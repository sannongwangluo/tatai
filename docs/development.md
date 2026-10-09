# 开发与验证

> 面向**从源码构建、跑验证、改代码**的人。安装使用见 [`getting-started.md`](getting-started.md)；桌面壳细节见 [`../src-tauri/README.md`](../src-tauri/README.md)。

## 1. 前置与版本口径

| 项 | 要求 | 说明 |
| --- | --- | --- |
| Node.js（开发/构建） | `^20.19.0 \|\| >=22.12.0` | 构建链是 Vite 7，它自己的 `engines` 就是这个区间（来源：`node_modules/vite/package.json` 的 `engines`）。**20.0–20.18 或 22.0–22.11 会在 vite 启动时被挡下** |
| Node.js（只跑运行态） | ≥ 20 | 桌面壳照旧复用系统 Node 跑本地服务，只做存在性探测 |
| pnpm | **12** | CI 钉 `version: 12`；锁文件 `lockfileVersion: 9.0`。**别依赖"Node 自带 corepack"**（新版 Node 已弃用、后续不再随带）；用 `npm i -g pnpm@12` |
| 包管理器 | 只用 pnpm | 不混入其他锁文件 |

**推荐直接用现有 LTS 22.12+**，不用为塔台改环境。首次上手 `pnpm install`；**复现环境**（本地对齐 CI）用 `pnpm install --frozen-lockfile`。

## 2. 从源码跑起来

```bash
git clone https://github.com/sannongwangluo/tatai.git
cd tatai
pnpm install
```

起服务（两个终端，各跑一条）：

```bash
pnpm dev:server    # 后端：http://localhost:8787（探活 GET /health）
pnpm dev           # 前端：http://localhost:5173
```

浏览器打开 **http://localhost:5173**，左栏「＋ 添加项目」填一个本地项目目录，即完成接入（塔台只往该项目的 `.工作台/` 写它自己的数据，见 [`getting-started.md`](getting-started.md) 第 4 节）。

其他常用命令：

```bash
pnpm typecheck     # tsc --noEmit
pnpm build         # 前端产物 dist/
pnpm build:server  # 随包后端（含 THIRD-PARTY-NOTICES.txt）
pnpm mcp           # 开发态 MCP 入口（= tsx src/mcp/index.ts，只在仓库根目录手动调试用）
```

## 3. 桌面壳（可选，需 Rust 工具链）

桌面壳需要 Rust 工具链，且 PATH 里要有 node ≥ 20；安装包只出 Windows。

```bash
pnpm tauri:dev     # 起壳窗口：beforeDevCommand 先 pnpm build:server 再 pnpm dev
pnpm tauri:build   # 一条命令打安装包 → src-tauri/target/release/bundle/{nsis,msi}/
```

两条都不需要你先手动跑 `pnpm build` / `pnpm build:server`——各自的前置命令会自动带上。**`resources/server` 在 dev 态也缺不得**：`bundle.resources` 无条件声明它，没有它壳一启动就报 `resource path 'resources\server' doesn't exist` 直接退出。

`pnpm tauri:build` 走**包装器**（`scripts/tauri-build.ts`）：构建成功后写一份**构建戳**（`scripts/lib/buildStamp.ts`，记本次构建的源码内容指纹），再自动跑 `pnpm package:bind` 把产物与源码绑定（`binding.json`）。**不要绕过包装器**：直接 `pnpm exec tauri build` 再单独跑 `pnpm package:bind` 会因**缺戳**被拒。

完整口径（随包链路、`WebView2Loader.dll` 的坑、进程树收口、权限最小集）见 [`../src-tauri/README.md`](../src-tauri/README.md)。

## 4. 验证脚本清单

每张施工卡都留了可复现的验证脚本，`pnpm verify:<卡号>` 即跑。下面这份清单是"哪块东西当初是怎么验的"，按需查。

### 4.1 跑之前先看这几条（涉及真实数据的边界）

- **只跑表里明确标注自带临时夹具（临时 `TATAI_HOME`）的脚本**，其余一律按"会碰真实数据"对待、先审再跑。**别把"所有脚本都安全"当前提**：未经逐条审计，就不下这个结论。
- **老脚本不止读、还可能写真实数据**：`scripts/lib/fixtures.ts` 的 `ensureSelfRegistered()` 在缺 `tatai` 记录时会往全局 `registry.json` 写一条；`verify:intent-path` 就属这一类。此外 `verify:a1/a2/a4/a5`、`b1/b3`、`f2/f3/f4`、`check:graph`、`m4`、`n1/n2/n3`、`v09-08/11/13/17`、`verify:intent-path` 等还会读真实注册表、本仓库正文或目标项目的 `.工作台/`。**只设 `TATAI_HOME` 指向临时目录，兜住的是全局数据目录这一侧，兜不住仓库正文与目标项目 `.工作台/`**——要在这上面做真实验证，先读脚本，再用可丢弃的仓库/项目副本加一个独立的临时 `TATAI_HOME` 跑。
- **会写真实台账/真实配置的命令别在陌生环境顺手跑**：`migrate:real`、`backfill:*`（写真实项目事件账本）、`remote:token` / `remote:write`（改真实远程口令与写开关）。
- `verify:v09-18` 依赖作者私有证据目录，缺 `TATAI_V0918_EVIDENCE_DIR` 时对应段 SKIP。
- **环境变量口径**：需要 `TATAI_HOME`／`TATAI_REAL_IDS` 等变量而没设时，依赖它们的段落显式打印 `SKIP` 并让脚本以**退出码 3** 收尾（"没跑全"，不算失败；`0` = 全跑全过，`1` = 有断言 FAIL）。

### 4.2 全量清单

| 脚本 | 验什么 |
| --- | --- |
| `pnpm verify:registry` / `verify:onboard` / `verify:r3` / `verify:r4` | 项目注册表读写层（自带临时 TATAI_HOME，不碰真实注册表）、项目接入（kind 判定 / gitignore 提示）、列表与添加的 HTTP 层、选中态与最近打开 |
| `pnpm verify:g1` / `g2` / `g3` | `.工作台/` 存储层唯一性、Gate 时间线视图、Gate 状态机与历史 |
| `pnpm verify:d1` / `d2` / `d3` | 设计书只读视图、待议记录追加、落稿流程 |
| `pnpm verify:c1` / `c2` / `c3` | 聊天会话存储、流式渲染、落稿入口 |
| `pnpm verify:h1` / `h2` / `h3` / `h4` | 文件监听与变更流水、SSE 推送、独立变更子页面、监听加固（大项目降级 / 合批 / 背压 / 句柄回收） |
| `pnpm verify:t1` / `t2` | 终端 PTY 基础与终端视图（真 PTY 字节流对照） |
| `pnpm verify:b1` / `b2` / `b3` | 项目扫描器、逆向落稿流程（读真实注册表与项目，见上方边界） |
| `pnpm verify:a1` / `a2` / `a3` / `a4` / `a5` | 架构图混合管线：静态解析、起名与硬上限、方框图渲染、下钻展开、四色与对账标黄（部分卡读真实项目） |
| `pnpm verify:f2` / `f3` / `f4` / `check:graph` | 两视图共用数据层、数据流向图、两视图切换（位置不丢 / 不重解析）、两视图一致性（读真实项目） |
| `pnpm verify:n1` / `n2` / `n3` | 思维导图（markdown 导出回查 / 折叠与性能 / 三视图互相定位）（读真实项目） |
| `pnpm verify:e1` / `e2` / `e3` | 多终端分屏、日志着色（逐字节对照）、命令历史（含密码不落盘反证） |
| `pnpm verify:v1` | 流程实况视图（五源合成 + 超时变色） |
| `pnpm verify:p2` / `p3` | 跨项目视图（汇总口径逐条对账）、全局变更流（10 万行夹具上的首屏与翻页耗时） |
| `pnpm verify:m1` / `m2` / `m3` / `m4` | MCP 工具集与 Agent 管理面板（m4 读真实注册表） |
| `pnpm verify:u1` / `u2` / `u3` | 桌面壳接入、随包后端集成（包内入口真起 + 真 MCP 客户端连上 + 安装目录零写入）、安装包产物逐条对账（读本机构建产物） |
| `pnpm verify:s1` / `s2` / `s3` | 远程九条红线、只读远程、写模式与访问审计 |
| `pnpm verify:l3` | 空模板（`templates/.工作台.example/`）：结构逐项对齐设计书 §2.2、零真实数据自查、冷启动接入、模板 ↔ 代码 schema 防漂移 |
| `pnpm verify:intent-path` / `verify:f-37f129` / `verify:review-arch-badges-ui` | 2026-09-25 复核批次（`change-20260925-review-fix`）：①`intent.json` 来源路径补齐；②记录性 PLAN 改动后基线重激活的 `revision_object_tampered` 修复；③架构主视图来源/证据徽标（H-4 解除）真浏览器 61 断言全过 |
| `pnpm verify:c015-service` / `c016-blueprint-authority` / `c014-outbox-real` / `t19-parse-run` / `c017-usage` / `budget` / `c017-budget-race`（含 `-ui` 段） | 2026-09-21 收口批次：写侧唯一入口与引用完整性、派生蓝图权威与继承事实登记、outbox 断线待提交生产接入端到端、解析后台可取消与 UI 闭环、认领配额与用量统计 |
| `pnpm remote:token` / `pnpm remote:write` | 远程口令管理与写模式开关（**改真实配置**：token `show`/`rotate`；write `status`/`on`/`off`） |

> 下面两表的 `v0.6`／`v0.7`／`v0.8`／`v0.9` 是**内部施工批次代号**（与脚本名 `verify:v06-*`／`v07-*`… 对应），**不是产品版本号**；产品版本以 [Releases](https://github.com/sannongwangluo/tatai/releases) 为准。

| 脚本 | 验什么 |
| --- | --- |
| `pnpm verify:v06-01` ~ `verify:v06-14`（含 `-b/-c/-d/-e/-f/-a` 派生卡与 `-ui` 浏览器段） | v0.6 十四张施工卡：v2 唯一写入服务与离线降级、迁移与需求/变更、图纸基线、规划图派生与三视图、状态投影、项目入口与认领门禁、执行回执链、检查与验收面、注册表恢复 |
| `pnpm verify:v07-01` ~ `verify:v07-04` | v0.7 四张卡：写入服务独立进程化与自愈、状态机工具面与事件面检查（`rebind_task`）、v2 迁移收口与历史状态回放、接续入口体验件（`doctor` / 设计书分段读 / 批次号自动生成） |
| `pnpm verify:v08-01` ~ `verify:v08-06` | v0.8 六张卡：欠账清理与迁移收口、图面色块与事实对齐、模块级验证口径与图面配色、声明链与证据链补全、语义层来源归一与「图正在更新」横幅、两处真显示缺陷修复 |
| `pnpm verify:v09-01` / `verify:v09-02` / `verify:v09-05` | 健康修复批次：判绿证据采信与检查记录一致性、系统架构主视图连线、接续入口与文档口径同步（三卡在账本里都在结果提交**之后**经历任务定义重导，**卡行当前为 `todo`／待对账**）。**同批其余 V09 卡的执行结果多已交付，但"交付结果 ≠ 已验收"**——**提交 ≠ 验收**：未逐卡独立审计、未用户验收的照旧不算完成，逐卡状态以 `PLAN.md` 的卡行与其「账本投影对照表」为准 |
| `pnpm verify:v09-06`（+ `verify:v09-06-ui` 真浏览器段） | 私有事实备份/恢复的**产品入口**——清单可读与同提交边界幂等、不合格备份一律判不合格、隔离恢复逐项核验且 `replaced:false`、四条路由真 HTTP 逐条对错误码；浏览器段真 DOM 验证（详见 PLAN 卡） |
| `pnpm verify:v09-08` | 对账配对修正与读口同源（`list_tasks`/`read_progress` 与 `last_seq` 同源；`get_arch` 状态口径分两支：已迁移项目 v2 证据派生、未迁移项目 v1 原样） |
| `pnpm verify:v09-11` | 数据流向图的口径落地与来源可追溯（「当前实现＝静态 import」与「目标语义＝输入源→处理→存储→输出」同时可见且互相区分；真实项目一条端到端数据链逐跳复算；覆盖对账从 DESIGN 声明区机械抽取逐条核对；R1–R6 判据成文且每条有反例真被拦下） |
| `pnpm verify:v09-12`（+ `verify:v09-12-ui` 真浏览器段） | 六图触发范围扩展与「正在更新／预计用时／失效」口径（深层模块/接口文件/跨模块依赖都能触发确定性重解析；防抖合批、生成物自触发忽略、重解析有界；浏览器段真 DOM 验证） |
| `pnpm verify:v09-13` ~ `verify:v09-20`（含 `-ui` 段与 `verify:v09-20-info-bar`） | v0.9 后续卡（含 V09-14 桌面壳进程树收口、V09-19 六图完整读口、V09-20 交付读数返工）。**V09-21 没有同名脚本**（`pnpm verify:v09-21` 不存在，别照旧表跑）——该卡的验证落在 `verify:v09-18`／`verify:v09-19`／`verify:v09-09-ui`；逐卡定义与证据见 `PLAN.md` 文末对应卡区 |
| `pnpm verify:v09-22` / `verify:v09-22-ui` / `verify:v09-22-mcp` | 2026-09-28 六图聚合节点全量可查看：概览默认不变＋「显示全部」＋MCP `mode=full` 取回隐藏对象；夹具（15/16/80/1000/2500 节点）与两真实项目全量逐 ID 对账、真浏览器交互实测（显示全部/搜索定位/键盘/缩放拖动/巨枝加载全部）。同日返工五契约：archItemsOf 上限外逐项取回、childrenOffset 稳定分页、full＝未聚合并集分页遍历、游标四段制绑定读取模式、草稿快照标识内容驱动（读数 114/0＋54/0/0） |
| `pnpm verify:sync-evidence` | 2026-09-30 V09-23 同步证据发现与完整性对账：登记面（闭键/来源实核/幂等/设计·协调权限）、supersedes 不缩分母·不改 `blocks_entry`、逐项 passed/missing/failed 与半写/坏字段/未知字段/转义同名键/遍历/junction/自引用/未登记不采纳、`task_states` `scope_mode`（at_registration 历史断言不被未来合法推进阻塞）、目标漂移·指纹自洽·并发零重复、接续阻断（entry/claim/直连写口/伪造假 passed 零字节/解阻/复阻）、graph_full 真实 builder fail-closed 不写死对象数、`collectProjectFacts` 不引 sync·互调 0 递归 0 超时、后台发现生命周期、HTTP 读口与 MCP 三接口同判据 |
| `pnpm exec tsx scripts/verify-sync-desktop-routes.ts` | 隔离真实桌面宿主：主动扫描与宿主只读状态可达，令牌/方法/路径边界有效；先断言核验成功，再检查重复扫描零新增；404 的零新增不能算幂等成功 |
| `pnpm verify:forward-baseline` | 2026-10-02 V09-28 正向成套图纸入口：工具入口红例（未知 op/错误角色/`user_confirmation`/缺依据/缺 expected/缺 kind 零写入）、read 零副作用、daemon 与新桌面宿主两场景的 preserve/activate（零差异建第一条、重复幂等 `created=false`、源变 `VERSION_CONFLICT`、激活不写 gate/events）、服务端强校验 expected（直连 work 面缺两份源哈希 400）、错方法/尾缀/无令牌边界 |
| `pnpm verify:forward-journey` | 2026-10-02 V09-29 正向闭环**完整旅程**：**真 stdio MCP 子进程（SDK client）＋ 真 `src/server/index.ts`（动态端口、隔离 home）**——工具面可发现且 schema 可调用、read/activate 基线、requirement/change/import、claim→doing/blocked/协调器解阻→checkpoint→submit（相同重试 `duplicate=true`）→自检/独审失败→reopen 新 attempt→修复/复测→夹具 HTTP 人工验收→新客户端重启接续；每步核对回执/读口/事件数一致与跨阶段语义 |
| `pnpm exec tsx scripts/verify-progress-reporting.ts` | V09-27 Agent 完整上报：经真实 MCP handler + 真唯一写入服务（进程内 + 回环 HTTP + 描述符）——阶段上报/幂等/反例、`report_execution` 回执链、`record_work_evidence` 证据/审计/缺陷、`submit_task_result` 重试拿回原回执、服务不可用不降级、重启接续 |
| `pnpm verify:v06-02` | 两份图纸的版本与审定（含塔台自身 PLAN 的行数点名断言；沿革见脚本内） |
| `pnpm verify:v09-50` | 2026-10-06 V09-50 源码依赖采集热路径等价优化：真实绑定下 import 收集走原生 tree-sitter query（非静默回退）；合成夹具逐文件 `FileImports{targets,loc,skip}` 与**手工推导期望**一致；"只扫顶层语句"的**红反例**；`too_large`/`unreadable` 两态分账；**故障注入回退**四种情况都**丢弃半结果、完整回退旧全树 DFS**。**默认自包含**（临时件落 `os.tmpdir()`，不扫私有目录）；外部等价 oracle 须**显式** `--baseline-module/--dataset/--extra-root`，缺必需输入即退出码 2 如实报错、不静默当绿 |
| **v0.4.0 批次（2026-10-06…10-09）新增／受影响的隔离验证脚本** | `pnpm verify:v09-03`（需求落地与追踪链，含 PLAN 剥离钉值与 V09-62 卡行负例）、`verify:feature-ledger`（+ `verify:feature-ledger-ui` 真浏览器段）、`verify:delivery-overview`（+ `verify:delivery-overview-ui`）、`verify:work-package`、`verify:host-work-package`、`verify:build-identity`、`verify:v09-04`——逐条断言与读数见 `PROGRESS.md` 对应批次与 `PLAN.md` 对应卡定义。全部走 `mkdtemp` 夹具＋隔离 `TATAI_HOME`＋回环随机端口，**不碰真实项目数据、不占 8787** |

各脚本的真实输出与逐条对照写在 `PROGRESS.md` 对应卡号的流水里。

## 5. 提交前的基础检查（与 CI 同口径）

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm verify:registry   # 注册表回归（自带临时 TATAI_HOME，不碰真实数据）
```

CI 只跑这四条，**刻意保持轻量**：不碰任何私有目录、密钥或真实项目数据。桌面壳（Rust/tauri）与真实安装包的构建**不在 CI 里复现**——那需要 Windows 本机工具链，由维护者在发布流程里跑。

## 6. 文档自身的机械校验

改文档后建议跑：

```bash
pnpm verify:v09-05   # README/上手文档的目录说明同源、工具计数与注册表恒等、安全口径如实、模板标注
pnpm verify:l3       # 空模板与 templates/README.md 的字段口径 ↔ 代码 schema 防漂移
```

`verify:v09-05` 需要真实数据目录（`TATAI_HOME`，缺省 `~/.tatai`）里的 tatai 台账与注册表；拿不到就如实报 FAIL，不假装通过。它对真实数据只读，真跑写盘一律落在 `os.tmpdir()` 的隔离夹具里。

它还**对照本仓库自己的 `.工作台/` 与 `templates/README.md`** 核对目录说明是否与真实结构一致——所以要在**塔台自己的开发树**里跑（本仓库是自举项目，`.工作台/` 就在仓库里）。在别的项目或一份干净 clone 里跑，那几条会如实红，不表示文档写错了。另外 `verify:v09-05` 会真调一次 `attachAgentsMd("tatai")` 复核幂等——由于注册表里 `tatai` 指向本仓库，它作用的也是**本仓库根 `AGENTS.md`**；调用只在"标记区已一致"的分支上执行（零写入），不一致时如实报红、不代你写。
