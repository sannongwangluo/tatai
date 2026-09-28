// V06-12 Git 保存版本提醒（DESIGN.md §3.15 整节即本组件契约；§3.9 保存状态、§8.5 私有事实备份）。
//
// 逐句落点：
//   · 「相关成果已通过必要检查且工作树仍有改动时，提示这批成果还没有保存为本地 Git 版本」
//     → 卡片正文分两行：**本地保存状态**（`reminder.local_commit`）与**成果口径**
//       （`reminder.verification`，checks_passed / unverified / unknown）。
//   · 「展示变更摘要、文件范围与最后检测时间」→ `reminder.summary` / `reminder.file_scope` /
//     `reminder.last_detected_at` 三块，全部来自服务端，界面不自己算。
//   · 「支持查看、复制给执行 Agent 的整理说明、稍后提醒」
//     → 三个按钮：查看（展开卡片看文件范围与完整整理说明）/ 复制（`navigator.clipboard`，
//       失败退回 textarea + execCommand；复制内容另行上屏可核对）/ 稍后提醒（**只暂缓当前这一批**）。
//   · 「未验证改动可显示未保存，但不称为稳定成果」→ 未验证态名写「**未验证**」并补一句
//     "它是未保存改动，不是稳定成果"；本组件的文案里没有"稳定成果"这个说法（只有这句话在否定它）。
//   · 「触发按成果事件、项目重新打开或用户刷新，并合并同一批改动；不每保存一个文件弹窗」
//     → 触发三条：① 项目 SSE 事件（成果提交即来，500ms 合并窗口）；② 重新打开项目（本组件随项目
//       选中挂载即拉一次）；③ 手动「刷新」按钮。合并靠**变更指纹**：指纹没变 = 同一批改动 →
//       只更新计数与检测时间，**不重复展开**；指纹变了才是新一批（`data-reminder-batch-new="1"`）。
//     **不打扰的落点**：新一批只把入口点亮 + 入口旁一行说明，卡片**不自动展开**（详情由用户点开；
//       §3.15「不每保存一个文件弹窗」+ §3.10「不每次文件保存弹窗」）。
//   · 「不自动执行 git add/commit/push，不修改 Git 配置或工作树」→ 本组件只有 GET 一条口子；
//       页面上没有任何 Git 写按钮。
//   · 「不是仓库时明确未使用 Git，不擅自初始化」→ `reminder.is_repository=false` → 卡片明写
//       未使用 Git，且不给任何"初始化仓库"的入口。
//   · 「远端仅显示最近已知跟踪状态及观测时间，不做隐式 fetch……无法确认标未知」→ 远端一行只渲染
//       `reminder.remote.label` + 观测时间 + "只读本地引用、未联网"；无上游时服务端给的就是
//       「无上游：不断言远端同步状态」——整份提醒里不出现任何正面的远端同步断言。
//   · 「`.工作台/` 通常被忽略，其聊天、任务和证据不能因为代码提交就显示已备份」→ 私有事实一行永远
//       是 `unknown` + 原因（忽略 ≠ 已备份）；入口是否可用是**另一个**读数（`backup_flow_available`，
//       V09-06 起为真：项目信息页里能创建一致备份并恢复到隔离目录）——入口可用、代码提交，
//       都不许说成"已备份"。
//   · 「不同项目提醒相互隔离」→ 现场（已暂缓的指纹 / 上一批指纹与合并计数）按项目 id 分桶存在
//       sessionStorage；异步回包落地前先核对"还是不是发起那个项目"（§3.1 旧响应不许写进新界面）。
//   · 「用户稍后提醒的记录不能隐藏新的重要成果」→ 暂缓记录的是**指纹集合**，新指纹不在集合里，
//       所以新一批一定重新露面。
import { useCallback, useEffect, useRef, useState } from "react";
import { getGitStatus, projectEventsUrl, type GitStatusPayload, type ProjectItem } from "../api";

/** SSE 事件合并窗口（毫秒）：文件监听一批改动可能连推多行，窗口内只重探一次 */
const RESYNC_DEBOUNCE_MS = 500;

const STORAGE_PREFIX = "tatai.gitReminder.";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 存不下不影响本进程内的展示 */
  }
}

/** 上一批改动的记忆（用于"合并同一批改动"）：指纹 + 这批被合并了几次 + 最后一次是在哪个页面实例里记的 */
interface BatchMemory {
  fingerprint: string | null;
  merged: number;
  /**
   * 记这份记忆的那个**页面实例**标识。
   * 为什么要它：React `StrictMode` 在 dev 下会把挂载副作用跑两遍，"第一遍就判定成合并"会把
   * 「新一批」误判成「旧一批」（第一次打开项目就不提醒了）；而"用户手点刷新"与"重新打开项目"
   * 都要算合并。用页面实例区分：同一实例里的重复探测算合并计数，跨实例（刷新/重开）算"同一批再来一次"。
   */
  page: string;
}

/** 本次页面实例的标识（模块级：同一页面生命周期内固定，刷新即换） */
const PAGE_ID = Math.random().toString(36).slice(2, 12);

const LOCAL_COMMIT_TONE: Record<string, string> = {
  saved: "border-emerald-700/60 bg-emerald-950/30 text-emerald-200",
  unsaved: "border-amber-600/60 bg-amber-950/30 text-amber-200",
  unknown: "border-neutral-600 bg-neutral-800/60 text-neutral-300",
};

const VERIFICATION_TONE: Record<string, string> = {
  checks_passed: "border-sky-700/60 bg-sky-950/30 text-sky-200",
  partially_covered: "border-amber-700/60 bg-amber-950/30 text-amber-200",
  unverified: "border-neutral-600 bg-neutral-800/60 text-neutral-300",
  blocked: "border-red-800/60 bg-red-950/30 text-red-200",
  unknown: "border-neutral-600 bg-neutral-800/60 text-neutral-400",
};

/** 成果口径的状态名（人话，与 `gitStatus.ts#VerificationState` 一一对应） */
const VERIFICATION_STATE_LABEL: Record<string, string> = {
  checks_passed: "已通过必要检查",
  partially_covered: "部分覆盖（未宣称整批通过）",
  unverified: "未验证",
  blocked: "不能算通过（有未收口阻断）",
  unknown: "未知",
};

const KIND_LABEL: Record<string, string> = {
  staged: "已暂存",
  modified: "未暂存",
  untracked: "未跟踪",
  conflicted: "冲突",
};

export function VersionReminder({ project }: { project: ProjectItem }) {
  const [payload, setPayload] = useState<GitStatusPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  /** 本批改动被合并了几次（指纹没变的重复检测只加这个数，不重复展开） */
  const [merged, setMerged] = useState(0);
  /** 本批指纹是不是"新的一批"（新一批 = 与记忆里的指纹不同） */
  const [batchNew, setBatchNew] = useState(false);
  const [snoozed, setSnoozed] = useState<string[]>([]);
  const projectIdRef = useRef(project.id);
  projectIdRef.current = project.id;

  const fingerprintKey = `${STORAGE_PREFIX}batch.${project.id}`;
  const snoozeKey = `${STORAGE_PREFIX}snoozed.${project.id}`;

  const load = useCallback(() => {
    const id = project.id;
    return getGitStatus(id)
      .then((p) => {
        if (projectIdRef.current !== id) return; // §3.1：旧项目的响应不许写进新项目的界面
        setPayload(p);
        setLoadError(null);
        const fp = p.reminder.change_fingerprint;
        const memory = readJson<BatchMemory>(fingerprintKey, { fingerprint: null, merged: 0, page: "" });
        if (fp !== null && memory.fingerprint === fp) {
          if (memory.page === PAGE_ID) {
            // 同一页面实例里又来一次同一批（StrictMode 双挂载 / SSE 抖动 / 手点刷新）：
            // 只加合并计数，**不改批次判定**（不重复展开、也不把"新一批"翻成"旧一批"）
            const next: BatchMemory = { fingerprint: fp, merged: memory.merged + 1, page: PAGE_ID };
            writeJson(fingerprintKey, next);
            setMerged(next.merged);
            return;
          }
          // 跨页面实例（用户**重新打开项目**/刷新）遇到同一批：合并计数，但不重复展开
          const next: BatchMemory = { fingerprint: fp, merged: memory.merged, page: PAGE_ID };
          writeJson(fingerprintKey, next);
          setMerged(next.merged);
          setBatchNew(false);
          return;
        }
        if (fp === null) {
          // 没有可信的"这批改动"（未使用 Git / 只读探测失败）：不做批次合并，本页只判一次
          if (memory.fingerprint === null && memory.page === PAGE_ID) return;
          writeJson(fingerprintKey, { fingerprint: null, merged: 0, page: PAGE_ID } satisfies BatchMemory);
          setMerged(0);
          setBatchNew(false);
          return;
        }
        // 新一批（指纹变了）：入口转为醒目并写上"新一批改动"——**不自动弹卡片**（轻量、不打扰，
        // 详情由用户点开看；§3.15「不每保存一个文件弹窗」）
        const next: BatchMemory = { fingerprint: fp, merged: 0, page: PAGE_ID };
        writeJson(fingerprintKey, next);
        setMerged(0);
        setBatchNew(true);
      })
      .catch((e: Error) => {
        if (projectIdRef.current !== id) return;
        setLoadError(e.message);
        setPayload(null);
      });
  }, [project.id, fingerprintKey]);

  // 切项目：重置现场，拉一次，并订阅项目事件（成果提交 → 变更流水/证据变化 → SSE）
  useEffect(() => {
    setPayload(null);
    setLoadError(null);
    setOpen(false);
    setNoteOpen(false);
    setCopied(null);
    setMerged(0);
    setBatchNew(false);
    setSnoozed(readJson<string[]>(snoozeKey, []));

    void load();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource(projectEventsUrl(project.id));
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data as string) as { hello?: boolean };
      if (data.hello) return; // 握手不算事件（打开项目那一次已单独拉过）
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void load(), RESYNC_DEBOUNCE_MS);
    };
    return () => {
      if (timer !== null) clearTimeout(timer);
      es.close();
    };
  }, [project.id, load, snoozeKey]);

  const reminder = payload?.reminder ?? null;
  const fingerprint = reminder?.change_fingerprint ?? null;
  const isSnoozed = fingerprint !== null && snoozed.includes(fingerprint);
  const dirty = reminder !== null && reminder.file_scope.total > 0;
  /** 有值得看的结论才出声：有改动、探测失败、或不是仓库（明说未使用 Git） */
  const stateUnknown = reminder !== null && reminder.local_commit.state === "unknown";
  /** 值得看一眼：有未保存改动 / 未使用 Git / 状态未知（探测失败） */
  const noteworthy = reminder !== null && (dirty || stateUnknown || !reminder.is_repository);
  const hot = noteworthy && !isSnoozed;
  const badgeText =
    isSnoozed
      ? "暂缓"
      : reminder !== null && !reminder.is_repository
        ? "未使用 Git"
        : stateUnknown && !dirty
          ? "未知"
          : `${reminder?.file_scope.total ?? 0} 个改动`;

  const onSnooze = () => {
    if (fingerprint === null) return;
    if (snoozed.includes(fingerprint)) return;
    const next = [...snoozed, fingerprint];
    setSnoozed(next);
    writeJson(snoozeKey, next);
    setOpen(false);
  };

  const onRefresh = () => {
    setReloadTick((n) => n + 1);
    void load();
  };

  const onCopy = () => {
    const note = reminder?.agent_note ?? "";
    setCopied(note);
    // 剪贴板 API 在无权限/非安全上下文（含 headless 验证环境）下会**异步**拒绝；不 catch 就是
    // 一条未处理拒绝 = 页面上一条 JS 错误。失败时退回"选中 textarea + execCommand"的老路。
    const fallbackCopy = (): void => {
      try {
        const ta = document.createElement("textarea");
        ta.value = note;
        ta.setAttribute("data-reminder-copy-fallback", "1");
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        /* 复制失败也不静默：复制内容已上屏（data-reminder-copied-notice），用户可手工选走 */
      }
    };
    const clip = navigator.clipboard;
    if (clip !== undefined && typeof clip.writeText === "function") {
      clip.writeText(note).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
  };

  // 未就绪：入口先摆出来（不装作没有提醒这件事）
  if (reminder === null) {
    return (
      <div className="relative self-center" data-version-reminder data-reminder-project={project.id} data-reminder-state="loading">
        <button
          data-reminder-entry
          disabled
          title={loadError === null ? "正在只读探测本地 Git 版本状态…" : undefined}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-neutral-500"
        >
          版本提醒
          <span data-reminder-badge className="rounded-full bg-neutral-800 px-1.5 py-0.5 text-[10px] leading-none text-neutral-500">
            {loadError === null ? "…" : "!"}
          </span>
        </button>
        {loadError !== null && (
          <span data-reminder-error className="ml-2 text-[10px] text-red-400" title={loadError}>
            探测请求失败：{loadError}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="relative self-center"
      data-version-reminder
      data-reminder-project={project.id}
      data-reminder-state={reminder.local_commit.state}
      data-reminder-fingerprint={fingerprint ?? ""}
      data-reminder-total={String(reminder.file_scope.total)}
      data-reminder-merged={String(merged)}
      data-reminder-batch-new={batchNew ? "1" : "0"}
      data-reminder-snoozed={isSnoozed ? "1" : "0"}
      data-reminder-snoozed-fingerprints={snoozed.join(",")}
      data-reminder-is-repository={reminder.is_repository ? "1" : "0"}
      data-reminder-backed-up={reminder.private_facts.backed_up}
      data-reminder-refreshes={String(reloadTick)}
      data-reminder-open={open ? "1" : "0"}
    >
      <div className="flex items-center gap-1.5">
        <button
          data-reminder-entry
          onClick={() => setOpen((v) => !v)}
          title="Git 保存版本提醒（只读探测：不自动 add/commit/push，不 fetch，不改仓库）"
          className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs ${
            hot
              ? "bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
              : "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
          }`}
        >
          版本提醒
          <span
            data-reminder-badge
            className={`rounded-full px-1.5 py-0.5 text-[10px] leading-none ${
              hot ? "bg-amber-500 text-neutral-950" : "bg-neutral-800 text-neutral-500"
            }`}
          >
            {badgeText}
          </span>
        </button>
        {isSnoozed && (
          <span data-reminder-snoozed-hint className="text-[10px] text-neutral-500">
            已暂缓这批改动（指纹 {fingerprint?.slice(0, 8)}…）；新一批成果不会被它挡住
          </span>
        )}
        {batchNew && noteworthy && !isSnoozed && (
          <span data-reminder-batch-mark className="text-[10px] text-amber-400">
            新一批{!reminder.is_repository ? "状态" : "改动"}
            {dirty ? `：${reminder.file_scope.total} 个文件还没保存为本地 Git 版本（点开看摘要与整理说明）` : "（点开看）"}
          </span>
        )}
      </div>

      {open && (
        <div
          data-version-reminder-card
          className="fixed right-4 top-28 z-30 max-h-[70vh] w-[46rem] max-w-[92vw] space-y-2 overflow-y-auto rounded border border-neutral-800 bg-neutral-950/95 p-3 text-xs shadow-lg"
        >
          {/* ① 摘要 + 本地保存状态 + 最后检测时间 */}
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <p data-reminder-summary className="text-neutral-200">
                {reminder.summary}
              </p>
              <p
                data-reminder-local-commit
                className={`inline-block rounded border px-1.5 py-0.5 ${LOCAL_COMMIT_TONE[reminder.local_commit.state]}`}
              >
                {reminder.local_commit.label}
              </p>
            </div>
            <div className="shrink-0 space-y-1 text-right">
              <p data-reminder-detected className="text-neutral-500">
                最后检测：{reminder.last_detected_at}
              </p>
              {merged > 0 && (
                <p data-reminder-merged-note className="text-neutral-600">
                  同一批改动已合并 {merged} 次重复检测（不重复弹窗）
                </p>
              )}
            </div>
          </div>

          {/* ② 成果口径：已通过必要检查 / 部分覆盖 / 未验证 / 有未收口阻断 / 未知（补修 D 五态） */}
          <p
            data-reminder-verification
            data-verification-state={reminder.verification.state}
            className={`rounded border px-2 py-1 ${VERIFICATION_TONE[reminder.verification.state] ?? VERIFICATION_TONE.unknown}`}
          >
            {reminder.verification.label}
            {(reminder.verification.related_submission_ids.length > 0 ||
              reminder.verification.related_evidence_ids.length > 0) && (
              <span data-reminder-related className="ml-1 text-[10px] text-neutral-400">
                关联成果 {reminder.verification.related_submission_ids.join("、") || "（无）"} ·
                证据 {reminder.verification.related_evidence_ids.map((e) => e.slice(0, 8) + "…").join("、") || "（无）"}
              </span>
            )}
          </p>

          {/* ②-b 判定依据（补修 D）：凭什么 / 覆盖了什么 / 没覆盖什么 / 绑的哪一版 / 三类记录分开 */}
          {reminder.verification.detail !== null && (
            <div
              data-reminder-verification-basis
              data-verification-batch={reminder.verification.detail.declared.batch}
              data-verification-covered={String(reminder.verification.detail.coverage.covered_paths.length)}
              data-verification-uncovered={String(reminder.verification.detail.coverage.uncovered_paths.length)}
              data-verification-required-source={reminder.verification.detail.declared.required_checks_source}
              className="space-y-1 rounded border border-neutral-800 bg-neutral-900/50 p-2 text-[11px] text-neutral-300"
            >
              <p data-verification-state-label className="text-neutral-200">
                成果口径：{VERIFICATION_STATE_LABEL[reminder.verification.detail.state] ?? reminder.verification.detail.state}
              </p>
              <p data-verification-scope className="text-neutral-400">
                声明范围：成果 {reminder.verification.detail.declared.submission_ids.join("、") || "（无）"}｜任务{" "}
                {reminder.verification.detail.declared.task_ids.join("、") || "（无）"}｜路径{" "}
                {reminder.verification.detail.declared.paths.length} 条｜必需检查{" "}
                {reminder.verification.detail.declared.required_checks.map((c) => c.check_id).join("、") || "（清单未知）"}
              </p>
              <p data-verification-coverage className="text-neutral-400">
                覆盖：已覆盖 {reminder.verification.detail.coverage.covered_paths.length} 条
                {reminder.verification.detail.coverage.covered_paths.length > 0
                  ? `（${reminder.verification.detail.coverage.covered_paths.slice(0, 4).join("、")}）`
                  : ""}
                ｜未验证 {reminder.verification.detail.coverage.uncovered_paths.length} 条
                {reminder.verification.detail.coverage.uncovered_paths.length > 0
                  ? `（${reminder.verification.detail.coverage.uncovered_paths.slice(0, 4).join("、")}）`
                  : ""}
                {reminder.verification.detail.coverage.complete ? (
                  "｜覆盖完整"
                ) : (
                  <span className="text-amber-300/90">｜不宣称整批通过</span>
                )}
              </p>
              <p data-verification-version className="text-neutral-400">
                版本绑定（{reminder.verification.detail.version.basis}）：当前内容版本{" "}
                {reminder.verification.detail.version.by_scope
                  .map((s) => (s.fingerprint === null ? "取不到" : `${s.fingerprint.slice(0, 12)}…`))
                  .join("、") || "（无被检查范围）"}
                ｜HEAD {reminder.verification.detail.version.head?.slice(0, 12) ?? "（空仓库/未知）"}…
                ——{reminder.verification.detail.version.note}
              </p>
              {reminder.verification.detail.checks.length > 0 && (
                <ul data-verification-checks className="space-y-0.5 font-mono text-[10px] text-neutral-400">
                  {reminder.verification.detail.checks.map((c, i) => (
                    <li key={`${c.check_id}:${i}`} data-verification-check data-check-effective={c.effective}>
                      {c.check_id} ← {c.record_ref ?? "（无事件记录）"}｜复核 {c.effective}（{c.result}）
                      ｜{c.independence === "independent" ? "独立审计" : "作者自检"}
                      ｜绑定 {c.bound_revision === null ? "（未绑定）" : `${c.bound_revision.revision_kind}:${c.bound_revision.revision.slice(0, 12)}…`}
                      ｜当前 {c.current_content_version === null ? "取不到" : `${c.current_content_version.slice(0, 12)}…`}
                      ｜证据 {c.evidence_sha256 === null ? "（无）" : `${c.evidence_sha256.slice(0, 8)}…`}
                      {c.effective === "passed" ? "" : `｜${c.why}`}
                    </li>
                  ))}
                </ul>
              )}
              {reminder.verification.detail.missing_checks.length > 0 && (
                <p data-verification-missing className="text-amber-300/90">
                  缺口：{reminder.verification.detail.missing_checks.map((m) => m.check_id).join("、")}
                </p>
              )}
              {reminder.verification.detail.blockers.length > 0 && (
                <p data-verification-blockers className="text-red-300/90">
                  未收口阻断：{reminder.verification.detail.blockers.map((b) => b.blocker_id).join("、")}
                </p>
              )}
              <p data-verification-records className="text-neutral-500">
                自检 {reminder.verification.detail.records.self_checks.length} 条｜独立审计{" "}
                {reminder.verification.detail.records.independent_audits.length} 条｜用户接受{" "}
                {reminder.verification.detail.records.user_acceptances.length} 条（
                <strong className="font-semibold text-neutral-400">
                  检查通过 ≠ 独立审计通过 ≠ 用户已验收
                </strong>
                ）
              </p>
            </div>
          )}

          {/* ③ 远端（只显示最近已知跟踪状态及时间）+ 私有事实备份（backed_up 永远 unknown） */}
          <p data-reminder-remote className="text-neutral-400">
            远端：{reminder.remote.label}｜上游 {reminder.remote.upstream ?? "无"}｜观测时间{" "}
            {reminder.remote.observed_at}｜只读本地引用、未联网（不做隐式 fetch / 推送）
          </p>
          <p data-reminder-private className="text-neutral-400">
            私有事实（.工作台/）：{reminder.private_facts.backed_up === "unknown" ? "备份状态未知" : reminder.private_facts.backed_up}
            ——{reminder.private_facts.label}
          </p>
          <p
            data-reminder-backup-flow={reminder.private_facts.backup_flow_available ? "available" : "absent"}
            className="text-neutral-400"
          >
            本机备份入口：
            {reminder.private_facts.backup_flow_available ? (
              <>
                {"可用（「项目信息」页的「私有事实备份/恢复」：按事件提交边界取一致备份、只恢复到隔离目录、不自动替换当前数据）——"}
                <strong className="font-semibold text-neutral-300">
                  入口可用、代码提交，都不等于这份私有事实已被备份
                </strong>
              </>
            ) : (
              "不可用（当前构建没有显式备份/恢复入口）"
            )}
          </p>

          {!reminder.is_repository && (
            <p data-reminder-not-git className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-300">
              未使用 Git：没有本地版本可保存，也没有"已备份"这回事（塔台不擅自初始化仓库）。
            </p>
          )}

          {reminder.probe_error !== null && (
            <p data-reminder-probe-error className="rounded border border-red-800 bg-red-950/40 px-2 py-1 text-red-200">
              只读探测失败 [{reminder.probe_error.code}]：{reminder.probe_error.message}
              ——工作树状态<strong className="font-semibold">未知</strong>（不当作干净）
            </p>
          )}

          {/* ④ 文件范围（工作树根相对；超限如实给省略量） */}
          <div data-reminder-files>
            <p className="text-neutral-500">
              文件范围：{reminder.file_scope.total} 个
              {reminder.file_scope.omitted > 0 ? `（下列 ${reminder.file_scope.files.length} 个，另有 ${reminder.file_scope.omitted} 个未列出）` : ""}
            </p>
            <ul className="mt-1 max-h-40 overflow-y-auto font-mono text-[11px] text-neutral-300">
              {reminder.file_scope.files.length === 0 && <li className="text-neutral-500">（无改动）</li>}
              {reminder.file_scope.files.map((f) => (
                <li key={`${f.kind}:${f.path}`} data-reminder-file data-file-kind={f.kind} data-file-in-project={f.in_project ? "1" : "0"}>
                  <span className="text-neutral-500">[{KIND_LABEL[f.kind] ?? f.kind}]</span> {f.path}
                  {f.in_project ? "" : "（不在本项目根内）"}
                </li>
              ))}
            </ul>
          </div>

          {/* ⑤ 三个动作：查看（整理说明）/ 复制给执行 Agent / 稍后提醒 */}
          <div className="flex flex-wrap items-center gap-2 border-t border-neutral-800 pt-2">
            <button
              data-reminder-view
              onClick={() => setNoteOpen((v) => !v)}
              className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
            >
              {noteOpen ? "收起整理说明" : "查看整理说明"}
            </button>
            <button
              data-reminder-copy
              onClick={onCopy}
              className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
            >
              复制给执行 Agent
            </button>
            <button
              data-reminder-snooze
              onClick={onSnooze}
              disabled={fingerprint === null || isSnoozed}
              className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
            >
              稍后提醒（只对这批）
            </button>
            <button
              data-reminder-refresh
              onClick={onRefresh}
              className="rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
            >
              刷新探测
            </button>
            <span className="text-[10px] text-neutral-600">
              塔台只读探测：不自动 git add/commit/push、不 fetch、不改 Git 配置与工作树
            </span>
          </div>

          {copied !== null && (
            <p data-reminder-copied-notice className="text-[10px] text-emerald-300">
              已复制 {copied.length} 个字符的整理说明（下面是复制内容，可核对）
            </p>
          )}
          {(noteOpen || copied !== null) && (
            <pre
              data-reminder-agent-note
              className="max-h-56 overflow-auto whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-900/60 p-2 font-mono text-[11px] text-neutral-300"
            >
              {copied ?? reminder.agent_note}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
