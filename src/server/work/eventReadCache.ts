// V09-38 复审修正：快照层——**可验证的** buildSnapshot 增量复用 + 跨进程快照基线的核验。
//
// 读取（内容验证 / 有界解析缓存 / 仅解析后缀）已经抽到纯模块 `ledgerRead.ts`；本模块只做两件事：
//   1. `snapshotFromLedger`：把一次现读的账本交给 `buildSnapshotReusing`，增量折叠可复用的前缀，
//      复用不成立就等价于全量。折叠基线由 `ledgerRead` 的缓存条目私有持有，本模块只推进它。
//   2. `snapshotBaseFromDisk`：把磁盘 `state.json`（若带 `source_fp` 来源证明）**按本次现读账本核验后**
//      当作续折基线；缺失 / 伪造 / schema 变 / 规则变 / 边界不符 / **派生实体被篡改** → 一律不给基线
//      （调用方全量重折）。核验含一次 canonical replay（见 `verifySnapshotEntities`）。
//
// 关于"只折 0 条"：来源指纹（`source_fp`）只证明"账本字节没变"，**不证明** `state.json.entities` 就是
// 这份账本的投影——保留指纹只改 payload/revision/增删实体都能骗过它。所以磁盘基线在采用前必须做一次
// canonical replay 核验实体/结构/幂等不变量，并把**规范重放得到的实体**（不是磁盘原件）当基线；本次
// 现读事件覆盖了全部事件，故键表按现读重建（完整，`seen_keys_complete: true`）。代价如实：这次核验
// 就是一次全量折叠，所以本路径**不省解析、不省 fold**，只是"能不能信磁盘派生"的正确性闸门。
import path from "node:path";
import { nowIso } from "../time";
import {
  buildSnapshotReusing,
  freezeEntityStates,
  readSnapshotFromDisk,
  verifySnapshotEntities,
  verifySnapshotSource,
} from "./eventStore";
import {
  peekLedgerEntry,
  readLedger,
  setLedgerFoldBase,
  type LedgerRead,
} from "./ledgerRead";
import type { FoldBase, LedgerPrefixProof, WorkEvent, WorkSnapshot } from "./types";

// 读取与缓存的原语一律从 `ledgerRead` 再导出，保持既有调用面（脚本/未来 service）不变。
export {
  EVENT_READ_CACHE_MAX_ENTRIES,
  EVENT_READ_CACHE_MAX_ENTRY_BYTES,
  EVENT_READ_CACHE_MAX_ENTRY_EVENTS,
  EVENT_READ_CACHE_MAX_LINE_BYTES,
  EVENT_READ_CACHE_MAX_TOTAL_BYTES,
  clearEventReadCache,
  eventReadCacheStats,
  peekLedgerEntry,
  readLedger,
  resetEventReadCacheLimits,
  setEventReadCacheLimitsForTest,
  setLedgerFoldBase,
  type EventReadCacheStats,
  type LedgerRead,
} from "./ledgerRead";

export interface CachedSnapshotResult {
  read: LedgerRead;
  snapshot: WorkSnapshot;
  origin: "full" | "incremental";
  reused_events: number;
  folded_events: number;
  reason: string | null;
  /** 仅当本次核验了磁盘基线时非空：非 null 表示"不予复用"的具体原因 */
  disk_base_reason: string | null;
}

/**
 * 由缓存读口构造快照（V09-38「可验证的 buildSnapshot 增量复用」）。
 *
 * 折叠基线绑定**已证明的内容身份**：只有本次现读的前缀摘要与基线记录一致、且边界事件
 * （seq + event_id）双重指认时，才只折叠新增后缀；否则全量重折，结果与 `buildSnapshot` 逐对象一致。
 * `reuseDiskSnapshot` 打开时，会先把磁盘 `state.json` 的来源证明按本次现读账本核验，核验通过才当基线。
 */
export function snapshotFromLedger(
  workDir: string,
  projectId: string,
  opts: {
    projectionError?: string | null;
    generatedAt?: string;
    reuseDiskSnapshot?: boolean;
  } = {},
): CachedSnapshotResult {
  const read = readLedger(workDir);
  const entry = peekLedgerEntry(workDir);
  const canonical: readonly WorkEvent[] = entry !== null ? entry.events : read.events;
  let base: FoldBase | null = entry?.foldBase ?? null;
  // 冷读时 `read.prefix_proof` 是 null（进程内没有可用的前缀），此时磁盘基线要通过核验**自带证明**：
  // `snapshotBaseFromDisk` 在核验通过后给出一个由本次现读内容派生的 `LedgerPrefixProof`，
  // 折叠层据此才愿意复用（V09-38 复审：核验通过要形成"真实可复用"的证明，而不是空谈）。
  let proof = read.prefix_proof;
  let diskBaseReason: string | null = null;
  if (base === null && opts.reuseDiskSnapshot === true) {
    const fromDisk = snapshotBaseFromDisk(workDir, read, projectId);
    base = fromDisk.base;
    proof = fromDisk.proof;
    diskBaseReason = fromDisk.reason;
  }
  const result = buildSnapshotReusing(
    projectId,
    canonical,
    { content: read.content, base, proof },
    opts.projectionError ?? null,
    opts.generatedAt ?? nowIso(),
  );
  if (entry !== null) setLedgerFoldBase(workDir, result.base);
  return {
    read,
    snapshot: result.snapshot,
    origin: result.origin,
    reused_events: result.reused_events,
    folded_events: result.folded_events,
    reason: result.reason,
    disk_base_reason: diskBaseReason,
  };
}

/**
 * 跨进程持久增量的**读侧**：把磁盘 `state.json` 转换成续折基线——**只有按本次现读账本核验通过**才返回基线。
 *
 * 核验项（任一不成立即 `base: null` + 原因，调用方全量重折）：
 *   · 快照存在、`project_id` 一致、带 `source_fp`、schema 与 `FOLD_RULES_VERSION` 相同；
 *   · `source_fp` 的 `file_bytes/verified_bytes/prefix_sha256` 与**本次现读账本**逐字节一致；
 *   · `folded_events` 恰好等于本次事件条数（无新增；见文件头说明），且边界事件 seq + event_id 指认成立；
 *   · **规范重放核验派生实体**（`verifySnapshotEntities`）：磁盘 `entities` 必须与本次现读账本的
 *     `replayEvents` 逐对象一致——来源指纹只证明"账本没变"，证不了派生实体没被篡改（payload/revision/增删）。
 *
 * **返给折叠层的实体是规范重放的结果，不是磁盘原件**；`seen_keys` 也按本次现读事件重建（完整），
 * 因此基线标 `seen_keys_complete: true`。另外返回一个由**本次现读内容**派生的 `proof`，让冷读
 * （进程内没有前缀证明）也能形成可复用的真实证明。
 *
 * **能力边界（如实，不粉饰）**：规范重放这一步就是一次全量折叠。所以本路径**不省解析、不省 fold**，
 * 它是"能不能信这份磁盘派生"的正确性闸门，而不是提速手段；通不过就明确回退全量。省工作量的真实
 * 路径是进程内前缀复用（parse 缓存 + 增量 fold），不是这里。
 */
export function snapshotBaseFromDisk(
  workDir: string,
  read: LedgerRead,
  projectId: string,
): { base: FoldBase | null; reason: string | null; proof: LedgerPrefixProof | null } {
  const refused = (reason: string): { base: null; reason: string; proof: null } => ({
    base: null,
    reason,
    proof: null,
  });
  const snapshot = readSnapshotFromDisk(workDir);
  const verdict = verifySnapshotSource(snapshot, read.content, projectId);
  if (!verdict.ok) return refused(verdict.reason);
  const fp = snapshot!.source_fp!;
  if (fp.folded_events !== read.events.length) return refused("folded_events_mismatch");
  const entitiesVerdict = verifySnapshotEntities(snapshot, read.events);
  if (!entitiesVerdict.ok) return refused(entitiesVerdict.reason);
  if (fp.folded_events > 0) {
    const boundary = read.events[fp.folded_events - 1];
    if (boundary === undefined) return refused("boundary_missing");
    if (boundary.seq !== fp.last_seq) return refused("boundary_seq_mismatch");
    if (boundary.event_id !== fp.last_event_id) return refused("boundary_event_mismatch");
  }
  // 规范重放得到的实体（可信）；冻结后共享 payload 也改不动，污染不进后续复用。
  const entities = freezeEntityStates(entitiesVerdict.entities);
  const seenKeys = new Map<string, number>();
  for (const e of read.events) seenKeys.set(e.idempotency_key, e.seq);
  return {
    base: {
      content: read.content,
      folded_events: fp.folded_events,
      last_seq: entitiesVerdict.last_seq,
      last_event_id: read.events[read.events.length - 1]?.event_id ?? null,
      entities,
      // 本次现读事件覆盖了全部事件（folded_events === events.length），键表完整。
      seen_keys: seenKeys,
      seen_keys_complete: true,
    },
    reason: null,
    proof: {
      prefix_bytes: read.content.verified_bytes,
      prefix_sha256: read.content.prefix_sha256,
      file_bytes: read.content.file_bytes,
    },
  };
}

/** 供调用方判断"这个 workDir 的缓存条目现在是否可用"（不读盘、不改状态） */
export function cachedLedgerKey(workDir: string): string {
  return path.resolve(workDir);
}
