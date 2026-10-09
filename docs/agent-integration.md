# 外部执行接入档案（项目适配 · 实测）

> 依据：`DESIGN.md` §1.5（默认工作链：Claude Code 协调 Kimi Code）、§5.4（连续施工与恢复）、§6.5–§6.7（协作接口与权限边界）、
> `PLAN.md` V06-11「核实真实工具版本、配置标识和启动方式，编成项目适配档案」。
>
> **本档案只写实测到的东西**：每条都附本机真跑出来的命令与输出片段。没跑过的写「未测」，不照抄上游文档。
> 机读的那几栏在 `src/server/work/executionReceipts.ts#BUILTIN_CLIENT_PROFILES`，两边口径必须一致（验证脚本对账）。
>
> 实测环境：Windows + Git Bash，`node v24.18.0`、`pnpm 12.4.2`、`git 2.54.0.windows.1`；
> 两个 CLI 都在 PATH 上：`<你的可执行目录>/{kimi,claude}`（作者实测机器的具体路径属本机信息，不录入本档案）。实测日期：2026-09-20。
>
> **凭据只报"在不在"**：本档案与回执都不记录任何密钥原文，只写键名与配置路径。
> **本机路径占位**：作者机器的用户名与具体目录不录入（`<你的可执行目录>`、`<KIMI_CODE_HOME>` 等占位符），换机器以实际环境为准。

---

## 1. 工具清单与版本（实测）

| 工具 | 角色 | 版本（实测命令与输出） | 非交互一次性执行 |
| --- | --- | --- | --- |
| Kimi Code（`kimi`） | 执行者（worker） | `kimi --version` → `0.41.0` | **支持**：`kimi -p "<prompt>"` |
| Claude Code（`claude`） | 协调器（coordinator，拉起/终止执行进程） | `claude --version` → `2.1.274 (Claude Code)` | **支持**：`claude -p "<prompt>"` |
| Node / pnpm | 塔台运行时与包管理 | `node --version` → `v24.18.0`；`pnpm --version` → `12.4.2` | — |

`kimi doctor`（只读，不写配置）实测输出：

```
Kimi doctor

OK config.toml  <KIMI_CODE_HOME>/config.toml
OK tui.toml     <KIMI_CODE_HOME>/tui.toml

All checked config files are valid.
```

---

## 2. Kimi Code（执行者）——启动方式与配置标识

### 2.1 启动方式（`kimi --help` 实测片段）

```
Usage: kimi [options] [command]
Options:
  -V, --version                 output the version number
  -m, --model <model>           LLM model alias to use for this invocation. Defaults to
                                default_model in config.toml.
  -p, --prompt <prompt>         Run one prompt non-interactively and print the response.
  --output-format <format>      Output format for prompt mode. Defaults to text. (choices: "text", "stream-json")
  --add-dir <dir>               Add an additional workspace directory for this session. Can be
                                repeated. (default: [])
  -y, --yolo                    Start in Ask When Needed mode: routine edits and commands run
                                automatically; risky actions, questions, and plans still ask.
  --auto                        Start in Never Ask mode: never interrupts you; everything runs and
                                is decided automatically. (default: false)
```

**受控启动模板**（数组；`executionReceipts.ts` 按它渲染 argv）：

```
kimi -p <prompt> --model <model> --output-format text
```

- `-p` = 非交互一次性执行，**与 `--auto` / `-y` 互斥**（实测）：
  `kimi -p "…" --auto` → `error: Cannot combine --prompt with --auto.`（`-y` 同）。
  所以模板里**不带**这两个开关；无人值守的权限口径由受控配置的 `default_permission_mode`
  决定（本机实测 = `"auto"`），会话内不再向人提问。
- 文档式一次性探测（`--version`）走 `kimi --version`，**不**启动会话。
- **Windows 上 PATH 里给的是 `.cmd` 垫片**（`…/.openagents/nodejs/kimi.cmd`，内容是
  `"%_prog%" "…/dist/main.mjs" %*`）。Node 侧直接 `spawn` 这个路径会失败（实测报
  `'…kimi.CMD" "-p" …' 不是内部或外部命令`），必须经 cmd 启动——协调器实测用
  `spawn('"<bin>" "<arg1>" …', { shell: true })`（等价 `cmd.exe /d /s /c`）。
  塔台侧只给 `bin` 与 `argv`（`LaunchPlan.bin` / `.command`），平台启动细节归协调器。

### 2.2 一次性执行实测（真跑过）

```
$ KIMI_CODE_HOME=<隔离副本> kimi -p "只回答两个字：收到" --model deepseek-v41-flash --output-format text
<stdout> • 收到
<stderr> kimi version 0.41.0
         To resume this session: kimi -r session_955156a3-f6cd-438b-9ad1-a784b2af0c3b
exit=0
```

**真代码任务（无人值守）实测**：在 `os.tmpdir()` 的隔离小项目里（`calc.mjs` 的 `multiply` 只会抛
`TODO`，`test.mjs` 红），用同一个模板跑：

```
$ cd <隔离目录> && kimi -p "只改当前目录里的 calc.mjs：把 multiply(a, b) 实现成整数乘法（return a * b）；其它文件一律不动；改完运行 node test.mjs，必须看到 PASS 且退出码 0；最后用一句话报告你改了什么、测试结果如何。" --model deepseek-v41-flash --output-format text
<stdout> • I'll start by reading the two relevant files.
         • Now the single edit:
         • 我把 `calc.mjs:2` 的 `multiply(a,b)` 从抛错改为 `return a * b`（只动了这一个文件），运行 `node test.mjs` 输出 `PASS` 且退出码为 0。
<stderr> kimi version 0.41.0
         • Run node test.mjs, capturing output and exit code.PASS
         exit code: 0
exit=0（用时 5.7s）
```

结论：`kimi` **可以无人值守调用**——不需要人工登录交互，会自己读文件、改文件、跑验证命令；
stdout 是回答、stderr 带版本与执行的命令回显，退出码 0。完整演练（含打断与恢复）见
`.工作台/evidence/V06-11/1/drills/`。

### 2.3 配置标识（哪个文件在生效）

- 生效的配置根由环境变量 `KIMI_CODE_HOME` 决定（作者本机实测值不录入，以你机器的实际值为准）
  （`kimi doctor` 读的就是它下面的 `config.toml`）。
- 该 `config.toml` 的实测关键项（**只列键名与取值，不含密钥**）：
  - `default_model = "deepseek-v41-flash"`
  - `[models.deepseek-v41-flash]` → `provider = "deepseek"`、`model = "deepseek-flash"`、
    `display_name = "DeepSeek V4.1 Flash (正式版)"`、`capabilities = ["thinking","image_in","tool_use"]`
  - `[providers.deepseek]` → `base_url`、`api_key`（凭据在本机配置文件里，值不入档）
- **两处配置目录不是同一个**：`~/.kimi-code/config.toml` 也存在，但它的 `default_model` 是 `kimi-code/k3`
  且 DeepSeek 走本机网关。**生效的是 `KIMI_CODE_HOME` 指向的那份**。核配置时先看 `KIMI_CODE_HOME`，
  别照着 `~/.kimi-code/` 下结论（本机两份内容不同，已实测）。

与 DESIGN §1.5 的对应：**Kimi Code（DeepSeek V4.1 Flash）= `kimi` + `--model deepseek-v41-flash`**。
全局默认值（`default_model`）**不由塔台改**：本卡只读，回执里记"实际用的 model"。

### 2.4 隔离工作目录与 hooks（实测踩到的坑）

- 隔离工作目录约定：协调器把子进程 **cwd 设为隔离目录**，Kimi Code 的项目规则从 cwd 往上找；
  演练目录用 `os.tmpdir()` 下的临时目录，项目内执行落在 `<项目>/.工作台/runs/<task>/<attempt>`。
  **不把项目根当执行目录**（`assertIsolatedWorkspace` 明文拒绝）。
- 全局配置里挂有会话级 hooks（`UserPromptSubmit` / `SessionEnd` 会调第二大脑的 python 脚本）。
  交互式用没问题，但**无人值守演练会顺着 hooks 碰真实项目的资料库**。所以演练按"**隔离配置副本**"跑：
  把 `config.toml` 复制到临时 `KIMI_CODE_HOME` 并**去掉 `[[hooks]]` 段**，用同一个
  provider/model 跑真实模型调用。**全局配置一律只读，本卡不改用户的 `config.toml`。**

---

## 3. Claude Code（协调器）——启动方式与配置标识

### 3.1 启动方式（`claude --help` 实测片段）

```
Usage: claude [options] [command] [prompt]
Claude Code - starts an interactive session by default, use -p/--print for
non-interactive output

  --bare                                Minimal mode: skip hooks, LSP, plugin
                                        sync, attribution, auto-memory,
                                        background prefetches, keychain reads,
                                        and CLAUDE.md auto-discovery. ...
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --allowedTools, --allowed-tools <tools...>
      Comma or space-separated list of tool names to allow
  --bg, --background                    Start the session in the background and
                                        return immediately. ...
  --append-system-prompt <prompt>       Append a system prompt to the default
                                        system prompt
```

**受控启动模板**：`claude -p <prompt> --bare`（`--bare` 跳过 hooks/插件自动发现，
无人值守时不会顺手跑用户会话脚本）；档位用 `--effort <low|medium|high|xhigh|max>`。
Windows 上同样是 `.cmd` 垫片（`…/.openagents/nodejs/claude.cmd`），Node 侧要经 `shell: true` 拉起。

### 3.2 一次性执行实测（真跑过）

```
$ ANTHROPIC_BASE_URL=http://127.0.0.1:3456 ANTHROPIC_AUTH_TOKEN=<本机网关令牌> ANTHROPIC_MODEL=glm-5.3 \
  claude -p "只回答两个字：收到" --bare
<stdout> 收到
<stderr> "glm-5.3" isn't described by this version's model catalog; ... [claude-code:unrecognized_model] {"model":"glm-5.3","query_source":"sdk"}
exit=0
```

结论：`claude -p` **可以无人值守调用**；stderr 那条 `unrecognized_model` 是本地网关模型名不在
Claude Code 自带目录里的提示（本机网关配置导致，**不是**本卡要改的东西），退出码仍为 0，实测如实记录。

### 3.3 配置标识

- `~/.claude/settings.json`：`env` 段把 `ANTHROPIC_BASE_URL` 指向本机网关（`http://127.0.0.1:3456`），
  `ANTHROPIC_AUTH_TOKEN` 为本地网关令牌，`model` = `opus`，`permissions.defaultMode = "bypassPermissions"`，
  并挂有 `SessionStart`/`UserPromptSubmit`/`SessionEnd` 三个 hooks（调第二大脑的 bat）。
  **本档案只记键名**；演练用 `--bare` 绕开 hooks，不改这份配置。
- `~/.claude/AGENTS.md`/`CLAUDE.md`：全局规则（实测中提示主对话模型与子代理模型的约定）。
  **塔台不改它们**：模型默认值属于用户自行选择（DESIGN §1.5 末句「当前用户自行选择工具/模型/档位」）。
- `~/.codex/` 存在，但**本卡不涉及**（`codex` 不在 V06-11 的链路上，未实测其启动方式）。

---

## 4. 谁负责什么（§6.5 权限边界，落到本机）

| 事 | 谁做 | 落点 |
| --- | --- | --- |
| 启动/终止执行进程、选隔离目录、收 stdout/stderr/退出码 | 外部协调器（Claude Code 或用户手上的协调入口） | 塔台**不 spawn 任何进程**：`executionReceipts.ts` 只产出启动计划与回执协议 |
| 记录启动/心跳/检查点/停止/交付、实际客户端/model/effort/workspace、父执行 | 协调器提交回执 | `execution.start_requested` / `started` / `heartbeat` / `checkpoint` / `stop_requested` / `stopped` / `delivered` |
| 外部动作前声明 `effect_id`/目标/授权/核实方法，动作后关联实际结果标识 | 协调器 | `execution.effect_declared` / `effect_confirmed` / `effect_unverified` |
| 认领、租约、结果提交的五查 | 塔台（V06-10 已交付） | `claims.ts`（心跳事件 ≠ 租约续约：续约仍走 `renewClaim`） |
| 已提交卡的受控重开（新 attempt、旧 token 即刻作废、旧结果与证据永久保留；不产生执行事实、不恢复旧绿） | **协调器**（V09-10 已交付；`role` 声明之外还要 `reopen_basis` 可取回，取不回即拒——DESIGN 附录 F/E.4） | `claim_task` 的 `op=reopen` → `claims.reopenTask`（唯一写入服务边界同一份 `verifyReopenCommand` 判据，直连写口不能旁路） |
| 恢复时核对旧进程/未提交改动/任务版本/外部效果 | 协调器按塔台给的计划做 | `planRecovery()` + 注入的真探针（`ExecutionProbe`） |

**命令模板只从受控配置来**：项目可以放 `<项目>/.工作台/agents.json`（`{"clients":[…]}`）覆盖/追加档案，
模板必须是 **argv 数组**；调用方给**字符串命令**（例如从模型回答里抄来的命令行）一律拒收
（`COMMAND_FROM_TEXT_REJECTED`，DESIGN §6.5「模型生成的说明文本不能直接成为命令」）。

---

## 4.1 MCP 读口的同源边界（2026-09-24 V09-08；DESIGN.md 附录 E.6）

外部执行者拿到的**状态**必须与用户在六图上看到的同源；v1 兼容读数必须**点名自己是兼容读数**。
三个读口的现行口径（工具描述与返回体逐字一致，改动见 PLAN V09-08）：

| 读口 | 给的是什么 | 状态口径 | 兼容/旧态标注 |
| --- | --- | --- | --- |
| `get_arch` | **技术详情层**（模块方框图 / 数据流向图 / 思维导图三张共用的代码关系数据：顶层代码模块 + 依赖边 + 聊天补全节点） | **已迁移项目**：模块状态＝**v2 证据派生**（映射到该模块的任务 `display_status` 汇总，DESIGN 附录 D）：`status`＝派生上屏键、`status_display`＝短标、`status_source` 恒 `v2_evidence`；**映射不到写「无状态记录」**（没有已发布蓝图时同样全部「无状态记录」，不回退 v1） | **未迁移项目（v1）**：原样返回共用渲染数据（`progress.json` 四色原样，不另加状态来源字段），形状逐字不变；已迁移项目不再把 `progress.json` 自报四色当状态（报告 02 G-07）；规划层（能力/声明模块/任务）与逐对象状态看 `project_entry` 或状态投影 |
| `list_tasks` | 任务行（§2.3.4 全字段）＋ `projection` | 已迁移项目：行来自 **v2 事件账本**（逐行 `ledger_source`/`v2_status`），`projection.last_seq` **与行同源** | 旧 `.工作台/tasks.json` 快照自己的序号在 `compat_snapshot_seq`，落后时 `stale=true`；未迁移项目整份读 v1 台账文件（形状逐字不变） |
| `read_progress` | Gate 状态 ＋ `modules` 四色 | `modules` 是 `progress.json` 的 **v1 兼容读数**（自报进度），**不是 v2 状态** | 已迁移项目回 `modules_projection`（明说口径）；`tasks_projection` 同 `list_tasks`；未迁移项目不带这两个键 |

对账（§4.5）在过关现场与三图上是**同一份**判据：`only_in_code` 逐条带 `category`
（`actionable_mismatch`／`outside_scope`／`structural`），界面**分类分计**——只有前者才叫「对账差」；
声明模块的状态继承只认材料点名了「实现落点」的配对（附录 E.7 裁定①）。

## 4.2 数据流向图的来源分层（2026-09-24 V09-11；DESIGN.md §3.2／§11.2）

**别把技术详情三图上的静态依赖渲染读成业务数据流**——这是本轮的硬口径：

- **当前实现**：三张技术详情图（模块方框图／数据流向图／思维导图）共用同一份**静态 import 依赖层方向渲染**。
  它画的是代码依赖方向，**不是业务数据流**，也不证明质量通过。
- **目标语义**：数据流向图要给出业务/项目数据从**输入源 → 处理节点 → 存储 → 输出/外部系统**的实际路径；
  关系＝数据的**产生／传递／读写／转换**；每条关系带**稳定 ID、方向、逐条出处**（`design_declared`／
  `code_static`／`code_measured`，归不进三档标 `unverified`）与**验证态**（`verified`／`unverified`／`missing`）。
- **静态 import 只作线索**：它只进 `static_clues`，**永不计入出处档位**，也**不得**据此生成「已验证」的数据边。

两句话在**同一处**同时给出、互相区分：数据流向图页签的画布上方（`data-flow-current-implementation` /
`data-flow-target-semantics`）、`get_arch` 的 v2 返回体（`data_flow.current_implementation` /
`data_flow.target_semantics`）与本文档。**未迁移项目（v1）的 `get_arch` 返回体不加任何字段**（形状逐字不变）。

`data_flow` 里另给三样（口径见 `src/ui/arch/projectGraph.ts` 的 R1–R6；派生见 `src/arch/dataflow.ts`）：

| 字段 | 给的是什么 | 怎么判 |
| --- | --- | --- |
| `nodes` / `edges` | 实体（输入源/处理节点/存储/输出·外部系统）与关系（产生/传递/读写/转换），各带稳定 ID、方向、出处与验证态 | `verified` **⇔ 至少一条有效的 `code_measured` 出处**（可复跑脚本＋登记在 `package.json`＋脚本正文提到该路径）；设计声明与代码静态分析只能支撑 `unverified`；一条有效出处都没有 ⇒ `missing` |
| `chains` | 该项目至少一条**端到端数据链**（逐跳带节点 ID、进入该跳的关系、角色、验证态与出处） | 链 `verified` **⇔ 四类实体齐全且逐跳节点与关系都到 `verified`**；缺一环而仍标已验证即不合格（缺的类别进 `missing_kinds`） |
| `coverage` | 对项目**所声明的**每个数据输入／存储／输出**逐条**对账（不抽样、不用几条边代表全量） | 每行要么给路径与证据，要么带 `gap` 进 `missing_paths`；`missing_paths` 非空 ⇒ `deliverable_blocked: true`，**不得**得出「项目可交付」结论。设计自己写明「尚未实现／未引入」的行单列，既不算已覆盖也不计入缺路径 |

**出处一律复算**（R3）：`find` 定位片段必须在 `path` 的 `locator` 处原样出现（设计书按章节区间、代码按行、
实测按脚本行）；复算失败、文件不存在、行号越界、脚本未登记的出处**一律剔除**（`scan.notes` 逐条留因），
并按剔除后的证据重判验证态——不保留已经不作数的出处。**不新增任何运行时侵入采集**；同时**不因**「不要求
侵入采集」而降低真实路径的证据要求。

可复跑判据：`pnpm verify:v09-11`（正例 0 违规 + 每类反例逐条被判违规 + 全仓禁止句式 0 命中）。
HTTP 读口：`GET /api/projects/:id/arch/dataflow`（只读，与 `get_arch` 的 `data_flow` 同一份派生）。

## 4.3 六图完整状态的读取（2026-09-26 V09-19；DESIGN.md §6.4／§6.7、附录 E.18 四）

常规接续优先 `task_brief`，旧连接未提供时使用 `project_entry`。简报默认 detail=summary，复用完整判据，保留所有理由的阻断标记及短摘要、当前任务完整约束、所有权、版本和必读材料；摘要省略部分不能当作已读。按返回指引用 detail=reason 与 reason_index/reasons_revision 补取，版本改变需重取摘要；detail=full 保留旧完整简报。状态未变且没有新动作时不重复拉取。阶段材料按 `required_reads.path` 与实时 `range` 读原文，其 `section` 是哈希绑定定位，不是 `read_design`/`read_plan` 的同名参数。条目另带 `purpose` 分类（`required_content` 先读正文／`trace_reference` 按需回读／`resume_context` 续接现场）；设计引用派生条目另带 `resolution`／`source_ref`，`resolution=unresolved` 表示该条依据**现在定位不到**（**不是已读、不是已通过**），按 `source_ref` 用 `read_design(index=true)` 或按 `range` 补取核实，**不得用近似标题顶替**。同步阻断存在时，简报的 `sync.repair_plan` 在默认 `detail=summary` 下是**紧凑导航**（`nav:true`；现行批次数、逐 `verdict` 项数、阻断批次数、等待派生计数、有界每批摘要与结构化 `refetch`），`detail=full` 与 `read_sync_status` 仍给**完整逐项**修复计划（不删 `expected`/`actual`/原因/候选）。涉及架构判断时，仍按下述方式取齐完整图。

**Agent 不该为了拼出六图先去读仓库代码。** 接续入口 `project_entry` 现在带一份**六图摘要**，
完整状态由 `get_project_graphs` 一次给全：

- **`project_entry` 的 `graph_summary`**（简短，不内联整图）：六图各一行（键/标题/层/节点数/关系数/分组数/同组关系数/被截断数）＋
  **同一快照标识** `snapshot_id`＋基线 `baseline_id` 与生成时刻 `generated_at`＋可用性 `availability`（published／draft_only／none）＋
  **更新中或过期状态**（`update_state`/`update_phase`/`update_reason`/`update_eta_text`/`banners`）＋**异常** `anomalies`＋
  交付读数与用户待验数＋**下一读取入口** `next_read_entry`。
- **`get_project_graphs` 四档**：① 缺省＝**全部六图**；② `graph=<六图之一>`；③ `node_id=<稳定 ID>`；④ `relation_id=<稳定关系 ID>`。
  另有读取模式 `mode`：缺省 `overview`（概览，人看概要）；`mode=full`＝**全量模式**取回概览聚合隐藏的节点/关系。
  六图键：`functional`（功能全景）／`architecture`（系统架构）／`construction`（施工依赖）／`module_map`（模块方框图）／
  `data_flow`（数据流向图）／`mind_map`（思维导图）。
- **逐对象给什么**：稳定 ID、名称、**状态键**与**界面短标/颜色口径**（同一份 `statusColor.ts`）、来源（需求/设计/代码）、
  映射（需求 id／设计章节／代码模块）、**证据状态**（verified／unverified／missing／invalidated／user_pending）、
  **有效版本**、**阻断原因**、**用户待验标记**。
- **技术图来源分层**：`module_map`／`data_flow` 的 `counts.by_origin={code,plan,chat}` 给三类计数，逐节点带 `origin_layer`（`code`／`plan`／`chat`）——
  **「节点总数」不等于「代码模块数」**（塔台实测 80 节点＝8 代码模块＋72 规划对象＋0 聊天补全）。
  `by_origin` 只数**本图可见真实实体**（`__more__` 聚合占位不计入、不冒充代码模块）；**真实代码模块数**读 `counts.by_origin_underlying`（底层未聚合并集口径，两种模式同值），
  隐藏的真实代码模块数＝`by_origin_underlying.code − by_origin.code`（2026-09-29 返工 F4 定版）。
- **完整性（`mode=full`）**：`mode=full` 走**未聚合并集**、按 **4000 对象/页**在**同一快照**上分页续取
  （四段游标 `<snapshot_id>:<mode>:<graphKey>:<offset>`）；**没有 20000 生产上限**——`MCP_FULL_LIMITS=20000` 自 V09-22 返工起不再是生产读口上限，仅存于验证夹具。
  合并视图超限时给 `total`/`returned`／`incomplete:true` 与 `completeness.cursors`（逐图游标），带 `graph=<六图之一>` ＋对应游标把该图取齐：
  **`complete:true` 只表示本次请求图对象分页取完，不等于源码全覆盖**——采集完整性看顶层 **`collection`**（机器可判读：`status`＝not_parsed/unknown/incomplete/complete、`budget_exhausted`、`legacy_other_bucket`、`reasons[]`、`ignored_dir_segments[]`，2026-09-29 返工 F5 定版；与分页 `complete` 语义独立、可同时成立），人读解释另见各图 `notes` 与顶层 `anomalies`。
  概览模式（`mode=overview`）只适合人看概要，被聚合隐藏的对象不在其中；**不允许**静默截断后仍称「全图」。
- **模型待审线索单列**（`model_leads`／`model_node_leads`，标「未审定」）：不混进正式节点或正式关系、不计入任何验证读数（§4.1）。
- **三种「到哪一步」分开**（`separate_readouts`）：交付读数 `delivery.verdict`（可请求验收／不可判定项目可交付，
  **仍不等于用户接受**）、工作流 `next_action`、**用户 Gate** 各自表达，任一项都不等于「已交付」。
- **同源**：本读口不另算颜色或绿灯——图面走 `.工作台/arch/blueprint.json` 与 `buildViewModel`，技术详情走 `src/arch/render.ts`，
  数据流向走 `dataFlowLayerOf`，来源/映射/证据与交付阻断走 `src/ui/arch/provenance.ts`。**`get_arch` 仍是技术详情三图的代码关系层读口，本工具不取代它。**

## 4.4 读不到/更新中/损坏时怎么表现（如实，不粉饰）

- **没有已发布图**：`availability` 给 `draft_only`/`none`，并在 `anomalies` 里写明原因（草稿图**不可作施工依据**）。
- **图更新中/失败/过期**：`update_state` 给 `updating`/`failed`/`stale` 与原因；预计用时只给**有依据的实测值**，
  依据不足写「无法估计」——**不编造 ETA**。
- **能力分类声明表损坏**（V09-19 R-1）：`capability_classes.table_state="broken"` 并逐项点名受影响章节，
  未解析出分类的能力标 `unknown`、**不按功能能力计数**；该版图**阻断发布**（保留上次有效图并显示原因）。


---

## 5. 回执协议（协调器怎么把执行现场交回塔台）

实体：`execution:<execution_id>`（一个 attempt 一个 id；重派换新 id，不覆盖旧执行的记录）。
信封、版本、幂等与 V06-10 的认领一致：走唯一写入服务，失败码同层。

| 事件 | 何时提 | 关键字段 |
| --- | --- | --- |
| `execution.start_requested` | 拉起之前 | goal / argv_digest / template_source / timeout_ms / workspace；现场 = **启动请求中**（不是运行中） |
| `execution.started` | 进程确认跑起来 | `actual{client_id,client_version,model,effort,workspace,pid}` + 父执行（`parent_execution_id`/`parent_run_id`） |
| `execution.heartbeat` | 有信号时 | observed_at / awaiting_input / note；**缺失或超期都不等于停止** |
| `execution.checkpoint` | 阶段断点 | note / artifacts / worktree{head,dirty,changed_files} / effects_in_flight |
| `execution.stop_requested` | 请求停止 | reason / confirm_method |
| `execution.stopped` | 停止**已确认** | `confirmation`（必填，空则拒收 `STOP_NOT_CONFIRMED`）/ evidence / exit_code |
| `execution.failed` | 启动失败或运行失败 | phase(launch/run) / scene{message,exit_code,stderr_tail,argv_digest} / log_ref |
| `execution.effect_declared` | 外部动作**之前** | effect_id / target / authorization / verify_method / 外部幂等键 |
| `execution.effect_confirmed` | 动作**之后** | result_ref（必填：实际结果标识） |
| `execution.effect_unverified` | 效果查不清 | check_evidence；`retry_blocked=true`（暂停自动重试） |
| `execution.delivered` | 交付 | deliverables / evidence_refs / verification / untested / known_issues / diff_ref / exit_code / 实际客户端版本 |

**恢复顺序**（`planRecovery()` 出的步骤与 §5.4 逐字对齐）：
读最后检查点 → **查询外部动作的实际效果** → 确认旧 run 是否仍有写入可能 → 核对工作树与基线 →
判断成果/证据有效性 → 处理旧认领 → 建立新 attempt → 继续。
结果不明（进程查不清 / 效果待核实）时 `blind_replay_blocked = true`：**不盲重放**；
要往**同一个可写目录**派新执行，必须先有"停止已确认"，否则换隔离目录（`dispatchGuard`）。

### 5.1 Agent 完整上报的 MCP 入口（V09-27／V09-28，契约 F3/F1，2026-10-02）

- `report_execution`：上表事件链的 Agent 入口。每次带 `project_id` / `task_id` / `run_id` / `attempt_id` / `workspace` / `claim_token` / `change_id`（**只接当前认领持有人**），`op` 取 `start_requested|started|heartbeat|checkpoint|stop_requested|stopped|failed|delivered|effect_*`；`stopped` 必须带 `confirmation`（缺则 `STOP_NOT_CONFIRMED`），**心跳缺失不等于停机**。示例：`report_execution {op:"checkpoint", task_id:"T-1", run_id:"run-T-1-1", attempt_id:"att-T-1-1-…", workspace:".工作台/runs/T-1/1", claim_token:"…", change_id:"change-…", note:"改到一半", artifacts:["src/x.ts"]}`。
- `record_work_evidence`：证据与审计的 Agent 入口。`op=store` 把证据正文交**唯一写服务宿主**落盘（不可变、内容寻址；`kind="source_manifest"` 时带 `source_manifest` 有限文件清单，服务端现读算哈希）；`op=read` 按 `sha256` 读回；另有 `submission`（成果登记）／`self_check`（作者自检）／`independent_audit`（审计者须≠作者、五视角覆盖）／`fix`／`retest`／`finding`。示例：`record_work_evidence {op:"store", role:"executor", kind:"self_check", summary:"自检输出", content:"…", binding:{revision_kind:"code", revision:"<sha>"}}`。**不暴露人工验收/用户接受风险**，也不接受 `role=user`。

源清单按两步登记：先 `store`（`kind=source_manifest`、`source_manifest:[{path:"src/x.ts"}]`，载体绑定声明 `revision_kind=code`），取回 `evidence.source_manifest.fingerprint` 和 `evidence.sha256`；再登记自检/独审，用该指纹填 `binding.revision`、用该证据地址填检查项 `evidence_sha256`。载体登记时的版本标识只是自报，检查采用服务端现读得出的清单指纹。历史无清单记录保留，但不能据此宣称当前源码已验证。

- `manage_baseline`：正向成套图纸入口。`op=read` 只读两份源与生效基线（零副作用）；`op=preserve` 存不可变历史；`op=activate` 用**已有**图纸做技术审定激活（固定 `delegated_technical_review`，须带两份源 `expected.{design,plan}_content_sha256` 与 `approved_by`/`approval_basis`；零差异、不调模型、不写用户 Gate）。示例：`manage_baseline {op:"activate", role:"designer", approved_by:"gpt-6", approval_basis:"技术审定", expected:{design_content_sha256:"…", plan_content_sha256:"…"}}`。

- `preflight_task_result`（V09-47／P2，只读预检）：`submit_task_result` **同形输入**（面向前述已取得合法认领的执行者）；提交前**一次列清**可预判缺项与**锁内未查项**（`not_checked` 与 `not_applicable` 分开、不混用）。**只读**：不写事件/证据/租约、不自愈、不产生认领；**不是门禁、不是通行票**——预检到提交之间版本/认领/租约可能变化，提交时在唯一写入服务临界区内按当前事实**重核**（`recheck_on_commit=true`）。响应带 `supported_contract:"preflight/v1"`；命中已提交的同一幂等键 ⇒ 短路、只返回 `already_submitted`＋原回执（**不冒称当前校验通过**）。宿主不支持该只读路由（旧宿主）⇒ `UNSUPPORTED_BY_HOST`，**绝不回退**到 `submit_task_result`，也不在 MCP 进程本地另算一套判据。宿主侧路由 `POST /api/work/preflight`（`claim_token` 业务秘密走 body，与传输令牌 `x-tatai-work-token` 头是两回事；只读远程模式下由远程红线先拒）。

四件事分开记：**阶段自报**（`report_task_status` 的 v2 `doing`/`blocked`/协调器 `ready`；`done` 不在这里写，走 `submit_task_result`）／**提交**（`submit_task_result`，带证据/认领/版本五查；相同请求重试拿回原回执 `duplicate=true`）／**执行回执**（`report_execution`）／**证据与审计**（`record_work_evidence`）。四类写一律经唯一写入服务转接，MCP 进程不自己追加事件（§2.6）。完整旅程（真 stdio MCP + 真 `index.ts`）见 `scripts/verify-forward-journey.ts`（`pnpm verify:forward-journey`）。

---

## 6. 不可启动路径（缺什么就报什么，不替用户选服务）

`resolveStartable({project_id, client_id})` 的四条结论：

| 结论 | 触发 | 现场 |
| --- | --- | --- |
| `CLIENT_NOT_CONFIGURED` | `client_id` 在（项目受控配置 ∪ 内置实测档案）里没有条目；或受控配置文件坏/条目非法 | 逐条列缺什么；**不退回内置后假装能用** |
| `CLIENT_UNAVAILABLE` | PATH 上找不到该 CLI 的可执行文件 | 报"声明可用但二进制不在" |
| `CREDENTIAL_MISSING` | 档案里声明的凭据项检查不过（只报在不在） | 逐条列缺哪一项凭据 |
| `OK` | 档案在、二进制在、凭据齐 | 转述实测版本与隔离目录约定 |

三条硬口径：

1. **不替用户选择新服务**：不可启动就停在这里（`NO_SUBSTITUTE_NOTE` 逐字在场），
   不自动换 provider/model/客户端顶上（§6.5）。
2. **启动失败须回报失败及现场**：`execution.failed` 必须带 `scene.message` 与现场（退出码/stdout-stderr 位置），
   **不能**先把任务标成运行中（§6.5）。启动失败时事件现场里没有 `execution.started`。
3. **不改全局模型默认值**：塔台只记"实际用的 model/effort"，用户的 `config.toml`/`settings.json` 一律只读（§1.5 末句、卡面交付）。

---

## 7. 复跑本档案（实测命令清单）

```bash
kimi --version                     # → 0.41.0
kimi doctor                        # → 认 KIMI_CODE_HOME 下的 config.toml
kimi --help                        # → -p / --model / --output-format（-p 与 --auto/-y 互斥，实测报错）
claude --version                   # → 2.1.274 (Claude Code)
claude --help                      # → -p/--print、--bare、--effort、--bg、--allowedTools
echo "KIMI_CODE_HOME=$KIMI_CODE_HOME"
grep -n 'default_model\|deepseek-v41-flash' "$KIMI_CODE_HOME/config.toml"   # 只看键名，别把密钥贴进任何文件
ls "$(dirname "$(command -v kimi)")"/kimi.*        # → kimi / kimi.cmd / kimi.ps1（Windows .cmd 垫片）
```

塔台侧（确定性、不依赖真 worker）：`pnpm verify:v06-11`。

## 8. 未测 / 已知限制（如实）

- **未测**：`codex` 的启动方式（不在本卡链路，未实测）；`kimi acp`（ACP 服务端模式）未试；
  `claude --bg` 后台会话未试。
- `kimi -p` 的 `--output-format stream-json` 未用于回执解析（本卡只记录 argv 与退出码，不做流式解析）。
- 协调器若用 `claude` 拉起 `kimi`，两层都需要可用的凭据与配额；**本卡未做"跨客户端凭据转发"**，
  两个 CLI 各自读自己的配置。
- 真实演练只在 `os.tmpdir()` 的隔离小项目里做，**未**在三个真实项目里跑过外部 worker。
