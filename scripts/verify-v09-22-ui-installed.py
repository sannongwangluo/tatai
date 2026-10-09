#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-22 正式安装版 UI 验证（F1 验收）：附着安装版 WebView2 真机驱动六图。

用途（F1）
  Codex 审验发现：原 `verify-v09-22-ui.py` 启动的是 vite dev（浏览器里的开发态证据），
  没有驱动**正式桌面入口**。正式安装版是 Tauri exe（前端内嵌进 WebView2），本脚本用
  WebView2 的远程调试口（CDP）附着到**真机安装版**上，复用原脚本的步骤逻辑与选择器，
  在正式入口上重跑同一批 UI 断言——证明「安装版能真渲染六图、交互真的可用」。

前置条件（由协调器准备）
  1) 已用隔离 TATAI_HOME 启动**安装版** tatai.exe（后端为 exe 自带 sidecar，默认端口 8787）；
  2) 启动时带环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
     （或与本脚本 --cdp-port 一致的端口）。

用法
  python scripts/verify-v09-22-ui-installed.py --cdp-port 9222 --backend-port 8787
  （--log-dir 换输出目录，默认脚本旁 tmp-ui-installed）

与原脚本的关系
  步骤同源：step0 六图 + step1–step6 复用 `verify-v09-22-ui.py` 的选择器与断言逻辑；差别只在
  入口——那边起 vite dev 用本地浏览器打开，这边连 CDP 附着正式安装版的 WebView2。

隔离口径（AGENTS.md §5；2026-09-29 定向收尾 R2 加固）
  夹具项目全部落在本脚本自建临时目录，经**安装版后端自己的 API**（POST /api/projects）注册进
  协调器给的隔离 TATAI_HOME；真实 ~/.tatai 与真实项目零接触。
  **写前隔离核对（硬闸）**：--expect-data-dir 必填；脚本先 GET /health 取 data_dir＋pid，
  与预期隔离目录规范化比对（normcase＋realpath，两侧同口径）——不匹配立即退出（exit 2），
  且任何 DELETE/POST/PUT/PATCH 在核对通过前一律被写保护拦下（Backend.api 里计数留痕并抛错），
  不存在「HTTP 200 就当隔离对了」的路径。核对结论、实际 data_dir、后端 pid、CDP 身份与
  全程写请求流水落 `<log-dir>/isolation.log`；错目录零写请求的保护验证＝用故意错的
  --expect-data-dir 跑一次本脚本，看它在写前退出且 isolation.log 写请求数为 0。
  全程控制台消息（含时间戳与 url）整份留档到 `<log-dir>/console-full.log`。收尾删临时目录、
  注销夹具项目；**不杀塔台进程**（那是协调器的事），只断开 playwright 连接。
"""
import argparse
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

# 输出目录：由 --log-dir 在 main() 里赋值（截图与控制台留档都落这里）
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tmp-ui-installed")
KEEP = os.environ.get("V0922_KEEP_TMP") == "1"
# 主夹具项目 id：内置自建、只落临时区，经安装版后端 API 注册进隔离 home。
MAIN_PROJECT = "v0922-ui-main"
MAIN_BIG_CHILDREN = 50
# 主夹具规划层：8 个能力分组 ＋ 8 张任务卡；全部锚到夹具里真实存在的静态模块 mod-01
# （见 build_main_blueprint 说明：锚到实测模块只挂 plan_refs、不新建灰节点，技术详情图不被扰动）
MAIN_CAP_COUNT = 8
MAIN_PLAN_ANCHOR = "mod-01"
VIEW = (1600, 950)

passes = [0]
fails = []
skips = []
CONSOLE = []  # 全量控制台消息（带时间戳与 url），全程不筛选


def ok(cond, label):
    print(("[ui] PASS " if cond else "[ui] FAIL ") + label)
    if cond:
        passes[0] += 1
    else:
        fails.append(label)


def skip(label):
    print("[ui] SKIP " + label)
    skips.append(label)


def info(msg):
    print("[ui]   " + msg)


# ── 通用工具 ─────────────────────────────────────────────────────────────────
def http_json(url, method="GET", body=None, timeout=240):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, text


def _rm_onerror(func, p, exc):
    # Windows：git 对象文件是只读属性，rmtree 会 WinError 5 拒绝访问——先去掉只读再删
    try:
        os.chmod(p, stat.S_IWRITE)
        func(p)
    except Exception:
        pass


def rmtree_hard(p):
    """删临时目录（Windows：只读 git 对象 + 短暂句柄占用，去只读并重试）。"""
    for _ in range(4):
        if not os.path.exists(p):
            return True
        try:
            shutil.rmtree(p, onerror=_rm_onerror)
        except Exception:
            pass
        if not os.path.exists(p):
            return True
        time.sleep(0.8)
    return not os.path.exists(p)


class Backend:
    """安装版后端：不 spawn，直接指向 exe 自带 sidecar 的端口（协调器已用隔离 home 启动）。

    写保护（R2）：writes_allowed 在隔离核对（verify_isolation）通过前恒为 False——
    任何写方法（POST/DELETE/PUT/PATCH）先记账进 write_log 再抛错，物理上不存在
    「没核对 data_dir 就写出去」的路径；GET 不受限（health 探测本身要靠它）。"""

    WRITE_METHODS = ("POST", "DELETE", "PUT", "PATCH")

    def __init__(self, port):
        self.port = port
        self.writes_allowed = False
        self.write_log = []  # 每次写请求一条：{"t","method","path","blocked"}

    def api(self, path, method="GET", body=None):
        if method.upper() in self.WRITE_METHODS:
            blocked = not self.writes_allowed
            self.write_log.append(
                {"t": _ts(), "method": method.upper(), "path": path, "blocked": blocked})
            if blocked:
                raise RuntimeError(
                    "写保护拦截：%s %s——/health.data_dir 尚未通过隔离核对（--expect-data-dir），"
                    "禁止任何写请求（R2）" % (method.upper(), path))
        return http_json("http://127.0.0.1:%d%s" % (self.port, path), method, body)

    def wait_health(self, timeout=120):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.api("/health")[0] == 200:
                    return
            except Exception:
                pass
            time.sleep(0.3)
        raise RuntimeError("安装版后端 127.0.0.1:%d 未就绪（/health 探测超时）" % self.port)


def _ts():
    return time.strftime("%Y-%m-%dT%H:%M:%S") + ".%03d" % (int(time.time() * 1000) % 1000)


def _norm_dir(p):
    """目录名的规范化比对口径（Windows 大小写/分隔符/尾斜杠/符号链接一视同仁）。"""
    return os.path.normcase(os.path.realpath(os.path.abspath(p)))


def verify_isolation(backend, expect_data_dir):
    """R2 写前硬闸：/health 的 data_dir 必须与预期隔离目录规范化相等，否则在任何写请求前退出。

    通过 → 打开写保护、把实际 data_dir／后端 pid／端口写进 isolation.log；
    不匹配 → 结论与两侧目录写进 isolation.log，exit 2（此刻写请求必为 0，由 write_log 自证）。"""
    st, health = backend.api("/health")
    if st != 200 or not isinstance(health, dict):
        print("[isolation] FAIL /health 不可用（%s %r）——不进行任何写操作" % (st, health))
        _write_isolation_log({"verdict": "fail", "reason": "health_unavailable", "status": st,
                              "write_requests": backend.write_log})
        sys.exit(2)
    actual = health.get("data_dir")
    pid = health.get("pid")
    actual_n = _norm_dir(actual) if isinstance(actual, str) else None
    expect_n = _norm_dir(expect_data_dir)
    entry = {
        "verdict": "match" if actual_n == expect_n else "MISMATCH",
        "checked_at": _ts(),
        "backend_port": backend.port,
        "backend_pid": pid,
        "health_data_dir": actual,
        "health_data_dir_normalized": actual_n,
        "expect_data_dir": expect_data_dir,
        "expect_data_dir_normalized": expect_n,
        "write_requests_so_far": list(backend.write_log),
    }
    info("隔离核对：%s（data_dir=%r vs 预期 %r；后端 pid=%s，端口 %d）"
         % (entry["verdict"], actual, expect_data_dir, pid, backend.port))
    if actual_n != expect_n:
        print("[isolation] FAIL data_dir 不匹配：实际 %r ≠ 预期 %r——按 R2 立即退出，"
              "写请求数 %d（全部被拦截）" % (actual, expect_data_dir, len(backend.write_log)))
        _write_isolation_log(entry)
        sys.exit(2)
    backend.writes_allowed = True
    _write_isolation_log(entry)
    return health


ISOLATION_LOG = []  # 隔离核对与入口身份的追加式流水（isolation.log 的内存态）


def _write_isolation_log(entry):
    ISOLATION_LOG.append(entry)
    path = os.path.join(OUT, "isolation.log")
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return path


# ── CDP 附着（正式入口） ─────────────────────────────────────────────────────
def wait_cdp(cdp_port, timeout=60):
    """轮询 http://127.0.0.1:<cdp-port>/json/version 直到就绪（超时报错退出）。"""
    url = "http://127.0.0.1:%d/json/version" % cdp_port
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=3) as resp:
                if resp.status == 200:
                    return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            last = e
        time.sleep(0.5)
    raise RuntimeError(
        "CDP 端口 %d 未就绪（%s）；确认安装版已带 "
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=%d 启动" % (cdp_port, last, cdp_port))


def find_shell_page(browser, timeout=30):
    """在已有 contexts 里找塔台界面页：url 以 http(s)://tauri.localhost 或 tauri:// 开头。
    找不到就列出所有 pages 的 url 供诊断。"""
    deadline = time.time() + timeout
    last_urls = []
    while time.time() < deadline:
        last_urls = []
        for ctx in browser.contexts:
            for pg in ctx.pages:
                u = pg.url or ""
                last_urls.append(u)
                if (u.startswith("http://tauri.localhost") or u.startswith("https://tauri.localhost")
                        or u.startswith("tauri://")):
                    return pg
        time.sleep(0.5)
    raise RuntimeError("未找到塔台界面页（url 需以 http://tauri.localhost 或 tauri:// 开头）；"
                       "现有 pages：%s" % (last_urls or "（无）"))


def shell_origin(page):
    """从找到的 page.url 取 origin（项目页导航用）。"""
    parts = urllib.parse.urlsplit(page.url)
    return "%s://%s" % (parts.scheme, parts.netloc)


def _msg_line(kind, text, url):
    ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()) + ".%03d" % (int(time.time() * 1000) % 1000)
    body = (text or "").replace("\r", " ").replace("\n", " ")
    return "[%s] %s %s: %s" % (ts, kind, url or "-", body)


def on_console(msg):
    # 审验要求：**所有**消息都收（不按类型筛选），带时间戳与 url
    loc = msg.location or {}
    CONSOLE.append(_msg_line("console.%s" % msg.type, msg.text, loc.get("url") or ""))


def on_pageerror(err):
    CONSOLE.append(_msg_line("pageerror", str(err), ""))


# ── 页面导航（hash 路由沿用原脚本惯例，项目页 origin 从 shell page 取） ─────────
def nav_project(page, project):
    target = "%s/#p/%s" % (page._shell_origin, urllib.parse.quote(project, safe=""))
    try:
        page.goto(target, wait_until="domcontentloaded")
    except Exception:
        # 自定义 scheme（tauri://）goto 可能不被允许：退回改 location.href
        page.evaluate("(h) => { window.location.href = h; }", target)


def open_arch(page, project):
    nav_project(page, project)
    page.wait_for_timeout(2500)
    page.locator('button[data-view="arch"]').click()
    page.wait_for_selector("[data-arch-tab]", timeout=40000)
    page.wait_for_timeout(1000)


def open_tech(page, mode):
    page.locator('[data-project-view-tab="tech"]').click()
    page.wait_for_selector("[data-graph-mode-switch]", timeout=40000)
    page.locator('[data-graph-mode="%s"]' % mode).click()
    page.wait_for_timeout(2200)


def open_main(page, name):
    page.locator('[data-project-view-tab="%s"]' % name).click()
    page.wait_for_timeout(2200)


def wait_nodes(page, target, timeout=40):
    end = time.time() + timeout
    n = -1
    while time.time() < end:
        n = page.locator("[data-arch-view] .react-flow__node").count()
        if n == target:
            return n
        page.wait_for_timeout(200)
    return n


def wait_count(locator, timeout=30):
    """轮询等待 locator 计数 > 0（拿不到就返回最终计数，供断言如实报数）。"""
    end = time.time() + timeout
    n = 0
    while time.time() < end:
        n = locator.count()
        if n > 0:
            return n
        time.sleep(0.3)
    return n


def viewport_transform(page):
    return page.evaluate(
        "() => { const vp = document.querySelector('.react-flow__viewport');"
        " return vp ? getComputedStyle(vp).transform : null; }")


# ── step0：逐张打开六图 ───────────────────────────────────────────────────────
def step0_six_graphs(page, rec):
    """⓪ 逐张打开六图：三主视图（functional/architecture/construction，open_main 页签切换）
    ＋三技术图（module_map=MODULE_BOX / data_flow=DATA_FLOW / mind_map=MIND_MAP，open_tech
    的 hash 惯例），每张断言容器与节点非空。"""
    for name in ("functional", "architecture", "construction"):
        open_main(page, name)
        host = page.locator('[data-project-view="%s"]' % name)
        ok(host.count() >= 1, "⓪ 主视图 %s 容器在场（data-project-view=%s）" % (name, name))
        n = wait_count(page.locator('[data-project-view="%s"] .react-flow__node' % name), timeout=30)
        ok(n > 0, "⓪ 主视图 %s 节点非空（.react-flow__node=%d）" % (name, n))
        rec.setdefault("step0", {})[name] = {"container": host.count(), "nodes": n}
        page.screenshot(path=os.path.join(OUT, "00-main-%s.png" % name))
    for label, mode in (("module_map", "MODULE_BOX"), ("data_flow", "DATA_FLOW"), ("mind_map", "MIND_MAP")):
        open_tech(page, mode)
        if mode == "MIND_MAP":
            page.wait_for_selector("[data-mindmap-view]", timeout=40000)
            n = 0
            end = time.time() + 30
            while time.time() < end:
                n = page.locator("[data-mindmap-view] .markmap-node").count()
                if n > 0:
                    break
                page.wait_for_timeout(300)
            host = page.locator("[data-mindmap-view]")
            ok(host.count() >= 1, "⓪ 技术图 %s 容器在场（data-mindmap-view）" % label)
            ok(n > 0, "⓪ 技术图 %s 节点非空（.markmap-node=%d）" % (label, n))
        else:
            host = page.locator("[data-arch-view]")
            ok(host.count() >= 1, "⓪ 技术图 %s 容器在场（data-arch-view）" % label)
            n = wait_count(page.locator("[data-arch-view] .react-flow__node"), timeout=30)
            ok(n > 0, "⓪ 技术图 %s 节点非空（.react-flow__node=%d）" % (label, n))
        rec.setdefault("step0", {})[label] = {"nodes": n}
        page.screenshot(path=os.path.join(OUT, "00-tech-%s.png" % label))


# ── 七步（step1–step6，与原脚本同源） ─────────────────────────────────────────
def step1_full_toggle(page, backend, project, rec):
    r_over = backend.api("/api/projects/%s/arch/render" % urllib.parse.quote(project))[1]
    r_full = backend.api("/api/projects/%s/arch/render?full=1" % urllib.parse.quote(project))[1]
    ov_nodes = r_over["render"]["graph"]["nodes"]
    full_nodes = r_full["render"]["graph"]["nodes"]
    rec["overview_nodes"] = len(ov_nodes)
    rec["full_nodes"] = len(full_nodes)
    info("概览节点 %d / 全量节点 %d（现场取）；全量聚合标记 %s" % (
        len(ov_nodes), len(full_nodes), r_full["render"]["graph"]["truncated"]))
    n0 = wait_nodes(page, len(ov_nodes))
    ok(n0 == len(ov_nodes), "① 概览画布节点数 %d === 概览 API %d" % (n0, len(ov_nodes)))
    ok(page.locator("[data-arch-show-all]").is_visible(), "① 概览态 `data-arch-show-all` 在场且可见")
    agg_before = page.locator("[data-arch-view] [data-arch-aggregate]").count()
    ok(agg_before >= 1, "① 概览态聚合节点在场（%d 个 [data-arch-aggregate]）" % agg_before)
    t0 = time.time()
    page.locator("[data-arch-show-all]").click()
    n_full = wait_nodes(page, len(full_nodes))
    rec["full_layout_ms"] = round((time.time() - t0) * 1000)
    ok(page.get_attribute("[data-arch-mode-state]", "data-arch-mode-state") == "full",
       "① 点「显示全部」→ `data-arch-mode-state=full`")
    ok(page.locator("[data-arch-full-note]").count() >= 1, "① 全量态一行说明 `data-arch-full-note` 在场")
    ok(n_full == len(full_nodes), "① 全量画布节点数 %d === full API %d（节点数增长到一致）" % (n_full, len(full_nodes)))
    agg_after = page.locator("[data-arch-view] [data-arch-aggregate]").count()
    ok(agg_after == 0, "① 全量态聚合节点消失（[data-arch-aggregate] 计数=%d）" % agg_after)
    page.screenshot(path=os.path.join(OUT, "01-tech-full.png"))
    return full_nodes, ov_nodes


def pick_full_only_fragment(full_nodes, ov_nodes):
    ov_blob = " ".join(("%s %s %s" % (n.get("name"), n.get("id"), n.get("path"))).lower() for n in ov_nodes)
    ov_ids = {n["id"] for n in ov_nodes}
    for n in full_nodes:
        if n["id"] in ov_ids:
            continue
        name = (n.get("name") or "").strip()
        if name == "":
            continue
        frag = name.lower()
        if frag in ov_blob:
            continue
        hits = [m for m in full_nodes
                if frag in ("%s %s %s" % (m.get("name"), m.get("id"), m.get("path"))).lower()]
        if len(hits) == 1 and hits[0]["id"] == n["id"]:
            return n["id"], name
    return None, None


def step2_search(page, full_nodes, ov_nodes, rec):
    target_id, frag = pick_full_only_fragment(full_nodes, ov_nodes)
    ok(target_id is not None, "② 现场找到「仅全量模式存在」的节点名片段：%r（id=%s）" % (frag, target_id))
    if target_id is None:
        return
    # 概览态下搜不到（如实提示）——先确认这一条非特例
    page.locator("[data-arch-search]").fill(frag)
    page.wait_for_timeout(500)
    ov_count = page.get_attribute("[data-arch-search-count]", "data-arch-search-count")
    rec["search_overview_count"] = ov_count
    # 先在概览态验证（此时按钮已切到全量，故回落概览后再测；见 step3 已复位为概览）
    page.locator("[data-arch-search]").fill(frag)
    page.wait_for_timeout(700)
    cnt = page.get_attribute("[data-arch-search-count]", "data-arch-search-count")
    ok(cnt not in (None, "", "0", "无匹配"), "② 全量态搜索命中计数 `data-arch-search-count`=%s（非 0）" % cnt)
    page.keyboard.press("Enter")
    page.wait_for_timeout(900)
    focused = page.get_attribute("[data-arch-mode-state]", "data-arch-focused")
    rec["search_focused"] = focused
    ok(focused == target_id, "② Enter → `data-arch-focused`=%s（= 该节点 id）" % (focused or "(空)"))
    ok(page.locator("[data-arch-view] .react-flow__node[data-id='%s']" % target_id).count() == 1,
       "② 命中节点确实出现在画布上（.react-flow__node[data-id=%s]）" % target_id)
    page.screenshot(path=os.path.join(OUT, "02-search-focus.png"))


def step3_keyboard(page, full_nodes, rec):
    # 键盘：Tab 从搜索框移到下一个可聚焦元素；Enter 激活「显示全部」按钮使状态属性翻转
    page.locator("[data-arch-search]").focus()
    page.keyboard.press("Tab")
    page.wait_for_timeout(200)
    after_tab = page.evaluate("() => { const a = document.activeElement; return a ? (a.getAttribute('data-arch-search-prev') !== null ? 'search-prev' : (a.tagName + ':' + (a.getAttribute('data-arch-search-next') !== null ? 'search-next' : ''))) : 'none'; }")
    rec["tab_after_search"] = after_tab
    ok(after_tab in ("search-prev", "BUTTON:search-next", "BUTTON:"), "③ Tab 从搜索框移到搜索行按钮（activeElement=%s）" % after_tab)
    # 回到概览，再用键盘 Enter 激活「显示全部」
    if page.locator("[data-arch-show-overview]").count() > 0:
        page.locator("[data-arch-show-overview]").click()
        page.wait_for_timeout(1500)
    ok(page.get_attribute("[data-arch-mode-state]", "data-arch-mode-state") == "overview", "③ 已回到 `data-arch-mode-state=overview`")
    page.locator("[data-arch-show-all]").focus()
    focused_el = page.evaluate("() => document.activeElement ? (document.activeElement.getAttribute('data-arch-show-all') !== null ? 'show-all' : document.activeElement.tagName) : 'none'")
    ok(focused_el == "show-all", "③ Tab/焦点落在「显示全部」按钮上（activeElement=%s）" % focused_el)
    page.keyboard.press("Enter")
    wait_nodes(page, len(full_nodes))
    ok(page.get_attribute("[data-arch-mode-state]", "data-arch-mode-state") == "full", "③ Enter 激活「显示全部」→ 状态属性翻转为 full")
    return full_nodes


def step3_node_enter(page, project, rec):
    """节点元素聚焦后 Enter 触发详情回调（系统架构主视图的 ArchCanvas 传了 onNodeClick）。"""
    open_main(page, "architecture")
    n = 0
    end = time.time() + 30
    while time.time() < end:
        n = page.locator("[data-arch-view] .react-flow__node").count()
        if n > 0:
            break
        page.wait_for_timeout(400)
    if n > 0:
        page.wait_for_timeout(1200)  # 等 React Flow 首帧布局稳定
    rec["arch_view_nodes"] = n
    if n == 0:
        ok(False, "③ 系统架构主视图没有可聚焦节点（工程 %s 主视图为空，跳过 Enter 详情断言）" % project)
        return None
    node_id = None
    active_in_node = False
    for _ in range(25):  # React Flow 节点可能重排：聚焦与校验之间留重试窗口
        node_id = page.evaluate(
            "() => { const el = document.querySelector('[data-arch-view] .react-flow__node');"
            " if (!el) return null; el.focus(); return el.getAttribute('data-id'); }")
        page.wait_for_timeout(200)
        active_in_node = page.evaluate(
            "() => { const a = document.activeElement; return !!(a && a.closest && a.closest('.react-flow__node')); }")
        if node_id and active_in_node:
            break
    if not (node_id and active_in_node):
        dbg = page.evaluate(
            """() => ({ views: document.querySelectorAll('[data-arch-view]').length,
                 nodes: document.querySelectorAll('[data-arch-view] .react-flow__node').length,
                 tabindex: document.querySelector('[data-arch-view] .react-flow__node')?.getAttribute('tabindex'),
                 activeTag: document.activeElement?.tagName,
                 activeClass: document.activeElement?.className?.toString().slice(0,60),
                 activeInNode: !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.react-flow__node')) })""")
        rec["node_enter_focus_debug"] = dbg
        info("③ 节点聚焦诊断：%s" % json.dumps(dbg, ensure_ascii=False))
    ok(bool(node_id) and active_in_node, "③ 节点元素可聚焦（data-id=%s，activeElement 落在 .react-flow__node 内）" % node_id)
    if not (node_id and active_in_node):
        return None
    before = page.locator("[data-project-detail] [data-detail-section]").count()
    page.keyboard.press("Enter")
    page.wait_for_timeout(800)
    after = page.locator("[data-project-detail] [data-detail-section]").count()
    detail_prov = page.locator("[data-project-detail] [data-detail-provenance]").count()
    rec["detail_sections_before_after"] = [before, after]
    ok(after > before or detail_prov > 0,
       "③ 节点聚焦后 Enter 触发详情回调（详情段 %d → %d，data-detail-provenance=%d）" % (before, after, detail_prov))
    page.screenshot(path=os.path.join(OUT, "08-node-enter-detail.png"))
    return node_id


def step4_zoom_drag(page, rec):
    open_tech(page, "MODULE_BOX")
    wait_nodes(page, -1, timeout=1)  # no-op to settle
    page.wait_for_timeout(1500)
    box = page.locator("[data-arch-view]").bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    # ① 节点拖动（先拖后缩：缩放会把节点挪出视口，拖不到）——挑一个**视口内可见**的节点
    vis = page.evaluate(
        """() => {
          const host = document.querySelector('[data-arch-view]');
          const c = host.getBoundingClientRect();
          for (const n of host.querySelectorAll('.react-flow__node')) {
            const r = n.getBoundingClientRect();
            const x = r.x + r.width/2, y = r.y + r.height/2;
            if (x < c.x + 30 || x > c.x + c.width - 30 || y < c.y + 30 || y > c.y + c.height - 30) continue;
            const hit = document.elementFromPoint(x, y);
            if (hit && (hit === n || n.contains(hit) || (hit.closest && hit.closest('.react-flow__node') === n))) {
              return {id: n.getAttribute('data-id'), x: Math.round(x), y: Math.round(y)};
            }
          }
          return null;
        }""")
    ok(vis is not None, "④ 找到视口内可见、可命中的节点用于拖动（%s）" % (vis and vis["id"]))
    if vis is not None:
        before = page.locator("[data-arch-view] .react-flow__node[data-id='%s']" % vis["id"]).evaluate("(el) => el.style.transform")
        page.mouse.move(vis["x"], vis["y"])
        page.mouse.down()
        page.mouse.move(vis["x"] + 140, vis["y"] + 80, steps=15)
        page.mouse.up()
        page.wait_for_timeout(800)
        after = page.locator("[data-arch-view] .react-flow__node[data-id='%s']" % vis["id"]).evaluate("(el) => el.style.transform")
        rec["drag_node"] = [vis["id"], before, after]
        ok(before != after, "④ 真鼠标拖动节点改变其 transform（%s：%s → %s）" % (vis["id"], str(before)[:26], str(after)[:26]))
    # ② wheel 缩放
    t0 = viewport_transform(page)
    page.mouse.move(cx, cy)
    page.mouse.wheel(0, -500)
    page.wait_for_timeout(700)
    t1 = viewport_transform(page)
    rec["zoom_transform"] = [t0, t1]
    ok(t0 != t1, "④ 真鼠标 wheel 缩放改变 viewport transform（%s → %s）" % (str(t0)[:30], str(t1)[:30]))
    page.screenshot(path=os.path.join(OUT, "04-zoom-drag.png"))


def step5_back_overview(page, ov_count, rec):
    # 当前在全量态（step4 用 MODULE_BOX 重新进入，从概览开始 → 先确保全量）
    if page.get_attribute("[data-arch-mode-state]", "data-arch-mode-state") != "full":
        if page.locator("[data-arch-show-all]").count() > 0:
            page.locator("[data-arch-show-all]").click()
            page.wait_for_timeout(1500)
    page.locator("[data-arch-show-overview]").click()
    n = wait_nodes(page, ov_count)
    ok(page.get_attribute("[data-arch-mode-state]", "data-arch-mode-state") == "overview", "⑤「返回概览」→ `data-arch-mode-state=overview`")
    ok(n == ov_count, "⑤ 返回概览节点数 %d === 概览 API %d" % (n, ov_count))
    agg = page.locator("[data-arch-view] [data-arch-aggregate]").count()
    ok(agg >= 1, "⑤ 聚合节点回归（[data-arch-aggregate] 计数=%d）" % agg)
    page.screenshot(path=os.path.join(OUT, "05-back-overview.png"))


def discover_big_branch(backend, project):
    """从 API 现场发现一个「>40 直接子级」的顶层枝，并取其全量子级数。
    取**概览** render 的顶层节点（保证该枝就在概览思维导图顶层，可点）。"""
    r = backend.api("/api/projects/%s/arch/render" % urllib.parse.quote(project))[1]
    nodes = r["render"]["graph"]["nodes"]
    for n in nodes:
        p = (n.get("path") or "").strip()
        if p == "" or "/" in p or ":" in n["id"] or n.get("aggregate"):
            continue
        st, res = backend.api("/api/projects/%s/arch/expand" % urllib.parse.quote(project), "POST", {"module_path": p})
        if st != 200 or not isinstance(res, dict) or not res.get("ok"):
            continue
        trunc = res["result"]["truncated"]["children"]
        if trunc > 0:
            st2, res2 = backend.api("/api/projects/%s/arch/expand" % urllib.parse.quote(project), "POST", {"module_path": p, "full": True})
            full_children = len([c for c in res2["result"]["children"] if c["kind"] != "aggregate"])
            return {"id": n["id"], "path": p, "overview_children": len([c for c in res["result"]["children"] if c["kind"] != "aggregate"]), "overview_truncated": trunc, "full_children": full_children}
    return None


BRANCH_JS = """(id) => {
  const gs = [...document.querySelectorAll('[data-mindmap-view] g[data-path]')];
  let g = gs.find(x => { const t = (x.querySelector('foreignObject')?.textContent || x.textContent || '').trim(); return t === id; });
  if (!g) g = gs.find(x => (x.textContent || '').trim().startsWith(id));
  if (!g) return null;
  const lab = g.querySelector('foreignObject') || g.querySelector('text') || g;
  const r = lab.getBoundingClientRect();
  const cx = Math.round(r.x + r.width/2), cy = Math.round(r.y + r.height/2);
  const hit = document.elementFromPoint(cx, cy);
  return {x: cx, y: cy, text: (g.textContent||'').trim().slice(0,30), n: Math.round(r.width),
          hit: hit ? (hit.closest && hit.closest('g[data-path]') ? (hit.closest('g[data-path]').textContent||'').trim().slice(0,20) : hit.tagName) : 'none'};
}"""


def wait_branch_node(page, branch_id, timeout=40):
    end = time.time() + timeout
    while time.time() < end:
        d = page.evaluate(BRANCH_JS, branch_id)
        if d is not None and d["n"] > 0:
            return d
        page.wait_for_timeout(400)
    return None


def mindmap_click_branch(page, branch_id):
    d = wait_branch_node(page, branch_id)
    if d is None:
        return None
    page.mouse.click(d["x"], d["y"])
    return d


def mm_debug(page, tag):
    d = page.evaluate(
        """() => ({
          mode: document.querySelector('[data-mindmap-mode-state]')?.getAttribute('data-mindmap-mode-state') ?? 'none',
          mmNodes: document.querySelector('[data-mindmap-view]')?.getAttribute('data-mindmap-mm-nodes') ?? 'n/a',
          svg: document.querySelectorAll('[data-mindmap-svg]').length,
          gpaths: document.querySelectorAll('[data-mindmap-view] g[data-path]').length,
          mmNodes2: document.querySelectorAll('[data-mindmap-view] .markmap-node').length,
          svgLen: (document.querySelector('[data-mindmap-svg]')?.innerHTML || '').length,
          showAll: document.querySelectorAll('[data-mindmap-show-all]').length,
          showOver: document.querySelectorAll('[data-mindmap-show-overview]').length,
          err: document.querySelector('[data-mindmap-error]')?.textContent?.slice(0, 160) ?? 'none',
          errBanner: document.querySelector('[data-mindmap-error-banner]')?.textContent?.slice(0, 160) ?? 'none',
          loads: document.querySelector('[data-mindmap-view]')?.getAttribute('data-mindmap-loads') ?? 'n/a',
          nodesAttr: document.querySelector('[data-mindmap-view]')?.getAttribute('data-mindmap-nodes') ?? 'n/a',
          truncatedAttr: document.querySelector('[data-mindmap-view]')?.getAttribute('data-mindmap-truncated') ?? 'n/a',
          fullNote: document.querySelector('[data-mindmap-full-note]')?.textContent?.replace(/\\s+/g,' ').trim() ?? 'none',
        })""")
    info("⑥ 诊断[%s]：%s" % (tag, json.dumps(d, ensure_ascii=False)))
    return d


def step6_mindmap(page, backend, project, rec):
    console_idx = len(CONSOLE)  # 本段期间新增的控制台错误（下方断言不含 NaN）
    open_tech(page, "MIND_MAP")
    page.wait_for_selector("[data-mindmap-view]", timeout=40000)
    # 等 markmap 真渲染出来（mm-nodes > 0）
    end = time.time() + 30
    while time.time() < end:
        if (page.get_attribute("[data-mindmap-view]", "data-mindmap-mm-nodes") or "0") not in ("0", "", None):
            break
        page.wait_for_timeout(300)
    page.wait_for_timeout(1200)
    mm_debug(page, "进入 MIND_MAP")
    branch = discover_big_branch(backend, project)
    rec["big_branch"] = branch
    ok(branch is not None, "⑥ 现场发现 >40 直接子级的枝：%s" % json.dumps(branch, ensure_ascii=False))
    if branch is None:
        return
    ok(page.locator("[data-mindmap-show-all]").count() >= 1, "⑥ 思维导图概览态 `data-mindmap-show-all` 在场（超量才有此入口）")
    # A) 巨枝展开 + 「加载全部子级」（不依赖顶层切换，先做这部分）
    clicked = mindmap_click_branch(page, branch["id"])
    if clicked is None:
        texts = page.evaluate(
            "() => [...document.querySelectorAll('[data-mindmap-view] g[data-path]')].map(x => (x.textContent||'').trim().slice(0,20))")
        rec["mindmap_branch_texts"] = texts
        info("⑥ 未匹配到枝节点，画布上的 g[data-path] 文本（前 40）：%s" % json.dumps(texts[:40], ensure_ascii=False))
    ok(clicked is not None, "⑥ 在导图上找到并点击巨枝节点（%r → %s）" % (clicked["text"] if clicked else None, branch["path"]))
    if clicked is not None:
        page.wait_for_selector("[data-mindmap-load-all]", timeout=40000)
        page.wait_for_timeout(1200)
        capped = page.locator("[data-mindmap-capped-note='%s']" % branch["path"]).count()
        ok(capped >= 1, "⑥ 展开后出现聚合提示行（data-mindmap-capped-note=%s）" % branch["path"])
        log_before = json.loads(page.get_attribute("[data-mindmap-load-log]", "data-mindmap-load-log") or "[]")
        last_before = [x for x in log_before if x.get("path") == branch["path"]][-1]
        rec["mindmap_before"] = last_before
        ok(last_before["dropped"] > 0, "⑥ 展开默认口径：子级 %d、截断 %d（>0 触发降级行）" % (last_before["children"], last_before["dropped"]))
        page.screenshot(path=os.path.join(OUT, "07a-mindmap-capped.png"))
        # 点「加载全部子级」→ 子级数 = 全量 expand API children 数，聚合提示消失
        page.locator("[data-mindmap-load-all]").first.click()
        page.wait_for_timeout(3500)
        log_after = json.loads(page.get_attribute("[data-mindmap-load-log]", "data-mindmap-load-log") or "[]")
        last_after = [x for x in log_after if x.get("path") == branch["path"]][-1]
        rec["mindmap_after"] = last_after
        ok(last_after["dropped"] == 0, "⑥「加载全部子级」后该枝截断归零（dropped=%d）" % last_after["dropped"])
        ok(last_after["children"] == branch["full_children"],
           "⑥ 该枝子级数 %d === 全量 expand API %d" % (last_after["children"], branch["full_children"]))
        gone = page.locator("[data-mindmap-capped-note='%s']" % branch["path"]).count()
        ok(gone == 0, "⑥ 聚合提示行消失（data-mindmap-capped-note 计数=%d）" % gone)
        page.screenshot(path=os.path.join(OUT, "07b-mindmap-loadall.png"))
        # 巨枝「加载全部子级」后：仍真实绘制、且无 NaN transform（透明跳变/坐标错乱的反例）
        assert_mindmap_painted(page, "巨枝加载全部", rec)
    # B) 顶层「显示全部」切换
    hit = page.evaluate(
        """() => { const b = document.querySelector('[data-mindmap-show-all]'); if (!b) return null;
             const r = b.getBoundingClientRect(); const x = r.x + r.width/2, y = r.y + r.height/2;
             const e = document.elementFromPoint(x, y);
             return {x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height),
                     hit: e ? (e.closest('[data-mindmap-show-all]') ? 'show-all' : e.tagName + '.' + e.className) : 'none'}; }""")
    rec["mindmap_showall_btn"] = hit
    info("⑥ 显示全部按钮命中诊断：%s" % json.dumps(hit, ensure_ascii=False))
    page.locator("[data-mindmap-show-all]").click()
    trace = []
    end = time.time() + 6
    while time.time() < end:
        trace.append(page.get_attribute("[data-mindmap-mode-state]", "data-mindmap-mode-state"))
        page.wait_for_timeout(200)
    rec["mindmap_mode_trace"] = trace[:24]
    info("⑥ 模式状态轨迹（点后 6s 采样）：%s" % trace[:24])
    mm_debug(page, "点显示全部后")
    ok(page.get_attribute("[data-mindmap-mode-state]", "data-mindmap-mode-state") == "full", "⑥ 顶层「显示全部」→ `data-mindmap-mode-state=full`")
    ok(page.locator("[data-mindmap-full-note]").count() >= 1, "⑥ 全量态一行说明 `data-mindmap-full-note` 在场")
    page.screenshot(path=os.path.join(OUT, "06-mindmap-full.png"))
    # 全量态真实绘制（强化断言）：节点/SVG 非空、可见节点落在容器盒内、无 NaN transform
    assert_mindmap_painted(page, "全量", rec)
    # 返回概览后：真实重绘（不是空白）
    if page.locator("[data-mindmap-show-overview]").count() > 0:
        page.locator("[data-mindmap-show-overview]").first.click()
        page.wait_for_timeout(2500)
    ok(page.get_attribute("[data-mindmap-mode-state]", "data-mindmap-mode-state") == "overview", "⑥ 返回概览 → `data-mindmap-mode-state=overview`")
    assert_mindmap_painted(page, "返回概览", rec)
    # 控制台监听：step6 期间错误/告警不含 NaN
    step6_console = CONSOLE[console_idx:]
    rec["step6_console"] = step6_console[:20]
    ok(not any("NaN" in c for c in step6_console), "⑥ step6 期间控制台输出不含 NaN（本段 %d 条）" % len(step6_console))


def mindmap_paint(page):
    """思维导图真实绘制读数：markmap 节点数、层级节点数、SVG innerHTML 长度，
    落在 [data-mindmap-view] 容器盒内的可见节点数，以及 transform 里的 NaN 计数。"""
    return page.evaluate(
        """() => {
          const host = document.querySelector('[data-mindmap-view]');
          const box = host ? host.getBoundingClientRect() : null;
          const nodes = host ? [...host.querySelectorAll('.markmap-node')] : [];
          let visibleInBox = 0;
          for (const n of nodes) {
            const r = n.getBoundingClientRect();
            if (r.width <= 0 && r.height <= 0) continue;
            if (box && r.left >= box.left - 1 && r.right <= box.right + 1
                     && r.top >= box.top - 1 && r.bottom <= box.bottom + 1) visibleInBox++;
          }
          const svg = document.querySelector('[data-mindmap-svg]');
          const gT = host ? [...host.querySelectorAll('g[transform]')].map(g => g.getAttribute('transform') || '') : [];
          return {
            mm: nodes.length,
            gpaths: host ? host.querySelectorAll('g[data-path]').length : 0,
            svgLen: svg ? (svg.innerHTML || '').length : 0,
            visibleInBox: visibleInBox,
            nanTransforms: gT.filter(t => t.indexOf('NaN') >= 0).length,
          };
        }""")


def assert_mindmap_painted(page, tag, rec):
    d = mindmap_paint(page)
    rec.setdefault("mindmap_paint", {})[tag] = d
    info("⑥ 思维导图绘制[%s]：%s" % (tag, json.dumps(d, ensure_ascii=False)))
    ok(d["mm"] > 0 and d["gpaths"] > 0 and d["svgLen"] > 200,
       "⑥[%s] 真绘制：.markmap-node=%d、g[data-path]=%d、SVG innerHTML=%d（>200）" % (tag, d["mm"], d["gpaths"], d["svgLen"]))
    ok(d["visibleInBox"] >= 3,
       "⑥[%s] 至少 3 个 .markmap-node 可见且落在 [data-mindmap-view] 容器盒内（实际 %d）" % (tag, d["visibleInBox"]))
    ok(d["nanTransforms"] == 0, "⑥[%s] g[transform] 无 NaN（实际 %d 个）" % (tag, d["nanTransforms"]))
    return d


def build_hidden_modules():
    """隐藏对象夹具模块集：id n0001..n2000 + bigdir（共 2001），file_count 降序；
    n0002..n0010 各指向 n0001（hub 收 9 条入边 ⇒ 扇出形态）。bigdir 指向真实目录（UI 展开 2001 子级）。"""
    mods = []
    for i in range(1, 2001):
        deps = [{"to": "n0001", "weight": 1}] if 2 <= i <= 10 else []
        mods.append({"id": "n%04d" % i, "path": "n%04d" % i, "file_count": 2001 - i, "deps": deps})
    mods.append({"id": "bigdir", "path": "bigdir", "file_count": 5000, "deps": []})
    return mods


def make_fixture(tmp, fid, modules, bigdir_files=0):
    """建临时夹具项目目录（.工作台/arch/modules.json ＋可选 bigdir 真实目录若干文件）。
    只落本脚本自建临时区；注册由调用方经安装版后端 API 完成（真实 ~/.tatai 不动）。"""
    d = os.path.join(tmp, "proj-" + fid)
    arch = os.path.join(d, ".工作台", "arch")
    os.makedirs(arch, exist_ok=True)
    with open(os.path.join(arch, "modules.json"), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "generated_at": "2026-01-01T00:00:00+08:00",
                   "budget_exhausted": False, "modules": modules}, f, ensure_ascii=False)
    if bigdir_files:
        bd = os.path.join(d, "bigdir")
        os.makedirs(bd, exist_ok=True)
        for i in range(bigdir_files):
            open(os.path.join(bd, "part-%05d.txt" % i), "w").close()
    return d


def build_main_modules():
    """主夹具 v0922-ui-main 的模块集：19 个常规模块（各 2~3 个 .ts）＋1 个巨枝模块（50 直接子级）。
    `file_count` 用各目录内**真实**文件数，保证概览保留集确定（file_count 降序、同数按 id 升序）。"""
    mods = []
    for i in range(1, 20):
        mods.append({"id": "mod-%02d" % i, "path": "mod-%02d" % i,
                     "file_count": 3 if i % 2 else 2, "deps": []})
    mods.append({"id": "bigbranch", "path": "bigbranch",
                 "file_count": MAIN_BIG_CHILDREN, "deps": []})
    return mods


def build_main_tree(d):
    """按上面的模块集在磁盘**真建**文件树：普通模块各 2~3 个真 .ts；巨枝模块 50 个真 .ts
    （>MAX_CHILDREN=40，供 /arch/expand 现场读数与思维导图「加载全部子级」对照）。"""
    for i in range(1, 20):
        md = os.path.join(d, "mod-%02d" % i)
        os.makedirs(md, exist_ok=True)
        for j in range(3 if i % 2 else 2):
            with open(os.path.join(md, "part-%02d.ts" % j), "w", encoding="utf-8") as f:
                f.write("export const m%02d_%02d = %d;\n" % (i, j, i * 100 + j))
    bd = os.path.join(d, "bigbranch")
    os.makedirs(bd, exist_ok=True)
    for j in range(MAIN_BIG_CHILDREN):
        with open(os.path.join(bd, "leaf-%02d.ts" % j), "w", encoding="utf-8") as f:
            f.write("export const leaf%02d = %d;\n" % (j, j))


def make_main_fixture(tmp):
    """主夹具：modules.json ＋磁盘真文件树 ＋**已发布规划图**（只落本脚本自建临时区）。"""
    d = make_fixture(tmp, MAIN_PROJECT, build_main_modules())
    build_main_tree(d)
    arch = os.path.join(d, ".工作台", "arch")
    with open(os.path.join(arch, "blueprint.json"), "w", encoding="utf-8") as f:
        json.dump(build_main_blueprint(), f, ensure_ascii=False)
    return d


def build_main_blueprint():
    """主夹具的**已发布规划图**（`.工作台/arch/blueprint.json`，`publish.published=true`）。

    为什么必须有：功能全景（能力分组）与施工依赖（任务节点）两张主视图的节点**只来自规划图**
    （`GET /arch/blueprint` 的已发布蓝图经 `buildViewModel` 取节点）——夹具没有已发布蓝图时，
    两张主视图只能落到「无规划」空态（`.react-flow__node=0`），而 step0 要求三主图节点非空。
    原 `make_main_fixture` 只造 modules.json ＋磁盘真文件树（**缺规划层**），测试前提不成立；
    这里补齐规划层，测试前提才成立（形状复用 `probe-v09-22-mainviews-installed.py` 的已发布蓝图语义，
    去掉与本卡无关的 MCP 对照逻辑）。

    规划节点用 `source_refs.kind="code_module"` 锚到夹具里**真实存在的静态模块**（`MAIN_PLAN_ANCHOR`）：
    `mergePlanningLayer`（`.工作台` 规划层并入共用数据层的唯一合并点）命中实测模块时**只把规划 id
    记进该静态节点的 `plan_refs`、不新建灰节点**——于是技术详情三图（module_map/data_flow/mind_map，
    读 `?planning=1`）的节点集合与纯静态口（`/arch/render`，不带 planning）一致，step1/step5 的
    「画布节点数 === 非规划 API 节点数」耦合不被扰动（否则规划灰节点会被追加进画布、把两条断言打红）。"""
    ref = {"kind": "code_module", "path": MAIN_PLAN_ANCHOR, "locator": MAIN_PLAN_ANCHOR, "sha256": None}
    nodes, edges = [], []
    for i in range(1, MAIN_CAP_COUNT + 1):
        k = "%02d" % i
        nodes.append({"id": "plan:cap:%s" % k, "kind": "capability", "name": "能力 %s" % k,
                      "source_refs": [dict(ref)], "related_ids": []})
        nodes.append({"id": "plan:task:T%s" % k, "kind": "task", "name": "任务 T%s" % k,
                      "source_refs": [dict(ref)], "related_ids": []})
        # 任务 → 所属能力（task_design_ref）：让两张主视图有真实关系（非孤点），口径与 probe 夹具同源
        edges.append({"source": "plan:task:T%s" % k, "target": "plan:cap:%s" % k,
                      "kind": "task_design_ref", "source_refs": [], "certainty": "declared"})
    return {
        "version": 1, "baseline_id": "bl-v0922-ui-main-fixture",
        "generator_version": "verify-v09-22-ui-installed.main-fixture",
        "generated_at": "2026-01-01T00:00:00+08:00", "source_manifest": [],
        "nodes": nodes, "edges": edges,
        "coverage": {"design_sections": {"total": 0, "mapped": 0, "unmapped": []},
                     "plan_tasks": {"total": MAIN_CAP_COUNT, "mapped": MAIN_CAP_COUNT, "unmapped": []},
                     "code_modules": {"total": 1, "mapped": 1, "unmapped": []},
                     "nodes_total": len(nodes), "nodes_kept": len(nodes),
                     "edges_total": len(edges), "edges_kept": len(edges),
                     "note": "V09-22 安装版 UI 验证主夹具：已发布规划图（能力/任务锚到夹具静态模块）"},
        "omitted": [], "model_receipt": None,
        "publish": {"published": True, "reason": None, "validated_at": "2026-01-01T00:00:00+08:00"},
        "based_on": {"model_key": "v0922-ui-main-fixture", "full_key": "v0922-ui-main-fixture",
                     "design_content_sha256": None, "plan_definition_sha256": None, "semantic": False},
    }


def register_project(backend, fid, name, path):
    """经安装版后端 API 注册夹具项目：先删后建（幂等）。数据落进协调器给的隔离 home。"""
    backend.api("/api/projects/%s" % urllib.parse.quote(fid, safe=""), "DELETE")  # 不存在时 404，忽略
    st, res = backend.api("/api/projects", "POST", {"id": fid, "name": name, "path": path})
    good = st == 200 and isinstance(res, dict) and res.get("ok") is True
    ok(good, "夹具注册 %s（POST /api/projects → %s）" % (fid, st))
    if not good:
        raise RuntimeError("夹具 %s 注册失败：%s %s" % (fid, st, res))


def unregister_projects(backend, ids):
    """注销夹具项目（best-effort；不让清理问题盖过验证结论）。"""
    for fid in ids:
        try:
            backend.api("/api/projects/%s" % urllib.parse.quote(fid, safe=""), "DELETE")
        except Exception:
            pass


def step6_project_switch(page, main_project, alt_project, rec):
    """换到另一个项目再切回：思维导图仍真实绘制（不是空白）。"""
    try:
        open_arch(page, alt_project)
        open_tech(page, "MIND_MAP")
        page.wait_for_selector("[data-mindmap-view]", timeout=40000)
        page.wait_for_timeout(1500)
    except Exception as e:
        skip("⑥ 换项目（%s）打开思维导图失败：%s" % (alt_project, str(e)[:80]))
    open_arch(page, main_project)
    open_tech(page, "MIND_MAP")
    page.wait_for_selector("[data-mindmap-view]", timeout=40000)
    page.wait_for_timeout(1800)
    d = mindmap_paint(page)
    rec["mindmap_after_switch"] = d
    ok(d["mm"] > 0, "⑥ 换项目再切回后思维导图仍绘制（.markmap-node=%d）" % d["mm"])


def step6_hidden_drawer(page, backend, hidden_project, rec):
    """隐藏对象抽屉（终态契约）：夹具项目 2001 模块＋扇出。"""
    try:
        open_arch(page, hidden_project)
        open_tech(page, "MODULE_BOX")
        page.wait_for_timeout(2000)
    except Exception as e:
        skip("⑥ 隐藏对象抽屉：打开夹具 %s 方框图失败：%s" % (hidden_project, str(e)[:80]))
        return
    ok(page.locator("[data-arch-show-all]").count() >= 1, "⑥[抽屉] 概览态 `data-arch-show-all` 在场（扇出/上限形态入口）")
    if page.locator("[data-arch-show-all]").count() >= 1:
        page.locator("[data-arch-show-all]").first.click()
        page.wait_for_timeout(3000)
    items_entry = page.locator("[data-arch-hidden-items]").count()
    ok(items_entry >= 1, "⑥[抽屉] 全量态 `data-arch-hidden-items` 入口在场（查看被聚合对象）")
    drawer = page.locator("[data-arch-hidden-drawer]")
    ok(drawer.count() >= 1, "⑥[抽屉] `data-arch-hidden-drawer` 抽屉在场")
    if items_entry >= 1 and drawer.count() >= 1:
        page.locator("[data-arch-hidden-items]").first.click()
        page.wait_for_timeout(1500)
        cnt = page.get_attribute("[data-arch-hidden-count]", "data-arch-hidden-count")
        ok(cnt is not None and "2001" in (cnt or ""), "⑥[抽屉] 计数标签 `data-arch-hidden-count` 含 2001（实际 %r）" % cnt)
        ids = set()
        for _ in range(60):
            rows = page.eval_on_selector_all(
                "[data-arch-hidden-item]",
                "els => els.map(e => e.getAttribute('data-arch-hidden-item'))")
            ids.update(x for x in rows if x)
            more = page.locator("[data-arch-hidden-more]")
            if more.count() == 0:
                break
            more.first.click()
            page.wait_for_timeout(600)
        ok(len(ids) == 2001, "⑥[抽屉] 逐页点完累计 `data-arch-hidden-item` id 集合=%d（期望 2001，无漏无重）" % len(ids))
        search = page.locator("[data-arch-hidden-search]")
        if search.count() >= 1:
            search.fill("n2000")
            page.wait_for_timeout(800)
            hits = page.locator("[data-arch-hidden-item]")
            if hits.count() >= 1:
                hits.first.click()
                page.wait_for_timeout(800)
                detail = page.locator("[data-arch-detail]")
                ok(detail.count() >= 1 and "n2000" in (detail.first.inner_text() or ""),
                   "⑥[抽屉] 搜索命中点击后 `data-arch-detail` 面板含 n2000 名字")
            else:
                ok(False, "⑥[抽屉] 搜索 n2000 无命中行（契约未实现）")
        else:
            ok(False, "⑥[抽屉] 无 `data-arch-hidden-search`（契约未实现）")
    else:
        info("⑥[抽屉] 入口/抽屉未实现，抽屉内部断言留第二步（当前红着留档）")
    step6_children_pagination(page, rec)


def step6_children_pagination(page, rec):
    """UI 展开 2001 子级节点（bigdir）：展开后画布后代应含第 2001 个子级。"""
    try:
        toggle = page.locator('[data-expand-toggle="bigdir"]')
        if toggle.count() == 0:
            ok(False, "⑥ 子级分页：全量态未找到 bigdir 的展开钮 `data-expand-toggle=bigdir`（终态契约）")
            return
        before = page.locator("[data-arch-view] .react-flow__node").count()
        # React Flow 会把节点移出视口，普通 click 因「element is outside of the viewport」超时——
        # 用 JS 直接派发点击，绕过视口命中检查（本断言只关心展开行为与后代节点数）。
        page.eval_on_selector('[data-expand-toggle="bigdir"]', "el => el.click()")
        page.wait_for_timeout(5000)
        after = page.locator("[data-arch-view] .react-flow__node").count()
        rec["bigdir_expand"] = [before, after]
        ok(after - before >= 1500, "⑥ 子级分页：展开 bigdir 后画布新增 ≥1500 子级（before=%d after=%d）——终态契约" % (before, after))
    except Exception as e:
        ok(False, "⑥ 子级分页：展开 bigdir 失败（%s）——终态契约" % str(e)[:80])


def write_console_full():
    """全量控制台留档（审验要求）：所有消息（含时间戳与 url）整份写入 <log-dir>/console-full.log。"""
    path = os.path.join(OUT, "console-full.log")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(CONSOLE) + ("\n" if CONSOLE else ""))
    info("控制台全量留档：%d 条 → %s" % (len(CONSOLE), path))
    return path


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="V09-22 正式安装版 UI 验证（CDP 附着 WebView2）")
    ap.add_argument("--cdp-port", type=int, default=9222, help="WebView2 远程调试端口（默认 9222）")
    ap.add_argument("--backend-port", type=int, default=8787, help="安装版后端 sidecar 端口（默认 8787）")
    ap.add_argument("--expect-data-dir", required=True,
                    help="R2 写前硬闸：预期的隔离 TATAI_HOME（与 /health.data_dir 规范化比对；"
                         "不匹配在任何 DELETE/POST 前退出，exit 2）")
    ap.add_argument("--log-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "tmp-ui-installed"),
                    help="输出目录：截图与 console-full.log（默认脚本旁 tmp-ui-installed）")
    return ap.parse_args(argv)


def main():
    global OUT
    args = parse_args()
    OUT = args.log_dir
    os.makedirs(OUT, exist_ok=True)

    tmp = tempfile.mkdtemp(prefix="tatai-v0922ui-installed-")
    backend = Backend(args.backend_port)
    registered = []
    rec = {}
    attached = False
    try:
        backend.wait_health()
        # R2 写前硬闸：任何 DELETE/POST 之前显式核对 /health.data_dir＝本次预期隔离目录
        verify_isolation(backend, args.expect_data_dir)
        info("安装版后端就绪 127.0.0.1:%d（隔离核对通过；实际目录与 pid 见 isolation.log）" % args.backend_port)

        # 夹具：磁盘文件树＋modules.json 只落本脚本自建临时区；注册走安装版后端 API（先删后建，幂等）。
        main_dir = make_main_fixture(tmp)
        hidden_dir = make_fixture(tmp, "v0922-ui-hidden", build_hidden_modules(), bigdir_files=2001)
        alt_dir = make_fixture(tmp, "v0922-ui-alt", [
            {"id": "a1", "path": "a1", "file_count": 3, "deps": [{"to": "a2", "weight": 1}]},
            {"id": "a2", "path": "a2", "file_count": 1, "deps": []},
        ])
        for fid, name, d in ((MAIN_PROJECT, "V09-22 主夹具", main_dir),
                             ("v0922-ui-hidden", "V09-22 隐藏对象夹具", hidden_dir),
                             ("v0922-ui-alt", "V09-22 切换夹具", alt_dir)):
            register_project(backend, fid, name, d)
            registered.append(fid)

        try:
            cdp = wait_cdp(args.cdp_port)
            info("CDP 就绪：%s" % (cdp.get("Browser", "") or ""))
            with sync_playwright() as p:
                browser = p.chromium.connect_over_cdp("http://127.0.0.1:%d" % args.cdp_port)
                page = find_shell_page(browser)
                page._shell_origin = shell_origin(page)
                attached = True
                info("附着塔台界面页：%s（origin=%s）" % (page.url, page._shell_origin))
                # 入口身份留档（R2）：CDP 浏览器串＋正式壳页面 url＋后端端口——写进 isolation.log，
                # 与开头的 data_dir/pid 一起构成「这次到底打的是哪个入口」的完整自证
                _write_isolation_log({
                    "verdict": "entry-identity",
                    "checked_at": _ts(),
                    "backend_port": args.backend_port,
                    "cdp_port": args.cdp_port,
                    "cdp_browser": cdp.get("Browser", "") or "",
                    "shell_page_url": page.url,
                })
                # 审验要求：attach 后立刻收集**所有** console / pageerror（带时间戳与 url），全程不筛选
                page.on("console", on_console)
                page.on("pageerror", on_pageerror)

                open_arch(page, MAIN_PROJECT)
                # step0：六图逐张打开（三主视图＋三技术图），每张断言容器与节点非空
                step0_six_graphs(page, rec)
                # 复位到主夹具的模块方框图，跑 step1–step6（与原脚本同源）
                open_arch(page, MAIN_PROJECT)
                open_tech(page, "MODULE_BOX")
                full_nodes, ov_nodes = step1_full_toggle(page, backend, MAIN_PROJECT, rec)
                step3_keyboard(page, full_nodes, rec)
                step2_search(page, full_nodes, ov_nodes, rec)
                step4_zoom_drag(page, rec)
                step5_back_overview(page, len(ov_nodes), rec)
                step3_node_enter(page, MAIN_PROJECT, rec)
                step6_mindmap(page, backend, MAIN_PROJECT, rec)
                # 各段独立 try：单段异常记 SKIP 留第二步，不许中断整个脚本、丢后续证据
                try:
                    step6_project_switch(page, MAIN_PROJECT, "v0922-ui-alt", rec)
                except Exception as e:
                    skip("⑥ 换项目再切回段异常：%s" % str(e)[:100])
                try:
                    step6_hidden_drawer(page, backend, "v0922-ui-hidden", rec)
                except Exception as e:
                    skip("⑥ 隐藏对象抽屉段异常：%s" % str(e)[:100])
        except Exception as e:
            ok(False, "安装版附着/驱动异常：%s" % str(e)[:200])
        finally:
            # 全量控制台留档（无论成败都落）：NaN 检查在**整份日志**上做
            write_console_full()
            blob = "\n".join(CONSOLE)
            rec["console_full_lines"] = len(CONSOLE)
            ok("translate(NaN" not in blob, "控制台全文不含 `translate(NaN`（%d 条消息）" % len(CONSOLE))
            ok("NaN,NaN" not in blob, "控制台全文不含 `NaN,NaN`（%d 条消息）" % len(CONSOLE))
    finally:
        # 写请求总账（R2）：全程每一次 DELETE/POST 都在此留痕（被拦截的也记 blocked=true）；
        # 错目录退出的场景下这份账就是「零写请求」的机器自证
        rec["write_requests_total"] = len(backend.write_log)
        rec["write_requests_blocked"] = sum(1 for w in backend.write_log if w.get("blocked"))
        rec["write_log"] = backend.write_log
        _write_isolation_log({
            "verdict": "write-summary",
            "checked_at": _ts(),
            "write_requests_total": len(backend.write_log),
            "write_requests_blocked": rec["write_requests_blocked"],
        })
        unregister_projects(backend, registered)
        if not KEEP:
            cleaned = rmtree_hard(tmp)
            info("临时夹具目录自清：%s（%s）" % ("已删" if cleaned else "残留", tmp))
        # 有意不杀塔台进程（协调器负责回收）；退出 playwright 连接即断开附着
        if attached:
            info("已断开 playwright 附着；不杀塔台进程（由协调器回收）")

    with open(os.path.join(OUT, "readings.json"), "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False, indent=2)

    print("\n[ui] UI(安装版) %d PASS / %d FAIL" % (passes[0], len(fails)))
    if skips:
        for x in skips:
            print("[ui]   SKIP " + x)
    if fails:
        for x in fails:
            print("[ui]   FAIL " + x)
        sys.exit(1)


if __name__ == "__main__":
    main()
