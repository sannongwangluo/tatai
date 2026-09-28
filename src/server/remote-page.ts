// ═══════════════════════════════════════════════════════════════════════════════════
// 三期 S2：远程只读页面（PLAN.md S2 卡 DoD①「局域网内另一台设备只读查看」的落点）。
//
// 为什么是一张自包含 HTML 而不是第二套前端：U1 红线的精神是"壳里零业务 UI、界面只此一份"，
// 塔台的前端产物（`src/ui`）是给桌面壳与本地浏览器用的**完整工作台**（含终端、落稿、Gate 操作）。
// 远程设备需要的只是「只读看到四样」：项目列表 / 设计书（含待议）/ 架构图数据 / Gate 时间线。
// 所以这里不引 React、不复制任何业务规则、不建构建步骤——页面只做两件事：
//   ① 用 Authorization 头把口令换成会话（POST /api/remote/login），会话 id 只存在本标签页的
//      sessionStorage 里（关标签页即丢，不落 cookie → 没有 CSRF 面，也没有"忘了登出"的常驻凭据）；
//   ② 逐个调**服务端既有读接口**（`/api/projects`、`/design`、`/discuss`、`/arch/render`、
//      `/progress`、`/gate.jsonl`）并把 JSON 画出来——零业务口径，服务端返回什么就显示什么。
// 写接口一个都不调（调了也只会收到 403 REMOTE_READ_ONLY，见 `remote-routes.ts` 的清单）。
//
// 安全口径（与 auth.ts 的红线配套）：
//   · 页面本体是唯一免凭据的响应（`PUBLIC_PATHS`），内容里**没有任何项目数据**，只有登录表单；
//   · 响应带 nonce 的 CSP（脚本只认本页那一段）+ no-store，不缓存、不许被嵌进别的站点；
//   · 所有数据一律经 `esc()` 转义后进 DOM（项目名/设计书/待议/聊天都是用户数据，禁拼原始 HTML）。
// ═══════════════════════════════════════════════════════════════════════════════════

/** 页面 HTML（`nonce` 由调用方每次现生成，供 CSP 认脚本） */
export function remotePageHtml(nonce: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>塔台 · 远程只读</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #0b0d10; color: #e6e8eb; }
  header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
           padding: 10px 16px; border-bottom: 1px solid #23272e; background: #11141a; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  .ro { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #3a2a12; color: #f5c26b;
        border: 1px solid #5c4320; }
  .spacer { flex: 1; }
  .muted { color: #8b949e; font-size: 12px; }
  button { font: inherit; background: #1f242c; color: #e6e8eb; border: 1px solid #333a44;
           border-radius: 6px; padding: 5px 12px; cursor: pointer; }
  button:hover { background: #262c35; }
  button:disabled { opacity: .5; cursor: default; }
  button.tab { border-radius: 6px 6px 0 0; border-bottom-color: transparent; }
  button.tab.on { background: #1b2733; border-color: #2f5d86; color: #9ccdf7; }
  main { padding: 16px; max-width: 1100px; }
  .card { border: 1px solid #23272e; border-radius: 8px; padding: 14px; background: #11141a; }
  .row { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
  .col-left { min-width: 230px; flex: 0 0 250px; }
  .col-right { flex: 1; min-width: 320px; }
  ul.projects { list-style: none; margin: 0; padding: 0; }
  ul.projects li { padding: 7px 9px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
  ul.projects li:hover { background: #171b21; }
  ul.projects li.on { background: #1b2733; border-color: #2f5d86; }
  .kind { font-size: 11px; color: #8b949e; margin-left: 6px; }
  pre { white-space: pre-wrap; word-break: break-word; background: #0e1116; border: 1px solid #23272e;
        border-radius: 6px; padding: 10px; max-height: 60vh; overflow: auto; margin: 0; }
  .nodes { display: flex; flex-wrap: wrap; gap: 8px; }
  .node { border: 1px solid #2b313a; border-radius: 6px; padding: 6px 9px; background: #0e1116; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .timeline { list-style: none; margin: 0; padding: 0; }
  .timeline li { border-left: 2px solid #2b313a; padding: 4px 0 4px 12px; margin-left: 4px; }
  .pass { color: #7ee787; } .reject { color: #ff7b72; } .pending { color: #d0a215; }
  .msg { margin-top: 10px; padding: 8px 10px; border-radius: 6px; font-size: 13px; display: none; }
  .msg.err { display: block; background: #2b1416; border: 1px solid #6b2b32; color: #ffb4ab; }
  .msg.ok { display: block; background: #12251a; border: 1px solid #2b6b46; color: #9be8b4; }
  input[type=password] { font: inherit; width: 100%; padding: 8px 10px; border-radius: 6px;
        border: 1px solid #333a44; background: #0e1116; color: #e6e8eb; }
  label { display: block; margin: 6px 0; font-size: 13px; color: #c9d1d9; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #23272e; font-size: 13px; }
  .hide { display: none; }
</style>
</head>
<body>
<header>
  <h1>塔台 · 远程只读视图</h1>
  <span class="ro">只读模式</span>
  <span class="muted" id="session-info">未登录</span>
  <span class="spacer"></span>
  <button id="logout" class="hide">登出</button>
</header>
<main>
  <div class="card" id="login-card">
    <label>远程口令（主机上跑 <code>pnpm remote:token</code> 取；口令只用于换会话，不落浏览器存储）</label>
    <input type="password" id="token" autocomplete="off" placeholder="43 位口令">
    <p><button id="login">进入只读视图</button></p>
    <p class="muted">本页只提供只读查看：项目列表 / 设计书（含待议）/ 架构图数据 / Gate 时间线。
      写接口在服务端一律被拒（403 REMOTE_READ_ONLY）；聊天记录默认不下发（主机要显式置位 TATAI_REMOTE_CHAT=1）。</p>
  </div>

  <div id="viewer" class="hide">
    <div class="row">
      <div class="col-left card">
        <div class="muted" style="margin-bottom:8px">项目列表</div>
        <ul class="projects" id="projects"></ul>
      </div>
      <div class="col-right">
        <div class="card" id="detail">
          <div id="tabs"></div>
          <div id="panel" style="margin-top:12px"></div>
        </div>
      </div>
    </div>
  </div>

  <div class="msg" id="msg"></div>

  <div class="card" style="margin-top:16px">
    <p class="muted" style="margin:0">数据来路：页面只调服务端既有读接口，一个字节的本地路径都不落在远程设备上。
      会话到期或用「登出」后，本页的会话凭据立即失效。</p>
  </div>

  <footer style="margin-top:24px;padding-top:12px;border-top:1px solid #23272e;font-size:12px;color:#8b949e">
    塔台 Tatai · 杭州三农网络科技有限公司 · GNU AGPL-3.0
    · <a href="https://github.com/sannongwangluo/tatai" style="color:#9ccdf7" rel="noreferrer noopener">源代码</a>
    （基于本项目提供服务时，须以同协议提供对应源代码）
  </footer>
</main>
<script nonce="${nonce}">
(function () {
  var SKEY = "tatai.remote.session";
  var STATUS_COLORS = { done: "#3fb950", doing: "#d29922", issue: "#f85149", todo: "#8b949e" };
  var state = { sid: null, expiresAt: 0, chatExposed: false, projectId: null, tab: "design", loopback: false };
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function showMsg(text, kind) {
    var box = $("msg");
    box.className = "msg " + (kind || "err");
    box.textContent = text;
  }
  function clearMsg() { $("msg").className = "msg"; $("msg").textContent = ""; }

  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    var cred = opts.credential || state.sid;
    if (cred) headers.authorization = "Bearer " + cred;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    return fetch(path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      cache: "no-store"
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = {};
        try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
        // Q37（2026-09-18 审计）：原始文本一并带回——ndjson 端点（gate.jsonl）的正文
        // 在"恰好一条记录"时会 JSON.parse 成功（JSON 允尾随空白），此时 body 里没有 .raw，
        // 只认 body.raw 的消费点会静默拿到空串。取正文一律用 text，不靠 parse 的成败。
        return { status: res.status, body: body, text: text };
      });
    });
  }

  function errText(r) {
    var e = r.body && r.body.error;
    if (e && e.code) return r.status + " " + e.code + "：" + (e.message || "");
    return r.status + "（响应不是标准错误结构）";
  }

  function showLogin(note, kind) {
    state.sid = null;
    state.loopback = false;
    sessionStorage.removeItem(SKEY);
    $("login-card").classList.remove("hide");
    $("viewer").classList.add("hide");
    $("logout").classList.add("hide");
    $("session-info").textContent = "未登录";
    if (note) showMsg(note, kind || "err");
  }

  function showViewer() {
    $("login-card").classList.add("hide");
    $("viewer").classList.remove("hide");
    $("logout").classList.remove("hide");
    loadProjects();
  }

  function tick() {
    if (state.loopback) { $("session-info").textContent = "本机直连（回环免 token）"; return; }
    if (!state.sid) return;
    var left = Math.round((state.expiresAt - Date.now()) / 1000);
    if (left <= 0) { showLogin("会话已到期（会话有效期到点），请用口令重新进入"); return; }
    var m = Math.floor(left / 60), s = left % 60;
    $("session-info").textContent = "会话剩余 " + m + " 分 " + (s < 10 ? "0" + s : s) + " 秒";
  }

  function login() {
    var token = $("token").value.trim();
    if (!token) { showMsg("先填口令"); return; }
    $("login").disabled = true;
    api("/api/remote/login", { method: "POST", credential: token, body: {} })
      .then(function (r) {
        $("login").disabled = false;
        if (r.status !== 200) { showMsg("换会话失败 → " + errText(r)); return; }
        var s = r.body.session || {};
        state.sid = s.session_id;
        state.expiresAt = Date.parse(s.expires_at);
        state.chatExposed = r.body.chat_exposed === true;
        state.loopback = false;
        sessionStorage.setItem(SKEY, state.sid);
        $("token").value = "";
        clearMsg();
        showViewer();
        tick();
      })
      .catch(function (e) { $("login").disabled = false; showMsg("请求失败：" + e.message); });
  }

  function logout() {
    api("/api/remote/logout", { method: "POST", body: {} }).then(function (r) {
      if (r.status === 200) showLogin("已登出：该会话在服务端立即失效（再用同一凭据会得到 401 SESSION_INVALID）", "ok");
      else showLogin("登出请求被拒 → " + errText(r), "err");
    });
  }

  function loadProjects() {
    api("/api/projects").then(function (r) {
      if (r.status === 401 || r.status === 403) { showLogin("凭据失效/被拒 → " + errText(r)); return; }
      if (r.status !== 200 || !Array.isArray(r.body)) { showMsg("项目列表读失败 → " + errText(r)); return; }
      var items = r.body;
      var ul = $("projects");
      if (items.length === 0) { ul.innerHTML = "<li class=\\"muted\\">（注册表里还没有项目）</li>"; return; }
      ul.innerHTML = items.map(function (p) {
        return "<li data-id=\\"" + esc(p.id) + "\\" class=\\"" + (p.id === state.projectId ? "on" : "") + "\\">" +
          esc(p.name) + "<span class=\\"kind\\">" + esc(p.kind || "") + "</span></li>";
      }).join("");
      Array.prototype.forEach.call(ul.querySelectorAll("li[data-id]"), function (li) {
        li.onclick = function () { selectProject(li.getAttribute("data-id")); };
      });
      if (!state.projectId && items.length > 0) selectProject(items[0].id);
    });
  }

  function selectProject(id) {
    state.projectId = id;
    Array.prototype.forEach.call($("projects").querySelectorAll("li[data-id]"), function (li) {
      li.className = li.getAttribute("data-id") === id ? "on" : "";
    });
    renderTabs();
    loadTab();
  }

  var TABS = [
    { key: "design", label: "设计书" },
    { key: "discuss", label: "待议" },
    { key: "arch", label: "架构图数据" },
    { key: "gate", label: "Gate 时间线" },
    { key: "chat", label: "聊天", onlyChat: true }
  ];

  function renderTabs() {
    var shown = TABS.filter(function (t) { return !t.onlyChat || state.chatExposed; });
    if (!shown.some(function (t) { return t.key === state.tab; })) state.tab = "design";
    $("tabs").innerHTML = shown.map(function (t) {
      return "<button class=\\"tab " + (t.key === state.tab ? "on" : "") + "\\" data-tab=\\"" + t.key + "\\">" +
        esc(t.label) + "</button>";
    }).join(" ");
    Array.prototype.forEach.call($("tabs").querySelectorAll("button[data-tab]"), function (btn) {
      btn.onclick = function () { state.tab = btn.getAttribute("data-tab"); renderTabs(); loadTab(); };
    });
  }

  function pid() { return encodeURIComponent(state.projectId || ""); }

  function loadTab() {
    if (!state.projectId) return;
    var panel = $("panel");
    panel.innerHTML = "<p class=\\"muted\\">读取中…</p>";
    if (state.tab === "design") {
      api("/api/projects/" + pid() + "/design").then(function (r) {
        if (r.status !== 200) return fail(panel, r);
        var d = r.body.design || {};
        panel.innerHTML = d.exists
          ? "<pre>" + esc(d.content) + "</pre>"
          : "<p class=\\"muted\\">（该项目还没有设计书）</p>";
      });
    } else if (state.tab === "discuss") {
      api("/api/projects/" + pid() + "/discuss").then(function (r) {
        if (r.status !== 200) return fail(panel, r);
        var d = r.body.discuss || {};
        panel.innerHTML = d.exists
          ? "<p class=\\"muted\\">共 " + esc(d.count) + " 条待议（只追加，提疑权）</p><pre>" + esc(d.content) + "</pre>"
          : "<p class=\\"muted\\">（该项目还没有待议记录）</p>";
      });
    } else if (state.tab === "arch") {
      api("/api/projects/" + pid() + "/arch/render").then(function (r) {
        if (r.status !== 200) return fail(panel, r);
        var g = (r.body.render || {}).graph;
        if (!g) { panel.innerHTML = "<p class=\\"muted\\">（该项目还没解析过架构：主机上跑一次 arch/parse）</p>"; return; }
        var nodes = g.nodes.map(function (n) {
          var c = STATUS_COLORS[n.status] || "#484f58";
          return "<div class=\\"node\\"><span class=\\"dot\\" style=\\"background:" + c + "\\"></span>" +
            esc(n.name) + "<span class=\\"muted\\"> · " + esc(n.path) + " · " + esc(n.file_count) + " 文件</span></div>";
        }).join("");
        var rows = g.edges.map(function (e) {
          return "<tr><td>" + esc(e.from) + "</td><td>→</td><td>" + esc(e.to) + "</td><td>" + esc(e.weight) + "</td></tr>";
        }).join("");
        panel.innerHTML = "<p class=\\"muted\\">节点 " + g.nodes.length + " 个 · 全量依赖边 " + g.edges.length +
          " 条 · 生成于 " + esc(g.generated_at) + "</p><div class=\\"nodes\\">" + nodes + "</div>" +
          "<h3 style=\\"font-size:13px\\">依赖边（消费者 → 提供者，权重=import 条数）</h3>" +
          "<table><thead><tr><th>from</th><th></th><th>to</th><th>权重</th></tr></thead><tbody>" + rows + "</tbody></table>";
      });
    } else if (state.tab === "gate") {
      Promise.all([
        api("/api/projects/" + pid() + "/progress"),
        api("/api/projects/" + pid() + "/gate.jsonl")
      ]).then(function (rs) {
        if (rs[0].status !== 200) return fail(panel, rs[0]);
        var p = rs[0].body.progress || {};
        var cur = (p.gate || {}).current_step;
        var mods = (p.modules || []).map(function (m) {
          var c = STATUS_COLORS[m.status] || "#484f58";
          return "<li><span class=\\"dot\\" style=\\"background:" + c + "\\"></span>" + esc(m.name) +
            " <span class=\\"muted\\">" + esc(m.id) + " · " + esc(m.status) + "</span></li>";
        }).join("");
        var lines = [];
        if (rs[1].status === 200) {
          lines = String(rs[1].text || "").split("\\n").filter(function (x) { return x.trim() !== ""; });
        } else {
          lines = [];
        }
        var tl = lines.map(function (x) {
          var l = {};
          try { l = JSON.parse(x); } catch (e) { return "<li class=\\"muted\\">" + esc(x) + "</li>"; }
          return "<li><span class=\\"muted\\">" + esc(l.ts) + "</span> · " + esc(l.step) +
            " · <span class=\\"" + esc(l.result) + "\\">" + esc(l.result) + "</span> · by " + esc(l.by) +
            (l.note ? " · " + esc(l.note) : "") + "</li>";
        }).join("");
        panel.innerHTML = "<p>当前步：<b>" + esc(cur || "(未开始)") + "</b></p>" +
          "<h3 style=\\"font-size:13px\\">模块四色</h3><ul class=\\"timeline\\">" +
          (mods || "<li class=\\"muted\\">（无模块）</li>") + "</ul>" +
          "<h3 style=\\"font-size:13px\\">Gate 流水（gate.jsonl）</h3><ul class=\\"timeline\\">" +
          (tl || "<li class=\\"muted\\">（还没有 Gate 记录）</li>") + "</ul>";
      });
    } else if (state.tab === "chat") {
      api("/api/projects/" + pid() + "/chat/sessions").then(function (r) {
        if (r.status !== 200) return fail(panel, r);
        var list = r.body.sessions || [];
        if (list.length === 0) { panel.innerHTML = "<p class=\\"muted\\">（没有聊天会话）</p>"; return; }
        panel.innerHTML = "<table><thead><tr><th>会话</th><th>条数</th><th>首条摘要</th><th>最后写入</th></tr></thead><tbody>" +
          list.map(function (s) {
            return "<tr><td>" + esc(s.session_id) + "</td><td>" + esc(s.message_count) + "</td><td>" +
              esc(s.first_message || "") + "</td><td>" + esc(s.updated_at) + "</td></tr>";
          }).join("") + "</tbody></table>";
      });
    }
  }

  function fail(panel, r) {
    panel.innerHTML = "<p class=\\"msg err\\">读失败 → " + esc(errText(r)) + "</p>";
  }

  function boot() {
    var sid = sessionStorage.getItem(SKEY);
    if (!sid) { showLogin(null); return; }
    state.sid = sid;
    api("/api/remote/session").then(function (r) {
      if (r.status !== 200) { showLogin("会话不可用 → " + errText(r)); return; }
      state.expiresAt = Date.parse((r.body.session || {}).expires_at || 0);
      state.chatExposed = r.body.chat_exposed === true;
      state.loopback = r.body.via === "loopback";
      showViewer();
      tick();
    }).catch(function (e) { showLogin("请求失败：" + e.message); });
  }

  $("login").onclick = login;
  $("logout").onclick = logout;
  $("token").onkeydown = function (ev) { if (ev.key === "Enter") login(); };
  setInterval(tick, 1000);
  boot();
})();
</script>
</body>
</html>
`;
}
