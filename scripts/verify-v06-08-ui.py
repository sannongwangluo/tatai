#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V06-08 浏览器场景验证（Python + Playwright）：自用工作面与施工图页在**真实浏览器**里的行为。

用法：python scripts/verify-v06-08-ui.py
      （或 pnpm verify:v06-08-ui；V0608_KEEP_TMP=1 保留临时夹具现场）

why 必须跑真浏览器（PLAN.md V06-08 检查项 3）："实际切换三个隔离项目、断网重连、刷新、退回场景，
验证不串状态、不清空草稿、未知不显成功；待议处置持久化且 §3.5 附录 B 原文哈希不变、同文字不同
来源不误合并、采纳未实现不显示完工"——这些只能在实际 DOM 与真实 HTTP 上验，渲染函数级断言不算。

三条检查项逐条落到断言组（组号与 PLAN 卡面一一对应）：
  ① 主导航 = 项目图/设计书/施工图/聊天/实况与验收；终端移出用户主导航（维护诊断保留）；
     不加"下一步用什么工具/模型/档位"卡。
  ② 项目级草稿/选中/滚动隔离；待议可提出/采纳/驳回/被替代（带理由与关联修订/任务）且只追加
     decisions.jsonl；前端只给项目自己登记过的 http(s) 场景当链接；纯后端给可读场景。
  ③ 切三个隔离项目 / 断网重连 / 刷新 / 退回场景；待议处置持久化且附录 B 原文哈希不变；
     同文字不同来源不误合并；采纳未实现不显示完工。

隔离口径（AGENTS.md §5 / 卡面红线）：
  · 临时 TATAI_HOME + `tempfile` 下三个夹具项目，**绝不碰**三个真实项目的 `.工作台/`；
  · 塔台自身的本体哈希（repo 根 DESIGN.md，含附录 B 区段）在脚本首尾各算一次并断言不变——
    本脚本**不往里面追加任何待议**，待议处置只在夹具项目的 decisions.jsonl 上做；
  · 模型环节不参与（本卡零模型）：夹具事实全部经**真实 v2 写入服务**（`POST /api/work/command`）
    提交，证据正文按内容寻址写进夹具 `.工作台/work/evidence/`，不伪造读取结果；
  · 收尾杀净子进程、删临时目录（V0608_KEEP_TMP=1 可留现场）。
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
SHOT_DIR = os.path.join(REPO, ".工作台", "verify", "v06-08")
A = "v0608ui-a"
B = "v0608ui-b"
SELF = "v0608ui-self"
KEEP = os.environ.get("V0608_KEEP_TMP") == "1"

MAIN_NAV = ["项目图", "设计书", "施工图", "聊天", "实况与验收"]
APPENDIX_B = "## 附录 B：待议记录"

fails = []
passes = [0]
step = {"now": "启动"}


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

def design_md(title, lines):
    body = "\n".join(f"第 {i} 行：{title} 的正文内容，用来把设计书拉长到可滚动。" for i in range(lines))
    return (
        f"# {title}\n\n> 夹具：只用于 V06-08 浏览器场景（与 repo 根 DESIGN.md 同结构）。\n\n"
        "## 1 概述\n\n目标：夹具。\n\n"
        f"## 2 正文\n\n{body}\n"
    )


def plan_md(title, cards, extra_dep=""):
    rows = "\n".join(
        f"| {cid} | todo | {goal} | {dep} | {ev} |" for cid, goal, dep, ev in cards
    )
    sections = []
    for cid, goal, dep, ev in cards:
        sections.append(
            f"### {cid} {goal}\n\n"
            f"**设计依据**：§2。**依赖**：{dep or '无'}。\n\n"
            f"**文件责任**：`src/{cid.lower()}.ts`。\n\n"
            f"- [ ] {cid} 的验收检查项一\n- [ ] {cid} 的验收检查项二\n\n"
            f"**交付**：{ev}。\n"
        )
    return (
        f"# {title}\n\n> 夹具施工图。\n\n## 当前任务\n\n"
        "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |\n| --- | --- | --- | --- | --- |\n"
        f"{rows}\n\n" + "\n".join(sections)
    )


def discuss_md(entries):
    return (
        "# 待议记录\n\n> 夹具。\n\n" + "\n".join(f"- `{d}` {t}" for d, t in entries) + "\n"
    )


def make_registry(home, records):
    write(
        os.path.join(home, "registry.json"),
        json.dumps({"version": 1, "projects": records}, ensure_ascii=False, indent=2) + "\n",
    )


def appendix_b_of(text):
    start = text.find(APPENDIX_B)
    if start < 0:
        return None
    nxt = text.find("\n## ", start + len(APPENDIX_B))
    return text[start : (len(text) if nxt < 0 else nxt + 1)]


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def make_project(root, *, name, with_design, plan_cards, design_lines=6, discuss=None, self_managed=False):
    os.makedirs(root, exist_ok=True)
    if self_managed:
        write(os.path.join(root, "DESIGN.md"), design_md(f"{name} 设计", design_lines))
        write(os.path.join(root, "PLAN.md"), plan_md(f"{name} 施工图", plan_cards))
    else:
        if with_design:
            write(os.path.join(root, ".工作台", "design.md"), design_md(f"{name} 设计", design_lines))
        write(os.path.join(root, ".工作台", "plan.md"), plan_md(f"{name} 施工图", plan_cards))
    if discuss:
        if self_managed:
            text = read(os.path.join(root, "DESIGN.md"))
            text = text.rstrip("\n") + f"\n\n{APPENDIX_B}\n\n"
            text += "\n".join(f"- `{d}` {t}" for d, t in discuss) + "\n"
            write(os.path.join(root, "DESIGN.md"), text)
        else:
            write(os.path.join(root, ".工作台", "design.discuss.md"), discuss_md(discuss))
    write(os.path.join(root, "progress.json"), json.dumps({
        "version": 1,
        "gate": {"current_step": "develop", "history": [
            {"step": "kickoff", "result": "pass", "at": "2026-09-20T08:00:00+08:00", "note": "夹具"},
            {"step": "requirement", "result": "pass", "at": "2026-09-20T08:10:00+08:00", "note": "夹具"},
        ]},
        "modules": [{"id": "m1", "name": "夹具模块一", "status": "doing"}],
    }, ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(root, ".工作台", "tasks.json"), json.dumps({
        "version": 1,
        "tasks": [
            {"id": cid, "title": goal, "module_id": "m1", "status": "doing", "reporter": "fixture",
             "updated_at": "2026-09-20T09:00:00+08:00"}
            for cid, goal, _dep, _ev in plan_cards
        ],
    }, ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(root, ".工作台", "gate.jsonl"), "\n".join([
        json.dumps({"ts": "2026-09-20T08:00:00+08:00", "step": "kickoff", "result": "pass", "by": "user", "note": "夹具"}, ensure_ascii=False),
        json.dumps({"ts": "2026-09-20T08:10:00+08:00", "step": "requirement", "result": "pass", "by": "user", "note": "夹具"}, ensure_ascii=False),
    ]) + "\n")
    write(os.path.join(root, "src", "index.ts"), "export const v = 1;\n")
    write(os.path.join(root, "README.md"), f"# {name}\n\n夹具项目。\n")
    write(os.path.join(root, "package.json"), '{"name":"fixture"}\n')


def put_evidence(root, content, summary, kind="acceptance"):
    """按内容寻址把证据正文写进夹具的 `.工作台/work/evidence/`（与 evidence.ts 同格式）。"""
    sha = sha256(content)
    path = os.path.join(root, ".工作台", "work", "evidence", f"{sha}.json")
    write(path, json.dumps({
        "evidence_id": sha,
        "sha256": sha,
        "bytes": len(content.encode("utf-8")),
        "recovery_path": f"work/evidence/{sha}.json",
        "kind": kind,
        "summary": summary,
        "created_by": "fixture",
        "role": "agent",
        "binding": {"revision_kind": "code", "revision": "fixture-code-rev-1"},
        "source_ref": None,
        "created_at": "2026-09-20T09:30:00+08:00",
        "content_sha256": sha,
        "content": content,
    }, ensure_ascii=False, indent=2) + "\n")
    return sha


# ══════════════════════════════ 后端 ══════════════════════════════

class Backend:
    def __init__(self, home, port, log_path):
        self.home = home
        self.port = port
        env = dict(os.environ)
        env["TATAI_HOME"] = home
        env["TATAI_PORT"] = str(port)
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", os.path.join("src", "server", "index.ts")],
            cwd=REPO,
            env=env,
            stdout=open(log_path, "ab"),
            stderr=subprocess.STDOUT,
        )

    def api(self, path, method="GET", body=None, headers=None, timeout=120):
        return http(f"http://127.0.0.1:{self.port}{path}", method, body, timeout=timeout, headers=headers)

    def work_token(self):
        with open(os.path.join(self.home, "work-service.json"), encoding="utf-8") as f:
            return json.load(f)["token"]

    def wo_command(self, command):
        status, body = self.api(
            "/api/work/command", "POST", command, headers={"x-tatai-work-token": self.work_token()}
        )
        if status != 200:
            raise RuntimeError(f"v2 写入失败 HTTP {status}：{str(body)[:300]}")
        return body

    def wait_health(self, timeout=60):
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
        raise RuntimeError(f"后端 {self.port} 未就绪")

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
        ["node", os.path.join("node_modules", "vite", "bin", "vite.js"), "dev", "--port", str(port), "--strictPort"],
        cwd=REPO,
        env=env,
        stdout=open(log_path, "ab"),
        stderr=subprocess.STDOUT,
    )
    deadline = time.time() + 120
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("vite 起不来（进程已退出）")
        try:
            with urllib.request.urlopen(f"http://localhost:{port}/", timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"vite {port} 未就绪")


def cmd(project, entity, type_, payload, key, expected=None, actor="fixture", role="agent"):    return {
        "schema_version": 2,
        "project_id": project,
        "change_id": "v0608ui",
        "entity_id": entity,
        "expected_revision": expected,
        "type": type_,
        "actor_id": actor,
        "role": role,
        "idempotency_key": key,
        "payload": payload,
    }


def seed_project_facts(backend, pid):
    """把夹具的施工定义绑定 + 执行状态 + 结果提交 + 人工验收经**真实写入服务**提交。

    定义哈希与图纸修订都从服务端 `GET /plan` 现取（不自己算，避免"夹具算错哈希"变成假结论）。
    """
    status, body = backend.api(f"/api/projects/{pid}/plan")
    if status != 200:
        raise RuntimeError(f"读 plan 失败 HTTP {status}: {str(body)[:200]}")
    plan = body["plan"]
    rev = plan["content_sha256"]
    hashes = plan["definition_hashes"]
    ids = [d["task_id"] for d in plan["definitions"]]
    rev_no = 0
    for tid in ids:
        rev_no += 1
        backend.wo_command(cmd(pid, f"task:{tid}", "task.definition_imported",
                               {"definition_sha256": hashes[tid], "plan_revision": rev, "definition_revision": 1},
                               f"{tid}:def:v0608ui", expected=None))
    return plan, rev


def seed_states(backend, pid, plan):
    """T-1 结果已提交（带证据）、T-2 执行中、T-3 就绪。"""
    ids = [d["task_id"] for d in plan["definitions"]]
    t1, t2, t3 = ids[0], ids[1], ids[2]
    backend.wo_command(cmd(pid, f"task:{t1}", "task.status_changed", {"status": "executing"},
                           f"{t1}:st1:v0608ui", expected=1))
    backend.wo_command(cmd(pid, f"task:{t1}", "task.result_submitted",
                           {"definition_sha256": plan["definition_hashes"][t1], "plan_revision": plan["content_sha256"]},
                           f"{t1}:st2:v0608ui", expected=2))
    backend.wo_command(cmd(pid, f"task:{t2}", "task.status_changed", {"status": "executing"},
                           f"{t2}:st1:v0608ui", expected=1))
    backend.wo_command(cmd(pid, f"task:{t3}", "task.status_changed", {"status": "ready"},
                           f"{t3}:st1:v0608ui", expected=1))
    return t1, t2, t3


# ══════════════════════════════ 浏览器断言 ══════════════════════════════

def wait_for_attr(page, selector, attr, value, timeout_ms):
    """条件等待：某元素上的某属性变成目标值（返回 True/False，不抛）。

    断网/重连这类**时序**断言一律用它——固定 sleep 会看运气（第一次跑就在
    「恢复连接后自动重连」那一条上偶发翻车）。"""
    try:
        page.wait_for_function(
            "([sel, a, v]) => { const el = document.querySelector(sel);"
            " return !!el && el.getAttribute(a) === v; }",
            arg=[selector, attr, value],
            timeout=timeout_ms,
        )
        return True
    except Exception:
        return False


def run_browser(vite_port, backend_port, backend, roots, t_ids):
    os.makedirs(SHOT_DIR, exist_ok=True)
    t1, t2, t3 = t_ids["a"]
    x1 = t_ids["b"][0]
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        base = f"http://localhost:{vite_port}"

        def shot(name):
            page.screenshot(path=os.path.join(SHOT_DIR, name))

        def open_view(pid, view_key, wait_sel, timeout=60000):
            page.goto(f"{base}/#p/{pid}", wait_until="domcontentloaded")
            page.wait_for_selector(f'button[data-view="{view_key}"]', timeout=timeout)
            page.locator(f'button[data-view="{view_key}"]').click()
            page.wait_for_selector(wait_sel, timeout=timeout)
            page.wait_for_timeout(300)

        def open_chat(pid):
            page.goto(f"{base}/#p/{pid}", wait_until="domcontentloaded")
            page.wait_for_selector('button[data-view="chat"]', timeout=60000)
            page.locator('button[data-view="chat"]').click()
            page.wait_for_selector("[data-chat-input]", timeout=30000)
            page.wait_for_timeout(300)

        def open_plan(pid):
            open_view(pid, "plan", "[data-plan-view]")

        def open_design(pid):
            open_view(pid, "design", "[data-discuss-view]")

        def open_acceptance(pid):
            open_view(pid, "live", "[data-live-page]")
            page.locator('[data-live-sub="acceptance"]').click()
            page.wait_for_selector("[data-acceptance-view]", timeout=30000)
            page.wait_for_timeout(400)

        # ══════════════ ① 主导航 = 五页；终端移出主导航；不加工具/模型/档位卡 ══════════════
        step["now"] = "① 主导航"
        page.goto(f"{base}/#p/{A}", wait_until="domcontentloaded")
        page.wait_for_selector('button[data-view="arch"]', timeout=60000)
        page.wait_for_timeout(500)
        main_labels = page.eval_on_selector_all(
            "nav[data-main-nav] button", "els => els.map(e => (e.innerText||'').trim())"
        )
        ok(main_labels == MAIN_NAV, f"① 主导航恰为 {MAIN_NAV}（实际 {main_labels}）")
        ok(page.locator('nav[data-main-nav] button[data-view="terminal"]').count() == 0,
           "① 终端不在用户主导航里（§3.1 明令移除）")
        ok(page.locator('nav[data-aux-nav] button[data-view="terminal"]').count() == 1,
           "① 终端移到辅助入口并标注「维护诊断」（保留下 xterm.js/node-pty 与服务端 PTY 通道）")
        body_text = page.inner_text("body")
        no_guide = all(w not in body_text for w in ("下一步用什么", "推荐模型", "档位"))
        ok(no_guide, "① 页面上没有「下一步用什么工具/模型/档位」教学卡（§3.1 / §12.1）")
        # §3.11：必要待决事项在主工作面可见，并且能一键去处理
        pending = page.locator("[data-pending-decisions]")
        pv = pending.get_attribute("data-pending-decisions") if pending.count() == 1 else None
        ok(pending.count() == 1 and pv not in (None, "unknown"),
           f"① 主工作面显示必要待决事项数量（§3.11；实际 data-pending-decisions={pv}）")
        ok(pv == "2", f"① 待决数量 = 甲项目两条未处置的待议（实际 {pv}）")
        pending.click()
        page.wait_for_selector("[data-discuss-view]", timeout=30000)
        ok(page.locator("[data-discuss-entry]").count() == 2,
           "① 点「待决事项」→ 直接跳到设计书的待议区（两件事就在眼前，不用自己找）")
        page.screenshot(path=os.path.join(SHOT_DIR, "01b-pending-decisions.png"))
        # 源码级护栏：依赖与后端 PTY 通道一个字都没删
        pkg = read(os.path.join(REPO, "package.json"))
        ok('"@xterm/xterm"' in pkg and '"node-pty"' in pkg and '"@xterm/addon-fit"' in pkg,
           "① package.json 里 @xterm/xterm / @xterm/addon-fit / node-pty 三个依赖仍在")
        ok(os.path.exists(os.path.join(REPO, "src", "server", "pty.ts"))
           and "createTermMatch" in read(os.path.join(REPO, "src", "server", "index.ts")),
           "① 后端 PTY 通道（src/server/pty.ts + 终端路由）仍在")
        shot("01-main-nav.png")

        # ══════════════ ② 项目图默认功能全景；旧三图仍在技术详情里 ══════════════
        step["now"] = "② 项目图默认功能全景"
        page.goto(f"{base}/#p/{A}", wait_until="domcontentloaded")
        page.locator('button[data-view="arch"]').click()
        page.wait_for_selector('[data-project-view-tab="functional"]', timeout=60000)
        page.wait_for_timeout(600)
        ok(page.locator('[data-arch-tab="functional"]').count() == 1,
           "② 项目图默认落在「功能全景」（§3.1：项目图默认展示功能全景；V06-06 缓办的默认落点在本卡切过来）")
        ok(page.locator("[data-arch-mode]").count() == 0,
           "② 默认不再落在「技术详情 · 方框图」")
        ok(page.locator('[data-project-view-tab="tech"]').count() == 1,
           "② 技术详情入口仍在（旧三图一个都没删）")
        page.locator('[data-project-view-tab="tech"]').click()
        page.wait_for_selector('[data-graph-mode="MODULE_BOX"]', timeout=30000)
        page.wait_for_selector("[data-arch-mode]", timeout=60000)
        ok(page.locator('[data-graph-mode="MODULE_BOX"]').count() == 1
           and page.locator('[data-graph-mode="DATA_FLOW"]').count() == 1
           and page.locator('[data-graph-mode="MIND_MAP"]').count() == 1,
           "② 点进技术详情仍有方框图 / 数据流向图 / 思维导图三个切换口")
        shot("02-project-graph-default-functional.png")

        # ══════════════ ③ 施工图页：定义 + 状态、筛选、卡片↔原文双向定位 ══════════════
        step["now"] = "③ 施工图页"
        open_plan(A)
        cards = page.locator("[data-plan-card]").count()
        ok(cards == 3, f"③ 施工图页按卡号列出 {cards} 张卡（定义来自 .工作台/plan.md）")
        ok(page.locator(f'[data-plan-card="{t1}"] [data-plan-card-status-label]').inner_text().find("结果已提交") >= 0,
           "③ 卡片同时给出运行状态（TaskState，来自已提交事件）")
        ok("定义 rev" in page.locator(f'[data-plan-card="{t1}"] [data-plan-card-revision]').inner_text(),
           "③ 卡片同时给出定义修订（TaskDefinition，定义与状态分开显示 §2.6）")
        ok(page.locator(f'[data-plan-card="{t2}"] [data-plan-card-dependency]').count() == 1,
           "③ 有依赖的卡显示依赖卡号")
        # 状态筛选
        page.select_option("[data-plan-status-filter]", "result_submitted")
        page.wait_for_timeout(250)
        shown = page.locator("[data-plan-card]").count()
        note = page.locator("[data-plan-count]").inner_text()
        ok(shown == 1 and t1 in page.locator("[data-plan-cards]").inner_text(),
           f"③ 按状态筛选（结果已提交）→ 只剩 {shown} 张（{note.strip()[:40]}…）")
        ok("隐藏 2 张" in note, "③ 筛选后明说隐藏了几张（不因隐藏节点呈现「全部完成」§3.3）")
        page.select_option("[data-plan-status-filter]", "all")
        page.wait_for_timeout(200)
        # 依赖筛选
        page.select_option("[data-plan-dep-filter]", "has")
        page.wait_for_timeout(250)
        ok(page.locator("[data-plan-card]").count() == 2, "③ 按依赖筛选（有依赖）→ 2 张")
        page.select_option("[data-plan-dep-filter]", "all")
        page.wait_for_timeout(200)
        # 卡片 → 原文
        page.locator(f'[data-plan-card="{t2}"]').click()
        page.wait_for_selector(f'[data-plan-excerpt="{t2}"]', timeout=15000)
        excerpt = page.locator(f'[data-plan-excerpt="{t2}"]').inner_text()
        ok(f"原文出处 · {t2}" in excerpt and "设计依据" in excerpt,
           f"③ 点卡片 → 右侧给出它在原文里的小节与表格行（{t2}）")
        ok(page.locator(f'[data-plan-excerpt="{t2}"] [data-plan-excerpt-row]').count() == 1,
           "③ 原文出处带行号（表格行原文）")
        # 原文 → 卡片（双向定位的另一半）
        page.locator(f'[data-plan-source-task="{t1}"]').click()
        page.wait_for_timeout(250)
        ok(page.locator(f'[data-plan-card="{t1}"][data-plan-selected="1"]').count() == 1,
           "③ 点原文里的表格行 → 反过来选中那张卡（双向定位）")
        shot("03-plan-view.png")

        # ══════════════ ④ 项目级隔离：页面 / 选中项 / 滚动位置 ══════════════
        step["now"] = "④ 项目级隔离"
        ok(page.locator('[data-view="plan"]').count() >= 1, "④ 前置：甲项目当前页是「施工图」")
        open_plan(B)
        ok(page.locator("[data-plan-view]").count() == 1 and page.locator(f'[data-plan-card="{x1}"]').count() == 1,
           "④ 切到乙项目：页签保留（施工图），但卡片是乙项目自己的（不串状态）")
        # 乙项目的卡与甲不同
        ok(page.locator(f'[data-plan-card="{t1}"]').count() == 0,
           "④ 乙项目的施工图里没有甲项目的卡（项目级隔离）")
        open_plan(A)
        ok(page.locator(f'[data-plan-card="{t1}"][data-plan-selected="1"]').count() == 1,
           "④ 切回甲项目：选中项还在（§3.1 切项目保留各自的选中项）")
        # 滚动位置隔离（设计书页够长）
        open_design(A)
        page.eval_on_selector("[data-view-host]", "el => { el.scrollTop = 900; }")
        page.wait_for_timeout(400)
        scroll_a = page.eval_on_selector("[data-view-host]", "el => el.scrollTop")
        open_design(B)
        page.wait_for_timeout(400)
        scroll_b = page.eval_on_selector("[data-view-host]", "el => el.scrollTop")
        ok(scroll_b == 0, f"④ 乙项目设计书从头开始（scrollTop={scroll_b}）")
        open_design(A)
        page.wait_for_timeout(600)
        scroll_a2 = page.eval_on_selector("[data-view-host]", "el => el.scrollTop")
        ok(scroll_a > 500 and abs(scroll_a2 - scroll_a) <= 40,
           f"④ 切回甲项目：滚动位置还原（{scroll_a} → {scroll_a2}；§3.1 保留滚动位置）")
        shot("04-project-isolation.png")

        # ══════════════ ⑤ 未发草稿：切项目不串稿 + 刷新不丢 ══════════════
        step["now"] = "⑤ 未发草稿"
        open_chat(A)
        page.fill("[data-chat-input]", "甲项目的未发草稿")
        open_chat(B)
        ok(page.input_value("[data-chat-input]") == "", "⑤ 切到乙项目：输入框是空的（草稿不串项目）")
        open_chat(A)
        ok(page.input_value("[data-chat-input]") == "甲项目的未发草稿", "⑤ 切回甲项目：未发草稿还在")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("[data-chat-input]", timeout=60000)
        page.wait_for_timeout(500)
        ok(page.input_value("[data-chat-input]") == "甲项目的未发草稿",
           "⑤ **刷新**后未发草稿还在（§3.14「刷新不丢草稿」；草稿按项目存在 sessionStorage）")
        shot("05-draft-survives-reload.png")
        page.fill("[data-chat-input]", "")

        # ══════════════ ⑥ 待议处置：提出/采纳/驳回/被替代 + 持久化 + 同文字不合并 + 附录 B 不变 ══════════════
        step["now"] = "⑥ 待议处置"
        repo_design_sha_before = sha256(read(os.path.join(REPO, "DESIGN.md")))
        self_design_path = os.path.join(roots["self"], "DESIGN.md")
        self_design_before = read(self_design_path)
        self_appendix_before = sha256(appendix_b_of(self_design_before) or "")
        open_design(SELF)
        entries = page.locator("[data-discuss-entry]").count()
        ok(entries == 3, f"⑥ 自举夹具的待议记录列出 {entries} 条（本体 = 它的 DESIGN.md 附录 B）")
        texts = page.eval_on_selector_all("[data-discuss-entry]", "els => els.map(e => e.innerText)")
        ok(texts[0].split("定位：")[0].strip() == texts[1].split("定位：")[0].strip(),
           "⑥ 前置：第 0、1 条待议**文字完全相同**（用来验「同文字不同来源不误合并」）")
        # 提出 → 采纳（关联一张还未实现的卡）→ 看是否谎报完工
        page.fill("[data-discuss-reason='0']", "夹具：先提出")
        page.click("[data-discuss-action='proposed'][data-discuss-action-index='0']")
        page.wait_for_timeout(1200)
        ok(page.locator('[data-discuss-entry][data-discuss-index="0"][data-discuss-state="proposed"]').count() == 1,
           "⑥ 待议「提出」落成派生态 proposed")
        page.fill("[data-discuss-reason='0']", "夹具：采纳，关联任务 T-1")
        page.fill("[data-discuss-related-task='0']", t1)
        page.click("[data-discuss-action='accepted'][data-discuss-action-index='0']")
        page.wait_for_timeout(1500)
        ok(page.locator('[data-discuss-entry][data-discuss-index="0"][data-discuss-state="accepted"]').count() == 1,
           "⑥ 待议「采纳」落成派生态 accepted（带理由与关联任务）")
        impl = page.locator('[data-discuss-entry][data-discuss-index="0"] [data-discuss-implementation]')
        ok(impl.count() == 1 and impl.get_attribute("data-discuss-implemented") == "0",
           "⑥ **采纳未实现不显示完工**：关联任务未获用户验收 → data-discuss-implemented=0")
        ok("采纳不等于已实现" in impl.inner_text(),
           f"⑥ 采纳卡片明写「采纳不等于已实现」：{impl.inner_text()[:60]}…")
        # 驳回（第 2 条）
        page.fill("[data-discuss-reason='2']", "夹具：驳回，理由写清")
        page.click("[data-discuss-action='rejected'][data-discuss-action-index='2']")
        page.wait_for_timeout(1500)
        ok(page.locator('[data-discuss-entry][data-discuss-index="2"][data-discuss-state="rejected"]').count() == 1,
           "⑥ 待议「驳回」落成派生态 rejected")
        # 被替代（第 1 条）
        page.fill("[data-discuss-reason='1']", "夹具：被替代")
        page.fill("[data-discuss-related-revision='1']", "0" * 64)
        page.click("[data-discuss-action='superseded'][data-discuss-action-index='1']")
        page.wait_for_timeout(1500)
        ok(page.locator('[data-discuss-entry][data-discuss-index="1"][data-discuss-state="superseded"]').count() == 1,
           "⑥ 待议「被替代」落成派生态 superseded")
        ok(page.locator('[data-discuss-entry][data-discuss-index="0"][data-discuss-state="accepted"]').count() == 1,
           "⑥ **同文字不同来源不误合并**：第 1 条被替代后，文字相同的第 0 条仍是「已采纳」")
        # 只追加 + 持久化
        decisions_path = os.path.join(roots["self"], ".工作台", "decisions.jsonl")
        ok(os.path.exists(decisions_path), "⑥ 处置记录落在 `.工作台/decisions.jsonl`（只追加，§3.5）")
        lines = [l for l in read(decisions_path).splitlines() if l.strip()]
        recs = [json.loads(l) for l in lines]
        ok(len(recs) == 4 and all(r.get("discussion_ref", {}).get("content_sha256") for r in recs),
           f"⑥ decisions.jsonl 有 {len(recs)} 条处置记录，每条都带 discussion_ref（原源/序号/原文哈希）")
        ok(all(r["discussion_ref"]["source"] for r in recs) and recs[0]["action"] == "proposed",
           "⑥ 记录含原源与动作序（提出 → 采纳 → 被替代 → 驳回）")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("[data-discuss-view]", timeout=60000)
        page.wait_for_timeout(800)
        ok(page.locator('[data-discuss-entry][data-discuss-index="0"][data-discuss-state="accepted"]').count() == 1,
           "⑥ 刷新后处置派生态仍在（持久化：界面据 decisions.jsonl 派生）")
        # 原文哈希不变（待议本体一个字节都没改）
        self_design_after = read(self_design_path)
        ok(self_design_after == self_design_before,
           "⑥ 处置后自举夹具的 DESIGN.md **逐字节不变**（不改待议原文）")
        ok(sha256(appendix_b_of(self_design_after) or "") == self_appendix_before,
           "⑥ 附录 B 区段哈希不变（首尾哈希对照）")
        ok(sha256(read(os.path.join(REPO, "DESIGN.md"))) == repo_design_sha_before,
           "⑥ repo 根 DESIGN.md（塔台自身附录 B 本体）全程哈希不变——本卡一个字节都没动它")
        shot("06-discuss-disposition.png")

        # ══════════════ ⑦ 断网重连：不清空最后成功数据 + 显示观测时间 ══════════════
        step["now"] = "⑦ 断网重连"
        open_view(A, "live", "[data-live-view]")
        page.wait_for_timeout(1500)
        before_observed = page.locator("[data-live-observed]").inner_text()
        before_stage = page.locator("[data-live-stage]").inner_text()
        ok("观测时间：" in before_observed and "还没有成功观测" not in before_observed,
           f"⑦ 实况页显示观测时间：{before_observed.strip()}")
        blocker = lambda route: route.abort()
        page.route("**/api/**", blocker)
        stale_ok = wait_for_attr(page, "[data-live-view]", "data-live-stale", "1", 30000)
        page.wait_for_timeout(1500)
        ok(stale_ok,
           "⑦ 断网后快照标「刷新失败/状态未知」（不把数据源没回话误诊成项目卡死）")
        ok(page.locator("[data-live-stage]").inner_text() == before_stage,
           "⑦ **自动重连不清空最后成功数据**：断网期间阶段大字仍是上次成功的值")
        ok(page.locator("[data-live-observed]").inner_text() == before_observed,
           "⑦ 观测时间在失败期间不推进（一眼看出看到的是什么时候的事实）")
        ok(page.locator("[data-project-item]").count() == 3,
           "⑦ 断网期间左栏项目列表不被清空（最后成功读到的 3 个项目还在）")
        page.unroute("**/api/**", blocker)
        ok(wait_for_attr(page, "[data-live-view]", "data-live-stale", "0", 40000),
           "⑦ 恢复连接后自动重连成功（data-live-stale 回到 0）")
        after_observed = page.locator("[data-live-observed]").inner_text()
        ok(after_observed != before_observed, f"⑦ 重连后观测时间前推（{before_observed.strip()} → {after_observed.strip()}）")
        shot("07-reconnect-keeps-last-good.png")

        # ══════════════ ⑧ 验收页：待验收区 / 有效场景证据 / 接受与退回 / 未知不显成功 ══════════════
        step["now"] = "⑧ 验收页"
        gate_path = os.path.join(roots["a"], ".工作台", "gate.jsonl")
        gate_before = read(gate_path)
        open_acceptance(A)
        ok(page.locator("[data-acceptance-view]").count() == 1, "⑧ 实况与验收页的「验收」子页签可用")
        ok(page.locator(f'[data-acceptance-task="{t2}"][data-acceptance-state="accepted"]').count() == 1,
           f"⑧ 已有人工验收记录的 {t2} 显示 accepted（记录来自 v2 事件，不是前端猜的）")
        pending_card = page.locator(f'[data-acceptance-task="{t1}"]')
        ok(pending_card.get_attribute("data-acceptance-state") == "pending",
           f"⑧ 没有用户验收记录的 {t1} 是 pending（**未知不显成功**）")
        ok("用户已接受" not in pending_card.inner_text(),
           "⑧ 待验收项上没有「用户已接受」这类成功措辞")
        ok(pending_card.locator("[data-acceptance-display]").count() == 1,
           "⑧ 待验收项同时给出真实状态与原因（§3.10）")
        # 有效场景证据
        ev_items = pending_card.locator("[data-acceptance-evidence-item]")
        ok(ev_items.count() >= 1 and ev_items.first.get_attribute("data-acceptance-evidence-effective") == "1",
           "⑧ 有效场景证据逐条标「有效」（证据按内容寻址，读时复核哈希）")
        ok("有效" in pending_card.locator("[data-acceptance-evidence]").inner_text(),
           "⑧ 证据项明写有效/已失效（源变了的不再算通过 §5.6）")
        # 结果链接：只把项目自己登记过的 http(s) 场景渲染成链接，且不跑任意协议
        links = page.eval_on_selector_all(
            "[data-result-link]", "els => els.map(e => ({href: e.getAttribute('href'), rel: e.getAttribute('rel')}))"
        )
        ok(any(l["href"].startswith("http://") for l in links),
           f"⑧ 项目登记过的 http(s) 场景渲染成可打开链接（{links[:2]}）")
        ok(all(l["rel"] and "noreferrer" in l["rel"] for l in links),
           "⑧ 结果链接带 rel=noreferrer noopener（受控打开，不把壳顶掉）")
        bad_links = page.eval_on_selector_all(
            "a[href]", "els => els.filter(e => /^(javascript|file|data):/i.test(e.getAttribute('href')||'')).length"
        )
        ok(bad_links == 0, "⑧ 页面上没有任何 javascript:/file:/data: 协议链接（不跑任意协议）")
        ok(page.locator(f'[data-acceptance-task="{t3}"] [data-acceptance-readable]').count() == 1,
           "⑧ 纯后端项目给可读场景（输入/期望/实际/证据）")
        read_text = page.locator(f'[data-acceptance-task="{t1}"] [data-acceptance-readable]').inner_text()
        ok(all(k in read_text for k in ("输入", "期望", "实际", "证据")),
           "⑧ 可读场景四段齐全（输入/期望/实际/证据）")
        shot("08-acceptance-pending.png")
        # 退回场景
        page.fill(f'[data-acceptance-note="{t1}"]', "退回原因：集成检查还没做")
        page.click(f'[data-acceptance-reject="{t1}"]')
        page.wait_for_timeout(2500)
        ok(page.locator(f'[data-acceptance-task="{t1}"][data-acceptance-state="rejected"]').count() == 1,
           "⑧ 点「退回」→ 该任务变 rejected（用户本人记录，§3.14）")
        card_text = page.locator(f'[data-acceptance-task="{t1}"]').inner_text()
        ok("退回原因：集成检查还没做" in card_text, "⑧ 退回原因留痕并上屏（§3.10 待验收区聚合退回原因）")
        ok("已退回" in page.locator("[data-acceptance-counts]").inner_text()
           and page.locator("[data-acceptance-rejected-count]").inner_text() == "1",
           "⑧ 待验收区计数更新（已退回 1）")
        gate_after = read(gate_path)
        ok(gate_before == gate_after,
           "⑧ 人工验收**没有**改用户 Gate（gate.jsonl 逐字节不变；§5.8 两件事分开记）")
        # 再接受（两个方向都走一遍）
        page.click(f'[data-acceptance-accept="{t1}"]')
        page.wait_for_timeout(2500)
        ok(page.locator(f'[data-acceptance-task="{t1}"][data-acceptance-state="accepted"]').count() == 1,
           "⑧ 再点「接受」→ 变 accepted（状态由真实回执刷新，不乐观上屏）")
        # 阶段摘要（§3.4：放在实况与验收页）
        page.click("[data-acceptance-stage-toggle]")
        page.wait_for_selector("[data-gate-timeline]", timeout=30000)
        ok(page.locator("[data-gate-timeline]").count() == 1,
           "⑧ 阶段摘要（用户 Gate 时间线）在实况与验收页里仍在（§3.4）")
        shot("09-acceptance-rejected-accepted.png")

        ok(not page_errors, f"⑨ 全程无页面 JS 异常（实际 {page_errors[:2]}）")
        browser.close()


def main():
    home = tempfile.mkdtemp(prefix="tatai-v0608-ui-home-")
    work = tempfile.mkdtemp(prefix="tatai-v0608-ui-proj-")
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
        root_a = os.path.join(work, "a")
        root_b = os.path.join(work, "b")
        root_self = os.path.join(work, "self")
        cards_a = [
            ("T-1", "甲：导入能力", "", "甲一验收记录"),
            ("T-2", "甲：导出能力", "T-1", "甲二验收记录"),
            ("T-3", "甲：报表能力", "T-1、用户本轮授权", "甲三验收记录"),
        ]
        cards_b = [
            ("X-1", "乙：唯一一张卡", "", "乙一验收记录"),
            ("X-2", "乙：第二张卡", "X-1", "乙二验收记录"),
        ]
        cards_self = [("T-1", "自举：唯一一张卡", "", "自举验收记录")]
        make_project(root_a, name="夹具·甲", with_design=True, plan_cards=cards_a, design_lines=140,
                     discuss=[("2026-09-20", "甲：两条文字相同的待议"), ("2026-09-20", "甲：第二条不同文字")])
        make_project(root_b, name="夹具·乙", with_design=True, plan_cards=cards_b, design_lines=20,
                     discuss=[("2026-09-21", "乙：待议条目")])
        make_project(root_self, name="夹具·自举", with_design=False, plan_cards=cards_self, design_lines=30,
                     discuss=[("2026-09-20", "自举场景：同样文字不同来源"),
                              ("2026-09-20", "自举场景：同样文字不同来源"),
                              ("2026-09-20", "自举场景：第三条第")],
                     self_managed=True)
        roots = {"a": root_a, "b": root_b, "self": root_self}
        make_registry(home, [
            {"id": A, "name": "夹具·甲", "path": root_a, "kind": "fullstack",
             "registered_at": "2026-09-20T08:00:00+08:00", "last_opened_at": "2026-09-20T08:00:00+08:00"},
            {"id": B, "name": "夹具·乙", "path": root_b, "kind": "backend",
             "registered_at": "2026-09-20T08:00:00+08:00", "last_opened_at": "2026-09-20T08:00:00+08:00"},
            {"id": SELF, "name": "夹具·自举", "path": root_self, "kind": "static", "self_managed": True,
             "registered_at": "2026-09-20T08:00:00+08:00", "last_opened_at": "2026-09-20T08:00:00+08:00"},
        ])

        backend_port = free_port()
        backend = Backend(home, backend_port, logs)
        backend.wait_health()
        info(f"后端就绪：http://127.0.0.1:{backend_port}（隔离 TATAI_HOME {home}）")

        # ── 夹具事实：经真实写入服务提交（定义绑定 → 执行状态 → 结果提交 → 人工验收） ──
        plan_a, rev_a = seed_project_facts(backend, A)
        seed_project_facts(backend, B)
        seed_project_facts(backend, SELF)
        t1, t2, t3 = seed_states(backend, A, plan_a)
        sha_ok = put_evidence(root_a, "夹具证据：T-1 自检输出\nexit 0\n", "T-1 自检输出（夹具）", "self_check")
        sha_acc = put_evidence(root_a, "夹具证据：验收场景截图说明\n", "验收场景输入/期望/实际（夹具）", "acceptance")
        backend.wo_command(cmd(A, "submission:sub-T-1", "audit.submission_submitted", {
            "goal": "甲：导入能力交付", "task_id": t1, "round": 1, "baseline": {},
            "changed_files": ["src/import.ts"],
            "commands": [{"command": "pnpm test import", "exit_code": 0, "output_ref": None}],
            "untested": [{"item": "十万行性能", "reason": "夹具未跑"}],
            "known_issues": ["夹具已知问题一条"],
            "evidence_refs": [sha_ok], "binding": {"revision_kind": "code", "revision": "fixture-code-rev-1"},
            "submitted_by": "fixture-agent",
        }, "sub-T-1:v0608ui", expected=None))
        # 作者自检一条（**自检不是独立审计**，§5.5）：让 T-1 有一条真绑证据的检查项，
        # 但必需项没凑齐 → 显示仍停在「待验证」，用来验"未知不显成功"
        backend.wo_command(cmd(A, "check:chk-T-1", "audit.self_check_recorded", {
            "task_id": t1, "round": 1, "checked_by": "fixture-agent",
            "checks": [{"check_id": f"{t1}::check:0", "method": "命令", "command": "pnpm test import",
                        "exit_code": 0, "output_ref": None, "evidence_sha256": sha_ok, "verifies": "code"}],
            "conclusion": "pass",
            "binding": {"revision_kind": "code", "revision": "fixture-code-rev-1"},
        }, "chk-T-1:v0608ui", expected=None))
        backend.wo_command(cmd(A, "acceptance:acc-T-2", "audit.human_acceptance_recorded", {
            "decision": "accept", "task_id": t2, "batch_id": None,
            "scenario_refs": ["http://127.0.0.1:3457/result", "走一遍导入流程"],
            "baseline": {}, "evidence_refs": [sha_acc], "accepted_by": "user",
            "note": "夹具：用户已接受",
        }, "acc-T-2:v0608ui", expected=None, actor="user", role="user"))
        info("夹具事实已提交（定义绑定 + 三态 + 结果提交 + 一条人工验收 + 两份证据正文）")

        # 静态解析一次（A 的真实现场）：让技术详情里的旧三图有节点可画，
        # "旧三图一个都没删"就能在真画布上断言，而不是只看按钮在不在
        st, body = backend.api(f"/api/projects/{A}/arch/parse", "POST", {})
        if st != 200:
            raise RuntimeError(f"arch/parse 失败 HTTP {st}: {str(body)[:200]}")
        info("夹具·甲 静态解析完成（arch/modules.json 已落盘）")

        vite_port = free_port()
        vite = start_vite(vite_port, backend_port, os.path.join(SHOT_DIR, "vite.log"))
        info(f"vite 就绪：http://localhost:{vite_port}（代理 → {backend_port}）")
        run_browser(vite_port, backend_port, backend, roots, {"a": (t1, t2, t3), "b": ("X-1",)})
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
            print(f"[ui] 保留现场：{home} / {work}")
        else:
            for d in (home, work):
                try:
                    shutil.rmtree(d, ignore_errors=True)
                except Exception:
                    pass

    print(f"[ui] 合计 PASS {passes[0]} / FAIL {len(fails)}")
    for f in fails:
        print("[ui]   FAIL " + f)
    print(f"[ui] 截图目录：{SHOT_DIR}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
