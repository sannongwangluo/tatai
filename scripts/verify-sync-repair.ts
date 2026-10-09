// V09-48（P3）· 同步只读修复计划与候选证据边界 · 专项回归（先红后绿）。
//
// 规范来源：docs/agent-optimization-20261006.md §7（含 coordinator-decisions.md 的纠正，以父目录
// patch-stage/new/docs 的同名最终稿为准）；PLAN V09-48。判据设计（含 P3 非作者复核 5 点返工）：
//   · 只对**现行（active）批次**给修复计划；被 supersede 的历史批次不参与、不重扫、不阻断。
//   · 逐项给全 + 结构化 `next_read_entry`（tool+args，不是 JSON 式字符串）+ 缺证项的**具体补证动作**
//     （目标路径/角色/核对内容 + 补证完成后的 scan 入口；missing 不再只建议"再扫一遍"）。
//   · `registered_by`（登记事件角色）与 `recommended_role`（按失败类型的**建议**）分开；不替人授权。
//   · 候选**只对能机械生成/可复用的项**：优先**保留仍适用的既有证据工件**（不替换成契约来源），
//     否则按 check 真实目标机械生成**整文件** sha（含 section 项也用整文件、不用章节哈希）；非机械项
//     （task_states/graph_full/未知）且无可复用旧工件 ⇒ 必需项 ⇒ `candidate_unavailable_reason`，不代造。
//   · 候选草稿默认 `completed:false`；身份/输入版本在 `meta`。**实核走真实 scan 链路**（无独立重复 helper）。
//   · `graph_full` 命中"图正在更新" ⇒ `waiting_for_derivation` + 可重试原因；**有其它失败时不冒充唯一原因**；
//     依据不足不编 ETA；**绝不改变 v1 阻断**。
//   · 只读就是零写入：按字节判（事件账本与证据库无新增）。
//   · 接续入口（entry/task_brief）的同步段带修复计划，且**复用同一次同步评估**（全量评估不翻倍）。
//
// 隔离口径（AGENTS.md §5）：mkdtemp 夹具 + 隔离 dataDir；不碰真实 ~/.tatai、真实项目与账本、不接网关、不调模型。
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
const readText = (f: string): string => fs.readFileSync(f, "utf8");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const loadSrc = async <T>(rel: string): Promise<T> => (await import(pathToFileURL(path.join(SRC, rel)).href)) as T;

/** 递归内容哈希：用于"只读就是零写入"的字节级判定（文件名 + 内容 sha）。 */
const treeHash = (dir: string): string => {
  const rows: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try { names = fs.readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch { rows.push(`${path.relative(dir, p)}\u0000gone`); continue; }
      if (st.isDirectory()) walk(p);
      else rows.push(`${path.relative(dir, p).replace(/\\/g, "/")}\u0000${st.isFile() ? sha256(fs.readFileSync(p)) : "nonfile"}`);
    }
  };
  walk(dir);
  return sha256(rows.join("\n"));
};

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-sync-repair-"));
const dataDir = path.join(tmpBase, "home");
const root = path.join(tmpBase, "proj-repair");
const workDir = path.join(root, ".工作台", "work");
const inbox = path.join(workDir, "sync-inbox");
const archDir = path.join(root, ".工作台", "arch");
const PID = "repairfx";
const CHG = "chg-repair";

const SCOPE_A_REL = "reports/scope_a.md";
const SCOPE_B_REL = "reports/scope_b.md";
const RESULT_REL = "reports/result.md";
const RECEIPT_REL = "reports/receipt.json";
const DOC_REL = "reports/doc.md";
const COPY_SRC_REL = "reports/copy_src.md";
const COPY_RESULT_REL = "reports/copy_result.md";
const SCOPE_A_ABS = path.join(root, SCOPE_A_REL);
const SCOPE_B_ABS = path.join(root, SCOPE_B_REL);
const RESULT_ABS = path.join(root, RESULT_REL);
const RECEIPT_ABS = path.join(root, RECEIPT_REL);
const DOC_ABS = path.join(root, DOC_REL);
const COPY_SRC_ABS = path.join(root, COPY_SRC_REL);
const COPY_RESULT_ABS = path.join(root, COPY_RESULT_REL);

const DOC_TEXT = "# 塔台文档\n\n说明段。\n\n## 1 概述\n\n概述正文一行。\n\n## 2 细节\n\n细节正文一行。\n";
const DOC_SECTION = "塔台文档 / 1 概述";

async function main(): Promise<void> {
  info(`同步只读修复计划与候选证据边界 · 专项回归（${process.platform} · node ${process.version}）`);
  info(`  夹具根 ${tmpBase}（隔离 dataDir ${dataDir}）`);

  const registryMod = await loadSrc<typeof import("../src/server/registry")>("server/registry.ts");
  const serviceMod = await loadSrc<typeof import("../src/server/work/service")>("server/work/service.ts");
  const syncMod = await loadSrc<typeof import("../src/server/work/sync")>("server/work/sync.ts");
  const contractMod = await loadSrc<typeof import("../src/server/work/syncContract")>("server/work/syncContract.ts");
  const checksMod = await loadSrc<typeof import("../src/server/work/syncChecks")>("server/work/syncChecks.ts");
  const eventStoreMod = await loadSrc<typeof import("../src/server/work/eventStore")>("server/work/eventStore.ts");
  const probeMod = await loadSrc<typeof import("../src/server/work/syncProbe")>("server/work/syncProbe.ts");
  const materialMod = await loadSrc<typeof import("../src/shared/materialSection")>("shared/materialSection.ts");
  const entryMod = await loadSrc<typeof import("../src/server/work/entry")>("server/work/entry.ts");
  const briefMod = await loadSrc<typeof import("../src/server/work/taskBrief")>("server/work/taskBrief.ts");
  type StatusReport = ReturnType<typeof syncMod.readSyncStatus>;
  type AnyReport = StatusReport & { repair_plan?: any };

  // ═══ 0. 夹具：真实文件、真实契约、真实收件目录（隔离 dataDir）═══
  mkdirp(dataDir);
  mkdirp(root);
  mkdirp(inbox);
  mkdirp(archDir);
  write(path.join(root, ".工作台", "design.md"), "# 修复计划夹具设计书\n\n## 1 目标\n\n夹具设计正文。\n");
  write(path.join(root, ".工作台", "plan.md"), "# 修复计划夹具施工图\n\n## 1 卡区\n\n夹具施工正文。\n");
  write(SCOPE_A_ABS, "原始工作范围 A\n");
  write(SCOPE_B_ABS, "原始工作范围 B\n");
  write(RESULT_ABS, "夹具结果文件（artifact）。\n");
  writeJson(RECEIPT_ABS, { result: "ok", detail: "夹具回执" });
  write(DOC_ABS, DOC_TEXT);
  write(COPY_SRC_ABS, "复制候选夹具来源（原始）。\n");
  write(COPY_RESULT_ABS, "复制候选夹具结果（原始）。\n");
  writeJson(path.join(archDir, "modules.json"), { version: 1, generated_at: "2026-10-06T00:00:00.000Z", budget_exhausted: false, modules: [{ id: "src", path: "src", file_count: 1, loc: 0, deps: [] }] });

  registryMod.addProject({ id: PID, name: "修复计划夹具", path: root, kind: "backend" }, dataDir);
  const service = new serviceMod.WorkService({ dataDir });
  const submitter = { submit: (c: unknown) => service.submit(c) };

  const mkArt = (abs: string): { path: string; sha256: string } => ({ path: path.relative(root, abs).replace(/\\/g, "/"), sha256: sha256(fs.readFileSync(abs)) });
  const postEvidence = (batchId: string, pkg: unknown): void => {
    const tmp = path.join(inbox, `.${batchId}.evidence.json.tmp-${crypto.randomBytes(3).toString("hex")}`);
    fs.writeFileSync(tmp, `${JSON.stringify(pkg, null, 2)}\n`);
    fs.renameSync(tmp, path.join(inbox, `${batchId}.evidence.json`));
  };
  const mkEvidence = (batchId: string, contractSha: string, items: { id: string; result: string; artifacts?: { path: string; sha256: string }[] }[], completed = true): unknown => ({
    schema_version: 1,
    batch_id: batchId,
    project_id: PID,
    contract_sha256: contractSha,
    completed,
    items: items.map((it) => ({ id: it.id, result: it.result, artifacts: it.artifacts ?? [mkArt(RESULT_ABS)] })),
  });

  const baseItems = (): unknown[] => [
    { id: "result", label: "结果文件哈希（整文件绑定）", required: true, check: { type: "file_hash", path: RESULT_REL, sha256: sha256(readText(RESULT_ABS)) } },
    { id: "receipt", label: "回执字段", required: true, check: { type: "json_value", path: RECEIPT_REL, pointer: "/result", expected: "ok" } },
  ];

  const registered = new Map<string, { sha: string; seq: number }>();
  const register = (batchId: string, sources: { path: string; sha256: string }[], items: unknown[], extra: Record<string, unknown> = {}, role = "designer"): void => {
    const raw = { schema_version: 1, batch_id: batchId, project_id: PID, title: `批次 ${batchId}`, sources, items, blocks_entry: true, ...extra };
    const contract = contractMod.validateSyncContract(raw);
    const cmd = syncMod.buildRegisterContractCommand({ projectId: PID, changeId: CHG, actorId: "fixture", role, contract, expectedRevision: null });
    const receipt = service.submit(cmd);
    if (!receipt.ok || receipt.projection.state !== "applied") throw new Error(`登记 ${batchId} 失败：${JSON.stringify(receipt).slice(0, 300)}`);
    registered.set(batchId, { sha: contractMod.syncContractSha256(contract), seq: receipt.seq });
  };

  const scopeA = (): { path: string; sha256: string } => ({ path: SCOPE_A_REL, sha256: sha256(readText(SCOPE_A_ABS)) });
  const scopeB = (): { path: string; sha256: string } => ({ path: SCOPE_B_REL, sha256: sha256(readText(SCOPE_B_ABS)) });

  // 历史 + 现行 + 漂移 + 缺证 + 图等待 + 章节锚定 + 非机械项 + 旧工件复用 + 复制候选
  register("old1", [scopeA()], baseItems());
  register("pass1", [scopeA()], baseItems(), { supersedes: "old1" });
  register("drift1", [scopeB()], baseItems());
  register("missing1", [scopeA()], [
    ...baseItems(),
    { id: "opt", label: "非必需项（也如实列 missing）", required: false, check: { type: "file_hash", path: RESULT_REL, sha256: sha256(readText(RESULT_ABS)) } },
  ]);
  register("graph1", [scopeA()], [{ id: "g", label: "六图同快照取齐", required: true, check: { type: "graph_full", expected_baseline_id: "bl-repair" } }]);
  const docDigest = materialMod.markdownSectionDigest(fs.readFileSync(DOC_ABS), DOC_SECTION);
  if (!docDigest.ok) throw new Error(`章节夹具解析失败：${JSON.stringify(docDigest)}`);
  const SECTION_SHA = docDigest.sha256;
  register("sec1", [scopeA()], [{ id: "sec", label: "章节子树哈希（含 section 的来源）", required: true, check: { type: "markdown_section", path: DOC_REL, section: DOC_SECTION, sha256: SECTION_SHA } }]);
  register("states1", [scopeA()], [{ id: "st", label: "账本任务状态（非机械项）", required: true, check: { type: "task_states", scope_mode: "current", expected: { "T-missing": "done" } } }]);
  register("reuse1", [scopeA()], [{ id: "res", label: "结果文件哈希", required: true, check: { type: "file_hash", path: RESULT_REL, sha256: sha256(readText(RESULT_ABS)) } }]);
  register("copy1", [{ path: COPY_SRC_REL, sha256: sha256(readText(COPY_SRC_ABS)) }], [
    { id: "res", label: "复制候选的目标文件哈希", required: true, check: { type: "file_hash", path: COPY_RESULT_REL, sha256: sha256(readText(COPY_RESULT_ABS)) } },
  ]);

  postEvidence("pass1", mkEvidence("pass1", registered.get("pass1")!.sha, [
    { id: "result", result: "passed", artifacts: [mkArt(RESULT_ABS)] },
    { id: "receipt", result: "passed", artifacts: [mkArt(RECEIPT_ABS)] },
  ]));
  postEvidence("drift1", mkEvidence("drift1", registered.get("drift1")!.sha, [
    { id: "result", result: "passed", artifacts: [mkArt(RESULT_ABS)] },
    { id: "receipt", result: "passed", artifacts: [mkArt(RECEIPT_ABS)] },
  ]));
  postEvidence("graph1", mkEvidence("graph1", registered.get("graph1")!.sha, [{ id: "g", result: "passed", artifacts: [mkArt(SCOPE_A_ABS)] }]));
  // reuse1：证据工件的路径与 check 目标**不同**（artifact=receipt.json，check 目标=result.md）——用于测"旧适用工件保留"。
  postEvidence("reuse1", mkEvidence("reuse1", registered.get("reuse1")!.sha, [{ id: "res", result: "passed", artifacts: [mkArt(RECEIPT_ABS)] }]));
  postEvidence("copy1", mkEvidence("copy1", registered.get("copy1")!.sha, [{ id: "res", result: "passed", artifacts: [mkArt(COPY_RESULT_ABS)] }]));

  // 图探针：注册一个"图正在更新"的**假**全量探针（隔离；syncGraph 未加载，无真实图构建）。probeExtraReason
  // 非 null 时额外带回一条原因（模拟"除 updating 外还有其它失败原因"）。
  let probeCalls = 0;
  let probeExtraReason: string | null = null;
  probeMod.registerSyncGraphProbe(() => {
    probeCalls += 1;
    const extra = probeExtraReason;
    return {
      ok: false,
      verdict: "failed",
      baseline_id: "bl-repair",
      baseline_valid: true,
      design_revision: "d-fix",
      plan_revision: "p-fix",
      plan_definition_revision: "pd-fix",
      graph_inputs: {},
      graph_input_problems: [],
      availability: extra === null ? "published" : "draft",
      update_state: "updating",
      collection_status: "complete",
      complete: true,
      anomalies: [],
      reasons: extra === null ? ["图正在更新"] : [extra, "图正在更新"],
    };
  });

  const syncEvents = (): { seq: number; entity_id: string; type: string }[] =>
    eventStoreMod.loadEvents(workDir).events.filter((e) => e.type.startsWith("sync.")).map((e) => ({ seq: e.seq, entity_id: e.entity_id, type: e.type }));
  const entityEvents = (entity: string): number => syncEvents().filter((e) => e.entity_id === entity).length;
  const scan = (): Promise<unknown> => syncMod.scanSyncProject({ projectId: PID, dataDir, submitter });
  const batchOf = (r: AnyReport, id: string): any => (r.batches as any[]).find((b) => b.batch_id === id);
  const inPlan = (r: AnyReport, id: string): any => (r.repair_plan?.batches ?? []).find((b: any) => b.batch_id === id);
  const itemOf = (b: any, id: string): any => (b?.items ?? []).find((i: any) => i.item_id === id);

  await scan();
  const boot = syncMod.readSyncStatus(PID, dataDir) as AnyReport;
  ok(batchOf(boot, "pass1")?.verdict === "passed", "0-1 现行批次 pass1 证据齐全 → passed（夹具前置）", { verdict: batchOf(boot, "pass1")?.verdict });
  ok(batchOf(boot, "reuse1")?.verdict === "passed", "0-2 reuse1（artifact 与 check 目标不同）凭真实目标仍 passed（夹具前置）", { verdict: batchOf(boot, "reuse1")?.verdict });

  // ═══ 1. 修复计划：只对现行批次、逐项给全、结构化入口 ═══
  info("── 1. 只读修复计划（现行批次、逐项给全、结构化 next_read_entry）");
  const r1 = syncMod.readSyncStatus(PID, dataDir) as AnyReport;
  const rp = r1.repair_plan;
  ok(rp !== undefined && rp !== null, "1-1 read_sync_status 响应附加只读修复计划 repair_plan");
  ok(rp?.read_only === true && rp?.generated_from === "read_sync_status", "1-2 修复计划显式只读、来源标注 read_sync_status", { read_only: rp?.read_only, generated_from: rp?.generated_from });
  const planIds = (rp?.batches ?? []).map((b: any) => b.batch_id);
  ok(["pass1", "drift1", "missing1", "graph1", "sec1", "states1", "reuse1", "copy1"].every((id) => planIds.includes(id)), "1-3 全部现行批次都在修复计划里", { planIds });
  ok(!planIds.includes("old1"), "1-4 被 supersede 的历史批次**不在**修复计划里（不参与、不重扫）", { planIds });
  ok(planIds.length > 0 && (rp?.batches ?? []).every((b: any) => b.active === true), "1-5 修复计划只含 active=true 批次");

  const pass = inPlan(r1, "pass1");
  ok(pass?.contract_generation?.sha256_12 === registered.get("pass1")!.sha.slice(0, 12) && pass?.contract_generation?.registered_seq === registered.get("pass1")!.seq && pass?.contract_generation?.active === true,
    "1-6 契约代次 contract_generation={sha256_12, registered_seq, active} 取自登记事实", pass?.contract_generation);
  ok(pass?.registered_by?.role === "designer" && pass?.registered_by?.actor_id === "fixture", "1-7 registered_by = 契约**登记事件**的 role/actor_id（不是责任人）", pass?.registered_by);
  const passResult = itemOf(pass, "result");
  const itemFields = ["item_id", "label", "required", "verdict", "reasons", "expected", "actual", "source_drift", "reusable_artifacts", "expired_artifacts", "registered_by", "recommended_role", "next_read_entry", "next_evidence_action", "waiting_for_derivation"];
  ok(itemFields.every((f) => f in (passResult ?? {})), "1-8 逐项给全规范字段（含 next_evidence_action）", { fields: Object.keys(passResult ?? {}) });
  ok(passResult?.verdict === "passed" && Array.isArray(passResult?.reusable_artifacts) && passResult.reusable_artifacts.length >= 1 && passResult.reusable_artifacts.every((a: any) => a.sha256 === sha256(readText(RESULT_ABS))),
    "1-9 仍与当前目标一致的可复用工件被列为 reusable_artifacts", passResult?.reusable_artifacts);
  ok(passResult?.next_read_entry?.tool === "read_sync_status" && passResult.next_read_entry.args?.project_id === PID && typeof passResult.next_read_entry !== "string",
    "1-10 next_read_entry 是**结构化** {tool,args}（不是 JSON 式字符串）", { next: passResult?.next_read_entry });
  ok(passResult?.next_evidence_action === null, "1-11 已通过项不带补证动作（next_evidence_action=null）");
  ok(passResult?.waiting_for_derivation === null, "1-12 非图项不带 waiting_for_derivation");

  // ═══ 2. 一次列全 + 缺证项的具体补证动作（不复用"再扫一遍"）═══
  info("── 2. 完整待补项 + 具体补证动作");
  const missing = inPlan(r1, "missing1");
  const missIds = (missing?.items ?? []).map((i: any) => i.item_id).sort();
  ok(JSON.stringify(missIds) === JSON.stringify(["opt", "receipt", "result"]), "2-1 缺证批次的**全部**项（含非必需）都列出，不被省略", { missIds });
  ok(missing !== undefined && (missing?.items ?? []).every((i: any) => i.verdict === "missing" && Array.isArray(i.reasons) && i.reasons.length >= 1), "2-2 每项给 verdict 与 reasons", missing?.items?.map((i: any) => [i.item_id, i.verdict]));
  const missResult = itemOf(missing, "result");
  const nea = missResult?.next_evidence_action;
  ok(nea !== undefined && nea !== null && typeof nea.action === "string" && nea.action.length > 0, "2-3 缺证项给**具体补证动作**（不是只建议再扫）", nea);
  ok(nea?.role === "executor" && nea?.evidence_path === `.工作台/work/sync-inbox/missing1.evidence.json`, "2-4 补证动作给目标路径与角色", { role: nea?.role, path: nea?.evidence_path });
  ok(Array.isArray(nea?.target_paths) && nea.target_paths.includes(RESULT_REL) && typeof nea?.verify === "string" && nea.verify.includes("整文件"), "2-5 补证动作给目标路径与核对内容", { targets: nea?.target_paths, verify: nea?.verify });
  ok(nea?.then_scan?.tool === "scan_sync_evidence" && nea.then_scan.args?.project_id === PID, "2-6 补证完成后再给扫描入口（结构化）", nea?.then_scan);
  ok(missResult?.next_read_entry?.tool === "project_entry" && missResult?.next_read_entry?.args?.role === "executor", "2-7 缺证项结构化读取入口指向建议角色", missResult?.next_read_entry);
  ok(missing !== undefined && (missing?.items ?? []).every((i: any) => i.next_read_entry !== undefined && typeof i.next_read_entry.tool === "string" && typeof i.next_read_entry.args === "object"), "2-8 每项都给结构化读取入口");

  // ═══ 3. registered_by 与 recommended_role 分开（Codex 纠正）═══
  info("── 3. registered_by / recommended_role 分开");
  ok(missing?.items?.every((i: any) => i.recommended_role === "executor"), "3-1 必需项缺证 → recommended_role=executor（按失败类型的建议）", missing?.items?.map((i: any) => [i.item_id, i.recommended_role]));
  ok(missing?.registered_by?.role === "designer" && missing?.items?.[0]?.registered_by?.role === "designer", "3-2 每项的 registered_by 是登记角色（designer）", { rb: missing?.registered_by });
  ok(missing?.items?.length === 3 && missing.items.every((i: any) => i.recommended_role !== i.registered_by?.role), "3-3 recommended_role 与 registered_by 分离（登记人 ≠ 责任人、不替人授权）");
  ok(!("responsible_role" in (missing?.items?.[0] ?? {})), "3-4 不出现把登记者冒充责任人的 responsible_role 字段");

  // ═══ 4. 来源漂移：逐项列出、只列不自动刷新、候选不成立 ═══
  info("── 4. 来源漂移（只列、不自动刷新）");
  const scopeBBefore = readText(SCOPE_B_ABS);
  write(SCOPE_B_ABS, "范围 B 在登记后被改（漂移）。\n");
  const r2 = syncMod.readSyncStatus(PID, dataDir) as AnyReport;
  const drift = inPlan(r2, "drift1");
  const driftItem = itemOf(drift, "result");
  ok(drift?.verdict === "stale", "4-1 登记来源独立漂移 → 批次 stale（不拿旧通过顶上）", { verdict: drift?.verdict });
  ok(JSON.stringify(driftItem?.source_drift) === JSON.stringify([{ path: SCOPE_B_REL, registered_sha256: sha256(scopeBBefore), current_sha256: sha256(readText(SCOPE_B_ABS)) }]),
    "4-2 source_drift 逐条给 {path, registered_sha256, current_sha256}（同一份快照，不另算）", driftItem?.source_drift);
  ok(driftItem?.recommended_role === "coordinator" && driftItem?.next_read_entry?.args?.role === "coordinator", "4-3 来源漂移 → coordinator（建议与结构化入口一致）", { role: driftItem?.recommended_role, next: driftItem?.next_read_entry });
  ok(drift?.candidate_evidence === null && typeof drift?.candidate_unavailable_reason === "string" && drift.candidate_unavailable_reason.length > 0,
    "4-4 来源漂移时**不**给候选（候选不自动采纳漂移）", { reason: drift?.candidate_unavailable_reason });
  ok(inPlan(r2, "pass1")?.verdict === "passed" && itemOf(inPlan(r2, "pass1"), "result")?.source_drift?.length === 0, "4-5 未被改的批次不受影响（逐批独立）");
  ok(batchOf(r2, "drift1")?.contract_sha256 === registered.get("drift1")!.sha, "4-6 修复计划不改契约（contract_sha256 不变）");
  write(SCOPE_B_ABS, scopeBBefore);

  // ═══ 5. 候选边界：旧工件保留 / 章节项整文件 sha / 草稿默认不完整 / 非机械项不代造 ═══
  info("── 5. 候选证据边界");
  const r3 = syncMod.readSyncStatus(PID, dataDir) as AnyReport;

  // 5.A 旧适用工件保留（reuse1：既有 artifact=receipt.json，check 目标=result.md）
  const reuseCand = inPlan(r3, "reuse1")?.candidate_evidence;
  const reusePkg = reuseCand?.package;
  const reuseArt = reusePkg?.items?.find((i: any) => i.id === "res")?.artifacts ?? [];
  ok(reuseArt.length === 1 && reuseArt[0].path === RECEIPT_REL && reuseArt[0].sha256 === sha256(readText(RECEIPT_ABS)),
    "5-1 候选**保留仍适用的既有证据工件**（不被替换成 check 目标/契约来源）", reuseArt);
  ok(reuseCand?.meta?.item_basis?.some((b: any) => b.item_id === "res" && b.basis === "reused_existing_evidence"), "5-2 候选 meta 标注工件来自「复用既有证据」", reuseCand?.meta?.item_basis);
  ok(reuseArt.every((a: any) => a.path !== SCOPE_A_REL), "5-3 候选不拿契约来源路径冒充目标工件");

  // 5.B 章节锚定项：artifact 用**整文件** sha（不是章节哈希）
  const secCand = inPlan(r3, "sec1")?.candidate_evidence;
  const secArt = secCand?.package?.items?.find((i: any) => i.id === "sec")?.artifacts ?? [];
  const docFullSha = sha256(fs.readFileSync(DOC_ABS));
  ok(secArt.length === 1 && secArt[0].path === DOC_REL && secArt[0].sha256 === docFullSha && secArt[0].sha256 !== SECTION_SHA,
    "5-4 含 section 的项：候选 artifact 是**整文件** sha，不是章节哈希", { art: secArt, docFullSha, SECTION_SHA });
  ok(secCand?.meta?.item_basis?.some((b: any) => b.item_id === "sec" && b.basis === "mechanical_target"), "5-5 章节项工件标注为按真实目标机械生成", secCand?.meta?.item_basis);

  // 5.C 候选是原闭键能读的证据包、默认 completed:false、未验证
  const pkg = reusePkg;
  const parsed = checksMod.parseEvidencePackage(pkg);
  ok(parsed.ok === true, "5-6 候选内层就是**原闭键解析**能读的证据包（可进既有正式 scan 链路）", parsed.ok === false ? parsed.reasons : undefined);
  ok(pkg?.completed === false && parsed.ok === true && parsed.pkg.completed === false, "5-7 候选草稿默认 completed=false（半成品，不进原流程就先不改）");
  ok(pkg?.batch_id === "reuse1" && pkg?.contract_sha256 === registered.get("reuse1")!.sha, "5-8 候选带输入版本（batch/契约哈希）");
  const candMeta = reuseCand?.meta;
  ok(candMeta?.verified === false && candMeta?.completed_default === false && candMeta?.based_on_contract_sha256 === registered.get("reuse1")!.sha && typeof candMeta?.based_on_registered_seq === "number" && typeof candMeta?.generated_by === "string",
    "5-9 候选 meta 明确未验证草稿 + 身份 + 依据的契约版本", candMeta);

  // 5.D 非机械项（task_states）无可复用旧工件 ⇒ 不代造、整份候选不可用
  const statesPlan = inPlan(r3, "states1");
  ok(statesPlan?.candidate_evidence === null && typeof statesPlan?.candidate_unavailable_reason === "string" && statesPlan.candidate_unavailable_reason.includes("st"),
    "5-10 非机械项（task_states）不可机械生成且无旧工件 ⇒ 候选不可用（不代造 passed）", { reason: statesPlan?.candidate_unavailable_reason });
  ok(itemOf(statesPlan, "st")?.next_evidence_action?.role === "executor" && Array.isArray(itemOf(statesPlan, "st")?.next_evidence_action?.target_paths) && itemOf(statesPlan, "st").next_evidence_action.target_paths.length === 0,
    "5-11 非机械项的补证动作如实给（无文件目标时 target_paths 为空、仍给核对内容）", itemOf(statesPlan, "st")?.next_evidence_action);
  ok(inPlan(r3, "sec1")?.blocks_entry === true && inPlan(r3, "reuse1")?.blocks_entry === true, "5-12 候选/修复计划不改 blocks_entry");

  // ═══ 6. 复制候选走**真实 scan 链路**：草稿被拒、采纳后按当时目标核、源/目标再变即不通过 ═══
  info("── 6. 复制候选 → 真实 scan（无独立重复 helper）");
  const candCopy = inPlan(syncMod.readSyncStatus(PID, dataDir) as AnyReport, "copy1")?.candidate_evidence;
  ok(candCopy !== null && candCopy !== undefined, "6-1 copy1 无漂移时给候选（夹具前置）");
  // 6.A 草稿原样（completed:false）放进收件目录 → 真实 scan 判**不通过**（半成品不算通过）
  postEvidence("copy1", candCopy.package);
  await scan();
  const draftVerdict = batchOf(syncMod.readSyncStatus(PID, dataDir) as AnyReport, "copy1")?.verdict;
  ok(draftVerdict !== "passed", "6-2 草稿（completed:false）走真实 scan 不通过（半成品不算通过）", { verdict: draftVerdict });
  // 6.B 协调者显式核实后置 completed=true → 目标未变 → 真实 scan 通过（**无 meta 也不影响**：依据由 scan 重核）
  postEvidence("copy1", { ...candCopy.package, completed: true });
  await scan();
  ok(batchOf(syncMod.readSyncStatus(PID, dataDir) as AnyReport, "copy1")?.verdict === "passed", "6-3 采纳（completed=true）后目标未变 → 真实 scan 通过（身份 meta 丢失不影响：依据按当时目标重核）");
  // 6.C 复制后再改**来源** → 真实 scan 不通过（stale）
  const copySrcBefore = readText(COPY_SRC_ABS);
  write(COPY_SRC_ABS, "复制候选夹具来源（采纳后又被改）。\n");
  await scan();
  const afterSrc = batchOf(syncMod.readSyncStatus(PID, dataDir) as AnyReport, "copy1");
  ok(afterSrc?.verdict !== "passed" && afterSrc?.verdict === "stale", "6-4 复制候选走真实 scan 后**来源**再变 → 不通过（stale）", { verdict: afterSrc?.verdict });
  write(COPY_SRC_ABS, copySrcBefore);
  await scan();
  ok(batchOf(syncMod.readSyncStatus(PID, dataDir) as AnyReport, "copy1")?.verdict === "passed", "6-5 来源复原后真实 scan 再次通过");
  // 6.D 复制后再改**目标** → 真实 scan 不通过（artifact 哈希不符）
  const copyResultBefore = readText(COPY_RESULT_ABS);
  write(COPY_RESULT_ABS, "复制候选夹具结果（采纳后又被改）。\n");
  await scan();
  const afterTarget = batchOf(syncMod.readSyncStatus(PID, dataDir) as AnyReport, "copy1");
  ok(afterTarget?.verdict !== "passed" && afterTarget?.verdict === "invalid", "6-6 复制候选走真实 scan 后**目标**再变 → 不通过（invalid）", { verdict: afterTarget?.verdict });
  write(COPY_RESULT_ABS, copyResultBefore);
  await scan();
  ok(batchOf(syncMod.readSyncStatus(PID, dataDir) as AnyReport, "copy1")?.verdict === "passed", "6-7 目标复原后真实 scan 再次通过");
  // 6.E 确认删除了"未接线重复 helper"（不导出、不行使）
  ok(!("verifyCandidateInputVersion" in (syncMod as unknown as Record<string, unknown>)), "6-8 未接线的重复 helper（verifyCandidateInputVersion）已移除（复用真实 scan 链路）");

  // ═══ 7. 零写入（按字节判）═══
  info("── 7. 只读就是零写入（字节级）");
  const beforeWork = treeHash(workDir);
  const beforeData = treeHash(dataDir);
  const beforeInboxCount = fs.readdirSync(inbox).length;
  syncMod.readSyncStatus(PID, dataDir);
  entryMod.evaluateProjectEntry({ project_id: PID, role: "coordinator" }, { dataDir });
  ok(treeHash(workDir) === beforeWork, "7-1 调用前后 .工作台/work 字节不变（事件账本/证据库无新增）");
  ok(treeHash(dataDir) === beforeData, "7-2 调用前后隔离 dataDir 字节不变");
  ok(fs.readdirSync(inbox).length === beforeInboxCount, "7-3 收件目录无新增文件（候选零落盘）");

  // ═══ 8. 候选不被自动发现/不自动采纳 ═══
  info("── 8. 候选不进自动发现链路（不自动采纳）");
  const candFile = path.join(inbox, "reuse1.candidate.json");
  write(candFile, `${JSON.stringify(candCopy?.package ?? {}, null, 2)}\n`);
  const beforeScan = entityEvents("sync:reuse1");
  await scan();
  const afterScan = entityEvents("sync:reuse1");
  ok(afterScan === beforeScan, "8-1 收件目录里的 *.candidate.json 不被发现（文件名只认 <batch>.evidence.json）", { beforeScan, afterScan });
  ok(!(syncMod.readSyncStatus(PID, dataDir).unregistered_evidence ?? []).some((u: any) => String(u.path).includes("candidate")), "8-2 候选文件不出现在 unregistered_evidence（根本不被枚举）");
  fs.rmSync(candFile, { force: true });

  // ═══ 9. graph_full 等待派生：如实标注，但绝不改变 v1 阻断；有其它失败时不冒充唯一原因 ═══
  info("── 9. graph_full 等待派生 vs v1 阻断 vs 非唯一原因");
  const g = inPlan(syncMod.readSyncStatus(PID, dataDir) as AnyReport, "graph1");
  const gItem = itemOf(g, "g");
  ok(gItem?.verdict !== "passed", "9-1 graph_full 未通过时该必需项非 passed", { verdict: gItem?.verdict });
  ok(gItem?.waiting_for_derivation?.state === "updating" && gItem?.waiting_for_derivation?.retryable === true && typeof gItem?.waiting_for_derivation?.reason === "string",
    "9-2 命中图正在更新 → 给 waiting_for_derivation + 可重试原因", gItem?.waiting_for_derivation);
  ok(gItem?.waiting_for_derivation?.sole_cause === true && (gItem?.waiting_for_derivation?.other_failures ?? []).length === 0,
    "9-3 只有 updating 一种原因时如实标 sole_cause=true", gItem?.waiting_for_derivation);
  ok(gItem?.waiting_for_derivation?.eta?.total_ms === null, "9-4 依据不足不编 ETA（total_ms=null）", gItem?.waiting_for_derivation?.eta);
  ok(g?.blocks_entry === true, "9-5 修复计划不改 blocks_entry");
  const block = syncMod.computeSyncBlock(PID, dataDir);
  ok(block.blocked === true && block.batches.some((b: any) => b.batch_id === "graph1"), "9-6 v1 阻断语义不变：graph_full 未满足仍阻断接续/认领", { blocked: block.blocked, batches: block.batches.map((b: any) => b.batch_id) });
  // 9.E 图探针额外带回一条原因 ⇒ updateSole=false ⇒ **不**宣称 updating 是唯一直接原因
  probeExtraReason = "图可用性 draft（未发布/只有草稿）";
  const gExtra = itemOf(inPlan(syncMod.readSyncStatus(PID, dataDir) as AnyReport, "graph1"), "g");
  probeExtraReason = null;
  ok(gExtra?.waiting_for_derivation?.sole_cause === false && (gExtra?.waiting_for_derivation?.other_failures ?? []).length >= 1,
    "9-7 同时有其它失败原因时不冒充 updating 是唯一直接原因（sole_cause=false + other_failures 非空）", gExtra?.waiting_for_derivation);
  ok(typeof gExtra?.waiting_for_derivation?.reason === "string" && gExtra.waiting_for_derivation.reason.includes("不只"), "9-8 非唯一原因时文案明确不把它当唯一原因", gExtra?.waiting_for_derivation?.reason);

  // ═══ 10. A3-不漂移：同输入重读一致；无关源变化不误报；相关变化准确失效 ═══
  info("── 10. A3-不漂移 / 准确失效");
  const d1 = (syncMod.readSyncStatus(PID, dataDir) as AnyReport).repair_plan;
  const d2 = (syncMod.readSyncStatus(PID, dataDir) as AnyReport).repair_plan;
  ok(d1 !== undefined && d1.batches.length > 0 && JSON.stringify(d1) === JSON.stringify(d2), "10-1 同输入重复只读 → 修复计划逐字节一致（无墙钟、不漂移）");
  const modulesAbs = path.join(archDir, "modules.json");
  const modulesBytes = fs.readFileSync(modulesAbs);
  write(modulesAbs, modulesBytes); // 同语义"重生成"：内容相同、只改时间戳
  const d3 = (syncMod.readSyncStatus(PID, dataDir) as AnyReport).repair_plan;
  ok(d1 !== undefined && JSON.stringify(d3) === JSON.stringify(d1), "10-2 同语义重生成（内容不变、仅时间戳变）→ 修复计划不漂移");
  const resultBefore = readText(RESULT_ABS);
  write(RESULT_ABS, "夹具结果文件（登记后被改）。\n");
  const r10 = syncMod.readSyncStatus(PID, dataDir) as AnyReport;
  const p10 = inPlan(r10, "pass1");
  ok(itemOf(p10, "result")?.verdict !== "passed" && (itemOf(p10, "result")?.expired_artifacts ?? []).length >= 1, "10-3 相关目标变化 → 准确失效（非 passed + expired_artifacts 列出）", { verdict: itemOf(p10, "result")?.verdict, expired: itemOf(p10, "result")?.expired_artifacts });
  ok(p10 !== undefined && (itemOf(p10, "result")?.reusable_artifacts ?? []).length === 0, "10-4 失效的引用不再列入 reusable_artifacts（可复用与已失效分开）");
  write(RESULT_ABS, resultBefore);
  const p10b = inPlan(syncMod.readSyncStatus(PID, dataDir) as AnyReport, "pass1");
  ok(itemOf(p10b, "result")?.verdict === "passed" && (itemOf(p10b, "result")?.reusable_artifacts ?? []).length >= 1, "10-5 复原后重新通过且引用回到可复用");

  // ═══ 11. 不降级：整文件绑定/required 不被顺手改档 ═══
  info("── 11. 不降级（current / 整文件绑定不变）");
  const r11 = syncMod.readSyncStatus(PID, dataDir) as AnyReport;
  const p11 = inPlan(r11, "pass1");
  ok(batchOf(r11, "pass1")?.contract_sha256 === registered.get("pass1")!.sha, "11-1 只读修复计划不改契约哈希（不降级/不改档）");
  const ri11 = itemOf(p11, "result");
  ok(p11 !== undefined && ri11?.expected?.path === RESULT_REL && ri11?.expected?.sha256 === sha256(readText(RESULT_ABS)) && !("section" in (ri11?.expected ?? {})) && ri11?.required === true,
    "11-2 整文件绑定与 required 原样保留（未被降成章节绑定/非必需）", { expected: ri11?.expected, required: ri11?.required });
  const baseIds = (baseItems() as { id: string; required: boolean }[]).map((c) => c.id).sort();
  ok(p11 !== undefined && JSON.stringify((p11.items ?? []).map((i: any) => i.item_id).sort()) === JSON.stringify(baseIds) &&
    (baseItems() as { id: string; required: boolean }[]).every((c) => itemOf(p11, c.id)?.required === c.required),
    "11-3 修复计划逐项覆盖契约 item 且 required 与契约一致（同一份判据，不另算）", { ids: (p11?.items ?? []).map((i: any) => i.item_id) });

  // ═══ 12. 旧批次免重扫（不改历史口径）═══
  info("── 12. 历史批次免重扫");
  const beforeOld = entityEvents("sync:old1");
  await scan();
  ok(entityEvents("sync:old1") === beforeOld, "12-1 扫描不给被取代的历史批次新增事件（历史免重扫）", { beforeOld, after: entityEvents("sync:old1") });
  const oldRow = batchOf(syncMod.readSyncStatus(PID, dataDir) as AnyReport, "old1");
  ok(oldRow?.active === false && oldRow?.historical === true, "12-2 读口仍如实保留历史批次行（historical=true）", { active: oldRow?.active, historical: oldRow?.historical });

  // ═══ 13. 接续入口（entry / task_brief）同步段：带修复计划且**一次**全量评估 ═══
  info("── 13. entry / task_brief 同步段（复用同次评估，不翻倍）");
  const beforeCalls = probeCalls;
  let entry: any = null;
  let entryErr: string | null = null;
  try {
    entry = entryMod.evaluateProjectEntry({ project_id: PID, role: "coordinator" }, { dataDir });
  } catch (e) {
    entryErr = e instanceof Error ? e.message : String(e);
  }
  const callsAfterEntry = probeCalls - beforeCalls;
  ok(entryErr === null, "13-1 evaluateProjectEntry 在夹具内可求值（只读）", { error: entryErr });
  ok(callsAfterEntry === 1, "13-2 entry 同步段**只做一次**全量评估（图探针恰好调用 1 次；若另调 readSyncStatus 会变 2）", { callsAfterEntry });
  ok(entry?.sync_summary?.repair_plan !== undefined && entry.sync_summary.repair_plan !== null, "13-3 project_entry 的 sync_summary 只读附加 repair_plan", { has: entry?.sync_summary?.repair_plan !== undefined });
  const directPlan = (syncMod.readSyncStatus(PID, dataDir) as AnyReport).repair_plan;
  ok(JSON.stringify(entry?.sync_summary?.repair_plan) === JSON.stringify(directPlan), "13-4 entry 的 repair_plan 与 read_sync_status 同一份（同判据，不另算）");
  const brief = briefMod.buildTaskBrief(entry as never, { project_id: PID, role: "coordinator" }) as unknown as { sync: any };
  ok(brief?.sync?.repair_plan !== undefined && brief.sync.repair_plan !== null, "13-5 task_brief 的同步段**透传** repair_plan", { has: brief?.sync?.repair_plan !== undefined });
  // P3 集成修正（2026-10-06）：`buildTaskBrief`（detail=full）保留**完整** repair_plan；`summarizeTaskBrief`（默认
  // detail=summary）只把新增的 repair_plan 转**紧凑导航**（nav/计数/refetch），其余同步字段逐字一致。
  const summary = briefMod.summarizeTaskBrief(brief as never, { refetchArgs: { project_id: PID, role: "coordinator" } }) as unknown as { sync: any };
  const fullPlan = brief?.sync?.repair_plan;
  const navPlan = summary?.sync?.repair_plan;
  ok(
    fullPlan?.batches?.[0]?.items?.[0]?.item_id !== undefined && fullPlan.batches[0].items.length > 0,
    "13-6 detail=full 的 repair_plan 保留完整逐项（item_id/expected/actual）",
    { items: fullPlan?.batches?.[0]?.items?.length },
  );
  ok(
    navPlan?.nav === true && navPlan?.read_only === true && navPlan?.refetch?.tool === "read_sync_status" && navPlan.refetch.args?.project_id === PID && !JSON.stringify(navPlan).includes('"items"'),
    "13-7 summary 的 repair_plan 是紧凑导航（nav/read_only/结构化 refetch 到 read_sync_status(project_id)，不内联 items）",
    navPlan,
  );
  ok(
    JSON.stringify({ ...brief?.sync, repair_plan: undefined }) === JSON.stringify({ ...summary?.sync, repair_plan: undefined }),
    "13-8 summary 同步段除 repair_plan 外逐字一致（门禁/状态字段未裁剪）",
  );

  info(`\n[verify] 结果：PASS ${passCount} · FAIL ${failCount}`);
  if (failCount === 0) info("[verify] 全部通过：sync repair-plan / candidate-boundary 专项回归（返工版）");
}

void main().catch((e) => {
  console.error(`[verify] 夹具/脚本异常：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exitCode = 1;
});
