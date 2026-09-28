#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-11 UI 真机验证：数据流向图页面上的「当前实现 vs 目标语义」口径与来源分层（真浏览器 + 真后端 + 真 DOM）。

用法：python scripts/verify-v09-11-ui.py（或 pnpm verify:v09-11-ui；V0911_SHOT_DIR 换截图目录）

为什么必须跑真浏览器（PLAN V09-11 检查项 ①③「图页面」「逐跳可点开追到出处与验证态」）：
  · 判据的对象是**用户在这一页上看得见的那几行字与那几个可点开的锚点**——「当前实现＝静态 import
    依赖层方向渲染（不是业务数据流）」与「目标语义＝输入源→处理节点→存储→输出/外部系统」是不是
    同时在场、是不是互相区分；数据链的每一跳点开后是不是真能读到出处档位与复跑命令。渲染函数级
    断言看不见"面板没渲染 / 折叠了打不开 / 两句话被写成一模一样"。
  · 期望值一律**从真后端**的 `GET /api/projects/:id/arch/dataflow` 现取现算，不写死数字。

隔离口径（AGENTS.md §5 / 本卡红线）：
  · 临时 `TATAI_HOME`（tempfile）里**只注册真实塔台自身**（路径 = 本仓库，`self_managed`）；
  · **全程零写入**：不点 Gate、不触发解析、不建备份，只读设计/施工/蓝图/数据流派生；
  · 收尾杀净后端与 vite、删临时目录；截图落 `.工作台/evidence/V09-11/1/ui-shots/`。
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
    "V0911_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "V09-11", "1", "ui-shots")
)
REAL_ID = "tatai"

passes = [0]
fails = []


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


def http(url, method="GET", body=None, timeout=120):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, method=method, data=data)
    if data is not None:
        req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        text = resp.read().decode("utf-8")
        return resp.status, (json.loads(text) if text.strip().startswith(("{", "[")) else text)


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


def open_data_flow(page, base, pid):
    page.goto("%s/#p/%s" % (base, pid), wait_until="domcontentloaded")
    page.wait_for_timeout(2500)
    page.locator('button[data-view="arch"]').click()
    page.wait_for_timeout(600)
    page.locator('[data-project-view-tab="tech"]').click()
    page.wait_for_selector('[data-graph-mode="DATA_FLOW"]', timeout=30000)
    page.locator('[data-graph-mode="DATA_FLOW"]').click()
    page.wait_for_selector("[data-flow-legend]", timeout=20000)
    # 目标语义那一层是异步取的：等它落到「有数据」的状态（不是加载中）
    page.wait_for_selector("[data-flow-summary]", timeout=30000)
    page.wait_for_timeout(500)


def text_of(page, sel):
    el = page.locator(sel)
    return el.first.inner_text() if el.count() > 0 else ""


def run_browser(vite_port, backend):
    base = "http://localhost:%d" % vite_port
    status, payload = backend.api("/api/projects/%s/arch/dataflow" % REAL_ID)
    if status != 200:
        raise RuntimeError("GET arch/dataflow HTTP %s" % status)
    model = payload["data_flow"]
    info("后端模型：实体 %d · 关系 %d · 链 %d · 覆盖行 %d · 缺路径 %d"
         % (len(model["nodes"]), len(model["edges"]), len(model["chains"]),
            model["coverage"]["declared_total"], model["coverage"]["missing"]))
    os.makedirs(SHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1680, "height": 1050}).new_page()
        open_data_flow(page, base, REAL_ID)

        # ── ① 两句话同时可见且互相区分 ──
        cur_sel = "[data-flow-current-implementation]"
        tgt_sel = "[data-flow-target-semantics]"
        ok(page.locator(cur_sel).count() == 1 and page.locator(tgt_sel).count() == 1,
           "「当前实现」与「目标语义」两个锚点各一个（同时在场）")
        cur_text, tgt_text = text_of(page, cur_sel), text_of(page, tgt_sel)
        ok(cur_text != "" and tgt_text != "" and cur_text != tgt_text,
           "两句话**互相区分**（不同的两段文字，不是同一句换说法）")
        ok("当前实现" in cur_text and "静态 import" in cur_text and "业务数据流" in cur_text,
           "「当前实现」那句点名静态依赖层与业务数据流：%s" % cur_text[:60])
        ok(all(k in tgt_text for k in ["输入源", "处理节点", "存储", "输出/外部系统"]),
           "「目标语义」那句点名四类实体：%s" % tgt_text[:60])
        ok(all(k in tgt_text for k in ["产生", "传递", "读写", "转换", "稳定 ID"]),
           "「目标语义」那句点名四类关系与稳定 ID／方向／出处／验证态")
        notflow = text_of(page, "[data-flow-not-business-flow]")
        ok("不是" in notflow and "业务数据流" in notflow,
           "页面上显式否定「画布＝业务数据流」（红线：不得显示为业务数据流）")

        # ── ① 实体/关系/覆盖对账：DOM 读数与后端模型逐项相等 ──
        summary = text_of(page, "[data-flow-summary]")
        ok(("实体 %d" % len(model["nodes"])) in summary and ("关系 %d" % len(model["edges"])) in summary,
           "汇总行读数与后端模型一致：%s" % summary[:80])

        page.locator("details[data-flow-entities] > summary").click()
        page.wait_for_timeout(300)
        for kind in ["input_source", "process", "store", "output_external"]:
            n_dom = page.locator('[data-flow-entity-kind="%s"]' % kind).count()
            n_model = len([n for n in model["nodes"] if n["kind"] == kind])
            ok(n_dom == n_model and n_dom > 0,
               "实体「%s」在页面上 %d 个（后端模型 %d 个，逐项相等）" % (kind, n_dom, n_model))

        page.locator("details[data-flow-relations] > summary").click()
        page.wait_for_timeout(300)
        n_edges = page.locator("[data-flow-edge]").count()
        ok(n_edges == len(model["edges"]) and n_edges > 0,
           "关系在页面上 %d 条（后端模型 %d 条）" % (n_edges, len(model["edges"])))
        prov_dom = page.locator("[data-flow-edge][data-flow-provenance]").count()
        ver_dom = page.locator("[data-flow-edge][data-flow-verification]").count()
        ok(prov_dom == n_edges and ver_dom == n_edges,
           "每条关系都带来源分层与验证态属性（%d/%d）" % (prov_dom, ver_dom))
        # 反例守线：静态 import 线索必须与出处分开显示（线索在场时不得混进出处档位）
        ok(page.locator("[data-flow-static-clue]").count() >= 1,
           "静态 import 线索单独成行（%d 处，标注「只作线索」）" % page.locator("[data-flow-static-clue]").count())

        # ── ③ 端到端数据链：逐跳可点开追到出处与验证态 ──
        chain = model["chains"][0]
        ok(page.locator('[data-flow-chain="%s"]' % chain["id"]).count() == 1,
           "端到端数据链在页面上（%s）" % chain["id"])
        hops = page.locator("[data-flow-hop]")
        ok(hops.count() == len(chain["hops"]),
           "链上 %d 跳逐跳有锚点（后端 %d 跳）" % (hops.count(), len(chain["hops"])))
        kinds_dom = [page.locator("[data-flow-hop]").nth(i).get_attribute("data-flow-hop") for i in range(hops.count())]
        ok(kinds_dom == [h["node_id"] for h in chain["hops"]],
           "跳序与后端模型逐跳对齐（%s）" % " → ".join(kinds_dom))
        # 真点开第一跳与最后一跳：读得到出处与复跑命令
        for idx in [0, hops.count() - 1]:
            hop = chain["hops"][idx]
            loc = page.locator('[data-flow-hop="%s"] summary' % hop["node_id"])
            loc.click()
            page.wait_for_timeout(250)
            box = page.locator('[data-flow-hop="%s"]' % hop["node_id"])
            body = box.inner_text()
            n_ev = box.locator("[data-flow-evidence]").count()
            ok(n_ev == len(hop["evidence"]) and n_ev > 0,
               "第 %d 跳（%s）点开后读到 %d 条出处（后端 %d 条）" % (hop["index"], hop["node_id"], n_ev, len(hop["evidence"])))
            ok("pnpm verify" in body or "复跑" in body,
               "第 %d 跳的出处带可复跑命令（点开后正文里有）：%s" % (hop["index"], body.replace("\n", " ")[:70]))
            ok(("已验证" in body) or ("未核实" in body) or ("缺证" in body),
               "第 %d 跳点开后能读到验证态" % hop["index"])

        # ── ④ 覆盖对账：逐条在场 + 缺路径阻断 ──
        page.locator("details[data-flow-coverage] > summary").click()
        page.wait_for_timeout(300)
        n_rows = page.locator("[data-flow-coverage-row]").count()
        ok(n_rows == model["coverage"]["declared_total"] and n_rows >= 20,
           "覆盖对账在页面上 %d 行（后端 %d 行；声明全量，不抽样）" % (n_rows, model["coverage"]["declared_total"]))
        blocked = page.locator("[data-flow-blocked]").first.get_attribute("data-flow-blocked")
        blocked_text = text_of(page, "[data-flow-blocked]")
        ok(blocked == ("true" if model["deliverable_blocked"] else "false"),
           "页面上的交付阻断读数与后端一致（%s）" % blocked)
        if model["coverage"]["missing_paths"]:
            miss = model["coverage"]["missing_paths"][0]
            ok("不得得出" in blocked_text and miss.split("/")[-1] in blocked_text,
               "缺路径在页面上点名并阻断交付结论：%s" % blocked_text[:90])

        page.screenshot(path=os.path.join(SHOT_DIR, "01-data-flow-口径与数据链.png"), full_page=False)
        page.locator("details[data-flow-coverage] > summary").click()
        page.locator("details[data-flow-relations] > summary").click()
        page.wait_for_timeout(300)
        page.screenshot(path=os.path.join(SHOT_DIR, "02-data-flow-上层画布.png"), full_page=False)
        ok(os.path.exists(os.path.join(SHOT_DIR, "01-data-flow-口径与数据链.png")),
           "真机截图落盘 %s" % os.path.join(SHOT_DIR, "01-data-flow-口径与数据链.png"))
        browser.close()


def main():
    tmp = tempfile.mkdtemp(prefix="tatai-v0911-ui-")
    home = os.path.join(tmp, "home")
    os.makedirs(home, exist_ok=True)
    now = "2026-09-24T00:00:00+08:00"
    write(os.path.join(home, "registry.json"),
          json.dumps({"version": 1, "projects": [
              {"id": REAL_ID, "name": "塔台", "path": REPO, "kind": "fullstack", "self_managed": True,
               "registered_at": now, "last_opened_at": now}]}, ensure_ascii=False, indent=2) + "\n")
    backend = None
    vite = None
    try:
        port = free_port()
        backend = Backend(home, port, os.path.join(SHOT_DIR, "..", "ui-backend.log"))
        backend.wait_health()
        info("后端 %d 已就绪" % port)
        vport = free_port()
        vite = start_vite(vport, port, os.path.join(SHOT_DIR, "..", "ui-vite.log"))
        info("vite %d 已就绪" % vport)
        run_browser(vport, backend)
    finally:
        if vite is not None:
            vite.kill()
        if backend is not None:
            backend.kill()
        shutil.rmtree(tmp, ignore_errors=True)

    print("[ui] V09-11 UI：PASS %d / FAIL %d" % (passes[0], len(fails)))
    if fails:
        print("[ui] 存在 FAIL")
        sys.exit(1)
    print("[ui] 全部 PASS")


if __name__ == "__main__":
    main()
