// V06-08 验证脚本（PLAN.md V06-08；DESIGN.md §3.5 待议处置为主契约）。
// 用法：pnpm verify:v06-08（或 node --import tsx scripts/verify-v06-08.ts）
//
// 本卡主要是界面卡，**浏览器侧**的三条检查项由 `python scripts/verify-v06-08-ui.py` 真开浏览器验
// （切三个隔离项目 / 断网重连 / 刷新 / 退回 / 待议处置 / 附录 B 哈希）。本脚本只补**非浏览器**的那部分：
//   · 待议处置记录（`src/server/work/decisions.ts`）的纯口径——定位引用三件套、只追加、
//     同文字不同来源不合并、理由/关联必填、采纳 ≠ 已实现；
//   · 四条新路由的源码级登记对账（远端清单与 index.ts 提及数一致，防"新增路由漏登记"）；
//   · 红线守卫：**待议原文只读**（处置只写 decisions.jsonl，待议文件首尾字节相同）、
//     repo 根 DESIGN.md 整文件（含附录 B）首尾哈希不变。
// 环境隔离：只用 `os.tmpdir()` 下的临时目录，不碰任何真实项目的 `.工作台/`；不起服务、不联网。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DECISION_ACTION_LABELS,
  DECISIONS_FILE,
  DECISION_ACTIONS,
  appendDecision,
  deriveDispositions,
  discussionContentHash,
  discussionEntriesOf,
  discussionRefKey,
  readDecisions,
  relatedImplementationOf,
  validateDecisionInput,
  type DecisionInput,
} from "../src/server/work/decisions";
import { isWorkError } from "../src/server/work/types";
import { REMOTE_ROUTES, REMOTE_WRITE_ROUTES, routeMentionCounts, routeMentionTotal } from "../src/server/remote-routes";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0608-verify-"));
let passCount = 0;
let failCount = 0;

function ok(cond: boolean, label: string): void {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount++;
  else {
    failCount++;
    process.exitCode = 1;
  }
}

const info = (msg: string): void => console.log(`[verify]   ${msg}`);
const sha256 = (s: string): string => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** 抛错并返回结构化 code（不合法输入要"明确拒绝"，不是静默吞） */
function errCodeOf(fn: () => unknown): string {
  try {
    fn();
    return "<no-error>";
  } catch (e) {
    return isWorkError(e) ? e.code : `<thrown:${(e as Error).name}>`;
  }
}

const DISCUSS = [
  "- `2026-09-20` 场景：同样文字不同来源",
  "- `2026-09-20` 场景：同样文字不同来源",
  "- `2026-09-20` 场景：第三条不同文字",
].join("\n");

function main(): void {
  console.log("[verify] V06-08 待议处置口径 / 路由登记 / 原文只读（非浏览器部分）");
  console.log(`[verify]   node ${process.version} · ${process.platform} · repo ${REPO}`);

  // ── ① 定位引用三件套（discussion_ref）──
  info("① 待议条目的定位引用（原源 / 条目序号 / 原内容哈希）");
  const entries = discussionEntriesOf(DISCUSS, ".工作台/design.discuss.md");
  ok(entries.length === 3, `① 条目切分：${entries.length} 条（只认 "${"- `"}" 开头的行）`);
  ok(
    entries.every((e, i) => e.ref.index === i && e.ref.source === ".工作台/design.discuss.md"),
    "① 每条带原源与条文序号（0 起，按正文出现顺序）",
  );
  ok(
    entries[0].ref.content_sha256 === discussionContentHash(entries[0].text) &&
      entries[0].ref.content_sha256 === entries[1].ref.content_sha256,
    "① 内容哈希 = 原文整行的 sha256；两条文字相同的条目哈希相同（但序号不同）",
  );
  ok(
    discussionRefKey(entries[0].ref) !== discussionRefKey(entries[1].ref),
    "① 定位键 = 源 ␟ 序号 ␟ 哈希 → **同文字不同来源/序号不合并**（钥匙不同）",
  );
  const trailing = discussionEntriesOf(`${entries[0].text}   \n`, ".工作台/design.discuss.md");
  ok(
    trailing[0].ref.content_sha256 === entries[0].ref.content_sha256,
    "① 行尾空白不算改原文（哈希口径稳定，误报噪点不产生假的「原文已变」）",
  );

  // ── ② 输入校验：理由必填 / 采纳与替代必须关联 / 动作词表 ──
  info("② 处置输入的显式校验（缺什么拒什么，不写半条）");
  const ref0 = entries[0].ref;
  const base = {
    discussion_ref: ref0,
    action: "proposed",
    reason: "要加 XLSX 导入",
    decided_by: "user",
    role: "user",
    related: {},
  };
  ok(errCodeOf(() => validateDecisionInput({ ...base, reason: "  " })) === "INVALID_COMMAND",
     "② 理由为空 → 拒绝（没有理由等于没有处置依据）");
  ok(errCodeOf(() => validateDecisionInput({ ...base, action: "accepted" })) === "INVALID_COMMAND",
     "② 采纳但没有任何关联修订/任务 → 拒绝（§3.5 采纳后要关联，否则判不了是否实现）");
  ok(errCodeOf(() => validateDecisionInput({ ...base, action: "superseded" })) === "INVALID_COMMAND",
     "② 被替代但没有任何替代关系/关联 → 拒绝");
  ok(errCodeOf(() => validateDecisionInput({ ...base, action: "好像通过了" })) === "INVALID_COMMAND",
     `② action 只接受 ${DECISION_ACTIONS.join("/")}，别的词一律拒`);
  ok(errCodeOf(() => validateDecisionInput({ ...base, discussion_ref: { ...ref0, content_sha256: "x" } })) === "INVALID_COMMAND",
     "② 原内容哈希不是 64 位十六进制 → 拒绝（定位引用不合法就不写）");
  const accepted = validateDecisionInput({
    ...base,
    action: "accepted",
    related: { task_id: "T-9" },
  });
  ok(accepted.action === "accepted" && accepted.related?.task_id === "T-9",
     "② 采纳 + 关联任务 → 通过");

  // ── ③ 只追加 + 同文字不合并 + 派生态 ──
  info("③ 处置记录只追加 / 派生态按定位键（源+序号+哈希）");
  const workDir = path.join(tmpBase, "proj", ".工作台");
  const discussFile = path.join(workDir, "design.discuss.md");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(discussFile, DISCUSS, "utf8");
  const discussBefore = fs.readFileSync(discussFile, "utf8");

  const r1 = appendDecision(workDir, { ...accepted, reason: "第一条：采纳并关联 T-9" } as DecisionInput);
  const fileAfterFirst = fs.readFileSync(path.join(workDir, DECISIONS_FILE), "utf8");
  const r2 = appendDecision(workDir, {
    discussion_ref: entries[1].ref,
    action: "superseded",
    reason: "第二条：被替代",
    decided_by: "user",
    role: "user",
    related: { task_id: "T-9" },
    supersedes: null,
  });
  const afterTwo = fs.readFileSync(path.join(workDir, DECISIONS_FILE), "utf8");
  ok(afterTwo.startsWith(fileAfterFirst), "③ 只追加：第二次写入后，第一次的整段字节原样还在文件头部");
  ok(
    fs.readFileSync(discussFile, "utf8") === discussBefore,
    "③ 待议原文一个字节都没改（处置只写 decisions.jsonl）",
  );
  const read = readDecisions(workDir);
  ok(read.records.length === 2 && read.corrupt === 0, `③ 读回 ${read.records.length} 条处置记录，零坏行`);
  const disp = deriveDispositions(entries, read.records);
  ok(
    disp[discussionRefKey(entries[0].ref)].status === "accepted" &&
      disp[discussionRefKey(entries[1].ref)].status === "superseded" &&
      disp[discussionRefKey(entries[2].ref)].status === "none",
    "③ 两条文字相同的待议各自有自己的派生态（未处置的那条仍是待处理）",
  );
  ok(
    disp[discussionRefKey(entries[0].ref)].status_label === DECISION_ACTION_LABELS.accepted &&
      disp[discussionRefKey(entries[0].ref)].history.length === 1,
    "③ 派生态带中文标签与历史记录（界面只渲染，不自己推状态）",
  );
  // 同一 key 追加第二条 → 取最后一条
  appendDecision(workDir, {
    discussion_ref: entries[0].ref,
    action: "rejected",
    reason: "后来改主意了：驳回",
    decided_by: "user",
    role: "user",
    related: {},
  });
  const disp2 = deriveDispositions(entries, readDecisions(workDir).records);
  ok(
    disp2[discussionRefKey(entries[0].ref)].status === "rejected" &&
      disp2[discussionRefKey(entries[0].ref)].history.length === 2,
    "③ 同一条待议再处置一次 → 当前态取最后一条，历史两条都在（不覆盖旧记录）",
  );
  // 坏行如实计数
  fs.appendFileSync(path.join(workDir, DECISIONS_FILE), "{ 这不是合法 JSON\n", "utf8");
  ok(readDecisions(workDir).corrupt === 1, "③ 坏行如实计数（不静默吞掉「有坏行」这件事）");
  info(`③ 处置记录 id 形如 ${r1.decision_id} / ${r2.decision_id}`);

  // ── ④ 采纳 ≠ 已实现 ──
  info("④ 采纳 ≠ 已实现（只有用户验收接受才算实现）");
  const notImpl = relatedImplementationOf("T-9", { status: "result_submitted", status_label: "结果已提交" }, "pending");
  ok(!notImpl.implemented && notImpl.note.includes("采纳不等于已实现"),
     "④ 关联任务只是「结果已提交」→ implemented=false，并明说采纳不等于已实现");
  const noTask = relatedImplementationOf("T-9", null, "pending");
  ok(!noTask.implemented && noTask.note.includes("尚未开工"), "④ 关联任务没有任何执行状态 → 明说尚未开工");
  const done = relatedImplementationOf("T-9", { status: "result_submitted", status_label: "结果已提交" }, "accepted");
  ok(done.implemented, "④ 只有用户验收 accepted 才算已实现");

  // ── ⑤ 路由登记对账（新增路由漏登记会被抓住）──
  info("⑤ 四条新路由在 remote-routes.ts 的登记与 index.ts 源码提及数一致");
  const ids = ["plan-read", "discussions-read", "discussions-decide", "acceptance-read", "acceptance-record"];
  const found = REMOTE_ROUTES.filter((r) => ids.includes(r.id));
  ok(found.length === ids.length, `⑤ 五条新路由全部登记（${found.map((r) => r.id).join("、")}）`);
  ok(
    found.filter((r) => r.kind === "write").every((r) => r.method === "POST"),
    "⑤ 两条写路由（待议处置 / 人工验收）方法为 POST（只读模式下由 S2 红线先拒）",
  );
  const src = fs
    .readFileSync(path.join(REPO, "src/server/index.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  const count = (hay: string, needle: string): number => {
    let n = 0;
    let i = hay.indexOf(needle);
    while (i >= 0) {
      n++;
      i = hay.indexOf(needle, i + needle.length);
    }
    return n;
  };
  const anchorsOk = found.every((r) => r.anchors.every((a) => count(norm(src), norm(a)) === 1));
  ok(anchorsOk, "⑤ 五条新路由的锚点在 index.ts（剥注释）里各恰好命中 1 次（防漂移对账的锚点唯一）");
  const scanned: Record<string, number> = {};
  for (const m of src.matchAll(/req\.method === "(GET|POST|PUT|DELETE)"/g)) {
    scanned[m[1]] = (scanned[m[1]] ?? 0) + 1;
  }
  const manifest = routeMentionCounts();
  ok(
    (scanned.GET ?? 0) === manifest.GET && (scanned.POST ?? 0) === manifest.POST,
    `⑤ GET/POST 提及数一致（源码 ${scanned.GET}/${scanned.POST} == 清单 ${manifest.GET}/${manifest.POST}，` +
      `清单共 ${REMOTE_ROUTES.length} 条 / ${routeMentionTotal()} 处提及）`,
  );
  ok(
    (scanned.DELETE ?? 0) === (manifest.DELETE ?? 0),
    `⑤ DELETE 提及数对账齐平（源码 ${scanned.DELETE} == 清单 ${manifest.DELETE}）——` +
      "2026-09-20 V06-13 全链落地补登记（chat-session-delete）后由红转绿",
  );

  // ── ⑤-补（2026-09-20 第二轮裁定 2）：上面那条"相等"保留不动，另给**被补登记的那条 DELETE 路由**
  //    补三条身份校验。**不**把 DELETE 总数钉死（裁定明说"不必永久钉死总数为 6"）——
  //    只钉这条路由的"唯一登记 / 归属写 / 远端真被拒"，总数继续靠上面的动态相等断言把关。
  const delPath = "/api/projects/:id/chat/sessions/:sid";
  const delRegistered = REMOTE_ROUTES.filter((r) => r.method === "DELETE" && r.path === delPath);
  const delRoute = delRegistered[0] ?? null;
  const delAnchorHits = delRoute === null ? -1 : delRoute.anchors.reduce((n, a) => n + count(norm(src), norm(a)), 0);
  ok(
    delRegistered.length === 1 &&
      delRoute !== null &&
      delRoute.anchors.length === 1 &&
      delAnchorHits === 1,
    `⑤ 唯一登记：DELETE ${delPath} 在防漂移清单里**恰好一条**（不是"至少一条"：命中 ${delRegistered.length} 条），` +
      `源码 index.ts（剥注释）里的登记点也**恰好一处**（命中 ${delAnchorHits} 处）——补登记只能落在这一条上，重复登记/漏登记都会红`,
  );
  ok(
    delRoute !== null && delRoute.kind === "write",
    `⑤ 该条登记 kind === "write"（实为 ${delRoute?.kind}）：删聊天会话是写动作，只读模式下必须被拦`,
  );
  // 第 3 条（远端请求真的被拒）——**间接证据**：
  // 本脚本的头部口径就是"不起服务、不联网"（见文件头"不起服务、不联网"），进程内没有任何发 HTTP 的能力，
  // 所以**不硬造**一次远端请求（硬造只会得到一个与产品无关的自造断言）。改为：①钉住这条路由确实进了
  // `REMOTE_WRITE_ROUTES`（= 清单里 kind==="write" 的全集）；②钉住 `verify:s2` 段④ 里**遍历这张表、
  // 逐条真打、断言全部 403 REMOTE_READ_ONLY** 的那条既有断言还在（源码级指针，被删掉这里就红）。
  // 为什么是间接证据：真请求由 verify-s2 发（它起服务、造远程来源、逐条打），这里只证明"这条路由在被真打的
  // 那张表里、且那条逐条拒绝的断言仍在"——本条自身不产生任何 HTTP 证据。
  const s2Src = fs.readFileSync(path.join(REPO, "scripts/verify-s2.ts"), "utf8");
  const delInWriteSet = delRoute !== null && REMOTE_WRITE_ROUTES.some((r) => r.id === delRoute.id);
  ok(
    delInWriteSet &&
      s2Src.includes("for (const route of REMOTE_WRITE_ROUTES)") &&
      s2Src.includes("w.res.status === 403") &&
      s2Src.includes('codeOf(w.res) === "REMOTE_READ_ONLY"'),
    `⑤ 远端请求真被拒（间接证据，本脚本不发 HTTP）：该路由在 REMOTE_WRITE_ROUTES（当前 ${REMOTE_WRITE_ROUTES.length} 条）` +
      "，verify:s2 段④ 正是遍历这张表逐条真打并断言 403 REMOTE_READ_ONLY（该断言仍在：源码级指针校验通过）",
  );

  // ── ⑥ 红线：待议原文与塔台根文档只读 ──
  info("⑥ 红线守卫（本卡只追加处置记录，不改待议原文与塔台根文档）");
  const decSrc = fs.readFileSync(path.join(REPO, "src/server/work/decisions.ts"), "utf8");
  ok(
    decSrc.includes("fs.appendFileSync") && !/fs\.writeFileSync\(.*decisions/.test(decSrc),
    "⑥ decisions.ts 写路径只有 appendFileSync（没有改写/截断分支）",
  );
  ok(
    !/appendDiscuss|writeTextAtomic|designPath/.test(decSrc),
    "⑥ decisions.ts 不引用任何待议/设计书写入口（只读待议正文）",
  );

  console.log(`\n[verify] V06-08 结果：${passCount} PASS / ${failCount} FAIL（exit ${process.exitCode ?? 0}）`);
}

try {
  main();
} catch (e) {
  console.error(`[verify] 异常：${e instanceof Error ? e.stack : String(e)}`);
  process.exitCode = 1;
} finally {
  if (process.env.TATAI_KEEP_TMP === "1") {
    info(`保留现场：${tmpBase}`);
  } else {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}
