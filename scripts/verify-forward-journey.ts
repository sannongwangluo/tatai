// V09-29 正向闭环**完整旅程**验证（PLAN V09-29；DESIGN.md §2.6/§2.9/§5.4/§5.6/§6.7；契约 F1–F5）。
//
// 口径（这一条是本脚本存在的理由）：**真 stdio MCP 子进程（SDK client）＋ 真 `src/server/index.ts`
// 桌面后端进程（动态端口、隔离 home）**。不是"调用 handler 冒充 stdio"，也不是"只调库当全链路通过"：
//   · 后端 = `spawn(node --import tsx src/server/index.ts)`，`TATAI_PORT=0` 由内核分配端口、隔离 `TATAI_HOME`；
//   · agent 侧 = `@modelcontextprotocol/sdk` 的 `Client` + `StdioClientTransport` 连 `src/mcp/index.ts`，
//     经标准输入输出真实握手、listTools、callTool；
//   · 工具写口经 `ctx.work` → 描述符 → 桌面宿主 `workHost`（唯一写入服务）落事件账本。
// 隔离：mkdtemp 夹具项目 + 隔离 home + 随机端口；不碰真实 ~/.tatai、真实项目/账本/8787；收尾清进程与临时目录。
//
// 覆盖旅程（契约 F5 逐段）：
//   0  工具面：真 stdio `tools/list` 能发现 **31** 个工具，schema 可调用（listTools 取到的 inputSchema 是对象）
//   1  无模型配置：现有两份图纸 → manage_baseline read（零副作用）
//   2  技术审定激活：manage_baseline activate（固定 delegated_technical_review，不写 Gate）
//   3  需求登记：manage_requirement register
//   4  变更批次：manage_change open（目标基线只引用哈希）
//   5  施工定义导入：import_plan_definitions（受检、悬空引用拒）
//   6  接续入口：project_entry（只读、给 claim_task 与 task_revision）
//   7  领取：claim_task（原子、expected_revision）
//   8  开工：report_task_status(doing)
//   9  阻塞：report_task_status(blocked)
//   10 协调器解阻：report_task_status(ready + readiness_basis)
//   11 重新领取（新 attempt，takeover_basis）
//   12 执行回执：report_execution start_requested/started/heartbeat/checkpoint（缺心跳≠停机）
//   13 提交：submit_task_result；**相同请求重试 → 原回执 duplicate=true**（不是 VERSION_CONFLICT）
//   14 证据/审计：record_work_evidence store（含 source_manifest）/ submission / self_check(fail) / independent_audit(fail)
//   15 返工重开：claim_task(op=reopen，协调器 + 可取回依据) → 新 attempt（旧 token 作废）
//   16 修复/复测：record_work_evidence fix → retest（pass 才关缺陷）
//   17 人工验收：夹具 HTTP POST /api/projects/:id/acceptance（**测试用户**模拟；真实 Gate 不写）
//   18 重启接续：断开旧 client → 起**新** MCP client → project_entry 读回现场
// 每一步检查回执/读口/事件数一致；反例/错误/不可用如实断言（不静默放过）。测试用户只在隔离夹具。
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addProject } from "../src/server/registry";
import { readClaimEvents } from "../src/server/work/claims";
import { readTaskStates } from "../src/server/work/tasks";
import { readBaselineLog } from "../src/server/work/documents";

// ── 断言 ──
let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount += 1;
  else {
    failCount += 1;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1800)}`);
  }
};
const info = (m: string): void => console.log(`[verify] ${m}`);
const sha256 = (d: string | Buffer): string => crypto.createHash("sha256").update(d).digest("hex");
const mkdirp = (d: string): void => { fs.mkdirSync(d, { recursive: true }); };
const write = (f: string, t: string): void => { mkdirp(path.dirname(f)); fs.writeFileSync(f, t, "utf8"); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── 隔离夹具 ──
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_ENTRY = path.join(ROOT, "src", "server", "index.ts");
const MCP_ENTRY = path.join(ROOT, "src", "mcp", "index.ts");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-forward-journey-"));
const HOME = path.join(tmpBase, "home");
const PROJECT = path.join(tmpBase, "proj-journey");
const PID = "forwardjourney";
const CHG = "change-journey";
const workDir = path.join(PROJECT, ".工作台", "work");
const DESIGN_REL = ".工作台/design.md";
const PLAN_REL = ".工作台/plan.md";

interface Card { id: string; goal: string; dep?: string; role: string }
const planText = (title: string, cards: Card[]): string => {
  const L = [`# ${title}`, "", "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |", "| --- | --- | --- | --- | --- |"];
  for (const c of cards) L.push(`| ${c.id} | todo | ${c.goal} | ${c.dep ?? ""} | ${c.id} 的完成证据 |`);
  L.push("");
  // 需求映射经正式工具参数导入：覆盖没有文内映射表的正常项目，不能靠补表绕过接续缺口。
  for (const c of cards) {
    L.push(
      `### ${c.id} ${c.goal}`,
      "",
      `**设计依据**：§1。**依赖**：${c.dep ?? "无"}。**文件责任**：\`src/${c.id.toLowerCase()}.ts\`。**责任角色**：${c.role}。`,
      "",
      `- [ ] ${c.goal} 达标`,
      "",
    );
  }
  return L.join("\n");
};
const PLAN_TEXT = planText("V09-29 正向闭环夹具施工图", [{ id: "T-1", goal: "夹具卡一", dep: "", role: "executor" }]);

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("TATAI_")) { delete env[k]; continue; }
    if (/API_?KEY|SECRET|PASSWORD|CREDENTIAL|ACCESS_KEY$/i.test(k)) delete env[k];
  }
  env.TATAI_HOME = HOME;
  env.TATAI_SEMANTIC_AUTO = "0"; // 无模型配置：不调网关、不做语义补全
  env.TATAI_SYNC_DISCOVERY = "0";
  env.TATAI_NO_AUTOSTART = "1"; // 桌面宿主自发布描述符；MCP 侧绝不另起 daemon
  return { ...env, ...extra };
}

// ── 桌面后端（真 index.ts）──
function startDesktop(): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", DESKTOP_ENTRY], {
    cwd: ROOT,
    env: cleanEnv({ TATAI_PORT: "0" }),
    windowsHide: true,
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

interface HttpResult { status: number; json: Record<string, unknown> }
function httpReq(host: string, port: number, method: string, p: string, body?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    let payload: string | undefined;
    if (body !== undefined) { payload = JSON.stringify(body); headers["content-type"] = "application/json"; }
    const req = http.request({ host, port, path: p, method, headers }, (res) => {
      let t = "";
      res.on("data", (c: Buffer) => (t += c.toString("utf8")));
      res.on("end", () => { let j: Record<string, unknown> = {}; try { j = JSON.parse(t) as Record<string, unknown>; } catch { j = { raw: t }; } resolve({ status: res.statusCode ?? 0, json: j }); });
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("http 超时")));
    req.end(payload);
  });
}

// ── MCP 客户端（真 stdio）──
interface CallOut { ok: boolean; text: string; json: Record<string, unknown> }
async function connectClient(name: string): Promise<Client> {
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", MCP_ENTRY], cwd: ROOT, env: cleanEnv() as Record<string, string> }));
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallOut> {
  const r = await client.callTool({ name, arguments: args });
  const content = (r.content as { type?: string; text?: string }[]) ?? [];
  const text = content.map((c) => c.text ?? "").join("\n");
  let json: Record<string, unknown> = {};
  try { const p = JSON.parse(text) as unknown; if (typeof p === "object" && p !== null) json = p as Record<string, unknown>; } catch { /* 非 JSON */ }
  return { ok: r.isError !== true, text, json };
}
const asObj = (j: unknown): Record<string, unknown> => (typeof j === "object" && j !== null ? (j as Record<string, unknown>) : {});

const revOf = (taskId: string): number => readTaskStates(workDir).states[taskId]?.revision ?? -1;
const statusOf = (taskId: string): string => readTaskStates(workDir).states[taskId]?.status ?? "<none>";
const evCount = (): number => { try { return readClaimEvents(workDir).length; } catch { return -1; } };
// 零写入按实际字节核对；只有文件数不变不足以排除已有证据被覆盖。
const evidenceBytesFingerprint = (): string => {
  const dir = path.join(workDir, "evidence");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  return sha256(JSON.stringify(files.map((name) => [name, sha256(fs.readFileSync(path.join(dir, name)))])));
};

async function main(): Promise<void> {
  info(`V09-29 正向闭环完整旅程（真 stdio MCP + 真 index.ts；${process.platform} · node ${process.version}）`);
  info(`  夹具 ${PROJECT}（隔离 TATAI_HOME=${HOME}）`);

  mkdirp(HOME);
  write(path.join(PROJECT, DESIGN_REL), "# 夹具设计书\n\n## 1 目标\n\n现有成套图纸零差异审定。\n");
  write(path.join(PROJECT, PLAN_REL), PLAN_TEXT);
  write(path.join(PROJECT, "src", "t-1.ts"), "export const t1 = 1;\n");
  addProject({ id: PID, name: "正向闭环夹具", path: PROJECT, kind: "backend" }, HOME);

  const child = startDesktop();
  const childLogs: string[] = [];
  child.stdout?.on("data", (d: Buffer) => childLogs.push(d.toString("utf8")));
  child.stderr?.on("data", (d: Buffer) => childLogs.push(d.toString("utf8")));

  let client: Client | null = null;
  try {
    const desc = await waitDescriptor(45_000);
    ok(desc !== null, "0-1 真 index.ts 桌面后端起并发布描述符（动态端口）", { desc, log: childLogs.join("").slice(-400) });
    if (desc === null) throw new Error("桌面后端未发布描述符");
    let health: HttpResult | null = null;
    for (let i = 0; i < 50; i++) {
      try { health = await httpReq(desc.host, desc.port, "GET", "/health"); if (health.status === 200) break; } catch { /* 未就绪 */ }
      await sleep(200);
    }
    ok(health?.status === 200, "0-2 桌面后端可探活（/health 200）", health);

    // ═══ 0. 工具面：真 stdio listTools ═══
    client = await connectClient("verify-forward-journey");
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    const expectedNames = [
      "manage_baseline", "report_execution", "record_work_evidence", "report_task_status",
      "project_entry", "claim_task", "submit_task_result", "manage_requirement", "manage_change",
      "import_plan_definitions", "read_design", "read_progress",
    ];
    // 2026-10-07 定向更新（五要素留档）：旧期望＝30｜依据＝本批 B2/V09-52 新增功能清单只读读口 feature_ledger
    //   （DESIGN §6.12；注册表 `src/mcp/tools/index.ts` 里逐字记「工具面 30 → 31」）并入后实有 31 个
    //   （真 stdio tools/list 逐个点名在场，见下一条 0-4）｜新期望＝31｜保留意图＝真 stdio 工具面必须与源码
    //   注册表同数，工具静默丢失要立刻红｜判据不放宽：仍是精确钉值，未放宽成「≥30」或「关键工具在即可」。
    //   （前一版 30 的五要素留档见 git 历史：旧期望 29 → preflight_task_result 并入 → 30。）
    ok(tools.length === 31, `0-3 stdio tools/list 发现 31 个工具（收到 ${tools.length}）`, names);
    ok(expectedNames.every((n) => names.includes(n)), "0-4 关键工具都在 stdio 工具面（含 V09-27/V09-28 新入口）", expectedNames.filter((n) => !names.includes(n)));
    ok(tools.every((t) => typeof t.inputSchema === "object" && (t.inputSchema as { type?: string }).type === "object"), "0-5 每个工具的 inputSchema 都是可调用的对象 schema");
    ok(names.every((n) => !/^write_|^delete_/.test(n)), "0-6 权限红线：工具面没有 write_/delete_ 直写口");

    // ═══ 1. 无模型配置 + read 零副作用 ═══
    const before = sha256(JSON.stringify(readTaskStates(workDir)));
    const mRead = await call(client, "manage_baseline", { project_id: PID, op: "read" });
    ok(mRead.ok && asObj(mRead.json).current_pair !== undefined, "1-1 manage_baseline read 读出两份源当前修订", mRead.text.slice(0, 300));
    ok(sha256(JSON.stringify(readTaskStates(workDir))) === before, "1-2 read 零副作用（项目事件投影未变）");
    const pair = asObj(mRead.json).current_pair as Record<string, string> | undefined;
    const expected = { design_content_sha256: pair?.design_content_sha256 ?? "", plan_content_sha256: pair?.plan_content_sha256 ?? "" };
    ok(/^[0-9a-f]{64}$/.test(expected.design_content_sha256) && /^[0-9a-f]{64}$/.test(expected.plan_content_sha256), "1-3 read 给出现行两源的 content_sha256（激活 expected 直接用）", pair);

    // ═══ 2. 技术审定激活 ═══
    const mAct = await call(client, "manage_baseline", { project_id: PID, op: "activate", role: "designer", approved_by: "gpt-6", approval_basis: "契约 F1 技术审定（夹具）", expected });
    ok(mAct.ok && asObj(mAct.json).view !== undefined, "2-1 manage_baseline activate 成功（工具入口经唯一宿主）", mAct.text.slice(0, 400));
    ok(readBaselineLog(PID, HOME).baselines.length === 1, "2-2 生效基线恰好 1 条");
    ok(!fs.existsSync(path.join(PROJECT, ".工作台", "gate.jsonl")), "2-3 激活不写用户 Gate（gate.jsonl 不存在）");
    const mAct2 = await call(client, "manage_baseline", { project_id: PID, op: "activate", role: "designer", approved_by: "gpt-6", approval_basis: "重复技术审定（夹具）", expected });
    ok(mAct2.ok && (asObj(asObj(mAct2.json).result).created === false), "2-4 重复技术审定幂等：created=false、不新增基线", mAct2.text.slice(0, 300));
    ok(readBaselineLog(PID, HOME).baselines.length === 1, "2-5 重复请求不滥增基线（仍 1 条）");

    // ═══ 3. 需求登记 ═══
    const mReq = await call(client, "manage_requirement", { op: "register", project_id: PID, role: "designer", change_id: CHG, requirement_id: "req-journey-1", source: { kind: "user", ref: "用户 2026-10-02 夹具指令" }, problem: "夹具需求：验证正向闭环", users: ["夹具用户"], success_scenarios: ["全链路走通"], exclusions: ["不做逆向"], priority: "高", status: "explicit" });
    ok(mReq.ok && asObj(mReq.json).requirement !== undefined, "3-1 manage_requirement register 成功", mReq.text.slice(0, 300));
    ok(asObj(asObj(mReq.json).requirement).requirement_id === "req-journey-1", "3-2 读回同一需求（稳定 id 不变）");

    // ═══ 4. 变更批次 ═══
    const mChg = await call(client, "manage_change", { op: "open", project_id: PID, role: "coordinator", change_batch_id: CHG, goal: "夹具正向闭环", authorized_scope: "仅夹具项目", target_baseline: { design_revision: expected.design_content_sha256, plan_revision: expected.plan_content_sha256 }, affected_subsystems: ["fixture"], exit_criteria: "全链路通过" });
    ok(mChg.ok && asObj(mChg.json).change_batch_id === CHG, "4-1 manage_change open 成功（目标基线只引用哈希）", mChg.text.slice(0, 300));

    // ═══ 5. 施工定义导入 ═══
    const mImp = await call(client, "import_plan_definitions", { project_id: PID, role: "coordinator", change_id: CHG, bind_change_id: CHG, requirement_ids: { "T-1": ["req-journey-1"] } });
    ok(mImp.ok && Array.isArray(asObj(mImp.json).imported) && (asObj(mImp.json).imported as unknown[]).length === 1, "5-1 import_plan_definitions 受检导入成功", mImp.text.slice(0, 300));
    ok(statusOf("T-1") === "preparing", "5-2 导入后 T-1 状态=preparing（可认领）", { status: statusOf("T-1") });

    // ═══ 6. 接续入口（只读）═══
    const evBeforeEntry = evCount();
    const entry = await call(client, "project_entry", { project_id: PID, role: "executor", client_capabilities: "continuable" });
    const entryJson = asObj(entry.json);
    const reasons = (entryJson.reasons as unknown[]) ?? [];
    const reasonCodes = reasons.map((r) => asObj(r).code);
    const claimReason = reasons.map((r) => asObj(r)).find((r) => r.code === "claimable");
    const taskRevision = claimReason?.task_revision;
    ok(entryJson.next_action === "claim_task", "6-1 project_entry 给出 next_action=claim_task", { next_action: entryJson.next_action, codes: reasonCodes });
    ok(evCount() === evBeforeEntry, "6-2 project_entry 只读（不认领、不写事件）");
    ok(typeof taskRevision === "number", "6-3 理由里带 task_revision（claim_task 的 expected_revision）", claimReason ?? reasonCodes);
    // 6-4/6-5（V09-53／D1 接通后）：**真宿主进程**（spawn 的 `src/server/index.ts` → 描述符 → `/api/work/entry`）
    // 的回包也带逐 check 工作包——不是本地另算、也不是 `unsupported_by_host`。`versions`/`source` 在场即证明
    // 这份入口来自宿主只读读口（本地回退路径不带这两项）。
    ok(
      entryJson.versions !== undefined && entryJson.source !== undefined,
      "6-4 这次 project_entry 走的是真宿主只读读口（versions/source 在场，非本地回退）",
      { versions: entryJson.versions !== undefined, source: entryJson.source !== undefined },
    );
    const hostWp = asObj(entryJson.work_package);
    ok(
      typeof hostWp.package_revision === "string" && hostWp.package_revision !== "" && Array.isArray(hostWp.checks) && hostWp.checks.length >= 1,
      "6-5 真宿主进程的只读入口**带回逐 check 工作包**（D1 全链：查询参数 → readJobs → 同一份现读快照）",
      { has: entryJson.work_package !== undefined, checks: (hostWp.checks as unknown[])?.length ?? null },
    );
    const wpChecks = (hostWp.checks as unknown[]) ?? [];
    ok(
      wpChecks.length >= 1 &&
        wpChecks.every((c) => {
          const o = asObj(c);
          const n = asObj(o.next_operation);
          return typeof n.tool === "string" && typeof n.operation === "string" && !(n.tool === "submit_task_result");
        }),
      "6-6 工作包逐项给的是**可执行**下一步（未开工不推 submit_task_result、不出现虚构操作）",
      wpChecks.map((c) => {
        const o = asObj(c);
        const n = asObj(o.next_operation);
        return `${o.check_id}:${String(n.tool)}.${String(n.operation)}`;
      }),
    );

    // ═══ 7. 领取 ═══
    const claim1 = await call(client, "claim_task", { project_id: PID, task_id: "T-1", role: "executor", change_id: CHG, expected_revision: taskRevision, owner_id: "agent-1", lease_ms: 1, workspace: path.join(PROJECT, ".工作台", "runs", "T-1", "manual1") });
    const claim1Json = asObj(asObj(claim1.json).claim);
    const token1 = String(claim1Json.claim_token ?? "");
    ok(claim1.ok && token1 !== "", "7-1 claim_task 认领成功并拿到 token", claim1.text.slice(0, 200));
    ok(statusOf("T-1") === "claimed", "7-2 认领后状态=claimed", { status: statusOf("T-1") });
    let rev = revOf("T-1");

    // ═══ 8-10. doing → blocked → coordinator ready ═══
    const doing = await call(client, "report_task_status", { project_id: PID, task_id: "T-1", status: "doing", expected_revision: rev, claim_token: token1, owner_id: "agent-1", role: "executor", change_id: CHG, request_id: "jz-doing-1" });
    ok(doing.ok && statusOf("T-1") === "executing", "8-1 v2 开工 doing → 执行中", { status: statusOf("T-1"), text: doing.text.slice(0, 220) });
    rev = revOf("T-1");

    const evBeforeRej = evCount();
    const badToken = await call(client, "report_task_status", { project_id: PID, task_id: "T-1", status: "blocked", reason: "x", expected_revision: rev, claim_token: "not-the-token", owner_id: "agent-1", role: "executor", change_id: CHG });
    ok(!badToken.ok, "8-2 错误 token 上报被拒（回执如实报错）", badToken.text.slice(0, 220));
    ok(evCount() === evBeforeRej, "8-3 反例零字节（事件数不变）");

    const blocked = await call(client, "report_task_status", { project_id: PID, task_id: "T-1", status: "blocked", reason: "等前置证据", expected_revision: rev, claim_token: token1, owner_id: "agent-1", role: "executor", change_id: CHG, request_id: "jz-blocked-1" });
    ok(blocked.ok && statusOf("T-1") === "blocked", "9-1 阻塞上报成功（task.blocked）", { status: statusOf("T-1"), text: blocked.text.slice(0, 220) });
    rev = revOf("T-1");

    const badReady = await call(client, "report_task_status", { project_id: PID, task_id: "T-1", status: "ready", expected_revision: rev, role: "executor", change_id: CHG, reason: "想解阻" });
    ok(!badReady.ok && /协调器/.test(badReady.text), "10-1 非协调器解阻被拒（协调器专用）", badReady.text.slice(0, 220));
    const ready = await call(client, "report_task_status", { project_id: PID, task_id: "T-1", status: "ready", expected_revision: rev, role: "coordinator", change_id: CHG, reason: "前置已补齐", readiness_basis: [DESIGN_REL], request_id: "jz-ready-1" });
    ok(ready.ok && statusOf("T-1") === "ready", "10-2 协调器有依据解阻成功 → ready", { status: statusOf("T-1"), text: ready.text.slice(0, 260) });
    rev = revOf("T-1");

    // ═══ 11. 重新领取（新 attempt）═══
    const claim2 = await call(client, "claim_task", { project_id: PID, task_id: "T-1", role: "executor", change_id: CHG, expected_revision: rev, owner_id: "agent-2", lease_ms: 1, takeover_basis: "旧认领租约已到期，隔离新工作目录并确认新 attempt", workspace: path.join(PROJECT, ".工作台", "runs", "T-1", "manual2") });
    const claim2Json = asObj(asObj(claim2.json).claim);
    const token2 = String(claim2Json.claim_token ?? "");
    ok(claim2.ok && token2 !== "" && token2 !== token1, "11-1 解阻后重新领取，新 token ≠ 旧 token", claim2.text.slice(0, 200));
    rev = revOf("T-1");
    const target = {
      project_id: PID,
      task_id: "T-1",
      run_id: String(claim2Json.run_id ?? ""),
      attempt_id: String(claim2Json.attempt_id ?? ""),
      workspace: String(claim2Json.workspace ?? ""),
      claim_token: token2,
      change_id: CHG,
      owner_id: "agent-2",
      role: "executor",
      client_id: "kimi-code",
    };

    // ═══ 12. 执行回执（缺心跳≠停机）═══
    const evBeforeExec = evCount();
    const sr = await call(client, "report_execution", { op: "start_requested", ...target, goal: "夹具执行", argv_digest: "d1", template_source: "tmpl", timeout_ms: 60000 });
    ok(sr.ok, "12-1 report_execution(start_requested) 回执", sr.text.slice(0, 200));
    const st = await call(client, "report_execution", { op: "started", ...target, client_version: "0.9", argv_digest: "d1", pid: 4321 });
    ok(st.ok, "12-2 report_execution(started) 回执", st.text.slice(0, 200));
    const hb = await call(client, "report_execution", { op: "heartbeat", ...target, note: "在改 t-1.ts" });
    ok(hb.ok, "12-3 report_execution(heartbeat) 回执", hb.text.slice(0, 200));
    const cp = await call(client, "report_execution", { op: "checkpoint", ...target, note: "改到一半", artifacts: ["src/t-1.ts"] });
    ok(cp.ok, "12-4 report_execution(checkpoint) 回执", cp.text.slice(0, 200));
    ok(evCount() > evBeforeExec, "12-5 执行回执真的落了事件账本");
    const entryRun = await call(client, "project_entry", { project_id: PID, role: "executor", client_capabilities: "continuable" });
    const run = ((asObj(entryRun.json).current_runs as unknown[]) ?? []).map((r) => asObj(r)).find((r) => r.task_id === "T-1");
    const site = asObj(run?.run_site);
    ok(site.observed === true && site.state !== "confirmed_stopped", "12-6 运行现场观测到且不把心跳/检查点读成停止", site);
    ok(asObj(site.last_checkpoint).note === "改到一半", "12-7 运行现场带出最后检查点内容", site.last_checkpoint);

    // ═══ 13. 提交 + 相同重试 ═══
    const evBeforeSubmit = evCount();
    const submitArgs = { project_id: PID, task_id: "T-1", role: "executor", owner_id: "agent-2", change_id: CHG, claim_token: token2, expected_revision: rev, ownership_basis: "旧认领租约已到期，已核实旧进程停止并隔离新工作目录", deliverables: ["夹具交付物"], evidence_refs: [DESIGN_REL], verification: [{ command: "pnpm test", exit_code: 0, output_ref: "fixture" }], untested: [], known_issues: [] };
    const submit1 = await call(client, "submit_task_result", submitArgs);
    ok(submit1.ok && statusOf("T-1") === "result_submitted", "13-1 submit_task_result 成功（result_submitted）", { status: statusOf("T-1"), text: submit1.text.slice(0, 240) });
    const importedHash = readClaimEvents(workDir).find((e) => e.type === "task.definition_imported")?.payload.definition_sha256;
    const resultHash = readClaimEvents(workDir).find((e) => e.type === "task.result_submitted")?.payload.definition_sha256;
    ok(typeof importedHash === "string" && resultHash === importedHash,
      "13-1b 工具参数导入的需求映射贯穿提交：结果回执仍绑定原施工定义，未丢失映射");
    const evAfterSubmit = evCount();
    const submit2 = await call(client, "submit_task_result", submitArgs);
    ok(submit2.ok && asObj(asObj(submit2.json).receipt).duplicate === true, "13-2 相同请求重试 → 拿回原回执 duplicate=true（不是 VERSION_CONFLICT）", submit2.text.slice(0, 300));
    ok(evCount() === evAfterSubmit, "13-3 重试无二次效果（事件数不变）", { before: evAfterSubmit, after: evCount() });
    const submitConflict = await call(client, "submit_task_result", { ...submitArgs, deliverables: ["改了内容"] });
    ok(!submitConflict.ok && /IDEMPOTENCY_CONFLICT/.test(submitConflict.text), "13-4 同键异内容 → IDEMPOTENCY_CONFLICT", submitConflict.text.slice(0, 240));
    info(`  （提交阶段事件：${evBeforeSubmit} → ${evAfterSubmit}）`);

    // ═══ 14. 证据/审计（含 source_manifest）═══
    const store = await call(client, "record_work_evidence", { op: "store", project_id: PID, role: "executor", kind: "self_check", content: "夹具自检原始输出\n", summary: "自检原始输出", binding: { revision_kind: "code", revision: "deadbeef" } });
    const evSha = String(asObj(asObj(store.json).evidence).sha256 ?? "");
    ok(store.ok && /^[0-9a-f]{64}$/.test(evSha), "14-1 store 证据正文（宿主不可变写入，内容寻址）", store.text.slice(0, 200));
    const readBack = await call(client, "record_work_evidence", { op: "read", project_id: PID, sha256: evSha });
    ok(readBack.ok && String(asObj(asObj(readBack.json).evidence).content ?? "").includes("夹具自检原始输出"), "14-2 read 读回同一份证据正文", readBack.text.slice(0, 160));

    // F4：源文件清单（有限、项目内、可取回）——登记时服务端现读算哈希
    const manStore = await call(client, "record_work_evidence", { op: "store", project_id: PID, role: "auditor", kind: "source_manifest", summary: "源清单：t-1.ts", binding: { revision_kind: "code", revision: "deadbeef" }, source_manifest: ["src/t-1.ts"] });
    const manBlob = asObj(asObj(manStore.json).evidence);
    ok(manStore.ok && asObj(manBlob.source_manifest).fingerprint !== undefined, "14-3 store source_manifest（有限源清单 + 内容哈希）", manStore.text.slice(0, 300));
    const manSha = String(manBlob.sha256 ?? "");
    ok(/^[0-9a-f]{64}$/.test(manSha), "14-4 源清单证据同样内容寻址", manSha.slice(0, 12));

    const sub = await call(client, "record_work_evidence", { op: "submission", project_id: PID, role: "executor", actor_id: "agent-2", change_id: CHG, record_id: "jz-sub-1", goal: "夹具成果", submitted_by: "agent-2", evidence_refs: [evSha], untested: [], known_issues: [] });
    ok(sub.ok, "14-5 submission 成果登记", sub.text.slice(0, 200));
    const selfFail = await call(client, "record_work_evidence", { op: "self_check", project_id: PID, role: "executor", actor_id: "agent-2", change_id: CHG, record_id: "jz-sc-1", checked_by: "agent-2", conclusion: "fail", binding: { revision_kind: "code", revision: "deadbeef" }, checks: [{ check_id: "c1", command: "pnpm test", exit_code: 1, evidence_sha256: evSha, verifies: "code" }] });
    ok(selfFail.ok, "14-6 作者自检 conclusion=fail 如实落账（失败不被吞）", selfFail.text.slice(0, 200));
    const coverage = [
      { area: "behavior_boundaries", status: "checked", basis: "边界用例" },
      { area: "data_concurrency", status: "checked", basis: "并发写" },
      { area: "interface_integration", status: "checked", basis: "工具入口" },
      { area: "failure_recovery", status: "checked", basis: "服务不可用" },
      { area: "trust_permission", status: "checked", basis: "越权反例" },
    ];
    // 写前校验（src/server/work/auditValidation.ts §失败独审）：conclusion=fail（或含 result=failed 的 check）**必须**
    // 引用 foldFindings 里的**在册 finding ID**，自由文本会被唯一写入服务在落盘前拒绝（零字节）。故按**真实流程**：
    // 先正式 open finding，再以其 id 登记失败审计——测试不改产品校验，只把夹具走成正式引用。
    const findOpen = await call(client, "record_work_evidence", { op: "finding", sub_op: "open", project_id: PID, role: "auditor", actor_id: "agent-3", change_id: CHG, severity: "user_visible_defect", source: "verify:forward-journey", expected: "t-1 边界通过", actual: "未通过", repro: "跑边界用例", evidence_sha256: evSha, object_id: "T-1" });
    const findingId = String(asObj(findOpen.json).finding_id ?? "");
    ok(findOpen.ok && findingId !== "", "14-7 缺陷 open（带复现+证据；失败独审的前置在册引用）", findOpen.text.slice(0, 240));

    // 负例（判据不放宽）：旧散文 findings 的失败独审**仍被**写前校验拒绝，且账本 / 证据库**零写入**。
    const evBeforeProse = sha256(fs.readFileSync(path.join(workDir, "events.jsonl")));
    const evFilesBeforeProse = evidenceBytesFingerprint();
    const auditProse = await call(client, "record_work_evidence", { op: "independent_audit", project_id: PID, role: "auditor", actor_id: "agent-3", change_id: CHG, record_id: "jz-au-prose", auditor: "agent-3", author_id: "agent-2", conclusion: "fail", coverage, findings: ["T-1 边界用例未过"], not_reported_scope: ["未跑性能"] });
    ok(!auditProse.ok && /EVENT_INVALID|finding 不存在/.test(auditProse.text), "14-8 负例：散文 findings 的失败独审被写前校验拒绝（不回落成自由文本）", auditProse.text.slice(0, 240));
    ok(sha256(fs.readFileSync(path.join(workDir, "events.jsonl"))) === evBeforeProse, "14-9 负例零字节：事件账本内容未改变");
    ok(evidenceBytesFingerprint() === evFilesBeforeProse, "14-10 负例零字节：证据库文件集合与内容均未改变");

    const auditFail = await call(client, "record_work_evidence", { op: "independent_audit", project_id: PID, role: "auditor", actor_id: "agent-3", change_id: CHG, record_id: "jz-au-1", auditor: "agent-3", author_id: "agent-2", conclusion: "fail", coverage, findings: [findingId], not_reported_scope: ["未跑性能"] });
    ok(auditFail.ok, "14-11 独立审计 conclusion=fail 落账（审计者≠作者；findings 引用在册 finding id）", auditFail.text.slice(0, 220));

    // ═══ 15. 返工重开（协调器）═══
    rev = revOf("T-1");
    const reopen = await call(client, "claim_task", { op: "reopen", project_id: PID, task_id: "T-1", role: "coordinator", change_id: CHG, expected_revision: rev, reason: "审计失败返工", reopen_basis: [evSha], request_id: "jz-reopen-1" });
    const reopenJson = asObj(asObj(reopen.json).reopen);
    ok(reopen.ok && reopenJson.attempt !== undefined, "15-1 claim_task(op=reopen) 协调器受控重开成功（新 attempt）", reopen.text.slice(0, 300));
    const reopenAttempt = Number(reopenJson.attempt ?? 0);
    ok(statusOf("T-1") === "ready", "15-2 重开后回到可认领态（ready）", { status: statusOf("T-1") });
    const badReopenRole = await call(client, "claim_task", { op: "reopen", project_id: PID, task_id: "T-1", role: "executor", change_id: CHG, reason: "越权重开", reopen_basis: [evSha] });
    ok(!badReopenRole.ok, "15-3 非协调器重开被拒", badReopenRole.text.slice(0, 220));

    // 修复 attempt：新领取 → 修复 → 复测
    rev = revOf("T-1");
    const claim3 = await call(client, "claim_task", { project_id: PID, task_id: "T-1", role: "executor", change_id: CHG, expected_revision: rev, owner_id: "agent-4", takeover_basis: "返工新 attempt，隔离新工作目录", workspace: path.join(PROJECT, ".工作台", "runs", "T-1", `att${reopenAttempt}`) });
    const claim3Json = asObj(asObj(claim3.json).claim);
    const token3 = String(claim3Json.claim_token ?? "");
    ok(claim3.ok && token3 !== "", "15-4 返工 attempt 可重新领取（新 token）", claim3.text.slice(0, 200));
    const fix = await call(client, "record_work_evidence", { op: "fix", project_id: PID, role: "executor", actor_id: "agent-4", change_id: CHG, record_id: "jz-fix-1", finding_id: findingId, fix_revision: "rev2", fixed_by: "agent-4", evidence_ref: evSha });
    ok(fix.ok, "16-1 修复记录（待复测，不自动关闭）", fix.text.slice(0, 200));
    const retest = await call(client, "record_work_evidence", { op: "retest", project_id: PID, role: "auditor", actor_id: "agent-3", change_id: CHG, record_id: "jz-rt-1", finding_id: findingId, retested_by: "agent-3", retest_evidence: evSha, result: "pass" });
    ok(retest.ok, "16-2 复测记录（pass 才关闭缺陷）", retest.text.slice(0, 200));

    // 返工 attempt 再交一次结果（新 attempt 的提交）
    rev = revOf("T-1");
    const submit3 = await call(client, "submit_task_result", { ...submitArgs, claim_token: token3, owner_id: "agent-4", expected_revision: rev, deliverables: ["返工后交付物"] });
    ok(submit3.ok && statusOf("T-1") === "result_submitted", "16-3 返工 attempt 提交结果成功", { status: statusOf("T-1"), text: submit3.text.slice(0, 240) });

    // ═══ 17. 夹具 HTTP 人工验收（测试用户；真实 Gate 不写）═══
    const acc = await httpReq(desc.host, desc.port, "POST", `/api/projects/${PID}/acceptance`, { decision: "accept", accepted_by: "fixture-user", task_id: "T-1", scenario_refs: ["夹具场景"], evidence_refs: [evSha], note: "夹具测试用户验收（非真实 Gate）" });
    ok(acc.status === 200 && asObj(acc.json).ok === true, "17-1 夹具 HTTP 人工验收成功（task 级 accept）", { status: acc.status, body: acc.json });
    const agentAcc = await call(client, "record_work_evidence", { op: "acceptance", project_id: PID, role: "user", change_id: CHG });
    ok(!agentAcc.ok, "17-2 Agent 工具不暴露人工验收（不代签用户 Gate）", agentAcc.text.slice(0, 200));

    // ═══ 18. 重启 / 新 MCP 客户端接续 ═══
    await client.close();
    client = null;
    const evBeforeRestart = evCount();
    client = await connectClient("verify-forward-journey-2");
    ok(evCount() === evBeforeRestart, "18-1 断开重连前后账本事件数一致（事实持久化，无内存态丢失）");
    const entry2 = await call(client, "project_entry", { project_id: PID, role: "executor", client_capabilities: "continuable" });
    ok(entry2.ok, "18-2 新客户端 project_entry 可用", entry2.text.slice(0, 240));
    const nextAction = asObj(entry2.json).next_action;
    ok(typeof nextAction === "string" && (["resume_task", "claim_task", "review_result", "await_role", "await_decision", "blocked", "complete"] as string[]).includes(nextAction), `18-3 下一动作在七值枚举内（收到 ${JSON.stringify(nextAction)}）`);
    // 现场如实：T-1 已提交结果 + 已有审计/缺陷 → 协调器视角应是 review_result（收件）
    const entryCoord = await call(client, "project_entry", { project_id: PID, role: "coordinator", client_capabilities: "coordination" });
    ok(asObj(entryCoord.json).next_action === "review_result", "18-4 协调器重启接续：已提交结果 → review_result（收件）", entryCoord.text.slice(0, 300));
    const entryRead = await call(client, "project_entry", { project_id: PID, role: "executor", client_capabilities: "read_only" });
    ok(asObj(entryRead.json).next_action !== "claim_task", "18-5 只读客户端不派写任务（能力闸门）", { next: asObj(entryRead.json).next_action });
  } finally {
    if (client !== null) { try { await client.close(); } catch { /* 已关 */ } }
    try { child.kill(); } catch { /* 已退出 */ }
    await sleep(300);
    if (process.env.TATAI_KEEP_TMP === "1") {
      info(`保留现场：${tmpBase}`);
    } else {
      try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* 清理尽力而为 */ }
    }
    info(`汇总：${passCount} PASS / ${failCount} FAIL`);
  }
}

main().catch((e: unknown) => {
  console.error(`[verify] 异常终止：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
