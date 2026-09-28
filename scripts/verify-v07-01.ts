// verify-v07-01：写入服务独立进程化（PLAN V07-01 三杀矩阵 + 并发双拉起 + 接管/退位握手）。
// 全程隔离 TATAI_HOME + 临时项目；真拉真杀真自愈，不 mock。
//   ① 冷启动自愈：无应用、无描述符 → MCP 客户端首写按需拉起 daemon，写入成功
//   ② 杀 daemon 自愈：硬杀 daemon（留陈旧描述符）→ 下一次写入自愈（清死指针→重拉起）
//   ③ 陈旧描述符：伪造死 pid 描述符 → 写入自愈不受骗
//   ④ 并发双拉起：两个客户端同时冷启动 → 双方写入都成功、描述符唯一且赢家存活
//   ⑤ 接管握手：错 token 401 不让位；对 token 200 → 撤描述符退出（桌面应用接管路径）
//   ⑥ daemon 退位：已有活服务时 daemon 启动即退位（exit 0，不抢锁）
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  WorkServiceClient,
  readServiceDescriptor,
  writeServiceDescriptor,
  WORK_TOKEN_HEADER,
} from "../src/server/work/service";
import { createWorkHost } from "../src/server/workHost";
import { loadEvents } from "../src/server/work/eventStore";

const results: Array<[boolean, string]> = [];
const check = (ok: boolean, msg: string): void => {
  results.push([ok, msg]);
  console.log(`[verify] ${ok ? "PASS" : "FAIL"} ${msg}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAEMON_TS = path.join(REPO, "src", "server", "work", "daemon.ts");

function makeHome(name: string): { dataDir: string; projRoot: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `v0701-${name}-`));
  const projRoot = path.join(dataDir, "proj");
  fs.mkdirSync(projRoot, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "registry.json"),
    JSON.stringify({
      version: 1,
      projects: [
        {
          id: "v0701",
          name: "V07-01 验证夹具",
          path: projRoot,
          kind: "backend",
          registered_at: "2026-09-22T00:00:00+08:00",
          last_opened_at: "2026-09-22T00:00:00+08:00",
        },
      ],
    }),
  );
  process.env.TATAI_HOME = dataDir;
  return { dataDir, projRoot };
}

const eventCount = (projRoot: string) => {
  try {
    return loadEvents(path.join(projRoot, ".工作台", "work")).events.length;
  } catch {
    return 0;
  }
};

const commandOf = (key: string, entityId: string) => ({
  schema_version: 2,
  project_id: "v0701",
  change_id: "change-none",
  actor_id: "verify-v07-01",
  role: "coordinator",
  entity_id: entityId,
  type: "requirement.registered",
  expected_revision: null,
  idempotency_key: key,
  payload: {
    source: { kind: "user", ref: "verify-v07-01" },
    problem: "三杀矩阵验证",
    users: [],
    success_scenarios: [],
    exclusions: [],
    priority: "P2",
    status: "explicit",
  },
});

const submitCmd = (dataDir: string, key: string, entityId: string) =>
  new WorkServiceClient({ dataDir, timeoutMs: 8000 }).submit(commandOf(key, entityId));

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function main(): Promise<void> {
  // ── ① 冷启动自愈 ──
  const A = makeHome("cold");
  {
    const client = new WorkServiceClient({ dataDir: A.dataDir, timeoutMs: 1500 });
    const before = await client.probe();
    check(!before.available, "① 冷启动前探活不可用（无应用、无描述符）");
    const receipt = await submitCmd(A.dataDir, "k-cold-1", "requirement:req-a");
    check(receipt.ok, `① 冷启动首写成功（自愈拉起 daemon，seq=${receipt.seq}）`);
    const after = await client.probe();
    check(after.available && after.descriptor !== null && pidAlive(after.descriptor.pid), "① 自愈后探活可用且描述符 pid 存活");
    check(eventCount(A.projRoot) === 1, "① 事件落盘恰 1 条");
  }

  // ── ② 杀 daemon 自愈 ──
  {
    const d1 = readServiceDescriptor(A.dataDir)!;
    process.kill(d1.pid); // Windows 下硬杀：留陈旧描述符，模拟服务崩溃/被任务管理器结束
    await sleep(300);
    check(!pidAlive(d1.pid), "② daemon 已被硬杀（描述符成死指针）");
    const receipt = await submitCmd(A.dataDir, "k-heal-1", "requirement:req-b");
    check(receipt.ok, `② 死指针后下一次写入自愈成功（清死描述符→重拉起，seq=${receipt.seq}）`);
    const d2 = readServiceDescriptor(A.dataDir)!;
    check(d2.pid !== d1.pid && pidAlive(d2.pid), "② 新 daemon 上岗（pid 已换且存活）");
    check(eventCount(A.projRoot) === 2, "② 事件累计恰 2 条（无重复、无丢失）");
  }

  // ── ③ 陈旧描述符不受骗 ──
  const C = makeHome("stale");
  {
    writeServiceDescriptor(C.dataDir, {
      schema_version: 2,
      pid: 9999999,
      host: "127.0.0.1",
      port: 1,
      token: "deadbeef",
      started_at: "2026-09-22T00:00:00+08:00",
      url: "http://127.0.0.1:1",
    });
    const receipt = await submitCmd(C.dataDir, "k-stale-1", "requirement:req-a");
    check(receipt.ok, `③ 伪造死 pid 描述符 → 写入自愈成功（seq=${receipt.seq}）`);
    const d = readServiceDescriptor(C.dataDir)!;
    check(d.pid !== 9999999 && pidAlive(d.pid), "③ 死描述符被清理并换成活服务");
    check(eventCount(C.projRoot) === 1, "③ 事件落盘恰 1 条");
  }

  // ── ④ 并发双拉起 ──
  const D = makeHome("race");
  {
    const [r1, r2] = await Promise.all([
      submitCmd(D.dataDir, "k-race-1", "requirement:req-a"),
      submitCmd(D.dataDir, "k-race-2", "requirement:req-b"),
    ]);
    check(r1.ok && r2.ok, `④ 并发双客户端冷启动写入都成功（seq=${r1.seq}/${r2.seq}）`);
    check(eventCount(D.projRoot) === 2, "④ 事件恰 2 条（单写者账本，无重复/损坏）");
    await sleep(700); // 等并发仲裁窗口（输家 300ms 后静默退位）过完
    const client = new WorkServiceClient({ dataDir: D.dataDir, timeoutMs: 1500 });
    const alive = await client.probe();
    check(alive.available && alive.descriptor !== null && pidAlive(alive.descriptor.pid), "④ 仲裁后赢家存活且描述符有效");
  }

  // ── ⑤ 接管握手（复用 ①② 的活 daemon） ──
  {
    const d = readServiceDescriptor(A.dataDir)!;
    const wrong = await fetch(`http://${d.host}:${d.port}/api/work/admin/shutdown`, {
      method: "POST",
      headers: { [WORK_TOKEN_HEADER]: "wrong-token" },
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    check(wrong !== null && wrong.status === 401, "⑤ 错 token 的接管请求被拒（401，不让位）");
    await sleep(200);
    check(pidAlive(d.pid), "⑤ 拒错 token 后 daemon 继续在岗");
    const right = await fetch(`http://${d.host}:${d.port}/api/work/admin/shutdown`, {
      method: "POST",
      headers: { [WORK_TOKEN_HEADER]: d.token },
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    check(right !== null && right.ok, "⑤ 对 token 的接管请求 200（应用接管路径）");
    let gone = false;
    for (let i = 0; i < 15; i++) {
      await sleep(200);
      if (readServiceDescriptor(A.dataDir) === null) {
        gone = true;
        break;
      }
    }
    check(gone, "⑤ daemon 让位：描述符已撤");
    let exited = false;
    for (let i = 0; i < 15 && !exited; i++) {
      await sleep(200);
      exited = !pidAlive(d.pid);
    }
    check(exited, "⑤ daemon 让位后退出进程");
  }

  // ── ⑥ daemon 退位（已有活服务时启动即退） ──
  const F = makeHome("defer");
  {
    const wh = createWorkHost(F.dataDir);
    const srv = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      void wh.handle(req, res, pathname).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
    const addr = srv.address() as { port: number; address: string };
    wh.publish(addr.port, addr.address);
    const mine = readServiceDescriptor(F.dataDir)!;

    const tsx = (() => {
      try {
        return pathToFileURL(require.resolve("tsx")).href;
      } catch {
        return "tsx";
      }
    })();
    const child = spawn(process.execPath, ["--import", tsx, DAEMON_TS], {
      env: { ...process.env, TATAI_HOME: F.dataDir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let childOut = "";
    child.stdout.on("data", (c) => (childOut += String(c)));
    child.stderr.on("data", (c) => (childOut += String(c)));
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => resolve(-1), 8000);
      child.on("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    check(code === 0, `⑥ 已有活服务时 daemon 退位退出（exit=${code}${code !== 0 ? `，输出：${childOut.slice(0, 200)}` : ""}）`);
    const after = readServiceDescriptor(F.dataDir);
    check(after !== null && after.pid === mine.pid, "⑥ 退位不抢锁：描述符仍是原宿主（pid 未变）");
    wh.unpublish();
    srv.close();
  }

  // ── 清理：杀掉各场景残留 daemon，删临时目录 ──
  for (const home of [A, C, D]) {
    const d = readServiceDescriptor(home.dataDir);
    if (d !== null && pidAlive(d.pid)) {
      try {
        process.kill(d.pid);
      } catch {
        /* 尽力而为 */
      }
    }
  }
  await sleep(300);
  if (process.env.TATAI_KEEP_TMP !== "1") {
    for (const home of [A, C, D, F]) fs.rmSync(home.dataDir, { recursive: true, force: true });
    console.log("[verify] 已清理隔离夹具目录（TATAI_KEEP_TMP=1 可保留现场）");
  }

  const fail = results.filter(([ok]) => !ok).length;
  console.log(`\n[verify] V07-01 结果：${results.length - fail} PASS / ${fail} FAIL`);
  if (fail > 0) process.exit(1);
}

// 场景⑥里 require.resolve 需要挂在仓库上下文（ESM 下用 createRequire）
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

main().catch((e) => {
  console.error("[verify] 运行失败：", e);
  process.exit(1);
});
