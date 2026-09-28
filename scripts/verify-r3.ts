// R3 验证脚本（用 tsx 跑）：HTTP 层覆盖 R3 卡 DoD。
// 用法：pnpm verify:r3（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表）
// 覆盖点：
//   ① GET /api/projects 逐条带 exists（目录存在=绿 true / 不存在=灰 false，口径由后端给）
//   ② POST 不存在路径 → 结构化错误（ok:false + PATH_NOT_FOUND），非崩溃
//   ③ POST 合法目录 → 写入注册表（registry.json 落盘）+ 列表刷新可见 + 幂等不重复写
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const PORT = 8793;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 准备临时数据目录与预置注册表（一条真实目录 + 一条不存在路径）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-r3-verify-"));
const dataDir = path.join(tmpBase, "home");
const realDir = path.join(tmpBase, "real-project");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(realDir);
const ghostPath = path.join(tmpBase, "ghost-project"); // 故意不建，测 exists:false
fs.writeFileSync(
  path.join(dataDir, "registry.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        {
          id: "real-project",
          name: "真实目录项目",
          path: realDir,
          kind: "backend",
          registered_at: "2026-09-17T10:00:00+08:00",
          last_opened_at: "2026-09-17T10:00:00+08:00",
        },
        {
          id: "ghost-project",
          name: "路径已消失项目",
          path: ghostPath,
          kind: "static",
          registered_at: "2026-09-17T10:00:00+08:00",
          last_opened_at: "2026-09-17T10:00:00+08:00",
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
  [
    "--import",
    "tsx",
    path.join("src", "server", "index.ts"),
  ],
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

interface ListItem {
  id: string;
  name: string;
  path: string;
  kind: string;
  exists: boolean;
}

try {
  await waitUp();
  console.log(`[verify] server up at ${BASE} (TATAI_HOME=${dataDir})`);

  // ── DoD② 列表逐条带 exists（状态点口径由后端给出）──
  const list1 = (await (await fetch(`${BASE}/api/projects`)).json()) as ListItem[];
  console.log("[verify] GET /api/projects ->", JSON.stringify(list1, null, 2));
  ok(list1.length === 2, "DoD② 预置两条项目全部列出");
  ok(
    list1.every((p) => typeof p.exists === "boolean"),
    "DoD② 每条都带 exists 布尔字段",
  );
  ok(
    list1.find((p) => p.id === "real-project")?.exists === true,
    "DoD② 目录存在 -> exists:true（绿点）",
  );
  ok(
    list1.find((p) => p.id === "ghost-project")?.exists === false,
    "DoD② 目录不存在 -> exists:false（灰点）",
  );

  // ── DoD③ 添加流程：不存在路径 → 结构化错误 ──
  const badRes = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: path.join(tmpBase, "不存在的目录") }),
  });
  const bad = (await badRes.json()) as {
    ok: boolean;
    error?: { code: string; message: string };
  };
  console.log("[verify] POST 不存在路径 ->", badRes.status, JSON.stringify(bad));
  ok(bad.ok === false, "DoD③ 不存在路径返回 ok:false 而非崩溃");
  ok(bad.error?.code === "PATH_NOT_FOUND", "DoD③ 结构化错误码 PATH_NOT_FOUND");

  // ── DoD③ 添加流程：合法目录 → 落盘 + 列表刷新可见 ──
  const newDir = path.join(tmpBase, "added-via-api");
  fs.mkdirSync(newDir);
  fs.writeFileSync(path.join(newDir, ".gitignore"), "node_modules/\n", "utf8"); // 故意缺 .工作台/ 行
  const addRes = await fetch(`${BASE}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: newDir, name: "API 添加的项目" }),
  });
  const added = (await addRes.json()) as {
    ok: boolean;
    already_registered?: boolean;
    detected?: { kind: string; reasons: string[] };
    gitignore?: { hint: string | null };
  };
  console.log("[verify] POST 合法目录 ->", addRes.status, JSON.stringify(added, null, 2));
  ok(added.ok === true && added.already_registered === false, "DoD③ 添加成功且非重复");
  ok(typeof added.detected?.kind === "string", "DoD③ 返回 kind 判定结果");
  ok(
    typeof added.gitignore?.hint === "string" && added.gitignore.hint.includes(".工作台/"),
    "DoD③ 缺 .工作台/ gitignore 行 → 返回提示（DESIGN.md §8.2）",
  );

  // 幂等：再 POST 一次不重复写
  const again = (await (
    await fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: newDir, name: "API 添加的项目" }),
    })
  ).json()) as { ok: boolean; already_registered?: boolean };
  ok(again.ok === true && again.already_registered === true, "DoD③ 重复添加幂等不重复写");

  // 列表刷新可见 + 持久化：直接读 registry.json 文件验证落盘
  const list2 = (await (await fetch(`${BASE}/api/projects`)).json()) as ListItem[];
  ok(list2.length === 3, "DoD③ 添加后列表刷新可见（2 -> 3）");
  ok(
    list2.find((p) => p.name === "API 添加的项目")?.exists === true,
    "DoD③ 新项目 exists:true",
  );
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(dataDir, "registry.json"), "utf8"),
  ) as { projects: { id: string; name: string }[] };
  ok(
    onDisk.projects.some((p) => p.name === "API 添加的项目"),
    "DoD③ 数据已落盘 registry.json（刷新页面仍在的事实源）",
  );
} finally {
  child.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
