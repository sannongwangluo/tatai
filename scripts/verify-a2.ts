// A2 验证脚本（用 tsx 跑，真调 DeepSeek V4.1 Flash）：Flash 起名 + 硬上限渲染 JSON。
// 用法：pnpm verify:a2
// 覆盖点（对应 A2 卡 DoD 逐条）：
//   ① 对塔台自身起名（真调 Flash）：src/arch → 中文人话名，贴 7 模块真实对照表
//      （path → name/blurb/kind）；
//   ② 缓存（§12.2 风险 2）：连调两次 nameModules，第二次计数包装器证明 0 次 API 请求，
//      names.json 逐字节不变；
//   ③ 硬上限（§4.3 第 1 招）：造 50 模块超大项目 → 渲染 JSON 节点数 ≤ MAX_NODES 且出现
//      「还有 N 个」聚合节点；边超 MAX_EDGES 按权重截断；扇出过滤 top-K（第 4 招）；
//   ④ 提示词与上限数值落 src/arch/config.ts（§12.1 未决项 #3，断言导出存在）；
//   ⑤ 失败降级：mock chat 对指定模块抛错 → 该模块 fallback:true + path 兜底名，其余不阻塞；
//   ⑥ HTTP 全链路：POST arch/name（幂等走缓存）+ GET arch/render + 伪造 id 404。
// 备注：①② 对塔台自身真实落盘 .工作台/arch/names.json（塔台纳管口径内）；临时项目全走临时目录。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nameModules } from "../src/arch/name";
import { buildRenderGraph, renderGraph } from "../src/arch/render";
import { parseProject, type ArchModule } from "../src/arch/parse";
import { ARCH_LIMITS, MORE_NODE_ID, buildNameMessages } from "../src/arch/config";
import { chat as flashChat, type FlashMessage, type FlashOptions } from "../src/server/flash";
import { addProject } from "../src/server/registry";
import { ensureSelfRegistered, finish, realHome } from "./lib/fixtures";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
const REAL_DATA_DIR = realHome(); // TATAI_HOME > 缺省 ~/.tatai（脚本不写死作者本机路径）
ensureSelfRegistered(REAL_DATA_DIR); // 塔台自身＝本仓库：幂等登记，脚本换台机器也能跑

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

/** 造 N 个模块的超大骨架（mod01 文件最多，环状依赖 + 指向 hub 的扇出边） */
function makeBigModules(n: number): ArchModule[] {
  const modules: ArchModule[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `mod${String(i).padStart(2, "0")}`;
    modules.push({
      id,
      name: "",
      path: id,
      file_count: (n - i + 1) * 10,
      loc: (n - i + 1) * 100,
      deps: [
        // 环状边：mod01→mod02→…→modN→mod01，权重递减（大头之间边权高）
        { to: `mod${String((i % n) + 1).padStart(2, "0")}`, weight: n - i + 1 },
        // 扇出：所有模块都引 mod01（公共节点入边爆高，触发 §4.3 第 4 招）
        ...(i !== 1 ? [{ to: "mod01", weight: i }] : []),
      ],
    });
  }
  return modules;
}

async function main(): Promise<void> {
  // ── ④ 配置项（未决项 #3 收口证据）──────────────────────────────
  console.log("[verify] ── ④ 提示词与上限数值落 config.ts（§12.1 未决项 #3）");
  console.log(`[verify]   ARCH_LIMITS=${JSON.stringify(ARCH_LIMITS)}`);
  ok(ARCH_LIMITS.MAX_NODES === 15 && ARCH_LIMITS.MAX_EDGES === 40, "④ 硬上限数值落配置项（MAX_NODES=15 / MAX_EDGES=40）");
  ok(ARCH_LIMITS.MAX_FANOUT === 8 && ARCH_LIMITS.FANOUT_KEEP === 5, "④ 扇出过滤参数落配置项（MAX_FANOUT=8 / FANOUT_KEEP=5）");
  const promptProbe = buildNameMessages({ path: "src/arch", file_count: 4, loc: 100, deps: [], sample_files: ["src/arch/parse.ts"] });
  ok(promptProbe.length === 2 && promptProbe[0].content.includes("翻译") && promptProbe[0].content.includes("kind"), "④ 起名提示词落配置项（翻译职责 + kind 分类口径）");

  // ── ①② 塔台自身起名（真调 Flash）+ 缓存证据 ────────────────────
  console.log("\n[verify] ── ①② 塔台自身起名（真调 DeepSeek V4.1 Flash）+ 缓存");
  parseProject("tatai", REAL_DATA_DIR); // 确保 modules.json 为最新骨架
  // 计数包装器：真调底层 flashChat，统计 API 请求次数（DoD② 证据口径）
  let apiCalls = 0;
  const countingChat = (messages: FlashMessage[], opts?: FlashOptions) => {
    apiCalls++;
    return flashChat(messages, opts);
  };
  const namesPath = path.join(REPO_ROOT, ".工作台", "arch", "names.json");
  const r1 = await nameModules("tatai", { dataDir: REAL_DATA_DIR, chat: countingChat, force: true });
  ok(r1.named > 0 && r1.fallbacks === 0, `① 首次起名真发请求：named=${r1.named} fallbacks=${r1.fallbacks}（API 请求 ${apiCalls} 次）`);
  ok(fs.existsSync(namesPath), "① names.json 真实落盘 .工作台/arch/names.json");
  const callsAfterFirst = apiCalls;
  const bytes1 = fs.readFileSync(namesPath);

  // DoD① 真实对照表：path → name / blurb / kind（7 模块全贴）
  console.log("[verify]   ── DoD① 真实对照表（塔台自身 7 模块，Flash 真输出）：");
  const parsedR1 = await nameModules("tatai", { dataDir: REAL_DATA_DIR }); // 读缓存口径的对照（不再发请求则 named=0）
  const { arch } = (await import("../src/arch/parse")).readModules("tatai", REAL_DATA_DIR);
  for (const m of arch?.modules ?? []) {
    const e = r1.file.entries[m.id];
    console.log(`[verify]     ${m.path} → name=${JSON.stringify(e?.name)} blurb=${JSON.stringify(e?.blurb)} kind=${e?.kind}${e?.fallback ? " (fallback)" : ""}`);
    ok(e !== undefined && typeof e.name === "string" && e.name !== "" && /[一-龥]/.test(e.name), `① ${m.id} 产出中文人话名`);
    ok(e !== undefined && ["code", "data", "docs", "mixed"].includes(e.kind), `① ${m.id} kind 分类合法（${e?.kind}）`);
  }
  ok(parsedR1.named === 0, "② 第二次调用 named=0（签名命中缓存零请求）");

  // DoD② 缓存证据：再用计数包装器连调，0 次 API 请求 + names.json 逐字节不变
  const apiCallsBefore = apiCalls;
  const r2 = await nameModules("tatai", { dataDir: REAL_DATA_DIR, chat: countingChat });
  const bytes2 = fs.readFileSync(namesPath);
  ok(apiCalls - apiCallsBefore === 0 && r2.named === 0 && r2.cache_hits === r1.named, `② 连调第二次 0 次 API 请求（named=${r2.named} cache_hits=${r2.cache_hits}）`);
  ok(bytes1.equals(bytes2), "② names.json 逐字节不变（DoD②）");
  console.log(`[verify]   缓存证据：首次 API 请求 ${callsAfterFirst} 次 → 第二次 0 次，cache_hits=${r2.cache_hits}，文件 sha 前后一致`);

  // ── ③ 硬上限：50 模块超大项目 → 聚合节点 + 边截断 + 扇出过滤 ──
  console.log("\n[verify] ── ③ 硬上限（50 模块超大项目，§4.3 第 1/4 招）");
  const big = makeBigModules(50);
  const bigNames: Record<string, { name: string; blurb: string; kind: "code" }> = {};
  for (const m of big) bigNames[m.id] = { name: `模块${m.id}`, blurb: "", kind: "code" };
  const graph = buildRenderGraph(big, bigNames);
  const more = graph.nodes.find((n) => n.id === MORE_NODE_ID);
  ok(graph.nodes.length <= ARCH_LIMITS.MAX_NODES, `③ 50 模块 → 渲染节点 ${graph.nodes.length} ≤ MAX_NODES=${ARCH_LIMITS.MAX_NODES}`);
  ok(more !== undefined && more.aggregate === true, `③ 出现「还有 N 个」聚合节点（${more?.name}）`);
  if (more) console.log(`[verify]   聚合节点：name=${JSON.stringify(more.name)} file_count=${more.file_count} blurb=${JSON.stringify(more.blurb)}`);
  ok(graph.truncated.nodes === 50 - (ARCH_LIMITS.MAX_NODES - 1), `③ 被聚合节点数 ${graph.truncated.nodes} = 50 - (MAX_NODES-1)`);
  ok(graph.edges.length <= ARCH_LIMITS.MAX_EDGES, `③ 边数 ${graph.edges.length} ≤ MAX_EDGES=${ARCH_LIMITS.MAX_EDGES}（按权重截断，truncated.edges=${graph.truncated.edges}）`);
  const mod01In = graph.edges.filter((e) => e.to === "mod01");
  ok(mod01In.length <= ARCH_LIMITS.FANOUT_KEEP, `③ 扇出过滤：mod01 入边 ${mod01In.length} ≤ FANOUT_KEEP=${ARCH_LIMITS.FANOUT_KEEP}（top-K 保留）`);
  ok(graph.edges.every((e, i, arr) => i === 0 || arr[i - 1].weight >= e.weight), "③ 边按权重降序（截断保大头）");
  // 被聚合节点的边重定向进 __more__
  const moreEdges = graph.edges.filter((e) => e.from === MORE_NODE_ID || e.to === MORE_NODE_ID);
  console.log(`[verify]   重定向进 __more__ 的边 ${moreEdges.length} 条；总边 ${graph.edges.length} 条（截断前含扇出过滤）`);

  // 无缓存名字时的兜底：name 回落模块 id，不炸
  const graphNoNames = buildRenderGraph(big.slice(0, 5), {});
  ok(graphNoNames.nodes.every((n) => n.name === n.id), "③ 无 names.json 缓存时 name 兜底模块 id（纯本地零 LLM）");

  // ── ⑤ 失败降级：mock chat 对指定模块抛错 ──────────────────────
  console.log("\n[verify] ── ⑤ 单模块失败降级（mock flash 报错，不阻塞整体）");
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-a2-verify-"));
  try {
    const projDir = path.join(tmpBase, "proj-fallback");
    for (const d of ["alpha", "beta", "gamma"]) {
      fs.mkdirSync(path.join(projDir, d), { recursive: true });
      fs.writeFileSync(path.join(projDir, d, "m.py"), `v = "${d}"\n`, "utf8");
    }
    const dataDir = path.join(tmpBase, "home");
    fs.mkdirSync(dataDir, { recursive: true });
    addProject({ id: "p-fallback", name: "降级验证", path: projDir, kind: "backend" }, dataDir);
    parseProject("p-fallback", dataDir);
    // mock：beta 模块必炸，其余返回合法 JSON（按提示词 user 内容里的模块路径分辨）
    const mockChat = (messages: FlashMessage[]) => {
      const user = JSON.parse(messages[1].content) as { 模块路径: string };
      if (user.模块路径 === "beta") return Promise.reject(new Error("mock：beta 模块 API 500"));
      return Promise.resolve(JSON.stringify({ name: `${user.模块路径}模块`, blurb: "mock 说明", kind: "code" }));
    };
    const rf = await nameModules("p-fallback", { dataDir, chat: mockChat });
    const beta = rf.file.entries["beta"];
    ok(rf.fallbacks === 1 && beta?.fallback === true, `⑤ beta 失败降级 fallback:true（fallbacks=${rf.fallbacks}）`);
    ok(beta?.name === "beta", `⑤ 兜底名为 path 末段（实际 ${JSON.stringify(beta?.name)}）`);
    ok(rf.named >= 2 && rf.file.entries["alpha"]?.name === "alpha模块", "⑤ 其余模块正常起名不阻塞");
    // fallback 不参与缓存命中：再调一次会重试（这次不炸了）
    const retryChat = (messages: FlashMessage[]) => {
      const user = JSON.parse(messages[1].content) as { 模块路径: string };
      return Promise.resolve(JSON.stringify({ name: `${user.模块路径}模块`, blurb: "重试成功", kind: "code" }));
    };
    const rr = await nameModules("p-fallback", { dataDir, chat: retryChat });
    ok(rr.named === 1 && rr.file.entries["beta"]?.fallback === undefined, "⑤ fallback 条目不命中缓存，重试转正");

    // ── ⑥ HTTP 全链路（临时数据目录 + 真实后端子进程）─────────────
    console.log("\n[verify] ── ⑥ HTTP 全链路");
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

      // GET arch/render：names.json 已有缓存（上一步 retryChat 转正后）→ 渲染 JSON
      const g0 = await fetch(`${BASE}/api/projects/p-fallback/arch/render`);
      const gb = (await g0.json()) as { ok: boolean; render: { exists: boolean; graph?: { nodes: { id: string; name: string }[]; edges: unknown[] } } };
      ok(g0.status === 200 && gb.render.exists === true, "⑥ GET arch/render → 200 exists:true");
      ok(gb.render.graph?.nodes.every((n) => n.name !== "") === true, "⑥ 渲染节点 name 非空（缓存名或 id 兜底）");
      console.log(`[verify]   render 节点：${gb.render.graph?.nodes.map((n) => `${n.id}=${n.name}`).join(" ")}`);

      // POST arch/name 幂等：缓存已全命中 → named=0（HTTP 层无密钥时也能跑通缓存路径）
      const n0 = await fetch(`${BASE}/api/projects/p-fallback/arch/name`, { method: "POST" });
      const nb = (await n0.json()) as { ok: boolean; result: { named: number; cache_hits: number; fallbacks: number } };
      console.log(`[verify]   POST arch/name -> ${n0.status} named=${nb.result?.named} cache_hits=${nb.result?.cache_hits} fallbacks=${nb.result?.fallbacks}`);
      ok(n0.status === 200 && nb.result.named === 0 && nb.result.cache_hits >= 3, "⑥ POST arch/name 幂等走缓存（named=0，零 API 请求）");

      // 未解析项目 GET arch/render → exists:false 空态
      const emptyDir = path.join(tmpBase, "proj-empty");
      fs.mkdirSync(emptyDir, { recursive: true });
      fs.writeFileSync(path.join(emptyDir, "a.py"), "a = 1\n", "utf8");
      addProject({ id: "p-empty", name: "空项目", path: emptyDir, kind: "backend" }, dataDir);
      const g1 = await fetch(`${BASE}/api/projects/p-empty/arch/render`);
      const g1b = (await g1.json()) as { render: { exists: boolean } };
      ok(g1.status === 200 && g1b.render.exists === false, "⑥ 未解析 GET arch/render → 200 exists:false");
      // 未解析 POST arch/name → 400
      const n1 = await fetch(`${BASE}/api/projects/p-empty/arch/name`, { method: "POST" });
      ok(n1.status === 400, "⑥ 未解析 POST arch/name → 400（先跑 arch/parse）");

      // 伪造 id → 404
      const n2 = await fetch(`${BASE}/api/projects/no-such/arch/name`, { method: "POST" });
      ok(n2.status === 404, "⑥ 伪造项目 id POST arch/name → 404");
      const g2 = await fetch(`${BASE}/api/projects/no-such/arch/render`);
      ok(g2.status === 404, "⑥ 伪造项目 id GET arch/render → 404");
    } finally {
      child?.kill();
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  finish();
}

main().catch((err) => {
  console.error("[verify] 异常:", err);
  process.exitCode = 1;
});
