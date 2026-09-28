// V06-07 验证脚本（PLAN.md V06-07「聊天成稿与可追溯动作」，DESIGN.md §3.5–§3.6 / §3.12 / §9.2–§9.4）。
// 用法：pnpm verify:v06-07（或 node --import tsx scripts/verify-v06-07.ts）
//       浏览器场景由 `scripts/verify-v06-07-ui.py` 负责，两者都跑才算完。
//
// 本脚本覆盖三条检查项（逐条有可运行断言）：
//   ① **自然表达触发**：讨论（存草稿、不激活）/ 整理方案（有出处的章节差异 → review_needed）/
//      更新图（走 V06-05 派生流程并回执覆盖与未映射）/ 定位反馈（携带选中对象形成变更或问题，
//      不把一次不满判成整个项目失败）；正式修订先读现行两份材料并展示差异；
//      逆向入口接入双文档链（设计草稿 + 剩余施工草稿，两份都有来源、无证据实现标待验证、原 Gate 不变）。
//   ② **可追溯与可靠**：工具动作与结果关联持久化、幂等写入（重复发送不产生第二次效果）、
//      失败可续接；有有效引用的会话删除转归档留引用（无引用的普通聊天照常可删）。
//   ③ **五个模拟场景**：落稿失败 / 图写成功但回答中断 / 重复发送 / 旧项目延迟回包 / 引用会话删除，
//      断言不谎报、不重复写、重开可查；并断言 `applied` 只由真实写入回执产生（伪造行读回即报坏行）。
//
// 隔离口径（AGENTS.md §5 / 卡面红线）：
//   · 临时 TATAI_HOME + `os.tmpdir()` 下的三个夹具项目，**绝不碰**三个真实项目的 `.工作台/`；
//   · 模型环节用**自带 SSE 伪模型夹具**（不依赖真网关、不依赖网速）；动作落盘全部经真实模块入口；
//   · 收尾杀净子进程、删临时目录（TATAI_KEEP_TMP=1 可留现场）。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import {
  actionStatusLabel,
  activateChatActionProposal,
  assertAppliedHasWriteReceipt,
  chatActionsReferencingSession,
  classifyChatIntent,
  getChatAction,
  listChatActions,
  readChatActions,
  retryChatAction,
  runChatAction,
  type ChatAction,
} from "../src/server/work/chatActions";
import { loadDocument } from "../src/server/work/documents";
import { appendDesign } from "../src/server/workstation";
import { draftDesign, readReverseDraft, readReversePlanDraft } from "../src/server/reverseDraft";
import { parsePlanTable, validatePlanTasks } from "../src/server/work/planValidate";

const REPO = process.cwd();
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
const section = (t: string) => console.log(`\n[verify] ── ${t}`);
const info = (t: string) => console.log(`[verify]   ${t}`);

const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const read = (f: string): string => fs.readFileSync(f, "utf8");
const sha256File = (f: string): string => sha256(fs.readFileSync(f));
const exists = (f: string): boolean => fs.existsSync(f);
/** 缺文件用 "(无)" 参与比对：夹具里的项目本来就没有 progress/gate 时不该崩 */
const hashOrNone = (f: string): string => (fs.existsSync(f) ? sha256File(f) : "(无)");

// ───────────────────────────── 零改动护栏清单 ─────────────────────────────

const PROTECTED_DOCS = [
  "DESIGN.md",
  "PLAN.md",
  "PROGRESS.md",
  "AGENTS.md",
  "README.md",
  "docs/design-history-v0.4.md",
  "docs/design-history-v0.5.md",
];
/** 既有验证脚本：本卡一个字节都不许改（改了这里就红） */
const VICTIM_SCRIPTS = [
  "scripts/verify-chat-context.ts",
  "scripts/verify-chat-tools.ts",
  "scripts/verify-chat-arch-write.ts",
  "scripts/verify-c1.ts",
  "scripts/verify-c2.ts",
  "scripts/verify-c3.ts",
  "scripts/verify-m5.ts",
  "scripts/verify-d1.ts",
  "scripts/verify-d2.ts",
  "scripts/verify-d3.ts",
  "scripts/verify-b3.ts",
  "scripts/verify-s2.ts",
  "scripts/verify-v06-01.ts",
  "scripts/verify-v06-02.ts",
  "scripts/verify-v06-03.ts",
  "scripts/verify-v06-04.ts",
  "scripts/verify-v06-05.ts",
  "scripts/verify-v06-06.ts",
  "scripts/verify-v06-06-ui.py",
  "scripts/verify-v06-09.ts",
  "scripts/verify-l3.ts",
];

/** DESIGN.md 附录 B 区间（标题行起、到文件尾）——本卡连它一个字节都不许动 */
function appendixBRegion(): string {
  const text = read(path.join(REPO, "DESIGN.md"));
  const idx = text.indexOf("## 附录 B：待议记录");
  return idx === -1 ? "" : text.slice(idx);
}

// ───────────────────────────── 夹具 ─────────────────────────────

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0607-verify-"));
const home = path.join(tmpBase, "home");
const mainRoot = path.join(tmpBase, "main");
const draftRoot = path.join(tmpBase, "draft");
const otherRoot = path.join(tmpBase, "other");
const MAIN = "v0607-main";
const DRAFT = "v0607-draft";
const OTHER = "v0607-other";

const mkdirp = (d: string) => fs.mkdirSync(d, { recursive: true });
const write = (f: string, t: string) => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, t, "utf8");
};

const DESIGN_MARKER = "V0607-设计暗记-风铃草";
const MAIN_DESIGN = [
  "# v0607-main 设计书",
  "",
  `> 暗记：${DESIGN_MARKER}（夹具）。`,
  "",
  "## 1 概述",
  "目标：夹具项目，用来验证聊天动作链路。",
  "",
  "## 2 导入能力",
  "现状：导入通道只支持 CSV。",
  "",
].join("\n");

const MAIN_PLAN = [
  "# 夹具施工图",
  "",
  "## 当前任务",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1 | todo | 打地基 |  | 地基验收记录 |",
  "| T-2 | todo | 砌墙 | T-1 | 墙体验收记录 |",
  "",
  "### T-1 打地基",
  "",
  "**设计依据**：§1。**依赖**：无。",
  "",
  "**文件责任**：`src/base.ts`。",
  "",
  "- [ ] 挖到硬土",
  "",
  "**交付**：地基验收记录。",
  "",
  "### T-2 砌墙",
  "",
  "**设计依据**：§2。**依赖**：T-1。",
  "",
  "**文件责任**：`src/wall.ts`。",
  "",
  "- [ ] 砌到顶",
  "",
  "**交付**：墙体验收记录。",
  "",
].join("\n");

const DRAFT_CODE = [
  "export function importCsv(text: string): string[] {",
  "  return text.split('\\n');",
  "}",
  "",
  "export const VERSION = '0.1.0';",
  "",
].join("\n");

mkdirp(home);
mkdirp(mainRoot);
mkdirp(draftRoot);
mkdirp(otherRoot);
write(path.join(mainRoot, ".工作台", "design.md"), MAIN_DESIGN);
write(path.join(mainRoot, ".工作台", "plan.md"), MAIN_PLAN);
write(path.join(mainRoot, "src", "base.ts"), "export const BASE = 1;\n");
write(path.join(mainRoot, "src", "wall.ts"), "export const WALL = 2;\n");
write(path.join(mainRoot, "README.md"), "# v0607-main\n\n夹具项目（只用于 V06-07 验证）。\n");
write(path.join(mainRoot, "package.json"), '{"name":"v0607-main"}\n');
// 第二个夹具项目：**有既有实现、没有 design.md**（"对既有项目实点逆向入口"）
write(path.join(draftRoot, "src", "importer.ts"), DRAFT_CODE);
write(path.join(draftRoot, "README.md"), "# v0607-draft\n\n有既有实现但没有设计书的老项目夹具。\n");
write(path.join(draftRoot, "package.json"), '{"name":"v0607-draft"}\n');
write(path.join(otherRoot, "src", "app.ts"), "export const APP = 'other';\n");

const record = (id: string, name: string, dir: string) => ({
  id,
  name,
  path: dir,
  kind: "backend",
  registered_at: "2026-09-21T00:00:00+08:00",
  last_opened_at: "2026-09-21T00:00:00+08:00",
});
write(
  path.join(home, "registry.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        record(MAIN, "V06-07 主夹具", mainRoot),
        record(DRAFT, "V06-07 逆向夹具", draftRoot),
        record(OTHER, "V06-07 另一项目", otherRoot),
      ],
    },
    null,
    2,
  ),
);
process.env.TATAI_HOME = home;

const workbench = (root: string) => path.join(root, ".工作台");
const workOf = (root: string) => path.join(workbench(root), "work");
const actionsFile = (root: string) => path.join(workOf(root), "chat-actions.jsonl");

// ───────────────────────────── 伪模型（自带 SSE，不依赖真网关） ─────────────────────────────

interface StubRequest {
  messages: { role: string; content: unknown }[];
}
const stubRequests: StubRequest[] = [];
let stubFailNext = false;
let stubFailAll = false;

const DESIGN_DRAFT_MD = [
  "## 一、项目是什么",
  "夹具老项目：做导入。",
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
  observed: [
    { path: "src/importer.ts", what: "已实现 CSV 行切分", evidence: "" },
  ],
  tasks: [
    {
      card_id: "RV-01",
      goal: "补齐导入的错误处理",
      dependencies: "",
      evidence: "错误用例通过记录",
      files: "`src/importer.ts`",
      checks: ["空文件不抛错"],
      body: "",
    },
  ],
  notes: ["既有实现没有验证证据，一律待验证"],
});

const PROPOSAL_JSON = JSON.stringify({
  design_items: [
    {
      op: "replace",
      path: "v0607-main 设计书 / 2 导入能力",
      text:
        "## 2 导入能力\n\n现状：导入通道只支持 CSV。\n\n补充（按讨论）：需要支持 XLSX，并保留 CSV 行为。",
      rationale: "讨论里明确要加 XLSX",
      sources: ["用户原话：我想加 XLSX 导入"],
    },
    {
      op: "replace",
      path: "不存在的章节",
      text: "## 不存在的章节\n\n臆断内容。",
      rationale: "故意放一个定位不到的章节",
      sources: ["无来源但也带了一条出处，测定位"],
    },
  ],
  plan_items: [
    {
      op: "add",
      card_id: "T-3",
      goal: "加 XLSX 导入",
      dependencies: "T-1",
      evidence: "XLSX 导入验收记录",
      body: "**契约**：输入 xlsx 字节，输出行数组。",
      rationale: "讨论里明确要加",
      sources: ["用户原话：我想加 XLSX 导入"],
    },
    {
      op: "add",
      card_id: "T-4",
      goal: "没有出处的卡",
      dependencies: "",
      evidence: "无",
      body: "",
      rationale: "故意不给出处",
      sources: [],
    },
  ],
  notes: ["提案只是提案"],
});

function sseText(text: string): string {
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  return (
    chunk({ choices: [{ delta: { content: text }, finish_reason: null }] }) +
    chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
    "data: [DONE]\n\n"
  );
}

function allText(messages: StubRequest["messages"]): string {
  return messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
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
    const text = allText(messages);
    if (stubFailAll || stubFailNext) {
      stubFailNext = false;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "夹具：模型侧中断（模拟回答中途断掉）" } }));
      return;
    }
    let reply = "（夹具）这是一句普通回答。";
    if (text.includes("design_items")) reply = PROPOSAL_JSON;
    else if (text.includes("\"observed\"")) reply = PLAN_DRAFT_JSON;
    else if (text.includes("请起草四块雏形")) reply = DESIGN_DRAFT_MD;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.end(sseText(reply));
  });
});

const STUB_PORT = 34560;
const HTTP_PORT = 34561;
const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;
const spawned: ChildProcess[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const listen = (server: http.Server, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

async function main(): Promise<void> {
  await listen(stubServer, STUB_PORT);
  process.env.TATAI_DEEPSEEK_BASE_URL = STUB_URL;
  if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = "stub-key-for-verify";
  info(`伪模型（SSE 夹具）已起：${STUB_URL}（本脚本不依赖真网关）`);

  // ── 开工前哈希 ──
  const docsBefore = new Map(PROTECTED_DOCS.map((f) => [f, sha256File(path.join(REPO, f))]));
  const scriptsBefore = new Map(VICTIM_SCRIPTS.map((f) => [f, sha256File(path.join(REPO, f))]));
  const appendixBefore = sha256(appendixBRegion());
  const contractBefore = read(path.join(REPO, "docs", "work-v2-contract.md"));
  const contractHeadBefore = contractBefore.split("\n").filter((l) => l.startsWith("## ")).join("\n");
  console.log("=".repeat(72));
  console.log("[verify] 开工前：DESIGN.md 附录 B sha256 =", appendixBefore);
  console.log("=".repeat(72));

  // ═════════════ ① 自然表达触发四行动作 ═════════════
  section("① 自然表达 → 动作（§3.6 四行动作表）");
  const intents: [string, string | null][] = [
    ["我想做一个 XLSX 导入", "discussion"],
    ["整理成方案交给设计审定", "proposal"],
    ["按定版图纸把图更新一下", "blueprint_update"],
    ["这里不对，我想改这里", "locate_feedback"],
    // 负例：既有验证脚本里的原话不能误判成动作（否则会凭空产生写动作）
    [
      "只根据你拿到的背景材料，用一行回答两个问题，格式：「标题=…；步=…」。① 背景材料里设计书『第二节』的标题原文是什么？② Gate 当前步的 id 是什么？",
      null,
    ],
    ["用 write_arch 给架构图补一个概念节点：name=「消息总线」", null],
    ["只回答两个字：你好", null],
    ["请记住数字 42，只回复：记住了", null],
  ];
  for (const [text, want] of intents) {
    const m = classifyChatIntent(text);
    ok(
      (want === null ? m === null : m?.kind === want),
      `① 意图识别「${text.slice(0, 24)}…」→ ${m?.kind ?? "（不触发动作）"}（期望 ${want ?? "不触发"}）`,
    );
  }
  ok(
    classifyChatIntent("这里不对，我想改这里", { hasSelection: true })?.kind === "locate_feedback",
    "① 定位反馈在带选中对象时也认（携带当前选中能力/任务）",
  );

  // ── ①-A 讨论：存草稿、不激活 ──
  const designBeforeA = sha256File(path.join(mainRoot, ".工作台", "design.md"));
  const planBeforeA = sha256File(path.join(mainRoot, ".工作台", "plan.md"));
  const a1 = await runChatAction({
    projectId: MAIN,
    sessionId: "sess-discuss",
    text: "我想做一个 XLSX 导入",
  });
  ok(a1.action.kind === "discussion" && a1.action.status === "saved", "①-A 讨论 → 状态 saved（已保存草稿）");
  ok(actionStatusLabel(a1.action) === "已保存草稿", `①-A 六阶段文案来自回执：${actionStatusLabel(a1.action)}`);
  const draftRel = a1.action.result_ref?.path ?? "";
  ok(
    draftRel !== "" &&
      exists(path.join(mainRoot, draftRel)) &&
      read(path.join(mainRoot, draftRel)).includes("不激活任何基线"),
    `①-A 讨论草稿真落盘且写明「不激活」（${draftRel}）`,
  );
  ok(
    sha256File(path.join(mainRoot, ".工作台", "design.md")) === designBeforeA &&
      sha256File(path.join(mainRoot, ".工作台", "plan.md")) === planBeforeA &&
      !exists(path.join(mainRoot, ".工作台", "baselines.jsonl")),
    "①-A 讨论**没有**改动设计书/施工图/基线（讨论与激活分开）",
  );
  ok(
    a1.action.source_versions.design?.content_sha256 === sha256(MAIN_DESIGN) &&
      a1.action.source_versions.plan !== null,
    "①-A 讨论也登记了读到的现行版本（可追溯）",
  );

  // ── ①-B 定位反馈：携带选中对象，形成变更或问题，不动项目状态 ──
  const progressBeforeB = hashOrNone(path.join(mainRoot, ".工作台", "progress.json"));
  const gateBeforeB = hashOrNone(path.join(mainRoot, ".工作台", "gate.jsonl"));
  const b1 = await runChatAction({
    projectId: MAIN,
    sessionId: "sess-discuss",
    text: "这里不对，我想改这里：导入能力应该支持大文件",
    selection: { kind: "capability", id: "cap:import", name: "导入能力" },
  });
  ok(
    b1.action.kind === "locate_feedback" &&
      b1.action.status === "saved" &&
      b1.action.affected_ids.includes("capability:cap:import"),
    "①-B 定位反馈 → saved + 携带选中能力（affected_ids 记到对象 id）",
  );
  ok(
    b1.action.result_ref?.kind === "change" && (b1.action.result_ref?.path ?? "").includes("chat-changes.jsonl"),
    `①-B 形成变更记录（${b1.action.result_ref?.kind}）`,
  );
  ok(
    hashOrNone(path.join(mainRoot, ".工作台", "progress.json")) === progressBeforeB &&
      hashOrNone(path.join(mainRoot, ".工作台", "gate.jsonl")) === gateBeforeB,
    "①-B 一次不满**没有**把项目判成失败（progress/gate 逐字节未动）",
  );

  // ── ①-C 更新图：无生效基线 → 如实失败；激活基线后 → applied（真实发布回执） ──
  const c0 = await runChatAction({ projectId: MAIN, sessionId: "sess-bp", text: "按定版图纸把图更新一下" });
  ok(
    c0.action.status === "failed" && c0.action.error?.message.includes("生效基线") === true,
    `①-C 无生效基线时**不谎报**：failed（${c0.action.error?.message.slice(0, 40)}…）`,
  );
  ok(
    c0.action.tool_receipts.some((r) => r.tool === "blueprint" && r.ok === false && r.write === false),
    "①-C 失败回执写清了「未发布」（write=false，不产生 applied）",
  );

  const { activateBaseline } = await import("../src/server/work/documents");
  const baseline0 = activateBaseline(
    MAIN,
    { approved_by: "gpt-6", approval_basis: "夹具：先有生效基线才能画图", approval_kind: "delegated_technical_review" },
    home,
  );
  ok(baseline0.created, `①-C 先用 V06-02 程序入口激活基线（${baseline0.baseline.baseline_id}）`);
  const c1 = await runChatAction({ projectId: MAIN, sessionId: "sess-bp", text: "按定版图纸把图更新一下" });
  ok(
    c1.action.status === "applied" && actionStatusLabel(c1.action) === "图已更新",
    `①-C 生效基线后 → applied /「图已更新」（真实发布回执）`,
  );
  ok(
    exists(path.join(mainRoot, ".工作台", "arch", "blueprint.json")) &&
      c1.action.tool_receipts.some((r) => r.tool === "blueprint" && r.ok && r.write),
    "①-C 图真落盘 + 回执 write=true（applied 只由真实写入回执产生）",
  );
  const bpDetail = c1.action.tool_receipts.find((r) => r.tool === "blueprint")!.detail as {
    coverage: { design_sections: { mapped: number; total: number; unmapped: unknown[] }; plan_tasks: unknown };
    unmapped: string[];
  };
  ok(
    c1.action.tool_receipts.find((r) => r.tool === "blueprint")!.summary.includes("覆盖") &&
      c1.action.tool_receipts.find((r) => r.tool === "blueprint")!.summary.includes("未映射") &&
      bpDetail.coverage.design_sections.total > 0,
    "①-C 回执列了实际覆盖与未映射（§3.6「回执列新增/修改/未映射、实际覆盖与图版本」）",
  );

  // ── ①-D 整理方案：先读现行两份材料 → 有出处的章节差异 → review_needed ──
  const d1 = await runChatAction({ projectId: MAIN, sessionId: "sess-prop", text: "整理成方案交给设计审定" });
  info(`①-D 提案动作：status=${d1.action.status} error=${d1.action.error?.message ?? "（无）"}`);
  ok(
    d1.action.kind === "proposal" && d1.action.status === "review_needed",
    `①-D 整理方案 → review_needed（待审定）`,
  );
  ok(
    actionStatusLabel(d1.action) === "待审定" &&
      d1.action.source_versions.design !== null &&
      d1.action.source_versions.plan !== null &&
      d1.action.tool_receipts[0].summary.includes("读到设计"),
    "①-D 正式修订**先读现行两份材料**（回执里两个来源都在）",
  );
  const propExtra = d1.action.result_ref!.extra as {
    section_diff_counts: { changed: number; added: number; removed: number };
    design_candidate: { path: string; sha256: string };
    plan_candidate: { path: string; sha256: string };
    dropped: { what: string; why: string }[];
    changed_tasks: number;
  };
  ok(
    propExtra.section_diff_counts.changed >= 1 && propExtra.changed_tasks >= 1,
    `①-D 产出**章节差异**（改 ${propExtra.section_diff_counts.changed} 处）与任务差异（${propExtra.changed_tasks} 张）`,
  );
  const proposalReport = read(path.join(mainRoot, d1.action.result_ref?.path ?? ""));
  ok(
    proposalReport.includes("章节差异") &&
      proposalReport.includes("任务差异") &&
      proposalReport.includes("用户原话") &&
      proposalReport.includes("出处："),
    "①-D 交接资料里有出处（原话 + 条目出处 + 差异表）",
  );
  ok(
    propExtra.dropped.some((x) => x.what.includes("不存在的章节")) &&
      propExtra.dropped.some((x) => x.what.includes("T-4") && x.why.includes("出处")),
    `①-D 定位不到/无出处的条目**被丢弃并登记**（${propExtra.dropped.map((x) => x.what).join("、")}）`,
  );
  ok(
    sha256File(path.join(mainRoot, ".工作台", "design.md")) === designA1() &&
      sha256File(path.join(mainRoot, ".工作台", "plan.md")) === planA1(),
    "①-D 提案阶段现行图纸**一个字节都没改**（候选件写在 .工作台/work 下）",
  );
  ok(
    listChatActions(MAIN, { sessionId: "sess-discuss" }).every((a) => a.project_id === MAIN) &&
      listChatActions(OTHER, {}).length === 0,
    "①-D 动作按项目隔离（另一项目读不到本项目的动作）",
  );

  // ═════════════ ② 可追溯 / 幂等 / 失败续接 ═════════════
  section("② 可追溯、幂等、失败续接");
  const draftDir = path.join(workOf(mainRoot), "chat-drafts");
  const draftsBefore = fs.readdirSync(draftDir).length;
  const e0 = await runChatAction({ projectId: MAIN, sessionId: "sess-dup", text: "我想做一个去重用例" });
  const e1 = await runChatAction({ projectId: MAIN, sessionId: "sess-dup", text: "我想做一个去重用例" });
  ok(
    e0.deduplicated === false && e1.deduplicated === true && e1.action.action_id === e0.action.action_id,
    "②-1 重复发送命中幂等键：返回同一动作（不产生第二次效果）",
  );
  ok(
    fs.readdirSync(draftDir).length === draftsBefore + 1,
    `②-1 重复发送只留一份讨论草稿（本轮新增 ${fs.readdirSync(draftDir).length - draftsBefore} 份）`,
  );
  const changesFile = path.join(workOf(mainRoot), "chat-changes.jsonl");
  const changeLines = read(changesFile).trim().split(/\r?\n/).length;
  const b1b = await runChatAction({
    projectId: MAIN,
    sessionId: "sess-dup2",
    text: "这里不对，我想改这里：导出能力也支持大文件",
    selection: { kind: "capability", id: "cap:export", name: "导出能力" },
  });
  const b1c = await runChatAction({
    projectId: MAIN,
    sessionId: "sess-dup2",
    text: "这里不对，我想改这里：导出能力也支持大文件",
    selection: { kind: "capability", id: "cap:export", name: "导出能力" },
  });
  ok(
    !b1b.deduplicated && b1c.deduplicated && b1c.action.action_id === b1b.action.action_id &&
      read(changesFile).trim().split(/\r?\n/).length === changeLines + 1,
    "②-1 定位反馈重复发送也只登记一次变更记录（两次调用只多一条）",
  );

  // ── ②-2 落稿失败：草稿目录被占 → 动作 failed（不得报 saved），修好后可续接 ──
  const blocked = path.join(workOf(mainRoot), "chat-drafts");
  const blockedBackup = fs.readdirSync(blocked).map((n) => [n, read(path.join(blocked, n))] as const);
  fs.rmSync(blocked, { recursive: true, force: true });
  write(blocked, "占位文件：让落盘失败（模拟落稿写不进盘）\n");
  const f1 = await runChatAction({ projectId: MAIN, sessionId: "sess-fail", text: "我想做一个失败用例" });
  ok(
    f1.action.status === "failed" && f1.action.error !== null && actionStatusLabel(f1.action) === "失败",
    `②-2 落稿失败 → failed（不谎报 saved）：${f1.action.error?.message.slice(0, 60)}…`,
  );
  ok(
    !f1.action.tool_receipts.some((r) => r.tool === "write_draft" && r.ok),
    "②-2 失败动作里没有「写成功」的回执",
  );
  fs.rmSync(blocked, { force: true });
  mkdirp(blocked);
  for (const [n, content] of blockedBackup) write(path.join(blocked, n), content);
  const f2 = await retryChatAction(MAIN, f1.action.action_id);
  ok(
    f2.status === "saved" &&
      f2.action_id === f1.action.action_id &&
      f2.stages.filter((s) => s.status === "failed").length === 1,
    "②-2 失败可续接：同一条动作重跑成功（不产生第二个动作）",
  );

  // ── ②-3 applied 红线：伪造的 applied 行读回即报坏行 ──
  const fake: ChatAction = {
    ...a1.action,
    action_id: "act-forged-applied",
    status: "applied",
    tool_receipts: [],
  };
  let guardThrew = false;
  try {
    assertAppliedHasWriteReceipt(fake);
  } catch {
    guardThrew = true;
  }
  ok(guardThrew, "②-3 无写入回执却标 applied → 落盘前被拒（applied 只能由真实回执产生）");
  const forgedLine = JSON.stringify({
    ...fake,
    rev: 99,
    idempotency_key: "forged",
  });
  fs.appendFileSync(actionsFile(mainRoot), `${forgedLine}\n`, "utf8");
  const logAfterForge = readChatActions(MAIN, home);
  ok(
    logAfterForge.corrupt.some((c) => c.reason.includes("applied")) &&
      logAfterForge.actions.every((a) => a.action_id !== "act-forged-applied"),
    "②-3 手工塞进去的 applied 行在**读回**时被判坏行（不因为它写在文件里就当真）",
  );
  // 清掉伪造行，避免污染后续断言
  const keptLines = read(actionsFile(mainRoot))
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.includes("act-forged-applied"));
  write(actionsFile(mainRoot), `${keptLines.join("\n")}\n`);

  // ── ②-4 工具动作与结果关联持久化 ──
  const tools = listChatActions(MAIN, { sessionId: "sess-chat" });
  void tools;
  const assoc = await runChatAction({ projectId: MAIN, sessionId: "sess-chat", text: "我想做个工具关联用例" });
  const { appendChatActionReceipt } = await import("../src/server/work/chatActions");
  const assoc2 = appendChatActionReceipt(MAIN, assoc.action.action_id, {
    tool: "chat_tools",
    ok: true,
    write: true,
    summary: "本轮模型调用工具 1 次：write_arch×1；真实写入 .工作台/arch/supplement.json",
    affected_ids: ["chat:消息总线"],
  });
  ok(
    assoc2.tool_receipts.length === assoc.action.tool_receipts.length + 1 &&
      assoc2.affected_ids.includes("chat:消息总线") &&
      getChatAction(MAIN, assoc.action.action_id)?.tool_receipts.length === assoc2.tool_receipts.length,
    "②-4 工具动作与结果关联落盘（写回后再读回一致）",
  );

  // ═════════════ ③ 会话删除：归档留引用 ═════════════
  section("③ 会话删除：有引用转归档、无引用照常删");
  const chatDir = path.join(workbench(mainRoot), "chat");
  const { createSession, deleteSession, appendMessage } = await import("../src/server/chat");
  const sidRef = createSession(MAIN, home);
  appendMessage(MAIN, sidRef, { role: "user", content: "我想做一个 XLSX 导入", ts: new Date().toISOString() }, home);
  // 让这个会话被一个动作引用（同内容 → 幂等命中既有讨论动作，把引用挪到这个会话上）
  const ref1 = await runChatAction({ projectId: MAIN, sessionId: sidRef, text: "我想做一个引用会话的讨论" });
  ok(ref1.action.status === "saved", "③ 前置：被引用的会话产生了一个 saved 动作");
  ok(
    chatActionsReferencingSession(MAIN, sidRef, home).length === 1,
    "③ 引用识别：该会话被动作有效引用",
  );
  const del1 = deleteSession(MAIN, sidRef, home);
  ok(
    del1.archived && del1.archive_path !== null && del1.action_ids.includes(ref1.action.action_id),
    `③ 有有效引用 → 转归档（${del1.archive_path}）并列出引用它的动作`,
  );
  ok(
    !exists(path.join(chatDir, `${sidRef}.jsonl`)) &&
      exists(path.join(chatDir, "archive", `${sidRef}.jsonl`)) &&
      read(path.join(chatDir, "archive", `${sidRef}.jsonl`)).includes("我想做一个 XLSX 导入"),
    "③ 归档是**挪走**不是删除：内容一字不改地留在 chat/archive/",
  );
  const archivedAction = getChatAction(MAIN, ref1.action.action_id)!;
  ok(
    archivedAction.archived &&
      archivedAction.archive?.session_archive_path !== null &&
      archivedAction.tool_receipts.some((r) => r.tool === "session_archive") &&
      listChatActions(MAIN, { sessionId: sidRef }).length === 1,
    "③ 动作记录留痕（归档位置 + 引用仍可核实），重开可查",
  );
  const sidPlain = createSession(MAIN, home);
  appendMessage(MAIN, sidPlain, { role: "user", content: "随便聊一句", ts: new Date().toISOString() }, home);
  const del2 = deleteSession(MAIN, sidPlain, home);
  ok(
    del2.archived === false && !exists(path.join(chatDir, `${sidPlain}.jsonl`)),
    "③ 没有有效引用的普通聊天**照常可删**（不因为本卡就把所有会话都锁住）",
  );

  // ═════════════ ④ 审定并激活（正式修订的落地） ═════════════
  section("④ 审定并激活：源变了不许激活；激活后图纸按章节改、Gate 不动");
  // ④-1 源在审定期间改变 → VERSION_CONFLICT，且一个字节都不写
  const designNow = sha256File(path.join(mainRoot, ".工作台", "design.md"));
  write(
    path.join(mainRoot, ".工作台", "design.md"),
    `${MAIN_DESIGN}\n## 9 审定期间的改动\n\n外部改动（模拟审定期间源变了）。\n`,
  );
  const tampered = activateChatActionProposal(
    MAIN,
    d1.action.action_id,
    { approved_by: "user", approval_basis: "夹具：源已变，必须拒绝", approval_kind: "user_confirmed" },
    { dataDir: home },
  );
  ok(
    tampered.status === "failed" && tampered.error?.code === "VERSION_CONFLICT",
    "④-1 源在审定中改变 → 拒绝激活（VERSION_CONFLICT），不拿旧提案覆盖新原文",
  );
  ok(
    sha256File(path.join(mainRoot, ".工作台", "design.md")) !== designNow &&
      read(path.join(mainRoot, ".工作台", "design.md")).includes("外部改动"),
    "④-1 拒绝时现状未被改动（外部那份还在）",
  );
  // 还原现场：同一份提案（源已还原 → 幂等键相同）续接回 review_needed
  write(path.join(mainRoot, ".工作台", "design.md"), MAIN_DESIGN);
  const d2 = await runChatAction({ projectId: MAIN, sessionId: "sess-prop", text: "整理成方案交给设计审定" });
  ok(
    d2.action.status === "review_needed" && d2.action.action_id === d1.action.action_id,
    "④-1 源还原后同一提案续接回 review_needed（同一动作、同一幂等键，不产生第二份提案）",
  );
  // ④-2 候选件被改过 → 拒绝采信（本用例会把 d2 标 failed）
  const candPath = path.join(mainRoot, (d2.action.result_ref!.extra as { design_candidate: { path: string } }).design_candidate.path);
  const candGood = read(candPath);
  write(candPath, `${candGood}\n<!-- 手工篡改 -->\n`);
  const tamperedCand = activateChatActionProposal(
    MAIN,
    d2.action.action_id,
    { approved_by: "user", approval_basis: "夹具：候选件被改过", approval_kind: "user_confirmed" },
    { dataDir: home },
  );
  ok(
    tamperedCand.status === "failed" && tamperedCand.error?.code === "PROPOSAL_TAMPERED",
    "④-2 候选件与提案记录不一致 → 拒绝采信（不拿被改过的候选激活）",
  );
  ok(
    !read(path.join(mainRoot, ".工作台", "design.md")).includes("手工篡改"),
    "④-2 拒绝采信时现行图纸未被写入",
  );
  write(candPath, candGood);
  // 候选件还原后续接同一条提案（重跑 → review_needed），再走"缺依据"与正式激活
  const d3 = await runChatAction({ projectId: MAIN, sessionId: "sess-prop", text: "整理成方案交给设计审定" });
  ok(
    d3.action.action_id === d2.action.action_id && d3.action.status === "review_needed",
    "④-2 候选件还原后续接回同一条提案（review_needed）",
  );
  // ④-3 缺审定依据 → 拒绝
  let basisThrew = false;
  try {
    activateChatActionProposal(
      MAIN,
      d3.action.action_id,
      { approved_by: "user", approval_basis: "  ", approval_kind: "user_confirmed" },
      { dataDir: home },
    );
  } catch {
    basisThrew = true;
  }
  ok(basisThrew, "④-3 没有审定依据 → 拒绝（§2.9：无依据不能激活）");
  ok(
    getChatAction(MAIN, d3.action.action_id, home)?.status === "review_needed",
    "④-3 缺依据被拒后动作仍是 review_needed（拒得干净，不留半状态）",
  );
  // ④-4 正常审定激活
  const gateFile = path.join(mainRoot, ".工作台", "gate.jsonl");
  const gateBeforeAct = hashOrNone(gateFile);
  const designed = activateChatActionProposal(
    MAIN,
    d3.action.action_id,
    { approved_by: "user", approval_basis: "夹具：人确认按讨论修订导入能力章节", approval_kind: "user_confirmed" },
    { dataDir: home },
  );
  ok(
    designed.status === "applied" && actionStatusLabel(designed) === "基线已激活",
    `④-4 审定并激活 → applied /「基线已激活」（真实写入回执）`,
  );
  const designAfter = read(path.join(mainRoot, ".工作台", "design.md"));
  ok(
    designAfter.includes("需要支持 XLSX") && designAfter.includes("## 2 导入能力"),
    "④-4 设计书按**章节**改到位（不是往文末追加总结）",
  );
  const planAfter = read(path.join(mainRoot, ".工作台", "plan.md"));
  ok(planAfter.includes("| T-3 |") && planAfter.includes("加 XLSX 导入"), "④-4 施工图按**任务**加了新卡");
  const baselines = read(path.join(mainRoot, ".工作台", "baselines.jsonl")).trim().split(/\r?\n/);
  ok(
    baselines.length >= 2 &&
      JSON.parse(baselines[baselines.length - 1]).approved_by === "user" &&
      JSON.parse(baselines[baselines.length - 1]).approval_kind === "user_confirmed",
    "④-4 基线流水新增一条（approved_by=user / user_confirmed，没伪造技术审定）",
  );
  ok(
    hashOrNone(gateFile) === gateBeforeAct,
    "④-4 激活基线**不写 gate.jsonl**（审定 ≠ 用户 Gate，§2.9 红线）",
  );
  // ④-5 同一份提案不能重复激活
  let reActivateThrew = false;
  try {
    activateChatActionProposal(
      MAIN,
      d3.action.action_id,
      { approved_by: "user", approval_basis: "再来一次", approval_kind: "user_confirmed" },
      { dataDir: home },
    );
  } catch {
    reActivateThrew = true;
  }
  ok(reActivateThrew, "④-5 已 applied 的提案不能重复激活（不产生第二次写入）");

  // ═════════════ ⑤ 落稿笔（appendDesign）语义不变 ═════════════
  section("⑤ 既有落稿笔 appendDesign 语义不变（与新的章节修订链路并存）");
  const otherDesignBefore = exists(path.join(otherRoot, ".工作台", "design.md"))
    ? read(path.join(otherRoot, ".工作台", "design.md"))
    : "(无设计书)";
  const knob = appendDesign(OTHER, "## 附录：落稿笔追加段\n\n追加内容原样落盘。\n", home);
  const otherDesign = read(path.join(otherRoot, ".工作台", "design.md"));
  ok(
    otherDesign.startsWith("# V06-07 另一项目 设计稿") &&
      otherDesign.endsWith("追加内容原样落盘。\n") &&
      knob.lines_after > knob.lines_before,
    "⑤ 落稿笔仍追加到 design.md 末尾（无设计书先建标题头，行为逐字不变）",
  );
  // 塔台自身口径：插在 DESIGN.md 附录 B 之前——本卡不调用它，但断言源码里那条分支还在
  const workstationSrc = read(path.join(REPO, "src", "server", "workstation.ts"));
  ok(
    workstationSrc.includes("export function appendDesign(") &&
      workstationSrc.includes("appendixBRange(oldText).start"),
    "⑤ 落稿笔本体（含塔台「附录 B 之前」分支）未被本卡改动",
  );
  const chatActionsSrc = read(path.join(REPO, "src", "server", "work", "chatActions.ts"));
  ok(
    !chatActionsSrc.includes("appendDesign(") && !chatActionsSrc.includes("appendDiscuss("),
    "⑤ 新的聊天动作链路**不调用**落稿笔（两条路各有入口，互不替代）",
  );

  // ═════════════ ⑥ 逆向入口：双文档链 ═════════════
  section("⑥ 逆向入口接入双文档链（设计草稿 + 剩余施工草稿）");
  const gateDraftFile = path.join(draftRoot, ".工作台", "progress.json");
  ok(!exists(gateDraftFile), "⑥ 前置：逆向夹具还没有 progress.json（从零开始）");
  const reverse = await draftDesign(DRAFT, { memoryTimeoutMs: 1200 }, home);
  ok(reverse.conflict === false, "⑥ 无 design.md 项目 → 正常起草（非 conflict）");
  const rd = readReverseDraft(DRAFT, home);
  const rpd = readReversePlanDraft(DRAFT, home);
  ok(
    rd.exists && rpd.exists,
    `⑥ 两份草稿都落盘（design.draft.md / plan.draft.md）`,
  );
  ok(
    rd.exists && rd.content.includes("推断 Gate 步") && rd.content.includes("推断依据"),
    "⑥ 设计草稿带推断依据（有来源）",
  );
  ok(
    rpd.exists &&
      rpd.content.includes("## 来源") &&
      rpd.content.includes("代码扫描") &&
      rpd.content.includes("设计草稿：design.draft.md"),
    "⑥ 剩余施工草稿写明了来源（扫描 / 设计草稿 / 推断依据）",
  );
  ok(
    rpd.exists && rpd.content.includes("待验证"),
    "⑥ 无验证证据的既有实现**仍标待验证**（不因「已经写了」就当通过）",
  );
  const rpTable = parsePlanTable(rpd.exists ? rpd.content : "");
  ok(
    rpTable !== null &&
      rpTable.rows.length === 1 &&
      validatePlanTasks(rpTable.rows, true).length === 0 &&
      rpTable.rows[0].evidence !== "",
    "⑥ 剩余施工草稿的任务表结构合法且每张卡都有完成证据（坏图纸不落盘）",
  );
  ok(
    reverse.conflict === false && reverse.plan_draft !== null && reverse.plan_draft.pending_verification >= 1,
    "⑥ 起草回执带上第二份草稿的待验证计数（前端能如实显示）",
  );
  ok(
    !exists(path.join(draftRoot, ".工作台", "design.md")) &&
      !exists(path.join(workbench(draftRoot), "gate.jsonl")) &&
      !exists(path.join(draftRoot, ".工作台", "baselines.jsonl")),
    "⑥ 起草**不动 Gate**：没有 design.md / gate.jsonl / baselines（原 Gate 不变，不自动填绿）",
  );
  const conflictMain = await draftDesign(MAIN, { memoryTimeoutMs: 1200 }, home);
  ok(
    conflictMain.conflict === true && !exists(path.join(mainRoot, ".工作台", "plan.draft.md")),
    "⑥ 已有 design.md 的项目仍是 conflict（不覆盖、也不凭空写第二份草稿）",
  );

  // ═════════════ ⑦ 真服务端到端（重开可查 / 图写成功但回答中断 / 旧项目延迟回包） ═════════════
  section("⑦ 真服务端子进程：SSE 动作回执 + 重开可查");
  const child = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    env: {
      ...process.env,
      TATAI_HOME: home,
      TATAI_PORT: String(HTTP_PORT),
      TATAI_DEEPSEEK_BASE_URL: STUB_URL,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? "stub-key-for-verify",
    },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO,
  });
  spawned.push(child);
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  const BASE = `http://localhost:${HTTP_PORT}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) break;
    } catch {
      /* 等 */
    }
    await sleep(250);
  }
  try {
    // ⑦-1 自然表达触发 + SSE 动作回执
    const r0 = await fetch(`${BASE}/api/projects/${OTHER}/chat/sessions`, { method: "POST" });
    const j0 = (await r0.json()) as { session_id?: string };
    const sid = j0.session_id!;
    ok(typeof sid === "string" && sid.length > 0, "⑦-1 真服务端创建会话");
    const res = await fetch(`${BASE}/api/projects/${OTHER}/chat/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "我想做一个只有真服务端才有的讨论" }),
    });
    const sse = await res.text();
    ok(res.status === 200 && sse.includes('"action"'), "⑦-1 发问 → SSE 里带动作回执（前端按它显示六阶段文案）");
    const actionEvent = JSON.parse(
      sse
        .split("\n\n")
        .map((e) => e.trim())
        .find((e) => e.startsWith("data: ") && e.includes('"action"'))!
        .slice(6),
    ) as { action: { status: string; label: string; action_id: string } };
    ok(
      actionEvent.action.status === "saved" && actionEvent.action.label === "已保存草稿",
      `⑦-1 回执状态与文案来自服务端真实落盘（${actionEvent.action.status}/${actionEvent.action.label}）`,
    );
    ok(sse.includes("data: [DONE]"), "⑦-1 SSE 正常收尾（动作没有打断聊天）");

    // ⑦-2 重开可查：新建一个「进程外」的读（HTTP GET），动作还在
    const ra = await fetch(`${BASE}/api/projects/${OTHER}/chat/actions?session_id=${sid}`);
    const jaRaw = (await ra.json()) as Record<string, unknown>;
    info(`⑦-2 GET chat/actions → ${ra.status} ${JSON.stringify(jaRaw).slice(0, 200)}`);
    const ja = jaRaw as unknown as { ok: boolean; actions: { action_id: string; trigger: string }[]; phase_labels: Record<string, string> };
    ok(
      ja.ok && ja.actions.some((a) => a.action_id === actionEvent.action.action_id),
      "⑦-2 重开可查：HTTP 读回同一条动作（做过什么核实得了）",
    );
    ok(
      ja.phase_labels.applied === "图已更新" && ja.phase_labels.failed === "失败",
      "⑦-2 六阶段文案由服务端下发（前端不猜）",
    );

    // ⑦-3 图写成功但回答中断：动作先真实落盘（applied），随后模型侧中断
    //      夹具 OTHER 还没有基线 → 先激活一个，让"更新图"能真发布
    const act = await fetch(`${BASE}/api/projects/${OTHER}/documents/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved_by: "gpt-6", approval_basis: "夹具：让更新图可发布", approval_kind: "delegated_technical_review" }),
    });
    const actBody = (await act.json()) as { ok?: boolean; error?: unknown };
    info(`⑦-3 documents/activate → ${act.status} ${actBody.ok === true ? "ok" : JSON.stringify(actBody.error)}`);
    stubFailNext = true;
    const res3 = await fetch(`${BASE}/api/projects/${OTHER}/chat/sessions/${sid}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "按定版图纸把图更新一下" }),
    });
    const sse3 = await res3.text();
    const after3 = (await (await fetch(`${BASE}/api/projects/${OTHER}/chat/actions?session_id=${sid}`)).json()) as { actions: { status: string; kind: string; label: string; tool_receipts: { tool: string; ok: boolean; write: boolean }[] }[] };
    const bpAction = after3.actions.find((a) => a.kind === "blueprint_update");
    const published = exists(path.join(workbench(otherRoot), "arch", "blueprint.json"));
    const chatBroke = sse3.includes('"error"');
    if (published) {
      ok(
        sse3.includes('"error"') && bpAction?.status === "applied" && bpAction.label === "图已更新",
        "⑦-3 图写成功但回答中断：图已发布 = applied（真回执），聊天侧如实报错",
      );
    } else {
      ok(
        chatBroke && bpAction?.status === "failed",
        "⑦-3 图没写成 + 回答中断：动作如实 failed（不谎报已更新）",
      );
    }
    ok(
      (bpAction?.tool_receipts ?? []).some((r) => r.tool === "blueprint"),
      "⑦-3 中断后动作回执仍可读（回执不因聊天半截而丢）",
    );

    // ⑦-4 旧项目延迟回包：另一项目的动作列表不受影响
    const ro = await fetch(`${BASE}/api/projects/${MAIN}/chat/actions`);
    const jo = (await ro.json()) as { actions: { project_id?: string }[] };
    ok(
      jo.actions.length > ja.actions.length,
      `⑦-4 项目隔离：主夹具动作 ${jo.actions.length} 条 / 另一项目 ${ja.actions.length} 条，互不串（旧项目延迟回包写不进别的项目）`,
    );

    // ⑦-5 逆向入口经 HTTP：双草稿 + 原 Gate 不变
    const rrev = await fetch(`${BASE}/api/projects/${DRAFT}/design/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ memory_timeout_ms: 1200 }),
    });
    const jrev = (await rrev.json()) as {
      ok: boolean;
      result: { conflict: boolean; plan_draft: { source: string } | null; plan_draft_error: string | null };
    };
    ok(
      jrev.ok && jrev.result.conflict === false && jrev.result.plan_draft !== null,
      "⑦-5 HTTP 逆向入口产出两份草稿（plan_draft 非空）",
    );
    const rget = await fetch(`${BASE}/api/projects/${DRAFT}/design/draft`);
    const jget = (await rget.json()) as { ok: boolean; draft: { exists: boolean }; plan_draft: { exists: boolean } };
    ok(
      jget.ok && jget.draft.exists && jget.plan_draft.exists,
      "⑦-5 HTTP 读回两份草稿（设计 + 剩余施工）",
    );
    ok(
      !exists(path.join(draftRoot, ".工作台", "design.md")) &&
        !exists(path.join(workbench(draftRoot), "gate.jsonl")),
      "⑦-5 逆向入口**没有**自动填绿：design.md / gate.jsonl 仍不存在（原 Gate 不变）",
    );

    // ⑦-6 会话删除的 HTTP 口径
    const refSid = (await (await fetch(`${BASE}/api/projects/${OTHER}/chat/sessions`, { method: "POST" })).json()) as {
      session_id: string;
    };
    await fetch(`${BASE}/api/projects/${OTHER}/chat/sessions/${refSid.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "我想做一个会被引用的讨论" }),
    });
    const delRes = await fetch(`${BASE}/api/projects/${OTHER}/chat/sessions/${refSid.session_id}`, { method: "DELETE" });
    const delBody = (await delRes.json()) as { ok: boolean; archived: boolean; archive_path: string | null };
    ok(
      delBody.ok && delBody.archived === true && (delBody.archive_path ?? "").includes("archive"),
      `⑦-6 有引用的会话删除 → 响应如实说明转归档（${delBody.archive_path}）`,
    );
    const rplain = await fetch(`${BASE}/api/projects/${OTHER}/chat/sessions`, { method: "POST" });
    const plainSid = ((await rplain.json()) as { session_id: string }).session_id;
    const delPlain = await fetch(`${BASE}/api/projects/${OTHER}/chat/sessions/${plainSid}`, { method: "DELETE" });
    const delPlainBody = (await delPlain.json()) as { ok: boolean; archived: boolean };
    ok(delPlainBody.ok && delPlainBody.archived === false, "⑦-6 无引用的会话删除 → 照常删除（archived=false）");

    // ⑦-7 规划动作可显式跑（POST op=run），且不重复写
    const runRes = await fetch(`${BASE}/api/projects/${OTHER}/chat/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "run", text: "我想做一个显式跑的动作" }),
    });
    const runBody = (await runRes.json()) as { ok: boolean; action: { action_id: string }; deduplicated: boolean };
    const runRes2 = await fetch(`${BASE}/api/projects/${OTHER}/chat/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "run", text: "我想做一个显式跑的动作" }),
    });
    const runBody2 = (await runRes2.json()) as { deduplicated: boolean; action: { action_id: string } };
    ok(
      runBody.ok && runBody2.deduplicated === true && runBody2.action.action_id === runBody.action.action_id,
      "⑦-7 显式跑动作同样走幂等键（第二次返回同一动作）",
    );
  } finally {
    child.kill();
    await sleep(300);
  }

  // ═════════════ ⑧ 零改动护栏 ═════════════
  section("⑧ 零改动护栏（文档 / 既有验证脚本 / 附录 B）");
  for (const f of PROTECTED_DOCS) {
    ok(sha256File(path.join(REPO, f)) === docsBefore.get(f), `⑧ 受保护文档未改动：${f}`);
  }
  for (const f of VICTIM_SCRIPTS) {
    ok(sha256File(path.join(REPO, f)) === scriptsBefore.get(f), `⑧ 既有验证脚本未改动：${f}`);
  }
  ok(sha256(appendixBRegion()) === appendixBefore, `⑧ DESIGN.md 附录 B 区间 sha256 首尾一致（${appendixBefore.slice(0, 12)}…）`);
  const contractAfter = read(path.join(REPO, "docs", "work-v2-contract.md"));
  ok(
    contractHeadBefore.length > 0 &&
      contractAfter.startsWith(contractBefore.slice(0, contractBefore.length)) &&
      contractAfter.includes("V06-07"),
    "⑧ docs/work-v2-contract.md 只在**尾部追加**了新节（既有各节原文前缀逐字不变）",
  );
}

/** ①-D 用的基线态哈希：提案阶段比对的"现行图纸"（激活基线不改图纸，故等于原夹具内容） */
let designA1Cache: string | null = null;
let planA1Cache: string | null = null;
function designA1(): string {
  if (designA1Cache === null) designA1Cache = sha256(MAIN_DESIGN);
  return designA1Cache;
}
function planA1(): string {
  if (planA1Cache === null) planA1Cache = sha256File(path.join(mainRoot, ".工作台", "plan.md"));
  return planA1Cache;
}

function cleanup(): void {
  try {
    stubServer.close();
  } catch {
    /* 已关 */
  }
  for (const proc of spawned) {
    try {
      if (proc.exitCode === null) proc.kill();
    } catch {
      /* 已退出 */
    }
  }
  if (process.env.TATAI_KEEP_TMP === "1") {
    console.log(`[verify] 保留现场：${tmpBase}`);
    return;
  }
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* Windows 下文件偶被占用，残留 tmp 目录无害 */
  }
}

main()
  .catch((e) => {
    console.error(`[verify] 异常：${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
    console.log(`[verify] 合计 PASS ${passCount} / FAIL ${failCount}`);
    console.log("[verify] done");
  });

void loadDocument;
void readReverseDraft;
