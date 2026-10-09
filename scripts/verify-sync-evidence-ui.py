#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V09-24 UI 真机验证：主工作面「同步证据状态」小摘要 + 按需详情（DESIGN.md §2.10；
契约 docs/sync-evidence-contract.md「接口、界面和交付」）。

用法：python scripts/verify-sync-evidence-ui.py
      （V0924_SHOT_DIR 换截图目录、V0924_KEEP_TMP=1 保留现场、V0924_VITE_PORT 换 vite 端口）

为什么必须跑真浏览器（PLAN.md V09-24 验收）：
  · 「状态未配置/等待证据/漏项/待审/来源已变/通过/失败中文清楚」——这是**上屏**口径，只有真 DOM 里
    读 `data-sync-*` 才算数，读口单测证明不了界面没把不通过涂成绿；
  · 「点击按需详情逐项来源/期望/实际/原因/证据路径」——必须**真点一下**再读，不能只在文字里解释；
  · 「切项目/卸载不串数据」——只有真点第二个项目、再让第一个项目的回包**后到**，才能证明旧响应
    没写进新项目界面；
  · 「小屏画布不受影响」——只有真量 `data-view-host` 的前后包围盒、并在详情打开时量，才算数。

替身范围（如实标注）：
  · **隔离真后端 + 真 vite**（动态空闲端口、临时 TATAI_HOME、夹具项目只落临时区）。
  · `GET /api/projects/:id/sync-status` 由本脚本用 `page.route` **替身**给出，因为 V09-23 后端读口
    与本卡并行施工；替身只造**返回体**，界面判据、DOM、交互全部真实。替身不写账、不调模型。
  · 另有一段 **不替身** 的真实链路核对（M 段）：真后端读口 + 真界面端到端，覆盖**三态**——
    真实未配置（夹具项目尚无契约）、真实配置通过（经隔离后端**唯一写口**登记真契约 + 投放真证据，
    目标字节一致 ⇒ 真后端判 passed）、真实配置失败（改了被清单覆盖的目标字节 ⇒ 真后端判 failed）。
    每态的界面应然状态**只按后端报告字段 + 契约 headline 规则独立算出**再与真 DOM 比对，
    不用 `st in SYNC_UI_STATES`（恒真）或 `should_green = st == "passed"`（取界面自身＝自证）。
  · 替身只造**返回体**，界面判据、DOM、交互全部真实；替身不写账、不调模型。M 段的新页不挂替身。

不杀 8787、不动用户浏览器：后端/vite 全走动态空闲端口（vite 端口默认 5199，被占即拒跑）。
"""
import hashlib
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
    "V0924_SHOT_DIR", os.path.join(REPO, ".工作台", "verify", "sync-evidence-20260930", "ui")
)
# 后端/vite 日志同样是本脚本的输出：默认落在 SHOT_DIR 下，**不再**追加进历史证据目录
# `.工作台/verify/sync-evidence-20260930/`（旧版把 ui-backend.log/ui-vite.log 以 "ab" 追加到那里，
# 会污染历史现场；调用方也可用 V0924_LOG_DIR 显式改到别处）。
LOG_DIR = os.environ.get("V0924_LOG_DIR", os.path.join(SHOT_DIR, "_backend-logs"))
KEEP = os.environ.get("V0924_KEEP_TMP") == "1"
# 0 ⇒ 每次动态取一个空闲端口（默认）；显式给 V0924_VITE_PORT 才固定端口并做占用检查。
VITE_PORT = int(os.environ.get("V0924_VITE_PORT", "0"))
FIX_A = "v0924-sync-a"
FIX_B = "v0924-sync-b"
HANG_MS = 0  # 占位（延迟用「挂起 + 事后回包」实现，不用 sleep 阻塞 Playwright 事件循环）
# 界面 `data-sync-state` 的合法值集（SyncVerdict ∪ {loading,error,scan_error}，见
# src/ui/components/SyncEvidenceStatus.tsx 的 SyncUiState）。真实链路联验用它判「没渲染成意外态」。
SYNC_UI_STATES = {"not_configured", "missing", "passed", "failed", "stale",
                  "needs_review", "invalid", "incomplete", "loading", "error", "scan_error"}

passes = [0]
fails = []
skips = []
step = {"now": "启动"}


def ok(cond, label):
    print(("[ui] PASS " if cond else "[ui] FAIL ") + label)
    if cond:
        passes[0] += 1
    else:
        fails.append(label)


def skip(label):
    print("[ui] SKIP " + label)
    skips.append(label)


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


# 本脚本只访问隔离的本机服务：全部 loopback 请求必须绕过系统 HTTP 代理。
# 系统代理（HTTP_PROXY/HTTPS_PROXY）会把 127.0.0.1 的回环请求也劫走——实测经代理拿回 HTTP 502，
# 而 no_proxy 是否在场由调用方环境决定，不能依赖。故用空 ProxyHandler 的局部 opener：只影响本脚本，
# 不改用户代理设置（V09-24 修复：后端健康检查曾因代理劫持在 120s 等待后误判「未就绪」）。
LOCAL_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _ensure_loopback_no_proxy():
    """把 loopback 显式并入 NO_PROXY：后端/vite 子进程继承本进程环境，别让它们把本机流量交给系统代理。
    只改本脚本进程的环境，不动用户 shell/系统代理设置。"""
    hosts = ("localhost", "127.0.0.1", "::1")
    for key in ("NO_PROXY", "no_proxy"):
        parts = [p for p in os.environ.get(key, "").split(",") if p]
        os.environ[key] = ",".join(parts + [h for h in hosts if h not in parts])


_ensure_loopback_no_proxy()


def http(url, method="GET", body=None, timeout=120):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, method=method, data=data)
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with LOCAL_HTTP.open(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8")
            return resp.status, (json.loads(text) if text.strip().startswith(("{", "[")) else text)
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, text


# ══════════════════════════════ 夹具（契约形状，可被后端读口真实替换） ══════════════════════════════

DESIGN = """# V09-24 UI 夹具设计书

## 1. 夹具设计

### 1.1 夹具能力

夹具能力一：用来说明同步小摘要不该挤坏画布。
"""

PLAN = """# V09-24 UI 夹具施工图

| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |
| --- | --- | --- | --- | --- |
| T-1 | todo | 夹具任务一 | 无 | 夹具任务一按要求跑完 |

### T-1 夹具任务一

**交付**：夹具任务一按要求跑完。
"""

MODULES = {
    "version": 1,
    "generated_at": "2026-09-30T00:00:00+08:00",
    "budget_exhausted": False,
    "modules": [{"id": "src", "path": "src", "name": "夹具代码模块", "file_count": 1, "loc": 6, "deps": []}],
}

SECTION_OK = "V09-24 UI 夹具设计书 / 1. 夹具设计 / 1.1 夹具能力"

BLUEPRINT = {
    "version": 1,
    "baseline_id": "baseline-ui-fixture",
    "generator_version": "v06-05.1",
    "generated_at": "2026-09-30T00:00:00+08:00",
    "source_manifest": [],
    "nodes": [
        {"id": "plan:cap:01", "kind": "capability", "name": "夹具能力一",
         "source_refs": [{"kind": "design_section", "path": ".工作台/design.md",
                          "locator": SECTION_OK, "sha256": None}],
         "related_ids": ["plan:code:src"]},
        {"id": "plan:code:src", "kind": "module", "name": "夹具代码模块",
         "source_refs": [{"kind": "code_module", "path": ".工作台/arch/modules.json", "locator": "src",
                          "sha256": None}],
         "related_ids": ["plan:cap:01"]},
    ],
    "edges": [
        {"source": "plan:cap:01", "target": "plan:code:src", "kind": "design_interface",
         "certainty": "declared",
         "source_refs": [{"kind": "design_section", "path": ".工作台/design.md",
                          "locator": SECTION_OK, "sha256": None}]},
    ],
    "coverage": {
        "design_sections": {"total": 1, "mapped": 1, "unmapped": []},
        "plan_tasks": {"total": 1, "mapped": 1, "unmapped": []},
        "code_modules": {"total": 1, "mapped": 1, "unmapped": []},
        "nodes_total": 2, "nodes_kept": 2, "edges_total": 1, "edges_kept": 1,
        "note": "UI 夹具蓝图（本脚本手写）",
    },
    "omitted": [],
    "model_receipt": None,
    "publish": {"published": True, "reason": None, "validated_at": "2026-09-30T00:00:00+08:00"},
    "based_on": {"model_key": "ui-fixture", "full_key": "ui-fixture",
                 "design_content_sha256": None, "plan_definition_sha256": None, "semantic": False},
}


def make_fixture(root, fix_id):
    proj = os.path.join(root, "work", fix_id)
    write(os.path.join(proj, ".工作台", "design.md"), DESIGN)
    write(os.path.join(proj, ".工作台", "plan.md"), PLAN)
    write(os.path.join(proj, ".工作台", "arch", "modules.json"),
          json.dumps(MODULES, ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(proj, ".工作台", "arch", "blueprint.json"),
          json.dumps(BLUEPRINT, ensure_ascii=False, indent=2) + "\n")
    write(os.path.join(proj, "src", "index.ts"), "export const a = 1;\n")
    return proj


def make_registry(home, projects):
    now = "2026-09-30T00:00:00+08:00"
    write(os.path.join(home, "registry.json"),
          json.dumps({"version": 1, "projects": [
              {"id": pid, "name": name, "path": path, "kind": "backend",
               "registered_at": now, "last_opened_at": now}
              for pid, name, path in projects
          ]}, ensure_ascii=False, indent=2) + "\n")


# ── 契约返回体替身（形状逐字段照 docs/sync-evidence-contract.md §「接口、界面和交付」）──

def item(iid, label, required, verdict, expected, actual, reasons=None, artifacts=None):
    return {
        "id": iid, "label": label, "required": required, "verdict": verdict,
        "expected": expected, "actual": actual, "reasons": reasons or [],
        "artifacts": artifacts or [],
    }


def batch(bid, title, verdict, items, evidence_path=None, active=True, blocks_entry=True,
          historical=None, verified_at=None):
    # `historical` 默认跟随 `active`（2026-10-03 增量核验后的默认口径：历史批次结论来自账本回执）；
    # 显式传 historical=False + active=False 可造「本次显式实时复查」那一档。
    if historical is None:
        historical = not active
    return {
        "batch_id": bid, "title": title, "active": active, "historical": historical,
        "blocks_entry": blocks_entry, "verdict": verdict, "contract_sha256": "a" * 64,
        "evidence_path": evidence_path, "verified_at": verified_at, "items": items,
    }


def report(fix_id, configured, overall, batches, checked_at="2026-09-30T18:20:00+08:00",
           scan_error=None, unregistered=None, collection=None):
    return {"ok": True, "sync": {
        "project_id": fix_id, "configured": configured, "overall": overall,
        "checked_at": checked_at, "scan_error": scan_error, "batches": batches,
        "unregistered_evidence": unregistered or [],
        "collection": collection or {"complete": True, "reasons": []},
    }}


EV = ".工作台/work/sync-inbox/batch-1.evidence.json"

STUB_UNCONFIGURED = report(FIX_A, False, "not_configured", [])

STUB_AWAITING = report(FIX_A, True, "missing", [
    batch("batch-1", "2026-09-30 塔台同步", "missing", [
        item("i-1", "设计书哈希与登记一致", True, "missing", {"path": "DESIGN.md", "sha256": "b" * 64},
             None, ["证据包不存在"]),
        item("i-2", "六图同快照取齐", True, "missing", {"baseline_id": "bl-x"}, None, ["证据包不存在"]),
    ], evidence_path=None),
])

STUB_DEFICIENT = report(FIX_A, True, "failed", [
    batch("batch-1", "2026-09-30 塔台同步", "failed", [
        item("i-1", "设计书哈希与登记一致", True, "passed",
             {"path": "DESIGN.md", "sha256": "b" * 64},
             {"path": "DESIGN.md", "sha256": "b" * 64},
             artifacts=[{"path": EV, "sha256": "c" * 64}]),
        item("i-2", "施工图任务定义逐项一致", True, "missing",
             {"task_ids": ["V09-23", "V09-24"]}, {"task_ids": ["V09-23"]}, ["证据包未列出该项"]),
        item("i-3", "六图同快照取齐", False, "failed",
             {"collection": {"complete": True}}, {"collection": {"complete": False}},
             ["collection.complete=false"], artifacts=[{"path": EV, "sha256": "c" * 64}]),
    ], evidence_path=EV),
], unregistered=[
    {"path": ".工作台/work/sync-inbox/batch-9.evidence.json", "batch_id": "batch-9",
     "reason": "未登记批次，不采纳"},
], collection={"complete": True, "reasons": []})

# 契约把 missing 与 failed 分开：`missing`＝证据缺失（等待证据），`failed`＝对账发现不一致（发现缺项）
STUB_MISSING = STUB_DEFICIENT

STUB_PASSED = report(FIX_A, True, "passed", [
    batch("batch-1", "2026-09-30 塔台同步", "passed", [
        item("i-1", "设计书哈希与登记一致", True, "passed",
             {"path": "DESIGN.md", "sha256": "b" * 64},
             {"path": "DESIGN.md", "sha256": "b" * 64},
             artifacts=[{"path": EV, "sha256": "c" * 64}]),
        item("i-2", "施工图任务定义逐项一致", True, "passed",
             {"task_ids": ["V09-23", "V09-24"]}, {"task_ids": ["V09-23", "V09-24"]},
             artifacts=[{"path": EV, "sha256": "c" * 64}]),
    ], evidence_path=EV),
], checked_at="2026-09-30T18:33:00+08:00")

STUB_STALE = report(FIX_A, True, "stale", [
    batch("batch-1", "2026-09-30 塔台同步", "stale", [
        item("i-1", "设计书哈希与登记一致", True, "stale",
             {"path": "DESIGN.md", "sha256": "b" * 64},
             {"path": "DESIGN.md", "sha256": "d" * 64},
             ["登记来源在当前目标上已变化"], artifacts=[{"path": EV, "sha256": "c" * 64}]),
    ], evidence_path=EV),
])

STUB_NEEDS_REVIEW = report(FIX_A, True, "needs_review", [
    batch("batch-1", "2026-09-30 塔台同步", "needs_review", [
        item("i-1", "独立审核引用", True, "needs_review", {"task_id": "V09-09"},
             {"state": "submitted"}, ["尚无有效独立审核证据"]),
    ], evidence_path=EV),
])

STUB_INVALID = report(FIX_A, True, "invalid", [
    batch("batch-1", "2026-09-30 塔台同步", "invalid", [
        item("i-1", "设计书哈希与登记一致", True, "invalid",
             {"path": "DESIGN.md", "sha256": "b" * 64},
             {"path": "DESIGN.md", "sha256": "e" * 64}, ["登记哈希与实际目标不符"],
             artifacts=[{"path": EV, "sha256": "c" * 64}]),
    ], evidence_path=EV),
])

STUB_INCOMPLETE = report(FIX_A, True, "incomplete", [
    batch("batch-1", "2026-09-30 塔台同步", "incomplete", [
        item("i-1", "六图同快照取齐", True, "incomplete", {"collection": {"complete": True}},
             {"collection": {"complete": False}}, ["达到扫描上限，未取齐"]),
    ], evidence_path=EV),
], collection={"complete": False, "reasons": ["达到扫描上限，未取齐"]})

# 通过 + 扫描错误：界面**不得**显绿（失败不能默认绿）
STUB_PASSED_SCAN_ERROR = report(FIX_A, True, "passed", [
    batch("batch-1", "2026-09-30 塔台同步", "passed", [
        item("i-1", "设计书哈希与登记一致", True, "passed", {"path": "DESIGN.md"}, {"path": "DESIGN.md"}),
    ], evidence_path=EV),
], scan_error="inbox 目录不可读：EACCES（本轮未取齐）")

# 通过但范围未取齐：同样不得显绿
STUB_PASSED_INCOMPLETE_SCOPE = report(FIX_A, True, "passed", [
    batch("batch-1", "2026-09-30 塔台同步", "passed", [
        item("i-1", "设计书哈希与登记一致", True, "passed", {"path": "DESIGN.md"}, {"path": "DESIGN.md"}),
    ], evidence_path=EV),
], collection={"complete": False, "reasons": ["达到扫描上限，未取齐"]})

STUB_B_NOT_CONFIGURED = report(FIX_B, False, "not_configured", [])

# ── 返工反例（Codex 复查 2026-09-30）：未配置不得吞掉后端失败结论/未取齐 ──
# configured=false 但后端已给出明确失败/未取齐结论：界面必须如实显示该结论，**不得**误显示「未配置」。
STUB_UNCONFIGURED_INVALID = report(FIX_A, False, "invalid", [
    batch("batch-1", "声明未登记但扫描失败", "invalid", [
        item("i-1", "设计书哈希与登记一致", True, "invalid",
             {"path": "DESIGN.md"}, {"path": "DESIGN.md"}, ["登记哈希与实际目标不符"]),
    ], evidence_path=EV),
], collection={"complete": False, "reasons": ["扫描未取齐"]})

STUB_UNCONFIGURED_INCOMPLETE = report(FIX_A, False, "incomplete", [
    batch("batch-1", "声明未登记但范围未取齐", "incomplete", [
        item("i-1", "六图同快照取齐", True, "incomplete", {"collection": {"complete": True}},
             {"collection": {"complete": False}}, ["达到扫描上限，未取齐"]),
    ], evidence_path=EV),
], collection={"complete": False, "reasons": ["达到扫描上限，未取齐"]})

# ── active 与已 superseded 历史：范围/差项按现行批次，历史按**账本回执**展示（不再实时求值）──
HIST_VERIFIED_AT = "2026-09-30T17:00:00+08:00"
STUB_ACTIVE_AND_HISTORY = report(FIX_A, True, "failed", [
    batch("batch-2", "2026-09-30 现行批次", "failed", [
        item("a-1", "现行必需一", True, "passed", {"path": "DESIGN.md"}, {"path": "DESIGN.md"},
             artifacts=[{"path": EV, "sha256": "c" * 64}]),
        item("a-2", "现行必需二（缺）", True, "missing", {"path": "PLAN.md"}, None, ["证据包未列出该项"]),
        item("a-3", "现行可选", False, "passed", {"k": 1}, {"k": 1}),
    ], evidence_path=EV, active=True),
    # 有回执的历史批次：结论与核验时间都来自账本，逐项 actual 为 null、reasons 注明「历史回执」
    batch("batch-1", "2026-09-30 历史批次（已被取代）", "passed", [
        item("h-1", "历史必需一", True, "passed", None, None, ["历史回执（%s）：不是本次实时核验" % HIST_VERIFIED_AT]),
        item("h-2", "历史必需二（缺）", True, "missing", None, None, ["历史回执（%s）：不是本次实时核验" % HIST_VERIFIED_AT]),
    ], evidence_path=EV, active=False, historical=True, verified_at=HIST_VERIFIED_AT),
    # 无回执的历史批次：明确「未核验」
    batch("batch-0", "2026-09-30 历史批次（无回执）", "missing", [
        item("z-1", "历史必需（未核验）", True, "missing", None, None, ["被取代的历史批次：账本无有效核验回执——明确未核验"]),
    ], evidence_path=None, active=False, historical=True, verified_at=None),
])


def good_sync(fix_id=FIX_A):
    """合格返回体的基线（供边界反例逐项改坏；刻意写成会被 shared 契约接受的最小完整体）"""
    return {
        "project_id": fix_id, "configured": True, "overall": "passed",
        "checked_at": "2026-09-30T18:20:00+08:00", "scan_error": None,
        "batches": [batch("batch-1", "t", "passed", [
            item("i-1", "l", True, "passed", {"a": 1}, {"a": 1})], evidence_path=EV)],
        "unregistered_evidence": [],
        "collection": {"complete": True, "reasons": []},
    }


def shape_bad_cases():
    """必要字段边界反例：每例只改坏一处，界面都必须「读取失败」且不显绿、不崩溃。"""
    cases = []
    s = good_sync(); s["batches"] = [None]
    cases.append(("批次为 null", s))
    s = good_sync(); s["batches"][0]["items"] = None
    cases.append(("批次 items 为 null", s))
    s = good_sync(); s["batches"][0]["items"][0]["artifacts"] = [None]
    cases.append(("证据 artifact 为 null", s))
    s = good_sync(); s["batches"][0]["items"][0]["reasons"] = "坏原因"
    cases.append(("item.reasons 非字符串数组", s))
    s = good_sync(); s["batches"][0]["verdict"] = "weird"
    cases.append(("批次 verdict 非法", s))
    s = good_sync(); s["batches"][0]["items"][0]["verdict"] = "not_configured"
    cases.append(("逐项 verdict 非法（不得用 not_configured）", s))
    s = good_sync(); s["batches"][0]["active"] = "yes"
    cases.append(("批次 active 非布尔", s))
    s = good_sync(fix_id=FIX_B)
    cases.append(("project_id 与请求项目不一致", s))
    s = good_sync(); s["collection"] = {"complete": "yes", "reasons": []}
    cases.append(("collection.complete 非布尔", s))
    s = good_sync(); s["unregistered_evidence"] = [{"path": "x", "batch_id": None}]
    cases.append(("未登记证据缺 reason", s))
    return cases


# ══════════════════════════════ 后端 / vite ══════════════════════════════

class Backend:
    def __init__(self, home, port, log_path):
        env = dict(os.environ)
        env["TATAI_HOME"] = home
        env["TATAI_PORT"] = str(port)
        env["TATAI_SEMANTIC_AUTO"] = "0"
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


# ══════════════ 真后端写口（隔离 TATAI_HOME 内）：登记真契约 / 投放证据 ══════════════
# M 段要覆盖「真实未配置 / 真实配置失败 / 真实配置通过」三态，配置态必须由**真后端**产生，不能用替身。
# 登记走唯一写服：从隔离 TATAI_HOME 的服务描述符取 host/port/token，POST 真写口。只碰隔离库与隔离项目。

def _descriptor(home):
    with open(os.path.join(home, "work-service.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def work_post(home, path, body):
    """带描述符 token 的本机写口 POST（只打隔离后端）。返回 (status, body)。"""
    desc = _descriptor(home)
    url = "http://%s:%d%s" % (desc["host"], desc["port"], path)
    req = urllib.request.Request(url, method="POST", data=json.dumps(body).encode("utf-8"))
    req.add_header("content-type", "application/json")
    req.add_header("x-tatai-work-token", desc["token"])
    try:
        with LOCAL_HTTP.open(req, timeout=90) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(text)
        except Exception:  # noqa: BLE001
            return e.code, text


def sha_file(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def contract_sha256(contract):
    """契约内容地址：用**产品自己的** syncContractSha256（经 tsx 调真模块）算，不在脚本里另造一套。"""
    fd, tmp = tempfile.mkstemp(suffix=".contract.json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(contract, f, ensure_ascii=False)
        env = dict(os.environ, TATAI_CONTRACT_FILE=tmp)
        proc = subprocess.run(
            ["node", "--import", "tsx", "--input-type=module", "-e",
             "import {validateSyncContract, syncContractSha256} from './src/server/work/syncContract.ts';"
             "import fs from 'node:fs';"
             "const c=validateSyncContract(JSON.parse(fs.readFileSync(process.env.TATAI_CONTRACT_FILE,'utf8')));"
             "process.stdout.write(syncContractSha256(c));"],
            cwd=REPO, env=env, capture_output=True, text=True,
        )
        sha = proc.stdout.strip()
        if proc.returncode != 0 or len(sha) != 64:
            raise RuntimeError("契约内容地址计算失败：rc=%s out=%r err=%r"
                               % (proc.returncode, proc.stdout[-300:], proc.stderr[-300:]))
        return sha
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def register_real_contract(home, project_id, contract, sha):
    """经隔离后端唯一写口登记真契约（幂等键与产品 buildRegisterContractCommand 同形）。"""
    cmd = {
        "schema_version": 2,
        "project_id": project_id,
        "change_id": "change-m-real-ui",
        "entity_id": "sync:%s" % contract["batch_id"],
        "expected_revision": None,
        "type": "sync.contract_registered",
        "actor_id": "v0924-ui",
        "role": "designer",
        "idempotency_key": "sync-contract:%s:%s" % (contract["batch_id"], sha[:24]),
        "payload": contract,
    }
    return work_post(home, "/api/work/command", cmd)


def project_root_of(home, pid):
    with open(os.path.join(home, "registry.json"), "r", encoding="utf-8") as f:
        reg = json.load(f)
    for p in reg.get("projects") or []:
        if p.get("id") == pid:
            return p.get("path")
    return None


# ── 独立预期：只按**后端报告字段 + 契约 headline 规则**算界面应然状态，**不读界面自己的 data-sync-state** ──
# 与 src/ui/components/SyncEvidenceStatus.tsx 的 headlineStateOf/isGreen 同一份**契约**（不是同一个读数），
# 用来消灭复审指出的自证：`st in SYNC_UI_STATES` 恒真、`should_green = st == "passed"` 取 UI 自身。

def expected_headline(rep):
    if rep.get("scan_error") is not None:
        return "scan_error"
    overall = rep.get("overall")
    if overall not in ("passed", "not_configured"):
        return overall
    if (rep.get("collection") or {}).get("complete") is not True:
        return "incomplete"
    if not rep.get("configured") and overall == "not_configured":
        return "not_configured"
    if not rep.get("configured") or overall == "not_configured":
        return "invalid"
    return "passed"


def expected_green(rep):
    return (expected_headline(rep) == "passed" and rep.get("scan_error") is None
            and (rep.get("collection") or {}).get("complete") is True)


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
            with LOCAL_HTTP.open("http://localhost:%d/" % port, timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("vite %d 未就绪" % port)


# ══════════════════════════════ 浏览器侧工具 ══════════════════════════════

ROOT = "[data-sync-evidence-status]"
VIEW_HOST = "[data-view-host]"

STUB = {"body": None, "status": 200, "hang": False, "hung": [], "requests": [], "all": []}


def sync_requests():
    return [r for r in STUB["requests"]]


def attr(page, selector, name):
    loc = page.locator(selector)
    if loc.count() == 0:
        return None
    return loc.first.get_attribute(name)


def sync_attr(page, name):
    return attr(page, ROOT, name)


def label(page):
    loc = page.locator("[data-sync-label]")
    return loc.first.inner_text().strip() if loc.count() else None


def wait_label(page, want, timeout=12.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        cur = label(page)
        if cur is not None and want in cur:
            return True
        page.wait_for_timeout(200)
    return False


def set_stub(payload, status=200):
    STUB["body"] = payload
    STUB["status"] = status
    STUB["hang"] = False


def handle_route(route, request):
    STUB["requests"].append({"method": request.method, "url": request.url})
    if "/sync-status" not in request.url:
        route.continue_()
        return
    if STUB["hang"]:
        # 挂起不回（不用 sleep 阻塞事件循环）；稍后由脚本手动回包，模拟「旧项目的回包后到」
        STUB["hung"].append(route)
        return
    if STUB["body"] is None:
        route.continue_()
        return
    route.fulfill(
        status=STUB["status"], content_type="application/json",
        body=json.dumps(STUB["body"], ensure_ascii=False),
    )


def open_project(page, base, pid, wait=1200):
    page.goto("%s/#p/%s" % (base, pid), wait_until="domcontentloaded")
    page.wait_for_timeout(wait)


def goto_project(page, base, pid, wait=1500):
    page.evaluate("(p) => { window.location.hash = '#p/' + p; }", pid)
    page.wait_for_timeout(wait)


# ══════════════════════════════ 断言段 ══════════════════════════════

def launch_browser(p):
    """真浏览器：优先 Playwright 自带 chromium；本机未装（ms-playwright 空）时退回系统 Edge。
    本机实测 chromium 包未下载，而 Edge 是系统自带——两者都是真 Chromium 内核，不改变判据。"""
    # 浏览器同样不该把 loopback 交给系统代理（与脚本其它回环请求同口径）。
    args = ["--no-proxy-server", "--proxy-bypass-list=*"]
    chan = os.environ.get("V0924_BROWSER_CHANNEL", "")
    if chan:
        return p.chromium.launch(headless=True, channel=chan, args=args), "channel=%s" % chan
    try:
        return p.chromium.launch(headless=True, args=args), "bundled-chromium"
    except Exception as e:  # noqa: BLE001
        info("自带 chromium 起不来（%s），退回系统 Edge" % str(e).splitlines()[0][:120])
        return p.chromium.launch(headless=True, channel="msedge", args=args), "channel=msedge"


def run_browser(vite_port, backend, home):
    base = "http://localhost:%d" % vite_port
    os.makedirs(SHOT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser, which = launch_browser(p)
        info("浏览器：%s" % which)
        page = browser.new_context(viewport={"width": 1680, "height": 1000}).new_page()
        page.on("request", lambda r: STUB["all"].append((r.method, r.url)))
        page.route("**/api/projects/*/sync-status*", handle_route)

        # ── A 未配置：小摘要入口在主工作面，且中文状态清楚、不显绿 ──
        step["now"] = "A 未配置"
        set_stub(STUB_UNCONFIGURED)
        open_project(page, base, FIX_A, wait=2500)
        if page.locator(ROOT).count() == 0:
            # 改前（未实现）走这里：功能整体不存在＝红证据。后续各段都以本元素为前提，
            # 不在这里空跑 30s 超时，直接如实收尾并留档。
            ok(False, "主项目工作面出现同步证据小摘要入口（%s）" % ROOT)
            info("改前功能不存在：V09-24 的同步摘要入口在界面上没有实现（红证据，后续段不适用）")
            page.screenshot(path=os.path.join(SHOT_DIR, "00-red-before-impl.png"))
            browser.close()
            return
        ok(True, "主项目工作面出现同步证据小摘要入口（%s）" % ROOT)
        ok(label(page) is not None and "未配置" in label(page),
           "未配置态中文清楚（label=%r）" % (label(page),))
        ok(sync_attr(page, "data-sync-state") == "not_configured",
           "未配置态状态键 data-sync-state=%r" % (sync_attr(page, "data-sync-state"),))
        ok(sync_attr(page, "data-sync-green") == "0",
           "未配置**不显绿**（data-sync-green=%r）" % (sync_attr(page, "data-sync-green"),))
        ok(page.locator(ROOT).inner_text().find("未配置") >= 0, "未配置态文案上屏")
        # 未配置也要给「实际核对时间」（来自接口 checked_at）
        ok((sync_attr(page, "data-sync-checked-at") or "") == "2026-09-30T18:20:00+08:00",
           "核对时间来自接口 checked_at（%r）" % (sync_attr(page, "data-sync-checked-at"),))
        page.screenshot(path=os.path.join(SHOT_DIR, "01-not-configured.png"))

        # ── B 等待证据：配置了契约、但还没有证据包 ──
        step["now"] = "B 等待证据"
        set_stub(STUB_AWAITING)
        page.locator("[data-sync-refresh]").click()
        ok(wait_label(page, "等待证据"), "配置了契约但没有证据包 ⇒ 「等待证据」（label=%r）" % (label(page),))
        ok(sync_attr(page, "data-sync-green") == "0",
           "等待证据**不显绿**（data-sync-green=%r）" % (sync_attr(page, "data-sync-green"),))

        # ── C 发现缺项（契约：missing=等待证据、failed=对账发现不一致）：逐项漏项、必需项计数、不显绿 ──
        step["now"] = "C 发现缺项"
        set_stub(STUB_DEFICIENT)
        page.locator("[data-sync-refresh]").click()
        ok(wait_label(page, "发现缺项"), "证据包在但对账发现不一致 ⇒ 「发现缺项」（label=%r）" % (label(page),))
        ok(sync_attr(page, "data-sync-state") == "failed",
           "发现缺项态 state=failed（%r）" % (sync_attr(page, "data-sync-state"),))
        ok(sync_attr(page, "data-sync-green") == "0",
           "缺项**不显绿**（data-sync-green=%r）" % (sync_attr(page, "data-sync-green"),))
        ok(sync_attr(page, "data-sync-items") == "3" and sync_attr(page, "data-sync-items-required") == "2",
           "范围项数来自接口（共 %r 项 / 必需 %r 项）"
           % (sync_attr(page, "data-sync-items"), sync_attr(page, "data-sync-items-required")))
        ok(sync_attr(page, "data-sync-items-missing") == "1",
           "漏项数点名为 %r（必需项缺 1）" % (sync_attr(page, "data-sync-items-missing"),))
        ok("未登记" in (sync_attr(page, "data-sync-unregistered-count") or "x")
           or (sync_attr(page, "data-sync-unregistered-count") == "1"),
           "未登记证据如实计数（data-sync-unregistered-count=%r）"
           % (sync_attr(page, "data-sync-unregistered-count"),))
        page.screenshot(path=os.path.join(SHOT_DIR, "02-missing.png"))

        # ── D 详情：真点一下，逐项 来源/期望/实际/原因/证据路径 ──
        step["now"] = "D 详情"
        page.locator("[data-sync-detail-toggle]").first.click()
        page.wait_for_timeout(400)
        detail = page.locator("[data-sync-detail-body]")
        ok(detail.count() == 1, "点摘要 ⇒ 打开按需详情（data-sync-detail-body）")
        ok(detail.count() == 1 and detail.first.get_attribute("data-sync-detail-shape") == "overlay",
           "详情是**浮层**（不占纵向排版、不挤画布）")
        rows = page.locator("[data-sync-item]")
        ok(rows.count() == 3, "详情逐项列出全部 %d 项（实到 %d 项，不抽样）" % (3, rows.count()))
        row2 = page.locator("[data-sync-item='i-2']")
        ok(row2.count() == 1, "漏项 i-2 逐项在场")
        if row2.count() == 1:
            ok(row2.first.get_attribute("data-sync-item-verdict") == "missing",
               "i-2 逐项 verdict=missing")
            exp = row2.locator("[data-sync-item-expected]").inner_text()
            act = row2.locator("[data-sync-item-actual]").inner_text()
            ok("V09-23" in exp and "V09-24" in exp, "逐项给「期望」（%r）" % (exp[:70],))
            ok("V09-23" in act and "V09-24" not in act, "逐项给「实际」（%r）" % (act[:70],))
            reasons = row2.locator("[data-sync-item-reason]").all_inner_texts()
            ok(len(reasons) >= 1 and any("证据包未列出" in r for r in reasons),
               "逐项给「原因」（%r）" % (reasons[:1],))
        row3 = page.locator("[data-sync-item='i-3']")
        ok(row3.locator("[data-sync-item-artifact]").count() >= 1,
           "有证据的行给「证据路径」入口（%d 条）" % row3.locator("[data-sync-item-artifact]").count())
        art_text = row3.locator("[data-sync-item-artifact]").first.inner_text()
        ok(EV in art_text or ".evidence.json" in art_text,
           "证据路径可读（%r）" % (art_text[:70],))
        ok(page.locator("[data-sync-unregistered-row]").count() == 1,
           "未登记批次逐条列出且不被采纳")
        ok("只对已登记范围作结论" in page.locator("[data-sync-detail-body]").inner_text(),
           "详情写明「只对已登记范围作结论」（范围之外不声称覆盖）")
        page.screenshot(path=os.path.join(SHOT_DIR, "03-detail-missing.png"))

        # ── E 通过：只有必需项全过 + 范围取齐才显绿 ──
        step["now"] = "E 通过"
        set_stub(STUB_PASSED)
        page.locator("[data-sync-refresh]").click()
        ok(wait_label(page, "同步通过"), "必需项全过 ⇒ 「同步通过」（label=%r）" % (label(page),))
        ok(sync_attr(page, "data-sync-green") == "1" and sync_attr(page, "data-sync-state") == "passed",
           "通过态才显绿（green=%r, state=%r）"
           % (sync_attr(page, "data-sync-green"), sync_attr(page, "data-sync-state")))
        ok(sync_attr(page, "data-sync-checked-at") == "2026-09-30T18:33:00+08:00",
           "通过态核对时间＝本次实际核对时间（%r）" % (sync_attr(page, "data-sync-checked-at"),))
        page.screenshot(path=os.path.join(SHOT_DIR, "04-passed.png"))

        # ── F 失败不能默认绿：scan_error / 范围未取齐 ──
        step["now"] = "F 检查失败优先"
        set_stub(STUB_PASSED_SCAN_ERROR)
        page.locator("[data-sync-refresh]").click()
        ok(wait_label(page, "检查失败"), "scan_error 非空 ⇒ 「检查失败」（label=%r）" % (label(page),))
        ok(sync_attr(page, "data-sync-green") == "0" and sync_attr(page, "data-sync-state") == "scan_error",
           "扫描出错**绝不显绿**（green=%r, state=%r）"
           % (sync_attr(page, "data-sync-green"), sync_attr(page, "data-sync-state")))
        set_stub(STUB_PASSED_INCOMPLETE_SCOPE)
        page.locator("[data-sync-refresh]").click()
        page.wait_for_timeout(600)
        ok(sync_attr(page, "data-sync-green") == "0",
           "overall=passed 但 collection 未取齐 ⇒ 不显绿（state=%r, green=%r）"
           % (sync_attr(page, "data-sync-state"), sync_attr(page, "data-sync-green")))
        ok(sync_attr(page, "data-sync-state") == "incomplete" and "检查未完成" in (label(page) or ""),
           "范围未取齐 ⇒ 「检查未完成」（state=%r, label=%r）"
           % (sync_attr(page, "data-sync-state"), label(page)))
        ok("未取齐" in page.locator(ROOT).inner_text(), "未取齐在摘要里可见")
        page.screenshot(path=os.path.join(SHOT_DIR, "05-scan-error-not-green.png"))

        # ── G 来源已变 / 待审核 / 检查失败 / 检查未完成 ──
        step["now"] = "G 来源已变/待审核/检查失败/未完成"
        for stub, want, state in (
            (STUB_STALE, "来源已变", "stale"),
            (STUB_NEEDS_REVIEW, "待审核", "needs_review"),
            (STUB_INVALID, "检查失败", "invalid"),
            (STUB_INCOMPLETE, "检查未完成", "incomplete"),
        ):
            set_stub(stub)
            page.locator("[data-sync-refresh]").click()
            ok(wait_label(page, want), "%s 中文状态清楚（label=%r, 期望 state=%s）" % (want, label(page), state))
            ok(sync_attr(page, "data-sync-state") == state,
               "%s：data-sync-state=%r" % (want, sync_attr(page, "data-sync-state")))
            ok(sync_attr(page, "data-sync-green") == "0", "%s 不显绿" % want)
            page.screenshot(path=os.path.join(SHOT_DIR, "06-%s.png" % state))
        if page.locator("[data-sync-detail-body]").count() == 1:
            page.locator("[data-sync-detail-close]").first.click()
            page.wait_for_timeout(200)

        # ── H 接口失败（替身 500）：如实报错、不显绿、不冒充未配置 ──
        step["now"] = "H 接口失败（替身 500）"
        set_stub({"ok": False, "error": {"code": "INTERNAL", "message": "替身故障：读口 500"}}, status=500)
        page.locator("[data-sync-refresh]").click()
        ok(wait_label(page, "读取失败"), "接口失败 ⇒ 「读取失败」（label=%r）" % (label(page),))
        ok(sync_attr(page, "data-sync-state") == "error" and sync_attr(page, "data-sync-green") == "0",
           "接口失败**不显绿**且与「未配置」分开（state=%r）" % (sync_attr(page, "data-sync-state"),))
        ok("未配置" not in (label(page) or ""), "接口失败不得冒充「未配置」")
        err_text = page.locator("[data-sync-error]").first.inner_text() if page.locator("[data-sync-error]").count() else ""
        ok("INTERNAL" in err_text or "替身故障" in err_text, "失败原因如实上屏（%r）" % (err_text[:70],))
        page.screenshot(path=os.path.join(SHOT_DIR, "07-api-error.png"))

        # ── H2 返回体不合契约（200 但缺字段）：逐项校验拦下，**不拿半截体渲染出绿** ──
        step["now"] = "H2 返回体不合契约"
        set_stub({"ok": True})
        page.locator("[data-sync-refresh]").click()
        ok(wait_label(page, "读取失败"), "200 但没有报告体 ⇒ 「读取失败」（label=%r）" % (label(page),))
        set_stub({"ok": True, "sync": {
            "project_id": FIX_A, "configured": True, "overall": "passed",
            "checked_at": "2026-09-30T18:40:00+08:00", "scan_error": None, "batches": [],
        }})
        page.locator("[data-sync-refresh]").click()
        page.wait_for_timeout(700)
        ok(sync_attr(page, "data-sync-state") == "error" and sync_attr(page, "data-sync-green") == "0",
           "缺 unregistered_evidence/collection 的「passed」返回体被逐项校验拦下，**不显绿**"
           "（state=%r, green=%r）" % (sync_attr(page, "data-sync-state"), sync_attr(page, "data-sync-green")))
        err_text2 = page.locator("[data-sync-error]").first.inner_text() if page.locator("[data-sync-error]").count() else ""
        ok("SYNC_STATUS_SHAPE" in err_text2, "不合契约的返回体给出点名理由（%r）" % (err_text2[:80],))

        # ── I 手动刷新 + 轮询：都不发写操作、不调模型 ──
        step["now"] = "I 刷新与轮询"
        STUB["requests"].clear()
        set_stub(STUB_PASSED)
        page.locator("[data-sync-refresh]").click()
        ok(wait_label(page, "同步通过"), "手动刷新读口可用（label=%r）" % (label(page),))
        ok(len(sync_requests()) >= 1, "手动刷新真的发了读请求（%d 次）" % len(sync_requests()))
        n_before = len(sync_requests())
        set_stub(STUB_STALE)
        ok(wait_label(page, "来源已变", timeout=25), "轮询合理频率自动取数（无需点击即更新，label=%r）" % (label(page),))
        ok(len(sync_requests()) > n_before, "轮询确实发了新读请求（%d → %d）" % (n_before, len(sync_requests())))
        bad = [r for r in sync_requests() if r["method"] != "GET"]
        ok(not bad, "同步摘要只发 GET 读口，零写操作（非 GET：%r）" % (bad[:3],))

        # ── J 切项目不串数据：旧项目的回包**后到**也不得写进新项目界面 ──
        step["now"] = "J 切项目不串数据"
        set_stub(STUB_PASSED)
        goto_project(page, base, FIX_A, wait=1500)
        ok(wait_label(page, "同步通过"), "切回 A：A 的通过态上屏（label=%r）" % (label(page),))
        # 让 A 的下一次轮询**挂起**，随后切到 B
        STUB["hang"] = True
        STUB["hung"].clear()
        deadline = time.time() + 25
        while time.time() < deadline and not STUB["hung"]:
            page.wait_for_timeout(300)
        ok(len(STUB["hung"]) >= 1, "A 的在途读请求已被挂起（%d 个），准备做「旧回包后到」反例" % len(STUB["hung"]))
        set_stub(STUB_B_NOT_CONFIGURED)
        goto_project(page, base, FIX_B, wait=2500)
        ok(wait_label(page, "未配置", timeout=10), "切到 B：B 的未配置态上屏（label=%r）" % (label(page),))
        # 现在把 A 的旧回包补发（若已被 Abort 取消，则说明取消生效，同样满足要求）
        late_delivered = 0
        for r in STUB["hung"]:
            try:
                r.fulfill(status=200, content_type="application/json",
                          body=json.dumps(STUB_PASSED, ensure_ascii=False))
                late_delivered += 1
            except Exception as e:  # noqa: BLE001
                info("挂起的 A 回包补发失败（说明在途请求已被取消）：%s" % str(e)[:120])
        info("A 的旧回包补发成功 %d 个" % late_delivered)
        page.wait_for_timeout(2500)
        ok(label(page) is not None and "未配置" in label(page),
           "旧项目 A 的回包后到 ⇒ B 的界面**不被写脏**（label=%r）" % (label(page),))
        ok(sync_attr(page, "data-sync-green") == "0", "B 未配置，仍不显绿")
        page.screenshot(path=os.path.join(SHOT_DIR, "08-project-switch-no-bleed.png"))

        # ── K 小屏：画布不被挤坏、详情不吃画布 ──
        step["now"] = "K 小屏画布不受影响"
        set_stub(STUB_MISSING)
        set_page = page
        set_page.set_viewport_size({"width": 1280, "height": 720})
        goto_project(page, base, FIX_A, wait=2500)
        ok(wait_label(page, "发现缺项", timeout=10), "小屏下摘要仍可读（label=%r）" % (label(page),))
        page.locator('button[data-view="arch"]').click()
        page.wait_for_timeout(1800)
        nodes_before = page.locator("[data-project-node]").count()
        box_before = page.locator(VIEW_HOST).bounding_box()
        bar_box = page.locator(ROOT).bounding_box()
        info("画布宿主前后对照前的包围盒：%r / 节点 %d" % (box_before, nodes_before))
        ok(bar_box is not None and bar_box["height"] <= 44,
           "摘要条只占一行（高 %.1fpx，不挤画布）" % (bar_box["height"] if bar_box else -1))
        page.screenshot(path=os.path.join(SHOT_DIR, "09-small-canvas-closed.png"))
        page.locator("[data-sync-detail-toggle]").first.click()
        page.wait_for_timeout(500)
        ok(page.locator("[data-sync-detail-body]").count() == 1, "小屏下详情可打开")
        box_after = page.locator(VIEW_HOST).bounding_box()
        nodes_after = page.locator("[data-project-node]").count()
        ok(box_before == box_after,
           "详情打开**不吃画布**：画布宿主包围盒逐值不变（%r → %r）" % (box_before, box_after))
        ok(nodes_after == nodes_before and nodes_before > 0,
           "详情打开后画布节点数不变（%d → %d）" % (nodes_before, nodes_after))
        page.screenshot(path=os.path.join(SHOT_DIR, "10-small-canvas-detail-open.png"))
        page.locator("[data-sync-detail-close]").first.click()
        page.wait_for_timeout(300)
        ok(page.locator("[data-sync-detail-body]").count() == 0, "详情可关闭（不常驻遮图）")
        # 不挤坏：整页不因新增这一行出现整体滚动；把这一行隐藏后，画布宿主**恰好**长回这一行的高度
        # （说明它只占自己那一行，没有连带挤压/错位别的元素）。
        no_scroll = page.evaluate(
            "() => document.documentElement.scrollHeight <= window.innerHeight + 1"
        )
        ok(no_scroll, "新增一行后整页仍不出现整体纵向滚动（小屏 1280x720）")
        delta = page.evaluate(
            "() => { const bar = document.querySelector('[data-sync-evidence-status]');"
            " const host = document.querySelector('[data-view-host]');"
            " const h0 = host.getBoundingClientRect().height;"
            " const bh = bar.getBoundingClientRect().height;"
            " bar.style.display = 'none';"
            " const h1 = host.getBoundingClientRect().height;"
            " bar.style.display = '';"
            " return { delta: Math.round((h1 - h0) * 10) / 10, bar: Math.round(bh * 10) / 10 }; }"
        )
        info("隐藏摘要条前后画布宿主高度差：%r" % (delta,))
        ok(abs(delta["delta"] - delta["bar"]) <= 1.0,
           "隐藏摘要条后画布宿主恰好长回一行（%.1fpx ≈ 条高 %.1fpx）——只占自己那一行"
           % (delta["delta"], delta["bar"]))

        # ── L 不加页签、不动既有导航 ──
        step["now"] = "L 不加大页签"
        ok(page.locator("[data-main-nav] button").count() == 6,
           "主导航仍是 6 页（V09-62 新增「交付总览」后：交付总览 + 既有 5 页；实到 %d）" % page.locator("[data-main-nav] button").count())
        ok(page.locator("[data-aux-nav] button").count() == 2,
           "辅助入口仍是 2 项（实到 %d）" % page.locator("[data-aux-nav] button").count())
        ok(page.locator("[data-project-status-bar]").count() == 1,
           "原顶部状态条仍在（未被替换）")

        # ── N 未配置不得吞掉后端失败结论/未取齐（Codex 复查 2026-09-30）──
        step["now"] = "N 未配置降级"
        page.goto("%s/?case=n#p/%s" % (base, FIX_A), wait_until="domcontentloaded")
        page.wait_for_timeout(1800)
        set_stub(STUB_UNCONFIGURED_INVALID)
        page.locator("[data-sync-refresh]").click()
        ok(wait_label(page, "检查失败", timeout=10),
           "configured=false + overall=invalid ⇒ 如实显示「检查失败」（label=%r）" % (label(page),))
        ok(sync_attr(page, "data-sync-state") == "invalid",
           "未配置不吞后端 invalid 结论：state=%r" % (sync_attr(page, "data-sync-state"),))
        ok("未配置" not in (label(page) or ""), "configured=false 不误显示「未配置」")
        ok(sync_attr(page, "data-sync-green") == "0", "configured=false + invalid 不显绿")
        set_stub(STUB_UNCONFIGURED_INCOMPLETE)
        page.locator("[data-sync-refresh]").click()
        ok(wait_label(page, "检查未完成", timeout=10),
           "configured=false + overall=incomplete ⇒ 「检查未完成」（label=%r）" % (label(page),))
        ok(sync_attr(page, "data-sync-state") == "incomplete",
           "未配置不吞 incomplete 结论：state=%r" % (sync_attr(page, "data-sync-state"),))
        ok("未配置" not in (label(page) or ""), "未取齐不误显示「未配置」")
        ok(sync_attr(page, "data-sync-green") == "0", "未取齐不显绿")

        # ── O 坏返回体边界：必要字段逐项校验，缺/坏一律「读取失败」、不崩溃、不显绿 ──
        step["now"] = "O 坏返回体边界校验"
        for i, (bad_name, bad_sync) in enumerate(shape_bad_cases()):
            set_stub({"ok": True, "sync": bad_sync})
            page.goto("%s/?case=o%d#p/%s" % (base, i, FIX_A), wait_until="domcontentloaded")
            page.wait_for_timeout(1200)
            st = sync_attr(page, "data-sync-state")
            ok(st == "error" and sync_attr(page, "data-sync-green") == "0",
               "坏返回体（%s）⇒ 读取失败且不显绿（state=%r, green=%r）"
               % (bad_name, st, sync_attr(page, "data-sync-green")))
            ok(page.locator(ROOT).count() == 1,
               "坏返回体（%s）不崩溃、摘要条仍在（未白屏）" % bad_name)

        # ── P active 与已 superseded 历史：范围/差项按现行批次，历史仍详情可查 ──
        step["now"] = "P 现行/历史范围与差项"
        set_stub(STUB_ACTIVE_AND_HISTORY)
        page.goto("%s/?case=p#p/%s" % (base, FIX_A), wait_until="domcontentloaded")
        page.wait_for_timeout(1800)
        ok(wait_label(page, "发现缺项", timeout=10), "现行批次含缺项 ⇒ 「发现缺项」（label=%r）" % (label(page),))
        ok(sync_attr(page, "data-sync-batches-active") == "1"
           and sync_attr(page, "data-sync-batches-history") == "2",
           "批次范围分现行/历史（active=%r, history=%r）"
           % (sync_attr(page, "data-sync-batches-active"), sync_attr(page, "data-sync-batches-history")))
        ok(sync_attr(page, "data-sync-items") == "3" and sync_attr(page, "data-sync-items-required") == "2"
           and sync_attr(page, "data-sync-items-missing") == "1",
           "主条必需缺数按**现行批次**（items=%r, required=%r, missing=%r），不计入历史"
           % (sync_attr(page, "data-sync-items"), sync_attr(page, "data-sync-items-required"),
              sync_attr(page, "data-sync-items-missing")))
        ok(sync_attr(page, "data-sync-history-items") == "3"
           and sync_attr(page, "data-sync-history-verified") == "1",
           "历史项数单列且区分「有回执/未核验」（history-items=%r, verified=%r）"
           % (sync_attr(page, "data-sync-history-items"), sync_attr(page, "data-sync-history-verified")))
        page.locator("[data-sync-detail-toggle]").first.click()
        page.wait_for_timeout(400)
        ok(page.locator("[data-sync-item]").count() == 6,
           "历史项仍在详情里可查（共 %d 项）" % page.locator("[data-sync-item]").count())
        cur = page.locator("[data-sync-batch='batch-2']")
        hist = page.locator("[data-sync-batch='batch-1']")
        ok(cur.count() == 1 and cur.first.get_attribute("open") is not None, "现行批次默认展开")
        ok(hist.count() == 1 and hist.first.get_attribute("open") is None, "历史批次默认折叠（仍可点开）")
        page.screenshot(path=os.path.join(SHOT_DIR, "12-active-vs-history.png"))
        if hist.count() == 1:
            hist.locator("summary").first.click()
            page.wait_for_timeout(300)
            ok(hist.first.get_attribute("open") is not None, "历史批次可点开查看（历史仍详情可查）")
        detail_text = page.locator("[data-sync-detail-body]").inner_text()
        ok("已被取代" in detail_text, "历史批次标注「已被取代」")
        ok(hist.first.get_attribute("data-sync-batch-historical") == "1"
           and hist.first.get_attribute("data-sync-batch-verified-at") == HIST_VERIFIED_AT,
           "有回执的历史批次带 historical=1 与核验时间（%r / %r）"
           % (hist.first.get_attribute("data-sync-batch-historical"),
              hist.first.get_attribute("data-sync-batch-verified-at")))
        ok("历史回执" in detail_text and HIST_VERIFIED_AT in detail_text,
           "详情明确写出「历史回执」与核验时间（不是本次实时核验）")
        hist0 = page.locator("[data-sync-batch='batch-0']")
        ok(hist0.count() == 1 and hist0.first.get_attribute("data-sync-batch-verified-at") == "",
           "无回执历史批次 verified_at 为空（明确未核验，不冒充通过）")
        ok("未核验" in detail_text, "无回执历史在详情里明确「未核验」")
        page.locator("[data-sync-detail-close]").first.click()
        page.wait_for_timeout(200)

        # ── Q 详情 toggle 可访问性：aria-expanded + 关联可访问标签 ──
        step["now"] = "Q 详情可访问性"
        set_stub(STUB_PASSED)
        page.locator("[data-sync-refresh]").click()
        ok(wait_label(page, "同步通过", timeout=10), "回到通过态（label=%r）" % (label(page),))
        toggle = page.locator("[data-sync-detail-toggle]").first
        ok(toggle.get_attribute("aria-expanded") == "false",
           "详情 toggle 初始 aria-expanded=false（%r）" % toggle.get_attribute("aria-expanded"))
        ok(toggle.get_attribute("aria-controls") == "sync-evidence-detail-panel",
           "toggle 用 aria-controls 关联详情面板（%r）" % toggle.get_attribute("aria-controls"))
        toggle.click()
        page.wait_for_timeout(400)
        ok(toggle.get_attribute("aria-expanded") == "true",
           "展开后 aria-expanded=true（%r）" % toggle.get_attribute("aria-expanded"))
        panel = page.locator("#sync-evidence-detail-panel")
        ok(panel.count() == 1, "aria-controls 指向的面板存在")
        ok(panel.count() == 1 and panel.first.get_attribute("aria-labelledby") == "sync-evidence-detail-title",
           "面板用 aria-labelledby 关联可访问标签")
        ok(page.locator("#sync-evidence-detail-title").count() == 1, "被关联的标题元素存在")
        ok(panel.count() == 1 and panel.first.get_attribute("role") == "dialog", "详情面板 role=dialog")
        page.locator("[data-sync-detail-close]").first.click()
        page.wait_for_timeout(300)
        ok(toggle.get_attribute("aria-expanded") == "false",
           "收起后 aria-expanded 回到 false（%r）" % toggle.get_attribute("aria-expanded"))

        # ── M 真实链路（不替身）：真后端读口 + 真界面端到端同源，覆盖「未配置 / 配置失败 / 配置通过」三态 ──
        step["now"] = "M 真实链路核对（不替身，三态）"
        # 用**新开的一页**做真实链路：page.route 是每页注册的，新页不带替身，口径干净
        # （不用 page.unroute —— 实测它在这里没能摘掉替身，会拿旧替身读数冒充真实链路）。
        # 复审修订（2026-10-08）：预期状态**只**由真后端报告字段 + 契约 headline 规则独立算出，
        # 不再用 `st in SYNC_UI_STATES`（恒真）或 `should_green = st == "passed"`（取 UI 自身＝自证）；
        # 配置两态由**真写口登记真契约 + 真证据**产生，然后逐态核对界面与独立预期同值。
        _s, health = backend.api("/health")
        real = browser.new_context(viewport={"width": 1680, "height": 1000}).new_page()
        open_project(real, base, FIX_A, wait=2500)
        proj_a_root = project_root_of(home, FIX_A)

        def real_report():
            st, body = backend.api("/api/projects/%s/sync-status" % FIX_A)
            rep = body.get("sync") if isinstance(body, dict) else None
            return st, rep

        def assert_real_case(tag, expect_overall, expect_configured, shot):
            """真后端读口 → **独立**算预期（后端报告字段 + 契约 headline 规则）→ 真界面同值才判过。"""
            status, rep = real_report()
            ok(status == 200 and isinstance(rep, dict),
               "M(%s)：真后端读口可达且给报告（HTTP %r，形状=%s）"
               % (tag, status, "dict" if isinstance(rep, dict) else type(rep).__name__))
            if not (status == 200 and isinstance(rep, dict)):
                return
            ok(rep.get("overall") == expect_overall and bool(rep.get("configured")) == expect_configured,
               "M(%s)：真后端**确实**处于该态（configured=%r / overall=%r，期望 %s/%s）"
               % (tag, rep.get("configured"), rep.get("overall"), expect_configured, expect_overall))
            exp_state = expected_headline(rep)
            exp_green = expected_green(rep)
            real.locator("[data-sync-refresh]").click()
            deadline = time.time() + 15
            while time.time() < deadline and sync_attr(real, "data-sync-state") != exp_state:
                real.wait_for_timeout(200)
            ui_state = sync_attr(real, "data-sync-state")
            ui_green = sync_attr(real, "data-sync-green")
            ok(ui_state in SYNC_UI_STATES,
               "M(%s)：真界面状态键落在契约值集内（state=%r）" % (tag, ui_state))
            ok(ui_state == exp_state,
               "M(%s)：真界面状态 == 按后端报告**独立**算出的契约状态（UI=%r，独立预期=%r；"
               "读口 overall=%r/scan_error=%r/collection=%r）"
               % (tag, ui_state, exp_state, rep.get("overall"), rep.get("scan_error"), rep.get("collection")))
            ok(ui_green == ("1" if exp_green else "0"),
               "M(%s)：真界面显绿 == 按后端报告**独立**算（UI=%r，独立预期=%r）"
               % (tag, ui_green, "1" if exp_green else "0"))
            coll = "complete" if (rep.get("collection") or {}).get("complete") is True else "incomplete"
            ok(sync_attr(real, "data-sync-configured") == ("1" if rep.get("configured") else "0")
               and sync_attr(real, "data-sync-batches") == str(len(rep.get("batches") or []))
               and sync_attr(real, "data-sync-collection") == coll,
               "M(%s)：真界面 configured/batches/collection 与真读口逐字段一致（%r/%s/%s）"
               % (tag, sync_attr(real, "data-sync-configured"), sync_attr(real, "data-sync-batches"),
                  sync_attr(real, "data-sync-collection")))
            real.screenshot(path=os.path.join(SHOT_DIR, shot))

        # M1 真实未配置：夹具项目尚无契约（真后端 configured=false / overall=not_configured）
        assert_real_case("M1 未配置", "not_configured", False, "11-real-not-configured.png")

        # M2 真实配置通过：经真写口登记真契约 + 投放真证据（file_hash 目标字节一致 ⇒ 真后端判 passed）
        if proj_a_root is None:
            ok(False, "M2：从隔离注册表取不到夹具项目根，无法登记真契约")
        else:
            batch = "v0924-real-1"
            design_rel = ".工作台/design.md"
            target_rel = "src/index.ts"
            design_sha = sha_file(os.path.join(proj_a_root, *design_rel.split("/")))
            target_sha = sha_file(os.path.join(proj_a_root, *target_rel.split("/")))
            contract = {
                "schema_version": 1, "batch_id": batch, "project_id": FIX_A,
                "title": "V09-24 真实链路联验（隔离夹具）",
                "sources": [{"path": design_rel, "sha256": design_sha}],
                "items": [{"id": "i-code", "label": "夹具源码字节与登记一致", "required": True,
                           "check": {"type": "file_hash", "path": target_rel, "sha256": target_sha}}],
                "blocks_entry": True,
            }
            c_sha = contract_sha256(contract)
            cst, cbody = register_real_contract(home, FIX_A, contract, c_sha)
            ok(cst == 200 and isinstance(cbody, dict) and cbody.get("ok") is True,
               "M2：经隔离后端唯一写口登记真契约（HTTP %r，seq=%s）"
               % (cst, (cbody or {}).get("seq") if isinstance(cbody, dict) else None))
            ev_dir = os.path.join(proj_a_root, ".工作台", "work", "sync-inbox")
            os.makedirs(ev_dir, exist_ok=True)
            evidence = {
                "schema_version": 1, "batch_id": batch, "project_id": FIX_A,
                "contract_sha256": c_sha, "completed": True,
                "items": [{"id": "i-code", "result": "passed",
                           "artifacts": [{"path": design_rel, "sha256": design_sha}]}],
            }
            with open(os.path.join(ev_dir, "%s.evidence.json" % batch), "w", encoding="utf-8") as f:
                json.dump(evidence, f, ensure_ascii=False, indent=2)
            assert_real_case("M2 配置通过", "passed", True, "11-real-passed.png")

            # M3 真实配置失败：改了被清单覆盖的目标字节 ⇒ 真后端按当前实际目标判 failed（不是换个名字的通过）
            with open(os.path.join(proj_a_root, *target_rel.split("/")), "a", encoding="utf-8", newline="") as f:
                f.write("// V09-24 UI 联验：目标字节已变（应当被判失败）\n")
            assert_real_case("M3 配置失败", "failed", True, "11-real-failed.png")

        real.close()
        info("后端 health=%r" % (health,))

        browser.close()


def main():
    tmp = tempfile.mkdtemp(prefix="tatai-v0924ui-")
    home = os.path.join(tmp, "home")
    os.makedirs(home, exist_ok=True)
    proj_a = make_fixture(tmp, FIX_A)
    proj_b = make_fixture(tmp, FIX_B)
    make_registry(home, [(FIX_A, "V09-24 同步夹具 A", proj_a), (FIX_B, "V09-24 同步夹具 B", proj_b)])
    os.makedirs(LOG_DIR, exist_ok=True)
    backend_port = free_port()
    vite_port = VITE_PORT or free_port()
    backend = None
    vite = None
    try:
        if VITE_PORT and port_busy(vite_port):
            print("[ui] FAIL vite %d 已被占用：本脚本不抢端口（先停掉占用者或用 V0924_VITE_PORT 换端口）" % vite_port)
            sys.exit(1)
        step["now"] = "起后端"
        backend = Backend(home, backend_port, os.path.join(LOG_DIR, "ui-backend.log"))
        backend.wait_health()
        info("后端就绪：127.0.0.1:%d（TATAI_HOME=%s）" % (backend_port, home))
        step["now"] = "起 vite"
        vite = start_vite(vite_port, backend_port, os.path.join(LOG_DIR, "ui-vite.log"))
        info("vite 就绪：http://localhost:%d" % vite_port)
        run_browser(vite_port, backend, home)
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

    print("[ui] 计数：%d PASS / %d FAIL / %d SKIP" % (passes[0], len(fails), len(skips)))
    if fails:
        print("[ui] 存在 FAIL")
        sys.exit(1)
    print("[ui] 全部 PASS")


if __name__ == "__main__":
    main()
