// V09-62 界面验证（真浏览器）：DESIGN §3.16／§3.17、PLAN V09-62 的「人的默认交付入口」。
//
// 用法（环境约束：**不用 pnpm exec / pnpm build**）：
//   node node_modules/tsx/dist/cli.mjs scripts/verify-delivery-overview-ui.ts
//   证据输出目录可用 TATAI_DLV_UI_OUT 覆盖（本文件有界返工把 before/after 分目录留存）。
//
// 这一层验的是**界面行为**，不是后端派生（后端派生由 scripts/verify-delivery-overview.ts 覆盖）：
//   · 真服务：临时 TATAI_HOME + 动态空闲端口起本仓真实后端（`src/server/index.ts`），临时 cacheDir 起
//     真实 Vite dev server（`TATAI_DEV_API_PORT` 指到后端），真浏览器（系统 Edge，CDP 直驱）打开真实
//     应用包；
//   · 可控夹具：`delivery` / `agent_review` / `delivery.integration` 这些字段由注入脚本在浏览器内截获
//     `feature-ledger` 请求后给出（后端 A 未落地时也能验界面契约）。**注入只覆盖这一个读口**，其余
//     全部走真实服务——本脚本**不把 mock 当真服务实测**；实服务/安装同源由协调者另验。
//
// 覆盖（PLAN V09-62 chk-v09-62-03；DESIGN §3.17）：
//   ① 默认入口：新项目打开落到「交付总览」，首屏答「能否开始人工试用 / 还差什么」；
//   ② 缺证据/未审查：不可试用结论 + 逐项点名，未知不假绿；
//   ③ 旧服务：路由不识别（404）与字段缺失两种都显式未知，不冒充可试用；
//   ④ 分页：按钮续取更完整且版本一致；版本变了（409）旧页作废、**立即**撤结论、重读第一页，不拼接两版；
//   ⑤ 刷新失败：保留上次成功内容，但**撤下**「可试用」结论，且**全页可见文字**不得再出现可试用承诺
//      （旧 summary/绿通过只作「上次结果」呈现，或收进折叠详情）；继续失败不回绿；
//   ⑥ 快速切项目：晚到的旧项目回包不写进新项目界面；
//   ⑦ 既有入口/项目记忆：切到设计书后切走再回来仍在设计书；六图等入口照旧可达；
//   ⑧ 人的接受入口：去验收落到「验收」子页（不是实况默认），不代写 Gate；
//   ⑨ 边界形态：state 合法但 counts/gates/version 缺失时降为未知，不崩溃、不假 ready；
//      ⑨b 逐项必要子结构缺失（counts={} / gates=[] / 缺行 / version={} / user_acceptance={} / scope 非法）
//      一律降未知，专打容器级（只查 typeof object）检查的盲区；
//   ⑩ 大范围人话：17 功能 / 24 条阻断时首屏按人话类别合并、完整明细折叠一条不丢、功能列表仍可找到；
//   ⑪ 组合流程验证：`delivery.integration` 证据可展开，缺字段明确未知（不自己另算 overall）。
//
// 隔离红线（AGENTS.md §5）：只写临时目录与隔离证据目录（默认 `.工作台/functional-delivery-20261009/ui/`，
// 可用 TATAI_DLV_UI_OUT 覆盖）；不碰真实 ~/.tatai、不碰真实 8787、不 commit、不装依赖、不改 node_modules
// （Vite cacheDir 走环境变量）。清理只杀本脚本自己拉起的进程。

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { addProject } from "../src/server/registry";
import { displayCopyOf } from "../src/ui/components/deliveryOverviewDisplay";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const OUT = process.env.TATAI_DLV_UI_OUT ?? path.join(REPO, ".工作台", "functional-delivery-20261009", "ui");

const results: Array<{ ok: boolean; label: string; detail?: string }> = [];
function check(ok: boolean, label: string, detail?: string): void {
  results.push({ ok, label, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}
function note(msg: string): void {
  console.log(`     ${msg}`);
}
/** 把一段页面文字留档到证据目录（修后「全页文字」证据） */
function dumpText(name: string, text: string): void {
  try {
    fs.writeFileSync(path.join(OUT, name), text, "utf8");
  } catch {
    /* 留档尽力而为，不影响断言 */
  }
}

// ─────────────────────────── 进程与端口 ───────────────────────────

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("拿不到空闲端口"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitHttp(url: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status >= 200 && res.status < 500) return;
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} 未就绪：${url}`);
}

function killTree(proc: ChildProcess | null): void {
  if (proc === null || proc.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    /* 收尾尽力而为 */
  }
}

// ─────────────────────────── 夹具（隔离 home + 项目） ───────────────────────────

interface FixtureProject {
  id: string;
  name: string;
}

const PROJECTS: FixtureProject[] = [
  { id: "p-ready", name: "夹具·可试用" },
  { id: "p-missing", name: "夹具·缺证据" },
  { id: "p-paging", name: "夹具·分页" },
  { id: "p-old404", name: "夹具·旧服务路由" },
  { id: "p-oldfield", name: "夹具·旧服务字段" },
  { id: "p-large", name: "夹具·大范围" },
  // ⑬⑭⑮ 本轮有界收敛新增：真实 18 项元数据的布局别名面 + 完成态/负例读数面
  //    元数据（名称/场景原文）取自 2026-10-09 前次正式 HTTP 快照 after-submit-http.json，
  //    **只作显式 UI 夹具**（不读私人路径、不冒充真实当前通过）。
  { id: "p-real18", name: "夹具·真实18项元数据" },
  { id: "p-oldcounts", name: "夹具·旧宿主缺新counts字段" },
  { id: "p-mixed", name: "夹具·完成态与负例" },
  { id: "p-broken", name: "夹具·残缺字段" },
  // ⑨b 必要子结构缺失（state 却写 ready）：逐一验「契约必要字段缺失 ⇒ 未知，不假 ready」。
  // 非作者复审补：只测「整个 delivery 缺失」不够——counts={} / gates=[] / 缺行 / version={} /
  // user_acceptance={} / scope 非法都可能被旧的容器级检查误判成一次可用读数。
  { id: "p-broken-counts", name: "夹具·空counts" },
  { id: "p-broken-gates", name: "夹具·空gates" },
  { id: "p-broken-gates-partial", name: "夹具·缺行gates" },
  { id: "p-broken-version", name: "夹具·空version" },
  { id: "p-broken-accept", name: "夹具·空accept" },
  { id: "p-broken-scope", name: "夹具·非法scope" },
  // 不注入：这条走**真实后端**返回（本仓后端尚未落地 delivery 字段），验「旧服务缺字段不假绿」的真服务面
  { id: "p-real", name: "夹具·真服务" },
];

function buildFixtures(home: string, root: string): void {
  fs.mkdirSync(home, { recursive: true });
  for (const p of PROJECTS) {
    const dir = path.join(root, p.id);
    fs.mkdirSync(path.join(dir, ".工作台", "work"), { recursive: true });
    fs.writeFileSync(path.join(dir, "DESIGN.md"), `# ${p.name}\n\n## 1. 夹具设计\n\n夹具正文。\n`, "utf8");
    fs.writeFileSync(path.join(dir, "PLAN.md"), `# ${p.name} 施工图\n\n## 夹具卡\n\n夹具施工定义。\n`, "utf8");
    addProject({ id: p.id, name: p.name, path: dir, kind: "backend" }, home);
  }
}

// ─────────────────────────── 注入脚本（可控 fixture） ───────────────────────────
//
// 只在浏览器内拦截 feature-ledger：`delivery` / `agent_review` 由这里给；其余请求一律透传给真实服务。
// 控制状态在 window.__DLV.ctl[pid] 上，由驱动脚本在断言前设。

const INJECT_TEMPLATE = String.raw`
(function () {
  var orig = window.fetch;
  window.__DLV = window.__DLV || { calls: [] };
  window.__DLV.ctl = window.__DLV.ctl || {};
  function withAbort(init, ms, make) {
    return new Promise(function (resolve, reject) {
      var signal = init && init.signal;
      var aborted = false;
      function onAbort() {
        aborted = true;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      setTimeout(function () {
        if (aborted) return;
        if (signal) signal.removeEventListener("abort", onAbort);
        try { resolve(make()); } catch (e) { reject(e); }
      }, ms || 0);
    });
  }
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url ? input.url : String(input));
    var m = /\/api\/projects\/([^/]+)\/feature-ledger/.exec(url);
    if (!m) return orig.apply(this, arguments);
    var pid = decodeURIComponent(m[1]);
    var q = url.indexOf("?") >= 0 ? url.slice(url.indexOf("?")) : "";
    var cursor = "";
    var mm = /[?&]cursor=([^&]*)/.exec(q);
    if (mm) cursor = decodeURIComponent(mm[1]);
    window.__DLV.calls.push({ pid: pid, cursor: cursor, t: Math.round(performance.now()) });
    var ctl = window.__DLV.ctl[pid] || {};
    var fx = (window.__DLV_FIXTURES || {})[pid];
    if (ctl.conflictNext) {
      ctl.conflictNext = false;
      return withAbort(init, 0, function () {
        return new Response(JSON.stringify({ ok: false, status: 409, code: "REVISION_CHANGED", message: "清单版本已变" }), {
          status: 409, headers: { "content-type": "application/json" },
        });
      });
    }
    if (ctl.failCount && ctl.failCount > 0) {
      ctl.failCount = ctl.failCount - 1;
      return withAbort(init, ctl.delayMs || 0, function () { throw new TypeError("Failed to fetch"); });
    }
    if (!fx) return orig.apply(this, arguments);
    var key = cursor || "_";
    var status = fx.status || 200;
    var body = fx.responses[key];
    if (body === undefined) return orig.apply(this, arguments);
    return withAbort(init, ctl.delayMs || 0, function () {
      return new Response(JSON.stringify(body), { status: status, headers: { "content-type": "application/json" } });
    });
  };
})();
`;

// ─────────────────────────── 夹具账本（固定 API 契约） ───────────────────────────

const NOW = "2026-10-09T03:00:00.000Z";

interface ItemSpec {
  id: string;
  name: string;
  scenario: string;
  desc: string;
  design: string;
  impl: string;
  vstate: string;
  vevidence: string;
  passed: number;
  required: number;
  missing: string[];
  accept: string;
  review?: { state: string; required: number; passed: number; missing: string[]; evidence?: Array<Record<string, unknown>> };
  extraction?: "declared" | "mapped_requirement_pending" | "registered_candidate" | "unregistered_candidate";
  /** 已登记需求引用（`registered_candidate` 用：需求 ID / 来源 / certainty）；缺省按原规则生成 */
  reqRef?: { requirement_id: string; source_ref: string; certainty: string };
}

function featureItem(s: ItemSpec): Record<string, unknown> {
  const extraction = s.extraction ?? "declared";
  const item: Record<string, unknown> = {
    item_id: s.id,
    scope_id: "project:delivery",
    scope_revision: "rev-1",
    display_name: s.name,
    user_description: s.desc,
    scenario: s.scenario,
    requirement_refs:
      extraction === "declared"
        ? [{ requirement_id: `req-${s.id}`, certainty: "explicit", source_ref: ".工作台/functional-delivery-20261009/REQUEST.txt" }]
        : s.reqRef !== undefined
          ? [s.reqRef]
          : [],
    design_section_refs:
      extraction === "declared"
        ? [{ anchor: "design-1", title: "夹具设计", line: 3, status: "located", hash: "sec-1" }]
        : [],
    design_coverage: {
      state: s.design,
      review: { reviewer: s.design === "已核对" ? "codex" : null, ref: s.design === "已核对" ? "基线 bl-1" : null, ref_kind: "baseline", section_sha256: "sec-1", unmet: s.design === "已核对" ? null : "尚无审定记录" },
      gap: s.design === "已核对" ? null : "缺设计覆盖审定",
    },
    implementation: { state: s.impl, basis: s.impl === "no_run_record" ? null : "seq 4339" },
    verification: {
      display_status: s.vstate,
      evidence_state: s.vevidence,
      required_count: s.required,
      passed_count: s.passed,
      missing: s.missing,
      effective_version: s.passed > 0 ? "pkg-ready-1" : null,
      evidence_entry:
        s.passed > 0 ? [{ check_id: `chk-${s.id}`, effective: "passed", evidence_ref: `ev-${s.id}` }] : [],
    },
    user_acceptance: {
      state: s.accept,
      scope_tasks: [`task-${s.id}`],
      accepted_tasks: s.accept === "accepted" ? [`task-${s.id}`] : [],
      gate_ref: s.accept === "pending" ? null : "gate-1",
      unmet: s.accept === "pending" ? "等你决定" : null,
    },
    pending_decisions: [],
    task_refs: [{ task_id: `task-${s.id}`, definition_fingerprint: "fp-1" }],
    provenance: {
      extraction,
      unmapped: extraction === "mapped_requirement_pending" ? [`req-${s.id}`] : [],
      pending_leads: [],
      derivation: { design_revision: "a1", plan_revision: "b2", plan_definition: "d3", ledger_last_seq: 4339 },
    },
  };
  if (s.review !== undefined) {
    item.agent_review = {
      state: s.review.state,
      required_count: s.review.required,
      passed_count: s.review.passed,
      missing: s.review.missing,
      evidence: s.review.evidence ?? [],
    };
  }
  return item;
}

function evidence(checkId: string, reviewer: string): Record<string, unknown> {
  return { check_id: checkId, reviewer, at: NOW, evidence_ref: `ev-${checkId}`, record_ref: null, notes: [] };
}

function deliveryGate(id: string, label: string, state: string, checkIds: string[], missing: string[], ev: Array<Record<string, unknown>>): Record<string, unknown> {
  return { id, label, state, check_ids: checkIds, missing, evidence: ev };
}

function ledgerBody(opts: {
  items: Array<Record<string, unknown>>;
  delivery?: Record<string, unknown> | null;
  paging?: { complete: boolean; cursor: string | null };
  coverage?: Record<string, unknown>;
  sourceComplete?: boolean;
}): Record<string, unknown> {
  const ledger: Record<string, unknown> = {
    state: "ok",
    scope_id: "project:delivery",
    scope_revision: "rev-1",
    package_revision: "pkg-ready-1",
    package_revision_basis: ["DESIGN@a1", "PLAN@b2", "ledger@4339"],
    document_selection: {
      requested: "active",
      mode: "active",
      design_revision: "a1",
      plan_revision: "b2",
      plan_definition: "d3",
      baseline_id: "bl-1",
      drift: null,
    },
    artifact_ref: null,
    artifact_selection: null,
    generated_at: NOW,
    source_revision: { design: "a1", plan: "b2", ledger_last_seq: 4339 },
    coverage:
      opts.coverage ?? {
        examined_sources: [{ ref: "DESIGN.md", kind: "design" }, { ref: "PLAN.md", kind: "plan" }],
        unexamined_sources: [],
        registered_requirement_count: 6,
        mapped_count: 5,
        pending_count: 1,
        unregistered_candidate_count: 1,
        source_complete: opts.sourceComplete ?? true,
      },
    items: opts.items,
    paging: opts.paging ?? { complete: true, cursor: null },
  };
  if (opts.delivery !== null) ledger.delivery = opts.delivery;
  return { ok: true, ledger };
}

function readyDelivery(): Record<string, unknown> {
  return {
    state: "ready_for_trial",
    summary: "本期正式功能的设计覆盖、技术验证与 Agent 审查都已满足，可以交给人试用了。",
    scope: "project",
    // 分母守恒：mapped 3 + pending 1 + registered_candidates 1 = requirements 5；formal = mapped+pending = 4
    counts: { features: 3, design_checked: 3, verified: 3, reviewed: 3, requirements: 5, mapped_requirements: 3, pending_requirements: 1, formal_requirements: 4, registered_candidates: 1, candidates: 1 },
    gates: [
      deliveryGate("coverage", "完整功能范围核查", "passed", ["chk-v09-62-01"], [], [evidence("chk-v09-62-01", "codex")]),
      deliveryGate("review", "非作者审查与问题收口", "passed", ["chk-v09-62-04"], [], [evidence("chk-v09-62-04", "codex")]),
      deliveryGate("runtime", "运行交付版本核对", "passed", ["chk-v09-62-05"], [], [evidence("chk-v09-62-05", "codex")]),
    ],
    integration: {
      state: "passed",
      check_ids: ["int-project-delivery-01"],
      missing: [],
      evidence: [evidence("int-project-delivery-01", "codex")],
    },
    blockers: [],
    version: { design_revision: "a1", plan_revision: "b2", baseline_id: "bl-1", ledger_last_seq: 4339, drift: null },
    user_acceptance: { pending: 3, accepted: 0, rejected: 0, accepted_known_limit: 0 },
  };
}

/**
 * 旧宿主：`delivery.counts` 里**没有**新增的 `formal_requirements` / `registered_candidates`。
 * 契约：界面必须显式「未知」，**不得**拿 0 冒充「没有候选」；items 里的候选仍按分类单列（不依赖 counts）。
 */
function readyDeliveryOldCounts(): Record<string, unknown> {
  const d = readyDelivery();
  const c: Record<string, unknown> = { ...(d.counts as Record<string, unknown>) };
  delete c.formal_requirements;
  delete c.registered_candidates;
  d.counts = c;
  return d;
}

function notReadyDelivery(): Record<string, unknown> {
  return {
    state: "not_ready",
    summary: "还有技术验证与 Agent 审查没有完成，现在还不能开始人工试用。",
    scope: "project",
    counts: { features: 2, design_checked: 1, verified: 1, reviewed: 0, requirements: 4, mapped_requirements: 3, pending_requirements: 1, candidates: 1 },
    gates: [
      deliveryGate("coverage", "完整功能范围核查", "passed", ["chk-v09-62-01"], [], [evidence("chk-v09-62-01", "codex")]),
      deliveryGate("review", "非作者审查与问题收口", "pending", ["chk-v09-62-04"], ["还缺 1 项有效非作者审查记录"], []),
      deliveryGate("runtime", "运行交付版本核对", "pending", ["chk-v09-62-05"], ["还没对拟交付产物做实跑版本核对"], []),
    ],
    integration: {
      state: "pending",
      check_ids: ["int-project-delivery-01"],
      missing: ["组合流程检查还没通过"],
      evidence: [],
    },
    blockers: [
      { kind: "technical_verification", item_id: "cap-b", message: "功能「批量恢复」还差 1 项技术验证证据" },
      { kind: "agent_review", item_id: "cap-b", message: "功能「批量恢复」还没有非作者审查记录" },
      { kind: "gate_runtime", item_id: null, message: "还没核对拟交付运行版本" },
    ],
    version: { design_revision: "a1", plan_revision: "b2", baseline_id: "bl-1", ledger_last_seq: 4339, drift: null },
    user_acceptance: { pending: 2, accepted: 0, rejected: 0, accepted_known_limit: 0 },
  };
}

/** ⑩ 大范围夹具：17 项正式功能 + 24 条阻断（4 类，**用后端 deliveryReadout 的真实 kind**），
 *  验首屏人话分类合并与完整明细不丢。 */
const LARGE_FEATURES = Array.from({ length: 17 }, (_, idx) => {
  const n = idx + 1;
  const done = n <= 10;
  return featureItem({
    id: `cap-${String(n).padStart(2, "0")}`,
    name: `正式功能${n}`,
    scenario: `用于场景${n}`,
    desc: `功能${n}的人话说明`,
    design: done ? "已核对" : "部分",
    impl: "result_submitted",
    vstate: done ? "verified" : "pending_verification",
    vevidence: done ? "verified" : "missing",
    passed: done ? 1 : 0,
    required: 1,
    missing: done ? [] : ["缺技术验证证据"],
    accept: "pending",
    review: {
      state: done ? "passed" : "pending",
      required: 1,
      passed: done ? 1 : 0,
      missing: done ? [] : ["缺 Agent 审查记录"],
      evidence: [],
    },
  });
});

const LARGE_BLOCKERS: Array<Record<string, unknown>> = (() => {
  const specs: Array<{ kind: string; n: number; msg: (i: number) => string }> = [
    { kind: "technical_verification", n: 10, msg: (i) => `功能${i}还差技术验证证据` },
    { kind: "agent_review", n: 8, msg: (i) => `功能${i}还没有 Agent 审查记录` },
    { kind: "gate_runtime", n: 3, msg: (i) => `运行交付版本里第${i}处还没核对` },
    { kind: "design_coverage", n: 3, msg: (i) => `功能${i}的设计覆盖有缺口` },
  ];
  const out: Array<Record<string, unknown>> = [];
  let k = 0;
  for (const s of specs) {
    for (let i = 1; i <= s.n; i++) {
      k += 1;
      out.push({ kind: s.kind, item_id: `cap-${String(((k - 1) % 17) + 1).padStart(2, "0")}`, message: s.msg(i) });
    }
  }
  return out;
})();

function largeDelivery(): Record<string, unknown> {
  return {
    state: "not_ready",
    summary: "还有技术验证与 Agent 审查没有完成，现在还不能开始人工试用。",
    scope: "project",
    counts: { features: 17, design_checked: 10, verified: 10, reviewed: 10, requirements: 20, mapped_requirements: 18, pending_requirements: 2, candidates: 1 },
    gates: [
      deliveryGate("coverage", "完整功能范围核查", "passed", ["chk-v09-62-01"], [], [evidence("chk-v09-62-01", "codex")]),
      deliveryGate("review", "非作者审查与问题收口", "pending", ["chk-v09-62-04"], ["还缺 8 项有效非作者审查记录"], []),
      deliveryGate("runtime", "运行交付版本核对", "pending", ["chk-v09-62-05"], ["还没对拟交付产物做实跑版本核对"], []),
    ],
    // 故意不给 integration：验「缺字段明确未知，不自己另算 overall」
    blockers: LARGE_BLOCKERS,
    version: { design_revision: "a1", plan_revision: "b2", baseline_id: "bl-1", ledger_last_seq: 4339, drift: null },
    user_acceptance: { pending: 17, accepted: 0, rejected: 0, accepted_known_limit: 0 },
  };
}

// ── ⑬ 真实 18 项元数据夹具（只作显式 UI 夹具） ──
//
// 名称与场景**原文**取自 2026-10-09 前次正式 HTTP 快照（`after-submit-http.json` 的 `ledger.items`
// 里 18 项 `extraction=declared`）。用途是让「真实正式功能名称下的卡片别名 / 右栏原名 / 布局几何」
// 被真浏览器实际渲染一次——**这不是当前通过读数**，读数按快照形态塑形（verified + review passed），
// 是否可试用仍只由夹具的 delivery 决定。此处不读任何私人路径，元数据内联在本文件里。
const REAL18_META: Array<{ id: string; name: string; scenario: string }> = [
  { id: "cap-loop-feature-list", name: "设计书旁的人话功能清单与设计覆盖对照", scenario: "阅读设计时看出已有功能与遗漏，点击回原文" },
  { id: "cap-loop-four-dim-readout", name: "四维读数分开、绿色只按本范围验证", scenario: "不靠颜色也能分辨设计/实现/验证/接受" },
  { id: "cap-loop-handoff-package", name: "逐项交接包（check 级材料与下一动作）", scenario: "新会话拿到 check 级材料与下一步" },
  { id: "cap-loop-flow-loop", name: "提交→复验→下一动作的接续闭环", scenario: "提交→复验→下一动作闭环可追" },
  { id: "cap-loop-source-change-reverify", name: "源变复验（按界，恰一个动作）", scenario: "改一处只看受影响范围，历史保留" },
  { id: "cap-loop-supplement-path", name: "用户补充设计路径", scenario: "我提的需求能看到去向" },
  { id: "cap-loop-human-accept", name: "人的验收结果可见", scenario: "人看懂结果并自己提决定，Agent 不代签" },
  { id: "cap-six-graphs", name: "六图生成、按当前状况自动更新与人可读浏览", scenario: "打开六图看当前项目结构/依赖/数据路径，缺项与旧图如实标示，点节点回原文" },
  { id: "cap-graph-agent-read", name: "Agent 直接读六图完整当前状态（MCP/HTTP 读口）", scenario: "只给项目入口，Agent 即说出六图各自内容、算到哪一版、哪处未验证、下一步读什么" },
  { id: "cap-business-dataflow", name: "业务数据流真实路径图（输入→处理→存储→输出/外部系统）", scenario: "数据流主画布给出业务路径，逐跳可追出处与验证态；静态 import 不冒充真数据流" },
  { id: "cap-requirements-traceability", name: "需求→设计→施工卡→实现/证据 可追溯", scenario: "任一已登记需求能正向追到设计依据、承接卡、实现与证据，反向也能追回；缺环如实报缺" },
  { id: "cap-audit-closure", name: "五环审计、独立抽查与缺陷闭环", scenario: "执行完成、机械验证、独立审计、用户验收分别记录；缺陷可复现、修复有复测、旧证据保留" },
  { id: "cap-sync-evidence", name: "同步证据发现与完整性验收", scenario: "登记应同步范围→Agent 交固定格式证据包→塔台逐项比对当前实际目标→自动放行/阻断" },
  { id: "cap-shell-lifecycle", name: "桌面服务生命周期与安全默认配置", scenario: "壳正常关闭或被强杀后，随壳启动的后端子树退出并释放端口（尤其 8787），数据不丢、不误杀其他客户端" },
  { id: "cap-agent-continuity", name: "Agent 接续材料、入口与只读预检提效", scenario: "换会话/换 Agent 后，新接手者按入口取得 check 级材料与下一步；提交前只读预检一次列清缺项；构建身份可辨识" },
  { id: "cap-ui-experience", name: "人话主界面、日夜主题与图标一致", scenario: "非开发者用大白话看懂项目全貌、模块用途与依据；日夜主题可切换并记住；图标统一" },
  { id: "cap-reverse-draft", name: "从已有代码补设计草稿", scenario: "登记已有项目后，结合源码、文档和可用历史形成设计草稿；已有设计不被覆盖，Gate 只给建议" },
  { id: "cap-delivery-overview", name: "交付总览与人工试用交接", scenario: "从一个页面核对本期功能、验证、非作者审查和运行版本，知道还差什么、何时可开始人工试用" },
];

const REAL18_FEATURES: Array<Record<string, unknown>> = REAL18_META.map((m) =>
  featureItem({
    id: m.id,
    name: m.name,
    scenario: m.scenario,
    desc: `${m.name}的人话说明`,
    design: "已核对",
    impl: "result_submitted",
    vstate: "verified",
    vevidence: "verified",
    passed: 3,
    required: 3,
    missing: [],
    accept: "pending",
    review: { state: "passed", required: 3, passed: 3, missing: [], evidence: [] },
  }),
);

function real18Delivery(): Record<string, unknown> {
  const d = readyDelivery();
  d.counts = { features: 18, design_checked: 18, verified: 18, reviewed: 18, requirements: 52, mapped_requirements: 52, pending_requirements: 0, candidates: 1 };
  d.summary = "夹具：18 项真实功能元数据（名称/场景取自前次 HTTP 快照），读数按快照形态塑形，不代表当前通过。";
  d.user_acceptance = { pending: 18, accepted: 0, rejected: 0, accepted_known_limit: 0 };
  return d;
}

// ── ⑭ 完成态与负例读数面（逐个状态：已实现/仅提交/失效/失败/无记录/缺审查/未知 + 超长原文） ──

const LONG_ORIGINAL_NAME =
  "这是一个刻意不在审定别名表里的超长功能原文，用来验证卡片遇到未知原文时完整换行显示、既不横向撑破布局也不靠省略号把范围藏起来";
const LONG_ORIGINAL_SCENARIO =
  "同样很长的使用场景原文：卡片列的宽度有限，这里要允许换行，不能产生横向滚动，也不能把内容截断后让人以为这就是全部。";

function mixedItem(over: Partial<ItemSpec> & Pick<ItemSpec, "id" | "name" | "scenario" | "desc">): Record<string, unknown> {
  return featureItem({
    design: "已核对",
    impl: "result_submitted",
    vstate: "verified",
    vevidence: "verified",
    passed: 1,
    required: 1,
    missing: [],
    accept: "pending",
    ...over,
  });
}

function mixedItems(): Array<Record<string, unknown>> {
  const failed = mixedItem({
    id: "cap-m-failed",
    name: "有检查明确失败的功能",
    scenario: "验证里有一项明确失败",
    desc: "验证里有一项明确失败",
    vstate: "verified",
    vevidence: "verified",
    passed: 1,
    required: 2,
    missing: ["chk-m-failed 失败"],
  });
  (failed.verification as Record<string, unknown>).evidence_entry = [
    { check_id: "chk-m-failed", effective: "failed", evidence_ref: "ev-m-failed" },
  ];
  return [
    // 提交 + 当前有效技术验证 ⇒ 卡片要能读作「已实现」+「验证通过」
    mixedItem({ id: "cap-m-verified", name: "已完成且验证通过的功能", scenario: "已完成且验证通过", desc: "已完成且验证通过", review: { state: "passed", required: 2, passed: 2, missing: [], evidence: [] } }),
    // 只是提交过、还没验证 ⇒ 「已提交实现」而不是「已实现」
    mixedItem({ id: "cap-m-submitted", name: "提交了但还没验证的功能", scenario: "提交了但还没验证", desc: "提交了但还没验证", vstate: "pending_verification", vevidence: "missing", passed: 0, required: 1, missing: ["缺技术验证证据"], review: { state: "pending", required: 1, passed: 0, missing: ["缺 Agent 审查记录"], evidence: [] } }),
    // 证据已失效 ⇒ 「需要复验」
    mixedItem({ id: "cap-m-invalid", name: "证据已失效的功能", scenario: "证据已失效", desc: "证据已失效", vevidence: "invalidated", review: { state: "passed", required: 1, passed: 1, missing: [], evidence: [] } }),
    failed,
    // 图上无运行投影 ⇒ 「暂无实现记录」（不得读成「未开始」）
    mixedItem({ id: "cap-m-norun", name: "没有运行投影的功能", scenario: "没有运行投影", desc: "没有运行投影", impl: "no_run_record", vstate: "planned", vevidence: "missing", passed: 0, required: 1, missing: ["缺技术验证证据"] }),
    // 完全不认识的验证读数 ⇒ 显式未知
    mixedItem({ id: "cap-m-unknown", name: "读数未知的功能", scenario: "读数未知", desc: "读数未知", vstate: "unknown", vevidence: "unknown", passed: 0, required: 1 }),
    // 后端没给审查读数（旧服务）⇒ 「未知」，不是「未完成」
    mixedItem({ id: "cap-m-noreview", name: "旧服务没给审查读数的功能", scenario: "旧服务没给审查读数", desc: "旧服务没给审查读数" }),
    // 未知原文（不在别名表）⇒ 原样完整显示
    mixedItem({ id: "cap-m-long", name: LONG_ORIGINAL_NAME, scenario: LONG_ORIGINAL_SCENARIO, desc: LONG_ORIGINAL_SCENARIO }),
  ];
}

function mixedDelivery(n: number): Record<string, unknown> {
  const d = notReadyDelivery();
  d.summary = "夹具：完成态与负例读数（每张卡一个状态），只用来看界面读数是否分得清。";
  d.counts = { features: n, design_checked: 1, verified: 2, reviewed: 1, requirements: n, mapped_requirements: n, pending_requirements: 0, candidates: 0 };
  d.blockers = [{ kind: "technical_verification", item_id: "cap-m-submitted", message: "功能「提交了但还没验证的功能」还差 1 项技术验证证据" }];
  d.user_acceptance = { pending: n, accepted: 0, rejected: 0, accepted_known_limit: 0 };
  return d;
}

/** ⑨ 残缺字段夹具：state 合法，但 counts/gates/version/user_acceptance 缺失 → 必须降为未知，不假 ready */
function brokenDelivery(): Record<string, unknown> {
  return { state: "ready_for_trial", summary: "（残缺字段夹具：本行不该被当真可试用）" };
}

/**
 * ⑨b 只坏**一个**必要子结构：其余字段都写得像一次合法 ready 读数，唯独某项缺失/不完整/非法。
 * 契约：`delivery` 的必要字段缺失要降未知（§3.16「缺字段…均不冒充当前可试用」），所以每一例都
 * 必须判非 ready。用完整的 `readyDelivery()` 当基线，保证失败只由被替换的那一项引起。
 */
function malformedReady(over: Record<string, unknown>): Record<string, unknown> {
  return { ...readyDelivery(), ...over };
}

const BROKEN_CORE_FIXTURES: Record<string, { status: number; responses: Record<string, unknown> }> = {
  // counts 是空对象（各计数读到 0）却写 ready
  "p-broken-counts": { status: 200, responses: { _: ledgerBody({ delivery: malformedReady({ counts: {} }), items: [] }) } },
  // gates 是空集（三类交付核对一行没有）却写 ready
  "p-broken-gates": { status: 200, responses: { _: ledgerBody({ delivery: malformedReady({ gates: [] }), items: [] }) } },
  // gates 缺一行（少了 runtime）——声明是固定三行，缺行不算一次可用读数
  "p-broken-gates-partial": {
    status: 200,
    responses: {
      _: ledgerBody({
        delivery: malformedReady({
          gates: [
            deliveryGate("coverage", "完整功能范围核查", "passed", ["chk-v09-62-01"], [], [evidence("chk-v09-62-01", "codex")]),
            deliveryGate("review", "非作者审查与问题收口", "passed", ["chk-v09-62-04"], [], [evidence("chk-v09-62-04", "codex")]),
          ],
        }),
        items: [],
      }),
    },
  },
  // version 是空对象（设计/施工/基线全 null）却写 ready
  "p-broken-version": { status: 200, responses: { _: ledgerBody({ delivery: malformedReady({ version: {} }), items: [] }) } },
  // user_acceptance 是空对象却写 ready
  "p-broken-accept": { status: 200, responses: { _: ledgerBody({ delivery: malformedReady({ user_acceptance: {} }), items: [] }) } },
  // scope 非法：不能被默认成 project（那等于把「范围未知」当「整项目」放大结论）
  "p-broken-scope": { status: 200, responses: { _: ledgerBody({ delivery: malformedReady({ scope: "bogus" }), items: [] }) } },
};

const FIXTURES: Record<string, { status: number; responses: Record<string, unknown> }> = {
  // ⑬ 真实 18 项元数据（名称/场景取自前次 HTTP 快照；读数按快照形态塑形，不代表当前通过）
  "p-real18": {
    status: 200,
    responses: { _: ledgerBody({ delivery: real18Delivery(), items: REAL18_FEATURES }) },
  },
  // ⑭ 完成态与负例：每张卡一个读数（已实现/仅提交/失效/失败/无记录/未知/缺审查/超长原文）
  "p-mixed": {
    status: 200,
    responses: { _: ledgerBody({ delivery: mixedDelivery(8), items: mixedItems() }) },
  },
  // ① 可试用：三类 Gate + 组合流程验证都通过、无阻断、功能与非作者审查齐备
  "p-ready": {
    status: 200,
    responses: {
      _: ledgerBody({
        delivery: readyDelivery(),
        items: [
          featureItem({ id: "cap-a", name: "项目登记与切换", scenario: "添加已有项目并在项目间切换", desc: "把本机项目登记进来", design: "已核对", impl: "result_submitted", vstate: "verified", vevidence: "verified", passed: 3, required: 3, missing: [], accept: "pending", review: { state: "passed", required: 2, passed: 2, missing: [], evidence: [evidence("chk-review-a", "claude")] } }),
          featureItem({ id: "cap-b", name: "备份与恢复", scenario: "导出并恢复项目状态", desc: "备份与恢复", design: "已核对", impl: "result_submitted", vstate: "verified", vevidence: "verified", passed: 2, required: 2, missing: [], accept: "pending", review: { state: "passed", required: 2, passed: 2, missing: [], evidence: [evidence("chk-review-b", "claude")] } }),
          featureItem({ id: "cap-c", name: "人工 Gate", scenario: "在验收区记录人的接受", desc: "人工 Gate", design: "已核对", impl: "result_submitted", vstate: "verified", vevidence: "verified", passed: 1, required: 1, missing: [], accept: "pending", review: { state: "passed", required: 1, passed: 1, missing: [], evidence: [] } }),
          featureItem({ id: "pending:req-loop-9", name: "（未映射需求）req-loop-9", scenario: "导出每周进展", desc: "用户补充的需求，尚无正式设计去向", design: "缺失", impl: "no_run_record", vstate: "planned", vevidence: "missing", passed: 0, required: 1, missing: ["缺技术验证证据"], accept: "pending", extraction: "mapped_requirement_pending" }),
          featureItem({ id: "pending:req-R13", name: "（已登记待确认）req-R13", scenario: "代码/图文专用扩展（Q）", desc: "候选单列，未纳入必需", design: "缺失", impl: "no_run_record", vstate: "planned", vevidence: "missing", passed: 0, required: 1, missing: ["缺技术验证证据"], accept: "pending", extraction: "registered_candidate", reqRef: { requirement_id: "req-R13", source_ref: "docs/design/2026-09-29-需求覆盖与未决项-v0.1.md §3 R13 行（L51）", certainty: "待确认" } }),
          featureItem({ id: "pending:cand-3", name: "未登记候选：多机同步", scenario: "跨设备同步项目", desc: "用户口头提到、尚未登记的需求", design: "缺失", impl: "no_run_record", vstate: "planned", vevidence: "missing", passed: 0, required: 1, missing: ["缺技术验证证据"], accept: "pending", extraction: "unregistered_candidate" }),
        ],
      }),
    },
  },
  // ⑱ 真正旧宿主：新增 counts 与 registered_candidate 分类都不存在，不能据空返回推断候选总数为 0。
  "p-oldcounts": {
    status: 200,
    responses: {
      _: ledgerBody({
        delivery: readyDeliveryOldCounts(),
        items: [
          featureItem({ id: "cap-a", name: "项目登记与切换", scenario: "添加已有项目并在项目间切换", desc: "把本机项目登记进来", design: "已核对", impl: "result_submitted", vstate: "verified", vevidence: "verified", passed: 3, required: 3, missing: [], accept: "pending", review: { state: "passed", required: 2, passed: 2, missing: [], evidence: [evidence("chk-review-a", "claude")] } }),
        ],
      }),
    },
  },
  // ② 缺证据：不可试用，阻断逐条点名
  "p-missing": {
    status: 200,
    responses: {
      _: ledgerBody({
        delivery: notReadyDelivery(),
        items: [
          featureItem({ id: "cap-a", name: "项目登记与切换", scenario: "添加已有项目并在项目间切换", desc: "把本机项目登记进来", design: "已核对", impl: "result_submitted", vstate: "verified", vevidence: "verified", passed: 3, required: 3, missing: [], accept: "pending", review: { state: "passed", required: 2, passed: 2, missing: [], evidence: [] } }),
          featureItem({ id: "cap-b", name: "批量恢复", scenario: "一次恢复多个备份", desc: "批量恢复备份", design: "已核对", impl: "result_submitted", vstate: "pending_verification", vevidence: "missing", passed: 1, required: 2, missing: ["缺集成检查证据"], accept: "pending", review: { state: "pending", required: 2, passed: 0, missing: ["缺非作者审查记录"], evidence: [] } }),
        ],
      }),
    },
  },
  // ④ 分页：第一页 incomplete，续取第二页
  "p-paging": {
    status: 200,
    responses: {
      _: ledgerBody({
        delivery: readyDelivery(),
        paging: { complete: false, cursor: "cur1" },
        items: [
          featureItem({ id: "cap-a", name: "项目登记与切换", scenario: "添加已有项目并在项目间切换", desc: "登记项目", design: "已核对", impl: "result_submitted", vstate: "verified", vevidence: "verified", passed: 3, required: 3, missing: [], accept: "pending", review: { state: "passed", required: 2, passed: 2, missing: [], evidence: [] } }),
        ],
      }),
      cur1: ledgerBody({
        delivery: readyDelivery(),
        paging: { complete: true, cursor: null },
        items: [
          featureItem({ id: "cap-a", name: "项目登记与切换", scenario: "添加已有项目并在项目间切换", desc: "登记项目", design: "已核对", impl: "result_submitted", vstate: "verified", vevidence: "verified", passed: 3, required: 3, missing: [], accept: "pending", review: { state: "passed", required: 2, passed: 2, missing: [], evidence: [] } }),
          featureItem({ id: "cap-b", name: "备份与恢复", scenario: "导出并恢复项目状态", desc: "备份恢复", design: "已核对", impl: "result_submitted", vstate: "verified", vevidence: "verified", passed: 2, required: 2, missing: [], accept: "pending", review: { state: "passed", required: 2, passed: 2, missing: [], evidence: [] } }),
        ],
      }),
    },
  },
  // ③a 旧服务：路由不识别（404）→ 界面显式「未接入」
  "p-old404": {
    status: 404,
    responses: { _: { ok: false, error: { code: "NOT_FOUND", message: "no such route" } } },
  },
  // ③b 旧服务：路由在，但没有 delivery 字段 → 显式未知，不假绿
  "p-oldfield": {
    status: 200,
    responses: {
      _: ledgerBody({
        delivery: null,
        items: [
          featureItem({ id: "cap-a", name: "项目登记与切换", scenario: "添加已有项目并在项目间切换", desc: "登记项目", design: "已核对", impl: "result_submitted", vstate: "verified", vevidence: "verified", passed: 3, required: 3, missing: [], accept: "pending" }),
        ],
      }),
    },
  },
  // ⑩ 大范围：17 功能 / 24 阻断 / 4 类
  "p-large": {
    status: 200,
    responses: { _: ledgerBody({ delivery: largeDelivery(), items: LARGE_FEATURES }) },
  },
  // ⑨ 残缺 delivery：state 合法但结构缺失
  "p-broken": {
    status: 200,
    responses: {
      _: ledgerBody({
        delivery: brokenDelivery(),
        items: [
          featureItem({ id: "cap-a", name: "项目登记与切换", scenario: "添加已有项目并在项目间切换", desc: "登记项目", design: "已核对", impl: "result_submitted", vstate: "verified", vevidence: "verified", passed: 3, required: 3, missing: [], accept: "pending" }),
        ],
      }),
    },
  },
  // ⑨b 必要子结构缺失（每例只坏一项）——见 BROKEN_CORE_FIXTURES
  ...BROKEN_CORE_FIXTURES,
};

// ─────────────────────────── 极简 CDP 客户端（系统 Edge，无新增依赖） ───────────────────────────

function findBrowser(): string | null {
  const candidates = [
    process.env.TATAI_UI_BROWSER,
    process.env.TATAI_EDGE_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

type Msg = { id?: number; method?: string; params?: unknown; sessionId?: string; result?: unknown; error?: unknown };

class Cdp {
  private ws: WebSocket;
  private nextId = 0;
  private pending = new Map<number, (m: Msg) => void>();
  private waiters = new Map<string, Array<(m: Msg) => void>>();
  private listeners = new Map<string, Set<(m: Msg) => void>>();
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(String(ev.data)));
  }
  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP 连接失败")), { once: true });
    });
    return new Cdp(ws);
  }
  private onMessage(raw: string): void {
    let msg: Msg;
    try {
      msg = JSON.parse(raw) as Msg;
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const fn = this.pending.get(msg.id);
      if (fn !== undefined) {
        this.pending.delete(msg.id);
        fn(msg);
      }
      return;
    }
    if (msg.method !== undefined) {
      const key = `${msg.sessionId ?? "*"}:${msg.method}`;
      const persistent = this.listeners.get(key);
      if (persistent !== undefined) for (const fn of persistent) fn(msg);
      const list = this.waiters.get(key);
      if (list !== undefined && list.length > 0) {
        const fn = list.shift();
        if (fn !== undefined) fn(msg);
      }
    }
  }
  on(method: string, sessionId: string | undefined, cb: (m: Msg) => void): void {
    const key = `${sessionId ?? "*"}:${method}`;
    const set = this.listeners.get(key) ?? new Set<(m: Msg) => void>();
    set.add(cb);
    this.listeners.set(key, set);
  }
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Msg> {
    const id = ++this.nextId;
    const payload: Record<string, unknown> = { id, method };
    if (params !== undefined) payload.params = params;
    if (sessionId !== undefined) payload.sessionId = sessionId;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify(payload));
    });
  }
  async call(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    const res = await this.send(method, params, sessionId);
    if (res.error !== undefined) throw new Error(`${method} 失败：${JSON.stringify(res.error)}`);
    return res.result;
  }
  waitEvent(method: string, sessionId: string | undefined, timeoutMs: number): Promise<Msg> {
    const key = `${sessionId ?? "*"}:${method}`;
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(key) ?? [];
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error(`等待事件超时：${method}`));
      }, timeoutMs);
      const wrapped = (m: Msg): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(m);
      };
      if (list.length === 0) this.waiters.set(key, [wrapped]);
      else list.push(wrapped);
    });
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

class Page {
  private cdp: Cdp;
  private session: string;
  readonly consoleErrors: string[] = [];
  readonly exceptions: string[] = [];
  constructor(cdp: Cdp, session: string) {
    this.cdp = cdp;
    this.session = session;
  }
  static async open(cdp: Cdp, url: string): Promise<Page> {
    const created = (await cdp.call("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const attached = (await cdp.call("Target.attachToTarget", { targetId: created.targetId, flatten: true })) as { sessionId: string };
    const page = new Page(cdp, attached.sessionId);
    cdp.on("Runtime.exceptionThrown", page.session, (m) => {
      const p = m.params as { exceptionDetails?: { exception?: { description?: string }; text?: string } } | undefined;
      page.exceptions.push(p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text ?? "未知异常");
    });
    cdp.on("Runtime.consoleAPICalled", page.session, (m) => {
      const p = m.params as { type?: string; args?: Array<{ value?: unknown; description?: string }> } | undefined;
      if (p?.type === "error") {
        page.consoleErrors.push((p.args ?? []).map((a) => String(a.value ?? a.description ?? "")).join(" "));
      }
    });
    await cdp.call("Page.enable", {}, page.session);
    await cdp.call("Runtime.enable", {}, page.session);
    await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false }, page.session);
    const fixtures = `window.__DLV_FIXTURES = ${JSON.stringify(FIXTURES)};`;
    await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: fixtures }, page.session);
    await cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: INJECT_TEMPLATE }, page.session);
    const loaded = page.cdp.waitEvent("Page.loadEventFired", page.session, 30000);
    await cdp.call("Page.navigate", { url }, page.session);
    await loaded;
    return page;
  }
  async eval<T>(expression: string): Promise<T> {
    const res = (await this.cdp.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.session)) as {
      result?: { value?: unknown; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (res.exceptionDetails !== undefined) {
      throw new Error(`页面求值异常：${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "未知"}`);
    }
    return res.result?.value as T;
  }
  async waitFor(expression: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.eval<boolean>(`!!(${expression})`)) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  }
  async text(selector: string): Promise<string> {
    return this.eval<string>(`(function(){var e=document.querySelector(${JSON.stringify(selector)});return e?e.textContent:"";})()`);
  }
  async count(selector: string): Promise<number> {
    return this.eval<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  }
  async attr(selector: string, name: string): Promise<string | null> {
    return this.eval<string | null>(`(function(){var e=document.querySelector(${JSON.stringify(selector)});return e?e.getAttribute(${JSON.stringify(name)}):null;})()`);
  }
  async click(selector: string): Promise<boolean> {
    return this.eval<boolean>(
      `(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true;})()`,
    );
  }
  /** 默认**可见**文字：排除折叠 <details>（未展开）里除 <summary> 之外的内容。 */
  async visibleText(): Promise<string> {
    return this.eval<string>(
      `(function(){
        var b=document.body.cloneNode(true);
        var junk=b.querySelectorAll('script,style,noscript');
        for(var k=0;k<junk.length;k++){ junk[k].parentNode && junk[k].parentNode.removeChild(junk[k]); }
        var ds=b.querySelectorAll('details:not([open])');
        for(var i=0;i<ds.length;i++){
          var kids=ds[i].children;
          for(var j=kids.length-1;j>=0;j--){ if(kids[j].tagName!=='SUMMARY') ds[i].removeChild(kids[j]); }
        }
        return b.textContent||'';
      })()`,
    );
  }
  /** 「默认首屏」文字：不论详情当前是否被展开，都只取折叠前的默认可见层（去掉所有 details 正文）。 */
  async defaultText(): Promise<string> {
    return this.eval<string>(
      `(function(){
        var b=document.body.cloneNode(true);
        var junk=b.querySelectorAll('script,style,noscript');
        for(var k=0;k<junk.length;k++){ junk[k].parentNode && junk[k].parentNode.removeChild(junk[k]); }
        var ds=b.querySelectorAll('details');
        for(var i=0;i<ds.length;i++){
          var kids=ds[i].children;
          for(var j=kids.length-1;j>=0;j--){ if(kids[j].tagName!=='SUMMARY') ds[i].removeChild(kids[j]); }
        }
        return b.textContent||'';
      })()`,
    );
  }
  /** 某个元素范围内的「默认首屏」文字（同样去掉 details 正文）。 */
  async defaultTextOf(selector: string): Promise<string> {
    return this.eval<string>(
      `(function(){
        var root=document.querySelector(${JSON.stringify(selector)});
        if(!root) return "";
        var b=root.cloneNode(true);
        var ds=b.querySelectorAll('details');
        for(var i=0;i<ds.length;i++){
          var kids=ds[i].children;
          for(var j=kids.length-1;j>=0;j--){ if(kids[j].tagName!=='SUMMARY') ds[i].removeChild(kids[j]); }
        }
        return b.textContent||'';
      })()`,
    );
  }
  /** 全页文字（含折叠内容）——用于验「折叠也不丢」 */
  async allText(): Promise<string> {
    return this.eval<string>(`document.body.textContent||""`);
  }
  async setCtl(pid: string, ctl: Record<string, unknown>): Promise<void> {
    await this.eval(`(function(){window.__DLV.ctl[${JSON.stringify(pid)}] = ${JSON.stringify(ctl)};return true;})()`);
  }
  async shot(file: string): Promise<void> {
    const res = (await this.cdp.call("Page.captureScreenshot", { format: "png" }, this.session)) as { data: string };
    fs.writeFileSync(file, Buffer.from(res.data, "base64"));
  }
  /** 真浏览器视口（截图与「网格多列/窄屏不溢出」断言用；同一页可反复改宽） */
  async setViewport(width: number, height: number): Promise<void> {
    await this.cdp.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, this.session);
  }
  /** 真键盘按键（不是 `.click()` 代打）：验「整块是 button」的 Enter/Space/Escape 真实路径 */
  async press(key: "Enter" | "Space" | "Escape"): Promise<void> {
    // 空格键的 `key` 是 `" "`（不是 `"Space"`），否则 Chrome 不按「按钮激活」处理
    const map: Record<string, { key: string; code: string; keyCode: number; text: string }> = {
      Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
      Space: { key: " ", code: "Space", keyCode: 32, text: " " },
      Escape: { key: "Escape", code: "Escape", keyCode: 27, text: "" },
    };
    const k = map[key];
    await this.cdp.call(
      "Input.dispatchKeyEvent",
      { type: "keyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, text: k.text },
      this.session,
    );
    await this.cdp.call(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode },
      this.session,
    );
  }
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(OUT, "tmp-"));
  const home = path.join(tmp, "home");
  const root = path.join(tmp, "root");
  buildFixtures(home, root);

  const backendPort = await freePort();
  const vitePort = await freePort();
  let backend: ChildProcess | null = null;
  let vite: ChildProcess | null = null;
  let browser: ChildProcess | null = null;
  let cdp: Cdp | null = null;

  const backendLog = fs.openSync(path.join(OUT, "ui-backend.log"), "a");
  const viteLog = fs.openSync(path.join(OUT, "ui-vite.log"), "a");
  const browserLog = fs.openSync(path.join(OUT, "ui-browser.log"), "a");

  try {
    // 后端用 node 直接跑 tsx（不经过 pnpm/.bin shim，避免重写共享 junction 的 Windows shim）
    backend = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
      cwd: REPO,
      env: { ...process.env, TATAI_HOME: home, TATAI_PORT: String(backendPort) },
      stdio: ["ignore", backendLog, backendLog],
    });
    await waitHttp(`http://127.0.0.1:${backendPort}/health`, 120000, "后端");
    note(`后端就绪 127.0.0.1:${backendPort}（TATAI_HOME=${home}）`);

    vite = spawn(process.execPath, [path.join("node_modules", "vite", "bin", "vite.js"), "dev", "--port", String(vitePort), "--strictPort", "--host", "127.0.0.1"], {
      cwd: REPO,
      env: { ...process.env, TATAI_DEV_API_PORT: String(backendPort), TATAI_VITE_CACHE_DIR: path.join(tmp, "vite-cache") },
      stdio: ["ignore", viteLog, viteLog],
    });
    await waitHttp(`http://127.0.0.1:${vitePort}/`, 180000, "vite");
    note(`vite 就绪 http://127.0.0.1:${vitePort}`);

    const exe = findBrowser();
    if (exe === null) throw new Error("找不到 Edge/Chrome（可设 TATAI_UI_BROWSER 指定）");
    const userDataDir = path.join(tmp, "browser");
    const dbgPort = await freePort();
    browser = spawn(exe, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-proxy-server",
      "--proxy-server=direct://",
      "--proxy-bypass-list=*",
      "--disable-extensions",
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${dbgPort}`,
      "about:blank",
    ], { stdio: ["ignore", browserLog, browserLog] });
    await waitHttp(`http://127.0.0.1:${dbgPort}/json/version`, 60000, "浏览器调试口");
    const version = (await (await fetch(`http://127.0.0.1:${dbgPort}/json/version`)).json()) as { webSocketDebuggerUrl: string; Browser: string };
    note(`浏览器 ${version.Browser}`);
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);

    const base = `http://127.0.0.1:${vitePort}`;
    await runScenarios(cdp, base);

    const summary = `PASS ${results.filter((r) => r.ok).length} / ${results.length}`;
    note(summary);
  } finally {
    cdp?.close();
    killTree(browser);
    killTree(vite);
    killTree(backend);
    fs.closeSync(backendLog);
    fs.closeSync(viteLog);
    fs.closeSync(browserLog);
    await new Promise((r) => setTimeout(r, 1500));
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      note(`临时目录未清干净（进程占用，可手动删）：${tmp}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) process.exitCode = 1;
  writeReport();
  console.log(`\n结论：${failed.length === 0 ? "全部通过" : `${failed.length} 项未通过`}`);
}

async function runScenarios(cdp: Cdp, base: string): Promise<void> {
  const page = await Page.open(cdp, `${base}/#p/p-ready`);
  const shots = (name: string): string => path.join(OUT, `${name}.png`);

  try {
    await scenarioDefault(page, shots);
    await scenarioAcceptanceJump(page, base, shots);
    await scenarioMissing(page, base, shots);
    await scenarioOld(page, base, shots);
    await scenarioRealService(page, shots);
    await scenarioIntegration(page, shots);
    await scenarioBrokenShape(page, shots);
    await scenarioBrokenCore(page, shots);
    await scenarioLarge(page, shots);
    await scenarioPaging(page, base, shots);
    await scenarioRefreshFail(page, base, shots);
    await scenarioRace(page, base, shots);
    await scenarioMemory(page, base, shots);
    await scenarioGrid(page, shots);
    await scenarioReal18(page, shots);
    await scenarioCardStatus(page, shots);
    await scenarioCardInteraction(page, shots);
    await scenarioFirstScreen(page, shots);
    await scenarioDetailScrollStability(page, shots);
    await scenarioRegisteredCandidateOldHost(page, shots);

    check(page.exceptions.length === 0, "全程无未捕获页面异常（pageerror=0）", page.exceptions.slice(0, 3).join(" | "));
  } finally {
    await page.shot(shots("99-final")).catch(() => undefined);
  }
}

async function gotoTab(page: Page, view: string): Promise<void> {
  await page.click(`[data-main-nav] [data-view="${view}"]`);
}

/**
 * 打开某项目的「交付总览」页：hash 切项目（**不整页重载**，保住 __DLV.ctl），再显式点主导航里
 * 的「交付总览」——项目视图按项目记忆，前面的场景可能把该项目留在别的页上。
 */
async function openDelivery(page: Page, pid: string): Promise<void> {
  await page.eval(`(function(){window.location.hash="#p/${pid}";return true;})()`);
  await page.waitFor(`document.querySelector('[data-main-nav] [data-view="delivery"]')`, 20000);
  await page.click('[data-main-nav] [data-view="delivery"]');
  await page.waitFor(`document.querySelector('[data-delivery-overview]')`, 20000);
}

// ─────────── 本轮有界收敛（2026-10-09 Codex 复审裁定）的断言辅助 ───────────

/** 审定别名（逐条抄自 ROOT-UI-REVIEW.md 的「卡片短名 / 卡片一句用途」两列，**不是**从实现模块读回来的）。 */
const ALIAS_EXPECTED: Array<{ name: string; short: string; purpose: string }> = [
  { name: "设计书旁的人话功能清单与设计覆盖对照", short: "功能清单与设计对照", purpose: "看清项目有哪些功能、设计有没有遗漏。" },
  { name: "四维读数分开、绿色只按本范围验证", short: "功能进度与验收状态", purpose: "分清设计、实现、验证和人的接受。" },
  { name: "逐项交接包（check 级材料与下一动作）", short: "逐项工作交接", purpose: "让接手的 Agent 找到材料和下一步。" },
  { name: "提交→复验→下一动作的接续闭环", short: "提交后继续推进", purpose: "成果提交后，接着复验和处理下一步。" },
  { name: "源变复验（按界，恰一个动作）", short: "改动后重新验证", purpose: "找出改动影响的功能，重新检查。" },
  { name: "用户补充设计路径", short: "补充需求与设计", purpose: "让新想法有记录、能追到处理结果。" },
  { name: "人的验收结果可见", short: "人工验收", purpose: "由你决定接受或退回，保留结果。" },
  { name: "六图生成、按当前状况自动更新与人可读浏览", short: "项目图与自动更新", purpose: "查看项目结构和关联，跟上当前变化。" },
  { name: "Agent 直接读六图完整当前状态（MCP/HTTP 读口）", short: "Agent 读取项目图", purpose: "让 Agent 读到完整图内容和当前状态。" },
  { name: "业务数据流真实路径图（输入→处理→存储→输出/外部系统）", short: "业务数据流向", purpose: "看数据从哪里来、怎样处理、流到哪里。" },
  { name: "需求→设计→施工卡→实现/证据 可追溯", short: "需求与实现追踪", purpose: "从需求一路查到设计、实现和证据。" },
  { name: "五环审计、独立抽查与缺陷闭环", short: "审查与问题修复", purpose: "查出问题、修复复测，并保留依据。" },
  { name: "同步证据发现与完整性验收", short: "同步结果核对", purpose: "核对该同步的内容是否真正到位。" },
  { name: "桌面服务生命周期与安全默认配置", short: "桌面服务与安全", purpose: "管好随桌面启动的服务和默认配置。" },
  { name: "Agent 接续材料、入口与只读预检提效", short: "Agent 接手续做", purpose: "换会话、换 Agent 后仍能接着工作。" },
  { name: "人话主界面、日夜主题与图标一致", short: "界面与外观", purpose: "看懂项目，用合适的深浅主题。" },
  { name: "从已有代码补设计草稿", short: "生成设计草稿", purpose: "从已有项目的代码和资料补出设计草稿。" },
  { name: "交付总览与人工试用交接", short: "交付总览", purpose: "核对功能和审查结果，判断能否试用。" },
];

/** 把交付总览滚回顶部（第一屏几何断言必须在未滚动状态下量） */
async function resetOverviewScroll(page: Page): Promise<void> {
  await page.eval(`(function(){var h=document.querySelector('[data-delivery-overview]');if(h)h.scrollTop=0;return true;})()`);
  await new Promise((r) => setTimeout(r, 200));
}

interface RowMetric {
  ok: boolean;
  reason?: string;
  cards?: number;
  row?: number;
  top?: number;
  bottom?: number;
  hostTop?: number;
  hostBottom?: number;
  hostHeight?: number;
  headHeight?: number;
  headShare?: number | null;
  fullyVisible?: boolean;
}

/** 量「第一行方块」是否**完整**落在本页可视区（`[data-delivery-overview]` 自身是滚动容器） */
const FIRST_ROW_METRIC = `(function(){
  var host=document.querySelector('[data-delivery-overview]');
  if(!host) return {ok:false,reason:"no overview"};
  var cards=Array.prototype.slice.call(host.querySelectorAll('[data-delivery-grid] [data-delivery-feature]'));
  if(cards.length===0) return {ok:false,reason:"no cards"};
  var hr=host.getBoundingClientRect();
  var rects=cards.map(function(c){return c.getBoundingClientRect();});
  var minTop=Math.min.apply(null,rects.map(function(r){return r.top;}));
  var row=rects.filter(function(r){return Math.abs(r.top-minTop)<=2;});
  var top=Math.min.apply(null,row.map(function(r){return r.top;}));
  var bottom=Math.max.apply(null,row.map(function(r){return r.bottom;}));
  var hh=Math.round(hr.bottom-hr.top);
  var head=Math.round(top-hr.top);
  return {ok:true,cards:cards.length,row:row.length,top:Math.round(top),bottom:Math.round(bottom),
    hostTop:Math.round(hr.top),hostBottom:Math.round(hr.bottom),hostHeight:hh,headHeight:head,
    headShare:hh>0?Math.round((head/hh)*1000)/1000:null,
    fullyVisible:(top>=hr.top-1)&&(bottom<=hr.bottom+1)};
})()`;

/** 功能块/方块超出视口右缘的最大像素（负值也算，抓贴边裁剪） */
const FEATURES_OVERHANG = `(function(){var vw=document.documentElement.clientWidth;var m=0;document.querySelectorAll("[data-delivery-features], [data-delivery-detail-pane], [data-delivery-grid] [data-delivery-feature]").forEach(function(e){var r=e.getBoundingClientRect();var o=Math.round(r.right-vw);if(o>m)m=o;});return m;})()`;

async function scenarioDefault(page: Page, shots: (n: string) => string): Promise<void> {
  note("── ① 默认入口与首屏结论 ──");
  await page.eval(`(function(){window.location.hash="#p/p-ready";return true;})()`);
  // 默认入口：无持久选择的新项目应落到「交付总览」
  await page.waitFor(`document.querySelector('[data-main-nav] [data-view="delivery"]')`, 20000);
  const navFirst = await page.eval<string>(`(function(){var n=document.querySelector("[data-main-nav]");if(!n)return "";var b=n.querySelector("button");return b?b.textContent.trim():"";})()`);
  check(navFirst === "交付总览", "新导航第一项是「交付总览」", navFirst);
  const isActive = await page.eval<boolean>(`(function(){var b=document.querySelector('[data-main-nav] [data-view="delivery"]');return !!b && b.getAttribute("aria-current")==="page";})()`);
  check(isActive, "未持久选择时默认停在「交付总览」");

  const okReady = await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="ready_for_trial"]')`, 20000);
  check(okReady, "可试用夹具：结论态=ready_for_trial");
  const conclusion = await page.text("[data-delivery-conclusion]");
  check(/可以开始人工试用/.test(conclusion), "首屏人话回答「能否开始人工试用」", conclusion.trim().slice(0, 60));
  const gateCount = await page.count("[data-delivery-gate]");
  check(gateCount === 3, "三类交付核对都列出", String(gateCount));
  const featureCount = await page.count("[data-delivery-features] [data-delivery-feature]");
  check(featureCount >= 3, "正式功能表列出（含人话名与场景）", String(featureCount));
  const firstName = await page.text('[data-delivery-feature="cap-a"] [data-feature-name]');
  check(/项目登记与切换/.test(firstName), "功能项用人话名呈现", firstName.trim());
  const scenarioText = await page.text('[data-delivery-feature="cap-a"] [data-feature-scenario]');
  check(/添加已有项目/.test(scenarioText), "功能项带使用场景", scenarioText.trim());
  const review = await page.attr('[data-delivery-feature="cap-a"]', "data-agent-review");
  check(review === "passed", "每项带非作者审查读数", String(review));
  // 详细 ID / 证据 / 审查者与时间可展开：点方块 → 右栏详情 → 展开技术细节
  await page.click('[data-delivery-feature="cap-a"]');
  const paneShown = await page.waitFor(
    `(function(){var n=document.querySelector('[data-delivery-detail-pane] [data-detail-name]');return !!n && /项目登记与切换/.test(n.textContent||'');})()`,
    10000,
  );
  check(paneShown, "点功能方块后右栏详情切到该功能（原名）");
  const detailOpen = await page.eval<boolean>(
    `(function(){var d=document.querySelector('[data-delivery-detail-pane] [data-detail-technical]');if(!d)return false;d.open=true;var t=d.textContent||"";return /cap-a/.test(t) && /claude/.test(t);})()`,
  );
  check(detailOpen, "展开技术细节后有功能 ID / 证据来源 / 审查者与时间");
  // 人的接受单列、不代签
  const acc = await page.text("[data-delivery-acceptance]");
  check(/待|pending|你/.test(acc), "人的接受单列显示（不代签）", acc.trim().slice(0, 60));
  // 待映射需求与未登记候选另列且不混分母
  const pend = await page.count("[data-delivery-pending-requirements] [data-pending-requirement]");
  const cand = await page.count("[data-delivery-candidates] [data-candidate]");
  check(pend >= 1, "已登记待映射需求另列", String(pend));
  check(cand >= 1, "未登记候选另列", String(cand));
  const featuresSection = await page.text("[data-delivery-features]");
  check(!/未登记候选：多机同步/.test(featuresSection), "待映射/候选不混进正式功能分母");
  // 已登记待确认候选：另列、标明「已登记待确认」、ID/来源可见、不标「未登记」也不出现通过章
  const regCandidates = await page.count("[data-delivery-registered-candidates] [data-registered-candidate]");
  check(regCandidates >= 1, "已登记待确认候选另列", String(regCandidates));
  const regCandText = await page.text("[data-delivery-registered-candidates]");
  check(/已登记待确认候选/.test(regCandText), "候选区标题明写「已登记待确认候选」");
  check(/req-R13/.test(regCandText) && /待确认/.test(regCandText), "候选区给出需求 ID 与「待确认」状态", regCandText.replace(/\s+/g, " ").trim().slice(0, 160));
  check(!/未登记/.test(regCandText), "候选区不把这批说成「未登记」", regCandText.replace(/\s+/g, " ").trim().slice(0, 160));
  check(!/已通过|通过章/.test(regCandText), "候选区不出现通过章");
  check(!/req-R13/.test(featuresSection), "已登记待确认候选不混进正式功能卡片");
  const versionLine = await page.text("[data-delivery-version]");
  check(
    /已登记待确认 1/.test(versionLine) && /正式 4/.test(versionLine),
    "完整读数行显式给出正式分母（4）与已登记待确认候选数（1）",
    versionLine.replace(/\s+/g, " ").trim().slice(0, 220),
  );

  // ⑪ 组合流程验证：与三类核对并列、成功时也带证据可展开
  const intRow = await page.attr("[data-delivery-integration]", "data-integration-state");
  check(intRow === "passed", "组合流程验证读数与三类核对并列（integration=passed）", String(intRow));
  const intEvidence = await page.eval<boolean>(
    `(function(){var d=document.querySelector('[data-delivery-integration] details');if(!d)return false;d.open=true;return /int-project-delivery-01/.test(d.textContent||'');})()`,
  );
  check(intEvidence, "组合流程验证的证据可展开核对", "");

  // ⑧ 首屏去实现话术：默认首屏文字不得夹带「只读派生」「非作者」；功能行不得夹带 cap-ID
  const visDefault = await page.defaultText();
  check(!/只读派生/.test(visDefault), "首屏默认可见文字不含「只读派生」实现话术");
  check(!/非作者/.test(visDefault), "首屏默认文案用「Agent 审查」，不含「非作者」实现话术");
  check(/Agent审查/.test(visDefault), "首屏出现人话「Agent审查」字样");
  const headText = await page.defaultTextOf('[data-delivery-feature="cap-a"]');
  check(!/cap-a/.test(headText), "功能行默认可见文字不含 cap-ID（已移入折叠详情）");

  // 长段服务端结论（delivery.summary）不再占首屏：默认折叠，但依据仍可展开读到（不丢信息）
  const summaryFold = await page.count("[data-delivery-summary-fold]");
  check(summaryFold === 1, "服务端结论原文收在折叠区（默认不占首屏）");
  check(!/可以交给人试用|均已满足/.test(visDefault), "首屏默认可见文字不含长段服务端结论原文");
  check(/可以交给人试用/.test(await page.allText()), "折叠里仍能读到服务端结论原文（依据不丢）");
  check(
    /正式功能 \d+ 项/.test(visDefault) && /人的接受/.test(visDefault),
    "首屏有一行紧凑计数（正式功能/设计覆盖/技术验证/Agent审查 + 人的接受）",
  );

  dumpText("01-default-default-text.txt", visDefault);
  dumpText("01-default-full-text.txt", await page.allText());
  await page.shot(shots("01-default-ready"));
}

/** ⑧ 人的接受入口：点「去验收」必须落在「验收」子页，不进实况默认；不代写 Gate */
async function scenarioAcceptanceJump(page: Page, base: string, shots: (n: string) => string): Promise<void> {
  note("── ⑧ 「去验收」落到验收子页而非实况 ──");
  await openDelivery(page, "p-ready");
  await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="ready_for_trial"]')`, 20000);
  const hasBtn = (await page.count("[data-delivery-jump-acceptance]")) === 1;
  check(hasBtn, "交付总览有「去验收区记录你的接受」入口");
  await page.click("[data-delivery-jump-acceptance]");
  const onAcceptance = await page.waitFor(`document.querySelector('[data-acceptance-view]')`, 15000);
  check(onAcceptance, "点「去验收」真的落到验收子页（data-acceptance-view 在场）");
  const liveShown = await page.count("[data-live-view]");
  check(liveShown === 0, "没有停在「实况」默认子页（data-live-view 不在场）");
  const liveActive = await page.eval<boolean>(`(function(){var b=document.querySelector('[data-main-nav] [data-view="live"]');return !!b && b.getAttribute("aria-current")==="page";})()`);
  check(liveActive, "主导航停在「实况与验收」（验收子页挂在它下面）");
  // 不代写 Gate：验收区只呈现待验收记录，页面没有自动「接受」动作按钮（人工接受只由用户记录）
  const autoAccept = await page.count("[data-acceptance-view] [data-gate-accept]");
  check(autoAccept === 0, "验收子页没有自动接受动作（Agent 不代写 Gate）");
  await page.shot(shots("08-acceptance-jump"));
}

/**
 * ⑱ 已登记待确认候选 + 旧宿主兼容：新增 counts 字段缺失时显式「未知」，候选仍按 items 单列、
 * 不混进正式功能卡片，也不出现通过章。
 */
async function scenarioRegisteredCandidateOldHost(page: Page, shots: (n: string) => string): Promise<void> {
  note("── ⑱ 已登记待确认候选：旧宿主缺新 counts 字段 ⇒ 未知（不假 0）──");
  await openDelivery(page, "p-oldcounts");
  const okState = await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="ready_for_trial"]')`, 20000);
  check(okState, "旧宿主 ready 读数仍可读（不因新增字段缺失被整体降级）");
  const versionLine = await page.text("[data-delivery-version]");
  check(
    /正式 未知/.test(versionLine) && /已登记待确认 未知/.test(versionLine),
    "缺新字段 ⇒ 显式「未知」，不拿 0 冒充",
    versionLine.replace(/\s+/g, " ").trim().slice(0, 240),
  );
  const regCand = await page.count("[data-delivery-registered-candidates] [data-registered-candidate]");
  const regCandText = await page.text("[data-delivery-registered-candidates]");
  check(regCand === 0, "真正旧宿主没有新分类的条目");
  check(/未知/.test(regCandText) && !/0 项|（无）/.test(regCandText), "缺候选字段与条目时，候选区显示未知，不假报零项或无", regCandText);
  const featuresSection = await page.text("[data-delivery-features]");
  check(!/req-R13/.test(featuresSection), "旧宿主下候选同样不混进正式功能卡片");
  await page.shot(shots("15-registered-candidate-old-host"));
}

async function scenarioMissing(page: Page, base: string, shots: (n: string) => string): Promise<void> {
  note("── ② 缺证据/未审查：不可试用且点名 ──");
  await openDelivery(page, "p-missing");
  const okState = await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="not_ready"]')`, 20000);
  check(okState, "缺证据夹具：结论态=not_ready");
  const conclusion = await page.text("[data-delivery-conclusion]");
  check(/还不能开始人工试用|不能开始/.test(conclusion), "首屏明说还不能开始试用", conclusion.trim().slice(0, 60));
  const blockers = await page.count("[data-delivery-blockers] [data-delivery-blocker]");
  check(blockers >= 2, "阻断原因逐条列出", String(blockers));
  // 真实 kind 分类：两个真实类别都用人话标签（不落泛称兜底）
  const tV = await page.text('[data-delivery-blocker-group="technical_verification"] .tt-dlv-blocker-tag');
  const aR = await page.text('[data-delivery-blocker-group="agent_review"] .tt-dlv-blocker-tag');
  check(tV.includes("技术验证还没过") && aR.includes("还没有 Agent 审查记录"), "缺证据按真实类别用人话标签点出", `${tV} / ${aR}`);
  const gatesPending = await page.count('[data-delivery-gate][data-gate-state="pending"]');
  check(gatesPending >= 2, "未满足的核对项标 pending", String(gatesPending));
  const reviewState = await page.attr('[data-delivery-feature="cap-b"]', "data-agent-review");
  check(reviewState === "pending", "未审查功能标出非作者审查未完成", String(reviewState));
  check(!/可以开始人工试用/.test(conclusion), "未满足时不出现「可以开始人工试用」绿结论");
  const intPending = await page.attr("[data-delivery-integration]", "data-integration-state");
  check(intPending === "pending", "组合流程验证未通过时标 pending", String(intPending));
  await page.shot(shots("02-missing"));
}

async function scenarioOld(page: Page, base: string, shots: (n: string) => string): Promise<void> {
  note("── ③ 旧服务：路由不识别 / 字段缺失 ──");
  await openDelivery(page, "p-old404");
  const okUnsupported = await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="unsupported"]')`, 20000);
  check(okUnsupported, "旧服务（404）显式「本功能未接入」");
  const t404 = await page.text("[data-delivery-overview]");
  check(/未接入|还没有交付总览/.test(t404), "未接入文案明确", t404.trim().slice(0, 40));

  await openDelivery(page, "p-oldfield");
  const okUnknown = await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="unknown"]')`, 20000);
  check(okUnknown, "旧服务（缺 delivery 字段）结论=unknown");
  const tOld = await page.text("[data-delivery-overview]");
  check(!/可以开始人工试用/.test(tOld), "字段缺失时不假绿");
  await page.shot(shots("03-old-service"));
}

/** ③c 真服务：不注入，直接用真实后端返回验「不假绿」 */
async function scenarioRealService(page: Page, shots: (n: string) => string): Promise<void> {
  note("── ③c 真服务（不注入）：真实后端返回的功能清单 ──");
  await openDelivery(page, "p-real");
  const settled = await page.waitFor(
    `document.querySelector('[data-delivery-overview][data-delivery-state="unknown"], [data-delivery-overview][data-delivery-state="not_derived"], [data-delivery-overview][data-delivery-state="error"]')`,
    20000,
  );
  check(settled, "真服务返回（缺 delivery 字段/无法派生）时界面给出明确非绿结论");
  const realState = await page.attr("[data-delivery-overview]", "data-delivery-state");
  const conclusion = await page.text("[data-delivery-conclusion]");
  check(!/可以开始人工试用/.test(conclusion), "真服务上不出现「可以开始人工试用」");
  const explained = await page.count("[data-delivery-error], [data-delivery-unknown], [data-delivery-conclusion]");
  check(explained >= 1, "真服务的非绿结论带明确原因（不是空白首屏）");
  note(`真服务 p-real 结论态=${realState}（${conclusion.trim().slice(0, 40)}）`);
  await page.shot(shots("03b-real-service"));
}

/** ⑪ 组合流程验证缺字段：明确未知，不自己另算 overall */
async function scenarioIntegration(page: Page, shots: (n: string) => string): Promise<void> {
  note("── ⑪ 组合流程验证缺字段 → 未知 ──");
  await openDelivery(page, "p-large");
  await page.waitFor(`document.querySelector('[data-delivery-integration]')`, 20000);
  const st = await page.attr("[data-delivery-integration]", "data-integration-state");
  check(st === "unknown", "缺 integration 字段时组合流程验证=unknown（不假绿）", String(st));
  const t = await page.text("[data-delivery-integration]");
  check(/还没有提供|未知|无法确认/.test(t), "缺字段时明说未知原因", t.trim().slice(0, 40));
}

/** ⑨ 边界形态：state 合法但 counts/gates/version 缺失 → 未知，不崩溃、不假 ready */
async function scenarioBrokenShape(page: Page, shots: (n: string) => string): Promise<void> {
  note("── ⑨ 残缺 delivery 形态 → 未知，不假 ready ──");
  await openDelivery(page, "p-broken");
  await page.waitFor(`document.querySelector('[data-delivery-overview]')`, 20000);
  await new Promise((r) => setTimeout(r, 800));
  const st = await page.attr("[data-delivery-overview]", "data-delivery-state");
  check(st !== "ready_for_trial", "state 合法但结构缺失时不判为可试用", String(st));
  const conclusion = await page.text("[data-delivery-conclusion]");
  check(!/可以开始人工试用/.test(conclusion), "残缺形态下可见结论不含可试用承诺");
  const vis = await page.defaultText();
  check(!/可以开始人工试用|均已满足/.test(vis), "残缺形态下全页可见文字不含可试用承诺");
  check(vis.trim().length > 0, "残缺形态下有明确原因（不是空白首屏）");
  await page.shot(shots("09-broken-shape"));
}

/** ⑩ 大范围：17 功能 / 24 阻断 → 首屏人话合并、完整明细折叠不丢、功能列表仍可找到 */
/**
 * ⑨b 必要子结构缺失：`delivery` 的 state 写着 ready，但 counts/gates/version/user_acceptance/scope
 * 里恰有一项不完整或非法。契约要求「必要字段缺失 ⇒ 未知」，所以每一例都必须判非 ready、全页都不得
 * 出现可试用承诺。这一组是本轮独立复审新增的负例，专打容器级（只查 `typeof === object`）检查的盲区。
 */
async function scenarioBrokenCore(page: Page, shots: (n: string) => string): Promise<void> {
  note("── ⑨b 必要子结构缺失（counts={} / gates=[] / 缺行 / version={} / accept={} / scope 非法）→ 未知，不假 ready ──");
  const cases: Array<{ pid: string; what: string }> = [
    { pid: "p-broken-counts", what: "counts 空对象" },
    { pid: "p-broken-gates", what: "gates 空集" },
    { pid: "p-broken-gates-partial", what: "gates 缺 runtime 行" },
    { pid: "p-broken-version", what: "version 空对象" },
    { pid: "p-broken-accept", what: "user_acceptance 空对象" },
    { pid: "p-broken-scope", what: "scope 非法" },
  ];
  for (const c of cases) {
    await openDelivery(page, c.pid);
    await page.waitFor(`document.querySelector('[data-delivery-overview]')`, 20000);
    await new Promise((r) => setTimeout(r, 700));
    const st = await page.attr("[data-delivery-overview]", "data-delivery-state");
    check(st !== "ready_for_trial", `必要结构缺失（${c.what}）时不判为可试用`, String(st));
    const conclusion = await page.text("[data-delivery-conclusion]");
    check(!/可以开始人工试用/.test(conclusion), `必要结构缺失（${c.what}）时首屏结论不含可试用承诺`);
    const vis = await page.defaultText();
    check(!/可以开始人工试用|均已满足/.test(vis), `必要结构缺失（${c.what}）时全页可见文字无试用承诺`);
    check(vis.trim().length > 0, `必要结构缺失（${c.what}）时有明确原因（不是空白首屏）`);
    await page.shot(shots(`09b-${c.pid}`));
  }
}

async function scenarioLarge(page: Page, shots: (n: string) => string): Promise<void> {
  note("── ⑩ 大范围：人话合并首屏差项，明细一条不丢 ──");
  await openDelivery(page, "p-large");
  const ok = await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="not_ready"]')`, 20000);
  check(ok, "大范围夹具：结论态=not_ready");
  const features = await page.count("[data-delivery-features] [data-delivery-feature]");
  check(features === 17, "17 项正式功能都在功能列表里（仍可找到）", String(features));
  const groupCount = await page.count("[data-delivery-blockers] [data-delivery-blocker-group]");
  check(groupCount === 4, "首屏把阻断按人话类别合并（真实 4 类，不是一堆技术行）", String(groupCount));
  // 真实 kind 的 DOM 分类核对：每个真实类别都落在对应分组、用人话标签，**不落泛称兜底**
  for (const [kind, label] of [
    ["technical_verification", "技术验证还没过"],
    ["agent_review", "还没有 Agent 审查记录"],
    ["gate_runtime", "运行交付版本还没核对"],
    ["design_coverage", "设计覆盖有缺口"],
  ] as const) {
    const tag = await page.text(`[data-delivery-blocker-group="${kind}"] .tt-dlv-blocker-tag`);
    check(tag.includes(label), `真实阻断类别「${kind}」用人话标签呈现`, tag);
  }
  const groupKinds = await page.eval<string[]>(
    `Array.from(document.querySelectorAll("[data-delivery-blockers] [data-delivery-blocker-group]")).map(function(e){return e.getAttribute("data-delivery-blocker-group");})`,
  );
  check(
    groupKinds.length === 4 && groupKinds.every((k) => k !== null && k !== "unknown"),
    "分组 kind 都是真实类别（无 unknown/泛称兜底）",
    groupKinds.join(","),
  );
  const blockerTotal = await page.count("[data-delivery-blockers] [data-delivery-blocker]");
  check(blockerTotal === 24, "完整阻断明细折叠保留、一条不丢", String(blockerTotal));
  const detailPresent = await page.count("[data-delivery-blockers] [data-delivery-blocker-detail]");
  check(detailPresent === 1, "完整明细收在一条折叠里", String(detailPresent));
  // 默认首屏文字：不含功能 ID/技术检查号（都折叠），不含可试用承诺
  const vis = await page.defaultText();
  check(!/cap-\d\d/.test(vis), "首屏默认可见文字不含功能 ID（cap-xx 均折叠）");
  check(!/chk-/.test(vis), "首屏默认可见文字不含技术检查编号（chk-* 均折叠）");
  check(!/可以开始人工试用/.test(vis), "大范围不可试用时首屏无绿结论");
  check(!/还需要处理的事项/.test(vis), "首屏默认文字无泛称兜底（真实 kind 都有对应人话标签）");
  // 「差什么」的一行分类计数默认就在首屏（不是只能靠展开才知道）——折叠的是逐条明细，不是分类本身
  check(
    /还差 24 项/.test(vis) && /技术验证还没过/.test(vis) && /还没有 Agent 审查记录/.test(vis),
    "首屏一行给出待处理的分类计数（折叠的是逐条明细）",
    vis.replace(/\s+/g, " ").slice(0, 120),
  );
  // 折叠里确实还有功能 ID 明细（不丢）
  const all = await page.allText();
  check(/cap-a|cap-01/.test(all), "折叠详情里仍能追到功能/来源技术明细");
  dumpText("10-large-default-text.txt", vis);
  dumpText("10b-large-all-text.txt", all);
  await page.shot(shots("10-large"));
  await page.eval(
    `(function(){var d=document.querySelector('[data-delivery-blockers]');if(d)d.open=true;var i=document.querySelector('[data-delivery-blocker-detail]');if(i)i.open=true;return true;})()`,
  );
  await new Promise((r) => setTimeout(r, 250));
  const openedItems = await page.eval<number>(
    `(function(){var n=0;document.querySelectorAll("[data-delivery-blockers] [data-delivery-blocker]").forEach(function(e){if(e.offsetParent!==null)n++;});return n;})()`,
  );
  check(openedItems === 24, "展开折叠后 24 条技术明细真的可见（不是只留在 DOM 里）", String(openedItems));
  await page.shot(shots("10b-large-blockers"));
}

async function scenarioPaging(page: Page, base: string, shots: (n: string) => string): Promise<void> {
  note("── ④ 分页：续取完整、版本一致、409 立即撤结论、同版刷新不回退 ──");
  await openDelivery(page, "p-paging");
  const ok = await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="ready_for_trial"]')`, 20000);
  check(ok, "分页夹具首屏就绪");
  const before = await page.count("[data-delivery-features] [data-delivery-feature]");
  check(before === 1, "第一页只载入 1 项", String(before));
  const hasMore = await page.count("[data-delivery-load-more]");
  check(hasMore === 1, "有「继续读取下一页」入口");
  const clicked = await page.click("[data-delivery-load-more]");
  if (!clicked) {
    check(false, "续取按钮可点");
    return;
  }
  const grew = await page.waitFor(`document.querySelectorAll("[data-delivery-features] [data-delivery-feature]").length >= 2`, 10000);
  check(grew, "续取后功能项补齐");
  const after = await page.count("[data-delivery-features] [data-delivery-feature]");
  check(after >= 2, "续取后项数增加且不丢", String(after));
  const complete = await page.count("[data-delivery-paging-complete]");
  check(complete === 1, "续取到底后显示「已全部载入」");

  // ⑪/U2 同版本周期对账：保住已载入的后页，也必须保住对应的 paging（不退回「未载完」）
  note("     等待一轮同版周期对账（可见页 5s 一轮）…");
  await new Promise((r) => setTimeout(r, 7000));
  const stillComplete = await page.count("[data-delivery-paging-complete]");
  check(stillComplete === 1, "同版本刷新后仍显示「已全部载入」（不回退为未载齐）");
  const noMoreBtn = await page.count("[data-delivery-load-more]");
  check(noMoreBtn === 0, "同版本刷新后没有冒出「继续读取下一页」（旧游标不回退）");
  const keptItems = await page.count("[data-delivery-features] [data-delivery-feature]");
  check(keptItems >= 2, "同版本刷新后已载入项不丢", String(keptItems));
  await page.shot(shots("04b-paging-refresh-retain"));

  // 409：版本变了 → **立即**撤结论（不等新页成功），重读第一页，不拼接两版
  await openDelivery(page, "p-missing");
  await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="not_ready"]')`, 20000);
  await openDelivery(page, "p-paging");
  await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="ready_for_trial"]')`, 20000);
  // 让冲突后的重读慢一点，才能在窗口内观察「立即撤结论」
  await page.setCtl("p-paging", { conflictNext: true, delayMs: 1500 });
  const clicked2 = await page.click("[data-delivery-load-more]");
  if (!clicked2) {
    check(false, "冲突场景下续取按钮可点");
    await page.setCtl("p-paging", {});
    return;
  }
  const noticed = await page.waitFor(`document.querySelector('[data-delivery-paging-notice]')`, 10000);
  check(noticed, "续取遇到版本冲突（409）时明确提示旧页作废");
  const withdrawnNow = await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="stale"]')`, 2000);
  check(withdrawnNow, "409 时当前 ledger 立即失效（不等新页成功就撤就绪）");
  const concl409 = await page.text("[data-delivery-conclusion]");
  check(!/可以开始人工试用/.test(concl409), "409 后可见结论不含可试用承诺");
  const reset = await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="ready_for_trial"]')`, 15000);
  check(reset, "重读第一页成功后恢复结论");
  const count1 = await page.count("[data-delivery-features] [data-delivery-feature]");
  check(count1 === 1, "冲突后回到第一页（不把两版拼在一起）", String(count1));
  await page.setCtl("p-paging", {});
  await page.shot(shots("04-paging"));
}

async function scenarioRefreshFail(page: Page, base: string, shots: (n: string) => string): Promise<void> {
  note("── ⑤ 刷新失败：保留内容但撤下「可试用」，全页可见文字不得自相矛盾 ──");
  await openDelivery(page, "p-ready");
  await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="ready_for_trial"]')`, 20000);
  const before = await page.count("[data-delivery-features] [data-delivery-feature]");
  check(before >= 3, "刷新前已载入正式功能", String(before));
  // 同一项目下让下一轮后台对账（可见页面 5s 一轮）读失败
  await page.setCtl("p-ready", { failCount: 1 });
  const stale = await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-stale="1"]')`, 15000);
  check(stale, "同一项目后台刷新失败时进入「陈旧」态");
  const conclusion = await page.text("[data-delivery-conclusion]");
  check(!/可以开始人工试用/.test(conclusion), "刷新失败后撤下「可以开始人工试用」");
  const retained = await page.count("[data-delivery-features] [data-delivery-feature]");
  check(retained >= 3, "刷新失败仍保留上次成功内容", String(retained));
  const staleNote = await page.count("[data-delivery-stale-note]");
  check(staleNote >= 1, "显式说明「显示的是上次成功结果」");

  // U1 核心负例：全页**默认可见**文字不得再出现可试用承诺；绿色读数要么撤下、要么明确标「上次」
  const vis = await page.visibleText();
  check(!/可以开始人工试用|可以交给人试用|均已满足/.test(vis), "刷新失败后全页可见文字无任何可试用承诺", vis.replace(/\s+/g, " ").slice(0, 80));
  const visiblePositive = await page.eval<number>(
    `(function(){var n=0;document.querySelectorAll('.tt-dlv-positive, .tt-dlv-chip-ok').forEach(function(e){if(e.offsetParent!==null)n++;});return n;})()`,
  );
  check(visiblePositive === 0, "刷新失败后可见的「绿色通过」读数为 0（绿只可收进详情/标上次）", String(visiblePositive));
  // 旧 summary 若保留，须清楚标「上次结果」且默认折叠（不与非绿标题同屏并陈）
  const prevFolded = await page.eval<boolean>(
    `(function(){var d=document.querySelector('[data-delivery-prev-summary]');return !!d && d.open===false && /可以交给人试用|已满足/.test(d.textContent||'');})()`,
  );
  check(prevFolded, "旧 summary 收在折叠详情里并标为上次结果（默认不可见）");
  dumpText("05-refresh-fail-visible-text.txt", vis);
  dumpText("05-refresh-fail-full-text.txt", await page.allText());
  await page.shot(shots("05-refresh-fail"));

  // 「模拟恢复继续失败也不绿」
  await page.setCtl("p-ready", { failCount: 99 });
  await new Promise((r) => setTimeout(r, 6500));
  const stillStale = await page.attr("[data-delivery-overview]", "data-delivery-stale");
  const concl2 = await page.text("[data-delivery-conclusion]");
  check(stillStale === "1" && !/可以开始人工试用/.test(concl2), "继续失败时维持非绿（不因重试假恢复）", String(stillStale));

  await page.setCtl("p-ready", {});
  const recovered = await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="ready_for_trial"]')`, 20000);
  check(recovered, "刷新恢复后重新给出结论");
}

async function scenarioRace(page: Page, base: string, shots: (n: string) => string): Promise<void> {
  note("── ⑥ 快速切项目：晚到旧回包不串 ──");
  // 先把 p-ready / p-missing 的记忆页都设为「交付总览」（hash 切换不重载，注入 ctl 仍在）
  await openDelivery(page, "p-ready");
  await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="ready_for_trial"]')`, 20000);
  await openDelivery(page, "p-missing");
  await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="not_ready"]')`, 20000);
  // 从 p-missing 带延迟切回 p-ready（制造在途慢响应），120ms 内又切走 → 慢回包晚到
  await page.setCtl("p-ready", { delayMs: 1500 });
  await page.eval(`(function(){window.location.hash="#p/p-ready";return true;})()`);
  await new Promise((r) => setTimeout(r, 120));
  await page.eval(`(function(){window.location.hash="#p/p-missing";return true;})()`);
  const landed = await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="not_ready"]')`, 20000);
  check(landed, "切到缺证据项目后显示该项目结论");
  await new Promise((r) => setTimeout(r, 2000));
  const projectName = await page.text("[data-status-project]");
  const state = await page.attr("[data-delivery-overview]", "data-delivery-state");
  const readyAppeared = await page.count('[data-delivery-overview][data-delivery-state="ready_for_trial"]');
  check(/缺证据/.test(projectName), "当前项目名是缺证据夹具", projectName.trim());
  check(state === "not_ready", "晚到的旧项目回包没有覆盖新项目结论", String(state));
  check(readyAppeared === 0, "旧项目（可试用）结论没有串到新项目界面");
  await page.setCtl("p-ready", {});
  await page.shot(shots("06-race"));
}

async function scenarioMemory(page: Page, base: string, shots: (n: string) => string): Promise<void> {
  note("── ⑦ 项目记忆与既有入口 ──");
  await page.eval(`(function(){window.location.hash="#p/p-ready";return true;})()`);
  await page.waitFor(`document.querySelector('[data-main-nav] [data-view="delivery"]')`, 20000);
  await gotoTab(page, "design");
  const onDesign = await page.waitFor(`document.querySelector('[data-view="design"][aria-current="page"]')`, 8000);
  check(onDesign, "可切到「设计书」页（既有入口保留）");
  // 切走再回来应保持「设计书」（项目记忆）
  await page.eval(`(function(){window.location.hash="#p/p-missing";return true;})()`);
  await page.waitFor(`document.querySelector('[data-delivery-overview]')`, 20000);
  await page.eval(`(function(){window.location.hash="#p/p-ready";return true;})()`);
  const restored = await page.waitFor(`document.querySelector('[data-view="design"][aria-current="page"]')`, 10000);
  check(restored, "切项目再回来保持上次所选页面（项目记忆）");
  // 六图（项目图）等入口可达
  const navLabels = await page.eval<string[]>(`Array.from(document.querySelectorAll("[data-main-nav] button")).map(function(b){return b.textContent.trim();})`);
  check(
    navLabels.includes("项目图") && navLabels.includes("设计书") && navLabels.includes("施工图") && navLabels.includes("聊天") && navLabels.includes("实况与验收"),
    "六图/设计/施工/聊天/实况入口保持可达",
    navLabels.join(" / "),
  );
  check(navLabels.length === 6, "主导航恰为六页（交付总览 + 既有五页）", String(navLabels.length));
  // 跳转回调：交付总览的「去设计书」按钮能切页
  await gotoTab(page, "delivery");
  const onDelivery = await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="ready_for_trial"]')`, 20000);
  check(onDelivery, "可切回「交付总览」");
  const jump = await page.count("[data-delivery-jump-design]");
  check(jump === 1, "交付总览提供跳转到设计书的入口");
  const jumped = await page.click("[data-delivery-jump-design]");
  const onDesignAfterJump = jumped && (await page.waitFor(`document.querySelector('[data-view="design"][aria-current="page"]')`, 8000));
  check(onDesignAfterJump, "点「去设计书」能跳到设计书页");
  await page.shot(shots("07-memory"));
}

/**
 * ⑫ 界面返工（2026-10-09 用户已批准）：功能方块网格 + 右侧详情。
 * 这是本轮的**有界卡片交互 E2E**：验网格成列、点方块右栏随选中切换、键盘选取、关闭详情、
 * 全部项可访问、三类读数分开、1366/1440 深与浅、窄屏不横向溢出，并留档真浏览器截图。
 * 只用既有夹具读口（p-large 的 17 项），不新增 mock、不碰真实服务与真实 8787。
 */
async function scenarioGrid(page: Page, shots: (n: string) => string): Promise<void> {
  note("── ⑫ 功能方块网格 + 右侧详情（有界返工） ──");
  await openDelivery(page, "p-large");
  await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="not_ready"]')`, 20000);

  // 方块数量来自实时清单（17 项全在，不硬编码）；宽度用方块左上角 x 去重数出列数
  const cards = await page.count("[data-delivery-features] [data-delivery-feature]");
  check(cards === 17, "功能方块网格铺开全部 17 项（数量来自实时清单）", String(cards));
  const columns = await page.eval<number>(
    `(function(){var xs={};document.querySelectorAll("[data-delivery-grid] [data-delivery-feature]").forEach(function(e){xs[Math.round(e.getBoundingClientRect().left)]=1;});return Object.keys(xs).length;})()`,
  );
  check(columns >= 2, "默认视口下方块排成多列", String(columns));

  // 点不同方块 → 右栏随选中切换
  const firstName = await page.text("[data-delivery-detail-pane] [data-detail-name]");
  await page.click('[data-delivery-feature="cap-02"]');
  const switched = await page.waitFor(
    `(function(){var n=document.querySelector('[data-delivery-detail-pane] [data-detail-name]');return !!n && /正式功能2/.test(n.textContent||'');})()`,
    10000,
  );
  check(switched, "点另一个方块后右栏切到该功能", `${firstName.trim()} → 正式功能2`);
  // 详情三类读数分开（实现/技术验证/Agent审查各一枚，不合并成单一完成标志）
  const dims = await page.eval<string[]>(
    `Array.from(document.querySelectorAll("[data-delivery-detail-pane] .tt-dlv-pane-chips .tt-dlv-chip")).map(function(e){return e.getAttribute("data-dim");})`,
  );
  check(
    dims.includes("implementation") && dims.includes("verification") && dims.includes("review"),
    "详情把实现/技术验证/Agent审查分开呈现",
    dims.join(","),
  );

  // 键盘：方块可聚焦（整块是 button），激活后右栏切换——不靠点小字选卡
  await page.eval(`(function(){var c=document.querySelector('[data-delivery-feature="cap-03"]');if(c)c.focus();return true;})()`);
  const focused = await page.eval<boolean>(`document.activeElement===document.querySelector('[data-delivery-feature="cap-03"]')`);
  check(focused, "方块可获得键盘焦点（整块是 button）");
  await page.click('[data-delivery-feature="cap-03"]');
  const kbSelected = await page.waitFor(
    `(function(){var n=document.querySelector('[data-delivery-detail-pane] [data-detail-name]');return !!n && /正式功能3/.test(n.textContent||'');})()`,
    10000,
  );
  check(kbSelected, "键盘聚焦的方块可被选中并切换右栏");

  // 关闭详情（关闭按钮键盘可达）→ 点方块再打开
  await page.click("[data-delivery-detail-close]");
  const closed = await page.waitFor(`document.querySelectorAll("[data-delivery-detail-pane]").length === 0`, 8000);
  check(closed, "关闭详情可用（关闭按钮）");
  await page.click('[data-delivery-feature="cap-01"]');
  const reopened = await page.waitFor(`document.querySelector("[data-delivery-detail-pane]") !== null`, 8000);
  check(reopened, "关闭后点方块能重新打开详情");

  // 视口 × 主题截图 + 不横向溢出（量元素右缘超出视口的像素，比 scrollWidth 更能抓贴边裁剪）
  const overhang = FEATURES_OVERHANG;

  await page.setViewport(1366, 900);
  await new Promise((r) => setTimeout(r, 250));
  const o1366 = await page.eval<number>(overhang);
  check(o1366 <= 1, "1366 宽无横向溢出", String(o1366));
  await page.shot(shots("12-grid-1366-light"));

  await page.click("[data-theme-toggle]");
  await new Promise((r) => setTimeout(r, 250));
  const isDark = await page.eval<boolean>(`document.documentElement.getAttribute("data-theme")==="dark"`);
  check(isDark, "外观可切到深色（截图留档）");
  await page.shot(shots("12-grid-1366-dark"));

  await page.setViewport(1440, 900);
  await new Promise((r) => setTimeout(r, 250));
  const o1440 = await page.eval<number>(overhang);
  check(o1440 <= 1, "1440 宽无横向溢出", String(o1440));
  await page.shot(shots("12-grid-1440-dark"));

  await page.setViewport(1024, 820);
  await new Promise((r) => setTimeout(r, 250));
  const oNarrow = await page.eval<number>(overhang);
  check(oNarrow <= 1, "窄屏（1024）无横向溢出", String(oNarrow));
  const narrowPane = await page.count("[data-delivery-detail-pane]");
  check(narrowPane === 1, "窄屏仍能访问详情（叠放在网格**上方**，不是埋在卡下面）", String(narrowPane));
  await page.shot(shots("12-grid-narrow-dark"));

  // 复位视口与主题，不影响收尾断言
  await page.setViewport(1500, 950);
  await page.click("[data-theme-toggle]");
  await new Promise((r) => setTimeout(r, 200));
}

/**
 * ⑬ 18 项真实元数据（名称/场景原文取自前次正式 HTTP 快照，**只作显式 UI 夹具**）：
 * 卡片显示审定短名与一句用途，右栏保留原名与原场景，未审定原文原样完整显示。
 */
async function scenarioReal18(page: Page, shots: (n: string) => string): Promise<void> {
  note("── ⑬ 18 项真实元数据：卡片别名 / 右栏原名原场景 ──");
  await openDelivery(page, "p-real18");
  const laid = await page.waitFor(`document.querySelectorAll("[data-delivery-grid] [data-delivery-feature]").length === 18`, 20000);
  check(laid, "18 项真实正式功能全部铺成方块（数量来自实时清单，不硬编码）");

  const unit = ALIAS_EXPECTED.filter((a) => {
    const got = displayCopyOf(a.name);
    return got !== null && got.short === a.short && got.purpose === a.purpose;
  }).length;
  check(unit === ALIAS_EXPECTED.length, "审定别名表逐条命中（精确原文 → 短名 + 一句用途）", `${unit}/${ALIAS_EXPECTED.length}`);
  check(displayCopyOf("一个没有审定别名的新原文") === null, "未审定的原文不进别名表（调用方原样显示）");

  const dom = await page.eval<Array<{ id: string; name: string; purpose: string }>>(`(function(){
    return Array.prototype.slice.call(document.querySelectorAll('[data-delivery-grid] [data-delivery-feature]')).map(function(c){
      var n=c.querySelector('[data-feature-name]');var p=c.querySelector('[data-feature-scenario]');
      return {id:c.getAttribute('data-delivery-feature'),name:n?n.textContent.trim():'',purpose:p?p.textContent.trim():''};
    });
  })()`);
  const wantByName = new Map(ALIAS_EXPECTED.map((a) => [a.name, a]));
  const idToName = new Map(REAL18_META.map((m) => [m.id, m.name]));
  const bad: string[] = [];
  for (const d of dom) {
    const want = wantByName.get(idToName.get(d.id) ?? "");
    if (want === undefined) {
      bad.push(`${d.id}:没有对应审定别名`);
      continue;
    }
    if (d.name !== want.short || d.purpose !== want.purpose) bad.push(`${d.id}:${d.name} / ${d.purpose}`);
  }
  check(dom.length === 18 && bad.length === 0, "18 张卡片逐张显示审定短名与一句用途", bad.slice(0, 3).join(" | "));
  check(
    !/^设计书旁的人话功能清单/.test(dom[0]?.name ?? ""),
    "卡片不再直接显示技术长标题（已换短名）",
    dom[0]?.name ?? "",
  );

  // 右栏保留**原名称与原场景**（不因卡片用了短名而丢原文）
  await page.click('[data-delivery-feature="cap-six-graphs"]');
  const paneShown = await page.waitFor(`document.querySelector('[data-delivery-detail-pane] [data-detail-name]') !== null`, 8000);
  const paneName = (await page.text("[data-delivery-detail-pane] [data-detail-name]")).trim();
  const panePurpose = (await page.text("[data-delivery-detail-pane] [data-detail-purpose]")).trim();
  const sixGraphs = REAL18_META.find((m) => m.id === "cap-six-graphs");
  check(paneShown && sixGraphs !== undefined && paneName === sixGraphs.name, "右栏保留功能原名（不是卡片短名）", paneName);
  check(sixGraphs !== undefined && panePurpose.includes(sixGraphs.scenario), "右栏保留原场景原文", panePurpose.slice(0, 40));
  await page.shot(shots("13-real18-pane"));
}

/**
 * ⑯ 首屏几何：1366×768 第一行方块必须**完整**落在可视区——可试用、不可试用、以及带 24 条阻断时都要；
 * 同时量「顶部区高度」既证明顶部明显变短，也证明不是把文字藏起来了（折叠行与结论仍在）。
 */
async function scenarioFirstScreen(page: Page, shots: (n: string) => string): Promise<void> {
  note("── ⑯ 首屏几何：1366×768 第一行完整（含 not_ready / 大范围） ──");
  const cases: Array<{ pid: string; label: string; shot: string }> = [
    { pid: "p-real18", label: "可试用 18 项", shot: "16-real18-1366x768-light" },
    { pid: "p-mixed", label: "不可试用 8 项", shot: "16-mixed-1366x768-dark" },
    { pid: "p-large", label: "不可试用 17 项 + 24 条阻断", shot: "16-large-1366x768-dark" },
  ];
  // 第一例走浅色，其后走深色（两种主题都要能第一行完整）
  for (const c of cases) {
    await openDelivery(page, c.pid);
    await page.waitFor(`document.querySelector("[data-delivery-grid]")`, 20000);
    await page.setViewport(1366, 768);
    await resetOverviewScroll(page);
    const m = await page.eval<RowMetric>(FIRST_ROW_METRIC);
    check(m.ok === true && m.fullyVisible === true, `1366×768 第一行方块完整可见（${c.label}）`, JSON.stringify(m));
    check(
      m.headShare !== null && m.headShare !== undefined && m.headShare <= 0.5,
      `1366×768 顶部区不超过首屏可用高度的一半（卡片是主工作面）（${c.label}）`,
      `head=${m.headHeight}px / host=${m.hostHeight}px = ${m.headShare}`,
    );
    const over = await page.eval<number>(FEATURES_OVERHANG);
    check(over <= 1, `1366×768 无横向溢出（${c.label}）`, String(over));
    // 结论仍在首屏（首屏不是只有卡片）
    const conclVisible = await page.eval<boolean>(
      `(function(){var c=document.querySelector('[data-delivery-conclusion]');var h=document.querySelector('[data-delivery-overview]');if(!c||!h)return false;var r=c.getBoundingClientRect(),hr=h.getBoundingClientRect();return r.top>=hr.top-1&&r.bottom<=hr.bottom+1;})()`,
    );
    check(conclVisible, `1366×768 首屏仍能看到总体结论（${c.label}）`);
    if (c.pid !== "p-real18") {
      const line = (await page.text("[data-delivery-blockers-summary]")).trim();
      check(
        /还差 \d+ 项/.test(line) && /技术验证还没过|设计覆盖有缺口|Agent 审查记录|运行交付版本/.test(line),
        `1366×768 首屏一行给出待处理分类计数（${c.label}）`,
        line.slice(0, 70),
      );
    }
    await page.shot(shots(c.shot));
    if (c.pid === "p-real18") {
      check((await page.count("[data-delivery-blockers-summary]")) === 0, "没有阻断时不显示「还差什么」行（不制造无问题的问题）");
      await page.click("[data-theme-toggle]");
      await new Promise((r) => setTimeout(r, 250));
      await resetOverviewScroll(page);
      const md = await page.eval<RowMetric>(FIRST_ROW_METRIC);
      check(md.ok === true && md.fullyVisible === true, "1366×768 深色主题下第一行方块同样完整可见", JSON.stringify(md));
      await page.shot(shots("16-real18-1366x768-dark"));
    }
  }
  // 1440 宽再量一次（更宽的视口不能反而把第一行挤下去）
  await page.setViewport(1440, 900);
  await resetOverviewScroll(page);
  const m1440 = await page.eval<RowMetric>(FIRST_ROW_METRIC);
  check(m1440.ok === true && m1440.fullyVisible === true, "1440×900 第一行方块完整可见", JSON.stringify(m1440));
  await page.shot(shots("16-large-1440x900-dark"));

  await page.click("[data-theme-toggle]");
  await page.setViewport(1500, 950);
  await new Promise((r) => setTimeout(r, 250));
}

/**
 * ⑭ 完成态与负例读数：提交≠已实现、失效要复验、失败要有问题、无运行投影是「暂无实现记录」、
 * 后端没给审查读数是「未知」；缺口直接标在卡上；未审定原文原样完整且不横向溢出。
 */
async function scenarioCardStatus(page: Page, shots: (n: string) => string): Promise<void> {
  note("── ⑭ 完成态与负例读数（每张卡一个状态） ──");
  await openDelivery(page, "p-mixed");
  await page.waitFor(`document.querySelectorAll("[data-delivery-grid] [data-delivery-feature]").length === 8`, 20000);
  await page.setViewport(1366, 900);
  await resetOverviewScroll(page);

  const chip = (id: string, dim: string): Promise<string> =>
    page.text(`[data-delivery-feature="${id}"] .tt-dlv-chip[data-dim="${dim}"]`);
  const differs = async (id: string, dim: string, want: string, label: string): Promise<void> => {
    const t = (await chip(id, dim)).trim();
    check(t.includes(want), label, t);
  };

  await differs("cap-m-verified", "implementation", "已实现", "提交 + 验证当前有效 ⇒ 实现读作「已实现」");
  await differs("cap-m-verified", "verification", "验证通过", "验证当前有效 ⇒ 技术验证「验证通过」");
  await differs("cap-m-verified", "review", "已通过", "有有效独立审查 ⇒ Agent审查「已通过」");
  await differs("cap-m-submitted", "implementation", "已提交实现", "只提交未验证 ⇒ 「已提交实现」（不叫已实现）");
  await differs("cap-m-submitted", "verification", "待验证", "未验证 ⇒ 技术验证「待验证」");
  await differs("cap-m-submitted", "review", "未完成", "缺审查记录 ⇒ Agent审查「未完成」");
  await differs("cap-m-invalid", "verification", "需要复验", "证据已失效 ⇒ 「需要复验」");
  await differs("cap-m-failed", "verification", "有问题", "有明确失败检查 ⇒ 「有问题」");
  await differs("cap-m-norun", "implementation", "暂无实现记录", "图上无运行投影 ⇒ 「暂无实现记录」（不是「未开始」）");
  await differs("cap-m-unknown", "verification", "未知", "不认识的验证读数 ⇒ 显式「未知」");
  await differs("cap-m-noreview", "review", "未知", "后端没给审查读数 ⇒ 「未知」（不是「未完成」）");

  const gapChip = await page.count('[data-delivery-feature="cap-m-submitted"] .tt-dlv-chip[data-dim="gap"]');
  check(gapChip === 1, "有缺口的卡直接标出缺口条数（缺口可见）");
  const noGap = await page.count('[data-delivery-feature="cap-m-verified"] .tt-dlv-chip[data-dim="gap"]');
  check(noGap === 0, "没有缺口的卡不假装有缺口", String(noGap));
  const longName = (await page.text('[data-delivery-feature="cap-m-long"] [data-feature-name]')).trim();
  check(longName === LONG_ORIGINAL_NAME, "不在别名表里的原文原样完整显示（不截断、不省略）", longName.slice(0, 30));

  // 点开缺口卡：缺口明细在右栏可查（不是把信息藏掉）
  await page.click('[data-delivery-feature="cap-m-submitted"]');
  const gapDetail = await page.waitFor(`document.querySelector('[data-delivery-detail-pane] [data-feature-verify-missing]') !== null`, 8000);
  const gapText = (await page.text("[data-delivery-detail-pane] [data-feature-verify-missing]")).trim();
  const reviewGap = await page.count("[data-delivery-detail-pane] [data-feature-review-missing]");
  check(gapDetail && /缺技术验证证据/.test(gapText), "右栏能点开看到缺口明细", gapText);
  check(reviewGap === 1, "右栏分开列出审查缺口", String(reviewGap));

  // 未审定原文的超长名：窄屏与宽屏都不横向溢出
  await page.setViewport(1024, 820);
  await new Promise((r) => setTimeout(r, 250));
  const overNarrow = await page.eval<number>(FEATURES_OVERHANG);
  check(overNarrow <= 1, "超长原文在窄屏不横向溢出", String(overNarrow));
  await page.setViewport(1366, 900);
  await new Promise((r) => setTimeout(r, 250));
  const overWide = await page.eval<number>(FEATURES_OVERHANG);
  check(overWide <= 1, "超长原文在宽屏不横向溢出", String(overWide));
  const cardFits = await page.eval<boolean>(
    `(function(){var c=document.querySelector('[data-delivery-feature="cap-m-long"]');if(!c)return false;return c.scrollWidth<=c.clientWidth+1;})()`,
  );
  check(cardFits, "超长方块自身没有横向滚动（内容完整换行）");
  await page.shot(shots("14-card-status"));
  await page.setViewport(1500, 950);
}

/**
 * ⑮ 卡片交互：关闭后网格占满可用宽度 / 真键盘选中与 Esc 关闭 / 焦点回到触发方块 /
 * 窄屏选中后详情到达可视区且在网格上方 / 切项目不串详情 / 刷新失败旧读数注明「上次」。
 */
async function scenarioCardInteraction(page: Page, shots: (n: string) => string): Promise<void> {
  note("── ⑮ 卡片交互：满宽 / 键盘 / 焦点 / 窄屏到达 / 不串详情 ──");
  await openDelivery(page, "p-real18");
  await page.waitFor(`document.querySelectorAll("[data-delivery-grid] [data-delivery-feature]").length === 18`, 20000);
  await page.setViewport(1366, 900);
  await new Promise((r) => setTimeout(r, 250));

  const openWidth = await page.eval<number>(`document.querySelector("[data-delivery-grid]").getBoundingClientRect().width`);
  check((await page.count("[data-delivery-detail-pane]")) === 1, "宽屏默认展示当前选中项的详情");
  await page.click("[data-delivery-detail-close]");
  const closed = await page.waitFor(`document.querySelectorAll("[data-delivery-detail-pane]").length === 0`, 8000);
  check(closed, "关闭详情可用（关闭按钮）");
  const layoutClosed = await page.attr("[data-detail-open]", "data-detail-open");
  check(layoutClosed === "0", "关闭后布局标记为单栏（不留空栏）", String(layoutClosed));
  const closedWidth = await page.eval<number>(`document.querySelector("[data-delivery-grid]").getBoundingClientRect().width`);
  check(closedWidth > openWidth + 200, "关闭详情后网格占满可用宽度", `${Math.round(openWidth)} → ${Math.round(closedWidth)}`);
  await resetOverviewScroll(page);
  await page.shot(shots("15-grid-full-width"));

  // 真键盘：聚焦方块 → Enter 选中（整块是 button，不是点小字）
  await page.eval(`(function(){document.querySelector('[data-delivery-feature="cap-ui-experience"]').focus();return true;})()`);
  await page.press("Enter");
  const kbSelected = await page.waitFor(
    `(function(){var n=document.querySelector('[data-delivery-detail-pane] [data-detail-name]');return !!n && n.textContent.indexOf("人话主界面")>=0;})()`,
    8000,
  );
  check(kbSelected, "键盘 Enter 可选中方块并切换右栏（真按键，不是 .click()）");
  // Esc 关闭 + 焦点回到触发方块
  await page.press("Escape");
  const escClosed = await page.waitFor(`document.querySelectorAll("[data-delivery-detail-pane]").length === 0`, 8000);
  check(escClosed, "Esc 可关闭详情（键盘可用）");
  const focusBack = await page.eval<boolean>(`document.activeElement === document.querySelector('[data-delivery-feature="cap-ui-experience"]')`);
  check(focusBack, "关闭详情后焦点回到触发方块");

  // 真键盘：Space 也能选中
  await page.eval(`(function(){document.querySelector('[data-delivery-feature="cap-reverse-draft"]').focus();return true;})()`);
  await page.press("Space");
  const spaceSelected = await page.waitFor(
    `(function(){var n=document.querySelector('[data-delivery-detail-pane] [data-detail-name]');return !!n && n.textContent.indexOf("从已有代码补设计草稿")>=0;})()`,
    8000,
  );
  check(spaceSelected, "键盘空格也能选中方块（整块可操作）");

  // 窄屏：换一个项目（全新挂载、无选中）时先看到卡片，不预占详情位
  await page.setViewport(1024, 820);
  await new Promise((r) => setTimeout(r, 250));
  await openDelivery(page, "p-mixed");
  await page.waitFor(`document.querySelectorAll("[data-delivery-grid] [data-delivery-feature]").length === 8`, 20000);
  await resetOverviewScroll(page);
  const narrowDefault = await page.count("[data-delivery-detail-pane]");
  check(narrowDefault === 0, "窄屏未选中时不占位（首屏直接是卡片）", String(narrowDefault));
  const narrowOpen = await page.attr("[data-detail-open]", "data-detail-open");
  check(narrowOpen === "0", "窄屏未选中时网格单栏占满", String(narrowOpen));
  const narrowRow = await page.eval<RowMetric>(FIRST_ROW_METRIC);
  check(narrowRow.ok === true && narrowRow.fullyVisible === true, "窄屏未选中时第一行方块完整可见", JSON.stringify(narrowRow));
  // 选中靠后的最后一张卡：详情必须到达可视区、且在网格上方（不埋在 8 张卡下面）
  await page.click('[data-delivery-feature="cap-m-long"]');
  await new Promise((r) => setTimeout(r, 500)); // 等 scrollIntoView
  const narrowState = await page.eval<{ paneTop: number; paneBottom: number; gridTop: number; hostTop: number; hostBottom: number; inView: boolean; above: boolean } | null>(
    `(function(){
      var host=document.querySelector('[data-delivery-overview]');
      var pane=document.querySelector('[data-delivery-detail-pane]');
      var grid=document.querySelector('[data-delivery-grid]');
      if(!host||!pane||!grid) return null;
      var pr=pane.getBoundingClientRect(),gr=grid.getBoundingClientRect(),hr=host.getBoundingClientRect();
      return {paneTop:Math.round(pr.top),paneBottom:Math.round(pr.bottom),gridTop:Math.round(gr.top),
        hostTop:Math.round(hr.top),hostBottom:Math.round(hr.bottom),
        inView:pr.bottom>hr.top&&pr.top<hr.bottom, above:pr.top<=gr.top+1};
    })()`,
  );
  check(narrowState !== null && narrowState.inView, "窄屏选中后详情到达可视区（不埋在卡下面）", JSON.stringify(narrowState));
  check(narrowState !== null && narrowState.above, "窄屏详情叠在网格上方（在卡片附近）", JSON.stringify(narrowState));
  await page.shot(shots("15-narrow-arrival"));
  await page.press("Escape");
  await new Promise((r) => setTimeout(r, 300));
  const narrowFocus = await page.eval<boolean>(`document.activeElement === document.querySelector('[data-delivery-feature="cap-m-long"]')`);
  const narrowCardInView = await page.eval<boolean>(
    `(function(){var c=document.querySelector('[data-delivery-feature="cap-m-long"]');var h=document.querySelector('[data-delivery-overview]');if(!c||!h)return false;var r=c.getBoundingClientRect(),hr=h.getBoundingClientRect();return r.bottom>hr.top&&r.top<hr.bottom;})()`,
  );
  check(narrowFocus && narrowCardInView, "窄屏关闭详情后焦点与可视区都回到触发方块", `${narrowFocus}/${narrowCardInView}`);

  // 切项目不串详情
  await page.setViewport(1500, 950);
  await openDelivery(page, "p-real18");
  await page.click('[data-delivery-feature="cap-sync-evidence"]');
  await page.waitFor(`(function(){var n=document.querySelector('[data-delivery-detail-pane] [data-detail-name]');return !!n&&n.textContent.indexOf("同步证据发现")>=0;})()`, 8000);
  await openDelivery(page, "p-mixed");
  await page.waitFor(`document.querySelectorAll("[data-delivery-grid] [data-delivery-feature]").length === 8`, 20000);
  const afterSwitch = (await page.text("[data-delivery-detail-pane] [data-detail-name]")).trim();
  check(!/同步证据发现/.test(afterSwitch) && afterSwitch.length > 0, "切项目后不残留上一个项目的详情", afterSwitch);

  // 刷新失败：卡片读数注明「上次」且不再显绿
  await openDelivery(page, "p-ready");
  await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="ready_for_trial"]')`, 20000);
  await page.setCtl("p-ready", { failCount: 1 });
  const stale = await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-stale="1"]')`, 15000);
  check(stale, "后台刷新失败进入「陈旧」态（本轮复测）");
  const staleChip = (await page.text('[data-delivery-feature="cap-a"] .tt-dlv-chip[data-dim="verification"]')).trim();
  check(staleChip.includes("（上次）"), "刷新失败后卡片读数明确注明「上次」", staleChip);
  const staleGreen = await page.eval<number>(
    `(function(){var n=0;document.querySelectorAll('.tt-dlv-chip-ok').forEach(function(e){if(e.offsetParent!==null)n++;});return n;})()`,
  );
  check(staleGreen === 0, "刷新失败后卡片上不再有可见的绿色通过读数", String(staleGreen));
  const paneStale = await page.count("[data-delivery-detail-pane][data-pane-stale='1'] [data-detail-stale-note]");
  check(paneStale === 1, "刷新失败时右栏也注明「这是上次读数」", String(paneStale));
  await page.setCtl("p-ready", {});
  await page.waitFor(`document.querySelector('[data-delivery-overview][data-delivery-state="ready_for_trial"]')`, 20000);
}

/**
 * ⑰ 窄屏详情的滚动位置（Codex 代码复审回归）：**同项目成功后台刷新**不得把用户已经下滑的页面
 *    抢回详情；而选卡 / 重开详情 / 切到窄屏这些**用户意图**仍要到达详情。
 *
 * 回归来源：窄屏 `scrollIntoView` 的 effect 曾把整个 `ledger` 放进依赖。同项目周期对账每轮都把
 * `ledger` 换成**新对象**，于是用户读完详情自己下滑后，会被下一轮刷新强行拉回详情。
 * 夹具用法：p-mixed 的这次「成功刷新」只把所选功能的 `design_coverage.state` 从「已核对」改成
 * 「缺失」——右栏的「设计覆盖」行随之更新，卡片可见文字与布局不变，所以滚动位置只受本回归影响。
 */
async function scenarioDetailScrollStability(page: Page, shots: (n: string) => string): Promise<void> {
  note("── ⑰ 窄屏详情：成功刷新不抢滚动位置 / 关掉重开仍到达 ──");
  interface PaneView {
    scrollTop: number;
    paneTop: number;
    inView: boolean;
  }
  const PANE_VIEW = `(function(){
    var host=document.querySelector('[data-delivery-overview]');
    var pane=document.querySelector('[data-delivery-detail-pane]');
    if(!host||!pane) return null;
    var pr=pane.getBoundingClientRect(),hr=host.getBoundingClientRect();
    return {scrollTop:Math.round(host.scrollTop),paneTop:Math.round(pr.top-hr.top),
      inView:pr.bottom>hr.top&&pr.top<hr.bottom};
  })()`;

  await page.setViewport(1024, 820);
  await new Promise((r) => setTimeout(r, 250));
  await openDelivery(page, "p-mixed");
  await page.waitFor(`document.querySelectorAll("[data-delivery-grid] [data-delivery-feature]").length === 8`, 20000);
  await resetOverviewScroll(page);

  // ① 用户选卡：详情到达可视区（先证明「用户意图到达」这条路径本身可用）
  await page.click('[data-delivery-feature="cap-m-long"]');
  await new Promise((r) => setTimeout(r, 600));
  const arrived = await page.eval<PaneView | null>(PANE_VIEW);
  check(
    arrived !== null && arrived.inView === true && Math.abs(arrived.paneTop) <= 8,
    "⑰ 窄屏选卡后详情到达可视区（用户意图触发，详情起点对齐到可视区顶）",
    JSON.stringify(arrived),
  );

  // ② 用户自行下滑到别处（越过详情起点）并记下位置。
  // 判据取「详情起点已被滚到可视区上方」（`paneTop <= -8`）而不是「详情完全不可见」：详情栏很高，
  // 下滑后它仍可能与可视区**部分重叠**（实测 paneTop=-588 时 inView 仍为 true），后者不成立。
  const scrollAway = await page.eval<number>(
    `(function(){var h=document.querySelector('[data-delivery-overview]');h.scrollTop=Math.round((h.scrollHeight-h.clientHeight)*0.7);return Math.round(h.scrollTop);})()`,
  );
  const away = await page.eval<PaneView | null>(PANE_VIEW);
  check(
    away !== null && away.paneTop <= -8 && away.scrollTop === scrollAway && scrollAway > 0,
    "⑰ 用户手动下滑后已经越过详情起点（回归前提成立）",
    JSON.stringify(away),
  );
  await page.shot(shots("17-narrow-scrolled-away"));

  // ③ 触发一次**同项目成功刷新**：改夹具 + `online` 事件立即对账（不依赖 5 秒定时器）
  const callsBefore = await page.eval<number>(`window.__DLV.calls.filter(function(c){return c.pid==="p-mixed";}).length`);
  await page.eval(
    `(function(){
      var items=window.__DLV_FIXTURES["p-mixed"].responses._.ledger.items;
      for(var i=0;i<items.length;i++){ if(items[i].item_id==="cap-m-long") items[i].design_coverage.state="缺失"; }
      window.dispatchEvent(new Event("online"));
      return true;
    })()`,
  );
  const refreshed = await page.waitFor(
    `(function(){var p=document.querySelector('[data-delivery-detail-pane]');return !!p&&p.textContent.indexOf("缺设计依据")>=0;})()`,
    15000,
  );
  const callsAfter = await page.eval<number>(`window.__DLV.calls.filter(function(c){return c.pid==="p-mixed";}).length`);
  check(refreshed, "⑰ 同项目成功刷新后详情内容确实更新（设计覆盖：缺设计依据）");
  check(callsAfter > callsBefore, "⑰ 这次刷新确实发出了 feature-ledger 请求（内容更新不是本地假象）", `${callsBefore} → ${callsAfter}`);

  const after = await page.eval<PaneView | null>(PANE_VIEW);
  check(
    after !== null && Math.abs(after.scrollTop - scrollAway) <= 2,
    "⑰ 成功刷新后滚动位置保持（不把用户拉回详情）",
    `下滑后 ${scrollAway} → 刷新后 ${after === null ? "null" : after.scrollTop}`,
  );
  check(after !== null && after.paneTop <= -8, "⑰ 成功刷新后仍停在用户滑到的位置（详情起点没被拉回来）", JSON.stringify(after));
  await page.shot(shots("17-narrow-after-refresh"));

  // ④ 关掉再打开同一张卡：仍要到达（修滚动位置不能顺手把「用户意图」也去掉）
  await page.press("Escape");
  await new Promise((r) => setTimeout(r, 300));
  check((await page.count("[data-delivery-detail-pane]")) === 0, "⑰ Esc 仍能关掉详情");
  await page.click('[data-delivery-feature="cap-m-long"]');
  await new Promise((r) => setTimeout(r, 600));
  const reopened = await page.eval<PaneView | null>(PANE_VIEW);
  check(
    reopened !== null && reopened.inView === true && Math.abs(reopened.paneTop) <= 8,
    "⑰ 关闭后重新打开同卡仍到达详情（起点对齐）",
    JSON.stringify(reopened),
  );

  // ⑤ 换一张卡：也要到达，且右栏跟着换（不串详情）
  await page.click('[data-delivery-feature="cap-m-failed"]');
  await new Promise((r) => setTimeout(r, 600));
  const switched = await page.eval<PaneView | null>(PANE_VIEW);
  const switchedName = (await page.text("[data-delivery-detail-pane] [data-detail-name]")).trim();
  check(
    switched !== null && switched.inView === true && Math.abs(switched.paneTop) <= 8,
    "⑰ 换一张卡后详情仍到达可视区（起点对齐）",
    JSON.stringify(switched),
  );
  check(switchedName.indexOf("有检查明确失败") >= 0, "⑰ 换卡后右栏跟着换（不串详情）", switchedName);

  // ⑥ 切到宽屏：详情栏固定可见（narrow=false 时不该再靠滚动到达）
  await page.setViewport(1500, 950);
  await new Promise((r) => setTimeout(r, 300));
  check((await page.count("[data-delivery-detail-pane]")) === 1, "⑰ 切到宽屏后详情栏仍然可见");

  // ⑦ 刷新后选中项**消失**：不渲染悬空详情，也不跳（读取后 selection 不存在不能跳）。
  // 这次刷新的 package_revision 也变了，所以交付总览不会按「同版保住已载入后页」留下旧项。
  await page.setViewport(1024, 820);
  await new Promise((r) => setTimeout(r, 400));
  const scrollAway2 = await page.eval<number>(
    `(function(){var h=document.querySelector('[data-delivery-overview]');h.scrollTop=Math.round((h.scrollHeight-h.clientHeight)*0.7);return Math.round(h.scrollTop);})()`,
  );
  await page.eval(
    `(function(){
      var fx=window.__DLV_FIXTURES["p-mixed"];
      if(!window.__DLV_KEEP_BODY) window.__DLV_KEEP_BODY=fx.responses._;
      var body=JSON.parse(JSON.stringify(window.__DLV_KEEP_BODY));
      body.ledger.package_revision="pkg-ready-2";
      body.ledger.items=body.ledger.items.filter(function(i){return i.item_id!=="cap-m-failed";});
      fx.responses._=body;
      window.dispatchEvent(new Event("online"));
      return true;
    })()`,
  );
  const paneGone = await page.waitFor(`document.querySelectorAll("[data-delivery-detail-pane]").length === 0`, 15000);
  const gone = await page.eval<{ scrollTop: number; max: number }>(
    `(function(){var h=document.querySelector('[data-delivery-overview]');return {scrollTop:Math.round(h.scrollTop),max:Math.round(h.scrollHeight-h.clientHeight)};})()`,
  );
  check(paneGone, "⑰ 源刷新后选中项消失：不再渲染悬空详情");
  // 这里**不断言** scrollTop 精确不变：面板本身就叠在网格上方，它一消失，可视区上方的高度就变了，
  // 浏览器的滚动锚定/夹取会**合法地**调整 scrollTop。实测 884 → 267（新上限 647）。硬把它当回归
  // 判据不成立；「有没有可跳的目标」这一点由上面的 paneGone 断言给出（没有面板就没有滚动目标）。
  note(`⑰ 面板消失后 scrollTop 由滚动锚定/夹取调整：${scrollAway2} → ${gone.scrollTop}（新上限 ${gone.max}），故不断言精确不变`);

  // 还原夹具（p-mixed 的原始读数留给别的场景）
  await page.eval(
    `(function(){
      var fx=window.__DLV_FIXTURES["p-mixed"];
      if(window.__DLV_KEEP_BODY) fx.responses._=window.__DLV_KEEP_BODY;
      var items=fx.responses._.ledger.items;
      for(var i=0;i<items.length;i++){ if(items[i].item_id==="cap-m-long") items[i].design_coverage.state="已核对"; }
      return true;
    })()`,
  );
}

// ─────────────────────────── 报告 ───────────────────────────

function writeReport(): void {
  const passed = results.filter((r) => r.ok).length;
  const lines: string[] = [];
  lines.push(`# V09-62 交付总览 UI 验证（真浏览器）`);
  lines.push("");
  lines.push(`- 时间：${new Date().toISOString()}`);
  lines.push(`- 命令：node node_modules/tsx/dist/cli.mjs scripts/verify-delivery-overview-ui.ts（证据目录 ${OUT}）`);
  lines.push(`- 结果：${passed} / ${results.length} 通过`);
  lines.push("");
  lines.push(`- 真服务：临时 TATAI_HOME + 动态端口起真实后端（src/server/index.ts）+ 真实 Vite dev server + 真实浏览器（系统 Edge，CDP 直驱）。`);
  lines.push(`- 可控夹具：仅拦截 feature-ledger 读口，为 delivery/agent_review/delivery.integration 提供场景数据；其余请求走真实服务。`);
  lines.push(`- 未覆盖：真实后端 delivery 派生、安装版同源（由协调者另验）；本脚本不把夹具当真服务实测。`);
  lines.push(`- 真服务面：p-real 不注入，直接读真实后端（含其缺字段路径），确认不出现「可以开始人工试用」。`);
  lines.push(`- 本轮有界返工补充：U1 刷新失败全页可见文字负例（含 409 立即撤结论、继续失败不绿）；U2 同版刷新保住 paging 不回退；U3 去验收落 acceptance 子页；U4 首屏去实现话术/ID（17 功能 + 24 阻断人话合并、明细不丢）；⑨ 残缺 delivery 形态降未知；⑪ integration 缺字段明确未知。`);
  lines.push(`- ⑨b 独立复审补（非作者）：必要子结构逐项缺失（counts={} / gates=[] / gates 缺行 / version={} / user_acceptance={} / scope 非法）都判非 ready——旧的容器级检查只查 typeof object，会把它们当一次可用读数。`);
  lines.push("");
  for (const r of results) lines.push(`- ${r.ok ? "[x]" : "[ ]"} ${r.label}${r.detail === undefined ? "" : ` — ${r.detail}`}`);
  lines.push("");
  fs.writeFileSync(path.join(OUT, "REPORT.txt"), lines.join("\n"), "utf8");
  fs.writeFileSync(
    path.join(OUT, "results.json"),
    JSON.stringify({ at: new Date().toISOString(), passed, total: results.length, results }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(OUT, "exit.txt"), String(process.exitCode ?? 0), "utf8");
}

main().catch((e: unknown) => {
  console.error("验证脚本崩溃：", e);
  results.push({ ok: false, label: "验证脚本自身异常", detail: String(e) });
  try {
    writeReport();
  } catch {
    /* 忽略 */
  }
  process.exitCode = 1;
});
