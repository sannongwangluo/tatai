#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""一次性调试：按 badges-ui 的导航顺序复现「audit 节点点击被同组关系区拦截」。
访问顺序：项目页 → arch 页签 → functional →（600ms+1500ms 节奏）→ architecture → 量 audit 节点矩形/视口/命中。
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
REAL_HOME = os.path.join(os.path.expanduser("~"), ".tatai")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def main():
    tmp = tempfile.mkdtemp(prefix="tatai-dbg-archclick-")
    home = os.path.join(tmp, "home")
    shutil.copytree(REAL_HOME, home)
    out_dir = os.path.join(REPO, ".工作台", "evidence", "V09-21", "1", "probes")
    os.makedirs(out_dir, exist_ok=True)
    backend_port = free_port()
    vite_port = free_port()
    env = dict(os.environ)
    env["TATAI_HOME"] = home
    env["TATAI_PORT"] = str(backend_port)
    backend = subprocess.Popen(
        ["node", "--import", "tsx", os.path.join("src", "server", "index.ts")],
        cwd=REPO, env=env, stdout=open(os.path.join(out_dir, "dbg-backend.log"), "wb"), stderr=subprocess.STDOUT)
    env2 = dict(os.environ)
    env2["TATAI_DEV_API_PORT"] = str(backend_port)
    vite = subprocess.Popen(
        ["node", os.path.join("node_modules", "vite", "bin", "vite.js"), "dev", "--port", str(vite_port), "--strictPort"],
        cwd=REPO, env=env2, stdout=open(os.path.join(out_dir, "dbg-vite.log"), "wb"), stderr=subprocess.STDOUT)
    try:
        deadline = time.time() + 150
        while time.time() < deadline:
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/health" % backend_port, timeout=5):
                    break
            except Exception:
                time.sleep(0.5)
        deadline = time.time() + 150
        while time.time() < deadline:
            try:
                with urllib.request.urlopen("http://localhost:%d/" % vite_port, timeout=5) as r:
                    if r.status == 200:
                        break
            except Exception:
                time.sleep(0.5)
        base = "http://localhost:%d" % vite_port
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
            page.goto("%s/#p/tatai" % base, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            page.locator('button[data-view="arch"]').click()
            page.wait_for_selector("[data-arch-tab]", timeout=30000)
            page.wait_for_timeout(1200)
            # badges-ui 节奏：先 functional 再 architecture
            page.locator('[data-project-view-tab="functional"]').click()
            page.wait_for_timeout(600)
            page.wait_for_timeout(1500)
            page.locator('[data-project-view-tab="architecture"]').click()
            page.wait_for_timeout(600)
            page.wait_for_timeout(1500)
            import json as _j
            for wait_s in (0, 2000, 3000, 3000):
                if wait_s: page.wait_for_timeout(wait_s)
                vp = page.evaluate("""() => { const vp = document.querySelector('[data-project-view="architecture"] .react-flow__viewport'); if (!vp) return null; const m = new DOMMatrix(getComputedStyle(vp).transform); const n = document.querySelector('[data-project-view="architecture"] .react-flow__node[data-id="audit"]'); const r = n ? n.getBoundingClientRect() : null; return {zoom: m.a, tx: m.e, ty: m.f, audit_y: r ? r.y : null}; }""")
                print("sample:", _j.dumps(vp))
            bounds = page.evaluate("""() => {
              const view = document.querySelector('[data-project-view="architecture"]');
              const vp = view.querySelector('.react-flow__viewport');
              const m = new DOMMatrix(getComputedStyle(vp).transform);
              const out = [];
              for (const n of view.querySelectorAll('.react-flow__node')) {
                const r = n.getBoundingClientRect();
                // 反推图坐标：screen = graph*zoom + t + canvasOffset；canvasOffset 用 arch_view 的位置
                out.push({id: n.getAttribute('data-id'), gx: (r.x - m.e)/m.a, gy: (r.y - m.f)/m.a, w: r.width/m.a, h: r.height/m.a});
              }
              // 注意：m.e/m.f 是画布元素内的平移，rect 是页面坐标——差一个画布原点；相对边界不受影响
              const xs = out.map(o=>o.gx), ys = out.map(o=>o.gy);
              return {n: out.length, minX: Math.min(...xs), maxX: Math.max(...xs.map((x,i)=>x+out[i].w)),
                minY: Math.min(...ys), maxY: Math.max(...ys.map((y,i)=>y+out[i].h)),
                sample: out.slice(0,4)};
            }""")
            print("graph-bounds:", __import__('json').dumps(bounds))
            m = page.evaluate("""() => {
              const view = document.querySelector('[data-project-view="architecture"]');
              const host = view.querySelector('[data-project-canvas-host]');
              const archview = view.querySelector('[data-arch-view]');
              const vp = archview ? archview.querySelector('.react-flow__viewport') : null;
              const mm = vp ? new DOMMatrix(getComputedStyle(vp).transform) : null;
              const n = view.querySelector('.react-flow__node[data-id="audit"]');
              const r = n ? n.getBoundingClientRect() : null;
              const cr = archview ? archview.getBoundingClientRect() : null;
              let hit = null;
              if (r) { const h = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2);
                hit = h ? h.tagName + '.' + (h.getAttribute('class')||'').slice(0,60) : 'none'; }
              return {viewport: mm ? {zoom: mm.a, tx: mm.e, ty: mm.f} : null,
                audit_rect: r ? {x: r.x, y: r.y, w: r.width, h: r.height} : null,
                canvas_host: host ? host.getBoundingClientRect().toJSON() : null,
                arch_view: cr ? cr.toJSON() : null,
                arch_view_client: archview ? {w: archview.clientWidth, h: archview.clientHeight} : null,
                hit_at_audit_center: hit};
            }""")
            print(json.dumps(m, ensure_ascii=False, indent=1))
            page.screenshot(path=os.path.join(out_dir, "dbg-arch-click.png"))
            browser.close()
    finally:
        for proc in (vite, backend):
            try:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
                else:
                    proc.kill()
            except Exception:
                pass
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
