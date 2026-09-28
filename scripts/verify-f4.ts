// F4 验证脚本（用 tsx 跑）：两视图切换与一致性（PLAN F4 卡 DoD②③④ + 顺手收掉的 fitView 竞态）。
// 用法：pnpm verify:f4
//
// 覆盖点：
//   ② 布局记忆按视图分键（**真 UI 拖动**）：方框图拖 A → 切数据流向图（A 落在自己那份坐标上）→ 拖 B
//      → 切回方框图：A 坐标逐字节仍是拖动后的值；脚本侧贴 layout.json 前后 diff（含 v1 → v2 升级）。
//   ③ 切换不触发全量重解析：画布上的解析入口计数（`data-arch-parse-calls` / `data-arch-data-loads`）
//      切换前后不变 + 浏览器网络日志在整个切换过程里零 `arch/parse`、`arch/expand`、`arch/render` 请求；
//      展开态的子树跨视图保持（切回来还在，无需重新展开）。
//   ④ fitView / 无空白：每次切换后所有节点都被 fit 进视口（节点中心落在画布框内）、画布非空白。
//   ⑤ 回归（DoD④）：模块状态（v2 派生口径）+ 对账标黄在**两个视图**上都成立（DOM 读数两视图逐项对照 + 截图）。
//
// 端口策略（外部审计点名过"固定端口易受残留进程干扰"）：**不碰任何既有监听**——后端起前先探空闲端口
// （bind 0 让系统分配），vite 同样动态选端口并把它看到的后端端口经 TATAI_DEV_API_PORT 传进代理；
// 起后盯子进程早退（端口被抢即换端口重试）。全程不用 8787 / 5173，也不复用、不杀别人的服务。
//
// 隐私（AGENTS.md §5/§6）：只跑本机真实注册表数据；本脚本唯一的写操作是界面上拖出来的坐标，跑完把
// 本项目 `.工作台/arch/layout.json` 逐字节还原（gitignore 运行时数据）。截图落 `.工作台/verify/f4-*.png`。
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandDirectory } from "../src/arch/expand";
import { readModules } from "../src/arch/parse";
import { LAYOUT_MIGRATION_MODE, readLayoutByRoot } from "../src/arch/layoutStore";
import { getProject } from "../src/server/registry";
import { ensureSelfRegistered, finish, realHome } from "./lib/fixtures";
import { fetchTechDisplayExpectations } from "./lib/displayStatus";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_DATA_DIR = realHome(); // TATAI_HOME > 缺省 ~/.tatai（脚本不写死作者本机路径）
ensureSelfRegistered(REAL_DATA_DIR); // 塔台自身＝本仓库：幂等登记，脚本换台机器也能跑
const VERIFY_DIR = path.join(REPO_ROOT, ".工作台", "verify");
const LAYOUT_FILE = path.join(REPO_ROOT, ".工作台", "arch", "layout.json");
const UI_PROJECT = "tatai";

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 端口：探活 + 动态分配 ─────────────────────────

/** 该端口当前是否有人监听（哪怕占用者不应答也算被占） */
function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(800, () => done(false));
  });
}

/** 让系统分配一个空闲端口（bind 0 → 读回端口 → 放掉）；起服务前再探一次，避免别人刚抢走 */
async function pickFreePort(): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, () => {
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });
    if (port > 0 && !(await portListening(port))) return port;
  }
  throw new Error("分配不到空闲端口（连续 5 次都被抢）");
}

const VITE_BASE = (port: number) => `http://localhost:${port}/`;

/** 等 HTTP 就绪。两种回环写法都试：vite 只监听 IPv6 回环（[::1]）时写死 127.0.0.1 会探空，
 *  反之亦然——探活不能只认一种地址族（F4：端口探活要真探到自己的服务）。 */
async function waitUpAny(
  urls: string[],
  label: string,
  opts: { timeoutMs?: number; isAlive?: () => boolean } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (opts.isAlive && !opts.isAlive()) throw new Error(`${label} 进程已退出（端口可能被抢）`);
    for (const url of urls) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
        if (r.status < 500) return;
      } catch {
        // 还没起来
      }
    }
    await sleep(250);
  }
  throw new Error(`${label} 未就绪（${timeoutMs / 1000}s 超时）：${urls.join(" / ")}`);
}

/** 把子进程的输出接到控制台（诊断用；vite 的 ready 行在 stdout） */
function pipeOutput(child: ChildProcess, label: string): void {
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[${label}] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${label}] ${d}`));
}

/** 起服务并盯早退：起前探端口空闲（已被占直接报错，不去沾别人的服务） */
async function startService(
  label: string,
  port: number,
  spawnFn: (port: number) => ChildProcess,
  readyUrls: string[],
): Promise<ChildProcess> {
  if (await portListening(port)) throw new Error(`${label} 端口 ${port} 已被占用（本脚本不碰既有监听，请重跑）`);
  const child = spawnFn(port);
  pipeOutput(child, `${label}:${port}`);
  child.once("exit", (code) => {
    if (!intentionalStop.has(port) && code !== 0) {
      console.error(`[verify] ${label}（端口 ${port}）意外退出：code=${code}（端口被抢？）`);
    }
  });
  await waitUpAny(readyUrls, `${label} ${port}`, { isAlive: () => child.exitCode === null });
  if (child.exitCode !== null) throw new Error(`${label} 起不来（exitCode=${child.exitCode}，端口 ${port} 可能被抢）`);
  return child;
}

// ───────────────────────── UI 段：playwright ─────────────────────────

async function uiPlaywright(backendPort: number): Promise<void> {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  // ── 骨架无关取形（2026-09-18）：UI 断言用的模块 id / 文件 / 状态期望按 A1+A4 实况动态取 ──
  //   expandMod = 第一个有直属文件子级的顶层模块（展开后制造"跨视图要保持"的子树）；expandFile 其首个文件子级；
  //   dragA / dragB = 另外两个顶层模块（两视图各自拖一个，验证分桶互不覆盖）；
  //   状态期望 = 界面上屏的 **v2 派生状态**（V08-06 收尾定向更新：见 PY_SHOT 头部"定向更新"注释）。
  const project = getProject(UI_PROJECT, REAL_DATA_DIR);
  const a1 = readModules(UI_PROJECT, REAL_DATA_DIR);
  const expandPick =
    project && a1.arch
      ? a1.arch.modules.find((m) => expandDirectory(project.path, m.path).children.some((c) => c.kind === "file"))
      : undefined;
  const expandFile =
    expandPick && project
      ? expandDirectory(project.path, expandPick.path).children.find((c) => c.kind === "file")?.path
      : undefined;
  const others = a1.arch?.modules.filter((m) => m.id !== expandPick?.id) ?? [];
  const [dragA, dragB] = [others[0]?.id, others[1]?.id];
  if (!project || !a1.arch || !expandPick || !expandFile || !dragA || !dragB) {
    ok(false, "① UI 段前置：A1 modules.json / 可展开模块缺失（先跑 arch/parse）");
    return;
  }
  // 期望值从**后端**取（与界面同一份读口 + 同一份派生函数），所以要在后端就绪之后才算
  const displayExpect = await fetchTechDisplayExpectations({
    baseUrl: `http://127.0.0.1:${backendPort}`,
    projectId: UI_PROJECT,
    techIds: a1.arch.modules.map((m) => m.id),
  });
  console.log(
    `[verify]   UI 段期望（v2 派生实况）：${Object.entries(displayExpect)
      .map(([id, e]) => `${id}=${e.key}`)
      .join(" · ")}`,
  );
  const pyPath = path.join(VERIFY_DIR, "f4-shot.py");
  fs.writeFileSync(
    pyPath,
    PY_SHOT.replaceAll("__EXPAND_MOD__", expandPick.id)
      .replaceAll("__EXPAND_FILE__", expandFile)
      .replaceAll("__DRAG_A__", dragA)
      .replaceAll("__DRAG_B__", dragB)
      .replaceAll("__DISPLAY_JSON__", JSON.stringify(displayExpect)),
    "utf8",
  );
  // vite 端口动态选：直接调 vite 自己的入口（不经 pnpm 壳——pnpm 会把 `--` 原样转给 vite，
  // vite 遇到 `--` 就停止解析选项，`--port` 被当成位置参数丢掉：F3/A4/A5 的 `pnpm dev -- --port 5173`
  // 一直跑在 vite 默认端口上，只是因为默认值恰好也是 5173 才没暴露）。`--strictPort` 保证被抢即失败。
  const viteEntry = path.join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");
  let vitePort = 0;
  let vite: ChildProcess | null = null;
  for (let attempt = 1; attempt <= 3 && !vite; attempt++) {
    vitePort = await pickFreePort();
    const child = spawn(process.execPath, [viteEntry, "dev", "--port", String(vitePort), "--strictPort"], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
      env: { ...process.env, TATAI_DEV_API_PORT: String(backendPort) },
    });
    pipeOutput(child, `vite:${vitePort}`);
    try {
      // 冷启动要跑依赖预打包，给足时间；进程早退（端口被抢 / 配置错）立刻换端口
      await waitUpAny([VITE_BASE(vitePort), `http://127.0.0.1:${vitePort}/`, `http://[::1]:${vitePort}/`], `vite ${vitePort}`, {
        timeoutMs: 90_000,
        isAlive: () => child.exitCode === null,
      });
      vite = child;
      console.log(`[verify]   vite ${vitePort} 已就绪（第 ${attempt} 次尝试）`);
    } catch (e) {
      console.log(`[verify]   vite 端口 ${vitePort} 起不来（第 ${attempt} 次）：${(e as Error).message}`);
      killTree(child, vitePort);
    }
  }
  if (!vite) {
    ok(false, "① UI 段：vite 起不来（连续 3 个动态端口都失败）");
    return;
  }
  console.log(`[verify]   UI 段服务就绪：后端 ${backendPort}（动态端口）+ vite ${vitePort}（动态端口）`);
  try {
    const out = execSync(`python "${pyPath}" ${vitePort} ${backendPort} ${UI_PROJECT}`, {
      cwd: VERIFY_DIR,
      stdio: "pipe",
      timeout: 300_000,
    }).toString();
    process.stdout.write(out);
    ok(out.includes("UI_ASSERT_ALL_PASS"), "②③④⑤ playwright UI 断言全过（切换/位置不丢/不重解析/无空白/两视图状态与标黄）");
  } catch (e) {
    process.stdout.write((e as { stdout?: Buffer }).stdout?.toString() ?? "");
    process.stderr.write((e as { stderr?: Buffer }).stderr?.toString() ?? "");
    ok(false, "UI 段执行失败（见上方输出）");
  } finally {
    killTree(vite, vitePort);
    await sleep(500);
  }
  for (const shot of [
    "f4-01-module-box-dragged.png",
    "f4-02-data-flow-dragged.png",
    "f4-03-module-box-switched-back.png",
    "f4-04-switch-no-blank.png",
    "f4-05-data-flow-four-colors.png",
    "f4-06-module-box-four-colors.png",
  ]) {
    ok(fs.existsSync(path.join(VERIFY_DIR, shot)), `⑤ UI 截图落盘 .工作台/verify/${shot}`);
  }
}

/** 自己主动收尾杀的端口（退出回调据此区分"意外早退"与"正常收尾"） */
const intentionalStop = new Set<number>();

/** 杀掉自己起的进程树（Windows 上 pnpm/cmd 壳不杀子进程会残留 vite） */
function killTree(child: ChildProcess, port?: number): void {
  if (port) intentionalStop.add(port);
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      // 已退出则忽略
    }
  } else {
    child.kill();
  }
}

// ───────────────────────── 主流程 ─────────────────────────

async function main(): Promise<void> {
  const project = getProject(UI_PROJECT, REAL_DATA_DIR);
  if (!project) {
    ok(false, `真实项目 ${UI_PROJECT} 不在注册表（${REAL_DATA_DIR}）`);
    return;
  }

  // ── ② 脚本侧基线：UI 跑之前的 layout.json（含 v1 → v2 升级的前后对照）──
  console.log("[verify] ── ② 布局记忆按视图分键（UI 真拖动 + layout.json 前后 diff）");
  const layoutBackup = fs.existsSync(LAYOUT_FILE) ? fs.readFileSync(LAYOUT_FILE) : null;
  const beforeRaw = layoutBackup ? layoutBackup.toString("utf8").replace(/\s+/g, " ").trim() : "（缺文件）";
  const beforeVersion = layoutBackup
    ? (JSON.parse(layoutBackup.toString("utf8")) as { version?: number }).version
    : undefined;
  console.log(`[verify]   UI 前 layout.json（version ${String(beforeVersion)}）：${beforeRaw}`);
  ok(
    beforeVersion === 1 || beforeVersion === 2 || beforeVersion === undefined,
    `② layout.json 基线与当前结构口径相符（version=${String(beforeVersion)}：v1 旧结构 / v2 按视图分键 / 缺文件空态）`,
  );

  // ── 布局基线归零（2026-09-18，对齐 verify-a4 的欠债修法；verify-n3 的 snapshotAndReset 同款）──
  // 真实 layout.json 里可能躺着历轮屏幕像素拖动攒下的欠债坐标（实测 templates (2091.35, 2701.13)）：
  // fitView 被它压到 minZoom → 节点屏幕尺寸 < 60×30 → drag() 的固定偏移起手点落在节点外，拖的是
  // 画布不是节点，PUT 从不触发（本次复跑实测：全程零 /arch/layout PUT、DATA_FLOW 桶恒空）。
  // 跑之前归零到已知基线（空 positions = 全走 dagre 兜底，起点确定），跑完按上面的快照逐字节还原。
  fs.mkdirSync(path.dirname(LAYOUT_FILE), { recursive: true });
  fs.writeFileSync(LAYOUT_FILE, `${JSON.stringify({ version: 2, positions: {} }, null, 2)}\n`, "utf8");
  console.log("[verify]   布局基线已归零（positions 空 → 全走 dagre 兜底；真实基线见上一行，跑完逐字节还原）");

  let backend: ChildProcess | null = null;
  let backendPort = 0;
  try {
    backendPort = await pickFreePort();
    backend = await startService(
      "后端",
      backendPort,
      (port) =>
        spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
          cwd: REPO_ROOT,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TATAI_HOME: REAL_DATA_DIR, TATAI_PORT: String(port) },
        }),
      [`http://127.0.0.1:${backendPort}/health`, `http://localhost:${backendPort}/health`],
    );
    await uiPlaywright(backendPort);
  } finally {
    if (backend) {
      intentionalStop.add(backendPort);
      backend.kill();
    }
    await sleep(300);
  }

  // ── ② 脚本侧收尾：UI 跑完的 layout.json（两视图各自的桶）+ 逐字节还原 ──
  const afterRaw = fs.existsSync(LAYOUT_FILE) ? fs.readFileSync(LAYOUT_FILE, "utf8").replace(/\s+/g, " ").trim() : "（缺文件）";
  console.log(`[verify]   UI 后 layout.json：${afterRaw}`);
  if (fs.existsSync(LAYOUT_FILE)) {
    const parsed = readLayoutByRoot(project.path);
    const boxCount = Object.keys(parsed.positions.MODULE_BOX ?? {}).length;
    const flowCount = Object.keys(parsed.positions.DATA_FLOW ?? {}).length;
    console.log(
      `[verify]   读回口径：version=${parsed.version} · positions 键 = ${Object.keys(parsed.positions).join(", ")}` +
        ` · ${LAYOUT_MIGRATION_MODE} 桶 ${boxCount} 个节点坐标 · DATA_FLOW 桶 ${flowCount} 个节点坐标`,
    );
    ok(parsed.version === 2, `② 磁盘结构已升为 v2（position 按视图分键，version=${parsed.version}）`);
    ok(boxCount > 0 && flowCount > 0, `② 两个视图的坐标**各自**落盘（方框图 ${boxCount} 个 / 数据流向图 ${flowCount} 个），互不覆盖`);
  } else {
    ok(false, "② UI 拖动后没有落盘 layout.json（布局记忆没生效）");
  }
  // 还原（本脚本只借界面拖一下，不改用户已摆的布局）
  if (layoutBackup) fs.writeFileSync(LAYOUT_FILE, layoutBackup);
  else if (fs.existsSync(LAYOUT_FILE)) fs.rmSync(LAYOUT_FILE);
  console.log(`[verify]   已把 layout.json 逐字节还原成 UI 前的内容（${layoutBackup ? `${layoutBackup.length} 字节` : "原本不存在 → 删除"}）`);
}

/** UI 段 python（与 A3/A4/A5/F3 同风格；断言失败打印 [UI FAIL] 并以 UI_ASSERT_FAILS 收尾）
 *  骨架无关（2026-09-18）：展开模块/文件、拖动 A/B、状态期望由 ts 侧按实况注入
 *（__EXPAND_MOD__ / __EXPAND_FILE__ / __DRAG_A__ / __DRAG_B__ / __DISPLAY_JSON__）。 */
const PY_SHOT = String.raw`# F4 UI 验证：两视图来回切换（位置不丢 / 不重解析 / 无空白）+ 模块状态与对账标黄两视图都成立
# 用法：python f4-shot.py <vitePort> <backendPort> <projectId>
#
# V08-06 收尾（2026-09-24）状态期望定向更新（判据未放宽）：
#   旧期望 = v1 四色：「[data-arch-status]」计数 + 状态词「未开始/进行中/已完成/有问题」。
#   依据   = 技术详情画布已换成 v2 派生状态上色（ArchCanvas 的 statusOverride 分支）：给了派生表就
#            **不写** data-arch-status，改写 data-display-status（六态键 / no_status_record）
#            ＋徽标 data-status-label（见 scripts/lib/displayStatus.ts 的同源算期望）。
#   新期望 = 每个顶层模块节点的上屏键与徽标文字逐项等于派生实况；「[data-arch-status]」恒为 0。
#   保留意图 = ⑤ 的原意"状态通道（色 + 文字）在两个视图里都成立且逐项一致"原样保留；
#            对账标黄（data-arch-diff）与「差异是信号不是错误」的断言一个字没改。
#   判据未放宽 = 两视图读数逐项相等（不是"都有颜色就算过"），且新增"v1 属性不出现"的硬断言。
import json
import re
import sys
import urllib.request

from playwright.sync_api import sync_playwright

VITE_PORT = sys.argv[1]
BACKEND_PORT = sys.argv[2]
PROJECT = sys.argv[3]
BASE = f"http://localhost:{VITE_PORT}"
OUT = "."
fails = []
# v2 派生期望：{模块 id: {"key": 上屏键, "label": 徽标文字, "hex": 状态色}}（ts 侧注入，来源见文件头）
EXPECT_DISPLAY = json.loads('__DISPLAY_JSON__')
MODULE_IDS = list(EXPECT_DISPLAY.keys())
PRESENT_WORDS = sorted({e["label"] for e in EXPECT_DISPLAY.values()})

def ok(cond, label):
    print(("[UI PASS] " if cond else "[UI FAIL] ") + label)
    if not cond:
        fails.append(label)

def translate_of(style):
    m = re.search(r"translate\((-?[\d.]+)px[, ]+(-?[\d.]+)px\)", style or "")
    return (float(m.group(1)), float(m.group(2))) if m else None

def node_pos(page, node_id):
    return translate_of(page.locator(f'.react-flow__node[data-id="{node_id}"]').first.get_attribute("style"))

def parse_calls(page):
    return int(page.locator("[data-arch-parse-calls]").first.get_attribute("data-arch-parse-calls"))

def data_loads(page):
    return int(page.locator("[data-arch-data-loads]").first.get_attribute("data-arch-data-loads"))

def nodes_all_in_view(page):
    """所有节点都落在画布框内（fitView 生效的硬证据：节点中心在 pane 里）"""
    return page.evaluate("""() => {
        const pane = document.querySelector('.react-flow__pane');
        if (!pane) return {ok: false, total: 0, outside: []};
        const r = pane.getBoundingClientRect();
        const nodes = [...document.querySelectorAll('.react-flow__node')];
        const outside = [];
        for (const n of nodes) {
            const b = n.getBoundingClientRect();
            const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
            if (cx < r.x || cx > r.x + r.width || cy < r.y || cy > r.y + r.height) outside.push(n.getAttribute('data-id'));
        }
        return {ok: outside.length === 0 && nodes.length > 0 && r.width > 50 && r.height > 50,
                total: nodes.length, outside: outside};
    }""")

def settle(page, timeout=20000):
    """等画布就绪：节点全在视口内（fitView 生效）——F4 的 fitView 修复就是为这条"""
    page.wait_for_selector(".react-flow__node", timeout=timeout)
    for _ in range(30):
        res = nodes_all_in_view(page)
        if res["ok"]:
            page.wait_for_timeout(300)
            return res
        page.wait_for_timeout(250)
    return nodes_all_in_view(page)

def viewport_zoom(page):
    """React Flow 视口当前缩放：屏幕像素位移 ÷ zoom = 流程图坐标位移（与 verify-a4 修欠债同款口径）"""
    t = page.locator(".react-flow__viewport").evaluate("el => getComputedStyle(el).transform")
    m = re.match(r"matrix\(([-\d.e]+),", t or "")
    if m:
        return float(m.group(1))
    m2 = re.search(r"scale\(([\d.]+)\)", t or "")
    return float(m2.group(1)) if m2 else 1.0

def drag(page, node_id, dx_flow, dy_flow):
    """拖动：按**节点 DOM 中心**起手，位移按当前 zoom 换算成屏幕像素（dx_flow/dy_flow 是流程图
    坐标里的固定量）。早先按节点左上角 +60/+30 屏幕偏移起手：基线被历史欠债坐标压到 minZoom 时
    节点屏幕尺寸 < 60×30，起手点落在节点外 → 拖的是画布不是节点，PUT 从不触发（A4 修欠债时
    踩过同一坑；ts 侧已把布局基线归零，这里再对齐同一口径双保险）。"""
    node = page.locator(f'.react-flow__node[data-id="{node_id}"]').first
    box = node.bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    zoom = viewport_zoom(page)
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + dx_flow * zoom, cy + dy_flow * zoom, steps=12)
    page.mouse.up()
    page.wait_for_timeout(1600)  # 等 debounce（600ms）PUT 落盘

def a5_counts(page):
    """技术详情读数（v2 派生口径）：每个顶层模块的上屏状态键 + 对账标黄节点数 + 状态词
    （两个视图必须逐项一致；状态词按派生实况里真出现的那些断言，不硬编码六态齐现）"""
    display = {mid: page.locator(f'[data-arch-node="{mid}"]').first.get_attribute("data-display-status")
               for mid in MODULE_IDS}
    diff = page.locator("[data-arch-diff]").count()
    texts = " ".join(page.locator(".react-flow__node").all_inner_texts())
    words = {w: (w in texts) for w in PRESENT_WORDS}
    panel = page.locator("[data-reconcile-panel]").inner_text()
    return display, diff, words, panel

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
    # ③ 网络日志：整个切换过程里不得出现解析/渲染数据请求（只换选择器，不重解析）
    arch_requests = []
    page.on("request", lambda r: arch_requests.append(r.url) if re.search(r"/arch/(parse|expand|render|name)", r.url) else None)

    page.goto(f"{BASE}/#p/{PROJECT}", wait_until="domcontentloaded")
    page.wait_for_timeout(2500)
    page.locator('button[data-view="arch"]').click()
    # V06-08：§3.1 把「项目图」默认落点切到「功能全景」；F4 守的是技术详情里两个 React Flow 视图
    # 共用一个画布实例、坐标各自落盘，所以显式进入「技术详情」——断言、判据与阈值一个字都不动。
    page.locator('[data-project-view-tab="tech"]').click()
    page.wait_for_selector(".react-flow__node", timeout=30000)
    settle(page)
    ok(page.locator('[data-arch-mode="MODULE_BOX"]').count() == 1, "① 技术详情默认进方框图（data-arch-mode=MODULE_BOX）")

    calls0, loads0 = parse_calls(page), data_loads(page)
    print(f"[UI] 起步计数：解析入口调用 {calls0} 次 · 数据层拉取 {loads0} 次")

    # ② 方框图里拖 A（**先拖后展**，2026-09-18）：展开子树的文件节点会和模块位置重叠（实测零基线
    # 下 scripts 的子树压到 src 位置上，DOM 更上层的文件节点会截走中心点抓取 → 拖错对象、MODULE_BOX
    # 桶里落的是文件坐标）。画布只有模块节点时先拖，抓取目标唯一。
    # 生效口径（2026-09-18 加强）：早先只查"读到坐标"——节点没被拖动也照过（欠债现场正是这么漏网的）；
    # 现在按**流程图位移 ≈ 设定值**校验（中心起手 + 按 zoom 换算，位移不受缩放影响）。
    box_a_before = node_pos(page, "__DRAG_A__")
    drag(page, "__DRAG_A__", 260, 180)
    box_a_dragged = node_pos(page, "__DRAG_A__")
    box_b_before = node_pos(page, "__DRAG_B__")
    print("[UI] 方框图：A=__DRAG_A__", box_a_before, "→", box_a_dragged, "；B=__DRAG_B__ 拖动前", box_b_before)
    ok(box_a_dragged is not None and box_a_before is not None and
       abs(box_a_dragged[0] - box_a_before[0] - 260) < 40 and abs(box_a_dragged[1] - box_a_before[1] - 180) < 40,
       f"② 方框图里拖动 A 真实位移生效（{box_a_before} → {box_a_dragged}，流程图位移 ≈ (260,180)）")
    page.screenshot(path=f"{OUT}/f4-01-module-box-dragged.png")

    # ③ 再展开一个模块（制造"跨视图要保持"的折叠状态；模块/文件动态注入）
    page.locator('[data-expand-toggle="__EXPAND_MOD__"]').click()
    page.wait_for_selector('[data-file-node="__EXPAND_FILE__"]', timeout=20000)
    settle(page)
    calls1, loads1 = parse_calls(page), data_loads(page)
    expanded_box = page.locator(".react-flow__node").count()
    ok(calls1 > calls0, f"③ 展开确实走了一次解析入口（计数 {calls0} → {calls1}）")

    # ② 切到数据流向图：展开态保持、计数不变、零新解析请求、画布无空白
    reqs_before_switch = len(arch_requests)
    page.locator('[data-graph-mode="DATA_FLOW"]').click()
    page.wait_for_selector("[data-flow-legend]", timeout=20000)
    switch_res = settle(page)
    ok(page.locator('[data-arch-mode="DATA_FLOW"]').count() == 1, "① 切到数据流向图（同一画布实例，data-arch-mode 变成 DATA_FLOW）")
    ok(page.locator('[data-file-node="__EXPAND_FILE__"]').count() == 1,
       f"③ 方框图里展开的子树在数据流向图里**还在**（不重挂画布 → 折叠状态与子级缓存跨视图保持）")
    ok(parse_calls(page) == calls1 and data_loads(page) == loads1,
       f"③ 切视图不动解析/数据层：解析入口计数 {parse_calls(page)} == {calls1}、数据层拉取 {data_loads(page)} == {loads1}")
    ok(switch_res["ok"], f"④ 数据流向图画布无空白：{switch_res['total']} 个节点全部落在视口内（fitView 生效）")
    ok(len(arch_requests) == reqs_before_switch,
       f"③ 切到数据流向图时零新解析请求（网络日志里 arch/parse|expand|render|name 计数 {len(arch_requests)}，== 切换前 {reqs_before_switch}）")
    flow_a_before = node_pos(page, "__DRAG_A__")
    print("[UI] 数据流向图：A=__DRAG_A__ 那份坐标（本视图自己的）", flow_a_before)
    ok(flow_a_before is None or box_a_dragged is None or
       abs(flow_a_before[0] - box_a_dragged[0]) > 1 or abs(flow_a_before[1] - box_a_dragged[1]) > 1,
       f"② 数据流向图里 A 用的是**本视图自己的**坐标（{flow_a_before} != 方框图 {box_a_dragged}，两桶各存各的）")

    # ② 数据流向图里拖 B 到别处，并用后端 layout.json 证明写进了 DATA_FLOW 桶
    flow_b_before = node_pos(page, "__DRAG_B__")
    drag(page, "__DRAG_B__", 300, 260)
    flow_b_dragged = node_pos(page, "__DRAG_B__")
    ok(flow_b_dragged is not None and flow_b_before is not None and
       (abs(flow_b_dragged[0] - flow_b_before[0]) > 50 or abs(flow_b_dragged[1] - flow_b_before[1]) > 50),
       f"② 数据流向图里拖 B 生效：{flow_b_before} → {flow_b_dragged}")
    layout_json = json.load(urllib.request.urlopen(
        f"http://127.0.0.1:{BACKEND_PORT}/api/projects/{PROJECT}/arch/layout", timeout=30))
    buckets = layout_json["layout"]["positions"]
    ok("__DRAG_B__" in buckets.get("DATA_FLOW", {}),
       f"② 拖动落进 DATA_FLOW 桶：layout.json positions.DATA_FLOW={json.dumps(buckets.get('DATA_FLOW', {}), ensure_ascii=False)}")
    ok("__DRAG_B__" not in buckets.get("MODULE_BOX", {}),
       f"② 同一次拖动没写进 MODULE_BOX 桶（该桶只有方框图里拖的那几个）：{json.dumps(buckets.get('MODULE_BOX', {}), ensure_ascii=False)}")
    settle(page)
    page.screenshot(path=f"{OUT}/f4-02-data-flow-dragged.png")

    # ⑤ 数据流向图上的状态口径（**v2 派生状态** + 对账标黄）
    page.wait_for_selector("[data-display-status]", timeout=20000)
    flow_display, flow_diff, flow_words, flow_panel = a5_counts(page)
    ok(flow_display == {mid: EXPECT_DISPLAY[mid]["key"] for mid in MODULE_IDS},
       f"⑤ 数据流向图里模块上屏状态与派生实况逐项相符：{flow_display}")
    ok(all(flow_words.values()), f"⑤ 数据流向图里状态词随色同显（按实况 {len(PRESENT_WORDS)} 种）：{flow_words}")
    ok(flow_diff > 0, f"⑤ 数据流向图里对账标黄节点 {flow_diff} 个（§4.5 差异是信号）")
    ok("信号" in flow_panel and "不是错误" in flow_panel, "⑤ 数据流向图里对账面板明示「差异是信号，不是错误」")
    page.screenshot(path=f"{OUT}/f4-05-data-flow-four-colors.png")

    # ② 切回方框图：A 仍在拖动后的位置，B 没被数据流向图的拖动带偏
    page.locator('[data-graph-mode="MODULE_BOX"]').click()
    settle(page)
    ok(page.locator('[data-arch-mode="MODULE_BOX"]').count() == 1, "① 切回方框图")
    box_a_back = node_pos(page, "__DRAG_A__")
    box_b_after = node_pos(page, "__DRAG_B__")
    print("[UI] 切回方框图：A=__DRAG_A__", box_a_back, "（方框图拖动后应为", box_a_dragged, "）；B=__DRAG_B__", box_b_after)
    ok(box_a_back is not None and box_a_dragged is not None and
       abs(box_a_back[0] - box_a_dragged[0]) < 1 and abs(box_a_back[1] - box_a_dragged[1]) < 1,
       f"② 切回方框图 A 位置仍在原位：{box_a_back} == 方框图里拖动后的 {box_a_dragged}（数据流向图的拖动没覆盖它）")
    ok(box_b_after is not None and box_b_before is not None and
       abs(box_b_after[0] - box_b_before[0]) < 1 and abs(box_b_after[1] - box_b_before[1]) < 1,
       f"② 方框图的 B（__DRAG_B__）坐标未被数据流向图的拖动改动：{box_b_after} == {box_b_before}")
    ok(page.locator('[data-file-node="__EXPAND_FILE__"]').count() == 1, "③ 切回方框图后展开态仍在（折叠状态没被切换清掉）")
    box_display, box_diff, box_words, box_panel = a5_counts(page)
    ok(box_display == flow_display and box_diff == flow_diff and box_words == flow_words,
       f"⑤ 状态口径两视图逐项一致：上屏状态 {box_display} == {flow_display}、标黄 {box_diff} == {flow_diff}、"
       f"状态词 {box_words} == {flow_words}")
    page.screenshot(path=f"{OUT}/f4-06-module-box-four-colors.png")
    page.screenshot(path=f"{OUT}/f4-03-module-box-switched-back.png")

    # ③④ 来回切换 3 轮：每轮都要求无空白 + 计数不变 + 零解析请求
    calls_before_loop, loads_before_loop = parse_calls(page), data_loads(page)
    requests_before_loop = len(arch_requests)
    blanks = []
    for i in range(3):
        page.locator('[data-graph-mode="DATA_FLOW"]').click()
        settle(page)
        r1 = nodes_all_in_view(page)
        page.locator('[data-graph-mode="MODULE_BOX"]').click()
        settle(page)
        r2 = nodes_all_in_view(page)
        blanks.append((r1["ok"], r1["outside"], r2["ok"], r2["outside"]))
    ok(all(b[0] and b[2] for b in blanks),
       f"④ 来回切换 3 轮，每次两边都无节点落在视口外（每轮 outside={[b[1] + b[3] for b in blanks]}）")
    ok(all(not b[1] and not b[3] for b in blanks), f"④ 全程零个节点在视口外：{[b[1] + b[3] for b in blanks]}")
    ok(parse_calls(page) == calls_before_loop and data_loads(page) == loads_before_loop,
       f"③ 3 轮切换后计数仍不变：解析入口 {parse_calls(page)}（切换前 {calls_before_loop}）· 数据层拉取 {data_loads(page)}（切换前 {loads_before_loop}）")
    ok(len(arch_requests) == requests_before_loop,
       f"③ 3 轮切换期间零新解析请求（arch/parse|expand|render|name 累计 {len(arch_requests)} 次，全部发生在切换之前的展开动作里）")
    a_final = node_pos(page, "__DRAG_A__")
    ok(a_final is not None and box_a_dragged is not None and abs(a_final[0] - box_a_dragged[0]) < 1 and abs(a_final[1] - box_a_dragged[1]) < 1,
       f"② 3 轮来回切换后 A 仍在原位 {a_final}（切视图不跳位）")
    page.screenshot(path=f"{OUT}/f4-04-switch-no-blank.png")
    print(f"[UI] 计数汇总：解析入口 {calls1} → {parse_calls(page)}（切换前后不变）· 数据层拉取 {loads1} → {data_loads(page)}"
          f" · 解析类请求总数 {len(arch_requests)} · 节点 {page.locator('.react-flow__node').count()} 个")
    browser.close()

print("UI_ASSERT_ALL_PASS" if not fails else f"UI_ASSERT_FAILS:{len(fails)}")
`;

try {
  main()
    .then(() => finish())
    .catch((e) => {
      console.error("[verify] 异常:", e);
      process.exitCode = 1;
    });
} catch (err) {
  console.error("[verify] 异常:", err);
  process.exitCode = 1;
}
