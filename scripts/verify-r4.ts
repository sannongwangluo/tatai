// R4 验证脚本（用 tsx 跑）：HTTP 层覆盖 R4 卡 DoD。
// 用法：pnpm verify:r4（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表）
// 覆盖点：
//   ① POST /api/projects/:id/open 写回 last_opened_at（registry.json 前后对照）
//   ② DELETE /api/projects/:id 只删注册表记录，磁盘目录仍在（红线断言）
//   ③ open / remove 不存在的 id → 404 + 结构化错误码 PROJECT_NOT_FOUND
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const PORT = 8794;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 准备临时数据目录与两条预置项目（目录都真实存在）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-r4-verify-"));
const dataDir = path.join(tmpBase, "home");
const dirA = path.join(tmpBase, "project-a");
const dirB = path.join(tmpBase, "project-b");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(dirA);
fs.mkdirSync(dirB);
const OLD_TS = "2026-09-17T10:00:00+08:00";
fs.writeFileSync(
  path.join(dataDir, "registry.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        {
          id: "project-a",
          name: "项目 A",
          path: dirA,
          kind: "backend",
          registered_at: OLD_TS,
          last_opened_at: OLD_TS,
        },
        {
          id: "project-b",
          name: "项目 B",
          path: dirB,
          kind: "static",
          registered_at: OLD_TS,
          last_opened_at: OLD_TS,
        },
      ],
    },
    null,
    2,
  ),
  "utf8",
);

// ── 起真实后端子进程（临时 TATAI_HOME + 独立端口）──
await assertPortFree(PORT); // 端口已被占：立刻失败，不拿占用者的服务跑验证
const child = spawn(
  process.execPath,
  ["--import", "tsx", path.join("src", "server", "index.ts")],
  {
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
watchChild(child, PORT, () => upPorts.has(PORT)); // 子进程早退（EADDRINUSE）立刻报错退出

async function waitUp(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        upPorts.add(PORT);
        return;
      }
    } catch {
      // 还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("后端 10 秒内未就绪");
}

// ── 端口冲突快速失败（2026-09-18 加）────────────────────────────────
// 端口被残留服务 / 并行会话占用时，子进程 EADDRINUSE 会静默死掉，而 waitUp 会打到占用者身上，
// 导致后续莫名 404 崩溃或对错误数据假通过。这里：起前探端口 → 起后盯早退。
const upPorts = new Set<number>();

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true)); // 有人监听 = 端口被占
    sock.once("error", () => done(false)); // 拒绝连接 = 端口空闲
    sock.setTimeout(1000, () => done(false));
  });
}

/** 起前预探测：端口已被占用立刻报错退出，不拿别人的服务跑验证 */
async function assertPortFree(port: number): Promise<void> {
  if (await portListening(port)) {
    console.error(`[verify] 后端起不来：端口 ${port} 被占用，先清理残留进程`);
    process.exit(1);
  }
}

/** 起后盯早退：子进程在就绪前退出（典型 EADDRINUSE）立即报错退出，不再继续验证 */
function watchChild(proc: ChildProcess, port: number, isUp: () => boolean): void {
  proc.once("exit", async (code) => {
    if (isUp()) return; // 脚本自己收尾杀的，不算异常
    const why = (await portListening(port))
      ? `端口 ${port} 被占用`
      : `后端进程提前退出（code=${code}）`;
    console.error(`[verify] 后端起不来：${why}，先清理残留进程`);
    process.exit(1);
  });
}

interface RegistryFile {
  projects: { id: string; path: string; last_opened_at: string }[];
}

function readOnDisk(): RegistryFile {
  return JSON.parse(
    fs.readFileSync(path.join(dataDir, "registry.json"), "utf8"),
  ) as RegistryFile;
}

try {
  await waitUp();
  console.log(`[verify] server up at ${BASE} (TATAI_HOME=${dataDir})`);

  // ── DoD① open 接口写回 last_opened_at（前后对照）──
  const before = readOnDisk();
  ok(
    before.projects.find((p) => p.id === "project-a")?.last_opened_at === OLD_TS,
    "DoD① 前置：project-a 的 last_opened_at 为旧时间戳",
  );
  const openRes = await fetch(`${BASE}/api/projects/project-a/open`, {
    method: "POST",
  });
  const opened = (await openRes.json()) as {
    ok: boolean;
    project?: { id: string; last_opened_at: string };
  };
  console.log("[verify] POST /api/projects/project-a/open ->", openRes.status, JSON.stringify(opened));
  ok(openRes.status === 200 && opened.ok === true, "DoD① open 接口返回 200 + ok:true");
  ok(
    opened.project?.id === "project-a" &&
      typeof opened.project.last_opened_at === "string" &&
      opened.project.last_opened_at !== OLD_TS,
    "DoD① open 返回更新后的项目记录（时间戳已变）",
  );
  const afterOpen = readOnDisk();
  const tsA = afterOpen.projects.find((p) => p.id === "project-a")?.last_opened_at;
  ok(
    tsA !== undefined && tsA !== OLD_TS,
    "DoD① registry.json 落盘：project-a 的 last_opened_at 已更新",
  );
  ok(
    afterOpen.projects.find((p) => p.id === "project-b")?.last_opened_at === OLD_TS,
    "DoD① 未选中的 project-b 时间戳不受影响",
  );

  // 再 open 一次（切走再切回的等价操作）：时间戳继续前进而非报错
  await new Promise((r) => setTimeout(r, 1100)); // 时间戳秒级精度，隔 1 秒保证可见差异
  await fetch(`${BASE}/api/projects/project-a/open`, { method: "POST" });
  const tsA2 = readOnDisk().projects.find((p) => p.id === "project-a")?.last_opened_at;
  ok(tsA2 !== tsA, "DoD① 重复 open（切回）再次更新时间戳，不报错");

  // ── DoD③ open 不存在的 id → 404 ──
  const open404 = await fetch(`${BASE}/api/projects/no-such-id/open`, {
    method: "POST",
  });
  const open404Body = (await open404.json()) as {
    ok: boolean;
    error?: { code: string };
  };
  console.log("[verify] POST 不存在 id/open ->", open404.status, JSON.stringify(open404Body));
  ok(open404.status === 404, "DoD③ open 不存在 id 返回 404");
  ok(
    open404Body.ok === false && open404Body.error?.code === "PROJECT_NOT_FOUND",
    "DoD③ open 不存在 id 返回结构化错误 PROJECT_NOT_FOUND",
  );

  // ── DoD② remove 接口：只删注册表记录，磁盘目录仍在（红线）──
  ok(fs.existsSync(dirB), "DoD② 前置：project-b 磁盘目录存在");
  const delRes = await fetch(`${BASE}/api/projects/project-b`, {
    method: "DELETE",
  });
  const delBody = (await delRes.json()) as { ok: boolean; removed?: string };
  console.log("[verify] DELETE /api/projects/project-b ->", delRes.status, JSON.stringify(delBody));
  ok(delRes.status === 200 && delBody.ok === true && delBody.removed === "project-b", "DoD② remove 接口返回 200 + removed");
  const afterDel = readOnDisk();
  ok(
    afterDel.projects.length === 1 &&
      afterDel.projects.every((p) => p.id !== "project-b"),
    "DoD② 注册表记录已删除（2 -> 1）",
  );
  ok(
    fs.existsSync(dirB),
    "DoD② 红线断言：移除后 project-b 磁盘目录仍在（只删注册表，不删目录）",
  );
  const listAfter = (await (await fetch(`${BASE}/api/projects`)).json()) as { id: string }[];
  ok(
    listAfter.length === 1 && listAfter[0].id === "project-a",
    "DoD② 列表接口同步：只剩 project-a",
  );

  // ── DoD③ remove 不存在的 id → 404 明确错误 ──
  const del404 = await fetch(`${BASE}/api/projects/no-such-id`, {
    method: "DELETE",
  });
  const del404Body = (await del404.json()) as {
    ok: boolean;
    error?: { code: string; message: string };
  };
  console.log("[verify] DELETE 不存在 id ->", del404.status, JSON.stringify(del404Body));
  ok(del404.status === 404, "DoD③ remove 不存在 id 返回 404");
  ok(
    del404Body.ok === false && del404Body.error?.code === "PROJECT_NOT_FOUND",
    "DoD③ remove 不存在 id 返回明确错误 PROJECT_NOT_FOUND",
  );
  ok(
    fs.existsSync(dirA),
    "DoD② 兜底：project-a 磁盘目录全程未被触碰",
  );
} finally {
  child.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
