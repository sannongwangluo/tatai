#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-12 UI 真机验证：六图「正在更新／预计用时／失效」与「无需手动刷新拿到新图」。

用法：python scripts/verify-v09-12-ui.py
      （或 pnpm verify:v09-12-ui；V0912_SHOT_DIR 换截图目录、V0912_KEEP_TMP=1 保留现场）

为什么必须跑真浏览器（PLAN.md V09-12 检查项 ②③ + DESIGN 附录 E.8-4）：
  · ②「更新期间显示正在更新与预计用时；依据不足时显示无法估计」——这是**上屏**口径：
    真浏览器里读 `data-project-update*` 才算数，服务端单测只能证明记录里没编数字。
  · ③「变更完成后下一次打开拿到本次变更对应的完整新图」——真 DOM 里节点真的出现/指纹真的对上，
    才算"拿到了新图"，而不是"提示了一句"。

隔离口径（AGENTS.md §5）：临时 `TATAI_HOME` + 夹具项目（自带 design/plan/modules.json）；
真实塔台项目一个字节都不碰；后端走动态空闲端口（不动 8787）；vite 固定 5173 被占即拒跑。
本脚本**不点刷新、不切项目**去驱动变更——变更一律写**夹具项目磁盘上的源码文件**（真 watcher 链路）。
"""
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
SHOT_DIR = os.environ.get(
    "V0912_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "V09-12", "1", "ui-shots")
)
KEEP = os.environ.get("V0912_KEEP_TMP") == "1"
FIX_ID = "v0912ui"

passes = [0]
fails = []
step = {"now": "启动"}


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


def port_busy(port):
    s = socket.socket()
    s.settimeout(0.5)
    try:
        s.connect(("127.0.0.1", port))
        return True
    except Exception:
        return False
    finally:
        s.close()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return path


def http(url, method="GET", body=None, headers=None, timeout=120):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, method=method, data=data)
    if data is not None:
        req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
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


def change_token(lines):
    """与 graphRefresh 内部同一口径：action:path 排序后 \\n 连接，sha256 取前 16 位"""
    import hashlib

    return hashlib.sha256("\n".join(sorted(lines)).encode("utf-8")).hexdigest()[:16]


# ══════════════════════════════ 夹具 ══════════════════════════════

DESIGN = """# V09-12 UI 夹具设计书

## 2 模块划分

| # | 模块 | 说明 |
| --- | --- | --- |
| 1 | 甲模块 | 夹具能力 |

## 3 说明

夹具正文。
"""

PLAN = """# V09-12 UI 夹具施工图

| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |
| --- | --- | --- | --- | --- |
| T-1 | todo | 甲模块落成 |  | 甲验收记录 |

### T-1 甲模块落成

**设计依据**：§2。

- [ ] 甲做出来

**交付**：甲验收记录。
"""

MODULES = {
    "version": 1,
    "generated_at": "2026-09-24T00:00:00+08:00",
    "budget_exhausted": False,
    "modules": [
        {"id": "src", "path": "src", "name": "", "file_count": 2, "loc": 6, "deps": []},
        {"id": "src-lib", "path": "src/lib", "name": "", "file_count": 1, "loc": 3, "deps": []},
    ],
}

PROGRESS = {
    "version": 1,
    "gate": {
        "current_step": "design",
        "history": [
            {"step": "kickoff", "result": "pass", "at": "2026-09-24T00:00:00+08:00", "note": None},
            {"step": "requirement", "result": "pass", "at": "2026-09-24T00:00:00+08:00", "note": None},
            {"step": "design", "result": "pending", "at": None, "note": None},
        ],
    },
    "modules": [{"id": "src", "name": "源码", "status": "todo"}],
}


def make_fixture(root):
    proj = os.path.join(root, "work", FIX_ID)
    write(os.path.join(proj, ".工作台", "design.md"), DESIGN)
    write(os.path.join(proj, ".工作台", "plan.md"), PLAN)
    write(os.path.join(proj, ".工作台", "arch", "modules.json"),
          json.dumps(MODULES, ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(proj, ".工作台", "progress.json"),
          json.dumps(PROGRESS, ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(proj, ".工作台", "gate.jsonl"), "")
    write(os.path.join(proj, "src", "index.ts"), "export const a = 1;\n")
    write(os.path.join(proj, "src", "plain.ts"), "export const p = 1;\n")
    write(os.path.join(proj, "src", "lib", "util.ts"), "export const u = 1;\n")
    return proj


def make_registry(home, fix_proj):
    now = "2026-09-24T00:00:00+08:00"
    write(os.path.join(home, "registry.json"),
          json.dumps({"version": 1, "projects": [
              {"id": FIX_ID, "name": "V09-12 UI 夹具", "path": fix_proj, "kind": "backend",
               "registered_at": now, "last_opened_at": now},
          ]}, ensure_ascii=False, indent=2) + "\n")


# ══════════════════════════════ 后端 / vite ══════════════════════════════

class Backend:
    def __init__(self, home, port, log_path, extra_env=None):
        env = dict(os.environ)
        env["TATAI_HOME"] = home
        env["TATAI_PORT"] = str(port)
        # V09-12 UI 段：把安全防抖的**最小间隔**拉长，让"正在更新（等闸门）"这一窗口长过页面 4s 轮询
        # （与 watcher 的 TATAI_WATCH_* 同一先例：只调闸门量级，不改判定与文案；跑完即进程结束）
        env.update(extra_env or {})
        self.port = port
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", os.path.join("src", "server", "index.ts")],
            cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
        )

    def api(self, path, method="GET", body=None, headers=None):
        return http("http://127.0.0.1:%d%s" % (self.port, path), method, body, headers)

    def wait_health(self, timeout=120):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("后端进程退出（日志见 ui-backend.log）")
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
    deadline = time.time() + 120
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("vite 起不来（进程已退出，见 ui-vite.log）")
        try:
            with urllib.request.urlopen("http://localhost:%d/" % port, timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("vite %d 未就绪" % port)


# ══════════════════════════════ 浏览器断言 ══════════════════════════════

ROOT = "[data-project-view]"


def read_attr(page, selector, attr):
    loc = page.locator(selector)
    if loc.count() == 0:
        return None
    return loc.first.get_attribute(attr)


def run_browser(vite_port, backend, home, fix_proj):
    base = "http://localhost:%d" % vite_port

    def served_update():
        _s, body = backend.api("/api/projects/%s/arch/blueprint" % FIX_ID)
        return ((body or {}).get("update") or None)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1680, "height": 1000}).new_page()
        page.goto("%s/#p/%s" % (base, FIX_ID), wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        # 进图页（系统架构主视图里 ArchCanvas 会画实测模块层）
        page.locator('button[data-view="arch"]').click()
        page.wait_for_selector(ROOT, timeout=30000)
        page.wait_for_timeout(1200)
        os.makedirs(SHOT_DIR, exist_ok=True)
        page.screenshot(path=os.path.join(SHOT_DIR, "01-before-change.png"))
        nav_count_before = page.evaluate("performance.getEntriesByType('navigation').length")
        info("变更前：data-project-update=%r" % read_attr(page, ROOT, "data-project-update"))

        # ── 写夹具项目里的**深层模块**文件（真 watcher 链路；页面一动不动） ──
        deep_file = os.path.join(fix_proj, "src", "deep", "x.ts")
        write(deep_file, "export const x = 1;\n")
        token1 = change_token(["add:src/deep/x.ts"])
        info("已写 %s（不动页面、不点刷新）；期望本轮指纹 %s" % (deep_file, token1))

        # ① 更新完成：无需手动刷新 → ready + 指纹等于本次变更（图页自动失效重取的直接证据）
        ready_deadline = time.time() + 30
        state = token_now = None
        while time.time() < ready_deadline:
            state = read_attr(page, ROOT, "data-project-update")
            token_now = read_attr(page, ROOT, "data-project-update-token")
            if state == "ready" and token_now == token1:
                break
            page.wait_for_timeout(300)
        ok(state == "ready" and token_now == token1,
           "不点刷新：页面读数自己变成 ready 且本轮指纹对上（state=%r token=%r）" % (state, token_now))
        ok(page.locator("[data-project-update-banner]").count() == 0, "ready 时「正在更新」横幅不残留")
        page.screenshot(path=os.path.join(SHOT_DIR, "02-ready-after-change.png"))

        # ② 更新**期间**的呈现：第二次变更落在安全防抖闸门内 → 更新窗口被拉长到轮询读得到
        #    （后端用 TATAI_GRAPH_REFRESH_MIN_INTERVAL_MS 放宽闸门；判定与文案一个字没改）
        deep2 = os.path.join(fix_proj, "src", "deep2", "y.ts")
        write(deep2, "export const y = 1;\n")
        token2 = change_token(["add:src/deep2/y.ts"])
        info("已写 %s（紧接着上一轮 ⇒ 排队等闸门）；期望本轮指纹 %s" % (deep2, token2))
        seen_updating = False
        eta_samples = []
        deadline = time.time() + 25
        while time.time() < deadline:
            state = read_attr(page, ROOT, "data-project-update")
            eta = read_attr(page, "[data-project-update-eta]", "data-project-update-eta")
            banner = page.locator("[data-project-update-banner]")
            if state == "updating" and banner.count() > 0:
                if not seen_updating:
                    page.screenshot(path=os.path.join(SHOT_DIR, "03-updating-banner.png"))
                seen_updating = True
                text = banner.first.inner_text()
                eta_samples.append((eta, text, (served_update() or {}).get("phase"), ((served_update() or {}).get("eta") or {}).get("basis")))
            if seen_updating and len(eta_samples) >= 3:
                break
            page.wait_for_timeout(300)
        ok(seen_updating, "不点刷新：更新期间页面自己出现「正在更新」横幅（data-project-update=updating）")
        if eta_samples:
            eta_text = eta_samples[0][0]
            banner_text = eta_samples[0][1]
            phases = sorted({s[2] for s in eta_samples if s[2]})
            bases = sorted({s[3] for s in eta_samples if s[3]})
            info("更新期间读数：eta=%r；阶段=%s；服务端依据=%s；横幅=%s" % (eta_text, phases, bases, banner_text[:120]))
            ok("图正在更新" in banner_text, "横幅文字含「图正在更新」（②口径在场）")
            ok(
                eta_text == "无法估计" or (eta_text or "").startswith("约 "),
                "预计用时读数是「无法估计」或「约 N 秒」两种合规形态之一（实际 %r）" % eta_text,
            )
            # 一致性（反例断言）：界面读数必须与服务端记录的依据对得上——
            # 记录说 basis=none（没依据）时界面必须「无法估计」；有依据时才允许给秒数。
            consistent = all(
                (s[0] == "无法估计") if s[3] == "none" else bool(s[0] and s[0].startswith("约 "))
                for s in eta_samples
            )
            ok(consistent, "反例断言：界面预计用时与记录依据一致（basis=none ⇔ 无法估计；有依据才出秒数）")

        # ③ 更新完成后：指纹换成第二次变更、横幅消失（仍是零手动刷新）
        ready_deadline = time.time() + 30
        while time.time() < ready_deadline:
            state = read_attr(page, ROOT, "data-project-update")
            token_now = read_attr(page, ROOT, "data-project-update-token")
            if state == "ready" and token_now == token2:
                break
            page.wait_for_timeout(300)
        ok(state == "ready" and token_now == token2,
           "不点刷新：第二轮更新完成后指纹换成第二次变更（state=%r token=%r）" % (state, token_now))
        ok(page.locator("[data-project-update-banner]").count() == 0, "第二轮 ready 后横幅同样自动消失")
        nav_count_after = page.evaluate("performance.getEntriesByType('navigation').length")
        ok(nav_count_before == nav_count_after == 1,
           "全程零手动刷新/零重载：页面导航计数 %d → %d" % (nav_count_before, nav_count_after))
        page.screenshot(path=os.path.join(SHOT_DIR, "04-ready-second-round.png"))

        # ④ 下一次打开拿到本次变更对应的完整新图：切到技术详情（切页签，不是刷新），新深层模块在场
        page.locator('[data-project-view-tab="tech"]').click()
        page.wait_for_selector("[data-arch-node]", timeout=30000)
        page.wait_for_timeout(1500)
        nodes = page.locator("[data-arch-node]")
        ids = [nodes.nth(i).get_attribute("data-arch-node") for i in range(nodes.count())]
        ok(
            "src-deep" in ids and "src-deep2" in ids,
            "技术详情画布上出现两次变更新增的深层模块节点（节点: %s）" % "、".join([i for i in ids if i][:12]),
        )
        page.screenshot(path=os.path.join(SHOT_DIR, "05-tech-canvas-new-modules.png"))

        # ⑤ 页面自己那条链在动（数据层拉取计数 ≥1 即证不是"靠人刷新"）：读 DOM 计数
        loads = read_attr(page, "[data-arch-data-loads]", "data-arch-data-loads")
        ok(loads is not None and int(loads) >= 1, "技术详情数据层拉取计数在场（data-arch-data-loads=%r）" % loads)

        browser.close()


def main():
    root = tempfile.mkdtemp(prefix="tatai-v0912ui-")
    home = os.path.join(root, "home")
    os.makedirs(home, exist_ok=True)
    backend = None
    vite = None
    try:
        step["now"] = "夹具"
        fix_proj = make_fixture(root)
        make_registry(home, fix_proj)
        info("隔离 TATAI_HOME：%s" % home)
        info("夹具项目：%s" % fix_proj)

        step["now"] = "起后端"
        port = free_port()
        backend = Backend(
            home, port, os.path.join(root, "ui-backend.log"),
            # 把安全防抖**最小间隔**放宽（只调闸门量级）：让"正在更新（等闸门）"这一窗口长过页面 4s 轮询，
            # 使 ② 的真机读数可确定性复现。判定判据与文案一个字都没改。
            extra_env={"TATAI_GRAPH_REFRESH_MIN_INTERVAL_MS": "15000"},
        )
        backend.wait_health()
        info("后端就绪 http://127.0.0.1:%d（闸门：TATAI_GRAPH_REFRESH_MIN_INTERVAL_MS=15000）" % port)

        step["now"] = "开监听"
        status, body = backend.api("/api/projects/%s/watch" % FIX_ID, "POST")
        ok(status == 200 and (body or {}).get("ok") is True, "夹具项目开监听成功（发现链随监听挂上，HTTP %s）" % status)
        # 等 watcher ready，否则首次写入会落在启动窗口（只喂 size 表）
        deadline = time.time() + 20
        ready = False
        while time.time() < deadline and not ready:
            _s, w = backend.api("/api/watch")
            ready = any(d.get("id") == FIX_ID and d.get("ready") for d in ((w or {}).get("details") or []))
            if not ready:
                time.sleep(0.3)
        ok(ready, "watcher 就绪（此后写入才进发现链）")

        step["now"] = "起 vite"
        vite_port = 5173
        if port_busy(vite_port):
            raise RuntimeError("5173 已被占用（不碰别人的 dev server）——本段无法在本机真跑")
        vite = start_vite(vite_port, port, os.path.join(root, "ui-vite.log"))
        info("vite 就绪 http://localhost:%d" % vite_port)

        step["now"] = "浏览器"
        run_browser(vite_port, backend, home, fix_proj)
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        ok(False, "UI 段在「%s」中断：%s" % (step["now"], e))
    finally:
        if vite is not None:
            try:
                vite.kill()
                vite.wait(timeout=10)
            except Exception:
                pass
        if backend is not None:
            backend.kill()
        if KEEP:
            info("保留现场：%s（V0912_KEEP_TMP=1）" % root)
        else:
            shutil.rmtree(root, ignore_errors=True)

    print("[ui] 计数：%d PASS / %d FAIL" % (passes[0], len(fails)))
    print("[ui] 截图目录：%s" % SHOT_DIR)
    if fails:
        for f in fails:
            print("[ui]   FAIL " + f)
        sys.exit(1)
    print("[ui] 全部 PASS")


if __name__ == "__main__":
    main()
