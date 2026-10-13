#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""V09-67 界面验证：交付总览「读哪个版本」（工作区/交付候选）——真实浏览器 + 真实服务 + 真实全绿夹具。

DESIGN §6.14 第 8 段（交付读数默认版本与试用提升）＋ §3.16/§3.17（人的默认交付总览）；
PLAN V09-67 卡面与 chk-v09-67-*；需求 req-project-workspace-version-isolation。

这一层验的是**界面与读口的真实闭环**（后端派生/冻结/回收另由 verify-v09-63…66 覆盖）：

  · 真服务：临时 TATAI_HOME + 动态空闲端口起本仓真实后端（src/server/index.ts），临时 cacheDir 起
    真实 Vite dev server（TATAI_DEV_API_PORT 指向后端），真实 Playwright Chromium 打开真实应用包；
  · 真夹具（**合法完整**）：三张真图纸源（DESIGN 功能清单声明区 + PLAN 卡/功能映射/「交付核对声明」/
    「集成检查要求」，章节 hash 现算回填）经**真实宿主唯一写入口**登记——需求登记、定义导入、基线激活、
    工作区登记/冻结/试用提升、源清单存证（reportingHost）、作者自检 + 非作者独立审查（audit 模块）。
    **不是 mock 出来的返回值**；夹具项目是临时目录里的真实 Git 仓库（不可变快照走 git_blob 快速通道）。
  · 可控夹具：只在浏览器内**拦截** `GET …/workspaces` 与 `GET …/feature-ledger`，用于旧宿主（404/缺字段）、
    迟到回包、分页 409、刷新失败这些真服务造不出来的**故障分支**。**正常场景一律透传真实服务**。

覆盖（逐条对卡面/check）：
  ① 真绿：默认交付读数 200 且真正 `ready_for_trial`（无登记试用版项目＝活动主目录旧语义）；
  ② 默认读「当前试用候选」：界面把解析出的工作区 id **显式带上**，服务端实际读的 workspace_id/根/指纹一致；
  ③ 切「开发中」：立即撤下旧结论、请求带上开发工作区 id、服务端实际读开发区根（**切开发读新根**）；
  ④ 未验候选提升**真拒**且旧指针保留；给真技术+独审事实后才提升成功（**§6.14 第 8 段**）；
  ⑤ dev 变更（源码＋设计/施工）**不让固定候选变红**；
  ⑥ 给旧候选追加真实失败 ⇒ 同版读数**必须变化**（不能锁死颜色）；
  ⑦ 同 scope 快切 / 迟到回包不串；分页续页带同一参数、409 旧页作废；
  ⑧ 旧宿主 404 / delivery 缺 workspace 字段 = 显式未知；刷新失败保留内容但撤下可试用结论；
  ⑨ 窄屏无横向溢出、键盘可切换版本。

隔离红线（AGENTS.md §5）：只写系统临时目录与隔离证据目录（默认 `.工作台/v09-67-ui/`，可用
TATAI_V09_67_UI_OUT 覆盖）；不碰真实 ~/.tatai、不碰真实 8787、不 commit、不装依赖、不改 node_modules
（Vite cacheDir 走环境变量）。清理只杀本脚本自己拉起的进程（按 PID + 子树）。

用法（环境约束：不用 pnpm exec / pnpm build）：
  python scripts/verify-v09-67-ui.py
  TATAI_V09_67_UI_OUT=<dir> python scripts/verify-v09-67-ui.py
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
OUT = Path(os.environ.get("TATAI_V09_67_UI_OUT") or (REPO / ".工作台" / "v09-67-ui"))

PID_GREEN = "p-v0967g"  # 甲：真绿（无登记试用版 ⇒ 默认按活动主目录读）
PID_WS = "p-v0967"  # 乙：工作区/试用提升生命周期
PID_LEGACY = "p-v0967-legacy"  # 丙：无任何工作区登记

RESULTS: list[dict] = []
NOTES: list[str] = []
DEFECTS: list[str] = []


def check(cond: bool, label: str, detail: object = "", *, defect: bool = False) -> bool:
    RESULTS.append({"ok": bool(cond), "label": label, "detail": str(detail), "defect": bool(defect)})
    print(f"{'PASS' if cond else ('DEFECT' if defect else 'FAIL')} {label}" + (f" — {detail}" if str(detail) else ""), flush=True)
    if not cond and defect:
        DEFECTS.append(f"{label} — {detail}")
    return bool(cond)


def note(msg: str) -> None:
    NOTES.append(msg)
    print(f"     {msg}", flush=True)


# ─────────────────────────── 进程与端口 ───────────────────────────


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def wait_http(url: str, timeout_s: float, label: str) -> None:
    deadline = time.time() + timeout_s
    last = ""
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                if 200 <= r.status < 500:
                    return
        except Exception as e:  # noqa: BLE001
            last = str(e)
        time.sleep(0.3)
    raise RuntimeError(f"{label} 未就绪：{url}（{last}）")


def kill_tree(pid: int | None) -> None:
    if pid is None:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, check=False)
        else:
            os.kill(pid, 9)
    except Exception:  # noqa: BLE001
        pass


def http_json(url: str) -> tuple[int, object]:
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(body)
        except Exception:  # noqa: BLE001
            return e.code, body


# ─────────────────────────── 夹具（真实注册表 + 真实工作区写入 + 真实证据） ───────────────────────────

SEED_TS = r'''
// verify-v09-67-ui.py 的夹具写入（真实宿主唯一写入口；临时 TATAI_HOME；不碰真实账本/服务）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { addProject } from "file://__REPO__/src/server/registry";
import { WorkService } from "file://__REPO__/src/server/work/service";
import { projectWorkDir } from "file://__REPO__/src/server/workstation";
import { importTaskDefinitions } from "file://__REPO__/src/server/work/plan";
import { submitDefinitionImports } from "file://__REPO__/src/server/work/tasks";
import { activateBaseline, buildSectionIndex } from "file://__REPO__/src/server/work/documents";
import { registerRequirement } from "file://__REPO__/src/server/work/requirements";
import {
  readWorkspaces,
  readWorkspacesForProject,
  registerWorkspace,
  freezeWorkspace,
  selectDevWorkspace,
  pointTrialWorkspace,
} from "file://__REPO__/src/server/work/workspaces";
import { installWorkspaceHostWiring } from "file://__REPO__/src/server/work/hostWiring";
import { handleReportingRequest } from "file://__REPO__/src/server/work/reportingHost";
import { submitSelfCheck, submitIndependentAudit, COVERAGE_AREAS, COVERAGE_AREA_LABELS } from "file://__REPO__/src/server/work/audit";
import { openFinding, readFindings } from "file://__REPO__/src/server/work/evidence";
import { readFeatureLedger } from "file://__REPO__/src/server/work/featureLedger";

const home = process.argv[2]!;
const out = process.argv[3]!;
const fixtureRoot = process.argv[4]!;
process.env.TATAI_HOME = home;

const CHANGE = "change-v0967";
const COORD = "v0967-coord";
const EXEC = "v0967-exec";
const AUDITOR = "v0967-auditor";
const TASK = "V09-67";
const CAP = "cap-v0967";

const sha256 = (b: string): string => crypto.createHash("sha256").update(b, "utf8").digest("hex");
const write = (f: string, text: string): void => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
};

// ── 合法完整功能声明（DESIGN 声明区 + PLAN 卡/映射/交付核对声明/集成检查要求） ──
const DECL_HEAD = [
  "| 功能 ID | 人话功能名 | 需求 ID | 设计章节 | 本期范围（scope_id） | 覆盖结论 | 依据/缺口（review） | 使用结果与场景 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
];
const designDraft = [
  "# 设计书",
  "",
  "### 3.16 交付总览（夹具）",
  "",
  "正文：交付总览按明确版本只读派生。",
  "",
  "## 功能清单声明（夹具）",
  "",
  DECL_HEAD[0],
  DECL_HEAD[1],
  `| ${CAP} | 交付总览版本一致 | req-v0967 | §3.16 | ${CAP} | 已核对 | reviewer=审1; ref=.工作台/design.md#3.16; section_sha256=SECT; gap= | 夹具场景：切版本后结论一致 |`,
  "",
].join("\n");
const sectSha = buildSectionIndex(designDraft).find((s) => s.title.startsWith("3.16 "))?.sha256 ?? "";
const DESIGN = designDraft.replace("section_sha256=SECT", `section_sha256=${sectSha}`);
const PLAN = [
  "# 施工图",
  "",
  "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
  "| --- | --- | --- | --- | --- |",
  `| ${TASK} | todo | 交付总览版本一致 |  | 证据齐 |`,
  "",
  `### ${TASK} 交付总览版本一致`,
  "",
  "**设计依据**：§3.16。**依赖**：无。**文件责任**：`src/app.ts`。",
  "",
  "- [ ] **chk-v0967-01 完整功能范围核查**",
  "- [ ] **chk-v0967-02 交付总览版本一致达标**",
  "- [ ] **chk-v0967-03 非作者审查与问题收口**",
  "- [ ] **chk-v0967-04 运行交付版本核对**",
  "",
  "| 功能 ID | 人话功能名 | 承接卡 | 必需检查 | 集成检查 | 结果状态 |",
  "| --- | --- | --- | --- | --- | --- |",
  `| ${CAP} | 交付总览版本一致 | ${TASK} | chk-v0967-02 | int-v0967-01 | 未验 |`,
  "",
  "## 交付核对声明",
  "",
  "| 核对项 | 承接卡 | 检查 ID |",
  "| --- | --- | --- |",
  `| coverage | ${TASK} | chk-v0967-01 |`,
  `| review | ${TASK} | chk-v0967-03 |`,
  `| runtime | ${TASK} | chk-v0967-04 |`,
  "",
  "## 集成检查要求",
  "",
  "| 对象 ID | 检查 ID | 说明 | 必需性 |",
  "| --- | --- | --- | --- |",
  `| ${CAP} | int-v0967-01 | 端到端集成 | 必需 |`,
  "| project:delivery | int-project-delivery-01 | 交付集成 | 必需 |",
  "",
].join("\n");

const service = new WorkService({ dataDir: home });
installWorkspaceHostWiring();
const errors: string[] = [];
const notes: string[] = [];
const result: Record<string, unknown> = { errors, notes, fixtureRoot };
let workDirOf = (id: string): string => projectWorkDir(id, home);
const submitterFor = (id: string) => ({ submit: (c: unknown) => service.submit(c), read: () => readWorkspaces(workDirOf(id)) });

type Proj = { id: string; root: string; devRoot?: string; git: boolean };
const projects: Proj[] = [];

function mockReq(body: unknown): never {
  const req = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]) as never;
  (req as { method: string }).method = "POST";
  (req as { url: string }).url = "/api/work/reporting/evidence";
  (req as { headers: Record<string, string> }).headers = {};
  return req;
}
function mockRes(): { res: never; read: () => { status: number; body: unknown } } {
  const st = { status: 0, body: "" };
  const res = {
    setHeader: () => {},
    writeHead: (s: number) => { st.status = s; return res; },
    end: (v?: unknown) => { if (typeof v === "string") st.body = v; },
  };
  Object.defineProperty(res, "statusCode", { get: () => st.status, set: (s: number) => { st.status = s; } });
  return { res: res as never, read: () => ({ status: st.status, body: st.body === "" ? null : JSON.parse(st.body) }) };
}

function makeProject(p: Proj): void {
  try {
    write(path.join(p.root, ".工作台", "design.md"), DESIGN);
    write(path.join(p.root, ".工作台", "plan.md"), PLAN);
    write(path.join(p.root, "src", "app.ts"), "export const app = 1;\n");
    write(path.join(p.root, "README.md"), "# fixture\n");
    fs.mkdirSync(path.join(p.root, ".工作台", "work"), { recursive: true });
    if (p.git) {
      execFileSync("git", ["-C", p.root, "init", "-q", "-b", "main"]);
      execFileSync("git", ["-C", p.root, "config", "user.email", "fixture@v0967"]);
      execFileSync("git", ["-C", p.root, "config", "user.name", "v0967"]);
      execFileSync("git", ["-C", p.root, "add", "-A"], { stdio: "ignore" });
      execFileSync("git", ["-C", p.root, "commit", "-q", "-m", "fixture"]);
    }
    addProject({ id: p.id, name: p.id, path: p.root, kind: "backend" }, home);
    const sub = submitterFor(p.id);
    registerRequirement(sub as never, {
      project_id: p.id, requirement_id: "req-v0967", change_id: CHANGE, actor_id: "v0967-setup", role: "designer",
      source: { kind: "user", ref: "夹具用户 2026-10-09" }, problem: "夹具需求", users: [], success_scenarios: [], exclusions: [],
      priority: "P1", status: "explicit",
    });
    submitDefinitionImports(service, {
      project_id: p.id, change_id: CHANGE, actor_id: "v0967-setup", role: "coordinator",
      definitions: importTaskDefinitions(PLAN, { plan_revision: sha256(PLAN) }).definitions,
    });
    activateBaseline(p.id, { approved_by: "user", approval_basis: "V09-67 隔离夹具审定（不代表真实用户 Gate）", approval_kind: "user_confirmed" }, home);
  } catch (e) {
    errors.push(`project ${p.id}: ${(e as Error).message}`);
  }
}

/** 源清单证据（真宿主存证）+ 作者自检 + 非作者独立审查；供交付核对与试用提升共用 */
async function seedEvidence(projectId: string, workspaceId: string | null, rootFiles: string[]): Promise<{ evid: string; fp: string }> {
  const { res, read } = mockRes();
  await handleReportingRequest(
    mockReq({
      project_id: projectId, workspace_id: workspaceId ?? undefined, content: "", kind: "source_manifest",
      summary: "候选源清单（夹具）", created_by: EXEC, role: "executor",
      binding: { revision_kind: "code", revision: "rev-x" }, source_manifest: rootFiles.map((p) => ({ path: p })),
    }),
    res,
    { pathname: "/api/work/reporting/evidence", dataDir: home },
  );
  const body = read().body as { ok?: boolean; evidence?: { evidence_id: string; source_manifest?: { fingerprint: string } } };
  const evid = body?.evidence?.evidence_id ?? "";
  const fp = body?.evidence?.source_manifest?.fingerprint ?? "";
  if (!evid || !fp) {
    errors.push(`evidence ${projectId}/${workspaceId}: 存证失败 ` + JSON.stringify(body).slice(0, 300));
    console.error("EVIDENCE-FAIL", projectId, workspaceId, JSON.stringify(body).slice(0, 400));
  }
  return { evid, fp };
}

function seedChecks(projectId: string, evid: string, fp: string): void {
  const objects: Record<string, string> = {
    "chk-v0967-01": TASK, "chk-v0967-02": TASK, "chk-v0967-03": TASK, "chk-v0967-04": TASK,
    [`${TASK}::evidence`]: TASK, "int-v0967-01": CAP, "int-project-delivery-01": "project:delivery",
  };
  const sub = submitterFor(projectId);
  for (const [c, objectId] of Object.entries(objects)) {
    const sc = submitSelfCheck(sub as never, {
      project_id: projectId, change_id: CHANGE, actor_id: EXEC, role: "executor", record_id: `sc-${c}`,
      task_id: objectId, checked_by: EXEC, conclusion: "pass",
      binding: { revision_kind: "code", revision: fp },
      checks: [{ check_id: c, method: "夹具定向检查", command: null, exit_code: null, evidence_sha256: evid, scope: [], verifies: "code" }],
    });
    const ia = submitIndependentAudit(sub as never, {
      project_id: projectId, change_id: CHANGE, actor_id: AUDITOR, role: "auditor", record_id: `ia-${c}`,
      task_id: objectId, auditor: AUDITOR, author_id: EXEC, conclusion: "pass",
      binding: { revision_kind: "code", revision: fp },
      checks: [{ check_id: c, result: "passed", evidence_sha256: evid, scope: [] }],
      coverage: COVERAGE_AREAS.map((a) => ({ area: a, status: "checked" as const, basis: `${COVERAGE_AREA_LABELS[a]}：夹具已独立复核` })),
    });
    if (!sc.ok || !ia.ok) errors.push(`checks ${projectId}/${c}: sc=${sc.ok} ia=${ia.ok}`);
  }
}

function led(projectId: string, params: Record<string, unknown>): unknown {
  const r = readFeatureLedger(projectId, home, params as never, { project_exists: (x) => projects.some((p) => p.id === x) });
  if (!r.ok) return { ok: false, status: r.status, code: r.code, message: r.message };
  const d = r.ledger.delivery;
  return {
    ok: true, state: d?.state, summary: d?.summary,
    workspace: r.ledger.workspace, doc_mode: r.ledger.document_selection?.mode,
    selection: r.ledger.document_selection,
    counts: d?.counts,
    gates: d?.gates?.map((g) => ({ id: g.id, state: g.state, missing: g.missing })),
    integration: { state: d?.integration?.state, missing: d?.integration?.missing },
    version: d?.version,
    blockers: d?.blockers?.map((b) => `${b.kind}:${b.message}`),
  };
}

// ════════ 甲：真绿项目（无登记试用版 ⇒ 默认按活动主目录读，真 ready_for_trial） ════════
const GREEN = { id: "p-v0967g", root: path.join(fixtureRoot, "green"), devRoot: path.join(fixtureRoot, "green-dev"), git: true };
projects.push(GREEN);
makeProject(GREEN);
{
  const sub = submitterFor(GREEN.id);
  const wsDir = path.join(GREEN.devRoot!);
  write(path.join(wsDir, ".工作台", "design.md"), DESIGN);
  write(path.join(wsDir, ".工作台", "plan.md"), PLAN);
  write(path.join(wsDir, "src", "app.ts"), "export const app = 1;\n");
  write(path.join(wsDir, "README.md"), "# fixture\n");
  const reg = registerWorkspace(sub, {
    project_id: GREEN.id, workspace_id: "ws-green-dev", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    kind: "dev", purpose: "开发区（夹具）", root: wsDir, source_kind: "directory",
  });
  if (!reg.ok) errors.push(`register green-dev: ${reg.code} ${reg.message}`);
  const { evid, fp } = await seedEvidence(GREEN.id, "ws-green-dev", ["src/app.ts", "README.md"]);
  seedChecks(GREEN.id, evid, fp);
  const ptr = readWorkspaces(workDirOf(GREEN.id)).pointer;
  const sd = selectDevWorkspace(sub, {
    project_id: GREEN.id, workspace_id: "ws-green-dev", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    expected_revision: ptr?.revision ?? 0, basis: "夹具：开发指针",
  });
  if (!sd.ok) errors.push(`select_dev green: ${sd.code} ${sd.message}`);
  result.greenPointer = readWorkspaces(workDirOf(GREEN.id)).pointer;
  result.greenLedger = led(GREEN.id, {});
  result.greenDevLedger = led(GREEN.id, { workspace: "dev" });
}

// ════════ 乙：工作区/试用提升生命周期项目（dev + 候选 + 真实证据 → 提升） ════════
const WS = { id: "p-v0967", root: path.join(fixtureRoot, "p-main"), git: true };
const TRIAL_ROOT = path.join(fixtureRoot, "roots", "trial");
const DEV_ROOT = path.join(fixtureRoot, "roots", "dev");
projects.push(WS);
makeProject(WS);
for (const r of [TRIAL_ROOT, DEV_ROOT]) {
  write(path.join(r, ".工作台", "design.md"), DESIGN);
  write(path.join(r, ".工作台", "plan.md"), PLAN);
  write(path.join(r, "src", "app.ts"), "export const app = 1;\n");
  write(path.join(r, "README.md"), "# fixture\n");
}
{
  const sub = submitterFor(WS.id);
  const regT = registerWorkspace(sub, {
    project_id: WS.id, workspace_id: "ws-trial", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    kind: "trial", purpose: "固定试用候选（夹具）", root: TRIAL_ROOT, source_kind: "directory", task_ids: [TASK],
  });
  const regD = registerWorkspace(sub, {
    project_id: WS.id, workspace_id: "ws-dev", change_id: CHANGE, actor_id: COORD, role: "coordinator",
    kind: "dev", purpose: "隔离开发区（夹具）", root: DEV_ROOT, source_kind: "directory",
  });
  if (!regT.ok) errors.push(`register ws-trial: ${regT.code} ${regT.message}`);
  if (!regD.ok) errors.push(`register ws-dev: ${regD.code} ${regD.message}`);

  // ⓪ 冻结候选（宿主现读内容指纹 + 配套 DESIGN/PLAN 内容哈希 + 真实 baseline）
  {
    const rec = readWorkspaces(workDirOf(WS.id)).workspaces["ws-trial"];
    const fr = freezeWorkspace(sub, {
      project_id: WS.id, workspace_id: "ws-trial", change_id: CHANGE, actor_id: COORD, role: "coordinator",
      expected_revision: rec.revision, included_uncommitted: false, declared_paths: [],
    });
    if (!fr.ok) errors.push(`freeze ws-trial: ${fr.code} ${fr.message}`);
  }

  // ① 未验提升 → 真拒 + 旧指针保留
  {
    const ptr = readWorkspaces(workDirOf(WS.id)).pointer;
    const rej = pointTrialWorkspace(sub, {
      project_id: WS.id, workspace_id: "ws-trial", change_id: CHANGE, actor_id: COORD, role: "coordinator",
      expected_revision: ptr?.revision ?? 0, basis: "夹具：未验提升（应拒）",
    });
    result.pointReject = { ok: rej.ok, code: rej.ok ? null : rej.code, message: rej.message };
    result.pointerAfterReject = readWorkspaces(workDirOf(WS.id)).pointer?.current_trial_workspace_id ?? null;
  }

  // ② 真证据（源清单 + 自检 + 非作者独审）
  const { evid, fp } = await seedEvidence(WS.id, "ws-trial", ["src/app.ts", "README.md"]);
  seedChecks(WS.id, evid, fp);
  result.evidence = { evidence_id: evid, fingerprint: fp };

  // ③ 已验版本提升 → 成功
  {
    const ptr = readWorkspaces(workDirOf(WS.id)).pointer;
    const acc = pointTrialWorkspace(sub, {
      project_id: WS.id, workspace_id: "ws-trial", change_id: CHANGE, actor_id: COORD, role: "coordinator",
      expected_revision: ptr?.revision ?? 0, basis: "夹具：已验版本提升",
    });
    result.pointAccept = { ok: acc.ok, code: acc.ok ? null : acc.code, message: acc.message };
  }
  // ④ 设开发指针（保留试用指针）
  {
    const ptr = readWorkspaces(workDirOf(WS.id)).pointer;
    const sd = selectDevWorkspace(sub, {
      project_id: WS.id, workspace_id: "ws-dev", change_id: CHANGE, actor_id: COORD, role: "coordinator",
      expected_revision: ptr?.revision ?? 0, basis: "夹具：开发指针",
    });
    if (!sd.ok) errors.push(`select_dev ws: ${sd.code} ${sd.message}`);
  }
  result.pointer = readWorkspaces(workDirOf(WS.id)).pointer;
  result.views = readWorkspacesForProject(WS.id, home);
  const frozen = readWorkspaces(workDirOf(WS.id)).workspaces["ws-trial"];
  result.frozen = { status: frozen.status, content_fingerprint: frozen.freeze?.content_fingerprint ?? null, version_binding: frozen.freeze?.version_binding ?? null, task_ids: frozen.task_ids };

  result.ledgerDefault = led(WS.id, {});
  result.ledgerTrial = led(WS.id, { workspace: "ws-trial" });
  result.ledgerDev = led(WS.id, { workspace: "dev" });

  // ⑤ dev 变更（源码 + 设计/施工之一）：固定候选不应变红；dev 视图读新根
  write(path.join(DEV_ROOT, "src", "app.ts"), "export const app = 2; // dev change\n");
  write(path.join(DEV_ROOT, ".工作台", "plan.md"), PLAN + "\n<!-- dev 后续修改（夹具） -->\n");
  write(path.join(DEV_ROOT, ".工作台", "design.md"), DESIGN + "\n<!-- dev 后续修改（夹具） -->\n");
  result.ledgerTrialAfterDev = led(WS.id, { workspace: "ws-trial" });
  result.ledgerDevAfterDev = led(WS.id, { workspace: "dev" });
}

// ════════ 丙：无工作区登记项目（旧 current/active 语义） ════════
const LEGACY = { id: "p-v0967-legacy", root: path.join(fixtureRoot, "legacy"), git: false };
projects.push(LEGACY);
makeProject(LEGACY);

result.fixture = {
  green: { id: GREEN.id, root: GREEN.root, devRoot: GREEN.devRoot },
  ws: { id: WS.id, root: WS.root, trialRoot: TRIAL_ROOT, devRoot: DEV_ROOT },
  legacy: { id: LEGACY.id, root: LEGACY.root },
};
result.projectIds = projects.map((p) => p.id);
fs.writeFileSync(out, JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify({
  ok: errors.length === 0, errors,
  green: (result.greenLedger as { state?: string })?.state,
  wsDefault: (result.ledgerDefault as { state?: string })?.state,
  wsTrial: (result.ledgerTrial as { state?: string })?.state,
  wsDev: (result.ledgerDev as { state?: string })?.state,
  wsTrialAfterFail: (result.ledgerTrialAfterFail as { state?: string })?.state,
}));
'''


def _seed_script(tmp: Path) -> Path:
    # `.mts` ⇒ ESM（夹具用了顶层 await；临时目录在仓库外，没有 package.json 说明模块类型）
    seed_path = tmp / "seed.mts"
    seed_path.write_text(SEED_TS.replace("__REPO__", REPO.as_posix()), "utf8")
    return seed_path


# ⑥ 对旧候选追记**真实阻断缺陷**（真宿主唯一写口，独立进程；用于验「同版读数必须真变色」）
FAULT_TS = r'''
import fs from "node:fs";
import { WorkService } from "file://__REPO__/src/server/work/service";
import { projectWorkDir } from "file://__REPO__/src/server/workstation";
import { openFinding, readFindings } from "file://__REPO__/src/server/work/evidence";
const home = process.argv[2]!;
const projectId = process.argv[3]!;
const taskId = process.argv[4]!;
const evidenceId = process.argv[5] ?? "";
process.env.TATAI_HOME = home;
const service = new WorkService({ dataDir: home });
const workDir = projectWorkDir(projectId, home);
const sub = { submit: (c: unknown) => service.submit(c), read: () => readFindings(workDir) };
const r = openFinding(sub as never, {
  project_id: projectId, change_id: "change-v0967-fail", actor_id: "v0967-auditor", role: "auditor",
  severity: "blocks_core_goal", source: "夹具：冻结后独立审计发现新缺陷",
  expected: "无未收口缺陷", actual: "发现阻断缺陷", repro: "夹具复现步骤",
  evidence_sha256: evidenceId, object_id: taskId,
});
console.log(JSON.stringify(r));
'''


def run_fault(tmp: Path, home: Path, project_id: str, task_id: str, evidence_id: str) -> dict:
    path = tmp / "fault.mts"
    path.write_text(FAULT_TS.replace("__REPO__", REPO.as_posix()), "utf8")
    proc = subprocess.run(
        [node_exe()[0], "node_modules/tsx/dist/cli.mjs", str(path), str(home), project_id, task_id, evidence_id],
        cwd=str(REPO), capture_output=True, text=True, timeout=120,
    )
    print("     [fault]", (proc.stdout or "").strip()[-200:], flush=True)
    if proc.returncode != 0:
        print(proc.stderr.strip()[-1500:], flush=True)
    return {"returncode": proc.returncode}



def seed(tmp: Path, home: Path) -> dict:
    home.mkdir(parents=True, exist_ok=True)
    out = tmp / "seed-result.json"
    proc = subprocess.run(
        [node_exe()[0], "node_modules/tsx/dist/cli.mjs", str(_seed_script(tmp)), str(home), str(out), str(tmp / "fixture")],
        cwd=str(REPO), capture_output=True, text=True, timeout=300,
    )
    print(proc.stdout.strip()[-1500:], flush=True)
    if proc.returncode != 0 or not out.exists():
        print(proc.stderr.strip()[-4000:], flush=True)
        raise RuntimeError("夹具写入失败（见上）")
    return json.loads(out.read_text("utf8"))


def node_exe() -> list[str]:
    return [shutil.which("node") or "node"]


# ─────────────────────────── 浏览器内拦截（可控夹具；默认透传真服务） ───────────────────────────

INIT_JS = r"""
window.__V967 = { calls: [], ctl: {} };
(function () {
  var orig = window.fetch;
  function lookup(box, kind, ws, cursor) {
    var keys = [
      kind + "|" + (ws || "") + "|" + (cursor || ""),
      kind + "|" + (ws || ""),
      kind,
    ];
    for (var i = 0; i < keys.length; i++) if (box[keys[i]]) return box[keys[i]];
    return null;
  }
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url ? input.url : String(input));
    var m = /\/api\/projects\/([^/?#]+)\/(workspaces|feature-ledger)(\?[^#]*)?/.exec(url);
    if (!m) return orig.apply(this, arguments);
    var pid = decodeURIComponent(m[1]);
    var kind = m[2];
    var q = m[3] || "";
    var wsm = /[?&]workspace=([^&]*)/.exec(q);
    var cm = /[?&]cursor=([^&]*)/.exec(q);
    var ws = wsm ? decodeURIComponent(wsm[1]) : null;
    var cursor = cm ? decodeURIComponent(cm[1]) : null;
    window.__V967.calls.push({
      pid: pid, kind: kind, url: url, ws: ws, cursor: cursor,
      revision: (/[?&]expected_revision=([^&]*)/.exec(q) || [])[1] || null,
      t: Math.round(performance.now()),
    });
    var box = window.__V967.ctl[pid] || {};
    var ctl = lookup(box, kind, ws, cursor);
    if (!ctl) return orig.apply(this, arguments);
    var delay = ctl.delayMs || 0;
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (ctl.fail > 0) {
          ctl.fail = ctl.fail - 1;
          reject(new TypeError("Failed to fetch"));
          return;
        }
        if (ctl.status || ctl.body !== undefined) {
          var payload = ctl.body === undefined ? {} : ctl.body;
          resolve(new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
            status: ctl.status || 200, headers: { "content-type": "application/json" },
          }));
          return;
        }
        resolve(orig.apply(window, [input, init]));
      }, delay);
    });
  };
})();
"""


# ─────────────────────────── 夹具账本（固定 API 契约，只作显式 UI 故障夹具） ───────────────────────────

NOW = "2026-10-09T03:00:00.000Z"


def feature_item(i: int, ws_id: str) -> dict:
    return {
        "item_id": f"cap-v{i}",
        "scope_id": "project:delivery",
        "scope_revision": "rev-1",
        "display_name": f"夹具功能{i}",
        "user_description": f"夹具功能{i}的说明",
        "scenario": f"用在夹具场景{i}",
        "requirement_refs": [{"requirement_id": f"req-v{i}", "certainty": "explicit", "source_ref": "REQUEST.txt"}],
        "design_section_refs": [{"anchor": "design-1", "title": "夹具设计", "line": 3, "status": "located", "hash": "sec-1"}],
        "design_coverage": {
            "state": "已核对",
            "review": {"reviewer": "codex", "ref": "基线 bl-1", "ref_kind": "baseline", "section_sha256": "sec-1", "unmet": None},
            "gap": None,
        },
        "implementation": {"state": "result_submitted", "basis": "seq 1"},
        "verification": {
            "display_status": "verified", "evidence_state": "verified",
            "required_count": 1, "passed_count": 1, "missing": [],
            "effective_version": "pkg-v1",
            "evidence_entry": [{"check_id": f"chk-v{i}", "effective": "passed", "evidence_ref": f"ev-v{i}"}],
        },
        "user_acceptance": {"state": "pending", "scope_tasks": [f"task-v{i}"], "accepted_tasks": [], "gate_ref": None, "unmet": "等你决定"},
        "pending_decisions": [],
        "task_refs": [{"task_id": f"task-v{i}", "definition_fingerprint": "fp-1"}],
        "provenance": {"extraction": "declared", "unmapped": [], "pending_leads": [], "derivation": {"design_revision": "a1", "plan_revision": "b2", "plan_definition": "d3", "ledger_last_seq": 1}},
        "agent_review": {"state": "passed", "required_count": 1, "passed_count": 1, "missing": [], "evidence": []},
    }


def delivery_of(state: str, features: int, ws_id: str | None, ws_root: str | None, fingerprint: str | None) -> dict:
    return {
        "state": state,
        "summary": f"夹具服务端结论（{state}）",
        "scope": "project",
        "counts": {
            "features": features, "design_checked": features, "verified": features, "reviewed": features,
            "requirements": features, "mapped_requirements": features, "pending_requirements": 0,
            "candidates": 0, "formal_requirements": features, "registered_candidates": 0,
        },
        "gates": [
            {"id": "coverage", "label": "完整功能范围核查", "state": "passed", "check_ids": [], "missing": [], "evidence": []},
            {"id": "review", "label": "Agent 审查与问题收口", "state": "passed", "check_ids": [], "missing": [], "evidence": []},
            {"id": "runtime", "label": "运行交付版本核对", "state": "passed", "check_ids": [], "missing": [], "evidence": []},
        ],
        "version": {
            "design_revision": "a" * 64, "plan_revision": "b" * 64, "baseline_id": "bl-fixture",
            "ledger_last_seq": 1, "drift": None,
            "workspace_id": ws_id, "workspace_root": ws_root, "content_fingerprint": fingerprint,
        },
        "user_acceptance": {"pending": features, "accepted": 0, "rejected": 0, "accepted_known_limit": 0},
        "blockers": [],
        "integration": {"state": "passed", "check_ids": [], "missing": [], "evidence": []},
    }


def ledger_stub(n: int, ws_id: str | None, ws_root: str | None, *, paging: dict | None = None,
                workspace_field: bool = True, state: str = "ready_for_trial", package: str = "pkg-v1") -> dict:
    items = [feature_item(i + 1, ws_id or "main") for i in range(n)]
    ledger = {
        "state": "ok",
        "scope_id": "project:delivery",
        "scope_revision": "rev-1",
        "package_revision": package,
        "package_revision_basis": ["DESIGN@a1", "PLAN@b2", "ledger@1"],
        "document_selection": {
            "requested": "active", "mode": "active", "design_revision": "a1", "plan_revision": "b2",
            "plan_definition": "d3", "baseline_id": "bl-fixture", "drift": None,
        },
        "artifact_ref": None,
        "artifact_selection": None,
        "generated_at": NOW,
        "source_revision": {"design": "a1", "plan": "b2", "ledger_last_seq": 1},
        "coverage": {
            "examined_sources": [{"ref": "DESIGN.md", "kind": "design"}], "unexamined_sources": [],
            "registered_requirement_count": n, "mapped_count": n, "pending_count": 0,
            "unregistered_candidate_count": 0, "source_complete": True,
        },
        "items": items,
        "paging": paging or {"complete": True, "cursor": None},
        "delivery": delivery_of(state, n, ws_id, ws_root, (f"fp-{ws_id}" if ws_id else None)),
    }
    if workspace_field:
        ledger["workspace"] = {
            "requested": ws_id, "workspace_id": ws_id,
            "kind": "trial" if (ws_id or "").endswith("trial") else "dev",
            "root": ws_root, "source_commit": None,
            "content_fingerprint": (f"fp-{ws_id}" if ws_id else None), "status": "frozen",
            "resolved": ws_id is not None,
            "reason": None if ws_id is not None else "夹具：未解析到明确工作区",
        }
    return {"ok": True, "ledger": ledger}


# ─────────────────────────── 浏览器辅助 ───────────────────────────


def wait_true(page, expr: str, timeout_ms: int = 15000, interval_ms: int = 120) -> bool:
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        try:
            if page.evaluate(f"Boolean(({expr}))"):
                return True
        except Exception:  # noqa: BLE001
            pass
        page.wait_for_timeout(interval_ms)
    return False


def set_ctl(page, pid: str, box: dict) -> None:
    page.evaluate("(a) => { window.__V967.ctl[a[0]] = a[1]; }", [pid, box])


def picker(page, name: str) -> str | None:
    return page.evaluate(
        "(n) => { const e = document.querySelector('[data-delivery-version-picker]'); return e ? e.getAttribute(n) : null; }",
        name,
    )


def text_of(page, selector: str) -> str:
    return page.evaluate("(s) => { const e = document.querySelector(s); return e ? e.textContent : ''; }", selector) or ""


def open_delivery(page, pid: str) -> None:
    page.evaluate("(p) => { window.location.hash = '#p/' + p; }", pid)
    page.wait_for_selector("[data-main-nav] [data-view='delivery']", timeout=20000)
    page.click("[data-main-nav] [data-view='delivery']")
    page.wait_for_selector("[data-delivery-overview]", timeout=20000)
    wait_true(page, "document.querySelector('[data-delivery-version-picker][data-scope-pending=\"0\"]')", 25000)


def state_of(page) -> str:
    return page.evaluate(
        "() => { const e = document.querySelector('[data-delivery-overview]'); return e ? e.getAttribute('data-delivery-state') : ''; }"
    )


def calls(page, pid: str | None = None, kind: str | None = None) -> list:
    return page.evaluate(
        "(a) => window.__V967.calls.filter((c) => (!a[0] || c.pid === a[0]) && (!a[1] || c.kind === a[1]))",
        [pid, kind],
    )


def ws_of(read: dict) -> dict:
    return (read or {}).get("workspace") or {}


# ─────────────────────────── 主流程 ───────────────────────────


def main() -> int:  # noqa: C901
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="tatai-v0967-"))
    home = tmp / "home"
    home.mkdir(parents=True, exist_ok=True)

    j = seed(tmp, home)
    fx = j.get("fixture") or {}
    t_root = (fx.get("ws") or {}).get("trialRoot")
    d_root = (fx.get("ws") or {}).get("devRoot")
    g_root = (fx.get("green") or {}).get("root")
    gd_root = (fx.get("green") or {}).get("devRoot")

    check(not j.get("errors"), "夹具写入（真实写口：3 项目 + 需求/定义/基线 + 工作区登记/冻结/提升 + 真证据）", j.get("errors"))
    check((j.get("pointReject") or {}).get("code") == "PROMOTION_UNVERIFIED",
          "① 未验候选提升**真拒** PROMOTION_UNVERIFIED", (j.get("pointReject") or {}).get("code"))
    check(j.get("pointerAfterReject") is None, "① 未验拒绝后旧试用指针保留（仍为空）", j.get("pointerAfterReject"))
    check((j.get("pointAccept") or {}).get("ok") is True, "② 真技术+独审事实齐备后 point_trial 成功", (j.get("pointAccept") or {}).get("message"))
    ptr = j.get("pointer") or {}
    check(ptr.get("current_trial_workspace_id") == "ws-trial" and ptr.get("current_dev_workspace_id") == "ws-dev",
          "② 双指针并存（试用 ws-trial / 开发 ws-dev；不被整条替换清空）", ptr)
    frozen = j.get("frozen") or {}
    vb = frozen.get("version_binding") or {}
    check(frozen.get("status") == "frozen" and len(str(vb.get("design_sha256") or "")) == 64 and len(str(vb.get("plan_sha256") or "")) == 64,
          "② 冻结记录绑定同一版本的 DESIGN/PLAN 内容哈希 + baseline", vb)
    ev = j.get("evidence") or {}
    check(len(str(ev.get("evidence_id") or "")) == 64 and len(str(ev.get("fingerprint") or "")) == 64,
          "② 源清单证据经真实宿主唯一写入口存证（内容寻址 + 指纹）", f"{str(ev.get('evidence_id'))[:12]}…")

    backend_port = free_port()
    vite_port = free_port()
    backend = None
    vite = None
    browser = None
    pw = None
    try:
        backend_log = open(OUT / "ui-backend.log", "a", encoding="utf-8")
        vite_log = open(OUT / "ui-vite.log", "a", encoding="utf-8")
        backend = subprocess.Popen(
            node_exe() + ["--import", "tsx", "src/server/index.ts"],
            cwd=str(REPO), env={**os.environ, "TATAI_HOME": str(home), "TATAI_PORT": str(backend_port)},
            stdout=backend_log, stderr=backend_log,
        )
        wait_http(f"http://127.0.0.1:{backend_port}/health", 240, "后端")
        note(f"后端就绪 127.0.0.1:{backend_port}（TATAI_HOME={home}）")

        vite = subprocess.Popen(
            node_exe() + ["node_modules/vite/bin/vite.js", "dev", "--port", str(vite_port), "--strictPort", "--host", "127.0.0.1"],
            cwd=str(REPO),
            env={**os.environ, "TATAI_DEV_API_PORT": str(backend_port), "TATAI_VITE_CACHE_DIR": str(tmp / "vite-cache")},
            stdout=vite_log, stderr=vite_log,
        )
        wait_http(f"http://127.0.0.1:{vite_port}/", 300, "vite")
        note(f"vite 就绪 http://127.0.0.1:{vite_port}")

        base = f"http://127.0.0.1:{vite_port}"
        api_g = f"http://127.0.0.1:{backend_port}/api/projects/{PID_GREEN}"
        api_w = f"http://127.0.0.1:{backend_port}/api/projects/{PID_WS}"
        api_l = f"http://127.0.0.1:{backend_port}/api/projects/{PID_LEGACY}"

        # ───────────────── 真服务面（甲：真绿） ─────────────────
        st, led_g = http_json(f"{api_g}/feature-ledger")
        check(st == 200 and isinstance(led_g, dict) and led_g.get("ok") is True, "真服务：甲 默认 feature-ledger 200", f"HTTP {st}")
        lg = (led_g or {}).get("ledger") or {}
        dg = lg.get("delivery") or {}
        check(dg.get("state") == "ready_for_trial", "③ 真绿：甲 默认交付读数**真正 ready_for_trial**", dg.get("state"))
        cg = dg.get("counts") or {}
        check(cg.get("features", 0) > 0 and cg.get("verified") == cg.get("features") and cg.get("reviewed") == cg.get("features"),
              "③ 真绿：全部正式功能技术验证 + 非作者审查通过", f"{cg.get('verified')}/{cg.get('features')}")
        check(all((g or {}).get("state") == "passed" for g in (dg.get("gates") or [])) and len(dg.get("gates") or []) == 3,
              "③ 真绿：三类交付核对全 passed", [(g or {}).get("id") for g in (dg.get("gates") or [])])
        check((dg.get("integration") or {}).get("state") == "passed", "③ 真绿：project:delivery 集成核对 passed", (dg.get("integration") or {}).get("state"))
        check("可以开始人工试用" in str(dg.get("summary") or ""), "③ 真绿：结论＝可以开始人工试用", str(dg.get("summary"))[:60])
        check(ws_of(lg).get("resolved") is False, "③ 甲 未登记试用版 ⇒ 默认按活动主目录旧语义（不臆造工作区参数）", ws_of(lg))
        st, led_gd = http_json(f"{api_g}/feature-ledger?document=active&workspace=dev")
        lgd = (led_gd or {}).get("ledger") or {}
        check(st == 200 and ws_of(lgd).get("workspace_id") == "ws-green-dev",
              "③ 甲 workspace=dev 明确读开发区（workspace_id 真透传）", ws_of(lgd).get("workspace_id"))
        check((ws_of(lgd).get("root") or "") == gd_root, "③ 甲 workspace=dev 读到的根＝登记的开发区根", ws_of(lgd).get("root"))

        # ───────────────── 真服务面（乙：工作区/试用提升） ─────────────────
        st, view = http_json(f"{api_w}/workspaces")
        check(st == 200 and isinstance(view, dict), "真服务工作区读口可用（GET …/workspaces）", f"HTTP {st}")
        pointer = (view or {}).get("pointer") or {}
        ids = [w.get("workspace_id") for w in (view or {}).get("workspaces") or []]
        check(pointer.get("current_trial_workspace_id") == "ws-trial", "乙：当前试用候选指针＝ws-trial", pointer.get("current_trial_workspace_id"))
        check(pointer.get("current_dev_workspace_id") == "ws-dev", "乙：当前开发工作区指针＝ws-dev", pointer.get("current_dev_workspace_id"))
        check("ws-trial" in ids and "ws-dev" in ids, "乙：两个工作区版本都在读口里", ",".join(str(i) for i in ids))
        t_root_reg = next((w.get("root") for w in view["workspaces"] if w.get("workspace_id") == "ws-trial"), None)
        d_root_reg = next((w.get("root") for w in view["workspaces"] if w.get("workspace_id") == "ws-dev"), None)

        st, led_w = http_json(f"{api_w}/feature-ledger")
        check(st == 200 and isinstance(led_w, dict) and led_w.get("ok") is True, "乙：默认 feature-ledger 200（＝当前试用候选）", f"HTTP {st}")
        lw = (led_w or {}).get("ledger") or {}
        check(ws_of(lw).get("workspace_id") == "ws-trial", "乙：默认读到的就是已登记的固定试用版", ws_of(lw).get("workspace_id"))
        check((ws_of(lw).get("root") or "") == t_root_reg, "乙：默认读到的根＝登记的试用根", ws_of(lw).get("root"))
        st, led_wt = http_json(f"{api_w}/feature-ledger?document=active&workspace=ws-trial")
        lwt = (led_wt or {}).get("ledger") or {}
        check(st == 200 and ws_of(lwt).get("workspace_id") == "ws-trial", "④ 显式 workspace=ws-trial 与默认读同一版本", ws_of(lwt).get("workspace_id"))
        check(ws_of(lwt).get("root") == ws_of(lw).get("root") and ws_of(lwt).get("content_fingerprint") == ws_of(lw).get("content_fingerprint"),
              "④ 显式与默认的 workspace_id/root/内容指纹真的一致", f"{ws_of(lwt).get('content_fingerprint')}")
        st, led_wd = http_json(f"{api_w}/feature-ledger?document=active&workspace=dev")
        lwd = (led_wd or {}).get("ledger") or {}
        check(st == 200 and ws_of(lwd).get("workspace_id") == "ws-dev" and (ws_of(lwd).get("root") or "") == d_root_reg,
              "④ 开发视图明确读当前开发工作区（切开发读新根）", f"{ws_of(lwd).get('workspace_id')} @ {ws_of(lwd).get('root')}")
        st_bad, _bad = http_json(f"{api_w}/feature-ledger?document=active&workspace=ws-does-not-exist")
        check(st_bad == 400, "④ 未知工作区参数 ⇒ 400（路由**真透传** workspace，不是被白名单丢掉）", f"HTTP {st_bad}")
        dg2 = lw.get("delivery") or {}
        cg2 = dg2.get("counts") or {}
        check(cg2.get("features", 0) > 0 and cg2.get("verified") == cg2.get("features") and cg2.get("reviewed") == cg2.get("features"),
              "④ 试用版功能面真实全绿（真服务派生；与所选版本同源）", f"verified {cg2.get('verified')}/{cg2.get('features')}")
        check(all((g or {}).get("state") == "passed" for g in (dg2.get("gates") or [])) and len(dg2.get("gates") or []) == 3,
              "④ 试用版三类交付核对全 passed（真服务派生）", [(g or {}).get("state") for g in (dg2.get("gates") or [])])
        check(("ws-trial" == (dg2.get("version") or {}).get("workspace_id")) and ((dg2.get("version") or {}).get("workspace_root") or "") == t_root_reg,
              "④ 交付读数标出所读 workspace_id/root（与请求一致）", dg2.get("version"))

        # ───────────────── 缺陷断言：固定试用版应当真绿、且真实失败必须让它变色 ─────────────────
        def _blk(d: dict) -> list:
            return [f"{(b or {}).get('kind')}:{(b or {}).get('message')}" for b in (d.get("blockers") or [])]

        d_before = {**dg2, "blockers": _blk(dg2)}
        d_trial = {**((lwt.get("delivery") or {})), "blockers": _blk(lwt.get("delivery") or {})}
        d_trial_dev = (j.get("ledgerTrialAfterDev") or {})
        d_dev_after = (j.get("ledgerDevAfterDev") or {})
        check(j.get("greenLedger", {}).get("state") == "ready_for_trial",
              "夹具自检：甲（活动主目录）真绿（对照基线）", (j.get("greenLedger") or {}).get("state"))
        check(d_before.get("state") == "ready_for_trial",
              "⑤ 固定试用版（已验版本）默认读数应为 ready_for_trial（真绿）",
              f"实际 state={d_before.get('state')}；blockers={d_before.get('blockers')}（模式 {lw.get('document_selection', {}).get('mode')}）", defect=True)
        check(not any("version" in str(b) for b in (d_before.get("blockers") or [])),
              "⑤ 固定试用版不应被当作「版本不可信」而早退为未知",
              d_before.get("blockers"), defect=True)
        check(d_trial.get("state") == d_before.get("state"), "④ 显式 workspace=ws-trial 与默认读数同结论（同版一致）",
              f"默认 {d_before.get('state')} / 显式 {d_trial.get('state')}")
        check(d_trial_dev.get("state") == d_before.get("state") and d_trial_dev.get("doc_mode") == "frozen_candidate",
              "⑥ dev 变更（源码+设计/施工）后固定候选读数**不变**（不机械失效、也不消失）",
              f"{d_before.get('state')} -> {d_trial_dev.get('state')}")
        check(d_trial_dev.get("state") != "not_ready", "⑥ dev 变更后固定候选**不因开发目录变化变红**", d_trial_dev.get("state"))
        check((d_dev_after.get("selection") or {}).get("drift") is not None,
              "⑥ 开发视图如实反映现行稿与已批准基线的差异（真的读了新根/新稿）",
              str((d_dev_after.get("selection") or {}).get("drift"))[:80])

        # ⑥ 对旧候选追记**真实阻断缺陷**（独立进程 + 真宿主写口），再读同版读数
        f = run_fault(tmp, home, PID_WS, "V09-67", str(ev.get("evidence_id") or ""))
        check(f.get("returncode") == 0, "⑦ 追记真实阻断缺陷经真宿主唯一写口成功（零拒绝、零字节失败）", f)
        st, led_wf = http_json(f"{api_w}/feature-ledger?document=active&workspace=ws-trial")
        lwf = (led_wf or {}).get("ledger") or {}
        d_trial_fail = {**((lwf.get("delivery") or {})), "blockers": _blk(lwf.get("delivery") or {})}
        check(d_trial_fail.get("state") != d_trial_dev.get("state"),
              "⑦ 对旧候选追记真实阻断缺陷后，同版读数**必须变化**（不能锁死颜色）",
              f"{d_trial_dev.get('state')} -> {d_trial_fail.get('state')}", defect=True)
        check(any("f-" in str(b) or "blocking_finding" in str(b) for b in (d_trial_fail.get("blockers") or [])),
              "⑦ 追记的阻断缺陷必须逐条点名在 blockers 里",
              d_trial_fail.get("blockers"), defect=True)

        # ───────────────── 真浏览器 ─────────────────
        from playwright.sync_api import sync_playwright  # noqa: PLC0415

        pw = sync_playwright().start()
        launch_err: list[str] = []
        for channel in ("msedge", "chromium", None):
            try:
                browser = pw.chromium.launch(headless=True, **({} if channel is None else {"channel": channel}))
                note(f"浏览器：Playwright（channel={channel or '默认'}）")
                break
            except Exception as e:  # noqa: BLE001
                launch_err.append(f"{channel}: {e}")
        if browser is None:
            raise RuntimeError("浏览器起不来：" + " | ".join(launch_err))

        page = browser.new_page(viewport={"width": 1500, "height": 950})
        page.set_default_timeout(20000)
        page.add_init_script(INIT_JS)
        page_errors: list[str] = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.goto(f"{base}/#p/{PID_GREEN}")
        page.wait_for_selector("[data-delivery-overview]", timeout=40000)

        # ── 甲：默认真绿（截图可直观看到可试用绿色） ──
        open_delivery(page, PID_GREEN)
        check(picker(page, "data-scope-active") == "trial", "甲：默认停在「试用版」", picker(page, "data-scope-active"))
        check(picker(page, "data-scope-pending") == "0", "甲：工作区登记已落定（选择器可用）", picker(page, "data-scope-pending"))
        check(picker(page, "data-scope-legacy") == "1", "甲：未登记试用版 ⇒ 明确按活动主目录旧语义读", picker(page, "data-scope-legacy"))
        check(picker(page, "data-scope-param") == "", "甲：不臆造工作区参数（旧路径不带 workspace）", picker(page, "data-scope-param"))
        legacy_calls = [c for c in calls(page, PID_GREEN, "feature-ledger") if c.get("ws") is None]
        check(len(legacy_calls) >= 1, "甲：按不带 workspace 的旧路径读", f"{len(legacy_calls)} 次")
        check(wait_true(page, "document.querySelector('[data-delivery-overview]').getAttribute('data-delivery-state') === 'ready_for_trial'", 30000),
              "甲（真实浏览器）：默认视图状态＝ready_for_trial", state_of(page))
        check("可以开始人工试用" in text_of(page, "[data-delivery-conclusion]"),
              "(截图) 甲：默认结论＝可以开始人工试用（可直观看到可试用绿色）",
              text_of(page, "[data-delivery-conclusion]").strip()[:50])
        counts_g = text_of(page, "[data-delivery-counts]")
        check("正式功能" in counts_g, "甲：给出全范围正式功能计数", counts_g.strip()[:70])
        check(page.query_selector("[data-delivery-version-mismatch]") is None, "甲：无版本不一致告警")
        page.screenshot(path=str(OUT / "01-green-active.png"))

        # 甲：切开发（读开发区根）
        page.click('[data-delivery-scope-option="dev"]')
        check(wait_true(page, "document.querySelector('[data-delivery-version-picker]').getAttribute('data-scope-param') === 'ws-green-dev'", 15000),
              "甲：切「开发中」⇒ 参数解析为 ws-green-dev", picker(page, "data-scope-param"))
        dev_calls_g = [c for c in calls(page, PID_GREEN, "feature-ledger") if c.get("ws") == "ws-green-dev"]
        check(len(dev_calls_g) >= 1, "甲：开发视图请求带上 workspace=ws-green-dev", f"{len(dev_calls_g)} 次")
        check(wait_true(page, "document.querySelector('[data-delivery-overview]').getAttribute('data-delivery-state') !== 'loading'", 25000),
              "甲：开发视图读数落地", state_of(page))
        read_root_g = text_of(page, "[data-delivery-read-root]")
        check("green-dev" in read_root_g, "甲：版本依据区给出**服务端实际读取**的开发区根", read_root_g.strip()[:90])
        page.screenshot(path=str(OUT / "02-green-dev.png"))

        # ── 乙：默认读试用版；真实服务（真 workspace 参数） ──
        open_delivery(page, PID_WS)
        check(picker(page, "data-scope-active") == "trial", "④ 乙：默认停在「试用版」", picker(page, "data-scope-active"))
        check(picker(page, "data-scope-pending") == "0", "④ 乙：工作区登记已落定", picker(page, "data-scope-pending"))
        check(picker(page, "data-scope-param") == "ws-trial", "④ 乙：默认读解析出的试用工作区（显式带上参数）", picker(page, "data-scope-param"))
        check(page.evaluate("() => document.querySelector('[data-delivery-scope-option=\"trial\"]').getAttribute('aria-pressed')") == "true",
              "④ 乙：选择器把「试用版」标为当前选择")
        trial_calls = [c for c in calls(page, PID_WS, "feature-ledger") if c.get("ws") == "ws-trial"]
        check(len(trial_calls) >= 1, "④ 乙：功能清单请求**实际带上** workspace=ws-trial", f"{len(trial_calls)} 次")
        scope_note = text_of(page, "[data-delivery-scope-note]")
        check("试用" in scope_note, "④ 乙：选择器旁说明这是已登记的固定试用版", scope_note.strip()[:80])
        check(t_root_reg is not None and str(t_root_reg).split("\\")[-1] in scope_note, "④ 乙：选择器旁显示试用版根目录（尾段）", scope_note.strip()[:80])
        check(wait_true(page, "document.querySelector('[data-delivery-overview]') && document.querySelector('[data-delivery-overview]').getAttribute('data-delivery-state') !== 'loading'", 30000),
              "④ 乙：清单读数落地（版本依据区渲染出来）", state_of(page))
        read_ws_line = text_of(page, "[data-delivery-read-workspace]")
        check("ws-trial" in read_ws_line, "④ 乙：版本依据里给出服务端实际读取的版本＝试用候选", read_ws_line.strip()[:90])
        read_root_line = text_of(page, "[data-delivery-read-root]")
        check((t_root_reg or "") == "" or str(t_root_reg).split("\\")[-1] in read_root_line or str(t_root_reg).split("\\")[-1] in scope_note,
              "④ 乙：读到的根目录与登记试用根一致", read_root_line.strip()[:90])
        check(page.query_selector("[data-delivery-version-mismatch]") is None, "④ 乙：所选版本与服务端实读版本一致（无 mismatch）")
        # 「同一事实」必须与真浏览器**同一时刻**的读数比：乙 段真浏览器在 ⑥ 追记阻断缺陷**之后**才加载，
        # 拿追记之前的 d_before 是过期快照（后台冻结读数恒 unknown 时两边同为 unknown，缺陷被掩盖）。
        # 这里现读一次同版读数再比（判据与断言语义不变，只把对照快照换成同刻）。
        _, led_now = http_json(f"{api_w}/feature-ledger?document=active&workspace=ws-trial")
        d_now_delivery = (((led_now or {}).get("ledger") or {}).get("delivery") or {})
        d_now = {**d_now_delivery, "blockers": _blk(d_now_delivery)}
        check(state_of(page) == (d_now.get("state") or ""),
              "④ 乙：界面状态与服务端真实读数一致（同一事实）", f"UI {state_of(page)} / HTTP {d_now.get('state')}")
        check("可以开始人工试用" not in text_of(page, "[data-delivery-conclusion]") or d_now.get("state") == "ready_for_trial",
              "④ 乙：不给未成立的可试用结论（不假绿）", text_of(page, "[data-delivery-conclusion]").strip()[:50])
        page.screenshot(path=str(OUT / "03-ws-trial.png"))

        # 乙：切开发（真服务）
        page.click('[data-delivery-scope-option="dev"]')
        check(wait_true(page, "document.querySelector('[data-delivery-version-picker]').getAttribute('data-scope-param') === 'ws-dev'", 15000),
              "④ 乙：切「开发中」⇒ 参数解析为 ws-dev", picker(page, "data-scope-param"))
        dev_calls = [c for c in calls(page, PID_WS, "feature-ledger") if c.get("ws") == "ws-dev"]
        check(len(dev_calls) >= 1, "④ 乙：开发视图请求带上 workspace=ws-dev", f"{len(dev_calls)} 次")
        check(wait_true(page, "document.querySelector('[data-delivery-overview]').getAttribute('data-delivery-state') !== 'loading'", 25000),
              "④ 乙：开发视图读数落地", state_of(page))
        read_root_dev = text_of(page, "[data-delivery-read-root]")
        check("dev" in read_root_dev, "④ 乙：版本依据区给出服务端实际读取的开发区根（切开发读新根）", read_root_dev.strip()[:90])
        page.screenshot(path=str(OUT / "04-ws-dev.png"))

        # ── ④ 同 scope 快切 / 迟到回包不串（可控夹具） ──
        stub_trial = ledger_stub(5, "ws-trial", t_root)
        stub_dev = ledger_stub(2, "ws-dev", d_root)
        set_ctl(page, PID_WS, {"feature-ledger|ws-dev": {"body": stub_dev}})
        page.click('[data-delivery-scope-option="dev"]')
        check(wait_true(page, "document.querySelector('[data-delivery-counts]') && /正式功能 2 项/.test(document.querySelector('[data-delivery-counts]').textContent)", 20000),
              "迟到回包夹具：开发视图先落地（正式功能 2 项）")
        set_ctl(page, PID_WS, {"feature-ledger|ws-trial": {"delayMs": 3000, "body": stub_trial}, "feature-ledger|ws-dev": {"body": stub_dev}})
        page.click('[data-delivery-scope-option="trial"]')
        check(wait_true(page, "document.querySelector('[data-delivery-version-picker]').getAttribute('data-scope-active') === 'trial'", 8000),
              "迟到回包夹具：先切到试用版（慢回包在途）")
        page.wait_for_timeout(120)
        page.click('[data-delivery-scope-option="dev"]')
        check(wait_true(page, "document.querySelector('[data-delivery-version-picker]').getAttribute('data-scope-active') === 'dev'", 8000),
              "迟到回包夹具：立刻切回开发视图")
        landed_dev = wait_true(page, "document.querySelector('[data-delivery-counts]') && /正式功能 2 项/.test(document.querySelector('[data-delivery-counts]').textContent)", 20000)
        check(landed_dev, "迟到回包夹具：切回开发视图并落地（正式功能 2 项）")
        page.wait_for_timeout(3600)
        counts_after = text_of(page, "[data-delivery-counts]")
        check("正式功能 2 项" in counts_after, "迟到的试用版回包没有覆盖开发视图（不串 scope）", counts_after.strip()[:70])
        check(picker(page, "data-scope-active") == "dev", "迟到回包后仍停在开发视图", picker(page, "data-scope-active"))
        page.screenshot(path=str(OUT / "05-late-response.png"))
        set_ctl(page, PID_WS, {})

        # ── 分页：续页带同一工作区参数；409 旧页作废 ──
        page_stub = ledger_stub(1, "ws-trial", t_root, paging={"complete": False, "cursor": "cur1"})
        set_ctl(page, PID_WS, {
            "feature-ledger|ws-trial": {"body": page_stub},
            "feature-ledger|ws-trial|cur1": {"status": 409, "body": {"ok": False, "status": 409, "code": "REVISION_CHANGED", "message": "清单版本已变"}},
        })
        page.click('[data-delivery-scope-option="trial"]')
        page.evaluate("() => window.dispatchEvent(new Event('online'))")
        check(wait_true(page, "document.querySelector('[data-delivery-load-more]')", 20000), "分页夹具：出现「继续读取下一页」")
        page.click("[data-delivery-load-more]")
        check(wait_true(page, "document.querySelector('[data-delivery-paging-notice]')", 20000), "续页遇 409 时明确提示旧页作废")
        cur_calls = [c for c in calls(page, PID_WS, "feature-ledger") if c.get("cursor") == "cur1"]
        check(len(cur_calls) >= 1 and all(c.get("ws") == "ws-trial" for c in cur_calls),
              "续页请求带上与第一页**同一个**工作区参数（页与页不串版本）",
              json.dumps([[c.get("ws"), c.get("cursor")] for c in cur_calls], ensure_ascii=False))
        check(wait_true(page, "document.querySelector('[data-delivery-overview]').getAttribute('data-delivery-state') !== 'loading'", 20000), "409 后重读第一页并落地")
        items_after = page.evaluate("() => document.querySelectorAll('[data-delivery-features] [data-delivery-feature]').length")
        check(items_after == 1, "409 后回到第一页（不把两版拼在一起）", items_after)
        set_ctl(page, PID_WS, {})
        page.screenshot(path=str(OUT / "06-paging.png"))

        # ── 旧宿主：/workspaces 404 且清单缺 workspace 字段 ──
        set_ctl(page, PID_WS, {
            "workspaces": {"status": 404, "body": {"ok": False, "error": {"code": "NOT_FOUND", "message": "no such route"}}},
            "feature-ledger": {"body": ledger_stub(3, None, None, workspace_field=False)},
        })
        open_delivery(page, PID_WS)
        page.evaluate("() => window.dispatchEvent(new Event('online'))")
        check(wait_true(page, "document.querySelector('[data-delivery-version-picker]') && document.querySelector('[data-delivery-version-picker]').getAttribute('data-scope-unknown') === '1'", 25000),
              "旧宿主（无工作区读口）：选择器显式标未知", picker(page, "data-scope-unknown"))
        check(picker(page, "data-scope-legacy") == "1", "旧宿主：明确按活动主目录旧语义读", picker(page, "data-scope-legacy"))
        check(picker(page, "data-scope-param") == "", "旧宿主：不臆造工作区参数", picker(page, "data-scope-param"))
        legacy_calls2 = [c for c in calls(page, PID_WS, "feature-ledger") if c.get("ws") is None]
        check(len(legacy_calls2) >= 1, "旧宿主下按不带 workspace 的旧路径读", f"{len(legacy_calls2)} 次")
        check(page.query_selector("[data-delivery-scope-error]") is not None, "旧宿主读口缺失时页面上明确说明（不是静默）")
        read_unknown = text_of(page, "[data-delivery-read-workspace]")
        check("未知" in read_unknown, "清单缺 workspace 字段 ⇒ 实际读取版本显示未知（不冒充已核对）", read_unknown.strip()[:90])
        check(page.query_selector("[data-delivery-version-mismatch]") is None, "旧宿主下不断言版本一致/不一致（未知就是未知）")
        page.screenshot(path=str(OUT / "07-old-host.png"))
        set_ctl(page, PID_WS, {})

        # ── 刷新失败：保留内容但撤下可试用结论 ──
        keep = ledger_stub(4, "ws-trial", t_root)
        mode = {"value": "ok"}

        def ledger_route(route) -> None:
            if mode["value"] == "fail":
                route.abort()
                return
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "ledger": keep["ledger"]}, ensure_ascii=False))

        page7 = browser.new_page(viewport={"width": 1500, "height": 950})
        page7.set_default_timeout(20000)
        page7.route("**/feature-ledger*", ledger_route)
        page7.goto(f"{base}/#p/{PID_WS}")
        page7.wait_for_selector("[data-delivery-overview]", timeout=40000)
        page7.click('[data-main-nav] [data-view="delivery"]')
        check(wait_true(page7, "document.querySelector('[data-delivery-overview]').getAttribute('data-delivery-state') === 'ready_for_trial'", 25000),
              "刷新失败夹具：先读到可试用结论")
        mode["value"] = "fail"
        page7.evaluate("() => window.dispatchEvent(new Event('online'))")
        stale = wait_true(page7, "document.querySelector('[data-delivery-overview]').getAttribute('data-delivery-stale') === '1'", 25000)
        check(stale, "刷新失败进入「陈旧」态")
        check("可以开始人工试用" not in text_of(page7, "[data-delivery-conclusion]"), "刷新失败后撤下可试用结论", text_of(page7, "[data-delivery-conclusion]").strip()[:60])
        cards_stale = page7.evaluate("() => document.querySelectorAll('[data-delivery-features] [data-delivery-feature]').length")
        check(cards_stale >= 1, "刷新失败仍保留上次成功内容", cards_stale)
        check(picker(page7, "data-scope-param") == "ws-trial", "刷新失败不影响版本选择（仍按试用版读）", picker(page7, "data-scope-param"))
        page7.screenshot(path=str(OUT / "08-refresh-fail.png"))
        page7.close()

        # ── 窄屏无横向溢出 + 键盘切换 ──
        set_ctl(page, PID_WS, {})
        open_delivery(page, PID_WS)
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(300)
        over = page.evaluate("() => Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth)")
        check(over <= 1, "窄屏（390）无横向溢出", over)
        bar_over = page.evaluate(
            "() => { const e = document.querySelector('[data-delivery-version-picker]'); if (!e) return 999; const r = e.getBoundingClientRect(); return Math.round(r.right - document.documentElement.clientWidth); }"
        )
        check(bar_over <= 1, "版本选择器自身不超出窄屏宽度", bar_over)
        check(page.evaluate("() => { const e = document.querySelector('[data-delivery-scope-option=\"dev\"]'); return !!e && e.offsetParent !== null; }"),
              "窄屏下版本选择器仍可见可用")
        page.set_viewport_size({"width": 1500, "height": 950})
        page.wait_for_timeout(200)
        page.click('[data-delivery-scope-option="trial"]')
        page.wait_for_timeout(300)
        page.evaluate("() => { document.querySelector('[data-delivery-scope-option=\"dev\"]').focus(); }")
        check(page.evaluate("() => document.activeElement === document.querySelector('[data-delivery-scope-option=\"dev\"]')"), "版本选择按钮可获得键盘焦点")
        page.keyboard.press("Enter")
        check(wait_true(page, "document.querySelector('[data-delivery-version-picker]').getAttribute('data-scope-active') === 'dev'", 10000),
              "真键盘 Enter 可切换版本视图（不用 .click()）")
        page.keyboard.press("Tab")
        page.screenshot(path=str(OUT / "09-a11y.png"))

        # ── 丙：无工作区登记项目（旧语义明确标注） ──
        open_delivery(page, PID_LEGACY)
        check(picker(page, "data-scope-active") == "trial", "丙：无登记项目的默认视图仍是「试用版」", picker(page, "data-scope-active"))
        check(picker(page, "data-scope-legacy") == "1", "丙：无登记试用版 ⇒ 明确标出按活动主目录旧语义读", picker(page, "data-scope-legacy"))
        check(picker(page, "data-scope-param") == "", "丙：无登记试用版 ⇒ 不带 workspace 参数", picker(page, "data-scope-param"))
        note_text = text_of(page, "[data-delivery-scope-note]")
        check("活动主目录" in note_text or "固定试用版" in note_text, "丙：选择器旁说明读的是活动主目录旧语义", note_text.strip()[:80])
        st_l, led_l = http_json(f"{api_l}/feature-ledger")
        check(st_l == 200, "丙：无工作区登记项目读口仍 200（旧路径不退化）", f"HTTP {st_l}")
        page.screenshot(path=str(OUT / "10-legacy-project.png"))

        # ── 全程无未捕获页面异常 ──
        check(len(page_errors) == 0, "全程无未捕获页面异常（pageerror=0）", " | ".join(page_errors[:3]))

    finally:
        try:
            if browser is not None:
                browser.close()
        except Exception:  # noqa: BLE001
            pass
        if pw is not None:
            try:
                pw.stop()
            except Exception:  # noqa: BLE001
                pass
        kill_tree(vite.pid if vite is not None else None)
        kill_tree(backend.pid if backend is not None else None)
        time.sleep(1.0)
        # 只清自己的临时子树；夹具里的真实 Git 仓库把对象文件设成只读（Windows），
        # 先把整棵子树改可写再删（重试几次，最后如实记录）
        for attempt in range(4):
            for _root, _dirs, _files in os.walk(tmp, topdown=False):
                for _name in _files + _dirs:
                    try:
                        os.chmod(os.path.join(_root, _name), stat.S_IWRITE)
                    except OSError:
                        pass
            shutil.rmtree(tmp, ignore_errors=True)
            if not tmp.exists():
                break
            time.sleep(1.5)
        if tmp.exists():
            note(f"临时目录未清干净：{tmp}")

    write_report()
    failed = [r for r in RESULTS if not r["ok"]]
    print(f"\n结论：{'全部通过' if not failed else f'{len(failed)} 项未通过'}（{len(RESULTS) - len(failed)}/{len(RESULTS)}）", flush=True)
    if DEFECTS:
        print(f"其中 {len(DEFECTS)} 项由**后台缺陷**阻塞（见 REPORT「后台缺陷」段）：", flush=True)
        for d in DEFECTS:
            print(f"  - {d}", flush=True)
    return 1 if failed else 0


def write_report() -> None:
    passed = len([r for r in RESULTS if r["ok"]])
    lines = [
        "# V09-67 交付总览「读哪个版本」界面验证（真实浏览器 + 真实服务 + 真实全绿夹具）",
        "",
        f"- 时间：{time.strftime('%Y-%m-%dT%H:%M:%S')}",
        "- 命令：python scripts/verify-v09-67-ui.py",
        f"- 证据目录：{OUT}",
        f"- 结果：{passed} / {len(RESULTS)} 通过",
        f"- 由后台缺陷阻塞：{len(DEFECTS)} 项",
        "",
        "- 真服务：临时 TATAI_HOME + 动态端口真实后端 + 真实 Vite dev + Playwright；",
        "- 真夹具：三张合法图纸源（声明区/卡/映射/交付核对声明/集成检查要求）+ 需求/定义/基线 + 工作区登记/冻结/",
        "  试用提升 + 源清单存证 + 作者自检 + 非作者独审，全部经真实宿主唯一写入口；",
        "- 可控夹具：仅浏览器内拦截 /workspaces 与 /feature-ledger（旧宿主、迟到回包、分页 409、刷新失败），默认透传真服务。",
        "",
    ]
    for n in NOTES:
        lines.append(f"- 记录：{n}")
    lines.append("")
    if DEFECTS:
        lines.append("## 后台缺陷（阻塞项；非夹具问题）")
        lines.append("")
        for d in DEFECTS:
            lines.append(f"- {d}")
        lines.append("")
    lines.append("## 逐项断言")
    lines.append("")
    for r in RESULTS:
        tag = "[x]" if r["ok"] else ("[!]" if r.get("defect") else "[ ]")
        lines.append(f"- {tag} {r['label']}{(' — ' + r['detail']) if r['detail'] else ''}")
    (OUT / "REPORT.md").write_text("\n".join(lines) + "\n", "utf8")
    (OUT / "results.json").write_text(
        json.dumps({"passed": passed, "total": len(RESULTS), "defects": DEFECTS, "results": RESULTS, "notes": NOTES}, ensure_ascii=False, indent=2),
        "utf8",
    )


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        RESULTS.append({"ok": False, "label": "脚本自身异常", "detail": str(e), "defect": False})
        print(f"脚本崩溃：{e}", flush=True)
        try:
            write_report()
        except Exception:  # noqa: BLE001
            pass
        sys.exit(1)
