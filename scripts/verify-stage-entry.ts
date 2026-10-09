// 示例项目接续缺口 · 有界修正专项验证（2026-09-30；用户授权「先把这块对齐」，方案见
// `D:/demo-project/.工作台/tatai-alignment/20260930-diagnosis/plan.md` §6.1 R1 / §6.2 G1）。
//
// 用法：
//   pnpm verify:stage-entry                    # 改后：全部反例必须被挡住
//   pnpm verify:stage-entry -- --expect=old [--src=<HEAD 快照>/src]
//                                                    # 改前：同一批反例必须**挡不住**（留档漏洞现场）
//
// 覆盖两条修正（反例逐条落到断言名）：
//   需求A 项目级阶段必读指针 `.工作台/work/stage-reads.json`（只读、fail-closed）：
//     无配置=老项目原样兼容（不加 missing 理由、required_reads 不多条目）；合法配置 = 必读条目进
//     required_reads、preferred_task_id 只在真实就绪候选内生效；损坏/漂移/穿越/软链逃逸/错误 kind/
//     重复字段/超大/schema 不匹配 **一律 blocked 不派活**。
//   需求B 阻塞卡不许新领：`claims.claimTask` 与唯一写入服务的文件锁（`POST /api/work/command`）两条
//     入口都拒（引 blocked_reason 与"按原启动条件经协调器解阻"），零认领事件；MCP `claim_task` 同样拒；
//     准备卡照常可领、续约/取消/已交付/版本冲突的既有语义不退化。
//
// 隔离口径（AGENTS.md §5）：mkdtemp 夹具 + 隔离 TATAI_HOME + 本进程回环 HTTP（随机端口）；
// 不碰真实 ~/.tatai、不碰真实项目、不接网关、不调模型；收尾杀子进程 + 整棵删临时目录。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

// ── 断言与日志 ──

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount += 1;
  else {
    failCount += 1;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1600)}`);
  }
};
/** 反例断言：new 模式要求「反例被挡住」= `observed === newExpectation`；
 *  old 模式要求取反（同一批反例**挡不住**才是改前现场），日志措辞也按改前口径如实写。 */
const okNew = (observed: boolean, newExpectation: boolean, label: string, detail?: unknown): void => {
  if (expectOld) ok(observed === !newExpectation, `【改前口径】反例未被挡住：${label}`, detail);
  else ok(observed === newExpectation, label, detail);
};
const info = (msg: string): void => console.log(`[verify] ${msg}`);
const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const sha256File = (f: string): string => sha256(fs.readFileSync(f));

// ── 参数：期望口径 + 源树（new=仓库 src；old=HEAD 快照 src，两者同一脚本跑） ──

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (flag: string): string | null => {
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  if (eq !== undefined) return eq.slice(flag.length + 1);
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? "") : null;
};
const expectOld = (argOf("--expect") ?? "new") === "old";
const SRC = path.resolve(argOf("--src") ?? path.join(ROOT, "src"));
const MCP_ENTRY = path.join(SRC, "mcp", "index.ts");

const loadSrc = async <T>(relFromSrc: string): Promise<T> =>
  (await import(pathToFileURL(path.join(SRC, relFromSrc)).href)) as T;

// ── 隔离夹具 ──

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-entry-patch-verify-"));
const dataDir = path.join(tmpBase, "home");
const root = path.join(tmpBase, "proj-entry-patch");
const workDir = path.join(root, ".工作台", "work");
const outsideDir = path.join(tmpBase, "outside");
const STAGE_FILE = path.join(workDir, "stage-reads.json");
const TOTAL_REL = "docs/项目总图.md";
const AGENTS_REL = "AGENTS.md";
const HANDOFF_REL = ".工作台/handoff/20260930-handoff.md";
const TOTAL_ABS = path.join(root, "docs", "项目总图.md");
const AGENTS_ABS = path.join(root, "AGENTS.md");
const HANDOFF_ABS = path.join(root, ".工作台", "handoff", "20260930-handoff.md");
const CHG = "chg-entry-patch";
const EXEC = "executor-1";

const mkdirp = (d: string): void => {
  fs.mkdirSync(d, { recursive: true });
};
const write = (f: string, text: string): void => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};

interface Card {
  id: string;
  goal: string;
  dep?: string;
  priority?: string;
  role?: string;
}

const CARDS: Card[] = [
  { id: "T-A", goal: "甲事", priority: "高", role: "executor" },
  { id: "T-B", goal: "乙事", dep: "T-A", priority: "最高", role: "executor" },
  { id: "T-C", goal: "丙事", priority: "低", role: "executor" },
  { id: "T-D", goal: "丁事", priority: "中", role: "designer" },
  { id: "T-E", goal: "戊事", priority: "低", role: "executor" },
  { id: "T-F", goal: "己事", priority: "低", role: "executor" },
  { id: "T-G", goal: "庚事", priority: "低", role: "executor" },
  { id: "T-BK1", goal: "阻塞卡一", priority: "低", role: "executor" },
  { id: "T-BK2", goal: "阻塞卡二", priority: "低", role: "executor" },
  { id: "T-BK3", goal: "阻塞卡三", priority: "低", role: "executor" },
];

const planText = (title: string, cards: Card[]): string => {
  const lines = [`# ${title}`, "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"];
  for (const c of cards) lines.push(`| ${c.id} | todo | ${c.goal} | ${c.dep ?? ""} | ${c.id} 的完成证据 |`);
  lines.push("");
  for (const c of cards) {
    lines.push(`### ${c.id} ${c.goal}`);
    lines.push("");
    lines.push(
      `**设计依据**：§1。**依赖**：${c.dep ?? "无"}。**文件责任**：\`src/${c.id.toLowerCase()}.ts\`。` +
        (c.priority === undefined ? "" : `**优先级**：${c.priority}。`) +
        (c.role === undefined ? "" : `**责任角色**：${c.role}。`),
    );
    lines.push("");
    lines.push(`- [ ] ${c.goal} 达标`);
    lines.push("");
  }
  return lines.join("\n");
};

const PLAN_TEXT = planText("示例项目接续缺口修正验证施工图", CARDS);

// ── 指针文件写入助手 ──

/** 合法指针的基准（总图/AGENTS/交接三条必读 + 两条来源；preferred 可选） */
const validStageReads = (preferred: string | null): Record<string, unknown> => {
  const sources = [
    { path: TOTAL_REL, sha256: sha256File(TOTAL_ABS) },
    { path: HANDOFF_REL, sha256: sha256File(HANDOFF_ABS) },
  ];
  const entries = [
    { path: TOTAL_REL, kind: "evidence", why: "总图：项目地图与当前批次入口", revision: sha256File(TOTAL_ABS) },
    { path: AGENTS_REL, kind: "evidence", why: "工作规则：进项目先读", revision: sha256File(AGENTS_ABS) },
    { path: HANDOFF_REL, kind: "checkpoint", why: "当前交接：上一轮停止位置与续接条件", revision: sha256File(HANDOFF_ABS) },
  ];
  return {
    schema_version: 1,
    generated_from: sources,
    entries,
    ...(preferred === null ? {} : { preferred_task_id: preferred }),
  };
};
const writeStageReads = (cfg: unknown): void => {
  write(STAGE_FILE, typeof cfg === "string" ? cfg : `${JSON.stringify(cfg, null, 2)}\n`);
};
const removeStageReads = (): void => {
  fs.rmSync(STAGE_FILE, { force: true });
};

// ── MCP stdio 客户端（沿用 verify-v09-22-mcp 的 framing） ──

interface RpcMsg {
  id?: number;
  result?: { content?: { type: string; text?: string }[]; isError?: boolean; serverInfo?: { name?: string } };
  error?: unknown;
}
interface EntryLike {
  next_action: string;
  reasons: { code: string; text: string; task_id?: string | null }[];
  required_reads: { path: string; kind: string; why: string; revision?: string | null }[];
}
interface ClaimLike {
  ok?: boolean;
  code?: string;
  message?: string;
}
const reasonCodes = (e: EntryLike): string[] => e.reasons.map((r) => r.code);
const readPathsOf = (e: EntryLike): string[] => e.required_reads.map((r) => `${r.kind}:${r.path}`);

async function main(): Promise<void> {
  info(`示例项目接续缺口 · 有界修正专项验证（expect=${expectOld ? "old（改前：反例必须挡不住）" : "new（改后：反例必须挡住）"}）`);
  info(`  源树：${SRC}`);

  const entryMod = await loadSrc<typeof import("../src/server/work/entry")>("server/work/entry.ts");
  const serviceMod = await loadSrc<typeof import("../src/server/work/service")>("server/work/service.ts");
  const claimsMod = await loadSrc<typeof import("../src/server/work/claims")>("server/work/claims.ts");
  const tasksMod = await loadSrc<typeof import("../src/server/work/tasks")>("server/work/tasks.ts");
  const documentsMod = await loadSrc<typeof import("../src/server/work/documents")>("server/work/documents.ts");
  const referencesMod = await loadSrc<typeof import("../src/server/work/references")>("server/work/references.ts");
  const registryMod = await loadSrc<typeof import("../src/server/registry")>("server/registry.ts");
  const typesMod = await loadSrc<typeof import("../src/server/work/types")>("server/work/types.ts");

  // ═══ 0. 夹具与环境 ═══
  mkdirp(dataDir);
  mkdirp(outsideDir);
  write(path.join(outsideDir, "total.md"), "# 项目根外的文件（软链逃逸反例）\n");
  write(path.join(root, ".工作台", "design.md"), "# 示例项目接续缺口修正验证设计书\n\n## 1 目标\n\n夹具设计正文。\n");
  write(path.join(root, ".工作台", "plan.md"), PLAN_TEXT);
  write(TOTAL_ABS, "# 夹具项目总图\n\n## 3 当前阶段\n\n夹具总图正文（验证用）。\n");
  write(AGENTS_ABS, "# 夹具工作规则\n\n1. 开工先读总图。\n");
  write(HANDOFF_ABS, "# 夹具交接\n\n上一轮停止位置：夹具交接正文。\n");
  // 软链逃逸反例：项目根内的 junction 指向根外（Windows 上目录 junction 不需要特权；文件符号链接要特权，故用 junction）
  const linkPath = path.join(root, "link-out");
  let symlinkReady = false;
  try {
    fs.symlinkSync(outsideDir, linkPath, "junction");
    symlinkReady = true;
  } catch (e) {
    info(`  [环境] junction 创建失败（${e instanceof Error ? e.message : String(e)}）：软链反例将如实记未跑`);
  }

  const service = new serviceMod.WorkService({ dataDir });
  const submitter = { submit: (c: unknown) => service.submit(c) };
  const token = crypto.randomBytes(18).toString("base64url");
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    void serviceMod.handleWorkRequest(req, res, { service, token, pathname }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  serviceMod.writeServiceDescriptor(dataDir, {
    schema_version: typesMod.SCHEMA_VERSION,
    pid: process.pid,
    host: "127.0.0.1",
    port,
    token,
    started_at: new Date().toISOString(),
    url: `http://127.0.0.1:${port}`,
  });

  registryMod.addProject({ id: "entrypatch", name: "接续缺口修正夹具", path: root, kind: "backend" }, dataDir);
  const definitions = referencesMod.importPlanChecked(PLAN_TEXT, workDir).definitions;
  tasksMod.submitDefinitionImports(submitter, {
    project_id: "entrypatch",
    change_id: CHG,
    actor_id: "fixture",
    role: "coordinator",
    definitions,
  });
  documentsMod.activateBaseline(
    "entrypatch",
    { approved_by: "user", approval_basis: "接续缺口修正夹具审定", approval_kind: "user_confirmed" },
    dataDir,
  );

  const revOf = (taskId: string): number | null => tasksMod.readTaskStates(workDir).states[taskId]?.revision ?? null;
  // 夹具：`result_submitted` 是**历史/迁移状态**（造"已交付卡"的现场），不是一次新交付——走**既有状态边界**
  // `task.status_changed` + `payload.status`（`migrate.ts` 把 v1 `done` 折成 `result_submitted` 的同一形态）；
  // `task.result_submitted` 是交付提交事件，只由带合法认领 + 证据的提交写入（P2/V09-47 锁内共享判据），
  // 夹具不冒充交付提交（本项不测试新交付）。
  let fixtureStatusSeq = 0;
  const setStatus = (
    taskId: string,
    status: Parameters<typeof tasksMod.submitTaskStatus>[1]["status"],
    reason?: string,
  ): void => {
    const expectedRevision = revOf(taskId);
    if (status === "result_submitted") {
      fixtureStatusSeq += 1;
      submitter.submit({
        schema_version: typesMod.SCHEMA_VERSION,
        project_id: "entrypatch",
        change_id: CHG,
        entity_id: `task:${taskId}`,
        expected_revision: expectedRevision,
        type: "task.status_changed",
        actor_id: "fixture",
        role: "coordinator",
        idempotency_key: `fixture-hist-status:${taskId}:result_submitted:${expectedRevision}:${fixtureStatusSeq}`,
        payload: { status, ...(reason === undefined ? {} : { reason }) },
      });
      return;
    }
    tasksMod.submitTaskStatus(submitter, {
      project_id: "entrypatch",
      task_id: taskId,
      change_id: CHG,
      actor_id: "fixture",
      role: "coordinator",
      expected_revision: expectedRevision,
      status,
      ...(reason === undefined ? {} : { reason }),
    });
  };
  const entryOf = (role: string, extra: Record<string, unknown> = {}): EntryLike =>
    entryMod.evaluateProjectEntry({ project_id: "entrypatch", role, ...extra } as never, { dataDir }) as EntryLike;
  const claimsOf = (taskId: string): number =>
    claimsMod.readClaimEvents(workDir).filter((e) => e.entity_id === `task:${taskId}` && e.type === "task.claimed").length;

  // 取消 / 已交付 / 阻塞三类现场（B 段用；都在 A 段只读断言之前固定下来）
  setStatus("T-E", "cancelled", "夹具：验证取消卡的原规则");
  setStatus("T-F", "result_submitted", "夹具：验证已交付卡的原规则");
  for (const id of ["T-BK1", "T-BK2", "T-BK3"]) {
    setStatus(id, "blocked", "用户授权尚未覆盖该范围：需协调器按原启动条件解阻（T01b 同型前置）");
  }

  const missingReads = entryOf("executor", { client_capabilities: "continuable" });
  ok(
    missingReads.next_action === "claim_task" && reasonCodes(missingReads).includes("baseline_active"),
    "0-1 夹具：有效基线 + 就绪队列 → executor 拿到 claim_task",
    { action: missingReads.next_action, reasons: reasonCodes(missingReads) },
  );

  // ═══ A. 需求A：项目级阶段必读指针 ═══
  info("── A. 阶段必读指针（.工作台/work/stage-reads.json）");

  // A-1 无配置：老项目原样兼容（不阻断、不加 missing 理由、required_reads 不多条目）
  removeStageReads();
  const noCfg = entryOf("executor", { client_capabilities: "continuable" });
  ok(
    noCfg.next_action === "claim_task" &&
      !reasonCodes(noCfg).some((c) => c.startsWith("stage_reads")) &&
      !noCfg.required_reads.some((r) => r.path === TOTAL_REL),
    "A-1 无指针文件：完全兼容旧项目（照常派活、不加 missing 理由、不多必读条目）",
    { action: noCfg.next_action, paths: readPathsOf(noCfg) },
  );

  // A-2 合法指针：三条必读进 required_reads（kind 用既有枚举），默认排序不变
  writeStageReads(validStageReads(null));
  const withCfg = entryOf("executor", { client_capabilities: "continuable" });
  const cfgPaths = readPathsOf(withCfg);
  okNew(
    cfgPaths.includes(`evidence:${TOTAL_REL}`) &&
      cfgPaths.includes(`evidence:${AGENTS_REL}`) &&
      cfgPaths.includes(`checkpoint:${HANDOFF_REL}`) &&
      withCfg.required_reads.some((r) => r.path === TOTAL_REL && typeof r.revision === "string"),
    true,
    "A-2 合法指针：总图/AGENTS/当前交接进 required_reads（kind 用既有枚举、带 revision）",
    { paths: cfgPaths },
  );
  ok(
    withCfg.next_action === "claim_task" && withCfg.reasons.some((r) => r.task_id === "T-A"),
    "A-3 合法指针不影响判定：仍按「优先级→依赖层级→稳定 ID」选 T-A",
    { action: withCfg.next_action, reasons: reasonCodes(withCfg) },
  );

  // A-4 preferred_task_id 命中真实就绪候选 → 选中它并给理由
  writeStageReads(validStageReads("T-C"));
  const pref = entryOf("executor", { client_capabilities: "continuable" });
  okNew(
    pref.reasons.some((r) => r.task_id === "T-C") && reasonCodes(pref).includes("stage_preferred_selected"),
    true,
    "A-4 preferred_task_id=T-C（真实就绪）→ 在就绪集合内选中 T-C 并给理由（不新增授权）",
    { reasons: reasonCodes(pref), picked: pref.reasons.find((r) => r.task_id !== undefined)?.task_id },
  );

  // A-5 resume_hint（调用方显式）优先于指针优选
  const hinted = entryOf("executor", { client_capabilities: "continuable", resume_hint: "T-A" });
  ok(
    hinted.reasons.some((r) => r.task_id === "T-A") && reasonCodes(hinted).includes("resume_hint_received"),
    "A-5 resume_hint=T-A 优先于指针的 preferred=T-C：选中 T-A（调用方显式优先）",
    { reasons: reasonCodes(hinted) },
  );

  // A-6 preferred_task_id 指向依赖未释放的卡 → 不选它（回落默认排序）并给理由
  writeStageReads(validStageReads("T-B"));
  const prefBlocked = entryOf("executor", { client_capabilities: "continuable" });
  okNew(
    prefBlocked.reasons.some((r) => r.task_id === "T-A") && reasonCodes(prefBlocked).includes("stage_preferred_unusable"),
    true,
    "A-6 preferred_task_id=T-B（依赖 T-A 未释放）→ 不选它、不绕依赖，回落默认排序并给理由",
    { reasons: reasonCodes(prefBlocked) },
  );

  // A-7 角色：preferred 指到别人的卡 → 不选它；就绪集合按角色过滤
  writeStageReads(validStageReads("T-C"));
  const designer = entryOf("designer", { client_capabilities: "continuable" });
  okNew(
    designer.reasons.some((r) => r.task_id === "T-D") && reasonCodes(designer).includes("stage_preferred_unusable"),
    true,
    "A-7 role=designer + preferred=T-C（executor 的卡）→ 不派别人的卡，按角色选 T-D 并给理由",
    { reasons: reasonCodes(designer) },
  );

  // A-8 无匹配角色：如实 await_role（角色不符），但必读条目照给
  const auditor = entryOf("观察者", { client_capabilities: "continuable" });
  okNew(
    auditor.next_action === "await_role" &&
      reasonCodes(auditor).includes("role_mismatch") &&
      readPathsOf(auditor).includes(`evidence:${TOTAL_REL}`),
    true,
    "A-8 role=观察者（职责类未知、无匹配卡）→ await_role(role_mismatch) 且 stage 必读照给（读取不因角色被扣）",
    { action: auditor.next_action, reasons: reasonCodes(auditor) },
  );
  const readOnly = entryOf("executor", {});
  okNew(
    readOnly.next_action === "await_role" &&
      reasonCodes(readOnly).includes("client_read_only") &&
      readPathsOf(readOnly).includes(`checkpoint:${HANDOFF_REL}`),
    true,
    "A-9 未声明能力（按只读处理）→ await_role(client_read_only) 且 stage 必读照给",
    { action: readOnly.next_action, reasons: reasonCodes(readOnly) },
  );

  // A-10 来源漂移：改了总图内容 → 明确 blocked，不静默派活
  writeStageReads(validStageReads(null));
  write(TOTAL_ABS, "# 夹具项目总图\n\n## 3 当前阶段\n\n夹具总图正文（**已被改写**）。\n");
  const drifted = entryOf("executor", { client_capabilities: "continuable" });
  okNew(
    drifted.next_action === "blocked" && reasonCodes(drifted).includes("stage_reads_invalid"),
    true,
    "A-10 来源漂移（总图生成后被改写）→ blocked + stage_reads_invalid（不派活）",
    { action: drifted.next_action, reasons: reasonCodes(drifted), text: drifted.reasons[0]?.text?.slice(0, 200) },
  );
  write(TOTAL_ABS, "# 夹具项目总图\n\n## 3 当前阶段\n\n夹具总图正文（验证用）。\n");

  // A-11 来源不存在
  const missingSource = validStageReads(null);
  (missingSource.generated_from as { path: string; sha256: string }[]).push({
    path: "docs/不存在的总图.md",
    sha256: sha256("x"),
  });
  writeStageReads(missingSource);
  okNew(entryOf("executor", { client_capabilities: "continuable" }).next_action === "blocked", true,
    "A-11 来源文件不存在（generated_from 点名缺失）→ blocked", { reasons: reasonCodes(entryOf("executor", { client_capabilities: "continuable" })) });

  // A-12 entries 路径穿越
  const traversal = validStageReads(null);
  (traversal.entries as Record<string, unknown>[])[0]!.path = "../outside/total.md";
  writeStageReads(traversal);
  const travEntry = entryOf("executor", { client_capabilities: "continuable" });
  okNew(
    travEntry.next_action === "blocked" && (travEntry.reasons[0]?.text ?? "").includes("parent_traversal"),
    true,
    "A-12 entries 路径穿越（../）→ blocked（parent_traversal）",
    { text: travEntry.reasons[0]?.text?.slice(0, 240) },
  );

  // A-13 软链（junction）逃逸
  const escaped = validStageReads(null);
  (escaped.entries as Record<string, unknown>[])[0]!.path = "link-out/total.md";
  writeStageReads(escaped);
  const escEntry = entryOf("executor", { client_capabilities: "continuable" });
  okNew(
    symlinkReady ? escEntry.next_action === "blocked" && (escEntry.reasons[0]?.text ?? "").includes("symlink_escape") : false,
    symlinkReady,
    "A-13 entries 经软链/junction 逃出项目根 → blocked（symlink_escape）",
    { symlinkReady, text: escEntry.reasons[0]?.text?.slice(0, 240) },
  );

  // A-14 错误 kind（不发明新枚举）
  const badKind = validStageReads(null);
  (badKind.entries as Record<string, unknown>[])[0]!.kind = "overview";
  writeStageReads(badKind);
  const kindEntry = entryOf("executor", { client_capabilities: "continuable" });
  okNew(
    kindEntry.next_action === "blocked" && (kindEntry.reasons[0]?.text ?? "").includes("kind"),
    true,
    "A-14 entries 用了枚举外的 kind → blocked（不发明必需 enum）",
    { text: kindEntry.reasons[0]?.text?.slice(0, 240) },
  );

  // A-15 重复字段（同一对象里同一个键写两次）
  writeStageReads('{\n  "schema_version": 1,\n  "schema_version": 1,\n  "generated_from": [],\n  "entries": []\n}');
  const dupEntry = entryOf("executor", { client_capabilities: "continuable" });
  okNew(
    dupEntry.next_action === "blocked" && (dupEntry.reasons[0]?.text ?? "").includes("重复字段"),
    true,
    "A-15 指针里有重复字段（JSON 同键两次）→ blocked",
    { text: dupEntry.reasons[0]?.text?.slice(0, 240) },
  );

  // A-15b 转义写法的重复键（`"schema_version"` 与 `"\u0073chema_version"` 是同一个键）——
  // 只比原文会让它成为绕过口（对端探针 `root-stage-review-o7ur1t/` 指出，2026-09-30 收口）
  writeStageReads(
    '{"schema_version":99,"\\u0073chema_version":1,"generated_from":[],"entries":[]}',
  );
  const dupEscaped = entryOf("executor", { client_capabilities: "continuable" });
  okNew(
    dupEscaped.next_action === "blocked" && (dupEscaped.reasons[0]?.text ?? "").includes("重复字段"),
    true,
    "A-15b 重复键用 \\u 转义写法（解码后同名）→ 同样 blocked（不能靠转义绕过重复字段检查）",
    { action: dupEscaped.next_action, text: dupEscaped.reasons[0]?.text?.slice(0, 240) },
  );

  // A-16 schema_version 不匹配（2 现已是合法 v2，未知版本用 99）
  const badSchema = validStageReads(null);
  badSchema.schema_version = 99;
  writeStageReads(badSchema);
  okNew(entryOf("executor", { client_capabilities: "continuable" }).next_action === "blocked", true,
    "A-16 schema_version=99（不认识的版本）→ blocked");

  // A-17 文件过大
  const big = validStageReads(null);
  (big.entries as Record<string, unknown>[])[0]!.why = "x".repeat(300 * 1024);
  writeStageReads(big);
  const bigEntry = entryOf("executor", { client_capabilities: "continuable" });
  okNew(
    bigEntry.next_action === "blocked" && (bigEntry.reasons[0]?.text ?? "").includes("过大"),
    true,
    "A-17 指针文件超过体积上限 → blocked",
    { text: bigEntry.reasons[0]?.text?.slice(0, 200) },
  );

  // A-18 entries 重复 path
  const dupPath = validStageReads(null);
  (dupPath.entries as Record<string, unknown>[]).push({ ...(dupPath.entries as Record<string, unknown>[])[0]! });
  writeStageReads(dupPath);
  okNew(entryOf("executor", { client_capabilities: "continuable" }).next_action === "blocked", true,
    "A-18 entries 同一条 path 列了两次 → blocked（重复字段）");

  // A-19 MCP 面（真实 stdio 子进程）：required_reads 带 stage 条目
  writeStageReads(validStageReads(null));
  const mcp = spawnMcp();
  await mcp.handshake();
  const mcpEntry = (await mcp.callJson("project_entry", {
    project_id: "entrypatch",
    role: "executor",
    client_capabilities: "continuable",
  })) as EntryLike;
  okNew(
    readPathsOf(mcpEntry).includes(`evidence:${TOTAL_REL}`) && readPathsOf(mcpEntry).includes(`checkpoint:${HANDOFF_REL}`),
    true,
    "A-19 MCP project_entry（真实 stdio 子进程）→ required_reads 带总图与当前交接",
    { paths: readPathsOf(mcpEntry) },
  );
  const mcpBroken = validStageReads(null);
  mcpBroken.schema_version = 9;
  writeStageReads(mcpBroken);
  const mcpBlocked = (await mcp.callJson("project_entry", {
    project_id: "entrypatch",
    role: "executor",
    client_capabilities: "continuable",
  })) as EntryLike;
  okNew(
    mcpBlocked.next_action === "blocked" && reasonCodes(mcpBlocked).includes("stage_reads_invalid"),
    true,
    "A-20 MCP project_entry：坏指针 → next_action=blocked（MCP 面同样不派活）",
    { action: mcpBlocked.next_action, reasons: reasonCodes(mcpBlocked) },
  );

  // ═══ B. 需求B：阻塞卡不许新领 ═══
  info("── B. 阻塞卡不许新领（claimTask / 直连 work command / MCP claim_task）");
  removeStageReads();
  ok(
    tasksMod.readTaskStates(workDir).states["T-BK1"]?.status === "blocked" &&
      revOf("T-BK1") !== null &&
      claimsOf("T-BK1") === 0,
    "B-0 夹具：T-BK1/T-BK2/T-BK3 已置阻塞（blocked_reason 在场）、零认领事件",
    { states: ["T-BK1", "T-BK2", "T-BK3"].map((t) => tasksMod.readTaskStates(workDir).states[t]?.status) },
  );

  // B-1 claimTask 直调（MCP claim_task 的同一函数）
  const direct = (await claimsMod.claimTask(
    { project_id: "entrypatch", task_id: "T-BK1", role: "executor", owner_id: "direct-1", change_id: CHG },
    submitter,
    dataDir,
  )) as { ok?: boolean; code?: string; message?: string };
  okNew(
    direct.ok !== true && direct.code === "NOT_CLAIMABLE" && claimsOf("T-BK1") === 0,
    true,
    "B-1 claimTask(阻塞卡) → NOT_CLAIMABLE，零认领事件（拒绝无副作用）",
    { code: direct.code, claims: claimsOf("T-BK1") },
  );
  const rawMessage = direct.message ?? "";
  okNew(
    direct.ok !== true && rawMessage.includes("按**原启动条件**") && rawMessage.includes("blocked_reason"),
    true,
    "B-1b 拒绝话术引用 blocked_reason 与处置路径（按原启动条件经协调器解阻），不把一句话当凭据",
    { message: rawMessage.slice(0, 300) },
  );

  // B-2 直连唯一写入服务（POST /api/work/command）手写 task.claimed：不能旁路
  const eventsFile = path.join(workDir, "events.jsonl");
  const sizeBefore = fs.statSync(eventsFile).size;
  const rawCommand = {
    schema_version: typesMod.SCHEMA_VERSION,
    project_id: "entrypatch",
    change_id: CHG,
    entity_id: "task:T-BK2",
    expected_revision: revOf("T-BK2"),
    type: "task.claimed",
    actor_id: "raw-writer",
    role: "executor",
    idempotency_key: "raw-claim-bk2-1",
    payload: {
      claim_action: "claim",
      owner_id: "raw-writer",
      owner_role: "executor",
      run_id: "run-T-BK2-raw",
      attempt_id: "att-T-BK2-raw",
      attempt: 1,
      claim_token: "clm-raw-bk2",
      lease_expires_at: new Date(Date.now() + 900_000).toISOString(),
      workspace: ".工作台/runs/T-BK2/att-raw",
      takeover_basis: null,
    },
  };
  const raw = await postCommand(rawCommand);
  okNew(
    raw.status === 400 &&
      raw.body.includes("阻塞卡不许新领") &&
      fs.statSync(eventsFile).size === sizeBefore &&
      claimsOf("T-BK2") === 0,
    true,
    "B-2 直连 POST /api/work/command 手写 task.claimed → 拒绝、零字节、零认领事件（写口不能旁路）",
    { status: raw.status, body: raw.body.slice(0, 300), sizeBefore, sizeAfter: fs.statSync(eventsFile).size },
  );
  okNew(
    raw.status === 400 && raw.body.includes("blocked_not_claimable"),
    true,
    "B-2b 直连拒绝带结构化 detail.reason=blocked_not_claimable（机器可判）",
    { status: raw.status, body: raw.body.slice(0, 300) },
  );

  // B-3 MCP claim_task（真实 stdio 子进程 → 描述符 → 本进程写入服务）
  const mcpClaim = await mcp.callRaw("claim_task", {
    project_id: "entrypatch",
    task_id: "T-BK3",
    role: "executor",
    owner_id: "mcp-owner",
    change_id: CHG,
  });
  const mcpClaimBody = mcpClaim.text;
  okNew(
    mcpClaim.isError && mcpClaimBody.includes("NOT_CLAIMABLE") && claimsOf("T-BK3") === 0,
    true,
    "B-3 MCP claim_task(阻塞卡) → isError + NOT_CLAIMABLE，零认领事件",
    { isError: mcpClaim.isError, body: mcpClaimBody.slice(0, 300) },
  );

  // B-4 准备卡照常可领（原能力不退化）
  const normal = (await claimsMod.claimTask(
    { project_id: "entrypatch", task_id: "T-A", role: "executor", owner_id: "normal-1", change_id: CHG },
    submitter,
    dataDir,
  )) as { ok?: boolean; claim?: { claim_token?: string } };
  ok(normal.ok === true && claimsOf("T-A") === 1, "B-4 准备卡（T-A）照常认领成功、恰 1 条认领事件（原能力不退化）", {
    ok: normal.ok,
    claims: claimsOf("T-A"),
  });

  // B-5 续约语义保留（续的是已有认领，不是新领）
  const renewed = (await claimsMod.renewClaim(
    {
      project_id: "entrypatch",
      task_id: "T-A",
      role: "executor",
      owner_id: "normal-1",
      change_id: CHG,
      claim_token: normal.claim?.claim_token ?? "",
      expected_revision: revOf("T-A") ?? 0,
    },
    submitter,
    dataDir,
  )) as { ok?: boolean; code?: string };
  ok(renewed.ok === true, "B-5 续约（renewClaim）语义保留：持有者续自己那一次认领照常成功", { code: renewed.code });

  // B-6 取消 / 已交付的既有规则不变
  const cancelled = (await claimsMod.claimTask(
    { project_id: "entrypatch", task_id: "T-E", role: "executor", owner_id: "norm-2", change_id: CHG },
    submitter,
    dataDir,
  )) as { ok?: boolean; code?: string; message?: string };
  const submitted = (await claimsMod.claimTask(
    { project_id: "entrypatch", task_id: "T-F", role: "executor", owner_id: "norm-3", change_id: CHG },
    submitter,
    dataDir,
  )) as { ok?: boolean; code?: string; message?: string };
  ok(
    cancelled.ok !== true && (cancelled.message ?? "").includes("已取消") &&
      submitted.ok !== true && submitted.code === "NOT_CLAIMABLE" && (submitted.message ?? "").includes("结果已提交"),
    "B-6 取消卡 / 结果已交付卡的原规则不变（逐条明确拒绝）",
    { cancelled: cancelled.code, submitted: submitted.code },
  );

  // B-7 版本与并发：过期 expected_revision → VERSION_CONFLICT；同一现场两次并发 → 恰好一个成功
  const stale = (await claimsMod.claimTask(
    { project_id: "entrypatch", task_id: "T-G", role: "executor", owner_id: "v-1", change_id: CHG, expected_revision: 999 },
    submitter,
    dataDir,
  )) as { ok?: boolean; code?: string };
  ok(stale.ok !== true && stale.code === "VERSION_CONFLICT", "B-7 版本检查不退化：过期 expected_revision → VERSION_CONFLICT", {
    code: stale.code,
  });
  const raceRevs = revOf("T-G") ?? 0;
  const race = await Promise.all([
    claimsMod.claimTask({ project_id: "entrypatch", task_id: "T-G", role: "executor", owner_id: "race-a", change_id: CHG, expected_revision: raceRevs }, submitter, dataDir),
    claimsMod.claimTask({ project_id: "entrypatch", task_id: "T-G", role: "executor", owner_id: "race-b", change_id: CHG, expected_revision: raceRevs }, submitter, dataDir),
  ]);
  const winners = race.filter((r) => (r as { ok?: boolean }).ok === true).length;
  const losers = race.filter((r) => (r as { ok?: boolean }).ok !== true).map((r) => (r as { code?: string }).code);
  ok(
    winners === 1 && losers.every((c) => c === "CLAIM_HELD" || c === "VERSION_CONFLICT"),
    "B-7b 并发：同一现场两次认领恰好一个成功，败者明确拒绝（CLAIM_HELD/VERSION_CONFLICT）",
    { winners, losers },
  );

  // B-8 解阻后可领（门禁跟着事件账本状态走，不是永久封杀）
  setStatus("T-BK1", "ready", "协调器按原启动条件解阻：授权/前置已满足");
  const afterUnblock = (await claimsMod.claimTask(
    { project_id: "entrypatch", task_id: "T-BK1", role: "executor", owner_id: "after-unblock", change_id: CHG },
    submitter,
    dataDir,
  )) as { ok?: boolean; code?: string };
  okNew(afterUnblock.ok === true, true, "B-8 解阻（task.status_changed→ready）后照常可领：门禁随账本状态变化", {
    ok: afterUnblock.ok,
    code: afterUnblock.code,
  });

  // ═══ 收尾 ═══
  mcp.kill();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    serviceMod.removeServiceDescriptor(dataDir);
  } catch {
    // 夹具目录随后整棵删，描述符删不掉不影响结论
  }
  if (process.env.TATAI_KEEP_TMP !== "1") fs.rmSync(tmpBase, { recursive: true, force: true });

  info(`── 汇总：PASS ${passCount} / FAIL ${failCount}（expect=${expectOld ? "old" : "new"}）`);
  if (expectOld && failCount === 0) {
    info("  改前口径：上述反例**全部挡不住**（漏洞现场已留档），与改后的同一脚本运行对比即知修正是否真的生效");
  }

  // ── 内部小工具 ──

  function postCommand(body: unknown): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        { host: "127.0.0.1", port, path: "/api/work/command", method: "POST", headers: { "content-type": "application/json", [serviceMod.WORK_TOKEN_HEADER]: token, "content-length": Buffer.byteLength(payload) } },
        (res) => {
          let text = "";
          res.on("data", (c: Buffer) => {
            text += c.toString("utf8");
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  }

  interface McpHandle {
    handshake: () => Promise<void>;
    callRaw: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
    callJson: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    kill: () => void;
  }

  function spawnMcp(): McpHandle {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("TATAI_")) delete env[k];
    env.TATAI_HOME = dataDir;
    const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], { cwd: ROOT, env });
    let stderrBuf = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderrBuf += d.toString("utf8");
    });
    let buf = "";
    const pending = new Map<number, (msg: RpcMsg) => void>();
    let idc = 0;
    const send = (method: string, params: unknown): Promise<RpcMsg> =>
      new Promise((resolve, reject) => {
        const id = ++idc;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP 请求超时：${method}${stderrBuf === "" ? "" : `（stderr: ${stderrBuf.slice(-200)}）`}`));
        }, 120_000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    const notify = (method: string, params: unknown): void => {
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    };
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === "") continue;
        let msg: RpcMsg;
        try {
          msg = JSON.parse(line) as RpcMsg;
        } catch {
          continue;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      }
    });
    const callRaw = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
      const r = await send("tools/call", { name, arguments: args });
      if (r.error !== undefined) return { text: JSON.stringify(r.error), isError: true };
      return { text: r.result?.content?.[0]?.text ?? "", isError: r.result?.isError === true };
    };
    return {
      handshake: async (): Promise<void> => {
        const init = await send("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "verify-stage-entry", version: "1.0" },
        });
        notify("notifications/initialized", {});
        ok(
          init.error === undefined && typeof init.result?.serverInfo?.name === "string",
          "0-2 MCP stdio 子进程握手成功（真实 MCP 面，不是模拟调用）",
          { serverInfo: init.result?.serverInfo?.name, stderr: stderrBuf.slice(-200) },
        );
      },
      callRaw,
      callJson: async (name: string, args: Record<string, unknown>): Promise<unknown> => {
        const r = await callRaw(name, args);
        if (r.isError) throw new Error(`${name} isError：${r.text.slice(0, 300)}`);
        return JSON.parse(r.text) as unknown;
      },
      kill: (): void => {
        try {
          if (child.exitCode === null) child.kill();
        } catch {
          // 已经退出
        }
      },
    };
  }
}

main().catch((e: unknown) => {
  console.error(`[verify] FAIL 脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
