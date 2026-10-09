#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-20 UI 真机验证：六图「简短默认态＋按需详情」、详情不吃画布、下钻控件可达性。

用法：python scripts/verify-v09-20-ui.py
      （V0920_SHOT_DIR 换输出目录、V0920_KEEP_TMP=1 保留现场）

为什么必须跑真浏览器（PLAN V09-20 检查项 ①②④⑤）：
  · ①「默认态只一行」是**上屏**口径——真 DOM 里读 `<summary>` 的可见文字才算数；
  · ④「详情展开后画布保留可操作空间」是**布局**口径——只有真浏览器量出的
    `[data-project-canvas-host]` / `[data-arch-view]` 高度与节点可点性才算数；
  · ⑤「下钻控件人能用鼠标点到」——用**真实屏幕坐标**发鼠标事件并核 `elementFromPoint`；
    `locator.click` 会自动滚动/自动等待，成功本身**不作为**人的可用性证明（用户明确要求）。

隔离口径（AGENTS.md §5）：真后端 + 真 vite 全走动态空闲端口；数据目录 = 真实 `~/.tatai` 的
临时只读拷贝（读的是真项目 D:\\tatai 的真实 `.工作台`，写口落在临时区）；全程只读浏览；
收尾杀净两端、删临时目录；另记 `~/.tatai` 与真实 `events.jsonl` 的首尾指纹自证零写入。
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
OUT = os.environ.get("V0920_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "V09-20", "1", "ui"))
KEEP = os.environ.get("V0920_KEEP_TMP") == "1"
REAL_HOME = os.path.join(os.path.expanduser("~"), ".tatai")
PROJECT = "tatai"
SIZES = [(1280, 800), (1600, 950), (1920, 1080)]

VIEWS = [
    ("functional", "main", "功能全景"),
    ("architecture", "main", "系统架构"),
    ("construction", "main", "施工依赖"),
    ("MODULE_BOX", "tech", "模块方框图"),
    ("DATA_FLOW", "tech", "数据流向图"),
    ("MIND_MAP", "tech", "思维导图"),
]
READOUT_SEL = {
    "functional": '[data-project-view="functional"] [data-delivery-readout]',
    "architecture": '[data-project-view="architecture"] [data-delivery-readout]',
    "construction": '[data-project-view="construction"] [data-delivery-readout]',
    "MODULE_BOX": '[data-delivery-readout="tech-MODULE_BOX"]',
    "DATA_FLOW": '[data-delivery-readout="tech-DATA_FLOW"]',
    "MIND_MAP": '[data-delivery-readout="mindmap"]',
}
CANVAS_SEL = {
    "functional": '[data-project-view="functional"] [data-project-canvas-host]',
    "architecture": '[data-project-view="architecture"] [data-project-canvas-host]',
    "construction": '[data-project-view="construction"] [data-project-canvas-host]',
    "MODULE_BOX": "[data-arch-view]",
    "DATA_FLOW": "[data-arch-view]",
    "MIND_MAP": "[data-mindmap-view]",
}
TECH_VIEWS = ("MODULE_BOX", "DATA_FLOW")

passes = [0]
fails = []


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


def http(url, timeout=180):
    req = urllib.request.Request(url, method="GET")
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


def file_sha256(path):
    if not os.path.isfile(path):
        return "n/a"
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def tree_fingerprint(root, limit=3000):
    rows = []
    if not os.path.isdir(root):
        return {"files": 0, "hash": "n/a"}
    for cur, _dirs, files in os.walk(root):
        for name in sorted(files):
            p = os.path.join(cur, name)
            rows.append("%s\t%d" % (os.path.relpath(p, root).replace("\\", "/"), os.path.getsize(p)))
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

    def api(self, path):
        return http("http://127.0.0.1:%d%s" % (self.port, path))

    def wait_health(self, timeout=180):
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
    deadline = time.time() + 150
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


BOX_JS = """(sel) => { const e = document.querySelector(sel); if (!e) return null;
  const r = e.getBoundingClientRect();
  return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; }"""

DRILL_JS = """(id) => {
  const host = document.querySelector('[data-arch-view]');
  if (!host) return null;
  const el = host.querySelector('.react-flow__node[data-id="' + id + '"] [data-expand-toggle]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  const t = hit ? hit.closest('[data-expand-toggle]') : null;
  const c = host.getBoundingClientRect();
  const vp = document.querySelector('.react-flow__viewport');
  return {x: r.x, y: r.y, w: r.width, h: r.height, cx: cx, cy: cy,
          hit: t ? t.getAttribute('data-expand-toggle') : (hit ? hit.tagName : 'none'),
          canvas: {x: c.x, y: c.y, w: c.width, h: c.height},
          transform: vp ? getComputedStyle(vp).transform : ''};
}"""


def open_view(page, name, kind):
    if kind == "main":
        page.locator('[data-project-view-tab="%s"]' % name).click()
    else:
        page.locator('[data-project-view-tab="tech"]').click()
        page.wait_for_selector("[data-graph-mode-switch]", timeout=30000)
        page.locator('[data-graph-mode="%s"]' % name).click()
    page.wait_for_timeout(2200)


def read_port(backend):
    """现取读口读数（按页/按尺寸重取：长跑期间源变会触发图重建，取一次用到底会假红）。"""
    _s, bp = backend.api("/api/projects/%s/arch/blueprint" % PROJECT)
    pv = (bp or {}).get("provenance") or {}
    delivery = pv.get("delivery") or {}
    return {
        "verdict": delivery.get("verdict"),
        "conclusion": delivery.get("conclusion"),
        "counts": ",".join("%s=%s" % (k, v) for k, v in (delivery.get("counts") or {}).items()),
        "reasons": len(delivery.get("reasons") or []),
        "user_pending": len(delivery.get("user_pending") or []),
    }


def check_page(page, name, kind, size, rec, read_fn):
    rsel = READOUT_SEL[name]
    csel = CANVAS_SEL[name]
    if page.locator(rsel).count() == 0:
        ok(False, "%s/%s 找不到本页自己的交付读数盘（%s）" % (name, size, rsel))
        return
    summary = page.evaluate(
        "(sel) => { const s = document.querySelector(sel + ' summary');"
        " return s ? s.innerText.replace(/\\s+/g,' ').trim() : null; }",
        rsel,
    )
    rec["summary_default"] = summary
    verdict_attr = page.get_attribute(rsel, "data-delivery-verdict")
    conclusion_attr = page.get_attribute(rsel, "data-delivery-conclusion")
    rec["readout_attrs"] = {
        "verdict": verdict_attr,
        "conclusion": conclusion_attr,
        "reasons": page.get_attribute(rsel, "data-delivery-reasons"),
        "user_pending": page.get_attribute(rsel, "data-delivery-user-pending"),
        "counts": page.get_attribute(rsel, "data-delivery-counts"),
    }
    # ── ① 默认态：一行、含结论、异常/待办可见、不含五档图例与长解释 ──
    # 2026-10-06 定向更新（五要素留档）：
    #   旧期望＝可见摘要里**逐字**出现 `data-delivery-conclusion` 的原文（如「不可判定项目可交付」）｜
    #   依据＝本卡追加段（2026-09-27 用户指令）定的现行口径就是**白话摘要**：信息区默认只给一行白话，
    #     正式结论仍以机器可读的 `data-delivery-conclusion` 属性在场（`ProvenancePanel.tsx:170`
    #     ＋同处 201 行 `data-delivery-conclusion-badge`），展示时按 `ProvenancePanel.tsx:38` 的
    #     白话映射表翻译（「不可判定项目可交付」→「还不能确认已做好」）——原文比对自该口径落地起
    #     必然不成立，本步从未真正跑过｜
    #   新期望＝可见摘要必须给出与结论**对应**的白话结论；映射表由测试自己持有（不 import 产品代码，
    #     免得拿产品对着产品验），**未知结论值仍按原文比对**（新出现的口径不放过）｜
    #   保留意图＝「默认摘要必须给出结论、不得被读成已验收」一条不动（下一条仍钉「阻断 N 项」/「尚未验收」）｜
    #   判据不放宽＝仍是**可见文字里的精确子串相等**，只把展示口径换成同义白话；并且空结论值仍判红
    #     （不许退化成"有字就算"）。
    PLAIN_CONCLUSION = {"不可判定项目可交付": "还不能确认已做好"}
    expected_conclusion = PLAIN_CONCLUSION.get(conclusion_attr or "", conclusion_attr or "")
    ok(bool(summary) and expected_conclusion != "" and expected_conclusion in (summary or ""),
       "%s/%s 默认摘要给出结论「%s」（白话口径 %r）（%r）" % (name, size, conclusion_attr, expected_conclusion, summary))
    blocked = verdict_attr == "blocked"
    ok(("阻断" in (summary or "")) if blocked else ("尚未验收" in (summary or "")),
       "%s/%s 默认摘要%s" % (name, size,
                             "给出阻断条数（异常默认可见）" if blocked else "必带「尚未验收」限定（防读成已验收）"))
    chips_in_summary = page.locator(rsel + " summary [data-delivery-state-chip]").count()
    legend_in_summary = page.locator(rsel + " summary [data-delivery-state-legend]").count()
    reaasons_in_summary = page.locator(rsel + " summary [data-delivery-reason]").count()
    pending_in_summary = page.locator(rsel + " summary [data-delivery-pending]").count()
    ok(chips_in_summary == 0 and legend_in_summary == 0,
       "%s/%s 默认摘要里**没有**五档图例（chip=%d、legend=%d）" % (name, size, chips_in_summary, legend_in_summary))
    ok(reaasons_in_summary == 0 and pending_in_summary == 0,
       "%s/%s 默认摘要里**没有**逐条名单（reasons=%d、pending=%d）" % (name, size, reaasons_in_summary, pending_in_summary))
    ok("能力分类" not in (summary or "") and "不代签" not in (summary or ""),
       "%s/%s 默认摘要里没有能力分类长解释与常显「不代签」说明（%r）" % (name, size, summary))
    ok(len(summary or "") <= 140, "%s/%s 默认摘要长度 %d 字（≤140）" % (name, size, len(summary or "")))
    # ── ④ 详情展开：画布高度不变、>0、可滚动、可关闭 ──
    panel_before = page.evaluate(BOX_JS, rsel)
    canvas_before = page.evaluate(BOX_JS, csel)
    rec["panel_default"] = panel_before
    rec["canvas_default"] = canvas_before
    ok(canvas_before is not None and canvas_before["h"] > 0,
       "%s/%s 默认态画布高度 %s > 0" % (name, size, canvas_before and canvas_before["h"]))
    page.locator(rsel + " [data-delivery-expand]").first.click()
    page.wait_for_timeout(450)
    panel_after = page.evaluate(BOX_JS, rsel)
    canvas_after = page.evaluate(BOX_JS, csel)
    rec["panel_expanded"] = panel_after
    rec["canvas_expanded"] = canvas_after
    rec["detail_body"] = page.evaluate(BOX_JS, rsel + " [data-delivery-detail-body]")
    rec["detail_scroll"] = page.evaluate(
        """(sel) => { const b = document.querySelector(sel + ' [data-delivery-detail-body]');
             return b ? {scrollH: b.scrollHeight, clientH: b.clientHeight, canScroll: b.scrollHeight > b.clientHeight} : null; }""",
        rsel)
    ok(canvas_after is not None and canvas_after["h"] > 0,
       "%s/%s 详情展开后画布高度 %s > 0（不再被压成 0）" % (name, size, canvas_after and canvas_after["h"]))
    ok(canvas_before is not None and canvas_after is not None and canvas_after["h"] == canvas_before["h"],
       "%s/%s 详情展开**不改画布高度**（%s → %s：详情是浮层）"
       % (name, size, canvas_before and canvas_before["h"], canvas_after and canvas_after["h"]))
    ok(panel_after is not None and panel_after["h"] == (panel_before or {}).get("h"),
       "%s/%s 面板自身高度不因展开而长高（%s → %s）"
       % (name, size, (panel_before or {}).get("h"), panel_after and panel_after["h"]))
    sc = rec["detail_scroll"]
    ok(sc is not None and sc["clientH"] > 0 and sc["canScroll"],
       "%s/%s 详情内部独立滚动（scrollH=%s > clientH=%s）" % (name, size, sc and sc["scrollH"], sc and sc["clientH"]))
    # ── ② 收起≠删数据：逐条证据完整在场 ──
    reasons_attr = int(page.get_attribute(rsel, "data-delivery-reasons") or 0)
    pending_attr = int(page.get_attribute(rsel, "data-delivery-user-pending") or 0)
    n_reasons = page.locator(rsel + " [data-delivery-reason]").count()
    n_pending = page.locator(rsel + " [data-delivery-pending]").count()
    chips = page.locator(rsel + " [data-delivery-state-legend] [data-delivery-state-chip]").count()
    chips_visible = page.evaluate(
        """(sel) => { let n = 0; const cs = document.querySelectorAll(sel + ' [data-delivery-state-legend] [data-delivery-state-chip]');
             for (const c of cs) { const r = c.getBoundingClientRect(); if (r.width > 0 && r.height > 0) n++; } return n; }""",
        rsel)
    rec["reasons"] = [reasons_attr, n_reasons]
    rec["pending"] = [pending_attr, n_pending]
    rec["chips"] = [chips, chips_visible]
    ok(n_reasons == reasons_attr, "%s/%s 展开后逐条阻断原因一条不少（属性 %d / DOM %d）" % (name, size, reasons_attr, n_reasons))
    ok(n_pending == pending_attr, "%s/%s 展开后逐条人工待验一条不少（属性 %d / DOM %d）" % (name, size, pending_attr, n_pending))
    ok(chips == 6 and chips_visible == 6,
       "%s/%s 展开后五档图例（＋未映射）6 个 chip 全部可见" % (name, size))
    readings = read_fn() if read_fn is not None else None
    if readings is not None:
        ok(rec["readout_attrs"]["verdict"] == readings.get("verdict")
           and rec["readout_attrs"]["counts"] == readings.get("counts"),
           "%s/%s 界面读数与读口同源（verdict/counts 逐值一致；读口现取）" % (name, size))
    page.screenshot(path=os.path.join(OUT, "%s-%s-expanded.png" % (size, name)))
    # 关闭
    page.locator(rsel + " [data-delivery-detail-close]").first.click()
    page.wait_for_timeout(300)
    still = page.evaluate("(sel) => { const d = document.querySelector(sel + ' details'); return d ? d.open : null; }", rsel)
    canvas_closed = page.evaluate(BOX_JS, csel)
    nodes = page.locator(csel + " .react-flow__node").count()
    rec["canvas_after_close"] = canvas_closed
    rec["nodes_after_close"] = nodes
    ok(still is False, "%s/%s 详情可关闭" % (name, size))
    ok(canvas_closed is not None and canvas_closed["h"] == (canvas_before or {}).get("h"),
       "%s/%s 关闭后画布高度回到原值（%s）" % (name, size, canvas_closed and canvas_closed["h"]))
    page.screenshot(path=os.path.join(OUT, "%s-%s-default.png" % (size, name)))


def drill(page, rec):
    """scripts → scripts-lib 下钻：真实屏幕坐标 + elementFromPoint + 命中区尺寸。"""
    page.locator('button[data-view="arch"]').click()
    page.wait_for_selector("[data-arch-tab]", timeout=30000)
    page.wait_for_timeout(1200)
    # 与技术详情页签同一路径进入模块方框图（与上面逐页检查走同一个 open_view，避免两套进入方式）
    open_view(page, "MODULE_BOX", "tech")
    page.wait_for_selector("[data-arch-view] .react-flow__node", state="attached", timeout=30000)
    page.wait_for_timeout(1500)
    seq = []
    for step, target in enumerate(["audit", "scripts", "scripts-lib"]):
        d = page.evaluate(DRILL_JS, target)
        if d is None:
            seq.append({"step": step, "target": target, "found": False})
            ok(False, "下钻第 %d 步：画布上找不到 %s 的展开钮" % (step, target))
            break
        inside = (d["canvas"]["x"] <= d["x"] and d["canvas"]["y"] <= d["y"]
                  and d["x"] + d["w"] <= d["canvas"]["x"] + d["canvas"]["w"]
                  and d["y"] + d["h"] <= d["canvas"]["y"] + d["canvas"]["h"])
        entry = {"step": step, "target": target,
                 "toggle_box": {k: round(d[k], 2) for k in ("x", "y", "w", "h")},
                 "click_point": [round(d["cx"], 1), round(d["cy"], 1)],
                 "elementFromPoint": d["hit"], "inside_canvas": inside,
                 "viewport_transform": d["transform"]}
        ok(inside, "下钻第 %d 步：%s 的展开钮整体落在画布内（屏幕坐标 x=%.1f y=%.1f）" % (step, target, d["x"], d["y"]))
        ok(d["w"] >= 18 and d["h"] >= 18,
           "下钻第 %d 步：%s 的展开钮**屏幕命中区** %.2f×%.2f px（≥18，不随缩放缩到亚像素）"
           % (step, target, d["w"], d["h"]))
        ok(d["hit"] == target,
           "下钻第 %d 步：该点的 elementFromPoint 就是 %s 的展开钮（%r）" % (step, target, d["hit"]))
        page.mouse.click(d["cx"], d["cy"])
        page.wait_for_timeout(3000)
        entry["nodes_after"] = page.locator("[data-arch-view] .react-flow__node").count()
        entry["zoom_after"] = page.evaluate(
            "() => { const vp = document.querySelector('.react-flow__viewport');"
            " if (!vp) return null; const m = new DOMMatrix(getComputedStyle(vp).transform); return m.a; }")
        ok(entry["nodes_after"] > 7, "下钻第 %d 步：点了 %s 之后画布节点数增长到 %d" % (step, target, entry["nodes_after"]))
        page.screenshot(path=os.path.join(OUT, "drill-step%d-%s.png" % (step, target)))
        seq.append(entry)
    rec["drill"] = seq


def main():
    tmp = tempfile.mkdtemp(prefix="tatai-v0920ui-")
    home = os.path.join(tmp, "home")
    shutil.copytree(REAL_HOME, home)
    os.makedirs(OUT, exist_ok=True)
    home_before = tree_fingerprint(REAL_HOME)
    events = os.path.join(REPO, ".工作台", "work", "events.jsonl")
    events_before = file_sha256(events)
    info("真实 ~/.tatai 指纹（前）：%d 文件 / %s…" % (home_before["files"], home_before["hash"][:12]))
    info("真实 events.jsonl sha256（前）：%s…" % events_before[:16])

    backend_port = free_port()
    vite_port = free_port()
    backend = None
    vite = None
    rec_root = []
    readings = None
    drill_rec = {}
    try:
        backend = Backend(home, backend_port, os.path.join(OUT, "ui-backend.log"))
        backend.wait_health()
        info("后端就绪 127.0.0.1:%d（TATAI_HOME=%s）" % (backend_port, home))
        vite = start_vite(vite_port, backend_port, os.path.join(OUT, "ui-vite.log"))
        info("vite 就绪 http://localhost:%d" % vite_port)
        read_fn = lambda: read_port(backend)  # noqa: E731 —— 每页现取，避免长跑期间图重建造成假红
        readings = read_fn()
        info("读口读数（脚本开始时）：%s" % json.dumps(readings, ensure_ascii=False))
        ok(readings["verdict"] in ("blocked", "requestable"),
           "读口给出交付结论「%s」（verdict=%s）" % (readings["conclusion"], readings["verdict"]))

        # 逐页 + 三档窗口
        base = "http://localhost:%d" % vite_port
        with sync_playwright() as p:
            for w, h in SIZES:
                size = "%dx%d" % (w, h)
                browser = p.chromium.launch(headless=True)
                try:
                    page = browser.new_context(viewport={"width": w, "height": h}).new_page()
                    page.goto("%s/#p/%s" % (base, PROJECT), wait_until="domcontentloaded")
                    page.wait_for_timeout(3000)
                    page.locator('button[data-view="arch"]').click()
                    page.wait_for_selector("[data-arch-tab]", timeout=30000)
                    page.wait_for_timeout(1200)
                    for name, kind, label in VIEWS:
                        open_view(page, name, kind)
                        rec = {"view": name, "label": label, "size": size}
                        try:
                            check_page(page, name, kind, size, rec, read_fn)
                        except Exception as e:  # noqa: BLE001
                            ok(False, "%s/%s 检查过程异常：%s" % (name, size, str(e).split("\n")[0]))
                            rec["error"] = str(e).split("\n")[0]
                        rec_root.append(rec)
                        page.goto("%s/#p/%s" % (base, PROJECT), wait_until="domcontentloaded")
                        page.wait_for_timeout(2000)
                        page.locator('button[data-view="arch"]').click()
                        page.wait_for_selector("[data-arch-tab]", timeout=30000)
                        page.wait_for_timeout(900)
                finally:
                    browser.close()
            # ⑤ 下钻可达性（1600×950）
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
                page.goto("%s/#p/%s" % (base, PROJECT), wait_until="domcontentloaded")
                page.wait_for_timeout(3000)
                try:
                    drill(page, drill_rec)
                except Exception as e:  # noqa: BLE001
                    ok(False, "下钻可达性检查过程异常：%s" % str(e).split("\n")[0])
                    drill_rec["error"] = str(e).split("\n")[0]
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
    events_after = file_sha256(events)
    ok(home_before["hash"] == home_after["hash"], "真实 ~/.tatai 零写入（指纹前后一致）")
    ok(events_before == events_after, "真实事件账本 events.jsonl 零写入（sha256 前后一致）")

    with open(os.path.join(OUT, "readings.json"), "w", encoding="utf-8") as f:
        json.dump({"readout": readings, "pages": rec_root, "drill": drill_rec}, f, ensure_ascii=False, indent=2)
    if not KEEP:
        shutil.rmtree(tmp, ignore_errors=True)
    print("\n[ui] V09-20-UI %d PASS / %d FAIL" % (passes[0], len(fails)))
    if fails:
        for x in fails:
            print("[ui]   FAIL " + x)
        sys.exit(1)


if __name__ == "__main__":
    main()
