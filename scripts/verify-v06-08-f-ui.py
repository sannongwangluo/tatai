#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""补修包 F 的**浏览器**验证（Python + Playwright）：可体验运行入口在真 DOM 里的行为。

用法：python scripts/verify-v06-08-f-ui.py
      （或 pnpm verify:v06-08-f-ui；V0608F_KEEP_TMP=1 保留临时夹具现场）

为什么必须跑真浏览器：本包要证的三件事只有在真 DOM 上才算数——
  ① **用户还没验收时**，验收页就已经展示成果登记里的可体验入口（入口不是验收记录派生的）；
  ② 没有入口时页面写"尚不可体验"、登记过但失效/过期的**逐条说明状态**（不静默消失）；
  ③ 点"打开入口"是受控打开（协议白名单 + 浏览器降级到新标签页），而且**不产生任何"已接受"记录**
     （页面状态、计数、后端事件三处都要能对上）。

隔离口径（照 `verify-v06-08-ui.py`）：
  · 临时 TATAI_HOME + `tempfile` 下一个夹具项目，**绝不碰**三个真实项目的 `.工作台/`；
  · 夹具事实全部经**真实 v2 写入服务**（`POST /api/work/command`）提交，证据正文按内容寻址；
  · 收尾杀净子进程、删临时目录（V0608F_KEEP_TMP=1 可留现场）。

复用：夹具/后端/vite 的构造与断言小工具从 `scripts/verify-v06-08-ui.py` 里 **import**（不复制一份），
本脚本只写自己的场景与断言。
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

# 复用 `verify-v06-08-ui.py` 时不让 Python 往 `scripts/` 里写 `__pycache__/`（那是**仓库里的垃圾文件**，
# 而且 `__pycache__` 没进 .gitignore，跑一次验证就会在工作树里多出一个未跟踪目录）。
sys.dont_write_bytecode = True

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(SCRIPTS, ".."))

# 复用 V06-08 UI 脚本里的夹具/后端工具（文件名带短横线，用 importlib 按路径加载）
_spec = importlib.util.spec_from_file_location("v0608ui", os.path.join(SCRIPTS, "verify-v06-08-ui.py"))
v0608ui = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(v0608ui)

PROJECT = "v0608f-ui-a"
KEEP = os.environ.get("V0608F_KEEP_TMP") == "1"
SHOT_DIR = os.path.join(REPO, ".工作台", "verify", "v06-08-f")

fails = []
passes = [0]


def ok(cond, label):
    print(("[ui-f] PASS " if cond else "[ui-f] FAIL ") + label)
    if cond:
        passes[0] += 1
    else:
        fails.append(label)


def info(msg):
    print("[ui-f]   " + msg)


def main():
    home = tempfile.mkdtemp(prefix="tatai-v0608f-ui-home-")
    work = tempfile.mkdtemp(prefix="tatai-v0608f-ui-work-")
    logs = os.path.join(work, "logs")
    os.makedirs(logs, exist_ok=True)
    os.makedirs(SHOT_DIR, exist_ok=True)
    backend = None
    vite = None
    try:
        root = os.path.join(work, PROJECT)
        v0608ui.make_project(
            root,
            name="夹具·补修F",
            with_design=True,
            plan_cards=[("T-1", "甲：导入能力", "", "甲一验收记录"), ("T-2", "甲：报表能力", "T-1", "甲二验收记录"),
                        ("T-3", "甲：导出能力", "", "甲三验收记录")],
            design_lines=40,
        )
        v0608ui.make_registry(home, [
            {"id": PROJECT, "name": "夹具·补修F", "path": root, "kind": "fullstack",
             "registered_at": "2026-09-20T08:00:00+08:00", "last_opened_at": "2026-09-20T08:00:00+08:00"},
        ])

        # 补修包 E 的自动语义链会调模型；本脚本验的是验收页的入口展示，关掉后台模型调用。
        os.environ["TATAI_SEMANTIC_AUTO"] = "0"
        vite_port = v0608ui.free_port()
        backend_port = v0608ui.free_port()
        backend = v0608ui.Backend(home, backend_port, os.path.join(logs, "backend.log"))
        backend.wait_health()
        info(f"后端就绪：http://127.0.0.1:{backend_port}（隔离 TATAI_HOME {home}）")

        plan, rev = v0608ui.seed_project_facts(backend, PROJECT)
        ids = [d["task_id"] for d in plan["definitions"]]
        t1, t2 = ids[0], ids[1]
        v0608ui.seed_states(backend, PROJECT, plan)

        def local_iso(ms):
            """本地带偏移 ISO（与产品钟同口径：`+08:00` 而不是 `+0800`）"""
            t = time.localtime(ms / 1000)
            base = time.strftime("%Y-%m-%dT%H:%M:%S", t)
            off = time.strftime("%z", t)
            return f"{base}{off[:3]}:{off[3:]}"

        def wo(entity, type_, payload, key, expected=None, actor="fixture", role="agent"):
            return backend.wo_command(v0608ui.cmd(PROJECT, entity, type_, payload, key, expected=expected,
                                                 actor=actor, role=role))

        # ── 阶段 A：成果提交了，但**没有**登记任何运行入口 → 页面应写"尚不可体验" ──
        sha_a = v0608ui.put_evidence(root, "夹具证据：T-1 真实命令输出\npassed 7\n", "T-1 验收证据（夹具）", "acceptance")
        wo(f"submission:sub-{t1}-a", "audit.submission_submitted", {
            "goal": "甲：导入能力交付（先不登记入口）", "task_id": t1, "round": 1, "baseline": {},
            "changed_files": ["src/import.ts"],
            "commands": [{"command": "pnpm test import", "exit_code": 0, "output_ref": None}],
            "untested": [{"item": "十万行性能", "reason": "夹具未跑"}], "known_issues": [],
            "evidence_refs": [sha_a], "binding": {"revision_kind": "code", "revision": "fixture-code-rev-1"},
            "submitted_by": "fixture-agent",
        }, f"sub-{t1}-a:v0608fui", expected=None)
        info("阶段 A 夹具就绪：成果已提交、未登记运行入口、用户未验收")

        # ── 阶段 B：再提交一次成果，登记三条入口（可打开 / 探测失败 / 已过期） ──
        now_ms = int(time.time() * 1000)
        fresh_iso = local_iso(now_ms)
        stale_iso = local_iso(now_ms - 25 * 3600 * 1000)
        open_url = f"http://127.0.0.1:{vite_port}/#p/{PROJECT}"
        # 更晚那条成果的入口地址（明确不同于 open_url，避免"打开入口"点击断言出现多义）
        open_url_later = f"http://127.0.0.1:{vite_port}/#p/{PROJECT}-export"
        wo(f"submission:sub-{t1}-b", "audit.submission_submitted", {
            "goal": "甲：导入能力交付（登记可体验入口）", "task_id": t1, "round": 2, "baseline": {},
            "changed_files": ["src/import.ts"],
            "commands": [{"command": "pnpm test import", "exit_code": 0, "output_ref": None}],
            "untested": [], "known_issues": [],
            "evidence_refs": [sha_a], "binding": {"revision_kind": "code", "revision": "fixture-code-rev-2"},
            "submitted_by": "fixture-agent",
            "runtime_entries": [
                {"scenario": "甲：导入能力（可体验）", "url": open_url, "verified_at": fresh_iso,
                 "status": "reachable", "reason": None},
                {"scenario": "甲：压测台（已失效）", "url": "http://127.0.0.1:9/bench", "verified_at": fresh_iso,
                 "status": "unreachable", "reason": "夹具：进程已结束"},
                # 2026-09-20（裁定 F2）：这条**不再**叫"已过期"——超复核提醒阈值只标「待重新验证」，
                # 而且**仍然有打开按钮**（超时不等于失效，也不撤入口）
                {"scenario": "甲：旧接口调试台（待重新验证）", "url": "http://127.0.0.1:5180/api",
                 "verified_at": stale_iso, "status": "reachable", "reason": None},
            ],
        }, f"sub-{t1}-b:v0608fui", expected=None)
        # 再交一条**更晚**的成果（绑定版本 fixture-code-rev-3），把上面那条的绑定版本推成"已过期"；
        # 它自己带一条入口（绑新版本 ⇒ current），于是页面上能同时看到 current 与 outdated 两种版本状态
        wo(f"submission:sub-{t1}-c", "audit.submission_submitted", {
            "goal": "甲：导出流程交付（更晚的版本）", "task_id": t1, "round": 3, "baseline": {},
            "changed_files": ["src/export.ts"],
            "commands": [{"command": "pnpm test export", "exit_code": 0, "output_ref": None}],
            "untested": [], "known_issues": [],
            "evidence_refs": [sha_a], "binding": {"revision_kind": "code", "revision": "fixture-code-rev-3"},
            "submitted_by": "fixture-agent",
            "runtime_entries": [
                {"scenario": "甲：导出流程（当前版本）", "url": open_url_later, "verified_at": fresh_iso,
                 "status": "reachable", "reason": None},
            ],
        }, f"sub-{t1}-c:v0608fui", expected=None)
        # 任务级：让 t2 只在验收记录里带一个非 http 场景引用（证明非 http(s) 渲染成纯文本，不当链接）
        wo(f"acceptance:acc-{t2}", "audit.human_acceptance_recorded", {
            "decision": "accept", "task_id": t2, "batch_id": None,
            "scenario_refs": ["javascript:alert(1)", "走一遍导出流程"],
            "baseline": {}, "evidence_refs": [sha_a], "accepted_by": "user", "note": "夹具：用户已接受",
        }, f"acc-{t2}:v0608fui", expected=None, actor="user", role="user")
        info("阶段 B 夹具就绪：三条入口登记（1 可打开 / 1 失效 / 1 过期）+ t2 带非 http 场景引用")

        # ── 阶段 C：用户还没接受的那条任务保持 pending ──
        events_path = os.path.join(root, ".工作台", "work", "events.jsonl")
        acc_before = backend.api(f"/api/projects/{PROJECT}/acceptance")[1]["acceptance"]

        vite = v0608ui.start_vite(vite_port, backend_port, os.path.join(logs, "vite.log"))
        info(f"vite 就绪：http://localhost:{vite_port}（代理 → {backend_port}）")

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1600, "height": 1000})
            page = context.new_page()
            page_errors = []
            page.on("pageerror", lambda e: page_errors.append(str(e)))
            base = f"http://localhost:{vite_port}"

            def shot(name):
                page.screenshot(path=os.path.join(SHOT_DIR, name))

            def open_acceptance():
                page.goto(f"{base}/#p/{PROJECT}", wait_until="domcontentloaded")
                page.wait_for_selector('button[data-view="live"]', timeout=60000)
                page.locator('button[data-view="live"]').click()
                page.wait_for_selector("[data-live-page]", timeout=30000)
                page.locator('[data-live-sub="acceptance"]').click()
                page.wait_for_selector("[data-runtime-entries]", timeout=30000)
                page.wait_for_timeout(400)
                # 装一个 window.open 探针：既证明"打开动作真的走到了浏览器降级路"，
                # 又**不真弹窗打网络**（返回 null，把"打开"这一步留在可断言的一层）
                page.evaluate(
                    "() => { window.__tataiOpenCalls = [];"
                    " window.open = (...args) => { window.__tataiOpenCalls.push(args); return null; }; }"
                )

            # ═══════════ ① 用户未验收，入口已经在页面上（来源是成果登记） ═══════════
            open_acceptance()
            pending_card = page.locator(f'[data-acceptance-task="{t1}"]')
            ok(pending_card.get_attribute("data-acceptance-state") == "pending",
               f"① t1（{t1}）在页面上仍是 pending（没有任何用户验收记录）")
            section = page.locator("[data-runtime-entries]")
            ok(section.count() == 1, "① 验收页有「可体验运行入口」区块（§3.7）")
            ok(section.get_attribute("data-runtime-entry-summary-kind") == "available",
               "① 概况 kind=available（有可打开入口）")
            entries = page.locator("[data-runtime-entry]")
            ok(entries.count() == 4, f"① 四条登记逐条上屏（实际 {entries.count()}）")
            openables = page.locator('[data-runtime-entry-state="openable"]')
            ok(openables.count() == 2 and all(
                openables.nth(i).get_attribute("data-runtime-entry-openable") == "1" for i in range(2)
            ), "① 可打开的入口两条（data-runtime-entry-openable=1；含更晚那条成果的当前版本入口）")
            # 后续"打开入口/文案"断言只针对「甲：导入能力」这一条（避免定位器多义）
            open_entry = page.locator('[data-runtime-entry-state="openable"]').filter(has_text="甲：导入能力（可体验）")
            ok(open_entry.count() == 1, "① 「甲：导入能力」这一条可唯一定位（打开断言的对象明确）")
            entry_text = open_entry.inner_text()
            ok("甲：导入能力（可体验）" in entry_text and "来源成果 sub-" in entry_text,
               "① 入口带上场景与**来源成果**（谁登记的、对应哪批成果）")
            ok("fixture-code-rev-2" in entry_text and "登记时间" in entry_text and "验证时间" in entry_text,
               "① 入口带上**版本、登记时间与验证时间**（最少登记五项里的三项）")
            ok("打开入口 ≠ 用户接受" in section.inner_text(),
               "① 区块明写「打开入口 ≠ 用户接受」（两件事分开记，§5.8）")
            ok(page.locator(f'[data-acceptance-task="{t2}"]').get_attribute("data-acceptance-state") == "accepted",
               "① 对照：t2 有用户验收记录 → accepted（页面上两件事并存）")
            shot("01-runtime-entries-before-acceptance.png")

            # ═══════════ ② 两条轴分开：①「待重新验证」仍可打开 ②「版本过期」是另一回事 ═══════════
            failed = page.locator('[data-runtime-entry-state="failed"]')
            ok(failed.count() == 1 and "甲：压测台（已失效）" in failed.inner_text(),
               "② 探测失败的入口仍在页面上（没静默消失）")
            ok("探测失败" in failed.inner_text() and "夹具：进程已结束" in failed.inner_text(),
               "② 失效入口写明状态与不可用原因")
            ok(failed.locator("[data-runtime-entry-blocked]").count() == 1
               and failed.locator("[data-runtime-entry-open]").count() == 0,
               "② 失效入口**没有**打开按钮（结构上就不可能点开）")
            # 2026-09-20（裁定 F2 ②）：超复核提醒阈值 ⇒「待重新验证」，**不判不可达、不撤打开按钮**
            due = page.locator('[data-runtime-entry-state="reverify_due"]')
            ok(due.count() == 1 and "待重新验证" in due.inner_text() and "甲：旧接口调试台" in due.inner_text(),
               "② 超复核提醒阈值的入口标「待重新验证」（**不是**「已失效 / 已过期」）")
            ok(due.get_attribute("data-runtime-entry-openable") == "1"
               and due.locator("[data-runtime-entry-open]").count() == 1,
               "② 待重新验证的入口**仍然有打开按钮**（超时不撤入口）")
            ok(page.locator('[data-runtime-entry-state="expired"]').count() == 0,
               "② 页面上不存在「expired」这一档（旧口径已从词表移除）")
            # 版本轴（裁定 F2 ③）：与"能不能打开"**分开显示**
            outdated = page.locator('[data-runtime-entry-revision-state="outdated"]')
            current = page.locator('[data-runtime-entry-revision-state="current"]')
            ok(outdated.count() == 3 and current.count() == 1,
               f"② 版本轴独立上屏：已过期 {outdated.count()} 条 / 当前 {current.count()} 条（绑定版本 vs 当前版本）")
            ok(current.locator("[data-runtime-entry-open]").count() == 1
               and outdated.locator("[data-runtime-entry-open]").count() == 2,
               "② 版本过期**不撤**打开入口（3 条可打开：2 条版本已过期 + 1 条当前版本）")
            ok("成果版本已过期" in open_entry.inner_text() and "仍可打开" in open_entry.inner_text(),
               "② 版本过期那条自己说清：入口仍可打开，只是对应的是旧版本")
            summary_note = page.locator("[data-runtime-entry-summary-note]").inner_text()
            ok("有 3 个可打开的入口" in summary_note and "待重新验证" in summary_note
               and "探测失败 1" in summary_note,
               f"② 概况把「能打开（含待重新验证）」与「当前打不开」分开数：{summary_note[:64]}…")

            # ═══════════ ③ 受控打开：只走 http(s)，浏览器降级到新标签页 ═══════════
            counts_before = page.locator("[data-acceptance-pending-count]").inner_text()
            url_before = page.url
            open_entry.locator("[data-runtime-entry-open]").click()
            page.wait_for_timeout(500)
            calls = page.evaluate("() => window.__tataiOpenCalls")
            ok(len(calls) == 1 and calls[0][0] == open_url,
               f"③ 点「打开入口」→ 真的走了浏览器新标签页这条路（window.open 实参 = 登记地址：{calls[0][0] if calls else '无'}）")
            ok(len(calls) == 1 and "noopener" in (calls[0][2] or "") and "noreferrer" in (calls[0][2] or ""),
               f"③ 新标签页带 noopener+noreferrer（拿不到 opener、也带不上 Referer）：{calls[0][2] if calls else '无'}")
            notice = page.locator("[data-runtime-entry-open-notice]").inner_text()
            ok("新标签页" in notice or "系统浏览器" in notice, f"③ 上屏受控打开回执：{notice}")
            ok(page.url == url_before, "③ 塔台页面自己**没有**被导航走（窗口不被顶掉）")
            bad_links = page.eval_on_selector_all(
                "a[href]", "els => els.filter(e => /^(javascript|file|data):/i.test(e.getAttribute('href')||'')).length"
            )
            ok(bad_links == 0, "③ 页面上没有任何 javascript:/file:/data: 链接（非 http(s) 一律不执行）")
            ok(page.locator(f'[data-acceptance-task="{t2}"]').inner_text().find("javascript:alert(1)") >= 0,
               "③ 验收记录里的非 http(s) 场景引用按纯文本给（连链接都不渲染）")
            ok(page.locator(f'[data-acceptance-task="{t2}"] [data-result-link]').count() == 0,
               "③ 该任务名下没有任何指向非 http(s) 的链接")
            shot("02-controlled-open.png")

            # ═══════════ ④ 打开 ≠ 接受 ═══════════
            ok(page.locator(f'[data-acceptance-task="{t1}"]').get_attribute("data-acceptance-state") == "pending",
               "④ 打开入口后 t1 仍是 pending（打开不是接受）")
            ok(page.locator("[data-acceptance-pending-count]").inner_text() == counts_before,
               f"④ 待验收计数没变（{counts_before}）")
            ok("用户已接受" not in page.locator(f'[data-acceptance-task="{t1}"]').inner_text(),
               "④ t1 卡片上没有出现任何「用户已接受」字样")
            ok(not page_errors, f"④ 全程无页面 JS 异常（实际 {page_errors[:2]}）")
            browser.close()

        # ── ⑤ 后端事实对账：入口登记没有产生任何"已接受"，且入口清单与阶段 A 的来源无关 ──
        acc_after = backend.api(f"/api/projects/{PROJECT}/acceptance")[1]["acceptance"]
        raw_events = open(events_path, encoding="utf-8").read()
        accept_lines = [l for l in raw_events.splitlines() if "audit.human_acceptance_recorded" in l]
        ok(len(accept_lines) == 1,
           f"⑤ 全程只有夹具自己写的那 1 条人工验收事件（打开入口没有写第二条）：实际 {len(accept_lines)} 条")
        t1_after = [t for t in acc_after["tasks"] if t["task_id"] == t1][0]
        ok(t1_after["acceptance"] == "pending" and t1_after["acceptance_records"] == [],
           "⑤ 后端读回：t1 没有验收记录、状态仍是 pending（打开入口 ≠ 用户接受）")
        ok(acc_after["runtime_entry_summary"]["kind"] == "available"
           and len(acc_after["runtime_entries"]) == 4
           and acc_after["runtime_entry_summary"]["can_open_count"] == 3
           and acc_after["runtime_entry_summary"]["reverify_due_count"] == 1
           and acc_after["runtime_entry_summary"]["outdated_count"] == 3,
           "⑤ 入口清单在点击前后一致（4 条；可打开 3＝含待重验 1；版本过期 3），且概况两条轴都数出来")
        ok(json.dumps(acc_after["runtime_entries"], ensure_ascii=False)
           == json.dumps(acc_before["runtime_entries"], ensure_ascii=False),
           "⑤ 入口清单逐字未变（页面动作不改任何登记）")
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
            print(f"[ui-f] 保留现场：{home} / {work}")
        else:
            for d in (home, work):
                try:
                    shutil.rmtree(d, ignore_errors=True)
                except Exception:
                    pass

    print(f"[ui-f] 合计 PASS {passes[0]} / FAIL {len(fails)}")
    for f in fails:
        print("[ui-f]   FAIL " + f)
    print(f"[ui-f] 截图目录：{SHOT_DIR}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
