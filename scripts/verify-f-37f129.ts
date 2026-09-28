// 缺陷 f-37f129d510c94de3 复测脚本（finding.opened seq 170，object_id=V06-02，DESIGN.md §2.6 / §2.9）
// 用法：pnpm verify:f-37f129（或 npx tsx scripts/verify-f-37f129.ts）
//
// 缺陷原文：施工图**记录性**改动（卡面勾选 `- [ ]` → `- [x]`，定义哈希不变、内容哈希变）后重激活基线
// 直接 400 `revision_object_tampered`「不可变历史对象已被改动」——误导性指控，且此后这条基线再也刷新不了。
// 复现配方（finding 原文）：隔离 `TATAI_HOME`、无 Git 的临时项目：建 design.md/plan.md → 首次 activateBaseline
// （created=true，内容 c1、定义 d）→ 只把卡面 `- [ ]` 改 `- [x]`（c2≠c1、定义仍 d）→ 再 activateBaseline → 抛。
//
// 本脚本逐条验「修好了没有」，判据不放宽（红就是红）：
//   ① 最小复现**必须通过**：记录性改动后重激活不再 400；新内容被保住（内容寻址新对象）；
//      历史对象字节未被覆盖；返回的 `advance` 如实标为「内容前进、定义未变」（plan=content_only）。
//   ② 幂等：同 content 同定义重复激活 → 返回原基线、不重复追加、盘上零新增文件。
//   ③ 真·篡改仍拒，且**文案区分**「真被改」与「内容前进」：`reason=revision_object_tampered` +
//      `tamper_kind=true_tamper`；三种真篡改现场（内容哈希名下的对象被改、主名对象被改到定义区、
//      主名对象只改定义区之外但被基线引用）逐一拒绝，写回原字节后现场复原、重激活回到幂等。
//   ④ CRLF 场景如实处理（Git blob 快速通道）：`core.autocrlf=true`（工作区 CRLF / 库内 LF）时快速通道
//      **必须让路**（落不可变副本，取回的字节与工作区逐字节相同）；`core.autocrlf=false`（原样入库）时
//      快速通道**真能用**（`git:<oid>` 取回逐字节相同）。两档都按实测字节判，不按"文件在库里"判。
//   ⑤ 真实项目 `tatai` 的既有基线与历史副本**只读**不受影响：流水里每条引用都能按恢复位置取回、哈希相符；
//      点名 `bl-adfcbbb6-2e4c7a9c`（施工图内容哈希 `2e4c7a9c…`）与同定义哈希下的旧主名对象仍在场。
//   ⑥ HTTP 端到端（缺陷现场走的就是这条路由）：`POST /api/projects/:id/documents/activate` 在记录性改动后
//      返回 200 + created=true + advance.plan=content_only（旧行为是 400 `revision_object_tampered`）；
//      真篡改时仍 400 且错误文案说清原因。
//
// 只读红线：真实项目 / 真实数据目录一律**只读**（⑦ 前后哈希对照自证）；所有真跑写盘落在 `os.tmpdir()`
// 的隔离夹具与隔离 `TATAI_HOME` 里，收尾删除（`TATAI_KEEP_TMP=1` 保留现场）。
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  activateBaseline,
  baselinesPath,
  loadDocument,
  recoverRevision,
  revisionObjectRel,
  sha256Hex,
  type ActivateBaselineResult,
  type DocumentRevisionRef,
} from "../src/server/work/documents";
import { WorkError } from "../src/server/work/types";

const REPO = process.cwd();
const PORT = 8843;
const REAL_ROOT = REPO;
const REAL_BASELINES = path.join(REAL_ROOT, ".工作台", "baselines.jsonl");
const REAL_PLAN_REVISIONS = path.join(REAL_ROOT, ".工作台", "plan-revisions");
const NAMED_BASELINE = "bl-adfcbbb6-2e4c7a9c";
const NAMED_PLAN_CONTENT = "2e4c7a9c326838eddb6d8c252911b08bf70a2ccf65b85596e83842dfbd560091";
const OLD_PRIMARY_OBJECT = "dd224237781614af71219d1132ab11e500ea9e7e20dc4d5d7f8598a6584d11e9";

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (cond: boolean, label: string): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
  }
};
const info = (label: string): void => console.log(`[verify]   ${label}`);
const skipNote = (label: string): void => {
  console.log(`[verify] SKIP ${label}`);
  skip++;
};
const section = (t: string): void => console.log(`\n[verify] ═══ ${t} ═══`);
const read = (p: string): string => fs.readFileSync(p, "utf8");
const sha256 = (b: string | Buffer): string => sha256Hex(b);
const short = (s: string): string => `${s.slice(0, 12)}…`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 取一次调用抛出的 WorkError（null = 没抛，或抛的不是 WorkError） */
function workErrorOf(fn: () => unknown): WorkError | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof WorkError) return e;
    console.log(`[verify]   （非 WorkError 抛出：${(e as Error).message}）`);
    return null;
  }
}

// ── 隔离环境 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-f37f129-"));
const dataDir = path.join(tmpBase, "home");
fs.mkdirSync(dataDir, { recursive: true });
const mkdirp = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true });
};
const write = (file: string, text: string): void => {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, text, "utf8");
};
const workbench = (root: string): string => path.join(root, ".工作台");
const projRoot = (id: string): string => path.join(tmpBase, id);

const registered: string[] = [];
function registerProject(id: string): string {
  const dir = projRoot(id);
  mkdirp(dir);
  registered.push(id);
  write(
    path.join(dataDir, "registry.json"),
    JSON.stringify(
      {
        version: 1,
        projects: registered.map((pid) => ({
          id: pid,
          name: `f-37f129 夹具 ${pid}`,
          path: projRoot(pid),
          kind: "backend",
          registered_at: "2026-09-25T00:00:00+08:00",
          last_opened_at: "2026-09-25T00:00:00+08:00",
        })),
      },
      null,
      2,
    ),
  );
  return dir;
}

/** 施工图夹具：任务表（进定义哈希）+ 卡面检查项（在表**之外**，只动内容哈希） */
const planDoc = (tick: string, eol = "\n"): string =>
  [
    "# f-37f129 夹具施工图",
    "",
    "## 当前任务",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| T-1 | todo | 打地基 |  | `pnpm test` 通过 |",
    "| T-2 | todo | 砌墙 | T-1 | 验收清单勾完 |",
    "",
    "## 卡面检查项（在任务表之外，不进施工定义哈希）",
    "",
    `- [${tick}] T-1 现场照片`,
    `- [${tick}] T-2 验收清单`,
    "",
  ].join(eol);
const designDoc = (eol = "\n"): string =>
  ["# f-37f129 夹具设计书", "", "## 1 概述", "记录性改动不得被误报成篡改。", ""].join(eol);

const APPROVAL = {
  approved_by: "gpt-6",
  approval_basis: "用户已委派的技术设计职责（§2.9）——本脚本只做复测，不代表任何用户 Gate",
  approval_kind: "delegated_technical_review" as const,
};
/** 激活；被拒时返回 null 并如实打印原因（断言层给出红，不把脚本打断） */
function activateOrNull(projectId: string): ActivateBaselineResult | null {
  try {
    return activateBaseline(projectId, APPROVAL, dataDir);
  } catch (e) {
    info(`激活被拒：${(e as Error).message.slice(0, 240)}`);
    return null;
  }
}

// ── git 夹具辅助（CRLF 档） ──
function git(root: string, args: string[], input?: Buffer): { okv: boolean; out: string } {
  try {
    const out = execFileSync("git", ["-C", root, ...args], {
      input,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { okv: true, out: Buffer.from(out).toString("utf8").trim() };
  } catch {
    return { okv: false, out: "" };
  }
}
const gitAvailable = (): boolean => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
function gitInit(root: string, autocrlf: string): boolean {
  mkdirp(root);
  return (
    git(root, ["init", "-q"]).okv &&
    git(root, ["config", "core.autocrlf", autocrlf]).okv &&
    git(root, ["config", "user.email", "verify-f-37f129@example.invalid"]).okv &&
    git(root, ["config", "user.name", "verify-f-37f129"]).okv
  );
}
const gitCommitAll = (root: string): boolean =>
  git(root, ["add", "-A"]).okv && git(root, ["commit", "-q", "-m", "夹具"]).okv;

// 真实项目只读现场快照（⑦ 前后对照，自证一个字节都没写）
const realBaselinesBefore = fs.existsSync(REAL_BASELINES) ? sha256(fs.readFileSync(REAL_BASELINES)) : null;
const realPlanRevisionsBefore = fs.existsSync(REAL_PLAN_REVISIONS)
  ? fs.readdirSync(REAL_PLAN_REVISIONS).sort()
  : null;

const spawned: ChildProcess[] = [];
process.on("exit", () => {
  for (const proc of spawned) {
    try {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    } catch {
      // 已经没了
    }
  }
});

// ═════════════════════ ① 最小复现（finding 原文配方） ═════════════════════
section("① 最小复现：记录性改动后重激活（隔离 TATAI_HOME、无 Git 的临时项目）");

const repro = "repro";
const reproRoot = registerProject(repro);
write(path.join(workbench(reproRoot), "design.md"), designDoc());
write(path.join(workbench(reproRoot), "plan.md"), planDoc(" "));

ok(!fs.existsSync(path.join(reproRoot, ".git")), "① 夹具项目根**没有** Git（复现配方要求：无 Git 的临时项目）");

const first = activateOrNull(repro);
ok(first !== null, "① 首次激活成功");
const c1 = loadDocument(repro, "plan", dataDir)!.revision;
const d = c1.definition_sha256;
info(`首次激活：created=${String(first?.created)} ${String(first?.baseline.baseline_id)}；施工图内容 ${short(c1.content_sha256)} / 定义 ${short(d)}`);
ok(first?.created === true, `① 首次激活 created=true（${String(first?.baseline.baseline_id)}）`);
ok(first?.advance?.plan === "initial", `① 首条基线 advance.plan=initial（如实标"第一次建立"）`);
ok(
  first?.baseline.plan_revision.recovery.ref === revisionObjectRel("plan", d) &&
    first?.baseline.plan_revision.recovery.sha256 === c1.content_sha256,
  `① 首个不可变对象落**定义哈希主名**（${revisionObjectRel("plan", d)}）——§2.6 的主名落法未被本修复改变`,
);
const primaryRel = revisionObjectRel("plan", d);
const primaryPath = path.join(reproRoot, primaryRel);
ok(
  fs.existsSync(primaryPath) && sha256(fs.readFileSync(primaryPath)) === c1.content_sha256,
  "① 主名对象逐字节等于当时的原文（内容 c1）",
);

// 复现配方的那一步：只把卡面 `- [ ]` 改成 `- [x]`
write(path.join(workbench(reproRoot), "plan.md"), planDoc("x"));
const c2 = loadDocument(repro, "plan", dataDir)!.revision;
info(`记录性改动后：施工图内容 ${short(c2.content_sha256)} / 定义 ${short(c2.definition_sha256)}`);
ok(c2.content_sha256 !== c1.content_sha256, "① 卡面勾选使**内容**哈希前进（c2 ≠ c1）");
ok(c2.definition_sha256 === d, "① 卡面勾选**不动**施工定义哈希（定义仍 d）——这正是缺陷配方里「定义未变」的前提");

const second = activateOrNull(repro);
ok(
  second !== null,
  "① 记录性改动后重激活**不再抛**（缺陷靶心：旧行为是 400 revision_object_tampered）",
);
ok(second?.created === true, `① 新内容产生**新基线**（created=true，${String(second?.baseline.baseline_id)}）——旧基线仍指向旧原文，不混用`);
ok(second?.baseline.baseline_id !== first?.baseline.baseline_id, "① 两条基线 id 不同（施工图段取内容哈希，不撞 id）");
ok(
  second?.advance?.plan === "content_only" && second?.advance?.design === "unchanged",
  `① 返回里**如实标注**「内容前进、定义未变」（advance.plan=${String(second?.advance?.plan)}；设计书那一侧没动，` +
    `advance.design=${String(second?.advance?.design)}）`,
);
const variantRel = revisionObjectRel("plan", c2.content_sha256);
ok(
  second?.baseline.plan_revision.recovery.ref === variantRel,
  `① 新正文另存到**内容寻址**对象（${variantRel}），不占用定义哈希主名`,
);
ok(
  second?.baseline.plan_revision.recovery.sha256 === c2.content_sha256 &&
    second?.baseline.plan_revision.content_sha256 === c2.content_sha256,
  "① 基线记录同时引用**内容哈希**（recovery.sha256 / content_sha256）与**定义哈希**（definition_sha256 未变）",
);
const recovered = second === null ? null : recoverRevision(reproRoot, second.baseline.plan_revision.recovery);
const livePlanText = read(path.join(workbench(reproRoot), "plan.md"));
ok(
  recovered?.text === livePlanText,
  "① 按新基线的恢复位置取回的原文与工作区现行 PLAN **逐字节相同**（新内容真被保住了）",
);
ok(
  recovered?.text.includes("- [x] T-1") === true && recovered?.text.includes("- [ ] T-1") === false,
  "① 保住的原文里勾选位确实是 `- [x]`（不是把旧正文当新正文）",
);
ok(
  fs.existsSync(primaryPath) && sha256(fs.readFileSync(primaryPath)) === c1.content_sha256,
  "① 旧对象（定义哈希主名）**逐字节未被覆盖**——历史对象不接受编辑（DESIGN §2.6）",
);
const filesAfterSecond = fs.readdirSync(path.join(workbench(reproRoot), "plan-revisions")).sort();
ok(
  filesAfterSecond.length === 2 &&
    filesAfterSecond.includes(`${d}.md`) &&
    filesAfterSecond.includes(`${c2.content_sha256}.md`),
  `① plan-revisions 里恰好两个对象（主名 ${short(d)} / 内容名 ${short(c2.content_sha256)}），旧对象仍在场`,
);
const oldRecovered = first === null ? null : recoverRevision(reproRoot, first.baseline.plan_revision.recovery);
ok(
  oldRecovered?.text.includes("- [ ] T-1") === true && oldRecovered?.text.includes("- [x] T-1") === false,
  "① **旧基线**仍能按它自己的恢复位置取回它当时的原文（勾选位是 `- [ ]`）——两版互不干扰",
);

// ═════════════════════ ② 幂等 ═════════════════════
section("② 同 content 同定义重复激活：幂等返回，盘上零新增");

const logBefore = read(baselinesPath(repro, dataDir));
const third = activateOrNull(repro);
ok(
  third?.created === false && third?.baseline.baseline_id === second?.baseline.baseline_id,
  `② 重复激活返回**原基线**（created=${String(third?.created)}，${String(third?.baseline.baseline_id)}）`,
);
ok(third?.advance === null, "② 幂等命中时 advance=null（没新建，就没有相对旧基线的推进可标）");
ok(read(baselinesPath(repro, dataDir)) === logBefore, "② 重复激活后 baselines.jsonl **逐字节未变**（没重复追加）");
ok(
  fs.readdirSync(path.join(workbench(reproRoot), "plan-revisions")).sort().join(",") === filesAfterSecond.join(","),
  "② 重复激活后 plan-revisions **没多出也没少掉**一个文件",
);

// ═════════════════════ ③ 真·篡改仍拒，且文案区分 ═════════════════════
section("③ 真·篡改仍必须拒，错误文案必须区分「真被改」与「内容前进」");

const variantPath = path.join(reproRoot, variantRel);
const variantBytesGood = fs.readFileSync(variantPath);
const primaryBytesGood = fs.readFileSync(primaryPath);

// ③-1 内容哈希名下的对象被改成别的内容
write(variantPath, `${planDoc("x")}\n<!-- 被人手改过 -->\n`);
const tamperVariant = workErrorOf(() => activateBaseline(repro, APPROVAL, dataDir));
ok(tamperVariant !== null, "③-1 内容寻址对象被改动 → 重激活**拒绝**（不静默采用）");
ok(
  tamperVariant?.detail?.reason === "revision_object_tampered" && tamperVariant?.detail?.tamper_kind === "true_tamper",
  `③-1 reason=revision_object_tampered + tamper_kind=true_tamper（${String(tamperVariant?.detail?.reason)} / ${String(
    tamperVariant?.detail?.tamper_kind,
  )}）`,
);
ok(
  tamperVariant !== null &&
    tamperVariant.message.includes("真·篡改") &&
    tamperVariant.message.includes("内容前进") &&
    tamperVariant.message.includes("记录性改动") &&
    tamperVariant.message.includes("不会报这个错"),
  "③-1 文案同时说清「这是真篡改」与「记录性改动（内容前进）不报这个错」——不再是一句误导性的「已被改动」",
);
fs.writeFileSync(variantPath, variantBytesGood);
ok(workErrorOf(() => activateBaseline(repro, APPROVAL, dataDir)) === null, "③-1 现场还原（写回原字节）后重激活恢复正常");

// ③-2 主名对象被改到**定义区**（改交付目标）⇒ 连"这个定义哈希下的修订"都不是了
write(primaryPath, planDoc(" ").replace("打地基", "把地基改成别的"));
const tamperDefinition = workErrorOf(() => activateBaseline(repro, APPROVAL, dataDir));
ok(tamperDefinition !== null, "③-2 主名对象被改到定义区 → 重激活**拒绝**");
ok(
  tamperDefinition?.detail?.reason === "revision_object_tampered" &&
    tamperDefinition?.detail?.tamper_kind === "true_tamper" &&
    typeof tamperDefinition?.detail?.stored_definition_sha256 === "string" &&
    tamperDefinition?.detail?.stored_definition_sha256 !== tamperDefinition?.detail?.object_key_sha256,
  "③-2 错误详情给出「重算定义哈希 ≠ 对象名」这条判据（stored_definition_sha256 / object_key_sha256）",
);
ok(
  tamperDefinition !== null &&
    tamperDefinition.message.includes("对不上名字") &&
    tamperDefinition.message.includes("真·篡改"),
  "③-2 文案点名判据（「对不上名字」）而不是笼统说「被改动」",
);
fs.writeFileSync(primaryPath, primaryBytesGood);

// ③-3 主名对象只改**定义区之外**（卡面检查项），但该对象被首条基线引用 ⇒ 照样拒
write(primaryPath, planDoc(" ").replace("- [ ] T-1 现场照片", "- [ ] T-1 现场照片（被改过）"));
const tamperReferenced = workErrorOf(() => activateBaseline(repro, APPROVAL, dataDir));
ok(tamperReferenced !== null, "③-3 被基线引用的主名对象只在定义区之外被改 → 照样**拒绝**（历史对象字节不许变）");
ok(
  tamperReferenced?.detail?.reason === "revision_object_tampered" &&
    tamperReferenced?.detail?.referenced_by_baseline === true &&
    tamperReferenced?.detail?.tamper_kind === "true_tamper",
  "③-3 详情标出 referenced_by_baseline=true（判据是「被基线引用 + 字节与记录不符」，不是「内容前进」）",
);
ok(
  tamperReferenced !== null && tamperReferenced.message.includes("已被基线流水引用"),
  "③-3 文案说明拒的依据（被基线流水引用），不会被读成「勾了检查项就该报错」",
);
fs.writeFileSync(primaryPath, primaryBytesGood);

// 反例对照：对象完好时同一现场**不报错**——证明上面三条拒的确实是"字节被改"，不是"内容前进"
const afterRestore = activateOrNull(repro);
ok(
  afterRestore?.created === false && afterRestore?.baseline.baseline_id === second?.baseline.baseline_id,
  "③ 反例对照：对象字节写回后同一次激活**零报错**且回到幂等（只有「字节是否被改」变了）",
);
ok(
  sha256(fs.readFileSync(primaryPath)) === c1.content_sha256 && sha256(fs.readFileSync(variantPath)) === c2.content_sha256,
  "③ 三个篡改现场全部复原：两个对象各自逐字节等于基线记录的原文",
);

// ═════════════════════ ④ CRLF 场景（Git blob 快速通道的如实处理） ═════════════════════
section("④ CRLF：Git blob 快速通道要么真能用（取回逐字节相同），要么老实让路落不可变副本");

if (!gitAvailable()) {
  skipNote("④ 本机没有可用的 git ⇒ CRLF / Git blob 快速通道两档无法实测（如实跳过，不算通过）");
} else {
  // ④-A core.autocrlf=true：工作区 CRLF、库内 LF ⇒ 快速通道必须让路
  const crlfAuto = "crlfauto";
  const crlfAutoRoot = registerProject(crlfAuto);
  write(path.join(workbench(crlfAutoRoot), "design.md"), designDoc("\r\n"));
  write(path.join(workbench(crlfAutoRoot), "plan.md"), planDoc(" ", "\r\n"));
  ok(gitInit(crlfAutoRoot, "true") && gitCommitAll(crlfAutoRoot), "④-A 夹具仓库就绪（core.autocrlf=true + 一次提交）");
  const planFile = path.join(workbench(crlfAutoRoot), "plan.md");
  const planBytes = fs.readFileSync(planFile);
  const oidOfWorkBytes = git(crlfAutoRoot, ["hash-object", "--stdin"], planBytes);
  const oidHead = git(crlfAutoRoot, ["rev-parse", "HEAD:.工作台/plan.md"]);
  ok(planBytes.toString("utf8").includes("\r\n"), "④-A 工作区施工图确实是 CRLF");
  ok(
    oidOfWorkBytes.okv && oidHead.okv && oidOfWorkBytes.out !== oidHead.out,
    `④-A 实测前提：工作区字节的 blob oid（${short(oidOfWorkBytes.out)}）≠ 库内 blob oid（${short(oidHead.out)}）——` +
      "`core.autocrlf` 让「文件在库里」和「库里的字节等于工作区字节」成了两件事",
  );
  const oidInDb = git(crlfAutoRoot, ["cat-file", "-t", oidOfWorkBytes.out]);
  ok(!oidInDb.okv, "④-A 工作区字节的那个 oid 在库内**取不回**（cat-file 失败）⇒ 快速通道只能让路");
  const crlfActivate = activateOrNull(crlfAuto);
  ok(
    crlfActivate?.baseline.plan_revision.recovery.kind === "immutable_copy",
    `④-A CRLF 工作区上**不被**引用成 git blob（recovery.kind=${String(
      crlfActivate?.baseline.plan_revision.recovery.kind,
    )}）——不拿一个取回后字节不同的对象冒充原文`,
  );
  const crlfRef = crlfActivate?.baseline.plan_revision;
  const crlfBack = crlfRef === undefined ? null : recoverRevision(crlfAutoRoot, crlfRef.recovery);
  ok(
    crlfBack?.bytes.equals(planBytes) === true && crlfRef?.content_sha256 === sha256(planBytes),
    "④-A 不可变副本取回的字节与工作区文件**逐字节相同**（CRLF 原样保住，基线能取回确切原文）",
  );

  // ④-B core.autocrlf=false：原样入库 ⇒ 快速通道真能用（且取回逐字节相同）
  const crlfRaw = "crlfraw";
  const crlfRawRoot = registerProject(crlfRaw);
  write(path.join(workbench(crlfRawRoot), "design.md"), designDoc("\r\n"));
  write(path.join(workbench(crlfRawRoot), "plan.md"), planDoc(" ", "\r\n"));
  ok(gitInit(crlfRawRoot, "false") && gitCommitAll(crlfRawRoot), "④-B 对照夹具仓库就绪（core.autocrlf=false + 一次提交）");
  const rawPlanFile = path.join(workbench(crlfRawRoot), "plan.md");
  const rawPlanBytes = fs.readFileSync(rawPlanFile);
  const rawActivate = activateOrNull(crlfRaw);
  ok(
    rawActivate?.baseline.plan_revision.recovery.kind === "git_blob",
    `④-B 库内字节逐字节等于原文时**就用** git 引用（recovery.kind=${String(
      rawActivate?.baseline.plan_revision.recovery.kind,
    )}，ref=${String(rawActivate?.baseline.plan_revision.recovery.ref)}）`,
  );
  const rawRef = rawActivate?.baseline.plan_revision;
  const rawBack = rawRef === undefined ? null : recoverRevision(crlfRawRoot, rawRef.recovery);
  ok(
    rawBack?.bytes.equals(rawPlanBytes) === true && rawRef?.content_sha256 === sha256(rawPlanBytes),
    "④-B git 引用取回的字节与原文逐字节相同（「能用就用、用的时候真能用」）",
  );

  // ④-C CRLF 项目上照样走完记录性改动 → 重激活（组合场景）
  write(rawPlanFile, planDoc("x", "\r\n"));
  const rawSecond = activateOrNull(crlfRaw);
  ok(
    rawSecond?.created === true && rawSecond?.advance?.plan === "content_only",
    "④-C CRLF 项目上的记录性改动同样不报错、如实标为 content_only",
  );
  const rawSecondRef = rawSecond?.baseline.plan_revision;
  const rawSecondBack = rawSecondRef === undefined ? null : recoverRevision(crlfRawRoot, rawSecondRef.recovery);
  ok(
    rawSecondBack?.bytes.equals(fs.readFileSync(rawPlanFile)) === true,
    "④-C 新正文按它自己的恢复位置取回，与工作区逐字节相同",
  );
}

// ═════════════════════ ⑤ 真实项目既有基线与历史副本（只读） ═════════════════════
section("⑤ 真实 tatai 的既有基线 / 历史副本只读不受影响（不重写历史）");

if (realBaselinesBefore === null) {
  skipNote("⑤ 真实项目没有 .工作台/baselines.jsonl ⇒ 本档无法实测（如实跳过，不算通过）");
} else {
  const rows = read(REAL_BASELINES)
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map(
      (l) =>
        JSON.parse(l) as {
          baseline_id: string;
          design_revision: DocumentRevisionRef;
          plan_revision: DocumentRevisionRef;
        },
    );
  let unreadable = 0;
  let copies = 0;
  let gitRefs = 0;
  for (const b of rows) {
    for (const [kind, ref] of [
      ["design", b.design_revision],
      ["plan", b.plan_revision],
    ] as const) {
      if (ref.recovery.kind === "immutable_copy") {
        copies++;
        const abs = path.join(REAL_ROOT, ref.recovery.ref);
        if (!fs.existsSync(abs) || sha256(fs.readFileSync(abs)) !== ref.recovery.sha256) {
          unreadable++;
          info(`⑤ ${b.baseline_id} ${kind}：副本缺失或哈希不符（${ref.recovery.ref}）`);
        }
      } else {
        gitRefs++;
      }
      try {
        if (sha256(recoverRevision(REAL_ROOT, ref.recovery).bytes) !== ref.content_sha256) {
          unreadable++;
          info(`⑤ ${b.baseline_id} ${kind}：取回的字节与基线记录的内容哈希不符`);
        }
      } catch (e) {
        unreadable++;
        info(`⑤ ${b.baseline_id} ${kind}：取不回（${(e as Error).message.slice(0, 120)}）`);
      }
    }
  }
  ok(
    unreadable === 0,
    `⑤ 流水 ${rows.length} 条基线、${copies} 个不可变副本引用 + ${gitRefs} 个 git 引用**全部能按恢复位置取回且哈希相符**（取不回 ${unreadable} 条）`,
  );

  const named = rows.find((b) => b.baseline_id === NAMED_BASELINE);
  ok(named !== undefined, `⑤ 点名基线 ${NAMED_BASELINE} 仍在流水里（历史只追加，不重写）`);
  ok(
    named?.plan_revision.content_sha256 === NAMED_PLAN_CONTENT &&
      named?.plan_revision.recovery.ref === revisionObjectRel("plan", NAMED_PLAN_CONTENT),
    `⑤ ${NAMED_BASELINE} 的施工图修订仍按**内容寻址**位置记录并可读（${String(named?.plan_revision.recovery.ref)}）`,
  );
  const namedBack = named === undefined ? null : recoverRevision(REAL_ROOT, named.plan_revision.recovery);
  ok(
    namedBack !== null && sha256(namedBack.bytes) === NAMED_PLAN_CONTENT,
    "⑤ 该基线按恢复位置取回的施工图原文与记录的内容哈希相符（取回能力没被本次修复动摇）",
  );
  info(
    `⑤ 参考（非断言）：该基线取回的施工图与**当前** PLAN.md ${
      namedBack !== null && namedBack.bytes.equals(fs.readFileSync(path.join(REAL_ROOT, "PLAN.md")))
        ? "逐字节相同"
        : "不同（PLAN.md 之后又改过——按 §2.9 走下一次重激活即可）"
    }`,
  );

  const referencing = rows.find(
    (b) => b.plan_revision.recovery.ref === revisionObjectRel("plan", OLD_PRIMARY_OBJECT),
  );
  const oldPrimaryAbs = path.join(REAL_ROOT, revisionObjectRel("plan", OLD_PRIMARY_OBJECT));
  ok(
    referencing !== undefined && fs.existsSync(oldPrimaryAbs),
    `⑤ 同定义哈希下的**旧主名对象**仍在场（${revisionObjectRel("plan", OLD_PRIMARY_OBJECT)}）——修复不清理、不覆盖历史对象`,
  );
  ok(
    referencing !== undefined && sha256(fs.readFileSync(oldPrimaryAbs)) === referencing.plan_revision.recovery.sha256,
    "⑤ 该旧对象逐字节等于引用它的那条基线记下的原文（旧基线仍能取回它那一版）",
  );
}

// ═════════════════════ ⑥ HTTP 端到端 ═════════════════════
section("⑥ HTTP 端到端：POST /api/projects/:id/documents/activate（缺陷现场走的就是这条路由）");

async function portListening(port: number): Promise<boolean> {
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

const httpProj = "http";
const httpRoot = registerProject(httpProj);
write(path.join(workbench(httpRoot), "design.md"), designDoc());
write(path.join(workbench(httpRoot), "plan.md"), planDoc(" "));

if (await portListening(PORT)) {
  skipNote(`⑥ 端口 ${PORT} 被占用 ⇒ 不抢端口、不杀他人进程，HTTP 端到端如实跳过（不算通过）`);
} else {
  const child = spawn(process.execPath, ["--import", "tsx", path.join("src", "server", "index.ts")], {
    cwd: REPO,
    env: { ...process.env, TATAI_HOME: dataDir, TATAI_PORT: String(PORT), TATAI_SEMANTIC_AUTO: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(child);
  child.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));
  let up = false;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  ok(up, `⑥ 隔离后端在 127.0.0.1:${PORT} 就绪（TATAI_HOME 为隔离目录，不碰真实数据）`);

  if (up) {
    const postActivate = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/projects/${httpProj}/documents/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(APPROVAL),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    const r1 = await postActivate();
    ok(r1.status === 200 && r1.body.created === true, `⑥ 首次 HTTP 激活 200 + created=true（${r1.status}）`);
    write(path.join(workbench(httpRoot), "plan.md"), planDoc("x"));
    const r2 = await postActivate();
    ok(
      r2.status === 200 && r2.body.created === true,
      `⑥ 记录性改动后 HTTP 重激活返回 **${r2.status}**（旧行为是 400 revision_object_tampered；created=${String(
        r2.body.created,
      )}）`,
    );
    const advance = r2.body.advance as { plan?: string } | null | undefined;
    ok(advance?.plan === "content_only", `⑥ HTTP 响应里如实标注 advance.plan=${String(advance?.plan)}（内容前进、定义未变）`);
    const r3 = await postActivate();
    ok(r3.status === 200 && r3.body.created === false, `⑥ 无改动再激活：200 + created=false（幂等，${r3.status}）`);

    // 真篡改经 HTTP 仍 400，且错误文案说清原因
    const httpVariantAbs = path.join(
      httpRoot,
      revisionObjectRel("plan", loadDocument(httpProj, "plan", dataDir)!.revision.content_sha256),
    );
    const goodVariant = fs.readFileSync(httpVariantAbs);
    write(httpVariantAbs, `${planDoc("x")}\n<!-- 手改 -->\n`);
    const r4 = await postActivate();
    const err = (r4.body.error ?? {}) as { code?: string; message?: string };
    ok(r4.status === 400 && err.code === "INVALID_COMMAND", `⑥ 真篡改经 HTTP 仍 400 INVALID_COMMAND（${r4.status}）`);
    ok(
      typeof err.message === "string" && err.message.includes("真·篡改") && err.message.includes("内容前进"),
      "⑥ HTTP 错误文案同样区分「真被改」与「内容前进」（不再是一条误导性的「已被改动」）",
    );
    fs.writeFileSync(httpVariantAbs, goodVariant);
    const r5 = await postActivate();
    ok(r5.status === 200, `⑥ 现场还原后 HTTP 重激活恢复 200（${r5.status}）`);
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // 已经没了
  }
  for (let i = 0; i < 40 && (await portListening(PORT)); i++) await sleep(250);
  ok(!(await portListening(PORT)), `⑥ 收尾：隔离后端进程已退出、端口 ${PORT} 已释放`);
}

// ═════════════════════ ⑦ 只读红线自证 ═════════════════════
section("⑦ 只读红线：全脚本跑完，真实项目的基线与历史副本一个字节都没变");

if (realBaselinesBefore !== null) {
  ok(
    sha256(fs.readFileSync(REAL_BASELINES)) === realBaselinesBefore,
    `⑦ 真实 .工作台/baselines.jsonl 逐字节未变（sha256 ${short(realBaselinesBefore)}）`,
  );
}
if (realPlanRevisionsBefore !== null) {
  ok(
    fs.readdirSync(REAL_PLAN_REVISIONS).sort().join(",") === realPlanRevisionsBefore.join(","),
    `⑦ 真实 .工作台/plan-revisions/ 文件集合未变（${realPlanRevisionsBefore.length} 个历史对象）`,
  );
}

// ── 收尾 ──
console.log("");
console.log(
  `[verify] 结果：${pass} PASS / ${fail} FAIL / ${skip} SKIP` +
    (skip > 0 ? "（SKIP = 环境不满足、如实跳过，**不算通过**）" : ""),
);
if (process.env.TATAI_KEEP_TMP !== "1") {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  console.log("[verify] 已清理隔离夹具目录（TATAI_KEEP_TMP=1 可保留现场）");
} else {
  console.log(`[verify] 保留现场：${tmpBase}`);
}
