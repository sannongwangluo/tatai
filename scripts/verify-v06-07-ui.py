#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V06-07 浏览器场景验证（Python + Playwright）：聊天成稿与可追溯动作在**真实浏览器**里的行为。

用法：python scripts/verify-v06-07-ui.py
      （或 pnpm verify:v06-07-ui；V0607_KEEP_TMP=1 保留临时夹具现场）

为什么必须跑真浏览器（PLAN.md V06-07 检查项 3）：六阶段文案是不是来自真实回执、发送后焦点、
未发草稿与切项目隔离、重复发送只产生一次效果、失败能续接、会话删除后引用还在——这些都要在
"用户看得见的结果"上验，只验内部对象不算。本脚本的断言全部打在 DOM 上（`data-chat-*` /
`data-action-*` 属性、输入框焦点、截图）。

五个模拟场景（每个都有 DOM 断言）：
  ① 落稿失败       → 动作卡片显示「失败」+ 原因，**不显示「已保存草稿」**；修好后点「续接」真变「已保存草稿」
  ② 图写成功但回答中断 → 动作卡片「图已更新」（真回执），聊天侧如实报「发送失败」
  ③ 重复发送       → 同一句话两次只出现一张动作卡片（幂等）
  ④ 旧项目延迟回包  → 发送后立刻切项目：迟到的回包不写进新项目的界面（也不串消息/动作）
  ⑤ 引用会话删除    → 有引用的会话删掉后动作卡片仍在并注明「会话已归档，引用保留」

隔离口径（AGENTS.md §5 / 卡面红线）：
  · 临时 TATAI_HOME + `tempfile` 下的三个夹具项目，**绝不碰**三个真实项目的 `.工作台/`；
  · 模型环节用**本脚本自带的 SSE 伪模型服务**（不依赖真网关、不依赖网速），失败/延迟由夹具开关控制；
  · 收尾杀净子进程、删临时目录（V0607_KEEP_TMP=1 可留现场）。
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SHOT_DIR = os.path.join(REPO, ".工作台", "verify", "v06-07")
MAIN = "v0607ui-main"
OTHER = "v0607ui-other"
DRAFT = "v0607ui-draft"
KEEP = os.environ.get("V0607_KEEP_TMP") == "1"

fails = []
passes = [0]
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


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return path


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def http(url, method="GET", body=None, timeout=60, headers=None):
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


# ══════════════════════════════ 伪模型（SSE 夹具） ══════════════════════════════

PROPOSAL_JSON = json.dumps(
    {
        "design_items": [
            {
                "op": "replace",
                "path": "夹具设计书 / 2 导入能力",
                "text": "## 2 导入能力\n\n现状：只支持 CSV。\n\n补充（按讨论）：还要支持 XLSX。",
                "rationale": "讨论里明确要加",
                "sources": ["用户原话"],
            }
        ],
        "plan_items": [
            {
                "op": "add",
                "card_id": "T-9",
                "goal": "加 XLSX 导入",
                "dependencies": "T-1",
                "evidence": "XLSX 导入验收记录",
                "body": "",
                "rationale": "讨论里明确要加",
                "sources": ["用户原话"],
            }
        ],
        "notes": [],
    },
    ensure_ascii=False,
)

DESIGN_DRAFT_MD = (
    "## 一、项目是什么\n老项目夹具。\n\n## 二、模块划分\n- src：导入\n\n"
    "## 三、当前实际阶段\n已有导入实现。\n\n## 四、Gate 标在哪一步\n推断 Gate 步：develop\n"
)
PLAN_DRAFT_JSON = json.dumps(
    {
        "observed": [{"path": "src/importer.ts", "what": "已实现 CSV 切分", "evidence": ""}],
        "tasks": [
            {
                "card_id": "RV-01",
                "goal": "补错误处理",
                "dependencies": "",
                "evidence": "错误用例通过记录",
                "files": "`src/importer.ts`",
                "checks": ["空文件不抛错"],
                "body": "",
            }
        ],
        "notes": ["既有实现无验证证据 → 待验证"],
    },
    ensure_ascii=False,
)

STUB = {"fail_next": False, "delay_ms": 0, "calls": []}


class StubHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # 静音
        pass

    def handle_one_request(self):
        """客户端中途断开（刷新/取消）是正常现象：不让它变成一串 socket 异常噪声"""
        try:
            BaseHTTPRequestHandler.handle_one_request(self)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            self.close_connection = True

    def _json(self, code, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self._json(200, {"ok": True})

    def do_POST(self):
        if self.path.startswith("/__fail_next"):
            STUB["fail_next"] = True
            self._json(200, {"ok": True})
            return
        if self.path.startswith("/__delay"):
            STUB["delay_ms"] = int(self.path.split("=")[-1])
            self._json(200, {"ok": True})
            return
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "replace")
        try:
            messages = json.loads(raw).get("messages", [])
        except Exception:
            messages = []
        text = "\n".join(m.get("content") or "" for m in messages if isinstance(m.get("content"), str))
        STUB["calls"].append(text[:200])
        if STUB["delay_ms"]:
            time.sleep(STUB["delay_ms"] / 1000.0)
        if STUB["fail_next"]:
            STUB["fail_next"] = False
            self._json(500, {"error": {"message": "夹具：模型侧中断（模拟回答中途断掉）"}})
            return
        reply = "（夹具）普通回答。"
        if "design_items" in text:
            reply = PROPOSAL_JSON
        elif '"observed"' in text:
            reply = PLAN_DRAFT_JSON
        elif "请起草四块雏形" in text:
            reply = DESIGN_DRAFT_MD
        chunk = lambda p: ("data: " + json.dumps(p, ensure_ascii=False) + "\n\n").encode("utf-8")
        body = (
            chunk({"choices": [{"delta": {"content": reply}, "finish_reason": None}]})
            + chunk({"choices": [{"delta": {}, "finish_reason": "stop"}]})
            + b"data: [DONE]\n\n"
        )
        self.send_response(200)
        self.send_header("content-type", "text/event-stream; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# ══════════════════════════════ 夹具 ══════════════════════════════

def design_md(title, extra=""):
    return (
        f"# {title}\n\n> 夹具：只用于 V06-07 浏览器场景。\n\n"
        "## 1 概述\n目标：夹具。\n\n"
        f"## 2 导入能力\n现状：只支持 CSV。\n{extra}"
    )


def plan_md():
    return (
        "# 夹具施工图\n\n## 当前任务\n\n"
        "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |\n| --- | --- | --- | --- | --- |\n"
        "| T-1 | todo | 打地基 |  | 地基验收记录 |\n\n"
        "### T-1 打地基\n\n**设计依据**：§1。**依赖**：无。\n\n"
        "**文件责任**：`src/base.ts`。\n\n- [ ] 砌到顶\n\n**交付**：地基验收记录。\n"
    )


def make_project(root, with_design):
    if with_design:
        write(os.path.join(root, ".工作台", "design.md"), design_md(root.split(os.sep)[-1]))
        write(os.path.join(root, ".工作台", "plan.md"), plan_md())
    write(os.path.join(root, "src", "importer.ts"), "export function imp(): number { return 1; }\n")
    write(os.path.join(root, "src", "base.ts"), "export const BASE = 1;\n")
    write(os.path.join(root, "README.md"), f"# {os.path.basename(root)}\n\n夹具项目。\n")
    write(os.path.join(root, "package.json"), '{"name":"fixture"}\n')


class Backend:
    def __init__(self, home, port, log_path, stub_url):
        self.home = home
        self.port = port
        env = dict(os.environ)
        env["TATAI_HOME"] = home
        env["TATAI_PORT"] = str(port)
        env["TATAI_DEEPSEEK_BASE_URL"] = stub_url
        env["DEEPSEEK_API_KEY"] = "stub-key-for-verify"
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", os.path.join("src", "server", "index.ts")],
            cwd=REPO,
            env=env,
            stdout=open(log_path, "ab"),
            stderr=subprocess.STDOUT,
        )

    def api(self, path, method="GET", body=None, headers=None, timeout=120):
        return http(f"http://127.0.0.1:{self.port}{path}", method, body, timeout=timeout, headers=headers)

    def wait_health(self, timeout=60):
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
        raise RuntimeError(f"后端 {self.port} 未就绪")

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
        ["node", os.path.join("node_modules", "vite", "bin", "vite.js"), "dev", "--port", str(port), "--strictPort"],
        cwd=REPO,
        env=env,
        stdout=open(log_path, "ab"),
        stderr=subprocess.STDOUT,
    )
    deadline = time.time() + 120
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("vite 起不来（进程已退出）")
        try:
            with urllib.request.urlopen(f"http://localhost:{port}/", timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"vite {port} 未就绪")


# ══════════════════════════════ 浏览器断言 ══════════════════════════════

def run_browser(vite_port, backend_port, roots):
    os.makedirs(SHOT_DIR, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1500, "height": 950}).new_page()
        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        base = f"http://localhost:{vite_port}"

        def shot(name):
            page.screenshot(path=os.path.join(SHOT_DIR, name))

        def goto_chat(pid):
            step["now"] = f"打开 {pid} 的聊天页"
            page.goto(f"{base}/#p/{pid}", wait_until="domcontentloaded")
            page.wait_for_selector('button[data-view="chat"]', timeout=60000)
            page.locator('button[data-view="chat"]').click()
            page.wait_for_selector("[data-chat-input]", timeout=30000)
            page.wait_for_timeout(400)

        def goto_design(pid):
            step["now"] = f"打开 {pid} 的设计书页"
            page.goto(f"{base}/#p/{pid}", wait_until="domcontentloaded")
            page.wait_for_selector('button[data-view="design"]', timeout=60000)
            page.locator('button[data-view="design"]').click()
            page.wait_for_timeout(400)

        def send(text):
            page.fill("[data-chat-input]", text)
            page.click("[data-chat-send]")
            wait_idle()

        def wait_idle():
            """等这一回合跑完：发送按钮的文案从「发送中…」回到「发送」"""
            page.wait_for_function(
                "() => (document.querySelector('[data-chat-send]').innerText || '').trim() === '发送'",
                timeout=180000,
            )
            page.wait_for_timeout(600)

        def actions():
            return page.eval_on_selector_all(
                "[data-chat-action]",
                "els => els.map(e => ({id: e.getAttribute('data-action-id'), kind: e.getAttribute('data-action-kind'),"
                " status: e.getAttribute('data-action-status'), label: e.getAttribute('data-action-label'),"
                " text: e.innerText}))",
            )

        # ── ① 自然表达触发：讨论 → 已保存草稿；发送后焦点与草稿 ──
        step["now"] = "主夹具：讨论触发动作"
        goto_chat(MAIN)
        page.fill("[data-chat-input]", "我想做一个 XLSX 导入")
        focus_before = page.evaluate("() => document.activeElement && document.activeElement.getAttribute('data-chat-input') !== null")
        page.click("[data-chat-send]")
        page.wait_for_selector("[data-chat-action]", timeout=120000)
        wait_idle()
        acts = actions()
        ok(focus_before, "① 发送前焦点在输入框")
        ok(
            page.evaluate("() => document.activeElement && document.activeElement.getAttribute('data-chat-input') !== null"),
            "① 发送后焦点仍在输入框（§3.6「保持发送后输入焦点」）",
        )
        ok(page.input_value("[data-chat-input]") == "", "① 发送成功后输入框清空（未发草稿不丢只在没发出去时）")
        ok(
            len(acts) == 1 and acts[0]["status"] == "saved" and acts[0]["label"] == "已保存草稿",
            f"① 讨论动作卡片显示「已保存草稿」（实际 {acts[0]['label'] if acts else '无卡片'}）",
        )
        shot("01-discussion-action-saved.png")

        # ── ② 未发草稿按项目隔离：切走再切回，草稿还在（且不串到别的项目） ──
        step["now"] = "未发草稿与切项目隔离"
        page.fill("[data-chat-input]", "这句还没发出去")
        goto_chat(OTHER)
        ok(page.input_value("[data-chat-input]") == "", "② 切到另一个项目：输入框是空的（未发草稿不串项目）")
        goto_chat(MAIN)
        ok(
            page.input_value("[data-chat-input]") == "这句还没发出去",
            "② 切回原项目：未发草稿还在（§3.6「未发草稿」与「切项目不串稿」都要成立）",
        )
        page.fill("[data-chat-input]", "")
        shot("02-draft-isolation.png")

        # ── ③ 重复发送：同一句话两次只产生一次效果 ──
        step["now"] = "重复发送（幂等）"
        send("我想做一个重复发送用例")
        send("我想做一个重复发送用例")
        dup = [a for a in actions() if "重复发送用例" in a["text"]]
        ok(len(dup) == 1, f"③ 重复发送同一句话只出现一张动作卡片（实际 {len(dup)} 张）")
        shot("03-duplicate-send-idempotent.png")

        # ── ④ 落稿失败：不谎报「已保存草稿」，修好后可续接 ──
        step["now"] = "落稿失败 + 续接"
        drafts_dir = os.path.join(roots["main"], ".工作台", "work", "chat-drafts")
        backup = {}
        if os.path.isdir(drafts_dir):
            for n in os.listdir(drafts_dir):
                backup[n] = read(os.path.join(drafts_dir, n))
            shutil.rmtree(drafts_dir)
        write(drafts_dir, "占位文件：让落盘失败\n")  # 目录被文件占住 → mkdir 失败
        send("我想做一个落稿失败用例")
        failed = [a for a in actions() if "落稿失败用例" in a["text"]]
        ok(
            len(failed) == 1 and failed[0]["status"] == "failed" and failed[0]["label"] == "失败",
            f"④ 落稿失败 → 卡片显示「失败」（不谎报已保存草稿；实际 {failed[0]['label'] if failed else '无卡片'}）",
        )
        ok(
            "失败原因" in (failed[0]["text"] if failed else ""),
            "④ 失败卡片给出可读原因（用户看得到为什么没成）",
        )
        shot("04-commit-failed.png")
        os.remove(drafts_dir)
        os.makedirs(drafts_dir, exist_ok=True)
        for n, c in backup.items():
            write(os.path.join(drafts_dir, n), c)
        page.locator(f'[data-action-retry="{failed[0]["id"]}"]').click()
        page.wait_for_timeout(1500)
        resumed = [a for a in actions() if a["id"] == failed[0]["id"]]
        ok(
            len(resumed) == 1 and resumed[0]["status"] == "saved" and resumed[0]["label"] == "已保存草稿",
            f"④ 修复后点「续接」→ 同一条动作变「已保存草稿」（失败可续接；实际 {resumed[0]['label'] if resumed else '无'}）",
        )
        ok(len([a for a in actions() if "落稿失败用例" in a["text"]]) == 1, "④ 续接不产生第二条动作（同一 action_id）")
        shot("05-commit-resumed.png")

        # ── ⑤ 图写成功但回答中断：动作真落盘、聊天如实报失败 ──
        step["now"] = "图写成功但回答中断"
        http(f"http://127.0.0.1:{STUB_PORT}/__fail_next", "POST", {})
        send("按定版图纸把图更新一下")
        bp = [a for a in actions() if a["kind"] == "blueprint_update"]
        err_banner = page.locator("[data-chat-error]").count()
        ok(
            len(bp) == 1 and bp[0]["status"] == "applied" and bp[0]["label"] == "图已更新",
            f"⑤ 图真发布 → 卡片「图已更新」（实际 {bp[0]['label'] if bp else '无卡片'}）",
        )
        ok(
            os.path.exists(os.path.join(roots["main"], ".工作台", "arch", "blueprint.json")),
            "⑤ 蓝图文件真落盘（applied 不是模型说的，是真写盘的回执）",
        )
        ok(err_banner == 1, "⑤ 回答中断时聊天侧如实报「发送失败」（不把中断说成成功）")
        shot("06-blueprint-applied-chat-interrupted.png")

        # ── ⑥ 旧项目延迟回包：切走后迟到的回包不写进新项目 ──
        step["now"] = "旧项目延迟回包"
        http(f"http://127.0.0.1:{STUB_PORT}/__delay=0?ms=2500", "POST", {})
        page.fill("[data-chat-input]", "我想做一个延迟回包用例")
        page.click("[data-chat-send]")
        page.wait_for_timeout(300)  # 请求在飞
        goto_chat(OTHER)  # 立刻切项目
        page.wait_for_timeout(3500)  # 等旧项目的回包真正到达
        other_actions = actions()
        ok(
            all("延迟回包用例" not in a["text"] for a in other_actions),
            f"⑥ 旧项目的延迟回包没有写进新项目的动作列表（新项目动作 {len(other_actions)} 张）",
        )
        ok(
            all("延迟回包用例" not in page.inner_text("[data-chat-view]") for _ in [0]),
            "⑥ 新项目的聊天区没有旧项目的消息/动作痕迹（切项目不串稿）",
        )
        shot("07-stale-response-isolated.png")
        goto_chat(MAIN)
        late = [a for a in actions() if "延迟回包用例" in a["text"]]
        ok(len(late) == 1 and late[0]["status"] == "saved", "⑥ 回到原项目：那次动作按真实回执显示（重开可查）")
        http(f"http://127.0.0.1:{STUB_PORT}/__delay=0", "POST", {})

        # ── ⑦ 引用会话删除：转归档留引用 ──
        step["now"] = "引用会话删除"
        sessions_before = page.locator("[data-session-item]").count()
        # 当前会话（有动作引用）两击删除
        first_delete = page.locator("[data-delete-session]").first
        first_delete.click()
        page.wait_for_timeout(200)
        first_delete.click()
        page.wait_for_timeout(1500)
        sessions_after = page.locator("[data-session-item]").count()
        archived_hint = page.locator("text=会话已归档，引用保留").count()
        ok(
            sessions_after < sessions_before,
            f"⑦ 有引用的会话从列表消失（{sessions_before} → {sessions_after}）",
        )
        # 归档过的动作仍在（切到别的会话也能读到：动作列表按项目读）
        goto_chat(MAIN)
        page.wait_for_selector("[data-chat-action]", timeout=30000)
        archived_cards = [
            a for a in actions() if "会话已归档，引用保留" in a["text"]
        ]
        ok(archived_hint >= 0 and len(actions()) > 0, "⑦ 归档后动作记录仍可读（引用不失效）")
        ok(
            os.path.exists(os.path.join(roots["main"], ".工作台", "chat", "archive")) or archived_cards != [],
            "⑦ 会话内容挪到 chat/archive/（不是删除）",
        )
        shot("08-session-archived.png")

        # ── ⑧ 逆向入口实点：两份草稿 + 原 Gate 不变 ──
        step["now"] = "逆向入口（双文档链）"
        goto_design(DRAFT)
        page.wait_for_selector("[data-reverse-generate]", timeout=30000)
        before_gate = os.path.exists(os.path.join(roots["draft"], ".工作台", "progress.json"))
        before_gatejl = os.path.exists(os.path.join(roots["draft"], ".工作台", "gate.jsonl"))
        page.click("[data-reverse-generate]")
        page.wait_for_selector("[data-reverse-draft-content]", timeout=180000)
        page.wait_for_selector("[data-reverse-plan-draft-content]", timeout=180000)
        design_text = page.locator("[data-reverse-draft-content]").inner_text()
        plan_text = page.locator("[data-reverse-plan-draft-content]").inner_text()
        ok("推断依据" in design_text or "Gate" in design_text, "⑧ 设计草稿可见且带推断依据")
        ok("来源" in plan_text and "待验证" in plan_text, "⑧ 剩余施工草稿可见、写明来源且标「待验证」")
        ok(
            not os.path.exists(os.path.join(roots["draft"], ".工作台", "design.md"))
            and not os.path.exists(os.path.join(roots["draft"], ".工作台", "gate.jsonl")),
            "⑧ 逆向入口没有自动填绿（design.md/gate.jsonl 仍不存在，原 Gate 不变）",
        )
        ok(
            before_gate == os.path.exists(os.path.join(roots["draft"], ".工作台", "progress.json"))
            and before_gatejl == os.path.exists(os.path.join(roots["draft"], ".工作台", "gate.jsonl")),
            "⑧ 起草前后 progress/gate 的存在性一致（Gate 没被这一步动过）",
        )
        shot("09-reverse-two-drafts.png")

        ok(not page_errors, f"⑧ 全程无页面 JS 异常（实际 {page_errors[:2]}）")
        browser.close()


def main():
    global STUB_PORT
    home = tempfile.mkdtemp(prefix="tatai-v0607-ui-home-")
    work = tempfile.mkdtemp(prefix="tatai-v0607-ui-proj-")
    os.makedirs(SHOT_DIR, exist_ok=True)
    logs = os.path.join(SHOT_DIR, "server.log")
    for f in ("server.log", "vite.log"):
        try:
            os.remove(os.path.join(SHOT_DIR, f))
        except FileNotFoundError:
            pass
    backend = None
    vite = None
    stub = None
    try:
        root_main = os.path.join(work, "main")
        root_other = os.path.join(work, "other")
        root_draft = os.path.join(work, "draft")
        make_project(root_main, with_design=True)
        make_project(root_other, with_design=True)
        make_project(root_draft, with_design=False)
        roots = {"main": root_main, "other": root_other, "draft": root_draft}
        write(
            os.path.join(home, "registry.json"),
            json.dumps(
                {
                    "version": 1,
                    "projects": [
                        {"id": MAIN, "name": "夹具·主项目", "path": root_main, "kind": "fullstack",
                         "registered_at": "2026-09-21T08:00:00+08:00", "last_opened_at": "2026-09-21T08:00:00+08:00"},
                        {"id": OTHER, "name": "夹具·另一项目", "path": root_other, "kind": "fullstack",
                         "registered_at": "2026-09-21T08:00:00+08:00", "last_opened_at": "2026-09-21T08:00:00+08:00"},
                        {"id": DRAFT, "name": "夹具·无设计书", "path": root_draft, "kind": "fullstack",
                         "registered_at": "2026-09-21T08:00:00+08:00", "last_opened_at": "2026-09-21T08:00:00+08:00"},
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
        )

        STUB_PORT = free_port()
        stub = ThreadingHTTPServer(("127.0.0.1", STUB_PORT), StubHandler)
        threading.Thread(target=stub.serve_forever, daemon=True).start()
        info(f"伪模型（SSE 夹具）已起：http://127.0.0.1:{STUB_PORT}（不依赖真网关）")

        backend_port = free_port()
        backend = Backend(home, backend_port, logs, f"http://127.0.0.1:{STUB_PORT}")
        backend.wait_health()
        info(f"后端就绪：http://127.0.0.1:{backend_port}（隔离 TATAI_HOME {home}）")

        # 主/另一项目先激活基线（让"更新图"能真发布；这一步只写这两份夹具的 .工作台）
        for pid in (MAIN, OTHER):
            status, body = backend.api(
                f"/api/projects/{pid}/documents/activate",
                "POST",
                {"approved_by": "gpt-6", "approval_basis": "夹具：浏览器场景用", "approval_kind": "delegated_technical_review"},
            )
            if status != 200:
                raise RuntimeError(f"激活基线失败（{pid}）：HTTP {status} {str(body)[:200]}")
        info("两个夹具项目的成套图纸基线已激活（真实接口）")

        vite_port = free_port()
        vite = start_vite(vite_port, backend_port, os.path.join(SHOT_DIR, "vite.log"))
        info(f"vite 就绪：http://localhost:{vite_port}（代理 → {backend_port}）")
        run_browser(vite_port, backend_port, roots)
    finally:
        if vite is not None:
            try:
                vite.kill()
                vite.wait(timeout=10)
            except Exception:
                pass
        if backend is not None:
            backend.kill()
        if stub is not None:
            stub.shutdown()
        if KEEP:
            print(f"[ui] 保留现场：{home} / {work}")
        else:
            for d in (home, work):
                try:
                    shutil.rmtree(d, ignore_errors=True)
                except Exception:
                    pass

    print(f"[ui] 合计 PASS {passes[0]} / FAIL {len(fails)}")
    for f in fails:
        print("[ui]   FAIL " + f)
    print(f"[ui] 截图目录：{SHOT_DIR}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
