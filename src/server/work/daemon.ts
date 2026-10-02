// 独立写入服务宿主（PLAN V07-01；DESIGN 附录 C.5-1）。
//
// 为什么单独一个入口：桌面应用的后端（index.ts）平时就是写入服务宿主；但 agent 无头跑
// （应用没开）时写入不能瘫痪——本入口让写入服务能脱离应用独立成活，由 MCP 客户端按需拉起
// （service.ts 的 ensureWorkService 自愈）。
//
// 所有权规则（单写者铁律不变，work-service.json 描述符即锁）：
//   · 启动时先探活——已有**可答**活服务本进程**立即退位**（exit 0，不发布、不抢锁）；
//   · 探活失败但描述符所指进程**仍活**（慢/不可达宿主）同样退位——**探活超时 ≠ 进程已停**，不另起写者
//     （V09-29 恢复保护；契约 F3 尾段；runtime-observation.md 的 15s 读超时与同 home 多 daemon 现场）；
//   · 冷启动发布走 `publishUnderOwnershipLock`（有界跨进程锁 + 存活核实），并发双拉起只允许一个发布者；
//   · 发布后**持续**复核所有权，失去描述符即停后台发现并退出，且退出只撤自己的描述符（不删新宿主的）；
//   · 桌面应用启动时会经 /api/work/admin/shutdown 请本进程让位（接管握手，token 同描述符）；
//   · 优雅退出（信号/接管/失去所有权）撤自己的描述符；被硬杀留下陈旧描述符由客户端探活识别并清理（自愈）。
//
// 起法：随包产物 `server/write-service.js`（build-server.ts 打包本文件），或开发态
//   `node --import tsx src/server/work/daemon.ts`。绑定 127.0.0.1:0（随机端口，
//   实际地址写进描述符）——不占固定端口，天然避开与应用后端 8787 的冲突。
import http from "node:http";
import { resolveDataDir } from "../registry";
import { createWorkHost } from "../workHost";
import { startSyncDiscovery, stopSyncDiscovery } from "./syncDiscovery";
import { WorkServiceClient, WORK_TOKEN_HEADER } from "./service";
import { descriptorBelongsTo, publishUnderOwnershipLock, readOwnership } from "./serviceOwnership";

const dataDir = resolveDataDir();

/** 发布后**持续**复核所有权的周期（ms）：失去描述符即停发现并退出（旧宿主不得继续扫描写账）。 */
const OWNERSHIP_CHECK_MS = 1_000;

async function main(): Promise<void> {
  const workHost = createWorkHost(dataDir);

  // ① 先探活：已有**可答**的活服务就退位——绝不当第二个写者（并发双拉起时后到者自然退出）
  const client = new WorkServiceClient({ dataDir, timeoutMs: 1500 });
  const alive = await client.probe();
  if (alive.available) {
    console.log(
      `[write-service] 已有活写入服务（${alive.descriptor?.host}:${alive.descriptor?.port}，pid ${alive.descriptor?.pid}），本进程退位退出`,
    );
    process.exit(0);
  }

  // ①b 探活失败但描述符所指进程**仍活**：这是"慢/不可达宿主"，不是死宿主。**绝不**据此另起写者
  //     （契约 F3 尾段；runtime-observation：真实安装版健康读 15s 超时、同 home 多 daemon）。
  //     只报"不可达/所有权待核实"并退位——把写者身份留给仍然存活的那个进程，等它答或等它真死。
  const pre = readOwnership(dataDir);
  // ①a.2 描述符**在场但坏/读不了**：这是"所有权未知"，不是"无人拥有"。**绝不**拿它当不存在去冷启动覆盖
  //       （ownership-review-remaining.md 第 4 条）——本进程退位，把那不明描述符留给它的主人或人工处置。
  //       （真正发布时 `publishUnderOwnershipLock` 还会再挡一次；这里提前退位避免白绑一个端口。）
  if (pre.state === "invalid") {
    console.log(
      `[write-service] 描述符在场但坏/读不了（${pre.reason}）——所有权未知，按服务不可用/所有权待核实退位，` +
        "不覆盖不明所有权（不当它不存在去冷启动）",
    );
    process.exit(0);
  }
  if (pre.descriptor !== null && !pre.isSelf && pre.pidAlive) {
    console.log(
      `[write-service] 已有宿主进程存活但探活不可达（pid ${pre.descriptor.pid}，${alive.reason}）——` +
        "按服务不可用/所有权待核实退位，不另起写者（探活超时≠进程已停）",
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
    console.log(`[write-service] 退出（${reason}）`);
    void (async () => {
      // V09-23：先停后台同步发现——关监听/定时器并 await 在途扫描，返回后不再有扫描写入
      try {
        await stopSyncDiscovery();
      } catch {
        // 停止失败不挡退出（描述符照撤，客户端自愈）
      }
      try {
        workHost.unpublish();
      } catch {
        // 撤不掉也不挡退出——残留描述符由客户端自愈清理
      }
      server.close(() => process.exit(0));
    })();
    // 兜底：stopSyncDiscovery 自身有界（≤10s），这里留一点余量后强制退出
    setTimeout(() => process.exit(0), 12_000).unref();
  }
  process.on("SIGINT", () => shutdown("sigint"));
  process.on("SIGTERM", () => shutdown("sigterm"));

  server.listen(0, "127.0.0.1", () => {
    const bound = server.address();
    if (bound === null || typeof bound !== "object") {
      console.error("[write-service] 绑定失败，退出");
      process.exit(1);
    }
    // ② 冷启动发布仲裁（V09-29 恢复保护）：以 dataDir 下的**有界跨进程文件锁**串行化发布 + 锁内
    //    再核一次存活——并发双拉起时只有一个发布者；已有**别的仍活进程**的描述符就退位，不覆盖。
    //    真 pid 死（ESRCH）才在锁内清陈旧描述符后自愈发布。**不在 publish 前先广播**（退位候选不先扫）。
    const arb = publishUnderOwnershipLock(dataDir, () => workHost.publish(bound.port, bound.address));
    if (!arb.published) {
      console.log(
        `[write-service] 未取得发布权（${arb.reason}${arb.lock_error === undefined ? "" : `：${arb.lock_error}`}，` +
          `既有描述符 pid ${arb.existing?.pid ?? "无"}）——退位，不启动后台发现，也不覆盖仍活的宿主`,
      );
      exiting = true; // 不撤别人的描述符
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
      return;
    }
    console.log(`[write-service] data dir: ${dataDir}`);
    // ③ 发布后**持续**复核所有权：描述符一旦易主（pid/token 不再是本进程）就停后台发现并退出
    //    （旧宿主失去描述符不得继续发现扫描写账）；退出走 shutdown，unpublish 只撤自己的描述符。
    const monitor = setInterval(() => {
      if (exiting) return;
      if (!descriptorBelongsTo(dataDir, workHost.token)) {
        console.log("[write-service] 描述符已易主（失去唯一写宿主所有权）——停止后台发现并退出，不撤新宿主描述符");
        shutdown("lost-ownership");
      }
    }, OWNERSHIP_CHECK_MS);
    monitor.unref();
    // ④ 确认描述符确实属于本进程才启动后台同步发现（与 startSyncDiscovery 内部复核同一门槛）；
    //    极端并发下若已被别人覆盖，静默退位且不启动发现。
    if (!descriptorBelongsTo(dataDir, workHost.token)) {
      console.log("[write-service] 发布后描述符不属于本进程——静默退位，不启动后台发现");
      exiting = true; // 跳过 unpublish：描述符属于赢家
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
      return;
    }
    startSyncDiscovery({ service: workHost.service, dataDir, token: workHost.token });
  });
}

main().catch((e: unknown) => {
  console.error(`[write-service] 启动失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
