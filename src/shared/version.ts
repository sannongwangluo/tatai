// 产品版本号的**唯一来源**：一律读仓库根 `package.json` 的 `version`，代码里不再各处置字面量。
//
// 为什么这样写，随包产物放到任意目录也照样对（U2：`src-tauri/resources/server/` 被装到
// `%LOCALAPPDATA%\Tatai\server\`，那里和它的上级都没有任何 package.json）：
//   · 这是**构建期内联**——`pnpm build:server` 的 vite SSR 构建（mcp.js / index.js）与 `pnpm build`
//     的前端构建都会把这个 JSON 模块的内容直接烙进产物，包里是版本字符串本身，不是一次文件读取；
//   · `pnpm mcp`（tsx 直跑源码）在读源码时就解析成同一个字面量。
//   所以运行时**不读文件、不猜路径**——早先这个版本号在 `src/mcp/server.ts` 与界面页脚各写死一次
//   （当时写死的那个版本号），bump 时就漏了一处，这里收成唯一来源。
//
// 它与 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 的一致性
// 由 `scripts/verify-version-consistency.ts` 对账（一处读取、其余对账，不做代码生成）。
import { version } from "../../package.json";

export const APP_VERSION: string = version;
