#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-09 ① 六图真实 UI：真浏览器 + 真后端，**六图逐屏**截图与 `data-*` 读数。

六图（DESIGN.md §3.2 / 附录 E.5）：
  · 三主视图 = 功能全景(functional) / 系统架构(architecture) / 施工依赖(construction)
  · 技术详情三张 = 模块方框图(MODULE_BOX) / 数据流向图(DATA_FLOW) / 思维导图(MIND_MAP)

逐屏留：截图 1 张 + 读数（节点数/边数/这张图回答什么问题/数据从哪来），落
`.工作台/evidence/V09-09/1/ui-shots/` 与 `ui-readings.json`。
数据流向图屏额外核对 V09-11 的「当前实现 vs 目标语义」双口径＋数据链面板；
主视图屏额外核对 V09-12 的更新状态锚点与 V09-13 的来源/证据标注＋交付阻断读数；
其中 functional/architecture 两屏另核对 **§3.2 同组关系的可见性**（逐条同组关系在场、计数与六图读口
`get_project_graphs` 的同一份派生逐值相等）＋**实际可达性**（默认可见可点的画布关系按钮 /
说明入口可点→关系列表完整展开→条目可点追来源；展开过程画布高度不塌；异常默认可见）；
construction 屏保持原「有边」判据（V09-21 R5：过期断言**等强替换**，不是删除或放宽）。

真机口径（卡面 ①，隔离按 AGENTS.md §5）：
  · 起**真**后端（`node --import tsx src/server/index.ts`）+ **真** vite；
    端口：dev 默认 5173（`V0909_VITE_PORT` 可覆盖为动态空闲端口，避免与并发 UI 脚本抢 5173）；
    浏览器：默认用本机现有 **Edge**（`channel=msedge`；`V0909_BROWSER_CHANNEL=""` 回退自带 chromium）；
  · 输出目录：`V0909_EVID_DIR` 可覆盖（默认旧固定证据目录）；本轮指向 v0909-real 唯一目录，不覆盖旧证据；
  · 所有 loopback 请求**绕过系统代理**（装全局 opener + no_proxy），vite 依赖缓存写隔离目录；
  · 数据目录 = 临时 `TATAI_HOME`，其内容 = 真实 `~/.tatai` 的**只读拷贝**（含真实注册表）——
    六图读的是**真实项目 D:\\tatai 的真实 `.工作台`**（蓝图/对账/事件账本），
    而全局数据目录落在临时区 ⇒ 与 dev 后端写口（work-service.json 等）**零接触 ~/.tatai**；
  · 全程只读浏览六图：不点 Gate、不触发解析、不建备份、不调任何写接口；
  · 收尾杀净两端、删临时目录；脚本另记 `~/.tatai` 首尾指纹自证零写入。
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

# 输出目录：可选环境变量覆盖（默认仍是旧固定证据目录，保持兼容）。
# 本轮（2026-10-08 v0909-real attempt）显式指向新唯一目录，**不覆盖**旧固定证据。
# 相对路径按仓库根解析，便于 `V0909_EVID_DIR=.工作台/project-completion-20261008/v0909-real` 这样传。
_EVID_ENV = os.environ.get("V0909_EVID_DIR", "").strip()
EVID = os.path.abspath(_EVID_ENV if os.path.isabs(_EVID_ENV) else os.path.join(REPO, _EVID_ENV)) \
    if _EVID_ENV else os.path.join(REPO, ".工作台", "evidence", "V09-09", "1")

# 所有 loopback（127.0.0.1 / localhost）请求**绕过系统代理**：否则 urllib 会走 http(s)_proxy
# 打到外网网关导致本地健康检查/接口调用失败（或泄漏到代理）。装全局 opener + 设 no_proxy 双保险。
os.environ["no_proxy"] = os.environ.get("no_proxy", "") + ",127.0.0.1,localhost,::1"
os.environ["NO_PROXY"] = os.environ.get("NO_PROXY", "") + ",127.0.0.1,localhost,::1"
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))

SHOT_DIR = os.environ.get("V0909_SHOT_DIR", os.path.join(EVID, "ui-shots"))
READINGS = os.path.join(EVID, "ui-readings.json")
REAL_HOME = os.path.join(os.path.expanduser("~"), ".tatai")
REAL_ID = "tatai"
# dev 端口：默认 5173（与壳 devUrl 一致、兼容），可用 V0909_VITE_PORT 覆盖成动态空闲端口，
# 避免与其它并发 UI 验证脚本（占着 5173/3456/…）抢端口。
VITE_PORT = int(os.environ.get("V0909_VITE_PORT", "5173"))
# 浏览器通道：默认用本机现有 Edge（playwright 未装自带 chromium；任务口径「用现有 Edge」），
# 置空（V0909_BROWSER_CHANNEL=""）则回退到 playwright 自带 chromium 的旧行为。
BROWSER_CHANNEL = os.environ.get("V0909_BROWSER_CHANNEL", "msedge").strip()

passes = [0]
fails = []
infos = []


def ok(cond, label):
    print(("[ui] PASS " if cond else "[ui] FAIL ") + label)
    if cond:
        passes[0] += 1
    else:
        fails.append(label)


def info(msg):
    infos.append(msg)
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


def http(url, method="GET", body=None, timeout=180):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, method=method, data=data)
    if data is not None:
        req.add_header("content-type", "application/json")
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


def tree_fingerprint(root, limit=2000):
    """目录树指纹（相对路径+大小），用于「零写入 ~/.tatai」自证；另返回逐文件 map 供定位变更。"""
    import hashlib

    sizes = {}
    if not os.path.isdir(root):
        return {"files": 0, "hash": "n/a", "sizes": sizes}
    for cur, _dirs, files in os.walk(root):
        for name in sorted(files):
            p = os.path.join(cur, name)
            rel = os.path.relpath(p, root).replace("\\", "/")
            try:
                size = os.path.getsize(p)
            except OSError:
                size = -1
            sizes[rel] = size
            if len(sizes) >= limit:
                break
    rows = sorted("%s\t%d" % (k, v) for k, v in sizes.items())
    return {"files": len(sizes), "hash": hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest(), "sizes": sizes}


# ══════════════════════════════ 后端 / vite ══════════════════════════════

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

    def api(self, path):
        return http("http://127.0.0.1:%d%s" % (self.port, path))

    def wait_health(self, timeout=180):
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


def start_vite(port, backend_port, log_path, cache_dir=None):
    env = dict(os.environ)
    env["TATAI_DEV_API_PORT"] = str(backend_port)
    # 依赖预打包缓存隔离：node_modules 是对真实 D:/tatai 的 junction，vite 默认会写共享的
    # node_modules/.vite——并发跑验证脚本会互相打架（vite.config.ts 的 TATAI_VITE_CACHE_DIR 口径）。
    if cache_dir:
        env["TATAI_VITE_CACHE_DIR"] = cache_dir
    proc = subprocess.Popen(
        ["node", os.path.join("node_modules", "vite", "bin", "vite.js"), "dev",
         "--port", str(port), "--strictPort"],
        cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
    )
    deadline = time.time() + 150
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


ROOT = "[data-project-view]"
NAV_EVENTS = []


def attr(page, selector, name):
    loc = page.locator(selector)
    if loc.count() == 0:
        return None
    return loc.first.get_attribute(name)


def text(page, selector):
    loc = page.locator(selector)
    return loc.first.inner_text() if loc.count() > 0 else ""


def open_ancestor_details(page, selector):
    """展开目标元素的所有**收起的祖先** `<details>`（当前 UI 把若干面板嵌在默认收起的 details 内）。

    这是像用户那样把折叠区点开，不改产品；只动祖先 details，不动目标自身所在的 details。
    """
    page.evaluate(
        """(sel) => {
          const el = document.querySelector(sel);
          if (!el) return;
          let p = el.parentElement;
          while (p) {
            if (p.tagName === 'DETAILS' && p.open !== true) p.open = true;
            p = p.parentElement;
          }
        }""",
        selector,
    )
    page.wait_for_timeout(250)


def wait_view_nodes(page, viewk, node_sel, budget_s=90):
    """等当前主视图的节点真上屏。冷启动首屏可能慢（后端同步扫描/首次取模型）——超时前促发一次重取
    （切到另一页签再切回，幂等只读），避免把「还没渲染完」误读成 0 节点。"""
    deadline = time.time() + budget_s
    tried_switch = False
    while time.time() < deadline:
        if page.locator(node_sel).count() > 0:
            return True
        page.wait_for_timeout(2000)
        if not tried_switch and time.time() > deadline - budget_s * 0.4:
            tried_switch = True
            other = "architecture" if viewk != "architecture" else "functional"
            try:
                page.locator('[data-project-view-tab="%s"]' % other).click(timeout=5000)
                page.wait_for_timeout(1500)
                page.locator('[data-project-view-tab="%s"]' % viewk).click(timeout=5000)
            except Exception:  # noqa: BLE001
                pass
    return page.locator(node_sel).count() > 0


def ensure_view(page, viewk, node_sel, budget_s=90):
    """确保当前页**稳定停在该主视图**上，再读数。

    为什么需要：本机同时有别的 worker 在改源码，vite dev 的 HMR 可能触发**整页重载**（实测：
    2026-10-08 首跑时 architecture 屏读到一半被导航掉，`data-project-delivery`/徽标/画布高度全变 None）。
    重载后 `data-project-view` 回到默认态，这里重新点页签并等节点上屏；这是**取稳定读数**，不是改产品。
    """
    deadline = time.time() + budget_s
    while time.time() < deadline:
        try:
            cur = page.locator(ROOT).first.get_attribute("data-project-view")
        except Exception:  # noqa: BLE001
            cur = None
        if cur == viewk and page.locator(node_sel).count() > 0:
            return True
        try:
            page.locator('[data-project-view-tab="%s"]' % viewk).click(timeout=5000)
        except Exception:  # noqa: BLE001
            try:
                page.wait_for_load_state("domcontentloaded", timeout=10000)
            except Exception:  # noqa: BLE001
                pass
        page.wait_for_timeout(800)
    return False


def stable_probe(page, probe_fn, *args, **kwargs):
    """跑一次勘测；若期间发生过**整页导航**（并发 HMR 重载），重建视图后重跑（最多 3 次）。

    返回 (读数 dict, 重试次数)。重载不算产品问题，也不因此判红——但要如实记在读数里。
    """
    for attempt in range(3):
        before = len(NAV_EVENTS)
        out = probe_fn(page, *args, **kwargs)
        if len(NAV_EVENTS) == before:
            out["nav_reloads_during_probe"] = 0
            out["reload_retries"] = attempt
            return out
        page.wait_for_timeout(1200)
    out["nav_reloads_during_probe"] = len(NAV_EVENTS) - before
    out["reload_retries"] = 3
    return out


def main_question(page):
    """主视图问题句：页签容器里紧跟 `data-project-view-switch` 的那个说明 span。"""
    loc = page.locator("[data-project-view-switch] + span")
    if loc.count() > 0:
        return loc.first.inner_text().strip()
    return ""


def edge_count_main(page):
    """主视图边数：图例逐条 `data-edge-count` 之和（与渲染同一份可见边）。"""
    vals = page.evaluate(
        "Array.from(document.querySelectorAll('[data-edge-legend]')).map(e => e.getAttribute('data-edge-count'))"
    )
    try:
        return sum(int(v) for v in vals if v not in (None, ""))
    except Exception:
        return None


def read_intra_counts(home, project_id=REAL_ID):
    """读口现场取**同组关系**条数（六图读口 `get_project_graphs` 用的是同一份派生 `sixGraphsOf`）。

    为什么用子进程：六图读口没有 HTTP 面（服务端只暴露 blueprint/dataflow/render），本脚本在**同一隔离
    TATAI_HOME** 下起一个 node 进程调同一份派生，拿 functional/architecture 两屏的同组关系条数——
    界面上的逐条同组关系必须与它逐值相等（§3.2 同组关系可见性；数字**动态取**，不钉死）。
    返回 (读数 dict, 失败原因)；读不到时读数给 None（由调用处的断言判红，不当成「一致」）。
    """
    code = (
        "const m = await import('file:///%s/src/arch/sixGraphs.ts');"
        "const s = m.sixGraphsOf(%s, { limit: 100000 });"
        "const out = {};"
        "for (const k of ['functional', 'architecture']) {"
        "  const g = s.graphs[k];"
        "  out[k] = { intra: g.counts.intra_relations, groups: g.counts.groups,"
        " truncated: g.counts.truncated_by_limit, groups_listed: g.groups.length };"
        "}"
        "console.log(JSON.stringify({ snapshot: s.snapshot_id ?? null, graphs: out }));"
        % (REPO.replace("\\", "/"), json.dumps(project_id))
    )
    env = dict(os.environ)
    env["TATAI_HOME"] = home
    try:
        proc = subprocess.run(
            ["node", "--import", "tsx", "--input-type=module", "-e", code],
            cwd=REPO, env=env, capture_output=True, text=True, timeout=300,
        )
    except Exception as e:  # noqa: BLE001
        return None, "读口子进程异常：%s" % e
    if proc.returncode != 0:
        return None, "读口子进程 exit %d：%s" % (proc.returncode, (proc.stderr or "").strip()[-400:])
    for line in reversed((proc.stdout or "").strip().splitlines()):
        try:
            return json.loads(line), ""
        except Exception:  # noqa: BLE001
            continue
    return None, "读口没有输出可解析的 JSON：%r" % (proc.stdout or "")[-200:]


def intra_counts_on_screen(page, viewk):
    """本屏「同组关系」的界面读数（§3.2 同组关系可见性）：

      · `panel_count` = 面板 `[data-intra-relations]` 的 `data-intra-relations-count`（本次视图全部条数）；
      · `entries`     = 面板里**逐条** `[data-intra-relation]` 条目数（限高可滚，但逐条都在 DOM 里）；
      · `groups`      = 条目按分组摊开的组数（"逐条列在分组上"的机械读数）；
      · `chip_total`  = 画布分组节点上的 `[data-intra-chip]` 条目合计（NodeCard 上的可点条目）。
    """
    anchor = '[data-intra-relations="project-%s"]' % viewk
    loc = page.locator(anchor)
    if loc.count() == 0:
        return None

    def _int(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    chip_vals = page.evaluate(
        "Array.from(document.querySelectorAll('[data-intra-chips]')).map(e => e.getAttribute('data-intra-chips-count'))"
    )
    try:
        chip_total = sum(int(v) for v in chip_vals if v not in (None, ""))
    except Exception:  # noqa: BLE001
        chip_total = None
    return {
        "anchor": loc.first.get_attribute("data-intra-relations"),
        "panel_count": _int(loc.first.get_attribute("data-intra-relations-count")),
        "panel_visible": _int(loc.first.get_attribute("data-intra-relations-visible")),
        "entries": page.locator("%s [data-intra-relation]" % anchor).count(),
        "groups": page.locator("%s [data-intra-group]" % anchor).count(),
        "chip_anchors": len(chip_vals),
        "chip_total": chip_total,
    }


def box_height(page, selector):
    loc = page.locator(selector)
    if loc.count() == 0:
        return None
    b = loc.first.bounding_box()
    return None if b is None else round(b["height"], 1)


def _first_visible(loc):
    """返回 locator 里第一个真正可见的第 i 项（没有则 None）。"""
    for i in range(loc.count()):
        try:
            if loc.nth(i).is_visible():
                return i
        except Exception:  # noqa: BLE001
            continue
    return None


def panel_anchor(viewk):
    return '[data-intra-relations="project-%s"]' % viewk


def probe_intra_reachability(page, viewk):
    """勘测「同组关系」在这张主视图上的**实际可达性**（默认态 → 说明入口 → 关系列表 → 出处行）。

    为什么不再断言「面板 summary 本体默认可见」（2026-10-08 v0909-final-review，五要素留档）：
      旧期望＝`IntraRelationPanel` 的 `summary[data-intra-relations-summary]` **自身**默认可见（2026-09-27
              V09-21 R5 时它是画布上方顶层的一行折叠件，当时本检查 PASS）。
      依据  ＝2026-10-04 **已验收的 UI 重设计**（`git 9df895d`「chore: archive accepted UI and v0.3.0
              release changes」，实施契约 `docs/ui-redesign-20261004.md`，用户授权 req-tatai-ui-20261004）
              把画布上方的说明块（数量/连线/分组口径 ＋ 边语义图例 ＋ 同组关系面板）统一收进
              `<details class="tt-graph-guide">`（默认收起，**summary 一行常显可点**）；DESIGN §3.11 现行
              口径是「画布上方那组信息默认至多简短一行、详情按需展开」，并且「收起只改上屏篇幅、不改判据」。
              另：`IntraRelationChips`（画布分组节点上的同组关系条目，V09-17 引入）**默认就在画布上**，
              点一下直接落到详情面板的出处行——默认可达路径并不依赖面板本体常显。
      新期望＝**可达性**（比"某块默认可见"更贴 §3.2 的原意）：
              (a) 画布上方说明入口（`.tt-graph-guide > summary`）默认可见、可点；
              (b) 点开后同组关系面板 summary 可见，关系列表**逐条完整**（条数＝面板计数＝读口值）；
              (c) 任一条关系点开后给出**可追的具体来源行**（`设计来源/代码来源：<路径> · <定位>`）；
              (d) functional 屏另有**默认态**就可达的第二条路：画布分组节点上的 `[data-intra-chip]`
                  默认可见、可点，点一下直接显示该关系的出处行；
              (e) 上述展开/点击过程中画布高度不塌（`[data-project-canvas-host]` 保有可操作高度）。
      保留意图＝原断言守的是「同组关系**不是只写在文字里**、用户真能点开追到来源」（DESIGN §3.2 红线）；
              "面板本体默认可见"只是当时那版布局的**实现细节**，不是这条红线本身。
      判据不放宽＝(a)–(e) 任一不成立即判红：说明入口不可见/不可点、关系列表条数与读口不等、条目点不开、
              出处行给不出具体路径、画布被压塌——任一情形逐条判红；functional 屏若**两条默认可达路径都没有**
              （入口不可点 **且** 画布无可见可点的关系按钮）同样判红。
    """
    anchor = panel_anchor(viewk)
    # 并发 HMR 可能整页重载：先确保仍停在本视图（否则读到的是默认视图的 DOM）
    ensure_view(page, viewk, "[data-arch-node]" if viewk == "architecture" else "[data-project-node]")
    # 复位成"默认态"再勘测。**两处都要复位**：切视图时 React 复用同两个 `<details>` 节点，
    # 上一屏探针把它们展开过；只复位外层 guide 的话，后面"点开面板"会变成**点关**，
    # 于是条目不可见、所有点击超时（2026-10-08 实测踩到：architecture 屏 8 次点击全超时，实为脚本 bug）。
    page.evaluate(
        """(viewk) => {
          const d = document.querySelector('.tt-graph-guide');
          if (d) d.open = false;
          const f = document.querySelector('[data-intra-relations="project-' + viewk + '"] details[data-intra-relations-fold]');
          if (f) f.open = false;
        }""",
        viewk,
    )
    page.wait_for_timeout(250)

    guide = page.locator(".tt-graph-guide")
    guide_present = guide.count() > 0
    guide_summary = page.locator(".tt-graph-guide > summary").first
    guide_summary_present = guide_summary.count() > 0
    guide_summary_visible = bool(guide_summary_present) and guide_summary.is_visible()
    out = {
        "view": viewk,
        "guide_present": guide_present,
        "guide_summary_present": guide_summary_present,
        "guide_summary_visible_default": guide_summary_visible,
        "canvas_h_default": box_height(page, "[data-project-canvas-host]"),
        "panel_entries_default": page.locator("%s [data-intra-relation]" % anchor).count() if page.locator(anchor).count() else 0,
        "panel_summary_visible_default": (
            page.locator("%s summary[data-intra-relations-summary]" % anchor).first.is_visible()
            if page.locator("%s summary[data-intra-relations-summary]" % anchor).count() else False
        ),
    }

    # (d) functional 屏：画布分组节点上的关系按钮——默认态即可见、可点、点出出处行
    chips = page.locator("[data-intra-chip]")
    out["chip_count"] = chips.count()
    idx = _first_visible(chips)
    out["chip_visible_index"] = idx
    out["chip_visible_count"] = 0 if idx is None else 1
    if idx is not None:
        chip = chips.nth(idx)
        cid = chip.get_attribute("data-intra-chip")
        try:
            chip.click(timeout=8000)
            page.wait_for_timeout(500)
            sec = page.locator('[data-project-relation="%s"]' % cid)
            lines = page.locator("[data-project-relation-line]")
            texts = [lines.nth(k).inner_text().strip() for k in range(lines.count())]
            traced = [t for t in texts if ("来源：" in t or "设计来源" in t or "代码来源" in t) and "·" in t]
            out["chip_open"] = {
                "chip": cid,
                "section_present": sec.count() > 0,
                "section_visible": bool(sec.count()) and sec.first.is_visible(),
                "lines": len(texts),
                "traced_line": (traced[0] if traced else (texts[0] if texts else ""))[:200],
                "trace_ok": bool(traced),
            }
            close = page.locator("[data-project-relation-close]")
            if close.count():
                try:
                    close.first.click(timeout=4000)
                except Exception:  # noqa: BLE001
                    pass
        except Exception as e:  # noqa: BLE001
            out["chip_open"] = {"chip": cid, "section_present": False, "trace_ok": False, "error": str(e).splitlines()[0]}
    else:
        out["chip_open"] = None

    # (a)(b) 说明入口 → 关系列表完整展开
    if guide_summary_present:
        try:
            guide_summary.click(timeout=8000)
            page.wait_for_timeout(350)
        except Exception as e:  # noqa: BLE001
            out["guide_click_error"] = str(e).splitlines()[0]
    out["guide_open_after_click"] = page.evaluate(
        "() => { const d = document.querySelector('.tt-graph-guide'); return d ? d.open === true : null }"
    )
    out["canvas_h_guide_open"] = box_height(page, "[data-project-canvas-host]")
    panel_summary = page.locator("%s summary[data-intra-relations-summary]" % anchor)
    out["panel_summary_visible_after_guide"] = bool(panel_summary.count()) and panel_summary.first.is_visible()
    if panel_summary.count():
        try:
            panel_summary.first.click(timeout=8000)
            page.wait_for_timeout(350)
        except Exception as e:  # noqa: BLE001
            out["panel_click_error"] = str(e).splitlines()[0]
        # 点完确认真处于展开态（点在已展开的 details 上会变成收起——那会让下面的条目点击全部超时）
        fold_open = page.evaluate(
            """(viewk) => {
              const f = document.querySelector('[data-intra-relations="project-' + viewk + '"] details[data-intra-relations-fold]');
              return f ? f.open === true : null;
            }""",
            viewk,
        )
        if fold_open is not True:
            try:
                panel_summary.first.click(timeout=8000)
                page.wait_for_timeout(350)
            except Exception:  # noqa: BLE001
                pass
            fold_open = page.evaluate(
                """(viewk) => {
                  const f = document.querySelector('[data-intra-relations="project-' + viewk + '"] details[data-intra-relations-fold]');
                  return f ? f.open === true : null;
                }""",
                viewk,
            )
        out["panel_fold_open"] = fold_open
    out["panel_entries_after_expand"] = page.locator("%s [data-intra-relation]" % anchor).count()
    out["panel_groups_after_expand"] = page.locator("%s [data-intra-group]" % anchor).count()

    # (c) 真实列表里抽查若干条关系：点开后必须给出可追的具体来源行
    # 用 evaluate **一次性**取候选（避免逐元素 `get_attribute` 的隐式 30s 等待：大图条目多、React 会重渲染，
    # 逐元素取属性在网络/HMR 抖动下会超时并**中断整个六图巡检**——2026-10-08 首跑实测踩到，改用批量读）。
    try:
        candidates = page.evaluate(
            """(viewk) => {
              const root = document.querySelector('[data-intra-relations="project-' + viewk + '"]');
              if (!root) return [];
              return Array.from(root.querySelectorAll('details[data-intra-relation]'))
                .map(el => ({ edge: el.getAttribute('data-intra-relation'), kinds: el.getAttribute('data-intra-relation-source-kinds') || '' }))
                .filter(x => x.edge && x.kinds !== '')
                .slice(0, 8);
            }""",
            viewk,
        )
    except Exception as e:  # noqa: BLE001
        candidates = []
        out["trace_candidates_error"] = str(e).splitlines()[0]
    trace = {"attempted": len(candidates), "ok": False, "detail": "本屏没有带来源种类的同组关系条目"}
    last_err = ""
    # 有界重试：只试**前 8 条**带来源种类者（够刻画「点得开、追得到」；全部点不开即判红，不靠穷举）。
    for cand in candidates:
        edge = cand["edge"]
        kinds = cand["kinds"]
        try:
            page.locator('[data-intra-relation-summary="%s"]' % edge).first.click(timeout=8000)
        except Exception as e:  # noqa: BLE001
            last_err = str(e).splitlines()[0]
            continue
        page.wait_for_timeout(350)
        try:
            texts = page.evaluate(
                """(edge) => Array.from(document.querySelectorAll('[data-intra-relation-source^="' + edge + '#"]'))
                     .map(e => (e.textContent || '').trim())""",
                edge,
            )
        except Exception:  # noqa: BLE001
            texts = []
        traced = [t for t in texts if ("设计来源：" in t or "代码来源：" in t or "未归类来源：" in t) and "·" in t]
        trace = {
            "attempted": trace["attempted"],
            "ok": bool(traced),
            "edge": edge,
            "kinds": kinds,
            "lines": len(texts),
            "detail": "edge=%s、来源种类=%s、展开出处行 %d 条；抽查行：%s"
            % (edge, kinds, len(texts), (traced[0] if traced else (texts[-1] if texts else "(无)"))[:160]),
        }
        break
    if not trace["ok"]:
        trace["detail"] = "%s（%d 条带来源种类的条目尝试点开；最后失败：%s）" % (trace["detail"], trace["attempted"], last_err or "无错误信息")
    out["relation_trace"] = trace
    out["canvas_h_after_expand"] = box_height(page, "[data-project-canvas-host]")
    return out


def probe_exception_visibility(page, viewk):
    """异常默认可见（DESIGN §3.11／E.19 第 4 条）：有可行动异常时那**一条**信息栏的摘要默认可见；
    健康态整条不占常驻行。返回读数，由调用处断言（不在这里静默放过）。"""
    sec = page.locator("[data-graph-info-bar]")
    if sec.count() == 0:
        return {"view": viewk, "bar_present": False}
    rows = sec.first.get_attribute("data-graph-info-rows")
    healthy = page.locator("[data-graph-info-healthy]").count() > 0
    summary = page.locator("[data-graph-info-summary]")
    brief = ""
    if summary.count():
        brief = summary.first.inner_text().strip().replace("\n", " ")
    return {
        "view": viewk,
        "bar_present": True,
        "rows": rows,
        "healthy": healthy,
        "summary_present": summary.count() > 0,
        "summary_visible": bool(summary.count()) and summary.first.is_visible(),
        "brief": brief[:200],
        "bar_height": box_height(page, "[data-graph-info-bar]"),
    }


def ensure_tech(page, mode, sel, budget_s=150):
    """技术详情页：确保「技术详情」页签＋指定图 mode 已选中，且目标锚点在场；并发重载时自动重选。"""
    deadline = time.time() + budget_s
    while time.time() < deadline:
        if page.locator(sel).count() > 0:
            return True
        try:
            if page.locator("[data-graph-mode-switch]").count() == 0:
                page.locator('[data-project-view-tab="tech"]').click(timeout=5000)
                page.wait_for_timeout(500)
            page.locator('[data-graph-mode="%s"]' % mode).click(timeout=5000)
        except Exception:  # noqa: BLE001
            try:
                page.wait_for_load_state("domcontentloaded", timeout=10000)
            except Exception:  # noqa: BLE001
                pass
        page.wait_for_timeout(1000)
    return page.locator(sel).count() > 0


def shot(page, name):
    os.makedirs(SHOT_DIR, exist_ok=True)
    path = os.path.join(SHOT_DIR, name)
    page.screenshot(path=path, full_page=False)
    ok(os.path.exists(path) and os.path.getsize(path) > 3000, "截图落盘 %s（%d B）" % (name, os.path.getsize(path)))
    return name


def run_browser(vite_port, backend, readings):
    base = "http://localhost:%d" % vite_port

    # ── 读口先自证：同一份派生模型（服务端）给出期望读数 ──
    _s, bp = backend.api("/api/projects/%s/arch/blueprint" % REAL_ID)
    view = (bp or {}).get("view") or {}
    graph = view.get("graph") or {}
    svc_nodes = len(graph.get("nodes", []))
    svc_edges = len(graph.get("edges", []))
    pv = (bp or {}).get("provenance") or {}
    delivery = (pv.get("delivery") or {})
    info("后端蓝图视图：节点 %d、边 %d；交付结论 %r" % (svc_nodes, svc_edges, delivery.get("conclusion")))
    ok(svc_nodes > 0 and svc_edges > 0, "后端蓝图视图有真实节点/边（%d/%d）" % (svc_nodes, svc_edges))

    _s, df = backend.api("/api/projects/%s/arch/dataflow" % REAL_ID)
    model = (df or {}).get("data_flow") or {}
    ok(bool(model.get("nodes")), "后端数据流向图模型有实体（%d 个）" % len(model.get("nodes", [])))

    # ── 同组关系读口（V09-21 R5）：MCP `get_project_graphs` 的同一份派生，同一隔离 TATAI_HOME 现场取 ──
    intra_read, intra_err = read_intra_counts(backend.home)
    if intra_read is None:
        info("同组关系读口不可读：%s" % intra_err)
    else:
        info(
            "同组关系读口（sixGraphsOf 快照 %s）：functional %s 条、architecture %s 条（截断标记 %s/%s）"
            % (
                intra_read.get("snapshot"),
                intra_read["graphs"]["functional"]["intra"],
                intra_read["graphs"]["architecture"]["intra"],
                intra_read["graphs"]["functional"]["truncated"],
                intra_read["graphs"]["architecture"]["truncated"],
            )
        )

    with sync_playwright() as p:
        launch_kwargs = {"headless": True}
        if BROWSER_CHANNEL:
            launch_kwargs["channel"] = BROWSER_CHANNEL
        browser = p.chromium.launch(**launch_kwargs)
        page = browser.new_context(viewport={"width": 1680, "height": 1050}).new_page()
        page.on("load", lambda _p: NAV_EVENTS.append(time.time()))
        page.goto("%s/#p/%s" % (base, REAL_ID), wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        page.locator('button[data-view="arch"]').click()
        page.wait_for_selector(ROOT, timeout=40000)
        page.wait_for_timeout(2000)

        # ══ 主视图三张 ══
        for idx, viewk in enumerate(["functional", "architecture", "construction"], start=1):
            # 切视图会各取一次自己的模型（异步）：等节点真上屏再读数，避免把「还没渲染完」读成 0；
            # `ensure_view` 另防并发 HMR 的整页重载（重载后重选页签）。
            node_sel = "[data-arch-node]" if viewk == "architecture" else "[data-project-node]"
            ok(ensure_view(page, viewk, node_sel), "主视图屏 %s 页签切到位且节点真上屏（并发重载安全）" % viewk)
            wait_view_nodes(page, viewk, node_sel)
            page.wait_for_timeout(1200)
            cur = attr(page, ROOT, "data-project-view")
            # 架构主视图（V08-06）复用共用方框图渲染器（节点类型 archNode、锚点 data-arch-node）；
            # 另两个主视图走 projectNode（锚点 data-project-node）——按视图各取其实在的节点集
            if viewk == "architecture":
                node_n = page.locator("[data-project-view] [data-arch-node]").count()
            else:
                node_n = page.locator("[data-project-node]").count()
            edge_n = edge_count_main(page)
            q = main_question(page)
            r = {
                "graph": viewk,
                "kind": "main",
                "tab": viewk,
                "question": q,
                "data_project_view_kind": attr(page, ROOT, "data-project-view-kind"),
                "node_count": node_n,
                "edge_count": edge_n,
                "reads": attr(page, ROOT, "data-project-reads"),
                "update_state": attr(page, ROOT, "data-project-update"),
                "update_token": attr(page, ROOT, "data-project-update-token"),
                "delivery": attr(page, ROOT, "data-project-delivery"),
                "delivery_conclusion": attr(page, ROOT, "data-project-delivery-conclusion"),
                "delivery_blocked": attr(page, ROOT, "data-project-delivery-blocked"),
                "source": (
                    "共用方框图渲染器（graphOverride=共用数据层）+ v2 状态投影（架构屏专属：模块/能力派生状态）"
                    if viewk == "architecture"
                    else "已发布蓝图 .工作台/arch/blueprint.json + v2 状态投影（GET /arch/blueprint 同一份）"
                ),
                "screenshot": shot(page, "%02d-%s.png" % (idx, viewk)),
            }
            ok(cur == viewk, "主视图屏 %s：data-project-view=%r" % (viewk, cur))
            ok(node_n > 0, "主视图屏 %s 有节点（%d 个）" % (viewk, node_n))
            ok(
                r["delivery"] is not None and r["update_state"] is not None,
                "主视图屏 %s 带 V09-13 交付阻断读数（%r / %r）与 V09-12 更新状态（%r）"
                % (viewk, r["delivery"], r["delivery_conclusion"], r["update_state"]),
            )
            ok(len(q) > 0, "主视图屏 %s 能读到「这张图回答什么问题」：%s" % (viewk, q[:60]))
            if viewk == "construction":
                # V09-21 R5（2026-09-27）：施工依赖屏**原判据一字不动**——它不分组，同组关系判据不适用。
                ok(edge_n is not None and edge_n > 0, "主视图屏 %s 有边（图例合计 %r）" % (viewk, edge_n))
            else:
                # 定向更新（V09-21 R5，2026-09-27，五要素留档）：主视图「有边（图例合计>0）」→
                #   **同组关系逐条在场 ＋ 与读口同值**（等强替换过期断言，判据不放宽）。
                #   旧期望＝本屏图例逐条 `data-edge-count` 合计 > 0（当时那两屏的同组关系不画连线，
                #          线数合计恒为 0 ⇒ 这条断言跟着口径变更一起过期）。
                #   依据＝DESIGN §3.2「同组关系的可见性」：同一分组内的设计接口等关系**必须在图上
                #          真实可查看、可点开追到来源**，不能只用一段文字解释充数——"线数合计 > 0"
                #          量的是"有没有画线"，不是这条判据；V09-02／V09-13 已把这两屏的裁断转成
                #          `intra_relations`（不画自环、不伪造跨组边，逐条列在分组节点上）。
                #   新期望＝本屏分组节点上的**逐条同组关系**在场，且三处计数逐值相等：
                #          面板 `data-intra-relations-count` ＝ 逐条条目数 `[data-intra-relation]`
                #          ＝ 读口（MCP `get_project_graphs` 的同一份派生 `sixGraphsOf`，同一隔离
                #          TATAI_HOME 现场取）；functional 屏另有分组节点上的可点条目（`data-intra-chip`）
                #          合计也须相等。读口值**动态取**，不钉死数字（随蓝图重派生而变；截断标记须为 0，
                #          否则读口本身不完整）。
                #   保留意图＝原判据守的是"这张主视图上真的画出了东西、不是空图"；现在改成守
                #          **该可见的关系逐条可见、且与读口同源同值**（比"有边>0"更强：线数 0 也能过，
                #          只要有同组关系逐条在场；反之计数不等／条目数不足／读口读不到就判红）。
                #   判据不放宽＝面板缺失、计数不等、逐条条目数与计数不等、分组组数 0、functional 屏
                #          分组节点条目合计不等、读口读不到或结果被截断，任一情形逐条判红。
                scr = intra_counts_on_screen(page, viewk)
                want = ((intra_read or {}).get("graphs") or {}).get(viewk) or {}
                want_n = want.get("intra")
                want_ok = intra_read is not None and want.get("truncated") in (0, None) and isinstance(want_n, int)
                if viewk == "functional":
                    # functional 走 projectNode 渲染器：条目还**逐条挂在分组节点卡片上**（`data-intra-chip`）
                    chips_ok = scr is not None and scr["chip_total"] == want_n
                else:
                    # architecture 屏画布是共用 ArchCanvas（不渲染分组卡片条目），逐条可见由面板承担
                    chips_ok = True
                ok(
                    scr is not None
                    and want_ok
                    and scr["panel_count"] == want_n
                    and scr["entries"] == want_n
                    and scr["groups"] >= 1
                    and chips_ok,
                    "主视图屏 %s 分组节点上的逐条同组关系在场且与读口同值（%s；面板 %s 条 / 逐条条目 %s / "
                    "分组 %s 组 / 分组节点条目 %s 条；读口 %s 条%s）"
                    % (
                        viewk,
                        "R5 等强替换：原「有边（图例合计>0）」→ 同组关系逐条在场＋与读口同值",
                        (scr or {}).get("panel_count"),
                        (scr or {}).get("entries"),
                        (scr or {}).get("groups"),
                        (scr or {}).get("chip_total"),
                        want_n if want_ok else "不可读（%s）" % intra_err,
                        "" if viewk == "functional" else "；本屏由面板逐条承担（共用画布不渲染分组卡片条目）",
                    ),
                )
                r["intra_relations"] = scr
                r["intra_relations_read_port"] = want
                r["edge_count_note"] = (
                    "本屏同组关系不画连线（不画自环、不伪造跨组边）；`edge_count` 只计可见连线，"
                    "保留供参考，不再是本屏判据（§3.2 同组关系可见性）"
                )
                # ── 同组关系**实际可达性**（2026-10-08 v0909-final-review）──
                # 旧期望（v0909-real）＝「IntraRelationPanel 的 summary 本体默认可见」并如实判红，定性为
                #   「产品回归」。五要素留档与依据见 `probe_intra_reachability` 的 docstring：那条断言钉的是
                #   2026-09-27 之前的布局细节，而 2026-10-04 的**已验收 UI 重设计**（git 9df895d ＋
                #   docs/ui-redesign-20261004.md）把画布上方说明块统一收进默认收起的 `.tt-graph-guide`
                #   （summary 一行常显可点），DESIGN §3.11 现行口径也是「默认至多简短一行、详情按需展开」。
                #   所以本检查**换成等强的可达性判据**（不放宽、也不是删除）：
                #     (a) 说明入口默认可见可点；(b) 点开后关系列表逐条完整；(c) 列表条目点开给出可追来源；
                #     (d) functional 屏另有**默认态**可达的画布关系按钮（`data-intra-chip`）能点开显示来源；
                #     (e) 上述展开过程中画布高度不塌。
                reach = stable_probe(page, probe_intra_reachability, viewk)
                r["intra_reachability"] = reach
                ok(
                    reach["guide_summary_present"] and reach["guide_summary_visible_default"],
                    "主视图屏 %s 画布上方说明入口默认可见可点（`.tt-graph-guide > summary`；关系列表由此可达）"
                    % viewk,
                )
                ok(
                    bool(reach.get("guide_open_after_click")) and reach["panel_summary_visible_after_guide"],
                    "主视图屏 %s 外层说明入口可点 → 同组关系面板展开入口到场（open=%s、面板 summary 可见=%s）"
                    % (viewk, reach.get("guide_open_after_click"), reach["panel_summary_visible_after_guide"]),
                )
                ok(
                    reach["panel_entries_after_expand"] == (scr or {}).get("panel_count")
                    and reach["panel_groups_after_expand"] >= 1
                    and (want_ok and reach["panel_entries_after_expand"] == want_n),
                    "主视图屏 %s 关系列表**完整展开**（展开后逐条条目 %s ＝ 面板计数 %s ＝ 读口 %s；分组 %s 组；details.open=%s）"
                    % (
                        viewk,
                        reach["panel_entries_after_expand"],
                        (scr or {}).get("panel_count"),
                        want_n if want_ok else "不可读（%s）" % intra_err,
                        reach["panel_groups_after_expand"],
                        reach.get("panel_fold_open"),
                    ),
                )
                ok(
                    reach.get("panel_fold_open") is True,
                    "主视图屏 %s 点开的确实是**展开**（details[data-intra-relations-fold].open=true，不是把已展开的点关）"
                    % viewk,
                )
                ok(
                    bool((reach.get("relation_trace") or {}).get("ok")),
                    "主视图屏 %s 关系条目点开后给出**可追的具体来源**：%s"
                    % (viewk, (reach.get("relation_trace") or {}).get("detail", "(无)")),
                )
                if viewk == "functional":
                    # (d) 默认画布节点关系按钮可见可点击并显示来源（§3.2 红线的默认态路径）
                    chip_open = reach.get("chip_open") or {}
                    ok(
                        reach["chip_count"] > 0 and reach["chip_visible_index"] is not None,
                        "主视图屏 functional 画布分组节点上的关系按钮**默认可见**（%d 个，其中可见 %s）"
                        % (reach["chip_count"], reach["chip_visible_count"]),
                    )
                    ok(
                        bool(chip_open.get("section_present")) and bool(chip_open.get("section_visible"))
                        and bool(chip_open.get("trace_ok")),
                        "主视图屏 functional 默认态点一下画布关系按钮即显示**该关系的来源**：%s"
                        % (str(chip_open.get("traced_line", ""))[:160] or chip_open.get("error", "(无)")),
                    )
                else:
                    # architecture 屏画布（共用 ArchCanvas）不渲染分组卡片条目：默认可达路径＝说明入口那一条，
                    # 若入口不可点，则本屏没有第二条路 ⇒ 判红（不放宽）。
                    ok(
                        reach["guide_summary_visible_default"] and bool(reach.get("guide_open_after_click")),
                        "主视图屏 %s 无画布内关系按钮，默认可达路径**只有**说明入口——该入口必须默认可点（已核）" % viewk,
                    )
                ok(
                    (reach["canvas_h_after_expand"] or 0) >= 120,
                    "主视图屏 %s 关系展开过程中画布高度不塌（默认 %s px → 说明展开 %s px → 全部展开 %s px；下限 120 px）"
                    % (
                        viewk,
                        reach["canvas_h_default"],
                        reach["canvas_h_guide_open"],
                        reach["canvas_h_after_expand"],
                    ),
                )
                ok(
                    reach["panel_entries_default"] == reach["panel_entries_after_expand"],
                    "主视图屏 %s 关系条目**一个都没丢**（收起态 DOM %s 条 ＝ 展开后 %s 条；收起只改上屏篇幅，§3.11）"
                    % (viewk, reach["panel_entries_default"], reach["panel_entries_after_expand"]),
                )
                # 异常默认可见（§3.11／E.19 第 4 条）：有可行动异常 ⇒ 那一条信息栏的摘要必须默认可见；
                # 健康态 ⇒ 整条不占常驻行（读数在 data-* 里照旧可查）。
                ensure_view(page, viewk, node_sel)  # 探针期间若发生过整页重载，先回到本视图再读
                ev = probe_exception_visibility(page, viewk)
                r["exception_visibility"] = ev
                if ev.get("bar_present"):
                    if ev.get("rows") == "1":
                        ok(bool(ev["summary_visible"]), "主视图屏 %s 有可行动异常时信息栏摘要默认可见：%s" % (viewk, ev["brief"]))
                    elif ev.get("healthy"):
                        ok((ev.get("bar_height") or 0) <= 1, "主视图屏 %s 健康态信息栏不占常驻行（高 %s px）" % (viewk, ev.get("bar_height")))
                    else:
                        ok(False, "主视图屏 %s 信息栏既非「有问题一行」也非健康态（rows=%r、healthy=%r）" % (viewk, ev.get("rows"), ev.get("healthy")))
                else:
                    ok(False, "主视图屏 %s 缺 `data-graph-info-bar` 读数锚点（无法核异常默认可见）" % viewk)
            if viewk == "architecture":
                # 期望定向更新（2026-09-25，review-fix-20260925／H-4 修复；判据**收紧**而非放宽）：
                #   旧期望 = 本屏节点级来源/证据徽标**必定为 0/0**（V09-09 复审当时的如实记录：该屏复用
                #            共用画布时没把 `provenance` 传下去，另两主视图与三技术图都有 ⇒ 记为缺陷 H-4）；
                #   依据   = H-4 已在本批次修复：`ProjectGraphView` 把同一份 `provenance` 传给本屏画布
                #            （并关掉画布自带的那份重复读数盘），缺陷清单的启动条件已满足；
                #   新期望 = 本屏**每个对象节点**都带来源/证据徽标（徽标数 = 节点数 − 聚合节点数；
                #            聚合节点不是可对账对象，它挂的是 `data-arch-aggregate-note` 说明）；
                #   保留意图 = 原记录想守的是"这一屏到底有没有节点级标注"这件事可被机械读出——
                #            现在改成断言它**必须有**，并把聚合节点的例外显式排除（不靠"0 也算过"）。
                sb = page.locator("[data-project-view] [data-arch-source-badge]").count()
                eb = page.locator("[data-project-view] [data-arch-evidence-badge]").count()
                agg_n = page.locator("[data-project-view] [data-arch-aggregate]").count()
                r["node_source_evidence_badges"] = {"source": sb, "evidence": eb, "aggregate_nodes": agg_n}
                ok(sb > 0 and eb > 0 and sb == node_n - agg_n and eb == node_n - agg_n,
                   "架构主视图节点级来源/证据徽标：%d/%d（H-4 已修：节点 %d 个 − 聚合节点 %d 个；"
                   "聚合节点另挂 data-arch-aggregate-note 说明" % (sb, eb, node_n, agg_n))
                info("架构主视图节点级来源/证据徽标：%d/%d（H-4 已修，见 review-fix-20260925/arch-badges）" % (sb, eb))
            readings["graphs"].append(r)

        # 来源与证据标注上屏抽查（V09-13）：主视图画布节点带来源种类与证据状态
        kinds = page.evaluate(
            "Array.from(document.querySelectorAll('[data-project-node]')).map(e => "
            "[e.getAttribute('data-project-node'), e.getAttribute('data-project-source-kind'),"
            " e.getAttribute('data-project-evidence-state')])"
        )
        ok(len(kinds) > 0 and all(k[1] not in (None, "") and k[2] not in (None, "") for k in kinds),
           "V09-13：每个画布节点都带来源种类与证据状态（抽 %d 个：%r）" % (len(kinds), kinds[:3]))

        # ══ 技术详情三张 ══
        page.locator('[data-project-view-tab="tech"]').click()
        page.wait_for_selector("[data-graph-mode-switch]", timeout=30000)
        page.wait_for_timeout(800)

        # 4) 模块方框图
        ok(ensure_tech(page, "MODULE_BOX", '[data-arch-mode="MODULE_BOX"]'), "模块方框图选中且画布在场（并发重载安全）")
        page.wait_for_timeout(2500)
        mb_nodes = page.locator('[data-arch-mode="MODULE_BOX"] .react-flow__node').count()
        r = {
            "graph": "MODULE_BOX",
            "kind": "tech",
            "question": text(page, "[data-mode-question]"),
            "data_arch_mode": attr(page, '[data-arch-mode="MODULE_BOX"]', "data-arch-mode"),
            "node_count": mb_nodes,
            "edge_count": None,
            "source": "静态代码解析 .工作台/arch/modules.json + 蓝图（GET /arch/render，三张技术图共用一份数据层）",
            "screenshot": shot(page, "04-module-box.png"),
        }
        ok(mb_nodes > 0, "模块方框图屏有节点（%d 个）" % mb_nodes)
        ok(len(r["question"]) > 0, "模块方框图屏能读到问题句：%s" % r["question"][:60])
        readings["graphs"].append(r)

        # 5) 数据流向图（V09-11 双口径 + 数据链 + V09-13 阻断）
        # 2026-10-08 现场修正（协议对齐当前 UI，判据不削弱）：点开数据流向图默认落在**「业务数据路径」层**
        # （`data-business-flow`）；「当前实现（静态 import）」口径条与「目标语义」口径条在**「代码引用线索」层**
        # （`FlowLegend` + `TargetSemanticsPanel`）。先如实读业务层，再切代码层跑既有全部断言（双口径、
        # 数据链、覆盖对账、交付阻断、实体/关系）——切层只是到达同一视图的另一层，不改任何判据。
        page.locator('[data-graph-mode="DATA_FLOW"]').click()
        page.wait_for_timeout(1500)
        bus_present = page.locator("[data-business-flow]").count() >= 1
        if not bus_present:
            # 并发 HMR 重载会把视图打回默认态：重建一次再读（不改判据，只是取稳定读数）
            ensure_tech(page, "DATA_FLOW", "[data-business-flow]", budget_s=60)
            page.wait_for_timeout(1200)
            bus_present = page.locator("[data-business-flow]").count() >= 1
        bus_counts = text(page, "[data-business-flow-counts]")
        bus_shot = shot(page, "05b-data-flow-business.png")
        ok(bus_present, "数据流向图双层：默认「业务数据路径」层在（%s）" % bus_counts)
        try:
            page.locator('nav[aria-label="数据流图层"] button', has_text="代码引用线索").click(timeout=8000)
        except Exception:  # noqa: BLE001
            ensure_tech(page, "DATA_FLOW", "[data-business-flow]", budget_s=60)
            try:
                page.locator('nav[aria-label="数据流图层"] button', has_text="代码引用线索").click(timeout=8000)
            except Exception:  # noqa: BLE001
                pass
        # 用 state="attached"：当前 UI 把目标语义/覆盖面板嵌在**默认收起**的 details 内，元素在 DOM 但不可见；
        # 等「可见」会误判超时。这里等挂载，再展开祖先 details 让内容真正上屏（下述断言不变）。
        page.wait_for_selector('[data-flow-legend]', state="attached", timeout=40000)
        page.wait_for_selector("[data-flow-summary]", state="attached", timeout=40000)
        open_ancestor_details(page, "[data-flow-summary]")
        page.wait_for_timeout(1000)
        cur_note = text(page, "[data-flow-current-implementation]")
        tgt_note = text(page, "[data-flow-target-semantics]")
        if cur_note == "" or tgt_note == "":
            # 并发 HMR 重载：重建数据流向图并重切到「代码引用线索」层后再读一次
            ensure_tech(page, "DATA_FLOW", "[data-business-flow]", budget_s=60)
            page.wait_for_timeout(1200)
            try:
                page.locator('nav[aria-label="数据流图层"] button', has_text="代码引用线索").click(timeout=8000)
            except Exception:  # noqa: BLE001
                pass
            try:
                page.wait_for_selector("[data-flow-summary]", state="attached", timeout=30000)
            except Exception:  # noqa: BLE001
                pass
            open_ancestor_details(page, "[data-flow-summary]")
            page.wait_for_timeout(800)
            cur_note = text(page, "[data-flow-current-implementation]")
            tgt_note = text(page, "[data-flow-target-semantics]")
        ok(cur_note != "" and tgt_note != "" and cur_note != tgt_note,
           "数据流向图：V09-11「当前实现」与「目标语义」双口径同时可见且互相区分")
        # 定向更新（2026-10-08，协议对齐当前 UI 文案；判据不放宽）：旧断言钉「静态 import」字面；现 UI 的
        # 「当前实现」口径条（`data-flow-current-implementation`）文案改为「当前画布展示代码之间的引用关系，
        # 不代表业务数据已经流通」。保留意图不变——该口径条必须**同时**点名「这是代码引用/静态依赖层」且
        # 「不是业务数据流」；两层语义缺一即判红（判据不放宽，只把过期字面换成同义的可核语义）。
        ok(("代码" in cur_note or "静态" in cur_note or "引用" in cur_note) and "业务数据" in cur_note,
           "「当前实现」点名代码引用（静态依赖）层、且声明不代表业务数据流")
        ok(all(k in tgt_note for k in ["输入源", "处理节点", "存储", "输出/外部系统"]),
           "「目标语义」点名四类实体")
        ok(page.locator("[data-flow-chain]").count() >= 1,
           "数据流向图屏有端到端数据链面板（%d 条）" % page.locator("[data-flow-chain]").count())
        # 覆盖对账面板现嵌在默认收起的 `data-flow-material-details` 内：像用户那样先展开祖先 details 再点开。
        open_ancestor_details(page, "details[data-flow-coverage]")
        try:
            page.locator("details[data-flow-coverage] > summary").first.click(timeout=8000)
        except Exception:  # noqa: BLE001
            pass
        page.wait_for_timeout(400)
        cov_rows = page.locator("[data-flow-coverage-row]").count()
        blocked_flag = attr(page, "[data-flow-blocked]", "data-flow-blocked")
        flow_nodes = page.locator("[data-flow-node]").count()
        flow_edges = page.locator("[data-flow-edge]").count()
        r = {
            "graph": "DATA_FLOW",
            "kind": "tech",
            "question": text(page, "[data-mode-question]"),
            "data_arch_mode": attr(page, '[data-arch-mode="DATA_FLOW"]', "data-arch-mode"),
            "node_count": flow_nodes,
            "edge_count": flow_edges,
            "coverage_rows": cov_rows,
            "deliverable_blocked": blocked_flag,
            "missing_paths": (model.get("coverage") or {}).get("missing_paths"),
            "business_layer_present": bus_present,
            "business_layer_counts": bus_counts,
            "current_implementation_note": cur_note[:200],
            "target_semantics_note": tgt_note[:200],
            "source": "目标语义层 GET /arch/dataflow（设计声明 + 代码线索 + 测试证据三档出处）；画布＝静态 import 依赖层",
            "screenshot": shot(page, "05-data-flow.png"),
        }
        ok(flow_nodes > 0 and flow_edges > 0, "数据流向图屏目标语义有实体/关系（%d/%d）" % (flow_nodes, flow_edges))
        ok(cov_rows > 0, "数据流向图屏覆盖对账逐条在场（%d 行）" % cov_rows)
        ok(blocked_flag in ("true", "false"),
           "数据流向图屏带交付阻断读数（data-flow-blocked=%r；真实项目当前＝%s）"
           % (blocked_flag, "阻断（intent.json 缺路径）" if blocked_flag == "true" else "未阻断"))
        readings["graphs"].append(r)
        try:
            page.locator("details[data-flow-coverage] > summary").first.click(timeout=5000)
        except Exception:  # noqa: BLE001
            pass
        page.wait_for_timeout(300)

        # 6) 思维导图
        # 当前 UI：markmap 由懒加载 + 共用数据层构建，元素在 DOM 挂载后才可见（大图构建更久）。
        # 用 state="attached" 等挂载，超时放宽到 120s（不钉死「可见」以免把慢构建误判为超时）；
        # 并发 HMR 重载会让 markmap 构建白做——最多重建两次（判据不变，只是取稳定读数）。
        mm_nodes = mm_depth = mm_mm = None
        for _try in range(3):
            page.locator('[data-graph-mode="MIND_MAP"]').click()
            try:
                page.wait_for_selector("[data-mindmap-source]", state="attached", timeout=120000)
            except Exception:  # noqa: BLE001
                # 整页重载：重建技术详情页签与 mode 再等一次
                ensure_tech(page, "MIND_MAP", "[data-mindmap-source]", budget_s=120)
            page.wait_for_timeout(2500)
            mm_nodes = attr(page, "[data-mindmap-source]", "data-mindmap-nodes")
            mm_depth = attr(page, "[data-mindmap-source]", "data-mindmap-depth")
            mm_mm = attr(page, "[data-mindmap-source]", "data-mindmap-mm-nodes")
            if mm_nodes not in (None, ""):
                break
        r = {
            "graph": "MIND_MAP",
            "kind": "tech",
            "question": text(page, "[data-mode-question]"),
            "node_count": int(mm_nodes) if mm_nodes not in (None, "") else None,
            "edge_count": None,
            "mindmap_depth": mm_depth,
            "mindmap_markmap_nodes": mm_mm,
            "source": "共用数据层（GET /arch/render，selectGraph=MIND_MAP）+ markmap 渲染",
            "screenshot": shot(page, "06-mind-map.png"),
        }
        ok(r["node_count"] is not None and r["node_count"] > 0, "思维导图屏有节点（%r，深度 %r）" % (mm_nodes, mm_depth))
        readings["graphs"].append(r)

        browser.close()


def main():
    os.makedirs(SHOT_DIR, exist_ok=True)
    home_before = tree_fingerprint(REAL_HOME)
    info("真实 ~/.tatai 指纹（前）：%d 文件 / %s…" % (home_before["files"], home_before["hash"][:12]))

    tmp = tempfile.mkdtemp(prefix="tatai-v0909ui-")
    home = os.path.join(tmp, "home")
    os.makedirs(home, exist_ok=True)
    # 全局数据目录 = 真实 ~/.tatai 的只读拷贝（含真实注册表；读的是真实项目数据，写入落在临时区）
    for name in ("registry.json", "config.json", "agents.json"):
        src = os.path.join(REAL_HOME, name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(home, name))
    if not os.path.exists(os.path.join(home, "registry.json")):
        write(os.path.join(home, "registry.json"),
              json.dumps({"version": 1, "projects": [
                  {"id": REAL_ID, "name": "塔台", "path": REPO, "kind": "fullstack", "self_managed": True,
                   "registered_at": "2026-09-24T00:00:00+08:00", "last_opened_at": "2026-09-24T00:00:00+08:00"}]},
                  ensure_ascii=False, indent=2) + "\n")

    readings = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "project": REAL_ID,
                "graphs": [], "real_home_before": {k: v for k, v in home_before.items() if k != "sizes"}}
    backend = None
    vite = None
    try:
        if port_busy(VITE_PORT):
            print("[ui] FAIL vite %d 已被占用：本脚本不抢端口（先停掉占用者再跑）" % VITE_PORT)
            sys.exit(1)
        port = free_port()
        backend = Backend(home, port, os.path.join(EVID, "ui-backend.log"))
        backend.wait_health()
        info("后端就绪：127.0.0.1:%d（TATAI_HOME=%s）" % (port, home))
        vite = start_vite(VITE_PORT, port, os.path.join(EVID, "ui-vite.log"),
                          cache_dir=os.path.join(tmp, "vite-cache"))
        info("vite 就绪：http://localhost:%d" % VITE_PORT)
        run_browser(VITE_PORT, backend, readings)
    except Exception as e:  # noqa: BLE001
        ok(False, "运行期出错：%s" % e)
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
        home_after = tree_fingerprint(REAL_HOME)
        # 零写入自证（精确化，2026-10-08）：并发运行的**真实服务**（本机 127.0.0.1:8787）
        # 持续追加它自己的 `~/.tatai/logs/backend.log`，与本文本脚本无关；把它作为**已知外部写者**单列，
        # 其余任何文件变化照判红（不因日志变动放过真实写入）。
        EXTERNAL_WRITERS = {"logs/backend.log"}
        before_sizes = home_before.get("sizes", {})
        after_sizes = home_after.get("sizes", {})
        changed = sorted(
            k for k in set(before_sizes) | set(after_sizes)
            if before_sizes.get(k) != after_sizes.get(k)
        )
        unexpected = [k for k in changed if k not in EXTERNAL_WRITERS]
        readings["real_home_after"] = {k: v for k, v in home_after.items() if k != "sizes"}
        readings["real_home_changed"] = changed
        readings["real_home_external_writers"] = sorted(EXTERNAL_WRITERS)
        ok(
            len(unexpected) == 0,
            "零写入自证：真实 ~/.tatai 除并发服务自写的 %s 外未被本脚本改动（变更=%s）"
            % (sorted(EXTERNAL_WRITERS), changed or "无"),
        )
        readings["summary"] = {"graphs": len(readings["graphs"]), "pass": passes[0], "fail": len(fails)}
        try:
            with open(READINGS, "w", encoding="utf-8", newline="\n") as f:
                f.write(json.dumps(readings, ensure_ascii=False, indent=2) + "\n")
            print("[ui] 读数落 %s" % READINGS)
        except Exception as e:  # noqa: BLE001
            print("[ui] 读数落盘失败：%s" % e)
        if os.environ.get("V0909_KEEP_TMP") != "1":
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            info("保留现场：%s" % tmp)

    print("[ui] V09-09 ①：%d PASS / %d FAIL" % (passes[0], len(fails)))
    if fails:
        print("[ui] 存在 FAIL")
        for f in fails:
            print("[ui]   FAIL " + f)
        sys.exit(1)
    print("[ui] 全部 PASS")


if __name__ == "__main__":
    main()
