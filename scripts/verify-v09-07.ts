// V09-07 验证脚本（tsx 跑）：源变化发现链、图页刷新与图新鲜度口径统一
// （PLAN.md V09-07；DESIGN.md §2.9 / §3.9 / §4.4 / 附录 E.8）。
// 用法：pnpm verify:v09-07（自带临时 TATAI_HOME 与夹具项目，不碰真实注册表与真实项目；
// 不起 8787 真实服务——后端子进程走空闲端口）。
//
// 隔离口径（本脚本自己守）：全部写入都落在 os.tmpdir() 的夹具里；真实 `.工作台` 一个字节都不碰。
//
// 覆盖（逐条对着施工规格「验证」段）：
//   ① watcher 定点豁免：真服务器 + 真 watcher，写 `.工作台/design.md` 有事件、
//      写 `.工作台/arch/x.json` 与 `.工作台/work/probe.jsonl` 无事件、写 `src/foo.ts` 有事件
//      （读口 GET /api/projects/:id/changes，负断言走静默窗）；
//   ② 工作事件提交后 `GET /live` 的 `task_last_seq` 前进（前端轮询的服务端前提）＋
//      `hasAdvancedEvents` 纯函数正反例（src/ui/arch/lastSeq.ts）；
//   ③ 顶层加目录（带 .ts，突发三连写）→ 安全防抖后 modules.json 重建（含新目录模块）、
//      `graph-refresh-last.json` last_trigger=parse_changed 且 collapsed≥1（三连合一批）、
//      蓝图回执 trigger 以 parse_changed 开头；随后写 `.工作台/arch/**` **不触发**新一轮（防自触）；
//   ④ 注入失败分支（deps.parse 失败 run / 同步抛 / 被取消）：旧 modules.json 与旧 blueprint.json
//      逐字节不变、回执 last_error 如实带原因、rebuild 不被调用；解析进行中再来变化 →
//      最多补一轮（parse 调用数有界、合并去重）；
//   ⑤ 未审定 design.md 改动 → `.工作台/arch/blueprint-draft.json` 更新（draft:true、
//      publish.published:false、based_on 指向新源哈希），正式 `blueprint.json` 逐字节不变；
//   ⑥ freshnessOf 口径统一（E.8-7）：PLAN 非定义区改动（内容哈希变、定义哈希不变）**不**判过期
//      （旧口径会误判——本条对改造前代码是红的）；PLAN 定义哈希变 → 判过期；缺任一侧哈希不比
//      （不引入新假阳性）；设计书侧旧口径不动（回归 guard）。
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { draftBlueprintOf } from "../src/arch/blueprint";
import { freshnessOf } from "../src/ui/arch/projectGraph";
import { nowIso } from "../src/server/time";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8823;
const BASE = `http://localhost:${PORT}`;

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
  }
};
const info = (m: string): void => console.log(`[verify]   ${m}`);
const section = (t: string): void => console.log(`\n[verify] ── ${t}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha256File = (f: string): string | null =>
  fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null;
const sha256Text = (t: string): string => crypto.createHash("sha256").update(t, "utf8").digest("hex");

// ── 夹具（临时 TATAI_HOME + 夹具项目；不碰真实注册表与真实项目）──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v09-07-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
// 产品代码里任何"取全局数据目录"的缺省路径都落到夹具（ spawned 子进程另经 env 传同一目录）
process.env.TATAI_HOME = dataDir;

const MAIN = "v0907-main"; // ①②③⑤ 的真服务器夹具（真 watcher + 真发现链）
const mainRoot = path.join(tmpBase, "main-proj");
const UNIT = "v0907-unit"; // ④ 注入失败夹具（in-process，deps 注入）
const unitRoot = path.join(tmpBase, "unit-proj");

const DESIGN_TEXT = [
  "# V09-07 夹具设计书",
  "",
  "## 2 模块划分",
  "",
  "| # | 模块 | 说明 |",
  "| --- | --- | --- |",
  "| 1 | 甲模块 | 夹具能力 |",
  "",
  "## 3 说明",
  "",
  "夹具正文。",
  "",
].join("\n");

const PLAN_TEXT = [
  "# V09-07 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| T-1 | todo | 甲模块落成 |  | 甲验收记录 |",
  "",
  "### T-1 甲模块落成",
  "",
  "**设计依据**：§2。",
  "",
  "**契约**：输入甲，输出甲的产物。",
  "",
  "**文件责任**：`src/`。",
  "",
  "- [ ] 甲做出来",
  "",
  "**交付**：甲验收记录。",
  "",
  "**完成证据**：甲验收记录。",
  "",
].join("\n");

const write = (rel: string, text: string): void => {
  const abs = path.join(tmpBase, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, "utf8");
};

// 主夹具：src/ 一个源码文件 + 图纸两源 + 已解析的 modules.json（顶层目录已知 = ["src"]）
write("main-proj/src/index.ts", "export const a = 1;\n");
write("main-proj/.工作台/design.md", DESIGN_TEXT);
write("main-proj/.工作台/plan.md", PLAN_TEXT);
write(
  "main-proj/.工作台/arch/modules.json",
  JSON.stringify(
    {
      version: 1,
      generated_at: "2026-09-24T00:00:00+08:00",
      budget_exhausted: false,
      modules: [{ id: "src", path: "src", name: "", file_count: 1, loc: 5, deps: [] }],
    },
    null,
    2,
  ) + "\n",
);
// 注入夹具：同上但蓝图侧放哨兵字节（④ 断言"旧图逐字节不动"用）
write("unit-proj/src/index.ts", "export const u = 1;\n");
write("unit-proj/.工作台/design.md", DESIGN_TEXT);
write("unit-proj/.工作台/plan.md", PLAN_TEXT);
write(
  "unit-proj/.工作台/arch/modules.json",
  JSON.stringify(
    {
      version: 1,
      generated_at: "2026-09-24T00:00:00+08:00",
      budget_exhausted: false,
      modules: [{ id: "src", path: "src", name: "", file_count: 1, loc: 5, deps: [] }],
    },
    null,
    2,
  ) + "\n",
);
write("unit-proj/.工作台/arch/blueprint.json", JSON.stringify({ sentinel: "official-blueprint-v0907" }) + "\n");

const nowStamp = nowIso();
write(
  "home/registry.json",
  JSON.stringify({
    version: 1,
    projects: [
      { id: MAIN, name: "V09-07 主夹具", path: mainRoot, kind: "backend", registered_at: nowStamp, last_opened_at: nowStamp },
      { id: UNIT, name: "V09-07 注入夹具", path: unitRoot, kind: "backend", registered_at: nowStamp, last_opened_at: nowStamp },
    ],
  }),
);

// ⑤ 的正式图哨兵：用**产品自己的派生链**产出一份形状合法的 blueprint，再以 published 姿态落盘
// （夹具数据，不碰真实项目）；随后 ⑤ 断言它逐字节不变。
{
  const draft = draftBlueprintOf(MAIN, { dataDir });
  if (draft === null) throw new Error("夹具图纸派生不出草稿（夹具缺陷，不是产品结论）");
  const published = {
    ...draft.blueprint,
    publish: { published: true, reason: null, validated_at: nowStamp },
  };
  const { draft: _drop, ...bp } = published as Record<string, unknown>;
  write("main-proj/.工作台/arch/blueprint.json", JSON.stringify(bp, null, 2) + "\n");
}
const mainBlueprintShaBefore = sha256File(path.join(mainRoot, ".工作台", "arch", "blueprint.json"));
const unitBlueprintShaBefore = sha256File(path.join(unitRoot, ".工作台", "arch", "blueprint.json"));
const unitModulesShaBefore = sha256File(path.join(unitRoot, ".工作台", "arch", "modules.json"));

// ── 端口冲突快速失败（与 verify-h2 同一口径）──
const upPorts = new Set<number>();
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
async function assertPortFree(port: number): Promise<void> {
  if (await portListening(port)) {
    console.error(`[verify] 后端起不来：端口 ${port} 被占用，先清理残留进程`);
    process.exit(1);
  }
}
function watchChild(proc: ChildProcess, port: number): void {
  proc.once("exit", (code) => {
    if (upPorts.has(port)) return;
    console.error(`[verify] 后端进程提前退出（code=${code}），先清理残留进程`);
    process.exit(1);
  });
}
async function waitUp(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        upPorts.add(PORT);
        return;
      }
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error("后端 15 秒内未就绪");
}

interface ApiResp {
  status: number;
  body: Record<string, unknown>;
}
async function api(method: string, rawPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResp> {
  const res = await fetch(`${BASE}${rawPath}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

interface ChangeRow {
  ts: string;
  path: string;
  action: string;
  size_delta: number | null;
}
async function changesOf(id: string): Promise<ChangeRow[]> {
  const r = await api("GET", `/api/projects/${id}/changes`);
  return ((r.body.changes as ChangeRow[] | undefined) ?? []).map((c) => c);
}
/** 轮询直满足条件或超时（ watcher AWF 300ms + 落盘合批是异步的，断言必须等） */
async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return true;
    if (Date.now() - t0 > timeoutMs) {
      info(`等待超时（${timeoutMs}ms）：${what}`);
      return false;
    }
    await sleep(150);
  }
}

const receiptPath = (root: string): string => path.join(root, ".工作台", "arch", "graph-refresh-last.json");
const readJson = (f: string): Record<string, unknown> | null => {
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

// 新模块按需动态引入：改造前代码里它们不存在——红跑时按 FAIL 计而不是整脚本崩掉
const graphRefresh = await import("../src/server/work/graphRefresh").catch(() => null);
const lastSeq = await import("../src/ui/arch/lastSeq").catch(() => null);

let child: ChildProcess | undefined;
try {
  await assertPortFree(PORT);
  const proc = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: REPO_ROOT,
  });
  child = proc;
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  watchChild(proc, PORT);
  await waitUp();
  info(`server up at ${BASE}（TATAI_HOME=${dataDir}）`);

  // ═════════════════════ ② 工作事件 → task_last_seq 前进（前端轮询的服务端前提） ═════════════════════
  section("② 工作事件提交后 status-projection/live 的 task_last_seq 前进 ＋ hasAdvancedEvents 正反例");
  const descFile = path.join(dataDir, "work-service.json");
  const desc = JSON.parse(fs.readFileSync(descFile, "utf8")) as { host: string; port: number; token: string };
  const liveSeq = async (): Promise<number | null> => {
    const r = await api("GET", `/api/projects/${MAIN}/live`);
    const live = r.body.live as { task_last_seq?: number | null } | undefined;
    return live?.task_last_seq ?? null;
  };
  const seqBefore = await liveSeq();
  const submit = await api(
    "POST",
    "/api/work/command",
    {
      schema_version: 2,
      project_id: MAIN,
      change_id: "change-v0907",
      entity_id: "task:T-1",
      expected_revision: null,
      type: "task.status_changed",
      actor_id: "v09-07-verify",
      role: "executor",
      idempotency_key: "v0907:T-1:status:1",
      payload: { status: "executing" },
    },
    { "x-tatai-work-token": desc.token },
  );
  ok(submit.status === 200 && submit.body.ok === true, `② 工作事件经唯一写入面提交成功（HTTP ${submit.status}）`);
  const seqAfter = await liveSeq();
  ok(
    seqAfter !== null && (seqBefore === null || seqAfter > seqBefore),
    `② task_last_seq 前进：${seqBefore ?? "null"} → ${seqAfter ?? "null"}（前端轮询靠它发现事实推进）`,
  );
  const projSeq = await api("GET", `/api/projects/${MAIN}/status-projection`);
  const projBody = projSeq.body.projection as { last_seq?: number; revisions?: Record<string, unknown>; baseline?: Record<string, unknown> } | undefined;
  ok(
    projSeq.status === 200 && typeof projBody?.last_seq === "number" && projBody.last_seq === seqAfter,
    `② status-projection.last_seq 与 live 同源（=${projBody?.last_seq}）`,
  );
  // V09-07 ⑤ 口径统一的服务端装配前提：revisions/baseline 都要带 plan_definition（定义哈希）
  ok(
    typeof projBody?.revisions?.plan_definition === "string" &&
      (projBody.revisions.plan_definition as string).length === 64,
    `② revisions.plan_definition = 当前 PLAN 定义哈希（实际: ${String(projBody?.revisions?.plan_definition).slice(0, 16)}…）`,
  );
  if (lastSeq === null) {
    ok(false, "② src/ui/arch/lastSeq.ts 存在并导出 hasAdvancedEvents（红：模块未建）");
  } else {
    const has = lastSeq.hasAdvancedEvents;
    ok(
      has(3, 4) === true && has(4, 3) === false && has(3, 3) === false,
      "② hasAdvancedEvents 正反例：前进才 true（3→4 true；4→3、3→3 false）",
    );
    ok(
      has(undefined, 5) === false && has(undefined, null) === false && has(5, null) === false && has(null, null) === false,
      "② hasAdvancedEvents 空值口径：从未观察（undefined）只登记基线不算前进；current 读不到（null）也不算前进",
    );
    ok(
      has(null, 1) === true && has(null, 0) === false,
      "② hasAdvancedEvents：上次读出 null（v1 兼容/读不到）→ 本轮序号 ≥1 = v2 账本起跑，**算**前进（迁移期第一条事件不吞掉）",
    );
  }

  // ═════════════════════ ① watcher 定点豁免（真服务器 + 真 watcher） ═════════════════════
  section("① watcher 豁免：.工作台/design.md 有事件；.工作台/arch/** 与 .工作台/work/** 照旧无事件");
  const w = await api("POST", `/api/projects/${MAIN}/watch`);
  ok(w.status === 200 && w.body.ok === true, `① POST /watch 落地（HTTP ${w.status}）`);
  await waitFor(async () => {
    const r = await api("GET", "/api/watch");
    const details = (r.body.details as { id: string; ready: boolean }[] | undefined) ?? [];
    return details.some((d) => d.id === MAIN && d.ready === true);
  }, 10000, "watcher ready");
  info("watcher ready（初始扫描结束，此后变更才进流水）");

  // 写 .工作台/design.md（豁免对象之一：必须有事件；同时喂 ⑤ 的草稿链）
  const designV2 = `${DESIGN_TEXT}\n## 9 追加章节（未审定改动）\n\n这段是审定后追加的内容，内容哈希已变。\n`;
  fs.writeFileSync(path.join(mainRoot, ".工作台", "design.md"), designV2, "utf8");
  const designSeen = await waitFor(
    async () => (await changesOf(MAIN)).some((c) => c.path === ".工作台/design.md"),
    10000,
    ".工作台/design.md 变更事件",
  );
  ok(designSeen, "① 写 .工作台/design.md → 变更事件进流水（定点豁免生效）");

  // 负断言（静默窗）：.工作台/arch/ 与 .工作台/work/ 下的写入**绝不**进流水（防自触死循环红线不动）
  fs.writeFileSync(path.join(mainRoot, ".工作台", "arch", "probe.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(mainRoot, ".工作台", "work", "probe.jsonl"), "{}\n", "utf8");
  await sleep(3000); // AWF 300ms + 合批 50ms + 裕量的静默窗
  const afterProbe = await changesOf(MAIN);
  ok(
    !afterProbe.some((c) => c.path.startsWith(".工作台/arch/") || c.path.startsWith(".工作台/work/")),
    `① 写 .工作台/arch/probe.json 与 .工作台/work/probe.jsonl → 静默窗内零事件（其余 .工作台/** 照旧整段忽略）`,
  );

  // 普通源码文件照旧有事件（豁免没有把监听口径撑大）
  fs.writeFileSync(path.join(mainRoot, "src", "foo.ts"), "export const foo = 1;\n", "utf8");
  const fooSeen = await waitFor(
    async () => (await changesOf(MAIN)).some((c) => c.path === "src/foo.ts" && c.action === "add"),
    10000,
    "src/foo.ts 变更事件",
  );
  ok(fooSeen, "① 写 src/foo.ts → 变更事件进流水（既有口径不回退）");

  // ═════════════════════ ⑤ 未审定 doc 改动 → 草稿更新 +「源已变」标记；正式图不动 ═════════════════════
  section("⑤ design.md（未审定）改动 → blueprint-draft.json 更新、正式 blueprint.json 逐字节不变");
  if (graphRefresh === null) {
    ok(false, "⑤ src/server/work/graphRefresh.ts 存在（红：发现链模块未建）");
  } else {
    const draftFile = path.join(mainRoot, ".工作台", "arch", "blueprint-draft.json");
    const draftOk = await waitFor(() => {
      const j = readJson(draftFile);
      return j !== null && (j.based_on as { design_content_sha256?: string } | undefined)?.design_content_sha256 === sha256Text(designV2);
    }, 10000, "blueprint-draft.json 指向新源哈希");
    const j = readJson(draftFile);
    ok(
      draftOk && j?.draft === true && (j.publish as { published?: boolean })?.published === false,
      `⑤ 草稿落盘：draft:true、publish.published:false、based_on 指向当前（未审定）源哈希`,
    );
    ok(
      sha256File(path.join(mainRoot, ".工作台", "arch", "blueprint.json")) === mainBlueprintShaBefore,
      "⑤ 正式 blueprint.json 逐字节不变（未审定改动只更新草稿，不发布正式图）",
    );
    const receipt = readJson(receiptPath(mainRoot));
    ok(receipt?.last_trigger === "doc_changed", `⑤ graph-refresh-last.json 记下 doc_changed 轮次（实际: ${String(receipt?.last_trigger)}）`);
  }

  // ═════════════════════ ③ 顶层结构变化 → 防抖 → 确定性重解析 + 蓝图重建 ═════════════════════
  section("③ 顶层加目录（突发三连写）→ 防抖合批一轮 → modules.json 重建 + 蓝图回执 parse_changed");
  if (graphRefresh === null) {
    ok(false, "③ 发现链已挂载（红：graphRefresh 未建/未接线）");
  } else {
    const mainModulesFile = path.join(mainRoot, ".工作台", "arch", "modules.json");
    // 突发三连写（均在静默窗内）：新顶层目录 newmod/ 带 3 个 .ts
    fs.mkdirSync(path.join(mainRoot, "newmod"), { recursive: true });
    fs.writeFileSync(path.join(mainRoot, "newmod", "a.ts"), "export const a2 = 1;\n", "utf8");
    await sleep(120);
    fs.writeFileSync(path.join(mainRoot, "newmod", "b.ts"), "export const b2 = 1;\n", "utf8");
    await sleep(120);
    fs.writeFileSync(path.join(mainRoot, "newmod", "c.ts"), "export const c2 = 1;\n", "utf8");
    const roundOk = await waitFor(() => readJson(receiptPath(mainRoot))?.last_trigger === "parse_changed", 20000, "parse_changed 轮次");
    const receipt = readJson(receiptPath(mainRoot));
    ok(roundOk && receipt !== null, "③ 防抖后跑了一轮重解析（graph-refresh-last.json last_trigger=parse_changed）");
    ok(
      typeof receipt?.last_parse_run_id === "string" && receipt.last_parse_run_id !== "",
      `③ 回执带 parse run id（${String(receipt?.last_parse_run_id).slice(0, 12)}…）`,
    );
    ok(
      typeof receipt?.collapsed === "number" && (receipt.collapsed as number) >= 1,
      `③ 突发三连被合批去重成一轮（collapsed=${String(receipt?.collapsed)} ≥ 1）`,
    );
    ok(receipt?.last_error === null, `③ 本轮无错误（last_error=${JSON.stringify(receipt?.last_error)}）`);
    const modulesNow = readJson(mainModulesFile);
    const moduleIds = ((modulesNow?.modules as { id: string }[] | undefined) ?? []).map((m) => m.id);
    ok(
      moduleIds.includes("newmod") && moduleIds.includes("src"),
      `③ modules.json 已重建且含新顶层目录模块（实际: ${moduleIds.join("、") || "（空）"}）`,
    );
    // 蓝图重建回执（run 成功才触发；trigger 以 parse_changed 开头——自动链内部追加 :deterministic 段）
    const bpReceiptFile = path.join(mainRoot, ".工作台", "arch", "blueprint-receipt.json");
    const bpReceiptOk = await waitFor(() => {
      const t = readJson(bpReceiptFile)?.trigger;
      return typeof t === "string" && t.startsWith("parse_changed");
    }, 20000, "蓝图回执 trigger=parse_changed…");
    const bpTrigger = readJson(bpReceiptFile)?.trigger;
    ok(bpReceiptOk, `③ 蓝图重建回执 trigger 以 parse_changed 开头（实际: ${String(bpTrigger)}）`);
    ok(
      sha256File(path.join(mainRoot, ".工作台", "arch", "blueprint.json")) === mainBlueprintShaBefore,
      "③ 无生效基线的夹具：重建被发布门禁拦下，旧正式图逐字节保留（失败保留旧图，§4.4）",
    );

    // 反例：写生成目录 .工作台/arch/** 不得自触发新一轮（防 .工作台 自触死循环）
    const receiptSnapshot = fs.readFileSync(receiptPath(mainRoot), "utf8");
    fs.writeFileSync(path.join(mainRoot, ".工作台", "arch", "self-trigger-probe.json"), "{}\n", "utf8");
    await sleep(4000); // > 防抖 1200ms + 一轮快速 parse 的裕量
    ok(
      fs.readFileSync(receiptPath(mainRoot), "utf8") === receiptSnapshot,
      "③ 反例：写 .工作台/arch/self-trigger-probe.json 后回执纹丝不动（生成物变化不自触发本链）",
    );
  }

  // ═════════════════════ ④ 注入失败分支与有界补跑（in-process，deps 注入） ═════════════════════
  section("④ 失败保留旧图 + 如实原因；解析中再变 → 最多补一轮（有界、去重）");
  if (graphRefresh === null) {
    ok(false, "④ 注入式单测可跑（红：graphRefresh 未建）");
  } else {
    const { startGraphRefresh, stopGraphRefresh, graphRefreshDispatch } = graphRefresh;
    // ④a：parse 返回失败 run → 旧 modules.json / 旧 blueprint.json 逐字节不变，回执带原因，rebuild 零调用
    let rebuildCalls = 0;
    startGraphRefresh(UNIT, {
      dataDir,
      quietMs: 60,
      parse: () => ({
        run: { id: "run-fail-1" },
        done: Promise.resolve({ id: "run-fail-1", status: "failed", error: "注入失败：磁盘只读" }),
        deduplicated: false,
      }),
      rebuild: () => {
        rebuildCalls++;
      },
    });
    graphRefreshDispatch(UNIT, { ts: nowIso(), path: "newdir/a.ts", action: "add", size_delta: 12 });
    const failReceiptOk = await waitFor(
      () => typeof readJson(receiptPath(unitRoot))?.last_error === "string",
      8000,
      "④a 失败回执",
    );
    const failReceipt = readJson(receiptPath(unitRoot));
    ok(
      failReceiptOk && String(failReceipt?.last_error).includes("注入失败"),
      `④a 失败 run → 回执 last_error 如实带原因（${String(failReceipt?.last_error).slice(0, 50)}…）`,
    );
    ok(failReceipt?.last_parse_run_id === "run-fail-1", "④a 回执登记了失败 run 的 id（可追溯）");
    ok(
      sha256File(path.join(unitRoot, ".工作台", "arch", "modules.json")) === unitModulesShaBefore &&
        sha256File(path.join(unitRoot, ".工作台", "arch", "blueprint.json")) === unitBlueprintShaBefore,
      "④a 失败保留旧物：modules.json 与 blueprint.json 逐字节不变",
    );
    ok(rebuildCalls === 0, `④a run 失败 ⇒ 不触发蓝图重建（rebuild 调用 ${rebuildCalls} 次）`);
    stopGraphRefresh(UNIT);

    // ④b：parse 同步抛 → 同样收场（不炸监听本体、回执如实）
    let rebuildCallsB = 0;
    startGraphRefresh(UNIT, {
      dataDir,
      quietMs: 60,
      parse: () => {
        throw new Error("注入爆炸：注册表读不动");
      },
      rebuild: () => {
        rebuildCallsB++;
      },
    });
    graphRefreshDispatch(UNIT, { ts: nowIso(), path: "other/b.ts", action: "add", size_delta: 5 });
    const throwOk = await waitFor(
      () => String(readJson(receiptPath(unitRoot))?.last_error ?? "").includes("注入爆炸"),
      8000,
      "④b 同步抛回执",
    );
    ok(throwOk && rebuildCallsB === 0, "④b parse 同步抛 → 回执如实记原因、rebuild 不触发、旧物不动");
    stopGraphRefresh(UNIT);

    // ④c：取消分支（run cancelled）→ 与失败同口径（保留旧图 + 原因），不冒充成功
    let rebuildCallsC = 0;
    startGraphRefresh(UNIT, {
      dataDir,
      quietMs: 60,
      parse: () => ({
        run: { id: "run-cancel-1" },
        done: Promise.resolve({ id: "run-cancel-1", status: "cancelled", error: null }),
        deduplicated: false,
      }),
      rebuild: () => {
        rebuildCallsC++;
      },
    });
    graphRefreshDispatch(UNIT, { ts: nowIso(), path: "xdir/x.ts", action: "add", size_delta: 3 });
    const cancelOk = await waitFor(
      () => String(readJson(receiptPath(unitRoot))?.last_error ?? "").includes("cancelled"),
      8000,
      "④c 取消回执",
    );
    ok(cancelOk && rebuildCallsC === 0, "④c run 被取消 → 回执如实（含 cancelled）、不触发重建");
    stopGraphRefresh(UNIT);

    // ④d：解析进行中再来变化 → 记 pending，本轮结束后最多再补一轮（parse 调用数有界 = 2，不是每条变化一轮）
    let parseCalls = 0;
    let rebuildCallsD = 0;
    const gates: Array<(r: { id: string; status: string; error: null }) => void> = [];
    startGraphRefresh(UNIT, {
      dataDir,
      quietMs: 60,
      parse: () => {
        parseCalls++;
        const id = `run-d${parseCalls}`;
        return {
          run: { id },
          done: new Promise<{ id: string; status: string; error: null }>((r) => gates.push(r)),
          deduplicated: false,
        };
      },
      rebuild: () => {
        rebuildCallsD++;
      },
    });
    graphRefreshDispatch(UNIT, { ts: nowIso(), path: "d1/a.ts", action: "add", size_delta: 1 });
    await waitFor(() => parseCalls === 1, 5000, "④d 第一轮开跑");
    // 第一轮还在跑（done 未放闸）：连来两条结构变化
    graphRefreshDispatch(UNIT, { ts: nowIso(), path: "d2/b.ts", action: "add", size_delta: 1 });
    graphRefreshDispatch(UNIT, { ts: nowIso(), path: "d3/c.ts", action: "add", size_delta: 1 });
    await sleep(400); // 让这两条走过自己的防抖窗（它们应被记成 pending，而不是并行再起一轮）
    const duringRunCalls = parseCalls;
    gates[0]?.({ id: "run-d1", status: "done", error: null }); // 第一轮放闸
    await waitFor(() => parseCalls === 2, 5000, "④d 补跑一轮");
    gates[1]?.({ id: "run-d2", status: "done", error: null });
    await sleep(400); // 静默后不应再有第三轮
    ok(duringRunCalls === 1, `④d 解析进行中来的变化不并行起新 run（进行中 parse 调用仍=${duringRunCalls}）`);
    ok(parseCalls === 2, `④d 本轮结束后**最多补一轮**（parse 总调用=${parseCalls}，有界不无界重试）`);
    const dReceipt = readJson(receiptPath(unitRoot));
    ok(
      typeof dReceipt?.collapsed === "number" && (dReceipt.collapsed as number) >= 1 && rebuildCallsD === 2,
      `④d 补跑这轮合批了 pending 变化（collapsed=${String(dReceipt?.collapsed)}），两轮成功各触发一次重建`,
    );
    stopGraphRefresh(UNIT);
  }

  // ═════════════════════ ⑥ freshnessOf 口径统一（E.8-7：施工图侧比定义哈希） ═════════════════════
  section("⑥ freshnessOf：PLAN 非定义区改动不判过期（旧口径红）、定义区改动判过期、设计侧不动");
  const P_DEF_0 = "a".repeat(64); // 蓝图派生时用的施工图定义哈希
  const P_DEF_1 = "b".repeat(64); // 改动后的施工图定义哈希
  const P_CONTENT_OLD = "c".repeat(64); // 基线批准的施工图内容哈希
  const P_CONTENT_NEW = "e".repeat(64); // 只改状态列/勾选位后的内容哈希
  const D_CONTENT = "d".repeat(64);
  const bpFx = {
    baseline_id: "bl-fx",
    generated_at: "2026-09-24T10:00:00+08:00",
    publish: { published: true, reason: null, validated_at: "2026-09-24T10:00:00+08:00" },
    based_on: {
      model_key: "mk",
      full_key: "fk",
      design_content_sha256: D_CONTENT,
      plan_definition_sha256: P_DEF_0,
      semantic: false,
    },
  } as never;
  const baselineFx = {
    baseline_id: "bl-fx",
    design_revision: D_CONTENT,
    plan_revision: P_CONTENT_OLD,
    plan_definition: P_DEF_0,
  };
  {
    // 只改 PLAN 状态列/勾选位：内容哈希变了（revisions.plan ≠ 基线 plan_revision），定义哈希没变。
    // 旧口径（比内容哈希）会误判「图已过期」——本断言对改造前代码是**红的**。
    const r = freshnessOf({
      blueprint: bpFx,
      receipt: null,
      revisions: { design: D_CONTENT, plan: P_CONTENT_NEW, plan_definition: P_DEF_0 },
      baseline: baselineFx,
    });
    ok(
      r.state === "fresh" && r.banners.length === 0,
      `⑥ 只改 PLAN 非定义区（状态列/勾选位）⇒ 不判过期（E.8-7；实际 state=${r.state}${r.banners.length > 0 ? ` banners=${r.banners[0].slice(0, 24)}…` : ""}）`,
    );
  }
  {
    const r = freshnessOf({
      blueprint: bpFx,
      receipt: null,
      revisions: { design: D_CONTENT, plan: P_CONTENT_NEW, plan_definition: P_DEF_1 },
      baseline: baselineFx,
    });
    ok(
      r.state === "stale" && r.banners.some((b) => b.includes("施工图")),
      "⑥ 改了 PLAN 定义区（定义哈希变）⇒ 判过期且点名施工图",
    );
  }
  {
    const noDef = freshnessOf({
      blueprint: bpFx,
      receipt: null,
      revisions: { design: D_CONTENT, plan: P_CONTENT_NEW, plan_definition: null },
      baseline: baselineFx,
    });
    const bpNoDef = {
      baseline_id: "bl-fx",
      generated_at: "2026-09-24T10:00:00+08:00",
      publish: { published: true, reason: null, validated_at: null },
      based_on: { model_key: "mk", full_key: "fk", design_content_sha256: D_CONTENT, plan_definition_sha256: null, semantic: false },
    } as never;
    const bpSideMissing = freshnessOf({
      blueprint: bpNoDef,
      receipt: null,
      revisions: { design: D_CONTENT, plan: P_CONTENT_NEW, plan_definition: P_DEF_1 },
      baseline: baselineFx,
    });
    ok(
      noDef.state === "fresh" && bpSideMissing.state === "fresh",
      "⑥ 缺任一侧定义哈希 ⇒ 不比（不引入新假阳性）",
    );
  }
  {
    const r = freshnessOf({
      blueprint: bpFx,
      receipt: null,
      revisions: { design: "f".repeat(64), plan: P_CONTENT_OLD, plan_definition: P_DEF_0 },
      baseline: baselineFx,
    });
    ok(r.state === "stale" && r.banners.some((b) => b.includes("设计书")), "⑥ 回归 guard：设计书内容哈希变 ⇒ 照旧判过期（设计侧口径不动）");
  }
} finally {
  child?.kill();
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

console.log(`\n[verify] 汇总：${pass} PASS / ${fail} FAIL`);
console.log(process.exitCode ? "[verify] 存在 FAIL" : "[verify] 全部 PASS");
