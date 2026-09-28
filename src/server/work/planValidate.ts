// 施工图最小结构解析/校验（PLAN.md V06-02，DESIGN.md §2.7 / §2.9 / §3.5）。
//
// 本卡**只做最小**：把施工图里第一张合格 Markdown 表解析成任务行，并检查四件能让基线不合法的事。
// V06-03 在此基础上扩展完整 TaskDefinition（稳定 ID、范围/接口/风险等字段与迁移），
// 故这里刻意不加"顺手多写点"的字段校验——本文件的口径就是 V06-02 的验收口径。
//
// 解析口径（PLAN.md V06-02 检查项 2）：
//   · 只吃**第一张**表头同时含「卡号」「依赖」「完成证据」的 Markdown 表。
//     塔台自己的 PLAN.md 就是这种表（v0.6 施工卡表）；同一份文档里历史章节还有别的表
//     （「原登记 / v0.6 去向 / 责任卡」「工作包 / 首先定位的现有来源 / …」），表头不含这三个列名，
//     一律不吃——否则会把历史表格当成现行任务定义。
//   · 每行取 `id`（卡号列）、`交付目标`、`依赖`、`完成证据`；其余列（如「状态」）本卡不取：
//     状态是**派生**内容（DESIGN.md §2.6），不进施工定义哈希。
//   · 依赖列按 `、`、`,`、`，`、`/`、空白 切分（供应商写法不一，全按分隔符处理）。
//
// 校验口径（任一不通过即拒绝激活，错误里点名 id）：
//   ① 卡号重复；② 依赖悬空（依赖的 id 不在本表内）；③ 依赖成环；④ 缺验收内容（交付目标或完成证据为空单元格）。
//
// 依赖口径（2026-09-21 用户拍板与 V06-03 对齐；V06-02 旧口径曾把依赖列每个 token 都当依赖 id）：
//   只有「卡号形态」token（`isCardIdToken`：表内已有卡号忽略大小写相同，或形如字母数字加短折线且含数字）
//   才当依赖 id 参与悬空/成环判定；其余（塔台 `PLAN.md` 里 `DES-V06` 行的"用户本轮授权"、`V06-01` 行的
//   "施工授权"这类自然语言）是外部授权/前置条件，归 dependency_notes，**不算悬空依赖**——
//   与 V06-03 导入路径（work/plan.ts）同一份判据（分类器本尊在本文件，plan.ts 转发再导出）。
import crypto from "node:crypto";
import { WorkError } from "./types";

/** 表头必须同时含这三列，才算"施工卡表"（缺一不吃） */
export const PLAN_TABLE_REQUIRED_COLUMNS: readonly string[] = ["卡号", "依赖", "完成证据"];
export const PLAN_COLUMN_ID = "卡号";
export const PLAN_COLUMN_GOAL = "交付目标";
export const PLAN_COLUMN_DEPENDENCIES = "依赖";
export const PLAN_COLUMN_EVIDENCE = "完成证据";

/** 一张施工卡行（本卡最小字段；V06-03 扩展到完整 TaskDefinition） */
export interface PlanTask {
  /** 卡号（本表的稳定 id） */
  id: string;
  /** 交付目标（一句话目标） */
  goal: string;
  /** 依赖的卡号（已按分隔符切分；原样保留大小写与顺序） */
  dependencies: string[];
  /** 完成证据（验收内容；空 = 缺验收内容） */
  evidence: string;
  /** 原文行号（1 起），报错时能指回原文 */
  row: number;
}

export interface PlanTable {
  /** 原文行号（1 起） */
  start_line: number;
  header: string[];
  rows: PlanTask[];
}

/**
 * 结构问题种类。
 * `no_table` / `empty_table` / `empty_id` 是"根本解析不成任务行"的前置问题；
 * `duplicate_id` / `dangling_dependency` / `dependency_cycle` / `missing_acceptance`
 * 是 PLAN.md V06-02 明列的四个拒绝条件。
 */
export type PlanIssueProblem =
  | "no_table"
  | "empty_table"
  | "empty_id"
  | "duplicate_id"
  | "dangling_dependency"
  | "dependency_cycle"
  | "missing_acceptance"
  // 下面两条是 T21（I-1/I-2）补的跨对象引用问题：任务定义里的 requirement_ids / change_id
  // 在**投影**里解析不到就是悬空。它们不在本文件的校验里产出（本文件只吃文档本身），
  // 由 `references.ts` 的跨对象校验按同一套 PlanIssue 表述发出——同族风格，不另立一套错误形态。
  | "dangling_requirement"
  | "dangling_change"
  // 下面两条是 V09-03（附录 E.2）补的需求映射表问题：承接了不存在的卡、或「当前有效」行
  // 缺需求 id / 承接卡为空（空登记）。同样由 `references.ts` 的受检导入路径发出，不在本文件产出。
  | "dangling_map_card"
  | "incomplete_requirement_map";

export interface PlanIssue {
  problem: PlanIssueProblem;
  /** 点名的 id（空数组 = 与具体卡号无关，如"没有合格表"） */
  ids: string[];
  /** 一行可读说明（含缺失的依赖 id / 成环路径 / 行号） */
  detail: string;
}

// ── 解析 ──

/**
 * 单个 Markdown 表格行：拆出单元格（尊重 `\|` 转义；去掉首尾的表格边框竖线）。
 * 导出：补修 C（V06-09）读「集成检查要求」那张独立表时复用同一套切分口径，
 * 不为同一件事写第二个解析器。**原行为逐字不变**。
 */
export function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  const inner = trimmed.slice(1, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && inner[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** 分隔行（`| --- | :--: |`）：每个单元格只有 -、: 与空白，且至少两个 -（导出理由同 `splitTableRow`） */
export function isSeparatorRow(line: string): boolean {
  const cells = splitTableRow(line);
  if (cells === null || cells.length === 0) return false;
  return cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s+/g, "")));
}

/** 表头单元格归一：去反引号/星号/空白（容 `**卡号**`、`\`卡号\`` 一类写法） */
function normalizeCell(text: string): string {
  return text.replace(/[`*]/g, "").replace(/\s+/g, "").trim();
}

/** 依赖列切分：`、`、`,`、`，`、`/` 与空白都是分隔符（顺序保留，空段丢弃） */
export function splitDependencies(cell: string): string[] {
  return cell
    .split(/[、,，/\s]+/)
    .map((s) => s.replace(/[`*]/g, "").trim())
    .filter((s) => s !== "");
}

/** 卡号形态：字母打头，字母数字串，可用 `-` / `_` 连接（如 `V06-03`、`DES-V06-CLARIFY`、`T-9`） */
export const CARD_ID_RE = /^[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*$/;

/**
 * token 是不是"卡号形态"（DESIGN/PLAN V06-03 的依赖口径；2026-09-21 起也是本文件悬空判定的口径）：
 *   · 与本文档表内某卡号逐字或忽略大小写相同 → 是（即使不含数字，如 `ABC`）；
 *   · 否则必须形如字母数字加短折线**且含数字**（`V06-03`、`T-9`）→ 是；
 *   · 其余（「用户本轮授权」「施工授权」「审读问题」…）→ 否，归 dependency_notes，不算悬空依赖。
 */
export function isCardIdToken(token: string, known: ReadonlySet<string>): boolean {
  const t = token.trim();
  if (t === "") return false;
  for (const id of known) {
    if (id !== "" && id.toLowerCase() === t.toLowerCase()) return true;
  }
  return CARD_ID_RE.test(t) && /\d/.test(t) && t.length <= 40;
}

/**
 * 解析文档里**第一张**表头同时含「卡号」「依赖」「完成证据」的表。
 * 找不到合格表返回 null（不猜、不退回别的表——历史表格不是现行施工定义）。
 */
export function parsePlanTable(markdown: string): PlanTable | null {
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const header = splitTableRow(lines[i]);
    if (header === null) continue;
    if (!isSeparatorRow(lines[i + 1] ?? "")) continue; // 表头下面必须紧跟分隔行，否则不是表格
    const normalized = header.map(normalizeCell);
    if (!PLAN_TABLE_REQUIRED_COLUMNS.every((c) => normalized.includes(c))) continue;

    const colOf = (name: string): number => normalized.indexOf(name);
    const idCol = colOf(PLAN_COLUMN_ID);
    const goalCol = colOf(PLAN_COLUMN_GOAL);
    const depCol = colOf(PLAN_COLUMN_DEPENDENCIES);
    const evCol = colOf(PLAN_COLUMN_EVIDENCE);

    const rows: PlanTask[] = [];
    for (let j = i + 2; j < lines.length; j++) {
      const cells = splitTableRow(lines[j]);
      if (cells === null) break; // 表格结束
      if (isSeparatorRow(lines[j])) continue;
      const at = (idx: number): string => (idx >= 0 && idx < cells.length ? cells[idx] : "");
      rows.push({
        id: normalizeCell(at(idCol)),
        // 交付目标列缺席时按空处理 → 由「缺验收内容」点名（不静默当成合法）
        goal: goalCol >= 0 ? at(goalCol).trim() : "",
        dependencies: splitDependencies(at(depCol)),
        evidence: at(evCol).trim(),
        row: j + 1,
      });
    }
    return { start_line: i + 1, header: normalized, rows };
  }
  return null;
}

/** 解析失败（没有合格表）时给一张空表的语义：rows = []，由校验给出 `no_table` */
export function parsePlanTasks(markdown: string): PlanTask[] {
  return parsePlanTable(markdown)?.rows ?? [];
}

// ── 校验 ──

/** 找所有处在环上的 id，并给出一个具体环路径（报错要能看懂） */
function findCycles(ids: string[], deps: Map<string, string[]>): { ids: Set<string>; example: string[] } {
  const inCycle = new Set<string>();
  let example: string[] = [];
  for (const start of ids) {
    // 从 start 出发，看能不能回到 start（只走本表内的边；悬空依赖不参与成环判定）
    const stack: { id: string; path: string[] }[] = [{ id: start, path: [start] }];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const { id, path } = stack.pop()!;
      for (const next of deps.get(id) ?? []) {
        if (next === start) {
          const cycle = [...path, start];
          for (const n of path) inCycle.add(n);
          if (example.length === 0 || cycle.length < example.length) example = cycle;
          continue;
        }
        if (seen.has(next) || !deps.has(next)) continue;
        seen.add(next);
        stack.push({ id: next, path: [...path, next] });
      }
    }
  }
  return { ids: inCycle, example };
}

/**
 * 校验任务行，返回**全部**问题（不早退：一次报清，省得改一条跑一次）。
 * 输入一般是 `parsePlanTable(...).rows`；表缺席/空表也要给出问题，故允许 rows 为空。
 */
export function validatePlanTasks(rows: PlanTask[], tableFound = true): PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (!tableFound) {
    return [
      {
        problem: "no_table",
        ids: [],
        detail: `没有找到表头同时含「${PLAN_TABLE_REQUIRED_COLUMNS.join("」「")}」的 Markdown 表`,
      },
    ];
  }
  if (rows.length === 0) {
    return [{ problem: "empty_table", ids: [], detail: "施工卡表存在但一行任务都没有" }];
  }

  // ① 卡号重复
  const byId = new Map<string, PlanTask[]>();
  for (const r of rows) {
    const list = byId.get(r.id) ?? [];
    list.push(r);
    byId.set(r.id, list);
  }
  const dupIds = [...byId.entries()].filter(([, list]) => list.length > 1).map(([id]) => id);
  if (dupIds.length > 0) {
    issues.push({
      problem: "duplicate_id",
      ids: dupIds.sort(),
      detail: dupIds
        .map((id) => `${id}（行 ${byId.get(id)!.map((r) => r.row).join("、")}）`)
        .join("；"),
    });
  }
  // 空卡号：解析不成任务行（与"卡号重复"不是一回事，单独点名行号）
  const emptyIdRows = rows.filter((r) => r.id === "").map((r) => r.row);
  if (emptyIdRows.length > 0) {
    issues.push({
      problem: "empty_id",
      ids: [""],
      detail: `卡号列为空的行：${emptyIdRows.join("、")}`,
    });
  }

  // ② 依赖悬空（V06-03 口径：非卡号形态 token 归 dependency_notes，不算悬空——判据见 isCardIdToken）
  const known = new Set(rows.map((r) => r.id));
  const dangling = new Map<string, string[]>(); // 缺失的 id → 谁依赖它
  for (const r of rows) {
    for (const dep of r.dependencies) {
      if (known.has(dep)) continue;
      if (!isCardIdToken(dep, known)) continue;
      const who = dangling.get(dep) ?? [];
      who.push(r.id);
      dangling.set(dep, who);
    }
  }
  if (dangling.size > 0) {
    issues.push({
      problem: "dangling_dependency",
      ids: [...dangling.keys()].sort(),
      detail: [...dangling.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([dep, who]) => `${dep}（被 ${[...new Set(who)].join("、")} 依赖，本表内不存在）`)
        .join("；"),
    });
  }

  // ③ 依赖成环（只算本表内的边）
  const deps = new Map<string, string[]>();
  for (const r of rows) deps.set(r.id, r.dependencies.filter((d) => known.has(d)));
  const cycles = findCycles([...byId.keys()].filter((id) => id !== ""), deps);
  if (cycles.ids.size > 0) {
    issues.push({
      problem: "dependency_cycle",
      ids: [...cycles.ids].sort(),
      detail: `成环：${cycles.example.join(" → ")}${cycles.ids.size > cycles.example.length - 1 ? `（共 ${cycles.ids.size} 个 id 在环上）` : ""}`,
    });
  }

  // ④ 缺验收内容（交付目标或完成证据为空）
  const missing = rows.filter((r) => r.goal === "" || r.evidence === "");
  if (missing.length > 0) {
    issues.push({
      problem: "missing_acceptance",
      ids: missing.map((r) => r.id),
      detail: missing
        .map((r) => {
          const what = [r.goal === "" ? "交付目标" : null, r.evidence === "" ? "完成证据" : null]
            .filter((x): x is string => x !== null)
            .join("/");
          return `${r.id || `(行 ${r.row} 无卡号)`} 缺 ${what}`;
        })
        .join("；"),
    });
  }

  return issues;
}

/** 把问题列表拼成一句能直接读的错误文案（点名 id） */
export function describePlanIssues(issues: PlanIssue[]): string {
  const label: Record<PlanIssueProblem, string> = {
    no_table: "找不到施工卡表",
    empty_table: "施工卡表为空",
    empty_id: "卡号为空",
    duplicate_id: "卡号重复",
    dangling_dependency: "依赖悬空",
    dependency_cycle: "依赖成环",
    missing_acceptance: "缺验收内容",
    dangling_requirement: "需求引用悬空",
    dangling_change: "变更批次引用悬空",
    dangling_map_card: "需求映射表承接了不存在的卡",
    incomplete_requirement_map: "需求映射行缺需求 id 或承接卡为空（空登记）",
  };
  return issues.map((i) => `${label[i.problem]}：${i.detail}`).join("；");
}

/**
 * 校验不通过即抛 `INVALID_COMMAND`（拒绝激活；detail 里带全部问题与点名 id）。
 * 通过则静默返回（调用方随后用 `definitionHashOf` 取施工定义哈希）。
 */
export function assertPlanTasksValid(rows: PlanTask[], source: string, tableFound = true): void {
  const issues = validatePlanTasks(rows, tableFound);
  if (issues.length === 0) return;
  throw new WorkError(
    "INVALID_COMMAND",
    `施工图结构校验不通过（${source}）：${describePlanIssues(issues)}`,
    { source, issues },
  );
}

/**
 * 施工定义哈希（DESIGN.md §2.9：「只覆盖任务目标、范围、依赖、接口与验收内容，
 * 不含派生状态、更新时间和执行日志」）。
 *
 * 本卡取到的最小集合 = 卡号 + 交付目标 + 依赖 + 完成证据（`状态` 列等派生内容不参与），
 * 规范化成定序 JSON 再 sha256——同一份定义在任何进程里算出同一个哈希。
 */
export function definitionHashOf(rows: PlanTask[]): string {
  const canonical = rows.map((r) => [r.id, r.goal, r.dependencies, r.evidence]);
  return crypto.createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
