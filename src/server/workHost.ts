// 写入服务在桌面服务进程里的宿主（PLAN.md V06-01）。
//
// 为什么单开一个宿主文件：`src/server/index.ts` 有 2400+ 行、只该加"一行导入 + 一处挂载"，
// 服务实例、令牌、描述符的发布/撤销这些具体事都收在这里，避免 index.ts 继续变胖。
//
// 挂载点两处（都在 index.ts）：
//   · `handleRequest` 里：本模块的路由先答（`/api/work/*`，含 token 校验）；
//   · `server.on("listening")` 里：绑上之后把**实际地址**写进数据目录的服务描述符，
//     让 stdio MCP 进程能发现唯一写入服务；进程退出时撤销描述符。
//
// V09-29 边界补修（契约 F3 尾段；ownership-review-remaining.md 第 1、2 条）：**写路由先过所有权闸**——
// 唯一写宿主判据＝描述符仍属本进程（pid + 本次令牌）。失去它（被别的宿主覆盖 / 从未发布 / 桌面接管未确认）
// 之后，即使请求带的是旧 token，**一切有副作用的 work 面写请求也一律 503 拒绝并零字节落盘**。只停发布与后台
// 扫描、只靠客户端更新描述符，都拦不住"失败宿主继续当第二写者"；判据收在这一处，桌面宿主与独立 daemon 同一份。
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { nowIso } from "./time";
import {
  WorkService,
  handleWorkRequest,
  logServiceLifecycle,
  writeServiceDescriptor,
  type WorkServiceDescriptor,
} from "./work/service";
import { WorkError } from "./work/types";
import { handleBaselineRequest } from "./work/baselineHost";
import { handleProjectIndexRequest } from "./work/projectIndexHost";
import { descriptorBelongsTo, removeDescriptorIfOwned } from "./work/serviceOwnership";

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

/** work 面路由前缀（command、repair、sync、reporting、baseline 等写口都在这下面；读口是 GET，不在此闸范围） */
const WORK_FACE_PREFIX = "/api/work/";

/** 非写宿主时的落盘拒绝：结构化 503，消息说清"写面已拒绝、零字节"，不误导调用方当成功。 */
function sendWriteRefusal(res: ServerResponse): void {
  res.writeHead(503, { "content-type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      code: "SERVICE_UNAVAILABLE",
      message:
        "本进程当前不是唯一写宿主（描述符不属于本进程）：写面已拒绝，未写入任何字节。" +
        "请把写请求指向当前写宿主，或稍后重试（DESIGN.md §2.6/§11.3）",
      detail: {},
    }),
  );
}

export function createWorkHost(
  dataDir: string,
  opts: { faults?: { snapshot?: "throw" } } = {},
): WorkHost {
  const token = crypto.randomBytes(32).toString("base64url");
  /**
   * V09-29 慢 body 竞态：写者身份判据只有一份（描述符 pid + 本次令牌），注入 WorkService 与基线宿主，
   * 由它们在各写路径**实际落盘前的锁内/落盘前**调用。持有旧令牌但已非当前写宿主的进程一律被拒、零字节。
   */
  const assertWriteOwnership = (): void => {
    if (!descriptorBelongsTo(dataDir, token)) {
      throw new WorkError(
        "SERVICE_UNAVAILABLE",
        "本进程当前不是唯一写宿主（描述符已易主或未发布）：写面已拒绝，未写入任何字节。" +
          "请把写请求指向当前写宿主，或稍后重试（DESIGN.md §2.6/§11.3）",
        {},
      );
    }
  };
  const service = new WorkService({ dataDir, faults: opts.faults, assertWriteOwnership });
  let descriptor: WorkServiceDescriptor | null = null;

  return {
    service,
    token,
    // V09-28：先委派**基线宿主**（`/api/work/baseline/*`，走 documents 判据），命中即答；
    // 未命中再走原 work 面（事件账本）。桌面宿主与独立 daemon 都用这一个 handle，
    // 故两种宿主场景下基线写都经同一份判据与同一个写者。
    handle: async (req, res, pathname) => {
      // V09-29 边界闸（契约 F3 尾段；ownership-review-remaining.md 第 1、2 条）：
      // **写方法**（非 GET：command / repair / sync/scan / reporting/evidence POST / baseline preserve·activate）
      // 只有在描述符仍属本进程（pid + 本次令牌）时才放行。不是写宿主 → 直接 503，不进入 baseline/work 写路径。
      // 读口（GET health/snapshot/sync/status）不在闸内——读不产生第二写者。
      // 注意：这是**入口**闸，慢 body 请求的 body 到达前描述符仍可能易主；真正的兜底在各写路径落盘前
      // 再查（WorkService.submit/repair 锁内、reporting/baseline 宿主落盘前）。
      const method = req.method ?? "GET";
      if (method !== "GET" && pathname.startsWith(WORK_FACE_PREFIX) && !descriptorBelongsTo(dataDir, token)) {
        sendWriteRefusal(res);
        return true;
      }
      if (await handleBaselineRequest(req, res, { dataDir, token, pathname, assertWriteOwnership })) return true;
      // V09-39（契约 U5/U5.1）：持久项目说明索引的唯一宿主面 `/api/work/project-index/{upsert,remove}`——
      // 桌面宿主与独立 daemon 同一份 handle、同一写者；读（read/impact/coverage）不走本模块（本地纯读取）。
      // POST upsert/remove 已被上面的写方法所有权闸覆盖（非写宿主 503 零字节）。
      if (await handleProjectIndexRequest(req, res, { dataDir, token, pathname, assertWriteOwnership })) return true;
      return handleWorkRequest(req, res, { service, token, pathname });
    },
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
      // V09-29 边界补修（契约 F3 尾段；ownership-review-remaining.md 第 3 条）：**同一发布锁内比对后删除**。
      // 先前"先读自己的描述符、再 rm"两步非原子——两步之间被新宿主接管并写下自己的描述符，旧 rm 会删掉新文件。
      // `removeDescriptorIfOwned` 把「读—判—删」收进发布锁，且：描述符坏/读不了、属于别人、拿不到锁，三种不确定
      // 一律**保守不删**（宁留一个陈旧指针，也不删掉新宿主的描述符）。
      const outcome = removeDescriptorIfOwned(dataDir, token);
      if (outcome.removed) {
        logServiceLifecycle(dataDir, "stop", { port: descriptor.port, host: descriptor.host });
      } else if (outcome.reason === "owned_by_other") {
        console.log(
          `[tatai-server] 写入服务描述符已易主（pid ${outcome.existing?.pid ?? "?"}）——本进程退出不撤销它（不删新宿主的描述符）`,
        );
      } else if (outcome.reason === "descriptor_unreadable" || outcome.reason === "lock_busy") {
        console.log(
          `[tatai-server] 退出未撤销写入服务描述符（${outcome.reason}）——所有权无法核对或锁忙，保守不删`,
        );
      }
      descriptor = null;
    },
  };
}
