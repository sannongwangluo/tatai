#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-07 UI 真机验证：图页**自动失效重取**（真浏览器 + 真后端 + 真 DOM，不碰手动刷新）。

用法：python scripts/verify-v09-07-ui.py
      （或 pnpm verify:v09-07-ui；V0907_SHOT_DIR 换截图目录、V0907_KEEP_TMP=1 保留现场）

为什么必须跑真浏览器（PLAN.md V09-07 检查项 ② / DESIGN 附录 E.8-5）：
  · 判据是「提交一次工作结果后，**不经手动刷新/切项目**即可看到图页状态变化」——
    这只有真 DOM 读得出来：节点状态词变没变、数据层拉取计数涨没涨。
  · 轮询机制（4s 读 `GET /live` 的 `task_last_seq`，前进就 load()）是前端行为，
    服务端单测覆盖不到「定时器真的挂在页面上、页面可见性门控真的生效」这一层。

隔离口径（AGENTS.md §5 / 本卡红线）：
  · 临时 `TATAI_HOME`（tempfile）+ 夹具项目（自带 design/plan/modules.json/progress.json）；
    真实塔台项目一个字节都不碰；后端走动态空闲端口（不动 8787）；vite 固定 5173 被占即拒跑。
  · 工作事件经**唯一写入面** `POST /api/work/command`（描述符令牌从夹具 home 读）写入夹具项目账本。
  · 收尾杀净后端与 vite、删临时目录（V0907_KEEP_TMP=1 可留现场）。
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

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SHOT_DIR = os.environ.get(
    "V0907_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "V09-07", "1", "ui-shots")
)
KEEP = os.environ.get("V0907_KEEP_TMP") == "1"
FIX_ID = "v0907ui"

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


def port_busy(port):
    s = socket.socket()
    s.settimeout(0.5)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except Exception:
        return False
    finally:
        s.close()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return path


def http(url, method="GET", body=None, headers=None, timeout=120):
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

DESIGN = """# V09-07 UI 夹具设计书

## 2 模块划分

| # | 模块 | 说明 |
| --- | --- | --- |
| 1 | 甲模块 | 夹具能力 |

## 3 说明

夹具正文。
"""

PLAN = """# V09-07 UI 夹具施工图

| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |
| --- | --- | --- | --- | --- |
| T-1 | todo | 甲模块落成 |  | 甲验收记录 |

### T-1 甲模块落成

**设计依据**：§2。

**契约**：输入甲，输出甲的产物。

**文件责任**：`src/`。

- [ ] 甲做出来

**交付**：甲验收记录。

**完成证据**：甲验收记录。
"""

MODULES = {
    "version": 1,
    "generated_at": "2026-09-24T00:00:00+08:00",
    "budget_exhausted": False,
    "modules": [{"id": "src", "path": "src", "name": "", "file_count": 1, "loc": 5, "deps": []}],
}

PROGRESS = {
    "version": 1,
    "gate": {
        "current_step": "design",
        "history": [
            {"step": "kickoff", "result": "pass", "at": "2026-09-24T00:00:00+08:00", "note": None},
            {"step": "requirement", "result": "pass", "at": "2026-09-24T00:00:00+08:00", "note": None},
            {"step": "design", "result": "pending", "at": None, "note": None},
        ],
    },
    "modules": [{"id": "src", "name": "源码", "status": "todo"}],
}


def make_fixture(root):
    proj = os.path.join(root, "work", FIX_ID)
    write(os.path.join(proj, ".工作台", "design.md"), DESIGN)
    write(os.path.join(proj, ".工作台", "plan.md"), PLAN)
    write(os.path.join(proj, ".工作台", "arch", "modules.json"),
          json.dumps(MODULES, ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(proj, ".工作台", "progress.json"),
          json.dumps(PROGRESS, ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(proj, ".工作台", "gate.jsonl"), "")
    write(os.path.join(proj, "src", "index.ts"), "export const a = 1;\n")
    return proj


def make_registry(home, fix_proj):
    now = "2026-09-24T00:00:00+08:00"
    write(os.path.join(home, "registry.json"),
          json.dumps({"version": 1, "projects": [
              {"id": FIX_ID, "name": "V09-07 UI 夹具", "path": fix_proj, "kind": "backend",
               "registered_at": now, "last_opened_at": now},
          ]}, ensure_ascii=False, indent=2) + "\n")


# ══════════════════════════════ 后端 / vite ══════════════════════════════

class Backend:
    def __init__(self, home, port, log_path):
        env = dict(os.environ)
        env["TATAI_HOME"] = home
        env["TATAI_PORT"] = str(port)
        self.port = port
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
            raise RuntimeError("vite 起不来（进程已退出，见 ui-vite.log）")
        try:
            with urllib.request.urlopen("http://localhost:%d/" % port, timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("vite %d 未就绪" % port)


# ══════════════════════════════ 浏览器断言 ══════════════════════════════

TASK_NODE = '[data-project-node="plan:task:T-1"]'


def submit_status(backend, token, seq_no, expected_revision):
    """经唯一写入面提交一条工作事件（task.status_changed → executing）。
    同一实体的第二次提交必须带上一次回执的 entity_revision（乐观并发：VERSION_CONFLICT 不覆盖别人）。"""
    status, body = backend.api("/api/work/command", "POST", {
        "schema_version": 2,
        "project_id": FIX_ID,
        "change_id": "change-v0907-ui",
        "entity_id": "task:T-1",
        "expected_revision": expected_revision,
        "type": "task.status_changed",
        "actor_id": "v09-07-ui",
        "role": "executor",
        "idempotency_key": "v0907ui:T-1:status:%d" % seq_no,
        "payload": {"status": "executing"},
    }, headers={"x-tatai-work-token": token})
    ok_flag = status == 200 and (body or {}).get("ok") is True
    revision = (body or {}).get("entity_revision") if ok_flag else None
    return ok_flag, revision


def wait_attr(page, selector, attr, want, timeout_s=18, label="", live_probe=None):
    """不碰页面（零刷新零点击），纯读 DOM 属性等到目标值——轮询生效与否的直接证据。"""
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        loc = page.locator(selector)
        if loc.count() > 0:
            last = loc.first.get_attribute(attr)
            if want(last):
                return True, last
        page.wait_for_timeout(400)
    n_live = page.evaluate("performance.getEntriesByType('resource').filter(e => e.name.includes('/live')).length")
    info("等待超时（%ds）%s：最后读数 %r；页面内 /live 请求数=%s；visibility=%s；直读 live=%s"
         % (timeout_s, label, last, n_live, page.evaluate("document.visibilityState"),
            json.dumps(live_probe(), ensure_ascii=False)[:200] if live_probe else "n/a"))
    return False, last


def run_browser(vite_port, backend, home):
    base = "http://localhost:%d" % vite_port
    # 写入面描述符（夹具 home 里）：host/port/token —— 与 stdio MCP 发现写入服务同一份
    with open(os.path.join(home, "work-service.json"), encoding="utf-8") as f:
        desc = json.load(f)
    token = desc["token"]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1680, "height": 1000}).new_page()

        # ── 打开图页（施工依赖主视图：任务节点在这张图上）──
        page.goto("%s/#p/%s" % (base, FIX_ID), wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        page.locator('button[data-view="arch"]').click()
        page.wait_for_selector('[data-project-view-tab="construction"]', timeout=30000)
        page.locator('[data-project-view-tab="construction"]').click()
        page.wait_for_selector(TASK_NODE, timeout=30000)
        page.wait_for_timeout(1000)

        before = page.locator(TASK_NODE).first.get_attribute("data-project-status-label")
        info("事件前任务节点状态词：%s" % before)
        os.makedirs(SHOT_DIR, exist_ok=True)
        page.screenshot(path=os.path.join(SHOT_DIR, "01-graph-before-event.png"))

        # ── 经 API 提交一条工作事件；**不碰刷新**，等图页自己变 ──
        submitted, rev1 = submit_status(backend, token, 1, None)
        ok(submitted, "工作事件经唯一写入面提交成功（task.status_changed → executing）")
        live_probe = lambda: backend.api("/api/projects/%s/live" % FIX_ID)[1].get("live", {}).get("task_last_seq")
        changed, after = wait_attr(page, TASK_NODE, "data-project-status-label",
                                   lambda v: v != before, label="主视图节点状态词", live_probe=live_probe)
        ok(changed and after == "正在实现",
           "不碰手动刷新：主视图任务节点状态词自动从「%s」变成「%s」（轮询 task_last_seq 前进 → 自动重取）"
           % (before, after))
        page.screenshot(path=os.path.join(SHOT_DIR, "02-graph-after-event-auto.png"))

        # ── 切走再切回（同样不手刷）：读数一致、不丢 ──
        page.locator('button[data-view="live"]').click()
        page.wait_for_timeout(1500)
        page.locator('button[data-view="arch"]').click()
        page.wait_for_selector('[data-project-view-tab="construction"]', timeout=30000)
        page.locator('[data-project-view-tab="construction"]').click()
        page.wait_for_selector(TASK_NODE, timeout=30000)
        page.wait_for_timeout(800)
        back = page.locator(TASK_NODE).first.get_attribute("data-project-status-label")
        ok(back == "正在实现", "切走/切回（无手动刷新）后读数一致：仍为「%s」" % back)
        page.screenshot(path=os.path.join(SHOT_DIR, "03-graph-switch-back.png"))

        # ── 技术详情（ArchCanvas）这条轮询链也生效：数据层拉取计数自动 +1 ──
        page.locator('[data-project-view-tab="tech"]').click()
        page.wait_for_selector("[data-arch-data-loads]", timeout=30000)
        page.wait_for_timeout(1200)
        loads_before = int(page.locator("[data-arch-data-loads]").first.get_attribute("data-arch-data-loads"))
        submitted2, _ = submit_status(backend, token, 2, rev1)
        ok(submitted2, "第二条工作事件提交成功（驱动技术详情画布那条链；expected_revision 跟上一条回执）")
        bumped, loads_after_raw = wait_attr(page, "[data-arch-data-loads]", "data-arch-data-loads",
                                            lambda v: v is not None and int(v) > loads_before,
                                            label="技术详情数据层拉取计数")
        ok(bumped, "技术详情画布也不手刷自动重取：data-arch-data-loads %d → %s" % (loads_before, loads_after_raw))
        page.screenshot(path=os.path.join(SHOT_DIR, "04-tech-canvas-auto-reload.png"))
        browser.close()


def main():
    root = tempfile.mkdtemp(prefix="tatai-v0907ui-")
    home = os.path.join(root, "home")
    os.makedirs(home, exist_ok=True)
    backend = None
    vite = None
    try:
        step["now"] = "夹具"
        fix_proj = make_fixture(root)
        make_registry(home, fix_proj)
        info("隔离 TATAI_HOME：%s" % home)
        info("夹具项目：%s" % fix_proj)

        step["now"] = "起后端"
        port = free_port()
        backend = Backend(home, port, os.path.join(root, "ui-backend.log"))
        backend.wait_health()
        info("后端就绪 http://127.0.0.1:%d" % port)
        ok(backend.api("/api/projects/%s/live" % FIX_ID)[0] == 200, "夹具 live 读口可用（HTTP 200）")

        step["now"] = "起 vite"
        vite_port = 5173
        if port_busy(vite_port):
            raise RuntimeError("5173 已被占用（不碰别人的 dev server）——本段无法在本机真跑")
        vite = start_vite(vite_port, port, os.path.join(root, "ui-vite.log"))
        info("vite 就绪 http://localhost:%d" % vite_port)

        step["now"] = "浏览器"
        run_browser(vite_port, backend, home)
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
            info("保留现场：%s（V0907_KEEP_TMP=1）" % root)
        else:
            shutil.rmtree(root, ignore_errors=True)

    print("[ui] 计数：%d PASS / %d FAIL" % (passes[0], len(fails)))
    print("[ui] 截图目录：%s" % SHOT_DIR)
    if fails:
        for f in fails:
            print("[ui]   FAIL " + f)
        sys.exit(1)
    print("[ui] 全部 PASS")


if __name__ == "__main__":
    main()
