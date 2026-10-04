# 持久项目说明索引与交接覆盖（project_index）协议

> 依据：DESIGN.md §6.8；docs/unified-optimization-contract.md U5／U5.1；PLAN V09-39。本文只写**当前实现**的对外协议与判据；实现与验证状态以 PLAN、统一证据根为准，本文不等于已经上线。

## 1. 定位

`project_index` 维护一份**Agent 编写的项目说明文档** `docs/project-notes.json`（项目根内相对路径）。它是**待审说明层**，不是设计、不是事件、不是验收事实：

- 它是**可重建的导航索引**，不是新设计权威；不改六图颜色/状态、不写用户 Gate。
- 不存在时是**明确空索引**：**不能据此推断「没有影响」**（缺少说明 ≠ 无耦合）。
- 项目已有**异 schema** 同名文档时明确冲突，**不可覆盖**、也不按本 schema 解析。

## 2. 文档 schema

顶层**严格闭键**（只允许下列三个键，多一个即拒）：

```json
{
  "schema_version": 1,
  "doc": "project-notes",
  "notes": [ /* ProjectNote[] */ ]
}
```

`notes[]` 每条（闭键）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string（必填） | 稳定身份；全库唯一，重复即拒 |
| `responsibility` | string | 职责（干什么） |
| `paths` | string[] | 受管文件/模块的项目根内相对路径（按路径检索用） |
| `interfaces` | string[] | 对外接口 |
| `constraints` | string[] | 约束 |
| `relations` | `{to,kind?,note?}[]` | 关系声明（`to` 是另一条 `id`） |
| `sources` | `{path,sha256}[]` | **有限**来源：路径 + **完整 SHA256**（64 位小写十六进制） |
| `task_ids` | string[] | 关联卡号 |
| `tests` | string[] | 关联测试入口 |
| `evidence_refs` | string[] | 关联已有证据引用 |
| `declared_by` | string\|null | 声明者 |

示例见 `templates/project-notes.example.json`。

## 3. 判据（写）

- **增量**：`upsert` 只替换数组里给出的条目（按 `id`），其它条目语义**不重写**；`remove` 只删指定 `id` 的**说明**，**不删源文件/业务证据**。
- **CAS**：`expected_file_sha256` 必须是**当前文件内容**的 sha256（文件不存在用 `null`）；不符即 `VERSION_CONFLICT`，不写。`withFileLock` 锁内核对 + 临时文件 rename 原子落盘。
- **来源当前完整 hash 校验**：写下时现读每个 `sources[].path` 的当前内容，必须与声明的 `sha256` 相符；读不到/越界/软链/junction/超限/凭据路径一律拒。`sha256` **不许编造**（不是登记时自报、也不是 mtime/size 能代替的）。
- **拒收**：未知字段、重复 `id`、超条目数/超字节/超长、路径含 `..`/绝对/盘符/UNC/NUL、**最终或中间段 junction/软链逃逸**、凭据与忽略目录路径。
- **路径迁移**：保持 `id` 的**显式 upsert**（改 `paths`），**不凭同名猜测**。
- **Agent 声明默认待审**：条目自带 `evidence_refs` 也**不能**升格为 verified；本索引不提供「已验证」字段。

## 4. 判据（读）

- **只读零副作用**：`read`/`impact`/`coverage` 本地读，**不 ensure 宿主、不拉 writer、不调模型**。
- **来源现读复核**：内容变＝`stale`、路径消失＝`missing`、取不到（越界/凭据/超单文件上限）＝`unreadable`、一致＝`ok`、**本次查询来源读取预算用尽**＝`unknown`（未取到当前内容，按未知待补取，**绝不当成内容相符**）。**没被覆盖的无关文件变化不影响**。同长度同 mtime 的原地改写靠**内容哈希**识别（mtime/size 不作判据）。
- **来源读取复用与共享预算**：一次 `read`/`impact`/`coverage`（以及一次写校验）内，同一**规范路径**只现读一次并复用已取字节/哈希，所有来源共享**文件数与字节预算**（`PROJECT_INDEX_READ_LIMITS`：缺省 2048 文件 / 64 MiB，可被调用方收紧）。超预算如实标 `unknown` 并给补取入口，不把超限当作相符；缓存**不跨请求**留存，写锁内依旧现读当前来源。
- **`impact`**：给**显式声明关系** + **代码引用 `source_current`**（只表示来源当前**实际存在且哈希相符**，**不**表示声明的关系已验证；关系仍是 Agent `declared` 待审）+ 未知 coverage。**未声明 ≠ 无影响**。
- **`coverage`（交接覆盖）**：列**必需材料 / 实际返回范围与版本 / 遗漏 / 补取工具**。**送达 ≠ 理解 ≠ 验收**；**未取原文、未读源码的范围不宣称 covered**。补取入口：`read_plan`、`read_design`、`expand_module`、`project_index op=read`。

## 5. 工具面

| op | 副作用 | 说明 |
| --- | --- | --- |
| `read` | 无 | 按 `path`/`task_id`/`id` 返回条目摘要与来源状态；不存在＝空索引 |
| `impact` | 无 | 影响清单（声明关系 + 实际存在的代码引用 + 未知 coverage） |
| `coverage` | 无 | 交接覆盖清单与补取入口 |
| `upsert` | 写（经唯一宿主） | 增量新增/更新指定条目 |
| `remove` | 写（经唯一宿主） | 删除指定说明条目 |

写经**唯一写入服务宿主**（`projectIndexHost.handleProjectIndexRequest`，路由 `/api/work/project-index/{upsert,remove}`）；stdio MCP 不自己写项目目录。宿主侧做 token 鉴权、**慢 body 期间失去写所有权**（`assertWriteOwnership`）复核与体积上限（413）。

## 6. 与上下文包的接线

设计/施工页在上下文包（`project_entry.context_manifest`）里返回**新格式 `tcur1` 完整版本游标**（完整 64 位 sha ＋ 项目/文档绑定），可被 `read_design`/`read_plan` **直接消费**；旧 `tctx1` 短前缀只定位、会被明确拒绝（`LEGACY_CURSOR`）。`BuildContextOptions.events`（共享账本）让同一次请求不再另读账本；`task_state` 来源的内容身份是**真实字节 sha256**，不用 `last_seq` 冒充。说明文档存在时作为**可选**来源纳入上下文清单；不存在是正常空态，不强制首建全仓说明才接续。

## 7. 维护步骤（改后如何更新条目）

代码/文档改动后，维护者按下列步骤把说明层与**实际内容**对齐；只更新**受影响**条目，不做全仓预建、不重写无关条目。说明层改动仍是 Agent 声明，**不升格 verified、不改六图状态/颜色、不写用户 Gate**。无写能力/未获授权时**不声称已写**，按末步「交接」办理。

1. **定位**：用 `op=read` / `op=impact` 按本次改动的 `path`（或 `task_id`）取相关条目与来源状态；**命中不到不推断「无影响」**。
2. **读原文**：对需更新的条目回读其 `sources[].path` 的**实际内容**并核实语义改动；`stale`/`missing`/`unreadable`/`unknown` 一律**以实际源码为准**，不拿旧说明下结论。
3. **改说明**：只 upsert 受影响条目，按实际语义更新 `responsibility`/`paths`/`interfaces`/`constraints`/`relations`；**保持 `id` 不变**（路径迁移＝保持 id 的显式 upsert，不凭同名猜）。
4. **重算来源哈希**：`sources[].sha256` 只在**读过并核实该来源语义**后，按当前文件内容重算（不许用 mtime/size 顶替、不许在未读内容时先填哈希）。
5. **CAS 写**：写前 `op=read` 取回 `notes_file.version_sha256` 作 `expected_file_sha256`；经**唯一写入宿主** `op=upsert`/`op=remove` 提交；遇 `VERSION_CONFLICT` **重读当前文件、合并本次增量再重试**，不强行覆盖他人改动。
6. **写后读回**：`op=read` 读回本次落盘条目与来源状态，核对**增量已生效**、无关条目未被改写；读回不符按第 2 步重取来源再修。
7. **删除/移除**：`op=remove` 只删指定 `id` 的**说明**；源文件被移除时只在条目里去掉对应 `paths`/`sources` 说明，**不删源文件、不删业务证据**。若源文件删除使某条目**职责消失**，一并 `op=remove` 该条目，并核对其他条目**指向它的入向 `relations`**、一并清理或改指，**不留悬空引用**。
8. **如实标范围**：未取原文、未读源码的部分记为**未覆盖**并给补取入口，不用旧条目冒充当前。
9. **交接（无写能力/未获授权）**：**不声称已写**；把本次**说明更新/遗漏/未解决项**连同 `op=read` 取到的 `notes_file.version_sha256`（作 `expected_file_sha256`）交接给有权维护者，由其完成写入与读回。
