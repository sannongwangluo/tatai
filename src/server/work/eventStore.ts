// 事件落盘与重放（PLAN.md V06-01，DESIGN.md §2.6）。
//
// 本层是**纯文件系统层**：入参是一个 `work/` 目录（`<项目根>/.工作台/work/`），
// 不认项目 id、不读注册表——路径解析在 workstation.ts，仲裁与传输在 service.ts。
// 这样"重放能不能得到同一份状态"可以用一个临时目录直接验证，不必起服务。
//
// 落盘顺序（DESIGN.md §2.6，硬口径）：
//   校验 → 追加完整事件并持久化（fsync）→ 返回提交序号 → 更新投影
// 投影失败可重放修复，但**不能撤销已经回执成功的事实**——所以本文件里
// 投影失败只记 `projection-error.json`，绝不回删事件。
//
// 残缺尾行（半截 JSON，上次写到一半被 kill）与中段损坏是两回事，处理方式相反：
//   · 残缺尾行：只在**恢复校验**（写入路径 / 显式 recover）时隔离到 quarantine/ 并记一行
//     recovery.jsonl，然后把文件截回最后一个完整行——绝不粘行、绝不静默删；
//   · 中段损坏：任何读路径都**直接抛 MIDDLE_CORRUPT**（带行号），不跳过、不当没看见。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { iterFileLines } from "../lineStream";
import { nowIso } from "../time";
import { LEDGER_FILE_NAME, readLedger, type LedgerRead } from "./ledgerRead";
import {
  FOLD_RULES_VERSION,
  LEDGER_CONTENT_SCHEMA,
  SCHEMA_VERSION,
  WorkError,
  validateWorkEvent,
  type FoldBase,
  type LedgerContentFingerprint,
  type LedgerPrefixProof,
  type SnapshotSourceFingerprint,
  type WorkEntityState,
  type WorkEvent,
  type WorkSnapshot,
} from "./types";

// 账本内容身份/前缀证明/折叠基线/规则版本是**形状**，事实源在 `types.ts`（读层与类型层共用，
// 避免 `eventStore ⇄ 读缓存` 的循环依赖）。这里照旧再导出，保持既有 import 面不变。
export type { FoldBase, LedgerContentFingerprint, LedgerPrefixProof, SnapshotSourceFingerprint };
export { FOLD_RULES_VERSION, LEDGER_CONTENT_SCHEMA };

export const EVENTS_FILE = LEDGER_FILE_NAME;
export const STATE_FILE = "state.json";
export const RECOVERY_FILE = "recovery.jsonl";
export const PROJECTION_ERROR_FILE = "projection-error.json";
export const QUARANTINE_DIR = "quarantine";

export const eventsPath = (workDir: string): string => path.join(workDir, EVENTS_FILE);
export const statePath = (workDir: string): string => path.join(workDir, STATE_FILE);
export const recoveryPath = (workDir: string): string => path.join(workDir, RECOVERY_FILE);
export const projectionErrorPath = (workDir: string): string =>
  path.join(workDir, PROJECTION_ERROR_FILE);
export const quarantineDir = (workDir: string): string => path.join(workDir, QUARANTINE_DIR);

/** 一条读不出来的行（尾行半截或中段损坏），带出错时的行号与原文片段 */
export interface CorruptLine {
  line: number;
  raw: string;
  reason: string;
}

export interface LoadedEvents {
  events: WorkEvent[];
  /**
   * 文件**未以换行收尾**时的最后一行（半截行）。它是"上次写入被打断"的现场，
   * 不是一条事件：读路径如实报出，等写入路径或显式 recover 去隔离。
   */
  tail: CorruptLine | null;
}

const RAW_KEEP_CHARS = 200;

/** 文件是否未以 `\n` 收尾（= 尾部有半截行）。不存在/空文件都算"没有半截尾" */
export function hasPartialTail(file: string): boolean {
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return false;
    const fd = fs.openSync(file, "r");
    try {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      return last[0] !== 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * 读全部事件（**生产读口**：有界内容核验解析缓存 + 合法追加只解析后缀，V09-38 复审修正）。
 *
 * 这里不再是"每次重读重解析"，而是委派给 `ledgerRead.readLedger`：每次现读真实字节做 sha256 核验，
 * 摘要对上才复用已解析事件、只解析追加的后缀；核验不过一律全量。返回的**语义**与 `loadEventsFull`
 * 完全一致（同一组事件、同一种半截尾、同一种 `MIDDLE_CORRUPT`）——差别只在代价。
 *
 * 修改兼容性：返回的**数组**是独立切片，调用方可以照旧 `push`/替换元素；元素是缓存内的权威对象
 * （深冻结），只读。已核对全部生产调用点（statusProjection / tasks / claims / sync / audit / evidence /
 * executionReceipts / requirements / usage / service / backup / changes / migrate / mcp syncEvidence /
 * scripts/outbox）均为只读消费（`[...events]` 拷贝、fold、find/filter），无原地改事件对象者。
 */
export function loadEvents(workDir: string): LoadedEvents {
  const read = readLedger(workDir);
  return { events: read.events, tail: read.tail };
}

/**
 * **全量 oracle**（原 `loadEvents` 实现原样保留，V09-38）：逐行流式全量解析，不查任何缓存。
 * 测试用它做逐对象对照；生产读路径走 `loadEvents`。两者对同一份账本必须给同一组事件。
 *
 * 抛错口径：任何**非尾行**的损坏都抛 `MIDDLE_CORRUPT`（带行号、原文片段、原因），
 * 让"中间坏了却继续绿灯"不可能发生。尾行半截不抛，塞进返回值的 `tail`。
 */
export function loadEventsFull(workDir: string): LoadedEvents {
  const file = eventsPath(workDir);
  if (!fs.existsSync(file)) return { events: [], tail: null };

  const partial = hasPartialTail(file);
  const events: WorkEvent[] = [];
  const corrupt: CorruptLine[] = [];
  let lastLineNo = 0;

  for (const line of iterFileLines(file)) {
    lastLineNo++;
    const text = line.trim();
    if (text === "") continue;
    try {
      events.push(validateWorkEvent(JSON.parse(text)));
    } catch (e) {
      corrupt.push({
        line: lastLineNo,
        raw: text.slice(0, RAW_KEEP_CHARS),
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 只有"最后一行 + 文件未以换行收尾"才是可容忍的半截尾；其余位置一律暴露
  let tail: CorruptLine | null = null;
  if (partial && corrupt.length > 0 && corrupt[corrupt.length - 1].line === lastLineNo) {
    tail = corrupt.pop() ?? null;
  }
  if (corrupt.length > 0) {
    const first = corrupt[0];
    throw new WorkError(
      "MIDDLE_CORRUPT",
      `事件文件中段损坏，塔台拒绝跳过：${EVENTS_FILE} 第 ${first.line} 行不是合法事件（${first.reason}）。` +
        `共 ${corrupt.length} 处；请先核对现场再从最后一个完整事件之后重建，不要手工删中间行`,
      { file: EVENTS_FILE, line: first.line, reason: first.reason, count: corrupt.length },
    );
  }
  return { events, tail };
}

/**
 * 隔离半截尾行（**只读路径不调用它**，由写入路径或显式 recover 触发）：
 * 把半截原始字节复制进 `quarantine/`、记一行 `recovery.jsonl`、再把 events.jsonl 截回最后一个完整行。
 * 三个动作都不丢字节：隔离副本保留原文与哈希，截断只截掉"从来没成为事件"的那半行。
 */
export function recoverTail(workDir: string): { quarantined: string[] } {
  const file = eventsPath(workDir);
  if (!fs.existsSync(file) || !hasPartialTail(file)) return { quarantined: [] };

  const size = fs.statSync(file).size;
  const tailStart = lastNewlineEnd(file, size);
  if (tailStart >= size) return { quarantined: [] };

  const fd = fs.openSync(file, "r");
  let raw: Buffer;
  try {
    raw = Buffer.alloc(size - tailStart);
    fs.readSync(fd, raw, 0, raw.length, tailStart);
  } finally {
    fs.closeSync(fd);
  }
  fs.truncateSync(file, tailStart);

  const dir = quarantineDir(workDir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, "-");
  const name = `events-tail-${stamp}-${crypto.randomBytes(3).toString("hex")}.jsonl`;
  const dest = path.join(dir, name);
  fs.writeFileSync(dest, raw);

  appendRecovery(workDir, {
    action: "tail_quarantined",
    file: EVENTS_FILE,
    bytes: raw.length,
    sha256: crypto.createHash("sha256").update(raw).digest("hex"),
    quarantine: path.join(QUARANTINE_DIR, name),
    truncated_to: tailStart,
  });
  return { quarantined: [dest] };
}

/** 从文件末尾往回找最后一个 `\n` 之后的位置（= 最后一个完整行的结束偏移） */
function lastNewlineEnd(file: string, size: number): number {
  const fd = fs.openSync(file, "r");
  try {
    const chunk = 64 * 1024;
    const buf = Buffer.allocUnsafe(chunk);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunk);
      const n = fs.readSync(fd, buf, 0, end - start, start);
      for (let i = n - 1; i >= 0; i--) {
        if (buf[i] === 0x0a) return start + i + 1;
      }
      end = start;
    }
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

/** 追加一行恢复记录（只追加；恢复动作本身也要留痕） */
function appendRecovery(workDir: string, record: Record<string, unknown>): void {
  fs.mkdirSync(workDir, { recursive: true });
  const line = JSON.stringify({ ts: nowIso(), ...record }) + "\n";
  fs.appendFileSync(recoveryPath(workDir), line, "utf8");
}

/**
 * 追加一条事件并**在返回前落盘**（fsync，DESIGN.md §2.6 落盘顺序）。
 *
 * 追加前先把半截尾处理掉（隔离+记录+截断）：裸 append 会把新记录粘在残尾后面，
 * 两条一起变坏——这是仓库里 gate.jsonl/changes.jsonl 已经踩过同类坑的同款防线。
 */
export function appendEventDurable(workDir: string, event: WorkEvent): void {
  fs.mkdirSync(workDir, { recursive: true });
  const file = eventsPath(workDir);
  if (hasPartialTail(file)) recoverTail(workDir);
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, JSON.stringify(event) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 单条事件折叠进「中间态」：seq 从 1 起严格 +1、同实体 revision 严格 +1、幂等键唯一——
 * 三项结构不变量，任一不成立即抛（**不降级成"看起来没事"**）。
 *
 * `replayEvents`（从头全量折）与 V09-38 的增量续折共用这一处判据：只有"从已证明的基线接着折"
 * 与"从头重折"走同一条路，增量结果才可能与全量 oracle 逐对象一致。
 */
interface FoldState {
  entities: Record<string, WorkEntityState>;
  seenKeys: Map<string, number>;
  lastSeq: number;
  /** 幂等键表是否覆盖全部已折事件（跨进程从 state.json 复用时为 false） */
  seenKeysComplete: boolean;
}

function emptyFoldState(): FoldState {
  return { entities: {}, seenKeys: new Map(), lastSeq: 0, seenKeysComplete: true };
}

function foldEventInto(state: FoldState, e: WorkEvent): void {
  if (e.seq !== state.lastSeq + 1) {
    throw new WorkError(
      "EVENT_INVALID",
      `事件 seq 不连续：期望 ${state.lastSeq + 1}，实际 ${e.seq}（事件 ${e.event_id}）。` +
        "seq 有洞说明丢过完整事件，不能当作正常状态继续",
      { expected: state.lastSeq + 1, got: e.seq, event_id: e.event_id },
    );
  }
  const prev = state.entities[e.entity_id];
  const expectedRev = (prev?.revision ?? 0) + 1;
  if (e.entity_revision !== expectedRev) {
    throw new WorkError(
      "EVENT_INVALID",
      `实体 ${e.entity_id} 的 revision 不连续：期望 ${expectedRev}，实际 ${e.entity_revision}（事件 ${e.event_id}）`,
      { entity_id: e.entity_id, expected: expectedRev, got: e.entity_revision },
    );
  }
  const dupKey = state.seenKeys.get(e.idempotency_key);
  if (dupKey !== undefined) {
    throw new WorkError(
      "EVENT_INVALID",
      `幂等键在事件文件里出现两次：${e.idempotency_key}（第 ${dupKey} 与第 ${e.seq} 序号）——说明有写入绕过了幂等检查`,
      { idempotency_key: e.idempotency_key, at_seq: dupKey, again_at_seq: e.seq },
    );
  }
  state.seenKeys.set(e.idempotency_key, e.seq);

  state.entities[e.entity_id] = {
    revision: e.entity_revision,
    type: e.type,
    last_event_id: e.event_id,
    updated_at: e.received_at,
    payload: e.payload,
  };
  state.lastSeq = e.seq;
}

/**
 * 重放事件得到状态（DESIGN.md §2.6：`state.json` 为带 `last_seq` 的可重建快照）。
 *
 * 除逐条事件自校验外，这里还核对结构不变量——任一不成立都抛（**不降级成"看起来没事"**）：
 *   · seq 从 1 起严格 +1（无洞、无重号）：有洞说明丢过完整事件，必须停下来查现场；
 *   · 同一实体 revision 严格 +1；
 *   · 幂等键在本项目内唯一（重复出现说明写入端绕过了幂等检查）。
 */
export function replayEvents(events: readonly WorkEvent[]): {
  entities: Record<string, WorkEntityState>;
  last_seq: number;
} {
  const state = emptyFoldState();
  for (const e of events) foldEventInto(state, e);
  return { entities: state.entities, last_seq: state.lastSeq };
}

/** 由事件构造快照（纯函数；`projection_error` 非空 = 这份快照已知落后于事件） */
export function buildSnapshot(
  projectId: string,
  events: WorkEvent[],
  projectionError: string | null = null,
  generatedAt: string = nowIso(),
): WorkSnapshot {
  const { entities, last_seq } = replayEvents(events);
  return {
    schema_version: SCHEMA_VERSION,
    project_id: projectId,
    last_seq,
    generated_at: generatedAt,
    entities,
    projection_error: projectionError,
  };
}

// ── V09-38：内容证明后的可验证增量折叠 / 快照复用（契约 U1/U2；DESIGN §6.8） ──
//
// `LedgerContentFingerprint` / `LedgerPrefixProof` / `FoldBase` 三个类型的定义在 `types.ts`
// （读层与类型层共用，避免循环依赖）。它们只描述「账本字节现在是什么」与「哪一段事件已经被折过」，
// 都**不是**"当前有效"的证明，也**不是**事实源——只允许加速派生。放行判据建立在**本次实际内容哈希**之上。

export interface SnapshotReuseInput {
  /** 本次现读的账本内容身份 */
  content: LedgerContentFingerprint;
  /** 可续折的基线；没有就给 null（走全量重折） */
  base: FoldBase | null;
  /** 本次现读算出的前缀字节证明；没有就给 null（走全量重折） */
  proof: LedgerPrefixProof | null;
}

export type FoldReuseDecision =
  | { ok: true; folded_events: number }
  | { ok: false; reason: string };

/**
 * 判定"能否拿 base 续折"——**只认内容证明**，任一条件不成立一律返回不可复用（调用方走全量）。
 * 这是 V09-38 里"可验证"的落点：不靠调用方口头保证，靠字节摘要 + 事件边界两处硬核对。
 */
export function decideFoldReuse(
  base: FoldBase | null | undefined,
  events: readonly WorkEvent[],
  proof: LedgerPrefixProof | null | undefined,
  content: LedgerContentFingerprint,
): FoldReuseDecision {
  if (base === null || base === undefined) return { ok: false, reason: "no_base" };
  if (proof === null || proof === undefined) return { ok: false, reason: "no_prefix_proof" };
  if (!Number.isInteger(base.folded_events) || base.folded_events < 0 || base.folded_events > events.length) {
    return { ok: false, reason: "base_length_out_of_range" };
  }
  // 跨进程快照复用的基线拿不到前缀幂等键（快照不存这类事实）：只允许"折叠 0 条"，一旦要折新事件就回全量
  if (base.seen_keys_complete === false && base.folded_events < events.length) {
    return { ok: false, reason: "incomplete_seen_keys" };
  }
  if (proof.file_bytes !== content.file_bytes) return { ok: false, reason: "proof_content_diverged" };
  if (proof.prefix_bytes !== base.content.verified_bytes) return { ok: false, reason: "prefix_bytes_mismatch" };
  if (proof.prefix_sha256 !== base.content.prefix_sha256) return { ok: false, reason: "prefix_sha256_mismatch" };
  if (proof.file_bytes < base.content.verified_bytes) return { ok: false, reason: "file_shrank" };
  if (content.verified_bytes < base.content.verified_bytes) return { ok: false, reason: "content_shrank" };
  if (base.folded_events > 0) {
    const boundary = events[base.folded_events - 1];
    if (boundary === undefined) return { ok: false, reason: "boundary_missing" };
    if (boundary.seq !== base.last_seq) return { ok: false, reason: "boundary_seq_mismatch" };
    if (boundary.event_id !== base.last_event_id) return { ok: false, reason: "boundary_event_mismatch" };
  }
  return { ok: true, folded_events: base.folded_events };
}

export interface SnapshotReuseResult {
  snapshot: WorkSnapshot;
  origin: "full" | "incremental";
  /** 复用为基线的事件条数 */
  reused_events: number;
  /** 本次真正折叠的事件条数 */
  folded_events: number;
  /** 回退全量的原因（增量时为 null） */
  reason: string | null;
  /** 最新折叠态（可重建派生物；供缓存层作为下一次续折的基线） */
  base: FoldBase;
}

/**
 * 与 `buildSnapshot` 同义的快照构造，但允许在**内容证明成立**时只折叠新增后缀（V09-38）。
 *
 * 证明不成立（基线缺失、前缀摘要不符、事件边界对不上、文件变短/被替换）→ **等价于全量**：
 * 从头重折，结果与 `buildSnapshot` 逐对象一致。证明成立时也只折叠 `events[reused..]`，
 * 前缀沿用基线——因为前缀字节已由 `proof` 证明未变，且边界事件（seq + event_id）双重指认。
 */
export function buildSnapshotReusing(
  projectId: string,
  events: readonly WorkEvent[],
  reuse: SnapshotReuseInput,
  projectionError: string | null = null,
  generatedAt: string = nowIso(),
): SnapshotReuseResult {
  const decision = decideFoldReuse(reuse.base, events, reuse.proof, reuse.content);
  const state = emptyFoldState();
  let origin: "full" | "incremental";
  let reusedEvents: number;
  let foldedEvents: number;
  let reason: string | null;

  if (decision.ok && reuse.base !== null) {
    const base = reuse.base;
    // **深隔离到实体壳层**：每个实体都新建一个壳，调用方改写 `snapshot.entities[x]` 或
    // `base.entities[x]`（增删键/改 revision）都碰不到传入基线和缓存。payload 仍共享——
    // 缓存路径的 payload 已深冻结，磁盘路径在建基线时也会冻结，改它会抛错而不是静默污染。
    state.entities = isolateEntityStates(base.entities);
    state.lastSeq = base.last_seq;
    state.seenKeysComplete = base.seen_keys_complete !== false;
    reusedEvents = decision.folded_events;
    foldedEvents = events.length - decision.folded_events;
    // 幂等键表一律复制：即使"没有新增可折"也不与传入基线共享同一 Map，避免外部经
    // `peekLedgerEntry` 等拿到 Map 后写入污染后续快照（V09-38 复审：Map 隔离）。
    state.seenKeys = new Map(base.seen_keys);
    if (foldedEvents > 0) {
      for (let i = decision.folded_events; i < events.length; i++) foldEventInto(state, events[i]!);
    }
    origin = "incremental";
    reason = null;
  } else {
    reusedEvents = 0;
    foldedEvents = events.length;
    for (const e of events) foldEventInto(state, e);
    origin = "full";
    reason = decision.ok ? "no_base" : decision.reason;
  }

  const snapshot: WorkSnapshot = {
    schema_version: SCHEMA_VERSION,
    project_id: projectId,
    last_seq: state.lastSeq,
    generated_at: generatedAt,
    entities: state.entities,
    projection_error: projectionError,
  };
  // 基线是**缓存私有**的续折状态：这里做一层**浅隔离**（每实体一个新壳，payload 仍共享），
  // 使调用方改 `snapshot.entities[x]` 或增删键都碰不到后续复用。深拷贝整份实体字典没必要，
  // 也会把增量省下的开销吃回去；payload 在缓存路径上是深冻结的，改它会抛错而不是静默污染。
  const base: FoldBase = {
    content: reuse.content,
    folded_events: events.length,
    last_seq: state.lastSeq,
    last_event_id: events[events.length - 1]?.event_id ?? null,
    entities: isolateEntityStates(state.entities),
    seen_keys: state.seenKeys,
    ...(state.seenKeysComplete ? {} : { seen_keys_complete: false }),
  };
  return { snapshot, origin, reused_events: reusedEvents, folded_events: foldedEvents, reason, base };
}

/** 浅隔离实体字典：每实体一个新壳（字段值共享；payload 视为不可变），调用方改写碰不到缓存基线 */
function isolateEntityStates(
  entities: Record<string, WorkEntityState>,
): Record<string, WorkEntityState> {
  const out: Record<string, WorkEntityState> = {};
  for (const key of Object.keys(entities)) {
    const e = entities[key]!;
    out[key] = {
      revision: e.revision,
      type: e.type,
      last_event_id: e.last_event_id,
      updated_at: e.updated_at,
      payload: e.payload,
    };
  }
  return out;
}

/** 写快照（原子：临时文件 + rename；快照是派生数据，不需要 fsync） */
export function writeSnapshot(workDir: string, snapshot: WorkSnapshot): void {
  fs.mkdirSync(workDir, { recursive: true });
  const file = statePath(workDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/** 读磁盘上的快照；不存在/不合法返回 null（调用方按"未知"处理，不假装是空状态） */
export function readSnapshotFromDisk(workDir: string): WorkSnapshot | null {
  const file = statePath(workDir);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as WorkSnapshot;
    if (raw?.schema_version !== SCHEMA_VERSION || typeof raw.last_seq !== "number") return null;
    return raw;
  } catch {
    return null;
  }
}

// ── V09-38 复审：跨进程持久增量的**写方接口**与**读方核验**（本轮不接 service；见增量复审报告） ──
//
// 契约 U2 明令：`last_seq` 不能当内容证明，缺失/不可信必须 full。所以磁盘快照只允许携带
// `SnapshotSourceFingerprint`（本次现读账本的内容身份 + 边界事件 + 规则版本），读侧一律**按当前现读账本**
// 重算核对后才复用。写方（`service.ts` 的唯一写宿主）接线方式——**只读一次 `readLedger`**：
//
//   const read = readLedger(workDir);                 // 一次现读：events 与 content 同源
//   const snapshot = buildSnapshot(projectId, read.events, null);
//   snapshot.source_fp = snapshotSourceFingerprintOf(read, snapshot);
//   writeSnapshot(workDir, snapshot);
//
// 注意：不能像旧报告示例那样 `loadEvents` 再 `readLedger` 各读一次，再拿两次结果拼证明（"假称同次"）。
// 读侧还有一道独立闸门：`verifySnapshotEntities` 用 canonical replay 核验磁盘 `entities`，防止只改派生
// 派生物的篡改（见 `snapshotBaseFromDisk`）。本卡不改 `service.ts`，故写侧接线仍待根代理；在此之前
// `state.json` 不带 `source_fp`，读侧一律走全量——不会把未核验的旧快照当事实。

/**
 * 写方用：按**当前现读账本内容身份**生成一份快照来源证明（不读盘、不调模型、零副作用）。
 *
 * 推荐调用是传**一次 `readLedger` 的结果**（`events` 与 `content` 只能来自同一次读）：
 * `snapshotSourceFingerprintOf(read, snapshot)`。旧报告的示例是 `loadEvents` 与 `readLedger`
 * 各读一次再拼起来——那会"假称同次"，已改正为单次 `readLedger`。
 *
 * 为兼容既有调用（含 root 反例 probe）仍保留 `(content, events, snapshot)` 三元形式：调用方
 * **必须**保证 `content` 与 `events` 来自同一次读；这不是运行时能替调用方证明的。
 */
export function snapshotSourceFingerprintOf(
  read: Pick<LedgerRead, "content" | "events">,
  snapshot: Pick<WorkSnapshot, "last_seq" | "entities">,
): SnapshotSourceFingerprint;
export function snapshotSourceFingerprintOf(
  content: LedgerContentFingerprint,
  events: readonly WorkEvent[],
  snapshot: Pick<WorkSnapshot, "last_seq" | "entities">,
): SnapshotSourceFingerprint;
export function snapshotSourceFingerprintOf(
  contentOrRead: LedgerContentFingerprint | Pick<LedgerRead, "content" | "events">,
  eventsOrSnapshot: readonly WorkEvent[] | Pick<WorkSnapshot, "last_seq" | "entities">,
  maybeSnapshot?: Pick<WorkSnapshot, "last_seq" | "entities">,
): SnapshotSourceFingerprint {
  let content: LedgerContentFingerprint;
  let events: readonly WorkEvent[];
  let snapshot: Pick<WorkSnapshot, "last_seq" | "entities">;
  if (maybeSnapshot === undefined) {
    const read = contentOrRead as Pick<LedgerRead, "content" | "events">;
    content = read.content;
    events = read.events;
    snapshot = eventsOrSnapshot as Pick<WorkSnapshot, "last_seq" | "entities">;
  } else {
    content = contentOrRead as LedgerContentFingerprint;
    events = eventsOrSnapshot as readonly WorkEvent[];
    snapshot = maybeSnapshot;
  }
  return {
    schema: LEDGER_CONTENT_SCHEMA,
    file_bytes: content.file_bytes,
    verified_bytes: content.verified_bytes,
    prefix_sha256: content.prefix_sha256,
    folded_events: events.length,
    last_seq: snapshot.last_seq,
    last_event_id: events[events.length - 1]?.event_id ?? null,
    fold_rules_version: FOLD_RULES_VERSION,
  };
}

export type SnapshotSourceVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * 派生实体核验结果：通过时一并给出**规范重放得到的实体**（可信、可直接当基线），
 * 避免调用方为了拿实体再折一次。
 */
export type SnapshotEntityVerdict =
  | { ok: true; entities: Record<string, WorkEntityState>; last_seq: number }
  | { ok: false; reason: string };

/**
 * 读方用：核验一份磁盘快照的来源证明能否对**本次现读账本**复用。
 * 只认内容证明 + 边界事件 + 规则版本；任一不成立一律 `ok:false`（调用方回退全量）。
 * 这里只做判断，不做 IO；具体的基线构造在快照层（`eventReadCache.snapshotBaseFromDisk`）。
 */
export function verifySnapshotSource(
  snapshot: WorkSnapshot | null | undefined,
  content: LedgerContentFingerprint,
  projectId: string,
): SnapshotSourceVerdict {
  if (snapshot === null || snapshot === undefined) return { ok: false, reason: "no_snapshot" };
  if (snapshot.project_id !== projectId) return { ok: false, reason: "project_mismatch" };
  const fp = snapshot.source_fp;
  if (fp === null || fp === undefined) return { ok: false, reason: "missing_source_fp" };
  if (fp.schema !== LEDGER_CONTENT_SCHEMA) return { ok: false, reason: "schema_mismatch" };
  if (fp.fold_rules_version !== FOLD_RULES_VERSION) return { ok: false, reason: "fold_rules_changed" };
  if (!Number.isInteger(fp.folded_events) || fp.folded_events < 0) {
    return { ok: false, reason: "folded_events_invalid" };
  }
  if (fp.file_bytes !== content.file_bytes) return { ok: false, reason: "file_bytes_mismatch" };
  if (fp.verified_bytes !== content.verified_bytes) return { ok: false, reason: "verified_bytes_mismatch" };
  if (fp.prefix_sha256 !== content.prefix_sha256) return { ok: false, reason: "prefix_sha256_mismatch" };
  if (fp.last_seq !== snapshot.last_seq) return { ok: false, reason: "last_seq_mismatch" };
  // 边界事件指认（第 folded_events 条事件的 event_id）需要账本事件，由快照层拿到 `events` 后完成。
  return { ok: true };
}

/** 稳定序列化（键排序）：用于把"规范重放的实体"与"磁盘快照实体"做逐字段比较 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

/**
 * 读方用：核验磁盘快照的**派生实体**能否与**本次现读账本的规范重放**逐对象一致。
 *
 * 这是 V09-38 复审点名的漏洞的落点：`source_fp` 只证明"账本字节没变"，**不证明** `state.json`
 * 里的 `entities` 就是这份账本的投影——保留 `source_fp`、只改 payload / 增删实体 / 改 revision
 * 的篡改必须被拒。因此首次把磁盘快照当续折基线前，必须做一次 canonical replay（含 seq 连续、
 * entity_revision 连续、幂等键唯一这三项结构不变量；任一不成立 `replayEvents` 会抛，这里转成拒绝原因），
 * 再与磁盘实体逐字段比较。**不用**同文件自报的任何 `state_sha`——那只能自证，证不了内容。
 *
 * 代价如实：这一步就是一次全量折叠。所以它**不是省解析**的手段，而是"能不能信这份磁盘派生"的
 * 正确性闸门；通不过就明确拒绝，由调用方回退全量。
 */
export function verifySnapshotEntities(
  snapshot: WorkSnapshot | null | undefined,
  events: readonly WorkEvent[],
): SnapshotEntityVerdict {
  if (snapshot === null || snapshot === undefined) return { ok: false, reason: "no_snapshot" };
  const entities = snapshot.entities;
  if (entities === null || typeof entities !== "object" || Array.isArray(entities)) {
    return { ok: false, reason: "snapshot_entities_invalid" };
  }
  let canonical: { entities: Record<string, WorkEntityState>; last_seq: number };
  try {
    canonical = replayEvents(events);
  } catch {
    // 账本本身违反结构不变量（seq/实体 revision 不连续、幂等键重复）→ 不能信它派生出的任何快照
    return { ok: false, reason: "snapshot_structure_invalid" };
  }
  if (canonical.last_seq !== snapshot.last_seq) return { ok: false, reason: "snapshot_last_seq_mismatch" };
  const wantKeys = Object.keys(canonical.entities).sort();
  const gotKeys = Object.keys(entities).sort();
  if (wantKeys.length !== gotKeys.length) return { ok: false, reason: "snapshot_entities_key_mismatch" };
  for (let i = 0; i < wantKeys.length; i++) {
    if (wantKeys[i] !== gotKeys[i]) return { ok: false, reason: "snapshot_entities_key_mismatch" };
  }
  for (const key of wantKeys) {
    const want = canonical.entities[key]!;
    const got = (entities as Record<string, unknown>)[key];
    if (got === null || typeof got !== "object") return { ok: false, reason: "snapshot_entity_invalid" };
    if (stableStringify(want) !== stableStringify(got)) {
      return { ok: false, reason: "snapshot_entity_mismatch" };
    }
  }
  // 核验通过：返回**规范重放的实体**（不是磁盘原件）——它由账本重新派生，可信；调用方拿它当基线。
  return { ok: true, entities: canonical.entities, last_seq: canonical.last_seq };
}

/** 深冻结派生实体（磁盘快照路径用）：冻结后共享 payload 不可能被外部改写 */
export function freezeEntityStates(entities: Record<string, WorkEntityState>): Record<string, WorkEntityState> {
  for (const key of Object.keys(entities)) {
    const e = entities[key];
    if (e !== undefined) freezeEntityState(e);
  }
  return Object.freeze(entities);
}

function freezeEntityState(e: WorkEntityState): void {
  if (!Object.isFrozen(e.payload)) {
    Object.freeze(e.payload);
    for (const key of Object.keys(e.payload)) {
      const v = e.payload[key];
      if (v !== null && typeof v === "object" && !Object.isFrozen(v)) Object.freeze(v);
    }
  }
  Object.freeze(e);
}

/** 记下"投影失败"（事件已提交但快照没跟上）；空 error 表示清除该标记 */
export function writeProjectionError(workDir: string, info: { error: string; last_seq: number } | null): void {
  const file = projectionErrorPath(workDir);
  if (info === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ts: nowIso(), ...info }, null, 2) + "\n", "utf8");
}

/** 读投影失败标记；没有/不合法返回 null */
export function readProjectionError(
  workDir: string,
): { ts: string; error: string; last_seq: number } | null {
  const file = projectionErrorPath(workDir);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      ts?: string;
      error?: string;
      last_seq?: number;
    };
    if (typeof raw.error !== "string" || typeof raw.last_seq !== "number") return null;
    return { ts: raw.ts ?? "", error: raw.error, last_seq: raw.last_seq };
  } catch {
    return null;
  }
}

/**
 * 重放修复：以事件文件为唯一事实源重建快照，成功后清掉投影失败标记。
 * 不触碰事件文件——修复的是派生数据，不是事实。
 */
export function rebuildSnapshot(workDir: string, projectId: string): WorkSnapshot {
  const { events, tail } = loadEvents(workDir);
  if (tail) recoverTail(workDir);
  const snapshot = buildSnapshot(projectId, events, null);
  writeSnapshot(workDir, snapshot);
  writeProjectionError(workDir, null);
  return snapshot;
}
