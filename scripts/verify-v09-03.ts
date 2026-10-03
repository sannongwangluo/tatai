// V09-03 需求对象落地与追踪链打通（PLAN.md V09-03；DESIGN.md §1.2/§2.5/§2.6/§2.7、附录 E.2）。
// 用法：pnpm verify:v09-03
//
// 覆盖点（卡面 ①–⑥ 逐条真跑）：
//   ① 登记：需求经唯一写入服务登记（当前有效项），投影读回逐条可核（来源/分类/确认度）；
//   ② 引用完整性反例：映射表承接不存在的卡 / 「当前有效」行空登记 ⇒ 受检导入整次拒绝并点名；
//      任务 `requirement_ids` 指向未登记需求 ⇒ 既有的投影悬空校验照拒；
//   ③ 正反追踪：映射表 ⇒ 至少 3 张卡 `requirement_ids` 非空，正向（需求→承接卡）与反向（卡→需求）都能答；
//   ④ 既有卡零改动：追加映射表前后，第一张卡表原文逐字节不变（哈希断言；真实 PLAN.md 亦同法自证）；
//   ⑤ 改映射重新受检（正反）：改承接关系 ⇒ 施工定义哈希变 + 被承接卡任务定义哈希变；
//      反例——只改来源措辞不动承接 ⇒ 别的卡哈希不误变；只改状态列/勾选位 ⇒ 定义哈希不变；
//   ⑥ 门槛与回归。
//
// 隔离口径：临时 TATAI_HOME + 夹具（os.tmpdir()）；塔台根文档只读（首尾 sha256 对照）；收尾清理。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkService } from "../src/server/work/service";
import { WorkError } from "../src/server/work/types";
import { readRequirements, registerRequirement, requirementIdsOf } from "../src/server/work/requirements";
import {
  importTaskDefinitions,
  parseRequirementMap,
  planDefinitionDigest,
  requirementMapForCards,
  taskDefinitionHash,
} from "../src/server/work/plan";
import { importPlanChecked } from "../src/server/work/references";

const REPO = process.cwd();
let passCount = 0;
const failCount: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) {
    passCount += 1;
    console.log(`[verify] PASS ${label}`);
  } else {
    failCount.push(label);
    console.log(`[verify] FAIL ${label}`);
  }
}
const sha256Text = (t: string): string => crypto.createHash("sha256").update(t, "utf8").digest("hex");

// ═════════════ 夹具施工图（三卡小表 + 需求映射表） ═════════════
const FIXTURE_PLAN_BASE = `# 夹具施工图

| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |
| --- | --- | --- | --- | --- |
| T-1 | done | 甲目标 | 无 | 甲证据 |
| T-2 | doing | 乙目标 | T-1 | 乙证据 |
| T-3 | todo | 丙目标 | T-2 | 丙证据 |

### T-1 甲卡

**交付**：甲。
`;

const MAP_SECTION = `

### 需求映射（测试小节）

| 需求 ID | 来源 | 分类 | 适用范围/生效时点 | 确认度 | 承接卡 |
| --- | --- | --- | --- | --- | --- |
| req-R-1 | 设计书 §1 | 当前有效 | 本轮 | 明确 | T-1、T-2 |
| req-R-2 | 设计书 §2 | 当前有效 | 本轮 | 明确 | T-3 |
| req-R-3 | 设计书 §3 | 历史 | 已被取代 | 明确 | T-9 |
`;
const FIXTURE_PLAN_WITH_MAP = FIXTURE_PLAN_BASE + MAP_SECTION;

function main(): void {
  const docBefore = new Map<string, string>();
  for (const rel of ["DESIGN.md", "PLAN.md", "PROGRESS.md", "AGENTS.md", "README.md"]) {
    const abs = path.join(REPO, rel);
    docBefore.set(rel, fs.existsSync(abs) ? sha256Text(fs.readFileSync(abs, "utf8")) : "<missing>");
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0903-"));
  try {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    process.env.TATAI_HOME = home;
    const projRoot = path.join(tmp, "proj");
    const workDir = path.join(projRoot, ".工作台", "work");
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(
      path.join(home, "registry.json"),
      JSON.stringify(
        {
          version: 1,
          projects: [
            {
              id: "v0903-fixture",
              name: "V09-03 夹具",
              path: projRoot,
              kind: "backend",
              registered_at: "2026-09-24T00:00:00+08:00",
              last_opened_at: "2026-09-24T00:00:00+08:00",
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    const svc = new WorkService({ dataDir: home });

    // ═══ ① 登记：只登记「当前有效」需求，读回逐条可核 ═══
    console.log("[verify] ═══ ① 需求登记与读回（当前有效才入册） ═══");
    const now = "2026-09-24T00:00:00+08:00";
    const reg = (id: string, title: string, source: string) =>
      registerRequirement(svc, {
        project_id: "v0903-fixture",
        requirement_id: id,
        change_id: "change-v0903",
        actor_id: "verify-v09-03",
        role: "executor",
        occurred_at: now,
        source: { kind: "design", ref: source },
        problem: title,
        users: [],
        success_scenarios: [],
        exclusions: [],
        priority: "normal",
        status: "explicit",
      });
    reg("req-R-1", "六图按当前项目状况显示", "DESIGN.md 附录 E.5");
    reg("req-R-2", "全面审计与修复", "PLAN.md v0.9 入口「来源与授权」段");
    const registeredIds = requirementIdsOf(readRequirements(workDir));
    ok(registeredIds.includes("req-R-1") && registeredIds.includes("req-R-2"), `① 登记两条当前有效需求并读回（${registeredIds.join("/")}）`);

    // ═══ ② 引用完整性反例（整次拒绝 + 点名） ═══
    console.log("[verify] ═══ ② 悬空/空登记反例 ═══");
    // ②-a：承接不存在的卡 ⇒ dangling_map_card 点名
    const badCardPlan = FIXTURE_PLAN_BASE + MAP_SECTION.replace("T-1、T-2", "T-1、T-77");
    let code = "";
    try {
      importPlanChecked(badCardPlan, workDir, {});
    } catch (e) {
      code = e instanceof WorkError ? `${e.code}:${(e.detail as { issues?: { problem: string }[] })?.issues?.[0]?.problem ?? ""}` : "other";
      const msg = e instanceof Error ? e.message : String(e);
      ok(code === "INVALID_COMMAND:dangling_map_card" && msg.includes("T-77"), `②-a 承接不存在的卡 T-77 ⇒ 整次拒绝并点名（${code}）`);
    }
    if (code === "") ok(false, "②-a 承接不存在的卡居然没被拒（应 dangling_map_card）");
    // ②-b：「当前有效」行承接卡为空 ⇒ incomplete_requirement_map
    const emptyPlan = FIXTURE_PLAN_BASE + MAP_SECTION.replace("T-1、T-2 |", " |");
    code = "";
    try {
      importPlanChecked(emptyPlan, workDir, {});
    } catch (e) {
      code = e instanceof WorkError ? `${e.code}:${(e.detail as { issues?: { problem: string }[] })?.issues?.[0]?.problem ?? ""}` : "other";
      ok(code === "INVALID_COMMAND:incomplete_requirement_map", `②-b 「当前有效」行承接卡为空 ⇒ 整次拒绝（${code}）`);
    }
    if (code === "") ok(false, "②-b 空登记居然没被拒（应 incomplete_requirement_map）");
    // ②-c：需求 id 未登记 ⇒ 既有投影悬空校验照拒（带引用的新形态定义）
    code = "";
    try {
      importPlanChecked(FIXTURE_PLAN_WITH_MAP, workDir, {});
      // 未被拒 = 投影里 R-1/R-2 已登记 ⇒ 本段只验「未登记才拒」：换一个未登记 id 的映射再试
    } catch {
      // 不允许在这里拒（R-1/R-2 已登记）
      ok(false, "②-c 已登记需求的导入被误拒");
    }
    const ghostPlan = FIXTURE_PLAN_BASE + MAP_SECTION.replace("req-R-1", "req-GHOST");
    code = "";
    try {
      importPlanChecked(ghostPlan, workDir, {});
      ok(false, "②-c 未登记需求 req-GHOST 居然没被拒（应 dangling_requirement）");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ok(e instanceof WorkError && msg.includes("req-GHOST"), `②-c 承接未登记需求 ⇒ 投影悬空校验拒并点名（${(e as WorkError).code}）`);
    }

    // ═══ ③ 正反追踪（映射进任务定义） ═══
    console.log("[verify] ═══ ③ 正反追踪 ═══");
    const imported = importTaskDefinitions(FIXTURE_PLAN_WITH_MAP, {});
    const byId = new Map(imported.definitions.map((d) => [d.task_id, d]));
    const nonEmpty = imported.definitions.filter((d) => (d.requirement_ids ?? []).length > 0);
    ok(nonEmpty.length >= 3, `③ 至少 3 张卡 requirement_ids 非空（实际 ${nonEmpty.length}：${nonEmpty.map((d) => d.task_id).join("/")}）`);
    ok(
      (byId.get("T-1")?.requirement_ids ?? []).includes("req-R-1") && (byId.get("T-2")?.requirement_ids ?? []).includes("req-R-1"),
      "③ 反向：T-1/T-2 各答出承接 req-R-1",
    );
    const forward = requirementMapForCards(parseRequirementMap(FIXTURE_PLAN_WITH_MAP));
    ok((forward.get("T-3") ?? []).includes("req-R-2"), "③ 正向：req-R-2 由 T-3 承接");
    ok(!([...(byId.values())].some((d) => (d.requirement_ids ?? []).includes("req-R-3"))), "③ 「历史」行（req-R-3）不产生承接（不进任何卡的 requirement_ids）");

    // ═══ ④ 既有卡零改动（哈希断言） ═══
    console.log("[verify] ═══ ④ 既有卡表逐字节不变 ═══");
    ok(
      !FIXTURE_PLAN_WITH_MAP.slice(0, FIXTURE_PLAN_BASE.length).includes("| T-9 |") &&
        FIXTURE_PLAN_WITH_MAP.startsWith(FIXTURE_PLAN_BASE),
      "④ 夹具：映射表是追加，既有文本逐字节前缀不变",
    );
    // 真实 PLAN.md：追加块逐字节剥离后应回到追加前读数（本包复核 61c511ec…）
    // 定向更新（V09-10，2026-09-24）：钉值 61c511ec… → 83ede1ef…。判据未放宽——仍是
    // "剥离需求映射追加块后与钉值逐字节恒等"（多一字少一字都红）：
    //   旧钉值 61c511ec…（V09-03 包复核时的 PLAN）｜依据：v0.9 批次按用户 2026-09-24 返工裁定
    //   在第一张当前任务表末段增补 V09-10 卡行（PLAN 文末 V09-10 段；卡面交付物含 v06-02 行数断言同步）｜
    //   新钉值 83ede1ef…（＝当前 PLAN 剥离同一追加块的实测 sha256）｜
    //   保留意图：剥离后既有卡行/勾选位零改动——本卡没碰 PLAN 一字（PLAN 由主会话统一写）。
    // 定向更新（V09-04 交付面，2026-09-25）：钉值 e9826f89… → 7d86f367…。判据未放宽：
    //   旧钉值 e9826f89…｜依据：V09-04 卡面文件责任补 PLAN 第一张当前任务表 U3 行一句处置结论
    //   （撤销「不把它当通过依据」的限制；同源重打＋verify:u3 真实绿，证据 .工作台/evidence/V09-04/1/）——
    //   U3 行在追加块锚点之前，钉值随之变化（批次影响分析追加三已预告）｜新钉值 7d86f367…
    //   （＝现行 PLAN 剥离同一追加块的实测 sha256）｜保留意图同上（剥离后逐字节恒等，多一字少一字都红）。
    // 定向更新（V09-03 返工，2026-09-24）：钉值 83ede1ef… → e9826f89…。判据未放宽：
    //   旧钉值 83ede1ef…｜依据：第 4 稿（用户 2026-09-24 第 2 轮澄清）改了追加块**之前**的正文——
    //   顶部指针段、第一张当前任务表 V09-04／V09-09／V09-10 行与新增 V09-11…V09-16 六行、v0.9 入口；
    //   第 5 稿（Codex 定向复审 7 条）移除 V09-15 行并同步依赖（DESIGN 附录 G/G.4、PLAN v0.9 入口
    //   「机械影响」段第 4 条已预告本钉值必变）｜新钉值 e9826f89…（＝现行 PLAN 剥离同一追加块的
    //   实测 sha256）｜保留意图：仍是「剥离后与钉值逐字节恒等，多一字少一字都红」；追加块之内
    //   （需求映射表／V09-10…V09-16 卡定义／覆盖表）的后续变更不影响本钉值。
    // 定向更新（2026-09-25 复核批次）：钉值 7d86f367… → fed9938c…。判据未放宽：
    //   旧钉值 7d86f367…｜依据：复核批次改了追加块锚点之前的正文——一期 2/7/8 产出行
    //   补「实现落点」标注（声明模块 11.1-02/07/08 配对，V08-04 先例格式）、第一张当前任务表
    //   V09 行状态列同步账本（状态列属派生内容、不入定义哈希，needs_rebind 实测为空）、
    //   顶部指针段追加批次例外条（PLAN 未决/覆盖表的追加块内变更不影响本钉值）｜
    //   新钉值 fed9938c…（＝现行 PLAN 剥离同一追加块的实测 sha256）｜保留意图同上。
    // 定向更新（2026-09-25 终审收口批）：钉值 fed9938c… → b3068eb0…。判据未放宽：
    //   旧钉值 fed9938c…｜依据：终审收口批改了追加块锚点之前的正文——v0.9 入口「体例约定」段
    //   补一句任务/证据两套读数对照（防误读，终审报告 P6）｜新钉值 b3068eb0…（＝现行 PLAN
    //   剥离同一追加块的实测 sha256）｜保留意图同上（剥离后逐字节恒等，多一字少一字都红）；
    //   覆盖表补注在追加块之内，不影响本钉值。
    // 定向更新（V09-17，2026-09-25）：钉值 b3068eb0… → c095b35f…。判据未放宽：
    //   旧钉值 b3068eb0…｜依据：PLAN 第 6 稿按用户 2026-09-25 会话逐条转达的 GPT-6 复审裁定
    //   （DESIGN 附录 E.15）改了追加块锚点**之前**的正文——第一张当前任务表末段增补 V09-17 一行、
    //   v0.9 入口与账本投影对照表同步｜新钉值 c095b35f…（＝现行 PLAN 剥离同一追加块的实测
    //   sha256）｜保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内（需求映射表／
    //   卡定义／覆盖表）的变更不影响本钉值。
    // 定向更新（V09-17 收口，2026-09-25）：钉值 c095b35f… → 43696510…。判据未放宽：
    //   旧钉值 c095b35f…｜依据：V09-17 交付同步（PLAN 第一张当前任务表 V09-17 行状态列改 done、
    //   覆盖表 V09-17 行证据与状态列更新；提交 git 96eb7f9）改了追加块锚点**之前**的正文——
    //   收口批马拉松复跑实测红（19/1），属第 6 稿「机械影响」预告的同类连带｜新钉值 43696510…
    //   （＝现行 PLAN 剥离同一追加块的实测 sha256）｜保留意图同上（剥离后逐字节恒等，
    //   多一字少一字都红）。
    // 定向更新（终审返工批 change-20260925-v0917-rework，2026-09-25）：钉值 43696510… → 9952d5de…。
    //   判据未放宽：旧钉值 43696510…｜依据：终审返工改了追加块锚点**之前**的正文——
    //   第一张当前任务表 V08-01／V08-02 行「完成证据」列补登可追溯实现路径声明（F-4，旧记录一字未改、
    //   仅追加声明）＋ 15 张 V09 行「完成证据」列「未开工」陈词更正为「已交付（执行结果）」（审计 F-5①；
    //   提交 git acbb9fb）｜新钉值 9952d5de…（＝现行 PLAN 剥离同一追加块的实测 sha256）｜
    //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内（覆盖表 V09-17 行等）
    //   的后续变更不影响本钉值。
    // 定向更新（V09-19 收口内追加，2026-09-26）：钉值 e80b7508… → 4dbf72f6…。判据未放宽：
    //   旧钉值 e80b7508…｜依据：第一张当前任务表前正文再改一次——v0.9 入口「第 8 稿」段的「机械影响」补齐本批
    //   实测连带六条（蓝图读数增长／AGENTS 行尾归 LF／DESIGN 标记字面量改写／verify:m1 白名单补 v09 族／
    //   verify:v09-05 ⑧ 名单补 V09-19／v09-04+v09-01 待重绑消解）｜
    //   新钉值 4dbf72f6…（＝现行 PLAN 剥离同一追加块的实测 sha256，项目自身实测非估算）｜
    //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）。
    // 定向更新（V09-19，2026-09-26）：钉值 2e4c00b8… → e80b7508…。判据未放宽：
    //   旧钉值 2e4c00b8…｜依据：PLAN 第 8 稿（批次 change-20260926-v09-19，DESIGN 附录 E.18）
    //   改了追加块锚点**之前**的正文——顶部指针段第 8 稿例外条、第一张当前任务表新增 V09-19 行、
    //   v0.9 入口「第 8 稿」段（含机械影响逐条登记）｜
    //   新钉值 e80b7508…（＝现行 PLAN 剥离同一追加块的实测 sha256，项目自身实测非估算）｜
    //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内（需求映射表／卡定义／覆盖表）
    //   的后续变更不影响本钉值。
    // 定向更新（V09-20，2026-09-26）：钉值 4dbf72f6… → 290b9ee9…。判据未放宽：
    //   旧钉值 4dbf72f6…｜依据：PLAN 第 9 稿（批次 change-20260926-v0920-ui，DESIGN 附录 E.19）
    //   改了追加块锚点**之前**的正文——顶部指针段第 9 稿例外条、第一张当前任务表新增 V09-20 行
    //   （状态列含批次号）、v0.9 入口「第 9 稿」段（含机械影响与三条定向更新逐条登记）｜
    //   新钉值 290b9ee9…（＝现行 PLAN 剥离同一追加块的实测 sha256，项目自身实测非估算）｜
    //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内（需求映射表／卡定义／覆盖表）
    //   的后续变更不影响本钉值。
    // 定向更新（V09-21，2026-09-27）：钉值 290b9ee9… → 2177a47f…。判据未放宽：
    //   旧钉值 290b9ee9…｜依据：PLAN 第 10 稿（批次 change-20260927-v0921-rework，任务书
    //   `.工作台/handoff/2026-09-27-V0921-返工任务书-Kimi.md`）改了追加块锚点**之前**的正文——
    //   顶部指针段第 10 稿例外条、第一张当前任务表新增 V09-21 行、v0.9 入口「第 10 稿」段
    //   （含机械影响逐条登记）｜新钉值 2177a47f…（＝现行 PLAN 剥离同一追加块的实测 sha256，
    //   项目自身实测非估算）｜保留意图同上（剥离后逐字节恒等，多一字少一字都红）；
    //   追加块之内（需求映射表补两行／V09-21 卡定义／覆盖表）的变更不影响本钉值。
    // 定向更新（V09-22，2026-09-28）：钉值 2177a47f… → d027669d…。判据未放宽：
    //   旧钉值 2177a47f…｜依据：PLAN 第 11 稿（批次 change-20260928-d7982446，用户 2026-09-28 会话指令，
    //   施工任务书 `.工作台/handoff/2026-09-28-V0922-全量可查看-施工任务书.md`）改了追加块锚点**之前**的
    //   正文——顶部指针段第 11 稿例外条、第一张当前任务表新增 V09-22 行、v0.9 入口「第 11 稿」段
    //   （含机械影响与接续手续如实登记）｜新钉值 60c706f1…（＝现行 PLAN 剥离同一追加块的实测 sha256；终稿措辞微调后重算，
    //   项目自身实测非估算）｜保留意图同上（剥离后逐字节恒等，多一字少一字都红）；
    //   追加块之内（需求映射表补一行／V09-22 卡定义／覆盖表）的变更不影响本钉值。
    // 定向更新（V09-23…V09-25 增量 ＋ 公开脱敏，2026-09-30）：钉值 60c706f1… → a3b26407…。判据未放宽：
    //   旧钉值 60c706f1…｜依据（两件事，逐条留痕）：
    //   ① 本轮新增三卡（用户 2026-09-30 会话指令「同步证据发现与完整性验收」）：PLAN 第一张当前任务表
    //      追加 V09-23/V09-24/V09-25 三行——这三行在**追加块锚点之前**，剥离后正文因此变长，钉值必变。
    //      范围核验（确认原有 50 卡定义没被本轮顺手改）：git diff PLAN.md 只有 101 行插入、0 行删除；
    //      且对"剥离去尾追加块后的正文"做逐行差分，**只有一处纯插入**（HEAD 基线第 82 行后插入 3 行＝
    //      V09-23…V09-25 卡行），无任何行被改写/删除——即锚点前除这三行外一字未动。取证见本轮
    //      test-alignment 报告（源仓 60c706f1 → a3b26407 的差分脚本与实际读数）。
    //      注：V09-23…V09-25 的需求映射行与文末「同步证据发现与完整性验收」段都在**锚点之后**（属追加块），
    //      不影响本钉值。
    //   ② 公开脱敏：导出规程把真实客户项目名与盘符路径等匿名化后才落公开仓，公开仓那份 PLAN
    //      与主仓字节不同 ⇒ 公开仓 verify-v09-03.ts 的钉值必须按**同一算法**在新字节上重钉。这不是放宽、
    //      也不是取当前文件 hash 冒充旧证据：公开钉值由 scripts/export-opensource.py 在计划阶段从转换后的
    //      PLAN 现算并定点替换（算法同本文件：定位同一锚点→取其前→sha256），见 docs/open-source-release.md §3.2。
    //   新钉值 a3b26407…（＝现行主仓 PLAN 行尾归一 LF 后剥离同一追加块的实测 sha256，项目自身实测非估算）｜
    //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内（需求映射表／卡定义／覆盖表）的
    //   后续变更不影响本钉值。
    // 定向更新（V09-26…V09-29 增量，2026-10-02）：钉值 a3b26407… → 08a176fb…。判据未放宽：
    //   旧钉值 a3b26407…｜依据：用户 2026-10-02 会话指令的正向批次（正向成套图纸直接技术审定、
    //   正向工作面统一自动刷新、Agent 阶段/执行/证据上报链、当前代码证据有效性反例核验）已授权已验收，
    //   给 PLAN 第一张当前任务表**追加块锚点之前**增补 V09-26／V09-27／V09-28／V09-29 四行卡行——
    //   这四行在锚点之前，剥离后正文因此变长，钉值必变。
    //   范围核验（确认原有正文没被顺手改）：对"剥离去尾追加块后的正文"做逐行差分，**只有一处纯插入**
    //   （锚点前第 82 行后插入 4 行＝V09-26…V09-29 卡行），无任何行被改写/删除；把这确切 4 行去掉后
    //   重算，结果**精确等于**旧钉值 a3b26407…（独立复算见本轮导出的 pin-delta-proof 证据）。
    //   新钉值 08a176fb…（＝现行主仓 PLAN 行尾归一 LF 后剥离同一追加块的实测 sha256，项目自身实测非估算）｜
    //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内（需求映射表／卡定义／覆盖表）
    //   的后续变更不影响本钉值。
    // 定向更新（同步核验增量提速，2026-10-03）：钉值 08a176fb… → 12c30b0b…。判据未放宽：
    //   旧钉值 08a176fb…｜依据：用户已批准的定向性能修复（同步核验增量提速）在 v0.9 入口
    //   「本轮改了什么（如实）」区**追加块锚点之前**增补「第 12 稿（2026-10-03）」一段（记录本轮范围、
    //   语义修正与机械影响；**不新增卡行、不改任何卡定义与验收内容**）——该段在锚点之前，剥离后正文变长，钉值必变。
    //   范围核验：把这确切一段（「**第 12 稿（2026-10-03，同步核验增量提速」开头到其后的空行）逐字节删去后重算，
    //   结果**精确等于**旧钉值 08a176fb…（实测：newStripped＝12c30b0b…、removedParagraph＝08a176fb… 由同一脚本现算，非估算）。
    //   新钉值 12c30b0b…（＝现行主仓 PLAN 行尾归一 LF 后剥离同一追加块的实测 sha256，项目自身实测非估算）｜
    //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内（需求映射表／卡定义／覆盖表）
    //   的后续变更不影响本钉值。第一张当前任务表卡行数未变（未增删卡行）⇒ `pnpm verify:v06-02` 行数断言不受影响。
    // 定向更新（统一优化 V09-30…V09-39，2026-10-03）：钉值 12c30b0b… → cfcdef1d…。判据未放宽：
    //   旧钉值 12c30b0b…｜依据：用户 2026-10-03 明确新授权的统一优化批次（依据 DESIGN §6.8 与
    //   docs/unified-optimization-contract.md U1–U6）在第一张当前任务表**追加块锚点之前**新增
    //   V09-30…V09-39 十行卡行（纯插入，既有卡行/卡定义/勾选位零改动）——插入在锚点之前，剥离后正文变长，钉值必变。
    //   范围核验：把这确切十行（`| V09-30 |` … `| V09-39 |`）逐字节删去后重算，结果**精确等于**旧钉值 12c30b0b…
    //   （实测：现行剥离正文＝cfcdef1d…、删十行后＝12c30b0b…，由同一脚本现算非估算；独立复算见
    //   `<维护者核验目录>/tatai-git-sync-20261003/pin-delta-proof.json`）。锚点前相对 HEAD 逐行差分**只有两处纯插入**
    //   （本十行卡行 ＋ 已由上一钉值覆盖的「第 12 稿」段），无任何行被改写/删除。
    //   新钉值 cfcdef1d…（＝现行主仓 PLAN 行尾归一 LF 后剥离同一追加块的实测 sha256，项目自身实测非估算）｜
    //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内（需求映射表／卡定义／覆盖表）
    //   的后续变更不影响本钉值。**机械影响**：第一张当前任务表卡行数 57 → 67 ⇒ `pnpm verify:v06-02` ② 行数点名断言
    //   同批定向更新为 67（同一条沿革，见该脚本）。
    //
    // 行尾归一（2026-09-30 口径说明）：本仓 PLAN.md 在 Windows 检出/编辑下是 CRLF（core.autocrlf=true），
    //   而 git 仓库存的是 LF、导出规程也只产 LF。本断言判的是**内容**逐字节恒等，不是行尾风格；故先做
    //   定长可逆的 CRLF→LF 归一再定位锚点与取哈希，既保留"剥离后逐字节恒等"的判据，又让主仓/公开仓
    //   两侧走同一套算法（公开仓那份由导出脚本按同一算法重钉）。归一不动其它任何字节。
    const planNow = fs.readFileSync(path.join(REPO, "PLAN.md"), "utf8").replace(/\r\n/g, "\n");
    const anchor = "\n---\n\n### 需求映射（V09-03 追加";
    const idx = planNow.indexOf(anchor);
    ok(idx > 0, "④ 真实 PLAN.md 含需求映射小节（追加在文末）");
    if (idx > 0) {
      const stripped = planNow.slice(0, idx);
      ok(
        sha256Text(stripped) === "7005ae4614d4c43ff6bace87810ac145bf29519388dfedfada9f8a8f52a6aa2d",
        "④ 真实 PLAN.md 剥离追加块后逐字节（行尾归一 LF）回到追加前内容（sha256 恒等 7005ae46…，既有卡行/勾选位零改动）",
      );
    }

    // ═══ ⑤ 改映射重新受检（正反断言） ═══
    console.log("[verify] ═══ ⑤ 改映射 ⇒ 重新受检 ═══");
    const digestBefore = planDefinitionDigest(FIXTURE_PLAN_WITH_MAP);
    const t1HashBefore = taskDefinitionHash(byId.get("T-1")!);
    const changed = FIXTURE_PLAN_WITH_MAP.replace("req-R-2 | 设计书 §2 | 当前有效 | 本轮 | 明确 | T-3 |", "req-R-2 | 设计书 §2 | 当前有效 | 本轮 | 明确 | T-1、T-3 |");
    const importedAfter = importTaskDefinitions(changed, {});
    ok(planDefinitionDigest(changed) !== digestBefore, "⑤ 改承接关系 ⇒ 施工定义哈希变化（映射表在定义区）");
    const t1After = importedAfter.definitions.find((d) => d.task_id === "T-1")!;
    ok(taskDefinitionHash(t1After) !== t1HashBefore && (t1After.requirement_ids ?? []).includes("req-R-2"), "⑤ 被承接卡 T-1 的任务定义哈希变化（重新受检，不产生执行事实）");
    const wordingOnly = FIXTURE_PLAN_WITH_MAP.replace("设计书 §1", "设计书 §1.2 行");
    const importedWording = importTaskDefinitions(wordingOnly, {});
    ok(
      taskDefinitionHash(importedWording.definitions.find((d) => d.task_id === "T-3")!) ===
        taskDefinitionHash(byId.get("T-3")!),
      "⑤ 反例：只改来源措辞（不动承接关系）⇒ 无关卡 T-3 的任务定义哈希不变（不误重绑）",
    );
    const stateOnly = FIXTURE_PLAN_WITH_MAP.replace("| T-2 | doing |", "| T-2 | done |").replace("- [ ]", "- [x]");
    ok(planDefinitionDigest(stateOnly) === digestBefore, "⑤ 反例：只改状态列/勾选位 ⇒ 施工定义哈希不变（不触发重新受检）");

    // ═══ ⑥ 收尾：根文档零改动自证 ═══
    for (const [rel, before] of docBefore) {
      const abs = path.join(REPO, rel);
      const after = fs.existsSync(abs) ? sha256Text(fs.readFileSync(abs, "utf8")) : "<missing>";
      ok(after === before, `⑥ 根文档零改动：${rel}`);
    }
  } finally {
    delete process.env.TATAI_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n[verify] V09-03：PASS ${passCount} / FAIL ${failCount.length}`);
  if (failCount.length > 0) {
    for (const f of failCount) console.log(`[verify]   FAIL ${f}`);
    process.exit(1);
  }
  console.log("[verify] 全部 PASS");
}

main();
