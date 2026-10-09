// V09-09 最终集成复审（tsx 跑）：跨客户端接续、正反追踪、真机装卸的**机械可核部分**。
// 用法：pnpm verify:v09-09（先跑过一次 `pnpm verify:v09-09-ui` 产真机六图读数；本脚本读它并对账）
//
// 卡性质（PLAN.md V09-09）：集成复审——产出**结论与证据**，不是再修一轮功能。
// 本脚本覆盖卡面 ①–⑨ 中**机械可核**的部分；判断项（真机装卸、独立审计、用户 Gate）以证据包
// `.工作台/evidence/V09-09/1/` 里的真机记录与如实缺口为准，不由脚本自证。
//
// 覆盖点：
//   ① 六图真实 UI：读 `ui-readings.json`（真浏览器产出）＋与视图常量/后端派生交叉对账；
//      六张截图逐个存在且在盘上。架构主视图节点级来源/证据徽标缺失**如实记录**（缺陷清单，不扩修）。
//   ② MCP 跨客户端接续：`next_action` 恰七值的契约 + **两个真 stdio MCP 客户端（不同客户端名/角色）**
//      经**真桌面宿主**（唯一写入服务，动态端口、隔离 home）对一个**隔离真实项目**跑完整接续闭环
//      「select_project → project_entry → claim_task → 实际产物 → 证据入库 → submit_task_result → 再
//      project_entry 取下一项」；再对**真实项目 tatai** 用真客户端只读取一次（如实记 blocked 读数与
//      理由原文）；v1 未迁移项目过渡接法另跑一次。**不是**直接调函数 claim→resume，也不写真实 tatai 账本。
//   ③ 正反追踪 + 覆盖表全表对账：req-2026-09-24-g3 → §3.2/§11.2 → V09-11 → 证据 正反各一条；
//      链上缺环**如实报缺**（反例）；PLAN 文末覆盖表逐行机械对账 + G-1…G-6 账本 seq 808–813。
//   ④ 备份/恢复隔离演练：真跑备份 → 隔离恢复 → 重放核验（来源可定位/证据哈希相符/清单可读/
//      replaced:false）；复跑 V06-14 两类反证（跨时刻拼接、裸目录副本）仍判不合格。
//   ⑤ 安装/卸载：当前安装包产物在盘上 ＋ **当前包**的真机装卸记录（唯一输入接口
//      `install-uninstall-current.json`，须绑定盘上当前包 sha256）。历史 0.1.0 记录只作历史，
//      **不采信为当前包通过**；缺当前包记录时如实判 **PENDING**（未验证），不拿旧演练充数。
//   ⑥ 文档/状态/蓝图三方同步：DESIGN 附录口径 ↔ getArch 读口投影 ↔ 蓝图/六图读数互不矛盾；
//      文档工具计数恒等（des-current/m2 复跑日志在册）。
//   ⑦ 计划外登记面：逐条确认「已登记影响与启动条件」或「已明确排除」，不留口头承诺。
//   ⑧ 非作者独立审计：**本 attempt 即为 V09-09 的非作者技术复审**——要求证据目录里在册的是一份
//      真做过审视的审计记录（覆盖/未覆盖矩阵 ＋ 独立性声明：是否同模型/同会话/是否先看作者摘要 ＋
//      缺陷清单），不再是「如实标缺口」也能过（判据收紧；用户 Gate ⑨ 仍只留本人）。
//   ⑨ 用户 Gate 只留本人：本批复核未由 Agent 代签用户验收；只交「可请求验收」材料清单。
//
// 隔离口径：真实 `.工作台/work/` 与真实 DESIGN/PLAN **只读**（首尾 sha256 自证零写入）；
// 一切写操作在 os.tmpdir() 夹具里；不调任何 MCP 写工具、不动真实事件账本。

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { getArchTool } from "../src/mcp/tools/getArch";
import { ENTRY_INTERFACE_NAMES } from "../src/mcp/tools/projectEntry";
import { GRAPH_MODES } from "../src/arch/graph-mode";
import { archProvenanceModelOf, readBlueprint } from "../src/arch/blueprint";
import { addProject } from "../src/server/registry";
import { activeBaseline } from "../src/server/work/documents";
import { loadEvents, replayEvents } from "../src/server/work/eventStore";
import { evaluateProjectEntry, NEXT_ACTION_TRIGGERS, PROJECT_ENTRY_ACTIONS } from "../src/server/work/entry";
import { importTaskDefinitions } from "../src/server/work/plan";
import { readRequirements } from "../src/server/work/requirements";
import { projectWorkDir } from "../src/server/workstation";
import { PROJECT_VIEWS } from "../src/ui/arch/projectGraph";
// 安装包文件名带产品版本号；唯一来源见 src/shared/version.ts（读仓库根 package.json）
import { APP_VERSION } from "../src/shared/version";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 输出目录：可选环境变量覆盖（默认仍是旧固定证据目录，保持兼容）。本轮（2026-10-08 v0909-real
// attempt）显式指向新唯一目录，**不覆盖**旧固定证据；相对路径按仓库根解析。
const EVID_ENV = process.env.V0909_EVID_DIR?.trim();
const EVID = EVID_ENV
  ? path.resolve(path.isAbsolute(EVID_ENV) ? EVID_ENV : path.join(REPO, EVID_ENV))
  : path.join(REPO, ".工作台", "evidence", "V09-09", "1");
const REAL_HOME = process.env.TATAI_HOME?.trim() || path.join(os.homedir(), ".tatai");

let pass = 0;
const fails: string[] = [];
const pendings: { label: string; reason: string }[] = [];
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond && detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1600)}`);
  if (cond) pass += 1;
  else {
    fails.push(label);
    process.exitCode = 1;
  }
};
/**
 * 明确 PENDING：本 attempt **做不到**（需 root/最终安装/外部条件）而不是「失败」，也**不是通过**。
 * 三态分开：PASS 计入 pass；FAIL 计入 fails 且退出码 1；PENDING 单列、不进 pass、也**不冒充通过**——
 * 只要还有 PENDING，整轮就**不是全绿**（退出码同样非 0，避免「exit 0＝全通过」被误读）。
 */
const pending = (label: string, reason: string): void => {
  console.log(`[verify] PENDING ${label}（未验证，不计 PASS）`);
  console.log(`[verify]   原因：${reason}`);
  pendings.push({ label, reason });
};
const info = (m: string): void => console.log(`[verify]   ${m}`);
const section = (t: string): void => console.log(`\n[verify] ── ${t}`);

const sha256Text = (t: string): string => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const sha256File = (f: string): string | null =>
  fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null;
const readIf = (f: string): string => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
const readJson = <T>(f: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as T;
  } catch {
    return null;
  }
};
const exists = (f: string): boolean => fs.existsSync(f);
const artifact = (rel: string): string => path.join(EVID, rel);
const raw: Record<string, unknown> = { card: "V09-09", at: new Date().toISOString(), real_home: REAL_HOME };
const mkdirp = (d: string): void => void fs.mkdirSync(d, { recursive: true });
const write = (f: string, t: string): void => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, t, "utf8");
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── 真 `node --check`（XC-1/XC-2 的**可核验证**） ──
// 2026-10-08 root 复审拒收：旧实现创建真实 TS 产物后**从未运行** node --check，
//   却在 store 与 submit 的 verification 里硬编码 `exit_code:0`/`output_ref:"fixture"` —— 无依据的验证报告。
//   本实现改为 `spawnSync(process.execPath, ["--check", <产物>])` **真跑**，原样落 stdout/stderr/exit 三个原始
//   文件（＋命令原文），store 对应真实证据后再 submit；字段一律取真值，绝不预填成功；未真过则守卫抛错、
//   不得提交为通过（②-16c 用语法坏产物反证：真 exit 非 0 且被守卫拒）。
//
// 注意（Node v24 实测）：`node --check` 对含**顶层 ESM**（import/export）的文件走模块路径、不做 CJS 语法核
//   （坏 ESM 也返回 0，等于空转）；故产物写成**脚本式 TS**（无顶层 import/export），让 node --check 真解析；
//   负例同样是脚本式坏产物（真 exit 非 0），两处形状一致、判据不空转。
interface NodeCheck {
  command: string;
  file_rel: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  ok: boolean;
  /** 原始输出取回位置（相对仓库根；文件写入 EVID/raw/） */
  output_ref: string;
  raw: { stdout: string; stderr: string; exit: string; cmd: string };
}
function runNodeCheck(fileAbs: string, fileRel: string, rawBase: string): NodeCheck {
  const r = spawnSync(process.execPath, ["--check", fileAbs], { encoding: "utf8", windowsHide: true });
  const exitCode = typeof r.status === "number" ? r.status : -1;
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  const relOf = (p: string): string => {
    const rel = path.relative(REPO, p);
    return rel.startsWith("..") ? p : rel;
  };
  const pStdout = artifact(path.join("raw", `${rawBase}.stdout.txt`));
  const pStderr = artifact(path.join("raw", `${rawBase}.stderr.txt`));
  const pExit = artifact(path.join("raw", `${rawBase}.exit.txt`));
  const pCmd = artifact(path.join("raw", `${rawBase}.cmd.txt`));
  const pCombined = artifact(path.join("raw", `${rawBase}.combined.txt`));
  write(pStdout, stdout);
  write(pStderr, stderr);
  write(pExit, `${exitCode}\n`);
  write(pCmd, `${process.execPath} --check ${fileAbs}\n`);
  write(
    pCombined,
    `$ ${process.execPath} --check ${fileAbs}\nexit_code=${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
  );
  return {
    command: `node --check ${fileRel}`,
    file_rel: fileRel,
    exit_code: exitCode,
    stdout,
    stderr,
    ok: exitCode === 0,
    output_ref: relOf(pCombined),
    raw: { stdout: relOf(pStdout), stderr: relOf(pStderr), exit: relOf(pExit), cmd: relOf(pCmd) },
  };
}
/** 验证没真过的产物**不得**被当成通过提交（真 exit 0 才放行；用于负例与提交前守卫） */
function requireCheckPass(chk: NodeCheck): void {
  if (!chk.ok) throw new Error(`node --check 未通过（exit ${chk.exit_code}）：${chk.file_rel}——不得提交为通过`);
}

// ── 源 hash 漂移记录（并发写作者存在时如实留痕） ──
// 本 attempt 期间另有 worker 在改 index/runtime 入口、UI 独立复审也在跑：这些文件的 hash 可能中途变化。
// 这里在启动时与收尾各取一次，逐文件报「同/变」，并把两次读数写进 raw —— 不覆盖、不掩盖并发改动。
const DRIFT_WATCH = [
  "src/server/index.ts",
  "src/mcp/index.ts",
  "src/mcp/tools/projectEntry.ts",
  "src/server/work/entry.ts",
  "src/server/work/claims.ts",
  "src/ui/arch/ProjectGraphView.tsx",
  "src/ui/arch/ProvenancePanel.tsx",
  "src/server/work/service.ts",
  "scripts/verify-v09-09.ts",
  "scripts/verify-v09-09-ui.py",
];
const driftFingerprint = (): Record<string, string | null> =>
  Object.fromEntries(DRIFT_WATCH.map((rel) => [rel, sha256File(path.join(REPO, rel))]));
const driftStart = driftFingerprint();

// ── 真实只读现场（零写入自证） ──
const realLedger = path.join(REPO, ".工作台", "work", "events.jsonl");
const ledgerBefore = sha256File(realLedger);
const ledgerBeforeText = readIf(realLedger);
const designBefore = sha256Text(readIf(path.join(REPO, "DESIGN.md")));
const planBefore = sha256Text(readIf(path.join(REPO, "PLAN.md")));

/**
 * 真实账本「本 attempt 零写入」自证（2026-10-08 root 复审后**收紧**；旧判法有洞、被换掉）：
 *
 * 旧判法的洞（root 指出的两个 + 一个同族）：
 *   · 只找「行前缀公共段」，**不判历史是否被截断/改写**：把账本删到只剩公共前缀以内再重写，`appended` 空、
 *     `leaked` 空 ⇒ 全删账本也能过；
 *   · `catch{}` **静默忽略坏 JSON 行**：往账本里塞坏行也不报，等于不要求「新增行都是合法事件」；
 *   · 于是「我们没写」与「有人把账本改了」在旧判法下不可区分。
 *
 * 新判法（判据**收紧**，逐条硬要求，全满足才允许把变化归因于并发写者）：
 *   ① **字节前缀不变**：after 的前 N 字节必须**逐字节等于** before（N=before 字节数）。否则＝历史被截断/改写，
 *      不归因并发，如实判**异常**（ok=false）。
 *   ② **新增全部可解析合法事件**：前缀之后的新增行逐行必须 JSON 可解析、且是合法事件形状（对象 + 非空 `type`）。
 *      任一坏行 ⇒ ok=false（不再静默忽略）。
 *   ③ **新增无本 attempt 标识**：新增事件里 project_id 不得是隔离夹具（`v0909-xclient-real`/`v0909-v1`）、
 *      change_id 不得是 `change-xclient-real`。有 ⇒ 确证写了真实账本，ok=false。
 *   三条全过才 ⇒ ok=true，note 明说「并发写者合法追加」；配 ②-33b 正向对照（夹具事实确实落在隔离项目账本）
 *   区分「我们没写」与「别人在写」。负例（截断/前缀改写/坏 JSON/夹具事实/合法追加）由 ⑩B 用**纯隔离文件**证。
 */
function realLedgerZeroLeak(beforeHash: string | null, beforeText: string, f: string): { ok: boolean; note: string; leaked: string[] } {
  const afterBuf = fs.existsSync(f) ? fs.readFileSync(f) : Buffer.from("", "utf8");
  const afterHash = crypto.createHash("sha256").update(afterBuf).digest("hex");
  // 静默窗口：首尾哈希一致（连字节都没变）⇒ 没人写，直接通过
  if (beforeHash !== null && beforeHash === afterHash) {
    return { ok: true, note: "首尾 sha256 一致（静默窗口，无人写）", leaked: [] };
  }
  const bBuf = Buffer.from(beforeText, "utf8");
  // ① 字节前缀不变（逐字节比较，不是「行前缀」近似）
  const prefixOk = afterBuf.length >= bBuf.length && afterBuf.subarray(0, bBuf.length).equals(bBuf);
  if (!prefixOk) {
    return {
      ok: false,
      note:
        `真实账本**已不是**本 attempt 起点内容的字节前缀（历史被截断或改写：起点 ${bBuf.length} 字节 / 现有 ` +
        `${afterBuf.length} 字节）——不归因并发，判异常`,
      leaked: [],
    };
  }
  const suffix = afterBuf.subarray(bBuf.length).toString("utf8");
  const lines = suffix.split(/\r?\n/).filter((l) => l.trim() !== "");
  const bad: string[] = [];
  const leaked: string[] = [];
  const FIXTURE_PIDS = new Set(["v0909-xclient-real", "v0909-v1"]);
  for (const line of lines) {
    let e: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("不是事件对象");
      e = parsed as Record<string, unknown>;
    } catch {
      // ② 坏 JSON / 非事件对象：**拒绝**，不静默忽略
      bad.push(line.slice(0, 200));
      continue;
    }
    if (typeof e.type !== "string" || e.type === "") {
      bad.push(line.slice(0, 200));
      continue;
    }
    // ③ 本 attempt 夹具事实
    const pid = String(e.project_id ?? "");
    const cid = String(e.change_id ?? "");
    if (FIXTURE_PIDS.has(pid) || cid === "change-xclient-real") leaked.push(line.slice(0, 200));
  }
  if (bad.length > 0) {
    return {
      ok: false,
      note: `真实账本新增行里 ${bad.length} 行**不可解析 / 不是合法事件**（拒绝：不静默忽略坏行）`,
      leaked: [...leaked, ...bad],
    };
  }
  if (leaked.length > 0) {
    return { ok: false, note: `真实账本新增 ${lines.length} 行，其中 ${leaked.length} 条是**本 attempt 夹具事实**`, leaked };
  }
  return {
    ok: true,
    note: `有并发写作者：真实账本新增 ${lines.length} 行（字节前缀不变、新增全部可解析合法、无本 attempt 夹具标识）`,
    leaked: [],
  };
}

/**
 * realLedgerZeroLeak 的**纯隔离文件负例自证**（⑩B，用 TMP 下的临时文件，绝不碰真实账本）：
 *   合法外部追加 ⇒ 通过；截断 / 前缀改写 / 坏 JSON / 夹具事实 ⇒ 全部拒绝。
 */
function realLedgerLeakSelfTest(): void {
  const dir = path.join(TMP, "ledger-selftest");
  mkdirp(dir);
  const put = (name: string, text: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text, "utf8");
    return p;
  };
  const evt = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ schema_version: 2, seq: 1, type: "audit.self_check_recorded", project_id: "tatai", ...over });
  const l1 = evt({ seq: 1 });
  const base = `${l1}\n`;

  // 1) 合法外部追加（非夹具项目）⇒ 归因并发（通过）
  const okFile = put("after-legal.jsonl", `${base}${evt({ seq: 2, actor_id: "Codex", change_id: "project-completion-20261008" })}\n`);
  const r1 = realLedgerZeroLeak(sha256Text(base), base, okFile);
  ok(r1.ok, "⑩B-1 合法外部追加（字节前缀不变 ＋ 新增可解析合法事件 ＋ 无夹具标识）⇒ 归因并发写者", r1.note);

  // 2) 历史被截断（after 不再是 before 的字节前缀）⇒ 拒绝
  const before2 = `${base}${evt({ seq: 2 })}\n${evt({ seq: 3 })}\n`;
  const truncFile = put("after-truncated.jsonl", `${base}${evt({ seq: 2 })}\n`);
  const r2 = realLedgerZeroLeak(sha256Text(before2), before2, truncFile);
  ok(!r2.ok, "⑩B-2 历史被**截断**（after 非 before 字节前缀）⇒ 拒绝（旧判法会漏，新判法拦住）", r2.note);

  // 3) 前缀被改写（同长度、改了更早的一行）⇒ 拒绝
  const rewriteFile = put("after-rewrite.jsonl", `${base}${evt({ seq: 2, type: "audit.rewritten" })}\n${evt({ seq: 3 })}\n`);
  const r3 = realLedgerZeroLeak(sha256Text(before2), before2, rewriteFile);
  ok(!r3.ok, "⑩B-3 前缀被**改写**（新旧字节前缀不一致）⇒ 拒绝", r3.note);

  // 4) 新增坏 JSON 行 ⇒ 拒绝（不再静默忽略）
  const badFile = put("after-badjson.jsonl", `${base}{this is not json\n`);
  const r4 = realLedgerZeroLeak(sha256Text(base), base, badFile);
  ok(!r4.ok, "⑩B-4 新增行含**坏 JSON** ⇒ 拒绝（旧判法静默忽略）", r4.note);

  // 5) 新增事件是本 attempt 夹具事实 ⇒ 拒绝
  const fixFile = put(
    "after-fixture.jsonl",
    `${base}${JSON.stringify({ schema_version: 2, seq: 9, type: "task.claimed", project_id: "v0909-xclient-real", change_id: "change-xclient-real" })}\n`,
  );
  const r5 = realLedgerZeroLeak(sha256Text(base), base, fixFile);
  ok(!r5.ok, "⑩B-5 新增事件是**本 attempt 夹具事实**（project_id/change_id 命中夹具）⇒ 拒绝", r5.note);

  // 6) 全删账本（after 为空）⇒ 拒绝（旧判法会把「空 appended」当通过）
  const emptyFile = put("after-empty.jsonl", "");
  const r6 = realLedgerZeroLeak(sha256Text(before2), before2, emptyFile);
  ok(!r6.ok, "⑩B-6 账本被**全删**（after 为空、after 非 before 前缀）⇒ 拒绝", r6.note);

  raw.ledger_selftest = { legal: r1.ok, trunc: r2.ok, rewrite: r3.ok, badjson: r4.ok, fixture: r5.ok, empty: r6.ok };
}

// ── 隔离数据目录 = 真实 ~/.tatai 的**只读拷贝**（真实注册表；读的是真实项目数据） ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0909-"));
const HOME = path.join(TMP, "home");
fs.mkdirSync(HOME, { recursive: true });
for (const name of ["registry.json", "config.json", "agents.json"]) {
  const src = path.join(REAL_HOME, name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(HOME, name));
}
if (!fs.existsSync(path.join(HOME, "registry.json"))) {
  addProject({ id: "tatai", name: "塔台", path: REPO, kind: "fullstack", self_managed: true }, HOME);
}

// ═══════════════════════════════ ① 六图真实 UI ═══════════════════════════════

type GraphReading = {
  graph: string;
  kind: string;
  question: string;
  node_count: number | null;
  edge_count: number | null;
  screenshot: string;
  source?: string;
  delivery?: string | null;
  update_state?: string | null;
  coverage_rows?: number;
  deliverable_blocked?: string;
  missing_paths?: string[];
  node_source_evidence_badges?: { source: number; evidence: number; aggregate_nodes?: number };
};
type UiReadings = { graphs: GraphReading[]; real_home_before?: { hash: string }; real_home_after?: { hash: string } };

function section1(): void {
  section("① 六图真实 UI（真浏览器读数对账）");
  const ui = readJson<UiReadings>(artifact("ui-readings.json"));
  ok(ui !== null, "①-1 真机六图读数在册（.工作台/evidence/V09-09/1/ui-readings.json）");
  if (ui === null) return;
  const byKey = new Map(ui.graphs.map((g) => [g.graph, g]));
  const wantMain = Object.keys(PROJECT_VIEWS);
  const wantTech = Object.keys(GRAPH_MODES);
  ok(
    wantMain.every((k) => byKey.has(k)) && wantTech.every((k) => byKey.has(k)) && ui.graphs.length === 6,
    `①-2 六图逐屏齐全：三主视图 ${wantMain.join("/")} ＋ 技术详情三张 ${wantTech.join("/")}（共 ${ui.graphs.length} 屏）`,
  );
  for (const k of wantMain) {
    const g = byKey.get(k);
    ok(
      g !== undefined && g.question.length > 0 && g.node_count !== null && (g.node_count as number) > 0,
      `①-3 ${k} 屏：问题句「${g?.question ?? ""}」、节点 ${g?.node_count ?? "?"}、（数据源：${g?.source ?? "?"}）`,
    );
    ok(
      g !== undefined && g.delivery !== undefined && g.delivery !== null && g.update_state !== undefined,
      `①-4 ${k} 屏带 V09-13 交付阻断读数（${g?.delivery}/${g?.deliverable_blocked ?? "-"}）与 V09-12 更新状态（${g?.update_state}）`,
    );
    ok(
      g !== undefined && exists(artifact("ui-shots/" + g.screenshot)) && fs.statSync(artifact("ui-shots/" + g.screenshot)).size > 3000,
      `①-5 ${k} 屏真机截图在盘上：ui-shots/${g?.screenshot}`,
    );
  }
  for (const k of wantTech) {
    const g = byKey.get(k);
    ok(
      g !== undefined && g.question.length > 0 && g.node_count !== null && (g.node_count as number) > 0,
      `①-6 技术详情 ${k} 屏：问题句「${g?.question ?? ""}」、节点 ${g?.node_count ?? "?"}`,
    );
    ok(
      g !== undefined && exists(artifact("ui-shots/" + g.screenshot)),
      `①-7 技术详情 ${k} 屏真机截图在盘上：ui-shots/${g?.screenshot}`,
    );
  }
  const df = byKey.get("DATA_FLOW");
  // 期望定向更新（2026-09-25，review-fix-20260925；判据未放宽）：
  //   旧期望 = `df.deliverable_blocked === "true"`（真实项目 `.工作台/intent.json` 那条数据流路径缺读写点
  //            ⇒ 覆盖对账报缺路径 ⇒ 交付被判阻断）。冻结依据是 V09-09 复审当时的读数。
  //   依据   = 本批次前一步（`review-fix-20260925/intent-path`）给 `intent.json` 补上了真实读点与
  //            登记校验点，真实项目覆盖对账的缺路径由 1 变 0（读数见本段 info 行与
  //            `.工作台/evidence/review-fix-20260925/intent-path/READINGS.md`）。
  //   新期望 = **双向**——数据流向图屏仍必须有双口径与覆盖对账行（原样保留）；缺路径读数要与
  //            `deliverable_blocked` 一致：有缺路径必为 `true`，无缺路径不得留着 `true` 的空阻断。
  //   保留意图 = 「缺路径必须阻断项目可交付」这条判据本身一个字节没动——它由 `verify:v09-11` ④
  //            在**真实模型**上双向断言、⑤ 用合成缺路径反例当场拦住，不靠真实数据的偶然缺件证明有效。
  const dfCovered = (df?.coverage_rows ?? 0) > 0;
  const dfBlocked = df?.deliverable_blocked;
  const dfMissing = df?.missing_paths ?? null;
  ok(
    df !== undefined &&
      dfCovered &&
      (dfBlocked === "true" || dfBlocked === "false") &&
      dfMissing !== null &&
      (dfMissing.length > 0 ? dfBlocked === "true" : dfBlocked === "false"),
    `①-8 数据流向图屏：V09-11 双口径在场、覆盖对账 ${df?.coverage_rows ?? 0} 行、缺路径 ${JSON.stringify(dfMissing)}、交付阻断读数 ${dfBlocked}（真实项目当前缺路径 0 ⇒ 新读数 false，见 intent-path 证据）`,
  );
  const arch = byKey.get("architecture");
  const badges = arch?.node_source_evidence_badges;
  // 期望定向更新（2026-09-25，review-fix-20260925／H-4；判据**收紧**）：旧记录是"本屏徽标 0/0，如实登记缺口"；
  // H-4 已修（本屏画布传 provenance）⇒ 现在断言它**必须有**徽标，且数量＝节点数 − 聚合节点数
  // （聚合节点不是可对账对象，另挂 data-arch-aggregate-note 说明），保留"这一屏的节点级标注可被机械读出"这一意图。
  ok(
    badges !== undefined &&
      badges.source > 0 &&
      badges.source === (arch?.node_count ?? 0) - (badges.aggregate_nodes ?? 0) &&
      badges.evidence === badges.source,
    `①-8b 架构主视图节点级来源/证据徽标 ${JSON.stringify(badges)}（H-4 已修：对象节点全部带徽标；` +
      `聚合节点不是可对账对象）——交付阻断读数仍在（${arch?.delivery}）`,
  );
  raw.section1 = {
    graphs: ui.graphs.map((g) => ({ graph: g.graph, node_count: g.node_count, edge_count: g.edge_count })),
    arch_badges: badges,
  };
}

// ═══════ ② MCP 跨客户端接续（真 stdio 客户端 + 真宿主 + 隔离真实项目） ═══════

/**
 * 本节的判据来源与「为什么这么做」（不是把函数调用说成客户端）：
 *   · 卡面 chk-v09-09-02 要求「用**真实 MCP 客户端**（至少两个不同客户端/角色）跑
 *     `select_project → project_entry → claim_task → 施工 → submit_task_result → 再 project_entry`
 *     的完整接续；记录 `next_action` 各分支的实际取值与理由原文；未迁移项目按 §6.6 另跑一次」。
 *   · 因此本节用 **`@modelcontextprotocol/sdk` 的真 stdio 客户端**连 `src/mcp/index.ts` 子进程，
 *     每个客户端是**独立进程、独立连接**（客户端名/角色都不同）；写口经 `ctx.work` 落到
 *     **真桌面宿主** `src/server/index.ts`（唯一写入服务，动态端口、隔离 home、`TATAI_NO_AUTOSTART=1`
 *     保证 MCP 侧不另起 daemon）。
 *   · 项目是**隔离的真实项目**（真图纸/真施工图/真源码，注册进隔离 home），不是 mock 对象；
 *     真实项目 `tatai` 另用真客户端**只读**取一次，如实记 blocked 读数与理由原文。
 *   · **不写**真实 tatai 账本（`events.jsonl` 首尾 sha256 一致，⑩-6 复核）。
 */

interface CallOut { ok: boolean; text: string; json: Record<string, unknown> }
interface JourneyStep { client: string; role: string; tool: string; ok: boolean; next_action: string | null; reason: string }

const asObj = (j: unknown): Record<string, unknown> =>
  typeof j === "object" && j !== null ? (j as Record<string, unknown>) : {};

/** 跨客户端旅程的干净环境：**清掉一切 TATAI_***（防把真实服务/真实 home 带进来），只留本夹具值 */
function journeyEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k.startsWith("TATAI_")) continue;
    if (/API_?KEY|SECRET|PASSWORD|CREDENTIAL|ACCESS_KEY$/i.test(k)) continue;
    env[k] = v;
  }
  env.TATAI_HOME = HOME;
  env.TATAI_SEMANTIC_AUTO = "0";
  env.TATAI_SYNC_DISCOVERY = "0";
  env.TATAI_NO_AUTOSTART = "1"; // 唯一写入者＝真桌面宿主；MCP 侧绝不另起 daemon
  return { ...env, ...extra };
}

interface HostDescriptor { host: string; port: number; token: string; pid: number }

function readHostDescriptor(): HostDescriptor | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(HOME, "work-service.json"), "utf8")) as Record<string, unknown>;
    if (typeof d.port !== "number" || typeof d.host !== "string" || typeof d.token !== "string" || typeof d.pid !== "number") return null;
    return { host: d.host, port: d.port, token: d.token, pid: d.pid };
  } catch {
    return null;
  }
}

async function waitHostDescriptor(timeoutMs: number): Promise<HostDescriptor | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = readHostDescriptor();
    if (d !== null) return d;
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}

function httpGet(host: string, port: number, p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: p, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("http 超时")));
    req.end();
  });
}

async function connectMcpClient(name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(REPO, "src", "mcp", "index.ts")],
      cwd: REPO,
      env: journeyEnv(),
    }),
  );
  return client;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<CallOut> {
  const r = await client.callTool({ name, arguments: args });
  const content = ((r.content ?? []) as { type?: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  let json: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === "object" && parsed !== null) json = parsed as Record<string, unknown>;
  } catch {
    /* 非 JSON 也算 CallOut（text 里能看） */
  }
  return { ok: r.isError !== true, text: content, json };
}

const nextActionOf = (j: Record<string, unknown>): string | null =>
  typeof j.next_action === "string" ? j.next_action : null;
// `project_entry` 把理由放 `reasons`；`submit_task_result` 的回包把"下一动作的理由"放 `next_reasons`
// （见 `src/server/work/claims.ts#submitTaskResult` 的返回形状）——两处都要读，否则提交步的理由会被记成空串。
const firstReasonTextOf = (j: Record<string, unknown>): string => {
  const rs = Array.isArray(j.reasons)
    ? (j.reasons as unknown[])
    : Array.isArray(j.next_reasons)
      ? (j.next_reasons as unknown[])
      : [];
  const first = asObj(rs[0]);
  return typeof first.text === "string" ? first.text : "";
};
// 理由数组里 `reasons[0]` 常常是**基线/前置**理由（不是本次动作的理由），要按内容找具体那条就得扫全部。
const reasonTextsOf = (j: Record<string, unknown>): string[] => {
  const src = Array.isArray(j.reasons)
    ? (j.reasons as unknown[])
    : Array.isArray(j.next_reasons)
      ? (j.next_reasons as unknown[])
      : [];
  return src
    .map((r) => asObj(r))
    .map((o) => (typeof o.text === "string" ? o.text : ""))
    .filter((t) => t !== "");
};
const revisionInReasons = (j: Record<string, unknown>): number | null => {
  const rs = Array.isArray(j.reasons) ? (j.reasons as unknown[]) : [];
  for (const r of rs) {
    const o = asObj(r);
    if (typeof o.task_revision === "number") return o.task_revision;
  }
  return null;
};
/** 按理由 code 精确取 `task_revision`（`claimable`／`resume_available` 才带得准；别拿别的理由凑） */
const revisionOfReason = (j: Record<string, unknown>, code: string): number | null => {
  const rs = Array.isArray(j.reasons) ? (j.reasons as unknown[]) : [];
  for (const r of rs) {
    const o = asObj(r);
    if (o.code === code && typeof o.task_revision === "number") return o.task_revision;
  }
  return null;
};

const XCLIENT_PLAN = [
  "# V09-09 跨客户端隔离真实项目施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| XC-1 | todo | 第一个可认领的真实卡 | | XC-1 的产物与证据 |",
  "| XC-2 | todo | 第二个可认领的真实卡 | | XC-2 的产物与证据 |",
  "",
  "### XC-1 第一个可认领的真实卡",
  "",
  "**设计依据**：§6.7。**依赖**：无。**文件责任**：`src/xc-1.ts`。",
  "",
  "- [ ] XC-1 产出真实产物并入账",
  "",
  "### XC-2 第二个可认领的真实卡",
  "",
  "**设计依据**：§6.7。**依赖**：无。**文件责任**：`src/xc-2.ts`。",
  "",
  "- [ ] XC-2 产出真实产物并入账",
  "",
].join("\n");

async function section2(): Promise<void> {
  section("② MCP 跨客户端接续（两个真 stdio 客户端 + 真宿主 + 隔离真实项目）");
  const want = ["resume_task", "claim_task", "review_result", "await_role", "await_decision", "blocked", "complete"];
  ok(
    PROJECT_ENTRY_ACTIONS.length === 7 && want.every((w) => (PROJECT_ENTRY_ACTIONS as readonly string[]).includes(w)),
    `②-1 next_action 恰好七值且与 §6.7 枚举一致：${PROJECT_ENTRY_ACTIONS.join("/")}`,
  );
  ok(
    want.every((w) => typeof NEXT_ACTION_TRIGGERS[w as keyof typeof NEXT_ACTION_TRIGGERS] === "string" && NEXT_ACTION_TRIGGERS[w as keyof typeof NEXT_ACTION_TRIGGERS].length > 0),
    "②-2 每个 next_action 都带「什么时候选它」的判据原文",
  );
  ok(
    ENTRY_INTERFACE_NAMES.length === 3 && ENTRY_INTERFACE_NAMES.join(",") === "project_entry,claim_task,submit_task_result",
    `②-3 接续入口只有三只工具（无独立 reopen_task）：${ENTRY_INTERFACE_NAMES.join("/")}`,
  );

  // ── 隔离真实项目（真图纸/真施工图/真源码；注册进隔离 home） ──
  const xid = "v0909-xclient-real";
  const xroot = path.join(TMP, "xclient-real-proj");
  write(path.join(xroot, ".工作台", "design.md"), "# V09-09 跨客户端隔离真实项目设计书\n\n## 1 目标\n\n用一个隔离的真实项目跑通跨客户端接续闭环。\n");
  write(path.join(xroot, ".工作台", "plan.md"), XCLIENT_PLAN);
  addProject({ id: xid, name: "V09-09 跨客户端隔离真实项目", path: xroot, kind: "fullstack" }, HOME);

  const ledgerShaIn2 = sha256File(realLedger);
  const ledgerShaIn2Text = readIf(realLedger);
  const host = spawn(process.execPath, ["--import", "tsx", path.join(REPO, "src", "server", "index.ts")], {
    cwd: REPO,
    env: journeyEnv({ TATAI_PORT: "0" }),
    windowsHide: true,
  });
  const hostLogs: string[] = [];
  host.stdout?.on("data", (d: Buffer) => hostLogs.push(d.toString("utf8")));
  host.stderr?.on("data", (d: Buffer) => hostLogs.push(d.toString("utf8")));

  const steps: JourneyStep[] = [];
  let clientA: Client | null = null;
  let clientB: Client | null = null;
  let clientC: Client | null = null;
  const closes: (() => Promise<void>)[] = [];
  try {
    const desc = await waitHostDescriptor(60_000);
    ok(desc !== null && desc.pid !== process.pid, "②-4 真桌面宿主（唯一写入服务）已起并发布描述符（动态端口，非本进程）", desc === null ? hostLogs.join("").slice(-500) : `port=${desc.port} pid=${desc.pid}`);
    if (desc === null) throw new Error("桌面宿主未发布描述符");
    let healthy = 0;
    for (let i = 0; i < 100; i++) {
      try {
        healthy = await httpGet(desc.host, desc.port, "/health");
        if (healthy === 200) break;
      } catch {
        /* 未就绪 */
      }
      await sleep(200);
    }
    ok(healthy === 200, "②-5 桌面宿主可探活（/health 200）");

    // ── 两个 fresh 真 stdio 客户端（不同客户端名 + 不同角色） ──
    clientA = await connectMcpClient("kimi-code");
    clientB = await connectMcpClient("claude-code");
    closes.push(async () => { if (clientA !== null) await clientA.close(); });
    closes.push(async () => { if (clientB !== null) await clientB.close(); });

    const toolsA = (await clientA.listTools()).tools;
    const names = toolsA.map((t) => t.name);
    ok(
      names.includes("select_project") && names.includes("project_entry") && names.includes("claim_task") &&
        names.includes("submit_task_result") && names.includes("record_work_evidence"),
      `②-6 真 stdio 工具面可发现完整接续链（客户端 A：${toolsA.length} 个工具；select_project/project_entry/claim_task/submit_task_result/record_work_evidence 全在）`,
      names,
    );
    const toolsB = (await clientB.listTools()).tools;
    ok(toolsB.length === toolsA.length, `②-7 客户端 B 是**另一条 fresh 连接**且工具面同源（${toolsB.length} 个）`);

    // ── A：select → 图纸/需求/变更/导入（都经真客户端 → 唯一宿主） ──
    const selA = await callTool(clientA, "select_project", { project_id: xid });
    const selAJson = asObj(selA.json);
    ok(
      selA.ok && selAJson.path === xroot && typeof selAJson.workstation_dir === "string",
      `②-8 客户端 A 真调 select_project（id 入参）→ 项目根 ${String(selAJson.path)}、工作台 ${String(selAJson.workstation_dir)}`,
      selA.text.slice(0, 300),
    );

    const rb = await callTool(clientA, "manage_baseline", { project_id: xid, op: "read" });
    const pair = asObj(asObj(rb.json).current_pair);
    // op=activate 的 expected 要**两份源的内容哈希**（`manage_baseline` schema 的字段名；read 取回后原样回填）
    const expected = {
      design_content_sha256: String(pair.design_content_sha256 ?? ""),
      plan_content_sha256: String(pair.plan_content_sha256 ?? ""),
    };
    ok(
      rb.ok && /^[0-9a-f]{64}$/.test(expected.design_content_sha256) && /^[0-9a-f]{64}$/.test(expected.plan_content_sha256),
      "②-9 客户端 A 读到现行两源修订（激活用 expected 直接用读口值）",
      pair,
    );
    const act = await callTool(clientA, "manage_baseline", {
      project_id: xid, op: "activate", role: "designer", approved_by: "v0909-reviewer",
      approval_basis: "V09-09 跨客户端夹具技术审定（隔离真实项目）", expected,
    });
    ok(act.ok, "②-10 客户端 A 经唯一宿主激活基线（零差异技术审定）", act.text.slice(0, 400));
    const req = await callTool(clientA, "manage_requirement", {
      op: "register", project_id: xid, role: "designer", change_id: "change-xclient-real",
      requirement_id: "req-xclient-1", source: { kind: "user", ref: "V09-09 卡面 chk-v09-09-02（夹具）" },
      problem: "隔离真实项目上验证跨客户端完整接续", users: ["验收人"], success_scenarios: ["两个客户端各跑一条完整闭环"],
      exclusions: ["不写真实 tatai 账本"], priority: "高", status: "explicit",
    });
    ok(req.ok, "②-11 客户端 A 登记需求 req-xclient-1", req.text.slice(0, 200));
    const chg = await callTool(clientA, "manage_change", {
      op: "open", project_id: xid, role: "coordinator", change_batch_id: "change-xclient-real",
      goal: "跨客户端闭环", authorized_scope: "仅隔离夹具项目", target_baseline: { design_revision: expected.design_content_sha256, plan_revision: expected.plan_content_sha256 },
      affected_subsystems: ["fixture"], exit_criteria: "两条闭环走通",
    });
    ok(chg.ok, "②-12 客户端 A 开变更批次", chg.text.slice(0, 300));
    const imp = await callTool(clientA, "import_plan_definitions", {
      project_id: xid, role: "coordinator", change_id: "change-xclient-real", bind_change_id: "change-xclient-real",
      requirement_ids: { "XC-1": ["req-xclient-1"], "XC-2": ["req-xclient-1"] },
    });
    const importedIds = (Array.isArray(asObj(imp.json).imported) ? (asObj(imp.json).imported as unknown[]) : []).map((d) => String(asObj(d).task_id));
    ok(imp.ok && importedIds.includes("XC-1") && importedIds.includes("XC-2"), `②-13 客户端 A 受检导入两张真卡（${importedIds.join("/")}）`, imp.text.slice(0, 300));

    // ── A：project_entry → claim → 施工 → 存证 → submit → 再 project_entry（取下一项） ──
    const entry1 = await callTool(clientA, "project_entry", { project_id: xid, role: "executor", client_capabilities: ["continuable"] });
    const rev1 = revisionOfReason(entry1.json, "claimable");
    steps.push({ client: "kimi-code", role: "executor", tool: "project_entry", ok: entry1.ok, next_action: nextActionOf(entry1.json), reason: firstReasonTextOf(entry1.json) });
    ok(entry1.ok && nextActionOf(entry1.json) === "claim_task" && typeof rev1 === "number", `②-14 客户端 A 的 project_entry 给出 next_action=claim_task 与 task_revision=${rev1}（理由原文：${firstReasonTextOf(entry1.json).slice(0, 90)}）`);
    const claim1 = await callTool(clientA, "claim_task", {
      project_id: xid, task_id: "XC-1", role: "executor", owner_id: "kimi-code", change_id: "change-xclient-real",
      expected_revision: rev1, workspace: path.join(xroot, ".工作台", "runs", "XC-1", "kimi"),
    });
    const claim1Json = asObj(asObj(claim1.json).claim);
    const token1 = String(claim1Json.claim_token ?? "");
    steps.push({ client: "kimi-code", role: "executor", tool: "claim_task", ok: claim1.ok && token1 !== "", next_action: null, reason: `XC-1 token=${token1.slice(0, 10)}…` });
    ok(claim1.ok && token1 !== "", "②-15 客户端 A 真 `claim_task` 成功并拿到认领 token", claim1.text.slice(0, 260));

    const entry2 = await callTool(clientA, "project_entry", { project_id: xid, role: "executor", client_capabilities: ["continuable"] });
    steps.push({ client: "kimi-code", role: "executor", tool: "project_entry", ok: entry2.ok, next_action: nextActionOf(entry2.json), reason: firstReasonTextOf(entry2.json) });
    // 认领后实体版本前进：提交要用**认领后**的版本（用认领前的 rev1 会 VERSION_CONFLICT）
    const revAfterClaim = revisionOfReason(entry2.json, "resume_available") ?? revisionInReasons(entry2.json);
    ok(
      entry2.ok && nextActionOf(entry2.json) === "resume_task" && typeof revAfterClaim === "number",
      `②-16 客户端 A 认领后再取接续 = resume_task（当前实体版本 ${revAfterClaim}；理由原文：${firstReasonTextOf(entry2.json).slice(0, 90)}）`,
    );

    // 施工：客户端 A 在项目里产出**真实产物**（真文件 + 真哈希 + 真 `node --check`）
    const art1Rel = "src/xc-1.ts";
    write(path.join(xroot, art1Rel), `const xc1 = "V09-09 跨客户端真实产物（kimi-code）";\nvoid xc1;\n`);
    const art1Sha = sha256File(path.join(xroot, art1Rel));
    const chk1 = runNodeCheck(path.join(xroot, art1Rel), art1Rel, "xc-1-node-check");
    ok(
      chk1.ok,
      `②-16b 客户端 A 对 ${art1Rel} **真跑** \`node --check\`：exit=${chk1.exit_code}（stdout/stderr/exit 原文落 raw/，未预填成功）`,
      { exit_code: chk1.exit_code, stdout: chk1.stdout.slice(0, 200), stderr: chk1.stderr.slice(0, 200), raw: chk1.raw },
    );

    // 负例（先证工具不空转）：语法坏产物真跑 node --check 非 0，且提交守卫拒绝（不预填成功）
    const badRel = "src/xc-negative-broken.ts";
    write(path.join(xroot, badRel), `const broken = (\n`);
    const badChk = runNodeCheck(path.join(xroot, badRel), badRel, "xc-negative-node-check");
    let badBlocked = false;
    try {
      requireCheckPass(badChk);
    } catch {
      badBlocked = true;
    }
    ok(
      badChk.exit_code !== 0 && badBlocked,
      `②-16c 负例：语法坏产物真跑 \`node --check\` 非 0（exit=${badChk.exit_code}）⇒ 提交守卫拒绝提交为通过`,
      { stderr: badChk.stderr.slice(0, 240) },
    );
    fs.rmSync(path.join(xroot, badRel), { force: true });

    // 真实源清单（服务端现读算哈希）→ 取回 fingerprint 作自检的版本绑定（正式引用其 hash）
    const man1 = await callTool(clientA, "record_work_evidence", {
      op: "store", project_id: xid, role: "executor", kind: "source_manifest",
      summary: "XC-1 覆盖源清单", binding: { revision_kind: "code", revision: art1Sha }, source_manifest: [art1Rel],
    });
    const man1Sha = String(asObj(asObj(man1.json).evidence).sha256 ?? "");
    const fp1 = String(asObj(asObj(asObj(man1.json).evidence).source_manifest).fingerprint ?? "");
    ok(
      man1.ok && /^[0-9a-f]{64}$/.test(man1Sha) && /^[0-9a-f]{64}$/.test(fp1),
      `②-17 客户端 A 登记**真实**源清单（服务端现读算哈希；fingerprint=${fp1.slice(0, 12)}…）`,
      man1.text.slice(0, 220),
    );

    // 自检证据：正文含**真跑**的命令/exit/stdout/stderr；版本绑定＝源清单 fingerprint（正式引用其 hash）
    const ev1 = await callTool(clientA, "record_work_evidence", {
      op: "store", project_id: xid, role: "executor", kind: "self_check",
      content:
        `产物 ${art1Rel}\nsha256=${art1Sha}\n` +
        `验证命令：${chk1.command}\nexit_code=${chk1.exit_code}\n` +
        `stdout：${chk1.stdout || "(空)"}\nstderr：${chk1.stderr || "(空)"}\n` +
        `源清单 fingerprint=${fp1}\n结论：${chk1.ok ? "通过" : "未通过"}\n`,
      summary: "XC-1 自检（真跑 node --check；含真实产物哈希）", binding: { revision_kind: "code", revision: fp1 },
    });
    const ev1Sha = String(asObj(asObj(ev1.json).evidence).sha256 ?? "");
    ok(
      ev1.ok && /^[0-9a-f]{64}$/.test(ev1Sha),
      "②-18 客户端 A 把**真跑结论**存成内容寻址证据（经唯一宿主，不可变；版本绑定＝源清单 fingerprint）",
      ev1.text.slice(0, 200),
    );

    if (!chk1.ok) {
      // 验证未过 ⇒ 依「验证失败不得继续提交为通过」**不提交**
      ok(false, `②-19 产物 ${art1Rel} node --check 未通过（exit ${chk1.exit_code}）⇒ 不提交为通过`);
    } else {
      const sub1 = await callTool(clientA, "submit_task_result", {
        project_id: xid, task_id: "XC-1", role: "executor", owner_id: "kimi-code", change_id: "change-xclient-real",
        claim_token: token1, expected_revision: revAfterClaim, deliverables: [`真实产物 ${art1Rel}`],
        evidence_refs: [ev1Sha, man1Sha],
        verification: [{ command: chk1.command, exit_code: chk1.exit_code, output_ref: chk1.output_ref }],
        untested: [], known_issues: [], result_revision: fp1,
      });
      steps.push({ client: "kimi-code", role: "executor", tool: "submit_task_result", ok: sub1.ok, next_action: nextActionOf(sub1.json), reason: firstReasonTextOf(sub1.json) });
      ok(sub1.ok && nextActionOf(sub1.json) !== null, `②-19 客户端 A 提交 XC-1 结果并**顺手读到下一动作**＝${nextActionOf(sub1.json)}`, sub1.text.slice(0, 260));
      const out1Abs = path.isAbsolute(chk1.output_ref) ? chk1.output_ref : path.join(REPO, chk1.output_ref);
      ok(
        sub1.ok && exists(out1Abs) && readIf(out1Abs).includes(`exit_code=${chk1.exit_code}`),
        `②-19b 提交里的 verification 是**真跑**值：command=\`${chk1.command}\`、exit=${chk1.exit_code}、output_ref=${chk1.output_ref}（原始输出在盘）；` +
          `证据引用＝自检 ${ev1Sha.slice(0, 12)}… ＋ 源清单 ${man1Sha.slice(0, 12)}…；result_revision＝fingerprint ${fp1.slice(0, 12)}…`,
      );
      ok(exists(path.join(xroot, art1Rel)) && sha256File(path.join(xroot, art1Rel)) === art1Sha, `②-20 真实产物在项目里可复核（${art1Rel} sha=${String(art1Sha).slice(0, 12)}…）`);
    }

    const entry3 = await callTool(clientA, "project_entry", { project_id: xid, role: "executor", client_capabilities: ["continuable"] });
    steps.push({ client: "kimi-code", role: "executor", tool: "project_entry", ok: entry3.ok, next_action: nextActionOf(entry3.json), reason: firstReasonTextOf(entry3.json) });
    ok(entry3.ok && nextActionOf(entry3.json) === "claim_task", `②-21 环回收口：客户端 A 再取 project_entry 拿到**下一项**（next_action=${nextActionOf(entry3.json)}；理由：${firstReasonTextOf(entry3.json).slice(0, 80)}）`);

    // ── B：另一条 fresh 连接、另一个角色 ──
    const selB = await callTool(clientB, "select_project", { path: xroot });
    ok(selB.ok && asObj(selB.json).id === xid, `②-22 客户端 B 用 **path 入参** select_project（另一条入参形态）→ ${String(asObj(selB.json).id)}`, selB.text.slice(0, 260));
    const entryB1 = await callTool(clientB, "project_entry", { project_id: xid, role: "coordinator", client_capabilities: ["continuable", "coordination"] });
    steps.push({ client: "claude-code", role: "coordinator", tool: "project_entry", ok: entryB1.ok, next_action: nextActionOf(entryB1.json), reason: firstReasonTextOf(entryB1.json) });
    // 校正（2026-10-08 V09-09 TS 返工）：原断言要求「A 提交 XC-1 后，**协调器**立刻读到 review_result」——
    //   与 §6.7 的**稳定次序**不符：第 7 步 claim_task（依赖/证据已满足的队列，池里还有 XC-2 可领）
    //   **先于**第 8 步 review_result。塔台此时给 claim_task 是**正确行为**，不是为了掩盖没结果。
    //   保留意图＝证明「**跨进程**能看到 A 在同一项目里已提交的结果」，改由两点真证，不弱化：
    //     (a) ②-23：此刻协调器读到 claim_task（池未清空，按设计第 7 步优先）——不是拿 blocked/await 冒充；
    //     (b) ②-23b：池清空后（B 也提交了 XC-2），同一条 fresh 连接的协调器读得 review_result，
    //         且理由原文**点名 A 的 XC-1**（另一个进程产出的结果，跨进程可见）。
    ok(entryB1.ok && nextActionOf(entryB1.json) === "claim_task", `②-23 客户端 B（协调器）跨进程接入同一项目：池里还剩 XC-2 ⇒ 按 §6.7 第 7 步（claim 先于 review）读到 next_action=${nextActionOf(entryB1.json)}（理由：${firstReasonTextOf(entryB1.json).slice(0, 90)}）`);

    const entryB2 = await callTool(clientB, "project_entry", { project_id: xid, role: "executor", client_capabilities: ["continuable"] });
    const revB = revisionOfReason(entryB2.json, "claimable");
    steps.push({ client: "claude-code", role: "executor", tool: "project_entry", ok: entryB2.ok, next_action: nextActionOf(entryB2.json), reason: firstReasonTextOf(entryB2.json) });
    ok(entryB2.ok && nextActionOf(entryB2.json) === "claim_task" && typeof revB === "number", `②-24 客户端 B（执行者）取到池里**剩下的**那一项（next_action=${nextActionOf(entryB2.json)}、revision=${revB}；理由：${firstReasonTextOf(entryB2.json).slice(0, 80)}）`);
    const claim2 = await callTool(clientB, "claim_task", {
      project_id: xid, task_id: "XC-2", role: "executor", owner_id: "claude-code", change_id: "change-xclient-real",
      expected_revision: revB, workspace: path.join(xroot, ".工作台", "runs", "XC-2", "claude"),
    });
    const token2 = String(asObj(asObj(claim2.json).claim).claim_token ?? "");
    ok(claim2.ok && token2 !== "" && token2 !== token1, "②-25 客户端 B 独立认领 XC-2（新 token ≠ A 的 token）", claim2.text.slice(0, 220));
    const entryB2b = await callTool(clientB, "project_entry", { project_id: xid, role: "executor", client_capabilities: ["continuable"] });
    steps.push({ client: "claude-code", role: "executor", tool: "project_entry", ok: entryB2b.ok, next_action: nextActionOf(entryB2b.json), reason: firstReasonTextOf(entryB2b.json) });
    const revB2 = revisionOfReason(entryB2b.json, "resume_available") ?? revisionInReasons(entryB2b.json);
    ok(entryB2b.ok && nextActionOf(entryB2b.json) === "resume_task" && typeof revB2 === "number", `②-25b 客户端 B 认领后转 resume_task（当前实体版本 ${revB2}）`);
    const art2Rel = "src/xc-2.ts";
    write(path.join(xroot, art2Rel), `const xc2 = "V09-09 跨客户端真实产物（claude-code）";\nvoid xc2;\n`);
    const art2Sha = sha256File(path.join(xroot, art2Rel));
    const chk2 = runNodeCheck(path.join(xroot, art2Rel), art2Rel, "xc-2-node-check");
    ok(
      chk2.ok,
      `②-25c 客户端 B 对 ${art2Rel} **真跑** \`node --check\`：exit=${chk2.exit_code}（原始 stdout/stderr/exit 落 raw/）`,
      { exit_code: chk2.exit_code, stdout: chk2.stdout.slice(0, 200), stderr: chk2.stderr.slice(0, 200), raw: chk2.raw },
    );
    const man2 = await callTool(clientB, "record_work_evidence", {
      op: "store", project_id: xid, role: "executor", kind: "source_manifest",
      summary: "XC-2 覆盖源清单", binding: { revision_kind: "code", revision: art2Sha }, source_manifest: [art2Rel],
    });
    const man2Sha = String(asObj(asObj(man2.json).evidence).sha256 ?? "");
    const fp2 = String(asObj(asObj(asObj(man2.json).evidence).source_manifest).fingerprint ?? "");
    ok(
      man2.ok && /^[0-9a-f]{64}$/.test(man2Sha) && /^[0-9a-f]{64}$/.test(fp2) && fp2 !== fp1,
      `②-25d 客户端 B 登记**真实**源清单（服务端现读算哈希；fingerprint=${fp2.slice(0, 12)}…≠ A 的 ${fp1.slice(0, 12)}…）`,
      man2.text.slice(0, 220),
    );
    const ev2 = await callTool(clientB, "record_work_evidence", {
      op: "store", project_id: xid, role: "executor", kind: "self_check",
      content:
        `产物 ${art2Rel}\nsha256=${art2Sha}\n` +
        `验证命令：${chk2.command}\nexit_code=${chk2.exit_code}\n` +
        `stdout：${chk2.stdout || "(空)"}\nstderr：${chk2.stderr || "(空)"}\n` +
        `源清单 fingerprint=${fp2}\n结论：${chk2.ok ? "通过" : "未通过"}\n`,
      summary: "XC-2 自检（真跑 node --check）", binding: { revision_kind: "code", revision: fp2 },
    });
    const ev2Sha = String(asObj(asObj(ev2.json).evidence).sha256 ?? "");
    if (!chk2.ok) {
      ok(false, `②-26 产物 ${art2Rel} node --check 未通过（exit ${chk2.exit_code}）⇒ 不提交为通过`);
    } else {
      const out2Abs = path.isAbsolute(chk2.output_ref) ? chk2.output_ref : path.join(REPO, chk2.output_ref);
      const sub2 = await callTool(clientB, "submit_task_result", {
        project_id: xid, task_id: "XC-2", role: "executor", owner_id: "claude-code", change_id: "change-xclient-real",
        claim_token: token2, expected_revision: revB2, deliverables: [`真实产物 ${art2Rel}`],
        evidence_refs: [ev2Sha, man2Sha],
        verification: [{ command: chk2.command, exit_code: chk2.exit_code, output_ref: chk2.output_ref }],
        untested: [], known_issues: [], result_revision: fp2,
      });
      steps.push({ client: "claude-code", role: "executor", tool: "submit_task_result", ok: sub2.ok, next_action: nextActionOf(sub2.json), reason: firstReasonTextOf(sub2.json) });
      ok(
        sub2.ok && ev2Sha !== "" && ev2Sha !== ev1Sha && exists(out2Abs),
        `②-26 客户端 B 独立存证并提交 XC-2（自检 ${ev2Sha.slice(0, 12)}…、源清单 ${man2Sha.slice(0, 12)}…；真跑 exit=${chk2.exit_code}；下一动作 ${nextActionOf(sub2.json)}）`,
        sub2.text.slice(0, 220),
      );
    }

    const entryB3 = await callTool(clientB, "project_entry", { project_id: xid, role: "coordinator", client_capabilities: ["continuable", "coordination"] });
    steps.push({ client: "claude-code", role: "coordinator", tool: "project_entry", ok: entryB3.ok, next_action: nextActionOf(entryB3.json), reason: firstReasonTextOf(entryB3.json) });
    // ②-23b（见 ②-23 的校正说明）：池清空后，B（另一进程）的协调器读到 **A 提交的 XC-1** 待审——
    //   理由原文点名 XC-1 ⇒ 跨进程可见（不是本连接内存、也不是把 blocked/await 冒充 review）。
    const reviewReasonB3 = reasonTextsOf(entryB3.json).find((t) => /XC-1/.test(t)) ?? "";
    ok(
      entryB3.ok && nextActionOf(entryB3.json) === "review_result" && reviewReasonB3 !== "",
      `②-23b 池清空后 B（另一进程）的协调器读到 **A 提交的 XC-1** 待审 ⇒ next_action=${nextActionOf(entryB3.json)}（跨进程可见：理由原文点名 XC-1：${reviewReasonB3.slice(0, 140) || "(未点名)"}）`,
    );
    const entryB4 = await callTool(clientB, "project_entry", { project_id: xid, role: "executor", client_capabilities: ["continuable"] });
    steps.push({ client: "claude-code", role: "executor", tool: "project_entry", ok: entryB4.ok, next_action: nextActionOf(entryB4.json), reason: firstReasonTextOf(entryB4.json) });
    ok(entryB4.ok && nextActionOf(entryB4.json) !== "claim_task", `②-27 池已清空：执行者视角不再派新领（next_action=${nextActionOf(entryB4.json)}；理由：${firstReasonTextOf(entryB4.json).slice(0, 80)}）`);

    // ── 第三条 fresh 连接：断连重连后事实仍在（唯一宿主持久化，不是内存态） ──
    await clientA.close();
    clientA = null;
    clientC = await connectMcpClient("kimi-code-restart");
    closes.push(async () => { if (clientC !== null) await clientC.close(); });
    const entryC = await callTool(clientC, "project_entry", { project_id: xid, role: "executor", client_capabilities: ["continuable"] });
    steps.push({ client: "kimi-code-restart", role: "executor", tool: "project_entry", ok: entryC.ok, next_action: nextActionOf(entryC.json), reason: firstReasonTextOf(entryC.json) });
    ok(entryC.ok && nextActionOf(entryC.json) === nextActionOf(entryB4.json), `②-28 第三条 fresh 连接（A 断开后新起）读到**同一个** next_action=${nextActionOf(entryC.json)}（事实落在唯一宿主，不是连接内存）`);

    const distinct = new Set(steps.map((s) => s.next_action).filter((a): a is string => a !== null));
    for (const need of ["claim_task", "resume_task", "review_result"]) {
      ok(distinct.has(need), `②-29 next_action 分支 **${need}** 由真客户端现场取到（共 ${distinct.size} 种：${[...distinct].join("/")}）`);
    }
    ok(
      steps.length >= 10 && steps.every((s) => s.reason !== ""),
      `②-30 每个取到的 next_action 都留了**理由原文**（${steps.length} 步；未触发＝${want.filter((w) => !distinct.has(w as never)).join("/") || "无"}，不编造）`,
    );
    info(`  跨客户端旅程步数 ${steps.length}；两个 fresh 客户端（kimi-code/claude-code）+ 第三条重连客户端；真实产物 ${art1Rel}／${art2Rel} 在项目内`);
    info(`  仍未被现场触发的 next_action 分支：${want.filter((w) => !distinct.has(w as never)).join("/") || "（无）"}`);

    // ── 真实项目 tatai：真客户端**只读**取一次（如实记 blocked 与理由原文） ──
    const realEntry = await callTool(clientC, "project_entry", { project_id: "tatai", role: "executor", client_capabilities: ["continuable"] });
    ok(
      realEntry.ok && nextActionOf(realEntry.json) !== null,
      `②-31 真实项目 tatai 用真客户端只读取接续（next_action=${nextActionOf(realEntry.json)}；理由原文：${firstReasonTextOf(realEntry.json).slice(0, 100)}）`,
    );
    const realCoord = await callTool(clientC, "project_entry", { project_id: "tatai", role: "coordinator", client_capabilities: ["continuable", "coordination"] });
    ok(
      realCoord.ok && nextActionOf(realCoord.json) === nextActionOf(realEntry.json),
      `②-32 真项目逐角色读数一致（executor=${nextActionOf(realEntry.json)}／coordinator=${nextActionOf(realCoord.json)}）——项目当前被基线源变更/同步批次/证据缺口阻断，读口如实报，不编造分支`,
    );
    // 真实账本「本 attempt 零写入」自证：并发写作者存在时按**新增事件**判（见 realLedgerZeroLeak 说明），
    //   并用 ②-33b 正向对照证明夹具写事实落在**隔离项目**账本里，而不是真实账本。
    const leak33 = realLedgerZeroLeak(ledgerShaIn2, ledgerShaIn2Text, realLedger);
    ok(leak33.ok, `②-33 本节全程**没写**真实 tatai 事件账本（${leak33.note}）`, leak33.leaked);
    const isoLedger = path.join(xroot, ".工作台", "work", "events.jsonl");
    const isoText = readIf(isoLedger);
    ok(
      exists(isoLedger) && isoText.includes("XC-1") && isoText.includes("change-xclient-real"),
      `②-33b 正向对照：本轮写事实确实落在**隔离项目**账本里（${path.relative(TMP, isoLedger)} 含 XC-1/change-xclient-real），不是真实账本`,
    );
    raw.section2_real_project = {
      executor: { next_action: nextActionOf(realEntry.json), reason: firstReasonTextOf(realEntry.json) },
      coordinator: { next_action: nextActionOf(realCoord.json), reason: firstReasonTextOf(realCoord.json) },
    };

    // ── v1 未迁移项目过渡接法（§6.6）：真客户端再跑一次 ──
    const v1Root = path.join(TMP, "v1proj");
    write(path.join(v1Root, ".工作台", "tasks.json"), JSON.stringify({ version: 1, tasks: [{ id: "T-1", title: "v1 夹具任务", status: "todo" }] }, null, 2));
    write(path.join(v1Root, ".工作台", "progress.json"), JSON.stringify({ current_step: "夹具", history: [] }, null, 2));
    write(path.join(v1Root, ".工作台", "design.md"), "# v1 夹具设计书\n\n## 1 目标\n");
    const v1id = "v0909-v1";
    addProject({ id: v1id, name: "v1 夹具", path: v1Root, kind: "backend" }, HOME);
    const v1entry = await callTool(clientC, "project_entry", { project_id: v1id, role: "executor", client_capabilities: ["continuable"] });
    ok(
      v1entry.ok && nextActionOf(v1entry.json) !== null && want.includes(String(nextActionOf(v1entry.json))) && !exists(path.join(v1Root, ".工作台", "work", "events.jsonl")),
      `②-34 未迁移项目（无事件账本）经真客户端走 §6.6 过渡接法也拿得到接续动作（next_action=${nextActionOf(v1entry.json)}），且**没有**被悄悄迁成 v2（仍无 events.jsonl）`,
    );
    ok(
      nextActionOf(v1entry.json) !== nextActionOf(entryC.json),
      `②-35 两条路都没断：v1 项目 ${nextActionOf(v1entry.json)} ≠ 隔离 v2 项目 ${nextActionOf(entryC.json)}`,
    );

    raw.section2 = {
      contract: want,
      isolated_project: { id: xid, root: xroot, plan_cards: ["XC-1", "XC-2"] },
      host: { port: desc.port, pid: desc.pid, unique_writer: true },
      clients: ["kimi-code", "claude-code", "kimi-code-restart"],
      steps,
      branch_values: [...distinct],
      not_triggered: want.filter((w) => !distinct.has(w as never)),
      artifacts: { "src/xc-1.ts": art1Sha, "src/xc-2.ts": art2Sha },
      node_check: {
        "XC-1": { command: chk1.command, exit_code: chk1.exit_code, output_ref: chk1.output_ref, raw: chk1.raw, manifest_sha256: man1Sha, fingerprint: fp1, self_check_sha256: ev1Sha },
        "XC-2": { command: chk2.command, exit_code: chk2.exit_code, output_ref: chk2.output_ref, raw: chk2.raw, manifest_sha256: man2Sha, fingerprint: fp2, self_check_sha256: ev2Sha },
        negative: { command: badChk.command, exit_code: badChk.exit_code, blocked: badBlocked, raw: badChk.raw },
      },
      v1_transition: { next_action: nextActionOf(v1entry.json), reason: firstReasonTextOf(v1entry.json), ledger_created: false },
    };
  } catch (err) {
    ok(false, `② 跨客户端旅程异常：${(err as Error).message}`);
    info(`  宿主日志尾部：${hostLogs.join("").slice(-600)}`);
  } finally {
    for (const c of closes) {
      try {
        await c();
      } catch {
        /* 已关 */
      }
    }
    try {
      host.kill();
      await sleep(300);
    } catch {
      /* 已退出 */
    }
  }
}

// ═══════════════════ ③ 正反追踪 + 覆盖表全表对账 ═══════════════════

type CoverageRow = { 覆盖项: string; 来源: string; 设计依据: string; 承接卡: string; 判据: string; 状态: string };

function parseCoverageTable(planText: string): CoverageRow[] {
  const lines = planText.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes("需求→设计→任务→验收覆盖表"));
  if (start < 0) return [];
  const rows: CoverageRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim().startsWith("|")) continue;
    const cells = l.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    if (cells[0].startsWith("---") || cells[0] === "覆盖项") continue;
    rows.push({ 覆盖项: cells[0], 来源: cells[1], 设计依据: cells[2], 承接卡: cells[3], 判据: cells[4], 状态: cells[5] });
  }
  return rows;
}

function section3(): void {
  section("③ 需求→设计→任务→证据 正反追踪 + 覆盖表全表对账");
  const workDir = path.join(REPO, ".工作台", "work");
  const reqs = readRequirements(workDir);
  const planText = readIf(path.join(REPO, "PLAN.md"));
  const designText = readIf(path.join(REPO, "DESIGN.md"));

  // 需求映射（受检导入口径）：承接卡 → requirement_ids
  const defs = importTaskDefinitions(planText).definitions;
  const byCard = new Map<string, string[]>();
  for (const d of defs) byCard.set(d.task_id, [...(d.requirement_ids ?? [])]);

  // ── 正向链：req-2026-09-24-g3 → §3.2/§11.2 → V09-11 → 证据 ──
  const g3 = reqs.requirements["req-2026-09-24-g3"];
  const designHas = designText.includes("### 3.2") || designText.includes("§11.2") || designText.includes("11.2");
  const cardHas = (byCard.get("V09-11") ?? []).includes("req-2026-09-24-g3");
  const evDir = path.join(REPO, ".工作台", "evidence", "V09-11", "1");
  const evFiles = exists(evDir) ? fs.readdirSync(evDir) : [];
  ok(g3 !== undefined && g3.seq > 0, `③-1 正向①：需求 req-2026-09-24-g3 已登记可读回（账本 seq ${g3?.seq}，状态 ${g3?.status_label}）`);
  ok(designHas, "③-2 正向②：设计依据可回查（DESIGN.md 有 §3.2／§11.2 正文）");
  ok(cardHas, `③-3 正向③：承接卡 V09-11 的任务定义带 requirement_ids=${JSON.stringify(byCard.get("V09-11") ?? [])}（含 g3）`);
  ok(evFiles.length > 0, `③-4 正向④：结果/证据入口在盘上（.工作台/evidence/V09-11/1/ 共 ${evFiles.length} 项）`);

  // ── 反向链：V09-11 证据 → 满足哪条需求 → 哪条设计依据 ──
  const backReq = (byCard.get("V09-11") ?? []).find((r) => r === "req-2026-09-24-g3");
  const backDesign = designText.includes("§11.2");
  ok(
    backReq === "req-2026-09-24-g3" && backDesign,
    "③-5 反向：从 V09-11 的证据入口反查 ⇒ 满足需求 req-2026-09-24-g3、设计依据 §11.2（链闭合）",
  );

  // ── 反例：链上缺环 ⇒ 如实报缺，不静默补全 ──
  const missingCardReqs = ["req-2026-09-24-g3"].filter(() => !(byCard.get("不存在的卡") ?? []).includes("req-2026-09-24-g3"));
  const fabricated = missingCardReqs.length === 0;
  ok(
    !fabricated && (byCard.get("不存在的卡") ?? []).length === 0,
    "③-6 反例：一条链缺「承接卡」这一环时，机械对账**报缺**（未知卡无 requirement_ids，不静默补全、不编造承接）",
  );
  // 定向更新（V09-21 R5，2026-09-27，五要素留档）：钉死「此刻被阻断」单一态 → **同源蕴含式**。
  //   旧期望＝钉死「`!deliverable_allowed && unmet > 0`」这一**单一态**（当时真实项目恰好被阻断）。
  //   依据＝那是基线重激活前的时点快照：本轮 bl-f9ec9718-a5692622 重激活后全项目证据「旧绿转待验证」，
  //          同一断言在别的时刻（全部证据有效时）翻面成红——钉死单一态＝拿时点快照自证
  //          （V09-18 裁定 8 禁止；DESIGN §4.2「颜色/结论由事实派生」）。
  //   新期望＝**同源蕴含式**（读数是什么就核什么）：缺口（未映射/未验证/缺证/证据失效 > 0，即
  //          `BLOCKING_EVIDENCE_STATES` ＋未映射——比任务书列的 unmapped/missing/invalidated 更完整）
  //          ⇒ `verdict="blocked"` ＋ `deliverable_allowed=false` ＋ `reasons` **逐条点名到对象**；
  //          全零 ⇒ `requestable` ＋ `reasons=0`；「有阻断却不点名」「没阻断却留空阻断」两头都判红。
  //   保留意图＝原断言守的是真实读口「**如实报缺、不静默补全**」这件事可被机械读出（DESIGN §3.2／§4.2）。
  //   判据不放宽＝缺口存在时依旧必须 blocked ＋逐条点名；另外多加两条同源不变量
  //          （`deliverable_allowed === (verdict === "requestable")`、`blocked ⇒ reasons 非空且逐条点名`），
  //          `verdict="none"` 只认读口自身的「不空集判绿」（对象数 0），任一不满足逐条判红。
  const prov = archProvenanceModelOf("tatai", { dataDir: HOME });
  const d = prov.delivery;
  const unmet = d.reasons.length;
  const dc = d.counts;
  const gapCount = dc.unmapped + dc.unverified + dc.missing + dc.invalidated;
  const namedReasons = d.reasons.length > 0 && d.reasons.every((r) => /（[^）]+）/.test(r));
  const coherent =
    d.conclusion !== "" &&
    d.deliverable_allowed === (d.verdict === "requestable") &&
    (d.verdict === "requestable"
      ? d.deliverable_allowed && d.reasons.length === 0
      : d.verdict === "blocked"
        ? !d.deliverable_allowed && namedReasons
        : d.verdict === "none" && !d.deliverable_allowed && dc.objects === 0);
  ok(
    coherent && (gapCount === 0 || d.verdict === "blocked"),
    `③-7 真实读口如实报缺（同源蕴含式，不钉单一态）：当前 verdict=${d.verdict}、缺口 ${gapCount} 条` +
      `（未映射 ${dc.unmapped} / 未验证 ${dc.unverified} / 缺证 ${dc.missing} / 证据失效 ${dc.invalidated}）、` +
      `逐条点名 ${unmet} 条 ⇒ ` +
      (gapCount > 0
        ? "有缺口必须 blocked＋逐条点名（已核）"
        : d.verdict === "requestable"
          ? "无缺口无理由 ⇒ requestable＋reasons=0（已核）"
          : "无计数缺口但仍有理由（如画布缺口）⇒ 仍须 blocked＋逐条点名（已核）") +
      `；结论「${d.conclusion}」`,
  );

  // ── 覆盖表全表对账 ──
  const rows = parseCoverageTable(planText);
  ok(rows.length >= 20, `③-8 PLAN 文末覆盖表可机械解析：${rows.length} 行`);
  const GAP = ["未施工", "待对账", "未开工", "证据未闭合", "尚未登记", "未登记", "待开工"];
  const gRows = rows.filter((r) => /G-\d/.test(r.覆盖项));
  ok(gRows.length === 6, `③-9 覆盖表 G-1…G-6 六行齐全（${gRows.map((r) => (r.覆盖项.match(/G-\d/)?.[0] ?? "?")).join("/")}）`);
  const ledgerEvents = loadEvents(workDir).events;
  const registeredEvents = ledgerEvents.filter((e) => String(e.type) === "requirement.registered");
  const gSeq = gRows.map((r) => {
    const idMatch = r.覆盖项.match(/req-2026-09-24-g\d/);
    const st = idMatch ? reqs.requirements[idMatch[0]] : undefined;
    return { row: r.覆盖项.match(/G-\d/)?.[0], id: idMatch?.[0] ?? null, seq: st?.seq ?? null, status: r.状态 };
  });
  const seqs = gSeq.map((g) => g.seq).filter((s): s is number => typeof s === "number");
  ok(
    seqs.length === 6 && Math.min(...seqs) === 808 && Math.max(...seqs) === 813,
    `③-10 G-1…G-6 在账本均为正规登记（req-2026-09-24-g1…g6，seq ${seqs.sort((a, b) => a - b).join(",")}；requirement.registered 事件 ${registeredEvents.length} 条）`,
  );
  const openG = gRows.filter((r) => GAP.some((m) => r.状态.includes(m)));
  info(`  如实列缺：覆盖表带缺口的行 ${openG.length} 行（${openG.map((r) => r.覆盖项.match(/G-\d/)?.[0]).join("/") || "无"}）`);
  raw.section3 = { g3_seq: g3?.seq ?? null, forward_closed: designHas && cardHas && evFiles.length > 0, coverage_rows: rows.length, g_seq: gSeq, unmet_reasons: unmet };
  fs.writeFileSync(
    artifact("coverage-table.json"),
    JSON.stringify({ generated_at: new Date().toISOString(), rows, g_seq: gSeq, table_rows: rows.length, gap_rows: openG.length }, null, 2) + "\n",
    "utf8",
  );
  ok(exists(artifact("coverage-table.json")), "③-11 覆盖表逐行对账读数落盘（coverage-table.json）");
}

// ═══════════════════ ④ 备份/恢复隔离演练（真跑） ═══════════════════

async function section4(): Promise<void> {
  section("④ 备份/恢复隔离演练（真跑 + V06-14 两类反证）");
  // 复用 V06-14 的备份语义模块；夹具在临时目录，真实数据零接触
  const { WorkService } = await import("../src/server/work/service");
  const { importTaskDefinitions: mport, taskDefinitionHash } = await import("../src/server/work/plan");
  const { submitDefinitionImports, submitTaskStatus } = await import("../src/server/work/tasks");
  const { putEvidence } = await import("../src/server/work/evidence");
  const { activateBaseline, WORKBENCH_DIRNAME } = await import("../src/server/work/documents");
  const { submitSubmission } = await import("../src/server/work/audit");
  const { verifyBackup, backupRoot } = await import("../src/server/work/backup");
  const { createBackupEntry, restoreBackupEntry, inspectBackupEntry, isBackupEntryError } = await import("../src/server/work/backupEntry");

  const D = path.join(TMP, "backup-home");
  fs.mkdirSync(D, { recursive: true });
  const id = "v0909-backup";
  const root = path.join(TMP, "backup-proj");
  fs.mkdirSync(path.join(root, WORKBENCH_DIRNAME), { recursive: true });
  const PLAN_TEXT = [
    "# V09-09 备份夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| B-1 | todo | 一致备份的提交边界 | | B-1 证据 |",
    "",
    "### B-1 一致备份的提交边界",
    "",
    "**设计依据**：§8.5。**文件责任**：`.工作台/**`。",
    "",
    "- [ ] 备份是某个提交序号的一致切片",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(root, WORKBENCH_DIRNAME, "design.md"), "# V09-09 备份夹具设计书\n\n## 1 目标\n\n备份/恢复隔离演练。\n", "utf8");
  fs.writeFileSync(path.join(root, WORKBENCH_DIRNAME, "plan.md"), PLAN_TEXT, "utf8");
  fs.mkdirSync(path.join(root, WORKBENCH_DIRNAME, "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, WORKBENCH_DIRNAME, "logs", "terminal-history.jsonl"), '{"cmd":"pnpm build"}\n', "utf8");
  addProject({ id, name: "V09-09 备份夹具", path: root, kind: "backend" }, D);

  const service = new WorkService({ dataDir: D });
  const submit = { submit: (c: unknown) => service.submit(c as never) };
  const defs = mport(PLAN_TEXT).definitions;
  submitDefinitionImports(submit as never, { project_id: id, change_id: "chg-v0909", actor_id: "fx", role: "executor", definitions: defs });
  const ev = putEvidence(projectWorkDir(id, D), {
    content: "自检命令：pnpm typecheck\nexit_code=0\n结论：通过\n",
    kind: "self_check",
    summary: "夹具自检",
    created_by: "fx",
    role: "executor",
    binding: { revision_kind: "code", revision: "rev-a" },
  });
  submitTaskStatus(submit as never, {
    project_id: id,
    task_id: "B-1",
    change_id: "chg-v0909",
    actor_id: "fx",
    role: "executor",
    expected_revision: 1,
    status: "executing",
    definition: { definition_sha256: taskDefinitionHash(defs[0]), plan_revision: defs[0].plan_revision ?? "" },
  } as never);
  const baseline = activateBaseline(id, { approved_by: "fx-reviewer", approval_basis: "夹具技术审定", approval_kind: "delegated_technical_review" }, D);
  submitSubmission(submit as never, {
    record_id: "sub-v0909-B-1",
    project_id: id,
    change_id: "chg-v0909",
    actor_id: "fx",
    role: "executor",
    goal: "一致备份的提交边界（夹具）",
    task_id: "B-1",
    changed_files: ["src/server/work/backup.ts"],
    commands: [],
    untested: [],
    known_issues: [],
    evidence_refs: [ev.evidence_id],
    binding: { revision_kind: "code", revision: "rev-a" },
    baseline: {
      baseline_id: baseline.baseline.baseline_id,
      design_revision: baseline.baseline.design_revision.content_sha256,
      plan_revision: baseline.baseline.plan_revision.definition_sha256,
    },
    submitted_by: "fx",
  } as never);

  const created = createBackupEntry(id, { dataDir: D, now: "2026-09-25T02:00:00+08:00" });
  ok(created.verification.ok, `④-1 真跑备份：${created.backup_id}（清单可读、八条核验通过；证据 ${created.manifest.counts.evidence} 份）`);
  const restored = restoreBackupEntry(id, created.backup_id, { dataDir: D });
  const facts = restored.report.facts;
  ok(restored.replaced === false && restored.replace_requires_user === true, "④-2 隔离恢复：replaced=false、替换仍由用户决定");
  ok(
    restored.report.ok && (facts?.documents_recovered.length ?? 0) > 0 && facts!.documents_recovered.every((d) => /^[0-9a-f]{64}$/.test(d.sha256)),
    `④-3 重放核验：恢复报告 ok=true，原文可定位且哈希相符（${facts?.documents_recovered.length ?? 0} 份图纸）`,
  );
  ok(
    (facts?.evidence_hash_checked.length ?? 0) > 0 && facts!.evidence_hash_checked.every((e) => e.sha256 === e.evidence_id),
    `④-4 证据哈希相符：${facts?.evidence_hash_checked.length ?? 0} 份内容寻址证据逐份复核`,
  );
  ok(
    (facts?.events_replayed ?? 0) > 0 && exists(facts?.cache_rebuilt.state_path ?? ""),
    `④-5 隔离目录里清单与事件可读、事件可重放、缓存可重建（replay ${facts?.events_replayed ?? 0} 条，截止 seq ${facts?.cache_rebuilt.last_seq ?? "?"}）`,
  );

  // 两类反证（V06-14）：跨时刻拼接 + 裸目录副本 ⇒ 仍判不合格
  const srcDir = path.join(backupRoot(D, id), created.backup_id);
  const clone = (as: string): string => {
    const dest = path.join(backupRoot(D, id), as);
    fs.cpSync(srcDir, dest, { recursive: true });
    return dest;
  };
  // 反证 A：跨时刻拼接（换更晚的事件正文并同步改清单哈希）
  const mixedId = "b-00000099-aaaaaaaaaaaa";
  const mixedDir = clone(mixedId);
  const mixedManifest = JSON.parse(fs.readFileSync(path.join(mixedDir, "backup-manifest.json"), "utf8")) as {
    sources: { rel_path: string; sha256: string; bytes: number }[];
  };
  const liveEvents = fs.readFileSync(path.join(root, WORKBENCH_DIRNAME, "work", "events.jsonl"));
  fs.writeFileSync(path.join(mixedDir, "workbench", "work", "events.jsonl"), liveEvents);
  const evEntry = mixedManifest.sources.find((s) => s.rel_path === "work/events.jsonl");
  if (evEntry) {
    evEntry.sha256 = sha256Text(liveEvents.toString("utf8"));
    evEntry.bytes = liveEvents.length;
  }
  fs.writeFileSync(path.join(mixedDir, "backup-manifest.json"), JSON.stringify(mixedManifest), "utf8");
  // 事后多塞一份**没进清单**的证据正文（v06-14 反证 A 的另一半）
  fs.mkdirSync(path.join(mixedDir, "workbench", "work", "evidence"), { recursive: true });
  fs.writeFileSync(
    path.join(mixedDir, "workbench", "work", "evidence", `${"f".repeat(64)}.json`),
    JSON.stringify({ evidence_id: "f".repeat(64), content_sha256: "f".repeat(64), content: "事后塞进来的一份\n" }) + "\n",
    "utf8",
  );
  const mixedVerdict = verifyBackup(mixedDir);
  ok(!mixedVerdict.ok && mixedVerdict.failures.length > 0, `④-6 反证 A（跨时刻拼接）仍判**不合格**：${mixedVerdict.failures.map((f) => f.code).join("、")}`);
  ok(verifyBackup(srcDir).ok, "④-7 反证 A 复算：原始那一份仍**合格**（不是哈希对不上，是拼接出来的不是一致切片）");
  // 反证 B：裸目录副本（没有清单）
  const bareId = "b-00000098-bbbbbbbbbbbb";
  const bareDir = path.join(backupRoot(D, id), bareId);
  fs.cpSync(path.join(srcDir, "workbench"), bareDir, { recursive: true });
  let bareCode = "";
  try {
    inspectBackupEntry(id, bareId, { dataDir: D });
  } catch (e) {
    bareCode = isBackupEntryError(e) ? e.code : `(${(e as Error).name})`;
  }
  ok(bareCode === "BACKUP_SOURCE_CORRUPT", `④-8 反证 B（裸目录副本，无清单）仍判**不合格**（抛 ${bareCode || "(没抛)"}，不是正常空态）`);

  const drill = {
    generated_at: new Date().toISOString(),
    reused_v09_06: "src/server/work/backup.ts / backupEntry.ts（V06-14/V09-06 语义，本卡只跑不改）",
    backup_id: created.backup_id,
    manifest: created.manifest,
    restore: { dest_root: restored.dest_root, replaced: restored.replaced, facts },
    counterexamples: { splice: mixedVerdict.failures.map((f) => f.code), bare_copy: bareCode },
  };
  fs.writeFileSync(artifact("backup-drill.json"), JSON.stringify(drill, null, 2) + "\n", "utf8");
  ok(exists(artifact("backup-drill.json")) && exists(artifact("04-备份恢复演练.md")), "④-9 演练记录与读数落盘（04-备份恢复演练.md + backup-drill.json）");
  raw.section4 = { backup_id: created.backup_id, restored_replaced: restored.replaced, splice_codes: mixedVerdict.failures.map((f) => f.code), bare_code: bareCode };
}

// ═══════ ⑤ 安装/卸载真机（**当前包**绑定；未绑定＝如实 PENDING，不拿旧演练充数） ═══════

/**
 * 判据收紧（2026-10-08 v0909-final-review；不是「只改文字遮盖」）：
 *   旧行为（v0909-real）＝读固定 `install-uninstall.json`（**0.1.0 旧包**的 2026-09-25 演练），
 *   逐字段断言 exit_code/秒数/survived/reinstalled 全过 ⇒ ⑤-4…⑤-7 **拿旧版记录记了 PASS**，
 *   只在旁边打印一句 `bound_to_current=false`。这等于「文件存在就算当前包通过」。
 *   现行判据＝⑤ 的通过必须**绑定盘上当前安装包**（记录里的 `package.nsis_sha256` ＝ 当前包 sha256）：
 *     · 历史记录只作历史，**单独报**（不再计入 PASS）；
 *     · 当前包记录走**唯一输入接口** `install-uninstall-current.json`（与历史同 schema，另加 `package.nsis_sha256`
 *       必须等于盘上当前包 sha）；缺它 ⇒ 如实 **PENDING**（未验证），并把它写进 raw 与报告，不冒充通过；
 *     · 给了记录但 sha 对不上 / exit_code≠0 / 未装回 ⇒ **FAIL**（不静默）。
 *   为什么不能在本次直接做：真装/卸会动用户桌面现场（`塔台.lnk`、注册表），且必须在 root 用**当前源码**
 *   重打包之后跑——本 attempt 的写域与授权都不含安装动作（任务书：root 最终新包安装负责）。
 */
interface InstallDrillRecord {
  at?: string;
  package?: { nsis?: string; nsis_bytes?: number; nsis_sha256?: string; msi?: string };
  before: { installed: boolean; desktop_shortcut: string | null; uninstall_registry: string[] };
  install: { exit_code: number; seconds: number; install_dir: string | null; shortcut_created: boolean };
  cold_start: { exit_code: number; reachable: boolean };
  uninstall: { exit_code: number; seconds: number; residual_paths: string[] };
  user_data_survived: { registry_sha_before: string; registry_sha_after: string; survived: boolean };
  reinstalled: boolean;
}

function section5(): void {
  section("⑤ 安装/卸载真机（当前包绑定；未绑定＝PENDING）");
  const installer = path.join(REPO, "src-tauri", "target", "release", "bundle", "nsis", `Tatai_${APP_VERSION}_x64-setup.exe`);
  const msi = path.join(REPO, "src-tauri", "target", "release", "bundle", "msi", `Tatai_${APP_VERSION}_x64_en-US.msi`);
  ok(exists(installer), `⑤-1 当前版本的安装包在盘上：${path.relative(REPO, installer)}（${exists(installer) ? fs.statSync(installer).size : "?"} B）`);
  ok(exists(msi), `⑤-2 当前版本的 MSI 同目录在盘上（${exists(msi) ? fs.statSync(msi).size : "?"} B）`);
  const curNsisSha = sha256File(installer);

  const hist = readJson<InstallDrillRecord>(artifact("install-uninstall.json"));
  const histSha = hist?.package?.nsis_sha256 ?? null;
  if (hist !== null) {
    const histBound = histSha !== null && curNsisSha !== null && histSha === curNsisSha;
    info(
      `  历史记录（**只作历史**）：${hist.at ?? "?"} 的 ${hist.package?.nsis ?? "?"}（sha ${histSha?.slice(0, 12) ?? "?"}…）；` +
        `盘上当前包 sha ${curNsisSha?.slice(0, 12) ?? "?"}… ⇒ ${histBound ? "恰好同包（其适用性可采信）" : "不是当前包（仅在册）"}`,
    );
    // 校正（2026-10-08 V09-09 TS 返工）：旧断言 `ok(!histBound, ...)` 把「历史包 sha ≠ 盘上当前包 sha」
    //   当成**必须通过的产品条件**——这是不合理断言：历史恰好与当前包同 sha 时（同产物），其适用性本就
    //   该被采信，不该判红。保留的硬要求**全部**留在下面 ⑤-4…⑤-8：当前包记录必须与盘上包**同 sha**
    //   （严格匹配），且静默真装 / 冷启动可达 / 卸载 / 用户数据保留 / 装回齐备。历史记录只在册、不单独当判据。
    ok(histSha !== null, `⑤-3 历史装卸记录在册可读（只作历史；sha 同/不同都不单独作为当前包是否通过的判据——当前包由 ⑤-4…⑤-8 严格判；本机历史${histBound ? "恰好同包、适用性可采信" : "与当前包不同包"}）`);
  } else {
    ok(false, "⑤-3 历史装卸记录 install-uninstall.json 不在册（历史证据缺失，如实报缺）");
  }

  const cur = readJson<InstallDrillRecord>(artifact("install-uninstall-current.json"));
  if (cur === null) {
    pending(
      "⑤-4 当前安装包的真机装卸（装 → 冷启动 → 卸载 → 残留比对 → 装回）",
      `未提供当前包记录 ${path.relative(REPO, artifact("install-uninstall-current.json"))}——` +
        `历史记录是 ${hist?.package?.nsis ?? "0.1.0"} 旧包（sha ${histSha?.slice(0, 12) ?? "?"}…），` +
        `盘上当前包是 ${path.basename(installer)}（sha ${curNsisSha?.slice(0, 12) ?? "?"}…），两者不等，旧演练**不能证明当前包**。` +
        "由 root 用当前源码重打包 → 真装 → 冷启动 → 卸载 → 残留比对 → 装回后，把同 schema 记录（package.nsis_sha256 必须等于当前包 sha）写到该路径再复跑本套件。",
    );
    raw.section5 = {
      historical: hist,
      current: null,
      current_nsis_sha256: curNsisSha,
      bound_to_current: false,
      state: "pending",
      input_interface: "install-uninstall-current.json",
    };
    return;
  }
  const curSha = cur.package?.nsis_sha256 ?? null;
  const boundToCurrent = curSha !== null && curNsisSha !== null && curSha === curNsisSha;
  ok(boundToCurrent, `⑤-4 当前包记录与盘上包**同 sha**（记录 ${curSha?.slice(0, 12) ?? "?"}… ＝ 盘上 ${curNsisSha?.slice(0, 12) ?? "?"}…）`);
  ok(cur.install.exit_code === 0 && cur.install.seconds > 0 && cur.cold_start.exit_code === 0 && cur.cold_start.reachable, `⑤-5 静默真装 + 冷启动成功（装 ${cur.install.seconds}s、冷启动 exit ${cur.cold_start.exit_code}、可达 ${cur.cold_start.reachable}）`);
  ok(cur.uninstall.exit_code === 0 && cur.uninstall.seconds > 0, `⑤-6 真卸载完成（${cur.uninstall.seconds}s；残留 ${cur.uninstall.residual_paths.join("；") || "无"}）`);
  ok(cur.user_data_survived.survived && cur.user_data_survived.registry_sha_before === cur.user_data_survived.registry_sha_after, "⑤-7 用户数据目录（~/.tatai）未被卸载碰（首尾 sha256 一致）");
  ok(cur.reinstalled, "⑤-8 演练结束已**重新装回**当前包（用户桌面保留可工作的新版）");
  raw.section5 = {
    historical: hist,
    current: cur,
    current_nsis_sha256: curNsisSha,
    bound_to_current: true,
    state: "verified",
    input_interface: "install-uninstall-current.json",
  };
}

// ═══════════════════ ⑥ 文档/状态/蓝图三方同步 ═══════════════════

async function section6(): Promise<void> {
  section("⑥ 文档 / 状态 / 蓝图三方同步抽查");  const designText = readIf(path.join(REPO, "DESIGN.md"));
  ok(
    designText.includes("附录 E") && designText.includes("附录 G") && designText.includes("v2 证据派生") && designText.includes("无状态记录"),
    "⑥-1 DESIGN 附录 E/G 口径在场（含「v2 证据派生」「无状态记录」标准措辞）",
  );
  const bp = readBlueprint("tatai", HOME);
  ok(bp !== null && bp.publish.published === true, `⑥-2 蓝图已发布（baseline ${bp?.baseline_id}、生成 ${bp?.generated_at}）`);
  const active = activeBaseline("tatai", HOME);
  ok(bp !== null && active !== null && bp.baseline_id === active.baseline_id, `⑥-3 图新鲜度：蓝图绑定**当前有效基线**（${bp?.baseline_id} = ${active?.baseline_id}）`);
  const designHash = sha256Text(designText);
  ok(bp !== null && bp.based_on.design_content_sha256 === designHash, `⑥-4 图新鲜度：蓝图的设计内容哈希与盘上 DESIGN.md 一致（${designHash.slice(0, 12)}…，未过期）`);

  const archRes = await getArchTool.handler({ project_id: "tatai" });
  const archJson = JSON.parse(archRes.content[0].text) as {
    module_status_source?: string;
    data_flow?: { current_implementation?: unknown; target_semantics?: unknown };
    provenance?: { delivery?: { verdict?: string } };
  };
  ok(archJson.module_status_source === "v2_evidence", "⑥-5 运行服务读口 get_arch 的模块状态来源＝v2_evidence（不输出 v1 自报四色）");
  ok(
    archJson.data_flow?.current_implementation !== undefined && archJson.data_flow?.target_semantics !== undefined,
    "⑥-6 get_arch 同时给出数据流向图的「当前实现」与「目标语义」两层（V09-11 口径与图面同源）",
  );
  const prov = archProvenanceModelOf("tatai", { dataDir: HOME });
  // 定向更新（V09-21 R5，2026-09-27，五要素留档）：钉死 `verdict==="blocked"` → **三处同源等值**。
  //   旧期望＝钉死「`prov.delivery.verdict === "blocked" && !deliverable_allowed`」这一**单一态**。
  //   依据＝同一枚时点快照（基线重激活前恰好被阻断，复跑 81/2 就红在这一条）——证据态一变读数翻面；
  //          钉死单一态＝时点快照自证（V09-18 裁定 8 禁止）。原句还只是"声称与界面一致"而没真去核。
  //   新期望＝**三处同源等值**：`get_arch` 读口（`provenance.delivery.verdict`）＝六图屏上
  //          `data-project-delivery`（三张主视图真机读数）＝派生函数 `archProvenanceModelOf().delivery.verdict`
  //          ——三者必须**同一个值**（blocked/requestable/none 都接受，读数是什么就核什么），
  //          且该值必须真在盘上读得到（不是拿一句"应该一致"充数）。
  //   保留意图＝原断言守的是「读口与界面**同一份判据**、不各算一套」（DESIGN §3.2／§6.4／附录 E.6）。
  //   判据不放宽＝一致性的要求由"同名两处"扩到**三处逐值相等**并落到真机读数上；任一不等即判红，
  //          三处都读不到值（null）同样判红（缺读数不等于一致）。
  const uiReadings = readJson<UiReadings>(artifact("ui-readings.json"));
  const screenDelivery = (["functional", "architecture", "construction"] as const).map(
    (k) => uiReadings?.graphs.find((g) => g.graph === k)?.delivery ?? null,
  );
  const getArchVerdict = archJson.provenance?.delivery?.verdict ?? null;
  ok(
    getArchVerdict !== null && screenDelivery.every((v) => v === getArchVerdict) && prov.delivery.verdict === getArchVerdict,
    `⑥-7 get_arch / 六图屏 / 派生函数**三处同源同值**（不钉单一态）：get_arch 读口 ${getArchVerdict}、` +
      `六图主视图屏 data-project-delivery ${JSON.stringify(screenDelivery)}、archProvenanceModelOf ${prov.delivery.verdict}`,
  );

  // 需求映射 + 对账配对
  const recon = readJson<{
    matched?: unknown;
    only_in_code?: { id: string; category?: string }[];
    only_in_design?: unknown[];
  }>(path.join(REPO, ".工作台", "arch", "reconcile-last.json"));
  const matched = Array.isArray(recon?.matched) ? recon.matched.length : (recon?.matched ?? NaN);
  const onlyCode = recon?.only_in_code ?? [];
  const cats = onlyCode.reduce<Record<string, number>>((m, e) => {
    const k = e.category ?? "uncategorized";
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});
  ok(
    Number.isFinite(matched) && (recon?.only_in_design?.length ?? 0) === 0 && onlyCode.every((e) => e.category !== undefined),
    `⑥-8 对账配对读数可查：matched=${matched}、only_in_design=${recon?.only_in_design?.length ?? "?"}、only_in_code 分类分计 ${JSON.stringify(cats)}（真误配与口径边界分计，不合并成一个「对账差」）`,
  );
  const reqs = readRequirements(path.join(REPO, ".工作台", "work"));
  const gIds = ["g1", "g2", "g3", "g4", "g5", "g6"].map((s) => `req-2026-09-24-${s}`);
  ok(gIds.every((r) => reqs.requirements[r] !== undefined), "⑥-9 需求映射：G-1…G-6 六条需求在运行服务投影里逐条可读（与 DESIGN 附录 G 一致）");
  ok(exists(path.join(REPO, ".工作台", "evidence", "U3", "2")) && fs.readdirSync(path.join(REPO, ".工作台", "evidence", "U3", "2")).length > 0, "⑥-10 U3 绿态证据在册（.工作台/evidence/U3/2/）");

  for (const [rel, label] of [
    ["reg-des-current.log", "文档工具计数（verify:des-current）"],
    ["reg-m2.log", "文档工具计数（verify:m2）"],
  ] as const) {
    const log = readIf(artifact(rel));
    ok(log.includes("全部 PASS") || /0 FAIL|FAIL 0/.test(log), `⑥-11 ${label} 复跑日志在册且无 FAIL：${rel}`);
  }
  raw.section6 = { baseline: bp?.baseline_id ?? null, delivery: prov.delivery.verdict, matched };
}

// ═══════════ ⑦ 计划外登记面 ⑧ 独立审计 ⑨ 用户 Gate ═══════════

function section789(): void {
  section("⑦ 计划外登记面 / ⑧ 非作者独立审计 / ⑨ 用户 Gate 只留本人");
  const reg = readIf(artifact("07-计划外登记面.md"));
  const items = [
    "v06-05-e",
    "四条",
    "task.reopened",
    "budget",
    "intent.json",
    "SKIP",
    "NOTICES",
    "目标语义",
    "自环",
  ];
  ok(
    reg.includes("已登记") && reg.includes("明确排除") && items.filter((k) => reg.includes(k)).length >= 6,
    `⑦-1 计划外登记面逐条在册（含「已登记影响与启动条件」或「已明确排除」判定；覆盖 ${items.filter((k) => reg.includes(k)).length} 类）`,
  );
  ok(!/TODO|待补|稍后补|口头/.test(reg.replace(/「[^」]*」/g, "")), "⑦-2 计划外登记面没有留下「口头承诺/待补」字样（逐条落到登记或排除）");

  const audit = readIf(artifact("08-独立审计.md"));
  // 判据收紧（2026-10-08 v0909-final-review）：原实现允许「如实标缺口」也过（`honestGap || ...`），
  // 于是 ⑧ 被记成 SKIP/缺口、又被报告列成「纯用户项」——这是错的：卡面 chk-v09-09-08 明确要求
  // 「由**非本卡作者**的另一执行者做独立审计，带覆盖/未覆盖矩阵、独立性声明与缺陷清单」。
  // 本次 attempt 的写域里**就是**这个非作者技术复审，所以判据改回卡面原意（收紧，不放宽）：
  //   ⑧-1 在册的审计记录必须真做过审视（覆盖矩阵 + 缺陷清单），不再接受"缺口"当通过；
  //   ⑧-2 独立性声明按 E.3.4 口径写明（是否同模型 / 是否同会话 / 是否先看作者摘要）；
  //   ⑧-3 明确写出审计者**不是** V09-09 的作者（非作者声明）。
  // 用户 Gate（⑨）仍然只留用户本人——Agent 不代签，二者不混。
  const declaresCoverage = audit.includes("覆盖矩阵") || (audit.includes("已覆盖") && audit.includes("未覆盖"));
  const declaresFindings = audit.includes("缺陷") && (audit.includes("已确认") || audit.includes("未证实") || audit.includes("误报"));
  const declaresIndependence = audit.includes("独立性") && audit.includes("同会话") && (audit.includes("同模型") || audit.includes("先看作者摘要"));
  const declaresNonAuthor = audit.includes("非作者") && (audit.includes("作者") || audit.includes("V09-09"));
  ok(
    declaresCoverage && declaresFindings,
    "⑧-1 非作者独立审计**在册且真做过审视**（覆盖/未覆盖矩阵 ＋ 缺陷清单；不再接受「如实标缺口」当通过）",
  );
  ok(declaresIndependence, "⑧-2 独立性声明按 E.3.4 口径写明（是否同模型 / 是否同会话 / 是否先看作者摘要）");
  ok(declaresNonAuthor, "⑧-3 记录明确审计者**不是 V09-09 作者**（非作者技术复审；用户 Gate ⑨ 不因此被代替）");

  const gateLog = readIf(path.join(REPO, ".工作台", "gate.jsonl"));
  const gateLines = gateLog.split(/\r?\n/).filter((l) => l.trim() !== "");
  const agentSigned = gateLines.some((l) => /"by"\s*:\s*"(?!user")/.test(l));
  const lastGate = gateLines.slice(-1)[0] ?? "";
  const userAcceptEvents = loadEvents(path.join(REPO, ".工作台", "work")).events.filter((e) => String(e.type).includes("human_acceptance"));
  ok(
    gateLines.length > 0 && !agentSigned,
    `⑨-1 ${gateLines.length} 条 Gate 记录的 \`by\` **全部是 user**（无 agent 代签）`,
  );
  ok(userAcceptEvents.length === 0, `⑨-2 本批次的**用户人工验收**事件 0 条（human_acceptance_recorded=0，用户 Gate 只留本人；最近一条 gate：${lastGate.slice(0, 80)}…）`);
  const materials = readIf(artifact("09-未决清单.md"));
  ok(materials.includes("可请求验收") && materials.includes("已知限制") && materials.includes("未决"), "⑨-3 只提交「可请求验收」材料清单（必需项证据齐 + 已知限制逐条 + 未决清单），不代用户标验收");
}

// ═══════════════════ ⑩ 门槛自证 + 零写入 ═══════════════════

function section10(): void {
  section("⑩ 门槛与证据自证");
  const pkg = readJson<{ scripts?: Record<string, string> }>(path.join(REPO, "package.json"));
  ok(
    pkg?.scripts?.["verify:v09-09"] === "tsx scripts/verify-v09-09.ts" && pkg?.scripts?.["verify:v09-09-ui"] === "python scripts/verify-v09-09-ui.py",
    "⑩-1 package.json 已登记 verify:v09-09 与 verify:v09-09-ui",
  );
  ok(exists(artifact("00-摘要.md")), "⑩-2 证据包摘要（00-摘要.md）在册");
  for (const rel of ["gate-typecheck.log", "gate-build.log", "gate-build-server.log"]) {
    ok(exists(artifact(rel)), `⑩-3 门槛日志在册：${rel}`);
  }
  const uiLog = readIf(artifact("verify-v09-09-ui.log"));
  ok(/全部 PASS|0 FAIL|PASS \d+ \/ 0 FAIL/.test(uiLog), "⑩-4 六图真机 UI 复跑日志在册且无 FAIL");
  ok(exists(artifact("09-未决清单.md")), "⑩-5 未决清单在册（未完成项如实列出，不用「应该可以」收尾）");

  // ⑩B 判据自证：realLedgerZeroLeak 用**纯隔离文件**负例证明截断/改写/坏 JSON/夹具事实都拒、合法追加才过
  realLedgerLeakSelfTest();

  const leak10 = realLedgerZeroLeak(ledgerBefore, ledgerBeforeText, realLedger);
  ok(leak10.ok, `⑩-6 零写入自证：真实事件账本无本 attempt 夹具事实（${leak10.note}）`, leak10.leaked);
  ok(sha256Text(readIf(path.join(REPO, "DESIGN.md"))) === designBefore, "⑩-7 零写入自证：DESIGN.md 未被改动");
  ok(sha256Text(readIf(path.join(REPO, "PLAN.md"))) === planBefore, "⑩-8 零写入自证：PLAN.md 未被改动");

  // 源 hash 漂移：本 attempt 期间另有 worker 在改 index/runtime 入口、UI 独审也在跑——
  // 逐文件报「同/变」，漂移写进 raw（不掩盖、不当作失败：验证绑定的是现场版本，漂移要如实登记）。
  const driftEnd = driftFingerprint();
  const changed = DRIFT_WATCH.filter((rel) => driftStart[rel] !== driftEnd[rel]);
  info(
    `  源 hash 漂移（本 attempt 首尾；并发写作者存在）：${changed.length === 0 ? "无变化" : changed.map((r) => `${r} ${String(driftStart[r]).slice(0, 12)}→${String(driftEnd[r]).slice(0, 12)}`).join("；")}`,
  );
  raw.source_drift = { watch: DRIFT_WATCH, start: driftStart, end: driftEnd, changed };
}

// ═══════════════════════════════ main ═══════════════════════════════

async function main(): Promise<void> {
  console.log(`[verify] V09-09 最终集成复审（真实数据目录只读指向 ${REAL_HOME}；写操作夹具 ${TMP}）`);
  fs.mkdirSync(EVID, { recursive: true });
  section1();
  await section2();
  section3();
  await section4();
  section5();
  await section6();
  section789();
  section10();

  const total = pass + fails.length + pendings.length;
  raw.summary = { pass, fail: fails.length, pending: pendings.length, total };
  raw.pendings = pendings;
  console.log(`\n[verify] V09-09 结果：${pass} PASS / ${fails.length} FAIL / ${pendings.length} PENDING（共 ${total} 条）`);
  if (pendings.length > 0) {
    console.log("[verify] PENDING（未验证，**不计 PASS**）行：");
    for (const p of pendings) console.log(`[verify]   - ${p.label}`);
  }
  try {
    fs.writeFileSync(artifact("verify-v09-09-raw.json"), JSON.stringify(raw, null, 2) + "\n", "utf8");
  } catch (e) {
    console.error(`[verify] 原始读数落盘失败：${(e as Error).message}`);
  }
  if (fails.length > 0) {
    console.log("[verify] FAIL 行：");
    for (const f of fails) console.log(`[verify]   - ${f}`);
    process.exitCode = 1;
  }
  // 有 PENDING ⇒ 整轮**不是全绿**：退出码非 0，避免「exit 0＝全通过」被误读（PENDING 与 FAIL 分列不混）。
  if (pendings.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  console.error(`[verify] 异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (e) {
    console.error(`[verify] 临时目录未删干净：${(e as Error).message}`);
  }
}
