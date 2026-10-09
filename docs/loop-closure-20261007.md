# 协作闭环细节契约（2026-10-07 批次 `change-20261007-loop-closure`）

> **状态：本批已开工；读模型与只读读口已实现（B2/V09-52）；候选代码及界面技术验证已完成，工作包证据提示已实现并经定向验证，正式安装待验证；人的体验与完整 token 未测。** 本文是 [DESIGN.md](../DESIGN.md) 正文新增条目的**细节契约**（字段、参数、错误码、判据与边界），不是第二本权威完成表，也不替代 PLAN 的卡定义与运行事实。功能清单声明区、稳定 check 键、唯一义务派生与只读读口（HTTP/MCP）**已落地**；**尚未实现/未测的部分**（正式安装、人的体验与完整 token 实测）仍以 PLAN 卡的真实证据与运行投影为准。
>
> 依据：已审方案 `<维护者核验目录>/tatai-loop-plan-20261007/implementation-v2/IMPLEMENTATION-PLAN.md`（Codex 复核定稿）与其覆盖索引 `COVERAGE.json`；纠偏事实见同目录 `COORDINATOR-REVIEW.md`。本轮为**文档与只读解析验证**：未改产品代码/真实账本、未登记需求、未导入任务定义、未激活基线、未提交 git、未代签任何用户 Gate。

## 1. 目标与范围（人话）

设计时看得出要做什么、有没有漏；换会话的 Agent 能接着干；交付时看得懂哪些功能已经验证可用。范围限定为**在既有事件账本与既有判据上加一层只读派生与两个只读读口**——不重建平台、不新建完成账本、不新建第七张图、不新建调度器。

## 2. 术语与稳定身份

**产品功能收敛为 7 项实际能力**（见 `CONTRACT.json` 的 `capabilities[]` 与 DESIGN §2.5.2）；18 条需求完整保留、各自映射卡。

| 名称 | 形态（拟议） | 口径 |
| --- | --- | --- |
| 需求 ID | `req-loop-<小写原 REQ 后缀>` | 只活在 requirement 的 `entity_id`；改措辞走 `requirement.updated`，**ID 不变**；**待经 `manage_requirement` 登记**，登记前引用属悬空（写入整次拒绝，§2.5 引用有效性） |
| 功能 ID | `cap-loop-<稳定键>`（**本批 7 个**） | 与既有 `plan:cap:*` **互不映射、互不涂绿**；改名不换 ID，拆并走既有变更机制 |
| 检查键 | `chk-<卡号小写>-<两位序号>`（如 `chk-v09-52-03`） | **已实现**；现行解析器同时识别稳定键与位置型身份，旧位置型记录经逐条定义绑定核对后显式映射（**不按位置套用旧通过**） |
| 检查旧身份映射 | 旧位置 ID → 稳定 `chk-*` | **冻结口径**：B2 落地「check 稳定键 + 定义指纹」后**重新审定**并**显式映射**旧位置身份，**绝不按位置/序号套用旧通过**；无映射即视为身份未知，旧证据标 `stale`/`unknown` |
| 集成检查键 | `int-loop-<能力后缀>-01` | 在 PLAN 的「集成检查要求」小节按**现行已有语法**声明（对象 ID = `cap-loop-*`）；改它＝施工图换版，旧证据过期 |
| 待归属行 | `item_id = pending:<requirement_id>` / `pending:<稳定来源定位符摘要>` | 不冒充正式功能身份；身份**不从中文标题重算**；与正式映射分栏 |
| 范围身份 | `scope_id` | **可解析形态（冻结）**：明确 `scope_id`（本批通常＝该功能自身 `cap-loop-ID`）或字面量 `null`；**不是「是/否」推断布尔**。未定 ⇒ `null` 且不给通过结论 |
| 范围版本 | `scope_revision` | 成员与检查定义的版本，随定义变化；与包版本 `package_revision` 分开读数 |
| 依据/缺口 review | `reviewer=<id>; ref=<...>; section_sha256=<...>; gap=<...>` | 只有 **reviewer 非空 ∧ ref 可定位 ∧ section_sha256 匹配 ∧ 基线批准** 才可判「已核对」；否则待审。`section_sha256` 只覆盖被引用功能章节，**不含声明表自身**（防自指） |
| 来源修订 | `source_revision:{ design, plan, ledger_last_seq }` | 版本一致性三要件，缺一即按「正在同步／数据已过期」处理 |

## 3. 功能清单声明区（DESIGN 侧正式源）

**为什么需要专门语法**：`requirement` 投影的 payload 是**闭键**（`source/problem/users/success_scenarios/exclusions/priority/status`，多一个都不收），没有位置放功能映射，塞进去会被 `INVALID_COMMAND` 拒。故正式源＝DESIGN 正文里的声明区，投影只做派生。

**声明区语法（已实现）**（见 DESIGN §2.5.1 的示例与 §2.5.2 的本批实例）：精确标题 + **完整八列表头**：

```
| 功能 ID | 人话功能名 | 需求 ID | 设计章节 | 本期范围（scope_id） | 覆盖结论 | 依据/缺口（review） | 使用结果与场景 |
```

**解析规则（B2 已落地）**：

1. 只识别**精确标题**（`/^#{4}\s*\d+(?:\.\d+)*\s+功能清单声明/`）之后的**第一张**完整表；**代码围栏（```）内的同形文本必须排除**（DESIGN 里就有一段语法示例，若不过滤会被误吸收）。
2. 表头八列齐全才吸收；缺列、重复功能 ID、悬空正式需求、章节无法定位**分别报错**（`SOURCE_INVALID`，点名行与原因）；**不靠任意三列相似就吸收普通表格**。「需求 ID」列可含**多个**需求（`、` 分隔）。
3. 「本期范围」列＝**明确 `scope_id` 或 `null`**（冻结形态）；`null` ⇒ 不给通过结论。
4. 「依据/缺口」列＝**review 键值段**（`; ` 分隔）：`reviewer=<审定人 id | 空>; ref=<项目相对路径#锚点 或 证据哈希>; section_sha256=<被覆盖章节 hash>; gap=<人话缺口>`；只有 reviewer 非空 ∧ ref 可定位 ∧ section_sha256 匹配 ∧ 基线批准 才可判「已核对」，否则待审——**草案不得自签**。`section_sha256` 算法见 DESIGN §2.5.1（只覆盖被引用功能章节，**不含声明表自身**，防自指）。
5. `覆盖结论=已核对` 只表示「该条已登记需求的设计语义已审查」，**不得**外推为整本设计绝对完整；也不能由引用存在、模型提案或设计被激活自动推断。
6. 缺项必须可见：派生输入以**已登记需求清单为起点**做全量对照，无映射的需求生成待归属行；只有设计而需求来源不清的功能标「来源待核对」；三类来源、未检查来源与解析错误**都进覆盖摘要计数**。覆盖摘要分栏给出 `examined_sources`／`unexamined_sources`／`registered_requirement_count`／`mapped_count`／`pending_count`／`source_complete`；`source_complete` 与分页 `paging.complete` **分开**，来源未读齐或已登记需求数为 0（空清单）时 `source_complete=false`、**不得标「完整」**。

**单源与可重建**：正式源 ＝ DESIGN 声明区（+ PLAN 功能映射 + 需求投影 + 事件账本 + 状态投影）；派生结果**删掉可重建**、不得手改。

## 4. PLAN 侧：功能→任务/检查/集成映射（新判据）

- **判据**：表头**同时含「功能 ID」「承接卡」**的表进**施工定义区**——改它改变施工定义哈希、被承接卡重新受检、**不产生执行事实**（与需求映射表同一族口径）。
- **现行口径（B2 已落地）**：`src/server/work/plan.ts#classifyPlanRegions` 已把「表头同含 功能 ID／承接卡」的功能映射表纳入**施工定义区**——改它改变施工定义哈希、被承接卡重新受检、**不产生执行事实**（与需求映射表同一族口径）。
- 现有**需求映射表**（表头同含「需求」「承接卡」）继续用于 `requirement_ids` 承接，本批 18 条 `req-loop-*` 按现行格式登记（见 PLAN「本批需求映射（2026-10-07 协作闭环）」）。

## 5. 四维读数

| 维度 | 取值 | 来源与判据 |
| --- | --- | --- |
| `design_coverage` | 缺失／部分／待审／已核对／源变待复核／无法判断 | 由**审定 DESIGN 声明行**复算；**引用存在 ≠ 已覆盖**、**模型提案 ≠ 已审定**、**设计被激活 ≠ 本需求已覆盖** |
| `implementation` | 无运行记录／未开始／进行中／结果已提交／阻塞／取消（＝既有 `ExecutionDimension` ∪ `no_run_record`） | 只用既有事件事实；**无任务 ⇒ 无运行记录（不写「未实现」）**；**提交 ≠ 已实现** |
| `verification` | 复用 canonical（`display_status` + `evidence_state` + 缺口逐条 + 有效版本 + 证据入口） | `statusProjection.ts` / `provenance.ts` 现有取值，**不另算一套** |
| `user_acceptance` | pending／accepted／rejected／**accepted_known_limit**（＝既有 `AcceptanceDimension`，**保留旧枚举**） | 既有 Gate；`pending` 不阻断「可请求验收」，阻断「已交付／已接受」 |
| `pending_decisions` | 问题/影响/建议/入口 | **另列**，不与四维混 |

**硬口径**：四维**可同时发生**（「有设计·已核对 + 无运行记录 + 未验证 + 待用户决定」是合法组合）；**绿色只取 `verification` 的对应范围**，且绿色仍按 DESIGN §4.2 六态口径（范围+版本+必需证据齐备+无未解阻断）；设计审定与用户接受**两个 Gate 不合并**。

## 6. 唯一义务/状态派生（`obligations.ts`）

```text
同一 revision 事实快照（events + 已批准定义 + 章节索引 + 图映射 + source_manifest 核验）
        ↓
deriveObligations(inputFacts)            // 唯一「义务/状态」派生入口（一次性读取与校验来源）
        ↓
factsSnapshot.obligations                // 只读结论
        ↓
投影：feature_item[]（功能视图） / work_package（任务视图） / 六图聚合 / UI（经只读 HTTP 读口）
```

- **投影之间互不读对方输出**（禁止 `coverageModel` 读 `workPackage`，反之亦然）；`buildWorkPackage(factsSnapshot, scope, role)` 只做选取与组织，不另判通过条件。
- 共享结构放 `src/shared/coverageTypes.ts`（**无 fs 依赖**，服务端与 UI 共用；UI 不导入带 fs 的服务端模块）。
- **零写入**：不新增事件类型、不新增持久缓存、不新增状态色系；派生结果可删除重建，**界面与模型都不涂色**。
- 输入缺口（任务引用或必需检查集合未定义完整）**不得按空集合「全通过」**，须生成明确动作。

## 7. 工作包（`work_package`）

- 顶层字段（已实现，**逐字沿已审方案 §4A**）：`scope_id`／`scope_revision`／`package_revision`／`baseline`／`task_id`／`task_revision`／`ownership`／`source_mode`（`direct_tatai`｜`coordinator_managed`）／`status`（**对象级** `DisplayStatus`）／`checks[]`／`completion`／`continuation`／`paging`。
- 逐项字段（已实现）：`checks[]` 每项含 `check_id`／`definition_fingerprint`／`requirement`／`required`／`independence_required`／`effective`（逐项有效口径：`passed`｜`failed`｜`missing`｜`stale`｜`unknown`｜`not_checked`｜`not_applicable`——**逐项不用 `DisplayStatus`，`DisplayStatus` 只作对象级主状态**）／`evidence_refs`／`verified_binding`／`changed_paths`／`uncovered`／`responsible_role`／`next_operation`（**对象** `{tool, operation, known_args, missing_args}`，缺什么参数点名列 `missing_args`）；`completion`＝`satisfied`/`remaining_checks`/`blocking_findings`，`continuation`＝`action_id`/`role`/`operation`/`reason`/`prerequisite`，`paging`＝`complete`/`cursor`。
- 「必需」与「独立复核必需」**分开**；缺口逐条点名，不合并成一句。
- **两种接续模式同形同判据**：`direct_tatai`（执行者直连塔台 MCP）与 `coordinator_managed`（协调者代转同形包、核验返回包并存证）。宿主不支持 ⇒ `unsupported`，**不回退写路由**。
- **旧客户端**：旧字段逐字保留可读，但该客户端**不具备完整接续能力**，不得据此声称已拿到完整工作包。
- **定义重排不按序号继承通过**：重排/改序号后须按 `definition_fingerprint`／稳定键重核。

## 8. 只读读口（HTTP + MCP 同判据）

```text
GET /api/projects/:id/feature-ledger          # 拟新增只读路由（项目级，同 status-projection 一族）
  scope=current|<scope_id>        缺省 current
  document=current|active|<revision>  缺省 active
  artifact_ref=<已登记产物引用>   可选
  expected_revision=<包版本>      可选；不符 ⇒ 409
  cursor=<opaque>                 分页游标（绑定 package_revision）
  limit=<1..200>                  缺省 50
200 { ok:true, ledger:{ state:"ok"|"not_derived", scope_id, scope_revision, package_revision,
      generated_at, source_revision:{design,plan,ledger_last_seq},
      coverage:{ examined_sources:[{ref,kind}], unexamined_sources:[{ref,kind,reason}],
                 registered_requirement_count, mapped_count, pending_count, source_complete },
      items:[feature_item], paging:{complete,cursor} } }
        ｜ { ok:true, ledger:{ state:"not_derived", reason, next_read } }
400 INVALID_INPUT ｜ 404 PROJECT_NOT_FOUND ｜ 409 REVISION_CHANGED ｜ 422 SOURCE_INVALID ｜ 503 SOURCE_UNAVAILABLE
只读红线：不写事件、不存证、不认领、不触发扫描、不因本路由自愈启动写服务；读失败不得返回空成功
完整性：paging.complete 只指本次请求范围分页已结束；来源是否读齐看 coverage.source_complete（两者分开）；
        源未读齐 / 已登记需求数为 0 / mapped+pending≠registered ⇒ source_complete=false，不得报「完整」；
        422/503 必须带失败来源与重试入口，不得返回 200 空 items 冒充成功
```

- **MCP**：拟名只读工具 `feature_ledger`，同义参数与错误语义，**共用同一份派生**；宿主不支持 ⇒ `unsupported`。
- **登记**：远程路由表按**只读**登记（沿用既有远程授权规则，**不新增授权模式**）。
- **分页与完整性（分开）**：`paging.complete` 只表示**本次请求范围的分页已结束**；来源是否读齐看 `coverage.source_complete`，两者**分开**。`source_complete=false`（有 `unexamined_sources`、或 `registered_requirement_count=0` 的空清单、或 `mapped+pending≠registered`）时**不得把 items 报成完整清单、不得报「完整」**。
- **失败不得伪空成功**：`422 SOURCE_INVALID`／`503 SOURCE_UNAVAILABLE` 必须**带失败来源与重试入口**，**不得返回 200 空 items 冒充成功**；`state=not_derived` 只用于「定义尚未派生」并必带 `reason`＋`next_read`，**不等于空项目**。
- **可点击设计章节**：每个 `feature_item` 带 `design_section_refs`（标题／行号／锚点／章节 hash，§3）；源变使 hash 不符 ⇒ `design_coverage=源变待复核`，历史结论保留（DESIGN §5.6）。
- **计数影响**：新增 MCP 工具会改变工具计数与清单 ⇒ 按既有「恰好」口径**逐个点名**更新（`scripts/verify-u2.ts`、`scripts/verify-m2.ts`、`scripts/verify-v09-05.ts`、`README.md`、`docs/capabilities.md`）；计数以注册表对账为准。
- **不整本灌 Agent**：读口返回结构化清单与缺口；章节定位只作绑定与读回起点（不等于已读、不等于已通过）。

## 9. 完成、退出、重入与幂等

- **逐项采信**：逐项缺失／错 check ID／错定义版本／源绑定与角色不符 ⇒ **不采信**；`exit_code=0` 只对声明了 `command` 的机械检查生效，**不当整卡通过**。
- **复审终结**：当前审计有效且必需检查全覆盖 ⇒ **不再列复审候选**；coordinator 与 auditor **两个分支都要覆盖**（现行两分支都缺该终止规则）。
- **重入**：返工经**受控重开**（新 attempt，绑当前定义与基线）；旧提交与旧证据**只读可查、不被覆盖**；旧认领 token 作废。
- **幂等**：同一事实重复读取返回**同一动作、不追加事件**；同幂等键重复提交返回**原回执**；键同内容异明确拒绝。
- **有界复验**：相关源变 ⇒ **恰一个**可识别复验动作；无关源变不连坐；失败持续阻断、修复不自行关闭、有效复验后恢复并**保留旧判词**。

## 10. 版本与范围

正文、清单与图必须绑定**同一**设计/范围/产物选择；不同修订先显示「正在同步／数据已过期」并给重读入口，**不混成一个当前结论**；历史文档只能关联**当时可取回**的映射与证据，无法重建 ⇒ 显示「历史状态未知」，**不套当前通过结论**；游标绑定 `package_revision`，版本变 ⇒ 旧游标失效（不静默返回跨版本数据）。

## 11. 人的验收与 token 验收

- **可用性实验**（可由无项目技术背景的测试人做）：正确说出目标／可信进度／可体验结果／未验证范围／需自己判断的事；区分「有设计／缺设计」与「已提交／待验证／已验证」；指出当前版本并解释历史通过项为何「待复验」；新需求去向可追；**无颜色仍可辨**；待用户决定项不妨碍已授权技术工作；不强迫用户读全部设计。
- **最终 Gate 归项目主人本人**；可用性实验只发现可用性问题，**Agent 一律不代签**。
- **三条真实路径**（无前序聊天的新会话执行）：两 Agent 接力（连读三次不重复派审/记账）／失败返工（阻断与恢复保留旧判词）／源变复验（恰一个动作、无关源不连坐）。
- **token 验收**：先做**计量预检**（`src/server/work/usage.ts` 的 `TOKEN_UNMEASURED` 明载执行端回执没有可核对 token 来源）→ 拿不到真实 usage ⇒ **标「未测」**，不用字符数/调用次数冒充，不建长期平台。**B1 开工前**冻结旧版可复现快照；冻结条件（同快照/同模型路由/同接入配置与权限/同验收强度）与通过判据**事前写入证据文件**；三旅程（冷接手／换会话继续／源变复验）各 ≥3 对同质量样本，输入输出分列、缓存命中单列并说明归属、失败与补救计入、人工时间不折 token；配对中位数小于零且多数下降才报告该场景**观察到**节省，三场景均满足才概括**本次实测范围内**的节省（不承诺百分比、不推广未测模型）。

## 12. 交互确定行为（摘要）

点击原文锚点（精确章节；定位不到 ⇒ `unresolved` + 原始引用，不猜）／反向定位（无对应显示「待归属」）／切换设计版本（草稿·基线·历史三档，历史只读）／编辑后刷新与失效（相关功能「待复验」、旧结论保留、无关文件不连坐；共享模块命中本范围仍须复验）／无设计（「缺设计·待补」+ 提需求入口，不隐藏）／无映射（「待归属」，不由模型补造需求）／读取失败（「读取失败·未知」+ 重试；空数据不渲染为完成）／模型降级（显示降级与原因，不当恢复绿的必要条件）／窄窗（收为可展开，异常与待决项默认可见，详情不吃掉主区）／切项目（不串数据、不串草稿）。完整表见 DESIGN §3.5。

## 13. 迁移、发布与回滚

历史缺口**逐条登记去向**（补登记／重验范围／修复复测／未开始保持未开始／设计角色补映射），**不逐方块手改色、不为减少红色删项**；试点＝V09-40／V09-44／一张真实 `stale` 卡（**不预定必须变绿**）；源码／随包后端／前端／桌面壳／MCP **版本一致后**才做发布验收，**未实际安装不得写通过**；回滚能读新旧记录、保留原始事件、不手工删账、旧程序面对新格式应拒写。夹具写域先核（`scripts/lib/fixtures.ts`：`resolveDataDir()` + `REPO_ROOT` 自注册 + `TATAI_REAL_IDS`，SKIP 必须显式 exit 3）。

## 14. 批次、卡、需求与功能映射

**产品功能收敛为 7 项实际能力**；18 条需求完整保留、各自映射卡（逐条见下）。卡号分配／正规化／不编造／不早宣／token／发布回滚等**不是独立产品功能**，作质量或交付约束挂到对应能力上。

| 方案批次 | 拟承接卡 | 主要需求（拟登记） | 涉及的能力（拟定） | 依赖 |
| --- | --- | --- | --- | --- |
| B1 契约冻结与正规化 | V09-51 | req-loop-normalize／req-loop-card-id／req-loop-cover-table／req-loop-supplement-path／req-loop-low-burden／req-loop-no-fabricate | 能力 6（补充路径）＋能力 3/4 的交付约束 | 无 |
| B2 功能清单契约与唯一义务派生 | V09-52 | req-loop-human-list／req-loop-cover-indep／req-loop-status-sep／req-loop-low-burden／req-loop-no-fabricate | 能力 1（清单与覆盖）＋能力 2（四维） | V09-51 |
| B3 工作包逐项化与两种接续模式 | V09-53 | req-loop-agent-handoff／req-loop-flow／req-loop-low-burden／req-loop-no-fabricate | 能力 3（逐项交接）＋能力 4（闭环） | V09-52 |
| B4 验证回报闭合、复审终结、有界复验 | V09-54 | req-loop-green-def／req-loop-agent-handoff／req-loop-flow／req-loop-src-change／req-loop-low-burden／req-loop-no-fabricate | 能力 4（闭环）＋能力 5（源变复验） | V09-53 |
| B5 六图同源聚合与版本读数统一 | V09-55 | req-loop-status-sep／req-loop-green-def／req-loop-low-burden／req-loop-no-fabricate | 能力 2（四维/同范围绿色） | V09-52 |
| B6 人话功能清单 UI 与交互确定性 | V09-56 | req-loop-human-list／req-loop-status-sep／req-loop-flow／req-loop-interaction／req-loop-supplement-path／req-loop-human-accept／req-loop-low-burden／req-loop-no-fabricate | 能力 1、2、4、6、7 | V09-52、V09-55 |
| B7 试点迁移与发布/回滚 | V09-57 | req-loop-release-rollback／req-loop-low-burden／req-loop-no-fabricate | 能力 7 的交付约束 | V09-51…V09-56 |
| B8 真实验收（人的可用性＋token＋两 Agent 接力） | V09-58 | req-loop-human-accept／req-loop-token-measure／req-loop-no-early-claim／req-loop-flow／req-loop-low-burden／req-loop-no-fabricate | 能力 7（人验收结果可见） | V09-51…V09-57 |

**能力→需求（7 项实际能力；完整见 `CONTRACT.json` 的 `capabilities[]` 与 DESIGN §2.5.2）**：

| 能力 ID | 人话名 | 需求 |
| --- | --- | --- |
| cap-loop-feature-list | 设计书旁的人话功能清单与设计覆盖对照 | req-loop-human-list、req-loop-cover-indep、req-loop-cover-table、req-loop-interaction |
| cap-loop-four-dim-readout | 四维读数分开、绿色只按本范围验证 | req-loop-status-sep、req-loop-green-def、req-loop-no-fabricate |
| cap-loop-handoff-package | 逐项交接包（check 级材料与下一动作） | req-loop-agent-handoff、req-loop-card-id、req-loop-low-burden |
| cap-loop-flow-loop | 提交→复验→下一动作的接续闭环 | req-loop-flow、req-loop-normalize、req-loop-low-burden |
| cap-loop-source-change-reverify | 源变复验（按界，恰一个动作） | req-loop-src-change、req-loop-low-burden |
| cap-loop-supplement-path | 用户补充设计路径 | req-loop-supplement-path、req-loop-normalize、req-loop-card-id |
| cap-loop-human-accept | 人的验收结果可见 | req-loop-human-accept、req-loop-no-early-claim、req-loop-token-measure、req-loop-release-rollback |

**依赖无环**（已由真实只读解析实测）：`V09-51→V09-52→V09-53→V09-54`、`V09-52→V09-55→V09-56`、`V09-51…V09-56→V09-57→V09-58`。契约冻结后 V09-53／V09-55 的独立写域可并行开发，**集成仍须前置满足**；共享文件（`entry.ts`／`service.ts`／`src/server/index.ts`）由**单一集成者串行**。

## 15. 现行解析器边界与机械影响（本轮实测）

- **首表卡行 78 → 86**（纯插入 8 行；`parsePlanTable`／`validatePlanTasks`／`importTaskDefinitions`／`validateTaskDefinitions` 全部 0 问题）⇒ `pnpm verify:v06-02` 的行数点名断言须定向更新为 **86**。
- **PLAN 前缀钉值**（`verify:v09-03` ④，算法：行尾归一 LF 后取 `\n---\n\n### 需求映射（V09-03 追加` 之前）：`6d39e2ba… → a02207e5…`，判据仍为「剥离后逐字节恒等」（既有卡行/勾选位零改动）。
- **设计定义哈希**（`documents.ts#designDefinitionText`，附录 B 之前）：`4c31a01e… → d25f554c…`（定义段 77,405 → 99,056 字符）；设计内容哈希 `81bfc20f… → d06f9b38…` ⇒ 按 DESIGN §5.6 做一次影响分析并由获授权设计/协调角色重激活基线（**设计稿阶段不激活**）。
- **未导入前** `pnpm verify:des-current` ⑮「每张卡都在运行中台账」会新增本批 **8** 项缺卡；加上此前 **11** 项，导入前共 **19** 项，本批导入后仍有原有 **11** 项待 B7 核对；导入须**先完成 18 条需求登记**（否则悬空需求引用会被 `references.ts` 拒）。
- **`verify:des-current` ⑧**（正文 § 引用与本地链接可解析）：候选实测悬空 § 引用 0、断链 0（本文档在 DESIGN 中只以行内代码引用，不做链接，避免细节文档未同批落地时断链）。
- **行尾**：DESIGN/PLAN 原文是混合行尾（正文多为 CRLF，最近几批新增区为 LF）。本轮新增块沿用**与最近几批一致**的 LF 行尾，未改动任何既有行的行尾；一次编辑误产生的**孤立 CR 已修复**（实测孤立 CR 计数 0）。
- **未跑**任何会写真实库的 `verify:*`；实测输出见 `evidence/parse-candidates.txt`（含 exit code）。

## 16. 起草时点的未做与未知（历史记录）

- **未做**：未实现任何代码；未登记需求（`REGISTER-INPUTS.json` 只准备不调用）；未导入任务定义；未激活基线；未跑 `verify:*` 写库脚本；未做迁移清单；未做 token 实测；未做人的可用性观察；未改 `templates/agents-md-snippet.md` 与 `src/server/attachAgentsMd.ts`（MCP 接续规则块由产品生成，本批把规则写进 AGENTS 正文，**产品文件改动留给实现批次**）。
- **未知/待定**：V09-51…V09-58 的实际编号分配（正式接续时确认）；两项目历史缺口的逐条去向（B7 清单确定）；token 实测数值（未测）；`plan:cap:*` 存量 ID 与 `cap-loop-*` 的别名边界（另一次设计裁定）；功能清单「提取覆盖」的完整度（显式披露，**不声称绝对完整**）。

## Codex 本轮技术审定与试用顺序

用户最新明确由 Codex 验收技术交付后、用户再试用。V09-56 验证界面信息与真实浏览器行为；真实人的理解观察留在 V09-58，最终体验 Gate 由用户本人决定。技术候选版可在技术验收后交付试用；这不表示人的可用性或全流程 token 收益已经通过。cap-loop-human-accept 的技术判据是正确呈现接受/退回等事实，不能以用户已经接受作为软件能力变绿的前提。全部产品目标的最终结论仍需如实列出未完成观察。

B1 独立复核更正：§15 读数已按实际设计哈希核正；缺卡为旧 11 项加本批 8 项，不隐去旧缺口。18 条需求和八卡现已通过唯一宿主登记，技术基线已激活；§16 保留起草时点记录。旧正文未删，PLAN/README 的段尾补句在行级 diff 中可表现为替换，不能把“零删历史”误表述为所有 diff 块只能纯插入。


### 工作包证据指引的兼容扩展

`next_operation` 可带只读 `prerequisites`／`guidance`，说明覆盖源清单与证据哈希/源码指纹的回填、机械和非机械检查的条件、独审读序与五维覆盖。这些字段不是工具参数，不放进 `known_args`；不代做验证、不预填结论。具体契约见 DESIGN §2.7。
