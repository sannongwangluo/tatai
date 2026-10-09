#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-36 真浏览器验收：界面「共享取数与明确新鲜度」的网络/渲染层（真 Chromium + 真后端 + 真 vite）。

用法：python scripts/verify-unified-ui.py
      V0936_REPO 指定被测仓库根（默认为本脚本所在仓库）
      V0936_KEEP_TMP=1 保留临时现场（默认跑完删净）    V0936_LABEL 本次运行标签

为什么要有这只脚本（缺什么补什么）：
  V09-36 卡面「目标」点名要**真实浏览器网络/渲染验收**，而仓内只有 Node 端
  `scripts/verify-unified-ui.ts`（node:http 计数服务器 + 真实 fetch，无浏览器、无渲染断言）；
  卡面「文件责任」点名的 `scripts/verify-unified-ui.py` 此前不存在。本仓约定
  `verify-*-ui.py` = playwright 真浏览器测试（scripts/ 下 40+ 个 *-ui.py 均如此），故本文件
  补的就是**浏览器侧那一层**：不改 Node 电池的粒度（在途合并的语义参数区分、写后失效代际、
  每订阅者 AbortSignal 等已由它覆盖），只验它验不了的两件事——**浏览器真的只发了一笔网络**与
  **界面真的把那份数据渲染出来了**。

覆盖（每一项都真跑真断言）：
  (a) 在途合并（浏览器网络层）：实况页与顶栏在同一瞬间对**同一 URL** 各发一次读请求时，
      Chromium 实际只发出 **1 笔**网络请求；同时两个消费点都渲染出**与后端读口同源**的数据
      （网络断言 + 渲染断言，缺一不算）。
  (b) 周期刷新保留（无 TTL）：停留施工图页跨过两轮 5s 对账，`/plan` 的真实网络请求数随时间
      递增 —— 证明「同 URL 只求值一次」的共享层没有把后续对账吞成缓存。
  (c) 旧回包不串项目：给项目 A 的 `/live` 加延迟，延迟未回时切到项目 B；B 的界面只渲染 B 的
      数据。两条路径都覆盖——① 实况页在途请求会随切项目被中止（既有语义）；② 项目图页的 `/live`
      轮询不带 signal，那一支订阅者切项目时还活着 ⇒ 延迟响应**真的到达浏览器**后才被丢弃。
      两条路径下 A 的阶段/项目名/卡号都不许出现在 B 的现场。
  (d) 渲染验收：主界面（顶栏项目名/主导航）与卡面点名的 `src/ui/components/SyncEvidenceStatus.tsx`
      真实渲染，且渲染值与后端读口逐字段同源。

隔离口径（AGENTS.md §5）：临时 TATAI_HOME + 临时夹具项目（两个）+ 动态空闲端口（后端与 vite
都用动态端口，不碰 8787）；不碰真实 ~/.tatai、不碰真实纳管项目与账本；不调模型（夹具不含模型
配置）、不联网外发。收尾杀净自有后端与 vite、删临时目录（V0936_KEEP_TMP=1 可留现场）。

退出码：0 全过；1 有 FAIL 或中途中断；3 环境缺失（未装 playwright python 包 / 无可用 Chromium）。
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_ENV = 3

try:  # 环境缺失必须显式报出来并按 3 退出——绝不把「没跑成」记成通过
    from playwright.sync_api import sync_playwright
except Exception as _e:  # noqa: BLE001
    print("[ui] 环境缺失：未安装 playwright python 包（%s）" % _e)
    print("[ui]  修复：python -m pip install playwright && python -m playwright install chromium")
    sys.exit(EXIT_ENV)

try:  # 中文日志落盘要稳定，别跟着控制台代码页走；行缓冲让日志在跑的过程中就能看（证据别等退出才落盘）
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
except Exception:  # noqa: BLE001
    pass

REPO = os.path.abspath(os.environ.get(
    "V0936_REPO",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."),
))
LABEL = os.environ.get("V0936_LABEL", "run")
KEEP = os.environ.get("V0936_KEEP_TMP") == "1"
IDA = "v0936uiA"
IDB = "v0936uiB"
NAME_A = "夹具甲"
NAME_B = "夹具乙"
# 实况/施工图两条数据端点的完整路径（浏览器发出的就是这两个 URL）
LIVE_A = "/api/projects/%s/live" % IDA
LIVE_B = "/api/projects/%s/live" % IDB
PLAN_A = "/api/projects/%s/plan" % IDA
PLAN_B = "/api/projects/%s/plan" % IDB
# 前端在途合并周期的别名（与 src/ui/useProjectRefresh.ts 的 PROJECT_REFRESH_INTERVAL_MS 对齐；
# 本脚本只在等待窗口里用它做时长预算，不断言这个常量本身——那是 Node 电池的静态断言范围）
REFRESH_MS = 5000

passes = [0]
fails = []
step = {"now": "启动"}


class EnvMissing(RuntimeError):
    """本机缺浏览器/缺 playwright 依赖——按环境缺失处理（exit 3），不当成被测实现的失败。"""


def ok(cond, label):
    print(("[ui] PASS " if cond else "[ui] FAIL ") + label)
    if cond:
        passes[0] += 1
    else:
        fails.append(label)
    return bool(cond)


def info(msg):
    print("[ui]   " + msg)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return path


# 本脚本只访问隔离的本机服务；不得把回环请求交给系统 HTTP 代理。
LOCAL_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _ensure_loopback_no_proxy():
    """把 loopback 显式并入 NO_PROXY：后端/vite 子进程继承本进程环境，别让它们把本机流量交给系统代理。
    只改本脚本进程的环境，不动用户 shell/系统代理设置。"""
    hosts = ("localhost", "127.0.0.1", "::1")
    for key in ("NO_PROXY", "no_proxy"):
        parts = [p for p in os.environ.get(key, "").split(",") if p]
        os.environ[key] = ",".join(parts + [h for h in hosts if h not in parts])


_ensure_loopback_no_proxy()


def http(url, method="GET", body=None, timeout=60):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, method=method, data=data)
    if data is not None:
        req.add_header("content-type", "application/json")
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


# ══════════════════════════════ 夹具（隔离，不碰真实数据） ══════════════════════════════

def design_doc(name):
    return """# V09-36 UI 夹具设计书 %s

## 2 模块划分

| # | 模块 | 说明 |
| --- | --- | --- |
| 1 | 甲模块 | 夹具能力 |

## 3 说明

夹具正文 %s。
""" % (name, name)


def plan_doc(task_id, name):
    return """# V09-36 UI 夹具施工图 %s

| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |
| --- | --- | --- | --- | --- |
| %s | todo | %s 甲模块落成 |  | %s 验收记录 |

### %s %s 甲模块落成

**设计依据**：§2。

**契约**：输入甲，输出甲的产物。

**文件责任**：`src/`。

- [ ] 甲做出来

**交付**：%s 验收记录。

**完成证据**：%s 验收记录。
""" % (name, task_id, name, name, task_id, name, name, name)


def progress_doc(current_step):
    return {
        "version": 1,
        "gate": {
            "current_step": current_step,
            "history": [
                {"step": "kickoff", "result": "pass", "at": "2026-10-02T00:00:00+08:00", "note": None},
                {"step": "requirement", "result": "pass", "at": "2026-10-02T00:00:00+08:00", "note": None},
                {"step": "design", "result": "pending", "at": None, "note": None},
            ],
        },
        "modules": [{"id": "src", "name": "源码", "status": "todo"}],
    }


MODULES = {
    "version": 1,
    "generated_at": "2026-10-02T00:00:00+08:00",
    "budget_exhausted": False,
    "modules": [{"id": "src", "path": "src", "name": "", "file_count": 1, "loc": 5, "deps": []}],
}


def make_project(root, pid, name, task_id, step_id):
    """夹具项目：与 scripts/verify-progress-ui.py 同一套最小结构（两个项目、卡号/步骤不同）。"""
    proj = os.path.join(root, "work", pid)
    write(os.path.join(proj, ".工作台", "design.md"), design_doc(name))
    write(os.path.join(proj, ".工作台", "plan.md"), plan_doc(task_id, name))
    write(os.path.join(proj, ".工作台", "arch", "modules.json"),
          json.dumps(MODULES, ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(proj, ".工作台", "progress.json"),
          json.dumps(progress_doc(step_id), ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(proj, ".工作台", "gate.jsonl"), "")
    # 待议源（非自举项目 = `.工作台/design.discuss.md`，entries 只认以 "- `" 开头的行）
    write(os.path.join(proj, ".工作台", "design.discuss.md"), "# 夹具待议\n\n（暂无）\n")
    write(os.path.join(proj, "src", "index.ts"), "export const a = 1;\n")
    return proj


def make_registry(home, proj_a, proj_b):
    now = "2026-10-02T00:00:00+08:00"
    write(os.path.join(home, "registry.json"),
          json.dumps({"version": 1, "projects": [
              {"id": IDA, "name": NAME_A, "path": proj_a, "kind": "backend",
               "registered_at": now, "last_opened_at": now},
              {"id": IDB, "name": NAME_B, "path": proj_b, "kind": "backend",
               "registered_at": now, "last_opened_at": now},
          ]}, ensure_ascii=False, indent=2) + "\n")


# ══════════════════════════════ 后端 / vite ══════════════════════════════

class Backend:
    def __init__(self, home, port, log_path):
        env = dict(os.environ)
        env["TATAI_HOME"] = home
        env["TATAI_PORT"] = str(port)
        self.port = port
        self.log_path = log_path
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", os.path.join("src", "server", "index.ts")],
            cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
        )

    def api(self, path, method="GET", body=None):
        return http("http://127.0.0.1:%d%s" % (self.port, path), method, body)

    def wait_health(self, timeout=180):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("后端进程退出（日志见 ui-backend.log）")
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
    # node_modules 是对真实 D:/tatai 的 junction：vite 默认把依赖预打包缓存写到共享的
    # node_modules/.vite，与真实环境/并发验证互相打架。指到本次隔离临时目录（收尾随临时目录删除）。
    env["TATAI_VITE_CACHE_DIR"] = cache_dir
    proc = subprocess.Popen(
        ["node", os.path.join("node_modules", "vite", "bin", "vite.js"), "dev",
         "--port", str(port), "--strictPort"],
        cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
    )
    deadline = time.time() + 180
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("vite 起不来（进程已退出，见 ui-vite.log）")
        try:
            with LOCAL_HTTP.open("http://localhost:%d/" % port, timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:  # noqa: BLE001
            time.sleep(0.5)
    raise RuntimeError("vite %d 未就绪" % port)


def launch_browser(p):
    """真 Chromium；本机装了 playwright 浏览器就用它，否则退回系统 Edge。都没有 = 环境缺失。"""
    # 浏览器同样不该把 loopback 交给系统代理（与脚本其它回环请求同口径）。
    args = ["--no-proxy-server", "--proxy-bypass-list=*"]
    try:
        return p.chromium.launch(headless=True, args=args)
    except Exception as e:  # noqa: BLE001
        info("默认 chromium 不可用（%s），退回系统 Edge" % str(e).splitlines()[0][:120])
    try:
        return p.chromium.launch(channel="msedge", headless=True, args=args)
    except Exception as e:  # noqa: BLE001
        raise EnvMissing(
            "无可用真实浏览器（playwright chromium 与系统 Edge 都起不来：%s）；"
            "修复：python -m playwright install chromium" % str(e).splitlines()[0][:120]
        )


# ══════════════════════════════ 浏览器辅助 ══════════════════════════════

# 页面内注入的两把读数（都在浏览器里，不改任何被测源码）：
#   ① `window.fetch` 包装：数**底层 fetch 尝试**（共享层把两个调用者并成一笔后，底层只会被调用一次，
#      所以这个数会跟真实网络请求数一致——它本身就是合并生效的一个侧面读数）；
#   ② `Response.prototype.clone` 包装：数**应用级取数需求**（共享层 settle 时给每个订阅者 clone 一份）。
# 判据：同一 URL 上「clone 次数 ≥ 2 且真实网络请求 == 1」== 两个调用者共用了一笔真实网络（真合并）；
# 若没合并，两者会相等（各发各的）。只数 fetch/网络层无法区分「合并了」与「只有一个消费点在轮询」，
# 所以这两把尺子必须一起用。
FETCH_STATS_JS = r"""
(() => {
  if (window.__tt) return;
  const stats = { calls: {}, clones: {}, inflight: {}, maxInflight: {}, events: [] };
  const orig = window.fetch;
  const pathOf = (input) => {
    let raw = "";
    try {
      raw = typeof input === "string" ? input : (input && input.url) || String(input);
      const abs = new URL(raw, window.location.href);
      return abs.pathname + abs.search;
    } catch (e) { return raw; }
  };
  window.__tt = stats;
  window.__ttReset = () => {
    stats.calls = {}; stats.clones = {}; stats.inflight = {}; stats.maxInflight = {}; stats.events = [];
  };
  window.__ttSnapshot = () => JSON.parse(JSON.stringify(stats));
  window.fetch = function (input, init) {
    const path = pathOf(input);
    const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    stats.calls[path] = (stats.calls[path] || 0) + 1;
    stats.inflight[path] = (stats.inflight[path] || 0) + 1;
    stats.maxInflight[path] = Math.max(stats.maxInflight[path] || 0, stats.inflight[path]);
    const seq = stats.events.length;
    stats.events.push({ seq: seq, path: path, method: method, phase: "call",
                        at: Date.now(), inflight: stats.inflight[path] });
    let out;
    try { out = orig.apply(this, arguments); }
    catch (e) { stats.inflight[path] -= 1; throw e; }
    const done = (phase) => {
      stats.inflight[path] -= 1;
      stats.events.push({ seq: seq, path: path, method: method, phase: phase,
                          at: Date.now(), inflight: stats.inflight[path] });
    };
    if (out && typeof out.then === "function") {
      out.then(() => done("settled"), () => done("failed"));
    } else { done("settled"); }
    return out;
  };
  // 应用级取数需求：共享层把一笔真实响应 clone 给**每个订阅者**（src/ui/sharedRead.ts#settle→bindBranch）。
  // 所以「同一 URL 的 clone 次数」= 那一刻真有几次调用要这份数据；配合网络响应笔数即可判定合并：
  //   clone ≥ 2 而网络响应 == 1 ⇒ 两个调用者共用了一笔网络（真合并）。
  const proto = window.Response && window.Response.prototype;
  if (proto && typeof proto.clone === "function") {
    const origClone = proto.clone;
    proto.clone = function () {
      try {
        if (this.url) {
          const abs = new URL(this.url, window.location.href);
          const p = abs.pathname + abs.search;
          stats.clones[p] = (stats.clones[p] || 0) + 1;
          stats.events.push({ seq: stats.events.length, path: p, method: "CLONE", phase: "clone",
                              at: Date.now(), inflight: stats.inflight[p] || 0 });
        }
      } catch (e) { /* 计数失败不影响被测实现 */ }
      return origClone.apply(this, arguments);
    };
  }
})();
"""


class NetLog:
    """真浏览器网络层逐笔记录（page.on("request"|"response"|"requestfailed")）。

    page.on("request") 是「浏览器实际发出的请求」——Chromium 把两个并发 fetch 合成一笔时，
    这里只会看到一笔（这是本卡要在浏览器层证明的东西）。装了 page.route 之后 HTTP 缓存同时被禁用
    （playwright 的行为），所以计数不会被内存缓存吞掉。
    """

    def __init__(self):
        self.rows = []

    def attach(self, page):
        page.on("request", lambda r: self.rows.append(
            {"phase": "request", "t": time.time() * 1000.0, "path": urllib.parse.urlsplit(r.url).path,
             "method": r.method}))
        page.on("response", lambda r: self.rows.append(
            {"phase": "response", "t": time.time() * 1000.0, "path": urllib.parse.urlsplit(r.url).path,
             "status": r.status}))
        page.on("requestfailed", lambda r: self.rows.append(
            {"phase": "failed", "t": time.time() * 1000.0, "path": urllib.parse.urlsplit(r.url).path,
             "method": r.method}))

    def reset(self):
        self.rows = []

    def count(self, path, phase="request"):
        return len([r for r in self.rows if r["phase"] == phase and r["path"] == path])

    def times(self, path, phase="request"):
        return [r["t"] for r in self.rows if r["phase"] == phase and r["path"] == path]


def text_of(page, selector):
    loc = page.locator(selector)
    if loc.count() == 0:
        return None
    return (loc.first.text_content() or "").strip()


def attr_of(page, selector, attr):
    loc = page.locator(selector)
    if loc.count() == 0:
        return None
    return loc.first.get_attribute(attr)


def wait_attr(page, selector, attr, want, timeout_s=20, label=""):
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        last = attr_of(page, selector, attr)
        if last is not None and want(last):
            return True, last
        page.wait_for_timeout(250)
    info("等待超时（%ds）%s：最后读数 %r" % (timeout_s, label, last))
    return False, last


def wait_text(page, selector, want, timeout_s=20, label=""):
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        last = text_of(page, selector)
        if last is not None and want(last):
            return True, last
        page.wait_for_timeout(250)
    info("等待超时（%ds）%s：最后读数 %r" % (timeout_s, label, last))
    return False, last


def goto_view(page, view):
    """切页：主视图直点；辅助入口（overview / terminal）先展开「更多」再点（与 V09-26 真机测试同口径）。"""
    aux = page.locator('[data-aux-nav] button[data-view="%s"]' % view)
    if aux.count() > 0:
        det = page.locator("details.tt-tools-disclosure")
        if det.count() > 0 and not det.first.evaluate("(d) => d.open"):
            det.first.locator("summary").click()
            page.wait_for_timeout(150)
    page.locator('button[data-view="%s"]' % view).first.click()


def switch_project(page, pid):
    page.locator('[data-project-item="%s"]' % pid).first.click()


def delay_route(ms, notes, tag):
    """给某个端点的响应加延迟（真浏览器侧 harness，不改任何源码）。"""
    def handler(route):
        try:
            time.sleep(ms / 1000.0)
            route.continue_()
        except Exception as e:  # noqa: BLE001
            notes.append("%s 延迟回填未完成（请求在延迟期间已被中止/断开：%s）" % (tag, type(e).__name__))
    return handler


def live_of(backend, pid):
    st, body = backend.api("/api/projects/%s/live" % pid)
    if st != 200 or not isinstance(body, dict) or body.get("ok") is not True:
        raise RuntimeError("读 /live(%s) 失败：HTTP %s %r" % (pid, st, body))
    return body["live"]


# ══════════════════════════════ 浏览器断言 ══════════════════════════════

SYNC_UI_STATES = {"not_configured", "missing", "passed", "failed", "stale",
                  "needs_review", "invalid", "incomplete", "loading", "error", "scan_error"}


def run_browser(vite_port, backend):
    base = "http://localhost:%d" % vite_port
    with sync_playwright() as p:
        browser = launch_browser(p)
        ctx = browser.new_context(viewport={"width": 1680, "height": 1000})
        ctx.add_init_script(FETCH_STATS_JS)
        page = ctx.new_page()
        net = NetLog()
        net.attach(page)
        route_notes = []
        # 全局路由：逐字透传（continue_）——playwright 一旦命中路由即禁用 HTTP 缓存，
        # 「同 URL 再请求」就不会被浏览器内存缓存顶掉，下面数到的都是真网络请求。
        page.route("**/api/**", lambda route: route.continue_())

        # ── ① (d1) 主界面真渲染：进入项目 A（默认落「项目图」页） ──
        step["now"] = "主界面渲染"
        net.reset()
        page.goto("%s/#p/%s" % (base, IDA), wait_until="domcontentloaded")
        shown, name_text = wait_text(page, "[data-status-project]", lambda v: v == NAME_A, 40, "顶栏项目名")
        _st_projects, projects_body = backend.api("/api/projects")
        api_name = next((r["name"] for r in (projects_body or []) if r.get("id") == IDA), None)
        nav_count = page.locator("[data-main-nav] button[data-view]").count()
        ok(shown and api_name == NAME_A,
           "(d1) 主界面真渲染：顶栏项目名 %r == 后端注册表同名（%r）；主导航 %d 页、状态条在场"
           % (name_text, api_name, nav_count))
        ok(nav_count == 6 and page.locator("[data-project-status-bar]").count() > 0,
           "(d1) 主界面骨架齐：主导航 6 页（V09-62 起含「交付总览」）+ 顶栏状态条（当前项目·当前目标·有效版本）都在 DOM 里")
        # 装载期的 /live：项目图页的 4s 轮询与顶栏对账会同刻各要一次，正好顺带记一笔读数（只作信息）
        info("装载期 %s：底层 fetch 尝试 %s 笔 / 浏览器网络 %s 笔（两个尺子都要能数出 >1，才说明它们不是恒为 1）"
             % (LIVE_A,
                page.evaluate("() => (window.__ttSnapshot().calls['%s'] || 0)" % LIVE_A),
                net.count(LIVE_A)))
        info("（page.route continue_ → 逐字透传 + 关闭 HTTP 缓存）")

        # ── ② (d2) 卡面点名的 SyncEvidenceStatus：真渲染 + 与后端读口逐字段同源 ──
        step["now"] = "同步证据状态渲染"
        seen, sync_state = wait_attr(page, "[data-sync-evidence-status]", "data-sync-state",
                                    lambda v: v not in ("", "loading"), 30, "同步证据状态结论")
        st_sync, sync_body = backend.api("/api/projects/%s/sync-status" % IDA)
        report = (sync_body or {}).get("sync") if isinstance(sync_body, dict) else None
        if not seen or not isinstance(report, dict):
            ok(False, "(d2) 同步证据状态组件渲染（state=%r，读口 HTTP %s）" % (sync_state, st_sync))
        else:
            dom_conf = attr_of(page, "[data-sync-evidence-status]", "data-sync-configured")
            dom_batches = attr_of(page, "[data-sync-evidence-status]", "data-sync-batches")
            dom_coll = attr_of(page, "[data-sync-evidence-status]", "data-sync-collection")
            dom_at = attr_of(page, "[data-sync-evidence-status]", "data-sync-checked-at") or ""
            label = text_of(page, "[data-sync-label]") or ""
            scope = text_of(page, "[data-sync-scope]")
            store = ("1" if report.get("configured") else "0") == dom_conf
            batch_ok = str(len(report.get("batches") or [])) == dom_batches
            coll_ok = ("complete" if (report.get("collection") or {}).get("complete") else "incomplete") == dom_coll
            at_ok = len(dom_at) >= 19 and dom_at[:4].isdigit()
            ok(sync_state in SYNC_UI_STATES and store and batch_ok and coll_ok and at_ok,
               "(d2) 同步证据状态组件真渲染且与后端读口同源：结论=%s、registered=%s==读口%s、批次数=%s==%s、"
               "取值范围=%s==%s、核对时间=%s；范围行=%r"
               % (sync_state, dom_conf, report.get("configured"), dom_batches,
                  len(report.get("batches") or []), dom_coll,
                  "complete" if (report.get("collection") or {}).get("complete") else "incomplete", dom_at, scope))
            ok(label != "" and page.locator("[data-sync-detail-toggle]").count() > 0,
               "(d2) 同步证据状态组件渲染出结论短标与详情入口：%r" % label)

        # ── ③ 现场准备：让 A / B 两个项目的「当前页」都停在实况页 ──
        #    (a) 要测的正是「同一时刻两个消费点对同一 URL 各要一次」：实况页的 5s 对账与顶栏的
        #    5s 对账同相（都在切项目那一提交里重启计时器），所以切项目后的第一个整周期就是干净的一对。
        step["now"] = "准备实况页现场"
        goto_view(page, "live")
        rendered, live_stage = wait_text(page, "[data-live-stage]", lambda v: v != "", 30, "实况页阶段")
        live_a0 = live_of(backend, IDA)
        ok(rendered and live_stage == live_a0["stage"],
           "(d1) 实况页真渲染：阶段词 %r == 后端 /live(A) 的 %r" % (live_stage, live_a0["stage"]))
        switch_project(page, IDB)
        goto_view(page, "live")
        wait_text(page, "[data-live-stage]", lambda v: v == live_of(backend, IDB)["stage"], 30, "B 实况页阶段")
        switch_project(page, IDA)
        wait_text(page, "[data-live-view]", lambda v: True, 30, "回到 A 实况页")

        # ── ④ (a) 在途合并：浏览器网络层 ==1 笔 + 两个消费点都渲染同源数据 ──
        step["now"] = "在途合并（浏览器网络层）"
        live_url_b = "**/api/projects/%s/live" % IDB
        page.route(live_url_b, delay_route(600, route_notes, "B /live 延迟"))
        switch_project(page, IDB)
        page.wait_for_timeout(2200)  # 让切项目那一刻的写请求(open/watch)与 SSE 重连代际先落定
        net.reset()
        page.evaluate("() => window.__ttReset()")
        window_start = time.time()
        page.wait_for_timeout(REFRESH_MS + 800)  # 跨过切项目后的第一个完整对账周期
        snap = page.evaluate("() => window.__ttSnapshot()")
        raw_calls = snap["calls"].get(LIVE_B, 0)
        raw_max_inflight = snap["maxInflight"].get(LIVE_B, 0)
        clones = snap["clones"].get(LIVE_B, 0)
        net_calls = net.count(LIVE_B)
        events = [e for e in snap["events"] if e["path"] == LIVE_B]
        info("窗口 %.1fs：订阅者 clone %d 份 / 底层 fetch 尝试 %d 笔（同 URL 在途峰值 %d）/ 浏览器网络请求 %d 笔"
             % (time.time() - window_start, clones, raw_calls, raw_max_inflight, net_calls))
        for e in events[:10]:
            info("  %s t=%d 在途=%d" % (e["phase"], e["at"], e["inflight"]))
        for t in net.times(LIVE_B)[:8]:
            info("  浏览器网络 request t=%d" % int(t))
        ok(clones >= 2,
           "(a) 同一瞬间确有两个消费点各要一次同一 URL：共享层在 /live(B) 上给 %d 个订阅者各 clone 了一份"
           "（实况页 5s 对账 + 顶栏 5s 对账同相）" % clones)
        ok(net_calls == 1,
           "(a) 在途合并（浏览器网络层）：%d 个同并发同 URL 调用 → Chromium 实际只发出 1 笔网络请求"
           "（未合并时必为 %d 笔）" % (clones, clones))
        # 渲染断言：两个消费点都拿到真实数据（不是"网络少了所以屏上空白"）
        live_b = live_of(backend, IDB)
        want_goal = (live_b.get("current_task") or {}).get("id") or live_b["stage"]
        chart_ok, widget_ok = False, False
        gauge = page.locator("[data-live-view]")
        deadline = time.time() + 20
        gauge_stage = None
        while time.time() < deadline:
            gauge_stage = text_of(page, "[data-live-stage]")
            chart_ok = gauge_stage == live_b["stage"]
            goal_text = text_of(page, "[data-status-goal]") or ""
            widget_ok = want_goal in goal_text
            if chart_ok and widget_ok:
                break
            page.wait_for_timeout(250)
        ok(chart_ok and widget_ok and gauge.count() > 0,
           "(a) 合并后两个消费点都渲染出与后端同源的真实数据：实况页阶段 %r == /live(B) 的 %r；"
           "顶栏当前目标含 %r" % (gauge_stage, live_b["stage"], want_goal))
        page.unroute(live_url_b)

        # ── ⑤ (b) 周期刷新保留：共享层没有把 5s 对账吞成缓存（同 URL 反复发真网络） ──
        step["now"] = "周期刷新保留（无 TTL）"
        goto_view(page, "plan")
        plan_card = '[data-plan-card="TB-1"]'
        plan_seen = page.locator(plan_card).count() > 0
        if not plan_seen:
            try:
                page.wait_for_selector(plan_card, timeout=30000)
                plan_seen = True
            except Exception:  # noqa: BLE001
                plan_seen = False
        goal_text = text_of(page, plan_card + " [data-plan-card-goal]")
        label_text = text_of(page, plan_card + " [data-plan-card-status-label]")
        ok(plan_seen and (goal_text or "") != "" and (label_text or "") != "",
           "(b) 施工图页真渲染：卡 TB-1 的交付目标 %r、状态词 %r" % (goal_text, label_text))
        # 判据必须看**真实网络**，且不能被「整页重载」冒充：页内读数（window.__tt）在整页重载后会归零，
        # 重载后的首次挂载取数也不是「周期性对账」。所以用**有界条件等待**取两笔**新的** /plan 真网络请求，
        # 并要求它们落在同一页面实例内、相邻间隔落在真实 5s 轮询周期带内。全程只被动观测——不点手动刷新、
        # 不改产品轮询周期。共享层若把后续对账吞成缓存，第 2 笔永不出现；同一次挂载的两笔间隔 ≈0 也不通过。
        # 重载偶发（HMR/vite 管线扰动）时按有界次数重测，仍拿不到干净窗口就如实 FAIL，绝不放大 sleep 蒙混。
        attempt = 0
        clean = False
        gap = None
        while attempt < 3 and not clean:
            attempt += 1
            goto_view(page, "plan")  # 重测前确保还在施工图页（整页重载会把视图复位到默认页）
            try:
                page.wait_for_selector(plan_card, timeout=15000)
            except Exception:  # noqa: BLE001
                pass
            page.wait_for_timeout(1200)  # 让挂载期的首发取数先结算，别把它当成一次周期对账
            origin = page.evaluate("() => performance.timeOrigin")
            page.evaluate("() => window.__ttReset()")
            net.reset()
            deadline = time.time() + 3.0 * (REFRESH_MS / 1000.0) + 6.0  # 有界：约 3 个周期 + 余量
            while time.time() < deadline and len(net.times(PLAN_B, "request")) < 2:
                page.wait_for_timeout(150)
            ts = net.times(PLAN_B, "request")[:2]
            reloaded = page.evaluate("() => performance.timeOrigin") != origin
            gap = (ts[1] - ts[0]) / 1000.0 if len(ts) >= 2 else None
            clean = (not reloaded) and gap is not None and 2.0 <= gap <= 9.0
            if not clean:
                info("(b) 第 %d 次观测不干净（两笔=%s、间隔=%s、整页重载=%s），重测"
                     % (attempt, len(ts) >= 2, ("%.2fs" % gap) if gap is not None else "n/a", reloaded))
        calls = page.evaluate("() => (window.__ttSnapshot().calls['%s'] || 0)" % PLAN_B)
        info("(b) 实测：尝试 %d 次；最近一次 /plan 两笔真网络间隔 %s、页内底层 fetch 尝试 %d 笔"
             % (attempt, ("%.2fs" % gap) if gap is not None else "n/a", calls))
        ok(clean,
           "(b) 周期刷新保留（无 TTL）：停留施工图页用**有界条件等待**取到两笔**新的** /plan 真网络请求，"
           "相邻间隔 %.2fs 落在真实 5s 轮询周期带内、同一页面实例内（无整页重载）；底层 fetch 尝试累计 %d 笔。"
           "共享层把后续对账吞成缓存则第 2 笔不出现，同一次挂载的两笔 ≈0 间隔也不通过（尝试 %d 次）"
           % (gap if gap is not None else -1.0, calls, attempt))
        ok(page.locator('[data-plan-view][data-plan-stale="0"]').count() > 0 and page.locator(plan_card).count() > 0,
           "(b) 周期对账后施工图页无陈旧标记且卡仍在（首轮数据未被后台刷新清空）")

        # ── ⑥ (c) 旧回包不串项目：延迟 A 的 /live，延迟未回时切到 B ──
        step["now"] = "延迟旧回包/切项目"
        # 让 B 的现场也停在实况页（⑤ 把 B 留在施工图页了）：延迟未回时切过去要立刻看到 B 的实况
        switch_project(page, IDB)
        goto_view(page, "live")
        wait_text(page, "[data-live-stage]", lambda v: v == live_of(backend, IDB)["stage"], 30, "B 实况页阶段")
        switch_project(page, IDA)
        wait_text(page, "[data-live-stage]", lambda v: v == live_of(backend, IDA)["stage"], 30, "A 实况页阶段")
        live_a = live_of(backend, IDA)
        live_b = live_of(backend, IDB)
        different = live_a["stage"] != live_b["stage"]
        ok(different, "(c) 夹具前提：A/B 的实况读数可区分（A=%r / B=%r）" % (live_a["stage"], live_b["stage"]))
        live_url_a = "**/api/projects/%s/live" % IDA
        page.route(live_url_a, delay_route(6000, route_notes, "A /live 延迟"))
        net.reset()
        try:
            with page.expect_request(live_url_a, timeout=30000):
                pass  # 等周期对账发出一笔被延迟的 A /live（延迟未回）
            page.locator('[data-project-item="%s"]' % IDB).first.click()  # 延迟未回时切到 B
        except Exception as e:  # noqa: BLE001
            ok(False, "(c) 等 A 的在途一半切项目失败：%s" % e)
        wait_text(page, "[data-status-project]", lambda v: v == NAME_B, 30, "B 顶栏项目名")
        b_stage_ok, b_stage = wait_text(page, "[data-live-stage]", lambda v: v == live_b["stage"], 30, "B 实况阶段")
        goal_b = text_of(page, "[data-status-goal]") or ""
        leaked, leaked_text = False, ""
        dl = time.time() + 9  # 等过 6s 的延迟窗口：A 的迟到回包（或已被中止的在途）此刻都已了结
        while time.time() < dl:
            here = " | ".join([text_of(page, "[data-live-stage]") or "",
                               text_of(page, "[data-status-goal]") or ""])
            if live_a["stage"] in here or NAME_A in (text_of(page, "[data-status-project]") or ""):
                leaked, leaked_text = True, here
                break
            page.wait_for_timeout(300)
        late_resp = net.count(LIVE_A, "response")
        late_failed = net.count(LIVE_A, "failed")
        info("延迟窗口内 A 的 /live：到达浏览器的响应 %d 笔、失败/中止 %d 笔；%s"
             % (late_resp, late_failed, "；".join(route_notes) if route_notes else "（路由回填无异常）"))
        ok(b_stage_ok and text_of(page, "[data-status-project]") == NAME_B and (live_b["stage"] in goal_b or
                                                                               (live_b.get("current_task") or {}).get("id", "") in goal_b),
           "(c) 延迟未回时切到 B：界面只渲染 B 的同源数据（项目名=%r、阶段=%r==/live(B) 的 %r）"
           % (text_of(page, "[data-status-project]"), b_stage, live_b["stage"]))
        ok(not leaked,
           "(c) 延迟未回的 A 在途请求不污染 B：延迟窗口过后现场仍只有 B 的数据（A 的阶段 %r／项目名 %r 未出现）%s"
           % (live_a["stage"], NAME_A, ("——泄漏现场：%s" % leaked_text) if leaked else ""))
        page.unroute(live_url_a)

        # ── ⑦ (c2) 「迟到回包真的到达」那条路径：项目图页的 /live 轮询**不带 signal**（src/ui/arch/
        #    ProjectGraphView.tsx 的 tick），切项目时那一支订阅者还活着 ⇒ 这笔延迟响应不会被中止，
        #    会**真到达浏览器**（⑥ 那条路径是切项目即中止）。两条路径都不许把 A 的数据写进 B 的界面。 ──
        step["now"] = "迟到回包真到达（项目图页）"
        switch_project(page, IDA)
        page.wait_for_timeout(1200)  # 让切到 A 那一刻的 /live(A) 先结算，别和下面的项目图页取数并到同一笔
        page.route(live_url_a, delay_route(6000, route_notes, "A /live 延迟(迟达路径)"))
        net.reset()
        try:
            with page.expect_request(live_url_a, timeout=30000):
                goto_view(page, "arch")  # 进项目图页：挂载即取一次 /live(A)（不带 signal，切项目不会中止它）
            page.locator('[data-project-item="%s"]' % IDB).first.click()  # 响应还在 6s 延迟里就切走
        except Exception as e:  # noqa: BLE001
            ok(False, "(c) 迟到回包路径：进项目图页并在延迟未回时切走失败：%s" % e)
        wait_text(page, "[data-status-project]", lambda v: v == NAME_B, 30, "B 顶栏项目名")
        b2_ok, b2_stage = wait_text(page, "[data-live-stage]", lambda v: v == live_b["stage"], 30, "B 实况阶段")
        page.wait_for_timeout(7000)  # 跨过 6s 延迟：此刻 A 的迟到响应已到达并被丢弃
        delivered = net.count(LIVE_A, "response")
        shell_text = " | ".join([text_of(page, "[data-status-project]") or "",
                                 text_of(page, "[data-status-goal]") or "",
                                 text_of(page, "[data-live-stage]") or ""])
        leaked2 = any(bad in shell_text for bad in (live_a["stage"], NAME_A, "TA-1"))
        info("迟到路径：A 的 /live 响应到达浏览器 %d 笔（应 ≥1——证明这是真·迟到回包，不是被提前掐断）" % delivered)
        ok(delivered >= 1,
           "(c) 迟到回包路径成立：切项目后那笔 A /live 的响应确实到达浏览器（%d 笔），"
           "被判据丢弃而不是被提前中止" % delivered)
        ok(b2_ok and not leaked2,
           "(c) 真·迟到回包不污染 B：响应到达后 B 的界面仍只渲染 B 的同源数据（项目名=%r、阶段=%r==/live(B) 的 %r；"
           "现场未见 A 的阶段/项目名/卡号）%s"
           % (text_of(page, "[data-status-project]"), b2_stage, live_b["stage"],
              ("——泄漏：%s" % shell_text) if leaked2 else ""))
        page.unroute(live_url_a)
        info("（点题）⑥/⑦ 两条路径合起来覆盖：A 的在途被中止时与 A 的迟到回包真到达时，B 的界面都只渲染 B 的数据")

        browser.close()


def main():
    root = tempfile.mkdtemp(prefix="tatai-v0936ui-")
    home = os.path.join(root, "home")
    os.makedirs(home, exist_ok=True)
    backend = None
    vite = None
    code = EXIT_OK
    try:
        step["now"] = "夹具"
        proj_a = make_project(root, IDA, "甲", "TA-1", "design")
        proj_b = make_project(root, IDB, "乙", "TB-1", "requirement")
        make_registry(home, proj_a, proj_b)
        info("[%s] 被测仓库：%s" % (LABEL, REPO))
        info("隔离 TATAI_HOME：%s" % home)

        step["now"] = "起后端"
        port = free_port()
        backend = Backend(home, port, os.path.join(root, "ui-backend.log"))
        backend.wait_health()
        info("后端（动态端口）http://127.0.0.1:%d" % port)
        ok(backend.api("/api/projects/%s/live" % IDA)[0] == 200, "夹具 live 只读读口可用（HTTP 200）")

        step["now"] = "起 vite"
        vite_port = free_port()
        vite = start_vite(vite_port, port, os.path.join(root, "ui-vite.log"), os.path.join(root, "vite-cache"))
        info("vite（动态端口）http://localhost:%d" % vite_port)

        step["now"] = "浏览器"
        run_browser(vite_port, backend)
    except EnvMissing as e:
        print("[ui] 环境缺失：%s" % e)
        code = EXIT_ENV
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        ok(False, "UI 段在「%s」中断：%s" % (step["now"], e))
        code = EXIT_FAIL
    finally:
        if vite is not None:
            try:
                vite.kill()
                vite.wait(timeout=10)
            except Exception:  # noqa: BLE001
                pass
        if backend is not None:
            backend.kill()
        # 无模型调用核对：夹具不含模型配置，本段零模型（后端日志里不该出现模型入口）
        try:
            with open(os.path.join(root, "ui-backend.log"), encoding="utf-8", errors="replace") as f:
                log_text = f.read()
            ok("ask_flash" not in log_text, "后端日志未见模型调用入口（夹具无模型配置，本段零模型）")
        except Exception:  # noqa: BLE001
            pass
        if KEEP:
            info("保留现场：%s（V0936_KEEP_TMP=1）" % root)
        else:
            shutil.rmtree(root, ignore_errors=True)

    if code == EXIT_ENV:
        print("[ui] 环境缺失，未跑完：PASS %d，FAIL %d（不计为通过）" % (passes[0], len(fails)))
        sys.exit(EXIT_ENV)
    print("[ui] [%s] PASS %d，FAIL %d" % (LABEL, passes[0], len(fails)))
    if fails:
        for f in fails:
            print("[ui]   FAIL " + f)
        sys.exit(EXIT_FAIL)
    if code != EXIT_OK:
        sys.exit(code)
    print("[ui] 全部 PASS")
    sys.exit(EXIT_OK)


if __name__ == "__main__":
    main()
