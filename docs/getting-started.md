# 上手塔台

> 面向第一次用塔台的人。目标：**装好 → 添加第一个项目 → 看到图 → Agent 通过 MCP 读到同一份事实**。
> 更全的边界与限制见 [`capabilities.md`](capabilities.md)；从源码构建见 [`development.md`](development.md)。

## 0. 先检查两件事

| 检查 | 怎么做 | 为什么 |
| --- | --- | --- |
| Node.js ≥ 20 | 在命令行跑 `node -v`，主版本号要 **≥ 20** | 塔台复用系统 Node 跑本地服务，**安装包不随包 node**。打包态启动只探一次 `node --version` 看**有没有**、不核对版本号；探不到时窗口照开、**没有专门弹窗**，原因写进 `<全局数据目录>/logs/shell.log` |
| WebView2 运行时 | 一般 Windows 10/11 已自带；缺了的话安装器会**联网**拉微软官方引导器 | 塔台用 WebView2 渲染界面，**不随包**。离线机器请先自行安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) |

## 1. 安装

**下载入口：[GitHub Releases](https://github.com/sannongwangluo/tatai/releases)**（产品版本口径以 Releases 为准）。

安装三步（以 NSIS 包为例）：

1. 下载 `Tatai_<版本>_x64-setup.exe` 并运行（装到当前用户目录，**无需管理员**）；
2. 跑 `node -v`，确认主版本号 **≥ 20**；
3. 双击桌面「Tatai」启动。

两种安装包是**同一份程序**，差别只在安装方式：

| | NSIS `…-setup.exe`（推荐） | MSI `…_en-US.msi` |
| --- | --- | --- |
| 安装范围 | 当前用户 `%LOCALAPPDATA%\Tatai` | `Program Files`（全机器） |
| 需要管理员 | **否**（不弹 UAC） | **是** |
| 卸载 | `uninstall.exe /S` | `msiexec /x` |

各安装包的体积与 SHA256 见对应 Release 页（仓库不另存发布说明副本，避免两处漂移）。

## 2. 升级：覆盖安装，没有自动更新

- 塔台没有自动更新。装新版 = 从 [Releases](https://github.com/sannongwangluo/tatai/releases) 下一个新包，覆盖安装。
- 升级前请正常退出塔台：关闭窗口后，桌面壳会带走在它之后启动的后端并释放 8787 端口。若安装器仍提示进程占用，再核对是否有残留（或该端口被别的进程占着），确认后再继续；不要无差别结束 node 进程——别的 Agent 客户端可能正用着它。
- 覆盖安装不删用户数据，卸载也不删：数据不在安装目录里（安装目录运行期只读）。所谓"卸载清干净"清的是程序文件、快捷方式与 HKCU 卸载项。
- 升级前建议先备份两处（详见第 4 节）：
  1. 全局数据目录（`~/.tatai` 或你的 `TATAI_HOME`）；
  2. 每个被纳管项目根下的 `.工作台/`。
- 本次升级的安装与数据保留实测状态以对应 Release 说明为准；仓库里的发布说明不预填尚未生成的哈希。
- 出故障看日志：
  - 后端：`<全局数据目录>/logs/backend.log`
  - 桌面壳：`<全局数据目录>/logs/shell.log`
  - 贴到 Issue 前先脱敏：去掉真实项目名、本机路径、密钥与口令（口径见 [CONTRIBUTING.md](../CONTRIBUTING.md)「绝不能提交的数据」）。

## 3. 第一次使用

1. 双击启动塔台，左栏「＋ 添加项目」，填一个本地项目目录。第一次可以先用一个空目录或示例仓库。
2. 塔台在该项目下建 `.工作台/`（设计书、任务、进度、证据都落在这里，默认进 `.gitignore`，不碰你的代码正文）。
3. 选中项目 →「技术详情」页签 → 点「先解析」：这是离线静态解析（tree-sitter，零模型调用）。有实际代码的项目会出来模块方框图／数据流向图／思维导图；空目录没有可解析的代码模块，界面只显示空态（没有模块），这是正常的。没配模型也能用——模块没有人话名时会尝试调一次模型起名，没配就退回目录名，结构图不受影响。
4. 让 Agent 接进来（第 5 节），依次调用 `list_projects` → `select_project` → `project_entry`。三个工具都返回结构化结果，MCP 就算接通了——空目录本来就没有设计基线，`project_entry` 返回缺基线（`next_action=await_decision`）或空状态也是正常结果，拿到它就证明连通，不必先取得有效基线。

> 说明：技术详情三张图当前共用静态 import 依赖层方向渲染——它画的是代码依赖方向，不是业务数据流，也不证明质量通过。口径见 [`capabilities.md`](capabilities.md)。

## 4. 数据在哪

三层，互不重叠：

| 层 | 位置 | 进 git 吗 | 内容 |
| --- | --- | --- | --- |
| 工作台全局 | `TATAI_HOME` 环境变量 > 默认 `~/.tatai/` | 否 | 注册表 `registry.json`、`agents.json`、模型服务配置 `config.json`、打包态日志 `logs/backend.log`、远程口令与写模式开关 `remote/`（只在开启远程时生成） |
| 项目私有 | `<项目根>/.工作台/` | **否（默认 gitignore）** | 设计书、待议、进度与 Gate、任务、聊天、变更流水、架构缓存、终端历史 |
| 项目公开 | `<项目根>/` 正文 | 是 | 代码、`AGENTS.md`、`README` |

把数据放别处就用环境变量，让网页端与 MCP 侧给**同一个值**：

```bash
TATAI_HOME=/path/to/data pnpm dev:server
# Windows 命令提示符：set TATAI_HOME=D:\my-tatai 后再跑 pnpm dev:server
```

每个被纳管项目的 `.工作台/` 里是这些东西（`[预置]`＝空模板里就有；`[程序自建·不预置]`＝塔台在第一次需要时自己建，模板不预置——逐条标注的同一份树见 [`../templates/README.md`](../templates/README.md)）：

```
.工作台/
├── design.md            设计书（界面「设计书」页签只读展示的就是它）            [预置]
├── design.discuss.md    待议记录（agent 经 MCP append_discuss 追加）           [预置]
├── plan.md              施工图（缺省源；与设计书成对审定生效基线）              [程序自建·不预置]
├── progress.json        Gate 当前步与七步历史 + 模块四色（迁移后是兼容投影）    [预置]
├── gate.jsonl           过关 / 打回流水（只追加）                              [预置]
├── tasks.json           agent 自报的任务及其状态（迁移后是 v2 事件的兼容投影）  [预置]
├── baselines.jsonl      成套图纸的生效基线（只追加）                          [程序自建·不预置]
├── design-revisions/    设计书不可变历史（按内容哈希命名）                    [程序自建·不预置]
├── plan-revisions/      施工图不可变历史（按定义哈希命名；同定义下的另一份正文按内容哈希命名） [程序自建·不预置]
├── decisions.jsonl      待议 / 待决登记的流水                                 [程序自建·不预置]
├── work/                v2 事实与投影：events.jsonl（唯一事实源）/ state.json / migration-backup/ / sync-inbox/  [程序自建·不预置]
├── evidence/            任务证据与交接包（按卡号分目录）                      [程序自建·不预置]
├── chat/                本地聊天会话记录                                       [预置]
├── changes.jsonl        文件变更流水（文件监听产出）                           [预置]
├── arch/                模块骨架、起名缓存、布局记忆、导图折叠记忆、对账结果与蓝图  [预置]
└── logs/                终端命令历史                                          [预置]
```

**关于 `work/sync-inbox/`**：同步证据的**收件目录**（程序自建、不预置）。做同步对账时，Agent 把 `<批次号>.evidence.json` 写进去，塔台后台发现后自行消费；**用户无需手工维护**。它已被 `.gitignore` 的 `.工作台/` 整目录覆盖，**不会进 git**。契约见 [`sync-evidence-contract.md`](sync-evidence-contract.md)。

（项目自己另放的辅助目录不在上表；塔台自身的 `audit/`、`reviews/`、`verify/` 审计与复跑产物在作者的**私有台账仓**，不随本开源仓分发。）

**绝不进 git**：`.工作台/`、`node_modules/`、`dist/`、构建与安装产物。仓库里只出源码 + 空模板 `templates/.工作台.example/`——别人 clone 下来能跑，但看不到任何真实项目数据。接入项目时若它自己的 `.gitignore` 少了 `.工作台/` 这一行，界面会提示补上。

塔台自己也被自己管（注册表里 `self_managed: true`）：它的设计书事实源就是仓库根的 `DESIGN.md`，`.工作台/` 里不再复制一份。

## 5. 让 Agent 接进来（MCP）

MCP 走 **stdio**：由**你的 Agent 客户端**按配置主动拉起塔台的 MCP 进程（塔台不反过来拉起 Agent）。

### 5.1 桌面壳装好后（推荐）

MCP 入口就是安装目录下的 `server/mcp.js`，即 `C:/Users/<用户名>/AppData/Local/Tatai/server/mcp.js`：

```json
{
  "mcpServers": {
    "tatai": {
      "command": "node",
      "args": ["C:/Users/<用户名>/AppData/Local/Tatai/server/mcp.js"]
    }
  }
}
```

- **必须写实际绝对路径**：`%LOCALAPPDATA%` 这类 Windows 变量**在 MCP 配置里不会被自动展开**，照抄上面那行、把 `<用户名>` 换成你自己的即可。
- MSI 装法不一样：程序在 `Program Files\Tatai`（需要管理员），入口随之变成 `C:/Program Files/Tatai/server/mcp.js`。
- **没安装、只是直接跑 `target/release/tatai.exe` 时**，入口在旁边：`<仓库>/src-tauri/target/release/server/mcp.js`。

### 5.2 从源码跑时

**先构建随包后端**，再用产物的绝对路径：

```bash
pnpm build:server
# 产物：src-tauri/resources/server/mcp.js（与 index.js 同级）
```

```json
{
  "mcpServers": {
    "tatai": {
      "command": "node",
      "args": ["<你的仓库绝对路径>/src-tauri/resources/server/mcp.js"],
      "env": { "TATAI_HOME": "<可选的全局数据目录>" }
    }
  }
}
```

**不要用 `node --import tsx <路径>/src/mcp/index.ts`**：它要靠客户端的工作目录（cwd）才解析得开，换客户端或换目录就会失败。构建后的 `server/mcp.js` 是自包含的，路径不依赖 cwd。开发态想直接用源码也可以，但那等价于 `pnpm mcp`（`tsx src/mcp/index.ts`），只适合在仓库根目录里手动调试。

### 5.3 两边要同源

`env.TATAI_HOME` 要与塔台（网页端或桌面壳）启动时一致，否则 MCP 侧读的是**另一份注册表**——"同一份数据"才是单一事实源的前提。不设时两边都取缺省 `~/.tatai`。

### 5.4 怎么算接通了（明确验证）

让 Agent 依次调用：

1. `list_projects` —— 列出已登记项目；
2. `select_project` —— 对准你的项目；
3. `project_entry` —— 拿**只读交接**：有效基线、上下文清单、未结束 run、`next_action` 与必读原文。

三个都能拿到合理结果，才算 MCP 真正接通（**只看配置文件写没写、不实际调用，不算验证**）。

MCP 工具数以 `src/mcp/tools/index.ts` 的注册表为**唯一来源**（`pnpm verify:v09-05` 对账，文档计数与注册表恒等）；工具清单与接续流程详见 [`agent-integration.md`](agent-integration.md)。

## 6. Node 与 pnpm 的版本口径（分开口径，别混）

分两种场景，要求不同：

| 场景 | 要求 | 说明 |
| --- | --- | --- |
| **安装/运行**塔台 | Node.js ≥ 20 | 只做**存在性**探测（`node --version` 能跑通即可），**不核对版本号** |
| **开发/构建**塔台 | `^20.19.0 \|\| >=22.12.0` | 构建链是 Vite 7，它自己的 `engines` 就是这个区间（来源：`node_modules/vite/package.json` 的 `engines`）。**20.0–20.18 或 22.0–22.11 会在 vite 启动时被挡下** |

**推荐直接用现有 LTS 22.12+，不用改你的环境**；只有当你机器上的 Node 恰好落在被挡的窄区间里，才需要装一个 22.12+ 或 20.19+。

**包管理器**：统一用 **pnpm 12**（CI 钉 `version: 12`；锁文件 `lockfileVersion: 9.0`）。

- **别依赖"Node 自带 corepack"**：corepack 在新版 Node 里已弃用、后续发行版不再随带，换机器就不一定有了。用 `npm i -g pnpm@12` 装，或直接用你已有的 pnpm 12。
- 首次上手用 `pnpm install`（对陌生机器更友好）；**要复现环境**（本地或 CI 一致）请用 `pnpm install --frozen-lockfile`。

## 7. 卸载

- NSIS：`uninstall.exe /S`；MSI：`msiexec /x`。
- 程序文件、快捷方式、HKCU 卸载项会清干净；**用户数据保留**——`~/.tatai`（或 `TATAI_HOME`）与各项目 `.工作台/` 不删，需要时手工清理。
- WebView2 自己会在 `%LOCALAPPDATA%\com.sannongwangluo.tatai` 留一份缓存目录（可达数百 MB），嫌大可在卸载时勾"删除应用数据"，或在 WebView2 设置里清。
