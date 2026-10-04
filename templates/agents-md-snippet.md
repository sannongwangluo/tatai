<!-- tatai-mcp:start -->
> 本目录接了塔台（Tatai）工作台 MCP，干活时汇报状态。

进项目先取接续入口（DESIGN.md §6.2 / §6.7）：

- 先 `select_project` 对准项目，再调 `project_entry`（入参 `project_id` / `role` / `client_capabilities` / `known_revision` / `resume_hint`）拿**只读交接**：有效基线、上下文清单、未结束 run、下一动作（`resume_task`/`claim_task`/`review_result`/`await_role`/`await_decision`/`blocked`/`complete`）、理由与必读原文。它只读，不会替你认领，也不会替你调模型。
- **项目说明按需取材**（不要求先建齐全仓说明才接续）：取完 `select_project` / `project_entry` 后，用 `project_index` 的 `op=read` / `op=impact` 按**当前任务**的 `path`（或 `task_id`）取相关条目与来源状态，命中的条目**按需回读** `sources[].path` 原文。**空索引、查不到都不等于无影响**（缺少说明 ≠ 无耦合）；来源 `stale`/`missing`/`unreadable`/`unknown` 时**以实际源码为准**、不拿旧说明下结论。它是 Agent 后补的**待审说明层**，不是设计/事件/验收事实。
- **改完代码要维护说明（闭环）**：完成代码变更后，按**改动路径**与实际**调用/约束**影响，经 `project_index` **唯一写入宿主** `upsert`/`remove` 增量更新**受影响**条目（**保持 `id` 不变**），不重写无关条目、也**不因缺索引被迫全仓预建**。写前用 `project_index` `op=read` 取 `notes_file.version_sha256` 作 `expected_file_sha256`；先**读过并核实来源语义**再重算 `sources[].sha256`——**不许只刷新哈希假装维护**；遇冲突**重读当前文件、合并本次增量再重试**；写后**读回核对**。**无写能力不得声称已写**：把本次说明更新/遗漏/未解决项交接给有权维护者。
- **六图别靠读代码猜**（2026-09-26 V09-19）：接续入口 `project_entry` 的 `graph_summary` 给六图各一行的计数与状态、同一快照标识、基线/更新时间、更新中或过期状态与原因、异常与下一读取入口；完整状态用 `get_project_graphs` 一次取全（四档：全部六图／`graph=<六图之一>`／`node_id=…`／`relation_id=…`；逐对象带状态键、界面短标与颜色口径、来源、映射、证据状态、有效版本、阻断原因、用户待验；模型待审线索单列，不混进正式节点/关系）。没有图或图更新中/失败/过期时，它如实给状态与原因——**不许**把静态 import 依赖读成业务数据流，也不许把「可请求验收」读成「已交付」。**架构判断/影响分析前先 `get_project_graphs mode=full` 按同一快照游标逐图取齐**（`complete:true` 只表示图对象取完，不等于源码全覆盖；采集残缺／忽略目录／旧聚合桶看各图 `notes` 与顶层 `anomalies`）。技术图节点看 `origin_layer`／`counts.by_origin` 区分代码模块与规划层对象，**别把节点总数当代码模块数**（塔台实测 80 节点＝8 代码模块＋72 规划对象＋0 聊天补全）。
- **阶段 / 提交 / 执行 / 证据是分开的四件事**（V09-27，契约 F3）：
  - 阶段自报 `report_task_status`：v2 带 `expected_revision` + 当前 `claim_token` 报 `doing`（执行中）/ `blocked`（带 `reason`）；`ready` 解阻**协调器专用**且必须给可取回的 `readiness_basis`（项目内相对路径/`event:<id>`/64 位证据哈希）。**`done` 不在这里写**——完成走 `submit_task_result`（带证据/认领/版本五查），它只表示「执行者已交结果」，不等于审计通过或人工验收接受。
  - 执行回执 `report_execution`：`op=start_requested/started/heartbeat/checkpoint/stop_requested/stopped/failed/delivered/effect_*`；每次带 `run_id`/`attempt_id`/`workspace`/`claim_token`。**心跳缺失不等于停机**，只有带确认依据（`confirmation`）的 `stopped` 才算已停。
  - 证据与审计 `record_work_evidence`：`op=store/read/submission/self_check/independent_audit/fix/retest/finding`；证据正文经**唯一写服务宿主**落盘（不可变、内容寻址，stdio 进程不自己写项目目录）。作者自检 ≠ 独立审计（审计者须≠作者）；**不暴露人工验收/用户接受风险**，也不接受 `role=user` 代签用户 Gate。
- **正向成套图纸入口**（V09-28）：`manage_baseline` `op=read`（只读两份源与生效基线，零副作用）→ `op=preserve`（存不可变历史）／`op=activate`（用**已有**图纸做技术审定激活：固定 `delegated_technical_review`，须带两份源当前 `expected` 内容哈希与 `approved_by`/`approval_basis`，零差异、不调模型、不写用户 Gate）。
- 照 `next_action` 干活：`claim_task`（带 `expected_revision` 的原子领取，冲突会被拒）→ 按返回的允许范围执行 → 核实 → `submit_task_result`（重新校验任务版本/依赖/认领 token/证据）→ 再调 `project_entry` 取下一项。既有授权内不必等人逐卡说继续。
- 能力如实声明：`client_capabilities` 不声明就按「仅可读取」处理——只读客户端只拿读取与明确的接续指令，不假装能自动执行。MCP 提供工具不等于客户端必然主动调用（§6.2）。
- **任务状态的事实源是 v2 事件账本**：`read_progress` 里的模块四色是 v1 兼容读数，不得当现行状态；模块状态由 v2 证据派生，派生不到就如实「无状态记录」，不要自己给模块涂色。拿不准现状时回 `project_entry` 或 `list_tasks` 查，再报，不瞎报。
- **来源可信度**（V09-29，契约 F4）：用于「已验证」的检查应绑定**有限、项目内、可取回**的源文件清单（`record_work_evidence` 的 `source_manifest`）：先 `op=store, kind=source_manifest`，取回 `evidence.source_manifest.fingerprint`；再用这个指纹作为自检/独审的 `binding.revision`（`revision_kind=code`），并在检查项引用该回执的 `evidence.sha256`。不要把旧自报修订或 Git HEAD 代替清单指纹。现读复核时覆盖的源码变了/删了 → 旧绿转**待验证**，取不到内容 → **未知待复核**，没被覆盖的无关文件变化不影响。可见工作面默认 **5 秒对账**，刷新失败显示陈旧横幅 + 原因 + 最近成功时间。
- 旧版先重读有效基线：`known_revision` 落后于当前版本时，塔台不派新任务。租约到期只表示"当前所有权需核实"，不证明旧进程已停止。
- 未迁移项目继续用现有接口与交接包（§6.6）：按项目实际格式与能力发现选择接口，不存在的工具不能用说明文本假装调用成功；`ask_flash` 会调用模型且可写图补全层，不是保证无副作用的只读工具。
<!-- tatai-mcp:end -->
