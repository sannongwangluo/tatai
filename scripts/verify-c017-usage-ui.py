#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""C017 用量区 UI 闭环验证（Python + Playwright 真浏览器）：卡面「UI 用量区」在真实 DOM/
真实 HTTP/真实文件系统上的行为证据（端点口径由 pnpm verify:c017-usage 覆盖，本脚本覆盖 UI 侧）。

用法：python scripts/verify-c017-usage-ui.py
      （C017_KEEP_TMP=1 保留临时夹具现场；C017_SHOT_DIR 可改截图目录，默认 .工作台/evidence/C017/1/）

卡面条款 → 本脚本断言/截图映射：
  ① 认领额度行（运营节流措辞：用量/上限/剩余，数字与夹具一致，不与费用表述同框）
     → quota 文案断言（已认领 4 次 / 上限 5 次 / 剩余可认领 1 次 / 「运营节流」/ 「接近上限」徽标）
     ＋ 01/02 截图；
  ② 耗时行（有来源如实显示毫秒，无来源标「进行中/无来源」）
     → T-A「90000 毫秒」、T-D「120000 毫秒」、T-B「进行中」、T-C「无来源」断言 ＋ 02 截图；
  ③ Token 行、金额行显式标「未计量」
     → 面板内「未计量」恰好 2 处、Token/金额两行各自可见 ＋ 02 截图；
  ④ 不得把配额数字与费用字样同框表述
     → 面板全文扫描「金额/费用/单价/成本/计费」零命中（「金额」行标签除外——它标的是未计量行本身，
        故扫描集只含 费用/单价/成本/计费 四字样，面板里连这些也不许出现）。

夹具与隔离（AGENTS.md §5 / 卡面红线）：
  · 临时 TATAI_HOME + tempfile 下一个夹具项目（手写合法 events.jsonl：4 认领动作，上限 5 → 接近上限），
    绝不碰真实项目与真实 TATAI_HOME；
  · 不调模型网关：DEEPSEEK_API_KEY 置空；全链零模型调用；
  · 收尾杀净子进程、删临时目录（C017_KEEP_TMP=1 可留现场）。
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
SHOT_DIR = os.environ.get("C017_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "C017", "1"))
KEEP = os.environ.get("C017_KEEP_TMP") == "1"

PID = "c017ui"
T0 = 1760572800  # 2026-10-16T00:00:00Z 附近的固定基点（夹具内自洽即可）

fails = []
passes = [0]


def ok(cond, label):
    print(("[ui] PASS " if cond else "[ui] FAIL ") + label)
    if cond:
        passes[0] += 1
    else:
        fails.append(label)


def info(msg):
    print("[ui]   " + msg)


def iso(ms_offset):
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(T0 + ms_offset / 1000.0))


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


def http(url, method="GET", body=None, timeout=60):
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


def claim_payload(token, owner, action):
    return {
        "claim_action": action, "owner_id": owner, "owner_role": "executor",
        "run_id": "run-1", "attempt_id": "a1", "attempt": 1,
        "claim_token": token, "lease_expires_at": iso(3600000),
        "workspace": "ws-fixture", "takeover_basis": None,
    }


def delivered_payload(task_id, token):
    return {
        "task_id": task_id, "run_id": "run-1", "attempt_id": "a1", "attempt": 1,
        "claim_token": token, "owner_id": "alice", "coordinator_id": "coord-fixture",
        "client_id": "fixture-client", "model": None, "effort": None,
        "workspace": "ws-fixture", "parent_execution_id": None, "parent_run_id": None,
        "result_summary": "夹具交付",
    }


def make_fixture(root, home):
    """4 条认领动作（上限 5 → 接近上限）：T-A 交付 90000ms / T-B 进行中 / T-C 释放后无来源 /
    T-D 真实续约后交付 120000ms（续约不多算一条）。"""
    work = os.path.join(root, ".工作台", "work")
    specs = [
        ("task:T-A", 1, "task.claimed", iso(0), claim_payload("tokA1-secret-ui00001", "alice", "claim")),
        ("execution:ex-T-A-a1", 1, "execution.delivered", iso(90000), delivered_payload("T-A", "tokA1-secret-ui00001")),
        ("task:T-B", 1, "task.claimed", iso(100000), claim_payload("tokB1-secret-ui00002", "bob", "claim")),
        ("task:T-C", 1, "task.claimed", iso(110000), claim_payload("tokC1-secret-ui00003", "carol", "claim")),
        ("task:T-C", 2, "task.status_changed", iso(115000), {"status": "preparing", "claim_released": True}),
        ("task:T-D", 1, "task.claimed", iso(120000), claim_payload("tokD1-secret-ui00004", "dave", "claim")),
        ("task:T-D", 2, "task.claimed", iso(180000), claim_payload("tokD1-secret-ui00004", "dave", "renew")),
        ("execution:ex-T-D-a1", 1, "execution.delivered", iso(240000), delivered_payload("T-D", "tokD1-secret-ui00004")),
    ]
    lines = []
    for i, (entity, rev, etype, at, payload) in enumerate(specs):
        lines.append(json.dumps({
            "schema_version": 2, "event_id": "ev-%s-%d" % (PID, i + 1), "project_id": PID,
            "change_id": "chg-fixture", "entity_id": entity, "entity_revision": rev, "seq": i + 1,
            "type": etype, "actor_id": "fixture", "role": "executor",
            "occurred_at": at, "received_at": at,
            "idempotency_key": "fx-%s-%d" % (PID, i + 1), "payload": payload,
        }, ensure_ascii=False))
    write(os.path.join(work, "events.jsonl"), "\n".join(lines) + "\n")
    write(os.path.join(work, "budget.json"), json.dumps({"max_task_claims": 5, "near_threshold_ratio": 0.8}))
    write(os.path.join(root, ".工作台", "design.md"), "# %s 夹具设计书\n" % PID)
    write(os.path.join(root, "README.md"), "# %s 夹具\n" % PID)
    write(os.path.join(home, "registry.json"), json.dumps({
        "version": 1,
        "projects": [{"id": PID, "name": PID, "path": root, "kind": "backend",
                      "registered_at": "2026-09-21T00:00:00+08:00", "last_opened_at": "2026-09-21T00:00:00+08:00"}],
    }, ensure_ascii=False))


class Backend:
    def __init__(self, home, port, log_path):
        self.port = port
        env = dict(os.environ)
        env["TATAI_HOME"] = home
        env["TATAI_PORT"] = str(port)
        env["DEEPSEEK_API_KEY"] = ""
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", os.path.join("src", "server", "index.ts")],
            cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
        )

    def api(self, path, method="GET", body=None, timeout=60):
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


def run_browser(vite_port):
    base = "http://localhost:%d" % vite_port
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto("%s/#p/%s" % (base, PID), wait_until="domcontentloaded")
        page.wait_for_selector('button[data-view="overview"]', timeout=60000)
        page.locator('button[data-view="overview"]').click()
        page.wait_for_selector("[data-usage-panel]", timeout=30000)
        page.wait_for_selector("[data-usage-quota]", timeout=30000)
        page.wait_for_timeout(800)

        panel = page.locator("[data-usage-panel]")
        panel_text = panel.inner_text()

        # ── ① 认领额度行：数字与夹具一致，运营节流措辞 ──
        info("① 认领额度行（运营节流，数字与夹具一致）")
        quota = page.locator("[data-usage-quota]").inner_text()
        ok("已认领 4 次" in quota, "① 用量数字与夹具一致：已认领 4 次（%s…）" % quota.strip()[:50])
        ok("上限 5 次" in quota, "① 上限与夹具一致：上限 5 次")
        ok("剩余可认领 1 次" in quota, "① 近阈值如实报剩余：剩余可认领 1 次")
        ok("接近上限" in quota, "① 接近上限徽标可见（4/5=0.8 触及 ratio）")
        ok("运营节流" in quota and "不代表任何实耗" in quota, "① 运营节流措辞在场：只数认领动作，不代表任何实耗")
        page.screenshot(path=os.path.join(SHOT_DIR, "01-usage-quota-near.png"), full_page=True)

        # ── ② 耗时行：有来源给毫秒，无来源标进行中/无来源 ──
        info("② 执行耗时行（有来源给毫秒 / 未完结如实标注）")
        ta = page.locator('[data-usage-duration-item="T-A"]').inner_text()
        td = page.locator('[data-usage-duration-item="T-D"]').inner_text()
        tb = page.locator('[data-usage-duration-item="T-B"]').inner_text()
        tc = page.locator('[data-usage-duration-item="T-C"]').inner_text()
        ok("90000 毫秒" in ta and "90.0 秒" in ta, "② T-A 有来源：90000 毫秒（90.0 秒，认领→交付）（%s）" % ta.strip()[:60])
        ok("120000 毫秒" in td, "② T-D 真实续约不多算一条、配首次认领：120000 毫秒（%s）" % td.strip()[:60])
        ok("进行中" in tb and "毫秒" not in tb.split("进行中")[0], "② T-B 未完结标「进行中」、不计毫秒（%s）" % tb.strip()[:60])
        ok("无来源" in tc, "② T-C 释放后无交付回执标「无来源」（%s）" % tc.strip()[:60])
        ok(page.locator("[data-usage-duration-item]").count() == 4, "② 恰 4 条耗时条目（续约不顶位、不新增）")
        ok("received_at" in panel_text, "② 耗时来源说明在场：事件时间戳 received_at")

        # ── ③ Token / 金额两行显式「未计量」 ──
        info("③ Token / 金额行显式「未计量」")
        token_row = page.locator("[data-usage-token]").inner_text()
        cost_row = page.locator("[data-usage-cost]").inner_text()
        ok("未计量" in token_row, "③ Token 行显式标「未计量」（%s…）" % token_row.strip()[:40])
        ok("未计量" in cost_row, "③ 金额行显式标「未计量」（%s…）" % cost_row.strip()[:40])
        ok(panel_text.count("未计量") == 2, "③ 面板内「未计量」恰好 2 处（Token、金额各一，不多不少）实际 %d 处" % panel_text.count("未计量"))
        page.screenshot(path=os.path.join(SHOT_DIR, "02-usage-panel-full.png"), full_page=True)

        # ── ④ 费用向字样零命中（配额数字不与费用表述同框） ──
        info("④ 表述巡检（面板全文）")
        banned = [w for w in ("费用", "单价", "成本", "计费") if w in panel_text]
        ok(not banned, "④ 面板无 费用/单价/成本/计费 字样%s" % ("（命中：" + ",".join(banned) + "）" if banned else ""))

        browser.close()


def main():
    os.makedirs(SHOT_DIR, exist_ok=True)
    for f in os.listdir(SHOT_DIR):
        if f.endswith(".png"):
            os.remove(os.path.join(SHOT_DIR, f))
    tmp = tempfile.mkdtemp(prefix="tatai-c017-ui-")
    home = os.path.join(tmp, "home")
    os.makedirs(home, exist_ok=True)
    backend = None
    vite = None
    try:
        root = os.path.join(tmp, "proj")
        make_fixture(root, home)
        info("夹具：%s（4 认领动作 / 上限 5 → 接近上限；T-A 90s、T-D 120s、T-B 进行中、T-C 无来源）" % PID)

        backend_port = free_port()
        backend = Backend(home, backend_port, os.path.join(SHOT_DIR, "server.log"))
        backend.wait_health()
        info("后端就绪：http://127.0.0.1:%d（隔离 TATAI_HOME）" % backend_port)

        # HTTP 交叉核对（与浏览器同一端点）：端点口径与夹具一致
        st, body = backend.api("/api/projects/%s/work/usage" % PID)
        quota = (body.get("usage") or {}).get("claim_quota") or {}
        ok(st == 200 and quota.get("usage") == 4 and quota.get("max") == 5 and quota.get("remaining") == 1
           and quota.get("status") == "near",
           "HTTP 交叉核对：usage=4 / max=5 / remaining=1 / status=near（与夹具一致）")

        vite_port = free_port()
        vite = start_vite(vite_port, backend_port, os.path.join(SHOT_DIR, "vite.log"))
        info("vite 就绪：http://localhost:%d（代理 → %d）" % (vite_port, backend_port))

        run_browser(vite_port)
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
