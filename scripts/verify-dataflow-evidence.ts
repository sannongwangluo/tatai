// 数据流向图「可复跑实测」判据的真实修复验证（V09-61；finding f-4c71d59ab5552d36）。
// 用法：pnpm exec tsx scripts/verify-dataflow-evidence.ts
//
// 修复前（反例，已实证）：`resolveMeasured` 只要「脚本文件在 + 登记在 package.json + 脚本正文含定位片段」
// 就给 `code_measured` → `verification === "verified"`。于是**脚本实际 exit 1 也照样绿**。
// 反例现场：`.工作台/project-completion-20261008/probe-measured.ts` 与 `measured-false-green.json`。
//
// 初版（第一轮）只扫 `evidence/` 目录里任意 self_check/independent_audit 小正文看 exit_code=0——复审判定不足：
//   · `store` 能把任意正文落成证据，它**不核**有没有正式审计记录引用并采信 → 孤立自报 blob 也能造绿；
//   · 缺省只绑脚本本体 → 实际被测业务源码变化仍绿；
//   · 同 spec 按任意可成立旧记录优先（哈希序）→ 失败新记录存在仍挑旧成功、可被不对应脚本遮挡。
// 本轮把采信起点改成**既有正式 self_check/independent_audit 记录的引用**，并按既有唯一证据规则
// （`checksWithSourceManifests` / `checkEffectiveness` / `pickCheckRecords`）核有效性；依赖范围从**被证明
// 节点/边的代码 claims + 显式声明 + package 绑定**推出完整有限集合。判据见 `src/arch/dataflowEvidence.ts`。
//
// 本脚本把「脚本存在 ≠ 跑过 ≠ 通过 ≠ 覆盖的源没变 ≠ 有正式引用采信」逐条变成可复跑的断言，正负例都在
// 隔离夹具里真跑（真经**唯一写服务**登记正式 self_check/independent_audit/fix 事件，真落内容寻址证据）：
//   ① 同 probe 修后不绿：脚本真 exit 1，图上不得标「已验证」（降为可复跑线索 code_static）。
//   ② 正式成功检查 + 当前完整源清单 ⇒ 绿（真经唯一写服务登记自检事件，真落源清单载体）。
//   ③ 业务实现源变不绿（脚本未变）：被证明节点的实现文件一变 ⇒ 源清单现读 invalidated ⇒ 退回未核实。
//   ④ 失败运行 exit_code != 0 不绿。
//   ⑤ 证据正文被篡改（内容地址对不上）不绿。
//   ⑥ 运行记录只证别的 spec_id 不绿。
//   ⑦ 范围不覆盖不绿：源清单没覆盖本条依赖的实现文件 ⇒ 未核实。
//   ⑧ 运行记录 script 与条目声明不一致不绿。
//   ⑨ 证据不是 source_manifest 载体（无源清单）不绿。
//   ⑩ 快照输入随证据失效；无关证据不 churn；同输入稳定。
//   ⑪ fail-closed 缺省：`analyzeDataFlowAt` 缺省空索引 ⇒ 即使有成功证据也不绿。
//   ⑫ 线索保留：降级后脚本仍作为 code_static 出处在场。
//   ⑬ 【新增】孤立自报 blob 不绿：只经 `putEvidence` 落一份完美正文、没有正式记录引用 ⇒ 图上不绿。
//   ⑭ 【新增】先成功后独审失败不绿；合法修复（fix 事件）+ 非作者复测闭环后恢复。
//   ⑮ 【新增】不相关 spec/source/脚本不能串：别的条目/别的源/别的脚本都带不动本条。
//   ⑯ 【新增】同输入快照稳定；事实/源变 ⇒ 身份变（旧游标被拒）。
//   ⑰ 【复审返工】正式录入走**既有** `record_work_evidence` 工具 + `WorkServiceClient` 经**隔离拥有的唯一宿主**
//      （`createWorkHost`，与桌面/daemon 同一份、含所有权闸）——**非**裸 `new WorkService({dataDir})` 直写。
//   ⑱ 同一条目两份记录：脚本对不上的（更新的）新记录不得遮挡对应的那份。
//   ⑲ 【第三轮】普通原始失败日志 / 缺 evidence 的正式失败：独立失败否决不被绕过（复现 finding 的假绿现场）——
//      **先对所有相关正式检查挑/否决，再核最终成功 winner 的载体**；失败与 unknown 不因载体格式被删除。
//   ⑳ 【第三轮】同 ID 不同对象不串：object_id+check_id 分组，跨对象复测不解除对方的失败。
//   ㉑ 【第三轮】作者集合按被审对象取：别处做过作者，不把本任务的独立审计降级（独立失败否决不被撤销）。
//   ㉒ 【第三轮】声明定义变而 code/脚本不变 ⇒ 不绿（运行记录绑定纯声明定义哈希，不含运行证据指纹、无循环）。
//   ㉓ 【第三轮】全部候选被拒：被拒事实进指纹/快照身份（不是同一 empty 常量）；完全无关记录不 churn。
//   ㉔ 【复审返工·治理负例】他人所有权（描述符 pid 属别进程）/ 无有效宿主时，经工具+客户端**不能私写**
//      （零事件零证据）；`independent_audit` 缺 coverage 直接拒（工具不自动填 checked），显式依据原样落账。
//   ㉕ 【复审返工】六图 `data_flow` 图层继承独立 failed 普通日志否决（六图与目标图共用同一适配器，不先筛载体）。
//
// 隔离口径（AGENTS.md §5）：一切写操作在 os.tmpdir() 夹具里（独立 dataDir + 独立项目根 + 动态端口宿主，**绝不 8787**），
// 收尾自清且**先确认目标在临时根内**；真实 `.工作台/work/` 与真实 DESIGN.md/PLAN.md **只读**；
// 不调任何生产 MCP 写工具、不动真实事件账本、不跑完整 v19/v22/build/install、不为纳管项目加埋点。
// 唯一写进真实项目的是本卡的**报告产物**：`.工作台/project-completion-20261008/measured-governance/`。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  analyzeDataFlow,
  analyzeDataFlowAt,
  resolveDataFlowDeclaration,
  type ProjectIndex,
} from "../src/arch/dataflow";
import { sixGraphsOf } from "../src/arch/sixGraphs";
import { readMeasuredRunIndex, emptyMeasuredRunIndex, DF_MEASURED_CHECK_PREFIX } from "../src/arch/dataflowEvidence";
import { addProject } from "../src/server/registry";
import { putEvidence, type EvidenceBlob } from "../src/server/work/evidence";
import { openFinding, readFindings } from "../src/server/work/evidence";
import { WorkService, WorkServiceClient } from "../src/server/work/service";
import { createWorkHost } from "../src/server/workHost";
import { submitSelfCheck, submitIndependentAudit, submitFix, COVERAGE_AREAS } from "../src/server/work/audit";
import { projectWorkDir } from "../src/server/workstation";
import { recordWorkEvidenceTool } from "../src/mcp/tools/recordWorkEvidence";
import type { McpTool, ToolResult } from "../src/mcp/tools/types";
import { REPO_ROOT } from "./lib/fixtures";

let pass = 0;
const fails: string[] = [];
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass += 1;
  else {
    fails.push(label);
    process.exitCode = 1;
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);
const section = (t: string): void => console.log(`\n[verify] ── ${t}`);
const sha256Hex = (t: string): string => crypto.createHash("sha256").update(t, "utf8").digest("hex");

const REPORT_DIR = process.env.TATAI_DATAFLOW_EVIDENCE_REPORT_DIR ?? path.join(REPO_ROOT, ".工作台", "project-completion-20261008", "measured-governance");
const cases: Record<string, unknown> = {};
const report: Record<string, unknown> = { tool: "verify-dataflow-evidence", generated_at: new Date().toISOString(), cases };

// ─────────────────────────── 隔离临时目录（收尾自清，先确认在临时根内） ───────────────────────────
const TMP_ROOT = path.resolve(os.tmpdir());
const CLEANUP: string[] = [];
/** 隔离宿主 HTTP 服务器收尾（关监听 + 撤描述符）；在删临时目录前先跑，且幂等。 */
const HOST_CLOSERS: (() => void)[] = [];
const mkTmp = (tag: string): string => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `tatai-dfev-${tag}-`));
  CLEANUP.push(dir);
  return dir;
};
const cleanup = (): void => {
  for (const close of HOST_CLOSERS.reverse()) {
    try {
      close();
    } catch {
      /* 收尾尽力而为 */
    }
  }
  for (const dir of CLEANUP.reverse()) {
    const abs = path.resolve(dir);
    if (abs === TMP_ROOT || !abs.startsWith(TMP_ROOT + path.sep)) {
      console.error(`[verify] 拒绝清理临时根外的目标：${abs}`);
      continue;
    }
    fs.rmSync(abs, { recursive: true, force: true });
  }
};
const writeFile = (abs: string, text: string): void => {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
};

// ─────────────────────────── 夹具：项目根 + 声明 + 运行证据 ───────────────────────────
const MARKER = "MEASURED_MARKER";
const BIZ = "src/biz.ts";
const BIZ_BODY = "export const biz = 1;\n";
const SPEC_ID = `${DF_MEASURED_CHECK_PREFIX}fx`;
type Bind = { revision_kind: "design" | "plan" | "interface" | "code"; revision: string };

interface Proj {
  home: string;
  id: string;
  root: string;
  workDir: string;
  declPath: string;
  scriptPath: string;
  service: WorkService;
  submitter: { submit: (c: unknown) => unknown };
}

const node = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "n1",
  kind: "process",
  label: "夹具节点",
  role: "process",
  claims: [{ tier: "code_static", path: BIZ, find: "export const biz", note: "实现文件：夹具业务逻辑" }],
  static_clues: [],
  ...extra,
});

const measuredSpec = (o: { id?: string; script?: string; npm?: string; sources?: string[]; node_ids?: string[] } = {}): Record<string, unknown> => {
  const script = o.script ?? "scripts/fx.ts";
  return {
    id: o.id ?? SPEC_ID,
    script,
    npm_script: o.npm ?? "verify:fx",
    find: MARKER,
    proves: "夹具：真走一次被测路径",
    ...(o.sources === undefined ? {} : { sources: o.sources }),
    artifact_ids: [],
    node_ids: o.node_ids ?? ["n1"],
    edge_ids: [],
  };
};

let projSeq = 0;
/** 造一个隔离项目（独立 dataDir + 独立项目根） */
function mkProject(opts: {
  specs?: Record<string, unknown>[];
  nodes?: Record<string, unknown>[];
  scriptBody?: string;
  extraFiles?: Record<string, string>;
} = {}): Proj {
  const home = mkTmp("home");
  const root = mkTmp("proj");
  const id = `fx${(projSeq += 1)}`;
  const scriptRel = "scripts/fx.ts";
  const body = opts.scriptBody ?? `// ${MARKER}\nexport const fx = 1;\n`;
  writeFile(path.join(root, "design.md"), `# 夹具设计\n\n### 2.2 每个项目内的\n\n- 夹具数据\n`);
  writeFile(path.join(root, scriptRel), body);
  writeFile(path.join(root, BIZ), BIZ_BODY);
  writeFile(path.join(root, "package.json"), JSON.stringify({ name: id, scripts: { "verify:fx": `tsx ${scriptRel}` } }, null, 2));
  for (const [rel, text] of Object.entries(opts.extraFiles ?? {})) writeFile(path.join(root, ...rel.split("/")), text);
  const declPath = path.join(root, ".工作台", "arch", "dataflow-index.json");
  writeFile(
    declPath,
    JSON.stringify(
      {
        version: 1,
        design_path: "design.md",
        artifacts: [],
        nodes: opts.nodes ?? [node()],
        edges: [],
        chains: [],
        measured: opts.specs ?? [measuredSpec()],
      },
      null,
      2,
    ),
  );
  addProject({ id, name: id, path: root, kind: "backend" }, home);
  const service = new WorkService({ dataDir: home });
  const submitter = { submit: (c: unknown) => service.submit(c as never) };
  return { home, id, root, workDir: projectWorkDir(id, home), declPath, scriptPath: path.join(root, scriptRel), service, submitter };
}

interface RunRecord {
  kind: "measured_run";
  version: number;
  run_id: string;
  spec_ids: string[];
  script: string;
  declaration_sha256?: string;
  command?: string;
  exit_code: number;
  output_summary?: string;
}

/** 当前解析声明的纯声明定义哈希（真实录入协议里由 `store` 自动绑定；夹具用同一函数取） */
const declShaOf = (P: Proj): string => resolveDataFlowDeclaration(P.id, { dataDir: P.home }).definition_sha256;

/** 读运行证据索引（夹具一律带上当前声明定义哈希，模拟产品读口 `resolveDataFlowDeclaration` 的完整输入） */
const readIdx = (P: Proj, scripts?: ReadonlyMap<string, string>) =>
  readMeasuredRunIndex(P.root, scripts, { declarationDefinitionSha: declShaOf(P) });

/**
 * 经唯一写服务落一份**运行记录载体**：kind=source_manifest，content=运行记录 JSON，source_manifest=覆盖的源文件。
 * （这就是真实成功闭环第一步：保存源清单与运行原始证据。）返回 blob（含指纹）。
 * 运行记录**自动绑上当前纯声明定义哈希**（与正式录入协议同一口径：经既有 `record_work_evidence` 工具
 * store，见 `⑰`；原计划的新公共 CLI `scripts/record-measured-run.ts` 已按复审决定移除、原样归档于
 * `.工作台/project-completion-20261008/measured-governance/archive/`）。
 */
function storeRun(
  P: Proj,
  run: RunRecord,
  cover: string[],
  opts: { envelopeKind?: "source_manifest" | "self_check" } = {},
): EvidenceBlob {
  const envelopeKind = opts.envelopeKind ?? "source_manifest";
  const record: RunRecord = { ...run, declaration_sha256: run.declaration_sha256 ?? declShaOf(P) };
  const content = JSON.stringify(record, null, 2);
  return putEvidence(P.workDir, {
    content,
    kind: envelopeKind,
    summary: `夹具运行记录（${run.spec_ids.join(",")}）`,
    created_by: "verify-dataflow-evidence",
    role: "executor",
    binding: { revision_kind: "code", revision: `run:${run.run_id}` },
    ...(envelopeKind === "source_manifest" ? { source_manifest: cover } : {}),
  });
}

const coverage = COVERAGE_AREAS.map((area) => ({ area, status: "checked" as const, basis: `夹具查了 ${area}` }));

/** 登记一条正式自检（作者自检；真经唯一写服务落事件）。`actor` 缺省 author；`task` 缺省 null。 */
function selfCheckPass(
  P: Proj,
  o: {
    id: string;
    checkId?: string;
    evidenceSha: string;
    fingerprint: string;
    command?: string | null;
    exitCode?: number | null;
    verifies?: "code" | "document" | "artifact";
    actor?: string;
    task?: string | null;
  },
): void {
  const actor = o.actor ?? "author";
  submitSelfCheck(P.submitter as never, {
    project_id: P.id,
    change_id: "chg-dfev",
    actor_id: actor,
    role: "executor",
    record_id: o.id,
    task_id: o.task ?? null,
    round: 1,
    checked_by: actor,
    conclusion: "pass",
    binding: { revision_kind: "code", revision: o.fingerprint } as Bind,
    checks: [
      {
        check_id: o.checkId ?? SPEC_ID,
        method: "夹具定向检查（真跑后按输出判）",
        evidence_sha256: o.evidenceSha,
        verifies: o.verifies ?? "code",
        command: o.command ?? null,
        exit_code: o.exitCode ?? 0,
      },
    ],
  });
}

/** 登记一条正式独立审计（非作者）。`task` 缺省 null；`authorId` 缺省 author。`evidenceSha` 允许空串（缺证据的失败）。 */
function indepAudit(
  P: Proj,
  o: {
    id: string;
    checkId?: string;
    auditor: string;
    result: "passed" | "failed";
    evidenceSha: string;
    fingerprint: string;
    task?: string | null;
    authorId?: string;
    findings?: string[];
    resolves?: string[];
    fix_refs?: string[];
  },
): void {
  submitIndependentAudit(P.submitter as never, {
    project_id: P.id,
    change_id: "chg-dfev",
    actor_id: o.auditor,
    role: "auditor",
    record_id: o.id,
    task_id: o.task ?? null,
    round: 1,
    auditor: o.auditor,
    author_id: o.authorId ?? "author",
    conclusion: o.result === "passed" ? "pass" : "fail",
    binding: { revision_kind: "code", revision: o.fingerprint } as Bind,
    coverage,
    checks: [{ check_id: o.checkId ?? SPEC_ID, result: o.result, evidence_sha256: o.evidenceSha, scope: [] }],
    findings: o.findings ?? [],
    ...(o.resolves === undefined ? {} : { resolves: o.resolves }),
    ...(o.fix_refs === undefined ? {} : { fix_refs: o.fix_refs }),
  });
}

const nodeOf = (m: { nodes: { id: string; verification: string; evidence: { tier: string; note: string; rerun: string | null }[] }[] }, id = "n1") =>
  m.nodes.find((n) => n.id === id);
const measuredRefs = (m: { nodes: { evidence: { tier: string }[] }[] }): { tier: string }[] =>
  m.nodes.flatMap((n) => n.evidence).filter((e) => e.tier === "code_measured");
const notesJoined = (m: { scan: { notes: string[] } }): string => m.scan.notes.join("\n");

// ─────────────────────────── 真实工具 + 客户端 + 隔离拥有的唯一宿主（V09-61 复审返工） ───────────────────────────
/**
 * 起一个**隔离拥有的唯一写宿主**：`createWorkHost`（与桌面后端/独立 daemon **同一份**，含所有权闸
 * `assertWriteOwnership`）绑动态端口 + 发布描述符；`WorkServiceClient` 经描述符发现它并发写。
 * **不用裸 `new WorkService({ dataDir })` 直写**——那正是被复审阻断的旁路（INDEP-01：绕过唯一宿主）。
 */
async function startOwnedHost(home: string): Promise<{ port: number; token: string; close: () => void }> {
  const host = createWorkHost(home);
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    void host
      .handle(req, res, pathname)
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end("{}");
        }
      })
      .catch((e: unknown) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ code: "INTERNAL", message: e instanceof Error ? e.message : String(e) }));
      });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  host.publish(port, "127.0.0.1");
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try { host.unpublish(); } catch { /* 描述符可能已易主：尽力而为 */ }
    try { (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); } catch { /* 老 node 无此 API */ }
    try { server.close(); } catch { /* 已关 */ }
  };
  HOST_CLOSERS.push(close);
  return { port, token: host.token, close };
}

/** 调**真实** MCP 工具 handler（经 `ctx.work` 转接唯一宿主），把 text 回执解析成 JSON。 */
async function callTool(tool: McpTool, args: Record<string, unknown>, ctx: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: any }> {
  const r = (await tool.handler(args, ctx as never)) as ToolResult;
  const text = r.content.map((c) => c.text).join("\n");
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { isError: r.isError === true, text, json };
}

/** 六图（`data_flow` 技术详情图）目标层里某节点的验证态——六图与目标图**共用** `resolveDataFlowDeclaration→readMeasuredRunIndex`。 */
function sixGraphDataFlowNode(projectId: string, home: string, id = "n1"): { verification: string; tiers: string[] } | null {
  const snap = sixGraphsOf(projectId, { dataDir: home }) as unknown as {
    graphs?: Record<string, { tech?: { nodes?: { id: string; verification: string; evidence: { tier: string }[] }[] } }>;
  };
  const n = snap.graphs?.data_flow?.tech?.nodes?.find((x) => x.id === id);
  return n === undefined ? null : { verification: n.verification, tiers: n.evidence.map((e) => e.tier) };
}

async function main(): Promise<void> {
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  // ═════════════ ⑬ 孤立自报 blob 不绿（op=store 存不了绿） ═════════════
  section("⑬ 孤立自报 blob 不绿：只落一份完美正文、没有正式记录引用");
  {
    const P = mkProject();
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-iso", spec_ids: [SPEC_ID], script: "scripts/fx.ts", command: "pnpm verify:fx", exit_code: 0, output_summary: "全绿" }, ["scripts/fx.ts", BIZ, "package.json"]);
    const idx = readIdx(P);
    ok(idx.verdicts.size === 0, `⑬ 只 op=store 落正文：运行证据索引为空（无正式引用；实得 ${idx.verdicts.size} 条）`);
    const model = analyzeDataFlow(P.id, { dataDir: P.home });
    ok(nodeOf(model as never)?.verification !== "verified", `⑬ 图上不得标「已验证」（实得 ${nodeOf(model as never)?.verification}）`);
    ok(measuredRefs(model as never).length === 0, "⑬ 图上没有 code_measured 出处（孤立 blob 造不了绿）");
    ok(nodeOf(model as never)?.evidence.some((e) => e.tier === "code_static") === true, "⑬ 脚本仍作为 code_static 可复跑线索在场");
    cases["isolated_blob"] = { verdicts: idx.verdicts.size, verification: nodeOf(model as never)?.verification, evidence_sha: blob.sha256 };
  }

  // ═════════════ ② 正式成功检查 + 当前完整源清单 ⇒ 绿 ═════════════
  section("② 正式成功检查 + 当前完整源清单 ⇒ 绿（经唯一写服务登记自检事件）");
  {
    const P = mkProject();
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-ok", spec_ids: [SPEC_ID], script: "scripts/fx.ts", command: "pnpm verify:fx", exit_code: 0, output_summary: "全绿" }, ["scripts/fx.ts", BIZ, "package.json"]);
    info(`② 运行记录载体 ${blob.sha256.slice(0, 12)}…，源清单指纹 ${blob.source_manifest?.fingerprint.slice(0, 12)}…`);
    selfCheckPass(P, { id: "sc-ok", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "" });
    const idx = readIdx(P);
    ok(idx.verdicts.get(SPEC_ID)?.verdict_ok === true, `② 读回：条目判决可成立（${idx.verdicts.get(SPEC_ID)?.reasons.join("；") || "ok"}）`);
    const model = analyzeDataFlow(P.id, { dataDir: P.home });
    const n = nodeOf(model as never);
    ok(n?.verification === "verified", `② 图上标「已验证」（实得 ${n?.verification}）`);
    ok(measuredRefs(model as never).length > 0, "② 图上确有 code_measured 出处（真实测）");
    const ref = (model as never as { nodes: { evidence: { tier: string; note: string; rerun: string | null }[] }[] }).nodes[0].evidence.find((e) => e.tier === "code_measured");
    ok((ref?.rerun ?? "").includes("verify:fx"), `② 实测出处带复跑命令（${ref?.rerun}）`);
    ok((ref?.note ?? "").includes("正式运行事实"), `② 实测出处点名「正式运行事实」（${(ref?.note ?? "").slice(0, 60)}…）`);
    cases["valid_evidence"] = { verification: n?.verification, evidence_id: blob.sha256, manifest: blob.source_manifest?.fingerprint, note: ref?.note };
  }

  // ═════════════ ③ 业务实现源变不绿（脚本未变） ═════════════
  section("③ 业务实现源变不绿（脚本未变）：被证明节点的实现文件一变 ⇒ 源清单现读 invalidated");
  {
    const P = mkProject();
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-c3", spec_ids: [SPEC_ID], script: "scripts/fx.ts", command: "pnpm verify:fx", exit_code: 0 }, ["scripts/fx.ts", BIZ, "package.json"]);
    selfCheckPass(P, { id: "sc-c3", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "" });
    ok(nodeOf(analyzeDataFlow(P.id, { dataDir: P.home }) as never)?.verification === "verified", "③ 基线：证据成立时绿");
    // 只改**业务实现文件**（脚本 scripts/fx.ts 一字未动）
    writeFile(path.join(P.root, BIZ), `export const biz = 2; // 改了业务实现\n`);
    const after = analyzeDataFlow(P.id, { dataDir: P.home });
    const n = nodeOf(after as never);
    ok(n?.verification !== "verified", `③ 覆盖的实现源一变即退回未核实（实得 ${n?.verification}）`);
    ok(notesJoined(after as never).includes("invalidated") || notesJoined(after as never).includes("范围不覆盖"), "③ 退回原因可见（源清单现读 invalidated / 范围不覆盖）");
    cases["impl_source_changed"] = { verification: n?.verification };
  }

  // ═════════════ ④ 失败运行不绿 + ⑨ 无源清单不绿 ═════════════
  section("④ 失败运行不绿（exit_code != 0）＋ ⑨ 证据无源清单不绿");
  {
    const P = mkProject();
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-fail", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 1 }, ["scripts/fx.ts", BIZ, "package.json"]);
    // 作者自检声明"通过"、命令退出码写 0，但**运行记录本身**退出码是 1 —— 运行事实必须自洽
    selfCheckPass(P, { id: "sc-fail", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "", command: null });
    const model = analyzeDataFlow(P.id, { dataDir: P.home });
    ok(nodeOf(model as never)?.verification !== "verified", `④ 运行 exit_code=1 不绿（实得 ${nodeOf(model as never)?.verification}）`);
    ok(notesJoined(model as never).includes("退出码"), "④ 退回原因点名「退出码」");

    // ⑨：证据不是 source_manifest 载体（kind=self_check，没有源清单）
    const Q = mkProject();
    const noManifest = storeRun(Q, { kind: "measured_run", version: 1, run_id: "r-noman", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 0 }, [], { envelopeKind: "self_check" });
    selfCheckPass(Q, { id: "sc-noman", evidenceSha: noManifest.sha256, fingerprint: sha256Hex("no-manifest") });
    const nq = nodeOf(analyzeDataFlow(Q.id, { dataDir: Q.home }) as never);
    ok(nq?.verification !== "verified", `⑨ 证据没有可现读复核的源清单 ⇒ 不绿（实得 ${nq?.verification}）`);
    cases["failed_run"] = { verification: nodeOf(model as never)?.verification };
    cases["no_manifest"] = { verification: nq?.verification };
  }

  // ═════════════ ⑤ 篡改不绿 ═════════════
  section("⑤ 篡改不绿：证据正文被改（内容地址对不上）");
  {
    const P = mkProject();
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-tam", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 0 }, ["scripts/fx.ts", BIZ, "package.json"]);
    selfCheckPass(P, { id: "sc-tam", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "" });
    ok(nodeOf(analyzeDataFlow(P.id, { dataDir: P.home }) as never)?.verification === "verified", "⑤ 基线：未篡改时绿");
    const blobPath = path.join(P.workDir, "evidence", `${blob.sha256}.json`);
    const raw = JSON.parse(fs.readFileSync(blobPath, "utf8")) as Record<string, unknown>;
    raw.content = String(raw.content) + "\n// 篡改：追加一字节\n";
    writeFile(blobPath, JSON.stringify(raw, null, 2));
    const after = analyzeDataFlow(P.id, { dataDir: P.home });
    const n = nodeOf(after as never);
    ok(n?.verification !== "verified", `⑤ 篡改后不绿（实得 ${n?.verification}）`);
    ok(notesJoined(after as never).includes("内容地址") || notesJoined(after as never).includes("现场被改过") || notesJoined(after as never).includes("被拒"), "⑤ 退回原因点名「内容地址/现场被改过/被拒」");
    cases["tampered"] = { verification: n?.verification };
  }

  // ═════════════ ⑥ 无关 spec 不绿 + ⑧ 脚本对不上不绿 ═════════════
  section("⑥ 运行记录只证别的 spec_id 不绿 ＋ ⑧ 运行记录 script 与条目声明不一致不绿");
  {
    const P = mkProject();
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-other", spec_ids: ["df-measured-other"], script: "scripts/fx.ts", exit_code: 0 }, ["scripts/fx.ts", BIZ, "package.json"]);
    selfCheckPass(P, { id: "sc-other", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "" });
    const n = nodeOf(analyzeDataFlow(P.id, { dataDir: P.home }) as never);
    ok(n?.verification !== "verified", `⑥ 只证 df-measured-other 的运行记录不给本条背书（实得 ${n?.verification}）`);

    const Q = mkProject({ extraFiles: { "scripts/other.ts": `// ${MARKER}\nexport const other = 1;\n` } });
    const blobQ = storeRun(Q, { kind: "measured_run", version: 1, run_id: "r-script", spec_ids: [SPEC_ID], script: "scripts/other.ts", exit_code: 0 }, ["scripts/fx.ts", BIZ, "package.json", "scripts/other.ts"]);
    selfCheckPass(Q, { id: "sc-script", evidenceSha: blobQ.sha256, fingerprint: blobQ.source_manifest?.fingerprint ?? "" });
    const nq = nodeOf(analyzeDataFlow(Q.id, { dataDir: Q.home }) as never);
    ok(nq?.verification !== "verified", `⑧ 运行记录 script 与条目声明不一致 ⇒ 不绿（实得 ${nq?.verification}）`);
    cases["unrelated_spec"] = { verification: n?.verification };
    cases["script_mismatch"] = { verification: nq?.verification };
  }

  // ═════════════ ⑦ 范围不覆盖不绿 ═════════════
  section("⑦ 范围不覆盖不绿：源清单没覆盖本条依赖的实现文件");
  {
    const P = mkProject();
    // 载体只覆盖脚本与 package.json，**不覆盖** src/biz.ts（被证明节点的实现文件）
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-scope", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 0 }, ["scripts/fx.ts", "package.json"]);
    selfCheckPass(P, { id: "sc-scope", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "" });
    const model = analyzeDataFlow(P.id, { dataDir: P.home });
    const n = nodeOf(model as never);
    ok(n?.verification !== "verified", `⑦ 范围不覆盖 ⇒ 不绿（实得 ${n?.verification}）`);
    ok(notesJoined(model as never).includes("范围不覆盖"), "⑦ 退回原因点名「范围不覆盖」");
    cases["scope_uncovered"] = { verification: n?.verification };
  }

  // ═════════════ ⑭ 先成功后独审失败不绿；合法修复 + 非作者复测闭环后恢复 ═════════════
  section("⑭ 先成功后独审失败不绿；合法修复 + 非作者复测闭环后恢复");
  {
    const P = mkProject();
    const cover = ["scripts/fx.ts", BIZ, "package.json"];
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-veto-1", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 0 }, cover);
    selfCheckPass(P, { id: "sc-veto", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "" });
    ok(nodeOf(analyzeDataFlow(P.id, { dataDir: P.home }) as never)?.verification === "verified", "⑭ 基线：自检通过时绿");
    // 失败独审必须关联**在册** finding（写侧校验）：先真报一条缺陷
    const subWithRead = { submit: (c: unknown) => P.service.submit(c as never), read: () => readFindings(P.workDir) };
    const finding = openFinding(subWithRead as never, {
      project_id: P.id,
      change_id: "chg-dfev",
      actor_id: "author",
      role: "executor",
      severity: "user_visible_defect",
      source: "夹具缺陷：实测运行需复核",
      expected: "正式运行事实应通过独立复核",
      actual: "独审给出失败",
      repro: "夹具复现：跑一次实测并让独立审计判失败",
      evidence_sha256: blob.sha256,
      object_id: null,
    });
    const findingId = finding.finding_id;
    info(`⑭ 在册 finding ${findingId}`);
    // 非作者独审判失败（同 check_id）
    indepAudit(P, { id: "au-veto-fail", auditor: "auditor1", result: "failed", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "", findings: [findingId] });
    const afterFail = analyzeDataFlow(P.id, { dataDir: P.home });
    ok(nodeOf(afterFail as never)?.verification !== "verified", `⑭ 独审失败 ⇒ 不绿（实得 ${nodeOf(afterFail as never)?.verification}）`);
    ok(notesJoined(afterFail as never).includes("失败"), "⑭ 退回原因点名「失败」（独审失败压过自检通过）");
    // 合法修复：改业务实现（新指纹）+ 登记 fix 事件
    writeFile(path.join(P.root, BIZ), `export const biz = 3; // 修复后\n`);
    const fixedBlob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-veto-2", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 0, output_summary: "修复后全绿" }, cover);
    const fixedFp = fixedBlob.source_manifest?.fingerprint ?? "";
    submitFix(P.submitter as never, {
      project_id: P.id,
      change_id: "chg-dfev",
      actor_id: "author",
      role: "executor",
      record_id: "fix-veto",
      finding_id: findingId,
      fix_revision: fixedFp,
      fixed_by: "author",
      evidence_ref: fixedBlob.sha256,
      regression: [{ command: "pnpm verify:fx", exit_code: 0 }],
    });
    // 非作者复测通过并显式解除（resolves + fix_refs）
    indepAudit(P, {
      id: "au-veto-pass",
      auditor: "auditor2",
      result: "passed",
      evidenceSha: fixedBlob.sha256,
      fingerprint: fixedFp,
      resolves: ["au-veto-fail"],
      fix_refs: ["fix-veto"],
    });
    const afterFix = analyzeDataFlow(P.id, { dataDir: P.home });
    const n = nodeOf(afterFix as never);
    ok(n?.verification === "verified", `⑭ 合法修复 + 非作者复测闭环后恢复「已验证」（实得 ${n?.verification}）`);
    ok(measuredRefs(afterFix as never).length > 0, "⑭ 恢复后确有 code_measured 出处");
    cases["veto_then_fix"] = { after_fail: nodeOf(afterFail as never)?.verification, after_fix: n?.verification };
  }

  // ═════════════ ⑮ 不相关 spec/source/脚本不能串 ═════════════
  section("⑮ 不相关 spec/source/脚本不能串：别的条目带不动本条");
  {
    const A = `${DF_MEASURED_CHECK_PREFIX}a`;
    const B = `${DF_MEASURED_CHECK_PREFIX}b`;
    const P = mkProject({
      specs: [
        measuredSpec({ id: A, script: "scripts/fx.ts", node_ids: ["n1"] }),
        measuredSpec({ id: B, script: "scripts/fx.ts", node_ids: ["n2"] }),
      ],
      nodes: [
        node(),
        node({ id: "n2", claims: [{ tier: "code_static", path: "src/biz2.ts", find: "export const biz2", note: "实现文件2" }] }),
      ],
      extraFiles: { "src/biz2.ts": "export const biz2 = 1;\n" },
    });
    // 只给 A 登记成功运行（覆盖 A 的实现文件，不覆盖 B 的）
    const blobA = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-A", spec_ids: [A], script: "scripts/fx.ts", exit_code: 0 }, ["scripts/fx.ts", BIZ, "package.json"]);
    selfCheckPass(P, { id: "sc-A", checkId: A, evidenceSha: blobA.sha256, fingerprint: blobA.source_manifest?.fingerprint ?? "" });
    const model = analyzeDataFlow(P.id, { dataDir: P.home });
    ok(nodeOf(model as never, "n1")?.verification === "verified", `⑮ A 的实现文件被覆盖 ⇒ A 的节点绿（实得 ${nodeOf(model as never, "n1")?.verification}）`);
    ok(nodeOf(model as never, "n2")?.verification !== "verified", `⑮ B 没有运行记录 ⇒ B 的节点不绿（实得 ${nodeOf(model as never, "n2")?.verification}）`);
    const idxAB = readIdx(P);
    ok(idxAB.verdicts.has(A) && !idxAB.verdicts.has(B), "⑮ 运行证据索引只命中 A，不串到 B");
    cases["no_cross"] = { a: nodeOf(model as never, "n1")?.verification, b: nodeOf(model as never, "n2")?.verification };
  }

  // ═════════════ ⑯ 同输入快照稳定；事实/源变旧游标作废 ═════════════
  section("⑯ 同输入快照身份稳定；事实/源变 ⇒ 身份变（旧游标被拒）");
  {
    const P = mkProject();
    const id0 = resolveDataFlowDeclaration(P.id, { dataDir: P.home }).identity;
    ok(id0.includes("|m:"), "⑯ 身份里带运行证据指纹（|m:…）");
    ok(resolveDataFlowDeclaration(P.id, { dataDir: P.home }).identity === id0, "⑯ 同输入重复读取：身份稳定");
    const fp0 = readIdx(P).fingerprint;
    // 无关证据（kind=other）：不进本判据 ⇒ 指纹与身份都不变
    putEvidence(P.workDir, { content: "无关证据：既不是运行记录也不被任何条目引用", kind: "other", summary: "unrelated", created_by: "verify-dataflow-evidence", role: "executor", binding: { revision_kind: "code", revision: "fixture" } });
    ok(readIdx(P).fingerprint === fp0, "⑯ 无关证据（非运行记录）增删不改变指纹（不 churn）");
    ok(resolveDataFlowDeclaration(P.id, { dataDir: P.home }).identity === id0, "⑯ 无关证据增删不改变身份");
    // 落一份正式成功证据：身份必须变
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-id", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 0 }, ["scripts/fx.ts", BIZ, "package.json"]);
    selfCheckPass(P, { id: "sc-id", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "" });
    const id1 = resolveDataFlowDeclaration(P.id, { dataDir: P.home }).identity;
    ok(id1 !== id0, `⑯ 登记成功运行 ⇒ 身份变（${id0.split("|m:")[1]?.slice(0, 8)} → ${id1.split("|m:")[1]?.slice(0, 8)}）`);
    ok(resolveDataFlowDeclaration(P.id, { dataDir: P.home }).identity === id1, "⑯ 新输入重复读取：身份稳定");
    // 覆盖源一变使其失效：身份再变（旧游标被拒）
    writeFile(path.join(P.root, BIZ), `export const biz = 9; // 之后改了实现\n`);
    const id2 = resolveDataFlowDeclaration(P.id, { dataDir: P.home }).identity;
    ok(id2 !== id1 && id2 !== id0, "⑯ 事实/源变 ⇒ 身份再变（旧游标被拒）");
    cases["identity"] = { before: id0, after_evidence: id1, after_invalidated: id2 };
  }

  // ═════════════ ⑪ fail-closed 缺省 ═════════════
  section("⑪ fail-closed 缺省：analyzeDataFlowAt 不传 measured_runs ⇒ 即便有正式成功证据也不绿");
  {
    const P = mkProject();
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-fc", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 0 }, ["scripts/fx.ts", BIZ, "package.json"]);
    selfCheckPass(P, { id: "sc-fc", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "" });
    const decl = JSON.parse(fs.readFileSync(P.declPath, "utf8")) as ProjectIndex;
    const noRuns = analyzeDataFlowAt(decl, { project_id: P.id, root: P.root, scripts: { "verify:fx": "tsx scripts/fx.ts" } });
    ok(nodeOf(noRuns as never)?.verification !== "verified", `⑪ 缺省空索引 ⇒ 不绿（实得 ${nodeOf(noRuns as never)?.verification}）`);
    const withRuns = analyzeDataFlowAt(decl, { project_id: P.id, root: P.root, scripts: { "verify:fx": "tsx scripts/fx.ts" }, measured_runs: readIdx(P) });
    ok(nodeOf(withRuns as never)?.verification === "verified", "⑪ 真传入运行证据索引 ⇒ 绿（证据必须真被读到）");
    cases["fail_closed_default"] = { no_runs: nodeOf(noRuns as never)?.verification, with_runs: nodeOf(withRuns as never)?.verification };
  }

  // ═════════════ ① 同 probe 修后不绿（脚本真 exit 1） ═════════════
  section("① 同 probe 修后不绿：脚本真 exit 1，图上不得标「已验证」（无运行事实）");
  {
    const P = mkProject();
    const cjs = "test.cjs";
    writeFile(path.join(P.root, cjs), `// ${MARKER}\nthrow new Error("deliberate failing test");\n`);
    writeFile(
      P.declPath,
      JSON.stringify(
        {
          version: 1,
          design_path: "design.md",
          artifacts: [],
          nodes: [node()],
          edges: [],
          chains: [],
          measured: [measuredSpec({ script: cjs, npm: "verify:fx" })],
        },
        null,
        2,
      ),
    );
    writeFile(path.join(P.root, "package.json"), JSON.stringify({ name: P.id, scripts: { "verify:fx": `node ${cjs}` } }, null, 2));
    const actual = spawnSync(process.execPath, [path.join(P.root, cjs)], { encoding: "utf8" });
    const model = analyzeDataFlow(P.id, { dataDir: P.home });
    const n = nodeOf(model as never);
    ok(actual.status === 1, `① 脚本真跑退出码 = ${actual.status}（夹具确实失败）`);
    ok(n?.verification !== "verified", `① 图上不得标「已验证」（实得 ${n?.verification}）`);
    ok(measuredRefs(model as never).length === 0, "① 图上没有 code_measured 出处（没有假实测）");
    ok(n?.evidence.some((e) => e.tier === "code_static") === true, "① 脚本仍作为 code_static 可复跑线索在场（线索未被删）");
    cases["probe_after"] = { actual_exit: actual.status, verification: n?.verification };
  }

  // ═════════════ ⑫ 反例回归：旧口径不再成立 ═════════════
  section("⑫ 回归：旧口径「脚本存在即 code_measured」对无证据条目不再成立");
  {
    const P = mkProject();
    const model = analyzeDataFlow(P.id, { dataDir: P.home });
    const allTiers = (model as never as { nodes: { evidence: { tier: string }[] }[] }).nodes.flatMap((n) => n.evidence.map((e) => e.tier));
    ok(!allTiers.includes("code_measured"), `⑫ 无正式运行事实 ⇒ 没有任何 code_measured 出处（实得 ${JSON.stringify([...new Set(allTiers)])}）`);
    ok(notesJoined(model as never).includes("实测未采信"), "⑫ 未采信原因逐条可见（scan.notes 点名「实测未采信」）");
    cases["regression_no_evidence"] = { tiers: [...new Set(allTiers)] };
  }

  // ═════════════ ⑰ 正式录入：既有 record_work_evidence 工具 + WorkServiceClient 经隔离拥有的唯一宿主 ═════════════
  section("⑰ 正式录入：record_work_evidence 经 WorkServiceClient → 隔离拥有的唯一宿主（非裸 WorkService 直写）");
  {
    const P = mkProject();
    const host = await startOwnedHost(P.home);
    const client = new WorkServiceClient({ dataDir: P.home, autostart: false });
    const ctx = { work: client, clientName: "verify-dataflow-evidence" };
    const cover = ["scripts/fx.ts", BIZ, "package.json"];
    const runRecord = {
      kind: "measured_run",
      version: 1,
      run_id: "tool-run-1",
      spec_ids: [SPEC_ID],
      script: "scripts/fx.ts",
      declaration_sha256: declShaOf(P),
      command: "pnpm verify:fx",
      exit_code: 0,
      output_summary: "经工具+客户端录入",
    };
    // ① store：运行记录载体（content=measured_run JSON，source_manifest=覆盖源）经**宿主**落盘
    const store = await callTool(recordWorkEvidenceTool, {
      op: "store",
      project_id: P.id,
      role: "executor",
      kind: "source_manifest",
      summary: `运行记录（${SPEC_ID}）`,
      content: JSON.stringify(runRecord, null, 2),
      binding: { revision_kind: "code", revision: `run:${runRecord.run_id}` },
      source_manifest: cover,
    }, ctx);
    const evidenceId = (store.json?.evidence?.sha256 ?? "") as string;
    const manifestFp = (store.json?.evidence?.source_manifest?.fingerprint ?? "") as string;
    ok(store.isError === false && /^[0-9a-f]{64}$/.test(evidenceId), `⑰ store 经工具+客户端+宿主落证据载体（${evidenceId.slice(0, 12)}…）`);
    ok(manifestFp !== "", "⑰ store 回执带当前源清单指纹（宿主现读算出的 code 修订）");
    // ② read：经同一宿主读回（集成往返）
    const read = await callTool(recordWorkEvidenceTool, { op: "read", project_id: P.id, sha256: evidenceId }, ctx);
    ok(read.isError === false && read.json?.evidence?.sha256 === evidenceId, "⑰ read 经同一宿主读回（集成往返一致）");
    // ③ self_check：作者自检（正式记录）经工具+客户端+宿主登记（不经裸 WorkService）
    const check = await callTool(recordWorkEvidenceTool, {
      op: "self_check",
      project_id: P.id,
      role: "executor",
      change_id: "chg-dfev",
      record_id: "tool-sc-1",
      checked_by: "author",
      conclusion: "pass",
      binding: { revision_kind: "code", revision: manifestFp },
      checks: [{ check_id: SPEC_ID, evidence_sha256: evidenceId, verifies: "code", command: "pnpm verify:fx", exit_code: 0 }],
    }, ctx);
    ok(check.isError === false && check.json?.receipt?.ok === true, "⑰ self_check 经工具登记成功（真经唯一宿主写事件，非裸 WorkService 直写）");
    const idx = readIdx(P);
    ok(idx.verdicts.get(SPEC_ID)?.verdict_ok === true, `⑰ 录入后被读成可成立实测（${idx.verdicts.get(SPEC_ID)?.reasons.join("；") || "ok"}）`);
    const model = analyzeDataFlow(P.id, { dataDir: P.home });
    ok(nodeOf(model as never)?.verification === "verified", `⑰ 图上标「已验证」（实得 ${nodeOf(model as never)?.verification}）`);
    cases["record_tool"] = { store_ok: store.isError === false, check_ok: check.isError === false, evidence_id: evidenceId, verification: nodeOf(model as never)?.verification };
    host.close();
  }

  // ═════════════ ⑱ 脚本对不上的新记录不得遮挡真正对应的那份 ═════════════
  section("⑱ 同一条目两份记录：脚本对不上的（更新的）新记录不得遮挡对应的那份");
  {
    const P = mkProject({ extraFiles: { "scripts/other.ts": `// ${MARKER}\nexport const other = 1;\n` } });
    const cover = ["scripts/fx.ts", "scripts/other.ts", BIZ, "package.json"];
    // 对应的一份（脚本 = scripts/fx.ts）先登记
    const right = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-right", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 0 }, cover);
    selfCheckPass(P, { id: "sc-right", evidenceSha: right.sha256, fingerprint: right.source_manifest?.fingerprint ?? "" });
    // 脚本对不上的一份（scripts/other.ts）后登记 —— 旧口径会因"更新"而挑它并遮住对应者
    const wrong = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-wrong", spec_ids: [SPEC_ID], script: "scripts/other.ts", exit_code: 0 }, cover);
    selfCheckPass(P, { id: "sc-wrong", evidenceSha: wrong.sha256, fingerprint: wrong.source_manifest?.fingerprint ?? "" });
    const idx = readIdx(P, new Map([[SPEC_ID, "scripts/fx.ts"]]));
    ok(idx.verdicts.get(SPEC_ID)?.record_ref === "check:sc-right", `⑱ 生效记录是**对应**的那份（${idx.verdicts.get(SPEC_ID)?.record_ref}）`);
    ok(idx.notes.join(" ").includes("不作为该条目候选"), "⑱ 脚本对不上的记录被点名「不作为该条目候选」（显式披露）");
    const model = analyzeDataFlow(P.id, { dataDir: P.home });
    ok(nodeOf(model as never)?.verification === "verified", `⑱ 图上标「已验证」（对应的一份未被遮挡；实得 ${nodeOf(model as never)?.verification}）`);
    cases["no_shadowing"] = { winner: idx.verdicts.get(SPEC_ID)?.record_ref, verification: nodeOf(model as never)?.verification };
  }

  // ═════════════ ⑲ 普通原始失败日志 / 缺 evidence 失败：独立失败否决不被绕过 ═════════════
  section("⑲ 普通原始失败日志 / 缺 evidence 的正式失败：独立失败否决不被绕过（复现 finding 的假绿现场）");
  {
    const P = mkProject();
    const cover = ["scripts/fx.ts", BIZ, "package.json"];
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-plain", spec_ids: [SPEC_ID], script: "scripts/fx.ts", command: "pnpm verify:fx", exit_code: 0 }, cover);
    selfCheckPass(P, { id: "sc-plain", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "" });
    ok(nodeOf(analyzeDataFlow(P.id, { dataDir: P.home }) as never)?.verification === "verified", "⑲ 基线：正式自检通过 ⇒ verified");
    // 失败独审引用的是**普通原始日志**（kind=independent_audit），不是 measured_run 载体——正是 probe 的现场
    const rawFail = putEvidence(P.workDir, { content: "Independent actual counterexample: assertion failed", kind: "independent_audit", summary: "raw failure", created_by: "auditor1", role: "auditor", binding: { revision_kind: "code", revision: blob.source_manifest?.fingerprint ?? "" } });
    const subWithRead = { submit: (c: unknown) => P.service.submit(c as never), read: () => readFindings(P.workDir) };
    const finding = openFinding(subWithRead as never, { project_id: P.id, change_id: "chg-dfev", actor_id: "auditor1", role: "auditor", severity: "user_visible_defect", source: "夹具：引普通原始日志的失败独审", expected: "正式失败应压过自检通过", actual: "独审判失败", repro: "夹具复现", evidence_sha256: rawFail.sha256, object_id: null });
    indepAudit(P, { id: "au-plain-fail", auditor: "auditor1", result: "failed", evidenceSha: rawFail.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "", findings: [finding.finding_id] });
    const afterPlain = analyzeDataFlow(P.id, { dataDir: P.home });
    ok(nodeOf(afterPlain as never)?.verification !== "verified", `⑲ 引普通原始日志的正式独审失败 ⇒ 不绿（实得 ${nodeOf(afterPlain as never)?.verification}）`);
    ok(measuredRefs(afterPlain as never).length === 0, "⑲ 失败否决后图上没有 code_measured 出处");
    ok(notesJoined(afterPlain as never).includes("失败"), "⑲ 退回原因点名「失败」（真失败没被载体格式先筛掉）");

    // (b) 缺 evidence 字段的正式失败同样否决（filterMeasuredRecords 不得因没证据字段把失败整条扔掉）
    const Q = mkProject();
    const qBlob = storeRun(Q, { kind: "measured_run", version: 1, run_id: "r-noev", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 0 }, cover);
    selfCheckPass(Q, { id: "sc-noev", evidenceSha: qBlob.sha256, fingerprint: qBlob.source_manifest?.fingerprint ?? "" });
    ok(nodeOf(analyzeDataFlow(Q.id, { dataDir: Q.home }) as never)?.verification === "verified", "⑲(b) 基线：正式自检通过 ⇒ verified");
    const qSub = { submit: (c: unknown) => Q.service.submit(c as never), read: () => readFindings(Q.workDir) };
    const qFinding = openFinding(qSub as never, { project_id: Q.id, change_id: "chg-dfev", actor_id: "auditor9", role: "auditor", severity: "user_visible_defect", source: "夹具：缺证据失败", expected: "缺证据失败仍应否决", actual: "独审判失败且无证据哈希", repro: "夹具复现", evidence_sha256: qBlob.sha256, object_id: null });
    indepAudit(Q, { id: "au-noev-fail", auditor: "auditor9", result: "failed", evidenceSha: "", fingerprint: qBlob.source_manifest?.fingerprint ?? "", findings: [qFinding.finding_id] });
    const afterNoEv = analyzeDataFlow(Q.id, { dataDir: Q.home });
    ok(nodeOf(afterNoEv as never)?.verification !== "verified", `⑲(b) 缺 evidence 的正式失败 ⇒ 不绿（实得 ${nodeOf(afterNoEv as never)?.verification}）`);
    cases["plain_failure_veto"] = { plain: nodeOf(afterPlain as never)?.verification, no_evidence: nodeOf(afterNoEv as never)?.verification };
  }

  // ═════════════ ⑳ 同 ID 不同对象不串 ═════════════
  section("⑳ 同 ID 不同对象不串：对象绑定 + 跨对象复测不解除");
  {
    const P = mkProject();
    const cover = ["scripts/fx.ts", BIZ, "package.json"];
    const blobA = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-objA", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 0 }, cover);
    selfCheckPass(P, { id: "sc-objA", task: "tA", evidenceSha: blobA.sha256, fingerprint: blobA.source_manifest?.fingerprint ?? "" });
    const rawB = putEvidence(P.workDir, { content: "tB 独立复核：断言失败", kind: "independent_audit", summary: "raw failure tB", created_by: "auditorB", role: "auditor", binding: { revision_kind: "code", revision: blobA.source_manifest?.fingerprint ?? "" } });
    const sub = { submit: (c: unknown) => P.service.submit(c as never), read: () => readFindings(P.workDir) };
    const fB = openFinding(sub as never, { project_id: P.id, change_id: "chg-dfev", actor_id: "auditorB", role: "auditor", severity: "user_visible_defect", source: "夹具：tB 失败", expected: "失败压过通过", actual: "独审判失败", repro: "夹具复现", evidence_sha256: rawB.sha256, object_id: "tB" });
    indepAudit(P, { id: "au-objB-fail", task: "tB", auditor: "auditorB", result: "failed", evidenceSha: rawB.sha256, fingerprint: blobA.source_manifest?.fingerprint ?? "", findings: [fB.finding_id] });
    const m1 = analyzeDataFlow(P.id, { dataDir: P.home });
    ok(nodeOf(m1 as never)?.verification !== "verified", `⑳ tB 的独立失败压过 tA 的通过（不互相掩盖；实得 ${nodeOf(m1 as never)?.verification}）`);
    // tA 上再登记「合法修复 + 非作者复测通过 + resolves tB 的失败」：跨对象**不解除**（resolutionKey 带 object_id）
    const blobA2 = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-objA2", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 0, output_summary: "修复后" }, cover);
    const fpA2 = blobA2.source_manifest?.fingerprint ?? "";
    submitFix(P.submitter as never, { project_id: P.id, change_id: "chg-dfev", actor_id: "author", role: "executor", record_id: "fix-obj", finding_id: fB.finding_id, fix_revision: fpA2, fixed_by: "author", evidence_ref: blobA2.sha256, regression: [{ command: "pnpm verify:fx", exit_code: 0 }] });
    indepAudit(P, { id: "au-objA-pass", task: "tA", auditor: "auditor2", result: "passed", evidenceSha: blobA2.sha256, fingerprint: fpA2, resolves: ["au-objB-fail"], fix_refs: ["fix-obj"] });
    const m2 = analyzeDataFlow(P.id, { dataDir: P.home });
    ok(nodeOf(m2 as never)?.verification !== "verified", `⑳ 跨对象复测不解除对方的失败（仍不绿；实得 ${nodeOf(m2 as never)?.verification}）`);
    cases["no_cross_object"] = { after_fail: nodeOf(m1 as never)?.verification, after_cross_retest: nodeOf(m2 as never)?.verification };
  }

  // ═════════════ ㉑ 作者集合按被审对象取 ═════════════
  section("㉑ 作者集合按被审对象取：别处做过作者不把本任务的独立审计降级");
  {
    const P = mkProject();
    const cover = ["scripts/fx.ts", BIZ, "package.json"];
    // 别的任务 t2：bob 做过一次 df-measured 自检 ⇒ 旧口径（全项目作者集合）会把 bob 当作者
    const t2blob = putEvidence(P.workDir, { content: "bob 在 t2 的自检日志", kind: "self_check", summary: "t2 selfcheck", created_by: "bob", role: "executor", binding: { revision_kind: "code", revision: "t2" } });
    selfCheckPass(P, { id: "sc-bob-t2", checkId: `${DF_MEASURED_CHECK_PREFIX}bob-t2`, task: "t2", actor: "bob", evidenceSha: t2blob.sha256, fingerprint: sha256Hex("t2") });
    // 本任务 t1：author 自检通过（有效载体）+ bob 独立审计失败（普通原始日志）
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-actor", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 0 }, cover);
    selfCheckPass(P, { id: "sc-t1", task: "t1", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "" });
    ok(nodeOf(analyzeDataFlow(P.id, { dataDir: P.home }) as never)?.verification === "verified", "㉑ 基线：t1 自检通过 ⇒ verified");
    // bob 的失败引用的是一份**有效运行记录载体**（脚本 exit 1）——这样旧口径下失败不是被载体格式筛掉，而是被
    // 「全项目作者集合」把 bob 降级成作者自检而丢掉否决位；新口径按对象取作者 ⇒ bob 在 t1 是非作者 ⇒ 否决成立。
    const bobRun = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-bob-fail", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 1, output_summary: "bob 复核：脚本退出码 1" }, cover);
    const sub = { submit: (c: unknown) => P.service.submit(c as never), read: () => readFindings(P.workDir) };
    const f = openFinding(sub as never, { project_id: P.id, change_id: "chg-dfev", actor_id: "bob", role: "auditor", severity: "user_visible_defect", source: "夹具：bob 在 t1 的失败", expected: "失败否决", actual: "bob 判失败", repro: "夹具复现", evidence_sha256: bobRun.sha256, object_id: "t1" });
    indepAudit(P, { id: "au-bob-t1", task: "t1", auditor: "bob", authorId: "author", result: "failed", evidenceSha: bobRun.sha256, fingerprint: bobRun.source_manifest?.fingerprint ?? "", findings: [f.finding_id] });
    const after = analyzeDataFlow(P.id, { dataDir: P.home });
    ok(nodeOf(after as never)?.verification !== "verified", `㉑ bob 在 t1 是非作者 ⇒ 他的失败否决成立（不绿；实得 ${nodeOf(after as never)?.verification}）`);
    cases["author_scope_per_object"] = { verification: nodeOf(after as never)?.verification };
  }

  // ═════════════ ㉒ 声明定义变而 code/脚本不变 ⇒ 不绿 ═════════════
  section("㉒ 声明定义变而 code/脚本不变 ⇒ 不绿（运行记录绑定纯声明定义哈希）");
  {
    const P = mkProject();
    const cover = ["scripts/fx.ts", BIZ, "package.json"];
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-decl", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 0 }, cover);
    selfCheckPass(P, { id: "sc-decl", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "" });
    const defBefore = declShaOf(P);
    ok(nodeOf(analyzeDataFlow(P.id, { dataDir: P.home }) as never)?.verification === "verified", "㉒ 基线：定义未变 ⇒ verified");
    // 只改声明的 measured 条目 proves（源码与脚本一字不动）
    const decl = JSON.parse(fs.readFileSync(P.declPath, "utf8")) as { measured: { proves: string }[] };
    decl.measured[0]!.proves = "夹具：改了证明范围（源码与脚本未变）";
    writeFile(P.declPath, JSON.stringify(decl, null, 2));
    const defAfter = declShaOf(P);
    ok(defAfter !== defBefore, `㉒ 声明定义哈希确实变了（${defBefore.slice(0, 8)}… → ${defAfter.slice(0, 8)}…）`);
    const after = analyzeDataFlow(P.id, { dataDir: P.home });
    ok(nodeOf(after as never)?.verification !== "verified", `㉒ 定义变而源码/脚本未变 ⇒ 不绿（实得 ${nodeOf(after as never)?.verification}）`);
    const rec = readIdx(P, new Map([[SPEC_ID, "scripts/fx.ts"]])).verdicts.get(SPEC_ID);
    ok(rec?.manifest?.status === "valid", `㉒ 源清单仍 valid（源码未变）——是定义绑定把它打回（实得 ${rec?.manifest?.status}）`);
    ok((rec?.reasons ?? []).some((r) => r.includes("声明定义")), "㉒ 退回原因点名「声明定义」不一致");
    cases["declaration_binding"] = { def_before: defBefore, def_after: defAfter, verification: nodeOf(after as never)?.verification };
  }

  // ═════════════ ㉓ 全部候选被拒：被拒事实进指纹/身份；无关记录不 churn ═════════════
  section("㉓ 全部候选被拒：被拒事实变 ⇒ 指纹/身份变；完全无关记录不变");
  {
    const P = mkProject({ extraFiles: { "scripts/other.ts": `// ${MARKER}\nexport const other = 1;\n`, "scripts/other2.ts": `// ${MARKER}\nexport const other2 = 1;\n` } });
    const scriptMap = new Map([[SPEC_ID, "scripts/fx.ts"]]);
    const rej1 = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-rej1", spec_ids: [SPEC_ID], script: "scripts/other.ts", exit_code: 0 }, ["scripts/fx.ts", BIZ, "package.json", "scripts/other.ts"]);
    selfCheckPass(P, { id: "sc-rej1", evidenceSha: rej1.sha256, fingerprint: rej1.source_manifest?.fingerprint ?? "" });
    const idx1 = readIdx(P, scriptMap);
    const idA = resolveDataFlowDeclaration(P.id, { dataDir: P.home }).identity;
    ok(idx1.verdicts.size === 0, `㉓ 全部候选被拒 ⇒ 无条目判决（实得 ${idx1.verdicts.size}）`);
    ok(idx1.fingerprint !== emptyMeasuredRunIndex().fingerprint, "㉓ 被拒事实进指纹（不是同一 empty 常量）");
    putEvidence(P.workDir, { content: "完全无关的其它证据", kind: "other", summary: "unrelated", created_by: "verify-dataflow-evidence", role: "executor", binding: { revision_kind: "code", revision: "fixture" } });
    ok(readIdx(P, scriptMap).fingerprint === idx1.fingerprint, "㉓ 完全无关记录增删不改变指纹（不 churn）");
    ok(resolveDataFlowDeclaration(P.id, { dataDir: P.home }).identity === idA, "㉓ 完全无关记录不改变快照身份");
    const rej2 = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-rej2", spec_ids: [SPEC_ID], script: "scripts/other2.ts", exit_code: 0 }, ["scripts/fx.ts", BIZ, "package.json", "scripts/other2.ts"]);
    selfCheckPass(P, { id: "sc-rej2", evidenceSha: rej2.sha256, fingerprint: rej2.source_manifest?.fingerprint ?? "" });
    const idx2 = readIdx(P, scriptMap);
    const idB = resolveDataFlowDeclaration(P.id, { dataDir: P.home }).identity;
    ok(idx2.fingerprint !== idx1.fingerprint, "㉓ 被拒事实变 ⇒ 指纹变");
    ok(idB !== idA, "㉓ 被拒事实变 ⇒ 快照身份变（同一图正文变化不再 snapshot 不变）");
    cases["rejected_facts_identity"] = { fp_before: idx1.fingerprint, fp_after: idx2.fingerprint, id_changed: idB !== idA };
  }

  // ═════════════ ㉔ 治理负例：他人所有权 / 无有效宿主 ⇒ 经工具+客户端也私写不了（零事件零证据） ═════════════
  section("㉔ 治理负例：他人所有权 / 无有效宿主时，经工具+客户端不能私写（零事件零证据）");
  {
    const P = mkProject();
    const host = await startOwnedHost(P.home);
    const client = new WorkServiceClient({ dataDir: P.home, autostart: false });
    const ctx = { work: client, clientName: "verify-dataflow-evidence" };
    const eventsFile = path.join(P.workDir, "events.jsonl");
    const evDir = path.join(P.workDir, "evidence");
    const eventsCount = (): number => (fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").length : 0);
    const evCount = (): number => (fs.existsSync(evDir) ? fs.readdirSync(evDir).length : 0);
    const descFile = path.join(P.home, "work-service.json");

    // 基线：owner 态下经工具写成功（证明端点是**真写口**，不是"本来就零增"当覆盖）
    const ownerStore = await callTool(recordWorkEvidenceTool, { op: "store", project_id: P.id, role: "executor", kind: "other", content: "owner evidence", summary: "owner", binding: { revision_kind: "code", revision: "r1" } }, ctx);
    const ownerEvidence = (ownerStore.json?.evidence?.sha256 ?? "") as string;
    const ownerSelf = await callTool(recordWorkEvidenceTool, { op: "self_check", project_id: P.id, role: "executor", change_id: "chg", record_id: "owner-sc", checked_by: "author", conclusion: "pass", binding: { revision_kind: "code", revision: "r1" }, checks: [{ check_id: "c-owner", method: "夹具自检", evidence_sha256: ownerEvidence, verifies: "code" }] }, ctx);
    ok(ownerStore.isError === false && ownerSelf.isError === false && evCount() === 1 && eventsCount() === 1, `㉔ 基线：owner 态经工具写成功（证据 ${evCount()}、事件 ${eventsCount()}；端点确为真写口）`);

    // 负例①：他人所有权（描述符 pid 改成**别的进程**，端口/令牌不变）→ 宿主写闸拒绝、零增
    const mine = JSON.parse(fs.readFileSync(descFile, "utf8")) as { pid: number; token: string };
    writeFile(descFile, JSON.stringify({ ...mine, pid: mine.pid + 424242 }, null, 2));
    const evB1 = evCount();
    const edB1 = eventsCount();
    const foreignStore = await callTool(recordWorkEvidenceTool, { op: "store", project_id: P.id, role: "executor", kind: "other", content: "foreign", summary: "foreign", binding: { revision_kind: "code", revision: "r2" } }, ctx);
    const foreignSelf = await callTool(recordWorkEvidenceTool, { op: "self_check", project_id: P.id, role: "executor", change_id: "chg", record_id: "foreign-sc", checked_by: "author", conclusion: "pass", binding: { revision_kind: "code", revision: "r2" }, checks: [{ check_id: "c-foreign", method: "夹具自检", evidence_sha256: ownerEvidence, verifies: "code" }] }, ctx);
    ok(foreignStore.isError === true && evCount() === evB1, `㉔ 他人所有权：store 被拒且证据零增（${foreignStore.json?.code ?? foreignStore.text.slice(0, 40)}）`);
    ok(foreignSelf.isError === true && eventsCount() === edB1, `㉔ 他人所有权：self_check 被拒且事件零增（${foreignSelf.json?.code ?? foreignSelf.text.slice(0, 40)}）`);

    // 负例②：没有有效宿主（撤描述符 + 关自愈）→ 同样拒、零增
    fs.rmSync(descFile, { force: true });
    const evB2 = evCount();
    const edB2 = eventsCount();
    const noHost = await callTool(recordWorkEvidenceTool, { op: "store", project_id: P.id, role: "executor", kind: "other", content: "nohost", summary: "nohost", binding: { revision_kind: "code", revision: "r3" } }, ctx);
    ok(noHost.isError === true && evCount() === evB2 && eventsCount() === edB2, `㉔ 无有效宿主：store 被拒且证据/事件零增（${noHost.json?.code ?? "SERVICE_UNAVAILABLE"}）`);

    // 负例③：independent_audit 缺 coverage 直接拒（不模板自动全 checked，INDEP-02 的机制整改）
    writeFile(descFile, JSON.stringify(mine, null, 2));
    const noCov = await callTool(recordWorkEvidenceTool, { op: "independent_audit", project_id: P.id, role: "auditor", change_id: "chg", record_id: "au-nocov", auditor: "auditor1", author_id: "author", conclusion: "pass", checks: [{ check_id: "c1", result: "passed" }] }, ctx);
    ok(noCov.isError === true && noCov.json?.code === "INVALID_COMMAND", `㉔ independent_audit 缺 coverage 直接拒（${noCov.json?.code ?? noCov.text.slice(0, 40)}；工具不自动填 checked）`);

    // 正例④：显式逐域依据 → 登记成功，且账本里的 basis 就是显式给的那几段（非模板句）
    const explicitCoverage = [
      { area: "behavior_boundaries", status: "checked", basis: "逐条核了边界分支（本次实测）" },
      { area: "data_concurrency", status: "checked", basis: "核了并发写所有权闸与被拒零增" },
      { area: "interface_integration", status: "checked", basis: "核了工具→客户端→宿主录入链路" },
      { area: "failure_recovery", status: "checked", basis: "核了宿主不可达时的失败回执" },
      { area: "trust_permission", status: "unchecked", basis: "未做权限模型形式化验证" },
    ];
    const cov = await callTool(recordWorkEvidenceTool, { op: "independent_audit", project_id: P.id, role: "auditor", change_id: "chg", record_id: "au-cov", auditor: "auditor1", author_id: "author", conclusion: "pass", coverage: explicitCoverage, checks: [{ check_id: "c1", result: "passed" }] }, ctx);
    ok(cov.isError === false, `㉔ 显式逐域依据的 independent_audit 登记成功（${cov.json?.receipt?.ok === true ? "receipt ok" : cov.text.slice(0, 40)}）`);
    const auEvent = fs.readFileSync(eventsFile, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as { type: string; entity_id?: string; payload?: { coverage?: { basis?: string }[] } }).find((e) => e.type === "audit.independent_audit_recorded" && e.entity_id === "audit:au-cov");
    const covBasis = (auEvent?.payload?.coverage ?? []).map((c) => String(c.basis ?? ""));
    ok(covBasis.includes("未做权限模型形式化验证") && !covBasis.some((b) => b.includes("独立复核该实测运行")), "㉔ 账本 coverage basis 是显式给的那几段（非『独立复核该实测运行』模板）");

    cases["governance_negatives"] = { owner_ok: true, foreign_store_refused: foreignStore.isError, foreign_self_refused: foreignSelf.isError, no_host_refused: noHost.isError, coverage_required: noCov.isError && noCov.json?.code === "INVALID_COMMAND" };
    host.close();
  }

  // ═════════════ ㉕ 六图 data_flow 图层：独立 failed 普通日志否决不被绕过 ═════════════
  section("㉕ 六图 data_flow 图层：独立 failed 普通日志否决生效（六图不先载体筛掉失败再选绿）");
  {
    const P = mkProject();
    const cover = ["scripts/fx.ts", BIZ, "package.json"];
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-six", spec_ids: [SPEC_ID], script: "scripts/fx.ts", command: "pnpm verify:fx", exit_code: 0 }, cover);
    selfCheckPass(P, { id: "sc-six", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "" });
    const baseNode = sixGraphDataFlowNode(P.id, P.home);
    ok(baseNode?.verification === "verified", `㉕ 基线：六图 data_flow 节点标「已验证」（实得 ${baseNode?.verification}）`);
    // 独立 failed 引用的是**普通原始日志**（kind=independent_audit，**不是** measured_run 载体）——
    // 六图层与目标图共用同一适配器，同样不得"先按载体格式筛掉失败再选绿"。
    const rawFail = putEvidence(P.workDir, { content: "Independent actual counterexample: assertion failed", kind: "independent_audit", summary: "raw failure", created_by: "auditor1", role: "auditor", binding: { revision_kind: "code", revision: blob.source_manifest?.fingerprint ?? "" } });
    const sub = { submit: (c: unknown) => P.service.submit(c as never), read: () => readFindings(P.workDir) };
    const finding = openFinding(sub as never, { project_id: P.id, change_id: "chg-dfev", actor_id: "auditor1", role: "auditor", severity: "user_visible_defect", source: "夹具：六图层否决", expected: "六图应继承独立失败否决", actual: "独审判失败", repro: "夹具复现", evidence_sha256: rawFail.sha256, object_id: null });
    indepAudit(P, { id: "au-six-fail", auditor: "auditor1", result: "failed", evidenceSha: rawFail.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "", findings: [finding.finding_id] });
    const afterNode = sixGraphDataFlowNode(P.id, P.home);
    ok(afterNode?.verification !== "verified", `㉕ 六图层独立 failed 普通日志 ⇒ 节点不绿（实得 ${afterNode?.verification}）`);
    ok((afterNode?.tiers ?? []).includes("code_measured") === false, "㉕ 六图层否决后没有 code_measured 出处（失败没被载体格式筛掉）");
    cases["six_graph_veto"] = { baseline: baseNode?.verification, after_veto: afterNode?.verification };
  }

  // 更新的待人验记录不能因载体 script 不同而被预筛；只有 passed 才能按脚本身份筛选。
  section("㉖ 待人验引用不同脚本载体：旧通过不得掩盖 not_checked");
  {
    const P = mkProject();
    const cover = ["scripts/fx.ts", BIZ, "package.json"];
    const blob = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-pending-base", spec_ids: [SPEC_ID], script: "scripts/fx.ts", exit_code: 0 }, cover);
    selfCheckPass(P, { id: "sc-pending-base", task: "t1", evidenceSha: blob.sha256, fingerprint: blob.source_manifest?.fingerprint ?? "" });
    ok(nodeOf(analyzeDataFlow(P.id, { dataDir: P.home }))?.verification === "verified", "㉖ 正例：待人验登记前，合法当前运行通过");
    const other = storeRun(P, { kind: "measured_run", version: 1, run_id: "r-pending-other", spec_ids: [SPEC_ID], script: "scripts/other.ts", exit_code: 0 }, cover);
    submitIndependentAudit(P.submitter as never, {
      project_id: P.id, change_id: "chg-dfev", actor_id: "auditor-pending", role: "auditor",
      record_id: "au-pending-other", task_id: "t1", auditor: "auditor-pending", author_id: "author",
      conclusion: "pass", binding: { revision_kind: "code", revision: other.source_manifest?.fingerprint ?? "" },
      coverage, checks: [{ check_id: SPEC_ID, result: "not_checked", evidence_sha256: other.sha256,
        pending: { role: "user", reason: "夹具人验尚未做", basis: "本反例显式待验登记" } }],
    });
    const after = analyzeDataFlow(P.id, { dataDir: P.home });
    ok(nodeOf(after)?.verification !== "verified", "㉖ 不同脚本载体不删除待人验事实，旧 pass 不得恢复绿");
    ok(sixGraphDataFlowNode(P.id, P.home)?.verification !== "verified", "㉖ 六图同样保留待人验、不假绿");
    cases["pending_mismatched_script"] = { after: nodeOf(after)?.verification };
  }

  report.summary = { pass, fail: fails.length, fails };
  writeFile(path.join(REPORT_DIR, "verify-dataflow-evidence.json"), JSON.stringify(report, null, 2) + "\n");

  console.log(`\nDATAFLOW-EVIDENCE: PASS ${pass} / FAIL ${fails.length}`);
  if (fails.length > 0) {
    for (const f of fails) console.log(`  FAIL ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e: unknown) => {
    console.error(`[verify] 脚本自身出错：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
