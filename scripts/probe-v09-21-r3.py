#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-21 R3 修前探针：系统架构主视图布局成因量测（先量后改，只量不断言）。

量测项（对应任务书 R3「先量后改」）：
  · 三档窗口（1280×800/1600×950/1920×1080）下 viewport scale（.react-flow__viewport transform）；
  · 架构视图每个对象节点的渲染矩形（getBoundingClientRect）与节点基础尺寸（offsetWidth/Height）；
  · 画布上方各常显块高度（从 [data-project-view="architecture"] 顶层到 [data-project-canvas-host] 之间逐块量）；
  · 画布宿主高度；
  · 第一个对象节点中心的 elementFromPoint 归属（真实命中）。

输出：.工作台/evidence/V09-21/1/probes/r3-before.json + 截图。隔离口径同 verify-v09-20-ui.py。
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
OUT = os.environ.get("V0921_PROBE_DIR", os.path.join(REPO, ".工作台", "evidence", "V09-21", "1", "probes"))
MODE = os.environ.get("V0921_R3_MODE", "before")  # before=修前量测；after=修后判据（判红 exit 1）
REAL_HOME = os.path.join(os.path.expanduser("~"), ".tatai")
PROJECT = "tatai"
SIZES = [(1280, 800), (1600, 950), (1920, 1080)]


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def http(url, timeout=180):
    req = urllib.request.Request(url, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode("utf-8")


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
            if os.path.basename(p) == "work-service.json":  # R6①同口径：daemon 描述符周转不计入指纹
                continue
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

    def wait_health(self, timeout=180):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("后端进程退出（见 ui-backend.log）")
            try:
                http("http://127.0.0.1:%d/health" % self.port, timeout=5)
                return
            except Exception:
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


MEASURE_JS = """() => {
  const view = document.querySelector('[data-project-view="architecture"]');
  if (!view) return {error: 'no architecture view'};
  const host = view.querySelector('[data-project-canvas-host]');
  const hostRect = host ? host.getBoundingClientRect() : null;
  // 画布上方各常显块：从视图顶层到画布宿主之间的所有兄弟/祖先链块
  const blocks = [];
  if (host) {
    let el = host;
    while (el && el !== view) {
      let sib = el.previousElementSibling;
      while (sib) {
        const r = sib.getBoundingClientRect();
        if (r.height > 0) blocks.push({tag: sib.tagName, cls: (sib.getAttribute('class')||'').slice(0,80),
          dataAttrs: [...sib.attributes].filter(a=>a.name.startsWith('data-')).map(a=>a.name+'='+a.value).join('|').slice(0,120),
          h: Math.round(r.height*10)/10, y: Math.round(r.y*10)/10});
        sib = sib.previousElementSibling;
      }
      el = el.parentElement;
    }
  }
  const vp = view.querySelector('.react-flow__viewport');
  let scale = null;
  if (vp) { const m = new DOMMatrix(getComputedStyle(vp).transform); scale = m.a; }
  const nodes = [];
  for (const n of view.querySelectorAll('.react-flow__node')) {
    const r = n.getBoundingClientRect();
    nodes.push({id: n.getAttribute('data-id'),
      rendered: {x: Math.round(r.x*10)/10, y: Math.round(r.y*10)/10, w: Math.round(r.width*10)/10, h: Math.round(r.height*10)/10},
      base: {w: n.offsetWidth, h: n.offsetHeight},
      classes: (n.getAttribute('class')||'').slice(0,100)});
  }
  // 节点中心命中（第一个对象节点）
  let centerHit = null;
  if (nodes.length > 0) {
    const n0 = nodes[0];
    const cx = n0.rendered.x + n0.rendered.w/2, cy = n0.rendered.y + n0.rendered.h/2;
    const hit = document.elementFromPoint(cx, cy);
    centerHit = {node: n0.id, point: [Math.round(cx), Math.round(cy)],
      hit: hit ? (hit.tagName + '.' + (hit.getAttribute('class')||'').slice(0,60)) : 'none',
      hitDataAttrs: hit ? [...hit.attributes].filter(a=>a.name.startsWith('data-')).map(a=>a.name).join('|') : '',
      hitClosestToggle: hit && hit.closest('[data-expand-toggle]') ? hit.closest('[data-expand-toggle]').getAttribute('data-expand-toggle') : null,
      hitClosestNode: hit && hit.closest('.react-flow__node') ? hit.closest('.react-flow__node').getAttribute('data-id') : null};
  }
  // 重叠遮盖检查：任意两个对象节点渲染矩形不得互相遮盖（盖住中心点）
  let overlaps = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i+1; j < nodes.length; j++) {
    const a = nodes[i].rendered, b = nodes[j].rendered;
    const acx = a.x + a.w/2, acy = a.y + a.h/2;
    if (acx >= b.x && acx <= b.x + b.w && acy >= b.y && acy <= b.y + b.h) overlaps.push([nodes[j].id, 'covers-center-of', nodes[i].id]);
  }
  return {
    canvas: hostRect ? {x: Math.round(hostRect.x), y: Math.round(hostRect.y), w: Math.round(hostRect.width), h: Math.round(hostRect.height)} : null,
    above_blocks: blocks,
    above_total_h: blocks.reduce((a,b)=>a+b.h, 0),
    viewport_scale: scale,
    node_count: nodes.length,
    nodes: nodes,
    center_hit: centerHit,
    center_overlaps: overlaps,
    window: {w: window.innerWidth, h: window.innerHeight},
  };
}"""

CLICK_CHECK_JS = """(nodeId) => {
  const detail = document.querySelector('[data-project-detail]');
  if (!detail) return {opened: false};
  const text = detail.innerText || '';
  const secs = detail.querySelectorAll('[data-detail-section]');
  return {opened: secs.length > 0, section_count: secs.length,
    has_provenance_section: text.includes('来源与证据'),
    placeholder: text.includes('点一个节点'),
    text_head: text.slice(0, 120)};
}"""

STABLE_JS = """() => {
  const view = document.querySelector('[data-project-view="architecture"]');
  if (!view) return null;
  const vp = view.querySelector('.react-flow__viewport');
  const m = vp ? (new DOMMatrix(getComputedStyle(vp).transform)) : null;
  const nodes = [...view.querySelectorAll('.react-flow__node')].map(n => {
    const r = n.getBoundingClientRect(); return n.getAttribute('data-id') + ':' + Math.round(r.x) + ',' + Math.round(r.y);
  }).join('|');
  return (m ? m.a.toFixed(4) + '/' + m.e.toFixed(1) + ',' + m.f.toFixed(1) : 'novp') + '#' + nodes;
}"""


def main():
    tmp = tempfile.mkdtemp(prefix="tatai-v0921-r3probe-")
    home = os.path.join(tmp, "home")
    shutil.copytree(REAL_HOME, home)
    os.makedirs(OUT, exist_ok=True)
    home_before = tree_fingerprint(REAL_HOME)
    events = os.path.join(REPO, ".工作台", "work", "events.jsonl")
    events_before = file_sha256(events)

    backend_port = free_port()
    vite_port = free_port()
    backend = None
    vite = None
    out = {"sizes": {}, "fingerprints": {"home_before": home_before, "events_before": events_before}}
    try:
        backend = Backend(home, backend_port, os.path.join(OUT, "r3-probe-backend.log"))
        backend.wait_health()
        vite = start_vite(vite_port, backend_port, os.path.join(OUT, "r3-probe-vite.log"))
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
                    page.locator('[data-project-view-tab="architecture"]').click()
                    # 等视口稳定（fit 是异步双帧＋有界等待；不等稳就量会量到 fit 前的中间态）
                    last_sig = None
                    for _ in range(40):
                        page.wait_for_timeout(500)
                        sig = page.evaluate(STABLE_JS)
                        if sig is not None and sig == last_sig:
                            break
                        last_sig = sig
                    m = page.evaluate(MEASURE_JS)
                    out["sizes"][size] = m
                    # R3 判据②：真实鼠标点「中心落在画布内且命中自身」的第一个对象节点 → 详情面板含「来源与证据」段
                    canvas = m.get("canvas") or {}
                    pick = None
                    for n in m.get("nodes", []):
                        r = n["rendered"]
                        cx, cy = r["x"] + r["w"] / 2, r["y"] + r["h"] / 2
                        if canvas and canvas["x"] <= cx <= canvas["x"] + canvas["w"] and canvas["y"] <= cy <= canvas["y"] + canvas["h"]:
                            pick = (n, cx, cy)
                            break
                    if pick is not None:
                        n, cx, cy = pick
                        hit = page.evaluate(
                            "(p) => { const h = document.elementFromPoint(p[0], p[1]);"
                            " const t = h && h.closest('[data-expand-toggle]');"
                            " const nd = h && h.closest('.react-flow__node');"
                            " return {toggle: t ? t.getAttribute('data-expand-toggle') : null, node: nd ? nd.getAttribute('data-id') : null}; }",
                            [cx, cy])
                        m["center_hit"] = {"node": n["id"], "point": [round(cx), round(cy)],
                                           "hitClosestToggle": hit.get("toggle"), "hitClosestNode": hit.get("node")}
                        page.mouse.click(cx, cy)
                        page.wait_for_timeout(900)
                        m["click_check"] = page.evaluate(CLICK_CHECK_JS, n["id"])
                    else:
                        m["center_hit"] = None
                        m["click_check"] = {"opened": False, "skipped": "没有任何节点中心落在画布内"}
                    # R3 判据汇总（本尺寸）
                    ch = m.get("center_hit")
                    ws = [n["rendered"]["w"] for n in m.get("nodes", [])]
                    hs = [n["rendered"]["h"] for n in m.get("nodes", [])]
                    m["r3_verdicts"] = {
                        "nodes_min_60x30": bool(ws) and min(ws) >= 60 and min(hs) >= 30,
                        "min_rendered": [min(ws) if ws else None, min(hs) if hs else None],
                        "center_hits_node_not_toggle": bool(ch) and ch.get("hitClosestToggle") is None and ch.get("hitClosestNode") == ch.get("node"),
                        "click_opens_detail_with_provenance": bool(m.get("click_check", {}).get("opened")) and bool(m.get("click_check", {}).get("has_provenance_section")),
                        "canvas_h": (m.get("canvas") or {}).get("h"),
                        "no_center_overlap": len(m.get("center_overlaps", [])) == 0,
                    }
                    page.screenshot(path=os.path.join(OUT, "r3-%s-%s-architecture.png" % (MODE, size)), full_page=False)
                    print("[probe] %s scale=%s nodes=%s canvas=%s above_total=%s verdicts=%s" % (
                        size, m.get("viewport_scale"), m.get("node_count"), m.get("canvas"), m.get("above_total_h"),
                        json.dumps(m["r3_verdicts"], ensure_ascii=False)))
                finally:
                    browser.close()
    finally:
        try:
            if vite is not None and os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(vite.pid), "/T", "/F"], capture_output=True)
            elif vite is not None:
                vite.kill()
        except Exception:
            pass
        if backend is not None:
            backend.kill()

    out["fingerprints"]["home_after"] = tree_fingerprint(REAL_HOME)
    out["fingerprints"]["events_after"] = file_sha256(events)
    out["fingerprints"]["zero_write_ok"] = (
        out["fingerprints"]["home_before"]["hash"] == out["fingerprints"]["home_after"]["hash"]
        and events_before == out["fingerprints"]["events_after"])
    with open(os.path.join(OUT, "r3-%s.json" % MODE), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("[probe] 零写入自证: %s" % out["fingerprints"]["zero_write_ok"])
    all_ok = out["fingerprints"]["zero_write_ok"] and all(
        all(v for k, v in (m.get("r3_verdicts") or {}).items() if k not in ("min_rendered", "canvas_h"))
        for m in out["sizes"].values())
    print("[probe] R3 判据汇总（%s）: %s" % (MODE, "ALL PASS" if all_ok else "HAS FAIL"))
    shutil.rmtree(tmp, ignore_errors=True)
    if MODE == "after" and not all_ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
