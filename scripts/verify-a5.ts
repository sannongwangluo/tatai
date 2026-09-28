// A5 验证脚本（用 tsx 跑）：模块状态 + 文件级变动点 + 对账标黄（挂在 Gate 上）。
// 用法：pnpm verify:a5
// 覆盖点（对应 A5 卡 DoD 逐条）：
//   ① 模块状态：临时项目 progress.json 造 todo/doing/done/issue 四态 → GET arch/render 节点状态一一对应
//      （**服务端 v1 读口**口径，本段未变）；UI 段 playwright 断言的是**界面上屏的 v2 派生状态**
//      （`data-display-status` + `data-status-label`，依据见 PY_SHOT 头部"定向更新"注释）；
//   ② 文件级变动点：changes.jsonl 造近时/超时对照记录 → expand 文件节点仅近时的标 changed_recently；
//      窗口常量在 src/arch/config.ts（CHANGE_DOT_WINDOW_HOURS=24）；
//   ③ 对账两向：临时项目 design.md 手写模块清单 {A,B,C} + modules.json 静态结果 {B,C,D}
//      → only_in_design=[A]、only_in_code=[d]（手工制造两种情况）；塔台自身真跑：
//      DESIGN.md §11.1 十项 vs 静态解析实况模块数 → 贴真实差异输出（设计预期的信号展示）；
//   ④ Gate 联动：POST gate 过关 → 响应含对账结果且 reconcile-last.json 落盘；
//      放 reconcile-request.json 后 POST arch/reconcile → 标记被消费清除；
//   ⑤ 未决项 #4 结论（汇总一行 + 单条平铺）在 UI 段验证面板实际渲染后写流水。
//   ④ F4 补断言：模块状态与对账标黄在**数据流向图**上同样成立（同一份派生表 / reconcile-last.json，
//      状态不因视图改——`NODE_COLOR_RULE`）；a5-04-data-flow-four-colors.png 为证。
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANGE_DOT_WINDOW_HOURS } from "../src/arch/config";
import { expandDirectory } from "../src/arch/expand";
import { readModules } from "../src/arch/parse";
import {
  RECONCILE_SIGNAL_NOTE,
  extractDesignModules,
  extractTataiDesignModules,
  reconcileProject,
} from "../src/arch/reconcile";
import { addProject, getProject } from "../src/server/registry";
import { ensureSelfRegistered, finish, realHome } from "./lib/fixtures";
import { fetchTechDisplayExpectations } from "./lib/displayStatus";
import { addModule, setModuleStatus, type ModuleStatus } from "../src/server/workstation";
import { nowIso } from "../src/server/time";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HTTP_PORT = 8796;
const BASE = `http://localhost:${HTTP_PORT}`;
const REAL_DATA_DIR = realHome(); // TATAI_HOME > 缺省 ~/.tatai（脚本不写死作者本机路径）
ensureSelfRegistered(REAL_DATA_DIR); // 塔台自身＝本仓库：幂等登记，脚本换台机器也能跑
const VERIFY_DIR = path.join(REPO_ROOT, ".工作台", "verify");

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUp(url: string, label: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) {
        upPorts.add(Number(new URL(url).port));
        return;
      }
    } catch {
      // 还没起来，继续等
    }
    await sleep(200);
  }
  throw new Error(`${label} 20 秒内未就绪`);
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
function watchChild(
  proc: ChildProcess,
  port: number,
  isUp: () => boolean,
  label = "后端",
): void {
  proc.once("exit", async (code) => {
    if (isUp()) return; // 脚本自己收尾杀的，不算异常
    const why = (await portListening(port))
      ? `端口 ${port} 被占用`
      : `进程提前退出（code=${code}）`;
    console.error(`[verify] ${label}起不来：${why}，先清理残留进程`);
    process.exit(1);
  });
}

/** 端口是否被占（占用则不起自己的服务，避免碰用户的 dev server） */
async function portBusy(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(800) });
    return true;
  } catch {
    return false;
  }
}

/** 造一份 modules.json 夹具（模拟 A1 静态解析落盘结果） */
function writeModulesFixture(root: string, ids: string[]): void {
  const file = path.join(root, ".工作台", "arch", "modules.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        version: 1,
        generated_at: nowIso(),
        modules: ids.map((id) => ({ id, name: "", path: id, file_count: 1, loc: 1, deps: [] })),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

async function spawnServer(port: number, dataDir: string): Promise<ChildProcess> {
  await assertPortFree(port); // 端口已被占：立刻失败，不拿占用者的服务跑验证
  const child = spawn(
    process.execPath,
    ["--import", "tsx", path.join("src", "server", "index.ts")],
    {
      env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    },
  );
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server:${port}] ${d}`));
  watchChild(child, port, () => upPorts.has(port)); // 子进程早退（EADDRINUSE）立刻报错退出
  return child;
}

async function main(): Promise<void> {
  // ── ③ 单元级：设计书模块清单提取（两路真实口径）────────────────
  console.log("[verify] ── ③ 设计书模块清单提取（单元级）");
  const designMd = fs.readFileSync(path.join(REPO_ROOT, "DESIGN.md"), "utf8");
  const tataiModules = extractTataiDesignModules(designMd);
  ok(
    tataiModules.length === 10 && tataiModules.every((m) => m.confidence === "high"),
    `③ 塔台例外：DESIGN.md §11.1 表格提取 10 项（实际 ${tataiModules.length}）`,
  );
  ok(
    tataiModules.some((m) => m.name === "模块方框图") && tataiModules.some((m) => m.name === "Gate 时间线"),
    `③ §11.1 表第 2 列真实模块名（${tataiModules.map((m) => m.name).join("/")}）`,
  );
  const generic = extractDesignModules(
    ["# 某项目设计稿", "", "## 模块划分", "", "- A", "- B：第二个模块", "- C（核心）", "", "## 其他节", "- 不该被收"].join("\n"),
  );
  ok(
    JSON.stringify(generic.map((m) => m.name)) === JSON.stringify(["A", "B", "C"]),
    `③ 通用提取：「模块划分」节列表项 + 说明性后缀清洗（实际 ${JSON.stringify(generic)}）`,
  );
  ok(generic.every((m) => m.confidence === "high"), "③ 约定节提取 confidence=high");
  // ── V08-01 稳定 ID 契约（§4.5 那张迁移卡）──────────────────────
  ok(
    JSON.stringify(tataiModules.map((m) => m.stable_id)) ===
      JSON.stringify(["11.1-01", "11.1-02", "11.1-03", "11.1-04", "11.1-05", "11.1-06", "11.1-07", "11.1-08", "11.1-09", "11.1-10"]) &&
      tataiModules.every((m) => m.identity_basis === "declared_number" && m.declared_key !== ""),
    `③ §11.1 十项改用**材料声明的编号**作稳定身份（${tataiModules.map((m) => m.stable_id).join("/")}）——不再把中文功能名当身份`,
  );
  ok(
    tataiModules.every((m) => m.section_path !== null && m.section_path.includes("11.1")),
    `③ 每条声明都带审定材料索引（章节路径，如「${String(tataiModules[0]?.section_path).slice(-20)}」）`,
  );
  ok(
    generic.every((m) => m.identity_basis === "material_position" && m.stable_id.startsWith("s")) &&
      JSON.stringify(generic.map((m) => m.declared_key)) === JSON.stringify(["L5", "L6", "L7"]),
    `③ 材料没给稳定键的列表项如实退化为**材料定位**（${generic.map((m) => m.stable_id).join("/")}；改名不换身份，重排会换，身份依据已标注）`,
  );
  // 改名不换身份：只把名字改掉，稳定 ID 逐字不变
  const renamed = extractDesignModules(
    ["# 某项目设计稿", "", "## 模块划分", "", "- 甲甲甲", "- 乙乙乙", "- 丙丙丙", ""].join("\n"),
  );
  ok(
    JSON.stringify(renamed.map((m) => m.stable_id)) === JSON.stringify(generic.map((m) => m.stable_id)),
    `③ 改名不换身份：名称全换后稳定 ID 逐字不变（${renamed.map((m) => m.stable_id).join("/")}）——§4.7`,
  );
  const fuzzy = extractDesignModules(["# x", "## 模块", "- 甲", "- 乙"].join("\n"));
  ok(
    fuzzy.length === 2 && fuzzy.every((m) => m.confidence === "low"),
    "③ 无「模块划分」节 → 模糊节兜底 confidence=low",
  );

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-a5-verify-"));
  const dataDir = path.join(tmpBase, "home");
  fs.mkdirSync(dataDir, { recursive: true });

  // ── ② 文件级变动点（逻辑层，近时/超时对照）────────────────────
  console.log("\n[verify] ── ② 文件级变动点（expandDirectory + changes.jsonl 窗口）");
  ok(CHANGE_DOT_WINDOW_HOURS === 24, `② 变动点时间窗可配：config.ts CHANGE_DOT_WINDOW_HOURS=${CHANGE_DOT_WINDOW_HOURS}`);
  const projColor = path.join(tmpBase, "proj-color");
  fs.mkdirSync(path.join(projColor, "src"), { recursive: true });
  fs.writeFileSync(path.join(projColor, "src", "a.ts"), "export const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(projColor, "src", "b.ts"), "export const b = 1;\n", "utf8");
  fs.mkdirSync(path.join(projColor, ".工作台"), { recursive: true });
  const old = new Date(Date.now() - (CHANGE_DOT_WINDOW_HOURS + 1) * 3600_000).toISOString();
  fs.writeFileSync(
    path.join(projColor, ".工作台", "changes.jsonl"),
    JSON.stringify({ ts: nowIso(), path: "src/a.ts", action: "modify", size_delta: 3 }) + "\n" +
      JSON.stringify({ ts: old, path: "src/b.ts", action: "modify", size_delta: 2 }) + "\n",
    "utf8",
  );
  const exp = expandDirectory(projColor, "src");
  ok(
    exp.children.find((c) => c.name === "a.ts")?.changed_recently === true,
    "② 近 24h 有记录的文件节点标 changed_recently",
  );
  ok(
    exp.children.find((c) => c.name === "b.ts")?.changed_recently !== true,
    "② 超出时间窗的记录不标（窗口生效）",
  );

  // ── ③ 对账两向（逻辑层，手工制造两种情况）──────────────────────
  console.log("\n[verify] ── ③ 对账两向（设计 {A,B,C} vs 代码 {B,C,D}）");
  const projRecon = path.join(tmpBase, "proj-recon");
  fs.mkdirSync(projRecon, { recursive: true });
  addProject({ id: "p-a5-recon", name: "A5 对账验证", path: projRecon, kind: "backend" }, dataDir);
  fs.mkdirSync(path.join(projRecon, ".工作台"), { recursive: true });
  fs.writeFileSync(
    path.join(projRecon, ".工作台", "design.md"),
    ["# A5 对账验证 设计稿", "", "## 模块划分", "", "- A", "- B", "- C", ""].join("\n"),
    "utf8",
  );
  writeModulesFixture(projRecon, ["b", "c", "d"]);
  const recon = reconcileProject("p-a5-recon", { trigger: "verify-logic", dataDir });
  ok(
    JSON.stringify(recon.only_in_design.map((d) => d.name)) === JSON.stringify(["A"]),
    `③ 设计书有代码没有 → only_in_design=[A]（实际 ${JSON.stringify(recon.only_in_design)}）`,
  );
  ok(
    JSON.stringify(recon.only_in_code.map((c) => c.id)) === JSON.stringify(["d"]),
    `③ 代码有设计书没有 → only_in_code=[d]（实际 ${JSON.stringify(recon.only_in_code)}）`,
  );
  ok(
    recon.matched.length === 2 && recon.note === RECONCILE_SIGNAL_NOTE,
    "③ matched=[B,C] + 结果带「信号不是错误」口径文案",
  );
  ok(recon.consumed_request === null, "③ 无对账钩子时 consumed_request=null");
  ok(
    fs.existsSync(path.join(projRecon, ".工作台", "arch", "reconcile-last.json")),
    "③ 对账结果落盘 .工作台/arch/reconcile-last.json",
  );

  // ── ③-2 路径写法归一（2026-09-22 批外缺陷修复）────────────────────
  // 修前：`norm()` 只去空白/反引号/下划线/括号，**不处理路径分隔符**——设计书按目录写法写
  // `src/`、`tests/`，代码侧 id 是 `src`、`tests`，两边永远对不上，于是 matched=0、
  // 每个模块都被报成"双向差异"（真实项目实测 14 个模块全落假差异）。
  console.log("\n[verify] ── ③-2 路径写法归一（设计 `src/` ↔ 代码 id `src`）");
  const projSlash = path.join(tmpBase, "proj-slash");
  fs.mkdirSync(projSlash, { recursive: true });
  addProject({ id: "p-a5-slash", name: "A5 路径写法验证", path: projSlash, kind: "backend" }, dataDir);
  fs.mkdirSync(path.join(projSlash, ".工作台"), { recursive: true });
  fs.writeFileSync(
    path.join(projSlash, ".工作台", "design.md"),
    ["# A5 路径写法验证 设计稿", "", "## 模块划分", "", "- `src/`：核心源码", "- `tests/`：测试", "- 只有设计有的模块", ""].join("\n"),
    "utf8",
  );
  writeModulesFixture(projSlash, ["src", "tests", "extra"]);
  const slashRecon = reconcileProject("p-a5-slash", { trigger: "verify-slash", dataDir });
  ok(
    JSON.stringify(slashRecon.matched.map((m) => `${m.design}→${m.module_id}`)) === JSON.stringify(["src/→src", "tests/→tests"]),
    `③-2 设计书的 \`src/\`、\`tests/\` 与代码 id 对上（actual ${JSON.stringify(slashRecon.matched)}）`,
  );
  ok(
    JSON.stringify(slashRecon.only_in_design.map((d) => d.name)) === JSON.stringify(["只有设计有的模块"]) &&
      JSON.stringify(slashRecon.only_in_code.map((c) => c.id)) === JSON.stringify(["extra"]),
    `③-2 差异只剩真正不同的两条（only_in_design=${JSON.stringify(slashRecon.only_in_design.map((d) => d.name))} / only_in_code=${JSON.stringify(slashRecon.only_in_code.map((c) => c.id))}）`,
  );
  // 反向对照：归一化只做"加法"——真正对不上的东西不许被凑成同一条
  ok(
    slashRecon.matched.length === 2 && slashRecon.design_modules.length === 3 && slashRecon.code_modules.length === 3,
    "③-2 归一化没把不同模块误判成同一条（3 设计项 + 3 代码模块 → 恰好 2 对匹配）",
  );

  // ── HTTP 全链路（四色 render + Gate 联动 + 钩子消费）────────────
  console.log("\n[verify] ── ①④ HTTP 全链路（临时后端 8796）");
  addProject({ id: "p-a5-color", name: "A5 四色验证", path: projColor, kind: "backend" }, dataDir);
  writeModulesFixture(projColor, ["m1", "m2", "m3", "m4", "m5"]);
  const child = await spawnServer(HTTP_PORT, dataDir);
  try {
    await waitUp(`${BASE}/health`, "后端");

    // ① 四色：progress.json 造四态 + 一个无记录模块（m5）
    const statuses: [string, ModuleStatus][] = [
      ["m1", "todo"],
      ["m2", "doing"],
      ["m3", "done"],
      ["m4", "issue"],
    ];
    for (const [id, status] of statuses) {
      const r = await fetch(`${BASE}/api/projects/p-a5-color/modules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, name: id, status }),
      });
      ok(r.status === 200, `① POST modules ${id}=${status} → 200`);
    }
    const render = await fetch(`${BASE}/api/projects/p-a5-color/arch/render`);
    const renderBody = (await render.json()) as {
      ok: boolean;
      render: { exists: boolean; graph?: { nodes: { id: string; status?: string }[] } };
    };
    const statusOf = Object.fromEntries(
      (renderBody.render.graph?.nodes ?? []).map((n) => [n.id, n.status]),
    );
    ok(
      statusOf.m1 === "todo" && statusOf.m2 === "doing" && statusOf.m3 === "done" && statusOf.m4 === "issue",
      `① 模块四色与 progress.json 一一对应（${JSON.stringify(statusOf)}）`,
    );
    ok(!("status" in statusOf && statusOf.m5 !== undefined) && statusOf.m5 === undefined,
      "① progress.json 无记录的模块 status 缺省（UI 按 todo 灰「未开始」渲染）");

    // ④ Gate 联动：过关自动跑对账，响应带回 + reconcile-last.json 落盘
    const gate = await fetch(`${BASE}/api/projects/p-a5-color/gate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step: "kickoff", result: "pass", note: "A5 验证：过关触发对账" }),
    });
    const gateBody = (await gate.json()) as {
      ok: boolean;
      reconcile?: { trigger?: string; only_in_code?: { id: string }[]; note?: string };
    };
    ok(gate.status === 200 && gateBody.ok, "④ POST gate 过关 → 200");
    ok(
      gateBody.reconcile?.trigger === "gate" && (gateBody.reconcile.only_in_code?.length ?? 0) === 5,
      `④ 过关自动跑对账，响应带回结果（trigger=gate，无 design.md → 5 模块全落 only_in_code）`,
    );
    ok(
      fs.existsSync(path.join(projColor, ".工作台", "arch", "reconcile-last.json")),
      "④ Gate 对账结果落盘 reconcile-last.json",
    );
    ok(
      gateBody.reconcile?.note === RECONCILE_SIGNAL_NOTE,
      "④ 对账结果带「信号不是错误」文案（绝不阻断 Gate）",
    );

    // ③ HTTP 对账两向 + ④ B3 钩子消费
    const rec1 = await fetch(`${BASE}/api/projects/p-a5-recon/arch/reconcile`, { method: "POST" });
    const rec1Body = (await rec1.json()) as {
      ok: boolean;
      result: { only_in_design: { name: string }[]; only_in_code: { id: string }[] };
    };
    ok(
      rec1.status === 200 &&
        rec1Body.result.only_in_design[0]?.name === "A" &&
        rec1Body.result.only_in_code[0]?.id === "d",
      "③ HTTP POST arch/reconcile → 两向差异（only_in_design=[A] / only_in_code=[d]）",
    );
    const reqFile = path.join(projRecon, ".工作台", "arch", "reconcile-request.json");
    fs.writeFileSync(
      reqFile,
      JSON.stringify({ ts: nowIso(), trigger: "reverse-draft-finalize", gate_step: "develop" }) + "\n",
      "utf8",
    );
    const rec2 = await fetch(`${BASE}/api/projects/p-a5-recon/arch/reconcile`, { method: "POST" });
    const rec2Body = (await rec2.json()) as {
      ok: boolean;
      result: { consumed_request: { trigger?: string } | null };
    };
    ok(
      rec2Body.result.consumed_request?.trigger === "reverse-draft-finalize" && !fs.existsSync(reqFile),
      "④ B3 对账钩子：reconcile-request.json 存在即跑一次后清除标记（文件已消失）",
    );
    const recGet = await fetch(`${BASE}/api/projects/p-a5-recon/arch/reconcile`);
    const recGetBody = (await recGet.json()) as { ok: boolean; reconcile: { exists: boolean } };
    ok(recGetBody.reconcile.exists === true, "GET arch/reconcile → 最近一次结果 exists:true");
    const rec404 = await fetch(`${BASE}/api/projects/no-such/arch/reconcile`, { method: "POST" });
    ok(rec404.status === 404, "伪造项目 id POST arch/reconcile → 404");

    // ── ③ 塔台自身真跑（DESIGN.md §11.1 十项 vs A1 静态解析实况）────
    console.log("\n[verify] ── ③ 塔台自身真跑对账（真实数据，贴真实差异）");
    const tatai = getProject("tatai", REAL_DATA_DIR);
    ok(tatai !== null, "③ 真实注册表里有塔台自身（self_managed）");
    if (tatai) {
      const real = reconcileProject("tatai", { trigger: "verify-a5-real", dataDir: REAL_DATA_DIR });
      console.log(
        `[verify]   设计书侧 ${real.design_modules.length} 项：${real.design_modules.map((d) => d.name).join("、")}`,
      );
      console.log(
        `[verify]   代码侧 ${real.code_modules.length} 项：${real.code_modules.map((c) => `${c.id}=${c.name}`).join("、")}`,
      );
      console.log(
        `[verify]   only_in_design=${real.only_in_design.length} only_in_code=${real.only_in_code.length} matched=${real.matched.length}`,
      );
      // 骨架无关（2026-09-18）：代码侧模块数从 A1 落盘实况取，不锚死旧骨架形态（骨架随顶层目录数翻新）
      const a1Count = readModules("tatai", REAL_DATA_DIR).arch?.modules.length ?? -1;
      ok(
        real.design_modules.length === 10 && real.code_modules.length === a1Count && a1Count > 0,
        `③ 塔台真实对账：§11.1 十项 vs 静态解析 ${a1Count} 模块（= A1 modules.json 实况；差异本身是设计预期的信号展示）`,
      );
      // 期望定向更新（V08-04，2026-09-23；判据未放宽——"两个方向都要如实给出、不许空集冒充全部对上"未变）：
      //   旧期望＝塔台自身**两向都非空**（当时 §11.1 的 6 项没有点名实现落点 ⇒ only_in_design=6）；
      //   依据＝V08-04 按 §4.5 把声明链补齐（一期 3/4/5/6/9/10 章节点名实测落点）⇒ 声明侧缺口归零是**事实变化**；
      //   新期望＝两个方向都**如实分类并带可核对出处**（代码侧待归属仍非空、声明侧配对数=声明模块数），
      //   机制层面"两向都要显示差异"仍由本脚本 ③ 的夹具（projA/projD 两向都非空）与本条的分类断言共同守着。
      ok(
        new Set(real.matched.map((m) => m.stable_id)).size + real.only_in_design.length ===
          real.design_modules.length &&
          real.only_in_code.length > 0 &&
          real.only_in_code.every((c) => typeof c.path === "string" && c.path !== ""),
        `③ 塔台自身差异如实分类（声明侧：对上 ${real.matched.length}＋待建 ${real.only_in_design.length} = ${real.design_modules.length}；代码侧待归属 ${real.only_in_code.length} 条各带路径）——V08-04 补全声明链后声明侧缺口归零，差异机制仍由夹具守着`,
      );
      // ── V08-01：对账走"稳定 ID + 审定材料索引"的**显式引用**，不再是名字对不上就算差异 ──
      const byRef = real.matched.filter((m) => m.via === "plan_section_ref");
      ok(
        byRef.length > 0,
        `③-3 §11.1 声明模块与代码模块按**材料写明的交叉引用**对上 ${byRef.length} 条（修前 matched=0＝功能名天然对不上目录）`,
      );
      ok(
        byRef.every((m) => typeof m.stable_id === "string" && m.stable_id.startsWith("11.1-") &&
          typeof m.plan_section === "string" && m.plan_section.includes("一期") &&
          typeof m.ref_text === "string" && m.ref_text.includes("§11.1 第")),
        `③-3 每条显式配对都带可核对出处（稳定 ID + 施工图章节 + 引用原文；例：${byRef[0]?.stable_id} → ${byRef[0]?.module_id} @${String(byRef[0]?.plan_section).slice(0, 18)}…）`,
      );
      ok(
        real.matched.filter((m) => m.via === "name_signal").length === 0 && real.design_modules.length === 10,
        "③-3 塔台自身**不再靠名字信号**配对（0 条 name_signal）——§11.1 是功能名、代码侧是目录名，本就对不上",
      );
      ok(
        real.only_in_design.every((d) => d.stable_id.startsWith("11.1-")) &&
          real.only_in_code.every((c) => typeof c.path === "string" && c.path !== ""),
        `③-3 剩余差异如实分类（待归属 ${real.only_in_code.length} 个代码模块带路径；待建/待归属 ${real.only_in_design.length} 条声明带稳定 ID）`,
      );
    }

    await uiPlaywright();
  } finally {
    child.kill();
    fs.rmSync(tmpBase, { recursive: true, force: true });
    finish();
    // Windows 上 pnpm/cmd 壳的 vite 子进程会挂住事件循环，强制收尾（遗留 vite 由端口复查兜底）
    setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
  }
}

/** ①②③ UI 段：后端 8787 + vite（5173），python playwright 四色/变动点/对账标黄截图。
 *  8787 若已有服务在跑（用户自己的 dev server），先探它是否带 A5 新路由：带则复用（绝不杀），不带则跳过。 */
async function uiPlaywright(): Promise<void> {
  console.log("\n[verify] ── ①②③ UI 段（python playwright，8787 + 5173）");
  let backend: ChildProcess | null = null;
  if (await portBusy("http://localhost:8787/health")) {
    // 已占用：探测是否是带 A5 路由的塔台后端（tsx watch 热加载场景）
    let reusable = false;
    try {
      const probe = await fetch("http://localhost:8787/api/projects/tatai/arch/reconcile", {
        signal: AbortSignal.timeout(5000),
      });
      const pb = (await probe.json()) as { ok?: boolean; reconcile?: { exists?: boolean } };
      reusable = probe.status === 200 && pb.ok === true && typeof pb.reconcile?.exists === "boolean";
    } catch {
      reusable = false;
    }
    if (!reusable) {
      console.log("[verify] FAIL UI 段：8787 被占用且不带 A5 路由（不是可复用的塔台后端，不碰）");
      process.exitCode = 1;
      return;
    }
    console.log("[verify] 8787 已有带 A5 路由的塔台后端在跑（用户 dev server，复用不杀）");
  }
  if (await portBusy("http://localhost:5173/")) {
    console.log("[verify] SKIP UI 段：5173 已被占用（不碰）");
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  // ── 骨架无关取形（2026-09-18）：UI 断言用的模块 id / 文件路径 / 状态期望全部动态取，不锚死旧骨架 ──
  //   变动点枝 = 第一个有直属文件子级的顶层模块（A4 真跑 expandDirectory 定夺），首个文件子级挂琥珀点；
  //   状态期望 = 界面上屏的 **v2 派生状态**（V08-06 收尾定向更新：早先按 progress.json 自报四色算，
  //   而技术详情画布已改成按 `taskDerivedModuleStatus` 派生上色 —— 期望值随口径改，判据不放宽：
  //   仍是"每个模块节点恰一个状态属性 + 状态词随色同显"，只是从四色换成六态键/无状态记录）。
  const tataiRoot = getProject("tatai", REAL_DATA_DIR)?.path;
  const a1 = readModules("tatai", REAL_DATA_DIR);
  const expandPick =
    tataiRoot && a1.arch
      ? a1.arch.modules.find((m) => expandDirectory(tataiRoot, m.path).children.some((c) => c.kind === "file"))
      : undefined;
  const dotFile =
    expandPick && tataiRoot
      ? expandDirectory(tataiRoot, expandPick.path).children.find((c) => c.kind === "file")?.path
      : undefined;
  if (!tataiRoot || !a1.arch || !expandPick || !dotFile) {
    ok(false, "①②③ UI 段前置：A1 modules.json / 可展开模块缺失（先跑 arch/parse）");
    return;
  }
  const pyPath = path.join(VERIFY_DIR, "a5-shot.py");
  const moduleIds = a1.arch.modules.map((m) => m.id);

  if (!backend && !(await portBusy("http://localhost:8787/health"))) {
    backend = await spawnServer(8787, REAL_DATA_DIR);
  }
  const viteBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const vite = spawn(viteBin, ["dev", "--", "--port", "5173", "--strictPort"], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO_ROOT,
    shell: process.platform === "win32",
  });
  vite.stderr?.on("data", (d: Buffer) => process.stderr.write(`[vite] ${d}`));
  // --strictPort 下 5173 被占会立刻退出，别拿错服务截图
  watchChild(vite, 5173, () => upPorts.has(5173), "vite 服务");
  try {
    await waitUp("http://localhost:8787/health", "后端 8787");
    await waitUp("http://localhost:5173/", "vite 5173");
    // V08-06 收尾：期望值改从**后端**取（与界面同一份读口 + 同一份派生函数），所以要在后端就绪之后
    // 才算、再写 python 脚本。算不出来（接口失败）就如实红——不许"算不出就跳过断言"。
    const displayExpect = await fetchTechDisplayExpectations({
      baseUrl: "http://localhost:8787",
      projectId: "tatai",
      techIds: moduleIds,
    });
    console.log(
      `[verify]   UI 段期望（v2 派生实况）：${moduleIds.map((id) => `${id}=${displayExpect[id].key}`).join(" · ")}`,
    );
    fs.writeFileSync(
      pyPath,
      PY_SHOT
        .replaceAll("__DISPLAY_JSON__", JSON.stringify(displayExpect))
        .replaceAll("__DOT_MOD__", expandPick.id)
        .replaceAll("__DOT_FILE__", dotFile),
      "utf8",
    );
    console.log("[verify] 8787 + 5173 就绪，跑 playwright …");
    try {
      const out = execSync(`python "${pyPath}"`, { cwd: VERIFY_DIR, stdio: "pipe" }).toString();
      process.stdout.write(out);
      ok(out.includes("UI_ASSERT_ALL_PASS"), "①②③④ playwright UI 断言全过（v2 模块状态/变动点/对账标黄，两个视图都成立）");
    } catch (e) {
      process.stdout.write((e as { stdout?: Buffer }).stdout?.toString() ?? "");
      process.stderr.write((e as { stderr?: Buffer }).stderr?.toString() ?? "");
      ok(false, "①②③④ playwright UI 段执行失败（见上方输出）");
    }
    for (const shot of [
      "a5-01-four-colors.png",
      "a5-02-changed-dot.png",
      "a5-03-reconcile.png",
      "a5-04-data-flow-four-colors.png",
    ]) {
      ok(fs.existsSync(path.join(VERIFY_DIR, shot)), `UI 截图落盘 .工作台/verify/${shot}`);
    }
  } finally {
    // Windows 上 pnpm/cmd 壳杀不干净进程树，用 taskkill /T 连根拔（只杀自己起的 vite）
    if (process.platform === "win32" && vite.pid) {
      try {
        execSync(`taskkill /PID ${vite.pid} /T /F`, { stdio: "ignore" });
      } catch {
        // 已退出则忽略
      }
    } else {
      vite.kill();
    }
    backend?.kill(); // 只杀自己起的；复用的用户 dev server 不碰
    await sleep(500);
  }
}

const PY_SHOT = String.raw`# A5 UI 验证截图：塔台架构图 模块状态（v2 派生）+ 文件级变动点 + 对账标黄（§4.2/§4.5）
# 真实数据（TATAI_HOME 真实注册表）：开跑前由 verify-a5.ts 保证真实塔台进度/对账现场可用。
#   骨架无关（2026-09-18）：模块 id / 变动点枝 / 状态期望全部动态注入
#   （__DISPLAY_JSON__ / __DOT_MOD__ / __DOT_FILE__），对账差异期望数从对账接口响应实况取。
#
# V08-06 收尾（2026-09-24）状态期望定向更新（判据未放宽）：
#   旧期望 = v1 四色：「[data-arch-status]」计数按 progress.json modules[] 实况（todo/doing/done/issue），
#            状态词取「未开始/进行中/已完成/有问题」。
#   依据   = 技术详情画布已按 V08-06 ② 换成 v2 派生状态上色（ArchCanvas 的 statusOverride 分支）：
#            给派生表时**不再写** data-arch-status（旧属性在 v2 口径下不出现），改写
#            data-display-status（六态键 / no_status_record）＋徽标 data-status-label。
#   新期望 = 每个顶层模块节点的 data-display-status == ts 侧按**同一份派生**算出的键
#            （arch/blueprint + status-projection + arch/reconcile → taskDerivedModuleStatus
#            → moduleStatusKeysOf，见 scripts/lib/displayStatus.ts），data-status-label ==
#            该键的徽标文字；整页「[data-arch-status]」计数必须为 0。
#   保留意图 = ①"状态上屏与实况一致"、②"每个节点恰一个状态属性（不冒充、不落空）"、
#            ③"颜色之外还有文字通道（色盲可辨）"、④"两个视图读数逐项相同" —— 四条原样保留。
#   判据未放宽 = 逐模块逐项相等（不是"至少有颜色"）；并新增"v2 口径下不出现 v1 四色属性"这条硬断言：
#            两套状态口径混在一个属性上就要红。回归结果见本脚本 ts 侧收尾打印与 PROGRESS 流水。
import datetime
import json
import os
import urllib.request

from playwright.sync_api import sync_playwright

OUT = "."
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHANGES = os.path.join(REPO, ".工作台", "changes.jsonl")
fails = []

def ok(cond, label):
    print(("[UI PASS] " if cond else "[UI FAIL] ") + label)
    if not cond:
        fails.append(label)

# ① 开跑前先真跑一次对账（8787 真实数据），供面板与黄色标记消费
req = urllib.request.Request(
    "http://localhost:8787/api/projects/tatai/arch/reconcile",
    method="POST", data=b"{}", headers={"content-type": "application/json"},
)
resp = json.load(urllib.request.urlopen(req, timeout=60))
# V08-04 期望定向更新（判据未放宽）：真对账的两个方向**如实分类**——声明侧配对数（去重稳定 ID）＋待建数
# = 声明模块总数；代码侧待归属仍非空。声明侧缺口归零是"声明链补全后的事实变化"，机制（两向都要显示差异、
# 差异是信号）仍由本脚本 ③ 的夹具断言守着。
__matched_ids = {m["stable_id"] for m in resp["result"]["matched"]}
ok(resp.get("ok")
   and len(__matched_ids) + len(resp["result"]["only_in_design"]) == len(resp["result"]["design_modules"])
   and len(resp["result"]["only_in_code"]) > 0,
   "POST 真对账两向如实分类（声明侧对上 %d＋待建 %d = %d；代码侧待归属 %d）"
   % (len(__matched_ids), len(resp["result"]["only_in_design"]),
      len(resp["result"]["design_modules"]), len(resp["result"]["only_in_code"])))
# v2 派生期望：{模块 id: {"key": 上屏键, "label": 徽标文字, "hex": 状态色}}（ts 侧注入，来源见文件头）
EXPECT_DISPLAY = json.loads('__DISPLAY_JSON__')
MODULE_IDS = list(EXPECT_DISPLAY.keys())
MODULE_COUNT = len(MODULE_IDS)
PRESENT_LABELS = sorted({e["label"] for e in EXPECT_DISPLAY.values()})
EXPECT_DIFF = len(resp["result"]["only_in_code"])

# ② changes.jsonl 备份 + 追加一条近时记录（跑完逐字节还原，gitignore 运行时数据）
backup = None
if os.path.exists(CHANGES):
    with open(CHANGES, "rb") as f:
        backup = f.read()
now = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
line = json.dumps({"ts": now, "path": "__DOT_FILE__", "action": "modify", "size_delta": 1}, ensure_ascii=False)
with open(CHANGES, "ab") as f:
    f.write(line.encode("utf-8") + b"\n")

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
        page.goto("http://localhost:5173/#p/tatai", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        page.locator('button[data-view="arch"]').click()
        # V06-08：§3.1 把「项目图」默认落点切到「功能全景」；A5 守的是技术详情那一层的四色/变动点/对账，
        # 所以显式进入「技术详情」——下面的断言、判据与阈值一个字都不动。
        page.locator('[data-project-view-tab="tech"]').click()
        page.wait_for_selector(".react-flow__node", timeout=20000)
        page.wait_for_timeout(1500)

        # ① 模块状态（v2 派生口径）：逐模块比对"上屏键 + 徽标文字"，并守住"两套口径不混用一个属性"
        #    （期望值来源与定向更新依据见文件头；拿不到派生表就红，不静默降级成老口径）
        page.wait_for_selector("[data-display-status]", timeout=20000)
        texts = " ".join(page.locator(".react-flow__node").all_inner_texts())
        box_display = {}
        for mid in MODULE_IDS:
            el = page.locator(f'[data-arch-node="{mid}"]').first
            exp = EXPECT_DISPLAY[mid]
            key = el.get_attribute("data-display-status")
            label = el.locator("[data-status-label]").first.get_attribute("data-status-label")
            box_display[mid] = key
            ok(key == exp["key"], f"模块 {mid} 上屏状态 = {key}（期望 {exp['key']}，v2 派生实况）")
            ok(label == exp["label"],
               f"模块 {mid} 状态词「{label}」随色同显（期望「{exp['label']}」——颜色之外的第二通道）")
        ok(page.locator("[data-arch-status]").count() == 0,
           "v2 口径下不出现 v1 四色属性 [data-arch-status]（两套状态口径不混在同一个属性上）")
        ok(page.locator(".react-flow__node [data-display-status]").count() == MODULE_COUNT,
           f"每个顶层模块节点恰一个状态属性（{MODULE_COUNT} 个模块节点、未展开时无文件节点）")
        for w in PRESENT_LABELS:
            ok(w in texts, f"状态词「{w}」在画布节点文字里可见（色盲可辨双通道）")
        ok(len(PRESENT_LABELS) > 0, "状态期望至少覆盖一种状态（不是空检查）")
        page.screenshot(path=f"{OUT}/a5-01-four-colors.png")

        # ② 文件级变动点：展开变动点枝（动态取）→ 首个文件子级挂琥珀小点
        page.locator('[data-expand-toggle="__DOT_MOD__"]').click()
        page.wait_for_selector('[data-file-node="__DOT_FILE__"]', timeout=15000)
        page.wait_for_timeout(1200)
        ok(page.locator('[data-changed-dot="__DOT_FILE__"]').count() == 1,
           "变动点：近 24h 有记录的文件节点带 [data-changed-dot] 琥珀点")
        page.screenshot(path=f"{OUT}/a5-02-changed-dot.png")
        page.locator('[data-expand-toggle="__DOT_MOD__"]').click()
        page.wait_for_timeout(800)

        # ③ 对账标黄：差异节点黄色标记 + 对账面板两组清单 + 「信号不是错误」文案
        panel = page.locator("[data-reconcile-panel]")
        # V09-20 定向更新（2026-09-26 用户指令，五要素留档）：
        #   旧期望＝对账面板的**长解释与两个逐条名单默认平铺可见**｜
        #   依据＝DESIGN §3.11（人用图面口径，2026-09-26 用户澄清）：技术详情的长对账说明改为
        #         「简短摘要＋按需查看」——汇总两行常显，长解释与逐条名单进「对账明细」按需展开｜
        #   新期望＝默认可见的汇总两行仍带「差异是信号，不是错误」口径句与分类分计；**点开**对账明细后
        #         逐条名单（含接口实况第 1 条）完整可读｜
        #   保留意图＝原始事实（逐条名单）一条不少、data-diff-list="only_in_code" 仍在场｜
        #   判据不放宽：名单条数与内容仍逐条比对，只是多一步「点开」。
        page.locator("[data-reconcile-panel] details[data-reconcile-detail] > summary").click()
        page.wait_for_timeout(300)
        ptext = panel.inner_text()
        ok("信号" in ptext and "不是错误" in ptext, "对账面板明示「差异是信号，不是错误」（§4.5）")
        # V08-01：清单条目改**从对账接口实况取**（不再钉死某条旧功能名——那些已按材料写明的交叉引用配上了）
        # V08-04：声明侧缺口已归零 ⇒ 面板该显示"待归属"那一侧；待建非空时仍按接口实况点名第一条
        pending = resp["result"]["only_in_design"]
        unmatched_code = resp["result"]["only_in_code"]
        if pending:
            ok(pending[0]["name"] in ptext,
               f"面板列出设计书有代码没有清单（接口实况第 1 条：{pending[0]['name']}）")
        else:
            first = unmatched_code[0] if unmatched_code else None
            shown = first is not None and (first["id"] in ptext or first.get("name", "") in ptext or first.get("path", "") in ptext)
            ok(shown and bool(unmatched_code),
               f"声明侧无待建 ⇒ 面板如实列出「代码有、设计没有」一侧（第 1 条：{first['name'] if first else '（空）'}）")
        ok(panel.locator('[data-diff-list="only_in_code"]').count() == 1, "面板列出代码有设计书没有清单")
        n_diff = page.locator("[data-arch-diff]").count()
        ok(n_diff == EXPECT_DIFF, f"对账差异节点黄色标记：{n_diff} 个 only_in_code 模块节点标黄（期望 {EXPECT_DIFF}，来自对账接口实况）")
        page.screenshot(path=f"{OUT}/a5-03-reconcile.png")

        # ④ F4：同一份口径在**两个视图**上都成立——切到数据流向图，逐模块状态/状态词/标黄读数与方框图逐项相同
        box_words = {w: (w in texts) for w in PRESENT_LABELS}
        page.locator('[data-graph-mode="DATA_FLOW"]').click()
        page.wait_for_selector("[data-flow-legend]", timeout=20000)
        page.wait_for_timeout(1500)
        ok(page.locator('[data-arch-mode="DATA_FLOW"]').count() == 1, "④ 切到数据流向图（F4 起两个视图共用一个画布实例）")
        flow_display = {mid: page.locator(f'[data-arch-node="{mid}"]').first.get_attribute("data-display-status")
                        for mid in MODULE_IDS}
        flow_diff = page.locator("[data-arch-diff]").count()
        flow_texts = " ".join(page.locator(".react-flow__node").all_inner_texts())
        flow_words = {w: (w in flow_texts) for w in PRESENT_LABELS}
        ok(flow_display == box_display,
           f"④ 模块状态在数据流向图里逐项相同：{flow_display} == 方框图 {box_display}（状态不因视图改，NODE_COLOR_RULE）")
        ok(all(flow_words.values()) and flow_words == box_words,
           f"④ 数据流向图里状态词与方框图逐项相同（色盲可辨双通道，按实况出现的 {len(PRESENT_LABELS)} 种）：{flow_words}")
        ok(flow_diff == n_diff and flow_diff == EXPECT_DIFF,
           f"④ 对账标黄在数据流向图里同样正确：{flow_diff} 个 == 方框图 {n_diff} 个（同一份 reconcile-last.json）")
        ok("信号" in panel.inner_text(), "④ 数据流向图里对账面板照旧在位（两视图共用同一份面板）")
        page.screenshot(path=f"{OUT}/a5-04-data-flow-four-colors.png")
        browser.close()
finally:
    # 逐字节还原 changes.jsonl（原本不存在则删掉本次新建）
    if backup is None:
        if os.path.exists(CHANGES):
            os.remove(CHANGES)
    else:
        with open(CHANGES, "wb") as f:
            f.write(backup)

print("UI_ASSERT_ALL_PASS" if not fails else f"UI_ASSERT_FAILS:{len(fails)}")
`;

/** 真实塔台 progress.json 的模块状态口径（2026-09-18 骨架翻新后重映射，逐条锚 PLAN.md 实况，不编造）：
 *  一期/二期/三期各组卡全 done → src（arch/server/ui/mcp 全部应用源码）/ scripts（各卡的 verify-*.ts）/
 *  src-tauri（三期 U 组）= done；发布组 L1/L2/L3 done → templates（L3 空模板）/ docs（L1 审计+发布说明）
 *  = done；发布组 L4 blocked（本地部分全绿，远端四步等主人授权）→ root（仓库打磨/tag 的落点在仓库根）
 *  = issue。模块 id/中文名与 A1 新骨架（modules.json）+ A2 起名缓存（names.json）同口径。
 *  已存在则刷新状态（幂等）；UI 段四色计数按这份真值动态算，不硬编码数字。
 *
 *  2026-09-22（批外缺陷修复，随 V07-03 迁移后的现场变化）：真实塔台已是 **v2 项目**，
 *  `addModule` / `setModuleStatus` 两个 v1 写口按 §2.6 一律拒写（`WRITE_UPGRADE_REQUIRED`）——
 *  实测本函数原来会在这里抛异常把整条 `verify:a5` 拦腰截断（既有的红，不是本批引入）。
 *  现在**不代写真实项目**：写口被拒就如实打印，界面期望本来就取 `progress.json` 实况，
 *  四色覆盖降为实况里出现的那几种（覆盖数由断言自行打印，不做假绿）。 */
function ensureRealModules(): void {
  const want: [string, string, ModuleStatus][] = [
    ["src", "前端界面", "done"],
    ["scripts", "构建脚本集", "done"],
    ["src-tauri", "桌面端外壳", "done"],
    ["templates", "模板样例库", "done"],
    ["docs", "项目文档", "done"],
    ["root", "项目根目录", "issue"],
  ];
  const refused: string[] = [];
  const codeOf = (e: unknown): string =>
    typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
  for (const [id, name, status] of want) {
    try {
      addModule("tatai", { id, name, status }, REAL_DATA_DIR);
      continue; // 未迁移项目：建了就是建了（含期望状态）
    } catch (e) {
      if (codeOf(e) !== "MODULE_EXISTS") {
        refused.push(`${id}（新增被拒：${codeOf(e)}）`);
        continue;
      }
    }
    try {
      setModuleStatus("tatai", id, status, REAL_DATA_DIR);
    } catch (e) {
      if (codeOf(e) === "WRITE_UPGRADE_REQUIRED") refused.push(`${id}（${status}）`);
      else throw e;
    }
  }
  if (refused.length > 0) {
    console.log(
      `[verify] 注：真实塔台是 v2 项目，v1 写口按 §2.6 拒绝改模块四色（${refused.join("、")}）；` +
        "本段期望值改按 .工作台/progress.json **实况**算（不代写真实项目、不假绿）",
    );
  }
}

try {
  ensureRealModules();
  await main();
} catch (err) {
  console.error("[verify] 异常:", err);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 300).unref();
}
