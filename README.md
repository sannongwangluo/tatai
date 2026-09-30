# 塔台 Tatai

**下载 Windows 版** → [Releases](https://github.com/sannongwangluo/tatai/releases/latest) ｜ [上手](docs/getting-started.md) ｜ [开发](docs/development.md) ｜ [更新日志](CHANGELOG.md) ｜ [![CI](https://github.com/sannongwangluo/tatai/actions/workflows/ci.yml/badge.svg)](https://github.com/sannongwangluo/tatai/actions/workflows/ci.yml)

> 一个人 + 多个 Agent，持续推进同一个项目。

塔台面向用 Agent 开发项目的非程序员：保存意图、设计书、施工安排、进度和验收证据，让换模型、换会话后的 Agent 有依据接着做。数据全部落在你本机，六图、任务账本、Gate、MCP、备份恢复这些核心功能不连网也能用。当前以作者自用为先，作者自行选择工具、模型和档位。

**English**: Tatai ("control tower") is a local-first desktop workbench for one person running multiple AI coding agents (Claude Code, Codex CLI, Gemini CLI, or any MCP-compatible agent) on the same project. Intent, design docs, build plans, tasks, progress and acceptance evidence live in one auditable event ledger that agents read and write through a single MCP interface. It covers multi-agent orchestration, spec-driven development, requirements traceability, acceptance gates and codebase architecture visualization (six graph views). Context survives model and session switches; "done" is only true with verifiable evidence; changing one document re-verifies only what it affects. Local-first, no cloud required. **Tatai does not start your agents for you and does not approve acceptance gates on your behalf.**

**适合谁**：你本机跑 Agent（Kimi Code / Claude Code / Codex 等），项目就在本地磁盘上，希望不同会话、不同模型接的是同一份事实，而不是各聊各的。

**不适合谁**：想找一个“输入需求就自动写完项目”的一键工具。塔台管理协作事实与执行请求，不负责启动或终止 Agent 进程（那是外部协调器的职责），也不代替你验收。

## 它解决什么问题

用 Agent 做项目的人，迟早撞上四件事：

1. **换模型／换会话就失忆**——上个会话聊定的方向、做过的决定，新会话一概不知；
2. **多个 Agent 各干各的**——没有同一份事实，互相覆盖、互相打架；
3. **“做完了”说不清**——谁说的做完、凭什么算做完、验证证据在哪，翻聊天记录对不上账；
4. **改一处不知道影响哪**——文档或代码动了一行，哪些东西要重新验证没人说得清。

塔台把这四件事变成一份可追溯的账：意图、设计书、施工图、任务、进度、验证证据全部落成事件流，Agent 通过 MCP 接进来读写同一份事实；状态只来自事实与有效证据，谁也不能口头宣布“完成”。

## 界面一览

| 跨项目视图：一屏看清每个项目卡在哪 | 技术详情·模块方框图：离线静态解析，可下钻 |
| --- | --- |
| ![跨项目视图](docs/screenshots/01-cross-project-view.png) | ![模块方框图](docs/screenshots/02-module-map.png) |

> 截图为虚构示例项目（界面数据来自临时夹具目录，无真实项目数据）。

## 下载与安装（Windows）

下载入口：[GitHub Releases](https://github.com/sannongwangluo/tatai/releases/latest)。产品版本口径以 Releases 为准，逐版本的体积与 SHA256 也看对应 Release 页。

- 安装包只出 Windows x64；作者在 Windows 11 x64 上实测。
- 运行前置：PATH 里要有 Node.js ≥ 20（安装包不随包 node）；WebView2 运行时缺了的话，安装器会联网拉微软官方引导器，离线机器请先自行安装。
- 推荐 NSIS 包（装到当前用户目录、免管理员）；MSI 包装到 `Program Files`、需要管理员。两者是同一份程序，卸载都不删用户数据。

前置检查、两种安装包的差异、升级与卸载步骤见 [docs/getting-started.md](docs/getting-started.md)。逐版本的体积与 SHA256 以 [Releases](https://github.com/sannongwangluo/tatai/releases) 对应页为准。

### 升级

- 塔台没有自动更新：装新版就是从 Releases 下一个新包覆盖安装。覆盖安装与卸载都不删用户数据（数据不在安装目录里，安装目录运行期只读）。
- 升级前请正常退出塔台（关闭窗口即会带走它启动的后端并释放 8787 端口）；若安装器仍提示进程占用，再按排错确认残留，不要无差别结束 node 进程。
- 升级前建议先备份两处：全局数据目录（`~/.tatai` 或你的 `TATAI_HOME`）与每个被纳管项目根下的 `.工作台/`。
- 本次升级的安装与数据保留实测状态，以对应 Release 说明为准（不预填未生成的哈希）。

## 第一次使用

1. 双击启动塔台，左栏「＋ 添加项目」，填一个本地项目目录。第一次可以先用一个空目录或示例仓库。
2. 塔台在该项目下建 `.工作台/`（设计书、任务、进度、证据都落在这里，默认进 `.gitignore`，不碰你的代码正文）。
3. 让 Agent 接进来读同一份事实：把塔台加进 Agent 的 MCP 配置（见 [docs/getting-started.md](docs/getting-started.md) 第 5 节），再让 Agent 依次调用 `list_projects` → `select_project` → `project_entry`。三个工具都返回了结构化结果，MCP 就算接通了。
   - 空目录没有设计基线是正常的：`project_entry` 会返回缺基线（`next_action=await_decision`）或空状态——拿到这个回复本身就是连通证明，不必先取得有效基线。
   - 空目录没有可解析的代码模块，技术详情页只会显示空态（没有模块）；要解析出模块方框图／数据流向图／思维导图，需要有实际代码的项目（离线静态解析，零模型调用）。没配模型也能用，模块名会退回目录名，结构图不受影响。

数据在哪、`.工作台/` 里逐条是什么、MCP 配置怎么写，见 [docs/getting-started.md](docs/getting-started.md)。

## 让 Agent 接进来（MCP）

- 22 个 stdio MCP 工具：项目接续（`list_projects`／`select_project`／`project_entry`／`doctor`）、任务与进度、认领与回执、设计书与图纸、需求／变更、同步证据对账（`register_sync_contract`／`scan_sync_evidence`／`read_sync_status`）等。计数以 `src/mcp/tools/index.ts` 的注册表为唯一来源（`pnpm verify:v09-05` 对账，文档计数与注册表恒等）；完整清单见 [docs/capabilities.md](docs/capabilities.md)。
- 桌面壳装好后，MCP 入口就是安装目录下的 `server/mcp.js`，例如 `C:/Users/<用户名>/AppData/Local/Tatai/server/mcp.js`。`%LOCALAPPDATA%` 这类变量不会被自动展开，配置里必须写实际绝对路径。
- 从源码跑时先 `pnpm build:server`，再用产物的绝对路径；不要依赖 `node --import tsx …` 这种要客户端 cwd 才解析得开的写法。完整示例见 [docs/getting-started.md](docs/getting-started.md) 第 5 节与 [docs/agent-integration.md](docs/agent-integration.md)。

`ask_flash` 会调用模型并可能写图补全层，不是保证无副作用的只读工具；只读客户端请按能力如实声明，塔台不会替它假装能自动执行。

## 需要配置 AI 服务的功能

塔台本身不需要任何模型服务就能用——六图、任务账本、七步 Gate、MCP、备份恢复全部离线可用。以下功能启用时才需要模型：模块“人话名”起名、内置 AI 项目聊天、概念图补全、逆向设计草稿、`ask_flash`。逐项需要什么、不配置会怎样，见 [docs/capabilities.md](docs/capabilities.md) 第 3 节。

**只配 Key 不够**：默认基址 `http://127.0.0.1:3456` 是作者本机的本地网关入口，普通用户机器上没有。用你自己的兼容服务时，必须再设 `TATAI_DEEPSEEK_BASE_URL` 指向可达地址，并核对实际模型名。

**隐私边界（如实说明）**：项目文件、任务账本、六图等数据都存在你本机，静态解析等核心功能可完全离线使用；但启用聊天、模块起名等 AI 功能时，发送给模型服务的内容（相关代码片段、设计书段落、你的提问）会离开本机、到达你配置的那个服务。配置了第三方服务就按该服务的隐私条款执行。

## 现在能用什么、还不能用什么

能用：项目登记与跨项目概览；七步 Gate（人工确认）与 Agent 自报任务；六图（功能全景／系统架构／施工依赖／模块方框图／数据流向图／思维导图）与下钻；设计书展示与追加落稿；内置 AI 聊天；任务认领与执行回执；私有事实的显式备份与隔离恢复；MCP 接续入口。其中技术详情三张图当前共用静态 import 依赖层方向渲染——它画的是代码依赖方向，不是业务数据流，也不证明质量通过。

还不能用／如实限制：安装包只出 Windows；WebView2 与 node 都不随包；远程访问保留但默认关闭且不提供“允许公网”的开关；没有自动更新；文档里说明的“完整自动接续、图纸派生与审计证据闭环”尚未具备，中大型／超大型支持须经自举、故障与规模验证。

逐条能力、六图与数据流向图口径、远程访问细节、已知限制见 [docs/capabilities.md](docs/capabilities.md)。

## 设计与施工方向

典型协作流程（各环节用什么工具／模型完全由你决定，塔台不绑定任何品牌）：任一会话与用户聊方向 → 设计角色审定设计书和施工图 → 塔台整理图关系并生成规划图 → 用户选定的执行 Agent 认领施工 → 低成本模型做审计／修复 → 关键节点独立终审 → 用户体验验收。角色与模型／客户端分开；这是分工模板，不是自动启动命令。

施工卡的逐卡状态与证据见 [施工图](PLAN.md)，独立验收与收口结论以 PLAN 与审计记录为准；范围、依赖与验收见 [设计及建设总图](DESIGN.md#117-v06-建设施工总图)。提交执行结果 ≠ 独立审计通过 ≠ 用户验收。

## 文档

| 文件 | 是什么 |
| --- | --- |
| [docs/getting-started.md](docs/getting-started.md) | 上手：前置检查、安装／升级／卸载、第一次使用、MCP 接入、数据在哪 |
| [docs/development.md](docs/development.md) | 从源码跑起来、Node／pnpm 版本口径、验证脚本清单与数据边界 |
| [docs/capabilities.md](docs/capabilities.md) | 当前能力、六图口径、AI 与隐私边界、远程访问、已知限制 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录（当前 0.2.0，2026-09-30） |
| [GitHub Releases](https://github.com/sannongwangluo/tatai/releases) | 发布说明与安装包；产品版本口径以此为准 |
| `DESIGN.md` / `PLAN.md` / `PROGRESS.md` | 设计依据 / 施工图与验收标准 DoD / 施工流水 |
| [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md) | 如何反馈问题与提交改动；安全漏洞的私密报告渠道 |

## 许可与第三方声明

- 本项目：GNU AGPL-3.0，见仓库根 `LICENSE`。
- 随包第三方声明：安装目录下的 `server/THIRD-PARTY-NOTICES.txt`，由 `pnpm build:server` 按实际打进包里的依赖树自动生成。
- 完整许可审计见 [docs/LICENSE-AUDIT.md](docs/LICENSE-AUDIT.md)（含 WebView2 分发条款与证据缺口登记）。

## 反馈与贡献

- 问题反馈：欢迎在 [Issues](https://github.com/sannongwangluo/tatai/issues) 提交，模板见 [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/)；贴日志先脱敏，绝不贴密钥。
- 安全漏洞：请走私密报告渠道，不要开公开 Issue，见 [SECURITY.md](SECURITY.md)。
- 提交改动：fork → 分支 → PR；基础检查命令见 [CONTRIBUTING.md](CONTRIBUTING.md)。CI 对每条 push／PR 自动跑冻结安装、typecheck、build 与隔离版注册表回归，不使用任何私有数据。
