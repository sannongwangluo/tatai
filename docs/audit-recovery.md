# 审计误登记的追加纠正

原审计、失败、修复、复验和用户接受各自保留。纠正只改变指定旧记录的解释，不编辑账本，不直接产生通过，不替用户决定 Gate。

`record_work_evidence(op="correction", role="coordinator")` 接收 `correction_id`、`expected_revision` 和闭合的 `correction`。首次修订为 null；返工须沿用实体、给当前修订，并用 `supersedes` 指向上一条纠正事件。任一身份或前代不匹配时零写入。

支持两种操作：

- `bind_finding_refs`：逐条保留原 findings 文本，说明其为缺陷还是背景，映射到正式 finding。不能清空全部缺陷或替换已有正式引用。历史 finding 的 object_id 若是复合描述，只接受 `finding_scope` 对原 opened 事件 ID、事件哈希和原 object_id 的精确绑定，并由裁定包批准归属；不做任务字符串模糊匹配。
- `reclassify_not_checked`：原报告明确未执行的指定 failed 检查恢复为待真人检查。任务、原检查和原绑定均精确钉住；不改同记录的其他真实失败、不减少必需项，不派 Agent 修复或自检。此操作不能转成 passed。

哈希口径：`target_raw_sha256` 是 UTF-8 原始事件单行（不含换行）的 SHA-256；`target_sha256` 是 `loadEvents` 返回的规范化原事件经 `JSON.stringify` 后的 SHA-256。绑定、检查、finding_scope 的事件哈希采用对应规范化对象 `JSON.stringify`。两种事件身份都验证，不把重新序列化称为原始字节证明。

写口必须读取项目内、无越界符号链接且内容哈希匹配的两份 JSON：

1. `audit-correction-review/1`：`decision="approved"`、具名 `reviewer`、完整 `reviewed_correction`（请求去掉 report_ref/report_sha256/authorization_ref/authorization_sha256 四项，其他字段精确一致）、`original_report{ref,sha256,pointer,value_sha256}`。pointer 为原 JSON 报告中的精确 JSON Pointer。未检纠正还要求定位对象的 check_id 相同及 `execution_assessment="not_performed"`。原报告本身将未验写成 fail 时，须在 rationale 中解释原 basis 的含义；这是独立审查者的语义裁定，不是程序从自然语言自动证明。
2. `audit-correction-authorization/1`：具名 `authorized_by`、授权依据，以及逐目标 `scope[{target_event_id,operation,check_id}]`。授权其他检查或操作不能复用。

审查者不能是原作者或原审查者；比较时归一空白、Unicode 和大小写。程序核对身份声明、内容与范围，采用项目既有本地可信角色边界，不提供密码学签名或自然人身份认证。具名裁定者必须真实完成审查，不能由协调器编造他人的批准。

新审计的逐检查结果只认 passed/failed/not_checked；失败必须引用在册同任务 finding。未知值不能默认通过。self_check 使用原有记录级 conclusion，不接受会被丢弃的逐项 result/pending。coverage 未给 status 沿用既有 checked 缺省；显式值只认 checked/unchecked/not_applicable，并核五视角身份、唯一性与依据。

## 真人待验的出口

等待 human_tester 的检查由实际测试人完成并保存原始观察记录。Agent 可以整理用户提供的记录和存证，但不得运行真人确认命令，不得宣称自己进行了人的理解测试。

测试人在交互终端运行 `pnpm exec tsx scripts/record-human-check.ts <观察记录.json>`，检查内容后亲自输入确认语句。输入须含 project_id、task_id、check_id、performed_by（真实测试人）、author_id（被审作者）、result（passed/failed）、evidence_sha256（已存证的观察证据）、binding（当前有效版本）、coverage（五视角的实际范围和依据）。没检查的视角写 unchecked 和原因；失败先登记正式 finding，并在 findings 列引用。不可用虚构哈希替代原始证据。

服务仍走唯一写者。真人记录复用独立审计事件，但角色来自事件信封 user 且 actor_id 必须等于 auditor；仅在 payload 中冒写 auditor_role=user 无效。记录须在待验之后、非作者且当前证据有效；普通 Agent 后续 pass 不解除人验。工具拒绝非交互输入并要求确认；这是一条人工操作约束，不声称能阻止有本机写权限的人伪造身份。

等待 user 的项在本轮用于含用户 Gate 的复合检查：除了上述真人检查，还必须有同任务、待验之后、当前 DESIGN/PLAN 基线的 accept 记录。现有 `/api/projects/:id/acceptance` 人工验收入口记录实际生效基线；旧无基线、旧版、其他任务或后续 reject 均不能解除该项。人的可用性检查和最终用户 Gate 分开记录；真人观察录入命令不写接受事件。

## 消费者兼容与验证

生产先更新唯一写服务和读取客户端，再追加纠正。旧消费者不认识 correction 时保留原 failed；但旧代码可能把直接写入 independent_audit 的 not_checked 当 passed，因此不得让旧消费者读取这种新结果。运行中 MCP 进程不会因为磁盘源码更新而自动重新加载；必须实际重连或核查其构建身份。

验证入口：`pnpm exec tsx scripts/verify-audit-recovery.ts`、`pnpm verify:loop-closure`、`pnpm verify:v06-09`、`pnpm verify:work-package`。本轮真实旧账本回放和逐目标裁定材料在私有工作台，公开代码不包含真实纳管数据。

V09-19 的测试维护保留真实六图完整遍历、跨段边界和工具 handler；轮数由图对象数与页长确定。limit=1 穷举在隔离小项目，真实大图仍测 limit=1 边界微遍历；不跨真实请求共享派生缓存。V09-44 的旧简报证据通过 `TATAI_BRIEF_EVIDENCE_DIR` 指定目录，缺省为项目 `.工作台/evidence/V09-44`，不依赖仓库父目录。
