// 补修包 F（V06-08）：**可体验运行入口**的受控打开（DESIGN.md §3.7「本期使用受控外部打开方式」）。
//
// 边界（照既有两条壳内能力的口径，`external-link.ts` / `dir-picker.ts`）：
//   · **只认 http(s)**：其余协议（`javascript:` / `file:` / `data:` / `blob:` / `mailto:` / `tel:` …）
//     一律**拒绝打开**——不是"打开失败"，是连尝试都不做（返回值里就说清为什么不打开）；
//   · 壳内（Tauri）：走 `@tauri-apps/plugin-opener` 的 `openUrl`，交系统浏览器打开；壳的权限清单
//     （`src-tauri/capabilities/default.json`）**只放行 `opener:allow-open-url` 且范围限 http/https**，
//     没有路径/邮件等其它 opener 能力，所以壳里也开不出别的协议；
//   · 浏览器里：没有壳能力，降级为浏览器自己的新标签页（`window.open` + `noopener,noreferrer`）——
//     这是**如实说明的降级**，不是同一种受控：浏览器地址栏由用户自己掌控，塔台拦不住用户手动改地址。
//     两条路径共同的硬边界只有一条：**非 http(s) 的地址一个都不打开**。
//
// 这里不做 HTTP 探测（塔台不代替执行者验证入口）、不弹窗尝试、不记日志到服务端。
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauriShell } from "./tauri-env";

/** 允许打开的协议白名单（与服务端 `work/runtimeEntries.ts#isRuntimeEntryUrl` 同口径，前端独立再判一遍） */
export const RESULT_ENTRY_PROTOCOLS = ["http:", "https:"] as const;

/** 入口地址能不能打开：能返回规范化后的 url，不能返回 null（不抛，调用方按 null 走"不打开"） */
export function openableResultUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  const raw = url.trim();
  if (raw === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null; // 相对路径/畸形串：解析不出协议就不是可打开的入口
  }
  return (RESULT_ENTRY_PROTOCOLS as readonly string[]).includes(parsed.protocol) ? parsed.href : null;
}

export interface ResultEntryOpenPlan {
  /** false = **不会打开**（调用方据此提示原因，而不是"打开失败了"） */
  open: boolean;
  url: string | null;
  /** 打开方式：壳内系统浏览器 / 浏览器新标签页 */
  via: "shell_browser" | "browser_tab" | null;
  /** 不打开的原因（人话；open=true 时为 null） */
  reason: string | null;
}

/**
 * 纯决策：给一个地址与"是不是壳内"，答"该不该开、怎么开"。
 * **不产生任何副作用**（不调 opener、不 window.open），所以可以在脚本里直接断言"不会打开"这一层。
 */
export function resultEntryOpenPlan(url: string | null | undefined, opts: { shell: boolean }): ResultEntryOpenPlan {
  const safe = openableResultUrl(url);
  if (safe === null) {
    const shown = url === null || url === undefined || url.trim() === "" ? "（空地址）" : url.trim();
    return {
      open: false,
      url: null,
      via: null,
      reason: `只允许打开 http(s) 的运行入口，这个地址不会打开：${shown}`,
    };
  }
  return { open: true, url: safe, via: opts.shell ? "shell_browser" : "browser_tab", reason: null };
}

/**
 * 执行打开（唯一副作用点）。返回的是**这次的决定**（开了/没开 + 原因）：
 *   · 拒绝打开 → 原样返回，绝不做任何打开尝试；
 *   · 壳内 → 交 `openUrl`（系统浏览器）；它异步失败时**只记日志、不退回本窗口导航**
 *     （同 `external-link.ts` 的理由：宁可什么都不发生，也不把应用顶掉）；
 *   · 浏览器 → 新标签页。
 */
export function openResultEntry(url: string): ResultEntryOpenPlan {
  const plan = resultEntryOpenPlan(url, { shell: isTauriShell() });
  if (!plan.open || plan.url === null) return plan;
  if (plan.via === "shell_browser") {
    void openUrl(plan.url).catch((e: unknown) => {
      console.error(`[tatai] 打开运行入口失败（${String(e)}）：${plan.url}`);
    });
    return plan;
  }
  // 浏览器降级：新标签页（`noopener,noreferrer` ⇒ 拿不到 opener，也带不上 Referer）
  window.open(plan.url, "_blank", "noopener,noreferrer");
  return plan;
}
