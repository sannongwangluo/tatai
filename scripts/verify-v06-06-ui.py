#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""V06-06 浏览器场景验证（Python + Playwright）：三个主视图与状态解释在**真实浏览器**里的行为。

用法：python scripts/verify-v06-06-ui.py
      （或 pnpm verify:v06-06-ui；V0606_KEEP_TMP=1 保留临时夹具现场）

为什么必须跑真浏览器（PLAN.md V06-06 检查项 3）：空仓灰图、父级不空集判绿、依赖线与集成线
语义分开、过期提示、刷新/折叠/返回定位、过滤数量——这六件事都要在"用户看得见的结果"上验，
只验内部对象不算。本脚本的断言全部打在 DOM 上（`data-project-*` 属性、节点 transform、
边的 computed stroke/dasharray、截图）。

隔离口径（AGENTS.md §5 / 卡面红线）：
  · 临时 TATAI_HOME + `tempfile` 下的两个夹具项目，**绝不碰**三个真实项目的 `.工作台/`；
  · 夹具事实全部经**真实接口**写入（激活基线 / work 命令 / 静态解析），不手写事件文件、
    不伪造状态；模型环节用"没配密钥"的真实失败（语义整理失败 → 保留上次有效图）；
  · 收尾杀净子进程、删临时目录（TATAI_KEEP_TMP=1 可留现场）。
"""
import hashlib
import json
import os
import re
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
SHOT_DIR = os.path.join(REPO, ".工作台", "verify", "v06-06")
# 测试只访问本次隔离的回环服务，显式直连：ambient 代理会把 127.0.0.1 探活转成 502（同
# `scripts/verify-forward-baseline-ui.py` 的既有口径）。判据不变，只是不让代理插手回环。
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))
MAIN = "v0606-main"
BIG = "v0606-big"
DRAFT = "v0606-draft"
# 2026-09-22（§3.2 草稿图预览落地）：`v0606-draft`（图纸在场、从未激活基线）现在**能预览草稿图**了，
# "无规划"这个空态得换一个**连草稿都派不出来**的夹具（没有任何图纸源）来验——判据没放宽，
# 只是把它放回真正"无规划"的现场。
EMPTY = "v0606-empty"
KEEP = os.environ.get("V0606_KEEP_TMP") == "1"

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


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


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
        with DIRECT.open(req, timeout=timeout) as resp:
            text = resp.read().decode("utf-8")
            return resp.status, (json.loads(text) if text.strip().startswith(("{", "[")) else text)
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(text)
        except Exception:
            return e.code, text


# ══════════════════════════════ 夹具（全部经真实接口写入） ══════════════════════════════

def design_md(title, sections):
    """设计书夹具：level-2 章节 = 能力节点；含「模块划分」小节时该节列表项 = 声明模块节点。"""
    out = [f"# {title}", "", "> 夹具：只用于 V06-06 的浏览器场景，不代表任何真实项目。", ""]
    for i, (name, body, modules) in enumerate(sections, start=1):
        out.append(f"## {i}. {name}")
        out.append("")
        out.append(body)
        out.append("")
        if modules:
            out.append("### 模块划分")
            out.append("")
            for m in modules:
                out.append(f"- {m}：该能力由这个模块承担")
            out.append("")
    return "\n".join(out)


def plan_md(rows, tasks):
    """施工图夹具：表头必须含「卡号/依赖/完成证据」三列；每卡正文给设计依据/文件责任/检查项/交付。"""
    out = [
        "# 夹具施工图",
        "",
        "| 卡号 | 状态 | 交付目标 | 依赖 | 完成证据 |",
        "| --- | --- | --- | --- | --- |",
    ]
    for r in rows:
        out.append("| " + " | ".join(r) + " |")
    out.append("")
    for t in tasks:
        out.append(f"### {t['id']} {t['goal']}")
        out.append("")
        out.append(f"**设计依据**：{t['design_refs']}")
        out.append("")
        out.append(f"**文件责任**：`{t['scope']}`")
        out.append("")
        for c in t["checks"]:
            out.append(f"- [ ] {c}")
        out.append("")
        out.append(f"**交付**：{t['deliver']}")
        out.append("")
    return "\n".join(out)


def make_main_project(root):
    """主夹具：4 个能力（不足 5，验"不补假节点"）+ 2 个声明模块 + 4 个任务（T-3 两个前置）。"""
    wb = os.path.join(root, ".工作台")
    design = design_md(
        "夹具设计书（记录工具）",
        [
            ("记录能力", "把用户放进来的东西按天记下来。", ["记录模块", "存储模块"]),
            ("导入能力", "把外部数据导进来。", []),
            ("导出能力", "把结果导出去。", []),
            ("校验能力", "校验记录是否自相矛盾。", []),
        ],
    )
    plan = plan_md(
        [
            ("T-1", "done", "记录地基", "", "`pnpm verify:t1` 全绿"),
            ("T-2", "doing", "导入通道", "T-1", "导入 1000 行无丢行"),
            ("T-3", "blocked", "导出通道", "T-1、T-2", "导出文件可被原系统读回"),
            ("T-4", "done", "校验规则", "T-2", "坏数据被点名"),
        ],
        [
            {
                "id": "T-1",
                "goal": "记录地基",
                "design_refs": "§1",
                "scope": "src/base/",
                "checks": ["地基水平合格", "压实复核合格"],
                "deliver": "可复建的地基。",
            },
            {
                "id": "T-2",
                "goal": "导入通道",
                "design_refs": "§2",
                "scope": "src/import/",
                "checks": ["1000 行导入无丢行"],
                "deliver": "导入通道。",
            },
            {
                "id": "T-3",
                "goal": "导出通道",
                "design_refs": "§3",
                "scope": "src/export/",
                "checks": ["导出文件可被原系统读回"],
                "deliver": "导出通道。",
            },
            {
                "id": "T-4",
                "goal": "校验规则",
                "design_refs": "§4",
                "scope": "src/check/",
                "checks": ["坏数据被点名"],
                "deliver": "校验规则。",
            },
        ],
    )
    write(os.path.join(wb, "design.md"), design)
    write(os.path.join(wb, "plan.md"), plan)
    # 真实代码：静态解析能给出实测模块（系统架构视图的"叠加实测代码映射"）
    for d, f, importline in [
        ("base", "base.ts", "export const BASE = 'base';\n"),
        ("import", "imp.ts", "import { BASE } from '../base/base';\nexport const IMP = BASE;\n"),
        ("export", "exp.ts", "import { IMP } from '../import/imp';\nexport const EXP = IMP;\n"),
        ("check", "chk.ts", "import { EXP } from '../export/exp';\nexport const CHK = EXP;\n"),
    ]:
        write(os.path.join(root, "src", d, f), importline)
    # 任务 ↔ 模块归属（v1 台账格式，§2.3.4）：模块父级的唯一现实来源
    write(
        os.path.join(wb, "tasks.json"),
        json.dumps(
            {
                "version": 1,
                "tasks": [
                    {"id": "T-1", "title": "记录地基", "module_id": "src-base", "status": "done", "reporter": "kimi-code", "updated_at": "2026-09-20T09:00:00+08:00"},
                    {"id": "T-2", "title": "导入通道", "module_id": "src-import", "status": "doing", "reporter": "kimi-code", "updated_at": "2026-09-20T09:30:00+08:00"},
                    {"id": "T-3", "title": "导出通道", "module_id": "src-export", "status": "blocked", "reporter": "kimi-code", "updated_at": "2026-09-20T09:40:00+08:00"},
                    {"id": "T-4", "title": "校验规则", "module_id": "src-check", "status": "done", "reporter": "kimi-code", "updated_at": "2026-09-20T09:50:00+08:00"},
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
    )


def make_big_project(root):
    """空仓夹具：**没有一行代码、没有静态解析**，但有 18 个能力（超 15 → 聚合显示数量）。
    §3.2：空仓库不是空图的理由——灰图必须出得来，且不许假绿。"""
    wb = os.path.join(root, ".工作台")
    sections = [(f"能力 {i:02d}", f"第 {i} 项能力说明。", []) for i in range(1, 19)]
    write(os.path.join(wb, "design.md"), design_md("夹具设计书（空仓项目）", sections))
    write(
        os.path.join(wb, "plan.md"),
        plan_md(
            [("B-1", "todo", "空仓也有一张卡", "", "图纸仍在，代码未写")],
            [
                {
                    "id": "B-1",
                    "goal": "空仓也有一张卡",
                    "design_refs": "§1",
                    "scope": "src/",
                    "checks": ["代码写出来后再谈"],
                    "deliver": "空仓库的规划节点。",
                }
            ],
        ),
    )


def make_draft_project(root):
    """草稿夹具：图纸在场但**从未激活基线** → 没有已发布的规划图；
    自 2026-09-22 起这个现场能预览**草稿图**（§3.2「未审定方案可预览，但明确标草稿图」）。"""
    wb = os.path.join(root, ".工作台")
    write(os.path.join(wb, "design.md"), design_md("夹具设计书（未激活）", [("草稿能力", "还没审定。", [])]))
    write(
        os.path.join(wb, "plan.md"),
        plan_md(
            [("D-1", "todo", "草稿卡", "", "审定后再谈")],
            [
                {
                    "id": "D-1",
                    "goal": "草稿卡",
                    "design_refs": "§1",
                    "scope": "src/",
                    "checks": ["审定后再谈"],
                    "deliver": "草稿。",
                }
            ],
        ),
    )


def make_empty_project(root):
    """空规划夹具：**连图纸源都没有**（没有 design.md / plan.md、没跑过静态解析）→ 无可派生的草稿。"""
    os.makedirs(root, exist_ok=True)
    write(os.path.join(root, "README.md"), "# 夹具·无图纸\n\n没有任何设计书/施工图源。\n")


# ══════════════════════════════ 服务与事实写入 ══════════════════════════════

class Backend:
    def __init__(self, home, port, log_path):
        self.home = home
        self.port = port
        self.log_path = log_path
        env = dict(os.environ)
        env["TATAI_HOME"] = home
        env["TATAI_PORT"] = str(port)
        # 隔离模型环节：不配密钥 → 语义整理真失败（用来造"图正在更新"：保留上次有效图 + 留回执）
        env.pop("DEEPSEEK_API_KEY", None)
        env["DEEPSEEK_API_KEY"] = ""
        self.proc = subprocess.Popen(
            ["node", "--import", "tsx", os.path.join("src", "server", "index.ts")],
            cwd=REPO,
            env=env,
            stdout=open(log_path, "ab"),
            stderr=subprocess.STDOUT,
        )

    def api(self, path, method="GET", body=None, headers=None):
        return http(f"http://127.0.0.1:{self.port}{path}", method, body, headers=headers)

    def work_token(self):
        """写入服务凭据：唯一写入服务在启动时把描述符落 `<TATAI_HOME>/work-service.json`
        （WORK_TOKEN_HEADER = x-tatai-work-token）；夹具按真实约定取用，不走后门。"""
        desc = json.loads(read(os.path.join(self.home, "work-service.json")))
        return desc["token"]

    def wait_health(self, timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"后端进程退出（code={self.proc.returncode}），日志见 {self.log_path}")
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
            with DIRECT.open(f"http://localhost:{port}/", timeout=5) as resp:
                if resp.status == 200:
                    return proc
        except Exception:
            time.sleep(0.5)
    raise RuntimeError(f"vite {port} 未就绪")


class Facts:
    """经真实 work 命令写入事实（唯一写入者 = WorkService；不手写事件文件）。"""

    def __init__(self, backend, project_id):
        self.backend = backend
        self.token = backend.work_token()
        self.pid = project_id
        self.rev = {}
        self.seq = 0
        self.change = f"CHG-{project_id}"

    def submit(self, entity_id, type_, payload, actor="kimi-code", role="executor"):
        self.seq += 1
        cmd = {
            "schema_version": 2,
            "project_id": self.pid,
            "change_id": self.change,
            "entity_id": entity_id,
            "expected_revision": self.rev.get(entity_id),
            "type": type_,
            "actor_id": actor,
            "role": role,
            "idempotency_key": f"{entity_id}:{type_}:{self.seq}",
            "occurred_at": "2026-09-20T0%d:00:00+08:00" % (self.seq % 9 + 1),
            "payload": payload,
        }
        status, body = self.backend.api("/api/work/command", "POST", cmd, {"x-tatai-work-token": self.token})
        if status != 200 or not isinstance(body, dict) or not (body.get("ok") is True or "entity_revision" in body):
            raise RuntimeError(f"work 命令失败（{type_} {entity_id}）：HTTP {status} {str(body)[:300]}")
        # /api/work/command 直接回执本体（WorkReceipt：entity_revision 在顶层）；兼容包裹形态
        receipt = body.get("receipt") or body.get("result") or body
        self.rev[entity_id] = receipt.get("entity_revision")
        return receipt


def publish_baseline(backend, project_id):
    """激活基线（真实接口）→ 触发规划图派生；等它发布出来。"""
    status, body = backend.api(
        f"/api/projects/{project_id}/documents/activate",
        "POST",
        {"approved_by": "gpt-6", "approval_basis": "夹具：浏览器场景用", "approval_kind": "delegated_technical_review"},
    )
    if status != 200:
        raise RuntimeError(f"激活基线失败：HTTP {status} {str(body)[:300]}")
    for _ in range(80):
        status, bp = backend.api(f"/api/projects/{project_id}/arch/blueprint")
        if status == 200 and bp.get("blueprint", {}).get("exists"):
            return bp["blueprint"]["blueprint"]
        time.sleep(0.25)
    raise RuntimeError("规划图 20 秒内没有发布（见后端日志）")


# ══════════════════════════════ 浏览器断言 ══════════════════════════════

STATUS_HEX = {
    "planned": "#a3a3a3",
    "in_progress": "#60a5fa",
    "pending_verification": "#fb923c",
    "verified": "#34d399",
    "blocked": "#f87171",
    "unknown": "#737373",
}
DEP_UNRESOLVED = "#737373"
INTEGRATION_PURPLE = "#c084fc"


def hex_to_rgb(h):
    h = h.lstrip("#")
    return "rgb(%d, %d, %d)" % (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def node_states(page):
    """画布上每个节点的 id → 状态（六态键或 unmapped）+ 坐标（transform 原文）。"""
    return page.eval_on_selector_all(
        "[data-project-canvas-host] [data-project-node]",
        """els => els.map(e => {
             const wrap = e.closest('.react-flow__node');
             return {
               id: e.getAttribute('data-project-node'),
               status: e.getAttribute('data-project-status'),
               label: e.getAttribute('data-project-status-label'),
               transform: wrap ? (wrap.style.transform || '') : '',
               text: e.innerText || ''
             };
           })""",
    )


def edge_styles(page, cls):
    return page.eval_on_selector_all(
        f"[data-project-canvas-host] g.{cls} path.react-flow__edge-path",
        """els => els.map(e => {
             const cs = getComputedStyle(e);
             const g = e.closest('g');
             return { stroke: cs.stroke, dash: cs.strokeDasharray, id: g ? g.getAttribute('data-id') : '' };
           })""",
    )


def open_view(page, view):
    step["now"] = f"切到主视图 {view}"
    page.locator(f'[data-project-view-tab="{view}"]').click()
    page.wait_for_selector(f'[data-arch-tab="{view}"]', timeout=30000)
    page.wait_for_timeout(700)


def viewport_transform(page):
    return page.eval_on_selector(
        "[data-project-canvas-host] .react-flow__viewport",
        "el => getComputedStyle(el).transform",
    )


def assert_dependency_vs_integration(page, tag):
    """依赖线与集成线语义分开（§4.2）：颜色与虚实都不同，且集成线绝不着完成色。"""
    dep = edge_styles(page, "te-edge-dependency")
    integ = edge_styles(page, "te-edge-integration")
    info(f"{tag}：依赖线 {len(dep)} 条（{sorted({d['stroke'] for d in dep})}）· 集成线 {len(integ)} 条（{sorted({i['stroke'] for i in integ})}）")
    ok(len(dep) >= 2, f"{tag}：施工依赖视图画出 {len(dep)} 条依赖线（T-3 有两个前置 → 不该是树）")
    ok(len(integ) >= 1, f"{tag}：画出 {len(integ)} 条集成/关系线（实现映射，端点也在画布上）")
    ok(
        all(d["stroke"] != hex_to_rgb(INTEGRATION_PURPLE) for d in dep),
        f"{tag}：依赖线用的不是集成线的紫色（{sorted({d['stroke'] for d in dep})}）",
    )
    ok(
        all(i["stroke"] == hex_to_rgb(INTEGRATION_PURPLE) for i in integ),
        f"{tag}：集成线统一用紫色（{sorted({i['stroke'] for i in integ})}）——不拿端点的完成色冒充连线色（§4.2）",
    )
    ok(
        all(i["dash"] not in ("none", "") for i in integ),
        f"{tag}：集成线是虚线（dasharray {sorted({i['dash'] for i in integ})}），实/虚也是第二通道",
    )
    dep_strokes = {d["stroke"] for d in dep}
    ok(
        dep_strokes <= set(hex_to_rgb(h) for h in STATUS_HEX.values()) | {hex_to_rgb(DEP_UNRESOLVED)},
        f"{tag}：依赖线的颜色只取「六态状态色（含未知的中性灰）」（{sorted(dep_strokes)}）",
    )
    # 本夹具的四条依赖线都拿到了投影结论（前置已交未释放→橙、还没开始→灰），所以都是实线；
    # "没有连线投影 = 未判释放"那一路画中性虚线，规则由 scripts/verify-v06-06.ts 直接断言
    ok(
        all(d["dash"] in ("none", "") for d in dep),
        f"{tag}：有结论的依赖线是实线 + 状态色（{sorted({d['dash'] for d in dep})}）；未判释放的才用中性虚线",
    )
    ok(
        not (dep_strokes & {hex_to_rgb(INTEGRATION_PURPLE)}),
        f"{tag}：两套线的颜色集合不相交（§4.2：语义分开着色）",
    )
    legend = page.locator("[data-project-edge-legend]").inner_text()
    ok(
        "依赖线" in legend and "集成" in legend and "不着完成色" in legend,
        f"{tag}：图例同时写清两类线（{legend[:60].replace(chr(10), ' ')}…）",
    )
    return dep, integ


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


def open_notes_fold(page):
    """把「口径注释」按**用户操作顺序**展开，不改任何断言、不绕过界面。

    现场是**两层**折叠：外层 `details.tt-graph-guide`（2026-09-27 用户指令：默认收起成一行）里
    再套着内层 `[data-project-notes-summary]`（更早的收起改动）。按 HTML `<details>` 的 UA 折叠
    语义，外层没展开时内层 summary 是**不可见**的（`not visible`），点不到——这不是功能坏了，
    是点之前少开了一层。先点**外层** summary，再点**内层** summary。"""
    outer = page.locator("details.tt-graph-guide > summary").first
    if outer.count():
        outer.click()
        page.wait_for_timeout(200)
    inner = page.locator("[data-project-notes-summary]").first
    if inner.count():
        inner.click()
        page.wait_for_timeout(300)


def expand_detail_folds(page):
    """把节点详情里**所有**折叠 `<details>` 按用户操作顺序逐个点开，再读全文。

    为什么：详情各段现在"**短线摘要在外、全文在里**"——`ProjectGraphView.tsx` 渲染 `s.summary`，
    把 `s.lines`（含"来源时间：图生成 …"、出处段的"设计书章节：…/施工卡：…／基线：…；派生器 …"）
    收在每段自己的 `<details data-detail-original=…>` 里；第⑤段「技术资料与原始定位」是
    `<details data-detail-technical>`。折叠时 `inner_text` 取不到全文，**不是内容没了**，是没展开。
    逐个点开 summary，断言一字未改、判据未放宽。"""
    for _ in range(16):
        folds = page.locator("[data-project-detail] details:not([open]) > summary")
        if folds.count() == 0:
            return
        try:
            folds.first.click(timeout=3000)
        except Exception:
            return
        page.wait_for_timeout(120)


def run_browser(vite_port, backend_port):
    os.makedirs(SHOT_DIR, exist_ok=True)
    with sync_playwright() as p:
        browser = launch_browser(p)
        page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        base = f"http://localhost:{vite_port}"

        def goto_project(pid, timeout=60000):
            page.goto(f"{base}/#p/{pid}", wait_until="domcontentloaded")
            page.wait_for_selector('button[data-view="arch"]', timeout=timeout)
            page.locator('button[data-view="arch"]').click()
            page.wait_for_selector('[data-arch-tab]', timeout=timeout)
            page.wait_for_timeout(500)

        # ── ① 主夹具：功能全景（4 个分组 → 不足 5 不补假节点） ──
        step["now"] = "主夹具：功能全景"
        goto_project(MAIN)
        page.wait_for_selector('[data-project-view-tab="functional"]', timeout=60000)
        open_view(page, "functional")
        page.wait_for_selector("[data-project-canvas-host] .react-flow__node", timeout=30000)
        states = node_states(page)
        ok(len(states) >= 4, f"功能全景渲染 {len(states)} 个能力分组节点（不足 5 个也照常出图）")
        note = page.locator("[data-project-scope]").inner_text()
        ok("显示全部" in note, f"顶栏显示当前范围（{note[:48]}…）")
        # 2026-09-27：口径注释区默认收起成一行；2026-10-08：外层又套了一层 `details.tt-graph-guide`
        # 折叠（同一次改动的两个落点）。按用户操作顺序先开外层、再开内层——断言一字未改、判据未放宽。
        open_notes_fold(page)
        overview_note = page.locator("[data-project-notes]").inner_text()
        ok(
            "不补假节点" in overview_note or "不足 5" in overview_note,
            f"概览说明写明「不足 5 个不补假节点」（§3.3）：{overview_note.splitlines()[-1][:52]}…",
        )
        ok(
            all(s["status"] in ("unmapped", "planned") for s in states),
            f"能力分组的六态来自投影/汇总（当前：{[s['status'] for s in states]}）",
        )
        page.screenshot(path=os.path.join(SHOT_DIR, "01-main-functional-overview.png"))

        # ── ② 详情五段：鼠标点开一个能力节点 ──
        step["now"] = "主夹具：详情五段"
        first_id = states[0]["id"]
        page.locator(f'[data-project-node="{first_id}"]').click()
        page.wait_for_selector("[data-detail-section]", timeout=15000)
        order = page.eval_on_selector_all(
            "[data-project-detail] [data-detail-section]",
            "els => els.map(e => e.getAttribute('data-detail-section'))",
        )
        ok(
            order[:5] == ["role", "situation", "origin", "verification", "tech"]
            and order[5:] == (["provenance"] if len(order) > 5 else []),
            f"详情五段顺序 = §3.2（作用 → 当前情况与原因 → 设计/施工出处 → 验证结果 → 技术资料）：{order}",
        )
        # 2026-10-08：详情各段「短线摘要在外、全文在里」——"来源时间"在 situation 段的
        # `[data-detail-original]` 里（另有第⑤段 `[data-detail-technical]`）。按用户操作逐个展开再读全文，
        # 断言一字未改（展开 helper 见模块级 expand_detail_folds）。
        expand_detail_folds(page)
        detail = page.locator("[data-project-detail]").inner_text()
        ok("未映射" in detail or "状态口径" in detail, "第②段给出状态与状态口径（不空集判绿）")
        ok("来源时间" in detail, "第②段带来源时间（图生成 / 本次读取）")
        ok("验证结果" in detail, "第④段给出验证结果与缺口")
        page.screenshot(path=os.path.join(SHOT_DIR, "02-main-detail-five-sections.png"))

        # ── ③ 键盘也能选中并打开详情（§3.3：鼠标、键盘均可） ──
        step["now"] = "主夹具：键盘选中"
        second = states[1] if len(states) > 1 else states[0]
        page.locator(f'[data-project-node="{second["id"]}"]').focus()
        page.keyboard.press("Enter")
        page.wait_for_timeout(400)
        kb_detail = page.locator("[data-project-detail]").inner_text()
        ok(
            second["text"].split("\n")[0] in kb_detail,
            f"键盘 Enter 选中「{second['text'].splitlines()[0][:16]}」并打开详情（与鼠标同一套详情）",
        )
        page.screenshot(path=os.path.join(SHOT_DIR, "03-main-keyboard-detail.png"))

        # ── ④ 图已过期 / 图正在更新：继续显示上次有效图 ──
        step["now"] = "主夹具：过期提示"
        # 2026-10-08：过期/更新提示现为折叠 `<details data-project-freshness>`（正文里才有"继续显示上次有效图"
        # 与原因），先按用户操作逐个点开再读；判据一字未改。
        fr = page.locator("[data-project-freshness] > summary")
        for i in range(fr.count()):
            fr.nth(i).click()
        page.wait_for_timeout(300)
        banners = page.eval_on_selector_all(
            "[data-project-freshness]",
            "els => els.map(e => [e.getAttribute('data-project-freshness'), e.innerText])",
        )
        kinds = {b[0] for b in banners}
        ok("stale" in kinds, f"标出「图已过期」（源改了、新图没生成）：{kinds}")
        ok("updating" in kinds, f"标出「图正在更新」（最近一次派生尝试没成功）：{kinds}")
        ok(
            len(node_states(page)) > 0,
            f"两条提示出现时**仍然显示上次有效图**（画布 {len(node_states(page))} 个节点，不是空图）",
        )
        ok(
            any("继续显示上次有效图" in b[1] or "不自动跳回全局" in b[1] for b in banners),
            "提示文案写明继续显示上次有效图 / 不自动跳回全局（§3.3 / §4.4）",
        )
        page.screenshot(path=os.path.join(SHOT_DIR, "04-main-stale-banners.png"))

        # ── ⑤ 刷新不跳动：坐标与视口都保持（不在用户查看时跳回全局） ──
        step["now"] = "主夹具：刷新不跳动"
        before = {s["id"]: s["transform"] for s in node_states(page)}
        vp_before = viewport_transform(page)
        page.locator("[data-project-refresh]").click()
        page.wait_for_timeout(1500)
        after = {s["id"]: s["transform"] for s in node_states(page)}
        vp_after = viewport_transform(page)
        same = [k for k in before if k in after and before[k] == after[k]]
        moved = [k for k in before if k in after and before[k] != after[k]]
        ok(
            len(moved) == 0 and len(same) >= 1,
            f"刷新（重新取数）后 {len(same)} 个节点坐标**逐个不变**、{len(moved)} 个跳动（布局增量更新，§3.3）",
        )
        ok(vp_before == vp_after, f"视口没被自动拉回全图（{vp_before} → {vp_after}，§3.3）")
        page.screenshot(path=os.path.join(SHOT_DIR, "05-main-refresh-no-jump.png"))

        # ── ⑥ 筛选：只看问题（数量 + 当前范围里说清隐藏了未完成） ──
        step["now"] = "主夹具：只看问题"
        open_view(page, "construction")
        page.wait_for_selector("[data-project-canvas-host] .react-flow__node", timeout=30000)
        all_states = node_states(page)
        page.locator('[data-project-filter="problem"]').click()
        page.wait_for_timeout(600)
        problem_states = [s for s in node_states(page) if s["status"] not in ("endpoint",)]
        scope = page.locator("[data-project-scope]").inner_text()
        ok(
            len(problem_states) < len(all_states),
            f"只看问题：节点 {len(all_states)} → {len(problem_states)}（筛掉了正在做/已通过的）",
        )
        ok(
            "只看问题" in scope and "共" in scope,
            f"顶栏显示过滤后的当前范围（{scope[:56]}…）",
        )
        ok(
            "隐藏" in scope and "不是" in scope and "验证已通过" in scope,
            f"范围说明点出隐藏里有多少**不是**验证已通过——不许让人以为「全项目已完成」（{scope[scope.find('隐藏'):][:64]}…）",
        )
        page.screenshot(path=os.path.join(SHOT_DIR, "06-main-filter-problem.png"))

        # ── ⑦ 施工依赖：多前置 + 依赖线/集成线语义分开 ──
        step["now"] = "主夹具：施工依赖"
        page.locator('[data-project-filter="all"]').click()
        page.wait_for_timeout(600)
        dep_states = node_states(page)
        by_label = {s["id"]: s for s in dep_states}
        statuses = sorted({s["status"] for s in dep_states})
        info(f"施工依赖节点状态：{[f'{s['id']}={s['status']}' for s in dep_states]}")
        ok(
            any(s["id"].endswith("T-1") and s["status"] == "pending_verification" for s in dep_states)
            and any(s["id"].endswith("T-2") and s["status"] == "in_progress" for s in dep_states)
            and any(s["id"].endswith("T-3") and s["status"] == "blocked" for s in dep_states)
            and any(s["id"].endswith("T-4") and s["status"] == "verified" for s in dep_states),
            f"四条任务的状态直接来自投影（橙/蓝/红/绿）：{sorted(f'{s['id'].split(':')[-1]}={s['status']}' for s in dep_states if s['id'].startswith('plan:task'))}",
        )
        t3_in = [e for e in edge_styles(page, "te-edge-dependency")]
        ok(
            len([e for e in t3_in if e["id"] and e["id"].endswith("plan:task:T-3:task_dependency")]) == 2,
            f"T-3 有两条依赖入边（多前置不强制成树）：{[e['id'] for e in t3_in]}",
        )
        assert_dependency_vs_integration(page, "施工依赖视图")
        page.screenshot(path=os.path.join(SHOT_DIR, "07-main-construction-dependencies.png"))

        # ── ⑧ 系统架构：模块父级不空集判绿（橙 + 自身集成检查缺口） ──
        step["now"] = "主夹具：系统架构（父级不判绿）"
        open_view(page, "architecture")
        page.wait_for_selector("[data-arch-node]", timeout=40000)
        page.wait_for_timeout(1200)
        arch_states = page.eval_on_selector_all(
            "[data-project-canvas-host] [data-display-status]",
            """els => els.map(e => ({
                 id: e.getAttribute('data-arch-node'),
                 status: e.getAttribute('data-display-status'),
                 text: e.innerText || ''
               }))""",
        )
        info(f"系统架构节点：{[f'{s['id']}={s['status']}' for s in arch_states]}")
        ok(len(arch_states) >= 3, f"系统架构渲染 {len(arch_states)} 个节点（能力 + 声明模块 + 实测模块）")
        parent = next((s for s in arch_states if s["id"] == "src-check"), None)
        ok(parent is not None, "实测模块 src-check（T-4 的模块父级）在画布上")
        if parent is not None:
            # V08-06 收尾（2026-09-24）期望定向更新（判据未放宽）：
            #   旧期望 = src-check 必须**不判绿**（V08-02 口径：模块派生封顶「结果待验证」）。
            #   依据   = DESIGN.md **附录 D**（V08-03 定的模块级验证口径，用户当班裁定「模块层颜色天花板
            #            是设计缺陷，必须现在补齐」）：模块在代码里存在且**成员卡全部 verified** ⇒ 判
            #            「验证通过」，不再封顶。V08-06 把系统架构视图的节点状态改成取**同一份派生表**
            #            （单一来源）后，这条口径才真正落到本视图上——V08-05 那次跑还是
            #            `src-check=pending_verification`（见 v0805-regress 的同名日志）。
            #   新期望 = `src-check == verified`（成员只有 T-4，T-4 已绿 ⇒ 附录 D 的"验证通过"）；
            #            「不空集判绿」这条红线改由**同屏没有成员的物种**来守：无成员的能力一个都不许判绿。
            #   保留意图 = ①"父级不许凭子级自动染绿——要有它自己的判据"、②"节点上带状态词双通道"、
            #            ③"详情说清为什么是这个状态"——三条原样保留。
            #   判据未放宽 = 仍是逐节点精确相等（不是"不报错就算过"），并**新增**"无成员对象必须留灰"。
            ok(
                parent["status"] == "verified",
                f"**父级按附录 D 判绿**：src-check 的成员只有 T-4（已 verified）⇒ 父级判「{parent['status']}」"
                f"（附录 D：非空且成员全绿；反例=T-1 所在的 src-base 仍橙）",
            )
            caps = [s for s in arch_states if s["id"].startswith("plan:cap:")]
            ok(
                bool(caps) and all(s["status"] != "verified" for s in caps),
                f"**不空集判绿（红线）**：没有成员的能力一个都没判绿：{[(s['id'], s['status']) for s in caps]}",
            )
            ok(
                "·" in parent["text"] or "已验证通过" in parent["text"] or "橙" in parent["text"],
                "父级节点上带状态词（色盲可辨的双通道）",
            )
            page.locator('[data-arch-node="src-check"]').click()
            page.wait_for_timeout(500)
            detail = page.locator("[data-project-detail]").inner_text()
            ok(
                "附录 D" in detail or "集成" in detail or "未映射" in detail,
                f"模块父级的详情说清状态依据（附录 D 模块判据 / 自身集成检查 / 未映射）：{detail[:80].replace(chr(10), ' ')}",
            )
        ok(
            all(s["status"] != "verified" for s in arch_states if s["id"] == "src-base"),
            "src-base（T-1 橙）也如实显示橙，不冒充绿",
        )
        page.screenshot(path=os.path.join(SHOT_DIR, "08-main-architecture-parent-not-green.png"))

        # ── ⑨ 折叠/展开（技术详情画布同源：展开子级再折叠，父级坐标不变） ──
        step["now"] = "主夹具：折叠/展开"
        toggles = page.locator("[data-project-canvas-host] button[data-expand-toggle]")
        if toggles.count() > 0:
            toggle_id = toggles.first.get_attribute("data-expand-toggle")
            before_pos = page.locator(f'.react-flow__node[data-id="{toggle_id}"]').first.get_attribute("style")
            before_count = page.locator("[data-project-canvas-host] .react-flow__node").count()
            toggles.first.click()
            page.wait_for_timeout(2500)
            expanded_count = page.locator("[data-project-canvas-host] .react-flow__node").count()
            after_pos = page.locator(f'.react-flow__node[data-id="{toggle_id}"]').first.get_attribute("style")
            ok(expanded_count >= before_count, f"展开子级：{before_count} → {expanded_count} 个节点（原地长出）")
            page.locator(f'[data-project-canvas-host] button[data-expand-toggle="{toggle_id}"]').click()
            page.wait_for_timeout(1200)
            folded_count = page.locator("[data-project-canvas-host] .react-flow__node").count()
            ok(folded_count == before_count, f"折叠回去：{expanded_count} → {folded_count} 个节点（父级没跳）")
            ok(after_pos == before_pos, "展开/收起期间父级坐标不变（局部重排不动全局，§4.6）")
        else:
            ok(False, "系统架构画布上没有可展开的模块节点（夹具里静态模块没解析出来？）")

        # ── ⑩ 跨视图定位 + 返回上次位置（稳定 ID 对齐） ──
        step["now"] = "主夹具：跨视图定位与返回位置"
        open_view(page, "construction")
        page.wait_for_selector("[data-project-canvas-host] .react-flow__node", timeout=30000)
        target = next(s for s in node_states(page) if s["id"].endswith("T-1"))
        page.locator(f'[data-project-node="{target["id"]}"]').click()
        page.wait_for_timeout(300)
        page.locator('[data-detail-goto-view="functional"]').click()
        page.wait_for_timeout(900)
        ok(
            page.locator('[data-arch-tab="functional"]').count() == 1,
            "从施工依赖点「在功能全景定位」→ 切到功能全景（跨视图定位走稳定 ID）",
        )
        note = page.locator("[data-project-locate-note]").first.get_attribute("data-project-locate-state")
        ok(note in ("matched", "unmatched"), f"定位有明确结论（{note}）")
        page.screenshot(path=os.path.join(SHOT_DIR, "09-main-cross-view-locate.png"))
        open_view(page, "construction")
        page.wait_for_timeout(600)
        page.locator("[data-project-return]").click()
        page.wait_for_timeout(900)
        back_note = page.locator("[data-project-locate-note]").first.get_attribute("data-project-locate-note")
        ok("已返回上次位置" in (back_note or ""), f"「返回上次位置」回到上一条位置（{back_note}）")
        page.screenshot(path=os.path.join(SHOT_DIR, "10-main-return-last-position.png"))

        # ── ⑪ 技术详情：主视图 → 技术详情定位（module_id 对齐；旧三图还在） ──
        step["now"] = "主夹具：去技术详情定位"
        code_node = next((s for s in node_states(page) if s["id"].startswith("plan:code:")), None)
        if code_node is None:
            ok(False, "施工依赖视图里没有实测模块端点（静态解析没跑出来？）")
        else:
            page.locator(f'[data-project-node="{code_node["id"]}"]').click()
            page.wait_for_timeout(300)
            page.locator("[data-detail-goto-tech]").click()
            page.wait_for_selector('[data-arch-tab="tech"]', timeout=20000)
            page.wait_for_selector("[data-arch-mode]", timeout=30000)
            page.wait_for_timeout(1500)
            note = page.locator("[data-arch-locate-note]").first
            state = note.get_attribute("data-arch-locate-state") if note.count() else "none"
            ok(state == "matched", f"技术详情侧按 module_id 命中共用层节点并给出结论（{state}）")
            note_text = note.get_attribute("data-arch-locate-note") if note.count() else ""
            ok("已定位" in (note_text or ""), f"技术详情侧定位提示留痕（{note_text}）")
            ok(
                page.locator('[data-graph-mode="MODULE_BOX"]').count() == 1
                and page.locator('[data-graph-mode="DATA_FLOW"]').count() == 1
                and page.locator('[data-graph-mode="MIND_MAP"]').count() == 1,
                "旧三图（方框图 / 数据流向图 / 思维导图）仍在技术详情里，一个都没删",
            )
        page.screenshot(path=os.path.join(SHOT_DIR, "11-main-tech-detail-locate.png"))

        # ── ⑫ 搜索：命中数量 + 无匹配（与"没有规划"分开） ──
        step["now"] = "主夹具：搜索与无匹配"
        open_view(page, "construction")
        page.wait_for_selector("[data-project-canvas-host] .react-flow__node", timeout=30000)
        total = len(node_states(page))
        page.locator("[data-project-search]").fill("T-3")
        page.wait_for_timeout(600)
        hit = len(node_states(page))
        ok(hit < total and hit >= 1, f"搜索 T-3：节点 {total} → {hit}（按稳定 ID/名字命中）")
        page.locator("[data-project-search]").fill("zzz-不存在")
        page.wait_for_timeout(600)
        empty = page.locator("[data-project-empty]").first
        ok(
            empty.count() == 1 and empty.get_attribute("data-project-empty") == "no_match",
            f"搜不到时是**无匹配**（{empty.inner_text()[:40] if empty.count() else '没有空态'}），不是「没有规划」/「加载失败」",
        )
        page.screenshot(path=os.path.join(SHOT_DIR, "12-main-search-nomatch.png"))
        page.locator("[data-project-search]").fill("")
        page.wait_for_timeout(400)

        # ── ⑬ 加载失败 ≠ 无规划（① 首屏就读不出来 → 整块空态卡 + 重试；② 已有图时 → 只挂横幅） ──
        step["now"] = "主夹具：加载失败"
        fail_page = browser.new_context(viewport={"width": 1600, "height": 950}).new_page()
        fail_page.route("**/arch/blueprint*", lambda route: route.abort())
        fail_page.goto(f"{base}/#p/{MAIN}", wait_until="domcontentloaded")
        fail_page.wait_for_selector('button[data-view="arch"]', timeout=60000)
        fail_page.locator('button[data-view="arch"]').click()
        fail_page.locator('[data-project-view-tab="functional"]').click()
        fail_page.wait_for_selector('[data-project-empty="load_failed"]', timeout=30000)
        failed = fail_page.locator('[data-project-empty="load_failed"]').first.inner_text()
        ok("加载失败" in failed and "没有规划" in failed, f"首屏读不出来 → **加载失败**空态卡，且文案显式排除「没有规划」（{failed[:34]}）")
        ok(fail_page.locator("[data-project-retry]").count() == 1, "加载失败给出重试出口（与「无规划」的空态不同）")
        fail_page.screenshot(path=os.path.join(SHOT_DIR, "13-main-load-failed.png"))
        fail_page.unroute("**/arch/blueprint*")
        fail_page.locator("[data-project-retry]").click()
        fail_page.wait_for_selector("[data-project-canvas-host] .react-flow__node", timeout=30000)
        ok(True, "点重试后读回来了（空态卡换回画布）")
        fail_page.close()
        # ② 已经有图时读盘失败：**不报废画布**——只挂横幅，图与视口都留在原地
        step["now"] = "主夹具：刷新失败不报废画布"
        page.route("**/arch/blueprint*", lambda route: route.abort())
        before_err = {s["id"]: s["transform"] for s in node_states(page)}
        vp_before_err = viewport_transform(page)
        page.locator("[data-project-refresh]").click()
        page.wait_for_selector("[data-project-error]", timeout=20000)
        err_text = page.locator("[data-project-error]").first.inner_text()
        after_err = {s["id"]: s["transform"] for s in node_states(page)}
        ok("读取失败" in err_text, f"已有图时读盘失败 → 横幅如实说读取失败（{err_text[:28]}）")
        ok(
            before_err == after_err and len(after_err) > 0 and viewport_transform(page) == vp_before_err,
            f"失败不报废画布：{len(after_err)} 个节点坐标与视口都没动（不清空、不跳回全局）",
        )
        page.unroute("**/arch/blueprint*")
        page.locator("[data-project-error] [data-project-retry]").click()
        page.wait_for_timeout(1200)
        ok(page.locator("[data-project-error]").count() == 0, "重试成功后横幅消失（恢复常态）")
        page.screenshot(path=os.path.join(SHOT_DIR, "13b-main-refresh-fail-banner.png"))

        # ── ⑭ 空仓夹具：灰图 + 超 15 个分组聚合显示数量 ──
        step["now"] = "空仓夹具：灰图与超量聚合"
        goto_project(BIG)
        page.wait_for_selector('[data-project-view-tab="functional"]', timeout=60000)
        open_view(page, "functional")
        page.wait_for_selector("[data-project-canvas-host] .react-flow__node", timeout=30000)
        gray_states = node_states(page)
        statuses = sorted({s["status"] for s in gray_states})
        ok(
            len(gray_states) >= 1 and all(s["status"] in ("unmapped", "planned") for s in gray_states),
            f"空仓（没有一行代码）照样出图：{len(gray_states)} 个灰节点，状态 {statuses}——空仓库不是空图的理由（§3.2）",
        )
        ok(
            any("未映射" in s["label"] or "已规划" in s["label"] for s in gray_states),
            f"灰节点带文字通道（标签：{sorted({s['label'] for s in gray_states})}），不是只靠颜色",
        )
        ok(
            not any(s["status"] == "verified" for s in gray_states),
            "空仓里没有任何节点被判绿（不假绿、不空集判绿，§4.2）",
        )
        page.screenshot(path=os.path.join(SHOT_DIR, "14-big-empty-repo-gray.png"))
        # 2026-09-27：口径注释区默认收起成一行；2026-10-08：外层又套了一层 `details.tt-graph-guide`
        # 折叠（同一次改动的两个落点）。按用户操作顺序先开外层、再开内层——断言一字未改、判据未放宽。
        open_notes_fold(page)
        note = page.locator("[data-project-notes]").inner_text()
        ok("超量聚合" in note and "另外 3 个" in note, f"18 个能力超上限 → 概览聚合并显示数量（说明里：{note.splitlines()[-1][:56]}…）")
        agg = page.locator("[data-project-aggregate]").count()
        ok(
            agg >= 1,
            f"超 15 个分组时画布上出现聚合节点（{agg} 个），把隐藏数量显示出来（§3.3）",
        )
        agg_text = page.locator("[data-project-aggregate]").first.inner_text() if agg else ""
        ok("还有" in agg_text and re.search(r"\d", agg_text) is not None, f"聚合节点文字带数量（{agg_text.replace(chr(10), ' ')[:48]}）")
        page.screenshot(path=os.path.join(SHOT_DIR, "15-big-over-limit-aggregate.png"))

        # ── ⑮ 草稿夹具：未审定方案**可预览**（标草稿图）+ 真正无图纸的项目才是"无规划" ──
        # 2026-09-22（§3.2 落地）：图纸在场、从未激活基线的项目此前只显示"无规划"空态，
        # 用户看不到任何规划内容；现在读口给出**草稿图**并在画布上明标未审定。
        step["now"] = "草稿夹具：草稿图可预览"
        goto_project(DRAFT)
        page.wait_for_selector('[data-project-view-tab="functional"]', timeout=60000)
        open_view(page, "functional")
        draft_banner = page.locator("[data-project-draft]").first
        draft_banner.wait_for(timeout=30000)
        ok(
            draft_banner.get_attribute("data-project-draft") == "draft_unaudited",
            f"未激活基线的项目：画布顶部挂**草稿图**横幅（data-project-draft={draft_banner.get_attribute('data-project-draft')}）",
        )
        # 2026-10-08：草稿横幅是折叠 `<details data-project-draft>`（身份/边界与"未发布原因 baseline_missing"
        # 在正文里），按用户操作先点开再读；判据一字未改。
        draft_banner.locator("summary").click()
        page.wait_for_timeout(250)
        dtext = draft_banner.inner_text()
        ok(
            "草稿" in dtext and "未审定" in dtext and "不能当施工依据" in dtext,
            f"草稿横幅写明身份与边界（{dtext.replace(chr(10), ' ')[:64]}…）",
        )
        ok(
            "baseline_missing" in dtext,
            "草稿横幅带**未发布原因**（baseline_missing，来自服务端 blocking，不是界面自己编的）",
        )
        page.wait_for_selector("[data-project-canvas-host] .react-flow__node", timeout=30000)
        draft_nodes = node_states(page)
        ok(
            len(draft_nodes) >= 1 and all(s["status"] in ("unmapped", "planned") for s in draft_nodes),
            f"草稿图真画出来了：{len(draft_nodes)} 个灰节点（未审定草稿不着任何完成色，§4.2/§3.2）",
        )
        ok(
            not any(s["status"] == "verified" for s in draft_nodes),
            "草稿图里没有任何节点被判绿（未审定不等于已完成）",
        )
        ok(
            page.locator("[data-project-empty]").count() == 0,
            "有草稿可预览时**不再**显示「还没有已发布的规划图」空态（空态与草稿分开）",
        )
        page.screenshot(path=os.path.join(SHOT_DIR, "16-draft-preview.png"))

        # ⑮-2 真正没有图纸源的项目 → 仍是"无规划"（不是加载失败、不提供重试、也不给草稿）
        step["now"] = "无图纸夹具：无规划"
        goto_project(EMPTY)
        page.wait_for_selector('[data-project-view-tab="functional"]', timeout=60000)
        open_view(page, "functional")
        page.wait_for_selector("[data-project-empty]", timeout=30000)
        empty = page.locator("[data-project-empty]").first
        state = empty.get_attribute("data-project-empty")
        ok(state == "no_plan", f"没有任何图纸源的项目 → **无规划**（data-project-empty={state}）")
        ok("没有已发布的规划图" in empty.inner_text(), f"无规划文案与加载失败不同（{empty.inner_text()[:40]}）")
        ok(page.locator("[data-project-retry]").count() == 0, "无规划不提供重试（它不是故障）")
        ok(
            page.locator("[data-project-draft]").count() == 0,
            "派不出草稿时**不挂**草稿横幅（不拿空图冒充草稿）",
        )
        page.screenshot(path=os.path.join(SHOT_DIR, "16b-draft-no-plan.png"))

        # ── ⑯ 不提供涂色入口（§4.2 明令） ──
        step["now"] = "红线：不提供涂色入口"
        write_controls = page.evaluate(
            """() => {
                 const sel = ['input[type=color]', '[data-set-status]', '[data-paint]', '[data-color-picker]', '[data-project-color]'];
                 return sel.flatMap(s => [...document.querySelectorAll(s)]).length;
               }"""
        )
        ok(write_controls == 0, f"三个主视图里没有任何涂色/改状态控件（命中 {write_controls} 个）")
        ok(
            page.evaluate("""() => ![...document.querySelectorAll('button')].some(b => /涂色|改色|设为完成|标记完成/.test(b.innerText))"""),
            "没有任何「涂色/改色/设为完成」按钮",
        )
        ok(not page_errors, f"全程零页面 JS 异常（{page_errors[:2] if page_errors else '无'}）")
        browser.close()


# ══════════════════════════════ 主流程 ══════════════════════════════

def main():
    home = tempfile.mkdtemp(prefix="tatai-v0606-home-")
    work = tempfile.mkdtemp(prefix="tatai-v0606-proj-")
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
        root_main = os.path.join(work, "main")
        root_big = os.path.join(work, "big")
        root_draft = os.path.join(work, "draft")
        root_empty = os.path.join(work, "empty")
        make_main_project(root_main)
        make_big_project(root_big)
        make_draft_project(root_draft)
        make_empty_project(root_empty)

        registry = {
            "version": 1,
            "projects": [
                {"id": MAIN, "name": "夹具·记录工具", "path": root_main, "kind": "fullstack", "registered_at": "2026-09-20T08:00:00+08:00", "last_opened_at": "2026-09-20T08:00:00+08:00"},
                {"id": BIG, "name": "夹具·空仓项目", "path": root_big, "kind": "fullstack", "registered_at": "2026-09-20T08:00:00+08:00", "last_opened_at": "2026-09-20T08:00:00+08:00"},
                {"id": DRAFT, "name": "夹具·未激活草稿", "path": root_draft, "kind": "fullstack", "registered_at": "2026-09-20T08:00:00+08:00", "last_opened_at": "2026-09-20T08:00:00+08:00"},
                {"id": EMPTY, "name": "夹具·无图纸", "path": root_empty, "kind": "fullstack", "registered_at": "2026-09-20T08:00:00+08:00", "last_opened_at": "2026-09-20T08:00:00+08:00"},
            ],
        }
        write(os.path.join(home, "registry.json"), json.dumps(registry, ensure_ascii=False, indent=2) + "\n")

        backend_port = free_port()
        backend = Backend(home, backend_port, logs)
        backend.wait_health()
        for _ in range(40):  # 唯一写入服务把描述符（含凭据）落到 TATAI_HOME 后才算就绪
            if os.path.exists(os.path.join(home, "work-service.json")):
                break
            time.sleep(0.25)
        info(f"后端就绪：http://127.0.0.1:{backend_port}（隔离 TATAI_HOME {home}）")

        # ① 静态解析（真实接口）：实测模块 → 系统架构的"叠加实测代码映射"
        for pid in (MAIN,):
            status, body = backend.api(f"/api/projects/{pid}/arch/parse", "POST")
            if status != 200:
                raise RuntimeError(f"静态解析失败：{body}")
        info("静态解析完成（主夹具 src/base、src/import、src/export、src/check）")

        # ② 激活基线 → 发布规划图
        bp_main = publish_baseline(backend, MAIN)
        bp_big = publish_baseline(backend, BIG)
        info(f"规划图已发布：主夹具 {len(bp_main['nodes'])} 节点（覆盖：设计 {bp_main['coverage']['design_sections']['mapped']} 节 / 任务 {bp_main['coverage']['plan_tasks']['mapped']} 张 / 模块 {bp_main['coverage']['code_modules']['mapped']} 个）")
        info(f"                空仓夹具 {len(bp_big['nodes'])} 节点（能力 {len([n for n in bp_big['nodes'] if n['kind'] == 'capability'])} 个）")

        # ③ 状态事实（真实 work 命令）：T-1 橙（缺证据）/ T-2 蓝 / T-3 红 / T-4 绿
        plan_path = os.path.join(root_main, ".工作台", "plan.md")
        plan_rev = sha256_text(read(plan_path))
        facts = Facts(backend, MAIN)
        for tid, seq in [("T-1", ["ready", "claimed", "executing", "result_submitted"]), ("T-2", ["ready", "claimed", "executing"]), ("T-3", ["ready", "claimed"]), ("T-4", ["ready", "claimed", "executing", "result_submitted"])]:
            facts.submit(f"task:{tid}", "task.definition_imported", {"definition_sha256": sha256_text(tid + "-def"), "plan_revision": plan_rev, "definition_revision": 1})
            for s in seq:
                if s == "claimed":
                    facts.submit(f"task:{tid}", "task.claimed", {"run_id": f"run-{tid}", "attempt_id": "a1", "owner_id": "kimi-code", "claim_token": f"tok-{tid}", "lease_expires_at": "2026-09-21T00:00:00+08:00"})
                elif s == "executing":
                    facts.submit(f"task:{tid}", "task.status_changed", {"status": "executing"})
                elif s == "result_submitted":
                    # P2/V09-47 返工：只置状态走既有状态边界（task.status_changed），不是结果交付提交
                    # （task.result_submitted 现在一律按交付提交被锁内核实：缺认领 token/证据即拒）
                    facts.submit(f"task:{tid}", "task.status_changed", {"status": "result_submitted"})
                else:
                    facts.submit(f"task:{tid}", "task.status_changed", {"status": s})
        facts.submit("task:T-3", "task.blocked", {"reason": "导出通道被上游格式变更卡住，等 T-2 定稿"})
        ev = "e" * 64
        # V09-01 定向适配（判据收紧，未放宽）：写侧新闸要求新提交的通过检查声明 verifies（附录 E.3.3）。
        # 这两条夹具自检核的是「卡面施工图验收条款落实」，声明 "document"（plan 绑定合法）；场景与断言不变。
        # T-1：只交了自检、缺第二项检查与交付包 diff → 橙（缺哪项说哪项）
        facts.submit(
            "check:T-1-self",
            "audit.self_check_recorded",
            {
                "task_id": "T-1",
                "round": 1,
                "checked_by": "kimi-code",
                "checks": [{"check_id": "T-1::check:0", "method": "跑一次水平尺", "evidence_sha256": ev, "verifies": "document"}],
                "conclusion": "pass",
                "binding": {"revision_kind": "plan", "revision": plan_rev},
            },
        )
        # T-4：自检 + 独立审计（覆盖五个视角）→ 绿
        facts.submit(
            "check:T-4-self",
            "audit.self_check_recorded",
            {
                "task_id": "T-4",
                "round": 1,
                "checked_by": "kimi-code",
                "checks": [{"check_id": "T-4::check:0", "method": "跑一次校验", "evidence_sha256": ev, "verifies": "document"}],
                "conclusion": "pass",
                "binding": {"revision_kind": "plan", "revision": plan_rev},
            },
        )
        facts.submit(
            "audit:T-4-ind",
            "audit.independent_audit_recorded",
            {
                "task_id": "T-4",
                "round": 1,
                "auditor": "claude-code",
                "author_id": "kimi-code",
                "checks": [
                    {"check_id": "T-4::check:0", "result": "passed", "evidence_sha256": ev},
                    {"check_id": "T-4::evidence", "result": "passed", "evidence_sha256": ev},
                ],
                "coverage": [
                    {"area": "behavior_boundaries", "status": "checked", "basis": "跑了边界用例"},
                    {"area": "data_concurrency", "status": "checked", "basis": "并发两次导入"},
                    {"area": "interface_integration", "status": "checked", "basis": "读了调用方原文"},
                    {"area": "failure_recovery", "status": "checked", "basis": "断网重试"},
                    {"area": "trust_permission", "status": "checked", "basis": "只读模式探针"},
                ],
                "conclusion": "pass",
                "binding": {"revision_kind": "plan", "revision": plan_rev},
            },
            actor="claude-code",
            role="auditor",
        )
        info("状态事实已写入：T-1 橙 / T-2 蓝 / T-3 红 / T-4 绿（+ T-3 的阻塞原因）")

        # ④ 造"图正在更新 / 图已过期"：源改了 + 一次语义整理真失败（没配密钥）→ 保留上次有效图 + 留回执
        # 改的是**设计书**（不是施工图）：检查记录绑定在施工图定义修订上，动施工图会把已过的检查
        # 全判成"源变了→旧绿转待验证"，那就测不出"绿来自投影 / 父级不空集判绿"这几条了。
        with open(os.path.join(root_main, ".工作台", "design.md"), "a", encoding="utf-8", newline="\n") as f:
            f.write("\n## 5. 备注\n\n2026-09-20：导出格式改了一版（夹具：源已更新、图还没重画）。\n")
        status, body = backend.api(f"/api/projects/{MAIN}/arch/blueprint", "POST", {"trigger": "fixture-semantic", "semantic": True, "force": True})
        receipt = (body or {}).get("result", {}) if isinstance(body, dict) else {}
        info(f"语义整理尝试（无密钥，真失败）：published={receipt.get('publish', {}).get('published')} kept_previous={receipt.get('kept_previous')} reason={str(receipt.get('publish', {}).get('reason'))[:60]}")
        status, bp_after = backend.api(f"/api/projects/{MAIN}/arch/blueprint")
        ok(
            bp_after["blueprint"]["exists"] and bp_after["blueprint"]["blueprint"]["baseline_id"] == bp_main["baseline_id"],
            "派生失败后**上次有效图仍在**（baseline_id 未变，§4.4）",
        )
        ok(
            bp_after["blueprint"]["receipt"] is not None and bp_after["blueprint"]["receipt"]["published"] is False,
            f"失败留回执（published={bp_after['blueprint']['receipt']['published']}，原因可从回执读）",
        )

        # ⑤ 前端 dev + 浏览器场景
        vite_port = free_port()
        vite = start_vite(vite_port, backend_port, os.path.join(SHOT_DIR, "vite.log"))
        info(f"vite 就绪：http://localhost:{vite_port}（代理 → {backend_port}）")
        run_browser(vite_port, backend_port)
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
            info(f"保留现场：TATAI_HOME={home} · 项目={work}（V0606_KEEP_TMP=1）")
        else:
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(work, ignore_errors=True)

    print(f"[ui] 计数：{passes[0]} PASS / {len(fails)} FAIL")
    print(f"[ui] 截图目录：{SHOT_DIR}")
    if fails:
        for f in fails:
            print(f"[ui]   FAIL {f}")
        sys.exit(1)
    print("[ui] 全部 PASS")


if __name__ == "__main__":
    main()
