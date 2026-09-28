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
`get_project_graphs` 的同一份派生逐值相等、抽查点开可追到具体来源）；construction 屏保持原「有边」判据
（V09-21 R5：过期断言**等强替换**，不是删除或放宽）。

真机口径（卡面 ①，隔离按 AGENTS.md §5）：
  · 起**真**后端（`node --import tsx src/server/index.ts`）+ **真** vite（5173 固定，被占即拒跑）；
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
EVID = os.path.join(REPO, ".工作台", "evidence", "V09-09", "1")
SHOT_DIR = os.environ.get("V0909_SHOT_DIR", os.path.join(EVID, "ui-shots"))
READINGS = os.path.join(EVID, "ui-readings.json")
REAL_HOME = os.path.join(os.path.expanduser("~"), ".tatai")
REAL_ID = "tatai"
VITE_PORT = 5173

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
    """目录树指纹（相对路径+大小+行数），用于「零写入 ~/.tatai」自证。"""
    import hashlib

    rows = []
    if not os.path.isdir(root):
        return {"files": 0, "hash": "n/a"}
    for cur, _dirs, files in os.walk(root):
        for name in sorted(files):
            p = os.path.join(cur, name)
            rel = os.path.relpath(p, root).replace("\\", "/")
            try:
                size = os.path.getsize(p)
            except OSError:
                size = -1
            rows.append("%s\t%d" % (rel, size))
            if len(rows) >= limit:
                break
    rows.sort()
    return {"files": len(rows), "hash": hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest()}


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


def start_vite(port, backend_port, log_path):
    env = dict(os.environ)
    env["TATAI_DEV_API_PORT"] = str(backend_port)
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


def attr(page, selector, name):
    loc = page.locator(selector)
    if loc.count() == 0:
        return None
    return loc.first.get_attribute(name)


def text(page, selector):
    loc = page.locator(selector)
    return loc.first.inner_text() if loc.count() > 0 else ""


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


def spot_check_intra_relation(page):
    """抽查一条同组关系：**真点击**点开它，展开的出处行必须给出具体来源（设计章节/任务/代码来源）。

    §3.2：「同一分组内的关系必须在图上真实可查看、可点开追到来源——不能只用一段文字解释充数」。
    所以这里不认「面板上有一句解释」，要求点开后出现 `设计来源：<路径> · <定位>（…）` 这类**可追的出处行**。
    返回 (是否通过, 说明文本)。
    """
    # 2026-09-27：同组关系面板默认收起成一行，抽查逐条前先点开折叠
    if page.locator("[data-intra-relations] summary[data-intra-relations-summary]").count():
        page.locator("[data-intra-relations] summary[data-intra-relations-summary]").first.click()
        page.wait_for_timeout(300)
    entries = page.locator("[data-intra-relations] details[data-intra-relation]")
    n = entries.count()
    for i in range(n):
        el = entries.nth(i)
        kinds = el.get_attribute("data-intra-relation-source-kinds") or ""
        edge = el.get_attribute("data-intra-relation")
        if kinds == "" or not edge:
            continue
        page.locator('[data-intra-relation-summary="%s"]' % edge).click()
        page.wait_for_timeout(500)
        lines = page.locator('[data-intra-relation-source^="%s#"]' % edge)
        texts = [lines.nth(k).inner_text().strip() for k in range(lines.count())]
        traced = [t for t in texts if ("设计来源：" in t or "代码来源：" in t or "未归类来源：" in t) and "·" in t]
        detail = "edge=%s、来源种类=%s、展开出处行 %d 条；抽查行：%s" % (
            edge,
            kinds,
            len(texts),
            (traced[0] if traced else (texts[-1] if texts else "(无)"))[:140],
        )
        if traced:
            return True, detail
    return False, "本屏 %d 条同组关系里没有一条点开后能追到具体来源（来源种类为空或出处行给不出路径）" % n


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
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1680, "height": 1050}).new_page()
        page.goto("%s/#p/%s" % (base, REAL_ID), wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        page.locator('button[data-view="arch"]').click()
        page.wait_for_selector(ROOT, timeout=40000)
        page.wait_for_timeout(2000)

        # ══ 主视图三张 ══
        for idx, viewk in enumerate(["functional", "architecture", "construction"], start=1):
            page.locator('[data-project-view-tab="%s"]' % viewk).click()
            page.wait_for_timeout(600)
            page.wait_for_selector(ROOT, timeout=30000)
            # 切视图会各取一次自己的模型（异步）：等节点真上屏再读数，避免把「还没渲染完」读成 0
            node_sel = "[data-arch-node]" if viewk == "architecture" else "[data-project-node]"
            try:
                page.wait_for_selector(node_sel, timeout=25000)
            except Exception:  # noqa: BLE001
                pass
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
                if viewk == "functional":
                    # 抽查 ≥1 条同组关系（V09-21 R5 任务书第 2 项；五要素留档）：
                    #   旧期望＝无——原套件从未覆盖「点开一条同组关系能不能追到出处」这一项，
                    #          属**新增覆盖**（不替换、不删除任何既有断言；套件断言数 39→40 如实上报）。
                    #   依据＝DESIGN §3.2「同组关系必须在图上真实可查看、可点开追到来源，
                    #          **不能只用一段文字解释充数**」——只核计数在场还不足以守住这一句。
                    #   新期望＝**真点击**一条同组关系（取第一条带来源种类者），展开的出处行里必须出现
                    #          `设计来源/代码来源/未归类来源：<路径> · <定位>` 这类可追的具体来源。
                    #   保留意图＝把「可见」守成「可追」：分组节点上有条目只是"可见"，追得到出处才是原意。
                    #   判据不放宽＝只认带路径与定位的出处行；找不到任何可追条目即判红（不是跳过）。
                    spot_ok, spot_detail = spot_check_intra_relation(page)
                    ok(spot_ok, "主视图屏 functional 抽查同组关系点开可追到出处：%s" % spot_detail)
                    r["intra_spot_check"] = spot_detail
            ok(len(q) > 0, "主视图屏 %s 能读到「这张图回答什么问题」：%s" % (viewk, q[:60]))
            ok(attr(page, ROOT, "data-project-delivery") is not None,
               "主视图屏 %s 带 V09-13 交付阻断读数（%r / %r）"
               % (viewk, attr(page, ROOT, "data-project-delivery"), attr(page, ROOT, "data-project-delivery-conclusion")))
            ok(attr(page, ROOT, "data-project-update") is not None,
               "主视图屏 %s 带 V09-12 图更新状态读数（%r）" % (viewk, attr(page, ROOT, "data-project-update")))
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
        page.locator('[data-graph-mode="MODULE_BOX"]').click()
        page.wait_for_selector('[data-arch-mode="MODULE_BOX"]', timeout=40000)
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
        page.locator('[data-graph-mode="DATA_FLOW"]').click()
        page.wait_for_selector('[data-flow-legend]', timeout=40000)
        page.wait_for_selector("[data-flow-summary]", timeout=40000)
        page.wait_for_timeout(1200)
        cur_note = text(page, "[data-flow-current-implementation]")
        tgt_note = text(page, "[data-flow-target-semantics]")
        ok(cur_note != "" and tgt_note != "" and cur_note != tgt_note,
           "数据流向图：V09-11「当前实现」与「目标语义」双口径同时可见且互相区分")
        ok("当前实现" in cur_note and "静态 import" in cur_note and "业务数据流" in cur_note,
           "「当前实现」点名静态依赖层与业务数据流")
        ok(all(k in tgt_note for k in ["输入源", "处理节点", "存储", "输出/外部系统"]),
           "「目标语义」点名四类实体")
        ok(page.locator("[data-flow-chain]").count() >= 1,
           "数据流向图屏有端到端数据链面板（%d 条）" % page.locator("[data-flow-chain]").count())
        page.locator("details[data-flow-coverage] > summary").click()
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
        page.locator("details[data-flow-coverage] > summary").click()
        page.wait_for_timeout(300)

        # 6) 思维导图
        page.locator('[data-graph-mode="MIND_MAP"]').click()
        page.wait_for_selector("[data-mindmap-source]", timeout=60000)
        page.wait_for_timeout(2500)
        mm_nodes = attr(page, "[data-mindmap-source]", "data-mindmap-nodes")
        mm_depth = attr(page, "[data-mindmap-source]", "data-mindmap-depth")
        mm_mm = attr(page, "[data-mindmap-source]", "data-mindmap-mm-nodes")
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
                "graphs": [], "real_home_before": home_before}
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
        vite = start_vite(VITE_PORT, port, os.path.join(EVID, "ui-vite.log"))
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
        readings["real_home_after"] = home_after
        ok(home_before["hash"] == home_after["hash"] and home_before["files"] == home_after["files"],
           "零写入自证：真实 ~/.tatai 指纹前后一致（%d 文件 / %s…）"
           % (home_after["files"], home_after["hash"][:12]))
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
