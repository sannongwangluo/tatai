// 写入服务在桌面服务进程里的宿主（PLAN.md V06-01）。
//
// 为什么单开一个宿主文件：`src/server/index.ts` 有 2400+ 行、只该加"一行导入 + 一处挂载"，
// 服务实例、令牌、描述符的发布/撤销这些具体事都收在这里，避免 index.ts 继续变胖。
//
// 挂载点两处（都在 index.ts）：
//   · `handleRequest` 里：本模块的路由先答（`/api/work/*`，含 token 校验）；
//   · `server.on("listening")` 里：绑上之后把**实际地址**写进数据目录的服务描述符，
//     让 stdio MCP 进程能发现唯一写入服务；进程退出时撤销描述符。
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { nowIso } from "./time";
import {
  WorkService,
  handleWorkRequest,
  logServiceLifecycle,
  removeServiceDescriptor,
  writeServiceDescriptor,
  type WorkServiceDescriptor,
} from "./work/service";

export interface WorkHost {
  service: WorkService;
  /** 本进程本次启动的调用令牌（写进描述符，MCP 从描述符读；每次启动重新生成，不落仓库） */
  token: string;
  /** 处理一条 work 路由；false = 不是本模块的路由 */
  handle: (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean>;
  /** 绑上之后发布描述符（port/host 取 `server.address()` 的实际值） */
  publish: (port: number, host: string) => void;
  /** 退出时撤销描述符（撤销后客户端得到"服务未启动"，而不是指向死端口的旧地址） */
  unpublish: () => void;
}

export function createWorkHost(
  dataDir: string,
  opts: { faults?: { snapshot?: "throw" } } = {},
): WorkHost {
  const service = new WorkService({ dataDir, faults: opts.faults });
  const token = crypto.randomBytes(32).toString("base64url");
  let descriptor: WorkServiceDescriptor | null = null;

  return {
    service,
    token,
    handle: (req, res, pathname) => handleWorkRequest(req, res, { service, token, pathname }),
    publish(port, host) {
      descriptor = {
        schema_version: 2,
        pid: process.pid,
        host,
        port,
        token,
        started_at: nowIso(),
        url: `http://${host}:${port}`,
      };
      writeServiceDescriptor(dataDir, descriptor);
      logServiceLifecycle(dataDir, "start", { port, host });
      console.log(`[tatai-server] work service → ${descriptor.url}/api/work/*（V06-01 唯一写入服务）`);
    },
    unpublish() {
      if (!descriptor) return;
      removeServiceDescriptor(dataDir);
      logServiceLifecycle(dataDir, "stop", { port: descriptor.port, host: descriptor.host });
      descriptor = null;
    },
  };
}
