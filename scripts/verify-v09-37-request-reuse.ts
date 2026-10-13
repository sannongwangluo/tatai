// V09-37 性能根因修复 · 请求内重复读取/重复核验消除 —— 行为/边界回归（红→绿）。
//
// 对应本轮最小修法（只做**同一请求内同输入只读结果的复用**，判据/返回字段/错误语义一字不改）：
//   修改 1：`readJobs.computeSyncStatusView` 把「现读快照 + readSyncStatus」整条同步判据链收进**一层派生作用域**；
//           `ledgerIdentityOf` 的**回包前账本内容身份复核**留在作用域**外**现读（fresh-read guard，不被记忆吞掉）。
//   修改 2：`evidence.readEvidence` 在派生作用域内按 (workDir, sha256) 记忆化、返回**深独立副本**；
//           内容寻址、写一次，键即内容地址；作用域 `finally` 一到即丢、**跨请求不缓存**。
//
// 钉住的性质：
//   S1 判据不变：`computeSyncStatusView` 的报告与直接 `readSyncStatus` **逐字段相等**（忽略 checked_at）。
//   S2 重复读取下降：同一次同步派生内账本整读次数显著低于**无作用域**的等价序列。
//   S3 fresh-read guard 仍在作用域外现读：一次 `computeSyncStatusView` 里，账本读取既有**作用域内**、也有**作用域外**。
//   S4 作用域不吞前后复核：**调用进行中**账本被追加一条现行批次登记 → 回包前复核检出 → 同一次调用内重算，
//      报告看到新批次（不是返回变过的旧结论）。
//   S5 不跨请求：两次 `computeSyncStatusView` 之间新增登记 → 第二次报告看到新批次。
//   E1 作用域外 readEvidence 读几次就是几次（默认路径逐字不变）。
//   E2 同一次派生内同一份证据只现读 1 次（此前每条检查各读一遍）。
//   E3 返回**深独立副本**：就地深改 binding / source_manifest.files[*] / 标量不泄露给同次派生的其他调用。
//   E4 内容被改/被删 → **下一个请求**判缺/对不上内容地址（抛 WorkError）；**同一次派生内**由于无 await，
//      返回本次派生的首个现读结论（边界如实标注，不假装会中途重读）。
//   E5 仅改 metadata（不改 content）：同一次派生内仍用首个结论（边界）；**下一个请求**读到新 metadata（重读，
//      非跨请求缓存）。
//   E6 跨 workDir 不串味：同内容地址、不同 workDir 的证据各读各的（键含 workDir）。
//
// 隔离口径（AGENTS.md §5）：mkdtemp 夹具 + 隔离 dataDir；不碰真实 ~/.tatai、真实项目与账本、不接网关、不调模型。
import crypto from "node:crypto";
import cp from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as registryMod from "../src/server/registry";
import { WorkService } from "../src/server/work/service";
import * as syncMod from "../src/server/work/sync";
import * as contractMod from "../src/server/work/syncContract";
import * as eventStoreMod from "../src/server/work/eventStore";
import * as tasksMod from "../src/server/work/tasks";
import * as referencesMod from "../src/server/work/references";
import * as probeMod from "../src/server/work/syncProbe";
import "../src/server/work/syncGraph"; // 注册 canonical 六图探针（side effect）
import { computeSyncStatusView } from "../src/server/work/readJobs";
import { readEvidence, evidenceBlobPath, sha256Hex } from "../src/server/work/evidence";
import { withDerivationScope, inDerivationScope } from "../src/server/work/derivationScope";
import { buildSourceManifest, verifySourceManifest, prewarmGitIgnored } from "../src/server/work/sourceEvidence";
import { readWorkspaces } from "../src/server/work/workspaces";
import { eventsSnapshotOf } from "../src/server/work/statusProjection";

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount += 1;
  else {
    failCount += 1;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1400)}`);
  }
};
const info = (m: string): void => console.log(`[verify] ${m}`);
const sha256 = (d: string | Buffer): string => crypto.createHash("sha256").update(d).digest("hex");
const mkdirp = (d: string): void => { fs.mkdirSync(d, { recursive: true }); };
const write = (f: string, t: string | Buffer): void => { mkdirp(path.dirname(f)); fs.writeFileSync(f, t); };
const writeJson = (f: string, v: unknown): void => write(f, `${JSON.stringify(v, null, 2)}\n`);
const normalize = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(normalize)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "checked_at").map(([k, x]) => [k, normalize(x)]))
      : v;
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── 读计数插桩：记 readFileSync/openSync 次数，并记下 events.jsonl 每次读取时的 inDerivationScope() ──
const readCount = new Map<string, number>();
const ledgerScopes: boolean[] = [];
const origReadFileSync = fs.readFileSync;
const origOpenSync = fs.openSync;
const origCloseSync = fs.closeSync;
const fdPaths = new Map<number, string>();
let counting = false;
let ledgerPathAbs = "";
let onLedgerRead: (() => void) | null = null;
function bump(p: unknown): void {
  if (!counting) return;
  const key = String(p).replace(/\\/g, "/");
  readCount.set(key, (readCount.get(key) ?? 0) + 1);
  if (path.resolve(String(p)) === ledgerPathAbs) ledgerScopes.push(inDerivationScope());
}
function fireLedgerRead(pAbs: string): void {
  if (onLedgerRead !== null && path.resolve(pAbs) === ledgerPathAbs) onLedgerRead();
}
function installCounter(): void {
  (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = function (p: fs.PathOrFileDescriptor, ...rest: unknown[]) {
    bump(p);
    const out = (origReadFileSync as unknown as (...a: unknown[]) => unknown).call(fs, p, ...rest);
    fireLedgerRead(String(p));
    return out as never;
  } as typeof fs.readFileSync;
  (fs as unknown as { openSync: typeof fs.openSync }).openSync = function (p: fs.PathLike, ...rest: unknown[]) {
    bump(p);
    const fd = (origOpenSync as unknown as (...a: unknown[]) => number).call(fs, p, ...rest);
    fdPaths.set(fd, String(p));
    return fd as never;
  } as typeof fs.openSync;
  (fs as unknown as { closeSync: typeof fs.closeSync }).closeSync = function (fd: number) {
    const p = fdPaths.get(fd);
    fdPaths.delete(fd);
    const out = (origCloseSync as unknown as (...a: unknown[]) => unknown).call(fs, fd);
    if (p !== undefined) fireLedgerRead(p);
    return out as never;
  } as typeof fs.closeSync;
}
function uninstallCounter(): void {
  (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = origReadFileSync;
  (fs as unknown as { openSync: typeof fs.openSync }).openSync = origOpenSync;
  (fs as unknown as { closeSync: typeof fs.closeSync }).closeSync = origCloseSync;
  fdPaths.clear();
}
function ofPath(p: string): number {
  return readCount.get(p.replace(/\\/g, "/")) ?? 0;
}
function resetCounts(): void {
  readCount.clear();
  ledgerScopes.length = 0;
}

async function main(): Promise<void> {
  info(`V09-37 请求内复用 · 专项回归（${process.platform} · node ${process.version}）`);

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-37-reuse-"));
  const dataDir = path.join(tmpBase, "home");
  const root = path.join(tmpBase, "proj");
  const workDir = path.join(root, ".工作台", "work");
  const inbox = path.join(workDir, "sync-inbox");
  const archDir = path.join(root, ".工作台", "arch");
  const PID = "v0937fx";
  const CHG = "chg-v0937";

  const SOURCE_REL = "reports/result.md";
  const SOURCE_ABS = path.join(root, SOURCE_REL);
  const MODULES_ABS = path.join(archDir, "modules.json");
  const DESIGN_ABS = path.join(root, ".工作台", "design.md");
  const PLAN_ABS = path.join(root, ".工作台", "plan.md");

  const planText = (title: string, cards: { id: string; goal: string; role: string }[]): string => {
    const L = [`# ${title}`, "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"];
    for (const c of cards) L.push(`| ${c.id} | todo | ${c.goal} |  | ${c.id} 的完成证据 |`);
    L.push("");
    for (const c of cards) L.push(`### ${c.id} ${c.goal}`, "", `**设计依据**：§1。**依赖**：无。**文件责任**：\`src/${c.id.toLowerCase()}.ts\`。**责任角色**：${c.role}。`, "", `- [ ] ${c.goal} 达标`, "");
    return L.join("\n");
  };

  // ═══ 0. 夹具（隔离 dataDir；真实文件、真实契约、真实收件目录）═══
  mkdirp(dataDir);
  mkdirp(root);
  mkdirp(inbox);
  write(SOURCE_ABS, "V09-37 请求内复用夹具：真实 artifact。\n");
  writeJson(MODULES_ABS, { version: 1, generated_at: "2026-10-13T00:00:00.000Z", budget_exhausted: false, modules: [{ id: "src", path: "src", file_count: 1, loc: 0, deps: [] }] });
  write(DESIGN_ABS, "# V09-37 复用夹具设计书\n\n## 1 目标\n\n夹具设计正文。\n");
  const PLAN_TEXT = planText("V09-37 复用夹具施工图", [{ id: "T-1", goal: "夹具卡一", role: "executor" }]);
  write(PLAN_ABS, PLAN_TEXT);

  registryMod.addProject({ id: PID, name: "V09-37 请求内复用夹具", path: root, kind: "backend" }, dataDir);

  const service = new WorkService({ dataDir });
  const submitter = { submit: (c: unknown) => service.submit(c) };
  tasksMod.submitDefinitionImports(submitter, { project_id: PID, change_id: CHG, actor_id: "fixture", role: "coordinator", definitions: referencesMod.importPlanChecked(PLAN_TEXT, workDir).definitions });

  const postEvidence = (batchId: string, contractSha: string): void => {
    const pkg = {
      schema_version: 1,
      batch_id: batchId,
      project_id: PID,
      contract_sha256: contractSha,
      completed: true,
      items: [{ id: "chk", result: "passed", artifacts: [{ path: SOURCE_REL, sha256: sha256(fs.readFileSync(SOURCE_ABS)) }] }],
    };
    const tmp = path.join(inbox, `.${batchId}.evidence.json.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(pkg, null, 2)}\n`);
    fs.renameSync(tmp, path.join(inbox, `${batchId}.evidence.json`));
  };
  const register = (batchId: string): void => {
    const raw = {
      schema_version: 1,
      batch_id: batchId,
      project_id: PID,
      title: `批次 ${batchId}`,
      sources: [{ path: SOURCE_REL, sha256: sha256(fs.readFileSync(SOURCE_ABS)) }],
      items: [{ id: "chk", label: "目标文件一致", required: true, check: { type: "file_hash", path: SOURCE_REL, sha256: sha256(fs.readFileSync(SOURCE_ABS)) } }],
      blocks_entry: false,
    };
    const contract = contractMod.validateSyncContract(raw);
    const cmd = syncMod.buildRegisterContractCommand({ projectId: PID, changeId: CHG, actorId: "fixture", role: "coordinator", contract, expectedRevision: null });
    const receipt = service.submit(cmd);
    if (!receipt.ok || receipt.projection.state !== "applied") throw new Error(`登记 ${batchId} 失败：${JSON.stringify(receipt).slice(0, 300)}`);
    postEvidence(batchId, contractMod.syncContractSha256(contract));
  };

  register("r1");
  register("r2");
  register("r3");
  register("r4");
  register("r5");
  register("r6");
  info(`  契约与证据就位：6 批；收件目录 ${inbox}`);

  if (probeMod.syncGraphProbe() === null) throw new Error("六图探针未注册（syncGraph 未加载）——夹具前置失败");

  ledgerPathAbs = path.resolve(eventStoreMod.eventsPath(workDir));
  const rawLedger = fs.readFileSync(eventStoreMod.eventsPath(workDir), "utf8");
  const restoreLedger = (): void => write(eventStoreMod.eventsPath(workDir), rawLedger);

  // ═══ S1 判据不变：computeSyncStatusView 与 readSyncStatus 逐字段相等 ═══
  const unscopedReport = syncMod.readSyncStatus(PID, dataDir);
  const scopedReport = computeSyncStatusView({ projectId: PID, dataDir });
  ok(unscopedReport.batches.length === 6, "S0 夹具 6 个现行批次就位", { got: unscopedReport.batches.length });
  ok(eq(unscopedReport, scopedReport), "S1 computeSyncStatusView 报告与 readSyncStatus 逐字段相等（判据未改）");

  // ═══ S2 重复读取下降（同一同步派生内账本整读次数）═══
  // 旧路径 = 「现读快照 + readSyncStatus（无作用域）+ 回包前复核」；新路径 = computeSyncStatusView（快照与链同作用域）。
  const oldSeqReads = (() => {
    installCounter();
    counting = true;
    resetCounts();
    const snap = eventsSnapshotOf(PID, dataDir);
    syncMod.readSyncStatus(PID, dataDir, { events: snap.events });
    eventsSnapshotOf(PID, dataDir);
    counting = false;
    const n = ofPath(ledgerPathAbs);
    uninstallCounter();
    return n;
  })();
  const newSeqReads = (() => {
    installCounter();
    counting = true;
    resetCounts();
    computeSyncStatusView({ projectId: PID, dataDir });
    counting = false;
    const n = ofPath(ledgerPathAbs);
    uninstallCounter();
    return n;
  })();
  ok(
    newSeqReads > 0 && newSeqReads < oldSeqReads,
    `S2 同一同步派生内账本整读次数下降：新 ${newSeqReads} < 旧 ${oldSeqReads}`,
    { new: newSeqReads, old: oldSeqReads },
  );

  // S2b 折叠单元（这正是 computeSyncStatusView 现提供作用域的直接受益点）：同一次派生内 readWorkspaces 6 次 → 账本只读 1 次。
  const rwUnscoped = (() => {
    installCounter();
    counting = true;
    resetCounts();
    for (let i = 0; i < 6; i += 1) readWorkspaces(workDir);
    counting = false;
    const n = ofPath(ledgerPathAbs);
    uninstallCounter();
    return n;
  })();
  const rwScoped = (() => {
    installCounter();
    counting = true;
    resetCounts();
    withDerivationScope(() => {
      for (let i = 0; i < 6; i += 1) readWorkspaces(workDir);
    });
    counting = false;
    const n = ofPath(ledgerPathAbs);
    uninstallCounter();
    return n;
  })();
  ok(
    rwUnscoped === 6 && rwScoped === 1,
    `S2b 折叠单元：readWorkspaces 6 次，作用域外读账本 ${rwUnscoped} 次、同一派生内 ${rwScoped} 次（computeSyncStatusView 现已提供该作用域）`,
    { rwUnscoped, rwScoped },
  );

  // ═══ S3 fresh-read guard 在作用域外现读 ═══
  installCounter();
  counting = true;
  resetCounts();
  computeSyncStatusView({ projectId: PID, dataDir });
  counting = false;
  uninstallCounter();
  const inScope = ledgerScopes.filter(Boolean).length;
  const outScope = ledgerScopes.filter((b) => !b).length;
  ok(
    inScope > 0 && outScope > 0,
    `S3 一次 computeSyncStatusView 内账本读取既在作用域内(链)也在作用域外(回包前复核)：in=${inScope} out=${outScope}`,
    { inScope, outScope, seq: ledgerScopes },
  );

  // ═══ S4 作用域不吞前后复核：调用进行中账本被追加 → 回包前复核检出 → 同调用内重算 ═══
  {
    // 造一条**新现行批次**登记事件（拷贝真实信封，只换 seq/entity/payload.batch_id）。
    const lines = rawLedger.split("\n").filter((l) => l.trim() !== "");
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const regEv = parsed.find((e) => e.type === "sync.contract_registered");
    const maxSeq = Math.max(...parsed.map((e) => Number(e.seq)));
    if (regEv === undefined) throw new Error("夹具缺 sync.contract_registered 事件");
    const contract = regEv.payload as Record<string, unknown>;
    const injected = {
      ...regEv,
      seq: maxSeq + 1,
      entity_id: "sync:r7-inject",
      entity_revision: 1,
      event_id: crypto.randomUUID(),
      idempotency_key: `fixture-inject-${crypto.randomBytes(4).toString("hex")}`,
      occurred_at: "2026-10-13T00:00:01.000Z",
      received_at: "2026-10-13T00:00:01.000Z",
      payload: { ...contract, batch_id: "r7-inject", title: "批次 r7-inject（注入）" },
    };
    let appended = false;
    onLedgerRead = () => {
      if (appended) return;
      appended = true;
      fs.appendFileSync(eventStoreMod.eventsPath(workDir), `${JSON.stringify(injected)}\n`, "utf8");
    };
    let report: { batches: unknown[] } | null = null;
    let threw: unknown = null;
    installCounter();
    counting = true;
    resetCounts();
    try {
      report = computeSyncStatusView({ projectId: PID, dataDir }) as unknown as { batches: unknown[] };
    } catch (e) {
      threw = e;
    }
    counting = false;
    uninstallCounter();
    onLedgerRead = null;
    ok(
      appended && (threw !== null || (report !== null && report.batches.length === 7)),
      "S4 调用进行中账本被追加 → 回包前复核检出并在同一次调用内重算（报告看到第 7 批；或明确拒绝）",
      { appended, threw: threw instanceof Error ? threw.message : threw, batches: report?.batches?.length },
    );
    restoreLedger();
  }

  // ═══ S5 不跨请求：两次调用之间新增登记 → 第二次看到新批次 ═══
  {
    const before = computeSyncStatusView({ projectId: PID, dataDir });
    register("r7-later");
    const after = computeSyncStatusView({ projectId: PID, dataDir });
    ok(
      before.batches.length === 6 && after.batches.length === 7,
      "S5 两次 computeSyncStatusView 之间新增登记 → 第二次报告看到新批次（无跨请求缓存）",
      { before: before.batches.length, after: after.batches.length },
    );
  }

  // ═══ E. readEvidence 请求内去重 + 深副本 + 边界 ═══
  const srcFiles: { rel: string; abs: string; text: string }[] = [];
  for (let i = 0; i < 8; i += 1) {
    const rel = `src/part${i}.ts`;
    const text = `export const part${i} = ${i};\n`;
    const abs = path.join(root, rel);
    write(abs, text);
    srcFiles.push({ rel, abs, text });
  }
  const evContent = JSON.stringify({ note: "v09-37 fixture evidence", n: 1 });
  const evSha = sha256Hex(evContent);
  const manifestA = buildSourceManifest(root, srcFiles.map((f) => ({ path: f.rel, sha256: sha256(f.text) })));
  const evFileA = evidenceBlobPath(workDir, evSha);
  const writeEvidenceA = (over: Record<string, unknown> = {}): void =>
    write(
      evFileA,
      JSON.stringify(
        {
          evidence_id: evSha,
          sha256: evSha,
          bytes: Buffer.byteLength(evContent, "utf8"),
          kind: "self_check",
          summary: "A",
          created_by: "fixture",
          role: "executor",
          binding: { revision_kind: "code", revision: manifestA.fingerprint },
          source_ref: null,
          created_at: "2026-10-13T00:00:00.000Z",
          content: evContent,
          source_manifest: manifestA,
          workspace_id: "w-a",
          workspace_root: path.join(tmpBase, "ws-a"),
          ...over,
        },
        null,
        2,
      ),
    );
  writeEvidenceA();

  // E1 作用域外读几次就是几次
  installCounter();
  counting = true;
  resetCounts();
  for (let i = 0; i < 5; i += 1) readEvidence(workDir, evSha);
  counting = false;
  uninstallCounter();
  ok(ofPath(evFileA) === 5, `E1 作用域外 readEvidence 5 次 → 读盘 5 次（默认路径不变；实际 ${ofPath(evFileA)}）`);

  // E2 同一次派生内只现读 1 次
  installCounter();
  counting = true;
  resetCounts();
  withDerivationScope(() => {
    for (let i = 0; i < 5; i += 1) readEvidence(workDir, evSha);
  });
  counting = false;
  uninstallCounter();
  ok(ofPath(evFileA) === 1, `E2 同一次派生内 readEvidence 5 次 → 读盘 1 次（此前每条检查各读一遍；实际 ${ofPath(evFileA)}）`);

  // E3 深独立副本
  const deep = withDerivationScope(() => {
    const b1 = readEvidence(workDir, evSha);
    const beforeSummary = b1.summary;
    const beforeRev = b1.binding.revision;
    const beforePath = b1.source_manifest?.files[0]?.path ?? "";
    b1.summary = "MUTATED";
    b1.binding.revision = "MUTATED";
    if (b1.source_manifest !== null) b1.source_manifest.files[0]!.path = "MUTATED";
    const b2 = readEvidence(workDir, evSha);
    return {
      sameObject: b1 === b2,
      sameManifest: b1.source_manifest === b2.source_manifest,
      summaryOk: b2.summary === beforeSummary,
      revOk: b2.binding.revision === beforeRev,
      pathOk: (b2.source_manifest?.files[0]?.path ?? "") === beforePath,
      expectedPath: beforePath,
    };
  });
  ok(deep.sameObject === false && deep.sameManifest === false, "E3a 同一次派生内两次读返回**不同对象**、**不同清单对象**");
  ok(deep.summaryOk && deep.revOk && deep.pathOk, "E3b 就地深改 binding.summary/files[*].path 不泄露给同次派生的其他调用", {
    summaryOk: deep.summaryOk,
    revOk: deep.revOk,
    pathOk: deep.pathOk,
  });

  // E4 内容被改 / 被删 → 下一个请求判缺/对不上内容地址；同一次派生内返回首个结论（边界）
  {
    // 同一次派生内：先读 → 篡改正文（真实改 content 字节）→ 再读：仍返回首个现读结论（无 await，不中途重读）
    const within = withDerivationScope(() => {
      const first = readEvidence(workDir, evSha);
      const raw1 = JSON.parse(fs.readFileSync(evFileA, "utf8")) as Record<string, unknown>;
      raw1.content = `${String(raw1.content)} `;
      fs.writeFileSync(evFileA, JSON.stringify(raw1, null, 2), "utf8");
      const second = readEvidence(workDir, evSha);
      return { same: first.sha256 === second.sha256 && second.bytes === Buffer.byteLength(evContent, "utf8") };
    });
    ok(within.same, "E4a 同一次派生内篡改证据正文（不改本次已读）仍返回首个现读结论（边界：无 await，不中途重读）");
    // 下一个请求：内容对不上内容地址 → 抛
    let nextErr: unknown = null;
    try {
      readEvidence(workDir, evSha);
    } catch (e) {
      nextErr = e;
    }
    ok(nextErr !== null, `E4b **下一个请求**重读：证据正文与内容地址不符 → 抛（实际 ${nextErr instanceof Error ? nextErr.message.slice(0, 60) : nextErr}）`);
    writeEvidenceA(); // 还原
    // 删除 → 下一个请求判缺
    fs.rmSync(evFileA, { force: true });
    let delErr: unknown = null;
    try {
      readEvidence(workDir, evSha);
    } catch (e) {
      delErr = e;
    }
    ok(delErr !== null, "E4c **下一个请求**重读：证据被删 → 抛（不静默返回旧对象）");
    writeEvidenceA();
  }

  // E5 仅改 metadata（不改 content）：同次派生用首个结论（边界）；下一个请求读到新 metadata
  {
    const newRoot = path.join(tmpBase, "ws-a-moved");
    const within = withDerivationScope(() => {
      const first = readEvidence(workDir, evSha);
      fs.writeFileSync(evFileA, fs.readFileSync(evFileA, "utf8").replace(JSON.stringify(path.join(tmpBase, "ws-a")), JSON.stringify(newRoot)), "utf8");
      const second = readEvidence(workDir, evSha);
      return { firstRoot: first.workspace_root, secondRoot: second.workspace_root };
    });
    const next = readEvidence(workDir, evSha);
    ok(
      within.firstRoot === within.secondRoot && next.workspace_root === newRoot,
      "E5 仅改 metadata：同次派生仍用首个结论（边界）；**下一个请求**读到新 metadata（重读，非跨请求缓存）",
      { within, nextRoot: next.workspace_root, expected: newRoot },
    );
    writeEvidenceA();
  }

  // E6 跨 workDir 不串味
  {
    const rootB = path.join(tmpBase, "proj-b");
    const wdB = path.join(rootB, ".工作台", "work");
    const evFileB = evidenceBlobPath(wdB, evSha);
    write(
      evFileB,
      JSON.stringify({
        evidence_id: evSha,
        sha256: evSha,
        bytes: Buffer.byteLength(evContent, "utf8"),
        kind: "self_check",
        summary: "B",
        created_by: "fixture",
        role: "executor",
        binding: { revision_kind: "code", revision: manifestA.fingerprint },
        source_ref: null,
        created_at: "2026-10-13T00:00:00.000Z",
        content: evContent,
        source_manifest: manifestA,
        workspace_id: "w-b",
        workspace_root: path.join(tmpBase, "ws-b"),
      }),
      );
    installCounter();
    counting = true;
    resetCounts();
    const cross = withDerivationScope(() => ({ a: readEvidence(workDir, evSha), b: readEvidence(wdB, evSha) }));
    counting = false;
    uninstallCounter();
    ok(
      cross.a.summary === "A" && cross.b.summary === "B" && ofPath(evFileA) === 1 && ofPath(evFileB) === 1,
      "E6 同内容地址、不同 workDir 的证据各读各的（键含 workDir，不串味）",
      { a: cross.a.summary, b: cross.b.summary, aReads: ofPath(evFileA), bReads: ofPath(evFileB) },
    );
  }

  // ═══ G. git check-ignore 按 root 批量（同一次请求内同一 root 的路径并集只探一次）═══
  {
    const gitRoot = path.join(tmpBase, "gitproj");
    mkdirp(path.join(gitRoot, "src"));
    write(path.join(gitRoot, ".gitignore"), "ignored/\n*.tmp\n");
    cp.spawnSync("git", ["-C", gitRoot, "init", "-q"], { windowsHide: true });
    const pool: { rel: string; sha: string }[] = [];
    for (let i = 0; i < 72; i += 1) {
      const rel = `src/g${i}.ts`;
      const text = `export const g${i} = ${i};\n`;
      write(path.join(gitRoot, rel), text);
      pool.push({ rel, sha: sha256(text) });
    }
    // 12 份**互不重叠**的清单（各 6 条、连续切分）→ 无预热时每份各起一次 git check-ignore。
    const gManifests: unknown[] = [];
    for (let i = 0; i < 12; i += 1) {
      const subset = pool.slice(i * 6, i * 6 + 6);
      gManifests.push(buildSourceManifest(gitRoot, subset.map((f) => ({ path: f.rel, sha256: f.sha }))));
    }
    const traceFile = path.join(tmpBase, "gittrace.json");
    const countStarts = (): number => {
      if (!fs.existsSync(traceFile)) return 0;
      return (fs.readFileSync(traceFile, "utf8").match(/"event":"start"/g) ?? []).length;
    };
    process.env.GIT_TRACE2_EVENT = traceFile;
    fs.rmSync(traceFile, { force: true });
    const noPrewarm = withDerivationScope(() => gManifests.map((m) => verifySourceManifest(gitRoot, m as never).status));
    const noPrewarmSpawns = countStarts();
    fs.rmSync(traceFile, { force: true });
    const union = [...new Set(pool.map((f) => f.rel))];
    const withPrewarm = withDerivationScope(() => {
      prewarmGitIgnored(gitRoot, union);
      return gManifests.map((m) => verifySourceManifest(gitRoot, m as never).status);
    });
    const prewarmSpawns = countStarts();
    delete process.env.GIT_TRACE2_EVENT;
    ok(
      noPrewarmSpawns === 12 && prewarmSpawns === 1,
      `G1 git check-ignore 子进程：无预热 ${noPrewarmSpawns} 次（每份清单各一次）→ 预热后 ${prewarmSpawns} 次（同 root 路径并集只探一次）`,
      { noPrewarmSpawns, prewarmSpawns },
    );
    ok(
      noPrewarm.every((s) => s === "valid") && withPrewarm.every((s) => s === "valid") && eq(noPrewarm, withPrewarm),
      "G2 预热前后逐清单 verdict 逐字段一致（批量只是少起子进程，不改判据）",
      { noPrewarm, withPrewarm },
    );
  }

  // 收尾清理
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    info(`夹具目录未能删除：${tmpBase}`);
  }

  info(`\n[verify] 结果：PASS ${passCount} · FAIL ${failCount}`);
  if (failCount === 0) info("[verify] 全部通过：V09-37 请求内复用专项回归");
}

void main().catch((e) => {
  console.error(`[verify] 夹具/脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
