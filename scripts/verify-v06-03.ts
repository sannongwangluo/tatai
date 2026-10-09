// V06-03 验证脚本（PLAN.md V06-03，DESIGN.md §2.6 / §2.7 / §2.9 / §5.4 / §5.8）。
// 用法：pnpm verify:v06-03（或 node --import tsx scripts/verify-v06-03.ts）
//
// 自带隔离环境：临时 TATAI_HOME + 临时项目目录（os.tmpdir() 下），**不碰**三个真实项目的 `.工作台/`；
// 塔台自身的 DESIGN.md / PLAN.md **只读**（脚本首尾逐文件 sha256 对照，证明零改动），
// 收尾清理自己建的临时目录（TATAI_KEEP_TMP=1 可保留现场）。
//
// 覆盖点（PLAN V06-03 检查项 1–3 逐条）：
//   ① 复用 V06-02 的 planValidate，扩展**完整定义解析与稳定 ID**：重复 ID（含大小写/空白这种"换身份"）、
//      悬空依赖、循环依赖、缺验收要求都点名 id；**区边界**（任务定义区 / 派生状态区 / 历史归档区）有
//      机器可判的判据，并断言"改状态列/改勾选位/改历史区都不动定义哈希，改交付目标才动"。
//   ② v1→v2 **预览 / 备份 / 校验 / 回滚 / 兼容投影**：旧 done 只映射「结果已提交」，取消任务带明确标记，
//      旧写工具缺版本/认领参数时**拒绝绕写**，**旧程序面对新格式拒写**；回滚逐字节还原用户原始数据。
//   ③ 状态更新不改变定义哈希；图纸修订使**相关**任务待重绑（依赖方一并重绑）；PLAN 与运行任务同源；
//      回滚不丢用户原始数据；施工图状态区投影**默认关闭**（塔台自己的 PLAN.md 一个字节都没动）。
//
// **断言口径（父代理复核后修正，务必遵守）**：凡断言**解析契约**的用例（表格列 → 字段、「设计依据/文件责任/
// 契约/交付」段 → 字段、检查项与勾选位 → acceptance、缺失字段如实为 null、依赖 token 切分、
// 「改状态列/勾选位/施工备注/历史区不动定义哈希」「改交付目标才动定义哈希」）一律跑在**受控夹具文档**上
// （临时项目 `contract` 的 `.工作台/plan.md`，内容完全由本脚本掌握，见 `CONTRACT_PLAN_*`）；
// 对**真实仓库文档**（`PLAN.md`）只断言"可被完整定义解析 / 结构合法 / 区边界判得出来 / 没被写"，
// **不断言任何某卡当前的状态值、完成证据文本、是否勾选**——否则每次按施工规矩同步进度都会把本脚本弄红
// （2026-09-20 父代理同步 V06-03 为 done 时就踩过一次）。
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WorkService } from "../src/server/work/service";
import { loadEvents, readSnapshotFromDisk } from "../src/server/work/eventStore";
import { WorkError } from "../src/server/work/types";
import {
  assertTaskDefinitionsValid,
  classifyPlanRegions,
  definitionOnlyText,
  diffTaskDefinitions,
  importTaskDefinitions,
  planDefinitionDigest,
  sha256Hex,
  splitDependencyCell,
  stableTaskKey,
  taskDefinitionHash,
  validateTaskDefinitions,
} from "../src/server/work/plan";
import type { TaskDefinition } from "../src/server/work/plan";
import { parsePlanTable, type PlanIssue } from "../src/server/work/planValidate";
import {
  alignDefinitionsAndStates,
  buildCompatTasksProjection,
  hasV2ProjectionMarker,
  readTaskStates,
  submitDefinitionImports,
  submitTaskEvent,
  submitTaskRebind,
  submitTaskStatus,
  taskEntityId,
  v1StatusOf,
  v1TaskWriteGate,
  writePlanStatusProjection,
  renderPlanStatusRegion,
  type CompatTasksFile,
} from "../src/server/work/tasks";
import {
  applyMigration,
  backupV1Files,
  isMigratedProject,
  previewMigration,
  readBackupManifest,
  readV1Snapshot,
  rollbackMigration,
  validateMigration,
} from "../src/server/work/migrate";
import {
  addModule,
  addTask,
  listTasks,
  projectWorkDir,
  readTasks,
  setModuleStatus,
  setTaskStatus,
  tasksProjectionInfo,
  WsError,
} from "../src/server/workstation";
import { readProgressTool } from "../src/mcp/tools/readProgress";
import { listTasksTool } from "../src/mcp/tools/listTasks";
import { reportTaskStatusTool } from "../src/mcp/tools/reportTaskStatus";
import { updateProgressTool } from "../src/mcp/tools/updateProgress";

const PORT = 8803;
const REPO = process.cwd();
const REPO_FILES = ["DESIGN.md", "PLAN.md", "PROGRESS.md", "AGENTS.md", "README.md", "templates/README.md"];

const spawned: ChildProcess[] = [];
process.on("exit", () => {
  for (const proc of spawned) {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch {
      // 已经没了
    }
  }
});

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
  }
};
const info = (msg: string) => console.log(`[verify] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function workErrorOf(fn: () => unknown): WorkError | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof WorkError) return e;
    console.log(`[verify]   （非 WorkError 抛出：${(e as Error).message}）`);
    return null;
  }
}
function wsErrorOf(fn: () => unknown): WsError | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof WsError) return e;
    console.log(`[verify]   （非 WsError 抛出：${(e as Error).message}）`);
    return null;
  }
}
const reasonOf = (e: WorkError | null): unknown => e?.detail?.reason;
const issuesOf = (e: { detail?: Record<string, unknown> } | null): PlanIssue[] =>
  (e?.detail?.issues as PlanIssue[] | undefined) ?? [];

async function toolText(result: unknown): Promise<{ text: string; isError: boolean }> {
  const r = (await result) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content[0]?.text ?? "", isError: r.isError === true };
}

// ── 隔离环境 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0603-verify-"));
const dataDir = path.join(tmpBase, "home");
const plainRoot = path.join(tmpBase, "plain"); // 未迁移项目：v1 行为必须逐字不变
const migRoot = path.join(tmpBase, "mig"); // 迁移夹具（v1 台账 → v2）
const defsRoot = path.join(tmpBase, "defs"); // 定义/状态投影夹具
const contractRoot = path.join(tmpBase, "contract"); // 解析契约受控夹具（① 段专用，内容完全由本脚本掌握）
const mkdirp = (dir: string) => fs.mkdirSync(dir, { recursive: true });
const write = (file: string, text: string) => {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, text, "utf8");
};
const writeBytes = (file: string, bytes: Buffer) => {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, bytes);
};
const read = (file: string) => fs.readFileSync(file, "utf8");
const workbench = (root: string) => path.join(root, ".工作台");
const sha256File = (file: string) => sha256Hex(fs.readFileSync(file));

for (const dir of [dataDir, plainRoot, migRoot, defsRoot, contractRoot]) mkdirp(dir);

const record = (id: string, name: string, dir: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  path: dir,
  kind: "backend",
  registered_at: "2026-09-20T00:00:00+08:00",
  last_opened_at: "2026-09-20T00:00:00+08:00",
  ...extra,
});
const TATAI_RECORD = record("tatai", "塔台（repo 根夹具，只读）", REPO, { self_managed: true });
const OTHER_RECORDS = [
  record("plain", "未迁移项目（v1 行为基线）", plainRoot),
  record("mig", "迁移夹具", migRoot),
  record("defs", "定义与投影夹具", defsRoot),
  record("contract", "解析契约受控夹具", contractRoot),
];
const writeRegistry = (records: unknown[]) =>
  write(path.join(dataDir, "registry.json"), JSON.stringify({ version: 1, projects: records }, null, 2));
writeRegistry([TATAI_RECORD, ...OTHER_RECORDS]);
// MCP 工具不带 dataDir（走 resolveDataDir()）——与 verify-l3 同款口径，进程内也钉到临时数据目录
process.env.TATAI_HOME = dataDir;

// ── 夹具：施工图（含历史区 / 派生状态区 / 卡片小节） ──
const DESIGN_MD = "# 夹具设计书\n\n## 1 概述\n定义与状态投影夹具。\n";
write(path.join(workbench(defsRoot), "design.md"), DESIGN_MD);

interface PlanFixture {
  rows: string[];
  cards?: string[];
  historyExtra?: string;
}
const planFixture = (f: PlanFixture): string =>
  [
    "# 夹具施工图",
    "",
    "## v0.6 当前施工入口",
    "",
    "**目标**：夹具。",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    ...f.rows,
    "",
    "### 施工与验证约定",
    "",
    "- 约定文本（非卡号标题，属历史归档区）",
    "",
    ...(f.cards ?? []),
    "## 历史审计项（旧表，表头不含「依赖」，别当施工定义）",
    "",
    "| 原登记 | v0.6 去向 / 责任卡 |",
    "| --- | --- |",
    `| Q25 | ${f.historyExtra ?? "随 V06-06 复核"} |`,
    "",
    "## v0.5 历史工作包（已被取代）",
    "",
    "历史正文，不进任务定义。",
    "",
  ].join("\n");

const CARD_T1 = [
  "### T-1 打地基",
  "",
  "**设计依据**：§2.7、§5.4–§5.8。**依赖**：用户本轮授权。",
  "",
  "**文件责任**：新增 `src/foundation.ts`；修改 `src/index.ts`。",
  "",
  "**风险**：中",
  "",
  "- [ ] 打完地基",
  "- [x] 验过一次",
  "",
  "**交付**：地基可承重；验收记录归档。",
  "",
  "**施工备注（2026-09-20）**：已开工，等料。",
  "",
];
const CARD_T2 = [
  "### T-2 砌墙",
  "",
  "**设计依据**：§2.7。**依赖**：T-1。",
  "",
  "**文件责任**：新增 `src/wall.ts`。",
  "",
  "- [ ] 砌到顶",
  "",
  "**交付**：墙体验收。",
  "",
];
const PLAN_BASE = planFixture({
  rows: [
    "| T-1 | todo | 打地基 | 用户本轮授权 | 地基验收记录 |",
    "| T-2 | todo | 砌墙 | T-1 | 墙体验收记录 |",
    "| T-3 | todo | 上梁 | T-1、T-2 | 上梁验收记录 |",
  ],
  cards: [...CARD_T1, ...CARD_T2],
});
write(path.join(workbench(defsRoot), "plan.md"), PLAN_BASE);

// ── 文档哈希（红线：DESIGN.md / PLAN.md 一个字节都不能动） ──
const docHashesBefore = new Map(REPO_FILES.map((f) => [f, sha256File(path.join(REPO, f))]));
console.log("=".repeat(72));
console.log("[verify] 塔台根文档 sha256（开工前）");
for (const [f, h] of docHashesBefore) console.log(`[verify]   ${f}  ${h}`);
console.log("=".repeat(72));

// ═══════════════════════════ ① 完整任务定义与区边界 ═══════════════════════════

console.log("");
info("═══ ① 完整定义解析、稳定 ID 与区边界 ═══");

// ── ①-a 受控夹具：解析契约的用例一律跑在它上面（不受仓库文档进度影响） ──
//
// 口径见文件头：真实仓库文档只断言"可被解析/结构合法"，**不断言**任何卡当前的状态值、完成证据文本或勾选位。
// 这里的夹具文档完全由脚本掌握（卡号/交付目标/依赖/完成证据/检查项/交付段/施工备注/历史区都写死在下面），
// 所以"表格列 → 字段""检查项与交付段 → acceptance""只改某张卡的交付目标时只有该卡的定义哈希变"这些
// **解析契约**断言不会因为有人同步塔台 PLAN 的进度而变红；并且每条哈希断言都带"变异确实生效"守卫，
// 杜绝 replace 落空导致的"空转通过"。
const CONTRACT_ROWS = [
  "| C-1 | todo | 打地基 | 用户本轮授权 | 地基验收记录 |",
  "| C-2 | doing | 砌墙 | C-1 | 墙体验收记录 |",
  "| C-3 | todo | 上梁 | C-1、C-2 | 上梁验收记录 |",
];
const CONTRACT_CARD_C1 = [
  "### C-1 打地基",
  "",
  "**设计依据**：§2.7、§5.4–§5.8。**依赖**：用户本轮授权。",
  "",
  "**文件责任**：新增 `src/foundation.ts`；修改 `src/index.ts`。",
  "",
  "- [ ] 打完地基",
  "- [x] 验过一次",
  "",
  "**交付**：地基可承重；验收记录归档。",
  "",
  "**施工备注（受控夹具）**：夹具备注原文。",
  "",
];
const CONTRACT_CARD_C2 = [
  "### C-2 砌墙",
  "",
  "**设计依据**：§2.7。**依赖**：C-1。",
  "",
  "**契约**：导出 `WallSpec`；输入 = 地基验收记录，输出 = 墙体清单。",
  "",
  "- [ ] 砌到顶",
  "",
  "**风险**：中",
  "",
  "**交付**：墙体验收。",
  "",
];
const CONTRACT_CARD_C3 = [
  "### C-3 上梁",
  "",
  "**设计依据**：§5.8。**依赖**：C-1、C-2。",
  "",
  "**文件责任**：新增 `src/beam.ts`。",
  "",
  "- [ ] 上梁到位",
  "",
  "**交付**：上梁验收记录。",
  "",
];
const CONTRACT_HISTORY_ROW = "| Q25 | 随 V06-06 复核 |";
/** 受控夹具文档（可参数化，供"改一处"的哈希对照用） */
const contractPlanDoc = (
  o: {
    rows?: string[];
    cards?: string[];
    historyRow?: string;
  } = {},
): string =>
  [
    "# 受控夹具施工图（解析契约专用）",
    "",
    "## 当前施工入口",
    "",
    "**目标**：夹具。",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    ...(o.rows ?? CONTRACT_ROWS),
    "",
    "### 施工与验证约定",
    "",
    "- 夹具约定（非卡号标题，属历史归档区）",
    "",
    ...(o.cards ?? [...CONTRACT_CARD_C1, ...CONTRACT_CARD_C2, ...CONTRACT_CARD_C3]),
    "## 历史审计项（旧表，表头不含「依赖」，别当施工定义）",
    "",
    "| 原登记 | v0.6 去向 / 责任卡 |",
    "| --- | --- |",
    `${o.historyRow ?? CONTRACT_HISTORY_ROW} |`,
    "",
    "## v0.5 历史工作包（已被取代）",
    "",
    "夹具历史正文。",
    "",
  ].join("\n");

const CONTRACT_PLAN = contractPlanDoc();
const contractPlanPath = path.join(workbench(contractRoot), "plan.md");
write(contractPlanPath, CONTRACT_PLAN);
const contractText = read(contractPlanPath); // 从临时项目里**读回**再解析，证明夹具确实落盘
const contract = importTaskDefinitions(contractText);
const contractIssues = validateTaskDefinitions(contract.definitions, true);
ok(
  contractText === CONTRACT_PLAN &&
    contract.definitions.length === 3 &&
    contractIssues.length === 0 &&
    path.resolve(contractPlanPath).startsWith(path.resolve(tmpBase)),
  `① 受控夹具就位：临时项目 ${path.basename(contractRoot)}/.工作台/plan.md 落盘并读回（${contract.definitions.length} 张卡，结构无问题）`,
);

// ①-b 解析契约：表格列 → 字段；正文段 → 字段（全部在夹具上断言）
const c1 = contract.definitions.find((d) => d.task_id === "C-1")!;
const c2 = contract.definitions.find((d) => d.task_id === "C-2")!;
const c3 = contract.definitions.find((d) => d.task_id === "C-3")!;
ok(
  c1.goal === "打地基" &&
    c1.evidence_requirement === "地基验收记录" &&
    c1.row_line > 0 &&
    c3.goal === "上梁" &&
    c3.evidence_requirement === "上梁验收记录" &&
    JSON.stringify(c3.dependency_ids) === JSON.stringify(["C-1", "C-2"]),
  `① 字段来源（夹具）：卡号/交付目标/完成证据/依赖列取自表格（C-1 goal=${String(c1.goal)}、证据=${String(
    c1.evidence_requirement,
  )}；C-3 deps=${c3.dependency_ids.join("、")}）`,
);
ok(
  JSON.stringify(c1.design_refs) === JSON.stringify(["§2.7", "§5.4–§5.8"]) &&
    JSON.stringify(c1.allowed_paths) === JSON.stringify(["src/foundation.ts", "src/index.ts"]) &&
    JSON.stringify(c3.allowed_paths) === JSON.stringify(["src/beam.ts"]),
  `① 正文段 → 字段（夹具）：「设计依据」→ design_refs=${JSON.stringify(c1.design_refs)}；「文件责任」反引号路径 → allowed_paths=${JSON.stringify(
    c1.allowed_paths,
  )}`,
);
ok(
  c1.acceptance !== null &&
    c1.acceptance.checks.length === 2 &&
    c1.acceptance.checks[0].checked === false &&
    c1.acceptance.checks[1].checked === true &&
    c1.acceptance.deliverables === "地基可承重；验收记录归档。" &&
    JSON.stringify(c1.deliverables) === JSON.stringify(["地基可承重", "验收记录归档"]),
  `① 检查项与「交付」段 → acceptance（夹具）：checks=${String(
    c1.acceptance?.checks.length,
  )} 项（` +
    "`[ ]`" +
    ` 与 ` +
    "`[x]`" +
    ` 都如实读到）、deliverables=${JSON.stringify(c1.deliverables)}`,
);
const c1Report = contract.report.tasks.find((t) => t.task_id === "C-1")!;
const contractMissing = [
  "change_id",
  "requirement_ids",
  "design_revision",
  "base_commit",
  "forbidden",
  "risk",
  "owner_role",
  "priority",
];
ok(
  c1.risk === null &&
    c1.owner_role === null &&
    c1.priority === null &&
    c1.change_id === null &&
    c1.requirement_ids === null &&
    c1.base_commit === null &&
    c1.design_revision === null &&
    c1.forbidden === null,
  "① 源文档没有的字段一律 null（夹具：风险/责任角色/优先级/变更批次/需求/基线/设计修订/禁止越界）",
);
ok(
  contractMissing.every((f) => c1Report.missing_fields.includes(f)) &&
    !c1Report.missing_fields.includes("goal") &&
    !c1Report.missing_fields.includes("allowed_paths") &&
    !c1Report.missing_fields.includes("evidence_requirement"),
  `① 导入报告如实列出缺失项（夹具：${c1Report.missing_fields.join("、")}）`,
);
const cardsWithoutInputsContract = contract.definitions.filter((d) => d.inputs === null).map((d) => d.task_id);
ok(
  c2.inputs !== null &&
    c2.inputs.startsWith("导出 `WallSpec`") &&
    JSON.stringify(cardsWithoutInputsContract) === JSON.stringify(["C-1", "C-3"]),
  `① 「**契约**」段 → inputs（夹具）：有该段的 C-2 非空，没有的如实为 null（${cardsWithoutInputsContract.join(
    "、",
  )}）`,
);
ok(
  c1.dependency_ids.length === 0 &&
    JSON.stringify(c1.dependency_notes) === JSON.stringify(["用户本轮授权"]) &&
    contractIssues.every((i) => i.problem !== "dangling_dependency"),
  `① 非卡号依赖归 dependency_notes 且**不算悬空**（夹具：C-1 → ${JSON.stringify(c1.dependency_notes)}）`,
);
const depSplit = splitDependencyCell("C-1、用户本轮授权", new Set(["C-1"]));
ok(
  JSON.stringify(depSplit.ids) === JSON.stringify(["C-1"]) &&
    JSON.stringify(depSplit.notes) === JSON.stringify(["用户本轮授权"]),
  "① 依赖切分口径：卡号形态 → dependency_ids；自然语言 → dependency_notes",
);
ok(
  c2.dependency_evidence.length === 1 &&
    c2.dependency_evidence[0].dependency_id === "C-1" &&
    c2.dependency_evidence[0].present &&
    c2.dependency_evidence[0].evidence === "地基验收记录" &&
    c3.dependency_evidence.length === 2,
  `① 依赖输入口径（夹具）：dependency_evidence 带依赖卡的「完成证据」（C-2 → ${JSON.stringify(
    c2.dependency_evidence[0].evidence,
  )}）`,
);
ok(stableTaskKey(" c-1 ") === "C-1", "① 稳定 ID：stable_key 去空白/忽略大小写（跨修订不换身份）");

// ①-c 真文档只断言"可被完整定义解析 / 结构合法"，不断言其可变状态
const tataiPlanText = read(path.join(REPO, "PLAN.md"));
const tatai = importTaskDefinitions(tataiPlanText);
const tataiIssues = validateTaskDefinitions(tatai.definitions, tatai.report.table_line !== null);
const tataiTable = parsePlanTable(tataiPlanText)!;
ok(
  tatai.definitions.length === tataiTable.rows.length &&
    tatai.definitions.length >= 16 &&
    tatai.report.table_line === tataiTable.start_line &&
    !tatai.definitions.some((d) => /^Q\d+$/.test(d.task_id)) &&
    tatai.definitions.some((d) => d.task_id === "V06-01") &&
    tatai.definitions.some((d) => d.task_id === "DES-V06"),
  `① 塔台 PLAN 可被完整定义解析：任务数 = 施工卡表行数（${tatai.definitions.length} ≥ 16），且没把历史表吃进来`,
);
ok(
  tataiIssues.length === 0,
  `① 塔台 PLAN 完整定义校验通过（重复 ID/悬空依赖/循环依赖/缺验收全无；问题=${JSON.stringify(
    tataiIssues.map((i) => i.problem),
  )}）——自然语言依赖（「施工授权」一类）不再被误判成悬空`,
);
const bindingFields = ["change_id", "base_commit", "design_revision"];
// 定向更新（V09-08 返工 attempt 3，2026-09-24）；判据未放宽——「不编造」双向仍成立：
//   旧期望＝change_id/requirement_ids/base_commit/design_revision 四字段对每张卡都列缺失
//   （当时需求映射为空、requirement_ids 确实全场缺席的实况）｜
//   依据：V09-03／V09-16 需求映射落地——19 张承接卡经受了检导入带非空 requirement_ids
//   （PLAN 需求映射表 12 行；账本 seq 748–791／814–857），这些卡的 requirement_ids 不再「缺失」｜
//   新期望＝按真实有无分列：change_id/base_commit/design_revision 仍场场列缺失；
//   requirement_ids 已映射的卡不得列缺失、未映射的卡必须列缺失｜
//   保留意图：如实——在场字段不列缺失（不藏）、缺席字段必列缺失（不编造）。
const defsById = new Map(tatai.definitions.map((d) => [d.task_id, d]));
ok(
  tatai.report.tasks.length === tatai.definitions.length &&
    tatai.report.tasks.every(
      (t) =>
        bindingFields.every((f) => t.missing_fields.includes(f)) &&
        ((defsById.get(t.task_id)?.requirement_ids ?? []).length > 0
          ? !t.missing_fields.includes("requirement_ids")
          : t.missing_fields.includes("requirement_ids")),
    ),
  "① 塔台 PLAN 每张卡的 §2.7 绑定字段如实列进缺失项（不编造）：change_id/base_commit/design_revision 仍列缺失；requirement_ids 已映射的卡不列缺失、未映射的仍列缺失",
);

// ①-d 区边界判据（真文档：结构性判据，不是"某卡当前状态"）
const regionMap = classifyPlanRegions(tataiPlanText);
const regionLines = (kind: string) =>
  regionMap.regions.filter((r) => r.kind === kind).reduce((n, r) => n + (r.line_end - r.line_start + 1), 0);
ok(
  JSON.stringify(regionMap.state_columns) === JSON.stringify(["状态"]) &&
    !regionMap.definition_columns.includes("状态") &&
    regionMap.definition_columns.includes("完成证据"),
  `① 区边界：施工卡表里「状态」列是派生状态列（state_columns=${JSON.stringify(
    regionMap.state_columns,
  )}，definition_columns=${JSON.stringify(regionMap.definition_columns)}）`,
);
ok(
  regionLines("definition") > 0 &&
    regionLines("state") > 0 &&
    regionLines("history") > 0 &&
    regionMap.regions.every((r) => r.reason.length > 0),
  `① 区边界：三类区都判出来了（定义 ${regionLines("definition")} 行 / 状态 ${regionLines(
    "state",
  )} 行 / 历史 ${regionLines("history")} 行，每段都带可读判据）`,
);
const histTables = regionMap.regions.filter((r) => r.kind === "history" && r.shape === "table");
ok(
  histTables.length > 0 &&
    histTables.every((r) => (r.reason.includes("表头") && r.reason.includes("历史归档"))),
  `① 区边界：表头缺必需列的表被判历史归档（${histTables.length} 段，判据可读）`,
);
ok(
  regionMap.regions.some(
    (r) => r.kind === "state" && r.shape === "state_paragraph" && r.reason.includes("施工备注"),
  ),
  "① 区边界：卡片小节的「施工备注」段被判派生状态区（不进定义）",
);

// ①-e 状态/历史变化不动定义；改交付目标才动定义（夹具 + "变异确实生效"守卫）
const digestBefore = planDefinitionDigest(contractText);
const hashOf = (text: string, id: string): string =>
  taskDefinitionHash(importTaskDefinitions(text).definitions.find((d) => d.task_id === id)!);
/** 变异必须真的改到了文本（否则 replace 落空 → 断言会"空转通过"，那是隐性削弱） */
const mutate = (text: string, from: string, to: string): { text: string; applied: boolean } => {
  const mutated = text.replace(from, to);
  return { text: mutated, applied: mutated !== text };
};
const statusMut = mutate(contractText, "| C-1 | todo |", "| C-1 | done |");
ok(
  statusMut.applied &&
    hashOf(statusMut.text, "C-1") === hashOf(contractText, "C-1") &&
    planDefinitionDigest(statusMut.text) === digestBefore,
  "① 改表格「状态」列（夹具）：定义哈希不变（派生状态不进定义）",
);
const checkedMut = mutate(contractText, "- [ ] 打完地基", "- [x] 打完地基");
ok(
  checkedMut.applied &&
    hashOf(checkedMut.text, "C-1") === hashOf(contractText, "C-1") &&
    planDefinitionDigest(checkedMut.text) === digestBefore,
  "① 改检查项勾选位（夹具）：定义哈希不变（勾没勾是派生状态）",
);
const remarkMut = mutate(
  contractText,
  "**施工备注（受控夹具）**：夹具备注原文。",
  "**施工备注（受控夹具）**：顺手改了备注。",
);
ok(
  remarkMut.applied &&
    hashOf(remarkMut.text, "C-1") === hashOf(contractText, "C-1") &&
    planDefinitionDigest(remarkMut.text) === digestBefore,
  "① 改「施工备注」执行备注（夹具）：定义哈希不变（执行日志不进定义）",
);
const historyMut = mutate(contractText, CONTRACT_HISTORY_ROW, "| Q25 | 改成别的话 |");
ok(
  historyMut.applied &&
    hashOf(historyMut.text, "C-1") === hashOf(contractText, "C-1") &&
    planDefinitionDigest(historyMut.text) === digestBefore,
  "① 改历史归档区（夹具旧表 Q25 行）：定义哈希不变（历史区不参与任务定义）",
);
const goalMut = mutate(contractText, "| C-2 | doing | 砌墙 |", "| C-2 | doing | 砌墙（改口径） |");
ok(
  goalMut.applied &&
    hashOf(goalMut.text, "C-2") !== hashOf(contractText, "C-2") &&
    planDefinitionDigest(goalMut.text) !== digestBefore &&
    hashOf(goalMut.text, "C-1") === hashOf(contractText, "C-1") &&
    hashOf(goalMut.text, "C-3") === hashOf(contractText, "C-3"),
  "① 改「交付目标」（夹具）：只有该卡的定义哈希变（C-2 变；C-1/C-3 不变）",
);
const defOnly = definitionOnlyText(tataiPlanText);
ok(
  defOnly.includes("完成证据") &&
    !defOnly.split("\n").some((l) => l.includes("施工备注")) &&
    sha256Hex(defOnly) === planDefinitionDigest(tataiPlanText),
  "① definition_digest 覆盖范围 = 定义区行（状态列清零、勾选位归一、施工备注段整段剔除）",
);

// ①-4 四类结构错误点名 id
const dupDoc = planFixture({
  rows: ["| T-1 | todo | 打地基 |  | 证据一 |", "| T-1 | todo | 重复卡号 | T-1 | 证据二 |"],
});
const dupIssues = validateTaskDefinitions(importTaskDefinitions(dupDoc).definitions, true);
ok(
  dupIssues.some((i) => i.problem === "duplicate_id" && i.ids.includes("T-1")) &&
    dupIssues.find((i) => i.problem === "duplicate_id")!.detail.includes("行"),
  `① 重复 ID → 点名 T-1（${dupIssues.find((i) => i.problem === "duplicate_id")?.detail}）`,
);
const caseDoc = planFixture({
  rows: ["| T-1 | todo | 打地基 |  | 证据一 |", "| t-1 | todo | 换个大小写就想换身份 |  | 证据二 |"],
});
const caseIssues = validateTaskDefinitions(importTaskDefinitions(caseDoc).definitions, true);
ok(
  caseIssues.some((i) => i.problem === "duplicate_id" && i.ids.includes("T-1") && i.ids.includes("t-1")),
  `① 稳定 ID：大小写不同的同一个卡号也判重复（${caseIssues.find((i) => i.problem === "duplicate_id")?.detail}）`,
);
const danglingDoc = planFixture({
  rows: ["| T-1 | todo | 打地基 |  | 证据一 |", "| T-2 | todo | 砌墙 | T-99 | 证据二 |"],
});
const danglingIssues = validateTaskDefinitions(importTaskDefinitions(danglingDoc).definitions, true);
ok(
  danglingIssues.some((i) => i.problem === "dangling_dependency" && i.ids.includes("T-99")),
  `① 悬空依赖 → 点名 T-99（${danglingIssues.find((i) => i.problem === "dangling_dependency")?.detail}）`,
);
const cycleDoc = planFixture({
  rows: [
    "| T-1 | todo | 打地基 | T-3 | 证据一 |",
    "| T-2 | todo | 砌墙 | T-1 | 证据二 |",
    "| T-3 | todo | 上梁 | T-2 | 证据三 |",
  ],
});
const cycleIssues = validateTaskDefinitions(importTaskDefinitions(cycleDoc).definitions, true);
ok(
  cycleIssues.some(
    (i) => i.problem === "dependency_cycle" && i.ids.length === 3 && i.detail.includes("→"),
  ),
  `① 循环依赖 → 报出环路径（${cycleIssues.find((i) => i.problem === "dependency_cycle")?.detail}）`,
);
const missingDoc = planFixture({ rows: ["| T-1 | todo |  |  | 地基验收记录 |", "| T-2 | todo | 砌墙 | T-1 |  |"] });
const missingIssues = validateTaskDefinitions(importTaskDefinitions(missingDoc).definitions, true);
ok(
  missingIssues.some(
    (i) => i.problem === "missing_acceptance" && i.ids.includes("T-1") && i.ids.includes("T-2"),
  ),
  `① 缺验收要求 → 点名两条（${missingIssues.find((i) => i.problem === "missing_acceptance")?.detail}）`,
);
const assertErr = workErrorOf(() => assertTaskDefinitionsValid(importTaskDefinitions(cycleDoc).definitions, "夹具施工图", true));
ok(
  assertErr?.code === "INVALID_COMMAND" &&
    issuesOf(assertErr as unknown as { detail: Record<string, unknown> }).length === 1,
  "① 校验不通过即抛 INVALID_COMMAND（带上全部问题与点名 id，拒绝导入）",
);
const noTable = validateTaskDefinitions([], false);
ok(noTable[0]?.problem === "no_table", "① 没有合格表 → no_table（不退回别的表猜任务）");

// ═══════════════════════════ ② v1→v2 迁移 ═══════════════════════════

console.log("");
info("═══ ② v1→v2 预览 / 备份 / 应用 / 校验 / 回滚 / 兼容投影 ═══");

// 台账夹具：CRLF + 自定义字段顺序 + 取消标记 + 用户自己的文件（回滚不能丢）
const V1_TASKS_JSONL = [
  "{",
  '  "version": 1,',
  '  "tasks": [',
  '    {',
  '      "id": "T-1",',
  '      "title": "打地基",',
  '      "module_id": "m-1",',
  '      "status": "todo",',
  '      "reporter": "kimi-code",',
  '      "updated_at": "2026-09-19T10:00:00+08:00",',
  '      "note": "等料"',
  "    },",
  '    {',
  '      "id": "T-2",',
  '      "title": "砌墙",',
  '      "module_id": "m-1",',
  '      "status": "doing",',
  '      "reporter": "kimi-code",',
  '      "updated_at": "2026-09-19T11:00:00+08:00"',
  "    },",
  '    {',
  '      "id": "T-3",',
  '      "title": "上梁",',
  '      "module_id": "m-1",',
  '      "status": "done",',
  '      "reporter": "kimi-code",',
  '      "updated_at": "2026-09-19T12:00:00+08:00",',
  '      "note": "结果已交"',
  "    },",
  '    {',
  '      "id": "T-4",',
  '      "title": "收尾",',
  '      "module_id": "m-2",',
  '      "status": "blocked",',
  '      "reporter": "kimi-code",',
  '      "updated_at": "2026-09-19T13:00:00+08:00"',
  "    },",
  '    {',
  '      "id": "T-5",',
  '      "title": "废弃卡",',
  '      "module_id": "m-2",',
  '      "status": "todo",',
  '      "cancelled": true,',
  '      "cancelled_reason": "需求取消",',
  '      "reporter": "kimi-code",',
  '      "updated_at": "2026-09-19T14:00:00+08:00"',
  "    }",
  "  ]",
  "}",
  "",
].join("\r\n");
const V1_PROGRESS_JSON = [
  "{",
  '  "version": 1,',
  '  "modules": [',
  '    { "id": "m-1", "name": "主体", "status": "doing" },',
  '    { "id": "m-2", "name": "收尾", "status": "issue" }',
  "  ],",
  '  "gate": {',
  '    "current_step": "kickoff",',
  '    "history": []',
  "  }",
  "}",
  "",
].join("\r\n");
const USER_NOTE = "# 我的私有笔记\n\r\n这行是用户自己的数据，迁移与回滚都不能动它。\n";
writeBytes(path.join(workbench(migRoot), "tasks.json"), Buffer.from(V1_TASKS_JSONL, "utf8"));
writeBytes(path.join(workbench(migRoot), "progress.json"), Buffer.from(V1_PROGRESS_JSON, "utf8"));
writeBytes(path.join(workbench(migRoot), "我的笔记.md"), Buffer.from(USER_NOTE, "utf8"));

const tasksFileMig = path.join(workbench(migRoot), "tasks.json");
const progressFileMig = path.join(workbench(migRoot), "progress.json");
const noteFileMig = path.join(workbench(migRoot), "我的笔记.md");
const snapshotBytes = () => ({
  tasks: fs.readFileSync(tasksFileMig),
  progress: fs.readFileSync(progressFileMig),
  note: fs.readFileSync(noteFileMig),
  dir: fs.readdirSync(workbench(migRoot)).sort().join(","),
});
const beforeBytes = snapshotBytes();

ok(
  !isMigratedProject("mig", dataDir) &&
    readV1Snapshot("mig", dataDir).tasks.length === 5 &&
    readV1Snapshot("mig", dataDir).tasks.filter((t) => t.cancelled).length === 1,
  "② 迁移前：台账是 v1（5 条任务，其中 1 条带明确取消标记），项目未被判为已迁移",
);

// ②-1 真实项目必须被拒（本卡只迁移隔离夹具）
const noIsolation = workErrorOf(() => previewMigration("mig", dataDir));
// V07-03（2026-09-22）文案随解锁演进：V06-10 前置已满足，真实迁移改走 real:{authorized_by,basis}
// 显式授权（留痕进备份 manifest）。判据本体不变：未声明 → INVALID_COMMAND + real_project_migration_not_allowed。
ok(
  noIsolation?.code === "INVALID_COMMAND" && reasonOf(noIsolation) === "real_project_migration_not_allowed" &&
    noIsolation!.message.includes("real:{authorized_by,basis}"),
  "② 未声明隔离夹具/授权 → 迁移预览被拒（真实切换须 real 授权留痕，§2.6）",
);
for (const [label, fn] of [
  ["backup", () => backupV1Files("mig", dataDir)],
  ["apply", () => applyMigration("mig", dataDir)],
  ["validate", () => validateMigration("mig", dataDir)],
  ["rollback", () => rollbackMigration("mig", dataDir)],
] as [string, () => unknown][]) {
  const e = workErrorOf(fn);
  ok(
    e?.code === "INVALID_COMMAND" && reasonOf(e) === "real_project_migration_not_allowed",
    `② ${label} 同样要求显式 isolated 声明（拒绝动真实项目）`,
  );
}

// ②-2 预览：列出将发生什么，不落盘
const preview = previewMigration("mig", dataDir, { isolated: true });
ok(
  preview.events.length === 5 &&
    preview.events.find((e) => e.task_id === "T-3")!.v2_status === "result_submitted" &&
    preview.events.find((e) => e.task_id === "T-1")!.v2_status === "preparing" &&
    preview.events.find((e) => e.task_id === "T-2")!.v2_status === "executing" &&
    preview.events.find((e) => e.task_id === "T-4")!.v2_status === "blocked",
  `② 预览的映射（${preview.events.map((e) => `${e.task_id}:${e.v1_status}→${e.v2_status}`).join("、")}）`,
);
ok(
  preview.events.find((e) => e.task_id === "T-5")!.type === "task.cancelled" &&
    preview.events.find((e) => e.task_id === "T-5")!.payload.cancelled === true,
  "② 预览：带明确取消标记的任务映射成 task.cancelled（并带上取消原因）",
);
const previewJson = JSON.stringify(preview.events);
ok(
  !/已交付|已验收|审计通过|人工验收接受(?!（)/.test(previewJson) &&
    preview.events.find((e) => e.task_id === "T-3")!.mapping_note.includes("不补造审计"),
  "② 预览：done 只映射「结果已提交」——没有任何事件把 done 说成已交付/已验收",
);
await sleep(20);
ok(
  JSON.stringify({ ...beforeBytes, dir: beforeBytes.dir }) === JSON.stringify({ ...snapshotBytes(), dir: beforeBytes.dir }) &&
    !fs.existsSync(projectWorkDir("mig", dataDir)),
  "② 预览不落盘（台账/进度/用户文件逐字节不变，也没建 work/ 目录）",
);

// ②-3 备份：整份复制 + 逐字节哈希清单
const backup = backupV1Files("mig", dataDir, { isolated: true });
const manifest = readBackupManifest("mig", backup.backup_id, dataDir);
const backupDir = path.join(projectWorkDir("mig", dataDir), "migration-backup", backup.backup_id);
ok(
  fs.existsSync(path.join(backupDir, "manifest.json")) &&
    manifest.files.length >= 3 &&
    manifest.files.every((f) => fs.existsSync(path.join(backupDir, f.rel))) &&
    manifest.files.every((f) => sha256Hex(fs.readFileSync(path.join(backupDir, f.rel))) === f.sha256),
  `② 备份落到 .工作台/work/migration-backup/<时间戳>/（${manifest.files.length} 个文件，逐字节哈希清单对得上）`,
);
ok(
  fs.readFileSync(path.join(backupDir, "tasks.json")).equals(beforeBytes.tasks) &&
    fs.readFileSync(path.join(backupDir, "progress.json")).equals(beforeBytes.progress) &&
    fs.readFileSync(path.join(backupDir, "我的笔记.md")).equals(beforeBytes.note) &&
    backup.dir_rel.includes("migration-backup"),
  "② 备份是整份逐字节复制（CRLF 行尾与字段顺序一起抱住，含用户自己的文件）",
);

// ②-4 应用：经唯一写入者提交事件 + 写兼容投影
const applied = applyMigration("mig", dataDir, { isolated: true });
const workDirMig = projectWorkDir("mig", dataDir);
const loadedEvents = loadEvents(workDirMig).events;
const stateSnap = readSnapshotFromDisk(workDirMig)!;
const statesAfter = readTaskStates(workDirMig);
ok(
  applied.receipts.length === 5 &&
    applied.receipts.every((r) => r.duplicate === false) &&
    loadedEvents.length === 5 &&
    loadedEvents.every((e, i) => e.seq === i + 1 && e.type.startsWith("task.")) &&
    stateSnap.last_seq === 5,
  `② apply：5 条事件经唯一写入者落盘（seq 1..5 无洞）、快照 last_seq=${stateSnap.last_seq}`,
);
ok(
  statesAfter.states["T-3"].status === "result_submitted" &&
    statesAfter.states["T-3"].status_label === "结果已提交" &&
    statesAfter.states["T-1"].status === "preparing" &&
    statesAfter.states["T-2"].status === "executing" &&
    statesAfter.states["T-4"].status === "blocked" &&
    statesAfter.states["T-5"].cancelled === true &&
    statesAfter.states["T-5"].cancel_reason === "需求取消",
  `② 事件推出的状态与 §5.4 映射一致（${Object.values(statesAfter.states)
    .map((s) => `${s.task_id}:${s.status}`)
    .join("、")}）`,
);
ok(
  !/已交付|已验收/.test(JSON.stringify(statesAfter)) &&
    (statesAfter.states["T-3"].status as string) !== "done" &&
    statesAfter.states["T-3"].status === "result_submitted",
  "② 旧 done 只到「结果已提交」：状态里没有「已交付/已验收」这种升级",
);
const projectionOnDisk = JSON.parse(read(tasksFileMig)) as CompatTasksFile;
ok(
  hasV2ProjectionMarker(projectionOnDisk) &&
    projectionOnDisk.projection_of === "work/events.jsonl" &&
    projectionOnDisk.last_seq === 5 &&
    projectionOnDisk.status_semantics.includes("不是事实源"),
  `② 兼容投影带标记（projection_of=${projectionOnDisk.projection_of}，last_seq=${projectionOnDisk.last_seq}）且显式声明不是事实源`,
);
ok(
  projectionOnDisk.tasks.find((t) => t.id === "T-3")!.status === "done" &&
    projectionOnDisk.tasks.find((t) => t.id === "T-3")!.v2_status === "result_submitted" &&
    projectionOnDisk.tasks.find((t) => t.id === "T-3")!.title === "上梁" &&
    projectionOnDisk.tasks.find((t) => t.id === "T-5")!.cancelled === true &&
    projectionOnDisk.tasks.find((t) => t.id === "T-1")!.note === "等料",
  "② 兼容投影保留 v1 台账的 title/note，并带上 v2_status（v1 done 仍是「结果已提交」）",
);
ok(
  listTasks("mig", dataDir).length === 5 && readTasks("mig", dataDir).tasks.length === 5,
  "② 旧读口仍能读兼容投影（v1 四态读回不退化；投影只是多带了 v2 补充字段）",
);
ok(isMigratedProject("mig", dataDir), "② 迁移后项目被判为已迁移（台账带标记 + 事件在场）");

// ②-5 旧写工具拒写（缺版本/认领参数）
const refuseStatus = wsErrorOf(() => setTaskStatus("mig", "T-3", "doing", dataDir));
const refuseAdd = wsErrorOf(() => addTask("mig", { id: "T-9", title: "新卡", module_id: "m-1", reporter: "x" }, dataDir));
const refuseModule = wsErrorOf(() => setModuleStatus("mig", "m-1", "done", dataDir));
// 2026-09-22（批外缺陷修复）：`addModule` 此前漏挂同款闸门——"建模块"这条 v1 口子还开着，
// 已迁移项目仍能经 `POST /projects/:id/modules` 往 progress.json 写 v1 事实（真实项目实测过）。
const refuseModuleAdd = wsErrorOf(() => addModule("mig", { id: "m-9", name: "新模块", status: "done" }, dataDir));
ok(
  refuseStatus?.code === "WRITE_UPGRADE_REQUIRED" &&
    refuseStatus.message.includes("schema_version") &&
    refuseStatus.message.includes("expected_revision") &&
    refuseStatus.message.includes("claim_token") &&
    refuseStatus.message.includes("v2"),
  `② 旧写工具拒写并给出升级要求（缺：schema_version/expected_revision/claim_token；${refuseStatus?.code}）`,
);
ok(
  refuseAdd?.code === "WRITE_UPGRADE_REQUIRED" &&
    refuseModule?.code === "WRITE_UPGRADE_REQUIRED" &&
    refuseModuleAdd?.code === "WRITE_UPGRADE_REQUIRED",
  "② 新增任务 / 模块四色 / **新增模块**三个旧写口同样被拒（拒写不挑入口）",
);
ok(
  fs.readFileSync(tasksFileMig).equals(Buffer.from(JSON.stringify(projectionOnDisk, null, 2) + "\n", "utf8")) &&
    fs.readFileSync(progressFileMig).equals(beforeBytes.progress),
  "② 四次拒写都没落一个字节（台账 != 被 v1 覆盖；progress.json 原样）",
);
const gateUnmigrated = v1TaskWriteGate({
  work_dir: projectWorkDir("plain", dataDir),
  tasks_file: path.join(workbench(plainRoot), "tasks.json"),
  what: "probe",
});
ok(
  gateUnmigrated.allowed &&
    v1TaskWriteGate({ work_dir: workDirMig, tasks_file: tasksFileMig, what: "probe" }).allowed === false,
  "② 闸门口径：未迁移项目 allowed、有 v2 投影/事件的项目 refused（同一份判据两向都测）",
);

// ②-6 校验（含"投影被改过"这种坏现场）
const validated = validateMigration("mig", dataDir, { isolated: true });
ok(
  validated.ok &&
    validated.checks.every((c) => c.ok) &&
    validated.checks.some((c) => c.name === "映射口径正确"),
  `② validate 全绿（${validated.checks.map((c) => c.name).join(" / ")}）`,
);
const tampered = { ...projectionOnDisk, tasks: projectionOnDisk.tasks.map((t) => ({ ...t })) };
tampered.tasks[0].status = "done";
write(tasksFileMig, JSON.stringify(tampered, null, 2) + "\n");
const afterTamper = validateMigration("mig", dataDir, { isolated: true });
ok(
  !afterTamper.ok && afterTamper.problems.some((p) => p.includes("兼容投影一致")),
  `② 手改兼容投影后 validate 报红（${afterTamper.problems.join("；").slice(0, 60)}…）`,
);
write(tasksFileMig, JSON.stringify(projectionOnDisk, null, 2) + "\n");
const applyTwice = workErrorOf(() => applyMigration("mig", dataDir, { isolated: true }));
ok(
  applyTwice?.code === "INVALID_COMMAND" && reasonOf(applyTwice) === "already_migrated",
  "② 重复 apply 被拒（已迁移项目不重复迁移；要回 v1 走 rollback）",
);

// ②-7 回滚：逐字节还原用户原始数据 + v1 写口恢复
const svc = new WorkService({ dataDir });
submitTaskStatus(svc, {
  project_id: "mig",
  task_id: "T-1",
  change_id: "post-migrate-change",
  actor_id: "kimi-code",
  role: "executor",
  expected_revision: readTaskStates(workDirMig).states["T-1"].revision,
  status: "executing",
});
const eventsBeforeRollback = loadEvents(workDirMig).events.length;
const rolled = rollbackMigration("mig", dataDir, { isolated: true });
const afterRollback = snapshotBytes();
ok(
  afterRollback.tasks.equals(beforeBytes.tasks) &&
    afterRollback.progress.equals(beforeBytes.progress) &&
    afterRollback.note.equals(beforeBytes.note),
  `② 回滚逐字节还原用户原始数据（tasks/progress/用户笔记 全等；行尾与字段顺序一并还原）`,
);
ok(
  rolled.restored.length >= 3 &&
    rolled.restored.every((r) => r.matches_backup) &&
    rolled.restored.find((r) => r.rel === "tasks.json")!.sha256 === manifest.files.find((f) => f.rel === "tasks.json")!.sha256,
  `② 回滚逐文件复核哈希（${rolled.restored.map((r) => r.rel).join("、")}）`,
);
ok(
  rolled.archived.some((p) => p.endsWith("events.jsonl")) &&
    !fs.existsSync(path.join(workDirMig, "events.jsonl")) &&
    fs.readFileSync(path.join(projectWorkDir("mig", dataDir), "migration-archived", path.basename(rolled.archive_dir_rel!), "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "").length === eventsBeforeRollback,
  `② 回滚把 v2 事件移进归档目录（${eventsBeforeRollback} 条事件一条不删，只搬位置）`,
);
ok(
  rolled.v1_writes_allowed && !isMigratedProject("mig", dataDir) && !hasV2ProjectionMarker(JSON.parse(read(tasksFileMig))),
  "② 回滚后项目回到 v1（台账不再是投影、事件已归档）：旧写口恢复可用",
);
const restoredWrite = setTaskStatus("mig", "T-2", "done", dataDir, "回滚后继续用 v1 上报");
ok(
  restoredWrite.status === "done" &&
    JSON.parse(read(tasksFileMig)).tasks.find((t: { id: string }) => t.id === "T-2").status === "done" &&
    !fs.existsSync(path.join(workDirMig, "events.jsonl")),
  "② 回滚后 v1 上报恢复可用（且没有偷偷写 v2 文件让旧程序误读）",
);

// ═══════════════════════════ ③ 状态投影（定义与状态分离） ═══════════════════════════

console.log("");
info("═══ ③ 状态投影：定义哈希不变 / 待重绑 / 同源 / 投影默认关闭 ═══");

const defsPlanPath = path.join(workbench(defsRoot), "plan.md");
const defsWorkDir = projectWorkDir("defs", dataDir);
const defsSvc = new WorkService({ dataDir });
const imported0 = importTaskDefinitions(PLAN_BASE);
const hashes0 = new Map(imported0.definitions.map((d) => [d.task_id, taskDefinitionHash(d)]));
const imports = submitDefinitionImports(defsSvc, {
  project_id: "defs",
  change_id: "defs-import-1",
  actor_id: "kimi-code",
  role: "executor",
  definitions: imported0.definitions,
});
const states0 = readTaskStates(defsWorkDir);
ok(
  imports.length === 3 &&
    Object.keys(states0.states).length === 3 &&
    states0.states["T-2"].definition_sha256 === hashes0.get("T-2") &&
    states0.states["T-2"].plan_revision === imported0.definitions[0].plan_revision,
  "③ 定义导入是独立事件（task.definition_imported），逐条绑定 definition_sha256 + plan_revision",
);
ok(
  alignDefinitionsAndStates(imported0.definitions, states0.states, imported0.definitions[0].plan_revision!).same_source === true,
  "③ PLAN 与运行任务同源：每个运行状态都对得上当前定义",
);

// ③-1 状态更新不改变定义哈希
const statusSeq: [string, "claimed" | "executing" | "result_submitted" | "blocked"][] = [
  ["T-1", "claimed"],
  ["T-1", "executing"],
  ["T-2", "blocked"],
  ["T-3", "result_submitted"],
];
for (const [taskId, status] of statusSeq) {
  const current = readTaskStates(defsWorkDir).states[taskId];
  const definition = {
    definition_sha256: hashes0.get(taskId)!,
    plan_revision: current.plan_revision ?? "",
    definition_revision: 1,
  };
  if (status === "result_submitted") {
    // V09-47/P2 起 `task.result_submitted` 是**交付提交**事件（锁内要求当前认领 + 可追溯证据），
    // 而 `submitTaskStatus(result_submitted)` 仍按原语义产出它 ⇒ 会被锁内判据拒。本用例只想把卡
    // **置成历史状态**（不是一次新交付），按设计走**既有状态边界** `task.status_changed(status=
    // "result_submitted")`——与 `migrate.ts` 把 v1 `done` 折成 `result_submitted` 逐字同一形态
    // （不带交付包、不宣称交付判据通过）。用例原意（状态更新不改变定义哈希）与断言都不变。
    submitTaskEvent(defsSvc, {
      project_id: "defs",
      task_id: taskId,
      change_id: "defs-status-1",
      actor_id: "kimi-code",
      role: "executor",
      expected_revision: current.revision,
      type: "task.status_changed",
      payload: { status, ...definition },
    });
  } else {
    submitTaskStatus(defsSvc, {
      project_id: "defs",
      task_id: taskId,
      change_id: "defs-status-1",
      actor_id: "kimi-code",
      role: "executor",
      expected_revision: current.revision,
      status,
      definition,
    });
  }
}
const statesAfterStatus = readTaskStates(defsWorkDir);
const reimportedSame = importTaskDefinitions(read(defsPlanPath), {
  plan_revision: imported0.definitions[0].plan_revision ?? undefined,
});
ok(
  statesAfterStatus.states["T-1"].status === "executing" &&
    statesAfterStatus.states["T-2"].status === "blocked" &&
    statesAfterStatus.states["T-3"].status === "result_submitted",
  `③ 4 次状态事件生效（${Object.values(statesAfterStatus.states).map((s) => `${s.task_id}:${s.status}`).join("、")}）`,
);
ok(
  reimportedSame.definitions.every((d) => taskDefinitionHash(d) === hashes0.get(d.task_id)) &&
    planDefinitionDigest(read(defsPlanPath)) === imported0.report.definition_digest,
  "③ **状态更新不改变定义哈希**（4 次状态事件后重导，逐条定义哈希与区边界摘要都没变）",
);
ok(
  alignDefinitionsAndStates(reimportedSame.definitions, statesAfterStatus.states, imported0.definitions[0].plan_revision!).same_source,
  "③ 状态变化后仍然同源（状态事件不改绑定、不改定义）",
);

// ③-2 图纸修订使相关任务待重绑
const planRev = (r: { definitions: TaskDefinition[] }) => r.definitions[0].plan_revision!;
const PLAN_T2_GOAL = PLAN_BASE.replace("| T-2 | todo | 砌墙 |", "| T-2 | todo | 砌墙（改口径） |");
write(defsPlanPath, PLAN_T2_GOAL);
const imported2 = importTaskDefinitions(PLAN_T2_GOAL);
const diffs = diffTaskDefinitions(imported0.definitions, imported2.definitions);
const align2 = alignDefinitionsAndStates(imported2.definitions, statesAfterStatus.states, planRev(imported2));
ok(
  diffs.find((d) => d.task_id === "T-2")!.change === "definition_changed" &&
    diffs.find((d) => d.task_id === "T-2")!.changed_fields.includes("goal") &&
    diffs.find((d) => d.task_id === "T-1")!.change === "unchanged",
  `③ 图纸修订后逐任务比对：T-2 definition_changed（字段 ${diffs
    .find((d) => d.task_id === "T-2")!
    .changed_fields.join("、")}），T-1 unchanged`,
);
ok(
  align2.needs_rebind.length === 1 &&
    align2.needs_rebind[0].task_id === "T-2" &&
    align2.needs_rebind[0].bound_definition_sha256 === hashes0.get("T-2") &&
    align2.needs_rebind[0].current_definition_sha256 === taskDefinitionHash(imported2.definitions.find((d) => d.task_id === "T-2")!),
  "③ **图纸修订使相关任务待重绑**（只点名 T-2，带旧/新定义哈希；T-1 不受影响）",
);
ok(
  !align2.same_source && align2.revision_stale.includes("T-1") && align2.not_started.length === 0,
  "③ 同源判定为 false，且未改定义的 T-1 只记「修订绑定过期」（不算重绑）",
);

/** 把待重绑的任务逐条重绑到当前定义（§5.6 的可追溯修订），返回重绑条数 */
function rebindAll(definitions: TaskDefinition[], changeId: string): number {
  let n = 0;
  for (const def of definitions) {
    const cur = readTaskStates(defsWorkDir).states[def.task_id];
    if (cur === undefined || cur.definition_sha256 === taskDefinitionHash(def)) continue;
    submitTaskRebind(defsSvc, {
      project_id: "defs",
      task_id: def.task_id,
      change_id: changeId,
      actor_id: "kimi-code",
      role: "executor",
      expected_revision: cur.revision,
      from_definition_sha256: cur.definition_sha256,
      definition: def,
      disposition: "adjust",
    });
    n++;
  }
  return n;
}

const rebound1 = rebindAll(imported2.definitions, "defs-rebind-1");
const t2AfterGoalEdit = imported2.definitions.find((d) => d.task_id === "T-2")!;
const statesAfterRebind1 = readTaskStates(defsWorkDir);
ok(
  rebound1 === 1 &&
    statesAfterRebind1.states["T-2"].definition_sha256 === taskDefinitionHash(t2AfterGoalEdit) &&
    statesAfterRebind1.states["T-2"].status === "blocked" &&
    loadEvents(defsWorkDir).events.some(
      (e) => e.type === "task.rebound" && e.payload.disposition === "adjust" && e.payload.from_definition_sha256 !== null,
    ),
  "③ 重绑是可追溯事件（task.rebound 带 from/to 与继续|调整|暂停处置；执行状态不被静默改写）",
);
ok(
  alignDefinitionsAndStates(imported2.definitions, statesAfterRebind1.states, planRev(imported2)).needs_rebind.length === 0,
  "③ 重绑后不再待重绑（T-2 已绑到新定义）",
);

// 依赖卡的证据口径变化 → 依赖方连带重绑（"相关任务"的连带，§5.6「依赖不只是前卡 done」）
const PLAN_T1_EVIDENCE = PLAN_T2_GOAL.replace(
  "| T-1 | todo | 打地基 | 用户本轮授权 | 地基验收记录 |",
  "| T-1 | todo | 打地基 | 用户本轮授权 | 地基验收记录（加严） |",
);
write(defsPlanPath, PLAN_T1_EVIDENCE);
const imported3 = importTaskDefinitions(PLAN_T1_EVIDENCE);
const align3 = alignDefinitionsAndStates(imported3.definitions, statesAfterRebind1.states, planRev(imported3));
ok(
  align3.needs_rebind.map((r) => r.task_id).sort().join(",") === "T-1,T-2,T-3" &&
    diffTaskDefinitions(imported2.definitions, imported3.definitions)
      .find((d) => d.task_id === "T-2")!
      .changed_fields.includes("dependency_evidence"),
  `③ 依赖卡的完成证据口径变了 → 依赖方也进待重绑（${align3.needs_rebind
    .map((r) => r.task_id)
    .join("、")}；T-2 的字段差含 dependency_evidence）`,
);
const rebound2 = rebindAll(imported3.definitions, "defs-rebind-2");
const statesAfterRebind = readTaskStates(defsWorkDir);
ok(
  rebound2 === 3 &&
    alignDefinitionsAndStates(imported3.definitions, statesAfterRebind.states, planRev(imported3)).needs_rebind.length === 0,
  "③ 三条任务重绑后全部同源（重绑逐条留痕，不静默换输入）",
);

// 只改状态列 → 不触发重绑（只有修订绑定过期）
const PLAN_STATUS_ONLY = PLAN_T1_EVIDENCE.replace("| T-2 | todo |", "| T-2 | done |");
write(defsPlanPath, PLAN_STATUS_ONLY);
const imported4 = importTaskDefinitions(PLAN_STATUS_ONLY);
const align4 = alignDefinitionsAndStates(imported4.definitions, statesAfterRebind.states, planRev(imported4));
ok(
  align4.needs_rebind.length === 0 && align4.revision_stale.length === 3 && align4.same_source,
  `③ 只改表格「状态」列：不触发重绑（只登记修订绑定过期 ${align4.revision_stale.join("、")}）——派生状态不制造任务重绑`,
);

// ③-4 运行任务对不上定义 = 不同源
const ghostStates = { ...statesAfterRebind.states, GHOST: { ...statesAfterRebind.states["T-1"], task_id: "GHOST" } };
const ghostAlign = alignDefinitionsAndStates(imported4.definitions, ghostStates, imported4.definitions[0].plan_revision!);
ok(
  !ghostAlign.same_source &&
    ghostAlign.orphan_states.length === 1 &&
    ghostAlign.orphan_states[0].task_id === "GHOST",
  `③ 凭空开工的运行状态被判不同源（${ghostAlign.orphan_states[0]?.reason}）`,
);

// ③-5 兼容投影 = 派生（事实在事件里）
const compatOut = buildCompatTasksProjection({
  states: statesAfterRebind.states,
  previous: { tasks: [{ id: "T-1", title: "手写标题", module_id: "m-9", note: "旧备注" }] },
  last_seq: statesAfterRebind.last_seq,
  generated_at: "2026-09-20T00:00:00+08:00",
});
const compatFile = path.join(workbench(defsRoot), "tasks.json");
write(compatFile, JSON.stringify(compatOut, null, 2) + "\n");
ok(
  hasV2ProjectionMarker(JSON.parse(read(compatFile))) &&
    JSON.parse(read(compatFile)).tasks.find((t: { id: string }) => t.id === "T-1").title === "手写标题" &&
    JSON.parse(read(compatFile)).tasks.find((t: { id: string }) => t.id === "T-1").module_id === "m-9",
  "③ 兼容投影保留旧台账的 title/module_id/note（用户数据不丢，缺的才用定义兜底）",
);
write(compatFile, JSON.stringify({ ...compatOut, tasks: [{ id: "T-1", status: "done" }] }, null, 2) + "\n");
const reparsed = buildCompatTasksProjection({
  states: statesAfterRebind.states,
  previous: { tasks: [{ id: "T-1", title: "手写标题", module_id: "m-9", note: "旧备注" }] },
  last_seq: statesAfterRebind.last_seq,
  generated_at: "2026-09-20T00:00:00+08:00",
});
ok(
  JSON.stringify(reparsed) === JSON.stringify(compatOut) &&
    v1StatusOf("result_submitted") === "done" &&
    v1StatusOf("cancelled") === "todo",
  "③ 投影被手改不影响事实：从事件重放派生一次就逐字节还原（投影不是事实源）",
);
write(compatFile, JSON.stringify(reparsed, null, 2) + "\n"); // 还原成派生出来的那一份（后面 list_tasks 要读它）
const listTool = await toolText(listTasksTool.handler({ project_id: "defs" }));
const progressTool = await toolText(readProgressTool.handler({ project_id: "defs" }));
ok(
  JSON.parse(listTool.text).projection?.projection_of === "work/events.jsonl" &&
    JSON.parse(progressTool.text).tasks_projection?.last_seq === statesAfterRebind.last_seq,
  "③ list_tasks / read_progress 如实回报「台账是投影」（来源 + last_seq）",
);
const gateMigrated = v1TaskWriteGate({ work_dir: defsWorkDir, tasks_file: compatFile, what: "probe" });
ok(!gateMigrated.allowed && gateMigrated.message.includes("升级"), "③ 投影在场时闸门不放行（旧写工具不能覆盖投影）");
ok(
  tasksProjectionInfo("defs", dataDir)?.projection_of === "work/events.jsonl" &&
    tasksProjectionInfo("plain", dataDir) === null,
  "③ tasksProjectionInfo：投影项目有信息、普通项目为 null（读路径不谎报）",
);

// ③-6 施工图状态区投影：默认关闭（塔台的 PLAN.md 一个字节都不能动）
const planBeforeRender = fs.readFileSync(path.join(REPO, "PLAN.md"));
const rendered = renderPlanStatusRegion(tataiPlanText, {
  "V06-03": {
    ...statesAfterStatus.states["T-1"],
    task_id: "V06-03",
    status: "executing",
    status_label: "执行中",
  },
});
ok(
  rendered.state_column_found &&
    rendered.changed.includes("V06-03") &&
    rendered.text.includes("| V06-03 | 执行中 |") &&
    !rendered.text.includes("| V06-01 | 执行中 |") &&
    fs.readFileSync(path.join(REPO, "PLAN.md")).equals(planBeforeRender),
  "③ renderPlanStatusRegion 是纯函数（真文档：只换「状态」列那格、认得出那张表，PLAN.md 未被写）",
);
// 渲染契约的细节断言跑在受控夹具上（真文档不断言可变状态：上面那条只证明"不写盘 + 认得出表"）
const contractRendered = renderPlanStatusRegion(contractText, {
  "C-2": {
    ...statesAfterStatus.states["T-1"],
    task_id: "C-2",
    status: "executing",
    status_label: "执行中",
  },
});
ok(
  contractRendered.state_column_found &&
    JSON.stringify(contractRendered.changed) === JSON.stringify(["C-2"]) &&
    contractRendered.text.includes("| C-2 | 执行中 | 砌墙 |") &&
    contractRendered.text.includes("| C-1 | todo | 打地基 |") &&
    contractRendered.text.includes(CONTRACT_HISTORY_ROW) &&
    contractRendered.text.includes("**施工备注（受控夹具）**：夹具备注原文。"),
  "③ renderPlanStatusRegion（夹具）：只换目标卡「状态」列那格，其它卡/历史区/卡片正文一字不动",
);
const planProjectionRefused = workErrorOf(() =>
  writePlanStatusProjection({
    plan_path: path.join(REPO, "PLAN.md"),
    plan_text: tataiPlanText,
    states: {},
  }),
);
ok(
  planProjectionRefused?.code === "INVALID_COMMAND" &&
    reasonOf(planProjectionRefused) === "plan_status_projection_disabled" &&
    planProjectionRefused!.message.includes("allow_real_documents"),
  "③ 施工图状态投影默认关闭（没显式允许就拒写，并说清怎么开）",
);
const tmpPlan = path.join(tmpBase, "guarded-plan.md");
write(tmpPlan, PLAN_BASE);
const guardedWrite = writePlanStatusProjection({
  plan_path: tmpPlan,
  plan_text: read(tmpPlan),
  states: { "T-1": { ...statesAfterStatus.states["T-1"], task_id: "T-1" } },
  allow_real_documents: true,
});
ok(
  guardedWrite !== null &&
    guardedWrite.changed.includes("T-1") &&
    read(tmpPlan).includes("| T-1 | 执行中 |") &&
    read(tmpPlan).includes("已开工，等料") &&
    read(tmpPlan).includes("| Q25 |"),
  "③ 显式允许时才写（只改状态列；卡片正文与历史区不动）",
);

// ═══════════════════════════ ④ v1 行为逐字不变（未迁移项目） ═══════════════════════════

console.log("");
info("═══ ④ 未迁移项目的 v1 行为逐字不变（切换前继续 v1/§6.6） ═══");

const plainTasksFile = path.join(workbench(plainRoot), "tasks.json");
const report = await reportTaskStatusTool.handler(
  { project_id: "plain", task_id: "P-1", status: "doing", title: "打地基", module_id: "m-1", reporter: "kimi-code", note: "首报" },
  { clientName: "kimi-code" },
);
const plainTasks = readTasks("plain", dataDir);
const plainRecord = plainTasks.tasks[0];
const expectedFileText = JSON.stringify(
  {
    version: 1,
    tasks: [
      {
        id: "P-1",
        title: "打地基",
        module_id: "m-1",
        status: "doing",
        reporter: "kimi-code",
        updated_at: plainRecord.updated_at,
        note: "首报",
      },
    ],
  },
  null,
  2,
) + "\n";
ok(
  !report.isError &&
    report.content[0].text === JSON.stringify({ created: true, task: plainRecord, note: "首报" }, null, 2),
  "④ report_task_status 回执形状与返回值逐字不变（created/task/note，无新增字段）",
);
ok(
  read(plainTasksFile) === expectedFileText &&
    Object.keys(plainRecord).join(",") === "id,title,module_id,status,reporter,updated_at,note",
  "④ tasks.json 落盘逐字不变（{version:1,tasks:[…]}、字段顺序 id,title,module_id,status,reporter,updated_at,note、2 空格缩进 + 尾换行）",
);
ok(
  !fs.existsSync(path.join(workbench(plainRoot), "work")) &&
    !fs.readdirSync(workbench(plainRoot)).some((f) => f.endsWith(".lock")),
  "④ 未迁移项目里没有多出任何 v2 目录/锁文件（闸门是纯判据，零副作用）",
);
const progressToolPlain = await toolText(readProgressTool.handler({ project_id: "plain" }));
const listToolPlain = await toolText(listTasksTool.handler({ project_id: "plain" }));
ok(
  Object.keys(JSON.parse(progressToolPlain.text)).join(",") === "gate,modules" &&
    Object.keys(JSON.parse(listToolPlain.text)).join(",") === "tasks",
  "④ read_progress / list_tasks 的返回字段与迁移前一致（未迁移项目不多出 projection 字段）",
);
addModule("plain", { id: "m-1", name: "主体" }, dataDir); // 前置：v1 模块得先存在（MCP 只改四色，不建模块）
const updateToolPlain = await toolText(updateProgressTool.handler({ project_id: "plain", module_id: "m-1", status: "todo" }));
ok(
  !updateToolPlain.isError && Object.keys(JSON.parse(updateToolPlain.text)).join(",") === "module",
  "④ update_progress 在未迁移项目照常改模块四色（回执形状不变）",
);
// 已迁移的夹具是 `defs`（台账是 v2 投影）；`mig` 在上一段已经回滚回 v1，正好用来对照
const compatBytesBeforeRefuse = fs.readFileSync(compatFile);
const migratedReportTool = await toolText(
  reportTaskStatusTool.handler({ project_id: "defs", task_id: "T-2", status: "doing" }, { clientName: "kimi-code" }),
);
const migratedProgressTool = await toolText(
  updateProgressTool.handler({ project_id: "defs", module_id: "m-1", status: "done" }),
);
ok(
  migratedReportTool.isError &&
    migratedReportTool.text.includes("拒绝") &&
    migratedReportTool.text.includes("schema_version") &&
    migratedReportTool.text.includes("claim_token") &&
    migratedProgressTool.isError &&
    migratedProgressTool.text.includes("升级"),
  "④ 已迁移项目上 MCP 写工具如实返回升级要求（isError=true，含版本/认领缺失字段清单）",
);
ok(
  fs.readFileSync(compatFile).equals(compatBytesBeforeRefuse) &&
    JSON.parse(read(tasksFileMig)).tasks.find((t: { id: string }) => t.id === "T-2").status === "done",
  "④ 被拒的 MCP 写入没有改动任何台账（投影逐字节不变；回滚后的 v1 台账保持 done）",
);

// ═══════════════════════════ ⑤ 真服务端到端（v2 写入面不退化） ═══════════════════════════

console.log("");
info("═══ ⑤ 真服务进程端到端（v2 写入面仍只认唯一写入者） ═══");

const registryNow = JSON.parse(read(path.join(dataDir, "registry.json"))) as { version: number; projects: { id: string }[] };
writeRegistry(registryNow.projects.filter((p) => p.id !== "tatai"));
await assertPortFree(PORT);
const child = spawnServer({ TATAI_HOME: dataDir, TATAI_PORT: String(PORT) });
await waitUpOn(PORT);
const descriptor = JSON.parse(read(path.join(dataDir, "work-service.json"))) as { host: string; port: number; token: string };
const api = async (url: string, init?: RequestInit) => {
  const r = await fetch(`http://127.0.0.1:${descriptor.port}${url}`, init);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const commandRes = await api("/api/work/command", {
  method: "POST",
  headers: { "content-type": "application/json", "x-tatai-work-token": descriptor.token },
  body: JSON.stringify({
    schema_version: 2,
    project_id: "defs",
    change_id: "http-e2e",
    entity_id: taskEntityId("T-3"),
    expected_revision: readTaskStates(defsWorkDir).states["T-3"].revision,
    type: "task.status_changed",
    actor_id: "kimi-code",
    role: "executor",
    idempotency_key: "http-e2e:T-3:1",
    payload: { status: "executing" },
  }),
});
ok(
  commandRes.status === 200 && commandRes.body.ok === true,
  `⑤ 真服务进程接受任务事件（HTTP ${commandRes.status}，event_id=${
    String((commandRes.body as { event_id?: string }).event_id).slice(0, 8)
  }…）`,
);
const snapshotRes = await api(`/api/work/snapshot?project_id=defs`, {
  headers: { "x-tatai-work-token": descriptor.token },
});
ok(
  snapshotRes.status === 200 &&
    (snapshotRes.body as { stale: boolean }).stale === false &&
    readTaskStates(defsWorkDir).states["T-3"].status === "executing",
  "⑤ 端到端后本地重放与 HTTP 读写一致（唯一写入者仍是桌面服务进程）",
);
await stopChild(child);
await sleep(200);

// ═══════════════════════════ 收尾：文档零改动 + 清理 ═══════════════════════════

console.log("");
info("═══ 收尾：塔台根文档零改动 ═══");
const docHashesAfter = new Map(REPO_FILES.map((f) => [f, sha256File(path.join(REPO, f))]));
for (const [f, h] of docHashesAfter) {
  ok(docHashesBefore.get(f) === h, `⑤ 未改动 ${f}（sha256 ${h.slice(0, 16)}…）`);
}

console.log("");
console.log(`[verify] 结果：${passCount} PASS / ${failCount} FAIL`);
if (process.env.TATAI_KEEP_TMP !== "1") {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log("[verify] 已清理隔离夹具目录（TATAI_KEEP_TMP=1 可保留现场）");
} else {
  console.log(`[verify] 保留现场：${tmpBase}`);
}

// ── 辅助 ──

function spawnServer(env: Record<string, string>): ChildProcess {
  const proc = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(proc);
  proc.stdout.on("data", (d: Buffer) => {
    if (process.env.TATAI_VERBOSE === "1") process.stdout.write(`[server] ${d.toString()}`);
  });
  proc.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));
  return proc;
}

async function waitUpOn(port: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error(`后端 ${port} 端口 15 秒内未就绪`);
}

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

async function assertPortFree(port: number): Promise<void> {
  if (await portListening(port)) {
    console.error(`[verify] 后端起不来：端口 ${port} 被占用，先清理残留进程`);
    process.exit(1);
  }
}

async function stopChild(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGKILL");
  for (let i = 0; i < 40; i++) {
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
}
