// 前端视图区错误边界（2026-09-18 审计修复）：App 右栏视图区（页签内容）渲染抛错时
// 不再白屏整页，而是落进本边界的 fallback——「视图出错 + 重试 + 错误摘要」。
// 口径：本组件**被用两次**：① App.tsx 只包右栏视图区（<main> 内容）——左栏（Agent/项目列表）与
// 弹窗不在它里面；② main.tsx 在**根**上再包一层（Q56）：App 自身 render 抛错（如 Q65 手改畸形
// hash 的 URIError）时，视图区那个边界在出错点下面救不到，根边界才是整页不白屏的兜底。
// 「重试」= 重置 boundary 状态（卸掉整棵出错子树重挂），不保证修复错误本身，只保证界面可恢复可诊断。
// React 惯例 class 组件写法（getDerivedStateFromError / componentDidCatch 是 class 专属 API，
// 函数组件没有对应物）。错误摘要只取 message 前 200 字符：完整堆栈进 console.error，不上屏刷屏。
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 完整错误与组件栈进控制台（诊断用），界面只给摘要
    console.error("[ErrorBoundary] 视图区渲染出错:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const summary = error.message.slice(0, 200);
    return (
      <div
        data-error-boundary
        className="flex flex-1 items-center justify-center overflow-y-auto p-6"
      >
        <div className="w-full max-w-xl space-y-3 rounded border border-neutral-800 bg-neutral-950 p-4">
          <h2 className="text-sm font-bold text-red-400">视图出错</h2>
          <p
            data-error-boundary-summary
            className="min-h-[1rem] break-all font-mono text-xs text-neutral-400"
          >
            {summary === "" ? "（无错误消息）" : summary}
          </p>
          <div>
            <button
              data-error-boundary-retry
              onClick={() => this.setState({ error: null })}
              className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }
}
