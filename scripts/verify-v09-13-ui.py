#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-13 UI 真机验证：来源/证据标注的**界面读数**与**交付阻断**、**同组关系逐条可点开追来源**。

用法：python scripts/verify-v09-13-ui.py
      （或 pnpm verify:v09-13-ui；V0913_SHOT_DIR 换截图目录、V0913_KEEP_TMP=1 保留现场）

为什么必须跑真浏览器（PLAN.md V09-13 检查项 ②④）：
  · ②「界面与读口明确不给「项目可交付」结论并逐条点名」——这是**上屏**口径：真 DOM 里
    读 `data-project-delivery-*` 才算数，服务端单测只能证明模型里没给结论。
  · ④「同一分组内的设计接口关系能在图上看到并点开追来源」——反例是"只在文字里解释"：
    只有真点一下分组节点上的关系条目、看到出处行出现，才算"图上可点开追来源"。

隔离口径（AGENTS.md §5）：临时 `TATAI_HOME` + 夹具项目（自带 design/plan/modules.json/blueprint.json）；
真实塔台项目一个字节都不碰；后端走动态空闲端口（不动 8787）；vite 固定 5173 被占即拒跑。
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
    "V0913_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "V09-13", "1", "ui-shots")
)
KEEP = os.environ.get("V0913_KEEP_TMP") == "1"
FIX_ID = "v0913ui"
VITE_PORT = 5173
BLOCKED_CONCLUSION = "不可判定项目可交付"
REQUESTABLE_CONCLUSION = "可请求验收"

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

DESIGN = """# V09-13 UI 夹具设计书

## 1. 夹具设计

### 1.1 夹具能力

夹具能力一：与成员模块之间有设计接口关系（同一分组内）。

### 1.2 夹具能力二

夹具能力二：来源引用哈希对不上（用来验证证据失效）。
"""

PLAN = """# V09-13 UI 夹具施工图

| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |
| --- | --- | --- | --- | --- |
| T-1 | todo | 夹具任务一 | 无 | 夹具任务一按要求跑完 |

### T-1 夹具任务一

**交付**：夹具任务一按要求跑完。
"""

MODULES = {
    "version": 1,
    "generated_at": "2026-09-24T00:00:00+08:00",
    "budget_exhausted": False,
    "modules": [{"id": "src", "path": "src", "name": "夹具代码模块", "file_count": 1, "loc": 6, "deps": []}],
}

SECTION_OK = "V09-13 UI 夹具设计书 / 1. 夹具设计 / 1.1 夹具能力"
SECTION_STALE = "V09-13 UI 夹具设计书 / 1. 夹具设计 / 1.2 夹具能力二"

BLUEPRINT = {
    "version": 1,
    "baseline_id": "baseline-ui-fixture",
    "generator_version": "v06-05.1",
    "generated_at": "2026-09-24T00:00:00+08:00",
    "source_manifest": [],
    "nodes": [
        {"id": "plan:cap:01", "kind": "capability", "name": "夹具能力一",
         "source_refs": [{"kind": "design_section", "path": ".工作台/design.md", "locator": SECTION_OK, "sha256": None}],
         "related_ids": ["plan:mod:01"]},
        {"id": "plan:cap:02", "kind": "capability", "name": "夹具能力二（来源已失效）",
         "source_refs": [{"kind": "design_section", "path": ".工作台/design.md", "locator": SECTION_STALE, "sha256": "0" * 64}],
         "related_ids": []},
        {"id": "plan:code:src", "kind": "module", "name": "夹具代码模块",
         "source_refs": [{"kind": "code_module", "path": ".工作台/arch/modules.json", "locator": "src", "sha256": None}],
         "related_ids": ["plan:cap:01"]},
        {"id": "plan:task:T-1", "kind": "task", "name": "夹具任务一",
         "source_refs": [{"kind": "plan_task", "path": ".工作台/plan.md", "locator": "T-1", "sha256": None}],
         "related_ids": ["plan:cap:01"]},
        {"id": "plan:concept:推断", "kind": "concept", "name": "夹具模型推断概念（无出处）",
         "source_refs": [], "related_ids": []},
    ],
    "edges": [
        {"source": "plan:cap:01", "target": "plan:code:src", "kind": "design_interface", "certainty": "declared",
         "source_refs": [{"kind": "design_section", "path": ".工作台/design.md", "locator": SECTION_OK, "sha256": None}]},
        {"source": "plan:task:T-1", "target": "plan:cap:01", "kind": "task_design_ref", "certainty": "declared",
         "source_refs": [{"kind": "design_section", "path": ".工作台/design.md", "locator": SECTION_OK, "sha256": None}]},
        {"source": "plan:cap:01", "target": "plan:concept:推断", "kind": "model_inference", "certainty": "inferred",
         "source_refs": []},
    ],
    "coverage": {
        "design_sections": {"total": 2, "mapped": 2, "unmapped": []},
        "plan_tasks": {"total": 1, "mapped": 1, "unmapped": []},
        "code_modules": {"total": 1, "mapped": 1, "unmapped": []},
        "nodes_total": 5, "nodes_kept": 5, "edges_total": 3, "edges_kept": 3,
        "note": "UI 夹具蓝图（本脚本手写）",
    },
    "omitted": [],
    "model_receipt": None,
    "publish": {"published": True, "reason": None, "validated_at": "2026-09-24T00:00:00+08:00"},
    "based_on": {"model_key": "ui-fixture", "full_key": "ui-fixture",
                 "design_content_sha256": None, "plan_definition_sha256": None, "semantic": False},
}


def make_fixture(root):
    proj = os.path.join(root, "work", FIX_ID)
    write(os.path.join(proj, ".工作台", "design.md"), DESIGN)
    write(os.path.join(proj, ".工作台", "plan.md"), PLAN)
    write(os.path.join(proj, ".工作台", "arch", "modules.json"),
          json.dumps(MODULES, ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(proj, ".工作台", "arch", "blueprint.json"),
          json.dumps(BLUEPRINT, ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(proj, "src", "index.ts"), "export const a = 1;\n")
    return proj


def make_registry(home, fix_proj):
    now = "2026-09-24T00:00:00+08:00"
    write(os.path.join(home, "registry.json"),
          json.dumps({"version": 1, "projects": [
              {"id": FIX_ID, "name": "V09-13 UI 夹具", "path": fix_proj, "kind": "backend",
               "registered_at": now, "last_opened_at": now},
          ]}, ensure_ascii=False, indent=2) + "\n")


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


ROOT = "[data-project-view]"


def attr(page, selector, name):
    loc = page.locator(selector)
    if loc.count() == 0:
        return None
    return loc.first.get_attribute(name)


# ══════════════════════════════ 浏览器断言 ══════════════════════════════

def run_browser(vite_port, backend):
    base = "http://localhost:%d" % vite_port

    # 读口先自证：同一份派生（服务端）也已给出阻断结论（界面读数与读口同源）
    _s, body = backend.api("/api/projects/%s/arch/blueprint" % FIX_ID)
    pv = ((body or {}).get("provenance") or None)
    svc_verdict = ((pv or {}).get("delivery") or {}).get("verdict")
    svc_conclusion = ((pv or {}).get("delivery") or {}).get("conclusion")
    ok(svc_verdict == "blocked" and svc_conclusion == BLOCKED_CONCLUSION,
       "读口（GET arch/blueprint）已带来源与证据标注且结论＝「%s」（verdict=%r）" % (svc_conclusion, svc_verdict))

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1680, "height": 1000}).new_page()
        page.goto("%s/#p/%s" % (base, FIX_ID), wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        page.locator('button[data-view="arch"]').click()
        page.wait_for_selector(ROOT, timeout=30000)
        page.wait_for_timeout(1500)
        os.makedirs(SHOT_DIR, exist_ok=True)
        page.screenshot(path=os.path.join(SHOT_DIR, "01-functional-view.png"), full_page=False)

        # ── ② 交付阻断读数（界面明确不给「项目可交付」并逐条点名） ──
        step["now"] = "② 交付阻断读数"
        verdict = attr(page, ROOT, "data-project-delivery")
        conclusion = attr(page, ROOT, "data-project-delivery-conclusion")
        blocked = attr(page, ROOT, "data-project-delivery-blocked")
        ok(conclusion == BLOCKED_CONCLUSION and blocked == "1",
           "界面结论＝「%s」（data-project-delivery=%r, blocked=%r）" % (conclusion, verdict, blocked))
        reasons_attr = attr(page, "[data-delivery-readout]", "data-delivery-reasons")
        ok(reasons_attr is not None and int(reasons_attr) > 0,
           "交付读数带阻断条数（data-delivery-reasons=%r）" % (reasons_attr,))
        # V09-20（§3.11／§4.2，2026-09-26 用户澄清）：**默认态只一行**——结论 + 阻断条数 + 查看入口，
        # 不含五档图例、能力分类长解释与逐条名单；异常（阻断）在默认态就必须看得见。
        summary_text = page.evaluate(
            "() => { const s = document.querySelector('[data-delivery-readout] summary');"
            " return s ? s.innerText.replace(/\\s+/g,' ').trim() : null; }"
        )
        ok(
            summary_text is not None
            and BLOCKED_CONCLUSION in summary_text
            and ("阻断" in summary_text or "待你确认" in summary_text)
            and "能力分类" not in summary_text
            and "不代签" not in summary_text
            and len(summary_text) <= 140,
            "默认态只一行且异常可见（%r）" % (summary_text,),
        )
        ok(
            page.locator("[data-delivery-readout] summary [data-delivery-state-chip]").count() == 0
            and page.locator("[data-delivery-readout] summary [data-delivery-reason]").count() == 0,
            "默认摘要里没有五档图例 chip、也没有逐条名单（收起的是篇幅，不是数据）",
        )
        # 默认折叠（真实项目 351 条平铺会把画布挤到亚像素 ⇒ 节点小到点不动）：点开摘要后逐条可读
        page.locator("[data-delivery-expand]").first.click()
        page.wait_for_timeout(400)
        reasons_n = page.locator("[data-delivery-reason]").count()
        ok(reasons_n == int(reasons_attr),
           "点开「逐条点名」后**逐条**列出全部 %d 条（DOM 里 %d 条，不抽样、不省略）" % (int(reasons_attr), reasons_n))
        first_reason = page.locator("[data-delivery-reason]").first.inner_text()
        ok(("（plan:" in first_reason) or ("（" in first_reason and "）" in first_reason),
           "逐条点名带对象 ID（例：%s…）" % first_reason[:70].replace("\n", " "))
        # V09-20：逐条理由文本必须**在浮层开着时**抓取——收起后 <details> 内容不可见，
        # `all_inner_texts()` 会返回空串（① 段原来在收起之后才读，会假红）。这里一次抓完复用。
        reason_texts_expanded = page.locator("[data-delivery-reason]").all_inner_texts()
        page.screenshot(path=os.path.join(SHOT_DIR, "01b-delivery-reasons-expanded.png"))
        ok(page.locator("[data-delivery-conclusion-badge]").inner_text().strip() == BLOCKED_CONCLUSION,
           "结论徽标文字就是「%s」（不是含糊的「有未完成项」）" % BLOCKED_CONCLUSION)
        # 反例防线：界面不能同时给出"可交付/可请求验收"
        ok(REQUESTABLE_CONCLUSION not in page.locator(ROOT).inner_text(),
           "界面上**没有**「%s」字样（存在阻断时不给可交付结论）" % REQUESTABLE_CONCLUSION)
        # V09-20：详情是**浮层**（不占纵向排版）——收起后再验"画布仍可操作"：
        # 收起后画布高度不变、节点仍在；不收起的话浮层会挡住后续画布点击。
        page.locator("[data-delivery-detail-close]").first.click()
        page.wait_for_timeout(300)
        ok(page.evaluate("() => { const d = document.querySelector('[data-delivery-readout] details'); return d ? d.open : null; }") is False,
           "点「关闭」收起交付详情浮层（§3.11：可关闭、独立滚动）")

        # ── ① 来源与证据标注上屏（逐对象） ──
        step["now"] = "① 来源与证据标注"
        node_ids = page.evaluate(
            "Array.from(document.querySelectorAll('[data-project-node]')).map(e => e.getAttribute('data-project-node'))"
        )
        info("画布节点：%r" % (node_ids,))
        kinds = page.evaluate(
            "Array.from(document.querySelectorAll('[data-project-node]')).map(e => "
            "[e.getAttribute('data-project-node'), e.getAttribute('data-project-source-kind'),"
            " e.getAttribute('data-project-evidence-state')])"
        )
        ok(len(kinds) > 0 and all(k[1] not in (None, "") and k[2] not in (None, "") for k in kinds),
           "每个画布节点都带来源种类与证据状态属性：%r" % (kinds,))
        # 未映射对象不一定进得了本视图的节点集（功能全景按能力分组）——但它**必须**出现在
        # 交付读数的逐条点名里（省略标注 ⇒ 不合格）。画面上先读到理由行，再核对对象 id。
        reason_texts = reason_texts_expanded
        panel_reasons = attr(page, "[data-delivery-readout]", "data-delivery-reasons")
        ok(any("未映射" in t for t in reason_texts) and any("plan:concept:推断" in t for t in reason_texts),
           "未映射对象在界面上被逐条点名（未映射理由行含 plan:concept:推断；读数共 %r 条）" % (panel_reasons,))
        # 点开一个能力节点 → 详情里的「来源与证据」段
        cap_node = page.locator("[data-project-node='plan:cap:01']")
        if cap_node.count() > 0:
            cap_node.first.click()
            page.wait_for_timeout(500)
            detail = page.locator("[data-detail-section='provenance']")
            ok(detail.count() == 1, "点节点后详情里出现「来源与证据」段")
            if detail.count() == 1:
                text = detail.first.inner_text()
                ok("来源种类" in text and "映射" in text and "证据状态" in text,
                   "详情段逐条列出「来源种类 / 映射 / 证据状态」（节选：%s…）" % text[:80].replace("\n", " "))
        else:
            ok(False, "画布上找不到能力节点 plan:cap:01（测不出详情段）")
        page.screenshot(path=os.path.join(SHOT_DIR, "02-source-evidence-badge.png"))

        # ── ④-a 主视图画布上：分组节点**直接**带同组关系条目，点一下就能追来源 ──
        step["now"] = "④-a 分组节点上的同组关系条目"
        chips = page.locator("[data-intra-chip]")
        chip_nodes = page.evaluate(
            "Array.from(document.querySelectorAll('[data-intra-chips]')).map(e => "
            "[e.getAttribute('data-intra-chips'), e.getAttribute('data-intra-chips-count')])"
        )
        info("带关系条目的节点：%r" % (chip_nodes,))
        ok(chips.count() >= 1,
           "功能全景的分组节点上**直接**有可点的同组关系条目（%d 个 data-intra-chip）" % chips.count())
        if chips.count() >= 1:
            chip_id = chips.first.get_attribute("data-intra-chip")
            chips.first.click()
            page.wait_for_timeout(400)
            rel = page.locator("[data-project-relation]")
            ok(rel.count() == 1, "点分组节点上的关系条目 ⇒ 详情里出现该关系的出处段")
            if rel.count() == 1:
                rel_lines = rel.first.locator("[data-project-relation-line]").all_inner_texts()
                ok(any("设计来源" in ln for ln in rel_lines),
                   "出处段真的追到来源（%s ⇒ 例：%s…）" % (chip_id, (rel_lines[1] if len(rel_lines) > 1 else rel_lines[0])[:80]))
            page.screenshot(path=os.path.join(SHOT_DIR, "03-intra-relation-opened.png"))
        else:
            ok(False, "分组节点上没有关系条目（测不出「图上可点开追来源」）")

        # ── ④ 同组关系：图上逐条可见、可点开追来源 ──
        step["now"] = "④ 同组关系可点开追来源"
        page.locator('button[data-project-view-tab="architecture"]').click()
        page.wait_for_timeout(1200)
        panel = page.locator("[data-intra-relations]")
        ok(panel.count() == 1, "架构视图上有「同组关系」面板（data-intra-relations）")
        # 2026-09-27：面板默认收起成一行，逐条抽查前先点开折叠
        if page.locator("[data-intra-relations] summary[data-intra-relations-summary]").count():
            page.locator("[data-intra-relations] summary[data-intra-relations-summary]").first.click()
            page.wait_for_timeout(300)
        count_attr = attr(page, "[data-intra-relations]", "data-intra-relations-count")
        ok(count_attr is not None and int(count_attr) >= 1,
           "面板逐条列出同组关系（%r 条）" % (count_attr,))
        items = page.locator("[data-intra-relation]")
        ok(items.count() >= 1, "每条同组关系一个可点锚点（%d 个 <details data-intra-relation>）" % items.count())
        if items.count() >= 1:
            edge_id = items.first.get_attribute("data-intra-relation")
            visible = items.first.get_attribute("data-intra-relation-visible")
            ok(visible == "1", "这条关系被标为「图上可见」（visible=%r）——只在文字里解释 ⇒ 不合格" % visible)
            src_lines = items.first.locator("[data-intra-relation-source]")
            ok(src_lines.count() >= 1,
               "点开前就能读到出处行（%d 行；例：%s…）" % (src_lines.count(), src_lines.first.inner_text()[:70]))
            info("同组关系 %s：%r" % (edge_id, src_lines.first.inner_text()[:100]))
        # 面板上的每一条：点开 summary 才能读到出处行（真点一下，不是"看文字"）
        if items.count() >= 1:
            items.first.locator("summary").click()
            page.wait_for_timeout(300)
            lines = items.first.locator("[data-intra-relation-source]").all_inner_texts()
            ok(len(lines) >= 1 and any("设计来源" in ln for ln in lines),
               "点开这条关系 ⇒ 读到出处行（例：%s…）" % (lines[0][:80] if lines else "无"))
        page.screenshot(path=os.path.join(SHOT_DIR, "03-intra-relations-panel.png"))

        # ── ③ 人工待验：界面上要有可读的待验读数（本夹具没有待验项，读口必须如实为 0） ──
        step["now"] = "③ 人工待验"
        pending_attr = attr(page, "[data-delivery-readout]", "data-delivery-user-pending")
        ok(pending_attr is not None,
           "交付读数里带人工待验条数（本夹具 %r 条——没有就不写「待验」，也不代签）" % (pending_attr,))
        ok(page.locator("[data-project-user-pending]").count() == 0 or pending_attr == "0",
           "本夹具没有人工待验项 ⇒ 界面上不出现用户待验标记（agent 不代签、也不虚报）")

        browser.close()


def main():
    global VITE_PORT
    tmp = tempfile.mkdtemp(prefix="tatai-v0913ui-")
    home = os.path.join(tmp, "home")
    os.makedirs(home, exist_ok=True)
    fix_proj = make_fixture(tmp)
    make_registry(home, fix_proj)
    log_dir = os.path.join(REPO, ".工作台", "evidence", "V09-13", "1")
    os.makedirs(log_dir, exist_ok=True)
    backend_port = free_port()
    backend = None
    vite = None
    try:
        if port_busy(VITE_PORT):
            print("[ui] FAIL vite %d 已被占用：本脚本不抢端口（先停掉占用者再跑）" % VITE_PORT)
            sys.exit(1)
        step["now"] = "起后端"
        backend = Backend(home, backend_port, os.path.join(log_dir, "ui-backend.log"))
        backend.wait_health()
        info("后端就绪：127.0.0.1:%d（TATAI_HOME=%s）" % (backend_port, home))
        step["now"] = "起 vite"
        vite = start_vite(VITE_PORT, backend_port, os.path.join(log_dir, "ui-vite.log"))
        info("vite 就绪：http://localhost:%d" % VITE_PORT)
        run_browser(VITE_PORT, backend)
    except Exception as e:  # noqa: BLE001
        ok(False, "运行期出错（%s 阶段）：%s" % (step["now"], e))
    finally:
        for proc in (vite, backend):
            if proc is None:
                continue
            try:
                if proc is backend:
                    backend.kill()
                else:
                    proc.kill()
                    proc.wait(timeout=10)
            except Exception:
                pass
        if not KEEP:
            shutil.rmtree(tmp, ignore_errors=True)
        else:
            info("保留现场：%s" % tmp)

    print("[ui] 计数：%d PASS / %d FAIL" % (passes[0], len(fails)))
    if fails:
        print("[ui] 存在 FAIL")
        sys.exit(1)
    print("[ui] 全部 PASS")


if __name__ == "__main__":
    main()
