#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V06-12 浏览器场景验证（Python + Playwright）：Git 保存版本提醒在**真实浏览器**里的行为。

用法：python scripts/verify-v06-12-ui.py
      （或 pnpm verify:v06-12-ui；V0612_KEEP_TMP=1 保留临时现场）

why 必须跑真浏览器（PLAN.md V06-12 检查项 2/3）：「在成果提交、重新打开或手动刷新时更新提醒并合并重复」
「提供查看与复制给 Agent 的说明」「新成果不被旧暂缓吞掉」「不同项目提醒相互隔离」「不每保存一个文件弹窗」
——这些只有在实际 DOM、真实 HTTP、真实 SSE 与真实文件系统上才验得出来，渲染函数级断言不算。

三条检查项逐条落到断言组（组号与 PLAN 卡面一一对应）：
  ② 触发与合并：挂载即探（重新打开项目）→ 变更新一批 → 点「刷新探测」手动刷 → 同一批指纹只合并计数、
     不重复展开；看变更摘要/文件范围/最后检测时间；查看整理说明 + 复制给执行 Agent；
     远端只给已知跟踪状态与观测时间；不是仓库时明说未使用 Git。
  ③ 只读：探测前后**夹具仓库**的 HEAD / 索引（`git ls-files -s` 输出哈希 + `.git/index` 字节哈希）/
     工作树全部文件哈希逐项相同；页面上没有初始化/提交/推送这类写入口。
  另：`.工作台/` 被忽略 + 代码已提交 → 卡片仍只说备份状态未知；有成果提交且证据在册 → 说
      「已通过必要检查」，没有的 → 说「未验证（不是稳定成果）」。

隔离口径（AGENTS.md §5 / 卡面红线）：
  · 临时 TATAI_HOME + `tempfile` 下的夹具项目，**绝不碰**三个真实项目的 `.工作台/`；
  · 夹具里的 git **写**命令（init/add/commit）只用来造现场，全部在 tempfile 内，收尾整棵删掉；
    塔台本体与真实项目**一个 git 写命令都没跑**；
  · 模型环节不参与（本卡零模型）：夹具事实经真实 v2 写入服务（POST /api/work/command）提交；
  · 收尾杀净子进程、删临时目录（V0612_KEEP_TMP=1 可留现场）。
"""
import hashlib
import json
import os
import pathlib
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
    "V0612_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "V06-12", "1", "screenshots")
)
# 测试只访问本次隔离的回环服务，显式直连：ambient 代理会把 127.0.0.1 探活转成 502（同
# `scripts/verify-forward-baseline-ui.py` 的既有口径）。判据不变，只是不让代理插手回环。
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))
A = "v0612ui-a"
B = "v0612ui-b"
C = "v0612ui-nogit"
KEEP = os.environ.get("V0612_KEEP_TMP") == "1"

MAIN_NAV = ["交付总览", "项目图", "设计书", "施工图", "聊天", "实况与验收"]

# 带空格与中文的路径（`-z` 解析的正题；页面上必须逐字显示）
P_SPACE_CN = "资料 汇总/带 空格 与中文 的文件.txt"
P_STAGED = "已暂存 目录/新 文件.txt"
P_UNTRACKED = "未跟踪 目录/还没 加进来的.md"
P_B = "乙 项目/改动 文件.txt"
P_LATER = "后来新增 的/新 成果.md"

fails = []
passes = [0]
step = {"now": "启动"}

GIT_ENV = dict(os.environ, GIT_TERMINAL_PROMPT="0")

FIXTURE_ROOTS = {}
GIT_BEFORE = {}


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


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def http(url, method="GET", body=None, timeout=120, headers=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, method=method, data=data)
    if data is not None:
        req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with DIRECT.open(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8")
            return resp.status, (json.loads(text) if text.strip().startswith(("{", "[")) else text)
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, text


# ══════════════════════════════ 夹具（tempfile 内；git 写命令只在这里）══════════════════════════════

def git(cwd, args, check=True):
    """夹具专用 git 调用（写命令只允许在 tempfile 里的夹具仓库上用）。"""
    res = subprocess.run(
        ["git"] + args, cwd=cwd, env=GIT_ENV, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    if check and res.returncode != 0:
        raise RuntimeError("git %s 失败（%s）：%s" % (" ".join(args), cwd, res.stdout))
    return res.stdout


def git_read(cwd, args):
    return subprocess.run(
        ["git"] + args, cwd=cwd, env=GIT_ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    ).stdout


GIT_ID = ["-c", "user.email=fixture@tatai.local", "-c", "user.name=fixture"]


def repo_fingerprint(root):
    """只读判据：HEAD / 索引登记内容 / .git/index 字节与时间 / 工作树文件哈希 / 引用清单。

    这里**只读**地了解现场：没有 .git 的目录返回全 null 的指纹（返回内容由工作树哈希兜住）。"""
    files = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != ".git")
        for name in sorted(filenames):
            abs_p = os.path.join(dirpath, name)
            rel = os.path.relpath(abs_p, root).replace("\\", "/")
            with open(abs_p, "rb") as f:
                files[rel] = sha256_bytes(f.read())
    worktree = sha256_bytes(json.dumps(files, sort_keys=True, ensure_ascii=False).encode("utf-8"))
    index_path = os.path.join(root, ".git", "index")
    if not os.path.exists(index_path):
        return {"head": "", "index_listing": "", "index_file": "", "index_size": 0,
                "index_mtime": 0, "refs": "", "worktree": worktree, "has_git": False}
    index_stat = os.stat(index_path)
    with open(index_path, "rb") as f:
        index_bytes = f.read()
    return {
        "head": git_read(root, ["--no-optional-locks", "rev-parse", "HEAD"]).strip(),
        "index_listing": sha256_bytes(git_read(root, ["--no-optional-locks", "ls-files", "-s"]).encode("utf-8")),
        "index_file": sha256_bytes(index_bytes),
        "index_size": index_stat.st_size,
        "index_mtime": index_stat.st_mtime_ns,
        "refs": sha256_bytes(git_read(root, ["--no-optional-locks", "for-each-ref"]).encode("utf-8")),
        "worktree": worktree,
        "has_git": True,
    }


def make_repo(root, first_file):
    os.makedirs(root, exist_ok=True)
    git(root, ["init", "-q", "-b", "main", "."])
    write(os.path.join(root, ".gitignore"), ".工作台/\n")
    write(os.path.join(root, first_file), "第一版\n")
    git(root, ["add", "--", ".gitignore", first_file])
    git(root, GIT_ID + ["commit", "-qm", "初版"])
    return root


def make_project_facts(root, plan_cards):
    # progress.json 的阅读位置是 `<项目根>/.工作台/progress.json`（workstation.ts 口径）；
    # 写到项目根会多出一个未跟踪文件、污染"这批改动"的夹具现场
    write(os.path.join(root, ".工作台", "progress.json"), json.dumps({
        "version": 1,
        "gate": {"current_step": "develop", "history": [
            {"step": "kickoff", "result": "pass", "at": "2026-09-20T08:00:00+08:00", "note": "夹具"},
        ]},
        "modules": [{"id": "m1", "name": "夹具模块一", "status": "doing"}],
    }, ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(root, ".工作台", "tasks.json"), json.dumps({
        "version": 1,
        "tasks": [{"id": cid, "title": goal, "module_id": "m1", "status": "doing",
                   "reporter": "fixture", "updated_at": "2026-09-20T09:00:00+08:00"}
                  for cid, goal in plan_cards],
    }, ensure_ascii=False, indent=2) + "\n")


def plan_md(title, cards):
    rows = "\n".join("| %s | todo | %s | | %s |" % (cid, goal, goal + "验收") for cid, goal in cards)
    sections = "\n".join(
        "### %s %s\n\n**设计依据**：§2。**依赖**：无。\n\n**文件责任**：`src/x.ts`。\n\n"
        "- [ ] %s 的验收检查项一\n\n**交付**：%s。\n" % (cid, goal, cid, goal)
        for cid, goal in cards
    )
    return ("# %s\n\n> 夹具施工图。\n\n## 当前任务\n\n"
            "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |\n| --- | --- | --- | --- | --- |\n%s\n\n%s\n"
            % (title, rows, sections))


def put_evidence(root, content, summary, kind="acceptance"):
    """按内容寻址把证据正文写进夹具的 `.工作台/work/evidence/`（与 evidence.ts 同格式）。"""
    sha = sha256_bytes(content.encode("utf-8"))
    write(os.path.join(root, ".工作台", "work", "evidence", sha + ".json"), json.dumps({
        "evidence_id": sha, "sha256": sha, "bytes": len(content.encode("utf-8")),
        "recovery_path": "work/evidence/%s.json" % sha, "kind": kind, "summary": summary,
        "created_by": "fixture", "role": "agent",
        "binding": {"revision_kind": "code", "revision": "fixture-code-rev-1"},
        "source_ref": None, "created_at": "2026-09-20T09:30:00+08:00",
        "content_sha256": sha, "content": content,
    }, ensure_ascii=False, indent=2) + "\n")
    return sha


def content_fingerprint(root, rels):
    """「当前实际内容版本」指纹——**用产品同一实现**算（`gitStatus.ts#contentVersionOf`）。

    补修 D ③：判定要绑定"含未提交改动"的当前内容，指纹算法只有一处实现；本脚本不重抄算法，
    而是用 tsx 动态 import 那个模块（`node --import tsx --input-type=module -e`），避免两边漂移。
    """
    uri = pathlib.Path(REPO, "src", "server", "gitStatus.ts").as_uri()
    code = (
        "const m = await import(%s);"
        "const cv = m.contentVersionOf(%s, %s);"
        "if (cv.fingerprint === null) { console.error(cv.note); process.exit(2); }"
        "process.stdout.write(cv.fingerprint);"
    ) % (json.dumps(uri), json.dumps(root), json.dumps(list(rels)))
    res = subprocess.run(
        ["node", "--import", "tsx", "--input-type=module", "-e", code],
        cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=GIT_ENV,
    )
    if res.returncode != 0 or not res.stdout.strip():
        raise RuntimeError("contentVersionOf 调用失败：%s" % (res.stderr.strip()[:300] or res.stdout.strip()[:300]))
    return res.stdout.strip()


def make_registry(home, records):
    write(os.path.join(home, "registry.json"),
          json.dumps({"version": 1, "projects": records}, ensure_ascii=False, indent=2) + "\n")


# ══════════════════════════════ 后端 / vite ══════════════════════════════

class Backend:
    def __init__(self, home, port, log_path):
        self.home = home
        self.port = port
        env = dict(os.environ)
        env["TATAI_HOME"] = home
        env["TATAI_PORT"] = str(port)
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", os.path.join("src", "server", "index.ts")],
            cwd=REPO, env=env, stdout=open(log_path, "ab"), stderr=subprocess.STDOUT,
        )

    def api(self, path, method="GET", body=None, headers=None, timeout=120):
        return http("http://127.0.0.1:%d%s" % (self.port, path), method, body, timeout=timeout, headers=headers)

    def work_token(self):
        with open(os.path.join(self.home, "work-service.json"), encoding="utf-8") as f:
            return json.load(f)["token"]

    def wo_command(self, command):
        status, body = self.api("/api/work/command", "POST", command,
                                headers={"x-tatai-work-token": self.work_token()})
        if status != 200:
            raise RuntimeError("v2 写入失败 HTTP %s：%s" % (status, str(body)[:300]))
        return body

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
            with DIRECT.open("http://localhost:%d/" % port, timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("vite %d 未就绪" % port)


def cmd(project, entity, type_, payload, key, expected=None, actor="fixture", role="agent"):
    return {
        "schema_version": 2, "project_id": project, "change_id": "v0612ui", "entity_id": entity,
        "expected_revision": expected, "type": type_, "actor_id": actor, "role": role,
        "idempotency_key": key, "payload": payload,
    }


# ══════════════════════════════ 浏览器断言 ══════════════════════════════

def wait_attr(page, selector, attr_name, value, timeout_ms):
    try:
        page.wait_for_function(
            "([sel, a, v]) => { const el = document.querySelector(sel);"
            " return !!el && el.getAttribute(a) === v; }",
            arg=[selector, attr_name, value], timeout=timeout_ms,
        )
        return True
    except Exception:
        return False


def attr(page, selector, name):
    loc = page.locator(selector)
    return loc.get_attribute(name) if loc.count() > 0 else None


def as_int(value):
    try:
        return int(value or 0)
    except ValueError:
        return 0


def launch_browser(p):
    """真浏览器：优先 Playwright 自带 chromium；本机未装（ms-playwright 空）时退回系统 Edge。
    两者都是真 Chromium 内核，判据不变（同 `scripts/verify-forward-baseline-ui.py` 的既有口径）。"""
    chan = os.environ.get("TATAI_UI_BROWSER_CHANNEL", "")
    if chan:
        return p.chromium.launch(headless=True, channel=chan)
    try:
        return p.chromium.launch(headless=True)
    except Exception as e:  # noqa: BLE001
        info("自带 chromium 起不来（%s），退回系统 Edge" % str(e).splitlines()[0][:120])
        return p.chromium.launch(headless=True, channel="msedge")


def run_browser(vite_port):
    os.makedirs(SHOT_DIR, exist_ok=True)
    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        base = "http://localhost:%d" % vite_port

        def shot(name):
            page.screenshot(path=os.path.join(SHOT_DIR, name))

        def wait_ready():
            page.wait_for_function(
                "() => { const el = document.querySelector('[data-version-reminder]');"
                " return !!el && el.getAttribute('data-reminder-state') !== 'loading'; }",
                timeout=60000,
            )
            page.wait_for_timeout(400)

        def ensure_card_open():
            if page.locator("[data-version-reminder-card]").count() == 0:
                page.locator("[data-reminder-entry]").click()
                page.wait_for_selector("[data-version-reminder-card]", timeout=15000)
                page.wait_for_timeout(150)

        def open_project(pid):
            page.goto("%s/#p/%s" % (base, pid), wait_until="domcontentloaded")
            page.wait_for_selector('button[data-view="arch"]', timeout=60000)
            page.wait_for_selector("[data-version-reminder]", timeout=60000)
            wait_ready()

        # ══════════ ① 入口挂在辅助入口、不新增主导航页（V09-62 的「交付总览」由该卡独占引入，非本卡）；首次自动展开一次 ══════════
        step["now"] = "① 辅助入口与首次提醒"
        open_project(A)
        main_labels = page.eval_on_selector_all(
            "nav[data-main-nav] button", "els => els.map(e => (e.innerText||'').trim())")
        ok(main_labels == MAIN_NAV,
           "① 主导航恰为既定六页（「交付总览」由 V09-62 独占引入；版本提醒挂在辅助入口，不新增 Tab；实际 %s）" % main_labels)
        ok(page.locator("nav[data-main-nav] [data-version-reminder]").count() == 0,
           "① 版本提醒不在主导航里（§3.1 辅助入口）")
        ok(page.locator('nav[data-aux-nav] button[data-view="terminal"]').count() == 1,
           "① 辅助入口的终端入口仍在（本卡没动 V06-08 的辅助入口结构）")
        ok(page.locator("[data-version-reminder]").count() == 1,
           "① 项目工作面上有且只有一个版本提醒入口")
        ok(attr(page, "[data-version-reminder]", "data-reminder-state") == "unsaved",
           "① 状态是 unsaved（工作树确有改动，不是凭空报的）")
        total = attr(page, "[data-version-reminder]", "data-reminder-total")
        ok(total == "3", "① 变更摘要里 3 个文件有改动（暂存/未暂存/未跟踪各一；实际 %s）" % total)
        ok(attr(page, "[data-version-reminder]", "data-reminder-batch-new") == "1",
           "① 新一批改动 → 标记 batch-new=1")
        ok(attr(page, "[data-version-reminder]", "data-reminder-open") == "0",
           "① **不弹窗**：新一批只把入口点亮，卡片不自动展开（轻量、不打扰；§3.15）")
        mark = page.locator("[data-reminder-batch-mark]").inner_text()
        ok("新一批" in mark and "还没保存为本地 Git 版本" in mark and "3 个文件" in mark,
           "① 入口旁一行说明写清「这批还没保存」：%s" % mark.strip()[:60])
        shot("01-reminder-entry-highlighted.png")
        ensure_card_open()
        ok(page.locator("[data-version-reminder-card]").count() == 1
           and attr(page, "[data-version-reminder]", "data-reminder-open") == "1",
           "① 点「版本提醒」→ 卡片展开（查看是用户动作，不是自动弹）")

        # ══════════ ② 卡片内容：摘要 / 文件范围 / 最后检测时间 / 成果口径 ══════════
        step["now"] = "② 卡片内容"
        summary = page.locator("[data-reminder-summary]").inner_text()
        ok("3 个文件有改动" in summary and "暂存 1" in summary and "未暂存 1" in summary
           and "未跟踪 1" in summary,
           "② 变更摘要给出四桶计数：%s" % summary.strip())
        detected = page.locator("[data-reminder-detected]").inner_text()
        ok("最后检测" in detected and "T" in detected, "② 显示最后检测时间：%s" % detected.strip())
        files = page.eval_on_selector_all(
            "[data-reminder-file]",
            "els => els.map(e => ({t: e.innerText, k: e.getAttribute('data-file-kind')}))")
        shown = [f["t"] for f in files]
        ok(any(P_SPACE_CN in t for t in shown), "② 文件范围逐字显示含空格与中文的路径 %r" % P_SPACE_CN)
        ok(any(P_STAGED in t for t in shown) and any(P_UNTRACKED in t for t in shown),
           "② 已暂存 / 未跟踪两种归属都列出来了（%d 条）" % len(shown))
        ok(sorted(f["k"] for f in files) == ["modified", "staged", "untracked"],
           "② 每条文件带机器可读的归属：%s" % [f["k"] for f in files])
        ver = page.locator("[data-reminder-verification]")
        ok(ver.get_attribute("data-verification-state") == "checks_passed",
           "② 夹具甲已提交成果且证据在册 → 口径「已通过必要检查」（实际 %s）"
           % ver.get_attribute("data-verification-state"))
        ok("已通过必要检查" in ver.inner_text() and "仍有改动" in ver.inner_text(),
           "② 该口径同时说清成果已通过检查、工作树仍有改动两件事")
        related = page.locator("[data-reminder-related]").inner_text()
        ok("sub-" in related and "…" in related,
           "② 提醒来源关联了成果 ID 与证据 ID（内容寻址哈希前缀）：%s" % related.strip()[:80])
        local_text = page.locator("[data-reminder-local-commit]").inner_text()
        ok("还没有保存为本地 Git 版本" in local_text,
           "② 本地保存状态明说未保存：%s" % local_text.strip()[:60])
        remote = page.locator("[data-reminder-remote]").inner_text()
        ok("无上游" in remote and "观测时间" in remote and "未联网" in remote,
           "② 远端只给已知跟踪状态 + 观测时间 + 未联网：%s" % remote.strip()[:80])
        ok("已同步" not in page.inner_text("body"),
           "② 无上游时整页找不到「已同步」这三个字（不做远端同步断言）")
        private = page.locator("[data-reminder-private]").inner_text()
        ok("备份状态未知" in private and "V06-14" in private,
           "② 私有事实（.工作台/）只说备份状态未知并说明原因：%s" % private.strip()[:70])
        ok(attr(page, "[data-version-reminder]", "data-reminder-backed-up") == "unknown"
           and "无法由 Git 推断" in private,
           "② 私有事实的机器可读口径只有 unknown（忽略 ≠ 已备份），且说明无法由 Git 推断")
        shot("02-reminder-card.png")

        # ══════════ ③ 重新打开项目 / 手动刷新 → 合并同一批，不重复弹窗 ══════════
        step["now"] = "③ 合并同一批"
        fp_first = attr(page, "[data-version-reminder]", "data-reminder-fingerprint")
        ok(len(fp_first or "") == 64, "③ 本批带有 64 位变更指纹：%s…" % (fp_first or "")[:12])
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("[data-version-reminder]", timeout=60000)
        wait_ready()
        ok(attr(page, "[data-version-reminder]", "data-reminder-fingerprint") == fp_first,
           "③ 重新打开项目：指纹不变（还是同一批改动）")
        merged_after_reload = as_int(attr(page, "[data-version-reminder]", "data-reminder-merged"))
        ok(merged_after_reload >= 1,
           "③ 同一批改动被合并计数（merged=%d），而不是当成第二批" % merged_after_reload)
        ok(attr(page, "[data-version-reminder]", "data-reminder-batch-new") == "0"
           and page.locator("[data-reminder-batch-mark]").count() == 0,
           "③ 合并后不再是新一批（batch-new=0，入口旁那行「新一批」说明也不再出现）")
        info("③ 重新打开后的现场：%s" % page.evaluate(
            "() => { const el = document.querySelector('[data-version-reminder]');"
            " return el ? Object.fromEntries(Array.from(el.attributes)"
            "  .filter(a => a.name.startsWith('data-reminder'))"
            "  .map(a => [a.name, a.value])) : null; }"))
        ok(attr(page, "[data-version-reminder]", "data-reminder-open") == "0",
           "③ 不每保存一个文件弹窗：同一批重新打开后不自动展开（要看得自己点）")
        ensure_card_open()
        page.wait_for_selector("[data-reminder-merged-note]", timeout=15000)
        ok("同一批改动已合并" in page.locator("[data-reminder-merged-note]").inner_text(),
           "③ 卡片里明说这批被合并了几次重复检测")
        before_merged = as_int(attr(page, "[data-version-reminder]", "data-reminder-merged"))
        page.locator("[data-reminder-refresh]").click()
        page.wait_for_timeout(1500)
        after_merged = as_int(attr(page, "[data-version-reminder]", "data-reminder-merged"))
        ok(after_merged > before_merged
           and attr(page, "[data-version-reminder]", "data-reminder-batch-new") == "0",
           "③ 手动刷新：同指纹继续合并（merged %d → %d），不产生新提醒" % (before_merged, after_merged))
        shot("03-merge-same-batch.png")

        # ══════════ ④ 稍后提醒只对这批；新成果不被旧暂缓吞掉 ══════════
        step["now"] = "④ 稍后提醒与不被旧暂缓吞掉"
        ensure_card_open()
        page.locator("[data-reminder-snooze]").click()
        page.wait_for_timeout(500)
        ok(attr(page, "[data-version-reminder]", "data-reminder-snoozed") == "1",
           "④ 点稍后提醒 → 状态标记 snoozed=1")
        ok(attr(page, "[data-version-reminder]", "data-reminder-open") == "0",
           "④ 暂缓后卡片收起（不再占视野）")
        ok("暂缓" in page.locator("[data-reminder-badge]").inner_text(),
           "④ 入口徽标显示暂缓，不是凭空消失（用户知道有东西被压住了）")
        ok(page.locator("[data-reminder-batch-mark]").count() == 0,
           "④ 暂缓后入口旁那行「新一批」说明也收起（暂缓 = 这批不再出声）")
        ok(attr(page, "[data-version-reminder]", "data-reminder-snoozed-fingerprints") == fp_first,
           "④ 暂缓记录的是当前这批的指纹（只对这批生效）")
        page.reload(wait_until="domcontentloaded")
        page.wait_for_selector("[data-version-reminder]", timeout=60000)
        wait_ready()
        ok(attr(page, "[data-version-reminder]", "data-reminder-snoozed") == "1",
           "④ 刷新后同一批仍是暂缓（不每刷新一次就吵一次）")
        # 新成果：写一个新文件（真实文件系统 + 文件监听 → SSE → 重新探测）
        write(os.path.join(FIXTURE_ROOTS[A], P_LATER), "新成果：后来又加的一个文件\n")
        for _ in range(60):
            page.wait_for_timeout(500)
            if attr(page, "[data-version-reminder]", "data-reminder-total") == "4":
                break
        cur_total = attr(page, "[data-version-reminder]", "data-reminder-total")
        cur_fp = attr(page, "[data-version-reminder]", "data-reminder-fingerprint")
        ok(cur_total == "4",
           "④ 新成果被探测到（文件数 3 → %s；触发链：写文件 → 监听 → SSE → 重新探测）" % cur_total)
        ok(cur_fp != fp_first,
           "④ 新一批的指纹与旧的不同（%s… ≠ %s…）" % ((cur_fp or "")[:8], (fp_first or "")[:8]))
        ok(attr(page, "[data-version-reminder]", "data-reminder-snoozed") == "0",
           "④ 新成果不被旧的稍后提醒吞掉：旧暂缓只压住旧指纹，新一批重新露面")
        ok(attr(page, "[data-version-reminder]", "data-reminder-batch-new") == "1",
           "④ 新一批被标成 batch-new=1（不是混进旧批次）")
        ok(page.locator("[data-reminder-batch-mark]").count() == 1
           and "新一批" in page.locator("[data-reminder-batch-mark]").inner_text(),
           "④ 新一批重新点亮入口并给出说明行（旧暂缓压不住它）")
        shot("04-new-batch-not-swallowed.png")

        # ══════════ ⑤ 查看 + 复制给执行 Agent 的整理说明 ══════════
        step["now"] = "⑤ 查看与复制"
        ensure_card_open()
        page.locator("[data-reminder-view]").click()
        page.wait_for_selector("[data-reminder-agent-note]", timeout=15000)
        note = page.locator("[data-reminder-agent-note]").inner_text()
        ok("变更指纹" in note and P_LATER in note,
           "⑤ 查看能读到完整整理说明（含变更指纹与新增文件路径）")
        page.locator("[data-reminder-copy]").click()
        page.wait_for_selector("[data-reminder-copied-notice]", timeout=15000)
        copied_notice = page.locator("[data-reminder-copied-notice]").inner_text()
        ok("已复制" in copied_notice, "⑤ 复制给执行 Agent 有明确回执：%s" % copied_notice.strip())
        copied_text = page.locator("[data-reminder-agent-note]").inner_text()
        ok("塔台**没有**替你执行任何 Git 写操作" in copied_text
           and "git add" not in copied_text and "git commit" not in copied_text,
           "⑤ 复制出去的内容明说塔台没执行 Git 写操作，也不夹带 git 写命令")
        ok(page.evaluate("() => document.querySelectorAll('[data-reminder-copy-fallback]').length") == 0,
           "⑤ 复制用的临时 textarea 已收走（不留在页面 DOM 里）")
        shot("05-copy-note.png")

        # ══════════ ⑥ 没有成果提交的项目 → 未验证，且不称稳定成果 ══════════
        step["now"] = "⑥ 未验证口径"
        open_project(B)
        ok(attr(page, "[data-version-reminder]", "data-reminder-state") == "unsaved",
           "⑥ 乙项目也有未保存改动（它自己的一批）")
        ensure_card_open()
        b_files = page.eval_on_selector_all("[data-reminder-file]", "els => els.map(e => e.innerText)")
        ok(any(P_B in t for t in b_files), "⑥ 乙项目列的是它自己的文件（%r）" % P_B)
        ok(not any(P_SPACE_CN in t for t in b_files), "⑥ 乙项目里没有甲项目的文件（提醒按项目隔离）")
        ok(attr(page, "[data-version-reminder]", "data-reminder-snoozed") == "0",
           "⑥ 甲的稍后提醒不影响乙（暂缓按项目 + 指纹分桶）")
        ver_b = page.locator("[data-reminder-verification]")
        ok(ver_b.get_attribute("data-verification-state") == "unverified",
           "⑥ 乙没有对应成果提交 → 口径「未验证」（实际 %s）" % ver_b.get_attribute("data-verification-state"))
        ok("不是稳定成果" in ver_b.inner_text(),
           "⑥ 未验证改动不被称为稳定成果：%s" % ver_b.inner_text()[:70])
        ok(attr(page, "[data-version-reminder]", "data-reminder-fingerprint") != cur_fp,
           "⑥ 乙的指纹与甲不同（各记各的）")
        shot("06-unverified-project.png")

        # ══════════ ⑦ 不是仓库 → 明说未使用 Git，且不给初始化入口 ══════════
        step["now"] = "⑦ 未使用 Git"
        open_project(C)
        ok(attr(page, "[data-version-reminder]", "data-reminder-is-repository") == "0",
           "⑦ 非 git 项目：is_repository=0")
        ok(attr(page, "[data-version-reminder]", "data-reminder-state") == "unknown",
           "⑦ 本地版本状态是 unknown（不是已保存）")
        ok("未使用 Git" in page.locator("[data-reminder-badge]").inner_text(),
           "⑦ 入口徽标直接写「未使用 Git」（不装成 0 个改动）")
        ok(attr(page, "[data-version-reminder]", "data-reminder-open") == "0",
           "⑦ 未使用 Git 也不自动弹卡片（不打扰）")
        ensure_card_open()
        ok(page.locator("[data-reminder-not-git]").count() == 1,
           "⑦ 卡片明说未使用 Git：%s" % page.locator("[data-reminder-not-git]").inner_text().strip()[:60])
        body_text = page.inner_text("body")
        # 判据落在**可点的入口**上：卡片里那句"不擅自初始化仓库"是说明文字，不是入口。
        init_entries = page.eval_on_selector_all(
            "button, a",
            "els => els.filter(e => /初始化|创建仓库|git init/.test(e.innerText||'')).length")
        ok(init_entries == 0 and "git init" not in body_text,
           "⑦ 不擅自初始化：没有任何初始化仓库的按钮或链接（屏幕上只有一句「不擅自初始化」的说明）")
        ok(os.path.exists(os.path.join(FIXTURE_ROOTS[C], ".git")) is False,
           "⑦ 该目录里确实仍无 .git（塔台没有替它建过仓库）")
        ok(all(w not in body_text for w in ("提交到 Git", "推送到", "git commit", "git push")),
           "⑦ 页面上没有任何 Git 写动作入口（不自动 add/commit/push）")
        shot("07-not-a-repository.png")

        # ══════════ ⑧ 只读红线：探测前后夹具仓库的 HEAD / 索引 / 工作树逐项相同 ══════════
        step["now"] = "⑧ 只读对照"
        after_a = repo_fingerprint(FIXTURE_ROOTS[A])
        before_a = GIT_BEFORE[A]
        ok(before_a["head"] == after_a["head"] and before_a["head"] != "",
           "⑧ 甲仓库 HEAD 未变（%s…；探测前后同一提交）" % before_a["head"][:12])
        ok(before_a["index_listing"] == after_a["index_listing"],
           "⑧ 甲仓库索引登记内容未变（git ls-files -s 输出哈希 %s…）" % before_a["index_listing"][:12])
        ok(before_a["index_file"] == after_a["index_file"] and before_a["index_size"] == after_a["index_size"]
           and before_a["index_mtime"] == after_a["index_mtime"],
           "⑧ 甲仓库 .git/index 字节/大小/时间一字未动（%d 字节）" % before_a["index_size"])
        ok(before_a["refs"] == after_a["refs"], "⑧ 甲仓库本地引用清单未变")
        # 工作树：唯一被允许多出来的文件是本脚本自己写进去的新成果（P_LATER），其余必须一模一样
        b_before, b_after = GIT_BEFORE[B], repo_fingerprint(FIXTURE_ROOTS[B])
        ok(b_before == b_after, "⑧ 乙仓库 HEAD/索引/工作树/引用逐项未变（%s…）" % b_before["head"][:12])
        c_before, c_after = GIT_BEFORE[C], repo_fingerprint(FIXTURE_ROOTS[C])
        ok(c_before == c_after and not c_after["has_git"],
           "⑧ 非 git 目录：连一个 .git 都没被建出来，工作树内容未变")
        ok(not os.path.exists(os.path.join(FIXTURE_ROOTS[A], ".git", "index.lock")),
           "⑧ 没有留下 .git/index.lock（探测没取索引锁）")
        shot("08-read-only-unchanged.png")

        ok(not page_errors, "⑨ 全程无页面 JS 异常（实际 %s）" % page_errors[:2])
        browser.close()


# ══════════════════════════════ 主流程 ══════════════════════════════

def main():
    home = tempfile.mkdtemp(prefix="tatai-v0612-ui-home-")
    work = tempfile.mkdtemp(prefix="tatai-v0612-ui-proj-")
    os.makedirs(SHOT_DIR, exist_ok=True)
    logs = os.path.join(SHOT_DIR, "server.log")
    for f in ("server.log", "vite.log"):
        try:
            os.remove(os.path.join(SHOT_DIR, f))
        except FileNotFoundError:
            pass
    backend = None
    vite = None
    try:
        root_a = os.path.join(work, "a")
        root_b = os.path.join(work, "b")
        root_c = os.path.join(work, "c")
        FIXTURE_ROOTS.update({A: root_a, B: root_b, C: root_c})

        # ── 夹具甲：真 git 仓库 + 暂存/未暂存/未跟踪三种改动（含空格与中文路径），无上游 ──
        make_repo(root_a, P_SPACE_CN)
        write(os.path.join(root_a, P_SPACE_CN), "改了内容（工作树）\n")   # → modified
        write(os.path.join(root_a, P_STAGED), "新文件但已暂存\n")
        git(root_a, ["add", "--", P_STAGED])                              # → staged
        write(os.path.join(root_a, P_UNTRACKED), "还没 add\n")            # → untracked
        make_project_facts(root_a, [("T-1", "甲：导入能力")])
        write(os.path.join(root_a, ".工作台", "plan.md"), plan_md("夹具·甲 施工图", [("T-1", "甲：导入能力")]))

        # ── 夹具乙：真 git 仓库 + 一处改动，没有成果提交（用来验未验证口径） ──
        make_repo(root_b, P_B)
        write(os.path.join(root_b, P_B), "乙改了内容\n")

        # ── 夹具丙：普通目录（不是仓库，不许被初始化） ──
        os.makedirs(root_c, exist_ok=True)
        write(os.path.join(root_c, "README.md"), "# 不是仓库\n")
        write(os.path.join(root_c, ".工作台", "tasks.json"), '{"version":1,"tasks":[]}\n')

        make_registry(home, [
            {"id": A, "name": "夹具·甲", "path": root_a, "kind": "fullstack",
             "registered_at": "2026-09-20T08:00:00+08:00", "last_opened_at": "2026-09-20T08:00:00+08:00"},
            {"id": B, "name": "夹具·乙", "path": root_b, "kind": "backend",
             "registered_at": "2026-09-20T08:00:00+08:00", "last_opened_at": "2026-09-20T08:00:00+08:00"},
            {"id": C, "name": "夹具·无 git", "path": root_c, "kind": "static",
             "registered_at": "2026-09-20T08:00:00+08:00", "last_opened_at": "2026-09-20T08:00:00+08:00"},
        ])

        backend_port = free_port()
        backend = Backend(home, backend_port, logs)
        backend.wait_health()
        info("后端就绪：http://127.0.0.1:%d（隔离 TATAI_HOME %s）" % (backend_port, home))

        # ── 夹具甲的成果事实：经真实 v2 写入服务提交（定义绑定 → 结果提交 + 证据正文） ──
        status, body = backend.api("/api/projects/%s/plan" % A)
        if status != 200:
            raise RuntimeError("读 plan 失败 HTTP %s：%s" % (status, str(body)[:200]))
        plan = body["plan"]
        backend.wo_command(cmd(A, "task:T-1", "task.definition_imported",
                               {"definition_sha256": plan["definition_hashes"]["T-1"],
                                "plan_revision": plan["content_sha256"], "definition_revision": 1},
                               "T-1:def:v0612ui", expected=None))
        sha_ok = put_evidence(root_a, "夹具证据：T-1 自检输出\nexit 0\n", "T-1 自检输出（夹具）", "self_check")
        # 补修包 D：要判「已通过必要检查」，光有"相关提交 + 证据在册"不够——还要有**真实通过结果**
        # （检查记录）、覆盖**声明范围**（现场改动 ∪ 成果声明）、证据在册、绑定**当前实际内容版本
        # （含未提交改动）**。这里按产品的**同一实现**算内容版本指纹（不重抄算法），再记真实自检记录。
        a_paths = [P_SPACE_CN, P_STAGED, P_UNTRACKED]
        fp_a = content_fingerprint(root_a, a_paths)
        sha_chk = put_evidence(root_a, "夹具证据：T-1 自检输出（绑定当前内容版本）\nexit 0\n",
                               "T-1 自检输出（夹具·内容版本）", "self_check")
        backend.wo_command(cmd(A, "submission:sub-T-1", "audit.submission_submitted", {
            "goal": "甲：导入能力交付", "task_id": "T-1", "round": 1, "baseline": {},
            # changed_files 与工作树里的改动**同名**：提醒据此把成果与这批改动关联起来
            "changed_files": a_paths,
            "commands": [{"command": "pnpm test import", "exit_code": 0, "output_ref": None}],
            "untested": [], "known_issues": [], "evidence_refs": [sha_ok],
            "binding": {"revision_kind": "code", "revision": fp_a},
            "submitted_by": "fixture-agent",
        }, "sub-T-1:v0612ui", expected=None))
        # 检查记录走**真实写入面**：两条必需检查（正文验收项 + 完成证据要求）都覆盖全部改动路径，
        # 证据在册，绑定当前内容版本指纹 → 判定才可能是 checks_passed
        backend.wo_command(cmd(A, "check:T-1-self-1", "audit.self_check_recorded", {
            "task_id": "T-1", "round": 1, "checked_by": "fixture-agent",
            "checks": [
                {"check_id": "T-1::check:0", "method": "跑夹具检查命令", "command": "pnpm test import",
                 "exit_code": 0, "output_ref": None, "evidence_sha256": sha_chk, "scope": a_paths, "verifies": "code"},
                {"check_id": "T-1::evidence", "method": "收齐完成证据", "command": None,
                 "exit_code": None, "output_ref": None, "evidence_sha256": sha_chk, "scope": a_paths, "verifies": "code"},
            ],
            "conclusion": "pass",
            "binding": {"revision_kind": "code", "revision": fp_a},
        }, "T-1:self:v0612ui", expected=None))
        info("夹具成果事实已提交（定义绑定 + 结果提交 + 真实自检记录，绑定当前内容版本 %s…）" % fp_a[:12])

        # 探测之前的只读判据（结束前对照）
        for pid, root in FIXTURE_ROOTS.items():
            GIT_BEFORE[pid] = repo_fingerprint(root)

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
            print("[ui] 保留现场：%s / %s" % (home, work))
        else:
            for d in (home, work):
                shutil.rmtree(d, ignore_errors=True)

    print("[ui] 合计 PASS %d / FAIL %d" % (passes[0], len(fails)))
    for f in fails:
        print("[ui]   FAIL " + f)
    print("[ui] 截图目录：%s" % SHOT_DIR)
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
