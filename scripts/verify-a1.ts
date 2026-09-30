// A1 验证脚本（用 tsx 跑）：tree-sitter 静态解析顶层模块骨架（纯静态，零 LLM）。
// 用法：pnpm verify:a1
// 覆盖点（对应 A1 卡 DoD 逐条）：
//   ① 对两个真实项目（一个 Python 后端 + 塔台自身 JS/TS，具体是哪个由 TATAI_REAL_IDS 给）在**隔离副本**上真跑
//      parseProject：源码树复制到 tmp、注册进隔离 home，产出 .工作台/arch/modules.json 并贴片段（模块清单 + 聚合边权重）；
//   ② 两项目顶层模块数都落在 5–15（§3.3 规则 1，贴数量）；
//   ③ 贴耗时：parse_ms（tree-sitter 解析阶段本身，不含遍历/IO）与单文件均值（毫秒级口径）；
//   ④ 绑定选型结论见 PROGRESS.md 流水（node binding，未决项 #2）；
//   ⑤ 采集层无损化：造 30 个顶层目录的临时项目 → 断言 modules.json 30 个模块全保留、无「其他」桶、
//      每个 id＝slugify(路径)；概览投影 buildSharedGraphFrom 仍 15 节点（14＋__more__、隐藏 16）。勘误见 ⑤ 段；
//   ⑥ import 解析正确性抽查：临时项目手写 py/ts 互相 import → 断言边与权重精确；
//   ⑦ 少于 5 时按二级目录细分补；
//   ⑧ HTTP 全链路：POST arch/parse 落盘 + GET arch/modules 读回 + 未解析空态 exists:false。
// 备注（2026-09-29 返工）：① 对真实项目在**隔离副本**上真跑（源码树复制到 tmp、注册进隔离 home），
// 真实项目 .工作台 零写入（2026-09-29 返工：此前真跑会重写真实 modules.json，Codex 审验要求改为隔离副本）。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDirectory, parseProject, readModules, slugify, type ArchModulesFile } from "../src/arch/parse";
import { ARCH_LIMITS, isJunkDir, MORE_NODE_ID } from "../src/arch/config";
import { buildSharedGraphFrom } from "../src/arch/shared-graph";
import { addProject, getProject } from "../src/server/registry";
import { ensureSelfRegistered, finish, realHome, realProjectIds, skip } from "./lib/fixtures";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
// 真实全局数据目录：TATAI_HOME > 缺省 ~/.tatai（脚本不写死作者本机路径）；
// 真实项目清单 = 塔台自身（本仓库，幂等登记）+ TATAI_REAL_IDS 列出的注册表项目 id
const REAL_DATA_DIR = realHome();
ensureSelfRegistered(REAL_DATA_DIR);

// ①②③ 隔离副本用的临时目录（隔离 home ＋ 隔离源码副本），main 收尾统一删除；
// 真实项目与真实 home 一律不碰（2026-09-29 返工：改隔离副本，不再对真实项目真跑落盘）。
const ISO_TMP: string[] = [];

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

/** 贴真实片段：模块清单 + 非空聚合边 */
function printFragment(tag: string, arch: ArchModulesFile, parseMs: number, durationMs: number, sourceFiles: number) {
  console.log(`[verify] ── ${tag} 真实片段：modules=${arch.modules.length}，parse_ms=${parseMs}（单文件均值 ${(parseMs / Math.max(1, sourceFiles)).toFixed(2)}ms），总耗时含 IO=${durationMs}ms`);
  for (const m of arch.modules) {
    const deps = m.deps.length > 0 ? ` deps=${JSON.stringify(m.deps)}` : "";
    console.log(`[verify]   ${m.id} path=${JSON.stringify(m.path)} files=${m.file_count} loc=${m.loc}${deps}`);
  }
  const edgeCount = arch.modules.reduce((n, m) => n + m.deps.length, 0);
  console.log(`[verify]   聚合边总数=${edgeCount}`);
}

/** 隔离副本用：递归复制源码树 srcRoot → dstRoot，**跳过**垃圾目录段（isJunkDir）与临时交换文件（*.tmp）。
 *  .工作台/node_modules/dist/target 等都在 JUNK_DIR_SEGMENTS 里，天然被跳过——与解析扫描的忽略口径一致，
 *  副本上解析出的模块集合因此与真实树等价；真实项目目录只读源、不写不改。 */
function copySourceTree(srcRoot: string, dstRoot: string): void {
  fs.mkdirSync(dstRoot, { recursive: true });
  for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    const src = path.join(srcRoot, entry.name);
    const dst = path.join(dstRoot, entry.name);
    if (entry.isDirectory()) {
      if (isJunkDir(entry.name)) continue;
      copySourceTree(src, dst);
    } else if (entry.isFile()) {
      if (entry.name.endsWith(".tmp")) continue;
      fs.copyFileSync(src, dst);
    }
    // 其余类型（符号链接等）跳过：解析扫描也不跟进，避免环
  }
}

async function main(): Promise<void> {
  // ── ①②③ 真实项目：塔台自身 + TATAI_REAL_IDS 给的项目（隔离副本上真跑，真实项目零写入）───
  console.log("[verify] ── ①②③ 真实项目解析（源码复制到隔离副本、注册进隔离 home；真实项目 .工作台 零写入）");
  // 2026-09-29（六图完整读取轮）：期望上界从 15 放开——采集层不再有损合并（DESIGN §4.3 修订），
  // 真实项目顶层候选 >15 是合法落盘结果；15 上限只约束概览投影层（⑤ 段已按新口径断言）。
  // 2026-09-29 返工（Codex 审验）：此前直接 parseProject(id, REAL_DATA_DIR) 会重写真实项目
  // .工作台/arch/modules.json；现改为复制源码树到隔离 tmp、注册进隔离 home，真实项目与真实 home 一律不写不删。
  try {
    for (const [id, expectMin] of realProjectIds().map((id) => [id, 5] as const)) {
      const real = getProject(id, REAL_DATA_DIR);
      if (!real) {
        skip(
          `① 真实项目 ${id} 解析`,
          `注册表里没有 ${id}：设 TATAI_REAL_IDS=<已登记的项目 id,…> 与 TATAI_HOME=<数据目录> 后可跑`,
        );
        continue;
      }
      // 隔离 home ＋ 隔离源码副本：真实项目目录只作只读源，不落盘、不注册进真实注册表
      const isoHome = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-a1-iso-home-"));
      ISO_TMP.push(isoHome);
      const srcTmp = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-a1-iso-src-"));
      ISO_TMP.push(srcTmp);
      const isoPath = path.join(srcTmp, "proj");
      copySourceTree(real.path, isoPath);
      const isoId = "a1-iso-" + id;
      addProject({ id: isoId, name: "A1 隔离副本", path: isoPath, kind: real.kind }, isoHome);
      const r = parseProject(isoId, isoHome);
      ok(fs.existsSync(r.source), `① ${id} modules.json 隔离副本落盘（${r.source}）`);
      ok(!r.source.startsWith(real.path), `① ${id} 落盘路径不在真实项目目录下（真实项目目录零写入）`);
      const back = readModules(isoId, isoHome);
      ok(back.exists === true && back.arch !== undefined, `① ${id} modules.json 可读回`);
      if (!back.arch) continue;
      ok(back.arch.version === 1 && typeof back.arch.generated_at === "string", `① ${id} 结构 version/generated_at 正确`);
      ok(back.arch.modules.every((m) => m.name === ""), `① ${id} name 字段留空（A2 Flash 起名填）`);
      ok(back.arch.modules.every((m) => typeof m.id === "string" && m.id !== "" && typeof m.file_count === "number"), `① ${id} id 稳定非空（路径 slug）`);
      ok(
        back.arch.modules.length >= expectMin,
        `② ${id} 顶层模块数 ${back.arch.modules.length} ≥ ${expectMin}（下限照旧；上界 2026-09-29 起放开——采集层 >15 合法落盘，15 上限在概览投影层）`,
      );
      const weightSum = back.arch.modules.flatMap((m) => m.deps).reduce((n, d) => n + d.weight, 0);
      console.log(`[verify]   ${id} import 提取 ${r.stats.imports} 条 → 聚合边权重总和 ${weightSum}（源码 ${r.stats.source_files} 文件，跳过大文件 ${r.stats.skipped_large}）`);
      ok(weightSum <= r.stats.imports, `① ${id} 边权重 ≤ import 条数（模块内边不画，只少不多）`);
      // tag 用原 id（输出可读性），内部数据来自隔离副本
      printFragment(id, back.arch, r.parse_ms, r.duration_ms, r.stats.source_files);
    }
  } finally {
    for (const dir of ISO_TMP) fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── ⑤ 采集层无损化：30 个顶层目录 → modules.json 全保留 + 概览投影仍 15 ─────
  // 2026-09-29 勘误（六图完整读取轮，DESIGN §4.3 已修订）：旧期望「落盘层合并后 ≤15＝14＋
  // id=other「其他」聚合桶」。依据变更：采集落盘层（parse.ts 删 mergeOverflow）不再有损合并，
  // >15 的候选原样落盘 modules.json；15 上限只在概览投影层（shared-graph.ts buildSharedGraphFrom
  // 的 ARCH_LIMITS.MAX_NODES）施加，保留 14 个真实节点＋1 个 __more__ 聚合节点。
  // 断言随之定向更新（不降强度：由「合并到 ≤15」改成「全保留、身份稳定」）。
  console.log("\n[verify] ── ⑤ 采集层无损化（30 顶层目录临时项目）");
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-a1-verify-"));
  try {
    const big = path.join(tmpBase, "proj-30dirs");
    for (let i = 1; i <= 30; i++) {
      const d = path.join(big, `mod${String(i).padStart(2, "0")}`);
      fs.mkdirSync(d, { recursive: true });
      // 文件数递减：mod01 最大，便于断言概览保留大头
      for (let j = 0; j <= 30 - i; j++) fs.writeFileSync(path.join(d, `f${j}.py`), `x${i}_${j} = 1\n`, "utf8");
    }
    const rBig = parseDirectory(big);
    const TOPS = 30;
    ok(rBig.file.modules.length === TOPS, `⑤ ${TOPS} 顶层目录 → modules.json ${rBig.file.modules.length} 个模块全保留（旧期望：合并后 ≤15＝14＋「其他」桶；新期望：全保留 ${TOPS}）`);
    ok(!rBig.file.modules.some((m) => m.id === "other" || m.path.startsWith("其他:")), "⑤ 无「其他」聚合桶（id=other / path 以「其他:」开头）（旧期望：存在该桶；新期望：采集层不合并）");
    ok(rBig.file.modules.every((m) => m.id === slugify(m.path)), "⑤ 每个模块 id＝slugify(路径)（稳定身份，原始候选逐个在场）");
    // 概览投影层上限仍在：buildSharedGraphFrom(模块数组) → 15 节点（14 真实＋__more__），隐藏 30−14
    const gOverview = buildSharedGraphFrom(rBig.file.modules, {});
    ok(
      gOverview.nodes.length === ARCH_LIMITS.MAX_NODES &&
        gOverview.nodes.filter((n) => n.aggregate !== true).length === ARCH_LIMITS.MAX_NODES - 1 &&
        gOverview.nodes.some((n) => n.id === MORE_NODE_ID) &&
        gOverview.truncated.nodes === TOPS - (ARCH_LIMITS.MAX_NODES - 1),
      `⑤ 概览投影：${gOverview.nodes.length} 节点（${ARCH_LIMITS.MAX_NODES - 1}＋__more__）、隐藏 ${gOverview.truncated.nodes}（上限移到概览层，不消失）`,
    );
    ok(rBig.file.modules.some((m) => m.id === "mod01"), "⑤ 文件数最大的目录保留为独立模块");
    const totalFiles = rBig.file.modules.reduce((n, m) => n + m.file_count, 0);
    ok(totalFiles === 465, `⑤ 落盘不丢文件（${totalFiles} = 30+29+…+1）`);

    // ── ⑥ import 解析正确性抽查（py 与 ts 各一组，权重精确）──────────
    console.log("\n[verify] ── ⑥ import 正确性（权重精确断言）");
    const imp = path.join(tmpBase, "proj-imports");
    // Python：pa/a.py 两条指向 pb/b.py（import pb.b + from pb import b）→ 边 pa→pb 权重 2
    fs.mkdirSync(path.join(imp, "pa"), { recursive: true });
    fs.mkdirSync(path.join(imp, "pb"), { recursive: true });
    fs.writeFileSync(path.join(imp, "pa", "a.py"), "import pb.b\nfrom pb import b\nfrom pb.b import thing\n", "utf8");
    fs.writeFileSync(path.join(imp, "pb", "b.py"), "thing = 1\n", "utf8");
    fs.writeFileSync(path.join(imp, "pb", "__init__.py"), "", "utf8");
    // TS：tsa/x.ts 三条指向 tsb/y.ts（import + export-from + require）→ 边 tsa→tsb 权重 3
    fs.mkdirSync(path.join(imp, "tsa"), { recursive: true });
    fs.mkdirSync(path.join(imp, "tsb"), { recursive: true });
    fs.writeFileSync(
      path.join(imp, "tsa", "x.ts"),
      'import { y } from "../tsb/y";\nexport { y } from "../tsb/y";\nconst q = require("../tsb/y");\nimport("./dyn");\n',
      "utf8",
    );
    fs.writeFileSync(path.join(imp, "tsa", "dyn.ts"), "export const d = 1;\n", "utf8");
    fs.writeFileSync(path.join(imp, "tsb", "y.ts"), "export const y = 1;\n", "utf8");
    const rImp = parseDirectory(imp);
    const find = (id: string) => rImp.file.modules.find((m) => m.id === id);
    const paPb = find("pa")?.deps.find((d) => d.to === "pb")?.weight;
    // import pb.b→pb/b.py、from pb import b→pb/__init__.py、from pb.b import thing→pb/b.py = 3 条
    ok(paPb === 3, `⑥ py 边 pa→pb 权重 = 3（import pb.b / from pb import b / from pb.b import，实际 ${paPb}）`);
    const tsaTsb = find("tsa")?.deps.find((d) => d.to === "tsb")?.weight;
    ok(tsaTsb === 3, `⑥ ts 边 tsa→tsb 权重 = 3（import / export-from / require，实际 ${tsaTsb}）`);
    const tsaSelf = find("tsa")?.deps.find((d) => d.to === "tsa");
    ok(tsaSelf === undefined, "⑥ 模块内边不画（import(\"./dyn\") 是模块内动态 import）");
    console.log(`[verify]   import 项目片段：${rImp.file.modules.map((m) => `${m.id}${m.deps.length ? JSON.stringify(m.deps) : ""}`).join(" ")}`);

    // ── ⑦ 少于 5：二级目录细分补 ──────────────────────────────────
    console.log("\n[verify] ── ⑦ 少于 5 细分补");
    const few = path.join(tmpBase, "proj-few");
    for (const sub of ["alpha", "beta", "gamma", "delta", "epsilon"]) {
      fs.mkdirSync(path.join(few, "src", sub), { recursive: true });
      fs.writeFileSync(path.join(few, "src", sub, "mod.py"), `v = "${sub}"\n`, "utf8");
    }
    const rFew = parseDirectory(few);
    ok(rFew.file.modules.length >= 5, `⑦ 单一 src 目录（5 个子目录）→ 细分补到 ${rFew.file.modules.length} ≥ 5`);
    ok(rFew.file.modules.some((m) => m.id === "src-alpha"), "⑦ 细分模块 id 为二级路径 slug（src-alpha）");

    // ── ⑧ HTTP 全链路 ───────────────────────────────────────────
    // ⑧ 用临时夹具（tmpBase/home ＋ 临时项目 imp），不碰真实项目与真实 home——无需隔离副本（2026-09-29 核查确认）
    console.log("\n[verify] ── ⑧ HTTP 全链路（临时数据目录 + 临时项目）");
    const dataDir = path.join(tmpBase, "home");
    fs.mkdirSync(dataDir, { recursive: true });
    addProject({ id: "p-arch", name: "架构解析项目", path: imp, kind: "backend" }, dataDir);
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

      // 未解析空态：GET arch/modules → exists:false（200，不是错误）
      const r0 = await fetch(`${BASE}/api/projects/p-arch/arch/modules`);
      const b0 = (await r0.json()) as { ok: boolean; arch: { exists: boolean } };
      ok(r0.status === 200 && b0.arch.exists === false, "⑧ 未解析 GET arch/modules → 200 exists:false");

      // POST arch/parse → 落盘 + 返回耗时与统计
      const r1 = await fetch(`${BASE}/api/projects/p-arch/arch/parse`, { method: "POST" });
      const b1 = (await r1.json()) as {
        ok: boolean;
        result: { source: string; module_count: number; duration_ms: number; parse_ms: number };
      };
      console.log(`[verify] POST arch/parse -> ${r1.status} modules=${b1.result?.module_count} parse_ms=${b1.result?.parse_ms} duration_ms=${b1.result?.duration_ms}`);
      ok(r1.status === 200 && b1.ok && b1.result.module_count >= 1, "⑧ POST arch/parse → 200 + 模块数");
      ok(fs.existsSync(b1.result.source), "⑧ POST arch/parse 真实落盘 modules.json");

      // GET 读回：与落盘一致
      const r2 = await fetch(`${BASE}/api/projects/p-arch/arch/modules`);
      const b2 = (await r2.json()) as { ok: boolean; arch: { exists: boolean; arch?: ArchModulesFile } };
      ok(r2.status === 200 && b2.arch.exists === true, "⑧ GET arch/modules 读回落盘结果");
      const paPbHttp = b2.arch.arch?.modules.find((m) => m.id === "pa")?.deps.find((d) => d.to === "pb")?.weight;
      ok(paPbHttp === 3, `⑧ HTTP 读回边 pa→pb 权重 = 3（实际 ${paPbHttp}）`);

      // 伪造 id → 404
      const r3 = await fetch(`${BASE}/api/projects/no-such/arch/parse`, { method: "POST" });
      ok(r3.status === 404, "⑧ 伪造项目 id POST arch/parse → 404");
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
