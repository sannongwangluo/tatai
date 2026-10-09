#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-26 UI 真机验证：正向工作面**统一自动对账 + 旧请求保护**（真浏览器 + 真隔离后端 + 动态端口）。

用法：python scripts/verify-progress-ui.py
      V0926_REPO 指定被测仓库根（默认为本脚本所在仓库；红例时指向 HEAD 快照）
      V0926_SHOT_DIR 截图目录    V0926_KEEP_TMP=1 保留现场    V0926_LABEL 本次运行标签

覆盖（PLAN.md V09-26 验收 + docs/forward-progress-contract.md F2）：
  · 不点击刷新时，真服务写事件后：施工图卡状态词 / 验收执行态 / 顶栏当前目标自动变化；
  · 账户外（文档/Gate）只有文件变化也追平：只改 progress.json（Gate）→ Gate 时间线自动更新；
  · 技术详情状态投影层 / 数据流目标语义层自动重取（计数递增）；
  · 验收输入在后台对账与切项目后保留、且不串项目；
  · 延迟旧响应 + 快速切项目：新项目界面不被旧项目回包污染；
  · 读失败：保留最后成功数据 + 标陈旧 + 最近成功时间；恢复后自行清除。

隔离口径（AGENTS.md §5）：临时 TATAI_HOME + 夹具项目（两个）+ 动态空闲端口（后端与 vite 都用
动态端口，不碰 8787）；不部署、不 commit、不调用任何模型（夹具不含模型配置）。
收尾杀净自有后端与 vite、删临时目录（V0926_KEEP_TMP=1 可留现场）。
"""
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

REPO = os.path.abspath(os.environ.get(
    "V0926_REPO",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."),
))
SHOT_DIR = os.environ.get("V0926_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "V09-26", "ui-shots"))
LABEL = os.environ.get("V0926_LABEL", "run")
KEEP = os.environ.get("V0926_KEEP_TMP") == "1"
IDA = "v0926uiA"
IDB = "v0926uiB"

passes = [0]
fails = []
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


# 本脚本只访问隔离的本机服务：全部 loopback 请求必须绕过系统 HTTP 代理。
# 系统代理（HTTP_PROXY/HTTPS_PROXY）会把 127.0.0.1 的回环请求也劫走——实测经代理拿回 HTTP 502，
# 而 no_proxy 是否在场由调用方环境决定，不能依赖。故这里用空 ProxyHandler 的局部 opener：只影响本脚本，
# 不改用户代理设置（V09-26 修复：后端健康检查曾因代理劫持在 120s 等待后误判「未就绪」）。
LOCAL_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _ensure_loopback_no_proxy():
    """把 loopback 显式并入 NO_PROXY：后端/vite 子进程继承本进程环境，别让它们把本机流量交给系统代理。
    只改本脚本进程的环境，不动用户 shell/系统代理设置。"""
    hosts = ("localhost", "127.0.0.1", "::1")
    for key in ("NO_PROXY", "no_proxy"):
        parts = [p for p in os.environ.get(key, "").split(",") if p]
        os.environ[key] = ",".join(parts + [h for h in hosts if h not in parts])


_ensure_loopback_no_proxy()


def http(url, method="GET", body=None, headers=None, timeout=120):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, method=method, data=data)
    if data is not None:
        req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with LOCAL_HTTP.open(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8")
            return resp.status, (json.loads(text) if text.strip().startswith(("{", "[")) else text)
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, text


# ══════════════════════════════ 夹具 ══════════════════════════════

def design_doc(name):
    return """# V09-26 UI 夹具设计书 %s

## 2 模块划分

| # | 模块 | 说明 |
| --- | --- | --- |
| 1 | 甲模块 | 夹具能力 |

## 3 说明

夹具正文 %s。
""" % (name, name)


def plan_doc(task_id, name):
    return """# V09-26 UI 夹具施工图 %s

| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |
| --- | --- | --- | --- | --- |
| %s | todo | %s 甲模块落成 |  | %s 验收记录 |

### %s %s 甲模块落成

**设计依据**：§2。

**契约**：输入甲，输出甲的产物。

**文件责任**：`src/`。

- [ ] 甲做出来

**交付**：%s 验收记录。

**完成证据**：%s 验收记录。
""" % (name, task_id, name, name, task_id, name, name, name)


def progress_doc(current_step):
    return {
        "version": 1,
        "gate": {
            "current_step": current_step,
            "history": [
                {"step": "kickoff", "result": "pass", "at": "2026-10-02T00:00:00+08:00", "note": None},
                {"step": "requirement", "result": "pass", "at": "2026-10-02T00:00:00+08:00", "note": None},
                {"step": "design", "result": "pending", "at": None, "note": None},
            ],
        },
        "modules": [{"id": "src", "name": "源码", "status": "todo"}],
    }


MODULES = {
    "version": 1,
    "generated_at": "2026-10-02T00:00:00+08:00",
    "budget_exhausted": False,
    "modules": [{"id": "src", "path": "src", "name": "", "file_count": 1, "loc": 5, "deps": []}],
}


def make_project(root, pid, name, task_id, step_id):
    proj = os.path.join(root, "work", pid)
    write(os.path.join(proj, ".工作台", "design.md"), design_doc(name))
    write(os.path.join(proj, ".工作台", "plan.md"), plan_doc(task_id, name))
    write(os.path.join(proj, ".工作台", "arch", "modules.json"),
          json.dumps(MODULES, ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(proj, ".工作台", "progress.json"),
          json.dumps(progress_doc(step_id), ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(proj, ".工作台", "gate.jsonl"), "")
    # 待议源（非自举项目 = `.工作台/design.discuss.md`，entries 只认以 "- `" 开头的行）
    write(os.path.join(proj, ".工作台", "design.discuss.md"), "# 夹具待议\n\n（暂无）\n")
    write(os.path.join(proj, "src", "index.ts"), "export const a = 1;\n")
    return proj


def make_registry(home, proj_a, proj_b):
    now = "2026-10-02T00:00:00+08:00"
    write(os.path.join(home, "registry.json"),
          json.dumps({"version": 1, "projects": [
              {"id": IDA, "name": "夹具 A", "path": proj_a, "kind": "backend",
               "registered_at": now, "last_opened_at": now},
              {"id": IDB, "name": "夹具 B", "path": proj_b, "kind": "backend",
               "registered_at": now, "last_opened_at": now},
          ]}, ensure_ascii=False, indent=2) + "\n")


# ══════════════════════════════ 后端 / vite ══════════════════════════════

class Backend:
    def __init__(self, home, port, log_path):
        env = dict(os.environ)
        env["TATAI_HOME"] = home
        env["TATAI_PORT"] = str(port)
        self.port = port
        self.log_path = log_path
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", os.path.join("src", "server", "index.ts")],
            cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
        )

    def api(self, path, method="GET", body=None, headers=None):
        return http("http://127.0.0.1:%d%s" % (self.port, path), method, body, headers)

    def wait_health(self, timeout=120):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("后端进程退出（日志见 ui-backend.log）")
            try:
                if self.api("/health")[0] == 200:
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


def start_vite(port, backend_port, log_path, cache_dir):
    env = dict(os.environ)
    env["TATAI_DEV_API_PORT"] = str(backend_port)
    # node_modules 是对真实 D:/tatai 的 junction：vite 默认把依赖预打包缓存写到共享的
    # node_modules/.vite，与真实环境/并发验证互相打架。指到本次隔离临时目录（收尾随临时目录删除）。
    env["TATAI_VITE_CACHE_DIR"] = cache_dir
    proc = subprocess.Popen(
        ["node", os.path.join("node_modules", "vite", "bin", "vite.js"), "dev",
         "--port", str(port), "--strictPort"],
        cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
    )
    deadline = time.time() + 120
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("vite 起不来（进程已退出，见 ui-vite.log）")
        try:
            with LOCAL_HTTP.open("http://localhost:%d/" % port, timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("vite %d 未就绪" % port)


def launch_browser(p):
    # 浏览器同样不该把 loopback 交给系统代理（与脚本其它回环请求同口径）。
    args = ["--no-proxy-server", "--proxy-bypass-list=*"]
    try:
        return p.chromium.launch(headless=True, args=args)
    except Exception as e:  # noqa: BLE001 — 本机未装 playwright chromium 时退回系统 Edge
        info("默认 chromium 不可用（%s），退回系统 Edge" % str(e).splitlines()[0][:80])
        return p.chromium.launch(channel="msedge", headless=True, args=args)


# ══════════════════════════════ 浏览器辅助 ══════════════════════════════

def text_of(page, selector):
    loc = page.locator(selector)
    if loc.count() == 0:
        return None
    return (loc.first.text_content() or "").strip()


def attr_of(page, selector, attr):
    loc = page.locator(selector)
    if loc.count() == 0:
        return None
    return loc.first.get_attribute(attr)


def wait_text(page, selector, want, timeout_s=16, label=""):
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        last = text_of(page, selector)
        if last is not None and want(last):
            return True, last
        page.wait_for_timeout(300)
    info("等待超时（%ds）%s：最后读数 %r" % (timeout_s, label, last))
    return False, last


def wait_present(page, selector, timeout_s=12):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if page.locator(selector).count() > 0:
            return True
        page.wait_for_timeout(300)
    return False


def wait_attr(page, selector, attr, want, timeout_s=16, label=""):
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        last = attr_of(page, selector, attr)
        if last is not None and want(last):
            return True, last
        page.wait_for_timeout(300)
    info("等待超时（%ds）%s：最后读数 %r" % (timeout_s, label, last))
    return False, last


def goto_view(page, view):
    """切页：主视图直点；辅助入口（overview / terminal）先展开「更多」再点。

    2026-10-06 定向更新（五要素留档）：
      旧前提＝「项目信息」(overview) 在主视图按钮里可直接点击｜依据＝`src/ui/App.tsx:83-86` 已把
      overview/terminal 放进 AUX_NAV，并渲染在「更多」`<details class="tt-tools-disclosure">` 的
      `[data-aux-nav]` 内（该导航布局自 commit 986253e「用户 2026-09-22 拍板收口」起即如此；本套件
      03f676c 2026-10-02 建立时就没适配，同一时期的源码快照里 overview 同样在 AUX_NAV）⇒
      定位器自建立起目标按钮就不可见，第 ④ 步「慢响应>5s」从未真正跑过｜新前提＝切辅助页须先
      展开「更多」再点｜保留意图＝仍用**真实鼠标点击**走界面切页（不改成直接改 state 或调 API
      绕过 UI），且第 ④ 步其余断言一条不动｜判据不放宽＝仍是真点击＋真等元素可见，未用 force
      点击、未放宽等待时长。
    """
    btn = page.locator('button[data-view="%s"]' % view)
    aux = page.locator('[data-aux-nav] button[data-view="%s"]' % view)
    if aux.count() > 0:
        det = page.locator("details.tt-tools-disclosure")
        if det.count() > 0 and not det.first.evaluate("(d) => d.open"):
            det.first.locator("summary").click()
            page.wait_for_timeout(150)
    btn.first.click()


def goto_acceptance(page):
    goto_view(page, "live")
    page.wait_for_selector('[data-live-sub="acceptance"]', timeout=30000)
    page.locator('[data-live-sub="acceptance"]').click()
    page.wait_for_selector('[data-acceptance-view]', timeout=30000)


def switch_project(page, pid):
    page.locator('[data-project-item="%s"]' % pid).first.click()
    page.wait_for_timeout(900)


def import_definition(backend, token, project_id, task_id):
    """先导入施工定义（正向流程 F1：阶段上报只接已导入定义的任务）。"""
    st, body = backend.api("/api/work/command", "POST", {
        "schema_version": 2,
        "project_id": project_id,
        "change_id": "change-v0926-ui",
        "entity_id": "task:%s" % task_id,
        "expected_revision": None,
        "type": "task.definition_imported",
        "actor_id": "v09-26-ui",
        "role": "executor",
        "idempotency_key": "v0926ui:%s:%s:def" % (project_id, task_id),
        "payload": {"plan_revision": "", "definition_revision": 1},
    }, headers={"x-tatai-work-token": token})
    flag = st == 200 and (body or {}).get("ok") is True
    rev = (body or {}).get("entity_revision") if flag else None
    return flag, rev


def submit_status(backend, token, seq_no, expected_revision, status):
    st, body = backend.api("/api/work/command", "POST", {
        "schema_version": 2,
        "project_id": IDA,
        "change_id": "change-v0926-ui",
        "entity_id": "task:TA-1",
        "expected_revision": expected_revision,
        "type": "task.status_changed",
        "actor_id": "v09-26-ui",
        "role": "executor",
        "idempotency_key": "v0926ui:TA-1:status:%d" % seq_no,
        "payload": {"status": status},
    }, headers={"x-tatai-work-token": token})
    flag = st == 200 and (body or {}).get("ok") is True
    rev = (body or {}).get("entity_revision") if flag else None
    return flag, rev


def fail_route(handler_status=500):
    def handler(route):
        route.fulfill(
            status=handler_status,
            content_type="application/json",
            body=json.dumps({"ok": False, "error": {"code": "TEST_READ_FAIL", "message": "夹具注入的读失败"}}),
        )
    return handler


def delay_route(ms):
    def handler(route):
        time.sleep(ms / 1000.0)
        route.continue_()
    return handler


# ══════════════════════════════ 浏览器断言 ══════════════════════════════

PLAN_CARD_A = '[data-plan-card="TA-1"]'
PLAN_CARD_B = '[data-plan-card="TB-1"]'
PLAN_LABEL_ATTR = "data-plan-card-status-label"


def run_browser(vite_port, backend, home, fixture_root):
    base = "http://localhost:%d" % vite_port
    with open(os.path.join(home, "work-service.json"), encoding="utf-8") as f:
        token = json.load(f)["token"]
    os.makedirs(SHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_context(viewport={"width": 1680, "height": 1000}).new_page()
        page.goto("%s/#p/%s" % (base, IDA), wait_until="domcontentloaded")
        page.wait_for_timeout(2500)

        # ── ① 施工图：写事件后**不手动刷新**自动变化 + 最后上报时间可见 ──
        step["now"] = "施工图自动对账"
        goto_view(page, "plan")
        page.wait_for_selector(PLAN_CARD_A, timeout=30000)
        page.wait_for_timeout(800)
        before = text_of(page, PLAN_CARD_A + " [data-plan-card-status-label]")
        info("事件前施工图卡状态：%r" % before)
        page.screenshot(path=os.path.join(SHOT_DIR, "01-plan-before.png"))
        imported, rev1 = import_definition(backend, token, IDA, "TA-1")
        ok(imported, "施工定义经唯一写入面导入成功（task.definition_imported）")
        changed, after_import = wait_text(page, PLAN_CARD_A + " [data-plan-card-status-label]",
                                          lambda v: v != before, label="施工图卡状态词（导入后）")
        ok(changed and after_import is not None and "待准备" in after_import,
           "不碰手动刷新：导入定义后施工图卡状态「%s」→「%s」" % (before, after_import))
        submitted, rev2 = submit_status(backend, token, 1, rev1, "executing")
        ok(submitted, "工作事件经唯一写入面提交成功（task.status_changed → executing）")
        changed2, after = wait_text(page, PLAN_CARD_A + " [data-plan-card-status-label]",
                                    lambda v: "执行中" in v, label="施工图卡状态词（执行中）")
        ok(changed2, "不碰手动刷新：上报执行后施工图卡状态「%s」→「%s」" % (after_import, after))
        ok(page.locator(PLAN_CARD_A + " [data-plan-card-updated]").count() > 0,
           "施工图卡显示最后上报时间/推进者（v2 updated_at/last_actor 现成字段）")
        sidebar_goal, _ = wait_text(page, "[data-status-goal]",
                                    lambda v: "TA-1" in v, label="顶栏当前目标")
        ok(sidebar_goal, "不碰手动刷新：顶栏当前目标自动追到 TA-1")
        page.screenshot(path=os.path.join(SHOT_DIR, "02-plan-after.png"))

        # ── ② 验收页：写事件后自动变化 + 成果/执行态 ──
        step["now"] = "验收自动对账"
        goto_acceptance(page)
        page.wait_for_selector('[data-acceptance-task="TA-1"]', timeout=30000)
        page.wait_for_timeout(600)
        a_before = text_of(page, '[data-acceptance-task="TA-1"] [data-acceptance-execution]')
        ok(a_before is not None and "执行中" in a_before,
           "验收页执行态与账本同源：%r" % a_before)
        submitted2, _rev3 = submit_status(backend, token, 2, rev2, "blocked")
        ok(submitted2, "第二条工作事件提交成功（task.status_changed → blocked）")
        a_changed, a_after = wait_text(page, '[data-acceptance-task="TA-1"] [data-acceptance-execution]',
                                       lambda v: "阻塞" in v, label="验收执行态")
        ok(a_changed, "不碰手动刷新：验收页执行态「%s」→「%s」" % (a_before, a_after))
        page.screenshot(path=os.path.join(SHOT_DIR, "03-acceptance-after.png"))

        # ── ③ 验收输入：后台对账不清、切项目隔离且回来还在 ──
        step["now"] = "输入保留/隔离"
        note = "A 的验收说明草稿 · 后台刷新不许清"
        page.fill('[data-acceptance-note="TA-1"]', note)
        page.wait_for_timeout(6500)  # 至少跨过一轮 5s 对账
        kept = page.input_value('[data-acceptance-note="TA-1"]')
        ok(kept == note, "后台自动对账后验收输入原样保留（%r）" % kept)
        ok(import_definition(backend, token, IDB, "TB-1")[0], "项目 B 也导入 TB-1 定义（验收区有卡可比对）")
        switch_project(page, IDB)
        goto_acceptance(page)
        page.wait_for_selector('[data-acceptance-task="TB-1"]', timeout=30000)
        b_note = page.input_value('[data-acceptance-note="TB-1"]')
        ok(b_note == "", "切到项目 B：看不到项目 A 的验收输入（不串项目）")
        switch_project(page, IDA)
        page.wait_for_selector('[data-acceptance-view]', timeout=30000)
        page.wait_for_selector('[data-acceptance-task="TA-1"]', timeout=30000)
        back_note = page.input_value('[data-acceptance-note="TA-1"]')
        ok(back_note == note, "切回项目 A：此前输入的验收说明仍在（%r）" % back_note)

        # ── ④ 慢响应 >5s 最终落地（F2 红线：不能被每轮对账丢弃） ──
        step["now"] = "慢响应>5s最终显示"
        goto_view(page, "plan")
        page.wait_for_selector(PLAN_CARD_A, timeout=30000)
        # 「慢响应」用**挂起 + 事后放行**实现，不用 time.sleep 阻塞 Playwright 同步事件循环。
        # 2026-10-08 修正：旧写法在 route 处理器里 sleep 6.6s 会把同步事件循环整体卡住；被延迟的
        # 请求各自再 sleep，读断言几乎跑不动、最后必然超时——那是**夹具缺陷**（等价于 sync UI 里
        # 早就注明的「不用 sleep 阻塞事件循环」），不是产品丢刷新。
        held = {"n": 0, "routes": [], "first_at": None}
        def slow_a(route):
            if held["first_at"] is None:
                held["first_at"] = time.time()  # 计时要锚在「第一笔真被挂起」这一刻，不是脚本自己开始等
            held["n"] += 1
            held["routes"].append(route)  # 先不回包：模拟在途慢响应（不阻塞事件循环）
        page.route("**/api/projects/%s/plan" % IDA, slow_a)
        goto_view(page, "overview")  # 卸载 PlanView
        goto_view(page, "plan")      # 重挂 → 首发请求被挂起
        t0 = time.time()
        # 有界等**至少一笔真被挂起**再计时：拦不到请求时「在途 0 笔 ≤ 3」是恒真，等于没测（复审第 3 点）。
        hold_deadline = time.time() + 8.0
        while held["n"] < 1 and time.time() < hold_deadline:
            page.wait_for_timeout(100)
        inflight_before_release = held["n"]
        ok(inflight_before_release >= 1,
           "慢响应夹具确实拦到在途请求（/plan 在途 %d 笔，不是「0 笔也过」）" % inflight_before_release)
        # 只有真拦到才等：让被挂起的首发请求在途 > 5s（跨过至少一个 5s 对账周期）后放行——慢响应必须最终落地。
        if inflight_before_release >= 1:
            hold_start = held["first_at"] if held["first_at"] is not None else t0
            remain = 5.5 - (time.time() - hold_start)
            if remain > 0:
                page.wait_for_timeout(int(remain * 1000))
        for r in list(held["routes"]):
            try:
                r.continue_()
            except Exception:  # noqa: BLE001
                pass
        landed, _ = wait_attr(page, PLAN_CARD_A, "data-plan-card", lambda v: v == "TA-1",
                              timeout_s=20, label="慢响应最终落地")
        elapsed = time.time() - (held["first_at"] if held["first_at"] is not None else t0)
        ok(landed and elapsed > 5.0,
           "慢响应（%.1fs > 5s 对账周期）最终仍落地显示（在途期间 /plan 仅 %d 笔，同一加载器有界）"
           % (elapsed, inflight_before_release))
        ok(inflight_before_release <= 3,
           "慢响应在途期间同一加载器未并发堆积（/plan 仅 %d 笔）" % inflight_before_release)
        page.unroute("**/api/projects/%s/plan" % IDA)
        for r in list(held["routes"]):
            try:
                r.continue_()
            except Exception:  # noqa: BLE001
                pass

        # ── ④b 多次快速切换 A↔B：不串项目、不回退、网络有界（并发 ≤1） ──
        step["now"] = "多次切换"
        inflight = {"cur": 0, "max": 0}
        def on_req(req):
            if req.method == "GET" and req.url.endswith("/plan"):
                inflight["cur"] += 1
                inflight["max"] = max(inflight["max"], inflight["cur"])
        def on_done(req):
            if req.method == "GET" and req.url.endswith("/plan"):
                inflight["cur"] -= 1
        page.on("request", on_req)
        page.on("requestfinished", on_done)
        page.on("requestfailed", on_done)
        goto_view(page, "plan")
        page.wait_for_selector(PLAN_CARD_A, timeout=30000)
        for pid in (IDB, IDA, IDB, IDA):
            switch_project(page, pid)
            goto_view(page, "plan")
        showed_a, _ = wait_attr(page, PLAN_CARD_A, "data-plan-card", lambda v: v == "TA-1",
                                timeout_s=20, label="多次切换后停在 A")
        ok(showed_a, "多次快速切换后停在项目 A 显示 A 的施工图（TA-1）")
        page.wait_for_timeout(4500)
        final_ok = page.locator(PLAN_CARD_A).count() > 0 and page.locator(PLAN_CARD_B).count() == 0
        ok(final_ok, "多次切换后没有回退/串项目（仍只有 TA-1）")
        ok(inflight["max"] <= 1,
           "多次切换网络严格有界：/plan 并发峰值 %d（≤1，未堆积）" % inflight["max"])

        # ── ④c 延迟旧响应 + 切项目：晚到的 A 不回写 B ──
        step["now"] = "延迟旧响应/切项目"
        goto_view(page, "plan")
        page.wait_for_selector(PLAN_CARD_A, timeout=30000)
        page.route("**/api/projects/%s/plan" % IDA, delay_route(4000))
        page.wait_for_timeout(6000)  # 让周期对账发出一笔被延迟的 A /plan
        switch_project(page, IDB)
        goto_view(page, "plan")
        showed_b, _ = wait_attr(page, PLAN_CARD_B, "data-plan-card", lambda v: v == "TB-1",
                                timeout_s=20, label="项目 B 施工图")
        ok(showed_b, "切到项目 B 后显示 B 的施工图（TB-1）")
        page.wait_for_timeout(6000)  # 延迟的 A 回包此刻应已到达并被丢弃
        still_b = page.locator(PLAN_CARD_B).count() > 0 and page.locator(PLAN_CARD_A).count() == 0
        ok(still_b, "晚到的项目 A 旧响应没有污染项目 B 的界面（仍只有 TB-1）")
        page.unroute("**/api/projects/%s/plan" % IDA)
        page.screenshot(path=os.path.join(SHOT_DIR, "04-late-response.png"))

        # ── ⑤ 读失败：保留最后成功数据 + 标陈旧/最近成功时间；恢复后自清 ──
        step["now"] = "读失败/恢复"
        page.route("**/api/projects/%s/plan" % IDB, fail_route())
        stale_seen, _ = wait_attr(page, "[data-plan-view]", "data-plan-stale", lambda v: v == "1",
                                  timeout_s=18, label="施工图陈旧标记")
        stale_at = attr_of(page, "[data-plan-stale-banner]", "data-plan-stale-at")
        ok(stale_seen, "读失败：施工图标陈旧（data-plan-stale=1）")
        ok(bool(stale_at), "陈旧横幅带最近成功时间（%r）" % stale_at)
        ok(page.locator(PLAN_CARD_B).count() > 0, "读失败：**保留最后成功数据**（TB-1 卡仍在，不闪空）")
        page.screenshot(path=os.path.join(SHOT_DIR, "05-stale.png"))
        page.unroute("**/api/projects/%s/plan" % IDB)
        recovered, _ = wait_attr(page, "[data-plan-view]", "data-plan-stale", lambda v: v == "0",
                                 timeout_s=18, label="施工图恢复")
        ok(recovered and page.locator(PLAN_CARD_B).count() > 0, "恢复后自行清除陈旧标记且数据仍在")

        # ── ⑥ 技术详情状态层 / 数据流目标层：自动重取（切回项目 A） ──
        step["now"] = "技术详情/数据流对账"
        switch_project(page, IDA)
        goto_view(page, "arch")
        page.wait_for_selector('[data-project-view-tab="tech"]', timeout=30000)
        page.locator('[data-project-view-tab="tech"]').click()
        # 旧版没有这个锚点：容错读取，别让它在红例里把整段打断（旧版此处断言应为 FAIL）
        has_status_anchor = wait_present(page, "[data-arch-status-loads]", timeout_s=12)
        n1 = int(attr_of(page, "[data-arch-status-loads]", "data-arch-status-loads") or "0")
        page.wait_for_timeout(6500)
        n2 = int(attr_of(page, "[data-arch-status-loads]", "data-arch-status-loads") or "0")
        ok(has_status_anchor and n2 > n1,
           "技术详情**状态色/证据**投影层自动重取（data-arch-status-loads %d → %d）" % (n1, n2))
        ok(attr_of(page, "[data-arch-status-loads]", "data-arch-status-stale") == "0",
           "技术详情状态层无陈旧标记")
        page.locator('[data-graph-mode="DATA_FLOW"]').click()
        # 2026-10-08：产品新增「业务数据路径」层（BusinessDataFlowView）并设为 DATA_FLOW 的默认层；
        # 旧画布与目标语义层 `[data-flow-target-layer]` 现在挂在「代码引用线索」层下（父容器 .hidden）。
        # 目标语义层不可见就先切到代码层再核——仍是同一个被断言的目标语义层，判据不放宽；切不过去
        # 也不让整段中止（下面用容错读取，坏在红例里如实记 FAIL，后续段照跑）。
        if not page.locator("[data-flow-target-layer]").is_visible():
            code_btn = page.get_by_role("button", name="代码引用线索")
            if code_btn.count() > 0:
                code_btn.first.click()
                page.wait_for_timeout(800)
        has_flow_anchor = wait_present(page, "[data-flow-target-layer]", timeout_s=12)
        m1 = int(attr_of(page, "[data-flow-target-layer]", "data-flow-target-loads") or "0")
        page.wait_for_timeout(6500)
        m2 = int(attr_of(page, "[data-flow-target-layer]", "data-flow-target-loads") or "0")
        flow_visible = page.locator("[data-flow-target-layer]").is_visible()
        ok(has_flow_anchor and flow_visible and m2 > m1,
           "数据流向图**目标语义层**在场、可见且自动重取（data-flow-target-loads %d → %d；层可见=%s）"
           % (m1, m2, flow_visible))
        page.screenshot(path=os.path.join(SHOT_DIR, "06-tech-dataflow.png"))

        # ── ⑦ 只有文件变化（Gate）没有账本事件，也追平 ──
        step["now"] = "Gate 文件变化追平"
        goto_view(page, "live")
        page.locator('[data-live-sub="acceptance"]').click()
        page.wait_for_selector("[data-acceptance-stage-toggle]", timeout=30000)
        page.locator("[data-acceptance-stage-toggle]").click()
        page.wait_for_selector("[data-gate-timeline]", timeout=30000)
        g_before = text_of(page, "[data-gate-current]")
        # 直接改夹具的 progress.json（= Gate 只有文件变化，账本序号不动）
        write(os.path.join(fixture_root, "work", IDA, ".工作台", "progress.json"),
              json.dumps(progress_doc("tasks"), ensure_ascii=False, indent=2) + "\n")
        g_changed, g_after = wait_text(page, "[data-gate-current]",
                                       lambda v: "tasks" in v, timeout_s=16, label="Gate 当前步")
        ok(g_changed, "只改 Gate 文件（无账本事件）：Gate 时间线自动追平 %r → %r" % (g_before, g_after))
        page.screenshot(path=os.path.join(SHOT_DIR, "07-gate-file-change.png"))

        # ── ⑧ 项目信息 / 待决事项：只有文件变化（无账本事件）也自动追平 ──
        step["now"] = "项目信息/待决事项对账"
        switch_project(page, IDB)
        goto_view(page, "overview")
        page.wait_for_selector("[data-project-info]", timeout=30000)
        wait_text(page, "[data-project-goal]", lambda v: "推进" in v, timeout_s=16, label="项目信息当前目标（初始）")
        ov_before = text_of(page, "[data-project-goal]")
        write(os.path.join(fixture_root, "work", IDB, ".工作台", "progress.json"),
              json.dumps(progress_doc("design"), ensure_ascii=False, indent=2) + "\n")
        ov_changed, ov_after = wait_text(page, "[data-project-goal]",
                                         lambda v: "设计" in v, timeout_s=16, label="项目信息当前目标")
        ok(ov_changed, "只改文档：项目信息「当前目标」自动追平 %r → %r" % (ov_before, ov_after))

        pd_before = attr_of(page, "[data-pending-decisions]", "data-pending-decisions")
        write(os.path.join(fixture_root, "work", IDB, ".工作台", "design.discuss.md"),
              "# 夹具待议\n\n（暂无）\n- `2026-10-02 B 待议：夹具追加项`\n")
        pd_after = pd_before
        deadline = time.time() + 16
        while time.time() < deadline:
            pd_after = attr_of(page, "[data-pending-decisions]", "data-pending-decisions")
            if pd_after == "1":
                break
            page.wait_for_timeout(300)
        ok(pd_after == "1", "只改文档：待决事项计数自动追平 %r → %r" % (pd_before, pd_after))
        page.screenshot(path=os.path.join(SHOT_DIR, "08-overview-pending.png"))

        # ── ⑨ 无模型调用（夹具无模型配置） ──
        step["now"] = "无模型调用核对"
        log_path = os.path.join(fixture_root, "ui-backend.log")
        log_text = ""
        try:
            with open(log_path, encoding="utf-8", errors="replace") as f:
                log_text = f.read()
        except Exception:
            pass
        ok("/ask_flash" not in log_text and "ask_flash" not in log_text,
           "后端日志未见模型调用入口（夹具无模型配置，本段零模型）")

        # ── ⑩ 卸载：终止在途/待补，卸载后不再继续 pending（超一个对账周期不发请求） ──
        step["now"] = "卸载停止 pending"
        switch_project(page, IDB)
        unmount_calls = {"n": 0}
        def count_unmount(route):
            unmount_calls["n"] += 1
            route.continue_()
        page.route("**/api/projects/%s/plan" % IDB, count_unmount)
        goto_view(page, "plan")
        page.wait_for_selector(PLAN_CARD_B, timeout=30000)
        page.wait_for_timeout(1500)  # 允许挂载首发 + 待补各发一笔
        goto_view(page, "overview")  # 卸载 PlanView（在途请求应被中止，pending 不再补跑）
        page.wait_for_timeout(1000)
        n_unmount = unmount_calls["n"]
        page.wait_for_timeout(8000)  # 远超 5s 对账周期：卸载后不应再有任何 /plan 请求
        n_after = unmount_calls["n"]
        ok(n_after == n_unmount,
           "卸载后不再继续 pending：/plan 请求数 %d → %d（跨过一个以上对账周期不变）" % (n_unmount, n_after))
        page.unroute("**/api/projects/%s/plan" % IDB)
        page.screenshot(path=os.path.join(SHOT_DIR, "09-unmounted.png"))

        browser.close()


def main():
    root = tempfile.mkdtemp(prefix="tatai-v0926ui-")
    home = os.path.join(root, "home")
    os.makedirs(home, exist_ok=True)
    backend = None
    vite = None
    try:
        step["now"] = "夹具"
        proj_a = make_project(root, IDA, "A", "TA-1", "design")
        proj_b = make_project(root, IDB, "B", "TB-1", "requirement")
        make_registry(home, proj_a, proj_b)
        info("[%s] 被测仓库：%s" % (LABEL, REPO))
        info("隔离 TATAI_HOME：%s" % home)

        step["now"] = "起后端"
        port = free_port()
        backend = Backend(home, port, os.path.join(root, "ui-backend.log"))
        backend.wait_health()
        info("后端（动态端口）http://127.0.0.1:%d" % port)
        ok(backend.api("/api/projects/%s/live" % IDA)[0] == 200, "夹具 live 读口可用（HTTP 200）")

        step["now"] = "起 vite"
        vite_port = free_port()
        vite = start_vite(vite_port, port, os.path.join(root, "ui-vite.log"), os.path.join(root, "vite-cache"))
        info("vite（动态端口）http://localhost:%d" % vite_port)

        step["now"] = "浏览器"
        run_browser(vite_port, backend, home, root)
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        ok(False, "UI 段在「%s」中断：%s" % (step["now"], e))
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
            info("保留现场：%s（V0926_KEEP_TMP=1）" % root)
        else:
            shutil.rmtree(root, ignore_errors=True)

    print("[ui] [%s] 计数：%d PASS / %d FAIL" % (LABEL, passes[0], len(fails)))
    print("[ui] 截图目录：%s" % SHOT_DIR)
    if fails:
        for f in fails:
            print("[ui]   FAIL " + f)
        sys.exit(1)
    print("[ui] 全部 PASS")


if __name__ == "__main__":
    main()
