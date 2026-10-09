#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""定位探针：谁把主 <g> 写成了 translate(NaN,NaN)。
包 Element.prototype.setAttribute，任何带 NaN 的 transform 写入都记下元素与 JS 栈。
复用 verify-mindmap-geometry.py 的后端/vite/夹具基建（只读复用，不改它）。
用法：python scripts/verify-mindmap-geometry-probe.py [project]
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
spec = importlib.util.spec_from_file_location("mmg", os.path.join(HERE, "verify-mindmap-geometry.py"))
mmg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mmg)

HOOK = r"""
(() => {
  const orig = Element.prototype.setAttribute;
  window.__nanSets = [];
  Element.prototype.setAttribute = function (name, value) {
    try {
      if (String(name) === 'transform' && String(value).indexOf('NaN') >= 0) {
        if (window.__nanSets.length < 8) {
          window.__nanSets.push({
            tag: this.tagName, cls: (this.getAttribute && this.getAttribute('class')) || '',
            value: value.slice(0, 80),
            t: Math.round(performance.now()),
            stack: (new Error()).stack,
          });
        }
      }
    } catch (e) {}
    return orig.call(this, name, value);
  };
})();
"""


def main():
    project = sys.argv[1] if len(sys.argv) > 1 else "mmgeom-empty"
    project2 = sys.argv[2] if len(sys.argv) > 2 else None
    tmp = tempfile.mkdtemp(prefix="tatai-mmprobe-")
    home = os.path.join(tmp, "home")
    shutil.copytree(mmg.REAL_HOME, home)
    os.makedirs(mmg.OUT, exist_ok=True)
    mmg.make_fixture(home, tmp, "mmgeom-single", "单模块夹具",
                     [{"id": "only", "path": "only", "file_count": 3, "deps": []}],
                     disk_files={"only": ["a.ts", "b.ts", "c.ts"]})
    mmg.make_fixture(home, tmp, "mmgeom-empty", "空夹具", [])
    mods = [{"id": "m%02d" % i, "path": "m%02d" % i, "file_count": 3 if i % 2 else 2, "deps": []}
            for i in range(1, 10)]
    mmg.make_fixture(home, tmp, "mmgeom-multi", "多模块夹具", mods)

    bport, vport = mmg.free_port(), mmg.free_port()
    backend = mmg.Backend(home, bport, os.path.join(mmg.OUT, "probe-backend.log"))
    vite = None
    try:
        backend.wait_health()
        vite = mmg.start_vite(vport, bport, os.path.join(mmg.OUT, "probe-vite.log"),
                              os.path.join(tmp, "vite-cache"))
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(headless=True)
            except Exception:
                browser = p.chromium.launch(headless=True, channel="msedge")
            page = browser.new_context(viewport={"width": 1500, "height": 900}).new_page()
            page._vite_port = vport
            page.add_init_script(HOOK)
            console = []
            page.on("console", lambda m: console.append("console.%s: %s" % (m.type, m.text))
                    if m.type in ("error", "warning") else None)
            mmg.open_arch(page, project)
            mmg.open_tech(page, "MIND_MAP")
            page.wait_for_selector("[data-mindmap-view]", timeout=40000)
            page.wait_for_timeout(2500)
            if project2:
                # hash-only 导航 = 应用内换项目（页面不重载）——原报告 NaN 就是这条路径
                n0 = len(console)
                mmg.open_arch(page, project2)
                mmg.open_tech(page, "MIND_MAP")
                page.wait_for_selector("[data-mindmap-view]", timeout=40000)
                page.wait_for_timeout(3000)
                print("[probe] 换项目(%s → %s) 期间 console NaN = %d" % (
                    project, project2, len([c for c in console[n0:] if "NaN" in c])))
            sets = page.evaluate("() => window.__nanSets || []")
            print("[probe] project=%s NaN transform 写入次数（前 8 条）= %d" % (project, len(sets)))
            for s in sets:
                print("  - <%s class=%r> value=%r t=%sms" % (s["tag"], s["cls"], s["value"], s["t"]))
                print("    stack:")
                for line in (s["stack"] or "").splitlines()[:8]:
                    print("      " + line.strip())
            nan = [c for c in console if "NaN" in c]
            print("[probe] console NaN 条数 = %d，示例：%s" % (len(nan), nan[:2]))
            print("[probe] transform = %s" % page.evaluate(
                "() => { const g = document.querySelector('[data-mindmap-svg] > g'); return g ? g.getAttribute('transform') : null; }"))
            browser.close()
    finally:
        try:
            if vite is not None:
                import subprocess
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(vite.pid), "/T", "/F"], capture_output=True)
        except Exception:
            pass
        backend.kill()
        mmg.rmtree_hard(tmp)


if __name__ == "__main__":
    main()
