// 补修包 F 验证脚本（PLAN.md「补修分包」表 F 行 + 其下 F 段；主责卡 V06-08，关联 V06-09/V06-11）。
// 用法：pnpm verify:v06-08-f（或 node --import tsx scripts/verify-v06-08-f.ts）
//
// **2026-09-20 按裁定 F2/F3 更新**（F2 入口复核口径；F3 MCP 登记运行入口）：
//   · F2：24h 只是**可达性复核提醒阈值**，不是入口的自动失效期限——超阈值标「待重新验证」
//     （`reverify_due`）且**仍然可打开**，**不得**标成不可达、**不因超时撤掉打开入口**；
//     状态词表里**没有** `expired` 这一档。「已知不可达」（`failed`）与「成果版本过期」
//     （版本轴 `outdated`）**分别处理**，两条轴互不覆盖。http(s) 白名单与受控打开限制不变。
//   · F3：Agent 结果回报（`task.result_submitted` 的可选 `runtime_entries`）也能登记运行入口，
//     复用同一套校验、版本绑定与事实写入，**不另造存储**；旧调用（不声明该字段）行为不变。
//
// **2026-09-20 按第二轮裁定 2/3 更新**（裁定 3：写入侧统一拒绝 + 版本两源同权）：
//   · 写入侧统一拒绝：`runtime_entries` 只要是 `null` 就抛 `EVENT_INVALID`；只要**存在且非 `null`**
//     就用 `parseRuntimeEntries(...)` 校验，非法即拒、**一个字节都不落盘**。校验挂在**唯一写出口**
//     （`service.ts#submit()`）⇒ 成果登记（`audit.submission_submitted`）与结果回报
//     （`task.result_submitted`）两条路径**统一拒绝**。本脚本两路各来一条写侧反例。
//   · 读侧闸门**保留**（历史坏记录要可追溯、不静默丢）：读侧仍是同一套校验，非法登记读回来
//     500 `EVENT_INVALID`。写侧已经产不出坏记录了，所以"历史坏记录"只能**直接往夹具的
//     `events.jsonl` 末尾追加**一条构造好的非法事件来重现（夹具在 `os.tmpdir()` 下，不碰真实项目）。
//     `null` 是**写侧比读侧严**的地方：读侧对历史里的 `null` 暂时按"没声明"容忍，
//     不能一收紧就让历史项目整体 500（见 `docs/work-v2-contract.md` §19.8）。
//   · 版本两源同权（裁定 3）：`latestCodeBindingRevision(records, events)` 取代只认成果登记的旧口径——
//     候选同时来自 ①成果登记 `binding.revision`（`revision_kind === "code"`）与 ②结果回报
//     `payload.result_revision`，排序＝**实际发生时间优先、同刻用服务端 `seq`**。
//     ⇒ 纯走 MCP 结果回报、从不写成果登记的项目，版本轴不再恒 `unknown`。夹具 C 因此重排：
//     ①先证明"更晚的结果回报就是当前版本"；②再追加一条更晚的、**不声明入口**的成果登记，
//     证明"版本过期仍判得出来（且仍可打开）"。两步各自断言，不只留最后一步的结论。
//   · 裁定 2（唯一登记 / `kind === "write"` / 远端 403）不在本脚本：它在
//     `verify-v06-08.ts` 段⑤ 与 `verify-v06-12.ts` 段④ 的路由登记对账里。
//
// **本包要证的一句话**：项目"可体验运行入口"（DESIGN.md §3.7 既定能力）有了**正式读写路径**——
//   ① 登记落在**成果登记**（`audit.submission_submitted` 的可选 `runtime_entries`）与**结果回报**
//      （`task.result_submitted` 的可选 `runtime_entries`）里，**不塞进全局 `registry.json`**，
//      也不必新造一套平行机制；写口是**唯一写入服务面** `POST /api/work/command`（MCP 侧经
//      `submit_task_result` 转接同一个写入服务）；
//   ② 登记内容最少含：项目/场景、来源成果与版本、实际入口、验证时间、结果或不可用原因；
//   ③ 读取从**权威事实装配**（`GET /api/projects/:id/acceptance`），所以**用户还没验收时就能看到入口**
//      （入口来自成果登记/结果回报，**不是**来自用户已提交的验收记录）；
//   ④ 打开按既定受控方式：**只允许 http(s)**，`javascript:` / `file:` / `data:` 连尝试都不做；
//   ⑤ 没有入口显示"尚不可体验"；登记过但探测失败/结果未知/待重新验证/版本过期的**逐条分别说明状态**，
//      不静默消失，也不把"该复核了"说成"已经失效"；
//   ⑥ **打开入口 ≠ 用户接受**（登记与读取都不产生任何"已接受"记录）。
//
// 隔离环境：临时 TATAI_HOME + `os.tmpdir()` 下三个夹具项目，**不碰**任何真实项目与 `D:\.tatai`；
// 塔台根文档（DESIGN.md / AGENTS.md / PLAN.md / PROGRESS.md / README.md / 两份设计史）**只读**
// （首尾逐文件 sha256 对照，证明零改动）；收尾杀净子进程、删临时目录（TATAI_KEEP_TMP=1 保留现场）。
//
// 本脚本**不起浏览器**：界面侧（真 DOM 上"入口在 pending 时就上屏、点开不产生已接受"）由
// `scripts/verify-v06-08-f-ui.py` 用真浏览器验；这里做纯口径 + 真 HTTP 的机器可复跑部分。

import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  RUNTIME_ENTRY_REVIEW_MS,
  RUNTIME_ENTRY_STATES,
  RUNTIME_ENTRY_URL_PROTOCOLS,
  isRuntimeEntryUrl,
  parseRuntimeEntries,
  resultSubmittedSources,
  runtimeEntryRevisionStateOf,
  runtimeEntryStateOf,
  runtimeEntrySummaryOf,
  runtimeEntryViews,
  type RuntimeEntrySource,
} from "../src/server/work/runtimeEntries";
import { putEvidence, type RevisionKind } from "../src/server/work/evidence";
import { foldAuditRecords, AUDIT_EVENT_TYPES } from "../src/server/work/audit";
import { loadEvents } from "../src/server/work/eventStore";
import {
  readServiceDescriptor,
  writeServiceDescriptor,
  WORK_TOKEN_HEADER,
  WorkServiceClient,
  type WorkServiceDescriptor,
} from "../src/server/work/service";
import { collectProjectFacts } from "../src/server/work/statusProjection";
import { buildSourceManifest } from "../src/server/work/sourceEvidence";
import { recordWorkEvidenceTool } from "../src/mcp/tools/recordWorkEvidence";
import { importTaskDefinitions, taskDefinitionHash } from "../src/server/work/plan";
import { projectWorkDir } from "../src/server/workstation";
import { REGISTERED_EVENT_TYPES, SCHEMA_VERSION, WORK_ERROR_CODES, isWorkError, type WorkEvent } from "../src/server/work/types";
import { REMOTE_ROUTES, routeMentionTotal } from "../src/server/remote-routes";
import { resultEntryOpenPlan } from "../src/ui/result-entry";

const REPO = process.cwd();
const PORT = 8837;
const A = "v0608f-a";
const B = "v0608f-b";
/** 夹具 C：只给 F3 真链路用（MCP 结果回报 → 验收读口 → 打开入口），不参与 A/B 的既有断言 */
const C = "v0608f-c";
const CHG = "chg-v0608f";
/** 只读的塔台根文档（首尾 sha256 对照；DESIGN.md / AGENTS.md 必须零改动） */
const DOC_FILES = [
  "DESIGN.md",
  "AGENTS.md",
  "PLAN.md",
  "PROGRESS.md",
  "README.md",
  "docs/design-history-v0.4.md",
  "docs/design-history-v0.5.md",
];

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
  }
};
const info = (msg: string) => console.log(`[verify] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const sha256File = (f: string): string => sha256(fs.readFileSync(f));
const short = (s: string | null | undefined): string => (s == null ? "null" : `${s.slice(0, 12)}…`);

const spawned: ChildProcess[] = [];
process.on("exit", () => {
  for (const proc of spawned) {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch {
      // 已经没了
    }
  }
});

// ── 塔台根文档零改动（首尾哈希） ──
const docBefore = new Map<string, string>();
for (const rel of DOC_FILES) {
  const abs = path.join(REPO, rel);
  docBefore.set(rel, fs.existsSync(abs) ? sha256File(abs) : "<missing>");
}

// ── 隔离环境与夹具 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0608f-verify-"));
const dataDir = path.join(tmpBase, "home");
const rootA = path.join(tmpBase, "A");
const rootB = path.join(tmpBase, "B");
const rootC = path.join(tmpBase, "C");
const mkdirp = (d: string) => fs.mkdirSync(d, { recursive: true });
const write = (f: string, text: string) => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
const workbench = (root: string) => path.join(root, ".工作台");

/** 夹具施工图：卡表 + 卡正文（含验收检查项，供纯后端"期望"段使用） */
function planTextFor(title: string, cards: readonly (readonly [string, string])[]): string {
  const rows = cards.map(([id, goal]) => `| ${id} | todo | ${goal} |  | ${goal}验收记录 |`).join("\n");
  const sections = cards
    .map(
      ([id, goal]) =>
        `### ${id} ${goal}\n\n**设计依据**：§1。**依赖**：无。\n\n` +
        `**契约**：输入原始数据，输出规范化数据。\n\n**文件责任**：新增 \`src/${id.toLowerCase()}.ts\`。\n\n` +
        `- [ ] ${id} 的验收检查项一\n- [ ] ${id} 的验收检查项二\n\n**交付**：${goal}验收记录。\n`,
    )
    .join("\n");
  return (
    `# ${title}\n\n> 补修包 F 夹具施工图。\n\n## 当前任务\n\n` +
    `| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |\n| --- | --- | --- | --- | --- |\n${rows}\n\n${sections}`
  );
}

const DESIGN_TEXT = "# 夹具设计书\n\n## 1 概述\n\n补修包 F 夹具。\n";
const planA = planTextFor("补修 F 夹具 A", [
  ["T-1", "数据层"],
  ["T-2", "接口层"],
  ["T-3", "展示层"],
]);
const planB = planTextFor("补修 F 夹具 B", [["X-1", "唯一的卡"]]);
/** 夹具 C（F3 真链路）：四张卡分别用来验 版本过期 / 非法登记 / 旧调用兼容 / 版本轴真 HTTP（结果回报路径） */
const planC = planTextFor("补修 F 夹具 C", [
  ["M-1", "可体验入口（结果回报）"],
  ["M-2", "非法入口登记（反例）"],
  ["M-3", "旧调用兼容"],
  ["M-4", "版本轴真 HTTP（结果回报路径·清单绑定）"],
]);

/** 夹具 A/B/C 的施工图文本 */
const PLAN_OF: Record<string, string> = { [A]: planA, [B]: planB, [C]: planC };

/**
 * 真定义哈希（与写/读边界现读重算用的**同一份** `taskDefinitionHash`）。
 *
 * P2/V09-47 最终纠正：结果提交的锁内共享判据会按当前施工图**现读重算**定义绑定——夹具若继续拿
 * `sha256("<taskId>-def")` 这种假哈希冒充"已绑定义"，提交会被如实拒（那不是产品缺陷，是夹具在撒
 * 谎）。这里按真定义算：夹具不冒充定义绑定，也不要求产品放宽校验。
 */
function realDefinitionHash(project: string, taskId: string): string {
  const text = PLAN_OF[project];
  if (text === undefined) throw new Error(`夹具缺陷：没有 ${project} 的施工图文本`);
  const def = importTaskDefinitions(text, { plan_revision: sha256(text) }).definitions.find((d) => d.task_id === taskId);
  if (def === undefined) throw new Error(`夹具缺陷：${project} 的施工图里没有 ${taskId}`);
  return taskDefinitionHash({ ...def, change_id: null, requirement_ids: def.requirement_ids ?? null });
}

for (const root of [rootA, rootB, rootC]) mkdirp(root);
write(path.join(workbench(rootA), "plan.md"), planA);
write(path.join(workbench(rootA), "design.md"), DESIGN_TEXT);
write(path.join(workbench(rootB), "plan.md"), planB);
write(path.join(workbench(rootB), "design.md"), DESIGN_TEXT);
write(path.join(workbench(rootC), "plan.md"), planC);
write(path.join(workbench(rootC), "design.md"), DESIGN_TEXT);
write(path.join(dataDir, "registry.json"), JSON.stringify({
  version: 1,
  projects: [
    { id: A, name: "补修 F 夹具 A", path: rootA, kind: "fullstack", registered_at: "2026-09-20T00:00:00+08:00", last_opened_at: "2026-09-20T00:00:00+08:00" },
    { id: B, name: "补修 F 夹具 B", path: rootB, kind: "backend", registered_at: "2026-09-20T00:00:00+08:00", last_opened_at: "2026-09-20T00:00:00+08:00" },
    { id: C, name: "补修 F 夹具 C", path: rootC, kind: "backend", registered_at: "2026-09-20T00:00:00+08:00", last_opened_at: "2026-09-20T00:00:00+08:00" },
  ],
}, null, 2));
process.env.TATAI_HOME = dataDir;
ok(projectWorkDir(A, dataDir) === path.join(workbench(rootA), "work"), "夹具注册表可解析项目 work 目录");

const CODE_KIND: RevisionKind = "code";
const putEv = (summary: string, content: string, revision: string) =>
  putEvidence(projectWorkDir(A, dataDir), {
    content,
    kind: "acceptance",
    summary,
    created_by: "kimi-code",
    role: "executor",
    binding: { revision_kind: CODE_KIND, revision },
    source_ref: summary,
  });

const portListening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });

/** 向 OS 要一个空闲回环端口（就绪负例的真后端用；避免固定端口与并发跑冲突） */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });

function spawnServer(): ChildProcess {
  const proc = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT), TATAI_SEMANTIC_AUTO: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(proc);
  serverProc = proc;
  proc.stdout.on("data", (d: Buffer) => {
    if (process.env.TATAI_VERBOSE === "1") process.stdout.write(`[server] ${d.toString()}`);
  });
  proc.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));
  return proc;
}

/** 当前这一代后端进程（F3 的"重启后读回一致"要把它杀掉再起一个） */
let serverProc: ChildProcess | null = null;

/**
 * 就绪判据（**依产品真实就绪协议**，不是"/health 可达就算好"）：
 *
 * 2026-10-08 runtime 独审 REPORT-r3.md §6 确证：旧 `restartServer` 以 `/health` 可达当"重启完成"，
 * 随即 `readServiceDescriptor(dataDir)?.token ?? workToken` 取 token——但产品在 `server.listen` 绑上后
 * **立即应答 `/health`**，而"接管握手 ＋ 发布描述符"是 `listen` 回调里的**异步**流程
 * （`src/server/index.ts:4200-4298`）⇒ 存在"/health 已 OK 但描述符尚未（重）发布"的窗口；此时读到的是
 * **上一代宿主**的描述符（旧 pid ＋ 旧 token），缓存下来后写口 API 全 401/503（实测 11 次里 4 次 100/14）。
 *
 * 新的就绪条件（只等**本次**宿主真的成为唯一写宿主，两条同时满足）：
 *   ① 数据目录里的服务描述符**属于本次进程**（`desc.pid === proc.pid`）——描述符由产品在
 *      `publishUnderOwnershipLock` 里发布（`src/server/work/serviceOwnership.ts`）；
 *   ② 凭该描述符的 token 真能过写口所有权探活（`GET /api/work/health` 200）——旧 token / 未就绪一律 401/不可达。
 * `waitHostReady` 只在这个**具体条件**上有界轮询；超时**如实报错**（不固定 sleep、不用泛重试掩盖真实错误、
 * 不拿旧 token 继续写）。四状态（`4-0b-*` 就绪负例）用独立 tempDataDir＋独立端口**真后端**确定性证明
 * "旧条件过早、新条件不放行、旧 token 写被拒"。
 */
async function hostIsReady(dd: string, procPid: number): Promise<{ ready: boolean; why: string }> {
  const desc = readServiceDescriptor(dd);
  if (desc === null) return { ready: false, why: "数据目录里还没有服务描述符" };
  if (desc.pid !== procPid) {
    return { ready: false, why: `描述符仍指向**旧**宿主 pid=${desc.pid}（本次宿主 pid=${procPid}）——不拿它的 token` };
  }
  try {
    const r = await fetch(`http://${desc.host}:${desc.port}/api/work/health`, {
      headers: { [WORK_TOKEN_HEADER]: desc.token },
      signal: AbortSignal.timeout(3000),
    });
    return r.ok
      ? { ready: true, why: `描述符 pid=${desc.pid} ＋ token 写口探活 200` }
      : { ready: false, why: `描述符 pid=${desc.pid} 但写口所有权探活 HTTP ${r.status}（旧 token / 尚未就绪）` };
  } catch (e) {
    return { ready: false, why: `描述符 pid=${desc.pid} 但写口不可达：${(e as Error).message}` };
  }
}

async function waitHostReady(proc: ChildProcess, timeoutMs = 40_000): Promise<{ pid: number; token: string; port: number }> {
  const deadline = Date.now() + timeoutMs;
  let why = "尚未开始";
  for (;;) {
    const st = await hostIsReady(dataDir, proc.pid ?? -1);
    if (st.ready) {
      const desc = readServiceDescriptor(dataDir);
      if (desc !== null) return { pid: desc.pid, token: desc.token, port: desc.port };
      why = "探活通过但描述符读不到（竞态），继续等";
    } else {
      why = st.why;
    }
    if (Date.now() > deadline) {
      throw new Error(`写入服务就绪超时（${timeoutMs}ms，判据＝本次宿主描述符 pid＋token＋写口所有权探活）：${why}`);
    }
    await sleep(100);
  }
}

/** 杀净当前后端并重新起一个（同一数据目录、同一端口）：验"事实落盘了、不是只活在内存里" */
async function restartServer(): Promise<void> {
  serverProc?.kill("SIGKILL");
  for (let i = 0; i < 80; i++) {
    if (!(await portListening(PORT))) break;
    await sleep(100);
  }
  const proc = spawnServer();
  // 新一代后端有自己的服务描述符：等**本次**宿主（描述符 pid＋token＋写口所有权探活）就绪再刷新凭据，
  // 不用"/health 可达"当就绪（旧写法会缓存上一代 token ⇒ 401/503，见上面 hostIsReady 说明）
  const ready = await waitHostReady(proc);
  workToken = ready.token;
}

/**
 * 确定性就绪延迟负例（4-0b）：证明旧"/health 可达"条件**过早**、新条件在描述符陈旧/服务未就绪时**不放行**，
 * 且此时凭**旧 token** 写会被拒（"不会用旧 token 写"）。
 *
 * 做法（不依赖时序碰运气、不用固定 sleep）：用**独立 tempDataDir ＋ 独立端口**起一个**真后端**；等它发布
 * 自己的描述符（新宿主 pid/token）后，把描述符**替换成"陈旧宿主"**（另一个 pid ＋ 错误 token）——这正是
 * "/health 已 OK、但描述符尚未（重）发布"这一窗口的精确复现。随后逐条核：旧条件仍成立、新条件不放行、
 * 旧 token 写被拒；恢复本次描述符后新条件才为真。只动独立临时目录，判据用产品自己的描述符＋token 写口。
 */
async function readinessNegativeCase(): Promise<void> {
  const negHome = path.join(tmpBase, "neg-home");
  mkdirp(negHome);
  const negPort = await freePort();
  const proc = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: negHome, TATAI_PORT: String(negPort), TATAI_SEMANTIC_AUTO: "0", TATAI_NO_AUTOSTART: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(proc);
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", () => {});
  const pid = proc.pid ?? -1;
  try {
    const deadline = Date.now() + 40_000;
    let newDesc: WorkServiceDescriptor | null = null;
    while (Date.now() < deadline) {
      const d = readServiceDescriptor(negHome);
      if (d !== null && d.pid === pid) {
        newDesc = d;
        break;
      }
      await sleep(100);
    }
    if (newDesc === null) {
      ok(false, "4-0b 就绪负例：真后端 40s 内未发布自己的描述符（无法构造负例）");
      return;
    }
    const goodDesc = newDesc;

    // 把描述符替换成"陈旧宿主"（另一个 pid ＋ 错误 token）——复现"新宿主尚未发布描述符"的窗口
    const staleDesc: WorkServiceDescriptor = { ...goodDesc, pid: pid + 100000, token: "0".repeat(64) };
    writeServiceDescriptor(negHome, staleDesc);

    // 旧条件：/health 可达（与描述符无关，此刻仍为真）——单看它无法区分新旧宿主 ⇒ 过早
    const health = await fetch(`http://127.0.0.1:${negPort}/health`).catch(() => null);
    // 新条件：描述符 pid ≠ 本次进程 ⇒ 不放行
    const staleSt = await hostIsReady(negHome, pid);
    // 凭**陈旧 token** 走真写口：必须被拒（非 200）
    const staleWrite = await fetch(`http://127.0.0.1:${negPort}/api/work/command`, {
      method: "POST",
      headers: { "content-type": "application/json", [WORK_TOKEN_HEADER]: staleDesc.token },
      body: JSON.stringify({
        schema_version: 2,
        project_id: A,
        change_id: CHG,
        entity_id: "neg:probe",
        expected_revision: null,
        type: "task.definition_imported",
        actor_id: "neg",
        role: "executor",
        idempotency_key: `neg:probe:${Date.now()}`,
        payload: {},
      }),
    }).catch(() => null);

    // 恢复本次宿主描述符 ⇒ 新条件才为真
    writeServiceDescriptor(negHome, goodDesc);
    const restoredSt = await hostIsReady(negHome, pid);

    ok(
      health !== null && health.ok,
      `4-0b-1 旧就绪条件（只看 /health 可达）在描述符仍是**陈旧宿主**时也成立 ⇒ **过早**（HTTP ${health?.status}）`,
    );
    ok(!staleSt.ready, `4-0b-2 新就绪条件在**陈旧描述符**下不放行：${staleSt.why}（旧写法会拿旧 token 继续写）`);
    ok(
      staleWrite !== null && staleWrite.status !== 200,
      `4-0b-3 凭**陈旧 token** 走真写口被拒（HTTP ${staleWrite === null ? "不可达" : staleWrite.status}）——"不会用旧 token 写"`,
    );
    ok(restoredSt.ready, `4-0b-4 恢复**本次**宿主描述符后才就绪：${restoredSt.why}`);
  } finally {
    try {
      proc.kill("SIGKILL");
    } catch {
      // 已退出
    }
  }
}

const api = async (p: string, init?: RequestInit): Promise<{ status: number; body: any; text: string }> => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, init);
  const text = await r.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body, text };
};
const postJson = (p: string, body: unknown) =>
  api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * 读口之外的**直接证据**：状态投影里的两个版本槽（契约 F4，`src/server/work/statusProjection.ts:2002–2007`）。
 *   · `code` = **当前可核对**的代码版本：**不能来自账本里的自报**，只有调用方显式给 `code_revision` 才有值，
 *     产品读口默认 `null`（= "当前源码未知，代码/版本一律待复核"）；
 *   · `code_declared` = 账本里**自报**的最近一次声明版本（两源同权 `latestCodeBindingRevision`），
 *     **只作展示**，绝不当"当前版本"。
 * 所以"两源同权、实际发生时间优先"的可核证据是 `code_declared`；`code` 恒 null 才符合 F4（自报不自证）。
 */
const revisionsOf = async (project: string): Promise<{ code: string | null; code_declared: string | null }> => {
  const r = (await api(`/api/projects/${project}/status-projection`)).body?.projection?.revisions ?? {};
  return { code: r.code ?? null, code_declared: r.code_declared ?? null };
};

/**
 * 错误信封有两种形状（都得认，别把"读错字段"当成"没报错"）：
 *   · 工作台数据面（`/api/projects/*`，`wsFail`）→ `{ok:false, error:{code,message}}`；
 *   · 写入面（`/api/work/*`，`workHost`）→ `{ok:false, code, message, detail}`（唯一写入服务的对外口径）。
 */
const errCodeOfBody = (body: any): string => String(body?.code ?? body?.error?.code ?? "<无码>");
const errMessageOfBody = (body: any): string => String(body?.message ?? body?.error?.message ?? "");

let workToken = "";
let idemSeq = 0;
const submitCommand = async (input: {
  project: string;
  type: string;
  entity_id: string;
  expected_revision: number | null;
  payload: Record<string, unknown>;
  occurred_at?: string;
  actor?: string;
  role?: string;
}): Promise<{ status: number; body: any; text: string }> =>
  api("/api/work/command", {
    method: "POST",
    headers: { "content-type": "application/json", "x-tatai-work-token": workToken },
    body: JSON.stringify({
      schema_version: 2,
      project_id: input.project,
      change_id: CHG,
      entity_id: input.entity_id,
      expected_revision: input.expected_revision,
      type: input.type,
      actor_id: input.actor ?? "kimi-code",
      role: input.role ?? "executor",
      idempotency_key: `${input.entity_id}:${input.type}:${++idemSeq}:${CHG}`,
      ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
      payload: input.payload,
    }),
  });

/** 夹具事实：定义导入 + 执行状态（读侧要 task_states 才有任务卡） */
async function seedTask(project: string, taskId: string, planRev: string): Promise<void> {
  const def = await submitCommand({
    project,
    type: "task.definition_imported",
    entity_id: `task:${taskId}`,
    expected_revision: null,
    payload: { definition_sha256: realDefinitionHash(project, taskId), plan_revision: planRev, definition_revision: 1 },
  });
  if (def.status !== 200) throw new Error(`task.definition_imported ${taskId} 失败：${def.status} ${def.text}`);
  const st = await submitCommand({
    project,
    type: "task.status_changed",
    entity_id: `task:${taskId}`,
    expected_revision: 1,
    payload: { status: "executing" },
  });
  if (st.status !== 200) throw new Error(`task.status_changed ${taskId} 失败：${st.status} ${st.text}`);
}

const acceptanceOf = async (project: string) => (await api(`/api/projects/${project}/acceptance`)).body?.acceptance;
const entryOf = (acc: any, scenario: string) =>
  (acc?.runtime_entries ?? []).find((e: any) => e.scenario === scenario) ?? null;
const taskOf = (acc: any, taskId: string) => (acc?.tasks ?? []).find((t: any) => t.task_id === taskId) ?? null;

// ══════════════════════════════════════════════════════════════════════════════
// ① 纯口径：登记形状、校验、状态判定、概况（零 IO、零后端）
// ══════════════════════════════════════════════════════════════════════════════
function pureChecks(): void {
  info("── ① 运行入口纯口径（登记形状 / 校验 / 状态 / 概况）");
  ok(
    RUNTIME_ENTRY_URL_PROTOCOLS.join(",") === "http,https" &&
      isRuntimeEntryUrl("http://127.0.0.1:5173/") &&
      isRuntimeEntryUrl("https://example.com/app") &&
      !isRuntimeEntryUrl("javascript:alert(1)") &&
      !isRuntimeEntryUrl("file:///C:/x.html") &&
      !isRuntimeEntryUrl("data:text/html,hi") &&
      !isRuntimeEntryUrl("mailto:a@b.c") &&
      !isRuntimeEntryUrl("/relative/path") &&
      !isRuntimeEntryUrl(""),
    "①-1 协议白名单只有 http(s)：javascript:/file:/data:/mailto:/相对路径/空串全部不是可体验入口",
  );

  const good = parseRuntimeEntries(
    [{ scenario: "下单流程", url: "http://127.0.0.1:5173/", verified_at: "2026-09-20T10:00:00+08:00", status: "reachable", reason: null }],
    { event_id: "e1", record_id: "sub-1" },
  );
  ok(
    good.length === 1 &&
      good[0].scenario === "下单流程" &&
      good[0].url === "http://127.0.0.1:5173/" &&
      good[0].status === "reachable",
    `①-2 合法登记解析：场景/入口/验证时间/结果四项齐全（${good[0]?.scenario}）`,
  );

  const code = (fn: () => unknown): string => {
    try {
      fn();
      return "<no-error>";
    } catch (e) {
      return isWorkError(e) ? e.code : `<thrown:${(e as Error).name}>`;
    }
  };
  const ctx = { event_id: "e1", record_id: "sub-1" };
  ok(
    code(() => parseRuntimeEntries([{ url: "http://x/", verified_at: "2026-09-20T10:00:00+08:00", status: "reachable" }], ctx)) === "EVENT_INVALID" &&
      code(() => parseRuntimeEntries([{ scenario: "s", verified_at: "2026-09-20T10:00:00+08:00", status: "reachable" }], ctx)) === "EVENT_INVALID" &&
      code(() => parseRuntimeEntries([{ scenario: "s", url: "http://x/", status: "reachable" }], ctx)) === "EVENT_INVALID" &&
      code(() => parseRuntimeEntries([{ scenario: "s", url: "http://x/", verified_at: "2026-09-20T10:00:00+08:00" }], ctx)) === "EVENT_INVALID",
    "①-3 缺 scenario/url/verified_at/status 任一 → EVENT_INVALID（宁可红，也不静默丢一条入口）",
  );
  const badUrls = ["javascript:alert(1)", "file:///C:/secret.txt", "data:text/html,<b>x</b>", "blob:http://x/y"].map((u) =>
    code(() => parseRuntimeEntries([{ scenario: "s", url: u, verified_at: "2026-09-20T10:00:00+08:00", status: "reachable" }], ctx)),
  );
  ok(
    badUrls.every((c) => c === "EVENT_INVALID"),
    `①-4 非 http(s) 的入口地址被**同一套校验**拒绝（写侧与读侧共用 parseRuntimeEntries；${badUrls.join("/")}）：其余协议连登记都不接受`,
  );
  ok(
    code(() => parseRuntimeEntries([{ scenario: "s", url: "http://x/", verified_at: "刚刚", status: "reachable" }], ctx)) === "EVENT_INVALID" &&
      code(() => parseRuntimeEntries([{ scenario: "s", url: "http://x/", verified_at: "2026-09-20T10:00:00+08:00", status: "unreachable" }], ctx)) ===
        "EVENT_INVALID" &&
      code(() => parseRuntimeEntries("not-an-array", ctx)) === "EVENT_INVALID",
    "①-5 时间解析不出 / 非 reachable 却没写不可用原因 / runtime_entries 不是数组 → 一律 EVENT_INVALID",
  );
  ok(parseRuntimeEntries(undefined, ctx).length === 0, "①-6 没声明 runtime_entries（字段缺省）＝ 这次成果没有入口，不是错误");
  ok(
    parseRuntimeEntries(null, ctx).length === 0,
    "①-6b 读侧对**历史里的 null** 也按「没声明」容忍（不抛、不 500）——这正是写侧比读侧严的地方：" +
      "写侧一律拒 null（见 ⑥-12 / ⑥-15），读侧不能因为这次收紧就让历史项目整体打不开",
  );

  const now = Date.parse("2026-09-20T12:00:00+08:00");
  const freshEntry = { status: "reachable" as const, verified_at: "2026-09-20T11:00:00+08:00" };
  /** 验证时间早于复核提醒阈值（裁定 F2 起：这只是"该复核了"，**不是**失效） */
  const overdueEntry = {
    status: "reachable" as const,
    verified_at: new Date(now - RUNTIME_ENTRY_REVIEW_MS - 60_000).toISOString(),
  };
  const fresh = runtimeEntryStateOf(freshEntry, now);
  const overdue = runtimeEntryStateOf(overdueEntry, now);
  const dead = runtimeEntryStateOf({ status: "unreachable", verified_at: "2026-09-20T11:00:00+08:00" }, now);
  const unknown = runtimeEntryStateOf({ status: "unknown", verified_at: "2026-09-20T11:00:00+08:00" }, now);
  ok(
    fresh.state === "openable" && fresh.openable === true &&
      overdue.state === "reverify_due" && overdue.openable === true &&
      dead.state === "failed" && dead.openable === false && unknown.state === "unknown" && unknown.openable === false,
    `①-7 状态判定（裁定 F2）：新验证的可打开 / 超 ${RUNTIME_ENTRY_REVIEW_MS / 3600_000}h 只标「待重新验证」且**仍可打开** / 探测失败失效 / 结果未知`,
  );

  // ── 裁定 F2：超阈值只提醒复核，不判不可达、不撤打开入口 ──
  const dueViews = runtimeEntryViews(
    [
      {
        kind: "submission",
        record_id: "sub-due",
        task_id: "T-1",
        submitted_by: "kimi-code",
        at: "2026-09-20T09:00:00+08:00",
        revision: "code-rev-1",
        revision_kind: "code",
        entries: parseRuntimeEntries(
          [{ scenario: "待复核入口", url: "http://127.0.0.1:5173/", verified_at: overdueEntry.verified_at, status: "reachable", reason: null }],
          ctx,
        ),
      },
    ],
    now,
  );
  ok(
    dueViews.length === 1 &&
      dueViews[0].state === "reverify_due" &&
      dueViews[0].openable === true &&
      dueViews[0].state_label.includes("待重新验证") &&
      !(RUNTIME_ENTRY_STATES as readonly string[]).includes("expired") &&
      RUNTIME_ENTRY_STATES.join(",") === "openable,reverify_due,failed,unknown",
    `①-8 超复核提醒阈值 → reverify_due 且 openable=true、文案写「待重新验证」；状态词表里**没有 expired**（超时不是入口失效）：${RUNTIME_ENTRY_STATES.join("/")}`,
  );

  ok(
    runtimeEntryRevisionStateOf("code-rev-1", "code-rev-1") === "current" &&
      runtimeEntryRevisionStateOf("code-rev-1", "code-rev-2") === "outdated" &&
      runtimeEntryRevisionStateOf("code-rev-2", "code-rev-1") === "outdated" &&
      runtimeEntryRevisionStateOf(null, "code-rev-1") === "unknown" &&
      runtimeEntryRevisionStateOf("code-rev-1", null) === "unknown" &&
      runtimeEntryRevisionStateOf("", "code-rev-1") === "unknown" &&
      runtimeEntryRevisionStateOf("code-rev-1", "   ") === "unknown",
    "①-9 版本轴四分（裁定 F2 ③）：一致=current / 不一致=outdated（两个方向都算）/ 任一侧 null 或空白=unknown（不猜成 current、也不猜成 outdated）",
  );

  const bothAxes = runtimeEntryViews(
    [
      {
        kind: "submission",
        record_id: "sub-both",
        task_id: "T-1",
        submitted_by: "kimi-code",
        at: "2026-09-20T09:00:00+08:00",
        revision: "code-rev-1",
        revision_kind: "code",
        entries: parseRuntimeEntries(
          [{ scenario: "两轴同时命中", url: "http://127.0.0.1:5173/", verified_at: overdueEntry.verified_at, status: "reachable", reason: null }],
          ctx,
        ),
      },
    ],
    now,
    { reviewMs: RUNTIME_ENTRY_REVIEW_MS, currentRevision: "code-rev-2" },
  );
  ok(
    bothAxes.length === 1 &&
      bothAxes[0].state === "reverify_due" &&
      bothAxes[0].revision_state === "outdated" &&
      bothAxes[0].source_revision === "code-rev-1" &&
      bothAxes[0].openable === true &&
      bothAxes[0].revision_label.includes("成果版本已过期"),
    "①-10 两条轴互不覆盖：同一条入口可以既「待重新验证」又「成果版本过期」，且**仍然可打开**（超时不降级、版本过期不把入口标成不可达）",
  );

  const dueSummary = runtimeEntrySummaryOf(dueViews);
  ok(
    dueSummary.kind === "available" &&
      dueSummary.total === 1 &&
      dueSummary.reverify_due_count === 1 &&
      dueSummary.can_open_count === 1 &&
      dueSummary.fresh_count === 0 &&
      dueSummary.failed_count === 0 &&
      dueSummary.unknown_count === 0 &&
      dueSummary.note.includes("待重新验证"),
    `①-11 只有「待重新验证」入口时项目概况**不因超时降级**：kind=${dueSummary.kind}（不是 unavailable/stale）、reverify_due_count=1、can_open_count=1`,
  );

  const mixedViews = runtimeEntryViews(
    [
      {
        kind: "submission",
        record_id: "sub-old",
        task_id: "T-1",
        submitted_by: "kimi-code",
        at: "2026-09-20T11:30:00+08:00",
        revision: "code-rev-1",
        revision_kind: "code",
        entries: parseRuntimeEntries(
          [{ scenario: "旧版入口", url: "http://127.0.0.1:5173/old", verified_at: freshEntry.verified_at, status: "reachable", reason: null }],
          ctx,
        ),
      },
      {
        kind: "submission",
        record_id: "sub-cur",
        task_id: "T-2",
        submitted_by: "kimi-code",
        at: "2026-09-20T11:40:00+08:00",
        revision: "code-rev-2",
        revision_kind: "code",
        entries: parseRuntimeEntries(
          [{ scenario: "当前版入口", url: "http://127.0.0.1:5173/cur", verified_at: freshEntry.verified_at, status: "reachable", reason: null }],
          ctx,
        ),
      },
    ],
    now,
    { reviewMs: RUNTIME_ENTRY_REVIEW_MS, currentRevision: "code-rev-2" },
  );
  const mixedSummary = runtimeEntrySummaryOf(mixedViews);
  ok(
    mixedSummary.outdated_count === 1 &&
      mixedSummary.can_open_count === 2 &&
      mixedSummary.fresh_count === 2 &&
      mixedViews.every((v) => v.openable === true),
    `①-12 版本过期限**单独计数**且与可打开计数**可以重叠**：${mixedSummary.can_open_count} 条都能打开、其中 ${mixedSummary.outdated_count} 条绑的是旧版本（两个数各说各的事）`,
  );
  ok(
    !("openable_count" in mixedSummary) && !("expired_count" in mixedSummary) && !("expired_count" in dueSummary),
    "①-13 概况字段里没有旧档案（openable_count / expired_count）：换的是口径，不是新旧两套并存",
  );

  // ── 裁定 F3：Agent 结果回报也能登记入口（折成来源的口径）──
  const resultSources = resultSubmittedSources([
    {
      event_id: "e-late",
      type: "task.result_submitted",
      seq: 9,
      entity_id: "task:M-9",
      actor_id: "kimi-code",
      received_at: "2026-09-20T11:50:00+08:00",
      payload: {
        result_revision: "code-rev-late",
        runtime_entries: [
          { scenario: "结果回报入口甲", url: "http://127.0.0.1:5173/a", verified_at: "2026-09-20T11:50:00+08:00", status: "reachable" },
        ],
      },
    },
    {
      event_id: "e-none",
      type: "task.result_submitted",
      seq: 7,
      entity_id: "task:M-7",
      actor_id: "kimi-code",
      received_at: "2026-09-20T11:40:00+08:00",
      payload: { result_revision: "code-rev-none" },
    },
    {
      event_id: "e-norev",
      type: "task.result_submitted",
      seq: 5,
      entity_id: "task:M-5",
      actor_id: "kimi-code",
      received_at: "2026-09-20T11:30:00+08:00",
      payload: {
        runtime_entries: [
          { scenario: "结果回报入口丙", url: "http://127.0.0.1:5173/c", verified_at: "2026-09-20T11:30:00+08:00", status: "reachable" },
        ],
      },
    },
    {
      event_id: "e-early",
      type: "task.result_submitted",
      seq: 3,
      entity_id: "task:M-3",
      actor_id: "kimi-code",
      received_at: "2026-09-20T11:10:00+08:00",
      payload: {
        result_revision: "code-rev-early",
        runtime_entries: [
          { scenario: "结果回报入口乙", url: "http://127.0.0.1:5173/b", verified_at: "2026-09-20T11:10:00+08:00", status: "unreachable", reason: "夹具：进程已结束" },
        ],
      },
    },
    {
      event_id: "e-audit",
      type: "audit.submission_submitted",
      seq: 1,
      entity_id: "submission:sub-1",
      actor_id: "kimi-code",
      received_at: "2026-09-20T11:00:00+08:00",
      payload: {
        runtime_entries: [
          { scenario: "成果登记入口", url: "http://127.0.0.1:5173/d", verified_at: "2026-09-20T11:00:00+08:00", status: "reachable" },
        ],
      },
    },
  ]);
  ok(
    resultSources.length === 3 &&
      resultSources.map((s) => s.record_id).join(",") === "result:e-early,result:e-norev,result:e-late" &&
      resultSources.every((s) => s.kind === "result_submitted" && s.submitted_by === "kimi-code") &&
      resultSources[0].task_id === "M-3" &&
      resultSources[0].revision === "code-rev-early" &&
      resultSources[0].revision_kind === "code" &&
      resultSources[0].entries[0].scenario === "结果回报入口乙" &&
      resultSources[1].revision === null &&
      resultSources[1].revision_kind === null &&
      resultSources[2].entries[0].scenario === "结果回报入口甲",
    "①-14 结果回报折成入口来源（F3）：只认 task.result_submitted、没声明 runtime_entries 的不产生来源、按 seq 升序、版本取 result_revision（缺省就 null）",
  );

  const views = runtimeEntryViews(
    [
      {
        kind: "submission",
        record_id: "sub-1",
        task_id: "T-1",
        submitted_by: "kimi-code",
        at: "2026-09-20T11:30:00+08:00",
        revision: "code-rev-1",
        revision_kind: "code",
        entries: good,
      },
      {
        kind: "submission",
        record_id: "sub-2",
        task_id: null,
        submitted_by: "kimi-code",
        at: "2026-09-20T11:40:00+08:00",
        revision: null,
        revision_kind: null,
        entries: parseRuntimeEntries(
          [{ scenario: "老入口", url: "http://127.0.0.1:9/dead", verified_at: "2026-09-19T11:00:00+08:00", status: "unreachable", reason: "进程已结束" }],
          ctx,
        ),
      },
    ],
    now,
  );
  ok(
    views.length === 2 &&
      views.every((v) => v.source_revision !== undefined) &&
      views.every((v) => v.source_kind === "submission") &&
      views.find((v) => v.scenario === "下单流程")?.source_revision === "code-rev-1" &&
      views.find((v) => v.scenario === "下单流程")?.source_record_id === "sub-1",
    "①-15 装配带**来源成果与版本**（哪条成果、哪一版、哪条路径来的），没声明版本就 null、不编造",
  );
  ok(
    runtimeEntrySummaryOf(views).kind === "available" &&
      runtimeEntrySummaryOf(views).can_open_count === 1 &&
      runtimeEntrySummaryOf(views).fresh_count === 1 &&
      runtimeEntrySummaryOf(views).reverify_due_count === 0 &&
      runtimeEntrySummaryOf(views.filter((v) => v.openable)).kind === "available",
    "①-16 有一条可打开 → available（概况里可打开数与「实测在阈值内」分开数）",
  );
  const allDead = runtimeEntryViews(
    [
      {
        kind: "submission",
        record_id: "sub-2",
        task_id: null,
        submitted_by: "kimi-code",
        at: "2026-09-19T11:40:00+08:00",
        revision: null,
        revision_kind: null,
        entries: parseRuntimeEntries(
          [{ scenario: "老入口", url: "http://127.0.0.1:9/dead", verified_at: "2026-09-19T11:00:00+08:00", status: "unreachable", reason: "进程已结束" }],
          ctx,
        ),
      },
    ],
    now,
  );
  const deadSummary = runtimeEntrySummaryOf(allDead);
  const emptySummary = runtimeEntrySummaryOf([]);
  ok(
    emptySummary.kind === "unavailable" && emptySummary.note.includes("尚不可体验") && emptySummary.total === 0,
    `①-17 没有任何登记 → 「尚不可体验」（与"登记过但不可用"分开说）：${emptySummary.note.slice(0, 24)}…`,
  );
  ok(
    deadSummary.kind === "stale" && deadSummary.note.includes("探测失败") && !deadSummary.note.includes("尚不可体验："),
    `①-18 登记过但都不可用 → stale 且逐条说明状态：${deadSummary.note.slice(0, 30)}…`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ② 受控打开：只允许 http(s)（纯决策层，**不真开窗口**）
// ══════════════════════════════════════════════════════════════════════════════
function openChecks(): void {
  info("── ② 受控打开（协议白名单 + 壳内/浏览器两条路）");
  const refused = ["javascript:alert(1)", "file:///C:/secret.txt", "data:text/html,<b>x</b>", "mailto:a@b.c", "/relative", "", "   "];
  const plans = refused.map((u) => resultEntryOpenPlan(u, { shell: false }));
  ok(
    plans.every((p) => p.open === false && p.url === null && p.via === null && (p.reason ?? "").includes("http(s)")),
    `②-1 ${refused.length} 个非 http(s)/空地址**一律拒绝打开**（open=false、url=null、不发任何打开动作）`,
  );
  const browser = resultEntryOpenPlan("http://127.0.0.1:5173/", { shell: false });
  const shell = resultEntryOpenPlan("http://127.0.0.1:5173/", { shell: true });
  ok(
    browser.open === true && browser.via === "browser_tab" && shell.open === true && shell.via === "shell_browser",
    `②-2 http(s) 才放行：浏览器走新标签页降级、壳内走系统浏览器（${browser.via} / ${shell.via}）`,
  );
  const caps = JSON.parse(fs.readFileSync(path.join(REPO, "src-tauri", "capabilities", "default.json"), "utf8")) as {
    permissions: (string | { identifier: string; allow?: { url?: string }[] })[];
  };
  const openerPerms = caps.permissions.filter(
    (p) => typeof p === "string" ? p.startsWith("opener:") : p.identifier.startsWith("opener:"),
  );
  const openerEntry = openerPerms.find((p) => typeof p !== "string" && p.identifier === "opener:allow-open-url") as
    | { identifier: string; allow?: { url?: string }[] }
    | undefined;
  const allowUrls = (openerEntry?.allow ?? []).map((a) => a.url ?? "");
  ok(
    openerPerms.length === 1 &&
      openerEntry !== undefined &&
      allowUrls.length === 2 &&
      allowUrls.every((u) => u.startsWith("http://*") || u.startsWith("https://*")),
    `②-3 壳权限清单只放行 open_url 一条且范围限 http(s)（没有 opener:default）：${allowUrls.join(" / ")}`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ③ 路由与登记面（写口是已登记的唯一写入服务面；本包零新增路由/零新增事件类型）
// ══════════════════════════════════════════════════════════════════════════════
function routeChecks(): void {
  info("── ③ 写口/读口的登记对账（防漂移）");
  const workCommand = REMOTE_ROUTES.find((r) => r.id === "work-command") ?? null;
  ok(
    workCommand !== null && workCommand.kind === "write" && workCommand.method === "POST",
    "③-1 登记入口的写口＝唯一写入服务面 POST /api/work/command（已登记为 write，只读模式下会被拒）",
  );
  const indexSrc = fs
    .readFileSync(path.join(REPO, "src", "server", "index.ts"), "utf8")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const acceptRead = REMOTE_ROUTES.find((r) => r.id === "acceptance-read") ?? null;
  const anchorHits = acceptRead === null ? -1 : acceptRead.anchors.filter((a) => indexSrc.includes(a)).length;
  ok(
    acceptRead !== null && anchorHits === acceptRead.anchors.length && acceptRead.note.includes("可体验运行入口"),
    `③-2 读口 GET /api/projects/:id/acceptance 的锚点唯一命中（${anchorHits}/${acceptRead?.anchors.length ?? 0}），note 已写明新增的可体验入口字段`,
  );
  ok(
    REMOTE_ROUTES.every((r) => !r.id.startsWith("runtime")) && routeMentionTotal() === REMOTE_ROUTES.reduce((n, r) => n + (r.mentions ?? 1), 0),
    `③-3 本包**零新增路由**（没有 runtime 路由；清单提及总数与逐条相加一致：${routeMentionTotal()}）`,
  );
  const subReg = REGISTERED_EVENT_TYPES.find((r) => r.type === "audit.submission_submitted");
  const resultReg = REGISTERED_EVENT_TYPES.find((r) => r.type === "task.result_submitted");
  ok(
    subReg !== undefined &&
      subReg.payload.includes("runtime_entries") &&
      resultReg !== undefined &&
      resultReg.payload.includes("runtime_entries") &&
      !REGISTERED_EVENT_TYPES.some((r) => r.type.startsWith("runtime.")) &&
      AUDIT_EVENT_TYPES.includes("audit.submission_submitted"),
    "③-4 登记挂在**既有事件**上（audit.submission_submitted 与 F3 的 task.result_submitted 各按可选 payload 追加 runtime_entries）——两条写入路径都零新增事件类型",
  );
  ok(
    WORK_ERROR_CODES.includes("EVENT_INVALID"),
    "③-5 非法登记复用既有错误码 EVENT_INVALID（不新增错误码）",
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ⑥ 裁定 F3 真链路：MCP 提交 → 持久化 → 验收页面显示 → 打开入口（夹具 C）
//    真 MCP 客户端子进程（stdio）+ 真认领 + 真结果回报 + 真 HTTP 读口。按 2026-09-20 第二轮裁定 3 重排：
//      ① 两源同权（更晚的结果回报就是"当前版本"，绑它的入口 current、更早的成果登记 outdated）；
//      ② 版本过期仍判得出来（再追加一条更晚、不声明入口的成果登记 ⇒ 同一入口变 outdated 且仍可打开）；
//      ③ 重启后端再读，逐字段一致（字段含 revision_state）；
//      ④ 写入侧统一拒绝（非法 / 显式 null 在写侧即拒、事件文件零新增，成果登记与 MCP 结果回报两路各验）；
//      ⑤ 旧调用兼容（不带 runtime_entries 的回报，行为与载荷键集合都照旧）；
//      ⑥ 读侧闸门仍在：**直接往夹具 events.jsonl 末尾追加**一条构造好的历史坏记录 → 读口 500 EVENT_INVALID，
//         再逐级修好 → 读口恢复 200（历史坏记录可追溯、不静默丢）。
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 只导入卡定义（卡停在 preparing，正是"可领取"的队列状态）：F3 的 MCP 认领要真领得到。
 * 返回**导入回执里的实体版本**——它就认领要带的 `expected_revision`（唯一写入服务按它做原子版本检查）。
 * 说明：本夹具没有激活成套图纸基线，所以不走 `project_entry` 取版本（无基线时它按 §2.9 返回
 * `await_decision`，不派新任务）；认领与版本检查本身照样是真路径、真原子写。
 */
async function seedDefinitionOnly(project: string, taskId: string, planRev: string): Promise<number> {
  const def = await submitCommand({
    project,
    type: "task.definition_imported",
    entity_id: `task:${taskId}`,
    expected_revision: null,
    payload: { definition_sha256: realDefinitionHash(project, taskId), plan_revision: planRev, definition_revision: 1 },
  });
  if (def.status !== 200) throw new Error(`task.definition_imported ${taskId} 失败：${def.status} ${def.text}`);
  const rev = def.body?.entity_revision;
  if (typeof rev !== "number") throw new Error(`task.definition_imported ${taskId} 回执里没有实体版本：${def.text}`);
  return rev;
}

/** 夹具 C 上结果回报声明的入口场景（读口按场景名找，改名要同步断言） */
const M1_SCENARIO = "M-1 可体验入口（结果回报）";
const M2_A_SCENARIO = "M-2 入口甲（非法 url）";
const M2_B_SCENARIO = "M-2 入口乙（非法时间）";
const SUB_ENTRY_SCENARIO = "C 成果登记入口（版本一致）";
/** 版本 A：只来自**成果登记** `binding.revision`（旧口径下它就是"当前版本"） */
const CODE_REV_C = "code-rev-C";
/**
 * 版本 B：只来自**MCP 结果回报**的 `result_revision`——它比版本 A **更晚**发生。
 * 裁定 3（两源同权）之后它就是"当前版本"；旧口径只认成果登记，于是它会被判成 outdated。
 * 这两条一正一反，正是"两源同权"能不能成立的分水岭。
 */
const CODE_REV_MCP_B = "code-rev-mcp-b";
/** 版本 C：再晚一步的**成果登记**（且**不声明入口**）——用来证明"版本过期仍判得出来" */
const CODE_REV_C_LATER = "code-rev-C-later";

interface McpCallResult {
  isError: boolean;
  text: string;
  json: any;
}

interface FMcpClient {
  client: Client;
  call: (name: string, args: Record<string, unknown>) => Promise<McpCallResult>;
  close: () => Promise<void>;
}

const mcpClients: FMcpClient[] = [];

/** 真起一个 stdio MCP 客户端子进程（隔离 TATAI_HOME；接法与 verify-v06-10 一致） */
async function startMcp(name: string): Promise<FMcpClient> {
  const tsxCli = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [tsxCli, path.join(REPO, "src", "mcp", "index.ts")],
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: dataDir } as Record<string, string>,
    stderr: "inherit",
  });
  const client = new Client({ name, version: "0.0.1" });
  await client.connect(transport);
  const call = async (tool: string, args: Record<string, unknown>): Promise<McpCallResult> => {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = Array.isArray(r.content)
      ? r.content
          .filter((c): c is { type: "text"; text: string } => (c as { type: string }).type === "text")
          .map((c) => c.text)
          .join("\n")
      : "";
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { isError: r.isError === true, text, json };
  };
  const wrapper: FMcpClient = {
    client,
    call,
    close: async () => {
      try {
        await client.close();
      } catch {
        // 关不上不影响断言
      }
    },
  };
  mcpClients.push(wrapper);
  return wrapper;
}

/** 重启后必须逐字段一致的那几项（场景/入口/状态/可打开/版本轴/来源记录） */
const restartFieldsOf = (acc: any): string[] =>
  (acc?.runtime_entries ?? [])
    .map((e: any) => `${e.scenario}|${e.url}|${e.state}|${e.openable}|${e.revision_state}|${e.source_record_id}`)
    .sort();

const occurrencesOf = (text: string, needle: string): number => text.split(needle).length - 1;

async function mcpResultEntryChecks(opts: { freshIso: string; staleIso: string }): Promise<void> {
  info("── ⑥ 裁定 F3 真链路：MCP 提交 → 持久化 → 验收页面显示 → 打开入口");
  const mcp = await startMcp("v0608f-f3");
  const tools = (await mcp.client.listTools()).tools.map((t) => t.name);
  ok(
    tools.includes("submit_task_result") && tools.includes("claim_task"),
    `⑥-1 真起 stdio MCP 客户端（共 ${tools.length} 个工具）：结果回报走既有 submit_task_result（不另造工具、不另造存储）`,
  );

  /** 三张卡各自的当前实体版本（定义导入回执给的，认领时当 expected_revision） */
  const revOf: Record<string, number> = {};
  for (const t of ["M-1", "M-2", "M-3"]) revOf[t] = await seedDefinitionOnly(C, t, sha256(planC));
  const evC = putEvidence(projectWorkDir(C, dataDir), {
    content: "$ pnpm test c\npassed 3\n",
    kind: "acceptance",
    summary: "C 夹具证据（F3 真链路）",
    created_by: "kimi-code",
    role: "executor",
    binding: { revision_kind: CODE_KIND, revision: CODE_REV_C },
    source_ref: "F3 真链路证据",
  }).evidence_id;
  const eventsFileC = path.join(projectWorkDir(C, dataDir), "events.jsonl");

  // ── ① 两源同权（裁定 3）：先只给"成果登记（rev A）"，再给一条**更晚**的结果回报（rev B）──
  const subC = await submitCommand({
    project: C,
    type: "audit.submission_submitted",
    entity_id: "submission:sub-C",
    expected_revision: null,
    occurred_at: opts.freshIso,
    payload: {
      goal: "C 夹具：成果登记（版本 A；旧口径下它就是当前版本）",
      task_id: "M-3",
      baseline: {},
      changed_files: [],
      commands: [{ command: "pnpm test c", exit_code: 0, output_ref: null }],
      untested: [],
      known_issues: [],
      evidence_refs: [evC],
      binding: { revision_kind: "code", revision: CODE_REV_C },
      submitted_by: "kimi-code",
      runtime_entries: [
        {
          scenario: SUB_ENTRY_SCENARIO,
          url: `http://127.0.0.1:${PORT}/c-submission`,
          verified_at: opts.freshIso,
          status: "reachable",
          reason: null,
        },
      ],
    },
  });
  ok(subC.status === 200, `⑥-2 夹具 C 先落一条成果登记（HTTP ${subC.status}，版本 A = ${CODE_REV_C}）：此刻"当前版本"只可能来自它`);
  const revSubmitOnly = await revisionsOf(C);
  ok(
    // F4：读口默认 `code=null`（自报不当当前版本）；自报值进 `code_declared`，此刻只可能来自这条成果登记（版本 A）。
    revSubmitOnly.code === null && revSubmitOnly.code_declared === CODE_REV_C,
    `⑥-2b 参照点（F4）：还没有任何结果回报时 revisions.code = ${revSubmitOnly.code}（**自报不当当前版本**，产品读口默认 null）；` +
      `自报值 code_declared = ${revSubmitOnly.code_declared}（= 成果登记的版本 A）——下面那条更晚的结果回报才是分水岭`,
  );

  // ── ① 真认领 → MCP 提交（带 runtime_entries，声明**更晚**的版本 B）──
  const revM1 = revOf["M-1"];
  const claim1 = await mcp.call("claim_task", {
    project_id: C,
    task_id: "M-1",
    role: "executor",
    change_id: CHG,
    expected_revision: revM1,
    workspace: ".工作台/runs/M-1/att-1",
  });
  const token1 = claim1.json?.claim?.claim_token as string | undefined;
  const rev1 = claim1.json?.claim?.entity_revision as number | undefined;
  ok(
    !claim1.isError &&
      claim1.json?.ok === true &&
      typeof token1 === "string" &&
      typeof rev1 === "number" &&
      rev1 === revM1 + 1,
    `⑥-3 MCP 真认领 M-1（原子写）：带 expected_revision=${revM1} → claim_token ${short(token1)}，实体版本 ${revM1} → ${rev1}`,
  );
  const submitted1 = await mcp.call("submit_task_result", {
    project_id: C,
    task_id: "M-1",
    role: "executor",
    change_id: CHG,
    claim_token: token1,
    expected_revision: rev1,
    deliverables: ["M-1 可体验入口交付"],
    evidence_refs: [evC],
    verification: [{ command: "node --import tsx scripts/verify-v06-08-f.ts", exit_code: 0 }],
    untested: [],
    known_issues: [],
    result_revision: CODE_REV_MCP_B,
    runtime_entries: [
      {
        scenario: M1_SCENARIO,
        url: `http://127.0.0.1:${PORT}/m1`,
        verified_at: opts.freshIso,
        status: "reachable",
      },
    ],
  });
  const subEvent1 = submitted1.json?.receipt?.event_id as string | undefined;
  if (submitted1.isError || submitted1.json?.ok !== true) {
    info(
      `⑥-4 现场：isError=${submitted1.isError} code=${String(submitted1.json?.code ?? "")} message=${String(
        submitted1.json?.message ?? "",
      ).slice(0, 500)}`,
    );
  }
  ok(
    !submitted1.isError && submitted1.json?.ok === true && typeof subEvent1 === "string",
    `⑥-4 MCP 提交结果（带 runtime_entries）成功：事件 ${short(subEvent1)}（seq=${submitted1.json?.receipt?.seq}）`,
  );

  // ── ② 验收读口显示（真 HTTP）＋ 打开入口（受控）──
  const accC = await acceptanceOf(C);
  const eM1 = entryOf(accC, M1_SCENARIO);
  ok(
    eM1 !== null &&
      eM1.source_kind === "result_submitted" &&
      eM1.source_record_id === `result:${subEvent1}` &&
      eM1.source_revision === CODE_REV_MCP_B &&
      eM1.source_task_id === "M-1" &&
      eM1.url === `http://127.0.0.1:${PORT}/m1`,
    `⑥-5 MCP 提交的入口在验收读口出现（source_kind=${eM1?.source_kind}，来源 ${short(eM1?.source_record_id)}）：两条写入路径合并进同一份清单，不另造存储`,
  );
  // 裁定 3 的证据点：版本 B **只出现在 MCP 结果回报里**（没有任何成果登记声明过它），
  // 而它比版本 A 更晚发生 ⇒ 按两源同权、实际发生时间优先，它就是**自报**的当前版本。
  // 契约 F4：自报不当"当前可核对版本" ⇒ 这条可核证据落在 `code_declared`，`revisions.code` 保持 null；
  // 读口没有可核对的当前版本 ⇒ 版本轴如实 unknown（不自证成 current，也不猜成 outdated）。
  // "版本一致→current / 源变→outdated" 的真实验证在下面 ⑦（以**真实现读源清单**为当前版本）。
  const revAfterResult = await revisionsOf(C);
  const eSubC = entryOf(accC, SUB_ENTRY_SCENARIO);
  ok(
    revAfterResult.code === null &&
      revAfterResult.code_declared === CODE_REV_MCP_B &&
      eM1?.revision_state === "unknown" &&
      eSubC?.revision_state === "unknown" &&
      eSubC?.openable === true,
    `⑥-6 两源同权（裁定 3）的可核证据是 code_declared = ${revAfterResult.code_declared}：它**只来自更晚的结果回报**的 result_revision（无任何成果登记声明过它）` +
      `，按实际发生时间优先成为**自报**的当前版本（旧口径只认成果登记，会取到版本 A）。` +
      `F4：自报不当"当前可核对版本" ⇒ revisions.code=${revAfterResult.code}，两条入口版本轴都如实 ${eM1?.revision_state}（**未知不自证**），且仍可打开（${eSubC?.openable}）`,
  );
  ok(
    eM1?.state === "openable" &&
      eM1.openable === true &&
      eM1.source_revision === CODE_REV_MCP_B,
    `⑥-6b 版本轴与"能不能打开"仍是两条轴：这条入口版本轴 ${eM1?.revision_state}（缺可核对当前版本）、照样可打开（state=${eM1?.state}）`,
  );
  const tM1 = taskOf(accC, "M-1");
  ok(
    tM1?.result_entry?.kind === "available" &&
      tM1?.result_entry?.url === `http://127.0.0.1:${PORT}/m1` &&
      String(tM1?.result_entry?.note ?? "").includes("结果回报") &&
      !String(tM1?.result_entry?.note ?? "").includes("版本提示"),
    `⑥-7 验收页面的「结果入口」就是这条：地址 + 来源「结果回报」；它绑的是当前版本，所以**不虚报版本过期**（"版本提示"只在真过期时出现）：${String(tM1?.result_entry?.note ?? "").slice(0, 40)}…`,
  );
  const openPlanM1 = resultEntryOpenPlan(String(eM1?.url ?? ""), { shell: false });
  ok(
    eM1 !== null && openPlanM1.open === true && openPlanM1.url === eM1.url && openPlanM1.via === "browser_tab",
    `⑥-8 打开入口（受控）：读口给的地址过 http(s) 白名单后放行（open=${openPlanM1.open} via=${openPlanM1.via}）`,
  );

  // ── ③ 版本过期仍判得出来（裁定 3 的第二问）：再追加一条**更晚**的成果登记（版本 C，且**不声明入口**）──
  const subCLater = await submitCommand({
    project: C,
    type: "audit.submission_submitted",
    entity_id: "submission:sub-C-later",
    expected_revision: null,
    payload: {
      goal: "C 夹具：更晚的成果登记（版本 C，不声明入口）——证明版本过期仍判得出来",
      task_id: "M-3",
      baseline: {},
      changed_files: [],
      commands: [{ command: "pnpm test c", exit_code: 0, output_ref: null }],
      untested: [],
      known_issues: [],
      evidence_refs: [evC],
      binding: { revision_kind: "code", revision: CODE_REV_C_LATER },
      submitted_by: "kimi-code",
    },
  });
  ok(
    subCLater.status === 200,
    `⑥-8b 再追加一条更晚的成果登记（HTTP ${subCLater.status}，版本 C = ${CODE_REV_C_LATER}，**不声明入口**）`,
  );
  const revAfterLater = await revisionsOf(C);
  const accC1 = await acceptanceOf(C);
  const eM1After = entryOf(accC1, M1_SCENARIO);
  const eSubAfter = entryOf(accC1, SUB_ENTRY_SCENARIO);
  ok(
    revAfterLater.code === null && revAfterLater.code_declared === CODE_REV_C_LATER,
    `⑥-8c 自报当前版本跟着**最新一次声明了版本的提交**走（两源同权、实际发生时间优先）：code_declared = ${revAfterLater.code_declared}` +
      `（版本 C 只来自这条成果登记）；F4：可核对版本 code = ${revAfterLater.code}（不拿自报当当前版本）`,
  );
  ok(
    eM1After?.revision_state === "unknown" &&
      eM1After.state === "openable" &&
      eM1After.openable === true &&
      eM1After.source_revision === CODE_REV_MCP_B,
    `⑥-8d 读口没有可核对的当前版本 ⇒ 版本轴如实 ${eM1After?.revision_state}（**不拿自报的版本 C 冒充当前版本**），**仍然可打开**（state=${eM1After?.state}／openable=${eM1After?.openable}）；` +
      `"版本一致→current、相关源变化→outdated 且仍可打开"由 ⑦ 以**真实现读源清单**为当前版本独立验证`,
  );
  ok(
    (accC1?.runtime_entries ?? []).length === 2 &&
      eSubAfter?.revision_state === "unknown" &&
      !String(taskOf(accC1, "M-1")?.result_entry?.note ?? "").includes("版本提示"),
    `⑥-8e 版本 C 那条**不声明入口** ⇒ 入口总数不变（仍 ${accC1?.runtime_entries?.length} 条）；` +
      `F4 下没有可核对当前版本 ⇒ 不虚报"版本提示"（两条入口版本轴 ${eM1After?.revision_state}／${eSubAfter?.revision_state}）`,
  );

  // ── ④ 重启读回：事实落盘了，不是只活在内存里（字段里含 revision_state，版本轴结论也要经得起重启）──
  const fieldsBefore = restartFieldsOf(accC1);
  const summaryBefore = JSON.stringify(accC1?.runtime_entry_summary ?? null);
  await restartServer();
  const accC2 = await acceptanceOf(C);
  const fieldsAfter = restartFieldsOf(accC2);
  ok(
    fieldsBefore.length === 2 && fieldsAfter.join(" ¶ ") === fieldsBefore.join(" ¶ "),
    `⑥-9 杀掉后端重新起一个后再读，两条入口仍在且逐字段一致（scenario/url/state/openable/revision_state/source_record_id）：${fieldsAfter.join(" ／ ")}`,
  );
  ok(
    JSON.stringify(accC2?.runtime_entry_summary ?? null) === summaryBefore,
    `⑥-10 重启后项目级概况也逐字段一致：${String(accC2?.runtime_entry_summary?.note ?? "").slice(0, 40)}…`,
  );

  // ── ⑤ 写入侧统一拒绝（裁定 3）：非法 / 显式 null 的 runtime_entries 在**写侧**就被拒、**一个字节都不写** ──
  //    两条写入路径各来一条：成果登记（走唯一写入服务面 HTTP）与 MCP 结果回报（同一写出口的转接）。
  const fileShaC = (): string => sha256File(eventsFileC);
  const lineCountC = (): number => fs.readFileSync(eventsFileC, "utf8").split("\n").filter((l) => l.trim() !== "").length;
  const shaBeforeRejects = fileShaC();
  const linesBeforeRejects = lineCountC();

  const badSubmitHttp = await submitCommand({
    project: C,
    type: "audit.submission_submitted",
    entity_id: "submission:sub-C-illegal",
    expected_revision: null,
    payload: {
      goal: "C 夹具：非法入口登记（写侧反例，期望根本不落盘）",
      task_id: "M-2",
      submitted_by: "kimi-code",
      runtime_entries: [{ scenario: M2_A_SCENARIO, url: "javascript:alert(1)", verified_at: opts.freshIso, status: "reachable" }],
    },
  });
  ok(
    badSubmitHttp.status !== 200 && errCodeOfBody(badSubmitHttp.body) === "EVENT_INVALID",
    `⑥-11 写侧拒绝（成果登记路径）：HTTP ${badSubmitHttp.status} ${errCodeOfBody(badSubmitHttp.body)}——非法 runtime_entries 在**唯一写出口**就被拒，` +
      `不再"按信封放行、留给读侧报错"：${errMessageOfBody(badSubmitHttp.body).slice(0, 40)}…`,
  );

  const nullSubmitHttp = await submitCommand({
    project: C,
    type: "audit.submission_submitted",
    entity_id: "submission:sub-C-null",
    expected_revision: null,
    payload: {
      goal: "C 夹具：runtime_entries 显式 null（写侧比读侧严的地方）",
      task_id: "M-2",
      submitted_by: "kimi-code",
      runtime_entries: null,
    },
  });
  ok(
    nullSubmitHttp.status !== 200 &&
      errCodeOfBody(nullSubmitHttp.body) === "EVENT_INVALID" &&
      errMessageOfBody(nullSubmitHttp.body).includes("null"),
    `⑥-12 写侧拒绝显式 null（读侧对历史 null 暂时容忍、写侧一律拒）：HTTP ${nullSubmitHttp.status} ${errCodeOfBody(nullSubmitHttp.body)}`,
  );
  ok(
    fileShaC() === shaBeforeRejects && lineCountC() === linesBeforeRejects,
    `⑥-12b 两笔被拒的成果登记**一个字节都没写**：事件文件 sha256 不变、行数仍 ${linesBeforeRejects} 行（"不落盘"不是"写进去再回滚"）`,
  );

  // MCP 结果回报路径：先真认领（认领本身是**合法**写、会落事件，所以零字节基线取在它之后）
  const revM2 = revOf["M-2"];
  const claim2 = await mcp.call("claim_task", {
    project_id: C,
    task_id: "M-2",
    role: "executor",
    change_id: CHG,
    expected_revision: revM2,
  });
  ok(
    !claim2.isError && claim2.json?.ok === true,
    `⑥-13 反例前置：MCP 真认领 M-2 成功（认领是合法写，零字节基线取在它之后）`,
  );
  const shaAfterClaim = fileShaC();
  const linesAfterClaim = lineCountC();
  const bad = await mcp.call("submit_task_result", {
    project_id: C,
    task_id: "M-2",
    role: "executor",
    change_id: CHG,
    claim_token: claim2.json?.claim?.claim_token,
    expected_revision: claim2.json?.claim?.entity_revision,
    deliverables: ["M-2 非法入口登记（写侧反例）"],
    evidence_refs: [evC],
    untested: [],
    known_issues: [],
    result_revision: "code-rev-mcp-m2",
    runtime_entries: [
      { scenario: M2_A_SCENARIO, url: "javascript:alert(1)", verified_at: opts.freshIso, status: "reachable" },
      { scenario: M2_B_SCENARIO, url: `http://127.0.0.1:${PORT}/m2b`, verified_at: "刚刚", status: "reachable" },
    ],
  });
  ok(
    (bad.isError === true || bad.json?.ok !== true) && bad.json?.code === "EVENT_INVALID",
    `⑥-14 写侧拒绝（MCP 结果回报路径）：submit_task_result 返回 isError=${bad.isError} code=${bad.json?.code ?? "<无码>"}——两条写入路径由同一写出口统一拒绝`,
  );
  const badNull = await mcp.call("submit_task_result", {
    project_id: C,
    task_id: "M-2",
    role: "executor",
    change_id: CHG,
    claim_token: claim2.json?.claim?.claim_token,
    expected_revision: claim2.json?.claim?.entity_revision,
    deliverables: ["M-2 显式 null 的入口登记（反例）"],
    evidence_refs: [evC],
    untested: [],
    known_issues: [],
    result_revision: "code-rev-mcp-m2-null",
    runtime_entries: null,
  });
  ok(
    (badNull.isError === true || badNull.json?.ok !== true) && badNull.json?.code === "EVENT_INVALID",
    `⑥-15 MCP 路径也拒显式 null（两路统一，不靠各自实现）：isError=${badNull.isError} code=${badNull.json?.code ?? "<无码>"}`,
  );
  ok(
    fileShaC() === shaAfterClaim && lineCountC() === linesAfterClaim,
    `⑥-15b 三笔被拒的写入**一个字节都没落盘**（以 MCP 认领之后为基线）：sha256 不变、行数仍 ${linesAfterClaim} 行`,
  );
  const accRejects = await api(`/api/projects/${C}/acceptance`);
  ok(
    accRejects.status === 200 && (accRejects.body?.acceptance?.runtime_entries ?? []).length === 2,
    `⑥-16 写侧把坏登记全挡在外面之后读口照常 ${accRejects.status}、入口仍 ${(accRejects.body?.acceptance?.runtime_entries ?? []).length} 条` +
      "——新写入再也产不出坏记录（读侧闸门只对历史现场生效，见下）",
  );

  // ── ⑤ 旧调用兼容：不声明 runtime_entries 的回报，行为与事件载荷都照旧 ──
  const revM3 = revOf["M-3"];
  const claim3 = await mcp.call("claim_task", {
    project_id: C,
    task_id: "M-3",
    role: "executor",
    change_id: CHG,
    expected_revision: revM3,
  });
  const legacy = await mcp.call("submit_task_result", {
    project_id: C,
    task_id: "M-3",
    role: "executor",
    change_id: CHG,
    claim_token: claim3.json?.claim?.claim_token,
    expected_revision: claim3.json?.claim?.entity_revision,
    deliverables: ["M-3 旧调用（不带 runtime_entries）"],
    evidence_refs: [evC],
    verification: [{ command: "pnpm test c", exit_code: 0 }],
    untested: [],
    known_issues: [],
    result_revision: CODE_REV_C,
  });
  ok(
    !legacy.isError && legacy.json?.ok === true,
    `⑥-17 旧调用（不带 runtime_entries）照常成功，五查回执不变：${String(legacy.json?.rechecks?.revision ?? "")}`,
  );
  const legacyEvent =
    fs
      .readFileSync(eventsFileC, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as WorkEvent)
      .find((e) => e.event_id === legacy.json?.receipt?.event_id) ?? null;
  const LEGACY_RESULT_KEYS = [
    "claim_token", "owner_id", "owner_role", "run_id", "attempt_id", "deliverables", "evidence_refs",
    "verification", "untested", "known_issues", "diff_ref", "result_revision", "ownership_basis",
    "meaning", "definition_sha256", "plan_revision",
  ];
  ok(
    legacyEvent !== null &&
      legacyEvent.type === "task.result_submitted" &&
      !("runtime_entries" in legacyEvent.payload) &&
      JSON.stringify(Object.keys(legacyEvent.payload).sort()) === JSON.stringify([...LEGACY_RESULT_KEYS].sort()),
    `⑥-18 旧调用产出的结果回报事件里**没有 runtime_entries 键**，载荷键集合与 F3 之前逐键相同（${Object.keys(legacyEvent?.payload ?? {}).length} 个键）`,
  );
  const accC4 = await acceptanceOf(C);
  ok(
    (accC4?.runtime_entries ?? []).length === 2 && String(taskOf(accC4, "M-3")?.result_entry?.note ?? "").includes("成果登记"),
    `⑥-19 旧调用不在清单里多出入口（仍 ${accC4?.runtime_entries?.length} 条：成果登记 1 + 结果回报 1）：M-3 的入口只来自它那条成果登记，不来自旧调用`,
  );
  // 排序列的另一面（裁定 3 的排序口径）：这条旧调用的结果回报声明的是**版本 A**（与更早那条成果登记同一个串），
  // 但它发生得更晚 ⇒ 按"实际发生时间优先"它就是**自报**的当前版本。这不是"粘性"，而是"谁最后声明、谁就是自报当前版本"；
  // 契约 F4：自报不当可核对当前版本 ⇒ 可核证据在 `code_declared`，`revisions.code` 恒 null，版本轴不自证。下面 ⑥-24 的计数按这个末态算。
  const revAfterLegacy = await revisionsOf(C);
  ok(
    revAfterLegacy.code === null &&
      revAfterLegacy.code_declared === CODE_REV_C &&
      entryOf(accC4, SUB_ENTRY_SCENARIO)?.revision_state === "unknown" &&
      entryOf(accC4, M1_SCENARIO)?.revision_state === "unknown",
    `⑥-19b 自报当前版本跟着**最后一次声明了版本的提交**走（两源同权、实际发生时间优先）：这条旧调用声明的版本 A（${CODE_REV_C}）比版本 C 更晚 ⇒ code_declared=${revAfterLegacy.code_declared}；` +
      `F4 下可核对版本 code=${revAfterLegacy.code}，两条入口版本轴都 ${entryOf(accC4, SUB_ENTRY_SCENARIO)?.revision_state}（自报不自证）`,
  );

  // ── ⑦ 读侧闸门仍在（**历史**坏记录）：写侧已产不出坏记录，只能直接往 events.jsonl 末尾追加一条 ──
  //    为什么这样造（裁定 3 明确要求读侧校验保留）：①历史坏记录必须**可追溯**、读回来是 500 `EVENT_INVALID`，
  //    不静默丢；②写入侧统一拒绝之后，合法路径再也写不进非法登记，"旧现场"只能靠直接改夹具事件文件重现
  //    （与本脚本 ⑥-13～⑥-15 的旧版做法同源）。夹具在 `os.tmpdir()` 下，不碰任何真实项目；
  //    seq 取现场最大值 +1、信封字段齐全，保证文件自洽（不是"造一条读不出来的 JSON"）。
  const rawLinesC = fs.readFileSync(eventsFileC, "utf8").split("\n").filter((l) => l.trim() !== "");
  const maxSeqC = Math.max(...rawLinesC.map((l) => (JSON.parse(l) as WorkEvent).seq));
  const historicalBadEvent: WorkEvent = {
    schema_version: SCHEMA_VERSION,
    event_id: "evt-fixture-historical-illegal-entries",
    project_id: C,
    change_id: CHG,
    entity_id: "task:M-2",
    entity_revision: 3,
    seq: maxSeqC + 1,
    type: "task.result_submitted",
    actor_id: "kimi-code",
    role: "executor",
    occurred_at: opts.freshIso,
    received_at: opts.freshIso,
    idempotency_key: "fixture-historical-illegal-entries:1",
    payload: {
      runtime_entries: [
        { scenario: M2_A_SCENARIO, url: "javascript:alert(1)", verified_at: opts.freshIso, status: "reachable" },
        { scenario: M2_B_SCENARIO, url: `http://127.0.0.1:${PORT}/m2b`, verified_at: "刚刚", status: "reachable" },
      ],
    },
  };
  fs.appendFileSync(eventsFileC, `${JSON.stringify(historicalBadEvent)}\n`, "utf8");
  const readBad = await api(`/api/projects/${C}/acceptance`);
  ok(
    readBad.status === 500 &&
      String(readBad.body?.error?.code ?? "") === "EVENT_INVALID" &&
      String(readBad.body?.error?.message ?? "").includes("http(s)"),
    `⑥-20 读侧闸门仍在（历史坏记录）：直接追加一条非法登记后读口 ${readBad.status} ${readBad.body?.error?.code ?? "<无码>"}` +
      `（不是静默跳过、也不把 javascript: 当入口）：${String(readBad.body?.error?.message ?? "").slice(0, 44)}…`,
  );
  const rawC = fs.readFileSync(eventsFileC, "utf8");
  ok(
    occurrencesOf(rawC, '"javascript:alert(1)"') === 1 && occurrencesOf(rawC, '"刚刚"') === 1,
    "⑥-21 反向对照的前提：两个非法值在事件文件里各只出现一次（写入侧已全拒，这两处只来自这条追加的历史记录，改动不误伤别的现场）",
  );
  fs.writeFileSync(eventsFileC, rawC.replace('"javascript:alert(1)"', `"http://127.0.0.1:${PORT}/m2a"`), "utf8");
  const readMid = await api(`/api/projects/${C}/acceptance`);
  ok(
    readMid.status === 500 && String(readMid.body?.error?.message ?? "").includes("verified_at"),
    `⑥-22 反向对照一：把条目甲的 url 改合法后重读 → 仍 ${readMid.status}，但这次卡在条目乙的 verified_at（逐条闸门，不是整条事件被无视/静默丢）`,
  );
  fs.writeFileSync(
    eventsFileC,
    fs.readFileSync(eventsFileC, "utf8").replace('"刚刚"', `"${opts.staleIso}"`),
    "utf8",
  );
  const readOk = await api(`/api/projects/${C}/acceptance`);
  const accC3 = readOk.body?.acceptance;
  const eM2a = entryOf(accC3, M2_A_SCENARIO);
  const eM2b = entryOf(accC3, M2_B_SCENARIO);
  ok(
    readOk.status === 200 &&
      eM2a?.url === `http://127.0.0.1:${PORT}/m2a` &&
      eM2a.state === "openable" &&
      eM2a.openable === true &&
      eM2b?.state === "reverify_due" &&
      eM2b.openable === true,
    `⑥-23 反向对照二：两条都修好后读取恢复 ${readOk.status}；甲可打开、乙超复核阈值 → ${eM2b?.state} 且**仍可打开**（历史坏记录修好后照常上屏，不静默丢）`,
  );
  ok(
    eM2a?.revision_state === "unknown" && eM2b?.revision_state === "unknown",
    `⑥-23b 这条历史记录没声明版本 ⇒ 版本轴 ${eM2a?.revision_state}（不猜成 current、也不猜成 outdated）`,
  );
  const sumC = accC3?.runtime_entry_summary;
  ok(
    sumC?.kind === "available" &&
      sumC.total === 4 &&
      sumC.can_open_count === 4 &&
      sumC.fresh_count === 3 &&
      sumC.reverify_due_count === 1 &&
      sumC.failed_count === 0 &&
      sumC.unknown_count === 0 &&
      // F4：读口不拿自报当"当前可核对版本" ⇒ 没有可核对当前版本时**无人**被判过期（outdated_count=0），
      // 版本轴如实 unknown（那两条正常登记 + 两条历史记录都不是 current）。不粉饰成"过期 1 条"。
      sumC.outdated_count === 0 &&
      String(sumC.note).includes("待重新验证"),
    `⑥-24 真链路末态的概况也不因超时降级：kind=${sumC?.kind}（不是 stale/unavailable）、共 ${sumC?.total} 条` +
      `（2 条正常登记 + 2 条历史追加）、可打开 ${sumC?.can_open_count} ／ 待重验 ${sumC?.reverify_due_count} ／ 版本过期 ${sumC?.outdated_count}` +
      `（F4：读口无可核对当前版本 ⇒ 版本过期计数如实为 0，不拿自报的版本当当前版本；` +
      `"相关源变化→过期"另由 ⑧ 以真实现读源清单为当前版本独立验证）`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ⑧ 版本轴以**真实现读源清单**为当前版本（契约 F4：自报不是当前版本，真 current 必须现读源清单）
// ══════════════════════════════════════════════════════════════════════════════
/** ⑧ 用的入口场景（读口/读函数按场景名找，改名要同步断言） */
const V_AXIS_SCENARIO = "版本轴入口（真实现读源清单）";
const V_NOVERSION_SCENARIO = "无版本声明入口（版本轴 unknown）";

/**
 * 为什么单独一段：契约 F4（`docs/forward-progress-contract.md`）明确「不能以账本里上次自报的 code revision
 * 反过来当当前代码版本」，所以读口 `revisions.code` 默认 null，没有「可核对当前版本」时版本轴只能如实 unknown。
 * 要真验证「版本一致→current、相关源变化→outdated 且仍可打开」，必须**造真实文件 + 经唯一宿主现读登记源清单**，
 * 把清单指纹当**可核对当前版本**（`opts.code_revision`，产品的显式覆盖口），再走产品读口（`collectProjectFacts`
 * + `runtimeEntryViews`，与验收读口同一份装配）。
 * 不伪造顶层 revision、不改产品判据；这里只是以真实现读把版本轴跑满。
 */
async function versionAxisFromManifestChecks(): Promise<void> {
  info("── ⑧ 版本轴以真实现读源清单为当前版本（F4：自报不是当前版本）");
  const hostClient = new WorkServiceClient({ dataDir, autostart: false });
  const rel = "src/version-axis.ts";
  const now = Date.now();
  const freshIso = new Date(now - 5 * 60 * 1000).toISOString();

  /** 造真实文件 → 经**唯一宿主**现读登记源清单 → 取回执指纹（与产品 manifestFingerprint 逐字核） */
  const storeManifest = async (content: string): Promise<{ fingerprint: string; sha: string }> => {
    write(path.join(rootC, rel), content);
    const local = buildSourceManifest(rootC, [rel]).fingerprint;
    const r = await recordWorkEvidenceTool.handler(
      {
        op: "store",
        project_id: C,
        role: "executor",
        kind: "source_manifest",
        summary: "版本轴夹具源清单（宿主现读）",
        binding: { revision_kind: "code", revision: "run:version-axis" },
        source_manifest: [rel],
      },
      { work: hostClient, clientName: "kimi-code" } as never,
    );
    const text = (r.content ?? [])
      .filter((c): c is { type: "text"; text: string } => (c as { type: string }).type === "text")
      .map((c) => c.text)
      .join("\n");
    const j = JSON.parse(text);
    const fp = j?.evidence?.source_manifest?.fingerprint as string | undefined;
    ok(
      j?.ok === true && typeof fp === "string" && /^[0-9a-f]{64}$/.test(fp) && fp === local,
      `⑧-1 源清单经唯一宿主现读登记（/api/work/reporting/evidence）：宿主回执指纹 ${short(fp)} 与产品 manifestFingerprint（${short(local)}）逐字一致`,
    );
    return { fingerprint: fp as string, sha: j.evidence.sha256 as string };
  };

  const v1 = await storeManifest("export const VERSION_AXIS = 1;\n");

  // 一条绑「真实现读清单指纹」的入口登记（版本＝盘上内容，不是自报串）+ 一条**无版本声明**的入口（另起一条登记）
  const subAxis = await submitCommand({
    project: C,
    type: "audit.submission_submitted",
    entity_id: "submission:sub-version-axis",
    expected_revision: null,
    payload: {
      goal: "C 夹具：版本轴入口（绑定真实现读源清单指纹）",
      task_id: "M-3",
      submitted_by: "kimi-code",
      changed_files: [rel],
      commands: [{ command: "pnpm test version-axis", exit_code: 0, output_ref: null }],
      untested: [],
      known_issues: [],
      binding: { revision_kind: "code", revision: v1.fingerprint },
      runtime_entries: [
        { scenario: V_AXIS_SCENARIO, url: `http://127.0.0.1:${PORT}/version-axis`, verified_at: freshIso, status: "reachable", reason: null },
      ],
    },
  });
  const subNoVer = await submitCommand({
    project: C,
    type: "audit.submission_submitted",
    entity_id: "submission:sub-no-version",
    expected_revision: null,
    payload: {
      goal: "C 夹具：无版本声明的入口（版本轴 unknown）",
      task_id: "M-3",
      submitted_by: "kimi-code",
      changed_files: [],
      commands: [{ command: "pnpm test no-version", exit_code: 0, output_ref: null }],
      untested: [],
      known_issues: [],
      runtime_entries: [
        { scenario: V_NOVERSION_SCENARIO, url: `http://127.0.0.1:${PORT}/no-version`, verified_at: freshIso, status: "reachable", reason: null },
      ],
    },
  });
  ok(
    subAxis.status === 200 && subNoVer.status === 200,
    `⑧-2 绑定「真实现读清单指纹」与「无版本声明」两条入口登记成功（HTTP ${subAxis.status}/${subNoVer.status}）`,
  );

  /** 以指定「可核对当前版本」读入口（与验收读口**同一份装配**：collectProjectFacts + runtimeEntryViews） */
  const readAxis = (currentRev: string): any[] => {
    const facts = collectProjectFacts(C, dataDir, { code_revision: currentRev });
    const sources: RuntimeEntrySource[] = [
      ...Object.values(facts.audit.submissions).map((s) => ({
        kind: "submission" as const,
        record_id: s.record_id,
        task_id: s.task_id,
        submitted_by: s.submitted_by,
        at: s.at,
        revision: s.binding?.revision ?? null,
        revision_kind: s.binding?.revision_kind ?? null,
        entries: s.runtime_entries,
      })),
      ...facts.result_runtime_sources,
    ];
    return runtimeEntryViews(sources, now, { reviewMs: RUNTIME_ENTRY_REVIEW_MS, currentRevision: currentRev });
  };
  const findE = (entries: any[], scenario: string): any => entries.find((e) => e.scenario === scenario) ?? null;

  const read1 = readAxis(v1.fingerprint);
  const eAxis1 = findE(read1, V_AXIS_SCENARIO);
  const eM1Ax = findE(read1, M1_SCENARIO);
  const eNoVer = findE(read1, V_NOVERSION_SCENARIO);
  ok(
    eAxis1?.revision_state === "current" && eAxis1.openable === true,
    `⑧-3 版本一致 ⇒ current：入口绑的正是现读清单指纹（${short(v1.fingerprint)}）⇒ revision_state=${eAxis1?.revision_state}，仍可打开（${eAxis1?.openable}）`,
  );
  ok(
    eM1Ax?.revision_state === "outdated" &&
      eM1Ax.openable === true &&
      String(eM1Ax.revision_label).includes("成果版本已过期"),
    `⑧-4 版本不一致 ⇒ outdated 且**仍可打开**：绑旧版本的入口（结果是结果回报来源）revision_state=${eM1Ax?.revision_state}（openable=${eM1Ax?.openable}）`,
  );
  ok(
    eNoVer?.revision_state === "unknown",
    `⑧-5 未声明版本 ⇒ unknown（不猜成 current、也不猜成 outdated）：${eNoVer?.revision_state}`,
  );

  // 相关源变化：改被清单覆盖的那个文件 → 重新现读登记（新指纹）⇒ 原 current 入口变 outdated，仍可打开
  const v2 = await storeManifest("export const VERSION_AXIS = 2;\n");
  ok(
    v2.fingerprint !== v1.fingerprint,
    `⑧-6 相关源变化 ⇒ 现读清单指纹随之变化：${short(v1.fingerprint)} → ${short(v2.fingerprint)}`,
  );
  const eAxis2 = findE(readAxis(v2.fingerprint), V_AXIS_SCENARIO);
  ok(
    eAxis2?.revision_state === "outdated" && eAxis2.openable === true && eAxis2.source_revision === v1.fingerprint,
    `⑧-7 相关源一变 ⇒ 原来 current 的入口变 outdated、**仍然可打开**（绑 ${short(eAxis2?.source_revision)}，当前 ${short(v2.fingerprint)}，openable=${eAxis2?.openable}）`,
  );

  // 自报不自证：显式可核对版本 = 现读清单指纹，而账本自报 code_declared 是另一串（≠ 指纹）
  const factsV = collectProjectFacts(C, dataDir, { code_revision: v2.fingerprint });
  ok(
    factsV.revisions.code === v2.fingerprint && factsV.revisions.code_declared !== v2.fingerprint,
    `⑧-8 可核对当前版本来自**现读源清单**（code=${short(factsV.revisions.code)}），不是账本自报（code_declared=${short(factsV.revisions.code_declared)} ≠ 指纹）：自报不自证`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ⑨ 版本轴经**真 HTTP 验收读口**（逐来源现读该来源自己引用的源清单；契约 F4「自报不自证」）
//
// 与 ⑧ 的分工：⑧ 用函数层的**显式注入口**（`opts.code_revision`）把版本轴跑满——它能证明"给定一个
// 可核对当前版本，判定是对的"，但**证明不了产品读口自己能拿到那样的版本**。修复前的产品缺口正是：
// `GET /api/projects/:id/acceptance` 从不给 `code_revision`，却把恒 null 的 `facts.revisions.code`
// 灌进 `runtimeEntryViews`，于是**真实 HTTP 读口下每条入口 version 轴恒 `unknown`**——"还能开、
// 但对应旧版成果"这条（DESIGN §3.7）在 HTTP 层永远判不出来。
//
// 修好之后：验收读口对**每条来源**逐来源现读它**明确引用**且**版本绑定一致**的合法源清单，
// 覆盖源没变 ⇒ `current`；覆盖源变了/被删 ⇒ `outdated`（仍可打开）；没清单/错来源/错绑定/缺失/
// 多份歧义 ⇒ `unknown`。本段全部走**真 HTTP 读写口 + 真宿主源清单**，不是函数探针。
// ══════════════════════════════════════════════════════════════════════════════
const HTTP_AXIS_SCENARIO = "⑨ 版本轴入口（成果登记·清单绑定）";
const HTTP_NO_MANIFEST_SCENARIO = "⑨ 无清单入口（自报不自证）";
const HTTP_WRONG_BIND_SCENARIO = "⑨ 错绑定入口（清单指纹≠声明版本）";
const HTTP_MISSING_SCENARIO = "⑨ 缺失清单入口（引用的清单不在盘上）";
const HTTP_NONMANIFEST_SCENARIO = "⑨ 错来源入口（引用非清单证据）";
const HTTP_AMBIGUOUS_SCENARIO = "⑨ 多歧义入口（引用了两份不同清单）";
const HTTP_RESULT_SCENARIO = "⑨ 结果回报入口（真 HTTP·两路同权）";

async function httpVersionAxisChecks(): Promise<void> {
  info("── ⑨ 版本轴经真 HTTP 验收读口：逐来源现读源清单（修复前 HTTP 下恒 unknown）");
  const hostClient = new WorkServiceClient({ dataDir, autostart: false });
  const workDirC = projectWorkDir(C, dataDir);
  const rel = "src/axis-covered.ts";
  const relOther = "src/axis-other.ts";
  const relUnrelated = "src/axis-unrelated.ts";
  const freshIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  /** 造真文件 → 经**唯一宿主**现读登记源清单 → 取回执指纹（与产品实现逐字核）；返回 sha 供正式引用 */
  const storeManifest = async (relPath: string, content: string): Promise<{ fingerprint: string; sha: string }> => {
    write(path.join(rootC, relPath), content);
    const local = buildSourceManifest(rootC, [relPath]).fingerprint;
    const r = await recordWorkEvidenceTool.handler(
      {
        op: "store",
        project_id: C,
        role: "executor",
        kind: "source_manifest",
        summary: `⑨ 版本轴真 HTTP 夹具源清单（${relPath}）`,
        binding: { revision_kind: "code", revision: "run:http-axis" },
        source_manifest: [relPath],
      },
      { work: hostClient, clientName: "kimi-code" } as never,
    );
    const text = (r.content ?? [])
      .filter((c): c is { type: "text"; text: string } => (c as { type: string }).type === "text")
      .map((c) => c.text)
      .join("\n");
    const j = JSON.parse(text);
    const fp = j?.evidence?.source_manifest?.fingerprint as string | undefined;
    ok(
      j?.ok === true && typeof fp === "string" && /^[0-9a-f]{64}$/.test(fp) && fp === local,
      `⑨-1 源清单经唯一宿主现读登记（/api/work/reporting/evidence）：回执指纹 ${short(fp)} 与产品 manifestFingerprint 逐字一致`,
    );
    return { fingerprint: fp as string, sha: j.evidence.sha256 as string };
  };

  /**
   * 造一份**同一覆盖集合但不同正文**的源清单载体（因而与别的载体同 `manifest.fingerprint`、不同内容地址），
   * 经**同一唯一宿主写口**登记（与 ⑨-1 同一路径）。`binding` 可自选来源类/修订，用来构造"同指纹、冲突 binding"。
   */
  const storeCarrier = async (
    relPath: string,
    content: string,
    binding: { revision_kind: string; revision: string },
  ): Promise<{ fingerprint: string; sha: string }> => {
    const r = await recordWorkEvidenceTool.handler(
      {
        op: "store",
        project_id: C,
        role: "executor",
        kind: "source_manifest",
        summary: `⑨b 冲突夹具源清单载体（${relPath} / ${binding.revision_kind}）`,
        content,
        binding,
        source_manifest: [relPath],
      },
      { work: hostClient, clientName: "kimi-code" } as never,
    );
    const text = (r.content ?? [])
      .filter((c): c is { type: "text"; text: string } => (c as { type: string }).type === "text")
      .map((c) => c.text)
      .join("\n");
    const j = JSON.parse(text);
    return {
      fingerprint: j?.evidence?.source_manifest?.fingerprint as string,
      sha: j?.evidence?.sha256 as string,
    };
  };

  const v1 = await storeManifest(rel, "export const AXIS_COVERED = 1;\n");
  const vOther = await storeManifest(relOther, "export const AXIS_OTHER = 1;\n");
  // 一份**非** source_manifest 证据（"错来源"反例：普通证据不能给版本轴背书）
  const nonManifest = putEvidence(workDirC, {
    content: "$ pnpm test axis\npassed\n",
    kind: "acceptance",
    summary: "⑨ 非清单证据（错来源反例）",
    created_by: "kimi-code",
    role: "executor",
    binding: { revision_kind: CODE_KIND, revision: v1.fingerprint },
    source_ref: "⑨ 错来源",
  }).evidence_id;
  const missingSha = sha256("⑨ 这份证据故意不存在");

  /** 一条成果登记（写侧真 HTTP）声明的入口；`bindingRevision` = 该登记声明的 code 版本，`refs` = 正式引用 */
  const submitAxis = (slug: string, scenario: string, bindingRevision: string | null, refs: string[]) =>
    submitCommand({
      project: C,
      type: "audit.submission_submitted",
      entity_id: `submission:sub-http-${slug}`,
      expected_revision: null,
      payload: {
        goal: `⑨ 版本轴真 HTTP（${slug}）`,
        task_id: "M-3",
        baseline: {},
        changed_files: [],
        commands: [{ command: "pnpm test axis", exit_code: 0, output_ref: null }],
        untested: [],
        known_issues: [],
        evidence_refs: refs,
        ...(bindingRevision === null ? {} : { binding: { revision_kind: "code", revision: bindingRevision } }),
        submitted_by: "kimi-code",
        runtime_entries: [
          { scenario, url: `http://127.0.0.1:${PORT}/axis-${slug}`, verified_at: freshIso, status: "reachable", reason: null },
        ],
      },
    });

  const subAxis = await submitAxis("bound", HTTP_AXIS_SCENARIO, v1.fingerprint, [v1.sha]);
  const subNoManifest = await submitAxis("nomanifest", HTTP_NO_MANIFEST_SCENARIO, "self-report-axis", []);
  const subWrongBind = await submitAxis("wrongbind", HTTP_WRONG_BIND_SCENARIO, "self-report-wrong", [v1.sha]);
  const subMissing = await submitAxis("missing", HTTP_MISSING_SCENARIO, v1.fingerprint, [missingSha]);
  const subNonManifest = await submitAxis("nonmanifest", HTTP_NONMANIFEST_SCENARIO, v1.fingerprint, [nonManifest]);
  const subAmbiguous = await submitAxis("ambiguous", HTTP_AMBIGUOUS_SCENARIO, v1.fingerprint, [v1.sha, vOther.sha]);
  ok(
    [subAxis, subNoManifest, subWrongBind, subMissing, subNonManifest, subAmbiguous].every((r) => r.status === 200),
    `⑨-2 六条成果登记（合法/无清单/错绑定/缺失/错来源/多歧义）经真 HTTP 写口全部登记成功（HTTP ${[subAxis, subNoManifest, subWrongBind, subMissing, subNonManifest, subAmbiguous].map((r) => r.status).join("/")}）`,
  );

  // ── 真 HTTP 读口：修复前这里六条**全部** unknown ──
  const acc1 = await acceptanceOf(C);
  const eAxis1 = entryOf(acc1, HTTP_AXIS_SCENARIO);
  const eNoManifest = entryOf(acc1, HTTP_NO_MANIFEST_SCENARIO);
  const eWrongBind = entryOf(acc1, HTTP_WRONG_BIND_SCENARIO);
  const eMissing = entryOf(acc1, HTTP_MISSING_SCENARIO);
  const eNonManifest = entryOf(acc1, HTTP_NONMANIFEST_SCENARIO);
  const eAmbiguous = entryOf(acc1, HTTP_AMBIGUOUS_SCENARIO);
  ok(
    eAxis1?.revision_state === "current" && eAxis1.openable === true && eAxis1.revision_current === v1.fingerprint,
    `⑨-3 真 HTTP 读口：成果登记**正式引用**了版本绑定一致的合法源清单且现读一致 ⇒ revision_state=${eAxis1?.revision_state}（修复前恒 unknown）、仍可打开（${eAxis1?.openable}）`,
  );
  ok(
    eNoManifest?.revision_state === "unknown" && eNoManifest.openable === true,
    `⑨-4 自报不自证：没引用任何清单、只自报版本串 ⇒ 版本轴如实 ${eNoManifest?.revision_state}（**不拿自报当当前版本**），仍可打开（${eNoManifest?.openable}）`,
  );
  ok(
    eWrongBind?.revision_state === "unknown",
    `⑨-5 错绑定：引用了合法清单，但声明的 code 版本 ≠ 清单指纹 ⇒ ${eWrongBind?.revision_state}（**不借一份无关清单背书**）`,
  );
  ok(
    eMissing?.revision_state === "unknown",
    `⑨-6 缺失：正式引用的清单证据不在盘上 ⇒ ${eMissing?.revision_state}（不猜、不绿）`,
  );
  ok(
    eNonManifest?.revision_state === "unknown",
    `⑨-7 错来源：正式引用的证据不是 source_manifest（普通验收证据）⇒ ${eNonManifest?.revision_state}（不给版本轴背书）`,
  );
  ok(
    eAmbiguous?.revision_state === "unknown",
    `⑨-8 多歧义：正式引用了**两份不同**的源清单 ⇒ ${eAmbiguous?.revision_state}（不借其中任意一份背书）`,
  );
  ok(
    acc1?.runtime_entry_summary?.outdated_count === 0,
    `⑨-9 拿不到可核对当前版本的这些入口**没有一个**被误判过期（outdated_count=${acc1?.runtime_entry_summary?.outdated_count}）：unknown 不等于 outdated`,
  );
  ok(
    !String(eAxis1?.revision_basis ?? "").includes(tmpBase) && !String(eAxis1?.revision_basis ?? "").includes(rootC),
    `⑨-10 版本轴依据是人话且**不含绝对私有路径**：${String(eAxis1?.revision_basis ?? "").slice(0, 34)}…`,
  );

  // ── 无关源变化不连坐：改一个**没被清单覆盖**的文件 ⇒ 那条入口仍 current ──
  write(path.join(rootC, relUnrelated), "export const AXIS_UNRELATED = 1;\n");
  const accUnrelated = await acceptanceOf(C);
  ok(
    entryOf(accUnrelated, HTTP_AXIS_SCENARIO)?.revision_state === "current",
    "⑨-11 无关文件变化**不连坐**：清单没覆盖它 ⇒ 该入口仍 current（有限范围的本义）",
  );

  // ── 结果回报路径（真 MCP 认领 + 真回报），正式引用**同一份**清单 ⇒ 两路同权 ──
  const mcp = await startMcp("v0608f-http-axis");
  const revM4 = await seedDefinitionOnly(C, "M-4", sha256(planC));
  const claim4 = await mcp.call("claim_task", {
    project_id: C,
    task_id: "M-4",
    role: "executor",
    change_id: CHG,
    expected_revision: revM4,
  });
  const submitted4 = await mcp.call("submit_task_result", {
    project_id: C,
    task_id: "M-4",
    role: "executor",
    change_id: CHG,
    claim_token: claim4.json?.claim?.claim_token,
    expected_revision: claim4.json?.claim?.entity_revision,
    deliverables: ["⑨ 版本轴（结果回报路径）"],
    evidence_refs: [v1.sha],
    verification: [{ command: "node --import tsx scripts/verify-v06-08-f.ts", exit_code: 0 }],
    untested: [],
    known_issues: [],
    result_revision: v1.fingerprint,
    runtime_entries: [
      { scenario: HTTP_RESULT_SCENARIO, url: `http://127.0.0.1:${PORT}/axis-result`, verified_at: freshIso, status: "reachable" },
    ],
  });
  ok(
    !submitted4.isError && submitted4.json?.ok === true,
    `⑨-12 结果回报路径（MCP 真认领 + submit_task_result）正式引用同一清单、绑定版本一致：${String(submitted4.json?.receipt?.event_id ?? "").slice(0, 12)}…`,
  );
  const accResult = await acceptanceOf(C);
  const eResult = entryOf(accResult, HTTP_RESULT_SCENARIO);
  ok(
    eResult?.revision_state === "current" &&
      eResult.source_kind === "result_submitted" &&
      eResult.source_revision === v1.fingerprint,
    `⑨-13 两路同权：结果回报来源（source_kind=${eResult?.source_kind}）的版本轴与成果登记**同判** ${eResult?.revision_state}`,
  );

  // ── 相关源变化（**不重新登记**）：改被清单覆盖的文件 ⇒ 两条来源都 outdated、都仍可打开 ──
  write(path.join(rootC, rel), "export const AXIS_COVERED = 2;\n");
  const accChanged = await acceptanceOf(C);
  const eAxis2 = entryOf(accChanged, HTTP_AXIS_SCENARIO);
  const eResult2 = entryOf(accChanged, HTTP_RESULT_SCENARIO);
  ok(
    eAxis2?.revision_state === "outdated" && eAxis2.openable === true && eAxis2.source_revision === v1.fingerprint,
    `⑨-14 相关源一变 ⇒ 真 HTTP 判 ${eAxis2?.revision_state}（绑 ${short(eAxis2?.source_revision)}）、**仍可打开**（openable=${eAxis2?.openable}）——"还能开但对应旧版成果"这条轴在 HTTP 层判得出来了`,
  );
  ok(
    eResult2?.revision_state === "outdated" && eResult2.openable === true,
    `⑨-15 结果回报那条**同判** ${eResult2?.revision_state}（两路同权、不偏袒任一来源）`,
  );
  ok(
    entryOf(accChanged, HTTP_NO_MANIFEST_SCENARIO)?.revision_state === "unknown" &&
      entryOf(accChanged, HTTP_AXIS_SCENARIO)?.openable === true,
    "⑨-16 相关源变了也不连坐别的来源：无清单那条仍 unknown；版本轴与「能不能打开」始终两条轴",
  );
  ok(
    (accChanged?.runtime_entry_summary?.outdated_count ?? 0) >= 2 &&
      (accChanged?.runtime_entry_summary?.can_open_count ?? 0) >= 2,
    `⑨-17 概况按版本轴单独计数：outdated_count=${accChanged?.runtime_entry_summary?.outdated_count}，can_open_count=${accChanged?.runtime_entry_summary?.can_open_count}（两个计数各说各的事、可重叠）`,
  );

  // ══════════════════════════════════════════════════════════════════════════════
  // ⑨b 顺序无关 / 冲突不借绿（独立复审 D1）
  //   旧解析**先按 `manifest.fingerprint` 去重、只核"保留的第一份"载体**，于是同一组引用换数组顺序
  //   会给出 current ↔ unknown 两个结论，且同指纹、不同 binding 的冲突不被判为歧义（静默借第一份）。
  //   修后：**每份候选先核到底，再按声明指纹归组**；组内结论必须全体一致，不一致 ⇒ 冲突 ⇒ unknown。
  //   三条冲突构造（都经真 HTTP 写口 + 真宿主；`store` 产不出的坏清单另按"清单被动过"直接落盘）：
  //     · 冲突 binding：同覆盖集合两份载体，`binding.revision_kind` 一份 code、一份 plan；
  //     · 空 binding：同覆盖集合另一份载体，`binding.revision` 是空白串（来源类对不上）；
  //     · 同指纹不同 files：声明同一 `fingerprint` 但 `files` 与指纹不自洽的载体（现读复核取不到结论）。
  //   判据：**同一引用集合换顺序结论逐字一致**；冲突一律 `unknown`（不借第一份的绿，也不随机择优）。
  // ══════════════════════════════════════════════════════════════════════════════
  const relConflict = "src/axis-conflict.ts";
  write(path.join(rootC, relConflict), "export const AXIS_CONFLICT = 1;\n");
  const cGood = await storeCarrier(relConflict, "carrier:good", { revision_kind: "code", revision: "run:good" });
  const cWrongKind = await storeCarrier(relConflict, "carrier:wrong-kind", { revision_kind: "plan", revision: "run:bad" });
  const cEmpty = await storeCarrier(relConflict, "carrier:empty-binding", { revision_kind: "code", revision: "   " });
  const cAgree = await storeCarrier(relConflict, "carrier:agree", { revision_kind: "code", revision: "run:agree" });
  ok(
    [cGood, cWrongKind, cEmpty, cAgree].every((c) => c.fingerprint === cGood.fingerprint) &&
      new Set([cGood.sha, cWrongKind.sha, cEmpty.sha, cAgree.sha]).size === 4,
    `⑨b-1 四份载体的覆盖集合相同（同清单指纹 ${short(cGood.fingerprint)}）、内容地址各不相同（构造前提成立）`,
  );

  // 同一指纹、但 `files` 与指纹不自洽的载体：store 产不出来（服务端现读算指纹），只能直接落盘当"清单被动过"
  const fakeContent = "⑨b 声明同一指纹但 files 与指纹不自洽的清单载体";
  const fakeSha = sha256(fakeContent);
  write(
    path.join(workDirC, "evidence", `${fakeSha}.json`),
    JSON.stringify({
      kind: "source_manifest",
      content: fakeContent,
      content_sha256: fakeSha,
      bytes: Buffer.byteLength(fakeContent, "utf8"),
      source_manifest: {
        version: "source-manifest-v1",
        files: [{ path: relConflict, sha256: "0".repeat(64), bytes: 1 }],
        fingerprint: cGood.fingerprint,
      },
      binding: { revision_kind: "code", revision: "run:fake" },
      summary: "⑨b 同指纹不同 files 的坏载体",
      created_by: "kimi-code",
      role: "executor",
      source_ref: null,
    }),
  );

  /** 同一引用集合、两种数组顺序各提交一条；返回两条读回的版本轴状态（用于断言顺序无关） */
  const orderPair = async (slug: string, a: string, b: string): Promise<[string, string]> => {
    const s1 = await submitAxis(`${slug}-ab`, `⑨b ${slug}（A 先）`, cGood.fingerprint, [a, b]);
    const s2 = await submitAxis(`${slug}-ba`, `⑨b ${slug}（B 先）`, cGood.fingerprint, [b, a]);
    if (s1.status !== 200 || s2.status !== 200) throw new Error(`⑨b ${slug} 登记失败 HTTP ${s1.status}/${s2.status}`);
    const acc = await acceptanceOf(C);
    return [
      String(entryOf(acc, `⑨b ${slug}（A 先）`)?.revision_state),
      String(entryOf(acc, `⑨b ${slug}（B 先）`)?.revision_state),
    ];
  };

  // 对照：单一好载体是 current（下面"冲突 → unknown"不是因为好载体本身坏了）
  await submitAxis("conflict-solo-good", "⑨b 单·好载体", cGood.fingerprint, [cGood.sha]);
  const soloGood = entryOf(await acceptanceOf(C), "⑨b 单·好载体");
  ok(
    soloGood?.revision_state === "current",
    `⑨b-2 对照：单引用这份好载体 ⇒ ${soloGood?.revision_state}（current；"冲突→unknown"不是因为它坏）`,
  );

  // 同指纹、结论**一致**的两份载体 ⇒ 仍 current（去重不误报冲突）
  const dupPair = await orderPair("一致双载体", cGood.sha, cAgree.sha);
  ok(
    dupPair[0] === "current" && dupPair[1] === "current",
    `⑨b-3 同指纹、结论一致的两份载体 ⇒ 两种顺序都 ${dupPair.join(" / ")}（去重不误报冲突）`,
  );

  const kindPair = await orderPair("冲突binding", cGood.sha, cWrongKind.sha);
  ok(
    kindPair[0] === "unknown" && kindPair[1] === "unknown",
    `⑨b-4 同指纹、**冲突 binding**（code vs plan）：两种顺序都 ${kindPair.join(" / ")}，不借第一份的绿`,
  );
  const emptyPair = await orderPair("空binding", cGood.sha, cEmpty.sha);
  ok(
    emptyPair[0] === "unknown" && emptyPair[1] === "unknown",
    `⑨b-5 同指纹、**空 binding**（binding.revision 空白）：两种顺序都 ${emptyPair.join(" / ")}，不借第一份的绿`,
  );
  const fakePair = await orderPair("同指纹异files", cGood.sha, fakeSha);
  ok(
    fakePair[0] === "unknown" && fakePair[1] === "unknown",
    `⑨b-6 同指纹、**不同 files**（清单自身不自洽）：两种顺序都 ${fakePair.join(" / ")}，不借第一份的绿`,
  );
  ok(
    kindPair[0] === kindPair[1] && emptyPair[0] === emptyPair[1] && fakePair[0] === fakePair[1],
    "⑨b-7 三组「同一引用集合换数组顺序」的结论逐字一致（顺序无关 / 确定性；修复前会 current↔unknown 翻转）",
  );
  const conflictEntry = entryOf(await acceptanceOf(C), "⑨b 冲突binding（B 先）");
  ok(
    !String(conflictEntry?.revision_basis ?? "").includes(tmpBase) &&
      !String(conflictEntry?.revision_basis ?? "").includes(rootC) &&
      /冲突|不一致/.test(String(conflictEntry?.revision_basis ?? "")),
    `⑨b-8 冲突依据是人话且不含绝对私有路径：${String(conflictEntry?.revision_basis ?? "").slice(0, 44)}…`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ④ 真 HTTP：登记 → 读取（入口在用户验收之前就可见 / 无入口 / 失效入口 / 打开≠接受）
// ══════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  pureChecks();
  openChecks();
  routeChecks();

  info("── ④ 登记 → 读取（真起后端 + 真 HTTP 写口，隔离 TATAI_HOME）");
  if (await portListening(PORT)) throw new Error(`端口 ${PORT} 被占用，无法起隔离后端`);
  const hostProc = spawnServer();
  // 依产品就绪协议等**本次**宿主（描述符 pid＋token＋写口所有权探活），不用"/health 可达"当就绪
  const hostReady = await waitHostReady(hostProc);
  ok(
    hostReady.port === PORT,
    `4-0 唯一写入服务描述符可发现且属**本次**宿主（port=${hostReady.port}、pid=${hostReady.pid}；` +
      `就绪判据＝描述符 pid ＋ token ＋ 写口所有权探活 200，非 /health 可达）`,
  );
  workToken = hostReady.token;

  // 4-0b 就绪延迟负例（确定性）：证旧"/health 可达"过早、新条件不放行、旧 token 写被拒
  await readinessNegativeCase();

  const planRevA = sha256(planA);
  const planRevB = sha256(planB);
  for (const t of ["T-1", "T-2", "T-3"]) await seedTask(A, t, planRevA);
  await seedTask(B, "X-1", planRevB);

  // 证据正文（内容寻址；真实提交里引用它——纯后端"证据"段不许是模拟文本）
  const evA = putEv("T-1 验收证据（夹具：真实命令输出）", "$ pnpm test import\npassed 7\n", "code-rev-A").evidence_id;

  const nowMs = Date.now();
  const freshIso = new Date(nowMs - 10 * 60 * 1000).toISOString();
  const staleIso = new Date(nowMs - RUNTIME_ENTRY_REVIEW_MS - 60 * 60 * 1000).toISOString();

  // ①T-1：一条可打开 + 一条探测失败（带不可用原因）
  const subT1 = await submitCommand({
    project: A,
    type: "audit.submission_submitted",
    entity_id: "submission:sub-T-1",
    expected_revision: null,
    occurred_at: freshIso,
    payload: {
      goal: "T-1 数据层交付",
      task_id: "T-1",
      baseline: {},
      changed_files: ["src/t-1.ts"],
      commands: [{ command: "pnpm test import", exit_code: 0, output_ref: null }],
      untested: [{ item: "十万行性能", reason: "夹具未跑" }],
      known_issues: [],
      evidence_refs: [evA],
      binding: { revision_kind: "code", revision: "code-rev-A" },
      submitted_by: "kimi-code",
      runtime_entries: [
        {
          scenario: "T-1 导入能力（可体验）",
          url: "http://127.0.0.1:5173/import",
          verified_at: freshIso,
          status: "reachable",
          reason: null,
        },
        {
          scenario: "T-1 压测入口（已失效）",
          url: "http://127.0.0.1:9/bench",
          verified_at: freshIso,
          status: "unreachable",
          reason: "进程已结束（夹具现场）",
        },
      ],
    },
  });
  ok(subT1.status === 200, `4-1 入口登记经唯一写入服务面提交成功（HTTP ${subT1.status}，seq=${subT1.body?.seq}）`);

  // T-2：唯一入口的验证时间已超过复核提醒阈值（裁定 F2：该提醒复核，**不是**入口失效）
  const subT2 = await submitCommand({
    project: A,
    type: "audit.submission_submitted",
    entity_id: "submission:sub-T-2",
    expected_revision: null,
    payload: {
      goal: "T-2 接口层交付",
      task_id: "T-2",
      baseline: {},
      changed_files: [],
      commands: [{ command: "pnpm test api", exit_code: 0, output_ref: null }],
      untested: [],
      known_issues: [],
      evidence_refs: [evA],
      binding: { revision_kind: "code", revision: "code-rev-A" },
      submitted_by: "kimi-code",
      runtime_entries: [
        {
          scenario: "T-2 接口调试台",
          url: "http://127.0.0.1:5180/api",
          verified_at: staleIso,
          status: "reachable",
          reason: null,
        },
      ],
    },
  });
  ok(subT2.status === 200, `4-2 超复核阈值的入口照常登记（HTTP ${subT2.status}）：读取侧按「待重新验证」显示状态，不静默消失、也不判成不可达`);

  // T-3：成果提交了但**没有**登记入口 → 该任务"尚不可体验"
  const subT3 = await submitCommand({
    project: A,
    type: "audit.submission_submitted",
    entity_id: "submission:sub-T-3",
    expected_revision: null,
    payload: {
      goal: "T-3 展示层交付",
      task_id: "T-3",
      baseline: {},
      changed_files: [],
      commands: [{ command: "pnpm test ui", exit_code: 0, output_ref: null }],
      untested: [],
      known_issues: [],
      evidence_refs: [evA],
      binding: { revision_kind: "code", revision: "code-rev-A" },
      submitted_by: "kimi-code",
    },
  });
  ok(subT3.status === 200, `4-3 不登记入口的成果提交成功（HTTP ${subT3.status}）：缺省即"没有入口"，不是错误`);

  // B 项目：纯后端，无任何入口登记
  const subB = await submitCommand({
    project: B,
    type: "audit.submission_submitted",
    entity_id: "submission:sub-X-1",
    expected_revision: null,
    payload: {
      goal: "X-1 唯一的卡交付",
      task_id: "X-1",
      baseline: {},
      changed_files: [],
      commands: [{ command: "pnpm test all", exit_code: 0, output_ref: null }],
      untested: [{ item: "并发", reason: "夹具未跑" }],
      known_issues: [],
      evidence_refs: [],
      binding: { revision_kind: "code", revision: "code-rev-B" },
      submitted_by: "kimi-code",
    },
  });
  ok(subB.status === 200, `4-4 纯后端夹具 B 的成果提交成功（HTTP ${subB.status}）`);

  // ── 读取：用户**尚未接受**时就能看到入口（③）──
  const acc = await acceptanceOf(A);
  ok(acc !== undefined, "4-5 GET /api/projects/A/acceptance 可读（真 HTTP）");
  ok(
    (acc?.tasks ?? []).every((t: any) => t.acceptance === "pending") && acc?.counts?.accepted === 0,
    "4-6 读取时**用户尚未接受**（三个任务全 pending、accepted 计数 0）",
  );
  ok(
    acc?.runtime_entry_summary?.kind === "available" &&
      acc?.runtime_entry_summary?.can_open_count === 2 &&
      acc?.runtime_entry_summary?.fresh_count === 1 &&
      acc?.runtime_entry_summary?.reverify_due_count === 1,
    `4-7 用户还没验收，入口就已经能看到：概况 kind=${acc?.runtime_entry_summary?.kind}、可打开 ${acc?.runtime_entry_summary?.can_open_count} 条（其中待重验 ${acc?.runtime_entry_summary?.reverify_due_count} 条，仍算可打开）`,
  );

  const eOpen = entryOf(acc, "T-1 导入能力（可体验）");
  ok(
    eOpen !== null &&
      eOpen.url === "http://127.0.0.1:5173/import" &&
      eOpen.verified_at === freshIso &&
      eOpen.status === "reachable" &&
      eOpen.state === "openable" &&
      eOpen.openable === true,
    `4-8 登记字段逐项对上：场景 / 实际入口 / 验证时间 / 结果（state=${eOpen?.state}）`,
  );
  const revA = await revisionsOf(A);
  ok(
    eOpen?.source_kind === "submission" &&
      eOpen?.source_record_id === "sub-T-1" &&
      eOpen?.source_revision === "code-rev-A" &&
      eOpen?.source_revision_kind === "code" &&
      eOpen?.source_submitted_by === "kimi-code" &&
      eOpen?.source_task_id === "T-1" &&
      typeof eOpen?.registered_at === "string" &&
      // 契约 F4：可核对当前版本不能来自账本自报 ⇒ 读口默认 code=null；自报值进 code_declared。
      // 读口没有可核对的当前版本 ⇒ 版本轴如实 unknown（自报不自证；"版本一致→current / 相关源变化→outdated"由 ⑧ 真实验证）。
      revA.code === null &&
      revA.code_declared === "code-rev-A" &&
      eOpen?.revision_state === "unknown",
    `4-9 来源成果与版本可追溯：${eOpen?.source_record_id} @ ${eOpen?.source_revision_kind} ${short(eOpen?.source_revision)}（登记人 ${eOpen?.source_submitted_by}）；` +
      `F4：可核对当前版本 code=${revA.code}（不拿自报当当前版本），自报 code_declared=${short(revA.code_declared)} ⇒ 版本轴如实 ${eOpen?.revision_state}`,
  );

  // ── ⑤ 失效 / 待重验入口说明状态（不静默消失，也不把"该复核了"说成"失效"）──
  const eDead = entryOf(acc, "T-1 压测入口（已失效）");
  ok(
    eDead !== null && eDead.state === "failed" && eDead.openable === false && eDead.reason === "进程已结束（夹具现场）",
    `4-10 探测失败的入口仍在清单里、明确标失效并给出原因：${eDead?.state_label}｜原因「${eDead?.reason}」`,
  );
  const eOld = entryOf(acc, "T-2 接口调试台");
  ok(
    eOld !== null &&
      eOld.state === "reverify_due" &&
      eOld.openable === true &&
      String(eOld.state_label).includes("待重新验证") &&
      !(RUNTIME_ENTRY_STATES as readonly string[]).includes("expired"),
    `4-11 超过复核提醒阈值的入口标「待重新验证」而不是当成失效：${eOld?.state} / openable=${eOld?.openable}（入口还在，只是该再确认一次）`,
  );
  const sumA = acc?.runtime_entry_summary;
  ok(
    (acc?.runtime_entries ?? []).length === 3 &&
      sumA?.fresh_count === 1 &&
      sumA?.reverify_due_count === 1 &&
      sumA?.failed_count === 1 &&
      sumA?.unknown_count === 0 &&
      sumA?.can_open_count === 2 &&
      sumA?.outdated_count === 0 &&
      !("openable_count" in (sumA ?? {})) &&
      !("expired_count" in (sumA ?? {})),
    `4-12 三条登记一条不丢（总数 ${acc?.runtime_entries?.length}：实测在阈值内 ${sumA?.fresh_count} / 待重验 ${sumA?.reverify_due_count} / 失效 ${sumA?.failed_count} / 可打开合计 ${sumA?.can_open_count}），且概况里没有旧档案字段`,
  );

  // ── ⑤ 无入口 → "尚不可体验" ──
  const t3 = taskOf(acc, "T-3");
  ok(
    t3?.result_entry?.kind === "unavailable" && String(t3?.result_entry?.note ?? "").includes("尚不可体验") && t3?.result_entry?.url === null,
    "4-13 没有登记入口的任务如实显示「尚不可体验」（不显示任何链接、不显示空壳成功）",
  );
  const t2 = taskOf(acc, "T-2");
  ok(
    t2?.result_entry?.kind === "available" &&
      t2?.result_entry?.url === "http://127.0.0.1:5180/api" &&
      String(t2?.result_entry?.note ?? "").includes("待重新验证") &&
      !String(t2?.result_entry?.note ?? "").includes("尚不可体验"),
    `4-14 只登记过「待重新验证」入口的任务：入口照样给得出地址并注明待重新验证（超时不撤掉入口，也不写成「尚不可体验」）：${String(t2?.result_entry?.note ?? "").slice(0, 30)}…`,
  );
  const t1 = taskOf(acc, "T-1");
  ok(
    t1?.result_entry?.kind === "available" &&
      t1?.result_entry?.url === "http://127.0.0.1:5173/import" &&
      String(t1?.result_entry?.note ?? "").includes("不等于"),
    "4-15 有可打开入口的任务：入口地址可打开，且文案明写「打开入口不等于用户验收接受」",
  );

  const accB = await acceptanceOf(B);
  ok(
    accB?.runtime_entries?.length === 0 &&
      accB?.runtime_entry_summary?.kind === "unavailable" &&
      String(accB?.runtime_entry_summary?.note ?? "").includes("尚不可体验"),
    "4-16 一个入口都没有的项目：概况 kind=unavailable 且明写「尚不可体验」（与加载失败分开）",
  );

  // ── ④ 纯后端可读场景：真实输入/期望/实际/证据四段（不是模拟输出）──
  const rs = taskOf(accB, "X-1")?.readable_scenario ?? null;
  ok(
    rs !== null && rs.input.includes("pnpm test all") && rs.input.includes("exit 0"),
    `4-17 纯后端「输入」是**真实提交的验证命令与退出码**：${String(rs?.input ?? "").slice(0, 40)}`,
  );
  ok(
    String(rs?.expected ?? "").includes("X-1 的验收检查项一") && String(rs?.expected ?? "").includes("X-1 的验收检查项二"),
    `4-18 纯后端「期望」来自施工图的版本化验收检查项：${String(rs?.expected ?? "").slice(0, 34)}…`,
  );
  ok(
    String(rs?.actual ?? "").startsWith("执行状态：") && !String(rs?.actual ?? "").includes("模拟"),
    `4-19 纯后端「实际」是**真实执行状态**（不是模拟输出）：${rs?.actual}`,
  );
  ok(
    String(rs?.evidence ?? "").includes("（没有绑定任何证据）") || String(rs?.evidence ?? "").includes("有效"),
    `4-20 纯后端「证据」如实（有证据给内容寻址摘要，没有就明写没有）：${String(rs?.evidence ?? "").slice(0, 30)}`,
  );
  const rsA = taskOf(acc, "T-1")?.readable_scenario ?? null;
  ok(
    String(rsA?.evidence ?? "").includes("有效") && String(rsA?.evidence ?? "").includes("T-1 验收证据"),
    `4-21 有证据时「证据」段指向真实证据正文（内容寻址清单里的那条）：${String(rsA?.evidence ?? "").slice(0, 34)}…`,
  );

  // ── ⑥ 打开 ≠ 接受：登记 + 读取都不产生"已接受" ──
  const eventsFile = path.join(projectWorkDir(A, dataDir), "events.jsonl");
  const rawEvents = fs.readFileSync(eventsFile, "utf8");
  const events: WorkEvent[] = loadEvents(projectWorkDir(A, dataDir)).events;
  const folded = foldAuditRecords(events);
  ok(
    !rawEvents.includes("audit.human_acceptance_recorded") &&
      Object.keys(folded.acceptances).length === 0 &&
      Object.values(folded.submissions).length === 3,
    `4-22 登记入口 + 读取之后**没有任何人工验收记录**（事件里 0 条、折叠出 3 条成果、0 条接受）：打开/登记 ≠ 接受`,
  );
  ok(
    (acc?.tasks ?? []).every((t: any) => t.acceptance_records.length === 0 && t.latest_acceptance === null),
    "4-23 每个任务的验收记录列表为空（入口可用 ≠ 已验收，§5.8）",
  );

  // 反向对照：用户真的记录了接受之后，入口**依旧来自成果登记**（与验收记录无关，内容一字不变）
  const acceptRes = await postJson(`/api/projects/${A}/acceptance`, {
    decision: "accept",
    task_id: "T-1",
    scenario_refs: ["http://127.0.0.1:5173/import"],
    evidence_refs: [evA],
    note: "夹具：用户接受",
    accepted_by: "user",
  });
  ok(acceptRes.status === 200, `4-24 反向对照：用户记录一次接受（HTTP ${acceptRes.status}）后…`);
  const acc2 = await acceptanceOf(A);
  const sameEntries =
    JSON.stringify(acc2?.runtime_entries ?? []) === JSON.stringify(acc?.runtime_entries ?? []) &&
    acc2?.runtime_entry_summary?.kind === "available";
  ok(
    sameEntries && taskOf(acc2, "T-1")?.acceptance === "accepted",
    "4-25 …入口清单**逐字不变**（来源是成果登记，不是验收记录）：状态变了、入口没变——两件事分开记",
  );
  ok(
    taskOf(acc2, "T-2")?.acceptance === "pending" && taskOf(acc2, "T-3")?.acceptance === "pending",
    "4-26 接受只落在被接受的那一条任务上（其余仍 pending，不连带染绿）",
  );

  // ── 反例：非法登记在**写侧**就被拒（裁定 3），且一个字节都不落盘 ──
  const shaBeforeBadA = sha256File(eventsFile);
  const linesBeforeBadA = fs.readFileSync(eventsFile, "utf8").split("\n").filter((l) => l.trim() !== "").length;
  const badSub = await submitCommand({
    project: A,
    type: "audit.submission_submitted",
    entity_id: "submission:sub-bad",
    expected_revision: null,
    payload: {
      goal: "非法入口登记（反例）",
      task_id: "T-3",
      submitted_by: "kimi-code",
      runtime_entries: [{ scenario: "危险入口", url: "javascript:alert(1)", verified_at: freshIso, status: "reachable" }],
    },
  });
  ok(
    badSub.status !== 200 && errCodeOfBody(badSub.body) === "EVENT_INVALID",
    `4-27 反例：非法入口登记在**写侧**就被拒（HTTP ${badSub.status} ${errCodeOfBody(badSub.body)}）` +
      `——不再"按信封放行、留给读侧报错"：${errMessageOfBody(badSub.body).slice(0, 40)}…`,
  );
  const eventsTextA = fs.readFileSync(eventsFile, "utf8");
  ok(
    sha256File(eventsFile) === shaBeforeBadA &&
      eventsTextA.split("\n").filter((l) => l.trim() !== "").length === linesBeforeBadA &&
      !eventsTextA.includes("javascript:alert(1)"),
    `4-28 反例：被拒的非法登记**一个字节都没落盘**（事件文件 sha256 与行数（${linesBeforeBadA} 行）不变，全文里查不到 javascript:alert(1)）`,
  );
  const accAfterBad = await api(`/api/projects/${A}/acceptance`);
  ok(
    accAfterBad.status === 200 && (accAfterBad.body?.acceptance?.runtime_entries ?? []).length === 3,
    `4-28b 写侧把坏登记挡在门外之后，读口照常 ${accAfterBad.status}、入口仍 ${(accAfterBad.body?.acceptance?.runtime_entries ?? []).length} 条` +
      "——新写入产不出坏记录（读侧闸门对历史现场仍生效，见 ⑥-20～⑥-23）",
  );

  // ── ⑥ 裁定 F3 真链路：MCP 提交 → 持久化 → 验收页面显示 → 打开入口（夹具 C）──
  // 放在 4-x 之后：夹具 C 完全独立，但"重启后端"这一步只在这里做，避免影响上面各段的时间基准。
  await mcpResultEntryChecks({ freshIso, staleIso });

  // ── ⑧ 版本轴以真实现读源清单为当前版本：真造文件 + 经唯一宿主现读登记 + 产品读口（夹具 C）──
  await versionAxisFromManifestChecks();

  // ── ⑨ 版本轴经**真 HTTP 验收读口**：逐来源现读源清单（修复前 HTTP 下恒 unknown，是产品缺口）──
  await httpVersionAxisChecks();

  info(`── 小结：PASS ${passCount} / FAIL ${failCount}`);
}

main()
  .catch((e) => {
    console.error(`[verify] 异常：${(e as Error).stack ?? String(e)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // ── 收尾：关 MCP 客户端、杀子进程、删临时目录、塔台根文档首尾哈希对照 ──
    for (const c of mcpClients) await c.close();
    for (const proc of spawned) {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
    for (let i = 0; i < 40; i++) {
      if (!(await portListening(PORT))) break;
      await sleep(100);
    }
    const docDiffs: string[] = [];
    for (const [rel, before] of docBefore) {
      const after = fs.existsSync(path.join(REPO, rel)) ? sha256File(path.join(REPO, rel)) : "<missing>";
      if (after !== before) docDiffs.push(`${rel}: ${short(before)} → ${short(after)}`);
    }
    ok(docDiffs.length === 0, `5-1 塔台根文档首尾 sha256 一致（${DOC_FILES.length} 份零改动，含 DESIGN.md / AGENTS.md）`);
    const designSha = sha256File(path.join(REPO, "DESIGN.md"));
    const agentsSha = sha256File(path.join(REPO, "AGENTS.md"));
    info(`5-2 对照哈希：DESIGN.md ${designSha} ／ AGENTS.md ${agentsSha}`);
    if (process.env.TATAI_KEEP_TMP === "1") info(`保留现场：${tmpBase}`);
    else fs.rmSync(tmpBase, { recursive: true, force: true });
    console.log(`[verify] 合计 PASS ${passCount} / FAIL ${failCount}`);
    console.log(failCount === 0 ? "[verify] PASS" : "[verify] FAIL");
  });
