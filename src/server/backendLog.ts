// U2：打包态后端日志落盘（PLAN.md 三期 U2 DoD①「日志目录落在全局数据目录」）。
//
// ██ 为什么要这一层 ██
// 桌面壳的 release 产物是 Windows GUI 子系统（`src-tauri/src/main.rs` 的 `windows_subsystem = "windows"`），
// 用户双击启动时**没有控制台**——`backend.rs` 把后端 stdout/stderr 转发到壳的 stdout，那份输出在双击
// 场景下无处可去，排障时一片空白（「让唯一的用户看得见」不能只在有控制台时成立）。
// 壳的打包分支因此置 `TATAI_LOG_TO_FILE=1` 打开本开关（见 backend.rs 的 `spawn`）；
// **dev（debug 构建）不置位**，行为与 U2 之前逐字相同——本层不改变任何 stdout 内容，只多抄一份副本。
//
// ██ 落盘位置 ██
// `<全局数据目录>/logs/backend.log`（DESIGN.md §8.1 第一层；路径唯一来源是 `registry.resolveDataDir`，
// 本文件不自己拼 home 目录）。**绝不写进应用安装目录**（那是卸载即丢的地方，U2 红线），也不写进任何
// 被纳管项目的 `.工作台/`——那是项目私有数据的位（§2.2），壳级日志不属于任何一个项目。
//
// ██ 增长控制 ██
// 只追加（`append`）；单文件超 MAX_LOG_BYTES 时在**启动时**滚动成 `backend.log.1`（覆盖旧归档一份，
// 与 E3 命令历史的滚动同一手法，不引入日志框架）。
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./registry";
import { nowIso } from "./time";

/** 全局数据目录下的日志子目录名（§8.1 第一层） */
export const LOG_DIR_NAME = "logs";
/** 壳级后端日志文件名 */
export const LOG_FILE_NAME = "backend.log";
/** 单文件滚动阈值：超过即滚动成 backend.log.1（预留，日志只是排查副本不无限膨胀） */
export const MAX_LOG_BYTES = 1024 * 1024;

/** 打开开关的环境变量名（由 `src-tauri/src/backend.rs` 的打包分支置位，口径与那边注释成对） */
export const LOG_TO_FILE_ENV = "TATAI_LOG_TO_FILE";

function rotateIfNeeded(file: string): void {
  if (!fs.existsSync(file)) return;
  if (fs.statSync(file).size < MAX_LOG_BYTES) return;
  fs.renameSync(file, `${file}.1`);
}

/** 日志 fd（`TATAI_LOG_TO_FILE=1` 未开启时恒为 null）：Q81 起同步写、关进程前 fsync + close */
let logFd: number | null = null;
/** 日志健康位：写失败一次就整体停写（stdout/stderr 本身照常）——日志是旁路，绝不拖累后端本体 */
let logDead = false;

/**
 * 把一个标准流（stdout/stderr）的写出内容同时抄进日志文件；返回还原函数（验证脚本用得上）。
 *
 * Q81（2026-09-18 审计）：日志此前走 `fs.createWriteStream` 的**异步写**，而收窗是
 * `taskkill /T /F`（TerminateProcess，信号处理器与 `process.on("exit")` 都没机会跑）——
 * 于是"已 write() 还压在 Node Writable 队列 / libuv 未完成的 fs.write 请求里"的那截字节随进程一起没了，
 * 谁也不知道日志尾部少了什么。现在**同步写**（`fs.writeSync(fd)`）：writeSync 返回时字节已交给内核，
 * 进程再被强杀也丢不掉；代价是每次输出一次写系统调用——日志只在打包态开（`TATAI_LOG_TO_FILE=1`）、
 * 频率是启动行与告警级，同步写完全吃得下。
 * 另配 `closeBackendLog()`（fsync + close）给优雅退出路径收尾，保证连掉电都不丢最后几行。
 *
 * Q21（2026-09-18 审计）的结论在这里一并满足：写失败**同步抛出**（ENOSPC/EBUSY/EPERM/EISDIR…），
 * 由下面的 try/catch 吞掉并停写——既不会变成 uncaughtException（那会撞上 index.ts 的
 * `process.exit(1)`，打包态后端永久下线），也不会回写已坏的日志形成回路。
 */
function tee(target: NodeJS.WriteStream, fd: number): () => void {
  const original = target.write.bind(target);
  target.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (!logDead) {
      try {
        // 同步写（口径见上）；string 与 Buffer 两条重载分别走，别用联合类型（fs.writeSync 不认）
        if (typeof chunk === "string") fs.writeSync(fd, chunk);
        else fs.writeSync(fd, chunk);
      } catch (e) {
        logDead = true; // 写不进去就停写：同步写没有异步 error 事件，这里是唯一的失败出口
        // 一次性诊断（logDead 已置位，这条不会再回写日志文件，直接到真实 stderr）
        process.stderr.write(
          `[tatai-server] 后端日志落盘失败，已停写该日志文件（进程继续，stdout/stderr 本身不受影响）：${(e as Error).message}\n`,
        );
      }
    }
    return (original as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof target.write;
  return () => {
    target.write = original;
  };
}

/**
 * 按 `TATAI_LOG_TO_FILE=1` 决定是否把 stdout/stderr 抄一份到 `<全局数据目录>/logs/backend.log`。
 * 返回落盘路径；未开启返回 null。调用点 = `src/server/index.ts` 进程启动处（越早越好，
 * 保证「listening on…」这类启动行也进日志）。
 */
export function teeBackendLog(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env[LOG_TO_FILE_ENV] !== "1") return null;
  const dir = path.join(resolveDataDir(env), LOG_DIR_NAME);
  const file = path.join(dir, LOG_FILE_NAME);
  // Q130（2026-09-19 审计）：mkdir / 滚动 / open 此前在**模块顶层**裸跑（`index.ts` 启动第一行就调本函数），
  // 任何一步抛错（日志目录被一个文件占着 → ENOTDIR、EACCES、ENOSPC…）都让**整个后端起不来**，
  // 而且异常发生在 listen 之前、`uncaughtException` 处理器注册之前——零输出、未绑端口、进程没了。
  // 打包态（GUI 子系统无控制台）下就是"双击没反应、什么线索都没有"，与本文件的口径
  // 「日志是旁路，绝不拖累后端本体」直接矛盾。现在整段收在 try 里：写不进去就**如实打一行**
  // （走真实 stderr，tee 还没生效）并返回 null，后端照常启动。
  try {
    fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded(file);
    logFd = fs.openSync(file, "a");
  } catch (e) {
    logFd = null;
    logDead = true; // 没开成：后续写入一律走 stdout/stderr 本体
    process.stderr.write(
      `[tatai-server] 后端日志落盘不可用（已跳过文件日志，进程照常启动）：${file} —— ${(e as Error).message}\n`,
    );
    return null;
  }
  logDead = false;
  tee(process.stdout, logFd);
  tee(process.stderr, logFd);
  // 这一行本身也会进日志（tee 已生效），作为每次启动的分隔标记
  console.log(`===== 塔台后端启动 ${nowIso()} pid=${process.pid} =====`);
  return file;
}

/**
 * 日志收尾（Q81）：把日志文件 fsync 到盘再关掉 fd——优雅退出路径调用（`index.ts` 的
 * `process.on("exit")`，信号退出与 `process.exit()` 都会经过那里）。幂等；未开日志时是空操作。
 * 收尾失败（个别文件系统不支持 fsync 等）只尽力而为：日志是旁路，别让它影响退出。
 */
export function closeBackendLog(): void {
  if (logFd === null) return;
  const fd = logFd;
  logFd = null;
  logDead = true; // 关掉之后不再往日志写（stdout/stderr 本身不受影响）
  try {
    // 收尾标记：与启动行成对，日志"到哪儿结束"有据可查（也是这条收尾路径真跑过的证据）
    fs.writeSync(fd, `===== 塔台后端日志收尾（fsync + close）pid=${process.pid} ${nowIso()} =====\n`);
  } catch {
    // 写不进就不写，收尾照做
  }
  try {
    fs.fsyncSync(fd);
  } catch {
    // 尽力而为：fsync 不被支持/失败都不拦住关闭
  }
  try {
    fs.closeSync(fd);
  } catch {
    // 同上
  }
}
