// 待议处置记录（PLAN.md V06-08；DESIGN.md §3.5 / §2.6）。
//
// 三条硬口径（每条在代码里都有一处落点，别混）：
//   ① **只追加**：本模块只往 `.工作台/decisions.jsonl` 追加整行，从不改写/删除既有记录
//      （`appendDecision` 里只有 `fs.appendFileSync`，没有任何 write/truncate 分支）。
//   ② **不改待议原文**：处置记录引用 `discussion_ref`（原源 + 条目序号 + 原内容哈希），
//      待议条目本体（塔台 = repo 根 `DESIGN.md` 附录 B；其他项目 = `.工作台/design.discuss.md`）
//      一个字节都不动——本模块**只读**待议正文，写只写 decisions.jsonl。
//   ③ **同文字不同来源不合并**：状态按 `refKey = 源 ␟ 序号 ␟ 内容哈希` 派生。两条文字一字不差
//      但来源/序号不同的历史记录各记各的状态，不因为文本相同就合并丢失来源（§3.5 末段）。
//
// 另两条口径：
//   · **采纳 ≠ 已实现**（§3.5）：本模块只记"设计层面怎么处置"；关联任务到底做到哪一步由
//     `relatedImplementationOf` 从现场事实（v2 任务状态 + 人工验收）现算，界面据此说清
//     "已采纳、但关联任务还没交付/还没验收"，绝不把采纳渲染成完工。
//   · 处置记录里的**理由必填**（提出/采纳/驳回/被替代都要），采纳还要有关联设计修订或施工任务
//     （§3.5「包含提出/采纳/驳回/被替代、理由、处理者、适用版本与替代关系」+「采纳后关联设计修订
//     或施工任务」）。缺了就拒，不写半条。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { nowIso, compareIsoTime } from "../time";
import { WorkError } from "./types";

/** 处置记录文件（项目根内相对路径；§2.6 与 intent.json / baselines.jsonl 并列） */
export const DECISIONS_FILE = "decisions.jsonl";

/** 待议条目行判定：`- \`日期\` …` 开头的列表行（与 UI/README 的 countDiscussEntries 同一口径） */
export const DISCUSSION_ENTRY_RE = /^- `/;

export const DECISION_ACTIONS = ["proposed", "accepted", "rejected", "superseded"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export const DECISION_ACTION_LABELS: Readonly<Record<DecisionAction, string>> = {
  proposed: "已提出",
  accepted: "已采纳",
  rejected: "已驳回",
  superseded: "已被替代",
};

/** 处置记录引用的待议原文位置：原源 + 条目序号 + 原内容哈希（§3.5 的 discussion_ref 三件套） */
export interface DiscussionRef {
  /** 待议源标识（塔台 = `DESIGN.md`（附录 B 区）；其他项目 = `.工作台/design.discuss.md`） */
  source: string;
  /** 条目序号（0 起，按正文出现顺序；同一文字出现在不同序号 = 两条不同记录） */
  index: number;
  /** 该条目原文（整行，去行尾空白）的 sha256 —— 原文改了就不是同一条待议 */
  content_sha256: string;
}

/** 处置关联（§3.5：采纳后关联设计修订或施工任务；基线/图纸修订是可选的更强引用） */
export interface DecisionRelated {
  baseline_id: string | null;
  design_revision: string | null;
  plan_revision: string | null;
  task_id: string | null;
}

/** 一条处置记录（decisions.jsonl 的一行；字段一次性写全，后续记录不改它） */
export interface DecisionRecord {
  /** 稳定 id（时间戳 + 内容指纹；同一条重复提交命中同 id，由调用方按幂等键挡） */
  decision_id: string;
  discussion_ref: DiscussionRef;
  action: DecisionAction;
  reason: string;
  /** 处理者标识（人/角色；不写"模型说的"这种含糊值） */
  decided_by: string;
  role: string;
  related: DecisionRelated;
  /** 被本记录替代的**处置记录** id（action=superseded 时给出；替代关系显式留痕） */
  supersedes: string | null;
  /** 适用版本（记录当时的图纸修订；取不到写 null，不编造） */
  applicable: { design_revision: string | null; plan_revision: string | null };
  at: string;
}

/** 待议条目（正文原文 + 定位引用） */
export interface DiscussionEntry {
  index: number;
  ref: DiscussionRef;
  /** 原文整行（逐字节来自待议源，界面只渲染不重写） */
  text: string;
}

/** 一条待议的处置派生态（由 decisions.jsonl 记录推出，记录本身不改） */
export interface DiscussionDisposition {
  status: DecisionAction | "none";
  status_label: string;
  decision_id: string | null;
  decision: DecisionRecord | null;
  /** 该条目下全部处置记录（时间正序；界面可展开看历史） */
  history: DecisionRecord[];
}

const refKey = (ref: DiscussionRef): string => `${ref.source}\u001f${ref.index}\u001f${ref.content_sha256}`;

export function discussionRefKey(ref: DiscussionRef): string {
  return refKey(ref);
}

/** 原文哈希口径：整行去行尾空白后 sha256（同一行前后空白差异不算改原文；中间一个字符都算） */
export function discussionContentHash(line: string): string {
  return crypto.createHash("sha256").update(line.replace(/\s+$/, ""), "utf8").digest("hex");
}

/** 把待议正文拆成带定位引用的条目（跳过非 `- \`` 行；序号按正文出现顺序） */
export function discussionEntriesOf(content: string, source: string): DiscussionEntry[] {
  const out: DiscussionEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!DISCUSSION_ENTRY_RE.test(line)) continue;
    const text = line.replace(/\s+$/, "");
    out.push({
      index: out.length,
      ref: { source, index: out.length, content_sha256: discussionContentHash(text) },
      text,
    });
  }
  return out;
}

/** 读 decisions.jsonl：坏行计数并跳过（不吞掉"有坏行"这件事），缺文件 = 还没处置过（正常空态） */
export function readDecisions(workDir: string): { records: DecisionRecord[]; corrupt: number } {
  const file = path.join(workDir, DECISIONS_FILE);
  if (!fs.existsSync(file)) return { records: [], corrupt: 0 };
  const records: DecisionRecord[] = [];
  let corrupt = 0;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as DecisionRecord;
      if (typeof parsed?.decision_id !== "string" || typeof parsed?.discussion_ref?.content_sha256 !== "string") {
        corrupt++;
        continue;
      }
      records.push(parsed);
    } catch {
      corrupt++;
    }
  }
  return { records, corrupt };
}

export interface DecisionInput {
  discussion_ref: DiscussionRef;
  action: DecisionAction;
  reason: string;
  decided_by: string;
  role: string;
  related?: Partial<DecisionRelated>;
  supersedes?: string | null;
  applicable?: { design_revision?: string | null; plan_revision?: string | null };
}

function bad(message: string, detail: Record<string, unknown> = {}): never {
  throw new WorkError("INVALID_COMMAND", message, detail);
}

/** 处置输入的显式校验（理由必填；采纳/替代必须带关联；动作必须在词表里） */
export function validateDecisionInput(raw: unknown): DecisionInput {
  if (typeof raw !== "object" || raw === null) bad("处置记录必须是对象");
  const r = raw as Record<string, unknown>;
  const refRaw = r.discussion_ref as Record<string, unknown> | undefined;
  if (typeof refRaw !== "object" || refRaw === null) bad("discussion_ref 缺失（原源/序号/原文哈希三件套）");
  const source = String(refRaw.source ?? "");
  const index = Number(refRaw.index);
  const sha = String(refRaw.content_sha256 ?? "");
  if (source === "") bad("discussion_ref.source 不能为空");
  if (!Number.isInteger(index) || index < 0) bad(`discussion_ref.index 必须是非负整数（收到 ${String(refRaw.index)}）`);
  if (!/^[0-9a-f]{64}$/.test(sha)) bad("discussion_ref.content_sha256 必须是 sha256 十六进制（64 位小写）");
  const action = String(r.action ?? "");
  if (!(DECISION_ACTIONS as readonly string[]).includes(action)) {
    bad(`action 只接受 ${DECISION_ACTIONS.join("/")}（收到 ${JSON.stringify(r.action)}）`);
  }
  const reason = typeof r.reason === "string" ? r.reason.trim() : "";
  if (reason === "") bad("理由必填：处置记录没有理由等于没有处置依据（§3.5）");
  const decided_by = String(r.decided_by ?? "").trim();
  if (decided_by === "") bad("decided_by 必填（谁处置的要说清）");
  const role = String(r.role ?? "user").trim() || "user";
  const relatedRaw = (r.related ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const related: DecisionRelated = {
    baseline_id: str(relatedRaw.baseline_id),
    design_revision: str(relatedRaw.design_revision),
    plan_revision: str(relatedRaw.plan_revision),
    task_id: str(relatedRaw.task_id),
  };
  const hasRelated =
    related.baseline_id !== null ||
    related.design_revision !== null ||
    related.plan_revision !== null ||
    related.task_id !== null;
  const act = action as DecisionAction;
  if ((act === "accepted" || act === "superseded") && !hasRelated) {
    bad(
      `action=${act} 必须关联设计修订或施工任务（§3.5：采纳后关联设计修订或施工任务，` +
        "不关联就无法判断是否已实现）",
      { action: act },
    );
  }
  const supersedes = str(r.supersedes);
  const applicable = (r.applicable ?? {}) as Record<string, unknown>;
  return {
    discussion_ref: { source, index, content_sha256: sha },
    action: act,
    reason,
    decided_by,
    role,
    related,
    supersedes,
    applicable: {
      design_revision: str(applicable.design_revision),
      plan_revision: str(applicable.plan_revision),
    },
  };
}

/** 稳定 id：内容指纹（同一条语义重复提交得到同 id，便于对账；调用方负责幂等） */
function decisionIdOf(input: DecisionInput, at: string): string {
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      [
        input.discussion_ref.source,
        String(input.discussion_ref.index),
        input.discussion_ref.content_sha256,
        input.action,
        input.reason,
        input.decided_by,
        input.related?.task_id ?? "",
        input.related?.design_revision ?? "",
        input.related?.plan_revision ?? "",
        input.related?.baseline_id ?? "",
        input.supersedes ?? "",
      ].join("\u001f"),
      "utf8",
    )
    .digest("hex");
  return `d-${at.replace(/[-:T+.]/g, "").slice(0, 14)}-${fingerprint.slice(0, 12)}`;
}

/**
 * 追加一条处置记录（**只追加**：目录不存在先建，文件只用 append）。
 * 返回落盘的那条记录；不动任何既有行。
 */
export function appendDecision(workDir: string, input: DecisionInput): DecisionRecord {
  const at = nowIso();
  const record: DecisionRecord = {
    decision_id: decisionIdOf(input, at),
    discussion_ref: input.discussion_ref,
    action: input.action,
    reason: input.reason,
    decided_by: input.decided_by,
    role: input.role,
    related: {
      baseline_id: input.related?.baseline_id ?? null,
      design_revision: input.related?.design_revision ?? null,
      plan_revision: input.related?.plan_revision ?? null,
      task_id: input.related?.task_id ?? null,
    },
    supersedes: input.supersedes ?? null,
    applicable: {
      design_revision: input.applicable?.design_revision ?? null,
      plan_revision: input.applicable?.plan_revision ?? null,
    },
    at,
  };
  fs.mkdirSync(workDir, { recursive: true });
  fs.appendFileSync(path.join(workDir, DECISIONS_FILE), JSON.stringify(record) + "\n", "utf8");
  return record;
}

/** 按待议条目派生处置状态：记录时间正序取最后一条为该条目的当前状态 */
export function deriveDispositions(
  entries: readonly DiscussionEntry[],
  records: readonly DecisionRecord[],
): Record<string, DiscussionDisposition> {
  const byKey = new Map<string, DecisionRecord[]>();
  // 决策记录的 `at` 是调用方给的时间（偏移任意）：按真实时刻正序，非法/缺失排最前 → 抢不到"最后一条"。
  for (const r of [...records].sort((a, b) => compareIsoTime(a.at, b.at))) {
    const key = refKey(r.discussion_ref);
    const list = byKey.get(key);
    if (list === undefined) byKey.set(key, [r]);
    else list.push(r);
  }
  const out: Record<string, DiscussionDisposition> = {};
  for (const e of entries) {
    const key = refKey(e.ref);
    const history = byKey.get(key) ?? [];
    const last = history.length === 0 ? null : history[history.length - 1];
    out[key] = {
      status: last === null ? "none" : last.action,
      status_label: last === null ? "待处理" : DECISION_ACTION_LABELS[last.action],
      decision_id: last?.decision_id ?? null,
      decision: last,
      history,
    };
  }
  return out;
}

/** 采纳后的关联任务实现情况（**给界面判断"采纳 ≠ 已实现"**；不把采纳说成完工） */
export interface RelatedImplementation {
  task_id: string;
  /** v2 任务执行状态（来自已提交事件；没有该实体就是 null） */
  execution_status: string | null;
  execution_label: string | null;
  /** 用户人工验收维度（pending/accepted/rejected/accepted_known_limit） */
  acceptance: "pending" | "accepted" | "rejected" | "accepted_known_limit";
  /** 只有用户验收接受才算"已实现"；执行者自报"结果已提交"不算（§2.6/§5.8） */
  implemented: boolean;
  note: string;
}

export function relatedImplementationOf(
  taskId: string,
  taskStatus: { status: string; status_label: string } | null,
  acceptance: RelatedImplementation["acceptance"],
): RelatedImplementation {
  const implemented = acceptance === "accepted";
  const note = implemented
    ? "关联任务已有人工验收接受记录"
    : taskStatus === null
      ? "关联任务当前没有任何执行状态（采纳只是设计层面，尚未开工）"
      : `关联任务当前「${taskStatus.status_label}」：采纳不等于已实现（§3.5），完成与否看任务状态与用户验收`;
  return {
    task_id: taskId,
    execution_status: taskStatus?.status ?? null,
    execution_label: taskStatus?.status_label ?? null,
    acceptance,
    implemented,
    note,
  };
}
