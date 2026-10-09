// V06-11 验证脚本（PLAN.md V06-11；DESIGN.md §5.4 / §6.5–§6.7 为主契约，另见 §1.5）。
// 用法：pnpm verify:v06-11（或 node --import tsx scripts/verify-v06-11.ts）
//
// 自带隔离环境：临时 `TATAI_HOME` + `os.tmpdir()` 下的夹具项目，**不碰**任何真实项目的 `.工作台/`；
// 塔台根文档（DESIGN.md / PLAN.md / PROGRESS.md / AGENTS.md / README.md / 两份设计史）只读，
// 首尾逐文件 sha256 对照证明零改动，`DESIGN.md` 附录 B 段另给单独哈希；收尾清理临时目录
// （`TATAI_KEEP_TMP=1` 保留现场）。
//
// **确定性、不依赖真 worker**（卡面第三条检查项）：全程用**假执行器**（把假现场喂给真回执函数）
// 与**注入探针**（进程 / 工作树 / 外部效果三个观察点）跑，不联模型、不 spawn 子进程。
// 真模型 + 真 worker 的隔离演练与打断恢复记录在 `.工作台/evidence/V06-11/1/drills/`（不在这个脚本里）。
//
// 覆盖点（卡面三条检查项逐条落到断言名）：
//   ① 受控配置与启动判定：内置实测档案与 `docs/agent-integration.md` 对账；项目受控配置优先、
//      坏配置不放行；字符串命令拒收；argv 模板渲染与稳定指纹；workspace 隔离口径（项目根 / 祖先 /
//      项目内非运行区一律拒）；**未配置 / 缺二进制 / 缺凭据 → 不可启动**，一个字节都不写、不替用户换服务。
//   ② 回执协议与失败码：五类事件（启动 / 心跳 / 检查点 / 停止 / 交付）+ 效果声明（前 / 后 / 待核实）跑全；
//      实际客户端 / model / effort / workspace 与父执行落事件；启动失败必须带现场且**不能先标运行中**；
//      停止没有确认依据一律拒收；回执只接当前认领；幂等与版本冲突；调用层失败码逐个点名。
//   ③ 判活与恢复：**无心跳不当已停止**；**停止未确认不再派同一可写目录**；恢复顺序与 §5.4 逐字对齐、
//      **先查询外部效果**；结果不明（进程查不清 / 效果待核实）→ 不盲重放；同一份事件换一个探针结论
//      就变（读的是现场不是猜）；旧进程 / 未提交改动 / 任务版本 / 旧认领逐条进结论。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import { activateBaseline } from "../src/server/work/documents";
import { importTaskDefinitions, type TaskDefinition } from "../src/server/work/plan";
import { claimTask, type ClaimSubmitter, type TaskClaim } from "../src/server/work/claims";
import { submitDefinitionImports } from "../src/server/work/tasks";
import { WorkService } from "../src/server/work/service";
import { registeredEventTypes, WORK_ERROR_CODES } from "../src/server/work/types";
import {
  AGENT_CONFIG_FILE,
  ARGV_PLACEHOLDERS,
  BUILTIN_CLIENT_PROFILES,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_STALE_MS,
  EFFECT_UNVERIFIED_NOTE,
  EXECUTION_EVENT_TYPES,
  EXECUTION_FAILURE_CODES,
  NO_HEARTBEAT_NOTE,
  NO_SUBSTITUTE_NOTE,
  RECOVERY_STEPS,
  RUN_SITE_STATES,
  argvDigest,
  assertIsolatedWorkspace,
  buildLaunchPlan,
  checkCredential,
  confirmEffect,
  declareEffect,
  dispatchGuard,
  executionEntityId,
  findExecutable,
  jsonPathPresent,
  livenessOf,
  loadClientProfiles,
  markEffectUnverified,
  parseClientProfile,
  planRecovery,
  profileOf,
  readExecution,
  recordCheckpoint,
  recordDelivered,
  recordFailed,
  recordHeartbeat,
  recordStartRequested,
  recordStarted,
  recordStopRequested,
  recordStopped,
  renderArgv,
  resolveStartable,
  tomlSectionKeyPresent,
  type ExecutionProbe,
  type ExecutionRecord,
  type ExecutionTarget,
} from "../src/server/work/executionReceipts";

// ── 断言与日志 ──

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 2000)}`);
  }
};
const info = (msg: string) => console.log(`[verify] ${msg}`);
const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const sha256File = (f: string): string => sha256(fs.readFileSync(f));

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 本卡只读的塔台根文档（首尾 sha256 对照；红线：不许改） */
const DOC_FILES = [
  "DESIGN.md",
  "PLAN.md",
  "PROGRESS.md",
  "AGENTS.md",
  "README.md",
  "docs/design-history-v0.4.md",
  "docs/design-history-v0.5.md",
];
const APPENDIX_B_HEADING = "## 附录 B：待议记录";
const appendixBOf = (text: string): string => {
  const idx = text.indexOf(APPENDIX_B_HEADING);
  return idx < 0 ? "<附录 B 段未找到>" : text.slice(idx);
};
/**
 * `docs/work-v2-contract.md` 的基线前缀（= 当前全文；此后只许尾部追加）。
 * 2026-09-20 审计重定基线：补修 F3 插段与 §14-§19 追加后，旧 26201 前缀口径作废；
 * 基准改为当前全文（70992 字节），此后仍只许尾部追加（前 N 字节哈希不变）。
 * 定向更新（2026-09-25 复核批次）：前缀哈希 79bd5766… → b4d38d17…。判据未放宽——
 *   仍是「前 70992 字节逐字节钉死、尾部只许追加」；旧钉值 79bd5766…｜依据：V09-01 批次
 *   对第 176 行 `audit.self_check_recorded` 行做了契约细化（补 `verifies`/采信分档说明，
 *   git diff 实测仅此一处一行改动），当时漏同步本钉值｜新钉值 b4d38d17…（＝当前前缀实测）｜
 *   保留意图：此后前缀再有任何字节改动仍必须红。
 * 定向重定基线（2026-09-30 接续缺口有界修正）：正文 §8.1 追加「写边界的认领门禁（阻塞卡不许新领）」、
 *   §12.1 追加 `required_reads` 的项目级阶段必读指针、§12.2 追加对应一条 —— 三处都在 70992 之前插段，
 *   按本卡既定程序**重钉前缀为当时全文**（旧钉值 b4d38d17… → 新钉值 36d8e74b…，字节 70992 → 82558）。
 *   判据未放宽：前缀仍逐字节钉死、尾部仍只许追加；本批改动出处见 `PLAN.md` 同日「附记（非卡）」与
 *   `D:/demo-project/.工作台/tatai-alignment/20260930-entry-patch/`。
 * 定向重定基线（2026-10-07 证据补登批次）：c49d277（V09-42，2026-10-04）把 `required_reads` 项目级扩展
 *   一条扩写为 stage-reads v2 章节绑定语义（同一条目一行替换、git diff 实测仅此一处），当时漏同步本钉值，
 *   导致 ⑤-1 红（现场前缀 359a825b… ≠ 旧钉 36d8e74b…）。改动出处可追（git log docs/work-v2-contract.md），
 *   按本卡既定程序**重钉前缀为当前全文**（字节 82558 → 85103，Windows CRLF 工作树口径，与历次钉值同一口径；
 *   旧钉值 36d8e74b…｜新钉值 c35df8b7…＝当前全文实测）。判据未放宽：前缀仍逐字节钉死、尾部仍只许追加。
 */
const CONTRACT_PREFIX_BYTES_OLD = 85103;
const CONTRACT_PREFIX_SHA256_OLD = "c35df8b78e265324af37c91e87d6d98d5556c7902d251058ead392852e68d845";
/**
 * 重定基线（2026-10-08，V09-61 测试维护；本轮治理修复授权）：
 *   正文增量 = §9.4 下方**唯一一处**「2026-10-08 审计追加纠正」整段（段落 + 空行两行），
 *   与 `docs/audit-recovery.md` 对应。`git diff docs/work-v2-contract.md` 实测**仅 2 行插入、0 行删除**
 *   （插入点在第 199 行、`### 9.4` 小节内；非新开场次而是对既有只读入口一节补审计纠正口径）。
 *   行尾口径（如实解释；**不做无条件 normalize 后弱比较**）：当前工作树是**混合行尾**——该新增段所在
 *   §9.4 区域被编辑工具写成 LF（3 处孤 LF），其余为 CRLF；历次钉值按「Windows 工作树整篇」口径。
 *   为免行尾抖动造成假红/假绿，新钉值对正文做**显式行尾归一化（CRLF→LF）后取精确 sha256 + 字节数**，
 *   比对是**逐字节精确相等**；同时保留旧 CRLF 钉值做 before 对照：
 *   移除该已审新增段后，正文（CRLF 化）**精确复现**旧钉值 85103 字节 / c35df8b7…（见下方断言）。
 *   保留意图：此后前缀再有任何字节改动仍必须红；尾部仍只许追加（长度 ≥ 前缀即视为尾部新增）。
 *   负例（下方断言）：改原前缀正文 / 改已审新增段 / 整段跳过 都必须报错，不允许跳过审核段。
 */
const CONTRACT_LF_BYTES = 85069;
const CONTRACT_LF_SHA256 = "4a4438413ce748e88840fafe69f1d3f7674e99654ed994bb49d70e50dd3afcc2";
/** 已审新增段（2026-10-08 审计纠正）段落原文（不含行尾）；其 sha256 亦钉死，防「整段跳过」。 */
const CONTRACT_AUDIT_SEGMENT_20261008 =
  "审计追加纠正（2026-10-08）：`audit.record_corrected` 使用 `audit-correction:` 实体，唯一写入者在锁内验证。仅允许 `bind_finding_refs` 和 `reclassify_not_checked`，不能产生 passed 或删除历史。必须绑定原始事件单行哈希与规范化事件哈希、目标/检查/原绑定，以及逐字段批准本请求的结构化独审裁定包和逐目标授权包；旧复合 finding 归属只接受原事件精确身份裁定。返工用同实体 CAS 与显式 supersedes。读面保留原记录与 correction_refs；待人验仍占必需项，普通 Agent pass 不能解除，user Gate 还须同任务、后续且基线有效的人工接受。完整协议、哈希区别、信任边界和真人操作见 [审计纠正契约](audit-recovery.md)。新写 finding/audit 在唯一写入服务锁内校验，非法值零追加；旧合法历史不批量改写。";
const CONTRACT_AUDIT_SEGMENT_20261008_SHA256 = "243f14fd29fdf4e662c931e02d4e1139a3697725937a8ed0f8478e79e234e583";
/** 移除已审段后的正文（LF 口径）应精确等于旧全文：84174 字节 / fabe122d…（before 对照的另一半）。 */
const CONTRACT_WITHOUT_AUDIT_LF_BYTES = 84174;
const CONTRACT_WITHOUT_AUDIT_LF_SHA256 = "fabe122d37218ae1028f34138e155f1716af6f5c12cb547780889473fb2bd19d";

/** 精确前缀判据（正例/负例共用；不做任何弱比较） */
const contractPrefixPinned = (lf: string): boolean => {
  const b = Buffer.from(lf, "utf8");
  return b.length >= CONTRACT_LF_BYTES && sha256(b.subarray(0, CONTRACT_LF_BYTES)) === CONTRACT_LF_SHA256;
};
/** 已审新增段精确在场判据：整段原文 + 其后空行都在，且整段 sha 相符 */
const contractAuditSegmentPinned = (lf: string): boolean =>
  lf.includes(`${CONTRACT_AUDIT_SEGMENT_20261008}\n\n`) &&
  sha256(CONTRACT_AUDIT_SEGMENT_20261008) === CONTRACT_AUDIT_SEGMENT_20261008_SHA256;
/** 移除已审新增段（段落 + 其后空行）；找不到就原样返回 */
const stripAuditSegment20261008 = (lf: string): string => {
  const i = lf.indexOf(CONTRACT_AUDIT_SEGMENT_20261008);
  if (i < 0) return lf;
  const after = lf.slice(i + CONTRACT_AUDIT_SEGMENT_20261008.length);
  if (!after.startsWith("\n\n")) return lf;
  return lf.slice(0, i) + after.slice(2);
};
/** 旧已钉前缀复现判据：移除已审段后的正文 CRLF 化后应精确等于旧钉值 */
const reproducesOldPrefix = (lf: string): boolean => {
  const b = Buffer.from(stripAuditSegment20261008(lf).replace(/\n/g, "\r\n"), "utf8");
  return b.length === CONTRACT_PREFIX_BYTES_OLD && sha256(b) === CONTRACT_PREFIX_SHA256_OLD;
};
/** §6.5「不替用户选择新服务」的口径句头（断言里引用，避免把长句抄两遍） */
const NO_SUBSTITUTE_HEAD = "不替用户选择新服务";

const docBefore = new Map<string, string>();
const appendixBefore = new Map<string, string>();
for (const rel of DOC_FILES) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) {
    docBefore.set(rel, "<missing>");
    appendixBefore.set(rel, "<missing>");
    continue;
  }
  const text = fs.readFileSync(abs, "utf8");
  docBefore.set(rel, sha256(text));
  if (rel === "DESIGN.md") appendixBefore.set(rel, sha256(appendixBOf(text)));
}

// ── 隔离环境 ──

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0611-verify-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;
const service = new WorkService({ dataDir });
const submitter: ClaimSubmitter = { submit: (c) => service.submit(c) };
const CHG = "chg-v0611";
const EXECUTOR = "kimi-code";
const COORDINATOR = "claude-code";

const mkdirp = (d: string) => fs.mkdirSync(d, { recursive: true });
const write = (f: string, text: string) => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
const read = (f: string) => fs.readFileSync(f, "utf8");
const eventsHash = (workDir: string): string => {
  const f = path.join(workDir, "events.jsonl");
  return fs.existsSync(f) ? sha256File(f) : "<none>";
};
const allEvents = (workDir: string): Record<string, unknown>[] => {
  const f = path.join(workDir, "events.jsonl");
  if (!fs.existsSync(f)) return [];
  return read(f)
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};
const isoAt = (base: string, deltaMs: number): string => new Date(Date.parse(base) + deltaMs).toISOString();
/**
 * 夹具喂给产品的"调用方时间串"：UTC `Z` 形态，与产品自写的本地 `+08:00` 串**混用**——
 * 本卡"信号串可能跨时区"这一层意图照旧保留。
 * 但一律**相对当下推导**，不写死绝对串：写死的串会让"近期信号 / 心跳超期"这类判活断言
 * 随本地钟点翻红（本地 18:00:20 之后、以及隔天，绝对串与真实钟的相对关系就反了）。
 */
const signalNow = (deltaMs = 0): string => new Date(Date.now() + deltaMs).toISOString();

// ── 夹具项目 ──

interface Card {
  id: string;
  goal: string;
  dep?: string;
}

/** 造一份合法施工图（表 + 卡正文；字段标签走 TASK_FIELD_ALIASES 的口径） */
function planText(title: string, cards: Card[]): string {
  const lines = [`# ${title}`, "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"];
  for (const c of cards) lines.push(`| ${c.id} | todo | ${c.goal} | ${c.dep ?? ""} | ${c.id} 的完成证据 |`);
  lines.push("");
  for (const c of cards) {
    lines.push(`### ${c.id} ${c.goal}`, "");
    lines.push(`**设计依据**：§5.4。**依赖**：${c.dep ?? "无"}。**文件责任**：\`src/${c.id.toLowerCase()}.ts\`。`, "");
    lines.push(`- [ ] ${c.goal} 达标`, "");
  }
  return lines.join("\n");
}

interface Fixture {
  id: string;
  root: string;
  workDir: string;
  defs: TaskDefinition[];
}

function makeFixture(id: string, cards: Card[]): Fixture {
  const root = path.join(tmpBase, id);
  mkdirp(path.join(root, ".工作台"));
  write(path.join(root, ".工作台", "design.md"), `# ${id} 设计书\n\n夹具设计正文（V06-11 验证用）。\n`);
  const plan = planText(`${id} 施工图`, cards);
  write(path.join(root, ".工作台", "plan.md"), plan);
  addProject({ id, name: `V06-11 夹具 ${id}`, path: root, kind: "backend" }, dataDir);
  const imported = importTaskDefinitions(plan, { plan_revision: sha256(plan) });
  activateBaseline(id, { approved_by: "user", approval_basis: "V06-11 夹具审定", approval_kind: "user_confirmed" }, dataDir);
  submitDefinitionImports(service, {
    project_id: id,
    change_id: CHG,
    actor_id: EXECUTOR,
    role: "executor",
    definitions: imported.definitions,
  });
  return { id, root, workDir: projectWorkDir(id, dataDir), defs: imported.definitions };
}

const mainFx = makeFixture("V0611-A", [{ id: "T-1", goal: "隔离小项目里补一个函数并让测试转绿" }]);
const cfgFx = makeFixture("V0611-B", [{ id: "T-1", goal: "受控配置夹具" }]);
const badFx = makeFixture("V0611-C", [{ id: "T-1", goal: "坏配置夹具" }]);
const fx2 = makeFixture("V0611-D", [
  { id: "T-2", goal: "判活与派发闸门夹具" },
  { id: "T-3", goal: "检查点在飞动作夹具" },
]);

// ── 假的客户端环境（不 spawn；只给 `findExecutable` 与凭据检查一个确定的现场） ──

const fakeBinDir = path.join(tmpBase, "fakebin");
mkdirp(fakeBinDir);
write(path.join(fakeBinDir, "kimi.exe"), "@echo off\r\necho 0.41.0\r\n");
write(path.join(fakeBinDir, "claude.exe"), "@echo off\r\necho 2.1.274 (Claude Code)\r\n");
const emptyBinDir = path.join(tmpBase, "nobin");
mkdirp(emptyBinDir);

/** 隔离的 Kimi Code 配置副本（**不带 hooks**；全局配置一律只读，这里只是造一个确定的现场） */
const fakeKimiHome = path.join(tmpBase, "kimi-home");
write(
  path.join(fakeKimiHome, "config.toml"),
  [
    'default_model = "deepseek-v41-flash"',
    "",
    "[providers.deepseek]",
    'base_url = "https://api.deepseek.com"',
    'api_key = "fixture-not-a-real-key"',
    "",
  ].join("\n"),
);
const noKeyKimiHome = path.join(tmpBase, "kimi-home-nokey");
write(
  path.join(noKeyKimiHome, "config.toml"),
  ['default_model = "deepseek-v41-flash"', "", "[providers.deepseek]", 'api_key = ""', ""].join("\n"),
);

const baseEnv: NodeJS.ProcessEnv = {
  PATH: fakeBinDir,
  PATHEXT: ".EXE;.CMD",
  KIMI_CODE_HOME: fakeKimiHome,
  HOME: path.join(tmpBase, "home-dir"),
  USERPROFILE: path.join(tmpBase, "home-dir"),
};
// Claude Code 的凭据项（`~/.claude/settings.json` 的本地网关令牌；只报在不在，不写真实值）
write(
  path.join(baseEnv.HOME as string, ".claude", "settings.json"),
  JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3456", ANTHROPIC_AUTH_TOKEN: "fixture-local-router" } }, null, 2),
);
const envOf = (patch: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...baseEnv, ...patch });

/** 演练用的隔离工作目录（tmpdir 里，不在任何项目根内） */
const wsRoot = path.join(tmpBase, "ws");
const ws1 = path.join(wsRoot, "T-1", "att-1");
const ws2 = path.join(wsRoot, "T-2", "att-1");
const ws3 = path.join(wsRoot, "T-3", "att-1");
for (const w of [ws1, ws2, ws3]) mkdirp(w);

interface Running {
  claim: TaskClaim;
  target: ExecutionTarget;
}

/** 假执行器：领取任务 → 启动请求 → 启动确认（把假现场喂给真回执函数） */
async function startFakeExecution(
  fx: Fixture,
  taskId: string,
  executionId: string,
  workspace: string,
  parent?: { execution_id: string; run_id: string },
): Promise<Running> {
  const claimed = await claimTask(
    { project_id: fx.id, task_id: taskId, role: "coordinator", owner_id: COORDINATOR, change_id: CHG, workspace },
    submitter,
    dataDir,
  );
  if (!claimed.ok) throw new Error(`夹具缺陷：领取 ${fx.id}/${taskId} 失败：${claimed.code} ${claimed.message}`);
  const claim = claimed.claim;
  const target: ExecutionTarget = {
    project_id: fx.id,
    execution_id: executionId,
    task_id: taskId,
    run_id: claim.run_id,
    attempt_id: claim.attempt_id,
    attempt: claim.attempt,
    ...(parent === undefined ? {} : { parent_execution_id: parent.execution_id, parent_run_id: parent.run_id }),
    coordinator_id: COORDINATOR,
    claim_token: claim.claim_token,
    owner_id: COORDINATOR,
    owner_role: "coordinator",
    change_id: CHG,
    workspace,
    client_id: EXECUTOR,
    model: "deepseek-v41-flash",
  };
  const req = await recordStartRequested(
    { ...target, goal: `${taskId} 隔离执行`, argv_digest: "sha256:fixture-argv", template_source: "内置实测档案", timeout_ms: DEFAULT_EXECUTION_TIMEOUT_MS },
    submitter,
    dataDir,
  );
  if (!req.ok) throw new Error(`夹具缺陷：启动请求失败：${req.code} ${req.message}`);
  const started = await recordStarted({ ...target, client_version: "0.41.0", pid: 4242, argv_digest: "sha256:fixture-argv" }, submitter, dataDir);
  if (!started.ok) throw new Error(`夹具缺陷：启动确认失败：${started.code} ${started.message}`);
  return { claim, target };
}

const run = async () => {
  // ═══════════════════ ① 受控配置、启动判定与启动计划（§6.5） ═══════════════════

  info("── ①-1 内置实测档案与适配档案对账");
  const doc = read(path.join(REPO, "docs", "agent-integration.md"));
  const kimi = profileOf("kimi-code", BUILTIN_CLIENT_PROFILES);
  const claude = profileOf("claude-code", BUILTIN_CLIENT_PROFILES);
  ok(
    kimi !== null &&
      claude !== null &&
      EXECUTION_EVENT_TYPES.length === 11 &&
      RUN_SITE_STATES.length === 7 &&
      RECOVERY_STEPS.length === 8,
    "①-1 内置档案两条（kimi-code / claude-code）+ 词表规模（事件 11 / 现场状态 7 / 恢复步骤 8）",
    { kimi: kimi?.client_id, claude: claude?.client_id },
  );
  ok(
    kimi !== null &&
      kimi.verified_version === "0.41.0" &&
      kimi.launch_template.join(" ") === "-p <prompt> --model <model> --output-format text" &&
      !kimi.launch_template.includes("--auto") &&
      kimi.non_interactive === true &&
      kimi.default_model === "deepseek-v41-flash" &&
      doc.includes("0.41.0") &&
      doc.includes("--model deepseek-v41-flash"),
    "①-1 Kimi Code = 0.41.0 + 非交互模板 `-p/--model deepseek-v41-flash`（档案与 docs/agent-integration.md 同口径）",
    kimi,
  );
  ok(
    claude !== null &&
      claude.verified_version === "2.1.274" &&
      claude.launch_template.join(" ") === "-p <prompt> --bare" &&
      claude.effort_flag === "--effort" &&
      claude.effort_values.join(",") === "low,medium,high,xhigh,max" &&
      doc.includes("2.1.274") &&
      doc.includes("--effort"),
    "①-1 Claude Code = 2.1.274 + `-p/--bare` + `--effort` 五档（档案与适配档案同口径）",
    claude,
  );
  ok(
    doc.includes("KIMI_CODE_HOME") && doc.includes("~/.kimi-code") && doc.includes("不是同一个"),
    "①-1 适配档案写明配置标识：生效的是 `KIMI_CODE_HOME` 下的 config.toml，两处目录内容不同",
  );
  ok(
    doc.includes("不可启动") && doc.includes(NO_SUBSTITUTE_HEAD) && !/api_key\s*=\s*"sk-/.test(doc),
    "①-1 适配档案有「不可启动」路径，且**没有**把任何密钥原文写进文档",
  );
  ok(
    EXECUTION_EVENT_TYPES.every((t) => t.startsWith("execution.")) &&
      new Set(EXECUTION_EVENT_TYPES).size === EXECUTION_EVENT_TYPES.length &&
      [
        "execution.start_requested",
        "execution.started",
        "execution.heartbeat",
        "execution.checkpoint",
        "execution.stop_requested",
        "execution.stopped",
        "execution.delivered",
      ].every((t) => (EXECUTION_EVENT_TYPES as readonly string[]).includes(t)),
    "①-1 事件词表：五类必备事件（启动/心跳/检查点/停止/交付）逐个点名在场且无重复",
  );
  ok(
    RUN_SITE_STATES.join(",") === "start_requested,running,awaiting_input,stop_requested,stopped,unreachable,ended",
    "①-1 运行现场七态与 §5.4 逐字对齐（启动请求中/运行中/等待输入/停止请求中/已停止/失联/已结束）",
    RUN_SITE_STATES,
  );
  ok(
    RECOVERY_STEPS.join(",") ===
      "read_last_checkpoint,query_effect,old_run_write_possible,worktree_baseline,result_evidence_validity,stale_claim,new_attempt,continue",
    "①-1 恢复顺序含 §5.4 七步且**先查外部效果**（query_effect 紧跟读检查点）",
    RECOVERY_STEPS,
  );

  info("── ①-2 项目受控配置优先 / 坏配置不放行");
  const builtin = loadClientProfiles(mainFx.id, dataDir);
  ok(
    builtin.source === "builtin" && builtin.config_path === null && builtin.problems.length === 0,
    "①-2 没有 `<项目>/.工作台/agents.json` 时用内置实测档案（source=builtin）",
    builtin,
  );
  write(
    path.join(cfgFx.workDir, AGENT_CONFIG_FILE),
    JSON.stringify(
      {
        clients: [
          {
            client_id: "fake-exec",
            label: "夹具假执行器",
            launch_template: ["run", "--prompt", "<prompt>", "--dir", "<workspace>"],
            verified_version: "fixture-1.0",
            default_model: "fixture-model",
            credentials: [],
            workspace_convention: "cwd = 隔离工作目录",
            source: "夹具受控配置",
          },
        ],
      },
      null,
      2,
    ),
  );
  const cfgLoad = loadClientProfiles(cfgFx.id, dataDir);
  const cfgVerdict = resolveStartable({ project_id: cfgFx.id, client_id: "kimi-code", dataDir, env: envOf() });
  ok(
    cfgLoad.source === "project_config" &&
      cfgLoad.profiles.length === 1 &&
      cfgLoad.profiles[0].client_id === "fake-exec" &&
      profileOf("kimi-code", cfgLoad.profiles) === null,
    "①-2 项目受控配置生效且**不退回**内置档案（内置 kimi-code 不再自动可用）",
    { source: cfgLoad.source, ids: cfgLoad.profiles.map((p) => p.client_id) },
  );
  ok(
    cfgVerdict.startable === false &&
      cfgVerdict.code === "CLIENT_NOT_CONFIGURED" &&
      cfgVerdict.message.includes(NO_SUBSTITUTE_HEAD),
    "①-2 受控配置里没有的客户端 → CLIENT_NOT_CONFIGURED（不拿内置顶上）",
    cfgVerdict,
  );

  write(path.join(badFx.workDir, AGENT_CONFIG_FILE), JSON.stringify({ clients: [{ client_id: "broken", launch_template: "run --prompt <prompt>" }] }, null, 2));
  const badLoad = loadClientProfiles(badFx.id, dataDir);
  const badVerdict = resolveStartable({ project_id: badFx.id, client_id: "broken", dataDir, env: envOf() });
  ok(
    badLoad.profiles.length === 0 &&
      badLoad.problems.length > 0 &&
      badLoad.problems[0].includes("launch_template") &&
      badVerdict.startable === false &&
      badVerdict.code === "CLIENT_NOT_CONFIGURED" &&
      badVerdict.config_problems.length > 0,
    "①-2 坏配置（launch_template 是命令字符串）逐条报错且不放行",
    { problems: badLoad.problems, code: badVerdict.code },
  );
  fs.rmSync(path.join(badFx.workDir, AGENT_CONFIG_FILE), { force: true });
  const healedVerdict = resolveStartable({ project_id: badFx.id, client_id: "kimi-code", dataDir, env: envOf() });
  ok(
    badLoad.problems.length > 0 && healedVerdict.startable === true && healedVerdict.code === "OK",
    "①-2 坏配置移除后回到内置档案可用（挡住的是坏那一刻的配置，不是整个项目）",
    healedVerdict,
  );
  const parseCases: { raw: unknown; want: string }[] = [
    { raw: { client_id: "x", launch_template: ["run", "<prompt>", "<unknown_ph>"] }, want: "未登记占位符" },
    { raw: { client_id: "x", launch_template: ["run", "--model", "<model>"] }, want: "必须含 <prompt>" },
    { raw: { client_id: "x" }, want: "缺 launch_template" },
    { raw: { launch_template: ["run", "<prompt>"] }, want: "缺 client_id" },
  ];
  const parseHits = parseCases.map((c) => {
    const r = parseClientProfile(c.raw);
    return "errors" in r && r.errors.some((e) => e.includes(c.want));
  });
  ok(
    parseHits.every(Boolean),
    "①-2 档案校验逐条报因（未登记占位符 / 缺 <prompt> / 缺模板 / 缺 client_id）",
    parseCases.map((c, i) => ({ want: c.want, hit: parseHits[i] })),
  );

  info("── ①-3 字符串命令拒收 / argv 模板渲染（§6.5「模型生成的说明文本不能直接成为命令」）");
  const textCmd = renderArgv("kimi -p '把 calc.js 改好' --auto", {});
  ok(
    textCmd.ok === false && textCmd.code === "COMMAND_FROM_TEXT_REJECTED" && textCmd.message.includes("模型生成"),
    "①-3 传字符串命令 → COMMAND_FROM_TEXT_REJECTED（命令行文本不收）",
    textCmd,
  );
  const rendered = renderArgv(["run", "--prompt", "<prompt>", "--dir", "<workspace>"], {
    "<prompt>": "补一个函数",
    "<workspace>": "C:/tmp/ws",
  });
  ok(
    rendered.ok === true &&
      rendered.argv.length === 5 &&
      rendered.argv[0] === "run" &&
      rendered.argv[2] === "补一个函数" &&
      rendered.argv[4] === "C:/tmp/ws" &&
      rendered.argv.every((a) => !/^["'].*["']$/.test(a)),
    "①-3 数组模板按占位符渲染成 argv 数组（不拼 shell 字符串、不夹引号）",
    rendered,
  );
  const missingValue = renderArgv(["run", "<prompt>", "<model>"], { "<prompt>": "x" });
  const unknownPh = renderArgv(["run", "<prompt>", "<evil>"], { "<prompt>": "x", "<evil>": "y" });
  ok(
    missingValue.ok === false &&
      missingValue.code === "TEMPLATE_INVALID" &&
      missingValue.failures.some((f) => f.includes("<model>")) &&
      unknownPh.ok === false &&
      unknownPh.code === "TEMPLATE_INVALID",
    "①-3 缺值 / 未登记占位符 → TEMPLATE_INVALID（逐条点名）",
    { missingValue, unknownPh },
  );
  ok(
    ARGV_PLACEHOLDERS.length === 7 &&
      argvDigest(["a", "b"]) === argvDigest(["a", "b"]) &&
      argvDigest(["a", "b"]) !== argvDigest(["a", "b", "c"]),
    "①-3 占位符白名单七项 + argv 指纹稳定（同命令同指纹、改一个参数就变）",
    ARGV_PLACEHOLDERS,
  );

  info("── ①-4 workspace 隔离口径（任务目录隔离 / 重叠修改串行化）");
  const rootWs = assertIsolatedWorkspace(mainFx.root, dataDir);
  const ancestorWs = assertIsolatedWorkspace(tmpBase, dataDir);
  const insideWs = assertIsolatedWorkspace(path.join(mainFx.root, "src", "sub"), dataDir);
  const runsWs = assertIsolatedWorkspace(path.join(mainFx.root, ".工作台", "runs", "T-1", "att-1"), dataDir);
  const tmpWs = assertIsolatedWorkspace(ws1, dataDir);
  ok(
    rootWs.ok === false && rootWs.code === "WORKSPACE_NOT_ISOLATED" && rootWs.failures.some((f) => f.includes("就是项目根")),
    "①-4 工作目录 = 项目根 → WORKSPACE_NOT_ISOLATED",
    rootWs,
  );
  ok(
    ancestorWs.ok === false && ancestorWs.failures.some((f) => f.includes("祖先")),
    "①-4 工作目录是项目根的祖先 → 拒（不把项目根一起暴露给外部执行器）",
    ancestorWs,
  );
  ok(
    insideWs.ok === false && insideWs.failures.some((f) => f.includes("隔离运行区")),
    "①-4 项目内但不是 `.工作台/runs/` → 拒（避免直接改工作树）",
    insideWs,
  );
  ok(
    runsWs.ok === true && tmpWs.ok === true && tmpWs.workspace === path.resolve(ws1),
    "①-4 `<项目>/.工作台/runs/<task>/<attempt>` 与 tmpdir 隔离目录都放行",
    { runsWs, tmpWs },
  );

  info("── ①-5 不可启动路径（未配置 / 缺二进制 / 缺凭据，且不替用户选服务）");
  const notConfigured = resolveStartable({ project_id: mainFx.id, client_id: "no-such-client", dataDir, env: envOf() });
  ok(
    notConfigured.startable === false &&
      notConfigured.code === "CLIENT_NOT_CONFIGURED" &&
      notConfigured.missing.some((m) => m.includes("no-such-client")) &&
      notConfigured.note === NO_SUBSTITUTE_NOTE,
    "①-5 未配置客户端 → CLIENT_NOT_CONFIGURED + 逐条缺项 + NO_SUBSTITUTE_NOTE 逐字在场",
    notConfigured,
  );
  const noBin = resolveStartable({ project_id: mainFx.id, client_id: "kimi-code", dataDir, env: envOf({ PATH: emptyBinDir }) });
  ok(
    noBin.startable === false && noBin.code === "CLIENT_UNAVAILABLE" && noBin.missing.some((m) => m.includes("可执行文件")),
    "①-5 PATH 上找不到 CLI → CLIENT_UNAVAILABLE（不试跑、不换服务）",
    noBin,
  );
  const noCred = resolveStartable({ project_id: mainFx.id, client_id: "kimi-code", dataDir, env: envOf({ KIMI_CODE_HOME: noKeyKimiHome }) });
  ok(
    noCred.startable === false &&
      noCred.code === "CREDENTIAL_MISSING" &&
      noCred.credentials.some((c) => !c.present) &&
      !JSON.stringify(noCred).includes("fixture-not-a-real-key"),
    "①-5 缺凭据 → CREDENTIAL_MISSING（只报在不在，回执里不带密钥原文）",
    { code: noCred.code, credentials: noCred.credentials },
  );
  const okVerdict = resolveStartable({ project_id: mainFx.id, client_id: "kimi-code", dataDir, env: envOf() });
  const claudeOk = resolveStartable({ project_id: mainFx.id, client_id: "claude-code", dataDir, env: envOf() });
  const claudeNoCred = resolveStartable({
    project_id: mainFx.id,
    client_id: "claude-code",
    dataDir,
    env: envOf({ HOME: path.join(tmpBase, "empty-home"), USERPROFILE: path.join(tmpBase, "empty-home") }),
  });
  ok(
    claudeOk.startable === true &&
      claudeOk.code === "OK" &&
      claudeOk.credentials.some((c) => c.present) &&
      claudeOk.credentials.some((c) => !c.present) &&
      claudeNoCred.startable === false &&
      claudeNoCred.code === "CREDENTIAL_MISSING" &&
      claudeNoCred.missing.length === 2,
    "①-5 凭据「任一满足」口径（Claude Code：settings.json 令牌在即算齐；两条都没有才 CREDENTIAL_MISSING）",
    { claudeOk, claudeNoCred },
  );
  ok(
    okVerdict.startable === true &&
      okVerdict.code === "OK" &&
      okVerdict.verified_version === "0.41.0" &&
      okVerdict.workspace_convention?.includes("隔离工作目录") === true &&
      okVerdict.credentials.every((c) => c.present),
    "①-5 凭据齐 + 二进制在 → OK，并转述实测版本与隔离目录约定",
    okVerdict,
  );
  ok(
    checkCredential({ kind: "env", name: "V0611_FAKE_TOKEN", label: "夹具环境变量" }, envOf()).present === false &&
      checkCredential({ kind: "env", name: "V0611_FAKE_TOKEN", label: "夹具环境变量" }, envOf({ V0611_FAKE_TOKEN: "1" })).present === true &&
      findExecutable("kimi", envOf({ PATH: emptyBinDir })) === null &&
      (findExecutable("kimi", envOf()) ?? "").toLowerCase().endsWith("kimi.exe"),
    "①-5 环境变量型凭据与可执行文件定位各有正反两例（缺就是缺，不猜）",
  );
  ok(
    tomlSectionKeyPresent(read(path.join(fakeKimiHome, "config.toml")), "providers.deepseek") === true &&
      tomlSectionKeyPresent(read(path.join(noKeyKimiHome, "config.toml")), "providers.deepseek") === false &&
      jsonPathPresent({ env: { ANTHROPIC_AUTH_TOKEN: "x" } }, "env.ANTHROPIC_AUTH_TOKEN") === true &&
      jsonPathPresent({ env: {} }, "env.ANTHROPIC_AUTH_TOKEN") === false,
    "①-5 凭据探测：TOML 段落 api_key 与 JSON 点分路径都能判「在不在」（两条路径各自正反）",
  );

  info("── ①-6 启动计划（argv 只从受控模板来；塔台不 spawn）");
  const hashBeforePlan = eventsHash(mainFx.workDir);
  const plan = buildLaunchPlan({
    project_id: mainFx.id,
    client_id: "kimi-code",
    prompt: "在隔离小项目里补一个函数并让测试从红变绿",
    workspace: ws1,
    model: "deepseek-v41-flash",
    task_id: "T-1",
    run_id: "run-T-1-1",
    attempt_id: "att-1",
    dataDir,
    env: envOf(),
  });
  const wantArgv = ["-p", "在隔离小项目里补一个函数并让测试从红变绿", "--model", "deepseek-v41-flash", "--output-format", "text"];
  ok(
    plan.ok === true && plan.plan.argv.length === wantArgv.length && plan.plan.argv.every((a, i) => a === wantArgv[i]),
    "①-6 启动计划 argv = 受控模板逐字渲染（`-p` 非交互 + 实测 model 别名；`-p` 与 `--auto` 互斥，实测后不再拼它）",
    plan.ok ? plan.plan.argv : plan,
  );
  ok(
    plan.ok === true &&
      plan.plan.cwd === path.resolve(ws1) &&
      plan.plan.argv_digest === argvDigest(plan.plan.argv) &&
      plan.plan.timeout_ms === DEFAULT_EXECUTION_TIMEOUT_MS &&
      plan.plan.verified_version === "0.41.0" &&
      plan.plan.coordinator_duties.length === 3 &&
      plan.plan.bin.toLowerCase().endsWith("kimi.exe") &&
      plan.plan.command.length === plan.plan.argv.length + 1 &&
      plan.plan.command[0] === plan.plan.bin &&
      plan.plan.command.slice(1).join(" ") === plan.plan.argv.join(" "),
    "①-6 计划含 bin/command（协调器照它 spawn）/ cwd / 指纹 / 超时 / 实测版本 / 协调器职责三条",
    plan.ok ? plan.plan : plan,
  );
  ok(eventsHash(mainFx.workDir) === hashBeforePlan, "①-6 产出启动计划**不写任何事实**（events.jsonl 逐字节没变）");
  const planEffort = buildLaunchPlan({
    project_id: mainFx.id,
    client_id: "claude-code",
    prompt: "x",
    workspace: ws2,
    effort: "medium",
    dataDir,
    env: envOf(),
  });
  const planBadEffort = buildLaunchPlan({
    project_id: mainFx.id,
    client_id: "claude-code",
    prompt: "x",
    workspace: ws2,
    effort: "maxx",
    dataDir,
    env: envOf(),
  });
  ok(
    planEffort.ok === true &&
      planEffort.plan.argv.includes("--effort") &&
      planEffort.plan.argv[planEffort.plan.argv.indexOf("--effort") + 1] === "medium" &&
      planBadEffort.ok === false &&
      planBadEffort.code === "TEMPLATE_INVALID",
    "①-6 档位合法时追加 `--effort <level>`；非法档位 → TEMPLATE_INVALID（挡在配置层）",
    { planEffort, planBadEffort },
  );
  const planUnknownClient = buildLaunchPlan({
    project_id: mainFx.id,
    client_id: "no-such-client",
    prompt: "x",
    workspace: ws1,
    dataDir,
    env: envOf(),
  });
  const planBadWs = buildLaunchPlan({
    project_id: mainFx.id,
    client_id: "kimi-code",
    prompt: "x",
    workspace: mainFx.root,
    dataDir,
    env: envOf(),
  });
  ok(
    planUnknownClient.ok === false &&
      planUnknownClient.code === "CLIENT_NOT_CONFIGURED" &&
      planUnknownClient.failures.length > 0 &&
      planBadWs.ok === false &&
      planBadWs.code === "WORKSPACE_NOT_ISOLATED",
    "①-6 不可启动的客户端连启动计划都不给；工作目录不隔离也不给（失败码原样透传）",
    { planUnknownClient, planBadWs },
  );
  ok(
    plan.ok === true && eventsHash(mainFx.workDir) === hashBeforePlan,
    "①-6 全部不可启动/不合法路径都不写一个字节",
  );

  // ═══════════════════ ② 回执协议（假执行器把五类事件跑全） ═══════════════════

  info("── ②-1 协调器领取既有任务 → 提交启动回执");
  const running = await startFakeExecution(mainFx, "T-1", "ex-T-1-att-1", ws1, {
    execution_id: "ex-coordinator-session-1",
    run_id: "run-coordinator-1",
  });
  const claim = running.claim;
  const baseTarget = running.target;
  const recAfterStart = readExecution(mainFx.workDir, "ex-T-1-att-1");
  ok(
    claim.claim_token.startsWith("clm-") && recAfterStart !== null && recAfterStart.site_state === "running" && recAfterStart.started_at !== null,
    "②-1 启动确认后运行现场是「运行中」（认领凭证 + 起跑时间都在）",
    recAfterStart,
  );
  const targetEvents = allEvents(mainFx.workDir).filter((e) => e.entity_id === executionEntityId("ex-T-1-att-1"));
  const startedEvent = targetEvents.find((e) => e.type === "execution.started");
  const actualOfStarted = ((startedEvent?.payload ?? {}) as Record<string, unknown>).actual as Record<string, unknown> | undefined;
  ok(
    actualOfStarted !== undefined &&
      actualOfStarted.client_id === EXECUTOR &&
      actualOfStarted.client_version === "0.41.0" &&
      actualOfStarted.model === "deepseek-v41-flash" &&
      actualOfStarted.workspace === ws1 &&
      actualOfStarted.pid === 4242 &&
      actualOfStarted.parent_execution_id === "ex-coordinator-session-1" &&
      actualOfStarted.parent_run_id === "run-coordinator-1" &&
      actualOfStarted.coordinator_id === COORDINATOR,
    "②-1 实际客户端/版本/model/effort/workspace 与父执行（父子链）都落进事件",
    actualOfStarted,
  );
  const requestEvent = targetEvents.find((e) => e.type === "execution.start_requested");
  ok(
    ((requestEvent?.payload ?? {}) as Record<string, unknown>).site_state === "start_requested" &&
      ((requestEvent?.payload ?? {}) as Record<string, unknown>).timeout_ms === DEFAULT_EXECUTION_TIMEOUT_MS &&
      ((requestEvent?.payload ?? {}) as Record<string, unknown>).argv_digest === "sha256:fixture-argv",
    "②-1 启动请求那一刻记的是「启动请求中」+ 超时上限 + argv 指纹（不是运行中）",
    requestEvent?.payload,
  );
  ok(
    targetEvents.map((e) => e.type).join(",") === "execution.start_requested,execution.started",
    "②-1 启动只产生两条事件（请求 + 确认），顺序稳定",
    targetEvents.map((e) => e.type),
  );

  info("── ②-2 心跳 / 检查点（含等待输入）");
  const hb1 = await recordHeartbeat({ ...baseTarget, observed_at: signalNow(-60000), note: "正在跑测试" }, submitter, dataDir);
  const hbWait = await recordHeartbeat(
    { ...baseTarget, observed_at: signalNow(-30000), awaiting_input: true, note: "等用户确认改法" },
    submitter,
    dataDir,
  );
  const recAfterHb = readExecution(mainFx.workDir, "ex-T-1-att-1");
  ok(
    hb1.ok === true &&
      hbWait.ok === true &&
      recAfterHb !== null &&
      recAfterHb.site_state === "awaiting_input" &&
      recAfterHb.heartbeats.length === 2 &&
      recAfterHb.heartbeats[0].note === "正在跑测试",
    "②-2 心跳两连写成功；执行器自报「等待输入」时运行现场跟着变（心跳内容读得回）",
    recAfterHb?.heartbeats,
  );
  const cp = await recordCheckpoint(
    {
      ...baseTarget,
      observed_at: signalNow(-1000),
      note: "calc.js 已补 multiply，测试还红",
      artifacts: ["calc.js"],
      worktree: { dirty: true, changed_files: ["calc.js"], head: "abc1234" },
      effects_in_flight: ["eff-1"],
    },
    submitter,
    dataDir,
  );
  const cpEmpty = await recordCheckpoint({ ...baseTarget, note: "   " }, submitter, dataDir);
  const recAfterCp = readExecution(mainFx.workDir, "ex-T-1-att-1");
  ok(
    cp.ok === true && cpEmpty.ok === false && cpEmpty.code === "INVALID_COMMAND",
    "②-2 检查点必须带现场内容（空 note 拒收）；带成果/工作树/在飞动作的检查点落盘",
    { cp, cpEmpty },
  );
  ok(
    recAfterCp !== null &&
      recAfterCp.checkpoints.length === 1 &&
      recAfterCp.checkpoints[0].artifacts[0] === "calc.js" &&
      recAfterCp.checkpoints[0].worktree?.changed_files[0] === "calc.js" &&
      recAfterCp.checkpoints[0].effects_in_flight[0] === "eff-1",
    "②-2 检查点内容（成果 / 未提交改动 / 在飞动作）能从事件里读回",
    recAfterCp?.checkpoints,
  );

  info("── ②-3 停止：请求 ≠ 已停止；没有确认依据一律拒收");
  const stopReq = await recordStopRequested(
    { ...baseTarget, reason: "超时上限到了", confirm_method: "kill 后按 PID 查进程是否还在" },
    submitter,
    dataDir,
  );
  const stopNoConfirmation = await recordStopped({ ...baseTarget, confirmation: "  " }, submitter, dataDir);
  const stoppedEvents = allEvents(mainFx.workDir).filter((e) => e.type === "execution.stopped");
  ok(
    stopReq.ok === true &&
      readExecution(mainFx.workDir, "ex-T-1-att-1")?.site_state === "stop_requested" &&
      stopNoConfirmation.ok === false &&
      stopNoConfirmation.code === "STOP_NOT_CONFIRMED" &&
      stopNoConfirmation.message.includes("不往同一个可写目录派新执行"),
    "②-3 停止请求把现场推进到「停止请求中」；停止没有确认依据 → STOP_NOT_CONFIRMED",
    { stopReq, stopNoConfirmation },
  );
  ok(stoppedEvents.length === 0, "②-3 被拒的停止**没有**写进事件（现场仍只有停止请求）", stoppedEvents.length);

  info("── ②-4 外部动作：先声明、后确认、查不清就标待核实");
  const declared = await declareEffect(
    {
      ...baseTarget,
      effect_id: "eff-1",
      target: "隔离演练目录的远端备份仓库",
      authorization: "用户已批准本次演练范围内的外部动作",
      verify_method: "按 commit 号查远端分支是否存在",
      external_idempotency_key: "idem-eff-1",
    },
    submitter,
    dataDir,
  );
  const badDeclare = await declareEffect({ ...baseTarget, effect_id: "eff-x", target: "", authorization: "a", verify_method: "" }, submitter, dataDir);
  const badConfirm = await confirmEffect({ ...baseTarget, effect_id: "eff-1", result_ref: " " }, submitter, dataDir);
  const undeclaredConfirm = await confirmEffect({ ...baseTarget, effect_id: "eff-never-declared", result_ref: "commit:xyz" }, submitter, dataDir);
  const confirmed = await confirmEffect({ ...baseTarget, effect_id: "eff-1", result_ref: "commit:deadbeef" }, submitter, dataDir);
  const declared2 = await declareEffect(
    { ...baseTarget, effect_id: "eff-2", target: "另一个外部目标", authorization: "同上", verify_method: "查对端回执 id" },
    submitter,
    dataDir,
  );
  const unverified = await markEffectUnverified(
    { ...baseTarget, effect_id: "eff-2", check_evidence: "对端查询超时，回执 id 拿不到" },
    submitter,
    dataDir,
  );
  ok(
    declared.ok === true && confirmed.ok === true && declared2.ok === true && unverified.ok === true,
    "②-4 效果声明 / 确认 / 待核实三条回执都写成功",
    { declared, confirmed, declared2, unverified },
  );
  ok(
    badDeclare.ok === false &&
      badDeclare.code === "INVALID_COMMAND" &&
      badConfirm.ok === false &&
      badConfirm.code === "INVALID_COMMAND" &&
      undeclaredConfirm.ok === false &&
      undeclaredConfirm.code === "EFFECT_DECLARATION_MISSING",
    "②-4 声明缺 target/verify_method、确认缺 result_ref、**没声明就确认**（EFFECT_DECLARATION_MISSING）一律拒收",
    { badDeclare, badConfirm, undeclaredConfirm },
  );
  const recEffects = readExecution(mainFx.workDir, "ex-T-1-att-1")?.effects ?? [];
  ok(
    recEffects.length === 2 &&
      recEffects.find((e) => e.effect_id === "eff-1")?.status === "confirmed" &&
      recEffects.find((e) => e.effect_id === "eff-1")?.result_ref === "commit:deadbeef" &&
      recEffects.find((e) => e.effect_id === "eff-1")?.external_idempotency_key === "idem-eff-1" &&
      recEffects.find((e) => e.effect_id === "eff-2")?.status === "unverified" &&
      recEffects.find((e) => e.effect_id === "eff-2")?.retry_blocked === true,
    "②-4 效果记录读回：已确认带实际结果标识与外部幂等键；待核实标 retry_blocked（暂停自动重试）",
    recEffects,
  );

  info("── ②-5 交付回执 + 启动失败必须带现场（不能先标运行中）");
  const delivered = await recordDelivered(
    {
      ...baseTarget,
      client_version: "0.41.0",
      deliverables: ["src/multiply.js", "test/multiply.test.mjs"],
      evidence_refs: ["self-check:测试从红转绿"],
      verification: [{ command: "node test/multiply.test.mjs", exit_code: 0, output_ref: "ws/logs/test.log" }],
      untested: [],
      known_issues: ["只覆盖整数乘法"],
      diff_ref: "ws/diff.patch",
      result_revision: "sha256:fixture",
      exit_code: 0,
    },
    submitter,
    dataDir,
  );
  const recDelivered = readExecution(mainFx.workDir, "ex-T-1-att-1");
  ok(
    delivered.ok === true &&
      recDelivered?.delivered?.exit_code === 0 &&
      recDelivered.delivered.deliverables.length === 2 &&
      recDelivered.delivered.verification[0].exit_code === 0 &&
      recDelivered.delivered.untested.length === 0 &&
      recDelivered.delivered.known_issues[0] === "只覆盖整数乘法",
    "②-5 交付回执带交付物/证据/验证命令与退出码/未测项/已知问题",
    recDelivered?.delivered,
  );

  const failTarget: ExecutionTarget = { ...baseTarget, execution_id: "ex-T-1-att-1-fail", workspace: ws3 };
  const failReq = await recordStartRequested(
    { ...failTarget, goal: "隔离目录里跑一次会失败的启动", argv_digest: "sha256:fail", template_source: "夹具", timeout_ms: 1000 },
    submitter,
    dataDir,
  );
  const failed = await recordFailed(
    {
      ...failTarget,
      phase: "launch",
      scene: { exit_code: 127, stderr_tail: "kimi: command not found", argv_digest: "sha256:fail", message: "子进程起不来" },
      log_ref: "ws/logs/launch.err",
    },
    submitter,
    dataDir,
  );
  const badFailed = await recordFailed({ ...failTarget, phase: "launch", scene: { message: "  " } }, submitter, dataDir);
  const failEventTypes = allEvents(mainFx.workDir)
    .filter((e) => e.entity_id === executionEntityId("ex-T-1-att-1-fail"))
    .map((e) => e.type);
  const recFailed = readExecution(mainFx.workDir, "ex-T-1-att-1-fail");
  ok(
    failReq.ok === true &&
      failed.ok === true &&
      !failEventTypes.includes("execution.started") &&
      failEventTypes.includes("execution.failed"),
    "②-5 启动失败的执行**没有** `execution.started`（不能先把任务标成运行中，§6.5）",
    failEventTypes,
  );
  ok(
    recFailed !== null &&
      recFailed.failed?.exit_code === 127 &&
      recFailed.failed.stderr_tail === "kimi: command not found" &&
      recFailed.site_state === "ended" &&
      badFailed.ok === false &&
      badFailed.code === "INVALID_COMMAND",
    "②-5 失败现场（退出码 / stderr 尾巴）读得回；只有一句话的失败现场拒收",
    { failed: recFailed?.failed, badFailed },
  );

  info("── ②-6 回执只接当前认领：token / 持有者 / 无认领 / 缺目录");
  const beforeBadWrites = eventsHash(mainFx.workDir);
  const wrongToken = await recordHeartbeat({ ...baseTarget, claim_token: "clm-not-this-one" }, submitter, dataDir);
  const wrongOwner = await recordHeartbeat({ ...baseTarget, owner_id: "someone-else" }, submitter, dataDir);
  const emptyWorkspace = await recordHeartbeat({ ...baseTarget, workspace: " " }, submitter, dataDir);
  const unknownTask = await recordHeartbeat({ ...baseTarget, task_id: "T-NOPE" }, submitter, dataDir);
  ok(
    wrongToken.ok === false &&
      wrongToken.code === "CLAIM_NOT_YOURS" &&
      wrongOwner.ok === false &&
      wrongOwner.code === "CLAIM_NOT_YOURS" &&
      emptyWorkspace.ok === false &&
      emptyWorkspace.code === "INVALID_COMMAND" &&
      unknownTask.ok === false &&
      unknownTask.code === "EXECUTION_UNKNOWN",
    "②-6 认领 token 不符 / 持有者不符 / 缺工作目录 / 任务无运行状态 → 四种明确拒绝（带失败码）",
    { wrongToken, wrongOwner, emptyWorkspace, unknownTask },
  );
  ok(eventsHash(mainFx.workDir) === beforeBadWrites, "②-6 被拒的回执一个字节都没写");

  info("── ②-7 幂等与版本冲突（回执也走唯一写入服务）");
  const revBefore = (readExecution(mainFx.workDir, "ex-T-1-att-1") as ExecutionRecord).revision;
  const beatObservedAt = signalNow();
  const beat = { ...baseTarget, expected_revision: revBefore, observed_at: beatObservedAt, note: "同一条心跳重发" };
  const beatA = await recordHeartbeat(beat, submitter, dataDir);
  const beatB = await recordHeartbeat(beat, submitter, dataDir);
  const beatFreshRev = await recordHeartbeat({ ...beat, expected_revision: revBefore + 1 }, submitter, dataDir);
  const sameStamp = allEvents(mainFx.workDir).filter(
    (e) => e.type === "execution.heartbeat" && ((e.payload ?? {}) as Record<string, unknown>).observed_at === beatObservedAt,
  );
  ok(
    beatA.ok === true &&
      beatB.ok === true &&
      beatB.receipt.duplicate === true &&
      beatB.receipt.event_id === beatA.receipt.event_id &&
      sameStamp.length === 1,
    "②-7 同一条心跳按**原次版本**补交命中幂等（返回原回执、不产生第二次效果）",
    { a: beatA.ok ? beatA.receipt : beatA, b: beatB.ok ? beatB.receipt : beatB, sameStamp: sameStamp.length },
  );
  ok(
    beatFreshRev.ok === false && beatFreshRev.code === "IDEMPOTENCY_CONFLICT",
    "②-7 同一个键换成「新版本」重发 → IDEMPOTENCY_CONFLICT（明确拒绝，不静默产生第二次效果）",
    beatFreshRev,
  );
  const staleWrite = (() => {
    try {
      service.submit({
        schema_version: 2,
        project_id: mainFx.id,
        change_id: CHG,
        entity_id: executionEntityId("ex-T-1-att-1"),
        expected_revision: 1,
        type: "execution.heartbeat",
        actor_id: COORDINATOR,
        role: "coordinator",
        idempotency_key: "ex-T-1-att-1:stale-probe",
        payload: {},
      });
      return null;
    } catch (e) {
      return e as { code?: string };
    }
  })();
  ok(staleWrite !== null && staleWrite.code === "VERSION_CONFLICT", "②-7 拿旧版本写回执 → VERSION_CONFLICT（不覆盖别人的推进）", staleWrite);
  ok(
    EXECUTION_FAILURE_CODES.length === 13 &&
      EXECUTION_FAILURE_CODES.every((c) => typeof c === "string" && c.length > 3) &&
      !read(path.join(REPO, "src", "server", "work", "types.ts")).includes("CLIENT_NOT_CONFIGURED"),
    "②-7 调用层失败码登记表 13 条，且**没有**混进写入服务的 `WORK_ERROR_CODES`",
    EXECUTION_FAILURE_CODES,
  );
  const executedTypes = new Set(
    allEvents(mainFx.workDir)
      .filter((e) => e.entity_id === executionEntityId("ex-T-1-att-1"))
      .map((e) => e.type as string),
  );
  ok(
    [
      "execution.start_requested",
      "execution.started",
      "execution.heartbeat",
      "execution.checkpoint",
      "execution.stop_requested",
      "execution.effect_declared",
      "execution.effect_confirmed",
      "execution.effect_unverified",
      "execution.delivered",
    ].every((t) => executedTypes.has(t)),
    "②-7 一次执行里把五类事件 + 效果三态跑全（事件类型逐个点名在场）",
    [...executedTypes],
  );

  // ═══════════════════ ③ 判活与派发闸门 ═══════════════════

  info("── ③-1 无心跳不当已停止");
  const running2 = await startFakeExecution(fx2, "T-2", "ex-T-2-att-1", ws2);
  // 信号串**相对此刻**推（见 signalNow 注释）：下面两个判活时点都由 lastSignal 推出来——
  // "信号在 1 秒前"= 近期、"推后 8 分钟"= 超期，两者与本地钟点无关；
  // 串仍是 UTC `Z` 形态，与产品自写的本地 `+08:00` 串（requested_at/started_at）混用。
  const hb2 = await recordHeartbeat({ ...running2.target, observed_at: signalNow(), note: "还在跑" }, submitter, dataDir);
  const rec2 = readExecution(fx2.workDir, "ex-T-2-att-1") as ExecutionRecord;
  const lastSignal = rec2.heartbeats[0]?.at ?? rec2.started_at ?? rec2.requested_at;
  const fresh = livenessOf(rec2, isoAt(lastSignal, 1000), DEFAULT_HEARTBEAT_STALE_MS);
  const stale = livenessOf(rec2, isoAt(lastSignal, DEFAULT_HEARTBEAT_STALE_MS * 4), DEFAULT_HEARTBEAT_STALE_MS);
  ok(hb2.ok === true && rec2 !== null && rec2.site_state === "running", "③-1 起一条「运行中」的假执行（心跳在位）", rec2?.site_state);
  ok(
    fresh.state === "confirmed_alive" && fresh.heartbeat_stale === false && fresh.note.includes("最近有信号"),
    "③-1 有近期信号 → confirmed_alive（只说明有信号，不承诺进程必然活着）",
    fresh,
  );
  ok(
    stale.state === "unknown" &&
      stale.heartbeat_stale === true &&
      stale.site_state === "unreachable" &&
      stale.note.includes(NO_HEARTBEAT_NOTE) &&
      stale.confirmation === null,
    "③-1 心跳超期 → unknown/unreachable + NO_HEARTBEAT_NOTE 逐字在场、确认依据为空（**不**说已停止）",
    stale,
  );
  const deliveredRec = readExecution(mainFx.workDir, "ex-T-1-att-1") as ExecutionRecord;
  ok(
    deliveredRec.delivered !== null &&
      livenessOf(deliveredRec, isoAt(deliveredRec.updated_at, 1000)).state === "unknown" &&
      livenessOf(deliveredRec, isoAt(deliveredRec.updated_at, 1000)).site_state === "ended" &&
      livenessOf(deliveredRec, isoAt(deliveredRec.updated_at, 1000)).note.includes("停止未确认"),
    "③-1 交付只说明「已结束」，停止仍需确认（判活仍是 unknown 且如实说明）",
    livenessOf(deliveredRec, isoAt(deliveredRec.updated_at, 1000)),
  );

  info("── ③-2 停止未确认不再派同一可写目录");
  const guardSame = dispatchGuard({ rec: rec2, target_workspace: ws2, now: isoAt(lastSignal, DEFAULT_HEARTBEAT_STALE_MS * 4) });
  const guardOther = dispatchGuard({ rec: rec2, target_workspace: ws3, now: isoAt(lastSignal, DEFAULT_HEARTBEAT_STALE_MS * 4) });
  ok(
    guardSame.allowed === false &&
      guardSame.code === "STOP_NOT_CONFIRMED_SAME_WORKSPACE" &&
      guardSame.message.includes("不往同一个可写目录派新执行") &&
      path.resolve(guardSame.suggested_workspace) !== path.resolve(ws2) &&
      guardSame.prerequisites.length >= 3,
    "③-2 停止未确认 + 同一目录 → 拒绝，并给隔离目录与新 attempt 前置条件（逐条）",
    guardSame,
  );
  ok(guardOther.allowed === true && guardOther.code === "OK", "③-2 换到不同（隔离）目录 → 放行（隔离成立即可派）", guardOther);
  const stopped = await recordStopped(
    {
      ...running2.target,
      confirmation: "kill 后按 PID 4242 查不到进程，且工作目录 mtime 5 分钟没变",
      evidence: ["ps -p 4242 无输出", "ws2 mtime=10:02:30"],
      exit_code: null,
    },
    submitter,
    dataDir,
  );
  const rec2Stopped = readExecution(fx2.workDir, "ex-T-2-att-1") as ExecutionRecord;
  const guardConfirmed = dispatchGuard({ rec: rec2Stopped, target_workspace: ws2, now: isoAt(lastSignal, DEFAULT_HEARTBEAT_STALE_MS * 4) });
  ok(
    stopped.ok === true &&
      rec2Stopped.stop_confirmation !== null &&
      rec2Stopped.stop_confirmation_evidence.length === 2 &&
      livenessOf(rec2Stopped, isoAt(lastSignal, DEFAULT_HEARTBEAT_STALE_MS * 4)).state === "confirmed_stopped" &&
      guardConfirmed.allowed === true,
    "③-2 带确认依据的停止 → confirmed_stopped，此后同一目录才可再派",
    { stop: stopped, guard: guardConfirmed },
  );
  ok(
    livenessOf({ ...rec2Stopped, stop_confirmation: null }, isoAt(lastSignal, 1000)).state === "unknown" &&
      livenessOf({ ...rec2Stopped, stop_confirmation: null }, isoAt(lastSignal, 1000)).note.includes("未确认"),
    "③-2 有停止事件但**没有**确认依据 → 按未确认处理（fail-closed）",
  );
  // 另一条执行（T-1）也要有"停止已确认"才会在恢复时被判成 no write possible
  const stoppedT1 = await recordStopped(
    {
      ...baseTarget,
      confirmation: "kill 后 PID 4242 不在进程表；工作目录 5 分钟无写入",
      evidence: ["ps -p 4242 无输出"],
      exit_code: 0,
    },
    submitter,
    dataDir,
  );
  const rec1Stopped = readExecution(mainFx.workDir, "ex-T-1-att-1") as ExecutionRecord;
  ok(
    stoppedT1.ok === true &&
      rec1Stopped.stop_confirmation !== null &&
      livenessOf(rec1Stopped, isoAt(rec1Stopped.updated_at, 1000)).state === "confirmed_stopped" &&
      dispatchGuard({ rec: rec1Stopped, target_workspace: ws1, now: isoAt(rec1Stopped.updated_at, 1000) }).allowed === true,
    "③-2 第二条执行补齐停止确认后，同一目录的派发闸门才打开（两条执行各自独立）",
    { stop: stoppedT1, live: livenessOf(rec1Stopped, isoAt(rec1Stopped.updated_at, 1000)).state },
  );

  // ═══════════════════ ④ 恢复核对（注入探针；先查效果、不盲重放） ═══════════════════

  info("── ④-1 恢复顺序与 §5.4 逐字对齐、先查询外部效果");
  // 恢复核对的对照时刻与探针报的租约：都相对此刻推（同 signalNow 口径），不写死绝对串
  const recoveryNow = signalNow();
  const probeOf = (opts: {
    process?: "alive" | "gone" | "unknown";
    effects?: Record<string, "effective" | "not_effective" | "unverifiable">;
    defaultEffect?: "effective" | "not_effective" | "unverifiable";
    dirty?: boolean;
    changed?: string[];
    claimToken?: string;
  }): ExecutionProbe => ({
    process: () => ({ state: opts.process ?? "gone", checked_by: "按 PID 查进程表 + 看工作目录 mtime", evidence: ["ps 无匹配"] }),
    workspace: () => ({ exists: true, dirty: opts.dirty ?? false, changed_files: opts.changed ?? [], head: "abc1234", errors: [] }),
    effect: (effect) => {
      const status = opts.effects?.[effect.effect_id] ?? opts.defaultEffect ?? "effective";
      return {
        effect_id: effect.effect_id,
        status,
        result_ref: status === "effective" ? "commit:deadbeef" : null,
        checked_by: `按核实方法「${effect.verify_method}」真查对端`,
        evidence: "对端查询结果快照",
      };
    },
    task: () => ({
      revision: 99,
      status: "claim",
      claim_token: opts.claimToken ?? claim.claim_token,
      owner_id: COORDINATOR,
      lease_expires_at: signalNow(3600000),
    }),
  });

  const resumed = await planRecovery({
    project_id: mainFx.id,
    execution_id: "ex-T-1-att-1",
    probe: probeOf({ process: "gone", effects: { "eff-1": "effective", "eff-2": "unverifiable" }, dirty: true, changed: ["calc.js"] }),
    target_workspace: ws1,
    dataDir,
    now: recoveryNow,
  });
  const p0 = resumed.ok ? resumed.plan : null;
  ok(
    p0 !== null && p0.steps.map((s) => s.step).join(",") === RECOVERY_STEPS.join(","),
    "④-1 恢复步骤顺序 = §5.4 故障恢复顺序（八步逐字对齐）",
    p0?.steps.map((s) => s.step) ?? resumed,
  );
  ok(
    p0 !== null &&
      p0.steps[1].step === "query_effect" &&
      p0.steps[1].observed.includes("eff-1") &&
      p0.steps[1].observed.includes("eff-2"),
    "④-1 **先查询实际效果**：第二步就是效果查询，且结论按 effect_id 逐个点名",
    p0?.steps[1] ?? resumed,
  );
  ok(
    p0 !== null &&
      p0.effects.length === 2 &&
      p0.effects.find((e) => e.effect.effect_id === "eff-1")?.decision.includes("补交回执") === true &&
      p0.effects.find((e) => e.effect.effect_id === "eff-2")?.decision.includes(EFFECT_UNVERIFIED_NOTE) === true,
    "④-1 动作已发生 → 补交回执不重放；查不清 → 标待核实并按 EFFECT_UNVERIFIED_NOTE 处理",
    p0?.effects.map((e) => ({ id: e.effect.effect_id, dec: e.decision })) ?? resumed,
  );
  ok(
    p0 !== null &&
      p0.blind_replay_blocked === true &&
      p0.blind_replay_reasons.some((r) => r.includes("eff-2")) &&
      p0.verdict === "await_effect_verification",
    "④-1 结果不明 → blind_replay_blocked=true 且判定为「先核实效果」（不盲重放）",
    p0 === null ? resumed : { blocked: p0.blind_replay_blocked, reasons: p0.blind_replay_reasons, verdict: p0.verdict },
  );
  ok(
    p0 !== null &&
      p0.process.state === "gone" &&
      p0.old_run_write_possible === "no" &&
      p0.workspace_state.dirty === true &&
      (p0.steps.find((s) => s.step === "worktree_baseline")?.decision ?? "").includes("保留") &&
      p0.task_state.claim_token === claim.claim_token &&
      (p0.last_checkpoint?.note ?? "").includes("calc.js 已补 multiply") &&
      p0.inheritable_artifacts.join(",") === "calc.js" &&
      p0.changed_since_checkpoint.join(",") === "calc.js" &&
      (p0.steps.find((s) => s.step === "result_evidence_validity")?.decision ?? "").includes("重新验证") &&
      p0.liveness.state === "confirmed_stopped",
    "④-1 旧进程 / 未提交改动 / 任务版本 / 最后检查点 / 停止确认都进结论（工作树脏 → 保留现场；点名成果仍在现场但被改过 → 沿用前重新验证）",
    p0 === null ? resumed : { process: p0.process, ws: p0.workspace_state, task: p0.task_state, live: p0.liveness, inherit: p0.inheritable_artifacts, changed: p0.changed_since_checkpoint },
  );

  info("── ④-2 恢复读的是现场：换一个探针，结论跟着变");
  const alivePlan = await planRecovery({
    project_id: mainFx.id,
    execution_id: "ex-T-1-att-1",
    probe: probeOf({ process: "alive", effects: { "eff-1": "not_effective" }, dirty: false }),
    target_workspace: ws1,
    dataDir,
    now: recoveryNow,
  });
  const unknownProcPlan = await planRecovery({
    project_id: mainFx.id,
    execution_id: "ex-T-1-att-1",
    probe: probeOf({ process: "unknown", effects: { "eff-1": "effective" }, dirty: false }),
    target_workspace: ws1,
    dataDir,
    now: recoveryNow,
  });
  const cleanPlan = await planRecovery({
    project_id: mainFx.id,
    execution_id: "ex-T-1-att-1",
    probe: probeOf({ process: "gone", defaultEffect: "effective", dirty: false }),
    target_workspace: ws1,
    dataDir,
    now: recoveryNow,
  });
  const ap = alivePlan.ok ? alivePlan.plan : null;
  const up = unknownProcPlan.ok ? unknownProcPlan.plan : null;
  const cplan = cleanPlan.ok ? cleanPlan.plan : null;
  ok(
    ap !== null &&
      ap.old_run_write_possible === "yes" &&
      ap.blind_replay_blocked === true &&
      ap.verdict === "new_attempt_new_workspace" &&
      ap.dispatch.allowed === false &&
      (ap.dispatch.message ?? "").includes("恢复探针现场") &&
      path.resolve(ap.next_attempt?.workspace ?? "") !== path.resolve(ws1) &&
      (ap.steps.find((s) => s.step === "old_run_write_possible")?.decision ?? "").includes("先终止"),
    "④-2 探针说「旧进程还在」→ 仍有写入可能 + 拦截重放 + **探针现场压过事件里的停止确认** + 新 attempt 落隔离目录",
    ap === null
      ? alivePlan
      : {
          write: ap.old_run_write_possible,
          blocked: ap.blind_replay_blocked,
          verdict: ap.verdict,
          dispatch: ap.dispatch.code,
          dispatch_msg: ap.dispatch.message,
          next_ws: ap.next_attempt?.workspace,
          step: ap.steps.find((s) => s.step === "old_run_write_possible")?.decision,
        },
  );
  ok(
    up !== null &&
      up.old_run_write_possible === "unknown" &&
      up.blind_replay_blocked === true &&
      (up.steps.find((s) => s.step === "old_run_write_possible")?.decision ?? "").includes(NO_HEARTBEAT_NOTE),
    "④-2 探针查不清进程 → 写入可能记 unknown（无心跳不当已停止）+ 仍挡重放",
    up ?? unknownProcPlan,
  );
  ok(
    cplan !== null && cplan.blind_replay_blocked === false && cplan.dispatch.allowed === true && cplan.verdict === "closed",
    "④-2 同一份事件换「已停 + 效果已确认 + 工作树干净」的探针 → 不挡重放且判旧 run 已收口（现场变了结论就变）",
    cplan === null ? cleanPlan : { blocked: cplan.blind_replay_blocked, guard: cplan.dispatch.code, verdict: cplan.verdict },
  );
  const notEffectivePlan = await planRecovery({
    project_id: mainFx.id,
    execution_id: "ex-T-1-att-1",
    probe: probeOf({ process: "gone", effects: { "eff-1": "not_effective" }, dirty: false }),
    target_workspace: ws1,
    dataDir,
    now: recoveryNow,
  });
  ok(
    notEffectivePlan.ok === true &&
      (notEffectivePlan.plan.effects.find((e) => e.effect.effect_id === "eff-1")?.decision ?? "").includes("idem-eff-1"),
    "④-2 动作没发生 → 重试时**复用外部幂等键**（不新造一次副作用）",
    notEffectivePlan.ok ? notEffectivePlan.plan.effects.map((e) => e.decision) : notEffectivePlan,
  );

  info("── ④-3 恢复边界：未知执行 / 在飞动作没声明 / 旧认领仍在");
  const unknownPlan = await planRecovery({ project_id: mainFx.id, execution_id: "ex-not-exist", probe: probeOf({}), dataDir });
  ok(
    unknownPlan.ok === false && unknownPlan.code === "EXECUTION_UNKNOWN" && unknownPlan.read_again.length > 0,
    "④-3 未知执行 → EXECUTION_UNKNOWN（不凭任务 id 猜）",
    unknownPlan,
  );
  const running3 = await startFakeExecution(fx2, "T-3", "ex-T-3-att-1", ws3);
  await recordCheckpoint(
    {
      ...running3.target,
      note: "在飞动作没声明",
      artifacts: ["a.js", "b.js"],
      effects_in_flight: ["eff-missing"],
      worktree: { dirty: false, changed_files: [], head: "h1" },
    },
    submitter,
    dataDir,
  );
  const planT3 = await planRecovery({
    project_id: fx2.id,
    execution_id: "ex-T-3-att-1",
    probe: probeOf({ process: "gone", dirty: false, claimToken: running3.claim.claim_token }),
    target_workspace: ws3,
    dataDir,
    now: signalNow(),
  });
  const p3 = planT3.ok ? planT3.plan : null;
  ok(
    p3 !== null &&
      p3.blind_replay_blocked === true &&
      p3.blind_replay_reasons.some((r) => r.includes("eff-missing")) &&
      p3.last_checkpoint?.artifacts.length === 2 &&
      p3.inheritable_artifacts.length === 2,
    "④-3 检查点里点名却无声明的在飞动作 → 挡住重放并点名；点名成果进「可继承」清单",
    p3 === null ? planT3 : { reasons: p3.blind_replay_reasons, inheritable: p3.inheritable_artifacts },
  );
  ok(
    p3 !== null && p3.steps.some((s) => s.step === "stale_claim" && s.observed.includes("仍持本次认领")),
    "④-3 旧认领仍在 → 恢复结论里如实点名（要处理它才能重派）",
    p3?.steps.find((s) => s.step === "stale_claim") ?? planT3,
  );

  // ═══════════════════ ⑤ 交付面（文档 / 契约登记 / 不 spawn / 无新依赖） ═══════════════════

  info("── ⑤-1 适配档案与契约文档");
  ok(
    fs.existsSync(path.join(REPO, "docs", "agent-integration.md")) &&
      doc.includes("## 5. 回执协议") &&
      doc.includes("## 6. 不可启动路径") &&
      doc.includes("## 8. 未测 / 已知限制") &&
      doc.includes("os.tmpdir()"),
    "⑤-1 docs/agent-integration.md 含回执协议、不可启动路径、隔离目录约定与未测清单",
  );
  ok(
    doc.includes("kimi doctor") &&
      doc.includes("claude --version") &&
      doc.includes("<stdout>") &&
      doc.includes("exit=0") &&
      doc.includes("Kimi doctor"),
    "⑤-1 适配档案贴的是真实实测片段（doctor / --version / --help / 一次性执行输出），不是照抄文档",
  );
  const contractText = read(path.join(REPO, "docs", "work-v2-contract.md"));
  // 行尾归一化仅此一处（口径见 CONTRACT_LF_* 常量注释）：CRLF→LF；之后一律按精确 sha256/字节数比对。
  const contractLf = contractText.replace(/\r\n/g, "\n");
  const contractLfBytes = Buffer.from(contractLf, "utf8");
  ok(
    contractPrefixPinned(contractLf),
    `⑤-1 docs/work-v2-contract.md **纯追加**（新钉前缀=当前全文：LF 口径前 ${CONTRACT_LF_BYTES} 字节精确 sha256 不变），尾部已含已审 2026-10-08 审计纠正段`,
    { bytes: contractLfBytes.length, prefix: sha256(contractLfBytes.subarray(0, CONTRACT_LF_BYTES)).slice(0, 16) },
  );
  // 已审新增段精确在场（先钉整段原文 + sha，再用它做 before 对照与负例）
  ok(
    contractAuditSegmentPinned(contractLf),
    `⑤-1 已审新增段精确在场（2026-10-08 审计纠正，§9.4 下方；段落 sha=${CONTRACT_AUDIT_SEGMENT_20261008_SHA256.slice(0, 16)}…）`,
  );
  // before 对照：移除该已审段后复现旧已钉前缀（证明本轮增量只此一段，别的字节没被顺手放过）
  const lfWithoutAudit = stripAuditSegment20261008(contractLf);
  const oldFullCrlfBytes = Buffer.from(lfWithoutAudit.replace(/\n/g, "\r\n"), "utf8");
  ok(
    Buffer.byteLength(lfWithoutAudit, "utf8") === CONTRACT_WITHOUT_AUDIT_LF_BYTES &&
      sha256(lfWithoutAudit) === CONTRACT_WITHOUT_AUDIT_LF_SHA256 &&
      oldFullCrlfBytes.length === CONTRACT_PREFIX_BYTES_OLD &&
      sha256(oldFullCrlfBytes) === CONTRACT_PREFIX_SHA256_OLD,
    `⑤-1 移除已审新增段后**复现旧已钉前缀**（before：${CONTRACT_PREFIX_BYTES_OLD} 字节/${CONTRACT_PREFIX_SHA256_OLD.slice(0, 16)}…；判据=精确 sha256 相等）`,
  );
  // 负例（判据不放宽）：改原前缀正文 / 改已审新增段 / 整段跳过 都必须报错
  {
    const bodyIdx = contractLf.indexOf("### 9.4 ");
    const mutatedBody = `${contractLf.slice(0, bodyIdx)}${contractLf[bodyIdx] === "#" ? "$" : "#"}${contractLf.slice(bodyIdx + 1)}`;
    const mutatedSegment = contractLf.replace(
      CONTRACT_AUDIT_SEGMENT_20261008,
      `申${CONTRACT_AUDIT_SEGMENT_20261008.slice(1)}`,
    );
    ok(
      !contractPrefixPinned(mutatedBody) &&
        !contractPrefixPinned(mutatedSegment) &&
        !contractPrefixPinned(lfWithoutAudit) &&
        !contractAuditSegmentPinned(mutatedSegment) &&
        !contractAuditSegmentPinned(lfWithoutAudit) &&
        !reproducesOldPrefix(mutatedSegment) &&
        !reproducesOldPrefix(mutatedBody),
      "⑤-1 负例：改原前缀正文 / 改已审新增段 / 整段跳过 均报错（前缀钉值、整段在场、旧前缀复现三重判据都拦）",
      { body: sha256(mutatedBody).slice(0, 16), segment: sha256(mutatedSegment).slice(0, 16), skipped: sha256(lfWithoutAudit).slice(0, 16) },
    );
  }
  ok(
    contractText.includes("## 13. 外部执行与恢复（V06-11 登记") &&
      contractText.includes("execution.start_requested") &&
      contractText.includes("CLIENT_NOT_CONFIGURED"),
    "⑤-1 契约文档 §13 登记执行词表与调用层失败码（逐个点名）",
  );

  info("── ⑤-2 塔台侧不 spawn、不新增依赖、不扩错码表");
  const moduleText = read(path.join(REPO, "src", "server", "work", "executionReceipts.ts"));
  ok(
    !/child_process|spawn\(|execSync|execFile|require\(/.test(moduleText),
    "⑤-2 执行回执模块**不 spawn 任何进程**（不在塔台里再造 worker / 调度中心，§6.5）",
  );
  ok(
    !/\bfrom\s+"(?!node:|\.)/.test(moduleText) && !/\bimport\s*\(/.test(moduleText),
    "⑤-2 模块只 import node 内置与仓库内相对路径（未新增依赖）",
  );
  ok(
    !/WORK_ERROR_CODES\s*=/.test(moduleText) &&
      moduleText.includes("不扩 `WORK_ERROR_CODES`") &&
      !(WORK_ERROR_CODES as readonly string[]).includes("CLIENT_NOT_CONFIGURED") &&
      !(WORK_ERROR_CODES as readonly string[]).includes("STOP_NOT_CONFIRMED"),
    "⑤-2 调用层失败码不写进 WORK_ERROR_CODES（登记面之外的 types.ts 未动：错码表没扩）",
  );
  const pkg = JSON.parse(read(path.join(REPO, "package.json"))) as { scripts: Record<string, string> };
  ok(pkg.scripts["verify:v06-11"] === "tsx scripts/verify-v06-11.ts", "⑤-2 package.json 注册 `verify:v06-11`", pkg.scripts["verify:v06-11"]);
  const typesText = read(path.join(REPO, "src", "server", "work", "types.ts"));
  ok(
    EXECUTION_EVENT_TYPES.every((t) => typesText.includes(`type: "${t}"`)) &&
      EXECUTION_EVENT_TYPES.every((t) => registeredEventTypes().includes(t)) &&
      registeredEventTypes().length === new Set(registeredEventTypes()).size,
    "⑤-2 11 个执行事件类型已逐个点名并入 `types.ts#REGISTERED_EVENT_TYPES`（登记面=能力发现），且登记面无重复",
    { registered: registeredEventTypes().length, execution: EXECUTION_EVENT_TYPES.length },
  );
  ok(
    service.info().registered_event_types.length === registeredEventTypes().length &&
      EXECUTION_EVENT_TYPES.every((t) => service.info().registered_event_types.includes(t)),
    `⑤-2 服务自述（\`service.info().registered_event_types\`）里能看到这 11 个执行事件（共 ${service.info().registered_event_types.length} 条）`,
    service.info().registered_event_types.length,
  );
};

run()
  .catch((e) => {
    console.error(`[verify] 异常：${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
    ok(false, `验证中断：${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(() => {
    info("── 塔台根文档零改动核对（首尾逐文件 sha256；DESIGN.md 附录 B 段单独哈希）");
    for (const rel of DOC_FILES) {
      const abs = path.join(REPO, rel);
      const after = fs.existsSync(abs) ? sha256File(abs) : "<missing>";
      ok(after === docBefore.get(rel), `文档未被改动：${rel} sha256=${after.slice(0, 16)}…`);
    }
    const designAbs = path.join(REPO, "DESIGN.md");
    const appendixAfter = fs.existsSync(designAbs) ? sha256(appendixBOf(read(designAbs))) : "<missing>";
    ok(appendixAfter === appendixBefore.get("DESIGN.md"), `DESIGN.md 附录 B 段未被改动（sha256=${appendixAfter.slice(0, 16)}…）`);

    if (process.env.TATAI_KEEP_TMP === "1") {
      info(`保留现场：${tmpBase}`);
    } else {
      fs.rmSync(tmpBase, { recursive: true, force: true });
      info(`夹具已清理：${path.basename(tmpBase)}`);
    }
    console.log(`\n[verify] V06-11 结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
  });
