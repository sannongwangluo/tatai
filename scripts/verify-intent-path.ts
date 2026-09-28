// 意图原文（`.工作台/intent.json`）数据流路径验证（DESIGN.md §2.5 单源分工／§2.6 权威数据表；数据流图 df-art-intent）。
// 用法：pnpm verify:intent-path
//
// 这一条路径此前是**真实缺路径**：§2.6 声明 `.工作台/intent.json` 是「意图/决策/基线」三件套之一，
// decisions.jsonl / baselines.jsonl 各有读写点，只有 intent.json 全仓没有任何读点 ⇒ 数据流覆盖对账
// 如实报缺并阻断「项目可交付」。本脚本逐跳验证补上后的路径真的走得通（不是靠改对账口径让它好看）。
//
// 判定口径（施工依据）：`intent.json` 是**人直接编写的原文**（同族于根 `DESIGN.md`），产品侧的必需能力是
// **读／解析／引用校验**，不是替人造一个写工具（§2.5「intent.json 是人的意图记录，可作为 requirement
// 的来源被引用，不另建一份可独立编辑的需求库」）——所以本脚本只验读与校验，不要求任何写口。
//
// 覆盖点（逐条真跑）：
//   ① 夹具写入 intent.json（模拟人编写）→ `readIntentFile` 逐字段读回一致，且**只读**（文件字节零改动）；
//      另验裸 `<id>` 与 `intent.json#<id>` 两种引用写法指向同一条目；
//   ② 真经唯一写入服务登记 requirement（source={kind:"intent", ref:"intent.json#r-1"}）→ 接受，
//      投影读回引用一致，事件里只有位置引用、**没有意图正文一个字**（§2.6 单源分工）；
//      反例：调用方不给项目 `.工作台/`（核不了）⇒ 拒，不凭"我以为是那条"先写后补；
//   ③ 悬空 ref（intent.json#r-999）→ 拒且错误点名悬空与缺失条目；零写入（事件条数不变）；
//      另验 ref 指向别的文件（design.md#r-1）→ 拒（不是这份文件就不算这条路径）；
//   ④ intent.json 不存在时登记 kind:"intent" → 拒且原因明确（点名文件不存在），零写入；
//   ⑤ intent.json 损坏（非 JSON／version 不认／items 非数组／id 重复）→ 抛带原因的 WorkError，
//      **不静默当空文件**（直接证据：`readIntentFile` 抛而不是返回 null），登记同样被拒；
//   ⑥ 真实项目（tatai）当前没有这份文件：`readIntentFile` 如实返回 null（"还没人写过"是正常空态），
//      而数据流覆盖行仍在表里、声明状态未被动过、且**已有真实 code 读点 ⇒ 不再是缺路径**；
//   ⑦ 产品真实入口（MCP `manage_requirement`）：工具 handler → 对象命令校验 → 唯一写入服务 → 事件落盘，
//      意图引用走通、悬空引用同样被拒——证明接线接在产品入口上，不是只在脚本自造的提交者上成立；
//   ⑧ 唯一写入服务边界（§2.5「一致校验面」）：**绕过对象命令**、手工拼 payload 直接 `service.submit`
//      的 requirement.registered/updated 也核同一份判据——悬空/文件不在/文件损坏一律拒且零字节、
//      可解析的放行、不带 source 的事件不被误伤；两侧报出**同一句话术与同一个 reason**（判据一处实现）。
//
// 隔离口径：一切写操作在 os.tmpdir() 夹具里（临时 TATAI_HOME + 临时项目目录），真实项目的 `.工作台/`
// **只读**（脚本末尾自证跑完仍未生成真实 intent.json）；收尾清理临时目录。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeDataFlow } from "../src/arch/dataflow";
import { manageRequirementTool } from "../src/mcp/tools/workObjects";
import { WorkService } from "../src/server/work/service";
import type { WorkServiceClient } from "../src/server/work/service";
import { INTENT_FILE, INTENT_SCHEMA_VERSION, readIntentFile, resolveIntentRef } from "../src/server/work/intent";
import { readRequirements, registerRequirement, updateRequirement } from "../src/server/work/requirements";
import { loadEvents } from "../src/server/work/eventStore";
import { WorkError } from "../src/server/work/types";
import { projectWorkDir, workstationDir } from "../src/server/workstation";
import { REPO_ROOT, ensureSelfRegistered, realHome } from "./lib/fixtures";

let passCount = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) {
    passCount += 1;
    console.log(`[verify] PASS ${label}`);
  } else {
    fails.push(label);
    console.log(`[verify] FAIL ${label}`);
  }
}
const info = (m: string): void => console.log(`[verify]   ${m}`);
const sha256Text = (t: string): string => crypto.createHash("sha256").update(t, "utf8").digest("hex");
const sha256File = (f: string): string => sha256Text(fs.readFileSync(f, "utf8"));
const workErrorOf = (fn: () => unknown): WorkError | null => {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof WorkError) return e;
    console.log(`[verify]   （非 WorkError 抛出：${(e as Error).message}）`);
    return null;
  }
};

// 真实项目的全局数据目录要在改 TATAI_HOME **之前**取（后面的夹具会覆盖环境变量）
const REAL_HOME = realHome();
const REPO = REPO_ROOT;
const REAL_BENCH = path.join(REPO, ".工作台");
const REAL_INTENT = path.join(REAL_BENCH, INTENT_FILE);
ensureSelfRegistered(REAL_HOME);

const INTENT_BODY = "用户原话：数据流图要能证明意图原文真被读到过，不要嘴上说有路径";
const INTENT_BODY_2 = "用户原话：意图原文是人写的，产品只读不替人写";
/** 夹具意图原文（人编写的原文；脚本只负责把它按这份字节写下来，之后一个字都不改） */
const INTENT_FIXTURE = JSON.stringify(
  { version: 1, items: [{ id: "r-1", text: INTENT_BODY }, { id: "r-2", text: INTENT_BODY_2 }] },
  null,
  2,
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-intent-path-"));
const dataDir = path.join(tmp, "home");
const FX = "intent-fixture"; // ① ② ③：有 intent.json 的夹具项目
const NX = "intent-none"; // ④：没有 intent.json 的夹具项目
const BX = "intent-broken"; // ⑤：intent.json 损坏的夹具项目
const mkdirp = (d: string): void => void fs.mkdirSync(d, { recursive: true });
const write = (f: string, text: string): void => {
  mkdirp(path.dirname(f));
  fs.writeFileSync(f, text, "utf8");
};
const benchOf = (root: string): string => path.join(root, ".工作台");

async function main(): Promise<void> {
  process.env.TATAI_HOME = dataDir;
  mkdirp(dataDir);
  const roots: Record<string, string> = { [FX]: path.join(tmp, "fx"), [NX]: path.join(tmp, "nx"), [BX]: path.join(tmp, "bx") };
  for (const root of Object.values(roots)) mkdirp(benchOf(root));
  write(
    path.join(dataDir, "registry.json"),
    JSON.stringify(
      {
        version: 1,
        projects: Object.entries(roots).map(([id, dir]) => ({
          id,
          name: `意图路径夹具 ${id}`,
          path: dir,
          kind: "backend",
          registered_at: "2026-09-25T00:00:00+08:00",
          last_opened_at: "2026-09-25T00:00:00+08:00",
        })),
      },
      null,
      2,
    ),
  );

  const service = new WorkService({ dataDir });
  /** 真经唯一写入服务提交（写侧一律走它；本脚本不自己造事件） */
  const submitterFor = (projectId: string, withBench: boolean) => ({
    submit: (command: unknown) => service.submit(command),
    ...(withBench ? { workbenchDir: workstationDir(projectId, dataDir) } : {}),
    read: () => readRequirements(projectWorkDir(projectId, dataDir)),
  });
  const fxWork = projectWorkDir(FX, dataDir);
  const fxBench = benchOf(roots[FX]);
  const eventCount = (workDir: string): number => (fs.existsSync(path.join(workDir, "events.jsonl")) ? loadEvents(workDir).events.length : 0);

  try {
    // ═════════════ ① 读：夹具原文 → readIntentFile 读回一致 ═════════════
    info("── ① 意图原文只读：夹具写入（模拟人编写）→ readIntentFile 逐字段读回一致");
    write(path.join(fxBench, INTENT_FILE), INTENT_FIXTURE);
    const beforeHash = sha256File(path.join(fxBench, INTENT_FILE));
    const read = readIntentFile(fxBench);
    ok(
      read !== null && read.version === INTENT_SCHEMA_VERSION && read.items.length === 2,
      `① 读回意图原文：version=${read?.version ?? "null"}、条目 ${read?.items.length ?? "-"} 条（${INTENT_FILE}）`,
    );
    ok(
      read?.items[0]?.id === "r-1" && read?.items[0]?.text === INTENT_BODY && read?.items[1]?.id === "r-2",
      "① 条目逐字段一致（id 与正文逐字来自那份文件，不是脚本另编的）",
    );
    ok(
      sha256File(path.join(fxBench, INTENT_FILE)) === beforeHash,
      `① 读是**只读**：读回后文件内容哈希未变（${beforeHash.slice(0, 12)}…）`,
    );
    const bare = resolveIntentRef(fxBench, "r-1");
    const explicit = resolveIntentRef(fxBench, `${INTENT_FILE}#r-1`);
    ok(
      bare.status === "found" && explicit.status === "found" && bare.entry.id === "r-1" && bare.entry.text === explicit.entry.text,
      `① 两种引用写法指向同一条目：裸 \`r-1\` 与 \`${INTENT_FILE}#r-1\` 都命中 ${bare.status === "found" ? bare.entry.id : "-"}`,
    );

    // ═════════════ ② 登记：真经唯一写入服务，引用被实解析 ═════════════
    info("── ② 登记：source={kind:\"intent\", ref:\"intent.json#r-1\"} 条目存在 ⇒ 接受");
    const fxSubmitter = submitterFor(FX, true);
    const receipt = registerRequirement(fxSubmitter, {
      project_id: FX,
      requirement_id: "req-意图路径",
      change_id: "change-none",
      actor_id: "verify-intent-path",
      role: "coordinator",
      source: { kind: "intent", ref: `${INTENT_FILE}#r-1` },
      problem: "意图原文要有真实读点与引用校验",
      users: ["人"],
      success_scenarios: ["悬空引用被点名拒"],
      exclusions: ["不替人写意图原文"],
      priority: "P1",
      status: "explicit",
    });
    const fxReq = readRequirements(fxWork).requirements["req-意图路径"];
    ok(
      receipt.ok === true && receipt.seq > 0 && fxReq !== undefined && fxReq.source.ref === `${INTENT_FILE}#r-1`,
      `② 登记经真写入服务成功（seq=${receipt.seq}）且投影读回引用一致（source=${fxReq?.source.kind}:${fxReq?.source.ref}）`,
    );
    const fxEvents = fs.readFileSync(path.join(fxWork, "events.jsonl"), "utf8");
    ok(
      fxEvents.includes(`${INTENT_FILE}#r-1`) && !fxEvents.includes(INTENT_BODY),
      "② 事件里只有位置引用、没有意图正文一个字（§2.6 单源分工：引用不是拷贝）",
    );
    const noBench = workErrorOf(() =>
      registerRequirement(
        { submit: (c: unknown) => service.submit(c) },
        {
          project_id: FX,
          requirement_id: "req-核不了",
          change_id: "change-none",
          actor_id: "verify-intent-path",
          role: "coordinator",
          source: { kind: "intent", ref: `${INTENT_FILE}#r-1` },
          problem: "核不了就不许登记",
          users: [],
          success_scenarios: [],
          exclusions: [],
          priority: "P2",
          status: "explicit",
        },
      ),
    );
    ok(
      noBench?.code === "INVALID_COMMAND" && String(noBench?.message).includes("workbenchDir"),
      `② 反例：调用方不给项目 .工作台/（核不了引用有效性）⇒ 拒（code=${noBench?.code ?? "没有报错"}）`,
    );
    const afterNoBench = eventCount(fxWork);
    ok(afterNoBench === receipt.seq, `② 反例零写入：事件条数仍是 ${afterNoBench}（没有先写后补）`);

    // ═════════════ ③ 悬空引用被点名拒 ═════════════
    info("── ③ 悬空 ref：条目不存在 ⇒ 拒且点名（零写入）");
    const beforeDangling = eventCount(fxWork);
    const dangling = workErrorOf(() =>
      registerRequirement(fxSubmitter, {
        project_id: FX,
        requirement_id: "req-悬空",
        change_id: "change-none",
        actor_id: "verify-intent-path",
        role: "coordinator",
        source: { kind: "intent", ref: `${INTENT_FILE}#r-999` },
        problem: "悬空引用",
        users: [],
        success_scenarios: [],
        exclusions: [],
        priority: "P2",
        status: "explicit",
      }),
    );
    ok(
      dangling?.code === "INVALID_COMMAND" &&
        String(dangling?.message).includes("悬空") &&
        String(dangling?.message).includes("r-999"),
      `③ 悬空 ref 被拒且点名缺的条目（${String(dangling?.message).slice(0, 70)}…）`,
    );
    ok(
      JSON.stringify(dangling?.detail?.known_ids ?? []) === JSON.stringify(["r-1", "r-2"]) &&
        dangling?.detail?.reason === "intent_ref_not_found",
      `③ 拒绝理由可区分（reason=${String(dangling?.detail?.reason)}，现场条目 ${JSON.stringify(dangling?.detail?.known_ids)}）`,
    );
    ok(eventCount(fxWork) === beforeDangling, `③ 悬空拒是原子拒绝：事件条数不变（${eventCount(fxWork)}）`);
    const wrongFile = workErrorOf(() =>
      registerRequirement(fxSubmitter, {
        project_id: FX,
        requirement_id: "req-指错文件",
        change_id: "change-none",
        actor_id: "verify-intent-path",
        role: "coordinator",
        source: { kind: "intent", ref: "design.md#r-1" },
        problem: "引用指向别的文件",
        users: [],
        success_scenarios: [],
        exclusions: [],
        priority: "P2",
        status: "explicit",
      }),
    );
    ok(
      wrongFile?.code === "INVALID_COMMAND" && wrongFile?.detail?.reason === "intent_ref_ref_invalid",
      `③ ref 指向非意图文件（design.md#r-1）⇒ 拒（reason=${String(wrongFile?.detail?.reason)}）`,
    );
    const updateDangling = workErrorOf(() =>
      updateRequirement(fxSubmitter, {
        project_id: FX,
        requirement_id: "req-意图路径",
        change_id: "change-none",
        actor_id: "verify-intent-path",
        role: "coordinator",
        fields: { source: { kind: "intent", ref: `${INTENT_FILE}#r-999` } },
      }),
    );
    ok(
      updateDangling?.code === "INVALID_COMMAND" && String(updateDangling?.message).includes("悬空"),
      `③ 更新改来源引用同样实解析（改 ref 也要核；实际 ${updateDangling?.code ?? "没有报错"}）`,
    );

    // ═════════════ ④ 没有那份文件 ⇒ 拒（不假装有） ═════════════
    info("── ④ intent.json 不存在：登记 kind:\"intent\" ⇒ 拒且原因明确");
    const nxSubmitter = submitterFor(NX, true);
    const missingFile = workErrorOf(() =>
      registerRequirement(nxSubmitter, {
        project_id: NX,
        requirement_id: "req-无原文",
        change_id: "change-none",
        actor_id: "verify-intent-path",
        role: "coordinator",
        source: { kind: "intent", ref: `${INTENT_FILE}#r-1` },
        problem: "没有意图原文文件",
        users: [],
        success_scenarios: [],
        exclusions: [],
        priority: "P2",
        status: "explicit",
      }),
    );
    ok(
      missingFile?.code === "INVALID_COMMAND" &&
        missingFile?.detail?.reason === "intent_ref_file_missing" &&
        String(missingFile?.message).includes(INTENT_FILE),
      `④ 文件不存在 ⇒ 拒并点名（reason=${String(missingFile?.detail?.reason)}；${String(missingFile?.message).slice(0, 60)}…）`,
    );
    ok(
      readIntentFile(benchOf(roots[NX])) === null && eventCount(projectWorkDir(NX, dataDir)) === 0,
      "④ `readIntentFile` 如实返回 null（「还没人写过」是正常空态）且零写入",
    );

    // ═════════════ ⑤ 损坏的原文 ⇒ 抛，绝不静默当空文件 ═════════════
    info("── ⑤ intent.json 损坏：抛带原因的 WorkError（不当空文件）");
    const bxBench = benchOf(roots[BX]);
    const bxFile = path.join(bxBench, INTENT_FILE);
    const brokenCases: { why: string; text: string; needle: string }[] = [
      { why: "非 JSON", text: "这不是 JSON，是半截笔记\n", needle: "不是合法 JSON" },
      { why: "version 不认", text: JSON.stringify({ version: 2, items: [] }), needle: "version 必须是" },
      { why: "items 不是数组", text: JSON.stringify({ version: 1, items: { r: "1" } }), needle: "items 必须是数组" },
      {
        why: "id 重复",
        text: JSON.stringify({ version: 1, items: [{ id: "r-1", text: "a" }, { id: "r-1", text: "b" }] }),
        needle: "id 重复",
      },
      { why: "条目缺 text", text: JSON.stringify({ version: 1, items: [{ id: "r-1" }] }), needle: "text 必须是非空字符串" },
    ];
    let allThrew = true;
    for (const c of brokenCases) {
      write(bxFile, c.text);
      const broken = workErrorOf(() => readIntentFile(bxBench));
      const threw = broken !== null && String(broken.message).includes(c.needle);
      if (!threw) allThrew = false;
      info(`     ⑤ ${c.why}：${threw ? "抛错点名" : "没有按预期抛错"}（${String(broken?.message ?? "返回了值").slice(0, 60)}…）`);
    }
    ok(allThrew, "⑤ 五种坏态逐条抛出带原因的 WorkError（不是返回 null 当空文件、也不是静默跳过）");
    write(bxFile, "半截 JSON {");
    const bxSubmitter = submitterFor(BX, true);
    const brokenRegister = workErrorOf(() =>
      registerRequirement(bxSubmitter, {
        project_id: BX,
        requirement_id: "req-坏原文",
        change_id: "change-none",
        actor_id: "verify-intent-path",
        role: "coordinator",
        source: { kind: "intent", ref: `${INTENT_FILE}#r-1` },
        problem: "原文损坏",
        users: [],
        success_scenarios: [],
        exclusions: [],
        priority: "P2",
        status: "explicit",
      }),
    );
    ok(
      brokenRegister?.code === "INVALID_COMMAND" &&
        brokenRegister?.detail?.reason === "intent_file_invalid" &&
        String(brokenRegister?.message).includes("不是合法 JSON"),
      `⑤ 损坏的原文下登记 ⇒ 拒且原因照原样报（reason=${String(brokenRegister?.detail?.reason)}），不当"悬空"也不当空文件`,
    );
    ok(eventCount(projectWorkDir(BX, dataDir)) === 0, "⑤ 坏原文下零写入");

    // ═════════════ ⑦ 产品入口：MCP manage_requirement 真链路 ═════════════
    info("── ⑦ 产品入口（MCP manage_requirement）：工具 handler → 对象命令校验 → 唯一写入服务 → 事件落盘");
    const relay = { submit: (c: unknown) => Promise.resolve(service.submit(c)) } as unknown as WorkServiceClient;
    const mcpCtx = { work: relay, clientName: "verify-intent-path" };
    const toolTextOf = (r: { content: { type: string; text?: string }[] }): string =>
      r.content.map((c) => c.text ?? "").join("");
    const toolJson = (r: { content: { type: string; text?: string }[] }): Record<string, unknown> =>
      JSON.parse(toolTextOf(r) || "{}") as Record<string, unknown>;
    const toolBase = {
      op: "register",
      project_id: FX,
      role: "coordinator",
      users: [] as string[],
      success_scenarios: [] as string[],
      exclusions: [] as string[],
      priority: "P2",
      status: "explicit",
    };
    const toolReceiptsBefore = eventCount(fxWork);
    const rTool = await manageRequirementTool.handler(
      { ...toolBase, requirement_id: "req-工具意图", source: { kind: "intent", ref: `${INTENT_FILE}#r-2` }, problem: "入口级：意图引用" },
      mcpCtx,
    );
    const pTool = toolJson(rTool);
    const toolReceipt = (pTool.receipts as { event_id?: string; seq?: number }[] | undefined)?.[0];
    ok(
      rTool.isError !== true &&
        pTool.ok === true &&
        typeof toolReceipt?.event_id === "string" &&
        !toolReceipt.event_id.includes("planned") &&
        (toolReceipt.seq ?? 0) > toolReceiptsBefore &&
        readRequirements(fxWork).requirements["req-工具意图"]?.source.ref === `${INTENT_FILE}#r-2`,
      `⑦ 工具入口（产品真实入口）登记意图引用成功：真实回执 seq=${toolReceipt?.seq ?? "-"}、读回引用一致（占位回执不外泄）`,
    );
    const rToolDangling = await manageRequirementTool.handler(
      { ...toolBase, requirement_id: "req-工具悬空", source: { kind: "intent", ref: `${INTENT_FILE}#r-999` }, problem: "入口级：悬空引用" },
      mcpCtx,
    );
    ok(
      rToolDangling.isError === true && toolTextOf(rToolDangling).includes("悬空"),
      `⑦ 工具入口的悬空意图引用同样拒（工具层不绕过对象命令的判据）：${toolTextOf(rToolDangling).slice(0, 80)}…`,
    );
    ok(
      eventCount(fxWork) === toolReceiptsBefore + 1,
      `⑦ 被拒的那次零写入（FX 事件 ${toolReceiptsBefore} → ${eventCount(fxWork)}，只多了成功的那一条）`,
    );

    // ═════════════ ⑧ 唯一写入服务边界：绕过对象命令直连 submit ═════════════
    info("── ⑧ 唯一写入服务边界：直连 WorkService.submit 的 requirement.* 也核同一份判据（§2.5 一致校验面）");
    const directSubmit = (
      projectId: string,
      entityId: string,
      type: string,
      payload: Record<string, unknown>,
      expectedRevision: number | null,
      key: string,
    ): WorkError | null => {
      try {
        service.submit({
          schema_version: 2,
          project_id: projectId,
          change_id: "change-none",
          entity_id: entityId,
          type,
          payload,
          expected_revision: expectedRevision,
          actor_id: "verify-intent-path",
          role: "coordinator",
          idempotency_key: key,
        });
        return null;
      } catch (e) {
        if (e instanceof WorkError) return e;
        throw e;
      }
    };
    /** 直连提交的 registered payload（绕过 registerRequirement，手工拼 payload） */
    const directRegistered = (source: unknown): Record<string, unknown> => ({
      source,
      problem: "直连写口：意图引用",
      users: [],
      success_scenarios: [],
      exclusions: [],
      priority: "P2",
      status: "explicit",
    });

    // ⑧-1 悬空 ref：直连 submit 必须被拒且点名（对象命令侧的同一句判据话术 + 同一 code）
    const beforeDirect = eventCount(fxWork);
    const directDangling = directSubmit(
      FX,
      "requirement:req-直连悬空",
      "requirement.registered",
      directRegistered({ kind: "intent", ref: `${INTENT_FILE}#r-999` }),
      null,
      "k-直连悬空",
    );
    ok(
      directDangling?.code === "INVALID_COMMAND" &&
        directDangling?.detail?.reason === "intent_ref_not_found" &&
        String(directDangling?.message).includes("悬空") &&
        String(directDangling?.message).includes("r-999"),
      `⑧-1 直连 submit 的悬空意图引用被拒并点名（code=${directDangling?.code ?? "没有报错"}、reason=${String(directDangling?.detail?.reason)}）`,
    );
    ok(
      eventCount(fxWork) === beforeDirect,
      `⑧-1 被拒的直连提交零字节（事件 ${beforeDirect} → ${eventCount(fxWork)}）`,
    );
    // 判据单一来源：两条入口对同一条悬空 ref 必须给出同一句判据话术与同一个 reason（不是各写一套）
    const sharedJudge = "来源引用悬空：意图条目不存在（r-999）";
    ok(
      String(directDangling?.message).includes(sharedJudge) &&
        String(dangling?.message).includes(sharedJudge) &&
        directDangling?.detail?.reason === dangling?.detail?.reason &&
        (directDangling?.detail?.cause as { reason?: string } | undefined)?.reason === "intent_ref_not_found",
      "⑧-1 判据单一来源：对象命令侧与写口边界报出同一句话术与同一个 reason（assertIntentSourceValid 一处实现）",
    );

    // ⑧-2 正对照：ref 可解析 ⇒ 直连 submit 放行、事件落盘、读回引用一致、正文不入事件
    const directOk = directSubmit(
      FX,
      "requirement:req-直连合法",
      "requirement.registered",
      directRegistered({ kind: "intent", ref: `${INTENT_FILE}#r-1` }),
      null,
      "k-直连合法",
    );
    const directState = readRequirements(fxWork).requirements["req-直连合法"];
    ok(
      directOk === null && directState?.source.ref === `${INTENT_FILE}#r-1` && eventCount(fxWork) === beforeDirect + 1,
      `⑧-2 正对照：可解析的意图引用经直连写口放行（seq 前进到 ${eventCount(fxWork)}，读回 source=${directState?.source.kind}:${directState?.source.ref}）`,
    );
    ok(
      !fs.readFileSync(path.join(fxWork, "events.jsonl"), "utf8").includes(INTENT_BODY),
      "⑧-2 直连写口落盘的事件里同样只有位置引用、没有意图正文（§2.6 单源分工）",
    );

    // ⑧-3 文件不存在／文件损坏：直连 submit 也被拒（reason 可区分，不是笼统一句"引用无效"）
    const directMissing = directSubmit(
      NX,
      "requirement:req-直连无原文",
      "requirement.registered",
      directRegistered({ kind: "intent", ref: `${INTENT_FILE}#r-1` }),
      null,
      "k-直连无原文",
    );
    const directBroken = directSubmit(
      BX,
      "requirement:req-直连坏原文",
      "requirement.registered",
      directRegistered({ kind: "intent", ref: `${INTENT_FILE}#r-1` }),
      null,
      "k-直连坏原文",
    );
    ok(
      directMissing?.detail?.reason === "intent_ref_file_missing" &&
        String(directMissing?.message).includes(INTENT_FILE) &&
        eventCount(projectWorkDir(NX, dataDir)) === 0,
      `⑧-3 直连提交到「没有这份原文」的项目被拒且原因可区分（reason=${String(directMissing?.detail?.reason)}、零写入）`,
    );
    ok(
      directBroken?.detail?.reason === "intent_file_invalid" && eventCount(projectWorkDir(BX, dataDir)) === 0,
      `⑧-3 直连提交到「原文损坏」的项目被拒（reason=${String(directBroken?.detail?.reason)}、零写入、不静默当空文件）`,
    );

    // ⑧-4 requirement.updated 走直连写口同样核（改来源引用不能从边界绕）
    const directUpdated = directSubmit(
      FX,
      "requirement:req-直连合法",
      "requirement.updated",
      { source: { kind: "intent", ref: `${INTENT_FILE}#r-999` } },
      1,
      "k-直连更新悬空",
    );
    ok(
      directUpdated?.code === "INVALID_COMMAND" && directUpdated?.detail?.reason === "intent_ref_not_found",
      `⑧-4 直连 requirement.updated 改来源引用到悬空条目 ⇒ 同样拒（reason=${String(directUpdated?.detail?.reason)}）`,
    );

    // ⑧-5 不顺手扩项：不带 source 的事件（status_changed）不在这道校验范围内，不被它误伤
    const directStatus = directSubmit(
      FX,
      "requirement:req-直连合法",
      "requirement.status_changed",
      { status: "inferred", reason: "夹具：证明不带 source 的事件不被这道校验误伤" },
      1,
      "k-直连改状态",
    );
    ok(
      directStatus === null && readRequirements(fxWork).requirements["req-直连合法"]?.status === "inferred",
      "⑧-5 边界校验只管 requirement.registered/updated 且只核 source.kind=intent：status_changed 照常放行（没顺手扩项）",
    );

    // ═════════════ ⑥ 真实项目：行仍在、读点已覆盖、原文确实没有 ═════════════
    info("── ⑥ 真实项目（tatai）：数据流行仍在、真实读点在场；原文文件当前没有 ⇒ 如实 null");
    const realRead = readIntentFile(REAL_BENCH);
    ok(
      realRead === null && !fs.existsSync(REAL_INTENT),
      `⑥ 真实项目当前没有 .工作台/${INTENT_FILE}：readIntentFile 如实返回 null（正常空态，不虚构条目、不报错）`,
    );
    const model = analyzeDataFlow("tatai", { dataDir: REAL_HOME });
    const row = model.coverage.rows.find((r) => r.artifact.includes(INTENT_FILE));
    ok(
      row !== undefined && row.declaration_status === "current" && row.kind === "input_source",
      `⑥ 覆盖表里这一行仍在（${row?.artifact ?? "（行都不在了）"}，declaration_status=${row?.declaration_status ?? "-"}）——没有为了让读数好看把它删掉`,
    );
    ok(
      row?.path_found === true && (row?.evidence.length ?? 0) > 0 && row?.gap === null,
      `⑥ 该行现在有真实读点：证据 ${row?.evidence.length ?? 0} 条、path_found=${row?.path_found}、gap=${JSON.stringify(row?.gap)}`,
    );
    ok(
      (row?.evidence ?? []).some((r) => r.locator.startsWith("src/server/work/intent.ts:")) &&
        (row?.evidence ?? []).some((r) => r.locator.startsWith("src/server/work/requirements.ts:")),
      `⑥ 读点出处逐条落在真实文件行上：${(row?.evidence ?? []).map((r) => r.locator).join("、")}`,
    );
    info(
      `     ⑥ 覆盖读数：声明 ${model.coverage.declared_total} 行 · 有路径 ${model.coverage.covered} · ` +
        `缺路径 ${model.coverage.missing}（${model.coverage.missing_paths.join("、") || "空"}） · 设计明写未实现 ${model.coverage.not_implemented}`,
    );
    ok(
      !model.coverage.missing_paths.some((a) => a.includes(INTENT_FILE)),
      `⑥ 缺路径清单里不再有它（现清单：${model.coverage.missing_paths.join("、") || "空"}）`,
    );
    ok(
      !fs.existsSync(REAL_INTENT) && realRead === null,
      "⑥ 自证：本脚本跑完，真实项目仍没有生成 intent.json（写操作只在临时夹具里）",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`[verify] 夹具已清理：${tmp}`);
  }

  console.log(`[verify] 意图路径：PASS ${passCount} / FAIL ${fails.length}`);
  if (fails.length > 0) {
    for (const f of fails) console.log(`[verify]   FAIL：${f}`);
    process.exit(1);
  }
  console.log("[verify] 全部 PASS");
}

void main();
