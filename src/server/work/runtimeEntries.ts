// 补修包 F（V06-08 主责，关联 V06-09/V06-11）：**项目可体验运行入口**的登记与读取口径。
//
// 为什么在这里、而不在 `registry.json`（补修 F ①）：
//   全局注册表只记"这台机器上有哪些项目、路径在哪"，是**跨项目**的索引；运行入口是**项目自己的
//   事实**（哪个场景、哪批成果、什么时候验的、现在还有效吗），临时地址会被换掉。塞进全局表意味着
//   一次登记要动全库索引、还要处理"项目不在表里"的边角；而塔台已经有**项目内**的成果登记机制
//   （`audit.submission_submitted`：交付物 + 证据 + 版本绑定）。本补修就挂在它上面：
//   成果提交时顺带声明该成果的**实际运行入口**（场景 / 入口 / 验证时间 / 结果或不可用原因），
//   入口因此天然带"来源成果与版本"，且**不依赖用户是否已提交验收记录**（§3.7、补修 F ③）。
//   补修 F3（2026-09-20）把**同一套登记**接到 Agent 结果回报（`task.result_submitted`）上，
//   两条写入路径共用本文件的形状、校验与状态判定——**不另造存储**。
//
// 本文件只回答"一条入口登记长什么样、什么算不合法、怎么判它现在能不能打开"——纯函数，零 IO。
// 写入走唯一写入服务（v2 事件，`POST /api/work/command` 或 MCP `submit_task_result`）；
// 读取从权威事实（事件折叠出的成果记录 / 任务状态）装配。
//
// 与 DESIGN.md §3.7 的对应（2026-09-20 定版）：
//   「前端项目的结果给可打开的实际运行入口、对应场景和验证时间」→ 下面的 scenario/url/verified_at；
//   「没有可用入口就明确"尚不可体验"」→ `runtimeEntrySummaryOf()` 的 unavailable；
//   「本期使用受控外部打开方式」→ `isRuntimeEntryUrl()`（只认 http(s)）+ `src/ui/result-entry.ts`；
//   「不能用模拟响应冒充已运行」→ `status` 是**执行者实测写下来的**，本模块不造、不猜、不探测；
//   「24h 只作可达性复核提醒阈值」→ `RUNTIME_ENTRY_REVIEW_MS` 只产出 `reverify_due`，
//     **不判为不可达、也不撤掉打开入口**；
//   「已知不可达与成果版本过期是两件事」→ `state`（能不能开）与 `revision_state`（对应哪一版）**两条轴**。
import { compareIsoTime, parseIsoMs } from "../time";
import { WorkError } from "./types";

/** 登记时执行者写的探测结果（三态：只能是他实测写下的，塔台不代跑探测） */
export const RUNTIME_ENTRY_STATUSES = ["reachable", "unreachable", "unknown"] as const;
export type RuntimeEntryStatus = (typeof RUNTIME_ENTRY_STATUSES)[number];

export const RUNTIME_ENTRY_STATUS_LABELS: Readonly<Record<RuntimeEntryStatus, string>> = {
  reachable: "验证时实测可打开",
  unreachable: "验证时探测失败（入口已失效）",
  unknown: "验证结果未知（执行者没给结果）",
};

/**
 * **可达性复核提醒阈值**（2026-09-20 授权角色定；**不是**入口的自动失效期限）。
 *
 * 临时运行地址会被换掉，所以"很久没复核"值得提醒；但"该重新看一眼"既不等于"已经失效"，
 * 也不等于塔台可以替用户关掉一个他可能还要用的入口。超阈值只把状态标成 `reverify_due`：
 * 界面上写"待重新验证"，**入口照样可以打开**。真正判"不可打开"的只有执行者实测的
 * `status=unreachable` 与"结果/时间不可用"。
 */
export const RUNTIME_ENTRY_REVIEW_MS = 24 * 60 * 60 * 1000;

/** 一条**已登记**的运行入口（写进成果登记 / 结果回报 payload 的形状） */
export interface RuntimeEntry {
  /** 场景名（人读的：如"下单流程走一遍"） */
  scenario: string;
  /** 实际入口地址（只接受 http(s)，其余协议在读侧被拒） */
  url: string;
  /** 执行者**实际验证**的时间（带偏移 ISO；不是本模块算的） */
  verified_at: string;
  status: RuntimeEntryStatus;
  /** 不可用原因（status != reachable 时必填；没有就如实写"未说明"这类原因文本，不许空着） */
  reason: string | null;
}

/** 读取时判出来的当前状态（由登记内容 + 当前时刻派生，**不改登记本身**） */
export const RUNTIME_ENTRY_STATES = ["openable", "reverify_due", "failed", "unknown"] as const;
export type RuntimeEntryState = (typeof RUNTIME_ENTRY_STATES)[number];

export const RUNTIME_ENTRY_STATE_LABELS: Readonly<Record<RuntimeEntryState, string>> = {
  openable: "可体验（实测可打开，且在复核提醒阈值内）",
  // 注意：这几串是**直接上屏的用户可见文案**，不要写 Markdown 强调符号（页面是纯文本渲染，`**` 会原样显示）
  reverify_due:
    "待重新验证：验证时间已超过复核提醒阈值（入口仍可打开，只是该再确认一次；不代表已失效）",
  failed: "入口失效：验证时探测失败",
  unknown: "入口状态未知：验证结果或验证时间不可用",
};

/**
 * **版本轴**（独立于上面的可打开状态）：这条入口绑定的成果版本，是不是当前事实里的版本。
 *
 * 与 `state` 分开的理由（裁定 F2 ③）：`failed` 说的是"验过、打不开"，`outdated` 说的是
 * "还能开，但它对应的是旧版本成果"——两件事，不能混成一种状态。
 */
export const RUNTIME_ENTRY_REVISION_STATES = ["current", "outdated", "unknown"] as const;
export type RuntimeEntryRevisionState = (typeof RUNTIME_ENTRY_REVISION_STATES)[number];

export const RUNTIME_ENTRY_REVISION_LABELS: Readonly<Record<RuntimeEntryRevisionState, string>> = {
  current: "成果版本与当前版本一致",
  outdated: "成果版本已过期：绑定的成果版本已不是当前版本（入口仍可打开，但对应的是旧版本）",
  unknown: "版本状态未知：缺少可比较的版本绑定（不猜）",
};

/**
 * **逐来源**的版本轴解析结论（读侧的 IO 部分算出来，喂给纯函数 `runtimeEntryViews`）。
 *
 * 为什么不是一个全局的"当前版本"字符串：契约 F4 明确**不能拿账本里自报的 code revision 反推当前版本**；
 * 能当"当前版本"的只有**这份成果自己正式引用、且版本绑定一致的合法源清单**现读复核的结论。
 * 于是"当前版本"是**逐来源记录**的（每条登记引用的清单不同、现读结论也不同），不能项目级共用一串。
 * 解析实现（唯一入口、含全部边界）见 `runtimeEntryRevision.ts`。
 */
export interface RuntimeEntryRevisionResolution {
  state: RuntimeEntryRevisionState;
  /** 可核对的当前版本：`valid` = 登记指纹；`invalidated` = 现读指纹；拿不到 = null */
  current_revision: string | null;
  /** 登记时指纹（有可用清单时）；没拿到可核对来源时为 null */
  registered_fingerprint: string | null;
  /** 生效的那份清单证据 id（唯一且可用时）；否则 null */
  evidence_id: string | null;
  /** 结论依据（人话；只用项目内相对路径，不含绝对私有路径/凭证） */
  basis: string;
}

/** 装配后的入口（登记内容 + 来源成果与版本 + 当前状态）；界面/接口消费的是它 */
export interface RuntimeEntryView extends RuntimeEntry {
  /** 来源成果：哪一条登记（`audit.submission_submitted` 的 record_id / `task.result_submitted` 的回报 id） */
  source_record_id: string;
  /** 来源事实的类别（F3：两条登记路径都要能看出自己是从哪来的） */
  source_kind: RuntimeEntrySourceKind;
  /** 来源登记里声明的版本（`binding.revision` / 结果回报的 `result_revision`）；没声明就是 null，不编造 */
  source_revision: string | null;
  source_revision_kind: string | null;
  source_submitted_by: string;
  source_task_id: string | null;
  /** 来源登记的提交时刻 */
  registered_at: string;
  state: RuntimeEntryState;
  state_label: string;
  /** 现在能不能打开（受控打开的判据之一；协议还要再过一遍 `isRuntimeEntryUrl`） */
  openable: boolean;
  /** 版本轴：这条入口绑定的成果版本 vs 当前版本（与 `state` **相互独立**） */
  revision_state: RuntimeEntryRevisionState;
  revision_label: string;
  /**
   * 这条入口**逐来源**解析出的可核对当前版本（拿不到为 null）。只用于追溯/展示，不泄露私有路径。
   * 逐来源解析生效时 = 解析结论；只有旧的两串比较路径下才回落到调用方给的全局当前版本。
   */
  revision_current: string | null;
  /** 版本轴结论依据（人话；逐来源解析生效时给，旧比较路径下为 null） */
  revision_basis: string | null;
}

/** 项目级入口概况（"尚不可体验"与"登记过但都不可用"必须分开说） */
export interface RuntimeEntrySummary {
  kind: "available" | "stale" | "unavailable";
  label: string;
  note: string;
  total: number;
  /** 现在真的能打开的条数（**含**"待重新验证"：超提醒阈值不等于不能打开） */
  can_open_count: number;
  /** 实测可打开且在复核提醒阈值内的条数 */
  fresh_count: number;
  /** 超过复核提醒阈值、仍可打开、只是该再确认一次的条数 */
  reverify_due_count: number;
  failed_count: number;
  unknown_count: number;
  /** 版本轴计数：绑定的成果版本已不是当前版本的条数（与上面的可打开计数**可以重叠**） */
  outdated_count: number;
}

/** 只认 http(s) 且必须能解析出真实 URL：其余协议（javascript:/file:/data:/mailto:…）与畸形串一律不是可体验入口 */
export function isRuntimeEntryUrl(url: string): boolean {
  const raw = url.trim();
  if (raw === "") return false;
  // 与前端 `src/ui/result-entry.ts#openableResultUrl` **同一判据**（`new URL()` + 协议白名单 + host 非空）：
  // 读侧若只用正则，`http://a b` 这类畸形串会被收下、还会被计进"可打开的入口"，点却点不开（计数与事实不符）。
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (!(RUNTIME_ENTRY_URL_PROTOCOLS as readonly string[]).includes(parsed.protocol.replace(":", ""))) return false;
  return parsed.host !== "";
}

export const RUNTIME_ENTRY_URL_PROTOCOLS = ["http", "https"] as const;

/** 读侧校验失败的原因（调用方按它拼结构化错误，不用解析 message） */
export interface RuntimeEntryParseContext {
  /** 出问题时指路的来源（事件 id + 登记 id） */
  event_id: string;
  record_id: string;
}

function badEntry(ctx: RuntimeEntryParseContext, message: string, detail: Record<string, unknown> = {}): never {
  // 与其它工作模块同口径：读侧遇到不合法的记录**明确报错**（`EVENT_INVALID`），不静默丢一条入口。
  throw new WorkError("EVENT_INVALID", `运行入口登记不合法：${message}`, {
    ...detail,
    event_id: ctx.event_id,
    record_id: ctx.record_id,
  });
}

/**
 * 解析一条登记（读侧严格校验，**两条写入路径共用**）。
 * 口径：必填字段缺一个就是**不合法**（宁可红，也不静默丢一条入口——静默丢等于"没登记"）；
 * 非 http(s) 的入口地址直接判不合法（补修 F ④：其余协议一律不执行，连登记都不接受）。
 */
export function parseRuntimeEntry(raw: unknown, ctx: RuntimeEntryParseContext): RuntimeEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    badEntry(ctx, "runtime_entries[] 每一项必须是 JSON 对象");
  }
  const o = raw as Record<string, unknown>;
  const scenario = typeof o.scenario === "string" ? o.scenario.trim() : "";
  if (scenario === "") badEntry(ctx, "runtime_entries[] 缺 scenario（这条入口对应哪个场景）", { field: "scenario" });
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (url === "") badEntry(ctx, "runtime_entries[] 缺 url（实际入口地址）", { field: "url" });
  if (!isRuntimeEntryUrl(url)) {
    badEntry(ctx, `runtime_entries[].url 只接受 http(s) 入口（收到 ${JSON.stringify(url)}）：其余协议一律不执行`, {
      field: "url",
      url,
    });
  }
  const verifiedAt = typeof o.verified_at === "string" ? o.verified_at.trim() : "";
  if (verifiedAt === "") badEntry(ctx, "runtime_entries[] 缺 verified_at（实际验证时间）", { field: "verified_at" });
  if (parseIsoMs(verifiedAt) === null) {
    badEntry(
      ctx,
      `runtime_entries[].verified_at 必须是可以解析出真实时刻的 ISO 串（收到 ${JSON.stringify(verifiedAt)}）：` +
        "解析不了的时间不许静默当成「刚刚验过」",
      { field: "verified_at", verified_at: verifiedAt },
    );
  }
  const status = o.status;
  if (typeof status !== "string" || !(RUNTIME_ENTRY_STATUSES as readonly string[]).includes(status)) {
    badEntry(ctx, `runtime_entries[].status 只接受 ${RUNTIME_ENTRY_STATUSES.join("/")}（收到 ${JSON.stringify(status)}）`, {
      field: "status",
      status,
    });
  }
  const reason = typeof o.reason === "string" && o.reason.trim() !== "" ? o.reason.trim() : null;
  if (status !== "reachable" && reason === null) {
    badEntry(ctx, "runtime_entries[] 的 status 不是 reachable 时必须写不可用原因（reason 不能空）", {
      field: "reason",
      status,
    });
  }
  return { scenario, url, verified_at: verifiedAt, status: status as RuntimeEntryStatus, reason };
}

/** 解析一整组登记；缺省（字段不存在）＝ 这条登记没声明入口，返回空数组 */
export function parseRuntimeEntries(raw: unknown, ctx: RuntimeEntryParseContext): RuntimeEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) badEntry(ctx, "runtime_entries 必须是数组", { field: "runtime_entries" });
  return raw.map((item) => parseRuntimeEntry(item, ctx));
}

/**
 * 判一条登记的**当前**状态（纯函数；`nowMs` 由调用方给，便于断言）。
 *   · status=unreachable → failed（执行者实测打不开）；status=unknown → unknown；
 *   · status=reachable：验证时间可解析才继续；**超过复核提醒阈值 → `reverify_due`，仍 `openable`**；
 *     阈值内 → `openable`。**没有"因超时而不可打开"这一档**（裁定 F2 ②）。
 */
export function runtimeEntryStateOf(
  entry: Pick<RuntimeEntry, "status" | "verified_at">,
  nowMs: number,
  reviewMs: number = RUNTIME_ENTRY_REVIEW_MS,
): { state: RuntimeEntryState; openable: boolean } {
  if (entry.status === "unreachable") return { state: "failed", openable: false };
  if (entry.status === "unknown") return { state: "unknown", openable: false };
  const verified = parseIsoMs(entry.verified_at);
  if (verified === null) return { state: "unknown", openable: false };
  if (nowMs - verified > reviewMs) return { state: "reverify_due", openable: true };
  return { state: "openable", openable: true };
}

/**
 * 判一条入口的**版本轴**状态（与能不能打开无关）。
 *   · 两侧都有可比较的版本且相等 → `current`；
 *   · 两侧都有但不相等 → `outdated`（还能打开，但对应的是旧版本成果）；
 *   · 任一侧拿不到 → `unknown`（**不猜成 current**，也不猜成 outdated）。
 */
export function runtimeEntryRevisionStateOf(
  sourceRevision: string | null | undefined,
  currentRevision: string | null | undefined,
): RuntimeEntryRevisionState {
  const a = typeof sourceRevision === "string" && sourceRevision.trim() !== "" ? sourceRevision.trim() : null;
  const b = typeof currentRevision === "string" && currentRevision.trim() !== "" ? currentRevision.trim() : null;
  if (a === null || b === null) return "unknown";
  return a === b ? "current" : "outdated";
}

/** 来源事实的类别：成果登记 / Agent 结果回报（F3 起两条路径等价） */
export const RUNTIME_ENTRY_SOURCE_KINDS = ["submission", "result_submitted"] as const;
export type RuntimeEntrySourceKind = (typeof RUNTIME_ENTRY_SOURCE_KINDS)[number];

export const RUNTIME_ENTRY_SOURCE_KIND_LABELS: Readonly<Record<RuntimeEntrySourceKind, string>> = {
  submission: "成果登记（audit.submission_submitted）",
  result_submitted: "Agent 结果回报（task.result_submitted）",
};

/** 结果回报事件的**最小结构面**（只要这几个字段就能装配来源；便于纯函数单测，不强绑事件类） */
export interface ResultSubmittedEventLike {
  event_id: string;
  type: string;
  seq: number;
  entity_id: string;
  actor_id: string;
  received_at: string;
  payload: Record<string, unknown>;
}

/**
 * 从事件流里把 **Agent 结果回报**声明的运行入口折成来源清单（补修 F3）。
 *
 * 与成果登记**同一套**形状、同一套读侧校验（`parseRuntimeEntries` 就在下面几行）、同一套状态判定；
 * 版本绑定复用该回报已有的 `result_revision`（§5.6 的复核基准），因此**不需要**新的存储或新的字段来源。
 * 没声明 `runtime_entries` 的回报**不产生来源**（旧调用行为不变）；每次回报各成一条来源——
 * 后来的回报不会盖掉先前那条失效条目（同 F ⑤ 的"不合并、不吞历史"）。
 */
export function resultSubmittedSources(
  events: readonly ResultSubmittedEventLike[],
  opts: { taskIdOfEntity?: (entityId: string) => string | null } = {},
): RuntimeEntrySource[] {
  const taskIdOf =
    opts.taskIdOfEntity ?? ((entityId: string) => (entityId.startsWith("task:") ? entityId.slice("task:".length) : null));
  const out: RuntimeEntrySource[] = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.type !== "task.result_submitted") continue;
    const recordId = `result:${e.event_id}`;
    const entries = parseRuntimeEntries(e.payload.runtime_entries, { event_id: e.event_id, record_id: recordId });
    if (entries.length === 0) continue;
    const rev = e.payload.result_revision;
    const revision = typeof rev === "string" && rev.trim() !== "" ? rev.trim() : null;
    // 该回报**正式引用**的证据（与成果登记 `evidence_refs` 同口径）：逐来源解析"可核对当前版本"用。
    // 只是把 payload 里已有的字段带出，不新增存储、不改判任何结论。
    const refsRaw = e.payload.evidence_refs;
    const evidence_refs = Array.isArray(refsRaw) ? refsRaw.filter((x): x is string => typeof x === "string") : [];
    out.push({
      kind: "result_submitted",
      record_id: recordId,
      task_id: taskIdOf(e.entity_id),
      submitted_by: e.actor_id,
      at: e.received_at,
      revision,
      revision_kind: revision === null ? null : "code",
      evidence_refs,
      entries,
    });
  }
  return out;
}

/** 装配最少输入：来源事实的元信息（除登记内容外，还要"来源成果与版本"） */
export interface RuntimeEntrySource {
  kind: RuntimeEntrySourceKind;
  record_id: string;
  task_id: string | null;
  submitted_by: string;
  at: string;
  revision: string | null;
  revision_kind: string | null;
  /**
   * 该来源记录**正式引用**的证据 id（成果登记/结果回报的 `evidence_refs`）：逐来源解析"可核对当前版本"用。
   * 缺省 = 没有可核对的引用（版本轴如实 unknown）。
   */
  evidence_refs?: readonly string[];
  /**
   * **逐来源**已解析出的版本轴结论（读侧现读该来源自己引用的源清单得出）。
   * 给了就以它为准（含如实 `unknown`），**不回退**到调用方给的全局 `currentRevision`——
   * 全局串只服务旧调用与函数层显式注入，产品读口一律逐来源解析。
   */
  revision_resolution?: RuntimeEntryRevisionResolution | null;
  entries: readonly RuntimeEntry[];
}

/** 装配选项（两个旋钮都显式给，避免调用方把"提醒阈值"当成"失效期限"用） */
export interface RuntimeEntryViewOptions {
  /** 可达性复核提醒阈值（默认 24h）：超阈值只标 `reverify_due`，**仍可打开** */
  reviewMs?: number;
  /**
   * 旧口令的**全局**当前版本（`facts.revisions.code`）。只在来源**没有** `revision_resolution` 时生效
   * （函数层显式注入 / 旧调用）；产品 HTTP 读口对每条来源都带逐来源解析，不再走这里。
   */
  currentRevision?: string | null;
}

/**
 * 从来源事实装配项目级入口清单（纯函数）。
 * 排序确定性：先按场景名，再按来源登记时刻，再按登记 id——同一场景被不同登记声明过就都留着
 * （不合并、不吞历史），这样"失效入口"不会被后来的一条盖掉（补修 F ⑤）。
 */
export function runtimeEntryViews(
  sources: readonly RuntimeEntrySource[],
  nowMs: number,
  opts: RuntimeEntryViewOptions = {},
): RuntimeEntryView[] {
  const reviewMs = opts.reviewMs ?? RUNTIME_ENTRY_REVIEW_MS;
  const currentRevision = opts.currentRevision ?? null;
  const views: RuntimeEntryView[] = [];
  for (const src of sources) {
    // 逐来源解析（读侧现读该来源自己引用的源清单）优先：给了就以它为准（含如实 unknown），
    // 不回退到全局串；没给才走旧的两串比较（函数层显式注入 / 旧调用）。
    const resolution = src.revision_resolution ?? null;
    const revisionState =
      resolution !== null ? resolution.state : runtimeEntryRevisionStateOf(src.revision, currentRevision);
    const revisionCurrent = resolution !== null ? resolution.current_revision : currentRevision;
    const revisionBasis = resolution !== null ? resolution.basis : null;
    for (const entry of src.entries) {
      const { state, openable } = runtimeEntryStateOf(entry, nowMs, reviewMs);
      views.push({
        ...entry,
        source_record_id: src.record_id,
        source_kind: src.kind,
        source_revision: src.revision,
        source_revision_kind: src.revision_kind,
        source_submitted_by: src.submitted_by,
        source_task_id: src.task_id,
        registered_at: src.at,
        state,
        state_label: RUNTIME_ENTRY_STATE_LABELS[state],
        openable,
        revision_state: revisionState,
        revision_label: RUNTIME_ENTRY_REVISION_LABELS[revisionState],
        revision_current: revisionCurrent,
        revision_basis: revisionBasis,
      });
    }
  }
  return views.sort(
    (a, b) =>
      a.scenario.localeCompare(b.scenario) ||
      compareIsoTime(a.registered_at, b.registered_at) ||
      a.source_record_id.localeCompare(b.source_record_id),
  );
}

/**
 * 项目级概况：没有入口 → "尚不可体验"；有能打开的 → "有可体验入口"；登记过但一个都打不开 → "登记过但当前不可用"。
 * **超复核提醒阈值不作为"不可用"**：那种条目计入 `reverify_due_count`、仍算 `can_open_count`，
 * 概况文案里单独点名，不混进"探测失败/未知"（裁定 F2 ②）。
 */
export function runtimeEntrySummaryOf(views: readonly RuntimeEntryView[]): RuntimeEntrySummary {
  const count = (s: RuntimeEntryState): number => views.filter((v) => v.state === s).length;
  const summary = {
    total: views.length,
    fresh_count: count("openable"),
    reverify_due_count: count("reverify_due"),
    can_open_count: views.filter((v) => v.openable).length,
    failed_count: count("failed"),
    unknown_count: count("unknown"),
    outdated_count: views.filter((v) => v.revision_state === "outdated").length,
  };
  /** 非"能打开"的那些，逐项点名（探测失败 / 结果未知）；超提醒阈值**不列在这里** */
  const blockedParts = [`探测失败 ${summary.failed_count}`, `结果未知 ${summary.unknown_count}`];
  if (views.length === 0) {
    return {
      kind: "unavailable",
      label: "尚不可体验",
      note: "尚不可体验：还没有任何成果或结果回报登记过可打开的运行入口（§3.7）。这不是「加载失败」，也不是「已验证通过」。",
      ...summary,
    };
  }
  if (summary.can_open_count > 0) {
    const others = views.length - summary.can_open_count;
    const due =
      summary.reverify_due_count > 0
        ? `；其中 ${summary.reverify_due_count} 条待重新验证（验证时间已超过复查提醒阈值，入口仍可打开，只是该再确认一次）`
        : "";
    return {
      kind: "available",
      label: "有可体验入口",
      note:
        `有 ${summary.can_open_count} 个可打开的入口${due}` +
        (summary.outdated_count > 0
          ? `；另有 ${summary.outdated_count} 条绑定的成果版本已不是当前版本（仍可打开，但对应旧版本）`
          : "") +
        (others > 0 ? `；${others} 条登记过但当前打不开（${blockedParts.join("、")}），逐条标了状态` : "") +
        "。打开入口不等于用户验收接受（§5.8）。",
      ...summary,
    };
  }
  return {
    kind: "stale",
    label: "登记过入口，当前都不可用",
    note:
      `登记过 ${views.length} 条运行入口，但当前都不可打开（${blockedParts.join("、")}）：逐条说明状态，不静默消失（§3.7）。` +
      (summary.outdated_count > 0
        ? `另有 ${summary.outdated_count} 条绑定的成果版本已不是当前版本（这条与"能不能打开"无关，逐条另有标注）。`
        : "") +
      "这不是「尚不可体验」（那是没有登记过入口）。",
    ...summary,
  };
}
