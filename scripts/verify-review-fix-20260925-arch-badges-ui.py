#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""review-fix-20260925／H-4：三张主视图节点级来源与证据徽标 ＋ 六图真机复测。

用法：python scripts/verify-review-fix-20260925-arch-badges-ui.py
      （V09H4_SHOT_DIR 换输出目录、V09H4_KEEP_TMP=1 保留现场）

为什么必须跑真浏览器（复核项 H-4 的判据就是"上屏"）：
  H-4 的原文是「架构主视图（系统架构）复用共用画布时**未传 provenance** ⇒ 该屏节点锚点
  `data-arch-node` 上没有来源/证据徽标（实测 0/0）」。读口（GET arch/blueprint 的 provenance）
  在 V09-13 就已带上，坏的是**这一屏的接线**——只有真 DOM 里数得出来的徽标才算修好。

六图逐屏（DESIGN.md §3.2／附录 E.5）：功能全景(functional) / 系统架构(architecture) /
施工依赖(construction) ＋ 技术详情三张：模块方框图(MODULE_BOX) / 数据流向图(DATA_FLOW) /
思维导图(MIND_MAP)。

真机口径（隔离按 AGENTS.md §5）：
  · 起**真**后端（`node --import tsx src/server/index.ts`）+ **真** vite，端口全走动态空闲端口
    （不占 5173、不碰 65050 上别人残留的 dev）；
  · 数据目录 = 临时 `TATAI_HOME`（真实 `~/.tatai` 的只读拷贝，含真实注册表）⇒ 读的是
    真实项目 D:\\tatai 的真实 `.工作台`，而写口落在临时区，零接触 ~/.tatai；
  · 全程只读浏览六图：不点 Gate、不触发解析、不调任何写接口；
  · 收尾杀净两端、删临时目录；另记 `~/.tatai` 与真实 events.jsonl 的首尾指纹自证零写入
    （V09-21／R6 起：`~/.tatai` 的比对口径**排除服务自建、会自我重写的启动骨架**
    `work-service.json`（含原子写残留）与 `logs/`，其余按内容 sha256 比对；被排除骨架的前后读数
    与写入服务探活结果原样记进 `readings.zero_write`；events.jsonl 的 sha256 一致性判据不变）。
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
EVID = os.path.join(REPO, ".工作台", "evidence", "review-fix-20260925", "arch-badges")
SHOT_DIR = os.environ.get("V09H4_SHOT_DIR", EVID)
READINGS = os.path.join(SHOT_DIR, "readings.json")
REAL_HOME = os.path.join(os.path.expanduser("~"), ".tatai")
REAL_ID = "tatai"
REAL_ROOT = REPO
BLOCKED_CONCLUSION = "不可判定项目可交付"
REQUESTABLE_CONCLUSION = "可请求验收"

passes = [0]
fails = []
infos = []


def ok(cond, label):
    print(("[ui] PASS " if cond else "[ui] FAIL ") + label)
    if cond:
        passes[0] += 1
    else:
        fails.append(label)


def info(msg):
    infos.append(msg)
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


def http(url, method="GET", body=None, timeout=180):
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


def file_sha256(path):
    if not os.path.isfile(path):
        return "n/a"
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ── 零写入自证的比对口径（V09-21／R6 定向更新，五要素留档）──
#   旧期望＝真实 ~/.tatai **整棵树**的 {相对路径 + 字节数} 指纹首尾必须逐字节一致｜
#   依据＝`src/server/registry.ts:63`／`:71-75` 已经把写入服务描述符 `work-service.json` 与 `logs/`
#         一起定为「**启动期自建、不含项目事实**的骨架」（前者原文：「每次 listen 都会重写（work/service.ts）」）；
#         `work/service.ts#writeServiceDescriptor` 落盘是「写 `work-service.json.<pid>.<ms>.tmp` + rename」，
#         所以重写的那一瞬还会在目录里留下**原子写残留**。数据目录里唯一写入服务上线/让位，或 MCP 客户端
#         按需自愈拉起它（`work/service.ts#ensureWorkService`），都会重写描述符、往 `logs/work-service.jsonl`
#         追生命周期行——这**不是探针写的**，却让「本次探针零写入」这条自证误报红（F-F 偶发红）｜
#   新期望＝口径**排除那份会自我重写的启动骨架**（描述符本体＋原子写残留＋`logs/` 目录），其余条目
#         （`agents.json`／`config.json`／`registry.json`／`remote/`／用户自己放的文件…）逐个比对，
#         且比对口径由 {路径+字节数} **收紧为每个文件的内容 sha256**（同长度改内容也藏不住）｜
#   保留意图＝「本次真机探针没往真实数据目录写一个字节」必须继续被证明：项目**唯一事实源**
#         `.工作台/work/events.jsonl` 的首尾 sha256 一致性仍按原判据硬断言（本节不动它）；
#         被排除的那份骨架的前后读数**原样记进 readings**（连同写入服务探活结果），不偷偷忽略｜
#   判据不放宽：排除的只是服务自建骨架；其余文件按**内容哈希**全等，路径集合或内容错配即红。
BOOT_SKELETON_FILE = "work-service.json"
BOOT_SKELETON_DIRS = ("logs",)


def is_boot_skeleton(rel):
    """该相对路径是否属于「服务自建、会自我重写、不含项目事实」的启动骨架。"""
    if rel == BOOT_SKELETON_FILE or rel.startswith(BOOT_SKELETON_FILE + "."):
        return True
    return any(rel == d or rel.startswith(d + "/") for d in BOOT_SKELETON_DIRS)


def tree_fingerprint(root, limit=3000):
    """真实数据目录首尾指纹（R6 口径：排除启动骨架；其余按内容 sha256 比对）。

    返回 {"files", "hash", "excluded"}：前两项是**参与比对**的那部分（断言只看它们），
    `excluded` 只作读数留档（骨架前后变了多少如实记下来，供人查，不参与判定）。
    """
    rows = []
    excluded = []
    if not os.path.isdir(root):
        return {"files": 0, "hash": "n/a", "excluded": excluded}
    for cur, dirs, files in os.walk(root):
        keep = []
        for name in sorted(dirs):
            rel_d = os.path.relpath(os.path.join(cur, name), root).replace("\\", "/")
            if is_boot_skeleton(rel_d):
                continue
            keep.append(name)
        dirs[:] = keep
        for name in sorted(files):
            p = os.path.join(cur, name)
            rel = os.path.relpath(p, root).replace("\\", "/")
            try:
                size = os.path.getsize(p)
            except OSError:
                size = -1
            if is_boot_skeleton(rel):
                sha = file_sha256(p)
                excluded.append("%s\t%d\t%s" % (rel, size, sha[:12]))
                continue
            rows.append("%s\t%s" % (rel, file_sha256(p)))
            if len(rows) >= limit:
                break
    # 骨架目录整体没进上面的遍历（剪枝了），单独把它们的条目记进读数
    for d in BOOT_SKELETON_DIRS:
        base = os.path.join(root, d)
        if not os.path.isdir(base):
            continue
        for cur, _dirs, files in os.walk(base):
            for name in sorted(files):
                p = os.path.join(cur, name)
                rel = os.path.relpath(p, root).replace("\\", "/")
                try:
                    size = os.path.getsize(p)
                except OSError:
                    size = -1
                excluded.append("%s\t%d\t%s" % (rel, size, file_sha256(p)[:12]))
    rows.sort()
    excluded.sort()
    return {
        "files": len(rows),
        "hash": hashlib.sha256("\n".join(rows).encode("utf-8")).hexdigest(),
        "excluded": excluded,
    }


def work_service_probe(home):
    """只读探活真实数据目录里的唯一写入服务描述符（不拉起、不清理、不写一个字节）。

    为什么要它：R6 把描述符排除出比对口径，那就得**如实说清**被排除的那份骨架当时是什么状态
    （有没有服务在跑、描述符是不是陈旧遗留），而不是让读的人以为「排除了就等于没这回事」。
    返回体只带 pid/host/port/探活结果，**不带 token**。
    """
    desc_path = os.path.join(home, BOOT_SKELETON_FILE)
    if not os.path.isfile(desc_path):
        return {"descriptor": "absent", "note": "描述符不在＝服务没起（或未初始化）"}
    try:
        with open(desc_path, "r", encoding="utf-8") as f:
            d = json.load(f)
    except Exception as e:  # noqa: BLE001
        return {"descriptor": "unreadable", "note": str(e)[:120]}
    out = {
        "descriptor": "present",
        "pid": d.get("pid"),
        "host": d.get("host"),
        "port": d.get("port"),
        "started_at": d.get("started_at"),
    }
    try:
        code, _body = http("http://%s:%s/api/work/health" % (d.get("host"), d.get("port")), timeout=3)
        out["health_http"] = code
        out["alive"] = code == 200
    except Exception as e:  # noqa: BLE001
        out["alive"] = False
        out["health_error"] = str(e)[:120]
    return out


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

    def api(self, path):
        return http("http://127.0.0.1:%d%s" % (self.port, path))

    def wait_health(self, timeout=180):
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
    deadline = time.time() + 150
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


def text(page, selector):
    loc = page.locator(selector)
    return loc.first.inner_text() if loc.count() > 0 else ""


def shot(page, name):
    os.makedirs(SHOT_DIR, exist_ok=True)
    path = os.path.join(SHOT_DIR, name)
    page.screenshot(path=path, full_page=False)
    ok(os.path.exists(path) and os.path.getsize(path) > 3000,
       "截图落盘 %s（%d B）" % (name, os.path.getsize(path)))
    return name


# 主视图节点徽标读数：来源档位 + 证据状态 + 徽标的实际渲染色（证明五档在图上可区分）
MAIN_BADGE_JS_MODE = """
() => {
  const rows = [];
  for (const e of document.querySelectorAll('[data-project-node]')) {
    rows.push({
      node: e.getAttribute('data-project-node'),
      source: e.getAttribute('data-project-source-kind'),
      state: e.getAttribute('data-project-evidence-state'),
      pending: e.getAttribute('data-project-user-pending'),
      label_el: document.querySelector('[data-project-evidence-badge="' + e.getAttribute('data-project-node') + '"]'),
      src_el: document.querySelector('[data-project-source-badge="' + e.getAttribute('data-project-node') + '"]'),
    });
  }
  return rows.map(r => {
    const cs = r.label_el ? getComputedStyle(r.label_el) : null;
    return {
      node: r.node, source: r.source, state: r.state, pending: r.pending,
      source_text: r.src_el ? r.src_el.innerText.trim() : null,
      evidence_text: r.label_el ? r.label_el.innerText.trim() : null,
      evidence_bg: cs ? cs.backgroundColor : null,
      evidence_fg: cs ? cs.color : null,
    };
  });
}
"""

LEGEND_JS = """(scopeSel) => {
  const host = document.querySelector(scopeSel) || document;
  return Array.from(host.querySelectorAll('[data-delivery-state-legend] [data-delivery-state-chip]')).map(e => {
    const cs = getComputedStyle(e);
    return {
      state: e.getAttribute('data-delivery-state-chip'),
      label: e.getAttribute('data-delivery-state-chip-label'),
      text: e.innerText.trim(),
      bg: cs.backgroundColor, fg: cs.color,
    };
  });
}
"""

ARCH_BADGE_JS = """() => {
  const nodes = Array.from(document.querySelectorAll('[data-arch-node]'));
  return nodes.map(e => {
    const id = e.getAttribute('data-arch-node');
    const src = document.querySelector('[data-arch-source-badge="' + id + '"]');
    const ev = document.querySelector('[data-arch-evidence-badge="' + id + '"]');
    const cs = ev ? getComputedStyle(ev) : null;
    return {
      node: id,
      aggregate: e.hasAttribute('data-arch-aggregate') ? '1' : null,
      source_kind: e.getAttribute('data-arch-source-kind'),
      evidence_state: e.getAttribute('data-arch-evidence-state'),
      user_pending: e.getAttribute('data-arch-user-pending'),
      source_text: src ? src.innerText.trim() : null,
      evidence_text: ev ? ev.innerText.trim() : null,
      evidence_bg: cs ? cs.backgroundColor : null,
      evidence_fg: cs ? cs.color : null,
    };
  });
}
"""


WAIT_RENDER_TIMEOUT_MS = 60000


def wait_rendered(page, probe, ready, where, expect, timeout=WAIT_RENDER_TIMEOUT_MS, interval=250, probe_arg=None):
    """确定性等待「异步渲染到位」再读——读的判据本身就是原断言的谓词（V09-21／R6，五要素留档）。

    旧期望＝`wait_for_selector` 之后按**定长睡眠**（各屏 600ms／1500ms／2500ms 不等）就一次取值，
           徽标/读数盘这时必须已经全在场｜
    依据＝这些锚点都不是静态标签：徽标的文字与颜色由 `ArchView` 异步取到的 provenance 重渲染出来，
           `MindMapView` 在它自己的取值未回时整枝渲染成「加载中…」（连读数盘都不在 DOM 里）。
           数据面重（本次 423 条标注 / 167 条阻断 / 29 条未验证）时，定长睡眠是**时点赌注**：
           慢一拍就整屏读到 0——判据本身没错，错在"没等它画完"（F-F 偶发红；同因还表现为
           后面每条 `page.get_attribute(...)` 各自空等 30s 并把整轮跑挂掉，后面断言一条都不执行）｜
    新期望＝按**同一份读数的完成判据**轮询（默认 250ms、60s 上限），判据成立才读；超时就把
           最后一次读数原样返回，交给**原有断言**判红（不是静默放过）｜
    保留意图＝每条断言仍在 DOM 真上屏的前提下判、仍会因真实回归变红；被等掉的是"渲染还没到"，
           不是"没有徽标也该算过"｜
    判据不放宽：`ready` 用的就是紧邻断言的**同一谓词**（例如"非聚合节点一个不缺地带徽标"），
           不是"等到 >0 就算数"；超时无果照样红，且把等待耗时如实记进读数。
    上限取 60s 的依据：本卡实测（并行施工窗口里）该产权重的取值偶发 >30s 才落地——健康时轮询
    第一次就成立、几乎不花时间；只有在"真慢/真没接上"时才走到上限，那时如实判红。
    """
    t0 = time.time()
    value = None
    waited = 0.0
    while True:
        value = page.evaluate(probe, probe_arg) if probe_arg is not None else page.evaluate(probe)
        if ready(value):
            break
        waited = time.time() - t0
        if waited * 1000 >= timeout:
            break
        page.wait_for_timeout(interval)
    waited = time.time() - t0
    info("%s：等 %s 渲染到位用了 %.0fms%s" % (where, expect, waited * 1000,
                                          "" if ready(value) else "（**超时**，交原断言判）"))
    return value


def arch_rows_ready(rows):
    """架构/模块方框图：存在节点且**非聚合对象节点一个不缺**地带来源与证据徽标（原断言谓词）。"""
    badged = [r for r in rows if r["source_text"] and r["evidence_text"]]
    objects = [r for r in rows if r["aggregate"] != "1"]
    return len(rows) > 0 and len(badged) > 0 and len(badged) == len(objects)


def main_rows_ready(rows):
    """功能全景/施工依赖：每个节点都带来源种类与证据状态，且徽标文字真上屏（原两条断言谓词）。"""
    badged = [r for r in rows if r["source"] not in (None, "") and r["state"] not in (None, "")]
    return (len(rows) > 0 and len(badged) == len(rows)
            and all(r["source_text"] and r["evidence_text"] for r in rows))


def wait_arch_badges(page, where):
    return wait_rendered(page, ARCH_BADGE_JS, arch_rows_ready, where, "节点徽标")


def wait_main_badges(page, where):
    return wait_rendered(page, MAIN_BADGE_JS_MODE, main_rows_ready, where, "节点徽标")


def wait_readout(page, scope_sel, where, timeout=WAIT_RENDER_TIMEOUT_MS):
    """确定性等待该屏**读数盘挂上 DOM**（本脚本后面每条 `page.get_attribute(scope + ' ...')` 的前提）。

    同 wait_rendered 的五要素（旧期望＝定长睡眠后读数盘必在；依据＝读数盘随异步 provenance 渲染，
    `MindMapView` 未取到时整枝不渲染；新期望＝轮询到在为止；保留意图＝判据仍按真实上屏；
    判据不放宽＝**只等出现**，出现后各条断言的判据一字不改，超时后照样走原路径判红）。
    """
    return wait_rendered(
        page,
        "(sel) => document.querySelectorAll(sel + ' [data-delivery-readout]').length",
        lambda n: n > 0,
        where, "读数盘", timeout=timeout, interval=250, probe_arg=scope_sel,
    )


def wait_legend_chips(page, scope_sel, where, timeout=WAIT_RENDER_TIMEOUT_MS):
    """确定性等待该屏**五档图例渲染出来**（展开后读短标/渲染色之前）。

    同 wait_rendered 的五要素：旧期望＝点开 `[data-delivery-expand]` 后睡 350ms 图例必在；
    依据＝图例与读数盘同批渲染、且会随面板重渲染短暂缺席；新期望＝轮询到「未映射＋五档＝6 枚
    chip」齐了才读；保留意图＝仍要求**恰好五档**（`data-delivery-state-chip` 去掉 unmapped 后
    必须恰 5 且文字通道逐档在场）；判据不放宽＝等到的是"图例齐"，不是把"五档"改成"有几档算几档"；
    超时后照原判据判红。
    """
    return wait_rendered(
        page,
        "(sel) => { const h = document.querySelector(sel);"
        " return h ? h.querySelectorAll('[data-delivery-state-legend] [data-delivery-state-chip]').length : -1; }",
        lambda n: n >= 6,
        where, "五档图例", timeout=timeout, interval=250, probe_arg=scope_sel,
    )


def run_browser(vite_port, backend, readings):
    base = "http://localhost:%d" % vite_port
    EVIDENCE_FIVE = ["verified", "user_pending", "unverified", "missing", "invalidated"]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(viewport={"width": 1680, "height": 1050}).new_page()
        page.goto("%s/#p/%s" % (base, REAL_ID), wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        page.locator('button[data-view="arch"]').click()
        page.wait_for_selector(ROOT, timeout=40000)
        page.wait_for_timeout(2000)

        observed = {}  # 证据状态 → [label, bg]（跨三张主视图收集，用于"五档在图上可区分"）
        legend_seen = {}  # 每屏的五档图例（短标 + 实际渲染色）

        def check_legend(where, scope_sel, rec):
            # V09-20 定向更新（2026-09-26 用户指令，五要素留档）：
            #   旧期望＝五档图例在**默认态**（常显 summary 里）即可读到｜
            #   依据＝旧读数盘把口径摆在常显 summary；DESIGN §3.11／§4.2「人用图面口径」（2026-09-26 用户澄清）
            #         改为：六图默认只占**简短一行**，五档含义/计数/逐条名单进**按需详情**｜
            #   新期望＝**默认摘要准确**（结论 + 阻断/待验条数，且默认态不含五档图例与逐条名单）
            #         ＋点开 `[data-delivery-expand]` 后五档与逐条证据**完整可见**｜
            #   保留意图＝五档仍可区分（短标与渲染色两两不同、颜色之外有文字通道）、逐条证据一条不少｜
            #   判据不放宽：五档仍是「恰好 5」（＋未映射），展开后 `data-delivery-reason` 逐条计数必须等于
            #         `data-delivery-reasons` 属性值（不抽样、不省略）。
            # V09-21／R6 定向补充（同因偶发红：读得比渲染早，五要素见 wait_readout／wait_legend_chips）：
            #   先确定性等到这份读数盘挂上 DOM，再按原有顺序读——面板随异步 provenance 渲染，
            #   定长睡眠读早了会让下面每条 `page.get_attribute(...)` 各自空等 30s（本卡实测：
            #   MIND_MAP 屏整枝在重渲染窗口里缺席 ⇒ 读数盘读不到 ⇒ 抛异常把整轮跑挂掉，
            #   后面断言一条都不执行）。等的只是"面板到了"，判据一字未改。
            wait_readout(page, scope_sel, "%s 屏" % where)
            summary_text = page.evaluate(
                "(sel) => { const s = document.querySelector(sel + ' [data-delivery-readout] summary');"
                " return s ? s.innerText.replace(/\\s+/g,' ').trim() : null; }",
                scope_sel,
            )
            rec["delivery_summary_default"] = summary_text
            rec["delivery_summary_default_chars"] = len(summary_text or "")
            # 同批定向更新：结论**按当前 verdict 蕴含式**判（不钉死某一种数据态）
            _v = page.get_attribute(scope_sel + " [data-delivery-readout]", "data-delivery-verdict")
            _expect = BLOCKED_CONCLUSION if _v == "blocked" else REQUESTABLE_CONCLUSION
            ok(bool(summary_text) and _expect in summary_text,
               "%s 屏默认摘要给出结论（verdict=%s；%r）" % (where, _v, summary_text))
            # 注：默认行**允许**出现各档构成的短标签（如「证据失效 47」）——那是"简短原因"，不是平铺图例。
            # 判据落在**DOM 结构**上：默认摘要里不许有五档 chip、不许有逐条 reason/pending；另限行长。
            _chips_in_summary = page.locator(scope_sel + " [data-delivery-readout] summary [data-delivery-state-chip]").count()
            _reasons_in_summary = page.locator(scope_sel + " [data-delivery-readout] summary [data-delivery-reason]").count()
            ok(
                summary_text is not None
                and _chips_in_summary == 0
                and _reasons_in_summary == 0
                and "能力分类" not in summary_text
                and "不代签" not in summary_text
                and len(summary_text) <= 140,
               "%s 屏默认态**只一行**：默认摘要里没有五档 chip／逐条名单／能力分类长解释／常显「不代签」（%d 字；%r）"
               % (where, len(summary_text or ""), summary_text),
            )
            page.locator(scope_sel + " [data-delivery-expand]").first.click()
            page.wait_for_timeout(350)
            # V09-21／R6 定向补充（同因偶发红）：展开后**等到五档图例齐**（未映射＋五档＝6 枚 chip）再读；
            # 等到的是"图例到了"，不是把"恰好五档"放宽成"有几档算几档"——超时后照原判据判红。
            wait_legend_chips(page, scope_sel, "%s 屏（展开后）" % where)
            chips = page.evaluate(LEGEND_JS, scope_sel)
            states = [c for c in chips if c["state"] != "unmapped"]
            rec["state_legend_scope"] = scope_sel
            rec["state_legend"] = chips
            legend_seen[where] = chips
            labels = [c["label"] for c in states]
            bgs = [c["bg"] for c in states]
            ok(len(states) == 5 and len(set(labels)) == 5 and len(set(bgs)) == 5,
               "%s 屏**展开后**的五档证据状态图例：五档短标与渲染色两两不同（本屏一份：%r）" % (where, list(zip(labels, bgs))))
            ok(all(c["text"] for c in chips),
               "%s 屏**展开后**图例每档都带文字通道（%r）" % (where, [c["text"] for c in chips]))
            reasons_attr = page.get_attribute(scope_sel + " [data-delivery-readout]", "data-delivery-reasons")
            pending_attr = page.get_attribute(scope_sel + " [data-delivery-readout]", "data-delivery-user-pending")
            n_reasons = page.locator(scope_sel + " [data-delivery-reason]").count()
            n_pending = page.locator(scope_sel + " [data-delivery-pending]").count()
            rec["reasons_expanded"] = [reasons_attr, n_reasons]
            rec["pending_expanded"] = [pending_attr, n_pending]
            ok(int(reasons_attr or 0) == n_reasons,
               "%s 屏展开后逐条阻断原因**一条不少**（属性 %s / DOM %d）" % (where, reasons_attr, n_reasons))
            ok(int(pending_attr or 0) == n_pending,
               "%s 屏展开后逐条人工待验**一条不少**（属性 %s / DOM %d）" % (where, pending_attr, n_pending))
            # 关闭：详情是浮层，收起后画布不被压（§3.11）
            # （R6：关之前同样确定性等到读数盘在——它若在重渲染窗口里短暂缺席，"关闭"这一步的点击
            #   会各自空等 30s 并把整轮跑挂掉；等的只是"面板在"，关闭判据不变。）
            wait_readout(page, scope_sel, "%s 屏（关闭前）" % where)
            page.locator(scope_sel + " [data-delivery-detail-close]").first.click()
            page.wait_for_timeout(250)
            still_open = page.evaluate(
                "(sel) => { const d = document.querySelector(sel + ' [data-delivery-readout] details'); return d ? d.open : null; }",
                scope_sel,
            )
            ok(still_open is False, "%s 屏详情可关闭（收起后画布高度不受影响）" % where)

        def collect_states(rows, where):
            for r in rows:
                st = r.get("state") or r.get("evidence_state")
                lb = r.get("evidence_text")
                if st in EVIDENCE_FIVE and lb:
                    observed.setdefault(st, {"label": lb, "bg": r.get("evidence_bg"), "seen_at": []})
                    if where not in observed[st]["seen_at"]:
                        observed[st]["seen_at"].append(where)

        # ══ 主视图三张 ══
        for idx, viewk in enumerate(["functional", "architecture", "construction"], start=1):
            page.locator('[data-project-view-tab="%s"]' % viewk).click()
            page.wait_for_timeout(600)
            page.wait_for_selector(ROOT, timeout=30000)
            node_sel = "[data-arch-node]" if viewk == "architecture" else "[data-project-node]"
            try:
                page.wait_for_selector(node_sel, timeout=25000)
            except Exception:  # noqa: BLE001
                pass
            page.wait_for_timeout(1500)
            # R6（同因偶发红）：徽标等**渲染到位**再读，且**截图落在等到之后**——免得证据图是一张
            # "徽标还没上屏"的时点照。等的谓词＝本屏两条断言的谓词（架构＝非聚合节点全带徽标；
            # 功能全景/施工依赖＝每节点都有来源种类+证据状态且徽标文字真上屏），断言一字未改。
            rows = (
                wait_arch_badges(page, "%s 屏" % viewk)
                if viewk == "architecture"
                else wait_main_badges(page, "%s 屏" % viewk)
            )
            rec = {
                "graph": viewk,
                "kind": "main",
                "question": text(page, "[data-project-view-switch] + span"),
                "node_count": (
                    page.locator("[data-project-view] [data-arch-node]").count()
                    if viewk == "architecture"
                    else page.locator("[data-project-node]").count()
                ),
                "screenshot": shot(page, "%02d-%s.png" % (idx, viewk)),
            }
            ok(rec["node_count"] > 0, "主视图 %s 渲染非空（%d 个节点）" % (viewk, rec["node_count"]))

            if viewk == "architecture":
                badged = [r for r in rows if r["source_text"] and r["evidence_text"]]
                aggregates = [r for r in rows if r["aggregate"] == "1"]
                rec["nodes"] = [
                    {"node": r["node"], "aggregate": r["aggregate"], "source_kind": r["source_kind"],
                     "evidence_state": r["evidence_state"], "source_text": r["source_text"],
                     "evidence_text": r["evidence_text"], "evidence_bg": r["evidence_bg"]}
                    for r in rows
                ]
                rec["badge_counts"] = {"nodes": len(rows), "badged": len(badged), "aggregate": len(aggregates)}
                info("架构主视图节点徽标：%d/%d 带徽标（聚合节点 %d 个）"
                     % (len(badged), len(rows), len(aggregates)))
                # H-4 的判据：这一屏的每个**对象节点**都要带来源档位 + 证据状态
                ok(len(badged) > 0 and len(badged) == len(rows) - len(aggregates),
                   "**H-4 已修**：架构主视图全部对象节点带来源与证据徽标（%d/%d，聚合节点 %d 个不冒充对象）"
                   % (len(badged), len(rows), len(aggregates)))
                ok(len(badged) > 0 and all(
                    r["source_kind"] not in (None, "") and r["evidence_state"] not in (None, "") for r in badged),
                   "架构主视图每个带徽标节点都有 data-arch-source-kind / data-arch-evidence-state 属性")
                agg_note = page.evaluate(
                    "Array.from(document.querySelectorAll('[data-arch-aggregate]')).map(e => "
                    "[e.getAttribute('data-arch-node'), !!document.querySelector('[data-arch-aggregate-note=\"' + e.getAttribute('data-arch-node') + '\"]')])"
                )
                rec["aggregate_note"] = agg_note
                ok(all(has_note for _id, has_note in agg_note),
                   "聚合节点显式写明「不是可对账对象、不进来源/证据标注」（%r）——不被误读成该屏标注又缺了" % (agg_note,))
                collect_states(rows, viewk)
                # 点开一个对象节点 → 详情里能看到 basis 细节（与另两主视图同一交互）
                target = next((r["node"] for r in badged if not r["node"].startswith("plan:aggregate")), None)
                if target is not None:
                    page.locator('[data-arch-node="%s"]' % target).first.click()
                    page.wait_for_timeout(600)
                    sec = page.locator("[data-detail-section='provenance']")
                    detail_text = sec.first.inner_text() if sec.count() == 1 else ""
                    rec["detail_after_click"] = {"node": target, "provenance_section": sec.count() == 1,
                                                 "excerpt": detail_text[:300]}
                    ok(sec.count() == 1 and "来源种类" in detail_text and "证据状态" in detail_text
                       and "映射" in detail_text,
                       "架构主视图点开节点 %s ⇒ 详情有「来源与证据」段（含来源种类/映射/证据状态/basis）"
                       % target)
                    ok("（" in detail_text and "）" in detail_text and len(detail_text) > 120,
                       "详情里能读到判据句 basis（不是只给一个色块）：%s…"
                       % detail_text.replace("\n", " ")[:90])
                    shot(page, "%02d%s-architecture-detail.png" % (idx, "b"))
                else:
                    ok(False, "架构主视图没有可点的对象节点（测不出详情 basis）")
            else:
                badged = [r for r in rows if r["source"] not in (None, "") and r["state"] not in (None, "")]
                rec["nodes"] = [
                    {"node": r["node"], "source_kind": r["source"], "evidence_state": r["state"],
                     "source_text": r["source_text"], "evidence_text": r["evidence_text"],
                     "evidence_bg": r["evidence_bg"]}
                    for r in rows
                ]
                rec["badge_counts"] = {"nodes": len(rows), "badged": len(badged)}
                ok(len(rows) > 0 and len(badged) == len(rows),
                   "主视图 %s 每个节点都带来源种类与证据状态（%d/%d）" % (viewk, len(badged), len(rows)))
                ok(all(r["source_text"] and r["evidence_text"] for r in rows),
                   "主视图 %s 的徽标文字真上屏（不是只有属性）：样例 %r"
                   % (viewk, [(r["node"], r["source_text"], r["evidence_text"]) for r in rows[:2]]))
                collect_states(rows, viewk)

            # 交付阻断读数（三个主视图都要有）
            # V09-20 定向更新（2026-09-26，五要素留档）：
            #   旧期望＝界面读数结论**钉死**「不可判定项目可交付」｜
            #   依据＝那张卡交付时（2026-09-25）真实项目的证据面确实是 blocked；此后证据按 §5.6 重绑，
            #         数据态回到「可请求验收」——钉死状态＝把旧数据态锁进断言（V09-17/V09-18 已就同
            #         一类问题把 verdict 钉值改成蕴含式；本处当时漏改）｜
            #   新期望＝**蕴含式**：verdict=blocked ⇒ 结论必须是「不可判定项目可交付」且 deliverable_allowed=0；
            #         verdict=requestable ⇒ 结论「可请求验收」且 deliverable_allowed=1｜
            #   保留意图＝"存在阻断就不许给可请求验收"这条红线，以及界面与读口同源｜
            #   判据不放宽：错配即判红（旧写法只认一种数据态，新写法把两种都管起来）。
            verdict_v = attr(page, ROOT, "data-project-delivery")
            conclusion = attr(page, ROOT, "data-project-delivery-conclusion")
            rec["delivery_verdict"] = verdict_v
            rec["delivery_conclusion"] = conclusion
            expect_conclusion = BLOCKED_CONCLUSION if verdict_v == "blocked" else REQUESTABLE_CONCLUSION
            ok(conclusion == expect_conclusion and verdict_v in ("blocked", "requestable", "none"),
               "主视图 %s 的交付读数＝「%s」（verdict=%s，与读口同一份派生）" % (viewk, conclusion, verdict_v))
            ok(not (verdict_v == "blocked" and conclusion == REQUESTABLE_CONCLUSION),
               "主视图 %s 存在阻断时**不给**「可请求验收」（红线）" % viewk)
            panels = page.locator("[data-project-view] [data-delivery-readout]").count()
            rec["delivery_panels"] = panels
            ok(panels == 1,
               "主视图 %s 的读数盘**只有一份**（复用共用画布的那屏没有重复上屏：%d 份）" % (viewk, panels))
            check_legend(viewk, "[data-project-view]", rec)
            # 画布真正拿到的可视面积与落在画布框里的节点数（"徽标在场"必须**看得见**才算数）
            rec["canvas_box"] = page.evaluate(
                "(sel) => { const e = document.querySelector(sel); if (!e) return null;"
                " const r = e.getBoundingClientRect();"
                " return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)}; }",
                "[data-project-canvas-host]",
            )
            # 徽标要**看得清**：fitView 收全图时 26/51 个节点会缩到字体不可读 ⇒ 放大后补一张，
            # 再把一个节点单独裁一张特写（徽标文字 + 颜色在图上可读，不止是 DOM 属性）。
            # ── V09-21／R6 同因补充（无界点击治理，五要素留档；不在本卡两条指名项内，同类"偶发红"）──
            #   旧期望＝循环里**无界点击** `.react-flow__controls-zoomin`（3 次预热 + 最多 24 次），
            #        直到"有节点 ≥150×70"或点够 24 次｜
            #   依据＝React Flow 的放大钮到 maxZoom 会变 `disabled`（实测日志：`element is not enabled`）；
            #        Playwright 对 disabled 元素的点击**不会失败也不会生效**，只会一直等——于是整轮
            #        以 `Locator.click: Timeout 30000ms exceeded` 抛异常中止，**后面所有断言一条都不执行**
            #        （本卡实测两处：09:47 基线跑在施工依赖屏、R3 并行改动把主视图初始 fit 比例抬高后
            #        更早触顶；诊断拷贝跑到施工依赖屏同样中止）。这是探针的**无界重试**，不是判据问题｜
            #   新期望＝点之前先看钮**是否可用**：不可用＝缩放已到上限，直接停手——预热循环 break、
            #        特写循环 break 后走**原有的兜底**（"放大后仍没有整块落在画布框里的节点 ⇒ 裁画布
            #        中心一块"，同一份 ≥2000 B 落盘判据）｜
            #   保留意图＝"徽标可读的特写图必须真落盘"不变：够大就裁节点、不够大就裁画布中心，两条路都在；
            #        放大次数上限（24）与 150×70 的目标尺寸一字未改｜
            #   判据不放宽：没有任何阈值/断言被改或删；只是**不再点击一个点了也没用的禁用钮**
            #        （旧写法在此情形下拿不到图、只会把整轮跑挂掉；新写法照样必须落盘一张真像素图）。
            zoomin = page.locator(".react-flow__controls-zoomin")
            if zoomin.count() > 0:
                for _ in range(3):
                    if not zoomin.first.is_enabled():
                        break
                    zoomin.first.click()
                    page.wait_for_timeout(250)
                page.wait_for_timeout(400)
                shot(page, "%02db-%s-badges-zoomed.png" % (idx, viewk))
                # React Flow 节点是绝对定位在变换容器里、画布框又是 overflow:hidden：
                # 直接对节点元素截图在它被裁到框外时会得到空白小图。这里按**节点与画布框的交集**
                # 在页面上裁一块；一直放大到有一个节点够大（≥150×70 px）为止——各视图 fitView
                # 后的初始比例差很多（塔台的系统架构是纵向长图，初始比例比功能全景小一个量级）。
                node_rect = None
                for _ in range(24):
                    node_rect = page.evaluate(
                        "() => { const host = document.querySelector('[data-project-canvas-host]'); if (!host) return null;"
                        " const hr = host.getBoundingClientRect(); let best = null, bestArea = 0;"
                        " for (const el of host.querySelectorAll('.react-flow__node')) {"
                        "   const r = el.getBoundingClientRect();"
                        "   const x = Math.max(r.left, hr.left), y = Math.max(r.top, hr.top);"
                        "   const x2 = Math.min(r.right, hr.right), y2 = Math.min(r.bottom, hr.bottom);"
                        "   const w = x2 - x, h = y2 - y, a = w * h;"
                        "   if (w > 60 && h > 40 && a > bestArea)"
                        "     { bestArea = a; best = {x: x, y: y, width: w, height: h, id: el.getAttribute('data-id')}; } }"
                        " return best; }"
                    )
                    if node_rect is not None and node_rect["width"] >= 150 and node_rect["height"] >= 70:
                        break
                    if not zoomin.first.is_enabled():  # R6：到缩放上限就停手，走下面的兜底裁切
                        break
                    zoomin.first.click()
                    page.wait_for_timeout(200)
                if node_rect is not None:
                    path = os.path.join(SHOT_DIR, "%02dc-%s-first-node.png" % (idx, viewk))
                    page.screenshot(path=path, clip={
                        "x": node_rect["x"], "y": node_rect["y"],
                        "width": node_rect["width"], "height": node_rect["height"],
                    })
                    rec["closeup_node"] = node_rect["id"]
                    ok(os.path.getsize(path) > 2000,
                       "节点特写（徽标可读）落盘 %s（节点 %s）"
                       % (os.path.basename(path), node_rect["id"]))
                else:
                    # 兜底：放大后仍没有整块落在画布框里的节点时，裁画布框中心一块（照样是真实像素）
                    box = page.evaluate(
                        "(sel) => { const e = document.querySelector(sel); const r = e.getBoundingClientRect();"
                        " return {x: r.x, y: r.y, w: r.width, h: r.height}; }",
                        "[data-project-canvas-host]",
                    )
                    clip = {"x": box["x"], "y": box["y"] + 10, "width": min(box["w"], 560),
                            "height": min(box["h"] - 20, 320)}
                    path = os.path.join(SHOT_DIR, "%02dc-%s-first-node.png" % (idx, viewk))
                    page.screenshot(path=path, clip=clip)
                    rec["closeup_node"] = None
                    rec["closeup_clip"] = clip
                    info("%s：放大后没有整块落在画布框内的节点，改裁画布中心一块 %r" % (viewk, clip))
                    ok(os.path.getsize(path) > 2000, "节点区特写（裁画布框）落盘 %s" % os.path.basename(path))
                page.locator(".react-flow__controls-fitview").click()
                page.wait_for_timeout(500)
            rec["nodes_inside_canvas_box"] = page.evaluate(
                "() => { const host = document.querySelector('[data-project-canvas-host]'); if (!host) return 0;"
                " const hr = host.getBoundingClientRect(); let n = 0;"
                " for (const el of host.querySelectorAll('.react-flow__node')) {"
                "   const r = el.getBoundingClientRect();"
                "   if (r.width > 0 && r.height > 0 && r.bottom > hr.top && r.top < hr.bottom"
                "       && r.right > hr.left && r.left < hr.right) n++; }"
                " return n; }"
            )
            info("%s：画布框 %r，框内可见节点 %s/%s"
                 % (viewk, rec["canvas_box"], rec["nodes_inside_canvas_box"], rec["node_count"]))
            ok((rec["canvas_box"] or {}).get("h", 0) > 80 and rec["nodes_inside_canvas_box"] > 0,
               "主视图 %s 的画布有可用面积（h=%s px）且节点落在框内（%d 个）——徽标**看得见**不只是属性在"
               % (viewk, (rec["canvas_box"] or {}).get("h"), rec["nodes_inside_canvas_box"]))
            readings["graphs"].append(rec)

        # ── 五档在图上可区分（用**真实渲染出来的徽标**证明，不靠词表自证） ──
        readings["evidence_states_on_graph"] = observed
        info("三张主视图上实际出现的证据状态：%s"
             % json.dumps({k: v["label"] for k, v in observed.items()}, ensure_ascii=False))
        labels = [v["label"] for v in observed.values()]
        bgs = [v["bg"] for v in observed.values()]
        # 定向更新（2026-09-25 终审收口；判据不放宽）：
        #   旧期望＝「三张主视图上至少出现 4 档证据状态」——钉在项 4b 修复前的数据态；
        #   依据＝数据变健康后图上真实只剩 2 档（user_pending／unverified），钉值必红（终审报告 P2）；
        #   新期望＝图上实际出现的证据状态集合 == 读口**节点级**计数里 count>0 的档位集合（动态对照，不落钉值）；
        #   保留意图＝节点一旦落入缺证/失效档，该档徽标必须在图上真实出现（藏不住）；不同档的短标与渲染色
        #   仍须两两不同（下一条）；错标绿仍由「没有任何一档被错标成已验证」守住。
        expected_states = {
            k for k, v in (readings.get("readout", {}).get("node_state_counts") or {}).items()
            if isinstance(v, int) and v > 0
        }
        ok(len(observed) > 0 and set(observed.keys()) == expected_states,
           "图上出现的证据状态档 == 读口节点级计数里 count>0 的档（图上 %d 档：%s；读口节点档：%s）"
           % (len(observed), "、".join(sorted(observed.keys())),
              json.dumps(readings.get("readout", {}).get("node_state_counts"), ensure_ascii=False)))
        ok(len(set(labels)) == len(labels) and len(set(bgs)) == len(bgs),
           "已出现的各档**短标两两不同、徽标渲染色也两两不同**（label=%r bg=%r）" % (labels, bgs))
        ok(all(v["label"] != "已验证" or k == "verified" for k, v in observed.items()),
           "没有任何一档被错标成「已验证」（五档文案与状态一一对应）")

        # ══ 技术详情三张 ══
        page.locator('[data-project-view-tab="tech"]').click()
        page.wait_for_selector("[data-graph-mode-switch]", timeout=30000)
        page.wait_for_timeout(800)

        # 4) 模块方框图
        # ── V09-21／R6【必修·本卡指名的一条】模块方框图徽标偶发 0：改成**确定性等待**（五要素留档）──
        #   旧期望＝`wait_for_selector('[data-arch-mode="MODULE_BOX"]')` 之后**定长睡 2500ms** 一次读完徽标，
        #        要求「节点非空且非聚合对象节点一个不缺地带来源与证据徽标」｜
        #   依据＝徽标文字/颜色由 `ArchView` 异步取到的 provenance 重渲染出来（`data-arch-source-badge` /
        #        `data-arch-evidence-badge`）；数据面重（本次 423 条标注 / 167 条阻断）时 2500ms 只是
        #        **时点赌注**——慢一拍整屏 `badged` 读到 0（F-F 实测偶发红：07 号基线跑就在 MODULE_BOX 撞过，
        #        判据本身没错，错在"没等它画完"）｜
        #   新期望＝反复取**同一份** `ARCH_BADGE_JS` 读数，直到「存在节点且非聚合节点全部带徽标」成立
        #        （250ms 轮询、60s 上限）；超时就把最后一次读数交给下面的**原有断言**判红｜
        #   保留意图＝「这一屏的对象节点一个不缺地带徽标」仍按 DOM 真上屏判（不是属性在就算数）；
        #        真实回归（徽标接线断了/被聚合冒充）照样红｜
        #   判据不放宽：轮询的完成判据＝**下面那条断言的同一谓词**（`arch_rows_ready`），不是"等到 >0 就算数"；
        #        超时无果照样红，等待耗时如实记进读数（rec 里另记 `badge_wait_ms`）。
        page.locator('[data-graph-mode="MODULE_BOX"]').click()
        page.wait_for_selector('[data-arch-mode="MODULE_BOX"]', timeout=40000)
        _t_badges = time.time()
        mb = wait_arch_badges(page, "MODULE_BOX 屏")
        mb_badged = [r for r in mb if r["source_text"] and r["evidence_text"]]
        readings["graphs"].append({
            "graph": "MODULE_BOX", "kind": "tech", "question": text(page, "[data-mode-question]"),
            "node_count": len(mb), "badge_counts": {"nodes": len(mb), "badged": len(mb_badged)},
            "nodes": [{"node": r["node"], "source_kind": r["source_kind"], "evidence_state": r["evidence_state"]}
                      for r in mb],
            "badge_wait_ms": round((time.time() - _t_badges) * 1000),
            "screenshot": shot(page, "04-module-box.png"),
        })
        ok(len(mb) > 0 and len(mb_badged) == len([r for r in mb if r["aggregate"] != "1"]),
           "模块方框图：节点 %d 个、带徽标 %d 个（来源与状态都在）" % (len(mb), len(mb_badged)))
        check_legend("MODULE_BOX", "[data-arch-canvas-host]", readings["graphs"][-1])
        collect_states(mb, "MODULE_BOX")

        # 5) 数据流向图（逐跳标签 + 覆盖对账 + 交付阻断新读数）
        page.locator('[data-graph-mode="DATA_FLOW"]').click()
        page.wait_for_selector('[data-flow-legend]', timeout=40000)
        page.wait_for_selector("[data-flow-summary]", timeout=40000)
        page.wait_for_timeout(1200)
        page.locator("details[data-flow-coverage] > summary").click()
        page.wait_for_timeout(400)
        df_nodes = page.locator("[data-flow-node]").count()
        # 关系面板默认折叠（折叠时 innerText 读不到）——先点开再读逐跳标签
        page.locator("details[data-flow-relations] > summary").click()
        page.wait_for_timeout(400)
        df_edges = page.locator("[data-flow-edge]").count()
        edge_hop_labels = page.evaluate(
            "Array.from(document.querySelectorAll('[data-flow-edge]')).map(e => e.querySelector('summary').innerText)"
        )
        hop_ok = [t for t in edge_hop_labels if "→" in t and "来源 " in t]
        cov_rows = page.locator("[data-flow-coverage-row]").count()
        blocked_flag = attr(page, "[data-flow-blocked]", "data-flow-blocked")
        readings["graphs"].append({
            "graph": "DATA_FLOW", "kind": "tech", "question": text(page, "[data-mode-question]"),
            "node_count": df_nodes, "edge_count": df_edges, "coverage_rows": cov_rows,
            "deliverable_blocked": blocked_flag,
            "current_implementation_note": text(page, "[data-flow-current-implementation]")[:200],
            "target_semantics_note": text(page, "[data-flow-target-semantics]")[:200],
            "hop_labels": edge_hop_labels,
            "screenshot": shot(page, "05-data-flow.png"),
        })
        ok(df_nodes > 0 and df_edges > 0, "数据流向图屏有实体/关系（%d/%d）" % (df_nodes, df_edges))
        ok(len(hop_ok) == df_edges,
           "数据流向图**逐跳标签在场**：%d/%d 条关系的标题行带方向与来源档位" % (len(hop_ok), df_edges))
        ok(cov_rows > 0, "数据流向图屏覆盖对账逐条在场（%d 行）" % cov_rows)
        # V09-11／intent-path 之后的**新读数**：intent.json 缺路径已补 ⇒ 逐跳缺路径类阻断应为 false
        ok(blocked_flag == "false",
           "数据流向图屏交付阻断读数＝%r（intent.json 缺路径已补 ⇒ 新读数应为 false）" % blocked_flag)
        check_legend("DATA_FLOW", "[data-arch-canvas-host]", readings["graphs"][-1])
        page.locator("details[data-flow-coverage] > summary").click()
        page.wait_for_timeout(300)

        # 6) 思维导图
        page.locator('[data-graph-mode="MIND_MAP"]').click()
        page.wait_for_selector("[data-mindmap-source]", timeout=60000)
        page.wait_for_timeout(2500)
        mm_nodes = attr(page, "[data-mindmap-source]", "data-mindmap-nodes")
        mm_prov = page.locator("[data-mm-provenance]").count()
        readings["graphs"].append({
            "graph": "MIND_MAP", "kind": "tech", "question": text(page, "[data-mode-question]"),
            "node_count": int(mm_nodes) if mm_nodes not in (None, "") else None,
            "depth": attr(page, "[data-mindmap-source]", "data-mindmap-depth"),
            "provenance_rows": mm_prov,
            "screenshot": shot(page, "06-mind-map.png"),
        })
        ok(mm_nodes not in (None, "") and int(mm_nodes) > 0, "思维导图屏有节点（%r）" % (mm_nodes,))
        ok(mm_prov > 0, "思维导图屏逐节点带来源/证据标注（%d 行 data-mm-provenance）" % mm_prov)
        check_legend("MIND_MAP", "[data-mindmap-host]", readings["graphs"][-1])
        readings["state_legend_by_screen"] = legend_seen

        browser.close()


def main():
    tmp = tempfile.mkdtemp(prefix="tatai-h4ui-")
    home = os.path.join(tmp, "home")
    shutil.copytree(REAL_HOME, home)
    os.makedirs(SHOT_DIR, exist_ok=True)
    log_dir = SHOT_DIR
    home_before = tree_fingerprint(REAL_HOME)
    events = os.path.join(REAL_ROOT, ".工作台", "work", "events.jsonl")
    events_before = file_sha256(events)
    # R6：被排除的那份「服务自建骨架」当时是什么状态、唯一写入服务在不在——如实留痕，不偷偷忽略
    daemon_before = work_service_probe(REAL_HOME)
    info("真实 ~/.tatai 指纹（前，口径=排除服务启动骨架 %s）：%d 文件 / %s…（另记 %d 条骨架读数）"
         % (list(BOOT_SKELETON_DIRS) + [BOOT_SKELETON_FILE], home_before["files"],
            home_before["hash"][:12], len(home_before["excluded"])))
    info("真实 ~/.tatai 写入服务探活（只读，不拉起）：%s" % json.dumps(daemon_before, ensure_ascii=False))
    info("真实 events.jsonl sha256（前）：%s…" % events_before[:16])

    backend_port = free_port()
    vite_port = free_port()
    backend = None
    vite = None
    readings = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "project": REAL_ID, "graphs": []}
    try:
        backend = Backend(home, backend_port, os.path.join(log_dir, "ui-backend.log"))
        backend.wait_health()
        info("后端就绪：127.0.0.1:%d（TATAI_HOME=%s）" % (backend_port, home))
        vite = start_vite(vite_port, backend_port, os.path.join(log_dir, "ui-vite.log"))
        info("vite 就绪：http://localhost:%d" % vite_port)

        # ── 读口先自证：同一份派生（服务端）的读数，供与 UI 读数逐条对照 ──
        _s, bp = backend.api("/api/projects/%s/arch/blueprint" % REAL_ID)
        pv = (bp or {}).get("provenance") or {}
        delivery = pv.get("delivery") or {}
        counts = delivery.get("counts") or {}
        _s, df = backend.api("/api/projects/%s/arch/dataflow" % REAL_ID)
        model = (df or {}).get("data_flow") or {}
        cov = model.get("coverage") or {}
        readings["readout"] = {
            "provenance_objects": len(pv.get("annotations") or []),
            "provenance_counts": counts,
            "delivery_verdict": delivery.get("verdict"),
            "delivery_conclusion": delivery.get("conclusion"),
            "delivery_reasons": len(delivery.get("reasons") or []),
            "delivery_user_pending": len(delivery.get("user_pending") or []),
            "requirements": pv.get("requirements"),
            "dataflow_coverage": {k: cov.get(k) for k in
                                  ("declared_total", "covered", "missing", "not_implemented", "missing_paths")},
            "dataflow_deliverable_blocked": model.get("deliverable_blocked"),
        }
        info("读口读数：对象 %s 个（%s）；交付结论「%s」；数据流覆盖 %s/%s、缺路径 %s、deliverable_blocked=%s"
             % (len(pv.get("annotations") or []), json.dumps(counts, ensure_ascii=False),
                delivery.get("conclusion"), cov.get("covered"), cov.get("declared_total"),
                cov.get("missing"), model.get("deliverable_blocked")))
        # 定向更新（2026-09-25 终审收口；判据不放宽）：
        #   旧期望＝五档计数全部 >0——钉在项 4b 修复前的数据态（当时 invalidated=19／missing>0）；
        #   依据＝项 4b 落地后数据变健康（missing=0／invalidated=0），旧钉法必红（终审报告 P2 实测 59 PASS/2 FAIL）；
        #   新期望＝五档键齐全、计数非负、且五档合计 == 逐对象标注总数（计数与标注对账一致）；
        #   保留意图＝五档词表完整在场（五档图例另有逐屏断言）；缺证/失效/未验证若 >0，交付结论必须仍是
        #   blocked（下一条单向断言守住「红档藏不住」）；错标绿由「没有被错标成已验证」与读口对账共同守住。
        FIVE = ("verified", "user_pending", "unverified", "missing", "invalidated")
        annotations = pv.get("annotations") or []
        node_state_counts = {}
        for _a in annotations:
            if _a.get("object_kind") == "node":
                _st = _a.get("evidence_state")
                node_state_counts[_st] = node_state_counts.get(_st, 0) + 1
        readings["readout"]["node_state_counts"] = node_state_counts
        ok(len(annotations) >= 50
           and all(k in counts and int(counts.get(k, 0)) >= 0 for k in FIVE)
           and sum(int(counts.get(k, 0)) for k in FIVE) == len(annotations),
           "读口带逐对象来源/证据标注，五档计数键齐全、非负且合计==对象总数（对象 %d 个：%s）"
           % (len(annotations), json.dumps(counts, ensure_ascii=False)))
        ok(not any(int(counts.get(k, 0)) > 0 for k in ("unverified", "missing", "invalidated"))
           or delivery.get("verdict") == "blocked",
           "缺证/失效/未验证任一 >0 ⇒ 交付结论必须 blocked（§4.2／E.9；当前 verdict=%s，counts=%s）"
           % (delivery.get("verdict"), json.dumps(counts, ensure_ascii=False)))
        # V09-20 定向更新（2026-09-26，五要素留档；与上面逐屏那条同一处理）：
        #   旧期望＝读口 verdict 钉死 blocked、deliverable_allowed 必须 false（钉在 2026-09-25 的数据态）｜
        #   依据＝证据按 §5.6 重绑后数据态回到 requestable；钉死旧态＝把过期状态锁进断言｜
        #   新期望＝**蕴含式**：blocked ⇒ conclusion=不可判定项目可交付 且 deliverable_allowed=false；
        #         requestable ⇒ conclusion=可请求验收 且 deliverable_allowed=true｜
        #   保留意图＝「不许把有阻断的读成可请求验收」的红线 + 读口与界面同源｜
        #   判据不放宽：两种数据态都必须与 deliverable_allowed 一致，错配即红。
        verdict_v = delivery.get("verdict")
        allowed = delivery.get("deliverable_allowed")
        expect_c = BLOCKED_CONCLUSION if verdict_v == "blocked" else REQUESTABLE_CONCLUSION
        ok(verdict_v in ("blocked", "requestable", "none")
           and delivery.get("conclusion") == expect_c
           and allowed is (verdict_v == "requestable"),
           "读口交付读数＝「%s」（verdict=%s, deliverable_allowed=%r，与界面读数同源）"
           % (delivery.get("conclusion"), verdict_v, allowed))
        ok(cov.get("missing_paths") == [] and model.get("deliverable_blocked") is False,
           "数据流向图读数（V09-11／intent-path 后）：缺路径 %r、deliverable_blocked=%r"
           % (cov.get("missing_paths"), model.get("deliverable_blocked")))

        run_browser(vite_port, backend, readings)
    except Exception as e:  # noqa: BLE001
        ok(False, "运行期出错：%s" % e)
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
        if os.environ.get("V09H4_KEEP_TMP") != "1":
            shutil.rmtree(tmp, ignore_errors=True)

    home_after = tree_fingerprint(REAL_HOME)
    events_after = file_sha256(events)
    daemon_after = work_service_probe(REAL_HOME)
    readings["zero_write"] = {
        # R6：比对的那部分（排除启动骨架，按内容 sha256）＋被排除骨架的前后读数＋服务探活。
        # 前后两次探活都只读（探活本身不写、不拉起）。
        "scope": {
            "excluded_files": [BOOT_SKELETON_FILE, BOOT_SKELETON_FILE + ".*（原子写残留）"],
            "excluded_dirs": list(BOOT_SKELETON_DIRS),
            "reason": "启动期自建、会自我重写、不含项目事实（src/server/registry.ts BOOT_SKELETON_ENTRIES）",
            "compared_by": "每个文件的内容 sha256（原 {路径+字节数} 的收紧版）",
        },
        "compared_before": home_before, "compared_after": home_after,
        "excluded_before": home_before["excluded"], "excluded_after": home_after["excluded"],
        "work_service_before": daemon_before, "work_service_after": daemon_after,
        "events_sha256_before": events_before, "events_sha256_after": events_after,
    }
    info("真实 ~/.tatai 指纹（后）：%d 文件 / %s…（骨架读数 %d 条，前后%s）"
         % (home_after["files"], home_after["hash"][:12], len(home_after["excluded"]),
            "有变化（已按启动骨架口径排除、记进 readings）" if home_before["excluded"] != home_after["excluded"]
            else "无变化"))
    info("真实 ~/.tatai 写入服务探活（后）：%s" % json.dumps(daemon_after, ensure_ascii=False))
    ok(home_before["hash"] == home_after["hash"] and home_before["files"] == home_after["files"],
       "零写入自证：真实 ~/.tatai 首尾指纹一致（比对口径＝排除服务启动骨架 %s 后、%d 个文件按内容 sha256 全等；"
       "被排除的骨架前后读数与写入服务探活结果已原样记进 readings.zero_write）"
       % (BOOT_SKELETON_FILE + "＋" + "/".join(BOOT_SKELETON_DIRS + ("*",)), home_after["files"]))
    ok(events_before == events_after, "零写入自证：真实 .工作台/work/events.jsonl 首尾 sha256 一致")
    readings["passes"] = passes[0]
    readings["fails"] = fails
    write(READINGS, json.dumps(readings, ensure_ascii=False, indent=2) + "\n")
    print("[ui] 读数已写入 %s" % READINGS)
    print("[ui] 计数：%d PASS / %d FAIL" % (passes[0], len(fails)))
    if fails:
        print("[ui] 存在 FAIL")
        sys.exit(1)
    print("[ui] 全部 PASS")


if __name__ == "__main__":
    main()
