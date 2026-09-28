#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-06 私有事实备份/恢复**产品入口**的浏览器场景验证（Python + Playwright）。

用法：python scripts/verify-v09-06-ui.py
      （或 pnpm verify:v09-06-ui；V0906_SHOT_DIR 换截图目录、V0906_KEEP_TMP=1 保留现场）

why 必须跑真浏览器（PLAN.md V09-06 检查项 / 第 3 轮返工缺陷 A、B、D）：
  · **缺陷 A（界面现场）**：在自定义位置建完备份后，详情读的是 `listParent` 这个 React state 里
    **还没更新**的旧位置。默认目录恰有同名 backupId 时，界面会静默显示**另一份**——不报错、也和
    刚建的清单对不上。这种事只有真 DOM + 真 HTTP + 真盘上文件才验得出来：渲染函数级断言看不见
    "闭包抓旧值 / 回包晚到"。修后判据：详情里的 `data-backup-detail-location` 必须**就是刚建的那个位置**；
    换位置 / 重开页面（界面现场归零）后旧回包不许覆盖。
  · **缺陷 B（文案）**：`**` 这类 Markdown 记号会被 React 逐字渲染到页面上（截图可见）。
    判据落在**页面渲染出来的文字**上：面板与版本提醒卡片里都不许出现字面 `**`。
  · **缺陷 D（如实告警）**：自定义目录里**只剩损坏/不可归属条目**时，不能一边说"这里没有备份"、
    一边把损坏这件事藏起来。判据：'data-backup-empty-skipped' 的醒目告警在，且逐条给出跳过原因。

隔离口径（AGENTS.md §5 / 本卡红线）：
  · 临时 `TATAI_HOME` + `tempfile` 下的夹具项目，**绝不碰**真实注册表与三个真实项目的 `.工作台/`；
  · 夹具事实经**真实 v2 写入服务**（`POST /api/work/command`）提交，备份/恢复全走**真实 HTTP 路由**；
  · 收尾杀净后端与 vite、删临时目录（V0906_KEEP_TMP=1 可留现场）。
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
    "V0906_SHOT_DIR", os.path.join(REPO, ".工作台", "evidence", "V09-06", "1", "fix3-shots")
)
KEEP = os.environ.get("V0906_KEEP_TMP") == "1"
PID = "v0906ui-main"

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


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return path


def http(url, method="GET", body=None, timeout=180, headers=None):
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


def same_path(a, b):
    """两个绝对路径指的是不是同一个目录（Windows 大小写与分隔符不敏感）"""
    if not a or not b:
        return False
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


# ══════════════════════════════ 夹具（tempfile 内） ══════════════════════════════

def plan_md(title, cards):
    rows = "\n".join("| %s | todo | %s | | %s |" % (cid, goal, goal + "验收") for cid, goal in cards)
    sections = "\n".join(
        "### %s %s\n\n**设计依据**：§8.5。**依赖**：无。\n\n**文件责任**：`src/x.ts`。\n\n"
        "- [ ] %s 的验收检查项一\n\n**交付**：%s。\n" % (cid, goal, cid, goal)
        for cid, goal in cards
    )
    return ("# %s\n\n> 夹具施工图。\n\n## 当前任务\n\n"
            "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |\n| --- | --- | --- | --- | --- |\n%s\n\n%s\n"
            % (title, rows, sections))


def make_registry(home, records):
    write(os.path.join(home, "registry.json"),
          json.dumps({"version": 1, "projects": records}, ensure_ascii=False, indent=2) + "\n")


def make_fixture(root):
    """夹具项目：一个非 Git 目录 + `.工作台` 的设计书/施工图（真事实经 v2 写入服务提交）"""
    proj = os.path.join(root, "work", PID)
    write(os.path.join(proj, ".工作台", "design.md"), "# 备份入口界面夹具\n\n## 1 目标\n\n真浏览器验收。\n")
    write(os.path.join(proj, ".工作台", "plan.md"),
          plan_md("备份入口界面夹具施工图", [("K-1", "一致备份的提交边界"), ("K-2", "隔离恢复与核验")]))
    write(os.path.join(proj, ".工作台", "logs", "terminal-history.jsonl"),
          '{"cmd":"pnpm build","at":"2026-09-24T09:00:00.000Z"}\n')
    home = os.path.join(root, "home")
    os.makedirs(home, exist_ok=True)
    now = "2026-09-24T09:00:00+08:00"
    make_registry(home, [{
        "id": PID, "name": "备份入口界面夹具 v0906ui-main", "path": proj, "kind": "backend",
        "registered_at": now, "last_opened_at": now,
    }])
    return home, proj


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

    def api(self, path, method="GET", body=None, headers=None, timeout=180):
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
            with urllib.request.urlopen("http://localhost:%d/" % port, timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("vite %d 未就绪" % port)


def cmd(project, entity, type_, payload, key, expected=None):
    return {
        "schema_version": 2, "project_id": project, "change_id": "v0906ui",
        "entity_id": entity, "expected_revision": expected, "type": type_,
        "actor_id": "fixture", "role": "agent", "idempotency_key": key, "payload": payload,
    }


def seed_events(backend):
    """经**真实 v2 写入服务**提交两条任务定义绑定（备份的"事件提交边界"必须有真事件撑着）。"""
    status, body = backend.api("/api/projects/%s/plan" % PID)
    if status != 200:
        raise RuntimeError("读 plan 失败 HTTP %s：%s" % (status, str(body)[:200]))
    plan = body["plan"]
    ids = [d["task_id"] for d in plan["definitions"]]
    for tid in ids:
        backend.wo_command(cmd(PID, "task:%s" % tid, "task.definition_imported",
                               {"definition_sha256": plan["definition_hashes"][tid],
                                "plan_revision": plan["content_sha256"], "definition_revision": 1},
                               "%s:def:v0906ui" % tid))
    return ids


def markdown_hits(text):
    """页面渲染出来的文字里逐行找字面 `**`（缺陷 B 的判据就是"用户到底看见什么"）"""
    return [ln.strip() for ln in text.splitlines() if "**" in ln]


# ══════════════════════════════ 浏览器断言 ══════════════════════════════

def run_browser(vite_port, home, custom1, restore_parent, broken):
    os.makedirs(SHOT_DIR, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1500, "height": 980}).new_page()
        page.set_default_timeout(45000)
        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        base = "http://localhost:%d" % vite_port

        def shot(name):
            page.screenshot(path=os.path.join(SHOT_DIR, name), full_page=True)

        def attr(sel, name):
            loc = page.locator(sel)
            return loc.get_attribute(name) if loc.count() > 0 else None

        def wait_sel(sel, timeout_ms=45000):
            try:
                page.wait_for_selector(sel, timeout=timeout_ms)
                return True
            except Exception:
                return False

        def wait_attr(sel, name, value, timeout_ms=45000):
            try:
                page.wait_for_function(
                    "([s,a,v]) => { const el = document.querySelector(s);"
                    " return !!el && el.getAttribute(a) === v; }",
                    arg=[sel, name, value], timeout=timeout_ms)
                return True
            except Exception:
                return False

        def open_info():
            """打开项目并切到「项目信息」（辅助入口，不新增导航页签）"""
            page.goto("%s/#p/%s" % (base, PID), wait_until="domcontentloaded")
            enter_info()

        def reload_info():
            """重开页面 = 界面现场归零（`listParent` 回到默认落点）。
            必须是**真的**一次文档加载：`page.goto` 到同一个 URL 不一定重载，所以这里用 `page.reload`。"""
            page.reload(wait_until="domcontentloaded")
            enter_info()

        def enter_info():
            page.wait_for_selector('button[data-view="arch"]', timeout=60000)
            page.locator('button[data-view="overview"]').click()
            page.wait_for_selector("[data-backup-panel]", timeout=60000)
            page.wait_for_timeout(400)

        def fill_location_and_create(loc):
            page.locator("[data-backup-location-input]").fill(loc)
            page.locator("[data-backup-create]").click()
            page.wait_for_selector("[data-backup-created]", timeout=90000)
            page.wait_for_timeout(600)

        def detail_location():
            return attr("[data-backup-detail-location]", "data-backup-detail-location")

        # ══════════ ① 入口挂载 + 文案（缺陷 B） ══════════
        step["now"] = "① 入口挂载与文案"
        open_info()
        ok(page.locator("[data-backup-panel]").count() == 1,
           "① 「项目信息」页里有且只有一个备份面板（不新增导航页签）")
        panel_text = page.locator("[data-backup-panel]").inner_text()
        hits = markdown_hits(panel_text)
        ok(not hits, "① 面板渲染出来的文字里没有字面 `**`（Markdown 记号不许逐字上屏；命中 %d 行：%s）"
           % (len(hits), hits[:2]))
        ok(page.locator("[data-backup-location-input]").count() == 1
           and page.locator("[data-backup-create]").count() == 1,
           "① 位置输入框与「立即备份」按钮都在（数据落点由用户选）")

        # 版本提醒卡片（同一页的辅助入口）渲染出来的文字同样不许带 `**`
        page.wait_for_selector("[data-reminder-entry]", timeout=60000)
        page.wait_for_function(
            "() => { const el = document.querySelector('[data-version-reminder]');"
            " return !!el && el.getAttribute('data-reminder-state') !== 'loading'; }", timeout=60000)
        if page.locator("[data-version-reminder-card]").count() == 0:
            page.locator("[data-reminder-entry]").click()
            page.wait_for_selector("[data-version-reminder-card]", timeout=20000)
        card_text = page.locator("[data-version-reminder-card]").inner_text()
        card_hits = markdown_hits(card_text)
        ok(not card_hits, "① 版本提醒卡片渲染出来的文字里没有字面 `**`（命中 %d 行：%s）"
           % (len(card_hits), card_hits[:2]))
        page.locator("[data-reminder-entry]").click()  # 收起来，别挡住后面的截图
        page.wait_for_timeout(200)
        shot("fix3-ui-01-entry-and-panel.png")

        # ══════════ ② 自定义位置建备份 → 详情必须读**刚落这一份**的位置（缺陷 A） ══════════
        step["now"] = "② 创建后详情读取刚落位置"
        fill_location_and_create(custom1)
        created_id = attr("[data-backup-created]", "data-backup-created")
        ok(bool(created_id), "② 创建回执给出备份 id：%s" % created_id)
        ok(same_path(attr("[data-backup-list-root]", "data-backup-list-root"), custom1),
           "② 清单跟着落到用户选的位置（data-backup-list-root=%s）"
           % attr("[data-backup-list-root]", "data-backup-list-root"))
        ok(attr("[data-backup-list-default]", "data-backup-list-default") == "0",
           "② 清单自述「不是默认落点」（data-backup-list-default=0）")
        ok(wait_sel("[data-backup-detail-location]", 60000),
           "② 创建之后界面上出现了这一份的详情（data-backup-detail-location）")
        loc = detail_location()
        ok(same_path(loc, custom1),
           "② **创建后详情读的就是刚建的那个位置**（data-backup-detail-location=%s；期望 %s）" % (loc, custom1))
        detail_text = page.locator("[data-backup-detail]").inner_text() if page.locator("[data-backup-detail]").count() else ""
        ok("你选的位置" in detail_text, "② 详情文案如实说「你选的位置」（不是「塔台数据目录下的默认落点」）")
        shot("fix3-ui-02-created-custom.png")

        # 把这一份复制进**默认落点**：默认目录里出现**同名**的另一个 backupId（缺陷 A 最狠的那种现场：
        # 旧闭包读默认位置不会 404，而是静默读到"另一份"）
        default_root = os.path.join(home, "backups", PID)
        copied = os.path.join(default_root, created_id)
        if os.path.exists(copied):
            shutil.rmtree(copied)
        shutil.copytree(os.path.join(custom1, created_id), copied)
        ok(os.path.isdir(copied), "② 反例前提：默认落点里放了一份**同名**的 %s（%s）" % (created_id, default_root))

        # ══════════ ③ 同名默认备份在场 + 页面重开（界面现场归零）后创建 → 详情仍读自定义位置 ══════════
        step["now"] = "③ 同名默认备份反例"
        reload_info()  # 重开页面 = 界面状态归零（listParent 回到默认落点）
        ok(page.locator("[data-backup-created]").count() == 0
           and page.locator("[data-backup-location-input]").input_value() == ""
           and attr("[data-backup-list-default]", "data-backup-list-default") == "1",
           "③ 反例前提：重开页面后界面现场真的归零（回执清掉、位置输入空、清单回到默认落点）")
        fill_location_and_create(custom1)
        created_id2 = attr("[data-backup-created]", "data-backup-created")
        ok(created_id2 == created_id,
           "③ 第二次创建复用同一份 id（幂等键 = 截止序号 + 内容指纹）：%s" % created_id2)
        page.wait_for_timeout(800)
        loc3 = detail_location()
        ok(same_path(loc3, custom1),
           "③ 默认目录里有**同名**备份时，创建后详情**仍**读自定义位置（实际 %s）——旧闭包读旧位置会静默显示另一份" % loc3)
        detail3 = page.locator("[data-backup-detail]").inner_text() if page.locator("[data-backup-detail]").count() else ""
        ok("你选的位置" in detail3 and "塔台数据目录下的默认落点" not in detail3.split("恢复")[0],
           "③ 详情文案没有把这份说成默认落点的那一份")
        shot("fix3-ui-03-same-id-in-default.png")

        # ══════════ ④ 重开页面 + 重新选目录 → 列出并打开自定义位置那一份（重启后照样找得回） ══════════
        step["now"] = "④ 重启后重新选目录"
        reload_info()
        page.locator("[data-backup-location-input]").fill(custom1)
        page.locator("[data-backup-query]").click()
        ok(wait_attr("[data-backup-list-root]", "data-backup-list-root", custom1),
           "④ 重开页面后按**用户重新选的位置**列出清单（data-backup-list-root=%s）" % custom1)
        row = "[data-backup-row='%s']" % created_id
        ok(page.locator(row).count() == 1, "④ 清单里有那一份（%s）" % created_id)
        page.locator(row).first.click()
        ok(wait_attr("[data-backup-detail-location]", "data-backup-detail-location", custom1),
           "④ 点开它，详情读的是这个自选位置（不是默认落点），且**没打开过**默认落点里的同名那一份")
        ok(not same_path(attr("[data-backup-detail-location]", "data-backup-detail-location"), default_root),
           "④ 详情落点不是默认落点（另一份同名备份还在默认目录里躺着：%s）" % default_root)
        shot("fix3-ui-04-restart-reselect.png")

        # ══════════ ⑤ 隔离恢复：只落隔离目录、replaced 恒 false ══════════
        step["now"] = "⑤ 隔离恢复"
        page.locator("[data-backup-restore-input]").fill(restore_parent)
        page.locator("[data-backup-restore]").click()
        got = wait_sel("[data-backup-restore-result]", timeout_ms=180000)
        ok(got, "⑤ 隔离恢复给出结果块（data-backup-restore-result）")
        ok(attr("[data-backup-replaced]", "data-backup-replaced") == "false",
           "⑤ replaced **false**（塔台不自动替换当前数据；实际 %s）" % attr("[data-backup-replaced]", "data-backup-replaced"))
        dest = attr("[data-backup-restore-result]", "data-backup-restore-result")
        ok(bool(dest) and os.path.isdir(os.path.join(dest, ".工作台", "work")),
           "⑤ 隔离目录真的落在用户选的位置下、且事件目录在（%s）" % dest)
        ok(bool(dest) and os.path.normcase(os.path.abspath(dest)).startswith(
            os.path.normcase(os.path.abspath(restore_parent))),
           "⑤ 隔离目录在用户选的恢复位置里，不在原项目里")
        shot("fix3-ui-05-isolated-restore.png")

        # ══════════ ⑥ 只剩损坏/不可归属条目 → 醒目告警 + 逐条原因（缺陷 D） ══════════
        step["now"] = "⑥ 只剩坏条目时的告警"
        page.locator("[data-backup-location-input]").fill(broken)
        page.locator("[data-backup-query]").click()
        ok(wait_attr("[data-backup-list-root]", "data-backup-list-root", broken),
           "⑥ 清单切到那个「只剩坏条目」的位置")
        skipped_count = attr("[data-backup-empty-skipped]", "data-backup-empty-skipped")
        ok(skipped_count == "3", "⑥ 出现**醒目告警**并报出被跳过的条目数（data-backup-empty-skipped=%s，期望 3）"
           % skipped_count)
        warn = page.locator("[data-backup-empty]").inner_text() if page.locator("[data-backup-empty]").count() else ""
        ok("跳过" in warn and "清单读不出来" in warn,
           "⑥ 告警里如实说了「有条目被跳过」且点名「清单读不出来」（不把损坏藏起来）")
        ok("b-00000001-aaaaaaaaaaaa" in warn and "b-00000002-bbbbbbbbbbbb" in warn,
           "⑥ 逐个点名被跳过的条目（坏清单那份与没有清单那份都在）")
        ok(page.locator("[data-backup-skipped-item]").count() == 3,
           "⑥ 每条都给原因（data-backup-skipped-item 共 %d 条）" % page.locator("[data-backup-skipped-item]").count())
        ok("这个位置里没有本项目自己的备份" not in warn,
           "⑥ 不再同时说「这里没有本项目自己的备份」而不提损坏（缺陷 D 的原现场）")
        shot("fix3-ui-06-broken-only-warning.png")

        # ══════════ ⑦ 收尾自证：全程没有页面 JS 错误 ══════════
        step["now"] = "⑦ 收尾"
        ok(len(page_errors) == 0, "⑦ 全程零页面 JS 错误（%s）" % (page_errors[:2] or "无"))
        info("截图目录：%s" % SHOT_DIR)
        browser.close()


def main():
    root = tempfile.mkdtemp(prefix="tatai-v0906ui-")
    home, proj = make_fixture(root)
    custom1 = os.path.join(root, "用户自选备份位置")
    restore_parent = os.path.join(root, "用户自选恢复位置")
    broken = os.path.join(root, "只剩坏条目的位置")
    for d in (custom1, restore_parent, broken):
        os.makedirs(d, exist_ok=True)
    # 缺陷 D 的现场：有清单文件却读不出来（多半是损坏的那一份）、压根没有清单、不是目录
    write(os.path.join(broken, "b-00000001-aaaaaaaaaaaa", "backup-manifest.json"), "{ 这不是 JSON：清单坏了\n")
    write(os.path.join(broken, "b-00000002-bbbbbbbbbbbb", "workbench", "work", "events.jsonl"), "\n")
    write(os.path.join(broken, "随手放的一个文件.txt"), "不是目录\n")

    backend = None
    vite = None
    try:
        os.makedirs(os.path.join(SHOT_DIR), exist_ok=True)
        backend_port = free_port()
        info("临时根：%s（TATAI_HOME=%s，项目=%s）" % (root, home, proj))
        backend = Backend(home, backend_port, os.path.join(SHOT_DIR, "backend.log"))
        backend.wait_health()
        ids = seed_events(backend)
        info("后端就绪：http://127.0.0.1:%d（夹具任务 %s 的事件已由真实 v2 写入服务提交）" % (backend_port, ids))

        vite_port = free_port()
        vite = start_vite(vite_port, backend_port, os.path.join(SHOT_DIR, "vite.log"))
        info("vite 就绪：http://localhost:%d（代理 → %d）" % (vite_port, backend_port))

        run_browser(vite_port, home, custom1, restore_parent, broken)
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
            info("保留现场：%s（V0906_KEEP_TMP=1）" % root)
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
