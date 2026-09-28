#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""T19 解析 run UI 闭环验证（Python + Playwright 真浏览器）：DESIGN §11.8 末段合同在真实 DOM/
真实 HTTP/真实文件系统上的行为证据（后端形态由 pnpm verify:t19-parse-run 覆盖，本脚本覆盖 UI 侧）。

用法：python scripts/verify-t19-parse-run-ui.py
      （T19_KEEP_TMP=1 保留临时夹具现场；T19_SHOT_DIR 可改截图目录，默认 .工作台/evidence/T19/1/）

合同条款 → 本脚本断言/截图映射：
  ① 后台可取消、前台保持响应
     → 03（进行中运行态条：进度文案＋显式取消钮）＋「进行中切功能全景再切回技术详情」页签照样响应；
  ② 进行中 UI 可响应（进度可见、不阻塞其它操作）
     → 03/06（运行态条只是一条横幅：切页签、旧图都在）＋ 06（运行中图上仍有 .react-flow__node）；
  ③ 取消只来自显式动作：断连/刷新/切项目≠取消，重连可续看
     → 06/07（HTTP 发起的 run，页面两次刷新后自动挂上续看——无任何点击发起）＋
        08（run 最终 done 而非 cancelled：刷新没触发取消）；
  ④ 显式取消不发布半成品：保留上次有效结果并标明未完成原因
     → 04（无旧结果时：原因说明＋modules.json 仍未落盘）＋ 09（有旧结果时：原因条＋旧图保留
        ＋modules.json 逐字节不变——取消动作由真实浏览器点击触发）；
  ⑤ 取消后可重试
     → 05（引导态「重新解析」跑完出图）＋ 10（图上「重新解析」跑完、原因条消、图刷新）；
  U-02（2026-09-21 收口审计）：主视图（系统架构）里解析 done 不得把静态解析图盖上画布
     → 11/12（技术详情发起解析 → 切系统架构等 done：运行态条消＋节点 id 集合逐项不变）。

夹具与隔离（AGENTS.md §5 / 卡面红线）：
  · 临时 TATAI_HOME + tempfile 下两个夹具项目（小 12 文件 / 大 4800 文件），绝不碰真实项目；
  · 不调模型网关：DEEPSEEK_API_KEY 置空；names.json 由夹具预算签名预置（渲染层按 id 合名，
    跳过 Flash 起名步）——预解析只走真 POST /arch/parse 静态解析，零模型；
  · 收尾杀净子进程、删临时目录（T19_KEEP_TMP=1 可留现场）。
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SHOT_DIR = os.environ.get("T19_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "T19", "1"))
KEEP = os.environ.get("T19_KEEP_TMP") == "1"

SMALL = "t19ui-small"
BIG = "t19ui-big"
BIG_DIRS = 12
BIG_FILES_PER_DIR = 400           # 4800 个带 import 的 .ts：解析 3s 级，取消窗口充足
SMALL_DIRS = 3
SMALL_FILES_PER_DIR = 4

fails = []
passes = [0]
ROOTS = {}


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


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return path


def http(url, method="GET", body=None, timeout=120, headers=None):
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


# ══════════════════════════════ 夹具 ══════════════════════════════

def make_source(d, f):
    lines = [
        'import { v0 } from "./f0";',
        "export const v%d = v0 + %d;" % (f, f),
        "export function fn%d(x: number): number {" % f,
        "  const a = x * %d;" % f,
        "  return a + v0;",
        "}",
    ]
    for i in range(24):
        lines.append("export const pad%d = %d;" % (i, d * 100000 + f * 100 + i))
    return "\n".join(lines) + "\n"


def make_project(root, pid, dirs, files_per_dir):
    os.makedirs(root, exist_ok=True)
    for d in range(dirs):
        for f in range(files_per_dir):
            write(os.path.join(root, "d%02d" % d, "f%d.ts" % f), make_source(d, f))
    write(os.path.join(root, "package.json"), json.dumps({"name": pid}))
    write(os.path.join(root, "README.md"), "# %s 夹具\n" % pid)
    return root


def make_registry(home, records):
    write(os.path.join(home, "registry.json"),
          json.dumps({"version": 1, "projects": records}, ensure_ascii=False, indent=2) + "\n")


def seed_names(backend, root, pid):
    """经**真实** POST /arch/parse 静态解析一次 → 按产出的模块 id 预置 names.json（渲染层按 id
    合名、不验签名）→ 删掉 modules.json 回到「未解析」现场。效果：浏览器里解析跑完后节点有名，
    跳过 Flash 起名步（本测试不调模型网关）；模块 id 由目录结构决定，重跑一致。"""
    st, body = backend.api("/api/projects/%s/arch/parse" % pid, "POST", {})
    if st != 200 or not isinstance(body, dict) or not body.get("result"):
        raise RuntimeError("夹具预解析失败 HTTP %s：%s" % (st, str(body)[:300]))
    modules_file = os.path.join(root, ".工作台", "arch", "modules.json")
    with open(modules_file, encoding="utf-8") as f:
        data = json.load(f)
    entries = {}
    for m in data["modules"]:
        entries[m["id"]] = {
            "name": "夹具模块-%s" % m["id"], "blurb": "夹具预置名", "kind": "code",
            "named_at": "2026-09-21T00:00:00.000Z", "signature": "fixture-seed",
        }
    write(os.path.join(root, ".工作台", "arch", "names.json"),
          json.dumps({"version": 1, "entries": entries}, ensure_ascii=False, indent=2) + "\n")
    os.remove(modules_file)
    return len(entries)


DESIGN_TEXT = "\n".join([
    "# T19 主视图夹具设计书",
    "",
    "## 1 概述",
    "主视图 override 场景夹具。",
    "",
    "## 2 能力甲",
    "能力甲为人提供甲。",
    "",
    "## 3 模块划分",
    "- 模块甲：甲的实现",
    "- 模块乙：乙的实现",
    "",
])
PLAN_TEXT = "\n".join([
    "# T19 主视图夹具施工图",
    "",
    "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
    "| --- | --- | --- | --- | --- |",
    "| T-1 | todo | 能力甲落成 |  | 甲验收记录 |",
    "",
    "### T-1 能力甲落成",
    "",
    "**设计依据**：§2。",
    "",
    "**契约**：输入甲，输出甲的产物。",
    "",
    "**文件责任**：`src/a.ts`。",
    "",
    "- [ ] 甲做出来",
    "",
    "**交付**：甲验收记录。",
    "",
])


def seed_blueprint(home, root, pid, tmp):
    """给主视图（系统架构）铺规划权威层：写 design/plan → 进程内 activateBaseline +
    rebuildBlueprint（确定性派生、零模型，与 verify-c014 夹具现场同款直写准备）→
    主视图的 graphOverride 才有规划图可喂。经临时 .ts 走 tsx（与全部 verify 脚本同一入口）。"""
    write(os.path.join(root, ".工作台", "design.md"), DESIGN_TEXT)
    write(os.path.join(root, ".工作台", "plan.md"), PLAN_TEXT)
    repo_url = "file:///" + os.path.abspath(REPO).replace("\\", "/")
    seed_ts = os.path.join(tmp, "seed-blueprint.ts")
    write(seed_ts, "\n".join([
        "const home = process.env.TATAI_HOME!;",
        "const pid = process.env.SEED_PID!;",
        "(async () => {",
        '  const { activateBaseline } = await import("%s/src/server/work/documents.ts");' % repo_url,
        '  const { rebuildBlueprint } = await import("%s/src/arch/blueprint.ts");' % repo_url,
        '  activateBaseline(pid, { approved_by: "fixture", approval_basis: "T19 UI 夹具技术审定（非真实用户 Gate）", approval_kind: "delegated_technical_review" }, home);',
        '  const r = await rebuildBlueprint(pid, { trigger: "t19-ui-seed" });',
        '  if (!r.publish.published || r.blueprint === null) { console.error("seed 派生未发布：" + (r.publish.reason ?? "?")); process.exit(1); }',
        '  console.log("seed blueprint nodes=" + r.blueprint.nodes.length);',
        "})().catch((e) => { console.error(e); process.exit(1); });",
    ]))
    env = dict(os.environ)
    env["TATAI_HOME"] = home
    env["SEED_PID"] = pid
    env["DEEPSEEK_API_KEY"] = ""
    proc = subprocess.run(["node", "--import", "tsx", seed_ts], cwd=REPO, env=env,
                          capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        raise RuntimeError("seed_blueprint 失败：%s%s" % (proc.stdout[-500:], proc.stderr[-1500:]))
    info("主视图规划层已铺好（%s）" % proc.stdout.strip().splitlines()[-1])


# ══════════════════════════════ 后端 / vite ══════════════════════════════

class Backend:
    def __init__(self, home, port, log_path):
        self.home = home
        self.port = port
        env = dict(os.environ)
        env["TATAI_HOME"] = home
        env["TATAI_PORT"] = str(port)
        env["DEEPSEEK_API_KEY"] = ""
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", os.path.join("src", "server", "index.ts")],
            cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
        )

    def api(self, path, method="GET", body=None, timeout=120):
        return http("http://127.0.0.1:%d%s" % (self.port, path), method, body, timeout=timeout)

    def wait_health(self, timeout=90):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError("后端进程退出，日志见 " + str(self.proc.args))
            try:
                status, _ = self.api("/health")
                if status == 200:
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
            raise RuntimeError("vite 起不来（进程已退出）")
        try:
            with urllib.request.urlopen("http://localhost:%d/" % port, timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("vite %d 未就绪" % port)


def wait_run(backend, pid, want, timeout=25):
    """GET 轮询 run 状态（与页面续看同一通道）；want 为可接受状态集合。"""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        st, body = backend.api("/api/projects/%s/arch/parse" % pid)
        if st == 200 and isinstance(body, dict):
            last = body.get("run")
            if last and last.get("status") in want:
                return last
        time.sleep(0.1)
    return last


def start_parse_bg(backend, pid):
    """后台线程发 POST arch/parse（等终态的那个请求）——模拟另一个客户端/页面发起的解析。"""
    box = {}
    def bg():
        try:
            box["st"], box["body"] = backend.api("/api/projects/%s/arch/parse" % pid, "POST", {})
        except Exception as e:  # 连接被服务端关闭等
            box["error"] = str(e)
    t = threading.Thread(target=bg, daemon=True)
    t.start()
    return t, box


# ══════════════════════════════ 浏览器断言 ══════════════════════════════

def run_browser(vite_port, backend):
    base = "http://localhost:%d" % vite_port
    big_modules = os.path.join(ROOTS[BIG], ".工作台", "arch", "modules.json")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})

        def shot(name):
            page.screenshot(path=os.path.join(SHOT_DIR, name))

        def goto_tech(pid):
            page.goto("%s/#p/%s" % (base, pid), wait_until="domcontentloaded")
            page.wait_for_selector('button[data-view="arch"]', timeout=60000)
            page.locator('[data-project-view-tab="tech"]').click()
            page.wait_for_selector("[data-graph-mode-switch]", timeout=30000)

        # ── ① 小项目：引导态 → 先解析 → 出图（无取消、无错误横幅）──
        info("① 小项目基础流（引导态→先解析→出图）")
        goto_tech(SMALL)
        page.wait_for_selector("[data-arch-parse-start]", timeout=30000)
        ok("这个项目还没有解析过架构" in page.locator("body").inner_text(),
           "① 未解析引导态如实显示（引导文案＋先解析入口）")
        shot("01-small-guide.png")
        page.locator("[data-arch-parse-start]").click()
        page.wait_for_selector("[data-arch-canvas-host] .react-flow__node", timeout=40000)
        ok(page.locator("[data-arch-canvas-host] .react-flow__node").count() > 0, "① 先解析跑完出图")
        ok(page.locator("[data-arch-parse-cancel-note]").count() == 0, "① 顺利跑完：无取消原因说明")
        ok(page.locator("[data-arch-error-banner]").count() == 0, "① 顺利跑完：无错误横幅（起名步已被 names 缓存跳过）")
        shot("02-small-done.png")

        # ── ② 大项目：运行态（进度＋取消钮）→ 进行中页面可响应 → 显式取消 → 原因＋无半成品 ──
        info("② 大项目：运行态/页面可响应/显式取消")
        goto_tech(BIG)
        page.wait_for_selector("[data-arch-parse-start]", timeout=30000)
        page.locator("[data-arch-parse-start]").click()
        page.wait_for_selector('[data-arch-parse-run="running"]', timeout=15000)
        progress_text = page.locator("[data-arch-parse-progress]").first.inner_text()
        ok("解析" in progress_text, "② 进行中显示运行态与进度（%s）" % progress_text.strip())
        ok(page.locator("[data-arch-parse-cancel]").count() >= 1, "② 进行中提供显式取消按钮")
        shot("03-big-running.png")
        # 进行中切到功能全景再切回：页签响应＝不阻塞其它操作；切回（重挂）自动续看＝断连≠取消
        page.locator('[data-project-view-tab="functional"]').click()
        page.wait_for_selector('[data-arch-tab="functional"]', timeout=10000)
        ok(True, "② 解析进行中切到功能全景页签照常响应（不阻塞其它操作）")
        page.locator('[data-project-view-tab="tech"]').click()
        page.wait_for_selector('[data-arch-parse-run="running"]', timeout=15000)
        ok(True, "②③ 切走再切回（画布重挂）后运行态自动续看——切换没有取消 run")
        # 显式取消（真实浏览器点击 = 合同里唯一的取消来源）
        page.locator("[data-arch-parse-cancel]").first.click()
        page.wait_for_selector("[data-arch-parse-cancel-note]", timeout=15000)
        note_text = page.locator("[data-arch-parse-cancel-note]").first.inner_text()
        ok("取消" in note_text and "未写入" in note_text and "沿用上次完整落盘状态" in note_text,
           "②④ 取消后如实显示未完成原因（%s…）" % note_text.strip()[:60])
        ok(not os.path.exists(big_modules), "②④ 取消后 modules.json 仍未落盘（部分结果不发布）")
        ok(page.locator("[data-arch-parse-start]").count() == 1, "②⑤ 取消后引导态给出重新发起入口")
        shot("04-big-cancelled-note.png")
        st, body = backend.api("/api/projects/%s/arch/parse" % BIG)
        ok(st == 200 and isinstance(body, dict) and (body.get("run") or {}).get("status") == "cancelled",
           "②④ HTTP 交叉核对：run 终态 cancelled（与界面口径一致）")

        # ── ③ 取消后重试（引导态重新解析）→ 跑完出图 ──
        info("③ 取消后重试")
        page.locator("[data-arch-parse-start]").click()
        page.wait_for_selector("[data-arch-canvas-host] .react-flow__node", timeout=60000)
        ok(os.path.exists(big_modules), "③⑤ 重跑后 modules.json 完整落盘")
        with open(big_modules, encoding="utf-8") as f:
            mods = json.load(f)["modules"]
        ok(len(mods) >= BIG_DIRS, "③⑤ 重跑结果完整（%d 个模块 ≥ %d 目录）" % (len(mods), BIG_DIRS))
        ok(page.locator("[data-arch-parse-cancel-note]").count() == 0, "③ 重跑成功后取消原因说明已消")
        shot("05-big-retry-done.png")

        # ── ④ 断连≠取消＋进页面自动挂上续看：HTTP 发起 run，页面两次刷新 ──
        info("④ 断连≠取消（HTTP 发起 + 两次页面刷新续看）")
        # 先刷新落到功能全景（此刻还没有 run），再由 HTTP 发起——点进技术详情时才"发现"它
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector('button[data-view="arch"]', timeout=60000)
        t4, box4 = start_parse_bg(backend, BIG)
        run4 = wait_run(backend, BIG, ("running",), timeout=25)
        ok(run4 is not None and run4.get("status") == "running", "④ HTTP 发起的 run 进入进行中")
        run4_id = (run4 or {}).get("id")
        # 进技术详情（无任何发起点击）应自动挂上运行态
        page.locator('[data-project-view-tab="tech"]').click()
        try:
            page.wait_for_selector('[data-arch-parse-run="running"]', timeout=15000)
        except Exception:
            # 诊断（断言照旧红）：此刻服务端 run 实况 + 页面现场，便于区分"挂上失败"与"run 已结束"
            st_d, body_d = backend.api("/api/projects/%s/arch/parse" % BIG)
            run_d = (body_d or {}).get("run") if isinstance(body_d, dict) else None
            info("④ 诊断：挂上等待超时——服务端 run=%s；页内 run 条数=%d；取消原因条=%d" % (
                json.dumps(run_d, ensure_ascii=False)[:300] if run_d else None,
                page.locator('[data-arch-parse-run]').count(),
                page.locator("[data-arch-parse-cancel-note]").count()))
            shot("XX-big-reattach-miss.png")
            raise
        ok(True, "④③ 进页面发现进行中 run，自动挂上续看（零点击发起）")
        ok(page.locator("[data-arch-canvas-host] .react-flow__node").count() > 0,
           "④② 运行态条不顶掉旧图（进行中旧结果仍可见可操作）")
        shot("06-big-reattach-running.png")
        st, body = backend.api("/api/projects/%s/arch/parse" % BIG)
        r4 = body.get("run") or {}
        ok(r4.get("id") == run4_id and r4.get("status") != "cancelled",
           "④③ 刷新 #1 后 run 未被取消（status=%s，同一 run_id）" % r4.get("status"))
        # 刷新 #2：再次断连重连
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector('button[data-view="arch"]', timeout=60000)
        page.locator('[data-project-view-tab="tech"]').click()
        try:
            page.wait_for_selector('[data-arch-parse-run="running"]', timeout=8000)
            ok(True, "④③ 第二次刷新后仍自动挂上续看")
            shot("07-big-reattach-running-2.png")
        except Exception:
            info("④ 第二次刷新时 run 已跑完（同样证明刷新没有取消它）")
        # 终态：run 必须 done（不是 cancelled）——两次刷新都没触发取消
        t4.join(timeout=70)
        final4 = wait_run(backend, BIG, ("done", "cancelled", "failed"), timeout=10)
        ok(final4 is not None and final4.get("status") == "done" and final4.get("id") == run4_id,
           "④③ 两次刷新后 run 终态 done（断连/刷新≠取消；实际 status=%s）" % (final4 or {}).get("status"))
        page.wait_for_selector('[data-arch-parse-run="running"]', state="detached", timeout=30000)
        ok(page.locator("[data-arch-canvas-host] .react-flow__node").count() > 0, "④ 终态后运行态条已消、图照常显示")
        shot("08-big-reattach-done.png")

        # ── ⑤ 有旧结果时显式取消：图上原因条＋旧图保留＋modules.json 逐字节不变；再点图上重新解析 ──
        info("⑤ 图上显式取消（旧结果保留＋逐字节不变）与图上重发")
        with open(big_modules, "rb") as f:
            bytes_before = f.read()
        t5, _box5 = start_parse_bg(backend, BIG)
        run5 = wait_run(backend, BIG, ("running",), timeout=25)
        ok(run5 is not None and run5.get("status") == "running", "⑤ 第二次 HTTP run 进入进行中")
        # 用页签切换重挂画布（比重整页刷新快一个量级，给取消点击留足窗口；重挂即自动挂上续看）
        page.locator('[data-project-view-tab="functional"]').click()
        page.wait_for_selector('[data-arch-tab="functional"]', timeout=10000)
        page.locator('[data-project-view-tab="tech"]').click()
        page.wait_for_selector('[data-arch-parse-run="running"]', timeout=15000)
        page.locator("[data-arch-parse-cancel]").first.click()
        page.wait_for_selector("[data-arch-parse-cancel-note]", timeout=15000)
        ok(page.locator("[data-arch-parse-retry]").count() == 1, "⑤④ 图上取消后给出「重新解析」入口")
        ok(page.locator("[data-arch-canvas-host] .react-flow__node").count() > 0,
           "⑤④ 取消后旧图保留（上次有效结果没有被清空）")
        with open(big_modules, "rb") as f:
            bytes_after = f.read()
        ok(bytes_after == bytes_before, "⑤④ 显式取消不发布半成品：modules.json 逐字节不变（UI 点击触发）")
        note5 = page.locator("[data-arch-parse-cancel-note]").first.inner_text()
        ok("显式取消" in note5 and "沿用上次完整落盘状态" in note5,
           "⑤④ 图上如实显示未完成原因（%s…）" % note5.strip()[:50])
        shot("09-big-graph-cancel-note.png")
        t5.join(timeout=30)
        # 图上「重新解析」→ 跑完：原因条消、run done
        page.locator("[data-arch-parse-retry]").click()
        page.wait_for_selector('[data-arch-parse-run="running"]', timeout=15000)
        ok(True, "⑤⑤ 图上重新解析后运行态条再次出现（可跟踪新 run）")
        final5 = wait_run(backend, BIG, ("done",), timeout=70)
        ok(final5 is not None and final5.get("status") == "done", "⑤⑤ 重新解析跑完 done")
        page.wait_for_selector("[data-arch-parse-cancel-note]", state="detached", timeout=30000)
        ok(page.locator("[data-arch-canvas-host] .react-flow__node").count() > 0, "⑤⑤ 重跑完图照常显示")
        shot("10-big-graph-retry-done.png")

        # ── ⑥ 主视图（系统架构）override：技术详情发起解析 → 切系统架构等 done →
        #    规划图节点集合不变＋运行态条消失（U-02；U-01 的换视图窗口也在这一跑里自然经过）──
        info("⑥ 主视图 override：解析完成不顶掉规划图")
        seed_blueprint(backend.home, ROOTS[BIG], BIG, os.path.dirname(ROOTS[BIG]))
        page.locator('[data-project-view-tab="architecture"]').click()
        page.wait_for_selector('[data-arch-tab="architecture"]', timeout=10000)
        # 节点等待用 attached（本场景断言的是"哪份数据层的节点 id 在画布上"，不是像素可见性）。
        # 判据设计（探针实证，scripts 一次性探针结论）：
        #   · override 图层（arch/blueprint 的合成层）恒含 plan:* 节点（cap/mod/aggregate）；
        #   · U-02 事故的覆盖源 getArchRender 是**纯静态层**（只有 d00…/root，没有任何 plan:*）；
        #   · 若父层首次 load 撞上 modules.json 被删的窗口，override 会是"空仓纯规划"风味
        #     （plan:code:*）——两种风味都合法，所以基准不等特定风味，等 id 集合**稳定**即可。
        page.wait_for_selector('[data-project-view="architecture"] .react-flow__node', state="attached", timeout=30000)
        ids_before = []
        settled = False
        deadline = time.time() + 40
        while time.time() < deadline:
            ids_now = sorted(page.eval_on_selector_all(
                '[data-project-view="architecture"] .react-flow__node', "els => els.map(e => e.dataset.id)"))
            if ids_now == ids_before and any(str(i).startswith("plan:") for i in ids_now):
                settled = True
                break
            ids_before = ids_now
            time.sleep(1.5)
        if not settled:
            err_txt = page.locator("[data-project-error]").inner_text() if page.locator("[data-project-error]").count() else ""
            empty_txt = page.locator("[data-project-empty]").inner_text() if page.locator("[data-project-empty]").count() else ""
            info("⑥ 诊断：主视图节点集合 40s 未稳定（ids=%s；project-error=%s；empty=%s）" % (
                ids_before, err_txt[:240], empty_txt[:240]))
            ok(False, "⑥ 主视图 override 图层稳定（id 集合两次采样一致且含 plan:* 节点）")
            browser.close()
            return
        ok(any(str(i).startswith("plan:cap:") for i in ids_before),
           "⑥ 主视图规划图已就位（%d 个节点，含 plan:* 规划节点）" % len(ids_before))
        shot("11-main-view-before-reparse.png")
        # 技术详情回到未解析引导态，从 UI 发起解析（POST 等终态期间切走＝U-01 的自然窗口）
        os.remove(big_modules)
        page.locator('[data-project-view-tab="tech"]').click()
        page.wait_for_selector('[data-arch-tab="tech"]', timeout=10000)
        page.wait_for_selector("[data-arch-parse-start]", timeout=30000)
        page.locator("[data-arch-parse-start]").click()
        page.wait_for_selector('[data-arch-parse-run="running"]', timeout=15000)
        # 立即切到系统架构：主视图经 GET 自动挂上续看；技术详情画布卸载（旧闭包不得再写图）
        page.locator('[data-project-view-tab="architecture"]').click()
        page.wait_for_selector('[data-arch-tab="architecture"]', timeout=10000)
        try:
            page.wait_for_selector('[data-arch-parse-run="running"]', timeout=8000)
            ok(True, "⑥ 切到主视图后自动挂上进行中 run（运行态条在主视图可见，不阻塞）")
        except Exception:
            info("⑥ 切到主视图时 run 已跑完（同样合法）")
        final6 = wait_run(backend, BIG, ("done", "cancelled", "failed"), timeout=70)
        ok(final6 is not None and final6.get("status") == "done",
           "⑥ 后台 run 跑完 done（实际 status=%s）" % (final6 or {}).get("status"))
        page.wait_for_selector('[data-arch-parse-run="running"]', state="detached", timeout=30000)
        ok(True, "⑥ 终态后运行态条已消（parseRun 被终态推进，不冻结在 running）")
        ids_after = sorted(page.eval_on_selector_all(
            '[data-project-view="architecture"] .react-flow__node', "els => els.map(e => e.dataset.id)"))
        # 风味盲比：切走时父层重挂 load 若撞上 modules.json 被删的窗口，override 会换成"空仓纯规划"
        # 风味（plan:code:d00…）——那是静态层暂时缺席的合法口径（§3.2 空仓也有规划图），不是 U-02
        # 事故。U-02 事故的形状是**纯静态层**（plan:* 全丢）。所以两边先把 plan:code: 前缀归一
        # 再比：风味变化不红，plan:* 丢失必红。
        norm = lambda ids: sorted(i[len("plan:code:"):] if str(i).startswith("plan:code:") else i for i in ids)
        nb, na = norm(ids_before), norm(ids_after)
        only_before = [i for i in nb if i not in na]
        only_after = [i for i in na if i not in nb]
        ok(na == nb and any(str(i).startswith("plan:") for i in na),
           "⑥ U-02：主视图仍是 override 规划图——归一后节点集合逐项不变（%d 个），plan:* 规划节点未丢%s" % (
               len(na), "" if na == nb else "（差集：仅前 %s / 仅后 %s）" % (only_before, only_after)))
        ok(page.locator("[data-arch-parse-cancel-note]").count() == 0, "⑥ 无取消原因条（done 正常收尾）")
        shot("12-main-view-override-intact.png")

        browser.close()


# ══════════════════════════════ main ══════════════════════════════

def main():
    os.makedirs(SHOT_DIR, exist_ok=True)
    for f in os.listdir(SHOT_DIR):
        if f.endswith(".png"):
            os.remove(os.path.join(SHOT_DIR, f))
    tmp = tempfile.mkdtemp(prefix="tatai-t19-ui-")
    home = os.path.join(tmp, "home")
    os.makedirs(home, exist_ok=True)
    backend = None
    vite = None
    try:
        root_small = make_project(os.path.join(tmp, "proj-small"), SMALL, SMALL_DIRS, SMALL_FILES_PER_DIR)
        root_big = make_project(os.path.join(tmp, "proj-big"), BIG, BIG_DIRS, BIG_FILES_PER_DIR)
        ROOTS[SMALL] = root_small
        ROOTS[BIG] = root_big
        make_registry(home, [
            {"id": SMALL, "name": SMALL, "path": root_small, "kind": "backend",
             "registered_at": "2026-09-21T00:00:00+08:00", "last_opened_at": "2026-09-21T00:00:00+08:00"},
            {"id": BIG, "name": BIG, "path": root_big, "kind": "backend",
             "registered_at": "2026-09-21T00:00:00+08:00", "last_opened_at": "2026-09-21T00:00:00+08:00"},
        ])
        info("夹具：%s（%d 文件）/ %s（%d 文件）" % (
            SMALL, SMALL_DIRS * SMALL_FILES_PER_DIR, BIG, BIG_DIRS * BIG_FILES_PER_DIR))

        backend_port = free_port()
        backend = Backend(home, backend_port, os.path.join(SHOT_DIR, "server.log"))
        backend.wait_health()
        info("后端就绪：http://127.0.0.1:%d（隔离 TATAI_HOME）" % backend_port)

        named_small = seed_names(backend, root_small, SMALL)
        named_big = seed_names(backend, root_big, BIG)
        info("names.json 已预置（小 %d 模块 / 大 %d 模块），modules.json 已撤回到未解析现场" % (named_small, named_big))

        vite_port = free_port()
        vite = start_vite(vite_port, backend_port, os.path.join(SHOT_DIR, "vite.log"))
        info("vite 就绪：http://localhost:%d（代理 → %d）" % (vite_port, backend_port))

        run_browser(vite_port, backend)
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
            print("[ui] 保留现场：%s" % tmp)
        else:
            try:
                shutil.rmtree(tmp, ignore_errors=True)
            except Exception:
                pass

    print("[ui] 合计 PASS %d / FAIL %d" % (passes[0], len(fails)))
    for f in fails:
        print("[ui]   FAIL " + f)
    print("[ui] 截图目录：%s" % SHOT_DIR)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
