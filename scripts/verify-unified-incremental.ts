// V09-38 增量读取复审修正 + 真实接入验证（tsx 跑）。
//
// 覆盖口径（红例优先；DESIGN.md §6.8；契约 docs/unified-optimization-contract.md U1/U2）：
//   · **生产入口接入**：`loadEvents` 走有界内容核验缓存，与全量 oracle `loadEventsFull` 逐条一致；
//     合法追加只解析后缀、重复读 0 解析；返回数组仍是独立切片（可 push/换元素），元素只读。
//   · 同长度 + 保留 mtime 的**原地改写**必须被识别（不得旧绿）；同内容改 mtime 仍可复用（按内容不按 stat）。
//   · 中段损坏照常抛 MIDDLE_CORRUPT（绝不沿用上一次缓存）；半截尾现场照常报出并可恢复；
//     **半截尾的 prefix 摘要与事件同一次读**（第二次读不错配，不改文件时摘要稳定）。
//   · 扫描期间文件在变（并发追加/截断）→ 不崩、不缓存、最终读到的是真实内容（不旧绿）。
//   · 缓存条目/总字节/单条字节/**事件条数**/**单行字节**上限与淘汰；**超预算正确退化为每次全量**。
//   · 增量解析与增量快照逐对象对全量 oracle；**改第一次返回的 entities/Map 不影响后续缓存基线**。
//   · 跨进程快照来源证明（`source_fp`）：核验通过才复用、缺失/伪造/规则变/边界不符/有新增 → 全量。
//   · 验证器直接受试：伪造前缀摘要/边界事件/跨读取证明 → 一律回退全量，绝不"看起来成功"。
//   · 真机基准：**只读**冻结镜像（约 53 MB）loadEventsFull vs loadEvents 暖 30 / 冷 5，附原始样本与 RSS。
//
// 隔离口径（AGENTS.md §5）：合成夹具一律放系统 tmp 下 `tatai-unified-incremental-` 前缀目录、收尾自清；
//   冻结镜像只读、绝不写入；不碰真实注册表与任何真实项目；不 build、不跑生产服务。
//
// 运行：node --import tsx scripts/verify-unified-incremental.ts
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FOLD_RULES_VERSION,
  buildSnapshot,
  buildSnapshotReusing,
  decideFoldReuse,
  eventsPath,
  loadEvents,
  loadEventsFull,
  recoverTail,
  replayEvents,
  snapshotSourceFingerprintOf,
  verifySnapshotEntities,
  verifySnapshotSource,
  writeSnapshot,
  type FoldBase,
  type FoldReuseDecision,
  type LedgerContentFingerprint,
  type LedgerPrefixProof,
} from "../src/server/work/eventStore";
import { WorkError, type WorkEvent, type WorkSnapshot } from "../src/server/work/types";
import {
  clearEventReadCache,
  eventReadCacheStats,
  peekLedgerEntry,
  readLedger,
  resetEventReadCacheLimits,
  setEventReadCacheLimitsForTest,
  snapshotBaseFromDisk,
  snapshotFromLedger,
} from "../src/server/work/eventReadCache";

const NOW = "2026-10-03T00:00:00+08:00";
const FIXED_GEN = "2026-10-03T00:00:00.000Z";
/** 冻结镜像（只读）：证据根 newroot/mirror。可用 TATAI_MIRROR_WORKDIR 覆盖 */
const MIRROR_WORKDIR =
  process.env.TATAI_MIRROR_WORKDIR ??
  "<维护者核验目录>/tatai-unified-20261003/mirror/project/.工作台/work";

let pass = 0;
const fails: string[] = [];
const skips: string[] = [];
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else {
    fails.push(label);
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 800)}`);
  }
};
const skip = (label: string): void => {
  console.log(`[verify] SKIP ${label}`);
  skips.push(label);
};
const info = (m: string): void => console.log(`[verify]   ${m}`);

const rssMb = (): number => process.memoryUsage().rss / 1048576;
const heapMb = (): number => process.memoryUsage().heapUsed / 1048576;

// ── 夹具 ──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-unified-incremental-"));

function workDirOf(tag: string): string {
  const dir = path.join(tmpRoot, tag, "work");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ev(seq: number, entity_id: string, revision: number, status: string): WorkEvent {
  return {
    schema_version: 2,
    event_id: `ev-${seq}`,
    project_id: "fixture",
    change_id: "chg-fixture",
    entity_id,
    entity_revision: revision,
    seq,
    type: "task.status_changed",
    actor_id: "fixture-executor",
    role: "executor",
    occurred_at: NOW,
    received_at: NOW,
    idempotency_key: `idem-${seq}`,
    payload: { status, note: `note-${seq}` },
  };
}

function writeLedger(workDir: string, events: WorkEvent[]): void {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(eventsPath(workDir), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

function appendLedger(workDir: string, e: WorkEvent): void {
  fs.appendFileSync(eventsPath(workDir), JSON.stringify(e) + "\n", "utf8");
}

/** 全量 oracle：**不走任何缓存**的独立实现 */
function oracle(workDir: string): WorkEvent[] {
  return loadEventsFull(workDir).events;
}

const jeq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameEvents = (a: readonly WorkEvent[], b: readonly WorkEvent[]): boolean => jeq(a, b);

/** 逐条比较事件时避开超大数组 JSON 双开：按批切片比较 */
function sameEventsChunked(a: readonly WorkEvent[], b: readonly WorkEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 500) {
    const ca = a.slice(i, i + 500);
    const cb = b.slice(i, i + 500);
    if (!jeq(ca, cb)) return false;
  }
  return true;
}

function sameEntities(a: { last_seq: number; entities: Record<string, unknown> }, b: typeof a): boolean {
  if (a.last_seq !== b.last_seq) return false;
  const ka = Object.keys(a.entities).sort();
  const kb = Object.keys(b.entities).sort();
  if (!jeq(ka, kb)) return false;
  for (const k of ka) if (!jeq(a.entities[k], b.entities[k])) return false;
  return true;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "(没有抛错)";
  } catch (e) {
    return e instanceof WorkError ? e.code : `(非 WorkError: ${(e as Error).message})`;
  }
}

function sha256Buf(b: Buffer): string {
  return crypto.createHash("sha256").update(b).digest("hex");
}

const GREEN = [
  ev(1, "task:aaaa", 1, "executing"),
  ev(2, "task:bbbb", 1, "executing"),
  ev(3, "task:aaaa", 2, "blocked"),
];

try {
  // ════════ A. 空账本 ════════
  console.log("[verify] ═══ A 空账本 ═══");
  {
    clearEventReadCache();
    const wd = workDirOf("empty");
    const r = readLedger(wd);
    ok(r.origin === "empty" && r.events.length === 0 && r.content.file_bytes === 0, "A1 账本不存在 → empty，零事件");
  }

  // ════════ B. 生产入口 loadEvents 接入缓存（与 loadEventsFull oracle 一致） ════════
  console.log("[verify] ═══ B loadEvents 接入 / 首次全量 / 无变化重复读 ═══");
  const wdMain = workDirOf("main");
  {
    clearEventReadCache();
    writeLedger(wdMain, GREEN);

    const before = eventReadCacheStats();
    const first = loadEvents(wdMain); // 生产入口：第一次必然全量
    const s1 = eventReadCacheStats();
    ok(
      s1.reparsed_events - before.reparsed_events === 3 && s1.hashed_bytes - before.hashed_bytes > 0,
      `B1 loadEvents 首次：全量解析 3 条、哈希了 ${s1.hashed_bytes - before.hashed_bytes} 字节`,
    );
    ok(sameEvents(first.events, loadEventsFull(wdMain).events), "B1 loadEvents 与 loadEventsFull 逐条一致");

    const before2 = eventReadCacheStats();
    const second = loadEvents(wdMain); // 内容未变：应复用、0 重解析
    const s2 = eventReadCacheStats();
    ok(
      s2.reparsed_events - before2.reparsed_events === 0 && s2.reused_events - before2.reused_events === 3,
      `B2 loadEvents 重复读：复用 3 条、重解析 0 条（hashed=${s2.hashed_bytes - before2.hashed_bytes} 字节，证明每次仍核验真实字节）`,
    );
    ok(s2.hashed_bytes - before2.hashed_bytes > 0, "B2 复用也**每次都哈希真实字节**（不是靠 mtime/size 判未变）");
    ok(sameEvents(second.events, loadEventsFull(wdMain).events), "B2 复用结果与 oracle 逐条一致");

    // 修改兼容性：数组仍是独立切片（可 push / 换元素），污染不进缓存
    const a = loadEvents(wdMain);
    const before3 = eventReadCacheStats();
    a.events.push(ev(99, "task:hacked", 1, "blocked"));
    a.events[0] = ev(98, "task:swapped", 1, "blocked");
    const b = loadEvents(wdMain);
    ok(b.events.length === 3 && sameEvents(b.events, GREEN), "B3 改 loadEvents 返回数组不影响后续权威读取（仍是原 3 条）");
    ok(eventReadCacheStats().reparsed_events - before3.reparsed_events === 0, "B3 数组改写未造成缓存失效或重解析");
  }

  // ════════ C. 合法追加只解析后缀 ════════
  console.log("[verify] ═══ C 合法追加仅解析后缀 ═══");
  {
    appendLedger(wdMain, ev(4, "task:bbbb", 2, "blocked"));
    const r = readLedger(wdMain);
    ok(
      r.origin === "incremental" && r.reparsed_events === 1 && r.reused_prefix_events === 3,
      `C1 追加 1 条：只重解析 1 条、复用 3 条（reparsed=${r.reparsed_events}, reused=${r.reused_prefix_events}）`,
    );
    ok(r.events.length === 4 && sameEvents(r.events, oracle(wdMain)), "C1 追加后事件与 oracle 逐条一致（4 条）");

    fs.utimesSync(eventsPath(wdMain), new Date(0), new Date(0));
    const r2 = readLedger(wdMain);
    ok(
      r2.origin === "incremental" && r2.reparsed_events === 0,
      "C2 只改 mtime、内容不变 → 仍复用（判据是内容摘要，不是 mtime）",
    );
  }

  // ════════ D. 同长度 + 保留 mtime 的原地改写（红例：不得旧绿） ════════
  console.log("[verify] ═══ D 同长度 + 保留 mtime 原地改写 ═══");
  {
    const wd = workDirOf("inplace");
    const file = eventsPath(wd);
    const stamp = new Date("2020-01-01T00:00:00Z");
    clearEventReadCache();
    writeLedger(wd, GREEN);
    fs.utimesSync(file, stamp, stamp);
    const rA = readLedger(wd);
    const stA = fs.statSync(file);
    const textA = fs.readFileSync(file, "utf8");
    ok(rA.origin === "full" && rA.events.length === 3, "D1 内容 A 先入缓存（full，3 条）");

    const textB = textA.split("executing").join("cancelled");
    fs.writeFileSync(file, textB, "utf8");
    fs.utimesSync(file, stamp, stamp);
    const stB = fs.statSync(file);
    ok(
      stA.size === stB.size && stA.mtimeMs === stB.mtimeMs,
      `D2 改写后 size(${stB.size}) 与 mtime(${stB.mtimeMs}) 与改前完全相同（夹具成立）`,
    );
    ok(textB !== textA && Buffer.byteLength(textB) === Buffer.byteLength(textA), "D2 内容确实不同且等长");

    const rB = readLedger(wd);
    ok(
      rB.origin === "full" && rB.fell_back_to_full && rB.fallback_reason === "prefix_mismatch",
      `D3 同长度同 mtime 改写被识别为全量重读（origin=${rB.origin}, reason=${rB.fallback_reason}）`,
    );
    ok(
      rB.events[0]!.payload.status === "cancelled" && sameEvents(rB.events, oracle(wd)),
      "D3 结论跟着新内容走（看到 cancelled），与 oracle 一致——没有旧绿",
    );
  }

  // ════════ E. 截断 / 整份替换 ════════
  console.log("[verify] ═══ E 截断 / 替换 ═══");
  {
    const wd = workDirOf("truncate");
    const file = eventsPath(wd);
    clearEventReadCache();
    writeLedger(wd, GREEN);
    readLedger(wd);
    const firstLineBytes = Buffer.byteLength(JSON.stringify(GREEN[0]) + "\n", "utf8");
    fs.truncateSync(file, firstLineBytes);
    const r = readLedger(wd);
    ok(
      r.origin === "full" && r.events.length === 1 && sameEvents(r.events, oracle(wd)),
      `E1 截断到 1 行 → 全量（origin=${r.origin}，{${r.events.length}} 条与 oracle 一致）`,
    );

    clearEventReadCache();
    writeLedger(wd, [ev(1, "task:zzzz", 1, "blocked")]);
    readLedger(wd);
    fs.rmSync(file, { force: true });
    writeLedger(wd, [ev(1, "task:yyyy", 1, "executing"), ev(2, "task:yyyy", 2, "blocked")]);
    const r2 = readLedger(wd);
    ok(
      r2.origin === "full" && sameEvents(r2.events, oracle(wd)),
      "E2 整份替换（新内容）→ 全量，与 oracle 一致",
    );
  }

  // ════════ F. 中段损坏（绝不沿用上一次缓存） ════════
  console.log("[verify] ═══ F 中段损坏 ═══");
  {
    const wd = workDirOf("middle");
    const file = eventsPath(wd);
    clearEventReadCache();
    writeLedger(wd, GREEN);
    const good = readLedger(wd);
    ok(good.events.length === 3, "F0 健康账本先入缓存（3 条）");

    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
    lines[1] = '{"schema_version":2,"event_id":"坏行在中间"';
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");

    const cacheCode = codeOf(() => readLedger(wd));
    const oracleCode = codeOf(() => loadEventsFull(wd));
    ok(cacheCode === "MIDDLE_CORRUPT", `F1 缓存读口中段坏行 → MIDDLE_CORRUPT（实际 ${cacheCode}）`);
    ok(oracleCode === cacheCode, "F1 与 loadEventsFull 抛同一错误码（口径一致）");
    let detailLine = -1;
    try {
      readLedger(wd);
    } catch (e) {
      detailLine = (e as WorkError).detail.line as number;
    }
    ok(detailLine === 2, `F1 报出位置（line=${detailLine}）——损坏暴露、不静默跳过、不返回旧缓存`);
  }

  // ════════ G. 半截尾现场 / 恢复 / prefix 摘要与事件同一次读 ════════
  console.log("[verify] ═══ G 半截尾 ═══");
  {
    const wd = workDirOf("tail");
    const file = eventsPath(wd);
    clearEventReadCache();
    writeLedger(wd, GREEN.slice(0, 2));
    readLedger(wd);
    const completeBytes = fs.statSync(file).size;
    const completeSha = sha256Buf(fs.readFileSync(file));
    // 半截尾 = 一条完整事件 JSON 的前半段（确定为非法 JSON、且是最后一行且无换行收尾）
    const full3 = JSON.stringify(ev(3, "task:aaaa", 2, "blocked"));
    fs.appendFileSync(file, full3.slice(0, 30), "utf8");

    const r = readLedger(wd);
    const o = loadEventsFull(wd);
    ok(
      r.tail !== null && r.events.length === 2 && (o.tail !== null && o.events.length === 2),
      `G1 半截尾：读侧报出 tail、前面 2 条完整事件照常读出（tail=${r.tail?.line}）`,
    );
    ok(sameEvents(r.events, o.events), "G1 与 loadEventsFull 的完整事件逐条一致");

    ok(
      r.content.verified_bytes === completeBytes,
      `G1 半尾 content.verified_bytes=${r.content.verified_bytes} 恰为完整行边界 ${completeBytes}`,
    );
    ok(
      r.content.prefix_sha256 === completeSha,
      "G1 半尾 prefix_sha256 等于【完整行那一段】的独立字节摘要（解析与哈希同版，非第二次读）",
    );
    ok(r.file_bytes > r.content.verified_bytes, "G1 file_bytes 含半截尾（> verified_bytes）");

    const r2b = readLedger(wd);
    ok(
      r2b.content.prefix_sha256 === r.content.prefix_sha256 &&
        r2b.content.verified_bytes === r.content.verified_bytes,
      "G2 半尾文件第二次读：prefix 摘要与边界稳定（不错配）",
    );
    ok(sameEvents(r2b.events, r.events), "G2 半尾第二次读事件一致");

    // 补全成完整事件（追加余下部分 + 换行）→ 成为第 3 条合法事件
    fs.appendFileSync(file, full3.slice(30) + "\n", "utf8");
    const r3 = readLedger(wd);
    ok(
      r3.tail === null && r3.events.length === 3 && sameEvents(r3.events, oracle(wd)),
      `G3 补全尾行后成为第 3 条完整事件（tail=${r3.tail}, 事件=${r3.events.length}），与 oracle 一致`,
    );

    // recoverTail：再造一个半截尾并隔离
    fs.appendFileSync(file, '{"schema_version":2,"event_id":"半截', "utf8");
    const rBefore = readLedger(wd);
    ok(rBefore.tail !== null && rBefore.events.length === 3, "G4 再造半截尾：报出 tail、完整事件 3 条");
    recoverTail(wd);
    const r4 = readLedger(wd);
    ok(r4.tail === null && sameEvents(r4.events, oracle(wd)), "G4 recoverTail 隔离后不再有半截尾，与 oracle 一致");
  }

  // ════════ H. 隔离：外部改返回数组/对象污染不进缓存 ════════
  console.log("[verify] ═══ H 返回值的隔离 ═══");
  {
    const wd = workDirOf("isolate");
    clearEventReadCache();
    writeLedger(wd, GREEN);
    const a = readLedger(wd);
    const before = a.events.length;
    a.events.push(ev(99, "task:hacked", 1, "blocked"));
    a.events[0] = ev(98, "task:swapped", 1, "blocked");
    let objThrew = false;
    try {
      (a.events[1]!.payload as Record<string, unknown>).status = "hacked";
    } catch {
      objThrew = true;
    }
    let deleteThrew = false;
    try {
      delete (a.events[1] as unknown as Record<string, unknown>).payload;
    } catch {
      deleteThrew = true;
    }

    const b = readLedger(wd);
    ok(b.events.length === before && sameEvents(b.events, GREEN), "H1 篡改返回值不影响后续权威读取（仍是原 3 条）");
    ok(objThrew, "H2 事件对象被深冻结：改写 payload 抛错（严格模式）");
    ok(deleteThrew, "H2 事件对象被深冻结：delete 字段抛错");
    ok(b.events[1]!.payload.status === "executing", "H3 缓存内对象未被污染（status 仍是 executing）");
    ok(Object.isFrozen(b.events[1]) && Object.isFrozen(b.events[1]!.payload), "H3 权威对象确实处于冻结态");
  }

  // ════════ I. 缓存上限与淘汰（条目 / 总字节 / 单条字节 / 事件条数 / 单行字节） ════════
  console.log("[verify] ═══ I 缓存上限与淘汰 ═══");
  {
    clearEventReadCache();
    setEventReadCacheLimitsForTest({ max_entries: 3, max_total_bytes: 1 << 30, max_entry_bytes: 1 << 30 });
    const dirs = ["c0", "c1", "c2", "c3", "c4"].map((t) => {
      const wd = workDirOf(`bound-${t}`);
      writeLedger(wd, [ev(1, "task:x", 1, "executing")]);
      readLedger(wd);
      return wd;
    });
    const s1 = eventReadCacheStats();
    ok(s1.entries === 3, `I1 条目上限 3：读 5 个不同 workDir 后仍只留 ${s1.entries} 条`);

    readLedger(dirs[0]!);
    const s2 = eventReadCacheStats();
    ok(s2.entries === 3, `I2 重读被淘汰的条目后仍受条目上限约束（${s2.entries} 条）`);

    clearEventReadCache();
    setEventReadCacheLimitsForTest({ max_entries: 8, max_total_bytes: 1 << 30, max_entry_bytes: 80, max_entry_events: 1 << 20, max_line_bytes: 1 << 30 });
    const wdBig = workDirOf("oversize");
    writeLedger(wdBig, GREEN);
    const rb = readLedger(wdBig);
    ok(rb.origin === "full" && eventReadCacheStats().entries === 0, "I3 超过单条**字节**上限的账本不缓存（entries=0）");
    const rb2 = readLedger(wdBig);
    ok(rb2.origin === "full" && rb2.reparsed_events === 3, "I3 未缓存则每次全量（reparsed=3），结果仍正确");
    ok(sameEvents(rb2.events, oracle(wdBig)), "I3 超上限退化后仍与 oracle 一致（正确退化，不旧绿）");

    clearEventReadCache();
    setEventReadCacheLimitsForTest({ max_entries: 8, max_total_bytes: 1 << 30, max_entry_bytes: 1 << 30, max_entry_events: 2, max_line_bytes: 1 << 30 });
    const wdMany = workDirOf("manyevents");
    writeLedger(wdMany, GREEN); // 3 条 > 事件上限 2
    const rm = readLedger(wdMany);
    ok(rm.origin === "full" && eventReadCacheStats().entries === 0, "I3b 超过单条**事件条数**上限的账本不缓存（entries=0）");

    clearEventReadCache();
    setEventReadCacheLimitsForTest({ max_entries: 8, max_total_bytes: 1 << 30, max_entry_bytes: 1 << 30, max_entry_events: 1 << 20, max_line_bytes: 50 });
    const wdLine = workDirOf("longline");
    writeLedger(wdLine, GREEN); // 每行远超 50 字节
    const rl = readLedger(wdLine);
    ok(rl.origin === "full" && eventReadCacheStats().entries === 0, "I3c 超过单行**字节**上限的账本不缓存（entries=0）");

    clearEventReadCache();
    setEventReadCacheLimitsForTest({ max_entries: 100, max_total_bytes: 120, max_entry_bytes: 1 << 30, max_entry_events: 1 << 20, max_line_bytes: 1 << 30 });
    const wdT1 = workDirOf("total-1");
    const wdT2 = workDirOf("total-2");
    const wdT3 = workDirOf("total-3");
    for (const wd of [wdT1, wdT2, wdT3]) writeLedger(wd, [ev(1, "task:y", 1, "executing")]);
    readLedger(wdT1);
    readLedger(wdT2);
    readLedger(wdT3);
    const s3 = eventReadCacheStats();
    ok(s3.bytes <= 120 && s3.entries < 3, `I4 总字节上限生效：留存 ${s3.entries} 条 / ${s3.bytes} 字节 ≤ 120`);

    resetEventReadCacheLimits();
    clearEventReadCache();
  }

  // ════════ J. 增量快照复用 + 返回实体/Map 的隔离 ════════
  console.log("[verify] ═══ J 增量快照复用与实体隔离 ═══");
  {
    const wd = workDirOf("snapshot");
    clearEventReadCache();
    writeLedger(wd, GREEN);
    const s1 = snapshotFromLedger(wd, "proj", { generatedAt: FIXED_GEN });
    ok(
      s1.origin === "full" && s1.folded_events === 3 && s1.reused_events === 0,
      `J1 首次快照全量折叠 3 条（origin=${s1.origin}, folded=${s1.folded_events}）`,
    );
    ok(
      sameEntities(s1.snapshot, buildSnapshot("proj", oracle(wd), null, FIXED_GEN)),
      "J1 首次快照实体逐对象等于 buildSnapshot oracle",
    );

    appendLedger(wd, ev(4, "task:bbbb", 2, "blocked"));
    const s2 = snapshotFromLedger(wd, "proj", { generatedAt: FIXED_GEN });
    ok(
      s2.origin === "incremental" && s2.folded_events === 1 && s2.reused_events === 3,
      `J2 追加后增量折叠：只折 1 条、复用 3 条（origin=${s2.origin}, folded=${s2.folded_events}, reused=${s2.reused_events}）`,
    );
    ok(
      sameEntities(s2.snapshot, buildSnapshot("proj", oracle(wd), null, FIXED_GEN)),
      "J2 增量快照实体逐对象等于全量 oracle（含 last_seq）",
    );

    // **复审点**：改第一次返回的实体/Map 不得污染后续缓存基线
    const mutated = s2.snapshot;
    mutated.entities["task:aaaa"]!.revision = 999;
    mutated.entities["task:bbbb"]!.payload = { hacked: true };
    delete mutated.entities["task:aaaa"];
    mutated.entities["task:ghost"] = { revision: 7, type: "x", last_event_id: "z", updated_at: NOW, payload: {} };

    const s3 = snapshotFromLedger(wd, "proj", { generatedAt: FIXED_GEN });
    ok(
      sameEntities(s3.snapshot, buildSnapshot("proj", oracle(wd), null, FIXED_GEN)),
      "J3 改上一次返回的实体/Map 后，下一次快照仍逐对象等于全量 oracle（缓存基线未被污染）",
    );
    ok(
      s3.snapshot.entities["task:aaaa"]!.revision === 2 && s3.snapshot.entities["task:ghost"] === undefined,
      "J3 被改写的实体值/新增键都没有泄进后续快照",
    );
    ok(s3.origin === "incremental" && s3.folded_events === 0, `J3 内容未变再取快照：折叠 0 条（folded=${s3.folded_events}）`);

    const file = eventsPath(wd);
    const text = fs.readFileSync(file, "utf8").split("executing").join("cancelled");
    fs.writeFileSync(file, text, "utf8");
    const s4 = snapshotFromLedger(wd, "proj", { generatedAt: FIXED_GEN });
    ok(s4.origin === "full", `J4 内容改写后快照回全量（origin=${s4.origin}）`);
    ok(
      sameEntities(s4.snapshot, buildSnapshot("proj", oracle(wd), null, FIXED_GEN)),
      "J4 回全量后实体仍等于 oracle",
    );
  }

  // ════════ K. 验证器直接受试：伪造证明一律回退全量 ════════
  console.log("[verify] ═══ K 验证器（decideFoldReuse / buildSnapshotReusing） ═══");
  {
    const events = GREEN;
    const bytes = Buffer.byteLength(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const whole = sha256Buf(Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n"));
    const content: LedgerContentFingerprint = { file_bytes: bytes, verified_bytes: bytes, prefix_sha256: whole };
    const proof: LedgerPrefixProof = { prefix_bytes: bytes, prefix_sha256: whole, file_bytes: bytes };
    const head2 = events.slice(0, 2);
    const base: FoldBase = {
      content,
      folded_events: 2,
      last_seq: 2,
      last_event_id: events[1]!.event_id,
      entities: replayEvents(head2).entities,
      seen_keys: new Map(head2.map((e) => [e.idempotency_key, e.seq] as const)),
    };

    const d = (b: FoldBase | null, p: LedgerPrefixProof | null, c: LedgerContentFingerprint): FoldReuseDecision =>
      decideFoldReuse(b, events, p, c);
    ok(d(null, proof, content).ok === false, "K1 base=null → 不可复用（no_base）");
    ok(d(base, null, content).ok === false, "K1 proof=null → 不可复用（no_prefix_proof）");
    ok(
      !d(base, { ...proof, prefix_sha256: "deadbeef" }, content).ok &&
        (d(base, { ...proof, prefix_sha256: "deadbeef" }, content) as { reason: string }).reason === "prefix_sha256_mismatch",
      "K2 伪造前缀摘要 → prefix_sha256_mismatch（验证器不被骗）",
    );
    ok(
      (d(base, { ...proof, prefix_bytes: bytes + 1 }, content) as { reason: string }).reason === "prefix_bytes_mismatch",
      "K2 前缀字节数不符 → prefix_bytes_mismatch",
    );
    ok(
      (d(base, { ...proof, file_bytes: bytes + 10 }, content) as { reason: string }).reason === "proof_content_diverged",
      "K2 证明与内容不是同一次读取 → proof_content_diverged",
    );
    ok(
      (d(base, proof, { ...content, verified_bytes: 1 }) as { reason: string }).reason === "content_shrank",
      "K3 内容比基线还短 → content_shrank",
    );
    ok(
      (d({ ...base, last_seq: 99 }, proof, content) as { reason: string }).reason === "boundary_seq_mismatch",
      "K3 基线边界 seq 对不上 → boundary_seq_mismatch",
    );
    ok(
      (d({ ...base, last_event_id: "ev-wrong" }, proof, content) as { reason: string }).reason === "boundary_event_mismatch",
      "K3 基线边界 event_id 对不上 → boundary_event_mismatch",
    );
    ok(
      (d({ ...base, seen_keys_complete: false }, proof, content) as { reason: string }).reason === "incomplete_seen_keys",
      "K3b 幂等键表不完整的基线 + 有新增 → incomplete_seen_keys（不许跳过去重）",
    );
    ok(d(base, proof, content).ok === true, "K4 证明与边界都成立 → 允许续折");

    const r = buildSnapshotReusing("proj", events, { content, base, proof }, null, FIXED_GEN);
    ok(r.origin === "incremental" && r.folded_events === 1 && r.reused_events === 2, "K5 真基线增量：折 1 条、复用 2 条");
    ok(sameEntities(r.snapshot, buildSnapshot("proj", events, null, FIXED_GEN)), "K5 增量聚合等于全量 oracle");

    // 返回的 snapshot 与返回的 base 必须是两套实体（浅隔离）
    r.snapshot.entities["task:aaaa"]!.revision = 12345;
    ok(
      r.base.entities["task:aaaa"]!.revision !== 12345,
      "K5b 返回 snapshot 与 base 的实体已隔离（改 snapshot 不影响 base）",
    );

    const rf = buildSnapshotReusing("proj", events, { content, base, proof: { ...proof, prefix_sha256: "x" } }, null, FIXED_GEN);
    ok(rf.origin === "full" && rf.reason === "prefix_sha256_mismatch", "K6 伪造证明 → 回退全量并给出原因");
    ok(sameEntities(rf.snapshot, buildSnapshot("proj", events, null, FIXED_GEN)), "K6 回退后仍等于全量 oracle（不拼凑）");
  }

  // ════════ L. 空文件 / 边界 ════════
  console.log("[verify] ═══ L 边界 ═══");
  {
    const wdEmptyFile = workDirOf("emptyfile");
    fs.writeFileSync(eventsPath(wdEmptyFile), "", "utf8");
    clearEventReadCache();
    const r = readLedger(wdEmptyFile);
    ok(r.origin === "full" && r.events.length === 0 && r.tail === null, "L1 空文件（0 字节）→ 0 事件、无半截尾");
    const r2 = readLedger(wdEmptyFile);
    ok(r2.origin === "incremental" && r2.events.length === 0, "L1 空文件重复读 → 增量复用（0 条）");
    ok(r2.content.prefix_sha256 === r.content.prefix_sha256, "L1 空文件内容身份稳定");
  }

  // ════════ N. 跨进程快照来源证明（types 的 source_fp schema） ════════
  console.log("[verify] ═══ N 跨进程快照来源证明 ═══");
  {
    const wd = workDirOf("persist");
    clearEventReadCache();
    writeLedger(wd, GREEN);
    const read = readLedger(wd);
    const snap: WorkSnapshot = buildSnapshot("proj", read.events, null, FIXED_GEN);
    snap.source_fp = snapshotSourceFingerprintOf(read, snap);
    writeSnapshot(wd, snap);

    ok(snap.source_fp.fold_rules_version === FOLD_RULES_VERSION, `N1 证明带规则版本 ${snap.source_fp.fold_rules_version}`);
    ok(verifySnapshotSource(snap, read.content, "proj").ok, "N1 证明与本次现读账本一致 → 核验通过");

    // 清掉进程内缓存：模拟"另一个进程/重启后"只靠 state.json 复用
    clearEventReadCache();
    const readAfter = readLedger(wd);
    const disk = snapshotBaseFromDisk(wd, readAfter, "proj");
    ok(
      disk.base !== null && disk.base.seen_keys_complete === true && disk.proof !== null,
      `N2 磁盘基线经 canonical replay 核验通过，键表按本次现读重建（完整）并附可复用前缀证明（reason=${disk.reason}）`,
    );

    const viaDisk = snapshotFromLedger(wd, "proj", { generatedAt: FIXED_GEN, reuseDiskSnapshot: true });
    ok(
      viaDisk.origin === "incremental" && viaDisk.folded_events === 0,
      `N2 用磁盘基线复用：折 0 条（origin=${viaDisk.origin}）`,
    );
    ok(
      sameEntities(viaDisk.snapshot, buildSnapshot("proj", oracle(wd), null, FIXED_GEN)),
      "N2 磁盘基线复用的实体逐对象等于全量 oracle",
    );

    // 有新增事件：磁盘基线没有前缀幂等键 → 必须回全量，不得跳过去重
    appendLedger(wd, ev(4, "task:bbbb", 2, "blocked"));
    clearEventReadCache();
    const readGrown = readLedger(wd);
    const diskGrown = snapshotBaseFromDisk(wd, readGrown, "proj");
    ok(diskGrown.base === null && typeof diskGrown.reason === "string", `N3 账本有新增 → 磁盘基线拒绝（reason=${diskGrown.reason}）`);
    const viaDiskGrown = snapshotFromLedger(wd, "proj", { generatedAt: FIXED_GEN, reuseDiskSnapshot: true });
    ok(viaDiskGrown.origin === "full", `N3 有新增时回全量（origin=${viaDiskGrown.origin}）`);

    // 用**当前账本**做一份合法快照，再分别伪造：前缀摘要 / folded_events / 规则版本 / 缺证明
    const liveRead = readLedger(wd);
    const liveEvents = liveRead.events;
    const goodSnap: WorkSnapshot = buildSnapshot("proj", liveEvents, null, FIXED_GEN);
    goodSnap.source_fp = snapshotSourceFingerprintOf(liveRead, goodSnap);

    const forged = JSON.parse(JSON.stringify(goodSnap)) as WorkSnapshot;
    forged.source_fp!.prefix_sha256 = "deadbeef";
    writeSnapshot(wd, forged);
    clearEventReadCache();
    const forgedBase = snapshotBaseFromDisk(wd, readLedger(wd), "proj");
    ok(forgedBase.base === null && forgedBase.reason === "prefix_sha256_mismatch", `N4 伪造前缀摘要 → 拒绝（reason=${forgedBase.reason}）`);

    const wrongCount = JSON.parse(JSON.stringify(goodSnap)) as WorkSnapshot;
    wrongCount.source_fp!.folded_events = liveEvents.length - 1; // 内容身份全对，只有折叠条数少 1
    writeSnapshot(wd, wrongCount);
    clearEventReadCache();
    const wrongCountBase = snapshotBaseFromDisk(wd, readLedger(wd), "proj");
    ok(
      wrongCountBase.base === null && wrongCountBase.reason === "folded_events_mismatch",
      `N4b 内容身份一致但折叠条数不符 → 拒绝（reason=${wrongCountBase.reason}）`,
    );

    const rulesChanged = JSON.parse(JSON.stringify(goodSnap)) as WorkSnapshot;
    rulesChanged.source_fp!.fold_rules_version = "fold-v0-old";
    writeSnapshot(wd, rulesChanged);
    clearEventReadCache();
    const rulesBase = snapshotBaseFromDisk(wd, readLedger(wd), "proj");
    ok(rulesBase.base === null && rulesBase.reason === "fold_rules_changed", `N5 规则版本变 → 拒绝（reason=${rulesBase.reason}）`);

    // 缺证明（旧 state.json）
    const noFp = JSON.parse(JSON.stringify(goodSnap)) as WorkSnapshot;
    delete noFp.source_fp;
    writeSnapshot(wd, noFp);
    clearEventReadCache();
    const noFpBase = snapshotBaseFromDisk(wd, readLedger(wd), "proj");
    ok(noFpBase.base === null && noFpBase.reason === "missing_source_fp", `N6 缺 source_fp → 拒绝（reason=${noFpBase.reason}，不为省事把旧快照当事实）`);

    // 磁盘基线不能用来折新事件（幂等键表不完整）——直接构造该情形
    const baseOnly = {
      content: liveRead.content,
      folded_events: liveEvents.length,
      last_seq: goodSnap.last_seq,
      last_event_id: liveEvents[liveEvents.length - 1]!.event_id,
      entities: goodSnap.entities,
      seen_keys: new Map<string, number>(),
      seen_keys_complete: false,
    } as FoldBase;
    const grown = [...liveEvents, ev(liveEvents.length + 1, "task:aaaa", 3, "blocked")];
    const reuseGrown = buildSnapshotReusing("proj", grown, { content: liveRead.content, base: baseOnly, proof: null }, null, FIXED_GEN);
    ok(reuseGrown.origin === "full" && reuseGrown.reason !== null, `N7 磁盘基线 + 有新增 → 回全量（reason=${reuseGrown.reason}）`);
  }

  // ════════ R. 保持 source_fp、篡改磁盘派生实体 → 必须拒绝（复审点名的漏洞） ════════
  console.log("[verify] ═══ R 磁盘快照实体篡改（source_fp 只证账本未变） ═══");
  {
    const wd = workDirOf("tamper");
    clearEventReadCache();
    writeLedger(wd, GREEN);
    const read = readLedger(wd);
    const snap: WorkSnapshot = buildSnapshot("proj", read.events, null, FIXED_GEN);
    snap.source_fp = snapshotSourceFingerprintOf(read, snap);
    writeSnapshot(wd, snap);
    clearEventReadCache();

    const readAfter = readLedger(wd);
    const good = snapshotBaseFromDisk(wd, readAfter, "proj");
    ok(good.base !== null && good.reason === null, "R0 未篡改：canonical replay 与磁盘实体一致 → 核验通过");

    const clone = (): WorkSnapshot => JSON.parse(JSON.stringify(snap)) as WorkSnapshot;

    // 保持 source_fp 逐字节不变，只改 payload（正是 root probe-snapshot-tamper.mts 的手法：blocked → result_submitted）
    const tamperPayload = clone();
    tamperPayload.entities["task:aaaa"]!.payload = { status: "result_submitted", note: "note-3" };
    writeSnapshot(wd, tamperPayload);
    clearEventReadCache();
    const rp = snapshotBaseFromDisk(wd, readLedger(wd), "proj");
    ok(rp.base === null && rp.reason === "snapshot_entity_mismatch", `R1 保 fp 改 payload → 拒绝（reason=${rp.reason}）`);

    const tamperRev = clone();
    tamperRev.entities["task:aaaa"]!.revision = 99;
    writeSnapshot(wd, tamperRev);
    clearEventReadCache();
    const rr = snapshotBaseFromDisk(wd, readLedger(wd), "proj");
    ok(rr.base === null && rr.reason === "snapshot_entity_mismatch", `R2 保 fp 改 revision → 拒绝（reason=${rr.reason}）`);

    const tamperDelete = clone();
    delete tamperDelete.entities["task:bbbb"];
    writeSnapshot(wd, tamperDelete);
    clearEventReadCache();
    const rd = snapshotBaseFromDisk(wd, readLedger(wd), "proj");
    ok(rd.base === null && rd.reason === "snapshot_entities_key_mismatch", `R3 保 fp 删实体 → 拒绝（reason=${rd.reason}）`);

    const tamperAdd = clone();
    tamperAdd.entities["task:ghost"] = { revision: 1, type: "x", last_event_id: "z", updated_at: NOW, payload: {} };
    writeSnapshot(wd, tamperAdd);
    clearEventReadCache();
    const ra = snapshotBaseFromDisk(wd, readLedger(wd), "proj");
    ok(ra.base === null && ra.reason === "snapshot_entities_key_mismatch", `R4 保 fp 加实体 → 拒绝（reason=${ra.reason}）`);

    // 篡改过的快照绝不能被 snapshotFromLedger 当基线复用
    const viaTampered = snapshotFromLedger(wd, "proj", { generatedAt: FIXED_GEN, reuseDiskSnapshot: true });
    ok(viaTampered.origin === "full", `R5 篡改快照不被复用（origin=${viaTampered.origin}）`);
    ok(
      sameEntities(viaTampered.snapshot, buildSnapshot("proj", oracle(wd), null, FIXED_GEN)),
      "R5 回退全量后实体仍逐对象等于 oracle",
    );

    // 直接受试：verifySnapshotEntities 对篡改给出 ok:false；而 verifySnapshotSource 只证"账本未变"
    const verdict = verifySnapshotEntities(tamperAdd, readAfter.events);
    ok(verdict.ok === false, `R6 verifySnapshotEntities(篡改) → ok:false（reason=${verdict.ok ? "-" : verdict.reason}）`);
    ok(
      verifySnapshotSource(tamperAdd, readAfter.content, "proj").ok === true,
      "R6 对比：verifySnapshotSource 仍 ok（它只证账本未变，不证派生态）——漏洞正是「只信它」",
    );
    ok(
      verifySnapshotEntities(snap, readAfter.events).ok === true,
      "R6 未篡改快照 verifySnapshotEntities → ok:true（核验可判别，非一律拒）",
    );
  }

  // ════════ S. 折叠基线/快照的实体与 Map 隔离（两次 warm，改第一次返回 + 改 peek 到的基线） ════════
  console.log("[verify] ═══ S 两次 warm 的基线隔离 ═══");
  {
    const wd = workDirOf("warm-iso");
    clearEventReadCache();
    writeLedger(wd, GREEN);

    const w1 = snapshotFromLedger(wd, "proj", { generatedAt: FIXED_GEN });
    // 改第一次返回的快照实体（改值 / 换 payload / 删键 / 加键）
    w1.snapshot.entities["task:aaaa"]!.revision = 999;
    w1.snapshot.entities["task:aaaa"]!.payload = { hacked: true };
    delete w1.snapshot.entities["task:bbbb"];
    w1.snapshot.entities["task:ghost"] = { revision: 7, type: "x", last_event_id: "z", updated_at: NOW, payload: {} };

    // 再改"取到的折叠基线"（Map + 实体）——这是复审点名的污染面
    const pe = peekLedgerEntry(wd);
    ok(pe !== null && pe.foldBase !== null, "S0 缓存里确有折叠基线可改（用于证明隔离有效）");
    if (pe?.foldBase) {
      pe.foldBase.seen_keys.set("hacked-idem", 12345);
      pe.foldBase.entities["task:aaaa"]!.revision = 555;
      pe.foldBase.entities["task:bbbb"]!.payload = { poisoned: true };
      delete pe.foldBase.entities["task:bbbb"];
    }

    const w2 = snapshotFromLedger(wd, "proj", { generatedAt: FIXED_GEN });
    ok(
      sameEntities(w2.snapshot, buildSnapshot("proj", oracle(wd), null, FIXED_GEN)),
      "S1 改第一次返回 + 改 peek 到的基线后，warm2 仍逐对象等于 oracle（基线未被污染）",
    );
    ok(w2.snapshot.entities["task:aaaa"]!.revision === 2 && w2.snapshot.entities["task:ghost"] === undefined, "S1 被改的值/新增键未泄进 warm2");

    // 再改第二次返回，验证第三次仍干净（不止一次 warm）
    w2.snapshot.entities["task:aaaa"]!.revision = 777;
    const pe2 = peekLedgerEntry(wd);
    if (pe2?.foldBase) pe2.foldBase.seen_keys.set("again", 1);
    const w3 = snapshotFromLedger(wd, "proj", { generatedAt: FIXED_GEN });
    ok(
      sameEntities(w3.snapshot, buildSnapshot("proj", oracle(wd), null, FIXED_GEN)),
      "S2 连改两次返回后 warm3 仍等于 oracle",
    );
    ok(w3.origin === "incremental" && w3.folded_events === 0, `S2 内容未变：仍走增量、折 0 条（folded=${w3.folded_events}）`);
  }

  // ════════ P. 持续追加（短读/文件在变）→ 重试后仍不稳定 → 明确 LEDGER_UNSTABLE，不返回混合事件 ════════
  console.log("[verify] ═══ P 持续追加 → 明确拒绝（不返回混合状态） ═══");
  {
    const wd = workDirOf("unstable");
    // 账本足够大，使一次全量扫描明显慢于追加间隔 → 每次扫描期间文件都会变大 → 重试后仍不稳定
    const N = 6000;
    const pad = "y".repeat(1500);
    const big: WorkEvent[] = [];
    for (let i = 1; i <= N; i++) {
      const e = ev(i, `task:u${i % 200}`, Math.floor((i - 1) / 200) + 1, i % 2 ? "executing" : "blocked");
      (e.payload as Record<string, unknown>).pad = pad;
      big.push(e);
    }
    writeLedger(wd, big);
    clearEventReadCache();

    // 持续追加（每 1ms 一条）
    const appender = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require('fs');const f=${JSON.stringify(eventsPath(wd))};let i=${N + 1};` +
          `const t=setInterval(()=>{const e={schema_version:2,event_id:'ev-'+i,project_id:'fixture',change_id:'chg-fixture',` +
          `entity_id:'task:u'+(i%200),entity_revision:Math.floor((i-1)/200)+1,seq:i,type:'task.status_changed',actor_id:'fixture-executor',` +
          `role:'executor',occurred_at:${JSON.stringify(NOW)},received_at:${JSON.stringify(NOW)},idempotency_key:'idem-'+i,payload:{status:'blocked'}};` +
          `try{fs.appendFileSync(f,JSON.stringify(e)+'\\n')}catch{};i++;if(i>${N + 6000}){clearInterval(t);process.exit(0)}},1);`,
      ],
      { stdio: "ignore" },
    );

    // 等子进程真正开始写，避免"读发生在第一次追加之前"造成偶发成功
    await new Promise((r) => setTimeout(r, 150));

    let threw = 0;
    let returned = 0;
    let other = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 400) {
      try {
        const r = readLedger(wd);
        returned += 1;
        // 任何"返回"的读都必须能重放（不是混合现场）
        replayEvents(r.events);
      } catch (e) {
        if (e instanceof WorkError && e.code === "LEDGER_UNSTABLE") threw += 1;
        else other += 1;
      }
    }
    appender.kill();
    ok(
      threw > 0 && other === 0,
      `P1 持续追加期间读 ${threw + returned} 次 → 明确抛 LEDGER_UNSTABLE ${threw} 次、无其它错误（返回 ${returned} 次）`,
    );

    // 写入停止后：清缓存再读，必须完整且与 oracle 一致（不留下被污染的旧前缀）
    await new Promise((r) => setTimeout(r, 120));
    clearEventReadCache();
    const quiet = readLedger(wd);
    ok(
      sameEventsChunked(quiet.events, oracle(wd)),
      `P2 停止写入后清缓存重读：与全量 oracle 逐条一致（${quiet.events.length} 条）`,
    );
    ok(quiet.tail === null && quiet.origin === "full", "P2 安静读无半截尾、从零全量建立");
  }

  // ════════ O. 扫描期间文件在变：不崩、不缓存、最终正确 ════════
  console.log("[verify] ═══ O 并发写入（文件在变） ═══");
  {
    const wd = workDirOf("changing");
    const N0 = 400;
    const base: WorkEvent[] = [];
    for (let i = 1; i <= N0; i++) base.push(ev(i, `task:t${i % 50}`, Math.floor((i - 1) / 50) + 1, i % 2 ? "executing" : "blocked"));
    writeLedger(wd, base);
    clearEventReadCache();

    const appender = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require('fs');const f=${JSON.stringify(eventsPath(wd))};let i=${N0 + 1};` +
          `const t=setInterval(()=>{const e={schema_version:2,event_id:'ev-'+i,project_id:'fixture',change_id:'chg-fixture',` +
          `entity_id:'task:t'+(i%50),entity_revision:Math.floor((i-1)/50)+1,seq:i,type:'task.status_changed',actor_id:'fixture-executor',` +
          `role:'executor',occurred_at:${JSON.stringify(NOW)},received_at:${JSON.stringify(NOW)},idempotency_key:'idem-'+i,payload:{status:'blocked',note:'appended'}};` +
          `try{fs.appendFileSync(f,JSON.stringify(e)+'\\n')}catch{};i++;if(i>${N0 + 400}){clearInterval(t);process.exit(0)}},1);`,
      ],
      { stdio: "ignore" },
    );

    let reads = 0;
    let corrupt = 0;
    let unstableThrows = 0;
    const t0 = performance.now();
    let during = 0;
    while (performance.now() - t0 < 700) {
      try {
        const r = readLedger(wd);
        during = Math.max(during, r.events.length);
        // 内部一致性：凡"返回"的读都必须能重放（seq/revision/幂等键不变量），证明不是混合现场
        replayEvents(r.events);
        reads += 1;
      } catch (e) {
        if (e instanceof WorkError && e.code === "MIDDLE_CORRUPT") corrupt += 1;
        // 文件在变、重试后仍不稳定：明确拒绝（V09-38 复审修正），不算失败
        else if (e instanceof WorkError && e.code === "LEDGER_UNSTABLE") unstableThrows += 1;
        else throw e;
      }
    }
    appender.kill();
    // 等写入停下，再取一次安静读数
    const t1 = performance.now();
    appender.on("exit", () => {});
    while (performance.now() - t1 < 300) {
      try {
        fs.appendFileSync(eventsPath(wd), "");
      } catch {
        /* ignore */
      }
      break;
    }

    ok(corrupt === 0, `O1 并发追加期间成功 ${reads} 次 / 明确拒绝 ${unstableThrows} 次：0 次误判中段损坏（不崩、不把半行当中段坏）`);
    ok(reads + unstableThrows > 0, `O1 并发期间确实走了真实读取路径（成功 ${reads}，明确拒绝 ${unstableThrows}，最多看到 ${during} 条）`);

    clearEventReadCache();
    const quiet = readLedger(wd);
    ok(
      sameEventsChunked(quiet.events, oracle(wd)),
      "O2 写入停止后一次安静读：与全量 oracle 逐条一致（没有留下旧绿/半截事件）",
    );
    ok(quiet.tail === null, "O2 安静读无半截尾");
  }

  // ════════ Q. 超预算（> 单条上限）的真实大账本：正确退化 ════════
  console.log("[verify] ═══ Q 超预算大账本退化 ═══");
  {
    const wd = workDirOf("overbudget");
    const file = eventsPath(wd);
    const N = 15000;
    const big: WorkEvent[] = [];
    const pad = "x".repeat(5000);
    for (let i = 1; i <= N; i++) {
      const e = ev(i, `task:b${i % 500}`, Math.floor((i - 1) / 500) + 1, i % 2 ? "executing" : "blocked");
      (e.payload as Record<string, unknown>).pad = pad;
      big.push(e);
    }
    fs.writeFileSync(file, big.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    const fileBytes = fs.statSync(file).size;
    clearEventReadCache();
    const r1 = readLedger(wd);
    const entries = eventReadCacheStats().entries;
    ok(
      fileBytes > 64 * 1024 * 1024 && r1.origin === "full" && entries === 0,
      `Q1 ${(fileBytes / 1048576).toFixed(1)} MB > 单条 64 MiB 上限 → 不缓存（entries=${entries}），按全量给出`,
    );
    const t = performance.now();
    const r2 = readLedger(wd);
    const ms2 = performance.now() - t;
    ok(r2.origin === "full" && r2.reparsed_events === N, `Q2 超预算账本每次全量重解析（reparsed=${r2.reparsed_events}，${ms2.toFixed(0)} ms）`);
    ok(
      r2.events.length === N && sameEventsChunked(r2.events, oracle(wd)),
      "Q2 退化后事件仍与全量 oracle 逐条一致（不崩、不旧绿）",
    );
    fs.rmSync(file, { force: true });
  }

  // ════════ M. 真机基准：只读冻结镜像 ════════
  console.log("[verify] ═══ M 冻结镜像真机基准（只读） ═══");
  if (!fs.existsSync(eventsPath(MIRROR_WORKDIR))) {
    skip(`M 冻结镜像不存在：${MIRROR_WORKDIR}（跳过真机基准）`);
  } else {
    const mirrorFile = eventsPath(MIRROR_WORKDIR);
    const mirrorBytes = fs.statSync(mirrorFile).size;
    const ms = (fn: () => void): number => {
      const t0 = performance.now();
      fn();
      return performance.now() - t0;
    };
    const gc = (): void => {
      const g = (globalThis as { gc?: () => void }).gc;
      if (typeof g === "function") g();
    };

    const warmupFull = loadEventsFull(MIRROR_WORKDIR);
    const mirrorEventCount = warmupFull.events.length;
    info(`M 冻结镜像：${(mirrorBytes / 1048576).toFixed(2)} MB / ${mirrorEventCount} 事件（只读；路径 ${MIRROR_WORKDIR}）`);

    // 单个缓存条目驻留内存 = 一次冷读建立缓存后的 RSS 增量（**不是**磁盘字节）。
    // 需要 `node --expose-gc` 才有意义；无 gc 时数字仅供参考。
    clearEventReadCache();
    gc();
    const rssBefore = rssMb();
    const heapBefore = heapMb();
    const tCold1 = ms(() => void loadEvents(MIRROR_WORKDIR));
    gc();
    const rssResident = rssMb();
    const heapResident = heapMb();
    info(
      `M 单条缓存驻留：冷读 ${tCold1.toFixed(0)} ms；RSS ${rssBefore.toFixed(1)} → ${rssResident.toFixed(1)} MB（+${(rssResident - rssBefore).toFixed(1)}），` +
        `heap ${heapBefore.toFixed(1)} → ${heapResident.toFixed(1)} MB（+${(heapResident - heapBefore).toFixed(1)}）｜磁盘字节 ${(mirrorBytes / 1048576).toFixed(2)} MB`,
    );
    if (typeof (globalThis as { gc?: () => void }).gc !== "function") {
      info("M 提示：未加 --expose-gc，驻留增量含未回收垃圾，仅供参考；用 node --expose-gc --import tsx 复跑可得到更干净的读数");
    }

    // 全量 oracle 冷读 5 次（独立实现，不查缓存）
    const fullSamples: number[] = [];
    for (let i = 0; i < 5; i++) fullSamples.push(ms(() => void loadEventsFull(MIRROR_WORKDIR)));

    // loadEvents（生产入口）冷读 5 次：每次先清空缓存
    const coldSamples: number[] = [];
    for (let i = 0; i < 5; i++) {
      clearEventReadCache();
      coldSamples.push(ms(() => void loadEvents(MIRROR_WORKDIR)));
    }

    // loadEvents 暖读 30 次：内容未变，应复用解析、只哈希
    clearEventReadCache();
    loadEvents(MIRROR_WORKDIR); // 暖机（建立缓存条目）
    const before = eventReadCacheStats();
    const warmSamples: number[] = [];
    for (let i = 0; i < 30; i++) warmSamples.push(ms(() => void loadEvents(MIRROR_WORKDIR)));
    const after = eventReadCacheStats();

    const stat = (xs: number[]): { p50: number; p95: number; max: number; min: number } => {
      const s = [...xs].sort((a, b) => a - b);
      const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
      return { p50: q(0.5), p95: q(0.95), max: s[s.length - 1]!, min: s[0]! };
    };
    const f = stat(fullSamples);
    const c = stat(coldSamples);
    const w = stat(warmSamples);
    info(`M loadEventsFull 冷 x5: ${fullSamples.map((x) => x.toFixed(0)).join(" / ")} ms → p50 ${f.p50.toFixed(0)} p95 ${f.p95.toFixed(0)} max ${f.max.toFixed(0)}`);
    info(`M loadEvents    冷 x5: ${coldSamples.map((x) => x.toFixed(0)).join(" / ")} ms → p50 ${c.p50.toFixed(0)} p95 ${c.p95.toFixed(0)} max ${c.max.toFixed(0)}`);
    info(`M loadEvents    暖 x30: ${warmSamples.map((x) => x.toFixed(1)).join(" / ")} ms → p50 ${w.p50.toFixed(1)} p95 ${w.p95.toFixed(1)} max ${w.max.toFixed(1)}`);
    const dReparsed = after.reparsed_events - before.reparsed_events;
    const dHashed = after.hashed_bytes - before.hashed_bytes;
    const dReused = after.reused_events - before.reused_events;
    info(`M 暖读计数校准：30 次共 reparsed=${dReparsed}（应为 0）、reused=${dReused}（应为 30×${mirrorEventCount}）、hashed=${dHashed} 字节（应为 30×${mirrorBytes}）`);
    info(`M 缓存条目：entries=${after.entries} bytes=${after.bytes}（磁盘字节预算 ${after.max_total_bytes}）`);

    ok(dReparsed === 0 && dReused === 30 * mirrorEventCount, "M1 暖读 30 次：0 次重解析、30×N 次复用（真的只哈希不解析）");
    ok(dHashed === 30 * mirrorBytes, "M1 暖读 30 次：恰好哈希 30×文件字节（每次都核验真实字节，成本如实）");
    ok(mirrorBytes <= 64 * 1024 * 1024 ? after.entries === 1 : after.entries === 0, "M2 53 MB 冻结账本按单条上限决定是否入缓存（本机条目数如实）");
    ok(
      sameEventsChunked(loadEvents(MIRROR_WORKDIR).events, warmupFull.events),
      "M3 loadEvents 与 loadEventsFull 在冻结镜像上逐条一致（接入不改语义）",
    );
    ok(
      w.p50 < c.p50,
      `M4 暖读 p50(${w.p50.toFixed(1)}ms) 低于冷读 p50(${c.p50.toFixed(1)}ms)：复用确实省下解析`,
    );
  }

  console.log("[verify] ═══ 收尾 ═══");
  const fin = eventReadCacheStats();
  info(
    `累计：reads=${fin.reads} full=${fin.full_reads} incremental=${fin.incremental_reads} empty=${fin.empty_reads} ` +
      `reparsed=${fin.reparsed_events} reused=${fin.reused_events} hashed=${fin.hashed_bytes} fell_back=${fin.fell_back} unstable=${fin.unstable_reads}`,
  );
} finally {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 收尾失败不影响结论 */
  }
}

console.log(`\n[verify] 小结：PASS ${pass}，FAIL ${fails.length}${skips.length > 0 ? `，SKIP ${skips.length}` : ""}`);
if (fails.length > 0) {
  console.log("[verify] FAIL 明细：\n  - " + fails.join("\n  - "));
  process.exitCode = 1;
} else if (skips.length > 0) {
  console.log("[verify] 结果: 全部 PASS（有 SKIP）");
  process.exitCode = 3;
} else {
  console.log("[verify] 结果: 全部 PASS");
}
