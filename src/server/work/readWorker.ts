// V09-37：宿主**只读**计算作业的 worker 线程入口（`worker_threads`）。
//
// 边界（DESIGN §6.8 / 契约 U4；本会话任务目标二）：
//   · **纯只读**：只调 `readJobs.runReadJobLocal`（入口/图摘要/同步判据的现读组合）。worker **不 import**
//     `WorkService`/`eventStore` 的写路径，也**不写任何盘**——它算完把结果 postMessage 回宿主，写账本/提交
//     一律由唯一写宿主做（`verify-unified-host.ts` 用真实字节验证运行期账本零增长）。
//   · **只答宿主主线程**：父线程通过 `postMessage` 派活；本文件不做任何网络/文件写。
//   · **开发 tsx / 打包 js 两态**：本文件在开发态由 `--import tsx` 起（pool 里指定 execArgv），打包态由
//     `read-worker.js`（build-server.ts 增的入口）起——两态同一份源码。
import { parentPort } from "node:worker_threads";
import { runReadJobLocal, type ReadJobKind } from "./readJobs";

interface JobRequest {
  id: number;
  kind: ReadJobKind;
  args: unknown;
}

if (parentPort === null) {
  throw new Error("readWorker 只能作为 worker_threads 运行（parentPort 为空）——不要在主线程 import 它");
}
const port = parentPort;

port.on("message", (msg: unknown) => {
  const req = msg as JobRequest | null;
  if (req === null || typeof req !== "object" || typeof req.id !== "number") return;
  try {
    const result = runReadJobLocal(req.kind, req.args);
    port.postMessage({ id: req.id, ok: true, result });
  } catch (e) {
    // 结构化错误带回去（WorkError 的 code/detail 不丢）：宿主据此映射 HTTP 状态与错误体。
    const err = e as { code?: unknown; detail?: unknown } | null;
    const code = typeof err?.code === "string" ? err.code : "READ_JOB_FAILED";
    const detail =
      typeof err?.detail === "object" && err.detail !== null ? (err.detail as Record<string, unknown>) : {};
    port.postMessage({ id: req.id, ok: false, error: { message: e instanceof Error ? e.message : String(e), code, detail } });
  }
});
