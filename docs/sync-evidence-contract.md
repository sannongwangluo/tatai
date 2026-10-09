# 同步证据发现与完整性验收契约 v1

日期：2026-09-30。技术设计：Codex。用户已授权设计及由 agent flash 实施此机制。本文是 DESIGN §2.10 的详细契约；不构成项目业务完成或用户 Gate。实现状态以 PLAN V09-23…V09-25、PROGRESS 和实际验证为准。

## 目标、范围与事实源

解决「实际同步完成了什么、是否漏项、是否与塔台记录一致」难以复核的问题。复用 v2 单写服务、证据内容地址、任务定义/状态和图派生，不增加第二份可独立修改的完成状态。每个可验收任务或同步批次可以交付证据包，不要求每次工具操作写文档。本轮落地同步批次的发现、完整性对账、接续约束与用户可见结果；普通业务任务仍经原认领、结果提交和审核流程，不因扫描到任意 Markdown 自动 done。

分母来自执行前登记的契约，不能执行后根据成功项缩小清单。设计角色/协调器通过明确写接口登记；文件发现只接收对应已登记契约的证据，不自动创建需求、改设计或改变契约。契约相同内容重交幂等，同 batch_id 改内容明确拒绝，修改范围使用新批次并显式 supersedes。

复核定版（2026-09-30）：supersedes 的新契约必须保留旧契约所有必需 item_id 且仍为 required=true；旧 blocks_entry=true 不能通过新契约改为false。v1不支持削减必需范围，拒绝时点名被删项；真正需要缩小范围属于后续明确变更，不由扫描器实施。注册工具限定设计/协调职责并记录actor，沿用可信本地写口，不把role字符串当作密码学授权。

## 契约与证据包

新增领域事件 `sync.contract_registered`、`sync.evidence_checked`，实体 `sync:<batch_id>`；新领域折叠/校验单源，登记面与 eventSurface 同步。运行事实仍为 `.工作台/work/events.jsonl`，快照可重建；证据包真实字节经现有 putEvidence 保存，不可变、可核哈希。禁止直接手写 events/state。错误经 WorkError 现有错误码和结构化 detail 返回。

契约 schema_version=1：batch_id（安全 ASCII 标识）、project_id、title、sources[{path,sha256}]、items[{id,label,required,check}]、blocks_entry:boolean、supersedes?:batch_id。至少一必需项，稳定 item_id 不重复；禁止未知字段、重复 JSON 字段（包括转义同名）、空来源、非法/超限内容、相对路径逃逸及软链/junction 逃逸。来源为当前项目内原始工作范围/设计/交接说明，哈希登记时必须匹配；事件冻结契约及其确定性 SHA256。sources 漂移应明确 stale，不悄悄接受旧证据。supersedes 必须指向同项目已登记旧批次且不能成环，旧记录保留。

每个项目有约定的 `.工作台/work/sync-inbox/`。Agent 完成后以临时文件写入再原子改名为 `<batch_id>.evidence.json`。只发现该格式，不扫描整仓任意 Markdown 推测完成。v1 证据包：schema_version、batch_id、project_id、contract_sha256、completed:boolean、items[{id,result,artifacts:[{path,sha256}]}]。result 为 passed/failed/needs_review；必需项必须全列，缺项、重复、未知项分别点名，未 required 的项也不可混淆。每项至少一真实 artifact：项目内可读取、有大小上限的报告/原始输出/回执；哈希实际重算，不采信仅文件名或总结句。completed=false/半写/坏格式/错误批次/旧契约/失败结论均不能通过。

证据包中的 passed 只是声明；程序必须再按契约检查当前实际目标。本地 Agent 为可信协作者而非防伪密码学身份，作者/审核身份沿用现有审核记录，不宣称目录权限或角色字符串证明可信。技术扫描不读取或打印凭据，不执行证据里的命令、不调用模型、不发外网。

## 检查类型：程序读取真实目标

check 为闭合的 discriminated union，每类型只接受明确字段。保持小范围，不能塞任意 JavaScript/正则执行器。允许实现者根据现有 canonical 函数确定字段细节并在本文一次定版，不能削弱以下语义：

1. `file_hash`：path + sha256。当前目标字节必须匹配登记期望，可用于权威设计保护、派生文件、交接、报告等。
2. `json_value`：path + JSON Pointer + expected。按 JSON 语义深比较实际字段，拒绝非法指针和原型路径；只能读项目内 JSON 文件。用于结构化回执或清单。不能把读同一份作者报告误称独立验证。
3. `task_definitions`：来自当前审定 plan 的实际解析定义，与账本导入定义按稳定 task_id/definition_sha256、依赖、角色等 canonical 定义完整逐项比；缺项、多项、字段不同都列出。实际分母由指定 source_plan 原文及其登记哈希给出，不仅比数量。
4. `task_states`：登记 task_id → execution_status 的准确期望集合，使用真实 v2 事件折叠，不能读 v1 compat 当实时；明确这证明执行登记而非独立验收。task_id 在定义中不存在亦失败。必须给 scope_mode=current|at_registration：current核对本次当前状态、改变即失败；at_registration以该契约登记事件前一个seq为固定截点（截点由服务确定，不能调用方任填），核对登记时已经存在的历史状态。证据在截点前未登记的成果不能拿截点后的状态补成通过。本次示例项目阶段历史回填采用at_registration，后续合法认领/reopen不会让旧同步批次永久阻塞；读口清楚给at_seq，不把此项说成实时进度。其他来源/文件/图基线等仍按实时规则，业务基线变化要求显式supersede，不静默解除约束。
5. `graph_full`：六图的只读 canonical builder，全量同快照取齐，collection complete、无 anomalies、期望有效 baseline_id（登记值）；不把静态关系说成业务验证，不把 614 等对象数写死成通用规则。未发布、旧基线、失败/陈旧/更新中、超限未取齐不能通过。
6. `required_reads`：期望项目内路径集合，核对 stage-reads.json 的 actual validated entries（不调用 project_entry 造成扫描循环）；各条目及来源哈希有效，缺条目点名。**v2 章节绑定兼容（V09-42）**：stage-reads 条目的去重键是 `path+section`，同一 `path` 可以有多个章节条目，所以每条期望可带可选 `section`，按 **(path, section)** 配对（只用 `path` 会让同 path 的多章节互相覆盖，出现假通过/假缺项，**不许**）；未点名 `section` 只匹配整文件条目，遇到"该 `path` 只有章节绑定条目"明确要求显式点名、**不按整文件哈希猜**；可选 `sha256` 核对条目 revision（条目是章节绑定则比章节子树哈希，拿整文件哈希核章节条目明确不符、不静默当匹配）。表示接续必读已配置，不意味着 Agent 已经阅读。
7. `markdown_section`（V09-42）：`path` + `section`（完整标题路径）+ `sha256`。按完整标题路径**唯一定位** Markdown 章节，核对「标题行 + 全部后代」子树的 sha256（口径唯一实现在 `src/shared/materialSection.ts`）。章节外改动不影响、章节内改动即 failed；章节缺失、同级同名重复、**每级路径不唯一**（重复父标题下子标题只出现一次也拒）→ failed，非文本/非法选择器 → invalid。**不放松 artifact 整文件契约**：证据包里的 `artifact` 仍是整文件 sha，本 check 只锚定章节子树，不代表 artifact 漂移被豁免。
8. `audit_check`（如需要独立审核）：引用已有任务/检查 ID 与版本，通过现有有效证据判据；缺失/旧版/未通过记 needs_review。不能由扫描器代写作者自检、独立审计或人工验收。本轮若没有真实用例可不开放该类型，但不得把技术对账说成语义审核。

输出统一逐项 verdict：passed/failed/missing/needs_review/stale/invalid，带期望、实际、来源、证据引用、原因；必需项全部 passed 且完整读取才 overall=passed。无登记契约显示 not_configured，不说 synced；契约存在但证据缺失显示 missing，不默认为通过。额外 evidence 文件也显式报告未登记批次，不私自采纳。

边界澄清（Codex实施复核）：包内未知item_id属invalid，不能只列原因仍判整包passed；task_definitions完整定义哈希必须始终核对，compare字段必须明确布尔，不能用false或缺字段关掉定义完整性检查；task_states期望集合不能为空。JSON Pointer转义仅允许~0/~1并拒绝原型段。自引用路径按规范化后的实际位置核验，不能用./或重复分隔符绕过。所有来源、目标与证据读前核常规文件及大小上限，收件目录及文件同样通过项目内realpath守卫；collection未取齐时读取结论和认领判定均不能通过。注册既有项目的新契约后，后台也必须开始发现其后续收件，不能要求重启或重新登记项目才生效。

## 自动发现、写入与重新验证

后台在唯一写服务宿主启动时，对已注册 v2 项目做有界首次扫描，并监听约定目录新增/替换/删除；不依赖用户先打开项目，不在 MCP 宿主各启动一套写者。可使用现有 chokidar 和生命周期设施；关闭宿主清理监听/定时器/队列。只处理有契约或明确 inbox 的项目，扫描项目数量/文件数/文件大小有界，达到上限报 incomplete 及原因，不能截断后报通过。目录不存在正常为空；联接目录不跟随。

后台自动扫描和显式 scan_sync_evidence 共用同一逻辑、单飞队列和真正唯一写口。必须 await WorkReceipt、核 ok/projection、读回；拒绝 silent catch。稳定幂等键由 batch/contract/evidence/current target fingerprint+verdict 构成，不随实体 revision 漂移。扫描重复、文件重复通知、响应丢失、重启并发均零重复效果；错误暴露但不破坏其他项目。**扫描只评估现行（active）批次**：已被取代的历史批次不评估、不写入（其结论以账本回执为准，见下）；收件目录里同一批次的证据在扫描内先**全部评估、再逐条提交**（写回本身不再打断同一轮的真实输入复用）。**单飞不丢通知**：某 key 已有在途扫描时再来一次请求，每个请求由「在它之后开始的一轮」覆盖、随自己那一轮完成即返回，**不等待后续无限新请求**；在途期间的请求合并进**已排定的下一轮**（不是复用同一 promise，也不是无限补跑链），该轮读完最新收件目录，故在途期间新登记批次/新投放证据不会因为"已经扫过了"被丢掉（watcher 漏报时尤其重要）；本轮错误如实抛回本轮请求、不被后轮成功掩盖，排定的补跑轮必被启动（stop 等待在途/排队后返回、返回后不再新增扫描写入）。

宿主定版：扫描器只在本进程已成为唯一写服务并发布/确认描述符后启动；桌面和独立daemon共用该生命周期，退位候选不能先扫。精确监听inbox，忽略自写events/state；项目注册表可增量发现，不只启动时一次列出。指纹不得包含自己刚追加的同步事件序号/墙钟/检查时间（否则每扫描一次都变）；at_registration截点稳定，其余实际任务/定义采用相关业务事实投影指纹。不可读或损坏的本领域事件不当成not_configured。

后台异常的组合接口（实施复核拆分）：`syncRuntimeHealth.ts`只保存当前宿主内的发现错误，不保存同步通过状态、不作为第二账本；它无业务模块依赖，导出`reportSyncDiscoveryIssue(dataDir, projectId:string|null, issue:string|null)`、`readSyncDiscoveryIssues(dataDir, projectId):string[]`、`clearSyncDiscoveryIssues(dataDir)`。null项目表示全局发现错误；null issue表示相应成功重试后清除。后台监听/项目上限/注册表读取/提交失败明确报告；read_sync_status与computeSyncBlock读取同份错误，有受影响现行阻断契约时fail closed。没有同步配置的旧项目不因其他项目单独故障被阻断。停止等待在途队列终结，await stop返回后不再新增扫描写入；防抖按项目替换定时器。

跨进程读取：MCP stdio不是后台宿主，不能拿本进程空错误汇冒充“后台无故障”。MCP同步状态及project_entry须从唯一宿主只读状态/健康接口取得同份错误，再用同源判据；不启动额外写者。宿主不可达或读口不完整时明确显示无法核对后台健康，不能静默丢弃已知发现故障后仍报告同步通过。

默认只读 read_sync_status 每次重读必要文件和实际目标，对比登记/最近扫描；修改、删除目标、证据或来源后立即显示 stale/missing/failed，历史 passed 不等于当前 passed。**这条实时口径只适用于现行（active）批次**；已被 supersede 的历史批次不再逐次实时重算——它展示**账本里最后一次有效核验回执**的结论与核验时间（`verified_at`，只作历史、不计入范围与差项、不再阻断），账本没有有效回执时明确「未核验」（`verified_at=null`，绝不显示为通过）。需要时可用显式入口（`readSyncStatus` 的 `liveHistorical`）对历史批次做一次实时复查，但常规只读不再把几十个历史批次重新卷进来（2026-10-03 增量核验，见附录）。后台捕获目标变化可复核留痕；即使监听没捕获，读口/认领门禁实际复核也不能继续使用旧通过。评估输入与记录时重核版本，防计算后目标变更假通过；写锁内同步契约校验与唯一服务边界核验，不允许直连伪造 sync.evidence_checked 的 passed 绕过检查。

依赖方向：同步不得接进 collectProjectFacts/projectWithReleases，图builder不能回穿同步；只在project_entry响应/认领边界读取同步判定。计算真实目标可在锁外，提交前带稳定目标指纹，锁内以有界目标快照核验身份、内容与实际指纹；不要在锁内跑不受控全仓扫描，也不得只比较调用方自己提供的摘要。锁等待/耗时/变化必须明确失败或重试不通过，不能覆盖活锁。文件系统并不受事件锁统一事务保护，要求评估前后指纹一致；不作“任意外部并发写都绝对原子”的承诺。

active blocks_entry 契约未当前通过时：project_entry 添加 sync_summary 和 required_reads，next_action=blocked 并列出差项；claimTask 与唯一写服务锁内 task.claimed（非续约）同样拒绝，避免绕开入口。superseded 批次只作历史不再阻塞，也不再逐次实时重算——其结论来自账本最后一次有效核验回执（带 `verified_at`），缺回执即「未核验」；写口同样拒绝给已被取代的批次新增核验事件（锁外与锁内各核一次 active，防"锁外备好后被取代"竞态，零字节）。自动接收证据不产生 task.result_submitted 或用户 Gate；同步检查通过只是取消本批次接续阻断，仍按原基线、角色、业务依赖决定下一步。

无契约的旧项目完全兼容；有非法或不可读的本领域事实明确失败，不当成未配置。同步只对声明范围作结论，范围以外未知内容不声称已覆盖。

## 接口、界面和交付

界面、HTTP和MCP共用 `src/shared/syncEvidence.ts` 的只读返回契约（后端实现者维护定义，UI不能另造类型语义）：`SyncStatusReport={project_id,configured,overall,checked_at,scan_error,batches,unregistered_evidence,collection}`。overall/batch.verdict/item.verdict 值集为 not_configured/missing/passed/failed/stale/needs_review/invalid/incomplete（item不使用not_configured）。batch={batch_id,title,active,historical,blocks_entry,verdict,contract_sha256,evidence_path,verified_at,items}；其中 `historical=true`＝本行结论来自**账本回执**而非本次实时核验（`verdict`/`items` 来自账本最后一条有效回执，`verified_at`＝该回执的核验时间；无回执时 `verified_at=null`、`verdict` 不可能是 passed）；默认口径下 `historical ⟺ active=false`，现行批次 `historical=false` 且 `verified_at=null`（现行批次的核对时间看报告级 `checked_at`）；显式历史复查（`readSyncStatus` 的 `liveHistorical`）时历史批次也走实时求值，`historical=false`（行仍按 `active=false` 归历史组；`data-sync-batch-history-note` 如实区分「历史回执/未核验」与「本次显式实时复查」两种情形）；item={id,label,required,verdict,expected,actual,reasons:string[],artifacts:{path,sha256}[]}；expected/actual为可序列化JSON（历史回执行不带本次实时 expected/actual，为 null 并在 reasons 注明「历史回执」而非当前有效）；unregistered_evidence={path,batch_id,reason}[]；collection={complete:boolean,reasons:string[]}；checked_at为实际本次核对时间，scan_error=null|string。未配置batches=[]，configured=false。HTTP读口 `GET /api/projects/:id/sync-status`，只读、不自动扫描写账；显式写扫描接口用现有可信本地接口惯例，不挂未授权远程路由。

- MCP：register_sync_contract（明确写入）、scan_sync_evidence（明确有写入）、read_sync_status（只读）。HTTP/界面同判据；采用现有 localhost 写口信任边界，远程功能保持关闭，不开放新未授权远程写路由。
- `register_sync_contract.contract` 的 MCP 声明接受 object 或 JSON string；文本通道额外拒绝重复字段（含转义同名）。成功及相同内容重复登记均返回 `project_id`、`batch_id`、`contract_sha256`、`registered_seq`。后者是本项目真实 `sync.contract_registered` 原事件的序号，不能用当前 last_seq 代替；重复响应附只读 `registration` 元数据，不伪造新的写回执，不新增事件。调用方可据此恢复 `at_registration` 截点。
- 唯一宿主接口为 `POST /api/work/sync/scan` 与 `GET /api/work/sync/status`，经已有描述符 token 和本机信任边界。桌面服务及独立 daemon 都须按准确方法/路径转接；验证必须实际调用桌面宿主，不能只覆盖 daemon。主动扫描返回错误时，即使账本零新增，也必须判失败，不能当作幂等成功。
- 同步状态在主项目工作面有简短入口，显示「未配置/等待证据/发现缺项/待审核/来源已变/同步通过/检查失败」及核对时间、范围项数。详情逐项缺口、期望与实际、证据入口；不默认展示实现 jargon。界面/API/MCP共用结果，无另算完成色。
- 本轮在示例项目登记真实同步批次并对照已有证据生成正式包，sources 与全部 check 来自已确认文件/账本实际可核事实，不能用假输出、当前时间假装历史测量或伪造验收。其生成器保存在示例项目，本项目只保留空模板/隔离夹具。登记前做备份/preview，前 180 历史事件原字节保护，B1零认领/零执行，七份权威设计与原B1交接不变；同期其他项目不新增本领域事实。
- 已有所有未提交变更保留。本轮未授权 Git commit、服务器部署、付费评测、启动示例项目业务、迁移旧库。源码检查及 build 通过后同步本机现有安装产物，文件备份/逐项哈希/安全重载/新 MCP 与 UI 真实验证，不能杀其他 Agent。

## 必需验收（先红后绿）

正常完整批次自动发现且无额外工具调用→passes并可取下一动作；缺一个必需项→准确missing；actual目标不同→failed；仅声称passed但目标错误→不通过；缺证/旧证/源码变化/半写/损坏/重复ID/未知字段/转义同名键/遍历及junction→明确拒绝；未登记证据可见不采纳；缩小分母/换契约同batch→拒绝；重复通知/显式扫描/重启→零重复事件；源或target被改/证据被删→读取及认领fail closed；直接写口假passed和直接认领都不能旁路；旧项目无配置不受影响；后台启动发现既有包、不选项目仍发现、关闭无监听泄漏；完整六图可读、UI清楚列差异；示例项目实测前180不变、无B1执行。

先存实际失败证据，再实现。测试不能只比较作者自产摘要与作者期望，至少以独立实际文件/账本目标修改构造反例；技术质量与人工 Gate 始终分开。终审查闭合链，不用测试数量代替覆盖。

## 附录：实现说明与最小明确规则（2026-09-30 实施；不削弱上文定版）

实现按 DESIGN §2.10 与上文契约执行，施工卡 V09-23（V09-24 界面、V09-25 集成与示例项目实测由对应执行者推进）。
逐条把"规范给语义、实现给字段细节"的落点与本轮**最小明确规则**记在此处，供主审核定；**不改上文判据语义**。

- **模块划分（解析/检查/扫描单责）**：`syncContract.ts`＝契约解析/冻结/supersedes；`syncChecks.ts`＝证据包解析＋六类 check 逐项裁决；
  `sync.ts`＝编排（折叠/读口/阻断/扫描/写边界核实）；`syncProbe.ts`＝零依赖的六图探针注册表（破 `sync↔syncGraph` 求值顺序环）；
  `syncGraph.ts`＝graph_full 探针（注册制，`sync.ts` 不反向 import `sixGraphs`）；`syncHttp.ts`＝只读读口；`syncDiscovery.ts`＝后台发现。
- **at_registration 截点**：`at_seq = 该契约登记事件的 seq − 1`，由服务在折叠时确定（调用方不能任填）；`task_states` 只折叠 `seq ≤ at_seq` 的业务事件；
  读口在 `item.actual` 回带 `at_seq`。其后合法 `claim/reopen` 不改变历史断言结论（F/A 定版）。
- **目标指纹（两段式，2026-09-30 A 返工定版）**：`target_fingerprint = sha256(stableStringify(逐项 {id,required,verdict,actual}))`；
  另有**有界** `source_fingerprint = sha256(stableStringify({sources:[{path,实际sha256}], items:[{id,required,actual}]}))`——
  两者都只由**业务事实**（文件字节/JSON 值/账本折叠 ≤ at_seq/plan 源哈希/必读哈希/图源输入身份）构成，
  **不含**任何 `sync.*` 事件序号或时间——连续扫描/重启零重复效果。
  **锁外**由唯一服务按当前实际目标做独立**全量**评估（含 `sixGraphsOf`）并与命令声称逐项比对；
  **锁内**只做**有界**复核：重核身份/证据真实字节，并用**图源探针**（只读生效基线身份＋设计/施工源修订，
  **不跑 `sixGraphsOf`**）、目标文件字节、业务投影重算 `source_fingerprint`，与锁外值**逐字节一致**才放行；
  目标在锁等待期间变过、或读取超预算（`SYNC_LOCK_REVIEW_MAX_BYTES`）一律明确失败（零字节），
  不覆盖活锁，也**不只比较调用方自己提供的摘要**（实测见 verify 段 L-6/L-7：算后改目标被拒、锁内全量图探针 0 次）。
- **登记幂等**：`register_sync_contract` 在提交前做**只读预检短路**——同 `batch_id` 同内容直接回报 `duplicate`（零新增事件）、异内容拒；
  避免 `expected_revision` 从 `null` 变 `1` 造成幂等指纹漂移后反而 `IDEMPOTENCY_CONFLICT`。
- **putEvidence 的版本绑定**：证据包真实字节经现有 `putEvidence` 存为不可变内容地址件，`kind="other"`，`source_ref`＝收件目录相对路径。存在`task_definitions`检查时绑定`revision_kind="plan"`及真实`source_sha256`；无该项时绑定`revision_kind="interface"`及本同步契约内容哈希，明确此处interface指同步契约、不能说成业务接口验证。禁止把任意scope文件哈希假标为plan修订。同步完整性以本领域sources与check重新核验，不从普通证据目录一条版本标签推定通过。
- **真实目标与作者声明的区分**：不虚构身份检测。落地为两条可判读观测点——
  ① **禁止自引用**：任何 check 目标路径与任何 artifact 路径落在 `.工作台/work/sync-inbox/` 内一律 `invalid`（收件目录里的东西不能当独立目标）；
  ② 逐项在规范观测点读真实目标（文件字节/JSON值/账本折叠/plan解析/六图canonical builder/stage-reads）。检查类型不证明作者身份；file_hash也可以证明声明文件版本一致，但不能因此说业务语义已经独立审核。必需项声明needs_review时不能通过，不增加无法可靠判别的作者路径规则。
- **同步摘要在响应层拼**：`project_entry.sync_summary` 由 `evaluateProjectEntry` 在响应层从 `computeSyncBlock` 组装（findings D）；
  `collectProjectFacts`（statusProjection.ts）**不读同步态**，故 `sixGraphsOf → entry → sync → 探针 → sixGraphsOf` 不成环。
- **写口门禁（2026-09-30 A 返工拆分）**：`sync.contract_registered` 的锁内核实走 `assertSyncContractWriteCommand`
  （闭键/来源实核/同批次改内容拒/supersedes 不成环/**职责边界锁内核**：非 designer/coordinator 直连也拒）；
  `sync.evidence_checked` 走**两段**：锁外 `prepareSyncEvidenceCheck` 独立全量评估并比对声称，锁内 `assertSyncEvidenceWriteCommand`
  重核身份/字节并用**有界**目标快照重算指纹。它与 `claimTask`／`entry` 的阻断判据**同一份** `computeSyncBlock`；
  伪造的 `sync.evidence_checked`（假 passed、算后改目标、契约/证据哈希不符）被拒、零字节。
- **来源与目标实时性 + 严判（A 返工）**：来源实核在**登记/读口/门禁/evidence_checked 写口**每次都做，来源不是 check 目标时变化也 `stale`；
  读前核常规文件与字节上限。证据包出现**未登记 item_id → 整包 invalid**；`task_states.expected` **不许为空**；
  `task_definitions.compare.owner_role/dependency_ids` 必须**明确布尔**且**定义哈希始终完整核对**（`compare=false` 关不掉）；
  `json_value.pointer` 只允许 `~0/~1` 并拒原型段；自引用路径按 POSIX 规范化后比（`./`、重复分隔符绕不过）。
- **收件目录守卫 + collection fail-closed（A 返工）**：收件目录与每个证据文件过 realpath 守卫（联接/软链逃逸、非常规文件不处理），
  文件数/单文件/总字节有界，**不可读显式 `incomplete`**；`inbox.complete=false` 时读口 `overall` 非 `passed`，
  有现行 `blocks_entry` 契约时 `computeSyncBlock.blocked=true`（认领/入口一并阻断）。
- **overall 与 gate 分开取（A 返工）**：读口 `overall` 取**所有 active 批次**的最差（含非门禁批次的缺项）；是否**阻断**另按 active 且 `blocks_entry` 判。
- **graph_full 基线当前有效（A 返工）**：除图 published/取齐/采集完整/无异常/更新态外，还实核**生效基线当前仍有效**
  （设计比内容哈希、施工图比定义哈希）且已发布图由该基线构建——**旧 `baseline_id` 未变但设计源变过仍非 passed**。
- **后台发现错误消费（组合复核）**：宿主读口/gate 读取零依赖 `syncRuntimeHealth` 的 `readSyncDiscoveryIssues`，不回穿发现模块或图builder。MCP是另一进程，`syncHost.hostSyncView` 经现有描述符只读唯一宿主报告/故障；不可达且已配置时明确失败，不因本进程错误汇为空假称后台健康。只读路径不拉起写者。旧无配置项目保持兼容。
- **读取预算（最后复核）**：来源实核默认16MB总预算；锁内来源与实际目标共用16MB预算，单文件仍有8MB上限，读前超界不读且不判通过。图输入有单文件8MB/合计16MB预算，异常或超界明确failed/incomplete；只有ENOENT算合法缺失。实际图输入身份和非sync业务事件投影进锁内外指纹，图builder仅在锁外运行；同步证据写口和非续约认领均按此边界核验。
- **发现与停止界限**：后台有界轮询每项目64个当前证据文件、扫描侧512文件/64MB总证据读取是另一界限（**只计当前（active/未知/未登记）证据；已被有效契约取代的历史文件退出当前发现预算、不计入也不进指纹**），当前证据超过则显式不完整，不用截断指纹报通过，先触及发现界限仍须明确报告；契约域坏事实时不豁免任何文件。每项目真防抖、按dataDir+project单飞；停止关监听和定时器后等待已启动扫描全部终止，10秒只是告警，不成功返回后留晚写。在途永不终止会延迟优雅退出，不承诺无条件有界停机。
- **验证**：`scripts/verify-sync-evidence.ts`（先红后绿，原始日志 `.工作台/verify/sync-evidence-20260930/backend/`）覆盖上文「必需验收」与 A–F 定版反例；
  真实示例项目批次登记、安装版与终审属 V09-25，不在本附录。

### 增量核验（2026-10-03，性能修复；用户已批准方向）

- **动机（实测）**：`readSyncStatus` 过去对**全部已登记批次**逐批实时求值。一个真实项目（示例项目）账本里有 44 条 `sync.contract_registered`，
  其中约 42 批带证据：一次只读要跑 44 次逐项裁决、反复读同一批目标文件（3898 条 item / 2004 个去重 artifact 路径，
  单路径最多重复 96 次）、并对每个批次重算一次六图输入身份——而其中绝大多数是**已被 supersede 的历史批次**，
  契约冻结、`at_registration` 截点固定，重算只是把旧结论重演。于是核验把实际开发卡住（宿主直读实测 8–10 秒，超客户端 5 秒预算）。
- **语义修正（本文正文已同步）**：历史批次改为展示**账本最后一次有效核验回执**（`historical`/`verified_at`，缺回执即「未核验」）；
  现行批次**照旧**逐项按当前实际目标实时重算。active 必需范围一项不减，`graph_full` 与锁内复核均不放松。
- **扫描侧**：只评估现行批次；同轮内**先全部评估、再逐条提交**（避免自写 `sync.evidence_checked` 打断同一轮的真实输入复用）；
  单飞在途请求合并成**一轮补跑**，不丢在途期间的新登记/新证据。
- **写前防 supersede 竞态**：`prepareSyncEvidenceCheck`（锁外）与 `assertSyncEvidenceWriteCommand`（锁内）各核一次 `active`；
  批次在"锁外备好后、写入前"被取代 → 明确拒（`sync_batch_superseded`）、**零字节**。
- **复用的边界（不放松）**：六图探针的调用内复用键仍以**内容身份**为准（生效基线、设计/施工源修订、有界图输入文件 sha256、
  业务事件投影指纹、**事件账本文件内容 sha256**），**不含** size/mtime/TTL，也不含自己的 sync 事件序号/墙钟；
  同长度改写、保留 mtime 都按内容失效；键核不出来一律不复用、逐次真建。证据包未变**不能**证明目标未变。
- **验证**：`scripts/verify-sync-incremental.ts`（先红后绿）覆盖 active/历史分离、历史不读目标、历史目标改/删后历史结论不变而现行立刻变、
  无回执历史未核验、扫描只写现行、写前 supersede 竞态零字节、在途补跑不丢通知、同长度保留 mtime 改写立即反映；
  `scripts/verify-sync-request-reuse.ts` 按新语义更新（历史批次改走回执、复用断言落在现行批次）。

### 增量核验复审返工（2026-10-03 第二轮，Codex 复审 1/2/3/7/8 项）

- **单飞完成代际有界（替换无限补跑链）**：每个请求由「在它**之后开始**的一轮」覆盖；原请求随自己那一轮完成即返回，
  **不等待**后续无限新请求；在途期间的请求合并进**已排定的下一轮**（不是复用同一 promise），该轮读完最新收件目录，
  在途期间的新登记/新证据不丢。**错误语义**：本轮失败如实抛回本轮请求，**不被后轮成功掩盖**；排定的补跑轮在本轮
  结算时**同步先启动**，所以 `stop` 等待在途 promise 时也能等到它——**停机不漏补跑**，`stopSyncDiscovery` 返回后
  不再新增扫描写入。持续通知（每 2 秒一次、扫描 >2 秒）下每请求最多等 ≈2 轮，不被挂死。
- **历史回执逐条校验（不引入新门禁）**：`foldSyncReceipts` 除形状外，按**本批次契约**核对 item 集合完整、重复 id、
  `required`、`overall` 与必需项一致（`overall=passed` 必须所有必需项 passed）。缺项/不一致的旧回执**不展示 passed**
  （`verified_at=null`、行按不可用/未核验如实呈现）；**历史回执损坏不升级成报告级 `problems`**——历史只作展示，
  报告与认领的当前门禁都不因此新增阻断（不因展示缓存读取制造无依据新阻断）。
- **历史退出当前发现预算（区分历史/active/未知）**：后台有界轮询的每项目 64 文件上限与读取侧 512 文件/64MB 上限
  **只计当前（active/未知/未登记）证据**；已被**有效契约**取代（`active=false`）的历史文件不计入，也不进发现指纹。
  未知或 active 超限仍 `incomplete`/fail-closed，不截断后报通过；契约域有坏事实时 `historicalBatchIds` 返回 **null**，
  **不豁免任何文件**（损坏契约不得用来把文件排除出当前预算）。补 100 历史 + 1 现行、65 未知、坏契约负例。
- **六图探针构建期间输入变动的明确过期**：`memoizeGraphProbe` 构建前后输入身份不一致（或事后核不出键）时，返回
  **明确过期**结果（`ok=false`、`verdict=stale`），让 `graph_full` 不通过——不再「只不入缓存」照常返回本次旧结果。
  尤其只有 1 个现行批次、没有下一批触发重算时，也不会把旧事件快照配新身份判 passed。
- **验证**：`scripts/verify-sync-incremental.ts` 增 K（100 历史+1 现行不拖死当前、坏契约不豁免、65 未知仍 fail-closed）、
  L（构建期间真外部输入改变 → 明确过期）、M（停机等在途+排队、返回后不重启）三段；同文件 G 段改为完成代际有界断言；
  `scripts/verify-sync-request-reuse.ts` 增 C-3/E-5（真文件/真事件在 build 期间改变 → 明确过期）；`verify-sync-discovery` S3
  改为「等价规范 dataDir 共用同一单飞队列」。

### 修复计划与候选证据边界（2026-10-06，P3／V09-48；契约细则见 docs/agent-optimization-20261006.md §7）

- **只读修复计划**：现行（active）批次的 `read_sync_status`／`project_entry`／`task_brief` 在原有逐项之外给一份**修复计划**——
  逐项 `item_id`、原因、责任角色（`registered_by` 来自登记事件；`recommended_role` 按失败类型建议，**不替人授权、不构成指派**）、
  当前代次、来源漂移（**只列漂移，不自动重算哈希/补证/改契约/缩小必需项**）、可复用工件与**下一读取入口**；一次列全，
  共因可分组显示但**不省略完整项**。
- **候选证据边界**：由纯派生件（如需重算的图/清单）得出的候选**只在响应里返回 JSON**——**零落盘**、不落收件目录、
  不被自动发现、**不自动采纳**；候选是**明确未验证的草稿**（不是证据、不是通过、不是独立审查），**不得**修改
  `required`／`blocks_entry`。本批**不新增保存入口**；若将来实现保存，须满足唯一宿主、既有判据、非自动发现位置＋断言，
  且候选进入正式链路时**实际读取并核对**其依据的契约哈希与目标当前字节，源再变 ⇒ 候选被拒。
- **不放松 v1 门禁**：未知/损坏/失联/收件目录未取齐仍阻断；`graph_full` 等必需项未满足仍阻断（`waiting_for_derivation`
  **只是说明**，不放行、**不编造 ETA**；重试有界且同代请求合并）。`at_registration` 截点与整文件绑定不为省事改档。
- **简报的紧凑形态**（集成修正，契约 §7.1.1）：`task_brief` 默认 `detail=summary` 把 `repair_plan` 转**紧凑导航**
  （`nav:true`；现行批次数／逐 `verdict` 项数／阻断批次数／等待派生计数／`read_only`／有界每批摘要／明确 `omitted.fields`／
  结构化 `refetch`）；`read_sync_status` 与 `project_entry`／`task_brief detail=full` **完整保留**逐项（一字不删）；
  summary **不重算**同步，只压缩同一次评估已有的投影。
- **验证**：`scripts/verify-sync-repair.ts`（定向反例与同快照字节对照）。
