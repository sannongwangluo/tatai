// U1（三期第 1 卡）：桌面壳环境探测——**极薄一层，只回答两个问题**：
//   ① 现在是不是跑在 Tauri 壳里；② 壳内 /api 该打到哪个 origin。
// 界面结构、组件树、路由一行都不动：壳内与浏览器里跑的是同一份 `src/ui`（U1 DoD①）。
//
// 为什么需要它：浏览器里 `/api` 走 vite 代理（vite.config.ts）或同源；
// 壳里前端由 Tauri 从 `dist/` 直接喂给 WebView，没有代理，origin 是 `http://tauri.localhost`，
// 相对路径 `/api/...` 会打到 WebView 自己身上——所以要显式指向壳拉起的本地服务。
// 后端 origin 白名单同口径见 src/server/index.ts 的 applyShellCors。

/** 壳内默认后端地址：端口与 Rust 侧 DEFAULT_PORT（src-tauri/src/backend.rs）、后端缺省端口三方同口径。 */
const SHELL_API_ORIGIN = "http://127.0.0.1:8787";

/** 是否跑在 Tauri 壳里。Tauri v2 恒注入 `__TAURI_INTERNALS__`；`__TAURI__` 只有开 withGlobalTauri 才有。 */
export function isTauriShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 壳在运行期注入的实际后端地址（`TATAI_PORT` 覆盖时与 `SHELL_API_ORIGIN` 不同）。
 * 写入方是 Rust 侧的初始化脚本 `backend.rs::api_origin_init_script`——页面脚本执行前注入，
 * 所以这里一定读得到；注入缺失/值非法（旧壳、手改）时返回 null，调用方退回缺省地址。
 */
function runtimeApiOrigin(): string | null {
  if (typeof window === "undefined") return null;
  const injected = (window as Window & { __TATAI_API_ORIGIN__?: unknown }).__TATAI_API_ORIGIN__;
  return typeof injected === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(injected) ? injected : null;
}

/**
 * API 基址前缀。非壳内返回空串——保持相对路径，浏览器里的行为与 U1 之前**逐字相同**，零影响。
 * 壳内再分两种：
 *   - dev（`tauri dev`，窗口加载的就是 vite dev server 的 5173）：也返回空串，/api 走 vite 代理，
 *     与浏览器完全同路（HMR 环境下改端口/改代理口径只需动 vite.config.ts 一处）；
 *   - 打包（`tauri build`，窗口加载 dist/，没有代理）：返回壳拉起的后端绝对地址——**优先用壳注入的
 *     实际地址**（`TATAI_PORT` 覆盖时对得上），没有注入才退回缺省。
 * VITE_TATAI_API_BASE 是构建期/验证脚本的显式覆盖（自定义端口、跨机调试时用），优先级最高。
 */
export function apiBase(): string {
  const override = import.meta.env.VITE_TATAI_API_BASE;
  if (override) return override;
  if (!isTauriShell()) return "";
  if (import.meta.env.DEV) return "";
  return runtimeApiOrigin() ?? SHELL_API_ORIGIN;
}
