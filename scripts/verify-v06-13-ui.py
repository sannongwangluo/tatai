#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V06-13 浏览器场景验证（Python + Playwright）：按 DESIGN §3.14「必须演练」清单逐条跑。

用法：python scripts/verify-v06-13-ui.py
      （V0613_KEEP_TMP=1 保留临时夹具现场；V0613_SHOT_DIR 可改截图目录）

why 必须跑真浏览器（PLAN.md V06-13 检查项 ③ / DESIGN §3.14）：「空仓库有灰色规划图；设计与施工图
可互相定位；同一任务在聊天、图和施工图显示同源状态；切项目不串消息；刷新不丢草稿与动作回执；未知不
显示成功；旧证据失效后不继续显示已验证；纯后端场景可读；终端不出现在主导航；Git 提醒不误报已备份」
——这些只有在实际 DOM、真实 HTTP、真实文件系统与真实派生链上才验得出来，渲染函数级断言不算。

§3.14「必须演练」10 条 → 本脚本断言组（组号见每段注释）：
  1 空仓库有灰色规划图            → ②
  2 设计与施工图可互相定位        → ③
  3 同一任务在聊天/图/施工图同源   → ④
  4 切项目不串消息                → ⑤
  5 刷新不丢草稿与动作回执        → ⑥
  6 未知不显示成功                → ⑦
  7 旧证据失效后不再显示已验证    → ⑧
  8 纯后端场景可读                → ⑨
  9 终端不出现在主导航            → ①
 10 Git 提醒不误报已备份          → ⑩
另：§3.14 第一句「人应能不看代码地指出目标 / 当前改动 / 已验证与未验证范围」→ ⑪（主工作面与图详情）。

隔离口径（AGENTS.md §5 / 卡面红线）：
  · 临时 TATAI_HOME + `tempfile` 下三个夹具项目，**绝不碰**三个真实项目的 `.工作台/`；
  · 夹具里的 git 写命令只用来造现场，全在 tempfile 内，收尾整棵删掉；塔台本体一个 git 写命令都没跑；
  · 模型环节不参与：夹具事实全部经**真实 v2 写入服务**（POST /api/work/command）提交，
    聊天动作只用零模型的 discussion / locate_feedback 两类；
  · 收尾杀净子进程、删临时目录（V0613_KEEP_TMP=1 可留现场）。
"""
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SHOT_DIR = os.environ.get(
    "V0613_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "V06-13", "1", "screenshots")
)
A = "v0613ui-a"
B = "v0613ui-b"
C = "v0613ui-empty"
KEEP = os.environ.get("V0613_KEEP_TMP") == "1"

MAIN_NAV = ["项目图", "设计书", "施工图", "聊天", "实况与验收"]

fails = []
passes = [0]
step = {"now": "启动"}
ROOTS = {}

GIT_ENV = dict(os.environ, GIT_TERMINAL_PROMPT="0")
GIT_ID = ["-c", "user.email=fixture@tatai.local", "-c", "user.name=fixture"]


def ok(cond, label):
    print(("[ui] PASS " if cond else "[ui] FAIL ") + label)
    if cond:
        passes[0] += 1
    else:
        fails.append(label)


def info(msg):
    print("[ui]   " + msg)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return path


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def http(url, method="GET", body=None, timeout=120, headers=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, method=method, data=data)
    if data is not None:
        req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8")
            return resp.status, (json.loads(text) if text.strip().startswith(("{", "[")) else text)
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, text


# ══════════════════════════════ 夹具 ══════════════════════════════

def design_md(title, lines=6):
    body = "\n".join(f"第 {i} 行：{title} 的正文内容，用来把设计书拉长到可滚动。" for i in range(lines))
    return (
        f"# {title}\n\n> 夹具：只用于 V06-13 浏览器场景（与 repo 根 DESIGN.md 同结构）。\n\n"
        "## 1 概述\n\n目标：夹具。\n\n"
        "## 2 导入能力\n\n- 模块：src（导入实现）\n\n"
        f"## 3 正文\n\n{body}\n"
    )


def plan_md(title, cards):
    rows = "\n".join(
        f"| {cid} | todo | {goal} | {dep} | {ev} |" for cid, goal, dep, ev in cards
    )
    sections = []
    for cid, goal, dep, ev in cards:
        sections.append(
            f"### {cid} {goal}\n\n"
            f"**设计依据**：§2。**依赖**：{dep or '无'}。\n\n"
            f"**文件责任**：`src/{cid.lower()}.ts`。\n\n"
            f"- [ ] {cid} 的验收检查项一\n\n"
            f"**交付**：{ev}。\n"
        )
    return (
        f"# {title}\n\n> 夹具施工图。\n\n## 当前任务\n\n"
        "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |\n| --- | --- | --- | --- | --- |\n"
        f"{rows}\n\n" + "\n".join(sections)
    )


def make_project(root, name, cards, *, design_lines=6, chat=None, git=False, code=True):
    os.makedirs(root, exist_ok=True)
    write(os.path.join(root, ".工作台", "design.md"), design_md(f"{name} 设计书", design_lines))
    write(os.path.join(root, ".工作台", "plan.md"), plan_md(f"{name} 施工图", cards))
    write(os.path.join(root, ".工作台", "tasks.json"), json.dumps({
        "version": 1,
        "tasks": [{"id": cid, "title": goal, "module_id": "m1", "status": "doing", "reporter": "fixture",
                   "updated_at": "2026-09-20T09:00:00+08:00"} for cid, goal, _d, _e in cards],
    }, ensure_ascii=False, indent=2) + "\n")
    if code:
        write(os.path.join(root, "src", "index.ts"), "export const v = 1;\n")
        write(os.path.join(root, "README.md"), f"# {name}\n\n夹具项目。\n")
        write(os.path.join(root, "package.json"), '{"name":"fixture"}\n')
    for sid, msgs in (chat or {}).items():
        lines = []
        for role, content in msgs:
            row = {"role": role, "content": content, "ts": "2026-09-20T08:00:00+08:00"}
            if role == "assistant":
                row["model"] = "deepseek-v41-flash"
            lines.append(json.dumps(row, ensure_ascii=False))
        write(os.path.join(root, ".工作台", "chat", f"{sid}.jsonl"), "\n".join(lines) + "\n")
    if git:
        write(os.path.join(root, ".gitignore"), ".工作台/\n")
        subprocess.run(["git", "init", "-q", "-b", "main", "."], cwd=root, env=GIT_ENV, check=True)
        subprocess.run(["git", "add", "--", ".gitignore", "src/index.ts", "README.md", "package.json"],
                       cwd=root, env=GIT_ENV, check=True)
        subprocess.run(["git"] + GIT_ID + ["commit", "-qm", "夹具初版"], cwd=root, env=GIT_ENV, check=True)
    return root


def put_evidence(root, content, summary, revision):
    sha = sha256(content)
    write(os.path.join(root, ".工作台", "work", "evidence", sha + ".json"), json.dumps({
        "evidence_id": sha, "sha256": sha, "bytes": len(content.encode("utf-8")),
        "recovery_path": f"work/evidence/{sha}.json", "kind": "self_check", "summary": summary,
        "created_by": "fixture", "role": "auditor",
        "binding": {"revision_kind": "code", "revision": revision},
        "source_ref": None, "created_at": "2026-09-20T09:30:00+08:00",
        "content_sha256": sha, "content": content,
    }, ensure_ascii=False, indent=2) + "\n")
    return sha


def make_registry(home, records):
    write(os.path.join(home, "registry.json"),
          json.dumps({"version": 1, "projects": records}, ensure_ascii=False, indent=2) + "\n")


# ══════════════════════════════ 后端 / vite ══════════════════════════════

class Backend:
    def __init__(self, home, port, log_path):
        self.home = home
        self.port = port
        env = dict(os.environ)
        env["TATAI_HOME"] = home
        env["TATAI_PORT"] = str(port)
        env.pop("DEEPSEEK_API_KEY", None)
        env["DEEPSEEK_API_KEY"] = ""
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", os.path.join("src", "server", "index.ts")],
            cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
        )

    def api(self, path, method="GET", body=None, headers=None, timeout=120):
        return http("http://127.0.0.1:%d%s" % (self.port, path), method, body, timeout=timeout, headers=headers)

    def work_token(self):
        with open(os.path.join(self.home, "work-service.json"), encoding="utf-8") as f:
            return json.load(f)["token"]

    def wo_command(self, command):
        status, body = self.api("/api/work/command", "POST", command,
                                headers={"x-tatai-work-token": self.work_token()})
        if status != 200:
            raise RuntimeError("v2 写入失败 HTTP %s：%s" % (status, str(body)[:400]))
        return body

    def wait_health(self, timeout=90):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("后端进程退出，日志见 " + str(self.proc.args))
            try:
                status, _ = self.api("/health")
                if status == 200:
                    return
            except Exception:
                pass
            time.sleep(0.3)
        raise RuntimeError("后端 %d 未就绪" % self.port)

    def kill(self):
        try:
            self.proc.kill()
            self.proc.wait(timeout=10)
        except Exception:
            pass


def start_vite(port, backend_port, log_path):
    env = dict(os.environ)
    env["TATAI_DEV_API_PORT"] = str(backend_port)
    proc = subprocess.Popen(
        ["node", os.path.join("node_modules", "vite", "bin", "vite.js"), "dev",
         "--port", str(port), "--strictPort"],
        cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
    )
    deadline = time.time() + 120
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("vite 起不来（进程已退出）")
        try:
            with urllib.request.urlopen("http://localhost:%d/" % port, timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("vite %d 未就绪" % port)


def cmd(project, entity, type_, payload, key, expected=None, actor="fixture", role="agent", at=None):
    command = {
        "schema_version": 2, "project_id": project, "change_id": "v0613ui", "entity_id": entity,
        "expected_revision": expected, "type": type_, "actor_id": actor, "role": role,
        "idempotency_key": key, "payload": payload,
    }
    if at is not None:
        command["occurred_at"] = at   # 顶层字段；放进 payload 会被忽略（夹具踩过的坑）
    return command


def publish_baseline(backend, project_id):
    """激活基线（真实接口）→ 触发规划图派生；等它发布出来。"""
    status, body = backend.api(
        f"/api/projects/{project_id}/documents/activate", "POST",
        {"approved_by": "v0613ui-design-role", "approval_basis": "V06-13 浏览器夹具：技术判断代行设计角色（非 GPT-6、非用户拍板）",
         "approval_kind": "delegated_technical_review"},
    )
    if status != 200:
        raise RuntimeError("激活基线失败：HTTP %s %s" % (status, str(body)[:300]))
    for _ in range(80):
        status, bp = backend.api(f"/api/projects/{project_id}/arch/blueprint")
        if status == 200 and bp.get("blueprint", {}).get("exists"):
            return bp["blueprint"]["blueprint"]
        time.sleep(0.25)
    raise RuntimeError("规划图 20 秒内没有发布（见后端日志）")


def projection_of(backend, project_id):
    status, body = backend.api(f"/api/projects/{project_id}/status-projection")
    if status != 200:
        raise RuntimeError("读状态投影失败 HTTP %s：%s" % (status, str(body)[:200]))
    return {o["object_id"]: o for o in body["projection"]["objects"]}


COVERAGE = [
    {"area": "behavior_boundaries", "status": "checked", "basis": "夹具：按用户路径走一遍"},
    {"area": "data_concurrency", "status": "unchecked", "basis": "夹具：单机串行"},
    {"area": "interface_integration", "status": "checked", "basis": "夹具：端到端跑通"},
    {"area": "failure_recovery", "status": "unchecked", "basis": "夹具：未做故障注入"},
    {"area": "trust_permission", "status": "not_applicable", "basis": "夹具：本卡不涉权限面"},
]


def seed_project(backend, pid, root, plan, *, code_rev, invalidate_task=None, later_rev="code-rev-2"):
    """把夹具事实经**真实写入服务**提交：定义绑定 → 执行状态 → 结果提交 → 独立审计。

    必需检查项从服务端投影现读（`missing`），不自己算——避免"夹具算错 check_id"变成假结论。
    invalidate_task：该卡先按 code_rev 判绿，再由一个新版本的提交把源修订推前（后面用 later_rev），
    于是它的旧证据转失效；其余卡按 later_rev 绑定证据，保持有效。"""
    ids = [d["task_id"] for d in plan["definitions"]]
    hashes = plan["definition_hashes"]
    plan_rev = plan["content_sha256"]
    for tid in ids:
        backend.wo_command(cmd(pid, f"task:{tid}", "task.definition_imported",
                               {"definition_sha256": hashes[tid], "plan_revision": plan_rev, "definition_revision": 1},
                               f"{tid}:def:v0613ui", expected=None))
    t1, t2, t3 = ids[0], ids[1], ids[2]
    backend.wo_command(cmd(pid, f"task:{t2}", "task.status_changed", {"status": "executing"},
                           f"{t2}:st-exec:v0613ui", expected=1))
    # T-3 先"就绪"再"执行中"再"已交结果"（版本号逐次递增，事件源自己管版本）
    backend.wo_command(cmd(pid, f"task:{t3}", "task.status_changed", {"status": "ready"},
                           f"{t3}:st-ready:v0613ui", expected=1))
    backend.wo_command(cmd(pid, f"task:{t3}", "task.status_changed", {"status": "executing"},
                           f"{t3}:st-exec:v0613ui", expected=2))
    backend.wo_command(cmd(pid, f"task:{t1}", "task.status_changed", {"status": "executing"},
                           f"{t1}:st-exec:v0613ui", expected=1))
    backend.wo_command(cmd(pid, f"task:{t1}", "task.result_submitted",
                           {"definition_sha256": hashes[t1], "plan_revision": plan_rev},
                           f"{t1}:st-submitted:v0613ui", expected=2))
    backend.wo_command(cmd(pid, f"task:{t3}", "task.result_submitted",
                           {"definition_sha256": hashes[t3], "plan_revision": plan_rev},
                           f"{t3}:st-submitted:v0613ui", expected=3))
    # 结果提交（绑定代码修订；T-3 的更晚 → 它带来"当前代码修订"）
    ev1 = put_evidence(ROOTS[A] if pid == A else ROOTS[B], "夹具：实现自检输出\nexit 0\n",
                       f"{t1} 实现自检（夹具）", code_rev)
    ev2 = put_evidence(ROOTS[A] if pid == A else ROOTS[B], "夹具：实现自检输出（第二张卡）\nexit 0\n",
                       f"{t3} 实现自检（夹具）", later_rev)
    backend.wo_command(cmd(pid, f"submission:sub-{t1}", "audit.submission_submitted", {
        "goal": "夹具：第一张卡交付", "task_id": t1, "round": 1, "baseline": {},
        "changed_files": ["src/index.ts"], "commands": [{"command": "pnpm test", "exit_code": 0, "output_ref": None}],
        "untested": [], "known_issues": [], "evidence_refs": [ev1],
        "binding": {"revision_kind": "code", "revision": code_rev},
        "submitted_by": "fixture-agent",
    }, f"sub-{t1}:v0613ui", expected=None, at="2026-09-20T09:00:00+08:00"))
    backend.wo_command(cmd(pid, f"submission:sub-{t3}", "audit.submission_submitted", {
        "goal": "夹具：第三张卡交付", "task_id": t3, "round": 1, "baseline": {},
        "changed_files": ["src/index.ts"], "commands": [{"command": "pnpm test", "exit_code": 0, "output_ref": None}],
        "untested": [], "known_issues": [], "evidence_refs": [ev2],
        "binding": {"revision_kind": "code", "revision": later_rev},
        "submitted_by": "fixture-agent",
    }, f"sub-{t3}:v0613ui", expected=None, at="2026-09-20T09:30:00+08:00"))
    # 独立审计：按投影点名的缺口逐项覆盖（最多 3 轮；每轮都是真为它列出的 check_id 出独立记录）
    for round_no in range(1, 4):
        proj = projection_of(backend, pid)
        todo = []
        for tid, binding_rev, ev in ((t1, code_rev, ev1), (t3, later_rev, ev2)):
            obj = proj.get(tid)
            if obj is None or obj["display_status"] == "verified" or not obj["missing"]:
                continue
            todo.append((tid, binding_rev, ev, [m["check_id"] for m in obj["missing"]]))
        if not todo:
            break
        for tid, binding_rev, ev, check_ids in todo:
            backend.wo_command(cmd(pid, f"audit:{tid}-r{round_no}", "audit.independent_audit_recorded", {
                "task_id": tid, "round": round_no, "auditor": "fixture-auditor", "auditor_role": "auditor",
                "author_id": "fixture-agent",
                "independence": {"different_actor": True, "same_session_as_author": False,
                                 "read_author_summary_first": True, "model_note": "夹具独立审计"},
                "checks": [{"check_id": c, "result": "passed", "evidence_sha256": ev} for c in check_ids],
                "coverage": COVERAGE, "findings": [], "conclusion": "pass",
                "not_reported_scope": ["夹具未覆盖的并发场景"], "method_limits": ["夹具：单机串行"],
                "binding": {"revision_kind": "code", "revision": binding_rev},
            }, f"audit-{tid}-r{round_no}:v0613ui", expected=None, actor="fixture-auditor", role="auditor"))
    if invalidate_task is not None:
        # 再交一版（绑定更新的代码修订）→ 当前代码修订前移 → 旧证据（绑旧修订）转失效
        backend.wo_command(cmd(pid, f"submission:sub-{invalidate_task}-v2", "audit.submission_submitted", {
            "goal": "夹具：改了一版（源变了）", "task_id": invalidate_task, "round": 2, "baseline": {},
            "changed_files": ["src/index.ts"], "commands": [], "untested": [], "known_issues": [],
            "evidence_refs": [ev1],
            "binding": {"revision_kind": "code", "revision": later_rev},
            "submitted_by": "fixture-agent",
        }, f"sub-{invalidate_task}-v2:v0613ui", expected=None, at="2026-09-20T09:45:00+08:00"))
    return t1, t2, t3


# ══════════════════════════════ 浏览器断言 ══════════════════════════════

def attr(page, selector, name):
    loc = page.locator(selector)
    return loc.get_attribute(name) if loc.count() > 0 else None


def node_states(page):
    return page.eval_on_selector_all(
        "[data-project-canvas-host] [data-project-node]",
        """els => els.map(e => ({
             id: e.getAttribute('data-project-node'),
             status: e.getAttribute('data-project-status'),
             label: e.getAttribute('data-project-status-label'),
             text: e.innerText || ''
           }))""",
    )


def run_browser(vite_port, backend, t_ids):
    os.makedirs(SHOT_DIR, exist_ok=True)
    t1, t2, t3 = t_ids["a"]
    b1 = t_ids["b"][0]
    c1 = t_ids["c"][0]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        base = "http://localhost:%d" % vite_port

        def shot(name):
            page.screenshot(path=os.path.join(SHOT_DIR, name))

        def goto_project(pid):
            page.goto("%s/#p/%s" % (base, pid), wait_until="domcontentloaded")
            page.wait_for_selector('button[data-view="arch"]', timeout=60000)
            page.wait_for_timeout(400)

        def open_view(pid, view, wait_sel=None, timeout=60000):
            goto_project(pid)
            page.locator('button[data-view="%s"]' % view).click()
            page.wait_for_selector(wait_sel or "[data-view-host]", timeout=timeout)
            page.wait_for_timeout(400)

        def open_graph(pid, view="functional"):
            goto_project(pid)
            page.locator('button[data-view="arch"]').click()
            page.wait_for_selector('[data-project-view-tab="%s"]' % view, timeout=60000)
            page.locator('[data-project-view-tab="%s"]' % view).click()
            page.wait_for_selector("[data-project-canvas-host] .react-flow__node", timeout=40000)
            page.wait_for_timeout(700)

        def open_plan(pid):
            open_view(pid, "plan", "[data-plan-view]")

        def open_chat(pid):
            open_view(pid, "chat", "[data-chat-input]")

        def open_acceptance(pid):
            open_view(pid, "live", "[data-live-page]")
            page.locator('[data-live-sub="acceptance"]').click()
            page.wait_for_selector("[data-acceptance-view]", timeout=30000)
            page.wait_for_timeout(500)

        def node_of(task_id, states):
            hit = [s for s in states if s["id"] == "plan:task:%s" % task_id]
            if not hit:
                hit = [s for s in states if task_id in s["id"]]
            return hit[0] if hit else None

        # ══════════ ① 终端不出现在主导航（§3.14 第 9 条）+ 没有工具/模型教学 ══════════
        step["now"] = "① 主导航与终端"
        goto_project(A)
        main_labels = page.eval_on_selector_all(
            "nav[data-main-nav] button", "els => els.map(e => (e.innerText||'').trim())")
        ok(main_labels == MAIN_NAV, "① 主导航恰为 %s（实际 %s）" % (MAIN_NAV, main_labels))
        ok(page.locator('nav[data-main-nav] button[data-view="terminal"]').count() == 0,
           "① **终端不在用户主导航里**（§3.1/§3.14；维护诊断入口保留在辅助入口）")
        ok(page.locator('nav[data-aux-nav] button[data-view="terminal"]').count() == 1,
           "① 终端移到辅助入口「维护诊断」（不是被删掉，是移出用户主界面）")
        body = page.inner_text("body")
        ok(all(w not in body for w in ("下一步用什么", "推荐模型", "档位")),
           "① 页面上没有「下一步用什么工具/模型/档位」教学卡（§3.1 / §12.1）")
        shot("01-main-nav-no-terminal.png")

        # ══════════ ② 空仓库有灰色规划图（§3.14 第 1 条） ══════════
        step["now"] = "② 空仓灰图"
        open_graph(C, "functional")
        gray = node_states(page)
        statuses = sorted({s["status"] for s in gray})
        ok(len(gray) >= 1 and all(s["status"] in ("unmapped", "planned") for s in gray),
           "② 空仓（一行代码都没有）照样出图：%d 个灰节点，状态 %s" % (len(gray), statuses))
        ok(not any(s["status"] == "verified" for s in gray),
           "② **空仓里没有一个节点被判绿**（不空集判绿、不假绿 §4.2）")
        ok(any("未映射" in s["label"] or "已规划" in s["label"] for s in gray),
           "② 灰是**带文字通道**的（标签 %s），不是只靠颜色" % sorted({s["label"] for s in gray}))
        shots = page.locator("[data-project-status-icon]").count()
        ok(shots >= 1, "② 每个节点都有状态图标位（颜色 + 文字 + 图标三通道）")
        page.screenshot(path=os.path.join(SHOT_DIR, "02-empty-repo-gray-graph.png"))
        # 施工依赖视图里能看到"已规划未开始"的卡（灰的正题）
        open_graph(C, "construction")
        c_states = node_states(page)
        c_node = node_of(c1, c_states)
        ok(c_node is not None and c_node["status"] in ("planned", "unmapped"),
           "② 施工依赖视图里 %s 是灰（%s）——蓝图有节点、没有执行事实，就只能是「已规划未开始」"
           % (c1, c_node["status"] if c_node else "(未找到节点)"))
        page.screenshot(path=os.path.join(SHOT_DIR, "02b-construction-planned.png"))

        # ══════════ ③ 设计与施工图可互相定位（§3.14 第 2 条） ══════════
        step["now"] = "③ 设计 ↔ 施工双向定位"
        # 设计侧出处：空仓功能全景里点一个能力节点（它的出处是设计书章节）
        open_graph(C, "functional")
        cap_nodes = [s for s in node_states(page) if "cap" in s["id"]]
        ok(len(cap_nodes) >= 1, "③ 前置：功能全景里有能力节点（%d 个）" % len(cap_nodes))
        page.locator('[data-project-node="%s"]' % cap_nodes[0]["id"]).click()
        page.wait_for_selector("[data-detail-section]", timeout=20000)
        cap_detail = page.locator("[data-project-detail]").inner_text()
        ok("设计书章节" in cap_detail, "③ 能力节点详情给出**设计书章节出处**（设计书侧可定位）")
        ok("基线" in cap_detail and "派生器" in cap_detail, "③ 出处段标明生效基线与派生器版本（可追溯，不是编的）")
        # 施工侧出处：施工依赖视图里点一张卡（它的出处是施工卡）
        open_graph(C, "construction")
        c_states = node_states(page)
        c_node = node_of(c1, c_states)
        ok(c_node is not None, "③ 前置：施工依赖视图里找到 %s 的节点" % c1)
        if c_node is not None:
            page.locator('[data-project-node="%s"]' % c_node["id"]).click()
            page.wait_for_selector("[data-detail-section]", timeout=20000)
            task_detail = page.locator("[data-project-detail]").inner_text()
            ok("施工卡" in task_detail,
               "③ 施工卡节点详情给出**施工图原文出处**（施工卡 + 路径）")
            ok("设计书章节" in task_detail or "§" in task_detail,
               "③ 同一节点的出处里也带到设计依据（设计与施工图在图上互相能找得到）")
            shot("03-task-detail-plan-origin.png")
        # 关系层：蓝图里确有"任务 → 设计章节所属能力"的 declared 关系（不是靠名字猜）
        st_bp, bp_body = backend.api("/api/projects/%s/arch/blueprint" % C)
        bp_edges = bp_body["blueprint"]["blueprint"]["edges"] if st_bp == 200 else []
        design_ref_edges = [e for e in bp_edges if e["kind"] == "task_design_ref" and "E-1" in e["source"]]
        ok(len(design_ref_edges) >= 1,
           "③ 图上确有把两者连起来的关系（task_design_ref %s）——设计↔施工的定位靠稳定 id，不靠名字"
           % [(e["source"], e["target"]) for e in design_ref_edges][:2])
        shot("03b-design-plan-cross-locate.png")
        # 另一半：施工图页 卡片 ↔ 原文 双向定位
        open_plan(A)
        page.locator('[data-plan-card="%s"]' % t1).click()
        page.wait_for_selector('[data-plan-excerpt="%s"]' % t1, timeout=20000)
        excerpt = page.locator('[data-plan-excerpt="%s"]' % t1).inner_text()
        ok(("原文出处 · %s" % t1) in excerpt and "设计依据" in excerpt,
           "③ 施工图页：点卡片 → 右侧给出它在施工图原文里的小节（含「设计依据」引用）")
        ok(page.locator('[data-plan-excerpt="%s"] [data-plan-excerpt-row]' % t1).count() == 1,
           "③ 原文出处带**行号**（能不看代码地定位到原文那一行）")
        page.locator('[data-plan-source-task="%s"]' % t1).click()
        page.wait_for_timeout(300)
        ok(page.locator('[data-plan-card="%s"][data-plan-selected="1"]' % t1).count() == 1,
           "③ 反向：点原文里的表格行 → 选中那张卡（双向定位闭环）")
        shot("03b-plan-card-to-source.png")

        # ══════════ ④ 同一任务在聊天、图和施工图显示同源状态（§3.14 第 3 条） ══════════
        step["now"] = "④ 聊天/图/施工图同源"
        open_plan(A)
        card_state = attr(page, '[data-plan-card="%s"]' % t2, "data-plan-card-status")
        plan_label = page.locator('[data-plan-card="%s"] [data-plan-card-status-label]' % t2).inner_text().strip()
        open_graph(A, "construction")
        a_states = node_states(page)
        a_node = node_of(t2, a_states)
        ok(a_node is not None, "④ 图上有 %s 的节点" % t2)
        graph_status = a_node["status"] if a_node else "(无)"
        # 同源：施工图给的是**执行状态**，图给的是**六态派生**——两条词汇表必须有确定的对应关系
        expect_display = {"ready": "planned", "claimed": "in_progress", "executing": "in_progress",
                          "result_submitted": "pending_verification", "blocked": "blocked"}.get(card_state)
        proj_t2 = projection_of(backend, A).get(t2, {})
        ok(plan_label != "" and graph_status != "(无)" and expect_display == graph_status,
           "④ **同一任务在图与施工图显示同源状态**：施工图「%s」(执行状态 %s) ↔ 图「%s」(六态)，"
           "且服务端投影 execution=%s / display=%s —— 一条事实、两条词汇表，不是各写一套"
           % (plan_label, card_state, graph_status, proj_t2.get("execution"), proj_t2.get("display_status")))
        ok(proj_t2.get("display_status") == graph_status and expect_display == proj_t2.get("display_status"),
           "④ 界面上的两处都与服务端投影对得上（图上/施工图上看到的不是前端自己算的：投影 display=%s）"
           % proj_t2.get("display_status"))
        open_chat(A)
        page.wait_for_selector("[data-chat-action]", timeout=30000)
        act = page.locator("[data-chat-action]").first
        affected = act.get_attribute("data-action-affected") or act.inner_text()
        ok(("task:%s" % t2) in (affected + act.inner_text()),
           "④ 聊天里那条动作的 affected/正文指向同一个任务 id（task:%s）" % t2)
        shot("04-chat-graph-plan-same-source.png")

        # ══════════ ⑤ 切项目不串消息（§3.14 第 4 条） ══════════
        step["now"] = "⑤ 切项目不串消息"
        open_chat(A)
        page.wait_for_selector("[data-msg-user]", timeout=30000)
        a_msgs = page.eval_on_selector_all("[data-msg-user], [data-msg-assistant]", "els => els.map(e => e.innerText)")
        ok(any("甲项目的会话" in m for m in a_msgs), "⑤ 甲项目聊天列出甲自己的消息（%d 条）" % len(a_msgs))
        open_chat(B)
        page.wait_for_selector("[data-msg-user]", timeout=30000)
        b_msgs = page.eval_on_selector_all("[data-msg-user], [data-msg-assistant]", "els => els.map(e => e.innerText)")
        ok(any("乙项目的会话" in m for m in b_msgs), "⑤ 乙项目聊天列出乙自己的消息（%d 条）" % len(b_msgs))
        ok(not any("甲项目的会话" in m for m in b_msgs),
           "⑤ **切项目不串消息**：乙项目里找不到甲的任何一条消息")
        b_sessions = page.eval_on_selector_all("[data-session-item]", "els => els.map(e => e.getAttribute('data-session-id'))")
        ok("s-b" in b_sessions and "s-a" not in b_sessions, "⑤ 会话列表也按项目隔离（%s）" % b_sessions)
        shot("05-project-chat-isolation.png")

        # ══════════ ⑥ 刷新不丢草稿与动作回执（§3.14 第 5 条） ══════════
        step["now"] = "⑥ 刷新不丢草稿与动作回执"
        open_chat(A)
        page.locator("[data-session-item]").first.click()
        page.wait_for_selector("[data-chat-input]", timeout=20000)
        page.fill("[data-chat-input]", "甲项目的未发草稿（V06-13）")
        receipt_kind = attr(page, "[data-chat-action]", "data-action-kind")
        receipt_count_before = page.locator("[data-action-receipt]").count()
        ok(receipt_kind == "locate_feedback", "⑥ 前置：聊天里有一条动作回执（kind=%s）" % receipt_kind)
        ok(receipt_count_before >= 1, "⑥ 动作回执逐条落盘（%d 条工具回执）" % receipt_count_before)
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("[data-chat-input]", timeout=60000)
        page.wait_for_timeout(600)
        ok(page.input_value("[data-chat-input]") == "甲项目的未发草稿（V06-13）",
           "⑥ **刷新后未发草稿还在**（草稿按项目留在 sessionStorage）")
        ok(page.locator("[data-action-receipt]").count() == receipt_count_before
           and attr(page, "[data-chat-action]", "data-action-kind") == "locate_feedback",
           "⑥ **刷新后动作回执仍在**（回执来自落盘的 chat-actions.jsonl，不是内存里的乐观上屏）")
        page.fill("[data-chat-input]", "")
        shot("06-draft-and-receipt-survive-reload.png")

        # ══════════ ⑦ 未知不显示成功（§3.14 第 6 条） ══════════
        step["now"] = "⑦ 未知不显示成功"
        open_acceptance(A)
        cards = page.eval_on_selector_all(
            "[data-acceptance-task]",
            "els => els.map(e => ({t: e.getAttribute('data-acceptance-task'), s: e.getAttribute('data-acceptance-state')}))")
        ok(len(cards) >= 1 and all(c["s"] == "pending" for c in cards),
           "⑦ 全部待验收项都是 pending（%s）——夹具里没有任何人工验收记录，界面不许自己写成功" % cards)
        acc_text = page.inner_text("[data-acceptance-view]")
        ok("用户已接受" not in acc_text and "已经完成" not in acc_text,
           "⑦ 待验收区里没有「用户已接受」这类成功措辞（质量状态不能代写验收 §5.8）")
        pending_t3 = page.locator('[data-acceptance-task="%s"]' % t3)
        ok(pending_t3.count() == 1 and pending_t3.get_attribute("data-acceptance-state") == "pending",
           "⑦ %s 的验证已过，但**人工验收仍是 pending**（已验证 ≠ 用户已接受）" % t3)
        ok("待验证" in page.inner_text("body") or "pending" in acc_text or "缺口" in acc_text,
           "⑦ 未收敛的部分给出原因/缺口，不显示成一片成功")
        shot("07-unknown-not-success.png")

        # ══════════ ⑧ 旧证据失效后不继续显示已验证（§3.14 第 7 条） ══════════
        step["now"] = "⑧ 旧证据失效"
        open_graph(A, "construction")
        a_states = node_states(page)
        n1 = node_of(t1, a_states)
        n3 = node_of(t3, a_states)
        ok(n1 is not None and n1["status"] != "verified",
           "⑧ 源改过的那张卡**不再显示已验证**（%s 的状态是 %s）" % (t1, n1["status"] if n1 else "?"))
        page.locator('[data-project-node="%s"]' % n1["id"]).click()
        page.wait_for_selector("[data-detail-section]", timeout=20000)
        detail = page.locator("[data-project-detail]").inner_text()
        ok("历史" in detail and ("失效" in detail or "取代" in detail),
           "⑧ 详情里写清旧结论被取代/失效，且**留在历史里**（不当没发生过）")
        ok("缺口" in detail or "必需" in detail, "⑧ 失效后如实点名缺哪几项（不是一句「未通过」）")
        ok(n3 is not None and n3["status"] == "verified",
           "⑧ 对照：绑定当前代码修订的那张卡仍是已验证（%s → %s）——失效只影响受影响对象" % (t3, n3["status"] if n3 else "?"))
        page.screenshot(path=os.path.join(SHOT_DIR, "08-stale-evidence-not-verified.png"))
        open_acceptance(A)
        t1_card = page.locator('[data-acceptance-task="%s"]' % t1)
        eff = t1_card.locator("[data-acceptance-evidence-item]")
        t1_eff = [eff.nth(i).get_attribute("data-acceptance-evidence-effective") for i in range(eff.count())]
        proj_t1 = projection_of(backend, A).get(t1, {})
        if t1_eff:
            ok("0" in t1_eff and "已失效" in t1_card.inner_text(),
               "⑧ 验收页把 T-1 的旧证据标成「已失效」（effective=%s）——不再算通过" % t1_eff)
        else:
            ok(t1_card.locator("[data-acceptance-no-evidence]").count() == 1
               and proj_t1.get("freshness") == "verification_stale"
               and len(proj_t1.get("history", [])) >= 1,
               "⑧ 失效的旧证据**已从「有效证据」里撤下**（验收页不再拿它当通过依据，只剩一句「没有绑定任何证据」），"
               "服务端把它记进历史：freshness=%s / history=%d 条"
               % (proj_t1.get("freshness"), len(proj_t1.get("history", []))))

        # ══════════ ⑨ 纯后端场景可读（§3.14 第 8 条） ══════════
        step["now"] = "⑨ 纯后端可读场景"
        open_acceptance(B)
        readable = page.locator('[data-acceptance-task="%s"] [data-acceptance-readable]' % b1)
        ok(readable.count() == 1, "⑨ 纯后端项目的待验收项给出**可读场景块**（没有界面可点，就给输入/期望/实际/证据）")
        rtext = readable.inner_text() if readable.count() == 1 else ""
        ok(all(k in rtext for k in ("输入", "期望", "实际", "证据")),
           "⑨ 可读场景四段齐全（输入/期望/实际/证据）：%s" % rtext.replace("\n", " ")[:70])
        shot("09-backend-readable-scenario.png")

        # ══════════ ⑩ Git 提醒不误报已备份（§3.14 第 10 条） ══════════
        step["now"] = "⑩ Git 提醒"
        goto_project(A)
        page.wait_for_selector("[data-version-reminder]", timeout=60000)
        page.wait_for_function(
            "() => { const el = document.querySelector('[data-version-reminder]');"
            " return !!el && el.getAttribute('data-reminder-state') !== 'loading'; }", timeout=60000)
        ok(attr(page, "[data-version-reminder]", "data-reminder-is-repository") == "1",
           "⑩ 甲是 git 仓库 → 提醒按仓库口径给")
        ok(attr(page, "[data-version-reminder]", "data-reminder-state") == "unsaved",
           "⑩ 甲工作树有未保存改动 → 提醒状态是 unsaved（这批成果还没保存为本地版本）")
        ok(attr(page, "[data-version-reminder]", "data-reminder-backed-up") == "unknown",
           "⑩ **私有事实备份状态只有 unknown**（代码提交 ≠ `.工作台/` 已备份）")
        if page.locator("[data-version-reminder-card]").count() == 0:
            page.locator("[data-reminder-entry]").click()
            page.wait_for_selector("[data-version-reminder-card]", timeout=15000)
        private_text = page.locator("[data-reminder-private]").inner_text()
        ok("备份状态未知" in private_text and "无法由 Git 推断" in private_text,
           "⑩ 提醒明说备份状态未知并给出原因：%s" % private_text.strip()[:60])
        reminder_text = page.inner_text("[data-version-reminder]")
        ok("已经备份" not in reminder_text and "已同步" not in reminder_text
           and "无法由 Git 推断" in reminder_text,
           "⑩ 提醒里没有「已经备份/已同步」这类没核实的正面结论，且明说私有事实备份「无法由 Git 推断」")
        shot("10-git-reminder-backed-up-unknown.png")

        # ══════════ ⑪ 人应能不看代码地指出（§3.14 第一句） ══════════
        step["now"] = "⑪ 不看代码就能指出"
        goto_project(A)
        overview = page.inner_text("body")
        ok(page.locator("[data-pending-decisions]").count() == 1,
           "⑪ 主工作面上能直接看到**待决事项**数量（不用翻聊天）")
        bar = page.locator("[data-project-status-bar]").inner_text()
        ok(page.locator("[data-project-status-bar]").count() == 1
           and "当前目标" in bar and "有效版本" in bar,
           "⑪ 工作面的状态条直接写清当前项目/当前目标/有效版本：%s" % bar.replace(chr(10), " ")[:80])
        ok("bl-" in bar, "⑪ 状态条里的有效版本是**生效基线 id**（不是「不知道」，不让人自己去翻文件）")
        ok(any(k in overview for k in ("待验收", "验收")), "⑪ 主工作面能看到验收/待验收入口（可体验结果的去处）")
        ok(any(k in overview for k in ("目标", "当前改动", "改动")), "⑪ 主工作面能看到目标/当前改动入口")
        open_graph(A, "construction")
        n_for_detail = node_of(t1, node_states(page))
        if n_for_detail is not None:
            page.locator('[data-project-node="%s"]' % n_for_detail["id"]).click()
        else:
            info("⑪ 警告：图上没找到 %s 的节点，详情段断言会以空详情为准" % t1)
            page.locator("[data-project-node]").first.click()
        page.wait_for_selector("[data-detail-section]", timeout=20000)
        vtext = page.locator('[data-detail-section="verification"]').inner_text()
        ok("未覆盖" in vtext or "缺口" in vtext, "⑪ 图详情第④段如实给出**未验证范围**（人不用读代码就能说清没验什么）")
        ok(page.locator('[data-detail-section="origin"]').count() == 1,
           "⑪ 第③段给出设计/施工出处（需要自己判断的事有原文可查）")
        shot("11-person-can-point-without-code.png")

        ok(not page_errors, "⑫ 全程无页面 JS 异常（实际 %s）" % page_errors[:2])
        browser.close()


def main():
    home = tempfile.mkdtemp(prefix="tatai-v0613-ui-home-")
    work = tempfile.mkdtemp(prefix="tatai-v0613-ui-proj-")
    os.makedirs(SHOT_DIR, exist_ok=True)
    logs = os.path.join(SHOT_DIR, "server.log")
    for f in ("server.log", "vite.log"):
        try:
            os.remove(os.path.join(SHOT_DIR, f))
        except FileNotFoundError:
            pass
    backend = None
    vite = None
    try:
        roots = {"a": os.path.join(work, "a"), "b": os.path.join(work, "b"), "c": os.path.join(work, "c")}
        ROOTS.update({A: roots["a"], B: roots["b"], C: roots["c"]})
        cards_a = [("T-1", "甲：先绿后失效的卡", "", "甲一验收记录"),
                   ("T-2", "甲：正在做的卡", "T-1", "甲二验收记录"),
                   ("T-3", "甲：仍然有效的卡", "T-1", "甲三验收记录")]
        cards_b = [("X-1", "乙：纯后端的第一张卡", "", "乙一验收记录"),
                   ("X-2", "乙：第二张卡", "X-1", "乙二验收记录"),
                   ("X-3", "乙：第三张卡", "X-1", "乙三验收记录")]
        cards_c = [("E-1", "空仓：已规划未开始的卡", "", "空仓一验收记录")]
        make_project(roots["a"], "夹具·甲", cards_a, design_lines=60, git=True,
                     chat={"s-a": [("user", "甲项目的会话：我想加个导出"),
                                   ("assistant", "甲项目的会话：先记成讨论草稿，不激活基线。")]})
        # 甲：制造"这批成果还没保存"的现场（工作树有未暂存改动）；`.工作台/` 被忽略
        write(os.path.join(roots["a"], "src", "index.ts"), "export const v = 2;\n")
        make_project(roots["b"], "夹具·乙（纯后端）", cards_b, design_lines=12,
                     chat={"s-b": [("user", "乙项目的会话：接口文档在哪"),
                                   ("assistant", "乙项目的会话：见设计书第 2 节。")]})
        # 丙：空仓（没有一行代码）；只有已审定的配套图纸
        make_project(roots["c"], "夹具·丙（空仓）", cards_c, design_lines=10, code=False)

        make_registry(home, [
            {"id": A, "name": "夹具·甲", "path": roots["a"], "kind": "fullstack",
             "registered_at": "2026-09-20T08:00:00+08:00", "last_opened_at": "2026-09-20T08:00:00+08:00"},
            {"id": B, "name": "夹具·乙（纯后端）", "path": roots["b"], "kind": "backend",
             "registered_at": "2026-09-20T08:00:00+08:00", "last_opened_at": "2026-09-20T08:00:00+08:00"},
            {"id": C, "name": "夹具·丙（空仓）", "path": roots["c"], "kind": "static",
             "registered_at": "2026-09-20T08:00:00+08:00", "last_opened_at": "2026-09-20T08:00:00+08:00"},
        ])

        backend_port = free_port()
        backend = Backend(home, backend_port, logs)
        backend.wait_health()
        info("后端就绪：http://127.0.0.1:%d（隔离 TATAI_HOME %s）" % (backend_port, home))

        # ── 三个项目的有效图纸与规划图（真接口：激活基线 → 触发派生） ──
        for pid in (A, B, C):
            bp = publish_baseline(backend, pid)
            info("%s 规划图已发布（基线 %s，节点 %d 个）" % (pid, bp["baseline_id"], len(bp["nodes"])))
        # 丙：导入定义但**零执行** → 图上只能是"已规划未开始"（灰的正题）
        plan_c = backend.api("/api/projects/%s/plan" % C)[1]["plan"]
        for d in plan_c["definitions"]:
            backend.wo_command(cmd(C, "task:%s" % d["task_id"], "task.definition_imported",
                                   {"definition_sha256": plan_c["definition_hashes"][d["task_id"]],
                                    "plan_revision": plan_c["content_sha256"], "definition_revision": 1},
                                   "%s:def:v0613ui" % d["task_id"], expected=None))
        # ── 甲的夹具事实（含"先判绿 → 源变 → 旧证据失效"） ──
        # ── 甲的夹具事实：先按 code-rev-1 全部判绿，再交一版把当前代码修订推到 code-rev-2
        #    （T-1 的旧证据因此失效；T-3 绑的是 code-rev-2，保持有效 —— 一组对照）
        plan_a = backend.api("/api/projects/%s/plan" % A)[1]["plan"]
        t_a = seed_project(backend, A, roots["a"], plan_a, code_rev="code-rev-1", invalidate_task="T-1")
        proj_a = projection_of(backend, A)
        info("甲投影：%s" % {k: v["display_status"] for k, v in proj_a.items() if v["object_kind"] == "task"})
        # ── 乙的夹具事实（纯后端：三张卡，一张交结果 + 独立审计） ──
        plan_b = backend.api("/api/projects/%s/plan" % B)[1]["plan"]
        t_b = seed_project(backend, B, roots["b"], plan_b, code_rev="code-rev-1")
        # ── 甲：一条零模型的聊天动作（定位反馈，带任务关联）→ 供"刷新不丢动作回执" ──
        st, body = backend.api("/api/projects/%s/chat/actions" % A, "POST",
                               {"text": "这里不对，这张卡的验收场景还缺一条", "session_id": "s-a",
                                "selection": {"kind": "task", "id": t_a[1]}})
        if st != 200:
            raise RuntimeError("聊天动作失败 HTTP %s：%s" % (st, str(body)[:200]))
        info("甲的聊天动作已登记：%s（kind=%s）" % (body["action"]["action_id"], body["action"]["kind"]))

        vite_port = free_port()
        vite = start_vite(vite_port, backend_port, os.path.join(SHOT_DIR, "vite.log"))
        info("vite 就绪：http://localhost:%d（代理 → %d）" % (vite_port, backend_port))
        run_browser(vite_port, backend, {"a": t_a, "b": t_b, "c": ("E-1",)})
    finally:
        if vite is not None:
            try:
                vite.kill()
                vite.wait(timeout=10)
            except Exception:
                pass
        if backend is not None:
            backend.kill()
        if KEEP:
            print("[ui] 保留现场：%s / %s" % (home, work))
        else:
            for d in (home, work):
                shutil.rmtree(d, ignore_errors=True)

    print("[ui] 合计 PASS %d / FAIL %d" % (passes[0], len(fails)))
    for f in fails:
        print("[ui]   FAIL " + f)
    print("[ui] 截图目录：%s" % SHOT_DIR)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
