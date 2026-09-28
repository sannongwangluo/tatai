// 独立写入服务宿主（PLAN V07-01；DESIGN 附录 C.5-1）。
//
// 为什么单独一个入口：桌面应用的后端（index.ts）平时就是写入服务宿主；但 agent 无头跑
// （应用没开）时写入不能瘫痪——本入口让写入服务能脱离应用独立成活，由 MCP 客户端按需拉起
// （service.ts 的 ensureWorkService 自愈）。
//
// 所有权规则（单写者铁律不变，work-service.json 描述符即锁）：
//   · 启动时先探活——已有活服务（探活通过）本进程**立即退位**（exit 0，不发布、不抢锁）；
//   · 桌面应用启动时会经 /api/work/admin/shutdown 请本进程让位（接管握手，token 同描述符）；
//   · 优雅退出（信号/接管）撤描述符；被硬杀留下陈旧描述符由客户端探活识别并清理（自愈）。
//
// 起法：随包产物 `server/write-service.js`（build-server.ts 打包本文件），或开发态
//   `node --import tsx src/server/work/daemon.ts`。绑定 127.0.0.1:0（随机端口，
//   实际地址写进描述符）——不占固定端口，天然避开与应用后端 8787 的冲突。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "../registry";
import { createWorkHost } from "../workHost";
import { WorkServiceClient, WORK_TOKEN_HEADER, SERVICE_DESCRIPTOR_FILE, type WorkServiceDescriptor } from "./service";

const dataDir = resolveDataDir();

function readServiceDescriptorSafe(dir: string): WorkServiceDescriptor | null {
  try {
    const file = path.join(dir, SERVICE_DESCRIPTOR_FILE);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as WorkServiceDescriptor;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const workHost = createWorkHost(dataDir);

  // ① 先探活：已有活服务就退位——绝不当第二个写者（并发双拉起时后到者自然退出）
  const client = new WorkServiceClient({ dataDir, timeoutMs: 1500 });
  const alive = await client.probe();
  if (alive.available) {
    console.log(
      `[write-service] 已有活写入服务（${alive.descriptor?.host}:${alive.descriptor?.port}，pid ${alive.descriptor?.pid}），本进程退位退出`,
    );
    process.exit(0);
  }

  // ② 绑定并发布（publish 取 server.address() 实际值——端口是随机的，不能假设）
  let exiting = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    // 接管握手：只有 daemon 有这条路由（应用宿主没有），token 不对一律 401
    if (req.method === "POST" && pathname === "/api/work/admin/shutdown") {
      if (req.headers[WORK_TOKEN_HEADER] !== workHost.token) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "UNAUTHORIZED", message: "缺少或错误的写入服务令牌" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "让位：描述符即撤，请尽快接管" }));
      shutdown("takeover");
      return;
    }
    workHost
      .handle(req, res, pathname)
      .then((handled) => {
        if (handled) return;
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "NOT_FOUND", path: pathname }));
      })
      .catch((e: unknown) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: "INTERNAL", message: e instanceof Error ? e.message : String(e) }));
      });
  });

  function shutdown(reason: string): void {
    if (exiting) return;
    exiting = true;
    try {
      workHost.unpublish();
    } catch {
      // 撤不掉也不挡退出——残留描述符由客户端自愈清理
    }
    console.log(`[write-service] 退出（${reason}）`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  }
  process.on("SIGINT", () => shutdown("sigint"));
  process.on("SIGTERM", () => shutdown("sigterm"));

  server.listen(0, "127.0.0.1", () => {
    const bound = server.address();
    if (bound === null || typeof bound !== "object") {
      console.error("[write-service] 绑定失败，退出");
      process.exit(1);
    }
    workHost.publish(bound.port, bound.address);
    console.log(`[write-service] data dir: ${dataDir}`);
    // 并发双拉起的收尾仲裁：两个 daemon 可能都通过了启动探活并先后发布（窗口毫秒级）。
    // 发布后复核描述符——若所有权已被后来者覆盖（pid 非本进程），本进程输掉竞争：
    // 静默退出**且不撤描述符**（那是赢家的锁，撤了会把赢家打死）。输家本来就没被任何
    // 客户端指向（客户端每次提交都现读描述符），多活 300ms 无害。
    setTimeout(() => {
      const now = readServiceDescriptorSafe(dataDir);
      if (now !== null && now.pid !== process.pid) {
        console.log(`[write-service] 描述符已被 pid ${now.pid} 接管（并发双拉起，本进程输）——静默退位`);
        exiting = true; // 跳过 unpublish：描述符属于赢家
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 500).unref();
      }
    }, 300).unref();
  });
}

main().catch((e: unknown) => {
  console.error(`[write-service] 启动失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
