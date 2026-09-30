// V09-23 返工 C2 · 锁内有界读取复核（有界读取预算 + 图输入异常明确失败）专项验证。
//
// 关闭两条 Codex 反例（`.工作台/verify/sync-evidence-20260930/codex-lock-budget.mts` 与 first-review 第 14 条后半）：
//   ① **契约 sources 与目标共用同一锁内读取预算**：`evaluateBatch` 走 ctx.byteBudget 时，
//      `contractSourceSnapshot` 必须**读前按 stat** 判定——本条会超总预算就不读，且**不能 passed**；
//      没有显式预算时（登记写口也在锁内）默认按 `SYNC_LOCK_REVIEW_MAX_BYTES` 有界，
//      不给出 256 来源 × 8MB ≈ 2GB 的锁内无界读取。反例：limit=16 + 1000 字节来源不许 passed。
//   ② **图输入有界读取异常/超界必须明确 failed/incomplete**：`graphInputsOf` 不再把
//      `oversize`/`total_budget_exceeded`/`unreadable`/`not_regular`/非 ENOENT 的读取失败
//      只当稳定 marker 放行（那样 fullbuilder 仍有效、同步仍 passed）；**只有 ENOENT 是合法缺失**。
//      锁内（有界图源探针）与全量探针都要把异常并进 ok/verdict。
//
// 覆盖（真文件为主）：预算反例 / 来源与目标共享预算 / 真实规模 17 sources + 23 items 正常 /
// 默认有界（无显式预算也拒超界来源）/ 图输入 oversize（graph-update、modules）/ 明确总限 /
// 非常规文件 / 缺失合法 null / 非 ENOENT 读取失败（**故障注入，明确标注**）。
//
// 隔离口径（AGENTS.md §5）：mkdtemp 夹具 + 隔离 TATAI_HOME；只读源码走项目内**有限**的
// `GRAPH_INPUT_FILES` 实际路径（不无界扫描）；不碰真实 ~/.tatai / 真实项目与账本 / 不接网关 / 不调模型。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let passCount = 0;
let failCount = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) passCount += 1;
  else {
    failCount += 1;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1400)}`);
  }
};
const info = (m: string): void => console.log(`[verify] ${m}`);
const sha256 = (d: string | Buffer): string => crypto.createHash("sha256").update(d).digest("hex");
const mkdirp = (d: string): void => { fs.mkdirSync(d, { recursive: true }); };
const write = (f: string, t: string | Buffer): void => { mkdirp(path.dirname(f)); fs.writeFileSync(f, t); };
const writeJson = (f: string, v: unknown): void => write(f, `${JSON.stringify(v, null, 2)}\n`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const loadSrc = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(SRC, rel)).href)) as T;

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-sync-budget-"));
const dataDir = path.join(tmpBase, "home");
const root = path.join(tmpBase, "proj-budget");
const workDir = path.join(root, ".工作台", "work");
const inbox = path.join(workDir, "sync-inbox");
const archDir = path.join(root, ".工作台", "arch");
const PID = "budgetfx";

type Contract = ReturnType<typeof import("../src/server/work/syncContract").validateSyncContract>;
type AnyCtx = {
  projectId: string;
  projectRoot: string;
  workDir: string;
  dataDir: string;
  events: unknown[];
  graphProbe: unknown;
  graphSourceProbe?: unknown;
  graphSourceOnly?: boolean;
  byteBudget?: { limit: number; used: number };
};

/** 在 `arch` 目录下按相对名写图输入（真文件） */
const writeArch = (name: string, data: string | Buffer): void => write(path.join(archDir, name), data);

async function main(): Promise<void> {
  info(`同步锁内有界读取复核 · 专项验证（${process.platform} · node ${process.version}）`);
  info(`  夹具根 ${tmpBase}（隔离 TATAI_HOME ${dataDir}）`);

  const registryMod = await loadSrc<typeof import("../src/server/registry")>("server/registry.ts");
  const contractMod = await loadSrc<typeof import("../src/server/work/syncContract")>("server/work/syncContract.ts");
  const checksMod = await loadSrc<typeof import("../src/server/work/syncChecks")>("server/work/syncChecks.ts");
  const graphMod = await loadSrc<typeof import("../src/server/work/syncGraph")>("server/work/syncGraph.ts");
  const probeMod = await loadSrc<typeof import("../src/server/work/syncProbe")>("server/work/syncProbe.ts");
  const MAX = contractMod.SYNC_LOCK_REVIEW_MAX_BYTES;
  const FILE_MAX = probeMod.SYNC_GRAPH_INPUT_FILE_MAX_BYTES;
  info(`  常量：SYNC_LOCK_REVIEW_MAX_BYTES=${MAX} · 单文件上限=${FILE_MAX} · 总上限=${probeMod.SYNC_GRAPH_INPUT_TOTAL_MAX_BYTES}`);

  mkdirp(dataDir);
  mkdirp(root);
  mkdirp(inbox);

  // ═══ 夹具与工具 ═══
  const resultRel = "reports/result.md";
  const resultAbs = path.join(root, resultRel);
  write(resultAbs, "锁内预算夹具：真实 artifact。\n");
  registryMod.addProject({ id: PID, name: "锁内预算夹具", path: root, kind: "backend" }, dataDir);

  const srcRev = (rel: string): string => sha256(fs.readFileSync(path.join(root, rel)));
  /** 按契约生成匹配证据包（每项 1 个真实 artifact，内容哈希实核） */
  const evidenceOf = (contract: Contract, artifactRel = resultRel): { path: string; abs: string } => {
    const abs = path.join(inbox, `${contract.batch_id}.evidence.json`);
    const pkg = {
      schema_version: 1,
      batch_id: contract.batch_id,
      project_id: PID,
      contract_sha256: contractMod.syncContractSha256(contract),
      completed: true,
      items: contract.items.map((it) => ({ id: it.id, result: "passed", artifacts: [{ path: artifactRel, sha256: srcRev(artifactRel) }] })),
    };
    write(abs, `${JSON.stringify(pkg, null, 2)}\n`);
    return { path: `.工作台/work/sync-inbox/${contract.batch_id}.evidence.json`, abs };
  };
  const baseCtx = (extra: Partial<AnyCtx> = {}): AnyCtx => ({
    projectId: PID,
    projectRoot: root,
    workDir,
    dataDir,
    events: [],
    graphProbe: probeMod.syncGraphProbe(),
    graphSourceProbe: probeMod.syncGraphSourceProbe(),
    ...extra,
  });
  const contractOrNull = (raw: unknown): Contract => contractMod.validateSyncContract(raw);

  // ═══ A. 锁内读取预算：契约 sources 与目标共用同一份 ═══
  console.log("[verify] ── A. 锁内读取预算（契约 sources 计入同一 ctx.byteBudget）");

  {
    // A-1 Codex 反例同款：limit=16，1000 字节来源（target 1 字节 / proof 0 字节）不许 passed。
    mkdirp(path.join(root, "budgetA"));
    write(path.join(root, "budgetA", "source.txt"), "s".repeat(1000));
    write(path.join(root, "budgetA", "target.txt"), "x");
    write(path.join(root, "budgetA", "proof.txt"), "");
    const c = contractOrNull({
      schema_version: 1,
      batch_id: "budget",
      project_id: PID,
      title: "Lock source budget",
      sources: [{ path: "budgetA/source.txt", sha256: sha256("s".repeat(1000)) }],
      blocks_entry: true,
      items: [{ id: "file", label: "Target", required: true, check: { type: "file_hash", path: "budgetA/target.txt", sha256: sha256("x") } }],
    });
    const evAbs = path.join(inbox, "budget.evidence.json");
    write(evAbs, JSON.stringify({ schema_version: 1, batch_id: "budget", project_id: PID, contract_sha256: contractMod.syncContractSha256(c), completed: true, items: [{ id: "file", result: "passed", artifacts: [{ path: "budgetA/proof.txt", sha256: sha256("") }] }] }));
    const ctx = baseCtx({ byteBudget: { limit: 16, used: 0 } });
    const r = checksMod.evaluateBatch(c, 1, { path: ".工作台/work/sync-inbox/budget.evidence.json", abs: evAbs }, ctx as never);
    ok(r.verdict !== "passed", "A-1 1000 字节来源 / limit=16 → 不许 passed（来源计入同一预算、读前按 stat 超界就不读）", { verdict: r.verdict, budget: ctx.byteBudget, reasons: r.reasons.slice(0, 3) });
    ok((ctx.byteBudget?.used ?? 0) <= 16, "A-1b 实际读取字节不超过预算上限（无静默截断填充）", { used: ctx.byteBudget?.used });
    ok(r.reasons.some((x) => x.includes("预算")), "A-1c 理由点名预算超界（不是含混 stale）", { reasons: r.reasons.slice(0, 3) });
  }
  {
    // A-2 锁外（无显式预算）正向 → passed；小预算但够读 → 仍 passed（预算拒绝非夹具误伤）。
    const c = contractOrNull({
      schema_version: 1,
      batch_id: "budget-ok",
      project_id: PID,
      title: "Lock source budget ok",
      sources: [{ path: resultRel, sha256: srcRev(resultRel) }],
      blocks_entry: true,
      items: [{ id: "file", label: "Target", required: true, check: { type: "file_hash", path: resultRel, sha256: srcRev(resultRel) } }],
    });
    const ev = evidenceOf(c);
    const r = checksMod.evaluateBatch(c, 1, ev, baseCtx() as never);
    ok(r.verdict === "passed", "A-2 同夹具无显式预算（锁外全量口径）→ passed（预算拒绝非夹具误伤）", { verdict: r.verdict, reasons: r.reasons.slice(0, 2) });
    const rBudget = checksMod.evaluateBatch(c, 1, ev, baseCtx({ byteBudget: { limit: 1024, used: 0 } }) as never);
    ok(rBudget.verdict === "passed", "A-2b 小预算但够读（1024 字节 > 来源+目标+artifact）→ 仍 passed", { verdict: rBudget.verdict });
  }
  {
    // A-3 来源先占预算、目标随后超界：来源 10B 通过、目标 20B 超 16B → 明确失败（共享同一份预算）。
    mkdirp(path.join(root, "budgetB"));
    write(path.join(root, "budgetB", "source.txt"), "s".repeat(10));
    write(path.join(root, "budgetB", "target.txt"), "t".repeat(20));
    write(path.join(root, "budgetB", "proof.txt"), "");
    const c = contractOrNull({
      schema_version: 1,
      batch_id: "budget-shared",
      project_id: PID,
      title: "Shared budget",
      sources: [{ path: "budgetB/source.txt", sha256: sha256("s".repeat(10)) }],
      blocks_entry: true,
      items: [{ id: "file", label: "Target", required: true, check: { type: "file_hash", path: "budgetB/target.txt", sha256: sha256("t".repeat(20)) } }],
    });
    const evAbs = path.join(inbox, "budget-shared.evidence.json");
    write(evAbs, JSON.stringify({ schema_version: 1, batch_id: "budget-shared", project_id: PID, contract_sha256: contractMod.syncContractSha256(c), completed: true, items: [{ id: "file", result: "passed", artifacts: [{ path: "budgetB/proof.txt", sha256: sha256("") }] }] }));
    const r = checksMod.evaluateBatch(c, 1, { path: ".工作台/work/sync-inbox/budget-shared.evidence.json", abs: evAbs }, baseCtx({ byteBudget: { limit: 16, used: 0 } }) as never);
    ok(r.verdict !== "passed", "A-3 来源先占 10B、目标 20B 超 16B → 目标读取超预算明确失败（同一份 ctx.byteBudget）", { verdict: r.verdict, reasons: r.reasons.slice(0, 3) });
  }
  {
    // A-4 真实规模：17 sources + 23 items，走**真** SYNC_LOCK_REVIEW_MAX_BYTES → 正常 passed。
    const srcFiles: { path: string; sha256: string }[] = [];
    const itemRels: string[] = [];
    for (let i = 0; i < 17; i++) {
      const rel = `scale/s${i}.md`;
      write(path.join(root, rel), `来源 ${i}：夹具内容。\n`);
      srcFiles.push({ path: rel, sha256: srcRev(rel) });
    }
    for (let i = 0; i < 23; i++) {
      const rel = `scale/t${i}.txt`;
      write(path.join(root, rel), `目标 ${i}\n`);
      itemRels.push(rel);
    }
    const id = (i: number): string => `i${String(i).padStart(2, "0")}`;
    const c = contractOrNull({
      schema_version: 1,
      batch_id: "scale-real",
      project_id: PID,
      title: "真实规模",
      sources: srcFiles,
      blocks_entry: true,
      items: itemRels.map((rel, i) => ({ id: id(i), label: `目标 ${i}`, required: true, check: { type: "file_hash", path: rel, sha256: srcRev(rel) } })),
    });
    write(path.join(inbox, "scale-real.evidence.json"), JSON.stringify({ schema_version: 1, batch_id: "scale-real", project_id: PID, contract_sha256: contractMod.syncContractSha256(c), completed: true, items: itemRels.map((_, i) => ({ id: id(i), result: "passed", artifacts: [{ path: resultRel, sha256: srcRev(resultRel) }] })) }));
    const ctx = baseCtx({ byteBudget: { limit: MAX, used: 0 } });
    const r = checksMod.evaluateBatch(c, 1, { path: ".工作台/work/sync-inbox/scale-real.evidence.json", abs: path.join(inbox, "scale-real.evidence.json") }, ctx as never);
    ok(r.verdict === "passed", "A-4 真实规模 17 sources + 23 items（真 16MB 预算）→ 正常 passed", { verdict: r.verdict, used: ctx.byteBudget?.used, reasons: r.reasons.slice(0, 2) });
    ok((ctx.byteBudget?.used ?? MAX) < MAX, "A-4b 真实规模实际读取远小于上限（预算不误伤正常批次）", { used: ctx.byteBudget?.used });
  }
  {
    // A-5 默认有界：没有显式预算（登记写口在锁内也走这条）时，来源合计超 16MB 也不读、明确失败。
    const big: { path: string; sha256: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const rel = `big/s${i}.bin`;
      const buf = Buffer.alloc(6 * 1024 * 1024, 0x61 + i);
      write(path.join(root, rel), buf);
      big.push({ path: rel, sha256: sha256(buf) });
    }
    const c = contractOrNull({
      schema_version: 1,
      batch_id: "big-sources",
      project_id: PID,
      title: "默认有界",
      sources: big,
      blocks_entry: true,
      items: [{ id: "file", label: "Target", required: true, check: { type: "file_hash", path: resultRel, sha256: srcRev(resultRel) } }],
    });
    const problems = contractMod.contractSourceProblems(c, root);
    ok(problems.length > 0 && problems.some((p) => p.includes("预算")), "A-5 无显式预算时来源合计 18MB > 16MB → 默认有界、点名超预算（登记写口锁内不再 2GB 无界读）", { problems: problems.slice(0, 2) });
    const r = checksMod.evaluateBatch(c, 1, evidenceOf(c), baseCtx() as never);
    ok(r.verdict !== "passed", "A-5b 超界来源不参与 passed（默认有界同样生效）", { verdict: r.verdict });
    for (const b of big) fs.rmSync(path.join(root, b.path), { force: true });
  }
  {
    // A-6 锁内 fallback 对**异常**仍保留错误：缺来源 / 漂移来源（无显式预算）不许被静默吞掉。
    write(path.join(root, "reports", "drifted.md"), "now current\n");
    const c = contractOrNull({
      schema_version: 1,
      batch_id: "src-errors",
      project_id: PID,
      title: "来源异常保留",
      sources: [
        { path: resultRel, sha256: srcRev(resultRel) },
        { path: "reports/absent.md", sha256: "0".repeat(64) },
        { path: "reports/drifted.md", sha256: sha256("was original\n") },
      ],
      blocks_entry: true,
      items: [{ id: "file", label: "Target", required: true, check: { type: "file_hash", path: resultRel, sha256: srcRev(resultRel) } }],
    });
    const snap = contractMod.contractSourceSnapshot(c, root, { byteBudget: { limit: MAX, used: 0 } });
    ok(snap.problems.some((p) => p.includes("不存在")), "A-6 锁内预算模式：缺来源仍明确报错（fallback 不吞异常）", { problems: snap.problems.slice(0, 3) });
    ok(snap.problems.some((p) => p.includes("漂移")), "A-6b 锁内预算模式：漂移来源仍明确报错", { problems: snap.problems.slice(0, 3) });
    ok(snap.problems.length === 2 && snap.snapshots.filter((s) => s.sha256 === null).length === 1, "A-6c 异常来源快照：缺失记 null、漂移记实际哈希（都不冒充已核实）", { snapshots: snap.snapshots.map((s) => ({ path: s.path, sha256: s.sha256 === null ? null : s.sha256.slice(0, 8) })) });
  }

  // ═══ B. 图输入有界读取异常：必须明确 failed/incomplete ═══
  console.log("[verify] ── B. 图输入有界读取异常（oversize / 总限 / 非常规 / 缺失 / 故障注入）");

  const gContract = contractOrNull({
    schema_version: 1,
    batch_id: "b-graph",
    project_id: PID,
    title: "图输入有界",
    sources: [{ path: resultRel, sha256: srcRev(resultRel) }],
    items: [{ id: "g", label: "图", required: true, check: { type: "graph_full", expected_baseline_id: "bl-x" } }],
    blocks_entry: true,
  });
  const gEvidence = (): { path: string; abs: string } => evidenceOf(gContract);
  const graphEval = (): { verdict: string; itemVerdict: string; actual: Record<string, unknown> } => {
    const r = checksMod.evaluateBatch(gContract, 1, gEvidence(), baseCtx({ graphSourceOnly: true, byteBudget: { limit: MAX, used: 0 } }) as never);
    return { verdict: r.verdict, itemVerdict: r.items[0]?.verdict ?? "", actual: (r.items[0]?.actual ?? {}) as Record<string, unknown> };
  };
  const clearArch = (): void => fs.rmSync(archDir, { recursive: true, force: true });
  /** 读图输入（容错取值：实现未回带 problems/incomplete 时按「无」处理，让断言逐条判失败而非脚本抛错） */
  const readGraphInputs = (): { inputs: Record<string, string | null>; problems: string[]; incomplete: boolean } => {
    const r = graphMod.graphInputsOf(PID, dataDir) as unknown as { inputs?: Record<string, string | null>; problems?: string[]; incomplete?: boolean };
    return { inputs: r.inputs ?? {}, problems: r.problems ?? [], incomplete: r.incomplete === true };
  };
  const fakeEacces = (target: string): (() => void) => {
    const orig = fs.lstatSync;
    (fs as unknown as { lstatSync: unknown }).lstatSync = ((p: fs.PathLike, ...rest: unknown[]) => {
      if (typeof p === "string" && path.resolve(p) === path.resolve(target)) {
        const e = new Error(`EACCES: permission denied, lstat '${p}'`) as NodeJS.ErrnoException;
        e.code = "EACCES";
        throw e;
      }
      return (orig as unknown as (...a: unknown[]) => unknown)(p, ...rest);
    }) as unknown as typeof fs.lstatSync;
    return () => { (fs as unknown as { lstatSync: unknown }).lstatSync = orig; };
  };
  clearArch();

  {
    // B-0 空态：arch 目录不存在 → 全部合法缺失 null，无 problems（缺失不是异常）。
    const gi = readGraphInputs();
    ok(gi.problems.length === 0 && Object.values(gi.inputs).every((v) => v === null) && Object.keys(gi.inputs).length === 7, "B-0 图输入全缺失 → 合法 null、无 problems（ENOENT 是唯一合法缺失）", { inputs: gi.inputs, problems: gi.problems });
  }
  {
    // B-1 oversize graph-update：>8MB（真文件，只体积超界），不许只带 oversize marker 放行。
    writeArch("graph-update.json", Buffer.alloc(FILE_MAX + 1, 0x20));
    const gi = readGraphInputs();
    ok(String(gi.inputs.graph_update).startsWith("oversize:") && gi.problems.some((p) => p.includes("graph-update")), "B-1 oversize graph-update → oversize marker **且** problems 非空（不再只带 marker 放行）", { marker: gi.inputs.graph_update, problems: gi.problems.slice(0, 2) });
    ok(gi.incomplete === false, "B-1b 纯超界裁决口径 = failed（非 I/O incomplete）");
    const v = graphEval();
    ok(v.verdict === "failed" && v.itemVerdict === "failed", "B-1c 锁内有界图源探针把 oversize graph-update 明确判 failed（不是 stale/marker 放行）", { verdict: v.verdict, itemVerdict: v.itemVerdict });
    ok(Array.isArray(v.actual.graph_input_problems) && (v.actual.graph_input_problems as string[]).length > 0, "B-1d item.actual 带 graph_input_problems（异常进入指纹，可复核）");
    clearArch();
  }
  {
    // B-2 oversize modules：图输入身份另一条实际路径同样明确失败。
    writeArch("modules.json", Buffer.alloc(FILE_MAX + 1, 0x20));
    const gi = readGraphInputs();
    ok(String(gi.inputs.modules).startsWith("oversize:") && gi.problems.some((p) => p.includes("modules")), "B-2 oversize modules.json → problems 非空（图模块采集事实也不放行）", { marker: gi.inputs.modules, problems: gi.problems.slice(0, 2) });
    const v = graphEval();
    ok(v.verdict !== "passed", "B-2b oversize modules → graph_full 项不可 passed", { verdict: v.verdict });
    clearArch();
  }
  {
    // B-3 明确总限：三个 6MB 文件（各自 ≤8MB 单文件上限）合计 18MB > 16MB → total_budget_exceeded 也算异常。
    writeArch("blueprint.json", Buffer.alloc(6 * 1024 * 1024, 0x7b));
    writeArch("modules.json", Buffer.alloc(6 * 1024 * 1024, 0x7b));
    writeArch("supplement.json", Buffer.alloc(6 * 1024 * 1024, 0x7b));
    const gi = readGraphInputs();
    ok(typeof gi.inputs.blueprint === "string" && typeof gi.inputs.modules === "string" && gi.inputs.blueprint.length === 64, "B-3 单文件都在 8MB 内（夹具前提：前两条正常出哈希）", { blueprint: String(gi.inputs.blueprint).slice(0, 12), modules: String(gi.inputs.modules).slice(0, 12) });
    ok(Object.values(gi.inputs).includes("total_budget_exceeded") && gi.problems.some((p) => p.includes("总字节")), "B-3b 明确总限超界 → total_budget_exceeded **且** problems 非空", { inputs: gi.inputs, problems: gi.problems.slice(0, 2) });
    const v = graphEval();
    ok(v.verdict === "failed", "B-3c 总限超界 → 明确 failed（不静默截断后当通过）", { verdict: v.verdict });
    clearArch();
  }
  {
    // B-4 非常规文件：目录占位 → not_regular_file 也是异常（不是 null 空态）。
    mkdirp(path.join(archDir, "names.json"));
    const gi = readGraphInputs();
    ok(gi.inputs.names === "not_regular_file" && gi.problems.some((p) => p.includes("names")), "B-4 目录占位 names.json → not_regular_file **且** problems 非空", { marker: gi.inputs.names, problems: gi.problems.slice(0, 2) });
    const v = graphEval();
    ok(v.verdict === "failed", "B-4b 非常规图输入 → 明确 failed", { verdict: v.verdict });
    clearArch();
  }
  {
    // B-5 缺失合法：只放一个正常文件，其余缺失 → null 且无 problems（回归：不误报 ENOENT）。
    writeJson(path.join(archDir, "semantic-status.json"), { state: "ok" });
    const gi = readGraphInputs();
    ok(gi.problems.length === 0 && gi.inputs.semantic_status !== null && gi.inputs.blueprint === null, "B-5 正常文件有哈希、缺失文件为 null 且无 problems（ENOENT 仍为合法空态）", { inputs: gi.inputs, problems: gi.problems });
    clearArch();
  }
  {
    // B-6 **故障注入（明确标注）**：lstatSync 在 modules.json 上改抛 EACCES（Windows 无法用真文件产出 EACCES）。
    //     断言点：绝不能 catch 一切异常当「不存在」；I/O 不可读裁决 incomplete。
    writeJson(path.join(archDir, "modules.json"), { version: 1, modules: [] });
    const target = path.join(archDir, "modules.json");
    const restore = fakeEacces(target);
    let injected: { inputs: Record<string, string | null>; problems: string[]; incomplete: boolean };
    let v: { verdict: string; itemVerdict: string };
    try {
      injected = readGraphInputs();
      v = graphEval();
    } finally {
      restore();
    }
    ok(injected.inputs.modules === "lstat_failed", "B-6（故障注入）非 ENOENT 的 lstat 失败 → 不当 null 空态（标记 lstat_failed）", { modules: injected.inputs.modules });
    ok(injected.problems.length > 0 && injected.problems.some((p) => p.includes("modules")), "B-6b（故障注入）EACCES 进 problems（不被静默吞成缺失）", { problems: injected.problems.slice(0, 2) });
    ok(injected.incomplete === true, "B-6c（故障注入）I/O 不可读裁决 incomplete（与纯超界的 failed 区分）");
    ok(v.itemVerdict === "incomplete", "B-6d（故障注入）锁内有界图源探针把不可读图输入明确判 incomplete", { verdict: v.verdict, itemVerdict: v.itemVerdict });
    clearArch();
  }
  {
    // B-7 全量探针同口径：oversize 图输入 → ok=false、problems 非空、verdict 非 passed（不只带 marker 放行）。
    writeArch("graph-update.json", Buffer.alloc(FILE_MAX + 1, 0x20));
    const full = probeMod.syncGraphProbe();
    if (full === null) {
      ok(false, "B-7 全量图探针已注册（注册制）");
    } else {
      const res = full(PID, dataDir);
      const gp = res.graph_input_problems ?? [];
      ok(res.ok === false && gp.length > 0, "B-7 全量探针：oversize 图输入 → ok=false 且 graph_input_problems 非空", { ok: res.ok, problems: gp.slice(0, 2) });
      ok(res.verdict !== "passed", "B-7b 全量探针：图输入异常 → verdict 非 passed", { verdict: res.verdict, reasons: res.reasons.slice(0, 2) });
      ok(gp.some((p) => p.includes("graph-update")), "B-7c 全量探针点名具体图输入路径（可复核）");
    }
    clearArch();
  }

  // ═══ 收尾 ═══
  console.log("[verify] ── 汇总");
  info(`PASS ${passCount} / FAIL ${failCount}`);
  if (process.env.TATAI_KEEP_TMP !== "1") {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((e: unknown) => {
  console.error(`[verify] FAIL 脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
