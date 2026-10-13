// 图纸源根接缝修复验证（本轮共同根因：documents.ts 的当前开发源解析）。
//
// 用法：npx tsx scripts/verify-workspace-documents.ts
//
// 自带隔离夹具：临时 TATAI_HOME + 临时 anchor/dev 目录（os.tmpdir() 下），**不碰**真实项目、
// 真实注册表、真实账本、安装实例与 8787。断言全部经**真实公共函数**调用（不 grep 源码字符串自证）。
//
// 覆盖（对着根审查的两项确凿缺陷与反例）：
//   A/B/C 自管理（tatai）／自管理另一 id／普通项目：有指针、无指针、未注入解析器、登记相对路径四种口径；
//         source_root/abs_path 跟真实开发根，project_root（中央锚点）恒为注册表根，anchor 源字节不动。
//   D     坏指针（root=null）与解析抛错**明确拒 source**：resolveDocumentSource / loadDocument / readDesign
//         抛错且不回落旧主根（不静默读旧版）；自管理同样 fail-closed。
//   E     坏源不连坐中央：projectWorkbenchDir / baselinesPath / 基线流水 / 不可变快照 / Git 恢复位一律
//         从注册表锚点派生，坏指针下历史固定候选仍读得回；中央证据仍能写。自管理同判。
//   F     冻结候选源码目录：文档写（appendDesign/appendDiscuss，含自管理）被拒且零增长；
//         合法中央证据/不可变副本仍能写，且不落到冻结目录里。
//   G     根原探针（document-source-probe.ts）两条断言等价复现。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addProject, setProjectDocumentPaths, getProject } from "../src/server/registry";
import {
  activateBaseline,
  activeBaseline,
  baselinesPath,
  loadDocument,
  preserveDocumentRevision,
  projectAnchorRoot,
  projectWorkbenchDir,
  readBaselineLog,
  readRevisionSnapshotText,
  recoverRevision,
  resolveDocumentSource,
  revisionSnapshotExists,
  setCurrentDevRootResolver,
  sha256Hex,
  type DocumentSource,
} from "../src/server/work/documents";
import { appendDesign, appendDiscuss, projectWorkDir, readDesign } from "../src/server/workstation";
import { putEvidence } from "../src/server/work/evidence";
import { WorkService } from "../src/server/work/service";
import { freezeWorkspace, readWorkspaces, registerWorkspace, selectDevWorkspace } from "../src/server/work/workspaces";
import { installWorkspaceHostWiring, resetWorkspaceHostWiring } from "../src/server/work/hostWiring";
import type { WorkspaceDevResolution } from "../src/shared/workspaceTypes";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: unknown): void => {
  console.log(`[verify] ${cond ? "PASS" : "FAIL"} ${label}`);
  if (cond) pass++;
  else {
    fail++;
    process.exitCode = 1;
    if (detail !== undefined) console.log(`[verify]   现场：${JSON.stringify(detail).slice(0, 1200)}`);
  }
};
const section = (t: string): void => console.log(`\n[verify] ═══ ${t}`);
const sha = (s: string | Buffer): string => sha256Hex(s);
const bytesHash = (f: string): string | null => (fs.existsSync(f) ? sha(fs.readFileSync(f)) : null);
function thrown(fn: () => unknown): unknown | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}
const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};
/** 目录树逐文件内容哈希（判断"某个目录零增长/零改写"） */
function treeHash(root: string): string {
  if (!fs.existsSync(root)) return "<absent>";
  const parts: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, ent.name);
      const r = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.isFile()) parts.push(`${r}\u0000${sha(fs.readFileSync(abs))}`);
    }
  };
  walk(root, "");
  return sha(parts.join("\n"));
}

const DESIGN_PLAN = [
  "# 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| D-1 | todo | 图纸源根卡 |  | D-1 验收记录 |",
  "",
  "### D-1 图纸源根卡",
  "",
  "**设计依据**：§2。",
  "",
  "- [ ] 做出来",
  "",
].join("\n");

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-wsd-"));
const data = path.join(tmpBase, "home");
const anchors = new Map<string, string>();
const devs = new Map<string, string>();
/** 夹具建立时锚点源文件的逐字节哈希（收尾对照"主源字节未被改动"） */
const anchorBytes = new Map<string, string>();
const recordAnchorBytes = (id: string, a: string, doc: string): void => {
  for (const rel of [doc, "PLAN.md"]) {
    const f = path.join(a, ...rel.split("/"));
    if (fs.existsSync(f)) anchorBytes.set(`${id}\u0000${rel}`, sha(fs.readFileSync(f)));
  }
};
for (const p of [data]) fs.mkdirSync(p, { recursive: true });

const anchorDir = (id: string, doc: string, plan = DESIGN_PLAN, selfManaged = false): string => {
  const a = path.join(tmpBase, `anchor-${id}`);
  anchors.set(id, a);
  write(path.join(a, doc), `# ANCHOR ${id} 设计书\n\nanchor 版正文\n`);
  write(path.join(a, "PLAN.md"), plan);
  addProject({ id, name: `fixture ${id}`, path: a, kind: "backend", ...(selfManaged ? { self_managed: true } : {}) }, data);
  recordAnchorBytes(id, a, doc);
  return a;
};
const devDir = (id: string, relDesign: string, designText: string, plan = DESIGN_PLAN, relPlan = ".工作台/plan.md"): string => {
  const d = path.join(tmpBase, `dev-${id}`);
  devs.set(id, d);
  write(path.join(d, ...relDesign.split("/")), designText);
  write(path.join(d, ...relPlan.split("/")), plan);
  return d;
};

// ── 解析器注入口径 ──
const mainOf = (pid: string): WorkspaceDevResolution => ({ workspace_id: `${pid}:main`, root: anchors.get(pid)!, source: "main" });
const ptrOf = (pid: string): WorkspaceDevResolution => ({ workspace_id: `${pid}:dev`, root: devs.get(pid)!, source: "pointer" });
const blockedOf = (pid: string): WorkspaceDevResolution => ({
  workspace_id: `${pid}:missing`,
  root: null,
  source: "blocked",
  blocked_reason: "夹具：显式指针指向不存在的工作区",
});

/** 断言一个 source 的关键字段 */
function srcShape(label: string, s: DocumentSource, exp: { rel: string; abs: string; root: string; sourceRoot: string; origin: string }): void {
  ok(
    s.rel_path === exp.rel && path.resolve(s.abs_path) === path.resolve(exp.abs) && path.resolve(s.project_root) === path.resolve(exp.root) &&
      path.resolve(s.source_root) === path.resolve(exp.sourceRoot) && s.origin === exp.origin,
    label,
    { rel: s.rel_path, abs: s.abs_path, project_root: s.project_root, source_root: s.source_root, origin: s.origin, exp },
  );
}

try {
  // ═══════════════════════ A：自管理 tatai ═══════════════════════
  section("A 自管理 tatai：固定文件名 + 当前真实开发根；project_root 恒为锚点");
  const A_SPLIT_NOTE = "anchor 版正文";
  const T_ANCHOR = anchorDir("tatai", "DESIGN.md", DESIGN_PLAN, true);
  const T_DEV = devDir("tatai", "DESIGN.md", "# DEV tatai 设计书\n\ndev 版正文\n", DESIGN_PLAN, "PLAN.md");
  // 登记字段对塔台不生效（"固定就是不接受覆盖"）——显式登记一份别的相对路径
  setProjectDocumentPaths("tatai", { design_path: ".工作台/design.md", plan_path: ".工作台/plan.md" }, data);
  ok(getProject("tatai", data)?.design_path === ".工作台/design.md", "A 夹具：tatai 注册表里确实登记了 design_path（用于证明被忽略）");
  {
    setCurrentDevRootResolver(ptrOf);
    const d = resolveDocumentSource("tatai", "design", data);
    srcShape("A 有指针：design 走 dev、rel 仍是 DESIGN.md、origin=tatai_root", d, {
      rel: "DESIGN.md",
      abs: path.join(T_DEV, "DESIGN.md"),
      root: T_ANCHOR,
      sourceRoot: T_DEV,
      origin: "tatai_root",
    });
    ok(d.rel_path === "DESIGN.md", "A 登记的 design_path 被忽略（塔台图纸文件名固定）", { rel: d.rel_path });
    const p = resolveDocumentSource("tatai", "plan", data);
    srcShape("A 有指针：plan 走 dev/PLAN.md", p, {
      rel: "PLAN.md",
      abs: path.join(T_DEV, "PLAN.md"),
      root: T_ANCHOR,
      sourceRoot: T_DEV,
      origin: "tatai_root",
    });
    const loaded = loadDocument("tatai", "design", data);
    ok(loaded !== null && loaded.text.includes("DEV tatai"), "A 有指针：loadDocument 读到 dev 正文（不是旧主根）", loaded?.source.abs_path);
    ok(loaded !== null && !loaded.text.includes(A_SPLIT_NOTE), "A 有指针：读到的不是 anchor 旧正文");

    setCurrentDevRootResolver(mainOf);
    const d2 = resolveDocumentSource("tatai", "design", data);
    srcShape("A 无指针（injected main）：回锚点根", d2, {
      rel: "DESIGN.md",
      abs: path.join(T_ANCHOR, "DESIGN.md"),
      root: T_ANCHOR,
      sourceRoot: T_ANCHOR,
      origin: "tatai_root",
    });
    ok(loadDocument("tatai", "design", data)?.text.includes("ANCHOR tatai") === true, "A 无指针：读到锚点正文");

    setCurrentDevRootResolver(null);
    const d3 = resolveDocumentSource("tatai", "design", data);
    srcShape("A 未注入解析器（旧行为兼容）：回锚点根", d3, {
      rel: "DESIGN.md",
      abs: path.join(T_ANCHOR, "DESIGN.md"),
      root: T_ANCHOR,
      sourceRoot: T_ANCHOR,
      origin: "tatai_root",
    });
  }

  // ═══════════════════════ B：自管理另一 id ═══════════════════════
  section("B 自管理另一 id：同一口径（不是 id=='tatai' 的特例）");
  const S2_ANCHOR = anchorDir("self-two", "DESIGN.md", DESIGN_PLAN, true);
  const S2_DEV = devDir("self-two", "DESIGN.md", "# DEV self-two 设计书\n\ndev 版正文\n", DESIGN_PLAN, "PLAN.md");
  setProjectDocumentPaths("self-two", { design_path: ".工作台/design.md" }, data);
  {
    setCurrentDevRootResolver(ptrOf);
    const d = resolveDocumentSource("self-two", "design", data);
    srcShape("B 有指针：走 dev、rel 固定、origin=tatai_root", d, {
      rel: "DESIGN.md",
      abs: path.join(S2_DEV, "DESIGN.md"),
      root: S2_ANCHOR,
      sourceRoot: S2_DEV,
      origin: "tatai_root",
    });
    setCurrentDevRootResolver(mainOf);
    srcShape("B 无指针：回锚点根", resolveDocumentSource("self-two", "design", data), {
      rel: "DESIGN.md",
      abs: path.join(S2_ANCHOR, "DESIGN.md"),
      root: S2_ANCHOR,
      sourceRoot: S2_ANCHOR,
      origin: "tatai_root",
    });
  }

  // ═══════════════════════ C：普通项目 ═══════════════════════
  section("C 普通项目：缺省 .工作台/design.md 跟开发根；登记相对路径同样跟开发根；project_root 恒锚点");
  const P_ANCHOR = anchorDir("plain", ".工作台/design.md");
  const P_DEV = devDir("plain", ".工作台/design.md", "# DEV plain 设计书\n\ndev 版正文\n");
  const PR_ANCHOR = anchorDir("plain-reg", ".工作台/design.md");
  const PR_DEV = devDir("plain-reg", "docs/DESIGN.md", "# DEV plain-reg 设计书\n\ndev docs 版正文\n");
  setProjectDocumentPaths("plain-reg", { design_path: "docs/DESIGN.md" }, data);
  {
    setCurrentDevRootResolver(ptrOf);
    srcShape("C 缺省口径 + 有指针：dev/.工作台/design.md", resolveDocumentSource("plain", "design", data), {
      rel: ".工作台/design.md",
      abs: path.join(P_DEV, ".工作台", "design.md"),
      root: P_ANCHOR,
      sourceRoot: P_DEV,
      origin: "default",
    });
    setCurrentDevRootResolver(mainOf);
    srcShape("C 缺省口径 + 无指针：anchor/.工作台/design.md", resolveDocumentSource("plain", "design", data), {
      rel: ".工作台/design.md",
      abs: path.join(P_ANCHOR, ".工作台", "design.md"),
      root: P_ANCHOR,
      sourceRoot: P_ANCHOR,
      origin: "default",
    });
    setCurrentDevRootResolver(null);
    srcShape("C 未注入解析器：anchor 口径（旧行为逐字段兼容）", resolveDocumentSource("plain", "design", data), {
      rel: ".工作台/design.md",
      abs: path.join(P_ANCHOR, ".工作台", "design.md"),
      root: P_ANCHOR,
      sourceRoot: P_ANCHOR,
      origin: "default",
    });

    setCurrentDevRootResolver(ptrOf);
    srcShape("C 登记相对路径 + 有指针：在 dev 根内解析", resolveDocumentSource("plain-reg", "design", data), {
      rel: "docs/DESIGN.md",
      abs: path.join(PR_DEV, "docs", "DESIGN.md"),
      root: PR_ANCHOR,
      sourceRoot: PR_DEV,
      origin: "registered",
    });
    setCurrentDevRootResolver(null);
    ok(
      loadDocument("plain-reg", "design", data) === null,
      "C 登记路径 + 未注入解析器：按锚点根解析（PR anchor 无 docs/DESIGN.md → 正常空态，不猜）",
    );
  }

  // ═══════════════════════ D：坏指针 / 解析抛错 → 明确拒 source ═══════════════════════
  section("D 坏指针与解析抛错：明确拒绝读图纸源，不静默回落旧主根（自管理同判）");
  {
    setCurrentDevRootResolver(blockedOf);
    for (const pid of ["plain", "plain-reg", "tatai", "self-two"]) {
      const e = thrown(() => resolveDocumentSource(pid, "design", data));
      ok(e !== null, `D ${pid}：坏指针时 resolveDocumentSource 抛错（不回落）`, e === null ? "未抛错（=读到了别的源）" : undefined);
      ok(e !== null && msgOf(e).includes("不静默回退"), `D ${pid}：错误说明拒绝回退（可复审）`, e === null ? undefined : msgOf(e).slice(0, 160));
      const e2 = thrown(() => loadDocument(pid, "design", data));
      ok(e2 !== null, `D ${pid}：loadDocument 抛错（不是 null 空态、也不是读到 anchor）`);
      const e3 = thrown(() => readDesign(pid, data));
      ok(e3 !== null, `D ${pid}：read_design（readDesign）抛错`);
    }
    // 解析器自身抛错：同样必须如实失败
    setCurrentDevRootResolver(() => {
      throw new Error("夹具解析器炸了");
    });
    const eThrow = thrown(() => resolveDocumentSource("plain", "design", data));
    ok(eThrow !== null && msgOf(eThrow).includes("当前开发源解析失败"), "D 解析器抛错 → 如实失败（不回退）", eThrow === null ? undefined : msgOf(eThrow).slice(0, 160));
    ok(thrown(() => loadDocument("plain", "design", data)) !== null, "D 解析器抛错 → loadDocument 抛错");

    // 反例：main 口径（root=anchor）不是"坏指针"，必须照常可读
    setCurrentDevRootResolver(mainOf);
    ok(loadDocument("plain", "design", data) !== null, "D 反例：main 口径（显式）仍可读，不被当成坏指针");
    setCurrentDevRootResolver(blockedOf);
    const eMissing = thrown(() => resolveDocumentSource("no-such-project", "design", data));
    ok(eMissing !== null && msgOf(eMissing).includes("项目不存在"), "D 不存在的项目仍按 INVALID_COMMAND 拒（口径未变）");
  }

  // ═══════════════════════ E：坏源不连坐中央 ═══════════════════════
  section("E 坏指针不连坐中央：基线/不可变快照/Git 恢复位/工作台目录一律锚点派生");
  const C_ANCHOR = anchorDir("central", ".工作台/design.md");
  const C_DEV = devDir("central", ".工作台/design.md", "# DEV central 设计书\n\ndev 版正文\n");
  {
    setCurrentDevRootResolver(ptrOf);
    const act = activateBaseline("central", { approved_by: "user", approval_basis: "隔离夹具审定（不代表真实用户 Gate）", approval_kind: "user_confirmed" }, data);
    ok(act.created === true, "E 夹具：在 dev 源上激活基线（基线落中央锚点）", act.baseline.baseline_id);
    ok(
      fs.existsSync(path.join(C_ANCHOR, ".工作台", "baselines.jsonl")) && !fs.existsSync(path.join(C_DEV, ".工作台", "baselines.jsonl")),
      "E 基线流水在锚点 .工作台（dev 下没有第二套）",
    );
    const devDesignText = fs.readFileSync(path.join(C_DEV, ".工作台", "design.md"), "utf8");
    const devDesignSha = sha(devDesignText);
    ok(act.baseline.design_revision.content_sha256 === devDesignSha, "E 基线记的是 dev 源内容哈希");
    const rec = act.baseline.design_revision.recovery;
    ok(rec.kind === "immutable_copy" && rec.ref.startsWith(".工作台/design-revisions/"), "E 不可变副本落在中央锚点相对位置", rec);

    setCurrentDevRootResolver(blockedOf);
    ok(thrown(() => resolveDocumentSource("central", "design", data)) !== null, "E 坏指针：图纸源读口仍明确拒（不回落）");
    ok(path.resolve(projectAnchorRoot("central", data)) === path.resolve(C_ANCHOR), "E 坏指针：projectAnchorRoot 恒为注册表锚点根");
    ok(path.resolve(projectWorkbenchDir("central", data)) === path.resolve(C_ANCHOR, ".工作台"), "E 坏指针：projectWorkbenchDir 从锚点派生（不抛错、不看指针）");
    ok(path.resolve(baselinesPath("central", data)) === path.resolve(C_ANCHOR, ".工作台", "baselines.jsonl"), "E 坏指针：baselinesPath 锚点派生");
    const log = readBaselineLog("central", data);
    ok(log.baselines.length === 1 && log.corrupt.length === 0, "E 坏指针：基线流水仍读得回（历史固定候选不连坐）", { n: log.baselines.length, corrupt: log.corrupt.length });
    ok(activeBaseline("central", data)?.baseline_id === act.baseline.baseline_id, "E 坏指针：activeBaseline 仍可用");
    ok(revisionSnapshotExists("central", "design", devDesignSha, data) === true, "E 坏指针：不可变快照存在性仍可判");
    ok(readRevisionSnapshotText("central", "design", devDesignSha, data) === devDesignText, "E 坏指针：不可变图纸原文仍逐字节读回");
    const recovered = recoverRevision(C_ANCHOR, rec);
    ok(recovered.text === devDesignText && sha(recovered.bytes) === rec.sha256, "E 坏指针：按恢复位置取回原文并核哈希");
    ok(thrown(() => loadDocument("central", "design", data)) !== null, "E 坏指针：现行源读取 fail-closed（中央可读 ≠ 现行源可读）");

    // 中央证据仍能写（坏指针 + 中央写口）
    const cWork = projectWorkDir("central", data);
    const blob = putEvidence(cWork, {
      content: "中央证据：坏指针下仍可存证",
      kind: "other",
      summary: "夹具",
      created_by: "verify-workspace-documents",
      role: "executor",
      binding: { revision_kind: "code", revision: devDesignSha },
    });
    ok(fs.existsSync(path.join(cWork, "evidence", `${blob.sha256}.json`)), "E 坏指针：中央证据仍能写（落锚点 .工作台/work/evidence）", blob.recovery_path);
    ok(blob.recovery_path.startsWith(".工作台/work/evidence/"), "E 中央证据恢复位置是锚点相对路径", blob.recovery_path);
    ok(!fs.existsSync(path.join(C_DEV, ".工作台", "work")), "E 中央证据没有落进 dev 目录");

    // 自管理同判：坏指针下中央历史仍读得回，且旧主根 DESIGN.md 不被当现行源读
    setCurrentDevRootResolver(ptrOf); // 激活时当前开发源是 dev（塔台自身同样遵循）
    const tataiAct = activateBaseline("tatai", { approved_by: "user", approval_basis: "隔离夹具审定（不代表真实用户 Gate）", approval_kind: "user_confirmed" }, data);
    ok(tataiAct.baseline.design_revision.source_path === "DESIGN.md", "E 自管理：基线记的源路径仍是固定文件名 DESIGN.md", tataiAct.baseline.design_revision.source_path);
    const tataiLog = readBaselineLog("tatai", data);
    ok(tataiLog.baselines.length === 1, "E 自管理：基线落 tatai 锚点 .工作台");
    ok(
      tataiLog.baselines[0].design_revision.content_sha256 === sha(fs.readFileSync(path.join(T_DEV, "DESIGN.md"), "utf8")),
      "E 自管理：基线记的是 dev DESIGN.md 内容哈希（不是旧主根）",
    );
    setCurrentDevRootResolver(blockedOf);
    ok(readBaselineLog("tatai", data).baselines.length === 1, "E 自管理：坏指针下中央基线仍读得回");
    ok(revisionSnapshotExists("tatai", "design", tataiLog.baselines[0].design_revision.content_sha256, data) === true, "E 自管理：坏指针下不可变快照仍可判在");
    ok(thrown(() => readDesign("tatai", data)) !== null, "E 自管理：坏指针下 readDesign 明确拒（不读旧主根 DESIGN.md）");
  }

  // ═══════════════════════ F：冻结候选写拒 / 中央写仍行 ═══════════════════════
  section("F 冻结候选：文档写被拒且零增长；合法中央证据与不可变副本仍能写");
  {
    const F_ANCHOR = anchorDir("frozen", ".工作台/design.md");
    const F_DEV = devDir("frozen", ".工作台/design.md", "# DEV frozen 设计书\n\ndev 版正文\n");
    installWorkspaceHostWiring(); // 真实宿主接线：注入 resolveCurrentDevRoot + assertHostedWriteAllowed
    const service = new WorkService({ dataDir: data });
    const submitter = { submit: (c: unknown) => service.submit(c as never), read: () => readWorkspaces(projectWorkDir("frozen", data)) };
    const regDev = registerWorkspace(submitter, {
      project_id: "frozen",
      workspace_id: "dev-f",
      change_id: "change-wsd",
      actor_id: "wsd-coordinator",
      role: "coordinator",
      kind: "dev",
      purpose: "夹具 dev-f",
      root: F_DEV,
      source_kind: "directory",
    });
    ok(regDev.ok === true, "F 登记 dev-f", regDev);
    const selDev = selectDevWorkspace(submitter, {
      project_id: "frozen",
      workspace_id: "dev-f",
      change_id: "change-wsd",
      actor_id: "wsd-coordinator",
      role: "coordinator",
      expected_revision: 0,
    });
    ok(selDev.ok === true, "F select_dev dev-f", selDev);
    const regCand = registerWorkspace(submitter, {
      project_id: "frozen",
      workspace_id: "cand-f",
      change_id: "change-wsd",
      actor_id: "wsd-coordinator",
      role: "coordinator",
      kind: "candidate",
      purpose: "冻结同目录夹具（与 dev-f 同根）",
      root: F_DEV,
      source_kind: "directory",
    });
    ok(regCand.ok === true, "F 登记 cand-f（同根）", regCand);
    const candRec = readWorkspaces(projectWorkDir("frozen", data)).workspaces["cand-f"];
    const fro = freezeWorkspace(submitter, {
      project_id: "frozen",
      workspace_id: "cand-f",
      change_id: "change-wsd",
      actor_id: "wsd-coordinator",
      role: "coordinator",
      expected_revision: candRec.revision,
      included_uncommitted: false,
      declared_paths: [],
    });
    ok(fro.ok === true, "F 冻结 cand-f", fro);

    ok(
      path.resolve(resolveDocumentSource("frozen", "design", data).source_root) === path.resolve(F_DEV),
      "F 冻结候选即当前开发源：图纸源根仍解析到该目录（读允许、写受守卫）",
    );
    const before = treeHash(F_DEV);
    const discuss0 = bytesHash(path.join(F_DEV, ".工作台", "design.discuss.md"));
    const eDiscuss = thrown(() => appendDiscuss("frozen", "应被拒的待议", data));
    ok(eDiscuss !== null && /CANDIDATE_FROZEN|冻结/.test(msgOf(eDiscuss)), "F 冻结源码：appendDiscuss 被真实守卫拒绝", eDiscuss === null ? undefined : msgOf(eDiscuss).slice(0, 160));
    ok(bytesHash(path.join(F_DEV, ".工作台", "design.discuss.md")) === discuss0, "F 冻结源码：待议文件零增长");
    const eDesign = thrown(() => appendDesign("frozen", "应被拒的落稿", data));
    ok(eDesign !== null && /CANDIDATE_FROZEN|冻结/.test(msgOf(eDesign)), "F 冻结源码：appendDesign 被拒", eDesign === null ? undefined : msgOf(eDesign).slice(0, 160));

    // 中央写（证据 + 不可变副本）仍行，且不落进冻结目录
    const fWork = projectWorkDir("frozen", data);
    const fBlob = putEvidence(fWork, {
      content: "中央证据：冻结候选下仍可登记",
      kind: "other",
      summary: "夹具",
      created_by: "verify-workspace-documents",
      role: "executor",
      binding: { revision_kind: "code", revision: "rev-frozen" },
    });
    ok(fs.existsSync(path.join(fWork, "evidence", `${fBlob.sha256}.json`)), "F 冻结候选：中央证据仍能写（§6.14 第 6 段）", fBlob.recovery_path);
    const preserved = preserveDocumentRevision("frozen", "design", data);
    ok(preserved.recovery.ref.startsWith(".工作台/design-revisions/"), "F 冻结候选：不可变历史仍写中央锚点", preserved.recovery);
    ok(fs.existsSync(path.join(F_ANCHOR, preserved.recovery.ref)), "F 不可变副本确实落在锚点目录");
    ok(treeHash(F_DEV) === before, "F 冻结目录树在被拒的两次写后逐字节不变（零增长）");

    // 自管理 + 冻结候选：写目标跟真实开发根，冻结守卫因此真正生效
    const tWork = projectWorkDir("tatai", data);
    const tService = new WorkService({ dataDir: data });
    const tSubmitter = { submit: (c: unknown) => tService.submit(c as never), read: () => readWorkspaces(tWork) };
    const tRegDev = registerWorkspace(tSubmitter, {
      project_id: "tatai",
      workspace_id: "tatai-dev",
      change_id: "change-wsd",
      actor_id: "wsd-coordinator",
      role: "coordinator",
      kind: "dev",
      purpose: "夹具 tatai dev",
      root: T_DEV,
      source_kind: "directory",
    });
    ok(tRegDev.ok === true, "F 登记 tatai dev", tRegDev);
    const tSel = selectDevWorkspace(tSubmitter, {
      project_id: "tatai",
      workspace_id: "tatai-dev",
      change_id: "change-wsd",
      actor_id: "wsd-coordinator",
      role: "coordinator",
      expected_revision: 0,
    });
    ok(tSel.ok === true, "F select_dev tatai-dev", tSel);
    const tRegCand = registerWorkspace(tSubmitter, {
      project_id: "tatai",
      workspace_id: "tatai-cand",
      change_id: "change-wsd",
      actor_id: "wsd-coordinator",
      role: "coordinator",
      kind: "candidate",
      purpose: "冻结同目录夹具",
      root: T_DEV,
      source_kind: "directory",
    });
    ok(tRegCand.ok === true, "F 登记 tatai-cand（同根）", tRegCand);
    const tCandRec = readWorkspaces(tWork).workspaces["tatai-cand"];
    const tFro = freezeWorkspace(tSubmitter, {
      project_id: "tatai",
      workspace_id: "tatai-cand",
      change_id: "change-wsd",
      actor_id: "wsd-coordinator",
      role: "coordinator",
      expected_revision: tCandRec.revision,
      included_uncommitted: false,
      declared_paths: [],
    });
    ok(tFro.ok === true, "F 冻结 tatai-cand", tFro);
    const tDevBefore = treeHash(T_DEV);
    const eTataiDesign = thrown(() => appendDesign("tatai", "应被拒的落稿", data));
    ok(
      eTataiDesign !== null && /CANDIDATE_FROZEN|冻结/.test(msgOf(eTataiDesign)),
      "F 自管理 + 冻结候选：落稿被拒（写目标跟真实开发根，守卫才真正生效）",
      eTataiDesign === null ? "未被拒：写目标仍钉在旧主根" : msgOf(eTataiDesign).slice(0, 160),
    );
    ok(treeHash(T_DEV) === tDevBefore, "F 自管理：dev 目录树未因被拒写改变", { before: tDevBefore, after: treeHash(T_DEV) });
  }

  // ═══════════════════════ G：根原探针等价断言 ═══════════════════════
  section("G 根原探针（document-source-probe.ts）两条断言等价复现");
  {
    const probeAnchor = anchorDir("probe-self", "DESIGN.md", DESIGN_PLAN, true);
    const probeDev = devDir("probe-self", "DESIGN.md", "# probe dev\n", DESIGN_PLAN, "PLAN.md");
    anchorDir("probe-normal", ".工作台/design.md");
    setCurrentDevRootResolver(() => ({ workspace_id: "dev", root: probeDev, source: "pointer" }));
    const result = resolveDocumentSource("probe-self", "design", data);
    ok(path.resolve(result.abs_path) === path.join(probeDev, "DESIGN.md"), "G 自管理 + 显式 dev 指针 → 读 dev DESIGN", result);
    ok(path.resolve(result.project_root) === path.resolve(probeAnchor) && path.resolve(result.source_root) === path.resolve(probeDev), "G project_root 仍锚点、source_root 是 dev");
    setCurrentDevRootResolver(() => ({ workspace_id: "bad", root: null, source: "blocked", blocked_reason: "fixture missing workspace" }));
    const err = thrown(() => resolveDocumentSource("probe-normal", "design", data));
    ok(err !== null, "G 坏显式指针 → 拒读（抛错）", err === null ? "未抛错" : undefined);
  }

  // ═══════════════════════ 收尾：中央锚点源字节不动 ═══════════════════════
  section("H 全程结束：所有锚点源文件逐字节未动");
  setCurrentDevRootResolver(null);
  let anchorChecked = 0;
  for (const [key, hash] of anchorBytes) {
    const [id, ...rest] = key.split("\u0000");
    const f = path.join(anchors.get(id)!, ...rest.join("\u0000").split("/"));
    const now = bytesHash(f);
    ok(now === hash, `H 锚点源逐字节未动：${id}/${rest.join("/")}`, { before: hash.slice(0, 12), after: (now ?? "<missing>").slice(0, 12) });
    anchorChecked++;
  }
  ok(anchorChecked >= 8, "H 锚点对照覆盖了自管理/普通项目等各夹具", { checked: anchorChecked });
  ok(
    !fs.existsSync(path.join(T_DEV, ".工作台", "baselines.jsonl")) && fs.existsSync(path.join(T_ANCHOR, ".工作台", "baselines.jsonl")),
    "H tatai 基线只在锚点（dev 下没有第二套）",
  );
  ok(
    !fs.existsSync(path.join(T_DEV, ".工作台", "design-revisions")) && fs.existsSync(path.join(T_ANCHOR, ".工作台", "design-revisions")),
    "H tatai 不可变修订库只在锚点（dev 下没有第二套）",
  );

  console.log(`\n[verify] ═══ 汇总：PASS=${pass} FAIL=${fail} ═══`);
} finally {
  resetWorkspaceHostWiring();
  setCurrentDevRootResolver(null);
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {
    /* 回收失败不影响判分 */
  }
}
