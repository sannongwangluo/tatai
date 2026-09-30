// 同步证据的后台自动发现与生命周期（PLAN V09-23 返工B；DESIGN.md §2.10；docs/sync-evidence-contract.md「自动发现、写入与重新验证」）。
//
// 硬口径（契约定版 + design-review findings E）：
//   ① **唯一写服务确认后才扫**：桌面后端（index.ts）与独立 daemon（daemon.ts）都在**发布描述符之后**调用
//      `startSyncDiscovery`，本模块再**读描述符复核 `pid === process.pid`** 才启动；退位候选/接管窗口不先扫。
//   ② **共用同一逻辑与单飞队列**：后台自动扫描与显式 `scan_sync_evidence` 都走 `requestSyncScan`
//      （单飞 key = 规范 dataDir + projectId，避免多数据目录/隔离夹具串味），真正唯一写口仍是 `WorkService.submit`。
//   ③ **有界增量、不静默**：项目数上限 `SYNC_MAX_PROJECTS`（达上限报 incomplete 及原因）；收件目录按
//      事件监听（depth:0、不跟随联接点，只挂约定目录，因此不会扫到服务自写）；项目注册表用**有界轮询**
//      增量发现（事件账本只按 mtime/size 便宜判据变化时才重解析）；每条 watch/注册表/队列/提交失败都进
//      `syncRuntimeHealth` 汇 + 日志，不 silent catch。
//   ④ **真防抖 + 可清理**：**按项目替换定时器**（不是每个 event 新增一个 timer）；`stopSyncDiscovery`
//      清 watch/timer 后**真正 await 全部已启动的在途扫描终止**才返回（10s 只记告警，**不**超时假成功），
//      之后不再新增扫描写入；restart 时旧在途的 finally 不会误删新队列。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { listProjects, type ProjectRecord } from "../registry";
import { projectWorkDir } from "../workstation";
import { readServiceDescriptor } from "./service";
import "./syncGraph"; // 组合根：注册 graph_full 六图探针
import { clearSyncDiscoveryIssues, reportSyncDiscoveryIssue } from "./syncRuntimeHealth";
import {
  SYNC_EVIDENCE_FILE_SUFFIX,
  SYNC_INBOX_REL,
  SYNC_MAX_PROJECTS,
  projectHasSyncContract,
  scanSyncProject,
  type SyncScanOutcome,
  type SyncSubmitter,
} from "./sync";

export interface SyncScanRequest {
  projectId: string;
  dataDir: string;
  submitter: SyncSubmitter;
  actorId?: string;
  role?: string;
}

/** 单飞槽 key＝**规范 dataDir** + 项目 id（同一进程内跑多数据目录/隔离夹具时不互相串） */
function scanKeyOf(dataDir: string, projectId: string): string {
  return `${path.resolve(dataDir)}\u0000${projectId}`;
}

/** 同 key 并发扫描合并成一次（单飞）；结果由所有等待者共享（彼此独立、无副作用叠加） */
const inflight = new Map<string, Promise<SyncScanOutcome>>();

/** 请求一次扫描（后台与显式 scan 共用；同 key 在途请求合并） */
export function requestSyncScan(req: SyncScanRequest): Promise<SyncScanOutcome> {
  const key = scanKeyOf(req.dataDir, req.projectId);
  const existing = inflight.get(key);
  if (existing !== undefined) return existing;
  const run = scanSyncProject({
    projectId: req.projectId,
    dataDir: req.dataDir,
    submitter: req.submitter,
    ...(req.actorId === undefined ? {} : { actorId: req.actorId }),
    ...(req.role === undefined ? {} : { role: req.role }),
  });
  const tracked = run.finally(() => {
    // 只删自己那一条：restart 后旧在途的 finally 不得误删新一轮的单飞槽
    if (inflight.get(key) === tracked) inflight.delete(key);
  });
  inflight.set(key, tracked);
  return tracked;
}

/** HTTP 显式扫描入口（service.ts 的 /api/work/sync/scan）——与后台同一份单飞队列 */
export function runSyncScanForRequest(req: SyncScanRequest): Promise<SyncScanOutcome> {
  return requestSyncScan(req);
}

// ── 后台生命周期 ──

/** 每项目防抖窗口（毫秒）：目录抖动合并成一次扫描 */
const SYNC_SCAN_DEBOUNCE_MS = 400;
/** 防抖上限（毫秒）：持续事件流下也按时扫一次，不被无限推迟 */
const SYNC_SCAN_MAX_WAIT_MS = 2_000;
/** 有界增量轮询周期（毫秒）：注册表/项目/事件账本变化兜底发现 */
const SYNC_POLL_INTERVAL_MS = 2_000;
/** 注册表变化防抖（毫秒） */
const SYNC_REGISTRY_DEBOUNCE_MS = 500;
/** 停机等待在途扫描"多久算久"的告警阈值（毫秒）：只记告警，**不**据此提前返回（见 `awaitInflight`） */
const SYNC_STOP_WARN_MS = 10_000;
/** 轮询每项目最多纳入指纹的证据文件数（有界）；**超出即 overflow**，由调用方按 fail-closed 上报，不截断冒充完整 */
const SYNC_POLL_MAX_EVIDENCE_FILES = 64;

/** 一个被后台跟踪的项目（注册表里出现过；有同步配置才挂收件监听） */
interface ProjectWatch {
  projectId: string;
  /** 规范化项目根（路径变更时据此重挂） */
  root: string;
  watcher: FSWatcher | null;
  /** 挂起中的防抖定时器（每项目至多一个） */
  scanTimer: NodeJS.Timeout | null;
  /** 本段防抖窗口的起点（用于防抖上限） */
  debounceSince: number;
  /** 事件账本身份（size:mtimeMs）——便宜增量判据，变了才重解析本领域事实 */
  eventsId: string;
  /** 收件目录指纹（证据文件名:大小:时间）——Watcher 漏报时的有界轮询兜底 */
  inboxFp: string;
  /** 上次判定的「有同步配置」（有契约或收件目录） */
  configured: boolean;
  /** 卸载/换路径后自增：旧监听回调据此作废，不再调度扫描（旧 watcher 关闭不误写） */
  generation: number;
  /** 该项目当前已知的发现失败（watch / 本领域事实或收件目录读不出 / 扫描提交）——按下标整体替换上报 */
  watch_error: string | null;
  facts_error: string | null;
  scan_error: string | null;
}

interface DiscoveryRuntime {
  service: SyncSubmitter;
  /** 规范 dataDir */
  dataDir: string;
  projects: Map<string, ProjectWatch>;
  registryWatcher: FSWatcher | null;
  registryTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  /** 本 runtime 启动的在途扫描（stop 时 await 收尾） */
  inflight: Set<Promise<unknown>>;
  stopped: boolean;
  initial_scan_done: boolean;
  /** 全局发现失败槽（每轮轮询按当前事实重算，成功重试即清） */
  registry_read_error: string | null;
  registry_watch_error: string | null;
  project_limit_note: string | null;
}

let runtime: DiscoveryRuntime | null = null;

function log(msg: string): void {
  console.log(`[tatai-sync] ${msg}`);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 全局发现错误按当前事实整体重算（清旧再写新：成功重试即清，null issue 语义） */
function applyGlobalIssues(rt: DiscoveryRuntime): void {
  reportSyncDiscoveryIssue(rt.dataDir, null, null);
  for (const issue of [rt.registry_read_error, rt.project_limit_note, rt.registry_watch_error]) {
    if (issue !== null) reportSyncDiscoveryIssue(rt.dataDir, null, issue);
  }
}

/** 单项目发现错误：把该项目当前已知的三类失败整体重写上报（成功重试即清相应项） */
function flushProjectIssues(rt: DiscoveryRuntime, w: ProjectWatch): void {
  reportSyncDiscoveryIssue(rt.dataDir, w.projectId, null);
  for (const issue of [w.watch_error, w.facts_error, w.scan_error]) {
    if (issue !== null) reportSyncDiscoveryIssue(rt.dataDir, w.projectId, issue);
  }
}

/** 清掉某项目的全部发现错误（注销/移出注册表时用，防残留） */
function clearProjectIssues(rt: DiscoveryRuntime, projectId: string): void {
  reportSyncDiscoveryIssue(rt.dataDir, projectId, null);
}

function inboxPathOf(root: string): string {
  return path.join(root, SYNC_INBOX_REL);
}

/** 收件目录是否在场；只有 ENOENT 算"正常为空"，其余读失败如实带回错误（不 silent catch） */
function probeInbox(root: string): { exists: boolean; error: string | null } {
  try {
    return { exists: fs.existsSync(inboxPathOf(root)), error: null };
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") return { exists: false, error: null };
    return { exists: false, error: `收件目录判不出：${errText(e)}` };
  }
}

/** 事件账本的便宜身份（size:mtimeMs）；无文件＝""。轮询只在它变了才重解析本领域事实。 */
function eventsIdentity(projectId: string, dataDir: string): { id: string; error: string | null } {
  try {
    const st = fs.statSync(path.join(projectWorkDir(projectId, dataDir), "events.jsonl"));
    return { id: `${st.size}:${Math.round(st.mtimeMs)}`, error: null };
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") return { id: "", error: null };
    return { id: "", error: `事件账本身份读不出：${errText(e)}` };
  }
}

/**
 * 收件目录的有界指纹（证据文件 `name:size:mtime` 摘要 + 计数）。
 *
 * 为什么轮询也要看收件目录：inbox watcher 在宿主刚起来/刚重挂的那一瞬间还没 ready，期间落地的
 * 证据文件可能被 `ignoreInitial` 吞掉；有界轮询是它的兜底（契约「可用有界增量轮询 + 准确 inbox watch」）。
 *
 * 硬口径（返工 B 终版）：
 *   ① **不 silent catch**：只有 ENOENT 算"目录/文件暂不在"，其余读失败（ENOTDIR/EPERM/EACCES/EIO…）
 *      一律**显式带回 `error`**，由调用方进 health——权限/IO 异常**不得**用 `gone` 吞成"没有证据"；
 *   ② **有界且不冒充完整**：最多纳入 `SYNC_POLL_MAX_EVIDENCE_FILES` 个证据文件，超出即 `overflow=true`；
 *      截断后的指纹**不能**保证发现后续文件的变化（watcher 故障时尤其致命），调用方据此 **fail-closed**
 *      上报（契约「达到上限报 incomplete 及原因，不能截断后报通过」），不得悄悄当作"没变化"。
 */
function inboxFingerprint(root: string): { fp: string; count: number; overflow: boolean; error: string | null } {
  const dir = path.join(root, SYNC_INBOX_REL);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") return { fp: "", count: 0, overflow: false, error: null };
    return { fp: "", count: 0, overflow: false, error: `收件目录读不出：${errText(e)}` };
  }
  const digest = crypto.createHash("sha256");
  let count = 0;
  let overflow = false;
  for (const name of names.sort()) {
    if (!name.endsWith(SYNC_EVIDENCE_FILE_SUFFIX)) continue;
    count += 1;
    if (count > SYNC_POLL_MAX_EVIDENCE_FILES) {
      overflow = true;
      break;
    }
    try {
      const st = fs.statSync(path.join(dir, name));
      digest.update(`${name}\u0000${st.size}\u0000${Math.round(st.mtimeMs)}\n`);
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno === "ENOENT") {
        // 读取期间刚被删（合法竞态）：如实记为"不在"
        digest.update(`${name}\u0000gone\n`);
        continue;
      }
      // 权限/IO 等异常：显式失败，绝不吞成 "gone"
      return { fp: "", count, overflow, error: `收件目录证据文件 ${name} 判不出：${errText(e)}` };
    }
  }
  return { fp: `${digest.digest("hex")}#${count}`, count, overflow, error: null };
}

// ── 扫描调度（每项目一个定时器＝真防抖） ──

function fireScan(rt: DiscoveryRuntime, w: ProjectWatch, why: string): void {
  if (rt.stopped) return;
  const promise = requestSyncScan({
    projectId: w.projectId,
    dataDir: rt.dataDir,
    submitter: rt.service,
    actorId: "sync-discovery",
    role: "coordinator",
  });
  const settled = promise
    .then((outcome) => {
      if (rt.stopped) return;
      if (outcome.scan_error !== null) {
        w.scan_error = `扫描有错误：${outcome.scan_error}`;
        log(`项目 ${w.projectId} 扫描有错误（${why}）：${outcome.scan_error}`);
      } else {
        w.scan_error = null;
        log(
          `项目 ${w.projectId} 扫描完成（${why}）：overall=${outcome.report.overall}，批次 ${outcome.report.batches.length} 个，` +
            `提交 ${outcome.entries.filter((e) => e.submitted).length} 条（重复 ${outcome.entries.filter((e) => e.duplicate).length}）`,
        );
      }
      flushProjectIssues(rt, w);
    })
    .catch((e: unknown) => {
      if (rt.stopped) return;
      w.scan_error = `扫描异常：${errText(e)}`;
      log(`项目 ${w.projectId} 扫描异常（${why}）：${errText(e)}`);
      flushProjectIssues(rt, w);
    });
  rt.inflight.add(settled);
  void settled.finally(() => {
    rt.inflight.delete(settled);
  });
}

/**
 * 调度一次扫描（**按项目替换定时器**：同一项目的连续通知合并成一次；持续事件流有防抖上限）。
 * `immediate` = 启动/首见项目时立刻扫（启动时按契约做有界首次扫描）。
 */
function scheduleScan(rt: DiscoveryRuntime, w: ProjectWatch, why: string, immediate = false): void {
  if (rt.stopped) return;
  if (immediate) {
    if (w.scanTimer !== null) {
      clearTimeout(w.scanTimer);
      w.scanTimer = null;
    }
    fireScan(rt, w, why);
    return;
  }
  const now = Date.now();
  if (w.scanTimer === null) {
    w.debounceSince = now;
  } else {
    clearTimeout(w.scanTimer);
    w.scanTimer = null;
    if (now - w.debounceSince >= SYNC_SCAN_MAX_WAIT_MS) {
      w.debounceSince = now;
      fireScan(rt, w, why);
      return;
    }
  }
  const generation = w.generation;
  const timer = setTimeout(() => {
    if (w.scanTimer === timer) w.scanTimer = null;
    if (rt.stopped || w.generation !== generation) return;
    fireScan(rt, w, why);
  }, SYNC_SCAN_DEBOUNCE_MS);
  timer.unref?.();
  w.scanTimer = timer;
}

// ── 项目监听 ──

/** 关掉一个项目的收件监听与挂起定时器；`generation` 自增使旧回调作废（旧 watcher 关闭不误写） */
function detachWatcher(rt: DiscoveryRuntime, w: ProjectWatch): void {
  w.generation += 1;
  if (w.scanTimer !== null) {
    clearTimeout(w.scanTimer);
    w.scanTimer = null;
  }
  const watcher = w.watcher;
  w.watcher = null;
  if (watcher !== null) {
    void watcher.close().catch((e: unknown) => log(`关闭项目 ${w.projectId} 收件监听失败（忽略）：${errText(e)}`));
  }
}

/** 挂一个项目的收件目录监听（只挂约定目录、depth:0、不跟随联接点）；目录暂时不在也会等它出现 */
function ensureWatcher(rt: DiscoveryRuntime, w: ProjectWatch): void {
  if (w.watcher !== null) return;
  const generation = w.generation;
  let watcher: FSWatcher;
  try {
    watcher = watch(inboxPathOf(w.root), {
      ignoreInitial: true,
      followSymlinks: false,
      depth: 0,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
  } catch (e) {
    w.watch_error = `收件目录监听挂不上：${errText(e)}（退化为有界轮询发现）`;
    log(`项目 ${w.projectId} 收件目录监听挂不上：${errText(e)}——退化为有界轮询/显式扫描`);
    return;
  }
  w.watcher = watcher;
  const onEvent = (): void => {
    if (rt.stopped || w.generation !== generation || w.watcher !== watcher) return;
    scheduleScan(rt, w, "inbox 变化");
  };
  watcher.on("add", onEvent);
  watcher.on("change", onEvent);
  watcher.on("unlink", onEvent);
  watcher.on("error", (e: unknown) => {
    if (rt.stopped || w.generation !== generation) return;
    w.watch_error = `收件目录监听错误：${errText(e)}`;
    log(`项目 ${w.projectId} 收件目录监听错误：${errText(e)}`);
    flushProjectIssues(rt, w);
  });
  w.watch_error = null;
  log(`项目 ${w.projectId} 收件目录监听已挂（${SYNC_INBOX_REL}）`);
}

// ── 注册表 / 项目增量发现（有界轮询） ──

/**
 * 一轮有界增量发现：枚举注册表（≤ `SYNC_MAX_PROJECTS` 个**有同步配置**的项目），
 * 处理新增/路径变更/注销，按事件账本 mtime/size 便宜判据决定是否重解析本领域事实，必要时挂监听并调度扫描。
 * 返回本轮"有同步配置"的项目数。
 */
function pollProjects(rt: DiscoveryRuntime, why: string): number {
  if (rt.stopped) return 0;
  let projects: ProjectRecord[];
  try {
    projects = listProjects(rt.dataDir);
    rt.registry_read_error = null;
  } catch (e) {
    rt.registry_read_error = `注册表读不出（后台发现本轮跳过，不当作空项目列表）：${errText(e)}`;
    log(rt.registry_read_error);
    applyGlobalIssues(rt);
    return 0;
  }

  const live = new Set<string>();
  let configuredCount = 0;
  let limitHit = false;
  const fresh: ProjectWatch[] = [];
  const newlyConfigured: { w: ProjectWatch; became: boolean }[] = [];

  for (const p of projects) {
    live.add(p.id);
    const root = path.resolve(p.path);
    let w = rt.projects.get(p.id);
    if (w !== undefined && w.root !== root) {
      detachWatcher(rt, w); // 路径变更：旧监听/定时器先关（旧 watcher 关闭不误写）
      w.root = root;
      w.eventsId = "";
      w.inboxFp = "";
      w.configured = false;
    }
    if (w === undefined) {
      w = {
        projectId: p.id,
        root,
        watcher: null,
        scanTimer: null,
        debounceSince: 0,
        eventsId: "",
        inboxFp: "",
        configured: false,
        generation: 0,
        watch_error: null,
        facts_error: null,
        scan_error: null,
      };
      rt.projects.set(p.id, w);
      fresh.push(w);
    }

    // 便宜增量判据：事件账本身份变了（或还没配置且收件目录在场）才重解析本领域事实
    const eventsId = eventsIdentity(p.id, rt.dataDir);
    const inbox = probeInbox(w.root);
    const inboxFp = inboxFingerprint(w.root);
    const factsErrors = [eventsId.error, inbox.error, inboxFp.error].filter((x): x is string => x !== null);
    if (inboxFp.overflow) {
      // 达到有界轮询上限：指纹已不能再保证覆盖后续文件的变化（watcher 故障时尤甚）→ 显式 fail-closed，
      // 不截断后当作完整发现（契约「达到上限报 incomplete 及原因，不能截断后报通过」）。
      factsErrors.push(
        `收件目录证据文件数超过有界轮询指纹上限 ${SYNC_POLL_MAX_EVIDENCE_FILES}（已见 ${inboxFp.count} 个）：` +
          "轮询兜底不再覆盖后续文件，watcher 故障时更无从发现——按 fail-closed 上报，不截断后报通过",
      );
    }
    const eventsChanged = eventsId.id !== w.eventsId;
    const inboxChanged = inboxFp.fp !== w.inboxFp;
    if (eventsChanged) w.eventsId = eventsId.id;
    if (inboxChanged) w.inboxFp = inboxFp.fp;
    const wasConfigured = w.configured;
    if (eventsChanged || (!wasConfigured && inbox.exists)) {
      try {
        w.configured = inbox.exists || projectHasSyncContract(p.id, rt.dataDir);
      } catch (e) {
        w.configured = inbox.exists;
        factsErrors.push(`本领域事实读不出：${errText(e)}`);
        log(`项目 ${p.id} 本领域事实读不出：${errText(e)}`);
      }
    }
    w.facts_error = factsErrors.length > 0 ? factsErrors.join("；") : null;
    if (w.facts_error !== null) log(`项目 ${p.id} 发现失败：${w.facts_error}`);

    if (!w.configured) {
      if (w.watcher !== null) detachWatcher(rt, w);
      flushProjectIssues(rt, w);
      continue;
    }

    configuredCount += 1;
    if (configuredCount > SYNC_MAX_PROJECTS) {
      limitHit = true;
      w.configured = true;
      flushProjectIssues(rt, w);
      break;
    }
    const hadWatcher = w.watcher !== null;
    ensureWatcher(rt, w);
    flushProjectIssues(rt, w);
    if (!hadWatcher || (!wasConfigured && w.configured) || eventsChanged || inboxChanged) {
      newlyConfigured.push({ w, became: !wasConfigured });
    }
  }

  // 注销/移出注册表的项目：关监听、清定时器、清它的发现错误（无残留）
  for (const id of [...rt.projects.keys()]) {
    if (live.has(id)) continue;
    const w = rt.projects.get(id);
    if (w !== undefined) detachWatcher(rt, w);
    rt.projects.delete(id);
    clearProjectIssues(rt, id);
  }

  rt.project_limit_note = limitHit
    ? `已同步配置项目数超过后台发现上限 ${SYNC_MAX_PROJECTS}：本次只处理前 ${SYNC_MAX_PROJECTS} 个（不截断后报通过，未处理项目按未知）`
    : null;
  applyGlobalIssues(rt);

  for (const f of fresh) scheduleScan(rt, f, `首见（${why}）`, true);
  for (const n of newlyConfigured) {
    if (fresh.includes(n.w)) continue;
    scheduleScan(rt, n.w, n.became ? `新登记同步配置（${why}）` : `事件账本变化（${why}）`);
  }
  if (fresh.length > 0) log(`注册表增量发现（${why}）：新项目 ${fresh.length} 个，其中已挂监听 ${configuredCount} 个`);
  return configuredCount;
}

function pollSafely(rt: DiscoveryRuntime, why: string): void {
  if (rt.stopped) return;
  try {
    pollProjects(rt, why);
  } catch (e) {
    rt.registry_read_error = `后台发现轮询异常（${why}）：${errText(e)}`;
    log(rt.registry_read_error);
    applyGlobalIssues(rt);
  }
}

/** 监听宿主自己的注册表（registry.json）。chokidar 能监听尚不存在的路径，创建/替换/删除都会触发。 */
function startRegistryWatch(rt: DiscoveryRuntime): void {
  const file = path.join(rt.dataDir, "registry.json");
  const onReg = (): void => {
    if (rt.stopped || rt.registryTimer !== null) return; // 已挂起的注册表防抖合并成一次
    const timer = setTimeout(() => {
      if (rt.registryTimer === timer) rt.registryTimer = null;
      pollSafely(rt, "注册表变化");
    }, SYNC_REGISTRY_DEBOUNCE_MS);
    timer.unref?.();
    rt.registryTimer = timer;
  };
  try {
    const rw = watch(file, {
      ignoreInitial: true,
      depth: 0,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    rw.on("add", onReg);
    rw.on("change", onReg);
    rw.on("unlink", onReg);
    rw.on("error", (e: unknown) => {
      if (rt.stopped) return;
      rt.registry_watch_error = `注册表监听错误：${errText(e)}（退化为有界轮询发现）`;
      log(rt.registry_watch_error);
      applyGlobalIssues(rt);
    });
    rt.registryWatcher = rw;
    rt.registry_watch_error = null;
  } catch (e) {
    rt.registry_watch_error = `注册表监听挂不上：${errText(e)}（退化为有界轮询发现）`;
    log(rt.registry_watch_error);
  }
  applyGlobalIssues(rt);
}

/**
 * 启动后台发现（组合根 = 唯一写服务宿主：`index.ts` 的 publish 之后 / `daemon.ts` 的 publish 之后）。
 * **先复核描述符确实属于本进程**才启动；有界首次扫描"既有包"；随后按约定目录增量发现 + 有界轮询兜底。
 * 幂等——已启动时直接返回。
 */
export function startSyncDiscovery(opts: { service: SyncSubmitter; dataDir: string }): void {
  if (runtime !== null) return;
  if (process.env.TATAI_SYNC_DISCOVERY === "0") {
    log("后台同步发现被 TATAI_SYNC_DISCOVERY=0 关闭（仅显式 scan_sync_evidence 生效）");
    return;
  }
  const dataDir = path.resolve(opts.dataDir);
  let descPid: number | null = null;
  try {
    descPid = readServiceDescriptor(dataDir)?.pid ?? null;
  } catch (e) {
    descPid = null;
    log(`读写入服务描述符失败（按未持有处理）：${errText(e)}`);
  }
  if (descPid !== process.pid) {
    log(
      `未确认唯一写入服务描述符属于本进程（描述符 pid=${descPid ?? "无"}，本进程 pid=${process.pid}）` +
        "——后台发现不启动（由真正持有描述符的宿主扫描）",
    );
    return;
  }

  const rt: DiscoveryRuntime = {
    service: opts.service,
    dataDir,
    projects: new Map(),
    registryWatcher: null,
    registryTimer: null,
    pollTimer: null,
    inflight: new Set(),
    stopped: false,
    initial_scan_done: false,
    registry_read_error: null,
    registry_watch_error: null,
    project_limit_note: null,
  };
  runtime = rt;

  startRegistryWatch(rt);
  const configured = pollProjects(rt, "启动");
  rt.pollTimer = setInterval(() => pollSafely(rt, "轮询"), SYNC_POLL_INTERVAL_MS);
  rt.pollTimer.unref?.();

  const pending = [...rt.inflight];
  if (pending.length === 0) rt.initial_scan_done = true;
  else
    void Promise.allSettled(pending).then(() => {
      if (runtime === rt) rt.initial_scan_done = true;
    });

  log(
    `后台发现已启动（data dir: ${dataDir}）：有同步配置的项目 ${configured} 个，收件目录 ${SYNC_INBOX_REL}` +
      `${rt.project_limit_note === null ? "" : `（${rt.project_limit_note}）`}`,
  );
}

/**
 * 停机等待在途扫描：**必须真正等到全部已启动的在途扫描终止**才返回，之后不再新增写入。
 *
 * 旧实现用 `Promise.race(全部在途, 10s)`：到点即清活跃槽、清 health 并成功返回，而仍在途的 scan
 * 随后照写——违背契约「await stop 返回后不再新增扫描写入」。这里改为一律 `Promise.allSettled`：
 * 10s 只**记一条告警**，不假称已停止、不提前撤权（否则宿主可能撤描述符后重启，与旧进程双写）。
 */
async function awaitInflight(pending: readonly Promise<unknown>[]): Promise<void> {
  if (pending.length === 0) return;
  const warn = setTimeout(() => {
    log(`停机等待在途扫描已超过 ${SYNC_STOP_WARN_MS}ms：继续等待其真正终止（不假称已停止、不提前撤权）`);
  }, SYNC_STOP_WARN_MS);
  warn.unref?.();
  try {
    await Promise.allSettled(pending);
  } finally {
    clearTimeout(warn);
  }
}

/**
 * 停机：关全部监听、清全部定时器、**真正等待全部已启动的在途扫描终止**后返回。
 * 返回之后不再有新的扫描写入（在途全部收尾后才清本宿主的发现错误）；幂等。
 */
export async function stopSyncDiscovery(): Promise<void> {
  const rt = runtime;
  if (rt === null) return;
  runtime = null;
  rt.stopped = true;

  if (rt.pollTimer !== null) clearInterval(rt.pollTimer);
  rt.pollTimer = null;
  if (rt.registryTimer !== null) clearTimeout(rt.registryTimer);
  rt.registryTimer = null;
  for (const w of rt.projects.values()) detachWatcher(rt, w);
  rt.projects.clear();
  const rw = rt.registryWatcher;
  rt.registryWatcher = null;
  if (rw !== null) await rw.close().catch((e: unknown) => log(`关闭注册表监听失败（忽略）：${errText(e)}`));

  const pending = [...rt.inflight];
  await awaitInflight(pending); // 真正等在途全部终止；10s 只记告警，不超时假成功
  rt.inflight.clear();
  clearSyncDiscoveryIssues(rt.dataDir);
  log(`后台发现已停止（监听/定时器已清，在途 ${pending.length} 条已全部收尾）`);
}

/** 供自检/验证读取（不写任何东西）：后台是否在跑、首次扫描、上限原因、监听/挂起计数 */
export function syncDiscoveryStatus(): {
  running: boolean;
  initial_scan_done: boolean;
  project_limit_note: string | null;
  watchers: number;
  watched_projects: number;
  pending_scans: number;
  projects: number;
} {
  if (runtime === null || runtime.stopped) {
    return { running: false, initial_scan_done: false, project_limit_note: null, watchers: 0, watched_projects: 0, pending_scans: 0, projects: 0 };
  }
  let watched = 0;
  let pending = 0;
  for (const w of runtime.projects.values()) {
    if (w.watcher !== null) watched += 1;
    if (w.scanTimer !== null) pending += 1;
  }
  return {
    running: true,
    initial_scan_done: runtime.initial_scan_done,
    project_limit_note: runtime.project_limit_note,
    watchers: watched + (runtime.registryWatcher !== null ? 1 : 0),
    watched_projects: watched,
    pending_scans: pending,
    projects: runtime.projects.size,
  };
}

/** 收件目录是否在场（只读；目录不存在正常为空） */
export function syncInboxExists(projectRoot: string): boolean {
  return probeInbox(projectRoot).exists;
}
