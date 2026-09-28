// ═══════════════════════════════════════════════════════════════════════════════════
// F5（2026-09-18 安全审计）：错误消息级脱敏——唯一出处。
//
// 审计发现：login 的 catch、wsFail 的 500 INTERNAL、flash.ts 配置错误、watcher 的
// stats.last_error 都会把 `Error.message` 原样回显给调用方；这些消息里常常夹着**本机绝对路径**
// （ENOENT 的 `open 'C:\Users\…'`、密钥配置文件位置、监听错误的文件路径……），对远程来源
// 等于把本机目录结构递出去（DESIGN.md §10.2 私人数据隔离）。
//
// 口径：与 index.ts 的 withoutLocalPaths（写/读响应的**字段级**裁剪，F6）互补——本函数管
// "字符串里夹的路径"，把 Windows 盘符路径（`C:\…` / `D:/…`）与 UNC 路径（`\\server\share\…`）
// 整段替换成 `<path>`；消息的其余部分（错误码、原因描述）原样保留，可读性不打折。
// POSIX 形态（`/home/...`）**不**在消息层替换：消息里大量出现 URL 路径段（`/api/projects/…`），
// 一并替换会把可读错误砍成马赛克；本机形态以盘符/UNC 为主，先收这两类（审计发现的实际命中面）。
// ═══════════════════════════════════════════════════════════════════════════════════

/** UNC 形态：`\\主机名\共享\…`（至少两段，主机名/段内排除路径非法字符与引号空白截断符） */
const UNC_PATH_RE = /\\\\[^\\/:*?"'<>|\r\n]+(?:\\[^\\/:*?"'<>|\r\n]+)+/g;
/** 盘符形态：`C:\…` 或 `D:/…`（至少盘符+分隔符；段内排除路径非法字符与引号）。
 * 两个细节（2026-09-18 复审修正，均有实测用例）：
 *   · lookbehind 排除"盘符字母前面还有字母/数字"——否则 `http://` 的 `p://`、`https://` 的
 *     `s://` 会被当盘符吃掉，URL 被砍成 `htt<path>:8787`；
 *   · 中间段用 `*`（任意多段）而非 `?`（至多一段）——否则 `C:\Users\x\auth.json` 只吃到
 *     `C:\Users\x`，输出 `<path>\auth.json`：看着脱过了，文件名还漏在外面。 */
const WINDOWS_PATH_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?:[^\\/:*?"'<>|\r\n]+[\\/])*[^\\/:*?"'<>|\r\n]*/g;

/**
 * 消息级脱敏：把字符串里的本机绝对路径（盘符 / UNC）整段换成 `<path>`。
 * 幂等、零 I/O；对不含路径的字符串原样返回（同一字符集，不做多余拷贝语义上的改变）。
 *
 * Q207（2026-09-19 二轮审计）：入参在运行期**不一定是 string**——`(e as Error).message` 这种取法
 * 在 `throw "x"`、`throw null`、`reject(undefined)` 下拿到的是 undefined，旧实现 `message.replace`
 * 会在这里抛 TypeError：错误处置路径自身崩掉（wsFail 的 500 被 withWs 链报成 400，未捕获路由则
 * 直接逃逸）。所以本函数是那种取法的**单点守卫**：非 string 一律 `String(v ?? "")` 取文案，
 * 抛字符串/数字/Error 对象都留下可读原文，抛 null/undefined 退化为空串（调用方照旧写 500）。
 */
export function sanitizeErrorMessage(message: unknown): string {
  const text = typeof message === "string" ? message : String(message ?? "");
  if (text === "") return text;
  return text.replace(UNC_PATH_RE, "<path>").replace(WINDOWS_PATH_RE, "<path>");
}
