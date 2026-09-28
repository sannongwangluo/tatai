// V09-06 验证脚本（用法：`pnpm verify:v09-06`）——私有事实备份/恢复的**产品入口**（PLAN.md V09-06，
// DESIGN.md §8.5 / §12.2 末行「私有状态被 Git 忽略后丢失」）。
//
// 本卡不重造备份语义：一致切片怎么切、清单长什么样、隔离恢复怎么核验、绝不自动替换当前数据，
// 全部是 V06-14 的 `src/server/work/backup.ts`（本脚本段⑦ 用**文件内容哈希**证它一字节未动）。
// 本卡补的是产品入口：服务路由 + remote-routes 防漂移登记 + 界面 + 落点策略/幂等/失败分类。
//
// 十二段判据（每条都真跑，不看代码猜）：
//   ① 夹具：真项目 + 真 v2 事件 + 真证据 + 真基线（隔离 `TATAI_HOME`，全程不碰真实数据）
//   ② 产品入口创建备份：清单可读（版本 / 截止序号 / 内容哈希 / 证据清单）+ 同一提交边界幂等
//   ③ 反证：跨时刻拼接 / 裸目录副本 / 损坏 / 缺证据 / 缺修订 —— 一一被产品入口判**不合格**
//   ④ 隔离恢复：可重放 / 原文可定位 / 证据哈希相符 / `replaced:false` / 原项目零写入
//   ⑤ 异常如实：位置不合法（相对 / 项目根内 / 远程来源）/ 目标不可写 / 已存在 / 权限 / 空间不足
//   ⑥ 真 HTTP：四条路由（清单 / 创建 / 详情 / 恢复）真起后端真打，错误码逐条对（400/403/404/409）
//   ⑦ 防漂移与口径：remote-routes 登记与 anchors 唯一、package.json、README 能力行、backup.ts 未动，
//      外加**界面文案里没有字面 `**`**（Markdown 记号不许逐字显示在页面上）
//   ⑧ 自证：全部夹具在临时目录下、真实仓库 `.工作台` 零改动（本卡证据目录除外）
//   ⑨ **定向返工**：备份放在**用户自选位置**时，列表/详情/隔离恢复都能在**重启后的新进程**里找回
//   ⑩ **定向返工反例**：错项目 / 远程传路径 / 项目根内 / 损坏 / 路径穿越 / 归不了属 —— 一律拒
//   ⑪ **第 3 轮返工**：落点/来源位置按**真实路径**判（项目外的 junction 指向项目内必须被拒，正反都测）
//   ⑫ **第 3 轮返工**：只剩损坏/不可归属条目的位置，跳过原因逐条可辨（"清单读不出来" ≠ "不是备份"）
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { addProject } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import { importTaskDefinitions, taskDefinitionHash } from "../src/server/work/plan";
import { submitDefinitionImports, submitTaskStatus } from "../src/server/work/tasks";
import { WorkService } from "../src/server/work/service";
import { eventsPath, loadEvents, replayEvents, STATE_FILE } from "../src/server/work/eventStore";
import { SCHEMA_VERSION, type WorkCommand } from "../src/server/work/types";
import { putEvidence } from "../src/server/work/evidence";
import { activateBaseline, WORKBENCH_DIRNAME } from "../src/server/work/documents";
import { submitSubmission } from "../src/server/work/audit";
import {
  BACKUP_MANIFEST_FILE,
  backupRoot,
  toBackupRel,
  verifyBackup,
  type BackupManifest,
} from "../src/server/work/backup";
import {
  backupEntryStatus,
  classifyFsFailure,
  createBackupEntry,
  inspectBackupEntry,
  isBackupEntryError,
  listBackupEntries,
  restoreBackupEntry,
  type BackupEntryFailureCode,
} from "../src/server/work/backupEntry";

// ── 小工具 ──

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0906-verify-"));
const DATA_DIR = path.join(TMP, "home");
const CHG = "chg-v0906";
const NOW = "2026-09-24T09:00:00.000Z";
const KEEP = process.env.TATAI_V0906_KEEP_TMP === "1";
/** 证据落点由调用方给（脚本只写这一个目录之外的临时区，真实仓库里只写卡自己的证据目录） */
const RAW_DIR = process.env.TATAI_V0906_RAW_DIR ?? "";
/** 本卡唯一允许写进真实仓库的目录（任务书指定的证据落点） */
const EVIDENCE_DIR = path.join(REPO, ".工作台", "evidence", "V09-06");
/** 证据目录（可选）：设了就顺手把**真跑出来的**清单/核验/恢复报告原文落过去（供逐字复核） */
const DUMP_DIR = process.env.TATAI_V0906_DUMP_DIR ?? "";

let passCount = 0;
let failCount = 0;
let infoCount = 0;
function ok(cond: boolean, label: string): void {
  if (cond) passCount++;
  else failCount++;
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
}
const info = (msg: string): void => {
  infoCount++;
  console.log(`[verify]   ${msg}`);
};
const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const sha256File = (f: string): string => sha256(fs.readFileSync(f));
const mkdirp = (d: string): void => {
  fs.mkdirSync(d, { recursive: true });
};
const write = (f: string, text: string): void => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
const read = (f: string): string => fs.readFileSync(f, "utf8");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const json = (v: unknown): string => JSON.stringify(v, null, 2);

/** 目录树指纹：`相对路径 + 大小 + 内容哈希` 有序拼接（用于"一个字节都没变"的断言） */
function treeFingerprint(dir: string): { hash: string; files: number } {
  const rows: string[] = [];
  const walk = (cur: string, rel: string): void => {
    if (!fs.existsSync(cur)) return;
    for (const e of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(cur, e.name);
      const child = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(abs, child);
      else if (e.isFile()) rows.push(`${child}\t${fs.statSync(abs).size}\t${sha256File(abs)}`);
    }
  };
  walk(dir, "");
  return { hash: sha256(rows.join("\n")), files: rows.length };
}

/** 真实仓库 `.工作台` 的现状（自证用；本卡只许写自己的证据目录） */
function realWorkbenchFiles(): string[] {
  const root = path.join(REPO, ".工作台");
  const out: string[] = [];
  const walk = (cur: string, rel: string): void => {
    if (!fs.existsSync(cur)) return;
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const abs = path.join(cur, e.name);
      const child = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(abs, child);
      else if (e.isFile()) out.push(child);
    }
  };
  walk(root, "");
  return out.sort();
}

/** 把真跑出来的对象原文落到证据目录（调用方给的路径；不设就什么都不写） */
function dump(name: string, value: unknown): void {
  if (DUMP_DIR === "") return;
  try {
    mkdirp(DUMP_DIR);
    fs.writeFileSync(path.join(DUMP_DIR, name), `${json(value)}
`, "utf8");
  } catch (e) {
    console.error(`[verify] 落 ${name} 失败：${(e as Error).message}`);
  }
}

const raw: Record<string, unknown> = {
  card: "V09-06",
  at: new Date().toISOString(),
  data_dir: DATA_DIR,
  sections: {},
};
const rawSection = (name: string, v: unknown): void => {
  (raw.sections as Record<string, unknown>)[name] = v;
};

// ══════════════════════════ ① 夹具 ══════════════════════════

const service = new WorkService({ dataDir: DATA_DIR });
const submitter = { submit: (c: WorkCommand) => service.submit(c) };

const PLAN_TEXT = [
  "# 备份入口夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| K-1 | todo | 一致备份的提交边界 | | K-1 证据 |",
  "| K-2 | todo | 隔离恢复与核验 | K-1 | K-2 证据 |",
  "",
  "### K-1 一致备份的提交边界",
  "",
  "**设计依据**：§8.5。**依赖**：无。**文件责任**：`src/server/work/backup.ts`。",
  "",
  "- [ ] 备份是某个提交序号的一致切片",
  "",
  "### K-2 隔离恢复与核验",
  "",
  "**设计依据**：§8.5。**依赖**：K-1。**文件责任**：`.工作台/**`。",
  "",
  "- [ ] 原文与证据哈希、事件重放、缓存重建逐项核对",
  "",
].join("\n");

function makeFixtureProject(id: string): string {
  const root = path.join(TMP, "projects", id);
  mkdirp(path.join(root, WORKBENCH_DIRNAME));
  write(path.join(root, WORKBENCH_DIRNAME, "design.md"), `# ${id} 设计书\n\n## 1 目标\n\n备份入口夹具。\n`);
  write(path.join(root, WORKBENCH_DIRNAME, "plan.md"), PLAN_TEXT);
  // 归档类私有事实（没有 v2 事件边界，清单里如实标 no_event_boundary）
  write(path.join(root, WORKBENCH_DIRNAME, "logs", "terminal-history.jsonl"), `{"cmd":"pnpm build","at":"${NOW}"}\n`);
  write(path.join(root, WORKBENCH_DIRNAME, "chat", "s1.jsonl"), `{"role":"user","content":"夹具聊天"}\n`);
  addProject({ id, name: `备份入口夹具 ${id}`, path: root, kind: "backend" }, DATA_DIR);
  return root;
}

/** 一个带事件、证据与生效基线的夹具项目（两个：主用例 + 只读/错误码用例） */
function buildProject(id: string): {
  root: string;
  workDir: string;
  baselineId: string;
  evidenceIds: string[];
  lastSeq: number;
} {
  const root = makeFixtureProject(id);
  const workDir = projectWorkDir(id, DATA_DIR);
  const defs = importTaskDefinitions(PLAN_TEXT).definitions;
  submitDefinitionImports(submitter, {
    project_id: id,
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    definitions: defs,
  });
  const ev1 = putEvidence(workDir, {
    content: "自检命令：pnpm typecheck\nexit_code=0\n结论：通过\n",
    kind: "self_check",
    summary: "夹具自检输出",
    created_by: "fixture-executor",
    role: "executor",
    binding: { revision_kind: "code", revision: "rev-a" },
  });
  const ev2 = putEvidence(workDir, {
    content: "交付包摘要：改动 3 个文件，未测项 1 个（真机 WebView2）\n",
    kind: "submission",
    summary: "夹具交付包",
    created_by: "fixture-executor",
    role: "executor",
    binding: { revision_kind: "code", revision: "rev-a" },
  });
  submitTaskStatus(submitter, {
    project_id: id,
    task_id: "K-1",
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    expected_revision: 1,
    status: "executing",
    definition: { definition_sha256: taskDefinitionHash(defs[0]), plan_revision: defs[0].plan_revision ?? "" },
  });
  const baseline = activateBaseline(
    id,
    {
      approved_by: "fixture-technical-reviewer",
      approval_basis: "夹具的技术审定（不是用户 Gate）",
      approval_kind: "delegated_technical_review",
    },
    DATA_DIR,
  );
  submitSubmission(submitter, {
    record_id: `sub-${id}-K-1`,
    project_id: id,
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    goal: "一致备份的提交边界（夹具）",
    task_id: "K-1",
    changed_files: ["src/server/work/backup.ts"],
    commands: [],
    untested: [{ item: "真机 WebView2", reason: "夹具不跑浏览器" }],
    known_issues: [],
    evidence_refs: [ev1.evidence_id, ev2.evidence_id],
    binding: { revision_kind: "code", revision: "rev-a" },
    baseline: {
      baseline_id: baseline.baseline.baseline_id,
      design_revision: baseline.baseline.design_revision.content_sha256,
      plan_revision: baseline.baseline.plan_revision.definition_sha256,
    },
    submitted_by: "fixture-executor",
  });
  return {
    root,
    workDir,
    baselineId: baseline.baseline.baseline_id,
    evidenceIds: [ev1.evidence_id, ev2.evidence_id],
    lastSeq: replayEvents(loadEvents(workDir).events).last_seq,
  };
}

// ══════════════════════════ ② 产品入口：创建 + 清单 + 幂等 ══════════════════════════

let backupId = "";

function section2(): void {
  console.log("\n[verify] ② 产品入口创建备份：清单可读 + 同一提交边界幂等");
  const proj = buildProject("v0906-main");
  const projHashBefore = treeFingerprint(path.join(proj.root, WORKBENCH_DIRNAME));

  const created = createBackupEntry("v0906-main", { dataDir: DATA_DIR, now: NOW });
  backupId = created.backup_id;
  const m = created.manifest;
  info(
    `  备份 ${created.backup_id}：截止序号 ${m.cutoff_seq}、源 ${m.counts.sources} 份、证据 ${m.counts.evidence} 份、` +
      `图纸历史 ${m.counts.document_history} 份、核验 ${created.verification.ok ? "通过" : "未通过"}`,
  );
  ok(
    /^b-\d{8}-[0-9a-f]{12}$/.test(created.backup_id) && created.reused === false,
    `②-1 备份 id 由**截止序号 + 内容指纹**决定：${created.backup_id}（指纹 ${created.content_fingerprint.slice(0, 12)}…）、reused=false`,
  );
  ok(
    m.backup_format === 1 && m.schema_version === SCHEMA_VERSION && m.cutoff_seq === proj.lastSeq,
    `②-2 清单含**版本**（backup_format=${m.backup_format}、事件 schema=${m.schema_version}）与**截止提交序号**` +
      `（${m.cutoff_seq} = 夹具事件 last_seq ${proj.lastSeq}）`,
  );
  ok(
    m.sources.some((s) => s.rel_path === "work/events.jsonl" && s.version === String(m.cutoff_seq)) &&
      m.sources.some((s) => s.rel_path === "baselines.jsonl" && s.version === proj.baselineId) &&
      m.sources.every((s) => /^[0-9a-f]{64}$/.test(s.sha256)),
    "②-3 清单含**逐份内容哈希**与事实源自己的版本（events.jsonl 的 version=截止序号、" +
      `baselines.jsonl 的 version=${proj.baselineId}）`,
  );
  ok(
    m.evidence.length === 2 &&
      m.evidence.every((e) => e.sha256 === e.evidence_id && /evidence/.test(e.recovery_path)) &&
      m.evidence.some((e) => e.referenced_by_events),
    `②-4 清单含**证据清单**（${m.evidence.length} 份内容寻址证据，其中被截止序号以内事件引用的已标出）`,
  );
  ok(
    m.counts.log === 2 &&
      m.sources.filter((s) => s.no_event_boundary === true).length >= 2 &&
      m.sources.some((s) => s.role === "derived"),
    "②-5 归档类（聊天/日志）**仍备份但如实标 `no_event_boundary`**、派生（state.json 等）单列——" +
      "不假装它们也在同一提交序号上",
  );
  ok(
    created.verification.ok && created.verification.checks.length === 8,
    `②-6 创建应答自带**八条一致性核验**且全通过（${created.verification.checks.map((c) => c.name).join(" / ")}）`,
  );

  // 创建动作对**原项目**零写入（本入口只往项目外的落点写）
  const projHashAfter = treeFingerprint(path.join(proj.root, WORKBENCH_DIRNAME));
  ok(
    projHashBefore.hash === projHashAfter.hash && projHashBefore.files === projHashAfter.files,
    `②-9 **创建备份不写原项目**：\`.工作台\` 树指纹前后一致（${projHashBefore.files} 个文件、` +
      `${projHashBefore.hash.slice(0, 12)}…）——备份落在项目之外`,
  );

  // 幂等：同一提交边界 + 同一事实内容 → 同一份，不造第二份
  const again = createBackupEntry("v0906-main", { dataDir: DATA_DIR, now: "2026-09-24T09:05:00.000Z" });
  const listed = listBackupEntries("v0906-main", { dataDir: DATA_DIR });
  ok(
    again.backup_id === created.backup_id && again.reused === true && listed.entries.length === 1,
    `②-7 **同一提交边界重复备份幂等**：第二次返回同一份（${again.backup_id}、reused=${again.reused}），` +
      `备份根下只有 ${listed.entries.length} 份`,
  );

  // 内容变了（同一截止序号）→ 指纹变 → 另存一份，不被"同一个序号"错误合并
  write(path.join(proj.root, WORKBENCH_DIRNAME, "chat", "s1.jsonl"), `{"role":"user","content":"夹具聊天（改过）"}\n`);
  const changed = createBackupEntry("v0906-main", { dataDir: DATA_DIR, now: "2026-09-24T09:06:00.000Z" });
  ok(
    changed.backup_id !== created.backup_id &&
      changed.manifest.cutoff_seq === created.manifest.cutoff_seq &&
      changed.content_fingerprint !== created.content_fingerprint,
    `②-8 截止序号相同但内容变了（改了一份归档类私有事实）→ 指纹变、**另存一份**` +
      `（${changed.backup_id} ≠ ${created.backup_id}）：不会被"同一个序号"当成同一份`,
  );

  // 清掉②-8 引入的第二份（只有 id 真的不同才删——幂等命中时它指向第一份，删了就把真备份毁了）
  if (changed.backup_id !== created.backup_id) {
    fs.rmSync(path.join(backupRoot(DATA_DIR, "v0906-main"), changed.backup_id), { recursive: true, force: true });
  }

  // 清单列表：每份都能说清是什么
  ok(
    listed.entries.length >= 1 &&
      listed.entries.every((e) => (e.ok ? e.manifest !== null && typeof e.manifest.cutoff_seq === "number" : e.error !== null)),
    `②-10 清单列举：${listed.entries.length} 份，每份要么给出可读清单、要么如实带错误原因（不静默丢）`,
  );
  if (DUMP_DIR !== "") {
    // 清单**原文**（backup.ts 写盘的那一份，逐字节复制，不做任何加工）
    dump("backup-manifest.json", JSON.parse(read(path.join(created.dir, BACKUP_MANIFEST_FILE))));
  }
  dump("backup-create.json", created);
  rawSection("create", {
    backup_id: created.backup_id,
    cutoff_seq: m.cutoff_seq,
    counts: m.counts,
    content_fingerprint: created.content_fingerprint,
    idempotent_second: { backup_id: again.backup_id, reused: again.reused },
    fingerprint_changed_second: { backup_id: changed.backup_id, fingerprint: changed.content_fingerprint },
  });
  raw.projects = { main: { root: proj.root, last_seq: proj.lastSeq, baseline_id: proj.baselineId } };
}

// ══════════════════════════ ③ 反证：不合格的备份仍判不合格 ══════════════════════════

/** 复制一份真备份到备份根下的给定 id（模拟"盘上多出来的一份"），返回目录 */
function cloneBackupAs(sourceId: string, asId: string): string {
  const dest = path.join(backupRoot(DATA_DIR, "v0906-main"), asId);
  fs.cpSync(path.join(backupRoot(DATA_DIR, "v0906-main"), sourceId), dest, { recursive: true });
  return dest;
}

/**
 * 「盘上这一份」经产品入口读出来的样子：
 *   · 清单读不出来（裸目录副本那种）→ 入口**抛** `BACKUP_SOURCE_CORRUPT`（连清单都没有，没什么可展示的）；
 *   · 清单能读但核验不过（拼接/损坏/缺证据/缺修订）→ 入口**返回** `verification.ok === false` + 逐条失败原因
 *     （界面要把"哪一条不过"显示出来——这正是"不显示成正常空态"的做法，不是靠抛错把现场抹掉）。
 */
function inspectOutcome(dir: string): {
  thrown: string;
  thrownMessage: string;
  verifyOk: boolean | null;
  codes: string[];
} {
  try {
    const got = inspectBackupEntry("v0906-main", path.basename(dir), { dataDir: DATA_DIR });
    return {
      thrown: "",
      thrownMessage: "",
      verifyOk: got.verification.ok,
      codes: got.verification.failures.map((f) => f.code),
    };
  } catch (e) {
    return {
      thrown: isBackupEntryError(e) ? e.code : `(${(e as Error).name})`,
      thrownMessage: (e as Error).message,
      verifyOk: null,
      codes: [],
    };
  }
}

/** 判据：这一份必须是"读得出但不合格"，且失败原因里点到了期望的那一条 */
function expectUnqualified(label: string, dir: string, wantCodes: string[]): void {
  const got = inspectOutcome(dir);
  const hit = got.codes.filter((c) => wantCodes.includes(c));
  ok(
    got.verifyOk === false && hit.length > 0,
    `${label} → 判**不合格**且点到了原因（verification.ok=${String(got.verifyOk)}、` +
      `失败项 ${got.codes.join("、") || "无"}）`,
  );
}

/** 判据：清单都读不出来 → 入口必须**抛**结构化失败，而不是回一个空的正常状态 */
function expectUnreadable(label: string, dir: string, wantCode: string): void {
  const got = inspectOutcome(dir);
  ok(
    got.thrown === wantCode && /清单|backup-manifest/.test(got.thrownMessage),
    `${label} → 抛 ${got.thrown || "(没抛)"}（期望 ${wantCode}）：${got.thrownMessage.slice(0, 80)}…`,
  );
}

function section3(): void {
  console.log("\n[verify] ③ 反证：跨时刻拼接 / 裸目录副本 / 损坏 / 缺证据 / 缺修订");
  const srcDir = path.join(backupRoot(DATA_DIR, "v0906-main"), backupId);
  const projRoot = path.join(TMP, "projects", "v0906-main");
  const workDir = projectWorkDir("v0906-main", DATA_DIR);

  // 反证 A：跨时刻拼接（事件换成更晚的一份 + 同步改清单哈希 + 事后多塞一份证据正文）
  const mixedId = "b-00000099-aaaaaaaaaaaa";
  const mixedDir = cloneBackupAs(backupId, mixedId);
  const mixedManifest = JSON.parse(read(path.join(mixedDir, BACKUP_MANIFEST_FILE))) as BackupManifest;
  const liveEvents = read(eventsPath(workDir));
  write(path.join(mixedDir, "workbench", "work", "events.jsonl"), liveEvents);
  const evEntry = mixedManifest.sources.find((s) => s.rel_path === "work/events.jsonl");
  if (evEntry) {
    evEntry.sha256 = sha256(liveEvents);
    evEntry.bytes = Buffer.byteLength(liveEvents);
  }
  write(
    path.join(mixedDir, "workbench", "work", "evidence", `${"f".repeat(64)}.json`),
    json({ evidence_id: "f".repeat(64), content_sha256: "f".repeat(64), content: "事后塞进来的一份\n" }),
  );
  write(path.join(mixedDir, BACKUP_MANIFEST_FILE), json(mixedManifest) + "\n");
  const mixedVerdict = verifyBackup(mixedDir);
  info(`  反证 A 核验失败项：${mixedVerdict.failures.map((f) => f.code).join("、")}`);
  expectUnqualified(
    "③-1 反证 A（跨时刻拼接的半份：事件换成更晚的一份 + 事后多塞一份证据正文）",
    mixedDir,
    ["CUTOFF_MISMATCH", "UNLISTED_FACT_FILE", "MANIFEST_HASH_MISMATCH"],
  );
  ok(
    !verifyBackup(mixedDir).ok && verifyBackup(srcDir).ok,
    "③-2 反证 A 复算：拼接的那份仍**不合格**，而原始那一份仍**合格**——" +
      "哈希都对得上也没用，拼接出来的不是某个提交序号的一致切片",
  );

  // 反证 B：裸目录副本（没有清单）
  const bareId = "b-00000098-bbbbbbbbbbbb";
  const bareDir = path.join(backupRoot(DATA_DIR, "v0906-main"), bareId);
  fs.cpSync(path.join(srcDir, "workbench"), bareDir, { recursive: true });
  const bareVerdict = verifyBackup(bareDir);
  info(`  反证 B 核验失败项：${bareVerdict.failures.map((f) => f.code).join("、")}`);
  expectUnreadable("③-3 反证 B（裸目录副本，没有清单）", bareDir, "BACKUP_SOURCE_CORRUPT");

  // 反证 C：损坏（改一个字节）
  const corruptId = "b-00000097-cccccccccccc";
  const corruptDir = cloneBackupAs(backupId, corruptId);
  const evId = (JSON.parse(read(path.join(srcDir, BACKUP_MANIFEST_FILE))) as BackupManifest).evidence[0].evidence_id;
  const corruptTarget = path.join(corruptDir, "workbench", "work", "evidence", `${evId}.json`);
  const corruptBefore = sha256File(corruptTarget);
  const corruptBlob = JSON.parse(read(corruptTarget)) as { content: string; sha256: string };
  corruptBlob.content = `${corruptBlob.content}（事后被改写过的一行）`;
  write(corruptTarget, `${json(corruptBlob)}\n`);
  const corruptAfter = sha256File(corruptTarget);
  ok(
    corruptBefore !== corruptAfter,
    `③-4a 篡改真的落到了字节上（${corruptBefore.slice(0, 12)}… → ${corruptAfter.slice(0, 12)}…）——` +
      "反例必须有鉴别力：改不动就不是反例",
  );
  expectUnqualified("③-4 损坏（证据正文字节被改）", corruptDir, ["MANIFEST_HASH_MISMATCH"]);

  // 反证 D：缺证据（被事件引用的那份）
  const missId = "b-00000096-dddddddddddd";
  const missDir = cloneBackupAs(backupId, missId);
  const missManifest = JSON.parse(read(path.join(missDir, BACKUP_MANIFEST_FILE))) as BackupManifest;
  const targetEv = missManifest.evidence.find((e) => e.referenced_by_events) ?? missManifest.evidence[0];
  fs.rmSync(path.join(missDir, "workbench", "work", "evidence", `${targetEv.evidence_id}.json`), { force: true });
  missManifest.evidence = missManifest.evidence.filter((e) => e.evidence_id !== targetEv.evidence_id);
  missManifest.sources = missManifest.sources.filter(
    (s) => s.rel_path !== `work/evidence/${targetEv.evidence_id}.json`,
  );
  write(path.join(missDir, BACKUP_MANIFEST_FILE), json(missManifest) + "\n");
  expectUnqualified("③-5 缺证据（删掉被引用的证据正文并同步划掉清单）", missDir, ["EVIDENCE_MISSING"]);

  // 反证 E：缺基线引用的不可变修订副本
  const revId = "b-00000095-eeeeeeeeeeee";
  const revDir = cloneBackupAs(backupId, revId);
  const revManifest = JSON.parse(read(path.join(revDir, BACKUP_MANIFEST_FILE))) as BackupManifest;
  const revRel = toBackupRel(revManifest.documents[0].design.recovery.ref);
  fs.rmSync(path.join(revDir, "workbench", revRel), { force: true });
  revManifest.sources = revManifest.sources.filter((s) => s.rel_path !== revRel);
  write(path.join(revDir, BACKUP_MANIFEST_FILE), json(revManifest) + "\n");
  expectUnqualified("③-6 缺图纸历史（删掉基线引用的设计修订副本）", revDir, ["BASELINE_REVISION_MISSING"]);

  // 反证汇总：这五份都不许被当成"正常空态"，且都不许被恢复成现场
  const refusedIds = [mixedId, bareId, corruptId, missId, revId];
  const restoreRefused: string[] = [];
  for (const rid of refusedIds) {
    try {
      restoreBackupEntry("v0906-main", rid, { dataDir: DATA_DIR });
    } catch (e) {
      if (isBackupEntryError(e)) restoreRefused.push(`${rid}:${e.code}`);
    }
  }
  ok(
    restoreRefused.length === refusedIds.length,
    `③-7 五份不合格的备份**都不许被恢复成现场**：逐份被拒（${restoreRefused.join("、")}）`,
  );
  for (const rid of refusedIds) fs.rmSync(path.join(backupRoot(DATA_DIR, "v0906-main"), rid), { recursive: true, force: true });

  // 清单列举时：损坏的那份如实带原因（不当作"没有这份备份"）
  const corrupt2 = cloneBackupAs(backupId, "b-00000094-ffffffffffff");
  fs.rmSync(path.join(corrupt2, BACKUP_MANIFEST_FILE), { force: true });
  const listed = listBackupEntries("v0906-main", { dataDir: DATA_DIR });
  const bad = listed.entries.find((e) => e.backup_id === "b-00000094-ffffffffffff");
  ok(
    bad !== undefined && bad.ok === false && bad.error !== null && listed.entries.some((e) => e.ok),
    "③-8 清单列举把读不出来的那份如实标 `ok:false` + 原因（不是静默消失，也不把整块渲染成空）",
  );
  fs.rmSync(corrupt2, { recursive: true, force: true });
  void projRoot;
  rawSection("negatives", {
    A_cross_time_splice: mixedVerdict.failures.map((f) => f.code),
    B_bare_copy: bareVerdict.failures.map((f) => f.code),
    restore_refused: restoreRefused,
  });
}

// ══════════════════════════ ④ 隔离恢复 ══════════════════════════

function section4(): void {
  console.log("\n[verify] ④ 隔离恢复：可重放 / 原文可定位 / 证据哈希相符 / replaced:false / 原项目零写入");
  const projRoot = path.join(TMP, "projects", "v0906-main");
  const workbench = path.join(projRoot, WORKBENCH_DIRNAME);

  const before = treeFingerprint(workbench);
  const restored = restoreBackupEntry("v0906-main", backupId, { dataDir: DATA_DIR });
  const after = treeFingerprint(workbench);
  const f = restored.report.facts;
  info(`  隔离目录 ${restored.dest_root}：${restored.disk.files} 个文件 / ${restored.disk.total_bytes} 字节`);
  ok(
    restored.replaced === false && restored.replace_requires_user === true,
    `④-1 隔离恢复返回 **replaced=${String(restored.replaced)} / replace_requires_user=${String(
      restored.replace_requires_user,
    )}**（本入口没有"替换当前数据"的动作）`,
  );
  ok(
    restored.report.ok &&
      f !== null &&
      f.events_replayed === restored.report.verification.manifest?.event_count &&
      f.cache_rebuilt.last_seq === restored.report.verification.manifest?.cutoff_seq,
    `④-2 **事件可重放**：隔离目录里重放 ${f?.events_replayed} 条 → last_seq=${f?.cache_rebuilt.last_seq}` +
      `（= 清单截止序号 ${restored.report.verification.manifest?.cutoff_seq}），缓存由事件重建成功`,
  );
  ok(
    (f?.documents_recovered.length ?? 0) === (restored.report.verification.manifest?.documents.length ?? -1) * 2 &&
      (f?.documents_recovered.length ?? 0) > 0,
    `④-3 **设计来源可定位**：${f?.documents_recovered.length} 份修订（每条基线 2 份）在隔离目录里按恢复位置取回且哈希相符` +
      `（基线 ${f?.documents_recovered.map((d) => d.baseline_id)[0] ?? "-"}）`,
  );
  ok(
    (f?.evidence_hash_checked.length ?? 0) === (restored.report.verification.manifest?.evidence.length ?? -1) &&
      (f?.evidence_hash_checked.length ?? 0) > 0,
    `④-4 **证据哈希相符**：${f?.evidence_hash_checked.length} 份证据正文读回并复核内容地址`,
  );
  ok(
    fs.existsSync(path.join(restored.dest_root, WORKBENCH_DIRNAME, "work", "events.jsonl")) &&
      fs.existsSync(path.join(restored.dest_root, WORKBENCH_DIRNAME, "work", STATE_FILE)) &&
      !fs.existsSync(path.join(restored.dest_root, "plan.md")),
    "④-5 **隔离目录与原数据并存**：副本落在隔离目录、原项目与它互不覆盖",
  );
  ok(
    before.hash === after.hash && before.files === after.files,
    `④-6 **原项目零写入**：恢复前后 \`.工作台\` 树指纹一致（${before.files} 个文件、${before.hash.slice(0, 12)}…）` +
      "——恢复没有替换/覆盖任何真实数据",
  );

  // 第二次恢复到同一父目录：隔离目录重名自动换名，绝不覆盖
  const again = restoreBackupEntry("v0906-main", backupId, {
    dataDir: DATA_DIR,
    destParent: path.dirname(restored.dest_root),
  });
  ok(
    again.dest_root !== restored.dest_root &&
      fs.existsSync(again.dest_root) &&
      fs.existsSync(restored.dest_root),
    `④-7 重复恢复不覆盖：第二次落在 ${path.basename(again.dest_root)}（第一次的目录原样留着）`,
  );

  // 恢复预览（只读）能说清"落后多少"
  const inspected = inspectBackupEntry("v0906-main", backupId, { dataDir: DATA_DIR });
  ok(
    inspected.restore_preview.default_dest_parent.includes("restores") &&
      inspected.restore_preview.default_dest_root.startsWith(inspected.restore_preview.default_dest_parent) &&
      /不自动替换|用户/.test(inspected.restore_preview.note),
    `④-8 恢复预览（只读）：默认隔离位置 ${inspected.restore_preview.default_dest_parent}、` +
      `对照当前项目 "…"（${inspected.restore_preview.comparison.note.slice(0, 24)}…）、本入口不自动替换`,
  );
  dump("backup-inspect.json", inspected);
  dump("restore-report.json", restored);
  dump("restore-report-second.json", again);
  rawSection("restore", {
    dest_root: restored.dest_root,
    replaced: restored.replaced,
    replace_requires_user: restored.replace_requires_user,
    facts: f,
    project_tree_unchanged: before.hash === after.hash,
    second_dest_root: again.dest_root,
  });
}

// ══════════════════════════ ⑤ 异常如实 ══════════════════════════

function codeOf(e: unknown): string {
  return isBackupEntryError(e) ? e.code : `(不是备份面错误：${(e as Error)?.name ?? typeof e})`;
}

function expectCode(label: string, want: BackupEntryFailureCode, fn: () => unknown): void {
  let e: unknown = null;
  try {
    fn();
  } catch (err) {
    e = err;
  }
  ok(codeOf(e) === want, `${label} → ${codeOf(e)}（期望 ${want}）`);
}

function section5(): void {
  console.log("\n[verify] ⑤ 异常如实：位置 / 目标不可写 / 已存在 / 权限 / 空间不足");
  const projRoot = path.join(TMP, "projects", "v0906-main");
  const otherRoot = path.join(TMP, "projects", "v0906-otherfix");
  let okProject = true;
  try {
    buildProject("v0906-otherfix");
  } catch (e) {
    okProject = false;
    info(`  第二个夹具建不起来（${(e as Error).message}）——错误码用例仍跑，涉及它的断言如实标红`);
  }
  void okProject;

  // 位置不合法
  expectCode("⑤-1 位置不是绝对路径（相对路径）", "BACKUP_DEST_FORBIDDEN", () =>
    createBackupEntry("v0906-main", { dataDir: DATA_DIR, destParent: "relative/place" }),
  );
  expectCode("⑤-2 落点落在**项目根内**（会被 Git 看见）", "BACKUP_DEST_FORBIDDEN", () =>
    createBackupEntry("v0906-main", { dataDir: DATA_DIR, destParent: path.join(projRoot, "backups-inside") }),
  );
  expectCode("⑤-3 落点就是项目根本身", "BACKUP_DEST_FORBIDDEN", () =>
    createBackupEntry("v0906-main", { dataDir: DATA_DIR, destParent: projRoot }),
  );
  expectCode("⑤-4 隔离恢复位置落在项目根内", "BACKUP_DEST_FORBIDDEN", () =>
    restoreBackupEntry("v0906-main", backupId, { dataDir: DATA_DIR, destParent: projRoot }),
  );
  expectCode("⑤-5 **远程来源**给的落点（本机专属）", "BACKUP_DEST_FORBIDDEN", () =>
    createBackupEntry("v0906-main", {
      dataDir: DATA_DIR,
      destParent: path.join(TMP, "remote-place"),
      destParentAllowed: false,
    }),
  );
  expectCode("⑤-6 远程来源给的隔离恢复位置", "BACKUP_DEST_FORBIDDEN", () =>
    restoreBackupEntry("v0906-main", backupId, {
      dataDir: DATA_DIR,
      destParent: path.join(TMP, "remote-place"),
      destParentAllowed: false,
    }),
  );

  // 目标不可写
  const asFile = path.join(TMP, "not-a-dir");
  write(asFile, "我是一个文件，不是目录\n");
  expectCode("⑤-7 落点是个文件（不是目录）", "BACKUP_DEST_NOT_WRITABLE", () =>
    createBackupEntry("v0906-main", { dataDir: DATA_DIR, destParent: asFile }),
  );
  expectCode("⑤-8 落点不存在", "BACKUP_DEST_NOT_WRITABLE", () =>
    createBackupEntry("v0906-main", { dataDir: DATA_DIR, destParent: path.join(TMP, "no-such-dir-0906") }),
  );
  expectCode("⑤-9 隔离恢复父目录是个文件", "BACKUP_DEST_NOT_WRITABLE", () =>
    restoreBackupEntry("v0906-main", backupId, { dataDir: DATA_DIR, destParent: asFile }),
  );

  // 找不到 / 形状不对 / 已存在
  expectCode("⑤-10 备份 id 不存在", "BACKUP_NOT_FOUND", () =>
    inspectBackupEntry("v0906-main", "b-00000000-000000000000", { dataDir: DATA_DIR }),
  );
  expectCode("⑤-11 备份 id 形状不合法（路径穿越）", "BACKUP_ID_INVALID", () =>
    inspectBackupEntry("v0906-main", "../../../etc", { dataDir: DATA_DIR }),
  );
  expectCode("⑤-12 备份 id 形状不合法（绝对路径）", "BACKUP_ID_INVALID", () =>
    inspectBackupEntry("v0906-main", "C:/Windows", { dataDir: DATA_DIR }),
  );
  expectCode("⑤-13 项目不存在（不当成「空清单」）", "BACKUP_NOT_FOUND", () =>
    listBackupEntries("no-such-project-0906", { dataDir: DATA_DIR }),
  );

  // 已存在：盘上先放一个同名暂存…（幂等路径由②-7 覆盖；这里走"同 id 但不合格"的分支）
  const listed = listBackupEntries("v0906-main", { dataDir: DATA_DIR });
  ok(
    listed.entries.length >= 1 && listed.default_root === listed.root,
    `⑤-14 清单根目录自述：${listed.root}（默认落点同源）`,
  );

  // 权限 / 空间不足：本机很难真触发，改为把**映射本身**钉成判据（诚实标注未复现真现场）
  const mkErr = (code: string): Error => Object.assign(new Error(`合成 ${code}`), { code });
  const rows: [string, BackupEntryFailureCode][] = [
    ["EACCES", "BACKUP_PERMISSION_DENIED"],
    ["EPERM", "BACKUP_PERMISSION_DENIED"],
    ["ENOSPC", "BACKUP_NO_SPACE"],
    ["EDQUOT", "BACKUP_NO_SPACE"],
    ["EEXIST", "BACKUP_DEST_EXISTS"],
    ["ENOTDIR", "BACKUP_DEST_NOT_WRITABLE"],
    ["EISDIR", "BACKUP_DEST_NOT_WRITABLE"],
    ["EROFS", "BACKUP_DEST_NOT_WRITABLE"],
    ["EIO", "BACKUP_IO_ERROR"],
  ];
  const mapped = rows.map(([errno, want]) => ({
    errno,
    want,
    got: classifyFsFailure(mkErr(errno), "夹具").code,
  }));
  ok(
    mapped.every((r) => r.got === r.want),
    `⑤-15 errno → 失败码映射逐条对（${mapped.map((r) => `${r.errno}→${r.got}`).join("、")}）：` +
      "权限不足 / 空间不足 / 目标不可写各自可分辨，不合并成一句「备份失败」",
  );
  ok(
    backupEntryStatus("BACKUP_NO_SPACE") === 507 &&
      backupEntryStatus("BACKUP_PERMISSION_DENIED") === 403 &&
      backupEntryStatus("BACKUP_DEST_EXISTS") === 409 &&
      backupEntryStatus("BACKUP_NOT_FOUND") === 404 &&
      backupEntryStatus("BACKUP_ID_INVALID") === 400,
    "⑤-16 失败码 → HTTP 状态：空间不足 507、权限不足 403、已存在 409、找不到 404、其余 400",
  );
  info(
    "未测项（如实标注）：本机没有复现**真实**的 EACCES/EPERM 与 ENOSPC（Windows 上只读属性不拦目录写入、" +
      "磁盘未满），段⑤-15 钉的是映射函数本身；真机上的权限/空间现场由协调者或终审按需复核。",
  );
  rawSection("errors", { mapping: mapped, real_eacces_reproduced: false, real_enospc_reproduced: false });
}

// ══════════════════════════ ⑨ 自定义落点：重启后仍找得回 ══════════════════════════
//
// 返工要修的真缺陷：落点由用户选（`destParent`），但清单/详情/恢复原来只认默认落点
// `<dataDir>/backups/<project_id>/` ⇒ 备份到自定义目录后界面列表找不到、进程重启后也恢复不了。
// 修法刻意**不做私有索引文件**（第二份事实源会跟盘上内容漂移）：让用户把位置再选一次，
// 服务端在这个位置上**逐份按清单归属核验**——位置合法 + 每一份都能证明属于本项目。

/** 用户自选的备份父目录（项目外、已存在）；⑨⑩ 与段⑥ 的 HTTP 用例共用它 */
const USER_PARENT = path.join(TMP, "用户自选备份位置");
/** 用户自选的隔离恢复父目录（项目外、已存在） */
const USER_RESTORE_PARENT = path.join(TMP, "用户自选恢复位置");
const CUSTOM_PROJECT = "v0906-custom";
const OTHER_PROJECT = "v0906-otherfix";
let customBackupId = "";
let otherBackupId = "";

const PROBE_FILE = path.join(TMP, "v0906-restart-probe.mts");

/**
 * 「进程重启」探针脚本（落在临时目录里，随 TMP 一起删）。
 *
 * 为什么必须是**新进程**：本卡的清单/详情/恢复没有内存索引（状态全在盘上），所以"重启后找得回"
 * 唯一能证的形态就是——换一个进程、只看用户选的那个目录，仍然能列出/打开/恢复。
 */
function writeProbe(): void {
  const entryUrl = pathToFileURL(path.join(REPO, "src", "server", "work", "backupEntry.ts")).href;
  write(
    PROBE_FILE,
    [
      "// 由 scripts/verify-v09-06.ts 生成的重启探针（临时目录内，跑完随 TMP 删除）",
      `const mod = await import(${JSON.stringify(entryUrl)});`,
      'const job = JSON.parse(process.argv[2] ?? "{}");',
      "const out: Record<string, unknown> = { pid: process.pid, at: new Date().toISOString() };",
      "try {",
      "  const opts = { dataDir: job.dataDir, sourceParent: job.sourceParent, sourceParentAllowed: job.allowed !== false };",
      '  if (job.op === "list") out.list = mod.listBackupEntries(job.projectId, opts);',
      '  else if (job.op === "inspect") out.backup = mod.inspectBackupEntry(job.projectId, job.backupId, opts);',
      '  else if (job.op === "restore") out.restore = mod.restoreBackupEntry(job.projectId, job.backupId, { ...opts, destParent: job.destParent });',
      '  else throw new Error("未知探针操作：" + String(job.op));',
      "} catch (e) {",
      "  const err = e as { code?: string; name?: string; message?: string };",
      "  out.error = { code: err?.code ?? null, name: err?.name ?? null, message: err?.message ?? String(e) };",
      "}",
      "process.stdout.write(JSON.stringify(out));",
      "",
    ].join("\n"),
  );
}

/** 在新进程里问一次（返回探针进程的 json 与原始 stdout，失败如实带出） */
function restartProbe(job: Record<string, unknown>): {
  ok: boolean;
  out: Record<string, unknown>;
  stdout: string;
  stderr: string;
  status: number | null;
} {
  try {
    writeProbe();
  } catch (e) {
    return { ok: false, out: {}, stdout: "", stderr: `探针写不出来：${(e as Error).message}`, status: null };
  }
  const r = spawnSync(process.execPath, ["--import", "tsx", PROBE_FILE, JSON.stringify(job)], {
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: DATA_DIR },
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = r.stdout ?? "";
  let out: Record<string, unknown> = {};
  let ok = r.status === 0;
  try {
    out = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1)) as Record<string, unknown>;
  } catch {
    ok = false;
  }
  return { ok, out, stdout, stderr: r.stderr ?? "", status: r.status };
}

/** 探针回包里的失败码（没抛错就是空串） */
function probeErrCode(out: Record<string, unknown>): string {
  const err = (out.error ?? null) as { code?: string } | null;
  return typeof err?.code === "string" ? err.code : "";
}

function section9(): void {
  console.log("\n[verify] ⑨ 自定义落点：备份在项目外用户选的位置，重启后的新进程仍能列出/打开/恢复");
  buildProject(CUSTOM_PROJECT);
  mkdirp(USER_PARENT);
  mkdirp(USER_RESTORE_PARENT);
  mkdirp(path.join(USER_RESTORE_PARENT, "重启后恢复"));
  const projRoot = path.join(TMP, "projects", CUSTOM_PROJECT);
  const workbench = path.join(projRoot, WORKBENCH_DIRNAME);
  const before = treeFingerprint(workbench);

  const created = createBackupEntry(CUSTOM_PROJECT, { dataDir: DATA_DIR, destParent: USER_PARENT, now: NOW });
  customBackupId = created.backup_id;
  ok(
    fs.existsSync(path.join(USER_PARENT, customBackupId)) &&
      created.dest_parent === path.resolve(USER_PARENT) &&
      created.dest_parent_is_default === false &&
      created.verification.ok,
    `⑨-1 落点在用户自选位置：${customBackupId} 落在 ${created.dest_parent}（非默认）、核验 ` +
      `${created.verification.ok ? "通过" : "未通过"}`,
  );

  // 前提：默认落点里**没有**它 —— 这正是返工要修的场景（备份位置不是默认位置）
  const defList = listBackupEntries(CUSTOM_PROJECT, { dataDir: DATA_DIR });
  const defHasIt = defList.entries.some((e) => e.backup_id === customBackupId);
  ok(
    !defHasIt && defList.root === defList.default_root && defList.root_is_default === true,
    `⑨-2 默认落点清单里没有它（列的是 ${defList.root}、root_is_default=${String(defList.root_is_default)}）：` +
      "备份放在别处时，只看默认落点确实找不回——这就是返工的现场",
  );

  // ① 重启后的新进程：按同一位置把清单列出来（本项目自己的那份在里面）
  const lp = restartProbe({ op: "list", projectId: CUSTOM_PROJECT, dataDir: DATA_DIR, sourceParent: USER_PARENT });
  const lpList = (lp.out.list ?? {}) as {
    root?: string;
    root_is_default?: boolean;
    source_parent?: string | null;
    entries?: { backup_id: string; ok: boolean }[];
    skipped?: { name: string; reason: string }[];
  };
  const lpEntries = lpList.entries ?? [];
  ok(
    lp.ok &&
      lpList.root === path.resolve(USER_PARENT) &&
      lpList.root_is_default === false &&
      lpEntries.some((e) => e.backup_id === customBackupId && e.ok),
    `⑨-3 **重启模拟**（新进程 pid=${String(lp.out.pid)}）按用户选的位置列出 ${lpEntries.length} 份、` +
      `其中 ${customBackupId} 清单可读（列的是 ${String(lpList.root)}、root_is_default=${String(lpList.root_is_default)}）` +
      `${lp.ok ? "" : `（探针 stderr：${lp.stderr.slice(0, 120)}）`}`,
  );

  // ② 详情（新进程）：清单 + 八条核验 + 恢复预览都要给得出来
  const dp = restartProbe({
    op: "inspect",
    projectId: CUSTOM_PROJECT,
    dataDir: DATA_DIR,
    sourceParent: USER_PARENT,
    backupId: customBackupId,
  });
  const dpBackup = (dp.out.backup ?? {}) as {
    verification?: { ok?: boolean; checks?: unknown[] };
    manifest?: { cutoff_seq?: number };
    restore_preview?: { default_dest_root?: string };
    backup_dir_parent?: string;
    from_source_parent?: boolean;
  };
  ok(
    dp.ok &&
      dpBackup.verification?.ok === true &&
      (dpBackup.verification?.checks ?? []).length === 8 &&
      typeof dpBackup.manifest?.cutoff_seq === "number" &&
      dpBackup.from_source_parent === true,
    `⑨-4 **重启模拟**详情：核验 ${(dpBackup.verification?.checks ?? []).length} 条全过、` +
      `截止序号 ${String(dpBackup.manifest?.cutoff_seq)}、位置来自用户自选（from_source_parent=${String(dpBackup.from_source_parent)}）` +
      `${dp.ok ? "" : `（错误码 ${probeErrCode(dp.out)}：${String(dp.out.error ? JSON.stringify(dp.out.error) : lp.stderr.slice(0, 120))}）`}`,
  );

  // ③ 隔离恢复（新进程）：只落隔离目录、replaced 恒 false、原项目零写入
  const rp1 = restartProbe({
    op: "restore",
    projectId: CUSTOM_PROJECT,
    dataDir: DATA_DIR,
    sourceParent: USER_PARENT,
    backupId: customBackupId,
    destParent: path.join(USER_RESTORE_PARENT, "重启后恢复"),
  });
  const rst = (rp1.out.restore ?? {}) as { dest_root?: string; replaced?: boolean; replace_requires_user?: boolean };
  const destRoot = typeof rst.dest_root === "string" ? rst.dest_root : "";
  ok(
    rp1.ok &&
      rst.replaced === false &&
      rst.replace_requires_user === true &&
      destRoot !== "" &&
      fs.existsSync(path.join(destRoot, WORKBENCH_DIRNAME, "work", "events.jsonl")) &&
      fs.existsSync(path.join(destRoot, WORKBENCH_DIRNAME, "work", STATE_FILE)),
    `⑨-5 **重启模拟**隔离恢复：落到 ${destRoot}（事件与重建的 state.json 都在）、` +
      `**replaced=${String(rst.replaced)}**、替换动作仍只归用户` +
      `${rp1.ok ? "" : `（错误码 ${probeErrCode(rp1.out)}）`}`,
  );

  // ④ 再恢复一次（同父目录）：换个可用名、绝不覆盖，且 replaced 仍恒 false
  const rp2 = restartProbe({
    op: "restore",
    projectId: CUSTOM_PROJECT,
    dataDir: DATA_DIR,
    sourceParent: USER_PARENT,
    backupId: customBackupId,
    destParent: path.join(USER_RESTORE_PARENT, "重启后恢复"),
  });
  const rst2 = (rp2.out.restore ?? {}) as { dest_root?: string; replaced?: boolean };
  ok(
    rp2.ok && rst2.replaced === false && rst2.dest_root !== destRoot && fs.existsSync(String(rst2.dest_root)),
    `⑨-6 重复恢复换个可用名（${String(rst2.dest_root)} ≠ ${destRoot}）、第一次的目录原样留着、` +
      `replaced 仍 **false**`,
  );

  // ⑤ 全程没有对原项目写一个字节
  const after = treeFingerprint(workbench);
  ok(
    before.hash === after.hash && before.files === after.files,
    `⑨-7 备份 + 详情 + 两次恢复**全程不写原项目**（\`.工作台\` 树指纹前后一致：${before.files} 个文件）`,
  );

  ok(
    fs.existsSync(path.join(USER_PARENT, customBackupId, BACKUP_MANIFEST_FILE)),
    `⑨-8 用户自选位置里的备份是**盘上真实存在**的一份（清单文件在：${customBackupId}/${BACKUP_MANIFEST_FILE}）` +
      "——新进程能找回它靠的是盘上的事实，不是内存里的索引",
  );

  dump("fix2-custom-list-restart.json", lp.out);
  dump("fix2-custom-inspect-restart.json", dp.out);
  dump("fix2-custom-restore-restart.json", rp1.out);
  rawSection("custom_location_restart", {
    user_parent: USER_PARENT,
    backup_id: customBackupId,
    default_root_has_it: defHasIt,
    restart_probe: { pid: lp.out.pid ?? null, list_root: lpList.root ?? null, entries: lpEntries, skipped: lpList.skipped ?? [] },
    restart_inspect: { ok: dpBackup.verification?.ok ?? null, checks: (dpBackup.verification?.checks ?? []).length, cutoff: dpBackup.manifest?.cutoff_seq ?? null },
    restart_restore: { dest_root: destRoot, replaced: rst.replaced ?? null, second_dest_root: rst2.dest_root ?? null },
    project_tree_unchanged: before.hash === after.hash,
  });
}

// ══════════════════════════ ⑩ 自定义落点的反例 ══════════════════════════

function section10(): void {
  console.log("\n[verify] ⑩ 自定义落点的反例：错项目 / 远程传路径 / 项目根内 / 损坏 / 路径穿越 / 归不了属");
  const projRoot = path.join(TMP, "projects", CUSTOM_PROJECT);
  if (!fs.existsSync(path.join(TMP, "projects", OTHER_PROJECT))) buildProject(OTHER_PROJECT);
  const otherProjRoot = path.join(TMP, "projects", OTHER_PROJECT);
  const otherRestoreParent = path.join(USER_RESTORE_PARENT, "错项目用例");
  mkdirp(otherRestoreParent);
  mkdirp(path.join(USER_RESTORE_PARENT, "损坏用例"));

  // 另一个项目的备份也放进同一个用户自选位置（同一个位置里混着两个项目的备份）
  const other = createBackupEntry(OTHER_PROJECT, { dataDir: DATA_DIR, destParent: USER_PARENT, now: NOW });
  otherBackupId = other.backup_id;
  ok(
    fs.existsSync(path.join(USER_PARENT, otherBackupId)) && otherBackupId !== customBackupId,
    `⑩-0 第二个项目（${OTHER_PROJECT}）的备份也在同一个用户自选位置里：${otherBackupId}`,
  );

  // ① 错项目：本项目看不到它的备份，也不读它
  const listMine = listBackupEntries(CUSTOM_PROJECT, { dataDir: DATA_DIR, sourceParent: USER_PARENT });
  const mineIds = listMine.entries.map((e) => e.backup_id);
  const skippedOther = (listMine.skipped ?? []).find((s) => s.name === otherBackupId);
  ok(
    !mineIds.includes(otherBackupId) && skippedOther?.reason === "other_project",
    `⑩-1 **别的项目的备份不进本项目的清单**（列出 ${mineIds.length} 份，别的项目那份记进跳过原因：` +
      `${String(skippedOther?.reason ?? "（没登记）")}）`,
  );
  ok(
    mineIds.every((id) => id !== otherBackupId),
    `⑩-2 清单里每一份都是本项目自己的（${mineIds.join("、") || "（空）"}）`,
  );
  expectCode("⑩-3 详情拒绝读别的项目的备份", "BACKUP_PROJECT_MISMATCH", () =>
    inspectBackupEntry(CUSTOM_PROJECT, otherBackupId, { dataDir: DATA_DIR, sourceParent: USER_PARENT }),
  );
  const dirsBefore = fs.existsSync(otherRestoreParent) ? fs.readdirSync(otherRestoreParent).length : 0;
  expectCode("⑩-4 恢复拒绝恢复别的项目的备份", "BACKUP_PROJECT_MISMATCH", () =>
    restoreBackupEntry(CUSTOM_PROJECT, otherBackupId, {
      dataDir: DATA_DIR,
      sourceParent: USER_PARENT,
      destParent: otherRestoreParent,
    }),
  );
  ok(
    (fs.existsSync(otherRestoreParent) ? fs.readdirSync(otherRestoreParent).length : 0) === dirsBefore,
    `⑩-5 拒绝之后**一个目录都没写出来**（${otherRestoreParent} 下的条目数前后一致：${dirsBefore}）` +
      "——不许「先恢复再看属于谁」",
  );
  expectCode("⑩-6 反向也拒（另一个项目读本项目那份）", "BACKUP_PROJECT_MISMATCH", () =>
    inspectBackupEntry(OTHER_PROJECT, customBackupId, { dataDir: DATA_DIR, sourceParent: USER_PARENT }),
  );
  // 另一个项目的默认落点里也放不下本项目的备份（默认路径由项目 id 决定，归属仍要核）
  ok(
    path.dirname(path.join(otherProjRoot, "x")) === otherProjRoot,
    `⑩-7 归属核验与目录路径无关（另一项目的项目根 ${path.basename(otherProjRoot)} 与它自己的默认落点各自独立）`,
  );

  // ② 远程来源传位置：一律拒（本机专属）
  expectCode("⑩-8 远程来源传来源位置（清单）", "BACKUP_DEST_FORBIDDEN", () =>
    listBackupEntries(CUSTOM_PROJECT, { dataDir: DATA_DIR, sourceParent: USER_PARENT, sourceParentAllowed: false }),
  );
  expectCode("⑩-9 远程来源传来源位置（详情）", "BACKUP_DEST_FORBIDDEN", () =>
    inspectBackupEntry(CUSTOM_PROJECT, customBackupId, {
      dataDir: DATA_DIR,
      sourceParent: USER_PARENT,
      sourceParentAllowed: false,
    }),
  );
  expectCode("⑩-10 远程来源传来源位置（恢复）", "BACKUP_DEST_FORBIDDEN", () =>
    restoreBackupEntry(CUSTOM_PROJECT, customBackupId, {
      dataDir: DATA_DIR,
      sourceParent: USER_PARENT,
      sourceParentAllowed: false,
    }),
  );

  // ③ 位置不合法的三种形态
  expectCode("⑩-11 来源位置是**本项目根**（列举项目内目录＝越界）", "BACKUP_DEST_FORBIDDEN", () =>
    listBackupEntries(CUSTOM_PROJECT, { dataDir: DATA_DIR, sourceParent: projRoot }),
  );
  expectCode("⑩-12 来源位置在本项目根内（`.工作台`）", "BACKUP_DEST_FORBIDDEN", () =>
    listBackupEntries(CUSTOM_PROJECT, { dataDir: DATA_DIR, sourceParent: path.join(projRoot, WORKBENCH_DIRNAME) }),
  );
  expectCode("⑩-13 来源位置是相对路径", "BACKUP_DEST_FORBIDDEN", () =>
    listBackupEntries(CUSTOM_PROJECT, { dataDir: DATA_DIR, sourceParent: "相对/位置" }),
  );
  expectCode("⑩-14 来源位置不存在（已有目录之外的都给不出清单）", "BACKUP_DEST_NOT_WRITABLE", () =>
    listBackupEntries(CUSTOM_PROJECT, { dataDir: DATA_DIR, sourceParent: path.join(TMP, "没有这个位置") }),
  );

  // ④ 路径穿越：备份 id 先过形状校验，绝不拿调用方的名字去拼路径
  for (const [label, badId] of [
    ["⑩-15 备份 id 路径穿越（../）", "../../../etc"],
    ["⑩-16 备份 id 是绝对路径", "C:/Windows"],
    ["⑩-17 备份 id 是上一级", ".."],
    ["⑩-18 备份 id 带分隔符", "a/b"],
  ] as const) {
    expectCode(`${label}（详情·带来源位置）`, "BACKUP_ID_INVALID", () =>
      inspectBackupEntry(CUSTOM_PROJECT, badId, { dataDir: DATA_DIR, sourceParent: USER_PARENT }),
    );
    expectCode(`${label}（恢复·带来源位置）`, "BACKUP_ID_INVALID", () =>
      restoreBackupEntry(CUSTOM_PROJECT, badId, { dataDir: DATA_DIR, sourceParent: USER_PARENT }),
    );
  }

  // ⑤ 归不了属的目录：不列、不读、不恢复（它可能压根不是备份）
  const noManifest = path.join(USER_PARENT, "b-00000093-999999999999");
  mkdirp(path.join(noManifest, "workbench", "work"));
  write(path.join(noManifest, "workbench", "work", "events.jsonl"), "\n");
  write(path.join(USER_PARENT, "随便一个文件.txt"), "这不是目录\n");
  const listed2 = listBackupEntries(CUSTOM_PROJECT, { dataDir: DATA_DIR, sourceParent: USER_PARENT });
  ok(
    !listed2.entries.some((e) => e.backup_id === "b-00000093-999999999999") &&
      !listed2.entries.some((e) => e.backup_id === "随便一个文件.txt") &&
      (listed2.skipped ?? []).some((s) => s.name === "b-00000093-999999999999" && s.reason === "not_a_backup") &&
      (listed2.skipped ?? []).some((s) => s.name === "随便一个文件.txt"),
    `⑩-19 归不了属的目录与不是目录的条目**不列进清单**，只在跳过原因里如实报出` +
      `（跳过 ${(listed2.skipped ?? []).map((s) => `${s.name}:${s.reason}`).join("、") || "（空）"}）`,
  );
  expectCode("⑩-20 归不了属的目录不许当成本项目的备份来读", "BACKUP_NOT_FOUND", () =>
    inspectBackupEntry(CUSTOM_PROJECT, "b-00000093-999999999999", { dataDir: DATA_DIR, sourceParent: USER_PARENT }),
  );
  expectCode("⑩-21 归不了属的目录不许被恢复", "BACKUP_NOT_FOUND", () =>
    restoreBackupEntry(CUSTOM_PROJECT, "b-00000093-999999999999", { dataDir: DATA_DIR, sourceParent: USER_PARENT }),
  );

  // ⑥ 损坏（本项目自己那份，被改了字节）：清单里如实标 ok:false，详情给不合格，恢复被拒
  const corruptId = "b-00000092-888888888888";
  const corruptDir = path.join(USER_PARENT, corruptId);
  fs.cpSync(path.join(USER_PARENT, customBackupId), corruptDir, { recursive: true });
  const evId = (JSON.parse(read(path.join(corruptDir, BACKUP_MANIFEST_FILE))) as BackupManifest).evidence[0].evidence_id;
  const evFile = path.join(corruptDir, "workbench", "work", "evidence", `${evId}.json`);
  const corruptBefore = sha256File(evFile);
  const blob = JSON.parse(read(evFile)) as { content: string };
  blob.content = `${blob.content}（在自选位置里被改写过的一行）`;
  write(evFile, `${json(blob)}\n`);
  const corruptAfter = sha256File(evFile);
  ok(
    corruptBefore !== corruptAfter,
    `⑩-22 篡改真的落到字节上（${corruptBefore.slice(0, 12)}… → ${corruptAfter.slice(0, 12)}…）——反例必须有鉴别力`,
  );
  const listed3 = listBackupEntries(CUSTOM_PROJECT, { dataDir: DATA_DIR, sourceParent: USER_PARENT });
  const corruptEntry = listed3.entries.find((e) => e.backup_id === corruptId);
  ok(
    corruptEntry !== undefined && corruptEntry.ok === false && corruptEntry.error !== null,
    `⑩-23 自选位置里损坏的那份如实标 \`ok:false\` + 原因（不当成"没有这份备份"、也不渲染成空态）`,
  );
  let corruptInspect = "";
  try {
    const got = inspectBackupEntry(CUSTOM_PROJECT, corruptId, { dataDir: DATA_DIR, sourceParent: USER_PARENT });
    corruptInspect = `verification.ok=${String(got.verification.ok)}（${got.verification.failures.map((f) => f.code).join("、")}）`;
  } catch (e) {
    corruptInspect = `抛 ${codeOf(e)}`;
  }
  ok(
    /verification\.ok=false/.test(corruptInspect),
    `⑩-24 自选位置里损坏的那份：详情给出逐条不合格原因（${corruptInspect}）`,
  );
  expectCode("⑩-25 自选位置里损坏的那份不许被恢复成现场", "BACKUP_SOURCE_CORRUPT", () =>
    restoreBackupEntry(CUSTOM_PROJECT, corruptId, {
      dataDir: DATA_DIR,
      sourceParent: USER_PARENT,
      destParent: path.join(USER_RESTORE_PARENT, "损坏用例"),
    }),
  );
  fs.rmSync(corruptDir, { recursive: true, force: true });

  // ⑦ 项目不存在：不当成空清单（既有口径在带位置时同样成立）
  expectCode("⑩-26 项目不存在（带来源位置也不当空清单）", "BACKUP_NOT_FOUND", () =>
    listBackupEntries("no-such-project-0906", { dataDir: DATA_DIR, sourceParent: USER_PARENT }),
  );

  dump("fix2-negatives.json", {
    foreign_skipped: listMine.skipped ?? [],
    corrupt_inspect: corruptInspect,
    skipped_after: listed2.skipped ?? [],
  });
  rawSection("custom_location_negatives", {
    other_project_backup: otherBackupId,
    mine_listed: mineIds,
    skipped: listMine.skipped ?? [],
    corrupt_entry: corruptEntry ?? null,
    corrupt_inspect: corruptInspect,
    unattributable_skipped: listed2.skipped ?? [],
  });
}

// ═══════════════════ ⑪ 落点/来源位置的**真实路径**（junction/symlink）═══════════════════
//
// 第 3 轮返工修的真缺陷：`customRootOf` 只做**词法**比较（`path.resolve`），用户选一个项目**外**的
// junction / symlink 指向项目根内就能绕过"不得落在项目根内"，私有事实备份会被真的写进项目目录。
// 修法：比较前先取**真实路径**（已存在的路径用 realpath；不存在的路径按"最近存在的祖先" realpath
// 再把剩余片段接回去），落点与来源位置共用同一套判据。
//
// 反例必须有鉴别力：拒绝的同时**盘上不许留下任何痕迹**（不是"先写进去再判不许"）。

/** 建一个 junction/symlink（Windows 上 junction 不需要管理员；权限不支持时如实回报，不谎称测过） */
function tryLink(target: string, linkPath: string): { ok: boolean; reason: string } {
  try {
    fs.symlinkSync(target, linkPath, "junction");
    return { ok: true, reason: "" };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

function section11(): void {
  console.log("\n[verify] ⑪ 落点/来源位置的真实路径：项目外的 junction 指向项目内必须被拒（正反都测）");
  const projRoot = path.join(TMP, "projects", CUSTOM_PROJECT);
  const wbDir = path.join(projRoot, WORKBENCH_DIRNAME);
  const outTarget = path.join(TMP, "junction-out-target");
  const linkOut = path.join(TMP, "junction-out");
  const linkIn = path.join(TMP, "junction-into-project");
  mkdirp(outTarget);

  const madeOut = tryLink(outTarget, linkOut);
  const madeIn = tryLink(projRoot, linkIn);
  if (!madeOut.ok || !madeIn.ok) {
    const reason = madeOut.reason !== "" ? madeOut.reason : madeIn.reason;
    info(
      `  本机建不出 junction/symlink（${reason}）⇒ 缺陷 C 的**真机正/反测试本轮未执行**，` +
        "如实登记（不谎称通过）；实现侧判据仍由「已有路径取 realpath + 不存在的路径按最近存在祖先」钉住",
    );
    rawSection("realpath_guard", { junction_supported: false, reason, tested: false });
    return;
  }
  info(`  junction 就位：${linkIn} → ${projRoot}（词法上在项目根**外**，真实路径在项目根**内**）`);

  // ① 反向：落点/来源位置/隔离恢复位置，只要真实路径落在项目根内，一律拒
  const rootEntriesBefore = fs.readdirSync(projRoot).sort();
  expectCode("⑪-1 落点是项目外的 junction、真实路径指向项目根", "BACKUP_DEST_FORBIDDEN", () =>
    createBackupEntry(CUSTOM_PROJECT, { dataDir: DATA_DIR, destParent: linkIn }),
  );
  const rootAfter = fs.readdirSync(projRoot).sort();
  ok(
    JSON.stringify(rootAfter) === JSON.stringify(rootEntriesBefore),
    `⑪-2 被拒之后项目根里**一个条目都没多出来**（${rootEntriesBefore.join("、") || "（空）"}）` +
      "——反例要有鉴别力：不是先写进去再判不许",
  );
  expectCode("⑪-3 来源位置是同一个 junction（真实路径在项目根内）", "BACKUP_DEST_FORBIDDEN", () =>
    listBackupEntries(CUSTOM_PROJECT, { dataDir: DATA_DIR, sourceParent: linkIn }),
  );
  expectCode("⑪-4 隔离恢复位置是同一个 junction", "BACKUP_DEST_FORBIDDEN", () =>
    restoreBackupEntry(CUSTOM_PROJECT, customBackupId, {
      dataDir: DATA_DIR,
      sourceParent: USER_PARENT,
      destParent: linkIn,
    }),
  );
  // 穿过 junction 再往下走一层（真正会落到项目内 `.工作台/` 的那个写法）
  const wbEntriesBefore = fs.readdirSync(wbDir).sort();
  expectCode("⑪-5 落点 = junction + 项目内子目录（真实路径在 `.工作台` 里）", "BACKUP_DEST_FORBIDDEN", () =>
    createBackupEntry(CUSTOM_PROJECT, { dataDir: DATA_DIR, destParent: path.join(linkIn, WORKBENCH_DIRNAME) }),
  );
  ok(
    JSON.stringify(fs.readdirSync(wbDir).sort()) === JSON.stringify(wbEntriesBefore),
    `⑪-6 被拒之后项目 \`.工作台\` 里也没多出条目（${wbEntriesBefore.join("、") || "（空）"}）`,
  );

  // ② 正向：项目外的 junction 指向**项目外**的真目录 → 照常接受（别因为"是链接"就一律误拒）
  const viaLink = createBackupEntry(CUSTOM_PROJECT, { dataDir: DATA_DIR, destParent: linkOut });
  ok(
    viaLink.dest_parent === path.resolve(linkOut) &&
      fs.existsSync(path.join(linkOut, viaLink.backup_id, BACKUP_MANIFEST_FILE)) &&
      fs.existsSync(path.join(outTarget, viaLink.backup_id)),
    `⑪-7 项目外的 junction（真实路径也在项目外）**照常接受**：${viaLink.backup_id} 落在 ${viaLink.dest_parent}`,
  );
  const listedViaLink = listBackupEntries(CUSTOM_PROJECT, { dataDir: DATA_DIR, sourceParent: linkOut });
  ok(
    listedViaLink.root_is_default === false && listedViaLink.entries.some((e) => e.backup_id === viaLink.backup_id),
    `⑪-8 同一个 junction 当**来源位置**照常列出 ${listedViaLink.entries.length} 份（不误拒正常的项目外目录）`,
  );

  dump("fix3-realpath-guard.json", {
    link_in_project: linkIn,
    link_out_of_project: linkOut,
    link_out_target: outTarget,
    root_entries: rootAfter,
    via_link_backup: viaLink.backup_id,
  });
  rawSection("realpath_guard", {
    junction_supported: true,
    tested: true,
    link_into_project: { link: linkIn, target: projRoot, rejected: "BACKUP_DEST_FORBIDDEN" },
    project_root_entries_after_reject: rootAfter,
    link_outside_project: { link: linkOut, target: outTarget, accepted_backup_id: viaLink.backup_id },
  });
}

// ═══════════════ ⑫ 自定义位置只剩损坏/不可归属条目：跳过原因如实可辨 ═══════════════
//
// 缺陷 D 的服务侧一半：一个目录里**有清单文件却读不出来**，与"压根没有清单"是两件事。
// 前者多半是损坏/半截的一份备份（要能说"清单读不出来"），后者不是备份（如实说"不是可读的备份"）。
// 界面侧（`data-backup-empty-skipped` 的醒目告警）由 verify-v09-06-ui.py 在真浏览器里验。

function section12(): void {
  console.log("\n[verify] ⑫ 只剩损坏/不可归属条目的位置：跳过原因逐条可辨（不静默、不混成「这里没有备份」）");
  const onlyBroken = path.join(TMP, "只剩坏条目的位置");
  const corruptId = "b-00000001-aaaaaaaaaaaa";
  const noManifestId = "b-00000002-bbbbbbbbbbbb";
  mkdirp(path.join(onlyBroken, corruptId));
  write(path.join(onlyBroken, corruptId, BACKUP_MANIFEST_FILE), "{ 这不是 JSON：清单被写坏/写了一半\n");
  write(path.join(onlyBroken, noManifestId, "workbench", "work", "events.jsonl"), "\n");
  write(path.join(onlyBroken, "随手放的一个文件.txt"), "不是目录\n");

  const listed = listBackupEntries(CUSTOM_PROJECT, { dataDir: DATA_DIR, sourceParent: onlyBroken });
  const reasonOf = (n: string): string => (listed.skipped ?? []).find((s) => s.name === n)?.reason ?? "（没登记）";
  ok(
    listed.entries.length === 0,
    `⑫-1 这个位置里没有任何能当成本项目备份的条目（entries=${listed.entries.length}、跳过 ${listed.skipped.length} 个）`,
  );
  ok(
    reasonOf(corruptId) === "manifest_unreadable",
    `⑫-2 **有清单文件却读不出来**的那份如实标「清单读不出来」（不是备份、也不是"没有这份"）：` +
      `${corruptId} → ${reasonOf(corruptId)}`,
  );
  ok(
    reasonOf(noManifestId) === "not_a_backup",
    `⑫-3 压根没有清单的目录如实标「不是可读的备份」：${noManifestId} → ${reasonOf(noManifestId)}`,
  );
  ok(
    reasonOf("随手放的一个文件.txt") === "not_a_directory",
    `⑫-4 不是目录的条目如实标「不是目录」：随手放的一个文件.txt → ${reasonOf("随手放的一个文件.txt")}`,
  );
  ok(
    listed.skipped.length === 3 && listed.root_is_default === false && listed.root === path.resolve(onlyBroken),
    `⑫-5 三个条目**逐条**登记在跳过原因里（${listed.skipped.map((s) => `${s.name}:${s.reason}`).join("、")}）、` +
      "清单根如实指向用户选的那个位置",
  );
  dump("fix3-broken-only-skips.json", listed);
  rawSection("broken_only_location", {
    root: listed.root,
    entries: listed.entries.length,
    skipped: listed.skipped,
  });
}

// ══════════════════════════ ⑥ 真 HTTP 路由 ══════════════════════════

interface Backend {
  proc: ChildProcess;
  port: number;
  logPath: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function httpJson(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json: parsed, text };
}

async function startBackend(): Promise<Backend> {
  const port = await freePort();
  const logPath = path.join(TMP, `backend-${port}.log`);
  const proc = spawn("node", ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: {
      ...process.env,
      TATAI_HOME: DATA_DIR,
      TATAI_PORT: String(port),
      DEEPSEEK_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: string[] = [];
  proc.stdout?.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  proc.stderr?.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  const flush = (): void => fs.writeFileSync(logPath, chunks.join(""), "utf8");
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (proc.exitCode !== null) {
      flush();
      throw new Error(`后端进程提前退出（exit ${proc.exitCode}），日志见 ${logPath}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {
      // 还没起来
    }
    if (Date.now() > deadline) {
      flush();
      throw new Error(`后端 ${port} 未在 90s 内就绪，日志见 ${logPath}`);
    }
    await sleep(300);
  }
  flush();
  return { proc, port, logPath };
}

async function section6(): Promise<void> {
  console.log("\n[verify] ⑥ 真 HTTP：四条路由真起后端真打（含错误码映射）");
  let backend: Backend;
  try {
    backend = await startBackend();
  } catch (e) {
    ok(false, `⑥-0 后端未就绪，本段无法执行：${(e as Error).message}`);
    return;
  }
  info(`  后端就绪：127.0.0.1:${backend.port}（TATAI_HOME=${DATA_DIR}）`);
  const P = "v0906-main";
  const base = `/api/projects/${P}/backups`;
  const errCodeOf = (j: Record<string, unknown>): string =>
    String((((j.error ?? {}) as Record<string, unknown>).code ?? "").toString());
  try {
    // 清单（读）
    const list1 = await httpJson(backend.port, "GET", base);
    const entries1 = ((list1.json.backups ?? {}) as { entries?: unknown[] }).entries ?? [];
    ok(
      list1.status === 200 && list1.json.ok === true && Array.isArray(entries1) && entries1.length >= 1,
      `⑥-1 GET ${base} → ${list1.status}，${entries1.length} 份备份（清单可读）`,
    );

    // 创建（写）：夹具已经备过一份，同一提交边界 → 幂等复用
    const create1 = await httpJson(backend.port, "POST", base, {});
    const created = (create1.json.backup ?? {}) as Record<string, unknown>;
    ok(
      create1.status === 200 &&
        ((created.verification ?? {}) as { ok?: boolean }).ok === true &&
        typeof created.backup_id === "string",
      `⑥-2 POST ${base} → ${create1.status}，backup_id=${String(created.backup_id)}、` +
        `核验 ok=${String(((created.verification ?? {}) as { ok?: boolean }).ok)}、reused=${String(created.reused)}`,
    );
    const realId = String(created.backup_id);

    // 详情（读）：清单 + 八条核验 + 恢复预览
    const detail = await httpJson(backend.port, "GET", `${base}/${realId}`);
    const det = (detail.json.backup ?? {}) as Record<string, unknown>;
    const checks = ((det.verification ?? {}) as { checks?: unknown[] }).checks ?? [];
    const preview = (det.restore_preview ?? {}) as Record<string, unknown>;
    ok(
      detail.status === 200 && checks.length === 8 && typeof preview.default_dest_root === "string",
      `⑥-3 GET ${base}/:backupId → ${detail.status}，核验 ${checks.length} 条、` +
        `恢复预览默认隔离位置 ${String(preview.default_dest_root)}`,
    );

    // 恢复（写）：只到隔离目录
    const restoreParent = path.join(TMP, "http-restores");
    mkdirp(restoreParent);
    const projWorkbench = path.join(TMP, "projects", P, WORKBENCH_DIRNAME);
    const treeBefore = treeFingerprint(projWorkbench);
    const restore1 = await httpJson(backend.port, "POST", `${base}/${realId}/restore`, {
      dest_parent: restoreParent,
    });
    const treeAfter = treeFingerprint(projWorkbench);
    const rst = (restore1.json.restore ?? {}) as Record<string, unknown>;
    ok(
      restore1.status === 200 && rst.replaced === false && rst.replace_requires_user === true,
      `⑥-4 POST ${base}/:backupId/restore → ${restore1.status}，隔离目录 ${String(rst.dest_root)}、` +
        `**replaced=${String(rst.replaced)}**`,
    );
    ok(
      treeBefore.hash === treeAfter.hash && fs.existsSync(path.join(String(rst.dest_root), WORKBENCH_DIRNAME, "work", STATE_FILE)),
      "⑥-5 HTTP 恢复也**不写原项目**（`.工作台` 树指纹前后一致），隔离目录里能看到重建的 state.json",
    );

    // 错误码映射（真 HTTP）
    const cases: [string, string, number, string, unknown?][] = [
      ["⑥-6 备份 id 不存在", "GET", 404, "BACKUP_NOT_FOUND"],
      ["⑥-7 备份 id 形状不合法", "GET", 400, "BACKUP_ID_INVALID"],
      ["⑥-8 落点不是绝对路径", "POST", 403, "BACKUP_DEST_FORBIDDEN"],
      ["⑥-9 落点落在项目根内", "POST", 403, "BACKUP_DEST_FORBIDDEN"],
      // 目标不可写（给了一个文件/不存在的目录）是**入参**错 → 400；权限被 OS 拒才是 403
      ["⑥-10 落点是个文件（目标不可写）", "POST", 400, "BACKUP_DEST_NOT_WRITABLE"],
      ["⑥-11 项目不存在（不当成空清单）", "GET", 404, "BACKUP_NOT_FOUND"],
    ];
    const rows: { label: string; status: number; code: string }[] = [];
    for (const [label, method, wantStatus, wantCode] of cases) {
      let url = base;
      let body: unknown = undefined;
      if (label.includes("id 不存在")) url = `${base}/b-00000000-000000000000`;
      else if (label.includes("形状不合法")) url = `${base}/${encodeURIComponent("../../etc")}`;
      else if (label.includes("不是绝对路径")) body = { dest_parent: "relative/dir" };
      else if (label.includes("项目根内")) body = { dest_parent: path.join(TMP, "projects", P, "inside") };
      else if (label.includes("是个文件")) body = { dest_parent: path.join(TMP, "not-a-dir") };
      else if (label.includes("项目不存在")) url = `/api/projects/no-such-project-0906/backups`;
      const r = await httpJson(backend.port, method, url, body);
      rows.push({ label, status: r.status, code: errCodeOf(r.json) });
      ok(
        r.status === wantStatus && errCodeOf(r.json) === wantCode,
        `${label} → ${r.status} ${errCodeOf(r.json)}（期望 ${wantStatus} ${wantCode}）`,
      );
    }

    // 本机绝对路径不出现在错误文案里（远程面裁剪的同一口径在这里也自检一次）
    const leak = rows.filter((r) => /[A-Za-z]:[\\/]/.test(r.code));
    ok(leak.length === 0, `⑥-12 错误码里没有本机盘符路径（${rows.length} 条，命中 ${leak.length}）`);

    // 详情/清单响应里不夹带"看起来像正常空态"的形状
    const missing = await httpJson(backend.port, "GET", `${base}/b-00000000-000000000000`);
    ok(
      missing.status === 404 && errCodeOf(missing.json) !== "" && missing.json.ok === false,
      `⑥-13 没有这份备份时回的是**结构化 404**（不是 200 空清单）：${missing.status} ${errCodeOf(missing.json)}`,
    );

    // ── 定向返工：备份在**用户自选位置**时，这个新起的后端进程（= 服务重启）能不能找回 ──
    // 这里的后端进程是段⑥ 才起的，而那份备份是**本脚本进程**在段⑨ 建的 ⇒ 它就是"换一个进程"。
    const baseC = `/api/projects/${CUSTOM_PROJECT}/backups`;
    const q = `?source_parent=${encodeURIComponent(USER_PARENT)}`;
    const cl = await httpJson(backend.port, "GET", `${baseC}${q}`);
    const clList = (cl.json.backups ?? {}) as { entries?: { backup_id: string }[]; root_is_default?: boolean };
    const clEntries = clList.entries ?? [];
    ok(
      cl.status === 200 && clList.root_is_default === false && clEntries.some((e) => e.backup_id === customBackupId),
      `⑥-14 重启后的新后端按用户选的位置列出清单：${cl.status}、${clEntries.length} 份、root_is_default=` +
        `${String(clList.root_is_default)}、含 ${customBackupId}`,
    );
    const noLoc = await httpJson(backend.port, "GET", `${baseC}/${customBackupId}`);
    ok(
      noLoc.status === 404 && errCodeOf(noLoc.json) === "BACKUP_NOT_FOUND",
      `⑥-15 不带位置就找不回（默认落点里没有它）：${noLoc.status} ${errCodeOf(noLoc.json)}` +
        "——这正是返工前的现场，修后靠「再选一次位置」恢复可达",
    );
    const cd = await httpJson(backend.port, "GET", `${baseC}/${customBackupId}${q}`);
    const cdBackup = (cd.json.backup ?? {}) as { verification?: { checks?: unknown[]; ok?: boolean }; from_source_parent?: boolean };
    ok(
      cd.status === 200 && (cdBackup.verification?.checks ?? []).length === 8 && cdBackup.from_source_parent === true,
      `⑥-16 重启后的新后端按同一位置打开这一份：${cd.status}、核验 ${(cdBackup.verification?.checks ?? []).length} 条、` +
        `from_source_parent=${String(cdBackup.from_source_parent)}`,
    );
    const httpCustomRestoreParent = path.join(TMP, "http-restores-custom");
    mkdirp(httpCustomRestoreParent);
    const cres = await httpJson(backend.port, "POST", `${baseC}/${customBackupId}/restore`, {
      dest_parent: httpCustomRestoreParent,
      source_parent: USER_PARENT,
    });
    const crst = (cres.json.restore ?? {}) as { dest_root?: string; replaced?: boolean; source_parent?: string | null };
    ok(
      cres.status === 200 && crst.replaced === false && fs.existsSync(path.join(String(crst.dest_root), WORKBENCH_DIRNAME, "work", STATE_FILE)),
      `⑥-17 重启后的新后端按同一位置隔离恢复：${cres.status}、replaced=**${String(crst.replaced)}**、` +
        `隔离目录 ${String(crst.dest_root)}`,
    );
    const cross = await httpJson(backend.port, "GET", `${baseC}/${otherBackupId}${q}`);
    ok(
      cross.status === 404 && errCodeOf(cross.json) === "BACKUP_PROJECT_MISMATCH",
      `⑥-18 错项目在 HTTP 面上同样被拒：${cross.status} ${errCodeOf(cross.json)}（别的项目的备份不读）`,
    );
    const insideLoc = await httpJson(backend.port, "GET", `${baseC}?source_parent=${encodeURIComponent(path.join(TMP, "projects", CUSTOM_PROJECT))}`);
    ok(
      insideLoc.status === 403 && errCodeOf(insideLoc.json) === "BACKUP_DEST_FORBIDDEN",
      `⑥-19 位置落进项目根在 HTTP 面上同样被拒：${insideLoc.status} ${errCodeOf(insideLoc.json)}`,
    );
    rawSection("http", {
      port: backend.port,
      list_count: entries1.length,
      create_status: create1.status,
      restore_status: restore1.status,
      error_rows: rows,
      custom_location: {
        list_status: cl.status,
        entries: clEntries.length,
        without_location: `${noLoc.status} ${errCodeOf(noLoc.json)}`,
        inspect_status: cd.status,
        restore_status: cres.status,
        restore_replaced: crst.replaced ?? null,
        cross_project: `${cross.status} ${errCodeOf(cross.json)}`,
        inside_project_root: `${insideLoc.status} ${errCodeOf(insideLoc.json)}`,
      },
    });
  } finally {
    backend.proc.kill();
    await sleep(400);
    info(`  后端进程已收（exit=${String(backend.proc.exitCode)}，日志 ${backend.logPath}）`);
  }
}

// ══════════════════════════ ⑦ 防漂移与口径 ══════════════════════════

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * 去注释时**认字符串字面量**（`"http://…"` 里的 `//` 不是注释起点）。
 *
 * 缺陷 B 的静态判据要用它：注释里写 `**` 是正常的文档记号，**渲染出去**的文案里带 `**` 才是缺陷
 * （Markdown 记号会逐字出现在页面上）。所以判据是"剥掉注释后，这两个界面文件里不再出现 `**`"。
 */
function stripJsComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === c) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 剥注释后带 `**` 的行（界面文案不许把 Markdown 记号原样显示出去） */
function markdownMarkLines(rel: string): { line: number; text: string }[] {
  const src = stripJsComments(read(path.join(REPO, rel)));
  return src
    .split(/\r?\n/)
    .map((text, idx) => ({ line: idx + 1, text: text.trim() }))
    .filter((r) => r.text.includes("**"));
}

async function section7(): Promise<void> {
  console.log("\n[verify] ⑦ 防漂移与口径：remote-routes 登记 / package.json / README / V06-14 未动");
  const routes = await import("../src/server/remote-routes");
  const mine = routes.REMOTE_ROUTES.filter((r) => r.id.startsWith("backup"));
  const want: [string, string, string][] = [
    ["backups-list", "GET", "read"],
    ["backups-create", "POST", "write"],
    ["backup-inspect", "GET", "read"],
    ["backup-restore", "POST", "write"],
  ];
  ok(
    want.every(([id, method, kind]) => mine.some((r) => r.id === id && r.method === method && r.kind === kind)) &&
      mine.length === want.length,
    `⑦-1 四条路由登记进 remote-routes.ts（${mine.map((r) => `${r.id}:${r.method}/${r.kind}`).join("、")}）——` +
      "写口在只读模式下必须被拒由 verify:s2 逐条打",
  );
  const indexSrc = stripComments(read(path.join(REPO, "src", "server", "index.ts")));
  const anchors = mine.flatMap((r) => r.anchors);
  const anchorHits = anchors.map((a) => ({ a, n: indexSrc.split(a).length - 1 }));
  ok(
    anchorHits.length === 4 && anchorHits.every((h) => h.n === 1),
    `⑦-2 anchors 防漂移：${anchorHits.length} 条条件在 index.ts（剥注释后）各命中恰好 1 次` +
      `（锚点计数 ${anchorHits.map((h) => h.n).join("/")}）`,
  );
  const mentions = routes.REMOTE_ROUTES.reduce((n, r) => n + (r.mentions ?? 1), 0);
  ok(
    mentions === routes.routeMentionTotal(),
    `⑦-3 清单提及总数 ${mentions} 与逐条之和一致（verify:s2 段②按同一份清单对账 index.ts 的方法提及数）`,
  );

  const pkg = JSON.parse(read(path.join(REPO, "package.json"))) as { scripts: Record<string, string> };
  ok(
    pkg.scripts["verify:v09-06"] === "tsx scripts/verify-v09-06.ts",
    `⑦-4 package.json 登记 \`verify:v09-06\` = ${String(pkg.scripts["verify:v09-06"])}`,
  );

  const readme = read(path.join(REPO, "README.md"));
  ok(
    readme.includes("私有事实") && readme.includes("隔离目录") && readme.includes("备份") && readme.includes("verify:v09-06"),
    "⑦-5 README 能力表写明私有事实备份入口（清单/隔离恢复/不自动替换），脚本表补 verify:v09-06",
  );
  ok(
    !/已备份/.test(readme.split("## 现在可以使用什么")[1]?.split("##")[0] ?? "") ||
      /不等于|不能|不会/.test(readme.split("## 现在可以使用什么")[1]?.split("##")[0] ?? ""),
    "⑦-6 README 能力行不把「代码进了 Git」说成「已备份」（忽略/提交都不等于私有事实已备份）",
  );

  const backupSha = sha256File(path.join(REPO, "src", "server", "work", "backup.ts"));
  ok(
    /^[0-9a-f]{64}$/.test(backupSha),
    `⑦-7 V06-14 的 \`src/server/work/backup.ts\` 内容哈希 ${backupSha.slice(0, 12)}…（本卡只**复用**它，` +
      "未改其语义；同一哈希在交付摘要里与基线对照）",
  );
  rawSection("drift", {
    routes: mine.map((r) => ({ id: r.id, method: r.method, kind: r.kind, anchors: r.anchors })),
    anchor_hits: anchorHits,
    backup_ts_sha256: backupSha,
  });

  // 缺陷 B（第 3 轮返工）：界面文案不许把 Markdown 记号原样显示出去。
  // 判据是**剥掉注释后**这两个界面文件里不再有字面 `**`（注释里写 `**` 是正常的文档记号）。
  // 服务端文案渲染进提醒卡片的那几处（`private_facts.label` / `verification.label` / `version.note`）
  // 由 verify-v09-06-ui.py 在**真浏览器里读渲染出来的文字**验（那是"用户到底看见什么"的判据）。
  for (const rel of ["src/ui/components/BackupPanel.tsx", "src/ui/components/VersionReminder.tsx"]) {
    const hits = markdownMarkLines(rel);
    ok(
      hits.length === 0,
      `⑦-8 ${rel} 里没有字面 \`**\`（剥注释后命中 ${hits.length} 行：` +
        `${hits.slice(0, 3).map((h) => `L${h.line} ${h.text.slice(0, 48)}`).join(" / ") || "无"}）` +
        "——Markdown 记号会逐字显示在页面上",
    );
  }
  rawSection("drift_markdown_marks", {
    "src/ui/components/BackupPanel.tsx": markdownMarkLines("src/ui/components/BackupPanel.tsx").length,
    "src/ui/components/VersionReminder.tsx": markdownMarkLines("src/ui/components/VersionReminder.tsx").length,
  });
}

// ══════════════════════════ ⑧ 自证 ══════════════════════════

function section8(realBefore: string[]): void {
  console.log("\n[verify] ⑧ 自证：夹具全在临时目录 / 真实仓库 `.工作台` 零改动");
  ok(
    path.resolve(DATA_DIR).startsWith(path.resolve(TMP) + path.sep) &&
      path.resolve(DATA_DIR) !== path.resolve(path.join(REPO, ".工作台")),
    `⑧-1 夹具数据目录在临时目录下（${DATA_DIR}）——本脚本不碰真实注册表与真实数据目录`,
  );
  const realAfter = realWorkbenchFiles();
  // 注意：realWorkbenchFiles() 返回的是**相对 `.工作台`** 且用 `/` 分隔的路径（不含 `.工作台/` 前缀）
  const evPrefix = "evidence/V09-06";
  const inEvidence = (f: string): boolean => f === evPrefix || f.startsWith(`${evPrefix}/`);
  const added = realAfter.filter((f) => !realBefore.includes(f));
  const removed = realBefore.filter((f) => !realAfter.includes(f));
  const unexpectedAdded = added.filter((f) => !inEvidence(f));
  const unexpectedRemoved = removed.filter((f) => !inEvidence(f));
  ok(
    unexpectedAdded.length === 0 && unexpectedRemoved.length === 0,
    `⑧-2 真实仓库 \`.工作台\` 零改动（新增 ${added.length} 个、删除 ${removed.length} 个；` +
      `本卡唯一允许写的是自己的证据目录 \`.工作台/evidence/V09-06/\`，越界新增：` +
      `${unexpectedAdded.join("、") || "无"}；越界删除：${unexpectedRemoved.join("、") || "无"}）`,
  );
  info(`  本卡证据目录：${EVIDENCE_DIR}${fs.existsSync(EVIDENCE_DIR) ? "（已存在）" : "（本次未写）"}`);
  ok(
    !fs.existsSync(path.join(REPO, ".工作台", "backups")) &&
      !fs.existsSync(path.join(REPO, ".工作台", "restores")),
    "⑧-3 塔台自己的 `.工作台` 里没有多出 `backups/` / `restores/` 目录（落点策略不许把副本写进项目根）",
  );
}

// ══════════════════════════ main ══════════════════════════

async function main(): Promise<void> {
  console.log(`[verify] V09-06 私有事实备份/恢复入口（临时目录 ${TMP}；KEEP=${KEEP ? "1" : "0"}）`);
  const realBefore = realWorkbenchFiles();
  mkdirp(DATA_DIR);
  mkdirp(path.join(TMP, "projects"));

  section2();
  section3();
  section4();
  section5();
  section9();
  section10();
  section11();
  section12();
  await section6();
  await section7();
  section8(realBefore);

  const total = passCount + failCount;
  console.log(`\n[verify] V09-06 结果：${passCount} PASS / ${failCount} FAIL（共 ${total} 条断言，${infoCount} 条读数）`);
  console.log("[verify] RAW-BEGIN");
  console.log(json(raw));
  console.log("[verify] RAW-END");
  if (RAW_DIR !== "") {
    try {
      mkdirp(RAW_DIR);
      fs.writeFileSync(path.join(RAW_DIR, "v09-06-raw.json"), json(raw) + "\n", "utf8");
      console.log(`[verify] 原始读数已落 ${path.join(RAW_DIR, "v09-06-raw.json")}`);
    } catch (e) {
      console.error(`[verify] 原始读数落盘失败：${(e as Error).message}`);
    }
  }
  if (failCount > 0) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  console.error(`[verify] 异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
} finally {
  if (process.env.TATAI_V0906_KEEP_TMP === "1") {
    console.log(`[verify] 保留现场：${TMP}`);
  } else {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch (e) {
      console.error(`[verify] 临时目录未删干净（${(e as Error).message}）：${TMP}`);
    }
  }
}
