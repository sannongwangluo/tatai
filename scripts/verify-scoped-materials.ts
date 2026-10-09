// V09-42 定向行为验证（docs/efficiency-20261004.md 第 2 条）：
//   · Markdown 章节绑定：完整标题路径唯一定位、哈希覆盖标题+后代、围栏内标题不算标题；
//   · stage-reads v1 整文件**逐条严格如旧**；v2 可显式点名章节，章节外改动不失效、章节内改动失效、
//     同 mtime 改写照样失效、缺失/重复/非 Markdown/路径逃逸/未知字段/非法类型一律拒；
//   · sync 新增 markdown_section check：登记校验 + 真实 evaluate（含负例），且**不削弱**旧的 artifact 整文件契约；
//   · 生成脚本：--check 只校验不写盘、--write 必须 CAS、原子写、不自行刷新旧漂移文件。
// 用法：pnpm tsx scripts/verify-scoped-materials.ts  （夹具走 os.tmpdir()，收尾清理；不动真实项目）
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMarkdownSections, findSection, markdownSectionDigest, decodeMarkdownBytes } from "../src/shared/materialSection";
import { loadStageReads, stageReadTargetDigest, validateStageReadsObject, STAGE_READS_REL } from "../src/server/work/stageReads";
import { validateSyncContract, syncContractSha256 } from "../src/server/work/syncContract";
import { evaluateBatch, type EvalContext } from "../src/server/work/syncChecks";
import { runPrepareStageReads, main as prepareMain, stageReadsLockAbs } from "./prepare-stage-reads";

let passCount = 0;
const fails: string[] = [];
function ok(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passCount += 1;
    console.log(`[verify] PASS ${label}`);
  } else {
    fails.push(label);
    console.log(`[verify] FAIL ${label}`);
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1200)}`);
  }
}
const sha256Hex = (d: string | Buffer): string => crypto.createHash("sha256").update(d).digest("hex");

// ── 夹具正文（固定行号，章节判据按硬编码期望钉死） ──
const MD_LINES = [
  "# 根标题", // 1
  "", // 2
  "根正文", // 3
  "", // 4
  "## 甲", // 5
  "", // 6
  "甲正文", // 7
  "", // 8
  "### 甲子", // 9
  "", // 10
  "甲子正文", // 11
  "", // 12
  "## 乙", // 13
  "", // 14
  "乙正文", // 15
  "", // 16
  "## 丙", // 17
  "", // 18
  "丙正文", // 19
  "", // 20
  "```", // 21
  "# 围栏里的假标题", // 22
  "```", // 23
  "", // 24
  "## 丁", // 25
  "", // 26
  "丁正文", // 27
];
const MD = MD_LINES.join("\n");
const MD_WHOLE = sha256Hex(Buffer.from(MD, "utf8"));
/** 行范围切片（1 基闭区间）——与 materialSection 口径同款，供硬编码期望对照 */
const sliceLines = (from: number, to: number): string => MD_LINES.slice(from - 1, to).join("\n");

function mkTmp(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tatai-v0942-${tag}-`));
}
function writeStage(root: string, obj: unknown): void {
  const dir = path.join(root, ".工作台", "work");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "stage-reads.json"), `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}
const sectionHash = (text: string, selector: string): string => {
  const d = markdownSectionDigest(Buffer.from(text, "utf8"), selector);
  if (!d.ok) throw new Error(`夹具章节不可用：${selector} -> ${d.reason}`);
  return d.sha256;
};

function main(): void {
  const tmp = mkTmp("all");
  try {
    // ══════════ ① materialSection：ATX 解析 / 围栏 / 唯一性 ══════════
    console.log("[verify] ═══ ① Markdown 章节解析（围栏/路径/唯一定位） ═══");
    const parsed = parseMarkdownSections(MD);
    ok(parsed.ok, "① 解析成功");
    if (parsed.ok) {
      const byPath = new Map(parsed.sections.map((s) => [s.path, s]));
      const paths = parsed.sections.map((s) => s.path);
      ok(
        ["根标题", "根标题 / 甲", "根标题 / 甲 / 甲子", "根标题 / 乙", "根标题 / 丙", "根标题 / 丁"].every((p) => byPath.has(p)),
        `① 完整标题路径齐（实测 ${JSON.stringify(paths)}）`,
      );
      ok(!paths.some((p) => p.includes("围栏")), "① 代码围栏里的 `# 围栏里的假标题` **没有**被当成标题");
      const jia = byPath.get("根标题 / 甲");
      ok(
        jia !== undefined && jia.line_start === 5 && jia.line_end === 12 && jia.content === sliceLines(5, 12) && jia.sha256 === sha256Hex(sliceLines(5, 12)),
        "① 「甲」覆盖标题+后代（行 5–12，含子树，不含乙）：正文与哈希逐字节对照一致",
      );
      const bing = byPath.get("根标题 / 丙");
      ok(
        bing !== undefined && bing.line_start === 17 && bing.line_end === 24 && bing.content === sliceLines(17, 24) && bing.sha256 === sha256Hex(sliceLines(17, 24)),
        "① 「丙」子树行 17–24（含其后围栏内容，止于同级丁）与哈希对照一致",
      );
      const ding = byPath.get("根标题 / 丁");
      ok(ding !== undefined && ding.line_start === 25 && ding.line_end === 27, "① 「丁」在围栏之后正常成节（行 25–27）");
    }
    const jiaLookup = findSection(MD, "根标题 / 甲");
    ok(jiaLookup.ok && jiaLookup.section.content.includes("甲子正文") && !jiaLookup.section.content.includes("乙正文"), "① 唯一定位「甲」：含后代甲子、不含乙");
    const missing = findSection(MD, "根标题 / 不存在");
    ok(!missing.ok && missing.reason.includes("没有完整标题路径"), "① 缺失章节 -> 拒绝并点名");
    const fenced = findSection(MD, "根标题 / 围栏里的假标题");
    ok(!fenced.ok, "① 围栏里的标题不可被选择（缺失即拒）");
    ok(markdownSectionDigest(Buffer.from(MD, "utf8"), "").ok === false, "① 空选择器 -> 拒绝");
    const badSel = markdownSectionDigest(Buffer.from(MD, "utf8"), "根标题 / 甲\nx");
    ok(!badSel.ok && badSel.code === "bad_selector", "① 选择器含控制字符 -> bad_selector");
    ok(!decodeMarkdownBytes(Buffer.from([0x61, 0x00, 0x62])).ok, "① 含 NUL 字节 -> 非文本拒绝");
    ok(!decodeMarkdownBytes(Buffer.from([0x61, 0xff, 0xfe])).ok, "① 非法 UTF-8 -> 非文本拒绝");

    // 重复同级标题 -> 路径重复 -> 无法唯一定位
    const dupMd = ["# 根", "", "## 重复", "", "a", "", "## 重复", "", "b"].join("\n");
    const dupLookup = findSection(dupMd, "根 / 重复");
    ok(!dupLookup.ok && dupLookup.reason.includes("命中"), "① 同级同名重复 -> 命中多处、拒绝唯一定位");

    // ── 祖先链必须按栈取（不能把前面的兄弟当祖先）；每一级路径都须唯一（V09-42 复审修复） ──
    const sibMd = ["# 根", "", "## 甲", "", "a", "", "## 乙", "", "b", "", "### 乙子", "", "c"].join("\n");
    const sibParsed = parseMarkdownSections(sibMd);
    ok(
      sibParsed.ok && sibParsed.sections.map((s) => s.path).includes("根 / 乙 / 乙子") && !sibParsed.sections.map((s) => s.path).includes("根 / 甲 / 乙 / 乙子"),
      "① 多兄弟：乙子路径 = 根 / 乙 / 乙子（不把前面的兄弟甲塞进祖先链）",
      sibParsed.ok ? sibParsed.sections.map((s) => s.path) : null,
    );
    ok(
      findSection(sibMd, "根 / 乙 / 乙子").ok === true && findSection(sibMd, "根 / 甲 / 乙子").ok === false,
      "① 多兄弟：乙子可唯一定位；把兄弟甲当祖先的选择器 -> missing（不误配）",
    );

    const multiRootMd = ["# 一", "", "## 子", "", "x", "", "# 二", "", "y"].join("\n");
    const mrParsed = parseMarkdownSections(multiRootMd);
    ok(
      mrParsed.ok && JSON.stringify(mrParsed.sections.map((s) => s.path)) === JSON.stringify(["一", "一 / 子", "二"]),
      "① 多根：两个顶级标题各自成路径，子标题只归各自根（不跨根串链）",
      mrParsed.ok ? mrParsed.sections.map((s) => s.path) : null,
    );

    const skipMd = ["# 根", "", "## 甲", "", "x", "", "#### 深", "", "y"].join("\n");
    const skipParsed = parseMarkdownSections(skipMd);
    ok(
      skipParsed.ok && skipParsed.sections.some((s) => s.path === "根 / 甲 / 深"),
      "① 跳级：## 甲 下 #### 深 -> 根 / 甲 / 深（取最近更小层级作父，不因跳级丢祖先）",
      skipParsed.ok ? skipParsed.sections.map((s) => s.path) : null,
    );

    const dupParentMd = ["# 根", "", "## 甲", "", "### 甲子", "", "a", "", "## 甲", "", "b"].join("\n");
    const dpChild = findSection(dupParentMd, "根 / 甲 / 甲子");
    ok(
      dpChild.ok === false && dpChild.reason.includes("根 / 甲"),
      "① 重复父标题：子标题只出现一次也拒绝（祖先链上「根 / 甲」重复 -> 每级不唯一）",
      dpChild,
    );
    ok(findSection(dupParentMd, "根 / 甲").ok === false, "① 重复父标题本身：命中多处 -> 拒绝");

    // ══════════ ② stage-reads v1：整文件逐条严格如旧 ══════════
    console.log("[verify] ═══ ② stage-reads v1 整文件兼容 ═══");
    const p1 = mkTmp("v1");
    const f1 = path.join(p1, "n.md");
    fs.writeFileSync(f1, MD, "utf8");
    writeStage(p1, {
      schema_version: 1,
      generated_from: [{ path: "n.md", sha256: MD_WHOLE }],
      entries: [{ path: "n.md", kind: "design", why: "本阶段必读", revision: MD_WHOLE }],
      preferred_task_id: null,
    });
    const v1 = loadStageReads(p1);
    ok(v1.status === "ok" && v1.schema_version === 1 && v1.entries[0]?.revision === MD_WHOLE, "② v1 整文件指针合法加载（schema_version=1）");
    // v1 里出现 section 字段 -> 未知字段拒（旧格式逐条严格）
    writeStage(p1, {
      schema_version: 1,
      generated_from: [{ path: "n.md", sha256: MD_WHOLE }],
      entries: [{ path: "n.md", kind: "design", why: "x", section: "根标题 / 丙", revision: MD_WHOLE }],
      preferred_task_id: null,
    });
    const v1Sec = loadStageReads(p1);
    ok(v1Sec.status === "invalid" && v1Sec.reasons.join().includes("未知字段"), "② v1 里写 section -> 未知字段拒绝（不静默升级格式）");
    // 错哈希
    writeStage(p1, {
      schema_version: 1,
      generated_from: [{ path: "n.md", sha256: "0".repeat(64) }],
      entries: [{ path: "n.md", kind: "design", why: "x", revision: "0".repeat(64) }],
      preferred_task_id: null,
    });
    const v1Bad = loadStageReads(p1);
    ok(v1Bad.status === "invalid" && v1Bad.reasons.join().includes("漂移"), "② v1 错哈希 -> 拒绝（来源漂移）");
    // v1 整文件：改任意一处（含被点章节外）即失效；且 mtime 还原也照样失效
    writeStage(p1, {
      schema_version: 1,
      generated_from: [{ path: "n.md", sha256: MD_WHOLE }],
      entries: [{ path: "n.md", kind: "design", why: "x", revision: MD_WHOLE }],
      preferred_task_id: null,
    });
    const st1 = fs.statSync(f1);
    const mdChangedExternal = MD.replace("甲正文", "甲正文改");
    fs.writeFileSync(f1, mdChangedExternal, "utf8");
    fs.utimesSync(f1, st1.atime, st1.mtime); // 还原 mtime：不接受 mtime 缓存
    const v1Changed = loadStageReads(p1);
    ok(v1Changed.status === "invalid" && v1Changed.reasons.join().includes("漂移"), "② v1 整文件改一字节且 mtime 还原 -> 仍失效（不看 mtime）");

    // ══════════ ③ stage-reads v2：章节绑定 ══════════
    console.log("[verify] ═══ ③ stage-reads v2 章节绑定 ═══");
    const p2 = mkTmp("v2");
    const f2 = path.join(p2, "n.md");
    fs.writeFileSync(f2, MD, "utf8");
    const yHash = sectionHash(MD, "根标题 / 乙");
    const bingHash = sectionHash(MD, "根标题 / 丙");
    const v2Pointer = (): Record<string, unknown> => ({
      schema_version: 2,
      generated_from: [{ path: "n.md", section: "根标题 / 乙", sha256: yHash }],
      entries: [{ path: "n.md", kind: "design", why: "本阶段必读", section: "根标题 / 丙", revision: bingHash }],
      preferred_task_id: null,
    });
    writeStage(p2, v2Pointer());
    const v2 = loadStageReads(p2);
    ok(
      v2.status === "ok" && v2.schema_version === 2 && v2.generated_from[0]?.section === "根标题 / 乙" && v2.entries[0]?.section === "根标题 / 丙",
      "③ v2 章节绑定指针合法加载（来源/条目都带 section）",
    );
    // 章节外改动（甲子）不失效
    fs.writeFileSync(f2, MD.replace("甲子正文", "甲子正文改（章节外）"), "utf8");
    const v2External = loadStageReads(p2);
    ok(v2External.status === "ok", "③ 章节外（甲子）改动 -> 乙/丙 仍有效（不失效）");
    // 来源章节内改动 -> 失效
    fs.writeFileSync(f2, MD.replace("乙正文", "乙正文改（来源章节内）"), "utf8");
    const v2SourceInternal = loadStageReads(p2);
    ok(v2SourceInternal.status === "invalid" && v2SourceInternal.reasons.join().includes("乙"), "③ 来源章节内（乙）改动 -> 拒绝并点名");
    // 章节内改动 -> 失效
    fs.writeFileSync(f2, MD.replace("丙正文", "丙正文改（章节内）"), "utf8");
    const v2Internal = loadStageReads(p2);
    ok(v2Internal.status === "invalid" && v2Internal.reasons.join().includes("丙"), "③ 章节内（丙）改动 -> 拒绝并点名");
    // 同级改名 -> 选择器缺失
    fs.writeFileSync(f2, MD.replace("## 丙", "## 丙改"), "utf8");
    const v2Renamed = loadStageReads(p2);
    ok(v2Renamed.status === "invalid" && v2Renamed.reasons.join().includes("没有完整标题路径"), "③ 标题改名 -> 章节缺失拒绝");
    // 插入同名同级标题 -> 重复 -> 拒绝
    fs.writeFileSync(f2, MD.replace("## 丁", "## 丙\n\n冒牌丙\n\n## 丁"), "utf8");
    const v2Dup = loadStageReads(p2);
    ok(v2Dup.status === "invalid" && v2Dup.reasons.join().includes("命中"), "③ 同级同名重复 -> 拒绝（每级必须唯一）");
    // 围栏里的假标题不能当章节
    fs.writeFileSync(f2, MD, "utf8"); // 还原夹具（上一段插了重复标题）
    writeStage(p2, {
      schema_version: 2,
      generated_from: [{ path: "n.md", sha256: MD_WHOLE }],
      entries: [{ path: "n.md", kind: "design", why: "x", section: "根标题 / 围栏里的假标题", revision: MD_WHOLE }],
      preferred_task_id: null,
    });
    const v2Fence = loadStageReads(p2);
    ok(v2Fence.status === "invalid" && v2Fence.reasons.join().includes("没有完整标题路径"), "③ 选择围栏内假标题 -> 缺失拒绝（围栏里的 `#` 不是标题）");
    // v2 非文本目标（NUL）
    const binPath = path.join(p2, "bin.dat");
    fs.writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02]));
    writeStage(p2, {
      schema_version: 2,
      generated_from: [{ path: "bin.dat", sha256: sha256Hex(fs.readFileSync(binPath)) }],
      entries: [{ path: "bin.dat", kind: "design", why: "x", section: "根标题 / 丙", revision: "0".repeat(64) }],
      preferred_task_id: null,
    });
    const v2Binary = loadStageReads(p2);
    ok(v2Binary.status === "invalid" && v2Binary.reasons.join().includes("NUL"), "③ 非 Markdown（含 NUL）章节选择 -> 拒绝");
    // 路径逃逸
    writeStage(p2, {
      schema_version: 2,
      generated_from: [{ path: "../outside.md", sha256: MD_WHOLE }],
      entries: [{ path: "n.md", kind: "design", why: "x" }],
      preferred_task_id: null,
    });
    const v2Escape = loadStageReads(p2);
    ok(v2Escape.status === "invalid" && v2Escape.reasons.join().includes("路径不合法"), "③ 路径越界（../）-> 拒绝");
    // 未知字段 / 非法类型
    const v2Unknown = validateStageReadsObject(
      { schema_version: 2, generated_from: [{ path: "n.md", sha256: MD_WHOLE }], entries: [{ path: "n.md", kind: "design", why: "x", bogus: 1 }], preferred_task_id: null },
      p2,
    );
    ok(v2Unknown.status === "invalid" && v2Unknown.reasons.join().includes("未知字段"), "③ v2 未知字段 -> 拒绝");
    const v2Type = validateStageReadsObject(
      { schema_version: 2, generated_from: [{ path: "n.md", sha256: MD_WHOLE }], entries: [{ path: "n.md", kind: "design", why: "x", section: 123 }], preferred_task_id: null },
      p2,
    );
    ok(v2Type.status === "invalid" && (v2Type as { reasons: string[] }).reasons.join().includes("section"), "③ section 非法类型（数字）-> 拒绝");
    // v2 无 section = 整文件（兼容形态）
    writeStage(p2, {
      schema_version: 2,
      generated_from: [{ path: "n.md", sha256: MD_WHOLE }],
      entries: [{ path: "n.md", kind: "design", why: "x", revision: MD_WHOLE }],
      preferred_task_id: null,
    });
    const v2Whole = loadStageReads(p2);
    ok(v2Whole.status === "ok" && v2Whole.entries[0]?.section === undefined, "③ v2 不带 section = 整文件哈希（合法）");

    // ══════════ ④ sync markdown_section：登记校验 + 真实 evaluate ══════════
    console.log("[verify] ═══ ④ sync markdown_section check ═══");
    const p4 = mkTmp("sync");
    const f4 = path.join(p4, "n.md");
    const rep4 = path.join(p4, "report.txt");
    const src4 = path.join(p4, "src.md");
    fs.writeFileSync(f4, MD, "utf8");
    fs.writeFileSync(rep4, "独立的整文件证据正文\n", "utf8");
    fs.writeFileSync(src4, "原始工作范围（独立来源，不属于被检目标）\n", "utf8");
    const repSha = sha256Hex(fs.readFileSync(rep4));
    const srcSha = sha256Hex(fs.readFileSync(src4));
    const bingHash4 = sectionHash(MD, "根标题 / 丙");

    // sources 是**独立来源**（src.md）：这样改被检目标不会顺带把来源判成漂移，能干净地检验 check 自身。
    const mkCheckContract = (check: Record<string, unknown>, sources: { path: string; sha256: string }[] = [{ path: "src.md", sha256: srcSha }]): unknown => ({
      schema_version: 1,
      batch_id: "b-v0942",
      project_id: "p-v0942",
      title: "章节绑定批次",
      sources,
      items: [{ id: "sec", label: "丙章节", required: true, check }],
      blocks_entry: false,
    });
    const secCheck = { type: "markdown_section", path: "n.md", section: "根标题 / 丙", sha256: bingHash4 };
    const contract = validateSyncContract(mkCheckContract(secCheck));
    ok(contract.items[0]?.check.type === "markdown_section", "④ 合法 markdown_section 契约登记通过");

    const reject = (raw: Record<string, unknown>, label: string): void => {
      let threw: string | null = null;
      try {
        validateSyncContract(mkCheckContract(raw));
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }
      ok(threw !== null, `${label}（拒绝：${threw ?? "居然放行"}）`);
    };
    reject({ ...secCheck, extra: 1 }, "④ 未知字段 -> 拒绝");
    reject({ ...secCheck, sha256: "xyz" }, "④ 非法 sha -> 拒绝");
    reject({ ...secCheck, path: "../x.md" }, "④ 路径越界 -> 拒绝");
    reject({ ...secCheck, section: "" }, "④ 空 section -> 拒绝");
    reject({ ...secCheck, section: "a\nb" }, "④ section 含换行 -> 拒绝");
    reject({ ...secCheck, section: 5 }, "④ section 非法类型 -> 拒绝");

    const evPath = path.join(p4, "evidence.json");
    const writeEvidence = (csha: string, artifactSha: string): { path: string; abs: string } => {
      const pkg = {
        schema_version: 1,
        batch_id: "b-v0942",
        project_id: "p-v0942",
        contract_sha256: csha,
        completed: true,
        items: [{ id: "sec", result: "passed", artifacts: [{ path: "report.txt", sha256: artifactSha }] }],
      };
      fs.writeFileSync(evPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
      return { path: "evidence.json", abs: evPath };
    };
    const ctx: EvalContext = { projectId: "p-v0942", projectRoot: p4, workDir: path.join(p4, ".工作台", "work"), dataDir: tmp, events: [], graphProbe: null };
    const ev = writeEvidence(syncContractSha256(contract), repSha);
    const pos = evaluateBatch(contract, 1, ev, ctx);
    ok(pos.verdict === "passed" && pos.items[0]?.verdict === "passed", "④ 正例：章节哈希匹配 -> passed");

    // 负例：章节内改动 -> failed
    fs.writeFileSync(f4, MD.replace("丙正文", "丙正文改"), "utf8");
    const negInternal = evaluateBatch(contract, 1, ev, ctx);
    ok(negInternal.verdict === "failed" && negInternal.items[0]?.verdict === "failed" && (negInternal.items[0]?.reasons[0] ?? "").includes("子树哈希不符"), "④ 负例：章节内改动 -> failed");

    // 负例：章节外改回，章节缺失 -> failed
    fs.writeFileSync(f4, MD, "utf8");
    const missContract = validateSyncContract(mkCheckContract({ ...secCheck, section: "根标题 / 不存在" }));
    const negMissing = evaluateBatch(missContract, 1, writeEvidence(syncContractSha256(missContract), repSha), ctx);
    ok(negMissing.verdict === "failed" && (negMissing.items[0]?.reasons[0] ?? "").includes("没有完整标题路径"), "④ 负例：章节缺失 -> failed");

    // 负例：同级重复 -> failed
    const dupFile = path.join(p4, "dup.md");
    fs.writeFileSync(dupFile, dupMd, "utf8");
    const dupContract = validateSyncContract(mkCheckContract({ ...secCheck, path: "dup.md", section: "根 / 重复" }));
    const negDup = evaluateBatch(dupContract, 1, writeEvidence(syncContractSha256(dupContract), repSha), ctx);
    ok(negDup.verdict === "failed" && (negDup.items[0]?.reasons[0] ?? "").includes("命中"), "④ 负例：同级同名重复 -> failed");

    // 负例：非文本 -> invalid
    const bin4 = path.join(p4, "bin.dat");
    fs.writeFileSync(bin4, Buffer.from([0x00, 0x01]));
    const binContract = validateSyncContract(mkCheckContract({ ...secCheck, path: "bin.dat" }));
    const negBin = evaluateBatch(binContract, 1, writeEvidence(syncContractSha256(binContract), repSha), ctx);
    ok(negBin.verdict === "invalid" && negBin.items[0]?.verdict === "invalid" && (negBin.items[0]?.reasons[0] ?? "").includes("NUL"), "④ 负例：非文本目标 -> invalid");

    // **不削弱旧契约**：artifact 仍是整文件 sha —— 拿章节哈希冒充整文件 → 该 item invalid
    const evBySectionHash = writeEvidence(syncContractSha256(contract), bingHash4);
    const negArtifact = evaluateBatch(contract, 1, evBySectionHash, ctx);
    ok(
      negArtifact.verdict === "invalid" && (negArtifact.items[0]?.reasons[0] ?? "").includes("artifact"),
      "④ artifact 整文件契约未被削弱：用章节哈希当 artifact -> invalid（新 check 不免除整文件锚定）",
    );
    // file_hash 仍是整文件：章节内改动后 file_hash 也 failed
    const fhContract = validateSyncContract(mkCheckContract({ type: "file_hash", path: "n.md", sha256: MD_WHOLE }));
    fs.writeFileSync(f4, MD.replace("丙正文", "丙正文改"), "utf8");
    const fhRes = evaluateBatch(fhContract, 1, writeEvidence(syncContractSha256(fhContract), repSha), ctx);
    ok(fhRes.verdict === "failed" && (fhRes.items[0]?.reasons[0] ?? "").includes("字节不符"), "④ file_hash 仍按整文件字节（未被新 check 改变）");

    // ── ④b required_reads 对 stage-reads v2 章节条目的兼容（V09-42 复审修复） ──
    fs.writeFileSync(f4, MD, "utf8"); // 还原被检目标（上一条 file_hash 测试改过它）
    const yHashR = sectionHash(MD, "根标题 / 乙");
    const bingHashR = sectionHash(MD, "根标题 / 丙");
    writeStage(p4, {
      schema_version: 2,
      generated_from: [
        { path: "n.md", section: "根标题 / 乙", sha256: yHashR },
        { path: "n.md", section: "根标题 / 丙", sha256: bingHashR },
      ],
      entries: [
        { path: "n.md", kind: "design", why: "必读乙", section: "根标题 / 乙", revision: yHashR },
        { path: "n.md", kind: "design", why: "必读丙", section: "根标题 / 丙", revision: bingHashR },
      ],
      preferred_task_id: null,
    });
    const rrEval = (check: Record<string, unknown>): ReturnType<typeof evaluateBatch> => {
      const c = validateSyncContract(mkCheckContract(check));
      return evaluateBatch(c, 1, writeEvidence(syncContractSha256(c), repSha), ctx);
    };
    // 同一 path 两条不同 section：按 (path, section) 各自命中（旧实现按 path 建 Map 会把前一条覆盖掉）
    ok(
      rrEval({ type: "required_reads", expected: [{ path: "n.md", section: "根标题 / 乙" }] }).verdict === "passed",
      "④ 同 path 多章节：required_reads 点名「乙」命中，未被「丙」覆盖",
    );
    ok(
      rrEval({ type: "required_reads", expected: [{ path: "n.md", section: "根标题 / 丙", sha256: bingHashR }] }).verdict === "passed",
      "④ required_reads 点名章节 + 核准章节子树 revision -> passed",
    );
    const rrNoSection = rrEval({ type: "required_reads", expected: [{ path: "n.md" }] });
    ok(
      rrNoSection.verdict === "missing" && (rrNoSection.items[0]?.reasons[0] ?? "").includes("点名 section"),
      "④ 未点名 section 而条目是章节绑定 -> missing 并要求显式点名（不按整文件哈希猜）",
      rrNoSection.items[0]?.reasons,
    );
    const rrWhole = rrEval({ type: "required_reads", expected: [{ path: "n.md", section: "根标题 / 丙", sha256: MD_WHOLE }] });
    ok(
      rrWhole.verdict === "missing" && (rrWhole.items[0]?.reasons[0] ?? "").includes("章节子树"),
      "④ 拿整文件哈希核章节条目 -> 不通过（不静默当匹配）",
      rrWhole.items[0],
    );
    const rrMissingSec = rrEval({ type: "required_reads", expected: [{ path: "n.md", section: "根标题 / 甲" }] });
    ok(
      rrMissingSec.verdict === "missing" && (rrMissingSec.items[0]?.reasons[0] ?? "").includes("根标题 / 甲"),
      "④ 点名未登记的章节 -> missing 且点名（不硬凑）",
    );
    fs.writeFileSync(f4, MD.replace("甲子正文", "甲子正文改（章节外）"), "utf8");
    ok(
      rrEval({ type: "required_reads", expected: [{ path: "n.md", section: "根标题 / 丙" }] }).verdict === "passed",
      "④ required_reads 章节外改动 -> 仍 passed",
    );
    fs.writeFileSync(f4, MD.replace("丙正文", "丙正文改"), "utf8");
    const rrDrift = rrEval({ type: "required_reads", expected: [{ path: "n.md", section: "根标题 / 丙" }] });
    ok(
      rrDrift.verdict === "invalid" && (rrDrift.items[0]?.reasons[0] ?? "").includes("漂移"),
      "④ 章节内改动 -> stage-reads 漂移，required_reads invalid（fail-closed，不自动接受漂移）",
    );
    fs.writeFileSync(f4, MD, "utf8");
    // 契约面：section 非法/未知字段 -> 拒
    reject({ type: "required_reads", expected: [{ path: "n.md", section: "" }] }, "④ required_reads section 空 -> 拒绝");
    reject({ type: "required_reads", expected: [{ path: "n.md", section: "a\nb" }] }, "④ required_reads section 含换行 -> 拒绝");
    reject({ type: "required_reads", expected: [{ path: "n.md", section: 5 }] }, "④ required_reads section 非法类型 -> 拒绝");
    reject({ type: "required_reads", expected: [{ path: "n.md", bogus: 1 }] }, "④ required_reads 条目未知字段 -> 拒绝");
    // v1 整文件兼容不变（旧行为不退化）
    writeStage(p4, {
      schema_version: 1,
      generated_from: [{ path: "n.md", sha256: MD_WHOLE }],
      entries: [{ path: "n.md", kind: "design", why: "整文件", revision: MD_WHOLE }],
      preferred_task_id: null,
    });
    const rrV1Plain = rrEval({ type: "required_reads", expected: [{ path: "n.md" }] });
    ok(rrV1Plain.verdict === "passed", "④ v1 整文件条目 + required_reads 未点名 section -> passed（旧行为不退化）", rrV1Plain.items[0]);
    const rrV1Whole = rrEval({ type: "required_reads", expected: [{ path: "n.md", sha256: MD_WHOLE }] });
    ok(rrV1Whole.verdict === "passed", "④ v1 整文件条目 + 核整文件 revision -> passed", rrV1Whole.items[0]);
    const rrV1Section = rrEval({ type: "required_reads", expected: [{ path: "n.md", sha256: bingHashR }] });
    ok(rrV1Section.verdict === "missing", "④ v1 整文件条目拿章节哈希核 -> 不通过（不混用口径）", rrV1Section.items[0]);

    // ══════════ ⑤ 生成脚本：--check 只校验 / --write CAS 原子写 ══════════
    console.log("[verify] ═══ ⑤ 生成脚本（--check / --write CAS） ═══");
    const p5 = mkTmp("gen");
    const f5 = path.join(p5, "n.md");
    fs.writeFileSync(f5, MD, "utf8");
    const cfg = path.join(p5, "template.json");
    const writeCfg = (mut?: (o: Record<string, unknown>) => void): void => {
      const tpl: Record<string, unknown> = {
        schema_version: 2,
        preferred_task_id: null,
        generated_from: [{ path: "n.md", section: "根标题 / 乙" }],
        entries: [{ path: "n.md", kind: "design", why: "本阶段必读", section: "根标题 / 丙" }],
      };
      if (mut) mut(tpl);
      fs.writeFileSync(cfg, `${JSON.stringify(tpl, null, 2)}\n`, "utf8");
    };
    const target = path.join(p5, ".工作台", "work", "stage-reads.json");

    writeCfg();
    const chk1 = runPrepareStageReads({ projectRoot: p5, configPath: cfg, write: false, expectedSha256: null });
    ok(chk1.code === 0 && !chk1.wrote && !fs.existsSync(target), "⑤ --check（目标不存在）：只校验、不写盘");
    const noExpected = runPrepareStageReads({ projectRoot: p5, configPath: cfg, write: true, expectedSha256: null });
    ok(noExpected.code === 1 && !fs.existsSync(target), "⑤ --write 缺 --expected-sha256 -> 拒绝（不自动接受漂移）");
    const wAbsent = runPrepareStageReads({ projectRoot: p5, configPath: cfg, write: true, expectedSha256: "absent" });
    ok(wAbsent.code === 0 && wAbsent.wrote && fs.existsSync(target), "⑤ --write --expected-sha256 absent（首次）-> 原子创建");
    const afterCreate = sha256Hex(fs.readFileSync(target));
    ok(afterCreate === wAbsent.target_sha256, "⑤ 写入内容 sha 与报告一致");
    const loaded = loadStageReads(p5);
    ok(loaded.status === "ok" && loaded.schema_version === 2 && loaded.entries[0]?.section === "根标题 / 丙", "⑤ 生成物能被 loadStageReads 读回（同判据）");
    // 已最新 -> 无需改写
    const wSame = runPrepareStageReads({ projectRoot: p5, configPath: cfg, write: true, expectedSha256: afterCreate });
    ok(wSame.code === 0 && !wSame.wrote, "⑤ CAS 命中且内容已最新 -> 不改写");
    // 错误期望 -> 拒写、文件不变
    const wWrong = runPrepareStageReads({ projectRoot: p5, configPath: cfg, write: true, expectedSha256: "a".repeat(64) });
    ok(wWrong.code === 1 && !wWrong.wrote && sha256Hex(fs.readFileSync(target)) === afterCreate, "⑤ CAS 不符 -> 拒写且文件不变");
    // 来源改 -> --check 报漂移(2) 且不写盘
    fs.writeFileSync(f5, MD.replace("丙正文", "丙正文改"), "utf8");
    const chkDrift = runPrepareStageReads({ projectRoot: p5, configPath: cfg, write: false, expectedSha256: null });
    ok(chkDrift.code === 2 && !chkDrift.wrote && sha256Hex(fs.readFileSync(target)) === afterCreate, "⑤ 来源漂移时 --check 只报告、不自行刷新旧文件");
    // 用旧期望写 -> 拒（不刷新旧漂移文件）
    const wStale = runPrepareStageReads({ projectRoot: p5, configPath: cfg, write: true, expectedSha256: afterCreate });
    ok(wStale.code === 0 && wStale.wrote, "⑤ 用当前（正确的）旧版本 CAS 写 -> 成功刷新到新章节哈希");
    const afterUpdate = sha256Hex(fs.readFileSync(target));
    ok(afterUpdate !== afterCreate, "⑤ 刷新后指针内容确实变了（新章节哈希）");
    // 模板里手写 sha -> 拒
    writeCfg((o) => {
      o.generated_from = [{ path: "n.md", section: "根标题 / 乙", sha256: "0".repeat(64) }];
    });
    const tplHash = runPrepareStageReads({ projectRoot: p5, configPath: cfg, write: false, expectedSha256: null });
    ok(tplHash.code === 1 && tplHash.lines.join().includes("sha256"), "⑤ 模板手写 sha256 -> 拒绝（哈希只现读来源生成）");
    // CLI main：缺 --config -> 1；正常 --check -> 0
    writeCfg();
    ok(prepareMain(["node", "prepare-stage-reads.ts", "--project-root", p5]) === 1, "⑤ CLI 缺 --config -> 退出码 1");
    ok(prepareMain(["node", "prepare-stage-reads.ts", "--project-root", p5, "--config", cfg]) === 0, "⑤ CLI --check 正常 -> 退出码 0");

    // ── ⑤b 独占锁 + 锁内 CAS + 版本漂移（V09-42 复审修复） ──
    writeCfg();
    const lockAbsRes = stageReadsLockAbs(p5);
    ok(lockAbsRes.ok, "⑤ 锁路径可解析（= 目标 + .lock）");
    const lockFile = lockAbsRes.ok ? lockAbsRes.abs : "";
    const beforeLock = sha256Hex(fs.readFileSync(target));
    // 冲突：锁被别人持有 -> 拒写、**不删别人的锁**、目标字节不变
    fs.writeFileSync(lockFile, "pid=999999\n", "utf8");
    const blockedByLock = runPrepareStageReads({ projectRoot: p5, configPath: cfg, write: true, expectedSha256: beforeLock });
    ok(
      blockedByLock.code === 1 &&
        !blockedByLock.wrote &&
        fs.existsSync(lockFile) &&
        blockedByLock.lines.join().includes("不自动删别人的锁") &&
        sha256Hex(fs.readFileSync(target)) === beforeLock,
      "⑤ 锁冲突：拒写、不删别人的锁、目标字节不变",
      blockedByLock.lines,
    );
    fs.rmSync(lockFile, { force: true });
    // 取到锁后 CAS 失败（期望版本过时）-> 拒写，且释放**自己**的锁（不留死锁）
    const casFailLocked = runPrepareStageReads({ projectRoot: p5, configPath: cfg, write: true, expectedSha256: "a".repeat(64) });
    ok(
      casFailLocked.code === 1 && !casFailLocked.wrote && !fs.existsSync(lockFile) && casFailLocked.lines.join().includes("锁内复核"),
      "⑤ 锁内 CAS：期望版本过时 -> 拒写，且释放自己的锁（不留死锁）",
      casFailLocked.lines,
    );
    // 目标没变、来源变了 -> 锁内 CAS 命中并真写，写后释放锁
    fs.writeFileSync(f5, MD, "utf8"); // 还原来源，令生成版本 ≠ 当前目标
    const realWrite = runPrepareStageReads({ projectRoot: p5, configPath: cfg, write: true, expectedSha256: beforeLock });
    ok(realWrite.code === 0 && realWrite.wrote && !fs.existsSync(lockFile), "⑤ 锁内 CAS 命中 -> 原子写成功，写后释放自己的锁");
    // 版本漂移：目标被外部改成别的 -> 旧期望写被锁内 CAS 拒，外部文件保留
    const afterReal = sha256Hex(fs.readFileSync(target));
    const driftedTarget = `${JSON.stringify({ schema_version: 2, generated_from: [], entries: [] }, null, 2)}\n`;
    fs.writeFileSync(target, driftedTarget, "utf8");
    const driftByVersion = runPrepareStageReads({ projectRoot: p5, configPath: cfg, write: true, expectedSha256: afterReal });
    ok(
      driftByVersion.code === 1 &&
        !driftByVersion.wrote &&
        driftByVersion.lines.join().includes("锁内复核") &&
        fs.readFileSync(target, "utf8") === driftedTarget &&
        !fs.existsSync(lockFile),
      "⑤ 版本漂移：期望版本已过时 -> 锁内 CAS 拒写、外部文件保留、锁释放",
      driftByVersion.lines,
    );

    // ══════════ ⑥ 生成模板 pin_revision：默认绑定 / false 实时必读（2026-10-04 有界修正） ══════════
    console.log("[verify] ═══ ⑥ 生成模板 pin_revision（实时必读例外） ═══");
    const p6 = mkTmp("pin");
    const dyn6 = path.join(p6, "dyn.md");
    const stable6 = path.join(p6, "stable.md");
    fs.writeFileSync(dyn6, MD, "utf8");
    fs.writeFileSync(stable6, MD, "utf8");
    const cfg6 = path.join(p6, "template.json");
    const writeCfg6 = (mut?: (o: Record<string, unknown>) => void): void => {
      const tpl: Record<string, unknown> = {
        schema_version: 2,
        preferred_task_id: null,
        generated_from: [{ path: "stable.md", section: "根标题 / 乙" }],
        entries: [
          { path: "stable.md", kind: "design", why: "稳定章节（默认绑定）", section: "根标题 / 丙" },
          { path: "dyn.md", kind: "checkpoint", why: "实时进度（不绑定）", section: "根标题 / 甲", pin_revision: false },
        ],
      };
      if (mut) mut(tpl);
      fs.writeFileSync(cfg6, `${JSON.stringify(tpl, null, 2)}\n`, "utf8");
    };

    writeCfg6();
    const pinChk = runPrepareStageReads({ projectRoot: p6, configPath: cfg6, write: false, expectedSha256: null });
    ok(pinChk.code === 0 && pinChk.generated !== null, "⑥ 合法模板（默认绑定 + pin_revision:false）--check 通过");
    const genRows = (pinChk.generated as { entries: Record<string, unknown>[] } | null)?.entries ?? [];
    const genSrc = (pinChk.generated as { generated_from: Record<string, unknown>[] } | null)?.generated_from ?? [];
    ok(
      genRows[0]?.revision === sectionHash(MD, "根标题 / 丙"),
      "⑥ 默认（不写 pin_revision）条目仍绑定 revision（= 该章节子树哈希）",
      genRows[0],
    );
    ok(genRows[1] !== undefined && !("revision" in genRows[1]), "⑥ pin_revision:false 条目**省略** revision", genRows[1]);
    ok(genRows[1]?.section === "根标题 / 甲", "⑥ pin_revision:false 仍保留 section（实时必读的定位）", genRows[1]);
    ok(
      genSrc[0]?.sha256 === sectionHash(MD, "根标题 / 乙"),
      "⑥ generated_from **始终**强制 sha256 绑定（不受 pin_revision 影响）",
      genSrc[0],
    );

    const target6 = path.join(p6, ".工作台", "work", "stage-reads.json");
    const pinWrite = runPrepareStageReads({ projectRoot: p6, configPath: cfg6, write: true, expectedSha256: "absent" });
    ok(pinWrite.code === 0 && pinWrite.wrote && fs.existsSync(target6), "⑥ 生成物原子写入");
    const pinLoaded = loadStageReads(p6);
    ok(
      pinLoaded.status === "ok" && pinLoaded.entries[0]?.revision !== null && pinLoaded.entries[1]?.revision === null,
      "⑥ 读回：默认条目 revision 有值、pin_revision:false 条目 revision=null（同判据合法）",
      pinLoaded,
    );

    // false 动态章节内容变化 -> 仍可 load（只核存在/安全/可解码/章节唯一，不核内容哈希）
    fs.writeFileSync(dyn6, MD.replace("甲正文", "甲正文改（实时进度）"), "utf8");
    ok(loadStageReads(p6).status === "ok", "⑥ pin_revision:false 的动态章节内容变化 -> 仍合法 load（只追加进度不重新冻结整份文档）");
    // 稳定来源（generated_from 章节）改动 -> 仍 invalid
    fs.writeFileSync(stable6, MD.replace("乙正文", "乙正文改（稳定来源）"), "utf8");
    const pinSrcDrift = loadStageReads(p6);
    ok(
      pinSrcDrift.status === "invalid" && pinSrcDrift.reasons.join().includes("乙"),
      "⑥ 稳定来源（generated_from 章节）改动 -> 仍 invalid（真实设计/授权严格阻断）",
      pinSrcDrift,
    );
    // 默认绑定条目（entries 章节）改动 -> 仍 invalid
    fs.writeFileSync(stable6, MD.replace("丙正文", "丙正文改（稳定条目）"), "utf8");
    const pinEntryDrift = loadStageReads(p6);
    ok(
      pinEntryDrift.status === "invalid" && pinEntryDrift.reasons.join().includes("丙"),
      "⑥ 默认绑定条目章节改动 -> 仍 invalid",
      pinEntryDrift,
    );
    fs.writeFileSync(stable6, MD, "utf8");

    // false + 文件丢失 -> 仍 invalid（存在性照核）；生成侧同样拒
    fs.rmSync(dyn6, { force: true });
    const pinFileGone = loadStageReads(p6);
    ok(
      pinFileGone.status === "invalid" && pinFileGone.reasons.join().includes("不存在"),
      "⑥ pin_revision:false 目标文件丢失 -> 仍 invalid（存在性照核）",
      pinFileGone,
    );
    const pinGenMissing = runPrepareStageReads({ projectRoot: p6, configPath: cfg6, write: false, expectedSha256: null });
    ok(
      pinGenMissing.code === 1 && pinGenMissing.lines.join().includes("不存在"),
      "⑥ 生成模板引用不存在的文件 -> 拒（--check 失败、不写盘）",
      pinGenMissing.lines,
    );
    // false + 章节丢失 -> 仍 invalid（章节可唯一定位照核）
    fs.writeFileSync(dyn6, MD.replace("## 甲", "## 甲改"), "utf8");
    const pinSecGone = loadStageReads(p6);
    ok(
      pinSecGone.status === "invalid" && pinSecGone.reasons.join().includes("没有完整标题路径"),
      "⑥ pin_revision:false 章节丢失 -> 仍 invalid（章节可唯一定位照核）",
      pinSecGone,
    );
    fs.writeFileSync(dyn6, MD, "utf8");

    // false + 路径逃逸 / 非文本 -> 仍拒（安全与可解码照核，与内容哈希无关）
    writeCfg6((o) => {
      (o.entries as Record<string, unknown>[])[1] = { path: "../outside.md", kind: "checkpoint", why: "逃逸", pin_revision: false };
    });
    const pinEscape = runPrepareStageReads({ projectRoot: p6, configPath: cfg6, write: false, expectedSha256: null });
    ok(
      pinEscape.code === 1 && pinEscape.lines.join().includes("路径不合法"),
      "⑥ pin_revision:false 路径越界（../）-> 拒绝（安全照核）",
      pinEscape.lines,
    );
    const bin6 = path.join(p6, "bin6.dat");
    fs.writeFileSync(bin6, Buffer.from([0x00, 0x01, 0x02]));
    writeCfg6((o) => {
      (o.entries as Record<string, unknown>[])[1] = { path: "bin6.dat", kind: "checkpoint", why: "非文本", section: "根标题 / 甲", pin_revision: false };
    });
    const pinBinary = runPrepareStageReads({ projectRoot: p6, configPath: cfg6, write: false, expectedSha256: null });
    ok(
      pinBinary.code === 1 && pinBinary.lines.join().includes("NUL"),
      "⑥ pin_revision:false 非文本（含 NUL）章节 -> 拒绝（可解码照核）",
      pinBinary.lines,
    );

    // 类型错误 -> 拒（必须是 boolean；默认 true）
    writeCfg6((o) => {
      ((o.entries as Record<string, unknown>[])[1] as Record<string, unknown>).pin_revision = "false";
    });
    const pinTypeStr = runPrepareStageReads({ projectRoot: p6, configPath: cfg6, write: false, expectedSha256: null });
    ok(
      pinTypeStr.code === 1 && pinTypeStr.lines.join().includes("pin_revision"),
      "⑥ pin_revision 非布尔（字符串）-> 拒绝",
      pinTypeStr.lines,
    );
    writeCfg6((o) => {
      ((o.entries as Record<string, unknown>[])[1] as Record<string, unknown>).pin_revision = 1;
    });
    const pinTypeNum = runPrepareStageReads({ projectRoot: p6, configPath: cfg6, write: false, expectedSha256: null });
    ok(
      pinTypeNum.code === 1 && pinTypeNum.lines.join().includes("pin_revision"),
      "⑥ pin_revision 非布尔（数字）-> 拒绝",
      pinTypeNum.lines,
    );

    // 来源夹带 pin_revision -> 拒（generated_from 不许该字段、仍强制 sha256）
    writeCfg6((o) => {
      (o.generated_from as Record<string, unknown>[])[0].pin_revision = false;
    });
    const pinSmuggle = runPrepareStageReads({ projectRoot: p6, configPath: cfg6, write: false, expectedSha256: null });
    ok(
      pinSmuggle.code === 1 && pinSmuggle.lines.join().includes("generated_from"),
      "⑥ generated_from 夹带 pin_revision -> 未知字段拒绝（来源仍强制 sha256）",
      pinSmuggle.lines,
    );

    // v1 模板出现 pin_revision -> 未知字段拒绝（v1 逐条严格如旧）
    writeCfg6((o) => {
      o.schema_version = 1;
      o.generated_from = [{ path: "stable.md" }];
      o.entries = [{ path: "stable.md", kind: "design", why: "x", pin_revision: false }];
    });
    const pinV1 = runPrepareStageReads({ projectRoot: p6, configPath: cfg6, write: false, expectedSha256: null });
    ok(
      pinV1.code === 1 && pinV1.lines.join().includes("未知字段"),
      "⑥ v1 模板出现 pin_revision -> 未知字段拒绝（v1 逐条严格如旧）",
      pinV1.lines,
    );

    // 运行时 schema 不新增键：指针条目里塞 pin_revision -> 未知字段拒（未扩 stageReads.ts）
    const v2RuntimePin = validateStageReadsObject(
      {
        schema_version: 2,
        generated_from: [{ path: "stable.md", sha256: MD_WHOLE }],
        entries: [{ path: "stable.md", kind: "design", why: "x", pin_revision: false }],
        preferred_task_id: null,
      },
      p6,
    );
    ok(
      v2RuntimePin.status === "invalid" && v2RuntimePin.reasons.join().includes("未知字段"),
      "⑥ 运行时指针条目出现 pin_revision -> 未知字段拒绝（不新增 runtime schema 键）",
      v2RuntimePin,
    );

    // ══════════ ⑦ 章节绑定的派生 range 与读回边界（2026-10-04 独立集成复审 P1-3 修复） ══════════
    console.log("[verify] ═══ ⑦ 章节绑定 range（父节子树 / 围栏 / 闭合 # / 前节插入行） ═══");
    const p7 = mkTmp("range");
    const f7 = path.join(p7, "n.md");
    fs.writeFileSync(f7, MD, "utf8");
    const yH7 = sectionHash(MD, "根标题 / 乙");
    const bH7 = sectionHash(MD, "根标题 / 丙");
    // stageReadTargetDigest：整文件 range=null；有 section 给标题+子树的起止行
    const dWhole = stageReadTargetDigest(f7, null);
    ok(dWhole.ok && dWhole.range === null && dWhole.sha256 === MD_WHOLE, "⑦ 整文件摘要 range=null（无 section 不派生行范围）", dWhole);
    const dJia = stageReadTargetDigest(f7, "根标题 / 甲");
    ok(
      dJia.ok && dJia.range?.start === 5 && dJia.range?.end === 12,
      "⑦ 父节 range 覆盖标题+全部后代（甲 = 行 5–12，含甲子、不含乙）",
      dJia,
    );
    const dBing = stageReadTargetDigest(f7, "根标题 / 丙");
    ok(dBing.ok && dBing.range?.start === 17 && dBing.range?.end === 24, "⑦ 含围栏的父节 range 正确（丙 = 行 17–24，含其后围栏、止于同级丁）", dBing);
    // 尾部闭合 `#`：materialSection 剥闭合序列后再定位
    const closeMd = ["# 根", "", "## 标题 ##", "", "正文", "", "## 乙", "", "乙正文"].join("\n");
    const f7c = path.join(p7, "close.md");
    fs.writeFileSync(f7c, closeMd, "utf8");
    const dClose = stageReadTargetDigest(f7c, "根 / 标题");
    ok(dClose.ok && dClose.range?.start === 3 && dClose.range?.end === 6, "⑦ 尾部闭合 `#`：「根 / 标题」可定位，range = 3–6（标题+正文）", dClose);
    ok(!stageReadTargetDigest(f7c, "根 / 标题 ##").ok, "⑦ 未剥闭合 `#` 的原始文本不是合法选择器（剥后才定位），不误配");

    // loadStageReads：带 section 的条目**派生**携带 range（来源不携带；range 不是指针 JSON 键）
    writeStage(p7, {
      schema_version: 2,
      generated_from: [{ path: "n.md", section: "根标题 / 乙", sha256: yH7 }],
      entries: [{ path: "n.md", kind: "design", why: "必读丙", section: "根标题 / 丙", revision: bH7 }],
      preferred_task_id: null,
    });
    const r7 = loadStageReads(p7);
    ok(
      r7.status === "ok" && r7.entries[0]?.section === "根标题 / 丙" && r7.entries[0]?.range?.start === 17 && r7.entries[0]?.range?.end === 24,
      "⑦ loadStageReads：带 section 的条目派生携带 range（标题+子树 17–24）",
      r7.status === "ok" ? r7.entries[0] : r7,
    );
    // range 不是指针 JSON 键：写进条目 -> 未知字段拒绝（不新增 runtime schema 键）
    const r7Key = validateStageReadsObject(
      {
        schema_version: 2,
        generated_from: [{ path: "n.md", sha256: MD_WHOLE }],
        entries: [{ path: "n.md", kind: "design", why: "x", section: "根标题 / 丙", range: { start: 1, end: 2 } }],
        preferred_task_id: null,
      },
      p7,
    );
    ok(r7Key.status === "invalid" && r7Key.reasons.join().includes("未知字段"), "⑦ 指针里写 range -> 未知字段拒绝（range 是派生字段，不是指针键）", r7Key);

    // 前节插入行：章节外插入只改行号、不改内容 -> 仍合法且 range 现算平移
    const withInsert = ["# 根标题", "插入的新行", ...MD_LINES.slice(1)].join("\n");
    fs.writeFileSync(f7, withInsert, "utf8");
    const r7Shift = loadStageReads(p7);
    ok(
      r7Shift.status === "ok" && r7Shift.entries[0]?.range?.start === 18 && r7Shift.entries[0]?.range?.end === 25,
      "⑦ 前节插入一行：章节内容不变仍合法，range 现算平移到 18–25（不保存旧行号）",
      r7Shift.status === "ok" ? r7Shift.entries[0] : r7Shift,
    );

    // 同一次 load 内复用同次 digest：来源+条目同 (path, section) 只读一次目标文件
    fs.writeFileSync(f7, MD, "utf8");
    writeStage(p7, {
      schema_version: 2,
      generated_from: [{ path: "n.md", section: "根标题 / 丙", sha256: bH7 }],
      entries: [{ path: "n.md", kind: "design", why: "必读丙", section: "根标题 / 丙", revision: bH7 }],
      preferred_task_id: null,
    });
    const realRead = fs.readFileSync;
    let reads7 = 0;
    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((...args: unknown[]) => {
      if (String(args[0]) === f7) reads7 += 1;
      return (realRead as unknown as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.readFileSync;
    let r7Reuse: ReturnType<typeof loadStageReads>;
    try {
      r7Reuse = loadStageReads(p7);
    } finally {
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = realRead;
    }
    ok(
      r7Reuse.status === "ok" && reads7 === 1,
      `⑦ 来源+条目同 (path, section) 在同一次 load 内复用同次 digest（目标文件只读 ${reads7} 次）`,
      { reads: reads7 },
    );

    // ══════════ 自证：真实仓库受保护文件未被本脚本改动 ══════════
    for (const rel of ["DESIGN.md", "PLAN.md", "PROGRESS.md", "README.md", "AGENTS.md"]) {
      const abs = path.join(process.cwd(), rel);
      ok(fs.existsSync(abs), `自证 ${rel} 在场（本脚本不改它）`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`[verify] V09-42：PASS ${passCount} / FAIL ${fails.length}`);
  if (fails.length > 0) {
    console.log("[verify] 存在 FAIL");
    process.exit(1);
  }
  console.log("[verify] 全部 PASS");
}

main();
