// 统一优化 U5／U5.1＋U3 上游游标接线（PLAN V09-39）隔离行为验证脚本（tsx 跑）。
//
// 覆盖 V09-39 的**正常行为与失败行为**（先红后绿：本脚本在实现落地前应整体失败/报缺件）：
//   · docs/project-notes.json：稳定 id / 职责 / 关系 / 接口 / 约束 / 有限 source{path,sha256} / task_ids/tests/evidence；
//     不存在＝明确空索引；异 schema 同名文档不可覆盖；
//   · 增量 upsert / remove：只改指定项、其它项语义不重写；完整文件 hash 做 CAS（锁内核对）＋原子写；
//     重复 id / 未知字段 / 超条目·字节 / 路径 `..`·绝对 / 最终＋中间 junction 逃逸 / 凭据路径 一律拒；
//   · 来源当前完整 hash 校验（含**同长度同 mtime** 改写被识别）；源删除/移动 → stale/missing，不删源；
//     保持 id 的显式 upsert 处理路径迁移（不凭同名猜测）；
//   · Agent 声明默认待审：带 evidence 字段也不能冒充 verified；
//   · read / impact / coverage 只读（不拉 writer）；impact 给显式声明关系＋**来源新鲜度**（source_current，
//     不证明关系已验证）＋未知 coverage；read/impact/coverage 与写校验共用同一次查询的**来源读取会话**
//     （按规范路径复用、共享文件/字节预算，超预算 unknown/补取）——独立计数实际 fs.readFileSync 次数验证；
//   · host adapter（handleProjectIndexRequest）＋ callProjectIndexHost：真实回环 HTTP 拼装，token 鉴权、
//     慢 body 期间失去写所有权（assertWriteOwnership）被拒、体积上限（含 chunked 超限 → 413、
//     远超上限断连、中途断开不挂宿主）；
//   · U3 上游接线：project_entry 的上下文包页返回 `tcur1` 完整版本游标（旧 `tctx1` 拒），可被 read_design/read_plan
//     直接消费；`BuildContextOptions.events` 共享账本不再另读；账本内容身份（真实 hash）不拿 `last_seq` 冒充。
//
// 隔离口径（AGENTS.md §5）：全程不碰真实 ~/.tatai、不写任何真实纳管项目——
//   · mkdtemp 两个系统 tmp：一个当隔离 TATAI_HOME（registry.json 落这里），一个放夹具项目；
//   · TATAI_HOME 指向隔离 home；server 函数显式传 dataDir=隔离 home；收尾 rmSync 自清；
//   · 真实回环 HTTP 只绑 127.0.0.1、随机端口；不下载依赖、不起正式服务、不提交、不递归委派。
//
// 用法：`node --import tsx scripts/verify-unified-index.ts`（package.json 条目由协调器统一添加；本脚本不改 package.json）。
// 退出码 0 = 全 PASS；1 = 有 FAIL。
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { addProject } from "../src/server/registry";
import { WorkError } from "../src/server/work/types";
import { sha256Hex } from "../src/server/work/documents";
import {
  PROJECT_NOTES_REL,
  PROJECT_NOTES_SCHEMA_VERSION,
  PROJECT_NOTES_DOC,
  readProjectNotesIndex,
  projectIndexImpact,
  projectIndexCoverage,
  upsertProjectNotes,
  removeProjectNotes,
  validateProjectNotesDocument,
} from "../src/server/work/projectIndex";
import {
  handleProjectIndexRequest,
  callProjectIndexHost,
  PROJECT_INDEX_ROUTE_PREFIX,
} from "../src/server/work/projectIndexHost";
import { projectIndexTool } from "../src/mcp/tools/projectIndex";
import type { McpTool, McpContext } from "../src/mcp/tools/types";
import { buildContextPackage, clearContextPackages } from "../src/server/work/context";
import { isLegacyCursor, parseProjectCursor } from "../src/shared/continuationCursor";
import { readDesignTool } from "../src/mcp/tools/readDesign";
import { readPlanTool } from "../src/mcp/tools/readPlan";
import { CONTINUATION_PERSISTENCE } from "../src/server/work/continuation";
import type { WorkServiceClient, WorkServiceDescriptor } from "../src/server/work/service";

let pass = 0;
let skipped = 0;
const fails: string[] = [];
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else fails.push(label);
};
const skip = (label: string, why: string): void => {
  skipped += 1;
  console.log(`[verify] SKIP ${label} —— ${why}`);
};
const info = (msg: string): void => console.log(`[verify]   ${msg}`);

const CLEANUP: string[] = [];
const mkTmp = (tag: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `v09-39-${tag}-`));
  CLEANUP.push(dir);
  return dir;
};

interface CallResult {
  isError: boolean;
  text: string;
  json: unknown;
}
const call = async (tool: McpTool, args: Record<string, unknown>, ctx?: McpContext): Promise<CallResult> => {
  const r = (await tool.handler(args, ctx)) as { content: { text: string }[]; isError?: boolean };
  const text = r.content?.[0]?.text ?? "";
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: r.isError === true, text, json };
};
const jget = (j: unknown): Record<string, unknown> => (j ?? {}) as Record<string, unknown>;

/** 递归快照（相对路径 → size:mtimeMs），用于「只读不落盘」断言 */
function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (abs: string): void => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out.set(path.relative(root, p).split(path.sep).join("/"), `${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function noteEntry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    responsibility: `${id} 的职责`,
    paths: [`src/${id}.ts`],
    interfaces: [],
    constraints: [],
    relations: [],
    sources: [],
    task_ids: [],
    tests: [],
    evidence_refs: [],
    declared_by: "fixture-agent",
    ...over,
  };
}

function readNotesRaw(dir: string): { exists: boolean; value: Record<string, unknown> | null; sha: string | null } {
  const file = path.join(dir, PROJECT_NOTES_REL);
  if (!fs.existsSync(file)) return { exists: false, value: null, sha: null };
  const buf = fs.readFileSync(file);
  return { exists: true, value: JSON.parse(buf.toString("utf8")) as Record<string, unknown>, sha: sha256Hex(buf) };
}

// ── 真实回环 HTTP 宿主：挂 handleProjectIndexRequest（adapter）＋ token ＋ 可切换写所有权 ──
interface HostHarness {
  port: number;
  token: string;
  setOwnership: (v: boolean) => void;
  stub: WorkServiceClient;
  close: () => Promise<void>;
}
async function startHost(dataDir: string, token: string): Promise<HostHarness> {
  let owned = true;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    void handleProjectIndexRequest(req, res, {
      dataDir,
      token,
      pathname,
      assertWriteOwnership: () => {
        if (!owned) throw new WorkError("SERVICE_UNAVAILABLE", "本进程已非唯一写宿主（夹具模拟易主）");
      },
    }).then(
      (handled) => {
        if (!handled) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "INVALID_COMMAND", message: "not a project-index route" }));
        }
      },
      (e: unknown) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "PROJECTION_FAILED", message: String(e) }));
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const desc: WorkServiceDescriptor = {
    schema_version: 2,
    pid: process.pid,
    host: "127.0.0.1",
    port,
    token,
    started_at: new Date().toISOString(),
    url: `http://127.0.0.1:${port}`,
  };
  const stub = { ensureWorkService: async () => desc } as unknown as WorkServiceClient;
  return {
    port,
    token,
    setOwnership: (v) => {
      owned = v;
    },
    stub,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function main(): Promise<void> {
  const base = mkTmp("base");
  const isoHome = mkTmp("home");
  process.env.TATAI_HOME = isoHome;
  info(`隔离 home=${isoHome}；夹具根=${base}`);

  // 夹具项目：登记在隔离 home；写 .工作台/design.md、.工作台/plan.md 供上下文接线测试
  const dirOf = (id: string): string => path.join(base, `proj-${id}`);
  const designLines = ["# 夹具设计书", "", "## 1 概述", "", "设计概述内容。", ""];
  for (let i = 1; i <= 400; i++) designLines.push(`设计填充第 ${String(i).padStart(4, "0")} 行：${"d".repeat(20)}`);
  const designText = designLines.join("\n");
  const planLines = ["# 夹具施工图", "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |", "| V09-39 | todo | 持久说明索引 | 无 | 证据 |", ""];
  for (let i = 1; i <= 600; i++) planLines.push(`填充第 ${String(i).padStart(4, "0")} 行：${"y".repeat(20)}`);
  planLines.push("");
  const planText = planLines.join("\n");
  const makeProject = (id: string): string => {
    const dir = dirOf(id);
    fs.mkdirSync(path.join(dir, ".工作台"), { recursive: true });
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".工作台", "design.md"), designText, "utf8");
    fs.writeFileSync(path.join(dir, ".工作台", "plan.md"), planText, "utf8");
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
    fs.writeFileSync(path.join(dir, "src", "b.ts"), "export const b = 2;\n", "utf8");
    fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n", "utf8");
    addProject({ id, name: `V09-39 夹具 ${id}`, path: dir, kind: "backend" }, isoHome);
    return dir;
  };
  const P = "idx"; // 主项目
  const dir = makeProject(P);

  // ═══════════════════ U5.1 schema：validateProjectNotesDocument ═══════════════════
  console.log("\n[verify] ── U5.1 schema 校验（纯）：合法通过；未知字段/重复 id/未知顶层字段被拒");
  {
    const good = {
      schema_version: PROJECT_NOTES_SCHEMA_VERSION,
      doc: PROJECT_NOTES_DOC,
      notes: [noteEntry("n1"), noteEntry("n2", { paths: ["src/b.ts"] })],
    };
    ok(validateProjectNotesDocument(good).notes.length === 2, "合法文档通过校验（2 条）");
    let unknownFieldRejected = false;
    try {
      validateProjectNotesDocument({ ...good, notes: [noteEntry("n1", { bogus_field: 1 })] });
    } catch (e) {
      unknownFieldRejected = e instanceof WorkError;
    }
    ok(unknownFieldRejected, "条目里的未知字段被拒");
    let dupRejected = false;
    try {
      validateProjectNotesDocument({ ...good, notes: [noteEntry("n1"), noteEntry("n1")] });
    } catch (e) {
      dupRejected = e instanceof WorkError;
    }
    ok(dupRejected, "重复 id 被拒");
    let topRejected = false;
    try {
      validateProjectNotesDocument({ ...good, extra_top: 1 });
    } catch (e) {
      topRejected = e instanceof WorkError;
    }
    ok(topRejected, "顶层未知字段被拒");
    let badPathRejected = false;
    try {
      validateProjectNotesDocument({ ...good, notes: [noteEntry("n1", { sources: [{ path: "../escape", sha256: "a".repeat(64) }] })] });
    } catch (e) {
      badPathRejected = e instanceof WorkError;
    }
    ok(badPathRejected, "source 路径含 `..` 被拒");
    let absRejected = false;
    try {
      validateProjectNotesDocument({ ...good, notes: [noteEntry("n1", { sources: [{ path: "C:/x", sha256: "a".repeat(64) }] })] });
    } catch (e) {
      absRejected = e instanceof WorkError;
    }
    ok(absRejected, "source 绝对/盘符路径被拒");
  }

  // ═══════════════════ U5 读：不存在＝明确空索引 ═══════════════════
  console.log("\n[verify] ── U5 读：不存在＝明确空索引（不推断无影响）");
  {
    const r = readProjectNotesIndex(P, { dataDir: isoHome });
    ok(r.notes_file.exists === false && r.entries.length === 0, "notes 文件不存在 → exists=false、entries=[]");
    ok(r.notes_file.schema_ok === true, "不存在时 schema_ok=true（合法空态）");
    ok(typeof r.note === "string" && r.note.includes("空"), "read 明确说明这是空索引，不是「没有影响」");
  }

  // ═══════════════════ U5 写：upsert 创建＋原子写＋只改指定项 ═══════════════════
  console.log("\n[verify] ── U5 写：upsert 创建、保留其它项、原子写");
  {
    const srcShaA = sha256Hex(fs.readFileSync(path.join(dir, "src", "a.ts")));
    const w1 = upsertProjectNotes(
      P,
      {
        expected_file_sha256: null,
        declared_by: "agent-1",
        entries: [
          noteEntry("n-a", {
            responsibility: "A 模块职责",
            paths: ["src/a.ts"],
            interfaces: ["export const a"],
            constraints: ["只读"],
            relations: [{ to: "n-b", kind: "depends_on", note: "A 依赖 B" }],
            sources: [{ path: "src/a.ts", sha256: srcShaA }],
            task_ids: ["V09-39"],
            tests: ["scripts/verify-unified-index.ts"],
            evidence_refs: ["event:abc"],
          }),
          noteEntry("n-b", { responsibility: "B 模块职责", paths: ["src/b.ts"] }),
        ],
      },
      isoHome,
    );
    ok(w1.entry_count === 2 && w1.created.length === 2, `upsert 创建 2 条（${w1.created.join(",")}）`);
    const raw1 = readNotesRaw(dir);
    ok(raw1.exists && raw1.value?.notes !== undefined, "notes 文件已原子落盘（可 JSON 读回）");

    // 只改 n-b 的职责；n-a 逐字节不变
    const w2 = upsertProjectNotes(
      P,
      { expected_file_sha256: raw1.sha, entries: [noteEntry("n-b", { responsibility: "B 新职责", paths: ["src/b.ts"] })] },
      isoHome,
    );
    ok(w2.updated.length === 1 && w2.created.length === 0, "第二次 upsert 只更新 n-b");
    const raw2 = readNotesRaw(dir);
    const notes = (raw2.value?.notes ?? []) as Record<string, unknown>[];
    const na = notes.find((n) => n.id === "n-a")!;
    const nb = notes.find((n) => n.id === "n-b")!;
    ok(JSON.stringify(na) === JSON.stringify(noteEntry("n-a", {
      responsibility: "A 模块职责", paths: ["src/a.ts"], interfaces: ["export const a"], constraints: ["只读"],
      relations: [{ to: "n-b", kind: "depends_on", note: "A 依赖 B" }], sources: [{ path: "src/a.ts", sha256: sha256Hex(fs.readFileSync(path.join(dir, "src", "a.ts"))) }],
      task_ids: ["V09-39"], tests: ["scripts/verify-unified-index.ts"], evidence_refs: ["event:abc"],
    })), "无关项 n-a 语义逐字节保留（只改指定项）");
    ok(nb.responsibility === "B 新职责", "n-b 已更新为新职责");
    ok(w2.file_sha256 !== raw1.sha, "写后文件 hash 变化");
  }

  // ═══════════════════ U5 写：CAS 冲突（错误 expected / 并发）═══════════════════
  console.log("\n[verify] ── U5 写：CAS（错误 expected 拒；并发只一个赢）");
  {
    const cur = readNotesRaw(dir).sha;
    let wrongRejected = false;
    try {
      upsertProjectNotes(P, { expected_file_sha256: "0".repeat(64), entries: [noteEntry("n-x")] }, isoHome);
    } catch (e) {
      wrongRejected = e instanceof WorkError && (e as WorkError).code === "VERSION_CONFLICT";
    }
    ok(wrongRejected, "expected_file_sha256 与当前不符 → VERSION_CONFLICT（不写）");

    // 并发：两个都拿同一 expected，只有一个成功
    const results = await Promise.allSettled([
      Promise.resolve().then(() => upsertProjectNotes(P, { expected_file_sha256: cur, entries: [noteEntry("n-c1")] }, isoHome)),
      Promise.resolve().then(() => upsertProjectNotes(P, { expected_file_sha256: cur, entries: [noteEntry("n-c2")] }, isoHome)),
    ]);
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    ok(okCount === 1, `并发同 expected 只一个成功（成功 ${okCount} 个）`);
  }

  // ═══════════════════ U5 写：重复 id / 未知字段 / 路径 / 凭据 / 超预算 / 异 schema ═══════════════════
  console.log("\n[verify] ── U5 写：非法输入一律拒（重复 id/未知字段/路径/凭据/超预算/异 schema）");
  {
    const cur = readNotesRaw(dir).sha;
    const expectReject = (fn: () => unknown, label: string): void => {
      let rejected = false;
      try {
        fn();
      } catch (e) {
        rejected = e instanceof WorkError;
      }
      ok(rejected, label);
    };
    expectReject(
      () => upsertProjectNotes(P, { expected_file_sha256: cur, entries: [noteEntry("n-a", { bogus: 1 })] }, isoHome),
      "upsert 未知字段被拒",
    );
    expectReject(
      () => upsertProjectNotes(P, { expected_file_sha256: cur, entries: [noteEntry("n-a", { sources: [{ path: "../x", sha256: "a".repeat(64) }] })] }, isoHome),
      "upsert source 含 `..` 被拒",
    );
    expectReject(
      () => upsertProjectNotes(P, { expected_file_sha256: cur, entries: [noteEntry("n-cred", { sources: [{ path: ".env", sha256: "a".repeat(64) }] })] }, isoHome),
      "upsert 凭据路径（.env）被拒",
    );
    const big = "z".repeat(4 * 1024 * 1024);
    expectReject(
      () =>
        upsertProjectNotes(
          P,
          { expected_file_sha256: cur, entries: [noteEntry("n-big", { responsibility: big })] },
          isoHome,
        ),
      "upsert 超字节预算被拒",
    );
  }

  // ═══════════════════ U5：来源当前完整 hash 校验（错误 sha / 同长 mtime / 删除 / 移动）═══════════════════
  console.log("\n[verify] ── U5：来源当前完整 hash 校验与 stale/missing");
  {
    // 错误 sha：upsert 时声明的 sha 与当前不符 → 拒
    let wrongShaRejected = false;
    try {
      upsertProjectNotes(
        P,
        { expected_file_sha256: readNotesRaw(dir).sha, entries: [noteEntry("n-a", { sources: [{ path: "src/a.ts", sha256: "f".repeat(64) }] })] },
        isoHome,
      );
    } catch (e) {
      wrongShaRejected = e instanceof WorkError;
    }
    ok(wrongShaRejected, "upsert 声明 sha 与当前源不符 → 拒（不许编造当前哈希）");

    // 只读：先写一份合法声明（用当前 sha），再改源内容（保持同长同 mtime）
    const srcPath = path.join(dir, "src", "b.ts");
    const before = fs.readFileSync(srcPath);
    const stBefore = fs.statSync(srcPath);
    const shaBefore = sha256Hex(before);
    upsertProjectNotes(
      P,
      { expected_file_sha256: readNotesRaw(dir).sha, entries: [noteEntry("n-b", { sources: [{ path: "src/b.ts", sha256: shaBefore }] })] },
      isoHome,
    );
    const sameLen = Buffer.from(before.toString("utf8").replace("2", "9"), "utf8"); // 同长度改写
    fs.writeFileSync(srcPath, sameLen);
    fs.utimesSync(srcPath, stBefore.atime, stBefore.mtime); // 恢复 mtime（同长同 mtime）
    const readAfter = readProjectNotesIndex(P, { dataDir: isoHome, id: "n-b" });
    const srcView = ((jget(readAfter.entries[0]).sources as Record<string, unknown>[]) ?? [])[0];
    ok(jget(srcView).status === "stale", `同长度＋同 mtime 改写被识别为 stale（status=${String(jget(srcView).status)}）`);

    // 删除源 → missing（不删源、不删说明）
    fs.rmSync(srcPath);
    const readMissing = readProjectNotesIndex(P, { dataDir: isoHome, id: "n-b" });
    const srcMissing = ((jget(readMissing.entries[0]).sources as Record<string, unknown>[]) ?? [])[0];
    ok(jget(srcMissing).status === "missing", `源删除被识别为 missing（status=${String(jget(srcMissing).status)}）`);
    ok(readNotesRaw(dir).value !== null, "源删除不影响说明文档本身（不删源、不删说明）");

    // 移动：把 a.ts 改名到 a2.ts（说明仍指 a.ts）→ 对 n-a 的来源表现为 missing
    fs.renameSync(path.join(dir, "src", "a.ts"), path.join(dir, "src", "a2.ts"));
    const readMoved = readProjectNotesIndex(P, { dataDir: isoHome, id: "n-a" });
    const srcMoved = ((jget(readMoved.entries[0]).sources as Record<string, unknown>[]) ?? [])[0];
    ok(jget(srcMoved).status === "missing", "源移动（旧路径消失）→ missing");
    // 迁移：保持 id 的显式 upsert（改 paths 指向新文件）——不凭同名猜测
    const shaA2 = sha256Hex(fs.readFileSync(path.join(dir, "src", "a2.ts")));
    const wMig = upsertProjectNotes(
      P,
      { expected_file_sha256: readNotesRaw(dir).sha, entries: [noteEntry("n-a", { responsibility: "A 模块职责", paths: ["src/a2.ts"], sources: [{ path: "src/a2.ts", sha256: shaA2 }] })] },
      isoHome,
    );
    ok(wMig.updated.includes("n-a"), "保持 id 的显式 upsert 完成路径迁移");
    const readMig = readProjectNotesIndex(P, { dataDir: isoHome, id: "n-a" });
    const srcMig = ((jget(readMig.entries[0]).sources as Record<string, unknown>[]) ?? [])[0];
    ok(jget(srcMig).status === "ok", "迁移后来源状态 ok");
  }

  // ═══════════════════ U5：Agent 声明默认待审（带 evidence 也不能冒充 verified）═══════════════════
  console.log("\n[verify] ── U5：Agent 声明默认待审");
  {
    const r = readProjectNotesIndex(P, { dataDir: isoHome, id: "n-a" });
    const e = jget(r.entries[0]);
    const ver = jget(e.verification);
    ok(ver.status === "declared", "条目 verification.status=declared（Agent 声明待审）");
    ok(ver.verified !== true, "带 evidence_refs 也不能把声明升格为 verified");
    const relEntry = jget(readProjectNotesIndex(P, { dataDir: isoHome, id: "n-a" }).entries[0]);
    const rel = (relEntry.relations ?? []) as Record<string, unknown>[];
    ok(rel.length === 0 || jget(rel[0]).status === "declared", "关系没有独立证据时只标 declared");
  }

  // ═══════════════════ U5：schema 冲突（异 schema 同名文档不可覆盖）═══════════════════
  console.log("\n[verify] ── U5：异 schema 同名文档不可覆盖");
  {
    const P2 = "conflict";
    const dir2 = makeProject(P2);
    fs.writeFileSync(path.join(dir2, PROJECT_NOTES_REL), JSON.stringify({ schema_version: 99, other: true }), "utf8");
    const before = fs.readFileSync(path.join(dir2, PROJECT_NOTES_REL));
    const r = readProjectNotesIndex(P2, { dataDir: isoHome });
    ok(r.notes_file.exists === true && r.notes_file.schema_ok === false, "read 如实报 schema 冲突（schema_ok=false）");
    ok(jget(r.notes_file.conflict).code !== undefined, "read 带冲突原因");
    let writeRejected = false;
    try {
      upsertProjectNotes(P2, { expected_file_sha256: sha256Hex(before), entries: [noteEntry("n1")] }, isoHome);
    } catch (e) {
      writeRejected = e instanceof WorkError;
    }
    ok(writeRejected, "upsert 拒绝覆盖异 schema 文档");
    ok(fs.readFileSync(path.join(dir2, PROJECT_NOTES_REL)).equals(before), "异 schema 文档原样保留（未被覆盖）");
  }

  // ═══════════════════ U5：说明文件 junction 逃逸 与 源 junction 逃逸 ═══════════════════
  console.log("\n[verify] ── U5：junction 逃逸（说明文件 / 源）被拒");
  {
    const P3 = "junction";
    const dir3 = makeProject(P3);
    const outside = path.join(base, "outside-notes");
    fs.mkdirSync(outside, { recursive: true });
    // 说明文件：docs 目录做成 junction 指向项目外
    fs.rmSync(path.join(dir3, "docs"), { recursive: true, force: true });
    let docsJunction = false;
    try {
      fs.symlinkSync(outside, path.join(dir3, "docs"), "junction");
      docsJunction = fs.existsSync(path.join(dir3, "docs"));
    } catch (e) {
      info(`docs junction 创建失败：${e instanceof Error ? e.message : String(e)}`);
    }
    if (docsJunction) {
      let rejected = false;
      try {
        upsertProjectNotes(P3, { expected_file_sha256: null, entries: [noteEntry("n1")] }, isoHome);
      } catch (e) {
        rejected = e instanceof WorkError;
      }
      ok(rejected, "说明文件经 junction 逃出项目根 → 写被拒");
      ok(!fs.existsSync(path.join(outside, "project-notes.json")), "逃逸目标处没有写出 notes 文件（零字节落盘）");
    } else {
      skip("说明文件 junction 逃逸", "本机无法创建 junction");
    }

    // 源 junction：src/link → 项目外，声明 link/leak.ts 作为来源
    const P4 = "srcjunc";
    const dir4 = makeProject(P4);
    const escapeTarget = path.join(base, "escape-src");
    fs.mkdirSync(escapeTarget, { recursive: true });
    fs.writeFileSync(path.join(escapeTarget, "leak.ts"), "export const leak = 1;\n", "utf8");
    const linkPath = path.join(dir4, "src", "link");
    let srcJunction = false;
    try {
      fs.symlinkSync(escapeTarget, linkPath, "junction");
      srcJunction = fs.existsSync(linkPath);
    } catch (e) {
      info(`src junction 创建失败：${e instanceof Error ? e.message : String(e)}`);
    }
    if (srcJunction) {
      let rejected = false;
      try {
        upsertProjectNotes(
          P4,
          { expected_file_sha256: null, entries: [noteEntry("n1", { sources: [{ path: "src/link/leak.ts", sha256: sha256Hex(fs.readFileSync(path.join(escapeTarget, "leak.ts"))) }] })] },
          isoHome,
        );
      } catch (e) {
        rejected = e instanceof WorkError;
      }
      ok(rejected, "源经**中间段 junction** 逃出项目根 → 写被拒");
    } else {
      skip("源 junction 逃逸", "本机无法创建 junction");
    }
  }

  // ═══════════════════ U5：remove 删说明不删源 ═══════════════════
  console.log("\n[verify] ── U5：remove 删除说明条目（不删源文件/证据）");
  {
    const before = readNotesRaw(dir).value as Record<string, unknown>;
    const countBefore = (before.notes as unknown[]).length;
    const srcExistsBefore = fs.existsSync(path.join(dir, "src", "a2.ts"));
    const w = removeProjectNotes(P, { expected_file_sha256: readNotesRaw(dir).sha, ids: ["n-b"] }, isoHome);
    ok(w.removed.includes("n-b"), "remove 删除了 n-b 说明条目");
    const after = readNotesRaw(dir).value as Record<string, unknown>;
    ok((after.notes as unknown[]).length === countBefore - 1, "条目数减一");
    ok(fs.existsSync(path.join(dir, "src", "a2.ts")) === srcExistsBefore, "删除说明不删源文件");
    const w2 = removeProjectNotes(P, { expected_file_sha256: readNotesRaw(dir).sha, ids: ["n-b"] }, isoHome);
    ok(w2.not_found.includes("n-b"), "重复 remove 如实报 not_found（不报假成功）");
  }

  // ═══════════════════ U5: read / impact / coverage 只读 ═══════════════════
  console.log("\n[verify] ── U5：read/impact/coverage 只读（不落盘）");
  {
    const snapBefore = snapshotTree(dir);
    readProjectNotesIndex(P, { dataDir: isoHome });
    projectIndexImpact(P, { dataDir: isoHome, path: "src/a2.ts" });
    projectIndexCoverage(P, { dataDir: isoHome, task_id: "V09-39" });
    const snapAfter = snapshotTree(dir);
    const same = snapBefore.size === snapAfter.size && [...snapBefore].every(([k, v]) => snapAfter.get(k) === v);
    ok(same, "read/impact/coverage 不写任何文件（项目树快照不变）");
  }

  // ═══════════════════ U5: impact —— 声明关系＋实际存在证据的代码引用＋未知 coverage ═══════════════════
  console.log("\n[verify] ── U5：impact 输出结构");
  {
    const imp = projectIndexImpact(P, { dataDir: isoHome, path: "src/a2.ts" });
    const matched = (imp.matched_entries as Record<string, unknown>[]) ?? [];
    ok(matched.some((m) => m.id === "n-a"), "impact 按路径找到 n-a");
    ok(typeof imp.declared_relations !== "undefined", "impact 给出显式声明关系清单");
    const refs = (imp.code_references as Record<string, unknown>[]) ?? [];
    const ref = refs.find((r) => r.path === "src/a2.ts");
    ok(ref !== undefined && jget(ref).source_current === true && jget(ref).verification === "declared", "代码引用只在实际存在且哈希相符时标 source_current=true，且仍是 declared 待审（不冒充已验证关系）");
    ok(ref !== undefined && !("evidenced" in jget(ref)), "旧字段 evidenced 已移除（不再把来源新鲜度当成关系已验证）");
    ok(typeof jget(imp.coverage).note === "string" && String(jget(imp.coverage).note).includes("未声明"), "impact 明确「未声明≠无影响」");
    const impUnknown = projectIndexImpact(P, { dataDir: isoHome, path: "src/does-not-exist-anywhere.ts" });
    ok(jget(impUnknown.coverage).status === "unknown", "无任何条目声明该路径 → coverage=unknown（不推断无影响）");
  }

  // ═══════════════════ U5: coverage —— 必需材料/实际范围版本/遗漏/补取工具 ═══════════════════
  console.log("\n[verify] ── U5：coverage 交接");
  {
    const cov = projectIndexCoverage(P, { dataDir: isoHome, task_id: "V9-NONE" });
    ok(Array.isArray(cov.required) && Array.isArray(cov.omissions) && Array.isArray(cov.supplementary), "coverage 给出 required/omissions/supplementary");
    ok(jget(cov.returned).version_sha256 !== undefined || jget(cov.returned).version_sha256 === null, "coverage 带实际返回的文件版本");
    const disc = (cov.disclaimers as string[]) ?? [];
    ok(disc.some((d) => d.includes("送达")) , "coverage 明说「送达不等于理解/验收」");
    ok((cov.supplementary as unknown[]).length > 0, "coverage 给出补取工具入口");
  }

  // ═══════════════════ U5：来源读取复用/共享预算（复审返工，独立计数实际 readFile） ═══════════════════
  console.log("\n[verify] ── U5：同查询来源读取复用（canonical 路径）＋共享文件/字节预算");
  {
    // ① 复用：100 条说明引用同一份 1 MiB 来源 → 实际 readFile 只应发生 1 次
    const P5 = "reads";
    const dir5 = makeProject(P5);
    const sharedAbs = path.join(dir5, "src", "shared.ts");
    const sharedBytes = Buffer.alloc(1024 * 1024, 0x20); // 1 MiB
    fs.writeFileSync(sharedAbs, sharedBytes);
    const sharedSha = sha256Hex(sharedBytes);
    const reuseNotes = Array.from({ length: 100 }, (_, i) =>
      noteEntry(`r-${i}`, { paths: ["src/shared.ts"], sources: [{ path: "src/shared.ts", sha256: sharedSha }] }),
    );
    fs.writeFileSync(
      path.join(dir5, PROJECT_NOTES_REL),
      JSON.stringify({ schema_version: PROJECT_NOTES_SCHEMA_VERSION, doc: PROJECT_NOTES_DOC, notes: reuseNotes }),
      "utf8",
    );
    const origRead = fs.readFileSync;
    let readFileCalls = 0;
    const fsPatch = fs as unknown as { readFileSync: (...a: unknown[]) => unknown };
    fsPatch.readFileSync = (p: unknown, ...args: unknown[]) => {
      if (typeof p === "string" && path.resolve(p) === path.resolve(sharedAbs)) readFileCalls += 1;
      return (origRead as unknown as (...a: unknown[]) => unknown)(p, ...args);
    };
    let reuseView: ReturnType<typeof readProjectNotesIndex>;
    try {
      reuseView = readProjectNotesIndex(P5, { dataDir: isoHome, limit: 100 });
    } finally {
      fs.readFileSync = origRead;
    }
    ok(reuseView.summary.returned === 100, `100 条引用同一来源全部返回（returned=${reuseView.summary.returned}）`);
    ok(readFileCalls === 1, `同一规范路径在本次查询内只现读一次（独立计数的实际 fs.readFileSync = ${readFileCalls}，不是数 helper）`);
    ok(
      reuseView.entries.every((e) => e.sources[0]?.status === "ok"),
      "复用读到的是当前内容：100 条来源状态全 ok",
    );
    info(`  红→绿对照：返工前同夹具实测 source_reads=100 / source_bytes=104857600（见证据根 review-probes/index-reads.json）`);

    // ② 路径隔离：两个不同路径不得互相串味（各自内容/哈希各自认）
    const P6 = "isolation";
    const dir6 = makeProject(P6);
    const xBytes = Buffer.from("export const x = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';\n", "utf8");
    const yBytes = Buffer.from("export const y = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';\n", "utf8");
    fs.writeFileSync(path.join(dir6, "src", "iso-x.ts"), xBytes);
    fs.writeFileSync(path.join(dir6, "src", "iso-y.ts"), yBytes);
    fs.writeFileSync(
      path.join(dir6, PROJECT_NOTES_REL),
      JSON.stringify({
        schema_version: PROJECT_NOTES_SCHEMA_VERSION,
        doc: PROJECT_NOTES_DOC,
        notes: [
          noteEntry("iso-x", { paths: ["src/iso-x.ts"], sources: [{ path: "src/iso-x.ts", sha256: sha256Hex(xBytes) }] }),
          noteEntry("iso-y", { paths: ["src/iso-y.ts"], sources: [{ path: "src/iso-y.ts", sha256: sha256Hex(yBytes) }] }),
        ],
      }),
      "utf8",
    );
    const isoView = readProjectNotesIndex(P6, { dataDir: isoHome });
    const isoX = isoView.entries.find((e) => e.id === "iso-x");
    const isoY = isoView.entries.find((e) => e.id === "iso-y");
    ok(
      isoX?.sources[0]?.current_sha256 === sha256Hex(xBytes) &&
        isoY?.sources[0]?.current_sha256 === sha256Hex(yBytes) &&
        isoX?.sources[0]?.status === "ok" &&
        isoY?.sources[0]?.status === "ok",
      "路径隔离：两个不同来源各自认自己的当前哈希（不互相串味）",
    );

    // ③ 有界合法大库：120 条 × 120 个不同小文件，在缺省预算内全部 ok
    const P7 = "biglib";
    const dir7 = makeProject(P7);
    const bigNotes = Array.from({ length: 120 }, (_, i) => {
      const rel = `src/big-${String(i).padStart(3, "0")}.ts`;
      const content = Buffer.from(`export const v${i} = ${i};\n`, "utf8");
      fs.writeFileSync(path.join(dir7, rel), content);
      return noteEntry(`big-${i}`, { paths: [rel], sources: [{ path: rel, sha256: sha256Hex(content) }] });
    });
    fs.writeFileSync(
      path.join(dir7, PROJECT_NOTES_REL),
      JSON.stringify({ schema_version: PROJECT_NOTES_SCHEMA_VERSION, doc: PROJECT_NOTES_DOC, notes: bigNotes }),
      "utf8",
    );
    const bigView = readProjectNotesIndex(P7, { dataDir: isoHome, limit: 500 });
    ok(bigView.summary.returned === 120, `有界合法大库：120 条全部返回（returned=${bigView.summary.returned}）`);
    ok(
      bigView.entries.every((e) => e.sources[0]?.status === "ok"),
      "有界合法大库：缺省预算内 120 个不同来源全 ok（预算不误伤合法范围）",
    );

    // ④ 超预算：收紧到 3 文件 / 200 KiB → 超出的明确 unknown（绝不冒充内容相符）
    const limited = readProjectNotesIndex(P7, { dataDir: isoHome, limit: 500, readLimits: { max_files: 3, max_bytes: 200 * 1024 } });
    const statuses = limited.entries.map((e) => e.sources[0]?.status);
    const okCount = statuses.filter((s) => s === "ok").length;
    const unknownCount = statuses.filter((s) => s === "unknown").length;
    ok(okCount > 0 && okCount <= 3, `超预算前只读到允许的文件数（ok=${okCount}）`);
    ok(unknownCount > 0, `超预算的来源明确标 unknown（unknown=${unknownCount}），不当成内容相符`);
    const unknownEntry = limited.entries.find((e) => e.sources[0]?.status === "unknown");
    ok(
      typeof unknownEntry?.sources[0]?.reason === "string" && /预算|补取|unknown/.test(String(unknownEntry?.sources[0]?.reason)),
      "超预算的 unknown 带预算/补取原因（可据此补取，不静默）",
    );
    ok(okCount + unknownCount === 120, "超预算查询下每条都有明确状态（ok 或 unknown，无遗漏）");

    // ⑤ 凭据路径读侧同样拒收，且不因拒收谎报存在
    const P8 = "cred";
    const dir8 = makeProject(P8);
    fs.writeFileSync(path.join(dir8, ".env"), "SECRET=1\n", "utf8");
    fs.writeFileSync(
      path.join(dir8, PROJECT_NOTES_REL),
      JSON.stringify({
        schema_version: PROJECT_NOTES_SCHEMA_VERSION,
        doc: PROJECT_NOTES_DOC,
        notes: [noteEntry("cred-1", { paths: ["src/a.ts"], sources: [{ path: ".env", sha256: "a".repeat(64) }] })],
      }),
      "utf8",
    );
    const credSrc = readProjectNotesIndex(P8, { dataDir: isoHome }).entries[0]?.sources[0];
    ok(
      credSrc?.status === "unreadable" && credSrc?.exists === false,
      "读侧拒收凭据路径（.env）且 exists=false（不因拒收谎报存在、不读取内容）",
    );
  }

  // ═══════════════════ U5: MCP 工具 project_index（read 本地；upsert/remove 经宿主）═══════════════════
  console.log("\n[verify] ── U5：MCP project_index 工具");
  {
    const r = await call(projectIndexTool, { project_id: P, op: "read", path: "src/a2.ts" });
    ok(!r.isError && jget(r.json).notes_file !== undefined, "project_index op=read（本地只读）返回 notes_file");
    const noWork = await call(projectIndexTool, { project_id: P, op: "upsert", entries: [noteEntry("n-x")] });
    ok(noWork.isError, "project_index op=upsert 无 ctx.work → 明确失败（不本地代写）");
  }

  // ═══════════════════ U5: host adapter 真实回环 HTTP（upsert/remove/持久/CAS/慢 body/体积）═══════════════════
  console.log("\n[verify] ── U5：handleProjectIndexRequest + callProjectIndexHost 真实回环 HTTP");
  {
    const token = "fixture-token-123";
    const host = await startHost(isoHome, token);
    try {
      const cur = readNotesRaw(dir).sha;
      const up = (await callProjectIndexHost(host.stub, P, "upsert", {
        expected_file_sha256: cur,
        declared_by: "host-agent",
        entries: [noteEntry("n-host", { responsibility: "经宿主写入", paths: ["README.md"], sources: [{ path: "README.md", sha256: sha256Hex(fs.readFileSync(path.join(dir, "README.md"))) }] })],
      })) as Record<string, unknown>;
      ok(up.ok === true, "callProjectIndexHost upsert 成功（真实 HTTP 往返）");
      info(`  host upsert 返回 entry_count=${String(up.entry_count)}`);

      // 重启持久：重新构造隔离进程态的读（无任何内存注册表）→ 仍可读
      const persisted = readProjectNotesIndex(P, { dataDir: isoHome, id: "n-host" });
      ok(jget(persisted.entries[0]).responsibility === "经宿主写入", "宿主写入的 notes 持久可读（重启后仍可读）");

      // 错误 token → 401
      const badToken = await fetch(`http://127.0.0.1:${host.port}${PROJECT_INDEX_ROUTE_PREFIX}upsert`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tatai-work-token": "wrong" },
        body: JSON.stringify({ project_id: P, expected_file_sha256: readNotesRaw(dir).sha, entries: [noteEntry("n-bad")] }),
      });
      ok(badToken.status === 401, `错误 token → 401（实际 ${badToken.status}）`);

      // 非本模块路由 → handle 返回 false（这里直接调函数验证）
      const nonRoute = await handleProjectIndexRequest(
        { method: "GET", headers: {} } as unknown as http.IncomingMessage,
        {} as unknown as http.ServerResponse,
        { dataDir: isoHome, token, pathname: "/api/work/health" },
      );
      ok(nonRoute === false, "非 project-index 路由返回 false（交回 workHost）");

      // remove 经宿主
      const rm = (await callProjectIndexHost(host.stub, P, "remove", {
        expected_file_sha256: readNotesRaw(dir).sha,
        ids: ["n-host"],
      })) as Record<string, unknown>;
      ok(Array.isArray(rm.removed) && (rm.removed as string[]).includes("n-host"), "callProjectIndexHost remove 成功");

      // 慢 body：先发一半 body，期间失去写所有权 → 503 拒绝、零字节落盘
      const beforeSlow = readNotesRaw(dir).sha;
      const enc = new TextEncoder();
      const body = JSON.stringify({ project_id: P, expected_file_sha256: beforeSlow, entries: [noteEntry("n-slow", { responsibility: "慢body" })] });
      const half = Math.floor(body.length / 2);
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(enc.encode(body.slice(0, half)));
          await sleep(60);
          host.setOwnership(false); // body 到达前失去所有权
          controller.enqueue(enc.encode(body.slice(half)));
          controller.close();
        },
      });
      const slowRes = await fetch(`http://127.0.0.1:${host.port}${PROJECT_INDEX_ROUTE_PREFIX}upsert`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tatai-work-token": token },
        body: stream,
        // @ts-expect-error Node fetch 流式请求体需要 duplex
        duplex: "half",
      });
      const slowText = await slowRes.text();
      ok(slowRes.status === 503, `慢 body 期间失去写所有权 → 503（实际 ${slowRes.status}）`);
      ok(slowText.includes("SERVICE_UNAVAILABLE"), "503 回执带 SERVICE_UNAVAILABLE 码");
      ok(readNotesRaw(dir).sha === beforeSlow, "慢 body 被拒后零字节落盘（文件未变）");

      // 体积上限：超大 body → 413/400 拒绝
      const huge = await fetch(`http://127.0.0.1:${host.port}${PROJECT_INDEX_ROUTE_PREFIX}upsert`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tatai-work-token": token },
        body: JSON.stringify({ project_id: P, expected_file_sha256: readNotesRaw(dir).sha, entries: [noteEntry("n-huge", { responsibility: "z".repeat(3 * 1024 * 1024) })] }),
      });
      ok(huge.status === 413 || huge.status === 400, `超体积 body 被拒（实际 ${huge.status}）`);

      // 恢复写所有权（上面慢 body 夹具把它模拟置为易主），供后续真实写与存活探针使用
      host.setOwnership(true);

      // 分块（Transfer-Encoding: chunked）超限：不加 content-length，累计越限 → 413，且不挂宿主
      const chunkStream = new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = new Uint8Array(64 * 1024);
          for (let i = 0; i < 40; i += 1) controller.enqueue(chunk); // 2.5 MiB > 上限（2 MiB + 256 KiB）
          controller.close();
        },
      });
      const chunked = await fetch(`http://127.0.0.1:${host.port}${PROJECT_INDEX_ROUTE_PREFIX}upsert`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tatai-work-token": token },
        body: chunkStream,
        // @ts-expect-error Node fetch 流式请求体需要 duplex
        duplex: "half",
      });
      ok(chunked.status === 413, `分块（chunked）超限 body → 413（实际 ${chunked.status}）`);
      await chunked.text();

      // 远超上限（>上限 + 16 MiB）：有界读取到断连——客户端拿到确定失败，宿主不挂
      let farOverRejected = false;
      try {
        const farStream = new ReadableStream<Uint8Array>({
          start(controller) {
            const chunk = new Uint8Array(64 * 1024);
            for (let i = 0; i < 340; i += 1) controller.enqueue(chunk); // ~21.25 MiB
            controller.close();
          },
        });
        const farRes = await fetch(`http://127.0.0.1:${host.port}${PROJECT_INDEX_ROUTE_PREFIX}upsert`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-tatai-work-token": token },
          body: farStream,
          signal: AbortSignal.timeout(10000),
          // @ts-expect-error Node fetch 流式请求体需要 duplex
          duplex: "half",
        });
        farOverRejected = farRes.status === 413 || farRes.status === 400 || farRes.status >= 500;
        await farRes.text().catch(() => "");
      } catch {
        farOverRejected = true; // 被断连（客户端拿到确定失败）
      }
      ok(farOverRejected, "远超上限（>上限+16MiB）的 body 被断连/拒绝（有界读取生效）");

      // 中途断开：发一半 body 后直接销毁连接 → 宿主不得挂死（socket 关闭/aborted 都要结算）
      await new Promise<void>((resolve) => {
        const sock = net.connect({ port: host.port, host: "127.0.0.1" }, () => {
          sock.write(
            `POST ${PROJECT_INDEX_ROUTE_PREFIX}upsert HTTP/1.1\r\nHost: 127.0.0.1\r\ncontent-type: application/json\r\n` +
              `x-tatai-work-token: ${token}\r\ncontent-length: 2000000\r\n\r\n`,
          );
          sock.write("x".repeat(1024)); // 只发一点就断
          setTimeout(() => {
            sock.destroy();
            resolve();
          }, 40);
        });
        sock.on("error", () => resolve());
      });

      // 宿主存活探针：非 project-index 路由仍被正常路由（404），说明中途断开没有挂死宿主
      const alive = await fetch(`http://127.0.0.1:${host.port}/api/work/health`, { signal: AbortSignal.timeout(5000) });
      ok(alive.status === 404, `中途断开后宿主仍存活并正常路由（探针 /api/work/health → ${alive.status}）`);
      const afterAbort = (await callProjectIndexHost(host.stub, P, "upsert", {
        expected_file_sha256: readNotesRaw(dir).sha,
        entries: [noteEntry("n-after-abort", { responsibility: "断开后仍可写", paths: ["README.md"] })],
      })) as Record<string, unknown>;
      ok(afterAbort.ok === true, "中途断开后经宿主照常完成一次 upsert（Promise 有结算、未挂宿主）");
    } finally {
      await host.close();
    }
  }

  // ═══════════════════ U3 上游接线：context 页 tcur1 ＋ events 共享账本＋真实账本 hash ═══════════════════
  console.log("\n[verify] ── U3：上下文包 tcur1 完整版本游标 ＋ events 共享账本");
  {
    clearContextPackages();
    const pkg = buildContextPackage(P, { dataDir: isoHome, maxChars: 3000, pageMaxChars: 800 });
    const cur = pkg.page?.next_cursor ?? null;
    ok(cur !== null && !isLegacyCursor(cur), "上下文包页返回新格式游标（非旧 tctx1）");
    const parsed = cur === null ? null : parseProjectCursor(cur);
    ok(parsed !== null && parsed.doc === "design", "页游标为 tcur1 且绑定 design 文档");

    // 真实链路：用该 tcur1 游标喂 read_design → 成功；喂 read_plan → CROSS_DOC
    if (cur !== null) {
      const rd = await call(readDesignTool, { project_id: P, cursor: cur });
      ok(!rd.isError, "read_design 直接消费 project_entry 上下文包的 tcur1 游标（真实 tool-entry→cursor 链路）");
      const rp = await call(readPlanTool, { project_id: P, cursor: cur });
      ok(rp.isError && rp.text.includes("CROSS_DOC"), "同一游标喂 read_plan → CROSS_DOC（跨文档不接续）");
    }

    // 旧 tctx1 游标明确失效
    const legacy = "tctx1:" + "a".repeat(16) + ":lines:5";
    const rl = await call(readDesignTool, { project_id: P, cursor: legacy });
    ok(rl.isError && rl.text.includes("LEGACY_CURSOR"), "旧 tctx1 游标被明确拒绝（LEGACY_CURSOR）");

    // 账本内容身份：不使用 last_seq 冒充 content_sha256
    const ledgerEntry = pkg.source_manifest.find((m) => m.path.endsWith("events.jsonl"));
    ok(ledgerEntry !== undefined, "包来源清单含 events.jsonl");
    const ledgerSha = ledgerEntry?.content_sha256 ?? "";
    ok(!String(ledgerSha).startsWith("last_seq:"), "账本内容身份不是 last_seq（不冒充内容哈希）");
    ok(ledgerSha === null || /^[0-9a-f]{64}$/.test(String(ledgerSha)), `账本内容身份是真实 64 位 sha 或 null（实际 ${String(ledgerSha).slice(0, 16)}）`);

    // events 共享账本：显式传入即不再另读；带 eventsContent 用真实 hash
    clearContextPackages();
    const fakePrefix = "b".repeat(64);
    const pkg2 = buildContextPackage(P, {
      dataDir: isoHome,
      maxChars: 3000,
      pageMaxChars: 800,
      events: [],
      eventsContent: { file_bytes: 0, verified_bytes: 0, prefix_sha256: fakePrefix },
    });
    const le2 = pkg2.source_manifest.find((m) => m.path.endsWith("events.jsonl"));
    ok(le2?.content_sha256 === fakePrefix, "传入 eventsContent 时账本内容身份即该真实 hash（不再另读）");

    // 不带 eventsContent：内容哈希留空，而不是 last_seq
    clearContextPackages();
    const pkg3 = buildContextPackage(P, { dataDir: isoHome, maxChars: 3000, pageMaxChars: 800, events: [] });
    const le3 = pkg3.source_manifest.find((m) => m.path.endsWith("events.jsonl"));
    ok(le3?.content_sha256 === null, "只传 events 未传内容身份 → content_sha256 留空（不以 last_seq 冒充）");
  }

  // ═══════════════════ U3：continuation 寿命说明（重启源未变仍可续读）══════════════════
  console.log("\n[verify] ── U3：CONTINUATION_PERSISTENCE 寿命说明");
  {
    ok(CONTINUATION_PERSISTENCE.restart_safe === true, "restart_safe=true");
    const note = String(CONTINUATION_PERSISTENCE.note ?? "");
    ok(!/只会明确报源变\/失效/.test(note) || note.includes("源未变"), "寿命说明不再笼统称重启后只失效（源未变应可续读）");
    ok(note.includes("源未变") || note.includes("未变"), "说明区分「源未变可续读 / 源变才失效」");
  }

  // ═══════════════════ 收尾 ═══════════════════
  console.log(`\n[verify] ── 汇总：${pass} PASS / ${fails.length} FAIL / ${skipped} SKIP`);
  if (fails.length > 0) {
    console.error("[verify] FAIL 明细：");
    for (const f of fails) console.error(`  - ${f}`);
  }
}

try {
  await main();
} finally {
  for (const d of CLEANUP) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 自清失败不阻断退出码含义 */
    }
  }
}
process.exit(fails.length === 0 ? 0 : 1);
