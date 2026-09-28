// B3 验证脚本（用 tsx 跑）：逆向落稿——起草雏形 + Gate 推断 + 定版入口 + 对账钩子。
// 用法：pnpm verify:b3（真调 Flash API + 真走记忆检索 MCP，需 DEEPSEEK_API_KEY）
// 覆盖点（对应 B3 卡 DoD 逐条）：
//   ① 对真实老项目（id 由 TATAI_ID_REVERSE 给，缺省 brain-memory；其 .工作台 无 design.md）真跑一次 draft：
//      产出含"项目是什么 / 模块划分 / 当前实际阶段 / Gate 标在哪一步"四块的雏形稿（贴片段），
//      落 .工作台/design.draft.md（草稿不是 design.md）；
//   ② Gate 位置是推断初值：草稿返回 inferred_gate_step 与三路推断依据（git/文件/README）；
//   ③ 定版只能由人触发：finalize 用推断值作为"人确认值"真跑 → design.md 真实生成 +
//      progress.json current_step 正确 + gate.jsonl 留痕（by:"user" note"逆向落稿定版"）；
//   ④ 对账钩子：.工作台/arch/reconcile-request.json 真实落盘（trigger:"reverse-draft-finalize"，
//      A5 消费此钩子——A5 未开工，本卡只留钩子并贴联动证据）；
//   ⑤ DoD⑤：已有 design.md 的临时项目 → draft 返回 conflict 不覆盖（文件内容逐字节不变）；
//   ⑥ 无草稿直接 finalize → HTTP 400 INVALID_INPUT；
//   ⑦ HTTP 全链路：POST design/draft（无 session_id → B3 分流）conflict 项目返回 200+conflict。
// 备注：
//   · 记忆检索 server 冷启动加载精排模型远超 15s（verify-b2 同口径），真实起草放宽记忆检索超时；
//   · 该项目的 .gitignore 若缺 `.工作台/` 行（R2 已探明）——按 §8.2 在流水再提示一次，不替它改；
//   · 本脚本对它是【真实定版】：跑完后该项目 .工作台 里有 design.md，
//     重复跑会按 DoD⑤ 走 conflict 分支（属预期，不是脚本错误）。
//   · 真实项目段要跑：设 TATAI_HOME=<已登记该项目的全局数据目录>、
//     TATAI_ID_REVERSE=<项目 id>、DEEPSEEK_API_KEY；缺哪个就 SKIP，不当 PASS。
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { draftDesign, finalizeDraft, readReverseDraft } from "../src/server/reverseDraft";
import { readDesign, readGateLines, readProgress } from "../src/server/workstation";
import { addProject, getProject } from "../src/server/registry";
import { finish, realHome, skip } from "./lib/fixtures";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8795;
const BASE = `http://localhost:${PORT}`;
const MEMORY_TIMEOUT_MS = 180_000; // 真实检索：冷启动模型加载放宽到 3 分钟（verify-b2 同口径）
const BRAIN_ID = process.env.TATAI_ID_REVERSE ?? "brain-memory";
// 真实全局数据目录：TATAI_HOME > 缺省 ~/.tatai（不写死作者本机路径）。
// 真实起草/定版必须读真实注册表（该项目得先登记在这个数据目录里）。
const REAL_DATA_DIR = realHome();

const ok = (cond: boolean, label: string) => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) process.exitCode = 1;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUp(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        upPorts.add(PORT);
        return;
      }
    } catch {
      // 还没起来，继续等
    }
    await sleep(200);
  }
  throw new Error("后端 20 秒内未就绪");
}

// ── 端口冲突快速失败（2026-09-18 加）────────────────────────────────
// 端口被残留服务 / 并行会话占用时，子进程 EADDRINUSE 会静默死掉，而 waitUp 会打到占用者身上，
// 导致后续莫名 404 崩溃或对错误数据假通过。这里：起前探端口 → 起后盯早退。
const upPorts = new Set<number>();

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (busy: boolean) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once("connect", () => done(true)); // 有人监听 = 端口被占
    sock.once("error", () => done(false)); // 拒绝连接 = 端口空闲
    sock.setTimeout(1000, () => done(false));
  });
}

/** 起前预探测：端口已被占用立刻报错退出，不拿别人的服务跑验证 */
async function assertPortFree(port: number): Promise<void> {
  if (await portListening(port)) {
    console.error(`[verify] 后端起不来：端口 ${port} 被占用，先清理残留进程`);
    process.exit(1);
  }
}

/** 起后盯早退：子进程在就绪前退出（典型 EADDRINUSE）立即报错退出，不再继续验证 */
function watchChild(proc: ChildProcess, port: number, isUp: () => boolean): void {
  proc.once("exit", async (code) => {
    if (isUp()) return; // 脚本自己收尾杀的，不算异常
    const why = (await portListening(port))
      ? `端口 ${port} 被占用`
      : `后端进程提前退出（code=${code}）`;
    console.error(`[verify] 后端起不来：${why}，先清理残留进程`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  // ── 前置：确认该项目登记在册 + §8.2 gitignore 提示（R2 已探明，只提示不改）──
  const brain = getProject(BRAIN_ID, REAL_DATA_DIR);
  if (!brain) {
    skip(
      `①② 真实起草（${BRAIN_ID}）`,
      `注册表里没有 ${BRAIN_ID}：设 TATAI_HOME=<已登记该项目的数据目录> 与 TATAI_ID_REVERSE=<项目 id> 后可跑`,
    );
    return;
  }
  const giFile = path.join(brain.path, ".gitignore");
  const giText = fs.existsSync(giFile) ? fs.readFileSync(giFile, "utf8") : "";
  const hasWorkbenchIgnore = giText.split(/\r?\n/).some((l) => l.trim() === ".工作台/");
  console.log(
    `[verify] §8.2 提示：该项目 .gitignore ${hasWorkbenchIgnore ? "已含" : "缺"} \`.工作台/\` 行` +
      (hasWorkbenchIgnore ? "" : "（R2 已探明，按口径只提示、不替它改）"),
  );
  // H02 扩查 S1：原 ok(!hasWorkbenchIgnore || true, …) 恒真，是假断言——R2 口径本就"只提示、不替它改"，
  // 不构成通过判据，删除断言只留日志提示（真实项目状态不作为本卡红绿灯）。

  // ── ①② 真实起草：该项目 → 四块雏形 + Gate 推断初值 ─────────────
  console.log(`\n[verify] ── ①② 真实起草（${BRAIN_ID}，真调 Flash + 记忆检索）`);
  const preDesign = readDesign(BRAIN_ID, REAL_DATA_DIR);
  if (preDesign.exists) {
    console.log(`[verify] 注意：${BRAIN_ID} 已有 design.md（${preDesign.source}）——`);
    console.log("[verify] 说明此前已真跑过定版；本轮改验 conflict 分支（DoD⑤ 对真实项目同样成立）");
    const again = await draftDesign(BRAIN_ID, { memoryTimeoutMs: MEMORY_TIMEOUT_MS }, REAL_DATA_DIR);
    ok(again.conflict === true, "① 重复起草 → conflict:true 不覆盖已有 design.md");
    return; // 证据已在首次跑的流水里；本次不重复定版
  }
  const t0 = Date.now();
  const draft = await draftDesign(BRAIN_ID, { memoryTimeoutMs: MEMORY_TIMEOUT_MS }, REAL_DATA_DIR);
  ok(draft.conflict === false, "① 无 design.md 项目 → 非 conflict（草稿正常生成）");
  if (draft.conflict) return;
  console.log(`[verify] 起草耗时 ${draft.duration_ms}ms（含扫描+记忆+Flash），模型 ${draft.model}`);
  console.log(
    `[verify] 记忆检索：${draft.memory.available ? `available（命中 ${draft.memory.results.length} 条，主题词级摘要入提示词）` : `降级（${draft.memory.reason}）——仅代码扫掀起草`}`,
  );
  console.log(`[verify] 推断 Gate 初值：${draft.inferred_gate_step}`);
  console.log(`[verify] 推断依据：git=${draft.evidence.git}`);
  console.log(`[verify]           文件=${draft.evidence.files}`);
  console.log(`[verify]           README=${draft.evidence.readme}`);

  const draftDoc = readReverseDraft(BRAIN_ID, REAL_DATA_DIR);
  ok(draftDoc.exists, "① 草稿落盘 .工作台/design.draft.md（草稿不是 design.md）");
  if (!draftDoc.exists) return;
  const fourBlocks = ["项目是什么", "模块划分", "当前实际阶段", "Gate 标在哪一步"] as const;
  for (const b of fourBlocks) {
    ok(draftDoc.content.includes(b), `DoD① 草稿含四块之一：「${b}」`);
  }
  ok(
    draftDoc.content.includes("推断依据"),
    "DoD② 草稿带推断依据（git 活跃度/文件完整度/README 措辞，§9.3）",
  );
  // 贴草稿片段（流水证据；限长，不整篇倾倒）
  const snippet = draftDoc.content.split(/\r?\n/).slice(0, 14).join("\n");
  console.log("[verify] 草稿开头片段（14 行）：\n" + snippet);
  // 起草后 design.md 仍不存在（草稿绝不冒充设计书）
  ok(!readDesign(BRAIN_ID, REAL_DATA_DIR).exists, "① 起草后 design.md 仍不存在（草稿 ≠ 设计书）");

  // ── ③④ 定版（人确认 = 采信推断值）：design.md + progress + gate.jsonl + 对账钩子 ──
  console.log(`\n[verify] ── ③④ 定版（gate_step 按推断值 ${draft.inferred_gate_step} 确认）`);
  const fin = finalizeDraft(
    BRAIN_ID,
    {
      gate_step: draft.inferred_gate_step,
      note: "B3 验证：人确认采信推断初值",
    },
    REAL_DATA_DIR,
  );
  console.log(`[verify] design.md: ${fin.design_source}`);
  const designNow = readDesign(BRAIN_ID, REAL_DATA_DIR);
  ok(designNow.exists, "③ 定版后 design.md 真实生成");
  if (designNow.exists) {
    ok(designNow.content.includes("项目是什么"), "③ design.md 内容为草稿转正（含四块）");
    ok(
      !designNow.content.includes("未定版"),
      "③ design.md 已去「未定版」标记（定版注记替换）",
    );
    console.log(
      "[verify] design.md 开头 5 行：\n" + designNow.content.split(/\r?\n/).slice(0, 5).join("\n"),
    );
  }
  ok(
    fin.progress.gate.current_step === draft.inferred_gate_step,
    `③ progress.json current_step = ${draft.inferred_gate_step}（实际 ${fin.progress.gate.current_step}）`,
  );
  const idx = ["kickoff", "requirement", "design", "tasks", "develop", "verify", "deliver"].indexOf(
    draft.inferred_gate_step,
  );
  const passedBefore = fin.progress.gate.history.filter((h, i) => i < idx && h.result === "pass");
  ok(
    passedBefore.length === idx,
    `③ 确认步之前 ${idx} 步全部标 pass（实际 ${passedBefore.length}）`,
  );
  const gateLines = readGateLines(BRAIN_ID, REAL_DATA_DIR);
  const finLines = gateLines.filter(
    (l) => l.by === "user" && typeof l.note === "string" && l.note.includes("逆向落稿定版"),
  );
  ok(
    finLines.length === idx,
    `③ gate.jsonl 留痕 ${idx} 行（by:"user" note 含"逆向落稿定版"，实际 ${finLines.length}）`,
  );
  if (finLines[0]) console.log(`[verify] gate.jsonl 首行：${JSON.stringify(finLines[0])}`);

  ok(fs.existsSync(fin.reconcile_request_source), "DoD④ 对账钩子文件真实落盘");
  const hook = JSON.parse(fs.readFileSync(fin.reconcile_request_source, "utf8")) as {
    ts: string;
    trigger: string;
    gate_step: string;
  };
  ok(
    hook.trigger === "reverse-draft-finalize" && hook.gate_step === draft.inferred_gate_step,
    `DoD④ 钩子内容正确（${JSON.stringify(hook)}）——A5 消费此钩子启动对账`,
  );

  // ── ⑤⑥⑦ HTTP 全链路（临时数据目录 + 临时项目，不碰真实注册表）──────────
  console.log("\n[verify] ── ⑤⑥⑦ HTTP 全链路（临时项目）");
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-b3-verify-"));
  const dataDir = path.join(tmpBase, "home");
  fs.mkdirSync(dataDir, { recursive: true });
  // 冲突项目：自带 .工作台/design.md（DoD⑤ 场景）
  const conflictRoot = path.join(tmpBase, "proj-conflict");
  fs.mkdirSync(path.join(conflictRoot, ".工作台"), { recursive: true });
  const conflictDesign = "# 已有设计书\n\n正文一个字都不能被覆盖。\n";
  fs.writeFileSync(path.join(conflictRoot, ".工作台", "design.md"), conflictDesign, "utf8");
  addProject({ id: "p-conflict", name: "冲突项目", path: conflictRoot, kind: "backend" }, dataDir);
  // 空项目：无草稿（finalize → 400 场景）
  const emptyRoot = path.join(tmpBase, "proj-empty");
  fs.mkdirSync(emptyRoot, { recursive: true });
  addProject({ id: "p-empty", name: "空项目", path: emptyRoot, kind: "backend" }, dataDir);

  let child: ChildProcess | undefined;
  try {
    await assertPortFree(PORT); // 端口已被占：立刻失败，不拿占用者的服务跑验证
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", path.join("src", "server", "index.ts")],
      {
        env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
        stdio: ["ignore", "pipe", "pipe"],
        cwd: REPO_ROOT,
      },
    );
    child = proc;
    proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
    watchChild(proc, PORT, () => upPorts.has(PORT)); // 子进程早退（EADDRINUSE）立刻报错退出
    await waitUp();
    console.log(`[verify] server up at ${BASE}（TATAI_HOME=${dataDir}）`);

    // ⑤⑦：POST design/draft（无 session_id → B3 分流）对冲突项目 → 200 + conflict:true，不调 Flash
    const r1 = await fetch(`${BASE}/api/projects/p-conflict/design/draft`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const b1 = (await r1.json()) as {
      ok: boolean;
      result: { conflict: boolean; hint?: string };
    };
    console.log(
      `[verify] POST draft（冲突项目）-> ${r1.status} conflict=${b1.result?.conflict} hint=${b1.result?.hint ?? "-"}`,
    );
    ok(r1.status === 200 && b1.ok && b1.result.conflict === true, "⑤⑦ 已有 design.md → 200 + conflict:true");
    const afterConflict = fs.readFileSync(
      path.join(conflictRoot, ".工作台", "design.md"),
      "utf8",
    );
    ok(afterConflict === conflictDesign, "DoD⑤ design.md 内容逐字节未被覆盖");
    ok(
      !fs.existsSync(path.join(conflictRoot, ".工作台", "design.draft.md")),
      "DoD⑤ 冲突时连草稿文件都不生成",
    );

    // ⑥：无草稿直接 finalize → 400 INVALID_INPUT
    const r2 = await fetch(`${BASE}/api/projects/p-empty/design/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gate_step: "develop" }),
    });
    const b2 = (await r2.json()) as { ok: boolean; error?: { code: string; message: string } };
    console.log(`[verify] POST finalize（无草稿）-> ${r2.status} ${b2.error?.code}: ${b2.error?.message}`);
    ok(r2.status === 400 && b2.error?.code === "INVALID_INPUT", "⑥ 无草稿直接 finalize → 400 INVALID_INPUT");

    // ⑥b：非法 gate_step → 400
    const r3 = await fetch(`${BASE}/api/projects/p-empty/design/finalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ gate_step: "nonsense" }),
    });
    const b3 = (await r3.json()) as { error?: { code: string } };
    ok(r3.status === 400 && b3.error?.code === "INVALID_STEP", "⑥b 非法 gate_step → 400 INVALID_STEP");

    // GET design/draft 空态：exists:false
    const r4 = await fetch(`${BASE}/api/projects/p-empty/design/draft`);
    const b4 = (await r4.json()) as { ok: boolean; draft: { exists: boolean } };
    ok(r4.status === 200 && b4.draft.exists === false, "⑦ GET design/draft 空态 → exists:false");
  } finally {
    child?.kill();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  finish();
}

main().catch((err) => {
  console.error("[verify] 异常:", err);
  process.exitCode = 1;
});
