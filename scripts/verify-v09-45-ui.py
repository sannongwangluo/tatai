#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""启动恢复 + 面板布局专项（DESIGN §6.10 运行部件构建身份 / §4.4 有界与去重 / §3.11 展开详情不吃掉画布）：
真实浏览器验证 BuildIdentityPanel **首次 /health 失败后自己恢复**，不靠刷新页面；并验证展开/折叠时
左栏项目区不被这块面板挤压或重叠。

为什么必须是真浏览器 + 真产物：
  · 缺陷现场就是"壳先开窗、后端后起"：面板挂载时 `getHealth()` 落空 → 旧实现一直 unknown，
    reload 才会好。只有真浏览器里看 DOM 属性随健康度**自己**变化，才算证明；
  · ui 身份是**构建期内联**的常量，源码直跑（vite dev）恒为 unknown。要看 `same_release` 就必须
    用 `vite build` 的真产物；server 身份同理要用 `build-server.ts` 的真产物。两边同批构建 ⇒ 同 release。

本脚本所以：把工作树整份拷到隔离快照（junction node_modules，不装任何依赖）→ 在快照里真跑
`vite build`（ui）与 `scripts/build-server.ts`（server）→ 起真 server → 前面放一个**可控闸门代理**：
  · 闸门 `refuse`：/health 模拟"连不上"（不回响应直接断连 ⇒ Chromium "Failed to fetch"）；
  · 闸门 `ok`    ：/health 透传真 server 的 /health（身份是真的，不是脚本编的）；
  · 闸门 `patch` ：透传但改写 server 身份的 release_id，模拟"重连换了包"；
  · 闸门 `noident`：透传但删掉 build_identity，模拟"旧后端/未内嵌身份"（仍须 unknown，不判一致）；
  · 闸门 `hang`  ：/health 不回，等客户端自己断（用来证明卸载会**取消在途请求**）。

断言覆盖（DESIGN §6.10 / §4.4 / §3.11）：
  ① 首次 health 失败 ⇒ 面板如实 failed/unknown，并起退避重连；
  ② 后续 health 成功 ⇒ **不 reload、不 navigate** 自动恢复 same_release（探针 `__tatai_p0_probe` 存活自证）；
  ③ 持续失败 ⇒ 一直 unknown，**不把上次成功冒充当前运行后端**；重试有界（非每秒狂打）；
  ④ 重连换包 ⇒ 显式刷新偏斜判定（same_release → skew，点名前 12 位）；
  ⑤ 成功清旧错误；旧后端未内嵌身份仍 unknown；卸载取消在途请求、离开后不再打 /health；
  ⑥ 任一瞬间至多一笔在途 /health（不叠加并发）；
  ⑦ **提前手动成功后没有旧定时器的额外 /health**（成功即清掉已排定的退避定时器）；
  ⑧ **长期失败 ⇒ 自动重试次数用尽即停**（连续无新请求，不永久轮询），且仍可手动恢复；
  ⑨ 已连上之后后台换包：`online` / 回前台也触发**一次受控读取**并刷新偏斜（不叠加、不用按钮）；
  ⑩ 展开 / 折叠、**1440×900 与较矮窗口**下左栏项目区（跨项目视图 / 添加项目）不被面板挤压或重叠
     （真实截图 + 矩形断言；展开详情走内部滚动）。

隔离与副作用：全在隔离临时快照与动态端口里；不写共享工作树、不装依赖、不碰真实 ~/.tatai；
收尾杀净本脚本拉起的进程与端口，清掉临时目录（V0945_RECOVERY_KEEP=1 可保留现场）。

用法：`python scripts/verify-v09-45-ui.py`
      （V0945_RECOVERY_OUT 换证据目录、V0945_RECOVERY_KEEP=1 保留现场、
        V0945_LEGACY_PANEL=<修前面板源文件> 走**负控**：快照里换成修前版本，本专项必须判红；
        V0945_LEGACY_CSS=<修前样式文件> 同法换样式，用来判红"展开详情不限高、压掉项目区"）
"""
import hashlib
import json
import os
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
if NODE is None:
    raise SystemExit("找不到 node（本脚本要求绝对 node/tsx/tsc，不用包管理器）")
VITE_JS = REPO / "node_modules" / "vite" / "bin" / "vite.js"
OUT = Path(os.environ.get("V0945_RECOVERY_OUT", str(REPO / ".." / "P0-startup-recovery-evidence"))).resolve()
KEEP = os.environ.get("V0945_RECOVERY_KEEP") == "1"

# 闸门 `patch` 用的"另一个包"的 release_id（64 hex，明显不是本批构建的）
PATCHED_RELEASE = "f" * 64

COPY_SKIP_DIRS = {"node_modules", ".git", ".工作台", "audit", "__pycache__", "dist"}
COPY_SKIP_REL = {"src-tauri/target", "src-tauri/resources", "src-tauri/gen"}

passes = [0]
fails = []
skips = []
LOGLINES = []
PAGE_ERRORS = []
CONSOLE = []


def ok(cond, label, detail=None):
    line = ("[recovery] PASS " if cond else "[recovery] FAIL ") + label + ("" if detail is None else "  :: " + json.dumps(detail, ensure_ascii=False)[:400])
    print(line, flush=True)
    LOGLINES.append(line)
    if cond:
        passes[0] += 1
    else:
        fails.append(label)


def skip(label, reason):
    line = "[recovery] SKIP " + label + "（" + reason + "）"
    print(line, flush=True)
    LOGLINES.append(line)
    skips.append(label + "：" + reason)


def info(msg):
    print("[recovery]   " + msg, flush=True)
    LOGLINES.append("  " + msg)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def http_json(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def file_sha256(path):
    if not path.is_file():
        return "n/a"
    h = hashlib.sha256()
    with h.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ── 隔离快照（只拷源，不拷输出/依赖；node_modules 用 junction 指向共享依赖，不装任何东西） ──
def copy_tree(src: Path, dest: Path):
    dest.mkdir(parents=True, exist_ok=True)
    for entry in os.scandir(src):
        rel = (Path(src) / entry.name).relative_to(REPO).as_posix()
        if entry.is_dir():
            if entry.name in COPY_SKIP_DIRS or rel in COPY_SKIP_REL:
                continue
            copy_tree(Path(entry.path), dest / entry.name)
        elif entry.is_file():
            shutil.copyfile(entry.path, dest / entry.name)


def junction(link: Path, target: Path):
    r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError("mklink /J 失败：%s%s" % (r.stdout, r.stderr))


def run(cmd, cwd, env=None, timeout=1200):
    proc = subprocess.run(cmd, cwd=str(cwd), env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    return proc


def launch_browser(p):
    """真 Chromium 内核：优先 playwright 自带 chromium，不在场就退回系统 Edge（都是 Chromium）。"""
    chan = os.environ.get("TATAI_P0_BROWSER_CHANNEL", "")
    if chan:
        return p.chromium.launch(headless=True, channel=chan)
    try:
        return p.chromium.launch(headless=True)
    except Exception as e:  # noqa: BLE001
        info("自带 chromium 起不来（%s），退回系统 Edge" % str(e).splitlines()[0][:120])
        return p.chromium.launch(headless=True, channel="msedge")


# ── 可控闸门代理：静态发 dist + /health 可控 + 其余 /api 透传真 server ──
class GateState:
    def __init__(self, dist: Path, backend: str):
        self.dist = dist
        self.backend = backend
        self.mode = "refuse"  # refuse | ok | patch | hang
        self.lock = threading.Lock()
        self.health_starts = []          # 每次 /health 请求开始的时间戳
        self.inflight = 0
        self.max_inflight = 0
        self.client_disconnects = 0      # hang 期间检测到客户端自己断（= 卸载取消了在途请求）
        self.proxied = []                # 被透传的路径（诊断用）


class GateHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "tatai-p0-gate/1"

    def log_message(self, *args):  # 静音
        pass

    @property
    def state(self) -> GateState:
        return self.server.state  # type: ignore[attr-defined]

    def _send(self, code, body: bytes, ctype="application/octet-stream"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _send_json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _proxy(self, method: str):
        length = int(self.headers.get("Content-Length") or 0)
        data = self.rfile.read(length) if length else None
        req = urllib.request.Request(self.state.backend + self.path, data=data, method=method)
        ctype = self.headers.get("Content-Type")
        if ctype:
            req.add_header("Content-Type", ctype)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = resp.read()
                self._send(resp.status, body, resp.headers.get("Content-Type", "application/json; charset=utf-8"))
                with self.state.lock:
                    self.state.proxied.append(self.path)
        except urllib.error.HTTPError as e:
            body = e.read()
            self._send(e.code, body, e.headers.get("Content-Type", "application/json; charset=utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send_json(502, {"ok": False, "error": {"code": "gate_proxy", "message": str(e)}})

    def _client_gone(self, limit: float) -> bool:
        """等客户端把这条连接断掉（EOF/复位）——用来证明卸载取消了在途请求。"""
        deadline = time.time() + limit
        while time.time() < deadline:
            try:
                r, _, _ = select.select([self.connection], [], [], 0.1)
                if r:
                    data = self.connection.recv(1, socket.MSG_PEEK)
                    if data == b"":
                        return True
            except OSError:
                return True
            time.sleep(0.05)
        return False

    def _handle_health(self):
        with self.state.lock:
            self.state.health_starts.append(time.time())
            self.state.inflight += 1
            self.state.max_inflight = max(self.state.max_inflight, self.state.inflight)
            mode = self.state.mode
        try:
            if mode == "hang":
                if self._client_gone(25.0):
                    with self.state.lock:
                        self.state.client_disconnects += 1
                self.close_connection = True
                return
            if mode == "refuse":
                # 模拟"连不上"：不回任何响应直接断连 ⇒ Chromium "Failed to fetch"（不是业务错误）
                self.close_connection = True
                return
            try:
                real = http_json(self.state.backend + "/health")
            except Exception:  # noqa: BLE001 —— 真后端不可达就如实 502（闸门不造假）
                self._send_json(502, {"ok": False})
                return
            if mode == "patch":
                bi = dict(real.get("build_identity") or {})
                bi["embedded"] = True
                bi["release_id"] = PATCHED_RELEASE
                real = dict(real)
                real["build_identity"] = bi
            elif mode == "noident":
                # 模拟**旧后端/未内嵌身份**：/health 能通、但没有 build_identity 字段 ⇒ 面板必须 unknown，不判一致
                real = dict(real)
                real.pop("build_identity", None)
            self._send_json(200, real)
        finally:
            with self.state.lock:
                self.state.inflight -= 1

    def _serve_static(self):
        path = urlparse(self.path).path
        if path == "/":
            path = "/index.html"
        target = (self.state.dist / path.lstrip("/")).resolve()
        if self.state.dist not in target.parents and target != self.state.dist:
            self._send(403, b"forbidden", "text/plain")
            return
        if not target.is_file():
            # SPA 兜底：无扩展名的路径回 index.html
            if "." not in Path(path).name:
                target = self.state.dist / "index.html"
            else:
                self._send(404, b"not found", "text/plain")
                return
        body = target.read_bytes()
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".mjs": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".woff2": "font/woff2",
            ".png": "image/png",
            ".ico": "image/x-icon",
        }.get(target.suffix, "application/octet-stream")
        self._send(200, body, ctype)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self._handle_health()
        elif path.startswith("/api/"):
            self._proxy("GET")
        else:
            self._serve_static()

    def do_POST(self):
        self._proxy("POST")

    def do_DELETE(self):
        self._proxy("DELETE")

    def do_PUT(self):
        self._proxy("PUT")


class Gate:
    def __init__(self, port: int, dist: Path, backend: str):
        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), GateHandler)
        self.httpd.daemon_threads = True
        self.httpd.state = GateState(dist, backend)  # type: ignore[attr-defined]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def state(self) -> GateState:
        return self.httpd.state  # type: ignore[attr-defined]

    def stop(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:  # noqa: BLE001
            pass


def start_backend(entry: Path, port: int, home: Path, log_path: Path):
    env = dict(os.environ)
    env["TATAI_HOME"] = str(home)
    env["TATAI_PORT"] = str(port)
    env["TATAI_NO_AUTOSTART"] = "1"
    log = log_path.open("wb")
    proc = subprocess.Popen([NODE, str(entry)], cwd=str(entry.parent), env=env, stdout=log, stderr=subprocess.STDOUT)
    url = "http://127.0.0.1:%d" % port
    deadline = time.time() + 120
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("构建出的 server 退出（见 %s）" % log_path)
        try:
            if http_json(url + "/health", timeout=3).get("ok"):
                return proc, url
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.3)
    raise RuntimeError("构建出的 server %d 未就绪（见 %s）" % (port, log_path))


def kill_tree(pid):
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
    except Exception:  # noqa: BLE001
        pass


def wait_attr(page, attr, want, timeout_ms):
    page.wait_for_function(
        "([a, w]) => { const p = document.querySelector('[data-build-identity-panel]');"
        " return !!p && p.getAttribute(a) === w; }",
        arg=[attr, want],
        timeout=timeout_ms,
    )


def soft_wait_attr(page, attr, want, timeout_ms):
    """等不到就返回 False（由断言如实判红）——负控（修前版本）下不该抛异常中断取证。"""
    try:
        wait_attr(page, attr, want, timeout_ms)
        return True
    except Exception:  # noqa: BLE001
        return False


def soft_click(page, selector, timeout_ms=10000):
    try:
        page.click(selector, timeout=timeout_ms)
        return True
    except Exception:  # noqa: BLE001
        return False


def panel_snapshot(page):
    return page.evaluate(
        "() => { const p = document.querySelector('[data-build-identity-panel]');"
        " const e = document.querySelector('[data-build-identity-error]');"
        " const d = document.querySelector('[data-build-skew-detail]');"
        " return p ? { state: p.getAttribute('data-build-identity-state'), skew: p.getAttribute('data-build-skew'),"
        "   ui: p.getAttribute('data-build-identity-ui'), server: p.getAttribute('data-build-identity-server'),"
        "   error: e ? e.textContent : null, detail: d ? d.textContent : null } : null; }"
    )


def layout_rects(page):
    """左栏真实几何：项目区（section）与其关键子元素、品牌页脚（含身份面板）的矩形。"""
    return page.evaluate(
        """() => {
      const rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect();
        return {top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width}; };
      const q = (s) => rect(document.querySelector(s));
      const addBtn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('添加项目'));
      const panel = document.querySelector('[data-build-identity-panel]');
      const detail = document.querySelector('[data-build-identity-detail]');
      return {
        footer: q('[data-brand-footer]'),
        section: q('aside.tt-sidebar > section'),
        panel: q('[data-build-identity-panel]'),
        cross: q('[data-entry="cross-project"]'),
        add: addBtn ? rect(addBtn) : null,
        vh: window.innerHeight, vw: window.innerWidth,
        panelOpen: panel ? panel.hasAttribute('open') : null,
        detailScrolls: detail ? detail.scrollHeight > detail.clientHeight + 1 : null,
        detailClientH: detail ? detail.clientHeight : null,
        detailScrollH: detail ? detail.scrollHeight : null,
      };
    }"""
    )


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def check_layout(page, label, min_section_h=100.0):
    """项目区不被新增面板挤压/重叠：section 要有可用高度，其关键子元素都要落在页脚之上、且留在视口内。

    几何读不到时如实判红（不让脚本崩掉、也不当通过）。"""
    m = layout_rects(page)
    problems = []
    sec, foot = m.get("section"), m.get("footer")
    if not (sec and _num(sec.get("height")) and _num(sec.get("bottom")) and _num(foot.get("top")) and _num(foot.get("bottom"))):
        problems.append("读不到项目区/页脚几何：%s" % json.dumps(m, ensure_ascii=False)[:200])
    else:
        if foot["bottom"] > m["vh"] + 1:
            problems.append("页脚超出视口底部（%.0f > %d）" % (foot["bottom"], m["vh"]))
        if sec["height"] < min_section_h:
            problems.append("项目区高度 %.0f < %.0f" % (sec["height"], min_section_h))
        for name, r in (("跨项目视图", m.get("cross")), ("添加项目", m.get("add"))):
            if not (r and _num(r.get("bottom"))):
                problems.append("读不到 %s 几何" % name)
            elif r["bottom"] > foot["top"] + 0.5:
                problems.append("%s 与页脚重叠（bottom %.0f > 页脚 top %.0f）" % (name, r["bottom"], foot["top"]))
            elif r["bottom"] > m["vh"] + 1:
                problems.append("%s 超出视口（%.0f > %d）" % (name, r["bottom"], m["vh"]))
    ok(not problems, label, {"problems": problems, "geom": m})
    return m


def main() -> int:
    if not VITE_JS.is_file():
        raise SystemExit("找不到 vite：%s" % VITE_JS)
    OUT.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="tatai-v0945-recovery-"))
    info("隔离工作区：%s" % work)
    info("证据目录：%s" % OUT)

    snap = work / "snap"
    copy_tree(REPO, snap)
    nm = (REPO / "node_modules").resolve()
    junction(snap / "node_modules", nm)
    info("快照 %s（node_modules -> %s，未安装任何依赖）" % (snap, nm))

    # 负控（先红）：把面板换成**修前版本**（挂载一次性 getHealth、无重试），本专项必须判红，
    # 以此证明它真的抓得到"启动不恢复"，而不是恒绿。默认不换（跑被测源码终态）。
    # V0945_LEGACY_CSS 同理换掉样式快照，用来单独判红"展开详情不限高、把左栏项目区压成 0 高"。
    legacy = os.environ.get("V0945_LEGACY_PANEL")
    if legacy:
        shutil.copyfile(legacy, snap / "src" / "ui" / "components" / "BuildIdentityPanel.tsx")
        info("负控：用修前版本覆盖面板（%s）" % legacy)
    legacy_css = os.environ.get("V0945_LEGACY_CSS")
    if legacy_css:
        shutil.copyfile(legacy_css, snap / "src" / "ui" / "index.css")
        info("负控：用修前版本覆盖样式（%s）" % legacy_css)

    ui_out = snap / ".out-ui"
    server_out = snap / ".out-server"
    build_env = dict(os.environ)
    build_env["TATAI_VITE_CACHE_DIR"] = str(work / "vite-cache")
    build_env["TATAI_BUILD_SERVER_OUT"] = str(server_out)

    # ── 真构建：ui（vite build，内联 ui 身份） ──
    t0 = time.time()
    b_ui = run([NODE, str(VITE_JS), "build", "--outDir", str(ui_out), "--emptyOutDir"], cwd=snap, env=build_env)
    (OUT / "10-build-ui.log").write_text((b_ui.stdout or "") + "\n" + (b_ui.stderr or ""), encoding="utf-8")
    ok(b_ui.returncode == 0, "真构建 ui（vite build）exit 0（%.1fs）" % (time.time() - t0), {"code": b_ui.returncode})

    # ── 真构建：server（build-server.ts，内联 server 身份） ──
    t0 = time.time()
    b_srv = run([NODE, "--import", "tsx", str(snap / "scripts" / "build-server.ts")], cwd=snap, env=build_env)
    (OUT / "11-build-server.log").write_text((b_srv.stdout or "") + "\n" + (b_srv.stderr or ""), encoding="utf-8")
    ok(b_srv.returncode == 0, "真构建 server（build-server.ts）exit 0（%.1fs）" % (time.time() - t0), {"code": b_srv.returncode})
    if b_ui.returncode != 0 or b_srv.returncode != 0:
        info("构建失败，提前退出")
        if not KEEP:
            shutil.rmtree(work, ignore_errors=True)
        return write_summary()

    # ── 起真 server，读它内嵌的 server 身份（同一批构建 ⇒ 与 ui 同 release） ──
    server_port = free_port()
    home = work / "home"
    home.mkdir(parents=True, exist_ok=True)
    (home / "registry.json").write_text(json.dumps({"version": 1, "projects": []}, ensure_ascii=False), encoding="utf-8")
    fixture = work / "fixture"
    fixture.mkdir(parents=True, exist_ok=True)
    server_proc, backend = start_backend(server_out / "index.js", server_port, home, OUT / "20-server.log")
    real_health = http_json(backend + "/health")
    real_release = (real_health.get("build_identity") or {}).get("release_id")
    info("真 server 就绪 %s：release %s…" % (backend, str(real_release)[:12]))

    gate_port = free_port()
    gate = Gate(gate_port, ui_out, backend)
    gate_url = "http://127.0.0.1:%d/" % gate_port
    info("闸门 %s（初态 refuse：/health 直接断连）" % gate_url)

    browser = None
    try:
        with sync_playwright() as p:
            browser = launch_browser(p)
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.on("pageerror", lambda e: PAGE_ERRORS.append(str(e)))
            page.on("console", lambda m: CONSOLE.append({"type": m.type, "text": m.text}))

            # ── ① 首次 health 失败 ──
            page.goto(gate_url, wait_until="domcontentloaded")
            page.wait_for_selector("[data-build-identity-panel]", timeout=30000)
            # 展开面板（<details> 默认折叠；后面的「重试」按钮要点得到）
            page.evaluate("() => document.querySelector('[data-build-identity-panel]')?.setAttribute('open', '')")
            soft_wait_attr(page, "data-build-identity-state", "failed", 20000)
            snap1 = panel_snapshot(page)
            ok(snap1["state"] == "failed" and snap1["server"] == "unknown" and snap1["skew"] == "unknown",
               "首次 /health 连不上 ⇒ 面板如实 failed / server=unknown / skew=unknown", snap1)
            ok(bool(snap1["error"]), "首次失败上屏错误原因（不静默）", {"error": snap1["error"]})
            ok(bool(snap1["detail"]) and "读后端身份失败" in (snap1["detail"] or ""), "偏斜说明点名失败原因（未知不等于一致）", {"detail": snap1["detail"]})
            ok(len(gate.state.health_starts) >= 1, "闸门确实收到 /health（失败是真实网络失败，不是页面没发请求）", {"count": len(gate.state.health_starts)})
            info("首次失败现场：%s" % json.dumps(snap1, ensure_ascii=False))

            # 跨 reload/navigate 存活的探针：自证"恢复不是刷新出来的"
            page.evaluate("() => { window.__tatai_p0_probe = 1; }")

            # ── ② 后端可用后**不 reload** 自动恢复 ──
            gate.state.mode = "ok"
            soft_wait_attr(page, "data-build-identity-state", "ok", 40000)
            snap2 = panel_snapshot(page)
            ok(snap2["skew"] == "same_release", "后端可用后面板自动恢复 same_release（未 reload）", snap2)
            ok(snap2["ui"] == snap2["server"] == real_release and real_release not in (None, "", "unknown"),
               "恢复后的身份是真的：两侧 release_id 相等且 == 真 server /health 的 release_id",
               {"ui": snap2["ui"], "server": snap2["server"], "real": real_release})
            ok(snap2["state"] == "ok" and not snap2["error"], "恢复后清掉旧错误（state=ok、无错误行）", snap2)
            ok(page.evaluate("() => window.__tatai_p0_probe === 1") is True,
               "全程未 reload / navigate：探针 __tatai_p0_probe 仍存活（恢复是面板自己做的）")
            page.screenshot(path=str(OUT / "30-recovered.png"))

            # ── ③ 持续失败：一直 unknown，不冒充上次成功；重试有界 ──
            gate.state.mode = "refuse"
            soft_click(page, "[data-build-identity-retry]")
            soft_wait_attr(page, "data-build-identity-state", "failed", 30000)
            snap3 = panel_snapshot(page)
            ok(snap3["server"] == "unknown" and snap3["skew"] == "unknown",
               "曾经成功后**再失败** ⇒ 立刻回到 unknown（不把上一次成功冒充当前运行后端）", snap3)
            with gate.state.lock:
                c0 = len(gate.state.health_starts)
            time.sleep(4.0)
            with gate.state.lock:
                c1 = len(gate.state.health_starts)
            delta = c1 - c0
            ok(2 <= delta <= 8, "持续失败 4s 内的自动重试次数有界（退避，非每秒狂打）", {"retries_in_4s": delta})
            snap3b = panel_snapshot(page)
            ok(snap3b["skew"] == "unknown", "持续失败期间始终 unknown（不误报同版）", snap3b)

            # ── ③c 提前手动成功后：没有旧退避定时器的额外 /health（成功即清掉待发 timer） ──
            gate.state.mode = "refuse"
            soft_click(page, "[data-build-identity-retry]")
            soft_wait_attr(page, "data-build-identity-state", "failed", 30000)
            time.sleep(6.5)  # 让自动退避跑到 6s 档：此刻已排定一笔 6s 后才触发的定时器
            with gate.state.lock:
                inflight_at_switch = gate.state.inflight
            gate.state.mode = "ok"
            early_ok = soft_click(page, "[data-build-identity-retry]") and soft_wait_attr(
                page, "data-build-skew", "same_release", 20000)
            with gate.state.lock:
                after_success = len(gate.state.health_starts)
            time.sleep(8.0)  # 越过那笔旧定时器本该触发的时刻（6s）；它若还在，会多打一次 /health
            with gate.state.lock:
                after_window = len(gate.state.health_starts)
            ok(early_ok and after_window == after_success,
               "提前手动成功后没有旧退避定时器的额外 /health（成功即清掉待发 timer）",
               {"recovered": early_ok, "inflight_at_switch": inflight_at_switch,
                "after_success": after_success, "after_8s_window": after_window})

            # ── ③d 长期失败：自动重试**次数用尽即停**（不永久轮询），且仍可手动恢复 ──
            gate.state.mode = "refuse"
            soft_click(page, "[data-build-identity-retry]")
            soft_wait_attr(page, "data-build-identity-state", "failed", 30000)
            with gate.state.lock:
                stop_c0 = len(gate.state.health_starts)
            t_stop = time.time()
            last = stop_c0
            stable_since = None
            while time.time() - t_stop < 45:
                time.sleep(1.0)
                with gate.state.lock:
                    cur = len(gate.state.health_starts)
                if cur != last:
                    last = cur
                    stable_since = time.time()
                elif stable_since is not None and time.time() - stable_since >= 7.0:
                    break
            stopped = stable_since is not None and time.time() - stable_since >= 7.0
            auto_reads = last - stop_c0
            ok(stopped and auto_reads <= 8,
               "长期失败：自动重试次数用尽即停（连续 7s 无新 /health，不永久轮询）",
               {"auto_reads_after_first_failure": auto_reads, "elapsed_s": round(time.time() - t_stop, 1),
                "stopped": stopped})

            gate.state.mode = "ok"
            manual_ok = soft_click(page, "[data-build-identity-retry]") and soft_wait_attr(
                page, "data-build-skew", "same_release", 20000)
            ok(manual_ok, "长期失败重试停止后仍可由用户手动恢复（受控重启）", {"recovered": manual_ok})

            # ── ④ 重连换了包：显式刷新检测偏斜 ──
            gate.state.mode = "patch"
            soft_click(page, "[data-build-identity-retry]")
            soft_wait_attr(page, "data-build-skew", "skew", 30000)  # 等**值真的变**（不是等一个本来就成立的态）
            snap4 = panel_snapshot(page)
            ok(snap4["skew"] == "skew" and snap4["server"] == PATCHED_RELEASE and snap4["ui"] == real_release,
               "重连换了包 ⇒ 刷新出 skew 并点名两侧（ui=本批 / server=另一批）", snap4)
            page.screenshot(path=str(OUT / "31-skew.png"))

            # ── ⑤ 换回本批：清错、回到 same_release ──
            gate.state.mode = "ok"
            soft_click(page, "[data-build-identity-retry]")
            soft_wait_attr(page, "data-build-skew", "same_release", 30000)
            snap5 = panel_snapshot(page)
            ok(snap5["skew"] == "same_release" and snap5["ui"] == snap5["server"] == real_release and not snap5["error"],
               "换回本批后回到 same_release 且无错误（可重复）", snap5)

            # ── ⑤b 旧后端/未内嵌身份：/health 通但没有 build_identity ⇒ 仍 unknown，不判一致 ──
            gate.state.mode = "noident"
            soft_click(page, "[data-build-identity-retry]")
            soft_wait_attr(page, "data-build-identity-server", "unknown", 30000)  # 由 release_id 变回 unknown
            snap5b = panel_snapshot(page)
            ok(snap5b["state"] == "ok" and snap5b["server"] == "unknown" and snap5b["skew"] == "unknown" and not snap5b["error"],
               "后端能通但没回构建身份（旧后端/未内嵌）⇒ 仍 unknown，不判一致", snap5b)
            # 恢复本批（给下一段一个干净起点）：等 skew 真的回到 same_release，不是等"本来就 ok"
            gate.state.mode = "ok"
            soft_click(page, "[data-build-identity-retry]")
            soft_wait_attr(page, "data-build-skew", "same_release", 30000)

            with gate.state.lock:
                max_inflight = gate.state.max_inflight
            ok(max_inflight <= 1, "全过程任一瞬间至多一笔在途 /health（重复触发不叠加并发）", {"max_inflight": max_inflight})

            # ── ⑤d 已经连上之后后台换包：online / 回前台也要能刷新偏斜（受控读取，不叠加） ──
            #     现状 = same_release；改成 patch 并派发连接恢复信号（**不用**面板按钮），面板应自己刷新。
            gate.state.mode = "patch"
            with gate.state.lock:
                sig_c0 = len(gate.state.health_starts)
            page.evaluate("() => window.dispatchEvent(new Event('online'))")
            sig_ok = soft_wait_attr(page, "data-build-skew", "skew", 15000)
            with gate.state.lock:
                sig_reads = len(gate.state.health_starts) - sig_c0
            ok(sig_ok and 1 <= sig_reads <= 2,
               "已连上后后台换包：online / 回前台触发**一次受控读取**并刷新出 skew（不叠加）",
               {"refreshed": sig_ok, "reads": sig_reads})
            # 复原本批（给下一段一个干净起点）
            gate.state.mode = "ok"
            soft_click(page, "[data-build-identity-retry]")
            soft_wait_attr(page, "data-build-skew", "same_release", 30000)

            # ── ⑤c 布局：展开 / 折叠、1440×900 与较矮窗口下项目区都不被身份面板挤压或重叠 ──
            page.set_viewport_size({"width": 1440, "height": 900})
            page.evaluate("() => document.querySelector('[data-build-identity-panel]')?.setAttribute('open', '')")
            time.sleep(0.4)
            m900 = check_layout(page, "1440×900 展开：左栏项目区不被身份面板挤压/重叠")
            ok(m900["detailScrolls"] is True,
               "1440×900 展开：身份详情走**内部限高滚动**（不是靠压掉项目区换空间）",
               {"client_h": m900["detailClientH"], "scroll_h": m900["detailScrollH"]})
            page.screenshot(path=str(OUT / "35-layout-expanded-1440x900.png"))

            page.set_viewport_size({"width": 1440, "height": 600})
            time.sleep(0.6)
            check_layout(page, "1440×600（较矮窗口）展开：项目区仍不被挤压/重叠", min_section_h=80.0)
            page.screenshot(path=str(OUT / "36-layout-expanded-1440x600.png"))

            page.evaluate("() => document.querySelector('[data-build-identity-panel]')?.removeAttribute('open')")
            time.sleep(0.4)
            m_collapsed = check_layout(page, "1440×600 默认折叠：项目区可操作、不与页脚重叠", min_section_h=150.0)
            ok(m_collapsed["panelOpen"] is False, "默认折叠：身份面板不展开（不常驻占行）",
               {"open": m_collapsed["panelOpen"]})
            page.screenshot(path=str(OUT / "37-layout-collapsed-1440x600.png"))

            # 复原（给 ⑥ 一个可点重试按钮的现场）
            page.set_viewport_size({"width": 1440, "height": 900})
            page.evaluate("() => document.querySelector('[data-build-identity-panel]')?.setAttribute('open', '')")
            time.sleep(0.3)

            # ── ⑥ 卸载取消：在途请求随离开页面被取消，且之后不再打 /health ──
            gate.state.mode = "hang"  # /health 不回，制造一条长期在途
            soft_click(page, "[data-build-identity-retry]")
            deadline = time.time() + 10
            while time.time() < deadline:
                with gate.state.lock:
                    if gate.state.inflight >= 1:
                        break
                time.sleep(0.05)
            with gate.state.lock:
                inflight_before = gate.state.inflight
                disconnects_before = gate.state.client_disconnects
                count_before_nav = len(gate.state.health_starts)
            ok(inflight_before >= 1, "离开前确有一笔在途 /health（悬挂中）", {"inflight": inflight_before})
            page.goto("about:blank")  # 卸载（React 树销毁 ⇒ 效果清理 + 在途 abort）
            deadline = time.time() + 15
            while time.time() < deadline:
                with gate.state.lock:
                    if gate.state.client_disconnects > disconnects_before:
                        break
                time.sleep(0.1)
            with gate.state.lock:
                disconnects_after = gate.state.client_disconnects
            ok(disconnects_after > disconnects_before,
               "卸载取消了在途 /health：闸门检测到客户端自己断连（AbortSignal 生效）",
               {"before": disconnects_before, "after": disconnects_after})
            time.sleep(3.0)
            with gate.state.lock:
                count_after_nav = len(gate.state.health_starts)
            ok(count_after_nav == count_before_nav,
               "离开页面后不再发起 /health（退避定时器/重连随卸载清理）",
               {"before_nav": count_before_nav, "after_nav": count_after_nav})

            ok(not PAGE_ERRORS, "页面全程无运行时错误", PAGE_ERRORS[:5])
    except Exception as error:  # noqa: BLE001 —— 取证不因单点异常中断；如实记录并判红
        ok(False, "专项无致命异常", str(error))
        try:
            page.screenshot(path=str(OUT / "32-fatal.png"))
        except Exception:  # noqa: BLE001
            pass
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:  # noqa: BLE001
                pass
        gate.stop()
        kill_tree(server_proc.pid)
        if not KEEP:
            shutil.rmtree(work, ignore_errors=True)
        else:
            info("保留现场：%s" % work)

    return write_summary()


def write_summary() -> int:
    summary = {
        "schema": "tatai-p0-startup-recovery-verification/1",
        "pass": passes[0],
        "fail": len(fails),
        "fails": fails,
        "skips": skips,
        "page_errors": PAGE_ERRORS,
        "console": CONSOLE[:20],
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (OUT / "recovery.log").write_text("\n".join(LOGLINES) + "\n", encoding="utf-8")
    line = "[recovery] PASS %d / FAIL %d / SKIP %d — %s" % (passes[0], len(fails), len(skips), OUT)
    print(line, flush=True)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
