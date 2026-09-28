// Q224（2026-09-19 二轮审计）：**壳内**点站外链接的处置——交系统浏览器打开，窗口自己不发导航。
//
// 现象（第 5 步②控件巡检实测，截图 R2/05-shots/02-09-站外链接点击后.png）：设计书/聊天里 markdown 渲染
// 的 `<a>` 没有 target，WebView2 就在**本窗口**里导航走——点一次 GitHub 链接，整个桌面窗口变成一页
// 网页，壳内没有返回入口，应用等于被顶掉。架构图的 React Flow 归属链接（第三方组件渲染的
// `<a target="_blank">`）同族。
//
// 口径（终审裁定）：站外链接一律 `preventDefault()` + 系统浏览器打开；壳内窗口地址栏里的东西永远
// 只有塔台自己的界面。实现取"系统浏览器"这条首选路（opener 插件，见 src-tauri/Cargo.toml 与
// capabilities/default.json），不是降级路（`target="_blank"`）：后者在壳里点下去什么都不发生。
//
// 边界：
//   · 只拦**站外 http(s)**——同源链接（塔台自己的 /api、锚点 `#x`、相对路径）原样走默认行为；
//   · 只在 Tauri 壳内装监听：浏览器里行为与本次修复前**逐字不变**（浏览器有自己的返回键，
//     把默认行为改掉反而是另一种跑偏）；
//   · 监听挂 document 捕获段而不是逐个 markdown 组件传 onClick：设计书、聊天、架构图归属链接
//     三处一次性覆盖，将来新加的 markdown 渲染处自动继承，"漏一个渲染点就再犯一次"。
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauriShell } from "./tauri-env";

/** 已装监听的 document（重复调用只装一层） */
const installed = new WeakSet<Document>();

/** 站外 http(s) 取规范化 url；站内/锚点/相对/非 http 协议一律返回 null（= 不拦） */
export function externalHttpUrl(href: string | null, base: string = window.location.href): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null; // 手改畸形窗口 hash 一类：解析不了就不是本站外链接，交给默认行为（由 Q65 的边界兜）
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.origin === new URL(base).origin) return null;
  return url.href;
}

/** 壳内站外链接的打开动作（导出是为了单测/探针直接调它，不依赖真实点击） */
export function openExternalViaSystemBrowser(url: string): void {
  void openUrl(url).catch((e: unknown) => {
    // 打不开（壳没注册插件/权限被拒）也不许退回本窗口导航：宁可什么都不发生，也不把应用顶掉
    console.error(`[tatai] 打开站外链接失败（${String(e)}）：${url}`);
  });
}

/** 装一次 document 级监听（幂等：重复调用只装一层）。main.tsx 在挂载前调用。 */
export function installExternalLinkOpener(target: Document = document): void {
  if (!isTauriShell()) return;
  if (installed.has(target)) return;
  installed.add(target);
  target.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const node = event.target;
      const anchor = node instanceof Element ? node.closest("a[href]") : null;
      if (!anchor) return;
      const url = externalHttpUrl(anchor.getAttribute("href"));
      if (!url) return;
      event.preventDefault();
      openExternalViaSystemBrowser(url);
    },
    true,
  );
}
