#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""思维导图几何护栏的定向真机验证（PLAN V09-61：translate(NaN,NaN) 修复）。

为什么必须跑真浏览器：症状是**浏览器控制台**里 markmap 主 `<g transform>` 被写成
`translate(NaN,NaN)`（`<g> attribute transform: Expected number`），只有真 DOM 属性与真
控制台读数才算数；helper 单测镜像不算。

隔离口径（AGENTS.md §5）：真后端 + 真 vite 全走动态空闲端口；`TATAI_HOME` 指临时目录，
夹具项目自建在临时区，真实 `~/.tatai` 与真实项目**零读零写**（首尾指纹自证）。收尾杀净两端、
删临时目录。

复现/回归的关键条件（`mindmapGeometry.ts` 根因注释）：容器隐藏（0×0）时，若**可见树布局盒退化**
（单模块/链状 → 某轴跨度为 0），markmap 的 `fit()` 算出 `0/0` → NaN。因此夹具含**单模块**项目
（可见树 = 根 + 1 个模块 → 跨度 0），这正是最容易被触发的退化形态。

用法：python scripts/verify-mindmap-geometry.py
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
OUT = os.environ.get("MMGEOM_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "V09-61", "ui"))
KEEP = os.environ.get("MMGEOM_KEEP_TMP") == "1"
REAL_HOME = os.path.join(os.path.expanduser("~"), ".tatai")
VIEW = (1500, 900)

passes = [0]
fails = []
CONSOLE = []


def ok(cond, label):
    print(("[mm] PASS " if cond else "[mm] FAIL ") + label)
    if cond:
        passes[0] += 1
    else:
        fails.append(label)


def info(msg):
    print("[mm]   " + msg)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def nm(m):
    if m.type not in ("error", "warning"):
        return None
    loc = m.location or {}
    where = ""
    if loc.get("url"):
        where = "  @ %s:%s:%s" % (loc.get("url"), loc.get("lineNumber"), loc.get("columnNumber"))
    return "console.%s: %s%s" % (m.type, m.text, where)


# MMGEOM_PROBE=1 时装入：包 Element.prototype.setAttribute，记下"谁把 transform 写成 NaN"的 JS 栈
PROBE_HOOK = r"""
(() => {
  const orig = Element.prototype.setAttribute;
  const origNS = Element.prototype.setAttributeNS;
  window.__nanSets = [];
  window.__xformWrites = 0;
  window.__hookSelftest = null;
  const record = (self, name, value) => {
    try {
      if (String(name) === 'transform') {
        window.__xformWrites++;
        const sv = String(value);
        if (sv.indexOf('NaN') >= 0 && window.__nanSets.length < 12) {
          window.__nanSets.push({
            tag: self.tagName, cls: (self.getAttribute && self.getAttribute('class')) || '',
            value: sv.slice(0, 80), t: Math.round(performance.now()),
            stack: (new Error()).stack,
          });
        }
      }
    } catch (e) {}
  };
  Element.prototype.setAttribute = function (name, value) {
    record(this, name, value);
    return orig.call(this, name, value);
  };
  Element.prototype.setAttributeNS = function (ns, name, value) {
    record(this, name, value);
    return origNS.call(this, ns, name, value);
  };
  // 自检：钩子必须看得见一次普通 transform 写入（不写 NaN，免得自检自己往控制台灌一条
  // "translate(NaN,NaN)" 假阳性——本脚本的断言正是"控制台无 NaN"）
  try {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', 'translate(1,1)');
    window.__hookSelftest = window.__xformWrites > 0 ? 'ok' : 'missed';
    window.__nanSets.length = 0; window.__xformWrites = 0;
  } catch (e) { window.__hookSelftest = 'error:' + e.message; }

  // MutationObserver：不论写入走 setAttribute 还是 innerHTML/属性节点，只要 transform 真变了就能看见
  window.__nanMutations = [];
  window.__xformMutations = 0;
  const startObs = () => {
    const root = document.documentElement;
    if (!root) return;
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type !== 'attributes' || m.attributeName !== 'transform') continue;
        window.__xformMutations++;
        const v = m.target.getAttribute('transform') || '';
        if (v.indexOf('NaN') >= 0 && window.__nanMutations.length < 12) {
          const path = [];
          let e = m.target;
          while (e && e !== document.body && path.length < 6) { path.push(e.tagName + (e.getAttribute && e.getAttribute('class') ? '.' + e.getAttribute('class') : '')); e = e.parentElement; }
          window.__nanMutations.push({ value: v.slice(0, 80), old: m.oldValue, path, t: Math.round(performance.now()) });
        }
      }
    }).observe(root, { subtree: true, attributes: true, attributeFilter: ['transform'], attributeOldValue: true });
  };
  if (document.documentElement) startObs();
  else document.addEventListener('readystatechange', function once() { if (document.documentElement) { startObs(); document.removeEventListener('readystatechange', once); } });
})();
"""


def _rm_onerror(func, p, exc):
    try:
        os.chmod(p, stat.S_IWRITE)
        func(p)
    except Exception:
        pass


def rmtree_hard(p):
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
    for cur, _d, files in os.walk(root):
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
        self.port = port
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", os.path.join("src", "server", "index.ts")],
            cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
        )

    def wait_health(self, timeout=240):
        end = time.time() + timeout
        while time.time() < end:
            if self.proc.poll() is not None:
                raise RuntimeError("后端进程退出（见 ui-backend.log）")
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/health" % self.port, timeout=5) as r:
                    if r.status == 200:
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
    env["TATAI_VITE_CACHE_DIR"] = cache_dir
    proc = subprocess.Popen(
        ["node", os.path.join("node_modules", "vite", "bin", "vite.js"), "dev",
         "--port", str(port), "--strictPort"],
        cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
    )
    end = time.time() + 180
    while time.time() < end:
        if proc.poll() is not None:
            raise RuntimeError("vite 起不来（见 ui-vite.log）")
        try:
            with urllib.request.urlopen("http://localhost:%d/" % port, timeout=5) as r:
                if r.status == 200:
                    return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("vite %d 未就绪" % port)


# ── 夹具 ─────────────────────────────────────────────────────────────────────
def make_fixture(home, tmp, fid, name, modules, disk_files=None):
    d = os.path.join(tmp, "proj-" + fid)
    arch = os.path.join(d, ".工作台", "arch")
    os.makedirs(arch, exist_ok=True)
    with open(os.path.join(arch, "modules.json"), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "generated_at": "2026-01-01T00:00:00+08:00",
                   "budget_exhausted": False, "modules": modules}, f, ensure_ascii=False)
    for path, files in (disk_files or {}).items():
        pd = os.path.join(d, path)
        os.makedirs(pd, exist_ok=True)
        for fn in files:
            with open(os.path.join(pd, fn), "w", encoding="utf-8") as f:
                f.write("export const v = 1;\n")
    reg_path = os.path.join(home, "registry.json")
    reg = json.load(open(reg_path, encoding="utf-8"))
    now = "2026-01-01T00:00:00+08:00"
    reg["projects"].append({"id": fid, "name": name, "path": d, "kind": "backend",
                            "registered_at": now, "last_opened_at": now})
    with open(reg_path, "w", encoding="utf-8") as f:
        json.dump(reg, f, ensure_ascii=False, indent=2)
    return d


# ── 页面操作 ─────────────────────────────────────────────────────────────────
def open_arch(page, project):
    page.goto("http://localhost:%d/#p/%s" % (page._vite_port, urllib.parse.quote(project, safe="")),
              wait_until="domcontentloaded")
    page.wait_for_timeout(2200)
    page.locator('button[data-view="arch"]').click()
    page.wait_for_selector("[data-arch-tab]", timeout=40000)
    page.wait_for_timeout(800)


def open_tech(page, mode):
    page.locator('[data-project-view-tab="tech"]').click()
    page.wait_for_selector("[data-graph-mode-switch]", timeout=40000)
    page.locator('[data-graph-mode="%s"]' % mode).click()
    page.wait_for_timeout(2000)


def switch_mode(page, mode):
    sel = '[data-graph-mode="%s"]' % mode
    page.wait_for_selector(sel, timeout=30000)
    page.locator(sel).click()
    page.wait_for_timeout(1400)


def wait_mm(page, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        v = page.get_attribute("[data-mindmap-view]", "data-mindmap-mm-nodes")
        if v not in (None, "", "0"):
            return int(v)
        page.wait_for_timeout(300)
    return 0


MM_JS = """() => {
  const host = document.querySelector('[data-mindmap-view]');
  const svg = document.querySelector('[data-mindmap-svg]');
  const box = host ? host.getBoundingClientRect() : null;
  const gs = host ? [...host.querySelectorAll('g[transform]')] : [];
  const nan = gs.filter(g => (g.getAttribute('transform') || '').indexOf('NaN') >= 0).length;
  const nodes = host ? [...host.querySelectorAll('.markmap-node')] : [];
  let inBox = 0;
  for (const n of nodes) {
    const r = n.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    if (box && r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1) inBox++;
  }
  const mainG = svg ? svg.querySelector(':scope > g') : null;
  return {
    mm: document.querySelector('[data-mindmap-view]')?.getAttribute('data-mindmap-mm-nodes') ?? 'n/a',
    nodes: document.querySelector('[data-mindmap-view]')?.getAttribute('data-mindmap-nodes') ?? 'n/a',
    markmapNodes: nodes.length,
    inBox: inBox,
    gpaths: host ? host.querySelectorAll('g[data-path]').length : 0,
    mainTransform: mainG ? (mainG.getAttribute('transform') || '') : '(no g)',
    nanTransforms: nan,
    focused: document.querySelector('[data-mindmap-view]')?.getAttribute('data-mindmap-focused') ?? '',
    focusState: document.querySelector('[data-mindmap-view]')?.getAttribute('data-mindmap-focus-state') ?? '',
    error: document.querySelector('[data-mindmap-error]')?.textContent?.slice(0, 120) ?? 'none',
    errBanner: document.querySelector('[data-mindmap-error-banner]')?.textContent?.slice(0, 120) ?? 'none',
  };
}"""


def mm_state(page):
    return page.evaluate(MM_JS)


def nan_in(console, since):
    return [c for c in console[since:] if "NaN" in c]


def dump_probe(page, rec):
    """MMGEOM_PROBE=1：读出"谁把 transform 写成 NaN"的证据（调用栈 + MutationObserver）。"""
    try:
        sets = page.evaluate("() => window.__nanSets || []")
        rec["nan_sets"] = sets
        info("探针自检=%r；transform 属性写入总数=%s；NaN 写入=%d 条" % (
            page.evaluate("() => window.__hookSelftest"),
            page.evaluate("() => window.__xformWrites"), len(sets)))
        muts = page.evaluate("() => window.__nanMutations || []")
        rec["nan_mutations"] = muts
        info("MutationObserver：transform 变更=%s；NaN 变更=%d 条" % (
            page.evaluate("() => window.__xformMutations"), len(muts)))
        for x in sets[:8]:
            info("  - <%s class=%r> value=%r t=%sms" % (x["tag"], x["cls"], x["value"], x["t"]))
            for line in (x.get("stack") or "").splitlines()[:12]:
                info("      " + line.strip())
    except Exception as e:
        info("探针转储失败：%s" % e)


def check_drawn(page, tag, console, since, rec):
    d = mm_state(page)
    rec.setdefault("states", {})[tag] = d
    info("[%s] transform=%s markmapNodes=%d inBox=%d gpaths=%d nanTransforms=%d focused=%r state=%r err=%r" % (
        tag, d["mainTransform"][:44], d["markmapNodes"], d["inBox"], d["gpaths"],
        d["nanTransforms"], d["focused"], d["focusState"], d["errBanner"]))
    ok(d["nanTransforms"] == 0, "[%s] g[transform] 无 NaN（实际 %d 个）" % (tag, d["nanTransforms"]))
    ok(d["markmapNodes"] > 0, "[%s] 真绘制出节点（.markmap-node=%d）" % (tag, d["markmapNodes"]))
    n = nan_in(console, since)
    ok(not n, "[%s] 本段控制台无 NaN（%d 条）" % (tag, len(n)))
    return d


def main():
    if not os.path.isdir(REAL_HOME):
        print("[mm] 真实数据目录不存在：%s" % REAL_HOME)
        sys.exit(2)
    tmp = tempfile.mkdtemp(prefix="tatai-mmgeom-")
    home = os.path.join(tmp, "home")
    shutil.copytree(REAL_HOME, home)
    os.makedirs(OUT, exist_ok=True)

    # 单模块项目：可见树 = 根 + 1 模块（某轴跨度 0，最易触发的退化形态）
    make_fixture(home, tmp, "mmgeom-single", "单模块夹具",
                 [{"id": "only", "path": "only", "file_count": 3, "deps": []}],
                 disk_files={"only": ["a.ts", "b.ts", "c.ts"]})
    # 空项目：没有任何模块
    make_fixture(home, tmp, "mmgeom-empty", "空夹具", [])
    # 多模块项目：正常对照 + 巨枝
    mods = [{"id": "m%02d" % i, "path": "m%02d" % i, "file_count": 3 if i % 2 else 2, "deps": []}
            for i in range(1, 10)]
    mods.append({"id": "big", "path": "big", "file_count": 50, "deps": []})
    make_fixture(home, tmp, "mmgeom-multi", "多模块夹具", mods,
                 disk_files={"big": ["leaf-%02d.ts" % j for j in range(50)]})

    home_before = tree_fingerprint(REAL_HOME)
    info("真实 ~/.tatai 指纹（前）：%d 文件 / %s…" % (home_before["files"], home_before["hash"][:12]))

    backend = None
    vite = None
    rec = {}
    bport = free_port()
    vport = free_port()
    try:
        backend = Backend(home, bport, os.path.join(OUT, "ui-backend.log"))
        backend.wait_health()
        vite = start_vite(vport, bport, os.path.join(OUT, "ui-vite.log"), os.path.join(tmp, "vite-cache"))
        info("后端 :%d / vite :%d 就绪（TATAI_HOME=%s）" % (bport, vport, home))

        def launch(p):
            try:
                return p.chromium.launch(headless=True)
            except Exception as e:
                info("chromium 不可用（%s），回落 msedge" % str(e)[:60])
                return p.chromium.launch(headless=True, channel="msedge")

        with sync_playwright() as p:
            browser = launch(p)
            try:
                page = browser.new_context(viewport={"width": VIEW[0], "height": VIEW[1]}).new_page()
                page._vite_port = vport
                if os.environ.get("MMGEOM_PROBE"):
                    page.add_init_script(PROBE_HOOK)
                page.on("pageerror", lambda e: CONSOLE.append("pageerror: %s" % str(e)))
                page.on("console", lambda m: CONSOLE.append(nm(m)) if nm(m) else None)

                # ① 初始挂载（退化形态：单模块）
                s = len(CONSOLE)
                open_arch(page, "mmgeom-single")
                open_tech(page, "MIND_MAP")
                page.wait_for_selector("[data-mindmap-view]", timeout=40000)
                ms = wait_mm(page)
                page.wait_for_timeout(900)
                check_drawn(page, "① 初始挂载(单模块)", CONSOLE, s, rec)
                page.screenshot(path=os.path.join(OUT, "01-initial-single.png"))

                # ② 隐藏再显示（切走 MODULE_BOX 再回来）
                s = len(CONSOLE)
                switch_mode(page, "MODULE_BOX")
                page.wait_for_timeout(1200)
                switch_mode(page, "MIND_MAP")
                page.wait_for_timeout(1400)
                d = check_drawn(page, "② 隐藏再显示", CONSOLE, s, rec)
                ok(d["inBox"] >= 1, "② 隐藏再显示后有节点落在容器盒内（inBox=%d）" % d["inBox"])
                page.screenshot(path=os.path.join(OUT, "02-hide-show.png"))

                # ③ 快速切图（连续来回 8 次）
                s = len(CONSOLE)
                for i in range(4):
                    switch_mode(page, "MODULE_BOX" if i % 2 == 0 else "MIND_MAP")
                switch_mode(page, "MIND_MAP")
                page.wait_for_timeout(1600)
                d = check_drawn(page, "③ 快速切图(8×)", CONSOLE, s, rec)
                ok(d["inBox"] >= 1, "③ 快速切图后仍有可画视图（inBox=%d）" % d["inBox"])

                # ④ 展开 + 反向定位（MODULE_BOX ↔ MIND_MAP）
                s = len(CONSOLE)
                child = None
                # 在导图里点模块节点 → 懒加载 A4 子级（就地展开）
                d = wait_mm(page) and page.evaluate(
                    """() => {
                      const g = [...document.querySelectorAll('[data-mindmap-view] g[data-path]')]
                        .find(x => (x.textContent || '').includes('only'));
                      if (!g) return null;
                      const r = g.getBoundingClientRect();
                      return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)};
                    }""")
                if d:
                    page.mouse.click(d["x"], d["y"])
                    page.wait_for_timeout(2500)
                    child = page.evaluate(
                        "() => { const e = document.querySelector('[data-mm-locate]'); return e ? e.getAttribute('data-mm-locate') : null; }")
                rec["expand_child"] = child
                ok(child is not None, "④ 导图点模块后展开出子级（data-mm-locate id=%r）" % child)
                # 折回去（子级不可见），再走方框图 → 导图的定位，验证"就地展开到可见 + 居中"不产生 NaN
                if d:
                    g2 = page.evaluate(
                        """() => {
                          const g = [...document.querySelectorAll('[data-mindmap-view] g[data-path]')]
                            .find(x => (x.textContent || '').includes('only'));
                          if (!g) return null;
                          const r = g.getBoundingClientRect();
                          return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)};
                        }""")
                    if g2:
                        page.mouse.click(g2["x"], g2["y"])
                        page.wait_for_timeout(1200)
                switch_mode(page, "MODULE_BOX")
                page.wait_for_timeout(800)
                # 在方框图展开该模块，拿到子级的「导图」入口
                if page.locator('[data-expand-toggle="only"]').count() > 0:
                    page.eval_on_selector('[data-expand-toggle="only"]', "el => el.click()")
                    page.wait_for_timeout(1500)
                # 优先用子级入口；方框图里该子级还没出来就退回**顶层模块自身**的入口
                # （仍走同一条 centerNode + 尺寸护栏，保证"展开定位"这一步真被执行到）
                target_id = child
                if not target_id or page.locator('[data-locate-mindmap="%s"]' % target_id).count() == 0:
                    target_id = "only"
                entry = page.locator('[data-locate-mindmap="%s"]' % target_id)
                rec["locate_target"] = target_id
                rec["locate_entry"] = entry.count()
                ok(entry.count() > 0, "④ 方框图里找到 `data-locate-mindmap` 定位入口（target=%r，%d 个）" % (target_id, entry.count()))
                if entry.count() > 0:
                    entry.first.click()
                    page.wait_for_timeout(2600)
                    d = check_drawn(page, "④ 反向定位回导图", CONSOLE, s, rec)
                    ok(d["focusState"] == "matched", "④ 定位命中（focus-state=%r）" % d["focusState"])
                    if d["focusState"] == "matched":
                        ok(d["focused"] == target_id, "④ 定位命中的就是该 module_id（focused=%r）" % d["focused"])
                        ok(page.locator('[data-mm-focused="%s"]' % target_id).count() >= 1,
                           "④ 导图上出现该节点的高亮环（data-mm-focused）")
                        page.screenshot(path=os.path.join(OUT, "04-locate-back.png"))
                else:
                    info("④ 方框图未出现 data-locate-mindmap 入口（跳过反向定位断言）")

                # ⑤ 空项目
                s = len(CONSOLE)
                open_arch(page, "mmgeom-empty")
                open_tech(page, "MIND_MAP")
                page.wait_for_selector("[data-mindmap-view]", timeout=40000)
                page.wait_for_timeout(1400)
                d = mm_state(page)
                rec["empty_state"] = d
                info("[⑤ 空项目] markmapNodes=%d nanTransforms=%d err=%r" % (d["markmapNodes"], d["nanTransforms"], d["errBanner"]))
                ok(d["nanTransforms"] == 0, "⑤ 空项目无 NaN transform（%d）" % d["nanTransforms"])
                ok(not nan_in(CONSOLE, s), "⑤ 空项目控制台无 NaN")
                ok(d["errBanner"] == "none" or d["markmapNodes"] >= 0, "⑤ 空项目不报错横幅（errBanner=%r）" % d["errBanner"])

                # ⑥ 多模块正常对照：隐藏再显示 + 全部切回
                s = len(CONSOLE)
                open_arch(page, "mmgeom-multi")
                open_tech(page, "MIND_MAP")
                page.wait_for_selector("[data-mindmap-view]", timeout=40000)
                wait_mm(page)
                page.wait_for_timeout(900)
                check_drawn(page, "⑥ 多模块初始", CONSOLE, s, rec)
                switch_mode(page, "MODULE_BOX")
                page.wait_for_timeout(1200)
                switch_mode(page, "MIND_MAP")
                page.wait_for_timeout(1500)
                d = check_drawn(page, "⑥ 多模块隐藏再显示", CONSOLE, s, rec)
                page.screenshot(path=os.path.join(OUT, "06-multi.png"))

                # 全段汇总：整轮控制台不得出现 NaN
                nan_all = [c for c in CONSOLE if "NaN" in c]
                rec["console_nan"] = nan_all[:10]
                rec["console_all"] = list(dict.fromkeys(CONSOLE))[:20]
                ok(not nan_all, "整轮真机验证控制台不含 translate(NaN,NaN)（%d 条）" % len(nan_all))
            finally:
                # 场景中途抛错也要把探针读数带出来（否则拿不到"谁写的 NaN"）
                if os.environ.get("MMGEOM_PROBE"):
                    dump_probe(page, rec)
                rec["console_all"] = list(dict.fromkeys(CONSOLE))[:20]
                rec["console_nan"] = [c for c in CONSOLE if "NaN" in c][:20]
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
    time.sleep(0.4)
    ok(home_before["hash"] == home_after["hash"],
       "真实 ~/.tatai 零写入（指纹前后一致：%d 文件）" % home_after["files"])

    with open(os.path.join(OUT, "readings.json"), "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False, indent=2)
    for line in rec.get("console_all", []):
        info("浏览器控制台：" + line)
    if not KEEP:
        info("临时夹具目录自清：%s（%s）" % ("已删" if rmtree_hard(tmp) else "残留", tmp))
    print("\n[mm] V09-61 思维导图几何 %d PASS / %d FAIL" % (passes[0], len(fails)))
    if fails:
        for x in fails:
            print("[mm]   FAIL " + x)
        sys.exit(1)


if __name__ == "__main__":
    main()
