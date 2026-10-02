import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
export default defineConfig({
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
});
