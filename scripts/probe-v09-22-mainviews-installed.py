#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-22 定向收尾 · 两张主视图（功能全景/施工依赖）正式入口可见性补证。

背景（Codex 复核 2026-09-29 §2）
  第四轮安装版 UI 验证里，功能全景/施工依赖两张主视图断言失败——夹具没有已发布蓝图（数据侧
  合理空），真实 home 复测只记了 DOM 计数（7/30/57），截图却是**空画布**，无法区分「截图早于
  布局完成」还是「真实显示问题」；随后的数据探针又调了不存在的 /api/projects/:id/graphs 路由
  404 中止、脚本未归档。本探针就是补这一块：

  1) 夹具带**已发布蓝图**（blueprint.json publish.published=true；8 能力/8 任务/8 模块，
     形状复用 verify-v09-22.ts B 段夹具）＋modules.json——两张主视图有真实规划层数据；
  2) 数据期望值走 **MCP 六图入口**（安装版 mcp.js stdio，同一隔离 home；不调任何不存在的
     HTTP 图路由）；
  3) 可见性判定：布局稳定（连续 3 次采样节点数与「全体节点 transform 签名＋视口变换」的
     **内容哈希**一致——2026-09-30 修正，Codex ca34057 复核 C1：旧版只比签名长度，节点
     同长度持续移动会假稳定；视口平移/缩放未收敛也判不稳定）之后，逐节点检查坐标有限
     （无 NaN/Infinity）、尺寸>0、画布容器盒内有可见节点，再截图留档；每次采样的完整
     签名、视口变换与 sha256 均归档进 readings，事后可逐字复核；
  4) 控制台全程留档并单列 NaN 计数——与既有 translate(NaN,NaN) 问题区分开，不拿它冒充全绿，
     也不让它淹没「主视图真实可见」的结论。

隔离口径（同 verify-v09-22-ui-installed.py 的 R2 硬闸）
  --expect-data-dir 必填；/health.data_dir 规范化比对不匹配 → 任何 DELETE/POST 前退出（exit 2），
  写请求流水自证为零。夹具只落本脚本自建临时区；不杀塔台进程（协调器负责回收隔离实例）。

用法（协调器先用隔离 TATAI_HOME＋独立端口启动安装版 exe 与 CDP）
  python scripts/probe-v09-22-mainviews-installed.py --cdp-port 9223 --backend-port 8891 \
      --expect-data-dir <隔离home> --installed-mcp <安装版server/mcp.js> --log-dir <证据目录>
"""
import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from playwright.sync_api import sync_playwright

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tmp-mainviews")
KEEP = os.environ.get("V0922_KEEP_TMP") == "1"
PROJECT = "v0922-mv-main"
G = 8  # 夹具规模：8 能力 / 8 任务 / 8 模块（两张主视图都 <15，无聚合，DOM 数=MCP 数可对照）

passes = [0]
fails = []
CONSOLE = []


def ok(cond, label):
    print(("[mv] PASS " if cond else "[mv] FAIL ") + label)
    if cond:
        passes[0] += 1
    else:
        fails.append(label)


def info(msg):
    print("[mv]   " + msg)


def _ts():
    return time.strftime("%Y-%m-%dT%H:%M:%S") + ".%03d" % (int(time.time() * 1000) % 1000)


# ── 通用（与 verify-v09-22-ui-installed.py 同源；探针自包含，便于归档独立复跑） ──
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


def _norm_dir(p):
    return os.path.normcase(os.path.realpath(os.path.abspath(p)))


class Backend:
    """R2 写保护：隔离核对通过前，任何写方法先记账再抛错（物理上不存在未核对先写的路径）。"""

    WRITE_METHODS = ("POST", "DELETE", "PUT", "PATCH")

    def __init__(self, port):
        self.port = port
        self.writes_allowed = False
        self.write_log = []

    def api(self, path, method="GET", body=None):
        if method.upper() in self.WRITE_METHODS:
            blocked = not self.writes_allowed
            self.write_log.append({"t": _ts(), "method": method.upper(), "path": path, "blocked": blocked})
            if blocked:
                raise RuntimeError("写保护拦截：%s %s——/health.data_dir 未通过隔离核对（R2）" % (method.upper(), path))
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
        raise RuntimeError("后端 127.0.0.1:%d 未就绪（/health 探测超时）" % self.port)


def _write_isolation_log(entry):
    with open(os.path.join(OUT, "isolation.log"), "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def verify_isolation(backend, expect_data_dir):
    st, health = backend.api("/health")
    if st != 200 or not isinstance(health, dict):
        _write_isolation_log({"verdict": "fail", "reason": "health_unavailable", "status": st,
                              "write_requests": backend.write_log})
        print("[isolation] FAIL /health 不可用（%s）——不进行任何写操作" % st)
        sys.exit(2)
    actual = health.get("data_dir")
    actual_n = _norm_dir(actual) if isinstance(actual, str) else None
    expect_n = _norm_dir(expect_data_dir)
    entry = {
        "verdict": "match" if actual_n == expect_n else "MISMATCH",
        "checked_at": _ts(),
        "backend_port": backend.port,
        "backend_pid": health.get("pid"),
        "health_data_dir": actual,
        "health_data_dir_normalized": actual_n,
        "expect_data_dir": expect_data_dir,
        "expect_data_dir_normalized": expect_n,
        "write_requests_so_far": list(backend.write_log),
    }
    info("隔离核对：%s（data_dir=%r vs 预期 %r；后端 pid=%s）" % (entry["verdict"], actual, expect_data_dir, health.get("pid")))
    _write_isolation_log(entry)
    if actual_n != expect_n:
        print("[isolation] FAIL data_dir 不匹配：实际 %r ≠ 预期 %r——立即退出，写请求数 %d"
              % (actual, expect_data_dir, len(backend.write_log)))
        sys.exit(2)
    backend.writes_allowed = True
    return health


# ── CDP 附着（同源工具） ──
def wait_cdp(cdp_port, timeout=60):
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
    raise RuntimeError("CDP 端口 %d 未就绪（%s）" % (cdp_port, last))


def find_shell_page(browser, timeout=30):
    deadline = time.time() + timeout
    last_urls = []
    while time.time() < deadline:
        last_urls = []
        for ctx in browser.contexts:
            for pg in ctx.pages:
                u = pg.url or ""
                last_urls.append(u)
                if u.startswith("http://tauri.localhost") or u.startswith("https://tauri.localhost") or u.startswith("tauri://"):
                    return pg
        time.sleep(0.5)
    raise RuntimeError("未找到塔台界面页；现有 pages：%s" % (last_urls or "（无）"))


def _msg_line(kind, text, url):
    body = (text or "").replace("\r", " ").replace("\n", " ")
    return "[%s] %s %s: %s" % (_ts(), kind, url or "-", body)


def on_console(msg):
    loc = msg.location or {}
    CONSOLE.append(_msg_line("console.%s" % msg.type, msg.text, loc.get("url") or ""))


def on_pageerror(err):
    CONSOLE.append(_msg_line("pageerror", str(err), ""))


# ── 页面导航 ──
def nav_project(page, project):
    parts = urllib.parse.urlsplit(page.url)
    origin = "%s://%s" % (parts.scheme, parts.netloc)
    target = "%s/#p/%s" % (origin, urllib.parse.quote(project, safe=""))
    try:
        page.goto(target, wait_until="domcontentloaded")
    except Exception:
        page.evaluate("(h) => { window.location.href = h; }", target)


def open_main(page, name, settle_ms=1200):
    page.locator('[data-project-view-tab="%s"]' % name).click()
    page.wait_for_timeout(settle_ms)


# ── 布局稳定与可见性读数（本轮补证的核心） ──
# 签名内容＝全体节点的 transform＋data-id；vp＝.react-flow__viewport 的 transform（视口
# 平移/缩放）。节点 transform 是画布坐标系、视口变换把它映射到屏幕——两者一起不变，
# 屏幕位置才真的不动（ca34057 复核 C1：只看节点签名会漏掉视口仍在平移/缩放的情形）。
LAYOUT_SIG_JS = """(view) => {
  const host = document.querySelector('[data-project-view="' + view + '"]');
  if (!host) return null;
  const nodes = [...host.querySelectorAll('.react-flow__node')];
  const vp = host.querySelector('.react-flow__viewport');
  return { n: nodes.length,
           vp: vp ? (vp.style.transform || '') : '',
           sig: nodes.map(x => (x.style.transform || '') + '#' + (x.getAttribute('data-id') || '')).sort().join('|') };
}"""

VISIBILITY_JS = """(view) => {
  const host = document.querySelector('[data-project-view="' + view + '"]');
  if (!host) return null;
  const c = host.getBoundingClientRect();
  let visible = 0, outOfBounds = 0, zeroSize = 0, nanTransforms = 0, finite = true;
  const sample = [];
  for (const n of host.querySelectorAll('.react-flow__node')) {
    const t = n.style.transform || '';
    if (t.indexOf('NaN') >= 0 || t.indexOf('Infinity') >= 0) { nanTransforms++; finite = false; }
    const r = n.getBoundingClientRect();
    if (![r.x, r.y, r.width, r.height].every(v => Number.isFinite(v))) { finite = false; continue; }
    if (r.width <= 0 && r.height <= 0) { zeroSize++; continue; }
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const inBox = cx >= c.left && cx <= c.right && cy >= c.top && cy <= c.bottom;
    if (inBox) visible++; else outOfBounds++;
    if (sample.length < 6) sample.push({ id: n.getAttribute('data-id'), x: Math.round(cx), y: Math.round(cy) });
  }
  return { total: host.querySelectorAll('.react-flow__node').length, visible, outOfBounds, zeroSize,
           nanTransforms, finite,
           canvas: { w: Math.round(c.width), h: Math.round(c.height) },
           sample };
}"""


def _sig_digest(sig, vp):
    """签名＋视口变换的联合内容哈希（sha256）——判稳与归档复核共用同一口径。"""
    return hashlib.sha256(("%s\x00%s" % (sig, vp)).encode("utf-8")).hexdigest()


def wait_layout_stable(page, view, timeout_s=40):
    """布局稳定＝连续 3 次采样（500ms 间隔）节点数与「签名＋视口变换」的**内容**一致。

    2026-09-30 修正（Codex ca34057 复核 C1）：旧版只比较签名**长度**（sig_len），节点
    同长度持续移动——如 translate(100,100)→(101,100)→(102,100)——会被误判 stable=True。
    现改为完整内容比较：签名与视口变换一起取 sha256，连续 3 次同一哈希且节点数不变才
    判稳定；视口平移/缩放未收敛时视口变换持续变化，同样判不稳定。
    每次采样把完整签名、视口变换与哈希记进 samples（随 readings 归档，事后可逐字比对
    或重算哈希复核）。返回 (stable, samples, last_sig)；不稳定也如实返回，交给断言红着留档。"""
    samples = []
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        cur = page.evaluate(LAYOUT_SIG_JS, view)
        if cur is None:
            time.sleep(0.4)
            continue
        digest = _sig_digest(cur["sig"], cur["vp"])
        samples.append({"t": _ts(), "n": cur["n"], "sig_len": len(cur["sig"]),
                        "sig_sha256": digest, "sig": cur["sig"], "vp": cur["vp"]})
        if len(samples) >= 3:
            tail = samples[-3:]
            if (all(s["n"] == tail[0]["n"] for s in tail)
                    and len({s["sig_sha256"] for s in tail}) == 1):
                return True, samples, cur
        last = cur
        time.sleep(0.5)
    return False, samples, last


# ── 夹具：已发布蓝图（形状复用 verify-v09-22.ts B 段）＋模块集 ──
def make_fixture(tmp):
    d = os.path.join(tmp, "proj-" + PROJECT)
    arch = os.path.join(d, ".工作台", "arch")
    os.makedirs(arch, exist_ok=True)
    mods = []
    for i in range(1, 6):
        mods.append({"id": "code-%02d" % i, "name": "", "path": "code-%02d" % i,
                     "file_count": 9 - i, "loc": 0,
                     "deps": [{"to": "code-01", "weight": 1}] if i > 1 else []})
    with open(os.path.join(arch, "modules.json"), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "generated_at": "2026-09-29T00:00:00+08:00",
                   "budget_exhausted": False, "modules": mods}, f, ensure_ascii=False)
    nodes, edges = [], []
    for i in range(1, G + 1):
        k = str(i).zfill(2)
        nodes.append({"id": "plan:cap:%s" % k, "kind": "capability", "name": "能力 %s" % k,
                      "source_refs": [], "related_ids": []})
        nodes.append({"id": "plan:task:T%s" % k, "kind": "task", "name": "任务 T%s" % k,
                      "source_refs": [], "related_ids": []})
        nodes.append({"id": "plan:code:m%s" % k, "kind": "module", "name": "模块 m%s" % k,
                      "source_refs": [], "related_ids": []})
        edges.append({"source": "plan:task:T%s" % k, "target": "plan:cap:%s" % k,
                      "kind": "task_design_ref", "source_refs": [], "certainty": "declared"})
        edges.append({"source": "plan:task:T%s" % k, "target": "plan:code:m%s" % k,
                      "kind": "implementation_map", "source_refs": [], "certainty": "observed"})
    bp = {
        "version": 1, "baseline_id": "bl-mv-fixture", "generator_version": "probe-v09-22-mainviews",
        "generated_at": "2026-09-29T00:00:00+08:00", "source_manifest": [],
        "nodes": nodes, "edges": edges,
        "coverage": {"design_sections": {"total": 0, "mapped": 0, "unmapped": []},
                     "plan_tasks": {"total": G, "mapped": G, "unmapped": []},
                     "code_modules": {"total": G, "mapped": G, "unmapped": []},
                     "nodes_total": len(nodes), "nodes_kept": len(nodes),
                     "edges_total": len(edges), "edges_kept": len(edges), "note": "主视图补证夹具"},
        "omitted": [], "model_receipt": None,
        "publish": {"published": True, "reason": None, "validated_at": "2026-09-29T00:00:00+08:00"},
        "based_on": {"model_key": "mv-fixture", "full_key": "mv-fixture",
                     "design_content_sha256": None, "plan_definition_sha256": None, "semantic": False},
    }
    with open(os.path.join(arch, "blueprint.json"), "w", encoding="utf-8") as f:
        json.dump(bp, f, ensure_ascii=False)
    return d


def main():
    global OUT
    ap = argparse.ArgumentParser(description="V09-22 两张主视图正式入口可见性补证（CDP＋MCP 对照）")
    ap.add_argument("--cdp-port", type=int, default=9223)
    ap.add_argument("--backend-port", type=int, default=8891)
    ap.add_argument("--expect-data-dir", required=True, help="R2 硬闸：预期隔离 TATAI_HOME")
    ap.add_argument("--installed-mcp", required=True, help="安装版 server/mcp.js 绝对路径（MCP 六图入口）")
    ap.add_argument("--log-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "tmp-mainviews"))
    args = ap.parse_args()
    OUT = args.log_dir
    os.makedirs(OUT, exist_ok=True)

    tmp = tempfile.mkdtemp(prefix="tatai-v0922mv-")
    backend = Backend(args.backend_port)
    registered = []
    rec = {}
    try:
        backend.wait_health()
        verify_isolation(backend, args.expect_data_dir)

        fixture = make_fixture(tmp)
        backend.api("/api/projects/%s" % urllib.parse.quote(PROJECT, safe=""), "DELETE")  # 幂等：不存在时 404
        st, res = backend.api("/api/projects", "POST", {"id": PROJECT, "name": "V09-22 主视图夹具", "path": fixture})
        ok(st == 200 and isinstance(res, dict) and res.get("ok") is True, "夹具注册（POST /api/projects → %s）" % st)
        if not (st == 200 and isinstance(res, dict) and res.get("ok") is True):
            raise RuntimeError("夹具注册失败：%s %s" % (st, res))
        registered.append(PROJECT)

        # MCP 六图入口取期望值（安装版 mcp.js，同一隔离 home）
        mcp_out = os.path.join(OUT, "mcp-expected.json")
        mcp_js = os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe-v09-22-mainviews-mcp.mjs")
        env = {k: v for k, v in os.environ.items() if not k.startswith("TATAI_")}
        env["TATAI_HOME"] = args.expect_data_dir
        p = subprocess.run(["node", mcp_js, os.path.abspath(args.installed_mcp), args.expect_data_dir, PROJECT, mcp_out],
                           capture_output=True, text=True, env=env, timeout=180)
        info("MCP 驱动：%s" % (p.stdout.strip() or p.stderr.strip()[:300]))
        ok(p.returncode == 0 and os.path.exists(mcp_out), "MCP 六图入口取到期望值（exit=%d）" % p.returncode)
        expected = json.load(open(mcp_out, encoding="utf-8")) if os.path.exists(mcp_out) else {}
        rec["mcp_expected"] = expected

        cdp = wait_cdp(args.cdp_port)
        _write_isolation_log({"verdict": "entry-identity", "checked_at": _ts(),
                              "backend_port": args.backend_port, "cdp_port": args.cdp_port,
                              "cdp_browser": cdp.get("Browser", "") or ""})
        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp("http://127.0.0.1:%d" % args.cdp_port)
            page = find_shell_page(browser)
            page.on("console", on_console)
            page.on("pageerror", on_pageerror)
            info("附着：%s" % page.url)
            _write_isolation_log({"verdict": "entry-identity", "checked_at": _ts(), "shell_page_url": page.url})

            nav_project(page, PROJECT)
            page.wait_for_timeout(2500)
            page.locator('button[data-view="arch"]').click()
            page.wait_for_selector("[data-arch-tab]", timeout=40000)
            page.wait_for_timeout(1000)

            for view in ("functional", "construction"):
                console_idx = len(CONSOLE)
                open_main(page, view)
                stable, samples, last = wait_layout_stable(page, view)
                rec.setdefault("stability", {})[view] = {"stable": stable, "samples": samples[-6:]}
                ok(stable, "%s 布局稳定（连续 3 次采样签名＋视口内容哈希一致；最终节点数=%s）" % (view, last and last.get("n")))
                vis = page.evaluate(VISIBILITY_JS, view)
                rec.setdefault("visibility", {})[view] = vis
                exp_n = (expected.get("graphs", {}).get(view, {}).get("counts", {}) or {}).get("nodes")
                ok(vis is not None and vis["total"] > 0, "%s 画布节点非空（DOM=%s）" % (view, vis and vis["total"]))
                ok(vis is not None and vis["finite"], "%s 全部节点坐标有限（无 NaN/Infinity）" % view)
                ok(vis is not None and vis["nanTransforms"] == 0,
                   "%s 节点 transform 无 NaN（实际 %s 个）" % (view, vis and vis["nanTransforms"]))
                ok(vis is not None and vis["visible"] >= 3,
                   "%s 画布容器盒内可见节点 %s 个（≥3；出界 %s、零尺寸 %s）" % (view, vis and vis["visible"], vis and vis["outOfBounds"], vis and vis["zeroSize"]))
                ok(exp_n is not None and vis is not None and vis["total"] == exp_n,
                   "%s DOM 节点数 %s === MCP 六图入口 counts.nodes %s" % (view, vis and vis["total"], exp_n))
                page.screenshot(path=os.path.join(OUT, "mainview-%s.png" % view))
                seg = CONSOLE[console_idx:]
                nan_msgs = [c for c in seg if "NaN" in c]
                rec.setdefault("console_nan", {})[view] = {"segment_messages": len(seg), "nan_messages": len(nan_msgs)}
                info("%s 段控制台：%d 条，其中含 NaN %d 条（既有问题单列，不并入结论）" % (view, len(seg), len(nan_msgs)))
    finally:
        rec["write_requests_total"] = len(backend.write_log)
        rec["write_requests_blocked"] = sum(1 for w in backend.write_log if w.get("blocked"))
        _write_isolation_log({"verdict": "write-summary", "checked_at": _ts(),
                              "write_requests_total": len(backend.write_log),
                              "write_requests_blocked": rec["write_requests_blocked"]})
        for fid in registered:
            try:
                backend.api("/api/projects/%s" % urllib.parse.quote(fid, safe=""), "DELETE")
            except Exception:
                pass
        if not KEEP:
            cleaned = rmtree_hard(tmp)
            info("临时夹具目录自清：%s（%s）" % ("已删" if cleaned else "残留", tmp))
        with open(os.path.join(OUT, "console-mainviews.log"), "w", encoding="utf-8") as f:
            f.write("\n".join(CONSOLE) + ("\n" if CONSOLE else ""))

    with open(os.path.join(OUT, "readings.json"), "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False, indent=2)

    print("\n[mv] 主视图可见性 %d PASS / %d FAIL" % (passes[0], len(fails)))
    for x in fails:
        print("[mv]   FAIL " + x)
    if fails:
        sys.exit(1)


if __name__ == "__main__":
    main()
