// V09-06：项目信息页里的「私有事实备份/恢复」维护区（PLAN.md V09-06，DESIGN.md §8.5 / §12.2）。
//
// 界面只做三件事，且**只**做这三件：
//   ① 备份：显示清单（格式/事件 schema 版本、截止提交序号、逐份内容哈希与角色、证据清单）；
//   ② 核验：显示八条一致性判据的逐条读数（这份备份到底是不是"某个提交序号的一致切片"）；
//   ③ 隔离恢复预览与执行：恢复只落在**隔离目录**，界面上写死一句"塔台不会自动替换当前数据"。
//
// 三条口径（都来自卡面，不是界面自己发明的）：
//   · **不把 Git 当私有事实备份**：这里说的是 `.工作台/` 的显式备份，与"代码提交了 Git"无关；
//   · **不自动替换**：恢复完只显示隔离目录与逐项核验结果，替换当前数据是用户本人的决定；
//   · 「读取失败」与「真的没有」分开显示（与 ChangesView / AcceptanceView 同一口径）：
//     清单读不出来时逐条如实显示 `ok:false` 的现成条目，而不是渲染成"暂无备份"。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BackupApiError,
  getBackup,
  getBackups,
  postBackup,
  postRestoreBackup,
  type BackupInspectResult,
  type BackupListResult,
  type BackupRestoreResult,
} from "../api";
import { canPickDirectory, pickDirectory } from "../dir-picker";

/** 字节 → 人读（界面只用于显示体量，不参与任何判据） */
function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 失败读数：`code` 是可分辨的失败码（损坏/权限/空间不足/目标不可写/位置不合法…），原样显示 */
function failText(e: unknown): string {
  if (e instanceof BackupApiError) return `${e.code}：${e.message}`;
  return (e as Error).message;
}

/**
 * 跳过原因 → 人话。服务端给的是**可分辨的枚举**（`BackupListSkipped.reason`），界面只负责翻译：
 * "有清单文件却读不出来"与"压根没有清单"是两件事（第 3 轮返工缺陷 D），不能都翻成"不是备份"。
 */
function skipReasonLabel(reason: string): string {
  if (reason === "other_project") return "属于别的项目（塔台不列、不读、也不恢复）";
  if (reason === "manifest_unreadable") return "清单读不出来（多半是损坏或写了一半的那一份）";
  if (reason === "not_a_directory") return "不是目录";
  return "不是可读的备份（没有清单文件，归不了属）";
}

export function BackupPanel({ projectId }: { projectId: string }) {
  const [list, setList] = useState<BackupListResult | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listTick, setListTick] = useState(0);
  /** 清单列的是哪个位置（`""` = 塔台数据目录下的默认落点）——与下面那个「备份位置」输入框同一个值 */
  const [listParent, setListParent] = useState<string>("");

  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<BackupInspectResult | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [backupParent, setBackupParent] = useState<string>("");
  const [restoreParent, setRestoreParent] = useState<string>("");
  const [busy, setBusy] = useState<"create" | "restore" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; reused: boolean; dir: string } | null>(null);
  const [restored, setRestored] = useState<BackupRestoreResult | null>(null);

  // 详情请求序号：晚到的回包只许写进"还是这次请求"的界面（换项目/换位置/换选中项都会 +1）
  const detailReq = useRef(0);

  /** 收起当前详情，并让**在飞的回包作废**（换项目、换位置时用：旧位置那份不许落到新位置的界面上） */
  const dropDetail = useCallback((): void => {
    detailReq.current += 1;
    setSelected(null);
    setDetail(null);
    setDetailError(null);
  }, []);

  // 换项目：位置输入与详情全部归零（回包晚到时不许写进新项目的界面，与 AcceptanceView 同一口径）
  useEffect(() => {
    dropDetail();
    setActionError(null);
    setCreated(null);
    setRestored(null);
    setBackupParent("");
    setRestoreParent("");
    setListParent("");
  }, [projectId, dropDetail]);

  // 清单：换项目、换位置或主动重查都重拉（`listParent` 就是"这次列哪个位置"）
  useEffect(() => {
    let stale = false;
    setList(null);
    setListError(null);
    getBackups(projectId, listParent)
      .then((r) => {
        if (!stale) setList(r);
      })
      .catch((e: Error) => {
        if (!stale) setListError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [projectId, listTick, listParent]);

  /**
   * 读某一份的详情。**位置必须显式传进来**：
   * `listParent` 是 React state，`setListParent` 落到新值之前它还是旧值——刚在自定义位置建完备份就
   * 用闭包里的旧位置去读详情，读到的是**默认落点**那一份（默认目录恰有同名 backupId 时，界面就会
   * 显示另一份，既不报错、也对不上新建的清单）。第 3 轮返工缺陷 A 修的就是这里。
   */
  const loadDetail = useCallback(
    (backupId: string, parent: string) => {
      detailReq.current += 1;
      const req = detailReq.current;
      setSelected(backupId);
      setDetail(null);
      setDetailError(null);
      setRestored(null);
      setActionError(null);
      getBackup(projectId, backupId, parent)
        .then((d) => {
          if (detailReq.current === req) setDetail(d);
        })
        .catch((e: Error) => {
          if (detailReq.current === req) setDetailError(e.message);
        });
    },
    [projectId],
  );

  /**
   * 换清单位置：旧位置那份详情不再属于当前清单 ⇒ 收起它、作废在飞回包，再列新位置。
   *   · 「查询这个位置」按钮走它（位置变了就重新读盘；同一个位置再点一次也重读）；
   *   · 备份到自定义位置成功后也走它（落点变了就得跟着它列）。
   */
  const switchLocation = (parent: string): void => {
    dropDetail();
    setRestored(null);
    setActionError(null);
    setListParent(parent);
    setListTick((t) => t + 1);
  };

  const runCreate = async (): Promise<void> => {
    if (busy !== null) return;
    setBusy("create");
    setActionError(null);
    setCreated(null);
    try {
      const r = await postBackup(projectId, backupParent);
      setCreated({ id: r.backup_id, reused: r.reused, dir: r.dir });
      // 落点变了就得跟着它列（否则"备份到自定义目录"的下一句永远是"清单里找不到"）；
      // 详情读**刚落到**的那个位置（`backupParent`），不是 state 里还没更新的旧位置
      switchLocation(backupParent);
      loadDetail(r.backup_id, backupParent);
    } catch (e) {
      setActionError(failText(e));
    } finally {
      setBusy(null);
    }
  };

  const runRestore = async (): Promise<void> => {
    if (busy !== null || selected === null) return;
    setBusy("restore");
    setActionError(null);
    setRestored(null);
    try {
      const r = await postRestoreBackup(projectId, selected, restoreParent, listParent);
      setRestored(r);
    } catch (e) {
      setActionError(failText(e));
    } finally {
      setBusy(null);
    }
  };

  const pickInto = async (set: (v: string) => void): Promise<void> => {
    const dir = await pickDirectory();
    if (dir !== null) set(dir);
  };

  const entries = list?.entries ?? [];
  const skipped = list?.skipped ?? [];

  return (
    <section className="space-y-3 border-t border-neutral-800 pt-3" data-backup-panel>
      <h3 className="text-sm font-semibold text-neutral-300">私有事实备份/恢复</h3>
      <p className="text-xs text-neutral-500">
        这里备份的是本项目的私有事实（<code className="text-neutral-400">.工作台/</code>）：它
        <strong className="font-semibold text-neutral-300">默认不进 Git</strong>
        ，被忽略不等于已备份。备份在事件提交边界上取一致切片，清单含格式与事件 schema 版本、截止提交序号、
        逐份内容哈希与证据清单。
      </p>
      <p className="text-xs text-neutral-600" data-backup-location-hint>
        备份位置可以是你自己选的目录（项目外的绝对路径）。
        <strong className="font-semibold text-neutral-500">位置变了就点「查询这个位置」</strong>
        ：塔台只认盘上那份清单，在所选位置上按清单归属找回
        <strong className="font-semibold text-neutral-500">本项目自己</strong>
        的备份——重启后换个位置照样找得回；别的项目的备份不列、不打开、也不恢复。
        留空即用塔台数据目录下的默认位置。
      </p>

      {/* ① 备份 */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-backup-create
            disabled={busy !== null}
            onClick={() => void runCreate()}
            className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-100 hover:bg-neutral-700 disabled:opacity-50"
          >
            {busy === "create" ? "正在备份…" : "立即备份"}
          </button>
          <input
            type="text"
            data-backup-location-input
            value={backupParent}
            onChange={(e) => setBackupParent(e.target.value)}
            placeholder="备份父目录的绝对路径（留空即用塔台数据目录下的默认位置）"
            className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600"
          />
          {canPickDirectory() && (
            <button
              type="button"
              onClick={() => void pickInto(setBackupParent)}
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              选择备份位置…
            </button>
          )}
          <button
            type="button"
            data-backup-query
            onClick={() => switchLocation(backupParent)}
            className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
            title="按上面这个位置列出本项目自己的备份（别的项目的备份不会被列出；位置一变，旧位置那份详情就收起来）"
          >
            查询这个位置
          </button>
          {backupParent !== "" && (
            <button
              type="button"
              onClick={() => {
                setBackupParent("");
                switchLocation("");
              }}
              className="text-xs text-neutral-500 underline"
            >
              用默认位置
            </button>
          )}
        </div>
        <p className="text-xs text-neutral-600" data-backup-location>
          备份位置：{backupParent === "" ? "塔台数据目录下的默认位置" : backupParent}
        </p>
        <p className="text-xs text-neutral-500" data-backup-list-root={list?.root ?? ""} data-backup-list-default={list === null ? "" : list.root_is_default ? "1" : "0"}>
          清单列的是：
          {list === null
            ? "（读取中…）"
            : list.root_is_default
              ? "塔台数据目录下的默认位置"
              : list.root}
          {list !== null && !list.root_is_default && (
            <span className="text-neutral-600">（你选的位置；只列本项目自己的备份）</span>
          )}
        </p>
        {created !== null && (
          <p className="text-xs text-emerald-300" data-backup-created={created.id}>
            已生成 {created.id}
            {created.reused ? "（同一提交边界上已有这一份，未重复备份）" : ""}：{created.dir}
          </p>
        )}
      </div>

      {/* ② 清单 */}
      {listError !== null ? (
        <p className="rounded border border-red-600/40 bg-red-950/30 p-2 text-xs text-red-300" data-backup-error>
          （备份清单读不到：{listError}）——这不等于"没有备份"，先确认后端与数据目录
        </p>
      ) : list === null ? (
        <p className="animate-pulse text-xs text-neutral-500" data-backup-loading>
          （读取清单…）
        </p>
      ) : entries.length === 0 ? (
        skipped.length > 0 ? (
          /* 缺陷 D：一个"能当成本项目备份"的条目都没有，≠"这个位置什么都没有"。
             另有条目被跳过时必须**醒目**说出来，并逐条给原因（其中"清单读不出来"多半就是损坏的那一份）。 */
          <div
            className="space-y-1 rounded border border-amber-600/50 bg-amber-950/25 p-2 text-xs text-amber-200"
            data-backup-empty
            data-backup-empty-skipped={skipped.length}
          >
            <p>
              {list !== null && !list.root_is_default
                ? `这个位置里没有一份能当成本项目备份的条目（你选的是 ${list.root}）。`
                : "这里没有一份能当成本项目备份的条目。"}
              但也有 {skipped.length} 个条目被跳过——这不等于「这里什么都没有」，下面逐条给原因：
            </p>
            <ul className="space-y-0.5" data-backup-skipped-list>
              {skipped.map((s) => (
                <li key={s.name} data-backup-skipped-item={s.name}>
                  <span className="font-mono">{s.name}</span>：{skipReasonLabel(s.reason)}
                </li>
              ))}
            </ul>
            <p className="text-amber-300/80">
              「清单读不出来」的多半是
              <strong className="font-semibold text-amber-200">损坏或写了一半</strong>
              的那一份备份：塔台不会把它当现场用，也不会替你删掉它。
            </p>
          </div>
        ) : (
          <p className="text-xs text-neutral-500" data-backup-empty>
            {list !== null && !list.root_is_default
              ? `这个位置里没有本项目自己的备份（你选的是 ${list.root}）：点上面的「立即备份」在这里取一份一致切片。`
              : "这个项目还没有任何备份：点上面的「立即备份」在事件提交边界上取一份一致切片。"}
          </p>
        )
      ) : (
        <ul className="space-y-1" data-backup-list>
          {entries.map((e) => (
            <li key={e.backup_id}>
              <button
                type="button"
                data-backup-row={e.backup_id}
                data-backup-row-ok={e.ok ? "1" : "0"}
                onClick={() => loadDetail(e.backup_id, listParent)}
                className={`w-full rounded px-2 py-1 text-left text-xs ${
                  selected === e.backup_id ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-900"
                }`}
              >
                <span className="font-mono">{e.backup_id}</span>
                {e.manifest === null ? (
                  <span className="ml-2 text-red-400">（清单读不出来：{e.error}）</span>
                ) : (
                  <span className="ml-2 text-neutral-500">
                    截止序号 {e.manifest.cutoff_seq} · 事实 {e.manifest.counts.fact + e.manifest.counts.legacy_fact} ·
                    证据 {e.manifest.counts.evidence} · 图纸历史 {e.manifest.counts.document_history} ·
                    {e.manifest.warnings.length > 0 ? ` 捕获告警 ${e.manifest.warnings.length}` : " 捕获无告警"}
                  </span>
                )}
                {e.manifest !== null && !e.ok && (
                  <span className="ml-2 text-red-400">（没通过一致性核验：{e.error}）</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 列到了但没被当成备份的条目：如实说清为什么不列（别让它静默消失）。
          一个可用条目都没有时上面那块醒目告警已经逐条列过，这里不重复。 */}
      {skipped.length > 0 && entries.length > 0 && (
        <p className="text-xs text-neutral-500" data-backup-skipped={skipped.length}>
          这个位置里另有 {skipped.length} 个条目没有被当成本项目的备份：
          {skipped
            .slice(0, 5)
            .map((s) => `${s.name}（${skipReasonLabel(s.reason)}）`)
            .join("、")}
          {skipped.length > 5 ? ` 等 ${skipped.length} 个` : ""}
        </p>
      )}

      {/* ③ 单份：核验 + 恢复预览 + 隔离恢复 */}
      {selected !== null && (
        <div className="space-y-2 rounded border border-neutral-800 p-2" data-backup-detail={selected}>
          {detailError !== null ? (
            <p className="text-xs text-red-300" data-backup-detail-error>
              （这一份读不出来：{detailError}）
            </p>
          ) : detail === null ? (
            <p className="animate-pulse text-xs text-neutral-500">（读取这一份…）</p>
          ) : (
            <>
              <div className="space-y-1 text-xs text-neutral-300">
                <p data-backup-detail-location={detail.backup_dir_parent}>
                  这一份的落点：{detail.from_source_parent ? "你选的位置" : "塔台数据目录下的默认落点"}（
                  {detail.backup_dir_parent}）
                </p>
                <p>
                  格式版本 {detail.manifest.backup_format} · 事件 schema {detail.manifest.schema_version} ·
                  截止提交序号 <span data-backup-cutoff>{detail.manifest.cutoff_seq}</span> ·
                  事件 {detail.manifest.event_count} 条 · 采集于 {detail.manifest.taken_at}
                </p>
                <p>
                  生效基线：{detail.manifest.active_baseline_id ?? "（无）"} ·
                  体量 {humanBytes(detail.disk.total_bytes)} / {detail.disk.files} 个文件
                </p>
                <p data-backup-counts>
                  事实 {detail.manifest.counts.fact} · 旧面事实 {detail.manifest.counts.legacy_fact} ·
                  图纸历史 {detail.manifest.counts.document_history} · 证据 {detail.manifest.counts.evidence} ·
                  派生（可重建）{detail.manifest.counts.derived} · 归档 {detail.manifest.counts.log} ·
                  跳过（临时/锁）{detail.manifest.counts.skipped}
                </p>
                {detail.manifest.warnings.length > 0 && (
                  <p className="text-amber-300" data-backup-warnings>
                    捕获时已记下问题（这份源本身不完整）：
                    {detail.manifest.warnings.join("；")}
                  </p>
                )}
              </div>

              {/* 八条一致性判据 */}
              <div className="space-y-1">
                <p className="text-xs font-semibold text-neutral-400">
                  {detail.verification.ok ? "一致性核验：全部通过" : "一致性核验：未通过"}
                </p>
                <ul className="space-y-0.5" data-backup-verify>
                  {detail.verification.checks.map((c) => (
                    <li
                      key={c.name}
                      data-backup-check={c.name}
                      className={`text-xs ${c.ok ? "text-neutral-400" : "text-red-300"}`}
                    >
                      {c.ok ? "✓" : "✗"} {c.name}：{c.detail}
                    </li>
                  ))}
                </ul>
              </div>

              {/* 内容哈希清单（备份的证据面：逐份路径 + 内容哈希） */}
              <details className="text-xs text-neutral-400">
                <summary data-backup-hashes-summary>
                  内容哈希清单（{detail.manifest.sources.length} 份）
                </summary>
                <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-neutral-500">
                  {detail.manifest.sources.map((s) => (
                    <li key={s.rel_path}>
                      {s.rel_path} · {s.role} · {s.sha256.slice(0, 12)}… · {s.bytes}B
                    </li>
                  ))}
                </ul>
                {detail.manifest.evidence.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-[10px] text-neutral-500" data-backup-evidence>
                    {detail.manifest.evidence.map((ev) => (
                      <li key={ev.evidence_id}>
                        证据 {ev.evidence_id.slice(0, 12)}… · {ev.kind} · {ev.summary}
                        {ev.referenced_by_events ? "（被截止序号以内的事件引用）" : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </details>

              {/* 恢复预览 */}
              <div className="space-y-1 text-xs text-neutral-300" data-backup-preview>
                <p className="font-semibold text-neutral-400">隔离恢复预览</p>
                <p data-backup-compare>{detail.restore_preview.comparison.note}</p>
                <p>
                  默认隔离目录：{detail.restore_preview.default_dest_root}
                  {detail.restore_preview.default_dest_exists ? "（已在盘上，恢复时会自动换一个可用名）" : ""}
                </p>
                <p className="text-neutral-500">{detail.restore_preview.note}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  data-backup-restore-input
                  value={restoreParent}
                  onChange={(e) => setRestoreParent(e.target.value)}
                  placeholder="隔离位置父目录的绝对路径（留空即用塔台数据目录下的默认位置）"
                  className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600"
                />
                <button
                  type="button"
                  data-backup-restore
                  disabled={busy !== null || !detail.verification.ok}
                  onClick={() => void runRestore()}
                  className="rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-100 hover:bg-neutral-700 disabled:opacity-50"
                >
                  {busy === "restore" ? "正在恢复到隔离目录…" : "恢复到隔离目录"}
                </button>
                {canPickDirectory() && (
                  <button
                    type="button"
                    onClick={() => void pickInto(setRestoreParent)}
                    className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
                  >
                    选择恢复位置…
                  </button>
                )}
                {restoreParent !== "" && (
                  <button
                    type="button"
                    onClick={() => setRestoreParent("")}
                    className="text-xs text-neutral-500 underline"
                  >
                    用默认位置
                  </button>
                )}
              </div>
              <p className="text-xs text-neutral-600">
                恢复位置：{restoreParent === "" ? "塔台数据目录下的默认位置" : restoreParent}
                （隔离目录新建在它下面，名 = 备份 id）
              </p>
              {!detail.verification.ok && (
                <p className="text-xs text-amber-300">
                  这份备份没通过一致性核验：不把它恢复成现场（对不上截止序号的半份备份不许当现场用）。
                </p>
              )}

              {restored !== null && (
                <div
                  className="space-y-1 rounded border border-emerald-800/50 bg-emerald-950/20 p-2 text-xs text-emerald-200"
                  data-backup-restore-result={restored.dest_root}
                >
                  <p data-backup-replaced={String(restored.replaced)}>
                    已恢复到隔离目录：{restored.dest_root}
                  </p>
                  <p className="text-emerald-300/80">
                    原项目未被写入；<code className="text-emerald-200">replaced={String(restored.replaced)}</code>
                    ——塔台不会自动替换当前数据，是否替换由你自己决定（本入口没有替换动作）。
                  </p>
                  <ul className="space-y-0.5">
                    {restored.report.checks.map((c) => (
                      <li key={c.name} data-backup-restore-check={c.name}>
                        {c.ok ? "✓" : "✗"} {c.name}：{c.detail}
                      </li>
                    ))}
                  </ul>
                  <p data-backup-restore-facts>
                    隔离目录里：重放事件 {restored.report.facts?.events_replayed ?? 0} 条 ·
                    取回修订 {restored.report.facts?.documents_recovered.length ?? 0} 份 ·
                    复核证据 {restored.report.facts?.evidence_hash_checked.length ?? 0} 份 ·
                    重建缓存 last_seq={restored.report.facts?.cache_rebuilt.last_seq ?? 0}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {actionError !== null && (
        <p className="rounded border border-red-600/40 bg-red-950/30 p-2 text-xs text-red-300" data-backup-action-error>
          {actionError}
        </p>
      )}
    </section>
  );
}
