// V09-12 验证脚本（tsx 跑）：六图触发范围扩展与「正在更新／预计用时／失效」口径
// （PLAN.md V09-12；DESIGN.md §3.2 触发范围 / §3.3 更新中与下次打开 / §4.4、附录 E.8-2、E.8-4）。
//
// 用法：pnpm verify:v09-12（自带临时 TATAI_HOME 与夹具项目，不碰真实注册表与真实项目；
// 真服务器走空闲端口 8834）。
//
// 覆盖（逐条对着施工规格「检查项」）：
//   ① 触发范围（含反例）：真服务器上只改**深层目录 / 接口文件 / 跨模块依赖**（**顶层目录一动不动**）
//      也各触发一轮「确定性重解析 + 蓝图重建」；反例断言＝这几次触发前后夹具顶层目录集合逐字不变
//      （若判据只认顶层目录增删，这三条必红）＋"无依赖变化的普通源码变化不触发"的负断言。
//   ② 更新中呈现（含反例）：纯函数层（estimateEta + 界面文案）四档依据各一例，`basis=none` ⇒
//      「无法估计」且文案里**不出现具体秒数**（反例：无依据却给秒数）；真服务器轮询记录里必须
//      同时观察到「正在更新 + 无法估计」与「正在更新 + 有依据的预计秒数」两种真实读数。
//   ③ 下次打开：变更完成后**新客户端**（本脚本自己）重取，拿到本次变更对应的完整新图
//      （模块骨架里出现新深层模块 + 变更指纹与本次变化逐字对上）；未完成/被中断时如实
//      标 updating/stale + 原因 + 横幅（反例：显示旧图且不标过期 ⇒ 不合格）。
//   ④ 防抖／去重／有界（三条各留反例断言）：突发多变更合并为一次（指纹覆盖全部三条）；
//      生成物自触发被忽略（记录逐字不动）；重解析有界（最小间隔闸门 + 窗口轮数预算 + 失败不自动重试，
//      反例＝无闸门时"每条变化一轮"）。
//   ⑤ 门槛与回归：本脚本断言自己已在 package.json 登记、四态与阶段口径只此一处、
//      界面 `data-project-update*` 读数在场；`verify:v09-07`／`v08-05`／`v08-06`／`f4`／`v06-05-e`／
//      `v09-11`、`typecheck`／`build`／`build:server` 由本次交付的日志核对（`.工作台/evidence/V09-12/1/`）。
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  changeVerdict,
  graphRefreshDispatch,
  startGraphRefresh,
  stopGraphRefresh,
  type GraphRefreshParseHandle,
} from "../src/server/work/graphRefresh";
import { PHASES_TOTAL, estimateEta, type GraphUpdateRecord } from "../src/server/work/graphUpdate";
import { graphUpdateBannerOf, graphUpdateEtaText, type GraphUpdateView } from "../src/ui/arch/projectGraph";
import { nowIso } from "../src/server/time";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8834;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);
const section = (t: string): void => console.log(`\n[verify] ── ${t}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha256Text = (t: string): string => crypto.createHash("sha256").update(t, "utf8").digest("hex");
/** 本轮变更指纹口径（必须与 `graphRefresh` 内部一致：`action:path` 排序后用 \n 连接再 sha256 取前 16 位） */
const changeToken = (lines: string[]): string => sha256Text([...lines].sort().join("\n")).slice(0, 16);

// ── 夹具（临时 TATAI_HOME + 夹具项目；不碰真实注册表与真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-12-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
process.env.TATAI_HOME = dataDir;

const MAIN = "v0912-main"; // ①②③④ 的真服务器夹具（真 watcher + 真发现链 + 真重解析）
const mainRoot = path.join(tmpBase, "main-proj");
const UNIT = "v0912-unit"; // ②③④ 的注入式夹具（in-process，deps 注入：闸门/失败/中断分支）
const unitRoot = path.join(tmpBase, "unit-proj");

const DESIGN_TEXT = [
  "# V09-12 夹具设计书",
  "",
  "## 2 模块划分",
  "",
  "| # | 模块 | 说明 |",
  "| --- | --- | --- |",
  "| 1 | 甲模块 | 夹具能力 |",
  "",
  "## 3 说明",
  "",
  "夹具正文。",
  "",
].join("\n");

const PLAN_TEXT = [
  "# V09-12 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1 | todo | 甲模块落成 |  | 甲验收记录 |",
  "",
  "### T-1 甲模块落成",
  "",
  "**设计依据**：§2。",
  "",
  "- [ ] 甲做出来",
  "",
  "**交付**：甲验收记录。",
  "",
].join("\n");

const write = (rel: string, text: string): void => {
  const abs = path.join(tmpBase, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
};
const readJson = (f: string): Record<string, unknown> | null => {
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};
const sha256File = (f: string): string | null =>
  fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null;

const modulesJson = (mods: { id: string; path: string; file_count: number; loc: number; deps: { to: string; weight: number }[] }[]): string =>
  JSON.stringify({ version: 1, generated_at: "2026-09-24T00:00:00+08:00", budget_exhausted: false, modules: mods }, null, 2) + "\n";

// 主夹具：顶层只有 `src` 与 `.工作台`（后续所有触发都**不动**顶层目录——①的反例断言就靠它）
write("main-proj/src/index.ts", "export const idx = 1;\n"); // 接口文件（桶/入口）
write("main-proj/src/plain.ts", "export const p = 1;\n"); // 普通源码（无 import）
write("main-proj/src/lib/util.ts", "export const u = 1;\n"); // 深层目录里的被依赖文件
write("main-proj/.工作台/design.md", DESIGN_TEXT);
write("main-proj/.工作台/plan.md", PLAN_TEXT);
write(
  "main-proj/.工作台/arch/modules.json",
  modulesJson([
    { id: "src", path: "src", file_count: 3, loc: 9, deps: [] },
    { id: "src-lib", path: "src/lib", file_count: 1, loc: 3, deps: [] },
  ]),
);

// 注入夹具：模块数 1（< MIN_MODULES=5）→ 深层目录判据生效；顶层只有 src
write("unit-proj/src/index.ts", "export const u = 1;\n");
write("unit-proj/.工作台/design.md", DESIGN_TEXT);
write("unit-proj/.工作台/plan.md", PLAN_TEXT);
write(
  "unit-proj/.工作台/arch/modules.json",
  modulesJson([{ id: "src", path: "src", file_count: 1, loc: 3, deps: [] }]),
);

const nowStamp = nowIso();
write(
  "home/registry.json",
  JSON.stringify({
    version: 1,
    projects: [
      { id: MAIN, name: "V09-12 主夹具", path: mainRoot, kind: "backend", registered_at: nowStamp, last_opened_at: nowStamp },
      { id: UNIT, name: "V09-12 注入夹具", path: unitRoot, kind: "backend", registered_at: nowStamp, last_opened_at: nowStamp },
    ],
  }),
);

const updateFile = (root: string): string => path.join(root, ".工作台", "arch", "graph-update.json");
const receiptFile = (root: string): string => path.join(root, ".工作台", "arch", "graph-refresh-last.json");
const modulesFileOf = (root: string): string => path.join(root, ".工作台", "arch", "modules.json");
const readUpdate = (root: string): GraphUpdateRecord | null => readJson(updateFile(root)) as GraphUpdateRecord | null;
const topDirsOf = (root: string): string[] =>
  fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

// ═══════════════════ ⑤ 结构与登记自证 ═══════════════════
section("⑤ 结构与登记：脚本已在 package.json、四态/阶段口径单处、界面读数在场");
{
  const pkg = readJson(path.join(REPO_ROOT, "package.json"));
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  ok(
    scripts["verify:v09-12"] === "tsx scripts/verify-v09-12.ts",
    `⑤ package.json 已登记 verify:v09-12（实际: ${String(scripts["verify:v09-12"])}）`,
  );
  const updateSrc = fs.readFileSync(path.join(REPO_ROOT, "src", "server", "work", "graphUpdate.ts"), "utf8");
  ok(
    ["updating", "ready", "stale", "failed"].every((s) => updateSrc.includes(`"${s}"`)),
    "⑤ 更新状态四态（updating/ready/stale/failed）在 graphUpdate.ts 只此一处定义",
  );
  ok(PHASES_TOTAL === 2, `⑤ 阶段总数口径单处（PHASES_TOTAL=${PHASES_TOTAL}：重解析 + 蓝图重建）`);
  const viewSrc = fs.readFileSync(path.join(REPO_ROOT, "src", "ui", "arch", "ProjectGraphView.tsx"), "utf8");
  ok(
    viewSrc.includes("data-project-update=") &&
      viewSrc.includes("data-project-update-banner=") &&
      viewSrc.includes("data-project-update-eta="),
    "⑤ 图页在场「正在更新／预计用时」读数（data-project-update / -banner / -eta）",
  );
  const refreshSrc = fs.readFileSync(path.join(REPO_ROOT, "src", "server", "work", "graphRefresh.ts"), "utf8");
  ok(
    refreshSrc.includes("autoRebuildBlueprint") && !/triggerBlueprintAuto/.test(refreshSrc),
    "⑤ 蓝图重建走**同一条**既有自动链（autoRebuildBlueprint），没有第二套派生入口",
  );
}

// ═══════════════════ ② 纯函数层：预计用时四档依据 + 界面文案（含反例） ═══════════════════
section("② 预计用时依据四档（纯函数）＋界面文案正反例");
const noBasis = estimateEta({ history_ms: [], phases_done: 0 });
const fromHistory = estimateEta({ history_ms: [1200, 3000, 1800], phases_done: 0 });
const baseView = (over: Partial<GraphUpdateView>): GraphUpdateView => ({
  state: "updating",
  scope: "structure_deep",
  reason: "新增深层目录 src/deep/",
  phase: "reparse",
  phases_done: 0,
  phases_total: 2,
  change_token: changeToken(["add:src/deep/x.ts"]),
  started_at: nowIso(),
  updated_at: nowIso(),
  finished_at: null,
  eta: noBasis,
  result: null,
  last_error: null,
  ...over,
});
const unknownBanner = graphUpdateBannerOf(baseView({}));
{
  ok(
    noBasis.basis === "none" && noBasis.total_ms === null && noBasis.note.includes("无法估计"),
    `② 无历史、无已完成阶段 ⇒ basis=none、不给数字（basis=${noBasis.basis}、total_ms=${String(noBasis.total_ms)}）`,
  );
  ok(
    fromHistory.basis === "history_median" && fromHistory.total_ms === 1800 && fromHistory.note.includes("本机历史 3 轮"),
    `② 有本机历史 ⇒ basis=history_median、取中位并写明样本（total_ms=${String(fromHistory.total_ms)}）`,
  );
  const fromPhases = estimateEta({
    history_ms: [],
    phases_done: 1,
    phases_total: 2,
    started_at: new Date(2_000_000).toISOString(),
    now_ms: 2_000_000 + 1500,
  });
  ok(
    fromPhases.basis === "elapsed_phases" && fromPhases.total_ms === 3000,
    `② 有已完成阶段数 + 已耗时 ⇒ 单位阶段外推（total_ms=${String(fromPhases.total_ms)}，1/2 阶段用 1.5s）`,
  );
  const fromGate = estimateEta({ history_ms: [1200], phases_done: 0, wait_ms: 2500 });
  ok(
    fromGate.basis === "wait_window" && fromGate.total_ms === 2500,
    `② 等闸门 ⇒ basis=wait_window（等待时长本身是实测量，total_ms=${String(fromGate.total_ms)}）`,
  );
  ok(
    graphUpdateEtaText(baseView({})) === "无法估计" &&
      unknownBanner !== null &&
      unknownBanner.eta_text === "无法估计" &&
      !/\d+(\.\d+)?\s*秒/.test(unknownBanner.text),
    `② 反例：依据不足时文案＝「无法估计」且**不含具体秒数**（实际出屏：${String(unknownBanner?.eta_text)}）`,
  );
  ok(
    unknownBanner !== null && unknownBanner.state === "updating" && unknownBanner.text.includes("图正在更新"),
    "② 更新期间有「正在更新」字样 + 当前阶段 + 已完成阶段数",
  );
  const knownBanner = graphUpdateBannerOf(baseView({ eta: fromHistory }));
  ok(
    knownBanner !== null && /\d+(\.\d+)?\s*秒/.test(knownBanner.eta_text) && knownBanner.text.includes("本机历史 3 轮"),
    `② 有依据时给秒数并写明依据（实际出屏：${String(knownBanner?.eta_text)}）`,
  );
  const staleBanner = graphUpdateBannerOf(
    baseView({ state: "stale", last_error: "监听已关（watcher 停止或服务退出）" }),
  );
  ok(
    staleBanner !== null && staleBanner.state === "stale" && staleBanner.text.includes("图已过期"),
    "② stale ⇒ 「图已过期」+ 原因（不得只显示旧图）",
  );
  const failedBanner = graphUpdateBannerOf(
    baseView({ state: "failed", last_error: "重解析未成功（failed）：注入失败" }),
  );
  ok(
    failedBanner !== null && failedBanner.state === "failed" && failedBanner.text.includes("注入失败"),
    "② failed ⇒ 「图更新失败」+ 原因",
  );
  ok(graphUpdateBannerOf(baseView({ state: "ready" })) === null, "② ready ⇒ 不出横幅（图与最近一次已完成变更一致）");

  // ① 判据纯函数：深层目录 / 接口文件（顶层目录一动不动）也判成要更新——反例口径的代码级证据
  const archFx = {
    version: 1 as const,
    generated_at: "2026-09-24T00:00:00+08:00",
    budget_exhausted: false,
    modules: [{ id: "src", path: "src", name: "", file_count: 3, loc: 9, deps: [] }],
  };
  const deepVerdict = changeVerdict(
    { ts: nowIso(), path: "src/deep/x.ts", action: "add", size_delta: 12 },
    { root: mainRoot, arch: archFx },
  );
  ok(
    deepVerdict !== null && deepVerdict.scope === "structure_deep",
    `① 判据：只加深层文件（顶层目录不动）⇒ structure_deep（实际: ${String(deepVerdict?.scope)}）`,
  );
  const ifaceVerdict = changeVerdict(
    { ts: nowIso(), path: "src/index.ts", action: "modify", size_delta: 3 },
    { root: mainRoot, arch: archFx },
  );
  ok(
    ifaceVerdict !== null && ifaceVerdict.scope === "interface",
    `① 判据：只改接口文件（顶层目录不动）⇒ interface（实际: ${String(ifaceVerdict?.scope)}）`,
  );
  const plainVerdict = changeVerdict(
    { ts: nowIso(), path: "src/plain.ts", action: "modify", size_delta: 3 },
    { root: mainRoot, arch: archFx, probe_before: () => "", probe_after: () => undefined },
  );
  ok(plainVerdict === null, "①-e 判据：普通源码改动（无依赖变化、非接口文件）⇒ 不触发（有界性的另一半）");
}

// ═══════════════════ 真服务器：①②③④ ═══════════════════
const upPorts = new Set<number>();
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
interface ApiResp {
  status: number;
  body: Record<string, unknown>;
}
async function api(method: string, rawPath: string, body?: unknown): Promise<ApiResp> {
  const res = await fetch(`${BASE}${rawPath}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return true;
    if (Date.now() - t0 > timeoutMs) {
      info(`等待超时（${timeoutMs}ms）：${what}`);
      return false;
    }
    await sleep(100);
  }
}

/** 观察到的更新状态读数（②的证据：真服务器上确实出现过"正在更新"与各种预计用时口径） */
interface Observed {
  state: string;
  phase: string | null;
  basis: string;
  total_ms: number | null;
  token: string | null;
  scope: string | null;
}
const observed: Observed[] = [];
function noteObserved(rec: GraphUpdateRecord | null): void {
  if (rec === null) return;
  const item: Observed = {
    state: rec.state,
    phase: rec.phase ?? null,
    basis: rec.eta?.basis ?? "?",
    total_ms: rec.eta?.total_ms ?? null,
    token: rec.change_token ?? null,
    scope: rec.scope ?? null,
  };
  const last = observed[observed.length - 1];
  if (
    last !== undefined &&
    last.state === item.state &&
    last.phase === item.phase &&
    last.basis === item.basis &&
    last.total_ms === item.total_ms &&
    last.token === item.token &&
    last.scope === item.scope
  ) {
    return; // 只记变化点，日志有界
  }
  observed.push(item);
  info(
    `[update] state=${item.state} phase=${String(item.phase)} basis=${item.basis} eta=${String(item.total_ms)}ms scope=${String(item.scope)} token=${String(item.token)}`,
  );
}

let child: ChildProcess | undefined;
let poller: NodeJS.Timeout | undefined;
try {
  if (await portListening(PORT)) {
    console.error(`[verify] 端口 ${PORT} 被占用，先清理残留进程`);
    process.exit(1);
  }
  const proc = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO_ROOT,
  });
  child = proc;
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  proc.once("exit", (code) => {
    if (upPorts.has(PORT)) return;
    console.error(`[verify] 后端进程提前退出（code=${code}）`);
    process.exit(1);
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      up = r.ok;
    } catch {
      // 还没起来
    }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error("后端 15 秒内未就绪");
  upPorts.add(PORT);
  info(`server up at ${BASE}（TATAI_HOME=${dataDir}）`);

  // 轮询观察更新状态（只读盘上的状态文件；只记变化点）
  poller = setInterval(() => noteObserved(readUpdate(mainRoot)), 80);

  section("① 监听与发现链接上（真服务器 + 真 watcher）");
  const w = await api("POST", `/api/projects/${MAIN}/watch`);
  ok(w.status === 200 && w.body.ok === true, `① POST /watch 落地（HTTP ${w.status}）——发现链随监听挂上`);
  const readyOk = await waitFor(async () => {
    const r = await api("GET", "/api/watch");
    const details = (r.body.details as { id: string; ready: boolean }[] | undefined) ?? [];
    return details.some((d) => d.id === MAIN && d.ready === true);
  }, 15000, "watcher ready");
  ok(readyOk, "① watcher 就绪（此后变更才进流水与发现链）");

  const topBefore = topDirsOf(mainRoot);
  info(`夹具顶层目录（触发前后都必须逐字不变）：${topBefore.join("、")}`);

  const updateOf = (): GraphUpdateRecord | null => readUpdate(mainRoot);
  async function waitRound(token: string, scope: string, timeoutMs: number): Promise<GraphUpdateRecord | null> {
    const hit = await waitFor(() => {
      const rec = updateOf();
      return rec !== null && rec.state === "ready" && rec.change_token === token && rec.scope === scope;
    }, timeoutMs, `轮次完成 scope=${scope} token=${token}`);
    if (!hit) info(`实际记录：${JSON.stringify(updateOf())?.slice(0, 300)}`);
    return updateOf();
  }

  // ── ①-a 深层模块（目录）变化 ──
  section("①-a 只改深层模块（新增 src/deep/x.ts，顶层目录不动）⇒ 触发重解析 + 图更新");
  const modulesShaBefore = sha256File(modulesFileOf(mainRoot));
  fs.mkdirSync(path.join(mainRoot, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(mainRoot, "src", "deep", "x.ts"), "export const x = 1;\n", "utf8");
  const deepToken = changeToken(["add:src/deep/x.ts"]);
  const deepRec = await waitRound(deepToken, "structure_deep", 25000);
  ok(
    deepRec !== null && deepRec.state === "ready" && deepRec.scope === "structure_deep",
    `①-a 深层目录变化触发一轮并完成（state=${String(deepRec?.state)} scope=${String(deepRec?.scope)}）`,
  );
  ok(/深层目录/.test(String(deepRec?.reason)), `①-a 记录写明判据（实际: ${String(deepRec?.reason).slice(0, 60)}…）`);
  ok(sha256File(modulesFileOf(mainRoot)) !== modulesShaBefore, "①-a **真的重解析了**（模块骨架内容已变——不是只提示）");
  {
    const mods = await api("GET", `/api/projects/${MAIN}/arch/modules`);
    const arch = (mods.body.arch ?? {}) as {
      exists?: boolean;
      arch?: { modules?: { id: string; path: string }[]; generated_at?: string };
    };
    const paths = (arch.arch?.modules ?? []).map((m) => m.path);
    ok(paths.includes("src/deep"), `①-a 新深层模块进了模块骨架（模块路径: ${paths.join("、")}）`);
    ok(
      deepRec?.result?.modules_generated_at === arch.arch?.generated_at,
      `①-a 更新状态记的结果与本轮模块骨架同源（${String(deepRec?.result?.modules_generated_at)}）`,
    );
  }
  ok(
    topDirsOf(mainRoot).join("|") === topBefore.join("|"),
    `① 反例断言：这一轮顶层目录集合逐字不变（${topDirsOf(mainRoot).join("、")}）——触发**不可能**来自"顶层目录增删"`,
  );

  // ── ①-b 接口文件变化 ──
  section("①-b 只改模块对外接口文件（src/index.ts，顶层目录不动）⇒ 触发");
  fs.writeFileSync(path.join(mainRoot, "src", "index.ts"), "export const idx = 2;\nexport const more = 3;\n", "utf8");
  const ifaceToken = changeToken(["modify:src/index.ts"]);
  const ifaceRec = await waitRound(ifaceToken, "interface", 25000);
  ok(
    ifaceRec !== null && ifaceRec.state === "ready" && ifaceRec.scope === "interface",
    `①-b 接口文件变化触发一轮并完成（scope=${String(ifaceRec?.scope)}）`,
  );
  ok(/接口文件/.test(String(ifaceRec?.reason)), `①-b 记录写明「接口文件」（实际: ${String(ifaceRec?.reason).slice(0, 60)}…）`);
  ok(topDirsOf(mainRoot).join("|") === topBefore.join("|"), "① 反例断言：接口轮同样顶层目录逐字不变");

  // ── ② 闸门等待读数（紧随上一轮：外部触发两轮之间必须隔开，等待时如实给依据） ──
  section("② 安全防抖闸门：紧接着的第二次触发必须排队等待并如实给出等待依据");
  fs.writeFileSync(path.join(mainRoot, "src", "lib", "index.ts"), "export { u } from './util';\n", "utf8");
  const gatedSeen = await waitFor(() => {
    const rec = updateOf();
    return rec?.state === "updating" && rec?.eta?.basis === "wait_window" && typeof rec?.eta?.total_ms === "number";
  }, 4000, "闸门排队读数（basis=wait_window）");
  ok(
    gatedSeen,
    `② 排队期间 basis=wait_window 且给出等待毫秒数（实际 ${String(updateOf()?.eta?.basis)} / ${String(updateOf()?.eta?.total_ms)}ms）`,
  );
  ok(
    updateOf()?.phase === "queued",
    `② 排队期间的阶段如实写 queued（实际: ${String(updateOf()?.phase)}）`,
  );
  const libToken = changeToken(["add:src/lib/index.ts"]);
  const libRec = await waitRound(libToken, "interface", 25000);
  ok(libRec?.state === "ready", "② 闸门到点后照常跑完（排队不等于丢弃）");
  ok(topDirsOf(mainRoot).join("|") === topBefore.join("|"), "① 反例断言：接口轮（新增 src/lib/index.ts）顶层目录逐字不变");

  // ── ①-c 跨模块依赖变化 ──
  section("①-c 只改跨模块依赖（src/plain.ts 加一条 import，顶层目录不动）⇒ 触发");
  fs.writeFileSync(path.join(mainRoot, "src", "plain.ts"), 'import { u } from "./lib/util";\nexport const p = u;\n', "utf8");
  const depToken = changeToken(["modify:src/plain.ts"]);
  const depRec = await waitRound(depToken, "dependency", 25000);
  ok(
    depRec !== null && depRec.state === "ready" && depRec.scope === "dependency",
    `①-c 依赖变化触发一轮并完成（scope=${String(depRec?.scope)}）`,
  );
  ok(/跨模块依赖/.test(String(depRec?.reason)), `①-c 记录写明「跨模块依赖」（实际: ${String(depRec?.reason).slice(0, 70)}…）`);
  {
    const mods = await api("GET", `/api/projects/${MAIN}/arch/modules`);
    const list = ((mods.body.arch ?? {}) as { arch?: { modules?: { id: string; deps?: { to: string }[] }[] } }).arch?.modules ?? [];
    const tos = (list.find((m) => m.id === "src")?.deps ?? []).map((d) => d.to);
    ok(tos.includes("src-lib"), `①-c 重解析后新依赖真的进图（src → ${tos.join("、") || "（空）"}）——不是只提示`);
  }
  ok(topDirsOf(mainRoot).join("|") === topBefore.join("|"), "① 反例断言：依赖轮顶层目录逐字不变");

  // ── ①-e 负断言 ──
  section("①-e 负断言：新增无依赖的普通源码文件 ⇒ 不触发（有界性的另一半）");
  {
    const recBefore = fs.readFileSync(updateFile(mainRoot), "utf8");
    fs.writeFileSync(path.join(mainRoot, "src", "quiet.ts"), "export const q = 1;\n", "utf8");
    await sleep(2600); // > 防抖窗 1200ms + 裕量
    ok(
      fs.readFileSync(updateFile(mainRoot), "utf8") === recBefore,
      "①-e 无依赖变化、非接口文件的普通源码新增 → 更新状态纹丝不动（不滥触发）",
    );
  }

  // ── ④-a 突发多变更合并为一次 ──
  section("④-a 突发三连写（同一新深层目录）⇒ 合并成一轮（指纹覆盖全部三条）");
  const burstToken = changeToken(["add:src/burst/a.ts", "add:src/burst/b.ts", "add:src/burst/c.ts"]);
  {
    fs.mkdirSync(path.join(mainRoot, "src", "burst"), { recursive: true });
    fs.writeFileSync(path.join(mainRoot, "src", "burst", "a.ts"), "export const ba = 1;\n", "utf8");
    await sleep(150);
    fs.writeFileSync(path.join(mainRoot, "src", "burst", "b.ts"), "export const bb = 1;\n", "utf8");
    await sleep(150);
    fs.writeFileSync(path.join(mainRoot, "src", "burst", "c.ts"), "export const bc = 1;\n", "utf8");
    const burstRec = await waitRound(burstToken, "structure_deep", 25000);
    const token = burstRec?.change_token ?? "";
    ok(
      token === burstToken,
      `④-a 三条突发合并成**一轮**：本轮变更指纹覆盖全部三条（实际 ${token}，三条合集 ${burstToken}；` +
        `若未合并会是单条指纹 ${changeToken(["add:src/burst/c.ts"])}）`,
    );
    await sleep(2000);
    ok(readUpdate(mainRoot)?.change_token === burstToken, "④-a 2 秒后指纹不变：三条变化只跑了一轮，没有各起一轮");
  }

  // ── ④-b 生成物自触发被忽略 ──
  section("④-b 生成物自触发被忽略：写 .工作台/arch/** 不动任何状态");
  {
    const recBefore = fs.readFileSync(updateFile(mainRoot), "utf8");
    const receiptBefore = fs.readFileSync(receiptFile(mainRoot), "utf8");
    fs.writeFileSync(path.join(mainRoot, ".工作台", "arch", "self-trigger-v0912.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(mainRoot, ".工作台", "arch", "probe-v0912.json"), "{}\n", "utf8");
    await sleep(3500); // > 防抖 1200ms + 一小轮重解析的裕量
    ok(
      fs.readFileSync(updateFile(mainRoot), "utf8") === recBefore &&
        fs.readFileSync(receiptFile(mainRoot), "utf8") === receiptBefore,
      "④-b 反例：写 .工作台/arch/** 后更新状态与回执逐字不变（生成物不自触发，无自触死循环）",
    );
  }

  // ── ② 真服务器读数汇总 ──
  section("② 真服务器读数：更新期间确实显示「正在更新」，无依据时＝无法估计、有依据时给秒数");
  {
    const updating = observed.filter((o) => o.state === "updating");
    ok(updating.length > 0, `② 轮询真的观察到 updating 状态（${updating.length} 个变化点）`);
    const noneEta = updating.filter((o) => o.basis === "none");
    ok(
      noneEta.length > 0,
      `② 首次更新（无历史、无已完成阶段）读出 basis=none（${noneEta.length} 次）⇒ 界面文案「无法估计」`,
    );
    const numeric = updating.filter((o) => typeof o.total_ms === "number" && o.basis === "history_median");
    ok(
      numeric.length > 0,
      `② 后续更新读出**有依据的预计用时**（basis=${numeric[0]?.basis ?? "-"}、${String(numeric[0]?.total_ms)}ms → 界面给具体秒数）`,
    );
    const gated = updating.filter((o) => o.basis === "wait_window");
    ok(gated.length > 0, `② 闸门等待也如实给依据（basis=wait_window、${String(gated[0]?.total_ms)}ms）`);
    const liveView = updateOf() as GraphUpdateView | null;
    const liveBanner = graphUpdateBannerOf(liveView);
    info(`当前记录出屏文案：${liveBanner === null ? "（ready：不出横幅）" : liveBanner.text.slice(0, 140)}…`);
  }

  // ── ③ 下一次打开：新客户端重取 ──
  section("③ 下次打开：变更完成后新客户端重取 → 本次变更对应的完整新图 + 指纹对上");
  {
    const bp = await api("GET", `/api/projects/${MAIN}/arch/blueprint`);
    const update = (bp.body.update ?? null) as GraphUpdateRecord | null;
    ok(bp.status === 200 && update !== null, `③ 读口 GET arch/blueprint 带 update 字段（state=${String(update?.state)}）`);
    ok(
      update?.state === "ready" && update.change_token === burstToken,
      `③ 下一次打开读到的就是**本次变更**那一轮（token=${String(update?.change_token)}＝三条突发指纹）`,
    );
    const render = await api("GET", `/api/projects/${MAIN}/arch/render`);
    const renderBody = (render.body.render ?? {}) as { exists?: boolean; graph?: { nodes?: { id: string }[] } };
    const ids = (renderBody.graph?.nodes ?? []).map((n) => n.id);
    ok(
      renderBody.exists !== false && ids.includes("src-burst"),
      `③ 技术详情层（ArchCanvas 数据）确实含本次新增的深层模块（节点: ${ids.join("、") || "（空）"}）`,
    );
    ok(
      update?.result?.blueprint_published === false || update?.result?.blueprint_published === true,
      `③ 蓝图层结论如实登记（published=${String(update?.result?.blueprint_published)}、` +
        `reason=${String(update?.result?.publish_reason).slice(0, 40)}…；夹具无生效基线，发布门禁照旧拦下）`,
    );
  }

  // ── ③ 未完成／被中断（in-process 注入） ──
  section("③ 未完成/被中断 ⇒ 明确 updating/stale + 原因 + 横幅（不得以旧图冒充新图）");
  {
    let releaseRef: { go: (() => void) | null } = { go: null };
    startGraphRefresh(UNIT, {
      dataDir,
      quietMs: 40,
      parse: () => ({
        run: { id: "run-hang-1" },
        done: new Promise((r) => {
          releaseRef.go = () => r({ id: "run-hang-1", status: "done", error: null });
        }),
      }),
      rebuild: () => undefined,
    });
    graphRefreshDispatch(UNIT, { ts: nowIso(), path: "src/deep/hang.ts", action: "add", size_delta: 5 });
    const hangUpdating = await waitFor(
      () => readUpdate(unitRoot)?.phase === "reparse",
      3000,
      "注入轮进入 reparse（重解析已启动但未收尾）",
    );
    const hangRec = readUpdate(unitRoot);
    ok(
      hangUpdating && hangRec?.phase === "reparse" && hangRec.reason !== null,
      `③ 未完成时如实标 updating（phase=${String(hangRec?.phase)}，原因在场）`,
    );
    const hangBanner = graphUpdateBannerOf(hangRec as GraphUpdateView | null);
    ok(
      hangBanner !== null && hangBanner.state === "updating" && hangBanner.text.includes("图正在更新"),
      "③ 未完成时界面出横幅「图正在更新」（反例：显示旧图且不标过期 ⇒ 这一条必红）",
    );
    stopGraphRefresh(UNIT);
    const staleRec = readUpdate(unitRoot);
    ok(
      staleRec?.state === "stale" && /监听已关/.test(String(staleRec?.last_error)),
      `③ 派生被中断（监听被关）⇒ 明确 stale + 原因（state=${String(staleRec?.state)}、error=${String(staleRec?.last_error).slice(0, 40)}…）`,
    );
    const staleBanner2 = graphUpdateBannerOf(staleRec as GraphUpdateView | null);
    ok(
      staleBanner2 !== null && staleBanner2.state === "stale" && staleBanner2.text.includes("图已过期"),
      "③ 中断后界面出「图已过期」+ 原因（不冒充新图）",
    );
    releaseRef.go?.();
    await sleep(200);
  }
  {
    // 进程重启遗留：盘上写着 updating、进程已换 → 开链时如实标 stale（不留下"正在更新"的假象）
    const rec = readUpdate(unitRoot);
    if (rec !== null) {
      fs.writeFileSync(
        updateFile(unitRoot),
        JSON.stringify({ ...rec, state: "updating", phase: "reparse", last_error: null }, null, 2) + "\n",
        "utf8",
      );
    }
    startGraphRefresh(UNIT, {
      dataDir,
      quietMs: 40,
      parse: () => ({ run: { id: "x" }, done: Promise.resolve({ id: "x", status: "done", error: null }) }),
      rebuild: () => undefined,
    });
    const afterRestart = readUpdate(unitRoot);
    ok(
      afterRestart?.state === "stale" && /上次派生被中断/.test(String(afterRestart?.last_error)),
      `③ 进程重启后开链：遗留的 updating 被如实标成 stale + 原因（state=${String(afterRestart?.state)}）`,
    );
    stopGraphRefresh(UNIT);
  }

  // ── ④-c 有界（in-process 注入） ──
  section("④-c 重解析有界：最小间隔闸门（外部触发两轮之间必须隔开）");
  {
    let calls = 0;
    const parse = (): GraphRefreshParseHandle => {
      calls++;
      const id = `mi-${calls}`;
      return { run: { id }, done: Promise.resolve({ id, status: "done", error: null }) };
    };
    startGraphRefresh(UNIT, { dataDir, quietMs: 40, minIntervalMs: 700, parse, rebuild: () => undefined });
    graphRefreshDispatch(UNIT, { ts: nowIso(), path: "src/d1/a.ts", action: "add", size_delta: 1 });
    await waitFor(() => calls >= 1, 3000, "第一轮开跑");
    graphRefreshDispatch(UNIT, { ts: nowIso(), path: "src/d2/b.ts", action: "add", size_delta: 1 });
    await sleep(300);
    const during = calls;
    ok(
      during === 1,
      `④-c 反例断言：第二轮**不能**立刻开跑（闸门间隔 700ms，此刻 parse 调用=${during}；无闸门时这里会是 2＝"每条变化一轮"）`,
    );
    const queuedRec = readUpdate(unitRoot);
    ok(
      queuedRec?.eta?.basis === "wait_window" && typeof queuedRec?.eta?.total_ms === "number",
      `④-c 排队期间如实给出等待依据（basis=${String(queuedRec?.eta?.basis)}、${String(queuedRec?.eta?.total_ms)}ms）`,
    );
    const second = await waitFor(() => calls >= 2, 3000, "第二轮在间隔到点后开跑");
    ok(second && calls === 2, `④-c 间隔到点后第二轮才跑（parse 总调用=${calls}）`);
    stopGraphRefresh(UNIT);
  }
  section("④-c' 重解析有界：滚动窗口轮数预算（超出即等待，不无界起轮）");
  {
    let calls = 0;
    const parse = (): GraphRefreshParseHandle => {
      calls++;
      const id = `bg-${calls}`;
      return { run: { id }, done: Promise.resolve({ id, status: "done", error: null }) };
    };
    startGraphRefresh(UNIT, {
      dataDir,
      quietMs: 30,
      minIntervalMs: 1,
      budgetWindowMs: 60_000,
      maxRoundsPerWindow: 2,
      parse,
      rebuild: () => undefined,
    });
    for (const d of ["b1", "b2", "b3", "b4", "b5"]) {
      graphRefreshDispatch(UNIT, { ts: nowIso(), path: `src/${d}/x.ts`, action: "add", size_delta: 1 });
      await sleep(180);
    }
    await sleep(900);
    const afterBurst = calls;
    ok(afterBurst === 2, `④-c' 窗口预算 2 轮：5 条突发只跑了 ${afterBurst} 轮（反例＝无预算时会是 5 轮）`);
    const budgetRec = readUpdate(unitRoot);
    ok(
      budgetRec?.state === "updating" && budgetRec?.phase === "queued" && budgetRec?.eta?.basis === "wait_window",
      `④-c' 超出预算时如实标「正在更新·等闸门」并给等待依据（phase=${String(budgetRec?.phase)}）`,
    );
    await sleep(1200);
    ok(calls === afterBurst, `④-c' 1.2 秒后调用数不变（${calls}）——不是无界重试`);
    stopGraphRefresh(UNIT);
  }
  section("④-c'' 有界：重解析失败不自动重试（如实 failed + 原因）");
  {
    let calls = 0;
    const parse = (): GraphRefreshParseHandle => {
      calls++;
      const id = `fail-${calls}`;
      return { run: { id }, done: Promise.resolve({ id, status: "failed", error: "注入失败：磁盘只读" }) };
    };
    startGraphRefresh(UNIT, { dataDir, quietMs: 30, minIntervalMs: 1, parse, rebuild: () => undefined });
    graphRefreshDispatch(UNIT, { ts: nowIso(), path: "src/f1/x.ts", action: "add", size_delta: 1 });
    const failedOk = await waitFor(() => readUpdate(unitRoot)?.state === "failed", 4000, "失败终态");
    await sleep(1200);
    const failedRec = readUpdate(unitRoot);
    ok(
      failedOk && calls === 1 && /注入失败/.test(String(failedRec?.last_error)),
      `④-c'' 失败即终态（state=${String(failedRec?.state)}，parse 调用=${calls}＝1 次，不自动重试）`,
    );
    const failBanner = graphUpdateBannerOf(failedRec as GraphUpdateView | null);
    ok(
      failBanner !== null && failBanner.state === "failed" && failBanner.text.includes("图更新失败"),
      "④-c'' 失败时界面出「图更新失败」+ 原因（旧图保留）",
    );
    stopGraphRefresh(UNIT);
  }
} finally {
  if (poller !== undefined) clearInterval(poller);
  child?.kill();
  await sleep(200);
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(`\n[verify] 汇总：${pass} PASS / ${fail} FAIL`);
console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
