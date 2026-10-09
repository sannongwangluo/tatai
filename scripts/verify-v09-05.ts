// V09-05 验证脚本（PLAN.md V09-05 检查项；DESIGN.md §6.2 / §6.7 / §1.7、附录 E.5 / E.6 / E.10）
// 用法：pnpm verify:v09-05
//
// 覆盖点（逐条对应 V09-05 的检查项，判据不放宽）：
//   ① 标记区收敛：根 `AGENTS.md` 的 `tatai-mcp` 标记区与 `templates/agents-md-snippet.md` **逐字节一致**
//      （同时打印两边的 sha256）；一致性用**代码自己的收敛判据**判（`convergeAgentsMdText(...).action === "none"`
//      ⇒ 真跑 `attach:agents-md` 会走"一个字节都不写"的分支）；再**真跑** `attachAgentsMd("tatai")` 复核
//      `inserted === false` 且文件哈希前后不变。反例在脚本内构造、**不写盘**：把标记区换成旧 v1 文案 ⇒
//      收敛判据必须是 `update`，且**标记区之外的正文逐字节不动**。
//      **①-bis（2026-09-24 定向补修）**：更新已有标记区时**只替换 start..end 本体**——结束标记之后原有的
//      字节（CRLF/LF 尾巴、紧随其后的用户正文、没有尾换行）一个都不插、一个都不吞，其余部分逐字节不动；
//      四种尾巴各一条夹具做首轮/重跑字节核对，并有**负反证**证明"旧写法（模板尾 LF 拼在原有后缀之前）"
//      会被这几条断言判红。真跑写盘只在 `os.tmpdir()` 下的隔离夹具项目里做（不碰真实注册表）。
//   ② 标记区之外的正文同步：旧 v1 口径逐条**不在**、新口径逐条**在场**（旧/新对照逐条打印），
//      且 AGENTS.md 的 § 引用全部能在 DESIGN.md 的章节号里解析（改文档不破引用契约）。
//   ③ 工具面口径：文档计数 == 注册表 `TOOLS.length`（**不写死数字**）；`verify:u2` / `verify:m2` 的点名清单
//      与注册表**互等**（少点名或多点名都红）；模板不再含旧 v1「任务状态自动汇总成模块四色状态」的说法。
//   ④ 用户面文档（2026-09-30 首页精简后，`.工作台/` 目录说明与验证脚本表从 README 移入 docs/，判据不放宽）：
//      ① `docs/getting-started.md` 的 `.工作台/` 目录说明与 `templates/README.md` 的树**同源**（一级条目集合相等）、
//         逐条标「预置/程序自建·不预置」、与真实结构一致（对照塔台自己的 `.工作台/`）；
//      ② 验证脚本表（v0.7 / v0.8 / v0.9 批次）落在 `docs/development.md`，且 README **链到**该文档（不孤立）；
//      ③ 安全口径如实——通配绑定默认拒绝（用 `resolveRemoteConfig` 真跑反证），口径落在 `docs/capabilities.md`
//         且 README 链到它。
//   ⑤ 模板与体例：模板树每个一级条目要么在模板里存在、要么写明 `[不预置]`（与 `verify:l3` 同判据）；
//      `PLAN.md` 写明「卡行状态是唯一状态源」。
//   ⑥ 点名断言定向更新：`verify:v06-02` 里塔台 PLAN 行数的**期望值 == 当前实际解析行数**，
//      且留了「旧期望／依据／新期望／保留意图」的痕迹（不是删断言、不是放宽成 `>=`）。
//   ⑧ 台账同源（只读真数据目录，与 verify:des-current 同口径）：V08-05 的定义哈希 == 账本绑定（`583060cc…`），
//      且它**不在** `needs_rebind` 里；待重绑只允许是 V08-06（由有授权者按 §5.6 处置，本卡不代劳）。
//
//   ⑩ 施工图修订历史「同定义哈希、新正文」（2026-09-24 定向补修新增）：施工定义哈希没变、正文内容变过时，
//      不可变对象不得被误判成"被改过"而拒绝激活——旧对象逐字节不动、新正文另存到内容哈希名下、
//      两版原文都能取回、重复激活幂等、真篡改仍拒绝、定义哈希与 task 绑定稳定、备份里两版各在各的位置。
//      夹具走 `os.tmpdir()` 的隔离项目与隔离 `TATAI_HOME`（收尾删除，`TATAI_KEEP_TMP=1` 保留现场）。
// 只读红线：本脚本**不写**任何事件 / 基线 / 文档，也不碰真实注册表与真实纳管项目；对真实数据目录的
// `attachAgentsMd` 调用只走"标记区已一致"的分支（零写入）；①-bis 与 ⑩ 的真跑写盘一律落在 `os.tmpdir()` 的
// 隔离夹具里（收尾删除，`TATAI_KEEP_TMP=1` 保留现场）。
// 环境：需要**真实数据目录**（`TATAI_HOME`，缺省 `~/.tatai`）里的 tatai 台账与注册表——拿不到就如实报 FAIL，
// 不假装通过（同 verify:des-current 的口径）。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SNIPPET_END_MARK,
  SNIPPET_START_MARK,
  attachAgentsMd,
  convergeAgentsMdText,
  outsideRegionUnchanged,
} from "../src/server/attachAgentsMd";
import {
  REMOTE_ENABLE_ENV,
  REMOTE_HOST_ENV,
  REMOTE_WILDCARD_ENV,
  RemoteConfigError,
  resolveRemoteConfig,
} from "../src/server/remote-config";
import { addProject, resolveDataDir } from "../src/server/registry";
import { importTaskDefinitions, taskDefinitionHash, validateTaskDefinitions } from "../src/server/work/plan";
import { definitionHashOf, parsePlanTable, validatePlanTasks } from "../src/server/work/planValidate";
import {
  BACKUP_MANIFEST_FILE,
  createProjectBackup,
  restoreBackup,
  toBackupRel,
  verifyBackup,
} from "../src/server/work/backup";
import {
  activateBaseline,
  activeBaseline,
  baselinesPath,
  loadDocument,
  preserveDocumentRevision,
  readBaselineLog,
  recoverRevision,
  revisionObjectRel,
  type ActivateBaselineResult,
  type DocumentRecovery,
  type DocumentRevisionRef,
} from "../src/server/work/documents";
import { WorkError } from "../src/server/work/types";
import { alignDefinitionsAndStates, readTaskStates } from "../src/server/work/tasks";
import { projectWorkDir } from "../src/server/workstation";
import * as toolsIndex from "../src/mcp/tools/index";

const REPO = process.cwd();
const AGENTS_MD = path.join(REPO, "AGENTS.md");
const TEMPLATE = path.join(REPO, "templates", "agents-md-snippet.md");
const TEMPLATE_README = path.join(REPO, "templates", "README.md");
const TEMPLATE_DIR = path.join(REPO, "templates", ".工作台.example");

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else fail++, (process.exitCode = 1);
};
const info = (label: string): void => console.log(`[verify]   ${label}`);
const section = (t: string): void => console.log(`\n[verify] ═══ ${t} ═══`);
const read = (p: string): string => fs.readFileSync(p, "utf8");
const sha256 = (b: string | Buffer): string => crypto.createHash("sha256").update(b).digest("hex");
const short = (s: string): string => `${s.slice(0, 8)}…`;

const agentsText = read(AGENTS_MD);
const templateText = read(TEMPLATE);

// ───────────────────────── ① 标记区收敛 ─────────────────────────
section("① 根 AGENTS.md 标记区 ↔ templates/agents-md-snippet.md（逐字一致 + 真跑幂等）");

const regionStart = agentsText.indexOf(SNIPPET_START_MARK);
const endMarkAt = agentsText.indexOf(SNIPPET_END_MARK, regionStart + SNIPPET_START_MARK.length);
const regionEnd = endMarkAt + SNIPPET_END_MARK.length;
const region = regionStart >= 0 && endMarkAt > regionStart ? agentsText.slice(regionStart, regionEnd) : "";
const bodyBefore = agentsText.slice(0, Math.max(regionStart, 0));
const bodyAfter = regionEnd > 0 ? agentsText.slice(regionEnd) : agentsText;

ok(regionStart >= 0 && endMarkAt > regionStart, `① 根 AGENTS.md 有成对的 ${SNIPPET_START_MARK} / ${SNIPPET_END_MARK}`);
ok(
  region === templateText.trimEnd(),
  `① 标记区与模板**逐字节一致**（region ${region.length} B / sha256 ${short(sha256(region))}；` +
    `模板 trimEnd 后 ${templateText.trimEnd().length} B / sha256 ${short(sha256(templateText.trimEnd()))}）`,
);

const converged = convergeAgentsMdText(agentsText, templateText);
ok(converged.action === "none", `① 代码自己的收敛判据：action=${converged.action}（none = 已是模板口径，attach 会零写入）`);
ok(converged.text === agentsText, "① 收敛判据算出的新文本与盘上逐字节相同（⇒ 真跑 attach 不改动任何字节）");

// ①-bis 根文件侧：结束标记 → 文件尾之间**只有那一个原有换行**（首次收敛若多插一个 LF，这里必红）。
// 判据不写死常量：后缀行尾应与正文行尾同源（这份文件的行尾是随检出/原本写入带来的，收敛无权改写它）。
const bodyEol = bodyBefore.includes("\r\n") ? "\r\n" : "\n";
ok(
  bodyAfter === bodyEol,
  `①-bis 根 AGENTS.md：结束标记之后恰好是那一个原有换行（正文行尾 ${JSON.stringify(bodyEol)} ⇒ 实测后缀 ` +
    `${JSON.stringify(bodyAfter)}；若为 ${JSON.stringify("\n\r\n")} 就是首次收敛在结束标记后多插了一个 LF）`,
);
ok(
  agentsText.endsWith(`${SNIPPET_END_MARK}${bodyEol}`) && !agentsText.endsWith(`${SNIPPET_END_MARK}\n\r\n`),
  "①-bis 根 AGENTS.md：文件以结束标记 + 那一个换行收尾，没有「结束标记后多一个空行」（git diff --check 的 EOF 空行就是它）",
);

// 反例（不写盘）：把标记区换成旧 v1 文案 → 必须 update，且正文逐字节不动
const STALE_REGION_V1 = [
  SNIPPET_START_MARK,
  "本目录接了塔台 MCP。先 list_projects/select_project 对准项目，再 read_design/read_progress/list_tasks。",
  "",
  "- 开工、阻塞、交结果时调用 report_task_status：project_id/task_id/status（todo/doing/done/blocked）。",
  "- done 只表明这张卡的执行结果已交付，不等于整个项目完成。",
  SNIPPET_END_MARK,
].join("\n");
const staleText = `${bodyBefore}${STALE_REGION_V1}${bodyAfter}`;
const staleConverged = convergeAgentsMdText(staleText, templateText);
ok(
  staleConverged.action === "update" && staleConverged.text !== staleText,
  `① 反例：标记区过期（旧 v1 文案）⇒ action=${staleConverged.action}（收敛判据真的会改标记区，不是恒等函数）`,
);
ok(
  staleConverged.text.startsWith(bodyBefore) && staleConverged.text.endsWith(bodyAfter),
  "① 反例：收敛只换标记区，**标记区之外的正文逐字节不动**（前缀/后缀都原样）",
);
ok(
  staleConverged.text.slice(regionStart, regionStart + templateText.trimEnd().length) === templateText.trimEnd(),
  "① 反例：收敛后的标记区 == 模板（trimEnd 口径）",
);

// ── ①-bis 补修夹具（V09-05 定向补修，2026-09-24）：更新已有标记区时**只替换 start..end 本体** ──
// 缺陷（已确认）：更新分支把 normalizeSnippet(snippet)（末尾带一个 LF）拼在结束标记之后**原有后缀之前**，
// ⇒ 首次收敛就给文件尾多插一个 LF：含 CRLF 尾巴的根 `AGENTS.md` 变成 `<!-- tatai-mcp:end -->\n\r\n`
// （`git diff --check` 报 `AGENTS.md:88 new blank line at EOF`），card ①「标记区之外逐字节不动」首次更新未真正达成。
const templateBody = templateText.trimEnd();
const TAIL_CASES: { what: string; head: string; tail: string }[] = [
  { what: "CRLF 尾巴（结束标记后原有 CRLF）", head: "## 用户规矩\r\n\r\n- 这一行不许动。\r\n\r\n", tail: "\r\n" },
  { what: "LF 尾巴（结束标记后原有 LF）", head: "## 用户规矩\n\n- 这一行不许动。\n\n", tail: "\n" },
  {
    what: "尾巴之后紧跟用户正文（CRLF）",
    head: "## 用户规矩\r\n",
    tail: "\r\n\r\n## 用户后来加的规则\r\n\r\n- 这条也不能被覆盖。\r\n",
  },
  { what: "标记区在文件尾、没有尾换行", head: "## 用户规矩\n", tail: "" },
];
for (const c of TAIL_CASES) {
  const oldText = `${c.head}${STALE_REGION_V1}${c.tail}`;
  const conv = convergeAgentsMdText(oldText, templateText);
  const expect = `${c.head}${templateBody}${c.tail}`;
  // 负反证（旧写法的产物）：模板尾 LF 直接拼在原有后缀之前 ⇒ 恰好多一个 LF
  const legacy = `${c.head}${templateBody}\n${c.tail}`;
  ok(
    conv.action === "update" && conv.text === expect,
    `①-bis 首轮 update 逐字节：${c.what} ⇒ 新文本 == 原文前缀 ＋ 模板 trimEnd 后 ＋ **原有后缀一个字节不差**` +
      `（尾部实测 ${JSON.stringify(conv.text.slice(-20))}）`,
  );
  ok(
    legacy !== expect && legacy.length === expect.length + 1 && conv.text !== legacy,
    `①-bis 负反证：${c.what} ⇒ 旧写法产物（${legacy.length} B，多一个 LF）≠ 期望（${expect.length} B）——` +
      "这几条断言对旧缺陷有鉴别力，不是恒真",
  );
  ok(
    outsideRegionUnchanged(oldText, conv.text) &&
      conv.text.startsWith(c.head) &&
      conv.text.endsWith(c.tail),
    `①-bis outsideRegionUnchanged(旧, 新) === true：${c.what} —— 标记区之外的前缀与后缀逐字节还在`,
  );
  const rerun = convergeAgentsMdText(conv.text, templateText);
  ok(
    rerun.action === "none" && rerun.text === conv.text,
    `①-bis 重跑：${c.what} ⇒ action=${rerun.action} 且文本逐字节不再变（收敛一次即稳定，不会每次多一个 LF）`,
  );
}

// ①-bis 真跑写盘：隔离 `TATAI_HOME` ＋ 夹具项目（走真实写入服务，**不碰**真实注册表/项目/事实文件）
{
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0905-attach-"));
  const attachData = path.join(tmpHome, "home");
  fs.mkdirSync(attachData, { recursive: true });
  const mkFixture = (id: string, text: string): string => {
    const root = path.join(tmpHome, id);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), text, "utf8");
    addProject({ id, name: `V09-05 补修夹具 ${id}`, path: root, kind: "backend" }, attachData);
    return path.join(root, "AGENTS.md");
  };
  const realCase = (label: string, id: string, head: string, tail: string): void => {
    const file = mkFixture(id, `${head}${STALE_REGION_V1}${tail}`);
    const before = fs.readFileSync(file);
    const first = attachAgentsMd(id, attachData);
    const afterFirst = fs.readFileSync(file);
    const expect = Buffer.from(`${head}${templateBody}${tail}`, "utf8");
    ok(
      first.inserted === true && first.updated === true && first.created === false && afterFirst.equals(expect),
      `①-bis 真跑首轮 update（${label}）：磁盘字节 == 原文前缀 ＋ 模板 trimEnd 后 ＋ 原有后缀；` +
        `inserted=true/updated=true/created=false（文件 ${before.length} B → ${afterFirst.length} B，` +
        `sha256 ${short(sha256(afterFirst))}）`,
    );
    const regionDelta = Buffer.byteLength(templateBody, "utf8") - Buffer.byteLength(STALE_REGION_V1, "utf8");
    ok(
      afterFirst.length - before.length === regionDelta,
      `①-bis 真跑首轮（${label}）：字节增减只来自标记区本体本身（实测 ${before.length} B → ${afterFirst.length} B，` +
        `差 ${afterFirst.length - before.length} B ＝ 标记区长度差 ${regionDelta} B；多/少一个字节都红）`,
    );
    ok(
      outsideRegionUnchanged(before.toString("utf8"), afterFirst.toString("utf8")),
      `①-bis 真跑首轮（${label}）：outsideRegionUnchanged(写盘前, 写盘后) === true（标记区之外逐字节没动）`,
    );
    ok(
      !afterFirst.includes(Buffer.from(`${SNIPPET_END_MARK}\n\r\n`)) &&
        !afterFirst.includes(Buffer.from(`${SNIPPET_END_MARK}\n\n`)),
      `①-bis 真跑首轮（${label}）：结束标记之后没有"多出来的那个 LF"（判据取自缺陷现象本身）`,
    );
    const second = attachAgentsMd(id, attachData);
    const afterSecond = fs.readFileSync(file);
    ok(
      second.inserted === false && second.updated === false && afterSecond.equals(afterFirst),
      `①-bis 真跑重跑（${label}）：inserted=false/updated=false 且文件逐字节不动（sha256 ${short(
        sha256(afterSecond),
      )}）`,
    );
    ok(
      outsideRegionUnchanged(afterFirst.toString("utf8"), afterSecond.toString("utf8")),
      `①-bis 真跑重跑（${label}）：重跑前后 outsideRegionUnchanged === true（标记区之外的字节一字未动）`,
    );
  };
  realCase("CRLF 尾巴", "v0905-attach-crlf", TAIL_CASES[0].head, TAIL_CASES[0].tail);
  realCase("LF 尾巴", "v0905-attach-lf", TAIL_CASES[1].head, TAIL_CASES[1].tail);
  realCase("尾巴之后紧跟用户正文", "v0905-attach-posttext", TAIL_CASES[2].head, TAIL_CASES[2].tail);
  if (process.env.TATAI_KEEP_TMP !== "1") fs.rmSync(tmpHome, { recursive: true, force: true });
  info(`①-bis 真跑夹具目录：${tmpHome}（${process.env.TATAI_KEEP_TMP === "1" ? "已保留现场" : "已清理"}）`);
}

// 真跑 attach（只在"已一致"分支调用 ⇒ 实现里就是零写入；越界时宁可如实红）
{
  const dataDir = resolveDataDir();
  const beforeBytes = fs.readFileSync(AGENTS_MD);
  if (converged.action === "none") {
    let receipt = "";
    let inserted: boolean | null = null;
    try {
      const r = attachAgentsMd("tatai", dataDir);
      inserted = r.inserted;
      receipt = `inserted=${String(r.inserted)} created=${String(r.created)} updated=${String(r.updated)}`;
    } catch (e) {
      receipt = `抛错：${(e as Error).message}`;
    }
    const afterBytes = fs.readFileSync(AGENTS_MD);
    ok(
      inserted === false && beforeBytes.equals(afterBytes),
      `① 真跑 \`pnpm attach:agents-md -- tatai\` 等价调用：${receipt}；文件逐字节未变（sha256 ${short(sha256(afterBytes))}）`,
    );
    ok(
      afterBytes.slice(0, regionStart).equals(beforeBytes.slice(0, regionStart)) &&
        afterBytes.slice(regionEnd).equals(beforeBytes.slice(regionEnd)),
      `① 真跑前后「标记区之外的正文段」哈希不变（前 ${bodyBefore.length} B / 后 ${bodyAfter.length} B）`,
    );
  } else {
    ok(false, "① 标记区尚未与模板一致：先跑 `pnpm attach:agents-md -- tatai` 收敛，本脚本不代它写");
  }
  info(`数据目录：${dataDir}（本脚本只读它；attach 走 inserted=false 分支）`);
}

// ───────────────────────── ② 标记区之外的正文同步 ─────────────────────────
section("② 标记区之外的正文：旧 v1 口径不在、新口径在场（逐条对照）");

const BODY_PAIRS: { what: string; was: string; now: string }[] = [
  { what: "抬头版本戳", was: "本文件按 v0.6 同步于 2026-09-20", now: "本文件按 **v0.9 批次同步于 2026-09-24**" },
  {
    what: "§0 交付边界（软件已施工）",
    was: "当前 DES-V06 仅修订设计与施工图等相关文档",
    now: "软件已施工，不是只有文档：v0.6 的 14 张施工卡、v0.7 与 v0.8 两轮都已交付代码与服务",
  },
  { what: "§1 v2 事实层已上线", was: "是目标设计，未实现前不要自己造一套兼容协议", now: "**已上线并在运行**" },
  { what: "§1 三个真实项目已迁移", was: "V06-03 只在隔离项目验证迁移", now: "tatai／brain-memory／huojia-camou 三个真实项目已迁移" },
  { what: "§1 compat 文件是兼容投影", was: "切换前保留现有接口上报", now: "只作迁移/回填快照，不再冒充实时源" },
  { what: "§2 以 project_entry 为接续入口", was: "通过实际 MCP 的 list_tasks/read_progress 核实状态", now: "`select_project` → `project_entry`" },
  { what: "§6 目标接续入口已交付", was: "目标接续入口见 DESIGN §6.7；尚未实现", now: "目标接续入口见 DESIGN §6.7，**已实现并交付**" },
  { what: "§7 六图映射", was: "三视图为功能全景/系统架构/施工依赖", now: "共**六图**" },
];
for (const p of BODY_PAIRS) {
  ok(
    !agentsText.includes(p.was) && agentsText.includes(p.now),
    `② ${p.what}：旧口径不在「${p.was.slice(0, 22)}${p.was.length > 22 ? "…" : ""}」／新口径在场「${p.now.slice(0, 22)}${p.now.length > 22 ? "…" : ""}」`,
  );
}

const DESIGN = read(path.join(REPO, "DESIGN.md"));
const designSections = [...DESIGN.matchAll(/^#{2,4} (\d+(?:\.\d+)*)(?:\.| )/gm)].map((m) => m[1]);
const danglingRefs = [...agentsText.matchAll(/§(\d+(?:\.\d+)*)/g)]
  .map((m) => m[1])
  .filter((n) => !designSections.includes(n));
ok(
  danglingRefs.length === 0,
  `② AGENTS.md 的 § 引用全部可解析到 DESIGN.md 的章节号（悬空 ${danglingRefs.length}${
    danglingRefs.length ? "：" + [...new Set(danglingRefs)].join("、") : ""
  }）`,
);

// ───────────────────────── ③ 工具面口径 ─────────────────────────
section("③ 工具面：文档计数 == 注册表；点名清单与注册表互等");

const toolNames = (toolsIndex as { TOOLS: readonly { name: string }[] }).TOOLS.map((t) => t.name);
const toolSet = new Set(toolNames);
ok(
  toolSet.size === toolNames.length && toolNames.length > 0,
  `③ 注册表 src/mcp/tools/index.ts 的 TOOLS：${toolNames.length} 个工具、无重名（不写死数字，全部按实测比）`,
);
info(`注册表工具名：${toolNames.join("、")}`);

const README = read(path.join(REPO, "README.md"));
const readmeCount = /- (\d+) 个 stdio MCP 工具/.exec(README)?.[1];
ok(
  readmeCount !== undefined && Number(readmeCount) === toolNames.length,
  `③ README 的「N 个 stdio MCP 工具」== 注册表（README 写 ${String(readmeCount)}，注册表 ${toolNames.length}）`,
);

/** 从验证脚本源码里抽出 `const NAME = [ ... ];` 的字面量名字集合（点名清单的唯一来源就是这两张表） */
function extractArray(source: string, constName: string): string[] {
  const m = new RegExp(`const ${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*(?:as const)?\\s*;`).exec(source);
  if (m === null) return [];
  return [...m[1].matchAll(/"([a-z][a-z0-9_]+)"/g)].map((x) => x[1]);
}
const u2Src = read(path.join(REPO, "scripts", "verify-u2.ts"));
const u2Names = extractArray(u2Src, "MCP_TOOL_NAMES");
ok(
  u2Names.length === toolNames.length && u2Names.every((n) => toolSet.has(n)),
  `③ verify:u2 的点名清单（MCP_TOOL_NAMES，${u2Names.length} 个）与注册表互等——多 ${u2Names
    .filter((n) => !toolSet.has(n))
    .join("/") || "无"}／缺 ${toolNames.filter((n) => !u2Names.includes(n)).join("/") || "无"}`,
);

const m2Src = read(path.join(REPO, "scripts", "verify-m2.ts"));
// 2026-09-30（V09-23 同步域收口）：`verify-m2.ts` 新增分组常量 `V0923_TOOLS`（同步证据域三接口，
// 注册表 19 → 22）。本清单是"分组名的唯一来源"，按同一口径补一个分组名——判据未放宽（仍是
// 各组非空 + 合计恰好 == 注册表 + 逐个成员在注册表内；不动态从注册表生成期望）。
// 2026-10-03（统一优化 V09-32/33/35 与 V09-39）：`verify-m2.ts` 再增 `V0932_TOOLS`（read_plan/expand_module）
// 与 `V0939_TOOLS`（project_index），注册表 25 → 28。同一口径补分组名，判据仍为"恰好"，不放宽。
// 2026-10-04（V09-41 紧凑简报 task_brief，独立集成复审 P1-1）：`verify-m2.ts` 再增 `V0941_TOOLS`
// （task_brief），注册表 28 → 29。同一口径补分组名，判据仍为"恰好"，不放宽。
// 2026-10-06（P2/V09-47 只读预检 preflight_task_result，最终集成）：`verify-m2.ts` 再增 `V0947_TOOLS`
// （preflight_task_result），注册表 29 → 30。同一口径补分组名，判据仍为"恰好"，不放宽。
const m2Groups = ["EXPECTED", "M5_TOOLS", "V0610_TOOLS", "C015_TOOLS", "V0702_TOOLS", "V0704_TOOLS", "V0919_TOOLS", "V0923_TOOLS", "V0927_TOOLS", "V0932_TOOLS", "V0939_TOOLS", "V0941_TOOLS", "V0947_TOOLS", "V0952_TOOLS"];
const m2Names = m2Groups.flatMap((g) => extractArray(m2Src, g));
ok(
  m2Groups.every((g) => extractArray(m2Src, g).length > 0) &&
    m2Names.length === toolNames.length &&
    m2Names.every((n) => toolSet.has(n)),
  `③ verify:m2 的分组点名清单（${m2Names.length} 个：一期 8 + 扩充 2 + V06-10 三件套 + C-015 三件套 + rebind_task + doctor + V09-19 六图读口 + V09-23 同步域三接口 + V09-27/V09-28 三接口 + V09-32/33/35 两件 + V09-39 project_index + V09-41 task_brief + V09-47 preflight_task_result）与注册表互等——多 ${m2Names
    .filter((n) => !toolSet.has(n))
    .join("/") || "无"}／缺 ${toolNames.filter((n) => !m2Names.includes(n)).join("/") || "无"}`,
);

ok(
  !templateText.includes("任务状态会自动汇总成模块四色状态") &&
    templateText.includes("v1 兼容读数") &&
    templateText.includes("无状态记录"),
  "③ templates/agents-md-snippet.md 不再写旧 v1「任务状态自动汇总成模块四色状态」，改按 v2 口径（兼容读数 / 无状态记录）",
);
const integrationDoc = read(path.join(REPO, "docs", "agent-integration.md"));
const integrationCounts = [...integrationDoc.matchAll(/\d+\s*个\s*(?:stdio\s*)?MCP\s*工具/g)].map((m) => m[0]);
ok(
  integrationCounts.length === 0,
  `③ docs/agent-integration.md 不含 MCP 工具计数（有计数就必须同源对账；实测 ${integrationCounts.length} 处）`,
);

// ───────────────────────── ④ 用户面文档 ─────────────────────────
section("④ 用户面文档：目录说明同源 / 脚本表补批次 / 安全口径如实");
// 2026-09-30 首页精简：README 只留首页动线，`.工作台/` 长目录树与验证脚本表移入 docs/ 并加链接。
// 判据不放宽——事实源换成承载它的文档；同时要求 README 仍链到这些文档，避免"搬走了却没人找得到"。
const GETTING_STARTED_DOC = read(path.join(REPO, "docs", "getting-started.md"));
const DEVELOPMENT_DOC = read(path.join(REPO, "docs", "development.md"));
const CAPABILITIES_DOC = read(path.join(REPO, "docs", "capabilities.md"));

/** 取一份文档树里某个缩进层级的一级条目（含该行原文，用于逐条核对行尾标注） */
function treeEntries(text: string, depth: number): { name: string; line: string }[] {
  const prefix = depth === 0 ? "" : "│   ".repeat(depth);
  const re = new RegExp(`^${prefix}[├└]── ([^\\s]+)`);
  const out: { name: string; line: string }[] = [];
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (!fence) continue;
    const m = re.exec(line);
    if (m) out.push({ name: m[1], line });
  }
  return out;
}
const workbenchTree = treeEntries(GETTING_STARTED_DOC, 0); // 树根就是 `.工作台/`（2026-09-30 起落在 docs/getting-started.md）
const tplReadme = read(TEMPLATE_README);
const tplTree = treeEntries(tplReadme, 1); // templates/README 的树根是 `<项目根>/`
const workbenchSet = new Set(workbenchTree.map((e) => e.name));
const workbenchUnmarked = workbenchTree.filter((e) => !e.line.includes("[预置]") && !e.line.includes("[程序自建"));
ok(workbenchTree.length >= 12, `④ docs/getting-started.md 的 .工作台 目录树可解析（${workbenchTree.length} 条一级条目）`);
ok(
  workbenchTree.length === tplTree.length && tplTree.every((e) => workbenchSet.has(e.name)),
  `④ 上手文档的 .工作台 目录说明与 templates/README.md 的树**同源**（上手文档 ${workbenchTree.length} 条／模板 ${
    tplTree.length
  } 条，模板里有而上手文档没有的：${tplTree.filter((e) => !workbenchSet.has(e.name)).map((e) => e.name).join("、") || "无"}）`,
);
ok(
  workbenchUnmarked.length === 0 &&
    workbenchTree.some((e) => e.line.includes("[预置]")) &&
    workbenchTree.some((e) => e.line.includes("[程序自建")),
  `④ 上手文档的目录树**逐条**标了「预置 / 程序自建·不预置」两档口径（未标：${workbenchUnmarked.map((e) => e.name).join("、") || "无"}）`,
);
{
  const presetMissing = workbenchTree.filter(
    (e) => e.line.includes("[预置]") && !fs.existsSync(path.join(TEMPLATE_DIR, e.name)),
  );
  ok(
    presetMissing.length === 0,
    `④ 上手文档标「预置」的条目真的在 templates/.工作台.example/ 里存在（不在：${
      presetMissing.map((e) => e.name).join("、") || "无"
    }）`,
  );
  // 「与真实结构一致」：拿塔台自己的 `.工作台/` 实测（它就是本仓库里可直接核对的一份真实结构）。
  // 允许例外**逐条点名并给理由**（不是"允许缺失"的兜底）：自举项目不复制 design.md/design.discuss.md
  // （上手文档紧接着那段已写明），施工图是仓库根 PLAN.md 所以没有 `.工作台/plan.md`。
  const SELF_MANAGED_EXCEPTIONS: Record<string, string> = {
    "design.md": "塔台自举：设计书事实源是仓库根 DESIGN.md，`.工作台/` 里不复制一份",
    "design.discuss.md": "塔台自举：待议区在根 DESIGN.md 附录 B，`.工作台/` 里不复制一份",
    "plan.md": "塔台自举：施工图是仓库根 PLAN.md（不是 `.工作台/plan.md`）",
  };
  const selfWorkbench = path.join(REPO, ".工作台");
  const realMissing = workbenchTree.filter(
    (e) => SELF_MANAGED_EXCEPTIONS[e.name] === undefined && !fs.existsSync(path.join(selfWorkbench, e.name)),
  );
  ok(
    realMissing.length === 0,
    `④ 目录说明与**真实结构**一致（对照塔台自己的 \`.工作台/\`）：未标为自举例外的条目都存在（不在：${
      realMissing.map((e) => e.name).join("、") || "无"
    }；例外 ${Object.keys(SELF_MANAGED_EXCEPTIONS).length} 条已在脚本内逐条给理由）`,
  );
}
// 搬走了也要找得到：README 必须链到承载这些事实的文档（否则"首页精简"就变成"信息消失"）。
for (const [label, rel] of [
  ["上手文档", "docs/getting-started.md"],
  ["开发文档", "docs/development.md"],
  ["能力文档", "docs/capabilities.md"],
] as const) {
  ok(README.includes(rel), `④ README 链到${label} ${rel}（事实源搬走后仍可达）`);
}
for (const marker of ["verify:v07-01", "verify:v08-01", "verify:v09-05"]) {
  ok(DEVELOPMENT_DOC.includes(marker), `④ 验证脚本表（docs/development.md）补 ${marker}`);
}
ok(
  DEVELOPMENT_DOC.includes("交付结果 ≠ 已验收") && DEVELOPMENT_DOC.includes("提交 ≠ 验收"),
  "④ v0.9 行口径如实：执行结果已交付，但「交付结果 ≠ 已验收／提交 ≠ 验收」——不把未审计、未验收写成已验收（2026-09-30 修正 README 里过期的「其余 V09 卡尚未交付」）",
);
ok(
  CAPABILITIES_DOC.includes(REMOTE_WILDCARD_ENV) &&
    CAPABILITIES_DOC.includes("默认拒绝") &&
    CAPABILITIES_DOC.includes("公网路径没有开关"),
  `④ 安全口径如实：docs/capabilities.md 写明 ${REMOTE_WILDCARD_ENV} 存在、**默认拒绝**、公网路径没有开关`,
);

/** 安全边界不是只写在文档里：真跑配置解析，反证"默认拒绝" */
function remoteReject(env: NodeJS.ProcessEnv): string | null {
  try {
    resolveRemoteConfig(env);
    return null;
  } catch (e) {
    return e instanceof RemoteConfigError ? e.code : `非 RemoteConfigError：${(e as Error).message}`;
  }
}
const wildcardEnv = { [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "0.0.0.0" };
ok(
  remoteReject({ [REMOTE_HOST_ENV]: "0.0.0.0" }) === "WILDCARD_FORBIDDEN" &&
    remoteReject(wildcardEnv) === "WILDCARD_FORBIDDEN",
  `④ 反证①：绑通配地址默认被拒（不开远程 → WILDCARD_FORBIDDEN；开了远程但不开逃生口 → 仍 WILDCARD_FORBIDDEN）`,
);
const wildcardAllowed = remoteReject({ ...wildcardEnv, [REMOTE_WILDCARD_ENV]: "1" });
ok(
  wildcardAllowed === null && resolveRemoteConfig({ ...wildcardEnv, [REMOTE_WILDCARD_ENV]: "1" }).warnings.length > 0,
  `④ 反证②：显式逃生口 ${REMOTE_WILDCARD_ENV}=1 才放行，且带醒目警告（放行是明示的）`,
);
ok(
  remoteReject({ [REMOTE_ENABLE_ENV]: "1", [REMOTE_HOST_ENV]: "8.8.8.8" }) === "PUBLIC_HOST_FORBIDDEN",
  "④ 反证③：公网地址一律拒（PUBLIC_HOST_FORBIDDEN）——公网路径没有开关",
);

// ───────────────────────── ⑤ 模板标注与体例 ─────────────────────────
section("⑤ 模板树逐条标注 + PLAN 体例约定");

const tplTreeDeep = treeEntries(tplReadme, 1);
const unannotated = tplTreeDeep.filter(
  (e) => !fs.existsSync(path.join(TEMPLATE_DIR, e.name)) && !e.line.includes("[不预置]"),
);
ok(
  tplTreeDeep.length >= 15 && unannotated.length === 0,
  `⑤ 模板树每个一级条目要么在模板里存在、要么写明「[不预置]」（共 ${tplTreeDeep.length} 条；不满足：${
    unannotated.map((e) => e.name).join("、") || "无"
  }）`,
);

const PLAN = read(path.join(REPO, "PLAN.md"));
ok(
  PLAN.includes("卡行状态是唯一状态源") && PLAN.includes("检查项只是当时的验收内容记录，不承载状态"),
  "⑤ PLAN.md 写明「卡行状态是唯一状态源」＋检查项不承载状态（v0.8 及更早勾选位不追改、也不反推已完成）",
);

// ───────────────────────── ⑥ 点名断言定向更新 ─────────────────────────
section("⑥ verify:v06-02 的行数点名断言：期望 == 实测（旧/新期望留痕）");

const planTable = parsePlanTable(PLAN);
const planRows = planTable?.rows ?? [];
const v0602Src = read(path.join(REPO, "scripts", "verify-v06-02.ts"));
const expectedRows = Number(/tataiPlan\.tasks\.length === (\d+)/.exec(v0602Src)?.[1] ?? NaN);
ok(
  Number.isFinite(expectedRows) && expectedRows === planRows.length,
  `⑥ verify:v06-02 的行数期望（${String(expectedRows)}）== 当前解析出的塔台 PLAN 行数（${planRows.length}）`,
);
ok(
  /旧期望 29/.test(v0602Src) && /新期望 38/.test(v0602Src) && v0602Src.includes("保留意图"),
  "⑥ 该断言留了「旧期望 29 → 新期望 38 ＋ 依据 ＋ 保留意图」的痕迹（不是删断言、不是放宽成 >=）",
);
ok(
  /tataiIssues\.every\(\(i\) => i\.problem !== "dependency_cycle"/.test(v0602Src),
  "⑥ 同一段里「无成环、无缺验收内容」的意图仍在（只改期望值，判据未放宽）",
);
const planIssues = validatePlanTasks(planRows);
const defs = importTaskDefinitions(PLAN);
const defIssues = validateTaskDefinitions(defs.definitions);
ok(
  planIssues.length === 0 && defIssues.length === 0,
  `⑥ validatePlanTasks ${planIssues.length} 问题 / validateTaskDefinitions ${defIssues.length} 问题（均应为 0）`,
);
info(`PLAN 施工卡 ${planRows.length} 行；definitionHashOf(rows) = ${short(definitionHashOf(planRows))}`);

// ───────────────────────── ⑧ 台账同源（只读） ─────────────────────────
section("⑧ 台账同源：V08-05 定义哈希 == 账本绑定；V08-05 不在 needs_rebind");

const dataDir = resolveDataDir();
const workDir = projectWorkDir("tatai", dataDir);
const states = readTaskStates(workDir).states;
const v0805Def = defs.definitions.find((d) => d.task_id === "V08-05");
const v0805State = states["V08-05"];
const v0805CurrentHash = v0805Def === undefined ? "" : taskDefinitionHash({ ...v0805Def, change_id: v0805State?.definition_change_id ?? null });
ok(
  v0805Def !== undefined && v0805State?.definition_sha256 !== undefined,
  `⑧ 账本能读到 V08-05 的定义与状态（工作目录 ${workDir}；TATAI_HOME 没指对就如实红）`,
);
// 定向更新（V09-18，2026-09-26）：判据未放宽——仍是「当前定义哈希 == 账本绑定」（动态相等），
//   只是不再钉死具体哈希值：
//   旧期望：两侧都为 `583060cc…`（E.14.1 行损坏修复后的哈希）｜
//   依据：哈希会随合法定义修订推进——2026-09-25 终审返工给 V08-05 卡节补内容（acbb9fb）后已为 `bf09d31c…`，
//        2026-09-26 第 7 稿受检重导（seq 1990）后账本同步绑定；钉死旧值会把「定义合法演进」误判成漂移｜
//   新期望：当前定义哈希 == 账本绑定（值以实测为准）｜保留意图：行损坏修复后不漂移、不需要重绑。
ok(
  v0805CurrentHash !== "" && v0805CurrentHash === String(v0805State?.definition_sha256 ?? ""),
  `⑧ V08-05 的任务定义哈希 == 账本绑定（当前 ${short(v0805CurrentHash)} / 账本 ${short(
    String(v0805State?.definition_sha256 ?? ""),
  )}；沿革：583060cc…（E.14.1 修复后）→ bf09d31c…（2026-09-25 终审返工补登）→ 现值）——不再需要重绑`,
);
const alignment = alignDefinitionsAndStates(defs.definitions, states, defs.definitions[0]?.plan_revision ?? "");
const rebindIds = alignment.needs_rebind.map((r) => r.task_id);
ok(
  !rebindIds.includes("V08-05"),
  `⑧ V08-05 不在 needs_rebind 里（实测 needs_rebind=[${rebindIds.join("、") || "空"}]）`,
);
// 点名断言**定向更新（V09-05 连带缺陷补修，2026-09-24）**；判据未放宽——仍是**逐条点名可解释 + 成员资格**、
// V08-05 仍须不在其中：
//   旧口径 `rebindIds.every((id) => id === "V08-06")`（依据：E.14.1 的 V08-05 行损坏修复只让 V08-06 的
//   `dependency_evidence` 变过；`every` 对空集为真，故协调器处置完 V08-06 后集合为空也照样绿）｜
//   本次实测（本卡补修前）：`needs_rebind=[]`——协调器已在 08:02 前后按 §5.6 处置过 V08-06｜
//   新增可解释来源（本卡自身）：本卡定义新增检查项⑩「施工图修订同定义哈希、新正文的定向补修」，
//   该项是**验收内容** ⇒ `taskDefinitionHash(V09-05)` `b5d16fe9… → a97b2cd5…`、账本旧绑定随之待重绑
//   （实测本卡补修后 `needs_rebind=["V09-05"]`）；这是"定义真的变了"的正常后果，由有授权者按 §5.6 处置，
//   **本卡不代劳**（本卡不导入任务定义、不重绑）｜
//   保留意图：待重绑集合里**每一条都必须能点名解释**（出现第三个未解释的 id 就红），V08-05 必须已恢复；
//   集合可随协调器处置而收缩到空集，故判据是"成员资格"而不是"恰好等于某集合"（与旧口径同一威力、不放宽）｜
//   沿革：E.14.1 时 1 种来源（V08-06），本次 2 种来源（＋本卡自身）。
// 定向更新（V09-18，2026-09-26）：判据未放宽——仍是「逐条点名可解释 + 成员资格 + V08-05 不在其中」：
//   新增可解释来源（第 7 稿，批次 change-20260926-7a6e179f）：V08-01／V08-02＝GPT-6 裁定 4 补登卡节
//   （真实设计依据，卡范围未扩）→ 定义变化，已按 §5.6 由协调器 rebind continue 处置（账本 seq 2032/2033）；
//   V09-18＝本批次新卡（施工中，提交时经 claim_task 正常认领，不算未解释漂移）。
// 定向更新（V09-19，2026-09-26）：判据未放宽——仍是「逐条点名可解释 + 成员资格 + V08-05 不在其中」：
//   新增可解释来源（第 8 稿，批次 change-20260926-v09-19）：V09-19＝本批次新卡，已经 `import_plan_definitions`
//   受检导入（账本 seq 2269；`requirement_ids=[req-2026-09-26-r2]` 收进任务定义哈希，故与"不带映射的复算"不同键
//   ⇒ 出现在 needs_rebind 属**已登记的已知口径**，由有授权者按 §5.6 处置，不属未解释漂移）。
// 定向更新（V09-20，2026-09-26）：判据未放宽——仍是「逐条点名可解释 + 成员资格 + V08-05 不在其中」：
//   新增可解释来源（第 9 稿，批次 change-20260926-v0920-ui）：V09-20＝本批次新卡，已经
//   `import_plan_definitions` 受检导入（账本 seq 2473；`requirement_ids=[req-2026-09-26-r4]` 收进任务定义哈希，
//   故与"不带映射的复算"不同键 ⇒ 出现在 needs_rebind 属**已登记的已知口径**，由有授权者按 §5.6 处置，
//   不属未解释漂移；本批已按 §5.6 全量重绑 48 卡，回执 rebind-receipts-v0920rb3.json）。
// 定向更新（V09-21，2026-09-27）：判据未放宽——仍是「逐条点名可解释 + 成员资格 + V08-05 不在其中」：
//   新增可解释来源（第 10 稿，批次 change-20260927-v0921-rework）：V09-21＝本批次新卡，已经
//   `import_plan_definitions` 受检导入（账本 seq 2766；`requirement_ids=[req-2026-09-27-r1]` 收进任务定义哈希，
//   故与"不带映射的复算"不同键 ⇒ 出现在 needs_rebind 属**已登记的已知口径**，由有授权者按 §5.6 处置，
//   不属未解释漂移；V09-20 随本批重导（R2：需求映射表补 req-2026-09-26-r4 行使定义哈希变化，seq 2765，
//   属任务书登记的预期处置）。
// 定向更新（V09-22，2026-09-28）：判据未放宽——仍是「逐条点名可解释 + 成员资格 + V08-05 不在其中」：
//   新增可解释来源（第 11 稿，批次 change-20260928-d7982446）：V09-22＝本批次新卡（六图聚合节点全量可查看），
//   已经 `import_plan_definitions` 受检导入（账本 seq 3025/3026；`requirement_ids=[req-2026-09-28-r1]` 收进
//   任务定义哈希，故与"不带映射的复算"不同键 ⇒ 出现在 needs_rebind 属**已登记的已知口径**，由有授权者按 §5.6
//   处置，不属未解释漂移；上一批 V09-18…V09-21 已按 §5.6 处置完，本批实测集合收缩到只剩 [V09-22]）。
const JUSTIFIED_REBIND = ["V08-06", "V09-05", "V08-01", "V08-02", "V09-18", "V09-19", "V09-20", "V09-21", "V09-22"];
ok(
  !rebindIds.includes("V08-05"),
  `⑧ V08-05 不在 needs_rebind 里（实测 needs_rebind=[${rebindIds.join("、") || "空"}]）`,
);
ok(
  rebindIds.every((id) => JUSTIFIED_REBIND.includes(id)),
  `⑧ 待重绑每一条都能点名解释（只允许 ${JSON.stringify(JUSTIFIED_REBIND)}：V08-06＝E.14.1 的依赖方证据恢复、` +
    `V09-05＝本卡新增检查项⑩；V08-01/02＝第 7 稿裁定 4 补登卡节（已按 §5.6 rebind continue 处置）；` +
    `V09-18／V09-19／V09-20／V09-21／V09-22＝各批次新卡（均已受检导入并带 requirement_ids 映射，属已登记已知口径；` +
    `V09-20 另含第 10 稿 R2 的需求映射表补行重导；V09-22 为第 11 稿新卡））——` +
    `实测 [${rebindIds.join("、") || "空"}]`,
);
info(
  `台账读数：needs_rebind=[${rebindIds.join("、") || "空"}]；revision_stale=${alignment.revision_stale.length} 张；` +
    `not_started=${alignment.not_started.length} 张；same_source=${String(alignment.same_source)}`,
);

// ── ⑩ 施工图修订：同定义哈希 + 新正文（2026-09-24 定向补修） ──
//
// 现象：施工定义哈希（卡号/交付目标/依赖/完成证据）没变、正文内容变了（本卡给 PLAN 增补「体例约定」段即触发），
// 调 `/documents/activate` 被 `revision_object_tampered` 拒绝——`plan-revisions/` 只按**定义哈希**命名，
// 两份正文抢同一个文件名，新正文被误判成"旧对象被改过"。
// 下面用隔离夹具（`os.tmpdir()`，不碰真实注册表/数据）逐条钉住修复后的行为：旧对象不动、新正文另存、
// 两版原文都取回、重复激活幂等、真篡改仍拒绝、定义哈希与任务绑定不变、备份里两版都在各自位置。
section("⑩ 施工图修订：同定义哈希 + 新正文（对象名 / 激活 / 幂等 / 篡改 / 备份）");

const workErrorOf = (fn: () => unknown): WorkError | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof WorkError ? e : null;
  }
};

{
  const revHome = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0905-rev-"));
  const revData = path.join(revHome, "home");
  const revRoot = path.join(revHome, "proj");
  const revWb = path.join(revRoot, ".工作台");
  fs.mkdirSync(path.join(revWb, "work"), { recursive: true });
  fs.mkdirSync(revData, { recursive: true });
  addProject({ id: "v0905rev", name: "V09-05 修订历史夹具", path: revRoot, kind: "backend" }, revData);
  const relAbs = (rel: string): string => path.join(revRoot, rel);
  const revWrite = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(relAbs(rel)), { recursive: true });
    fs.writeFileSync(relAbs(rel), text, "utf8");
  };
  const revRead = (rel: string): string => {
    // 读不到 = 空串：断言照样红，但不让一个缺文件把整段打断（红要红得清楚，别崩）
    try {
      return fs.readFileSync(relAbs(rel), "utf8");
    } catch {
      return "";
    }
  };
  /** 激活**被拒时不抛到底**：返回一个"未创建"占位结果，让依赖它的断言逐条红、且红得看得见原因 */
  const NOT_CREATED = "（未创建）";
  const rejected = (r: ActivateBaselineResult): boolean => r.baseline.baseline_id === NOT_CREATED;
  const act = (input: Parameters<typeof activateBaseline>[1]): ActivateBaselineResult => {
    try {
      return activateBaseline("v0905rev", input, revData);
    } catch (e) {
      const empty = (kind: "design" | "plan"): DocumentRevisionRef => ({
        kind,
        source_path: "",
        content_sha256: "",
        definition_sha256: "",
        recovery: { kind: "immutable_copy", ref: "", key: "", sha256: "" },
      });
      return {
        created: false,
        // 占位结果里如实填 null：这一路是"激活被拒"，没有相对旧基线的推进可标注
        // （`advance` 是 `activateBaseline` 的如实标注字段，见 `BaselineAdvance`）
        advance: null,
        baseline: {
          baseline_id: NOT_CREATED,
          design_revision: empty("design"),
          plan_revision: empty("plan"),
          approved_by: "",
          approval_basis: `激活被拒：${(e as Error).message}`,
          approval_kind: "delegated_technical_review",
          active_at: "",
          supersedes: null,
        },
      };
    }
  };
  /** 按恢复位置取原文；取不回返回空串（同样只让相关断言红，不打断本段） */
  const recoverText = (ref: DocumentRecovery | null | undefined): string => {
    if (ref === null || ref === undefined) return "";
    try {
      return recoverRevision(revRoot, ref).text;
    } catch {
      return "";
    }
  };

  const rowsV1 = ["| T-1 | todo | 打地基 |  | `pnpm test` 通过 |", "| T-2 | todo | 砌墙 | T-1 | 验收清单勾完 |"];
  /** 卡定义**之外**的一段正文（体例说明）：只改它，内容哈希变、定义哈希不变 */
  const planDocOf = (note: string, rows: string[] = rowsV1): string =>
    [
      "# 夹具施工图",
      "",
      `**体例约定（卡行状态是唯一状态源）**：${note}`,
      "",
      "## 当前任务",
      "",
      "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n");
  const DESIGN_FIX = ["# 夹具设计书", "", "## 1 概述", "本夹具只动施工图侧。", ""].join("\n");

  const PLAN_A = planDocOf("第一版说明。");
  const PLAN_B = planDocOf("第一版说明。追加一句只解释体例的话。");
  const PLAN_C = planDocOf("第一版说明。追加一句只解释体例的话。再加一句。");
  const PLAN_D = planDocOf(
    "第一版说明。追加一句只解释体例的话。再加一句。",
    rowsV1.map((r) => r.replace("打地基", "打地基（改定义）")),
  );

  const approve = {
    approved_by: "v0905-rev-fixture-design-role",
    approval_basis: "V09-05 定向补修隔离夹具（技术审定口径，非真实用户 Gate）",
    approval_kind: "delegated_technical_review" as const,
  };

  // ① 首版：对象落 §2.6 主名（定义哈希）
  revWrite(".工作台/design.md", DESIGN_FIX);
  revWrite(".工作台/plan.md", PLAN_A);
  const first = act(approve);
  const docA = loadDocument("v0905rev", "plan", revData)!;
  const defA = docA.revision.definition_sha256;
  const primaryRel = revisionObjectRel("plan", defA);
  ok(
    first.created &&
      first.baseline.plan_revision.recovery.ref === primaryRel &&
      fs.existsSync(relAbs(primaryRel)) &&
      revRead(primaryRel) === PLAN_A,
    `⑩ ① 首版施工图：不可变对象落 §2.6 主名（${primaryRel}），存的逐字节就是原文`,
  );
  ok(
    first.baseline.plan_revision.content_sha256 === docA.revision.content_sha256 &&
      first.baseline.plan_revision.definition_sha256 === defA,
    `⑩ ① 基线同时记内容哈希（${short(docA.revision.content_sha256)}）与定义哈希（${short(defA)}）`,
  );

  // ② 同定义哈希、新正文
  revWrite(".工作台/plan.md", PLAN_B);
  const docB = loadDocument("v0905rev", "plan", revData)!;
  ok(
    docB.revision.content_sha256 !== docA.revision.content_sha256 && docB.revision.definition_sha256 === defA,
    `⑩ ② 正文变过（体例说明段）：内容哈希 ${short(docA.revision.content_sha256)} → ${short(
      docB.revision.content_sha256,
    )}，定义哈希不变（${short(defA)}）`,
  );
  ok(
    docB.revision.recovery === null &&
      definitionHashOf(parsePlanTable(PLAN_B)!.rows) === definitionHashOf(parsePlanTable(PLAN_A)!.rows),
    "⑩ ② 新正文还没保住（读路径如实 recovery=null，不拿旧对象冒充）；定义哈希逐字节仍在同一区间",
  );
  const primaryBytesBefore = fs.readFileSync(relAbs(primaryRel));
  const primaryStatBefore = fs.statSync(relAbs(primaryRel));
  const second = act({ ...approve, expected: { plan_content_sha256: docB.revision.content_sha256 } });
  const variantBRel = revisionObjectRel("plan", docB.revision.content_sha256);
  ok(
    !rejected(second),
    "⑩ ③ 同定义哈希的新正文**不得被拒**（若批准依据里出现 revision_object_tampered，就是本次缺陷正中靶心；" +
      `本次 approval_basis=${JSON.stringify(second.baseline.approval_basis)}）`,
  );
  ok(
    second.created &&
      second.baseline.baseline_id !== first.baseline.baseline_id &&
      second.baseline.supersedes === first.baseline.baseline_id,
    `⑩ ③ 新正文激活成功并留下新基线（${first.baseline.baseline_id} → ${second.baseline.baseline_id}，supersedes 连上）`,
  );
  const primaryStatAfter = fs.statSync(relAbs(primaryRel));
  ok(
    fs.readFileSync(relAbs(primaryRel)).equals(primaryBytesBefore) &&
      primaryStatAfter.size === primaryStatBefore.size &&
      primaryStatAfter.mtimeMs === primaryStatBefore.mtimeMs,
    `⑩ ③ 旧不可变历史对象**一个字节都没动**（sha256 ${short(sha256(primaryBytesBefore))}、大小/mtime 全同）`,
  );
  ok(
    second.baseline.plan_revision.recovery.ref === variantBRel && revRead(variantBRel) === PLAN_B,
    `⑩ ③ 新正文另存到内容哈希名下（${variantBRel}），存的逐字节是 PLAN_B`,
  );
  ok(
    second.baseline.plan_revision.definition_sha256 === defA &&
      second.baseline.plan_revision.content_sha256 === docB.revision.content_sha256,
    "⑩ ③ 新基线记的是**新**正文的内容哈希，定义哈希与旧基线一致（task 绑定未被动摇）",
  );
  ok(
    recoverText(first.baseline.plan_revision.recovery) === PLAN_A &&
      recoverText(second.baseline.plan_revision.recovery) === PLAN_B,
    "⑩ ③ 两版原文各按自己的恢复位置取回且逐字节相等（旧基线取 A、新基线取 B）",
  );
  ok(
    JSON.stringify(importTaskDefinitions(PLAN_A).definitions.map((d) => [d.task_id, taskDefinitionHash(d)])) ===
      JSON.stringify(importTaskDefinitions(PLAN_B).definitions.map((d) => [d.task_id, taskDefinitionHash(d)])),
    "⑩ ③ 逐任务定义哈希两版完全一致（正文里的体例说明没有动摇任何 task 的定义绑定）",
  );

  // ③ 第三次正文 + 幂等
  revWrite(".工作台/plan.md", PLAN_C);
  const third = act(approve);
  const variantCRel = revisionObjectRel("plan", third.baseline.plan_revision.content_sha256);
  ok(
    third.created &&
      readBaselineLog("v0905rev", revData).baselines.length === 3 &&
      revRead(variantCRel) === PLAN_C,
    `⑩ ④ 第三次正文再激活：第三条基线 + 第三个对象（${variantCRel}）；三份正文三个文件名，谁都没被覆盖`,
  );
  ok(
    fs.readFileSync(relAbs(primaryRel)).equals(primaryBytesBefore) && revRead(variantBRel) === PLAN_B,
    "⑩ ④ 前两份对象仍然逐字节在场（主名 A / 内容哈希名 B）",
  );
  const linesBeforeAgain = fs.readFileSync(baselinesPath("v0905rev", revData));
  const filesBeforeAgain = fs.readdirSync(path.join(revWb, "plan-revisions")).sort();
  const again = act(approve);
  ok(
    !rejected(again) &&
      !again.created &&
      again.baseline.baseline_id === third.baseline.baseline_id &&
      activeBaseline("v0905rev", revData)?.baseline_id === third.baseline.baseline_id,
    `⑩ ④ 同一份正文重复激活：幂等——返回原基线 ${third.baseline.baseline_id}，不重复追加（未被拒：${String(
      !rejected(again),
    )}）`,
  );
  ok(
    fs.readFileSync(baselinesPath("v0905rev", revData)).equals(linesBeforeAgain) &&
      JSON.stringify(fs.readdirSync(path.join(revWb, "plan-revisions")).sort()) === JSON.stringify(filesBeforeAgain),
    "⑩ ④ 重复激活后基线流水逐字节未变、`plan-revisions/` 也没多出/少掉一个文件",
  );

  // ④ 定义真变（改交付目标）：对象仍按 §2.6 落**新的定义哈希主名**
  revWrite(".工作台/plan.md", PLAN_D);
  const defD = definitionHashOf(parsePlanTable(PLAN_D)!.rows);
  const fourth = act(approve);
  ok(
    fourth.created &&
      defD !== defA &&
      fourth.baseline.plan_revision.definition_sha256 === defD &&
      fourth.baseline.plan_revision.recovery.ref === revisionObjectRel("plan", defD) &&
      revRead(revisionObjectRel("plan", defD)) === PLAN_D,
    `⑩ ⑤ 真改了定义（交付目标 ${short(defA)} → ${short(defD)}）：对象仍落定义哈希主名，主名落法未被本修复改变`,
  );

  // ⑤ 备份/恢复：每条基线的施工图修订都要落在**它记录的**恢复位置（同定义哈希的两份正文互不覆盖）
  const backupId = "b-fix3";
  const backupDestRoot = path.join(revHome, "backups");
  let backupMsg = "";
  let backupOk = false;
  let restoreOk = false;
  try {
    const created = createProjectBackup("v0905rev", {
      dataDir: revData,
      destRoot: backupDestRoot,
      backupId,
      now: "2026-09-24T00:00:00+08:00",
    });
    // 备份落在 `destRoot/<backupId>`（≠ 缺省 `backupDirOf(dataDir,…)`，本夹具指定了落点）
    const bDir = path.join(backupDestRoot, backupId);
    const manifest = JSON.parse(read(path.join(bDir, BACKUP_MANIFEST_FILE))) as {
      documents: { baseline_id: string; plan: { content_sha256: string; recovery: { ref: string } } }[];
    };
    const wanted = [first, second, third, fourth].map((b) => b.baseline);
    const mismatched = wanted.filter((b) => {
      const entry = manifest.documents.find((d) => d.baseline_id === b.baseline_id);
      if (entry === undefined) return true;
      const ref = entry.plan.recovery.ref;
      if (ref !== b.plan_revision.recovery.ref) return true;
      const abs = path.join(bDir, "workbench", toBackupRel(ref));
      return !fs.existsSync(abs) || sha256(fs.readFileSync(abs)) !== b.plan_revision.content_sha256;
    });
    backupOk = mismatched.length === 0 && created.documents.length === 4;
    backupMsg = `备份 ${created.documents.length} 条基线、物化 ${wanted.length} 份施工图修订；位置/哈希对不上的 ${mismatched.length} 条`;
    const verification = verifyBackup(bDir);
    const restore = restoreBackup(bDir, path.join(revHome, "restore"));
    restoreOk = verification.ok && restore.ok && restore.replaced === false;
    backupMsg += `；verifyBackup ok=${verification.ok}（${verification.failures.map((f) => f.code).join("、") || "无失败"}）、restoreBackup ok=${restore.ok}、replaced=${restore.replaced}`;
  } catch (e) {
    backupMsg = `抛错：${(e as Error).message}`;
  }
  ok(
    backupOk,
    `⑩ ⑥ 备份里每条基线的施工图修订都落在**它记录的**恢复位置且哈希相符（同定义哈希的两份正文各在各的文件名下）——${backupMsg}`,
  );
  ok(restoreOk, `⑩ ⑥ 备份通过核验并可恢复到隔离目录（两版原文按恢复位置取回的判据就是它）——${backupMsg}`);

  // ⑥ 真篡改仍拒绝（逐条临时改字节后还原）
  revWrite(".工作台/plan.md", PLAN_A);
  const objAbs = relAbs(primaryRel);
  const objOriginal = fs.readFileSync(objAbs);
  fs.writeFileSync(objAbs, PLAN_A.replace("打地基", "被手改过的目标"), "utf8");
  const tamperDef = workErrorOf(() => preserveDocumentRevision("v0905rev", "plan", revData));
  ok(
    tamperDef?.detail?.reason === "revision_object_tampered" && tamperDef?.detail?.stored_definition_sha256 !== undefined,
    `⑩ ⑦ 主名对象被改到**定义区** ⇒ 它连"这个定义哈希的修订"都不是了，保存路径拒绝（reason=${String(
      tamperDef?.detail?.reason,
    )}）`,
  );
  fs.writeFileSync(objAbs, PLAN_A.replace("| T-1 | todo |", "| T-1 | done |"), "utf8");
  const tamperRef = workErrorOf(() => preserveDocumentRevision("v0905rev", "plan", revData));
  ok(
    tamperRef?.detail?.reason === "revision_object_tampered" && tamperRef?.detail?.referenced_by_baseline === true,
    `⑩ ⑦ 主名对象只被改到**定义区之外**（状态列）、但首条基线引用着它 ⇒ 字节对不上，照样拒绝（reason=${String(
      tamperRef?.detail?.reason,
    )}，referenced_by_baseline=${String(tamperRef?.detail?.referenced_by_baseline)}）`,
  );
  ok(
    workErrorOf(() => recoverRevision(revRoot, first.baseline.plan_revision.recovery))?.detail?.reason ===
      "revision_object_tampered",
    "⑩ ⑦ 权威判据在取回侧：旧基线按恢复位置取原文，内容对不上就拒绝当原修订（不静默降级）",
  );
  fs.writeFileSync(objAbs, objOriginal, "utf8");
  revWrite(".工作台/plan.md", PLAN_B);
  fs.writeFileSync(relAbs(variantBRel), `${PLAN_B}\n（被人手改过）\n`, "utf8");
  const tamperVariant = workErrorOf(() => preserveDocumentRevision("v0905rev", "plan", revData));
  ok(
    tamperVariant?.detail?.reason === "revision_object_tampered" &&
      workErrorOf(() => recoverRevision(revRoot, second.baseline.plan_revision.recovery))?.detail?.reason ===
        "revision_object_tampered",
    `⑩ ⑦ 内容哈希名下的对象被改动 ⇒ 保存与取回两侧都拒绝（reason=${String(tamperVariant?.detail?.reason)}）`,
  );
  fs.writeFileSync(relAbs(variantBRel), PLAN_B, "utf8");
  revWrite(".工作台/plan.md", PLAN_A);
  const backToA = act(approve);
  ok(
    revRead(primaryRel) === PLAN_A &&
      !backToA.created &&
      backToA.baseline.baseline_id === first.baseline.baseline_id &&
      backToA.baseline.plan_revision.recovery.ref === primaryRel &&
      readBaselineLog("v0905rev", revData).baselines.length === 4,
    `⑩ ⑦ 现场还原后复跑：主名对象仍是 A、逐字节未变；回到 A 的正文按**内容哈希**幂等命中首条基线` +
      `（${backToA.baseline.baseline_id}，流水仍 4 条）`,
  );

  // ⑧ 恶意恢复位置反例：`baselines.jsonl` 是磁盘上的事实文件，`recovery.ref` 只是记录里的一个字符串
  //    （`readBaselineLog` 只校验它是非空字符串）——越界/形状不符的恢复位置必须在**复制之前**被拒，
  //    且不许往备份目录之外写一个字节。四条反例逐条真跑 `createProjectBackup`（隔离夹具内）。
  interface EvilRef {
    content_sha256: string;
    definition_sha256: string;
    recovery: { kind: string; ref: string; key: string; sha256: string };
  }
  const pwnedSrc = path.join(revHome, "pwned.md");
  fs.writeFileSync(pwnedSrc, "备份目录之外的文件：不该被复制进来\n", "utf8");
  const pwnedSha = sha256(fs.readFileSync(pwnedSrc));
  /** `..` 越界落点：`path.join(<destRoot>/<id>/workbench, "../../pwned.md")` ⇒ `<destRoot>/pwned.md` */
  const escapedDest = path.join(backupDestRoot, "pwned.md");
  const realLine = fs
    .readFileSync(baselinesPath("v0905rev", revData), "utf8")
    .trimEnd()
    .split(/\r?\n/)
    .at(-1)!;
  const evilLineOf = (tag: string, mutate: (plan: EvilRef) => void): void => {
    const rec = JSON.parse(realLine) as {
      baseline_id: string;
      supersedes: string | null;
      plan_revision: EvilRef;
    };
    rec.baseline_id = `bl-evil-${tag}`;
    rec.supersedes = backToA.baseline.baseline_id;
    mutate(rec.plan_revision);
    fs.writeFileSync(baselinesPath("v0905rev", revData), `${realLine}\n${JSON.stringify(rec)}\n`, "utf8");
  };
  const evilCases: { tag: string; what: string; mutate: (plan: EvilRef) => void }[] = [
    {
      tag: "escape",
      what: "`..` 跨目录到备份目录之外（`.工作台/../../pwned.md`）",
      mutate: (p) => {
        p.content_sha256 = pwnedSha;
        p.recovery.ref = ".工作台/../../pwned.md";
        p.recovery.key = pwnedSha;
        p.recovery.sha256 = pwnedSha;
      },
    },
    {
      tag: "absolute",
      what: `绝对路径（${pwnedSrc}）`,
      mutate: (p) => {
        p.recovery.ref = pwnedSrc;
        p.recovery.key = p.content_sha256;
      },
    },
    {
      tag: "key-mismatch",
      what: "文件名与 `recovery.key` 不符",
      mutate: (p) => {
        p.recovery.ref = `.工作台/plan-revisions/${p.content_sha256}.md`;
        p.recovery.key = p.definition_sha256;
      },
    },
    {
      tag: "cross-kind",
      what: "施工图修订串到另一类图纸目录（`design-revisions/`）",
      mutate: (p) => {
        p.recovery.ref = `.工作台/design-revisions/${p.content_sha256}.md`;
        p.recovery.key = p.content_sha256;
      },
    },
  ];
  const evilReadings: string[] = [];
  for (const c of evilCases) {
    evilLineOf(c.tag, c.mutate);
    const err = workErrorOf(() =>
      createProjectBackup("v0905rev", {
        dataDir: revData,
        destRoot: backupDestRoot,
        backupId: `b-evil-${c.tag}`,
        now: "2026-09-24T00:00:00+08:00",
      }),
    );
    const escapedExists = fs.existsSync(escapedDest);
    evilReadings.push(`${c.tag}=${String(err?.detail?.reason)}`);
    ok(
      err?.detail?.reason === "revision_object_ref_invalid" && !escapedExists,
      `⑩ ⑧ 恶意恢复位置被拒且不向备份目录外写：${c.what}（reason=${String(err?.detail?.reason)}；` +
        `备份目录外 ${path.relative(revHome, escapedDest)} 存在=${String(escapedExists)}）`,
    );
  }
  ok(
    evilReadings.every((r) => r.endsWith("=revision_object_ref_invalid")),
    `⑩ ⑧ 四条越界／形状不符的恢复位置逐条拒绝（${evilReadings.join("、")}）——合法形状的基线（⑥ 的备份）不受影响`,
  );
  info(`⑩ ⑧ 反例对照文件仍在场：${pwnedSrc}（${short(pwnedSha)}，未被复制进任何备份）`);

  if (process.env.TATAI_KEEP_TMP !== "1") fs.rmSync(revHome, { recursive: true, force: true });
  info(`⑩ 夹具目录：${revHome}（${process.env.TATAI_KEEP_TMP === "1" ? "已保留现场" : "已清理"}）`);
}

// ───────────────────────── 汇总 ─────────────────────────
console.log("");
console.log(`[verify] 结果：${pass} PASS / ${fail} FAIL`);
if (fail > 0) console.log("[verify] 存在 FAIL");
