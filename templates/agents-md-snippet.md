<!-- tatai-mcp:start -->
> 本目录接了塔台（Tatai）工作台 MCP，干活时汇报状态。

接续规则（DESIGN §6.2 / §6.7；角色不绑定模型）：

1. `select_project` 对准项目，优先 `task_brief`（旧连接未提供则 `project_entry`）。如实传 `role`、`client_capabilities`；未声明能力按只读处理。入口只读，不代认领、不启动 Agent；**不存在的工具不能用说明文本假装调用成功**（§6.6）。
2. 按当前任务的 `required_reads` 读原文：阶段材料按 `path` 与 `range`（标题+子树的起止行，现读现算，插入章节外的行不影响）读原文；带 `section` 时它是**绑定定位**（§6.9），**不直接把它当 `read_design`/`read_plan` 的 `section` 参数转传**。条目带 `purpose` 分类（`required_content` 先读正文／`trace_reference` 按需回读／`resume_context` 续接现场）；设计引用派生条目另带 `resolution`／`source_ref`：`unresolved` 表示该条依据现在定位不到（**不是已读、不是已通过**），按 `source_ref` 用 `read_design(index=true)` 或按 `range` 补取核实，**不得用近似标题顶替**。`read_plan(task_id=…)` 取卡。简报默认摘要，不代表已读完整理由；必要时按返回索引/版本补取（detail=reason），detail=full 取完整简报。状态未变且无新动作不重复拉取；有 range 时不默认整篇读取。简报未返回的内容不算读过。账本和基线文件是追溯入口，不要求每轮全文读入；历史交接按需查，当前任务不默认重读全部历史。
3. 按 `next_action`（resume_task / claim_task / review_result / await_role / await_decision / blocked / complete）执行。`claim_task` 带 `expected_revision` 原子领取；按允许范围开发、自检、独立复核，`submit_task_result` 带真实证据/版本/认领回报，然后再取下一步。提交前可用**只读预检** `preflight_task_result`（与 `submit_task_result` 同形输入）一次列清可预判缺项与锁内未查项；它**不写任何字节、不是门禁/通行票**，不替代提交时的锁内重核，宿主不支持时明确 `UNSUPPORTED_BY_HOST`、**绝不回退**成写入。已有授权内连续推进，不逐卡问续。
4. 按完整可验收功能批次派工；共享文件由一个协调者集成，独立写域可并行。没有相关变化的有效证据复用；新增检查对应变化、失败或未证风险。辅助提交工具的自验不额外变成产品验收门；同因两次不收敛先查根因。
5. 状态以 v2 事件账本为准。`report_task_status` 的 v2 状态上报须版本/认领/持有者；done 用 `submit_task_result`，blocked 须说明，ready 须协调者与可取回依据。旧 v1 `tasks.json`/模块四色只作 **v1 兼容读数**、不得当现行状态；模块状态由 v2 证据派生、派生不到就如实「**无状态记录**」，不要自己给模块涂色。结果提交、自检、独立审计、用户 Gate 分开，**不把「可请求验收」读成「已交付」**，Agent 不代用户验收。
6. 执行现场用 `report_execution`；心跳缺失/租约过期不证明进程已停（**租约到期只表示「当前所有权需核实」，不证明旧进程已停止**），恢复前核实所有权和工作目录。`record_work_evidence` 存证/自检/独审/复测经唯一宿主（证据正文不可变、内容寻址，stdio 进程不自己写项目目录）；独审者≠作者，**不接受 `role=user` 代签用户 Gate**。实际未跑的验证不得写通过。
7. 验证绑定有限、完整的 `source_manifest`（覆盖所验行为依赖的源码/配置/迁移）；用宿主返回的指纹作 `binding.revision` 并引用证据。覆盖源改变须重验，无关源变化不机械重验；Git HEAD 或自报哈希不能代替实际源清单。
8. 同步契约由协调者先登记 `register_sync_contract`，执行者交 evidence 包，宿主 `scan_sync_evidence` 核验。阻断看当前入口/`read_sync_status`，不拿旧绿放行，不删必需项、自动刷新漂移哈希或伪造通过。阶段指针是派生导航，不是新授权；来源变化须核实后生成。
9. 先用 `project_index` read/impact 按当前任务或路径查说明，按需回读来源；空索引≠无影响。改后用唯一宿主 CAS upsert/remove 更新受影响条目，不预建全仓说明；**不许只刷新哈希假装维护**，**无写能力不得声称已写**。说明为待审层，不替代设计与证据。
10. 架构判断/影响分析前取 `get_project_graphs mode=full`，按同快照游标取齐；普通接续不重复取六图。完整分页不等于源码全覆盖，检查 collection/notes；静态 import 不是业务数据流，模型线索不是正式设计。用 `expand_module` 按需下钻。
11. 有效设计/施工基线变更按授权由 `manage_baseline` read→preserve/activate，保留旧依据，不因实现偏离自动反改设计。`activate` 走固定 `delegated_technical_review`：须带两份源当前 `expected` 哈希与 `approved_by`/`approval_basis`、零差异、不调模型、不写用户 Gate。旧 `known_revision` 先重读；不把工具存在当成自动执行能力。`ask_flash` 会调模型且可能写补全线索，不视为纯只读。
<!-- tatai-mcp:end -->
