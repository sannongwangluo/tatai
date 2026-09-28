#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-08 UI 真机验证：技术详情三图与 Gate 面板的**对账差异分类分计**（真浏览器 + 真后端 + 真 DOM）。

用法：python scripts/verify-v09-08-ui.py
      （或 pnpm verify:v09-08-ui；V0908_SHOT_DIR 换截图目录、V0908_KEEP_TMP=1 保留现场）

为什么必须跑真浏览器（PLAN.md V09-08 检查项 ③「UI 误导修正（用户可见）」）：
  · 判据的对象是**用户看见的那几行字与那几个徽标**——对账面板把 `only_in_code` 的条目
    分成了哪几类、各几条、节点徽标是不是只有"真差异"才黄。这些只有真 DOM 读得出来，
    渲染函数级断言看不见"面板没渲染 / 分类没上屏 / 两个面板各说一套"。
  · 同一条判据要在**三张技术图**（模块方框图 / 数据流向图 / 思维导图）与 **Gate 过关现场**
    都成立，且读数互相一致；期望值一律从**真后端**的对账结果算，不写死。

隔离口径（AGENTS.md §5 / 本卡红线）：
  · 临时 `TATAI_HOME`（tempfile）；注册表里放**两个**项目：
      ① 真实塔台自身（路径 = 本仓库，`self_managed`）——**只读**它的设计/施工/蓝图/对账，
         唯一写入是重跑对账产物 `.工作台/arch/reconcile-last.json`（与界面「重跑对账」同一条
         代码路径，派生缓存、不是事实源）；
      ② 分类夹具项目（tempfile 内，自带 design/plan/modules.json/.gitignore）——Gate 面板要**真点过关**，
         这一下会写 gate.jsonl；**绝不在真实塔台上点**（真实 Gate 只由用户本人动）。
  · 收尾杀净后端与 vite、删临时目录（V0908_KEEP_TMP=1 可留现场）。
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
    "V0908_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "V09-08", "1", "ui-shots")
)
KEEP = os.environ.get("V0908_KEEP_TMP") == "1"
REAL_ID = "tatai"          # 真实塔台自身（只读）
FIX_ID = "v0908ui-main"    # 分类夹具（Gate 面板在这里真点过关）

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


def http(url, method="GET", body=None, timeout=120):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, method=method, data=data)
    if data is not None:
        req.add_header("content-type", "application/json")
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

DESIGN = """# 分类夹具设计书

## 2 模块划分

| # | 模块 | 说明 |
| --- | --- | --- |
| 1 | 甲模块 | 只点名义落点 |
| 2 | 乙模块 | 点名实现落点 |

## 5 其它说明

别处提到 `outside-dir/` 这个目录（它声明在模块清单之外的一节里）。
"""

PLAN = """# 分类夹具施工图

## 甲卡｜甲模块（设计书 §2 第 1 项）

产出：`alpha-dir/thing.ts` 的素材目录（只点了落点，没别的说明）

## 乙卡｜乙模块（设计书 §2 第 2 项）

产出：实现落点 `beta-dir/main.ts`（实现落点，实测在场）
"""

MODULES = [
    {"id": "alpha-dir", "path": "alpha-dir"},
    {"id": "beta-dir", "path": "beta-dir"},
    {"id": "doc-dir", "path": "doc-dir"},
    {"id": "junk-out", "path": "junk-out"},
    {"id": "outside-dir", "path": "outside-dir"},
    {"id": "actionable-dir", "path": "actionable-dir"},
]


def make_fixture(root):
    """分类夹具：四类差异各一条 + 声明侧一个"落点未证实"的反例（全部实测在场）。"""
    proj = os.path.join(root, "work", FIX_ID)
    write(os.path.join(proj, ".工作台", "design.md"), DESIGN)
    write(os.path.join(proj, ".工作台", "plan.md"), PLAN)
    write(os.path.join(proj, ".工作台", "arch", "modules.json"),
          json.dumps({"version": 1, "generated_at": "2026-09-24T00:00:00+08:00", "budget_exhausted": False,
                      "modules": [dict(m, name="", file_count=1, loc=10, deps=[]) for m in MODULES]},
                     ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(proj, ".gitignore"), "junk-out/\n")
    # 有源码文件的目录（真代码模块）；doc-dir 只有文档（结构性）
    for rel in ["alpha-dir/thing.ts", "beta-dir/main.ts", "outside-dir/a.ts", "actionable-dir/a.ts",
                "junk-out/build.ts"]:
        write(os.path.join(proj, rel.replace("/", os.sep)), "export const x = 1;\n")
    write(os.path.join(proj, "doc-dir", "note.md"), "# 文档\n")
    # Gate 面板要真点一次过关：当前步 = 设计，history 里必须**有这一步**（recordGateTransition 的判据），
    # 前三步标已过（真写 gate.jsonl，写在夹具自己的 .工作台 里）
    write(os.path.join(proj, ".工作台", "progress.json"),
          json.dumps(
              {
                  "version": 1,
                  "gate": {
                      "current_step": "design",
                      "history": [
                          {"step": "kickoff", "result": "pass", "at": "2026-09-24T00:00:00+08:00", "note": None},
                          {"step": "requirement", "result": "pass", "at": "2026-09-24T00:00:00+08:00", "note": None},
                          {"step": "design", "result": "pending", "at": None, "note": None},
                      ],
                  },
                  "modules": [{"id": "alpha-dir", "name": "甲", "status": "todo"}],
              },
              ensure_ascii=False,
              indent=2,
          ) + "\n")
    write(os.path.join(proj, ".工作台", "gate.jsonl"), "")
    return proj


def make_registry(home, fix_proj):
    now = "2026-09-24T00:00:00+08:00"
    records = [
        # 真实塔台自身：路径 = 本仓库；self_managed ⇒ 设计书读 <repo>/DESIGN.md（只读它）
        {"id": REAL_ID, "name": "塔台", "path": REPO, "kind": "fullstack", "self_managed": True,
         "registered_at": now, "last_opened_at": now},
        {"id": FIX_ID, "name": "分类夹具 v0908ui", "path": fix_proj, "kind": "backend",
         "registered_at": now, "last_opened_at": now},
    ]
    write(os.path.join(home, "registry.json"),
          json.dumps({"version": 1, "projects": records}, ensure_ascii=False, indent=2) + "\n")


# ══════════════════════════════ 后端 / vite ══════════════════════════════

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

    def api(self, path, method="GET", body=None):
        return http("http://127.0.0.1:%d%s" % (self.port, path), method, body)

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

CATS = ["actionable_mismatch", "outside_scope", "structural", "unclassified"]

# 视口相交读数（V09-08 收口：DOM 计数不证明肉眼可见——节点矩形必须与 .react-flow 容器矩形相交）
VIEWPORT_DUMP_JS = r"""
() => {
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return {x: r.x, y: r.y, w: r.width, h: r.height}; };
  const view = document.querySelector('[data-arch-view]');
  const rf = view ? view.querySelector('.react-flow') : null;
  const container = rect(rf);
  const inView = (r) => r && container && r.w > 0 && r.h > 0 &&
      (r.x + r.w > container.x) && (r.x < container.x + container.w) &&
      (r.y + r.h > container.y) && (r.y < container.y + container.h);
  const nodes = [...(view ? view.querySelectorAll('.react-flow__node') : [])].map(rect);
  const yellow = [...(view ? view.querySelectorAll('[data-arch-diff-category="actionable_mismatch"]') : [])].map(rect);
  return { nodeCount: nodes.length, nodesInView: nodes.filter(inView).length,
           yellowCount: yellow.length, yellowInView: yellow.map(inView) };
}
"""


def expected_counts(reconcile_result):
    """期望分类计数：**从真后端返回体逐条算**（不写死数字）"""
    counts = {c: 0 for c in CATS}
    for item in reconcile_result.get("only_in_code", []):
        cat = item.get("category")
        counts[cat if cat in counts else "unclassified"] += 1
    return counts


def panel_counts(page, anchor):
    """读某个面板锚点下的分类计数（DOM 实况）"""
    out = {c: 0 for c in CATS}
    box = page.locator(anchor)
    if box.count() == 0:
        return None
    for c in CATS:
        el = box.locator('[data-diff-category="%s"]' % c)
        if el.count() == 0:
            continue
        text = el.first.inner_text()
        digits = "".join(ch for ch in text if ch.isdigit())
        out[c] = int(digits) if digits else 0
    return out


def assert_counts(label, counts, expect):
    ok(counts is not None, "%s：分类分计那一行在（面板锚点存在）" % label)
    if counts is None:
        return
    same = all(counts[c] == expect[c] for c in CATS)
    shown = " · ".join("%s=%d" % (c, counts[c]) for c in CATS if counts[c] or expect[c])
    ok(same, "%s：分类计数与后端对账结果逐类相等（%s）" % (label, shown))


def reconcile_result(backend, pid, ensure=False):
    """读某项目的最近一次对账结果（`{ok, reconcile:{exists,result}}`）。

    `ensure=True` 时先 POST 跑一次（界面「重跑对账」按钮的同一路径）——只对**夹具**用它；
    真实塔台只读既有结果（它由 `pnpm verify:v09-08` 的同一条代码路径生成过）。
    """
    if ensure:
        status, _ = backend.api("/api/projects/%s/arch/reconcile" % pid, "POST", {})
        if status != 200:
            raise RuntimeError("POST arch/reconcile 失败 HTTP %s" % status)
    status, body = backend.api("/api/projects/%s/arch/reconcile" % pid)
    rec = (body or {}).get("reconcile", {})
    if status != 200 or not rec.get("exists"):
        raise RuntimeError("项目 %s 还没有对账结果（exists=%s）" % (pid, rec.get("exists")))
    return rec["result"]


def open_tech(page, base, pid, mode="MODULE_BOX"):
    """进「项目图 → 技术详情」并切到指定那张技术图。

    为什么要显式点一次图模式：技术详情里的画布与思维导图是**同一个容器按模式显隐**的
    （非当前模式的容器带 `hidden`），切过项目之后模式会留在上一次的值上——不显式点一下，
    读到的 `[data-reconcile-panel]` 可能是隐藏容器里的那一份（visible 判据会挂）。
    """
    page.goto("%s/#p/%s" % (base, pid), wait_until="domcontentloaded")
    page.wait_for_timeout(2500)
    page.locator('button[data-view="arch"]').click()
    page.wait_for_timeout(600)
    page.locator('[data-project-view-tab="tech"]').click()
    page.wait_for_selector('[data-graph-mode="%s"]' % mode, timeout=30000)
    page.locator('[data-graph-mode="%s"]' % mode).click()
    page.wait_for_timeout(1200)


def run_browser(vite_port, backend, home):
    base = "http://localhost:%d" % vite_port
    real_recon = reconcile_result(backend, REAL_ID)
    fix_recon = reconcile_result(backend, FIX_ID, ensure=True)
    real_expect = expected_counts(real_recon)
    fix_expect = expected_counts(fix_recon)
    info("后端对账读数（真实塔台 %s）：%s" % (REAL_ID, json.dumps(real_expect, ensure_ascii=False)))
    info("后端对账读数（分类夹具 %s）：%s" % (FIX_ID, json.dumps(fix_expect, ensure_ascii=False)))
    ok(
        real_expect["actionable_mismatch"] == 0 and fix_expect["actionable_mismatch"] == 1,
        "两个项目的 actionable mismatch 读数符合预期（真实塔台 0 条＝无真误配；夹具 1 条＝真差异仍标黄）",
    )
    ok(
        real_expect["outside_scope"] >= 1 and real_expect["structural"] >= 1,
        "真实塔台的差异里既有「范围外」也有「结构性目录」（口径边界分类分计，不是一律叫对账差）",
    )
    os.makedirs(SHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1680, "height": 1000}).new_page()

        # ── 真项目（塔台自身）：三张技术图逐个读数 + 截图 ──
        open_tech(page, base, REAL_ID)

        panel_text = page.locator("[data-reconcile-panel]").inner_text()
        ok("对账" in panel_text and "信号" in panel_text and "不是错误" in panel_text,
           "三图面板保留「差异是信号，不是错误」的口径句")
        ok("范围外" in panel_text and "结构性目录" in panel_text,
           "面板**分别命名**了「范围外」「结构性目录」（不再把这 4 条都叫「对账差」）")
        ok(("真差异" in panel_text) or ("对账差" in panel_text),
           "面板点名了「真差异」这一档（分类词表逐档可读）")

        box_counts = panel_counts(page, "[data-reconcile-only-in-code-cats]")
        assert_counts("模块方框图", box_counts, real_expect)
        ok(page.locator('[data-diff-list="only_in_code"]').count() == 1,
           "原始事实照旧：`only_in_code` 的逐条名单仍在面板上（分类是解释、不改名单）")
        # 节点徽标：只有真差异用黄；口径边界用中性底色
        n_nodes = page.locator("[data-arch-diff]").count()
        n_yellow = page.locator('[data-arch-diff-category="actionable_mismatch"]').count()
        ok(n_nodes == sum(real_expect.values()),
           "画布上每条 only_in_code 模块仍带 [data-arch-diff] 标记（原始事实保留：%d 条）" % n_nodes)
        ok(n_yellow == real_expect["actionable_mismatch"],
           "黄色「对账差」徽标只落在真差异上（%d 个，期望 %d 个＝后端 actionable 读数）"
           % (n_yellow, real_expect["actionable_mismatch"]))
        ok(page.locator('[data-arch-diff-badge="structural"]').count() == real_expect["structural"],
           "结构性目录的节点徽标自带分类词（%d 个）" % real_expect["structural"])
        # 视口相交（收口硬要求）：节点必须真的落在 .react-flow 容器矩形内，不只是 DOM 在场
        vd = page.evaluate(VIEWPORT_DUMP_JS)
        ok(vd["nodeCount"] > 0, "真实塔台模块方框图画布 DOM 有节点（%d 个）" % vd["nodeCount"])
        ok(vd["nodeCount"] > 0 and vd["nodesInView"] == vd["nodeCount"],
           "真实塔台模块方框图节点全部落在视口内（%d/%d，fit 后无漏出视口）"
           % (vd["nodesInView"], vd["nodeCount"]))
        page.screenshot(path=os.path.join(SHOT_DIR, "01-tatai-tech-module-box.png"), full_page=False)

        page.locator('[data-graph-mode="DATA_FLOW"]').click()
        page.wait_for_selector('[data-arch-mode="DATA_FLOW"]', timeout=20000)
        page.wait_for_timeout(1500)
        flow_counts = panel_counts(page, "[data-reconcile-only-in-code-cats]")
        assert_counts("数据流向图", flow_counts, real_expect)
        ok(flow_counts == box_counts, "两张技术图读数逐项相同（同一份判据、同一份渲染）")
        page.screenshot(path=os.path.join(SHOT_DIR, "02-tatai-tech-data-flow.png"))

        page.locator('[data-graph-mode="MIND_MAP"]').click()
        page.wait_for_selector("[data-mindmap-view]", timeout=30000)
        page.wait_for_timeout(2000)
        mm_counts = panel_counts(page, "[data-mindmap-reconcile-cats]")
        assert_counts("思维导图", mm_counts, real_expect)
        ok(mm_counts == box_counts, "思维导图这一支的分类读数与另两张技术图一致（三图口径一致）")
        page.screenshot(path=os.path.join(SHOT_DIR, "03-tatai-tech-mind-map.png"))

        # ── 夹具项目：四类差异齐全 + Gate 过关现场真点一次 ──
        open_tech(page, base, FIX_ID)
        fix_box = panel_counts(page, "[data-reconcile-only-in-code-cats]")
        assert_counts("夹具项目·模块方框图", fix_box, fix_expect)
        ok(page.locator('[data-arch-diff-category="actionable_mismatch"]').count() == 1,
           "夹具里那条真差异在画布上是黄的（机制没被分类改坏）")
        # 视口相交（收口硬要求）：切项目后画布不得空白；黄色「真差异」节点必须在视口内肉眼可见
        vd_fix = page.evaluate(VIEWPORT_DUMP_JS)
        ok(vd_fix["nodeCount"] > 0, "夹具模块方框图画布 DOM 有节点（%d 个）" % vd_fix["nodeCount"])
        ok(vd_fix["nodeCount"] > 0 and vd_fix["nodesInView"] == vd_fix["nodeCount"],
           "夹具节点全部落在视口内（%d/%d；切项目再切图模式后画布不得空白）"
           % (vd_fix["nodesInView"], vd_fix["nodeCount"]))
        ok(vd_fix["yellowCount"] == 1 and vd_fix["yellowInView"] == [True],
           "黄色「真差异」节点在视口内肉眼可见（不只 DOM 在场）：yellowInView=%s" % vd_fix["yellowInView"])
        page.screenshot(path=os.path.join(SHOT_DIR, "04-fixture-tech-module-box.png"))

        # Gate 面板：切到「实况与验收」→ 验收子页 → 展开阶段摘要 → 真点过关 → 读过关现场的对账分类
        page.locator('button[data-view="live"]').click()
        page.wait_for_selector('[data-live-sub="acceptance"]', timeout=30000)
        page.locator('[data-live-sub="acceptance"]').click()
        page.wait_for_selector("[data-acceptance-view]", timeout=30000)
        page.wait_for_timeout(1200)
        toggle = page.locator("[data-acceptance-stage-toggle]")
        if toggle.count() > 0 and page.locator("[data-gate-timeline]").count() == 0:
            toggle.first.click()
            page.wait_for_timeout(1200)
        page.wait_for_selector("[data-gate-actions]", timeout=30000)
        page.locator('[data-gate-action="pass"]').first.click()
        page.wait_for_selector("[data-gate-confirm]", timeout=15000)
        page.locator("[data-gate-confirm]").first.click()
        page.wait_for_selector("[data-gate-reconcile]", timeout=30000)
        page.wait_for_timeout(1500)
        gate_text = page.locator("[data-gate-reconcile]").inner_text()
        ok("已自动对账" in gate_text and "范围外" in gate_text and "结构性目录" in gate_text,
           "Gate 过关现场的对账汇总也**分别命名**了分类（不再只报一个「对账差」数）")
        ok("只有" in gate_text and "才是对账差" in gate_text,
           "Gate 现场写明「只有真差异才是对账差」的口径句")
        gate_counts = panel_counts(page, "[data-gate-reconcile-cats]")
        assert_counts("Gate 过关现场", gate_counts, fix_expect)
        ok(gate_counts == fix_box, "Gate 面板与三图面板口径一致（同一份分类、同一份渲染组件）")
        via_text = page.locator("[data-gate-reconcile-via]").inner_text()
        ok("实现落点" in via_text and "落点未证实" in via_text,
           "Gate 现场摆出配对依据（实现落点 / 落点未证实 / 名字信号）：%s" % via_text.strip()[:80])
        page.screenshot(path=os.path.join(SHOT_DIR, "05-fixture-gate-panel.png"))
        browser.close()

    # ── 只读自证：夹具的那次过关只写了夹具自己的 .工作台；真实塔台的 Gate/任务账本没动 ──
    real_gate = os.path.join(REPO, ".工作台", "gate.jsonl")
    info("真实塔台 Gate 流水存在（本次未点）：%s" % os.path.exists(real_gate))
    info("夹具 Gate 流水已写（本次真点了一次过关）：%s"
         % os.path.exists(os.path.join(FIX_ID_PROJ[0], ".工作台", "gate.jsonl")))
    return real_expect, fix_expect


FIX_ID_PROJ = [None]


def main():
    root = tempfile.mkdtemp(prefix="tatai-v0908ui-")
    home = os.path.join(root, "home")
    os.makedirs(home, exist_ok=True)
    backend = None
    vite = None
    try:
        step["now"] = "夹具"
        fix_proj = make_fixture(root)
        FIX_ID_PROJ[0] = fix_proj
        make_registry(home, fix_proj)
        info("隔离 TATAI_HOME：%s" % home)
        info("分类夹具：%s" % fix_proj)

        step["now"] = "起后端"
        port = free_port()
        backend = Backend(home, port, os.path.join(root, "ui-backend.log"))
        backend.wait_health()
        info("后端就绪 http://127.0.0.1:%d" % port)
        ok(backend.api("/api/projects/%s/arch/reconcile" % FIX_ID)[0] == 200, "夹具对账读口可用（HTTP 200）")
        ok(backend.api("/api/projects/%s/arch/reconcile" % REAL_ID)[0] == 200,
           "真实塔台对账读口可用（只读）")

        step["now"] = "起 vite"
        vite_port = 5173
        if port_busy(vite_port):
            raise RuntimeError("5173 已被占用（不碰别人的 dev server）——本段无法在本机真跑")
        vite = start_vite(vite_port, port, os.path.join(root, "ui-vite.log"))
        info("vite 就绪 http://localhost:%d" % vite_port)

        step["now"] = "浏览器"
        run_browser(vite_port, backend, home)
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
            info("保留现场：%s（V0908_KEEP_TMP=1）" % root)
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
