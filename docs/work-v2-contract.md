# 事实写入 v2 契约（V06-01）

> 施工卡：`PLAN.md` V06-01。设计依据：`DESIGN.md` §2.6（权威数据与派生内容）、§5.4（恢复顺序）、§6.5（协作接口与权限边界）。
> 代码事实源：`src/server/work/{types,eventStore,service}.ts`、宿主 `src/server/workHost.ts`。
> 本卡**只**固化"格式 + 版本 + 幂等 + 单写入 + 错误格式"，不迁移真实项目、不实现调度、不动主界面。

## 1. 数据落在哪

```
<项目根>/.工作台/work/
├── events.jsonl              # 唯一事实源：一行一条事件，只追加；投影失败也不回删
├── state.json                # 派生快照（带 last_seq），删掉可全量重建
├── projection-error.json     # 投影失败标记（有它 = state.json 落后于事件，必须按陈旧处理）
├── recovery.jsonl            # 恢复动作留痕（隔离半截尾行等），只追加
└── quarantine/               # 被隔离的半截尾行原文（含 sha256），不删
```

全局（数据目录，默认 `~/.tatai/`）：

```
work-service.json            # 写入服务描述符：host/port/token/pid（0600；不在 = 服务没起）
logs/work-service.jsonl      # 服务启停留痕
```

`state.json` 是**派生数据**：删掉它、或 `projection-error.json` 存在时，用 `rebuildSnapshot()` / `POST /api/work/repair` 从事件重放即可重建。反之 `events.jsonl` 里的任何一条都是事实，不提供修改/删除接口。

## 2. 事件信封（DESIGN.md §2.6 最小信封）

```jsonc
{
  "schema_version": 2,
  "event_id": "1f0c…",              // 服务端生成（uuid）
  "project_id": "tatai",
  "change_id": "chg-2026-09-20-1",  // 本次变更批次（由调用方给）
  "entity_id": "task-001",          // 被改的实体
  "entity_revision": 3,             // 本事件生效后的实体版本（1 起，逐条 +1）
  "seq": 17,                        // 项目内提交序号（1 起，严格 +1，无洞无重号）
  "type": "task.status_changed",    // 小写字母开头的事件名（业务词表由 V06-03/V06-09 登记）
  "actor_id": "kimi-code",
  "role": "executor",
  "occurred_at": "2026-09-20T01:00:00+08:00",  // 业务时间（缺省 = received_at）
  "received_at": "2026-09-20T01:00:02+08:00",  // 写入服务提交时间
  "idempotency_key": "task-001:status:3",
  "payload": { "status": "doing" }
}
```

## 3. 写入命令与回执

命令（`POST /api/work/command`，body 即命令）：

| 字段 | 必填 | 口径 |
| --- | --- | --- |
| `schema_version` | 是 | 必须 `2` |
| `project_id` | 是 | 注册表里的项目 id（不认路径） |
| `change_id` | 是 | 本次变更批次 |
| `entity_id` | 是 | 被改实体 |
| `expected_revision` | 是 | `null` = 期望实体尚不存在；数字 = 期望恰好是该版本（乐观并发） |
| `type` | 是 | 事件名，`^[a-z][a-z0-9_.-]{2,63}$` |
| `actor_id` / `role` | 是 | 谁、以什么角色写的（角色不是安全凭证，§6.5） |
| `idempotency_key` | 是 | 项目内唯一；同键必须同内容 |
| `occurred_at` | 否 | 不给则等于 `received_at` |
| `payload` | 否 | JSON 对象，序列化后 ≤ 64 KiB |

成功回执：

```jsonc
{ "ok": true, "event_id": "1f0c…", "seq": 17, "entity_revision": 3,
  "received_at": "…", "duplicate": false,
  "projection": { "state": "applied" } }   // "failed" = 事件已提交但快照没跟上
```

顺序（DESIGN.md §2.6 落盘顺序）：**校验 → 幂等 → 版本 → 追加并 fsync → 回执 → 投影**。
前四步任一失败，磁盘上**一个字节都不写**；投影失败不回滚已提交的事实，只标记。

## 4. 错误码与恢复办法

| code | HTTP | 什么情况 | 怎么恢复 |
| --- | --- | --- | --- |
| `INVALID_COMMAND` | 400 | 命令不合法（缺字段、`schema_version` 不对、`expected_revision` 越界、payload 过大、项目不存在） | 按 message 改命令重发。非法命令不留痕，不会污染事件文件 |
| `VERSION_CONFLICT` | 409 | `expected_revision` 与当前版本不符（别人先改了） | 读最新快照/事件（detail 给了 `current_seq` 与 `diff_from_seq`），重算后**换新幂等键**重发；塔台不替你合并 |
| `IDEMPOTENCY_CONFLICT` | 409 | 同一个幂等键被用于**内容不同**的命令 | 同一意图重发请原样重发（会返回原回执）；确实是新改动 → 换一个新键 |
| `SERVICE_UNAVAILABLE` | 503 | 写入服务没起 / 不可达 / 令牌不对 | 起塔台桌面服务；离线期间**不要**自己去写 `events.jsonl`（那会造出第二个写者）。读取可继续（退化为最后快照 + `stale`） |
| `PROJECTION_FAILED` | 500 | 内部错误（不是投影标记本身；标记见回执里的 `projection.state`） | 先看 `projection-error.json`；用 `POST /api/work/repair` 或 `rebuildSnapshot()` 从事件重放重建快照 |
| `MIDDLE_CORRUPT` | 500 | `events.jsonl` **中段**有坏行（不是尾行） | **不要**跳过坏行继续跑。核对现场：坏行前后的事件、`.工作台/` 的其它流水、备份；确认丢的是哪一条后，从最后一个完整事件之后重建。塔台不提供"自动跳过" |
| `EVENT_INVALID` | 500 | 事件信封不合法，或结构不变量被破坏（seq 有洞、实体 revision 不连续、幂等键重复出现） | 同上：停下来查现场。seq 有洞意味着丢过完整事件，继续跑只会把错误带到下游 |
| `TAIL_QUARANTINED` | 500 | 尾部半截行（上次写到一半被杀）已隔离 | 无需人工处理：原文留在 `quarantine/`（带 sha256）、`recovery.jsonl` 有记录、事件文件已截回最后一个完整行。若想核对，比对隔离文件内容 |

## 5. 单写入与离线降级（§2.6 硬口径）

- **唯一写入者**是桌面服务进程内的 `WorkService`。stdio MCP 用 `WorkServiceClient` 转接，
  **不自己追加事件**；服务不可用时写入直接报 `SERVICE_UNAVAILABLE`，绝不退化成"自己写文件"。
- **离线读**：客户端读不到服务时返回磁盘上的**最后一份快照**并置 `stale: true` /
  `stale_reason`（`service_unavailable` / `service_not_running` / `projection_failed` /
  `snapshot_missing` / `no_events`）。界面与调用方必须按"未知/陈旧"展示，不得当成最新事实。
- 服务发现靠描述符：`<数据目录>/work-service.json`。删除该文件即等于"服务未在运行"。
- 工作台若被显式绑到非回环地址（远程开启），本面跟随同一地址，但既有远程红线仍先拦：
  非回环写方法在只读模式下 `403 REMOTE_READ_ONLY`；令牌只存在主机文件系统上。

## 6. 故障注入（验证用，产品路径不启用）

| 开关 | 作用 |
| --- | --- |
| `TATAI_WORK_FAULT_SNAPSHOT=1` | 让投影步骤必失败：事件照常落盘并回执，回执里 `projection.state = "failed"` |

验证脚本 `scripts/verify-v06-01.ts` 覆盖：幂等同内容 / 同键异内容 / 双写者版本冲突 /
重放一致 / 已提交但快照失败 / 半截尾隔离 / 中段损坏暴露 / 服务离线写入拒绝且旧快照可读并标陈旧 /
并发提交序号无洞 / 真服务进程端到端（含描述符发现）。

## 7. 本卡**不做**的事

- 不迁移任何真实项目的 v1 数据（`tasks.json` / `progress.json` 原样保留，写口仍是 v1）——迁移工具在 V06-03，
  真实项目切换要等 V06-10 的认领与兼容写入口。
- 不定义业务事件词表（任务/证据/基线分别由 V06-03/V06-09 登记）。
- 不实现调度、租约、外部执行回执（V06-10/V06-11）。
- 不改任何主界面。

## 8. 任务事件词表与迁移（V06-03 登记；代码在 `src/server/work/{plan,tasks,migrate}.ts`）

### 8.1 事件类型（实体 id 约定 `task:<task_id>`）

| type | payload | 状态影响 |
| --- | --- | --- |
| `task.definition_imported` | `definition_sha256` / `plan_revision` / `definition_revision` | **只刷新定义绑定**，不改执行状态（导入定义不是"已获执行许可"） |
| `task.status_changed` | `status` ∈ `preparing/ready/claimed/executing/result_submitted/blocked/cancelled` | 改执行状态 |
| `task.claimed` | `run_id/attempt_id/owner_id/claim_token/lease_expires_at` | → `claimed` |
| `task.result_submitted` | — | → `result_submitted`（**只表示执行者已交结果**，不代表审计通过/验收接受） |
| `task.blocked` | `reason` | → `blocked` |
| `task.cancelled` | `reason` | → `cancelled`（旁路，单独标记；取消后不能被后续事件悄悄改回非取消） |
| `task.rebound` | `from_definition_sha256` / `to_definition_sha256` / `to_plan_revision` / `to_definition_revision` / `disposition`（continue/adjust/pause） | 换定义绑定，**留痕不静默换输入** |

**写边界的认领门禁（2026-09-30 有界修正）**：`task.claimed` 不只在 `claims.claimTask` 里过一遍预查——
唯一写入服务的文件锁（`service.ts#submit` ②′.2）会用**锁内的事件现场**复核这张卡当前是不是 `blocked`，
是则拒绝（`INVALID_COMMAND` + `detail.reason="blocked_not_claimable"`）、被拒命令零字节；直连
`POST /api/work/command` 手写 `task.claimed` 因此不能旁路"只从就绪队列领"。合法的**续约**
（`claim_action:"renew"` 且凭事件现场核实通过）不受此限——续约是持有者对已有认领的延长，不是新领；
取消 / 已交付（`result_submitted`）的原有规则不变。解阻只能由协调器按**原启动条件**处理
（先满足前置，再写 `task.status_changed(status="ready")`），一句话的"授权"不构成解阻凭据。

### 8.2 定义与状态分离

施工定义来自施工图（`.工作台/plan.md` 或塔台根 `PLAN.md`）的第一张「卡号/依赖/完成证据」表 + 对应
`###` 卡片小节；`任务定义区 / 派生状态区（「状态」列、「施工备注」段、勾选位）/ 历史归档区` 的判据在
`plan.ts#classifyPlanRegions`。**定义哈希不含**状态、时间戳、执行备注与勾选位，所以报进度不会让基线作废；
状态变化只写事件，定义变化才让相关任务进"待重绑"（`tasks.ts#alignDefinitionsAndStates`）。

### 8.3 兼容投影与迁移

迁移后 `.工作台/tasks.json` 是 `work/events.jsonl` 的**兼容投影**（带 `projection_of` / `last_seq` /
`status_semantics`，保留 v1 四态以便旧读口读回）。旧 v1 写口（`addTask`/`setTaskStatus`/`setModuleStatus`）
看到投影或 `work/events.jsonl` 即拒写，返回 `WRITE_UPGRADE_REQUIRED` 与缺失字段清单；未迁移项目行为不变。
v1 四态映射按 DESIGN §5.4：`todo→preparing`、`doing→executing`、`done→result_submitted`、`blocked→blocked`，
取消只在原条目带明确标记时迁移。迁移目录：`.工作台/work/migration-backup/<时间戳>/`（整份逐字节备份 +
`manifest.json` 哈希清单）、回滚把 v2 事件/快照移进 `.工作台/work/migration-archived/<时间戳>/`（不删除事实）。
**本卡只服务隔离夹具**：迁移入口要求调用方显式声明 `isolated: true`，真实项目切换等 V06-10。

## 9. 证据与审计事件词表（V06-09 登记；代码在 `src/server/work/{evidence,audit,statusProjection}.ts`）

> 本节为 V06-09 追加：只登记新增词表与新增错误码，上文各节（v1 写口、v2 信封、错误表中既有条目）一个字节未改。
> 登记面的事实源是 `src/server/work/types.ts#REGISTERED_EVENT_TYPES`（与三个模块各自的词表常量对齐，漂移由 `verify-v06-09` 断言）。

### 9.1 证据正文（不可变内容）

正文按 **sha256 内容寻址**落 `<项目根>/.工作台/work/evidence/<sha256>.json`（`putEvidence`），写一次不再改写；
同内容重复提交返回原记录并标 `duplicate: true`。读时会复核"内容哈希 = 内容地址"，对不上抛 `EVIDENCE_INVALID`（不静默放过）。
**事件里只引用** `evidence_id(=sha256)` 与恢复位置（`recovery_path`），正文不进事件文件（§2.6）。

### 9.2 缺陷事件（实体 `finding:<finding_id>`，`finding_id = f-<同类指纹前 16 位>`）

| type | payload | 状态影响 |
| --- | --- | --- |
| `finding.opened` | `dedupe_key/severity/source/expected/actual/repro/evidence_sha256/affected_revision/object_id/duplicate_of` | 有 `repro`+证据 → `confirmed`；否则 `pending_repro`（`unverified`，明确写"风险未排除"）；`duplicate_of` 给定 → `duplicate` |
| `finding.reported_again` | `source/note` | 同指纹再次上报：记 `reports+1`，**不产生第二条缺陷** |
| `finding.transition` | `to/reviewer/duplicate_of/note/retest_evidence` | 依状态机推进（误报要独立复核人；关闭要复测证据；未证实不能关闭） |
| `finding.fix_submitted` | `fix_revision/evidence_sha256` | → `fixed_pending_retest`（**修复自述不关闭缺陷**） |
| `finding.retest_recorded` | `retested_by/retest_evidence/result/rerepro_gone/regression_scope` | `pass` → `closed`；`fail` → 回 `confirmed`（复测者 ≠ 报告者） |
| `finding.accepted_risk` | `accepted_by/basis/scope_revision/review_condition` | → `accepted_risk`（**role 必须是 user**；记录适用版本与复查条件，不是永久免审） |

severity 六值按**用户后果**定义：`blocks_core_goal / data_loss / unauthorized_access`（必须拦截）、
`user_visible_defect / degraded_experience / cosmetic`。判据里不含改动行数与模型品牌（§5.5）。

### 9.3 审计与修复链（五件事分开记录，各占一个实体前缀）

| type | 实体前缀 | payload 要点 |
| --- | --- | --- |
| `audit.submission_submitted` | `submission:` | 结果提交：goal/baseline/diff/commands/untested/known_issues/evidence_refs/binding |
| `audit.self_check_recorded` | `check:` | 自检：`checked_by` + 检查项（`check_id/method/command/exit_code/output_ref/evidence_sha256/scope`，V09-01 起可带 `verifies` 声明被验对象类别）＋`coverage[]`/`method_limits`（可选，记录层方法说明）；独立性固定 `author_self`（自检不是独立审计）。**采信分档**（DESIGN.md 附录 E.3.2）：带 `command` 的检查通过必须 `exit_code===0`（否则写侧 `EVENT_INVALID` 且读侧不采信）；不带 `command` 的检查凭证据哈希 ＋ 方法说明（per-check `method` 或记录层 `coverage`/`method_limits`）采信 |
| `audit.independent_audit_recorded` | `audit:` | 独立审计：`auditor`（≠ 作者）+ 独立性声明 + 五个视角覆盖矩阵 + `not_reported_scope` |
| `audit.fix_recorded` | `fix:` | 修复：`finding_id/fix_revision/fixed_by/regression[]` |
| `audit.retest_recorded` | `retest:` | 复测：`retested_by/retest_evidence/result`（修复自述不关闭缺陷） |
| `audit.human_acceptance_recorded` | `acceptance:` | 人工验收：`decision` + 场景/基线/证据引用；**role 必须是 user**，Agent 与技术审定不得代签 |

审计包（`buildAuditPackage`）按 §5.5 必含项组装九项，缺项进 `completeness.missing_items`（`assertAuditPackageComplete` 拦）；
`raw_entry_points` 给原文入口，`author_summary_is_navigation_only: true` 明示作者摘要只是导航。
高能力抽查包（`buildSpotCheckPackage`）按种子确定性选点，同样带原文入口与"抽查不是全量证明"的边界声明。

### 9.4 只读入口（两条路径共用一个分支，登记为一条路由 + `altPaths`）

- `GET /api/projects/:id/status-projection` —— 每对象 `execution/quality/acceptance/freshness` +
  `display_status`（§4.2 六态）+ required/passed/missing 计数与缺口 + 复核范围 + 历史；
- `GET /api/projects/:id/audit` —— 缺陷台账 / 审计链 / 证据清单 / 审计包 / 抽查包。

两条都从现场事实现算、不写任何文件，响应只含项目根内相对路径。

### 9.5 新增错误码

| code | HTTP | 什么情况 | 怎么恢复 |
| --- | --- | --- | --- |
| `EVIDENCE_INVALID` | 400 | 证据引用不合法：引用不存在的证据、内容哈希与内容地址不符、试图改写不可变证据、提交者没给缺陷读侧 | 先 `putEvidence` 落正文再引用；对不上的证据按"现场被改过"处理，别跳过 |

`progress.json` 的兼容投影只在**已迁移项目**上写（`writeCompatProgressProjection` 要求 `migrated: true`，
未迁移项目一个字节都不动）；四色是 v2 六态的**有损派生**，真状态看 `modules[].v2_display_status`。

## 10. 聊天动作记录（V06-07 登记；代码在 `src/server/work/chatActions.ts`）

本节**只追加**：§1–§9 的原文一个字节都没改（V06-07 是在它们之后续写的一节）。
聊天动作不是 v2 事件（不进 `events.jsonl`）：它是**面向人的可追溯回执**，落
`<项目根>/.工作台/work/chat-actions.jsonl`，一行一条**全量快照**，同一 `action_id` 取 `rev` 最大者即现状。
用途（DESIGN.md §3.6）：重新打开会话或重开进程后，仍能核实"做过什么、影响了哪些对象、失败原因是什么"。

### 10.1 一条动作长什么样

| 字段 | 口径 |
| --- | --- |
| `action_id` | `act-<本地时间戳>-<8 位十六进制>`；同一条动作的所有快照共用它 |
| `project_id` / `session_id` | 触发它的项目与会话（会话被删而有引用时转归档，见 §10.4） |
| `kind` | `discussion`（讨论）/ `proposal`（整理方案）/ `blueprint_update`（更新图）/ `locate_feedback`（定位反馈） |
| `status` | `reading` / `drafting` / `saved` / `review_needed` / `applied` / `failed`（六阶段，文案见 §10.2） |
| `trigger` | 用户原话（自然表达，动作判定的输入） |
| `idempotency_key` | `sha256(项目 + 会话 + kind + 归一化原话 + 选中对象 + **现行版本**)`——写动作的幂等键 |
| `source_versions` | 触发时读到的设计/施工内容与定义哈希 + 生效基线 id（`baseline_error` 区分"没有基线"与"读不到"） |
| `stages` | 阶段轨迹（每步时间、说明、对应回执下标） |
| `tool_receipts` | 工具动作与结果的关联：`{tool, ok, write, summary, affected_ids, detail}`；`write:true` 才算真写了盘 |
| `affected_ids` | 受影响对象（章节路径 / 卡号 / 图节点 id / 选中对象 / 基线 id） |
| `result_ref` | 产物指针（项目根内相对路径 + sha256）：讨论草稿 / 提案件 / 图 / 基线 / 变更记录 |
| `error` | `{code, message, stage, recoverable}`；`recoverable:true` 表示可续接（重跑同一动作） |
| `archived` / `archive` | 会话被归档时留痕（归档位置 + 原因），引用不失效 |

### 10.2 六阶段与文案（DESIGN.md §3.6 逐字）

`reading`＝「正在读取」、`drafting`＝「整理中」、`saved`＝「已保存草稿」、`review_needed`＝「待审定」、
`failed`＝「失败」；`applied` 的文案**由真实回执决定**：图派生发布 → 「图已更新」，基线激活 → 「基线已激活」。
前端只渲染服务端下发的 `label`，不自己推断状态。

### 10.3 `applied` 的唯一来源（硬口径）

`applied` 只能由**真实写入成功的回执**产生：落盘前 `assertAppliedHasWriteReceipt` 要求
`tool_receipts` 里至少有一条 `ok && write`；**读回时同一条校验再跑一遍**——手工塞进文件里的
"applied 但没有写入回执"行会被判坏行并报出，不因为它写在文件里就当真。模型说"我做完了"不产生 applied。

### 10.4 会话删除：有引用转归档

删除会话时先看有没有动作**有效引用**它（有产物指针 / 有受影响对象 / 处于 `review_needed`/`applied`）：
有引用 → `chat/<sid>.jsonl` 挪到 `chat/archive/`（内容一字不改）并在动作记录上留痕，删除响应如实说明
`archived:true` 与归档位置；没有引用 → 照旧删除。归档过的会话不再出现在会话列表里，但引用仍可核实。

### 10.5 只读/写入口

- `GET /api/projects/:id/chat/actions[?session_id=…][&action_id=…]` —— 读动作回执（只读）；
  含用户聊天原话，**远程口径与聊天读接口一致**（默认 403 `REMOTE_CHAT_HIDDEN`）。
- `POST /api/projects/:id/chat/actions` —— `op=run`（按原话跑一次动作）/ `op=retry`（续接失败动作）/
  `op=activate`（审定并激活提案，**唯一会写现行图纸的动作**，只能由人触发）。
- 自然表达触发的动作在 `POST …/chat/sessions/:sid/messages` 里就地完成，结果随 SSE `{"action":{…}}` 下发。

## 11. 待议处置记录（V06-08 登记）

`.工作台/decisions.jsonl` 与 `baselines.jsonl` 同层（§2.6「意图/决策/基线确认」三件套并列），
**只在尾部追加整行**，没有改写/截断分支。它记录**对待议条目的处置**，不重写待议原文。

| 字段 | 含义 |
| --- | --- |
| `decision_id` | 稳定 id（时间戳 + 内容指纹）；同一条语义重复提交得到同一 id |
| `discussion_ref` | 定位引用三件套：`source`（待议源）/ `index`（条目序号，0 起）/ `content_sha256`（该行原文去行尾空白的 sha256） |
| `action` | `proposed` / `accepted` / `rejected` / `superseded`（提出 / 采纳 / 驳回 / 被替代） |
| `reason` | 处置理由，**必填**（没有理由等于没有处置依据） |
| `decided_by` / `role` | 处理者标识与角色 |
| `related` | 关联对象：`baseline_id` / `design_revision` / `plan_revision` / `task_id`（采纳与被替代**必须**至少给一个，否则判不了是否实现） |
| `supersedes` | 被本记录替代的**处置记录** id（可空；替代关系显式留痕） |
| `applicable` | 处置当时生效基线的图纸修订（取不到写 null，不编造） |
| `at` | 记录时间 |

### 11.1 派生状态与两条硬口径

- **派生态按定位键派生**：`源 ␟ 序号 ␟ 内容哈希`。相同文字出现在不同源/不同序号 = 两条不同记录，
  各记各的状态，**不因为文本相同就合并丢失来源**（§3.5 末段）；同一条目多次处置取最后一条为当前态，
  历史记录全部保留。
- **不改待议原文**：处置只写本文件。塔台自身的待议本体是 repo 根 `DESIGN.md` 附录 B，
  处置记录一个字节都不动它；界面按派生状态显示"待处理 / 已提出 / 已采纳 / 已驳回 / 已被替代"。
- **采纳 ≠ 已实现**：`accepted` 只表示设计层面接受了这条待议。界面另按 `related.task_id` 取该任务的
  真实执行状态与用户人工验收（§5.8）——只有用户验收接受才算"已实现"，否则明写"采纳不等于已实现"。

### 11.2 入口

- `GET /api/projects/:id/plan` —— 施工定义（`TaskDefinition`）+ 运行状态（`TaskState`）+ 对齐结论
  + 每卡的原文定位片段（缺施工图返回 `exists:false` 空态）。
- `GET /api/projects/:id/discussions` —— 待议条目（带 `discussion_ref`）+ 处置派生态 + 处置记录
  + 采纳条目的关联实现情况（只读待议正文）。
- `POST /api/projects/:id/discussions/decisions` —— **只追加**一条处置记录；`discussion_ref` 对不上任何
  当前条目（原文/序号已变）时明确拒绝，不写挂错原文的记录。
- `GET/POST /api/projects/:id/acceptance` —— 验收页读口（待验收区 / 有效场景证据 / 可读场景）与
  用户人工验收写入（接受 / 退回 / 接受已知限制）。写入走 §2.6 的 v2 事件，`role` 固定 `user`：
  Agent 与技术审定不得代签用户 Gate（§5.8）。

## 12. 项目入口与任务认领（V06-10 登记；代码在 `src/server/work/{entry,claims}.ts` 与 `src/mcp/tools/projectEntry.ts`）

前置：本卡的入口与认领契约写在 **DESIGN.md §6.7 / §2.7 / §6.2**，本节只登记实现落点与调用约定，不改设计口径。

### 12.1 只读入口 `project_entry`（MCP 工具；进程内入口 `evaluateProjectEntry`）

- 输入**恰好**五个字段：`project_id` / `role` / `client_capabilities` / `known_revision` / `resume_hint`。
- 只读返回**恰好**八个字段：`project` / `baseline` / `context_manifest` / `current_change` / `current_runs` / `next_action` / `reasons` / `required_reads`（顺序即契约顺序，常量在 `entry.ts#PROJECT_ENTRY_RESULT_FIELDS`）。
- `next_action` **恰好**七个取值：`resume_task` / `claim_task` / `review_result` / `await_role` / `await_decision` / `blocked` / `complete`；判定优先顺序写在 `entry.ts` 文件头与 `decideNextAction` 里（恢复优先于新领；无有效基线不派活）。
- **只读红线**：入口不提交事件、不写文件、不认领、不调模型。它给的"下一项"是接续指令（任务/交接 ID、依据版本、依赖、允许范围、完成要求、`task_revision`），不是认领动作。
- 能力发现（§6.2）：`client_capabilities` **未声明按「仅可读取」处理**；只读档位不会被派发 `resume_task`/`claim_task`（返回 `await_role` + 接续指令）。
- **阻塞卡不许新领（2026-09-30 有界修正）**：任务执行状态是 `blocked` 时，`claim_task` 明确拒绝（`NOT_CLAIMABLE`，引 `blocked_reason` 原文并说明按**原启动条件**经协调器解阻），零认领事件；唯一写入服务的文件锁内复核同一判据（见 §8.1），直连 `POST /api/work/command` 手写 `task.claimed` 不能旁路。解阻只能由协调器写 `task.status_changed(status="ready")`（先满足原启动条件）；续约（`claim_action:"renew"`，核实通过）与释放不受此限。
- **`required_reads` 的项目级扩展（2026-09-30 有界修正）**：除硬编码的四处（plan/design/baselines/events，按需再加 audit/checkpoint）外，入口另读一个**可选的**项目级运行配置 `<项目根>/.工作台/work/stage-reads.json`（与 `budget.json` 同层同类，**机器派生指针、不是新设计也不是授权源**），把本阶段必读原文（项目总图、AGENTS.md、当前交接等）追加进 `required_reads`（`kind` 复用既有枚举，**不新增必需 enum**；同一 `kind+path` 不重复列）。文件不存在 = 老项目原样兼容（**不**加 missing 理由、不阻断）；文件存在但不合法（坏 JSON / 未知字段 / 重复字段 / `schema_version` 不是 `1` / 体积超 256 KiB / 条目 `kind` 不在枚举内 / `path` 绝对路径、`..` 穿越、越出项目根或经软链逃逸 / `generated_from` 或 `entries` 点名的文件不存在 / 生成时 `sha256` 与当前内容不一致）→ 入口 `next_action="blocked"` + `reasons[].code="stage_reads_invalid"`，**不派活**（来源缺失或改过就拒发）。**重复字段按 JSON 字符串语义解码后判定**：`"schema_version"` 与 `"\u0073chema_version"` 是同一个键，转义写法不能绕过该检查（2026-09-30 按对端探针 `root-stage-review-o7ur1t/` 收口）。`preferred_task_id`（可选）只是排序意见：只在**真实就绪候选集合**内生效（依赖已释放、角色相符、范围无冲突），指不动就如实给 `stage_preferred_unusable` 并回落默认排序；调用方显式 `resume_hint` **优先于**它，两者都不越权绕过任何校验。指针格式与判据的唯一实现在 `src/server/work/stageReads.ts`。

### 12.2 认领与回报 `claim_task` / `submit_task_result`（MCP 写口；实现 `claims.ts`）

- 认领是**带 `expected_revision` 的单独一次原子写**（`task.claimed`，实体 `task:<task_id>`）；两个客户端抢同一张卡时键不同、只有版本检查通过的那个成功。
- 事件 payload 追加（§2.7）：`run_id` / `attempt_id` / `attempt` / `owner_id` / `owner_role` / `claim_token` / `lease_expires_at` / `workspace`；重派另有 `takeover_basis`（核实依据）。
- **租约语义**：`lease_expires_at` 到期只表示"当前所有权需核实"，**不**证明旧进程已停止。到期后重派必须带 `takeover_basis`（隔离了新工作目录，或确认旧进程已停止且旧认领失效），否则拒绝。
- **提交重查**（`submitTaskResult`）：任务版本 / 认领 token 与持有者 / 租约 / 依赖释放（复用 V06-09 的 `dependencyRelease`，不看前卡自报 done）/ 证据引用（内容寻址 sha256 或项目根内相对路径，必须取得到）五查全过才写 `task.result_submitted`。
- **可体验运行入口（补修 F3，2026-09-20）**：`submit_task_result` 的入参新增**可选**
  `runtime_entries[]`（每项 `{scenario, url, verified_at, status, reason}`，**只收 http(s)**、`verified_at` 必须能解析出真实时刻、
  `status=reachable` 之外必须写 `reason`）。传了才写进 `task.result_submitted` 的 payload（**不传则事件载荷逐字节不变**，
  旧调用完全兼容）；**版本绑定复用回报里已有的 `result_revision`**，不新增字段来源。校验与成果登记
  （`audit.submission_submitted` 的 `runtime_entries`）**同一套**（`work/runtimeEntries.ts#parseRuntimeEntries`），
  且**闸门同样在读侧**：非法登记写入会被收下、读回来是 `EVENT_INVALID`（宁可红，不静默丢一条入口）。读取侧把两条路径
  **合并装配**（见 §19.3）。
- 续约/释放只允许持有者（token 校验）：续约写 `task.claimed`（`claim_action: "renew"`），释放写 `task.status_changed`（`status: "ready"` + `claim_released: true`）。
- 调用层失败码（**不是**写入服务错误码，不扩 `WORK_ERROR_CODES`）：`CLAIM_HELD` / `CLAIM_NOT_YOURS` / `LEASE_NEEDS_VERIFICATION` / `DEPENDENCY_UNMET` / `EVIDENCE_MISSING` / `NOT_CLAIMABLE`，外加写入服务原样透传的 `VERSION_CONFLICT` / `IDEMPOTENCY_CONFLICT` / `SERVICE_UNAVAILABLE` / `INVALID_COMMAND`。每个失败都带 `read_again`（重新读状态的入口）。
- **不承诺 exactly-once**：命令与文件系统不受 token 自动保护，执行器仍要自己落实目录隔离与进程终止（§2.7）。

### 12.3 客户端接入规则

`templates/agents-md-snippet.md` 是入口规则的模板，由 `scripts/attach-agents-md.ts`（`pnpm attach:agents-md -- <project_id>`）写进被纳管项目的 `AGENTS.md`（客户端实际载入的位置）：

- 只动 `<!-- tatai-mcp:start -->` … `<!-- tatai-mcp:end -->` 标记区；标记区与模板逐字节一致时一个字节都不写；
- 标记区过期时**只替换标记区**（收敛），用户自写规则（标记区内外）逐字节保留；
- 有 start 没有配对 end（标记被手工破坏）时拒绝写，不猜边界、不追加第二段。

## 13. 外部执行与恢复（V06-11 登记；代码在 `src/server/work/executionReceipts.ts`）

前置：本卡契约写在 **DESIGN.md §5.4 / §6.5–§6.7 / §1.5**，人话档案在 **docs/agent-integration.md**；
本节只登记实现落点与调用约定，不改设计口径。

### 13.1 定位（§6.5 硬边界）

塔台**不 spawn 任何进程**：外部协调器（Claude Code 等）负责拉起/终止执行进程与目录隔离。
本模块产出**启动计划**（argv 数组 + cwd + 超时 + 协调器职责）与**回执协议**，
**不在本仓另造一套 worker / 调度中心**。

- 命令模板只从**受控配置**来：内置实测档案 `BUILTIN_CLIENT_PROFILES`，项目可用
  `<项目>/.工作台/agents.json`（`{"clients":[…]}`）覆盖/追加；模板必须是 **argv 数组**，
  占位符只认 `<prompt>/<model>/<effort>/<workspace>/<task_id>/<run_id>/<attempt_id>`。
  传**字符串命令**（模型说明文本里抄来的命令行）一律 `COMMAND_FROM_TEXT_REJECTED`。
- **未配置 / 缺二进制 / 缺凭据 = 不可启动**：`resolveStartable` 返回
  `CLIENT_NOT_CONFIGURED` / `CLIENT_UNAVAILABLE` / `CREDENTIAL_MISSING`，逐条列缺什么，
  **不替用户选择新服务**。凭据检查只报"在不在"，回执与文档都不带密钥原文。
- 工作目录隔离（`assertIsolatedWorkspace` 明文拒绝）：项目根、项目根的祖先、
  项目内但不是 `<项目>/.工作台/runs/` 的路径一律不收。

### 13.2 执行事件词表（实体 `execution:<execution_id>`，一个 attempt 一个 id）

五类必备事件 + 效果三态 + 失败，共 11 个 `type`（**未并入 `types.ts#REGISTERED_EVENT_TYPES`**：
那张登记面的并集口径被 `verify-v06-09` 的 ④-2 断言锁定为 task/finding/audit 三个模块的并集，
本卡不改既有断言，是否登记交父代理裁定）：

| 事件 | 现场（§5.4 运行现场） | 关键 payload |
| --- | --- | --- |
| `execution.start_requested` | 启动请求中 | goal / argv_digest / template_source / timeout_ms |
| `execution.started` | 运行中 | `actual{client_id,client_version,model,effort,workspace,pid}` + 父执行 |
| `execution.heartbeat` | 运行中 / 等待输入 | observed_at / awaiting_input / note |
| `execution.checkpoint` | 运行中 / 等待输入 | note / artifacts / worktree / effects_in_flight |
| `execution.stop_requested` | 停止请求中 | reason / confirm_method |
| `execution.stopped` | 已停止 | `confirmation`（必填）/ evidence / exit_code |
| `execution.failed` | 已结束 | phase(launch/run) / scene{message,exit_code,stderr_tail,argv_digest} / log_ref |
| `execution.effect_declared` | —— | effect_id / target / authorization / verify_method / 外部幂等键 |
| `execution.effect_confirmed` | —— | result_ref（实际结果标识，必填） |
| `execution.effect_unverified` | —— | check_evidence；`retry_blocked=true` |
| `execution.delivered` | 已结束 | deliverables / evidence_refs / verification / untested / known_issues / diff_ref / exit_code |

### 13.3 三条硬口径（与 §5.4 逐字对齐）

- **启动失败须回报失败及现场**：失败走 `execution.failed`（带 `scene.message` 与现场），
  **不会**出现 `execution.started`——不能先把任务标成运行中。
- **无心跳不当已停止**：心跳缺失/超期只把运行现场判成 `unknown`（`unreachable`），
  `NO_HEARTBEAT_NOTE` 逐字在场；只有带 `confirmation` 的 `execution.stopped` 才是 `confirmed_stopped`。
- **停止未确认不再派同一可写目录**：`dispatchGuard` 在"同目录 + 停止未确认"时
  `STOP_NOT_CONFIRMED_SAME_WORKSPACE` 并给出隔离目录；恢复顺序见 `RECOVERY_STEPS`
  （读最后检查点 → **查询实际效果** → 旧 run 写入可能 → 工作树基线 → 成果/证据有效性 →
  旧认领 → 新 attempt → 继续），结果不明时 `blind_replay_blocked = true`（不盲重放）。

### 13.4 回执前置与调用层失败码

- 回执只接**当前有效认领**：`claim_token` 与任务现场一致、持有者一致，缺 `workspace` 拒收；
  回执照旧走唯一写入服务（幂等命中返回原回执；旧版本写 → `VERSION_CONFLICT`）。
- 心跳事件 **≠** 租约续约：续约仍走 `claims.renewClaim`（§12.2）。
- 调用层失败码（**不是**写入服务错误码，不扩 `WORK_ERROR_CODES`）：
  `CLIENT_NOT_CONFIGURED` / `CLIENT_UNAVAILABLE` / `CREDENTIAL_MISSING` / `TEMPLATE_INVALID` /
  `COMMAND_FROM_TEXT_REJECTED` / `WORKSPACE_NOT_ISOLATED` / `EXECUTION_UNKNOWN` /
  `CLAIM_HELD` / `CLAIM_NOT_YOURS` / `STOP_NOT_CONFIRMED` / `EFFECT_DECLARATION_MISSING` /
  `EFFECT_UNVERIFIED` / `BLIND_REPLAY_BLOCKED`，外加写入服务原样透传的
  `VERSION_CONFLICT` / `IDEMPOTENCY_CONFLICT` / `SERVICE_UNAVAILABLE` / `INVALID_COMMAND`。

## 14. 注册表现场状态与恢复入口（补修 A 登记；代码在 `src/server/registry.ts`）

补修 A（PLAN「补修分包」，V06-14 主责）收口的是注册表读取的 fail-open：**注册表读不到 ≠ 没有登记过
项目**。本节只登记"读不到时对外给出的形状与恢复入口"，不改上文任何既有契约。

### 14.1 现场判据（唯一出处 `probeRegistrySite`）

`registry.json` 按 `existsSync` 判为不存在时，按数据目录内容分档：

| 现场 | 判定 | 结果 |
| --- | --- | --- |
| 数据目录不存在（ENOENT） | 从没装过 | **首次初始化**：建空表 + 落初始化标记 `.tatai-initialized` |
| 目录列不出来（EACCES/EPERM…） | 看不清现场 | `REGISTRY_STATE_UNKNOWN`（保持未知，不猜为空） |
| 目录列表里有 `registry.json` 而 `existsSync` 说没有 | 文件其实在 | 走正常读路径（读不到则 `REGISTRY_UNREADABLE`） |
| 目录里有初始化标记 `.tatai-initialized` | 本目录被塔台初始化过 | `REGISTRY_MISSING`（**已有运行状态丢失**） |
| 除"启动骨架"外还有任何条目 | 有历史运行痕迹 | `REGISTRY_MISSING` |
| 只有启动骨架（`work-service.json` / `logs/` / `remote/`）或空目录 | 没有项目事实可丢 | **首次初始化**（保留合法流程） |

启动骨架 = **塔台进程启动期必定自建、且不含项目事实**的三个条目；其余任何条目（`agents.json`、
`config.json`、`projects/`、`registry.json.corrupt.*`、未知文件…）都算"已有运行状态痕迹"。
`*.lock` 与 `<file>.<pid>.<ts>.tmp` 是原子写/锁的瞬时残留，不算痕迹。

### 14.2 错误形状（读路径与写路径同一份）

`RegistryStateError`（`RegistryCorruptError` 是它的 `corrupt` 子类，类名与 code 沿用）带：

- `code`：`REGISTRY_MISSING` / `REGISTRY_JSON_CORRUPT` / `REGISTRY_UNREADABLE` / `REGISTRY_STATE_UNKNOWN`；
- `state`：`missing` / `corrupt` / `unreadable` / `unknown`（现场性质，给人看）；
- `reason` 与 `traces`（被判成痕迹的条目名，最多 20 条）；
- `recovery`：恢复入口说明（原文一处，见下）。

HTTP 层（`src/server/index.ts`）对四种 code 一律回 **500 + `{ok:false, error:{code,state,reason,traces?,recovery,file,message}}`**
（`file` 只给 basename，消息过消息级脱敏）。**任何路由都不在这条路径上返回空项目列表**。
`GET /api/projects` 在这种现场下返回结构化错误，不返回 `[]`。

### 14.3 恢复入口 `POST /api/registry/recover`（登记为写路由，见 `remote-routes.ts`）

- 空 body `{}`：把现场留档后**重建空表**（`action:"rebuilt_empty"`）——人确认这一份救不回来时才用；
- body `{"from":"<文件名>"}`：从**数据目录内**的留档/备份恢复（`action:"restored_from"`），
  来源必须能过注册表校验；原文一字不改地写回（不重新序列化）；
- 现场可读且未给 `from`：`action:"noop"`，**零改动**（不会顺手把好表清零）。

留档口径（一律改名/另写，不覆盖、不删）：

| 现场 | 留档 |
| --- | --- |
| 文件在但读不出来（corrupt/unreadable） | 改名 `registry.json.corrupt.<毫秒时间戳>`（原文一字不改） |
| 文件不在（missing） | 写 `registry.json.lost.<时间戳>.json`（记录当时的 state/code/reason/traces） |
| 表现场可读但要按 `from` 恢复 | 先改名 `registry.json.bak.<时间戳>` |

约束：全程 `withFileLock(registryPath)` + 原子写（tmp + rename）；`from` 只接受数据目录内的
**文件名**（不带路径、不含 `..`），非法入参回 **400 `INVALID_INPUT`** 且不动现有文件；
**读、写两条路径都不会自动重建**（旧口径"写路径遇到坏表就留档+清空重建"已取消）。

---

## 15. 时间字段的比较口径（补修 B 登记；代码在 `src/server/time.ts` + 各读侧）

**登记缘由**：事件信封里有两类时间，偏移不受产品统一控制：

| 字段 | 来源 | 偏移 |
| --- | --- | --- |
| `received_at`（→ 任务状态 `updated_at`、认领记录 `at`、执行 `requested_at`） | 唯一写入服务落盘时刻 | 本机 `nowIso()`（如 `+08:00`） |
| `occurred_at`（→ 审计记录 `at`：提交/自检/独立审计/修复/复测/人工验收；决策记录 `at`） | **调用方**给的业务时间，原样落盘 | 任意（`Z`、`+08:00`、`-05:00`…） |
| payload 里的 `observed_at` / `declared_at` / `started_at`（→ 心跳/检查点的 `at`） | **调用方**给 | 任意 |

因此**不能对时间串做字典序 / `canonical` 字符串大小比较**：`2026-09-20T09:00:00+08:00`
真实时刻（`01:00Z`）**早于** `2026-09-20T02:00:00Z`，字面序却相反。

### 15.1 三条硬口径

1. **权威重放按 `seq`**：`events.jsonl` 的折叠一律按服务端提交序号（`replayEvents`、`foldExecutions`）。
   客户端 `occurred_at` **不参与**重放顺序，事件数组反序不影响结论。
   （`occurred_at` 只作为业务时间记录，并进入审计记录的 `at`。）
2. **按发生时间比的地方解析成毫秒再比**：统一走 `src/server/time.ts` 的
   `parseIsoMs` / `compareIsoTime` / `latestByTime`（`live.ts`、`projects-summary.ts`、
   `global-changes.ts` 早已同口径；前端不 import 服务端模块，`ui/arch/projectGraph.ts` 就地解析）。
3. **同刻与非法**：
   - 同一瞬时的不同写法（`…10:00:00Z` vs `…18:00:00+08:00`）判**同刻**（比较为 0）；
   - 同刻并列的次级序 = 输入顺序里更靠后的那条（= 事实/提交顺序里最后提交的一条），稳定可复现；
   - 非法/缺失（空串、缺字段、`Date.parse` 为 `NaN`）**不参与**「取最新」的比较，
     在升序里排在所有有效值之前；整组都解析不出来时，取最晚的接口返回 `null`，
     由调用方走保守分支（如 `revisions.code = null`、验收维度回落 `pending`、`last_task_report_at = null`），
     **不把非法值当成最新或有效值**。

### 15.2 不做的事

- **不为了修排序改写历史**：既有事件、证据、哈希、历史事件的 `occurred_at` 一个字节都不动，
  也没有"统一重写落盘时间格式"的迁移；写入口径（`nowIso()`）保持不变，只统一**读侧比较**。
- **不机械改非时间排序**：稳定 ID、路径、名字、`finding_id`、`backup_id` 等的字典序原样保留。

## 16. 父级集成检查的正式链路（补修包 C 登记；代码在 `src/server/work/{plan,statusProjection,audit}.ts`）

补修包 C（V06-09 主责，V06-06 联验）补齐的是**父级"自身集成检查通过"这条门槛怎么落地**——
门槛本身不删、不放宽：父级仍然是「所有必需子项通过 **＋** 自身集成检查通过」才算通过，
空集合仍然不判绿（`mapping: "unmapped"` / `required_count === 0` 永远进不了 `verified`）。

### 16.1 "需要哪些集成检查"= 施工图里的版本化验收定义

写在**施工图**的一个独立小节里（不是另有存储、不是调用方声明）：

```markdown
### 集成检查要求（对象 → 必需集成检查）

| 对象 ID | 检查 ID | 说明 | 必需性 |
| --- | --- | --- | --- |
| module:paint | module:paint::integration | 模块内数据链路 | 必需 |
| module:api | module:api::integration::legacy | 旧接口兼容（本期不阻塞） | 可选 |
```

- **对象 ID** = 对象稳定 ID（`module:<模块>` / 集成线 id 一类；跨修订不变）。
- **必需性**：只有明确写「可选 / 选做 / 非必需 / optional / no」才是 `false`，**不明说的都算必需**。
- **绑定**：这份声明随施工图的修订（`content_sha256`）一起进不可变修订与基线；
  `plan.parseIntegrationRequirements` 只读那张表，**不进** `parsePlanTable` / `definitionHashOf` /
  `taskDefinitionHash` / `planDefinitionDigest` 任何一位（施工卡表与定义哈希口径逐字不变）。
- **生效判据**（`withIntegrationRequirementsInForce`）：① 小节结构可读（`issues` 为空）；
  ② 有**有效基线**；③ 基线批准的正是当前这版施工图。任一不满足 → 不据此判绿，
  并把原因原样作为父级的缺口理由（`integration_checks_blocked_reason` → `missing[].why`）。
- **过期即失效**：改了图纸 = 换了一版施工图 → 生效基线不再覆盖它，且绑在旧修订上的检查记录
  按 §5.6 的规则转"待验证"（旧结论保留在 `history`）。

### 16.2 检查结果 = 既有审计/证据事件（不另造存储）

复用 `audit.self_check_recorded` / `audit.independent_audit_recorded` 两条既有事件，
字段对应关系（**没有新增事件类型**）：

| 卡面要求字段 | 事件里落在哪 |
| --- | --- |
| 检查 ID | `checks[].check_id` |
| 目标对象稳定 ID | 记录的 `task_id`（父级即 `module:<模块>`；集成线即连线 id） |
| 被测版本（内容或定义哈希） | 记录级 `binding`（`revision_kind` + `revision`） |
| 范围 | `checks[].scope[]`（补修 C 新增的**可选**字段）+ 独立审计的 `not_reported_scope[]` |
| 证据引用 | `checks[].evidence_sha256`（正文走 `evidence/<sha256>.json`，内容寻址不可变） |
| 结果 | `checks[].result` / 自检的 `conclusion` |

`checks[].scope` 是本次唯一的事件 payload 扩展：可选、缺省空数组、读侧不猜"范围就是全部"。

### 16.3 读取路径从权威事实装配

- **唯一读口**：`GET /api/projects/:id/status-projection`（`src/server/index.ts`）。
  "需要哪些集成检查"来自施工图 + 生效基线，"检查通过没有"来自事件，两条都在请求时现算。
- **不读任何 query 参数**：本路由不解析 query（`workProjectionMatch[3]` 从不消费）；
  伪造 `?integration_checks=…` / `?module_integration_checks=…` / `?display_status=verified`
  得到的响应与不带参数**逐字节相同**。
- **进程内覆盖**：`objectsFromFacts(..., { module_integration_checks })` 仍然存在，但只是
  **测试夹具或调用方的显式覆盖**；它优先于图纸定义，并在投影里如实标注
  （`integration_checks_source: "override"` + 一条 `integration_requirements_override` 原因）。
  产品读口与前端**都不传它**。
- **响应里的依据**（可解释性）：
  - `projection.integration_requirements`：`declared` / `plan_revision` / `in_force` /
    `not_in_force_reason` / `issues` / `by_object`；
  - 每个对象的 `evidence_basis[]`：`check_id` / `record_ref`（事件实体，如 `check:<id>`）/
    `bound_revision` / `current_revision` / `evidence_sha256` / `effective` / `scope`；
  - 原有的 `history[]`（被取代的旧结论）与 `missing[]`（缺口点名到具体检查）不变。

### 16.4 验证入口

`pnpm verify:v06-09-c`（脚本 `scripts/verify-v06-09-c.ts`）：真实入口登记（`POST /documents/activate`）
→ 提交检查证据（`POST /api/work/command`）→ 读父级状态（HTTP 只读口）；服务重启后结果逐字节一致；
缺自身集成证据不绿；证据过期撤销当前通过；两个端点绿不能代替集成线通过；伪造 GET 参数不产生绿。

## 17. 一批改动的「检查通过」判定与内容版本绑定（补修包 D 登记；代码在 `src/server/gitStatus.ts`）

补修包 D（PLAN.md「补修分包」表 D 行 + 其下 D 段，主责卡 V06-12）**不认可**旧判定：
`changed_files` 与改动路径相交只说明「可能有关」，证据在册且哈希完整只说明「证据可取回且未损坏」，
两者都不能证明**检查通过**；「工作树干净」也只表示没有待保存改动。本节的判定是收紧后的**唯一口径**。

### 17.1 六条硬口径（`assessBatchVerification` 一处实现）

| # | 口径 | 落在哪 |
| --- | --- | --- |
| ① | 说清**声明范围**：哪批成果 / 哪些路径 / 哪些必需检查 | `ReminderVerification.declared`（`submission_ids` / `changed_paths` / `outcome_paths` / `required_checks`） |
| ② | 有**真实通过结果**、覆盖声明范围、所需证据**完整且当前有效**、**无未收口阻断** | `checks[]`（逐条复核）+ `coverage` + `blockers` |
| ③ | 绑定**当前实际内容版本（含未提交改动）** | `contentVersionOf()` 的指纹；`version.by_scope` + 每条 `checks[].bound_revision` / `current_content_version` |
| ④ | 只覆盖部分改动 → 显示**已覆盖与未验证范围**，不宣称整批通过 | `coverage.covered_paths` / `uncovered_paths`；状态 `partially_covered` |
| ⑤ | **自检 / 独立审计 / 用户接受分开记**，检查通过**不得**扩写成已验收 | `records.self_checks` / `independent_audits` / `user_acceptances`（只收属于本批成果或没挂任务的接受记录） |
| ⑥ | **工作树干净只表示没有待保存改动**，验证状态另算；没有验证证据就是未验证 | 干净树走同一判定（对象 = 最近一次成果提交）；无检查记录 → `unverified` |

状态五态：`checks_passed` / `partially_covered` / `unverified` / `blocked`（有未收口阻断）/ `unknown`
（不是仓库 / 只读探测失败）。**任何一条口径缺证据都不是 `checks_passed`**。

### 17.2 内容版本绑定：检查记录该绑什么（**这条是产出方要遵守的契约**）

- 口径常量 `CONTENT_VERSION_BASIS = "content-v1"`，实现 `gitStatus.ts#contentVersionOf(root, paths, {head})`：
  指纹 = 对**声明的那些路径当前的盘上内容**（每条路径的 `present` / 内容 sha256）取 sha256。
  **HEAD 与提交动作都不进指纹**（提交不改内容）；同路径内容再改一次 → 指纹必变。
- 检查记录要声明「这批改动已通过」，必须：`checks[].scope` 显式列出**被检查的路径**，
  记录级 `binding = { revision_kind: "code", revision: <该 scope 的内容指纹> }`（用 `contentVersionOf` 算，
  两侧同一实现）。`scope` 为空 → 说不清覆盖哪些路径 → 不据此判通过（①）。
- 复核按**每条记录自己的 scope** 现算当前指纹比对（复用 V06-09 `checkEffectiveness` 的
  「绑定修订 ≠ 当前修订 → 撤销通过」），所以旧版证据遇到同路径新修改必然失效（③）。
- 未提交改动**参与**内容指纹：同一份内容提交前后指纹相同（提交不是新版本），内容变了才是新版本。
- 单文件上限 `REMINDER_CONTENT_MAX_FILE_BYTES`（8MB）、单次总量上限 `REMINDER_CONTENT_MAX_TOTAL_BYTES`
  （64MB）：超限或被拒的路径取不到内容 → **不据此判通过**（`fingerprint: null`）。

### 17.3 反向要求（缺一即不通过）

- **必需检查清单**来自任务定义（`statusProjection.ts#requiredChecksFromDefinitions`，与 V06-09 拼
  `check_id` 的口径同一出处）。清单**未知或不全**（无任务定义 / 任务有定义但无检查项）→ **不空集判绿**。
- **失败检查记录仍在册**且没有被「**同一条**检查、**更晚**、覆盖同一范围、绑定当前内容版本」的通过记录
  取代 → 状态 `blocked`（审计事件只追加：修复后能否复测通过要靠新记录证明）。
- **未收口阻断**（未关闭/未判误报重复、也未被用户接受风险的缺陷；未解决的 Git 冲突）→ `blocked`。
  关系判据保守：**没声明影响范围就算影响**；声明了范围而与这批改动/任务无交集才算无关。
- 判定依据随响应带出（`reminder.verification.detail`），并写进「复制给执行 Agent 的整理说明」：
  记录来源 `record_ref`、复核结论与原因、绑定版本、当前内容版本、独立性、证据哈希、缺口与阻断。

### 17.4 读取路径

- 唯一读口：`GET /api/projects/:id/git-status`（只读；`remote-routes.ts` 登记 `git-status-read`）。
  事实从**权威来源**装配：`collectProjectFacts`（提交记录 / 自检与独立审计事件 / 缺陷）、
  `evidenceManifest`（证据在册与完整）、`requiredChecksFromDefinitions`（必需检查）。
  该路由**不解析任何请求参数**，前端与 GET 参数产生不了 `checks_passed`；内容指纹按项目工作树现算。
- 旧字段 `relatedOutcomes(...).checks_passed` **已删除**（它的判据正是本包否定的那条）：
  调用方只看 `verification.state` + `verification.detail`。

### 17.5 验证入口

`pnpm verify:v06-12-d`（`scripts/verify-v06-12-d.ts`）：真 Git 夹具 + 真起后端 +
真实 HTTP 写入面（定义绑定 / 成果提交 / 自检记录）→ 真实读口读出 `checks_passed` 并逐条核对依据；
五条点名反例（失败日志仍在册 / 旧版证据遇同路径新修改 / 部分文件有证据 / 证据失效 / 工作树干净但从未检查）
+ 必需清单未知、未收口阻断、复测取代等对照。回归：`verify:v06-12`、`verify:v06-12-ui`、`verify:v06-09`、
`verify:v06-09-c`、`verify:v06-13`。

## 18. 规划图的自动触发链与语义整理分段（补修包 E 登记；代码在 `src/arch/blueprintAuto.ts`）

补修 E 之前，V06-05 的触发语义是"有效基线激活只触发**确定性派生层**（零模型），模型语义整理只在显式
`semantic:true` 时跑"。裁定认为这**不合原意**：正常产品链路必须能自动得到必要的语义整理结果，
`semantic:true` 只能是显式重试/高级入口。本节登记补上来的那条链的**对外契约**（§1–§17 原文未动）。

### 18.1 触发点与档位

| 入口 | 档位 | 说明 |
| --- | --- | --- |
| `POST /api/projects/:id/documents/activate` | **自动**（缺省；`TATAI_SEMANTIC_AUTO=0` 可关） | 激活后异步跑自动链：先零模型发确定性派生，再按分段检查语义整理结果、缺什么整理什么 |
| 聊天动作「更新图」`POST /api/projects/:id/chat/actions`（`op_kind=blueprint_update`） | **自动** | 走同一条链（`awaitSemantic:false`：动作先拿到确定性/缓存结果，整理阶段在后台继续） |
| `POST /api/projects/:id/arch/blueprint {semantic:true}` | **显式重试/高级** | 强制重跑一轮**全量**整理（不吃分段缓存）；结果会落进分段缓存，随后自动链因此命中缓存、不重复调用 |
| `POST /api/projects/:id/arch/blueprint`（缺省 `semantic:false`） | 零模型 | 只做确定性派生 + 复用已保存的整理结果 |

**触发不阻塞主流程**：激活响应不等模型——确定性派生先落盘（回执 `trigger:":deterministic"`），
整理阶段在其后（缺省 300ms 静默期起跑）异步进行。状态与回执可查（18.3）。

### 18.2 分段缓存键与"只处理受影响范围"

来源分**两段**：`design`（设计段：设计书整体内容哈希）、`plan`（施工段：施工图**定义**哈希——
任务状态/进度/勾选位不在定义里，所以它们变了键也不变）。

```
segment_key = sha256( baseline_id | scope | 该段来源内容 sha256 | BLUEPRINT_GENERATOR_VERSION | SEMANTIC_SCOPE_VERSION )
```

- 命中（键一致）→ 复用已有整理结果，**零模型调用**；键不一致或缺失才算"要整理"。
- 一轮**最多一次模型调用**：只把要整理的段放进输入（未受影响段只给稳定 ID 索引，不给条目清单）；
  未受影响段的既有整理结果原样继承。
- 返回条目按**可定位出处**归段（有 `plan_task` 且无 `design_section` → 施工段；其余 → 设计段）；
  属于本轮未整理段的条目**丢弃并登记**（不许越范围改写未受影响部分）。
- 落缓存前再核一次该段的键：期间来源变了 → 该次结果作废（**过时响应不覆盖较新结果**，也不写缓存）。
- **校验不过的整理结果不采用、不落缓存**（否则会把图永久卡死）。

### 18.3 落点与只读状态

| 文件 | 内容 |
| --- | --- |
| `<项目根>/.工作台/arch/semantic-cache.json` | 分段整理结果 + 失败账目（`shards` / `failures`） |
| `<项目根>/.工作台/arch/semantic-status.json` | 最近一次自动链运行状态（阶段 / outcome / 分段账目 / 覆盖 / 缺失 / 说明） |
| `<项目根>/.工作台/arch/blueprint.json` · `blueprint-receipt.json` | 仍是 §4.1/§4.4 的那两份（未变） |

`GET /api/projects/:id/arch/blueprint` 在原有字段之外**新增只读字段** `semantic`：
`{ status, scopes[], cache{generator_version,scope_version,corrupt}, auto_enabled, note }`——只含哈希、段名与说明，
**不含任何本机绝对路径**（远程读口径不变）。它回答："这张图这一版的语义整理是哪次跑的、基于哪版基线/来源、
模型可不可用、覆盖了什么缺了什么"。

### 18.4 降级、重试上限与红线

- **模型不可用**：保留有效旧整理结果（该段标 `stale_source:true`，不当现行）或只展示确定性派生结果；
  状态里 `semantic_complete:false` 并写清版本/覆盖/缺失——**不冒充本轮完整语义整理已完成**。
- **有界重试**：一轮内每段最多 2 次尝试（间隔 400ms），跨轮累计最多 3 次失败（并有 30s 退避窗口）；
  到顶进**终止态**，只等"来源变化"或"显式 `semantic:true`"才继续（不得无界重试）。
- **重复事件合并**：同项目、同分段键签名、上一轮还没跑完时再触发 → 直接返回既有运行（不开新轮、不再调模型）。
- **纯状态变化零调用**：任务进度、检查结果、颜色（状态投影）、布局/折叠变化都不进分段键，
  因此**零模型调用**，且命中完整缓存时**连图都不重画**（`blueprint.json` 逐字节不变）。
- **模型不裁定完成色或新架构**：整理结果照旧过 `sanitizeModelProposal`（摘完成色/进度字段）与
  `validateBlueprint`（ID 唯一、端点存在、来源可定位且哈希有效、依赖无环、覆盖与上限、基线仍有效）。

### 18.5 运行开关（运维/验证用，与 `TATAI_WORK_FAULT_SNAPSHOT` 同款先例）

- `TATAI_SEMANTIC_AUTO=0`：关掉**自动**模型整理（确定性派生与状态登记照常；显式 `semantic:true` 不受影响）。
  自动化/验证环境可用它保证"不隐式调用模型"。

### 18.6 验证

`pnpm verify:v06-05-e`（`scripts/verify-v06-05-e.ts`，73 PASS / 0 FAIL）：真起后端 + **伪网关**（不调真网关）
验证"激活 → 自动触发（假模型恰好一次）→ 状态可查"；重复激活命中缓存零重复调用、零重画；施工图/设计书
变化各自只重整理受影响的那一段（输入清单与目标范围逐条对账）；四类纯状态变化零模型调用 + 零重画 +
分段键逐字未变；模型不可用（抛错 / 答非所问 / 未配密钥）降级并说明版本·覆盖·缺失；校验不过与过时响应
都不覆盖较新有效结果、也不写进分段缓存；`semantic:true` 显式路径仍可强制重跑且结果进分段缓存（随后自动链
零调用）。回归：`verify:v06-05`（72/0）、`verify:v06-06`（113/0）、`verify:v06-07`（117/0）、
`verify:v06-09`（149/0）、`verify:v06-09-c`（40/0）、`verify:v06-12-d`（39/0）、`verify:v06-13`（82/0）、
`verify:s2`、`verify:l3`、`verify:m2`、`pnpm typecheck/build/build:server`。

## 19. 项目可体验运行入口（补修包 F 登记；代码在 `src/server/work/runtimeEntries.ts` + `work/audit.ts` + `src/ui/result-entry.ts`）

DESIGN.md §3.7 的既定能力："前端项目的结果给可打开的实际运行入口、对应场景和验证时间；没有可用入口就明确
'尚不可体验'；本期使用受控外部打开方式；纯后端项目给可读的场景试验（输入/期望/实际/证据）"。本节登记这条能力
的**登记落点、读写路径、状态口径与受控打开边界**。

### 19.1 落点：成果登记里的可选字段（**不**进 `registry.json`）

- **为什么不在全局注册表**：`registry.json` 是"这台机器上有哪些项目、路径在哪"的**跨项目索引**；运行入口是
  **项目自己的事实**（哪个场景、哪批成果、什么时候验的、现在还有效吗），临时地址会被换掉。塞进全局表意味着
  一次登记要动全库索引、还要处理"项目不在表里"的边角。
- **落在哪**：`audit.submission_submitted`（既有成果登记）的 payload 追加**可选**字段
  `runtime_entries[]`。成果与入口因此天然绑在一起，"来源成果与版本"不需要调用方另行声明（见 19.2）。
  没声明该字段＝这次成果没有入口，**不是错误**。
- **零新增事件类型、零新增路由、零新增错误码**：非法登记复用 `EVENT_INVALID`。
  **2026-09-20 第二轮裁定后**：非法值在**两条写入路径统一拒绝**（`service.ts#submit()` 是唯一写出口，写完命令校验后即校验并**不落盘**），读侧**保留**同一套校验用于**历史坏记录的可追溯**；纠正与扫描口径见 §19.8。
- **两条等价的登记路径（补修 F3，2026-09-20）**：
  1. **成果登记** `audit.submission_submitted` 的可选字段 `runtime_entries[]`（补修 F 原有路径，写口 `POST /api/work/command`）；
  2. **Agent 结果回报** `task.result_submitted` 的可选字段 `runtime_entries[]`（MCP `submit_task_result` 新增**可选**入参；
     旧调用不传该字段时事件载荷**逐字节不变**）。
  两条路径**共用同一套形状、同一套读侧校验、同一套状态判定与排序**（`work/runtimeEntries.ts`），**不另造存储**；
  区别只有"来源是谁"：读取时每条入口带 `source_kind`（`submission` / `result_submitted`）与 `source_record_id`。
  读侧装配**从权威事实合并两条来源**（`audit.submissions` + `task.result_submitted` 事件折出的来源），
  不靠调用方在进程内传参、也不由 GET 参数决定。
- **版本绑定**：成果登记那条用它的 `binding.revision`；结果回报那条用**回报里已有的 `result_revision`**（§5.6 的复核基准）。
  两者都进**版本轴**（19.4），不新增字段来源。

### 19.2 登记形状（最少五项）

```jsonc
{
  "type": "audit.submission_submitted",
  "payload": {
    // …既有字段（goal/baseline/changed_files/commands/untested/known_issues/evidence_refs/binding…）
    "runtime_entries": [
      {
        "scenario": "下单流程走一遍",              // 场景（必填）
        "url": "http://127.0.0.1:5173/order",      // 实际入口（必填，**只接受 http(s)**）
        "verified_at": "2026-09-20T18:30:00+08:00",// 验证时间（必填，带偏移 ISO，必须能解析出真实时刻）
        "status": "reachable",                     // reachable / unreachable / unknown（执行者实测写下）
        "reason": null                             // status != reachable 时**必填**（不可用原因）
      }
    ]
  }
}
```

"项目"＝该事件的 `project_id`；"来源成果与版本"＝**它挂在哪条成果登记上**，读侧从记录本身派生，不由调用方声明。
读侧（`parseRuntimeEntries`）对每条登记做严格校验：缺字段、`url` 非 http(s)、`verified_at` 解析不出真实时刻、
`status` 不在词表、`status != reachable` 却没写原因 —— 一律 `EVENT_INVALID`（宁可红，也不静默丢一条入口；
静默丢等于"没登记过"）。`url` 的协议闸门在**读侧**，所以 `javascript:` / `file:` / `data:` 连登记都不接受。

### 19.3 读取路径

`GET /api/projects/:id/acceptance`（既有读口）在原有字段之外**新增**：

| 字段 | 内容 |
| --- | --- |
| `runtime_entries[]` | 项目级入口清单（**两条登记路径合并**），逐条含 `scenario/url/verified_at/status/reason` + `source_record_id`/`source_kind`/`source_revision`/`source_revision_kind`/`source_submitted_by`/`source_task_id`/`registered_at` + `state`/`state_label`/`openable` + `revision_state`/`revision_label` |
| `runtime_entry_summary` | `{kind: available\|stale\|unavailable, label, note, total, can_open_count, fresh_count, reverify_due_count, failed_count, unknown_count, outdated_count}` |
| `tasks[].result_entry` | 该任务的一句话口径：`{kind: available\|stale\|unavailable, url, note}`（不再恒为 `unavailable`；文案会点明「待重新验证」与「版本过期」） |

装配是**从权威事实现算**的纯函数（`runtimeEntryViews` → `runtimeEntrySummaryOf`），进程不缓存、GET 参数改不动它。
**它不读用户的验收记录**：入口来自成果登记，所以用户还没接受时入口照样在（补修 F ③）。

### 19.4 状态判定：**两条轴**，登记内容不动、状态是派生的

**轴一：能不能打开**（`state` / `openable`）

| state | 判据 | 界面 |
| --- | --- | --- |
| `openable` | `status=reachable` 且 `verified_at` 距今 ≤ `RUNTIME_ENTRY_REVIEW_MS`（默认 24h） | 给"打开入口"按钮 |
| `reverify_due` | `status=reachable` 但**超过复核提醒阈值** | 标"**待重新验证**"（明写"入口**仍可打开**，只是该再确认一次"）+ **照样给"打开入口"按钮** |
| `failed` | `status=unreachable`（执行者实测打不开） | 标"入口失效：验证时探测失败" + 原因，**没有**按钮 |
| `unknown` | `status=unknown`，或验证时间不可用 | 标状态未知，**没有**按钮 |

**2026-09-20 口径变化（原来这里有一档 `expired`，现在没有）**：`RUNTIME_ENTRY_TTL_MS` 改名 `RUNTIME_ENTRY_REVIEW_MS`，
语义从"入口有效期"改成"**可达性复核提醒阈值**"——**超阈值不再是"失效"**："该重新看一眼"不等于"已经失效"，
也不等于塔台可以替用户关掉一个他可能还要用的入口。**词表里不存在 `expired`**。

**轴二：绑定的是哪一版成果**（`revision_state`，**与能不能打开相互独立**）

| revision_state | 判据 | 含义 |
| --- | --- | --- |
| `current` | 来源登记的版本 = 当前事实里的代码/内容版本（`facts.revisions.code`） | 这条入口对应的是当前版本 |
| `outdated` | 两侧都有且不相等 | **成果版本已过期**：入口**仍可打开**，但对应的是旧版本成果 |
| `unknown` | 任一侧拿不到（登记没声明版本、或当前版本读不出） | 不猜成 `current`，也不猜成 `outdated` |

**为什么必须分两条轴**：「验过、打不开」（`failed`）与「还能开、只是对应旧版本」（`outdated`）是两件事；
把它们混成一种状态会让用户既分不清"要不要重开"，也分不清"要不要重新验一遍"。

项目级概况三态**必须分开说**：没有任何登记 → `unavailable`（"尚不可体验"，与加载失败分开）；有能打开的（`can_open_count > 0`，
**含"待重新验证"**）→ `available`；登记过但当前都打不开 → `stale`（"登记过入口，当前都不可用"，**不是**"尚不可体验"）。
**超复核提醒阈值不作为"不可用"**：那种条目计入 `reverify_due_count`、仍算 `can_open_count`，概况文案里单独点名，
**不把 `available` 降级成"尚不可体验"**。`outdated_count` 单独计数，且与可打开计数**可以重叠**（一条入口可以既待重验、又已过期）。
多条登记不合并、不吞历史：同一场景被不同登记声明过就都留着，后来的那条不会盖掉失效的旧条目。

### 19.5 受控打开（前端，`src/ui/result-entry.ts`）

- **协议白名单只有 http/https**：`openableResultUrl()` 用 `new URL()` 解析后判协议，其余（`javascript:` / `file:` /
  `data:` / `blob:` / `mailto:` / 相对路径 / 空串）返回 null，`resultEntryOpenPlan()` 给出
  `{open:false, url:null, via:null, reason}` —— **不是"打开失败"，是连尝试都不做**（可在脚本里直接断言这一层）。
- **壳内**：`@tauri-apps/plugin-opener` 的 `openUrl`（交系统浏览器）。壳权限清单
  `src-tauri/capabilities/default.json` **只放行 `opener:allow-open-url` 且范围限 http/https**（没有 `opener:default`，
  因此也没有路径/邮件等其它 opener 能力）。壳里打不开只记日志，**不退回本窗口导航**（不把应用顶掉，同 Q224）。
- **浏览器里（降级）**：`window.open(url, "_blank", "noopener,noreferrer")`。这是**如实说明的降级**：地址栏由用户
  自己掌控，塔台拦不住用户手动改地址；两条路共同的硬边界只有"非 http(s) 一个都不打开"。
- 界面只对 `openable: true` 的条目渲染"打开入口"按钮 —— 即 `openable` 与 `reverify_due` **都有按钮**（超复核提醒阈值**不撤按钮**）；
  `failed`/`unknown` 的条目**结构上就没有按钮**。列表里另有一行"版本：…"显示 `revision_label`，`outdated` 时用琥珀色提示，
  但它**不改变**能不能打开（两条轴分开显示）。

### 19.6 组合口径

- **打开入口 ≠ 用户接受**：登记、读取、打开都不写任何 `audit.human_acceptance_recorded`；验收页区块与每任务文案
  都明写"打开入口不等于用户验收接受（§5.8）"，接受/退回仍然只在待验收区按 `role=user` 记。
- **没有入口 → "尚不可体验"**：任务级 `result_entry.kind=unavailable`，不渲染任何链接、不显示空壳成功。
- **失效入口 → 说明状态**：条目留在清单里并标明状态与原因，不静默消失。
- **纯后端可读场景**：`tasks[].readable_scenario` 的"输入"＝成果登记里**真实跑过的命令与退出码**，"期望"＝施工图的
  版本化验收检查项，"实际"＝**真实执行状态**，"证据"＝内容寻址证据清单里的真实条目（补修 F 追加了"成果登记里执行者
  自己交的证据"这一类引用）；**不用模拟输出冒充已运行**。

### 19.7 验证

`pnpm verify:v06-08-f`（`scripts/verify-v06-08-f.ts`，**76 PASS / 0 FAIL**）：纯口径 18 条 + 受控打开 3 条 + 路由/登记面
5 条 + 真起后端的登记→读取 29 条 + 塔台根文档首尾哈希 1 条 + **补修 F2/F3 新增第⑥段 19 条**（真后端子进程 + 真 stdio MCP
客户端 + 真 HTTP 读口：MCP 提交 → 持久化 → 验收读口显示 → 受控打开决策；`result_revision` 故意异于当前版本以验版本轴；
**SIGKILL 重启后再读、逐字段一致**；非法登记经 MCP 被收下但**读回来 500 `EVENT_INVALID`**，并逐级把非法值改合法证明 500 就是
那条登记造成的；旧调用不带该字段时事件 payload **键集合逐键相同**）。含"写入面按信封放行、闸门在读侧 → 读回 500」
的反例，与"用户真的记录一次接受之后入口清单**逐字不变**"的反向对照。

`pnpm verify:v06-08-f-ui`（`scripts/verify-v06-08-f-ui.py`，**35 PASS / 0 FAIL**，真浏览器）：用户**尚未验收**时入口已上屏、
**`reverify_due`（待重新验证）条目仍有打开按钮**、`failed`/`unknown` 条目没有按钮（结构上点不开）、页面上**不存在 `expired` 这一档**、
版本轴 `outdated`/`current` 两种逐条上屏且**版本过期不撤按钮**、概况把"能打开（含待重验）"与"当前打不开"分开数、
点"打开入口"真的走到 `window.open`（实参＝登记地址、带 `noopener,noreferrer`）、塔台页面没被导航走、
打开后仍是 pending 且后端只多 0 条验收事件。

### 19.8 已知边界与纠正入口（2026-09-20 独立审计 → 第二轮裁定后逐条处置）

**裁定口径（第二轮裁定 3）**：非法值在**两条写入路径统一拒绝**；历史坏记录**保留追溯**并**支持显式纠正**；两种版本来源**同权**，最新有效代码绑定优先，沿用"实际发生时间 + 同刻服务端序号"排序；V06-12 仍须**版本精确匹配且证据有效**，结果回报本身不等于检查通过；`null` **先扫描历史再明确迁移**，不能直接收紧导致历史项目整体 500。

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 非法值在**写侧**统一拒绝 | **已修** | `src/server/work/service.ts#submit()`（**唯一写出口**，成果登记与结果回报都经它）在写完命令校验后即用 `parseRuntimeEntries` 校验 `payload.runtime_entries`，非法**不落盘**；`null` 在写侧直接拒（写侧比读侧严）。读侧保留同一套校验——**历史坏记录仍会如实报 `EVENT_INVALID`**（可追溯，不静默丢） |
| **历史坏记录**的可追溯与纠正 | 可追溯**已有**；纠正**分两种** | ①**成果登记路径**：折叠按 `record_id` 覆盖 ⇒ 用**同一个 `record_id` 重报一条合法登记**即可纠正当场（原坏事件仍留在事件文件里可追溯）；②**结果回报路径**：入口来源是"每个事件各计"（F ⑤：不合并、不吞历史）⇒ 同 task 重报**不能**抹掉先前那条坏记录，**纠正机制未实现**，登记为**未关闭缺口**（已无新增来源：写侧已拒；且真实项目里该路径此前从未登记过入口） |
| 两条登记路径的**版本基准** | **已修（同权）** | `statusProjection.ts#latestCodeBindingRevision(records, events)`：候选同时来自成果登记 `binding.revision`（`revision_kind==="code"`）与结果回报 `payload.result_revision`，按"实际发生时间优先、同刻用服务端 `seq`"取最新 ⇒ **纯走 MCP 结果回报的项目不再恒 `unknown`**。V06-12 口径未动：检查仍须**版本精确匹配 + 证据有效**才生效（`checkEffectiveness` 一字未改；结果回报不是检查记录、给不了绿灯） |
| 历史里的显式 `null` | 读侧**暂时容忍**，写侧已拒 | **扫描结果**：塔台自身项目 `D:/tatai/.工作台/work/events.jsonl` **不存在**（自举项目未激活 v2 基线）⇒ 本地无 `null` 记录可迁；**三个真实项目的事件文件在仓库外，本轮未扫描**（不越界读用户数据）。命令（用户可自行跑或授权我跑）：`grep -c '"runtime_entries": *null' "<项目根>/.工作台/work/events.jsonl"`；**扫出 0 条之前不收紧读侧**，避免历史项目整体 500；扫出 0 条后可按"非数组即非法"统一收紧 |
| 读侧与前端 URL 判据 | **已收紧** | 读侧改成 `new URL()` + 协议白名单 + host 非空，与 `src/ui/result-entry.ts` **同一判据**（原来读侧只正则，`http://a b` 这类畸形串会被收下并计进"可打开的入口"，点却点不开） |
| `stale` 概况文案 | **已补** | 全都不开时也点名"另有 N 条绑定版本已不是当前版本" |
| 用户可见文案里的 `**` | 本轮新引入的 3 处**已删** | 状态标签／概况 note／任务一句话口径都是**纯文本渲染**，写 `**` 会原样上屏。既有代码里同类写法不少（属**历史风格问题**，不在本轮授权范围，登记备查） |

---

## 20. 现状更正（2026-09-21 收口第一包：登记面过期表述对账）

按 `src/server/work/types.ts#REGISTERED_EVENT_TYPES` 与 `verify-v06-09` ④-2 的当前断言口径，更正上文两处
现状表述（按本文档只追加惯例，原文各节逐字未动）：

- §9 题记"与三个模块各自的词表常量对齐"：登记面现为**七个**模块词表的并集
  （task/finding/audit/execution/requirement/change/budget；2026-09-20 V06-11 并入执行、T21 并入需求与
  变更批次、T23 并入项目预算约束），`verify-v06-09` ④-2 按七模块并集锁定。
- §13.2 题记"未并入 `types.ts#REGISTERED_EVENT_TYPES`……是否登记交父代理裁定"：**已并入**——
  V06-11 的 11 个执行事件类型逐个点名在登记面里（`verify-v06-09` ④-2 断言在册且无重复），
  上文"交父代理裁定"的待决表述由该次并入了结。
- §8.1 `task.definition_imported` 的 payload 栏：**自 2026-09-21 C-015 复核返修起**，canonical 写口
  （`submitDefinitionImports`）新产生的事件除原三键外**携带 `requirement_ids` / `definition_change_id`**
  （显式 null = 本定义如实声明"无引用"；键名与形态判定单源在 `src/server/work/references.ts`
  `DEFINITION_REQUIREMENT_IDS_KEY` / `DEFINITION_CHANGE_ID_KEY` / `readDefinitionReferencePayload`）。
  唯一写入服务 `WorkService.submit` 在追加前对**新形态**（任一键在）从同一 events 现场折出
  需求/变更投影，用与 canonical 预检、受检导入**同一份** `validateDefinitionReferences` 判据核验：
  悬空 `requirement_ids` / 悬空定义批次点名 id、`INVALID_COMMAND`、原子、零字节（PLAN 第 94 行
  C-015②"经 WorkService.submit 直接提交"那一半）；形态不合法（非数组/杂元素/非串批次）同样点名
  字段拒。**两键都不在 = 旧形态**（历史事件/旧调用方），服务一条都不查——校验只约束新写入，
  历史事件原样重放不回改（§2.5 旧数据与回放；历史悬空"重放不失败、投影标未通过现行校验"仍是
  另一条已知迁移轨，本次未动全局重放）。`types.ts#REGISTERED_EVENT_TYPES` 同条词表备注已同步；
  验证：`scripts/verify-c015-service.ts` ⑬-⑱（RED→GREEN 合同完整保存在该文件）。

---

## 21. 现状更正（2026-09-21 收口第二包 C016：派生蓝图权威来源）

按 DESIGN §4.1 / §12.1 第 16 项与 PLAN V06-05 下 2026-09-21 C016 登记的统一口径，更正批3 T22
留下的实现形态（按本文档只追加惯例，上文各节逐字未动）：

- **派生蓝图不再有直接编辑入口**。旧 `src/arch/blueprintEdit.ts`（remove/split/merge 纯编辑函数 +
  继承账重放 `reapplyEditLedger`）已删除；`src/arch/blueprintEditService.ts#applyBlueprintEdit`
  改为明确 fail-closed：任何入参返回 `status:"disabled"`，**不写 blueprint.json、不写
  blueprint-edit-receipt.json**。`rebuildBlueprint` 不再从旧 blueprint.json 携带/重放私有编辑账
  （carryEditLedger 已拆）：节点/边只由当前审定源确定性派生；旧 blueprint.json 里的
  `inheritance` / `affected` 字段仅作只读兼容解析（类型保留在 `src/arch/blueprint.ts`），
  不再是新图权威、不驱动结构变化——被旧私账"删"掉的源节点随重派生复活，合法删除只能在
  源修订后发生。HTTP/UI/MCP 没有也不新增 blueprint 编辑接线。
- **合法变更事实落唯一事实流**：新事件类型 `change.blueprint_inheritance_recorded`
  （实体前缀 `change:`，已并入 `types.ts#REGISTERED_EVENT_TYPES` 与
  `changes.ts#CHANGE_EVENT_TYPES`）。payload 七键闭合：`kind(remove/split/merge)`、
  `from_baseline`、`to_baseline`（均为 {baseline_id, design_revision, plan_revision} 哈希引用）、
  `predecessor_ids[]`、`successor_ids[]`（remove=0 / split≥1 / merge=恰 1，且与前任不重叠）、
  `affected_node_ids[]`、`reference_dispositions[]`（每项 predecessor_id/referenced_by/action
  (migrated|disposed)/to/note 五键闭合；migrated 的 to 必须在 successor_ids 里，disposed 的 to
  必须为 null；同前任同引用不重复）。缺键/多键/空白/重复一律拒。结构判据单一来源在
  `changes.ts#readBlueprintInheritancePayload`，折叠（`foldChanges`）、写命令
  （`recordBlueprintInheritance`）与 `WorkService.submit` 直连预检（assertEntityEventFoldable，
  change: 实体域）共用同一份——**直连写口提交结构非法的同类事件照样拒且零字节**，不会毒化投影。
  折叠层另拒：批次首条非 opened 的登记、对已关闭批次的登记。事实落进
  `ChangeState.blueprint_inheritance_records`（payload + recorded_by/recorded_at/event_id），
  可审查、可回放。
- **语义闸在 submit 前完成**：`src/arch/blueprintInheritance.ts#registerBlueprintInheritance`
  依次核验——入参闭键；结构判据；role 归一必须是设计授权角色（designer 类）；批次真实存在且
  未关闭；from 逐字段等于批次 target_baseline；from 基线在基线流水真实存在（拿得到不可变恢复
  位置）；to 就是当前生效基线；from≠to 且 from 在 to 的 supersedes 修订链上；当前权威源内容与
  生效基线一致；前任确实存在于从 from 基线不可变修订（recoverRevision，哈希校验）重建的 from 图；
  to 图（当前权威源确定性重派生）已形成预期结果（remove=前任不在；split=前任不在且继任全在；
  merge=应消失的前任不在且唯一继任在）——**事实不能凭空删/造节点**；有效任务（任务投影未取消，
  含 from 图上相邻牵连）与有效证据（source_ref 逐字命中、哈希自洽）对前任的引用全部有处置明细，
  缺一项/多一项整体拒，证据读不出 fail-closed 拒；批次授权范围逐字覆盖每个前任。
  任一不成立抛 `INVALID_COMMAND` 且 events.jsonl **零字节变化**。
- 已知限制（如实声明）：from/to 图核对中的代码模块与名称缓存只能取当前值（历史没有实现观察
  快照），前任/继任核对对设计章节/施工任务派生节点严格，对代码模块节点以当前解析为准；
  位置序节点 id（能力/模块）在章节插入/重排后换身份（V06-05 已登记），以任务卡号等源声明
  稳定键为目标的删除/拆并核对待遇最严。
- 验证：`pnpm verify:c016-blueprint-authority`（`scripts/verify-c016-blueprint-authority.ts`，
  **60 PASS / 0 FAIL**；RED→GREEN 合同与 RED 实录完整保存在该文件头部注释）；回归：
  `pnpm typecheck`、`verify:v06-05`、`verify:v06-05-e`、`verify:requirements`、`verify:c015-service`、
  `verify:m2` 全绿。旧 `scripts/verify-blueprint-edit*.ts`（未登记 package alias）为被否方案背书，
  已删除；历史审计输出（`.工作台/audit/**`）保留不改。
