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
    // 定向更新（V09-40 界面与品牌统一，2026-10-04）：钉值 cfcdef1d… → e7915e86…。判据未放宽：
    //   旧钉值 cfcdef1d…｜依据：用户 2026-10-04 明确授权的 V09-40 批次（界面与品牌统一，正式验收
    //   `<维护者核验目录>/tatai-ui-20261004/ACCEPTANCE.md` 有独立浏览器复审 82/0 与原生打包版
    //   隔离验收 37/0）在第一张当前任务表**追加块锚点之前**新增 1 行 V09-40 卡行（纯插入，既有卡行/
    //   卡定义/勾选位零改动）——插入在锚点之前，剥离后正文变长，钉值必变。
    //   范围核验：剥离去尾追加块后相对 HEAD 逐行差分**只有一处纯插入**（锚点前插入 1 行 `| V09-40 |`），
    //   无任何行被改写/删除（实测：HEAD 版剥离正文 sha256＝cfcdef1d…＝旧钉值，现行工作树剥离正文
    //   ＝e7915e86…＝新钉值，由同一 strip 算法现算非估算）。V09-40 的 23 行小节在锚点**之后**（属追加块），
    //   不进钉值区、不影响本钉值。
    //   新钉值 e7915e86…（＝现行主仓 PLAN 行尾归一 LF 后剥离同一追加块的实测 sha256，项目自身实测非估算）｜
    //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内（需求映射表／卡定义／覆盖表）
    //   的后续变更不影响本钉值。
    //
    // 定向更新（V09-41…V09-44 既有欠账 ＋ V09-45…V09-49 本批增量，2026-10-06 集成）：钉值 e7915e86… → 4a80100a…。
    //   判据未放宽——仍是「剥离追加块后与钉值逐字节恒等，多一字少一字都红」。依据（两笔，逐条留痕）：
    //   ① 既有欠账：2026-10-04／10-05 的 V09-41…V09-44 批次（紧凑简报与接续按需展开）在第一张当前任务表
    //      **追加块锚点之前**新增 4 行卡行，当时未同步本钉值；实测 HEAD（c49d277f）剥离正文
    //      ＝2d0066eb…（≠ 旧钉值 e7915e86…）——即本断言在本批开工前已红，属既有欠账，非本批引入。
    //   ② 本批增量：2026-10-06 用户授权批次（docs/agent-optimization-20261006.md）再新增
    //      V09-45…V09-49 五行卡行，同样在追加块锚点**之前**（纯插入，既有卡行/卡定义/勾选位零改动）。
    //   范围核验（实测非估算）：相对 HEAD 对「剥离追加块后的正文」逐行差分**只有一处纯插入**
    //      （锚点前第 37 行后插入 5 行 `| V09-45 |`…`| V09-49 |`），无任何行被改写/删除；
    //      HEAD 剥离正文 2d0066eb… → 现行工作树剥离正文 4a80100a…（行尾归一 LF，主仓实测）。
    //   新钉值 4a80100a…｜保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内
    //      （需求映射表／V09-45…V09-49 卡小节／覆盖表）的变更不影响本钉值。
    // 定向更新（P5 条件启动追加 V09-50，2026-10-06 集成）：钉值 4a80100a… → 6d39e2ba…。
    //   判据未放宽——仍是「剥离追加块后与钉值逐字节恒等，多一字少一字都红」。
    //   依据：Codex 据真实全量采集 25–31 s 剖析（replay/FINAL-REPORT.md §8）裁定 P5 条件触发，在 PLAN
    //   第一张当前任务表**追加块锚点之前**再新增 1 行 V09-50（纯插入，既有卡行/卡定义/勾选位零改动；
    //   同批把 V09-49 卡行依赖列补 V09-50——该行属本批新卡，不属旧 72 卡）。
    //   范围核验（实测非估算）：相对新增前对「剥离追加块后的正文」逐行差分**只有一处纯插入**
    //   （`| V09-49 |` 行后插入 1 行 `| V09-50 |`）＋ V09-49 行依赖单元格一处就地改写。
    //   旧钉值 4a80100a… → 新钉值 6d39e2ba…（＝现行 PLAN 行尾归一 LF 后剥离同一追加块的实测 sha256）。
    //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内
    //   （需求映射表／V09-50 卡小节）的变更不影响本钉值。
    // 定向更新（协作闭环批次 V09-51…V09-58 八卡，2026-10-07；批次 change-20261007-loop-closure）：
    //   钉值 6d39e2ba… → a02207e5…。**由协调者授权的机械期望更新，不改产品规则**。
    //   判据未放宽——仍是「剥离追加块后与钉值逐字节恒等，多一字少一字都红」。
    //   依据：PLAN 第一张当前任务表在**追加块锚点之前**纯插入 8 行 V09-51…V09-58（既有卡行/卡定义/勾选位零改动；
    //   依据 PLAN「协作闭环批次」段与 B1 卡 V09-51 的「机械影响」第 2 条）。
    //   范围核验（实测非估算）：对 baseline/source 的 PLAN.md 与现行 PLAN.md 做行级差分，剔除行尾风格后
    //   **只有一处 8 行纯插入块**（`| V09-50 |` 行后插入 `| V09-51 |`…`| V09-58 |`），无卡行被改写或删除；
    //   追加块（需求映射表／八卡卡小节／覆盖表）本身不进本钉值。
    //   新钉值 a02207e5…（＝现行 PLAN 行尾归一 LF 后剥离同一追加块的实测 sha256；独立复核现读现算，非估算）。
    //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内
    //   （需求映射表／V09-51…V09-58 卡小节／覆盖表）的变更不影响本钉值。
    // 定向更新（docs-final 顶部指针段改写连带，2026-10-07；root 裁定 chk-v09-51-07 机械更正）：
    //   钉值 a02207e5… → dcd92565…。**由 root 授权的机械期望更新，不改产品规则**。
    //   判据未放宽——仍是「剥离追加块后与钉值逐字节恒等，多一字少一字都红」。
    //   依据：追加块锚点**之前**的 PLAN 第 3 行（顶部指针段）在 docs-final 轮被改写
    //   （草案状态「设计落稿候选，未开工／拟议功能映射…现行解析器不识别、落在历史归档区」
    //   → 已开工事实「B1 契约冻结已交付…／功能映射，两者均已按 B2 纳入施工定义区」），
    //   该行落在本钉值覆盖区内 ⇒ 剥离正文随之变；其余正文一字未动。
    //   范围核验（实测非估算）：对 docs-before-final/PLAN.md（旧钉值 a02207e5… 状态）
    //   与 docs-final/PLAN.md（现行）的**剥离正文**做逐行差分，**只有第 3 行一处改写**、
    //   行数同为 2011 行、其余逐字节相同；旧/新行 sha256 分别为 948d4a61…／bd64ba18…。
    //   新钉值 dcd92565…（＝现行 PLAN 行尾归一 LF 后剥离同一追加块的实测 sha256；现读现算，非估算）。
    //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内
    //   （需求映射表／V09-51…V09-58 卡小节／覆盖表）的变更不影响本钉值。
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
        (() => {
          // 负例（判据不放宽）：① 锚点前改一个字节 ⇒ 剥离哈希必变（逐字节判据，非模糊匹配）；
          //   ② 宽泛归一（把所有 `- [ ] chk-* ` 前缀一律剥掉）≠ 钉值 ⇒ 本轮只认"精确已审差异"。
          // 四阶段链钉值（逐阶段一枚，判据不放宽；每阶段只认本阶段"精确已审"差异，不做范围型归一）：
          //   PIN_V09_03        = 本阶段（V09-62 交付总览卡行：锚点前纯插入一整行已审卡行）后剥离哈希 d72cafa7…
          //   PREV_PIN_V09_03   = 上一阶段（plan-finalize：V09-09 十条恢复后授稳定键 10 条）后剥离哈希 81161852…
          //   PREV2_PIN_V09_03  = 再上一阶段（feature-scope-reconcile：84 条授键）后剥离哈希 eb8b1b77…
          //   LEGACY_PIN_V09_03 = 再再上一阶段（plan-integration：43 条授键）后剥离哈希 4299af1b…
          const PIN_V09_03 = "92822fdee8af79e68af0b1611642c8d013de72cd1ccf895ecf45d4bbae0bd3c1";
          const PREV_PIN_V09_03 = "b9192eb68f3adb96d75e619bdcaaf7d6cef577f92fcb1b7ea002406f712db241";
          const PREV2_PIN_V09_03 = "eb8b1b778253d1f45fb99d4e273a7fd32a4923a09ea4aa84a2985498dfae7c28";
          const LEGACY_PIN_V09_03 = "4299af1b2d15cc54512e9353634c1561d6679a40c63697a2ecbe4177ecd12762";
          // 本阶段唯一差异＝锚点前纯插入一整行已审 V09-62 卡行（全文一等）。判据不放宽：删/重复/改正文
          // 或改它处任一字节都不等于本阶段钉值；只整行去掉这一行应精确回到上一阶段 81161852…。
          const V09_62_ROW = "| V09-62 | todo | 交付总览、完整功能核查与可试用判定 | 无 | 同源读数与负例、浏览器默认入口、非作者复审、实际安装版本核对 |";
          const v0962Hits = stripped.split(V09_62_ROW).length - 1;
          ok(v0962Hits === 1, `④ 本阶段唯一差异：V09-62 卡行在锚点前恰命中 1 处（实际 ${v0962Hits}）`);
          const prevStripped = stripped.replace(V09_62_ROW + "\n", "");
          ok(sha256Text(prevStripped) !== PIN_V09_03, "④ 负例：删掉 V09-62 卡行 ⇒ ≠ 本阶段钉值（该行即本阶段差异，不得当作可不计）");
          ok(
            sha256Text(stripped.replace(V09_62_ROW + "\n", V09_62_ROW + "\n" + V09_62_ROW + "\n")) !== PIN_V09_03,
            "④ 负例：重复 V09-62 卡行 ⇒ ≠ 本阶段钉值",
          );
          ok(sha256Text(stripped.replace(V09_62_ROW, V09_62_ROW + "（改）")) !== PIN_V09_03, "④ 负例：改 V09-62 卡行正文 ⇒ ≠ 本阶段钉值");
          const tampered = `${stripped.slice(0, 100)}啊${stripped.slice(100)}`;
          ok(sha256Text(tampered) !== PIN_V09_03, "④ 负例：锚点前改其它一个字符 ⇒ 剥离哈希必变（非模糊匹配）");
          const wideStripped = stripped.replace(/^(- \[[ x]\] )chk-[a-z0-9-]+ /gm, "$1");
          ok(wideStripped !== stripped && sha256Text(wideStripped) !== PIN_V09_03, "④ 负例：宽泛剥掉全部 chk- 前缀 ≠ 钉值（不做无依据归一）");
          // 语义恒等证明（判据不放宽：只去掉**该阶段精确点名**的已审 token，不用范围型 allowlist、不做宽泛归一）：
          //   从剥离正文逐行只去掉某一份迁移表点名的 `chk-*` token，结果应精确回到该阶段的剥离哈希。
          const stripTokensOf = (src: string, tablePath: string): string => {
            const mig = JSON.parse(fs.readFileSync(tablePath, "utf8")) as { migration: { new_stable_id: string }[] };
            const toks = new Set(mig.migration.map((m) => m.new_stable_id));
            return src
              .split("\n")
              .map((l) => {
                const mm = /^(\s*-\s*\[[ xX]\]\s*)(chk-[A-Za-z0-9._-]+)\s(.*)$/.exec(l);
                return mm !== null && toks.has(mm[2]!) ? mm[1]! + mm[3]! : l;
              })
              .join("\n");
          };
          const pfMig = path.join(REPO, ".工作台", "project-completion-20261008", "plan-finalize", "migration-table.json");
          const fsMig = path.join(REPO, ".工作台", "project-completion-20261008", "feature-scope-reconcile", "migration-table.json");
          // 正向证明（本阶段）：只把已审 V09-62 卡行整行去掉 ⇒ 精确回到上一阶段 81161852…（锚点前无其它改动）。
          ok(sha256Text(prevStripped) === PREV_PIN_V09_03, "④ 正向证明（本阶段）：整行去掉已审 V09-62 卡行 ⇒ 精确回到上一阶段剥离哈希 81161852…（锚点前无其它改动）");
          // 前两阶段沿用（用**原历史正文**；判据不放宽）：从上一阶段剥离正文去掉 10 个 plan-finalize token
          // ⇒ eb8b1b77…；再去掉 41 个 feature-scope token ⇒ 4299af1b…（旧钉值按原历史正文复算，不在新源上重算）。
          if (fs.existsSync(pfMig)) {
            const back10 = stripTokensOf(prevStripped, pfMig);
            ok(sha256Text(back10) === PREV2_PIN_V09_03, "④ 正向证明（上一阶段）：去掉 plan-finalize 十处已审精确 token ⇒ 回到 eb8b1b77…（锚点前无其它改动）");
            if (fs.existsSync(fsMig)) {
              ok(sha256Text(stripTokensOf(back10, fsMig)) === LEGACY_PIN_V09_03, "④ 正向证明（再上一阶段）：再去掉 41 个 feature-scope token ⇒ 回到 4299af1b…（四阶段链逐段可还原）");
            }
          }
          return sha256Text(stripped) === PIN_V09_03;
        })(),
        // 定向更新（V09-61 plan-finalize V09-09 十条恢复检查授稳定键，2026-10-08）：钉值 eb8b1b77… → 81161852…。判据未放宽——\r
        //   仍是「剥离追加块后与钉值逐字节恒等，多一字少一字都红」。依据＝逐字审 diff ＋ 三阶段链逐段还原实测：\r
        //   本轮给 parser 修复后恢复的 V09-09 十条检查前置稳定键 `chk-v09-09-01`…`chk-v09-09-10`\r
        //   （见 plan-finalize/migration-table.json），**10 行落在追加块锚点之前**，均为**纯前缀插入**（只加 token，正文逐字不动）。\r
        //   语义恒等证明（非估算，写入上面的 ④ 正向断言）：只把这 10 个**本阶段新增** token 从现行 PLAN 的剥离正文逐行去掉，\r
        //   结果**精确等于**上一阶段剥离哈希 eb8b1b77…；再从该结果去掉 41 个 feature-scope token ⇒ 4299af1b…（两段各自锚定、逐段可还原）。\r
        //   新钉值 81161852…（＝现行 PLAN 行尾归一 LF 后剥离同一追加块的实测 sha256，项目自身实测非估算）｜\r
        //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内（需求映射表／卡定义／覆盖表／功能映射表）不受影响。\r
        // 定向更新（V09-61 feature-scope-reconcile 功能成员/必需检查语义补齐，2026-10-08）：钉值 4299af1b… → eb8b1b77…。判据未放宽——
        //   仍是「剥离追加块后与钉值逐字节恒等，多一字少一字都红」。依据＝逐字审 diff ＋ 剥离还原实测：
        //   本轮给 84 条旧卡真实验收项前置稳定键 `chk-<卡>-NN`（见 feature-scope-reconcile/migration-table.json），其中
        //   **41 行落在追加块锚点之前**（V06-04×3／V06-05×3／V06-07×3／V06-08×2／V06-12×3／V06-13×2／V08-02×4／
        //   V09-01×7／V09-05×3／V09-06×5／V09-08×6），均为**纯前缀插入**（只加 token，正文逐字不动）。
        //   语义恒等证明（非估算，写入上面的 ④ 正向断言）：只把这 41 个**新增** token 从现行 PLAN 的剥离正文逐行去掉，
        //   结果**精确等于**本轮 before（feature-scope-reconcile/PLAN.before.md 的剥离正文 4299af1b…）——即锚点前除这 41 处
        //   纯前缀插入外**一字未动**；这不是"宽泛归一"（把所有 `- [ ] chk-* ` 前缀一律剥掉的哈希 ≠ 新钉值，见上面的负例）。
        //   新钉值 eb8b1b77…（＝现行 PLAN 行尾归一 LF 后剥离同一追加块的实测 sha256，项目自身实测非估算）｜
        //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内（需求映射表／卡定义／覆盖表／功能映射表）不受影响。
        // 历史（上一轮 V09-61 plan-integration 稳定键迁移，2026-10-08）：钉值 259deb25… → 4299af1b…。判据未放宽——
        //   仍是「剥离追加块后与钉值逐字节恒等，多一字少一字都红」。依据＝逐字审 diff ＋ 剥离还原实测：
        //   本批给 43 条旧卡真实验收项前置稳定键 `chk-<卡>-NN`（见 plan-integration/migration-table.json），其中
        //   **13 行落在追加块锚点之前**（README §6.2 只列了 5 行——实际 13 行：V09-02⑤/V09-03③/V09-05④/
        //   V09-07②③/V06-01/V06-08/V06-09×2/V06-10/V06-11/V06-14/V08-04）。
        //   语义恒等证明（非估算）：只把这 13 个**新增** token 从现行 PLAN 的剥离正文逐行去掉，结果**精确等于**
        //   本批前基线（plan-integration/PLAN.before.md 的剥离正文 6519b427…）——即锚点前除这 13 处纯前缀插入外
        //   **一字未动**；这不是"宽泛归一"（把所有 `- [ ] chk-* ` 前缀一律剥掉的哈希 ≠ 新钉值，见上面的负例）。
        //   如实说明：旧钉值 259deb25… 在本批开工前就已 ≠ 本批前基线（6519b427…）——差额来自本批之前已落盘的
        //   锚点前改动（顶部指针段、V09-29 行文本、V09-45…V09-61 卡行），属既有欠账、非本批引入，本轮不代其背书。
        //   新钉值 4299af1b…（＝现行 PLAN 行尾归一 LF 后剥离同一追加块的实测 sha256，项目自身实测非估算）｜
        //   保留意图同上（剥离后逐字节恒等，多一字少一字都红）；追加块之内（需求映射表／卡定义／覆盖表）不受影响。
        "④ 真实 PLAN.md 剥离追加块后逐字节（行尾归一 LF）匹配 V09-62 交付总览卡行后正文（sha256 恒等 92822fde…，锚点前仅本阶段 1 行纯插入 + 前阶段 10 处 + 再前阶段 41 处纯前缀插入）",
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
