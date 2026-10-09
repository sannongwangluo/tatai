// ═══════════════════════════════════════════════════════════════════════════════════
// 三期 S2：路由-方法映射清单（PLAN.md S2 卡 DoD②「写接口逐个拒绝」的遍历依据）。
//
// 为什么要有这份清单：DoD② 的原文是"**所有写接口**在只读模式下返回拒绝——逐个写接口验证并贴返回"，
// 跑偏点是"只读了界面、没只读接口"。要证明"所有"，就必须先有一份**可数的全集**，再逐条打一遍——
// 于是本文件把 `src/server/index.ts` 里每一个路由分支登记成一条记录：
//   · `kind: "write"` → 只读模式下**必须**被 403 REMOTE_READ_ONLY 拦下（verify-s2 按表逐条打）；
//   · `kind: "read"`  → 只读模式下放行（要 token），verify-s2 至少覆盖 S2 要求的那四样；
//   · `kind: "session"` → 会话生命周期（口令换会话 / 登出 / 会话自述）：唯一的写方法例外，
//     见 `auth.ts#READ_ONLY_EXEMPT_PATHS`（放行范围只有"方法"一关，凭据一关没松，且不碰项目数据）；
//   · `kind: "public"`  → 免凭据的登录页 HTML 本体（零数据），见 `auth.ts#PUBLIC_PATHS`。
//
// 防漂移（"新增路由漏加清单时要能发现"）：每条记录带 `anchors` = index.ts 里那条分支的条件原文
// （去掉缩进逐字比对，`mentions` = 该条目占的 `req.method === "…"` 提及数）。verify-s2 做三件事：
//   ① 每条 anchor 在 index.ts（剥注释后）里恰好出现 1 次；
//   ② 清单的提及总数与按方法分项数 == 源码里扫出来的数字（差一条就红）；
//   ③ 会话/静态入口两类与 auth.ts 的 `READ_ONLY_EXEMPT_PATHS` / `PUBLIC_PATHS` 逐条对上。
// 运行时不消费本表（红线判定在 auth.ts，路由在 index.ts）——它是 DoD② 的取证清单与防漂移锚点。
// ═══════════════════════════════════════════════════════════════════════════════════

export type RemoteRouteMethod = "GET" | "POST" | "PUT" | "DELETE";
export type RemoteRouteKind = "read" | "write" | "session" | "public";

export interface RemoteRoute {
  /** 稳定标识（拒绝表里贴出来） */
  id: string;
  method: RemoteRouteMethod;
  /** 可打的具体地址模板（`:id` / `:sid` / `:taskId` / `:moduleId` 由验证脚本替换成真实夹具值） */
  path: string;
  /** 同一分支覆盖的额外地址（如登录页同时挂 `/` 与 `/remote`） */
  altPaths?: string[];
  kind: RemoteRouteKind;
  /** 一句话作用（流水里的表直接贴它） */
  note: string;
  /** index.ts 里的条件原文（去缩进；防漂移锚点） */
  anchors: string[];
  /** 该条目占的 `req.method === "…"` 提及数（默认 1；共用一个分支的多方法路由如实写 2） */
  mentions?: number;
  /** 验证脚本打这个写接口时带的 body/query（只读模式下写请求在路由前就被拒，body 只作可读性说明） */
  body?: unknown;
  query?: string;
}

/**
 * 明确排除的 `req.method === "…"` 提及（不算业务路由，故不进清单；差值对账用）。
 * CORS 预检：桌面壳（Tauri）跨源 POST 前的 OPTIONS，只有 CORS 头，零业务处理。
 */
export const ROUTE_MENTION_EXCLUSIONS: readonly { anchor: string; reason: string }[] = [
  {
    anchor: 'applyShellCors(req, res) && req.method === "OPTIONS"',
    reason: "CORS 预检（桌面壳跨源），不是业务路由",
  },
];

export const REMOTE_ROUTES: readonly RemoteRoute[] = [
  // ── S2 新增：远程只读入口本身（登录页 / 口令换会话 / 登出 / 会话自述）──
  {
    id: "remote-page",
    method: "GET",
    path: "/",
    altPaths: ["/remote"],
    kind: "public",
    note: "远程只读页面本体（登录表单 + 四样只读视图，自包含 HTML，零数据）",
    anchors: ['if (req.method === "GET" && (reqPath === "/" || reqPath === "/remote")) {'],
  },
  {
    id: "remote-login",
    method: "POST",
    path: "/api/remote/login",
    kind: "session",
    note: "口令换会话（要带 Authorization: Bearer <口令>；只动内存会话表）",
    anchors: ['if (req.method === "POST" && reqPath === "/api/remote/login") {'],
    body: { note: "口令只走 Authorization 头，body 不接口令" },
  },
  {
    id: "remote-logout",
    method: "POST",
    path: "/api/remote/logout",
    kind: "session",
    note: "登出（会话立刻失效；用口令调用时返回 logged_out:false）",
    anchors: ['if (req.method === "POST" && reqPath === "/api/remote/logout") {'],
  },
  {
    id: "remote-session",
    method: "GET",
    path: "/api/remote/session",
    kind: "session",
    note: "会话自述（当前是不是远程、凭据类型、到期时间、聊天是否下发）",
    anchors: ['if (req.method === "GET" && reqPath === "/api/remote/session") {'],
  },

  // ── V06-01：唯一写入服务面（自带描述符令牌校验；非回环来源仍先过远程红线）──
  {
    id: "work-health",
    method: "GET",
    path: "/api/work/health",
    kind: "read",
    note: "写入服务探活（回环 + 描述符令牌；数据目录里的服务描述符是它的发现入口）",
    anchors: ['if (req.method === "GET" && reqPath === "/api/work/health") {'],
  },
  {
    id: "work-snapshot",
    method: "GET",
    path: "/api/work/snapshot",
    kind: "read",
    note: "读 v2 快照（query project_id；服务不可达时由客户端降级为最后快照并标陈旧）",
    anchors: ['if (req.method === "GET" && reqPath === "/api/work/snapshot") {'],
    query: "?project_id=tatai",
  },
  {
    id: "work-command",
    method: "POST",
    path: "/api/work/command",
    kind: "write",
    note: "v2 事实的唯一写入路径（命令体带幂等键与 expected_revision；只读模式下由红线先拒）",
    anchors: ['if (req.method === "POST" && reqPath === "/api/work/command") {'],
    body: { schema_version: 2, note: "只读模式下在路由前就被 403，body 仅作可读性说明" },
  },
  {
    id: "work-repair",
    method: "POST",
    path: "/api/work/repair",
    kind: "write",
    note: "投影修复：以事件为唯一事实源重建快照（事件不删、不回滚）",
    anchors: ['if (req.method === "POST" && reqPath === "/api/work/repair") {'],
    body: { project_id: "tatai" },
  },
  // ── V09-25 终修：V09-23 新增的两条 work 面路由必须在桌面宿主（index.ts）转发，同样登记在本清单 ──
  // 登记理由（不是可选的美化）：verify-s2 段②的防漂移对账按 `req.method === "…"` 的提及数与本清单
  // 逐条对账——桌面宿主补路由必然新增字面提及，漏登记就会红。此前用「方法 + 精确路径」常量绕开扫描器
  // 的做法已被判为不可接受的捷径：新路由必须出现在维护中的路由面清单里。
  {
    id: "work-sync-scan",
    method: "POST",
    path: "/api/work/sync/scan",
    kind: "write",
    note:
      "显式同步扫描（MCP scan_sync_evidence 的唯一落点；与后台自动发现共用同一逻辑与单飞队列，" +
      "真正唯一写口仍是本服务的 submit；只读模式下由红线先拒）",
    anchors: ['if (req.method === "POST" && reqPath === "/api/work/sync/scan") {'],
    body: { project_id: "tatai", role: "coordinator" },
  },
  {
    id: "work-sync-status",
    method: "GET",
    path: "/api/work/sync/status",
    kind: "read",
    note:
      "宿主跨进程**只读**同步状态读口（同一份 report + 后台发现健康；不触发扫描、不写账；" +
      "仍要描述符令牌：无/错令牌 401 SERVICE_UNAVAILABLE）",
    anchors: ['if (req.method === "GET" && reqPath === "/api/work/sync/status") {'],
    query: "?project_id=:id",
  },
  {
    id: "work-entry",
    method: "GET",
    path: "/api/work/entry",
    kind: "read",
    note:
      "唯一宿主**只读**接续入口（V09-31/37）：一次返回入口 + 六图摘要，同一份现读快照贯通入口/图/同步；" +
      "CPU 重派生在有界 worker 线程（不占主线程）；仍要描述符令牌：无/错令牌 401 SERVICE_UNAVAILABLE",
    anchors: ['if (req.method === "GET" && reqPath === "/api/work/entry") {'],
    query: "?project_id=:id&role=executor",
  },
  // ── P2/V09-47（DESIGN §6.11）：结果提交前的**只读预检**路由（`kind: "write"` 沿用远程既有授权规则）──
  // 语义**只读**（不写事件/证据/租约、不自愈、不产生认领、不是门禁/通行票），但用 POST 承载表单式大对象：
  // `claim_token` 是**业务**秘密（走 body，避免日志/代理留痕），与**传输**凭据（描述符令牌
  // `x-tatai-work-token` 头）是两回事——不要把 body 里的 `claim_token` 和头里的服务令牌混同。
  // 登记为 `kind:"write"`：只读远程模式由远程红线先拒（**不为此改远程授权模式**），本机回环 MCP 才用得到。
  {
    id: "work-preflight",
    method: "POST",
    path: "/api/work/preflight",
    kind: "write",
    note:
      "唯一宿主**只读**结果预检（P2/V09-47，DESIGN §6.11）：提交前列清可预判缺项 + 锁内未查项单列 not_checked；" +
      "不写事件/证据/租约、不自愈、不产生认领；`claim_token` 业务秘密走 body（不进 URL），与传输令牌 `x-tatai-work-token` 头不是一回事；" +
      "只读远程模式下由远程红线先拒（沿用既有远程授权规则，不新增授权模式）",
    anchors: ['if (req.method === "POST" && reqPath === "/api/work/preflight") {'],
    body: { project_id: "tatai", task_id: "t1", role: "executor", change_id: "chg-1", claim_token: "业务秘密走 body", expected_revision: 1, evidence_refs: [] },
  },
  // ── V09-29 集成：V09-27 上报域（证据正文存/读）与 V09-28 正向基线（preserve/activate）──
  // 桌面宿主 `index.ts` 对 work 面**逐条列名**转发，未登记的精确路径会落本文件兜底 404；
  // 这四条与上面六条同款（方法 + 精确路径），用于让 MCP 在桌面宿主下也能拿到证据正文写/读口与基线路由
  // （此前 MCP 只能经 404 后回退；证据正文两条**没有**回退路由，加转发后桌面宿主才真正可用）。
  // 写两条在只读模式下由远程红线先拒（`kind: "write"`），读一条放行；四条都另有描述符令牌那一关。
  {
    id: "work-reporting-evidence-write",
    method: "POST",
    path: "/api/work/reporting/evidence",
    kind: "write",
    note:
      "证据正文落盘（内容寻址、不可变、读时复核哈希）：由唯一写服务宿主保存，**stdio 进程不本地写项目目录**；" +
      "读时同一份哈希复核，缺失/不符如实报错，不返回空证据",
    anchors: ['if (req.method === "POST" && reqPath === "/api/work/reporting/evidence") {'],
    body: { project_id: "tatai", note: "只读模式下在路由前就被 403，body 仅作可读性说明" },
  },
  {
    id: "work-reporting-evidence-read",
    method: "GET",
    path: "/api/work/reporting/evidence",
    kind: "read",
    note:
      "证据正文读回（query: project_id + sha256；宿主只读不自动启动服务；严格 64 位十六进制、拒路径穿越、" +
      "读时同一份哈希复核）；无/错令牌 401 SERVICE_UNAVAILABLE",
    anchors: ['if (req.method === "GET" && reqPath === "/api/work/reporting/evidence") {'],
    query: "?project_id=:id&sha256=<64 位十六进制>",
  },
  {
    id: "work-baseline-preserve",
    method: "POST",
    path: "/api/work/baseline/preserve",
    kind: "write",
    note:
      "把当前一份图纸存成不可变历史（Git 可取回的直接引用/blob，否则落副本并校验哈希）；" +
      "经唯一宿主 `work/baselineHost.ts`，与直挂 `/documents/preserve` 同一份 documents 判据",
    anchors: ['if (req.method === "POST" && reqPath === "/api/work/baseline/preserve") {'],
    body: { project_id: "tatai", kind: "design" },
  },
  {
    id: "work-baseline-activate",
    method: "POST",
    path: "/api/work/baseline/activate",
    kind: "write",
    note:
      "审定配套版本 → 双版本激活（只追加 baselines.jsonl；不写 gate.jsonl、不伪造用户 Gate）；" +
      "MCP 面固定 delegated_technical_review，服务端强校验两份源 current expected 内容哈希",
    anchors: ['if (req.method === "POST" && reqPath === "/api/work/baseline/activate") {'],
    body: {
      project_id: "tatai",
      approved_by: "remote",
      approval_basis: "只读模式探针",
      approval_kind: "delegated_technical_review",
    },
  },
  // ── V09-39（契约 U5/U5.1）：持久项目说明索引的唯一宿主写面（写两条；读 read/impact/coverage 本地纯读不走此处）──
  {
    id: "work-project-index-upsert",
    method: "POST",
    path: "/api/work/project-index/upsert",
    kind: "write",
    note:
      "项目说明索引（docs/project-notes.json）的显式增量 upsert：经唯一宿主 `work/projectIndexHost.ts`，" +
      "用完整文档版本做 CAS、锁内核对所有权与来源后原子写；只维护指定条目，不重写其它条目语义；" +
      "只读模式下由远程红线先拒（kind:write），另要描述符令牌",
    anchors: ['if (req.method === "POST" && reqPath === "/api/work/project-index/upsert") {'],
    body: { project_id: "tatai", entries: [{ id: "example", duty: "说明", sources: [] }] },
  },
  {
    id: "work-project-index-remove",
    method: "POST",
    path: "/api/work/project-index/remove",
    kind: "write",
    note:
      "项目说明索引的显式删除（删说明条目，**不**删源文件或业务证据）：同一份唯一宿主面与写者判据，" +
      "只读模式下由远程红线先拒，另要描述符令牌",
    anchors: ['if (req.method === "POST" && reqPath === "/api/work/project-index/remove") {'],
    body: { project_id: "tatai", ids: ["example"] },
  },

  // ── 补修 A（V06-14）：注册表恢复入口（显式触发；只读模式下必须被拒）──
  {
    id: "registry-recover",
    method: "POST",
    path: "/api/registry/recover",
    kind: "write",
    note: "注册表恢复/重建（显式触发；空 body = 现场留档后重建空表，带 from = 从数据目录内的留档/备份恢复）",
    anchors: ['if (req.method === "POST" && req.url === "/api/registry/recover") {'],
    body: { note: "只读模式下在路由前就被 403，body 仅作可读性说明（不给 from 就是重建空表）" },
  },

  // ── V09-06：私有事实备份/恢复的产品入口（读两份 + 写两份；写口在只读模式下必须被拒）──
  // 语义全部复用 V06-14 的 `src/server/work/backup.ts`；落点策略/幂等/失败分类在 `work/backupEntry.ts`。
  // 两条读口对远程只读客户端可用（响应过 `withoutLocalPaths`，本机绝对路径一律裁掉：
  // 备份落点、隔离恢复目录、数据目录都在其中）；两条写口另有**回环专属**的落点约束——
  // 远程来源给的 `dest_root` 一律拒（`BACKUP_DEST_FORBIDDEN`），理由见那张卡的 §8.5 / §10.2 口径。
  {
    id: "backups-list",
    method: "GET",
    path: "/api/projects/:id/backups",
    kind: "read",
    note:
      "私有事实备份清单（每份：格式/事件 schema 版本、截止提交序号、逐份内容哈希与角色、证据清单；" +
      "清单读不出来的逐条如实报 ok:false + 原因，不当作「没有这份备份」）",
    anchors: ['if (req.method === "GET" && backupsMatch && !backupsMatch[2]) {'],
  },
  {
    id: "backups-create",
    method: "POST",
    path: "/api/projects/:id/backups",
    kind: "write",
    note:
      "在事件提交边界上创建一份一致备份（清单含版本/截止序号/内容哈希/证据；同一提交边界重复备份幂等，" +
      "返回同一份并标 reused）；落点默认塔台数据目录，可由用户指定（**只接受回环来源**）",
    anchors: ['if (req.method === "POST" && backupsMatch && !backupsMatch[2]) {'],
    body: { note: "只读模式下在路由前就被 403；`dest_root` 省略即用默认落点" },
  },
  {
    id: "backup-inspect",
    method: "GET",
    path: "/api/projects/:id/backups/:backupId",
    kind: "read",
    note:
      "单份备份：清单 + 八条一致性核验（清单可解析/哈希相符/事实全在清单里/事件可重放且截止序号一致/" +
      "证据闭合/图纸历史闭合/缓存可重建/捕获时无警告）+ **恢复预览**（默认隔离目录、与当前项目的落后对照）",
    anchors: ['if (req.method === "GET" && backupsMatch && backupsMatch[2] && !backupsMatch[3]) {'],
  },
  {
    id: "backup-restore",
    method: "POST",
    path: "/api/projects/:id/backups/:backupId/restore",
    kind: "write",
    note:
      "把一份备份恢复到**隔离目录**并逐项核验（原文可定位 / 证据哈希相符 / 事件可重放 / 缓存可重建）；" +
      "**绝不自动替换当前数据**（应答恒为 replaced:false，替换由用户本人另行决定，本入口没有替换动作）",
    anchors: ['if (req.method === "POST" && backupsMatch && backupsMatch[2] && backupsMatch[3] === "restore") {'],
    body: { note: "只读模式下在路由前就被 403；`dest_root` 省略即用默认隔离目录" },
  },

  // ── 读接口（只读模式下放行，要 token）──
  {
    id: "projects-list",
    method: "GET",
    path: "/api/projects",
    kind: "read",
    note: "项目列表（远程响应裁掉本机绝对路径 path）",
    anchors: ['if (req.method === "GET" && req.url === "/api/projects") {'],
  },
  {
    id: "summary-projects",
    method: "GET",
    path: "/api/summary/projects",
    kind: "read",
    note: "跨项目汇总",
    anchors: ['if (req.method === "GET" && req.url === "/api/summary/projects") {'],
  },
  {
    id: "project-activity",
    method: "GET",
    path: "/api/projects/:id/activity",
    kind: "read",
    note: "反查兜底：改文件 vs 报状态两个时间对照",
    anchors: ['if (req.method === "GET" && sub && sub[2] === "activity" && !sub[3]) {'],
  },
  {
    id: "project-live",
    method: "GET",
    path: "/api/projects/:id/live",
    kind: "read",
    note: "实况聚合快照",
    anchors: ['if (req.method === "GET" && sub && sub[2] === "live" && !sub[3]) {'],
  },
  {
    id: "design-read",
    method: "GET",
    path: "/api/projects/:id/design",
    kind: "read",
    note:
      "设计书（S2 四样之一；远程响应裁掉落盘绝对路径 source）。B6/V09-56 增 `document` query：" +
      "缺省 current（旧 shape 不变）、active 读已批准基线快照、<64hex> 读不可变历史快照；" +
      "返回追加 source_rel/selection/sections/baseline_history 只读元数据（不新增写口/不建 cache）",
    anchors: ['if (req.method === "GET" && designReadMatch) {'],
    query: "?document=current|active|<64 位小写十六进制 sha256>",
  },
  {
    id: "discuss-read",
    method: "GET",
    path: "/api/projects/:id/discuss",
    kind: "read",
    note: "待议记录全文（S2 要求：设计书含待议）",
    anchors: ['if (req.method === "GET" && sub && sub[2] === "discuss" && !sub[3]) {'],
  },
  // ── V06-08：自用工作面的两条读取口 + 两条用户动作口（施工图 / 待议处置 / 人工验收）──
  {
    id: "plan-read",
    method: "GET",
    path: "/api/projects/:id/plan",
    kind: "read",
    note: "施工定义（TaskDefinition）+ 运行状态（TaskState）+ 对齐 + 每卡原文定位片段（缺施工图返回 exists:false 空态）",
    anchors: ['if (req.method === "GET" && planReadMatch) {'],
  },
  {
    id: "discussions-read",
    method: "GET",
    path: "/api/projects/:id/discussions",
    kind: "read",
    note: "待议条目（带 discussion_ref）+ 处置派生态 + 处置记录（采纳≠已实现的关联任务实况）；只读待议正文",
    anchors: ['if (req.method === "GET" && discussionsReadMatch) {'],
  },
  {
    id: "discussions-decide",
    method: "POST",
    path: "/api/projects/:id/discussions/decisions",
    kind: "write",
    note: "追加一条待议处置记录（提出/采纳/驳回/被替代 + 理由 + 关联修订/任务；只追加 decisions.jsonl，不改待议原文）",
    anchors: ['if (req.method === "POST" && discussionsDecideMatch) {'],
    body: {
      action: "proposed",
      discussion_ref: { source: "remote-probe", index: 0, content_sha256: "0".repeat(64) },
      reason: "远程只读探针",
      decided_by: "remote",
    },
  },
  {
    id: "acceptance-read",
    method: "GET",
    path: "/api/projects/:id/acceptance",
    kind: "read",
    note:
      "验收页数据：待验收区（每任务定义/真实状态/有效证据/可读场景/结果入口）+ 用户验收计数" +
      "+ **项目级可体验运行入口**（补修 F/F3：装配自**两条**权威来源——成果登记与 Agent 结果回报的 runtime_entries，" +
      "含来源成果与版本、验证时间、当前状态与版本状态；与用户是否已验收无关）；人工验收只认用户记录",
    anchors: ['if (req.method === "GET" && acceptanceMatch) {'],
  },
  {
    id: "acceptance-record",
    method: "POST",
    path: "/api/projects/:id/acceptance",
    kind: "write",
    note: "用户人工验收（接受/退回/接受已知限制）→ 提交 v2 事件；只接受真实用户身份，Agent 与技术审定不得代签",
    anchors: ['if (req.method === "POST" && acceptanceMatch) {'],
    body: { decision: "reject", note: "远程只读探针" },
  },
  // ── V06-02：两份图纸的版本与审定（唯一当前源 / 章节差异 / 不可变历史 / 双版本激活）──
  {
    id: "documents-read",
    method: "GET",
    path: "/api/projects/:id/documents",
    kind: "read",
    note: "两份图纸的当前源 + 修订（哈希/章节索引）+ 生效基线与施工图结构问题；只回项目根内相对路径",
    anchors: ['if (req.method === "GET" && sub && sub[2] === "documents" && !sub[3]) {'],
  },
  {
    id: "documents-diff",
    method: "GET",
    path: "/api/projects/:id/documents/diff",
    kind: "read",
    note: "两个修订之间的章节差异（query: kind=design|plan&from=<sha256>&to=<sha256>）",
    anchors: ['if (req.method === "GET" && documentsDiffMatch) {'],
    query: "?kind=design&from=<64 位十六进制>&to=<64 位十六进制>",
  },
  {
    id: "documents-preserve",
    method: "POST",
    path: "/api/projects/:id/documents/preserve",
    kind: "write",
    note: "把当前图纸存成不可变历史（Git 可取回的直接引用 blob，否则落副本并校验哈希）",
    anchors: ['if (req.method === "POST" && sub && sub[2] === "documents" && sub[3] === "preserve") {'],
    body: { kind: "design" },
  },
  {
    id: "documents-activate",
    method: "POST",
    path: "/api/projects/:id/documents/activate",
    kind: "write",
    note: "双版本激活（审定配套版本 → 只追加 baselines.jsonl；不写 gate.jsonl、不伪造用户 Gate）",
    anchors: ['if (req.method === "POST" && sub && sub[2] === "documents" && sub[3] === "activate") {'],
    body: {
      approved_by: "remote",
      approval_basis: "只读模式探针",
      approval_kind: "delegated_technical_review",
    },
  },
  // ── V06-09：证据/审计/状态投影（只读；从现场事实现算，不写任何文件）──
  {
    id: "work-status-projection",
    method: "GET",
    path: "/api/projects/:id/status-projection",
    altPaths: ["/api/projects/:id/audit"],
    kind: "read",
    note:
      "状态投影（每对象 execution/quality/acceptance/freshness + 六态 display_status + 计数与缺口" +
      "+ 每条已记录必需项的证据依据 evidence_basis）" +
      "与审计面（缺陷台账 / 审计链 / 证据清单 / 审计包 / 高能力抽查包及原文入口）；" +
      "父级「自身集成检查通过」的要求来自施工图的版本化验收定义（随有效基线生效），" +
      "检查结果来自审计/证据事件；本路由不读任何 query 参数（补修 C）",
    anchors: ['if (req.method === "GET" && workProjectionMatch) {'],
  },
  // ── B2/V09-52（DESIGN.md §6.12）：功能清单**只读**读口（唯一义务派生 → feature_item[]，四维分开）──
  {
    id: "feature-ledger-read",
    method: "GET",
    path: "/api/projects/:id/feature-ledger",
    kind: "read",
    note:
      "功能清单只读读口（B2/V09-52，DESIGN.md §6.12）：同一 revision 事实快照 → 唯一义务派生 → feature_item[]" +
      "（设计覆盖/实现/验证/用户接受四维分开，绿只取 verification；功能范围的必需/集成检查按 PLAN 映射**逐条**判，" +
      "同卡其他检查不拖累）；`document=active` 读**已批准基线快照**、`<revision>` 读不可变历史快照，读不出即 state=not_derived；" +
      "`artifact_ref` 必须是**已登记**产物引用（取不到 ⇒ 422）；" +
      "分页 paging.complete 与来源完整性 coverage.source_complete **分开**；错误 400 INVALID_INPUT／404 PROJECT_NOT_FOUND／" +
      "409 REVISION_CHANGED／422 SOURCE_INVALID／503 SOURCE_UNAVAILABLE，200 可为 state=not_derived（带 reason+补取入口）；" +
      "**纯读**：不写事件/证据/租约、不触发扫描、不自愈、不调模型",
    anchors: ['if (req.method === "GET" && featureLedgerMatch) {'],
    query: "?scope=current&document=active&limit=50",
  },
  // ── V06-12：Git 保存版本提醒（只读探测；不写工作树、不碰 Git 配置、不联网）──
  {
    id: "git-status-read",
    method: "GET",
    path: "/api/projects/:id/git-status",
    kind: "read",
    note:
      "只读 Git 探测：repository/detected_at/head + 暂存/未暂存/未跟踪/冲突路径清单 + 最近已知跟踪状态" +
      "（只读本地引用、不 fetch）+ `.工作台/` 是否已备份（默认 unknown）+ 探测失败如实报错；" +
      "附提醒派生（变更指纹 / 文件范围 / 关联成果与证据 ID / 给执行 Agent 的整理说明）",
    anchors: ['if (req.method === "GET" && gitStatusMatch) {'],
  },
  // ── C017：用量统计（只读；认领额度＝运营节流口径，与组①配额节流行为两组验收互不冒充）──
  {
    id: "work-usage",
    method: "GET",
    path: "/api/projects/:id/work/usage",
    kind: "read",
    note:
      "用量统计：认领额度（usage/max/remaining/near_threshold，复用 countTaskClaims 同一事件流计数口径；" +
      "运营节流、不代表任何实耗）+ 执行耗时（task.claimed→execution.delivered 按 task_id+claim_token 配对，" +
      "received_at 之差；未完结如实标进行中/无来源、不计毫秒）+ Token/金额两块缺可核对来源如实「未计量」" +
      "（不设阈值、不设计价算法，§1.4/§5.7）；纯读现算，不落一个字节，不读任何 query/body 参数",
    anchors: ['if (req.method === "GET" && workUsageMatch) {'],
  },
  {
    id: "design-draft-read",
    method: "GET",
    path: "/api/projects/:id/design/draft",
    kind: "read",
    note: "逆向草稿读取",
    anchors: ['if (req.method === "GET" && sub && sub[2] === "design" && sub[3] === "draft") {'],
  },
  {
    id: "progress-read",
    method: "GET",
    path: "/api/projects/:id/progress",
    kind: "read",
    note: "progress.json（Gate 当前步 + 模块四色；S2 四样之一）",
    anchors: ['if (req.method === "GET" && sub && sub[2] === "progress" && !sub[3]) {'],
  },
  {
    id: "gate-jsonl-read",
    method: "GET",
    path: "/api/projects/:id/gate.jsonl",
    kind: "read",
    note: "Gate 流水全部行（S2 四样之一：Gate 时间线）",
    anchors: ['if (req.method === "GET" && sub && sub[2] === "gate.jsonl") {'],
  },
  {
    id: "tasks-read",
    method: "GET",
    path: "/api/projects/:id/tasks",
    kind: "read",
    note: "任务列表",
    anchors: ['if (req.method === "GET" && sub && sub[2] === "tasks" && !sub[3]) {'],
  },
  {
    id: "chat-sessions-list",
    method: "GET",
    path: "/api/projects/:id/chat/sessions",
    kind: "read",
    note: "聊天会话列表（带首条消息摘要；默认被 REMOTE_CHAT_HIDDEN 拦下）",
    anchors: ['if (req.method === "GET" && chatMatch && !chatMatch[2]) {'],
  },
  {
    id: "chat-session-read",
    method: "GET",
    path: "/api/projects/:id/chat/sessions/:sid",
    kind: "read",
    note: "聊天全文（默认被 REMOTE_CHAT_HIDDEN 拦下）",
    anchors: ['if (req.method === "GET" && chatMatch && chatMatch[2] && !chatMatch[3]) {'],
  },
  {
    // V06-07：动作回执读口。含用户聊天原话（派生自聊天正文），**路由内按聊天闸门同口径补判**
    // （`isChatReadPath` 只认 chat/sessions*，那条正则与其断言一字未动：本路由不在它的匹配面内，
    // 闸门判在路由分支里，同 POST /design/draft 的 Q16 先例）。
    id: "chat-actions-list",
    method: "GET",
    path: "/api/projects/:id/chat/actions",
    kind: "read",
    note: "聊天动作回执（可查「做过什么 / 影响了哪些对象 / 失败原因」；默认被 REMOTE_CHAT_HIDDEN 拦下）",
    anchors: ['if (req.method === "GET" && chatActionsMatch) {'],
    query: "?session_id=:sid",
  },
  {
    id: "scan",
    method: "GET",
    path: "/api/projects/:id/scan",
    kind: "read",
    note: "项目扫描（现扫现返，不落盘）",
    anchors: ['if (req.method === "GET" && scanMatch) {'],
  },
  {
    id: "scan-cancel",
    method: "DELETE",
    path: "/api/projects/:id/scan",
    kind: "write",
    note: "取消该项目进行中的全量扫描（无进行中扫描时回 cancelled:false，不报错）",
    anchors: ['if (req.method === "DELETE" && scanMatch) {'],
  },
  {
    id: "arch-modules-read",
    method: "GET",
    path: "/api/projects/:id/arch/modules",
    kind: "read",
    note: "已落盘模块骨架",
    anchors: ['if (req.method === "GET" && archModulesMatch) {'],
  },
  {
    id: "arch-render",
    method: "GET",
    path: "/api/projects/:id/arch/render",
    kind: "read",
    note: "架构图数据（S2 四样之一：render/graph 合成）",
    anchors: ['if (req.method === "GET" && archRenderMatch) {'],
  },
  // ── V09-22 契约 1：未聚合并集逐项取回（HEAD 即有，此前漏登记；V09-25 终修补登记，不改功能/接口）──
  // 补登记理由：verify-s2 段②按 `req.method === "…"` 提及数逐条对账，这条既有只读路由的提及此前
  // 没有被清单认领（源码 47 vs 清单 46），属**清单与源码不一致**；补最少的清单登记即对平，不新增接口。
  {
    id: "arch-items-read",
    method: "GET",
    path: "/api/projects/:id/arch/items",
    kind: "read",
    note:
      "未聚合并集逐项取回（`kind=nodes|edges` 必填；`q` 子串过滤；`offset` 缺省 0、`limit` 缺省 200 " +
      "并 clamp 到 [1,2000]；数据源＝与 /arch/render 同一 builder 管线的未聚合并集，先过滤后开窗、逐页可取完）",
    anchors: ['if (req.method === "GET" && archItemsMatch) {'],
    query: "?kind=nodes",
  },
  {
    id: "arch-reconcile-read",
    method: "GET",
    path: "/api/projects/:id/arch/reconcile",
    kind: "read",
    note: "最近一次对账结果",
    anchors: ['if (req.method === "GET" && archReconcileMatch) {'],
  },
  {
    id: "arch-dataflow-read",
    method: "GET",
    path: "/api/projects/:id/arch/dataflow",
    kind: "read",
    note: "数据流向图来源分层（V09-11：当前实现 vs 目标语义口径＋实体/关系/端到端链/覆盖对账）",
    anchors: ['if (req.method === "GET" && archDataFlowMatch) {'],
  },
  // ── V06-05：图纸派生的规划关联数据（蓝图缓存 + 派生触发）──
  {
    id: "arch-blueprint-read",
    method: "GET",
    path: "/api/projects/:id/arch/blueprint",
    kind: "read",
    note: "已发布的规划图 + 派生回执 + 旧图与规划层合成视图 + 规划↔实现对账；从未发布返回 exists:false 空态",
    anchors: ['if (req.method === "GET" && archBlueprintMatch) {'],
  },
  {
    id: "arch-blueprint-rebuild",
    method: "POST",
    path: "/api/projects/:id/arch/blueprint",
    kind: "write",
    note: "触发一次派生与发布（semantic:true 才调模型；校验不过/模型失败/过时都保留旧图并留回执）",
    anchors: ['if (req.method === "POST" && archBlueprintMatch) {'],
    body: { trigger: "remote-probe", semantic: false },
  },
  {
    id: "arch-layout-read",
    method: "GET",
    path: "/api/projects/:id/arch/layout",
    kind: "read",
    note: "布局记忆（坐标）",
    anchors: ['if (req.method === "GET" && archLayoutMatch) {'],
  },
  {
    id: "arch-fold-read",
    method: "GET",
    path: "/api/projects/:id/arch/mindmap-fold",
    kind: "read",
    note: "思维导图折叠态",
    anchors: ['if (req.method === "GET" && archFoldMatch) {'],
  },
  {
    id: "memory",
    method: "GET",
    path: "/api/projects/:id/memory",
    kind: "read",
    note: "记忆检索 MCP（现取现返，不落盘）",
    anchors: ['if (req.method === "GET" && memoryMatch) {'],
  },
  {
    id: "changes-all",
    method: "GET",
    path: "/api/changes/all",
    kind: "read",
    note: "全局变更流",
    anchors: [
      'req.method === "GET" && req.url !== undefined && (req.url === "/api/changes/all" || req.url.startsWith("/api/changes/all?"))',
    ],
  },
  {
    id: "watch-list",
    method: "GET",
    path: "/api/watch",
    kind: "read",
    note: "监听中的项目 + 明细",
    anchors: ['if (req.method === "GET" && req.url === "/api/watch") {'],
  },
  {
    id: "changes-read",
    method: "GET",
    path: "/api/projects/:id/changes",
    kind: "read",
    note: "变更流水（分页/过滤）",
    anchors: ['if (req.method === "GET" && changesMatch) {'],
  },
  {
    id: "events",
    method: "GET",
    path: "/api/projects/:id/events",
    kind: "read",
    note: "SSE 实时变更事件",
    anchors: ['if (req.method === "GET" && eventsMatch) {'],
  },
  {
    id: "terminal-sessions",
    method: "GET",
    path: "/api/terminal/sessions",
    kind: "read",
    note: "某项目当前活跃终端会话（S3 红线⑧：默认 403 REMOTE_TERMINAL_HIDDEN，主机置 TATAI_REMOTE_TERMINAL=1 才放开）",
    anchors: ['if (req.method === "GET" && termPath === "/api/terminal/sessions") {'],
  },
  {
    id: "terminal-out",
    method: "GET",
    path: "/api/terminal/:sid/out",
    kind: "read",
    note: "终端输出 SSE（S3 已收口：默认 403 REMOTE_TERMINAL_HIDDEN——远程可读 = 把外壳日志读走）",
    anchors: ['if (req.method === "GET" && termMatch && termMatch[2] === "out") {'],
  },
  {
    id: "terminal-history-read",
    method: "GET",
    path: "/api/projects/:id/terminal/history",
    kind: "read",
    note: "命令历史检索（S3 已收口：默认 403 REMOTE_TERMINAL_HIDDEN——里面是用户敲过的命令原文）",
    anchors: ['if (histMatch && (req.method === "GET" || req.method === "DELETE")) {'],
  },
  {
    id: "agents-list",
    method: "GET",
    path: "/api/agents",
    kind: "read",
    note: "全局 agents.json",
    anchors: ['if (req.method === "GET" && req.url === "/api/agents") {'],
  },
  {
    id: "health",
    method: "GET",
    path: "/health",
    kind: "read",
    note: "探活（远程响应裁掉 data_dir）",
    anchors: ['if (req.method === "GET" && req.url === "/health") {'],
  },

  // ── 写接口（DoD②：只读模式下逐条必须 403 REMOTE_READ_ONLY）──
  {
    id: "discuss-append",
    method: "POST",
    path: "/api/projects/:id/discuss",
    kind: "write",
    note: "追加待议记录",
    anchors: ['if (req.method === "POST" && sub && sub[2] === "discuss" && !sub[3]) {'],
    body: { content: "远程只读探针" },
  },
  {
    id: "design-draft",
    method: "POST",
    path: "/api/projects/:id/design/draft",
    kind: "write",
    note: "起草（逆向落稿 / 会话提炼，会落 design.draft.md）",
    anchors: ['if (req.method === "POST" && sub && sub[2] === "design" && sub[3] === "draft") {'],
    body: { session_id: "s" },
  },
  {
    id: "design-finalize",
    method: "POST",
    path: "/api/projects/:id/design/finalize",
    kind: "write",
    note: "草稿转正（落 design.md + progress + gate.jsonl）",
    anchors: ['if (req.method === "POST" && sub && sub[2] === "design" && sub[3] === "finalize") {'],
    body: { gate_step: "design" },
  },
  {
    id: "design-append",
    method: "POST",
    path: "/api/projects/:id/design/append",
    kind: "write",
    note: "落稿笔（唯一设计书写口）",
    anchors: ['if (req.method === "POST" && sub && sub[2] === "design" && sub[3] === "append") {'],
    body: { content: "## 远程只读探针" },
  },
  {
    id: "gate-transition",
    method: "POST",
    path: "/api/projects/:id/gate",
    kind: "write",
    note: "人手点过关/打回（写 gate.jsonl）",
    anchors: ['if (req.method === "POST" && sub && sub[2] === "gate" && !sub[3]) {'],
    body: { step: "kickoff", result: "pass" },
  },
  {
    id: "gate-back",
    method: "POST",
    path: "/api/projects/:id/gate/back",
    kind: "write",
    note: "迭代回需求步",
    anchors: ['if (req.method === "POST" && sub && sub[2] === "gate" && sub[3] === "back") {'],
    body: { step: "requirement" },
  },
  {
    id: "task-add",
    method: "POST",
    path: "/api/projects/:id/tasks",
    kind: "write",
    note: "新增任务",
    anchors: ['if (req.method === "POST" && sub && sub[2] === "tasks" && !sub[3]) {'],
    body: { id: "probe", title: "远程只读探针", module_id: "probe", reporter: "remote" },
  },
  {
    id: "task-status",
    method: "POST",
    path: "/api/projects/:id/tasks/:taskId/status",
    kind: "write",
    note: "任务状态自报",
    anchors: ['if (req.method === "POST" && sub && sub[2] === "tasks" && sub[3] && sub[4] === "status") {'],
    body: { status: "done" },
  },
  {
    id: "module-add",
    method: "POST",
    path: "/api/projects/:id/modules",
    kind: "write",
    note: "新增模块",
    anchors: ['if (req.method === "POST" && sub && sub[2] === "modules" && !sub[3]) {'],
    body: { id: "probe", name: "远程只读探针" },
  },
  {
    id: "module-status",
    method: "POST",
    path: "/api/projects/:id/modules/:moduleId/status",
    kind: "write",
    note: "模块四色状态",
    anchors: ['if (req.method === "POST" && sub && sub[2] === "modules" && sub[3] && sub[4] === "status") {'],
    body: { status: "issue" },
  },
  {
    id: "chat-session-create",
    method: "POST",
    path: "/api/projects/:id/chat/sessions",
    kind: "write",
    note: "新建聊天会话（建空 jsonl 文件）",
    anchors: ['if (req.method === "POST" && chatMatch && !chatMatch[2]) {'],
  },
  {
    // V06-07：聊天动作的写口（跑动作 / 续接失败动作 / 审定并激活提案）。
    // 只读模式下任一 op 都在路由前被 403 REMOTE_READ_ONLY 拦下；本地路径走同一分支。
    id: "chat-actions",
    method: "POST",
    path: "/api/projects/:id/chat/actions",
    kind: "write",
    note: "聊天动作（run/retry/activate：跑动作、续接失败动作、审定并激活提案）",
    anchors: ['if (req.method === "POST" && chatActionsMatch) {'],
    body: { op: "run", text: "远程只读探针" },
  },
  {
    id: "chat-message",
    method: "POST",
    path: "/api/projects/:id/chat/sessions/:sid/messages",
    kind: "write",
    note: "发问（写 user/assistant 行 + 调 Flash）",
    anchors: ['if (req.method === "POST" && chatMatch && chatMatch[2] && chatMatch[3] === "/messages") {'],
    body: { content: "远程只读探针" },
  },
  {
    id: "chat-session-delete",
    method: "DELETE",
    path: "/api/projects/:id/chat/sessions/:sid",
    kind: "write",
    note: "删除聊天会话（连带删 jsonl，不可恢复；被动作引用的会话转归档留引用）",
    anchors: ['if (req.method === "DELETE" && chatMatch && chatMatch[2] && !chatMatch[3]) {'],
  },
  {
    // 批3终审 T19（DESIGN §11.8）：正式入口后台化——起/挂单飞 run 并等终态；成功才覆盖
    // modules.json，取消/失败不动旧件；分片让出事件循环（不再是请求内同步解析）。
    id: "arch-parse",
    method: "POST",
    path: "/api/projects/:id/arch/parse",
    kind: "write",
    note: "起/挂后台解析 run 并等终态落 modules.json（成功才覆盖旧件）",
    anchors: ['if (req.method === "POST" && archParseMatch) {'],
  },
  {
    id: "arch-parse-status",
    method: "GET",
    path: "/api/projects/:id/arch/parse",
    kind: "read",
    note: "解析 run 状态定位（进行中优先，否则最近一次；run:null = 没跑过）",
    anchors: ['if (req.method === "GET" && archParseMatch) {'],
  },
  {
    id: "arch-parse-cancel",
    method: "DELETE",
    path: "/api/projects/:id/arch/parse",
    kind: "write",
    note: "取消进行中的解析 run（部分结果不落盘；无进行中 run 回 cancelled:false，不报错）",
    anchors: ['if (req.method === "DELETE" && archParseMatch) {'],
  },
  {
    id: "arch-name",
    method: "POST",
    path: "/api/projects/:id/arch/name",
    kind: "write",
    note: "Flash 起名并落 names.json",
    anchors: ['if (req.method === "POST" && archNameMatch) {'],
    body: { force: false },
  },
  {
    id: "arch-reconcile-run",
    method: "POST",
    path: "/api/projects/:id/arch/reconcile",
    kind: "write",
    note: "立即跑一次对账并落 reconcile-last.json",
    anchors: ['if (req.method === "POST" && archReconcileMatch) {'],
  },
  {
    id: "arch-expand",
    method: "POST",
    path: "/api/projects/:id/arch/expand",
    kind: "write",
    note: "逐级下钻展开（只读解析，但接口按写口径管）",
    anchors: ['if (req.method === "POST" && archExpandMatch) {'],
    body: { module_path: "src" },
  },
  {
    id: "arch-layout-save",
    method: "PUT",
    path: "/api/projects/:id/arch/layout",
    kind: "write",
    note: "布局坐标写回",
    anchors: ['if (req.method === "PUT" && archLayoutMatch) {'],
    body: { mode: "MODULE_BOX", positions: {} },
  },
  {
    id: "arch-fold-save",
    method: "PUT",
    path: "/api/projects/:id/arch/mindmap-fold",
    kind: "write",
    note: "思维导图折叠态写回",
    anchors: ['if (req.method === "PUT" && archFoldMatch) {'],
    body: { expanded: [] },
  },
  {
    id: "watch-open",
    method: "POST",
    path: "/api/projects/:id/watch",
    kind: "write",
    note: "开文件监听",
    anchors: ['if (req.method === "POST" && watchMatch) {'],
  },
  {
    id: "watch-close",
    method: "DELETE",
    path: "/api/projects/:id/watch",
    kind: "write",
    note: "关文件监听",
    anchors: ['if (req.method === "DELETE" && watchMatch) {'],
  },
  {
    id: "terminal-create",
    method: "POST",
    path: "/api/projects/:id/terminal",
    kind: "write",
    note: "开 PTY 会话（远程开终端=给外壳，只读模式一律拒）",
    anchors: ['if (req.method === "POST" && createTermMatch) {'],
    body: { cols: 80, rows: 24 },
  },
  {
    id: "terminal-history-clear",
    method: "DELETE",
    path: "/api/projects/:id/terminal/history",
    kind: "write",
    note: "清空命令历史（与 GET 共用分支，故占 2 处方法提及）",
    anchors: [
      'if (histMatch && (req.method === "GET" || req.method === "DELETE")) {',
      'if (req.method === "DELETE") {',
    ],
    mentions: 2,
  },
  {
    id: "terminal-in",
    method: "POST",
    path: "/api/terminal/:sid/in",
    kind: "write",
    note: "往 PTY 写 stdin（远程执行命令的主入口）",
    anchors: ['if (req.method === "POST" && termMatch && termMatch[2] === "in") {'],
    query: "project_id=:id",
    body: { data: "whoami\r" },
  },
  {
    id: "terminal-resize",
    method: "POST",
    path: "/api/terminal/:sid/resize",
    kind: "write",
    note: "PTY 尺寸变更",
    anchors: ['if (req.method === "POST" && termMatch && termMatch[2] === "resize") {'],
    query: "project_id=:id",
    body: { cols: 100, rows: 30 },
  },
  {
    id: "terminal-close",
    method: "DELETE",
    path: "/api/terminal/:sid",
    kind: "write",
    note: "关闭 PTY 会话",
    anchors: ['if (req.method === "DELETE" && termMatch && !termMatch[2]) {'],
    query: "project_id=:id",
  },
  {
    id: "project-add",
    method: "POST",
    path: "/api/projects",
    kind: "write",
    note: "接入新项目（写全局注册表）",
    anchors: ['if (req.method === "POST" && req.url === "/api/projects") {'],
    body: { path: "/nonexistent/tatai-remote-probe" },
  },
  {
    id: "project-open",
    method: "POST",
    path: "/api/projects/:id/open",
    kind: "write",
    note: "选中项目（写 last_opened_at）",
    anchors: ['if (req.method === "POST" && openMatch) {'],
  },
  {
    id: "project-remove",
    method: "DELETE",
    path: "/api/projects/:id",
    kind: "write",
    note: "从注册表移除项目",
    anchors: ['if (req.method === "DELETE" && removeMatch) {'],
  },
  {
    id: "flash-chat",
    method: "POST",
    path: "/api/flash/chat",
    kind: "write",
    note: "Flash 流式聊天管道（会耗额度）",
    anchors: ['if (req.method === "POST" && req.url === "/api/flash/chat") {'],
    body: { messages: [{ role: "user", content: "远程只读探针" }] },
  },
];

/** 只读模式下必须逐个被拒的写路由（DoD② 的遍历集） */
export const REMOTE_WRITE_ROUTES: readonly RemoteRoute[] = REMOTE_ROUTES.filter((r) => r.kind === "write");

/** 会话生命周期路由（写方法的唯一例外；与 auth.ts#READ_ONLY_EXEMPT_PATHS 对账） */
export const REMOTE_SESSION_ROUTES: readonly RemoteRoute[] = REMOTE_ROUTES.filter((r) => r.kind === "session");

/** 免凭据静态入口（与 auth.ts#PUBLIC_PATHS 对账） */
export const REMOTE_PUBLIC_ROUTES: readonly RemoteRoute[] = REMOTE_ROUTES.filter((r) => r.kind === "public");

/** 某条路由占的方法提及数（默认 1） */
export function routeMentions(route: RemoteRoute): number {
  return route.mentions ?? 1;
}

/** 清单按方法分项的提及数（verify-s2 与 index.ts 源码扫描对账用） */
export function routeMentionCounts(): Record<RemoteRouteMethod, number> {
  const counts: Record<RemoteRouteMethod, number> = { GET: 0, POST: 0, PUT: 0, DELETE: 0 };
  for (const r of REMOTE_ROUTES) counts[r.method] += routeMentions(r);
  return counts;
}

/** 清单提及总数（不含 `ROUTE_MENTION_EXCLUSIONS`） */
export function routeMentionTotal(): number {
  return REMOTE_ROUTES.reduce((n, r) => n + routeMentions(r), 0);
}
