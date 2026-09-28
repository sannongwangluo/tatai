import fs from "node:fs";
import path from "node:path";

// 跨进程文件互斥（Q23，2026-09-18 审计）。
//
// 为什么需要：HTTP 后端与各 agent 的 MCP 进程是**独立进程**（src/mcp/server.ts 自述），却读写
// 同一份 registry.json / agents.json / 各项目 `.工作台/` 下的 tasks.json、progress.json。
// 这些写入一律是"读全文 → 改内存 → 整份 rename"，此前没有任何互斥：两个进程在「读—写」窗口内
// 交错就会**丢更新**（新增项目消失、last_active_at 回退、任务状态被覆盖）。
//
// 手段：在目标文件旁建 `<目标>.lock`（`openSync(..., "wx")` = O_EXCL 创建，Windows / POSIX 都认），
// 零依赖、不引 lockfile 库（与仓内"不引清单外依赖"一致）。锁只圈住"读—改—写"这一小段，
// 中间不掺 IO 等待，故持锁时间在毫秒级。
//
// 两条不硬失败的口径：
//   1) 拿不到锁**等**，不是直接报错——同步等待用 `Atomics.wait` 睡（Node 主线程允许，不空转烧 CPU）；
//   2) 等到超时就抛错（宁可不写，也不写坏数据）；错误是普通 Error（服务端自身竞争态，HTTP 落 500
//      INTERNAL 并过消息级脱敏），不作为用户输入类错误——故本模块不 import WsError（避免与
//      workstation.ts 形成循环 import）。
//
// 崩溃兜底：持锁进程被 kill 会留下锁文件。故按 mtime 判**陈旧锁**（超过 LOCK_STALE_MS 直接抢占，
// 并打一行日志）——一次崩溃不会把某个文件永久锁死。
//
// Q135（2026-09-19 审计）：这里原先宣称"等待超时（LOCK_TIMEOUT_MS）小于陈旧阈值，保证'锁在、进程真死了'时
// 最多等一个超时周期就能自愈"——**因果写反了**：陈旧判定就在等待循环内部，而等待上限（2s）**小于**
// 陈旧阈值（10s）⇒ 面对"刚死 3 秒的持锁进程"，等待者先撞超时抛错，而不是等到锁被判陈旧后自愈。
// 要让那句话成立，得 `LOCK_TIMEOUT_MS > LOCK_STALE_MS`（或把陈旧阈值压到等待上限以下），
// 两个方向各有代价，属**设计裁决**（本处不改数值、不改同步语义）：
//   · 抬等待上限 ⇒ 同步等待把事件循环冻得更久（`sleepSync` 就是 `Atomics.wait`，整服务停摆，
//     探针：300ms 等待把 50ms 定时器拖到 302ms；争用时最长冻结 LOCK_TIMEOUT_MS）；
//   · 压陈旧阈值 ⇒ 可能把**活着**的持锁进程的锁判成陈旧后抢占，两个写者交错 = 丢更新（正是本锁要防的事）。
// 彻底解法是把锁改成异步（等待期让出事件循环），但那要动 `registry` / `agents` / `workstation`
// 全链路的同步 API（连 `scripts/verify-*.ts` 的单元级调用点都要跟着改）——已按"架构级"上报，不在此硬修。

/** 抢锁重试间隔（ms） */
const LOCK_RETRY_MS = 5;
/**
 * 抢锁等待上限（ms）。Q135：本值**小于** LOCK_STALE_MS——所以"陈旧锁自愈"不会发生在等待窗口内
 * （等待者先撞超时；文件头记了这条因果与两个可选方向的代价）。
 */
const LOCK_TIMEOUT_MS = 2_000;
/** 超过这个年龄的锁文件视为陈旧（持锁进程大概率已死），可直接抢占 */
const LOCK_STALE_MS = 10_000;

/** 同步睡（Node 主线程支持 Atomics.wait，避免 try-lock 空转烧 CPU） */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 在 `target` 的跨进程互斥下执行 `fn`（同步；fn 里只做"读—改—写"，别放长 IO 等待）。
 * 同进程内同样受锁约束（锁文件是文件系统对象，不区分进程），故**不可重入**：fn 里不要再锁同一个 target。
 */
export function withFileLock<T>(
  target: string,
  fn: () => T,
  timeoutMs: number = LOCK_TIMEOUT_MS,
): T {
  const lock = `${target}.lock`;
  const deadline = Date.now() + timeoutMs;
  // 目标目录可能还不存在（首次写注册表/项目 .工作台/ 之前）——锁文件先落在同一个目录里
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd = -1;
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx");
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // Windows 实测：锁文件已被别的进程持有（未共享删除）时，`wx` 报的是 EPERM/EACCES 而不是 EEXIST，
      // 且它与"持锁方刚好删掉锁文件"能同时发生——所以不能靠 existsSync 当场判定。
      // 判据改成"目录本身可写吗"：可写还拿到 EPERM/EACCES ⇒ 是竞争（重试）；不可写 ⇒ 真错误，照抛。
      const contention =
        code === "EPERM" || code === "EACCES"
          ? (() => {
              try {
                fs.accessSync(path.dirname(lock), fs.constants.W_OK);
                return true;
              } catch {
                return false;
              }
            })()
          : false;
      if (code !== "EEXIST" && !contention) throw e;
      // 陈旧锁：持锁进程被 kill 时锁文件会留下，按 mtime 抢占（不静默——打一行日志）
      let stale = false;
      try {
        const st = fs.statSync(lock);
        stale = Date.now() - st.mtimeMs > LOCK_STALE_MS;
        if (stale) {
          console.warn(
            `[lock] 抢占陈旧锁 ${lock}（mtime ${st.mtime.toISOString()}，疑似持锁进程已死）`,
          );
        }
      } catch {
        // 锁刚被释放：下一轮重试即可
      }
      if (stale) {
        try {
          fs.rmSync(lock, { force: true });
        } catch {
          // 抢不掉（仍被持有等）：下一轮重试，超时由下面的 deadline 兜住
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `等待文件锁超时（${timeoutMs}ms）: ${lock}——另一个进程正在写同一份数据，稍后重试`,
        );
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }
}
