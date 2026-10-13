// V09-64/66 真实跨进程端到端验证（tsx 跑）：**真监听端口的后端服务进程 + 全新 stdio MCP 客户端**。
//
// 与 `verify-workspace-integration.ts` 的分工：
//   · 那个脚本的 HTTP 面是**进程内路由 CPU 路径**（mockReq/mockRes 直调处理器），**不代表**已真实监听端口
//     或已跑新 stdio 客户端；
//   · 本脚本起**真的后端服务进程**（`src/server/index.ts`，真实监听 `127.0.0.1:<port>`、发布
//     `work-service.json` 描述符），并用**全新的 stdio MCP 子进程**（`src/mcp/index.ts`）经 MCP 协议调用——
//     写命令走网络到宿主进程落盘（不在 stdio 子进程里写），并验证**真实 HTTP** 读口的行为。
//
// 断言：
//   A. 真实宿主 + fresh stdio MCP：`manage_workspace` register/freeze 成功，且写落在**宿主进程**（描述符 pid
//      ＝宿主实际服务进程、事件/证据出现在宿主数据目录）——不是 stdio 子进程自己写。
//   B. 宿主停掉后，同一 stdio MCP 再 register 一个新工作区**失败**（SERVICE_UNAVAILABLE），盘上**没有**该
//      工作区事件——证明 stdio 进程不本地写账本（跨进程写口是真的）。
//   C. 真实 HTTP `GET /api/projects/:id/feature-ledger`：`workspace=<未知 id>` → **400**（不透传就会被丢→422）；
//      `workspace=<已登记候选>` → 200；分支套 `withoutLocalPaths`（远端 F6 脱敏）。
//   D. 同一 fresh stdio MCP 经 `feature_ledger` 带 `workspace` 参数可读（HTTP/MCP 同底层同义）。
//
// 自带隔离环境（临时 TATAI_HOME + os.tmpdir() 夹具 + 临时端口），**不碰**真实项目/账本/生产服务；
// 结束时按 PID 子树收尾（不 Stop 所有 node）。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { WorkService } from "../src/server/work/service";
import { projectWorkDir } from "../src/server/workstation";
import { activateBaseline, buildSectionIndex } from "../src/server/work/documents";
import { importTaskDefinitions } from "../src/server/work/plan";
import { submitDefinitionImports } from "../src/server/work/tasks";
import { registerRequirement } from "../src/server/work/requirements";
import { readWorkspaces } from "../src/server/work/workspaces";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[e2e] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[e2e]   现场：${JSON.stringify(detail).slice(0, 1500)}`);
  }
};
const section = (t: string): void => console.log(`\n[e2e] ═══ ${t}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-hoste2e-"));
const PID = "hoste2e";
/** 只在**注册表锚点旧主根**出现的针（读到它 = 读了错版本） */
const ANCHOR_NEEDLE = "注册表锚点旧主根正文-不应被读到-b104";
/** 只在**当前开发工作区**出现的针（应被读到） */
const DEV_DESIGN_NEEDLE = "开发工作区设计正文-应被读到-3f9a";
const DEV_PLAN_NEEDLE = "开发工作区施工图正文-应被读到-7c21";
const PROJ = path.join(HOME, "proj");
const CAND = path.join(HOME, "cand");
const CAND2 = path.join(HOME, "cand2");
const DESCRIPTOR = path.join(HOME, "work-service.json");
let WORKDIR = "";
const serverLog = path.join(HOME, "server.log");

const children: ChildProcess[] = [];
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
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* 回收失败不影响判分 */
  }
}
process.on("exit", cleanup);

const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};
function parseTool(res: unknown): Record<string, unknown> {
  const content = (res as { content?: { text?: string }[] }).content ?? [];
  try {
    return JSON.parse(content[0]?.text ?? "") as Record<string, unknown>;
  } catch {
    return { raw: content[0]?.text ?? "", isError: (res as { isError?: boolean }).isError === true };
  }
}
function readDescriptor(): { pid: number; port: number; host: string; token: string } | null {
  try {
    return JSON.parse(fs.readFileSync(DESCRIPTOR, "utf8")) as { pid: number; port: number; host: string; token: string };
  } catch {
    return null;
  }
}
async function httpGet(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: await res.text() };
}
/** 指定 host（含局域网 IP）+ 可选 Bearer 凭据的 GET（remote F6 用） */
async function httpGetAt(
  host: string,
  port: number,
  urlPath: string,
  token?: string,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://${host}:${port}${urlPath}`, {
    ...(token !== undefined ? { headers: { authorization: `Bearer ${token}` } } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: await res.text() };
}
/** 本机第一个非内部 IPv4（真实局域网地址；没有 → null，相关段如实 SKIP） */
function firstLanIpv4(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}
function countWsEvents(wsId: string): number {
  const f = path.join(WORKDIR, "events.jsonl");
  if (!fs.existsSync(f)) return 0;
  return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.includes(wsId)).length;
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** 路径等价（Windows 大小写/短名差异：按 resolve + 小写比较，不改变判据） */
function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a === "" || b === "") return false;
  const ra = path.resolve(a).toLowerCase();
  const rb = path.resolve(b).toLowerCase();
  if (ra === rb) return true;
  try {
    return fs.realpathSync.native(ra) === fs.realpathSync.native(rb);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // ── 夹具（进程内先建成项目：DESIGN/PLAN + 需求 + 定义 + 基线；供冻结绑定配套版本 + 功能清单声明区） ──
  const DECL_HEAD = [
    "| 功能 ID | 人话功能名 | 需求 ID | 设计章节 | 本期范围（scope_id） | 覆盖结论 | 依据/缺口（review） | 使用结果与场景 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const planText = [
    "# 夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| H-1 | todo | 跨进程夹具卡 |  | 证据齐 |",
    "",
    "### H-1 跨进程夹具卡",
    "",
    "**设计依据**：§3.5。**依赖**：无。**文件责任**：`a.txt`。",
    "",
    "- [ ] **chk-h-1-01 达标 [独立审计]**",
    "",
    "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
    "| --- | --- | --- | --- | --- | --- |",
    "| cap-h | 跨进程夹具 | H-1 | chk-h-1-01 | int-h-01 | 未验 |",
    "",
  ].join("\n");
  const designDraft = [
    "# 夹具设计书",
    "",
    "### 3.5 目标章节",
    "",
    "正文。",
    "",
    "#### 功能清单声明（夹具）",
    "",
    DECL_HEAD[0],
    DECL_HEAD[1],
    "| cap-h | 跨进程夹具 | req-h | §3.5 | cap-h | 待审 | reviewer=; ref=DESIGN.md#3.5; section_sha256=SECT; gap=x | 场景 |",
    "",
  ].join("\n");
  const sectSha = buildSectionIndex(designDraft).find((s) => s.title.startsWith("3.5 "))?.sha256 ?? "";
  const designText = designDraft.replace("section_sha256=SECT", `section_sha256=${sectSha}`);

  // 锚点旧主根正文里放一枚**只在锚点出现**的针：读到它 = "读了错版本"（E/F 段用）
  write(path.join(PROJ, ".工作台", "design.md"), `${designText}\n${ANCHOR_NEEDLE}\n`);
  write(path.join(PROJ, ".工作台", "plan.md"), planText);
  // 先落 registry.json（addProject 在数据目录已有运行痕迹时会拒建，故按同一格式直接写夹具登记）
  write(
    path.join(HOME, "registry.json"),
    JSON.stringify({
      version: 1,
      projects: [{ id: PID, name: "本地跨进程夹具", path: PROJ, kind: "backend", registered_at: new Date().toISOString(), last_opened_at: new Date().toISOString() }],
    }),
  );
  WORKDIR = projectWorkDir(PID, HOME);
  const fixture = new WorkService({ dataDir: HOME });
  const fixtureWork = { submit: (c: unknown) => fixture.submit(c) };
  const CHANGE = "change-hoste2e";
  registerRequirement(fixtureWork as never, {
    project_id: PID, requirement_id: "req-h", change_id: CHANGE, actor_id: "fixture", role: "designer",
    source: { kind: "user", ref: "夹具" }, problem: "夹具需求", users: [], success_scenarios: [], exclusions: [], priority: "P1", status: "explicit",
  });
  submitDefinitionImports(fixture, {
    project_id: PID, change_id: CHANGE, actor_id: "fixture", role: "coordinator",
    definitions: importTaskDefinitions(planText, { plan_revision: crypto.createHash("sha256").update(planText, "utf8").digest("hex") }).definitions,
  });
  activateBaseline(PID, { approved_by: "user", approval_basis: "跨进程夹具审定（非用户 Gate）", approval_kind: "user_confirmed" }, HOME);
  write(path.join(CAND, "a.txt"), "candidate-bytes-v1\n");
  write(path.join(CAND, "keep.txt"), "keep\n");
  write(path.join(CAND2, "b.txt"), "candidate2-v1\n");

  // ── A. 起真宿主（真实监听 + 发布描述符） ──
  section("A. 真宿主进程 + fresh stdio MCP：写落在宿主进程");
  const server = spawn(process.execPath, [TSX, "src/server/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, TATAI_HOME: HOME, TATAI_PORT: "0", TATAI_NO_AUTOSTART: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(server);
  const out = fs.createWriteStream(serverLog);
  server.stdout?.pipe(out);
  server.stderr?.pipe(out);

  let desc = null as ReturnType<typeof readDescriptor>;
  for (let i = 0; i < 120; i += 1) {
    await sleep(500);
    desc = readDescriptor();
    if (desc !== null && desc.port > 0) break;
  }
  ok(desc !== null && desc.port > 0, "A. 真宿主发布描述符（work-service.json 带真实端口）", desc);
  if (desc === null) {
    console.log(fs.readFileSync(serverLog, "utf8").slice(0, 3000));
    throw new Error("宿主未就绪，无法继续");
  }
  ok(desc.pid !== process.pid && pidAlive(desc.pid), "A. 描述符 pid ＝真实宿主服务进程（≠本测试进程，且在运行）", { desc_pid: desc.pid, test_pid: process.pid });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX, "src/mcp/index.ts"],
    cwd: ROOT,
    env: { ...process.env, TATAI_HOME: HOME, TATAI_NO_AUTOSTART: "1" },
    stderr: "pipe",
  });
  const client = new Client({ name: "hoste2e-client", version: "1" }, { capabilities: {} });
  await client.connect(transport);
  const mcpPid = transport.pid;
  if (typeof mcpPid === "number" && mcpPid > 0) children.push({ pid: mcpPid } as ChildProcess); // 收尾兜底
  ok(typeof mcpPid === "number" && mcpPid !== desc.pid, "A. MCP 是独立子进程（与宿主不同 pid）", { mcp_pid: mcpPid, server_pid: desc.pid });

  const WS = "ws-host";
  const reg = parseTool(
    await client.callTool({
      name: "manage_workspace",
      arguments: { op: "register", project_id: PID, role: "coordinator", actor_id: "host-e2e", change_id: CHANGE, workspace_id: WS, kind: "candidate", purpose: "跨进程候选", root: CAND, source_kind: "directory" },
    }),
  );
  ok(reg.ok === true, "A. 经 fresh stdio MCP 调 manage_workspace(register) 成功（命令发往宿主）", reg);

  const rec = readWorkspaces(WORKDIR).workspaces[WS];
  const fr = parseTool(
    await client.callTool({
      name: "manage_workspace",
      arguments: { op: "freeze", project_id: PID, role: "coordinator", actor_id: "host-e2e", change_id: CHANGE, workspace_id: WS, expected_revision: rec.revision, included_uncommitted: false, declared_paths: [] },
    }),
  );
  ok(fr.ok === true, "A. 经 fresh stdio MCP 调 manage_workspace(freeze) 成功（HTTP 写路径，非进程内）", fr);
  ok(countWsEvents(WS) > 0 && fs.readFileSync(path.join(WORKDIR, "events.jsonl"), "utf8").includes('"workspace.frozen"'), "A. 冻结事件落在宿主数据目录（写发生在宿主进程）");
  const evidenceDir = path.join(WORKDIR, "evidence");
  const evidenceCount = fs.existsSync(evidenceDir) ? fs.readdirSync(evidenceDir).length : 0;
  ok(evidenceCount > 0, "A. 宿主落盘了候选索引/恢复证据（内容寻址）", { evidenceCount });

  // ── C. 真实 HTTP feature-ledger 路由：workspace 透传 + 未知 400 ──
  section("C. 真实 HTTP GET /feature-ledger：workspace 透传、未知 400");
  const bad = await httpGet(desc.port, `/api/projects/${encodeURIComponent(PID)}/feature-ledger?workspace=${encodeURIComponent("__nope__")}`);
  ok(bad.status === 400, "C. workspace=<未知 id> 明确 400（未被固定白名单丢弃）", { status: bad.status, body: bad.body.slice(0, 300) });
  const good = await httpGet(desc.port, `/api/projects/${encodeURIComponent(PID)}/feature-ledger?workspace=${encodeURIComponent(WS)}`);
  ok(good.status === 200, "C. workspace=<已登记候选> 200（真实 HTTP 读口）", { status: good.status, body: good.body.slice(0, 200) });
  const srcIndex = fs.readFileSync(path.join(ROOT, "src", "server", "index.ts"), "utf8");
  const branchAt = srcIndex.indexOf("featureLedgerMatch) {");
  const branch = branchAt >= 0 ? srcIndex.slice(branchAt, branchAt + 3000) : "";
  ok(branch.includes("withoutLocalPaths") && branch.includes('"workspace"'), "C. feature-ledger 分支：query 白名单含 workspace 且响应经 withoutLocalPaths 脱敏（远端 F6）", { hasWrap: branch.includes("withoutLocalPaths"), hasWorkspace: branch.includes('"workspace"') });

  // ── D. fresh stdio MCP 的 feature_ledger 带 workspace 可读 ──
  section("D. fresh stdio MCP feature_ledger 带 workspace 参数");
  const mcpLedger = parseTool(await client.callTool({ name: "feature_ledger", arguments: { project_id: PID, workspace: WS } }));
  ok(mcpLedger.ok === true, "D. MCP feature_ledger 接受并透传 workspace", mcpLedger);
  const mcpLedgerBad = parseTool(await client.callTool({ name: "feature_ledger", arguments: { project_id: PID, workspace: "__nope__" } }));
  ok(mcpLedgerBad.ok === false, "D. MCP feature_ledger 未知 workspace ⇒ 非 ok（400 语义）", mcpLedgerBad);

  // ── E. 当前开发指针贯通：**fresh stdio MCP 进程自己的只读读口** + 真实 HTTP 都读 dev 根 ──
  // 关键：`read_design`/`read_plan` 由 **MCP 子进程本地**读盘（不经宿主），所以这里能证明
  // "读对开发根"靠的是 **MCP 进程自己的组合根接线**（`installWorkspaceReadWiring`），不是"启动了 writer 才读对"。
  section("E. 显式开发指针：stdio 只读读口 + 真实 HTTP 都读 dev 根（不读锚点旧主根）");
  const DEV = path.join(HOME, "dev");
  write(path.join(DEV, ".工作台", "design.md"), `${designText}\n\n${DEV_DESIGN_NEEDLE}\n`);
  write(path.join(DEV, ".工作台", "plan.md"), `${planText}\n${DEV_PLAN_NEEDLE}\n`);
  const WSD = "ws-dev";
  const regDev = parseTool(
    await client.callTool({
      name: "manage_workspace",
      arguments: { op: "register", project_id: PID, role: "coordinator", actor_id: "host-e2e", change_id: CHANGE, workspace_id: WSD, kind: "dev", purpose: "当前开发工作区", root: DEV, source_kind: "directory" },
    }),
  );
  ok(regDev.ok === true, "E. 登记开发工作区（kind=dev）成功", regDev);
  // select_dev/point_trial 的 `expected_revision` 是**指针实体**的版本（不是工作区记录版本）：无指针时＝0
  const ptrRevBefore = readWorkspaces(WORKDIR).pointer?.revision ?? 0;
  const selDev = parseTool(
    await client.callTool({
      name: "manage_workspace",
      arguments: { op: "select_dev", project_id: PID, role: "coordinator", actor_id: "host-e2e", change_id: CHANGE, workspace_id: WSD, expected_revision: ptrRevBefore, basis: "夹具：显式开发指针" },
    }),
  );
  ok(selDev.ok === true, "E. select_dev 切换当前开发指针成功", selDev);
  ok(readWorkspaces(WORKDIR).pointer?.current_dev_workspace_id === WSD, "E. 指针确实落在事件账本（current_dev_workspace_id=ws-dev）");

  const rdDev = parseTool(await client.callTool({ name: "read_design", arguments: { project_id: PID } }));
  const rdDevContent = (rdDev as { design?: { content?: string | null } }).design?.content ?? "";
  ok(rdDevContent.includes(DEV_DESIGN_NEEDLE), "E. MCP(read_design) 在 dev 根读到 dev 正文（MCP 进程自己解析，不经宿主）");
  ok(!rdDevContent.includes(ANCHOR_NEEDLE), "E. MCP(read_design) 读到的不是锚点旧主根正文（未回落旧版本）");
  const rpDev = parseTool(await client.callTool({ name: "read_plan", arguments: { project_id: PID } }));
  const rpDevContent = (rpDev as { plan?: { content?: string | null } }).plan?.content ?? "";
  ok(rpDevContent.includes(DEV_PLAN_NEEDLE), "E. MCP(read_plan) 在 dev 根读到 dev 施工图正文");

  const httpDesign = await httpGet(desc.port, `/api/projects/${encodeURIComponent(PID)}/design`);
  ok(httpDesign.status === 200 && httpDesign.body.includes(DEV_DESIGN_NEEDLE) && !httpDesign.body.includes(ANCHOR_NEEDLE), "E. 真实 HTTP(GET /design) 也读 dev 根（不读锚点旧主根）", { status: httpDesign.status });

  const entDev = parseTool(
    await client.callTool({ name: "project_entry", arguments: { project_id: PID, role: "executor", client_capabilities: "work_ledger_v2" } }),
  );
  const entDevWs = (entDev as { context_manifest?: { workspace?: { root?: string | null; source?: string; workspace_id?: string } } }).context_manifest?.workspace;
  ok(samePath(entDevWs?.root, DEV) && entDevWs?.source === "pointer", "E. project_entry 的 workspace 续接上下文实测 dev 根（source=pointer）", entDevWs);
  // 更强判据：入口**实际读的图纸正文**必须是 dev 版（不是锚点旧主根）——这条才真正锁住
  // "宿主只读 worker 也装了源根接线"（worker 是独立线程，主线程装了不等于它装了）。
  const sha256ofBytes = (s: string): string => crypto.createHash("sha256").update(s, "utf8").digest("hex");
  const devDesignSha = sha256ofBytes(`${designText}\n\n${DEV_DESIGN_NEEDLE}\n`);
  const anchorDesignSha = sha256ofBytes(`${designText}\n${ANCHOR_NEEDLE}\n`);
  const devPlanSha = sha256ofBytes(`${planText}\n${DEV_PLAN_NEEDLE}\n`);
  const entDevDocs = (entDev as { project?: { documents?: { design?: { content_sha256?: string }; plan?: { content_sha256?: string } } } }).project?.documents;
  ok(
    entDevDocs?.design?.content_sha256 === devDesignSha && devDesignSha !== anchorDesignSha,
    "E. project_entry 的 documents.design 实测 **dev 正文哈希**（不是锚点旧主根；锁住 host 只读 worker 的源根接线）",
    { got: entDevDocs?.design?.content_sha256, dev: devDesignSha, anchor: anchorDesignSha },
  );
  ok(entDevDocs?.plan?.content_sha256 === devPlanSha, "E. project_entry 的 documents.plan 实测 dev 正文哈希", { got: entDevDocs?.plan?.content_sha256, dev: devPlanSha });

  // ── F. 固定候选回收后仍按**同版**可读：目录删除 + retire 后 HTTP/MCP 仍能读该候选 ──
  // 先跑 F 再跑 G：坏指针是 **fail-closed**（会阻断读该项目的当前源），若先制造坏指针会连坐候选读；
  // 两者各自覆盖不同接缝，顺序只是夹具卫生（不改任何判据）。
  section("F. 固定候选回收：retire + 目录删除后仍按同版可读（不判失效、不回落开发目录）");
  const recCand = readWorkspaces(WORKDIR).workspaces[WS];
  const retireCand = parseTool(
    await client.callTool({
      name: "manage_workspace",
      arguments: { op: "retire", project_id: PID, role: "coordinator", actor_id: "host-e2e", change_id: CHANGE, workspace_id: WS, expected_revision: recCand.revision, reason: "夹具：回收候选目录", reachability: "冻结索引/中央快照可还原" },
    }),
  );
  ok(retireCand.ok === true, "F. retire(已冻结候选) 成功", retireCand);
  fs.rmSync(CAND, { recursive: true, force: true });
  ok(!fs.existsSync(CAND), "F. 候选目录已物理删除（模拟按规则回收）");
  const ledgerRecovered = await httpGet(desc.port, `/api/projects/${encodeURIComponent(PID)}/feature-ledger?workspace=${encodeURIComponent(WS)}`);
  ok(ledgerRecovered.status === 200, "F. 真实 HTTP feature-ledger(workspace=已回收候选) 仍 200（同版可读，不因目录删除判失效）", { status: ledgerRecovered.status, body: ledgerRecovered.body.slice(0, 200) });
  const mcpLedgerRecovered = parseTool(await client.callTool({ name: "feature_ledger", arguments: { project_id: PID, workspace: WS } }));
  ok(mcpLedgerRecovered.ok === true, "F. MCP feature_ledger 读已回收候选仍 ok（HTTP/MCP 同底层）", mcpLedgerRecovered);

  // ── G. 坏指针：显式开发指针指向**不存在的工作区** ⇒ 读口明确拒（不静默回落旧主根/main） ──
  // 为什么用"指针指向未知 id"这一形态：`select_dev` 只接受 preparing 的 dev 目标、`retire` 又拒绝
  // 当前开发指针指向的工作区，所以"指针指向已回收工作区"经 API **不可达**；指针指向未知 id 是**唯一**
  // 只能由账本损坏/历史遗留产生的坏指针形态。这里克隆真实 `workspace.pointed` 事件、把 dev 指针改成
  // 一个不存在的工作区 id 再追加（临时夹具账本，非生产），跨进程真实覆盖该防御分支。
  section("G. 坏指针（指针指向不存在的工作区）：读口明确拒 + HTTP 4xx，不偷偷读旧主根");
  const ledgerFile = path.join(WORKDIR, "events.jsonl");
  const ledgerEvents = fs.readFileSync(ledgerFile, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  const lastPointer = [...ledgerEvents].reverse().find((e) => e.type === "workspace.pointed");
  ok(lastPointer !== undefined, "G. 夹具里确有真实 workspace.pointed 事件可克隆");
  const maxSeq = ledgerEvents.reduce((m, e) => Math.max(m, Number(e.seq) || 0), 0);
  const GHOST = "ghost-ws-not-registered";
  const ghostEvent = {
    ...(lastPointer as Record<string, unknown>),
    event_id: `evt-ghost-${Date.now()}`,
    seq: maxSeq + 1,
    entity_revision: Number((lastPointer as { entity_revision?: number }).entity_revision ?? 0) + 1,
    idempotency_key: `ghost-pointer-${Date.now()}`,
    payload: { ...((lastPointer as { payload?: Record<string, unknown> }).payload ?? {}), current_dev_workspace_id: GHOST },
  };
  fs.appendFileSync(ledgerFile, `${JSON.stringify(ghostEvent)}\n`, "utf8");
  ok(readWorkspaces(WORKDIR).pointer?.current_dev_workspace_id === GHOST, "G. 坏指针已落在账本（current_dev_workspace_id=ghost，无此工作区）");
  const rdBad = parseTool(await client.callTool({ name: "read_design", arguments: { project_id: PID } }));
  const rdBadText = JSON.stringify(rdBad);
  ok(!rdBadText.includes(DEV_DESIGN_NEEDLE) && !rdBadText.includes(ANCHOR_NEEDLE), "G. MCP(read_design) 坏指针：既不读 dev 也不回落锚点（如实失败）", rdBad);
  const rpBad = parseTool(await client.callTool({ name: "read_plan", arguments: { project_id: PID } }));
  const rpBadText = JSON.stringify(rpBad);
  ok(!rpBadText.includes(DEV_PLAN_NEEDLE), "G. MCP(read_plan) 坏指针：不读到任何一版施工图（如实失败）", rpBad);
  const httpDesignBad = await httpGet(desc.port, `/api/projects/${encodeURIComponent(PID)}/design`);
  ok(httpDesignBad.status === 400, "G. 真实 HTTP(GET /design) 坏指针 ⇒ 稳定 400（不是 500，也不静默 200 读旧主根）", { status: httpDesignBad.status, body: httpDesignBad.body.slice(0, 200) });
  const entBad = parseTool(
    await client.callTool({ name: "project_entry", arguments: { project_id: PID, role: "executor", client_capabilities: "work_ledger_v2" } }),
  );
  // 坏指针下入口**如实失败**（`loadDocument` 明确拒，不静默读旧主根）——形状可能是结构化错误，也可能是
  // 带 blocked workspace 的降级入口；两者都判为"没偷偷当 :main"，但**绝不**接受一个把 :main 当可用的入口。
  const entBadText = JSON.stringify(entBad);
  ok(
    !entBadText.includes('"source":"main"') && (entBadText.includes("当前开发指针不可用") || entBadText.includes('"source":"blocked"')),
    "G. project_entry 坏指针：如实拒（不静默当 :main）",
    entBad,
  );

  // ── B. 宿主停掉后同一 stdio MCP 再写 ⇒ 失败且盘上无写入 ──
  section("B. 宿主停掉 ⇒ stdio MCP 写失败且盘上无写入（不回退本地写账本）");
  if (server.pid !== undefined) killTree(server.pid);
  await sleep(3000);
  const WS2 = "ws-host2";
  const before = countWsEvents(WS2);
  const regDown = parseTool(
    await client.callTool({
      name: "manage_workspace",
      arguments: { op: "register", project_id: PID, role: "coordinator", actor_id: "host-e2e", change_id: "change-host-down", workspace_id: WS2, kind: "candidate", purpose: "宿主已停", root: CAND2, source_kind: "directory" },
    }),
  );
  ok(regDown.ok !== true, "B. 宿主已停 ⇒ stdio MCP 写命令失败（SERVICE_UNAVAILABLE，不本地写）", regDown);
  ok(countWsEvents(WS2) === before, "B. 盘上没有该工作区的新事件（零字节写入）", { before, after: countWsEvents(WS2) });

  // ── H. remote F6：**非回环来源**读 /api/projects/:id/workspaces 时裁掉本机绝对路径 ──
  // 与 verify-s2 的真实 LAN 夹具同源（绑真局域网 IP + 临时口令，不用生产凭据）；宿主已停后再起一台远程模式宿主。
  section("H. remote F6（真实局域网地址）：workspaces 读口裁掉本机绝对路径");
  const LAN = firstLanIpv4();
  if (LAN === null) {
    console.log("[e2e] SKIP H 本机没有非内部 IPv4（浏览器/远程段按环境性 SKIP，不当 PASS）");
  } else {
    const remoteServer = spawn(process.execPath, [TSX, "src/server/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, TATAI_HOME: HOME, TATAI_NO_AUTOSTART: "1", TATAI_PORT: "0", TATAI_REMOTE: "1", TATAI_HOST: LAN },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(remoteServer);
    const rlog = fs.createWriteStream(path.join(HOME, "remote-server.log"));
    remoteServer.stdout?.pipe(rlog);
    remoteServer.stderr?.pipe(rlog);
    let rdesc = null as ReturnType<typeof readDescriptor>;
    for (let i = 0; i < 120; i += 1) {
      await sleep(500);
      const d = readDescriptor();
      if (d !== null && d.host === LAN && fs.existsSync(path.join(HOME, "remote", "auth.json"))) {
        rdesc = d;
        break;
      }
    }
    ok(rdesc !== null && rdesc.port > 0, `H. 远程宿主就绪（真绑局域网地址 ${LAN} + 口令文件已落盘）`, rdesc);
    if (rdesc !== null) {
      const token = (JSON.parse(fs.readFileSync(path.join(HOME, "remote", "auth.json"), "utf8")) as { token: string }).token;
      const noTok = await httpGetAt(LAN, rdesc.port, `/api/projects/${encodeURIComponent(PID)}/workspaces`);
      ok(noTok.status === 401, "H. 非回环来源无 token ⇒ 401（远程鉴权在位）", { status: noTok.status });
      const rws = await httpGetAt(LAN, rdesc.port, `/api/projects/${encodeURIComponent(PID)}/workspaces`, token);
      ok(rws.status === 200, "H. 非回环来源带 token 读 /workspaces ⇒ 200", { status: rws.status, body: rws.body.slice(0, 160) });
      const leaks = [HOME, PROJ, DEV].filter((p) => rws.body.includes(p));
      ok(leaks.length === 0, "H. remote F6：/workspaces 响应里零本机绝对路径（anchor/dev 目录都未外泄）", leaks);
      const parsed = JSON.parse(rws.body) as { workspaces?: { workspace_id?: string; root?: unknown }[] };
      ok(
        (parsed.workspaces ?? []).every((w) => w.root === undefined),
        "H. remote F6：每个工作区记录的绝对 `root` 字段被裁掉（不拿相对路径或其它绿冒充）",
        (parsed.workspaces ?? []).map((w) => ({ id: w.workspace_id, root: w.root })),
      );
    }
    if (remoteServer.pid !== undefined) killTree(remoteServer.pid);
    await sleep(1500);
  }

  try {
    await client.close();
  } catch {
    /* 收尾 */
  }
}

main()
  .catch((e) => {
    console.error(`[e2e] 异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    console.log(`\n[e2e] ═══ 汇总：PASS=${pass} FAIL=${fail} ═══`);
    if (fail > 0) process.exitCode = 1;
    cleanup();
    setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
  });
