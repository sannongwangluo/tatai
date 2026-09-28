#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-21 R4 探针：模块方框图展开交互（先量/判红 → 修后判绿）。

判据（任务书 R4，真浏览器＋真实屏幕坐标）：
  ① 展开任一模块后，本次新子树的全部节点都在视口内可点（含其展开钮）；
  ② 展开后既有全部可见展开钮的 elementFromPoint 命中自身（抽查 ≥5 个含与新子树相邻者）；
  ③ 布局记忆/拖动/缩放不被抢（E.19）：本探针如实记录展开前后 zoom/translate，供收口核对。

现场：展开顶层模块 `scripts`（它的子级含 scripts-outbox 等目录与一批文件节点）。
输出：.工作台/evidence/V09-21/1/probes/r4-<mode>.json + 截图；mode=after 时判红 exit 1。
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
import urllib.request

from playwright.sync_api import sync_playwright

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT = os.environ.get("V0921_PROBE_DIR", os.path.join(REPO, ".工作台", "evidence", "V09-21", "1", "probes"))
MODE = os.environ.get("V0921_R4_MODE", "before")
REAL_HOME = os.path.join(os.path.expanduser("~"), ".tatai")
PROJECT = "tatai"
SIZE = (1680, 1050)  # 审计实测档位


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


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
            if os.path.basename(p) == "work-service.json":
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
                raise RuntimeError("后端进程退出（见 r4-probe-backend.log）")
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/health" % self.port, timeout=5):
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
            raise RuntimeError("vite 起不来")
        try:
            with urllib.request.urlopen("http://localhost:%d/" % port, timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("vite %d 未就绪" % port)


VIEWPORT_JS = """() => {
  const vp = document.querySelector('[data-arch-view] .react-flow__viewport');
  if (!vp) return null;
  const m = new DOMMatrix(getComputedStyle(vp).transform);
  return {zoom: m.a, tx: m.e, ty: m.f};
}"""

# 展开后量测：新子树节点（ids 传入）逐一枚举矩形＋视口内判定＋展开钮命中；
# 既有可见展开钮抽查（hitself）。
POST_EXPAND_JS = """(childIds) => {
  const host = document.querySelector('[data-arch-view]');
  const rect = host.getBoundingClientRect();
  const nodes = [];
  for (const id of childIds) {
    const el = host.querySelector('.react-flow__node[data-id="' + CSS.escape(id) + '"]');
    if (!el) { nodes.push({id: id, present: false}); continue; }
    const r = el.getBoundingClientRect();
    const tog = el.querySelector('[data-expand-toggle]');
    let toggle = null;
    if (tog) {
      const tr = tog.getBoundingClientRect();
      const cx = tr.x + tr.width/2, cy = tr.y + tr.height/2;
      const hit = document.elementFromPoint(cx, cy);
      const t = hit ? hit.closest('[data-expand-toggle]') : null;
      toggle = {x: Math.round(tr.x*10)/10, y: Math.round(tr.y*10)/10, w: Math.round(tr.width*10)/10, h: Math.round(tr.height*10)/10,
                cx: Math.round(cx), cy: Math.round(cy),
                in_viewport: cx >= rect.left && cx <= rect.right && cy >= rect.top && cy <= rect.bottom,
                hit_self: t ? t.getAttribute('data-expand-toggle') === id : false,
                hit_desc: t ? t.getAttribute('data-expand-toggle') : (hit ? hit.tagName + '.' + (hit.getAttribute('class')||'').slice(0,40) : 'none')};
    }
    nodes.push({id: id, present: true,
      rect: {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)},
      in_viewport: r.left >= rect.left && r.top >= rect.top && r.right <= rect.right && r.bottom <= rect.bottom,
      toggle: toggle});
  }
  // 既有可见展开钮抽查：全部可见 toggle 里取样本（调用方决定要哪几个）
  const allToggles = [];
  for (const t of host.querySelectorAll('[data-expand-toggle]')) {
    const r = t.getBoundingClientRect();
    if (r.width === 0) continue;
    const cx = r.x + r.width/2;
    const cyy = r.y + r.height/2;
    const vis = cx >= rect.left && cx <= rect.right && cyy >= rect.top && cyy <= rect.bottom;
    const hit = document.elementFromPoint(cx, cyy);
    const c = hit ? hit.closest('[data-expand-toggle]') : null;
    allToggles.push({id: t.getAttribute('data-expand-toggle'),
      cx: Math.round(cx), cy: Math.round(cyy), visible_center_in_viewport: vis,
      hit_self: c ? c.getAttribute('data-expand-toggle') === t.getAttribute('data-expand-toggle') : false,
      hit_desc: c ? 'toggle' : (hit ? hit.tagName + '.' + (hit.getAttribute('class')||'').slice(0,40) : 'none'),
      screen_w: Math.round(r.width*10)/10, screen_h: Math.round(r.height*10)/10});
  }
  return {canvas: {x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height)},
          subtree: nodes, toggles: allToggles};
}"""


def main():
    tmp = tempfile.mkdtemp(prefix="tatai-v0921-r4probe-")
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
    out = {"mode": MODE, "fingerprints": {"home_before": home_before, "events_before": events_before}}
    fails = []
    try:
        backend = Backend(home, backend_port, os.path.join(OUT, "r4-probe-backend.log"))
        backend.wait_health()
        vite = start_vite(vite_port, backend_port, os.path.join(OUT, "r4-probe-vite.log"))
        base = "http://localhost:%d" % vite_port
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_context(viewport={"width": SIZE[0], "height": SIZE[1]}).new_page()
                page.goto("%s/#p/%s" % (base, PROJECT), wait_until="domcontentloaded")
                page.wait_for_timeout(3000)
                page.locator('button[data-view="arch"]').click()
                page.wait_for_selector("[data-arch-tab]", timeout=30000)
                page.wait_for_timeout(1200)
                page.locator('[data-project-view-tab="tech"]').click()
                page.wait_for_selector("[data-graph-mode-switch]", timeout=30000)
                page.locator('[data-graph-mode="MODULE_BOX"]').click()
                page.wait_for_selector("[data-arch-view] .react-flow__node", state="attached", timeout=30000)
                # 等初始 fit 完成（不等会出现「节点在 DOM 但视口未归位」的中间态：rect 有效、
                # elementFromPoint 命中 pane、截图空画布）。判据：viewport 签名连续两次相同且 zoom≠1。
                sig_prev = None
                settled = False
                for _ in range(40):
                    page.wait_for_timeout(500)
                    sig = page.evaluate(
                        "() => { const vp = document.querySelector('[data-arch-view] .react-flow__viewport');"
                        " if (!vp) return null; const m = new DOMMatrix(getComputedStyle(vp).transform);"
                        " return m.a.toFixed(4) + '/' + m.e.toFixed(1) + '/' + m.f.toFixed(1); }")
                    if sig is not None and sig == sig_prev and not sig.startswith("1.0000/"):
                        settled = True
                        break
                    sig_prev = sig
                out["viewport_settled"] = settled
                page.wait_for_timeout(500)
                out["viewport_before"] = page.evaluate(VIEWPORT_JS)
                out["top_nodes"] = page.evaluate(
                    "() => [...document.querySelectorAll('[data-arch-view] .react-flow__node')].map(n => n.getAttribute('data-id'))")

                # 展开 scripts（真实鼠标点它的展开钮中心）
                tg = page.evaluate(
                    """() => { const t = document.querySelector('[data-arch-view] [data-expand-toggle="scripts"]');
                       if (!t) return null; const r = t.getBoundingClientRect();
                       return {cx: r.x + r.width/2, cy: r.y + r.height/2, w: r.width, h: r.height}; }""")
                if tg is None:
                    fails.append("找不到 scripts 的展开钮")
                else:
                    page.mouse.click(tg["cx"], tg["cy"])
                    page.wait_for_timeout(4000)
                out["viewport_after_expand"] = page.evaluate(VIEWPORT_JS)

                # 新子树 = scripts 的直接子级（从画布 DOM 里找 parent 链不如直接问数据：用展开前后差集）
                ids_after = page.evaluate(
                    "() => [...document.querySelectorAll('[data-arch-view] .react-flow__node')].map(n => n.getAttribute('data-id'))")
                new_ids = [i for i in ids_after if i not in (out["top_nodes"] or [])]
                out["new_subtree_ids"] = new_ids
                m = page.evaluate(POST_EXPAND_JS, new_ids)
                out["post_expand"] = m
                page.screenshot(path=os.path.join(OUT, "r4-%s-module-box-expanded.png" % MODE))

                # 判据①：新子树全部节点在视口内（有展开钮的其钮也在视口内且命中自身）
                sub = [n for n in m["subtree"] if n.get("present")]
                not_in = [n["id"] for n in sub if not n["in_viewport"]]
                tog_bad = [n["id"] for n in sub if n.get("toggle") and (not n["toggle"]["in_viewport"] or not n["toggle"]["hit_self"])]
                out["verdict_1_subtree_in_viewport"] = len(not_in) == 0 and len(tog_bad) == 0
                out["verdict_1_detail"] = {"not_in_viewport": not_in, "toggle_bad": tog_bad}
                # 判据②：可见展开钮抽查 ≥5（含与新子树相邻者）：命中自身
                vis = [t for t in m["toggles"] if t["visible_center_in_viewport"]]
                sample = vis[:8]
                bad = [t for t in sample if not t["hit_self"]]
                out["verdict_2_toggles_hit_self"] = len(sample) >= 5 and len(bad) == 0
                out["verdict_2_detail"] = {"sampled": len(sample), "bad": bad}
                print("[probe] 新子树 %d 节点；不在视口: %s；钮坏: %s" % (len(sub), not_in, tog_bad))
                print("[probe] 可见展开钮抽查 %d 个，命中坏: %s" % (len(sample), json.dumps(bad, ensure_ascii=False)[:200]))
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
    with open(os.path.join(OUT, "r4-%s.json" % MODE), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    ok = (out["fingerprints"]["zero_write_ok"] and not fails
          and out.get("verdict_1_subtree_in_viewport") and out.get("verdict_2_toggles_hit_self"))
    print("[probe] 零写入自证: %s；判据①=%s ②=%s" % (
        out["fingerprints"]["zero_write_ok"], out.get("verdict_1_subtree_in_viewport"), out.get("verdict_2_toggles_hit_self")))
    print("[probe] R4（%s）: %s" % (MODE, "ALL PASS" if ok else "HAS FAIL（修前判红属预期）"))
    shutil.rmtree(tmp, ignore_errors=True)
    if MODE == "after" and not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
