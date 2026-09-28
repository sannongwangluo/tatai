// D1 验证脚本（用 tsx 跑）：HTTP + 逻辑层断言设计书只读接口的口径。
// 用法：pnpm verify:d1（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表与真实项目；
// 唯一例外：注册一个指向本 repo 根的 "tatai" 记录，用于验证塔台自身例外读 <repo>/DESIGN.md）
// 覆盖点（PLAN.md D1 DoD 与施工图）：
//   ① 塔台（id=="tatai"，指向 repo 根）→ 返回 repo 根 DESIGN.md 全文（抽查 §3.5 标题在，
//      且与磁盘原文逐字节一致，source 是根 DESIGN.md 而非 .工作台/design.md）
//   ② self_managed:true 的非 tatai 项目 → 同样读 <项目根>/DESIGN.md（自举例外口径）
//   ③ 普通项目造 `.工作台/design.md` → 读到全文（含表格/代码块原样返回）
//   ④ 无设计书项目 → 200 + {exists:false}，不报错崩溃
//   ⑤ 伪造 id 路径穿越被拒（编码与未编码两种形态，PROJECT_NOT_FOUND / 路由不命中）
//   ⑥ 红线：POST/PUT/DELETE /design 一律 404——全仓没有任何写设计书的接口（§3.5 两条笔）
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { designPath, readDesign, WsError } from "../src/server/workstation";

const PORT = 8795;
const BASE = `http://localhost:${PORT}`;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 准备临时数据目录与三个临时项目（不碰真实注册表与真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-d1-verify-"));
const dataDir = path.join(tmpBase, "home");
const projWith = path.join(tmpBase, "d1-with"); // 有 .工作台/design.md 的普通项目
const projWithout = path.join(tmpBase, "d1-without"); // 无设计书的项目
const projSelf = path.join(tmpBase, "d1-self"); // self_managed:true，根 DESIGN.md
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(projWith, ".工作台"), { recursive: true });
fs.mkdirSync(projWithout);
fs.mkdirSync(projSelf);

// 夹具设计书：含 GFM 表格与代码块，验证原样返回（渲染正确性由 playwright 截图断言）
const FIXTURE = [
  "# 夹具项目设计书",
  "",
  "## 1. 定位",
  "",
  "一段正文。",
  "",
  "| 列甲 | 列乙 |",
  "| --- | --- |",
  "| a1 | b1 |",
  "",
  "```ts",
  "const answer: number = 42;",
  "```",
  "",
].join("\n");
fs.writeFileSync(path.join(projWith, ".工作台", "design.md"), FIXTURE, "utf8");
const SELF_FIXTURE = "# 自举项目根 DESIGN.md\n\nself_managed 例外口径验证。\n";
fs.writeFileSync(path.join(projSelf, "DESIGN.md"), SELF_FIXTURE, "utf8");

const regEntry = (id: string, p: string, selfManaged = false) => ({
  id,
  name: id,
  path: p,
  kind: "backend",
  registered_at: "2026-09-17T10:00:00+08:00",
  last_opened_at: "2026-09-17T10:00:00+08:00",
  ...(selfManaged ? { self_managed: true } : {}),
});
fs.writeFileSync(
  path.join(dataDir, "registry.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        // 塔台自身例外：id=="tatai" 指向本 repo 根（REPO_ROOT），读 <repo>/DESIGN.md
        regEntry("tatai", REPO_ROOT, true),
        regEntry("d1-with", projWith),
        regEntry("d1-without", projWithout),
        regEntry("d1-self", projSelf, true),
      ],
    },
    null,
    2,
  ),
  "utf8",
);

// ── 逻辑层（直接调 workstation 层，不起服务）──
const realDesign = fs.readFileSync(path.join(REPO_ROOT, "DESIGN.md"), "utf8");
ok(
  designPath("tatai", dataDir) === path.join(REPO_ROOT, "DESIGN.md"),
  "逻辑层：tatai 设计书路径 = <repo>/DESIGN.md（塔台自身例外，AGENTS.md §7）",
);
ok(
  designPath("d1-with", dataDir) === path.join(projWith, ".工作台", "design.md"),
  "逻辑层：普通项目设计书路径 = <项目根>/.工作台/design.md（§2.2）",
);
ok(
  designPath("d1-self", dataDir) === path.join(projSelf, "DESIGN.md"),
  "逻辑层：self_managed:true 项目同样读 <项目根>/DESIGN.md（自举例外口径）",
);
const logicDoc = readDesign("tatai", dataDir);
ok(
  logicDoc.exists === true && logicDoc.content === realDesign,
  "逻辑层：tatai 读到 repo 根 DESIGN.md 全文（与磁盘逐字节一致）",
);
try {
  designPath("..\\..\\Windows", dataDir);
  ok(false, "逻辑层：伪造 id 路径穿越被拒（实际: 未抛错）");
} catch (e) {
  ok(
    e instanceof WsError && e.code === "PROJECT_NOT_FOUND",
    `逻辑层：伪造 id 路径穿越被拒（PROJECT_NOT_FOUND）（实际: ${(e as Error).message}）`,
  );
}

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

interface DesignResp {
  status: number;
  body: {
    ok?: boolean;
    design?: { exists: boolean; content?: string; source?: string };
    error?: { code: string; message: string };
  };
}

async function httpGetDesign(rawIdPath: string): Promise<DesignResp> {
  const res = await fetch(`${BASE}/api/projects/${rawIdPath}/design`);
  return { status: res.status, body: (await res.json()) as DesignResp["body"] };
}

async function httpWriteDesign(method: string, id: string): Promise<number> {
  const res = await fetch(`${BASE}/api/projects/${encodeURIComponent(id)}/design`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "# 试图篡改设计书" }),
  });
  await res.text();
  return res.status;
}

try {
  await waitUp();
  console.log(`[verify] server up at ${BASE} (TATAI_HOME=${dataDir})`);

  // ── DoD④/施工图① 塔台 → repo 根 DESIGN.md 全文，§3.5 标题在 ──
  const tatai = await httpGetDesign("tatai");
  ok(tatai.status === 200 && tatai.body.design?.exists === true, "HTTP：tatai 设计书 200 + exists:true");
  ok(
    tatai.body.design?.content === realDesign,
    "HTTP：tatai 返回内容与 <repo>/DESIGN.md 磁盘原文逐字节一致",
  );
  ok(
    tatai.body.design?.content?.includes("### 3.5 设计书与施工图视图、修订权及基线") === true,
    "HTTP：tatai 设计书含 §3.5 标题（### 3.5 设计书与施工图视图、修订权及基线）",
  );
  ok(
    tatai.body.design?.source === path.join(REPO_ROOT, "DESIGN.md"),
    "HTTP：tatai source 指向 repo 根 DESIGN.md（不是 .工作台/design.md）",
  );

  // ── 施工图② 普通项目造 .工作台/design.md → 读到（表格/代码块原样）──
  const withDoc = await httpGetDesign("d1-with");
  ok(
    withDoc.status === 200 && withDoc.body.design?.content === FIXTURE,
    "HTTP：普通项目读到 .工作台/design.md 全文（GFM 表格/代码块原样返回）",
  );

  // ── 施工图③ 无设计书项目 → 200 + exists:false，不报错崩溃 ──
  const without = await httpGetDesign("d1-without");
  ok(
    without.status === 200 &&
      without.body.ok === true &&
      without.body.design?.exists === false,
    "HTTP：无设计书项目 → 200 + {exists:false}（正常空态，不是错误）",
  );

  // ── self_managed 例外（不依赖 id=="tatai" 也成立）──
  const self = await httpGetDesign("d1-self");
  ok(
    self.status === 200 && self.body.design?.content === SELF_FIXTURE,
    "HTTP：self_managed:true 项目读 <项目根>/DESIGN.md（自举例外口径）",
  );

  // ── 施工图④ 伪造 id 路径穿越被拒（两种形态）──
  const forgedEncoded = await httpGetDesign("..%2F..%2FWindows");
  ok(
    forgedEncoded.status === 404 && forgedEncoded.body.error?.code === "PROJECT_NOT_FOUND",
    "HTTP：编码形态伪造 id（..%2F..%2FWindows）→ 404 PROJECT_NOT_FOUND（路径只走注册表）",
  );
  const forgedRaw = await httpGetDesign("../../Windows");
  ok(
    forgedRaw.status === 404,
    "HTTP：未编码形态伪造 id（../../Windows）→ 404（路由不命中，根本不进入处理）",
  );

  // ── 红线⑥ 只读硬约束：POST/PUT/DELETE /design 一律 404（全仓无写设计书接口，§3.5 两条笔）──
  for (const method of ["POST", "PUT", "DELETE"]) {
    const status = await httpWriteDesign(method, "tatai");
    ok(status === 404, `红线：${method} /api/projects/tatai/design → 404（不存在任何写设计书接口）`);
  }
} finally {
  child.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
