// B6/V09-56：设计书正文旁的人话功能清单（DESIGN.md §3.5／§4.2／§6.12）。
//
// 这个组件**只渲染**服务端唯一派生读口给的结论（`GET /api/projects/:id/feature-ledger`）：
//   · 不自己判通过、不算百分比、不涂色、没有「改功能状态」入口；
//   · 四维（设计覆盖／实现／验证／用户接受）**分开显示**，绿色**只**出现在 canonical `verification`；
//     `design_coverage=已核对` 用文字/中性样式，**不借绿色冒充可用**；
//   · 缺设计与无运行记录说人话（「缺设计·待补」「无运行记录」），**不写「未实现」**；
//   · 异常与**待决数量**默认一眼可见；待决的完整长列表与详细技术字段收进限高独立滚动的
//     `<details>`（默认收起，**一条不删、身份不改**）；
//   · 「我补充一个需求」复用既有写口 `POST /discuss`（**只追加**），提交后不自动采纳、不改已审定事实。
//
// 默认态**人话优先**（Codex 11:54/11:55 复审 4）：首屏只留「有哪些功能、让你做什么、四维进度、
// 缺什么、下一步、当前/已审定/历史版本」；设计接口名/哈希/行号/规则条文号/审计细节一律收进详情或
// 可展开区，不写在正常用户要读的句子里（也不出现裸的 `**` 标记）。
import { useState } from "react";
import type { CoverageDesignSectionRef, FeatureItem, FeatureLedger } from "../../shared/coverageTypes";

/** 清单读口失败的人话现场（unsupported 与业务失败分开） */
export interface FeatureLedgerErrorView {
  unsupported: boolean;
  message: string;
  status: number | null;
  code: string;
}

/** 概览与清单面板共用的读口状态（两个组件读同一份，不各算一遍） */
export interface FeatureLedgerBundle {
  /** 与设计正文**同一份**版本选择器（不一致要显式报，不混版） */
  selector: string;
  ledger: FeatureLedger | null;
  error: FeatureLedgerErrorView | null;
  loading: boolean;
  /** 第一页失败时重试（重新读取，从第一页起） */
  onRetry: () => void;
  /** 继续读取下一页（真实 cursor 续读，合并进同一份清单） */
  onLoadMore: () => void;
  loadMoreBusy: boolean;
  /** 续读下一页失败的人话原因（保留已载内容，不假空成功） */
  loadMoreError: string | null;
  /** 续读时发现清单版本已变：旧页作废、已重读第一页 */
  pagingNotice: string | null;
  /** 点设计章节引用 → 定位正文（精确 anchor/line/hash） */
  onLocateSection: (ref: CoverageDesignSectionRef) => void;
  /** 正文里被选中的章节行（反向定位：显示关联功能/任务；无对应显示「待归属」） */
  activeSectionLine: number | null;
  /** 「我补充一个需求」：复用只追加的待议写口 */
  onSupplement: (text: string) => void;
  supplementBusy: boolean;
  supplementError: string | null;
  supplementNote: string | null;
  /** 补充草稿按项目保存（父组件持有，刷新/切项目不丢；§3.14） */
  supplementDraft: string;
  onSupplementDraftChange: (v: string) => void;
  /** 正文实际读到的设计修订（用于核对「正文与清单同一版本」；null = 未知） */
  bodyDesignRevision: string | null;
}

// ── 维度取值 → 人话（不靠颜色；绿色只在 verification 一档出现） ──

const IMPL_LABEL: Record<string, string> = {
  no_run_record: "无运行记录",
  not_started: "未开始",
  in_progress: "进行中",
  result_submitted: "结果已提交",
  blocked: "阻塞",
  cancelled: "已取消",
};

const DISPLAY_LABEL: Record<string, string> = {
  planned: "已规划（还没有执行）",
  in_progress: "正在实现",
  pending_verification: "结果待验证",
  verified: "要求的验证已通过",
  blocked: "有明确阻塞",
  unknown: "未知/陈旧",
};

const EVIDENCE_LABEL: Record<string, string> = {
  verified: "证据有效",
  unverified: "证据未核实",
  missing: "缺证据",
  invalidated: "证据已失效",
  user_pending: "待用户验收",
};

const ACCEPT_LABEL: Record<string, string> = {
  pending: "待你决定",
  accepted: "你已接受",
  rejected: "你已退回",
  accepted_known_limit: "你已接受（含已知限制）",
};

function implLabel(state: string): string {
  return IMPL_LABEL[state] ?? state;
}

/** 绿色只取 verification：`display_status=verified ∧ evidence_state=verified`（复用 canonical 判据） */
function verificationIsGreen(item: FeatureItem): boolean {
  return item.verification.display_status === "verified" && item.verification.evidence_state === "verified";
}

function designCoverageClass(state: string): string {
  if (state === "已核对") return "tt-fl-dim-value tt-fl-approved"; // 已核对 ≠ 绿：中性/信息色
  if (state === "缺失") return "tt-fl-dim-value tt-fl-missing";
  if (state === "源变待复核") return "tt-fl-dim-value tt-fl-stale";
  return "tt-fl-dim-value tt-fl-unknown";
}

/** 版本档位的人话名（不暴露哈希；哈希只在详情 title 里） */
function selectorLabel(selector: string, ledger: FeatureLedger | null): string {
  const mode = ledger?.document_selection.mode;
  if (selector === "current") return "当前草稿";
  if (selector === "active") return "已审定基线";
  if (mode === "revision") return "历史已替代版本";
  return `所选版本（${selector.slice(0, 12)}…）`;
}

/**
 * 一条 item 里**真需要人现在决定/知道**的原因（默认态要点名；空 = 不需要你现在看）。
 *
 * 关键分寸（Codex 复审 5/9）：未开始、未验证、没有运行记录的功能**不喊**用户去接受/退回——
 * 那是还没做完的活，归 Agent 继续做；只有「本范围要求的验证已经真通过、只差人拍板」才列成
 * 待你决定。用户接受维在四维里照旧如实标「待你决定」，这里只决定**要不要现在打扰人**。
 */
function attentionReasons(item: FeatureItem): string[] {
  const out: string[] = [];
  const dc = item.design_coverage.state;
  if (dc === "缺失") out.push("缺设计依据，待补");
  else if (dc === "源变待复核") out.push("相关来源改过，要复验");
  else if (dc === "无法判断") out.push("覆盖结论无法判断");
  // 之前验过、现在证据失效：这是用户该知道的（它刚变回「待验证」，不是从没验过）
  if (item.verification.evidence_state === "invalidated") {
    out.push("之前验过的证据已失效（覆盖的来源改过），要复验");
  }
  if (
    item.user_acceptance.state === "pending" &&
    verificationIsGreen(item) &&
    item.user_acceptance.scope_tasks.length > 0
  ) {
    out.push("验证已通过，等你决定接受或退回");
  }
  if (item.user_acceptance.state === "rejected") out.push("你已退回，待重新处理");
  // 同一份待议会被读口逐功能挂着（Codex R2：塔台真实第一页 20 条待议重复挂 7 个功能）。
  // 这里只说**本项**关联了几条，计数去重与总量在概览里按稳定身份算，不在单项里重复虚报总量。
  if (item.pending_decisions.length > 0) out.push(`本项关联 ${item.pending_decisions.length} 个待决问题`);
  return out;
}

/** 还没做完、要交给执行方继续的项（不打扰用户，但要说清有多少） */
function agentTodoReasons(item: FeatureItem): string[] {
  const out: string[] = [];
  if (!verificationIsGreen(item)) {
    if (item.verification.missing.length > 0) out.push(`还差 ${item.verification.missing.length} 项验证证据`);
    else out.push("还没有有效验证证据");
  }
  if (item.implementation.state === "no_run_record") out.push("还没有运行记录");
  else if (item.implementation.state === "blocked") out.push("当前阻塞");
  if (item.provenance.unmapped.length > 0) out.push("需求还没映射到功能");
  if (item.provenance.pending_leads.length > 0) out.push("有未审定线索（模型提案，待审）");
  return out;
}

function shortHash(h: string | null): string {
  return h === null || h === "" ? "—" : `${h.slice(0, 12)}…`;
}

/** 「已载 / 未载」读数：读口不给总数，就**不编总数**——只如实说已载多少、还有没有未载。 */
function pagingReadout(ledger: FeatureLedger): { loaded: number; complete: boolean; text: string } {
  const loaded = ledger.items.length;
  const complete = ledger.paging.complete;
  return {
    loaded,
    complete,
    text: complete
      ? `共 ${loaded} 项（已全部载入）`
      : `已载入 ${loaded} 项 · 还有没载入的功能（本页之后还有，要继续读取）`,
  };
}

/** 概览「需要你看一眼」默认先列几项（其余按需展开；展开后限高独立滚动，全部仍可读） */
const ATTENTION_PREVIEW = 3;

/**
 * 待决项的**稳定身份**统计。
 *
 * Codex R2 复审（真实已安装 R2 第一页）：读口把**同一份**待议逐功能挂载——塔台 20 条待议重复挂在 7 个功能上，
 * 直接对 `item.pending_decisions.length` 求和会得到 140，读起来像真有 140 个待决问题，明显误导。
 *
 * 这里按读口给的**稳定身份** `decision_id`（待议源的行定位符，如 `discuss#L12`）去重：
 * 同一待决关联多个功能只算一次；各功能项自己的 `pending_decisions` **原样保留**，关联不丢。
 * 拿不到稳定身份（空 id）时**不按中文标题猜**：如实退回「关联次数」口径，逐处计数并明说不去重。
 */
interface DecisionTally {
  /** 去重后的问题数；`null` = 原始记录没有可用的稳定身份，不做去重 */
  unique: number | null;
  /** 关联次数：已载入功能项挂着的待决处数之和（未去重） */
  links: number;
}

function tallyDecisions(items: FeatureItem[]): DecisionTally {
  const byId = new Map<string, Set<string>>();
  let links = 0;
  let unstable = false;
  for (const item of items) {
    for (const d of item.pending_decisions) {
      links += 1;
      const id = d.decision_id.trim();
      if (id === "") {
        unstable = true;
        continue;
      }
      const owners = byId.get(id);
      if (owners === undefined) byId.set(id, new Set([item.item_id]));
      else owners.add(item.item_id);
    }
  }
  return { unique: unstable ? null : byId.size, links };
}

/** 待决计数的人话（分清「去重后的问题数」与「关联次数」；身份不可靠时不假装去重过） */
function decisionSentence(t: DecisionTally, complete: boolean): string {
  const scope = complete ? "" : "（当前已载入范围内）";
  if (t.unique === null) {
    return `待决关联 ${t.links} 处需要人（或获授权的设计角色）定${scope}：这些记录没有稳定的身份标识，按关联次数计、不做去重，逐条见下面的功能项。`;
  }
  const head = `有 ${t.unique} 个待决问题需要人（或获授权的设计角色）定${scope}`;
  const dup =
    t.links > t.unique ? `；同一问题被 ${t.links} 处功能项关联，这里按问题去重、只算一次` : "";
  return `${head}${dup}，见下面的功能项。`;
}

/** 清单面板页眉里的待决短读数（同上口径，不把重复挂载求和当问题数） */
function decisionShort(t: DecisionTally): string {
  if (t.unique === null) return `待决关联 ${t.links} 处（按次数，未去重）`;
  return t.links > t.unique ? `待决 ${t.unique} 项（关联 ${t.links} 处）` : `待决 ${t.unique} 项`;
}

/**
 * 概览页眉：标题旁给一枚**明确的「查看功能清单」快捷入口**（Codex 最终复核补口）。
 *
 * 为什么需要：真实设计书正文很长（窄窗下 2000+px），清单排在正文之后——不靠这枚按钮，
 * 用户得先滚过整本设计才找得到功能清单。入口只做**定位**：滚到**同一设计页自己的**
 * `[data-feature-ledger]` 并把焦点落上去；**不改 `location.hash`**（保住 `#p/<项目>` 路由），
 * 不按标题文字模糊找，也不动清单自身的折叠/分页与状态。
 */
function jumpToFeatureLedger(ev: { currentTarget: HTMLElement }): void {
  const scope = ev.currentTarget.closest("[data-design-view]") ?? document;
  const target = scope.querySelector("[data-feature-ledger]");
  if (!(target instanceof HTMLElement)) return;
  target.scrollIntoView({ block: "start" });
  target.focus({ preventScroll: true });
}

function OverviewHeader() {
  return (
    <div className="tt-ov-head">
      <h3 className="tt-ov-title">功能概览</h3>
      <button
        type="button"
        data-overview-ledger-jump
        onClick={jumpToFeatureLedger}
        className="tt-ov-jump"
      >
        查看功能清单
      </button>
    </div>
  );
}

/**
 * 顶部**功能概览**（首屏人话；Codex 复审 7）。
 *
 * 只做四件事：① 有多少功能、验证过了几个；② 缺什么（设计/证据/来源）；③ 下一步该谁做（人还是 Agent）；
 * ④ 当前读的是哪一版。技术标识/哈希/行号不在这里出现——它们在清单面板的详情里。
 *
 * 密度（Codex R2 复审）：真实第一页 50 项、37 项要人看，逐条默认平铺会把设计正文与旁侧清单挤出首屏。
 * 所以「需要你看一眼」**默认只列前 3 项**，总数照旧点名，其余按需展开进限高独立滚动区（键盘可聚焦阅读），
 * 一条都不删；概览因此**有界**，正文与功能清单入口留在首屏。
 */
export function FeatureOverview(props: FeatureLedgerBundle) {
  const { ledger, error, loading, onRetry } = props;

  if (error !== null) {
    return (
      <section data-feature-overview data-overview-state={error.unsupported ? "unsupported" : "error"} className="tt-ov">
        <OverviewHeader />
        <p data-overview-error className="tt-fl-error">
          {error.unsupported
            ? "这个后端还没有功能清单这一项，暂时看不到功能概览；设计书正文照常可看。"
            : `功能概览暂时读不到：${error.message}`}
          <button type="button" data-overview-retry onClick={onRetry} className="tt-fl-retry">
            重试
          </button>
        </p>
      </section>
    );
  }
  if (ledger === null) {
    return (
      <section data-feature-overview data-overview-state="loading" className="tt-ov">
        <OverviewHeader />
        <p data-overview-loading className="tt-fl-muted">
          {loading ? "正在读取功能清单…" : "（还没有可显示的功能数据）"}
        </p>
      </section>
    );
  }
  if (ledger.state === "not_derived") {
    return (
      <section data-feature-overview data-overview-state="not_derived" className="tt-ov">
        <OverviewHeader />
        <p data-overview-not-derived className="tt-fl-warn">
          这个版本还没有功能清单可以核对：{ledger.reason ?? "定义尚未派生"}{" "}
          {ledger.next_read !== undefined ? `（补取入口：${ledger.next_read}）` : ""}
        </p>
      </section>
    );
  }

  const items = ledger.items;
  const green = items.filter(verificationIsGreen).length;
  const missingDesign = items.filter((i) => i.design_coverage.state === "缺失").length;
  const stale = items.filter((i) => i.design_coverage.state === "源变待复核").length;
  const needYou = items.filter((i) => attentionReasons(i).length > 0);
  const tally = tallyDecisions(items);
  const attentionPreview = needYou.slice(0, ATTENTION_PREVIEW);
  const attentionOverflow = needYou.slice(ATTENTION_PREVIEW);
  const todo = items.filter((i) => !verificationIsGreen(i)).length;
  const page = pagingReadout(ledger);
  const staleSelection = ledger.document_selection.requested !== props.selector;
  const versionMismatch =
    props.bodyDesignRevision !== null &&
    ledger.document_selection.design_revision !== null &&
    props.bodyDesignRevision !== ledger.document_selection.design_revision;

  return (
    <section data-feature-overview data-overview-state="ok" className="tt-ov">
      <OverviewHeader />
      <p data-overview-summary data-overview-loaded={page.loaded} data-overview-complete={page.complete ? "1" : "0"} className="tt-ov-summary">
        {page.text} · 验证已通过 {green} 项 · 待继续 {todo} 项
        {missingDesign > 0 ? ` · 缺设计依据 ${missingDesign} 项` : ""}
        {stale > 0 ? ` · 要复验 ${stale} 项` : ""}
      </p>

      {(staleSelection || versionMismatch) && (
        <p data-overview-stale-version className="tt-fl-warn">
          正在切换版本：这里显示的功能读数来自
          {selectorLabel(ledger.document_selection.requested, ledger)}
          ，与当前正文不是同一版，先不当成当前结论（读完会自动换成所选版本）。
        </p>
      )}

      {needYou.length > 0 && (
        <div
          data-ledger-attention
          data-ledger-attention-count={needYou.length}
          data-ledger-attention-preview={attentionPreview.length}
          data-ledger-attention-hidden={attentionOverflow.length > 0 ? "1" : "0"}
          data-overview-attention
          className="tt-ov-block"
        >
          <p data-ledger-attention-head className="tt-ov-block-head">
            需要你看一眼（{needYou.length} 项{page.complete ? "" : "，当前已载入范围内"}）：
          </p>
          <ul data-ledger-attention-list className="tt-ov-list">
            {attentionPreview.map((i) => (
              <li key={i.item_id} data-ledger-attention-item={i.item_id}>
                {i.display_name}：{attentionReasons(i).join(" · ")}
              </li>
            ))}
          </ul>
          {attentionOverflow.length > 0 && (
            <details data-ledger-attention-more className="tt-ov-more">
              <summary data-ledger-attention-more-summary className="tt-ov-more-summary">
                查看全部 {needYou.length} 项（还有 {attentionOverflow.length} 项）
              </summary>
              <ul
                data-ledger-attention-list-all
                className="tt-ov-list tt-ov-list-scroll"
                tabIndex={0}
                aria-label={`需要你看一眼的全部 ${needYou.length} 项（限高可滚动，键盘可读）`}
              >
                {attentionOverflow.map((i) => (
                  <li key={i.item_id} data-ledger-attention-item={i.item_id}>
                    {i.display_name}：{attentionReasons(i).join(" · ")}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {tally.links > 0 && (
        <p
          data-overview-decisions
          data-decision-unique={tally.unique === null ? "" : String(tally.unique)}
          data-decision-links={tally.links}
          className="tt-ov-next"
        >
          {decisionSentence(tally, page.complete)}
        </p>
      )}

      {todo > 0 && (
        <p data-overview-next className="tt-ov-next">
          还有 {todo} 项没验完：这部分是继续做的活（交给执行方），不需要你现在逐项拍板；
          等验证真过了、只剩接受或退回时才轮到你。
        </p>
      )}

      <p data-overview-version data-overview-version-mode={ledger.document_selection.mode} className="tt-fl-muted">
        当前依据的版本：{selectorLabel(ledger.document_selection.requested, ledger)}
        {ledger.document_selection.drift !== null ? ` · ${ledger.document_selection.drift}` : ""}
      </p>
    </section>
  );
}

/**
 * 功能清单面板（只读；正文旁）。
 *
 * 结构：① 摘要一行（在/载入读数 + 验证通过数）；② 版本/旧读数提示；③ 反向定位；
 * ④ 全部功能项（窄窗可折叠；展开后每项 4 维文字 + 点回原文 + 限高详情）；⑤ 真实分页续读；
 * ⑥ 「我补充一个需求」只追加输入。
 */
export function FeatureLedgerView(props: FeatureLedgerBundle) {
  const {
    selector,
    ledger,
    error,
    loading,
    onRetry,
    onLocateSection,
    activeSectionLine,
    onSupplement,
    supplementBusy,
    supplementError,
    supplementNote,
    supplementDraft,
    onSupplementDraftChange,
    bodyDesignRevision,
    onLoadMore,
    loadMoreBusy,
    loadMoreError,
    pagingNotice,
  } = props;
  const [listOpen, setListOpen] = useState(true);

  // ── 失败 / 未接入（旧服务） / 尚未派生 / 加载中：都要显式，不假空成功 ──
  if (error !== null) {
    return (
      <section
        data-feature-ledger
        data-ledger-state={error.unsupported ? "unsupported" : "error"}
        tabIndex={-1}
        className="tt-fl"
      >
        <header className="tt-fl-head">
          <h3 className="tt-fl-title">功能清单</h3>
        </header>
        {error.unsupported ? (
          <p data-ledger-unsupported className="tt-fl-error">
            这个后端还不认识功能清单这一项；这不表示清单为空或已经通过——设计书正文照常可看，界面也不会拿别的东西顶替。
          </p>
        ) : (
          <p data-ledger-error className="tt-fl-error">
            读取失败：{error.message}
            {error.status !== null ? `（HTTP ${error.status}${error.code !== "" ? ` · ${error.code}` : ""}）` : ""}
            <button type="button" data-ledger-retry onClick={onRetry} className="tt-fl-retry">
              重试
            </button>
          </p>
        )}
      </section>
    );
  }

  if (ledger === null) {
    return (
      <section data-feature-ledger data-ledger-state="loading" tabIndex={-1} className="tt-fl">
        <header className="tt-fl-head">
          <h3 className="tt-fl-title">功能清单</h3>
        </header>
        <p data-ledger-loading className="tt-fl-muted">
          {loading ? "正在读取功能清单…" : "（没有可显示的数据）"}
        </p>
      </section>
    );
  }

  const items = ledger.items;
  const attributed = items.filter((i) => i.item_id.startsWith("cap-"));
  const pendingItems = items.filter((i) => i.item_id.startsWith("pending:"));
  const green = items.filter(verificationIsGreen).length;
  const tally = tallyDecisions(items);
  const page = pagingReadout(ledger);
  const staleSelection = ledger.document_selection.requested !== selector;
  const versionMismatch =
    bodyDesignRevision !== null &&
    ledger.document_selection.design_revision !== null &&
    bodyDesignRevision !== ledger.document_selection.design_revision;
  const dimmed = staleSelection || versionMismatch;

  const sectionRelated =
    activeSectionLine === null
      ? null
      : items.filter((i) =>
          i.design_section_refs.some((r) => r.status === "located" && r.line === activeSectionLine),
        );

  return (
    <section
      data-feature-ledger
      data-ledger-state={ledger.state}
      data-ledger-stale-version={staleSelection ? "1" : "0"}
      tabIndex={-1}
      className={`tt-fl${dimmed ? " tt-fl-dimmed" : ""}`}
    >
      <header className="tt-fl-head">
        <h3 className="tt-fl-title">功能清单</h3>
        <span
          data-ledger-summary
          data-ledger-items={items.length}
          data-ledger-green={green}
          data-ledger-loaded={page.loaded}
          data-ledger-complete={page.complete ? "1" : "0"}
          className="tt-fl-summary"
        >
          {page.text} · 验证已通过 {green} 项 · {decisionShort(tally)}
        </span>
      </header>

      {/* 旧版读数提示：不与新正文混成一个当前结论（Codex 复审 6） */}
      {staleSelection && (
        <p data-ledger-stale-version-note className="tt-fl-warn">
          这些功能读数来自
          {selectorLabel(ledger.document_selection.requested, ledger)}
          （不是当前正文那一版）：正在换成所选版本，先别把它当成当前结论。
        </p>
      )}
      {versionMismatch && (
        <p data-ledger-version-mismatch className="tt-fl-warn">
          正文与清单不是同一个版本（正文 {shortHash(bodyDesignRevision)} / 清单{" "}
          {shortHash(ledger.document_selection.design_revision)}）：正在同步或数据已过期，等读口重读后再下结论。
        </p>
      )}
      {ledger.state === "not_derived" && (
        <p data-ledger-not-derived className="tt-fl-warn">
          这个版本还没有可核对的功能清单：{ledger.reason ?? "定义尚未派生"}
          {ledger.next_read !== undefined ? `（补取入口：${ledger.next_read}）` : ""}
        </p>
      )}
      {!ledger.coverage.source_complete && (
        <p data-ledger-source-incomplete className="tt-fl-warn">
          来源没有读齐，先别把这份清单当完整：
          {ledger.coverage.unexamined_sources.length > 0
            ? ledger.coverage.unexamined_sources.map((s) => `${s.ref}（${s.reason}）`).join("；")
            : `已登记需求 ${ledger.coverage.registered_requirement_count} 条，映射+待映射 ${ledger.coverage.mapped_count + ledger.coverage.pending_count}` +
              (typeof ledger.coverage.registered_candidate_count === "number"
                ? `，已登记待确认候选 ${ledger.coverage.registered_candidate_count}`
                : "")}
        </p>
      )}

      {/* ── 反向定位：正文选中章节 → 关联功能/任务；无对应显式「待归属」 ── */}
      {sectionRelated !== null && (
        <div data-ledger-related-line={activeSectionLine} className="tt-fl-related">
          {sectionRelated.length === 0 ? (
            page.complete ? (
              <p data-ledger-unassigned className="tt-fl-muted">
                这个章节暂时没有对应的功能或任务（待归属）：不硬凑相近的标题。
              </p>
            ) : (
              <p data-ledger-unassigned-pending className="tt-fl-muted">
                已载入的这些功能里，这一段还没有对应的功能或任务；后面还有没读进来的项，
                读完才能断定它是不是真的没有归属——不把「还没读」当成「没有」。
              </p>
            )
          ) : (
            <p data-ledger-related className="tt-fl-muted">
              这个章节承载 {sectionRelated.length} 项功能：
              {sectionRelated.map((i) => i.display_name).join("、")}
            </p>
          )}
        </div>
      )}

      {/* ── 全部功能项（窄窗可折叠；异常项在顶部概览里常显） ── */}
      <div className="tt-fl-listbar">
        <button
          type="button"
          data-ledger-list-toggle
          onClick={() => setListOpen((v) => !v)}
          className="tt-fl-toggle"
        >
          {listOpen ? "收起全部功能项" : `展开已载入的 ${items.length} 项功能`}
        </button>
        <span className="tt-fl-muted">
          （已归属 {attributed.length} · 待归属/待补 {pendingItems.length}）
        </span>
      </div>

      {listOpen && (
        <ul data-ledger-list className="tt-fl-list">
          {items.map((item) => (
            <FeatureLedgerItem
              key={item.item_id}
              item={item}
              onLocateSection={onLocateSection}
              activeSectionLine={activeSectionLine}
            />
          ))}
        </ul>
      )}

      {/* ── 分页续读（真实 cursor 续读；pagecomplete ≠ sourcecomplete） ── */}
      <div
        data-ledger-paging
        data-ledger-paging-complete={ledger.paging.complete ? "1" : "0"}
        className="tt-fl-paging"
      >
        {ledger.paging.complete ? (
          <span className="tt-fl-muted">已全部载入（是否有来源没读齐，看上面的提示）。</span>
        ) : (
          <>
            <button
              type="button"
              data-ledger-load-more
              disabled={loadMoreBusy}
              onClick={onLoadMore}
              className="tt-fl-toggle"
            >
              {loadMoreBusy ? "正在读取下一页…" : "继续读取下一页"}
            </button>
            <span data-ledger-remaining className="tt-fl-muted">
              （本页之后还有未载入的功能）
            </span>
          </>
        )}
      </div>
      {pagingNotice !== null && (
        <p data-ledger-paging-notice className="tt-fl-warn">
          {pagingNotice}
        </p>
      )}
      {loadMoreError !== null && (
        <p data-ledger-paging-error className="tt-fl-error">
          下一页没读进来（已载入的内容仍在）：{loadMoreError}
        </p>
      )}

      {/* ── 我补充一个需求（复用只追加的待议写口；提交不自动采纳） ── */}
      <div data-ledger-supplement className="tt-fl-supplement">
        <p className="tt-fl-muted">
          我补充一个需求（进入「待议」，只追加）：这里提的不会自动被采纳，也不会改已审定的设计；
          它先落到待议，由人或获授权的设计角色核实后再归入设计正文。
        </p>
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            const text = supplementDraft.trim();
            if (text === "" || supplementBusy) return;
            // 草稿的清除交给父组件：**只有提交成功**才清，而且只清提交的那一段
            // （发送期间继续编辑的新文案不能丢）。
            onSupplement(text);
          }}
          className="tt-fl-supplement-form"
        >
          <textarea
            data-ledger-supplement-input
            rows={2}
            value={supplementDraft}
            onChange={(e) => onSupplementDraftChange(e.target.value)}
            placeholder="问题 … ｜ 依据 … ｜ 建议 …"
            className="tt-fl-input"
          />
          <button
            type="submit"
            data-ledger-supplement-submit
            disabled={supplementBusy || supplementDraft.trim() === ""}
            className="tt-fl-supplement-btn"
          >
            补充到待议
          </button>
        </form>
        {supplementError !== null && (
          <p data-ledger-supplement-error className="tt-fl-error">
            补充失败（草稿保留，可重试）：{supplementError}
          </p>
        )}
        {supplementNote !== null && (
          <p data-ledger-supplement-note className="tt-fl-note">
            {supplementNote}
          </p>
        )}
      </div>
    </section>
  );
}

/** 一项功能：默认白话（做什么 + 四维）；详情收进限高独立滚动的 `<details>`。 */
function FeatureLedgerItem({
  item,
  onLocateSection,
  activeSectionLine,
}: {
  item: FeatureItem;
  onLocateSection: (ref: CoverageDesignSectionRef) => void;
  activeSectionLine: number | null;
}) {
  const dc = item.design_coverage.state;
  const green = verificationIsGreen(item);
  const isActive =
    activeSectionLine !== null &&
    item.design_section_refs.some((r) => r.status === "located" && r.line === activeSectionLine);
  const reasons = attentionReasons(item);
  const todo = agentTodoReasons(item);

  return (
    <li
      data-ledger-item={item.item_id}
      data-design-coverage={dc}
      data-implementation={item.implementation.state}
      data-verification={item.verification.display_status}
      data-evidence-state={item.verification.evidence_state}
      data-user-acceptance={item.user_acceptance.state}
      data-ledger-active={isActive ? "1" : "0"}
      className={`tt-fl-item${green ? " tt-fl-item-verified" : ""}${isActive ? " tt-fl-item-active" : ""}`}
    >
      <div className="tt-fl-item-head">
        <span data-ledger-item-name className="tt-fl-item-name">
          {item.display_name}
        </span>
        <span data-ledger-item-id className="tt-fl-id">
          {item.item_id}
        </span>
        {green && (
          <span data-ledger-verified className="tt-fl-badge-green">
            验证已通过
          </span>
        )}
      </div>

      {/* 「这个功能让你做什么」——默认简短白话 */}
      <p data-ledger-item-desc className="tt-fl-desc">
        {item.user_description !== "" ? item.user_description : "（这个功能还没有人话说明）"}
        {item.scenario !== "" ? ` · 场景：${item.scenario}` : ""}
      </p>

      {/* 四维分开显示（无颜色也能辨：每维都带文字标签） */}
      <div data-ledger-dims className="tt-fl-dims">
        <span data-ledger-dim="design_coverage" className="tt-fl-dim">
          <span className="tt-fl-dim-label">设计覆盖</span>
          <span className={designCoverageClass(dc)}>{dc === "缺失" ? "缺设计·待补" : dc}</span>
        </span>
        <span data-ledger-dim="implementation" className="tt-fl-dim">
          <span className="tt-fl-dim-label">实现</span>
          <span className="tt-fl-dim-value">{implLabel(item.implementation.state)}</span>
        </span>
        <span data-ledger-dim="verification" className="tt-fl-dim">
          <span className="tt-fl-dim-label">验证</span>
          <span className={green ? "tt-fl-dim-value tt-fl-green" : "tt-fl-dim-value tt-fl-unknown"}>
            {DISPLAY_LABEL[item.verification.display_status] ?? item.verification.display_status}
            （{EVIDENCE_LABEL[item.verification.evidence_state] ?? item.verification.evidence_state}，{item.verification.passed_count}/
            {item.verification.required_count}）
          </span>
        </span>
        <span data-ledger-dim="user_acceptance" className="tt-fl-dim">
          <span className="tt-fl-dim-label">你的接受</span>
          <span className="tt-fl-dim-value">{ACCEPT_LABEL[item.user_acceptance.state] ?? item.user_acceptance.state}</span>
        </span>
      </div>

      {reasons.length > 0 && (
        <p data-ledger-item-attention className="tt-fl-warn">
          {reasons.join(" · ")}
        </p>
      )}
      {reasons.length === 0 && todo.length > 0 && (
        <p data-ledger-item-todo className="tt-fl-muted">
          继续做（不需要你现在决定）：{todo.join(" · ")}
        </p>
      )}

      {/* 可点回原文的设计章节（精确 anchor/line/hash；定位不到显式报） */}
      {item.design_section_refs.length > 0 && (
        <div data-ledger-refs className="tt-fl-refs">
          {item.design_section_refs.map((ref) => (
            <button
              key={`${ref.anchor}:${ref.line}`}
              type="button"
              data-ledger-ref={ref.anchor}
              data-ledger-ref-status={ref.status}
              title={`${ref.title}（第 ${ref.line} 行，章节 hash ${ref.hash}）`}
              onClick={() => onLocateSection(ref)}
              className="tt-fl-ref"
              disabled={ref.status !== "located"}
            >
              {ref.status === "located" ? "跳回原文" : "定位不到"}：{ref.title}
            </button>
          ))}
        </div>
      )}

      {/* 待决问题：**数量**常显（上面的提醒文案已点名「本项关联 N 个待决问题」）；
          完整长列表默认收起，按需展开——真实现场里同一份 20 条待议会逐功能重复挂载，
          平铺开来单项就能撑到 6000+ px，功能列表根本扫不动。这里**一条不删、身份照旧**，
          只是默认不铺开；展开后限高独立滚动（同项详情口径）。 */}
      {item.pending_decisions.length > 0 && (
        <details data-ledger-decisions-details className="tt-fl-detail">
          <summary data-ledger-decisions-summary className="tt-fl-decisions-summary">
            查看本项关联的 {item.pending_decisions.length} 个待决问题
          </summary>
          <div
            data-ledger-decisions-body
            className="tt-fl-detail-body tt-fl-decisions-body"
            tabIndex={0}
            aria-label={`本项关联的 ${item.pending_decisions.length} 个待决问题（限高可滚动，键盘可读）`}
          >
            <ul data-ledger-decisions className="tt-fl-decisions">
              {item.pending_decisions.map((d, i) => (
                /* key 带上位置：`decision_id` 是稳定身份，但**身份不可用时为空串**
                   （S17b 故障分支），多个空串在同一 ul 里会撞 key —— React 会「重复/丢项」，
                   正好违反本卡「一条不丢」。身份照旧原样挂在 data 属性上，不靠 key 表达。 */
                <li key={`${d.decision_id}@${i}`} data-ledger-decision={d.decision_id}>
                  <span className="tt-fl-warn">待决：</span>
                  {d.question}（影响：{d.impact}；建议：{d.suggestion}；入口：{d.entry}）
                </li>
              ))}
            </ul>
          </div>
        </details>
      )}

      {/* 详细技术字段：按需展开，限高独立滚动 */}
      <details data-ledger-detail className="tt-fl-detail">
        <summary>详情（技术字段 / 来源 / 证据）</summary>
        <div data-ledger-detail-body className="tt-fl-detail-body">
          <dl className="tt-fl-dl">
            <dt>功能 ID</dt>
            <dd>{item.item_id}</dd>
            <dt>实现依据</dt>
            <dd>{item.implementation.basis ?? "（账本没有运行投影）"}</dd>
            <dt>验证有效版本</dt>
            <dd>{item.verification.effective_version ?? "（拿不到）"}</dd>
            <dt>缺的证据</dt>
            <dd>
              {item.verification.missing.length === 0
                ? "（无）"
                : item.verification.missing.map((m, i) => <div key={i}>{m}</div>)}
            </dd>
            <dt>证据入口</dt>
            <dd>
              {item.verification.evidence_entry.length === 0
                ? "（无）"
                : item.verification.evidence_entry.map((e) => (
                    <div key={`${e.check_id}:${e.evidence_ref}`}>
                      {e.check_id} · {e.effective} · {e.evidence_ref.slice(0, 12)}…
                    </div>
                  ))}
            </dd>
            <dt>设计覆盖审定</dt>
            <dd>
              审定人 {item.design_coverage.review.reviewer ?? "（空，未审定）"} · ref{" "}
              {item.design_coverage.review.ref ?? "—"} · 形态 {item.design_coverage.review.ref_kind} ·
              section_sha256 {shortHash(item.design_coverage.review.section_sha256)}
              {item.design_coverage.review.unmet !== null && <div>未通过原因：{item.design_coverage.review.unmet}</div>}
              {item.design_coverage.gap !== null && <div>缺口：{item.design_coverage.gap}</div>}
            </dd>
            <dt>需求来源</dt>
            <dd>
              {item.requirement_refs.length === 0
                ? "（无）"
                : item.requirement_refs.map((r) => (
                    <div key={r.requirement_id}>
                      {r.requirement_id} · {r.certainty} · {r.source_ref}
                    </div>
                  ))}
            </dd>
            <dt>任务</dt>
            <dd>
              {item.task_refs.length === 0
                ? "（无）"
                : item.task_refs.map((t) => (
                    <div key={t.task_id}>
                      {t.task_id} · 定义指纹 {shortHash(t.definition_fingerprint)}
                    </div>
                  ))}
            </dd>
            <dt>用户接受边界</dt>
            <dd>
              成员 {item.user_acceptance.scope_tasks.join("、") || "（无）"} · 已接受{" "}
              {item.user_acceptance.accepted_tasks.join("、") || "（无）"} · 记录{" "}
              {item.user_acceptance.gate_ref ?? "—"}
              {item.user_acceptance.unmet !== null && <div>{item.user_acceptance.unmet}</div>}
            </dd>
            <dt>来源与派生</dt>
            <dd>
              提取 {item.provenance.extraction} · 范围 {item.scope_id ?? "（未定）"} · 派生设计{" "}
              {shortHash(item.provenance.derivation.design_revision)} · 账本末序号{" "}
              {item.provenance.derivation.ledger_last_seq}
              {item.provenance.unmapped.length > 0 && <div>未映射：{item.provenance.unmapped.join("、")}</div>}
              {item.provenance.pending_leads.length > 0 && (
                <div>待审线索（模型提案，未审定）：{item.provenance.pending_leads.join("、")}</div>
              )}
            </dd>
          </dl>
        </div>
      </details>
    </li>
  );
}
