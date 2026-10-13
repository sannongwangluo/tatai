// verify-v09-37-source-stability：V09-37 独审 BLOCK-1 返工的**生产路径**源码稳定性回归（内置化）。
//
// 由来：BLOCK-1 的生产路径反例原先只在私有诊断目录里（`<diagnose>/performance-fix/probe-block1-rework.ts`，
//   依赖机器私有绝对路径）。本脚本把其中**真正有价值的生产路径变更检测用例**迁移进仓库，
//   相对 REPO 定位源码、只用隔离 mkdtemp 夹具（不依赖任何 D: 私有路径、不碰真实 ~/.tatai / 真实项目/账本）。
//
// 目的：钉住「同步链的派生作用域**不得**吞掉六图探针 pre/post 对 DESIGN/PLAN/图输入源变的检出」——
//   · 注册**合成**六图探针（ok=true/verdict=passed，baseline 与契约一致）→ 若无源变，图项本应 passed；
//   · 注册**合成**图源探针：其 design/plan 修订经真实 `loadDocument` 读取（正是被派生记忆影响的那条链），
//     有界图输入身份经真实 fs 读；
//   · 走**真实生产路径** `computeSyncStatusView`（→ readSyncStatus → evalContext → memoizeGraphProbe →
//     graphProbeKeyOf 的 pre/post）。
//
// 期望语义：
//   B0 控制（不改源）→ 图项 passed（证明夹具本身会通过，不是被其它原因压在 stale）。
//   B1/B2/B3（构建中改 design / plan / 图输入各一次）→ 图项**不再 passed**，且出现「构建期间被改动」过期原因。
//   B4 持续改 design → 连续 3 次图项都不 passed（fail-closed，不带旧绿放行）。
//   B5 还原 design → 图项恢复 passed（作用域不跨请求残留）。
//   改前（BLOCK-1）：处理组图项**仍 passed** → 本脚本红；改后：stale（非 passed）→ 绿。
//   C1–C6 derivationScope 机制面：绕过显式、可嵌套、不清空外层记忆、收尾不在作用域/绕过里。
//
// 运行：node --import tsx scripts/verify-v09-37-source-stability.ts
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addProject } from "../src/server/registry";
import { WorkService } from "../src/server/work/service";
import { buildRegisterContractCommand } from "../src/server/work/sync";
import { validateSyncContract, syncContractSha256 } from "../src/server/work/syncContract";
import { registerSyncGraphProbe, registerSyncGraphSourceProbe } from "../src/server/work/syncProbe";
import { computeSyncStatusView } from "../src/server/work/readJobs";
import { loadDocument } from "../src/server/work/documents";
import { withDerivationScope, withoutDerivationScope, derivationScopeStats, inDerivationScope } from "../src/server/work/derivationScope";

const sha256 = (d: string | Buffer): string => crypto.createHash("sha256").update(d).digest("hex");
const mkdirp = (d: string): void => { fs.mkdirSync(d, { recursive: true }); };
const write = (f: string, t: string): void => { mkdirp(path.dirname(f)); fs.writeFileSync(f, t); };

let pass = 0;
const fails: string[] = [];
const check = (id: string, ok: boolean, detail: unknown): void => {
  console.log(`[verify] ${ok ? "PASS" : "FAIL"} ${id}`);
  if (ok) pass += 1;
  else {
    fails.push(id);
    console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1600)}`);
  }
};

const EXPIRED = "在本次构建期间被改动";

function main(): void {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-v0937-srcstab-"));
  try {
    const dataDir = path.join(tmpBase, "home");
    const root = path.join(tmpBase, "proj");
    const workDir = path.join(root, ".工作台", "work");
    const inbox = path.join(workDir, "sync-inbox");
    const archDir = path.join(root, ".工作台", "arch");
    const PID = "srcstabfx";
    const SOURCE_REL = "reports/keep.md";
    const SOURCE_ABS = path.join(root, SOURCE_REL);
    const DESIGN_ABS = path.join(root, ".工作台", "design.md");
    const PLAN_ABS = path.join(root, ".工作台", "plan.md");
    const MODULES_ABS = path.join(archDir, "modules.json");

    mkdirp(dataDir);
    mkdirp(inbox);
    const designV1 = "# D srcstab\n\n## 1 x\n\nbase\n";
    const planV1 = "# P srcstab\n\n| 卡号 | 状态 |\n| --- | --- |\n";
    write(DESIGN_ABS, designV1);
    write(PLAN_ABS, planV1);
    write(MODULES_ABS, JSON.stringify({ version: 1, modules: [{ id: "src", path: "src", file_count: 1, deps: [] }] }));
    const sourceText = "keep-srcstab\n";
    write(SOURCE_ABS, sourceText);
    const sourceSha = sha256(sourceText);

    addProject({ id: PID, name: PID, path: root, kind: "backend" }, dataDir);
    const service = new WorkService({ dataDir });

    // ── 合成探针：图源探针经真实 loadDocument 读 design/plan（记忆影响链）+ 真实 fs 读图输入 ──
    const designRevOf = (pid: string, dd: string): string | null => loadDocument(pid, "design", dd)?.revision.content_sha256 ?? null;
    const planRevOf = (pid: string, dd: string): string | null => loadDocument(pid, "plan", dd)?.revision.content_sha256 ?? null;
    const planDefOf = (pid: string, dd: string): string | null => loadDocument(pid, "plan", dd)?.revision.definition_sha256 ?? null;
    const modulesHash = (): string | null => {
      try { return sha256(fs.readFileSync(MODULES_ABS)); } catch { return null; }
    };
    registerSyncGraphSourceProbe((pid: string, dd: string) => ({
      ok: true,
      baseline_id: "bl-syn",
      baseline_valid: true,
      design_revision: designRevOf(pid, dd),
      plan_revision: planRevOf(pid, dd),
      plan_definition_revision: planDefOf(pid, dd),
      graph_inputs: { modules: modulesHash() },
      graph_input_problems: [],
      graph_input_verdict: null,
      reasons: [],
    }));
    // 合成全量探针：ok=true/verdict=passed（若 pre/post 键一致就会采用它 → 图项 passed）
    registerSyncGraphProbe(() => ({
      ok: true,
      verdict: "passed",
      baseline_id: "bl-syn",
      baseline_valid: true,
      design_revision: null,
      plan_revision: null,
      plan_definition_revision: null,
      graph_inputs: {},
      graph_input_problems: [],
      availability: "published",
      update_state: null,
      collection_status: "complete",
      complete: true,
      anomalies: [],
      reasons: [],
    }));

    // ── 登记含 graph_full 的现行批次（期望基线 = 合成探针的 baseline）──
    const raw = {
      schema_version: 1,
      batch_id: "g1",
      project_id: PID,
      title: "srcstab graph_full 批次",
      sources: [{ path: SOURCE_REL, sha256: sourceSha }],
      items: [{ id: "chk", label: "六图全量", required: true, check: { type: "graph_full", expected_baseline_id: "bl-syn" } }],
      blocks_entry: false,
    };
    const contract = validateSyncContract(raw);
    const cmd = buildRegisterContractCommand({ projectId: PID, changeId: "chgB1", actorId: "fixture", role: "coordinator", contract, expectedRevision: null });
    if (!service.submit(cmd).ok) throw new Error("srcstab 契约登记失败");
    write(path.join(inbox, "g1.evidence.json"), `${JSON.stringify({
      schema_version: 1, batch_id: "g1", project_id: PID,
      contract_sha256: syncContractSha256(contract),
      completed: true,
      items: [{ id: "chk", result: "passed", artifacts: [{ path: SOURCE_REL, sha256: sourceSha }] }],
    }, null, 2)}\n`);

    // ── 源变注入 harness：按绝对路径监视 readFileSync，读后执行一次/多次改写 ──
    const origRead = fs.readFileSync;
    type Mutator = (readNo: number) => void;
    function runWithMutations<T>(watch: Map<string, Mutator>, fn: () => T): { value: T; reads: Map<string, number> } {
      const wanted = new Map<string, { abs: string; mut: Mutator }>();
      for (const [p, mut] of watch) wanted.set(path.resolve(p), { abs: path.resolve(p), mut });
      const reads = new Map<string, number>();
      (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = function (p: unknown, ...rest: unknown[]) {
        const abs = path.resolve(String(p));
        const hit = wanted.get(abs);
        if (hit !== undefined) reads.set(abs, (reads.get(abs) ?? 0) + 1);
        const out = (origRead as (...a: unknown[]) => unknown).call(fs, p, ...rest);
        if (hit !== undefined) hit.mut(reads.get(abs)!);
        return out;
      } as typeof fs.readFileSync;
      try {
        return { value: fn(), reads };
      } finally {
        (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = origRead;
      }
    }

    const itemOf = (report: unknown): { verdict: string; reasons: string[] } => {
      const r = report as { batches?: { batch_id?: string; items?: { verdict?: unknown; reasons?: unknown }[] }[] };
      const b = (r?.batches ?? []).find((x) => x.batch_id === "g1");
      const it = b?.items?.[0];
      return { verdict: String(it?.verdict), reasons: (it?.reasons ?? []) as string[] };
    };
    const runOnce = (): { verdict: string; reasons: string[]; expired: boolean } => {
      const r = computeSyncStatusView({ projectId: PID, dataDir });
      const it = itemOf(r);
      return { ...it, expired: it.reasons.some((x) => x.includes(EXPIRED)) };
    };

    // ═══ B 生产路径：控制（不改源）→ passed；处理（构建中改源）→ 不再 passed ═══
    {
      const control = runOnce();
      check(
        "B0 控制：构建期间不改源 → 合成图项 passed（夹具本身会通过，不是被其它原因压成 stale）",
        control.verdict === "passed" && !control.expired,
        control,
      );

      const design = runWithMutations(new Map([[DESIGN_ABS, (n: number) => { if (n === 1) fs.appendFileSync(DESIGN_ABS, "\n<!-- mutated during build -->\n"); }]]), runOnce);
      check(
        "B1 构建期间改 design.md → 图项**不再 passed**，且出现「构建期间被改动」过期原因",
        design.value.verdict !== "passed" && design.value.expired,
        { ...design.value, designReads: design.reads.get(path.resolve(DESIGN_ABS)) ?? 0 },
      );

      fs.writeFileSync(DESIGN_ABS, designV1); // 还原

      const plan = runWithMutations(new Map([[PLAN_ABS, (n: number) => { if (n === 1) fs.appendFileSync(PLAN_ABS, "\n<!-- mutated during build -->\n"); }]]), runOnce);
      check(
        "B2 构建期间改 plan.md → 图项**不再 passed**，且出现过期原因",
        plan.value.verdict !== "passed" && plan.value.expired,
        { ...plan.value, planReads: plan.reads.get(path.resolve(PLAN_ABS)) ?? 0 },
      );
      fs.writeFileSync(PLAN_ABS, planV1);

      const ginput = runWithMutations(new Map([[MODULES_ABS, (n: number) => { if (n === 1) fs.writeFileSync(MODULES_ABS, JSON.stringify({ version: 1, modules: [{ id: "src", path: "src", file_count: 9, deps: [] }] })); }]]), runOnce);
      check(
        "B3 构建期间改图输入 modules.json → 图项**不再 passed**，且出现过期原因",
        ginput.value.verdict !== "passed" && ginput.value.expired,
        { ...ginput.value, modulesReads: ginput.reads.get(path.resolve(MODULES_ABS)) ?? 0 },
      );
      write(MODULES_ABS, JSON.stringify({ version: 1, modules: [{ id: "src", path: "src", file_count: 1, deps: [] }] }));

      // B4 持续改（每次读 design 都追加）→ 连续 3 次都不 passed（fail-closed）
      fs.writeFileSync(DESIGN_ABS, designV1);
      const sustained: { verdict: string; expired: boolean }[] = [];
      for (let i = 0; i < 3; i++) {
        const r = runWithMutations(new Map([[DESIGN_ABS, () => fs.appendFileSync(DESIGN_ABS, "\n<!-- churn -->\n")]]), runOnce);
        sustained.push({ verdict: r.value.verdict, expired: r.value.expired });
      }
      check(
        "B4 持续改 design → 连续 3 次图项都不 passed（fail-closed，不带旧绿放行）",
        sustained.every((s) => s.verdict !== "passed" && s.expired),
        sustained,
      );
      fs.writeFileSync(DESIGN_ABS, designV1);

      // 还原后再跑一次，确认回到 passed（不是被永久污染）
      const restored = runOnce();
      check("B5 还原 design → 图项恢复 passed（作用域不跨请求残留）", restored.verdict === "passed" && !restored.expired, restored);
    }

    // ═══ C derivationScope 机制面：绕过显式、可嵌套、不清空 ═══
    {
      const countReads = <T>(fn: () => T): { value: T; reads: number } => {
        let reads = 0;
        (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = function (p: unknown, ...rest: unknown[]) {
          if (path.resolve(String(p)) === path.resolve(DESIGN_ABS)) reads += 1;
          return (origRead as (...a: unknown[]) => unknown).call(fs, p, ...rest);
        } as typeof fs.readFileSync;
        try { return { value: fn(), reads }; } finally { (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = origRead; }
      };

      const c1 = countReads(() => withDerivationScope(() => { loadDocument(PID, "design", dataDir); loadDocument(PID, "design", dataDir); }));
      check("C1 作用域内两次 loadDocument → 只读盘 1 次（记忆仍在）", c1.reads === 1, { reads: c1.reads });

      const c2 = countReads(() => withDerivationScope(() => {
        let bypassing = false;
        const before = derivationScopeStats();
        withoutDerivationScope(() => {
          bypassing = derivationScopeStats().bypassing;
          loadDocument(PID, "design", dataDir);
          loadDocument(PID, "design", dataDir);
        });
        return { bypassing, beforeActive: before.active };
      }));
      check("C2 withoutDerivationScope 内两次 loadDocument → 读盘 2 次（显式绕过），stats.bypassing=true", c2.reads === 2 && c2.value.bypassing === true, { reads: c2.reads, ...c2.value });

      const c3 = countReads(() => withDerivationScope(() => {
        loadDocument(PID, "design", dataDir);          // 1 次，落记忆
        withoutDerivationScope(() => loadDocument(PID, "design", dataDir)); // +1 次（绕过，不落）
        loadDocument(PID, "design", dataDir);          // 命中外层记忆 → +0
        return derivationScopeStats().entries;
      }));
      check("C3 绕过之后外层记忆未被清空：再读命中（总读盘 2 次）", c3.reads === 2, { reads: c3.reads, entries: c3.value });

      const c4 = countReads(() => withDerivationScope(() => {
        loadDocument(PID, "design", dataDir);          // 1 次
        withoutDerivationScope(() => withDerivationScope(() => loadDocument(PID, "design", dataDir))); // 嵌套作用域内绕过 → +1
        loadDocument(PID, "design", dataDir);          // 外层记忆仍在 → +0
        return derivationScopeStats().entries;
      }));
      check("C4 绕过里再开嵌套作用域不清空外层记忆（总读盘 2 次）", c4.reads === 2, { reads: c4.reads, entries: c4.value });

      const c5 = { outside: derivationScopeStats().bypassing, inScope: withDerivationScope(() => derivationScopeStats().bypassing), inBypass: withDerivationScope(() => withoutDerivationScope(() => derivationScopeStats().bypassing)) };
      check("C5 stats.bypassing：作用域外 false、作用域内(未绕过) false、绕过窗口 true", c5.outside === false && c5.inScope === false && c5.inBypass === true, c5);
      check("C6 收尾不在作用域/绕过里", inDerivationScope() === false && derivationScopeStats().bypassing === false, { active: inDerivationScope() });
    }
  } finally {
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n[verify] V09-37 源码稳定性：PASS ${pass} / FAIL ${fails.length}`);
  if (fails.length > 0) {
    for (const f of fails) console.log(`[verify]   FAIL ${f}`);
    process.exit(1);
  }
  console.log("[verify] 全部 PASS");
}

try {
  main();
} catch (e) {
  console.error(`[verify] 探针异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
}
