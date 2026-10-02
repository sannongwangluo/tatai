// V09-28 验证脚本（PLAN.md V09-28；DESIGN.md §2.9/§6.7；docs/forward-progress-contract.md F1）。
// 用法：pnpm verify:forward-baseline（或 node --import tsx scripts/verify-forward-baseline.ts）。
//
// 自带隔离环境：临时 `TATAI_HOME` + `os.tmpdir()` 下的夹具项目；**不碰**任何真实项目的 `.工作台/`、
// 不接网关、不调模型（子进程与父进程都设 `TATAI_SEMANTIC_AUTO=0`、`TATAI_SYNC_DISCOVERY=0`）。
// 收尾清临时目录与子进程（`TATAI_KEEP_TMP=1` 保留现场）。
//
// 覆盖（PLAN V09-28 验收口径逐条落到断言）：
//   0）红例：**桌面宿主精确转发这条 work 面**（V09-29 集成后 `/api/work/baseline/*` 两路都转发，
//      不再落 404），错方法/尾缀/无令牌仍不命中或被拒；daemon 与桌面宿主同一条 handle 委派链。
//   1）工具入口红例：未知 op / 错误角色 / user_confirmation / 缺依据 / 缺 expected / 缺 kind 一律拒。
//   2）读零副作用：无宿主时 `manage_baseline op=read` 可用，且**项目目录逐文件哈希不变、home 里不出现描述符**。
//   3）daemon 场景（唯一宿主＝独立写服务）：初次激活、零差异重复不滥增、preserve、读回一致。
//   4）源变：改 plan.md 后用旧 expected 激活 → VERSION_CONFLICT；用新 expected → 新基线 + supersedes。
//   5）app 场景（唯一宿主＝桌面后端）：桌面宿主**直连** work 面（V09-29 起精确转发）+ 服务端强校验；
//      直挂 `/documents/*` 仍可用作老宿主回退落点。
//   6）激活不写 Gate、不自动领取：`gate.jsonl` 不出现、`events.jsonl` 不出现（本卡只动基线）。
//
// 判据分层：本脚本是**工具入口 + 真宿主路由**的行为验证（经 `manageBaselineTool.handler` 与真
// HTTP 子进程），不是纯库测试。**stdio MCP 传输层**的端到端旅程见 `scripts/verify-forward-journey.ts`。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { manageBaselineTool } from "../src/mcp/tools/manageBaseline";
import { readBaselineView } from "../src/server/work/baselineHost";
import { addProject } from "../src/server/registry";
import { readBaselineLog } from "../src/server/work/documents";
import { WorkServiceClient, WORK_TOKEN_HEADER } from "../src/server/work/service";
import type { McpContext, ToolResult } from "../src/mcp/tools/types";

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount += 1;
  else {
    failCount += 1;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1600)}`);
  }
};
const info = (m: string): void => console.log(`[verify] ${m}`);
const sha256 = (d: string | Buffer): string => crypto.createHash("sha256").update(d).digest("hex");
const mkdirp = (d: string): void => { fs.mkdirSync(d, { recursive: true }); };
const write = (f: string, t: string): void => { mkdirp(path.dirname(f)); fs.writeFileSync(f, t, "utf8"); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_ENTRY = path.join(ROOT, "src", "server", "index.ts");
const DAEMON_ENTRY = path.join(ROOT, "src", "server", "work", "daemon.ts");

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-forward-baseline-"));
const HOME = path.join(tmpBase, "home");
const PROJECT = path.join(tmpBase, "proj-forward");
const PID = "forwardbase";

const DESIGN_V1 = "# 夹具设计书\n\n## 1 目标\n\n已有成套设计书与施工图，零差异激活。\n";
function planDoc(rows: readonly string[]): string {
  return [
    "# 夹具施工图",
    "",
    "## 当前任务",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
const PLAN_V1 = planDoc([
  "| T-1 | todo | 打地基 |  | 现场照片 |",
  "| T-2 | todo | 砌墙 | T-1 | 验收清单 |",
]);

/** 项目目录逐文件哈希（证明"读"不写一个字节） */
function dirFingerprint(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else entries.push(`${path.relative(root, abs).split(path.sep).join("/")} ${sha256(fs.readFileSync(abs))}`);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return sha256(entries.join("\n"));
}

async function callTool(args: Record<string, unknown>, ctx?: McpContext): Promise<{ isError: boolean; text: string; json: Record<string, unknown> | null }> {
  const res: ToolResult = await Promise.resolve(manageBaselineTool.handler(args, ctx));
  const text = res.content.map((c) => c.text).join("\n");
  let json: Record<string, unknown> | null = null;
  if (!res.isError) {
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
  }
  return { isError: res.isError === true, text, json };
}

interface HttpResult { status: number; json: Record<string, unknown> }
function httpReq(host: string, port: number, method: string, p: string, opts: { token?: string; body?: unknown } = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.token !== undefined) headers[WORK_TOKEN_HEADER] = opts.token;
    let payload: string | undefined;
    if (opts.body !== undefined) { payload = JSON.stringify(opts.body); headers["content-type"] = "application/json"; }
    const req = http.request({ host, port, path: p, method, headers }, (res) => {
      let t = "";
      res.on("data", (c: Buffer) => (t += c.toString("utf8")));
      res.on("end", () => { let j: Record<string, unknown> = {}; try { j = JSON.parse(t) as Record<string, unknown>; } catch { j = { raw: t }; } resolve({ status: res.statusCode ?? 0, json: j }); });
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("http 超时")));
    req.end(payload);
  });
}

function descriptorOf(): { host: string; port: number; token: string; pid: number } | null {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(HOME, "work-service.json"), "utf8")) as { host?: unknown; port?: unknown; token?: unknown; pid?: unknown };
    if (typeof d.port !== "number" || typeof d.host !== "string" || typeof d.token !== "string" || typeof d.pid !== "number") return null;
    return { host: d.host, port: d.port, token: d.token, pid: d.pid };
  } catch { return null; }
}
async function waitDescriptor(timeoutMs: number): Promise<{ host: string; port: number; token: string; pid: number } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = descriptorOf();
    if (d !== null) return d;
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}
async function waitDescriptorGone(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (descriptorOf() === null) return true;
    await sleep(150);
  }
  return descriptorOf() === null;
}

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("TATAI_")) { delete env[k]; continue; }
    if (/API_?KEY|SECRET|PASSWORD|CREDENTIAL|ACCESS_KEY$/i.test(k)) delete env[k];
  }
  env.TATAI_HOME = HOME;
  env.TATAI_SEMANTIC_AUTO = "0";
  env.TATAI_SYNC_DISCOVERY = "0";
  return { ...env, ...extra };
}

async function main(): Promise<void> {
  info(`正向基线入口 · V09-28 行为验证（${process.platform} · node ${process.version}）`);
  info(`  夹具 ${PROJECT}（隔离 TATAI_HOME=${HOME}）`);

  // ── 夹具项目 + 隔离 home ──
  mkdirp(HOME);
  write(path.join(PROJECT, ".工作台", "design.md"), DESIGN_V1);
  write(path.join(PROJECT, ".工作台", "plan.md"), PLAN_V1);
  addProject({ id: PID, name: "正向基线夹具", path: PROJECT, kind: "backend" }, HOME);
  process.env.TATAI_HOME = HOME; // 工具入口内的 resolveDataDir() 读它

  const client = new WorkServiceClient({ dataDir: HOME, timeoutMs: 4000 });
  const ctxWith = (): McpContext => ({ work: client, clientName: "verify-forward-baseline" });

  let child: ChildProcess | null = null;
  const childLogs: string[] = [];
  const startChild = (entry: string, extraEnv: Record<string, string> = {}): ChildProcess => {
    const c = spawn(process.execPath, ["--import", "tsx", entry], { cwd: ROOT, env: cleanEnv(extraEnv), windowsHide: true });
    c.stdout?.on("data", (d: Buffer) => childLogs.push(d.toString("utf8")));
    c.stderr?.on("data", (d: Buffer) => childLogs.push(d.toString("utf8")));
    return c;
  };
  const stopChild = async (c: ChildProcess): Promise<void> => {
    try { c.kill(); } catch { /* 已退出 */ }
    await sleep(300);
  };

  try {
    // ═══ 0）读零副作用（无宿主在场）═══
    const beforeRead = dirFingerprint(PROJECT);
    const noHostBefore = fs.existsSync(path.join(HOME, "work-service.json"));
    const read0 = await callTool({ project_id: PID, op: "read" });
    ok(!read0.isError && read0.json !== null, "0-1 op=read 只读可用（无宿主在场也能读）", { text: read0.text.slice(0, 300) });
    ok(dirFingerprint(PROJECT) === beforeRead && !fs.existsSync(path.join(HOME, "work-service.json")) && !noHostBefore,
      "0-2 op=read 零副作用：项目目录逐文件哈希不变、home 里不出现服务描述符（没起宿主）");
    const read0json = read0.json as { design?: { exists?: boolean }; plan?: { exists?: boolean }; baseline?: { count?: number }; current_pair?: { design_content_sha256?: string; plan_content_sha256?: string } } | null;
    ok(read0json?.design?.exists === true && read0json?.plan?.exists === true && read0json?.baseline?.count === 0,
      "0-3 op=read 如实报两源在场、尚无生效基线");
    const readExpected = {
      design_content_sha256: read0json?.current_pair?.design_content_sha256 ?? "",
      plan_content_sha256: read0json?.current_pair?.plan_content_sha256 ?? "",
    };

    // ═══ 1）工具入口红例（纯校验，不需要宿主）═══
    const rUnknownOp = await callTool({ project_id: PID, op: "explode" });
    ok(rUnknownOp.isError, "1-1 未知 op 拒", { text: rUnknownOp.text.slice(0, 200) });
    const rBadRole = await callTool({ project_id: PID, op: "activate", role: "executor", approved_by: "codex", approval_basis: "x", expected: readExpected }, ctxWith());
    ok(rBadRole.isError && /设计|协调|designer|coordinator/.test(rBadRole.text), "1-2 错误角色（executor）拒写", { text: rBadRole.text.slice(0, 240) });
    const rUserConfirm = await callTool({ project_id: PID, op: "activate", role: "designer", approved_by: "user", approval_basis: "x", expected: readExpected, approval_kind: "user_confirmed" }, ctxWith());
    ok(rUserConfirm.isError && /delegated_technical_review|user_confirmation/.test(rUserConfirm.text), "1-3 MCP 不支持 user_confirmation（固定技术审定）", { text: rUserConfirm.text.slice(0, 240) });
    const rNoBasis = await callTool({ project_id: PID, op: "activate", role: "designer", approved_by: "codex", approval_basis: "  ", expected: readExpected }, ctxWith());
    ok(rNoBasis.isError && /依据/.test(rNoBasis.text), "1-4 缺审定依据拒", { text: rNoBasis.text.slice(0, 200) });
    const rNoExpected = await callTool({ project_id: PID, op: "activate", role: "designer", approved_by: "codex", approval_basis: "依据" }, ctxWith());
    ok(rNoExpected.isError && /expected/.test(rNoExpected.text), "1-5 缺 expected（两份源哈希）拒", { text: rNoExpected.text.slice(0, 200) });
    const rNoKind = await callTool({ project_id: PID, op: "preserve", role: "designer" }, ctxWith());
    ok(rNoKind.isError && /kind/.test(rNoKind.text), "1-6 op=preserve 缺 kind 拒", { text: rNoKind.text.slice(0, 200) });
    ok(dirFingerprint(PROJECT) === beforeRead, "1-7 上述红例零写入（项目目录哈希不变）");

    // ═══ 2）daemon 场景（唯一宿主＝独立写服务）═══
    info("— 阶段 2：daemon 唯一宿主 —");
    child = startChild(DAEMON_ENTRY);
    const daemon = await waitDescriptor(40_000);
    ok(daemon !== null && daemon.pid === child.pid, "2-1 独立 daemon 发布描述符（属本进程）", { daemon, pid: child.pid, log: childLogs.join("").slice(-400) });
    if (daemon === null) throw new Error("daemon 未发布描述符");

    // 2-2 新 work 路由在 daemon 存在（带令牌 200、无令牌 401）
    const daemonWorkNoTok = await httpReq(daemon.host, daemon.port, "POST", "/api/work/baseline/activate", { body: { project_id: PID } });
    ok(daemonWorkNoTok.status === 401, "2-2 daemon 的新基线路由要描述符令牌（无令牌 401）", { status: daemonWorkNoTok.status });

    // 2-3 初次激活（零差异）
    const act1 = await callTool({ project_id: PID, op: "activate", role: "designer", approved_by: "codex", approval_basis: "契约 F1 技术审定（夹具）", expected: readExpected }, ctxWith());
    ok(!act1.isError && (act1.json?.result as { created?: boolean } | undefined)?.created === true, "2-3 初次激活成功且 created=true", { text: act1.text.slice(0, 400) });
    const log1 = readBaselineLog(PID, HOME);
    ok(log1.baselines.length === 1 && log1.corrupt.length === 0, "2-4 生效基线恰好 1 条（零差异也建第一条）", { count: log1.baselines.length });

    // 2-5 重复激活（零差异）不滥增
    const act2 = await callTool({ project_id: PID, op: "activate", role: "coordinator", approved_by: "codex", approval_basis: "重复请求（夹具）", expected: readExpected }, ctxWith());
    ok(!act2.isError && (act2.json?.result as { created?: boolean } | undefined)?.created === false, "2-5 重复激活幂等：created=false", { text: act2.text.slice(0, 300) });
    ok(readBaselineLog(PID, HOME).baselines.length === 1, "2-6 重复请求不新增基线（仍 1 条）");

    // 2-7 preserve 一份
    const pres = await callTool({ project_id: PID, op: "preserve", role: "designer", kind: "design" }, ctxWith());
    const presResult = pres.json?.result as { recovery?: { ref?: string } } | undefined;
    ok(!pres.isError && typeof presResult?.recovery?.ref === "string", "2-7 op=preserve 保存设计书不可变历史", { text: pres.text.slice(0, 300) });
    ok(fs.existsSync(path.join(PROJECT, presResult?.recovery?.ref ?? "__none__")), "2-8 preserve 的不可变副本真的落盘");

    // 2-9 读回一致
    const readAfter = await callTool({ project_id: PID, op: "read" });
    const raJson = readAfter.json as { baseline?: { active?: { baseline_id?: string } }; active_matches_current?: boolean } | null;
    ok(raJson?.active_matches_current === true && raJson?.baseline?.active?.baseline_id === log1.baselines[0].baseline_id,
      "2-9 读回：生效基线正好指向当前两源");

    // 2-10 源变 → 旧 expected 冲突、新 expected 成功
    write(path.join(PROJECT, ".工作台", "plan.md"), planDoc([
      "| T-1 | todo | 打地基 |  | 现场照片 |",
      "| T-2 | todo | 砌墙 | T-1 | 验收清单 |",
      "| T-3 | todo | 上梁 | T-2 | 现场照片 |",
    ]));
    const actStale = await callTool({ project_id: PID, op: "activate", role: "designer", approved_by: "codex", approval_basis: "旧草稿（夹具）", expected: readExpected }, ctxWith());
    ok(actStale.isError && /VERSION_CONFLICT|源在审定中改变|冲突/.test(actStale.text), "2-10 源已变：旧 expected 激活被拒（VERSION_CONFLICT）", { text: actStale.text.slice(0, 300) });
    const readDrift = await callTool({ project_id: PID, op: "read" });
    const driftJson = readDrift.json as { active_matches_current?: boolean; current_pair?: { design_content_sha256?: string; plan_content_sha256?: string } } | null;
    ok(driftJson?.active_matches_current === false, "2-11 源变后 read 如实标 active_matches_current=false");
    const actNew = await callTool({ project_id: PID, op: "activate", role: "designer", approved_by: "codex", approval_basis: "新草稿技术审定（夹具）", expected: { design_content_sha256: driftJson?.current_pair?.design_content_sha256 ?? "", plan_content_sha256: driftJson?.current_pair?.plan_content_sha256 ?? "" } }, ctxWith());
    ok(!actNew.isError && (actNew.json?.result as { created?: boolean } | undefined)?.created === true && readBaselineLog(PID, HOME).baselines.length === 2, "2-12 新 expected 激活成功：新基线 1 条、旧基线保留（共 2）");

    // 2-13 激活不写 Gate / 不写事件账本
    ok(
      !fs.existsSync(path.join(PROJECT, ".工作台", "gate.jsonl")) &&
        !fs.existsSync(path.join(PROJECT, ".工作台", "work", "events.jsonl")),
      "2-13 激活不写用户 Gate、不写事件账本（本卡只动 baselines.jsonl / 不可变副本）",
    );

    // 收尾 daemon
    await httpReq(daemon.host, daemon.port, "POST", "/api/work/admin/shutdown", { token: daemon.token });
    await waitDescriptorGone(6000);
    await stopChild(child);
    child = null;

    // ═══ 3）app 场景（唯一宿主＝桌面后端；V09-29 起**精确转发** work 面）═══
    info("— 阶段 3：桌面后端唯一宿主（直连 work 面 + 直挂回退仍在）—");
    child = startChild(DESKTOP_ENTRY, { TATAI_PORT: "0" });
    const app = await waitDescriptor(45_000);
    ok(app !== null && app.pid === child.pid, "3-1 桌面源进程（src/server/index.ts）发布描述符（属本进程）", { app, pid: child.pid, log: childLogs.join("").slice(-400) });
    if (app === null) throw new Error("桌面源进程未发布描述符");
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { up = (await httpReq(app.host, app.port, "GET", "/health")).status === 200; } catch { /* 未就绪 */ }
      if (!up) await sleep(200);
    }
    ok(up, "3-2 桌面源进程可探活（/health 200）");

    // 3-3 边界（V09-29 集成）：桌面宿主**精确转发**这条 work 面，但不是整段透传——
    //   无令牌 401、带令牌缺 expected 400（服务端强校验，工具不是唯一防线）、错方法/尾缀 404。
    const appNoTok = await httpReq(app.host, app.port, "POST", "/api/work/baseline/activate", { body: { project_id: PID } });
    ok(appNoTok.status === 401, "3-3a 桌面宿主转发的基线路由要描述符令牌（无令牌 401）", { status: appNoTok.status });
    const appNoExpected = await httpReq(app.host, app.port, "POST", "/api/work/baseline/activate", {
      token: app.token,
      body: { project_id: PID, approved_by: "gpt-6", approval_basis: "缺 expected（夹具）", approval_kind: "delegated_technical_review" },
    });
    ok(appNoExpected.status === 400 && /expected/.test(JSON.stringify(appNoExpected.json)), "3-3b 桌面宿主直连也必须带 expected：缺两份源哈希 400（服务端强校验）", { status: appNoExpected.status, body: appNoExpected.json });
    const appWrongMethod = await httpReq(app.host, app.port, "GET", "/api/work/baseline/activate", { token: app.token });
    ok(appWrongMethod.status === 404, "3-3c 错方法（GET /activate）不命中精确转发（404）", { status: appWrongMethod.status });
    const appSuffix = await httpReq(app.host, app.port, "POST", "/api/work/baseline/activate/extra", { token: app.token, body: { project_id: PID } });
    ok(appSuffix.status === 404, "3-3d 尾缀 /activate/extra 不命中（404，不是整段透传）", { status: appSuffix.status });

    // 3-3e 带令牌 + 合法 expected → 200（证明桌面宿主确实转发了该 work 面；V09-29 前这里恒为 404）
    const readAppPre = await callTool({ project_id: PID, op: "read" });
    const prePair = (readAppPre.json as { current_pair?: { design_content_sha256?: string; plan_content_sha256?: string } } | null)?.current_pair ?? {};
    const countBeforeDirect = readBaselineLog(PID, HOME).baselines.length;
    const appDirectWork = await httpReq(app.host, app.port, "POST", "/api/work/baseline/activate", {
      token: app.token,
      body: {
        project_id: PID,
        approved_by: "gpt-6",
        approval_basis: "桌面宿主直连 work 面（夹具）",
        approval_kind: "delegated_technical_review",
        expected: { design_content_sha256: prePair.design_content_sha256, plan_content_sha256: prePair.plan_content_sha256 },
      },
    });
    ok(appDirectWork.status === 200 && (appDirectWork.json as { ok?: boolean }).ok === true, "3-3e 桌面宿主带令牌+合法 expected 直连 200（不再 404）", { status: appDirectWork.status, body: appDirectWork.json });
    ok(readBaselineLog(PID, HOME).baselines.length === countBeforeDirect, "3-3f 直连激活同两份源不滥增基线（内容寻址幂等）");

    // 3-4 直挂路由在桌面宿主仍存在（老宿主 / 无 work 转发的回退落点）
    const appDirect = await httpReq(app.host, app.port, "POST", `/api/projects/${PID}/documents/preserve`, { body: { kind: "plan" } });
    ok(appDirect.status === 200 && (appDirect.json as { ok?: boolean }).ok === true, "3-4 直挂的 /api/projects/:id/documents/* 在桌面宿主可用（回退落点）", { status: appDirect.status });

    // 3-5 工具入口经桌面宿主（转发的 work 路由）成功激活
    const countBeforeApp = readBaselineLog(PID, HOME).baselines.length;
    // 让两源再变一次，产生一条**新**基线（证明这次激活真的经桌面宿主写成）
    write(path.join(PROJECT, ".工作台", "design.md"), `${DESIGN_V1}\n## 2 追加\n\n又改了一处。\n`);
    const readApp2 = await callTool({ project_id: PID, op: "read" });
    const pair2 = (readApp2.json as { current_pair?: { design_content_sha256?: string; plan_content_sha256?: string } } | null)?.current_pair ?? {};
    const actApp = await callTool({ project_id: PID, op: "activate", role: "designer", approved_by: "gpt-6", approval_basis: "桌面宿主技术审定（夹具）", expected: { design_content_sha256: pair2.design_content_sha256 ?? "", plan_content_sha256: pair2.plan_content_sha256 ?? "" } }, ctxWith());
    ok(!actApp.isError && (actApp.json?.result as { created?: boolean } | undefined)?.created === true, "3-5 工具入口经桌面宿主激活成功（created=true）", { text: actApp.text.slice(0, 400), prePair, pair2 });
    ok(readBaselineLog(PID, HOME).baselines.length === countBeforeApp + 1, "3-6 桌面宿主激活确实新增基线", { before: countBeforeApp, after: readBaselineLog(PID, HOME).baselines.length });

    // 3-7 桌面宿主下 preserve 也走同一条转发
    const presApp = await callTool({ project_id: PID, op: "preserve", role: "coordinator", kind: "plan" }, ctxWith());
    ok(!presApp.isError && typeof (presApp.json?.result as { recovery?: { ref?: string } } | undefined)?.recovery?.ref === "string", "3-7 桌面宿主下 op=preserve 经转发的 work 路由成功", { text: presApp.text.slice(0, 300) });

    await stopChild(child);
    child = null;

    info(`汇总：${passCount} PASS / ${failCount} FAIL`);
  } finally {
    if (child !== null) await stopChild(child);
    if (process.env.TATAI_KEEP_TMP === "1") {
      info(`保留现场：${tmpBase}`);
    } else {
      try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
    }
  }
}

main().catch((e: unknown) => {
  console.error(`[verify] 异常终止：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
