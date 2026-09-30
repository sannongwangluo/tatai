// V09-24：主工作面「同步证据状态」小摘要（DESIGN.md §2.10；契约 docs/sync-evidence-contract.md
// 「接口、界面和交付」；返回体与判据的单一出处是 src/shared/syncEvidence.ts，界面只读它）。
//
// 口径（为什么长这样）：
//   · **只读**：只发 `GET /api/projects/:id/sync-status`（轮询 + 手动刷新），零写操作、零模型调用；
//     状态与颜色一律来自返回体，**不在端上另算完成色**——`overall`/`verdict` 值集与中文短标
//     都用 shared 的 `SYNC_VERDICT_LABELS`，不自己造词（「失败不能默认绿」：只有
//     `passed` + 无 scan_error + `collection.complete` 才显绿）。
//   · **小摘要 + 按需详情**：默认只占状态条下面一行（结论 / 现行范围项数 / 核对时间），详情是**浮层**，
//     不占纵向排版、不加大页签、不挤画布（§3.1/§3.11 的人用图面口径）。详情 toggle 带 `aria-expanded`
//     与 `aria-controls`，面板用 `role=dialog` + `aria-labelledby` 关联可访问标签。
//   · **现行 vs 已取代**：范围与差项只按现行（`active`）批次算；被 supersede 的历史单列、默认折叠，
//     但仍可在详情里点开逐项查（不参与「缺几项」、不再阻断）。
//   · **不串数据**：每次取数带 AbortController + 代际号，切项目/卸载时作废在途回包，
//     旧项目的响应不写进新项目界面（§3.1）。
import { useCallback, useEffect, useRef, useState } from "react";
import { getSyncStatus, isBackendUnreachable } from "../api";
import { SYNC_VERDICT_LABELS, type SyncStatusReport, type SyncVerdict } from "../../shared/syncEvidence";

/** 轮询间隔：只读小读口，10 秒足够「人看一眼」的时效，也不至于把本机服务压出无谓流量 */
export const SYNC_POLL_MS = 10_000;

/** 摘要状态键：`SYNC_VERDICT_LABELS` 的全部取值 + 三种「还没有结论」的现场 */
type SyncUiState = SyncVerdict | "loading" | "error" | "scan_error";

const TONE_CLASS: Readonly<Record<SyncUiState, string>> = {
  loading: "text-neutral-500",
  not_configured: "text-neutral-400",
  missing: "text-amber-300",
  failed: "text-amber-300",
  stale: "text-amber-300",
  needs_review: "text-amber-300",
  incomplete: "text-amber-300",
  invalid: "text-red-400",
  scan_error: "text-red-400",
  error: "text-red-400",
  passed: "text-emerald-400",
};

const CHIP_CLASS: Readonly<Record<SyncUiState, string>> = {
  loading: "border-neutral-700 text-neutral-400",
  not_configured: "border-neutral-700 text-neutral-300",
  missing: "border-amber-700 text-amber-200",
  failed: "border-amber-700 text-amber-200",
  stale: "border-amber-700 text-amber-200",
  needs_review: "border-amber-700 text-amber-200",
  incomplete: "border-amber-700 text-amber-200",
  invalid: "border-red-700 text-red-200",
  scan_error: "border-red-700 text-red-200",
  error: "border-red-700 text-red-200",
  passed: "border-emerald-700 text-emerald-200",
};

/** 只有这一档才显绿：接口说通过、本次扫描无错、范围已取齐 */
function isGreen(r: SyncStatusReport | null, state: SyncUiState): boolean {
  return state === "passed" && r !== null && r.scan_error === null && r.collection.complete;
}

/**
 * 摘要结论（唯一判据出处）：scan_error 优先于 overall；`passed` 但范围没取齐不算通过。
 * 注意 `SYNC_VERDICT_LABELS.failed` 是「发现缺项」、`missing` 是「等待证据」——顺序不能反，
 * 契约里 `missing`＝证据缺失、`failed`＝对账发现不一致。
 *
 * 判据顺序（2026-09-30 Codex 复查修订）：`configured=false` **不得**吞掉后端已给出的失败结论或
 * 「范围未取齐」。旧写法把 `!configured` 放在最前，会把 `configured=false overall=invalid
 * collection.complete=false` 误显示成「未配置」。现行顺序：
 *   1) 扫描出错 ⇒ scan_error；
 *   2) overall 是 passed / not_configured 之外的明确结论（missing/failed/stale/needs_review/
 *      invalid/incomplete）⇒ 如实透传，它是后端给出的判据；
 *   3) 范围未取齐 ⇒ incomplete（降级，先于「通过」与「未配置」）；
 *   4) 只有「后端说未配置且确未登记」（读取正常、无失败信号）才是 not_configured；
 *   5) 其余（已登记却报未配置、或未登记却报通过）是自相矛盾的返回体 ⇒ invalid：不冒充通过，
 *      也不冒充未配置。
 */
function headlineStateOf(r: SyncStatusReport): SyncUiState {
  if (r.scan_error !== null) return "scan_error";
  if (r.overall !== "passed" && r.overall !== "not_configured") return r.overall;
  if (!r.collection.complete) return "incomplete";
  if (!r.configured && r.overall === "not_configured") return "not_configured";
  if (!r.configured || r.overall === "not_configured") return "invalid";
  return "passed";
}

function labelOf(state: SyncUiState): string {
  if (state === "error") return "读取失败";
  if (state === "loading") return "读取中";
  if (state === "scan_error") return SYNC_VERDICT_LABELS.invalid; // 「检查失败」：检查本身没跑完
  return SYNC_VERDICT_LABELS[state];
}

function jsonText(v: unknown): string {
  if (v === null || v === undefined) return "（无）";
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 400 ? `${s.slice(0, 400)}…（共 ${s.length} 字符，完整值见返回体）` : s;
}

function shortSha(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha;
}

export function SyncEvidenceStatus({ project }: { project: { id: string } }) {
  const [report, setReport] = useState<SyncStatusReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    const id = project.id;
    const gen = ++genRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    return getSyncStatus(id, { signal: ac.signal })
      .then((r) => {
        if (genRef.current !== gen) return; // 换项目/重开：这份回包作废（§3.1）
        setReport(r);
        setError(null);
      })
      .catch((e: Error) => {
        if (genRef.current !== gen || ac.signal.aborted) return;
        // 失败**保留**上一次成功读数（与顶部状态条同口径），只把结论降级成「读取失败」，绝不显绿
        setError(e.message);
      });
  }, [project.id]);

  useEffect(() => {
    // 换项目：先作废在途回包并清现场，再取本项目的数据
    genRef.current += 1;
    abortRef.current?.abort();
    setReport(null);
    setError(null);
    setOpen(false);
    void load();
    const timer = setInterval(() => void load(), SYNC_POLL_MS);
    return () => {
      clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [load]);

  // 根本没连上后端时快重试（与 App 的列表/状态条同口径）；业务错误不快重试，如实报出来
  useEffect(() => {
    if (error === null || !isBackendUnreachable(error)) return;
    const timer = setInterval(() => void load(), 1000);
    return () => clearInterval(timer);
  }, [error, load]);

  const state: SyncUiState =
    error !== null ? "error" : report === null ? "loading" : headlineStateOf(report);
  const green = error === null && isGreen(report, state);

  // 范围与差项按**现行（active）批次**算；被 supersede 的历史只单列、不参与「缺几项」，但详情里仍可查
  const batches = report === null ? [] : report.batches;
  const activeBatches = batches.filter((b) => b.active);
  const historyBatches = batches.filter((b) => !b.active);
  const activeItems = activeBatches.flatMap((b) => b.items);
  const historyItems = historyBatches.flatMap((b) => b.items);
  const required = activeItems.filter((i) => i.required);
  const missingRequired = required.filter((i) => i.verdict === "missing");

  return (
    <div
      data-sync-evidence-status
      data-sync-state={state}
      data-sync-green={green ? "1" : "0"}
      data-sync-configured={report === null ? "" : report.configured ? "1" : "0"}
      data-sync-checked-at={report === null ? "" : report.checked_at}
      data-sync-batches={report === null ? "" : String(batches.length)}
      data-sync-batches-active={report === null ? "" : String(activeBatches.length)}
      data-sync-batches-history={report === null ? "" : String(historyBatches.length)}
      data-sync-items={report === null ? "" : String(activeItems.length)}
      data-sync-items-required={report === null ? "" : String(required.length)}
      data-sync-items-missing={report === null ? "" : String(missingRequired.length)}
      data-sync-history-items={report === null ? "" : String(historyItems.length)}
      data-sync-unregistered-count={report === null ? "" : String(report.unregistered_evidence.length)}
      data-sync-collection={report === null ? "" : report.collection.complete ? "complete" : "incomplete"}
      className="relative flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-800 bg-neutral-900/30 px-3 py-1.5 text-[11px]"
    >
      <span className="text-neutral-500">同步证据</span>
      <button
        data-sync-detail-toggle
        type="button"
        aria-expanded={open}
        aria-controls="sync-evidence-detail-panel"
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        title="同步只对已登记范围作结论；点开逐项看期望、实际、原因与证据路径"
        className={`flex items-center gap-2 rounded border px-2 py-0.5 ${CHIP_CLASS[state]}`}
      >
        <span data-sync-label className={TONE_CLASS[state]}>
          {labelOf(state)}
        </span>
        <span data-sync-detail-hint className="text-neutral-500">
          {open ? "收起详情" : "查看详情"}
        </span>
      </button>

      {report !== null && (
        <>
          <span data-sync-scope className="text-neutral-400">
            范围：{batches.length} 批次（现行 {activeBatches.length}
            {historyBatches.length > 0 ? `／历史 ${historyBatches.length}` : ""}）
            {activeItems.length > 0 && (
              <>
                ／现行 {activeItems.length} 项（必需 {required.length}
                {missingRequired.length > 0 && (
                  <span className="text-amber-300">，缺 {missingRequired.length}</span>
                )}
                ）
              </>
            )}
            {historyBatches.length > 0 && <>／历史 {historyItems.length} 项（不计入差项）</>}
          </span>
          <span data-sync-checked-at-label className="text-neutral-500">
            核对时间：{report.checked_at}
          </span>
          {!report.collection.complete && (
            <span data-sync-collection-note className="text-amber-300">
              范围未取齐：{report.collection.reasons.join("；") || "未给原因"}
            </span>
          )}
          {report.unregistered_evidence.length > 0 && (
            <span data-sync-unregistered-note className="text-amber-300">
              未登记证据 {report.unregistered_evidence.length} 份（不采纳）
            </span>
          )}
        </>
      )}

      {error !== null && (
        <span data-sync-error title={error} className="min-w-0 max-w-[46ch] truncate text-red-400">
          读口失败：{error}
          {report !== null && "（下面是上一次成功读到的读数）"}
        </span>
      )}

      <button
        data-sync-refresh
        onClick={() => void load()}
        className="ml-auto rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800"
        title="手动重读同步状态（只读，不触发扫描写账）"
      >
        刷新
      </button>

      {open && (
        <div
          id="sync-evidence-detail-panel"
          role="dialog"
          aria-labelledby="sync-evidence-detail-title"
          data-sync-detail-body
          data-sync-detail-shape="overlay"
          className="absolute top-full left-3 z-30 max-h-[60vh] w-[min(900px,calc(100vw-2rem))] overflow-y-auto rounded border border-neutral-700 bg-neutral-900 p-3 shadow-xl"
        >
          <div className="flex items-start gap-3">
            <span id="sync-evidence-detail-title" className="font-semibold text-neutral-200">
              同步证据详情：<span className={TONE_CLASS[state]}>{labelOf(state)}</span>
            </span>
            <button
              data-sync-detail-close
              type="button"
              onClick={() => setOpen(false)}
              className="ml-auto rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800"
            >
              关闭
            </button>
          </div>

          <p className="mt-1 text-neutral-500">
            只对已登记范围作结论；范围之外的未知内容不声称已覆盖。同步通过只表示所登记范围在该版本对账通过，
            不等于业务实现、独立审核或人工验收。
          </p>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-neutral-400">
            <span data-sync-detail-scope>
              范围：{report === null
                ? "未知"
                : `${batches.length} 批次（现行 ${activeBatches.length}／历史 ${historyBatches.length}）`}
            </span>
            <span>核对时间：{report === null ? "（本次读取失败，无读数）" : report.checked_at}</span>
            <span>配置：{report === null ? "未知" : report.configured ? "已登记契约" : "未登记契约"}</span>
            <span data-sync-collection-detail>
              取值范围：{report === null ? "未知" : report.collection.complete ? "已取齐" : "未取齐"}
            </span>
          </div>

          {report !== null && report.scan_error !== null && (
            <p data-sync-scan-error className="mt-1 text-red-400">
              本次扫描出错：{report.scan_error}（出错即不判通过）
            </p>
          )}
          {report !== null && !report.collection.complete && report.collection.reasons.length > 0 && (
            <ul data-sync-collection-reasons className="mt-1 list-disc pl-5 text-amber-300">
              {report.collection.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}

          {error !== null && (
            <p data-sync-detail-error className="mt-1 text-red-400">
              读口失败：{error}
            </p>
          )}

          {report === null ? (
            <p className="mt-2 text-neutral-500">
              还没有读到达标的返回体——没有读数就不给任何结论，也不会显示为「未配置」。
            </p>
          ) : report.batches.length === 0 ? (
            <p data-sync-empty className="mt-2 text-neutral-500">
              本项目尚未登记同步契约（未配置）。契约登记由设计角色/协调器经明确写接口完成，界面不自动创建需求。
            </p>
          ) : (
            <div className="mt-2 space-y-2">
              {[...activeBatches, ...historyBatches].map((b) => {
                const bRequired = b.items.filter((i) => i.required);
                const bMissing = bRequired.filter((i) => i.verdict === "missing");
                return (
                  <details
                    key={b.batch_id}
                    data-sync-batch={b.batch_id}
                    data-sync-batch-verdict={b.verdict}
                    data-sync-batch-active={b.active ? "1" : "0"}
                    data-sync-batch-missing-required={String(bMissing.length)}
                    open={b.active}
                    className="rounded border border-neutral-800 bg-neutral-950/40 p-2"
                  >
                    <summary className="cursor-pointer text-neutral-200">
                      {b.title}（<code>{b.batch_id}</code>）—— <span className={TONE_CLASS[b.verdict]}>
                        {SYNC_VERDICT_LABELS[b.verdict]}
                      </span>
                      {b.active ? (
                        <span className="ml-2 text-[10px] text-emerald-300">现行批次（计入范围与差项）</span>
                      ) : (
                        <span className="ml-2 text-[10px] text-neutral-500">
                          已被取代（只作历史，不计入范围与差项，不再阻断）
                        </span>
                      )}
                      {b.active && b.blocks_entry && (
                        <span data-sync-batch-blocks={b.batch_id} className="ml-2 text-[10px] text-amber-300">
                          未通过时阻断接续与认领
                        </span>
                      )}
                    </summary>
                    <p className="mt-1 text-[10px] text-neutral-500">
                      证据包：
                      {b.evidence_path === null ? "（还没有证据包）" : <code data-sync-batch-evidence>{b.evidence_path}</code>}
                      {" ｜ 契约哈希："}
                      <code>{shortSha(b.contract_sha256)}</code>
                    </p>
                    <div className="mt-1 space-y-1">
                      {b.items.map((it) => (
                        <div
                          key={it.id}
                          data-sync-item={it.id}
                          data-sync-item-verdict={it.verdict}
                          className="rounded border border-neutral-800 px-2 py-1"
                        >
                          <div className="text-neutral-200">
                            {it.required ? (
                              <span className="mr-1 text-amber-300">[必需]</span>
                            ) : (
                              <span className="mr-1 text-neutral-500">[可选]</span>
                            )}
                            {it.label}（<code>{it.id}</code>）——{" "}
                            <span className={TONE_CLASS[it.verdict]}>{SYNC_VERDICT_LABELS[it.verdict]}</span>
                          </div>
                          <div className="text-neutral-400">
                            期望：<code data-sync-item-expected>{jsonText(it.expected)}</code>
                          </div>
                          <div className="text-neutral-400">
                            实际：<code data-sync-item-actual>{jsonText(it.actual)}</code>
                          </div>
                          {it.reasons.map((r, i) => (
                            <div key={i} data-sync-item-reason className="text-amber-300">
                              原因：{r}
                            </div>
                          ))}
                          {it.artifacts.length === 0 ? (
                            <div className="text-neutral-600">证据路径：无（该项没有可核证据）</div>
                          ) : (
                            it.artifacts.map((a, i) => (
                              <div key={i} data-sync-item-artifact className="text-neutral-400">
                                证据路径：<code>{a.path}</code>
                                <span className="text-neutral-600">（sha256 {shortSha(a.sha256)}）</span>
                              </div>
                            ))
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
          )}

          {report !== null && report.unregistered_evidence.length > 0 && (
            <div data-sync-unregistered className="mt-2">
              <div className="text-neutral-300">发现未登记的证据包（不采纳，也不当作通过）：</div>
              {report.unregistered_evidence.map((u, i) => (
                <div key={i} data-sync-unregistered-row className="text-neutral-400">
                  <code>{u.path}</code>
                  {u.batch_id !== null && <>（批 <code>{u.batch_id}</code>）</>}
                  ：{u.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SyncEvidenceStatus;
