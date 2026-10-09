import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// P0/V09-45：构建身份（docs/agent-optimization-20261006.md §4）。`vite build` 时把身份经 define
// 编译期内联进前端产物；dev（serve）**不内联**——源码直跑的界面如实报 unknown，不拿构建身份冒充。
import { buildDefineConfig, deriveIdentity, detectInputDrift, reconcileInputs, UI_BUILD_TARGET } from "./scripts/lib/buildIdentity";

// 前端 dev 端口 5173；后端骨架见 src/server/index.ts（端口 8787，pnpm dev:server）
// 后端端口可用 TATAI_DEV_API_PORT 覆盖（默认 8787）：验证脚本按动态空闲端口起后端时要让代理跟着走，
// 否则界面上所有 /api 请求都会打到别人的 8787（F4：verify 脚本不许占用固定端口）。
// 没设 TATAI_DEV_API_PORT 时再认 TATAI_PORT——那是壳的覆盖变量（src-tauri/src/backend.rs 的 port()），
// `pnpm tauri:dev` 带着 TATAI_PORT=9000 起时代理要跟着到 9000，否则 dev 态与打包态一样前后端错位（Q36）。
//
// U1（三期）：这三处口径与桌面壳对齐，改一处要改三处——
//   ① 端口 5173 = src-tauri/tauri.conf.json 的 build.devUrl；strictPort 保证壳不会指到空端口；
//   ② 产物目录 dist/ = tauri.conf.json 的 build.frontendDist（壳里加载的是同一份产物，不是另一套 UI）；
//   ③ 壳内没有 vite 代理，/api 的绝对基址由 src/ui/tauri-env.ts 给（见 src/ui/api.ts 的 apiFetch）。
const API_PORT = process.env.TATAI_DEV_API_PORT ?? process.env.TATAI_PORT ?? "8787";
const UI_PORT = 5173;
// V09-26 验证隔离：node_modules 是对真实 D:/tatai 的 junction，vite 默认依赖预打包缓存会写到共享的
// node_modules/.vite——并发跑验证脚本会互相/与真实环境打架。测试脚本用 TATAI_VITE_CACHE_DIR 指到
// 隔离目录；不设时行为逐字不变（默认 node_modules/.vite）。
const CACHE_DIR = process.env.TATAI_VITE_CACHE_DIR;

/**
 * P0/V09-45 构建后清单漂移检测（§4.2）：把**实际打进前端产物的模块清单**与 ui 显式输入集比对，
 * 仓库内、清单外的模块 ⇒ 抛错中止构建（"显式清单悄悄过期"不变假绿）。第三方（node_modules）与
 * Node 内建排除在清单外判定之外；仓库内模块落在输出目录（自指）同样中止。
 */
function buildInputDriftGuard(root: string): Plugin {
  return {
    name: "tatai-build-input-drift-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const ids: string[] = [];
      for (const out of Object.values(bundle)) {
        if (out.type !== "chunk") continue;
        ids.push(...Object.keys(out.modules ?? {}));
      }
      const drift = detectInputDrift("ui", ids, root);
      if (!drift.ok) {
        throw new Error(
          `[ui] 构建输入清单漂移：清单外仓库内模块 [${drift.outside.join(", ") || "无"}]、` +
            `输出自指模块 [${drift.output_self_reference.join(", ") || "无"}]、` +
            `未声明外部源码 [${drift.external_undeclared.join(", ") || "无"}]——显式输入集过期，拒绝产出（不静默放行）`,
        );
      }
    },
  };
}

export default defineConfig(({ command }) => {
  if (command !== "build") {
    return {
      plugins: [react(), tailwindcss()],
      ...(CACHE_DIR ? { cacheDir: CACHE_DIR } : {}),
      server: {
        // U1：devUrl 写死 5173，端口被占时宁可报错也不要悄悄换端口（换了壳就白屏）
        port: UI_PORT,
        strictPort: true,
        // R3：dev 下 /api 代理到后端 8787，前端开箱即用
        proxy: {
          "/api": { target: `http://localhost:${API_PORT}`, changeOrigin: true },
        },
        // Q118（并修掉同源的 Q113）：文件监听只关心前端源码段。数据目录（`.工作台/`）、审计产物
        // （`audit/`）、Rust 构建物（`src-tauri/`）与产物目录（`dist/`）都不是前端源码，dev 期不需要
        // HMR。实测本仓库根这三个非源码目录合计 30 万+ 个文件，chokidar 初始爬取会把 dev server 启动后
        // 的头几十秒拖到 5s+ 乃至不答（curl 5s 截断、浏览器首屏 30s 超时），排除后实测卡顿归零。
        // `src/`/`index.html`/`vite.config.ts` 均不在排除表内，源码 HMR 不受影响。
        watch: {
          ignored: ["**/.工作台/**", "**/audit/**", "**/src-tauri/**", "**/dist/**"],
        },
      },
    };
  }

  // ── 构建态：冻结输入 → 推身份 → 内联 → 构建后核对清单未漂移（§4.2/§4.3/§4.4）──
  // 仓库根：vite 由 `pnpm build`/`pnpm tauri:build` 在项目根跑，配置也在这里；用 cwd 而非
  // import.meta.url（vite 会把配置打成临时文件，URL 指向临时目录）。找不到 package.json 就明确报错。
  const root = process.cwd();
  if (!existsSync(path.join(root, "package.json"))) {
    throw new Error(`[ui] 构建根 ${root} 下没有 package.json——vite build 必须在项目根运行`);
  }
  const inputs = reconcileInputs(root);
  if (inputs.drifted) {
    throw new Error(`[ui] 冻结构建输入在构建期漂移，拒绝构建：\n  - ${inputs.reasons.join("\n  - ")}`);
  }
  const derivation = deriveIdentity(root, { inputs: inputs.effective });
  console.log(
    `[ui] 构建身份：release ${derivation.release_id.slice(0, 12)}… / build ${derivation.build_id.ui.slice(0, 12)}…` +
      `（ui 输入 ${derivation.ui_input_fingerprint.slice(0, 12)}…）`,
  );

  return {
    plugins: [react(), tailwindcss(), buildInputDriftGuard(root)],
    ...(CACHE_DIR ? { cacheDir: CACHE_DIR } : {}),
    define: buildDefineConfig(derivation.identities),
    // P0/V09-45（Codex 纠正 2）：编译目标**显式声明且确实生效**——与身份里的 `toolchain.targets.ui`
    // 是同一个常量。取 vite 7 的默认值字面量，故与"不设"逐字等价；但它让"声明就是开关"，
    // 不会再出现"身份说 target=node20、前端其实不是 node20"这种标签冒充。
    build: { target: UI_BUILD_TARGET },
  };
});
