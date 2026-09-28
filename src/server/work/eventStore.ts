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
import {
  SCHEMA_VERSION,
  WorkError,
  validateWorkEvent,
  type WorkEntityState,
  type WorkEvent,
  type WorkSnapshot,
} from "./types";

export const EVENTS_FILE = "events.jsonl";
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
 * 读全部事件（逐行流式，不把整份文件读进内存——沿用 Q46 口径）。
 *
 * 抛错口径：任何**非尾行**的损坏都抛 `MIDDLE_CORRUPT`（带行号、原文片段、原因），
 * 让"中间坏了却继续绿灯"不可能发生。尾行半截不抛，塞进返回值的 `tail`。
 */
export function loadEvents(workDir: string): LoadedEvents {
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
 * 重放事件得到状态（DESIGN.md §2.6：`state.json` 为带 `last_seq` 的可重建快照）。
 *
 * 除逐条事件自校验外，这里还核对结构不变量——任一不成立都抛（**不降级成"看起来没事"**）：
 *   · seq 从 1 起严格 +1（无洞、无重号）：有洞说明丢过完整事件，必须停下来查现场；
 *   · 同一实体 revision 严格 +1；
 *   · 幂等键在本项目内唯一（重复出现说明写入端绕过了幂等检查）。
 */
export function replayEvents(events: WorkEvent[]): {
  entities: Record<string, WorkEntityState>;
  last_seq: number;
} {
  const entities: Record<string, WorkEntityState> = {};
  const seenKeys = new Map<string, number>();
  let last_seq = 0;
  for (const e of events) {
    if (e.seq !== last_seq + 1) {
      throw new WorkError(
        "EVENT_INVALID",
        `事件 seq 不连续：期望 ${last_seq + 1}，实际 ${e.seq}（事件 ${e.event_id}）。` +
          "seq 有洞说明丢过完整事件，不能当作正常状态继续",
        { expected: last_seq + 1, got: e.seq, event_id: e.event_id },
      );
    }
    const prev = entities[e.entity_id];
    const expectedRev = (prev?.revision ?? 0) + 1;
    if (e.entity_revision !== expectedRev) {
      throw new WorkError(
        "EVENT_INVALID",
        `实体 ${e.entity_id} 的 revision 不连续：期望 ${expectedRev}，实际 ${e.entity_revision}（事件 ${e.event_id}）`,
        { entity_id: e.entity_id, expected: expectedRev, got: e.entity_revision },
      );
    }
    const dupKey = seenKeys.get(e.idempotency_key);
    if (dupKey !== undefined) {
      throw new WorkError(
        "EVENT_INVALID",
        `幂等键在事件文件里出现两次：${e.idempotency_key}（第 ${dupKey} 与第 ${e.seq} 序号）——说明有写入绕过了幂等检查`,
        { idempotency_key: e.idempotency_key, at_seq: dupKey, again_at_seq: e.seq },
      );
    }
    seenKeys.set(e.idempotency_key, e.seq);

    entities[e.entity_id] = {
      revision: e.entity_revision,
      type: e.type,
      last_event_id: e.event_id,
      updated_at: e.received_at,
      payload: e.payload,
    };
    last_seq = e.seq;
  }
  return { entities, last_seq };
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
