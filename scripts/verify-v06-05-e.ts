// 补修包 E 验证脚本（PLAN.md「补修分包」E 行，主责 V06-05，联验 V06-07；DESIGN §4.1 / §4.4 / §4.5）。
// 用法：pnpm verify:v06-05-e（或 node --import tsx scripts/verify-v06-05-e.ts）
//
// 这个脚本要证的七件事（逐条对应裁定与验证要求）：
//   ① **激活基线 → 自动触发**：真 HTTP 起后端（模型走**本脚本里的伪网关**），激活一条基线，
//      假模型被调用**恰好一次**；确定性派生先落地（激活响应不等模型），状态与回执可查。
//   ② **再次激活同一基线 → 缓存命中零重复调用**：伪网关请求数不变、图零重画（字节同一）。
//   ③ **相关来源变化 → 只重整理受影响范围**：施工图变了只整理施工段（输入里没有设计段条目清单），
//      设计段原样继承；反过来同理；调用次数可数（每轮 1 次）。
//   ④ **纯状态变化零模型调用**：任务进度 / 检查结果 / 颜色（状态投影）/ 布局四类变化之后，
//      模型调用 0、图不重画，且四类变化都不进分段缓存键（逐类断言键未变）。
//   ⑤ **模型不可用 → 降级与说明**：保留有效旧整理结果或只为确定性结果，说明版本/覆盖/缺失，
//      `semantic_complete:false`，不冒充"本轮完整语义整理已完成"。
//   ⑥ **坏出处只剔该条 / 过时响应不覆盖较新有效结果**：模型给定位不到的出处 → 该条在归一阶段被逐条剔除、
//      连条目一并记进图账目 omitted（点名主体与原文），其余条目照常合并与发布；
//      整理期间来源变了 → 该次结果作废（不覆盖较新结果，也不写进分段缓存）。
//      （2026-09-25 定向更新：V08-05 之前是"一个坏出处毁掉整层"，见 ⑥-a 段注释。）
//   ⑦ **`semantic:true` 显式路径仍可用且能强制重跑**，且它的结果会落进分段缓存 → 随后的自动链
//      命中缓存、零调用（`semantic:true` 不是产品链路的唯一触发方式）。
//
// 不调真网关：进程内的模型入口全部是注入的确定性夹具；真 HTTP 那一段让被测后端指向本脚本起的
// **伪网关**（`TATAI_DEEPSEEK_BASE_URL` + 假密钥）。环境隔离：临时 TATAI_HOME + `os.tmpdir()` 下
// 的夹具项目，**不碰**任何真实项目；塔台自身的文档首尾逐文件 sha256 对照（证明零改动）；
// 收尾清掉自建临时目录与起过的子进程（`TATAI_KEEP_TMP=1` 可保留现场）。
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  blueprintPath,
  planVsCode,
  readBlueprint,
  readBlueprintReceipt,
  readBlueprintSources,
  rebuildBlueprint,
  viewGraphWithPlan,
  type BlueprintChatFn,
  type BlueprintProposal,
} from "../src/arch/blueprint";
import {
  autoRebuildBlueprint,
  autoRunSettled,
  autoRunStatusOf,
  readSemanticCache,
  readSemanticStatus,
  recordExplicitSemanticResult,
  semanticCachePath,
  semanticScopeKey,
  semanticScopeSha,
  semanticStateOf,
  semanticStatusPath,
  triggerBlueprintAuto,
  SEMANTIC_MAX_ATTEMPTS_PER_RUN,
  SEMANTIC_MAX_FAILURE_ATTEMPTS,
  SEMANTIC_SCOPE_VERSION,
} from "../src/arch/blueprintAuto";
import { parseProject } from "../src/arch/parse";
import { savePositions } from "../src/arch/layoutStore";
import { saveFold } from "../src/arch/foldStore";
import { submitSelfCheck } from "../src/server/work/audit";
import { activateBaseline, activeBaseline, buildSectionIndex, designDefinitionText } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import {
  readTaskStates,
  renderPlanStatusRegion,
  submitDefinitionImports,
  submitTaskStatus,
  TASK_STATUS_LABELS,
  type TaskState,
} from "../src/server/work/tasks";
import { collectProjectFacts } from "../src/server/work/statusProjection";
import { WorkService } from "../src/server/work/service";
import { projectWorkDir } from "../src/server/workstation";
import type { FlashMessage } from "../src/server/flash";

const REPO = process.cwd();
const HTTP_PORT = 8826;
const STUB_PORT = 8827;
/** 首尾逐字节对照的文档（本包只读，一个字节都不许动；DESIGN.md 与 AGENTS.md 是硬要求） */
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

// ── 文档首尾哈希（证明零改动）──
const docBefore = new Map<string, string>();
for (const rel of DOC_FILES) {
  const abs = path.join(REPO, rel);
  docBefore.set(rel, fs.existsSync(abs) ? sha256File(abs) : "<missing>");
}

// ── 隔离环境与夹具 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0605e-verify-"));
const dataDir = path.join(tmpBase, "home");
const FIX_A = "e-fix-a";
const FIX_B = "e-fix-b";
const rootA = path.join(tmpBase, "fix-a");
const rootB = path.join(tmpBase, "fix-b");
const mkdirp = (d: string) => fs.mkdirSync(d, { recursive: true });
const write = (f: string, text: string) => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
const read = (f: string) => fs.readFileSync(f, "utf8");
const workbench = (root: string) => path.join(root, ".工作台");
const exists = (f: string) => fs.existsSync(f);
const hashOrNone = (f: string) => (exists(f) ? sha256File(f) : "<missing>");
for (const d of [dataDir, rootA, rootB]) mkdirp(d);

const DESIGN_TEXT = [
  "# 补修 E 夹具设计书",
  "",
  "## 1 概述",
  "夹具设计书：用来验证自动触发链。",
  "",
  "## 2 能力甲",
  "能力甲为人提供甲。",
  "",
  "## 3 能力乙",
  "能力乙为人提供乙。",
  "",
  "### 3.1 乙的子节",
  "故意不被引用的子节（覆盖账目要如实报）。",
  "",
  "## 4 模块划分",
  "- 模块甲：甲的实现",
  "- 模块乙：乙的实现",
  "",
  "## 5 能力丙",
  "暂无任务引用它。",
  "",
  "## 附录 A：说明",
  "附录不算能力节点。",
  "",
].join("\n");
const DESIGN_V2 = DESIGN_TEXT.replace("## 5 能力丙", "## 5 能力丙\n\n## 6 能力丁（后续新增）\n第二轮整理时新增的一节。");
const DESIGN_V3 = DESIGN_V2.replace("## 6 能力丁（后续新增）", "## 6 能力丁（第三版）\n第三版：用于模型不可用场景。");
const DESIGN_V4 = DESIGN_V3.replace("## 6 能力丁（第三版）", "## 6 能力丁（第四版）\n第四版：用于过时响应场景（旧响应）。");
const DESIGN_V5 = DESIGN_V4.replace("## 6 能力丁（第四版）", "## 6 能力丁（第五版）\n第五版：用于过时响应场景（较新结果）。");

const PLAN_TEXT = [
  "# 补修 E 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1 | todo | 能力甲落成 |  | 甲验收记录 |",
  "| T-2 | todo | 能力乙落成 | T-1 | 乙验收记录 |",
  "",
  "### T-1 能力甲落成",
  "",
  "**设计依据**：§2。**契约**：输入甲，输出甲的产物。",
  "",
  "**文件责任**：`src/mod-a/a.ts`。",
  "",
  "- [ ] 甲做出来",
  "",
  "**交付**：甲验收记录。",
  "",
  "### T-2 能力乙落成",
  "",
  "**设计依据**：§3。**契约**：输入乙，输出乙的产物。",
  "",
  "**文件责任**：`src/mod-b/b.ts`。",
  "",
  "- [ ] 乙做出来",
  "",
  "**交付**：乙验收记录。",
  "",
].join("\n");
/** 施工段变化：加一张卡（定义哈希必变） */
const PLAN_V2 = PLAN_TEXT.replace(
  "### T-2 能力乙落成",
  "### T-3 能力丙落成\n\n**设计依据**：§5。\n\n**文件责任**：`src/mod-c/c.ts`。\n\n**交付**：丙验收记录。\n\n### T-2 能力乙落成",
).replace("| T-2 | todo | 能力乙落成 | T-1 | 乙验收记录 |", "| T-2 | todo | 能力乙落成 | T-1 | 乙验收记录 |\n| T-3 | todo | 能力丙落成 | T-2 | 丙验收记录 |");

write(path.join(workbench(rootA), "design.md"), DESIGN_TEXT);
write(path.join(workbench(rootA), "plan.md"), PLAN_TEXT);
write(path.join(rootA, "src", "mod-a", "a.ts"), "export const A = 'a';\n");
write(path.join(rootA, "src", "mod-b", "b.ts"), "export const B = 'b';\n");
write(path.join(rootA, "src", "mod-c", "c.ts"), "export const C = 'c';\n");
write(path.join(rootA, "legacy", "old.ts"), "export const OLD = 'legacy';\n");
// 夹具 B：**没有**任何语义整理历史（用于"模型不可用且没有旧整理结果"的对照）
write(path.join(workbench(rootB), "design.md"), DESIGN_TEXT.replace("补修 E 夹具设计书", "补修 E 夹具设计书（B）"));
write(path.join(workbench(rootB), "plan.md"), PLAN_TEXT);

const record = (id: string, name: string, dir: string) => ({
  id,
  name,
  path: dir,
  kind: "backend",
  registered_at: "2026-09-21T00:00:00+08:00",
  last_opened_at: "2026-09-21T00:00:00+08:00",
});
write(
  path.join(dataDir, "registry.json"),
  JSON.stringify({ version: 1, projects: [record(FIX_A, "补修 E 夹具 A", rootA), record(FIX_B, "补修 E 夹具 B", rootB)] }, null, 2),
);
process.env.TATAI_HOME = dataDir;

const activate = (id: string) =>
  activateBaseline(
    id,
    { approved_by: "user", approval_basis: "补修 E 隔离夹具审定（不代表真实用户 Gate）", approval_kind: "user_confirmed" },
    dataDir,
  );

/** 设计书里 SECTION_PATH 对应的章节路径（与生产口径同源现算，不手抄） */
const DESIGN_PATH = ".工作台/design.md";
const PLAN_PATH = ".工作台/plan.md";
const SECTION_PATH = buildSectionIndex(designDefinitionText(DESIGN_TEXT)).find((s) => s.path.endsWith("4 模块划分"))?.path ?? "4 模块划分";

// ── 模型夹具 ──

/** 伪模型返回：按范围给条目；`marker` 进节点 id，用来断言"哪一轮的结果在图上" */
function proposalFor(marker: string, opts: { design: boolean; plan: boolean; badRef?: boolean }): BlueprintProposal {
  const nodes = opts.design
    ? [
        {
          id: `plan:concept:${marker}`,
          kind: "concept" as const,
          name: `伪模型概念 ${marker}`,
          source_refs: [
            { kind: "design_section" as const, path: DESIGN_PATH, locator: opts.badRef === true ? "不存在的章节" : SECTION_PATH, sha256: null },
          ],
          related_ids: ["plan:task:T-1"],
        },
      ]
    : [];
  const edges = opts.plan
    ? [
        {
          source: opts.design ? `plan:concept:${marker}` : "plan:task:T-1",
          target: "plan:task:T-2",
          kind: "model_inference" as const,
          source_refs: [{ kind: "plan_task" as const, path: PLAN_PATH, locator: "T-2", sha256: null }],
          certainty: "inferred" as const,
        },
      ]
    : [];
  return { nodes, edges };
}

interface ChatFixture {
  fn: BlueprintChatFn;
  calls: () => number;
  payloads: () => string[];
  payloadsRaw: string[];
}

/**
 * 确定性伪模型：
 *  · 按"本轮需整理范围"决定给哪些段的条目（模拟真实模型：只整理被要求的那一段）；
 *  · `delayMs` 用来把响应挂住（过时响应场景）；`errorText` / `badJson` 用来模拟失败；
 *  · 把每次**输入**原文记下来（"只处理受影响范围"要靠它证明：未受影响段不在输入里）。
 */
function mkChat(opts: {
  marker: string;
  design?: boolean;
  plan?: boolean;
  delayMs?: number;
  errorText?: string;
  badJson?: boolean;
  badRef?: boolean;
  ignoreFocus?: boolean;
}): ChatFixture {
  let calls = 0;
  const payloads: string[] = [];
  const fn: BlueprintChatFn = async (messages: FlashMessage[]) => {
    calls += 1;
    const text = messages.map((m) => String(m.content)).join("\n");
    payloads.push(text);
    if (opts.delayMs !== undefined && opts.delayMs > 0) await sleep(opts.delayMs);
    if (opts.errorText !== undefined) throw new Error(opts.errorText);
    const focus = opts.ignoreFocus === true ? { design: true, plan: true } : focusOf(text);
    const json = proposalFor(opts.marker, {
      design: (opts.design ?? true) && focus.design,
      plan: (opts.plan ?? true) && focus.plan,
      ...(opts.badRef === undefined ? {} : { badRef: opts.badRef }),
    });
    if (opts.badJson === true) return { text: "模型答了，但这不是 JSON", json: null, error: "输出里没有 JSON 值（既没有 { 也没有 [）" };
    return { text: "```json\n" + JSON.stringify(json) + "\n```", json, error: null };
  };
  return { fn, calls: () => calls, payloads: () => [...payloads], payloadsRaw: payloads };
}

/** 从伪模型的输入里读出"本轮需整理范围" */
function focusOf(text: string): { design: boolean; plan: boolean } {
  const m = text.match(/"本轮需整理范围":\[([^\]]*)\]/);
  if (m === null) return { design: true, plan: true }; // 全量整理（显式 semantic:true 路径）
  return { design: m[1].includes("design"), plan: m[1].includes("plan") };
}

interface StubGateway {
  server: http.Server;
  close: () => Promise<void>;
  requests: () => { at: number; body: string }[];
}

/** 伪网关（真 HTTP 那一段用）：OpenAI 兼容 SSE，回一段能过程序校验的整理结果 */
async function startStubGateway(): Promise<StubGateway> {
  const requests: { at: number; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => {
      body += d.toString("utf8");
    });
    req.on("end", async () => {
      requests.push({ at: Date.now(), body });
      await sleep(120); // 让"激活响应先落地"这件事可测
      const focus = focusOf(body.replace(/\\"/g, '"')); // SSE 请求体里锚点是转义过的 JSON 串
      // 伪网关也按范围给条目（模拟真实模型听话的样子）
      const json = proposalFor("http", focus);
      const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.end(
        chunk({ choices: [{ delta: { content: "```json\n" + JSON.stringify(json) + "\n```" }, finish_reason: null }] }) +
          chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
          "data: [DONE]\n\n",
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(STUB_PORT, "127.0.0.1", () => resolve());
  });
  return {
    server,
    close: () => new Promise<void>((r) => server.close(() => r())),
    requests: () => [...requests],
  };
}

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

const api = async (p: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
  const r = await fetch(`http://127.0.0.1:${HTTP_PORT}${p}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await r.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
};

async function waitFor<T>(fn: () => T | null, timeoutMs: number, label: string, intervalMs = 50): Promise<T | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = fn();
    if (v !== null) return v;
    await sleep(intervalMs);
  }
  info(`等待超时：${label}`);
  return null;
}

const scopeOf = (st: { scopes: { scope: string; state: string }[] }, scope: string) => st.scopes.find((s) => s.scope === scope)?.state ?? "（缺）";
const mkState = (task_id: string, status: keyof typeof TASK_STATUS_LABELS): TaskState => ({
  task_id,
  status: status as TaskState["status"],
  status_label: TASK_STATUS_LABELS[status as TaskState["status"]],
  cancelled: false,
  cancel_reason: null,
  blocked_reason: null,
  change_id: null,
  definition_change_id: null,
  run_id: null,
  attempt_id: null,
  owner_id: null,
  claim_token: null,
  lease_expires_at: null,
  definition_sha256: null,
  plan_revision: null,
  definition_revision: null,
  revision: 1,
  // V09-10：TaskState 新增 attempt/last_reopen（重开留痕）；本夹具不涉及返工，给零值
  attempt: null,
  last_reopen: null,
  seq: 1,
  last_event_id: "evt-fixture",
  updated_at: "2026-09-21T00:00:00+08:00",
  last_actor: "verify-v06-05-e",
});

let stub: StubGateway | null = null;
let serverChild: ChildProcess | null = null;

try {
  // ═══════════ ① 激活基线 → 自动触发（真 HTTP + 伪网关，假模型恰好一次） ═══════════
  info("── ① 有效基线激活 → 自动触发链（真后端 + 伪网关，不调真网关）");
  parseProject(FIX_A, dataDir);
  const baselineB = activate(FIX_B);
  ok(baselineB.created, `① 夹具 B 也先激活一条基线（${baselineB.baseline.baseline_id}）`);
  const baselineA = activate(FIX_A);
  ok(baselineA.created && activeBaseline(FIX_A, dataDir)?.baseline_id === baselineA.baseline.baseline_id, `① 先用 V06-02 程序入口激活夹具 A 的基线（${baselineA.baseline.baseline_id}）`);
  // 清掉图与语义缓存，让"激活触发了自动链"这件事可归因
  for (const f of [blueprintPath(FIX_A, dataDir), semanticCachePath(FIX_A, dataDir), semanticStatusPath(FIX_A, dataDir)]) fs.rmSync(f, { force: true });

  if (await portListening(HTTP_PORT)) {
    ok(false, `① 端口 ${HTTP_PORT} 被占用：无法起真后端验证激活触发，先清理残留进程`);
  } else {
    stub = await startStubGateway();
    const proc = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
      cwd: REPO,
      env: {
        ...process.env,
        TATAI_HOME: dataDir,
        TATAI_PORT: String(HTTP_PORT),
        TATAI_DEEPSEEK_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
        DEEPSEEK_API_KEY: "stub-key-for-verify-v06-05-e",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    spawned.push(proc);
    serverChild = proc;
    proc.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));
    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/health`);
        if (r.ok) break;
      } catch {
        // 还没起来
      }
      await sleep(250);
    }
    const t0 = Date.now();
    const act = await api(`/api/projects/${FIX_A}/documents/activate`, {
      method: "POST",
      body: JSON.stringify({ approved_by: "user", approval_basis: "补修 E HTTP 触发夹具", approval_kind: "user_confirmed" }),
    });
    const activateMs = Date.now() - t0;
    ok(act.status === 200, `① POST documents/activate 成功（HTTP ${act.status}）`);

    // 确定性派生先落地：激活响应返回时模型还没被打到（伪网关的到达时间晚于响应）
    const firstArrival = await waitFor(() => (stub !== null && stub.requests().length > 0 ? stub.requests()[0] : null), 20_000, "伪网关第一次请求");
    ok(
      firstArrival !== null && firstArrival.at - t0 > activateMs,
      `① **不 await 阻塞激活主流程**：激活响应 ${activateMs}ms 返回，伪网关 ${firstArrival === null ? "（未到）" : `${firstArrival.at - t0}ms 才被打到`}（前者先于后者）`,
    );
    const detReceipt = await waitFor(
      () => {
        const r = readBlueprintReceipt(FIX_A, dataDir);
        return r !== null && String(r.trigger).includes("deterministic") ? r : null;
      },
      20_000,
      "确定性派生回执",
    );
    ok(
      detReceipt !== null && detReceipt.published === true && detReceipt.model_calls === 0,
      `① 确定性派生**先发布**且零模型（回执 trigger=${detReceipt?.trigger ?? "（无）"}、model_calls=${detReceipt?.model_calls ?? "?"}）`,
    );

    // 等自动链跑完（状态落盘且 finished_at 非空）
    const done1 = await waitFor(() => {
      const st = readSemanticStatus(FIX_A, dataDir);
      return st !== null && st.finished_at !== null ? st : null;
    }, 30_000, "自动链第一次运行完成");
    const reqCount = stub.requests().length;
    ok(
      done1 !== null && done1.outcome === "semantic_ready" && reqCount === 1,
      `① 激活自动触发语义整理：伪网关被调用**恰好一次**（实际 ${reqCount} 次），outcome=${done1?.outcome ?? "（无）"}`,
    );
    ok(
      done1 !== null && done1.semantic_complete === true && scopeOf(done1, "design") === "tidied" && scopeOf(done1, "plan") === "tidied",
      `① 本轮覆盖两个来源段：design=${done1 === null ? "?" : scopeOf(done1, "design")} / plan=${done1 === null ? "?" : scopeOf(done1, "plan")}、semantic_complete=${done1?.semantic_complete ?? "?"}`,
    );
    const bp1 = readBlueprint(FIX_A, dataDir);
    // 2026-09-26 定向更新（R-2/B 类返工，非作者复审 independent-v0918-review-20260926 §七 R-2）——五要素留档：
    //   旧期望（旧实现）：伪模型补的概念节点并进 `bp.nodes` ⇒ `bp1.nodes.some(plan:concept:http)`｜
    //   依据：审计 probe2 P3——提案自报的新节点直入正式节点集会进交付对象清单（投影查不到 ⇒ missing ⇒
    //     阻断交付读数）；§4.1 要求提案节点留在待审线索层｜
    //   新期望：概念节点**不在正式节点集**，原始提案与处置留在 `model_node_leads`（`target="new_node"`）｜
    //   保留意图：整理结果照样可见可追溯、照常发布，但一条都不升格为正式对象。
    ok(
      bp1 !== null &&
        bp1.publish.published &&
        !bp1.nodes.some((n) => n.id === "plan:concept:http") &&
        (bp1.model_node_leads ?? []).some((l) => l.id === "plan:concept:http" && l.target === "new_node" && l.disposition === "lead_pending_review"),
      `① 整理结果照常发布＋提案概念待在审线索层（正式节点 ${bp1?.nodes.length ?? 0} 个、不含模型自报概念；节点线索 ${(bp1?.model_node_leads ?? []).length} 条，含 plan:concept:http）`,
    );
    const got = await api(`/api/projects/${FIX_A}/arch/blueprint`);
    ok(
      got.status === 200 &&
        got.body?.semantic?.status?.run_id === done1?.run_id &&
        typeof got.body?.semantic?.note === "string" &&
        Array.isArray(got.body?.semantic?.scopes),
      `① 状态与回执**可查**：GET arch/blueprint 同返 semantic 段（run_id=${got.body?.semantic?.status?.run_id ?? "（无）"}、分段 ${got.body?.semantic?.scopes?.length ?? 0} 条）`,
    );
    ok(
      got.body?.semantic?.scopes?.every((s: { key: string | null }) => typeof s.key === "string") === true &&
        !JSON.stringify(got.body?.semantic ?? {}).match(/[A-Za-z]:[\\/]/),
      "① 只读状态里只有哈希与段名：没有本机绝对路径（远程读口径）",
    );
    const receipt1 = readBlueprintReceipt(FIX_A, dataDir);
    ok(
      receipt1 !== null && receipt1.model_calls >= 1 && receipt1.model?.ok === true,
      `① 图回执记下这一版整理的模型调用（model_calls=${receipt1?.model_calls ?? "?"}、ok=${String(receipt1?.model?.ok)}）`,
    );

    // ═══════════ ② 再次激活同一基线 → 缓存命中零重复调用 ═══════════
    info("── ② 再次激活同一基线 → 缓存命中（零重复调用、零重画）");
    const bpBytes1 = hashOrNone(blueprintPath(FIX_A, dataDir));
    const runId1 = done1?.run_id ?? "";
    const act2 = await api(`/api/projects/${FIX_A}/documents/activate`, {
      method: "POST",
      body: JSON.stringify({ approved_by: "user", approval_basis: "补修 E HTTP 触发夹具（第二次）", approval_kind: "user_confirmed" }),
    });
    const done2 = await waitFor(() => {
      const st = readSemanticStatus(FIX_A, dataDir);
      return st !== null && st.finished_at !== null && st.run_id !== runId1 ? st : null;
    }, 30_000, "自动链第二次运行完成");
    ok(act2.status === 200 && act2.body?.created === false, `② 同对图纸重复激活返回既有基线（created=${String(act2.body?.created)}）`);
    ok(
      done2 !== null && done2.outcome === "cache_hit" && done2.blueprint.repainted === false,
      `② 缓存有效即复用：outcome=${done2?.outcome ?? "（无）"}、repainted=${String(done2?.blueprint.repainted)}`,
    );
    ok(
      stub.requests().length === reqCount,
      `② **零重复调用**：伪网关请求数仍为 ${reqCount}（第二次激活一次都没打）`,
    );
    ok(
      hashOrNone(blueprintPath(FIX_A, dataDir)) === bpBytes1,
      "② **零重画**：蓝图文件逐字节未变（完整缓存命中一个字节都没重算）",
    );
    ok(
      done2 !== null && done2.model.calls === 0 && done2.scopes.every((s) => s.model_calls === 0),
      `② 状态里两段的模型调用计数都是 0（${done2?.scopes.map((s) => `${s.scope}:${s.model_calls}`).join(" / ") ?? "（无）"}）`,
    );
    await stopChild(serverChild);
    serverChild = null;
    await stub.close();
    stub = null;
  }

  // ═══════════ ③ 相关来源变化 → 只重整理受影响范围 ═══════════
  info("── ③ 施工图变了 → 只整理施工段；设计书变了 → 只整理设计段");
  const designKey0 = semanticScopeKey(readBlueprintSources(FIX_A, dataDir), "design");
  const planKey0 = semanticScopeKey(readBlueprintSources(FIX_A, dataDir), "plan");
  const cache0 = readSemanticCache(FIX_A, dataDir).cache;
  const designRanAt0 = cache0.shards.design?.ran_at ?? null;
  const designRaw0 = cache0.shards.design?.raw_sha256 ?? null;

  write(path.join(workbench(rootA), "plan.md"), PLAN_V2);
  const planDirty = semanticScopeKey(readBlueprintSources(FIX_A, dataDir), "plan");
  const chatPlan = mkChat({ marker: "plan-round", design: true, plan: true });
  const r3a = await autoRebuildBlueprint(FIX_A, {
    dataDir,
    trigger: "e-step3-plan",
    chat: chatPlan.fn,
    kickoff_delay_ms: 0,
  });
  ok(
    r3a.model_calls === 1 && chatPlan.calls() === 1,
    `③-a 只发一次调用（model_calls=${r3a.model_calls}、夹具计数=${chatPlan.calls()}）`,
  );
  ok(
    planDirty !== planKey0 && semanticScopeKey(readBlueprintSources(FIX_A, dataDir), "design") === designKey0,
    "③-a 只有施工段键变了（设计段键未变）",
  );
  ok(
    focusOf(chatPlan.payloads()[0] ?? "").plan === true && focusOf(chatPlan.payloads()[0] ?? "").design === false,
    "③-a 输入里只带施工段（本轮需整理范围 = plan，未受影响的设计段不在输入清单里）",
  );
  ok(
    (chatPlan.payloads()[0] ?? "").includes("未整理范围索引_设计") && !(chatPlan.payloads()[0] ?? "").includes("设计章节"),
    "③-a 输入里设计段只留稳定 ID 索引（没有设计章节清单）：未受影响部分不重整理",
  );
  ok(
    scopeOf(r3a.status, "plan") === "tidied" && scopeOf(r3a.status, "design") === "reused",
    `③-a 分段状态：plan=${scopeOf(r3a.status, "plan")}（本轮整理）/ design=${scopeOf(r3a.status, "design")}（复用缓存）`,
  );
  const cacheA = readSemanticCache(FIX_A, dataDir).cache;
  ok(
    cacheA.shards.design?.scope_key === designKey0 && cacheA.shards.design?.ran_at === designRanAt0,
    "③-a 设计段缓存记录原样保留（没重跑、没被覆盖）",
  );
  const bpAfter3a = readBlueprint(FIX_A, dataDir);
  // 定向更新（V09-18 提案线索化 ＋ R-2 节点侧线索化，2026-09-26；五要素留档见 ① 段）：判据未放宽——
  //   旧期望：本轮施工段的整理（model_inference 关系）作为**正式边**进图；概念节点进 nodes｜
  //   依据：模型提案一律**待审线索**——关系进 `model_leads`、节点进 `model_node_leads`（R-2）｜
  //   新期望：上一轮的概念节点与关系都在**线索账**里查得到（分段语义：未受影响段不丢）｜
  //   保留意图：未受影响段的整理结果不丢、部分失败不抹掉已有效内容——身份从「正式对象/正式边」改为「待审线索」。
  ok(
    bpAfter3a !== null &&
      (bpAfter3a.model_node_leads ?? []).some((l) => l.id === "plan:concept:http") &&
      !bpAfter3a.nodes.some((n) => n.id === "plan:concept:http") &&
      (bpAfter3a.model_leads ?? []).some((l) => l.source === "plan:task:T-1" && l.target === "plan:task:T-2" && l.kind === "model_inference"),
    `③-a 未受影响段的整理结果仍在线索账（① 的概念节点与关系都在），本轮施工段的整理同样以**待审线索**入账（${bpAfter3a?.nodes.length ?? 0} 正式节点 / ${(bpAfter3a?.model_node_leads ?? []).length} 节点线索 / ${(bpAfter3a?.model_leads ?? []).length} 条关系线索；正式节点与正式关系都不收模型提案）`,
  );

  write(path.join(workbench(rootA), "design.md"), DESIGN_V2);
  const chatDesign = mkChat({ marker: "design-round", design: true, plan: true });
  const r3b = await autoRebuildBlueprint(FIX_A, { dataDir, trigger: "e-step3-design", chat: chatDesign.fn, kickoff_delay_ms: 0 });
  ok(
    chatDesign.calls() === 1 && focusOf(chatDesign.payloads()[0] ?? "").design === true && focusOf(chatDesign.payloads()[0] ?? "").plan === false,
    `③-b 反过来同理：设计段变了只整理设计段（调用 ${chatDesign.calls()} 次、本轮范围 = design）`,
  );
  ok(
    (chatDesign.payloads()[0] ?? "").includes("设计章节") && (chatDesign.payloads()[0] ?? "").includes("未整理范围索引_施工"),
    "③-b 输入里只有设计段清单，施工段只留卡号索引",
  );
  ok(
    scopeOf(r3b.status, "design") === "tidied" && scopeOf(r3b.status, "plan") === "reused" && r3b.model_calls === 1,
    `③-b 分段状态：design=${scopeOf(r3b.status, "design")} / plan=${scopeOf(r3b.status, "plan")}，模型调用 ${r3b.model_calls} 次`,
  );
  const bpAfter3b = readBlueprint(FIX_A, dataDir);
  // 定向更新（V09-18 提案线索化 ＋ R-2 节点侧线索化，2026-09-26；五要素留档见 ① 段）：
  //   模型关系/节点从 edges/nodes 移到线索账，**分段语义不变**——「同段替换」这一事实改为从**分段缓存**核
  //   （设计段 proposal 里只剩本轮 marker），而蓝图线索账按 §4.1「不靠对象消失消账」保留历史留痕。
  const cache3b = readSemanticCache(FIX_A, dataDir).cache;
  const designShardNodes = (cache3b.shards.design?.proposal?.nodes ?? []).map((n) => n.id);
  ok(
    bpAfter3b !== null &&
      (bpAfter3b.model_node_leads ?? []).some((l) => l.id === "plan:concept:design-round") &&
      (bpAfter3b.model_leads ?? []).some((l) => l.source === "plan:task:T-1" && l.target === "plan:task:T-2" && l.kind === "model_inference") &&
      !bpAfter3b.nodes.some((n) => n.id.startsWith("plan:concept:")) &&
      designShardNodes.length === 1 &&
      designShardNodes[0] === "plan:concept:design-round",
    `③-b 两段结果各自独立：设计段的分段缓存换成本轮结果（shard 里只剩 ${designShardNodes.join("、") || "（空）"}，旧的 plan:concept:http 被同段替换），施工段上一轮的关系以待审线索原样保留；蓝图节点线索账按 §4.1 不靠对象消失消账（历史留痕保留，正式节点集零模型概念节点）`,
  );
  ok(
    readSemanticCache(FIX_A, dataDir).cache.shards.design?.raw_sha256 !== designRaw0,
    "③-b 设计段缓存确实换成了新来源的那一份（raw_sha256 变了）",
  );

  // ═══════════ ④ 纯状态变化 → 零模型调用 ═══════════
  info("── ④ 任务进度 / 检查结果 / 颜色（状态投影）/ 布局变化 → 零模型调用、零重画");
  const bpBytes4 = hashOrNone(blueprintPath(FIX_A, dataDir));
  const designKey4 = semanticScopeKey(readBlueprintSources(FIX_A, dataDir), "design");
  const planKey4 = semanticScopeKey(readBlueprintSources(FIX_A, dataDir), "plan");
  const defHashBefore = readBlueprintSources(FIX_A, dataDir).plan?.definition_sha256 ?? "";
  // (a) 任务进度：工作层真事件 + 施工图状态列投影
  const svc = new WorkService({ dataDir });
  const imported = importTaskDefinitions(read(path.join(workbench(rootA), "plan.md")));
  submitDefinitionImports(svc, {
    project_id: FIX_A,
    change_id: "e-defs",
    actor_id: "verify-v06-05-e",
    role: "executor",
    definitions: imported.definitions,
  });
  const rev = readTaskStates(projectWorkDir(FIX_A, dataDir)).states["T-1"]?.revision ?? 0;
  submitTaskStatus(svc, {
    project_id: FIX_A,
    task_id: "T-1",
    change_id: "e-status",
    actor_id: "verify-v06-05-e",
    role: "executor",
    expected_revision: rev,
    status: "executing",
  });
  const projected = renderPlanStatusRegion(read(path.join(workbench(rootA), "plan.md")), { "T-1": mkState("T-1", "executing") });
  write(path.join(workbench(rootA), "plan.md"), projected.text);
  // (b) 检查结果：真提交一条自检记录（走唯一写入服务）
  const selfCheck = submitSelfCheck(svc, {
    project_id: FIX_A,
    change_id: "e-checks",
    actor_id: "verify-v06-05-e",
    role: "executor",
    record_id: "e-self-T-1-1",
    task_id: "T-1",
    checked_by: "verify-v06-05-e",
    checks: [{ check_id: "T-1::check:0", method: "跑夹具检查", command: "node -e check", exit_code: 0, scope: ["src/mod-a"], verifies: "code" }],
    conclusion: "pass",
    binding: { revision_kind: "code", revision: "v06-05-e-code-rev" },
  });
  // (c) 颜色：颜色由状态投影派生——真读一次投影（这是配色的唯一来源），不产生任何图改动
  const facts = collectProjectFacts(FIX_A, dataDir);
  // 布局：真写布局与折叠态（V08-01：模块节点 id 改为稳定 ID，这里从派生图**动态取**，不写死格式）
  savePositions(FIX_A, { "plan:cap:01": { x: 120, y: 40 } }, "MODULE_BOX", dataDir);
  const foldModId =
    readBlueprint(FIX_A, dataDir)?.nodes.find((n) => n.kind === "module" && n.name === "模块甲")?.id ?? "plan:mod:4-L4";
  saveFold(FIX_A, [{ id: foldModId, path: "4 模块划分" }], dataDir);
  // 视图/渲染读口（旧图 + 规划层合成）也真读一遍
  const view = viewGraphWithPlan(FIX_A, { dataDir });
  const reconcile = planVsCode(FIX_A, { dataDir });
  const chatIdle = mkChat({ marker: "should-not-run" });
  const r4 = await autoRebuildBlueprint(FIX_A, { dataDir, trigger: "status_changed", chat: chatIdle.fn, kickoff_delay_ms: 0 });
  ok(
    projected.changed.includes("T-1") &&
      defHashBefore === (readBlueprintSources(FIX_A, dataDir).plan?.definition_sha256 ?? "") &&
      selfCheck.seq >= 0 &&
      facts.baseline?.baseline_id === baselineA.baseline.baseline_id &&
      view.graph.nodes.length > 0 &&
      reconcile !== null,
    `④ 前置：四类变化都真发生了（状态列 ${projected.changed.join("/")}、自检记录已入流水（seq ${selfCheck.seq}）、投影事实 ${Object.keys(facts.task_states).length} 个任务状态、布局/折叠已写、合成视图 ${view.graph.nodes.length} 节点）`,
  );
  ok(
    chatIdle.calls() === 0 && r4.model_calls === 0 && r4.status.model.calls === 0,
    `④ 纯状态变化**零模型调用**（夹具计数 ${chatIdle.calls()}、结果 model_calls=${r4.model_calls}、状态计数=${r4.status.model.calls}）`,
  );
  ok(
    r4.repainted === false && hashOrNone(blueprintPath(FIX_A, dataDir)) === bpBytes4,
    "④ **零重画**：蓝图文件逐字节未变（命中完整缓存，一个字节没重算）",
  );
  ok(
    semanticScopeKey(readBlueprintSources(FIX_A, dataDir), "design") === designKey4 &&
      semanticScopeKey(readBlueprintSources(FIX_A, dataDir), "plan") === planKey4,
    "④ 四类变化都**不进分段缓存键**（设计段/施工段键逐字未变）",
  );
  ok(
    r4.outcome === "cache_hit" && r4.scopes.every((s) => s.state === "reused"),
    `④ 状态自述：outcome=${r4.outcome}、两段都 reused（${r4.scopes.map((s) => `${s.scope}:${s.state}`).join(" / ")}）`,
  );
  const st4 = semanticStateOf(FIX_A, { dataDir });
  ok(
    st4.scopes.every((s) => s.state === "fresh") && st4.note.includes("2/2"),
    `④ 只读状态快照也说"两段都是当前来源"（${st4.scopes.map((s) => `${s.scope}:${s.state}`).join(" / ")}）`,
  );

  // ═══════════ ⑤ 模型不可用 → 降级与说明 ═══════════
  info("── ⑤ 模型不可用 → 保留有效旧结果 / 确定性降级 + 说明版本·覆盖·缺失（不冒充完整整理）");
  write(path.join(workbench(rootA), "design.md"), DESIGN_V3);
  const chatFail = mkChat({ marker: "never", errorText: "夹具模型故障：网关 502" });
  const r5a = await autoRebuildBlueprint(FIX_A, { dataDir, trigger: "e-step5-fail", chat: chatFail.fn, kickoff_delay_ms: 0 });
  ok(
    chatFail.calls() === SEMANTIC_MAX_ATTEMPTS_PER_RUN && r5a.model_calls === SEMANTIC_MAX_ATTEMPTS_PER_RUN,
    `⑤-a 有界重试：一轮内最多 ${SEMANTIC_MAX_ATTEMPTS_PER_RUN} 次（实际 ${chatFail.calls()} 次），不是无界重试`,
  );
  ok(
    r5a.status.semantic_complete === false && r5a.outcome.startsWith("degraded"),
    `⑤-a **不冒充本轮完整整理完成**：outcome=${r5a.outcome}、semantic_complete=${String(r5a.status.semantic_complete)}`,
  );
  ok(
    scopeOf(r5a.status, "design") === "failed" && r5a.status.missing.some((m) => m.scope === "design") && r5a.status.missing.some((m) => m.reason.includes("502")),
    `⑤-a 缺失如实点名：design=${scopeOf(r5a.status, "design")}、missing=[${r5a.status.missing.map((m) => `${m.scope}:${m.reason.slice(0, 18)}`).join("；")}]`,
  );
  ok(
    r5a.status.note.includes("版本") && r5a.status.note.includes("生成器") && r5a.status.note.includes("缺失范围") && r5a.status.note.includes(`分段口径 ${SEMANTIC_SCOPE_VERSION}`),
    `⑤-a 说明里带版本/覆盖/缺失（note=${r5a.status.note.slice(0, 72)}…）`,
  );
  const bp5a = readBlueprint(FIX_A, dataDir);
  // 定向更新（V09-18 提案线索化 ＋ R-2 节点侧线索化，2026-09-26；五要素留档见 ① 段）：模型不可用不抹掉已有效内容——
  // 上一版整理结果以**待审线索**身份保留（节点在 model_node_leads、关系在 model_leads，内容一条不丢）。
  ok(
    bp5a !== null &&
      (bp5a.model_node_leads ?? []).some((l) => l.id === "plan:concept:design-round") &&
      !bp5a.nodes.some((n) => n.id.startsWith("plan:concept:")) &&
      (bp5a.model_leads ?? []).some((l) => l.source === "plan:task:T-1" && l.target === "plan:task:T-2" && l.kind === "model_inference"),
    "⑤-a 保留有效旧整理结果：上一版设计段与施工段的条目都还在**待审线索账**里（模型不可用不抹掉已有效的内容；正式节点集零模型概念节点）",
  );
  const cache5 = readSemanticCache(FIX_A, dataDir).cache;
  ok(
    cache5.failures.design !== undefined && cache5.failures.design.attempts >= 1 && cache5.shards.design?.scope_key === designKey4,
    `⑤-a 失败记账 + 旧结果留着：failures.design.attempts=${cache5.failures.design?.attempts ?? 0}、缓存仍是旧来源那一版`,
  );
  ok(
    r5a.status.scopes.find((s) => s.scope === "design")?.stale_source === true,
    "⑤-a 如实标注这批结果**基于旧来源**（stale_source=true，不当现行）",
  );
  // ⑤-b：没有旧整理结果 + 模型不可用 → 只出确定性降级结果，并说清缺什么
  const chatFailB = mkChat({ marker: "never", errorText: "夹具模型故障：网关 502" });
  const r5b = await autoRebuildBlueprint(FIX_B, { dataDir, trigger: "e-step5-fail-nocache", chat: chatFailB.fn, kickoff_delay_ms: 0 });
  const bp5b = readBlueprint(FIX_B, dataDir);
  ok(
    bp5b !== null && bp5b.publish.published && bp5b.nodes.some((n) => n.kind === "capability") && !bp5b.nodes.some((n) => n.id.startsWith("plan:concept:")),
    `⑤-b 没有旧整理结果时展示**确定性降级结果**（${bp5b?.nodes.length ?? 0} 个确定性节点、零模型概念节点）`,
  );
  ok(
    r5b.status.semantic_complete === false && r5b.status.missing.length === 2 && r5b.status.model.error !== null,
    `⑤-b 说明缺什么：missing=${r5b.status.missing.map((m) => m.scope).join("/")}、模型错误=${JSON.stringify(r5b.status.model.error)}`,
  );
  // ⑤-c：真"没配密钥"的配置类错误也算模型不可用（这一条走缺省模型入口，但本机没密钥 → 不会打到真网关）
  const savedKey = process.env.DEEPSEEK_API_KEY;
  const savedBase = process.env.TATAI_DEEPSEEK_BASE_URL;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "";
    process.env.TATAI_DEEPSEEK_BASE_URL = `http://127.0.0.1:${STUB_PORT + 9}`; // 死端口：即便走到网络也连不上
    // 注入"一分钟后"的时钟：跳过跨轮退避，真走到"调模型"那一步（缺省模型入口 → 没密钥 → 配置类错误）
    const r5c = await autoRebuildBlueprint(FIX_B, {
      dataDir,
      trigger: "e-step5-nokey",
      kickoff_delay_ms: 0,
      now: () => new Date(Date.now() + 60_000).toISOString(),
    });
    ok(
      r5c.status.model.available === false && r5c.status.semantic_complete === false,
      `⑤-c 未配置密钥按"模型不可用"处理（available=${String(r5c.status.model.available)}、错误=${JSON.stringify(r5c.status.model.error?.slice(0, 24))}）`,
    );
  } finally {
    if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.TATAI_DEEPSEEK_BASE_URL;
    else process.env.TATAI_DEEPSEEK_BASE_URL = savedBase;
  }
  // ⑤-d：跨轮退避 + 终止态（不重复打同一个坏来源）
  const chatFailAgain = mkChat({ marker: "never", errorText: "夹具模型故障：网关 502" });
  const r5d = await autoRebuildBlueprint(FIX_A, { dataDir, trigger: "e-step5-backoff", chat: chatFailAgain.fn, kickoff_delay_ms: 0 });
  ok(
    chatFailAgain.calls() === 0 && r5d.model_calls === 0,
    `⑤-d 距上次失败不足退避窗口 → 本轮不重试（夹具计数 ${chatFailAgain.calls()}）：避免重试风暴`,
  );
  ok(
    r5d.status.missing.some((m) => m.scope === "design" && m.reason.includes("不足")),
    `⑤-d 终止/退避如实说明（${r5d.status.missing.find((m) => m.scope === "design")?.reason ?? "（无）"}）`,
  );

  // ═══════════ ⑥ 整理结果被采用/作废的口径；过时响应不覆盖较新有效结果 ═══════════
  info("── ⑥ 坏出处只剔该条、图照常发布（账目点名）；过时响应不覆盖较新结果");
  // ⑥-a：模型给了定位不到的出处 → 该条在**归一阶段**被逐条剔除；同轮其余条目照常合并、照常发布。
  //
  // 定向更新（2026-09-25；判据未放宽，只把期望挪到现行语义）：
  //   旧期望（V08-05 之前的口径「一个坏出处毁掉整层」）：published=false、semantic_complete=false、
  //     missing 里带「校验」、回执 validation.blocking 落 `source_unlocatable`、图保持原样（此前有效的
  //     整理条目仍在）、该段**不进分段缓存**。
  //   依据：DESIGN.md 附录 B 2026-09-24 条（待裁定：定向更新 ⑥-a，还是复核「整段全是坏出处时应否整段拒发」）
  //     ＋ 本轮授权口径（按现行设计语义定向更新，不得靠删断言/放宽判据涂绿）
  //     ＋ V08-05（367c734：`normalizeProposalRefs` 在**校验器之前**按真实锚点归一/逐条剔除，
  //       「来源不可定位只剔该条，不再整份 scope 弃用」；`validateBlueprint` 一个字没改）
  //     ＋ 本次缺陷修复（2026-09-25：三条归一/剔除账目此前是死写、任何输出都读不到，现落进蓝图 omitted；
  //       新增断言见 scripts/verify-v08-05.ts ②′）。
  //   新期望：① 本轮照常发布且**不是整份弃用**（kept_previous=false）——坏条目不再连坐整层；
  //     ② 「被点名」判在**图账目**上：bp.omitted 含 ref_dropped（点名主体与原文）与 model_item_dropped——
  //        坏条目到不了校验器，所以不再要求回执 blocking 里出现 source_unlocatable；
  //     ③ 坏条目一条都没进图；同一段的旧条目按**分段语义**被本轮结果替换（同 ③-b 口径：本段换成本轮结果），
  //        未受影响的那一段（施工段）的既有模型结果原样保留；
  //     ④ 设计段缓存键推进到新来源（被采纳的是**剔除后**的结果）。
  //   保留意图：坏出处仍必须被剔除、被点名、不许静默通过——只是不再整层连坐（校验器强度未放宽的反证在 verify:v08-05 ③）。
  write(path.join(workbench(rootA), "design.md"), DESIGN_TEXT);
  const bpBytes6 = hashOrNone(blueprintPath(FIX_A, dataDir));
  const cacheDesignKey6 = readSemanticCache(FIX_A, dataDir).cache.shards.design?.scope_key ?? null;
  const chatBadRef = mkChat({ marker: "bad-ref", design: true, plan: true, badRef: true });
  const r6a = await autoRebuildBlueprint(FIX_A, { dataDir, trigger: "e-step6-badref", chat: chatBadRef.fn, kickoff_delay_ms: 0 });
  const receipt6a = readBlueprintReceipt(FIX_A, dataDir);
  ok(
    r6a.published === true &&
      r6a.status.semantic_complete === true &&
      r6a.status.missing.length === 0 &&
      receipt6a?.kept_previous === false,
    `⑥-a 坏出处**只剔该条**、本轮照常被采纳（published=${String(r6a.published)}、complete=${String(r6a.status.semantic_complete)}、missing=${r6a.status.missing.length}、kept_previous=${String(receipt6a?.kept_previous)}、outcome=${r6a.outcome}）`,
  );
  const bp6a = readBlueprint(FIX_A, dataDir);
  const droppedRef6a = (bp6a?.omitted ?? []).find((o) => o.kind === "ref_dropped");
  const droppedItem6a = (bp6a?.omitted ?? []).find((o) => o.kind === "model_item_dropped");
  ok(
    droppedRef6a !== undefined &&
      droppedRef6a.count === 1 &&
      droppedRef6a.detail.includes("不存在的章节") &&
      droppedRef6a.detail.includes("plan:concept:bad-ref") &&
      droppedItem6a !== undefined &&
      droppedItem6a.count >= 1,
    `⑥-a 坏出处**被点名**（图账目 omitted=${(bp6a?.omitted ?? []).map((o) => o.kind).join("/") || "（无）"}；原因=${droppedRef6a?.detail.slice(0, 56) ?? "（缺）"}…）`,
  );
  ok(
    bp6a !== null &&
      !bp6a.nodes.some((n) => n.id === "plan:concept:bad-ref") &&
      !bp6a.nodes.some((n) => n.id === "plan:concept:design-round") &&
      (bp6a.model_leads ?? []).some((l) => l.source === "plan:task:T-1" && l.target === "plan:task:T-2" && l.kind === "model_inference") &&
      (receipt6a?.validation?.blocking ?? []).every((f) => f.code !== "source_unlocatable"),
    `⑥-a 坏条目一条都没进图（连线索账都没有）；同段旧条目按分段语义被本轮结果替换、未受影响的施工段以待审线索原样保留；坏引用到不了校验器（${bp6a?.nodes.length ?? 0} 节点 / ${(bp6a?.model_leads ?? []).length} 条线索、blocking=${(receipt6a?.validation?.blocking ?? []).map((f) => f.code).join("/") || "（空）"}）`,
  );
  ok(
    bp6a?.publish.published === true && bpBytes6 !== "",
    "⑥-a 图仍是「已发布的有效结果」（没有因为模型给了坏出处而变成未发布/空图）",
  );
  const cacheAfter6a = readSemanticCache(FIX_A, dataDir).cache;
  ok(
    cacheAfter6a.shards.design?.scope_key === semanticScopeKey(readBlueprintSources(FIX_A, dataDir), "design") &&
      cacheAfter6a.shards.design?.scope_key !== cacheDesignKey6,
    `⑥-a 设计段缓存键推进到**当前来源**（采纳的是剔除后的结果：${String(cacheDesignKey6).slice(0, 8)}… → ${String(cacheAfter6a.shards.design?.scope_key).slice(0, 8)}…）`,
  );
  // ⑥-b：整理期间来源变了 → 该次响应作废，不覆盖较新结果、也不写缓存
  write(path.join(workbench(rootA), "design.md"), DESIGN_V4); // 先让设计段脏（这个版本是"旧响应"基于的那一版）
  const chatHang = mkChat({ marker: "stale-old", design: true, plan: false, delayMs: 1500 });
  const hangRun = autoRebuildBlueprint(FIX_A, { dataDir, trigger: "e-step6-hang", chat: chatHang.fn, kickoff_delay_ms: 0 });
  await sleep(250); // 让挂起那一轮先进入"整理中"
  write(path.join(workbench(rootA), "design.md"), DESIGN_V5); // 期间改源 → 旧响应注定过时
  const chatNewer = mkChat({ marker: "newer", design: true, plan: false });
  const newer = await autoRebuildBlueprint(FIX_A, { dataDir, trigger: "e-step6-newer", chat: chatNewer.fn, kickoff_delay_ms: 0 });
  const cacheAfterNewer = readSemanticCache(FIX_A, dataDir).cache;
  const keyAfterNewer = cacheAfterNewer.shards.design?.scope_key ?? null;
  const ranAtAfterNewer = cacheAfterNewer.shards.design?.ran_at ?? null;
  const stale = await hangRun;
  ok(
    newer.status.semantic_complete === true && scopeOf(newer.status, "design") === "tidied",
    `⑥-b 较新的那一轮整理成功（design=${scopeOf(newer.status, "design")}、调用 ${newer.model_calls} 次）`,
  );
  ok(
    stale.model_calls >= 1 &&
      scopeOf(stale.status, "design") === "failed" &&
      (stale.status.missing.find((m) => m.scope === "design")?.reason ?? "").includes("过时"),
    `⑥-b 旧响应被丢弃并如实说明（design=${scopeOf(stale.status, "design")}、理由=${stale.status.missing.find((m) => m.scope === "design")?.reason ?? "（无）"}）`,
  );
  const cacheAfterStale = readSemanticCache(FIX_A, dataDir).cache;
  ok(
    cacheAfterStale.shards.design?.scope_key === keyAfterNewer && cacheAfterStale.shards.design?.ran_at === ranAtAfterNewer,
    "⑥-b 分段缓存仍是**较新那一份**（旧响应没有覆盖它）",
  );
  const bp6 = readBlueprint(FIX_A, dataDir);
  // 定向更新（R-2，2026-09-26；五要素留档见 ① 段）：结果身份从正式节点改为**节点侧待审线索**。
  ok(
    bp6 !== null &&
      (bp6.model_node_leads ?? []).some((l) => l.id === "plan:concept:newer") &&
      !(bp6.model_node_leads ?? []).some((l) => l.id === "plan:concept:stale-old"),
    "⑥-b 线索账上是较新那一轮的结果，旧响应的条目一条都没进账",
  );

  // ═══════════ ⑦ semantic:true 显式路径仍可用（并落缓存 → 自动链不重复调用） ═══════════
  info("── ⑦ semantic:true 显式重试/高级入口：仍可用、能强制重跑、且结果进分段缓存");
  const designKeyBeforeExplicit = semanticScopeKey(readBlueprintSources(FIX_A, dataDir), "design");
  const chatExplicit = mkChat({ marker: "explicit", design: true, plan: true, ignoreFocus: true });
  const explicit = await rebuildBlueprint(FIX_A, {
    dataDir,
    trigger: "explicit_semantic",
    semantic: true,
    force: true,
    chat: chatExplicit.fn,
    on_semantic: (info) => recordExplicitSemanticResult(FIX_A, info, { dataDir, trigger: "explicit_semantic" }),
  });
  ok(
    explicit.publish.published && explicit.model_calls === 1 && chatExplicit.calls() === 1,
    `⑦ 显式 semantic:true 仍可用：强制重跑 1 次并发布（model_calls=${explicit.model_calls}）`,
  );
  ok(
    (readBlueprint(FIX_A, dataDir)?.model_node_leads ?? []).some((l) => l.id === "plan:concept:explicit") === true,
    "⑦ 显式那一轮的结果真进了线索账（不是空跑）——R-2：提案节点留在待审线索层",
  );
  const cacheExplicit = readSemanticCache(FIX_A, dataDir).cache;
  ok(
    cacheExplicit.shards.design?.scope_key === designKeyBeforeExplicit &&
      cacheExplicit.shards.design?.trigger === "explicit_semantic" &&
      cacheExplicit.shards.design?.scope_version === SEMANTIC_SCOPE_VERSION,
    `⑦ 显式结果落进分段缓存（trigger=${cacheExplicit.shards.design?.trigger ?? "（无）"}），随后自动链可命中缓存`,
  );
  const chatAfterExplicit = mkChat({ marker: "must-not-run" });
  const r7 = await autoRebuildBlueprint(FIX_A, { dataDir, trigger: "e-step7-after-explicit", chat: chatAfterExplicit.fn, kickoff_delay_ms: 0 });
  ok(
    chatAfterExplicit.calls() === 0 && r7.model_calls === 0 && r7.status.semantic_complete === true,
    `⑦ 显式整理之后自动链**零重复调用**（夹具 ${chatAfterExplicit.calls()} 次、outcome=${r7.outcome}）：两条路径共用同一份缓存`,
  );
  ok(
    r7.status.scopes.every((s) => s.state !== "missing") && r7.status.scopes.some((s) => s.model_calls === 0),
    `⑦ 分段账目按范围给（${r7.status.scopes.map((s) => `${s.scope}:${s.state}/${s.model_calls}`).join(" / ")}）`,
  );

  // ═══════════ ⑧ 补充：自动链的触发口与非阻塞状态 ═══════════
  info("── ⑧ 重复触发合并 + 后台继续（awaitSemantic:false）");
  const chatSlow = mkChat({ marker: "slow", delayMs: 900 });
  const bg = await autoRebuildBlueprint(FIX_A, { dataDir, trigger: "e-bg", chat: chatSlow.fn, awaitSemantic: false, force: true, kickoff_delay_ms: 0 });
  ok(
    bg.status.finished_at === null || bg.status.semantic_complete === false,
    `⑧ awaitSemantic:false → 立即返回（phase=${bg.status.phase}、finished=${String(bg.status.finished_at !== null)}），整理在后台继续`,
  );
  const dedup = await autoRebuildBlueprint(FIX_A, { dataDir, trigger: "e-bg-dup", chat: mkChat({ marker: "dup" }).fn, awaitSemantic: false, kickoff_delay_ms: 0 });
  ok(
    dedup.outcome === "deduped" && dedup.model_calls === 0,
    `⑧ 同项目同分段键的重复触发被**合并**（outcome=${dedup.outcome}，不再开一轮、不再调模型）`,
  );
  const settled = autoRunSettled(FIX_A);
  if (settled !== null) await settled;
  ok(
    autoRunStatusOf(FIX_A)?.finished_at !== null && chatSlow.calls() >= 1,
    `⑧ 后台那轮真跑完了（模型调用 ${chatSlow.calls()} 次、状态 finished）`,
  );
  const st8 = readSemanticStatus(FIX_A, dataDir);
  ok(
    st8 !== null && st8.finished_at !== null && st8.scopes.length === 2 && exists(semanticStatusPath(FIX_A, dataDir)),
    `⑧ 状态落盘可跨进程读（semantic-status.json 有终态与两段账目：${st8?.scopes.map((s) => `${s.scope}:${s.state}`).join(" / ") ?? "（无）"}）`,
  );
  ok(
    SEMANTIC_MAX_FAILURE_ATTEMPTS >= SEMANTIC_MAX_ATTEMPTS_PER_RUN,
    `⑧ 重试上限有界：每轮 ${SEMANTIC_MAX_ATTEMPTS_PER_RUN} 次 ≤ 跨轮 ${SEMANTIC_MAX_FAILURE_ATTEMPTS} 次（到顶进终止态）`,
  );
  ok(
    triggerBlueprintAuto.length >= 1,
    "⑧ 触发式入口签名仍是 (projectId, opts) 且同步返回（供「有效基线激活」「更新图」这类正常流程调用）",
  );
} catch (e) {
  ok(false, `验证中断：${(e as Error).message}`);
  console.error(e);
} finally {
  if (serverChild !== null) await stopChild(serverChild);
  if (stub !== null) await stub.close();

  info("── 文档零改动核对（首尾逐文件 sha256）");
  for (const rel of DOC_FILES) {
    const abs = path.join(REPO, rel);
    const after = fs.existsSync(abs) ? sha256File(abs) : "<missing>";
    ok(after === docBefore.get(rel), `文档未被改动：${rel} sha256=${after.slice(0, 16)}…`);
  }

  if (process.env.TATAI_KEEP_TMP === "1") info(`保留现场：${tmpBase}`);
  else {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    info(`夹具已清理：${path.basename(tmpBase)}`);
  }
  console.log(`\n[verify] 补修 E 结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
}

async function stopChild(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGKILL");
  for (let i = 0; i < 40; i++) {
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
}
