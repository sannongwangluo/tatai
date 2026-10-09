#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""B6/V09-56 人话功能清单 UI 真浏览器验证（隔离夹具 + 真后端 + 真 vite + 真 Chromium/Edge）。

用法：python scripts/verify-feature-ledger-ui.py
      （V0956_SHOT_DIR 换截图目录、V0956_KEEP_TMP=1 保留现场）

为什么必须真浏览器（PLAN V09-56 八个检查项 + Codex 11:54–11:58 复审九项）：默认态人话、四维无颜色
可辨、双向定位、三档版本、异常/失败在场、窄窗可读、只读红线与旧客户端、分页续读、草稿语义、
读数归属——全是**上屏/交互/布局**口径，HTTP 断言证明不了界面把它画对了。

隔离口径（AGENTS.md §5）：夹具与数据全落临时目录（临时 TATAI_HOME + 临时项目根），动态空闲端口，
后端 TATAI_PORT、vite TATAI_DEV_API_PORT + --strictPort；**不碰真实 ~/.tatai、不碰真实 8787/5173**；
收尾杀净两端并删临时目录；另记真实 ~/.tatai 与真实 events.jsonl 的首尾指纹自证零写入。
故障注入只做「失败 / 挂起后放行」两类（都不 mock 业务成功路径）。
"""
import json
import hashlib
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
OUT = os.environ.get(
    "V0956_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "V09-56", "1", "ui")
)
KEEP = os.environ.get("V0956_KEEP_TMP") == "1"
REAL_HOME = os.path.join(os.path.expanduser("~"), ".tatai")
REAL_EVENTS = os.path.join(REPO, ".工作台", "work", "events.jsonl")

passes = [0]
fails = []
console_errors = []
page_errors = []
requests_seen = []
dom_evidence = {}


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


# 本脚本只访问隔离的本机服务：全部 loopback 请求必须绕过系统 HTTP 代理。
# 系统代理（HTTP_PROXY/HTTPS_PROXY）会把 127.0.0.1 的回环请求也劫走——实测经代理拿回 HTTP 502，
# 而 no_proxy 是否在场由调用方环境决定，不能依赖。故用空 ProxyHandler 的局部 opener：只影响本脚本，
# 不改用户代理设置（V09-56 修复：后端健康检查曾因代理劫持在 180s 等待后误判「未就绪」）。
LOCAL_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _ensure_loopback_no_proxy():
    """把 loopback 显式并入 NO_PROXY：后端/vite 子进程继承本进程环境，别让它们把本机流量交给系统代理。
    只改本脚本进程的环境，不动用户 shell/系统代理设置。"""
    hosts = ("localhost", "127.0.0.1", "::1")
    for key in ("NO_PROXY", "no_proxy"):
        parts = [p for p in os.environ.get(key, "").split(",") if p]
        os.environ[key] = ",".join(parts + [h for h in hosts if h not in parts])


_ensure_loopback_no_proxy()


def http(url, timeout=60):
    req = urllib.request.Request(url, method="GET")
    try:
        with LOCAL_HTTP.open(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8")
            return resp.status, (json.loads(text) if text.strip().startswith(("{", "[")) else text)
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(text)
        except Exception:  # noqa: BLE001
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
    """目录指纹（逐文件 sha256；小目录用得起）：返回 {files, hash, by_path}。"""
    by_path = {}
    if not os.path.isdir(root):
        return {"files": 0, "hash": "n/a", "by_path": by_path}
    for cur, _dirs, files in os.walk(root):
        for name in sorted(files):
            if len(by_path) >= limit:
                break
            p = os.path.join(cur, name)
            rel = os.path.relpath(p, root).replace("\\", "/")
            by_path[rel] = file_sha256(p)
    rows = sorted("%s\t%s" % (k, v) for k, v in by_path.items())
    return {"files": len(rows), "hash": hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest(), "by_path": by_path}


# 真实 ~/.tatai 里**与本用例无关**、但会被「本机同时运行的真实服务 + 其它 Agent 的 MCP 进程」重写的文件：
# `agents.json` 只由 stdio MCP（`src/mcp/server.ts` → registerAgentActivity）写，本用例只起 HTTP 后端、
# 从不连真实 MCP；`registry.json` 的 `last_opened_at` 由**本机 run 中的**桌面/CLI 选中项目与 release 复读改写
# （Codex 14:00 NOTE：release R2 worker 正用新鲜 MCP 读真项目、root 13:55 又激活了基线，都在重写它）。
# 两者只写时间戳类字段，**不写业务/证据事实**。这里不凭 mtime/整树 sha 一句话放行：
# 收尾会**逐字段**看这两份文件到底变了什么，只有「无 fixture 痕迹」的并发时间戳改写才算可归因。
CONCURRENT_REWRITERS = {"agents.json", "registry.json"}
# 并发改写允许的字段（时间戳/活跃度）；出现别的字段名 ⇒ 不是并发时间戳，要显式报出来核
CONCURRENT_FIELDS = {
    "last_opened_at", "last_accessed_at", "last_accessed", "updated_at", "updated",
    "last_seen_at", "last_seen", "activity", "activities", "agents", "sessions",
}


def read_text(path):
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def try_json(text):
    if text is None:
        return None
    try:
        return json.loads(text)
    except Exception:  # noqa: BLE001
        return None


def fixture_trace(text, fixture_ids, tmp_dir):
    """这份文本里有没有**本次夹具**的痕迹（夹具项目 id / 临时 HOME 路径）。"""
    if text is None:
        return []
    hits = [i for i in fixture_ids if i in text]
    tnorm = tmp_dir.replace("\\", "/")
    if tnorm in text.replace("\\", "/"):
        hits.append(tnorm)
    return hits


def registry_change_report(before, after):
    """逐字段看 registry.json 变了什么：返回 (changed_projects:set, changed_keys:set, new_projects:set)。"""
    b, a = try_json(before), try_json(after)
    if not isinstance(b, dict) or not isinstance(a, dict):
        return (set(), set(), set())
    bm = {p.get("id"): p for p in (b.get("projects") or []) if isinstance(p, dict)}
    am = {p.get("id"): p for p in (a.get("projects") or []) if isinstance(p, dict)}
    changed, keys = set(), set()
    for pid in set(bm) | set(am):
        if bm.get(pid) != am.get(pid):
            changed.add(pid)
            for k in set((bm.get(pid) or {})) | set((am.get(pid) or {})):
                if (bm.get(pid) or {}).get(k) != (am.get(pid) or {}).get(k):
                    keys.add(k)
    return (changed, keys, set(am) - set(bm))


def launch_browser(p):
    """系统已装 Edge（Chromium 内核）；Playwright 自带 chromium 未下载时不触发下载。"""
    args = ["--no-proxy-server", "--proxy-server=direct://", "--proxy-bypass-list=*"]
    env_bin = os.environ.get("TATAI_UI_BROWSER", "").strip() or os.environ.get("TATAI_EDGE_PATH", "").strip()
    candidates = ([env_bin] if env_bin else []) + [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for cand in candidates:
        if cand and os.path.exists(cand):
            info("浏览器 executable_path=%s" % cand)
            return p.chromium.launch(headless=True, executable_path=cand, args=args)
    try:
        info("浏览器 channel=msedge（系统已装 Edge，不下载）")
        return p.chromium.launch(headless=True, channel="msedge", args=args)
    except Exception as e:  # noqa: BLE001
        info("msedge 起不来（%s），退回 Playwright chromium" % str(e).splitlines()[0][:120])
    return p.chromium.launch(headless=True, args=args)


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
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.3)
        raise RuntimeError("后端 %d 未就绪" % self.port)

    def kill(self):
        try:
            self.proc.kill()
            self.proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
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
    deadline = time.time() + 150
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("vite 起不来（见 ui-vite.log）")
        try:
            with LOCAL_HTTP.open("http://localhost:%d/" % port, timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:  # noqa: BLE001
            time.sleep(0.5)
    raise RuntimeError("vite %d 未就绪" % port)


# ────────────────────────── 浏览器侧小工具 ──────────────────────────

def box(page, sel):
    return page.evaluate(
        """(sel) => { const e = document.querySelector(sel); if (!e) return null;
             const r = e.getBoundingClientRect();
             return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; }""",
        sel,
    )


def txt(page, sel):
    loc = page.locator(sel)
    if loc.count() == 0:
        return None
    return loc.first.inner_text().strip()


def attr(page, sel, name):
    loc = page.locator(sel)
    if loc.count() == 0:
        return None
    return loc.first.get_attribute(name)


def count(page, sel):
    return page.locator(sel).count()


def input_val(page, sel):
    """安全读输入框值：元素不在就返回 None（不触发 Playwright 的 30s 等待/抛错打断整轮）。"""
    try:
        if page.locator(sel).count() == 0:
            return None
        return page.input_value(sel)
    except Exception:  # noqa: BLE001
        return None


def wait_sel(page, sel, timeout=20000):
    try:
        page.wait_for_selector(sel, timeout=timeout)
        return True
    except Exception:  # noqa: BLE001
        return False


def wait_until(page, cond, timeout_s=15.0):
    """有界等一个**真读到的**条件成立（200ms 轮询，不阻塞事件循环）。

    2026-10-08 终态复跑定位：S3/S15 等「切版本档」处原先只睡固定 1400/1600ms 就断言，
    异步重取偶尔没回来 ⇒ 整组假失败。这里改成有界等真读数落地；超时后仍按**实际读数**断言
    FAIL，一条判据也没放宽（不是「等够就算过」）。
    """
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if cond():
            return True
        page.wait_for_timeout(200)
    return bool(cond())


def wait_project_ready(page, pid, timeout=45000):
    """有界等：当前设计页**确实是 <pid> 项目的**（不是上一份还没被替换掉的 DOM）。

    共同根因（2026-10-08 终态复跑，102pass/3fail 后 S12 崩）：换项目时 React 会先把数据归零再异步
    重取，但 `wait_for_selector("[data-design-view]")` 可能先撞上**上一份**尚未被替换的正文/清单，
    随后固定 sleep 又不足以覆盖新项目的取数——断言就打在了旧项目的数据上（S10 的 F 两条、S12 的
    `input_value` 超时都落在这条竞态里）。这里用**版本选择器 input 的 name（含项目 id）**当项目身份
    信号（设计页两条渲染分支都会带上它），等它属于本项目再继续；等不到就抛超时（不静默按旧数据断言）。
    """
    page.wait_for_selector('input[name="design-version-%s"]' % pid, timeout=timeout)
    page.wait_for_selector("[data-design-view]", timeout=timeout)


def open_design(page, base, pid, expect_ledger=True, wait=900):
    page.goto("%s/#p/%s" % (base, pid), wait_until="domcontentloaded")
    page.locator('button[data-view="design"]').click()
    wait_project_ready(page, pid)
    if expect_ledger:
        page.wait_for_selector("[data-feature-ledger]", timeout=30000)
        # 等读口这一轮落地（成功 / 失败 / 未派生 / 未接入），避免把「还在读」当结论
        wait_sel(
            page,
            "[data-ledger-summary], [data-ledger-error], [data-ledger-unsupported], [data-ledger-not-derived]",
            timeout=30000,
        )
    page.wait_for_timeout(wait)


def fresh_document(page, base, pid, timeout=45000):
    """强制一份**全新文档**（等价 reload），并对冷 vite 缓存/依赖优化导致的慢重载兜底。

    2026-10-08：本机冷 vite 缓存下，一次 `page.reload` 偶发地被依赖优化拖过 30s 而超时
    （`Page.reload: Timeout`，navigated 到同一 hash 但 domcontentloaded 迟迟不来）。超时后
    改用**带 cache-bust 的 goto** 再取一份新文档——仍是真实整页重载，不改任何界面判据，
    只是不让一次慢重载把整段打断。
    """
    try:
        page.reload(wait_until="domcontentloaded", timeout=timeout)
        return
    except Exception:  # noqa: BLE001
        info("重载超时，改用带 cache-bust 的 goto 强制新文档（%s/#p/%s）" % (base, pid))
    page.goto("%s/?cb=%d#p/%s" % (base, int(time.time() * 1000), pid),
              wait_until="domcontentloaded", timeout=timeout)


def open_design_fresh(page, base, pid, wait=900):
    """像 open_design，但**强制真实重载文档**再进设计页。

    为什么需要：`page.goto` 到与当前完全相同的 URL（含同一 `#p/<id>`）不会触发导航，
    React 树与 DOM 都不重建；而 `<details open>` 是**非受控 DOM 态**，会跨「换视口/重复进入」
    残留——按 1440 展开过之后，切到 390 再量到的其实是「展开态」，默认收起根本没被量到
    （Codex R2 首轮 17 条失败里，窄窗那组全部源于此）。这里显式重载，保证每次量的是
    **默认收起**的真实首屏；S17b 的故障注入也只有真重载才会读到注入版，而不是上一份异步数据。
    """
    page.goto("%s/#p/%s" % (base, pid), wait_until="domcontentloaded", timeout=45000)
    fresh_document(page, base, pid)
    page.wait_for_timeout(400)
    page.locator('button[data-view="design"]').click()
    wait_project_ready(page, pid)
    page.wait_for_selector("[data-feature-ledger]", timeout=30000)
    wait_sel(
        page,
        "[data-ledger-summary], [data-ledger-error], [data-ledger-unsupported], [data-ledger-not-derived]",
        timeout=30000,
    )
    page.wait_for_timeout(wait)


def click_heading_by_text(page, needle):
    """按标题文字点正文标题（行号由组件从 AST 取，测试只按可见文字定位）。"""
    hit = page.evaluate(
        """(needle) => { const els = [...document.querySelectorAll('[data-design-heading]')];
             const el = els.find((e) => (e.textContent || '').includes(needle));
             if (!el) return null; el.click(); return el.getAttribute('data-design-heading'); }""",
        needle,
    )
    page.wait_for_timeout(400)
    return hit


def discuss_post_handler(action, held):
    """`/discuss` 写口故障注入：fail = 立即 500；hold = 扣住不放，由用例稍后放行（真后端）。"""
    def handler(route, request):
        is_post = request.method == "POST" and "/api/" in request.url and request.url.split("?")[0].endswith("/discuss")
        if not is_post:
            route.continue_()
            return
        if action == "fail":
            route.fulfill(
                status=500, content_type="application/json",
                body=json.dumps({"ok": False, "code": "FIXTURE_INJECTED", "message": "夹具注入：补充写入失败"}),
            )
        else:
            held.append(route)
    return handler


def expected_attention_ids(items):
    """独立复算「需要你看一眼」的应然集合（Python 侧重写判据，不复用组件代码）。

    判据口径（= `FeatureLedgerView.attentionReasons`）：设计覆盖缺失/源变待复核/无法判断、
    证据失效、验证已通过但只差用户拍板、用户已退回、**本条挂了待决项**——任一条成立就要人看。
    """
    out = []
    for i in items:
        dc = i["design_coverage"]["state"]
        v = i["verification"]
        ua = i["user_acceptance"]
        hit = dc in ("缺失", "源变待复核", "无法判断")
        if v["evidence_state"] == "invalidated":
            hit = True
        if (ua["state"] == "pending" and v["display_status"] == "verified"
                and v["evidence_state"] == "verified" and ua["scope_tasks"]):
            hit = True
        if ua["state"] == "rejected":
            hit = True
        if i["pending_decisions"]:
            hit = True
        if hit:
            out.append(i["item_id"])
    return out


def expected_decision_tally(items):
    """独立复算待决读数：返回 (稳定身份去重后的问题数 or None, 关联处数)。

    身份 = 读口给的 `decision_id`（待议源行定位符）；空身份视为不稳定，**不按标题猜**。
    """
    ids = set()
    links = 0
    unstable = False
    for i in items:
        for d in i["pending_decisions"]:
            links += 1
            did = (d.get("decision_id") or "").strip()
            if did == "":
                unstable = True
            else:
                ids.add(did)
    return (None if unstable else len(ids), links)


def ledger_hold_handler(held):
    def handler(route, request):
        if request.method == "GET" and "/feature-ledger" in request.url:
            held.append(route)
        else:
            route.continue_()
    return handler


def build_fixtures(home, root):
    proc = subprocess.run(
        ["node", "--import", "tsx", os.path.join("scripts", "verify-feature-ledger-ui.ts"),
         "--home", home, "--root", root],
        cwd=REPO, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError("夹具构造失败：\n%s\n%s" % (proc.stdout[-2000:], proc.stderr[-2000:]))
    return json.loads(proc.stdout)


def main():
    tmp = tempfile.mkdtemp(prefix="tatai-v0956ui-")
    try:
        run_fixture(tmp)
    finally:
        # 保留现场开关照旧；构造、浏览器或断言中断也必须清理本轮临时目录。
        if not KEEP:
            shutil.rmtree(tmp, ignore_errors=True)


def run_fixture(tmp):
    home = os.path.join(tmp, "home")
    root = os.path.join(tmp, "root")
    os.makedirs(OUT, exist_ok=True)
    real_home_before = tree_fingerprint(REAL_HOME)
    real_registry_file = os.path.join(REAL_HOME, "registry.json")
    real_agents_file = os.path.join(REAL_HOME, "agents.json")
    real_registry_before = read_text(real_registry_file)
    real_agents_before = read_text(real_agents_file)
    # 生产服务（本机 8787 桌面/CLI 后端）会把自己的日志写进真实 ~/.tatai/logs/；与本用例无关。
    # 记下它的前置内容，收尾用「只追加 + 无夹具痕迹」两条证据决定能否归因（不凭文件名放行）。
    real_log_before = {rel: read_text(os.path.join(REAL_HOME, rel))
                       for rel in ("logs/backend.log",)}
    # 真实事件账本（D:/tatai/.工作台/work/events.jsonl）：本用例只写隔离 HOME，不会写它；但**并发**
    # 的协调/MCP 写入（其它 worker 登记/认领/回执）会持续追加它。记内容首段，收尾用「只追加 + 无夹具
    # 痕迹」归因（不凭 sha 一句话放行，也不把并发的合法写入当成本用例越界）。
    real_events_before = read_text(REAL_EVENTS)
    info("真实 ~/.tatai 指纹（前）：%d 文件 / %s…" % (real_home_before["files"], real_home_before["hash"][:12]))

    fx = build_fixtures(home, root)
    info("夹具：%s" % ", ".join("%s=%s" % (k, v["id"]) for k, v in fx["projects"].items()))

    backend_port = free_port()
    vite_port = free_port()
    backend = None
    vite = None
    try:
        backend = Backend(home, backend_port, os.path.join(OUT, "ui-backend.log"))
        backend.wait_health()
        info("后端就绪 127.0.0.1:%d（TATAI_HOME=%s）" % (backend_port, home))
        vite = start_vite(vite_port, backend_port, os.path.join(OUT, "ui-vite.log"), os.path.join(tmp, "vite-cache"))
        info("vite 就绪 http://localhost:%d" % vite_port)
        base = "http://localhost:%d" % vite_port

        with sync_playwright() as p:
            browser = launch_browser(p)
            try:
                page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
                page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
                page.on("pageerror", lambda e: page_errors.append(str(e)))
                page.on("request", lambda r: requests_seen.append((r.method, r.url)))
                run_checks(page, base, backend, fx, tmp)
                if not page_errors:
                    ok(True, "全程无未捕获页面异常（pageerror=0）")
                else:
                    ok(False, "全程有未捕获页面异常：%s" % page_errors[:3])
            finally:
                browser.close()
    finally:
        try:
            if vite is not None:
                subprocess.run(["taskkill", "/PID", str(vite.pid), "/T", "/F"], capture_output=True)
        except Exception:  # noqa: BLE001
            pass
        if backend is not None:
            backend.kill()

    real_home_after = tree_fingerprint(REAL_HOME)
    real_events_after = read_text(REAL_EVENTS)
    changed_home = sorted(
        k for k in set(real_home_before["by_path"]) | set(real_home_after["by_path"])
        if real_home_before["by_path"].get(k) != real_home_after["by_path"].get(k)
    )
    info("真实 ~/.tatai 本次变化文件：%s" % (changed_home or "无"))

    # ── 隔离证据（自证写在哪）──
    # 1) 夹具的写落点必须是**隔离 HOME**：临时家里要有夹具项目与账本，才说明「写发生在隔离侧」。
    isolated_projects = set()
    iso_reg = try_json(read_text(os.path.join(home, "registry.json")))
    if isinstance(iso_reg, dict):
        isolated_projects = {p.get("id") for p in (iso_reg.get("projects") or []) if isinstance(p, dict)}
    fixture_ids = {v["id"] for v in fx["projects"].values()}
    iso_written = os.path.isdir(os.path.join(home, "projects")) or os.path.isfile(os.path.join(home, "registry.json")) \
        or os.path.isdir(home)
    ok(iso_written and fixture_ids.issubset(isolated_projects),
       "隔离 HOME 承接了本次全部夹具写入（%s；隔离 registry 里 %d 个夹具项目）"
       % (home, len(fixture_ids & isolated_projects)))

    # 2) 全程**没有**打到主机生产端口（8787）或 CDP（9333）：用真实请求清单点名，不靠指纹推断。
    production_hits = [u for (_m, u) in requests_seen
                       if (":%d" % 8787) in u or (":%d" % 9333) in u]
    ok(not production_hits, "全程零请求打到主机生产 8787/CDP 9333（越界 %d 条）" % len(production_hits))

    # 3) 真实 ~/.tatai 的变化：**逐字段**归因，不用整树 sha 一句话放行，也不把真越界藏起来。
    reg_changed, reg_keys, reg_new = registry_change_report(real_registry_before, read_text(real_registry_file))
    reg_trace = fixture_trace(read_text(real_registry_file), fixture_ids, tmp)
    agents_trace = fixture_trace(read_text(real_agents_file), fixture_ids, tmp)
    trace_leaks = sorted(set(reg_trace + agents_trace))
    reg_concurrent = (
        reg_changed.isdisjoint(fixture_ids)
        and reg_new.isdisjoint(fixture_ids)
        and reg_keys.issubset(CONCURRENT_FIELDS)
    )
    info("真实 registry.json 变化：项目=%s / 字段=%s / 新增=%s / 夹具痕迹=%s"
         % (sorted(reg_changed) or "无", sorted(reg_keys) or "无", sorted(reg_new) or "无", trace_leaks or "无"))
    # 生产服务自己的日志（真实 ~/.tatai/logs/）：只有在**确证只追加 + 无夹具痕迹**时才归因，
    # 不凭文件名一句话放行；被截断/含夹具痕迹一律落回 unexplained / leak。
    log_verdict = {}
    for rel, probe in real_log_before.items():
        after_t = read_text(os.path.join(REAL_HOME, rel))
        appended = probe is not None and after_t is not None and after_t.startswith(probe)
        clean = fixture_trace(after_t, fixture_ids, tmp) == []
        log_verdict[rel] = {"appended_only": appended, "fixture_free": clean}
        info("真实 %s：只追加=%s / 无夹具痕迹=%s" % (rel, appended, clean))

    def _attrib(rel):
        after_t = read_text(os.path.join(REAL_HOME, rel))
        if fixture_trace(after_t, fixture_ids, tmp):
            return "leak"
        if rel in CONCURRENT_REWRITERS:
            return "concurrent"
        v = log_verdict.get(rel)
        if v is not None:
            return "concurrent" if (v["appended_only"] and v["fixture_free"]) else "unexplained"
        return "unexplained"

    attributed = {c: _attrib(c) for c in changed_home}
    unexplained_home = [c for c, why in attributed.items() if why == "unexplained"]
    leaked_home = [c for c, why in attributed.items() if why == "leak"]
    ok(not trace_leaks,
       "真实 ~/.tatai 无**夹具**写入痕迹（夹具项目 id / 临时 HOME 路径都不出现在真实登记表里）")
    ok(not unexplained_home,
       "真实 ~/.tatai 的变化都可归因（可归因=%s；无解释的意外变化=%s）"
       % ({c: w for c, w in attributed.items()} or "无", unexplained_home))
    ok(not leaked_home, "真实 ~/.tatai 未出现本次夹具产物（本用例只写隔离 HOME）")
    if reg_changed or reg_keys:
        ok(reg_concurrent,
           "registry.json 的并发改写只动时间戳类字段、且不涉及夹具项目（回归：release R2 复读/root 激活基线在重写它）")
    events_appended = (real_events_before is not None and real_events_after is not None
                       and real_events_after.startswith(real_events_before))
    events_trace = fixture_trace(real_events_after, fixture_ids, tmp)
    events_unchanged = real_events_before == real_events_after
    info("真实事件账本 events.jsonl：未变=%s / 只追加=%s / 夹具痕迹=%s"
         % (events_unchanged, events_appended, events_trace or "无"))
    ok(not events_trace and (events_unchanged or events_appended),
       "真实事件账本 events.jsonl 无本次夹具写入（未变=%s；并发只追加=%s；夹具痕迹=%s）"
       % (events_unchanged, events_appended, events_trace or "无"))

    # 隔离判据**自检**（防「判据恒真」）：用合成样本证明①夹具痕迹能被抓到 ②并发时间戳改写被判为可归因
    # ③夹具项目被写进真实登记表会被判为越界。否则没有并发时这条判据等于没测。
    tids = {"ui-dense-attention", "ui-missing-design"}
    synth_before = json.dumps({"version": 1, "projects": [
        {"id": "示例项目", "name": "示例项目", "path": "D:/demo-project", "kind": "backend",
         "registered_at": "2026-09-29T00:06:09+08:00", "last_opened_at": "2026-10-07T13:58:21+08:00"}]})
    synth_after_ts = synth_before.replace("13:58:21", "14:00:37")
    synth_after_leak = json.dumps({"version": 1, "projects": [
        {"id": "示例项目", "name": "示例项目", "path": "D:/demo-project", "kind": "backend",
         "registered_at": "2026-09-29T00:06:09+08:00", "last_opened_at": "2026-10-07T14:00:37+08:00"},
        {"id": "ui-dense-attention", "name": "夹具", "path": "D:\\Temp\\x", "kind": "backend"}]})
    ok(fixture_trace(synth_before, tids, "D:/Temp/nowhere") == []
       and fixture_trace(synth_after_leak, tids, "D:/Temp/nowhere") == ["ui-dense-attention"],
       "隔离判据自检：真实登记表无夹具痕迹时为空；混进夹具项目 id 时被抓到")
    ch_ts, k_ts, new_ts = registry_change_report(synth_before, synth_after_ts)
    ok(ch_ts == {"示例项目"} and k_ts == {"last_opened_at"} and new_ts == set()
       and k_ts.issubset(CONCURRENT_FIELDS) and ch_ts.isdisjoint(tids),
       "隔离判据自检：并发只改 last_opened_at ⇒ 判为可归因（变化项目=%s 字段=%s）" % (sorted(ch_ts), sorted(k_ts)))
    ch_lk, k_lk, new_lk = registry_change_report(synth_before, synth_after_leak)
    ok(not new_lk.isdisjoint(tids) and not ch_lk.isdisjoint(tids),
       "隔离判据自检：夹具项目被写进真实登记表 ⇒ 判为越界（新增=%s）" % sorted(new_lk))
    ok(not registry_change_report(None, synth_after_ts)[0], "隔离判据自检：读不到旧文件时不误判（无变化）")
    # 隔离判据自检：生产日志归因规则的**两条腿**都要能反向——只追加可归因；混进夹具痕迹不可归因。
    synth_log = "2026 tx start\n2026 tx list\n"
    ok(synth_log.startswith("2026 tx start\n")
       and fixture_trace(synth_log + "夹具 ui-dense-attention", tids, "D:/Temp/nowhere") == ["ui-dense-attention"],
       "隔离判据自检：日志只追加可归因、日志混进夹具痕迹则不可归因")

    # 只读红线：本卡的读口/界面**不新增**写路径。
    # 既有入口（与本卡无关）：/discuss（补充需求复用）、/open、/watch（App 选项目本就打这两个；切项目会 DELETE /watch 停看）
    ALLOWED_POST = ("/discuss", "/open", "/watch")
    bad_write = [(m, u) for (m, u) in requests_seen if "/api/" in u and m == "PUT"]
    bad_write += [(m, u) for (m, u) in requests_seen if "/api/" in u and m == "DELETE" and "/watch" not in u]
    bad_post = [
        (m, u) for (m, u) in requests_seen
        if "/api/" in u and m == "POST" and not any(a in u for a in ALLOWED_POST)
    ]
    ok(not bad_write, "全程零 PUT、DELETE 只用于既有 /watch 停看（本卡未新增写路径；越界 %d 条）" % len(bad_write))
    ok(not bad_post, "POST 只打在既有入口 /discuss·/open·/watch（不新增写路径；越界 %d 条）" % len(bad_post))

    result = {"pass": passes[0], "fail": len(fails), "fails": fails,
              "console_errors": console_errors, "page_errors": page_errors,
              "requests": sorted({"%s %s" % (m, u) for (m, u) in requests_seen}),
              "bad_write": bad_write, "bad_post": bad_post,
              "dom": dom_evidence}
    with open(os.path.join(OUT, "console.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print("\n[ui] V09-56-UI %d PASS / %d FAIL" % (passes[0], len(fails)))
    for x in fails:
        print("[ui]   FAIL " + x)
    sys.exit(1 if fails else 0)


def snapshot_dom(page, key):
    dom_evidence[key] = page.evaluate(
        """() => {
          const items = [...document.querySelectorAll('[data-ledger-item]')].map((e) => ({
            item_id: e.getAttribute('data-ledger-item'),
            design_coverage: e.getAttribute('data-design-coverage'),
            implementation: e.getAttribute('data-implementation'),
            verification: e.getAttribute('data-verification'),
            evidence_state: e.getAttribute('data-evidence-state'),
            user_acceptance: e.getAttribute('data-user-acceptance'),
          }));
          const headings = [...document.querySelectorAll('[data-design-heading]')].map((e) => ({
            line: Number(e.getAttribute('data-design-heading')),
            level: e.getAttribute('data-design-heading-level'),
            id: e.id,
            text: (e.textContent || '').trim(),
          }));
          const ledger = document.querySelector('[data-feature-ledger]');
          return {
            overview_text: (document.querySelector('[data-feature-overview]') || {}).innerText || null,
            ledger_summary: (document.querySelector('[data-ledger-summary]') || {}).innerText || null,
            ledger_stale_version: ledger ? ledger.getAttribute('data-ledger-stale-version') : null,
            ledger_loaded: ledger ? ledger.querySelector('[data-ledger-summary]')?.getAttribute('data-ledger-loaded') : null,
            ledger_complete: ledger ? ledger.querySelector('[data-ledger-summary]')?.getAttribute('data-ledger-complete') : null,
            items,
            headings,
          };
        }"""
    )


def run_checks(page, base, backend, fx, tmp):
    P = {k: v["id"] for k, v in fx["projects"].items()}
    ROOT = {k: v["root"] for k, v in fx["projects"].items()}
    EXP = fx["expectations"]

    # ═══════════ S1 默认态 · 四维分开 · 无颜色可辨（chk-01/02） ═══════════
    info("S1 默认态与四维（B 已审无运行 / D 有效验证 / A 缺设计）")
    open_design(page, base, P["B"])
    ok(count(page, '[data-feature-ledger][data-ledger-state="ok"]') == 1, "B：功能清单面板在场（state=ok）")
    ok(count(page, '[data-ledger-item="cap-b"]') == 1, "B：声明功能 cap-b 可见")
    it = '[data-ledger-item="cap-b"]'
    ok(attr(page, it, "data-design-coverage") == "已核对", "B：设计覆盖=已核对")
    ok(attr(page, it, "data-implementation") == "no_run_record", "B：实现=no_run_record")
    ok(attr(page, it, "data-verification") != "verified", "B：验证未通过（绿只取 verification）")
    ok(attr(page, it, "data-user-acceptance") == "pending", "B：用户接受=pending（与设计审定分开）")
    bt = txt(page, it) or ""
    ok("无运行记录" in bt, "B：缺运行说「无运行记录」（人话）")
    ok("未实现" not in bt, "B：**不写**「未实现」")
    ok("缺设计" not in bt, "B：有设计 → 不误报缺设计")
    # 四维每维都有文字标签（无颜色也能辨）
    ok(count(page, it + " [data-ledger-dims] [data-ledger-dim]") == 4, "B：四维各一格（4 个 dim）")
    dimlabels = page.evaluate(
        """(sel) => Array.from(document.querySelectorAll(sel)).map(e => e.getAttribute('data-ledger-dim'))""",
        it + " [data-ledger-dim]",
    )
    ok(dimlabels == ["design_coverage", "implementation", "verification", "user_acceptance"],
       "B：四维顺序与标识 = 设计覆盖/实现/验证/用户接受")
    ok(count(page, it + " .tt-fl-green") == 0, "B：未验证 ⇒ 面板里没有绿色")
    dc_class = page.get_attribute(it + ' [data-ledger-dim="design_coverage"] .tt-fl-dim-value', "class") or ""
    ok("tt-fl-approved" in dc_class and "tt-fl-green" not in dc_class,
       "B：「设计已核对」用中性/信息色，**不借绿色**冒充可用")

    open_design(page, base, P["D"])
    dit = '[data-ledger-item="cap-d"]'
    ok(attr(page, dit, "data-verification") == "verified", "D：验证=verified")
    ok(count(page, dit + " [data-ledger-verified]") == 1, "D：绿色徽标只在验证已通过时出现")
    ok(count(page, dit + ' [data-ledger-dim="verification"] .tt-fl-green') == 1, "D：绿色落在 verification 一档")
    ddc = page.get_attribute(dit + ' [data-ledger-dim="design_coverage"] .tt-fl-dim-value', "class") or ""
    ok("tt-fl-green" not in ddc, "D：设计覆盖即便已核对也**不是绿色**")
    ok("你已接受" in (txt(page, dit) or ""), "D：用户接受维度显示「你已接受」（fixture 模拟，非真人验收）")
    ok("2/2" in (txt(page, dit) or ""), "D：验证给出本范围证据计数（2/2）")
    led_text = txt(page, "[data-feature-ledger]") or ""
    ok("%" not in led_text, "面板**不算百分比**（可见文字里没有 %）")
    ok(count(page, dit + " [data-ledger-detail]") == 1, "D：技术字段收进按需展开的详情")

    open_design(page, base, P["A"])
    ait = '[data-ledger-item="cap-a"]'
    ok(attr(page, ait, "data-design-coverage") == "缺失", "A：设计覆盖=缺失")
    ok("缺设计·待补" in (txt(page, ait) or ""), "A：说人话「缺设计·待补」")
    ok(count(page, '[data-ledger-item="pending:req-orphan"]') == 1, "A：需求有、设计没写的待补项**也显示**（不隐藏）")
    ok(count(page, ait + " [data-ledger-ref]") >= 1, "A：设计章节引用可点（回原文入口在场）")

    # ═══════════ S9 首屏人话：功能概览在前，技术材料在后（复审 4/7） ═══════════
    info("S9 首屏人话与布局（功能概览 / 正文旁清单 / 技术材料退后）")
    page.set_viewport_size({"width": 1600, "height": 950})
    open_design(page, base, P["D"], wait=1200)
    ov = box(page, "[data-feature-overview]")
    body_b = box(page, "[data-design-body]")
    led_b = box(page, "[data-feature-ledger]")
    tech_b = box(page, "[data-design-technical='baseline']")
    ok(ov is not None and ov["y"] < 950, "首屏就能看到功能概览（概览顶部在 1600×950 首屏内）")
    ok(body_b is not None and ov is not None and ov["y"] < body_b["y"],
       "功能概览排在正文之前（不用先滚过技术表单）")
    ok(tech_b is not None and body_b is not None and tech_b["y"] > body_b["y"],
       "既有审定激活等材料退到主区之后，不占首屏")
    ok(led_b is not None and body_b is not None and led_b["x"] > body_b["x"] and abs(led_b["y"] - body_b["y"]) < 80,
       "功能清单与正文并排（正文旁）")
    ov_text = txt(page, "[data-feature-overview]") or ""
    ok("验证已通过" in ov_text and "待继续" in ov_text, "概览默认就给出四维进度（通过/继续做）")
    ok("§" not in ov_text and "GET" not in ov_text and "**" not in ov_text and "只读派生" not in ov_text,
       "概览里没有规则条文号/接口名/裸 **/实现说明")
    band = (txt(page, "[data-feature-overview]") or "") + (txt(page, "[data-feature-ledger]") or "") + (txt(page, "[data-design-body]") or "")
    ok("**" not in band, "默认界面（概览+正文+清单）没有裸的 ** 标记")
    ok("不改写" not in band and "不造绿" not in band and "readonly" not in band,
       "默认界面不写「不改写/不造绿/readonly」这类实现规则")
    ok(count(page, "[data-baseline-panel]") == 1, "既有「审定与激活」能力仍保留（在可展开区里，没删功能）")
    ok("待议记录（" in (txt(page, '[data-design-technical-summary="discuss"]') or ""),
       "待议保留可展开入口 + 条数")
    ok(count(page, "[data-version-option]") >= 1, "版本入口（当前/已审定/历史）仍在默认界面")
    snapshot_dom(page, "first_screen_D")
    page.screenshot(path=os.path.join(OUT, "wide-firstscreen.png"))

    # ═══════════ S10 待决误报：未验证不喊用户（复审 5/9） ═══════════
    info("S10 待你决定的分寸（B 不喊 / F 真需要 / D 已接受）")
    open_design(page, base, P["B"])
    b_ov = txt(page, "[data-feature-overview]") or ""
    ok("待你接受" not in b_ov and "待你退回" not in b_ov and "待你决定" not in b_ov,
       "B：未验证/未开始的功能不喊用户接受或退回")
    ok(count(page, "[data-ledger-attention]") == 0, "B：没有真需要人现在决定的项 ⇒ 不制造待决块")
    ok(count(page, "[data-overview-attention]") == 0, "B：概览里也没有「需要你看一眼」的误报")
    ok(count(page, "[data-overview-next]") == 1 and "不需要你现在逐项拍板" in b_ov,
       "B：未完成的工作如实说成「继续做（交给执行方）」，不推给用户")
    ok(attr(page, '[data-ledger-item="cap-b"]', "data-user-acceptance") == "pending",
       "B：接受维仍如实标 pending（不隐藏、不代签）")
    open_design(page, base, P["F"])
    f_ov = txt(page, "[data-feature-overview]") or ""
    ok("等你决定接受或退回" in f_ov, "F：验证真通过、只差人拍板 ⇒ 才列成待你决定")
    ok(count(page, "[data-ledger-attention]") == 1, "F：真需要你决定的项默认可见")
    open_design(page, base, P["D"])
    ok("待你接受" not in (txt(page, "[data-feature-overview]") or ""), "D：已接受的功能不再喊用户")

    # ═══════════ S2 双向定位（chk-03） ═══════════
    info("S2 双向定位（清单→正文；正文→关联功能/待归属）")
    open_design(page, base, P["D"])
    ok(attr(page, '[data-ledger-item="cap-d"] [data-ledger-ref="3.5"]', "data-ledger-ref-status") == "located",
       "D：章节引用状态=located")
    page.locator('[data-ledger-item="cap-d"] [data-ledger-ref="3.5"]').click()
    page.wait_for_timeout(600)
    ok(attr(page, '[data-design-heading="9"]', "data-design-heading-active") == "1",
       "D：点清单引用 → 精确章节标题被选中（design-h-9，行号来自 design_section_refs）")
    page.locator('[data-design-heading="9"]').click()
    page.wait_for_timeout(400)
    ok(count(page, "[data-ledger-related-line]") >= 1, "D：反向选章节 → 显示关联功能区块")
    ok("功能 D" in (txt(page, "[data-ledger-related-line]") or ""), "D：反查显示这一段承载「功能 D」")
    page.locator('[data-design-heading="3"]').click()
    page.wait_for_timeout(400)
    ok(count(page, "[data-ledger-unassigned]") == 1, "D：没有功能承载的章节显式「待归属」（不硬凑近似标题）")

    # 定位不到的引用：**防御注入**（B2 读口对悬空章节整体 422，真实链路走不到这一支）
    led = backend.api("/api/projects/%s/feature-ledger?document=current" % P["D"])
    if led[0] == 200:
        mut = json.loads(json.dumps(led[1]["ledger"]))
        mut["items"][0]["design_section_refs"][0]["status"] = "unresolved"
        page.route(
            "**/feature-ledger*",
            lambda route: route.fulfill(status=200, content_type="application/json",
                                        body=json.dumps({"ok": True, "ledger": mut})),
        )
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("[data-design-view]", timeout=30000)
        # 注入版是**异步**落地的：有界等注入的引用项真渲染出来再判
        # （固定 sleep 会撞上还没重取回来的空窗，误入 else 记成「无法注入」的假失败）。
        wait_until(page, lambda: count(page, '[data-ledger-item="cap-d"] [data-ledger-ref]') >= 1, timeout_s=20)
        if count(page, '[data-ledger-item="cap-d"] [data-ledger-ref]') >= 1:
            st = attr(page, '[data-ledger-item="cap-d"] [data-ledger-ref]', "data-ledger-ref-status")
            ok(st == "unresolved" and "定位不到" in (page.inner_text('[data-ledger-item="cap-d"] [data-ledger-ref]') or ""),
               "【防御注入，非真实链路】定位不到的引用显式报「定位不到」并置灰（不猜近似标题）")
        else:
            ok(False, "无法注入 unresolved 引用以验证 UI 分支")
        page.unroute("**/feature-ledger*")

    # ═══════════ S13 标题行号来自 Markdown AST（复审 8；h1–h6/重复/强调/前缀） ═══════════
    info("S13 标题定位：行号取 AST，不按标题文字近似匹配")
    heads = EXP["I"]["headings"]
    open_design(page, base, P["I"], expect_ledger=False, wait=900)
    dom_heads = page.evaluate(
        """() => [...document.querySelectorAll('[data-design-heading]')].map((e) => ({
             line: Number(e.getAttribute('data-design-heading')),
             level: e.getAttribute('data-design-heading-level'),
             id: e.id,
             text: (e.textContent || '').trim() }))"""
    )
    dom_evidence["headings_I"] = dom_heads
    ok(len(dom_heads) == len(heads), "I：每个标题都拿到定位（%d 个，期望 %d）" % (len(dom_heads), len(heads)))
    ok(sorted(d["line"] for d in dom_heads) == sorted(h["line"] for h in heads),
       "I：标题 id 的行号 == 该标题在源文本里的真实行号（独立行扫描核对）")
    ok(all(d["id"] == "design-h-%d" % d["line"] for d in dom_heads), "I：id 形态 = design-h-<行号>")
    ok(len({d["line"] for d in dom_heads}) == len(dom_heads), "I：重复标题各拿各的行号（不共用同一行）")
    ok(any(d["level"] == "h5" for d in dom_heads) and any(d["level"] == "h6" for d in dom_heads),
       "I：h5 / h6 也纳入可定位标题（h1–h6 全覆盖）")
    dups = sorted(d["line"] for d in dom_heads if d["level"] == "h3" and d["text"] == "3.5 目标章节")
    ok(len(dups) == 2 and dups[1] - dups[0] > 1, "I：两个同名「3.5 目标章节」拿到两个不同真实行号（%s）" % dups)
    second_line = dups[1] if len(dups) == 2 else None
    if second_line is not None:
        page.locator('[data-design-heading="%d"]' % second_line).click()
        page.wait_for_timeout(400)
        ok(attr(page, '[data-design-heading="%d"]' % second_line, "data-design-heading-active") == "1",
           "I：点第二个同名标题 → 选中的是它自己（不是首个匹配）")
        others_off = page.evaluate(
            """(line) => [...document.querySelectorAll('[data-design-heading]')]
                 .filter((e) => Number(e.getAttribute('data-design-heading')) !== line)
                 .every((e) => e.getAttribute('data-design-heading-active') === '0')""",
            second_line,
        )
        ok(others_off, "I：其他标题都没有被误选中（重复标题不串）")

    # ═══════════ S3 三档版本 · 历史（chk-04） ═══════════
    info("S3 版本三档（当前草稿 / 已审定基线 / 历史已替代）")
    open_design(page, base, P["E"])
    ok(count(page, '[data-version-option="current"]') == 1, "E：版本档「当前草稿」在场")
    ok(count(page, '[data-version-option="active"]') == 1, "E：版本档「已审定基线」在场")
    ok(count(page, '[data-version-option="history"]') == 1, "E：版本档「历史已替代」在场")
    ok(count(page, '[data-version-option="active"][data-version-value="active"]') == 1, "E：基线档可选（有生效基线）")
    ok(attr(page, '[data-ledger-item="cap-e"]', "data-design-coverage") == "源变待复核",
       "E：相关源变 ⇒ 设计覆盖=源变待复核（相关功能标待复验）")
    hist_val = attr(page, '[data-version-option="history"]', "data-version-value")
    ok(bool(hist_val) and len(hist_val) == 64, "E：历史档带不可变修订 hash")
    ok("历史已替代" in (txt(page, '[data-version-option="history"]') or ""), "E：历史档标「历史已替代」+ 当时版本/接受状态")
    page.locator('[data-version-option="history"] input').click()
    wait_until(page, lambda: attr(page, "[data-design-current-mode]", "data-design-current-mode") == "revision")
    ok(attr(page, "[data-design-current-mode]", "data-design-current-mode") == "revision",
       "E：切历史档后正文实际读到 revision（不是只 echo 请求）")
    ok("历史" in (txt(page, "[data-design-current-mode]") or ""), "E：档位以人话显示（历史已替代版本）")
    body = txt(page, "[data-design-body]") or ""
    ok("已被改动" not in body, "E：历史档正文是**当时**的快照（不含之后的源变）")
    page.locator('[data-version-option="current"] input').click()
    wait_until(page, lambda: "已被改动" in (txt(page, "[data-design-body]") or ""))
    ok("已被改动" in (txt(page, "[data-design-body]") or ""), "E：切回当前草稿 → 正文是现行源（含源变）")
    ok(count(page, "[data-ledger-unassigned]") == 0, "E：正常态不应残留「待归属」提示")

    # 历史读不回 ⇒ 如实未知（不套当前结论）
    snap_dir = os.path.join(ROOT["E"], ".工作台", "design-revisions")
    removed = []
    if os.path.isdir(snap_dir):
        for name in os.listdir(snap_dir):
            # 只删「历史已替代」那一条（不是当前生效基线的快照）
            if hist_val[:12] in name:
                os.remove(os.path.join(snap_dir, name))
                removed.append(name)
    if removed:
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("[data-design-view]", timeout=30000)
        page.wait_for_timeout(1000)
        page.locator('[data-version-option="history"] input').click()
        wait_until(page, lambda: count(page, "[data-design-version-unreadable]") == 1)
        ok(count(page, "[data-design-version-unreadable]") == 1, "E：历史快照读不回 ⇒ 显式报未知（不套当前通过结论）")
        ok(count(page, "[data-ledger-not-derived]") == 1, "E：该版本清单未派生 ⇒ 显式 not_derived（不假空成功）")
    else:
        ok(False, "未能删到历史快照以验证「读不回」分支")

    # ═══════════ S15 读数归属：旧版读数不与新正文混（复审 6） ═══════════
    info("S15 版本切换期间的功能读数归属（旧版 / 加载中要明说）")
    open_design(page, base, P["D"], wait=1200)
    held = []
    page.route("**/feature-ledger*", ledger_hold_handler(held))
    page.locator('[data-version-option="active"] input').click()
    wait_until(page, lambda: attr(page, "[data-design-current-mode]", "data-design-current-mode") == "active")
    ok(attr(page, "[data-design-current-mode]", "data-design-current-mode") == "active",
       "S15：正文已经切到已审定基线")
    ok(attr(page, "[data-feature-ledger]", "data-ledger-stale-version") == "1",
       "S15：清单还是上一版本的读数 ⇒ 显式标「旧版」（不与新正文混成当前结论）")
    ok(count(page, "[data-ledger-stale-version-note]") == 1, "S15：旧版读数有明确提示语")
    ok("tt-fl-dimmed" in (page.get_attribute("[data-feature-ledger]", "class") or ""), "S15：旧版读数降级显示")
    ok(len(held) >= 1, "S15：新版本的清单请求确实还在途（--故障注入：延迟）")
    for r in held:
        r.continue_()
    wait_until(page, lambda: attr(page, "[data-feature-ledger]", "data-ledger-stale-version") == "0")
    ok(attr(page, "[data-feature-ledger]", "data-ledger-stale-version") == "0",
       "S15：新版本读回后不再标旧版")
    page.unroute("**/feature-ledger*")
    page.locator('[data-version-option="current"] input').click()
    wait_until(page, lambda: attr(page, "[data-design-current-mode]", "data-design-current-mode") == "current")

    # ═══════════ S11 分页续读：真实 cursor / 合并不隐漏 / 版本变拒旧页（复审 1） ═══════════
    info("S11 多页功能（120 项 > 默认页大小 50）：续读、合并、版本变拒绝")
    H = P["H"]
    open_design(page, base, H, wait=1400)
    h_sum = '[data-ledger-summary]'
    # 本项目第一页 50 项：项目切换后清单先落上一份/加载态是**允许的中间态**，机制是异步的——
    # 有界等本项目第一页真落地再断言（真加载不出来 / 报错仍按实际读数 FAIL，不放宽任何判据）。
    # 2026-10-08：原先紧跟固定 1400ms 睡后即断言，碰上加载略慢就会整组假失败（续读段反而能过）。
    deadline = time.time() + 15
    while time.time() < deadline and count(page, "[data-ledger-item]") != 50:
        page.wait_for_timeout(250)
    ok(count(page, "[data-ledger-item]") == 50, "H：第一页恰好 50 项（读口默认页大小）")
    ok(attr(page, h_sum, "data-ledger-loaded") == "50" and attr(page, h_sum, "data-ledger-complete") == "0",
       "H：读数如实标「已载入 50 / 未载完」")
    sum_text = txt(page, h_sum) or ""
    ok("已载入 50 项" in sum_text and "共 50 项" not in sum_text, "H：不把本页数量报成总数")
    ok(count(page, "[data-ledger-load-more]") == 1, "H：给出「继续读取下一页」入口")
    # 反向定位：**还有没载入的项**时不能判「无映射」
    click_heading_by_text(page, "2.5.2")
    ok(count(page, "[data-ledger-unassigned-pending]") == 1 and count(page, "[data-ledger-unassigned]") == 0,
       "H：还没读完时不把「未加载」当成「无映射」")
    ok(count(page, "[data-ledger-list]") == 1, "H：清单默认展开")
    # 续读合并同样是**异步**的：有界等结果真落地再断言，固定 sleep 会撞上「请求还没回来」的中间态
    # ⇒ 整组假失败（2026-10-08 终态复跑：同段另一处 100 项判据正是这条竞态）。等不到仍按实际读数 FAIL。
    page.locator("[data-ledger-load-more]").click()
    wait_until(page, lambda: count(page, "[data-ledger-item]") == 100, timeout_s=25)
    ok(count(page, "[data-ledger-item]") == 100, "H：续读第二页后合并为 100 项（真实 cursor 续读）")
    ok(attr(page, h_sum, "data-ledger-complete") == "0", "H：第二页后仍未读完")
    page.locator("[data-ledger-load-more]").click()
    wait_until(page, lambda: count(page, "[data-ledger-item]") == 120, timeout_s=25)
    ok(count(page, "[data-ledger-item]") == 120, "H：第三页后合并为全部 120 项")
    ok(attr(page, h_sum, "data-ledger-complete") == "1", "H：读完标记 complete")
    ok("共 120 项（已全部载入）" in (txt(page, h_sum) or ""), "H：读完后才报总数")
    ids = page.evaluate("""() => [...document.querySelectorAll('[data-ledger-item]')].map(e => e.getAttribute('data-ledger-item'))""")
    ok(len(set(ids)) == 120, "H：合并后没有重复项（按 item_id 去重）")
    heading_clicked = page.evaluate("""() => { const el=[...document.querySelectorAll('[data-design-heading]')].find(e=>(e.textContent||'').includes('2.5.2')); if (!el) return false; el.click(); return true; }""")
    ok(heading_clicked, "H：续读后仍可点击原设计章节（缺标题报失败并继续收集证据）")
    page.wait_for_timeout(400)
    ok(count(page, "[data-ledger-unassigned]") == 1 and count(page, "[data-ledger-unassigned-pending]") == 0,
       "H：全部读完后才判「这一段确实没有功能」")
    snapshot_dom(page, "paged_H")

    # 版本变：旧 cursor/expected_revision 必须被拒（HTTP 级确定性 + UI 级行为）
    st_api, http1 = backend.api("/api/projects/%s/feature-ledger?document=current" % H)
    ok(st_api == 200 and http1["ledger"]["paging"]["complete"] is False, "H：HTTP 第一页未读完（带 cursor）")
    old_cursor = http1["ledger"]["paging"]["cursor"]
    old_pkg = http1["ledger"]["package_revision"]
    design_file = os.path.join(ROOT["H"], ".工作台", "design.md")
    with open(design_file, "a", encoding="utf-8", newline="") as f:
        f.write("\n### 9.9 附注（夹具改动）\n\n改了内容，清单包版本随之变化。\n")
    st_stale, stale_body = backend.api(
        "/api/projects/%s/feature-ledger?document=current&cursor=%s&expected_revision=%s"
        % (H, old_cursor, old_pkg)
    )
    ok(st_stale == 409 and stale_body.get("code") == "REVISION_CHANGED",
       "H：版本已变时旧 cursor/expected_revision 被拒 409 REVISION_CHANGED（不静默拼接新旧两版）")
    # UI 侧的 409 路径（--故障注入：续读请求返回服务端真实的 REVISION_CHANGED 形状）
    # 上面刚往 design.md 追加过内容：**真重载**才会读到新包版本；而首屏一页 50 项是异步落地的，
    # 先**有界等**它真落地再点续读。固定 sleep 会撞上「还没载入 / 还留着旧版 120 项」的中间态，
    # 于是点了个不存在或过期的续读入口（2026-10-08 终态复跑 S11 的假失败正是这条竞态）。
    open_design_fresh(page, base, H, wait=1200)
    deadline = time.time() + 20
    while time.time() < deadline and not (
        count(page, "[data-ledger-item]") == 50 and attr(page, h_sum, "data-ledger-complete") == "0"
    ):
        page.wait_for_timeout(250)
    ok(count(page, "[data-ledger-item]") == 50 and attr(page, h_sum, "data-ledger-complete") == "0",
       "H：真重载后回到新包版本的第一页 50 项（续读前的前置态确已就绪）")
    page.locator("[data-ledger-load-more]").click()
    deadline = time.time() + 20
    while time.time() < deadline and count(page, "[data-ledger-item]") != 100:
        page.wait_for_timeout(250)
    ok(count(page, "[data-ledger-item]") == 100, "H：续读先把第二页读到 100 项")

    def stale_cursor(route, request):
        if request.method == "GET" and "feature-ledger" in request.url and "cursor=" in request.url:
            route.fulfill(
                status=409, content_type="application/json",
                body=json.dumps({"ok": False, "status": 409, "code": "REVISION_CHANGED",
                                 "message": "包版本已过期：事实/定义/源读数已变，请重读",
                                 "detail": {"cursor_package_revision": old_pkg, "current_revision": "changed"}}),
            )
        else:
            route.continue_()

    page.route("**/feature-ledger*", stale_cursor)
    page.locator("[data-ledger-load-more]").click()
    deadline = time.time() + 20
    while time.time() < deadline and count(page, "[data-ledger-paging-notice]") != 1:
        page.wait_for_timeout(250)
    ok(count(page, "[data-ledger-paging-notice]") == 1, "H：续读遇版本失效 ⇒ 明确告知旧页作废（不静默拼接）")
    # 作废旧页后「回到第一页 50 项」同样是异步的：有界等真落地再断言后面两条。
    deadline = time.time() + 20
    while time.time() < deadline and count(page, "[data-ledger-item]") != 50:
        page.wait_for_timeout(250)
    ok(count(page, "[data-ledger-item]") == 50, "H：版本失效后旧页作废、回到第一页（没有把两版并在一起）")
    ok(attr(page, h_sum, "data-ledger-complete") == "0", "H：重读第一页后仍未读完")
    page.unroute("**/feature-ledger*")

    # ═══════════ S12 补充需求草稿语义（复审 2） ═══════════
    info("S12 「我补充一个需求」草稿：失败保留 / 成功才清 / 发送中编辑不丢 / 切项目不串")
    sup_in = "[data-ledger-supplement-input]"
    open_design(page, base, P["D"], wait=1000)
    page.route("**/discuss", discuss_post_handler("fail", []))
    page.fill(sup_in, "失败也要保住这段")
    page.locator("[data-ledger-supplement-submit]").click()
    wait_until(page, lambda: count(page, "[data-ledger-supplement-error]") == 1)
    ok(count(page, "[data-ledger-supplement-error]") == 1, "S12：补充失败显式报错")
    ok(input_val(page, sup_in) == "失败也要保住这段", "S12：失败后草稿原样保留（可重试，不丢字）")
    page.unroute("**/discuss")

    page.fill(sup_in, "成功这一段会被清掉")
    page.locator("[data-ledger-supplement-submit]").click()
    wait_until(page, lambda: count(page, "[data-ledger-supplement-note]") == 1)
    ok(count(page, "[data-ledger-supplement-note]") == 1, "S12：成功后有回执（进入待议，不自动采纳）")
    ok(input_val(page, sup_in) == "", "S12：成功后清掉所属项目的草稿")

    held2 = []
    page.route("**/discuss", discuss_post_handler("hold", held2))
    page.fill(sup_in, "第一次提交的内容")
    page.locator("[data-ledger-supplement-submit]").click()
    # 提交请求是异步被拦下的：先**有界等**它真在途，再断言刚好一笔（固定 sleep 会数到 0 笔）。
    wait_until(page, lambda: len(held2) >= 1)
    page.fill(sup_in, "发送期间新写的内容")
    ok(len(held2) == 1, "S12：提交请求确实在途（--故障注入：挂起）")
    held2.pop(0).continue_()
    wait_until(page, lambda: input_val(page, sup_in) == "发送期间新写的内容")
    ok(input_val(page, sup_in) == "发送期间新写的内容", "S12：发送期间继续编辑的新文案不被清掉")
    page.unroute("**/discuss")

    held3 = []
    page.route("**/discuss", discuss_post_handler("hold", held3))
    page.fill(sup_in, "迟到成功的这段")
    page.locator("[data-ledger-supplement-submit]").click()
    wait_until(page, lambda: len(held3) >= 1)
    open_design(page, base, P["B"], wait=900)
    page.fill(sup_in, "B 项目自己的草稿")
    open_design(page, base, P["D"], wait=900)
    ok(len(held3) == 1, "S12：迟到请求仍在途")
    held3.pop(0).continue_()
    # 迟到回包落地的效果是「什么都不该变」：有界等它落地后仍按**实际读数**断言（不放宽判据）。
    wait_until(page, lambda: input_val(page, sup_in) == "迟到成功的这段")
    ok(input_val(page, sup_in) == "迟到成功的这段",
       "S12：切走又切回后的迟到成功不清所属项目草稿（A→B→A 按代际丢弃）")
    ok(count(page, "[data-ledger-supplement-note]") == 0, "S12：迟到成功不把回执写进当前界面")
    page.unroute("**/discuss")
    open_design(page, base, P["B"], wait=900)
    ok(input_val(page, sup_in) == "B 项目自己的草稿", "S12：切项目草稿各存各的（不串）")

    # ═══════════ S4 失效与失败语义（chk-05） ═══════════
    info("S4 失败语义（422 / 无设计 / 503 + 重试 / unsupported）")
    open_design(page, base, P["A3"])
    ok(count(page, "[data-ledger-error]") == 1, "A3：声明区无法解析 ⇒ 显式报错（不空成功）")
    e_text = txt(page, "[data-ledger-error]") or ""
    ok("422" in e_text or "SOURCE_INVALID" in e_text, "A3：错误带 HTTP 状态/错误码（%s）" % e_text.strip()[:60])
    ok(count(page, "[data-ledger-item]") == 0, "A3：失败时**不**渲染空 items 冒充成功")

    open_design(page, base, P["A2"])
    ok(count(page, "[data-design-missing]") == 1, "A2：无设计书 ⇒ 正文显式缺设计态")
    ok(count(page, "[data-ledger-error]") == 1, "A2：无声明区 ⇒ 清单显式报错（不隐藏）")

    # 503 → 读取失败 + 重试；重试（撤掉拦截）后恢复
    open_design(page, base, P["B"])
    page.route(
        "**/feature-ledger*",
        lambda route: route.fulfill(status=503, content_type="application/json",
                                    body=json.dumps({"ok": False, "status": 503, "code": "SOURCE_UNAVAILABLE",
                                                     "message": "夹具注入：事实来源读取失败"})),
    )
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("[data-design-view]", timeout=30000)
    wait_until(page, lambda: count(page, "[data-ledger-error]") == 1)
    ok(count(page, "[data-ledger-error]") == 1, "B+503：读取失败显式报（不默认空成功）")
    ok("503" in (txt(page, "[data-ledger-error]") or ""), "B+503：错误显示状态码 503")
    ok(count(page, "[data-ledger-unsupported]") == 0, "B+503：503 不误报「未接入」（与旧服务分开）")
    ok(count(page, "[data-ledger-retry]") == 1, "B+503：带重试入口")
    page.unroute("**/feature-ledger*")
    page.locator("[data-ledger-retry]").click()
    wait_until(page, lambda: count(page, '[data-ledger-item="cap-b"]') == 1)
    ok(count(page, '[data-ledger-item="cap-b"]') == 1, "B+503：重试后恢复（错误清除、清单回来）")

    # ═══════════ S5 窄窗与主区可达（chk-06） ═══════════
    info("S5 窄窗与主区（异常默认可见、列表可折叠、详情限高独立滚动）")
    page.set_viewport_size({"width": 380, "height": 720})
    open_design(page, base, P["F"], wait=1200)
    # 待决块随（异步读回的）清单一起渲染：有界等它真在场再断言，别让固定 sleep 决定这组结论。
    wait_until(page, lambda: count(page, "[data-ledger-attention]") == 1, timeout_s=20)
    ok(count(page, "[data-ledger-attention]") == 1, "窄窗：真需要你决定的项仍默认在场")
    ok((box(page, "[data-design-body]") or {}).get("w", 0) > 0, "窄窗：正文主区仍可达（宽度>0）")
    ok(count(page, "[data-ledger-list]") == 1, "窄窗：默认展开清单")
    page.locator("[data-ledger-list-toggle]").click()
    page.wait_for_timeout(300)
    ok(count(page, "[data-ledger-list]") == 0, "窄窗：清单可收起")
    ok(count(page, "[data-ledger-attention]") == 1, "窄窗：清单收起后待决项**仍可见**")
    page.locator("[data-ledger-list-toggle]").click()
    page.wait_for_timeout(300)
    ok(count(page, "[data-ledger-list]") == 1, "窄窗：清单可再展开")
    # 截图前把概览（含「需要你看一眼」）滚进视野：窄窗证据要看得见真需要人决定的项
    page.locator("[data-feature-overview]").scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    ok((box(page, "[data-ledger-attention]") or {}).get("y", -1) >= 0, "窄窗：待决项在可视区内（截图能看到）")
    page.screenshot(path=os.path.join(OUT, "narrow-380.png"))

    page.set_viewport_size({"width": 1600, "height": 950})
    open_design(page, base, P["B"], wait=1200)
    page.wait_for_selector('[data-ledger-item="cap-b"] [data-ledger-detail]', timeout=30000)
    page.wait_for_timeout(800)
    main_before = box(page, "[data-design-body]")
    page.locator('[data-ledger-item="cap-b"] [data-ledger-detail] summary').click()
    page.wait_for_timeout(400)
    main_after = box(page, "[data-design-body]")
    ok((main_before or {}).get("h") == (main_after or {}).get("h"), "详情展开**不吃掉主区**（正文高度不变）")
    sc = page.evaluate(
        """() => { const b = document.querySelector('[data-ledger-item="cap-b"] [data-ledger-detail-body]');
             return b ? {scrollH: b.scrollHeight, clientH: b.clientHeight, overflow: getComputedStyle(b).overflowY} : null; }"""
    )
    ok(sc is not None and sc["clientH"] > 0, "详情体可见且有高度（%s）" % (sc and sc["clientH"]))
    ok(sc is not None and sc["overflow"] in ("auto", "scroll"), "详情体独立滚动（overflow-y=%s）" % (sc and sc["overflow"]))

    # ═══════════ S6 只读红线 · 补充待议 · 旧客户端（chk-07） ═══════════
    info("S6 只读红线 / 补充需求复用待议只追加 / 旧服务未接入")
    open_design(page, base, P["D"])
    ok(count(page, '[data-feature-ledger] [contenteditable="true"]') == 0, "只读红线：清单没有可编辑区")
    ok(count(page, "[data-ledger-status-edit]") == 0, "只读红线：没有「改功能状态/涂色」入口")
    ok(count(page, '[data-feature-ledger] button:has-text("改状态")') == 0, "只读红线：清单里没有「改状态」按钮（说明文字里出现不算入口）")
    ok(count(page, '[data-feature-ledger] input[type="color"]') == 0, "只读红线：清单里没有取色器（不涂色）")

    # 补充草稿刷新不丢（按项目保存）
    page.locator("[data-ledger-supplement-input]").fill("刷新前草稿：请补一条需求")
    page.wait_for_timeout(200)
    page.reload(wait_until="domcontentloaded")
    # 刷新后同样是异步重取：先**确认回到本项目设计页**并等清单就绪，再读输入框
    # （不认项目身份的话，固定 sleep 可能读到还没替换掉的上一份 DOM / 读空挂 30s）。
    page.locator('button[data-view="design"]').click()
    wait_project_ready(page, P["D"])
    page.wait_for_selector("[data-ledger-supplement-input]", timeout=30000)
    wait_until(page, lambda: input_val(page, "[data-ledger-supplement-input]") is not None)
    ok("刷新前草稿" in (input_val(page, "[data-ledger-supplement-input]") or ""), "刷新不丢未提交草稿（补充需求输入框）")
    before_badge = page.inner_text("[data-discuss-badge]") if count(page, "[data-discuss-badge]") else "0"
    page.locator("[data-ledger-supplement-input]").fill("补充需求：夹具追加一条待议（B6 UI 验证）")
    page.locator("[data-ledger-supplement-submit]").click()
    wait_until(page, lambda: count(page, "[data-ledger-supplement-note]") == 1)
    ok(count(page, "[data-ledger-supplement-note]") == 1, "补充提交有回执（进入待议，不自动采纳）")
    disc = txt(page, "[data-discuss-view]") or ""
    ok("夹具追加一条待议" in disc, "补充进入「待议记录」（只追加；用户能看到去向入口）")

    # 旧客户端 / 未接入：404 NOT_FOUND 信封 ⇒ 显式「本功能未接入」，且不回退写路径
    open_design(page, base, P["B"])
    page.route(
        "**/feature-ledger*",
        lambda route: route.fulfill(status=404, content_type="application/json",
                                    body=json.dumps({"ok": False, "error": {"code": "NOT_FOUND", "message": "not found"}})),
    )
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("[data-design-view]", timeout=30000)
    wait_until(page, lambda: count(page, "[data-ledger-unsupported]") == 1)
    ok(count(page, "[data-ledger-unsupported]") == 1, "旧服务 404：显式报「本功能未接入」")
    ok(count(page, "[data-ledger-error]") == 0, "旧服务 404：不误报成普通读取失败")
    ok(count(page, "[data-design-body]") >= 1, "旧服务：设计正文照常可读（**不回退**任何写路径）")
    page.screenshot(path=os.path.join(OUT, "unsupported.png"), full_page=True)
    page.unroute("**/feature-ledger*")

    # ═══════════ S7 切项目不串 + 各自选择/草稿（chk-08 部分） ═══════════
    info("S7 切项目（各自版本选择/草稿、迟到响应不串数据）")
    open_design(page, base, P["D"])
    page.locator('[data-version-option="active"] input').click()
    # 换版本 = 换这一版的新读数：有界等正文真读到该档再断言（固定 sleep 会撞上还没重取的中间态）。
    wait_until(page, lambda: attr(page, "[data-design-current-mode]", "data-design-current-mode") == "active")
    ok(attr(page, "[data-design-current-mode]", "data-design-current-mode") == "active",
       "D：切到已审定基线（当前草稿→已审定基线）")
    open_design(page, base, P["B"])
    ok(attr(page, "[data-design-current-mode]", "data-design-current-mode") == "current",
       "B：新项目默认读到 current（不带 D 的选择）")
    ok(count(page, '[data-ledger-item="cap-b"]') == 1 and count(page, '[data-ledger-item="cap-d"]') == 0,
       "B：清单是 B 的项目数据（不串 D）")
    open_design(page, base, P["D"])
    ok(attr(page, "[data-design-current-mode]", "data-design-current-mode") == "active",
       "切回 D：版本选择按项目保留（仍是 active）")
    # 迟到响应不串：快速 A→D，最终 DOM 属 D。用**本项目身份 + 清单已就绪**当就绪信号
    # （固定 2000/1400ms 会撞上「旧 DOM 还没被替换」或「新数据还没落地」的中间态）。
    page.goto("%s/#p/%s" % (base, P["A"]), wait_until="domcontentloaded")
    page.goto("%s/#p/%s" % (base, P["D"]), wait_until="domcontentloaded")
    page.locator('button[data-view="design"]').click()
    wait_project_ready(page, P["D"])
    page.wait_for_selector("[data-feature-ledger]", timeout=30000)
    wait_sel(page, "[data-ledger-summary], [data-ledger-error], [data-ledger-unsupported], [data-ledger-not-derived]",
             timeout=30000)
    ok(count(page, '[data-ledger-item="cap-d"]') == 1 and count(page, '[data-ledger-item="cap-a"]') == 0,
       "快速切项目后最终 DOM 属 D（迟到旧响应不落地）")
    page.locator('[data-version-option="current"] input').click()
    wait_until(page, lambda: attr(page, "[data-design-current-mode]", "data-design-current-mode") == "current")

    # ═══════════ S14 源清单：真 HTTP 判绿 / 源变待复验 / 无关源不连坐（复审 7） ═══════════
    info("S14 真证据链：source_manifest 覆盖真实源码（HTTP 绿 → 改相关源待复验 → 无关源不连坐）")
    exp_d = EXP["D"]
    st, body = backend.api("/api/projects/%s/feature-ledger?document=current" % P["D"])
    http_d = None
    if st == 200:
        it_d = [i for i in body["ledger"]["items"] if i["item_id"] == "cap-d"]
        http_d = it_d[0] if it_d else None
    ok(http_d is not None, "S14：真 HTTP 读口返回 cap-d（HTTP %s）" % st)
    if http_d is not None:
        ok(http_d["verification"]["display_status"] == "verified" and http_d["verification"]["missing"] == [],
           "S14：真 HTTP 下 cap-d 验证通过且无缺口（不是靠 design 绑定冒充）")
        ent = http_d["verification"]["evidence_entry"]
        ok(bool(ent) and all(e["effective"] == "passed" for e in ent),
           "S14：逐条证据现读复核均为 passed（源清单覆盖的源码对得上）")
        ok(http_d["verification"]["effective_version"] is not None, "S14：带受检源版本（不是空）")
        dom_evidence["http_D_verified"] = {
            "display_status": http_d["verification"]["display_status"],
            "evidence_state": http_d["verification"]["evidence_state"],
            "passed_count": http_d["verification"]["passed_count"],
            "required_count": http_d["verification"]["required_count"],
            "evidence_entry": ent,
            "effective_version": http_d["verification"]["effective_version"],
        }
    open_design(page, base, P["D"], wait=1000)
    ok(attr(page, '[data-ledger-item="cap-d"]', "data-verification") == "verified", "S14：界面上 cap-d 为验证已通过")

    manifest_file = exp_d["manifest_file_abs"]
    unrelated_file = exp_d["unrelated_file_abs"]
    with open(manifest_file, encoding="utf-8", newline="") as f:
        original = f.read()
    # newline=""：字节级还原源文件（默认文本模式会把 \n 写成 \r\n，哈希就对不上了）
    with open(manifest_file, "w", encoding="utf-8", newline="") as f:
        f.write(original + "// 夹具改动：相关源码变了\n")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("[data-feature-ledger]", timeout=30000)
    # 现读复核（重算源指纹 → 判失效）是**异步**的：固定 sleep 会撞上还没重取完的中间态。
    # 有界等「该项真渲染出来**且**落到预期态」再断言；缺项时 attr 返回 None 会把
    # `!= "verified"` 蒙混过去，所以等的是「存在 + 状态」而不是只等元素出现。
    # 等不到仍按实际读数 FAIL，不放宽任何判据（2026-10-08 终态复跑：重载后 1400ms 硬断言是同一竞态）。
    capd = '[data-ledger-item="cap-d"]'
    wait_until(page, lambda: count(page, capd) == 1
               and attr(page, capd, "data-evidence-state") == "invalidated", timeout_s=25)
    ok(attr(page, capd, "data-verification") != "verified",
       "S14：改了**被清单覆盖**的源码 ⇒ 不再是验证通过")
    ok(attr(page, capd, "data-evidence-state") == "invalidated",
       "S14：证据状态如实标失效（旧绿转待复验）")
    ok("失效" in (txt(page, "[data-feature-overview]") or "") and "复验" in (txt(page, "[data-feature-overview]") or ""),
       "S14：界面上明说「之前验过的证据已失效，要复验」（不是静默掉绿）")
    page.screenshot(path=os.path.join(OUT, "source-changed.png"), full_page=True)
    snapshot_dom(page, "source_changed_D")
    with open(manifest_file, "w", encoding="utf-8", newline="") as f:
        f.write(original)
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("[data-feature-ledger]", timeout=30000)
    wait_until(page, lambda: count(page, capd) == 1
               and attr(page, capd, "data-verification") == "verified", timeout_s=25)
    ok(attr(page, capd, "data-verification") == "verified",
       "S14：把源码改回去（字节一致）⇒ 恢复验证通过（现读复核跟着内容走）")

    with open(unrelated_file, encoding="utf-8", newline="") as f:
        unrelated_original = f.read()
    with open(unrelated_file, "w", encoding="utf-8", newline="") as f:
        f.write(unrelated_original + "// 夹具改动：无关文件\n")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("[data-feature-ledger]", timeout=30000)
    wait_until(page, lambda: count(page, capd) == 1
               and attr(page, capd, "data-verification") == "verified", timeout_s=25)
    ok(attr(page, capd, "data-verification") == "verified",
       "S14：清单外的**无关源**变化不连坐（仍验证通过）")
    with open(unrelated_file, "w", encoding="utf-8", newline="") as f:
        f.write(unrelated_original)

    # ═══════════ S17 密度与待决计数（Codex R2 复审回归：真实第一页 50 项 / 37 项待注意 / 20 条待议重复挂 7 功能） ═══════════
    # 只看「有没有这个 class」证明不了：这里量**几何**（概览有界、正文与清单入口留在首屏、展开不吃主区）
    # 与**可访问性**（限高独立滚动、键盘可读、展开后全部可读），并拿 HTTP 真载荷独立复算计数口径。
    info("S17 大列表 + 同一待议重复挂载：概览有界 / 计数去重 / 明细按需展开且全部可读")
    JE = EXP["J"]
    JID = JE["project_id"]
    st_j, body_j = backend.api("/api/projects/%s/feature-ledger?document=current" % JID)
    ok(st_j == 200, "S17：真 HTTP 读口返回 J 第一页（HTTP %s）" % st_j)
    j_items = body_j["ledger"]["items"] if st_j == 200 else []
    exp_attention = expected_attention_ids(j_items)
    exp_unique, exp_links = expected_decision_tally(j_items)
    info("S17 真载荷：已载 %d 项 / 应然待注意 %d 项 / 待决去重 %s 项 / 关联 %d 处"
         % (len(j_items), len(exp_attention), exp_unique, exp_links))
    ok(len(j_items) == JE["page_size"] and len(exp_attention) > 30,
       "S17：夹具第一页 %d 项、其中 %d 项要人看（确实是一屏装不下的量）" % (len(j_items), len(exp_attention)))

    def attention_extra(sel):
        return page.evaluate(
            """(sel) => {
                 const e = document.querySelector(sel);
                 if (!e) return null;
                 return {
                   count: e.getAttribute('data-ledger-attention-count'),
                   preview: e.getAttribute('data-ledger-attention-preview'),
                   hidden: e.getAttribute('data-ledger-attention-hidden'),
                   head: (e.querySelector('[data-ledger-attention-head]') || {}).innerText || '',
                 };
               }""",
            sel,
        )

    def visible_attention_ids():
        # 只取**真渲染出来**的项：`getClientRects().length > 0` 在 Chromium 里对收起的
        # `<details>` 内容仍然成立（内容被 layout 进 DOM，只是不可见），会把 overflow 的 47 项
        # 也当成「可见」——首轮 1440 报「49 个可见」正是这个 selector 的错，不是产品把项漏出来。
        # `checkVisibility({checkVisibilityCSS:true})` 才认 `content-visibility`/折叠容器。
        return page.evaluate(
            """() => [...document.querySelectorAll('[data-ledger-attention-item]')]
                 .filter((e) => (typeof e.checkVisibility === 'function'
                     ? e.checkVisibility({ checkVisibilityCSS: true })
                     : e.getClientRects().length > 0 && !!e.offsetParent))
                 .map((e) => e.getAttribute('data-ledger-attention-item'))"""
        )

    for vw, vh, tag in ((1440, 900, "1440x900 宽屏"), (390, 844, "390x844 窄窗")):
        page.set_viewport_size({"width": vw, "height": vh})
        # 每个视口都**重载重进**：保证量的是默认收起态（上一视口展开过 details 会残留 DOM 态）
        open_design_fresh(page, base, JID, wait=1600)
        wait_until(page, lambda: count(page, "[data-ledger-item]") == 50
                   and count(page, "[data-ledger-attention]") == 1)
        ok(count(page, "[data-ledger-item]") == 50, "S17(%s)：第一页恰好 50 项（读口默认页大小）" % tag)
        ok(attr(page, "[data-ledger-summary]", "data-ledger-complete") == "0",
           "S17(%s)：分页未完成（读数不得自称全项目）" % tag)
        ok(count(page, "[data-ledger-attention]") == 1, "S17(%s)：待注意块默认在场" % tag)

        ex = attention_extra("[data-ledger-attention]")
        ok(ex is not None and ex["count"] == str(len(exp_attention)),
           "S17(%s)：待注意**总数保留**（DOM %s == 真载荷复算 %d）" % (tag, ex and ex["count"], len(exp_attention)))
        ok("当前已载入范围内" in (ex["head"] if ex else ""),
           "S17(%s)：分页未完成时计数明确限定在**当前已载入范围**，不称全项目" % tag)
        ok(ex is not None and ex["preview"] == "3" and ex["hidden"] == "1",
           "S17(%s)：默认只预览 3 项，其余标为「有未展开项」" % tag)

        # 待决计数：按稳定身份去重，不把重复挂载求和当问题数
        du = attr(page, "[data-overview-decisions]", "data-decision-unique")
        dl = attr(page, "[data-overview-decisions]", "data-decision-links")
        ok(du == str(exp_unique) and dl == str(exp_links),
           "S17(%s)：待决读数去重（唯一 %s == %s；关联 %s == %s）" % (tag, du, exp_unique, dl, exp_links))
        ov_txt = txt(page, "[data-feature-overview]") or ""
        ok("同一问题被 %d 处功能项关联" % exp_links in ov_txt and "只算一次" in ov_txt,
           "S17(%s)：明说同一待决关联多处、按问题只算一次" % tag)
        ok("有 %d 个待决问题" % exp_links not in ov_txt,
           "S17(%s)：**不**把关联处数冒充问题数（没有「有 %d 个待决问题」）" % (tag, exp_links))
        summ = txt(page, "[data-ledger-summary]") or ""
        ok("待决 %d 项" % exp_unique in summ and "关联 %d 处" % exp_links in summ,
           "S17(%s)：清单页眉同口径报待决（%s）" % (tag, summ[:80]))
        ok("共 50 项" not in summ, "S17(%s)：未载完时不报总数（不把本页当全项目）" % tag)

        # 默认（收起）几何：概览有界，正文与清单入口留在首屏
        ov = box(page, "[data-feature-overview]")
        dv = box(page, "[data-design-view]")
        body = box(page, "[data-design-body]")
        led = box(page, "[data-feature-ledger]")
        att = box(page, "[data-ledger-attention]")
        info("S17(%s) 收起几何：概览 h=%s / 待注意块 h=%s / 设计页 y=%s / 正文 y=%s / 清单 y=%s / 视口 h=%d"
             % (tag, ov and ov["h"], att and att["h"], dv and dv["y"], body and body["y"], led and led["y"], vh))
        # 待注意块恒为「3 项预览 + 一行展开入口」，与清单里有多少待注意项**无关**（390px 下每项折行约 3 行 ⇒ ~188px）
        ok(att is not None and att["h"] <= 260,
           "S17(%s)：收起时待注意块有界（h=%s ≤ 260，不再是一屏装不完的长列表）" % (tag, att and att["h"]))
        # 概览有界：宽屏固定上限；窄窗折行后仍必须**不超过一屏**（要求是「不被 37+ 提醒拖几屏」）
        if vw >= 1100:
            ok(ov is not None and ov["h"] <= 420,
               "S17(%s)：收起时概览有界（h=%s ≤ 420）" % (tag, ov and ov["h"]))
        else:
            ok(ov is not None and ov["h"] <= vh,
               "S17(%s)：收起时概览不超过一屏（h=%s ≤ 视口 %d；不随待注意条数变长）" % (tag, ov and ov["h"], vh))
        # 正文**相对设计页顶部**的位置：这才是「提醒有没有把主内容推下去」的判据。
        # 不能用绝对 y（窄窗 app 壳——侧栏/项目列表——本身就占几百 px，与被测的提醒无关）。
        if body is not None and dv is not None:
            info("S17(%s) 正文距设计页顶 %s px（壳内位置；与提醒无关的头部/版本选择器也在这段里）"
                 % (tag, body["y"] - dv["y"]))
        if vw >= 1100:
            ok(body is not None and body["y"] < vh,
               "S17(%s)：设计正文**首屏可见**（y=%s < %d，没被待注意列表挤出首屏）" % (tag, body and body["y"], vh))
            ok(led is not None and led["y"] < vh,
               "S17(%s)：功能清单入口**首屏可见**（y=%s < %d）" % (tag, led and led["y"], vh))
        else:
            ok(dv is not None and body is not None and body["y"] - dv["y"] <= vh,
               "S17(%s)：窄窗正文落在设计页首屏内（距页顶 %s ≤ %d；提醒没把它拖开几屏）"
               % (tag, body and dv and body["y"] - dv["y"], vh))
        if vw < 1100:
            # 窄窗是单列堆叠：清单在**正文之后**，它的 y 由正文长度决定，跟提醒无关。
            # 能证明「提醒没夹在中间」的是：清单紧贴正文末尾（中间只隔一点间距）。
            ok(led is not None and body is not None and 0 <= led["y"] - (body["y"] + body["h"]) <= 240,
               "S17(%s)：窄窗单列下清单紧跟正文（间隔 %s ≤ 240；提醒/明细没夹在正文与清单之间）"
               % (tag, led and body and led["y"] - (body["y"] + body["h"])))
        ok(body is not None and ov is not None and ov["y"] + ov["h"] <= body["y"],
           "S17(%s)：概览不压住正文（概览底 ≤ 正文顶）" % tag)

        # 收起时明细**不显示**（真正收起来，不是只藏一半）
        ok(page.locator("[data-ledger-attention-more]").get_attribute("open") is None,
           "S17(%s)：全部明细的 <details> 默认收起" % tag)
        ok(not page.locator("[data-ledger-attention-list-all]").is_visible(),
           "S17(%s)：收起时滚动区确实不可见（未渲染进首屏）" % tag)
        vis_ids = visible_attention_ids()
        ok(len(vis_ids) == 3 and set(vis_ids) == set(exp_attention[:3]),
           "S17(%s)：收起时**只**显示前 3 项（%d 个可见，且是清单顺序的前 3 项）" % (tag, len(vis_ids)))
        ok(len(vis_ids) == 3 and len(set(vis_ids)) == 3, "S17(%s)：概览项不重复渲染（3 个 id 各不相同）" % tag)
        snap_key = "dense_%s_collapsed" % vw
        page.screenshot(path=os.path.join(OUT, "dense-%d-collapsed.png" % vw))
        if vw == 1440:
            snapshot_dom(page, snap_key)

        # 展开：读到**全部**真项（一条不删、不截断），且限高独立滚动、键盘可读，不吃掉主区
        body_h_before = (box(page, "[data-design-body]") or {}).get("h")
        ov_h_before = (box(page, "[data-feature-overview]") or {}).get("h")
        page.locator("[data-ledger-attention-more-summary]").click()
        page.wait_for_timeout(400)
        ok(page.locator("[data-ledger-attention-more]").get_attribute("open") is not None,
           "S17(%s)：点开「查看全部」后 details 展开" % tag)
        open_summary = txt(page, "[data-ledger-attention-more-summary]") or ""
        ok("查看全部 %d 项" % len(exp_attention) in open_summary,
           "S17(%s)：展开入口写明总数（%s）" % (tag, open_summary.strip()))
        vis_after = visible_attention_ids()
        ok(len(vis_after) == len(exp_attention) and set(vis_after) == set(exp_attention),
           "S17(%s)：展开后**全部** %d 项都显示、且逐条对得上真载荷（去重后无缺无多）"
           % (tag, len(exp_attention)))
        ok(len(set(vis_after)) == len(vis_after),
           "S17(%s)：预览项与展开项不重复（合起来正好 %d 个不同 id）" % (tag, len(vis_after)))
        sc = page.evaluate(
            """() => { const b = document.querySelector('[data-ledger-attention-list-all]');
                 if (!b) return null;
                 const cs = getComputedStyle(b);
                 return {scrollH: b.scrollHeight, clientH: b.clientHeight,
                         overflowY: cs.overflowY, tabindex: b.getAttribute('tabindex')}; }"""
        )
        ok(sc is not None and sc["overflowY"] in ("auto", "scroll") and sc["scrollH"] > sc["clientH"],
           "S17(%s)：展开区**限高独立滚动**（scrollH %s > clientH %s，overflow-y=%s）"
           % (tag, sc and sc["scrollH"], sc and sc["clientH"], sc and sc["overflowY"]))
        ok(sc is not None and sc["tabindex"] == "0", "S17(%s)：滚动区可键盘聚焦（tabindex=%s）" % (tag, sc and sc["tabindex"]))
        ov_h_after = (box(page, "[data-feature-overview]") or {}).get("h")
        body_h_after = (box(page, "[data-design-body]") or {}).get("h")
        info("S17(%s) 展开几何：概览 h %s → %s / 正文 h %s → %s" % (tag, ov_h_before, ov_h_after, body_h_before, body_h_after))
        ok(ov_h_after is not None and ov_h_before is not None and ov_h_after - ov_h_before <= 260,
           "S17(%s)：展开后概览**仍有界**（增量 %s ≤ 260，不随 50 项无限长）"
           % (tag, (ov_h_after or 0) - (ov_h_before or 0)))
        ok(body_h_before == body_h_after, "S17(%s)：展开明细**不吃掉主区**（正文高度不变）" % tag)
        # 键盘真读：聚焦滚动区后用 PageDown 能真滚下去，末尾一项可读
        page.locator("[data-ledger-attention-list-all]").focus()
        focused = page.evaluate("""() => document.activeElement && document.activeElement.getAttribute('data-ledger-attention-list-all') !== null""")
        ok(focused, "S17(%s)：滚动区能拿到焦点（键盘可达）" % tag)
        page.keyboard.press("PageDown")
        page.wait_for_timeout(300)
        scrolled = page.evaluate("""() => { const b = document.querySelector('[data-ledger-attention-list-all]'); return b ? b.scrollTop : -1; }""")
        ok(scrolled > 0, "S17(%s)：聚焦后 PageDown 真的滚动了明细（scrollTop=%s）" % (tag, scrolled))
        page.evaluate("""() => { const b = document.querySelector('[data-ledger-attention-list-all]');
             if (b) b.scrollTop = b.scrollHeight; }""")
        page.wait_for_timeout(200)
        last_txt = page.evaluate(
            """() => { const all = [...document.querySelectorAll('[data-ledger-attention-item]')];
                 const e = all[all.length - 1]; return e ? e.innerText.trim() : null; }"""
        )
        last_expected = [i for i in j_items if i["item_id"] == exp_attention[-1]][0]["display_name"]
        ok(last_txt is not None and last_txt.startswith(last_expected),
           "S17(%s)：滚到底能读到**最后一项**（%s）" % (tag, (last_txt or "")[:40]))
        page.screenshot(path=os.path.join(OUT, "dense-%d-expanded.png" % vw))
        if vw == 1440:
            snapshot_dom(page, "dense_1440_expanded")

    # 计数口径的**防御分支**：身份不稳定（decision_id 为空）时不得假装去重，改口「关联次数」
    info("S17b 待决身份不稳定时的诚实口径（--故障注入：把 decision_id 抹空）")
    page.set_viewport_size({"width": 1440, "height": 900})
    mut = json.loads(json.dumps(body_j))
    for it in mut["ledger"]["items"]:
        for d in it["pending_decisions"]:
            d["decision_id"] = ""
    mutated_ids = sum(1 for it in mut["ledger"]["items"] for d in it["pending_decisions"])
    mut_links = mutated_ids  # 关联处数在抹空身份后不变
    served = []

    def serve_mutated(route_, request):
        # 只有**真重载**才会走到这里：上一版 `open_design`（同 URL 不导航）根本不会再请求，
        # 结果比的是界面上残留的**旧异步数据**，注入形同虚设（首轮 S17b 三条全假绿的假失败）。
        served.append(request.url)
        route_.fulfill(status=200, content_type="application/json",
                       body=json.dumps({"ok": True, "ledger": mut["ledger"]}))

    page.route("**/feature-ledger*", serve_mutated)
    console_mark = len(console_errors)
    open_design_fresh(page, base, JID, wait=1400)
    ok(len(served) >= 1, "S17b：真读到**注入版**（拦截已生效，不是复用旧异步数据；命中 %d 次）" % len(served))
    ok(mut_links == exp_links, "S17b：注入只抹身份、不改关联处数（%d == %d）" % (mut_links, exp_links))
    ok(attr(page, "[data-overview-decisions]", "data-decision-unique") == "",
       "S17b：身份不可用时**不假装去重**（data-decision-unique 为空）")
    decb = txt(page, "[data-overview-decisions]") or ""
    ok("关联次数计、不做去重" in decb, "S17b：改文案「按关联次数计、不做去重」（不凭中文标题去重）")
    ok("个待决问题" not in decb and ("待决关联 %d 处" % exp_links) in decb,
       "S17b：只报关联处数、不把它说成问题数（%s）" % decb[:60])
    # 身份为空时**不能**因此丢项或撞 React key（同一 ul 里全空 key ⇒ 重复/漏渲染）：
    # 逐项数一遍待决行，并确认这段没有新的「same key」告警。
    per_item = count(page, '[data-ledger-item="cap-j001"] [data-ledger-decision]')
    total_dec = count(page, "[data-ledger-decision]")
    ok(per_item == len(mut["ledger"]["items"][0]["pending_decisions"]),
       "S17b：身份为空也**不丢项**（首项待决行 %d == 真载荷 %d）"
       % (per_item, len(mut["ledger"]["items"][0]["pending_decisions"])))
    ok(total_dec == mut_links, "S17b：全页待决行 %d == 关联处数 %d（一条不少）" % (total_dec, mut_links))
    key_warn = [e for e in console_errors[console_mark:] if "same key" in e or "two children" in e]
    ok(not key_warn, "S17b：身份不稳时不撞 React key（新出现的重复 key 告警 %d 条）" % len(key_warn))
    page.unroute("**/feature-ledger*")

    # ═══════════ S19 待决长列表默认折叠（真实 R4 缺陷：单项被 20 条重复待决撑到 6487px） ═══════════
    # 现场（E/post-closure/TATAI-final-feature-list-visible.png）：R4 全部 7 项 verified，
    # 但每一项默认平铺 20 条长待决（同一份待议逐功能重复挂载），功能列表根本扫不动。
    # 修法口径：名称/描述/四维/重要缺口/待决**数量**常显，完整长列表进原生 `<details>`（默认关闭，
    # **一条不删、身份不改、不改变验证判定**）。这里量：默认折叠、单项可扫描、键盘能展开并读到全部、
    # 四维与来源链接不回归，并用「去掉限高后全部展开」复现修复前几何作对照。
    info("S19 待决长列表默认折叠：可扫描 / 一条不删 / 键盘可达 / 四维与来源不回归")
    dec_items = [i["item_id"] for i in j_items if i["pending_decisions"]]
    dec_expect = {i["item_id"]: len(i["pending_decisions"]) for i in j_items if i["pending_decisions"]}
    ref_expect = sum(len(i["design_section_refs"]) for i in j_items)
    ok(len(dec_items) >= 7,
       "S19：夹具里有 %d 项挂了待决（覆盖真实 R4「7 项各挂 20 条」的量级）" % len(dec_items))

    VISIBLE_JS = """(sel) => [...document.querySelectorAll(sel)]
        .filter((e) => (typeof e.checkVisibility === 'function'
            ? e.checkVisibility({ checkVisibilityCSS: true })
            : e.getClientRects().length > 0 && !!e.offsetParent)).length"""

    for vw, vh, tag in ((1440, 900, "1440x900 宽屏"), (390, 844, "390x844 窄窗")):
        page.set_viewport_size({"width": vw, "height": vh})
        load_wait = 1600 if vw >= 1100 else 2200
        open_design_fresh(page, base, JID, wait=load_wait)
        # 与 S17/S18 同款：整页重载后第一页 50 项是**异步**落地的，先有界等真落地再量
        # （真加载不出来仍按实际读数 FAIL，不放宽任何判据）。
        deadline = time.time() + 15
        while time.time() < deadline and count(page, "[data-ledger-item]") != JE["page_size"]:
            page.wait_for_timeout(250)
        first = dec_items[0]
        first_item = '[data-ledger-item="%s"]' % first
        ok(count(page, "[data-ledger-item]") == JE["page_size"],
           "S19(%s)：第一页 %d 项在场（与 S17 同载荷）" % (tag, JE["page_size"]))

        # ① 默认全部收起：一个入口都不得默认铺开
        det = count(page, "[data-ledger-decisions-details]")
        opened = count(page, "[data-ledger-decisions-details][open]")
        ok(det == len(dec_items),
           "S19(%s)：挂了待决的项各有一个展开入口（%d == %d）" % (tag, det, len(dec_items)))
        ok(opened == 0, "S19(%s)：待决完整长列表**默认全部收起**（open 的入口 %d 个）" % (tag, opened))
        in_dom = count(page, "[data-ledger-decision]")
        ok(in_dom == exp_links,
           "S19(%s)：待决行仍在 DOM（%d == 关联处数 %d，一条不删）" % (tag, in_dom, exp_links))
        vis_dec = page.evaluate(VISIBLE_JS, "[data-ledger-decision]")
        ok(vis_dec == 0, "S19(%s)：默认**可见**的待决行 = 0（真收起，不是藏一半）" % tag)

        # ② 数量与摘要常显（「待决默认可见」由数量+摘要满足，不把问题藏没）
        itxt = txt(page, first_item) or ""
        ok("本项关联 %d 个待决问题" % dec_expect[first] in itxt,
           "S19(%s)：本项待决**数量常显**（%s）" % (tag, [l for l in itxt.splitlines() if "待决问题" in l][:1]))
        dsum = txt(page, "%s [data-ledger-decisions-summary]" % first_item) or ""
        ok("查看本项关联的 %d 个待决问题" % dec_expect[first] in dsum,
           "S19(%s)：展开入口写明条数（%s）" % (tag, dsum.strip()))
        ok(page.evaluate(
            """(s) => { const e = document.querySelector(s); if (!e) return false;
                 return typeof e.checkVisibility === 'function'
                   ? e.checkVisibility({ checkVisibilityCSS: true }) : e.getClientRects().length > 0; }""",
            "%s [data-ledger-decision]" % first_item,
        ) is False,
           "S19(%s)：默认态本项第一条待决**不可见**（只在展开入口之后，不铺首屏）" % tag)

        # ③ 可扫描：单项高度有界；前 7 项（真实 R4 量级）总高在几屏内
        heights = page.evaluate(
            """(ids) => ids.map((id) => { const e = document.querySelector(`[data-ledger-item="${id}"]`);
                 return e ? Math.round(e.getBoundingClientRect().height) : -1; })""",
            dec_items,
        )
        cap = 420 if vw >= 1100 else 640
        ok(min(heights) > 0 and max(heights) <= cap,
           "S19(%s)：单项高度有界（最大 %d px ≤ %d；%d 项都可扫描）"
           % (tag, max(heights), cap, len(heights)))
        top7 = heights[:7]
        ok(sum(top7) <= len(top7) * cap,
           "S19(%s)：前 %d 项待决项总高 %d px ≤ %d×%d（不必滚过几万像素）"
           % (tag, len(top7), sum(top7), len(top7), cap))
        info("S19(%s) 收起几何：单项高 min=%d/max=%d px，%d 项合计 %d px"
             % (tag, min(heights), max(heights), len(heights), sum(heights)))
        collapsed_h = max(heights)

        # ⑤ 四维与来源链接不回归（折叠只动待决长列表的呈现位置）
        # 整页重载/HMR 扰动会让 DOM 短暂缺项：先**有界**等这批项都渲染出来再读（真缺项仍如实 FAIL，
        # 不放宽判据）。原写法读缺失项会返回 null，随后 `d["name"]` 直接抛 TypeError 打断整段。
        deadline = time.time() + 10
        while time.time() < deadline:
            present = page.evaluate(
                """(ids) => ids.filter((id) => document.querySelector(`[data-ledger-item="${id}"]`)).length""",
                dec_items,
            )
            if present == len(dec_items):
                break
            page.wait_for_timeout(250)
        dims = page.evaluate(
            """(ids) => ids.map((id) => { const e = document.querySelector(`[data-ledger-item="${id}"]`);
                 return e ? {dim: e.querySelectorAll('[data-ledger-dims] [data-ledger-dim]').length,
                             name: (e.querySelector('[data-ledger-item-name]') || {}).textContent || '',
                             refs: e.querySelectorAll('[data-ledger-ref]').length} : null; })""",
            dec_items,
        )
        ok(all(d is not None and d["dim"] == 4 for d in dims),
           "S19(%s)：每项四维仍在（%d 项全部 4 维）" % (tag, len(dims)))
        ok(all(d is not None and (d["name"] or "").strip() != "" for d in dims),
           "S19(%s)：每项名称仍在（不空）" % tag)
        ref_n = page.evaluate("() => document.querySelectorAll('[data-ledger-ref]').length")
        ok(ref_n == ref_expect,
           "S19(%s)：来源/设计章节链接数不变（%d == 真载荷 %d）" % (tag, ref_n, ref_expect))
        ref_st = page.evaluate(
            """() => [...document.querySelectorAll('[data-ledger-ref]')]
                 .map((e) => e.getAttribute('data-ledger-ref-status'))
                 .filter((s) => s !== 'located' && s !== 'unresolved').length"""
        )
        ok(ref_st == 0, "S19(%s)：来源链接状态只有 located/unresolved 两态（异常 %d）" % (tag, ref_st))

        # ⑥ 键盘展开：默认关闭 → Enter 打开 → 焦点进滚动区 → PageDown 真滚 → 滚到底读到最后一条
        dsel = "%s [data-ledger-decisions-summary]" % first_item
        page.locator(dsel).focus()
        ok(page.evaluate("(s) => document.activeElement === document.querySelector(s)", dsel),
           "S19(%s)：展开入口可键盘聚焦" % tag)
        ok(page.locator("%s [data-ledger-decisions-details]" % first_item).get_attribute("open") is None,
           "S19(%s)：敲键前本项入口确为**默认收起**（键盘用例前置）" % tag)
        page.keyboard.press("Enter")
        page.wait_for_timeout(300)
        ok(page.locator("%s [data-ledger-decisions-details]" % first_item).get_attribute("open") is not None,
           "S19(%s)：Enter 键展开待决长列表" % tag)
        vis_after = page.evaluate(VISIBLE_JS, "%s [data-ledger-decision]" % first_item)
        ok(vis_after == dec_expect[first],
           "S19(%s)：展开后本项 %d 条待决全部渲染（== 真载荷 %d）" % (tag, vis_after, dec_expect[first]))
        bsel = "%s [data-ledger-decisions-body]" % first_item
        sc = page.evaluate(
            """(s) => { const b = document.querySelector(s); if (!b) return null;
                 const cs = getComputedStyle(b);
                 return {scrollH: b.scrollHeight, clientH: b.clientHeight, overflowY: cs.overflowY,
                         tabindex: b.getAttribute('tabindex')}; }""",
            bsel,
        )
        ok(sc is not None and sc["overflowY"] in ("auto", "scroll") and sc["scrollH"] > sc["clientH"],
           "S19(%s)：展开区**限高独立滚动**（scrollH %s > clientH %s，overflow-y=%s）"
           % (tag, sc and sc["scrollH"], sc and sc["clientH"], sc and sc["overflowY"]))
        ok(sc is not None and sc["tabindex"] == "0", "S19(%s)：滚动区可键盘聚焦（tabindex=%s）" % (tag, sc and sc["tabindex"]))
        page.locator(bsel).focus()
        page.keyboard.press("PageDown")
        page.wait_for_timeout(300)
        scrolled = page.evaluate("(s) => { const b = document.querySelector(s); return b ? b.scrollTop : -1; }", bsel)
        ok(scrolled > 0, "S19(%s)：聚焦后 PageDown 真滚动待决区（scrollTop=%s）" % (tag, scrolled))
        page.evaluate("(s) => { const b = document.querySelector(s); if (b) b.scrollTop = b.scrollHeight; }", bsel)
        page.wait_for_timeout(200)
        last_txt = page.evaluate(
            """(id) => { const e = document.querySelector(`[data-ledger-item="${id}"]`);
                 const all = e ? [...e.querySelectorAll('[data-ledger-decision]')] : [];
                 const l = all[all.length - 1]; return l ? l.innerText.trim() : null; }""",
            first,
        )
        last_expect = dec_expect[first]
        ok(last_txt is not None and last_txt.startswith("待决："),
           "S19(%s)：滚到底能读到**最后一条**待决（本项共 %d 条；%s）"
           % (tag, last_expect, (last_txt or "")[:40]))
        page.screenshot(path=os.path.join(OUT, "decisions-%d-expanded.png" % vw))
        if vw == 1440:
            snapshot_dom(page, "decisions_1440_expanded")

        # ④ 折叠量级对照（放在最后，避免污染上面「默认收起 → 键盘展开」的用例）：
        # 把入口全开、再把限高去掉 ⇒ 复现修复前「平铺 20 条长待决」的几何。
        page.evaluate("() => document.querySelectorAll('[data-ledger-decisions-details]').forEach((d) => { d.open = true; })")
        page.wait_for_timeout(300)
        unfurl_all = page.evaluate(
            """(ids) => ids.map((id) => { const e = document.querySelector(`[data-ledger-item="${id}"]`);
                 if (!e) return -1;
                 e.querySelectorAll('[data-ledger-decisions-body]').forEach((b) => {
                   b.style.maxHeight = 'none'; b.style.overflow = 'visible';
                 });
                 return Math.round(e.getBoundingClientRect().height); })""",
            dec_items,
        )
        ok(unfurl_all[0] > collapsed_h * 5,
           "S19(%s)：折叠后单项 %d px；修前同一项平铺 20 条 ≈ %d px（量级差 %.1f× ≥ 5×）"
           % (tag, collapsed_h, unfurl_all[0], unfurl_all[0] / max(collapsed_h, 1)))
        info("S19(%s) 平铺对照：%d 项全开合计 %d px（修前量级），收起后合计 %d px"
             % (tag, len(unfurl_all), sum(unfurl_all), sum(heights)))
        page.reload(wait_until="domcontentloaded")

    # 收起态截图（修后首屏：功能列表可扫描）
    page.set_viewport_size({"width": 1440, "height": 900})
    open_design_fresh(page, base, JID, wait=1600)
    page.screenshot(path=os.path.join(OUT, "decisions-1440-collapsed.png"))
    page.set_viewport_size({"width": 390, "height": 844})
    open_design_fresh(page, base, JID, wait=2200)
    page.screenshot(path=os.path.join(OUT, "decisions-390-collapsed.png"))

    # ═══════════ S20 真实 R4 载荷（只读自调用方给定的 JSON 文件；不落仓库、不进源码） ═══════════
    # 现场就是这份读口的返回值：57 项、其中 7 项 cap-loop-* 全 verified、每项各挂同一份 20 条待议
    # （首屏单项被撑到 6487 px ⇒ 功能列表扫不动）。这里用**真实载荷**（经 env 路径只读，不写进代码、
    # 不提交）在两种视口下量同一组口径，并留截图作对照。载荷缺失时如实跳过，不冒充通过。
    real_path = os.environ.get("V0956_REAL_LEDGER", "").strip()
    real = None
    if real_path and os.path.isfile(real_path):
        with open(real_path, "r", encoding="utf-8") as f:
            real = json.load(f)
    if real is None:
        info("S20 跳过：未提供真实载荷（V0956_REAL_LEDGER=%r）— 本节只做夹具口径，不冒充真实载荷已验证" % real_path)
    else:
        rled = real.get("ledger", real)
        ritems = rled["items"]
        rgreen = [i["item_id"] for i in ritems
                  if i["verification"]["display_status"] == "verified"
                  and i["verification"]["evidence_state"] == "verified"]
        rdec = {i["item_id"]: len(i["pending_decisions"]) for i in ritems if i["pending_decisions"]}
        rrefs = sum(len(i["design_section_refs"]) for i in ritems)
        info("S20 真实载荷：%d 项 / 验证已通过 %d 项 / 挂待决 %d 项（各 %s 条）/ 来源引用 %d 处"
             % (len(ritems), len(rgreen), len(rdec), sorted(set(rdec.values())), rrefs))
        real_served = []

        def serve_real(route_, request):
            real_served.append(request.url)
            route_.fulfill(status=200, content_type="application/json", body=json.dumps(real))

        page.route("**/feature-ledger*", serve_real)
        for vw, vh, tag in ((1440, 900, "1440x900 宽屏"), (390, 844, "390x844 窄窗")):
            page.set_viewport_size({"width": vw, "height": vh})
            open_design_fresh(page, base, JID, wait=1600 if vw >= 1100 else 2400)
            ok(count(page, "[data-ledger-item]") == len(ritems),
               "S20(%s)：真实载荷 %d 项全部渲染（真读到注入版：%d 次命中）"
               % (tag, len(ritems), len(real_served)))
            ok(count(page, "[data-ledger-verified]") == len(rgreen),
               "S20(%s)：验证已通过的 %d 项在人话清单里**一眼可数**（绿色标记 %d 个）"
               % (tag, len(rgreen), len(rgreen)))
            ok(count(page, "[data-ledger-decisions-details][open]") == 0,
               "S20(%s)：待决长列表**默认全部收起**（open 入口 %d 个）" % (tag, 0))
            ok(count(page, "[data-ledger-decision]") == sum(rdec.values()),
               "S20(%s)：%d 条待决仍全在 DOM（一条不删）" % (tag, sum(rdec.values())))
            rh = page.evaluate(
                """(ids) => ids.map((id) => { const e = document.querySelector(`[data-ledger-item="${id}"]`);
                     return e ? Math.round(e.getBoundingClientRect().height) : -1; })""",
                list(rdec),
            )
            cap = 420 if vw >= 1100 else 640
            ok(min(rh) > 0 and max(rh) <= cap,
               "S20(%s)：修后每个已验证功能项高度 ≤ %d px（实测最大 %d px，修前现场该处为 6487 px）"
               % (tag, cap, max(rh)))
            first_real = list(rdec)[0]
            rsum = txt(page, '[data-ledger-item="%s"] [data-ledger-decisions-summary]' % first_real) or ""
            ok("查看本项关联的 %d 个待决问题" % rdec[first_real] in rsum,
               "S20(%s)：展开入口人话点名条数（%s）" % (tag, rsum.strip()))
            # 收起态截图：与 root 现场**同一份载荷**，可直接对照 E/post-closure 里 6487 px 的旧图。
            # 先滚到清单里的第一个已验收项，让视口落在**功能列表**上（不是页面顶部的概览）。
            def shot_list(name):
                page.evaluate(
                    """(id) => { const e = document.querySelector(`[data-ledger-item="${id}"]`);
                         if (e) e.scrollIntoView({ block: 'start' }); }""",
                    first_real,
                )
                page.wait_for_timeout(250)
                page.screenshot(path=os.path.join(OUT, name))

            shot_list("real-payload-%d-collapsed.png" % vw)
            rds = '[data-ledger-item="%s"] [data-ledger-decisions-summary]' % first_real
            page.locator(rds).focus()
            page.keyboard.press("Enter")
            page.wait_for_timeout(300)
            ok(page.locator('[data-ledger-item="%s"] [data-ledger-decisions-details]' % first_real)
               .get_attribute("open") is not None,
               "S20(%s)：真实载荷下键盘 Enter 也能展开" % tag)
            rvis = page.evaluate(VISIBLE_JS, '[data-ledger-item="%s"] [data-ledger-decision]' % first_real)
            ok(rvis == rdec[first_real],
               "S20(%s)：展开后 %d 条全部可达（== 真载荷 %d）" % (tag, rvis, rdec[first_real]))
            page.screenshot(path=os.path.join(OUT, "real-payload-%d-expanded.png" % vw))
            rdims = page.evaluate(
                """(ids) => ids.map((id) => { const e = document.querySelector(`[data-ledger-item="${id}"]`);
                     return e ? e.querySelectorAll('[data-ledger-dims] [data-ledger-dim]').length : -1; })""",
                list(rdec),
            )
            ok(all(d == 4 for d in rdims), "S20(%s)：真实载荷下每项四维仍在（%s）" % (tag, rdims))
            ok(page.evaluate("() => document.querySelectorAll('[data-ledger-ref]').length") == rrefs,
               "S20(%s)：来源/设计章节链接数 == 真载荷 %d 处" % (tag, rrefs))
            # 平铺对照：入口全开 + 去掉限高 ⇒ 复现修复前 6487 px 量级的单项几何
            page.evaluate("() => document.querySelectorAll('[data-ledger-decisions-details]').forEach((d) => { d.open = true; })")
            page.wait_for_timeout(400)
            runfurl = page.evaluate(
                """(ids) => ids.map((id) => { const e = document.querySelector(`[data-ledger-item="${id}"]`);
                     if (!e) return -1;
                     e.querySelectorAll('[data-ledger-decisions-body]').forEach((b) => {
                       b.style.maxHeight = 'none'; b.style.overflow = 'visible';
                     });
                     return Math.round(e.getBoundingClientRect().height); })""",
                list(rdec),
            )
            ok(max(runfurl) >= max(rh) * 5,
               "S20(%s)：折叠后最大 %d px vs 平铺 %d px（修前量级 %.0f×）"
               % (tag, max(rh), max(runfurl), max(runfurl) / max(max(rh), 1)))
            shot_list("real-payload-%d-unfurled.png" % vw)
        page.unroute("**/feature-ledger*")

    # ═══════════ S18 「查看功能清单」快捷入口（Codex 最终复核补口：长正文里一步到清单） ═══════════
    # 真实设计书正文很长（窄窗 2000+px），清单排在正文之后——root 看 run4 现场：390 窄窗正文 y1245、
    # 清单 y3313，用户得先滚过整本设计才找得到清单。这里证明：快捷入口**默认首段可见**、是**真按钮**
    # （键盘可达、无 href 不走锚点）、点击/键盘激活后**清单头真进入可视区且焦点落到清单根**，
    # 且 **URL/选中项目不变**（不碰 `#p/<项目>` 路由），清单自身折叠/分页照旧。
    info("S18 长正文里的「查看功能清单」快捷入口：一步可达 + 焦点落位 + 路由/清单不变")
    page.unroute("**/feature-ledger*")  # 双保险：不带着 S17b 的注入进这一节
    for vw, vh, tag, via in ((390, 844, "390x844 窄窗", "keyboard"), (1440, 900, "1440x900 宽屏", "click")):
        page.set_viewport_size({"width": vw, "height": vh})
        open_design_fresh(page, base, JID, wait=1600)
        # 与 S11/S19 同款：整页重载后清单一页 50 项是**异步**落地的，先**有界**等真落地再量，
        # 免掉「固定 1600ms 未及加载 ⇒ 快捷入口点了个还没渲染出来的清单 ⇒ 整组假失败」。
        # 真加载不出来仍按实际读数 FAIL，不放宽任何判据（2026-10-08 终态复跑：1440 档曾整组假失败）。
        deadline = time.time() + 15
        while time.time() < deadline and count(page, "[data-ledger-item]") != 50:
            page.wait_for_timeout(250)
        ok(count(page, "[data-overview-ledger-jump]") == 1,
           "S18(%s)：概览页眉有且仅有 1 枚「查看功能清单」快捷入口" % tag)
        jump = box(page, "[data-overview-ledger-jump]")
        ok(jump is not None and jump["y"] < vh,
           "S18(%s)：快捷入口默认首段可见（y=%s < 视口 %d，不必先遍历正文）" % (tag, jump and jump["y"], vh))
        jtag = page.evaluate(
            """() => { const b = document.querySelector('[data-overview-ledger-jump]');
                 return b ? {tag: b.tagName.toLowerCase(), href: b.getAttribute('href')} : null; }"""
        )
        ok(jtag is not None and jtag["tag"] == "button" and jtag["href"] is None,
           "S18(%s)：入口是**真按钮**且无 href（%s；定位不走裸锚点，不改 location.hash）"
           % (tag, jtag and jtag["tag"]))

        url_before = page.url
        body_before = box(page, "[data-design-body]")
        led_before = box(page, "[data-feature-ledger]")
        info("S18(%s) 激活前：正文 y=%s h=%s / 清单 y=%s / 视口 h=%d"
             % (tag, body_before and body_before["y"], body_before and body_before["h"],
                led_before and led_before["y"], vh))
        if vw < 1100:
            # 窄窗：单列下清单确实在长正文之后、默认落在视口外——这正是要修掉的「入口缺失」
            ok(led_before is not None and led_before["y"] >= vh and (body_before or {}).get("h", 0) > vh,
               "S18(%s)：清单默认在长正文（h=%s）之后的视口外（y=%s ≥ %d）"
               % (tag, body_before and body_before["h"], led_before and led_before["y"], vh))

        if via == "keyboard":
            page.locator("[data-overview-ledger-jump]").focus()
            ok(page.evaluate(
                """() => document.activeElement === document.querySelector('[data-overview-ledger-jump]')"""
            ), "S18(%s)：入口可用键盘聚焦" % tag)
            page.keyboard.press("Enter")
        else:
            page.locator("[data-overview-ledger-jump]").click()
        page.wait_for_timeout(600)

        led_after = box(page, "[data-feature-ledger]")
        head_after = box(page, "[data-feature-ledger] .tt-fl-title")
        ok(led_after is not None and 0 <= led_after["y"] < vh,
           "S18(%s)：激活后清单**头进入可视区**（y=%s ∈ [0,%d)）" % (tag, led_after and led_after["y"], vh))
        ok(head_after is not None and 0 <= head_after["y"] < vh,
           "S18(%s)：清单标题确在可视区（标题 y=%s ∈ [0,%d)）" % (tag, head_after and head_after["y"], vh))
        foc = page.evaluate(
            """() => { const a = document.activeElement;
                 return a ? {isLedger: a.hasAttribute('data-feature-ledger'),
                             tid: a.getAttribute('tabindex')} : null; }"""
        )
        ok(foc is not None and foc["isLedger"] and foc["tid"] == "-1",
           "S18(%s)：焦点落到**清单根**（可读目标：activeElement[data-feature-ledger], tabindex=%s）"
           % (tag, foc and foc["tid"]))
        ok(page.url == url_before,
           "S18(%s)：激活**不改 URL**（%s）" % (tag, page.url))
        ok(page.url.split("#")[-1] == "p/%s" % JID,
           "S18(%s)：仍停在 #p/<项目> 路由、选中项目不变" % tag)
        ok(count(page, "[data-ledger-list-toggle]") == 1
           and attr(page, "[data-ledger-summary]", "data-ledger-loaded") == "50",
           "S18(%s)：清单自身折叠/分页照旧（展开入口在场、第一页仍 50 项）" % tag)
        page.screenshot(path=os.path.join(OUT, "quick-entry-%d.png" % vw))

    # ═══════════ S16 截图与 DOM 证明 ═══════════
    info("S16 关键截图与 DOM 证明")
    page.set_viewport_size({"width": 1600, "height": 950})
    open_design(page, base, P["D"], wait=1400)
    # wide-firstscreen.png 已在 S9 拍下（干净的首次首屏）；这里补功能细节（清单详情）
    page.locator("[data-feature-ledger]").scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(OUT, "feature-details-ledger.png"))
    page.locator('[data-design-technical="baseline"]').scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(OUT, "feature-details-technical.png"))
    snapshot_dom(page, "final_D")
    open_design(page, base, P["A"], wait=1000)
    page.screenshot(path=os.path.join(OUT, "A-missing-design.png"), full_page=True)


if __name__ == "__main__":
    main()
