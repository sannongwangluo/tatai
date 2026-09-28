// P3 验证脚本（用 tsx 跑）：全局变更流的归并正确性 + 过滤 + 分页 + 边界 + 10 万行性能 + 复用 H3 渲染的源码级断言
// （PLAN.md P3 卡 DoD①–④ 与卡上"跑偏点"红线）。
//
// 用法：pnpm verify:p3
//
// 覆盖点（逐条对 DoD）：
//   ① DoD① 归并正确性：多项目**时间戳交错**的 changes.jsonl → 全局时间倒序正确（主键 ts 倒序、同刻按
//      project_id 升序的确定序），每条带 project_id/project_name，**既有三字段（ts/path/action/size_delta）
//      逐条与源文件相同**、字段集合恰好是「四字段 + 两归属字段」不多不少；期望值由脚本**独立**用
//      "拼起来再 sort" 算出（不走被测代码），逐条全等。
//   ② DoD② 过滤：`project_id=` 只出该项目的行，且与该项目自己的 H3 端口
//      `GET /api/projects/:id/changes` 的返回**逐条全等**（同一条流水两种读法不许分叉）；空项目过滤 = 空。
//   ③ DoD③ 性能：10 万行夹具（8 个临时项目 × 12,500 行）上贴**首屏 / 翻页 / 过滤**三种真实耗时
//      （响应里的服务端耗时拆解 + 客户端往返），total 精确；并贴**服务端进程 RSS 前后对比**（tasklist
//      工作集）+ 一个 `--expose-gc` 子进程里"窗口读 vs 全量读+sort"的堆占用对照（跑偏点红线：全量读会随
//      数据量长大，窗口读不随）。另加源码级护栏：global-changes.ts 里不出现 readFileSync / 全量 sort。
//   ④ DoD④ 复用：源码级断言「流水行渲染全仓只有一份」——`data-change-row` / `data-change-detail` /
//      size_delta 着色都只在 `src/ui/components/ChangesView.tsx`；单项目薄壳 `ChangesPage.tsx` 与
//      全局薄壳 `GlobalChangesPage.tsx` 都只是 `render <ChangesView …>`、自己一行行渲染都没有。
//   ⑤ 边界：空数据（全部项目都还没有 changes.jsonl）→ total 0 + 空数组；单项目边界（只选一个项目 =
//      该项目自己的流水）；offset 越过末尾 → 空数组但 total 不变；limit 缺省/超上限/负数、offset 负数、
//      project_id 不存在 → 各自的明确错误；坏行 → 该项目进 `errors[]`（不静默丢），其余项目照常出行。
//   ⑥ UI（playwright）：入口 → 全局流（200 行 + 所属项目列）、**连续滚动 10 次每步帧耗时**（贴中位/最大）、
//      项目过滤、点行展开行内详情；截图落 `.工作台/verify/p3-*.png`。
//
// 端口策略（照 verify-p2/n1/n2/n3 写法）：**不碰任何既有监听**——后端与 vite 都 bind 0 让系统分配端口
// （vite 经 `TATAI_DEV_API_PORT` 把动态后端端口传给代理）；起前探活、起后盯子进程早退；开头末尾各探一次
// 8787/5173（只记录状态，不杀别人的进程）。
// 隐私（AGENTS.md §5/§6）：夹具全部现造在 os.tmpdir() 里、用独立 TATAI_HOME，不碰真实注册表与真实项目。
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addProject, listProjects } from "../src/server/registry";
import {
  GLOBAL_CHANGES_DEFAULT_LIMIT,
  GLOBAL_CHANGES_MAX_LIMIT,
  type GlobalChangesResult,
} from "../src/server/global-changes";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY_DIR = path.join(REPO_ROOT, ".工作台", "verify");

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const info = (label: string) => console.log(`[verify] ---- ${label}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── 服务与端口（动态分配 + 探活） ─────────────────────────────

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

async function pickFreePort(): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });
    if (port > 0 && !(await portListening(port))) return port;
  }
  throw new Error("分配不到空闲端口（连续 5 次都被抢）");
}

const intentionalStop = new Set<number>();

function pipeOutput(child: ChildProcess, label: string): void {
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[${label}] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${label}] ${d}`));
}

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

interface Service {
  proc: ChildProcess;
  port: number;
  base: string;
}

async function startService(
  label: string,
  port: number,
  spawnFn: (port: number) => ChildProcess,
  readyUrls: string[],
): Promise<Service> {
  if (await portListening(port)) throw new Error(`${label} 端口 ${port} 已被占用（本脚本不碰既有监听，请重跑）`);
  const child = spawnFn(port);
  pipeOutput(child, `${label}:${port}`);
  child.once("exit", (code) => {
    if (!intentionalStop.has(port) && code !== 0) {
      console.error(`[verify] ${label}（端口 ${port}）意外退出：code=${code}（端口被抢？）`);
    }
  });
  try {
    await waitUpAny(readyUrls, `${label} ${port}`, { isAlive: () => child.exitCode === null });
  } catch (e) {
    killTree(child, port); // 没起来就别留子进程（端口被抢时尤其要收干净）
    await sleep(400);
    throw e;
  }
  return { proc: child, port, base: `http://127.0.0.1:${port}` };
}

/** 取某进程的工作集（KB）——Windows 用 tasklist（Win11 已无 wmic）；拿不到返回 null（不假报数字） */
function processRssKb(pid: number): number | null {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: "utf8" });
    const m = out.trim().match(/"([\d,]+ K)"\s*$/);
    if (!m) return null;
    const kb = Number(m[1].replace(/[^\d]/g, ""));
    return Number.isFinite(kb) ? kb : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── 夹具：临时 TATAI_HOME + 临时项目 ─────────────────────────────

interface FixtureLine {
  ts: string;
  path: string;
  action: "add" | "modify" | "remove";
  size_delta: number | null;
}

interface FixtureProject {
  id: string;
  name: string;
  root: string;
  lines: FixtureLine[];
}

const T0 = Date.parse("2026-09-18T10:00:00+08:00");

/** 造一个项目的流水内容（ts 严格递增；stepSec = 相邻两条的间隔，offsetSec = 相对 T0 的相位） */
function buildLines(id: string, n: number, stepSec: number, offsetSec: number): FixtureLine[] {
  const out: FixtureLine[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      ts: new Date(T0 + (i * stepSec + offsetSec) * 1000).toISOString(),
      path: `src/${id}/mod${i % 3}/file${i}.ts`,
      action: (["add", "modify", "remove"] as const)[i % 3],
      size_delta: i % 5 === 0 ? null : (i % 2 === 0 ? 1 : -1) * (i % 4096),
    });
  }
  return out;
}

function writeChanges(project: FixtureProject, lines: FixtureLine[]): void {
  const dir = path.join(project.root, ".工作台");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "changes.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
}

// ───────────────────────────── HTTP 助手 ─────────────────────────────

interface AllResp extends GlobalChangesResult {
  ok: boolean;
  error?: { code: string; message: string };
}

async function getAll(
  base: string,
  qs = "",
): Promise<{ status: number; body: AllResp; ms: number; bytes: number }> {
  const t = Date.now();
  const res = await fetch(`${base}/api/changes/all${qs}`);
  const text = await res.text();
  return {
    status: res.status,
    body: JSON.parse(text) as AllResp,
    ms: Date.now() - t,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

interface H3Resp {
  ok: boolean;
  changes?: { ts: string; path: string; action: string; size_delta: number | null }[];
  total?: number;
  error?: { code: string; message: string };
}

async function getH3(base: string, projectId: string): Promise<H3Resp> {
  const res = await fetch(
    `${base}/api/projects/${encodeURIComponent(projectId)}/changes?limit=100000`,
  );
  return (await res.json()) as H3Resp;
}

/** 期望的全局倒序（脚本**独立**算：拼起来 + 按「ts 倒序、同刻 project_id 升序」sort，不走被测代码） */
function expectedOrdered(projects: FixtureProject[]): { id: string; name: string; line: FixtureLine }[] {
  const flat = projects.flatMap((p) => p.lines.map((line) => ({ id: p.id, name: p.name, line })));
  return flat.sort((a, b) => {
    const d = Date.parse(b.line.ts) - Date.parse(a.line.ts);
    if (d !== 0) return d;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

const sameChange = (a: FixtureLine, b: FixtureLine) =>
  a.ts === b.ts && a.path === b.path && a.action === b.action && a.size_delta === b.size_delta;

// ───────────────────────────── 源码级护栏（DoD③④ 红线） ─────────────────────────────

function walkSrc(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSrc(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(path.relative(REPO_ROOT, p).replace(/\\/g, "/"));
  }
  return out;
}

function checkSourceGuards(): void {
  info("④ 源码级护栏：流水行渲染全仓只有一份（复用 H3，不另写）+ 归并侧不做全量读");
  const files = walkSrc(path.join(REPO_ROOT, "src"));
  const read = (f: string) => fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
  const filesWith = (needle: string) => files.filter((f) => read(f).includes(needle)).sort();

  const view = "src/ui/components/ChangesView.tsx";
  const h3Shell = "src/ui/components/ChangesPage.tsx";
  const globalShell = "src/ui/components/GlobalChangesPage.tsx";

  const rowHits = filesWith("data-change-row");
  ok(
    JSON.stringify(rowHits) === JSON.stringify([view]),
    `④ 行渲染唯一：全仓含 data-change-row 的文件 = ${rowHits.join(", ") || "（无）"}（期望只有 ${view}）`,
  );
  const detailHits = filesWith("data-change-detail");
  ok(
    JSON.stringify(detailHits) === JSON.stringify([view]),
    `④ 行内详情唯一：含 data-change-detail 的文件 = ${detailHits.join(", ") || "（无）"}`,
  );
  const actionHits = filesWith("ACTION_LABEL");
  // 2026-09-20 审计（R1-C-004）：子串匹配会把 DECISION_ACTION_LABELS 一并命中，
  // 故把清单对齐现实——变更流水的 ACTION_LABEL 仍只在 ChangesView，另两处是 decisions 侧同名字符串；
  // 断言仍锁死"就这三处"，不许再飘。
  const expectAction = [
    "src/server/work/decisions.ts",
    "src/ui/components/ChangesView.tsx",
    "src/ui/components/DesignView.tsx",
  ];
  ok(
    JSON.stringify(actionHits) === JSON.stringify(expectAction),
    `④ action 文案/着色唯一：含 ACTION_LABEL 的文件 = ${actionHits.join(", ") || "（无）"}`,
  );
  ok(
    read(h3Shell).includes("<ChangesView") && read(globalShell).includes("<ChangesView"),
    `④ 两个薄壳（${h3Shell} / ${globalShell}）都只是 render <ChangesView …>（同一份渲染器）`,
  );
  ok(
    !read(h3Shell).includes("<li") && !read(globalShell).includes("<li"),
    "④ 两个薄壳自己一行行渲染都没有（文件里不出现 <li，行结构只可能在 ChangesView）",
  );
  ok(
    read(globalShell).includes("projectLabel") && read(view).includes("data-change-project"),
    "④ 跨项目视图的「所属项目」列走渲染器的 projectLabel（不是自己拼的行）",
  );

  const merge = "src/server/global-changes.ts";
  const mergeSrc = read(merge);
  // 看**代码**而不是注释：注释里为了说明"为什么不用 readChanges 那套"会提到 readFileSync，
  // 那不是调用；把注释剥掉再查，护栏才拦得住真的全量读。
  const code = mergeSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  ok(
    !code.includes("readFileSync") && !code.includes(".sort("),
    `③ 归并侧不做全量读+排序：${merge} 的代码里不出现 readFileSync、不出现 Array.sort（窗口读 + 手写最大堆归并；注释里提到不算）`,
  );
  ok(
    mergeSrc.includes("lastIndexOf") && mergeSrc.includes("SourceHeap") && mergeSrc.includes("countLinesUncached"),
    "③ 三件套在位：倒读切行（lastIndexOf 按 \\n 字节切）+ 最大堆归并（SourceHeap）+ 流式行计数（countLinesUncached）",
  );
  const parseHits = filesWith("parseChangeLine");
  ok(
    JSON.stringify(parseHits) ===
      JSON.stringify(["src/server/global-changes.ts", "src/server/watcher.ts"].sort()),
    `③ §2.3.5 行校验唯一出处：含 parseChangeLine 的文件 = ${parseHits.join(", ")}（watcher 定义、global-changes 复用）`,
  );
}

// ───────────────────────────── UI 段：python playwright ─────────────────────────────

const PY_SHOT = `# P3 UI 段（一次性脚本，落 .工作台/verify/，gitignore）。
import json, sys, statistics
from playwright.sync_api import sync_playwright

vite_port, backend_port, spec_path = sys.argv[1], sys.argv[2], sys.argv[3]
spec = json.load(open(spec_path, encoding="utf-8"))
BASE = "http://localhost:" + vite_port
FAIL = []

def ok(cond, label):
    print(("[verify] PASS " if cond else "[verify] FAIL ") + label)
    if not cond:
        FAIL.append(label)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1500, "height": 900})
    page_errors = []
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    # 全局流的取数请求流水（用来证明"滚动不触发重新取数"）
    api_reqs = []
    page.on("request", lambda r: api_reqs.append(r.url) if "/api/changes/all" in r.url else None)

    page.goto(BASE + "/", wait_until="domcontentloaded")
    page.wait_for_selector('[data-entry="cross-project"]', timeout=40000)
    page.click('[data-entry="cross-project"]')
    page.wait_for_selector('[data-cross-view]', timeout=20000)
    ok(page.locator('[data-entry="global-changes"]').count() == 1,
       "⑥ 跨项目视图头部有「全局变更流」入口（§3.1 左栏与 P2 行结构未受影响：行数 " + str(page.locator('[data-cross-row]').count()) + "）")

    page.click('[data-entry="global-changes"]')
    page.wait_for_selector('[data-changes-page]', timeout=20000)
    page.wait_for_selector('[data-change-row]', timeout=20000)

    rows = page.locator('[data-change-row]')
    n_rows = rows.count()
    total_text = page.locator('[data-changes-total]').inner_text()
    ok(n_rows == 200, "⑥ 全局流首屏渲染窗口 = 200 行（实际 " + str(n_rows) + "）")
    ok(str(spec["total"]) in total_text, "⑥ 标题条上的总数 = 合并总条数 " + str(spec["total"]) + "（实际：" + total_text + "）")
    proj_labels = page.locator('[data-change-project]')
    n_labels = proj_labels.count()
    seen = set(proj_labels.nth(i).inner_text() for i in range(min(n_labels, 60)))
    ok(n_labels >= n_rows, "⑥ 每行都有「所属项目」列（行 " + str(n_rows) + " / 标签 " + str(n_labels) + "）")
    ok(len(seen) >= 5, "⑥ 首屏 60 行里出现 " + str(len(seen)) + " 个项目（确实是跨项目合并，不是单项目）：" + "、".join(sorted(seen)))

    page.screenshot(path="p3-01-global-stream.png")

    # 连续滚动 10 次：一边滚一边用 rAF 记录**每一帧的间隔**（不是"等两帧再计时"——那种测法把
    # 自己的等待算进去，任何页面都是 33ms）。再加 PerformanceObserver 采长任务（主线程被占的痕迹）。
    req_before = len(api_reqs)
    scroll = page.evaluate("""() => {
      const box = document.querySelector('[data-changes-page] div.overflow-y-auto');
      const deltas = [];
      const longTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) longTasks.push(e.duration);
        }).observe({ entryTypes: ["longtask"] });
      } catch (err) { /* 不支持就不采，不假造数字 */ }
      let last = 0;
      let alive = true;
      const tick = (t) => {
        if (last) deltas.push(t - last);
        last = t;
        if (alive) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return (async () => {
        const steps = [];
        for (let i = 0; i < 10; i++) {
          const t0 = performance.now();
          box.scrollTop = box.scrollTop + 400;
          // 等 3 帧：采样窗口 ~500ms（约 30 帧），太短的话样本不足、说明不了流畅性
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
          steps.push(performance.now() - t0);
        }
        alive = false;
        return {
          steps,
          deltas,
          longTasks,
          scrollTop: box.scrollTop,
          scrollHeight: box.scrollHeight,
          clientHeight: box.clientHeight,
          rows: document.querySelectorAll('[data-change-row]').length,
        };
      })();
    }""")
    deltas = scroll["deltas"]
    steps = scroll["steps"]
    avg = statistics.mean(deltas) if deltas else 0.0
    worst = max(deltas) if deltas else 0.0
    dropped = len([d for d in deltas if d > 25])
    longtasks = scroll["longTasks"]
    print("[verify] 滚动 10 次每步耗时(ms): " + ", ".join("%.1f" % s for s in steps))
    print("[verify] 滚动期间共采 %d 帧：平均 %.1fms/帧（约 %.0f FPS）/ 最慢一帧 %.1fms / >25ms 的帧 %d 个 / 主线程长任务 %d 个" % (len(deltas), avg, 1000.0 / avg if avg else 0, worst, dropped, len(longtasks)))
    print("[verify] 滚动容器 %d px 视口 / 内容 %d px 高（%d 行常驻 DOM），滚到 %d px" % (scroll["clientHeight"], scroll["scrollHeight"], scroll["rows"], scroll["scrollTop"]))
    ok(abs(scroll["rows"] - 200) <= 1, "⑥ 滚动期间常驻 DOM 行数保持 ~200（渲染窗口不膨胀，实际 %d）" % scroll["rows"])
    ok(avg < 20, "⑥ 滚动期间平均帧间隔 %.1fms（<20ms，接近 60 FPS）" % avg)
    ok(worst < 60, "⑥ 最慢一帧 %.1fms（<60ms，没有掉帧到肉眼可见的卡顿）" % worst)
    ok(len(longtasks) == 0, "⑥ 滚动期间主线程长任务 %d 个（0 = 没有被渲染/布局占住的卡顿痕迹）" % len(longtasks))
    ok(len(api_reqs) == req_before, "⑥ 滚动 10 次期间零新请求（滚动不触发重新取数；实际新增 %d 次 /api/changes/all）" % (len(api_reqs) - req_before))
    page.screenshot(path="p3-02-scrolled.png")

    # 再加一页（「加载更多」→ 400 行常驻）再滚一次：越翻越多的列表也不许卡
    page.click('[data-changes-more]')
    page.wait_for_function("() => document.querySelectorAll('[data-change-row]').length === 400", timeout=20000)
    more = page.evaluate("""() => {
      const box = document.querySelector('[data-changes-page] div.overflow-y-auto');
      const deltas = [];
      const longTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) longTasks.push(e.duration);
        }).observe({ entryTypes: ["longtask"] });
      } catch (err) { /* 同上 */ }
      let last = 0;
      let alive = true;
      const tick = (t) => {
        if (last) deltas.push(t - last);
        last = t;
        if (alive) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return (async () => {
        for (let i = 0; i < 10; i++) {
          box.scrollTop = box.scrollTop + 400;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))));
        }
        alive = false;
        return { deltas, longTasks, rows: document.querySelectorAll('[data-change-row]').length };
      })();
    }""")
    d2 = more["deltas"]
    avg2 = statistics.mean(d2) if d2 else 0.0
    print("[verify] 加载到 %d 行后再滚 10 次：共采 %d 帧 / 平均 %.1fms / 最慢 %.1fms / 长任务 %d 个" % (more["rows"], len(d2), avg2, max(d2) if d2 else 0.0, len(more["longTasks"])))
    ok(avg2 < 20, "⑥ 加载 400 行后继续滚动平均帧间隔 %.1fms（<20ms，列表变长也不卡）" % avg2)

    # 单项目过滤（DoD② 的 UI 侧）
    page.select_option('[data-changes-project-filter]', spec["filter_project_id"])
    page.wait_for_function(
        "() => document.querySelector('[data-changes-total]').innerText.indexOf('" + str(spec["filter_total"]) + "') >= 0",
        timeout=20000,
    )
    rows2 = page.locator('[data-change-row]')
    labels2 = set(page.locator('[data-change-project]').nth(i).inner_text() for i in range(page.locator('[data-change-project]').count()))
    ok(labels2 == {spec["filter_project_name"]},
       "②⑥ 过滤 " + spec["filter_project_id"] + " 后 200 行全部属于「" + spec["filter_project_name"] + "」（实际集合 " + "、".join(sorted(labels2)) + "）")
    ok(str(spec["filter_total"]) in page.locator('[data-changes-total]').inner_text(),
       "②⑥ 过滤后总数 = 该项目行数 " + str(spec["filter_total"]))
    page.screenshot(path="p3-03-filtered.png")

    # 回到全部项目 → 点行展开行内详情
    page.select_option('[data-changes-project-filter]', "")
    page.wait_for_function("() => document.querySelectorAll('[data-change-row]').length === 200", timeout=20000)
    page.locator('[data-change-row]').nth(0).locator("button").click()
    page.wait_for_selector('[data-change-detail]', timeout=10000)
    detail = page.locator('[data-change-detail]').inner_text()
    ok("所属项目" in detail, "⑥ 行内详情含「所属项目」字段（详情原文：" + detail.replace(chr(10), " / ") + "）")
    page.screenshot(path="p3-04-row-detail.png")

    # 按文件分组仍可用（同一渲染器的另一条分支）
    page.keyboard.press("Escape")
    page.wait_for_selector('[data-changes-page]', state="detached", timeout=10000)
    page.click('[data-entry="global-changes"]')
    page.wait_for_selector('[data-change-row]', timeout=20000)
    page.click('[data-changes-group-toggle]')
    page.wait_for_selector('[data-changes-groups]', timeout=10000)
    n_groups = page.locator('[data-changes-groups] details').count()
    ok(n_groups > 0, "⑥ 按文件分组在全局流上照样可用（" + str(n_groups) + " 组）")
    page.screenshot(path="p3-05-grouped.png")

    # 单项目子页面（H3）走的是同一个渲染器：点跨项目视图里的一行进入项目上下文 →
    # 「最近变更」入口 → 流水子页面。这里验"复用"的翻面：H3 自己的页面没被改坏，
    # 且单项目视图**不出现**「所属项目」列（同一渲染器、DOM 不因项目列而变）。
    page.keyboard.press("Escape")
    page.wait_for_selector('[data-changes-page]', state="detached", timeout=10000)
    page.click('[data-cross-row][data-project-id="' + spec["filter_project_id"] + '"]')
    page.wait_for_selector('[data-changes-entry]', timeout=20000)
    page.click('[data-changes-entry]')
    page.wait_for_selector('[data-changes-page]', timeout=20000)
    page.wait_for_selector('[data-change-row]', timeout=20000)
    h3_title = page.locator('[data-changes-page] h2').inner_text()
    h3_rows = page.locator('[data-change-row]').count()
    h3_labels = page.locator('[data-change-project]').count()
    ok(("变更流水 · " + spec["filter_project_name"]) in h3_title, "④ H3 单项目子页面照常打开（标题：" + h3_title + "）")
    ok(h3_rows == 200, "④ H3 单项目子页面首屏也是 200 行（同一渲染器，实际 " + str(h3_rows) + "）")
    ok(h3_labels == 0, "④ 单项目视图**没有**「所属项目」列（那一格不进 DOM，实际 " + str(h3_labels) + " 个）——同一渲染器按数据源决定列，不是两份实现")
    ok(page.locator('[data-changes-filter]').count() == 1, "④ 单项目视图保留按路径过滤输入框（跨项目视图关掉的那个）")
    page.fill('[data-changes-filter]', spec["h3_path_filter"])
    page.keyboard.press("Enter")
    # 过滤后首屏仍是 200 行（命中数远大于一页），所以按"计数条上的过滤后总数"来等——
    # 只等"第一行命中过滤串"会被未过滤列表的首行直接满足（那一行碰巧也命中）。
    page.wait_for_function(
        "() => { const t = document.querySelector('[data-changes-total]').innerText; const m = t.match(/共 (\\d+) 条/); return t.indexOf('过滤:') >= 0 && m && Number(m[1]) === "
        + str(spec["h3_path_total"]) + "; }",
        timeout=20000,
    )
    paths = page.evaluate(
        "() => Array.from(document.querySelectorAll('[data-change-row]')).map((li) => { const s = li.querySelectorAll('span[title]'); return s.length ? s[s.length - 1].title : ''; })"
    )
    hit = len([p for p in paths if spec["h3_path_filter"] in p])
    total_h3 = page.locator('[data-changes-total]').inner_text()
    ok(len(paths) > 0 and hit == len(paths), "④ H3 单项目路径过滤仍生效（" + spec["h3_path_filter"] + "：" + str(hit) + "/" + str(len(paths)) + " 行命中；计数条「" + total_h3 + "」与后端口径一致）")
    page.screenshot(path="p3-06-h3-subpage.png")
    page.keyboard.press("Escape")
    page.wait_for_selector('[data-changes-page]', state="detached", timeout=10000)

    ok(len(page_errors) == 0, "⑥ 全程零页面异常（实际 " + str(len(page_errors)) + "：" + " | ".join(page_errors[:3]) + "）")
    browser.close()

print("[verify] UI 段断言：" + str(len(FAIL)) + " 条 FAIL")
print("UI_ASSERT_ALL_PASS" if not FAIL else "UI_ASSERT_FAIL")
`;

async function uiPlaywright(specPath: string, backend: Service): Promise<void> {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const pyPath = path.join(VERIFY_DIR, "p3-shot.py");
  fs.writeFileSync(pyPath, PY_SHOT, "utf8");
  let vite: Service | null = null;
  for (let attempt = 1; attempt <= 3 && !vite; attempt++) {
    const port = await pickFreePort();
    try {
      vite = await startService(
        "vite",
        port,
        (p) =>
          spawn(
            process.execPath,
            [path.join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js"), "dev", "--port", String(p), "--strictPort"],
            {
              stdio: ["ignore", "pipe", "pipe"],
              cwd: REPO_ROOT,
              env: { ...process.env, TATAI_DEV_API_PORT: String(backend.port) },
            },
          ),
        [`http://localhost:${port}/`, `http://127.0.0.1:${port}/`],
      );
    } catch (e) {
      console.log(`[verify]   vite 端口 ${port} 起不来（第 ${attempt} 次）：${(e as Error).message}`);
    }
  }
  if (!vite) {
    ok(false, "⑥ UI 段：vite 起不来（连续 3 个动态端口都失败）");
    return;
  }
  console.log(`[verify]   UI 段服务就绪：后端 ${backend.port}（动态端口）+ vite ${vite.port}（动态端口）`);
  try {
    const out = execSync(`python "${pyPath}" ${vite.port} ${backend.port} "${specPath}"`, {
      cwd: VERIFY_DIR,
      stdio: "pipe",
      timeout: 900_000,
    }).toString();
    process.stdout.write(out);
    ok(out.includes("UI_ASSERT_ALL_PASS"), "⑥ playwright：入口 / 200 行窗口 / 所属项目列 / 10 次滚动帧耗时 / 项目过滤 / 行内详情 / 按文件分组 全过");
  } catch (e) {
    process.stdout.write((e as { stdout?: Buffer }).stdout?.toString() ?? "");
    process.stderr.write((e as { stderr?: Buffer }).stderr?.toString() ?? "");
    ok(false, "⑥ UI 段执行失败（见上方输出）");
  } finally {
    killTree(vite.proc, vite.port);
    await sleep(500);
  }  for (const shot of [
    "p3-01-global-stream.png",
    "p3-02-scrolled.png",
    "p3-03-filtered.png",
    "p3-04-row-detail.png",
    "p3-05-grouped.png",
    "p3-06-h3-subpage.png",
  ]) {
    ok(fs.existsSync(path.join(VERIFY_DIR, shot)), `⑥ UI 截图落盘 .工作台/verify/${shot}`);
  }
}

// ───────────────────────────── 内存对照探针（--expose-gc 子进程） ─────────────────────────────

const MEM_PROBE = `// P3 内存对照探针（一次性，落 .工作台/verify/，gitignore）：同一份夹具上比两种做法的堆占用。
// 用法：node --expose-gc --import tsx p3-mem-probe.ts <TATAI_HOME>
process.env.TATAI_HOME = process.argv[2];
const fs = await import("node:fs");
const path = await import("node:path");
const { queryGlobalChanges } = await import("../../src/server/global-changes");
const { listProjects } = await import("../../src/server/registry");

const heap = () => {
  global.gc();
  return process.memoryUsage().heapUsed;
};

const base = heap();
// 做法 A（本卡口径）：窗口读 + K 路归并，连翻 60 页
for (let i = 0; i < 60; i++) queryGlobalChanges({ limit: 200, offset: i * 200 });
const afterWindow = heap();

// 做法 B（PLAN P3 跑偏点要防的红线做法）：全量读进内存 + sort
const all = [];
for (const p of listProjects()) {
  const f = path.join(p.path, ".工作台", "changes.jsonl");
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split(/\\r?\\n/)) {
    if (line.trim() !== "") all.push(JSON.parse(line));
  }
}
all.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
const afterFull = heap();

console.log(
  JSON.stringify({
    base_mb: +(base / 1048576).toFixed(1),
    window_mb: +((afterWindow - base) / 1048576).toFixed(1),
    full_mb: +((afterFull - afterWindow) / 1048576).toFixed(1),
    rows: all.length,
  }),
);
`;

interface MemProbeResult {
  base_mb: number;
  window_mb: number;
  full_mb: number;
  rows: number;
}

function runMemProbe(home: string): MemProbeResult | null {
  const probePath = path.join(VERIFY_DIR, "p3-mem-probe.ts");
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  fs.writeFileSync(probePath, MEM_PROBE, "utf8");
  try {
    const out = execSync(
      `"${process.execPath}" --expose-gc --import tsx "${probePath}" "${home}"`,
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 300_000 },
    ).toString();
    const line = out.trim().split(/\r?\n/).filter((l) => l.startsWith("{"))[0];
    return line ? (JSON.parse(line) as MemProbeResult) : null;
  } catch (e) {
    console.error("[verify] 内存探针失败：", (e as Error).message);
    return null;
  }
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main(): Promise<void> {
  console.log("[verify] P3 全局变更流：归并 / 过滤 / 分页 / 边界 / 10 万行性能 / 复用渲染");
  const fixedBefore = { v: await portListening(8787), d: await portListening(5173) };
  console.log(
    `[verify]   8787 ${fixedBefore.v ? "有人监听（别人的，不碰）" : "空闲"} · 5173 ${fixedBefore.d ? "有人监听（别人的，不碰）" : "空闲"}`,
  );

  // ── 夹具：临时数据目录 + 12 个临时项目（4 小 + 8 大 = 10 万行），全在 os.tmpdir() 里 ──
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-p3-verify-"));
  const home = path.join(tmpBase, "home");
  fs.mkdirSync(home, { recursive: true });

  const small: FixtureProject[] = [];
  for (const [id, name, n, step, off] of [
    ["p3-a", "夹具甲", 6, 2, 0],
    ["p3-b", "夹具乙", 5, 3, 1],
    ["p3-c", "夹具丙", 3, 5, 2],
  ] as const) {
    const root = path.join(tmpBase, id);
    fs.mkdirSync(root, { recursive: true });
    addProject({ id, name, path: root, kind: "backend" }, home);
    small.push({ id, name, root, lines: buildLines(id, n, step, off) });
  }
  // 空项目：登记了、但一次变更都没有（没有 changes.jsonl）
  const emptyRoot = path.join(tmpBase, "p3-empty");
  fs.mkdirSync(emptyRoot, { recursive: true });
  addProject({ id: "p3-empty", name: "夹具空", path: emptyRoot, kind: "backend" }, home);

  const big: FixtureProject[] = [];
  const BIG_PROJECTS = 8;
  const BIG_PER = 12_500;
  for (let i = 0; i < BIG_PROJECTS; i++) {
    const id = `p3-big-${i}`;
    const name = `大夹具${i}`;
    const root = path.join(tmpBase, id);
    fs.mkdirSync(root, { recursive: true });
    addProject({ id, name, path: root, kind: "backend" }, home);
    big.push({ id, name, root, lines: buildLines(id, BIG_PER, BIG_PROJECTS, i) });
  }
  console.log(
    `[verify]   夹具：${listProjects(home).length} 个临时项目（小 ${small.length} + 空 1 + 大 ${big.length} × ${BIG_PER} = ${BIG_PROJECTS * BIG_PER} 行），TATAI_HOME=${home}`,
  );

  const backendPort = await pickFreePort();
  let backend: Service | null = null;
  try {
    backend = await startService(
      "后端",
      backendPort,
      (port) =>
        spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: REPO_ROOT,
          env: { ...process.env, TATAI_HOME: home, TATAI_PORT: String(port) },
        }),
      [`http://127.0.0.1:${backendPort}/health`],
    );
    const base = backend.base;

    // ── ① 空数据：一个 changes.jsonl 都还没有 ──
    info("① 边界：空数据（全部项目都还没有 changes.jsonl）");
    const empty = await getAll(base);
    ok(
      empty.status === 200 && empty.body.total === 0 && empty.body.changes.length === 0,
      `① 空数据 → 200 / total 0 / 空数组（实际 total=${empty.body.total} len=${empty.body.changes.length}）`,
    );
    ok(
      empty.body.stats.sources === 0 && empty.body.errors.length === 0,
      `① 空数据没有数据源也没有错误（sources=${empty.body.stats.sources} errors=${empty.body.errors.length}）`,
    );
    const emptyOne = await getAll(base, "?project_id=p3-empty");
    ok(
      emptyOne.status === 200 && emptyOne.body.total === 0,
      `① 单项目边界：只选一个还没变更过的项目 → total 0（实际 ${emptyOne.body.total}）`,
    );

    // ── ② 归并正确性（多项目交错时间戳） ──
    for (const p of small) writeChanges(p, p.lines);
    const expectedSmall = expectedOrdered(small);
    info(`② DoD①：${small.length} 个项目时间戳交错（共 ${expectedSmall.length} 行）→ 全局倒序 + 归属字段`);
    const merged = await getAll(base, `?limit=${GLOBAL_CHANGES_MAX_LIMIT}`);
    ok(
      merged.status === 200 && merged.body.total === expectedSmall.length,
      `② total = 各项目行数之和 ${expectedSmall.length}（实际 ${merged.body.total}）`,
    );
    ok(
      merged.body.changes.length === expectedSmall.length &&
        merged.body.changes.every(
          (l, i) => l.ts === expectedSmall[i].line.ts && l.project_id === expectedSmall[i].id,
        ),
      "② 逐条与脚本独立算出的期望序全等（ts 倒序；同刻按 project_id 升序）",
    );
    ok(
      merged.body.changes.every(
        (l, i) => i === 0 || Date.parse(merged.body.changes[i - 1].ts) >= Date.parse(l.ts),
      ),
      "② ts 单调不增（全局时间倒序，DoD①）",
    );
    const keys = Object.keys(merged.body.changes[0]).sort();
    ok(
      JSON.stringify(keys) === JSON.stringify(["action", "path", "project_id", "project_name", "size_delta", "ts"]),
      `② 行字段恰好 = §2.3.5 四字段 + 两个归属字段（实际 ${keys.join(",")}）`,
    );
    const fieldOk = merged.body.changes.every((l) => {
      const src = small.find((p) => p.id === l.project_id)!;
      const hit = src.lines.find((x) => x.ts === l.ts);
      return hit !== undefined && sameChange(hit, l);
    });
    ok(fieldOk, "② 每行的 ts/path/action/size_delta 与源文件那一行逐字段相同（三字段口径原样）");
    ok(
      merged.body.changes.every((l) => l.project_name === small.find((p) => p.id === l.project_id)!.name),
      "② project_name 取自注册表显示名（夹具甲/乙/丙）",
    );
    console.log(
      `[verify]   前 6 行：${merged.body.changes
        .slice(0, 6)
        .map((l) => `${l.ts.slice(11, 19)} ${l.project_id}`)
        .join(" | ")}`,
    );

    // ── ③ 分页无重无漏 ──
    info("③ 分页：无重、无漏、逐页与期望切片全等");
    const pages: GlobalChangeLineLike[][] = [];
    for (let offset = 0; offset < expectedSmall.length; offset += 4) {
      const r = await getAll(base, `?limit=4&offset=${offset}`);
      pages.push(r.body.changes as GlobalChangeLineLike[]);
    }
    const flat = pages.flat();
    ok(flat.length === expectedSmall.length, `③ 翻页总条数 ${flat.length} = ${expectedSmall.length}（不漏）`);
    ok(
      flat.every((l, i) => l.ts === expectedSmall[i].line.ts && l.project_id === expectedSmall[i].id),
      "③ 拼接后的顺序与全量期望逐条全等（不重、不乱序）",
    );
    ok(
      new Set(flat.map((l) => `${l.ts}|${l.project_id}|${l.path}`)).size === flat.length,
      "③ 页与页之间零重复（同一 ts/项目/路径不出现两次）",
    );
    const tail = await getAll(base, `?limit=4&offset=${expectedSmall.length}`);
    ok(tail.body.changes.length === 0 && tail.body.total === expectedSmall.length, "③ offset 越过末尾 → 空数组且 total 不变");
    ok(
      (await getAll(base)).body.changes.length === expectedSmall.length,
      `③ 不带参数时按缺省 limit 取窗口（小夹具 ${expectedSmall.length} 行 < 缺省 ${GLOBAL_CHANGES_DEFAULT_LIMIT}，全部返回）`,
    );

    // ── ④ 过滤：与该项目自己的 H3 端点逐条全等 ──
    info("② DoD②：project_id 过滤（并与 H3 单项目端点对照）");
    const h3a = await getH3(base, "p3-a");
    const filtered = await getAll(base, "?project_id=p3-a&limit=1000");
    ok(
      filtered.body.total === small[0].lines.length && filtered.body.changes.length === small[0].lines.length,
      `② 过滤 p3-a → total/条数 = 该项目行数 ${small[0].lines.length}`,
    );
    ok(
      filtered.body.changes.every((l) => l.project_id === "p3-a" && l.project_name === "夹具甲"),
      "② 过滤后每行归属都是 p3-a / 夹具甲",
    );
    ok(
      h3a.ok === true &&
        (h3a.changes ?? []).length === filtered.body.changes.length &&
        (h3a.changes ?? []).every((l, i) => sameChange(l as FixtureLine, filtered.body.changes[i])),
      `② 与 GET /api/projects/p3-a/changes 逐条全等（同一份流水的两种读法不分叉，${h3a.changes?.length} 条）`,
    );
    const badFilter = await getAll(base, "?project_id=no-such-project");
    ok(
      badFilter.status === 404 && badFilter.body.error?.code === "PROJECT_NOT_FOUND",
      `④ project_id 不存在 → 404 PROJECT_NOT_FOUND（实际 ${badFilter.status} ${badFilter.body.error?.code}）`,
    );

    // ── ⑤ 参数校验 ──
    const bad1 = await getAll(base, "?limit=-1");
    const bad2 = await getAll(base, "?offset=abc");
    const bad3 = await getAll(base, `?limit=${GLOBAL_CHANGES_MAX_LIMIT + 1}`);
    ok(bad1.status === 400 && bad1.body.error?.code === "INVALID_INPUT", `④ limit=-1 → 400（实际 ${bad1.status}）`);
    ok(bad2.status === 400 && bad2.body.error?.code === "INVALID_INPUT", `④ offset=abc → 400（实际 ${bad2.status}）`);
    ok(
      bad3.status === 400 && (bad3.body.error?.message ?? "").includes("上限"),
      `④ limit=${GLOBAL_CHANGES_MAX_LIMIT + 1} 超上限 → 400 并明说上限（不静默截断；实际 ${bad3.status}：${bad3.body.error?.message}）`,
    );

    // ── ⑥ 坏行：该项目进 errors[]，其余照常 ──
    info("⑤ 坏行：不静默丢、不整屏黑");
    const cFile = path.join(small[2].root, ".工作台", "changes.jsonl");
    fs.appendFileSync(cFile, "{ 这不是 JSON\n", "utf8");
    const broken = await getAll(base, "?limit=200");
    ok(
      broken.body.errors.length === 1 && broken.body.errors[0].project_id === "p3-c",
      `⑤ 坏行项目进 errors[]（实际 ${JSON.stringify(broken.body.errors)}）`,
    );
    ok(
      broken.body.total === expectedSmall.length - small[2].lines.length &&
        broken.body.changes.every((l) => l.project_id !== "p3-c") &&
        broken.body.changes.length === small[0].lines.length + small[1].lines.length,
      `⑤ 摘除后 total 与窗口口径一致（total=${broken.body.total}，p3-a/p3-b 的 ${small[0].lines.length + small[1].lines.length} 行照常返回）`,
    );
    writeChanges(small[2], small[2].lines); // 还原
    const restored = await getAll(base, "?limit=200");
    ok(
      restored.body.total === expectedSmall.length && restored.body.errors.length === 0,
      `⑤ 坏行修好后自行恢复（total 回到 ${expectedSmall.length}，errors 清空）`,
    );

    // ── ⑦ 10 万行压测 ──
    info(`③ DoD③：10 万行压测（${big.length} 个项目 × ${BIG_PER} 行）`);
    const tWrite = Date.now();
    for (const p of big) writeChanges(p, p.lines);
    const bytes = big.reduce(
      (s, p) => s + fs.statSync(path.join(p.root, ".工作台", "changes.jsonl")).size,
      0,
    );
    const expectedTotal = expectedSmall.length + big.length * BIG_PER;
    console.log(
      `[verify]   夹具落盘：${big.length * BIG_PER} 行 / ${(bytes / 1048576).toFixed(1)} MB / 写盘 ${Date.now() - tWrite}ms`,
    );

    const rssBefore = processRssKb(backend.proc.pid!);
    const cold = await getAll(base, "?limit=200&offset=0");
    const page2 = await getAll(base, "?limit=200&offset=4000");
    const filteredBig = await getAll(base, "?limit=200&project_id=p3-big-3");
    const warm = await getAll(base, "?limit=200&offset=0");
    ok(
      cold.body.total === expectedTotal && cold.body.changes.length === 200,
      `③ total 精确 = ${expectedTotal}（实际 ${cold.body.total}）`,
    );
    console.log(
      `[verify]   首屏(冷) 客户端 ${cold.ms}ms / 服务端 ${cold.body.stats.ms}ms（计数 ${cold.body.stats.count_ms} + 归并 ${cold.body.stats.merge_ms}）/ 响应 ${cold.bytes} 字节`,
    );
    console.log(
      `[verify]   首屏(热) 客户端 ${warm.ms}ms / 服务端 ${warm.body.stats.ms}ms（缓存命中源 ${warm.body.stats.cached_sources}/${warm.body.stats.sources}）`,
    );
    console.log(
      `[verify]   翻页 offset=4000 客户端 ${page2.ms}ms / 服务端 ${page2.body.stats.ms}ms（归并 ${page2.body.stats.merge_ms}）`,
    );
    console.log(
      `[verify]   过滤 project_id=p3-big-3 客户端 ${filteredBig.ms}ms / 服务端 ${filteredBig.body.stats.ms}ms（total=${filteredBig.body.total}，单源）`,
    );
    ok(
      cold.body.stats.ms < 1500 && page2.body.stats.ms < 500 && filteredBig.body.stats.ms < 500,
      `③ 三种耗时都远低于阈值（首屏 ${cold.body.stats.ms}ms < 1500 / 翻页 ${page2.body.stats.ms}ms < 500 / 过滤 ${filteredBig.body.stats.ms}ms < 500）`,
    );
    ok(
      page2.body.changes[0].ts === cold.body.changes[199].ts ||
        Date.parse(page2.body.changes[0].ts) <= Date.parse(cold.body.changes[199].ts),
      "③ 翻页边界无交错：第 2 段首条不晚于第 1 段末条（同一全局序的连续切片）",
    );

    // 连翻 60 页（UI「加载更多」会走到的最深翻页）：既验页与页之间不重不漏，也给 RSS 前后对比留出痕迹
    const tPages = Date.now();
    let contiguous = true;
    let prevLastKey = "";
    for (let i = 0; i < 60; i++) {
      const r = await getAll(base, `?limit=200&offset=${i * 200}`);
      if (r.body.changes.length !== 200) contiguous = false;
      const keys = r.body.changes.map((l) => `${l.ts}|${l.project_id}|${l.path}`);
      if (new Set(keys).size !== keys.length) contiguous = false; // 页内重复
      if (i > 0 && keys[0] === prevLastKey) contiguous = false; // 与上一页末条重叠
      prevLastKey = keys[keys.length - 1];
    }
    console.log(`[verify]   连翻 60 页（200/页，共 1.2 万行）耗时 ${Date.now() - tPages}ms`);
    ok(contiguous, "③ 连翻 60 页每页都满 200 行、页内无重复、页间无重叠（同一条流水不出现两次）");
    const deep = await getAll(base, "?limit=200&offset=99800");
    console.log(
      `[verify]   深翻 offset=99800 客户端 ${deep.ms}ms / 服务端 ${deep.body.stats.ms}ms（顺流丢弃，内存不变、I/O 变多——UI 走逐页追加，不出现）`,
    );
    ok(
      deep.body.changes.length === 200 && Date.parse(deep.body.changes[0].ts) < Date.parse(cold.body.changes[0].ts),
      "③ 深翻返回的确实是 10 万行里最旧那一段（窗口读没把「越界」当「没数据」）",
    );
    const rssAfter = processRssKb(backend.proc.pid!);
    console.log(
      `[verify]   服务端进程工作集：压测前 ${rssBefore === null ? "?" : (rssBefore / 1024).toFixed(1)}MB → 压测后 ${rssAfter === null ? "?" : (rssAfter / 1024).toFixed(1)}MB（夹具 ${(bytes / 1048576).toFixed(1)}MB / 10 万行）`,
    );
    ok(
      rssBefore !== null && rssAfter !== null && rssAfter - rssBefore < 64 * 1024,
      `③ 服务端工作集增量 ${rssBefore !== null && rssAfter !== null ? ((rssAfter - rssBefore) / 1024).toFixed(1) : "?"}MB < 64MB（不随 10 万行长起来）`,
    );

    // ── ⑧ 内存对照探针（窗口读 vs 全量读 + sort） ──
    const probe = runMemProbe(home);
    if (probe) {
      console.log(
        `[verify]   内存对照（--expose-gc 子进程，堆占用）：窗口读 60 页 +${probe.window_mb}MB ｜ 同一个夹具全量读+sort（红线做法）+${probe.full_mb}MB（${probe.rows} 行）`,
      );
      ok(
        probe.full_mb > probe.window_mb,
        `③ 全量读的堆占用 ${probe.full_mb}MB 明显高于窗口读 ${probe.window_mb}MB（跑偏点做法确实会随数据量长大）`,
      );
    } else {
      ok(false, "③ 内存对照探针跑失败（见上方报错）");
    }

    // ── ⑨ 源码级护栏 ──
    checkSourceGuards();

    // ── ⑩ UI 段 ──
    info("⑥ UI（playwright）：全局流 / 滚动 / 过滤 / 行内详情");
    const specPath = path.join(VERIFY_DIR, "p3-spec.json");
    fs.mkdirSync(VERIFY_DIR, { recursive: true });
    fs.writeFileSync(
      specPath,
      JSON.stringify(
        {
          total: expectedTotal,
          filter_project_id: "p3-big-3",
          filter_project_name: "大夹具3",
          filter_total: BIG_PER,
          h3_path_filter: "mod1/",
          // 期望的过滤后条数由脚本从夹具现算（不写死数字）：p3-big-3 的路径里含 mod1/ 的行数
          h3_path_total: big[3].lines.filter((l) => l.path.includes("mod1/")).length,
        },
        null,
        2,
      ),
      "utf8",
    );
    await uiPlaywright(specPath, backend);
  } finally {
    if (backend) {
      killTree(backend.proc, backend.port);
      await sleep(600);
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  console.log("\n[verify] ── 收尾：进程杀净 / 端口释放 / 8787+5173 仍是别人的");
  ok(!(await portListening(backendPort)), `收尾：后端动态端口 ${backendPort} 已释放（进程杀净）`);
  const fixedAfter = { v: await portListening(8787), d: await portListening(5173) };
  ok(
    fixedBefore.v === fixedAfter.v && fixedBefore.d === fixedAfter.d,
    `收尾：8787/5173 状态与开工前一致（${fixedAfter.v ? "有人在用" : "空闲"} / ${fixedAfter.d ? "有人在用" : "空闲"}）——本脚本没占用、没杀 PID`,
  );
  // 落盘自查（AGENTS.md §6 开源红线）：临时脚本/截图/夹具一律落在 gitignore 的 .工作台/ 里，
  // 仓库工作区里不许出现 .工作台 条目（夹具在 os.tmpdir()，跑完已删）
  let workbenchInGit = "（git status 未取到）";
  try {
    workbenchInGit = execSync("git status --porcelain", { cwd: REPO_ROOT, encoding: "utf8" })
      .split(/\r?\n/)
      .filter((l) => l.includes("工作台"))
      .join(" | ");
  } catch {
    // 取不到就不假装有结论
  }
  ok(
    fs.existsSync(path.join(VERIFY_DIR, "p3-shot.py")) && workbenchInGit === "",
    `收尾：一次性脚本只落 gitignore 的 .工作台/verify/，git status 里零 .工作台 条目（实际：${workbenchInGit || "无"}）`,
  );
}

/** 只用于类型标注：全局流的一行（避免在脚本里再抄一份类型） */
type GlobalChangeLineLike = GlobalChangesResult["changes"][number];

main()
  .then(() => console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS"))
  .catch((e) => {
    console.error("[verify] 异常:", e);
    process.exitCode = 1;
  });
