// N3 验证脚本（用 tsx 跑）：三视图互相定位（PLAN N3 卡 DoD①–④ + 卡上"跑偏点"红线）。
// 用法：pnpm verify:n3
//
// 覆盖点（逐条对 DoD）：
//   ① **双向定位**（DoD①）：
//      - 思维导图 → 方框图：点节点右侧的定位入口（`data-mm-locate`）→ 视图切到方框图、该 module_id
//        的节点**居中**（节点 DOM 中心 ≈ 画布中心）+ **高亮**（`data-arch-focused="1"`）；
//      - 思维导图 → 数据流向图：同上（切到流向图后仍按同一 id 命中）；
//      - 反向（方框图/流向图 → 思维导图）：点节点上的「导图」入口（`data-locate-mindmap`）→ 切到导图、
//        对应节点居中 + 高亮（`g[data-mm-focused]`）。
//   ② **按 id 对齐**（DoD① 红线，PLAN N3 跑偏点）：数据层先证"导图顶层 id 集合 == 共用层节点 id 集合"，
//      再把显示名全换成「改名反证-<id>」证明按 id 依然全中；UI 段再做一次**真改名**（改 names.json →
//      刷新 → 节点显示名变了、点它仍然定位到同一个 module_id）。
//   ③ **高亮同时体现状态色**（DoD②，与画布一致）：定位后读节点/高亮的颜色属性，断言它等于
//      **该节点上屏状态色**（v2 派生口径：`data-display-status` 六态键 → `statusColor.ts` 六态色表的 hex）。
//      V08-06 收尾（2026-09-24）定向更新：旧期望是"`progress.json` 四色"（todo 灰/doing 黄/done 绿/issue 红），
//      依据 = 技术详情三视图已改成按 v2 派生状态上色；保留意图 = "高亮色必须等于该节点的状态色、色值只出自
//      `statusColor.ts` 一份"；判据未放宽 = 仍是逐项相等（DOM 色值 == 色表推导值）+ 两侧（方框图/导图）同值。
//      多状态对照改由真实存在的第二种上屏状态承担（文件级节点「无状态记录」灰虚线，见 UI 段"② 前置补"）。
//      回归结果见 .工作台/evidence/V08-06/1/regress/n3.log。
//   ④ **定位不重置对方的折叠状态与布局记忆**（DoD③）：UI 段先真拖一个节点（layout.json 有真实内容）
//      并展开一枝，然后做整轮定位，断言 `layout.json`、`mindmap-fold.json` **逐字节不变**，
//      且已展开的枝没被折回去；导图侧"就地展开到可见"的那一步也不许写折叠记忆。
//   ⑤ **未匹配有明确提示**（DoD④）：导图的项目根节点在方框图无对应、方框图里展开的枝在导图里没展开，
//      两种情形都必须给出「该节点在 X 视图无对应」的提示（并配一次"补上展开后同一操作就命中"的正对照，
//      证明提示不是写死的）。
//
// 端口策略（照 verify-n2/f4 写法）：**不碰任何既有监听**——后端 bind 0 让系统分配，vite 同样动态选端口
// 并把后端端口经 TATAI_DEV_API_PORT 传进代理；起前探活、起后盯子进程早退；开头末尾各探一次 8787/5173
// （只记录状态，不杀别人的进程）。
// 隐私（AGENTS.md §5/§6）：真实项目只贴路径、id、结构与计数，不贴内容；本脚本会临时改
// `names.json`（改名反证）、`layout.json`（拖动）、`mindmap-fold.json`（导图展开），跑完三个文件
// **逐字节还原**（原本没有的删掉）。截图落 `.工作台/verify/n3-*.png`（gitignore）。
import { execSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandProject } from "../src/arch/expand";
import { buildMindTree } from "../src/arch/mindmap";
import { buildSharedGraph } from "../src/arch/render";
import { getProject } from "../src/server/registry";
import { ensureSelfRegistered, finish, realHome } from "./lib/fixtures";
import { fetchTechDisplayExpectations } from "./lib/displayStatus";
import { DISPLAY_STATUS_KEYS, NO_STATUS_RECORD_KEY } from "../src/ui/arch/statusColor";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_DATA_DIR = realHome(); // TATAI_HOME > 缺省 ~/.tatai（脚本不写死作者本机路径）
ensureSelfRegistered(REAL_DATA_DIR); // 塔台自身＝本仓库：幂等登记，脚本换台机器也能跑
const VERIFY_DIR = path.join(REPO_ROOT, ".工作台", "verify");
const PROJECT = "tatai";

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 端口：探活 + 动态分配（与 verify-f4/n1/n2 同一份写法） ─────────────────────────

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
  return child;
}

// ───────────────────────── ① 数据层：对齐键 = module_id（含改名反证） ─────────────────────────

interface ModSpec {
  id: string;
  label: string;
  path: string;
  /** v1 自报状态（progress.json）：只用于"挑三个不同模块"的多样性与诊断打印；
   *  上屏颜色/文字期望以 v2 派生表 `SPEC["display"]` 为准（V08-06 收尾定向更新） */
  status: string;
  aggregate: boolean;
}

function buildSpec(): {
  spec: Record<string, unknown>;
  mods: ModSpec[];
} {
  const project = getProject(PROJECT, REAL_DATA_DIR);
  const built = buildSharedGraph(PROJECT, { dataDir: REAL_DATA_DIR });
  if (!project || !built.exists || !built.graph) throw new Error("塔台项目数据不可读（注册表 / 共用数据层）");
  const graph = built.graph;

  // ①-1 导图顶层 id 集合 == 共用层节点 id 集合（同一份数据的第三种渲染，逐 id 相同 → id 可当对齐键）
  const tree = buildMindTree(graph, { id: project.id, name: project.name }, new Map());
  const graphIds = graph.nodes.map((n) => n.id).sort();
  const treeIds = tree.root.children.map((c) => c.id).sort();
  ok(
    JSON.stringify(graphIds) === JSON.stringify(treeIds) && graphIds.length > 0,
    `① 对齐键可用：导图顶层 ${treeIds.length} 个 id == 共用层节点 ${graphIds.length} 个 id（逐 id 相同，三视图共享同一份数据层）`,
  );

  // ①-2 改名反证（数据层）：显示名全换成「改名反证-<id>」后按 id 依然全中
  const renamed = { ...graph, nodes: graph.nodes.map((n) => ({ ...n, name: `改名反证-${n.id}` })) };
  const tree2 = buildMindTree(renamed, { id: project.id, name: project.name }, new Map());
  const ids2 = new Set(tree2.root.children.map((c) => c.id));
  ok(
    graphIds.every((id) => ids2.has(id)) &&
      tree2.root.children.every((c) => c.label === `改名反证-${c.id}`),
    `① 反证（数据层）：显示名全换成「改名反证-<id>」后，按 id 定位依然全中 ${ids2.size}/${graphIds.length} —— 名字只用于展示（PLAN N3 跑偏点）`,
  );

  const mods: ModSpec[] = graph.nodes.map((n) => ({
    id: n.id,
    label: n.name,
    path: n.path,
    status: n.status ?? "todo",
    aggregate: n.aggregate === true,
  }));
  console.log(
    `[verify]   顶层模块 ${mods.length} 个：${mods
      .map((m) => `${m.id}(${m.status}${m.aggregate ? "/聚合" : ""})`)
      .join("、")}`,
  );
  // ── 骨架无关取形（2026-09-18）：不硬编码会漂的模块 id（src-server/src-ui/src-arch 随骨架翻新已不存在）──
  //  V08-06 收尾（2026-09-24）：选目标只看"三个不同的模块"，**不再假设它们颜色不同**（v2 派生后塔台
  //  7 个顶层模块当前同色）——这里仍优先挑 v1 自报状态不同的，只为让三个目标尽量来自不同现场，
  //  颜色/文字期望一律以 `SPEC["display"]`（v2 派生实况）为准。
  //  boxTarget  = 第一个有直属文件子级的模块（方框图深枝定位要能命中文件级节点）；
  //  flowTarget = 换一个模块（v1 自报状态不同优先）；
  //  backTarget = 再换一个（反向定位的第三个目标，不硬编码具体 id）；
  //  canvasOwner = 另一个有子目录的模块（⑤ 未匹配 B 需要一枝导图里从没加载过的）。
  const info = mods.map((m) => {
    const kids = expandProject(PROJECT, m.path, REAL_DATA_DIR);
    return {
      m,
      kids,
      hasFile: kids.children.some((c) => c.kind === "file"),
      hasDir: kids.children.some((c) => c.kind === "dir"),
    };
  });
  const boxPick = info.find((x) => x.hasFile);
  if (!boxPick) throw new Error("塔台项目缺「有直属文件子级」的模块（深枝定位要文件级节点）");
  const boxTarget = boxPick.m;
  const boxKids = boxPick.kids;
  const flowTarget =
    info.find((x) => x.m.id !== boxTarget.id && x.m.status !== boxTarget.status)?.m ??
    info.find((x) => x.m.id !== boxTarget.id)!.m;
  const backTarget =
    info.find(
      (x) =>
        x.m.id !== boxTarget.id &&
        x.m.id !== flowTarget.id &&
        x.m.status !== boxTarget.status &&
        x.m.status !== flowTarget.status,
    )?.m ?? info.find((x) => x.m.id !== boxTarget.id && x.m.id !== flowTarget.id)!.m;
  // 拖动节点（④ 的 layout.json 基线制造）：与三个定位目标无关的任一顶层模块（骨架无关，不锚死 id）
  const dragNode =
    info.find(
      (x) => x.m.id !== boxTarget.id && x.m.id !== flowTarget.id && x.m.id !== backTarget.id,
    )?.m ?? info.find((x) => x.m.id !== boxTarget.id)!.m;
  // V08-06 收尾（2026-09-24）② 的期望定向更新（判据未放宽）：
  //   旧期望 = 定位目标要覆盖 progress.json 里的**≥2 种 v1 状态色**（"一色无对照意义"）。
  //   依据   = 技术详情画布已按 v2 派生状态上色（V08-06 ②）：塔台 7 个顶层模块的派生结果当前
  //            全是 `verified`（实测 `moduleStatusKeysOf(taskDerivedModuleStatus(...))`），
  //            所以"≥2 色"这个前提在 v2 口径下不再成立——旧断言会把事实判成失败。
  //   新期望 = ① 定位目标的**上屏键/环色/徽标文字**逐项等于同一份派生实况（`SPEC["display"]`，
  //            由 uiPlaywright 按界面同源算法注入，见 scripts/lib/displayStatus.ts）；
  //            ② 文件层边界仍守着：展开出来的文件级节点**不带状态属性**（文件层不判状态，
  //            既不冒充模块状态、也不落 v1 旧四色）——见 UI 段"② 前置补"。
  //   保留意图 = "定位高亮色必须等于该节点的状态色、且色值只出自 statusColor.ts 一份"原样保留。
  //   判据未放宽 = 仍是逐项相等（DOM 色值 == 色表推导值）+ 两侧（方框图/导图）同值，只是不再要求
  //            "屏幕上至少有 2 种状态色"（事实变了：塔台 7 个顶层模块当前派生结果一致）。
  //   回归结果：见 PROGRESS 流水与 .工作台/evidence/V08-06/1/regress/n3.log。
  const distinctStatus = new Set(mods.map((m) => m.status));
  console.log(
    `[verify]   定位目标（三个不同模块，按 v1 自报状态尽量取不同）：` +
      `${[boxTarget, flowTarget, backTarget].map((t) => `${t.id}(v1=${t.status})`).join(" · ")}` +
      `；v1 自报状态 ${distinctStatus.size} 种（只用于挑"三个不同模块"，颜色期望见 v2 派生表）`,
  );

  // 下钻层目标：A4 真跑一次取子级 id——文件级来自 boxTarget（展开枝上的真文件）；目录级来自
  // canvasOwner（≠ boxTarget，它的枝在导图里没加载过，⑤ 的"未匹配提示 + 正对照"才有意义）
  const fileChild = boxKids.children.find((c) => c.kind === "file");
  const canvasOwnerPick = info.find((x) => x.hasDir && x.m.id !== boxTarget.id);
  const dirChild = canvasOwnerPick?.kids.children.find((c) => c.kind === "dir");
  if (!fileChild || !canvasOwnerPick || !dirChild) throw new Error("A4 子级夹具不齐（file/dir 各需一个）");
  const canvasOwner = canvasOwnerPick.m;
  console.log(
    `[verify]   下钻层夹具：文件级 ${fileChild.path}（id=${fileChild.id}，属 ${boxTarget.id}）· 目录级 ${dirChild.path}（id=${dirChild.id}，属 ${canvasOwner.id}）`,
  );

  return {
    mods,
    spec: {
      project: PROJECT,
      projectId: project.id,
      projectRoot: project.path,
      modules: mods,
      boxTarget: boxTarget.id,
      flowTarget: flowTarget.id,
      backTarget: backTarget.id,
      dragNode: dragNode.id,
      canvasOwner: canvasOwner.id,
      fileChild: { id: fileChild.id, path: fileChild.path },
      mindmapFoldEntry: { id: boxTarget.id, path: boxTarget.path },
      canvasOnlyChild: { id: dirChild.id, path: dirChild.path },
      boxTargetText: `${boxTarget.label} ${boxTarget.path}`,
      uiText: `${canvasOwner.label} ${canvasOwner.path}`,
      rename: { id: boxTarget.id, to: `改名反证·${boxTarget.label}` },
      // `display`（模块 id → v2 上屏状态）由 `uiPlaywright` 在后端就绪后按登界面同源算法注入——
      // 这里不写死、也不用 v1 自报状态顶上（见 ② 的定向更新注释）。
    },
  };
}

// ───────────────────────── ③ 源码级护栏：对齐键只认 id、零新依赖、口径单一出处 ─────────────────────────

function walkSrc(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSrc(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(path.relative(REPO_ROOT, p).replace(/\\/g, "/"));
  }
  return out;
}

function checkSourceGuard(): void {
  console.log("\n[verify] ── ③ 源码级护栏：对齐键只认 module_id + 零新 npm 依赖");
  const files = walkSrc(path.join(REPO_ROOT, "src"));
  const read = (f: string) => fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
  const canvas = "src/ui/arch/ArchCanvas.tsx";
  const mind = "src/ui/arch/MindMapView.tsx";
  const locate = "src/ui/arch/locate.ts";
  const statusColor = "src/ui/arch/statusColor.ts";

  const external = (f: string) =>
    [...read(f).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.startsWith("."));
  ok(
    external(locate).length === 0 && external(statusColor).length === 0,
    `③ 零新 npm 依赖：N3 两个新模块 ${locate} / ${statusColor} 只 import 仓内相对路径（外部依赖 ${[...external(locate), ...external(statusColor)].join(" / ") || "（无）"}）`,
  );
  ok(
    read(canvas).includes("sharedIds.has(locate.id)") && read(mind).includes("byId.get(locate.id)"),
    "③ 两个视图都在**按 module_id**（共用层节点 id）找节点 —— 不拿显示名当对齐键",
  );
  ok(
    read(canvas).includes("unmatchedNote(") && read(mind).includes("unmatchedNote("),
    "③ 两个视图的未匹配提示走**同一句口径**（`locate.ts` 的 `unmatchedNote`，不是各写一句）",
  );
  const fourColorHits = files.filter((f) => /statusStyle\(|STATUS_STYLE/.test(read(f)));
  // 2026-09-18 复跑修正：CrossProjectView（已提交定版，acddf4f）的 Gate 三态/严重度/模块计数取色
  // 也 import 自同一份 statusColor.ts——消费方枚举如实纳入第四个；断言实质不变：色值定义单一出处
  // （所有消费方必须 import，不许内联色值），集合外再冒出第五个消费方照 FAIL。
  // 定向更新（V09-19，2026-09-26）：消费方枚举如实新增第五个 `src/arch/sixGraphs.ts`（六图 MCP 读口）。五要素留档：
  //   旧期望：用 statusStyle/STATUS_STYLE 的文件恰为 [ArchCanvas, statusColor, MindMapView, CrossProjectView]｜
  //   依据：V09-19 新增只读读口 `get_project_graphs`（DESIGN §6.4）——它要给每个对象同一个**状态短标与颜色口径**，
  //         按本断言的口径必须 import 那一份 statusColor，不许内联色值｜
  //   新期望：集合加入 `src/arch/sixGraphs.ts`（它**只用不定义**：色值仍唯一出自 statusColor.ts）｜
  //   保留意图：色值定义单一出处这条实质不变——集合外再冒第六个消费方照旧 FAIL（仍是精确集合比对，不是放宽成「包含即可」）。
  const sixGraphs = "src/arch/sixGraphs.ts";
  const crossView = "src/ui/projects/CrossProjectView.tsx";
  ok(
    JSON.stringify(fourColorHits.sort()) ===
      JSON.stringify([canvas, locate.replace("locate.ts", "statusColor.ts"), mind, crossView, sixGraphs].sort()),
    `③ 四色状态色值单一出处（${statusColor}）：用它的文件 = 方框图/导图两个渲染器 + 跨项目视图（Gate 三态与严重度取色，仍 import 同一份）（实际：${fourColorHits.join(", ")}；精确集合，多一个消费方照红）`,
  );
  const focusHits = files.filter((f) => read(f).includes("FOCUS_RING_COLOR"));
  ok(
    JSON.stringify(focusHits.sort()) === JSON.stringify([canvas, mind, statusColor].sort()),
    `③ 定位高亮色的单一出处同样是 ${statusColor}（${focusHits.join(", ")}）`,
  );
}

// ───────────────────────── ② ④ UI 段：playwright（动态端口 + 探活） ─────────────────────────

async function uiPlaywright(specPath: string, backendPort: number): Promise<void> {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  // V08-06 收尾：状态期望值从**后端**取（与界面同一份读口 + 同一份派生函数），写回 spec 供 python 消费。
  // 位置讲究：`buildSpec()` 跑在后端起之前，所以期望只能在这里补——也因此把 ② 的"覆盖实况状态"
  // 断言从 buildSpec 挪到这里（期望值到手才谈得上覆盖）。
  const specJson = JSON.parse(fs.readFileSync(specPath, "utf8")) as Record<string, unknown> & {
    modules: { id: string }[];
    boxTarget: string;
    flowTarget: string;
    backTarget: string;
  };
  const display = await fetchTechDisplayExpectations({
    baseUrl: `http://127.0.0.1:${backendPort}`,
    projectId: PROJECT,
    techIds: specJson.modules.map((m) => m.id),
  });
  specJson.display = display;
  fs.writeFileSync(specPath, JSON.stringify(specJson, null, 2), "utf8");
  const targets = [specJson.boxTarget, specJson.flowTarget, specJson.backTarget];
  const distinctKeys = new Set(Object.values(display).map((e) => e.key));
  const legalKeys = new Set<string>([...DISPLAY_STATUS_KEYS, NO_STATUS_RECORD_KEY, "unmapped"]);
  ok(
    targets.every(
      (id) =>
        display[id] !== undefined &&
        legalKeys.has(display[id].key) &&
        /^#[0-9a-f]{6}$/.test(display[id].hex) &&
        display[id].label !== "",
    ),
    `② 定位目标的 v2 上屏状态与状态色算得出且在白名单内（${targets.map((id) => `${id}=${display[id].key}/${display[id].hex}`).join(" · ")}；` +
      `实况上屏键 ${distinctKeys.size} 种：${[...distinctKeys].join("、")}——色值/短标出处 = statusColor.ts，逐项相等由 UI 段断言）`,
  );
  const pyPath = path.join(VERIFY_DIR, "n3-shot.py");
  fs.writeFileSync(pyPath, PY_SHOT, "utf8");
  let vitePort = 0;
  let vite: ChildProcess | null = null;
  for (let attempt = 1; attempt <= 3 && !vite; attempt++) {
    vitePort = await pickFreePort();
    const child = spawn(process.execPath, [path.join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js"), "dev", "--port", String(vitePort), "--strictPort"], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
      env: { ...process.env, TATAI_DEV_API_PORT: String(backendPort) },
    });
    pipeOutput(child, `vite:${vitePort}`);
    try {
      await waitUpAny(
        [`http://localhost:${vitePort}/`, `http://127.0.0.1:${vitePort}/`, `http://[::1]:${vitePort}/`],
        `vite ${vitePort}`,
        { timeoutMs: 90_000, isAlive: () => child.exitCode === null },
      );
      vite = child;
      console.log(`[verify]   vite ${vitePort} 已就绪（第 ${attempt} 次尝试）`);
    } catch (e) {
      console.log(`[verify]   vite 端口 ${vitePort} 起不来（第 ${attempt} 次）：${(e as Error).message}`);
      killTree(child, vitePort);
    }
  }
  if (!vite) {
    ok(false, "UI 段：vite 起不来（连续 3 个动态端口都失败）");
    return;
  }
  console.log(`[verify]   UI 段服务就绪：后端 ${backendPort}（动态端口）+ vite ${vitePort}（动态端口）`);
  try {
    const out = execSync(`python "${pyPath}" ${vitePort} ${backendPort} "${specPath}"`, {
      cwd: VERIFY_DIR,
      stdio: "pipe",
      timeout: 900_000,
    }).toString();
    process.stdout.write(out);
    ok(out.includes("UI_ASSERT_ALL_PASS"), "① ② ④ playwright：双向定位 / 按 id 对齐（含真改名）/ 未匹配提示 / 布局与折叠零变化 全过");
  } catch (e) {
    process.stdout.write((e as { stdout?: Buffer }).stdout?.toString() ?? "");
    process.stderr.write((e as { stderr?: Buffer }).stderr?.toString() ?? "");
    ok(false, "UI 段执行失败（见上方输出）");
  } finally {
    killTree(vite, vitePort);
    await sleep(500);
  }
  const shots = [
    "n3-01-canvas-baseline.png",
    "n3-02-mindmap-entries.png",
    "n3-03-mindmap-to-box.png",
    "n3-04-mindmap-to-flow.png",
    "n3-05-canvas-to-mindmap.png",
    "n3-06-reveal-file-node.png",
    "n3-07-unmatched-box.png",
    "n3-08-unmatched-mindmap.png",
    "n3-09-renamed-id-align.png",
  ];
  for (const shot of shots) ok(fs.existsSync(path.join(VERIFY_DIR, shot)), `UI 截图落盘 .工作台/verify/${shot}`);
}

/** UI 段 python（与 verify-n2 同款 playwright 写法；参数走一段 JSON） */
const PY_SHOT = String.raw`# N3 UI 验证：三视图互相定位（按 module_id 对齐 / 状态色高亮 / 不重置折叠与布局 / 未匹配提示）
# 用法：python n3-shot.py <vitePort> <backendPort> <spec.json>
#
# V08-06 收尾（2026-09-24）状态期望定向更新（判据未放宽）：见本脚本 ts 侧 ③ 的"定向更新"注释——
#   定位高亮色/节点状态属性按 **v2 派生上屏状态**（SPEC["display"][id] = {key,label,hex}，
#   由 ts 侧按界面同源算法从后端读口算好注入）逐项断言；不再用 progress.json 四色。
import json
import os
import re
import sys

from playwright.sync_api import sync_playwright

VITE_PORT, BACKEND_PORT, SPEC_PATH = sys.argv[1], sys.argv[2], sys.argv[3]
SPEC = json.load(open(SPEC_PATH, encoding="utf-8"))
BASE = f"http://localhost:{VITE_PORT}"
PID = SPEC["project"]
ROOT = SPEC["projectRoot"]
ARCH_DIR = os.path.join(ROOT, ".工作台", "arch")
NAMES_FILE = os.path.join(ARCH_DIR, "names.json")
LAYOUT_FILE = os.path.join(ARCH_DIR, "layout.json")
FOLD_FILE = os.path.join(ARCH_DIR, "mindmap-fold.json")
OUT = "."
fails = []
step = {"now": "启动"}
MOD = {m["id"]: m for m in SPEC["modules"]}
DISPLAY = SPEC["display"]


def ok(cond, label):
    print(("[UI PASS] " if cond else "[UI FAIL] ") + label)
    if not cond:
        fails.append(label)


def read_bytes_safe(p):
    return open(p, "rb").read() if os.path.exists(p) else None


def center(box):
    return (box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)


def dist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def arch_attr(page, name):
    el = page.locator("[data-arch-mode]").first
    return el.get_attribute(name) if el.count() else None


def mind_attr(page, name):
    el = page.locator("[data-mindmap-view]").first
    return el.get_attribute(name) if el.count() else None


def arch_note(page):
    """定位提示文字（画布侧）"""
    el = page.locator("[data-arch-locate-note]").first
    return el.get_attribute("data-arch-locate-note") if el.count() else ""


def mind_note(page):
    """定位提示文字（导图侧）"""
    el = page.locator("[data-mindmap-locate-note]").first
    return el.get_attribute("data-mindmap-locate-note") if el.count() else ""


def translate_of(style):
    m = re.search(r"translate\((-?[\d.]+)px[, ]+(-?[\d.]+)px\)", style or "")
    return (float(m.group(1)), float(m.group(2))) if m else None


def viewport_zoom(page):
    """React Flow 视口当前缩放（节点 transform 是流程图坐标，屏幕像素要除以它）"""
    t = page.locator(".react-flow__viewport").evaluate("el => getComputedStyle(el).transform")
    m = re.match(r"matrix\(([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+),\s*([-\d.e]+),", t or "")
    if m:
        return float(m.group(1))
    m2 = re.search(r"scale\(([\d.]+)\)", t or "")
    return float(m2.group(1)) if m2 else 1.0


def goto_arch(page, timeout=60000):
    page.wait_for_selector('button[data-view="arch"]', timeout=timeout)
    page.locator('button[data-view="arch"]').click()
    # V06-08：§3.1 把「项目图」默认落点切到「功能全景」；N3 守的是技术详情三视图互相定位，
    # 所以显式进入「技术详情」——断言、判据与阈值一个字都不动。
    page.locator('[data-project-view-tab="tech"]').click()
    page.wait_for_selector('[data-arch-node]', timeout=timeout)
    page.wait_for_timeout(900)


def switch_mode(page, mode):
    step["now"] = f"切视图 {mode}"
    page.locator(f'[data-graph-mode="{mode}"]').click()
    if mode == "MIND_MAP":
        page.wait_for_selector("[data-mindmap-view]", timeout=60000)
        page.wait_for_selector("[data-mm-locate]", timeout=60000)
    else:
        page.wait_for_selector(f'[data-arch-mode="{mode}"]', timeout=60000)
    page.wait_for_timeout(700)


def click_entry(page, sel):
    """点「导图」定位入口：真点被浮层截走时退化为派发一次冒泡 click。
    DATA_FLOW 视图左上角有 [data-flow-legend] 图例浮层，节点恰好排在图例下方时真点 30s 都过不去
    （实测 backTarget=src 在零基线 dagre 布局下正好被盖住）；与 n1 click_branch 同款兜底——
    断言随后照常验定位结果，点击方式只影响怎么触发，不影响验什么。"""
    loc = page.locator(sel).first
    try:
        loc.click(timeout=8000)
        return "mouse"
    except Exception:
        loc.evaluate("el => el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))")
        return "dispatch"


def click_mm_node(page, node_loc, what):
    """点导图上的 markmap 节点（svg.markmap g[data-path]）。
    Q3（2026-09-18 审计）：裸 click 走的是 Playwright 的 hit-target 校验——落点被后画的兄弟节点
    或 header 备注带（data-mindmap-capped-note，会随巨枝降级增高）压住时，它会一直重试到 30s
    超时（实测日志里 56 次 retrying），整个 UI 段就此中断。markmap 是原生 SVG，节点 g 的包围盒
    中心是不是被压住跟视图平移/备注高度有关，属**脚本可达性**问题（不是应用缺陷）。
    与 click_entry / verify-n2 的 click_node 同款兜底：真点 8s 过不去就退化为派发一次冒泡 click
    ——断言随后照常验"点了之后界面变成什么"，点击方式只影响怎么触发，不影响验什么。"""
    try:
        node_loc.first.click(timeout=8000)
        return "mouse"
    except Exception:
        node_loc.first.evaluate("el => el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))")
        return "dispatch"


def drag_point_in(page, node_id, box, label):
    """在节点包围盒内找一个"最上层元素真属于该节点"的落点（找不到 = None 并如实报）。
    Q3（2026-09-18 审计）：③ 前置先展开了 scripts 一枝，它的子级节点铺在 src 节点附近且画在**上层**
    （DOM 后者在上），src 的包围盒中心恰好被压住——实测裸取中心真拖走的是子节点
    （layout.json 落进的是 scripts-verify-e1-ts，不是 src），"拖动真实落盘"断言因此红。
    这里按几个候选落点逐点问 elementFromPoint 归属哪个 .react-flow__node，取第一个归属目标节点的点。"""
    point = page.evaluate(
        """([nodeId, box]) => {
             // 从上到下、由中心向外取样：中心被压住时先试上/左/右/下，再试四角
             const cands = [[0.5, 0.5], [0.5, 0.2], [0.2, 0.5], [0.8, 0.5], [0.5, 0.8],
                            [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
             for (const [fx, fy] of cands) {
               const x = box.x + box.width * fx, y = box.y + box.height * fy;
               const el = document.elementFromPoint(x, y);
               const owner = el && el.closest('.react-flow__node');
               if (owner && owner.getAttribute('data-id') === nodeId) return [x, y];
             }
             return null;
           }""",
        [node_id, box],
    )
    if point is None:
        print(f"[UI]   {label}：节点包围盒 {box} 里没有一个落点归属于 {node_id}（全被别的元素压住）")
    else:
        print(f"[UI]   {label}：落点 ({point[0]:.0f},{point[1]:.0f}) 归属 {node_id}（避开被压住的中心）")
    return point


def drag_node_in_layout(raw, node_id):
    """layout.json 里真有这个节点的坐标：按 mode 桶找键（不吃"src"是"src-tauri"子串的便宜）"""
    try:
        positions = json.loads(raw.decode("utf-8")).get("positions") or {}
    except Exception:
        return False
    return any(node_id in (bucket or {}) for bucket in positions.values())


def node_center_in(page, sel, host_sel, tol, label):
    """节点 DOM 中心 ≈ 宿主容器中心（"居中"的可验证口径）"""
    box = page.locator(sel).first.bounding_box()
    host = page.locator(host_sel).first.bounding_box()
    c, h = center(box), center(host)
    d = dist(c, h)
    ok(d <= tol, f"{label}（节点中心 {c[0]:.0f},{c[1]:.0f} vs 画布中心 {h[0]:.0f},{h[1]:.0f}，偏差 {d:.0f}px ≤ {tol}px）")
    print(f"[UI]   {label}：偏差 {d:.0f}px")


def focus_canvas(page, module_id, label):
    """方框图/流向图侧的定位落点断言：高亮色 + 上屏状态 + 徽标文字 + 居中。
    期望值取 SPEC["display"][module_id]（v2 派生实况；见文件头"定向更新"）。"""
    exp = DISPLAY[module_id]
    sel = f'[data-arch-node="{module_id}"][data-arch-focused="1"]'
    page.wait_for_selector(sel, timeout=20000)
    page.wait_for_timeout(500)
    el = page.locator(sel).first
    ok(el.get_attribute("data-arch-focus-color") == exp["hex"],
       f"{label}：高亮色 = 状态色 {exp['hex']}（{module_id} 上屏状态 {exp['key']}，与画布/statusColor.ts 同一份色表）")
    ok(el.get_attribute("data-display-status") == exp["key"],
       f"{label}：节点状态属性 = {exp['key']}（v2 派生口径；颜色 + 中文词双通道）")
    ok(el.get_attribute("data-arch-status") is None,
       f"{label}：v2 口径下不写 v1 四色属性 [data-arch-status]（两套状态不混在一个属性上）")
    badge = el.locator("[data-status-label]").first.get_attribute("data-status-label")
    ok(badge == exp["label"], f"{label}：节点徽标文字 = 「{badge}」（期望「{exp['label']}」——颜色之外的第二通道）")
    ok(arch_attr(page, "data-arch-focused") == module_id, f"{label}：画布侧已记录定位目标 {module_id}")
    ok(arch_attr(page, "data-arch-locate-state") == "matched", f"{label}：提示口径 = matched")
    node_center_in(page, sel, "[data-arch-view]", 80, f"{label}：节点在画布居中")
    return el


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
    page_errors = []
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    # Q3（2026-09-18 审计）：本机冷启 vite dev 的首屏实测 31~35s，Playwright 裸导航默认 30s 会先超时
    # （批次5 在 e1/e2/e3 上撞过同一堵墙）——给足导航预算，超时后仍失败才是真问题。
    page.goto(f"{BASE}/#p/{PID}", wait_until="domcontentloaded", timeout=180000)
    page.wait_for_timeout(2500)
    step["now"] = "打开架构图"
    goto_arch(page)
    ok(arch_attr(page, "data-arch-mode") == "MODULE_BOX", "① 技术详情默认停在方框图（回归口径不破）")
    page.screenshot(path=f"{OUT}/n3-01-canvas-baseline.png")

    # ── 前置现场：方框图里展开一枝（给"定位不重置折叠态"做基线）+ 真拖一个节点（layout.json 有内容）──
    page.locator(f'[data-expand-toggle="{SPEC["boxTarget"]}"]').click()
    page.wait_for_selector(f'[data-file-node="{SPEC["fileChild"]["path"]}"]', timeout=30000)
    page.wait_for_timeout(600)
    expanded_before = int(arch_attr(page, "data-arch-expanded") or 0)
    ok(expanded_before >= 1, f"③ 前置：方框图里已展开 {expanded_before} 枝（{SPEC['boxTarget']} 的子文件在画布上）")
    # ② 前置补（V08-06 收尾）：文件层不判状态——展开出来的文件级节点**不带任何状态属性**
    #    （既不冒充模块的「已验证通过」，也不落 v1 旧四色的「未开始」）；多状态对照的口径变化见 ts 侧 ② 注释。
    file_el = page.locator(f'[data-arch-node="{SPEC["fileChild"]["id"]}"]').first
    ok(file_el.get_attribute("data-display-status") is None and file_el.get_attribute("data-arch-status") is None,
       "② 文件级节点不带状态属性（文件层不判状态；不冒充模块状态、也不落 v1 旧四色）")

    node = page.locator(f'.react-flow__node[data-id="{SPEC["dragNode"]}"]')
    before_pos = translate_of(node.get_attribute("style"))
    zoom = viewport_zoom(page)
    box = node.bounding_box()
    # Q3（2026-09-18 审计）：落点先挑一个真归属目标节点的（展开树枝的子级铺在上层，中心会被压住）
    point = drag_point_in(page, SPEC["dragNode"], box, "③ 前置：拖动落点")
    ok(point is not None,
       f"③ 前置：{SPEC['dragNode']} 节点上有一个没被其它节点压住的落点（真拖得动目标节点）")
    cx, cy = point if point else center(box)
    page.mouse.move(cx, cy)
    page.mouse.down()
    page.mouse.move(cx + 240 * zoom, cy + 150 * zoom, steps=12)
    page.mouse.up()
    page.wait_for_timeout(1500)  # 等 debounce PUT 落盘
    layout_before = read_bytes_safe(LAYOUT_FILE)
    ok(layout_before is not None and drag_node_in_layout(layout_before, SPEC["dragNode"]),
       f"③ 前置：拖动真实落盘 layout.json（{SPEC['dragNode']} 坐标在内；定位前后逐字节对照的基线）")

    # ── ① 思维导图 → 方框图（DoD① 正向）──
    step["now"] = "导图→方框图"
    switch_mode(page, "MIND_MAP")
    entries = page.locator('[data-mm-locate][data-mm-locate-to="MODULE_BOX"]').count()
    ok(entries >= len([m for m in SPEC["modules"] if not m["aggregate"]]),
       f"① 导图每个顶层节点都有定位入口（方框图入口 {entries} 个 / 顶层模块 {len(SPEC['modules'])} 个）")
    page.screenshot(path=f"{OUT}/n3-02-mindmap-entries.png")

    # ── ⑤ 未匹配 A：导图的项目根节点（方框图里没有这个 module_id）──
    # 放在定位之前做：定位会把导图视口平移到目标节点上，根节点（右上角）随之可能跑出视口点不到。
    step["now"] = "未匹配：导图根 → 方框图"
    root_entry = page.locator(f'[data-mm-locate="{SPEC["projectId"]}"][data-mm-locate-to="MODULE_BOX"]')
    root_box = root_entry.bounding_box()
    ok(root_box is not None and root_box["width"] > 0, "⑤ 导图项目根节点的定位入口在视口内（默认全览）")
    root_entry.click()
    page.wait_for_selector('[data-arch-locate-state="unmatched"]', timeout=20000)
    note = arch_note(page)
    ok("该节点在方框图无对应" in note, f"⑤ 未匹配提示：{note[:120]}")
    ok(arch_attr(page, "data-arch-focused") == "", "⑤ 未匹配时不乱高亮（画布侧没有定位目标）")
    page.screenshot(path=f"{OUT}/n3-07-unmatched-box.png")
    switch_mode(page, "MIND_MAP")  # 回导图继续正向定位（回来自动 autoFit 全览）
    page.locator(f'[data-mm-locate="{SPEC["boxTarget"]}"][data-mm-locate-to="MODULE_BOX"]').click()
    page.wait_for_selector('[data-arch-mode="MODULE_BOX"]', timeout=20000)
    focus_canvas(page, SPEC["boxTarget"], "① 导图→方框图")
    ok(arch_attr(page, "data-arch-locate-state") == "matched" and SPEC["boxTarget"] in arch_note(page),
       "① 界面留痕：提示里写明对齐用的 module_id")
    page.screenshot(path=f"{OUT}/n3-03-mindmap-to-box.png")

    # ── ④ 定位不重置对方视图的折叠态（已展开的枝还在）──
    expanded_after = int(arch_attr(page, "data-arch-expanded") or 0)
    ok(expanded_after == expanded_before, f"④ 定位没改方框图的折叠态（展开枝数 {expanded_before} → {expanded_after}）")
    ok(page.locator(f'[data-file-node="{SPEC["fileChild"]["path"]}"]').count() == 1,
       "④ 前置展开的枝没有被折回去（子文件节点仍在画布上）")

    # ── ① 思维导图 → 数据流向图（DoD① 正向第二目标）──
    step["now"] = "导图→流向图"
    switch_mode(page, "MIND_MAP")
    page.locator(f'[data-mm-locate="{SPEC["flowTarget"]}"][data-mm-locate-to="DATA_FLOW"]').click()
    page.wait_for_selector('[data-arch-mode="DATA_FLOW"]', timeout=20000)
    focus_canvas(page, SPEC["flowTarget"], "① 导图→流向图")
    page.screenshot(path=f"{OUT}/n3-04-mindmap-to-flow.png")

    # ── ① 反向：方框图/流向图 → 思维导图（在流向图上点节点的「导图」入口）──
    step["now"] = "流向图→导图"
    how_back = click_entry(page, f'[data-locate-mindmap="{SPEC["backTarget"]}"]')
    page.wait_for_selector("[data-mindmap-view]", timeout=30000)
    page.wait_for_selector(f'[data-mm-focused="{SPEC["backTarget"]}"]', timeout=30000)
    page.wait_for_timeout(700)
    ring = page.locator(f'[data-mm-focused="{SPEC["backTarget"]}"]').first
    back_exp = DISPLAY[SPEC["backTarget"]]
    ok(ring.get_attribute("data-mm-focus-color") == back_exp["hex"] and ring.get_attribute("data-mm-focus-status") == back_exp["key"],
       f"① 反向定位：导图高亮环色 = 状态色 {back_exp['hex']}、环上状态词 = {back_exp['key']}"
       f"（{SPEC['backTarget']} 上屏状态；与方框图同一份色表）")
    ok(mind_attr(page, "data-mindmap-focused") == SPEC["backTarget"], "① 反向定位：导图侧已记录定位目标 module_id")
    ok(mind_attr(page, "data-mindmap-focus-state") == "matched", "① 反向定位：提示口径 = matched")
    print(f"[UI]   反向定位入口 {SPEC['backTarget']} 点击方式：{how_back}（图例浮层挡住真点时走派发）")
    page.wait_for_timeout(1400)  # 等 markmap 重画 + autoFit 过渡走完再量居中（见 MindMapView 的两次延后居中）
    node_center_in(page, f'[data-mm-focused="{SPEC["backTarget"]}"]', "[data-mindmap-canvas]", 120,
                   "① 反向定位：导图节点居中")
    page.screenshot(path=f"{OUT}/n3-05-canvas-to-mindmap.png")

    # ── ②④ 深枝：导图里"已加载但折叠着"的枝，从方框图定位要就地展开到可见，且**不写折叠记忆** ──
    step["now"] = "深枝定位（就地展开到可见）"
    switch_mode(page, "MODULE_BOX")  # 绕一圈再回导图：隐藏→显示触发 autoFit 全览，
    switch_mode(page, "MIND_MAP")    # 免得待会儿按整行文字点节点时它已被上一次居中移出视口
    target_label = SPEC["boxTargetText"]
    node_loc = page.locator("svg.markmap g[data-path]").filter(
        has_text=re.compile(r"^\s*" + re.escape(target_label) + r"(\s*\u25b8)?\s*$"))
    ok(node_loc.count() == 1, f"② 导图上找到顶层节点「{target_label}」（按整行文字定位，用于展开该枝）")
    how = click_mm_node(page, node_loc, f"② 展开「{target_label}」")
    print(f"[UI]   ② 导图节点「{target_label}」点击方式：{how}（落点被压住时走派发）")
    page.wait_for_function(
        "() => { const el = document.querySelector('[data-mindmap-view]');"
        " return !!el && Number(el.getAttribute('data-mindmap-loads')) >= 1; }", timeout=60000)
    page.wait_for_selector(f'[data-mm-locate="{SPEC["fileChild"]["id"]}"]', timeout=60000)
    ok(page.locator(f'[data-mm-locate="{SPEC["fileChild"]["id"]}"]').count() >= 1,
       f"② 该枝的子文件节点已在导图上（{SPEC['fileChild']['path']}）")
    # 再点一次 = 折回去（文件节点从画布消失，但已加载的数据留着）
    how = click_mm_node(page, node_loc, f"② 折回「{target_label}」")
    print(f"[UI]   ② 折回「{target_label}」点击方式：{how}")
    page.wait_for_timeout(900)
    ok(page.locator(f'[data-mm-locate="{SPEC["fileChild"]["id"]}"]').count() == 0,
       "② 该枝已折回（文件节点在导图上不可见）—— 定位要把它展开到可见")
    fold_before = read_bytes_safe(FOLD_FILE)
    print("[UI]   折叠记忆（定位前）：%s" % (fold_before.decode("utf-8", "replace") if fold_before else "（无文件）"))

    switch_mode(page, "MODULE_BOX")
    click_entry(page, f'[data-locate-mindmap="{SPEC["fileChild"]["id"]}"]')
    page.wait_for_selector("[data-mindmap-view]", timeout=30000)
    page.wait_for_selector(f'[data-mm-focused="{SPEC["fileChild"]["id"]}"]', timeout=30000)
    page.wait_for_timeout(700)
    ok(mind_attr(page, "data-mindmap-focus-state") == "matched",
       f"① 反向定位到文件级节点 {SPEC['fileChild']['path']}：导图命中（该枝已加载）")
    page.wait_for_timeout(1400)  # 同上：先让重画与 autoFit 过渡收敛
    node_center_in(page, f'[data-mm-focused="{SPEC["fileChild"]["id"]}"]', "[data-mindmap-canvas]", 140,
                   "① 反向定位：文件级节点展开到可见并居中")
    fold_after = read_bytes_safe(FOLD_FILE)
    ok(fold_before == fold_after,
       "④ 定位（含就地展开祖先到可见）前后 mindmap-fold.json 逐字节不变（展开只在内存里，折叠记忆不动）")
    page.screenshot(path=f"{OUT}/n3-06-reveal-file-node.png")

    # ── ⑤ 未匹配 B：方框图里有、导图没展开过的枝 → 提示；补上展开后同一操作就命中（正对照）──
    # 骨架无关（2026-09-18）：这枝取 canvasOwner（≠ boxTarget，导图里从没加载过），不锚 src-ui
    step["now"] = "未匹配：方框图 → 导图"
    switch_mode(page, "MODULE_BOX")
    click_entry(page, f'[data-expand-toggle="{SPEC["canvasOwner"]}"]')
    page.wait_for_selector(f'[data-locate-mindmap="{SPEC["canvasOnlyChild"]["id"]}"]', timeout=30000)
    page.wait_for_timeout(400)
    click_entry(page, f'[data-locate-mindmap="{SPEC["canvasOnlyChild"]["id"]}"]')
    page.wait_for_selector('[data-mindmap-locate-state="unmatched"]', timeout=30000)
    note2 = mind_note(page)
    ok("该节点在思维导图无对应" in note2, f"⑤ 未匹配提示：{note2[:140]}")
    ok(mind_attr(page, "data-mindmap-focused") == "", "⑤ 未匹配时不乱高亮（导图侧没有定位目标）")
    page.screenshot(path=f"{OUT}/n3-08-unmatched-mindmap.png")

    # 正对照：把这一枝在导图上展开（A4 懒加载），同一操作立刻命中 —— 证明提示不是写死的
    switch_mode(page, "MIND_MAP")
    ui_label = SPEC["uiText"]
    ui_node = page.locator("svg.markmap g[data-path]").filter(
        has_text=re.compile(r"^\s*" + re.escape(ui_label) + r"(\s*\u25b8)?\s*$"))
    ok(ui_node.count() == 1, f"⑤ 正对照：导图上找到「{ui_label}」节点准备展开")
    print(f"[UI]   ⑤ 正对照展开「{ui_label}」点击方式：{click_mm_node(page, ui_node, '⑤ 正对照展开')}")
    page.wait_for_selector(f'[data-mm-locate="{SPEC["canvasOnlyChild"]["id"]}"]', timeout=60000)
    switch_mode(page, "MODULE_BOX")
    click_entry(page, f'[data-locate-mindmap="{SPEC["canvasOnlyChild"]["id"]}"]')
    page.wait_for_selector('[data-mindmap-focus-state="matched"]', timeout=30000)
    ok(mind_attr(page, "data-mindmap-focused") == SPEC["canvasOnlyChild"]["id"],
       f"⑤ 正对照：补上展开后同一操作命中（{SPEC['canvasOnlyChild']['path']} 在导图上定位成功）")

    # ── ② 真改名反证（PLAN N3 跑偏点红线）：改 names.json 的显示名 → 刷新 → 点改名后的节点仍对齐同一 id ──
    step["now"] = "改名反证"
    names_before = read_bytes_safe(NAMES_FILE)
    names = json.loads(names_before.decode("utf-8"))
    old_name = names["entries"][SPEC["rename"]["id"]]["name"]
    names["entries"][SPEC["rename"]["id"]]["name"] = SPEC["rename"]["to"]
    with open(NAMES_FILE, "w", encoding="utf-8") as f:
        json.dump(names, f, ensure_ascii=False, indent=2)
    print("[UI]   改名反证：%s 「%s」→「%s」" % (SPEC["rename"]["id"], old_name, SPEC["rename"]["to"]))
    # 必须真刷新页面才读得到改过的 names.json：URL 没变（还是 #p/tatai），goto 同 URL 只会当作锚点跳转
    page.reload(wait_until="domcontentloaded", timeout=180000)  # 同上：冷启首屏预算（Q3）
    page.wait_for_timeout(2500)
    goto_arch(page)
    switch_mode(page, "MIND_MAP")
    entry = page.locator(f'[data-mm-locate="{SPEC["rename"]["id"]}"][data-mm-locate-to="MODULE_BOX"]')
    page.wait_for_selector(f'[data-mm-locate="{SPEC["rename"]["id"]}"][data-mm-locate-to="MODULE_BOX"]', timeout=60000)
    ok(entry.first.get_attribute("data-mm-locate-label") == SPEC["rename"]["to"],
       f"② 改名生效：导图定位入口的显示名 = 「{SPEC['rename']['to']}」（对齐键仍是 id={SPEC['rename']['id']}）")
    renamed_node = page.locator("svg.markmap g[data-path]").filter(has_text=re.compile(re.escape(SPEC["rename"]["to"])))
    ok(renamed_node.count() >= 1, "② 改名生效：导图上节点文字已变成新名字")
    entry.first.click()
    page.wait_for_selector('[data-arch-mode="MODULE_BOX"]', timeout=20000)
    focus_canvas(page, SPEC["rename"]["id"], "② 改名后按 id 对齐（点新名字的入口 → 仍定位到同一个 module_id）")
    ok(SPEC["rename"]["to"] in (page.locator(f'[data-arch-node="{SPEC["rename"]["id"]}"]').first.inner_text()),
       "② 方框图节点显示新名字、对齐键没变（一跳不断的反证）")
    page.screenshot(path=f"{OUT}/n3-09-renamed-id-align.png")
    # 改名现场立即还原（后续断言与收尾都按原样）
    with open(NAMES_FILE, "wb") as f:
        f.write(names_before)
    ok(read_bytes_safe(NAMES_FILE) == names_before, "② names.json 已逐字节还原")

    # ── ④ 整轮定位之后：布局记忆与折叠记忆零变化 ──
    layout_after = read_bytes_safe(LAYOUT_FILE)
    ok(layout_after == layout_before,
       "④ 整轮定位（导图↔方框图↔流向图）之后 layout.json 逐字节不变（定位不写布局记忆）")
    ok(not page_errors, "① 全过程零页面 JS 异常（%s）" % ("；".join(page_errors[:2]) if page_errors else "无"))
    browser.close()

print("UI_ASSERT_ALL_PASS" if not fails else f"UI_ASSERT_FAILS:{len(fails)}")
`;

// ───────────────────────── 现场保护：三个文件的快照 / 归零 / 还原 ─────────────────────────

const snapshots = new Map<string, Buffer | null>();

function archFile(name: string): string {
  const project = getProject(PROJECT, REAL_DATA_DIR);
  if (!project) throw new Error("塔台项目不在注册表里");
  return path.join(project.path, ".工作台", "arch", name);
}

function snapshotAndReset(): void {
  // layout.json：清成空 positions（已知基线，UI 段自己会拖出内容来对照）
  const layout = archFile("layout.json");
  snapshots.set(layout, fs.existsSync(layout) ? fs.readFileSync(layout) : null);
  fs.mkdirSync(path.dirname(layout), { recursive: true });
  fs.writeFileSync(layout, `${JSON.stringify({ version: 2, positions: {} }, null, 2)}\n`, "utf8");
  // mindmap-fold.json：删掉（默认全折叠的干净现场）
  const fold = archFile("mindmap-fold.json");
  snapshots.set(fold, fs.existsSync(fold) ? fs.readFileSync(fold) : null);
  fs.rmSync(fold, { force: true });
  // names.json：只快照，UI 段自己改自己还原（这里再兜一层）
  const names = archFile("names.json");
  snapshots.set(names, fs.existsSync(names) ? fs.readFileSync(names) : null);
}

function restoreSnapshots(): void {
  for (const [file, content] of snapshots) {
    try {
      if (content === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, content);
    } catch (e) {
      console.log(`[verify]   现场还原失败（${path.dirname(file)}）：${(e as Error).message}`);
    }
  }
}

// ───────────────────────── 主流程 ─────────────────────────

async function main(): Promise<void> {
  console.log("[verify] ── 端口：先探 8787 / 5173 是不是别人的（本脚本一律动态端口，绝不杀既有监听）");
  const fixedBefore = { v: await portListening(8787), d: await portListening(5173) };
  console.log(
    `[verify]   8787 ${fixedBefore.v ? "有人监听（别人的，不碰）" : "空闲"} · 5173 ${fixedBefore.d ? "有人监听（别人的，不碰）" : "空闲"}`,
  );

  console.log("\n[verify] ── ① 数据层：对齐键 = module_id（含显示名改名反证）");
  const built = buildSpec();

  checkSourceGuard();

  const specPath = path.join(VERIFY_DIR, "n3-spec.json");
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  fs.writeFileSync(specPath, JSON.stringify(built.spec, null, 2), "utf8");

  const backendPort = await pickFreePort();
  let backend: ChildProcess | null = null;
  snapshotAndReset();
  try {
    console.log("\n[verify] ── ② ④ UI 段：起后端（动态端口）+ vite（动态端口）+ playwright");
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
    ok(true, `② UI 段起服务：后端动态端口 ${backendPort}（探活通过）`);
    await uiPlaywright(specPath, backendPort);
  } finally {
    restoreSnapshots();
    if (backend) {
      intentionalStop.add(backendPort);
      backend.kill();
    }
    await sleep(800);
  }

  console.log("\n[verify] ── 收尾：进程杀净 + 动态端口释放 + 8787/5173 仍是别人的 + 现场逐字节还原");
  ok(!(await portListening(backendPort)), `收尾：后端动态端口 ${backendPort} 已释放（进程杀净）`);
  const fixedAfter = { v: await portListening(8787), d: await portListening(5173) };
  ok(
    fixedBefore.v === fixedAfter.v && fixedBefore.d === fixedAfter.d,
    `收尾：8787/5173 状态与开工前一致（${fixedAfter.v ? "有人在用" : "空闲"} / ${fixedAfter.d ? "有人在用" : "空闲"}）——本脚本没占用、没杀 PID`,
  );
  const restored = [...snapshots.entries()].every(([file, content]) =>
    content === null ? !fs.existsSync(file) : fs.readFileSync(file).equals(content),
  );
  ok(restored, `收尾：layout.json / mindmap-fold.json / names.json 三个文件已逐字节还原（快照 ${snapshots.size} 个）`);
}

main()
  .then(() => finish())
  .catch((e) => {
    console.error("[verify] 异常:", e);
    process.exitCode = 1;
  });
