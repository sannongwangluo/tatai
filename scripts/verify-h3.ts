// H3 验证脚本（用 tsx 跑）：HTTP 层验证 GET changes 的分页/过滤/倒序（PLAN.md H3 卡后端部分）。
// 用法：pnpm verify:h3（自带临时 TATAI_HOME 与临时项目目录，不碰真实注册表与真实项目）
// 覆盖点：
//   ① 直接写 240 条 changes.jsonl → GET ?limit=50 返回 50 条 + total=240，时间倒序（最新在上）
//   ② offset=50 翻页 → 与全量倒序结果切片逐条全等（不重复、不缺条）
//   ③ path 子串过滤 → 返回行全部含该子串，total = 过滤后条数
//   ④ 过滤 + 分页组合正确
//   ⑤ 非法 offset/limit → 400 INVALID_INPUT；无参数 → 全量倒序 + total
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject } from "../src/server/registry";
import type { ChangeLine } from "../src/server/watcher";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8795;
const BASE = `http://localhost:${PORT}`;

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

// ── 临时数据目录与临时项目（不碰真实注册表与真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-h3-verify-"));
const dataDir = path.join(tmpBase, "home");
const projDir = path.join(tmpBase, "h3-proj");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(projDir, { recursive: true });
addProject({ id: "h3-proj", name: "H3 验证项目", path: projDir, kind: "backend" }, dataDir);

// 直接造 240 条流水（不依赖 chokidar 时序，后端分页/过滤/倒序是读路径逻辑）：
// 路径按 i 分布到 3 个目录，ts 严格递增（每秒一条），action/size_delta 轮转
const TOTAL = 240;
const ACTIONS = ["add", "modify", "remove"] as const;
const t0 = Date.parse("2026-09-17T10:00:00+08:00");
const allLines: ChangeLine[] = [];
for (let i = 0; i < TOTAL; i++) {
  allLines.push({
    ts: new Date(t0 + i * 1000).toISOString(),
    path: `src/dir${i % 3}/file${i}.ts`,
    action: ACTIONS[i % 3],
    size_delta: i % 3 === 2 ? -(i + 1) : i + 1,
  });
}
const changesFile = path.join(projDir, ".工作台", "changes.jsonl");
fs.mkdirSync(path.dirname(changesFile), { recursive: true });
fs.writeFileSync(changesFile, allLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(200);
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

interface ApiResp {
  status: number;
  body: {
    ok?: boolean;
    changes?: ChangeLine[];
    total?: number;
    error?: { code: string; message: string };
  };
}

async function http(rawPath: string): Promise<ApiResp> {
  const res = await fetch(`${BASE}${rawPath}`);
  return { status: res.status, body: (await res.json()) as ApiResp["body"] };
}

// 期望的全量倒序（最新在上）
const expectedDesc = [...allLines].reverse();
const sameLine = (a: ChangeLine, b: ChangeLine) =>
  a.ts === b.ts && a.path === b.path && a.action === b.action && a.size_delta === b.size_delta;

let child: ChildProcess | undefined;
try {
  await assertPortFree(PORT); // 端口已被占：立刻失败，不拿占用者的服务跑验证
  const proc = spawn(
    process.execPath,
    ["--import", "tsx", path.join("src", "server", "index.ts")],
    {
      env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    },
  );
  child = proc;
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  watchChild(proc, PORT, () => upPorts.has(PORT)); // 子进程早退（EADDRINUSE）立刻报错退出
  await waitUp();
  console.log(`[verify] server up at ${BASE}（TATAI_HOME=${dataDir}，造了 ${TOTAL} 条流水）`);

  // ── ① limit=50 → 50 条 + total=240，时间倒序 ──
  const p1 = await http("/api/projects/h3-proj/changes?limit=50");
  const c1 = p1.body.changes ?? [];
  ok(p1.status === 200 && c1.length === 50 && p1.body.total === TOTAL,
    `① limit=50 → 50 条且 total=${TOTAL}（实际: ${c1.length} 条 total=${p1.body.total}）`);
  ok(
    c1.every((l, i) => sameLine(l, expectedDesc[i])),
    "① 首页 50 条与全量倒序头部逐条全等（最新在上）",
  );
  ok(
    c1.every((l, i) => i === 0 || Date.parse(c1[i - 1].ts) >= Date.parse(l.ts)),
    "① ts 单调不增（时间倒序，DoD②）",
  );

  // ── ② offset 翻页：offset=50&limit=50 与切片全等；翻到底无重复无缺条 ──
  const p2 = await http("/api/projects/h3-proj/changes?limit=50&offset=50");
  const c2 = p2.body.changes ?? [];
  ok(
    c2.length === 50 && p2.body.total === TOTAL && c2.every((l, i) => sameLine(l, expectedDesc[50 + i])),
    "② offset=50 翻页与全量倒序 [50,100) 逐条全等",
  );
  const tail = await http(`/api/projects/h3-proj/changes?limit=50&offset=${TOTAL - 10}`);
  const cTail = tail.body.changes ?? [];
  ok(
    cTail.length === 10 && cTail.every((l, i) => sameLine(l, expectedDesc[TOTAL - 10 + i])),
    "② 翻到底（offset=230）返回最后 10 条，无重复无缺条",
  );

  // ── ③ path 子串过滤 ──
  const f = await http(`/api/projects/h3-proj/changes?path=${encodeURIComponent("dir1/")}`);
  const cf = f.body.changes ?? [];
  const expectedFilter = expectedDesc.filter((l) => l.path.includes("dir1/"));
  ok(
    f.status === 200 &&
      cf.length === expectedFilter.length &&
      f.body.total === expectedFilter.length &&
      cf.every((l) => l.path.includes("dir1/")),
    `③ path=dir1/ 过滤 → 全部命中且 total=${expectedFilter.length}（实际: ${cf.length} 条 total=${f.body.total}）`,
  );

  // ── ④ 过滤 + 分页组合 ──
  const fp = await http(
    `/api/projects/h3-proj/changes?path=${encodeURIComponent("dir2/")}&limit=20&offset=10`,
  );
  const cfp = fp.body.changes ?? [];
  const expectedFp = expectedDesc.filter((l) => l.path.includes("dir2/"));
  ok(
    cfp.length === 20 &&
      fp.body.total === expectedFp.length &&
      cfp.every((l, i) => sameLine(l, expectedFp[10 + i])),
    "④ 过滤+分页组合（dir2/ 的第 2 页）与期望切片逐条全等",
  );

  // ── ⑤ 非法参数与无参数全量 ──
  const badOffset = await http("/api/projects/h3-proj/changes?offset=-1");
  ok(
    badOffset.status === 400 && badOffset.body.error?.code === "INVALID_INPUT",
    `⑤ offset=-1 → 400 INVALID_INPUT（实际: ${badOffset.status} ${badOffset.body.error?.code}）`,
  );
  const badLimit = await http("/api/projects/h3-proj/changes?limit=abc");
  ok(
    badLimit.status === 400 && badLimit.body.error?.code === "INVALID_INPUT",
    `⑤ limit=abc → 400 INVALID_INPUT（实际: ${badLimit.status} ${badLimit.body.error?.code}）`,
  );
  const full = await http("/api/projects/h3-proj/changes");
  ok(
    (full.body.changes ?? []).length === TOTAL &&
      full.body.total === TOTAL &&
      sameLine(full.body.changes![0], expectedDesc[0]),
    `⑤ 无参数 → 全量 ${TOTAL} 条倒序 + total（H2 旧调用兼容，响应仅追加 total 字段）`,
  );
} finally {
  child?.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
