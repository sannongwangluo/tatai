#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""补修包 F 的**浏览器**验证（Python + Playwright）：可体验运行入口在真 DOM 里的行为。

用法：python scripts/verify-v06-08-f-ui.py
      （或 pnpm verify:v06-08-f-ui）
环境变量：
  · V0608F_SHOT_DIR   输出目录（截图/日志）。**默认** REPO/.工作台/verify/v06-08-f（兼容原行为）；
                      本轮实测把它指向私有目录，避免覆盖历史产物。
  · V0608F_VITE_PORT  固定 vite 端口（默认每次动态取空闲端口）。
  · V0608F_KEEP_TMP=1 保留临时夹具现场。
  · TATAI_UI_BROWSER / TATAI_EDGE_PATH 指定浏览器可执行文件（默认用系统已装 Edge，不下载）。

为什么必须跑真浏览器：本包要证的三件事只有在真 DOM 上才算数——
  ① **用户还没验收时**，验收页就已经展示成果登记里的可体验入口（入口不是验收记录派生的）；
  ② 没有入口时页面写"尚不可体验"、登记过但失效/过期的**逐条说明状态**（不静默消失）；
  ③ 点"打开入口"是受控打开（协议白名单 + 浏览器降级到新标签页），而且**不产生任何"已接受"记录**
     （页面状态、计数、后端事件三处都要能对上）。

**2026-10-08 版本轴返工（本脚本自 F4 缺口修复后的必改项）**：
　　修好后的版本轴**不再拿账本里自报的 `binding.revision` 当当前版本**（契约 F4「自报不自证」）：能当
　　"当前版本"的只有该来源**正式引用、且版本绑定一致**的合法 `source_manifest` 现读结论。于是原夹具
　　（`evidence_refs` 指向 `acceptance` 类证据 + 自报 `fixture-code-rev-1/2/3` 猜 current/outdated）**必然
　　转红**——那正是"自报不自证"要断掉的老口径，**不是**把期望改成全 unknown 的借口。本脚本据此改为：
　　· 每份源清单经**唯一 HTTP 宿主**（`POST /api/work/reporting/evidence`）现读登记，取回执里的
　　  **服务端真实指纹**；成果登记/结果回报以该指纹当 `binding.revision`，并把它记进 `evidence_refs`；
　　· 覆盖文件真变化 ⇒ 旧成果在 DOM 上转 `outdated`；新登记清单与当前源码一致 ⇒ `current`；
　　· 补 unknown（错绑定/来源冲突）、两个来源（成果登记 vs 结果回报）同判、相关/无关源变化的 DOM 状态、
　　  来源混淆负例。**保留**原入口行为、协议白名单、打开不代签、24h 提醒、真实用户 Gate 夹具维度。

隔离口径（照 `verify-v06-08-ui.py`）：
  · 临时 TATAI_HOME + `tempfile` 下一个夹具项目，**绝不碰**真实项目的 `.工作台/`；
  · 夹具事实全部经**真实 v2 写入服务**（`POST /api/work/command`）提交；证据正文经**唯一写服务宿主**
    的真实写口落盘（内容寻址），测试**不自己裸写**证据文件；
  · 收尾杀净子进程、删临时目录（V0608F_KEEP_TMP=1 可留现场）。

复用：夹具/后端/vite/浏览器/宿主证据写口的构造与断言小工具从 `scripts/verify-v06-08-ui.py` 里
**import**（不复制一份），本脚本只写自己的场景与断言。
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
CHG = "v0608fui"
KEEP = os.environ.get("V0608F_KEEP_TMP") == "1"
# 输出目录**可配置、兼容默认**：不设 = 原来的 `.工作台/verify/v06-08-f`（历史产物照旧），
# 本轮实测把它指向私有唯一目录，避免覆盖历史 log/截图。
SHOT_DIR = os.environ.get("V0608F_SHOT_DIR") or os.path.join(REPO, ".工作台", "verify", "v06-08-f")
VITE_PORT_OVERRIDE = os.environ.get("V0608F_VITE_PORT")

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
        vite_port = int(VITE_PORT_OVERRIDE) if VITE_PORT_OVERRIDE else v0608ui.free_port()
        backend_port = v0608ui.free_port()
        backend = v0608ui.Backend(home, backend_port, os.path.join(logs, "backend.log"))
        backend.wait_health()
        info(f"后端就绪：http://127.0.0.1:{backend_port}（隔离 TATAI_HOME {home}）")

        plan, rev = v0608ui.seed_project_facts(backend, PROJECT)
        ids = [d["task_id"] for d in plan["definitions"]]
        t1, t2, t3 = ids[0], ids[1], ids[2]

        def local_iso(ms):
            """本地带偏移 ISO（与产品钟同口径：`+08:00` 而不是 `+0800`）"""
            t = time.localtime(ms / 1000)
            base = time.strftime("%Y-%m-%dT%H:%M:%S", t)
            off = time.strftime("%z", t)
            return f"{base}{off[:3]}:{off[3:]}"

        def wo(entity, type_, payload, key, expected=None, actor="fixture", role="agent"):
            return backend.wo_command(v0608ui.cmd(PROJECT, entity, type_, payload, key, expected=expected,
                                                 actor=actor, role=role))

        def submit(slug, scenario, binding_revision, refs, entries, task=t1, expected=None):
            payload = {
                "goal": f"甲：{scenario}（夹具）", "task_id": task, "round": 1, "baseline": {},
                "changed_files": ["src/import.ts"],
                "commands": [{"command": "pnpm test import", "exit_code": 0, "output_ref": None}],
                "untested": [], "known_issues": [],
                "evidence_refs": refs,
                "submitted_by": "fixture-agent",
                "runtime_entries": entries,
            }
            if binding_revision is not None:
                payload["binding"] = {"revision_kind": "code", "revision": binding_revision}
            return wo(f"submission:sub-{slug}", "audit.submission_submitted", payload,
                      f"sub-{slug}:v0608fui", expected=expected)

        def entry(scenario, url, verified_at, status="reachable", reason=None):
            return {"scenario": scenario, "url": url, "verified_at": verified_at, "status": status, "reason": reason}

        # ══════════ 源清单：经**唯一 HTTP 宿主**现读登记（指纹由服务端现读算，测试不自己造） ══════════
        def store_manifest(rel_path, content, revision_kind="code", revision="run:fixture"):
            v0608ui.write(os.path.join(root, rel_path), content)
            ev = v0608ui.store_evidence(
                backend, PROJECT, kind="source_manifest", content="",
                summary=f"补修F 夹具源清单（{rel_path} / {revision_kind}）",
                binding={"revision_kind": revision_kind, "revision": revision},
                source_manifest=[rel_path], created_by="fixture-agent",
            )
            fp = ev["source_manifest"]["fingerprint"]
            assert isinstance(fp, str) and len(fp) == 64, f"宿主回执没有指纹：{ev.get('source_manifest')}"
            return {"sha": ev["sha256"], "fp": fp, "fingerprint": fp}

        def store_manifest_distinct(rel_path, content, marker, revision_kind="code", revision="run:fixture"):
            """同一覆盖集合、**不同正文** ⇒ 同清单指纹、不同内容地址（构造"同指纹冲突 binding"用）"""
            v0608ui.write(os.path.join(root, rel_path), content)
            ev = v0608ui.store_evidence(
                backend, PROJECT, kind="source_manifest", content=marker,
                summary=f"补修F 夹具源清单载体（{marker}）",
                binding={"revision_kind": revision_kind, "revision": revision},
                source_manifest=[rel_path], created_by="fixture-agent",
            )
            return {"sha": ev["sha256"], "fingerprint": ev["source_manifest"]["fingerprint"]}

        # ── 阶段 A：成果提交了，但**没有**登记任何运行入口 → 概况应"尚不可体验" ──
        m_old = store_manifest("src/import.ts", "export const IMPORT = 1;\n", revision="run:old")
        info(f"源清单 M_old 经宿主现读登记：指纹 {m_old['fp'][:12]}…")
        wo(f"submission:sub-{t1}-a", "audit.submission_submitted", {
            "goal": "甲：导入能力交付（先不登记入口）", "task_id": t1, "round": 1, "baseline": {},
            "changed_files": ["src/import.ts"],
            "commands": [{"command": "pnpm test import", "exit_code": 0, "output_ref": None}],
            "untested": [{"item": "十万行性能", "reason": "夹具未跑"}], "known_issues": [],
            "evidence_refs": [m_old["sha"]], "binding": {"revision_kind": "code", "revision": m_old["fp"]},
            "submitted_by": "fixture-agent",
        }, f"sub-{t1}-a:v0608fui", expected=None)
        st, acc_a = backend.api(f"/api/projects/{PROJECT}/acceptance")
        ok(st == 200 and acc_a["acceptance"]["runtime_entry_summary"]["kind"] == "unavailable"
           and len(acc_a["acceptance"]["runtime_entries"]) == 0,
           "阶段A 成果已提交、未登记入口 ⇒ 概况 unavailable（尚不可体验），不是「加载失败」也不是「已验证通过」")
        info("阶段 A 夹具就绪：成果已提交、未登记运行入口、用户未验收")

        # ── 阶段 B：覆盖文件真变化 ⇒ 旧成果版本过期；再登记一份与当前源码一致的清单 ⇒ current ──
        v0608ui.write(os.path.join(root, "src", "import.ts"), "export const IMPORT = 2;\n")  # 覆盖源变了
        m_new = store_manifest("src/import.ts", "export const IMPORT = 2;\n", revision="run:new")
        m_plan = store_manifest_distinct("src/import.ts", "export const IMPORT = 2;\n", "carrier:plan-kind",
                                        revision_kind="plan", revision="run:plan")
        ok(m_old["fp"] != m_new["fp"] and m_new["fp"] == m_plan["fingerprint"],
           f"夹具前提：M_old 指纹 {m_old['fp'][:8]}… ≠ M_new 指纹 {m_new['fp'][:8]}…；M_plan 与 M_new **同指纹**（构造冲突用）")

        now_ms = int(time.time() * 1000)
        fresh_iso = local_iso(now_ms)
        stale_iso = local_iso(now_ms - 25 * 3600 * 1000)
        open_url = f"http://127.0.0.1:{vite_port}/#p/{PROJECT}"
        # 更晚那条成果的入口地址（明确不同于 open_url，避免"打开入口"点击断言出现多义）
        open_url_later = f"http://127.0.0.1:{vite_port}/#p/{PROJECT}-export"

        # ① 绑**旧清单**（覆盖源已变 ⇒ 现读 invalidated）→ 三条入口全 outdated；其中含失效/待重验两条轴
        submit(f"{t1}-b", "导入能力交付（登记可体验入口）", m_old["fp"], [m_old["sha"]], [
            entry("甲：导入能力（可体验）", open_url, fresh_iso),
            entry("甲：压测台（已失效）", "http://127.0.0.1:9/bench", fresh_iso, "unreachable", "夹具：进程已结束"),
            # 裁定 F2：超复核提醒阈值只标「待重新验证」，**仍然有打开按钮**（超时不等于失效，也不撤入口）
            entry("甲：旧接口调试台（待重新验证）", "http://127.0.0.1:5180/api", stale_iso),
        ])
        # ② 绑**新清单**（与当前源码一致 ⇒ 现读 valid）→ current
        submit(f"{t1}-c", "导出流程交付（绑当前源码清单）", m_new["fp"], [m_new["sha"]], [
            entry("甲：导出流程（当前版本）", open_url_later, fresh_iso),
        ])
        # ③ 来源混淆负例：声明的 code 版本 ≠ 所引清单指纹（错绑定）⇒ 不借一份无关清单背书 ⇒ unknown
        submit(f"{t1}-d", "来源混淆交付（错绑定）", "fixture-code-rev-wrong", [m_new["sha"]], [
            entry("甲：来源混淆（错绑定）", f"{open_url_later}-wrong", fresh_iso),
        ])
        # ④ 冲突负例：同指纹、不同 binding（code 清单 + plan 清单）⇒ 冲突不择优 ⇒ unknown
        submit(f"{t1}-e", "来源冲突交付（同指纹双 binding）", m_new["fp"], [m_new["sha"], m_plan["sha"]], [
            entry("甲：来源冲突（同指纹双 binding）", f"{open_url_later}-conflict", fresh_iso),
        ])

        # ⑤ 结果回报路径（真认领 + 真结果回报），正式引用**同一份**清单 ⇒ 与成果登记**同判 current**
        #    用 T-3（无前置依赖）：T-2 依赖 T-1，依赖未过的任务不接受交付（产品锁内核实，不是夹具能绕的）。
        claim = wo(f"task:{t3}", "task.claimed", {
            "run_id": "run-fixture", "attempt_id": "attempt-1", "owner_id": "fixture",
            "claim_token": "claim-fixture-1", "lease_expires_at": "2031-01-01T00:00:00+08:00",
        }, f"{t3}:claim:v0608fui", expected=1)
        wo(f"task:{t3}", "task.result_submitted", {
            "definition_sha256": plan["definition_hashes"][t3], "plan_revision": plan["content_sha256"],
            "claim_token": "claim-fixture-1", "result_revision": m_new["fp"], "evidence_refs": [m_new["sha"]],
            "runtime_entries": [entry("甲：导出流程（结果回报·当前版本）", f"{open_url_later}-result", fresh_iso)],
        }, f"{t3}:result:v0608fui", expected=2)
        info(f"结果回报已提交（认领事件 seq={claim.get('seq')}）：绑定清单 {m_new['fp'][:12]}…")

        # 任务级：让 t2 在验收记录里带一个非 http 场景引用（证明非 http(s) 渲染成纯文本，不当链接）
        wo(f"acceptance:acc-{t2}", "audit.human_acceptance_recorded", {
            "decision": "accept", "task_id": t2, "batch_id": None,
            "scenario_refs": ["javascript:alert(1)", "走一遍导出流程"],
            "baseline": {}, "evidence_refs": [m_new["sha"]], "accepted_by": "user", "note": "夹具：用户已接受",
        }, f"acc-{t2}:v0608fui", expected=None, actor="user", role="user")
        info("阶段 B 夹具就绪：7 条入口登记（旧清单 3 条 outdated / 新清单 1 条 + 结果回报 1 条 current / 混淆与冲突 2 条 unknown）+ t2 带非 http 场景引用")

        # ── 阶段 C：用户还没接受的那条任务保持 pending ──
        events_path = os.path.join(root, ".工作台", "work", "events.jsonl")
        acc_before = backend.api(f"/api/projects/{PROJECT}/acceptance")[1]["acceptance"]

        vite = v0608ui.start_vite(vite_port, backend_port, os.path.join(logs, "vite.log"),
                                  cache_dir=os.path.join(work, "vite-cache"))
        info(f"vite 就绪：http://localhost:{vite_port}（代理 → {backend_port}；缓存 {os.path.join(work, 'vite-cache')}）")

        with sync_playwright() as p:
            browser = v0608ui.launch_browser(p)
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

            def entry_by(scenario):
                return page.locator("[data-runtime-entry]").filter(has_text=scenario)

            def revision_state_of(scenario):
                loc = entry_by(scenario)
                return loc.first.get_attribute("data-runtime-entry-revision-state") if loc.count() == 1 else None

            def wait_revision(scenario, value, timeout_ms=40000):
                # 用**单调钟**计真实经过时间，不用墙钟（time.time()）。产品对账是 5s 周期的可见页轮询：
                # 2026-10-08 独立复验跑到这一步时机器发生墙钟前跳（18:14→19:20，记于本轮续作说明），
                # 若用 time.time() 一旦前跳超过 timeout，deadline 会被瞬间越过 ⇒ 循环**一次都不轮询**就
                # 返回 False（实测：注入 +4000s 后 time.time 只被调用 2 次即退出，DOM 仍是 current/current），
                # 于是把"产品没翻面"误报成失败（原 46/1 即此机制）。time.monotonic() 不受墙钟跳变影响，
                # 断言的 timeout 值一字不改、等待行为一字不改——只是让"40s"真的等于 40s 的真实经过时间。
                deadline = time.monotonic() + timeout_ms / 1000
                while time.monotonic() < deadline:
                    if revision_state_of(scenario) == value:
                        return True
                    page.wait_for_timeout(500)
                return False

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
            ok(entries.count() == 7, f"① 七条登记逐条上屏（实际 {entries.count()}）")
            openables = page.locator('[data-runtime-entry-state="openable"]')
            ok(openables.count() == 5 and all(
                openables.nth(i).get_attribute("data-runtime-entry-openable") == "1" for i in range(5)
            ), "① 可打开的入口五条（data-runtime-entry-openable=1）")
            # 后续"打开入口/文案"断言只针对「甲：导入能力」这一条（避免定位器多义）
            open_entry = page.locator('[data-runtime-entry-state="openable"]').filter(has_text="甲：导入能力（可体验）")
            ok(open_entry.count() == 1, "① 「甲：导入能力」这一条可唯一定位（打开断言的对象明确）")
            entry_text = open_entry.inner_text()
            ok("甲：导入能力（可体验）" in entry_text and "来源成果 sub-" in entry_text,
               "① 入口带上场景与**来源成果**（谁登记的、对应哪批成果）")
            ok(m_old["fp"] in entry_text and "登记时间" in entry_text and "验证时间" in entry_text,
               "① 入口带上**服务端真实清单指纹、登记时间与验证时间**（版本不再是自报串）")
            ok("打开入口 ≠ 用户接受" in section.inner_text(),
               "① 区块明写「打开入口 ≠ 用户接受」（两件事分开记，§5.8）")
            ok(page.locator(f'[data-acceptance-task="{t2}"]').get_attribute("data-acceptance-state") == "accepted",
               "① 对照：t2 有用户验收记录 → accepted（页面上两件事并存）")
            shot("01-runtime-entries-before-acceptance.png")

            # ═══════════ ② 两条轴分开：①「待重新验证」仍可打开 ②版本轴独立（不限时"不得改标准"） ═══════════
            failed = page.locator('[data-runtime-entry-state="failed"]')
            ok(failed.count() == 1 and "甲：压测台（已失效）" in failed.inner_text(),
               "② 探测失败的入口仍在页面上（没静默消失）")
            ok("探测失败" in failed.inner_text() and "夹具：进程已结束" in failed.inner_text(),
               "② 失效入口写明状态与不可用原因")
            ok(failed.locator("[data-runtime-entry-blocked]").count() == 1
               and failed.locator("[data-runtime-entry-open]").count() == 0,
               "② 失效入口**没有**打开按钮（结构上就不可能点开）")
            # 裁定 F2 ②：超复核提醒阈值 ⇒「待重新验证」，**不判不可达、不撤打开按钮**
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
            unknown = page.locator('[data-runtime-entry-revision-state="unknown"]')
            ok(outdated.count() == 3 and current.count() == 2 and unknown.count() == 2,
               f"② 版本轴独立上屏：已过期 {outdated.count()} / 当前 {current.count()} / 未知 {unknown.count()} 条（绑定清单 vs 现读复核）")
            ok(current.locator("[data-runtime-entry-open]").count() == 2
               and outdated.locator("[data-runtime-entry-open]").count() == 2,
               "② 版本过期**不撤**打开入口（outdated 里 2 条仍可打开：失效那条除外）")
            ok("成果版本已过期" in open_entry.inner_text() and "仍可打开" in open_entry.inner_text(),
               "② 版本过期那条自己说清：入口仍可打开，只是对应的是旧版本")
            unknown_entry = entry_by("甲：来源混淆（错绑定）")
            ok(unknown_entry.count() == 1 and "版本状态未知" in unknown_entry.inner_text(),
               "② 拿不到可核对当前版本的入口如实标「版本状态未知」（**不猜成 current/outdated**）")
            summary_note = page.locator("[data-runtime-entry-summary-note]").inner_text()
            ok("有 6 个可打开的入口" in summary_note and "待重新验证" in summary_note
               and "探测失败 1" in summary_note,
               f"② 概况把「能打开（含待重新验证）」与「当前打不开」分开数：{summary_note[:64]}…")

            # ═══════════ ②b 两个来源同权：成果登记与结果回报**同判 current** ═══════════
            sub_cur = entry_by("甲：导出流程（当前版本）")
            res_cur = entry_by("甲：导出流程（结果回报·当前版本）")
            ok(sub_cur.count() == 1 and res_cur.count() == 1
               and sub_cur.get_attribute("data-runtime-entry-revision-state") == "current"
               and res_cur.get_attribute("data-runtime-entry-revision-state") == "current",
               "②b 两个来源同权：成果登记与结果回报**正式引用同一清单** ⇒ 两边都判 current")
            ok("来源成果" in sub_cur.inner_text() and "来源结果回报" in res_cur.inner_text(),
               "②b 两条入口各自标清来源（成果登记 / 结果回报，F3：两条路径等价）")

            # ═══════════ ②c 来源混淆 / 冲突负例：都不能借第一份绿 ═══════════
            conflict = entry_by("甲：来源冲突（同指纹双 binding）")
            ok(conflict.count() == 1 and conflict.get_attribute("data-runtime-entry-revision-state") == "unknown",
               "②c 同指纹、冲突 binding（code 清单 + plan 清单）⇒ DOM 如实 unknown（不借第一份的绿）")
            ok(entry_by("甲：来源混淆（错绑定）").get_attribute("data-runtime-entry-revision-state") == "unknown",
               "②c 错绑定（声明版本 ≠ 所引清单指纹）⇒ DOM 如实 unknown（不借无关清单背书）")

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

            # ═══════════ ⑤ 点击前后入口清单逐字未变（页面动作不改任何登记） ═══════════
            acc_after = backend.api(f"/api/projects/{PROJECT}/acceptance")[1]["acceptance"]
            ok(acc_after["runtime_entry_summary"]["kind"] == "available"
               and len(acc_after["runtime_entries"]) == 7
               and acc_after["runtime_entry_summary"]["can_open_count"] == 6
               and acc_after["runtime_entry_summary"]["reverify_due_count"] == 1
               and acc_after["runtime_entry_summary"]["outdated_count"] == 3,
               "⑤ 入口清单在点击前后一致（7 条；可打开 6＝含待重验 1；版本过期 3），且概况两条轴都数出来")
            ok(json.dumps(acc_after["runtime_entries"], ensure_ascii=False)
               == json.dumps(acc_before["runtime_entries"], ensure_ascii=False),
               "⑤ 入口清单逐字未变（页面动作不改任何登记）")

            # ═══════════ ⑥ 相关/无关源变化在 DOM 上的状态（现读复核的有限范围） ═══════════
            ok(revision_state_of("甲：导出流程（当前版本）") == "current",
               "⑥ 前置：绑当前清单那条在 DOM 上 current")
            v0608ui.write(os.path.join(root, "src", "unrelated.ts"), "export const UNRELATED = 1;\n")
            page.wait_for_timeout(7000)  # 等一轮可见页面对账（默认 5s）
            ok(revision_state_of("甲：导出流程（当前版本）") == "current"
               and revision_state_of("甲：导出流程（结果回报·当前版本）") == "current",
               "⑥ **无关源变化不连坐**：清单没覆盖它 ⇒ DOM 仍 current（两条来源都 current）")
            v0608ui.write(os.path.join(root, "src", "import.ts"), "export const IMPORT = 3;\n")  # 相关源变了
            ok(wait_revision("甲：导出流程（当前版本）", "outdated")
               and wait_revision("甲：导出流程（结果回报·当前版本）", "outdated", 10000),
               "⑥ **相关源一变**：DOM 自动翻成 outdated（成果登记与结果回报两条同判，两路同权）")
            ok(revision_state_of("甲：导入能力（可体验）") == "outdated"
               and entry_by("甲：来源混淆（错绑定）").get_attribute("data-runtime-entry-revision-state") == "unknown",
               "⑥ 相关源变化不连坐版本轴的其它情形：旧成果仍 outdated；错绑定那条始终 unknown")
            shot("03-source-change-dom.png")

            ok(not page_errors, f"⑥ 全程无页面 JS 异常（实际 {page_errors[:2]}）")
            browser.close()

        # ── ⑦ 后端事实对账：入口登记没有产生任何"已接受"，也没有产生第二条人工验收 ──
        raw_events = open(events_path, encoding="utf-8").read()
        accept_lines = [l for l in raw_events.splitlines() if "audit.human_acceptance_recorded" in l]
        ok(len(accept_lines) == 1,
           f"⑦ 全程只有夹具自己写的那 1 条人工验收事件（打开入口没有写第二条）：实际 {len(accept_lines)} 条")
        acc_final = backend.api(f"/api/projects/{PROJECT}/acceptance")[1]["acceptance"]
        t1_final = [t for t in acc_final["tasks"] if t["task_id"] == t1][0]
        ok(t1_final["acceptance"] == "pending" and t1_final["acceptance_records"] == [],
           "⑦ 后端读回：t1 没有验收记录、状态仍是 pending（打开入口 ≠ 用户接受）")
        ok(acc_final["runtime_entry_summary"]["outdated_count"] == 5,
           f"⑦ 相关源变化后版本轴计数前推：outdated_count={acc_final['runtime_entry_summary']['outdated_count']}（3 旧清单 + 新清单 2 条）")
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
