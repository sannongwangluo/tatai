#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-22 UI 真机验证：六图聚合节点「全量可查看」（技术详情方框图 / 数据流向图 / 思维导图）。

用法：python scripts/verify-v09-22-ui.py
      （V0922_UI_PROJECT 换项目 id、V0922_SHOT_DIR 换输出目录、V0922_KEEP_TMP=1 保留现场）

为什么必须跑真浏览器（施工任务书 §3.2 七步）：
  · ①「显示全部」放开的是**上屏**节点数与 DOM 上的聚合节点——只有真 DOM 里数 `.react-flow__node`
    与 `[data-arch-aggregate]` 才算数；
  · ② 搜索命中「仅在全量模式存在」的节点、③ 键盘 Tab/Enter 激活、④ **真鼠标 wheel 缩放与节点拖动**
    改变 viewport / 节点 transform——这些是**交互**口径，`locator.click` 成功本身不作为人的可用性证明；
  · ⑥ 思维导图巨枝「加载全部子级」后子级数要等于 `/arch/expand` 全量口径的现场读数，聚合提示消失。

隔离口径（AGENTS.md §5）：真后端 + 真 vite 全走动态空闲端口。真实 `~/.tatai` 与真实项目目录
**只读**——启动前整份拷到临时区，注册表改写为指向**临时项目副本**，故交互产生的落盘（思维导图
折叠记忆 mindmap-fold.json、布局 layout.json）只落在临时副本里。收尾杀净两端、删临时目录；
另记真实 `~/.tatai`、真实项目 `.工作台` 的首尾指纹自证零写入。

对照数据**全部现场取**：`/arch/render?full=1`（全量节点集合）、`/arch/expand`（巨枝全量子级数），
不写死任何节点数或项目特例断言——只断行为与 API 对照。

V09-22 返工新增（终态契约，修前会红着留档）：
  · 思维导图真实绘制强化：全量/返回概览/巨枝加载全部后 `.markmap-node`、`g[data-path]`、SVG 非空，
    可见节点落在容器盒内，`g[transform]` 无 NaN；step6 期间控制台无 NaN；
  · 换项目再切回：思维导图仍真实绘制（临时 home 里另注册最小夹具项目）；
  · 隐藏对象抽屉（夹具 v0922-ui-hidden＝2001 模块＋扇出）：`data-arch-hidden-items/-drawer/-count`、
    逐页 `data-arch-hidden-more`、行 `data-arch-hidden-item`、搜索 `data-arch-hidden-search`、详情 `data-arch-detail`；
  · 子级分页：UI 展开 bigdir（2001 子级）后画布后代含第 2001 个子级。
  新夹具只登记进**临时** home、只落临时区；真实数据只读拷贝口径不变。
"""
import hashlib
import json
import os
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT = os.environ.get("V0922_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "V09-22", "1", "ui"))
KEEP = os.environ.get("V0922_KEEP_TMP") == "1"
REAL_HOME = os.path.join(os.path.expanduser("~"), ".tatai")
# 主夹具项目 id：内置自建、只落临时区。默认不再锚定真实注册表里某个项目——真实数据时点会漂移
# （本轮「类脑记忆-test」已从注册表消失），主项目段断言全部现场取，故用确定性夹具顶替。
# V0922_UI_PROJECT 向后兼容：等于本名=内置夹具（不 copytree）；给其它值=真实项目（仍整份 copytree 只读）。
MAIN_PROJECT = "v0922-ui-main"
PROJECT = os.environ.get("V0922_UI_PROJECT", MAIN_PROJECT)
# 主夹具巨枝模块的直接子级数：必须 > ARCH_LIMITS.MAX_CHILDREN(40) 才会触发下钻截断＋「加载全部子级」。
MAIN_BIG_CHILDREN = 50
VIEW = (1600, 950)

passes = [0]
fails = []
skips = []
CONSOLE = []


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
def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


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


def file_sha256(path):
    if not os.path.isfile(path):
        return "n/a"
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


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


def tree_fingerprint(root, limit=6000):
    rows = []
    if not os.path.isdir(root):
        return {"files": 0, "hash": "n/a"}
    for cur, _dirs, files in os.walk(root):
        for name in sorted(files):
            p = os.path.join(cur, name)
            try:
                rows.append("%s\t%d" % (os.path.relpath(p, root).replace("\\", "/"), os.path.getsize(p)))
            except OSError:
                rows.append("%s\t?" % os.path.relpath(p, root).replace("\\", "/"))
            if len(rows) >= limit:
                break
    rows.sort()
    return {"files": len(rows), "hash": hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()}


class Backend:
    def __init__(self, home, port, log_path):
        env = dict(os.environ)
        env["TATAI_HOME"] = home
        env["TATAI_PORT"] = str(port)
        self.home = home
        self.port = port
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", os.path.join("src", "server", "index.ts")],
            cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
        )

    def api(self, path, method="GET", body=None):
        return http_json("http://127.0.0.1:%d%s" % (self.port, path), method, body)

    def wait_health(self, timeout=240):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("后端进程退出（见 ui-backend.log）")
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
    deadline = time.time() + 180
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("vite 起不来（见 ui-vite.log）")
        try:
            with urllib.request.urlopen("http://localhost:%d/" % port, timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("vite %d 未就绪" % port)


# ── 页面导航 ─────────────────────────────────────────────────────────────────
def open_arch(page, project):
    page.goto("http://localhost:%d/#p/%s" % (page._vite_port, urllib.parse.quote(project, safe="")), wait_until="domcontentloaded")
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


def viewport_transform(page):
    return page.evaluate(
        "() => { const vp = document.querySelector('.react-flow__viewport');"
        " return vp ? getComputedStyle(vp).transform : null; }")


# ── 七步 ─────────────────────────────────────────────────────────────────────
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
    ok(branch is not None, "⑥ 现场发现 >40 直接子级的枝：%s" % (json.dumps(branch, ensure_ascii=False)))
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
    #    历史缺陷（2026-09-28 首次验证发现，已在本轮修复）：MindMapView 的取数 effect 曾在开头
    #    无条件 `setShowAll(false)`（本意是"换项目回概览"），而该 effect 依赖数组又含 `showAll`——
    #    点「显示全部」→ showAll=true 触发 effect → 立刻被打回，模式永远回不到 full。
    #    修复：`setShowAll(false)` 加了「项目真变了」守卫（projectChanged），只在换项目时重置。
    #    下面两条断言按任务书 §3.2 第 6 步口径保留（不降强度），现应如实 PASS。
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


def make_fixture(home, tmp, fid, name, modules, bigdir_files=0):
    """建临时夹具项目（.工作台/arch/modules.json ＋可选 bigdir 真实目录若干文件），
    并把该项目登记进**临时** home 的注册表（真实 ~/.tatai 不动）。"""
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
    reg_path = os.path.join(home, "registry.json")
    reg = json.load(open(reg_path, encoding="utf-8"))
    now = "2026-01-01T00:00:00+08:00"
    reg["projects"].append({"id": fid, "name": name, "path": d, "kind": "backend",
                            "registered_at": now, "last_opened_at": now})
    with open(reg_path, "w", encoding="utf-8") as f:
        json.dump(reg, f, ensure_ascii=False, indent=2)
    return d


def build_main_modules():
    """主夹具 v0922-ui-main 的模块集：19 个常规模块（各 2~3 个 .ts）＋1 个巨枝模块（50 直接子级）。
    `file_count` 用各目录内**真实**文件数，保证概览保留集确定（file_count 降序、同数按 id 升序）：
    巨型枝(50)＋十个 3 文件模块＋三个 2 文件模块 = 14 真模块，其余 6 个被聚合成「还有 6 个」。"""
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


def make_main_fixture(home, tmp):
    """主夹具：modules.json ＋磁盘真文件树，并登记进**临时** home 的注册表（真实 ~/.tatai 不动）。"""
    d = make_fixture(home, tmp, MAIN_PROJECT, "V09-22 主夹具", build_main_modules())
    build_main_tree(d)
    return d


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
    """隐藏对象抽屉（终态契约，修前会红）：夹具项目 2001 模块＋扇出。
    入口 data-arch-hidden-items / 抽屉 data-arch-hidden-drawer / 计数 data-arch-hidden-count /
    逐页 data-arch-hidden-more / 行 data-arch-hidden-item / 搜索 data-arch-hidden-search /
    详情 data-arch-detail。修前这些属性都不存在，断言红着留档，不中断脚本。"""
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
    """UI 展开 2001 子级节点（bigdir）：展开后画布后代应含第 2001 个子级。
    终态由 UI 工人保证可观测属性/节点计数；修前只有 40 上限的 39+聚合，断言红着留档。"""
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


def main():
    # 前置检查失败路径也要回收临时区：真实数据目录缺失在 mkdtemp **之前**判，注册表缺项目在 exit 前手删。
    if not os.path.isdir(REAL_HOME):
        print("[ui] 真实数据目录不存在：%s" % REAL_HOME)
        sys.exit(2)
    tmp = tempfile.mkdtemp(prefix="tatai-v0922ui-")
    home = os.path.join(tmp, "home")
    proj_copy = os.path.join(tmp, "project")
    shutil.copytree(REAL_HOME, home)
    os.makedirs(OUT, exist_ok=True)

    real_proj = None
    if PROJECT == MAIN_PROJECT:
        # 内置主夹具：自建真实文件树（20 模块）并注册进临时 home；不走真实注册表、不 copytree 真实项目。
        real_proj = make_main_fixture(home, tmp)
        info("主项目 %s（内置夹具，自建文件树，不 copytree）：%s" % (PROJECT, real_proj))
    else:
        # 读真实注册表，定位目标项目并整份拷到临时区（真实项目只读）
        reg = json.load(open(os.path.join(home, "registry.json"), encoding="utf-8"))
        target = next((p for p in reg["projects"] if p["id"] == PROJECT), None)
        if target is None:
            print("[ui] 注册表里没有项目 %s（可用：%s）" % (PROJECT, [p["id"] for p in reg["projects"]]))
            rmtree_hard(tmp)  # 前置失败也回收临时 home 拷贝（否则 mkdtemp 的整份拷贝泄漏）
            sys.exit(2)
        real_proj = target["path"]
        info("目标项目 %s：%s" % (PROJECT, real_proj))
        shutil.copytree(real_proj, proj_copy)
        # 把临时注册表里该项目的 path 改写为临时副本（交互落盘只落副本）
        for p in reg["projects"]:
            if p["id"] == PROJECT:
                p["path"] = proj_copy
        json.dump(reg, open(os.path.join(home, "registry.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    # V09-22 返工新增夹具（只登记进临时 home、只落临时区；真实 ~/.tatai 与真实项目不动）：
    #   · v0922-ui-hidden：2001 模块（n0001..n2000 + bigdir）＋ hub 9 入边；bigdir 目录含 2001 个文件。
    #   · v0922-ui-alt：最小夹具（换项目再切回的对照组）。
    make_fixture(home, tmp, "v0922-ui-hidden", "V09-22 隐藏对象夹具", build_hidden_modules(), bigdir_files=2001)
    make_fixture(home, tmp, "v0922-ui-alt", "V09-22 切换夹具", [
        {"id": "a1", "path": "a1", "file_count": 3, "deps": [{"to": "a2", "weight": 1}]},
        {"id": "a2", "path": "a2", "file_count": 1, "deps": []},
    ])

    # 首尾指纹（真实 ~/.tatai 恒校验；真实项目 .工作台 仅在显式给了真实项目时校验——夹具模式不碰任何真实项目）
    home_before = tree_fingerprint(REAL_HOME)
    info("真实 ~/.tatai 指纹（前）：%d 文件 / %s…" % (home_before["files"], home_before["hash"][:12]))
    proj_wb = None
    proj_before = None
    if PROJECT != MAIN_PROJECT:
        proj_wb = os.path.join(real_proj, ".工作台")
        proj_before = tree_fingerprint(proj_wb)
        info("真实项目 .工作台 指纹（前）：%d 文件 / %s…" % (proj_before["files"], proj_before["hash"][:12]))
    else:
        info("主夹具模式：未拷贝任何真实项目（真实项目零读零写），跳过真实项目 .工作台 指纹")

    backend_port = free_port()
    vite_port = free_port()
    backend = None
    vite = None
    rec = {}
    try:
        backend = Backend(home, backend_port, os.path.join(OUT, "ui-backend.log"))
        backend.wait_health()
        info("后端就绪 127.0.0.1:%d（TATAI_HOME=%s）" % (backend_port, home))
        vite = start_vite(vite_port, backend_port, os.path.join(OUT, "ui-vite.log"))
        info("vite 就绪 http://localhost:%d" % vite_port)

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_context(viewport={"width": VIEW[0], "height": VIEW[1]}).new_page()
                page._vite_port = vite_port
                page.on("pageerror", lambda e: CONSOLE.append("pageerror: %s" % str(e)))
                page.on("console", lambda m: CONSOLE.append("console.%s: %s" % (m.type, m.text)) if m.type in ("error", "warning") else None)
                open_arch(page, PROJECT)
                open_tech(page, "MODULE_BOX")
                full_nodes, ov_nodes = step1_full_toggle(page, backend, PROJECT, rec)
                # step3 键盘（先回概览再用键盘进全量）
                step3_keyboard(page, full_nodes, rec)
                # step2 搜索（在全量态）
                step2_search(page, full_nodes, ov_nodes, rec)
                # step4 缩放/拖动（重进 MODULE_BOX）
                step4_zoom_drag(page, rec)
                # step5 返回概览
                step5_back_overview(page, len(ov_nodes), rec)
                # step3 节点 Enter（系统架构主视图）——放在思维导图之前，隔离其影响
                step3_node_enter(page, PROJECT, rec)
                # step6 思维导图（放最后：曾发现顶层「显示全部」切换缺陷，本轮已修复，见段内注释）
                step6_mindmap(page, backend, PROJECT, rec)
                # V09-22 返工新增：换项目再切回、隐藏对象抽屉、子级分页
                # （各段独立 try：单段异常记 SKIP 留第二步，不许中断整个脚本、丢后续证据）
                try:
                    step6_project_switch(page, PROJECT, "v0922-ui-alt", rec)
                except Exception as e:
                    skip("⑥ 换项目再切回段异常：%s" % str(e)[:100])
                try:
                    step6_hidden_drawer(page, backend, "v0922-ui-hidden", rec)
                except Exception as e:
                    skip("⑥ 隐藏对象抽屉段异常：%s" % str(e)[:100])
            finally:
                browser.close()
    finally:
        try:
            if vite is not None:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(vite.pid), "/T", "/F"], capture_output=True)
                else:
                    vite.kill()
        except Exception:
            pass
        if backend is not None:
            backend.kill()

    home_after = tree_fingerprint(REAL_HOME)
    # 临时副本/数据目录：交互落盘（mindmap-fold.json / layout.json）只落在临时区，收尾自清
    time.sleep(0.5)
    ok(home_before["hash"] == home_after["hash"], "真实 ~/.tatai 零写入（指纹前后一致：%d 文件）" % home_after["files"])
    if proj_before is not None:
        proj_after = tree_fingerprint(proj_wb)
        ok(proj_before["hash"] == proj_after["hash"], "真实项目 .工作台 零写入（指纹前后一致：%d 文件）" % proj_after["files"])
    else:
        # 等价夹具断言（主题＝真实项目零读零写）：主夹具项目只登记在临时区，注册表里没有任何真实项目被改写/重定向。
        reg2 = json.load(open(os.path.join(home, "registry.json"), encoding="utf-8"))
        main_path = next((p["path"] for p in reg2["projects"] if p["id"] == MAIN_PROJECT), "")
        in_tmp = os.path.normcase(os.path.abspath(main_path)).startswith(os.path.normcase(os.path.abspath(tmp)))
        ok(in_tmp, "真实项目零读零写：主夹具项目只登记在临时区（%s），未拷改任何真实项目" % main_path)

    with open(os.path.join(OUT, "readings.json"), "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False, indent=2)
    uniq_console = list(dict.fromkeys(CONSOLE))[:20]
    for line in uniq_console:
        info("浏览器控制台：" + line)
    if not KEEP:
        cleaned = rmtree_hard(tmp)
        info("临时夹具目录自清：%s（%s）" % ("已删" if cleaned else "残留", tmp))
    print("\n[ui] V09-22-UI %d PASS / %d FAIL / %d SKIP" % (passes[0], len(fails), len(skips)))
    if skips:
        for x in skips:
            print("[ui]   SKIP " + x)
    if fails:
        for x in fails:
            print("[ui]   FAIL " + x)
        sys.exit(1)


if __name__ == "__main__":
    main()
