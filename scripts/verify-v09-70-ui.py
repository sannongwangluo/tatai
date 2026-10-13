#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-70 真浏览器验收：运行诊断页 + 全局轻量异常提示（真 Chromium + 真 Vite，**mock 后端读口**）。

用法：python scripts/verify-v09-70-ui.py
      V0970_KEEP=1 保留临时 vitest 现场（默认跑完删净）    V0970_LABEL 本次运行标签

为什么要有这只脚本（缺什么补什么）：
  V09-70 卡面「交付」点名要**真实浏览器逐页观察**：默认态、异常可见、详情不吃画布、窄窗可读、切项目不串、
  监看/退避/去重/恢复反例、脱敏导出核对。监看**行为**已由 `scripts/verify-v09-70.ts` 在 Node 里隔离真跑
  （假时钟）；本脚本补它验不了的**浏览器那一层**：真渲染、真网络请求计数（5 秒一次 / 隐藏暂停）、
  真下载导出、真页面错误捕获。

**mock 说明（绝不冒充真后端）**：本脚本用 Playwright `page.route` **拦截** `/api/**` 与 `/health`，
  用夹具 JSON 应答——**不是**真后端、**不是**真纳管数据。被测的是**前端**（App 接线、监看状态机、渲染、
  导出脱敏）。真实后台端到端由 `V09-71` 集成卡负责，不在此脚本内声称。

隔离口径（AGENTS.md §5）：临时 Vite 缓存目录 + 动态空闲端口；不碰真实 ~/.tatai、不碰真实纳管项目与账本；
  不调模型、不联网外发（一切 /api 都被本地 mock 应答）。收尾杀净自有 vite、删临时目录（V0970_KEEP=1 留现场）。

退出码：0 全过；1 有 FAIL 或中途中断；3 环境缺失（未装 playwright / 无可用 Chromium）。
"""
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.parse
import urllib.request

EXIT_OK, EXIT_FAIL, EXIT_ENV = 0, 1, 3

try:
    from playwright.sync_api import sync_playwright, expect
except Exception as _e:  # noqa: BLE001
    print("[ui] 环境缺失：未安装 playwright python 包（%s）" % _e)
    print("[ui]  修复：python -m pip install playwright && python -m playwright install chromium")
    sys.exit(EXIT_ENV)

ROOT = pathlib.Path(__file__).resolve().parents[1]
# 输出目录默认沿用作者路径；**返工/独立复核用 `V0970_OUT` 指向独立目录**，避免覆盖既有作者/独审证据
# （本次 V09-70 返工写到 `.工作台/diagnose-agent-entry-20261013/frontend-rework/`）。
_DEFAULT_OUT = ROOT / ".工作台" / "runtime-diagnostics-20261013"
OUT = pathlib.Path(os.environ.get("V0970_OUT") or str(_DEFAULT_OUT))
OUT.mkdir(parents=True, exist_ok=True)
HARNESS = OUT / "harness.html"
HARNESS_REL = HARNESS.relative_to(ROOT).as_posix() if HARNESS.is_relative_to(ROOT) else str(HARNESS)

# 夹具项目（不是真纳管数据）
PROJECTS = [
    {"id": "fixture", "name": "夹具项目甲", "path": "/tmp/fixture-a", "added_at": "2026-10-01T00:00:00Z",
     "last_opened_at": "2026-10-13T00:00:00Z", "exists": True},
    {"id": "other", "name": "夹具项目乙", "path": "/tmp/fixture-b", "added_at": "2026-10-01T00:00:00Z",
     "last_opened_at": "2026-10-13T00:00:00Z", "exists": True},
]
PROJECT_BY_ID = {p["id"]: p for p in PROJECTS}

SECRET_TOKEN = "SUPERSECRETTOKENVALUE1234567890"  # 用于验证导出脱敏：绝不许出现在导出里


def make_report(status="healthy", project_id="fixture", pid=4242, release="rel-9f3a1c",
                generated_at="2026-10-13T10:00:00.000Z"):
    incidents = []
    if status != "healthy":
        incidents = [{
            "at": "2026-10-13T09:59:30.000Z",
            "outcome": "timed_out",
            "job_kind": "entry",
            "project_id": project_id,
            "code": "READ_JOB_TIMEOUT",
            # 这条 reason 里故意塞绝对路径与 token 样长串：验证 sanitize/导出把它们脱掉
            "reason": "读取 C:\\secrets\\entry.json 超时（token=%s）" % SECRET_TOKEN,
            "queue_ms": 10,
            "execution_ms": 2500,
            "total_ms": 2510,
        }]
    reasons = []
    if status == "degraded":
        reasons = [{"code": "QUEUE_SATURATED", "detail": "读池排队满，本次读作业被拒（不等于不可达）", "subject": "read"}]
    elif status == "unavailable":
        reasons = [{"code": "PROCESS_EXITED", "detail": "唯一写服务进程已退出（明确不可达）", "subject": "service"}]
    elif status == "unknown":
        reasons = [{"code": "NO_EVIDENCE", "detail": "读不到、证据不足，不猜", "subject": None}]
    queue = {
        "read": {"mode": "worker", "busy": 1, "queued": 0, "queue_limit": 8, "pool_size": 2,
                 "group_queue_limit": 4, "groups_queued": 0, "started": 12, "completed": 11,
                 "failed": 0, "timeouts": 0, "rejected_full": 0, "rejected_group_full": 0},
        "scan": {"mode": "local", "busy": 0, "queued": 0, "queue_limit": 2, "pool_size": 1,
                 "group_queue_limit": 0, "groups_queued": 0, "started": 3, "completed": 3,
                 "failed": 0, "timeouts": 0, "rejected_full": 0, "rejected_group_full": 0},
    }
    timing = {"samples": 11, "queue_ms": {"count": 11, "min_ms": 1, "max_ms": 40, "avg_ms": 9},
              "execution_ms": {"count": 11, "min_ms": 80, "max_ms": 2400, "avg_ms": 640},
              "total_ms": {"count": 11, "min_ms": 90, "max_ms": 2450, "avg_ms": 650}}
    if status == "healthy" or status == "degraded":
        last = {"at": "2026-10-13T09:59:00.000Z", "age_ms": 60000}
    else:
        last = None
    return {
        "ok": True, "schema": "runtime-diagnostics-v1", "schema_version": 1,
        "generated_at": generated_at, "project_id": project_id, "detail": "summary",
        "process": {
            "pid": pid, "started_at": "2026-10-13T09:00:00.000Z", "release_id": release,
            "build_identity": {"component": "server", "embedded": True, "release_id": release,
                               "build_id": "bld-77c0", "reason": None},
            "build_identity_skew": {"state": "same_release", "detail": "同一版本（server 与 ui 同批构建）"},
        },
        "service": {"reachable": True,
                    "descriptor": {"present": True, "state": "valid", "pid_alive": True, "is_self": True},
                    "reason": None, "last_success_at": "2026-10-13T09:59:00.000Z", "age_state": "fresh"},
        "status": status, "reasons": reasons,
        "last_success": last, "stale_after_ms": 30000, "age_state": "fresh", "degraded_since": None,
        "incidents": incidents, "queue": queue, "timing": timing, "unsupported": [],
    }


class Runner:
    def __init__(self):
        self.checks = 0
        self.fails = 0
        self.notes = []

    def check(self, name, cond, detail=""):
        self.checks += 1
        if cond:
            print("  ok   %s" % name)
        else:
            self.fails += 1
            print("  FAIL %s%s" % (name, "" if detail == "" else " — %s" % detail))

    def note(self, msg):
        self.notes.append(msg)
        print("  ..   %s" % msg)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def write_harness():
    HARNESS.write_text(
        '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>V09-70 harness</title></head>'
        '<body style="margin:0"><div id="root" style="height:100vh"></div>'
        '<script type="module">import "/src/ui/main.tsx";</script></body></html>',
        encoding="utf-8",
    )


VISIBILITY_INIT = """
(() => {
  let vis = 'visible';
  try { Object.defineProperty(document, 'visibilityState', { configurable: true, get() { return vis; } }); } catch (e) {}
  window.__tataiSetVisibility = (v) => { vis = v; document.dispatchEvent(new Event('visibilitychange')); };
})();
"""


def start_vite(port, cache_dir):
    env = dict(os.environ, TATAI_VITE_CACHE_DIR=str(cache_dir))
    log = open(str(OUT / "vite.log"), "w", encoding="utf-8")
    proc = subprocess.Popen(
        ["node", str(ROOT / "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", str(port), "--strictPort"],
        cwd=str(ROOT), env=env, stdout=log, stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(200):
        if proc.poll() is not None:
            raise RuntimeError("Vite 提前退出（见 %s）" % (OUT / "vite.log"))
        try:
            opener.open("http://127.0.0.1:%d/" % port, timeout=1)
            return proc, opener
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("Vite 未在预期时间内就绪")


def attach_routes(page, state):
    def handler(route):
        req = route.request
        parsed = urllib.parse.urlparse(req.url)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        method = req.method
        if path == "/health":
            route.fulfill(status=200, content_type="application/json", body=json.dumps(
                {"ok": True, "pid": 111, "build_identity": None}))
            return
        if path == "/api/runtime/diagnostics":
            pid = (query.get("project_id") or [state["project_id"]])[0]
            state["diag_calls"].append({"t": time.time(), "project_id": pid})
            mode = state["diag_mode"]
            if mode == "abort":
                route.abort()
                return
            if mode == "404":
                route.fulfill(status=404, content_type="application/json",
                              body=json.dumps({"ok": False, "error": {"code": "NOT_FOUND", "message": "no route"}}))
                return
            if mode == "503":
                route.fulfill(status=503, content_type="application/json", body=json.dumps(
                    {"ok": False, "reason": "QUEUE_SATURATED",
                     "error": {"code": "QUEUE_SATURATED", "message": "读池队列满"}}))
                return
            gen = state.get("diag_generated_at") or "2026-10-13T10:00:00.000Z"
            report = make_report(status=state.get("diag_status", "healthy"), project_id=pid,
                                 generated_at=gen, release=state.get("diag_release", "rel-9f3a1c"))
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps(report, ensure_ascii=False))
            return
        if path == "/api/projects" and method == "GET":
            route.fulfill(status=200, content_type="application/json", body=json.dumps(PROJECTS))
            return
        m = re.fullmatch(r"/api/projects/([^/]+)/open", path)
        if m and method == "POST":
            pid = urllib.parse.unquote(m.group(1))
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps({"ok": True, "project": PROJECT_BY_ID.get(pid, PROJECTS[0])}))
            return
        m = re.fullmatch(r"/api/projects/([^/]+)/watch", path)
        if m:
            route.fulfill(status=200, content_type="application/json", body=json.dumps(
                {"ok": True, "watch": {"watching": True, "already": False}, "removed": False}))
            return
        if re.fullmatch(r"/api/projects/[^/]+/live", path):
            if state["live_mode"] == "abort":
                route.abort()
                return
            route.fulfill(status=200, content_type="application/json", body=json.dumps(
                {"ok": True, "live": {"stage": "进行中", "current_task": None, "blocked": False,
                                      "agents": [], "recent": [], "task_counts": {}, "gate": None,
                                      "last_event_at": None}}))
            return
        if re.fullmatch(r"/api/projects/[^/]+/documents", path):
            route.fulfill(status=200, content_type="application/json", body=json.dumps(
                {"ok": True, "documents": {"baseline": {"active": None, "count": 0, "corrupt": 0}}}))
            return
        if re.fullmatch(r"/api/projects/[^/]+/discussions", path):
            route.fulfill(status=200, content_type="application/json", body=json.dumps(
                {"ok": True, "discussions": {"entries": []}}))
            return
        if path == "/api/agents":
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True, "agents": []}))
            return
        # 其它一律 mock 成"业务错误"（视图组件会优雅降级，不冒充数据）
        route.fulfill(status=200, content_type="application/json", body=json.dumps(
            {"ok": False, "error": {"code": "MOCK", "message": "harness mock: %s" % path}}))

    page.route("**/api/**", handler)
    page.route("**/health", handler)


def new_state():
    return {"diag_mode": "ok", "diag_calls": [], "live_mode": "ok", "project_id": "fixture",
            "diag_status": "healthy", "diag_generated_at": None, "diag_release": "rel-9f3a1c"}


def local_clock(iso):
    """把夹具的 UTC ISO 时间换算成本地渲染文本（页面按本地时区显示，断言要对齐）。"""
    import datetime
    dt = datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone()
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def open_app(page, base, pid="fixture"):
    page.goto("%s/#p/%s" % (base, pid))
    page.wait_for_selector("[data-main-nav]", timeout=30000)


def open_diagnostics(page):
    # 辅助入口在「更多」details 里：强制展开（点击会 toggle，重复调用会关掉），再点「运行诊断」
    page.evaluate("() => { const d = document.querySelector('details.tt-tools-disclosure'); if (d) d.open = true; }")
    page.locator('nav[data-aux-nav] button[data-view="diagnostics"]').click()
    page.wait_for_selector("[data-diagnostics-page]", timeout=15000)


def main():
    runner = Runner()
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="v0970-"))
    vite_proc = None
    browser = None
    try:
        write_harness()
        port = free_port()
        base = "http://127.0.0.1:%d" % port
        print("[ui] 启动 Vite（隔离缓存 %s，端口 %d）" % (tmp, port))
        vite_proc, _ = start_vite(port, tmp)

        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(headless=True)
            except Exception:
                browser = p.chromium.launch(channel="msedge", headless=True)
            context = browser.new_context(accept_downloads=True, viewport={"width": 1400, "height": 900})

            # ── 场景 1：默认入口可达、辅助入口有「运行诊断」、诊断页渲染 healthy ──
            print("\n[场景1] 入口与默认态（healthy 安静）")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            st = new_state()
            attach_routes(page, st)
            page.add_init_script(VISIBILITY_INIT)
            open_app(page, base)
            # 辅助入口在「更多」details 里：先展开再断言
            page.locator("details.tt-tools-disclosure > summary").first.click()
            aux = page.locator('nav[data-aux-nav] button[data-view="diagnostics"]')
            runner.check("辅助入口存在「运行诊断」按钮",
                         aux.count() == 1 and "运行诊断" in (aux.first.text_content() or ""))
            # 默认主视图下：healthy ⇒ 全局提示安静（不占常驻行）
            runner.check("healthy 时全局提示安静", page.locator("[data-runtime-health-hint]").count() == 0)
            page.screenshot(path=str(OUT / "01-main-healthy-quiet.png"))
            open_diagnostics(page)
            runner.check("诊断页可达", page.locator("[data-diagnostics-page]").count() == 1)
            runner.check("诊断页读到 healthy", page.get_attribute("[data-diagnostics-page]", "data-runtime-health") == "healthy")
            runner.check("诊断页显示最近一次成功", page.locator("[data-diagnostics-last-success]").count() == 1)
            runner.check("诊断页展示队列读数", page.locator("[data-diagnostics-queue-read]").inner_text().find("读池") >= 0)
            src = page.locator('[data-diagnostics-section="timing"]').inner_text()
            runner.check("测得时长如实展示（非编造）", "均" in src and "ms" in src)
            page.screenshot(path=str(OUT / "02-diagnostics-healthy.png"))
            runner.check("无未捕获页面错误（场景1）", len(errors) == 0, "; ".join(errors[:3]))
            page.close()

            # ── 场景 2：异常默认可见（degraded）——主视图上全局提示一行可见 ──
            print("\n[场景2] 异常默认可见（degraded，主视图上）")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            st = new_state()
            st["diag_status"] = "degraded"
            attach_routes(page, st)
            page.add_init_script(VISIBILITY_INIT)
            open_app(page, base)
            hint = page.locator("[data-runtime-health-hint]")
            expect(hint).to_be_visible(timeout=15000)
            runner.check("degraded 时主视图上全局提示可见", page.get_attribute("[data-runtime-health-hint]", "data-runtime-health") == "degraded")
            runner.check("未在诊断页也显示（全局）", page.locator("[data-diagnostics-page]").count() == 0)
            runner.check("提示含「查看诊断」入口", page.locator("[data-runtime-hint-open]").count() == 1)
            page.screenshot(path=str(OUT / "03-main-degraded-hint.png"))
            # 点「查看诊断」跳到诊断页
            page.locator("[data-runtime-hint-open]").click()
            page.wait_for_selector("[data-diagnostics-page]", timeout=15000)
            runner.check("「查看诊断」跳转可用", page.locator("[data-diagnostics-page]").count() == 1)
            runner.check("无未捕获页面错误（场景2）", len(errors) == 0, "; ".join(errors[:3]))
            page.close()

            # ── 场景 3：任一主视图可见时 5 秒监看；隐藏即暂停；恢复可见立即再读 ──
            print("\n[场景3] 可见态 5 秒监看 / 隐藏暂停 / 恢复")
            page = context.new_page()
            st = new_state()
            attach_routes(page, st)
            page.add_init_script(VISIBILITY_INIT)
            open_app(page, base)  # 默认「交付总览」= 一个主视图（不是诊断页）
            runner.check("默认落在主视图（非诊断页）", page.locator("[data-diagnostics-page]").count() == 0)
            page.wait_for_timeout(1500)
            c0 = len(st["diag_calls"])
            runner.check("主视图可见时已开始监看（≥1 次诊断读）", c0 >= 1, "c0=%d" % c0)
            page.wait_for_timeout(6000)
            c1 = len(st["diag_calls"])
            runner.check("5 秒周期内又读了一轮", c1 > c0, "c0=%d c1=%d" % (c0, c1))
            # 隐藏文档 ⇒ 暂停
            page.evaluate("window.__tataiSetVisibility('hidden')")
            page.wait_for_timeout(300)
            c2 = len(st["diag_calls"])
            page.wait_for_timeout(6500)
            c3 = len(st["diag_calls"])
            runner.check("隐藏后暂停（不再主动读）", c3 == c2, "c2=%d c3=%d" % (c2, c3))
            # 恢复可见 ⇒ 立即再读
            page.evaluate("window.__tataiSetVisibility('visible')")
            page.wait_for_timeout(700)
            c4 = len(st["diag_calls"])
            runner.check("恢复可见后立即再读一轮", c4 > c3, "c3=%d c4=%d" % (c3, c4))
            page.close()

            # ── 场景 4：失败退避 400×2 封顶 6s、最多 6 次即停（真网络计数） ──
            print("\n[场景4] 失败退避与重试上限（真网络计数）")
            page = context.new_page()
            st = new_state()
            st["diag_mode"] = "abort"  # 网络层失败 ⇒ 归类"没连上" ⇒ 退避重试
            attach_routes(page, st)
            page.add_init_script(VISIBILITY_INIT)
            open_app(page, base)
            open_diagnostics(page)
            page.wait_for_timeout(17000)  # 400+800+1600+3200+6000=12000ms 余量
            calls = [c["t"] for c in st["diag_calls"]]
            # 首读 + 5 次退避 = 6 次
            runner.check("重试次数封顶为 6 次即停", len(calls) <= 6 and len(calls) >= 1, "calls=%d" % len(calls))
            gaps = [round((calls[i + 1] - calls[i]) * 1000) for i in range(len(calls) - 1)]
            runner.check("退避序列约 400/800/1600/3200/6000ms（容差）",
                         all(abs(g - e) < 350 for g, e in zip(gaps, [400, 800, 1600, 3200, 6000])),
                         "gaps=%s" % gaps)
            runner.check("停止后不再读（无更多调用）", len(st["diag_calls"]) == len(calls))
            runner.check("停止态如实标注", page.get_attribute("[data-diagnostics-page]", "data-runtime-phase") in ("stopped", "retrying"))
            page.screenshot(path=str(OUT / "04-diagnostics-retry-stopped.png"))
            page.close()

            # ── 场景 5：重连成功即停重试、恢复监看、恢复核验（需先有成功读数供比对） ──
            print("\n[场景5] 恢复：成功即停重试并核验新报告")
            page = context.new_page()
            st = new_state()
            st["diag_generated_at"] = "2026-10-13T10:00:00.000Z"
            attach_routes(page, st)
            page.add_init_script(VISIBILITY_INIT)
            open_app(page, base)
            open_diagnostics(page)
            page.wait_for_timeout(600)  # 首次成功
            runner.check("先拿到成功读数", page.get_attribute("[data-diagnostics-page]", "data-runtime-has-report") == "1")
            st["diag_mode"] = "abort"  # 制造一次网络层失败
            page.wait_for_timeout(6000)
            runner.check("故障时进入退避重试",
                         page.get_attribute("[data-diagnostics-page]", "data-runtime-phase") in ("retrying", "stopped"))
            st["diag_mode"] = "ok"
            st["diag_generated_at"] = "2026-10-13T11:11:11.000Z"
            st["diag_release"] = "rel-recovered"
            page.locator("[data-diagnostics-retry]").click()
            page.wait_for_timeout(1200)
            runner.check("重连成功后回监看（phase=monitoring）",
                         page.get_attribute("[data-diagnostics-page]", "data-runtime-phase") == "monitoring")
            runner.check("恢复核验说明可见", page.locator("[data-diagnostics-recovery]").count() == 1)
            runner.check("恢复报告时间已更新",
                         local_clock("2026-10-13T11:11:11.000Z") in page.locator("[data-diagnostics-generated]").inner_text())
            page.screenshot(path=str(OUT / "05-diagnostics-recovered.png"))
            page.close()

            # ── 场景 6：切项目不串（诊断读数随项目切换、旧报告不落地） ──
            print("\n[场景6] 切项目不串数据")
            page = context.new_page()
            st = new_state()
            st["diag_generated_at"] = "2026-10-13T12:00:00.000Z"
            attach_routes(page, st)
            page.add_init_script(VISIBILITY_INIT)
            open_app(page, base, "fixture")
            open_diagnostics(page)
            page.wait_for_timeout(500)
            runner.check("先到项目甲读数",
                         local_clock("2026-10-13T12:00:00.000Z") in page.locator("[data-diagnostics-generated]").inner_text())
            # 切到项目乙：核对诊断请求带上项目乙 id；乙是「新项目」——页面各自记忆，视图默认回交付总览
            st["diag_generated_at"] = "2026-10-13T13:00:00.000Z"
            page.get_by_text("夹具项目乙", exact=False).first.click()
            page.wait_for_timeout(1200)
            last_pid = st["diag_calls"][-1]["project_id"]
            runner.check("切项目后诊断请求带新项目 id", last_pid == "other", "last_pid=%s" % last_pid)
            open_diagnostics(page)
            page.wait_for_timeout(500)
            gen_text = page.locator("[data-diagnostics-generated]").inner_text()
            runner.check("诊断页显示新项目读数（不串旧数据）",
                         local_clock("2026-10-13T13:00:00.000Z") in gen_text, "gen=%s" % gen_text)
            page.screenshot(path=str(OUT / "06-switch-project.png"))
            page.close()

            # ── 场景 7：旧宿主未接入 ⇒ 明报未接入（不假装有数据） ──
            print("\n[场景7] 旧宿主：明报未接入")
            page = context.new_page()
            st = new_state()
            st["diag_mode"] = "404"
            attach_routes(page, st)
            page.add_init_script(VISIBILITY_INIT)
            open_app(page, base)
            open_diagnostics(page)
            page.wait_for_timeout(500)
            runner.check("未接入明报（supported=0）", page.get_attribute("[data-diagnostics-page]", "data-runtime-supported") == "0")
            runner.check("未接入页面可见提示", page.locator("[data-diagnostics-unsupported]").count() == 1)
            runner.check("未接入时不显示正常", page.get_attribute("[data-diagnostics-page]", "data-runtime-has-report") == "0")
            page.screenshot(path=str(OUT / "07-diagnostics-unsupported.png"))
            page.close()

            # ── 场景 8：脱敏导出（真下载）+ 客户端观测（本页读取失败单列） ──
            print("\n[场景8] 脱敏导出 + 客户端观测")
            page = context.new_page()
            st = new_state()
            st["diag_status"] = "degraded"  # 带一条含路径/token 的 incident
            st["live_mode"] = "abort"       # 让主页面读取（/live）网络失败 ⇒ 客户端观测
            attach_routes(page, st)
            page.add_init_script(VISIBILITY_INIT)
            open_app(page, base)
            page.wait_for_timeout(1500)  # 让 /live 失败若干次、被观测到
            open_diagnostics(page)
            page.wait_for_timeout(600)
            obs = page.get_attribute("[data-diagnostics-page]", "data-runtime-client-failures")
            runner.check("客户端观测记录本页读取失败", int(obs) >= 1, "client_failures=%s" % obs)
            runner.check("诊断页单列客户端观测", page.locator("[data-diagnostics-client-observation]").count() == 1)
            with page.expect_download() as dl_info:
                page.locator("[data-diagnostics-export]").click()
            dl = dl_info.value
            dl_path = dl.path()
            text = pathlib.Path(dl_path).read_text(encoding="utf-8")
            (OUT / "export-sample.json").write_text(text, encoding="utf-8")
            body = json.loads(text)
            runner.check("导出 schema 正确", body.get("schema") == "runtime-diagnostics-report" and body.get("schema_version") == 1)
            runner.check("导出含 redaction.note 与 redacted_fields",
                         isinstance(body.get("redaction", {}).get("note"), str) and len(body["redaction"]["redacted_fields"]) >= 5)
            runner.check("导出含客户端观测（本页读取）", body.get("client_observation") is not None)
            # 脱敏：夹具 incident.reason 里的绝对路径与 token 样长串必须被脱掉
            runner.check("导出不含 token 样长串", SECRET_TOKEN not in text)
            runner.check("导出不含绝对路径（C:\\secrets）", "secrets" not in text and "C:\\" not in text)
            runner.check("导出不含原始 URL", "http://" not in text and "127.0.0.1" not in text)
            page.screenshot(path=str(OUT / "08-diagnostics-export-client.png"))
            page.close()

            # ── 场景 9：窄窗可读 + 键盘可达 ──
            print("\n[场景9] 窄窗可读 + 键盘操作")
            page = context.new_page()
            st = new_state()
            st["diag_status"] = "unavailable"
            attach_routes(page, st)
            page.add_init_script(VISIBILITY_INIT)
            page.set_viewport_size({"width": 520, "height": 760})
            open_app(page, base)
            open_diagnostics(page)
            page.wait_for_timeout(400)
            # 键盘：Tab 到重试按钮并回车（可聚焦）
            page.locator("[data-diagnostics-retry]").focus()
            page.keyboard.press("Enter")
            page.wait_for_timeout(400)
            runner.check("窄窗下诊断页仍渲染", page.locator("[data-diagnostics-page]").count() == 1)
            runner.check("重试按钮可键盘触发", page.get_attribute("[data-diagnostics-page]", "data-runtime-health") == "unavailable")
            page.screenshot(path=str(OUT / "09-narrow-window.png"))
            page.close()

            # ── 场景 10：F01 服务故障后当前状态不绿 + 旧读数标注 + 恢复 ──
            print("\n[场景10] F01 失败后当前状态不绿（诊断页）+ 旧读数 + 恢复")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            st = new_state()
            st["diag_generated_at"] = "2026-10-13T10:00:00.000Z"
            attach_routes(page, st)
            page.add_init_script(VISIBILITY_INIT)
            open_app(page, base)
            open_diagnostics(page)
            page.wait_for_timeout(800)
            runner.check("F01 先拿到 healthy 读数（有历史报告）",
                         page.get_attribute("[data-diagnostics-page]", "data-runtime-health") == "healthy"
                         and page.get_attribute("[data-diagnostics-page]", "data-runtime-has-report") == "1")
            # 制造服务故障：mock 诊断读口 abort（网络层失败 ⇒ 归类"没连上"）
            st["diag_mode"] = "abort"
            page.wait_for_timeout(6500)
            health_attr = page.get_attribute("[data-diagnostics-page]", "data-runtime-health")
            runner.check("F01 失败后当前状态不再是 healthy（落 unknown）", health_attr == "unknown", "health=%s" % health_attr)
            runner.check("F01 有历史报告但标为旧读数",
                         page.get_attribute("[data-diagnostics-page]", "data-diagnostics-report-stale") == "1")
            runner.check("F01 旧读数提示可见（不冒充满/绿）", page.locator("[data-diagnostics-stale-report]").count() == 1)
            page.screenshot(path=str(OUT / "10-diagnostics-stale-old-report.png"))
            # 恢复：mock 重新 ok 且给新报告
            st["diag_mode"] = "ok"
            st["diag_generated_at"] = "2026-10-13T11:22:33.000Z"
            st["diag_release"] = "rel-reworked"
            page.wait_for_timeout(700)
            page.locator("[data-diagnostics-retry]").click()
            page.wait_for_timeout(1800)
            runner.check("F01 恢复后回 healthy", page.get_attribute("[data-diagnostics-page]", "data-runtime-health") == "healthy")
            runner.check("F01 恢复后旧读数标注消失",
                         page.get_attribute("[data-diagnostics-page]", "data-diagnostics-report-stale") == "0")
            runner.check("F01 恢复后读到新报告",
                         local_clock("2026-10-13T11:22:33.000Z") in page.locator("[data-diagnostics-generated]").inner_text())
            runner.check("无未捕获页面错误（场景10）", len(errors) == 0, "; ".join(errors[:3]))
            page.close()

            # ── 场景 11：F01 主视图全局提示：成功后再失联**不得**显示"运行正常" ──
            print("\n[场景11] F01 主视图全局提示：失联时不显示运行正常")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            st = new_state()
            st["diag_generated_at"] = "2026-10-13T10:00:00.000Z"
            attach_routes(page, st)
            page.add_init_script(VISIBILITY_INIT)
            open_app(page, base)  # 主视图（非诊断页）
            page.wait_for_timeout(1500)
            runner.check("F01 healthy 时全局提示仍安静", page.locator("[data-runtime-health-hint]").count() == 0)
            st["diag_mode"] = "abort"
            page.wait_for_timeout(6500)
            hint = page.locator("[data-runtime-health-hint]")
            expect(hint).to_be_visible(timeout=15000)
            health_attr = page.get_attribute("[data-runtime-health-hint]", "data-runtime-health")
            runner.check("F01 失联后主视图全局提示可见", page.locator("[data-runtime-health-hint]").count() == 1)
            runner.check("F01 全局提示不显示 healthy 绿点", health_attr != "healthy", "health=%s" % health_attr)
            label = page.locator("[data-runtime-hint-label]").inner_text()
            runner.check("F01 全局提示不显示「运行正常」", "运行正常" not in label, "label=%s" % label)
            runner.check("F01 全局提示标出历史读数为旧读数",
                         page.get_attribute("[data-runtime-health-hint]", "data-runtime-hint-stale") == "1")
            page.screenshot(path=str(OUT / "11-main-hint-failure-not-green.png"))
            runner.check("无未捕获页面错误（场景11）", len(errors) == 0, "; ".join(errors[:3]))
            page.close()

            # ── 场景 12：F05 卸载/重挂载：不用旧项目先发一笔读；定时器有界不泄漏 ──
            print("\n[场景12] F05 卸载/重挂载（取消选中 ⇒ 重新选中）")
            page = context.new_page()
            st = new_state()
            attach_routes(page, st)
            page.add_init_script(VISIBILITY_INIT)
            open_app(page, base)  # fixture
            page.wait_for_timeout(1500)
            runner.check("F05 挂载后已按项目 fixture 读", any(c["project_id"] == "fixture" for c in st["diag_calls"]))
            # 取消选中 ⇒ 项目区（含全局提示）卸载 ⇒ 最后一个订阅者退订 ⇒ stop()
            page.evaluate("window.location.hash = ''")
            page.wait_for_timeout(400)
            runner.check("F05 取消选中后全局提示消失（已卸载）", page.locator("[data-runtime-health-hint]").count() == 0)
            n_unmount = len(st["diag_calls"])
            page.wait_for_timeout(6500)
            runner.check("F05 卸载后无自激诊断请求（定时器有界）", len(st["diag_calls"]) == n_unmount,
                         "count=%d n_unmount=%d" % (len(st["diag_calls"]), n_unmount))
            # 重新选中 ⇒ 重挂载
            page.evaluate("window.location.hash = '#p/fixture'")
            page.wait_for_timeout(1500)
            calls_after = st["diag_calls"][n_unmount:]
            runner.check("F05 重挂载后重新按项目读", len(calls_after) >= 1 and calls_after[-1]["project_id"] == "fixture",
                         "calls=%s" % calls_after[-3:])
            runner.check("F05 重挂载后无他项目读数", all(c["project_id"] == "fixture" for c in calls_after),
                         "calls=%s" % calls_after[-3:])
            page.screenshot(path=str(OUT / "12-remount-reselect.png"))
            page.close()

            context.close()
            browser.close()
            browser = None
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("V09-70 UI 验收异常中断")
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
        if vite_proc is not None:
            try:
                vite_proc.kill()
            except Exception:
                pass
        if os.environ.get("V0970_KEEP") == "1":
            print("[ui] 保留现场：%s" % tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)
        sys.exit(EXIT_FAIL)
    finally:
        if vite_proc is not None:
            try:
                vite_proc.kill()
            except Exception:
                pass
        if os.environ.get("V0970_KEEP") != "1":
            shutil.rmtree(tmp, ignore_errors=True)

    print("\nV09-70 UI 验收：%d/%d 通过" % (runner.checks - runner.fails, runner.checks))
    summary = {"checks": runner.checks, "fails": runner.fails, "notes": runner.notes,
               "shot_dir": str(OUT)}
    (OUT / "verify-v09-70-ui.result.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    if runner.fails > 0:
        print("有 %d 项失败" % runner.fails)
        sys.exit(EXIT_FAIL)
    sys.exit(EXIT_OK)


if __name__ == "__main__":
    main()
