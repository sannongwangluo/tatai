// V06-13 验证脚本（PLAN.md V06-13 检查项 ①；DESIGN.md §1.6 / §3.14 / §11.8）。用法：pnpm verify:v06-13
//
// 这是 V06-13 的**隔离演练**（卡面检查项 ① 的八条逐条落成断言）；浏览器侧在
// `python scripts/verify-v06-13-ui.py`（§3.14「必须演练」清单），本脚本不碰浏览器。
//
// 八段（与卡面 ① 的点名顺序一一对应）：
//   ① 空仓灰图：零代码 + 零执行 → 规划图照样出得来，节点全灰、**一个绿都没有**；派生零模型、
//      不带任何完成色字段（§2.9 / §4.2 / §11.8「空仓规划与自动绘图」）。
//   ② 既有项目逆向入口产出两份草稿 → 审定配套基线 → 无证据实现仍待验证（§9.2 / §9.4）。
//      两份草稿由**真逆向入口**产出（模型侧走本脚本自带的 SSE 伪模型，确定性、不花钱、不联网）。
//   ③ 图纸改动：半套图纸不生效、旧基线保持到新基线激活成功、源变了进"影响待查"（§2.9 / §3.12）。
//   ④ 聊天与任务关联：四行动作里认得出意图、动作落在同一份事实、幂等不重复产生效果（§3.6）。
//   ⑤ 双 Agent 认领：第二个执行者被明确拒绝（带现场与重新读状态的入口）；依赖未释放 / 无证据 /
//      别人的 token / 租约到期都要如实拒绝（§2.7 / §11.8「并发认领」）。
//   ⑥ 旧证据失效：源修订一变，旧绿转"待验证"且旧结论保留在历史里；**只重验受影响对象**（§4.2 / §5.6）。
//   ⑦ Git 提醒：只读探测、无上游不写"已同步"、代码提交 ≠ 私有事实已备份（§3.15 / §8.5）。
//   ⑧ 收尾自证：塔台根文档与既有 scripts/** 首尾哈希逐项相同；夹具全在 os.tmpdir()、跑完自删。
//
// ██ 红线遵守 ██
//   · 所有夹具（含 git init/add/commit 这类写命令）只出现在 `os.tmpdir()` 下本脚本自建的目录里，
//     入口用 `assertUnderTmp()` 兜住；收尾整棵删掉（`TATAI_KEEP_TMP=1` 保留现场）。
//   · **不碰**三个真实项目的 `.工作台/`，也不对 `D:/tatai` 跑任何写类命令；本脚本源码里不含任何
//     真实项目路径（第 ⑧ 段源码级自证）。
//   · 真模型不参与：② 段用自带 SSE 伪模型（只喂确定性回答）；④ 段的"更新图"走产品自带的
//     **零模型**确定性派生（`semantic:false`）。
//   · 不代签：本脚本不产生任何"用户已验收""GPT-6 已抽查"的记录，也不改 Gate。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BLUEPRINT_LIMITS,
  blueprintPath,
  deriveBlueprint,
  readBlueprint,
  readBlueprintSources,
  rebuildBlueprint,
} from "../src/arch/blueprint";
import { forbiddenStatusKeysIn } from "../src/arch/blueprintValidate";
import { addProject, type ProjectKind } from "../src/server/registry";
import { projectWorkDir } from "../src/server/workstation";
import { draftDesign, readReverseDraft, readReversePlanDraft, finalizeDraft } from "../src/server/reverseDraft";
import {
  activeBaseline,
  activateBaseline,
  diffRevisionsByHash,
  diffSections,
  loadDocument,
  readBaselineLog,
} from "../src/server/work/documents";
import { importTaskDefinitions, taskDefinitionHash, type TaskDefinition } from "../src/server/work/plan";
import { submitDefinitionImports, submitTaskStatus } from "../src/server/work/tasks";
import { submitIndependentAudit, submitSubmission, type CoverageRow } from "../src/server/work/audit";
import { claimTask, submitTaskResult } from "../src/server/work/claims";
import { WorkService } from "../src/server/work/service";
import type { WorkCommand } from "../src/server/work/types";
import type { WorkSubmitter } from "../src/server/work/tasks";
import { evaluateProjectEntry } from "../src/server/work/entry";
import { readChatActions, runChatAction } from "../src/server/work/chatActions";
import { putEvidence } from "../src/server/work/evidence";
import { buildSourceManifest } from "../src/server/work/sourceEvidence";
import {
  checkEffectiveness,
  projectFromFacts,
  projectStatuses,
  type CheckInput,
  type SourceRevisions,
  type StatusObjectInput,
} from "../src/server/work/statusProjection";
import { buildVersionReminder, inspectGitStatus } from "../src/server/gitStatus";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF_FILE = fileURLToPath(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0613-verify-"));
const DATA_DIR = path.join(TMP, "home");
const CHG = "chg-v0613";
/** 本脚本的"现在"（固定值：断言不随真实时钟漂） */
const NOW = "2026-09-20T10:00:00.000Z";

let passCount = 0;
let failCount = 0;
function ok(cond: boolean, label: string): void {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
  }
}
const info = (msg: string): void => console.log(`[verify]   ${msg}`);
const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const sha256File = (f: string): string => sha256(fs.readFileSync(f));
const mkdirp = (d: string): void => {
  fs.mkdirSync(d, { recursive: true });
};
const write = (f: string, text: string): void => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
const read = (f: string): string => fs.readFileSync(f, "utf8");

/** 夹具路径护栏：任何"造现场/跑 git"的动作都不许落到本脚本临时目录之外 */
function assertUnderTmp(p: string): void {
  if (!path.resolve(p).startsWith(path.resolve(TMP) + path.sep)) {
    throw new Error(`夹具路径必须在本脚本临时目录下：${p}`);
  }
}

/** **夹具专用** git（写命令只允许夹具仓库用；真仓库一次都不走这里） */
function gitWrite(cwd: string, args: string[]): void {
  assertUnderTmp(cwd);
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

// ══════════════════════════ 开工前守护（收尾逐项对照） ══════════════════════════

/** 塔台根文档：本卡只读，首尾逐文件 sha256 对照 */
const ROOT_DOCS = [
  "DESIGN.md",
  "PLAN.md",
  "PROGRESS.md",
  "AGENTS.md",
  "README.md",
  "docs/design-history-v0.4.md",
  "docs/design-history-v0.5.md",
];
const rootDocBefore = new Map<string, string>(
  ROOT_DOCS.map((rel) => {
    const abs = path.join(REPO, rel);
    return [rel, fs.existsSync(abs) ? sha256File(abs) : "<missing>"];
  }),
);
/** 既有 `scripts/**`：本卡不许改动任何既有脚本（新脚本自己不在名单里） */
const SCRIPTS_DIR = path.join(REPO, "scripts");
function scriptFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(abs);
    }
  };
  walk(SCRIPTS_DIR);
  return out;
}
const scriptHashesBefore = new Map<string, string>(
  scriptFiles()
    .filter((f) => path.resolve(f) !== path.resolve(SELF_FILE))
    .map((f) => [f, sha256File(f)]),
);
info(`开工前：根文档 ${rootDocBefore.size} 份、既有 scripts 文件 ${scriptHashesBefore.size} 份的哈希已记下`);

// ══════════════════════════ 隔离环境 ══════════════════════════

mkdirp(DATA_DIR);
process.env.TATAI_HOME = DATA_DIR;
const service = new WorkService({ dataDir: DATA_DIR });
const submitter: WorkSubmitter = { submit: (c: WorkCommand) => service.submit(c) };

// ══════════════════════════ 夹具项目 ══════════════════════════

interface Card {
  id: string;
  goal: string;
  dep?: string;
  checks?: string[];
}

/** 合法施工图（表 + 卡正文；字段标签走 `TASK_FIELD_ALIASES` 的口径） */
function planText(title: string, cards: Card[]): string {
  const lines = [`# ${title}`, "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"];
  for (const c of cards) lines.push(`| ${c.id} | todo | ${c.goal} | ${c.dep ?? ""} | ${c.id} 的完成证据 |`);
  lines.push("");
  for (const c of cards) {
    lines.push(`### ${c.id} ${c.goal}`, "");
    lines.push(`**设计依据**：§2。**依赖**：${c.dep ?? "无"}。**文件责任**：\`src/${c.id.toLowerCase().replace(/-/g, "")}.ts\`。`, "");
    for (const ck of c.checks ?? [`${c.id} 的验收检查项一`]) lines.push(`- [ ] ${ck}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** 设计书：带编号 level-2 章节（规划图的"能力"就来自这里） */
function designText(title: string, extraSection = ""): string {
  return (
    `# ${title}\n\n> 夹具设计书（V06-13 隔离演练用；不是任何真实项目的设计）。\n\n` +
    "## 1 目标\n\n夹具目标一句话。\n\n" +
    "## 2 导入能力\n\n- 模块：src（导入实现）\n\n" +
    "## 3 导出能力\n\n- 模块：src（导出实现）\n" +
    extraSection
  );
}

interface Fixture {
  id: string;
  root: string;
  workDir: string;
  plan: string;
  defs: TaskDefinition[];
}

function makeFixture(
  id: string,
  opts: {
    name: string;
    kind: ProjectKind;
    design: string;
    plan: string;
    code?: Record<string, string>;
    git?: boolean;
    tasksJson?: boolean;
  },
): Fixture {
  const root = path.join(TMP, id);
  assertUnderTmp(root);
  mkdirp(path.join(root, ".工作台"));
  write(path.join(root, ".工作台", "design.md"), opts.design);
  write(path.join(root, ".工作台", "plan.md"), opts.plan);
  for (const [rel, content] of Object.entries(opts.code ?? {})) write(path.join(root, rel), content);
  if (opts.tasksJson !== false) {
    // 模块归属（父级/模块对象的现实来源：`.工作台/tasks.json` 的 module_id）
    write(
      path.join(root, ".工作台", "tasks.json"),
      JSON.stringify(
        {
          version: 1,
          tasks: importTaskDefinitions(opts.plan).definitions.map((d) => ({
            id: d.task_id,
            title: d.goal,
            module_id: "m1",
            status: "todo",
            reporter: "fixture",
            updated_at: NOW,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  }
  if (opts.git === true) {
    gitWrite(root, ["init", "-q", "-b", "main", "."]);
    write(path.join(root, ".gitignore"), ".工作台/\n");
    gitWrite(root, ["add", "--", ".gitignore", ...(opts.code ? Object.keys(opts.code) : [])]);
    gitWrite(root, [
      "-c",
      "user.email=fixture@tatai.local",
      "-c",
      "user.name=fixture",
      "commit",
      "-qm",
      "夹具初版",
    ]);
  }
  addProject({ id, name: opts.name, path: root, kind: opts.kind }, DATA_DIR);
  const imported = importTaskDefinitions(opts.plan, { plan_revision: sha256(opts.plan) });
  return { id, root, workDir: projectWorkDir(id, DATA_DIR), plan: opts.plan, defs: imported.definitions };
}

/** 审定并激活配套基线（批准人如实标注：本脚本不是 GPT-6、也不是用户） */
function approveBaseline(fx: Fixture, basis: string): string {
  const res = activateBaseline(
    fx.id,
    {
      approved_by: "v06-13-fixture-design-role",
      approval_basis: basis,
      approval_kind: "delegated_technical_review",
    },
    DATA_DIR,
  );
  return res.baseline.baseline_id;
}

/**
 * 夹具：只置状态（**历史口径**）。
 *
 * `status="result_submitted"` 走**既有状态边界** `task.status_changed` + `payload.status`——与 `migrate.ts`
 * 把 v1 `done` 折成 `result_submitted` 逐字同一形态（不带交付包、不宣称判据通过）。`task.result_submitted`
 * 是一条**交付提交**事件：只由带合法认领 token + 可追溯证据的提交写入（P2/V09-47 锁内共享判据）。
 * 本夹具只造"这张卡历史上交过结果"的**状态**（**不测试新交付**），不冒充交付提交，也不要求产品为
 * 夹具放宽校验。`submitTaskStatus` 本身**保留原事件语义**（结果提交一律产出 `task.result_submitted`）。
 */
let fixtureStatusSeq = 0;
function submitStatusOnly(submitter: WorkSubmitter, input: Parameters<typeof submitTaskStatus>[1]): void {
  if (input.status !== "result_submitted") {
    submitTaskStatus(submitter, input);
    return;
  }
  fixtureStatusSeq += 1;
  const payload: Record<string, unknown> = { status: "result_submitted" };
  if (input.reason !== undefined) payload.reason = input.reason;
  if (input.definition) {
    payload.definition_sha256 = input.definition.definition_sha256;
    payload.plan_revision = input.definition.plan_revision;
    if (input.definition.definition_revision !== undefined) {
      payload.definition_revision = input.definition.definition_revision;
    }
  }
  submitter.submit({
    schema_version: 2,
    project_id: input.project_id,
    change_id: input.change_id,
    entity_id: `task:${input.task_id}`,
    expected_revision: input.expected_revision,
    type: "task.status_changed",
    actor_id: input.actor_id,
    role: input.role,
    idempotency_key: `fixture-hist-status:${input.task_id}:result_submitted:${String(input.expected_revision)}:${fixtureStatusSeq}`,
    payload,
  });
}

/** 定义导入 + 交结果（不写任何检查记录 → "无证据/无验证"的现场） */
function importDefsAndSubmitResult(fx: Fixture, taskId: string, codeRev: string): void {
  submitDefinitionImports(service, {
    project_id: fx.id,
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    definitions: fx.defs,
  });
  const def = fx.defs.find((d) => d.task_id === taskId);
  if (def === undefined) throw new Error(`夹具缺陷：${fx.id} 里没有任务 ${taskId}`);
  const bound = { definition_sha256: taskDefinitionHash(def), plan_revision: def.plan_revision ?? "" };
  submitTaskStatus(submitter, {
    project_id: fx.id,
    task_id: taskId,
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    expected_revision: 1,
    status: "executing",
    definition: bound,
  });
  submitStatusOnly(submitter, {
    project_id: fx.id,
    task_id: taskId,
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    expected_revision: 2,
    status: "result_submitted",
    definition: bound,
  });
  submitSubmission(submitter, {
    record_id: `sub-${fx.id}-${taskId}`,
    project_id: fx.id,
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    goal: `${taskId} 的交付（夹具）`,
    task_id: taskId,
    changed_files: [],
    commands: [],
    untested: [{ item: "夹具未跑", reason: "隔离演练只验链路" }],
    known_issues: [],
    evidence_refs: [],
    binding: { revision_kind: "code", revision: codeRev },
    submitted_by: "fixture-executor",
  });
}

// ══════════════════════════ 伪模型（② 段专用；只喂确定性回答） ══════════════════════════

interface StubRequest {
  messages: { role: string; content: unknown }[];
}
const stubRequests: StubRequest[] = [];
let stubFail = false;

const DESIGN_DRAFT_MD = [
  "## 一、项目是什么",
  "夹具老项目：做 CSV 导入。",
  "",
  "## 二、模块划分",
  "- src：导入实现",
  "",
  "## 三、当前实际阶段",
  "已有可运行的导入实现。",
  "",
  "## 四、Gate 标在哪一步",
  "推断 Gate 步：develop",
  "理由：git 活跃度与文件完整度都指向开发中。",
].join("\n");

const PLAN_DRAFT_JSON = JSON.stringify({
  observed: [{ path: "src/importer.ts", what: "已实现 CSV 行切分", evidence: "" }],
  tasks: [
    {
      card_id: "RV-01",
      goal: "补齐导入的错误处理与验收证据",
      dependencies: "",
      evidence: "错误用例通过记录",
      files: "`src/importer.ts`",
      checks: ["空文件不抛错"],
      body: "",
    },
  ],
  notes: ["既有实现没有验证证据，一律待验证"],
});

function sseText(text: string): string {
  const chunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
  return (
    chunk({ choices: [{ delta: { content: text }, finish_reason: null }] }) +
    chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
    "data: [DONE]\n\n"
  );
}

const stubServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d: Buffer) => {
    body += d.toString("utf8");
  });
  req.on("end", () => {
    let messages: StubRequest["messages"] = [];
    try {
      messages = (JSON.parse(body) as { messages?: StubRequest["messages"] }).messages ?? [];
    } catch {
      /* 解析不成也照给回答 */
    }
    stubRequests.push({ messages });
    const text = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    if (stubFail) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "夹具：模型侧中断" } }));
      return;
    }
    const reply = text.includes('"observed"')
      ? PLAN_DRAFT_JSON
      : text.includes("请起草四块雏形")
        ? DESIGN_DRAFT_MD
        : "（夹具）普通回答。";
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.end(sseText(reply));
  });
});

const STUB_PORT = 34590;
const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;
const listen = (server: http.Server, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

// ══════════════════════════ 主流程 ══════════════════════════

/** 只读指纹：探测前后 `.git/index` 与工作树逐项对照（⑦ 段只读自证用） */
function gitFingerprint(root: string): string {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".git") continue;
        walk(abs);
      } else if (e.isFile()) files[path.relative(root, abs).replace(/\\/g, "/")] = sha256File(abs);
    }
  };
  walk(root);
  const indexFile = path.join(root, ".git", "index");
  const st = fs.statSync(indexFile);
  return sha256(
    JSON.stringify({
      head: execFileSync("git", ["--no-optional-locks", "rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      listing: sha256(execFileSync("git", ["--no-optional-locks", "ls-files", "-s"], { cwd: root, encoding: "utf8" })),
      index: sha256File(indexFile),
      index_size: st.size,
      index_mtime: st.mtimeMs,
      files,
    }),
  );
}

const FILE_SCOPE_5: CoverageRow[] = [
  { area: "behavior_boundaries", status: "checked", basis: "夹具：按用户路径逐条走" },
  { area: "data_concurrency", status: "unchecked", basis: "夹具：单机串行，未做并发对抗" },
  { area: "interface_integration", status: "checked", basis: "夹具：端到端跑通" },
  { area: "failure_recovery", status: "unchecked", basis: "夹具：未构造故障注入" },
  { area: "trust_permission", status: "not_applicable", basis: "夹具：本卡不涉权限面" },
];

async function main(): Promise<void> {
  console.log("[verify] V06-13 隔离演练（八段；卡面检查项 ① 逐条 + Git/根文档红线自证）");
  console.log(`[verify]   node ${process.version} · ${process.platform} · repo ${REPO}`);
  console.log(`[verify]   夹具根 ${TMP}（隔离 TATAI_HOME ${DATA_DIR}）`);

  // ═══════════════ ① 空仓灰图（零代码、零执行） ═══════════════
  info("① 空仓灰图：零代码 + 零执行 → 规划图照样出得来、全灰、一个绿都没有");
  const emptyFx = makeFixture("V0613-EMPTY", {
    name: "夹具·空仓",
    kind: "backend",
    design: designText("夹具·空仓 设计书"),
    plan: planText("夹具·空仓 施工图", [
      { id: "T-1", goal: "空仓第一张卡" },
      { id: "T-2", goal: "空仓第二张卡", dep: "T-1" },
    ]),
  });
  // 审定口径如实标注：本脚本以**技术判断代行设计角色**，不是 GPT-6，也不是用户拍板
  const emptyBaseline = approveBaseline(
    emptyFx,
    "V06-13 隔离演练：由执行代理以技术判断代行设计角色审定（非 GPT-6、非用户拍板）",
  );
  ok(emptyBaseline.startsWith("bl-"), `① 审定配套基线已激活：${emptyBaseline}`);
  const emptyRebuild = await rebuildBlueprint(emptyFx.id, { dataDir: DATA_DIR, trigger: "baseline_activated" });
  ok(
    emptyRebuild.publish.published === true && emptyRebuild.receipt.published === true,
    `① 有效基线 → 规划图自动发布（published=${emptyRebuild.publish.published}；trigger=${emptyRebuild.receipt.trigger}）`,
  );
  const emptyBp = readBlueprint(emptyFx.id, DATA_DIR);
  ok(emptyBp !== null, "① 规划图已落盘可读（.工作台/arch/blueprint.json）");
  const bp = emptyBp!;
  ok(bp.baseline_id === emptyBaseline, "① 规划图绑定的是当前生效基线（身份对齐，不是拿名字猜的）");
  const capNodes = bp.nodes.filter((n) => n.kind === "capability");
  const taskNodes = bp.nodes.filter((n) => n.kind === "task");
  ok(
    capNodes.length === 3 && taskNodes.length === 2,
    `① 零代码也出图：能力节点 ${capNodes.length} 个（设计书三个 level-2 章节）+ 任务节点 ${taskNodes.length} 个 = ${bp.nodes.length} 个`,
  );
  ok(
    bp.coverage.code_modules.total === 0 && bp.coverage.plan_tasks.mapped === 2,
    `① 覆盖账目如实：代码模块 0/*（空仓没有代码），施工任务 ${bp.coverage.plan_tasks.mapped}/${bp.coverage.plan_tasks.total} 已映射`,
  );
  ok(bp.model_receipt === null, "① 派生**零模型**（model_receipt=null：空仓画图不调模型）");
  ok(
    forbiddenStatusKeysIn({ nodes: bp.nodes, edges: bp.edges }).length === 0,
    "① 节点/关系里**没有任何完成色/进度字段**（模型与派生都不能写颜色当进度 §4.2）",
  );
  // 空仓的另一半正题：定义已导入、**零执行**（没有认领、没有心跳、没有结果提交）
  submitDefinitionImports(service, {
    project_id: emptyFx.id,
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    definitions: emptyFx.defs,
  });
  const srcForDerive = readBlueprintSources(emptyFx.id, DATA_DIR);
  const derived1 = deriveBlueprint(srcForDerive, { based_on: bp.based_on, generated_at: NOW });
  const derived2 = deriveBlueprint(srcForDerive, { based_on: bp.based_on, generated_at: NOW });
  ok(
    JSON.stringify(derived1.nodes.map((n) => n.id)) === JSON.stringify(derived2.nodes.map((n) => n.id)) &&
      JSON.stringify(derived1.nodes.map((n) => n.id)) === JSON.stringify(bp.nodes.map((n) => n.id)),
    `① 派生确定性：同一基线连跑两次 → 同一份节点 id（${bp.nodes.length} 个，改名不换身份的口径）`,
  );
  const emptyProj = projectFromFacts(emptyFx.id, DATA_DIR);
  const t1p = emptyProj.projection.by_id["T-1"];
  const t2p = emptyProj.projection.by_id["T-2"];
  ok(
    t1p?.display_status === "planned" && t2p?.display_status === "planned",
    `① 两张卡都是**灰：已规划，未开始**（${t1p?.display_status} / ${t2p?.display_status}）`,
  );
  ok(
    Object.values(emptyProj.projection.by_id).every((p) => p.display_status !== "verified"),
    "① 空仓里**没有任何对象被判绿**（不空集判绿、不假绿 §4.2）",
  );
  ok(emptyProj.projection.summary.counts.verified === 0, "① 概览计数里 verified=0（界面看到的数字与逐对象一致）");
  const modObj = emptyProj.projection.by_id["module:m1"];
  ok(
    modObj?.object_kind === "module" && modObj.display_status === "planned",
    "① 模块（父级）也在图里且是灰：子项全灰时父级不会是绿，也不需要集成检查就先判绿",
  );
  ok(
    emptyProj.projection.objects.length >= 4 &&
      emptyProj.projection.objects.every((o) => o.execution === "not_started") &&
      emptyProj.projection.summary.basis.includes("百分比"),
    `① **零执行**（${emptyProj.projection.objects.length} 个对象全部 not_started）+ 概览只给计数与缺口、不算虚假完成百分比`,
  );

  // ═══════════════ ② 逆向入口两份草稿 → 审定配套基线 → 无证据实现仍待验证 ═══════════════
  info("② 既有项目逆向入口：两份草稿 → 审定配套基线 → 无证据实现仍待验证");
  await listen(stubServer, STUB_PORT);
  process.env.TATAI_DEEPSEEK_BASE_URL = STUB_URL;
  if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = "stub-key-for-verify";
  info(`② 伪模型（SSE 夹具）已起：${STUB_URL}（本脚本不联真模型、不花钱）`);

  const revFx = makeFixture("V0613-REVERSE", {
    name: "夹具·逆向老项目",
    kind: "backend",
    design: "", // 无 design.md → 逆向入口的正常入口条件
    plan: "",
    code: {
      "src/importer.ts": "export function parseCsv(text: string): string[][] {\n  return text.split('\\n').map((l) => l.split(','));\n}\n",
      "README.md": "# 夹具老项目\n\n已经能做 CSV 导入了，但错误处理还没补。\n",
      "package.json": '{"name":"fixture-legacy","version":"0.0.1"}\n',
    },
    git: true,
    tasksJson: false,
  });
  // 逆向入口的正题：项目里**没有**设计书/施工图
  fs.rmSync(path.join(revFx.root, ".工作台", "design.md"), { force: true });
  fs.rmSync(path.join(revFx.root, ".工作台", "plan.md"), { force: true });
  const reverse = await draftDesign(revFx.id, { memoryTimeoutMs: 1200 }, DATA_DIR);
  ok(reverse.conflict === false, "② 老项目没有设计书 → 逆向入口正常起草（非 conflict）");
  const revPlanDraft = reverse.conflict ? null : reverse.plan_draft;
  const revPlanError = reverse.conflict ? "夹具缺陷：逆向入口返回 conflict" : reverse.plan_draft_error;
  ok(
    revPlanDraft !== null && revPlanError === null,
    `② 逆向入口产出**两份**草稿（第二份施工草稿卡号 ${revPlanDraft?.task_ids.join("、") ?? "（无）"}）`,
  );
  const rd = readReverseDraft(revFx.id, DATA_DIR);
  const rpd = readReversePlanDraft(revFx.id, DATA_DIR);
  ok(rd.exists && rpd.exists, "② 两份草稿都在盘上：`.工作台/design.draft.md` + `.工作台/plan.draft.md`");
  ok(
    revPlanDraft !== null && revPlanDraft.pending_verification >= 1 &&
      (rpd.exists ? rpd.content.includes("待验证") : false),
    `② 已写代码**不算通过**：剩余施工草稿登记了 ${revPlanDraft?.pending_verification ?? 0} 条「观测到的实现」并标待验证`,
  );
  ok(
    (rpd.exists ? rpd.content : "").includes("代码扫描") && (rpd.exists ? rpd.content : "").includes("设计草稿：design.draft.md"),
    "② 第二份草稿写明了来源（代码扫描 / 设计草稿 / 推断依据），不是凭空写的",
  );
  ok(
    !fs.existsSync(path.join(revFx.root, ".工作台", "design.md")) &&
      !fs.existsSync(path.join(revFx.root, ".工作台", "baselines.jsonl")) &&
      !fs.existsSync(path.join(revFx.root, ".工作台", "gate.jsonl")),
    "② 起草**不动 Gate**：草稿阶段没有 design.md / baselines / gate.jsonl（原 Gate 不会被草稿填绿）",
  );
  ok(stubRequests.length >= 2, `② 起草期间模型侧被真调用过（伪模型收到 ${stubRequests.length} 次请求，逐次可回溯）`);

  // 审定：把两份草稿落成配套图纸（本步由执行代理以技术判断代行设计角色确认草稿内容）
  info("② 审定（执行代理以技术判断代行设计角色：确认草稿内容后落成配套图纸，非 GPT-6、非用户拍板）");
  write(path.join(revFx.root, ".工作台", "plan.md"), rpd.exists ? rpd.content : "");
  const finalized = finalizeDraft(revFx.id, { gate_step: "develop", note: "V06-13 隔离演练：草稿转正（夹具）" }, DATA_DIR);
  ok(
    fs.existsSync(path.join(revFx.root, ".工作台", "design.md")) &&
      finalized.reconcile_request_source.includes("reconcile-request.json"),
    "② 设计草稿转正为 design.md，并留对账触发钩子（定版只能由人/审定角色触发 §9.3）",
  );
  const revBaseline = approveBaseline(revFx, "V06-13 隔离演练：配套图纸审定激活（技术判断代行设计角色）");
  const revDocs = loadDocument(revFx.id, "plan", DATA_DIR);
  ok(
    revBaseline.startsWith("bl-") && revDocs !== null && revDocs.table_found,
    "② 审定后激活**配套基线**（design.md + plan.md 成套），施工图结构合法",
  );
  const revDefs = importTaskDefinitions(revDocs!.text, { plan_revision: revDocs!.revision.content_sha256 }).definitions;
  ok(
    revDefs.length >= 1 && revDefs.every((d) => d.acceptance !== null),
    `② 审定后的施工图带验收项（${revDefs.length} 张卡，每张都有验收内容 → 定义可用）`,
  );
  // 无证据实现：有执行状态、没有一条通过的检查 → 只能停在"待验证"
  importDefsAndSubmitResult({ ...revFx, defs: revDefs }, revDefs[0].task_id, "fixture-code-rev-1");
  const revProj = projectFromFacts(revFx.id, DATA_DIR);
  const revTask = revProj.projection.by_id[revDefs[0].task_id];
  ok(
    revTask?.execution === "result_submitted",
    `② 实现已交结果（execution=${revTask?.execution}）——"已经写了"只算执行事实`,
  );
  ok(
    revTask?.display_status === "pending_verification" && (revTask?.missing_count ?? 0) >= 1,
    `② 但**没有验证证据 → 仍待验证**（display=${revTask?.display_status}，缺 ${revTask?.missing_count} 项：${(revTask?.missing ?? []).map((m) => m.check_id).slice(0, 2).join("、")}）`,
  );
  ok(revTask?.quality !== "audit_passed" && revTask?.quality !== "mechanical_passed", `② 质量维度是 ${revTask?.quality}（不是"已经过了检查"）`);
  ok(
    (revTask?.reasons ?? []).some((r) => r.code === "missing_evidence") &&
      (revTask?.reasons ?? []).some((r) => r.code === "acceptance_pending"),
    "② 原因写清「缺必需检查」+「人工验收待用户给」（质量状态不能代写验收）",
  );

  // ═══════════════ ③ 图纸改动 ═══════════════
  info("③ 图纸改动：半套不生效 / 旧基线保持到新基线成功 / 源变了进「影响待查」");
  const designBefore = loadDocument(emptyFx.id, "design", DATA_DIR);
  write(
    path.join(emptyFx.root, ".工作台", "design.md"),
    designText("夹具·空仓 设计书", "\n## 4 新增能力（图纸改动）\n\n- 模块：src（新）\n"),
  );
  const designAfter = loadDocument(emptyFx.id, "design", DATA_DIR);
  const secDiff = diffSections(
    "design",
    { text: designBefore!.text, content_sha256: designBefore!.revision.content_sha256, definition_sha256: designBefore!.revision.definition_sha256 },
    { text: designAfter!.text, content_sha256: designAfter!.revision.content_sha256, definition_sha256: designAfter!.revision.definition_sha256 },
  );
  ok(
    !secDiff.identical && secDiff.changed.some((c) => c.change === "added" && c.path.includes("新增能力")),
    `③ 图纸改动能被定位：新增章节「${secDiff.changed.find((c) => c.change === "added")?.path ?? "?"}」（逐节 delta）`,
  );
  const revDiff = diffRevisionsByHash(
    emptyFx.id,
    "design",
    designBefore!.revision.content_sha256,
    designAfter!.revision.content_sha256,
    DATA_DIR,
  );
  ok(!revDiff.identical && revDiff.after_content_sha256 !== revDiff.before_content_sha256, "③ 两版修订按内容哈希可比（不按时间猜）");
  const entryAfterEdit = evaluateProjectEntry({ project_id: emptyFx.id, role: "coordinator" }, { dataDir: DATA_DIR, now: NOW });
  ok(
    entryAfterEdit.baseline.source_changed_since_baseline === true && entryAfterEdit.baseline.valid === false,
    "③ 源改了但没激活新基线 → 入口报「基线之后源又变过」、valid=false（影响待查，不派新任务）",
  );
  // 施工图一侧按**定义**哈希判（DESIGN §2.9：定义哈希不含派生状态/执行日志，"避免每报一次进度就把基线作废"）
  {
    const tickFx = makeFixture("V0613-TICKONLY", {
      name: "夹具·勾账口径",
      kind: "backend",
      design: designText("夹具·勾账 设计书"),
      plan: planText("夹具·勾账 施工图", [{ id: "T-1", goal: "勾账卡" }]),
    });
    approveBaseline(tickFx, "V06-13 隔离演练：勾账口径夹具审定（执行代理以技术判断代行设计角色）");
    const planFile = path.join(tickFx.root, ".工作台", "plan.md");
    const planKeep = read(planFile);
    // (a) 记录性改动：把卡面检查项打勾（`- [ ]`→`- [x]`）——定义哈希不变，不算源变过
    write(planFile, planKeep.replace("- [ ] T-1 的验收检查项一", "- [x] T-1 的验收检查项一"));
    const entryTickOnly = evaluateProjectEntry({ project_id: tickFx.id, role: "coordinator" }, { dataDir: DATA_DIR, now: NOW });
    ok(
      entryTickOnly.baseline.source_changed_since_baseline === false && entryTickOnly.baseline.valid === true,
      `③ 记录性改动（检查项打勾）**不算**源变过：入口不因此冻结（source_changed=${entryTickOnly.baseline.source_changed_since_baseline}）——DESIGN §2.9「定义哈希不含派生状态/执行日志，避免每报一次进度就把基线作废」`,
    );
    // (b) 定义改动（施工图**表行**：卡号/交付目标/依赖/完成证据）——仍判源变过、入口冻结（不因为"反正只是记录"就放松）
    write(planFile, planKeep.replace("| T-1 | todo | 勾账卡 |  | T-1 的完成证据 |", "| T-1 | todo | 勾账卡（改过口径） |  | T-1 的完成证据 |"));
    const entryDefChanged = evaluateProjectEntry({ project_id: tickFx.id, role: "coordinator" }, { dataDir: DATA_DIR, now: NOW });
    ok(
      entryDefChanged.baseline.source_changed_since_baseline === true && entryDefChanged.baseline.valid === false,
      "③ 定义改动（施工图表行的交付目标）**仍判**源变过、入口冻结（记录性改动免冻结，不等于定义改动也免）",
    );
    write(planFile, planKeep);
  }
  const baseLogBefore = readBaselineLog(emptyFx.id, DATA_DIR).baselines.length;
  const planPath = path.join(emptyFx.root, ".工作台", "plan.md");
  const planBackup = read(planPath);
  fs.renameSync(planPath, `${planPath}.bak`);
  let halfPairRejected = "";
  try {
    activateBaseline(emptyFx.id, { approved_by: "role-x", approval_basis: "半套", approval_kind: "delegated_technical_review" }, DATA_DIR);
  } catch (e) {
    halfPairRejected = (e as Error).message;
  }
  ok(
    halfPairRejected !== "" && readBaselineLog(emptyFx.id, DATA_DIR).baselines.length === baseLogBefore,
    `③ **半套图纸不生效**：只有设计书、施工图缺场 → 拒绝激活且基线流水一条不增（${halfPairRejected.slice(0, 36)}…）`,
  );
  write(planPath, "# 夹具·空仓 施工图\n\n> 夹具：这张施工图故意没有任务表。\n");
  let badPlanRejected = "";
  try {
    activateBaseline(emptyFx.id, { approved_by: "role-x", approval_basis: "坏图纸", approval_kind: "delegated_technical_review" }, DATA_DIR);
  } catch (e) {
    badPlanRejected = (e as Error).message;
  }
  ok(
    badPlanRejected !== "" && readBaselineLog(emptyFx.id, DATA_DIR).baselines.length === baseLogBefore,
    "③ 坏施工图（没有任务表）不生效，旧基线继续有效（一个字节都没写）",
  );
  write(planPath, planBackup);
  const activeBeforeNew = activeBaseline(emptyFx.id, DATA_DIR);
  ok(activeBeforeNew?.baseline_id === emptyBaseline, "③ 新基线成功之前，现行基线仍是原来那条（不半途换基准）");
  const newActivation = activateBaseline(
    emptyFx.id,
    { approved_by: "role-x", approval_basis: "V06-13：改图后重新审定", approval_kind: "delegated_technical_review" },
    DATA_DIR,
  );
  const baseLogAfter = readBaselineLog(emptyFx.id, DATA_DIR);
  ok(
    newActivation.created && baseLogAfter.baselines.length === baseLogBefore + 1,
    `③ 配套图纸齐了才激活成功：基线流水 ${baseLogBefore} → ${baseLogAfter.baselines.length} 条（只追加）`,
  );
  ok(
    activeBaseline(emptyFx.id, DATA_DIR)?.baseline_id === newActivation.baseline.baseline_id &&
      newActivation.baseline.supersedes === emptyBaseline,
    "③ 新基线取代旧基线（supersedes 记明是谁被替代，旧记录不被删改）",
  );
  const entryAfterActivate = evaluateProjectEntry({ project_id: emptyFx.id, role: "coordinator" }, { dataDir: DATA_DIR, now: NOW });
  ok(
    entryAfterActivate.baseline.valid === true &&
      entryAfterActivate.baseline.active?.baseline_id === newActivation.baseline.baseline_id,
    "③ 激活新基线后入口恢复「可干活」（valid=true 且指向新基线）",
  );

  // ═══════════════ ④ 聊天与任务关联 ═══════════════
  info("④ 聊天与任务关联：动作认得出、落在同一份事实、幂等不重复产生效果");
  const actionsBefore = readChatActions(emptyFx.id, DATA_DIR).actions.length;
  const chat1 = await runChatAction(
    { projectId: emptyFx.id, sessionId: "s1", text: "我想加一个 CSV 导入选项" },
    { dataDir: DATA_DIR, now: () => NOW },
  );
  ok(
    chat1.action.kind === "discussion" && chat1.action.status === "saved" && chat1.action.result_ref?.kind === "discussion_draft",
    `④ 自然表达认出动作：kind=${chat1.action.kind}、status=${chat1.action.status}、草稿落盘`,
  );
  ok(
    !fs.existsSync(path.join(emptyFx.root, ".工作台", "baselines.jsonl")) ||
      readBaselineLog(emptyFx.id, DATA_DIR).baselines.length === baseLogBefore + 1,
    "④ 讨论**不激活任何基线**（日常讨论保存为草稿 §3.5）",
  );
  const chat1again = await runChatAction(
    { projectId: emptyFx.id, sessionId: "s1", text: "我想加一个 CSV 导入选项" },
    { dataDir: DATA_DIR, now: () => NOW },
  );
  ok(
    chat1again.deduplicated === true &&
      chat1again.action.action_id === chat1.action.action_id &&
      readChatActions(emptyFx.id, DATA_DIR).actions.length === actionsBefore + 1,
    "④ 同一句话重复发送 → 幂等命中，返回同一份动作、不产生第二次效果（§11.8 重复上报）",
  );
  const chat2 = await runChatAction(
    {
      projectId: emptyFx.id,
      sessionId: "s1",
      text: "这里不对，这张卡的验收场景还缺一条",
      selection: { kind: "task", id: "T-1" },
    },
    { dataDir: DATA_DIR, now: () => NOW },
  );
  ok(
    chat2.action.kind === "locate_feedback" && chat2.action.affected_ids.includes("task:T-1"),
    `④ 定位反馈与任务关联：affected_ids=${JSON.stringify(chat2.action.affected_ids)}（就是投影里的同一个任务 id）`,
  );
  const changesFile = path.join(emptyFx.workDir, "chat-changes.jsonl");
  const changeRec = fs.existsSync(changesFile)
    ? (JSON.parse(read(changesFile).trim().split(/\r?\n/).pop() ?? "{}") as Record<string, unknown>)
    : {};
  ok(
    changeRec.scope === "local" && changeRec.status === "open" && JSON.stringify(changeRec.target).includes("T-1"),
    "④ 一次不满只登记成本地变更/问题（scope=local，不判整个项目失败 §3.6）",
  );
  const chat3 = await runChatAction(
    {
      projectId: emptyFx.id,
      sessionId: "s1",
      text: "按定版图纸更新图",
      selection: { kind: "task", id: "T-1" },
    },
    { dataDir: DATA_DIR, now: () => NOW },
  );
  const bpReceipt = chat3.action.tool_receipts.find((r) => r.tool === "blueprint");
  ok(
    chat3.action.kind === "blueprint_update" && chat3.action.status === "applied" && bpReceipt?.ok === true && bpReceipt?.write === true,
    "④ 「更新图」走的是**真派生**（零模型、真写盘）→ applied 由回执决定，前端不猜",
  );
  ok(
    chat3.action.affected_ids.some((id) => id.startsWith("plan:")) || chat3.action.affected_ids.includes("T-1"),
    `④ 动作↔图关联：affected_ids 带上了图的稳定对象 id（${JSON.stringify(chat3.action.affected_ids.slice(0, 3))}…）`,
  );
  const defIds = importTaskDefinitions(read(planPath)).definitions.map((d) => d.task_id);
  const projAfterChat = projectFromFacts(emptyFx.id, DATA_DIR);
  ok(
    defIds.includes("T-1") &&
      projAfterChat.projection.by_id["T-1"] !== undefined &&
      chat2.action.affected_ids.includes("task:T-1"),
    "④ **同一任务三处同源**：施工定义（plan.md 卡号）、状态投影（object_id）、聊天动作（task:T-1）指的是同一个 id",
  );

  // ═══════════════ ⑤ 双 Agent 认领 ═══════════════
  info("⑤ 双 Agent 认领：冲突明确拒绝、依赖未释放不放行、无证据不收、别人的 token 不认");
  const claimFx = makeFixture("V0613-CLAIM", {
    name: "夹具·双执行者",
    kind: "backend",
    design: designText("夹具·双执行者 设计书"),
    plan: planText("夹具·双执行者 施工图", [
      { id: "T-1", goal: "前置卡" },
      { id: "T-2", goal: "依赖卡", dep: "T-1" },
      { id: "T-3", goal: "无依赖的第二张卡" },
    ]),
  });
  approveBaseline(claimFx, "V06-13 隔离演练：双执行者夹具（技术判断代行设计角色）");
  submitDefinitionImports(service, {
    project_id: claimFx.id,
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    definitions: claimFx.defs,
  });
  const claimA = await claimTask(
    { project_id: claimFx.id, task_id: "T-1", role: "coordinator", owner_id: "agent-a", change_id: CHG },
    submitter,
    DATA_DIR,
  );
  const claimB = await claimTask(
    { project_id: claimFx.id, task_id: "T-1", role: "coordinator", owner_id: "agent-b", change_id: CHG },
    submitter,
    DATA_DIR,
  );
  ok(claimA.ok, "⑤ 执行者 A 领到 T-1（第一次认领成功）");
  ok(
    claimB.ok === false && claimB.code === "CLAIM_HELD" && claimB.current_revision !== null && claimB.read_again !== "",
    `⑤ 执行者 B 领同一张卡 → **明确拒绝**（${claimB.ok === false ? claimB.code : "-"}；给了当前版本 ${claimB.ok === false ? claimB.current_revision : "-"} 与重新读状态的入口）`,
  );
  const claimDep = await claimTask(
    { project_id: claimFx.id, task_id: "T-2", role: "coordinator", owner_id: "agent-b", change_id: CHG },
    submitter,
    DATA_DIR,
  );
  ok(
    claimDep.ok === false && claimDep.code === "DEPENDENCY_UNMET" && claimDep.failures.length > 0,
    `⑤ 依赖未释放的卡不放行（${claimDep.ok === false ? claimDep.code : "-"}：${claimDep.ok === false ? claimDep.failures[0].slice(0, 46) : ""}…）`,
  );
  const tokenA = claimA.ok ? claimA.claim.claim_token : "";
  const wrongToken = await submitTaskResult(
    {
      project_id: claimFx.id,
      task_id: "T-1",
      role: "executor",
      owner_id: "agent-b",
      change_id: CHG,
      claim_token: "not-my-token",
      expected_revision: 2,
      deliverables: ["x"],
      evidence_refs: ["e".repeat(64)],
    },
    { submitter },
    DATA_DIR,
  );
  ok(
    wrongToken.ok === false && wrongToken.failures.some((f) => f.includes("认领 token")),
    `⑤ 别人的 token / 别人的持有者一律不认（${wrongToken.ok === false ? wrongToken.code : "-"}：${wrongToken.ok === false ? wrongToken.failures[0].slice(0, 40) : ""}…）`,
  );
  const noEvidence = await submitTaskResult(
    {
      project_id: claimFx.id,
      task_id: "T-1",
      role: "executor",
      owner_id: "agent-a",
      change_id: CHG,
      claim_token: tokenA,
      expected_revision: 2,
      deliverables: ["src/t1.ts 的实现"],
      evidence_refs: [],
    },
    { submitter },
    DATA_DIR,
  );
  ok(
    noEvidence.ok === false && noEvidence.code === "EVIDENCE_MISSING",
    `⑤ **无证据的"完成"不收**（${noEvidence.ok === false ? noEvidence.code : "-"}：${noEvidence.ok === false ? noEvidence.failures[0].slice(0, 44) : ""}…）`,
  );
  const ev = putEvidence(claimFx.workDir, {
    content: "夹具：T-1 的实现自检输出\nexit 0\n",
    kind: "self_check",
    summary: "T-1 实现自检（夹具）",
    created_by: "agent-a",
    role: "executor",
    binding: { revision_kind: "code", revision: "code-rev-1" },
    occurred_at: NOW,
  });
  const submitted = await submitTaskResult(
    {
      project_id: claimFx.id,
      task_id: "T-1",
      role: "executor",
      owner_id: "agent-a",
      change_id: CHG,
      claim_token: tokenA,
      expected_revision: 2,
      deliverables: ["src/t1.ts 的实现"],
      evidence_refs: [ev.evidence_id],
      verification: [{ command: "pnpm test t1", exit_code: 0 }],
      untested: [],
      known_issues: [],
      result_revision: "code-rev-1",
    },
    { submitter },
    DATA_DIR,
  );
  ok(
    submitted.ok && submitted.rechecks.claim !== "" && submitted.rechecks.evidence !== "",
    `⑤ 带证据的交付被接收（五查回执：claim/lease/evidence 逐项有结论）`,
  );
  ok(
    submitted.ok && submitted.next_action === null && submitted.next_reasons.length === 0,
    "⑤ 调用方没注入「读下一动作」的 reader → 如实返回 next_action=null（不假装已经派了下一张卡）",
  );
  const claimDependent = await claimTask(
    { project_id: claimFx.id, task_id: "T-2", role: "coordinator", owner_id: "agent-a", change_id: CHG },
    submitter,
    DATA_DIR,
  );
  ok(
    claimDependent.ok === false && claimDependent.code === "DEPENDENCY_UNMET",
    `⑤ 前置"交了结果但没达标"仍不放行依赖卡（${claimDependent.ok === false ? claimDependent.failures[0].slice(0, 44) : ""}…）——不看前卡自报 done`,
  );
  // 租约到期：没有核实依据不重派；给了依据才允许接手，并带出旧认领现场
  const leaseClaim = await claimTask(
    { project_id: claimFx.id, task_id: "T-3", role: "coordinator", owner_id: "agent-a", change_id: CHG, lease_ms: 1, now: NOW },
    submitter,
    DATA_DIR,
  );
  const lateNoBasis = await claimTask(
    {
      project_id: claimFx.id,
      task_id: "T-3",
      role: "coordinator",
      owner_id: "agent-b",
      change_id: CHG,
      now: new Date(Date.parse(NOW) + 10_000).toISOString(),
    },
    submitter,
    DATA_DIR,
  );
  ok(
    leaseClaim.ok && lateNoBasis.ok === false && lateNoBasis.code === "LEASE_NEEDS_VERIFICATION",
    `⑤ 租约到期但没给核实依据 → 拒绝重派（${lateNoBasis.ok === false ? lateNoBasis.code : "-"}：不默认旧进程已停止 §2.7）`,
  );
  const takeover = await claimTask(
    {
      project_id: claimFx.id,
      task_id: "T-3",
      role: "coordinator",
      owner_id: "agent-b",
      change_id: CHG,
      now: new Date(Date.parse(NOW) + 10_000).toISOString(),
      takeover_basis: "夹具：已隔离新工作目录，且确认旧认领失效",
    },
    submitter,
    DATA_DIR,
  );
  ok(
    takeover.ok && takeover.previous !== null && takeover.claim.owner_id === "agent-b",
    "⑤ 给出核实依据后允许接手，并**如实带出旧认领现场**（previous 非空，事后可追溯）",
  );
  const entryB = evaluateProjectEntry({ project_id: claimFx.id, role: "coordinator" }, { dataDir: DATA_DIR, now: NOW });
  ok(
    entryB.current_runs.some((r) => r.task_id === "T-3" && r.owner_id === "agent-b"),
    `⑤ 换执行者后从项目入口看得见"谁现在持有哪张卡"（current_runs 里有 ${entryB.current_runs.map((r) => r.task_id).join("、") || "无"}）`,
  );
  ok(
    entryB.next_action !== undefined && entryB.reasons.length > 0 && entryB.required_reads.length > 0,
    `⑤ 入口同时给出下一动作（${entryB.next_action}）、依据与必读清单（换会话接续不用人复述）`,
  );

  // ═══════════════ ⑥ 旧证据失效 ═══════════════
  info("⑥ 旧证据失效：源修订一变，旧绿转待验证、旧结论保留；只重验受影响对象");
  // 真实源码：T-1 的检查覆盖 `src/t1.ts`（清单里声明的有限范围），`src/t2.ts` 故意**不进**清单（无关文件）。
  const T1_REL = "src/t1.ts";
  const T2_REL = "src/t2.ts";
  const T1_SRC_A = "export const t1 = 'A';\n";
  const T1_SRC_B = "export const t1 = 'B';\n";
  const T2_SRC_A = "export const t2 = 'a';\n";
  const T2_SRC_B = "export const t2 = 'b';\n";
  const staleFx = makeFixture("V0613-STALE", {
    name: "夹具·旧证据失效",
    kind: "backend",
    design: designText("夹具·旧证据失效 设计书"),
    plan: planText("夹具·旧证据失效 施工图", [
      { id: "T-1", goal: "先绿后失效的卡" },
      { id: "T-2", goal: "另一张不受影响的卡" },
    ]),
    code: { [T1_REL]: T1_SRC_A, [T2_REL]: T2_SRC_A },
  });
  approveBaseline(staleFx, "V06-13 隔离演练：旧证据失效夹具（技术判断代行设计角色）");
  submitDefinitionImports(service, {
    project_id: staleFx.id,
    change_id: CHG,
    actor_id: "fixture-executor",
    role: "executor",
    definitions: staleFx.defs,
  });
  const REV_A = "code-rev-A";
  for (const taskId of ["T-1", "T-2"]) {
    const def = staleFx.defs.find((d) => d.task_id === taskId)!;
    const bound = { definition_sha256: taskDefinitionHash(def), plan_revision: def.plan_revision ?? "" };
    submitTaskStatus(submitter, {
      project_id: staleFx.id, task_id: taskId, change_id: CHG, actor_id: "fixture-executor", role: "executor",
      expected_revision: 1, status: "executing", definition: bound,
    });
    submitStatusOnly(submitter, {
      project_id: staleFx.id, task_id: taskId, change_id: CHG, actor_id: "fixture-executor", role: "executor",
      expected_revision: 2, status: "result_submitted", definition: bound,
    });
    submitSubmission(submitter, {
      record_id: `sub-${taskId}`, project_id: staleFx.id, change_id: CHG, actor_id: "fixture-executor", role: "executor",
      goal: `${taskId} 的交付（夹具）`, task_id: taskId, changed_files: [], commands: [], untested: [], known_issues: [],
      evidence_refs: [], binding: { revision_kind: "code", revision: REV_A },
      submitted_by: "fixture-executor", occurred_at: `${NOW.slice(0, 10)}T09:00:00.000Z`,
    });
  }
  // 负控：说通过但没给证据哈希 → 不算通过（旧绿不能靠"我说过了"成立）
  const effNoEvidence = checkEffectiveness(
    {
      check_id: "T-1::check:0", object_id: "T-1", result: "passed", actor_id: "fixture-auditor", role: "auditor",
      independence: "independent", binding: { revision_kind: "code", revision: REV_A }, evidence_sha256: null, at: NOW,
    },
    { code: REV_A },
    new Set(["fixture-executor"]),
  );
  ok(
    effNoEvidence.effective === "unknown" && effNoEvidence.why.includes("没证据"),
    `⑥ 负控：说通过但没给证据哈希 → effective=${effNoEvidence.effective}（不默认通过）`,
  );
  // 真实源清单：产品**现读** tmp 源码算哈希与指纹（不拿自报修订当来源），落到不可变证据载体。
  const t1ManifestA = buildSourceManifest(staleFx.root, [T1_REL]);
  const staleEv = putEvidence(staleFx.workDir, {
    content: "夹具：独立审计的复现记录（T-1）\n",
    kind: "source_manifest",
    summary: "T-1 独立审计证据（夹具）：覆盖源清单",
    created_by: "fixture-auditor",
    role: "auditor",
    binding: { revision_kind: "code", revision: t1ManifestA.fingerprint },
    source_manifest: [T1_REL],
    occurred_at: NOW,
  });
  // 按投影点名的缺口逐项补独立审计（每一轮都真为它列出的 check_id 出独立记录，最多 3 轮）
  let p1 = projectFromFacts(staleFx.id, DATA_DIR).projection.by_id["T-1"];
  let rounds = 0;
  while (p1 !== undefined && p1.display_status !== "verified" && p1.missing.length > 0 && rounds < 3) {
    rounds++;
    submitIndependentAudit(submitter, {
      record_id: `audit-T-1-r${rounds}`,
      project_id: staleFx.id,
      change_id: CHG,
      actor_id: "fixture-auditor",
      role: "auditor",
      task_id: "T-1",
      auditor: "fixture-auditor",
      auditor_role: "auditor",
      author_id: "fixture-executor",
      same_session_as_author: false,
      read_author_summary_first: true,
      checks: p1.missing.map((m) => ({ check_id: m.check_id, result: "passed" as const, evidence_sha256: staleEv.evidence_id })),
      coverage: FILE_SCOPE_5,
      conclusion: "pass",
      not_reported_scope: ["夹具未覆盖的并发场景"],
      method_limits: ["夹具：单机串行"],
      binding: { revision_kind: "code", revision: t1ManifestA.fingerprint },
      occurred_at: NOW,
    });
    p1 = projectFromFacts(staleFx.id, DATA_DIR).projection.by_id["T-1"];
  }
  ok(
    p1?.display_status === "verified" && rounds <= 2,
    `⑥ 必需项由**独立审计**逐项通过 → T-1 判绿（display=${p1?.display_status}，补了 ${rounds} 轮；作者自检不算独立 §5.5）`,
  );
  ok(p1?.quality === "audit_passed", `⑥ 质量维度是 ${p1?.quality}（独立审计档，不是只有自检那一档）`);
  // 负例①：**仅自报**一个 code 修订（不碰真实源）不得当源变证据——当前代码版本仍未知、旧绿不因此失效
  submitSubmission(submitter, {
    record_id: "sub-T-1-selfreport-b", project_id: staleFx.id, change_id: CHG, actor_id: "fixture-executor", role: "executor",
    goal: "T-1 自报改了代码（未改真实源）", task_id: "T-1", changed_files: [], commands: [], untested: [], known_issues: [],
    evidence_refs: [], binding: { revision_kind: "code", revision: "code-rev-B" },
    submitted_by: "fixture-executor", occurred_at: `${NOW.slice(0, 10)}T09:30:00.000Z`,
  });
  const pSelfReport = projectFromFacts(staleFx.id, DATA_DIR);
  ok(
    pSelfReport.facts.revisions.code === null && pSelfReport.facts.revisions.code_declared === "code-rev-B" &&
      pSelfReport.projection.by_id["T-1"]?.display_status === "verified",
    `⑥ 负例：**仅自报** code-rev-B 不构成源变证据（current code=${pSelfReport.facts.revisions.code}；自报值 code_declared=${pSelfReport.facts.revisions.code_declared} 只作展示；T-1 仍 ${pSelfReport.projection.by_id["T-1"]?.display_status}）`,
  );
  // 负例②：**不被清单覆盖**的无关文件变了不连坐（清单只声明 T1_REL 这条有限范围）
  write(path.join(staleFx.root, T2_REL), T2_SRC_B);
  const pUnrelated = projectFromFacts(staleFx.id, DATA_DIR);
  const t1Unrelated = pUnrelated.projection.by_id["T-1"];
  ok(
    t1Unrelated?.freshness === "fresh" && t1Unrelated?.display_status === "verified",
    `⑥ 负例：无关文件（不被清单覆盖的 ${T2_REL}）改变**不连坐**：T-1 freshness=${t1Unrelated?.freshness}、仍 ${t1Unrelated?.display_status}（清单是有界覆盖范围）`,
  );
  // 负例③：无效清单要拒绝（编造哈希 / kind 与清单不配）
  let badManifestRejected = "";
  try {
    buildSourceManifest(staleFx.root, [{ path: T1_REL, sha256: "0".repeat(64) }]);
  } catch (e) {
    badManifestRejected = (e as Error).message;
  }
  let badEvidenceRejected = "";
  try {
    putEvidence(staleFx.workDir, {
      content: "夹具：kind 与清单不配\n", kind: "self_check", summary: "夹具：无效载体",
      created_by: "fixture-auditor", role: "auditor",
      binding: { revision_kind: "code", revision: t1ManifestA.fingerprint }, source_manifest: [T1_REL],
    });
  } catch (e) {
    badEvidenceRejected = (e as Error).message;
  }
  ok(
    badManifestRejected.includes("哈希与当前文件内容不符") && badEvidenceRejected.includes("kind 必须是 source_manifest"),
    `⑥ 负例：**无效清单被拒**——编造哈希（${badManifestRejected.slice(0, 22)}…）；kind 与清单不配（${badEvidenceRejected.slice(0, 22)}…）`,
  );
  // 正题：**真改**被清单覆盖的源（${T1_REL}：A → B，不再上报任何事件）→ 旧的独立审计绿转待验证
  write(path.join(staleFx.root, T1_REL), T1_SRC_B);
  const p2 = projectFromFacts(staleFx.id, DATA_DIR);
  const t1After = p2.projection.by_id["T-1"];
  ok(
    p2.facts.revisions.code === null && t1After?.freshness === "verification_stale",
    `⑥ 真改覆盖源 ${T1_REL}（A→B）、current 代码版本仍未知（${p2.facts.revisions.code}）→ T-1 freshness=${t1After?.freshness}（清单现读复核判失效）`,
  );
  ok(
    t1After?.display_status === "pending_verification" && t1After?.quality === "evidence_invalid",
    `⑥ **旧绿不再显示为已验证**（display=${t1After?.display_status}、quality=${t1After?.quality}）`,
  );
  ok(
    (t1After?.history.length ?? 0) >= 1 && t1After?.history[0].bound_revision === t1ManifestA.fingerprint,
    `⑥ 旧结论**保留在历史里**（${t1After?.history.length} 条，绑定清单指纹 ${String(t1After?.history[0]?.bound_revision ?? "").slice(0, 12)}…）——不因转待验证而消失`,
  );
  ok(
    (t1After?.reasons ?? []).some((r) => r.code === "evidence_stale") && (t1After?.missing_count ?? 0) >= 1,
    `⑥ 原因写清「几项证据的源版本已变」并点名缺项（reasons=${(t1After?.reasons ?? []).map((r) => r.code).join("、")}）`,
  );
  ok(
    (t1After?.recheck_scope.length ?? 0) === 0,
    "⑥ 只读路径没人声明「受影响范围」时 recheck_scope 为空（不凭猜圈重验范围；显式声明时才给，见下两条）",
  );
  // 只重验受影响对象（对象各自绑定自己的源修订）
  const scopedObjects: StatusObjectInput[] = [
    {
      object_id: "S-1", object_kind: "task", label: "受影响对象",
      executions: [{ task_id: "S-1", status: "result_submitted", actor_id: "a", updated_at: NOW }],
      required_checks: [{ check_id: "S-1::c", label: "c" }],
      revisions: { code: "code-rev-B" },
    },
    {
      object_id: "S-2", object_kind: "task", label: "不受影响对象",
      executions: [{ task_id: "S-2", status: "result_submitted", actor_id: "a", updated_at: NOW }],
      required_checks: [{ check_id: "S-2::c", label: "c" }],
      revisions: { code: "code-rev-A" },
    },
  ];
  const scopedChecks: CheckInput[] = [
    {
      check_id: "S-1::c", object_id: "S-1", result: "passed", actor_id: "aud", role: "auditor",
      independence: "independent", binding: { revision_kind: "code", revision: "code-rev-A" },
      evidence_sha256: "e".repeat(64), at: NOW,
    },
    {
      check_id: "S-2::c", object_id: "S-2", result: "passed", actor_id: "aud", role: "auditor",
      independence: "independent", binding: { revision_kind: "code", revision: "code-rev-A" },
      evidence_sha256: "f".repeat(64), at: NOW,
    },
  ];
  const scoped = projectStatuses({
    objects: scopedObjects,
    findings: [],
    checks: scopedChecks,
    changes: [{ change_id: "chg-1", revision_kind: "code", from: "code-rev-A", to: "code-rev-B", affected: ["S-1"] }],
  });
  ok(
    scoped.by_id["S-1"].freshness === "verification_stale" && scoped.by_id["S-1"].recheck_scope.includes("S-1"),
    `⑥ 受影响对象进重验范围（S-1 freshness=${scoped.by_id["S-1"].freshness}，recheck_scope=${JSON.stringify(scoped.by_id["S-1"].recheck_scope)}）`,
  );
  ok(
    scoped.by_id["S-2"].freshness === "fresh" &&
      scoped.by_id["S-2"].display_status === "verified" &&
      scoped.by_id["S-2"].recheck_scope.length === 0,
    `⑥ 不受影响对象保持原状态（S-2 freshness=${scoped.by_id["S-2"].freshness}、display=${scoped.by_id["S-2"].display_status}）`,
  );

  // ═══════════════ ⑦ Git 提醒 ═══════════════
  info("⑦ Git 提醒：只读探测 / 无上游不写「已同步」 / 代码提交 ≠ 私有事实已备份");
  const gitFx = makeFixture("V0613-GIT", {
    name: "夹具·Git 提醒",
    kind: "backend",
    design: designText("夹具·Git 提醒 设计书"),
    plan: planText("夹具·Git 提醒 施工图", [{ id: "T-1", goal: "夹具卡" }]),
    code: { "src/index.ts": "export const v = 1;\n" },
    git: true,
  });
  write(path.join(gitFx.root, "src", "index.ts"), "export const v = 2;\n");
  const fpBefore = gitFingerprint(gitFx.root);
  const dirtyProbe = await inspectGitStatus(gitFx.root);
  const dirtyReminder = buildVersionReminder(dirtyProbe, { submissions: [], evidence: [] }, { project_name: "夹具·Git" });
  const fpAfter = gitFingerprint(gitFx.root);
  ok(fpBefore === fpAfter, "⑦ 探测前后 HEAD / 索引登记 / `.git/index` 字节与 mtime / 工作树逐项相同（只读，真没写）");
  ok(
    dirtyProbe.repository.is_repository && (dirtyProbe.modified ?? []).includes("src/index.ts"),
    `⑦ 认出"这批成果还没保存为本地版本"（未暂存 ${(dirtyProbe.modified ?? []).length} 个：${(dirtyProbe.modified ?? []).join("、")}）`,
  );
  ok(
    dirtyReminder.local_commit.state === "unsaved" && dirtyReminder.verification.state === "unverified" &&
      dirtyReminder.verification.label.includes("不是稳定成果"),
    "⑦ 有改动且无对应成果 → 提示未保存 + 未验证（不称为稳定成果）",
  );
  ok(
    dirtyProbe.tracking_observation.state === "no_upstream" &&
      !JSON.stringify(dirtyProbe).includes("已同步") &&
      !JSON.stringify(dirtyReminder).includes("已同步"),
    "⑦ 无上游 → **整份探测与提醒里都不出现「已同步」**（远端不做隐式 fetch/推送）",
  );
  ok(
    dirtyProbe.tracking_observation.fetched === false && dirtyReminder.remote.fetched === false,
    "⑦ 探测与提醒都带 fetched=false（只显示已知跟踪状态与观测时间）",
  );
  gitWrite(gitFx.root, ["add", "--", "src/index.ts"]);
  gitWrite(gitFx.root, ["-c", "user.email=fixture@tatai.local", "-c", "user.name=fixture", "commit", "-qm", "夹具：改了 v"]);
  const cleanProbe = await inspectGitStatus(gitFx.root);
  const cleanReminder = buildVersionReminder(cleanProbe, { submissions: [], evidence: [] }, { project_name: "夹具·Git" });
  ok(
    cleanProbe.private_backup_known.code_committed === true &&
      (cleanProbe.staged ?? []).length === 0 &&
      (cleanProbe.modified ?? []).length === 0,
    "⑦ 本地提交成功后：代码确实保存为本地 Git 版本（工作树干净）",
  );
  ok(
    cleanProbe.private_backup_known.ignored_by_git === true &&
      (cleanProbe.private_backup_known.ignored_file_count ?? 0) >= 2,
    `⑦ 「.工作台/」被 Git 忽略（忽略文件 ${cleanProbe.private_backup_known.ignored_file_count} 个：设计书/施工图/任务都在里面）`,
  );
  ok(
    cleanProbe.private_backup_known.backed_up === "unknown" &&
      cleanProbe.private_backup_known.backup_flow_available === true &&
      cleanReminder.private_facts.backed_up === "unknown",
    "⑦ **代码提交 ≠ 私有事实已备份**：提醒只说「备份状态未知」，不误报已备份（§8.5）——" +
      "本机显式备份/恢复入口**已交付**（V09-06，backup_flow_available=true），但入口可用不等于这一份已经备份过",
  );
  ok(
    cleanReminder.agent_note.includes("塔台**没有**替你执行任何 Git 写操作") &&
      !/(^|\s)git\s+(add|commit|push|fetch|pull)\b/i.test(cleanReminder.agent_note),
    "⑦ 整理说明里明说塔台没有替你执行 Git 写操作，正文不夹带 git 写命令",
  );
  const gitSrc = fs.readFileSync(path.join(REPO, "src", "server", "gitStatus.ts"), "utf8");
  ok(
    /--no-optional-locks/.test(gitSrc) && /GIT_OPTIONAL_LOCKS/.test(gitSrc),
    "⑦ 只读锁双保险在源码里（--no-optional-locks + GIT_OPTIONAL_LOCKS=0；V06-12 的实测结论）",
  );

  // ═══════════════ ⑧ 收尾自证：根文档与既有脚本零改动 / 夹具全在 tmpdir ═══════════════
  info("⑧ 收尾自证");
  let rootDocChanged = 0;
  for (const rel of ROOT_DOCS) {
    const abs = path.join(REPO, rel);
    const now = fs.existsSync(abs) ? sha256File(abs) : "<missing>";
    if (now !== rootDocBefore.get(rel)) {
      rootDocChanged++;
      console.log(`[verify]   FAIL 根文档被改动：${rel}`);
    }
  }
  ok(rootDocChanged === 0, `⑧ 根文档 ${ROOT_DOCS.length} 份首尾哈希逐项相同（DESIGN/PLAN/PROGRESS/AGENTS/README/两份设计史未动）`);
  let scriptChanged = 0;
  for (const [abs, before] of scriptHashesBefore) {
    if (!fs.existsSync(abs) || sha256File(abs) !== before) {
      scriptChanged++;
      console.log(`[verify]   FAIL 既有脚本被改动：${path.relative(REPO, abs)}`);
    }
  }
  ok(scriptChanged === 0, `⑧ 既有 scripts/** ${scriptHashesBefore.size} 份脚本首尾哈希逐项相同（本卡只新增 verify-v06-13.ts）`);
  const selfSrc = read(SELF_FILE);
  // 标记按片段拼接：脚本源码里不出现完整的真实项目路径（否则这条自证自己就红）
  const realProjectMarkers = ["5.0 类脑" + "记忆", "大黄" + "蜂", "货架" + "参谋", "D:/Git" + "hub"];
  const markersInSrc = realProjectMarkers.filter((m) => selfSrc.includes(m));
  ok(
    markersInSrc.length === 0,
    `⑧ 本脚本源码里**不含任何真实项目路径**（命中 ${markersInSrc.join("、") || "无"}）——演练全程只在 os.tmpdir() 夹具上`,
  );
  ok(
    fs.existsSync(TMP) && path.resolve(emptyFx.root).startsWith(path.resolve(TMP) + path.sep),
    "⑧ 本脚本造的全部现场都在自己的临时目录下（收尾整棵删除）",
  );
  ok(
    !fs.existsSync(path.join(gitFx.root, ".工作台", "work", "evidence")),
    "⑧ 夹具的私有状态只落在夹具自己的 `.工作台/` 里（不写注册表以外的真实数据目录）",
  );

  console.log(`\n[verify] V06-13（隔离演练）结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
}

try {
  await main();
} catch (e) {
  console.error(`[verify] 异常：${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
} finally {
  stubServer.close();
  if (process.env.TATAI_KEEP_TMP === "1") {
    info(`保留现场：${TMP}`);
  } else {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}
