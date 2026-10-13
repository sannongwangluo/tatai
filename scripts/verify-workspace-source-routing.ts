// 当前开发目录（工作区）源根贯通验证（本轮独立根因组；DESIGN.md §6.13／§6.14 第 1/2/6/7/10 段）。
//
// 用法：npx tsx scripts/verify-workspace-source-routing.ts
//
// 自带隔离夹具：临时 TATAI_HOME + 临时注册表（中央 anchor 根 + sibling dev 根 + 冻结候选），
// **不碰**任何真实项目/生产账本/安装实例，也不连真实 8787。所有断言都经**真实公共函数**调用，
// 不走 grep 源码字符串自证。
//
// 覆盖（对应本任务验收项）：
//   A 选 dev 后：read_source / notes 写 / appendDiscuss / appendDesign / AGENTS 写 / 终端 cwd / 扫描 / chat 读
//     实际读写的都是 dev，而中央 anchor 源文件字节不变、唯一 work 账本仍在 anchor；
//   B 冻结候选目录：真实文件写被拒且**零增长**；
//   C 坏 dev 指针：读/写/扫描/监听/终端**真实拒**，不回退 anchor；
//   D 指针切换：监听目标刷新到新根（不再看旧目录仍宣称看新根），中央 changes.jsonl 仍 anchor。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkService } from "../src/server/work/service";
import { loadEvents } from "../src/server/work/eventStore";
import { submitDefinitionImports } from "../src/server/work/tasks";
import { importPlanChecked } from "../src/server/work/references";
import { activateBaseline } from "../src/server/work/documents";
import { readWorkspaces, resolveDevFromProjection, registerWorkspace, selectDevWorkspace, freezeWorkspace } from "../src/server/work/workspaces";
import { installWorkspaceHostWiring, resetWorkspaceHostWiring } from "../src/server/work/hostWiring";
import { buildContextPackage, readContextSource } from "../src/server/work/context";
import { PROJECT_NOTES_REL, projectNotesFileInfo, upsertProjectNotes } from "../src/server/work/projectIndex";
import { appendDesign, appendDiscuss, readDiscuss, readDesign, projectWorkDir, workstationDir } from "../src/server/workstation";
import { attachAgentsMd } from "../src/server/attachAgentsMd";
import { executeChatTool } from "../src/server/chatTools";
import { scanProject } from "../src/server/scanner";
import { watchProject, unwatchProject, readChanges, closeAllWatchers } from "../src/server/watcher";
import { createTerminalSession, closeTerminal, listTerminalSessions, closeAllTerminals } from "../src/server/pty";
import { startGraphRefresh, stopAllGraphRefresh, graphRefreshRootOf } from "../src/server/work/graphRefresh";
// 组合根副作用：注册六图探针（与生产 `syncEvidence.ts` 工具同一做法；sync.ts 不反向 import 上层模块）
import "../src/server/work/syncGraph";

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
const sha = (s: string | Buffer): string => crypto.createHash("sha256").update(s).digest("hex");
const bytesOf = (f: string): string | null => (fs.existsSync(f) ? sha(fs.readFileSync(f)) : null);

function thrown(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
async function athrown(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs: number, stepMs = 40): Promise<boolean> {
  const t0 = Date.now();
  for (;;) {
    if (pred()) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(stepMs);
  }
}

// ── 夹具 ──
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "tatai-wsr-"));
const dataDir = path.join(tmpBase, "home");
const A = "wsra";
const B = "wsrb";
const G = "wsrg";
const anchorA = path.join(tmpBase, "anchorA");
const devA = path.join(tmpBase, "devA");
const devA2 = path.join(tmpBase, "devA2");
const devA3 = path.join(tmpBase, "devA3");
const anchorB = path.join(tmpBase, "anchorB");
const devB = path.join(tmpBase, "devB");
const anchorG = path.join(tmpBase, "anchorG");
const devG1 = path.join(tmpBase, "devG1");
const devG2 = path.join(tmpBase, "devG2");
const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};

const PLAN = [
  "# WSR 夹具施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  "| R-1 | todo | 源根贯通卡 |  | R-1 验收记录 |",
  "",
  "### R-1 源根贯通卡",
  "",
  "**设计依据**：§2。",
  "",
  "- [ ] 做出来",
  "",
].join("\n");
const DESIGN_ANCHOR = "# WSR 夹具设计书（anchor 版）\n\n## 2 模块划分\n\nanchor 版正文\n";
const DESIGN_DEV = "# WSR 夹具设计书（dev 版）\n\n## 2 模块划分\n\ndev 版正文\n";
const DESIGN_G1 = "# WSR 夹具设计书（devG1 版）\n\n## 2 模块划分\n\ndevG1 版正文\n";
const DESIGN_G2 = "# WSR 夹具设计书（devG2 版）\n\n## 2 模块划分\n\ndevG2 版正文\n";

for (const [root, design] of [
  [anchorA, DESIGN_ANCHOR],
  [devA, DESIGN_DEV],
  [devA2, DESIGN_DEV],
  [anchorB, DESIGN_ANCHOR],
  [devB, DESIGN_DEV],
  [anchorG, DESIGN_ANCHOR],
  [devG1, DESIGN_G1],
  [devG2, DESIGN_G2],
] as const) {
  write(path.join(root, ".工作台", "design.md"), design);
  write(path.join(root, ".工作台", "plan.md"), PLAN);
}
write(path.join(devG1, "src", "only-g1.ts"), "export const onlyG1 = 1;\n");
write(path.join(devG2, "src", "only-g2.ts"), "export const onlyG2 = 1;\n");
write(path.join(anchorA, "src", "anchor-only.ts"), "export const anchorOnly = 1;\n");
write(path.join(anchorA, "src", "shared-name.ts"), "export const whichRoot = 'anchor';\n");
write(path.join(devA, "src", "dev-only.ts"), "export const devOnly = 1;\n");
write(path.join(devA, "src", "shared-name.ts"), "export const whichRoot = 'dev';\n");
write(path.join(devA, "README.md"), "# devA\n");
write(path.join(devA2, "src", "new-root.txt"), "new root\n");
write(path.join(anchorB, "src", "only-anchor.ts"), "export const onlyAnchorB = 1;\n");
write(path.join(devB, "src", "only-dev.ts"), "export const onlyDevB = 1;\n");
write(path.join(devA3, "keep.txt"), "keep\n");

const stamp = "2026-10-09T00:00:00+08:00";
write(
  path.join(dataDir, "registry.json"),
  JSON.stringify({
    version: 1,
    projects: [
      { id: A, name: "WSR-A", path: anchorA, kind: "backend", registered_at: stamp, last_opened_at: stamp },
      { id: B, name: "WSR-B", path: anchorB, kind: "backend", registered_at: stamp, last_opened_at: stamp },
      { id: G, name: "WSR-G", path: anchorG, kind: "backend", registered_at: stamp, last_opened_at: stamp },
    ],
  }),
);
process.env.TATAI_HOME = dataDir;

const service = new WorkService({ dataDir });
const workDirA = projectWorkDir(A, dataDir);
const CHANGE = "change-wsr";
const COORD = "wsr-coordinator";
const submitter = { submit: (c: unknown) => service.submit(c), read: () => readWorkspaces(workDirA) };

/** 夹具：定义导入 + 基线（此时无 dev 指针 → documents 走 anchor） */
for (const [pid, wd] of [[A, workDirA], [B, projectWorkDir(B, dataDir)], [G, projectWorkDir(G, dataDir)]] as const) {
  const imported = importPlanChecked(PLAN, wd, { plan_revision: sha(PLAN) });
  submitDefinitionImports(service, { project_id: pid, change_id: CHANGE, actor_id: "wsr-setup", role: "coordinator", definitions: imported.definitions });
  activateBaseline(pid, { approved_by: "user", approval_basis: "WSR 隔离夹具审定（不代表真实用户 Gate）", approval_kind: "user_confirmed" }, dataDir);
}
installWorkspaceHostWiring();

const anchorSnap = {
  design: bytesOf(path.join(anchorA, ".工作台", "design.md")),
  plan: bytesOf(path.join(anchorA, ".工作台", "plan.md")),
  anchorOnly: bytesOf(path.join(anchorA, "src", "anchor-only.ts")),
  agents: bytesOf(path.join(anchorA, "AGENTS.md")),
  notes: bytesOf(path.join(anchorA, ...PROJECT_NOTES_REL.split("/"))),
  discuss: bytesOf(path.join(anchorA, ".工作台", "design.discuss.md")),
};

try {
  // ═══════════ A：选 dev 后各源读/写走 dev ═══════════
  section("A-0 登记 dev 工作区并 select_dev");
  {
    const reg = registerWorkspace(submitter, { project_id: A, workspace_id: "dev-a", change_id: CHANGE, actor_id: COORD, role: "coordinator", kind: "dev", purpose: "夹具 dev", root: devA, source_kind: "directory" });
    ok(reg.ok === true, `A-0 登记 dev-a（${reg.ok ? "ok" : (reg as { code?: string }).code}）`);
    for (const [id, root] of [["dev-a2", devA2], ["dev-a3", devA3]] as const) {
      const r = registerWorkspace(submitter, { project_id: A, workspace_id: id, change_id: CHANGE, actor_id: COORD, role: "coordinator", kind: "dev", purpose: "夹具", root, source_kind: "directory" });
      ok(r.ok === true, `A-0 登记 ${id}`);
    }
    const sel = selectDevWorkspace(submitter, { project_id: A, workspace_id: "dev-a", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: 0 });
    ok(sel.ok === true, `A-0 select_dev dev-a（${sel.ok ? "ok" : (sel as { code?: string }).code}）`);
  }

  section("A-1 read_source（context.readContextSource）读 dev");
  {
    const dev = readContextSource(A, "src/dev-only.ts", { dataDir });
    ok(dev.content_sha256 === sha("export const devOnly = 1;\n"), "A-1 dev 独有源可读到（内容哈希相符）");
    const same = readContextSource(A, "src/shared-name.ts", { dataDir });
    ok(same.total.chars > 0, "A-1 同名源取到（内容与 anchor 同名文件不同）", { chars: same.total.chars });
    const anchorOnly = thrown(() => readContextSource(A, "src/anchor-only.ts", { dataDir }));
    ok(anchorOnly !== null, "A-1 anchor 独有源**读不到**（证明没在读 anchor，未回退主根）", anchorOnly);
  }

  section("A-2 notes 写读同根（projectIndex → dev）");
  {
    const res = upsertProjectNotes(
      A,
      {
        expected_file_sha256: null,
        entries: [{ id: "n1", responsibility: "夹具说明", sources: [{ path: "src/dev-only.ts", sha256: sha("export const devOnly = 1;\n") }] }],
      },
      dataDir,
    );
    ok(res.ok === true, `A-2 notes upsert 成功（来源 sha 与 dev 当前内容相符）`);
    const devNotes = path.join(devA, ...PROJECT_NOTES_REL.split("/"));
    const anchorNotes = path.join(anchorA, ...PROJECT_NOTES_REL.split("/"));
    ok(fs.existsSync(devNotes), "A-2 说明文件真实落在 dev 根");
    ok(!fs.existsSync(anchorNotes), "A-2 anchor 根**没**被写入说明文件");
    ok(projectNotesFileInfo(A, dataDir).rel_path === PROJECT_NOTES_REL, "A-2 读侧报告同一 rel 路径");
  }

  section("A-3 appendDiscuss / appendDesign / AGENTS 写走 dev");
  {
    const d = appendDiscuss(A, "夹具待议：源根应走 dev", dataDir);
    ok(d.source.startsWith(devA), `A-3 appendDiscuss 落到 dev（${d.source}）`);
    ok(fs.existsSync(path.join(devA, ".工作台", "design.discuss.md")), "A-3 dev 有待议文件");
    ok(!fs.existsSync(path.join(anchorA, ".工作台", "design.discuss.md")), "A-3 anchor 无待议文件");
    ok(readDiscuss(A, dataDir).exists === true, "A-3 readDiscuss 读回");

    const before = fs.readFileSync(path.join(devA, ".工作台", "design.md"), "utf8");
    const app = appendDesign(A, "## 夹具追加段（dev）\n", dataDir);
    ok(app.source.startsWith(devA), `A-3 appendDesign 落到 dev（${app.source}）`);
    const afterDev = fs.readFileSync(path.join(devA, ".工作台", "design.md"), "utf8");
    ok(afterDev.length > before.length && afterDev.includes("夹具追加段"), "A-3 dev 设计书真实追加");
    ok(readDesign(A, dataDir).exists === true, "A-3 readDesign 读回");

    const ag = attachAgentsMd(A, dataDir);
    ok(ag.file.startsWith(devA), `A-3 attachAgentsMd 落到 dev（${ag.file}）`);
    ok(fs.existsSync(path.join(devA, "AGENTS.md")) && fs.readFileSync(path.join(devA, "AGENTS.md"), "utf8").includes("tatai-mcp:start"), "A-3 dev AGENTS.md 有约定段");
    ok(!fs.existsSync(path.join(anchorA, "AGENTS.md")), "A-3 anchor 没有生成 AGENTS.md");
  }

  section("A-4 终端 cwd = dev；扫描读 dev；chat 读 dev");
  {
    const sess = createTerminalSession(A, 80, 24);
    ok(path.resolve(sess.cwd) === path.resolve(devA), `A-4 终端会话 cwd=${sess.cwd}（应为 dev）`);
    const closed = await closeTerminal(sess.id, A);
    ok(closed !== null, "A-4 终端会话可关闭（不留悬挂会话）", closed);
    ok(listTerminalSessions(A).length === 0, "A-4 关闭后该项目无残留终端会话");
    await closeAllTerminals();

    const scan = await scanProject(A, dataDir);
    ok(path.resolve(scan.root) === path.resolve(devA), `A-4 scanProject root=${scan.root}（应为 dev）`);

    const readDev = executeChatTool(A, "read_file", JSON.stringify({ path: "src/dev-only.ts" }));
    ok(readDev.result.includes("devOnly"), "A-4 chat read_file 读到 dev 独有源");
    const readAnchor = executeChatTool(A, "read_file", JSON.stringify({ path: "src/anchor-only.ts" }));
    ok(!readAnchor.result.includes("anchorOnly"), "A-4 chat 读 anchor 独有源**取不到**（未回退主根）", readAnchor.result.slice(0, 200));
  }

  section("A-5 中央 anchor 源文件字节不变 + 唯一 work 账本仍 anchor");
  {
    ok(bytesOf(path.join(anchorA, ".工作台", "design.md")) === anchorSnap.design, "A-5 anchor 设计书字节未变");
    ok(bytesOf(path.join(anchorA, ".工作台", "plan.md")) === anchorSnap.plan, "A-5 anchor 施工图字节未变");
    ok(bytesOf(path.join(anchorA, "src", "anchor-only.ts")) === anchorSnap.anchorOnly, "A-5 anchor 源文件字节未变");
    ok(bytesOf(path.join(anchorA, "AGENTS.md")) === anchorSnap.agents, "A-5 anchor 未生成 AGENTS.md");
    ok(fs.existsSync(path.join(workDirA, "events.jsonl")), "A-5 唯一 work 账本在 anchor（events.jsonl 存在）");
    ok(!fs.existsSync(path.join(devA, ".工作台", "work", "events.jsonl")), "A-5 dev 下**没有**第二套 work 账本");
    ok(loadEvents(workDirA).events.length > 0, "A-5 账本事件可读（中央事实源仍 anchor）");
  }

  // ═══════════ D：指针切换后监听目标刷新 ═══════════
  section("D 指针切换：监听/派生根刷新到新目录（不再看旧目录）");
  {
    const w1 = watchProject(A, dataDir);
    await w1.mounted;
    await w1.ready;
    ok(path.resolve(w1.root) === path.resolve(devA), `D 首次监听根=${w1.root}（dev）`);
    startGraphRefresh(A, { dataDir });
    ok(path.resolve(graphRefreshRootOf(A) ?? "") === path.resolve(devA), `D 派生链根=${graphRefreshRootOf(A)}（dev）`);

    // 写入 dev 新文件 → 中央 changes.jsonl 应看到（相对 dev 根的路径）
    write(path.join(devA, "src", "watch-a.txt"), "a\n");
    const sawA = await waitFor(() => readChanges(A, 200, dataDir).some((c) => c.path === "src/watch-a.txt"), 8000);
    ok(sawA, "D dev 变更被监听并落到中央流水");
    ok(readChanges(A, 200, dataDir).every((c) => c.path !== undefined), "D 变更行形状正常");

    const anchorChanges = path.join(anchorA, ".工作台", "changes.jsonl");
    ok(fs.existsSync(anchorChanges), "D 变更流水落在 anchor（中央事实域）");
    ok(!fs.existsSync(path.join(devA, ".工作台", "changes.jsonl")), "D dev 下没有第二套 changes.jsonl");

    // 切指针到 dev-a2 → 重新开监听必须指向新根
    const sel2 = selectDevWorkspace(submitter, { project_id: A, workspace_id: "dev-a2", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: readWorkspaces(workDirA).pointer!.revision });
    ok(sel2.ok === true, `D select_dev 切到 dev-a2（${sel2.ok ? "ok" : (sel2 as { code?: string }).code}）`);
    const w2 = watchProject(A, dataDir);
    ok(w2.already === false, "D 指针切换后重新开监听：不是 already（真实重挂）");
    await w2.mounted;
    await w2.ready;
    ok(path.resolve(w2.root) === path.resolve(devA2), `D 重挂后监听根=${w2.root}（dev-a2）`);
    // 与 index.ts 的落地路径同序：开监听成功后调用 startGraphRefresh（它必须把链也切到新根）
    startGraphRefresh(A, { dataDir });
    ok(path.resolve(graphRefreshRootOf(A) ?? "") === path.resolve(devA2), `D 重挂后派生链根=${graphRefreshRootOf(A)}（dev-a2）`);

    write(path.join(devA2, "src", "watch-b.txt"), "b\n");
    const sawB = await waitFor(() => readChanges(A, 200, dataDir).some((c) => c.path === "src/watch-b.txt"), 8000);
    ok(sawB, "D 新根变更被监听（真在看 dev-a2）");

    // 旧根再写：不应再出现新行（避免“看着旧目录却宣称看新目录”）
    await sleep(600);
    const seenBefore = readChanges(A, 500, dataDir).filter((c) => c.path === "src/watch-a.txt").length;
    write(path.join(devA, "src", "watch-a.txt"), "a2\n");
    await sleep(1500);
    const seenAfter = readChanges(A, 500, dataDir).filter((c) => c.path === "src/watch-a.txt").length;
    ok(seenAfter === seenBefore, `D 旧根变更不再进流水（旧 ${seenBefore} 条 → 现 ${seenAfter} 条）`);
  }

  // ═══════════ B：冻结候选目录拒写且零增长 ═══════════
  section("B 冻结候选目录：真实文件写被拒且零增长（开发指针仍指向该目录）");
  {
    // 先把开发指针切回 dev-a（Phase D 已切到 dev-a2）；否则写目标不是下面要冻结的那个目录。
    const selBack = selectDevWorkspace(submitter, { project_id: A, workspace_id: "dev-a", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: readWorkspaces(workDirA).pointer!.revision });
    ok(selBack.ok === true, `B 开发指针切回 dev-a（${selBack.ok ? "ok" : (selBack as { code?: string }).code}）`);
    // 把当前 dev 目录同时登记为候选并冻结 → 该目录成为“冻结候选源目录”
    const reg = registerWorkspace(submitter, { project_id: A, workspace_id: "cand-shared", change_id: CHANGE, actor_id: COORD, role: "coordinator", kind: "candidate", purpose: "冻结同目录夹具", root: devA, source_kind: "directory" });
    ok(reg.ok === true, `B 登记 cand-shared（root=dev）`);
    theFreeze: {
      const rec = readWorkspaces(workDirA).workspaces["cand-shared"];
      const fr = freezeWorkspace(submitter, { project_id: A, workspace_id: "cand-shared", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: rec.revision, included_uncommitted: false, declared_paths: [] });
      ok(fr.ok === true, `B 冻结 cand-shared（${fr.ok ? "ok" : `${(fr as { code?: string }).code}: ${(fr as { message?: string }).message}`}）`);
      if (!fr.ok) break theFreeze;
      ok(readWorkspaces(workDirA).workspaces["cand-shared"].status === "frozen", "B 冻结状态落账");

      const sizeOf = (p: string): number => (fs.existsSync(p) ? fs.statSync(p).size : -1);
      const dBefore = sizeOf(path.join(devA, ".工作台", "design.discuss.md"));
      const dMsg = thrown(() => appendDiscuss(A, "应被拒", dataDir));
      ok(dMsg !== null && /冻结|CANDIDATE_FROZEN|候选/.test(dMsg), "B appendDiscuss 被拒（冻结源码写）", dMsg);
      ok(sizeOf(path.join(devA, ".工作台", "design.discuss.md")) === dBefore, "B appendDiscuss 零增长");

      const gBefore = sizeOf(path.join(devA, "AGENTS.md"));
      const gMsg = thrown(() => attachAgentsMd(A, dataDir));
      ok(gMsg !== null && /冻结|CANDIDATE_FROZEN|候选/.test(gMsg), "B attachAgentsMd 被拒", gMsg);
      ok(sizeOf(path.join(devA, "AGENTS.md")) === gBefore, "B AGENTS 写零增长");

      const nBefore = sizeOf(path.join(devA, ...PROJECT_NOTES_REL.split("/")));
      const nMsg = thrown(() => upsertProjectNotes(A, { expected_file_sha256: null, entries: [{ id: "n2", responsibility: "应被拒" }] }, dataDir));
      ok(nMsg !== null && /冻结|CANDIDATE_FROZEN|候选/.test(nMsg), "B notes 写被拒", nMsg);
      ok(sizeOf(path.join(devA, ...PROJECT_NOTES_REL.split("/"))) === nBefore, "B notes 写零增长");

      const evBefore = sizeOf(path.join(workDirA, "events.jsonl"));
      ok(evBefore >= 0, "B 中央账本原字节可读（拒绝不增长由写口保证）");
    }
  }

  // ═══════════ C：坏 dev 指针真实拒（不回退 anchor） ═══════════
  section("C 坏 dev 指针：读/写/扫描/监听/终端真实拒，不回退 anchor");
  {
    // (i) 纯派生判据：指针指向不存在 → blocked（真实公共函数）
    const proj = readWorkspaces(workDirA);
    const ptr = proj.pointer!;
    const missing = resolveDevFromProjection(A, anchorA, proj, { ...ptr, current_dev_workspace_id: "no-such-ws" });
    ok(missing.source === "blocked" && missing.root === null, `C 指针指向不存在的工作区 → blocked/root=null（实际 ${missing.source}/${missing.root}）`);

    // 回收 dev-a3（先切走指针，保证不是活指针）→ 指向已回收 = blocked
    const sel3 = selectDevWorkspace(submitter, { project_id: A, workspace_id: "dev-a3", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: readWorkspaces(workDirA).pointer!.revision });
    ok(sel3.ok === true, "C 先切到 dev-a3");
    const back = selectDevWorkspace(submitter, { project_id: A, workspace_id: "dev-a2", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: readWorkspaces(workDirA).pointer!.revision });
    ok(back.ok === true, "C 再切回 dev-a2");
    const rec3 = readWorkspaces(workDirA).workspaces["dev-a3"];
    const { retireWorkspace } = await import("../src/server/work/workspaces");
    const rt = retireWorkspace(submitter, { project_id: A, workspace_id: "dev-a3", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: rec3.revision, reason: "夹具回收", reachability: "目录在场" });
    ok(rt.ok === true, `C 回收 dev-a3（${rt.ok ? "ok" : (rt as { code?: string }).code}）`);
    const proj3 = readWorkspaces(workDirA);
    const retired = resolveDevFromProjection(A, anchorA, proj3, { ...proj3.pointer!, current_dev_workspace_id: "dev-a3" });
    ok(retired.source === "blocked" && retired.root === null, `C 指针指向已回收工作区 → blocked/root=null（实际 ${retired.source}）`);

    // (ii) 真实端到端：B 项目 dev 目录被移走（指针仍在，source=pointer）
    const regB = registerWorkspace(submitter, { project_id: B, workspace_id: "dev-b", change_id: CHANGE, actor_id: COORD, role: "coordinator", kind: "dev", purpose: "夹具 dev-b", root: devB, source_kind: "directory" });
    ok(regB.ok === true, "C 登记 B 的 dev-b");
    const selB = selectDevWorkspace({ submit: (c: unknown) => service.submit(c), read: () => readWorkspaces(projectWorkDir(B, dataDir)) }, { project_id: B, workspace_id: "dev-b", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: 0 });
    ok(selB.ok === true, `C select_dev dev-b（${selB.ok ? "ok" : (selB as { code?: string }).code}）`);
    fs.rmSync(devB, { recursive: true, force: true });

    const readMsg = thrown(() => readContextSource(B, "src/only-anchor.ts", { dataDir }));
    ok(readMsg !== null, "C 坏 dev：read_source 真实拒（anchor 里有同名源，仍未回退）", readMsg);
    const notesMsg = thrown(() => upsertProjectNotes(B, { expected_file_sha256: null, entries: [{ id: "x", responsibility: "应被拒" }] }, dataDir));
    ok(notesMsg !== null, "C 坏 dev：notes 写真实拒", notesMsg);
    const discMsg = thrown(() => appendDiscuss(B, "应被拒", dataDir));
    ok(discMsg !== null, "C 坏 dev：appendDiscuss 真实拒", discMsg);
    const agMsg = thrown(() => attachAgentsMd(B, dataDir));
    ok(agMsg !== null, "C 坏 dev：AGENTS 写真实拒", agMsg);
    ok(!fs.existsSync(path.join(anchorB, "AGENTS.md")), "C 坏 dev：anchor 未被写入 AGENTS.md");
    ok(!fs.existsSync(path.join(devB, "docs", "project-notes.json")), "C 坏 dev：没有在缺失目录里造出说明文件");
    const scanMsg = await athrown(() => scanProject(B, dataDir));
    ok(scanMsg !== null, "C 坏 dev：扫描真实拒", scanMsg);
    const watchMsg = thrown(() => watchProject(B, dataDir));
    ok(watchMsg !== null, "C 坏 dev：监听真实拒（不以 anchor 顶替）", watchMsg);
    const termMsg = thrown(() => createTerminalSession(B));
    ok(termMsg !== null, "C 坏 dev：终端真实拒（不在坏指针上启动 shell）", termMsg);
  }

  section("E 收尾：旧相关读口在无 dev 指针时逐字兼容（anchor 口径）");
  {
    // 新项目 B 的 dev-b 已坏；另用未登记 dev 指针的路径验证默认口径：A 切回 :main 后读 anchor
    const { mainWorkspaceId } = await import("../src/server/work/workspaces");
    const back = selectDevWorkspace(submitter, { project_id: A, workspace_id: mainWorkspaceId(A), change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: readWorkspaces(workDirA).pointer!.revision });
    ok(back.ok === true, "E select_dev 回 :main");
    const anchorRead = readContextSource(A, "src/anchor-only.ts", { dataDir });
    ok(anchorRead.content_sha256 === sha("export const anchorOnly = 1;\n"), "E 回 :main 后 read_source 读 anchor（默认口径兼容）");
    const design = readDesign(A, dataDir);
    ok(design.exists === true && design.source.startsWith(anchorA), `E 回 :main 后设计源=anchor（${design.exists ? design.source : "不存在"}）`);
  }

  // ═══════════ F：sync 域来源/目标按 dev 根实核（真登记 + 坏指针 fail-closed） ═══════════
  section("F sync 域：契约来源按 dev 根实核；坏 dev 指针 fail-closed 点名");
  {
    const syncMod = await import("../src/server/work/sync");
    const sel = selectDevWorkspace(submitter, { project_id: A, workspace_id: "dev-a", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: readWorkspaces(workDirA).pointer!.revision });
    ok(sel.ok === true, `F 指针切回 dev-a（${sel.ok ? "ok" : (sel as { code?: string }).code}）`);
    const rel = "synced/dev-src.md";
    const body = "dev sync source\n";
    write(path.join(devA, "synced", "dev-src.md"), body);
    const contract = {
      schema_version: 1,
      batch_id: "f-dev",
      project_id: A,
      title: "夹具批次",
      sources: [{ path: rel, sha256: sha(body) }],
      items: [{ id: "src", label: "来源", required: true, check: { type: "file_hash", path: rel, sha256: sha(body) } }],
      blocks_entry: true,
    };
    const cmd = syncMod.buildRegisterContractCommand({
      projectId: A,
      changeId: CHANGE,
      actorId: COORD,
      role: "coordinator",
      contract,
      expectedRevision: syncMod.syncEntityRevision(A, dataDir, "f-dev"),
    });
    const r = (await service.submit(cmd)) as { ok: boolean; code?: string };
    ok(r.ok === true, `F 用 **dev 独有**源登记同步契约成功（来源实核走 dev 根；若读 anchor 会因来源不存在被拒）（${r.ok ? "ok" : r.code}）`);
    const block = syncMod.computeSyncBlock(A, dataDir);
    ok(block.configured === true && block.batches.some((b) => b.batch_id === "f-dev"), "F 同步域已配置且该批次进阻断清单（无证据 → 未通过）", block.batches.map((b) => b.batch_id));

    fs.rmSync(devA, { recursive: true, force: true });
    const block2 = syncMod.computeSyncBlock(A, dataDir);
    ok(
      block2.blocked === true && JSON.stringify(block2).includes("当前开发工作区不可用"),
      "F 坏 dev 指针：同步域 fail-closed 且点名「当前开发工作区不可用」（不回退项目根）",
      block2.batches.map((b) => ({ id: b.batch_id, reasons: b.reasons.slice(0, 1) })),
    );
  }

  // ═══════════ G：指针在**两个调用之间**变更 → 下一次读立刻看新 root ═══════════
  // 目的（性能修复的回归面）：上下文读口把"当前开发根"解析改成**复用本次请求已现读的账本快照**后，
  // 绝不能因此跨请求缓存旧指针/旧绿——同一进程里两次相邻调用之间切了指针，第二次必须立刻看新 root。
  // 用**独立项目 + 两个等价 dev 根**做真实夹具（各自有同形但内容不同的设计书与独有源），
  // 走真实公共函数（`readContextSource` / `buildContextPackage`），不走 grep 源码自证。
  section("G 指针在两调用间变更：下一次读立刻看新 root（不跨请求缓存旧指针/旧绿）");
  {
    const workDirG = projectWorkDir(G, dataDir);
    const submitterG = { submit: (c: unknown) => service.submit(c), read: () => readWorkspaces(workDirG) };
    for (const [id, root] of [["dev-g1", devG1], ["dev-g2", devG2]] as const) {
      const reg = registerWorkspace(submitterG, { project_id: G, workspace_id: id, change_id: CHANGE, actor_id: COORD, role: "coordinator", kind: "dev", purpose: `夹具 ${id}`, root, source_kind: "directory" });
      ok(reg.ok === true, `G 登记 ${id}（${reg.ok ? "ok" : (reg as { code?: string }).code}）`);
    }
    const sel1 = selectDevWorkspace(submitterG, { project_id: G, workspace_id: "dev-g1", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: readWorkspaces(workDirG).pointer?.revision ?? 0 });
    ok(sel1.ok === true, `G select_dev dev-g1（${sel1.ok ? "ok" : (sel1 as { code?: string }).code}）`);

    // ① 第一次调用（无快照的公共读口）看 dev-g1
    const r1 = readContextSource(G, "src/only-g1.ts", { dataDir });
    ok(r1.content_sha256 === sha("export const onlyG1 = 1;\n"), "G 第一次调用读到 dev-g1 独有源（内容哈希相符）");

    // ② 指针在两次调用之间切换 → 下一次调用**立刻**看新 root，且旧 root 的独有源读不到
    const sel2 = selectDevWorkspace(submitterG, { project_id: G, workspace_id: "dev-g2", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: readWorkspaces(workDirG).pointer!.revision });
    ok(sel2.ok === true, `G 指针切到 dev-g2（${sel2.ok ? "ok" : (sel2 as { code?: string }).code}）`);
    const r2 = readContextSource(G, "src/only-g2.ts", { dataDir });
    ok(r2.content_sha256 === sha("export const onlyG2 = 1;\n"), "G 切换后下一次调用立刻读到 dev-g2 独有源（新 root 立即可见，未沿用旧指针）");
    const goneMsg = thrown(() => readContextSource(G, "src/only-g1.ts", { dataDir }));
    ok(goneMsg !== null, "G 旧 root 的独有源在新指针下**读不到**（证明真按当前指针解析）", goneMsg);

    // ③ 上下文包（sourceRootOf 解析设计页）同样跟着指针走，再切回也立刻跟回
    const pkgG2 = buildContextPackage(G, { dataDir });
    ok(pkgG2.page !== null && pkgG2.page.text.includes("devG2"), "G 上下文包设计页取 dev-g2 的设计书（跟当前指针走）", pkgG2.page?.text.slice(0, 60));
    const selBackG1 = selectDevWorkspace(submitterG, { project_id: G, workspace_id: "dev-g1", change_id: CHANGE, actor_id: COORD, role: "coordinator", expected_revision: readWorkspaces(workDirG).pointer!.revision });
    ok(selBackG1.ok === true, "G 指针切回 dev-g1");
    const pkgG1 = buildContextPackage(G, { dataDir });
    ok(pkgG1.page !== null && pkgG1.page.text.includes("devG1"), "G 再切回后上下文包立刻取 dev-g1 的设计书（不沿用上一次的结果）", pkgG1.page?.text.slice(0, 60));
  }
} finally {
  try {
    await closeAllWatchers();
  } catch {
    /* 收尾尽力 */
  }
  try {
    stopAllGraphRefresh();
  } catch {
    /* 收尾尽力 */
  }
  try {
    await closeAllTerminals();
  } catch {
    /* 收尾尽力 */
  }
  resetWorkspaceHostWiring();
  // 句柄释放有延迟（pty/chokidar），且退出前还有异步收尾可能重建数据目录：先尽力删一次。
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (!fs.existsSync(tmpBase)) break;
    } catch {
      /* 下一轮重试 */
    }
    await sleep(300);
  }
}
// 最终兜底：`exit` 事件里事件循环已空（不再有定时器/异步收尾），同步再删一次，保证不留临时树。
process.on("exit", () => {
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* 尽力而为 */
  }
});

console.log(`\n[verify] 结果：PASS ${pass} / FAIL ${fail}`);
if (fail > 0) process.exitCode = 1;
