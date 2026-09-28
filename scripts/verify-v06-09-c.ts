// 补修包 C 验证脚本（PLAN.md「补修分包」表 C 行 + 其下 C 段；主责卡 V06-09，联验 V06-06）。
// 用法：pnpm verify:v06-09-c（或 node --import tsx scripts/verify-v06-09-c.ts）
//
// **本包要证的一句话**：父级"必需子项通过 **＋ 自身集成检查通过**"这条门槛保留不变，
// 但它的正式链路是持久的、可追溯的、外部声明改不动的——
//   ① 需要哪些集成检查 = 施工图里的**版本化验收定义**（绑定对象稳定 ID，随图纸修订进不可变修订、
//      随**有效基线**生效）；
//   ② 检查结果 = **既有审计/证据事件**（`audit.self_check_recorded` / `audit.independent_audit_recorded`），
//      不另造存储；
//   ③ 读取路径从**权威事实装配**：HTTP `GET /api/projects/:id/status-projection` 现算，
//      GET 参数与前端声明产生不了绿灯。
//
// 隔离环境：临时 TATAI_HOME + 一个夹具项目（`os.tmpdir()` 下），**不碰**任何真实项目与 `D:\.tatai`；
// 塔台根文档（DESIGN.md / PLAN.md / PROGRESS.md / AGENTS.md / README.md / 两份设计史）**只读**
// （首尾逐文件 sha256 对照，证明零改动）；收尾清理自建临时目录与起过的子进程（TATAI_KEEP_TMP=1 保留现场）。
//
// 检查项与场景对应：
//   ① 真实入口登记（POST /documents/activate）→ 提交检查证据（POST /api/work/command，唯一写入服务面）
//      → 读取父级状态（GET /status-projection）；绿灯依据可追溯到记录 / 定义版本 / 证据哈希。
//   ② 服务重启后结果一致（真起后端、杀进程、再起、读同一状态）。
//   ③ 缺自身集成证据不绿（声明了但没交检查记录 → 父级不绿，且缺口点名的正是那条检查）。
//   ④ 证据过期撤销当前通过：④-a 被测版本前进（code 修订变化）→ 旧绿转待验证；
//      ④-b 图纸改一行 → 当前声明不再被有效基线批准 + 旧证据随 plan 修订过期。
//   ⑤ 两个端点绿不能代替集成线通过（集成线要自己的检查记录；补交后才绿）。
//   反例：伪造 GET 参数 / 向前端声明式地"注入"集成检查要求 → 一个字节都改不动结果。
//
// 已知边界（如实登记，不冒充）：证据**正文**今天没有 HTTP 写口（V06-09 未提供），
// 故正文走进程内 `putEvidence`（内容寻址 + 不可变），**检查记录事件**才走真实 HTTP 写入面。

import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  checksFromAudit,
  collectProjectFacts,
  objectsFromFacts,
  projectStatuses,
  type StatusObjectInput,
} from "../src/server/work/statusProjection";
import { putEvidence, type RevisionKind } from "../src/server/work/evidence";
import { readServiceDescriptor } from "../src/server/work/service";
import { projectWorkDir } from "../src/server/workstation";

const REPO = process.cwd();
const PORT = 8829;
const MAIN = "v0609c-main";
const CHG = "chg-v0609c";
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

let serverChild: ChildProcess | null = null;
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
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0609c-verify-"));
const dataDir = path.join(tmpBase, "home");
const mainRoot = path.join(tmpBase, "main");
const mkdirp = (d: string) => fs.mkdirSync(d, { recursive: true });
const write = (f: string, text: string) => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
const read = (f: string) => fs.readFileSync(f, "utf8");
const workbench = (root: string) => path.join(root, ".工作台");
for (const d of [dataDir, mainRoot]) mkdirp(d);
const MAIN_WORK = path.join(workbench(mainRoot), "work");

/**
 * 夹具施工图：施工卡表（V06-02 口径）+ 卡正文 + **集成检查要求表（补修 C 的版本化验收定义）**。
 * 集成检查要求小节标题含「集成检查要求」；表见 `parseIntegrationRequirements`。
 */
const PLAN_HEAD = [
  "# 夹具施工图（补修包 C / V06-09）",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| C-1 | todo | 数据层 |  | 数据层验收记录 |",
  "| C-2 | todo | 接口层 | C-1 | 接口层验收记录 |",
  "| C-3 | todo | 展示层 |  | 展示层验收记录 |",
  "",
  "### C-1 数据层",
  "",
  "**设计依据**：§1。**依赖**：无。",
  "",
  "**契约**：输入原始数据，输出规范化数据。",
  "",
  "**文件责任**：新增 `src/data.ts`。",
  "",
  "**交付**：数据层验收记录。",
  "",
  "### C-2 接口层",
  "",
  "**设计依据**：§1。**依赖**：C-1。",
  "",
  "**契约**：输入规范化数据，输出接口响应。",
  "",
  "**文件责任**：新增 `src/api.ts`。",
  "",
  "**交付**：接口层验收记录。",
  "",
  "### C-3 展示层",
  "",
  "**设计依据**：§1。**依赖**：无。",
  "",
  "**契约**：输入接口响应，输出页面。",
  "",
  "**文件责任**：新增 `src/ui.ts`。",
  "",
  "**交付**：展示层验收记录。",
  "",
  "### 集成检查要求（对象 → 必需集成检查）",
  "",
  "| 对象 ID | 检查 ID | 说明 | 必需性 |",
  "| --- | --- | --- | --- |",
  "| module:data | module:data::integration | 数据层内部读写链路打通 | 必需 |",
  "| module:api | module:api::integration | 接口层内部链路打通 | 必需 |",
  "| module:api | module:api::integration::legacy | 旧接口兼容（本期不阻塞） | 可选 |",
  "| module:ui | module:ui::integration | 展示层内部链路打通 | 必需 |",
  "",
].join("\n");
let planText = PLAN_HEAD;
const DESIGN_TEXT = "# 夹具设计书（补修包 C）\n\n## 1 概述\n本夹具用于验证父级集成检查的正式持久化链路。\n";
write(path.join(workbench(mainRoot), "design.md"), DESIGN_TEXT);
write(path.join(workbench(mainRoot), "plan.md"), planText);
write(path.join(mainRoot, "src", "data.ts"), "export const DATA = 'data-v1';\n");
write(path.join(mainRoot, "src", "ui.ts"), "export const UI = 'ui-v1';\n");
// v1 台账：模块归属的唯一现实来源（父级 = module:<module_id>）
write(
  path.join(workbench(mainRoot), "tasks.json"),
  JSON.stringify(
    {
      version: 1,
      tasks: [
        { id: "C-1", title: "数据层", module_id: "data", status: "todo", reporter: "kimi-code", updated_at: "2026-09-20T00:00:00+08:00" },
        { id: "C-2", title: "接口层", module_id: "api", status: "todo", reporter: "kimi-code", updated_at: "2026-09-20T00:00:00+08:00" },
        { id: "C-3", title: "展示层", module_id: "ui", status: "todo", reporter: "kimi-code", updated_at: "2026-09-20T00:00:00+08:00" },
      ],
    },
    null,
    2,
  ),
);
write(
  path.join(dataDir, "registry.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        {
          id: MAIN,
          name: "补修 C 主夹具",
          path: mainRoot,
          kind: "backend",
          registered_at: "2026-09-20T00:00:00+08:00",
          last_opened_at: "2026-09-20T00:00:00+08:00",
        },
      ],
    },
    null,
    2,
  ),
);
process.env.TATAI_HOME = dataDir;
ok(projectWorkDir(MAIN, dataDir) === MAIN_WORK, `夹具注册表可解析项目 work 目录（${path.basename(MAIN_WORK)}）`);

const planRev1 = sha256(planText);
const designRev = sha256(DESIGN_TEXT);
const codeRev1 = sha256("code-v1");
const codeRev2 = sha256("code-v2");
/** 集成检查结果的被测版本（code 维度）——④-a 用它证明"被测版本前进 → 旧绿转待验证" */
const CODE_KIND: RevisionKind = "code";

const putEv = (kind: Parameters<typeof putEvidence>[1]["kind"], summary: string, content: string, revision: { kind: RevisionKind; value: string }) =>
  putEvidence(MAIN_WORK, {
    content,
    kind,
    summary,
    created_by: "kimi-code",
    role: "executor",
    binding: { revision_kind: revision.kind, revision: revision.value },
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

// 补修包 E：激活会顺带在后台跑语义整理链（缺省打模型网关）。本脚本验的是"登记 → 提交证据 → 投影"，
// 不验自动链 → 注 `TATAI_SEMANTIC_AUTO=0`（docs/work-v2-contract.md §18.5）关掉后台模型调用。
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
  throw new Error(`后端 ${PORT} 20 秒内未就绪`);
}

async function stopChild(proc: ChildProcess | null): Promise<void> {
  if (proc === null || proc.exitCode !== null) return;
  proc.kill("SIGKILL");
  for (let i = 0; i < 40; i++) {
    if (proc.exitCode !== null) break;
    await sleep(100);
  }
  for (let i = 0; i < 40; i++) {
    if (!(await portListening(PORT))) return;
    await sleep(100);
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

// ── 唯一写入服务面（真实 HTTP 写口：POST /api/work/command + 描述符令牌）──

let workToken = "";
let idemSeq = 0;
const submitCommand = async (input: {
  type: string;
  entity_id: string;
  expected_revision: number | null;
  payload: Record<string, unknown>;
  occurred_at?: string;
  actor?: string;
  role?: string;
}) => {
  const res = await api("/api/work/command", {
    method: "POST",
    headers: { "content-type": "application/json", "x-tatai-work-token": workToken },
    body: JSON.stringify({
      schema_version: 2,
      project_id: MAIN,
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
  return res;
};

const projectionOf = async (query = "") => (await api(`/api/projects/${MAIN}/status-projection${query}`)).body?.projection;
const objectOf = (proj: any, objectId: string) => (proj?.objects ?? []).find((o: any) => o.object_id === objectId);
const codesOf = (o: any): string[] => (o?.reasons ?? []).map((r: any) => r.code);

async function main(): Promise<void> {
  write(path.join(mainRoot, "src", "api.ts"), "export const API = 'api-v1';\n");

  // ══════════════════════════ 1 真实入口：起后端 → 登记 → 提交证据 → 读父级状态 ══════════════════════════
  info("── ① 真实入口登记 → 提交检查证据 → 读取父级状态（全程真 HTTP）");
  if (await portListening(PORT)) throw new Error(`端口 ${PORT} 被占用，无法起隔离后端`);
  serverChild = spawnServer();
  await waitUp();
  const desc = readServiceDescriptor(dataDir);
  ok(desc !== null && desc.port === PORT, `1-0 唯一写入服务描述符可发现（host=${desc?.host} port=${desc?.port}）`);
  workToken = desc?.token ?? "";

  // 任务定义导入（模块归属要有任务状态才进对象表）——此时**还没有**有效基线
  for (const id of ["C-1", "C-2", "C-3"]) {
    const r = await submitCommand({
      type: "task.definition_imported",
      entity_id: `task:${id}`,
      expected_revision: null,
      payload: { definition_sha256: sha256(`${id}-def`), plan_revision: planRev1, definition_revision: 1 },
    });
    if (r.status !== 200) throw new Error(`task.definition_imported ${id} 失败：${r.status} ${r.text}`);
    const r2 = await submitCommand({
      type: "task.result_submitted",
      entity_id: `task:${id}`,
      expected_revision: 1,
      payload: {},
    });
    if (r2.status !== 200) throw new Error(`task.result_submitted ${id} 失败：${r2.status} ${r2.text}`);
  }

  // 0 前置：声明读到了，但没有有效基线 → 不据此判绿
  const projNoBaseline = await projectionOf();
  const mDataPre = objectOf(projNoBaseline, "module:data");
  const whyPre = (mDataPre?.missing ?? []).find((m: any) => m.check_id === "module:data::integration")?.why ?? "";
  ok(
    projNoBaseline?.integration_requirements?.declared === true &&
      projNoBaseline?.integration_requirements?.plan_revision === planRev1 &&
      projNoBaseline?.integration_requirements?.in_force === false &&
      String(projNoBaseline?.integration_requirements?.not_in_force_reason ?? "").includes("还没有生效基线"),
    `0-1 施工图已声明集成检查要求（${Object.keys(projNoBaseline?.integration_requirements?.by_object ?? {}).join("、")}），但未获有效基线批准 → in_force=false`,
  );
  ok(
    mDataPre !== undefined && mDataPre.display_status !== "verified" && whyPre.includes("生效基线"),
    `0-2 未获批准的声明不据此判绿：module:data=${mDataPre?.display_status}，缺口原话「${whyPre}」`,
  );

  // ①-a 登记：激活成套图纸基线（真实 HTTP 写入口）
  const activate = await postJson(`/api/projects/${MAIN}/documents/activate`, {
    approved_by: "gpt-6",
    approval_basis: "用户已委派的设计职责：审定这套图纸（含集成检查要求）",
    approval_kind: "delegated_technical_review",
    expected: { design_content_sha256: designRev, plan_content_sha256: planRev1 },
  });
  ok(
    activate.status === 200 && activate.body?.ok === true && activate.body?.baseline?.baseline_id !== undefined,
    `1-1 POST /documents/activate：有效基线生效（HTTP ${activate.status}，baseline=${activate.body?.baseline?.baseline_id}）`,
  );
  const projRegistered = await projectionOf();
  const mDataRegistered = objectOf(projRegistered, "module:data");
  const whyReg = (mDataRegistered?.missing ?? []).find((m: any) => m.check_id === "module:data::integration")?.why ?? "";
  ok(
    projRegistered?.integration_requirements?.in_force === true &&
      projRegistered?.integration_requirements?.plan_revision === planRev1 &&
      projRegistered?.baseline?.plan_revision === planRev1,
    `1-2 基线生效后声明即可用：in_force=${projRegistered?.integration_requirements?.in_force}、plan 修订=${short(projRegistered?.integration_requirements?.plan_revision)}（与生效基线一致）`,
  );
  ok(
    mDataRegistered?.required_count === 2 && whyReg.includes("没有任何检查记录"),
    `1-3 生效后父级的必需项里就有那条集成检查（module:data required=${mDataRegistered?.required_count}，缺口原话「${whyReg}」）`,
  );

  // ①-b 提交检查证据（先落证据正文：内容寻址 + 不可变；再交检查记录事件）
  const evChild1 = putEv("self_check", "C-1 数据层验收记录", "$ pnpm test data\nOK 数据层\n", { kind: "plan", value: planRev1 });
  const evChild2 = putEv("self_check", "C-2 接口层验收记录", "$ pnpm test api\nOK 接口层\n", { kind: "plan", value: planRev1 });
  const evChild3 = putEv("self_check", "C-3 展示层验收记录", "$ pnpm test ui\nOK 展示层\n", { kind: "plan", value: planRev1 });
  const evIntData = putEv("self_check", "module:data 集成检查输出", "$ pnpm test integ:data\nOK 数据层内部读写链路\n", { kind: CODE_KIND, value: codeRev1 });
  const evIntUi = putEv("self_check", "module:ui 集成检查输出", "$ pnpm test integ:ui\nOK 展示层内部链路\n", { kind: "plan", value: planRev1 });

  // 结果提交：把"当前被测代码版本"定到 codeRev1（集成检查绑的正是它）
  const sub1 = await submitCommand({
    type: "audit.submission_submitted",
    entity_id: "submission:c-round1",
    expected_revision: null,
    occurred_at: "2026-09-20T01:00:00+08:00",
    payload: {
      goal: "补修 C 夹具：数据层/接口层/展示层交付",
      task_id: "C-1",
      changed_files: ["src/data.ts", "src/api.ts", "src/ui.ts"],
      commands: [{ command: "pnpm test", exit_code: 0, output_ref: null }],
      binding: { revision_kind: CODE_KIND, revision: codeRev1 },
      submitted_by: "kimi-code",
    },
  });
  ok(sub1.status === 200 && sub1.body?.ok === true, `1-4 结果提交经真实写口提交（HTTP ${sub1.status}，seq=${sub1.body?.seq}）`);

  const selfCheck = async (recordId: string, taskId: string, checkId: string, evidenceSha: string, revision: { kind: RevisionKind; value: string }, scope: string[], occurredAt: string, subject: "document" | "code" = "code") =>
    submitCommand({
      type: "audit.self_check_recorded",
      entity_id: `check:${recordId}`,
      expected_revision: null,
      occurred_at: occurredAt,
      payload: {
        task_id: taskId,
        checked_by: "kimi-code",
        checks: [
          {
            check_id: checkId,
            method: `跑集成/验收检查 ${checkId}`,
            command: "pnpm test",
            exit_code: 0,
            output_ref: null,
            evidence_sha256: evidenceSha,
            scope,
            verifies: subject,
          },
        ],
        conclusion: "pass",
        binding: { revision_kind: revision.kind, revision: revision.value },
      },
    });

  const evts = [
    await selfCheck("c-c1", "C-1", "C-1::evidence", evChild1.sha256, { kind: "plan", value: planRev1 }, ["数据层读写"], "2026-09-20T01:10:00+08:00", "document"),
    await selfCheck("c-c2", "C-2", "C-2::evidence", evChild2.sha256, { kind: "plan", value: planRev1 }, ["接口层请求/响应"], "2026-09-20T01:11:00+08:00", "document"),
    await selfCheck("c-c3", "C-3", "C-3::evidence", evChild3.sha256, { kind: "plan", value: planRev1 }, ["展示层渲染"], "2026-09-20T01:12:00+08:00", "document"),
    await selfCheck("c-int-data", "module:data", "module:data::integration", evIntData.sha256, { kind: CODE_KIND, value: codeRev1 }, ["数据层→存储 端到端", "边界：空输入"], "2026-09-20T01:20:00+08:00"),
    await selfCheck("c-int-ui", "module:ui", "module:ui::integration", evIntUi.sha256, { kind: "plan", value: planRev1 }, ["展示层→接口 端到端"], "2026-09-20T01:21:00+08:00", "document"),
  ];
  ok(
    evts.every((e) => e.status === 200 && e.body?.ok === true),
    `1-5 五条检查记录经 POST /api/work/command（唯一写入服务面）提交成功（seq=${evts.map((e) => e.body?.seq).join("/")}）`,
  );
  // module:api 的集成检查**故意不提交**（③ 缺证据不绿）

  const proj1 = await projectionOf();
  const mData = objectOf(proj1, "module:data");
  const mApi = objectOf(proj1, "module:api");
  const mUi = objectOf(proj1, "module:ui");
  ok(
    proj1?.integration_requirements?.in_force === true &&
      proj1?.integration_requirements?.plan_revision === planRev1 &&
      proj1?.baseline?.plan_revision === planRev1,
    `1-6 读取入口带出集成检查要求的来源：in_force=${proj1?.integration_requirements?.in_force}、plan 修订=${short(proj1?.integration_requirements?.plan_revision)}（与生效基线一致）`,
  );
  ok(
    mData?.display_status === "verified" && mData.required_count === 2 && mData.passed_count === 2,
    `1-7 父级全绿 = 必需子项 + 自身集成检查（module:data=${mData?.display_status}，required=${mData?.required_count}，passed=${mData?.passed_count}）`,
  );
  ok(
    mUi?.display_status === "verified" && mUi.required_count === 2,
    `1-8 同一份图纸里的另一个父级也全绿（module:ui=${mUi?.display_status}，required=${mUi?.required_count}）`,
  );
  // ③ 缺自身集成证据不绿
  ok(
    mApi?.display_status !== "verified" &&
      mApi.passed_count === 1 &&
      mApi.missing.some((m: any) => m.check_id === "module:api::integration"),
    `③ 声明了集成检查但没交记录 → 不绿（module:api=${mApi?.display_status}，缺 ${mApi?.missing.map((m: any) => m.check_id).join("、")}）`,
  );
  ok(
    !(mApi?.missing ?? []).some((m: any) => m.check_id === "module:api::integration::legacy") &&
      mApi.required_count === 2,
    `③ 「可选」的集成检查不阻塞（module:api required=${mApi?.required_count}，可选项未计入）`,
  );
  // ①-c 绿灯依据可追溯：哪条记录 / 哪版定义 / 哪个证据哈希
  const basisData = (mData?.evidence_basis ?? []).find((b: any) => b.check_id === "module:data::integration");
  ok(
    basisData?.record_ref === "check:c-int-data" &&
      basisData?.bound_revision?.revision === codeRev1 &&
      basisData?.evidence_sha256 === evIntData.sha256 &&
      basisData?.effective === "passed" &&
      basisData?.scope?.includes("数据层→存储 端到端"),
    `1-9 绿灯依据可追溯（记录=${basisData?.record_ref}、被测版本=${short(basisData?.bound_revision?.revision)}、证据=${short(basisData?.evidence_sha256)}、范围=${(basisData?.scope ?? []).length} 条）`,
  );
  ok(
    (mData?.reasons ?? []).some((r: any) => r.code === "integration_requirements_definition"),
    "1-10 投影里如实标注集成检查要求来自版本化验收定义（plan 修订 + 随有效基线生效）",
  );

  // 反例：外部声明产生不了绿灯
  info("── 反例：伪造 GET 参数 / 前端声明不得产生绿");
  const forged = await projectionOf(
    `?integration_checks=1&module_integration_checks[api][0][check_id]=module:api::integration` +
      `&module_integration_checks[api][0][label]=伪造&display_status=verified&force_green=1`,
  );
  const mApiForged = objectOf(forged, "module:api");
  ok(
    JSON.stringify(forged) === JSON.stringify(proj1),
    "反例-1 带伪造查询参数的响应与不带参数**逐字节相同**（本路由不读任何 query：参数不是事实源）",
  );
  ok(
    mApiForged?.display_status !== "verified" &&
      mApiForged?.missing.some((m: any) => m.check_id === "module:api::integration"),
    `反例-2 伪造参数后 module:api 仍不绿（${mApiForged?.display_status}）——外部声明产生不了绿灯`,
  );
  const postClaim = await postJson(`/api/projects/${MAIN}/status-projection`, {
    integration_checks: [{ check_id: "module:api::integration", object_id: "module:api" }],
    display_status: "verified",
  });
  ok(
    !(postClaim.body?.ok === true && postClaim.body?.projection !== undefined),
    `反例-3 想用 POST body "注入"集成检查要求也拿不到绿灯投影（HTTP ${postClaim.status}）`,
  );

  // ══════════════════════════ ⑤ 两个端点绿不能代替集成线通过 ══════════════════════════
  info("── ⑤ 集成线要自己的检查记录（两个端点绿不自动证明连线绿）");
  const edgeId = "module:data->module:ui::integration";
  const edgeCheckId = `${edgeId}::c0`;
  const withEdge = (facts: ReturnType<typeof collectProjectFacts>) => {
    const edge: StatusObjectInput = {
      object_id: edgeId,
      object_kind: "edge",
      label: "数据层 → 展示层 集成线",
      edge: { edge_kind: "integration", from: "module:data", to: "module:ui" },
      required_checks: [{ check_id: edgeCheckId, label: "跨模块端到端数据链路证据" }],
      revisions: facts.revisions,
    };
    return projectStatuses({
      objects: objectsFromFacts(MAIN, dataDir, facts, { extra_edges: [edge] }),
      findings: facts.findings,
      checks: checksFromAudit(facts.audit),
      source_revision: facts.revisions,
    });
  };
  const factsA = collectProjectFacts(MAIN, dataDir);
  const setA = withEdge(factsA);
  ok(
    setA.by_id["module:data"]?.display_status === "verified" &&
      setA.by_id["module:ui"]?.display_status === "verified" &&
      setA.by_id[edgeId]?.display_status !== "verified",
    `5-1 两端绿（${setA.by_id["module:data"]?.display_status} / ${setA.by_id["module:ui"]?.display_status}）不自动证明连线绿（集成线=${setA.by_id[edgeId]?.display_status}）`,
  );
  ok(
    setA.by_id[edgeId]?.missing.some((m) => m.check_id === edgeCheckId),
    `5-2 集成线缺口点名到它自己那条检查：${setA.by_id[edgeId]?.missing.map((m) => m.check_id).join("、")}`,
  );
  const evEdge = putEv("self_check", "跨模块端到端链路检查输出", "$ pnpm test e2e:data-ui\nOK 数据层→展示层\n", { kind: "plan", value: planRev1 });
  const edgeEvent = await selfCheck("c-int-edge", edgeId, edgeCheckId, evEdge.sha256, { kind: "plan", value: planRev1 }, ["数据层→展示层 端到端"], "2026-09-20T01:30:00+08:00", "document");
  const factsB = collectProjectFacts(MAIN, dataDir);
  const setB = withEdge(factsB);
  ok(
    edgeEvent.status === 200 &&
      setB.by_id[edgeId]?.display_status === "verified" &&
      setB.by_id[edgeId]?.evidence_basis?.[0]?.record_ref === "check:c-int-edge" &&
      setB.by_id[edgeId]?.evidence_basis?.[0]?.evidence_sha256 === evEdge.sha256,
    `5-3 交上集成线自己的证据后才绿（集成线=${setB.by_id[edgeId]?.display_status}，依据记录=${setB.by_id[edgeId]?.evidence_basis?.[0]?.record_ref}）`,
  );

  // ══════════════════════════ ② 服务重启后结果一致 ══════════════════════════
  info("── ② 服务重启后结果一致（真起后端、杀进程、再起、读同一状态）");
  const beforeRestart = await projectionOf();
  const eventsBefore = sha256(read(path.join(MAIN_WORK, "events.jsonl")));
  const baselinesBefore = sha256(read(path.join(workbench(mainRoot), "baselines.jsonl")));
  await stopChild(serverChild);
  ok(!(await portListening(PORT)), "2-1 后端进程已停止（端口已释放）");
  serverChild = spawnServer();
  await waitUp();
  workToken = readServiceDescriptor(dataDir)?.token ?? "";
  const afterRestart = await projectionOf();
  ok(
    JSON.stringify(afterRestart) === JSON.stringify(beforeRestart),
    `2-2 重启后读同一状态逐字节一致（对象 ${afterRestart?.objects?.length} 个、last_seq=${afterRestart?.last_seq}）`,
  );
  ok(
    objectOf(afterRestart, "module:data")?.display_status === "verified" &&
      objectOf(afterRestart, "module:ui")?.display_status === "verified" &&
      objectOf(afterRestart, "module:api")?.display_status !== "verified",
    "2-3 重启后绿灯/不绿的分界没变（module:data/ui 绿、module:api 不绿）",
  );
  ok(
    sha256(read(path.join(MAIN_WORK, "events.jsonl"))) === eventsBefore &&
      sha256(read(path.join(workbench(mainRoot), "baselines.jsonl"))) === baselinesBefore,
    "2-4 读入口跑完：事件文件与基线流水一个字节都没变（只读入口不写事实）",
  );

  // ══════════════════════════ ④-a 证据过期：被测版本前进 ══════════════════════════
  info("── ④-a 证据过期撤销当前通过（被测版本前进：code 修订变化）");
  const sub2 = await submitCommand({
    type: "audit.submission_submitted",
    entity_id: "submission:c-round2",
    expected_revision: null,
    occurred_at: "2026-09-20T03:00:00+08:00",
    payload: {
      goal: "补修 C 夹具：第二轮交付（新代码版本）",
      task_id: "C-1",
      changed_files: ["src/data.ts"],
      commands: [{ command: "pnpm test", exit_code: 0, output_ref: null }],
      binding: { revision_kind: CODE_KIND, revision: codeRev2 },
      submitted_by: "kimi-code",
    },
  });
  const projStale = await projectionOf();
  const mDataStale = objectOf(projStale, "module:data");
  const mUiAfterCode = objectOf(projStale, "module:ui");
  ok(sub2.status === 200, `4-a-0 第二轮结果提交成功（seq=${sub2.body?.seq}），当前被测代码版本推进到 ${short(codeRev2)}`);
  ok(
    mDataStale?.display_status !== "verified" &&
      mDataStale?.quality === "evidence_invalid" &&
      mDataStale?.freshness === "verification_stale" &&
      codesOf(mDataStale).includes("evidence_stale"),
    `4-a-1 旧绿被撤销：module:data=${mDataStale?.display_status}（quality=${mDataStale?.quality}、freshness=${mDataStale?.freshness}）`,
  );
  const basisStale = (mDataStale?.evidence_basis ?? []).find((b: any) => b.check_id === "module:data::integration");
  ok(
    basisStale?.effective === "stale" &&
      basisStale?.bound_revision?.revision === codeRev1 &&
      basisStale?.current_revision === codeRev2 &&
      (mDataStale?.history ?? []).some((h: any) => h.check_id === "module:data::integration" && h.bound_revision === codeRev1),
    `4-a-2 旧结论保留在历史里（依据：绑 ${short(basisStale?.bound_revision?.revision)} → 当前 ${short(basisStale?.current_revision)}，history ${mDataStale?.history?.length} 条）`,
  );
  ok(
    mUiAfterCode?.display_status === "verified",
    `4-a-3 对照：绑 plan 修订的 module:ui 不受这次 code 版本变化影响（${mUiAfterCode?.display_status}）`,
  );

  // ══════════════════════════ ④-b 图纸改一行 → 声明不再被有效基线批准 + 旧证据过期 ══════════════════════════
  info("── ④-b 图纸改一行：当前声明不再被有效基线批准，旧证据随 plan 修订过期");
  planText = `${planText}**施工备注**：补修 C 验证——图纸改一行即换一版，旧证据随之过期。\n`;
  write(path.join(workbench(mainRoot), "plan.md"), planText);
  const planRev2 = sha256(planText);
  const projReplan = await projectionOf();
  const mUiReplan = objectOf(projReplan, "module:ui");
  ok(
    planRev2 !== planRev1 && projReplan?.revisions?.plan === planRev2,
    `4-b-1 施工图换了一版（plan 修订 ${short(planRev1)} → ${short(planRev2)}）`,
  );
  ok(
    projReplan?.integration_requirements?.in_force === false &&
      (projReplan?.integration_requirements?.not_in_force_reason ?? "").includes("生效基线"),
    `4-b-2 当前声明未被有效基线批准 → in_force=${projReplan?.integration_requirements?.in_force}，原话「${
      projReplan?.integration_requirements?.not_in_force_reason ?? ""
    }」`,
  );
  ok(
    mUiReplan?.display_status !== "verified" &&
      mUiReplan?.missing.some((m: any) => m.check_id === "module:ui::integration") &&
      mUiReplan?.missing.some((m: any) => m.check_id === "C-3::evidence" && String(m.why).includes("源变了")),
    `4-b-3 改图纸撤销了通过：module:ui=${mUiReplan?.display_status}，缺 ${mUiReplan?.missing.map((m: any) => m.check_id).join("、")}`,
  );
}

main()
  .catch((e) => {
    console.error(`[verify] 异常：${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
    ok(false, `验证中断：${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(async () => {
    await stopChild(serverChild);
    serverChild = null;

    info("── 塔台根文档零改动核对（首尾逐文件 sha256；DESIGN.md / AGENTS.md 必须零改动）");
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
    console.log(`\n[verify] 补修 C（v06-09-c）结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
  });
