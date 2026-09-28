// V06-05 验证脚本（PLAN.md V06-05，DESIGN.md §4.1 为主契约，另见 §2.9 / §3.2 / §4.4–§4.7）。
// 用法：pnpm verify:v06-05（或 node --import tsx scripts/verify-v06-05.ts）
//
// 自带隔离环境：临时 TATAI_HOME + 三个临时夹具项目（`os.tmpdir()` 下），**不碰**任何真实项目的
// `.工作台/`；塔台自身的 DESIGN.md / PLAN.md / PROGRESS.md / AGENTS.md / README.md 与两份设计史
// **只读**（脚本首尾逐文件 sha256 对照，证明零改动）；收尾清理自建临时目录与起过的子进程
// （TATAI_KEEP_TMP=1 可保留现场）。
//
// 模型夹具：**不依赖真机网关**——语义整理走注入的 `BlueprintChatFn`（合作模型 / 抛错模型 / 挂起模型），
// 因此"模型失败保留旧图""过时响应不覆盖新图""无出处关系标待核实"都是确定性的。
// 只有一条真起后端（②-1「有效基线激活触发」）走真实 HTTP：那一条要证的正是**路由接线**
// （激活成功后由服务端异步触发派生），起真进程才作数。
//
// 覆盖点（PLAN V06-05 检查项 1–3 逐条）：
//   ① 夹具与结构校验：三类夹具（无源码但有有效图纸 / 既有代码未映射 / 概念横跨目录）固定输出契约；
//      结构校验覆盖端点、重复 ID、失效来源、依赖循环、省略范围；omitted/coverage 如实（缺失就说缺失）。
//   ② 触发与发布：有效基线激活触发（真 HTTP）；DeepSeek 语义整理 + 程序校验/发布；模型失败保留旧图；
//      过时响应不覆盖新结果；无出处关系标待核实；架构冲突交设计角色（不自行删代码/补造需求）；
//      静态 parse 不得冲掉规划层（规划层与静态层分别存储）；禁止模型输入任务完成色/进度。
//   ③ 硬要求：零文件（空仓）仍有规划图、重新生成身份稳定（改名不换身份）、缺失覆盖如实报告、
//      纯任务状态变化零模型重画；并保留原 §11.1 解析兼容验证（DESIGN §11.1 十项 → 规划图模块节点）。
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  BLUEPRINT_GENERATOR_VERSION,
  BLUEPRINT_LIMITS,
  blueprintContextOf,
  blueprintPath,
  blueprintReceiptPath,
  deriveBlueprint,
  draftBlueprintOf,
  planVsCode,
  readBlueprint,
  readBlueprintReceipt,
  readBlueprintSources,
  rebuildBlueprint,
  sanitizeModelProposal,
  stripStatusKeys,
  viewGraphWithPlan,
  type Blueprint,
  type BlueprintChatFn,
  type BlueprintSources,
} from "../src/arch/blueprint";
import { forbiddenStatusKeysIn, validateBlueprint, type BlueprintContext } from "../src/arch/blueprintValidate";
import {
  buildSharedGraphFrom,
  mergePlanningLayer,
  selectGraph,
  type SharedGraph,
} from "../src/arch/shared-graph";
import {
  extractDesignModules,
  extractTataiDesignModules,
  moduleSectionPathOf,
  reconcilePlanWithCodeInputs,
} from "../src/arch/reconcile";
import { parseProject } from "../src/arch/parse";
import { buildSectionIndex, designDefinitionText, loadDocuments, activeBaseline, activateBaseline } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import {
  TASK_STATUS_LABELS,
  readTaskStates,
  renderPlanStatusRegion,
  submitDefinitionImports,
  submitTaskStatus,
  type TaskState,
} from "../src/server/work/tasks";
import { WorkService } from "../src/server/work/service";
import { projectWorkDir } from "../src/server/workstation";

const REPO = process.cwd();
const PORT = 8815;
/** 首尾逐字节对照的文档（本卡只读，一个字节都不许动） */
const DOC_FILES = [
  "DESIGN.md",
  "PLAN.md",
  "PROGRESS.md",
  "AGENTS.md",
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
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0605-verify-"));
const dataDir = path.join(tmpBase, "home");
const EMPTY = "v0605-empty"; // 无源码但有有效图纸
const PARTIAL = "v0605-partial"; // 既有代码未映射 + 概念横跨目录
/** 2026-09-22 批外缺陷修复（§3.2 草稿图预览）：图纸在场但**从未激活基线** → 只应有草稿，不该是空图 */
const DRAFTONLY = "v0605-draftonly";
const emptyRoot = path.join(tmpBase, "empty");
const partialRoot = path.join(tmpBase, "partial");
const draftOnlyRoot = path.join(tmpBase, "draftonly");
const mkdirp = (d: string) => fs.mkdirSync(d, { recursive: true });
const write = (f: string, text: string) => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
const read = (f: string) => fs.readFileSync(f, "utf8");
const workbench = (root: string) => path.join(root, ".工作台");
/** 目录内容快照（相对路径 → 内容 sha256，稳定排序）：用来证明只读入口**零写盘** */
const snapshotTree = (root: string): string => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(`${path.relative(root, abs).split(path.sep).join("/")}:${sha256File(abs)}`);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.join("|");
};
for (const d of [dataDir, emptyRoot, partialRoot, draftOnlyRoot]) mkdirp(d);

const EMPTY_DESIGN = [
  "# 夹具设计书（V06-05 空仓夹具）",
  "",
  "## 1 概述",
  "本夹具没有任何源码文件，用来证明空仓也必须有规划图（DESIGN.md §3.2）。",
  "",
  "## 2 能力甲",
  "能力甲为人提供甲。",
  "",
  "## 3 能力乙",
  "能力乙为人提供乙。",
  "",
  "### 3.1 乙的子节",
  "这个子节故意不被任何规划对象引用：覆盖账目必须如实报出未覆盖。",
  "",
  "## 4 模块划分",
  "- 模块甲：甲的实现",
  "- 模块乙：乙的实现",
  "",
  "## 5 能力丙",
  "能力丙暂时没有任务引用它（灰色待建项，不是报警）。",
  "",
  "## 附录 A：说明",
  "附录内容不算能力节点。",
  "",
].join("\n");

const PLAN_BODY = (modAPath: string, modBPath: string) =>
  [
    "# 夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| T-1 | todo | 能力甲落成 |  | 甲验收记录 |",
    "| T-2 | todo | 能力乙落成 | T-1 | 乙验收记录 |",
    "",
    "### T-1 能力甲落成",
    "",
    "**设计依据**：§2。",
    "",
    "**契约**：输入甲，输出甲的产物。",
    "",
    `**文件责任**：\`${modAPath}\`。`,
    "",
    "- [ ] 甲做出来",
    "- [ ] 甲验过",
    "",
    "**交付**：甲验收记录。",
    "",
    "### T-2 能力乙落成",
    "",
    "**设计依据**：§3。",
    "",
    "**契约**：输入乙，输出乙的产物。",
    "",
    `**文件责任**：\`${modBPath}\`。`,
    "",
    "- [ ] 乙做出来",
    "",
    "**交付**：乙验收记录。",
    "",
  ].join("\n");

const EMPTY_PLAN = PLAN_BODY("src/nowhere/a.ts", "src/nowhere/b.ts");
const PARTIAL_PLAN = PLAN_BODY("src/mod-a/a.ts", "src/mod-b/b.ts");
/** 有码夹具的设计书：与空仓夹具同构，只有标题不同（章节路径因此逐字可比） */
const PARTIAL_DESIGN = EMPTY_DESIGN.replace("空仓夹具", "有码夹具");
/** 未审定夹具的设计书：与空仓夹具同构（只验"草稿可预览"，不引入新结构） */
const DRAFTONLY_DESIGN = EMPTY_DESIGN.replace("空仓夹具", "未审定夹具");
const DRAFTONLY_PLAN = PLAN_BODY("src/draft/a.ts", "src/draft/b.ts");
/** 派生中改变源的版本（②-7「过时响应不覆盖新图」用）：加一节；原有章节路径不动 → locator 仍有效 */
const PARTIAL_DESIGN_V2 = PARTIAL_DESIGN.replace("## 5 能力丙", "## 5 能力丙\n\n## 6 能力丁（派生中新增）\n派生中改了源。");

write(path.join(workbench(emptyRoot), "design.md"), EMPTY_DESIGN);
write(path.join(workbench(emptyRoot), "plan.md"), EMPTY_PLAN);
write(path.join(workbench(partialRoot), "design.md"), PARTIAL_DESIGN);
write(path.join(workbench(partialRoot), "plan.md"), PARTIAL_PLAN);
write(path.join(workbench(draftOnlyRoot), "design.md"), DRAFTONLY_DESIGN);
write(path.join(workbench(draftOnlyRoot), "plan.md"), DRAFTONLY_PLAN);
// 既有代码：src/mod-a + src/mod-b 被施工图的「文件责任」覆盖；legacy 没有任何规划关联（待归属）
write(path.join(partialRoot, "src", "mod-a", "a.ts"), "export const A = 'a';\n");
write(path.join(partialRoot, "src", "mod-b", "b.ts"), "import { A } from '../mod-a/a';\nexport const B = A + 'b';\n");
write(path.join(partialRoot, "legacy", "old.ts"), "export const OLD = 'legacy';\n");
write(path.join(emptyRoot, "README.md"), "# 空仓夹具：没有任何源码\n");

const record = (id: string, name: string, dir: string) => ({
  id,
  name,
  path: dir,
  kind: "backend",
  registered_at: "2026-09-20T00:00:00+08:00",
  last_opened_at: "2026-09-20T00:00:00+08:00",
});
write(
  path.join(dataDir, "registry.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        record(EMPTY, "V06-05 空仓夹具", emptyRoot),
        record(PARTIAL, "V06-05 有码夹具", partialRoot),
        record(DRAFTONLY, "V06-05 未审定夹具", draftOnlyRoot),
      ],
    },
    null,
    2,
  ),
);
process.env.TATAI_HOME = dataDir;

const approve = (id: string) =>
  activateBaseline(id, {
    approved_by: "user",
    approval_basis: "V06-05 隔离夹具审定（不代表真实用户 Gate）",
    approval_kind: "user_confirmed",
  });

// ── 模型夹具：三种（合作 / 抛错 / 挂起）──
interface ChatPlan {
  json: unknown;
  count: number;
}
const mkJsonChat = (json: unknown): { fn: BlueprintChatFn; calls: () => number } => {
  let n = 0;
  const fn: BlueprintChatFn = async () => {
    n++;
    const text = "```json\n" + JSON.stringify(json) + "\n```";
    return { text, json, error: null };
  };
  return { fn, calls: () => n };
};
const mkErrorChat = (message: string): { fn: BlueprintChatFn; calls: () => number } => {
  let n = 0;
  const fn: BlueprintChatFn = async () => {
    n++;
    throw new Error(message);
  };
  return { fn, calls: () => n };
};
const mkBadJsonChat = (text: string): BlueprintChatFn => async () => ({ text, json: null, error: "输出里没有 JSON 值（既没有 { 也没有 [）" });
const mkHangingChat = (): { fn: BlueprintChatFn; release: () => void; started: () => boolean } => {
  let release: (() => void) | null = null;
  let started = false;
  const fn: BlueprintChatFn = () =>
    new Promise((resolve) => {
      started = true;
      release = () => resolve({ text: "{}", json: {}, error: null });
    });
  return { fn, release: () => release?.(), started: () => started };
};

/** 模型夹具引用的设计章节路径：与生产口径同源（buildSectionIndex）现算，不手抄 */
const PARTIAL_DESIGN_PATH = ".工作台/design.md";
const coopLocator = (() => {
  const secs = buildSectionIndex(designDefinitionText(PARTIAL_DESIGN));
  return secs.find((s) => s.path.endsWith("4 模块划分"))?.path ?? "4 模块划分";
})();

/** 合作模型：补一个横跨两个目录的概念节点 + 一条无出处关系 + 一批"完成色/进度"脏字段 */
const COOP_PROPOSAL = {
  nodes: [
    {
      id: "plan:concept:共享概念",
      name: "共享概念（甲与乙共用的语义）",
      kind: "concept",
      source_refs: [{ kind: "design_section", path: PARTIAL_DESIGN_PATH, locator: coopLocator }],
      related_ids: ["plan:code:src-mod-a", "plan:code:src-mod-b"],
      // §4.2 红线：模型试图写完成色/进度 —— 程序必须摘掉（下面逐条断言）
      status: "done",
      color: "green",
      progress: 0.9,
    },
  ],
  edges: [
    {
      source: "plan:concept:共享概念",
      target: "plan:code:src-mod-a",
      kind: "model_inference",
      source_refs: [],
      certainty: "declared",
    },
    {
      source: "plan:task:T-1",
      target: "plan:concept:不存在的节点",
      kind: "model_inference",
      source_refs: [],
    },
  ],
};

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
  updated_at: "2026-09-20T00:00:00+08:00",
  last_actor: "verify-v06-05",
});

// ── HTTP 小工具（②-1 用真后端）──
// 补修包 E：激活基线会在后台自动跑语义整理链（缺省就打模型网关）。本脚本要证的是"路由接线 → 触发"，
// 不是自动链本身；注 `TATAI_SEMANTIC_AUTO=0`（docs/work-v2-contract.md §18.5）关掉后台模型调用，
// 确定性派生照常、断言口径一条不变。
function spawnServer(): ChildProcess {
  const proc = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT), TATAI_SEMANTIC_AUTO: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(proc);
  proc.stdout.on("data", (d: Buffer) => {
    if (process.env.TATAI_VERBOSE === "1") process.stdout.write(`[server] ${d.toString()}`);
  });
  proc.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));
  return proc;
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
async function waitUp(): Promise<void> {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error(`后端 ${PORT} 端口 20 秒内未就绪`);
}
async function stopChild(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGKILL");
  for (let i = 0; i < 40; i++) {
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
}
const api = async (p: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
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

const baseOf = (bp: Blueprint) => ({
  model_key: "k",
  full_key: "k",
  design_content_sha256: null,
  plan_definition_sha256: null,
  semantic: false,
});

/** 夹具摘要（多处断言复用，避免各写一遍） */
const nodeIds = (bp: Blueprint): string[] => bp.nodes.map((n) => n.id).sort();

let serverChild: ChildProcess | null = null;

try {
  // ═══════════════════════ ① 夹具与结构校验 ═══════════════════════
  info("── ① 夹具与结构校验（三类夹具固定输出契约 + 结构校验逐条）");

  // ── 夹具 A：无源码但有有效图纸（空仓）──
  approve(EMPTY);
  const emptyRebuild = await rebuildBlueprint(EMPTY, { trigger: "baseline_activated" });
  const emptyBp = emptyRebuild.blueprint;
  ok(emptyRebuild.publish.published && emptyBp !== null, `①-A 有效基线激活触发派生并发布（publish.reason=${JSON.stringify(emptyRebuild.publish.reason)}）`);
  ok(
    emptyBp !== null && emptyBp.baseline_id === activeBaseline(EMPTY)?.baseline_id && emptyBp.baseline_id !== null,
    `①-A 规划图绑定生效基线（baseline_id=${emptyBp?.baseline_id ?? "null"}）`,
  );
  ok(
    fs.existsSync(blueprintPath(EMPTY)) && fs.existsSync(blueprintReceiptPath(EMPTY)),
    "①-A 派生缓存落 .工作台/arch/blueprint.json + 回执 blueprint-receipt.json（DESIGN §4.1 指定落点）",
  );
  const emptyNodes = emptyBp?.nodes ?? [];
  ok(
    emptyNodes.length >= 5 && (emptyBp?.edges.length ?? 0) > 0,
    `①-A 无源码也有规划图：${emptyNodes.length} 节点 / ${emptyBp?.edges.length ?? 0} 关系（能力 ${emptyNodes.filter((n) => n.kind === "capability").length} / 模块 ${emptyNodes.filter((n) => n.kind === "module").length} / 任务 ${emptyNodes.filter((n) => n.kind === "task").length}）`,
  );
  ok(
    emptyBp !== null && emptyBp.coverage.code_modules.total === 0 && emptyBp.source_manifest.some((m) => m.role === "modules" && m.status === "missing"),
    "①-A 代码侧如实报「没有输入」：code_modules.total=0 且 source_manifest 里 modules=missing（不假装有代码）",
  );

  // ── 输出契约字段齐全 ──
  const contractOk =
    emptyBp !== null &&
    typeof emptyBp.baseline_id === "string" &&
    typeof emptyBp.generator_version === "string" &&
    Array.isArray(emptyBp.source_manifest) &&
    Array.isArray(emptyBp.nodes) &&
    Array.isArray(emptyBp.edges) &&
    typeof emptyBp.coverage === "object" &&
    Array.isArray(emptyBp.omitted) &&
    emptyBp.nodes.every(
      (n) => typeof n.id === "string" && typeof n.kind === "string" && typeof n.name === "string" && Array.isArray(n.source_refs) && Array.isArray(n.related_ids),
    ) &&
    emptyBp.edges.every(
      (e) => typeof e.source === "string" && typeof e.target === "string" && typeof e.kind === "string" && Array.isArray(e.source_refs) && typeof e.certainty === "string",
    );
  ok(
    contractOk,
    `① 契约字段齐全：baseline_id / generator_version / source_manifest / nodes / edges / coverage / omitted；节点 id/kind/name/source_refs/related_ids；关系 source/target/kind/source_refs/certainty（generator=${emptyBp?.generator_version ?? "?"}）`,
  );
  ok(
    emptyBp !== null && emptyBp.source_manifest.every((m) => !/[A-Za-z]:[\\/]/.test(m.path) && !/^\\\\/.test(m.path)),
    "① 蓝图里只有项目根内相对路径：source_manifest 无本机绝对路径（远程读接口与 verify-s3 敏感面扫描同口径）",
  );

  // ── 夹具 B：既有代码未映射 ──
  parseProject(PARTIAL);
  approve(PARTIAL);
  const partialRebuild = await rebuildBlueprint(PARTIAL, { trigger: "baseline_activated" });
  const partialBp = partialRebuild.blueprint;
  ok(partialRebuild.publish.published && partialBp !== null, "①-B 有码夹具派生并发布成功");
  const codeTotal = partialBp?.coverage.code_modules.total ?? 0;
  const codeUnmapped = partialBp?.coverage.code_modules.unmapped ?? [];
  ok(
    codeTotal >= 2 && codeUnmapped.length >= 1 && codeUnmapped.some((u) => u.key === "legacy"),
    `①-B 既有代码未映射如实报出：${codeTotal} 个模块里 ${codeUnmapped.length} 个未映射（含 ${codeUnmapped.map((u) => u.key).join("/") || "无"}）`,
  );
  const partialCtx = blueprintContextOf(readBlueprintSources(PARTIAL));
  const partialValidation = partialBp === null ? null : validateBlueprint(partialBp, partialCtx);
  ok(
    partialValidation !== null &&
      partialValidation.review.some((f) => f.code === "code_not_in_plan" && f.handoff === "design_role" && f.ids.includes("legacy")),
    "①-B 代码未映射判成「待归属」并点名交设计角色核实（§4.5：程序不自行删代码/补造需求）",
  );
  const planCode = planVsCode(PARTIAL);
  ok(
    partBCodeOnlyCheck(planCode),
    `①-B 规划↔实现对账（§4.5）：待归属 ${planCode?.code_only.length ?? 0} 个（${planCode?.code_only.map((c) => c.id).join("/") ?? "无"}）/ 待建 ${planCode?.planned_only.length ?? 0} 个 / 稳定映射 ${planCode?.mapped.length ?? 0} 条`,
  );

  // ── 夹具 C：概念横跨目录 ──
  // 2026-09-26 定向更新（R-2/B 类返工，非作者复审 independent-v0918-review-20260926 §七 R-2）——五要素留档：
  //   旧期望（旧实现）：模型提案的 concept 节点（`plan:concept:共享概念`）并进 `bp.nodes`，图上有该节点、
  //     它的 `related_ids` 指向两个代码模块，`dirsOfRelated.size >= 2`。
  //   依据：审计 probe2 P2/P3 实测——提案节点直入正式节点集 ⇒ 进交付对象清单（投影查不到即 `missing`）
  //     或让正式对象被提案出处改红；违反 §4.1「待审线索不参加交付读数」的字面边界。
  //   新期望：提案节点**不进正式节点集**（图上查不到），原始提案与处置留在 `model_node_leads`
  //     （`target="new_node"`、`related_ids` 原样保留 ⇒ 跨目录事实照样可核）。
  //   保留意图：模型补的概念/关系统统可见、可追溯，但一条都不升格为正式对象或正式关系。
  //   判据不放宽：防护从「进图当候选对象」收紧为「不进图、只留线索」；跨目录事实改从线索账核。
  const coop = mkJsonChat(COOP_PROPOSAL);
  const coopRebuild = await rebuildBlueprint(PARTIAL, { trigger: "manual", semantic: true, chat: coop.fn, force: true });
  const coopBp = coopRebuild.blueprint;
  const conceptInGraph = coopBp?.nodes.find((n) => n.id === "plan:concept:共享概念") ?? null;
  const conceptLead = (coopBp?.model_node_leads ?? []).find((l) => l.id === "plan:concept:共享概念") ?? null;
  const relatedModules = (conceptLead?.proposed_related_ids ?? [])
    .map((id) => coopBp?.nodes.find((n) => n.id === id) ?? null)
    .filter((n): n is NonNullable<typeof n> => n !== null);
  const dirsOfRelated = new Set(
    relatedModules
      .flatMap((n) => n.source_refs.filter((r) => r.kind === "code_module").map((r) => r.locator))
      .map((id) => coopBp?.nodes.find((n) => n.id === `plan:code:${id}`)?.name ?? id),
  );
  ok(
    coopRebuild.publish.published &&
      conceptInGraph === null &&
      conceptLead !== null &&
      conceptLead.target === "new_node" &&
      relatedModules.length >= 2 &&
      dirsOfRelated.size >= 2,
    `①-C 概念横跨目录（R-2 新口径）：提案概念**不在正式节点集**，其跨 ${dirsOfRelated.size} 个不同模块（${[...dirsOfRelated].join(" / ")}）的关联在原样保留的节点线索账里可核（关联 ${relatedModules.length} 个正式对象）`,
  );

  // ── 结构校验逐条（手写不合法蓝图钉住每个判据）──
  const baseBp: Blueprint = coopBp ?? partialBp ?? (() => {
    throw new Error("夹具缺失：语义整理/有码夹具都没发布成功");
  })();
  const cloneBp = (): Blueprint => JSON.parse(JSON.stringify(baseBp)) as Blueprint;
  const ctx: BlueprintContext = partialCtx;
  const codesOf = (bp: Blueprint) => validateBlueprint(bp, ctx).blocking.map((f) => f.code);

  // 端点
  const noEndpoint = cloneBp();
  noEndpoint.nodes = noEndpoint.nodes.filter((n) => n.id !== "plan:code:src-mod-b");
  ok(codesOf(noEndpoint).includes("dangling_endpoint"), "①-1 结构校验：端点不存在 → blocking dangling_endpoint");
  // 重复 ID
  const dup = cloneBp();
  dup.nodes.push({ ...dup.nodes[0] });
  ok(codesOf(dup).includes("duplicate_id"), "①-1 结构校验：ID 重复 → blocking duplicate_id");
  // 失效来源（哈希对不上）
  const stale = cloneBp();
  stale.nodes[0] = { ...stale.nodes[0], source_refs: stale.nodes[0].source_refs.map((r) => ({ ...r, sha256: "0".repeat(64) })) };
  ok(codesOf(stale).includes("source_hash_stale"), "①-1 结构校验：失效来源（引用哈希 ≠ 当前哈希）→ blocking source_hash_stale");
  // 来源定位不到
  const unlocatable = cloneBp();
  unlocatable.nodes[0] = { ...unlocatable.nodes[0], source_refs: unlocatable.nodes[0].source_refs.map((r) => ({ ...r, locator: "不存在的章节路径" })) };
  ok(codesOf(unlocatable).includes("source_unlocatable"), "①-1 结构校验：来源定位不到 → blocking source_unlocatable");
  // 依赖循环
  const cyclic = cloneBp();
  cyclic.edges.push({ source: "plan:task:T-1", target: "plan:task:T-2", kind: "task_dependency", source_refs: [], certainty: "declared" });
  cyclic.edges.push({ source: "plan:task:T-2", target: "plan:task:T-1", kind: "task_dependency", source_refs: [], certainty: "declared" });
  const cyclicValidation = validateBlueprint(cyclic, ctx);
  ok(
    cyclicValidation.blocking.some((f) => f.code === "task_dependency_cycle") &&
      cyclicValidation.blocking.find((f) => f.code === "task_dependency_cycle")?.ids.join("→").includes("T-1") === true,
    "①-1 结构校验：任务依赖成环 → blocking task_dependency_cycle（点名环路节点）",
  );
  // 省略范围（少收了东西却没报）
  const noOmit = cloneBp();
  noOmit.coverage.nodes_total = noOmit.nodes.length + 7;
  noOmit.omitted = noOmit.omitted.filter((o) => o.kind !== "node_cap");
  ok(codesOf(noOmit).includes("omission_unreported"), "①-1 结构校验：省略范围没报（缺 omitted 条目）→ blocking omission_unreported");
  // 覆盖账目自相矛盾（拿空集冒充全覆盖）
  const fakeCover = cloneBp();
  fakeCover.coverage.design_sections = { total: 9, mapped: 7, unmapped: [] };
  ok(codesOf(fakeCover).includes("coverage_inconsistent"), "①-1 结构校验：mapped + unmapped ≠ total（空集冒充全覆盖）→ blocking coverage_inconsistent");
  // 基线
  const wrongBaseline = cloneBp();
  wrongBaseline.baseline_id = "bl-not-active";
  ok(codesOf(wrongBaseline).includes("baseline_changed"), "①-1 结构校验：生成后基线变了 → blocking baseline_changed（过时图不发布）");
  const noBaseline = cloneBp();
  ok(
    validateBlueprint(noBaseline, { ...ctx, active_baseline_id: null }).blocking.map((f) => f.code).includes("baseline_missing"),
    "①-1 结构校验：没有生效基线 → blocking baseline_missing（草稿不发布）",
  );
  // 上限
  const overLimit = cloneBp();
  overLimit.nodes = [...overLimit.nodes, ...Array.from({ length: BLUEPRINT_LIMITS.max_nodes }, (_, i) => ({ ...overLimit.nodes[0], id: `plan:concept:pad-${i}` }))];
  overLimit.coverage.nodes_kept = overLimit.nodes.length;
  ok(codesOf(overLimit).includes("limit_exceeded"), `①-1 结构校验：超出节点上限 ${BLUEPRINT_LIMITS.max_nodes} → blocking limit_exceeded`);
  // 完成色/进度泄漏
  const leaked = cloneBp() as Blueprint & { nodes: any[] };
  leaked.nodes[0] = { ...leaked.nodes[0], status: "done", color: "green", progress: 0.5 };
  ok(codesOf(leaked).includes("status_field_leak"), "①-1 结构校验：完成色/进度字段泄漏 → blocking status_field_leak（§4.2 模型不能写颜色当进度）");
  // 覆盖账目自洽（正面）
  const goodValidation = validateBlueprint(baseBp, ctx);
  ok(
    goodValidation.ok &&
      ["design_sections", "plan_tasks", "code_modules"].every((k) => {
        const s = (baseBp.coverage as any)[k];
        return s.mapped + s.unmapped.length === s.total;
      }),
    `①-2 覆盖账目自洽（正面）：三侧均 mapped + unmapped === total，且无 blocking（review ${goodValidation.review.length} 条照常发布）`,
  );
  ok(
    baseBp.coverage.design_sections.unmapped.length > 0 && baseBp.omitted.some((o) => o.kind === "unmapped"),
    `①-2 缺失覆盖如实报告：${baseBp.coverage.design_sections.unmapped.length} 个设计章节未映射并进 omitted（不拿空集冒充全覆盖）`,
  );

  // ═══════════════════════ ② 触发与发布 ═══════════════════════
  info("── ② 触发与发布（有效基线激活真 HTTP 触发 + 模型整理/校验/发布）");

  // ── ②-1 有效基线激活触发（真后端 + 真 HTTP）──
  if (await portListening(PORT)) {
    ok(false, `③-0 端口 ${PORT} 被占用：无法起真后端验证激活触发，先清理残留进程`);
  } else {
    // 先把已有产物清掉，这样"激活触发派生"这件事才可归因
    fs.rmSync(blueprintPath(EMPTY), { force: true });
    fs.rmSync(blueprintReceiptPath(EMPTY), { force: true });
    serverChild = spawnServer();
    await waitUp();
    const act = await api(`/api/projects/${EMPTY}/documents/activate`, {
      method: "POST",
      body: JSON.stringify({ approved_by: "user", approval_basis: "V06-05 HTTP 触发夹具", approval_kind: "user_confirmed" }),
    });
    let triggered: Blueprint | null = null;
    for (let i = 0; i < 60; i++) {
      triggered = readBlueprint(EMPTY);
      if (triggered !== null && triggered.baseline_id === activeBaseline(EMPTY)?.baseline_id) break;
      await sleep(250);
    }
    ok(act.status === 200, `②-1 POST documents/activate 成功（HTTP ${act.status}，created=${JSON.stringify(act.body?.created)}）`);
    ok(
      triggered !== null && triggered.baseline_id === activeBaseline(EMPTY)?.baseline_id,
      `②-1 有效基线激活**触发**规划关联重建：产物重新出现且绑定新基线（${triggered?.baseline_id ?? "null"}），无需人工点重建`,
    );
    const got = await api(`/api/projects/${EMPTY}/arch/blueprint`);
    ok(
      got.status === 200 && got.body?.ok === true && got.body?.blueprint?.exists === true && Array.isArray(got.body?.view?.graph?.nodes),
      `②-1 GET arch/blueprint 读回已发布规划图 + 合成视图（${got.body?.view?.graph?.nodes?.length ?? 0} 个合成节点）`,
    );
    ok(
      typeof got.body?.plan_code === "object" && got.body.plan_code !== null,
      "②-1 GET arch/blueprint 同返规划↔实现对账（§4.5）",
    );
    const post = await api(`/api/projects/${EMPTY}/arch/blueprint`, { method: "POST", body: JSON.stringify({ trigger: "manual-http", semantic: false }) });
    ok(
      post.status === 200 && post.body?.result?.publish?.published === true && post.body?.result?.model_calls === 0,
      `②-1 POST arch/blueprint 手动触发重建：发布成功且 model_calls=0（缺省零模型，§4.4）`,
    );
    await stopChild(serverChild);
    serverChild = null;
  }

  // ── ③-4 草稿图预览（DESIGN §3.2「未审定方案可预览，但明确标草稿图」；2026-09-22 批外缺陷修复）──
  // 修前：图纸在场但从未激活基线的项目，读口只回 `blueprint:{exists:false}`，主界面是一片空白——
  // 图数据派得出来、用户看不到。修后：读口给**只读、零写盘、零模型**的草稿，并明标 draft_unaudited；
  // 发布门禁一个字没动（能不能落成正式图仍由 rebuildBlueprint 判）。
  info("── ③-4 草稿图预览（未审定可预览，但不冒充已发布、不写盘）");
  {
    const before = snapshotTree(draftOnlyRoot);
    const draft = draftBlueprintOf(DRAFTONLY);
    ok(
      draft !== null && draft.blueprint.nodes.length > 0,
      `③-4 未激活基线的项目能派生出草稿（${draft?.blueprint.nodes.length ?? 0} 节点 / ${draft?.blueprint.edges.length ?? 0} 边）`,
    );
    ok(
      draft !== null && draft.blueprint.draft === true && draft.blueprint.publish.published === false,
      "③-4 草稿恒为 draft:true + published:false（不冒充已发布的有效图）",
    );
    ok(
      draft !== null && draft.reason !== null && draft.reason.startsWith("baseline_missing"),
      `③-4 草稿带不可发布原因（${draft?.reason ?? "null"}）`,
    );
    ok(
      draft !== null && draft.validation.blocking.some((b) => b.code === "baseline_missing"),
      "③-4 结构校验的 blocking 原样进草稿（没有被「能预览」掩盖）",
    );
    ok(readBlueprint(DRAFTONLY) === null, "③-4 草稿预览**没有**落成已发布图（blueprint.json 仍不存在）");
    ok(readBlueprintReceipt(DRAFTONLY) === null, "③-4 草稿预览连回执都不写（只读入口零写盘副作用，同 Q18 对 layout GET 的口径）");
    ok(snapshotTree(draftOnlyRoot) === before, "③-4 草稿预览前后项目目录逐字节未变（零写盘硬证）");

    // 发布门禁未放宽：POST 路径照样拒绝发布（receipt 落盘，但图不落）
    const gate = await rebuildBlueprint(DRAFTONLY, { trigger: "verify-draft-gate", semantic: false });
    ok(
      gate.publish.published === false && readBlueprint(DRAFTONLY) === null,
      `③-4 发布门禁一个字没动：POST 路径仍拒发（${gate.publish.reason ?? "无原因"}）`,
    );

    serverChild = spawnServer();
    await waitUp();
    const gotDraft = await api(`/api/projects/${DRAFTONLY}/arch/blueprint`);
    ok(
      gotDraft.status === 200 && gotDraft.body?.blueprint?.exists === false,
      "③-4 读口仍如实报 blueprint.exists=false（草稿不占已发布位，两者字段分开）",
    );
    ok(
      gotDraft.body?.draft?.exists === true && gotDraft.body?.draft?.label === "draft_unaudited",
      `③-4 读口给出草稿并标 draft_unaudited（label=${gotDraft.body?.draft?.label ?? "null"}）`,
    );
    const draftNote: unknown = gotDraft.body?.draft?.note;
    ok(
      gotDraft.body?.draft?.blueprint?.publish?.published === false &&
        typeof draftNote === "string" &&
        draftNote.includes("不能当施工依据"),
      "③-4 草稿载荷自带未审定声明与「不能当施工依据」边界（§3.2）",
    );
    ok(
      Array.isArray(gotDraft.body?.draft?.blueprint?.nodes) && gotDraft.body.draft.blueprint.nodes.length > 0,
      `③-4 读口带回的草稿有真节点可画（${gotDraft.body?.draft?.blueprint?.nodes?.length ?? 0} 个）`,
    );
    const gotPublished = await api(`/api/projects/${EMPTY}/arch/blueprint`);
    ok(
      gotPublished.body?.blueprint?.exists === true && gotPublished.body?.draft?.exists === false,
      "③-4 已有已发布图的项目不给草稿（不把草稿混进正在施工的有效图，§3.2）",
    );
    await stopChild(serverChild);
    serverChild = null;
  }

  // ── ②-2 DeepSeek 语义整理 + 程序校验/发布 ──
  const semanticBp = coopRebuild.blueprint;
  ok(
    coop.calls() === 1 && coopRebuild.rebuilt && coopRebuild.publish.published,
    `②-2 语义整理调模型 1 次并发布（model_calls=${coopRebuild.model_calls}）`,
  );
  ok(
    semanticBp?.model_receipt?.ok === true && semanticBp.model_receipt.raw_sha256 !== null && semanticBp.model_receipt.proposal !== null,
    "②-2 模型回执保留在缓存里（raw_sha256 + 规范化整理结果 proposal，§4.1「可基于已保存的整理结果重建」）",
  );
  ok(
    semanticBp !== null && semanticBp.publish.published && semanticBp.publish.validated_at !== null,
    "②-2 只有程序校验通过且无未处理基线冲突才发布（publish.validated_at 非空）",
  );

  // ── ②-3 无出处关系标待核实 ──
  // 定向更新（V09-18，2026-09-26，GPT-6 裁定 1–2／DESIGN §4.1／附录 E.17「提案线索化」）：判据未放宽、反而收紧——
  //   旧期望：模型给的无出处关系作为 certainty=unverified 的**正式边**进图，并进 review 清单（unverified_relation）｜
  //   依据：模型自报 certainty 不构成 DESIGN/PLAN 声明；提案边一律记为**待审线索**（model_leads），
  //   不进正式关系、不进能力成员/二级派生/绿态/交付读数，界面与 MCP 不得展示成已审定关系｜
  //   新期望：该关系 ① 不在 edges 里；② 在 model_leads 里（model_certainty=unverified、disposition=lead_pending_review、
  //   出处 0 条如实保留）；③ 正式关系里 0 条模型提案——「待核实、交设计角色」由线索账表达，不再借正式边的 review 清单｜
  //   保留意图：模型给的坏关系照样可见、照样不许当已审定架构——防护从「进图但标待核实」收紧为「根本不进正式关系」。
  const lead = semanticBp?.model_leads?.find((l) => l.source === "plan:concept:共享概念" && l.target === "plan:code:src-mod-a") ?? null;
  const inEdges = semanticBp?.edges.some((e) => e.source === "plan:concept:共享概念" && e.target === "plan:code:src-mod-a") ?? false;
  ok(
    !inEdges && lead !== null && lead.model_certainty === "unverified" && lead.disposition === "lead_pending_review" && lead.source_refs.length === 0,
    `②-3 模型给的无出处关系只进待审线索账、不进正式关系（在 edges=${inEdges}；线索 model_certainty=${lead?.model_certainty ?? "?"}、disposition=${lead?.disposition ?? "?"}、出处 ${lead?.source_refs.length ?? "?"} 条）`,
  );
  ok(
    !(semanticBp?.edges ?? []).some((e) => e.certainty === "unverified"),
    "②-3 正式关系里 0 条模型提案（提案一律待审线索、不当已审定架构；§4.1／附录 E.17）",
  );

  // ── ②-4 禁止模型输入任务完成色/进度 ──
  const statusKeys = ["status", "color", "progress"];
  ok(
    semanticBp !== null && !JSON.stringify(semanticBp.nodes).includes('"status"') && !JSON.stringify(semanticBp.nodes).includes('"color"'),
    "②-4 模型给的完成色/进度字段**没有**进规划数据（节点里查不到 status/color 字段）",
  );
  ok(
    semanticBp?.model_receipt?.rejected_fields.some((f) => statusKeys.some((k) => f.endsWith(`.${k}`))) === true,
    `②-4 被摘掉的脏字段如实记进回执（${semanticBp?.model_receipt?.rejected_fields.join("、") ?? "无"}）`,
  );
  const stripped = stripStatusKeys({ name: "甲", status: "done", nested: { color: "green", keep: 1 } }, "$", []);
  ok(
    typeof stripped === "object" && !("status" in (stripped as object)) && !("color" in ((stripped as any).nested as object)) && (stripped as any).nested.keep === 1,
    "②-4 摘字段是递归的且只摘脏字段（干净字段不动）",
  );

  // ── ②-5 静态 parse 不得冲掉规划层（两层分别存储）──
  const beforeParse = JSON.stringify(readBlueprint(PARTIAL));
  const beforeIds = semanticBp === null ? [] : nodeIds(semanticBp);
  const parseAgain = parseProject(PARTIAL);
  const afterParse = readBlueprint(PARTIAL);
  ok(
    JSON.stringify(afterParse) === beforeParse,
    `②-5 静态 parse 不冲掉规划层：重跑 arch/parse（${parseAgain.file.modules.length} 模块）后 blueprint.json 逐字节未变`,
  );
  ok(
    afterParse !== null && JSON.stringify(nodeIds(afterParse)) === JSON.stringify(beforeIds),
    "②-5 规划节点身份与集合在静态解析后不变（规划层与静态层分别存储）",
  );
  ok(
    fs.existsSync(path.join(workbench(partialRoot), "arch", "modules.json")) && fs.existsSync(path.join(workbench(partialRoot), "arch", "blueprint.json")),
    "②-5 两层落点分离：modules.json（静态解析层唯一写口）与 blueprint.json（规划层派生缓存）各存各的",
  );

  // ── ②-6 模型失败保留旧图 ──
  const beforeFailure = JSON.stringify(readBlueprint(PARTIAL));
  const errChat = mkErrorChat("夹具模型故障：网关 502");
  const failed = await rebuildBlueprint(PARTIAL, { trigger: "manual", semantic: true, chat: errChat.fn, force: true });
  ok(
    failed.publish.published === false && failed.kept_previous && JSON.stringify(readBlueprint(PARTIAL)) === beforeFailure,
    `②-6 模型失败保留旧图：旧图逐字节不变，本次发布被拒（reason=${JSON.stringify(failed.publish.reason)}）`,
  );
  ok(
    readBlueprintReceipt(PARTIAL)?.published === false && (readBlueprintReceipt(PARTIAL)?.model?.error ?? "").includes("502"),
    "②-6 失败原因写进回执（模型错误原文，界面可显示「为什么没更新」）",
  );
  const badJson = await rebuildBlueprint(PARTIAL, { trigger: "manual", semantic: true, chat: mkBadJsonChat("模型答了，但不是 JSON"), force: true });
  ok(
    badJson.publish.published === false && JSON.stringify(readBlueprint(PARTIAL)) === beforeFailure,
    `②-6 模型答了但不是 JSON（half-截断）同样不覆盖旧图（reason 含"没有 JSON": ${JSON.stringify(badJson.publish.reason)?.includes("JSON")}）`,
  );

  // ── ②-7 过时响应不覆盖新图 ──
  const hang = mkHangingChat();
  const stalePromise = rebuildBlueprint(PARTIAL, { trigger: "stale-A", semantic: true, chat: hang.fn, force: true });
  for (let i = 0; i < 40 && !hang.started(); i++) await sleep(50);
  // 期间改源（设计书加一节 → 缓存键变化）× 期间新一次派生先落地
  write(path.join(workbench(partialRoot), "design.md"), PARTIAL_DESIGN_V2);
  const newer = await rebuildBlueprint(PARTIAL, { trigger: "newer-B", force: true });
  const newerBytes = JSON.stringify(readBlueprint(PARTIAL));
  hang.release();
  const staleResult = await stalePromise;
  ok(
    newer.publish.published && staleResult.stale_discarded && staleResult.publish.published === false,
    `②-7 过时响应被丢弃：旧响应 stale_discarded=${staleResult.stale_discarded}（reason=${JSON.stringify(staleResult.publish.reason)}）`,
  );
  ok(
    JSON.stringify(readBlueprint(PARTIAL)) === newerBytes && readBlueprint(PARTIAL)?.based_on.full_key === newer.cache_key,
    "②-7 较新结果没被旧响应覆盖（磁盘上的图仍是新的那一份）",
  );

  // ═══════════════════════ ③ 三条硬要求 ═══════════════════════
  info("── ③ 零文件仍有规划图 / 身份稳定 / 缺失覆盖如实 / 纯状态变化零模型重画 / §11.1 兼容");

  // ── ③-1 零文件（空仓）仍有规划图 ──
  const emptySrc = readBlueprintSources(EMPTY);
  const emptyDerived = deriveBlueprint(emptySrc, { based_on: baseOf(emptyBp ?? ({} as Blueprint)) });
  ok(
    emptySrc.code.modules.length === 0 && emptyDerived.nodes.length >= 5 && emptyDerived.edges.length > 0,
    `③-1 零文件（空仓）仍有规划图：${emptyDerived.nodes.length} 节点 / ${emptyDerived.edges.length} 关系，且代码侧输入条数为 0`,
  );
  const emptyView = viewGraphWithPlan(EMPTY);
  ok(
    emptyView.graph.nodes.some((n) => n.plan_origin === "plan") && emptyView.blueprint !== null,
    `③-1 空仓的视图合成也出图：${emptyView.graph.nodes.length} 个合成节点（其中 ${emptyView.graph.nodes.filter((n) => n.plan_origin === "plan").length} 个规划灰节点）`,
  );

  // ── ③-2 重新生成身份稳定（改名不换身份）──
  const srcA = readBlueprintSources(EMPTY);
  const firstRun = deriveBlueprint(srcA, { based_on: baseOf(emptyBp ?? ({} as Blueprint)) });
  const secondRun = deriveBlueprint(readBlueprintSources(EMPTY), { based_on: baseOf(emptyBp ?? ({} as Blueprint)) });
  ok(
    JSON.stringify(nodeIds(firstRun)) === JSON.stringify(nodeIds(secondRun)),
    `③-2 同一输入重复派生：节点 id 集合逐字相同（${nodeIds(firstRun).length} 个，不因重生成漂移）`,
  );
  // 改名：把设计书里的「模块甲」改成「模块甲（改名后）」→ 模块节点 id 必须不变，只有 name 变
  const renamedDesign = EMPTY_DESIGN.replace("- 模块甲：甲的实现", "- 模块甲改名后：甲的实现");
  write(path.join(workbench(emptyRoot), "design.md"), renamedDesign);
  const renamedRun = deriveBlueprint(readBlueprintSources(EMPTY), { based_on: baseOf(emptyBp ?? ({} as Blueprint)) });
  const modNodeBefore = firstRun.nodes.find((n) => n.kind === "module" && n.name === "模块甲") ?? null;
  const modNodeAfter = modNodeBefore === null ? null : renamedRun.nodes.find((n) => n.id === modNodeBefore.id) ?? null;
  ok(
    modNodeBefore !== null && modNodeAfter !== null && modNodeAfter.name.includes("改名"),
    `③-2 改名不换身份：模块节点 ${modNodeBefore?.id ?? "?"} 的 name 从「${modNodeBefore?.name ?? "?"}」变成「${modNodeAfter?.name ?? "?"}」，id 不变`,
  );
  ok(
    JSON.stringify(nodeIds(renamedRun)) === JSON.stringify(nodeIds(firstRun)),
    "③-2 改名不改节点集合（章节序号 + 条目序号 + 卡号 + 模块 id 构成稳定 id）",
  );
  write(path.join(workbench(emptyRoot), "design.md"), EMPTY_DESIGN); // 复原夹具

  // ── ③-3 缺失覆盖如实报告 ──
  const honest = firstRun.coverage;
  ok(
    honest.design_sections.mapped + honest.design_sections.unmapped.length === honest.design_sections.total &&
      honest.design_sections.unmapped.length > 0,
    `③-3 缺失覆盖如实：设计章节 ${honest.design_sections.mapped}/${honest.design_sections.total} 已映射，未映射 ${honest.design_sections.unmapped.length} 条逐条列出`,
  );
  ok(
    firstRun.omitted.some((o) => o.kind === "unmapped" && o.count >= 1),
    `③-3 omitted 如实记录省略范围（${firstRun.omitted.map((o) => `${o.kind}×${o.count}`).join("、")}）`,
  );

  // ── ③-4 纯任务状态变化零模型重画 ──
  // 必须先有一个 semantic 的已发布图（coopRebuild 被 ②-7 的改源冲掉了 → 重新发一份）
  const semNow = await rebuildBlueprint(PARTIAL, { trigger: "manual", semantic: true, chat: coop.fn, force: true });
  ok(
    semNow.publish.published,
    `③-4 前置：先发布一份带模型整理结果的规划图（reason=${JSON.stringify(semNow.publish.reason)}；blocking=${JSON.stringify(semNow.validation?.blocking.map((f) => f.code) ?? [])}）`,
  );
  const keyBefore = semNow.cache_key;
  const defHashBefore = readBlueprintSources(PARTIAL).plan?.definition_sha256 ?? "";
  // 真改任务状态两条路径：① 工作层真事件（v2 事件流）② 施工图「状态」列投影（派生状态区）
  const svc = new WorkService({ dataDir });
  const imported = importTaskDefinitions(read(path.join(workbench(partialRoot), "plan.md")));
  submitDefinitionImports(svc, {
    project_id: PARTIAL,
    change_id: "v0605-defs",
    actor_id: "verify-v06-05",
    role: "executor",
    definitions: imported.definitions,
  });
  const rev = readTaskStates(projectWorkDir(PARTIAL, dataDir)).states["T-1"]?.revision ?? 0;
  submitTaskStatus(svc, {
    project_id: PARTIAL,
    task_id: "T-1",
    change_id: "v0605-status",
    actor_id: "verify-v06-05",
    role: "executor",
    expected_revision: rev,
    status: "executing",
  });
  const planText = read(path.join(workbench(partialRoot), "plan.md"));
  const projected = renderPlanStatusRegion(planText, { "T-1": mkState("T-1", "executing") });
  write(path.join(workbench(partialRoot), "plan.md"), projected.text);
  const defHashAfter = readBlueprintSources(PARTIAL).plan?.definition_sha256 ?? "";
  ok(
    projected.changed.includes("T-1") && defHashBefore === defHashAfter && defHashBefore !== "",
    `③-4 前置：任务状态真变了（施工图状态列 ${projected.changed.join("/")}），但施工**定义**哈希不变（${defHashBefore.slice(0, 12)}…）`,
  );
  const counting = mkJsonChat(COOP_PROPOSAL);
  const statusRebuild = await rebuildBlueprint(PARTIAL, { trigger: "status_changed", semantic: true, chat: counting.fn });
  ok(
    counting.calls() === 0 && statusRebuild.model_calls === 0 && statusRebuild.rebuilt === false,
    `③-4 纯任务状态变化**零模型重画**：model_calls=${statusRebuild.model_calls}、rebuilt=${statusRebuild.rebuilt}、缓存键未变（${statusRebuild.cache_key === keyBefore}）`,
  );
  ok(
    statusRebuild.publish.published && statusRebuild.publish.reason === "cache_hit",
    "③-4 命中完整缓存键：复用已发布规划图（§4.4 任务/验证变化只重算状态，不调 DeepSeek）",
  );
  const finalBp = readBlueprint(PARTIAL);
  const dirtyKeys = [
    ...(finalBp?.nodes ?? []).flatMap((n) => forbiddenStatusKeysIn(n, `node:${n.id}`)),
    ...(finalBp?.edges ?? []).flatMap((e) => forbiddenStatusKeysIn(e, `edge:${e.source}→${e.target}`)),
  ];
  ok(
    finalBp?.nodes.some((n) => n.kind === "task") === true && dirtyKeys.length === 0,
    `③-4 规划图里没有任何任务完成色/状态字段：${finalBp?.nodes.filter((n) => n.kind === "task").length} 个任务节点，脏字段 ${dirtyKeys.length} 处（§4.2：进度由事实派生，不由图写）`,
  );

  // ── ③-5 §11.1 解析兼容验证（保留）──
  const tataiDesign = read(path.join(REPO, "DESIGN.md"));
  const tataiPlan = read(path.join(REPO, "PLAN.md"));
  const tataiModules = extractTataiDesignModules(tataiDesign);
  const tataiSection = moduleSectionPathOf(tataiDesign, true);
  ok(
    tataiModules.length === 10 && tataiModules.every((m) => m.confidence === "high"),
    `③-5 §11.1 解析兼容保留：DESIGN.md §11.1 表格仍提取 ${tataiModules.length} 项（${tataiModules.map((m) => m.name).slice(0, 3).join("/")}…）`,
  );
  const tataiSectionIndex = buildSectionIndex(designDefinitionText(tataiDesign));
  const tataiSectionExpected = tataiSectionIndex.find((s) => s.title.startsWith("11.1 "))?.path ?? null;
  ok(
    tataiSection !== null && tataiSection === tataiSectionExpected,
    `③-5 模块清单章节可定位且与章节索引逐字一致（locator = ${tataiSection ?? "null"}）`,
  );
  const tataiSrc: BlueprintSources = {
    baseline_id: "bl-fixture-tatai",
    design: {
      path: "DESIGN.md",
      content_sha256: sha256(tataiDesign),
      definition_sha256: sha256(designDefinitionText(tataiDesign)),
      text: tataiDesign,
      sections: tataiSectionIndex.map((s) => ({ path: s.path, sha256: s.sha256, level: s.level, title: s.title })),
    },
    plan: {
      path: "PLAN.md",
      content_sha256: sha256(tataiPlan),
      definition_sha256: "fixture-plan-definition",
      text: tataiPlan,
      tasks: importTaskDefinitions(tataiPlan).definitions,
    },
    declared_modules: tataiModules.map((m) => ({ ...m, section_path: tataiSection })),
    code: {
      available: true,
      budget_exhausted: null,
      modules: [
        { id: "src-arch", path: "src/arch", file_count: 12 },
        { id: "src-server", path: "src/server", file_count: 30 },
      ],
    },
    // 半合成夹具：代码模块是合成的（无根模块），根级文件清单对本段断言无意义，如实 null
    repo_root_files: null,
    names: { "src-arch": { name: "架构图引擎" } },
    manifest: [],
  };
  const tataiBp = deriveBlueprint(tataiSrc, { based_on: baseOf({} as Blueprint) });
  const tataiModNodes = tataiBp.nodes.filter((n) => n.kind === "module" && n.id.startsWith("plan:mod:"));
  ok(
    tataiModNodes.length === 10 &&
      tataiModules.every((m) => tataiModNodes.some((n) => n.name === m.name)) &&
      tataiModNodes.every((n) => n.source_refs.some((r) => r.kind === "design_section" && r.locator === tataiSection)),
    `③-5 真实 DESIGN.md §11.1 十项成为规划图模块节点，出处全部指向 §11.1 章节（${tataiModNodes.length} 个）`,
  );
  ok(
    tataiBp.nodes.some((n) => n.kind === "capability") && tataiBp.edges.some((e) => e.kind === "task_dependency"),
    `③-5 真实 PLAN.md 的任务与依赖同样进图（能力 ${tataiBp.nodes.filter((n) => n.kind === "capability").length} / 任务 ${tataiBp.nodes.filter((n) => n.kind === "task").length} / 依赖边 ${tataiBp.edges.filter((e) => e.kind === "task_dependency").length}）`,
  );

  // ── ③-6 三图回归冒烟（旧图口径与规划层合并互不干扰）──
  const shared: SharedGraph = buildSharedGraphFrom(
    [
      { id: "src-arch", path: "src/arch", file_count: 12, deps: [{ to: "src-server", weight: 3 }] },
      { id: "src-server", path: "src/server", file_count: 30, deps: [] },
    ],
    { "src-arch": { name: "架构图引擎", blurb: "夹具", kind: "code" } },
  );
  const modes = ["MODULE_BOX", "DATA_FLOW", "MIND_MAP"] as const;
  const okModes = modes.every((m) => {
    const sel = selectGraph(m, shared);
    // E_view ⊆ E_ALL：节点集合一律等于共用层；边按**无序对**归属（DATA_FLOW 会把方向翻转成提供者→消费者，
    // 归并互惠对后也只剩一条——这是既有的 DATA_FLOW_EDGE_RULE 口径，不是漂移）
    const pairOf = (a: string, b: string) => [a, b].sort().join(">");
    const allPairs = new Set(shared.edges.map((e) => pairOf(e.from, e.to)));
    return sel.nodes.length === shared.nodes.length && sel.edges.every((e) => allPairs.has(pairOf(e.from, e.to)));
  });
  ok(okModes, "③-6 旧三视图口径未变：三种模式节点集合等于共用层、边集合 ⊆ E_ALL（E_view ⊆ E_ALL，方向按各模式口径）");
  const merged = mergePlanningLayer(shared, {
    baseline_id: "bl-fixture",
    nodes: [
      { id: "plan:cap:01", name: "能力甲", kind: "capability", code_module_ids: [] },
      { id: "plan:code:src-arch", name: "架构图引擎", kind: "module", code_module_ids: ["src-arch"] },
    ],
    edges: [{ source: "plan:cap:01", target: "plan:code:src-arch", kind: "design_interface", certainty: "declared" }],
  });
  ok(
    merged.nodes.find((n) => n.id === "src-arch")?.plan_refs?.includes("plan:code:src-arch") === true &&
      merged.nodes.some((n) => n.plan_origin === "plan") &&
      merged.edges.some((e) => e.origin === "plan"),
    "③-6 规划层并入共用层：实测模块挂上 plan_refs、未实现项成灰节点、规划关系带 origin=\"plan\"（唯一合并点）",
  );
  ok(
    shared.nodes.every((n) => n.plan_refs === undefined),
    "③-6 合并不改原对象：合并前的共用层节点没有被就地写入 plan_refs（纯函数）",
  );
} catch (e) {
  ok(false, `验证中断：${(e as Error).message}`);
  console.error(e);
} finally {
  if (serverChild !== null) await stopChild(serverChild);

  // ── 文档首尾哈希对照（零改动证明）──
  info("── 文档零改动核对（首尾逐文件 sha256）");
  for (const rel of DOC_FILES) {
    const abs = path.join(REPO, rel);
    const after = fs.existsSync(abs) ? sha256File(abs) : "<missing>";
    ok(after === docBefore.get(rel), `文档未被改动：${rel} sha256=${after.slice(0, 16)}…`);
  }

  if (process.env.TATAI_KEEP_TMP === "1") {
    info(`保留现场：${tmpBase}`);
  } else {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    info(`夹具已清理：${path.basename(tmpBase)}`);
  }
  console.log(`\n[verify] V06-05 结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
}

/** ①-B 的对账口径断言（提出来只为让调用点读起来短一点） */
function partBCodeOnlyCheck(pc: ReturnType<typeof planVsCode>): boolean {
  if (pc === null) return false;
  return pc.code_only.some((c) => c.id === "legacy") && pc.mapped.length >= 2 && pc.planned_only.length >= 1;
}
