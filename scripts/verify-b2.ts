// B2 验证脚本（用 tsx 跑）：记忆检索 MCP 接入，覆盖 B2 卡 DoD + HTTP 全链路。
// 用法：pnpm verify:b2（记忆检索 server 启动参数默认读 ~/.kimi-code/mcp.json 的 brain-memory 条目）
// 覆盖点：
//   ① 真实检索：对真实记忆检索 server 检索"塔台"关键词，真实返回记忆条目（贴 id + 主题词级摘要）
//   ② 降级路径：启动命令指向不存在路径 → 返回 {available:false, reason}，不抛错
//   ③ 无结果关键词（随机乱串）→ available 结构正常（available:true 且 results 为数组）
//   ④ HTTP 全链路：GET /api/projects/:id/memory?q=塔台 → 200 + 真实命中；
//      不带 q → 缺省用项目名检索；伪造 id → 404
// 隐私红线：流水只贴命中条目的 id 与限长主题词级摘要，绝不贴记忆全文。
// 备注：记忆检索 server 每次调用是新进程 + 加载精排模型，冷启动远超 15s
// （其本机 mcp.json 配的 startupTimeoutMs=60000/toolTimeoutMs=300000 同口径），
// 故真实检索断言用放宽超时；生产默认超时仍是 15s（超时即降级，不阻塞起草）。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { queryMemory, resolveBrainMcpConfig } from "../src/server/memory";
import { addProject } from "../src/server/registry";
import { finish, skip } from "./lib/fixtures";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8796;
const BASE = `http://localhost:${PORT}`;
const REAL_TIMEOUT_MS = 180_000; // 真实检索：冷启动模型加载放宽到 3 分钟

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUp(): Promise<void> {
  for (let i = 0; i < 100; i++) {
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
  throw new Error("后端 20 秒内未就绪");
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

async function main(): Promise<void> {
  // ── 启动参数口径（贴出来供流水核对）──────────────────────────────
  const cfg = resolveBrainMcpConfig();
  console.log(
    `[verify] 启动参数口径: ${cfg ? `${cfg.command} ${cfg.args.join(" ")}（cwd=${cfg.cwd ?? "(无)"}）` : "未配置"}`,
  );
  if (cfg === null) {
    skip(
      "①③ 真实检索（记忆检索 MCP 未配置）",
      "在 ~/.kimi-code/mcp.json 里配好 brain-memory 条目，或设 TATAI_BRAIN_MCP_CONFIG=<mcp.json> 后可跑",
    );
  } else {
    ok(true, "解析到记忆检索 server 启动参数（mcp.json brain-memory 条目）");
  }

  // ── ② 降级路径：不存在的启动命令 → available:false + reason，不抛 ──
  console.log("\n[verify] ── ② 降级路径（启动命令指向不存在路径）");
  const degraded = await queryMemory("塔台", {
    config: {
      command: path.join(os.tmpdir(), "no-such-dir", "no-such-python.exe"),
      args: ["-m", "brain_memory.mcp_server"],
    },
    timeoutMs: 10_000,
  });
  console.log(`[verify] 降级返回: ${JSON.stringify(degraded)}`);
  ok(degraded.available === false, "② 返回 available:false 而非抛错");
  ok(
    !degraded.available && typeof degraded.reason === "string" && degraded.reason !== "",
    `② 带降级原因（${!degraded.available ? degraded.reason : "-" }）`,
  );

  // ── ① 真实检索："塔台"关键词 → 真实命中（DoD①）──────────────────
  console.log("\n[verify] ── ① 真实检索「塔台」（冷启动放宽超时）");
  const real = cfg === null ? null : await queryMemory("塔台", { timeoutMs: REAL_TIMEOUT_MS, limit: 5 });
  if (real === null) {
    console.log("[verify]   未配置记忆检索 MCP → 本段随上面的 SKIP 一起没跑（不当 PASS）");
  } else if (real.available) {
    console.log(
      `[verify] 命中 ${real.results.length} 条（tool=${real.tool} 耗时=${real.duration_ms}ms），id+主题词级摘要：`,
    );
    for (const h of real.results) {
      console.log(`  | #${h.id ?? "?"} [${h.created ?? "-"}] ${h.summary.slice(0, 60)}`);
    }
    ok(real.results.length > 0, `DoD① 检索「塔台」真实返回记忆条目（${real.results.length} 条）`);
    ok(
      real.results.every((h) => h.summary.length <= 200),
      "① 摘要均限长（两阶段注入：无全文）",
    );
  } else {
    skip("① 真实检索（DoD①）", `检索通道不可用（${real.reason}）：配置/环境问题，这一段没跑，不算通过`);
  }

  // ── ③ 无结果关键词：随机乱串 → 结构正常 ─────────────────────────
  console.log("\n[verify] ── ③ 无结果关键词（随机乱串）");
  const gibberish = `zzqxkvjr${Math.random().toString(36).slice(2, 10)}`;
  const empty = cfg === null ? null : await queryMemory(gibberish, { timeoutMs: REAL_TIMEOUT_MS, limit: 5 });
  if (empty === null) {
    console.log("[verify]   未配置记忆检索 MCP → 本段随上面的 SKIP 一起没跑（不当 PASS）");
  } else if (empty.available) {
    console.log(`[verify] 乱串「${gibberish}」→ available:true，results ${empty.results.length} 条`);
    ok(Array.isArray(empty.results), "③ available:true 且 results 为数组（空结果口径正常）");
  } else {
    // 检索通道本身不可用也算可接受的降级，但上面①已成功，这里不应发生
    skip("③ 无结果关键词（DoD③）", `检索通道不可用（${empty.reason}）：这一段没跑`);
  }

  // ── ④ HTTP 全链路 ───────────────────────────────────────────────
  console.log("\n[verify] ── ④ HTTP 全链路");
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-b2-verify-"));
  const dataDir = path.join(tmpBase, "home");
  fs.mkdirSync(dataDir, { recursive: true });
  addProject({ id: "tatai-self", name: "塔台", path: REPO_ROOT, kind: "backend" }, dataDir);

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
    console.log(`[verify] server up at ${BASE}（TATAI_HOME=${dataDir}）`);

    // ④a：带 q=塔台 → 真实命中（服务端默认 15s 超时，模型已被①②③热过 OS 缓存）
    const r1 = await fetch(`${BASE}/api/projects/tatai-self/memory?q=${encodeURIComponent("塔台")}`);
    const b1 = (await r1.json()) as {
      ok: boolean;
      memory: { available: boolean; results?: Array<{ id: number | null; summary: string }>; reason?: string };
    };
    console.log(
      `[verify] GET memory?q=塔台 -> ${r1.status} available=${b1.memory.available}` +
        (b1.memory.available
          ? ` 命中=${b1.memory.results?.length} 首条=#${b1.memory.results?.[0]?.id ?? "?"} ${b1.memory.results?.[0]?.summary.slice(0, 60) ?? ""}`
          : ` reason=${b1.memory.reason}`),
    );
    ok(r1.status === 200 && b1.ok === true, "④a GET /api/projects/:id/memory?q=塔台 → 200 ok");
    ok(
      b1.memory.available === true && (b1.memory.results?.length ?? 0) > 0,
      "④a HTTP 链路真实返回命中条目",
    );

    // ④b：不带 q → 缺省用项目名（本项目 name=塔台，等价于 q=塔台）
    const r2 = await fetch(`${BASE}/api/projects/tatai-self/memory`);
    const b2 = (await r2.json()) as { ok: boolean; memory: { available: boolean; query?: string } };
    console.log(
      `[verify] GET memory（无 q）-> ${r2.status} available=${b2.memory.available} query=${(b2.memory as { query?: string }).query ?? "-"}`,
    );
    ok(r2.status === 200 && b2.ok === true, "④b 不带 q → 200 ok（缺省用项目名检索）");
    ok(
      (b2.memory as { query?: string }).query === "塔台",
      "④b 缺省 q 回落为项目名「塔台」",
    );

    // ④c：伪造 id → 404
    const r3 = await fetch(`${BASE}/api/projects/nosuchproj/memory?q=x`);
    const b3 = (await r3.json()) as { error?: { code: string; message: string } };
    console.log(`[verify] 伪造 id -> ${r3.status} ${b3.error?.code}: ${b3.error?.message}`);
    ok(r3.status === 404 && b3.error?.code === "PROJECT_NOT_FOUND", "④c 伪造 id → 404 PROJECT_NOT_FOUND");
  } finally {
    child?.kill();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  finish();
}

main().catch((err) => {
  console.error("[verify] 异常:", err);
  process.exitCode = 1;
});
