// outbox 适配层 · 生产接入版（C014 收口第三包，2026-09-21；外部协调器侧）
//
// 渊源：由 `.工作台/evidence/V06-11/2-outbox-适配层/adapter.ts`（隔离级，TPL-10 §五"补修验收六条"
// 全绿）原样晋升并增加 **real 模式**；隔离级证据原件一字未动。
//
// 定位：协调器侧的"待提交回执持久化 + 新进程幂等恢复"。塔台仍是唯一事实写者：
//   real 模式不直连事件文件，只经本地 submitter 走真实桌面服务的 `POST /api/work/command`
//   （描述符 `<数据目录>/work-service.json` 发现 host/port/token，头 `x-tatai-work-token`；
//   错误语义照抄 `src/server/work/service.ts` 的 `WorkServiceClient.submit`：描述符缺失/不可达 →
//   WorkError(SERVICE_UNAVAILABLE)，非 2xx 透传 code/message/detail；OUTBOX_SERVICE_URL 只改 URL），
//   回执类型 → v2 事件的映射走 `src/server/work/executionReceipts.ts` 的 record* helper——
//   认领门禁（CLAIM_HELD/CLAIM_NOT_YOURS）、稳定意图幂等键、实体版本现读全由 helper 层保证；
//   服务不可达 → 回执留本地待提交并拒绝领取新写任务，绝不退化成自己写事实文件（单写者契约不变）。
//
// 两种服务模式（service.json 的 mode 字段；环境变量 OUTBOX_MODE 覆盖）：
//   stub：本地夹具写服务（<url>/submit、/effect、/health）——隔离级行为，老测试形态；
//   real：塔台真实写服务。url 取环境变量 OUTBOX_SERVICE_URL（测试接缝：故障注入代理），
//         否则按 data_dir（service.json.data_dir 或 TATAI_HOME）读 work-service.json 描述符。
//
// 回执类型 → execution.* 映射（real 模式）：
//   heartbeat  → execution.heartbeat（observed_at 原观测时间 → 幂等键稳定）
//   checkpoint → execution.checkpoint（note/artifacts/worktree 全量）
//   delivery   → execution.effect_declared（动作前声明，同键去重）→ execution.delivered
//              → 本地按 verify_method 核实外部效果（当前支持 file_sha256:<绝对路径>:<sha256hex>）
//              → 核实成立才 execution.effect_confirmed（result_ref=sha256:<hex>），否则保持
//                submitted；恢复时仍核实不了 → unresolved，停止盲重放（§5.4）
//   claim --real 另走真实发起链：claimTask（task.claimed，拿 claim_token/attempt/run_id）
//              → execution.start_requested → execution.started，然后把 ExecutionTarget 存进 run 登记。
//
// 持久件（全部落在 `--home <dir>` 下，recover 只读这些）：
//   pending-receipts.jsonl        回执台账：每行一个 JSON（含完整负载与原幂等键）
//   pending-receipts.torn.jsonl   撕裂碎片侧车：崩溃残留的半行原文隔离于此，不静默丢
//   channel-state.json            通道状态 { paused }
//   run-state.json                已领取 run/attempt 登记（claim 写入；real 模式附 ExecutionTarget）
//   run-state.json.bak            上一份读得出的 run-state（主文件损坏时的回退材料，F-01）
//   run-state.json.torn           损坏的 run-state 主文件留证（覆盖前隔离，不静默丢，F-01）
//   service.json                  写服务配置 { mode, url?, data_dir? }
//   outbox.lock                   home 级互斥锁（pid+acquired_at；死锁可接管并留 takeover_from，F-02）
//
// 持久化抗撕裂：整文件重写一律走 临时文件+fsync+同目录 rename 原子替换（回执台账、run-state、
// channel-state 同口径，F-01）；追加先修复撕尾再写并 fsync；
// 读取容忍末尾半行（上次追加写了一半进程死亡），碎片隔离进侧车并在 recover 报告 torn 计数；
// 非末尾行损坏属真 corruption，点名行号抛错，拒绝静默跳过。
// run-state 读坏先回退 .bak、主与 .bak 双坏按空态起并标 torn（不抛砖变砖）；
// channel-state 读坏 fail-closed 当 paused:true（暂停意图丢失时宁可拒领）；
// real 模式回执缺 ExecutionTarget 时 recover 逐条计 missing_target 并 exit 2（拒绝盲提交，F-03）。
//
// 本地台账幂等键 = `<run>:<type>:<occurred_at>`，occurred_at 取**原观测时间**（payload.observed_at/occurred_at），
// 不经恢复重算——重交必须复用原键。同键只允许一种负载：
// 同键同内容为幂等重发（不追加台账第二条），同键不同内容拒绝（点名冲突，不覆盖既有台账）。
// 服务端幂等键由 executionReceipts helper 从稳定意图另算（同一次意图恢复后重算出同一个键）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readServiceDescriptor, WORK_TOKEN_HEADER } from "../../src/server/work/service";
import { resolveDataDir } from "../../src/server/registry";
import { loadEvents } from "../../src/server/work/eventStore";
import { projectWorkDir } from "../../src/server/workstation";
import { claimTask, type ClaimSubmitter } from "../../src/server/work/claims";
import {
  confirmEffect,
  declareEffect,
  recordCheckpoint,
  recordDelivered,
  recordHeartbeat,
  recordStartRequested,
  recordStarted,
  type ExecutionTarget,
} from "../../src/server/work/executionReceipts";
import { WorkError, type WorkCommand, type WorkErrorCode, type WorkEvent, type WorkReceipt } from "../../src/server/work/types";

/** 适配器自身版本（execution.started 的 client_version 如实记） */
const ADAPTER_VERSION = "outbox-adapter/1.0.0-c014";

// ── 类型 ──────────────────────────────────────────────────────────────

/** 本链路必要回执类型（recover 只处理这三种；claim_reject 是拒领记录，不参与补交） */
export const LINK_TYPES = ["heartbeat", "checkpoint", "delivery"] as const;
export type ReceiptType = (typeof LINK_TYPES)[number];
/** pending＝待提交；submitted＝已提交有回执；confirmed＝效果已确认；unresolved＝效果不可确认，停止盲重放 */
export type ReceiptStatus = "pending" | "submitted" | "confirmed" | "unresolved";

export interface OutboxReceipt {
  type: ReceiptType | "claim_reject";
  project: string | null;
  task: string | null;
  run: string | null;
  attempt: number | null;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  status: ReceiptStatus;
  occurred_at: string;
  /** 提交成功后的服务端回执（原回执） */
  receipt?: unknown;
  /** 最近一次提交失败原因（保持 pending 时登记） */
  last_error?: string;
  /** unresolved 的原因（停止盲重放时登记） */
  unresolved_reason?: string;
}

export interface ClaimResult {
  ok: boolean;
  run?: string;
  attempt?: number;
  reason?: string;
}

export interface EmitResult {
  ok: boolean;
  receipt?: OutboxReceipt;
  reason?: string;
}

export interface RecoverReport {
  lines: number;
  resubmitted: number;
  duplicates: number;
  confirmed: number;
  unresolved: number;
  still_pending: number;
  skipped: number;
  /** 本次恢复隔离的撕裂碎片行数（原文见 pending-receipts.torn.jsonl） */
  torn: number;
  /** real 模式下 run-state 缺 ExecutionTarget 的回执条数（F-03/F-01：拒绝盲提交，修复登记后下轮再补） */
  missing_target: number;
  /** 缺 ExecutionTarget 的 run id 清单（逐条点名，不合并） */
  missing_target_runs: string[];
}

// ── 持久件读写 ────────────────────────────────────────────────────────

const pendingFile = (home: string) => path.join(home, "pending-receipts.jsonl");
const tornFile = (home: string) => path.join(home, "pending-receipts.torn.jsonl");
const channelFile = (home: string) => path.join(home, "channel-state.json");
const runStateFile = (home: string) => path.join(home, "run-state.json");
const serviceFile = (home: string) => path.join(home, "service.json");

function ensureHome(home: string): void {
  fs.mkdirSync(home, { recursive: true });
}

// ── 抗撕裂写原语 ──────────────────────────────────────────────────────

let tmpCounter = 0;
/** 整文件原子替换：同目录临时文件 + fsync + rename（Windows 下 Node 以覆盖语义 rename） */
function atomicWriteFileSync(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${(tmpCounter += 1)}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** 追加一行并 fsync（进程死亡最多撕裂末尾半行，读取侧按撕尾容错） */
function appendRawSync(file: string, content: string): void {
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** 撕裂碎片隔离进侧车（按原文整行去重，不静默丢） */
function quarantineTorn(home: string, raws: string[]): void {
  const fresh = raws.filter((x) => x.trim() !== "");
  if (!fresh.length) return;
  ensureHome(home);
  const f = tornFile(home);
  const existing = fs.existsSync(f) ? fs.readFileSync(f, "utf8").split(/\r?\n/) : [];
  const add = fresh.filter((x) => !existing.includes(x));
  if (add.length) appendRawSync(f, add.join("\n") + "\n");
}

// ── home 级互斥锁（F-02，2026-09-21 收口审计） ────────────────────────────
//
// 一个 home 的台账同时只许一个适配器进程动：updateReceipt/recover 都是"读全量→整文件重写"，
// 两个进程并发会把对方刚追加/刚复活的行用陈旧清单盖掉（静默丢回执）。锁文件 `<home>/outbox.lock`
// （内容 pid+acquired_at；接管时附 takeover_from）：
//   · 'wx' 原子获取——拿到就持锁到子命令结束（finally 释放 + 进程 exit 兜底清理）；
//   · 已存在先看持有者 pid 死活：`process.kill(pid, 0)` 抛错 = 原进程已死（SIGKILL 带不走锁），
//     死锁可接管并在锁内容里留 takeover_from 记录；活锁（进程还在）明确拒，不等不猜；
//   · 接管是"写入→复核"两刷（rename 原子覆盖 + 回读确认自己那一笔）：残余竞态窗口内仍可能
//     双活，但那要求两个进程在同一毫秒级同时判对方死亡——比无锁时代的静默丢行严得多，且
//     接管的常见触发（死 holder）本身罕见。

const lockFile = (home: string) => path.join(home, "outbox.lock");

interface LockHandle {
  file: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockPayload(takeoverFrom?: string): string {
  return (
    JSON.stringify({
      pid: process.pid,
      acquired_at: new Date().toISOString(),
      ...(takeoverFrom === undefined ? {} : { takeover_from: takeoverFrom }),
    }) + "\n"
  );
}

/** 读出锁内容里的 holder pid（锁文件半截/非 JSON 按"判不了死活"处理——与死锁同走接管路） */
function lockHolderPid(file: string): number | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: unknown };
    return typeof j.pid === "number" && Number.isInteger(j.pid) ? j.pid : null;
  } catch {
    return null;
  }
}

function acquireLock(home: string): LockHandle {
  ensureHome(home);
  const f = lockFile(home);
  try {
    const fd = fs.openSync(f, "wx");
    try {
      fs.writeSync(fd, lockPayload());
    } finally {
      fs.closeSync(fd);
    }
    return { file: f };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const holder = lockHolderPid(f);
  if (holder !== null && holder !== process.pid && pidAlive(holder)) {
    throw new Error(
      `另一个适配器进程（pid ${holder}）正持有 ${f}：本 home 的台账同时只许一个进程动` +
        "（并发读-改-写会静默丢回执行）。等它结束再试；确认它已死而锁没清，人工删锁或由下次调用的死锁接管处理",
    );
  }
  // 死锁接管：临时文件原子覆盖锁文件，回读确认自己那一笔还在（被别的接管者顶掉就认栽）
  const from = holder === null ? "unreadable" : `pid-${holder}-dead`;
  const content = lockPayload(from); // 只算一次：两次调用 acquired_at 不同，复核会永远误判被顶掉
  const tmp = `${f}.takeover-${process.pid}`;
  atomicWriteFileSync(tmp, content);
  fs.renameSync(tmp, f);
  if (fs.readFileSync(f, "utf8") !== content) {
    throw new Error(`死锁接管竞争失败：${f} 已被另一个接管者持有，放弃本次（不并行动台账）`);
  }
  return { file: f };
}

function releaseLock(h: LockHandle): void {
  try {
    fs.rmSync(h.file);
  } catch {
    /* 已被清理（进程 exit 兜底与 finally 可能各跑一次） */
  }
}

/**
 * 读台账。末尾半行视为撕尾（上次追加中途崩溃）：交 tornOut 由调用方隔离，不拖垮恢复；
 * 非末尾行损坏属真 corruption，点名行号抛错，拒绝静默跳过。
 */
export function readReceipts(home: string, tornOut?: { lines: string[] }): OutboxReceipt[] {
  const f = pendingFile(home);
  if (!fs.existsSync(f)) return [];
  const lines = fs
    .readFileSync(f, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  const out: OutboxReceipt[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    try {
      out.push(JSON.parse(lines[i]) as OutboxReceipt);
    } catch (e) {
      if (i === lines.length - 1) {
        tornOut?.lines.push(lines[i]);
        continue;
      }
      throw new Error(`回执台账损坏：pending-receipts.jsonl 第 ${i + 1} 行 JSON 解析失败（非末尾行，拒绝静默跳过）：${(e as Error).message}`);
    }
  }
  return out;
}

export function writeReceipts(home: string, list: OutboxReceipt[]): void {
  ensureHome(home);
  atomicWriteFileSync(pendingFile(home), list.map((r) => JSON.stringify(r)).join("\n") + (list.length ? "\n" : ""));
}

function appendReceipt(home: string, r: OutboxReceipt): void {
  ensureHome(home);
  const f = pendingFile(home);
  if (fs.existsSync(f)) {
    const buf = fs.readFileSync(f, "utf8");
    if (buf !== "" && !buf.endsWith("\n")) {
      // 既有撕尾：先隔离碎片并把账本截到最后一条完整行，否则新行会与碎片粘成一条废行
      const cut = buf.lastIndexOf("\n");
      const tail = buf.slice(cut + 1);
      if (tail.trim() !== "") quarantineTorn(home, [tail]);
      atomicWriteFileSync(f, buf.slice(0, cut + 1));
    }
  }
  appendRawSync(f, JSON.stringify(r) + "\n");
}

function updateReceipt(home: string, key: string, r: OutboxReceipt): void {
  const torn = { lines: [] as string[] };
  const list = readReceipts(home, torn);
  if (torn.lines.length) quarantineTorn(home, torn.lines);
  const i = list.findIndex((x) => x.idempotency_key === key);
  if (i >= 0) list[i] = r;
  else list.push(r);
  writeReceipts(home, list);
}

interface RunState {
  current: string | null;
  runs: Record<string, { project: string; task: string; attempt: number; started_at: string; status: string; target?: ExecutionTarget }>;
  attempts: Record<string, number>;
}

/** run-state.json 的读取实况：主文件正常 / 主坏从 .bak 回退 / 主与 .bak 都坏按空态起（如实标注，不抛砖） */
type RunStateDegraded = "bak" | "torn" | undefined;
interface RunStateRead {
  state: RunState;
  degraded: RunStateDegraded;
}

const runStateBakFile = (home: string) => path.join(home, "run-state.json.bak");
const runStateTornFile = (home: string) => path.join(home, "run-state.json.torn");

function emptyRunState(): RunState {
  return { current: null, runs: {}, attempts: {} };
}

function parseRunState(raw: string): RunState | null {
  try {
    const s = JSON.parse(raw) as Partial<RunState>;
    return { current: s.current ?? null, runs: s.runs ?? {}, attempts: s.attempts ?? {} };
  } catch {
    return null;
  }
}

/**
 * 读 run-state（F-01，2026-09-21 收口审计）：主文件撕裂/损坏先回退 .bak（degraded:"bak"）；
 * 两者都坏 → 返回空态并标 degraded:"torn"——**不抛砖**（旧实现 JSON.parse 直接抛，claim/emit/
 * recover 全部以「执行失败」变砖，pending 回执永远无法补交）。调用方按 degraded 如实标注。
 */
function readRunStateDegraded(home: string): RunStateRead {
  const f = runStateFile(home);
  if (!fs.existsSync(f)) return { state: emptyRunState(), degraded: undefined };
  const main = parseRunState(fs.readFileSync(f, "utf8"));
  if (main !== null) return { state: main, degraded: undefined };
  const bak = runStateBakFile(home);
  if (fs.existsSync(bak)) {
    const b = parseRunState(fs.readFileSync(bak, "utf8"));
    if (b !== null) return { state: b, degraded: "bak" };
  }
  return { state: emptyRunState(), degraded: "torn" };
}

function readRunState(home: string): RunState {
  return readRunStateDegraded(home).state;
}

/** 写 run-state（F-01）：与回执台账同走 临时文件+fsync+同目录 rename 原子替换；
 *  覆盖前先把上一份**读得出的**主文件留作 .bak（回退材料）；主文件已坏时不配当 .bak——
 *  把它留证到 .torn 再覆盖（旧 .bak 不动，坏现场不静默丢）。 */
function writeRunState(home: string, st: RunState): void {
  ensureHome(home);
  const f = runStateFile(home);
  if (fs.existsSync(f)) {
    const prev = fs.readFileSync(f, "utf8");
    if (parseRunState(prev) !== null) {
      atomicWriteFileSync(runStateBakFile(home), prev);
    } else {
      try {
        fs.copyFileSync(f, runStateTornFile(home));
      } catch {
        /* 留证失败不拖垮主流程（新状态照常落） */
      }
    }
  }
  atomicWriteFileSync(f, JSON.stringify(st, null, 2));
}

/** 读通道状态（F-01）：文件读不出/损坏 → **fail-closed 当 paused:true**（暂停意图丢失时
 *  宁可拒领新写任务，也不当没暂停放行），并带回人读原因供调用方上屏/落台账。 */
function readChannelDegraded(home: string): { paused: boolean; degraded_reason: string | null } {
  const f = channelFile(home);
  if (!fs.existsSync(f)) return { paused: false, degraded_reason: null };
  try {
    const s = JSON.parse(fs.readFileSync(f, "utf8")) as { paused?: boolean };
    return { paused: s.paused === true, degraded_reason: null };
  } catch (e) {
    return {
      paused: true,
      degraded_reason: `channel-state.json 读不出/已损坏（${(e as Error).message}）：fail-closed 按 paused=true 拒领（暂停意图丢失时宁可拒领，请先修复该文件）`,
    };
  }
}

export function readChannel(home: string): { paused: boolean } {
  return { paused: readChannelDegraded(home).paused };
}

export async function setPaused(home: string, paused: boolean): Promise<{ paused: boolean }> {
  ensureHome(home);
  atomicWriteFileSync(channelFile(home), JSON.stringify({ paused }, null, 2));
  return { paused };
}

// ── 服务模式与发现 ────────────────────────────────────────────────────

interface ServiceConfig {
  /** stub＝本地夹具写服务；real＝塔台真实写服务（本地 submitter 真实 HTTP，语义同 WorkServiceClient.submit，单写者不变） */
  mode: "stub" | "real";
  /** stub 模式的夹具地址；real 模式的测试接缝（故障注入代理）。real 缺省走描述符发现 */
  url: string | null;
  /** real 模式的数据目录（读 <data_dir>/work-service.json 拿 host/port/token） */
  data_dir: string | null;
}

/** 服务配置：环境变量优先（OUTBOX_MODE / OUTBOX_SERVICE_URL / TATAI_HOME），其次 <home>/service.json */
function serviceConfigOf(home: string): ServiceConfig {
  let s: { mode?: string; url?: string; data_dir?: string } = {};
  const f = serviceFile(home);
  if (fs.existsSync(f)) s = JSON.parse(fs.readFileSync(f, "utf8")) as typeof s;
  const modeEnv = (process.env.OUTBOX_MODE ?? "").trim();
  const mode: "stub" | "real" = (modeEnv !== "" ? modeEnv : (s.mode ?? "stub")) === "real" ? "real" : "stub";
  const urlEnv = (process.env.OUTBOX_SERVICE_URL ?? "").trim();
  const homeEnv = (process.env.TATAI_HOME ?? "").trim();
  return {
    mode,
    url: urlEnv !== "" ? urlEnv : (s.url ?? null),
    data_dir: homeEnv !== "" ? homeEnv : (s.data_dir ?? null),
  };
}

/** 写服务地址：real 模式优先环境变量接缝，缺省读描述符；stub 模式必须显式给（env 或 service.json） */
function serviceUrlOf(home: string): string | null {
  const cfg = serviceConfigOf(home);
  if (cfg.url !== null) return cfg.url;
  if (cfg.mode === "real" && cfg.data_dir !== null) {
    const d = readServiceDescriptor(cfg.data_dir);
    return d?.url ?? null;
  }
  return null;
}

// ── 写服务客户端（stub 形状） ─────────────────────────────────────────

interface SubmitOutcome {
  ok: boolean;
  /** "accepted"＝新落账；"duplicate"＝服务端去重返回原回执（recover 据此计数） */
  status?: string;
  receipt?: unknown;
  error?: string;
}

async function submit(
  url: string,
  r: OutboxReceipt,
): Promise<SubmitOutcome> {
  try {
    const res = await fetch(`${url}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotency_key: r.idempotency_key,
        type: r.type,
        project: r.project,
        task: r.task,
        run: r.run,
        attempt: r.attempt,
        payload: r.payload,
      }),
      signal: AbortSignal.timeout(3000),
    });
    const j = (await res.json().catch(() => null)) as { status?: string; receipt?: unknown; message?: string } | null;
    if (!res.ok) return { ok: false, error: `写服务拒绝（HTTP ${res.status}）：${j?.message ?? "无消息"}` };
    return { ok: true, status: j?.status, receipt: j?.receipt };
  } catch (e) {
    // ack-loss 会在此表现为连接被重置/超时：本次未拿到应答，但服务端可能已收下
    return { ok: false, error: `写服务不可达：${(e as Error).message}` };
  }
}

// ── 写服务客户端（real 形状：executionReceipts helper × 本地 submitter 真实 HTTP） ──

/** real 提交的统一出口类型注解（helper 的 ExecutionOutcome 收敛成 SubmitOutcome） */
type RealSubmitResult = SubmitOutcome;

function outcomeOf<T extends { ok: boolean }>(o: T, what: string): RealSubmitResult {
  if (o.ok === true) {
    const receipt = (o as unknown as { receipt?: WorkReceipt }).receipt;
    return {
      ok: true,
      status: receipt?.duplicate === true ? "duplicate" : "accepted",
      receipt: receipt ?? null,
    };
  }
  const f = o as unknown as { code?: string; message?: string };
  return { ok: false, error: `${what} 被写服务拒（${f.code ?? "?"}）：${f.message ?? "无消息"}` };
}

/**
 * real 模式的本地 submitter：语义照抄 `WorkServiceClient.submit`（src/server/work/service.ts:794-826）——
 *   描述符缺失 → WorkError(SERVICE_UNAVAILABLE)；连接失败 → WorkError(SERVICE_UNAVAILABLE)；
 *   非 2xx → 透传服务端 code/message/detail 的 WorkError。
 * 唯一差别：URL 取 `cfg.url ?? http://<descriptor.host>:<descriptor.port>`——cfg.url 是
 * OUTBOX_SERVICE_URL/service.json.url 故障注入接缝（缺省与描述符发现完全一致），token 恒取描述符。
 */
function realSubmitterOf(cfg: ServiceConfig, dataDir: string): { submit: (command: unknown) => Promise<WorkReceipt> } {
  return {
    submit: async (command: unknown): Promise<WorkReceipt> => {
      const d = readServiceDescriptor(dataDir);
      if (!d) {
        throw new WorkError(
          "SERVICE_UNAVAILABLE",
          "写入服务未启动：v2 事实只有一个写入者，适配器不自己追加事件。请先启动塔台桌面服务后再提交",
          { data_dir: dataDir },
        );
      }
      const url = cfg.url ?? `http://${d.host}:${d.port}`;
      let res: Response;
      try {
        res = await fetch(`${url}/api/work/command`, {
          method: "POST",
          headers: { "content-type": "application/json", [WORK_TOKEN_HEADER]: d.token },
          body: JSON.stringify(command),
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        throw new WorkError(
          "SERVICE_UNAVAILABLE",
          `写入服务不可达（${url}）：${e instanceof Error ? e.message : String(e)}。本次没有写入任何字节`,
          { url },
        );
      }
      const body = (await res.json().catch(() => null)) as
        | { code?: WorkErrorCode; message?: string; detail?: Record<string, unknown> }
        | null;
      if (!res.ok) {
        const code = (body?.code ?? "SERVICE_UNAVAILABLE") as WorkErrorCode;
        throw new WorkError(code, body?.message ?? `写入服务返回 HTTP ${res.status}`, body?.detail ?? {});
      }
      return body as unknown as WorkReceipt;
    },
  };
}

const execIdOf = (target: ExecutionTarget): string => target.execution_id ?? `ex-${target.task_id}-${target.attempt_id}`;

/** helper 每次调用现场打的时间戳字段：同一意图补交重算负载时它们必然变，逐字节比对必须对它们豁免 */
const HELPER_CLOCK_FIELDS = new Set(["declared_at", "confirmed_at"]);

/** 剥掉 helper 现场时钟字段后的负载指纹（其余字段仍逐字节，键序稳定） */
function payloadFingerprint(p: Record<string, unknown> | undefined): string {
  const c = { ...(p ?? {}) };
  for (const k of HELPER_CLOCK_FIELDS) delete c[k];
  return stableStringify(c);
}

/**
 * "同一意图"的适配层口径（对照服务端 sameIntent，service.ts:540-552）：
 * 信封字段逐字节 + occurred_at 口径相同；负载对 HELPER_CLOCK_FIELDS 豁免——
 * 那是 helper 构建命令时的墙钟，不是意图内容。豁免之外有任何不同 = 真冲突。
 */
function sameIntentModuloHelperClock(c: WorkCommand, e: WorkEvent): boolean {
  return (
    c.project_id === e.project_id &&
    c.change_id === e.change_id &&
    c.entity_id === e.entity_id &&
    c.type === e.type &&
    c.actor_id === e.actor_id &&
    c.role === e.role &&
    (c.occurred_at === undefined || c.occurred_at === e.occurred_at) &&
    payloadFingerprint(c.payload) === payloadFingerprint(e.payload)
  );
}

/** 单步提交（含补交自愈，对应 §5.4「恢复后按幂等键补交」与服务端 sameIntent 口径）：
 *  ① 常规：helper 现读实体版本提交；
 *  ② IDEMPOTENCY_CONFLICT：同键事件已存在——先按已存在事件的 entity_revision-1 重发（负载全由输入
 *     决定的事件这就拿得到 duplicate 原回执）；仍 409 说明负载里混了 helper 现场时钟
 *     （effect_declared.declared_at / effect_confirmed.confirmed_at），重算永远对不上逐字节 sameIntent——
 *     此时用 lastCommand() 拿到的实发命令与已存在事件按 sameIntentModuloHelperClock 核验：是同一意图就把
 *     已存在事件**原文**（原负载 + 原次 expected_revision）经 submitRaw 重放拿 duplicate 原回执；
 *     核验不过 = 同键真冲突，原样上报，不静默吞；
 *  ③ VERSION_CONFLICT：键未落账但实体已被推进（断线期积压多条的恢复场景）→ 现读版本再试一次。 */
async function submitStep<T extends { ok: boolean }>(
  ctx: {
    workDir: string;
    stepKey: string;
    /** 原样提交一条命令（ verbatim 重放已存在事件用；与 helper 同一个真实 HTTP 出口） */
    submitRaw: (cmd: WorkCommand) => Promise<WorkReceipt>;
    /** 最近一次经捕获 submitter 实发的命令（helper 构建的原文，含 expected_revision） */
    lastCommand: () => WorkCommand | null;
  },
  call: (expectedRevision?: number) => Promise<T>,
): Promise<T> {
  let o = await call(undefined);
  if (o.ok === true) return o;
  const code = (o as { code?: string }).code;
  if (code === "IDEMPOTENCY_CONFLICT") {
    const existing = loadEvents(ctx.workDir).events.find((e) => e.idempotency_key === ctx.stepKey);
    if (existing) {
      const healed = await call(existing.entity_revision - 1);
      if (healed.ok === true) return healed;
      const cmd = ctx.lastCommand();
      if (cmd !== null && sameIntentModuloHelperClock(cmd, existing)) {
        const receipt = await ctx.submitRaw({
          schema_version: existing.schema_version,
          project_id: existing.project_id,
          change_id: existing.change_id,
          entity_id: existing.entity_id,
          expected_revision: existing.entity_revision - 1,
          type: existing.type,
          actor_id: existing.actor_id,
          role: existing.role,
          idempotency_key: existing.idempotency_key,
          occurred_at: existing.occurred_at,
          payload: existing.payload,
        });
        // 出口只有 outcomeOf 读 .receipt：补成 helper 成功分支形状即可
        return { ok: true, receipt } as unknown as T;
      }
    }
    return o;
  }
  if (code === "VERSION_CONFLICT") {
    o = await call(undefined);
    return o;
  }
  return o;
}

/** delivery 的效果核实（real）：本地按 verify_method 实查，当前支持 file_sha256:<绝对路径>:<sha256hex> */
function localEffectQuery(verifyMethod: string): { ok: boolean; found: boolean; result_ref?: string; error?: string } {
  const m = verifyMethod.match(/^file_sha256:(.+):([0-9a-f]{64})$/);
  if (!m) return { ok: false, found: false, error: `不支持的 verify_method：${verifyMethod}（当前只支持 file_sha256:<绝对路径>:<sha256hex>）` };
  const [, file, expect] = m;
  try {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    return actual === expect
      ? { ok: true, found: true, result_ref: `sha256:${actual}` }
      : { ok: true, found: false, error: `sha256 不符（实测 ${actual.slice(0, 12)}… ≠ 声明 ${expect.slice(0, 12)}…）` };
  } catch (e) {
    return { ok: true, found: false, error: `效果文件读不出：${(e as Error).message}` };
  }
}

/** real 模式提交：回执 → execution.* 事件链（claim 登记里有 ExecutionTarget 才走得了） */
async function realSubmit(home: string, cfg: ServiceConfig, r: OutboxReceipt): Promise<RealSubmitResult> {
  const regRead = readRunStateDegraded(home);
  const target = regRead.state.runs[r.run ?? ""]?.target;
  if (!target) return { ok: false, error: missingTargetError(regRead, r.run) };
  const dataDir = cfg.data_dir ?? resolveDataDir();
  const raw = realSubmitterOf(cfg, dataDir);
  let lastCmd: WorkCommand | null = null;
  // 捕获实发命令原文：submitStep 的"同一意图"核验要拿它与已存在事件比对
  const submitter: ClaimSubmitter = {
    submit: (c: unknown) => {
      lastCmd = c as WorkCommand;
      return raw.submit(c);
    },
  };
  const workDir = projectWorkDir(target.project_id, dataDir);
  const execId = execIdOf(target);
  const what = `回执 ${r.type}（${r.idempotency_key}）`;
  const stepCtx = (stepKey: string) => ({ workDir, stepKey, submitRaw: (cmd: WorkCommand) => raw.submit(cmd), lastCommand: () => lastCmd });
  try {
    if (r.type === "heartbeat") {
      const observedAt = String(r.payload.observed_at ?? r.occurred_at);
      const o = await submitStep(stepCtx(`${execId}:execution.heartbeat:${observedAt}`), (rev) =>
        recordHeartbeat(
          {
            ...target,
            ...(rev === undefined ? {} : { expected_revision: rev }),
            observed_at: observedAt,
            note: r.payload.note as string | undefined,
            awaiting_input: r.payload.awaiting_input as boolean | undefined,
          },
          submitter,
          dataDir,
        ),
      );
      return outcomeOf(o, what);
    }
    if (r.type === "checkpoint") {
      const observedAt = String(r.payload.observed_at ?? r.occurred_at);
      const o = await submitStep(stepCtx(`${execId}:execution.checkpoint:${observedAt}`), (rev) =>
        recordCheckpoint(
          {
            ...target,
            ...(rev === undefined ? {} : { expected_revision: rev }),
            observed_at: observedAt,
            note: String(r.payload.note ?? ""),
            artifacts: r.payload.artifacts as string[] | undefined,
            worktree: r.payload.worktree as { dirty: boolean; changed_files: string[]; head?: string | null } | null | undefined,
            effects_in_flight: r.payload.effects_in_flight as string[] | undefined,
            awaiting_input: r.payload.awaiting_input as boolean | undefined,
          },
          submitter,
          dataDir,
        ),
      );
      return outcomeOf(o, what);
    }
    // delivery：动作前声明（同键去重）→ 交付落账；效果确认在 emit/recover 里按核实结果另走 confirmEffect
    const effectId = String(r.payload.effect_id ?? "");
    const verifyMethod = String(r.payload.verify_method ?? "");
    const d = await submitStep(stepCtx(`${execId}:execution.effect_declared:${effectId}`), (rev) =>
      declareEffect(
        {
          ...target,
          ...(rev === undefined ? {} : { expected_revision: rev }),
          effect_id: effectId,
          target: String(r.payload.effect_target ?? "本地文件系统交付物"),
          authorization: String(r.payload.authorization ?? "协调器在已认领任务与已授权批次范围内交付"),
          verify_method: verifyMethod,
        },
        submitter,
        dataDir,
      ),
    );
    if (d.ok !== true) return outcomeOf(d, `${what} 的效果声明`);
    const o = await submitStep(stepCtx(`${execId}:execution.delivered`), (rev) =>
      recordDelivered(
        {
          ...target,
          ...(rev === undefined ? {} : { expected_revision: rev }),
          deliverables: (r.payload.deliverables as string[]) ?? [],
          evidence_refs: (r.payload.evidence_refs as string[]) ?? [],
          verification: r.payload.verification as { command: string; exit_code: number; output_ref?: string | null }[] | undefined,
          untested: r.payload.untested as string[] | undefined,
          known_issues: r.payload.known_issues as string[] | undefined,
          diff_ref: (r.payload.diff_ref as string | null) ?? null,
          exit_code: (r.payload.exit_code as number | null) ?? null,
          client_version: ADAPTER_VERSION,
        },
        submitter,
        dataDir,
      ),
    );
    return outcomeOf(o, what);
  } catch (e) {
    // 服务不可达 / 应答丢失（本地 submitter 抛 WorkError(SERVICE_UNAVAILABLE)）：本次未拿到应答，但服务端可能已收下
    return { ok: false, error: `写服务不可达：${(e as Error).message}` };
  }
}

/** run-state 缺 ExecutionTarget 的如实原因（F-01/F-03：含 .bak 回退与撕裂空态的实况，不笼统计数） */
function missingTargetError(regRead: RunStateRead, run: string | null): string {
  const degradedNote =
    regRead.degraded === "torn"
      ? "；run-state.json 主文件与 .bak 都损坏，按空态起（坏主文件已留证 run-state.json.torn）"
      : regRead.degraded === "bak"
        ? "；run-state.json 主文件已损坏，回退 .bak 后其中没有此 run"
        : "";
  return `run=${run} 没有 real 模式 ExecutionTarget（不是 claim --real 领的${degradedNote}）`;
}

/** real 模式效果确认补交（效果已核实成立后）：execution.effect_confirmed 按原 effect_id 落账 */
async function realConfirmEffect(home: string, cfg: ServiceConfig, r: OutboxReceipt, resultRef: string): Promise<RealSubmitResult> {
  const regRead = readRunStateDegraded(home);
  const target = regRead.state.runs[r.run ?? ""]?.target;
  if (!target) return { ok: false, error: missingTargetError(regRead, r.run) };
  const dataDir = cfg.data_dir ?? resolveDataDir();
  const raw = realSubmitterOf(cfg, dataDir);
  let lastCmd: WorkCommand | null = null;
  const submitter: ClaimSubmitter = {
    submit: (c: unknown) => {
      lastCmd = c as WorkCommand;
      return raw.submit(c);
    },
  };
  const workDir = projectWorkDir(target.project_id, dataDir);
  const execId = execIdOf(target);
  const effectId = String(r.payload.effect_id ?? "");
  try {
    const o = await submitStep(
      { workDir, stepKey: `${execId}:execution.effect_confirmed:${effectId}:${resultRef}`, submitRaw: (cmd: WorkCommand) => raw.submit(cmd), lastCommand: () => lastCmd },
      (rev) =>
        confirmEffect(
          { ...target, ...(rev === undefined ? {} : { expected_revision: rev }), effect_id: effectId, result_ref: resultRef, note: r.payload.note as string | undefined },
          submitter,
          dataDir,
        ),
    );
    return outcomeOf(o, `效果确认（${effectId}）`);
  } catch (e) {
    return { ok: false, error: `写服务不可达：${(e as Error).message}` };
  }
}

async function stubEffectQuery(url: string, key: string): Promise<{ ok: boolean; found: boolean; error?: string }> {
  try {
    const res = await fetch(`${url}/effect?key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, found: false, error: `HTTP ${res.status}` };
    const j = (await res.json()) as { found?: boolean };
    return { ok: true, found: j.found === true };
  } catch (e) {
    return { ok: false, found: false, error: (e as Error).message };
  }
}

async function stubHealth(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** real 模式健康检查：描述符拿 url+token，GET /api/work/health（令牌不对/服务没起都是不可达） */
async function realHealth(cfg: ServiceConfig): Promise<{ ok: boolean; error?: string }> {
  if (cfg.data_dir === null) return { ok: false, error: "real 模式缺 data_dir（service.json.data_dir 或 TATAI_HOME）" };
  const d = readServiceDescriptor(cfg.data_dir);
  if (d === null) return { ok: false, error: `服务描述符不存在（${cfg.data_dir}/work-service.json）：服务没起` };
  const url = cfg.url ?? d.url;
  try {
    const res = await fetch(`${url}/api/work/health`, {
      headers: { "x-tatai-work-token": d.token },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** 模式统一的效果查询：stub 问夹具口；real 本地按 verify_method 实查（§5.4 协调器登记的检查方式） */
async function effectQueryOf(home: string, url: string, r: OutboxReceipt): Promise<{ ok: boolean; found: boolean; result_ref?: string; error?: string }> {
  const cfg = serviceConfigOf(home);
  if (cfg.mode === "real") return localEffectQuery(String(r.payload.verify_method ?? ""));
  return stubEffectQuery(url, String(r.idempotency_key));
}

/** 模式统一的提交出口 */
async function submitOf(home: string, url: string, r: OutboxReceipt): Promise<SubmitOutcome> {
  const cfg = serviceConfigOf(home);
  if (cfg.mode === "real") return realSubmit(home, cfg, r);
  return submit(url, r);
}

async function healthOf(home: string, url: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = serviceConfigOf(home);
  if (cfg.mode === "real") return realHealth(cfg);
  return stubHealth(url);
}

// ── claim：领取写任务（断线/paused 拒领） ─────────────────────────────

function recordReject(home: string, project: string, task: string, reason: string, at: string): void {
  appendReceipt(home, {
    type: "claim_reject",
    project,
    task,
    run: null,
    attempt: null,
    payload: { reason, at },
    idempotency_key: `claim:${project}:${task}:${at}`,
    status: "pending",
    occurred_at: at,
  });
}

export async function claim(opts: {
  home: string;
  project: string;
  task: string;
  /** real 模式：走完本地闸后接真实发起链（claimTask → start_requested → started） */
  real?: boolean;
  workspace?: string;
  changeId?: string;
  goal?: string;
  timeoutMs?: number;
  ownerId?: string;
  role?: string;
  coordinatorId?: string;
  clientId?: string;
}): Promise<ClaimResult> {
  const { home, project, task } = opts;
  const at = new Date().toISOString();
  ensureHome(home);

  // ① 通道暂停（含 channel-state.json 损坏的 fail-closed 拒领，F-01）：拒领
  const ch = readChannelDegraded(home);
  if (ch.paused) {
    const reason = ch.degraded_reason ?? "通道已暂停（channel-state.json paused=true），拒绝领取新写任务";
    recordReject(home, project, task, reason, at);
    return { ok: false, reason };
  }

  // ② 写服务不可达：拒领
  const url = serviceUrlOf(home);
  if (url === null) {
    const reason = "写服务地址未配置（无 OUTBOX_SERVICE_URL、无 service.json 或描述符缺失），拒绝领取新写任务";
    recordReject(home, project, task, reason, at);
    return { ok: false, reason };
  }
  const h = await healthOf(home, url);
  if (!h.ok) {
    const reason = `写服务不可达（${h.error}），拒绝领取新写任务`;
    recordReject(home, project, task, reason, at);
    return { ok: false, reason };
  }

  const cfg = serviceConfigOf(home);
  const wantReal = opts.real === true || cfg.mode === "real";
  if (wantReal && cfg.mode !== "real") {
    const reason = "指定了 --real 但 service.json 不是 real 模式（或 OUTBOX_MODE 未置 real）：不静默降级 stub";
    recordReject(home, project, task, reason, at);
    return { ok: false, reason };
  }

  // ③ 正常：登记 run/attempt 并开始
  const st = readRunState(home);
  const k = `${project}|${task}`;
  const attempt = (st.attempts[k] ?? 0) + 1;
  const stamp = at.replace(/[-:.TZ]/g, "").slice(0, 14);
  const run = `run-${project}-${task}-a${attempt}-${stamp}`;

  // real 发起链：真实认领 → 启动请求 → 启动确认，全部落账后才把 ExecutionTarget 存进登记
  if (wantReal) {
    const workspace = (opts.workspace ?? "").trim();
    const changeId = (opts.changeId ?? "").trim();
    if (workspace === "" || changeId === "") {
      const reason = "claim --real 需要 --workspace <隔离目录> 与 --change <批次 id>";
      recordReject(home, project, task, reason, at);
      return { ok: false, reason };
    }
    const dataDir = cfg.data_dir ?? resolveDataDir();
    const submitter = realSubmitterOf(cfg, dataDir);
    const ownerId = opts.ownerId ?? "outbox-adapter";
    const role = opts.role ?? "coordinator";
    try {
      const claimed = await claimTask(
        { project_id: project, task_id: task, role, owner_id: ownerId, change_id: changeId, workspace },
        submitter,
        dataDir,
      );
      if (!claimed.ok) {
        const reason = `真实认领被拒（${claimed.code}）：${claimed.message}`;
        recordReject(home, project, task, reason, at);
        return { ok: false, reason };
      }
      const attemptId = `att-${claimed.claim.attempt}`;
      const target: ExecutionTarget = {
        project_id: project,
        task_id: task,
        run_id: claimed.claim.run_id,
        attempt_id: attemptId,
        attempt: claimed.claim.attempt,
        coordinator_id: opts.coordinatorId ?? ownerId,
        claim_token: claimed.claim.claim_token,
        owner_id: ownerId,
        owner_role: role,
        change_id: changeId,
        workspace,
        client_id: opts.clientId ?? "outbox-adapter-cli",
        model: null,
        effort: null,
      };
      const goal = opts.goal ?? `outbox 适配器执行 ${project}/${task}（run=${run}）`;
      const argvDigest = crypto.createHash("sha256").update(JSON.stringify([project, task, run, workspace])).digest("hex");
      const sr = await recordStartRequested(
        { ...target, goal, argv_digest: argvDigest, template_source: "outbox-adapter-cli", timeout_ms: opts.timeoutMs ?? 30 * 60 * 1000 },
        submitter,
        dataDir,
      );
      if (!sr.ok) {
        // 认领已生效但启动请求没落账：认领不能无声丢失——登记 dangling run 如实留现场（§5.4 恢复顺序）
        st.attempts[k] = attempt;
        st.runs[run] = { project, task, attempt, started_at: at, status: "claim_dangling", target };
        st.current = run;
        writeRunState(home, st);
        const reason = `启动请求落账被拒（${(sr as { code?: string }).code ?? "?"}）：${(sr as { message?: string }).message ?? "无消息"}；认领已在服务端生效，run=${run} 已登记为 claim_dangling，恢复时先按 §5.4 核对旧认领`;
        recordReject(home, project, task, reason, at);
        return { ok: false, reason };
      }
      const sd = await recordStarted(
        { ...target, client_version: ADAPTER_VERSION, pid: process.pid, argv_digest: argvDigest, started_at: at },
        submitter,
        dataDir,
      );
      if (!sd.ok) {
        st.attempts[k] = attempt;
        st.runs[run] = { project, task, attempt, started_at: at, status: "claim_dangling", target };
        st.current = run;
        writeRunState(home, st);
        const reason = `启动确认落账被拒（${(sd as { code?: string }).code ?? "?"}）：${(sd as { message?: string }).message ?? "无消息"}；认领已在服务端生效，run=${run} 已登记为 claim_dangling，恢复时先按 §5.4 核对旧认领`;
        recordReject(home, project, task, reason, at);
        return { ok: false, reason };
      }
      st.attempts[k] = attempt;
      st.runs[run] = { project, task, attempt, started_at: at, status: "running", target };
      st.current = run;
      writeRunState(home, st);
      return { ok: true, run, attempt };
    } catch (e) {
      const reason = `真实发起链失败（写服务不可达？）：${(e as Error).message}`;
      recordReject(home, project, task, reason, at);
      return { ok: false, reason };
    }
  }

  st.attempts[k] = attempt;
  st.runs[run] = { project, task, attempt, started_at: at, status: "running" };
  st.current = run;
  writeRunState(home, st);
  return { ok: true, run, attempt };
}

// ── beat/checkpoint/deliver：产出并持久化回执，随后尝试提交 ──────────

/** 键序稳定的序列化（供同键内容比对，不受对象键顺序影响） */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export async function emitReceipt(opts: {
  home: string;
  kind: ReceiptType;
  run: string;
  payloadFile?: string;
  payload?: Record<string, unknown>;
}): Promise<EmitResult> {
  const { home, kind, run } = opts;
  ensureHome(home);
  const regRead = readRunStateDegraded(home);
  const reg = regRead.state.runs[run];
  if (!reg) {
    const degradedNote =
      regRead.degraded === "torn"
        ? "；run-state.json 与 .bak 都损坏，按空态起（坏主文件留证 run-state.json.torn）"
        : regRead.degraded === "bak"
          ? "；run-state.json 已损坏，回退 .bak 后其中没有此 run"
          : "";
    return { ok: false, reason: `未知 run=${run}（本 home 未领取或登记已丢失${degradedNote}）` };
  }

  let payload: Record<string, unknown> = { ...(opts.payload ?? {}) };
  if (opts.payloadFile) {
    try {
      payload = JSON.parse(fs.readFileSync(opts.payloadFile, "utf8")) as Record<string, unknown>;
    } catch (e) {
      return { ok: false, reason: `payload-file 读取失败：${(e as Error).message}` };
    }
  }

  // 负载完整性（checkpoint 必须含 note/artifacts/worktree 全量；heartbeat 含观测时间）
  if (kind === "heartbeat" && !payload.observed_at) payload.observed_at = new Date().toISOString();
  if (kind === "checkpoint") {
    const miss = ["note", "artifacts", "worktree"].filter((x) => !(x in payload));
    if (miss.length) return { ok: false, reason: `checkpoint 负载缺字段：${miss.join("/")}（必须含 note/artifacts/worktree 全量）` };
    const wt = payload.worktree as Record<string, unknown> | undefined;
    const wmiss = ["dirty", "changed_files", "head"].filter((x) => !wt || !(x in wt));
    if (wmiss.length) return { ok: false, reason: `checkpoint.worktree 缺字段：${wmiss.join("/")}` };
  }
  if (kind === "delivery" && !payload.effect_id) return { ok: false, reason: "delivery 负载缺 effect_id" };

  // occurred_at 取原观测时间；幂等键复用该时间，恢复时不得重算
  const occurred_at = String(payload.occurred_at ?? payload.observed_at ?? new Date().toISOString());
  const idempotency_key = `${run}:${kind}:${occurred_at}`;

  // 幂等键冲突守卫：同 run 同类型同观测时间只允许一种负载。
  //   同键同内容 → 幂等重发：不追加台账第二条，复用既有行继续走提交流程（服务端按键去重）；
  //   同键不同内容 → 拒绝并点名冲突：不追加、不覆盖既有台账（否则原回执记录被静默改写、
  //   服务端 409 后留下一条永远无法补交的 pending，恢复每轮空转）。
  const contentOf = (r: { type: string; project: string | null; task: string | null; run: string | null; attempt: number | null; payload: Record<string, unknown> }) =>
    __sha256(stableStringify({ type: r.type, project: r.project, task: r.task, run: r.run, attempt: r.attempt, payload: r.payload }));
  const prior = readReceipts(home).find((x) => x.idempotency_key === idempotency_key);
  let receipt: OutboxReceipt;
  if (prior) {
    if (contentOf(prior) !== contentOf({ type: kind, project: reg.project, task: reg.task, run, attempt: reg.attempt, payload })) {
      return {
        ok: false,
        reason: `幂等键冲突：${idempotency_key} 已登记且负载不同，拒绝追加/覆盖既有台账（同 run 同类型同观测时间只允许一种负载；请用新的观测时间或新 attempt）`,
      };
    }
    receipt = prior;
  } else {
    receipt = {
      type: kind,
      project: reg.project,
      task: reg.task,
      run,
      attempt: reg.attempt,
      payload,
      idempotency_key,
      status: "pending",
      occurred_at,
    };
    appendReceipt(home, receipt);
  }

  const url = serviceUrlOf(home);
  if (url === null) {
    receipt.last_error = "写服务地址未配置，回执留本地待提交";
  } else {
    const s = await submitOf(home, url, receipt);
    if (s.ok) {
      receipt.receipt = s.receipt;
      if (kind === "delivery") {
        // 交付/效果确认：以外部效果核实为准——stub 问夹具口，real 本地按 verify_method 实查；
        // 核实成立才记 confirmed（real 模式还要把 execution.effect_confirmed 补落账）
        const q = await effectQueryOf(home, url, receipt);
        if (q.ok && q.found) {
          if (serviceConfigOf(home).mode === "real") {
            const c = await realConfirmEffect(home, serviceConfigOf(home), receipt, String(q.result_ref ?? ""));
            receipt.status = c.ok ? "confirmed" : "submitted";
            if (!c.ok) receipt.last_error = `效果已核实但确认落账失败（${c.error}）：保持 submitted，下轮按原键补确认`;
          } else {
            receipt.status = "confirmed";
          }
        } else {
          receipt.status = "submitted";
        }
      } else {
        receipt.status = "submitted";
      }
    } else {
      receipt.last_error = s.error;
    }
  }
  updateReceipt(home, idempotency_key, receipt);
  return { ok: true, receipt };
}

// ── recover：新进程仅凭持久材料恢复 ───────────────────────────────────

export async function recover(home: string): Promise<RecoverReport> {
  const url = serviceUrlOf(home);
  const torn = { lines: [] as string[] };
  const list = readReceipts(home, torn);
  if (torn.lines.length) quarantineTorn(home, torn.lines);
  const report: RecoverReport = {
    lines: list.length,
    resubmitted: 0,
    duplicates: 0,
    confirmed: 0,
    unresolved: 0,
    still_pending: 0,
    skipped: 0,
    torn: torn.lines.length,
    missing_target: 0,
    missing_target_runs: [],
  };
  // F-03/F-01（2026-09-21 收口审计）：real 模式的补交必须有 claim 时登记的 ExecutionTarget——
  // run-state 缺它（含撕裂后按空态起）不是"服务不可达"：拒绝盲提交，逐条计 missing_target 并点名 run，
  // 恢复出口据此 exit 2（旧行为是全部 still_pending 却 exit 0，编排会把恢复失败当成功）
  const runReg = serviceConfigOf(home).mode === "real" ? readRunStateDegraded(home) : null;

  for (const r of list) {
    if (!r.idempotency_key || !(LINK_TYPES as readonly string[]).includes(r.type)) {
      report.skipped += 1;
      continue;
    }
    if (r.status === "confirmed") continue;

    if (runReg !== null && runReg.state.runs[r.run ?? ""]?.target === undefined) {
      r.last_error = `${missingTargetError(runReg, r.run)}：拒绝盲提交，先修复 run-state 登记或人工核对`;
      report.missing_target += 1;
      const runId = String(r.run ?? "");
      if (!report.missing_target_runs.includes(runId)) report.missing_target_runs.push(runId);
      writeReceipts(home, list);
      continue;
    }

    if (r.type === "delivery") {
      // 效果确认：先查外部效果是否已生效；查不到或查询报错一律停止盲重放
      if (url === null) {
        r.status = "unresolved";
        r.unresolved_reason = "写服务地址未配置，无法确认外部效果；停止盲重放";
        report.unresolved += 1;
      } else {
        const q = await effectQueryOf(home, url, r);
        if (q.ok && q.found) {
          // §5.4「能够核实已经完成时补交回执」：效果已核实 → 按**原幂等键**把交付回执真正补交到写服务
          // （real 模式：effect_declared/delivered 同键去重补交 + effect_confirmed 补落账），
          // 服务端据此去重/落账完整负载；只在补交成功后才记 confirmed 并附服务端回执。
          const s = await submitOf(home, url, r);
          if (s.ok) {
            let confirmedNow = true;
            let confirmReceipt: unknown = s.receipt;
            if (serviceConfigOf(home).mode === "real") {
              const c = await realConfirmEffect(home, serviceConfigOf(home), r, String(q.result_ref ?? ""));
              confirmedNow = c.ok;
              if (c.ok) confirmReceipt = c.receipt;
              else r.last_error = `效果已核实但确认落账失败（${c.error}）：保持待提交，下轮按原键补确认`;
            }
            if (confirmedNow) {
              r.status = "confirmed";
              r.receipt = confirmReceipt;
              delete r.unresolved_reason;
              delete r.last_error;
              report.confirmed += 1;
            } else {
              report.still_pending += 1;
            }
          } else {
            // 效果已核实但回执补交失败：不记 confirmed、不重放动作，保持待提交由下轮按原键再补
            r.last_error = `外部效果已核实，但交付回执补交失败（${s.error}）；保持待提交，下轮按原键补交`;
            report.still_pending += 1;
          }
        } else if (q.ok && !q.found) {
          r.status = "unresolved";
          r.unresolved_reason = `外部效果核实未生效（${q.error ?? "查无此项"}），无法确认；停止盲重放`;
          report.unresolved += 1;
        } else {
          r.status = "unresolved";
          r.unresolved_reason = `外部效果查询失败（${q.error}），无法确认；停止盲重放`;
          report.unresolved += 1;
        }
      }
      writeReceipts(home, list);
      continue;
    }

    // heartbeat / checkpoint：按**原幂等键**重交，由服务端去重
    if (url === null) {
      r.status = "pending";
      r.last_error = "写服务地址未配置，回执留本地待提交";
      report.still_pending += 1;
      writeReceipts(home, list);
      continue;
    }
    const s = await submitOf(home, url, r);
    if (s.ok) {
      r.status = "submitted";
      r.receipt = s.receipt;
      delete r.last_error;
      report.resubmitted += 1;
      if (s.status === "duplicate") report.duplicates += 1;
    } else {
      r.status = "pending";
      r.last_error = s.error;
      report.still_pending += 1;
    }
    writeReceipts(home, list);
  }
  return report;
}

// ── CLI ───────────────────────────────────────────────────────────────

const USAGE = `outbox 适配层 CLI · 生产接入版（外部协调器侧；塔台唯一写者契约不变：只经本地 submitter 真实 HTTP，语义同 WorkServiceClient.submit）

用法：
  node --import tsx adapter.ts claim   --home <dir> --project <p> --task <t> [--real --workspace <隔离目录> --change <批次 id>] [--goal <人话>] [--timeout-ms <n>] [--owner <id>] [--role <角色>] [--coordinator <id>] [--client <id>]
  node --import tsx adapter.ts beat       --home <dir> --run <r> [--payload-file <f>]
  node --import tsx adapter.ts checkpoint --home <dir> --run <r> [--payload-file <f>]
  node --import tsx adapter.ts deliver    --home <dir> --run <r> [--payload-file <f>]
  node --import tsx adapter.ts recover --home <dir>
  node --import tsx adapter.ts pause   --home <dir> --on|--off

服务模式（<home>/service.json 的 mode 字段；OUTBOX_MODE 覆盖）：
  stub＝本地夹具写服务（{ "mode":"stub", "url":"http://127.0.0.1:<port>" }）；
  real＝塔台真实写服务（{ "mode":"real", "data_dir":"<TATAI_HOME>" }；url 走 work-service.json
        描述符发现，OUTBOX_SERVICE_URL 仅作故障注入测试接缝）。
deliver 的 payload（real 模式）：effect_id 必填；verify_method 形如
  file_sha256:<绝对路径>:<sha256hex>——本地按它核实外部效果，成立才落 execution.effect_confirmed。

退出码：claim 被拒＝1；recover 存在 unresolved 或 missing_target＝2；其它＝0。
互斥：动台账的子命令（claim/beat/checkpoint/deliver/recover/pause）全程持 <home>/outbox.lock；
  活 holder 明确拒（不等不猜），死 holder（pid 已不在）接管并在锁内容留 takeover_from。
持久件：<home>/pending-receipts.jsonl（原子重写＋撕尾容错）、pending-receipts.torn.jsonl（撕裂碎片侧车）、
  channel-state.json（原子重写；读坏 fail-closed 当 paused:true）、
  run-state.json（原子重写＋覆盖前留 .bak；主坏回退 .bak、双坏空态标 torn）、
  run-state.json.bak、run-state.json.torn（坏主文件留证）、service.json、outbox.lock`;

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | boolean> } {
  const [cmd = "", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const valueFlags = new Set(["home", "project", "task", "run", "payload-file", "workspace", "change", "goal", "timeout-ms", "owner", "role", "coordinator", "client"]);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith("--")) continue;
    const name = a.slice(2);
    if (valueFlags.has(name)) flags[name] = rest[++i] ?? "";
    else flags[name] = true;
  }
  return { cmd, flags };
}

async function main(): Promise<void> {
  try {
    await dispatch();
  } catch (e) {
    // 台账真损坏等致命错误：人读原因 + 非零退出，不以堆栈崩溃冒充受控失败
    console.error(`执行失败：${(e as Error).message}`);
    process.exitCode = 2;
  }
}

async function dispatch(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (!cmd || cmd === "help" || cmd === "--help" || flags.help === true) {
    console.log(USAGE);
    return;
  }
  // 退出码统一走 process.exitCode：直接 process.exit() 在 fetch 之后会触发 libuv 断言（Windows）
  const home = String(flags.home ?? "");
  if (!home) {
    console.error("缺 --home <dir>");
    process.exitCode = 2;
    return;
  }
  // F-02（2026-09-21 收口审计）：动台账的子命令全程持 home 级互斥锁——两个进程并发
  // "读全量→整文件重写"会把对方刚追加/复活的行用陈旧清单盖掉（静默丢回执）；
  // 活 holder 明确拒，死 holder（pid 不在）接管并留 takeover_from 记录
  const MUTATING = new Set(["claim", "beat", "checkpoint", "deliver", "recover", "pause"]);
  if (!MUTATING.has(cmd)) {
    console.error(`未知子命令：${cmd}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const lock = acquireLock(home);
  const releaseOnExit = (): void => releaseLock(lock);
  process.on("exit", releaseOnExit); // 兜底清理（正常路径 finally 已放；锁文件残留由死锁接管兜底）
  try {
    await dispatchLocked(cmd, flags, home);
  } finally {
    process.removeListener("exit", releaseOnExit);
    releaseLock(lock);
  }
}

async function dispatchLocked(cmd: string, flags: Record<string, string | boolean>, home: string): Promise<void> {
  if (cmd === "claim") {
    const project = String(flags.project ?? "");
    const task = String(flags.task ?? "");
    if (!project || !task) {
      console.error("claim 需要 --project 与 --task");
      process.exitCode = 2;
      return;
    }
    const r = await claim({
      home,
      project,
      task,
      real: flags.real === true,
      workspace: flags.workspace ? String(flags.workspace) : undefined,
      changeId: flags.change ? String(flags.change) : undefined,
      goal: flags.goal ? String(flags.goal) : undefined,
      timeoutMs: flags["timeout-ms"] ? Number(flags["timeout-ms"]) : undefined,
      ownerId: flags.owner ? String(flags.owner) : undefined,
      role: flags.role ? String(flags.role) : undefined,
      coordinatorId: flags.coordinator ? String(flags.coordinator) : undefined,
      clientId: flags.client ? String(flags.client) : undefined,
    });
    if (!r.ok) {
      console.error(`claim 拒绝：${r.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ ok: true, run: r.run, attempt: r.attempt }));
    return;
  }

  if (cmd === "beat" || cmd === "checkpoint" || cmd === "deliver") {
    const run = String(flags.run ?? "");
    if (!run) {
      console.error(`${cmd} 需要 --run`);
      process.exitCode = 2;
      return;
    }
    const kind: ReceiptType = cmd === "beat" ? "heartbeat" : cmd === "deliver" ? "delivery" : "checkpoint";
    const r = await emitReceipt({
      home,
      kind,
      run,
      payloadFile: flags["payload-file"] ? String(flags["payload-file"]) : undefined,
    });
    if (!r.ok) {
      console.error(`回执未产出：${r.reason}`);
      process.exitCode = 2;
      return;
    }
    console.log(
      JSON.stringify({ type: r.receipt?.type, status: r.receipt?.status, idempotency_key: r.receipt?.idempotency_key, last_error: r.receipt?.last_error ?? null }),
    );
    return;
  }

  if (cmd === "recover") {
    const rep = await recover(home);
    console.log(JSON.stringify(rep));
    // exit 2 语义（F-03 联动）：效果不可确认（unresolved）或 run-state 缺 ExecutionTarget（missing_target）都是恢复未完成
    process.exitCode = rep.unresolved > 0 || rep.missing_target > 0 ? 2 : 0;
    return;
  }

  if (cmd === "pause") {
    const on = flags.on === true;
    const off = flags.off === true;
    if (on === off) {
      console.error("pause 需要恰一个 --on 或 --off");
      process.exitCode = 2;
      return;
    }
    console.log(JSON.stringify(await setPaused(home, on)));
    return;
  }

  // dispatch 已在持锁前拦下未知子命令；这里是防御兜底（不静默当成功）
  console.error(`未知子命令：${cmd}\n${USAGE}`);
  process.exitCode = 2;
}

function invokedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(path.resolve(entry)).href === import.meta.url || /[\\/]adapter\.ts$/.test(entry);
  } catch {
    return /[\\/]adapter\.ts$/.test(entry);
  }
}

if (invokedAsCli()) void main();

// 供测试引用，确保 import 不触发 CLI
export const __selfPath = fileURLToPath(import.meta.url);
// 注意必须用提升的函数声明：CLI 入口在模块求值途中就会同步走到 emitReceipt 的同键内容比对，
// const 箭头那时还在 TDZ（实测报 "Cannot access '__sha256' before initialization"）
export function __keyOf(run: string, type: ReceiptType, occurredAt: string): string {
  return `${run}:${type}:${occurredAt}`;
}
export function __sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}
