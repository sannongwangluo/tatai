<!-- tatai-mcp:start -->
> 本目录接了塔台（Tatai）工作台 MCP，干活时汇报状态。

进项目先取接续入口（DESIGN.md §6.2 / §6.7）：

- 先 `select_project` 对准项目，再调 `project_entry`（入参 `project_id` / `role` / `client_capabilities` / `known_revision` / `resume_hint`）拿**只读交接**：有效基线、上下文清单、未结束 run、下一动作（`resume_task`/`claim_task`/`review_result`/`await_role`/`await_decision`/`blocked`/`complete`）、理由与必读原文。它只读，不会替你认领，也不会替你调模型。
- **六图别靠读代码猜**（2026-09-26 V09-19）：接续入口 `project_entry` 的 `graph_summary` 给六图各一行的计数与状态、同一快照标识、基线/更新时间、更新中或过期状态与原因、异常与下一读取入口；完整状态用 `get_project_graphs` 一次取全（四档：全部六图／`graph=<六图之一>`／`node_id=…`／`relation_id=…`；逐对象带状态键、界面短标与颜色口径、来源、映射、证据状态、有效版本、阻断原因、用户待验；模型待审线索单列，不混进正式节点/关系）。没有图或图更新中/失败/过期时，它如实给状态与原因——**不许**把静态 import 依赖读成业务数据流，也不许把「可请求验收」读成「已交付」。
- 照 `next_action` 干活：`claim_task`（带 `expected_revision` 的原子领取，冲突会被拒）→ 按返回的允许范围执行 → 核实 → `submit_task_result`（重新校验任务版本/依赖/认领 token/证据）→ 再调 `project_entry` 取下一项。既有授权内不必等人逐卡说继续。
- 能力如实声明：`client_capabilities` 不声明就按「仅可读取」处理——只读客户端只拿读取与明确的接续指令，不假装能自动执行。MCP 提供工具不等于客户端必然主动调用（§6.2）。
- 开工、完工、卡住时调 `report_task_status`（入参 `project_id` / `task_id` / `status`，四值 todo/doing/done/blocked；可带 `title`/`module_id`/`reporter`/`note`）自报任务状态。**任务状态的事实源是 v2 事件账本**：`read_progress` 里的模块四色是 v1 兼容读数，不得当现行状态；模块状态由 v2 证据派生，派生不到就如实「无状态记录」，不要自己给模块涂色。拿不准现状时回 `project_entry` 或 `list_tasks` 查，再报，不瞎报。
- `done` 只表明这张卡的执行结果已交付，不等于整个项目完成、不等于独立审计通过、也不等于用户 Gate 接受。
- 旧版先重读有效基线：`known_revision` 落后于当前版本时，塔台不派新任务。租约到期只表示"当前所有权需核实"，不证明旧进程已停止。
- 未迁移项目继续用现有接口与交接包（§6.6）：按项目实际格式与能力发现选择接口，不存在的工具不能用说明文本假装调用成功；`ask_flash` 会调用模型且可写图补全层，不是保证无副作用的只读工具。
<!-- tatai-mcp:end -->
