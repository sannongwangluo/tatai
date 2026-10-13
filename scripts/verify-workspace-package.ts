// 交付候选**构建包身份**绑定与试用提升实测（PLAN V09-63/V09-65；DESIGN.md §6.13 第 5 段、§6.14 第 3/8 段）。
//
// 覆盖的产品契约（impl-final-readout §5 登记的最后一个已确认缺口：`package_ok = docsOk`）：
//   ① 冻结候选**绑定既有构建输入身份**（复用 §6.10，不另算）：`release_id`／组件输入指纹／工具链；
//      冻结阶段**只判构建输入**，不要求产物已存在 ⇒「先冻结后构建」成立。
//   ② 试用提升由**宿主自行实测真实产物**（内嵌身份 + 构建戳 + 冻结构建输出清单 + 发布完整性 + 引用闭包），
//      与冻结记录逐项相符才放行；**不接受调用方自报 measured/自报通过**。
//   ③ 适用性明确：根含 §6.10 构建链 ⇒ 自动识别为包交付并绑定（**不能靠省略请求字段降成非包**）；
//      无链的普通项目 ⇒ 合理 `not_applicable`；**声明包却没有受支持身份** ⇒ `unsupported`／未知。
//   ④ schema 兼容：旧记录缺 `build_identity` ⇒ 已知包项目按**未知**处理，**不默认真**。
//   ⑤ 非 Git／CRLF 环境的**冻结 PLAN 快照读回**（impl-final-readout 遗留负例：缺陷 2 的专门回归）。
//
// 夹具诚实边界：本脚本在**隔离临时目录**里用既有构建链（`scripts/lib/*`）与 §6.10 输入集**实际算出**
// 构建身份、并用真实 `writeBuildStamp` 落构建戳——**明确不冒充真实 Tatai 整机包**（没有真正的 vite/tauri
// 构建，`tatai.exe`/NSIS/MSI 是占位字节）。整机包冻结/构建由 root 在真实开发树执行，本脚本不安装、不启停生产。
//
// 自带隔离环境（临时 TATAI_HOME + os.tmpdir 夹具 + 临时端口）；结束按 PID 子树收尾。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { WorkService } from "../src/server/work/service";
import { loadEvents } from "../src/server/work/eventStore";
import { readTaskStates, submitDefinitionImports } from "../src/server/work/tasks";
import { importPlanChecked } from "../src/server/work/references";
import { activateBaseline, buildSectionIndex } from "../src/server/work/documents";
import { registerRequirement } from "../src/server/work/requirements";
import {
  readWorkspaces,
  registerWorkspace,
  freezeWorkspace,
  pointTrialWorkspace,
} from "../src/server/work/workspaces";
import { installWorkspaceHostWiring } from "../src/server/work/hostWiring";
import { submitSelfCheck, submitIndependentAudit, COVERAGE_AREAS, COVERAGE_AREA_LABELS } from "../src/server/work/audit";
import { handleReportingRequest } from "../src/server/work/reportingHost";
import { projectWorkDir } from "../src/server/workstation";
import { isWorkError } from "../src/server/work/types";
import { readFeatureLedger } from "../src/server/work/featureLedger";
import {
  candidateAppVersion,
  deriveWorkspaceBuildBinding,
  detectBuildChain,
  verifyPackageAtPromotion,
} from "../src/server/work/workspaceBuildBinding";
import type { WorkspaceBuildBinding } from "../src/shared/workspaceTypes";
import { buildDefineValue, deriveIdentity } from "./lib/buildIdentity";
import { writeBuildStamp } from "./lib/buildStamp";
import { outputManifestFingerprint } from "./lib/buildOutputManifest";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[pkg] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[pkg]   现场：${JSON.stringify(detail).slice(0, 1600)}`);
  }
};
const section = (t: string): void => console.log(`\n[pkg] ═══ ${t}`);

function guardCode(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (isWorkError(e)) return typeof e.detail?.reason === "string" ? (e.detail.reason as string) : e.code;
    return `NON_WORK_ERROR:${(e as Error).message}`;
  }
}

// ── 临时环境与夹具 ──
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-pkg-"));
const dataDir = path.join(tmpBase, "home");
const PID = "ws-pkg";
const projRoot = path.join(tmpBase, "proj");
const pkgRoot = path.join(tmpBase, "pkg-cand");
const pkgEmptyRoot = path.join(tmpBase, "pkg-empty");
const pkgLegacyRoot = path.join(tmpBase, "pkg-legacy");
const plainRoot = path.join(tmpBase, "plain-cand");
const plainRoot2 = path.join(tmpBase, "plain-cand2");
const CRLF_PID = "ws-pkg-crlf";
const crlfRoot = path.join(tmpBase, "proj-crlf");
const crlfCand = path.join(tmpBase, "cand-crlf");
const children: ChildProcess[] = [];

const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};
const copy = (rel: string, toRoot: string): void => {
  const from = path.join(REPO, rel);
  const to = path.join(toRoot, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

const DESIGN = "# 交付候选包身份夹具设计书\n\n## 2 模块划分\n\n| # | 模块 | 说明 |\n| --- | --- | --- |\n| 1 | 甲模块 | 夹具 |\n";
const PLAN = [
  "# 交付候选包身份夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| F-1 | todo | 包身份夹具卡 |  | F-1 验收记录 |",
  "",
  "### F-1 包身份夹具卡",
  "",
  "**设计依据**：§2。**契约**：输入甲，输出甲。",
  "",
  "**文件责任**：`src/server/app.ts`。",
  "",
  "- [ ] 甲做出来",
  "",
  "**交付**：F-1 验收记录。",
  "",
  "**完成证据**：F-1 验收记录。",
  "",
].join("\n");

/** §6.10 构建链的最小子集（真字节从开发树复制；算法仍只由 `scripts/lib/*` 提供，夹具不复制判据） */
const CHAIN_SOURCES = [
  "src/shared/version.ts",
  "src/shared/stableJson.ts",
  "src/shared/buildIdentity.ts",
  "scripts/lib/buildIdentity.ts",
  "scripts/lib/buildStamp.ts",
  "scripts/lib/sourceFingerprint.ts",
  "scripts/lib/buildOutputManifest.ts",
  "scripts/lib/packageVerdict.ts",
];

function makePackageRoot(root: string, version: string): void {
  write(path.join(root, "package.json"), JSON.stringify({ name: "fixture-pkg", version, private: true }, null, 2) + "\n");
  write(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }, null, 2) + "\n");
  write(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  write(path.join(root, "vite.config.ts"), "export default { build: { target: 'baseline-widely-available' } };\n");
  write(path.join(root, "index.html"), "<!doctype html><html><body></body></html>\n");
  write(path.join(root, "src-tauri", "tauri.conf.json"), JSON.stringify({ productName: "fixture", version }, null, 2) + "\n");
  write(path.join(root, "src", "server", "app.ts"), "export const app = 'v1';\n");
  write(path.join(root, "src", "mcp", "mcp.ts"), "export const mcp = 1;\n");
  write(path.join(root, "src", "arch", "graph.ts"), "export const graph = 1;\n");
  write(path.join(root, "src", "ui", "arch", "projectGraph.ts"), "export const pg = 1;\n");
  write(path.join(root, "src", "ui", "arch", "provenance.ts"), "export const pv = 1;\n");
  write(path.join(root, "src", "ui", "arch", "statusColor.ts"), "export const sc = 1;\n");
  write(path.join(root, "public", "tatai-mark.svg"), "<svg></svg>\n");
  write(path.join(root, "scripts", "build-server.ts"), "export const bs = 1;\n");
  for (const rel of CHAIN_SOURCES) copy(rel, root);
  write(path.join(root, "README.md"), "# fixture package candidate\n");
  // 与真实塔台工程**同源**：构建产物（dist/、src-tauri/target/、src-tauri/resources/）不进候选索引
  // ——候选索引走 Git 口径（tracked ∪ 非 ignored untracked），所以夹具也按真实工程建 Git 仓库 + .gitignore。
  write(path.join(root, ".gitignore"), ["dist/", "src-tauri/target/", "src-tauri/resources/", ""].join("\n"));
  gitInitCommit(root);
}

function gitInitCommit(root: string): void {
  const run = (args: string[]): void => {
    execFileSync("git", ["-C", root, ...args], { stdio: ["ignore", "ignore", "ignore"], timeout: 30_000 });
  };
  run(["init"]);
  run(["add", "-A"]);
  run(["-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "commit", "-m", "fixture base"]);
}

function clearArtifacts(root: string): void {
  for (const rel of ["dist", path.join("src-tauri", "target"), path.join("src-tauri", "resources")]) {
    fs.rmSync(path.join(root, rel), { recursive: true, force: true });
  }
}

function mustPackage(root: string): WorkspaceBuildBinding {
  const d = deriveWorkspaceBuildBinding(root);
  if (!d.ok) throw new Error(`夹具：deriveWorkspaceBuildBinding 失败：${d.message}`);
  if (d.binding.delivery_kind !== "package") throw new Error("夹具：期望 package 身份");
  return d.binding;
}

/** 用**既有构建链**算出这批产物的内嵌身份（`overrides` 可造"另一版"的包用于冒充反例） */
function defineFor(root: string, overrides: { serverFp?: string; uiFp?: string; builtAt?: string } = {}): string {
  const b = mustPackage(root);
  const builtAt = overrides.builtAt ?? "2026-10-09T00:00:00.000Z";
  const derivation = deriveIdentity(root, {
    appVersion: candidateAppVersion(root),
    inputs: {
      server_input_fingerprint: overrides.serverFp ?? b.server_input_fingerprint!,
      ui_input_fingerprint: overrides.uiFp ?? b.ui_input_fingerprint!,
      toolchain: b.toolchain!,
    },
    builtAt: { server: builtAt, ui: builtAt },
  });
  return buildDefineValue(derivation.identities);
}

/** 在夹具根里"实际小构建"：写产物 + 用既有 `writeBuildStamp` 落戳（不冒充真实 Tatai 整机包） */
function buildPackage(root: string, opts: { spoofDefine?: string } = {}): void {
  const b = mustPackage(root);
  const define = opts.spoofDefine ?? defineFor(root);
  const ver = candidateAppVersion(root);
  write(path.join(root, "dist", "index.html"), `<!doctype html><html><head><script type="module" src="./assets/index.js"></script></head><body>fixture</body></html>\n`);
  write(path.join(root, "dist", "assets", "index.js"), `export const __TATAI_BUILD_IDENTITY__ = ${define};\n`);
  for (const n of ["index.js", "mcp.js", "write-service.js", "read-worker.js"]) {
    write(path.join(root, "src-tauri", "resources", "server", n), n === "index.js" ? `export const __TATAI_BUILD_IDENTITY__ = ${define};\n` : `// ${n}\n`);
  }
  const rel = path.join(root, "src-tauri", "target", "release");
  write(path.join(rel, "tatai.exe"), "MZ-fixture-shell\n".repeat(64));
  write(path.join(rel, "bundle", "nsis", `Tatai_${ver}_x64-setup.exe`), "fixture-nsis\n");
  write(path.join(rel, "bundle", "msi", `Tatai_${ver}_x64_en-US.msi`), "fixture-msi\n");
  // 戳必须最后写：戳指纹＝此刻整树（产物已在位）
  const outFp = outputManifestFingerprint(root, undefined, candidateAppVersion(root));
  writeBuildStamp(root, {
    release_id: b.release_id!,
    build_id: b.build_id!,
    server_input_fingerprint: b.server_input_fingerprint!,
    ui_input_fingerprint: b.ui_input_fingerprint!,
    server_input_file_count: b.server_input_file_count ?? 0,
    ui_input_file_count: b.ui_input_file_count ?? 0,
    server_input_manifest_sha256: b.server_input_manifest_sha256 ?? "",
    ui_input_manifest_sha256: b.ui_input_manifest_sha256 ?? "",
    toolchain: b.toolchain!,
    output_manifest_sha256: outFp.sha256,
    output_file_count: outFp.file_count,
  });
}

// ── HTTP 处理器直调夹具（存源清单证据） ──
function mockReq(url: string, body: unknown): IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as unknown as IncomingMessage;
  (req as unknown as { method: string }).method = "POST";
  (req as unknown as { url: string }).url = url;
  (req as unknown as { headers: Record<string, string> }).headers = {};
  return req;
}
function mockRes(): { res: ServerResponse; read: () => { status: number; body: unknown } } {
  const st = { status: 0, body: "" };
  const res = {
    setHeader: (): void => {},
    writeHead: (s: number): unknown => {
      st.status = s;
      return res;
    },
    end: (v?: unknown): void => {
      if (typeof v === "string") st.body = v;
    },
  };
  Object.defineProperty(res, "statusCode", {
    get: () => st.status,
    set: (s: number) => {
      st.status = s;
    },
  });
  return { res: res as unknown as ServerResponse, read: () => ({ status: st.status, body: st.body === "" ? null : JSON.parse(st.body) }) };
}

function killTree(pid: number): void {
  try {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {
    /* 已经不在了 */
  }
}
function cleanup(): void {
  for (const c of children) if (c.pid !== undefined) killTree(c.pid);
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* 回收失败不影响判分 */
  }
}
process.on("exit", cleanup);

async function main(): Promise<void> {
  // ── 夹具：项目（含非 Git CRLF 项目）+ 三个包候选根 + 两个普通候选根 ──
  const CRLF_PLAN = PLAN.replace(/\n/g, "\r\n");
  // 非 Git CRLF 项目的 DESIGN 必须带**功能清单声明区**（八列）与可定位章节，否则交付读数在派生前就 422
  const DECL_HEAD = [
    "| 功能 ID | 人话功能名 | 需求 ID | 设计章节 | 本期范围（scope_id） | 覆盖结论 | 依据/缺口（review） | 使用结果与场景 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const crlfDesignDraft = [
    "# 非 Git CRLF 夹具设计书",
    "",
    "### 3.5 目标章节",
    "",
    "正文。",
    "",
    "#### 功能清单声明（夹具）",
    "",
    DECL_HEAD[0],
    DECL_HEAD[1],
    "| cap-crlf | 非 Git CRLF 夹具 | req-crlf | §3.5 | cap-crlf | 待审 | reviewer=; ref=DESIGN.md#3.5; section_sha256=SECT; gap=x | 场景 |",
    "",
  ].join("\n");
  const crlfSectSha = buildSectionIndex(crlfDesignDraft).find((s) => s.title.startsWith("3.5 "))?.sha256 ?? "";
  const CRLF_DESIGN = crlfDesignDraft.replace("section_sha256=SECT", `section_sha256=${crlfSectSha}`).replace(/\n/g, "\r\n");
  fs.mkdirSync(dataDir, { recursive: true });
  write(path.join(projRoot, ".工作台", "design.md"), DESIGN);
  write(path.join(projRoot, ".工作台", "plan.md"), PLAN);
  write(path.join(crlfRoot, ".工作台", "design.md"), CRLF_DESIGN);
  write(path.join(crlfRoot, ".工作台", "plan.md"), CRLF_PLAN);
  makePackageRoot(pkgRoot, "9.9.9");
  makePackageRoot(pkgEmptyRoot, "9.9.9");
  makePackageRoot(pkgLegacyRoot, "9.9.9");
  write(path.join(plainRoot, "a.txt"), "plain-candidate-v1\n");
  write(path.join(plainRoot, "README.md"), "# plain\n");
  write(path.join(plainRoot2, "b.txt"), "plain-candidate-2-v1\n");
  write(path.join(plainRoot2, "README.md"), "# plain 2\n");
  write(path.join(crlfCand, "src", "c.txt"), "export const c = 3;\n");
  write(path.join(crlfCand, "README.md"), "# crlf candidate\n");
  write(
    path.join(dataDir, "registry.json"),
    JSON.stringify({
      version: 1,
      projects: [
        { id: PID, name: "包身份夹具", path: projRoot, kind: "backend", registered_at: "2026-10-09T00:00:00+08:00", last_opened_at: "2026-10-09T00:00:00+08:00" },
        { id: CRLF_PID, name: "非 Git CRLF 夹具", path: crlfRoot, kind: "backend", registered_at: "2026-10-09T00:00:00+08:00", last_opened_at: "2026-10-09T00:00:00+08:00" },
      ],
    }),
  );
  process.env.TATAI_HOME = dataDir;
  installWorkspaceHostWiring();
  const service = new WorkService({ dataDir });
  const workDir = projectWorkDir(PID, dataDir);
  const crlfWorkDir = projectWorkDir(CRLF_PID, dataDir);
  const submitter = { submit: (c: unknown) => service.submit(c), read: () => readWorkspaces(workDir) };
  const CHANGE = "change-pkg";
  const COORD = "pkg-coordinator";
  const EXEC = "pkg-executor";
  const AUDITOR = "pkg-auditor";

  {
    const imported = importPlanChecked(PLAN, workDir, { plan_revision: crypto.createHash("sha256").update(PLAN, "utf8").digest("hex") });
    submitDefinitionImports(service, { project_id: PID, change_id: CHANGE, actor_id: "pkg-setup", role: "coordinator", definitions: imported.definitions });
    activateBaseline(PID, { approved_by: "user", approval_basis: "包身份隔离夹具审定（不代表真实用户 Gate）", approval_kind: "user_confirmed" }, dataDir);
    ok(readTaskStates(workDir).states["F-1"] !== undefined, "⓪ 夹具就绪（定义导入 + 基线激活）");
    ok(detectBuildChain(pkgRoot) && !detectBuildChain(plainRoot), "⓪ 构建链识别：包候选根含 §6.10 构建链、普通候选根不含（宿主实测）");
  }

  async function seedEvidence(wsId: string, manifestPaths: string[]): Promise<void> {
    const { res, read } = mockRes();
    await handleReportingRequest(
      mockReq("/api/work/reporting/evidence", {
        project_id: PID,
        workspace_id: wsId,
        content: "",
        kind: "source_manifest",
        summary: `${wsId} 候选源清单`,
        created_by: EXEC,
        role: "executor",
        binding: { revision_kind: "code", revision: "rev-pkg" },
        source_manifest: manifestPaths.map((p) => ({ path: p })),
      }),
      res,
      { pathname: "/api/work/reporting/evidence", dataDir },
    );
    const body = read().body as { ok?: boolean; evidence?: { evidence_id?: string; source_manifest?: { fingerprint?: string } } };
    const evid = body.evidence?.evidence_id ?? "";
    const fp = body.evidence?.source_manifest?.fingerprint ?? "";
    if (body.ok !== true || evid === "" || fp === "") throw new Error(`夹具：${wsId} 存源清单证据失败：${JSON.stringify(body).slice(0, 400)}`);
    const sc = submitSelfCheck(submitter as never, {
      project_id: PID, change_id: CHANGE, actor_id: EXEC, role: "executor", record_id: `sc-${wsId}`,
      task_id: "F-1", checked_by: EXEC, conclusion: "pass",
      binding: { revision_kind: "code", revision: fp },
      checks: [
        { check_id: "F-1::check:0", method: "夹具", command: null, exit_code: null, evidence_sha256: evid, scope: [], verifies: "code" },
        { check_id: "F-1::evidence", method: "交付物证据（夹具）", command: null, exit_code: null, evidence_sha256: evid, scope: [], verifies: "code" },
      ],
    });
    const ia = submitIndependentAudit(submitter as never, {
      project_id: PID, change_id: CHANGE, actor_id: AUDITOR, role: "auditor", record_id: `ia-${wsId}`,
      task_id: "F-1", auditor: AUDITOR, author_id: EXEC, conclusion: "pass",
      binding: { revision_kind: "code", revision: fp },
      checks: [{ check_id: "F-1::check:0", result: "passed", evidence_sha256: evid, scope: [] }],
      coverage: COVERAGE_AREAS.map((a) => ({ area: a, status: "checked" as const, basis: `${COVERAGE_AREA_LABELS[a]}：夹具` })),
    });
    if (sc.ok !== true || ia.ok !== true) throw new Error(`夹具：${wsId} 自检/独审落账失败`);
  }

  async function registerAndFreeze(wsId: string, root: string, opts: { declaredPackage?: boolean } = {}): Promise<{ code: string | null; binding: WorkspaceBuildBinding | null }> {
    const reg = registerWorkspace(submitter, {
      project_id: PID, workspace_id: wsId, change_id: CHANGE, actor_id: COORD, role: "coordinator",
      kind: "candidate", purpose: `${wsId} 候选`, root, source_kind: "directory", task_ids: ["F-1"],
    });
    if (reg.ok !== true) return { code: reg.code, binding: null };
    const rec = readWorkspaces(workDir).workspaces[wsId];
    const fr = freezeWorkspace(submitter, {
      project_id: PID, workspace_id: wsId, change_id: CHANGE, actor_id: COORD, role: "coordinator",
      expected_revision: rec.revision, included_uncommitted: false, declared_paths: [],
      ...(opts.declaredPackage === true ? { declared_package: true } : {}),
    });
    if (fr.ok !== true) return { code: fr.code, binding: null };
    const after = readWorkspaces(workDir).workspaces[wsId];
    return { code: null, binding: after.freeze?.version_binding.build_identity ?? null };
  }

  // ═══ ① 先冻结后构建：冻结只判构建输入，不要求产物存在 ═══
  section("① 先冻结后构建（冻结阶段只定构建输入，不要求先有包）");
  {
    const before = await registerAndFreeze("pkg-cand", pkgRoot);
    ok(before.code === null, `① 包候选冻结成功（尚无任何构建产物）(${before.code ?? "ok"})`);
    ok(fs.existsSync(path.join(pkgRoot, "dist")) === false, "① 冻结时确无 dist/ 产物（证明不要求先有包）", { hasDist: fs.existsSync(path.join(pkgRoot, "dist")) });
    const b = before.binding;
    ok(b !== null && b.delivery_kind === "package", `① 冻结记录绑定**构建包身份**（delivery_kind=package）`, b);
    ok(
      b !== null && b.release_id !== null && b.server_input_fingerprint !== null && b.ui_input_fingerprint !== null && b.toolchain !== null,
      `① release_id／组件输入指纹／工具链都在场（release ${b?.release_id?.slice(0, 12) ?? "?"}…）`,
    );
    const direct = deriveWorkspaceBuildBinding(pkgRoot);
    ok(
      direct.ok === true && b !== null && direct.binding.release_id === b.release_id && direct.binding.server_input_fingerprint === b.server_input_fingerprint,
      "① 宿主现算身份与冻结记录一致（同一份 §6.10 算法，无第二套判据）",
    );
  }

  // ═══ ② 同版构建输出 → 试用提升（真实产物实测） ═══
  section("② 同版构建输出 → 试用提升（宿主实测真实产物）");
  {
    buildPackage(pkgRoot);
    await seedEvidence("pkg-cand", ["src/server/app.ts", "README.md"]);
    const ptrRev = readWorkspaces(workDir).pointer?.revision ?? 0;
    const pt = pointTrialWorkspace(submitter, {
      project_id: PID, workspace_id: "pkg-cand", change_id: CHANGE, actor_id: COORD, role: "coordinator",
      expected_revision: ptrRev, basis: "夹具：提升已冻结并同版构建的包候选",
    });
    ok(pt.ok === true, `② point_trial 通过（宿主实测产物身份与冻结记录逐项相符）(${pt.ok ? "ok" : `${pt.code}: ${pt.message}`})`);
    ok(readWorkspaces(workDir).pointer?.current_trial_workspace_id === "pkg-cand", "② 当前试用候选指针＝pkg-cand");
  }

  const pointerStays = (label: string): void => {
    ok(readWorkspaces(workDir).pointer?.current_trial_workspace_id === "pkg-cand", `${label}：失败保留旧指针（仍 pkg-cand）`);
  };

  function tryPoint(wsId: string, changeId: string): { ok: boolean; code?: string; message?: string } {
    const ptrRev = readWorkspaces(workDir).pointer?.revision ?? 0;
    const r = pointTrialWorkspace(submitter, {
      project_id: PID, workspace_id: wsId, change_id: changeId, actor_id: COORD, role: "coordinator",
      expected_revision: ptrRev, basis: "夹具：反例",
    });
    return r.ok === true ? { ok: true } : { ok: false, code: r.code, message: r.message };
  }

  // ═══ ③ 产物/分片篡改、缺包、A 版包冒充 B 版 ═══
  section("③ 反例：缺包 / 产物篡改 / 分片缺失 / A 版包冒充 B 版");
  {
    // ③-1 缺包：新候选冻结后**不构建**
    const miss = await registerAndFreeze("pkg-empty", pkgEmptyRoot);
    ok(miss.code === null && miss.binding?.delivery_kind === "package", "③-1 空包候选冻结 OK（只绑输入）");
    const r1 = tryPoint("pkg-empty", `${CHANGE}-a`);
    ok(r1.ok === false && r1.code === "PROMOTION_UNVERIFIED", `③-1 缺包提升拒 PROMOTION_UNVERIFIED（${r1.code}）`, r1);
    ok((r1.message ?? "").includes("缺构建戳") || (r1.message ?? "").includes("未采到内嵌构建身份"), `③-1 失败点名"缺戳/未采到内嵌身份"（不空拒）`, r1.message?.slice(0, 400));
    pointerStays("③-1");

    // ③-2 产物篡改：改 dist 分片字节（戳冻结的输出清单对不上）
    const shard = path.join(pkgRoot, "dist", "assets", "index.js");
    const shardOriginal = fs.readFileSync(shard);
    fs.writeFileSync(shard, `${shardOriginal.toString("utf8")}\n// tampered by fixture\n`, "utf8");
    const r2 = tryPoint("pkg-cand", `${CHANGE}-b`);
    ok(r2.ok === false && r2.code === "PROMOTION_UNVERIFIED", `③-2 产物篡改拒 PROMOTION_UNVERIFIED（${r2.code}）`);
    ok((r2.message ?? "").includes("冻结清单不一致"), `③-2 失败点名"输出与构建期冻结清单不一致"`, r2.message?.slice(0, 400));
    pointerStays("③-2");
    fs.writeFileSync(shard, shardOriginal);

    // ③-3 分片缺失：删掉被入口引用的随包后端分片
    const part = path.join(pkgRoot, "src-tauri", "resources", "server", "mcp.js");
    const partOriginal = fs.readFileSync(part);
    fs.rmSync(part);
    const r3 = tryPoint("pkg-cand", `${CHANGE}-c`);
    ok(r3.ok === false && r3.code === "PROMOTION_UNVERIFIED", `③-3 分片缺失拒 PROMOTION_UNVERIFIED（${r3.code}）`);
    ok((r3.message ?? "").includes("缺必需部件") || (r3.message ?? "").includes("引用的产物缺失"), `③-3 失败点名"缺必需部件/引用产物缺失"`, r3.message?.slice(0, 400));
    pointerStays("③-3");
    fs.writeFileSync(part, partOriginal);

    // ③-4 A 版包冒充 B 版：把"另一版"的内嵌身份产物换进来（源码仍是 B 版）
    const bDefine = defineFor(pkgRoot);
    const aDefine = defineFor(pkgRoot, { serverFp: "a".repeat(64), uiFp: "b".repeat(64) });
    ok(aDefine !== bDefine, "③-4 夹具造出 A 版（另一 release）的内嵌身份");
    buildPackage(pkgRoot, { spoofDefine: aDefine });
    const r4 = tryPoint("pkg-cand", `${CHANGE}-d`);
    ok(r4.ok === false && r4.code === "PROMOTION_UNVERIFIED", `③-4 A 版包冒充 B 版源码拒 PROMOTION_UNVERIFIED（${r4.code}）`);
    ok((r4.message ?? "").includes("内嵌 release_id") || (r4.message ?? "").includes("release"), `③-4 失败点名"内嵌 release_id ≠ 期望"（真实产物被读回核对）`, r4.message?.slice(0, 500));
    pointerStays("③-4");
    // 还原 B 版：重建同版产物 → 提升恢复
    clearArtifacts(pkgRoot);
    buildPackage(pkgRoot);
    const restored = tryPoint("pkg-cand", `${CHANGE}-e`);
    ok(restored.ok === true, `③-4 还原同版产物后提升恢复（${restored.ok ? "ok" : restored.message?.slice(0, 300)}）`);
  }

  // ═══ ④ 输入篡改：构建输入在冻结后漂移（宿主现算） ═══
  section("④ 输入篡改：构建输入漂移被宿主现算拒（单元级，含全路径实测）");
  {
    const frozen = mustPackage(pkgRoot);
    const appFile = path.join(pkgRoot, "src", "server", "app.ts");
    const original = fs.readFileSync(appFile);
    fs.writeFileSync(appFile, "export const app = 'v2-tampered';\n", "utf8");
    // 全路径：源码内容指纹先行拒（候选索引口径），同样 fail-closed
    const full = tryPoint("pkg-cand", `${CHANGE}-f`);
    ok(full.ok === false && full.code === "PROMOTION_UNVERIFIED", `④ 全路径：改源码后提升拒（${full.code}）`);
    pointerStays("④");
    // 单元级：直接调宿主实测判据，确认「构建输入漂移」这一条独立成立（不只靠内容指纹）
    const v = verifyPackageAtPromotion({ root: pkgRoot, frozen });
    ok(v.applicable === true && v.ok === false, "④ 单元级：verifyPackageAtPromotion 判不通过");
    ok(v.reasons.some((r) => r.includes("构建输入在冻结后漂移")) || v.reasons.some((r) => r.includes("输入指纹与冻结记录不符")), "④ 单元级：点名「构建输入在冻结后漂移」", v.reasons);
    fs.writeFileSync(appFile, original);
    ok(verifyPackageAtPromotion({ root: pkgRoot, frozen }).ok === true, "④ 还原源码后同版产物重新判通过");
  }

  // ═══ ⑤ 旧记录缺字段 + 已知包 ⇒ 未知（不默认真） ═══
  section("⑤ 旧记录缺 build_identity + 已知包项目 ⇒ 未知（不默认真）");
  {
    const legacy = await registerAndFreeze("pkg-legacy", pkgLegacyRoot);
    ok(legacy.code === null && legacy.binding?.delivery_kind === "package", "⑤ 新格式冻结先绑定身份（对照组）");
    // 模拟**旧记录**：把该 frozen 事件的 version_binding.build_identity 去掉（当时字段不存在）
    const ledgerFile = path.join(workDir, "events.jsonl");
    const lines = fs.readFileSync(ledgerFile, "utf8").split("\n");
    let stripped = false;
    const out = lines.map((l) => {
      if (l.trim() === "") return l;
      const e = JSON.parse(l) as { entity_id?: string; type?: string; payload?: { version_binding?: Record<string, unknown> } };
      if (e.entity_id === "workspace:pkg-legacy" && e.type === "workspace.frozen" && e.payload?.version_binding !== undefined) {
        delete e.payload.version_binding.build_identity;
        stripped = true;
        return JSON.stringify(e);
      }
      return l;
    });
    fs.writeFileSync(ledgerFile, out.join("\n"), "utf8");
    ok(stripped, "⑤ 夹具确已把旧 frozen 事件的 build_identity 抹掉（模拟 schema 兼容前的记录）");
    const rec = readWorkspaces(workDir).workspaces["pkg-legacy"];
    ok(rec.freeze !== null && rec.freeze.version_binding.build_identity === null, "⑤ 折叠后该记录 build_identity=null（schema 兼容：旧记录可读）");
    buildPackage(pkgLegacyRoot); // 产物齐备也**不得**默认通过
    const r = tryPoint("pkg-legacy", `${CHANGE}-g`);
    ok(r.ok === false && r.code === "PROMOTION_UNVERIFIED", `⑤ 旧记录（已知包）缺身份拒 PROMOTION_UNVERIFIED（不默认真）(${r.code})`);
    ok((r.message ?? "").includes("不得默认真") || (r.message ?? "").includes("未知"), "⑤ 失败点名「按未知处理，不得默认真」", r.message?.slice(0, 400));
    pointerStays("⑤");
  }

  // ═══ ⑥ 声明包却没有受支持身份 ⇒ unsupported／未知 ═══
  section("⑥ 声明包但没有受支持身份 ⇒ PACKAGE_IDENTITY_UNSUPPORTED（不假称已测）");
  {
    const reg = registerWorkspace(submitter, {
      project_id: PID, workspace_id: "plain-declared", change_id: CHANGE, actor_id: COORD, role: "coordinator",
      kind: "candidate", purpose: "普通项目（却声明包交付）", root: plainRoot, source_kind: "directory", task_ids: ["F-1"],
    });
    ok(reg.ok === true, "⑥ 登记普通候选（无 §6.10 构建链）");
    const rec = readWorkspaces(workDir).workspaces["plain-declared"];
    const evDir = path.join(workDir, "evidence");
    const evCount = (): number => (fs.existsSync(evDir) ? fs.readdirSync(evDir).length : 0);
    const ev0 = evCount();
    const b0 = loadEvents(workDir).events.length;
    const fr = freezeWorkspace(submitter, {
      project_id: PID, workspace_id: "plain-declared", change_id: CHANGE, actor_id: COORD, role: "coordinator",
      expected_revision: rec.revision, included_uncommitted: false, declared_paths: [], declared_package: true,
    });
    ok(fr.ok === false && fr.code === "PACKAGE_IDENTITY_UNSUPPORTED", `⑥ 声明包但无构建链：冻结拒 PACKAGE_IDENTITY_UNSUPPORTED（${fr.ok ? "（意外放行）" : fr.code}）`);
    ok(loadEvents(workDir).events.length === b0, "⑥ 拒绝时零字节写入（现场未改）");
    ok(evCount() === ev0, `⑥ 拒绝不留索引/恢复证据副作用（判据在保全之前）`);

    // ⑥b 调用方**不得**自报包身份（宿主实测；不接受 measured/自报通过）
    const recB = readWorkspaces(workDir).workspaces["plain-declared"];
    let selfReported: string | null = null;
    try {
      service.submit({
        schema_version: 2, project_id: PID, change_id: CHANGE, entity_id: "workspace:plain-declared",
        expected_revision: recB.revision, type: "workspace.frozen", actor_id: COORD, role: "coordinator",
        idempotency_key: "plain-declared:freeze:self-reported-identity",
        payload: {
          content_fingerprint: "a".repeat(64), included_uncommitted: false, declared_paths: [],
          version_binding: {
            build_identity: { delivery_kind: "package", basis: "调用方自报", release_id: "f".repeat(64), build_id: { server: "f".repeat(64), ui: "f".repeat(64) }, server_input_fingerprint: "f".repeat(64), ui_input_fingerprint: "f".repeat(64), toolchain: { node: "v0", pnpm: "0", platform: "x", arch: "x", targets: { server: "node20", ui: "baseline-widely-available" }, bundler: { vite: "0", rollup: "0", esbuild: "0" } } },
          },
        },
      });
    } catch (e) {
      selfReported = isWorkError(e) ? `${e.detail?.reason ?? e.code}` : `NON_WORK_ERROR:${(e as Error).message}`;
    }
    ok(
      selfReported === "INVALID_COMMAND" || (selfReported !== null && selfReported.includes("INVALID")),
      `⑥b 调用方自报 build_identity 被锁内拒（不接受 measured/自报）(${selfReported})`,
    );
    ok(loadEvents(workDir).events.length === b0, "⑥b 拒绝时零字节写入");
  }

  // ═══ ⑦ 普通非包项目：合理 not_applicable，不额外阻塞 ═══
  section("⑦ 普通非包项目：合理 not_applicable，试用提升正常通过");
  {
    const plain = await registerAndFreeze("plain-cand", plainRoot2);
    ok(plain.code === null && plain.binding?.delivery_kind === "not_applicable", `⑦ 普通候选冻结为 not_applicable（delivery_kind=${plain.binding?.delivery_kind}）`, plain.binding);
    ok(plain.binding?.release_id === null, "⑦ not_applicable 时不冒充 release_id（如实 null）");
    await seedEvidence("plain-cand", ["b.txt", "README.md"]);
    const r = tryPoint("plain-cand", `${CHANGE}-h`);
    ok(r.ok === true, `⑦ 普通非包项目试用提升通过（不额外阻塞）(${r.ok ? "ok" : `${r.code}: ${r.message?.slice(0, 300)}`})`);
    ok(readWorkspaces(workDir).pointer?.current_trial_workspace_id === "plain-cand", "⑦ 当前试用候选指针＝plain-cand");
  }

  // ═══ ⑧ 非 Git／CRLF：冻结 PLAN 快照读回（impl-final-readout 遗留负例） ═══
  section("⑧ 非 Git／CRLF 环境：冻结候选的 PLAN 快照仍可读回（不因缺内容名副本判 not_derived）");
  {
    ok(!fs.existsSync(path.join(crlfRoot, ".git")) && !fs.existsSync(path.join(crlfCand, ".git")), "⑧ 夹具确为非 Git 环境（无 .git）");
    const crlfSetup = { submit: (c: unknown) => service.submit(c) };
    registerRequirement(crlfSetup as never, {
      project_id: CRLF_PID, requirement_id: "req-crlf", change_id: CHANGE, actor_id: "pkg-setup", role: "designer",
      source: { kind: "user", ref: "夹具" }, problem: "非 Git CRLF 夹具需求", users: [], success_scenarios: [], exclusions: [], priority: "P1", status: "explicit",
    });
    const imported = importPlanChecked(CRLF_PLAN, crlfWorkDir, { plan_revision: crypto.createHash("sha256").update(CRLF_PLAN, "utf8").digest("hex") });
    submitDefinitionImports(service, { project_id: CRLF_PID, change_id: CHANGE, actor_id: "pkg-setup", role: "coordinator", definitions: imported.definitions });
    activateBaseline(CRLF_PID, { approved_by: "user", approval_basis: "非 Git CRLF 夹具审定（不代表真实用户 Gate）", approval_kind: "user_confirmed" }, dataDir);
    const crlfSubmitter = { submit: (c: unknown) => service.submit(c), read: () => readWorkspaces(crlfWorkDir) };
    const reg = registerWorkspace(crlfSubmitter, {
      project_id: CRLF_PID, workspace_id: "cand-crlf", change_id: CHANGE, actor_id: COORD, role: "coordinator",
      kind: "candidate", purpose: "非 Git CRLF 候选", root: crlfCand, source_kind: "directory", task_ids: ["F-1"],
    });
    ok(reg.ok === true, `⑧ 登记非 Git 候选（${reg.ok ? "ok" : reg.code}）`);
    const rec = readWorkspaces(crlfWorkDir).workspaces["cand-crlf"];
    const fr = freezeWorkspace(crlfSubmitter, {
      project_id: CRLF_PID, workspace_id: "cand-crlf", change_id: CHANGE, actor_id: COORD, role: "coordinator",
      expected_revision: rec.revision, included_uncommitted: false, declared_paths: [],
    });
    ok(fr.ok === true, `⑧ 冻结非 Git 候选（宿主现读 CRLF 的 DESIGN/PLAN 内容哈希）(${fr.ok ? "ok" : `${fr.code}: ${fr.message}`})`);
    const frozen = readWorkspaces(crlfWorkDir).workspaces["cand-crlf"];
    const planSha = frozen.freeze?.version_binding.plan_sha256 ?? null;
    const designSha = frozen.freeze?.version_binding.design_sha256 ?? null;
    ok(planSha === crypto.createHash("sha256").update(CRLF_PLAN, "utf8").digest("hex"), "⑧ 冻结绑定的是 **CRLF 原文**的 PLAN 内容哈希");
    ok(designSha !== null, "⑧ 冻结同时绑定 DESIGN 内容哈希");
    const res = readFeatureLedger(CRLF_PID, dataDir, { workspace: "cand-crlf" }, { project_exists: () => true });
    const led = (res as { ledger?: { document_selection?: { mode?: string; plan_revision?: string | null } } }).ledger;
    const sel = led?.document_selection;
    ok(sel?.mode === "frozen_candidate", `⑧ 交付读数按冻结候选版本读（mode=${sel?.mode}）`, res);
    ok(sel?.plan_revision === planSha, `⑧ 非 Git/CRLF 的 PLAN 快照**读回成功**（plan_revision=${sel?.plan_revision?.slice(0, 12) ?? "null"}…）——不因缺内容名副本判 not_derived`, res);
  }

  // ═══ ⑨ 真实宿主 + fresh stdio MCP（HTTP/MCP 接线） ═══
  await hostMcpSection(workDir, PID, submitter);

  console.log(`\n[pkg] 结果：PASS ${pass} / FAIL ${fail}`);
  if (fail > 0) process.exitCode = 1;
}

async function hostMcpSection(workDir: string, PID: string, submitter: { submit: (c: unknown) => unknown; read: () => ReturnType<typeof readWorkspaces> }): Promise<void> {
  section("⑨ 真实宿主进程 + fresh stdio MCP：freeze/point_trial 的包身份实测走真实接线");
  const CAND = "mcp-cand";
  const hostRoot = path.join(tmpBase, "hpack-cand");
  makePackageRoot(hostRoot, "9.9.9");
  buildPackage(hostRoot);
  const serverLog = path.join(tmpBase, "server.log");
  const descriptor = path.join(dataDir, "work-service.json");
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const server = spawn(process.execPath, [TSX, "src/server/index.ts"], {
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: "0", TATAI_NO_AUTOSTART: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(server);
  const log = fs.createWriteStream(serverLog);
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);

  let desc: { pid: number; port: number } | null = null;
  for (let i = 0; i < 120; i += 1) {
    await sleep(500);
    try {
      desc = JSON.parse(fs.readFileSync(descriptor, "utf8")) as { pid: number; port: number };
    } catch {
      desc = null;
    }
    if (desc !== null && desc.port > 0) break;
  }
  ok(desc !== null && desc.port > 0, "⑨ 真宿主就绪（work-service.json 带真实端口）", desc);
  if (desc === null) {
    console.log(fs.readFileSync(serverLog, "utf8").slice(0, 3000));
    return;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, "src/mcp/index.ts"],
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_NO_AUTOSTART: "1" },
    stderr: "pipe",
  });
  const client = new Client({ name: "pkg-host-mcp", version: "1" }, { capabilities: {} });
  await client.connect(transport);
  const mcpPid = transport.pid;
  if (typeof mcpPid === "number" && mcpPid > 0) children.push({ pid: mcpPid } as ChildProcess);

  const parseTool = (res: unknown): Record<string, unknown> => {
    const content = (res as { content?: { text?: string }[] }).content ?? [];
    try {
      return JSON.parse(content[0]?.text ?? "") as Record<string, unknown>;
    } catch {
      return { raw: content[0]?.text ?? "", isError: (res as { isError?: boolean }).isError === true };
    }
  };

  try {
    const reg = parseTool(
      await client.callTool({
        name: "manage_workspace",
        arguments: {
          op: "register", project_id: PID, role: "coordinator", actor_id: "pkg-mcp", change_id: "change-pkg-mcp",
          workspace_id: CAND, kind: "candidate", purpose: "跨进程包候选", root: hostRoot, source_kind: "directory", task_ids: ["F-1"],
        },
      }),
    );
    ok(reg.ok === true, "⑨ 经 fresh stdio MCP register 包候选成功（命令发往宿主）", reg);
    const rec = readWorkspaces(workDir).workspaces[CAND];
    const fr = parseTool(
      await client.callTool({
        name: "manage_workspace",
        arguments: {
          op: "freeze", project_id: PID, role: "coordinator", actor_id: "pkg-mcp", change_id: "change-pkg-mcp",
          workspace_id: CAND, expected_revision: rec.revision, included_uncommitted: false, declared_paths: [],
        },
      }),
    );
    ok(fr.ok === true, "⑨ 经 fresh stdio MCP freeze 成功（锁内宿主实测构建输入身份）", fr);
    const frozen = readWorkspaces(workDir).workspaces[CAND];
    ok(
      frozen.freeze?.version_binding.build_identity?.delivery_kind === "package" &&
        frozen.freeze.version_binding.build_identity.release_id !== null,
      "⑨ 冻结事件里带上宿主实测的构建包身份（release_id 在场）",
      frozen.freeze?.version_binding.build_identity,
    );

    // 证据（进程内种子，与宿主同一账本；只在宿主未代写的间隙落证据）
    const ev = mockRes();
    await handleReportingRequest(
      mockReq("/api/work/reporting/evidence", {
        project_id: PID, workspace_id: CAND, content: "", kind: "source_manifest", summary: "跨进程包候选源清单",
        created_by: "pkg-mcp-exec", role: "executor", binding: { revision_kind: "code", revision: "rev-mcp" },
        source_manifest: [{ path: "src/server/app.ts" }, { path: "README.md" }],
      }),
      ev.res,
      { pathname: "/api/work/reporting/evidence", dataDir },
    );
    const evBody = ev.read().body as { ok?: boolean; evidence?: { evidence_id?: string; source_manifest?: { fingerprint?: string } } };
    const evid = evBody.evidence?.evidence_id ?? "";
    const fp = evBody.evidence?.source_manifest?.fingerprint ?? "";
    ok(evBody.ok === true && evid !== "", "⑨ 跨进程候选源清单证据落账");
    submitSelfCheck(submitter as never, {
      project_id: PID, change_id: "change-pkg-mcp", actor_id: "pkg-mcp-exec", role: "executor", record_id: "sc-mcp",
      task_id: "F-1", checked_by: "pkg-mcp-exec", conclusion: "pass",
      binding: { revision_kind: "code", revision: fp },
      checks: [
        { check_id: "F-1::check:0", method: "夹具", command: null, exit_code: null, evidence_sha256: evid, scope: [], verifies: "code" },
        { check_id: "F-1::evidence", method: "交付物证据（夹具）", command: null, exit_code: null, evidence_sha256: evid, scope: [], verifies: "code" },
      ],
    });
    submitIndependentAudit(submitter as never, {
      project_id: PID, change_id: "change-pkg-mcp", actor_id: "pkg-mcp-aud", role: "auditor", record_id: "ia-mcp",
      task_id: "F-1", auditor: "pkg-mcp-aud", author_id: "pkg-mcp-exec", conclusion: "pass",
      binding: { revision_kind: "code", revision: fp },
      checks: [{ check_id: "F-1::check:0", result: "passed", evidence_sha256: evid, scope: [] }],
      coverage: COVERAGE_AREAS.map((a) => ({ area: a, status: "checked" as const, basis: `${COVERAGE_AREA_LABELS[a]}：夹具` })),
    });

    const ptrRev = readWorkspaces(workDir).pointer?.revision ?? 0;
    const pt = parseTool(
      await client.callTool({
        name: "manage_workspace",
        arguments: {
          op: "point_trial", project_id: PID, role: "coordinator", actor_id: "pkg-mcp", change_id: "change-pkg-mcp",
          workspace_id: CAND, expected_revision: ptrRev, basis: "夹具：跨进程提升",
        },
      }),
    );
    ok(pt.ok === true, "⑨ 经 fresh stdio MCP point_trial 通过（宿主实测真实产物，跨进程）", pt);
    ok(readWorkspaces(workDir).pointer?.current_trial_workspace_id === CAND, "⑨ 试用指针经真实宿主落到事件账本");

    // 跨进程反例：篡改产物后经 MCP 提升被拒、旧指针保留
    const shard = path.join(hostRoot, "dist", "assets", "index.js");
    const original = fs.readFileSync(shard);
    fs.writeFileSync(shard, `${original.toString("utf8")}\n// tampered cross-process\n`, "utf8");
    const ptrRev2 = readWorkspaces(workDir).pointer?.revision ?? 0;
    const bad = parseTool(
      await client.callTool({
        name: "manage_workspace",
        arguments: {
          op: "point_trial", project_id: PID, role: "coordinator", actor_id: "pkg-mcp", change_id: "change-pkg-mcp-bad",
          workspace_id: CAND, expected_revision: ptrRev2, basis: "夹具：篡改后跨进程提升",
        },
      }),
    );
    ok(bad.ok === false, "⑨ 篡改产物后经 MCP 提升被宿主拒（跨进程 fail-closed）", bad);
    ok(readWorkspaces(workDir).pointer?.current_trial_workspace_id === CAND, "⑨ 跨进程拒绝保留旧指针");
    fs.writeFileSync(shard, original);
  } finally {
    try {
      await client.close();
    } catch {
      /* 收尾 */
    }
    if (server.pid !== undefined) killTree(server.pid);
    await new Promise((r) => setTimeout(r, 800));
  }
}

main()
  .catch((e) => {
    console.error(`[pkg] 异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    console.log(`\n[pkg] 汇总：PASS=${pass} FAIL=${fail}`);
    if (fail > 0) process.exitCode = 1;
    cleanup();
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
  });
