#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-28 设计书页「现有成套图纸 · 审定与激活」真浏览器验证（PLAN.md V09-28；DESIGN.md §2.9/§6.7；
契约 docs/forward-progress-contract.md F1/F2）。

用法：python scripts/verify-forward-baseline-ui.py
      （TATAI_FB_SHOT_DIR 换截图目录、TATAI_FB_KEEP_TMP=1 保留现场、TATAI_FB_VITE_PORT 固定 vite 端口）

为什么必须跑真浏览器：
  · 「显示两源当前版本/状态」「明确动作」「主用户不要求理解哈希内部细节」是**上屏**口径——只有真 DOM
    里读 `data-baseline-*` 才算数；
  · 「零差异直接激活、不调模型、不经过逆向落稿」要**真点一下**再回读后端基线，文字解释不算；
  · 「自动重取不丢输入/不清空内容」「失败旧数据可见」「切项目输入隔离」只有真点、真等一轮对账、
    真切项目才能证明；
  · G0/G/H 段（2026-10-02 补）：**首屏失败 → 不手刷自动恢复**（契约 F2）与**换项目旧错误不串**（§3.14）。
    G0 是任务原话场景（全新挂载首屏 /design 503 → 解除拦截 → 不点刷新 → 正文自动回来）；2026-10-02
    小修把「首屏判定」改成「本项目是否已成功取到数据」（不再在 load 开头就置位），dev StrictMode 双挂载
    的**全新挂载首屏失败**因此显式上错误页（此前被误记 refreshError、页面无限停在「加载设计书…」），
    G0 现在同时断言 503 期间为错误页而非无限加载、解除后自动恢复；
    G 段走设计页已挂载、换项目触发的那次首屏失败（同样上错误页）；
    H 段用 MutationObserver 采换项目那一帧有没有把旧项目的失败横幅/旧正文带进新项目。
  · I/J 段（2026-10-02 补）：正向基线动作（激活/保存）的**代际守卫**——A 发请求后切 B，A 的晚到回执/
    错误/finally 忙状态不得写到 B；回 A 由普通自动读显示已提交的基线事实；A→B→A 的旧代回执被丢弃。
    真后端 + route **只扣住回执**（到点 continue_ 放行给真实服务，不伪造成功），动态 home/端口/缓存。

隔离口径：临时 TATAI_HOME + 夹具项目 + 随机空闲端口（后端与 vite 都动态端口），**不杀 8787**、
不动用户浏览器；后端 `TATAI_SEMANTIC_AUTO=0`（确定性派生照常、不调模型）。
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
# 测试只访问本次隔离的回环服务，显式直连，避免 ambient 代理把探活转成 502。
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))
SHOT_DIR = os.environ.get(
    "TATAI_FB_SHOT_DIR", os.path.join(REPO, ".工作台", "verify", "forward-baseline-20261002", "ui")
)
KEEP = os.environ.get("TATAI_FB_KEEP_TMP") == "1"
VITE_PORT_OVERRIDE = os.environ.get("TATAI_FB_VITE_PORT")
FIX_A = "fb-a"
FIX_B = "fb-b"
FIX_C = "fb-c"  # I/J 段专用干净源项目（无基线，便于"真实写入 0→1"与"晚到回执被丢弃"断言）
POLL_WAIT_MS = 7200  # > useProjectRefresh 的 5000ms 缺省对账周期，确保跨过至少一轮

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


def http(url, method="GET", body=None, timeout=120):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, method=method, data=data)
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with DIRECT.open(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8")
            return resp.status, (json.loads(text) if text.strip().startswith(("{", "[")) else text)
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, text


DESIGN = """# V09-28 夹具设计书

## 1 目标

已有成套设计书与施工图；本卡要求**零差异直接技术审定激活**，不调用模型、不经过逆向落稿。

## 2 边界

夹具正文，仅用于界面验证。
"""

PLAN = """# V09-28 夹具施工图

## 当前任务

| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |
| --- | --- | --- | --- | --- |
| T-1 | todo | 打地基 |  | `pnpm test` 通过 |
| T-2 | todo | 砌墙 | T-1 | 验收清单勾完 |
"""

DISCUSS = """# 待议记录

- `问题：夹具待议一 ｜ 依据：界面验证 ｜ 建议：保留输入`
"""


def make_fixture(root, fix_id):
    proj = os.path.join(root, "work", fix_id)
    write(os.path.join(proj, ".工作台", "design.md"), DESIGN)
    write(os.path.join(proj, ".工作台", "plan.md"), PLAN)
    write(os.path.join(proj, ".工作台", "design.discuss.md"), DISCUSS)
    return proj


def make_registry(home, projects):
    now = "2026-10-02T00:00:00+08:00"
    write(os.path.join(home, "registry.json"),
          json.dumps({"version": 1, "projects": [
              {"id": pid, "name": name, "path": path, "kind": "backend",
               "registered_at": now, "last_opened_at": now}
              for pid, name, path in projects
          ]}, ensure_ascii=False, indent=2) + "\n")


class Backend:
    def __init__(self, home, port, log_path):
        env = dict(os.environ)
        env["TATAI_HOME"] = home
        env["TATAI_PORT"] = str(port)
        env["TATAI_SEMANTIC_AUTO"] = "0"
        env["TATAI_SYNC_DISCOVERY"] = "0"
        self.port = port
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", os.path.join("src", "server", "index.ts")],
            cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
        )

    def api(self, path, method="GET", body=None, timeout=120):
        return http("http://127.0.0.1:%d%s" % (self.port, path), method, body, timeout)

    def wait_health(self, timeout=120, attempt_timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("后端进程退出（日志见 ui-backend.log）")
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                if self.api("/health", timeout=min(attempt_timeout, remaining))[0] == 200:
                    return
            except Exception:
                pass
            time.sleep(min(0.3, max(0.0, deadline - time.monotonic())))
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
    # node_modules 是对真实 D:/tatai 的 junction：vite 默认依赖预打包缓存写到共享 node_modules/.vite，
    # 与真实环境/并发验证打架。指到本次隔离临时目录（收尾随临时目录删除），不碰共享缓存。
    env["TATAI_VITE_CACHE_DIR"] = cache_dir
    proc = subprocess.Popen(
        ["node", os.path.join("node_modules", "vite", "bin", "vite.js"), "dev",
         "--port", str(port), "--strictPort"],
        cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
    )
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("vite 起不来（进程已退出，见 ui-vite.log）")
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            with DIRECT.open("http://localhost:%d/" % port, timeout=min(5, remaining)) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(min(0.5, max(0.0, deadline - time.monotonic())))
    proc.kill()
    proc.wait(timeout=10)
    raise RuntimeError("vite %d 未就绪" % port)


def attr(page, selector, name):
    loc = page.locator(selector)
    if loc.count() == 0:
        return None
    return loc.first.get_attribute(name)


def text_of(page, selector):
    loc = page.locator(selector)
    return loc.first.inner_text().strip() if loc.count() else None


def wait_for(page, selector, timeout=12.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if page.locator(selector).count() > 0:
            return True
        page.wait_for_timeout(200)
    return False


def baseline_count(backend, proj_id):
    _s, body = backend.api("/api/projects/%s/documents" % proj_id)
    return (body or {}).get("documents", {}).get("baseline", {}).get("count")


def open_design(page, base, pid, wait=1600):
    page.goto("%s/#p/%s" % (base, pid), wait_until="domcontentloaded")
    page.wait_for_timeout(wait)
    page.click('[data-main-nav] button[data-view="design"]')
    page.wait_for_timeout(1200)


def switch_project(page, pid, wait=1500):
    page.evaluate("(p) => { window.location.hash = '#p/' + p; }", pid)
    page.wait_for_timeout(wait)


def launch_browser(p):
    """真浏览器：优先 Playwright 自带 chromium；本机未装（ms-playwright 空）时退回系统 Edge。
    两者都是真 Chromium 内核，不改变判据。"""
    chan = os.environ.get("TATAI_FB_BROWSER_CHANNEL", "")
    if chan:
        return p.chromium.launch(headless=True, channel=chan)
    try:
        return p.chromium.launch(headless=True)
    except Exception as e:  # noqa: BLE001
        info("自带 chromium 起不来（%s），退回系统 Edge" % str(e).splitlines()[0][:120])
        return p.chromium.launch(headless=True, channel="msedge")


def run_browser(vite_port, backend, proj_a, proj_b):
    base = "http://localhost:%d" % vite_port
    with sync_playwright() as p:
        browser = launch_browser(p)
        ctx = browser.new_context(viewport={"width": 1400, "height": 1000})
        page = ctx.new_page()
        page.set_default_timeout(15000)

        # ═══ A）面板渲染：两源当前版本/状态 + 尚无基线 ═══
        step["now"] = "A 面板渲染"
        open_design(page, base, FIX_A)
        ok(page.locator("[data-baseline-panel]").count() == 1, "A-1 设计书页出现「现有成套图纸」审定区")
        ok(attr(page, '[data-baseline-source="design"] [data-baseline-source-exists]', "data-exists") == "1"
           and attr(page, '[data-baseline-source="plan"] [data-baseline-source-exists]', "data-exists") == "1",
           "A-2 两源都如实显示「已就位」")
        ver_d = text_of(page, '[data-baseline-source-version="design"]')
        ver_p = text_of(page, '[data-baseline-source-version="plan"]')
        ok(ver_d not in (None, "", "—") and ver_p not in (None, "", "—"),
           "A-3 两源各显示当前版本短标（%s / %s）" % (ver_d, ver_p))
        ok(attr(page, "[data-baseline-active]", "data-baseline-active") == "none",
           "A-4 未激活时如实显示「还没有生效基线」")
        # V09-28 复审：正向基线区按**现行授权**的角色口径说明（不再说"两条笔/只能人和 Max"这类旧说法）
        panel_text = text_of(page, "[data-baseline-panel]") or ""
        ok("两条笔" not in panel_text and "只能人和" not in panel_text and "Max" not in panel_text,
           "A-5 审定区不含与现行授权不符的旧文案（两条笔 / 只能人和 Max）")
        ok("用户已委派的设计角色" in panel_text and "我本人" in panel_text,
           "A-6 审定区按角色口径说明：技术审定=用户已委派的设计角色、用户确认=我本人")
        ok(len(ver_d or "") <= 24 and len(ver_p or "") <= 24,
           "A-7 两源版本以短标呈现（用户不必理解哈希内部细节：%s / %s）" % (ver_d, ver_p))
        page.screenshot(path=os.path.join(SHOT_DIR, "01-panel-before.png"))

        # ═══ B）真正激活（真后端写 baselines.jsonl）═══
        step["now"] = "B 激活"
        page.fill("[data-baseline-approver]", "gpt-6-verify")
        page.fill("[data-baseline-basis]", "界面技术审定夹具依据（V09-28 UI 验证）")
        page.click("[data-baseline-activate]")
        ok(wait_for(page, "[data-baseline-notice]", 15), "B-1 点击「审定并激活基线」后出现回执")
        notice = text_of(page, "[data-baseline-notice]") or ""
        ok("已激活" in notice or "生效" in notice, "B-2 回执说明已激活（%s）" % notice[:60])
        # 面板状态切到 present（可能等一轮重取；bump reloadTick 会立即重取）
        ok(wait_for(page, '[data-baseline-active="present"]', 10), "B-3 生效基线区切到 present")
        active_id = text_of(page, "[data-baseline-active-id]") or ""
        ok(active_id.startswith("bl-"), "B-4 显示生效基线 id（%s）" % active_id)
        ok(baseline_count(backend, FIX_A) == 1, "B-5 后端 baselines.jsonl 恰好 1 条")
        ok(not os.path.exists(os.path.join(proj_a, ".工作台", "gate.jsonl")),
           "B-6 激活不写用户 Gate（无 gate.jsonl）")
        page.screenshot(path=os.path.join(SHOT_DIR, "02-activated.png"))

        # ═══ C）零差异重复不滥增 ═══
        step["now"] = "C 零差异重复"
        page.fill("[data-baseline-approver]", "gpt-6-verify")
        page.fill("[data-baseline-basis]", "再次审定同一套（夹具）")
        page.click("[data-baseline-activate]")
        page.wait_for_timeout(2000)
        ok(baseline_count(backend, FIX_A) == 1, "C-1 零差异重复激活不新增基线（仍 1 条）")

        # ═══ D）自动重取不丢输入 / 不清空内容 ═══
        step["now"] = "D 刷新保留输入"
        page.fill("[data-discuss-input]", "D-待议草稿应被保留")
        page.fill("[data-discuss-reason=\"0\"]", "D-处置理由应被保留")
        page.fill("[data-baseline-basis]", "D-审定依据应被保留")
        before_body = text_of(page, "[data-design-view]") or ""
        ok("夹具设计书" in before_body, "D-0 设计书正文初始可见")
        page.wait_for_timeout(POLL_WAIT_MS)  # 跨过至少一轮自动对账（token 前进→重取）
        ok(page.input_value("[data-discuss-input]") == "D-待议草稿应被保留", "D-1 自动对账后待议草稿仍在")
        ok(page.input_value('[data-discuss-reason="0"]') == "D-处置理由应被保留", "D-2 自动对账后处置理由仍在")
        ok(page.input_value("[data-baseline-basis]") == "D-审定依据应被保留", "D-3 自动对账后审定依据仍在")
        after_body = text_of(page, "[data-design-view]") or ""
        ok("夹具设计书" in after_body, "D-4 自动对账没把设计书正文清成加载态（旧数据可见）")

        # ═══ E）刷新失败：保留旧数据并如实标失败 ═══
        step["now"] = "E 刷新失败保留旧数据"
        info("visibilityState=%s" % page.evaluate("() => document.visibilityState"))
        seen = {"design": 0}
        def fail_design(route, request):
            if request.method == "GET" and request.url.endswith("/design"):
                seen["design"] += 1
                route.fulfill(status=500, content_type="application/json",
                              body='{"ok":false,"error":{"code":"FIXTURE","message":"夹具故障"}}')
            else:
                route.continue_()
        page.route("**/*", fail_design)
        page.wait_for_timeout(POLL_WAIT_MS)
        info("拦截到的 /design 请求数=%d；refresh-error=%d design-view=%d" % (
            seen["design"], page.locator("[data-design-refresh-error]").count(),
            page.locator("[data-design-view]").count()))
        ok(page.locator("[data-design-refresh-error]").count() == 1, "E-1 刷新失败时显示失败横幅")
        # E-1b：持续失败期间横幅**不闪**——错误只在成功后清（否则每轮对账开头先清、失败再置回）
        samples = []
        for _ in range(12):  # ~6s，跨过至少一个 5s 对账周期
            samples.append(page.locator("[data-design-refresh-error]").count())
            page.wait_for_timeout(500)
        ok(all(s == 1 for s in samples), "E-1b 持续失败期间失败横幅不消失（错误只在成功后清，采样=%s）" % samples)
        ok("夹具设计书" in (text_of(page, "[data-design-view]") or ""), "E-2 失败时仍显示上次成功的设计书正文")
        page.unroute("**/*")
        page.wait_for_timeout(POLL_WAIT_MS)
        ok(page.locator("[data-design-refresh-error]").count() == 0, "E-3 恢复后失败横幅自行清除")

        # ═══ F）切项目输入隔离 ═══
        step["now"] = "F 切项目隔离"
        switch_project(page, FIX_B)
        page.click('[data-main-nav] button[data-view="design"]')
        page.wait_for_timeout(POLL_WAIT_MS)  # 让 B 的一轮对账落定（以防旧响应晚到串数据）
        ok(page.input_value("[data-discuss-input]") == "", "F-1 切到 B 后待议输入为空（不串 A 的草稿）")
        ok(page.input_value("[data-baseline-basis]") == "", "F-2 切到 B 后审定依据为空（不串 A 的输入）")
        switch_project(page, FIX_A)
        page.click('[data-main-nav] button[data-view="design"]')
        page.wait_for_timeout(1500)
        ok(page.input_value("[data-discuss-input]") == "D-待议草稿应被保留", "F-3 切回 A 后待议草稿恢复")
        ok(page.input_value("[data-baseline-basis]") == "D-审定依据应被保留", "F-4 切回 A 后审定依据恢复")
        page.screenshot(path=os.path.join(SHOT_DIR, "03-switch-back.png"))

        # ═══ G0）任务原话场景：全新挂载，首次 /design 503 → 显示错误 → 解除拦截 → 不手刷 → 自动恢复 ═══
        # 2026-10-02 小修后：首屏判定改成「本项目是否已成功取到数据」（不再在 load 开头就置位），
        # dev StrictMode 把挂载副作用跑两遍、第一遍被 abort 丢弃，第二遍 firstScreen 仍为 true（没成功过），
        # 于是**全新挂载的首屏失败也会显式上错误页**（此前被误记 refreshError，而 refreshError 只在有正文的
        # 分支渲染，页面就无限停在「加载设计书…」）。所以 G0 现在同时锁两件事：503 期间是错误页而非无限加载、
        # 解除后自动恢复（F2：恢复必须自动显示，不需手刷）。
        step["now"] = "G0 原话场景（全新挂载首屏断线）"
        f = ctx.new_page()
        f.set_default_timeout(15000)
        f_hits = {"n": 0}

        def fresh_fail(route, request):
            if request.method == "GET" and request.url.endswith("/design"):
                f_hits["n"] += 1
                route.fulfill(status=503, content_type="application/json",
                              body=json.dumps({"ok": False, "error": {"code": "FIXTURE", "message": "哨兵F-全新挂载首屏失败"}}))
            else:
                route.continue_()

        f.route("**/*", fresh_fail)
        f.goto("%s/#p/%s" % (base, FIX_A), wait_until="domcontentloaded")
        f.wait_for_timeout(1600)
        f.click('[data-main-nav] button[data-view="design"]')
        f.wait_for_timeout(1500)
        f_loading = f.locator("text=加载设计书").count()
        f_err = f.locator("[data-design-retry]").count()
        info("G0 全新挂载首屏 503 命中 %d 次；错误页=%d 正文=%d 加载中=%d" % (
            f_hits["n"], f_err, f.locator("[data-design-view]").count(), f_loading))
        ok(f_hits["n"] >= 1 and f.locator("[data-design-view]").count() == 0
           and f_err == 1 and f_loading == 0,
           "G0-1 全新挂载首屏 503 期间显式上错误页（不是无限「加载设计书…」）")
        f.screenshot(path=os.path.join(SHOT_DIR, "07-fresh-first-load-503.png"))
        f.unroute("**/*")
        f.wait_for_timeout(POLL_WAIT_MS)  # 关键：不点任何刷新
        ok(f.locator("[data-design-view]").count() == 1
           and "夹具设计书" in (text_of(f, "[data-design-view]") or "")
           and f.locator("[data-design-retry]").count() == 0
           and f.locator("[data-design-refresh-error]").count() == 0,
           "G0-2 解除拦截后错误页自动清、正文自动恢复（不点任何刷新，跨过一轮 5s 对账）")
        f.screenshot(path=os.path.join(SHOT_DIR, "08-fresh-recovered.png"))
        f.close()

        # ═══ G）首屏失败 → 自动恢复（不手刷）＋ H）换项目旧错误不串（契约 F2、§3.14）═══
        # 反例来源：2026-10-02 实读 DesignView.load() —— `loadError` 只在「换项目」分支被清过；
        # 首屏失败走的就是这一分支（置 loadError），而此后每轮对账的**成功**分支只清 refreshError，
        # 于是 `if (loadError) return 错误页` 会把恢复后的正文永久挡住：F2「首屏断线→恢复必须自动显示，
        # 不需手刷」失效。
        # 怎么在 dev 里真复现（不是想当然）：**新挂载**时 StrictMode 会把挂载副作用跑两遍，第一遍被
        # abort 丢弃、第二遍的 firstScreen 已是 false，所以全新挂载的首次失败只落 refreshError，碰不到
        # loadError。能碰到 loadError 的是「设计页已挂载、切项目触发的那次加载失败」。因此本节先把 A/B
        # 两个项目的 scope.view 都置成 design（DesignView 不卸载、只换 prop），再让切过去那次 /design 503。
        step["now"] = "G 首屏失败自动恢复"
        MSG_A = "哨兵A-夹具失败"
        MSG_B = "哨兵B-夹具失败"
        g = ctx.new_page()
        g.set_default_timeout(15000)
        g_hits = {"a": 0}

        # 预备：A、B 各自在设计页正常加载一次 → 两个项目的 scope.view 都是 design
        for pid in (FIX_A, FIX_B):
            g.goto("%s/#p/%s" % (base, pid), wait_until="domcontentloaded")
            g.wait_for_timeout(1500)
            g.click('[data-main-nav] button[data-view="design"]')
            g.wait_for_timeout(1500)
        ok(g.locator("[data-design-view]").count() == 1,
           "G-0 预备：两项目 view=design，DesignView 已挂载（换项目只换 prop、不卸载）")

        def fail_a_design(route, request):
            if request.method == "GET" and request.url.endswith("/design"):
                g_hits["a"] += 1
                route.fulfill(status=503, content_type="application/json",
                              body=json.dumps({"ok": False, "error": {"code": "FIXTURE", "message": MSG_A}}))
            else:
                route.continue_()

        g.route("**/*", fail_a_design)
        g.evaluate("(p) => { window.location.hash = '#p/' + p; }", FIX_A)  # 切回 A：这次首屏加载失败
        g.wait_for_timeout(2500)
        info("G 切回 A 的首屏 /design 503 命中 %d 次；错误页=%d 正文=%d" % (
            g_hits["a"], g.locator("[data-design-retry]").count(), g.locator("[data-design-view]").count()))
        ok(g.locator("[data-design-retry]").count() == 1 and g.locator("[data-design-view]").count() == 0,
           "G-1 首屏 /design 503 如实上错误页（无正文）")
        g.screenshot(path=os.path.join(SHOT_DIR, "04-first-load-503.png"))
        g.unroute("**/*")
        # 关键：**不点** [data-design-retry]，只等自动对账（F2：恢复必须自动显示，不需手刷）
        g.wait_for_timeout(POLL_WAIT_MS)
        info("解除拦截后（未点任何刷新）：错误页=%d 正文=%d" % (
            g.locator("[data-design-retry]").count(), g.locator("[data-design-view]").count()))
        ok(g.locator("[data-design-retry]").count() == 0, "G-2 解除拦截后错误页自行消失（未点任何刷新）")
        ok(g.locator("[data-design-view]").count() == 1
           and "夹具设计书" in (text_of(g, "[data-design-view]") or ""),
           "G-3 首屏断线后正文自动恢复（不手刷，跨过一轮 5s 对账）")
        ok(g.locator("[data-design-refresh-error]").count() == 0, "G-4 恢复后不留失败横幅")
        g.screenshot(path=os.path.join(SHOT_DIR, "05-first-load-recovered.png"))

        # ── H）换项目：旧项目的失败横幅 / 最近成功时间 / 旧正文不带入新项目（§3.14）──
        # settled 状态看不出串（新项目一旦有正文就意味着成功、成功即清 refreshError），能露出来的只有
        # 「换过去之后、归零生效之前」那一帧——用 MutationObserver 采这一帧有没有画过 A 的哨兵。
        step["now"] = "H 换项目失败标记隔离"

        def fail_design_as(msg, code):
            def handler(route, request):
                if request.method == "GET" and request.url.endswith("/design"):
                    route.fulfill(status=code, content_type="application/json",
                                  body=json.dumps({"ok": False, "error": {"code": "FIXTURE", "message": msg}}))
                else:
                    route.continue_()
            return handler

        # H-1：A 已有正文时刷新失败 → 横幅带 A 自己的「最近成功」时间
        g.route("**/*", fail_design_as(MSG_A, 500))
        g.wait_for_timeout(POLL_WAIT_MS)
        banner_a = text_of(g, "[data-design-refresh-error]") or ""
        ok(g.locator("[data-design-refresh-error]").count() == 1 and "最近成功" in banner_a,
           "H-1 A 刷新失败时横幅带最近成功时间（%s）" % banner_a[:64])
        g.evaluate("""() => {
          window.__stale = [];
          const mo = new MutationObserver(() => {
            if (location.hash.indexOf('#p/fb-b') < 0) return;
            if ((document.body.textContent || '').indexOf('哨兵A-') >= 0) window.__stale.push(Math.round(performance.now()));
          });
          mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
        }""")
        # H-2：切到 B（B 首屏也失败）→ 只能显示 B 自己的错误页，不得带 A 的横幅/时间戳/旧正文
        g.unroute("**/*")
        g.route("**/*", fail_design_as(MSG_B, 503))
        g.evaluate("(p) => { window.location.hash = '#p/' + p; }", FIX_B)
        g.wait_for_timeout(2500)
        stale = g.evaluate("() => window.__stale")
        b_body = text_of(g, "[data-design-view]") or ""
        info("切到 B 后：A 哨兵出现帧=%s；错误页=%d 正文长度=%d A横幅残留=%d" % (
            stale, g.locator("[data-design-retry]").count(), len(b_body),
            g.locator("[data-design-refresh-error]").count()))
        ok(g.locator("[data-design-retry]").count() == 1 and b_body == ""
           and g.locator("[data-design-refresh-error]").count() == 0,
           "H-2 切到 B 后不显示 A 的失败横幅/旧正文（B 用自己的首屏错误）")
        ok(stale == [], "H-3 换项目这一帧也没把 A 的错误/失败横幅带进 B（采样=%s）" % stale)
        # H-4：解除拦截 → B 自己恢复，不留失败标记
        g.unroute("**/*")
        g.wait_for_timeout(POLL_WAIT_MS)
        ok(g.locator("[data-design-view]").count() == 1
           and g.locator("[data-design-refresh-error]").count() == 0,
           "H-4 解除拦截后 B 自动恢复到 B 自己的正文，无残留失败标记")
        g.screenshot(path=os.path.join(SHOT_DIR, "06-switch-no-stale-error.png"))
        g.close()

        # ═══ I）正向基线动作（激活）代际守卫：C 的晚到回执不得写到 B（§3.14 / 契约 F2）═══
        # 真后端 + route **只扣住回执**：C 点激活后请求被扣住（C 显示忙）→ 切 B → 放行回执
        # （continue_ 交给真实服务照常写入，不伪造成功）→ 断言 B 上不出现 C 的成功/错误/忙状态；
        # 回 C 由普通自动读显示已提交的生效基线。用干净夹具 C（源）+ B（他项目），避开 A–H 段的既有写入。
        # 关键前提：先把 C、B 的 scope.view 都置成 design——DesignView 不卸载、换项目只换 prop，
        # 在途回执才有机会"落到 B 上"；若换了组件实例，守卫就失去被检验的现场，测试会假绿。
        step["now"] = "I 激活动作代际守卫"
        ix = ctx.new_page()
        ix.set_default_timeout(15000)
        held = []          # 被扣住的 route（不 resolve，等主线程放行 → 真实服务才处理）
        resp_status = {}   # 放行后真实后端回执的 HTTP 状态（证明"只延迟、没伪造"）

        def hold_c_baseline(route, request):
            u = request.url
            if request.method == "POST" and (
                "/api/projects/%s/documents/activate" % FIX_C in u
                or "/api/projects/%s/documents/preserve" % FIX_C in u
            ):
                held.append(route)
            else:
                route.continue_()

        def on_resp(r):
            if "/documents/activate" in r.url or "/documents/preserve" in r.url:
                resp_status[r.url] = r.status

        ix.on("response", on_resp)
        ix.route("**/*", hold_c_baseline)
        for pid in (FIX_C, FIX_B):
            ix.goto("%s/#p/%s" % (base, pid), wait_until="domcontentloaded")
            ix.wait_for_timeout(1500)
            ix.click('[data-main-nav] button[data-view="design"]')
            ix.wait_for_timeout(1500)
        switch_project(ix, FIX_C)
        ix.click('[data-main-nav] button[data-view="design"]')
        wait_for(ix, "[data-baseline-source-exists=\"design\"]", 12)
        ix.wait_for_timeout(800)
        ok(attr(ix, "[data-baseline-active]", "data-baseline-active") == "none",
           "I-0 干净夹具 C 尚无生效基线（后端 count=%s）" % baseline_count(backend, FIX_C))

        # C：填审定者/依据 → 点激活 → 请求被扣住 → C 显示忙
        ix.fill("[data-baseline-approver]", "guard-verify")
        ix.fill("[data-baseline-basis]", "代际守卫夹具依据（真实后端，只用 route 扣住回执）")
        ix.click("[data-baseline-activate]")
        ix.wait_for_timeout(600)
        ok(len(held) == 1 and text_of(ix, "[data-baseline-activate]") == "激活中…",
           "I-1 C 点激活后请求被扣住、C 显示忙（激活中…）")

        # 切到 B（C 请求仍在途）
        switch_project(ix, FIX_B)
        ix.wait_for_timeout(1200)
        b_clean = (ix.locator("[data-baseline-notice]").count() == 0
                   and ix.locator("[data-baseline-error]").count() == 0
                   and text_of(ix, "[data-baseline-activate]") != "激活中…"
                   and attr(ix, "[data-baseline-active]", "data-baseline-active") == "none")
        ok(b_clean, "I-2 切到 B 后不显示 C 的忙状态/成功/错误（B 自己仍无基线）")

        # 放行 C 的激活（真实服务照常写入 C）；晚到回执落在 B 上，必须被丢弃
        for r in held:
            r.continue_()
        held.clear()
        ix.wait_for_timeout(2500)
        ok(ix.locator("[data-baseline-notice]").count() == 0
           and ix.locator("[data-baseline-error]").count() == 0
           and text_of(ix, "[data-baseline-activate]") != "激活中…"
           and attr(ix, "[data-baseline-active]", "data-baseline-active") == "none",
           "I-3 C 的晚到激活回执不写到 B（B 上无 C 的成功/错误/忙状态）")
        ok(baseline_count(backend, FIX_C) == 1, "I-4 真实服务照常写入 C 的基线（count=1），route 只延迟不伪造")
        act_status = [s for u, s in resp_status.items() if "/documents/activate" in u]
        ok(200 in act_status, "I-5 放行后的 activate 回执来自真实后端（HTTP %s）" % act_status)
        ix.screenshot(path=os.path.join(SHOT_DIR, "09-late-baseline-on-b.png"))

        # 回 C：已提交的基线事实由普通自动读显示，且旧代回执不留提示
        switch_project(ix, FIX_C)
        ix.click('[data-main-nav] button[data-view="design"]')
        ix.wait_for_timeout(2000)
        ok(attr(ix, "[data-baseline-active]", "data-baseline-active") == "present"
           and (text_of(ix, "[data-baseline-active-id]") or "").startswith("bl-"),
           "I-6 回 C 后普通自动读显示已提交的生效基线")
        ok(ix.locator("[data-baseline-notice]").count() == 0,
           "I-7 回 C 不显示旧代晚到回执（提示已被代际守卫丢弃）")

        # ═══ J）A→B→A 的保存晚到回执：旧代一律丢弃，不落到回 A 后的 A 上 ═══
        step["now"] = "J A→B→A 保存晚到回执"
        wait_for(ix, '[data-baseline-preserve="design"]', 12)
        ix.click('[data-baseline-preserve="design"]')
        ix.wait_for_timeout(500)
        ok(len(held) == 1 and bool(ix.locator('[data-baseline-preserve="design"]').first.is_disabled()),
           "J-1 C 点保存后请求被扣住、C 显示忙（保存按钮禁用）")
        switch_project(ix, FIX_B)
        ix.wait_for_timeout(1200)
        switch_project(ix, FIX_C)
        ix.wait_for_timeout(1200)
        for r in held:
            r.continue_()
        held.clear()
        ix.wait_for_timeout(2500)
        ok(ix.locator("[data-baseline-notice]").count() == 0
           and ix.locator("[data-baseline-error]").count() == 0
           and not ix.locator('[data-baseline-preserve="design"]').first.is_disabled(),
           "J-2 A→B→A 后旧代保存回执被丢弃（回 A 无提示、无错误、不卡忙）")
        pre_status = [s for u, s in resp_status.items() if "/documents/preserve" in u]
        ok(200 in pre_status, "J-3 放行后的 preserve 回执来自真实后端（HTTP %s）" % pre_status)
        ix.screenshot(path=os.path.join(SHOT_DIR, "10-abba-preserve-guard.png"))
        ix.close()

        browser.close()


def main():
    tmp = tempfile.mkdtemp(prefix="tatai-fbui-")
    home = os.path.join(tmp, "home")
    os.makedirs(home, exist_ok=True)
    proj_a = make_fixture(tmp, FIX_A)
    proj_b = make_fixture(tmp, FIX_B)
    proj_c = make_fixture(tmp, FIX_C)
    make_registry(home, [
        (FIX_A, "V09-28 正向基线夹具 A", proj_a),
        (FIX_B, "V09-28 正向基线夹具 B", proj_b),
        (FIX_C, "V09-28 正向基线夹具 C", proj_c),
    ])
    os.makedirs(SHOT_DIR, exist_ok=True)
    backend_port = free_port()
    vite_port = int(VITE_PORT_OVERRIDE) if VITE_PORT_OVERRIDE else free_port()
    backend = None
    vite = None
    try:
        step["now"] = "起后端"
        backend = Backend(home, backend_port, os.path.join(SHOT_DIR, "ui-backend.log"))
        backend.wait_health()
        info("后端就绪：127.0.0.1:%d（TATAI_HOME=%s）" % (backend_port, home))
        step["now"] = "起 vite"
        vite = start_vite(vite_port, backend_port, os.path.join(SHOT_DIR, "ui-vite.log"),
                          os.path.join(tmp, "vite-cache"))
        info("vite 就绪：http://localhost:%d" % vite_port)
        step["now"] = "跑浏览器"
        run_browser(vite_port, backend, proj_a, proj_b)
    except Exception as e:  # noqa: BLE001
        ok(False, "运行期出错（%s 阶段）：%s" % (step["now"], e))
    finally:
        for proc in (vite, backend):
            if proc is None:
                continue
            try:
                if proc is backend:
                    backend.kill()
                else:
                    proc.kill()
                    proc.wait(timeout=10)
            except Exception:
                pass
        if not KEEP:
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            info("保留现场：%s" % tmp)

    print("[ui] 计数：%d PASS / %d FAIL" % (passes[0], len(fails)))
    if fails:
        print("[ui] 存在 FAIL")
        sys.exit(1)
    print("[ui] 全部 PASS")


if __name__ == "__main__":
    main()
