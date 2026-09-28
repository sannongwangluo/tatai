// V06-04 验证脚本（PLAN.md V06-04，DESIGN.md §2.7–§2.8 / §3.6 / §6.7）。
// 用法：pnpm verify:v06-04（或 node --import tsx scripts/verify-v06-04.ts）
//
// 自带隔离环境：临时 TATAI_HOME + 两个临时项目（os.tmpdir() 下），**不碰**三个真实项目的 `.工作台/`；
// 塔台自身的 DESIGN.md / PLAN.md **只读**（脚本首尾逐文件 sha256 对照，证明零改动）；
// 收尾清理自己建的临时目录与起过的子进程（TATAI_KEEP_TMP=1 可保留现场）。
//
// 模型夹具：本脚本**不依赖真机网关**——起一个本机 SSE 伪模型（OpenAI 流式形态），
// 按"合作模型/顽固模型"两种回放驱动 `runChatTurn`，从而确定性地制造
// 「批量读失败」「覆盖没读齐」「工具轮次撞顶中断」这些真实现场（施工与验证约定：可控模型夹具）。
// 真机网关的语义回归在既有 `verify:chat-context` / `verify:chat-tools` / `verify:m5` 里跑（本卡已执行）。
//
// 覆盖点（PLAN V06-04 检查项 1–3 逐条）：
//   ① 三个失败用例的回归（**先修实际成功计数，不靠提高上限遮掩**）：
//      · 批量读超总量上限 → 后一个文件"未读"，账本里 requested=1 但 complete=false（旧实现记成已读）；
//      · 单文件截断 → 只算"读到一部分"，不算读完全文件；
//      · 清单上限截断 → 回执必须自认"清单 ≠ 全量"，不得吞掉。
//      另外把二进制排除与失败路径计入"未读"（不缩小清单、不跳过 tests、不隐藏排除）。
//   ② 分层上下文：项目简报 → 施工图任务/生效基线 → 相关章节 → 按需原文；加入施工图与生效决定；
//      长于 2 万字符的设计分段取回（next_cursor/total/未覆盖范围）；模型中断保留已确认来源与续接位置；
//      源变化标陈旧并按影响范围增量重建，依赖任务拿到**明确失效项**。
//   ③ 夹具含：长于 2 万字符的设计、长文件（需分段续读）、批量读取失败、二进制排除、变动游标、
//      不同项目同名文件；断言"回执与实际返回一致"且"不串项目"。
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  collectFiles,  executeChatTool,
  makeCursor,
  parseCursor,
  readFilePaged,
  type ReadReceipt,
  type ChatToolResult,
} from "../src/server/chatTools";
import { buildChatContext } from "../src/server/chatContext";
import { runChatTurn, type ChatTurnReceipt } from "../src/server/chatTurn";
import {
  buildContextPackage,
  buildResumeCheckpoint,
  clearContextPackages,
  clearCheckpoint,
  CoverageLedger,
  ContextError,
  formatCoverageReceipt,
  getContextPackage,
  loadCheckpoint,
  packageStaleness,
  readContextSource,
  refreshContextPackage,
  resolveCheckpoint,
  rangesCoverAll,
  saveCheckpoint,
  type ContextPackage,
  type ResumeCheckpoint,
} from "../src/server/work/context";
import { activateBaseline, activeBaseline } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import { WorkService } from "../src/server/work/service";
import { submitTaskStatus, readTaskStates } from "../src/server/work/tasks";
import { projectWorkDir } from "../src/server/workstation";
import { askFlashTool } from "../src/mcp/tools/askFlash";

const REPO = process.cwd();
const REPO_FILES = ["DESIGN.md", "PLAN.md", "PROGRESS.md", "AGENTS.md", "README.md"];
const STUB_PORT = 8804;
const HTTP_PORT = 8805;
const MAIN = "v0604-main";
const OTHER = "v0604-other";
/** 长文件夹具：单文件远超 48000 字上限（必须分段续读） */
const BIG_LINES = 2500;
/** 设计书夹具：全文远超 2 万字符（必须分段取回） */
const DESIGN_BODY_LINES = 800;

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
const sha256 = (data: string | Buffer): string =>
  crypto.createHash("sha256").update(data).digest("hex");
const sha256File = (file: string): string => sha256(fs.readFileSync(file));

const spawned: ChildProcess[] = [];
process.on("exit", () => {
  for (const proc of spawned) {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch {
      /* 已经没了 */
    }
  }
});

// ── 隔离环境与夹具 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0604-verify-"));
const dataDir = path.join(tmpBase, "home");
const mainRoot = path.join(tmpBase, "main");
const otherRoot = path.join(tmpBase, "other");
const mkdirp = (dir: string) => fs.mkdirSync(dir, { recursive: true });
const write = (file: string, text: string) => {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, text, "utf8");
};
const writeBytes = (file: string, bytes: Buffer) => {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, bytes);
};
const read = (file: string) => fs.readFileSync(file, "utf8");
const workbenchOf = (root: string) => path.join(root, ".工作台");
/** 长文本生成：行长稳定，便于按行数断言分段 */
const longText = (prefix: string, lines: number): string => {
  const out: string[] = [];
  for (let i = 1; i <= lines; i++) {
    out.push(`${prefix}${String(i).padStart(5, "0")}：` + "锚".repeat(18) + "内容行");
  }
  return out.join("\n") + "\n";
};

for (const dir of [dataDir, mainRoot, otherRoot]) mkdirp(dir);

const DESIGN_MARKER = "V0604-设计暗记-葡萄藤";
const MAIN_DESIGN = [
  `# ${MAIN} 设计书`,
  "",
  `暗记：${DESIGN_MARKER}（只有真把设计书喂进模型请求才答得出）。`,
  "",
  "## 1 概述",
  "目标：验证分层上下文、可信覆盖账本与续读游标。",
  "",
  "## 2 长正文",
  longText("设计正文行 ", DESIGN_BODY_LINES),
].join("\n");
const OTHER_DESIGN = ["# other 设计书", "", "## 1 概述", "另一个项目的设计，同名文件内容不同。", ""].join("\n");

const PLAN_MD = [
  "# 夹具施工图",
  "",
  "## 当前任务",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1 | todo | 打地基 |  | 地基验收记录 |",
  "| T-2 | todo | 砌墙 | T-1 | 墙体验收记录 |",
  "",
  "### T-2 砌墙",
  "",
  "**设计依据**：§2.8。**依赖**：T-1。",
  "",
  "**契约**：输入砖，输出墙。",
  "",
  "**文件责任**：新增 `src/wall.ts`。",
  "",
  "- [ ] 砌到顶",
  "- [ ] 验过垂直度",
  "",
  "**交付**：墙体验收记录。",
  "",
].join("\n");

write(path.join(workbenchOf(mainRoot), "design.md"), MAIN_DESIGN);
write(path.join(workbenchOf(mainRoot), "plan.md"), PLAN_MD);
write(path.join(workbenchOf(otherRoot), "design.md"), OTHER_DESIGN);
write(path.join(otherRoot, "src", "app.ts"), "export const NAME = 'other-app';\n");

const APP_MARKER = "V0604-项目暗记-蓝鲸";
write(path.join(mainRoot, "package.json"), '{"name":"v0604-main"}\n');
write(
  path.join(mainRoot, "src", "app.ts"),
  [`// 同项目暗记：${APP_MARKER}`, "export const APP = 'main';", "export function hi(): string { return APP; }", ""].join("\n"),
);
const BIG_A = longText("大文件甲 ", BIG_LINES);
const BIG_B = longText("大文件乙 ", BIG_LINES);
write(path.join(mainRoot, "src", "big-a.txt"), BIG_A);
write(path.join(mainRoot, "src", "big-b.txt"), BIG_B);
write(path.join(mainRoot, "src", "util.ts"), "export function util(): number { return 42; }\n");
// 二进制（NUL）：read_file 拒读，覆盖账本必须按"排除且不算已读"登记
writeBytes(path.join(mainRoot, "assets", "blob.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff]));
// tests 目录：不得被跳过（§2.8 禁止"跳过 tests 制造全量覆盖"）
write(
  path.join(mainRoot, "tests", "check_test.py"),
  ["# 水母-对账-88：清单里的 tests 必须被读到，不得跳过", "def test_ok():", "    assert True", ""].join("\n"),
);
write(path.join(mainRoot, "docs", "note.md"), "# 备注\n无。\n");

const record = (id: string, name: string, dir: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  path: dir,
  kind: "backend",
  registered_at: "2026-09-20T00:00:00+08:00",
  last_opened_at: "2026-09-20T00:00:00+08:00",
  ...extra,
});
const TATAI_RECORD = record("tatai", "塔台（repo 根夹具，只读）", REPO, { self_managed: true });
const writeRegistry = () =>
  write(
    path.join(dataDir, "registry.json"),
    JSON.stringify({ version: 1, projects: [TATAI_RECORD, record(MAIN, "V06-04 主夹具", mainRoot), record(OTHER, "V06-04 同名文件夹具", otherRoot)] }, null, 2),
  );
writeRegistry();
process.env.TATAI_HOME = dataDir;
clearContextPackages();

// ── 伪模型（本机 SSE）：让工具循环可确定性回放 ──
interface StubCall {
  name: string;
  args: Record<string, unknown>;
}
type StubReply = { kind: "text"; text: string } | { kind: "tools"; calls: StubCall[] };
interface StubRequest {
  messages: { role: string; content: unknown }[];
  tools: string[];
}
const stubRequests: StubRequest[] = [];
let stubResponder: (messages: StubRequest["messages"], index: number) => StubReply = () => ({
  kind: "text",
  text: "（夹具）默认回答",
});
const stubSeenText = (): string[] => stubRequests.map((r) => r.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));

function sseReply(reply: StubReply): string {
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  if (reply.kind === "text") {
    return (
      chunk({ choices: [{ delta: { content: reply.text }, finish_reason: null }] }) +
      chunk({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
      "data: [DONE]\n\n"
    );
  }
  return (
    chunk({
      choices: [
        {
          delta: {
            tool_calls: reply.calls.map((c, i) => ({
              index: i,
              id: `call_${i + 1}`,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
          finish_reason: null,
        },
      ],
    }) +
    chunk({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) +
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
    let tools: string[] = [];
    try {
      const parsed = JSON.parse(body) as { messages?: StubRequest["messages"]; tools?: { function?: { name?: string } }[] };
      messages = parsed.messages ?? [];
      tools = (parsed.tools ?? []).map((t) => t.function?.name ?? "?");
    } catch {
      /* 解析不成也要给个回答，别把夹具搞死 */
    }
    const index = stubRequests.length;
    stubRequests.push({ messages, tools });
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    res.end(sseReply(stubResponder(messages, index)));
  });
});

/** 从覆盖续读指令里解析出"还没读到"的路径（合作模型夹具：照服务器点名的清单读） */
function pathsFromCoverageInstruction(text: string): string[] {
  return [...text.matchAll(/^- (\S.*)$/gm)]
    .map((m) => m[1].trim())
    .filter((p) => !p.startsWith("……"));
}
/** 取工具结果里某一段的原文（read_files 用 ===== 路径 ===== 分段；read_file 就是整段） */
function segmentOfToolResult(result: string, relPath: string): string {
  const header = `===== ${relPath} =====\n`;
  const at = result.indexOf(header);
  if (at === -1) return result;
  const from = at + header.length;
  const next = result.indexOf("\n\n===== ", from);
  return result.slice(from, next === -1 ? result.length : next);
}
/** 源文件里 receipt.range 覆盖的那几行（与工具回给模型的段逐字对照用） */
function linesOf(content: string, range: { start: number; end: number }): string {
  return content.split(/\r?\n/).slice(range.start - 1, range.end).join("\n");
}
function contextErrorOf(fn: () => unknown): ContextError | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof ContextError) return e;
    console.log(`[verify]   （非 ContextError 抛出：${(e as Error).message}）`);
    return null;
  }
}
function receiptOf(tool: ChatToolResult, relPath: string): ReadReceipt | null {
  return (tool.reads ?? []).find((r) => r.path === relPath) ?? null;
}

const listen = (server: http.Server, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;

async function waitUp(base: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error(`后端 10 秒内未就绪：${base}`);
}
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

async function main(): Promise<void> {
  // ── 塔台根文档哈希（红线：DESIGN.md / PLAN.md 一个字节都不能动）──
  const docHashesBefore = new Map(REPO_FILES.map((f) => [f, sha256File(path.join(REPO, f))]));
  console.log("=".repeat(72));
  console.log("[verify] 塔台根文档 sha256（开工前）");
  for (const [f, h] of docHashesBefore) console.log(`[verify]   ${f}  ${h}`);
  console.log("=".repeat(72));

  const designAbs = path.join(workbenchOf(mainRoot), "design.md");
  const bigAAbs = path.join(mainRoot, "src", "big-a.txt");

  // ═════════════════ ① 分层上下文包（简报 → 任务/基线 → 按需原文） ═════════════════
  info("═══ ① 分层上下文包与覆盖账本 ═══");
  // 生效基线（用 V06-02 的程序入口激活，不手造基线文件）
  const baseline = activateBaseline(
    MAIN,
    {
      approved_by: "gpt-6",
      approval_basis: "夹具：用户已委派的设计审定（技术审定，不伪造用户 Gate）",
      approval_kind: "delegated_technical_review",
    },
    dataDir,
  );
  ok(baseline.created, `① 生效基线已由 documents.activateBaseline 激活（${baseline.baseline.baseline_id}）`);

  const pkg = buildContextPackage(MAIN, { question: "T-2 砌墙 设计 依据" });
  const hasFields =
    typeof pkg.package_id === "string" &&
    pkg.package_id.length > 0 &&
    typeof pkg.generated_at === "string" &&
    typeof pkg.design_revision === "string" &&
    typeof pkg.plan_revision === "string" &&
    Array.isArray(pkg.source_manifest) &&
    typeof pkg.token_or_char_size === "number" &&
    Array.isArray(pkg.omitted) &&
    Array.isArray(pkg.stale_reasons);
  ok(hasFields, "① 上下文包字段齐全（package_id/generated_at/design_revision/source_manifest/token_or_char_size/omitted/stale_reasons）");

  const designEntry = pkg.source_manifest.find((m) => m.kind === "design") ?? null;
  ok(
    designEntry !== null &&
      designEntry.content_sha256 === sha256File(designAbs) &&
      designEntry.status !== "failed",
    "① 来源清单记设计书**真实内容哈希**（与磁盘 sha256 一致）",
  );

  // 长于 2 万字符的设计必须分段取回：本页 + 未覆盖范围 + 续读游标
  ok(
    MAIN_DESIGN.length > 20_000,
    `① 夹具设计书长于 2 万字符（实际 ${MAIN_DESIGN.length} 字）`,
  );
  ok(
    pkg.page !== null && pkg.page.complete === false && pkg.next_cursor !== null,
    `① 长设计**分段取回**：本页第 ${pkg.page?.range.start}–${pkg.page?.range.end} 行 / 共 ${pkg.page?.total.lines} 行，留续读游标`,
  );
  ok(
    pkg.page !== null && pkg.page.text.length <= 20_000 && pkg.token_or_char_size <= 24_000,
    `① 本页与整包都在预算内（页 ${pkg.page?.text.length} 字 / 包 ${pkg.token_or_char_size} 字）`,
  );
  const designOmitted = pkg.omitted.find((o) => o.path === designEntry?.path);
  ok(
    designOmitted?.detail.includes("续读游标") === true,
    `① 未覆盖范围如实登记（${designOmitted?.detail.slice(0, 60)}…）`,
  );
  ok(
    pkg.page !== null && linesOf(MAIN_DESIGN, pkg.page.range) === pkg.page.text,
    "① 回执与实际返回一致：本页文本 == 源文件对应行逐字",
  );

  // 施工图任务/生效决定进包
  ok(
    pkg.tasks.some((t) => t.task_id === "T-2" && t.dependency_ids.includes("T-1") && t.acceptance_checks >= 2),
    `① 施工图任务定义进包（${pkg.tasks.map((t) => `${t.task_id}(依赖${t.dependency_ids.join("/")})`).join("、")}）`,
  );
  const importedForCheck = importTaskDefinitions(PLAN_MD, { plan_revision: pkg.plan_revision ?? undefined });
  ok(
    pkg.plan_definition_digest === importedForCheck.report.definition_digest,
    "① 施工定义哈希与 plan.ts 现算一致（同源，不另立口径）",
  );
  ok(
    pkg.baseline !== null &&
      pkg.baseline.baseline_id === baseline.baseline.baseline_id &&
      pkg.baseline.approval_kind === "delegated_technical_review",
    `① 生效决定/基线进包（${pkg.baseline?.baseline_id}，${pkg.baseline?.approval_kind}）`,
  );
  ok(pkg.sections.some((s) => s.line_start >= 1), `① 相关章节索引进包（${pkg.sections.length} 节）`);

  // 按需原文续读：第二页 = 接着第一页，两页拼起来是原文前缀
  const second = readContextSource(MAIN, pkg.page!.path, {
    ...(pkg.next_cursor === null ? {} : { cursor: pkg.next_cursor }),
    maxChars: 20_000,
  });
  ok(
    second.range.start === pkg.page!.range.end + 1,
    `① 续读游标接着上一页（第 ${second.range.start} 行 = 上页末行 + 1）`,
  );
  ok(
    (pkg.page!.text + "\n" + second.text).startsWith(
      MAIN_DESIGN.split(/\r?\n/).slice(pkg.page!.range.start - 1, second.range.end).join("\n"),
    ),
    "① 两页拼起来与源文件逐字一致（分段取回没有丢行/串行）",
  );

  // 运行状态计数（真提交一条 v2 事件，不手造投影）
  const service = new WorkService({ dataDir });
  submitTaskStatus(service, {
    project_id: MAIN,
    task_id: "T-2",
    change_id: "c-v0604",
    actor_id: "agent-1",
    role: "executor",
    expected_revision: null,
    status: "executing",
    definition: { definition_sha256: pkg.tasks.find((t) => t.task_id === "T-2")!.definition_sha256, plan_revision: pkg.plan_revision ?? "" },
  });
  const pkgWithState = buildContextPackage(MAIN, { question: "T-2" });
  ok(
    pkgWithState.brief.task_counts.executing === 1 && pkgWithState.brief.text.includes("T-2"),
    `① 项目简报带施工运行状态（executing ${pkgWithState.brief.task_counts.executing} 张，点名 T-2）`,
  );
  ok(
    readTaskStates(projectWorkDir(MAIN, dataDir)).states["T-2"]?.status === "executing",
    "① 状态来自已提交事件投影（不是手造快照）",
  );

  // ═════════════════ ② 三个失败用例的回归 + 账本口径 ═════════════════
  info("═══ ② 覆盖账本：失败/截断/清单上限都不许算已读 ═══");
  const ledger = new CoverageLedger();
  // 清单里放一个"已登记但读不到"的路径（模拟：清单收好之后源被人删了）——
  // 这正是旧实现把"点过"记成"已读"的典型现场
  const vanishedRel = "src/vanished.txt";
  const manifestPaths = ["src/app.ts", vanishedRel, "src/big-a.txt", "src/big-b.txt", "tests/check_test.py"];
  ledger.setManifest(manifestPaths, { truncated: true, binaryExcluded: ["assets/blob.png"] });

  // ②-1 批量读超总量上限：后一个文件"未读"，绝不算已读（旧实现把"点过"记成"已读"）
  const batch = executeChatTool(MAIN, "read_files", JSON.stringify({ paths: ["src/big-a.txt", "src/big-b.txt"] }));
  const rBigA = receiptOf(batch, "src/big-a.txt");
  const rBigB = receiptOf(batch, "src/big-b.txt");
  ok(
    batch.result.includes("未读：整批总量已达上限") && rBigB?.status === "not_read" && rBigB?.range === null,
    "②-1 批量读超限：后一个文件如实标「未读」（一个字节都没返回）",
  );
  for (const r of batch.reads ?? []) {
    ledger.noteRequest(r.path);
    ledger.noteReceipt(r);
  }
  const bigBEntry = ledger.entriesOf().find((e) => e.path === "src/big-b.txt");
  ok(
    bigBEntry !== undefined && bigBEntry.requested === 1 && bigBEntry.taken >= 1 && bigBEntry.complete === false,
    "②-1 **请求过 ≠ 读到**：账本记了请求（requested=1）但状态不是已覆盖（旧实现正是在这里记成已读）",
  );
  ok(
    rBigA !== null && rBigA.status === "truncated" && rBigA.complete === false && rBigA.chars === linesOf(BIG_A, rBigA.range!).length,
    `②-1 长文件截断：只算读到一部分（${rBigA?.chars} 字 / 共 ${rBigA?.total?.chars} 字），回执字数与实际返回一致`,
  );
  ok(
    segmentOfToolResult(batch.result, "src/big-a.txt").includes(linesOf(BIG_A, rBigA!.range!)),
    "②-1 回执范围与真实返回的那段逐字一致（不是只报个数字）",
  );

  // ②-2 单文件截断 → 必须分段续读补齐才算读全（范围并集判据）
  const ledger2 = new CoverageLedger();
  ledger2.setManifest(["src/big-a.txt"]);
  let cursor: string | null = null;
  let guard = 0;
  do {
    const page = readFilePaged(mainRoot, "src/big-a.txt", cursor === null ? {} : { cursor });
    ledger2.noteReceipt(page.receipt);
    cursor = page.receipt.next_cursor;
    guard++;
  } while (cursor !== null && guard < 200);
  const done = ledger2.entriesOf().find((e) => e.path === "src/big-a.txt");
  ok(
    guard > 1 && done?.complete === true,
    `②-2 分段续读 ${guard} 次把长文件补齐后**才**算读全（成功读一段 ≠ 读完）`,
  );
  ok(
    rangesCoverAll([{ unit: "lines", start: 1, end: 5 }, { unit: "lines", start: 6, end: 9 }], 9) === true &&
      rangesCoverAll([{ unit: "lines", start: 1, end: 5 }], 9) === false &&
      rangesCoverAll([{ unit: "lines", start: 1, end: 5 }, { unit: "lines", start: 7, end: 9 }], 9) === false,
    "②-2 覆盖 = 范围并集（有洞不算读全）",
  );

  // ②-3 失败路径（不存在/目录）与二进制排除：都不计入已读，且逐条说明原因
  const failedReads = executeChatTool(
    MAIN,
    "read_files",
    JSON.stringify({ paths: ["src/app.ts", "不存在.ts", vanishedRel, "assets/blob.png", "docs"] }),
  );
  for (const r of failedReads.reads ?? []) {
    ledger.noteRequest(r.path);
    ledger.noteReceipt(r);
  }
  const rMissing = receiptOf(failedReads, "不存在.ts");
  const rVanished = receiptOf(failedReads, vanishedRel);
  const rBinary = receiptOf(failedReads, "assets/blob.png");
  const rDir = receiptOf(failedReads, "docs");
  ok(rMissing?.status === "failed", "②-3 读不到的文件（不存在）记失败，不计已读");
  ok(rVanished?.status === "failed", `②-3 清单里的路径读不到也记失败（${vanishedRel}）`);
  ok(rBinary?.status === "binary_excluded", "②-3 二进制文件排除读取，如实标 binary_excluded（不隐藏排除）");
  ok(rDir?.status === "failed", "②-3 目录当文件读记失败，不计已读");
  const appEntry = ledger.entriesOf().find((e) => e.path === "src/app.ts");
  ok(appEntry?.complete === true, "②-3 真读到的文件（src/app.ts）算已覆盖");

  // 清单上限：回执必须自认"清单 ≠ 全量"
  const summary3 = ledger.summary();
  const receipt3 = formatCoverageReceipt(summary3);
  ok(
    summary3.list_truncated === true &&
      summary3.omitted.some((o) => o.reason === "list_cap") &&
      receipt3.includes("已达上限截断"),
    "②-3 清单上限截断：回执明说「清单不等于全量」（不靠提高上限遮掩）",
  );
  ok(
    summary3.fully_read + summary3.partial + summary3.failed + summary3.never_read === summary3.manifest_files &&
      summary3.manifest_files === manifestPaths.length &&
      summary3.failed === 1 &&
      summary3.omitted.some((o) => o.path === vanishedRel && o.reason === "failed"),
    `②-3 回执分项与清单逐条对账（已读全 ${summary3.fully_read} / 部分 ${summary3.partial} / 失败 ${summary3.failed} / 未读 ${summary3.never_read} / 共 ${summary3.manifest_files}）`,
  );
  ok(
    summary3.binary_excluded === 1 && summary3.omitted.some((o) => o.reason === "binary_excluded"),
    "②-3 二进制排除数量与明细都在账本里（不隐藏排除）",
  );
  ok(
    receipt3.includes("文件清单") && !/全部已读/.test(receipt3),
    "②-3 没读全时回执**不**出现「全部已读」（旧实现的分项缺失已修）",
  );
  const allCovered = new CoverageLedger();
  allCovered.setManifest(["src/app.ts"]);
  const appRead = executeChatTool(MAIN, "read_file", JSON.stringify({ path: "src/app.ts" }));
  for (const r of appRead.reads ?? []) allCovered.noteReceipt(r);
  ok(
    formatCoverageReceipt(allCovered.summary()).includes(`文件清单 1 个，全部已读`),
    "②-3 真读全时才写「全部已读」（既有 ask_flash 回执口径保留）",
  );

  // ②-4 list_files 清单回执：截断要看见
  const listTool = executeChatTool(MAIN, "list_files", "{}");
  ok(
    listTool.list !== undefined && listTool.list.truncated === false && listTool.list.cap > 0,
    `②-4 list_files 返回清单回执（${listTool.list?.returned} 个，cap=${listTool.list?.cap}，truncated=${listTool.list?.truncated}）`,
  );

  // ═════════════════ ③ 游标绑定版本 / 不串项目 ═════════════════
  info("═══ ③ 变动游标、同名文件与不串项目 ═══");
  const page1 = readContextSource(MAIN, "src/big-a.txt", { maxChars: 1000 });
  const staleCursor = page1.next_cursor!;
  const bigA2 = BIG_A.replace("大文件甲 00001", "大文件甲 已改");
  write(bigAAbs, bigA2);
  const changedErr = contextErrorOf(() => readContextSource(MAIN, "src/big-a.txt", { cursor: staleCursor }));
  ok(
    changedErr?.code === "SOURCE_CHANGED",
    `③ 源变了再用旧游标 → 明确 SOURCE_CHANGED（不是静默给旧内容）`,
  );
  const toolStale = executeChatTool(MAIN, "read_file", JSON.stringify({ path: "src/big-a.txt", cursor: staleCursor }));
  ok(
    toolStale.result.includes("SOURCE_CHANGED") && receiptOf(toolStale, "src/big-a.txt")?.reason === "source_changed",
    "③ 工具面同样明确报 SOURCE_CHANGED（回执 status=failed，不静默续读旧内容）",
  );
  const parsed = parseCursor(staleCursor);
  ok(
    parsed !== null &&
      parsed.start === page1.range.end + 1 &&
      parsed.version === page1.version.slice(0, 16) &&
      makeCursor("a".repeat(64), "lines", 3).startsWith("tctx1:aaaa"),
    `③ 游标形态可解析且绑版本（${staleCursor.slice(0, 24)}…，start=${parsed?.start} = 上页末行 + 1）`,
  );
  const badCursor = contextErrorOf(() => readContextSource(MAIN, "src/big-a.txt", { cursor: "随便写的" }));
  ok(badCursor?.code === "INVALID_CURSOR", "③ 形态不合法的游标明确拒绝（INVALID_CURSOR）");
  write(bigAAbs, BIG_A); // 还原夹具

  const crossMain = readContextSource(MAIN, "src/app.ts");
  const crossOther = readContextSource(OTHER, "src/app.ts");
  ok(
    crossMain.text.includes("main") && crossOther.text.includes("other-app") && crossMain.version !== crossOther.version,
    "③ 不同项目同名文件各读各的（内容与哈希都不同，不串项目）",
  );
  const escapeErr = contextErrorOf(() => readContextSource(MAIN, `../${path.basename(otherRoot)}/src/app.ts`));
  ok(escapeErr?.code === "INVALID_INPUT", "③ 越出项目根的路径被拒（不借同名文件读到别的项目）");
  const otherPkg = buildContextPackage(OTHER);
  ok(
    otherPkg.design_revision !== pkg.design_revision && otherPkg.project_id === OTHER,
    "③ 两个项目的上下文包各绑各的设计修订（不串项目）",
  );

  // ═════════════════ ④ 陈旧与增量失效 ═════════════════
  info("═══ ④ 源变化标陈旧、按影响范围增量重建、依赖任务拿到明确失效项 ═══");
  const beforeRefresh = buildContextPackage(MAIN, { question: "T-2" });
  const freshNow = packageStaleness(beforeRefresh, MAIN, dataDir);
  ok(freshNow.stale === false, "④ 没改源时不标陈旧（增量重建的基线）");
  const refreshedNoop = refreshContextPackage(beforeRefresh.package_id, MAIN, { dataDir });
  ok(
    refreshedNoop.invalidation.derived_reused === true && refreshedNoop.invalidation.invalidated_tasks.length === 0,
    "④ 源没变：增量重建直接沿用派生结果、零失效项（不白重算）",
  );

  // 改设计书 → 标陈旧 + 增量重建 + 相关任务失效
  write(designAbs, `${MAIN_DESIGN}\n## 3 新增章节\n这一节是后加的，相关任务的设计依据需要复核。\n`);
  const stale = packageStaleness(beforeRefresh, MAIN, dataDir);
  ok(
    stale.stale === true && stale.changed.some((c) => c.path.endsWith("design.md")),
    `④ 源变化后旧包标陈旧（${stale.stale_reasons[0]?.slice(0, 60)}…）`,
  );
  const refreshed = refreshContextPackage(beforeRefresh.package_id, MAIN, { dataDir });
  ok(
    refreshed.package.design_revision !== beforeRefresh.design_revision &&
      refreshed.invalidation.rebuilt_sources.some((p) => p.endsWith("design.md")) &&
      refreshed.invalidation.derived_reused === false,
    "④ 增量重建：只重读变了的来源并重派生（设计书在 rebuilt，其余仍沿用）",
  );
  ok(
    refreshed.invalidation.invalidated_tasks.length === refreshed.package.tasks.length &&
      refreshed.invalidation.invalidated_tasks.every((t) => t.reason.includes("设计书修订变化")),
    `④ 相关任务收到**明确失效项**（${refreshed.invalidation.invalidated_tasks.map((t) => t.task_id).join("、")}）`,
  );
  ok(
    getContextPackage(beforeRefresh.package_id) !== null &&
      getContextPackage(refreshed.package.package_id) !== null,
    "④ 旧包仍在注册表里（可查历史，不被新包顶掉）",
  );

  // 改施工定义（换交付目标）→ 该任务的定义哈希变化 → 明确失效项点名"待重绑"
  const planAbs = path.join(workbenchOf(mainRoot), "plan.md");
  write(planAbs, PLAN_MD.replace("| T-2 | todo | 砌墙 | T-1 | 墙体验收记录 |", "| T-2 | todo | 砌墙（改） | T-1 | 墙体验收记录 |"));
  const stale2 = buildContextPackage(MAIN, { question: "T-2" });
  const refreshed2 = refreshContextPackage(refreshed.package.package_id, MAIN, { dataDir, question: "T-2" });
  const rebind = refreshed2.invalidation.invalidated_tasks.find((t) => t.task_id === "T-2");
  ok(
    rebind !== undefined && rebind.reason.includes("待重绑") && rebind.before !== rebind.after,
    `④ 施工定义变化 → 点名的明确失效项（${rebind?.reason.slice(0, 30)}…）`,
  );
  ok(stale2.plan_revision !== refreshed.package.plan_revision, "④ 施工图修订号跟着变（版本可查）");

  // ── 伪模型起解（后面几段都要它） ──
  await listen(stubServer, STUB_PORT);
  info(`伪模型（可控 SSE 夹具）已起：${STUB_URL}`);
  process.env.TATAI_DEEPSEEK_BASE_URL = STUB_URL;

  // ═════════════════ ⑤ 模型中断 → 检查点 → 服务器注入续接 ═════════════════
  info("═══ ⑤ 中断保留已确认来源与续接位置，下一轮由服务器注入续接 ═══");
  clearCheckpoint(MAIN, dataDir);
  const checkpointFile = path.join(projectWorkDir(MAIN, dataDir), "context-resume.json");
  let receipt1: ChatTurnReceipt | null = null;
  const stubborn: typeof stubResponder = () => ({ kind: "tools", calls: [{ name: "read_files", args: { paths: ["src/app.ts", "src/util.ts"] } }] });
  stubResponder = stubborn;
  const requestMark1 = stubRequests.length;
  let interruptedText = "";
  for await (const ev of runChatTurn(
    MAIN,
    [
      { role: "system", content: "夹具背景" },
      { role: "user", content: "把所有代码读完再告诉我结论。" },
    ],
    {
      model: "deepseek-flash",
      baseURL: STUB_URL,
      maxToolRounds: 2,
      onReceipt: (r) => {
        receipt1 = r;
      },
    },
  )) {
    if (ev.type === "delta") interruptedText += ev.text;
  }
  const kept = receipt1 as ChatTurnReceipt | null;
  const keptCheckpoint: ResumeCheckpoint | null = kept === null ? null : kept.checkpoint;
  ok(
    kept !== null && kept.interrupted === true && kept.tool_rounds_used === 2 && stubRequests.length - requestMark1 === 2,
    `⑤ 轮次撞顶即中断（跑满 ${kept?.tool_rounds_used} 轮，模型请求 ${stubRequests.length - requestMark1} 次）`,
  );
  ok(
    keptCheckpoint !== null &&
      keptCheckpoint.confirmed_sources.length >= 2 &&
      keptCheckpoint.confirmed_sources.every((c) => c.content_sha256.length === 64),
    `⑤ 检查点保留**已确认来源**（${keptCheckpoint?.confirmed_sources.map((c) => c.path).join("、")}）`,
  );
  ok(
    keptCheckpoint?.resume_position != null &&
      keptCheckpoint.resume_position.cursor !== null &&
      interruptedText.includes("服务器已保留续接现场"),
    `⑤ 检查点保留**续接位置**（${keptCheckpoint?.resume_position?.detail}）`,
  );
  ok(fs.existsSync(checkpointFile), `⑤ 检查点落盘：${path.relative(mainRoot, checkpointFile).replace(/\\/g, "/")}`);
  const saved = loadCheckpoint(MAIN, dataDir);
  ok(
    saved !== null && saved.reason === "tool_rounds_exhausted" && saved.package_id === keptCheckpoint?.package_id,
    "⑤ 检查点可从盘上读回（原因/包 id 对得上）",
  );

  // 源变了 → 已确认来源作废（SOURCE_CHANGED 口径），不得沿用旧内容
  const appAbs = path.join(mainRoot, "src", "app.ts");
  const appBefore = read(appAbs);
  write(appAbs, `${appBefore}// 事后又改了一行\n`);
  const resolution = resolveCheckpoint(saved!, MAIN, dataDir);
  ok(
    resolution.source_changed.some((c) => c.path === "src/app.ts") &&
      !resolution.confirmed_sources.some((c) => c.path === "src/app.ts"),
    "⑤ 已确认来源变了 → 从「已确认」里剔除并明说 SOURCE_CHANGED（不让模型沿用旧内容）",
  );
  write(appAbs, appBefore);

  // 下一轮：服务器注入续接指令（不依赖模型自觉）
  clearCheckpoint(MAIN, dataDir);
  stubResponder = () => ({ kind: "tools", calls: [{ name: "read_files", args: { paths: ["src/app.ts"] } }] });
  for await (const _ of runChatTurn(MAIN, [{ role: "system", content: "夹具背景" }, { role: "user", content: "继续。" }], {
    model: "deepseek-flash",
    baseURL: STUB_URL,
    maxToolRounds: 2,
  })) {
    void _;
  }
  const checkpointAgain = loadCheckpoint(MAIN, dataDir);
  const requestMark2 = stubRequests.length;
  stubResponder = () => ({ kind: "text", text: "（夹具）已按续接现场继续。" });
  for await (const _ of runChatTurn(MAIN, [{ role: "system", content: "夹具背景" }, { role: "user", content: "继续。" }], {
    model: "deepseek-flash",
    baseURL: STUB_URL,
  })) {
    void _;
  }
  const resumedReq = stubRequests.slice(requestMark2).map((r) => r.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n")).join("\n");
  ok(
    checkpointAgain !== null && resumedReq.includes("上一轮被中断") && resumedReq.includes("已确认来源"),
    "⑤ 下一轮由**服务器**注入续接指令（含已确认来源与续接位置，不靠模型自觉）",
  );
  ok(
    !fs.existsSync(checkpointFile),
    "⑤ 正常收工后清掉检查点（中断现场已消化，不会每轮重复注入）",
  );

  // ═════════════════ ⑥ full_coverage 端到端（伪模型驱动真循环） ═════════════════
  info("═══ ⑥ ask_flash full_coverage：回执与实际取回一致 ═══");
  const initialBatch = ["src/app.ts", "不存在.ts", "assets/blob.png", "src/big-a.txt", "src/big-b.txt"];
  let sawCoverageRound = false;
  stubResponder = (messages) => {
    const last = messages[messages.length - 1];
    const text = typeof last?.content === "string" ? last.content : "";
    if (text.includes("覆盖对账：下面这些清单文件你还没读过")) {
      sawCoverageRound = true;
      const unread = pathsFromCoverageInstruction(text);
      return unread.length > 0
        ? { kind: "tools", calls: [{ name: "read_files", args: { paths: unread.slice(0, 10) } }] }
        : { kind: "text", text: "（夹具）没有可读的了。" };
    }
    if (messages.some((m) => m.role === "tool")) {
      return { kind: "text", text: "（夹具）基于已读文件的结论：暗记在 src/app.ts。" };
    }
    return { kind: "tools", calls: [{ name: "read_files", args: { paths: initialBatch } }] };
  };
  const flashResult = await askFlashTool.handler({
    project_id: MAIN,
    question: "项目里有哪些暗记？把清单文件都读完再回答。",
    full_coverage: true,
  });
  const flashText = (flashResult.content[0] as { text: string }).text;
  info(`⑥ ask_flash 返回（前 200 字）：${flashText.slice(0, 200).replace(/\n/g, "⏎")}`);
  const flashJson = JSON.parse(flashText) as {
    answer?: string;
    tools_used?: string[];
    coverage?: {
      manifest_files: number;
      fully_read: number;
      partial: number;
      failed: number;
      never_read: number;
      binary_excluded: number;
      list_truncated: boolean;
      omitted: { path: string; reason: string }[];
    } | null;
  };
  const cov = flashJson.coverage;
  ok(sawCoverageRound && (flashJson.tools_used?.length ?? 0) > 0, "⑥ 覆盖对账自动点名续读被真执行（服务器数出来的差集）");
  ok(cov !== null && cov !== undefined, "⑥ ask_flash 返回结构化覆盖账本（与回答正文同一份）");
  if (cov !== null && cov !== undefined) {
    ok(
      cov.fully_read + cov.partial + cov.failed + cov.never_read === cov.manifest_files,
      `⑥ 账本分项与清单逐条对账（已读全 ${cov.fully_read} / 部分 ${cov.partial} / 失败 ${cov.failed} / 未读 ${cov.never_read} / 共 ${cov.manifest_files}）`,
    );
    ok(
      cov.partial >= 1 && cov.omitted.some((o) => o.path === "src/big-a.txt" && o.reason === "truncated"),
      "⑥ 截断的长文件在账本里是「只读到一部分」+ 未覆盖明细（真失败/截断不再算已读）",
    );
    ok(
      cov.never_read >= 1 &&
        cov.omitted.some((o) => o.reason === "not_read" || o.reason === "failed") &&
        cov.fully_read < cov.manifest_files,
      "⑥ 清单里没读到的算「未读/失败」并点名，不粉饰成全量覆盖",
    );
    ok(cov.binary_excluded >= 1, `⑥ 二进制按扩展名排除且如实计数（${cov.binary_excluded} 个）`);
    ok(
      (flashJson.answer ?? "").includes("覆盖对账（服务器机械核验）") &&
        (flashJson.answer ?? "").includes(`文件清单 ${cov.manifest_files} 个`) &&
        !(flashJson.answer ?? "").includes("全部已读"),
      "⑥ 回答里的回执与结构化账本同一份（没读全就不写「全部已读」）",
    );
    const manifest = collectFiles(mainRoot, "", 2000).files;
    ok(
      manifest.some((f) => f.startsWith("tests/")) && !manifest.some((f) => f.startsWith("node_modules/")),
      "⑥ 对账清单含 tests、跳依赖垃圾（口径与 list_files 同源，不跳 tests）",
    );
  }

  // ═════════════════ ⑦ 聊天背景仍注入设计书 + 真服务端到端不落盘 ═════════════════
  info("═══ ⑦ 背景由分层上下文产出：设计书暗记/施工图/基线都在，落盘口径不变 ═══");
  const background = buildChatContext(MAIN);
  ok(background.includes(DESIGN_MARKER), "⑦ 背景含设计书内容（暗记在首段，长设计也照样进模型请求）");
  ok(
    background.includes("【施工图任务定义") && background.includes("T-2") && background.includes("【生效决定 / 基线】"),
    "⑦ 背景含施工图任务与生效决定/基线（原「只有设计前 2 万字符」的缺口已补）",
  );
  ok(
    background.includes("【覆盖与未覆盖（服务器登记）】") && background.includes("未覆盖"),
    "⑦ 背景明说实际覆盖与未覆盖范围（不拿截断当全部理解）",
  );

  if (await portListening(HTTP_PORT)) {
    throw new Error(`端口 ${HTTP_PORT} 被占用，先清理残留进程`);
  }
  const child = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(HTTP_PORT), TATAI_DEEPSEEK_BASE_URL: STUB_URL },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO,
  });
  spawned.push(child);
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  const BASE = `http://localhost:${HTTP_PORT}`;
  await waitUp(BASE);
  info(`真服务子进程已起：${BASE}`);
  try {
    stubResponder = () => ({ kind: "text", text: "（夹具）背景已收到。" });
    const r0 = await fetch(`${BASE}/api/projects/${MAIN}/chat/sessions`, { method: "POST" });
    const j0 = (await r0.json()) as { session_id?: string };
    if (!j0.session_id) throw new Error(`创建会话失败：${JSON.stringify(j0)}`);
    const requestMark = stubRequests.length;
    const res = await fetch(`${BASE}/api/projects/${MAIN}/chat/sessions/${j0.session_id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "设计书里的暗记是什么？" }),
    });
    ok(
      res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/event-stream"),
      "⑦ 真服务端到端：POST messages → 200 + text/event-stream",
    );
    const sse = await res.text();
    ok(sse.includes("data: "), "⑦ SSE 有数据事件");
    const sentMessages = stubRequests
      .slice(requestMark)
      .flatMap((r) => r.messages)
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    ok(
      sentMessages.includes(DESIGN_MARKER) && sentMessages.includes("【施工图任务定义") && sentMessages.includes("【生效决定 / 基线】"),
      "⑦ 背景（设计书 + 施工图 + 基线）真的作为 system 消息进了模型请求",
    );
    ok(
      sentMessages.includes("你是「塔台」工作台里的 Flash 助手"),
      "⑦ 能力清单原样保留（既有背景注入断言不退化）",
    );
    const rb = await fetch(`${BASE}/api/projects/${MAIN}/chat/sessions/${j0.session_id}`);
    const jb = (await rb.json()) as { messages?: { role: string }[] };
    const roles = (jb.messages ?? []).map((m) => m.role);
    ok(
      roles.length === 2 && roles[0] === "user" && roles[1] === "assistant" && !roles.includes("system"),
      `⑦ 落盘仍 user+assistant 两行、无 system/tool 行（实际 ${JSON.stringify(roles)}）`,
    );
  } finally {
    child.kill();
    await sleep(300);
  }

  // ── 收尾：塔台根文档零改动 ──
  stubServer.close();
  const docHashesAfter = new Map(REPO_FILES.map((f) => [f, sha256File(path.join(REPO, f))]));
  console.log("=".repeat(72));
  console.log("[verify] 塔台根文档 sha256（收工后）");
  let unchanged = true;
  for (const [f, h] of docHashesAfter) {
    const same = docHashesBefore.get(f) === h;
    if (!same) unchanged = false;
    console.log(`[verify]   ${f}  ${h}  ${same ? "（未变）" : "（**变了**）"}`);
  }
  console.log("=".repeat(72));
  ok(unchanged, "⑧ 塔台根文档（DESIGN.md/PLAN.md/PROGRESS.md/AGENTS.md/README.md）首尾哈希一致，零改动");
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
