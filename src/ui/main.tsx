import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installExternalLinkOpener } from "./external-link";
import "./index.css";

// Q224（2026-09-19 二轮审计）：壳内站外链接交系统浏览器打开，窗口自己不发导航——装在挂载之前，
// 一次覆盖设计书/聊天/架构图所有 markdown 与第三方渲染的 <a>（口径见 src/ui/external-link.ts）。
installExternalLinkOpener();

// Q56（2026-09-18 审计）：App **自身** render 抛错时（如 Q65 手改畸形 hash 的 URIError、左栏列表
// 渲染抛错），视图区那个 <ErrorBoundary>（App.tsx 的 <main> 内）在出错点**下面**，救不到根——
// 无边界时 React 18 卸载整棵树 = 白屏，而且刷新不自愈。这里在根上再包一层兜底边界：
// 无论 App 哪一处抛错，都落进"错误摘要 + 重试"的 fallback，界面不白屏。
// 外层这层 div 只为给 fallback（flex flex-1）一个满屏容器；App 自己仍是 h-screen 的布局根。
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </div>
  </StrictMode>,
);
