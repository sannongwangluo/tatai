// 补修包 D 验证脚本（PLAN.md「补修分包」表 D 行 + 其下 D 段；主责卡 V06-12，复用 V06-09 证据有效性规则）。
// 用法：pnpm verify:v06-12-d
//
// **本包要证的一句话**：`checks_passed` 不再是"有相关提交 + 证据在册"或"工作树干净"这两条直通分支，
// 而是六条口径全过才算（①说清声明范围 ②真实通过结果+覆盖+证据当前有效+无未收口阻断
// ③绑定当前实际内容版本（含未提交改动）④部分覆盖要显示已覆盖/未验证且不宣称整批通过
// ⑤自检/独立审计/用户接受分开记、检查通过不扩写成已验收 ⑥工作树干净只表示没有待保存改动）。
//
// 分四段：
//   ① **正例（真实链路）**：真 Git 夹具仓库 + 真起后端 + **真实 HTTP 写入面**（`POST /api/work/command`）
//      提交定义绑定 / 成果提交 / 自检记录 → **真实 HTTP 读口**（`GET /api/projects/:id/git-status`）
//      读出「已通过必要检查」，并逐条核对依据（声明范围 / 覆盖 / 版本绑定 / 记录区分 / 无阻断）。
//   ② **五条点名反例 + 两条补充反例**：失败日志仍在册 / 旧版证据遇到同路径新修改 / 部分文件有证据 /
//      证据失效 / 工作树干净但从未检查；另加"必需检查清单未知不空集判绿"与"未收口阻断"。
//   ③ **改前口径的对照**：同一批事实在旧判据下会判"通过"（相交 + 证据在册），现在**不判通过**。
//   ④ 收尾自证：塔台根文档（DESIGN.md / AGENTS.md 必须零改动）首尾 sha256 相同、夹具全在 tmpdir、
//      对真仓库**一个 git 写命令都没跑**。
//
// ██ 红线遵守 ██
//   · 所有 git **写**命令只出现在 `gitWrite()` 里，路径一律 `os.tmpdir()` 下自己建的目录，入口用
//     `assertUnderTmp()` 兜住；对 `D:/tatai` 与三个真实项目一个写命令都不跑。
//   · 隔离数据：临时 `TATAI_HOME` + 临时项目目录；收尾杀净子进程、整棵删除（`TATAI_KEEP_TMP=1` 保留现场）。
//   · 证据**正文**今天没有 HTTP 写口（V06-09 起如此），故正文走进程内 `putEvidence`（内容寻址、不可变）；
//     **成果提交与检查记录**才走真实 HTTP 写入面——与包 C 的已知边界同一口径，如实登记不冒充。
import crypto from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessBatchVerification,
  buildVersionReminder,
  contentVersionOf,
  inspectGitStatus,
  relatedOutcomes,
  type ReminderOutcomeFacts,
  type ReminderVerification,
} from "../src/server/gitStatus";
import { putEvidence } from "../src/server/work/evidence";
import { projectWorkDir } from "../src/server/workstation";
import type { CheckInput } from "../src/server/work/statusProjection";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
  }
};
const info = (msg: string): void => console.log(`[verify]   ${msg}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const sha256File = (f: string): string => sha256(fs.readFileSync(f));

// ── 塔台根文档零改动（首尾哈希；DESIGN.md / AGENTS.md 是硬红线） ──
const docBefore = new Map<string, string>();
for (const rel of DOC_FILES) {
  const abs = path.join(REPO, rel);
  docBefore.set(rel, fs.existsSync(abs) ? sha256File(abs) : "<missing>");
}

// ── 隔离环境与夹具 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0612d-verify-"));
const HOME = path.join(TMP, "home");
const PROJ = path.join(TMP, "dirty-project");
const CLEAN = path.join(TMP, "clean-project");
const PROJECT_ID = "v0612d-main";
const CHANGE_ID = "chg-v0612d";
const dirtyRel = "src/d.txt";
const dirtyAbs = path.join(PROJ, dirtyRel);
const mkdirp = (d: string): void => {
  fs.mkdirSync(d, { recursive: true });
};
const write = (f: string, text: string): void => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
const read = (f: string): string => fs.readFileSync(f, "utf8");
const workbench = (root: string): string => path.join(root, ".工作台");
const WORK = path.join(workbench(PROJ), "work");

function assertUnderTmp(p: string): void {
  if (!path.resolve(p).startsWith(path.resolve(TMP) + path.sep)) {
    throw new Error(`夹具路径必须在本脚本的临时目录下：${p}`);
  }
}

/** **夹具专用**：跑写类 git 命令（真仓库一次都不许走这里） */
function gitWrite(cwd: string, args: string[]): void {
  assertUnderTmp(cwd);
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

const GIT_ID = ["-c", "user.email=fixture@tatai.local", "-c", "user.name=fixture"];

/**
 * 夹具施工图：交付目标 + 完成证据列 + 正文里的验收检查项。
 * 任务定义里的必需检查 = `D-1::check:0`（正文 `- [ ]` 项）+ `D-1::evidence`（完成证据列）——
 * 与 `statusProjection.ts#requiredChecksFromDefinitions` 的口径同一出处，**不从"当前实现输出"反推期望**。
 */
const PLAN_TEXT = [
  "# 夹具施工图（补修包 D / V06-12）",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| D-1 | todo | 夹具卡：一批改动的检查通过判定 |  | D-1 的完成证据（自检输出） |",
  "",
  "### D-1 夹具卡：一批改动的检查通过判定",
  "",
  "**设计依据**：§1。**依赖**：无。",
  "",
  "**文件责任**：`src/d.txt`。",
  "",
  "- [ ] D-1 的验收检查项（夹具）",
  "",
  "**交付**：夹具交付物。",
  "",
].join("\n");
const DESIGN_TEXT = "# 夹具设计书（补修包 D）\n\n## 1 概述\n本夹具用于验证一批改动的检查通过判定。\n";

for (const d of [HOME, PROJ, CLEAN]) mkdirp(d);
write(path.join(workbench(PROJ), "design.md"), DESIGN_TEXT);
write(path.join(workbench(PROJ), "plan.md"), PLAN_TEXT);
write(
  path.join(workbench(PROJ), "tasks.json"),
  JSON.stringify(
    {
      version: 1,
      tasks: [{ id: "D-1", title: "夹具卡", module_id: "m1", status: "doing", reporter: "fixture", updated_at: "2026-09-20T09:00:00+08:00" }],
    },
    null,
    2,
  ) + "\n",
);
write(
  path.join(HOME, "registry.json"),
  JSON.stringify(
    {
      version: 1,
      projects: [
        { id: PROJECT_ID, name: "补修 D 主夹具", path: PROJ, kind: "backend", registered_at: "2026-09-20T00:00:00+08:00", last_opened_at: "2026-09-20T00:00:00+08:00" },
      ],
    },
    null,
    2,
  ) + "\n",
);

// ── 真 Git 夹具：脏仓库（一个未提交改动）+ 干净仓库（同一个提交后的状态） ──
function makeRepo(root: string, rel: string, base: string): void {
  mkdirp(root);
  gitWrite(root, ["init", "-q", "-b", "main", "."]);
  write(path.join(root, ".gitignore"), ".工作台/\n");
  write(path.join(root, rel), base);
  gitWrite(root, ["add", "--", ".gitignore", rel]);
  gitWrite(root, [...GIT_ID, "commit", "-qm", "初版"]);
}
makeRepo(PROJ, dirtyRel, "第一版\n");
// 未提交改动：同一路径、不同内容 —— 反例② 的现场
write(dirtyAbs, "第一版 + 本地未提交改动\n");
makeRepo(CLEAN, "src/c.txt", "干净仓库第一版\n");

/** 本次判定的"当前实际内容版本"（含未提交改动）：判定与产出方调**同一个**函数 */
const contentVersion = (): string => {
  const cv = contentVersionOf(PROJ, [dirtyRel]);
  if (cv.fingerprint === null) throw new Error(`夹具内容版本取不到：${cv.note}`);
  return cv.fingerprint;
};
const FP_DIRTY = contentVersion();

// ── 后端（真实 HTTP 写口 + 读口） ──
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

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });

const portListening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean): void => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });

let PORT = 0;
async function startServer(): Promise<ChildProcess> {
  PORT = await freePort();
  const proc = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: HOME, TATAI_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(proc);
  proc.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return proc;
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error(`后端 ${PORT} 20 秒内未就绪`);
}

async function stopServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
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
const postJson = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  api(p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

// ── 判定辅助 ──
const pathsOf = (v: ReminderVerification): string[] => v.declared.paths;
const state = (v: ReminderVerification): string => v.state;
const checkOf = (v: ReminderVerification, id: string) => v.checks.find((c) => c.check_id === id);

/** 一条**真实通过结果**（声明范围 + 绑定给定内容版本 + 证据哈希） */
function passingCheck(over: Partial<CheckInput> = {}): CheckInput {
  return {
    check_id: "D-1::check:0",
    object_id: "D-1",
    result: "passed",
    actor_id: "fixture-agent",
    role: "executor",
    independence: "author_self",
    binding: { revision_kind: "code", revision: FP_DIRTY },
    evidence_sha256: "a".repeat(64),
    at: "2026-09-20T10:05:00+08:00",
    method: "自检：夹具",
    scope: [dirtyRel],
    record_ref: "check:D-1-self-1",
    ...over,
  };
}

const submissionFact = {
  record_id: "sub-D-1",
  task_id: "D-1",
  changed_files: [dirtyRel],
  evidence_refs: ["a".repeat(64)],
  at: "2026-09-20T10:00:00+08:00",
  submitted_by: "fixture-agent",
};
const REQUIRED = { "D-1": [{ check_id: "D-1::check:0", label: "D-1 的验收检查项（夹具）" }] };
const EVIDENCE_OK = [{ evidence_id: "a".repeat(64), intact: true }];

/** 基线事实：成果提交 + 真实通过结果 + 证据在册 + 必需检查清单（正例的最小完备集） */
const factsPassed = (over: Partial<ReminderOutcomeFacts> = {}): ReminderOutcomeFacts => ({
  submissions: [submissionFact],
  evidence: EVIDENCE_OK,
  checks: [passingCheck()],
  required_checks_by_task: REQUIRED,
  blockers: [],
  ...over,
});

const assess = (dirty: string[], facts: ReminderOutcomeFacts): ReminderVerification =>
  assessBatchVerification(dirty, facts, { repository_root: PROJ, head: "HEAD-fixture" });

// ═════════════════════════════ 主流程 ═════════════════════════════

async function main(): Promise<void> {
  console.log("[verify] V06-12 补修包 D：checks_passed 的判定（声明范围 / 真实通过 / 当前内容版本 / 部分覆盖 / 记录区分）");
  console.log(`[verify]   node ${process.version} · ${process.platform} · repo ${REPO}`);
  console.log(`[verify]   夹具根 ${TMP}（隔离 TATAI_HOME：${HOME}）`);
  process.env.TATAI_HOME = HOME;
  ok(
    projectWorkDir(PROJECT_ID, HOME) === WORK,
    `① 夹具注册表可解析项目 work 目录（${path.relative(TMP, WORK)}；证据正文与后端读的是同一处）`,
  );

  // ═══════════ ① 正例：真实写入链路 → 真实读口 ═══════════
  info("① 正例：真起后端 + 真实写入面（定义绑定 / 成果提交 / 自检记录）→ 真实读口 GET git-status");
  const probeBefore = {
    head: execFileSync("git", ["--no-optional-locks", "rev-parse", "HEAD"], { cwd: PROJ, encoding: "utf8" }).trim(),
    index: sha256(fs.readFileSync(path.join(PROJ, ".git", "index"))),
  };
  const server = await startServer();
  const token = (JSON.parse(read(path.join(HOME, "work-service.json"))) as { token: string }).token;
  let idem = 0;
  const woCommand = async (input: {
    type: string;
    entity_id: string;
    payload: Record<string, unknown>;
    actor?: string;
    role?: string;
  }): Promise<{ status: number; body: any }> => {
    const res = await postJson(
      "/api/work/command",
      {
        schema_version: 2,
        project_id: PROJECT_ID,
        change_id: CHANGE_ID,
        entity_id: input.entity_id,
        expected_revision: null,
        type: input.type,
        actor_id: input.actor ?? "fixture-agent",
        role: input.role ?? "executor",
        idempotency_key: `${input.entity_id}:${input.type}:${++idem}:${CHANGE_ID}`,
        payload: input.payload,
      },
      { "x-tatai-work-token": token },
    );
    return { status: res.status, body: res.body };
  };

  // ①-1 定义绑定（任务台账/定义走真实入口）
  const planRes = await api(`/api/projects/${PROJECT_ID}/plan`);
  const defHash = planRes.body?.plan?.definition_hashes?.["D-1"];
  ok(planRes.status === 200 && typeof defHash === "string", `① 读施工图定义哈希（HTTP ${planRes.status}，D-1 定义 ${String(defHash).slice(0, 12)}…）`);
  const defRes = await woCommand({
    type: "task.definition_imported",
    entity_id: "task:D-1",
    payload: { definition_sha256: defHash, plan_revision: planRes.body.plan.content_sha256, definition_revision: 1 },
  });
  ok(defRes.status === 200, `① 定义绑定经真实写口提交（HTTP ${defRes.status}）`);

  // ①-2 证据正文（内容寻址；正文无 HTTP 写口，见文件头已知边界）+ 成果提交 + 自检记录
  const evi = putEvidence(WORK, {
    content: "夹具自检输出：D-1 验收检查项 exit 0\n",
    kind: "self_check",
    summary: "D-1 自检输出（夹具）",
    created_by: "fixture-agent",
    role: "executor",
    binding: { revision_kind: "code", revision: FP_DIRTY },
    source_ref: "verify-v06-12-d",
  });
  const subRes = await woCommand({
    type: "audit.submission_submitted",
    entity_id: "submission:sub-D-1",
    payload: {
      goal: "D-1：夹具成果",
      task_id: "D-1",
      round: 1,
      baseline: {},
      changed_files: [dirtyRel],
      commands: [{ command: "node --test d.test.mjs", exit_code: 0, output_ref: null }],
      untested: [],
      known_issues: [],
      evidence_refs: [evi.evidence_id],
      binding: { revision_kind: "code", revision: FP_DIRTY },
      submitted_by: "fixture-agent",
    },
  });
  ok(subRes.status === 200, `① 成果提交经真实写口提交（HTTP ${subRes.status}，证据 ${evi.evidence_id.slice(0, 12)}…）`);
  const selfRes = await woCommand({
    type: "audit.self_check_recorded",
    entity_id: "check:D-1-self-1",
    payload: {
      task_id: "D-1",
      round: 1,
      checked_by: "fixture-agent",
      checks: [
        { check_id: "D-1::check:0", method: "跑夹具检查命令", command: "node --test d.test.mjs", exit_code: 0, output_ref: null, evidence_sha256: evi.evidence_id, scope: [dirtyRel], verifies: "code" },
        { check_id: "D-1::evidence", method: "收齐完成证据", command: null, exit_code: null, output_ref: null, evidence_sha256: evi.evidence_id, scope: [dirtyRel], verifies: "code" },
      ],
      conclusion: "pass",
      binding: { revision_kind: "code", revision: FP_DIRTY },
    },
  });
  ok(selfRes.status === 200, `① 自检记录经真实写口提交（HTTP ${selfRes.status}）`);

  const gitRes = await api(`/api/projects/${PROJECT_ID}/git-status`);
  const reminder = gitRes.body?.reminder;
  const detail = reminder?.verification?.detail;
  ok(gitRes.status === 200 && reminder !== undefined, `① 真实读口 GET /api/projects/:id/git-status（HTTP ${gitRes.status}）`);
  ok(
    reminder?.verification?.state === "checks_passed",
    `① 正例判「已通过必要检查」（实际 ${reminder?.verification?.state}）`,
  );
  ok(
    JSON.stringify(pathsOf(detail)) === JSON.stringify([dirtyRel]) &&
      JSON.stringify(detail.declared.changed_paths) === JSON.stringify([dirtyRel]) &&
      JSON.stringify(detail.declared.outcome_paths) === JSON.stringify([dirtyRel]) &&
      JSON.stringify(detail.coverage.covered_paths) === JSON.stringify([dirtyRel]) &&
      detail.coverage.uncovered_paths.length === 0 &&
      detail.coverage.complete === true,
    `① 声明范围与覆盖都点名到路径：声明 ${JSON.stringify(pathsOf(detail))}、已覆盖 ${JSON.stringify(detail.coverage.covered_paths)}、未验证 ${detail.coverage.uncovered_paths.length} 条`,
  );
  ok(
    detail.declared.required_checks_source === "task_definitions" &&
      detail.declared.required_checks.map((c: { check_id: string }) => c.check_id).sort().join(",") === "D-1::check:0,D-1::evidence",
    `① 「哪些必需检查」来自任务定义：${detail.declared.required_checks.map((c: { check_id: string }) => c.check_id).join("、")}`,
  );
  ok(
    detail.version.basis === "content-v1" &&
      detail.version.by_scope.some((s: { fingerprint: string | null }) => s.fingerprint === FP_DIRTY) &&
      detail.checks.every((c: { current_content_version: string | null }) => c.current_content_version === FP_DIRTY) &&
      detail.checks.every((c: { bound_revision: { revision: string } | null }) => c.bound_revision?.revision === FP_DIRTY),
    `① 版本绑定：被测版本 = 当前实际内容版本 ${FP_DIRTY.slice(0, 12)}…（含未提交改动；按内容现算，不按 HEAD/文件名）`,
  );
  ok(
    detail.checks.length === 2 &&
      detail.checks.every((c: { effective: string }) => c.effective === "passed") &&
      detail.checks.every((c: { record_ref: string | null }) => (c.record_ref ?? "").startsWith("check:")),
    "① 每条依据可追溯到记录来源（record_ref）+ 复核结论 passed（哪条记录判的、凭什么）",
  );
  ok(
    detail.blockers.length === 0 && detail.missing_checks.length === 0,
    `① 无未收口阻断、无缺口（阻断 ${detail.blockers.length} / 缺口 ${detail.missing_checks.length}）`,
  );
  ok(
    detail.records.self_checks.length === 2 &&
      detail.records.independent_audits.length === 0 &&
      detail.records.user_acceptances.length === 0 &&
      detail.checks.every((c: { independence: string }) => c.independence === "author_self"),
    "① 记录区分：通过项全来自**作者自检**、没有独立审计、也没有用户接受（不冒充审计/验收）",
  );
  ok(
    reminder.verification.label.includes("已通过必要检查") &&
      reminder.verification.label.includes("检查通过 ≠ 已验收") &&
      !reminder.verification.label.includes("用户已接受"),
    "① 自检通过**不得**等同「已验收」：文案明写「检查通过 ≠ 已验收」且不出现用户已接受的断言",
  );
  ok(
    reminder.verification.label.includes("工作树仍有改动") &&
      reminder.local_commit.state === "unsaved" &&
      reminder.summary.includes("个文件有改动"),
    "① 通过口径与「本地未保存」两件事分开说：检查通过 + 工作树仍有改动仍未保存",
  );
  ok(
    (reminder.agent_note as string).includes("检查依据") &&
      (reminder.agent_note as string).includes("版本绑定") &&
      (reminder.agent_note as string).includes("未验证") &&
      (reminder.agent_note as string).includes("检查通过 ≠ 已验收"),
    "① 「复制给执行 Agent 的整理说明」带上判定依据（声明范围/覆盖/版本/逐条依据/记录区分）",
  );
  // 读口只读：探测前后夹具仓库的 HEAD 与 .git/index 字节逐项相同
  ok(
    probeBefore.head === execFileSync("git", ["--no-optional-locks", "rev-parse", "HEAD"], { cwd: PROJ, encoding: "utf8" }).trim() &&
      probeBefore.index === sha256(fs.readFileSync(path.join(PROJ, ".git", "index"))),
    "① 真实读口走完，夹具仓库 HEAD 与 .git/index 字节未变（判定不写任何东西）",
  );

  // ═══════════ ② 五条点名反例 + 两条补充反例 ═══════════
  info("② 反例（裁定点名五条 + 必需清单未知 / 未收口阻断）");

  // ②-1 失败日志仍在册
  const failedInRegister = assess([dirtyRel], factsPassed({ checks: [passingCheck(), passingCheck({ check_id: "D-1::check:1", result: "failed", evidence_sha256: "b".repeat(64), at: "2026-09-20T10:06:00+08:00" })] }));
  ok(
    state(failedInRegister) === "blocked" && failedInRegister.label.includes("失败检查记录仍在册"),
    `②-1 失败日志仍在册 → **不判通过**（实际 ${state(failedInRegister)}：${failedInRegister.label.slice(0, 40)}…）`,
  );
  // ②-1b 对照：**同一条检查**在失败之后（更晚的记录）绑定当前内容版本又通过 → 不再拦（不是"一票永久否决"）
  const retested = assess([dirtyRel], factsPassed({
    checks: [
      passingCheck({ result: "failed", at: "2026-09-20T10:06:00+08:00" }),
      passingCheck({ at: "2026-09-20T10:30:00+08:00" }),
    ],
  }));
  ok(
    state(retested) === "checks_passed" && retested.label.includes("已被同范围的当前通过记录取代"),
    `②-1b 同一条检查失败后复测通过（更晚 + 绑定当前内容版本）→ ${state(retested)}，且文案说明旧失败已被取代`,
  );
  // ②-1c 反面对照：**别的检查**在同一批路径上通过，不能取代这条失败
  const otherCheckPassed = assess([dirtyRel], factsPassed({
    checks: [
      passingCheck({ check_id: "D-1::check:0", at: "2026-09-20T10:30:00+08:00" }),
      passingCheck({ check_id: "别的检查", result: "failed", at: "2026-09-20T10:06:00+08:00" }),
    ],
  }));
  ok(state(otherCheckPassed) === "blocked", `②-1c 别的检查通过不能取代这条失败记录（实际 ${state(otherCheckPassed)}）`);

  // ②-2 旧版证据遇到同路径新修改（同路径、不同内容）
  const staleInput = factsPassed({ checks: [passingCheck({ binding: { revision_kind: "code", revision: sha256("这是上一版内容的指纹") } })] });
  const stale = assess([dirtyRel], staleInput);
  ok(
    state(stale) !== "checks_passed" &&
      checkOf(stale, "D-1::check:0")?.effective === "stale" &&
      (checkOf(stale, "D-1::check:0")?.why ?? "").includes("源变了"),
    `②-2 旧版证据遇到同路径新修改 → 版本不匹配（复核 ${checkOf(stale, "D-1::check:0")?.effective}），不判通过`,
  );
  // 同一条记录：把文件内容再改一次（同路径）→ 判定立刻撤销（真实盘上验证，不只是构造字符串）
  write(dirtyAbs, "第一版 + 本地未提交改动 + 又改了一次\n");
  const afterSecondEdit = assess([dirtyRel], factsPassed());
  ok(
    state(afterSecondEdit) !== "checks_passed" &&
      checkOf(afterSecondEdit, "D-1::check:0")?.effective === "stale" &&
      checkOf(afterSecondEdit, "D-1::check:0")?.current_content_version !== FP_DIRTY,
    `②-2b 真盘上同路径再改一次：内容版本 ${(checkOf(afterSecondEdit, "D-1::check:0")?.current_content_version ?? "").slice(0, 12)}… ≠ 证据绑定 ${FP_DIRTY.slice(0, 12)}… → 撤销通过`,
  );
  write(dirtyAbs, "第一版 + 本地未提交改动\n"); // 还原现场（内容回到与证据绑定一致）
  ok(contentVersion() === FP_DIRTY, "②-2c 还原内容后内容版本回到与证据绑定同一枚（判据是内容，不是时间戳/HEAD）");

  // ②-3 部分文件有证据（现场还改了一个**成果没声明**的路径 → 同样进"未验证范围"）
  const secondRel = "src/e.txt";
  write(path.join(PROJ, secondRel), "第二个改动文件\n");
  const partial = assess([dirtyRel, secondRel], {
    submissions: [submissionFact], // 成果只声明了 dirtyRel
    evidence: EVIDENCE_OK,
    checks: [passingCheck()], // 检查也只覆盖 dirtyRel
    required_checks_by_task: REQUIRED,
  });
  ok(
    state(partial) === "partially_covered" &&
      JSON.stringify(partial.declared.changed_paths) === JSON.stringify([dirtyRel, secondRel]) &&
      JSON.stringify(partial.declared.outcome_paths) === JSON.stringify([dirtyRel]) &&
      JSON.stringify(partial.coverage.covered_paths) === JSON.stringify([dirtyRel]) &&
      JSON.stringify(partial.coverage.uncovered_paths) === JSON.stringify([secondRel]) &&
      partial.label.includes("不宣称整批通过"),
    `②-3 部分文件有证据 → ${state(partial)}：已覆盖 ${JSON.stringify(partial.coverage.covered_paths)}、未验证 ${JSON.stringify(partial.coverage.uncovered_paths)}（含成果没声明的现场改动）`,
  );
  fs.rmSync(path.join(PROJ, secondRel));

  // ②-4 证据失效（不在册 / 损坏）
  const eviGone = assess([dirtyRel], factsPassed({ evidence: [] }));
  const eviCorrupt = assess([dirtyRel], factsPassed({ evidence: [{ evidence_id: "a".repeat(64), intact: false }] }));
  ok(
    state(eviGone) !== "checks_passed" &&
      (checkOf(eviGone, "D-1::check:0")?.why ?? "").includes("不在册或已损坏") &&
      state(eviCorrupt) !== "checks_passed",
    `②-4 证据失效（不在册 / 损坏）→ 撤销通过（实际 ${state(eviGone)} / ${state(eviCorrupt)}）`,
  );

  // ②-5 工作树干净但从未检查（真起探测：干净仓库 + 没有任何检查记录）
  const cleanProbe = await inspectGitStatus(CLEAN);
  const cleanNeverChecked = buildVersionReminder(cleanProbe, { submissions: [], evidence: [] }, { project_name: "夹具·干净未检查" });
  ok(
    cleanNeverChecked.summary.includes("工作树干净") &&
      cleanNeverChecked.local_commit.state === "saved" &&
      cleanNeverChecked.verification.state === "unverified" &&
      cleanNeverChecked.verification.label.includes("没有待保存改动"),
    `②-5 工作树干净但从未检查 → 显示**未验证**（实际 ${cleanNeverChecked.verification.state}），只在本地保存一面说"干净"：${cleanNeverChecked.verification.label.slice(0, 46)}…`,
  );
  // 干净仓库上"最近一次成果提交但没有检查记录"也照样未验证（不因为工作树干净就判通过）
  const cleanWithOutcome = buildVersionReminder(
    cleanProbe,
    { submissions: [submissionFact], evidence: EVIDENCE_OK, checks: [], required_checks_by_task: REQUIRED },
    { project_name: "夹具·干净有成果无检查" },
  );
  ok(
    cleanWithOutcome.verification.state !== "checks_passed" &&
      cleanWithOutcome.verification.detail?.declared.batch === "latest_outcomes",
    `②-5b 干净树上对「最近一次成果提交」判定也**不**因干净而通过（实际 ${cleanWithOutcome.verification.state}，批次 ${cleanWithOutcome.verification.detail?.declared.batch}）`,
  );

  // ②-6 补充：必需检查清单未知 → 不空集判绿
  const noReq = assess([dirtyRel], factsPassed({ required_checks_by_task: undefined }));
  ok(
    state(noReq) !== "checks_passed" &&
      noReq.declared.required_checks_source === "unknown" &&
      noReq.label.includes("必需检查清单未知"),
    `②-6 必需检查清单未知 → 不空集判绿（实际 ${state(noReq)}）`,
  );
  // 任务定义里没有这个任务（清单不全）同样不判通过
  const noDef = assess([dirtyRel], factsPassed({ required_checks_by_task: { "别的卡": [] } }));
  ok(state(noDef) !== "checks_passed" && noDef.declared.required_checks_note.includes("没有任务定义"), `②-6b 任务没定义 → ${state(noDef)}（${noDef.declared.required_checks_note}）`);

  // ②-7 补充：未收口阻断（必须拦截的缺陷）→ 不能算通过
  const blocked = assess([dirtyRel], factsPassed({ blockers: [{ blocker_id: "f-abc123", kind: "finding", severity: "data_loss", must_block: true, status: "confirmed", object_id: "D-1", note: "夹具：数据被覆盖" }] }));
  ok(
    state(blocked) === "blocked" &&
      blocked.blockers.some((b) => b.blocker_id === "f-abc123") &&
      blocked.label.includes("未收口阻断"),
    `②-7 有未收口阻断 → ${state(blocked)}（${blocked.blockers.map((b) => b.blocker_id).join("、")}）`,
  );
  // 阻断被真正收口（closed）后不再拦：同样的场景判回通过
  const blockerClosed = assess([dirtyRel], factsPassed({ blockers: [{ blocker_id: "f-abc123", kind: "finding", must_block: true, status: "closed" }] }));
  ok(state(blockerClosed) === "checks_passed", `②-7b 阻断收口（closed）后不再拦：判定回到 ${state(blockerClosed)}（不是"一票永久否决"）`);
  // 缺陷声明了与这批改动无关的范围 → 不算影响该结论
  const blockerElsewhere = assess([dirtyRel], factsPassed({ blockers: [{ blocker_id: "f-其他", kind: "finding", must_block: true, status: "confirmed", paths: ["src/完全不相干.txt"] }] }));
  ok(state(blockerElsewhere) === "checks_passed", `②-7c 明确声明无关范围的缺陷不拦（${state(blockerElsewhere)}）；**未声明范围**的按影响处理（fail-closed）`);

  // ②-8 用户接受分两半：属于这批成果的记进来，别人的验收记录不许给这批背书
  const accBatch = assess([dirtyRel], factsPassed({
    acceptances: [
      { record_id: "ua-D-1", task_id: "D-1", decision: "accept", at: "2026-09-20T11:00:00+08:00" },
      { record_id: "ua-别的卡", task_id: "别的卡", decision: "accept", at: "2026-09-20T11:00:00+08:00" },
    ],
  }));
  ok(
    accBatch.records.user_acceptances.join(",") === "ua-D-1" && state(accBatch) === "checks_passed",
    `②-8 用户接受单独记且**只记本批的**（${accBatch.records.user_acceptances.join("、") || "无"}）——别人的验收不给这批背书，也不因有验收记录改变检查口径（${state(accBatch)}）`,
  );

  // ═══════════ ③ 改前口径对照：旧判据的输入现在不再判"通过" ═══════════
  info("③ 改前 → 改后对照（同一批事实，旧判据会判通过）");
  const oldPremise = relatedOutcomes(
    [dirtyRel],
    { submissions: [submissionFact], evidence: EVIDENCE_OK }, // 旧判据的全部输入：相交 + 证据在册
    { repository_root: PROJ, head: "HEAD-fixture" },
  );
  ok(
    oldPremise.submission_ids.length === 1 &&
      oldPremise.evidence_ids.length === 1 &&
      oldPremise.verification.state === "unverified",
    `③ 「改动路径与 changed_files 相交 + 证据在册」现在只判 ${oldPremise.verification.state}（关联成果仍在，但**不**等于检查通过）`,
  );
  ok(
    oldPremise.verification.label.includes("不是稳定成果"),
    "③ 未验证口径保留原话「不是稳定成果」（不把未验证改动说成稳定成果）",
  );

  await stopServer(server);

  // ═══════════ ④ 收尾自证 ═══════════
  info("④ 收尾自证（根文档零改动 / 夹具隔离 / 真仓库零写命令）");
  let docChanged = 0;
  for (const rel of DOC_FILES) {
    const abs = path.join(REPO, rel);
    const now = fs.existsSync(abs) ? sha256File(abs) : "<missing>";
    if (now !== docBefore.get(rel)) {
      docChanged++;
      console.log(`[verify]   FAIL 根文档被改动：${rel}`);
    }
  }
  ok(docChanged === 0, `④ 根文档 ${DOC_FILES.length} 份首尾哈希逐项相同（DESIGN.md / AGENTS.md 零改动）`);
  const selfSrc = read(fileURLToPath(import.meta.url));
  const realMarkers = ["5.0 类脑" + "记忆", "大黄" + "蜂", "货架" + "参谋", "D:/Git" + "hub"];
  ok(
    realMarkers.every((m) => !selfSrc.includes(m)),
    `④ 本脚本源码不含任何真实项目路径（命中 ${realMarkers.filter((m) => selfSrc.includes(m)).join("、") || "无"}）——夹具全程只在 os.tmpdir()`,
  );
  ok(
    fs.existsSync(TMP) && path.resolve(PROJ).startsWith(path.resolve(TMP) + path.sep) && path.resolve(CLEAN).startsWith(path.resolve(TMP) + path.sep),
    "④ 本脚本造的全部现场都在自己的临时目录下（收尾整棵删除）",
  );
  ok(
    !fs.existsSync(path.join(REPO, ".git", "index.lock")) && fs.existsSync(path.join(REPO, "package.json")),
    "④ 塔台本体没有被动过（没有遗留索引锁；本脚本只对其读文档与判据源码）",
  );

  console.log(`\n[verify] V06-12-D 结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
}

try {
  await main();
} catch (e) {
  console.error(`[verify] 异常：${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
} finally {
  for (const proc of spawned) {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch {
      // 已经没了
    }
  }
  if (process.env.TATAI_KEEP_TMP === "1") info(`保留现场：${TMP}`);
  else fs.rmSync(TMP, { recursive: true, force: true });
}
