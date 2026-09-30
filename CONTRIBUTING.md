# 参与贡献

感谢你愿意给塔台（Tatai）提问题或提交改动。这个项目当前以作者自用为先、由一个人加一组 Agent 维护，反馈节奏可能不快，但每一条都会看。

## 反馈问题

1. 先看 [Issues](https://github.com/sannongwangluo/tatai/issues) 里有没有人报过；
2. 新建 Issue 时选对应模板（[`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/)：Bug 报告 / 功能建议），模板会提示要带的信息：
   - 你在做什么（步骤）、期望什么、实际发生什么；
   - 环境：Windows 版本、Node 版本（`node -v`）、塔台版本（界面左下角页脚或 Release 页）；
   - 相关日志（如有）：`~/.tatai/logs/backend.log`、`~/.tatai/logs/shell.log`——**贴之前先脱敏**（见下文"绝不能提交的数据"）。

安全漏洞不要走公开 Issue，见 [SECURITY.md](SECURITY.md)。

## 从源码复现

前置：**Node.js `^20.19.0 || >=22.12.0`**（这是构建链 Vite 7 自己的 `engines` 要求；**推荐直接用现有 LTS 22.12+**，不用改环境）与 **pnpm 12**（用 `npm i -g pnpm@12` 装——**别依赖"Node 自带 corepack"**：新版 Node 已弃用、后续发行版不再随带，换机器就不一定有了）。

```bash
git clone https://github.com/sannongwangluo/tatai.git
cd tatai
pnpm install --frozen-lockfile   # 首次上手可用 pnpm install；要复现环境请保留 --frozen-lockfile
pnpm typecheck     # tsc --noEmit
pnpm build         # 前端产物 dist/
pnpm verify:registry   # 注册表读写层回归（自带临时 TATAI_HOME，不碰你的真实数据）
```

跑完整应用的最低组合（两个终端）：

```bash
pnpm dev:server    # 后端 http://localhost:8787
pnpm dev           # 前端 http://localhost:5173
```

桌面壳需要 Rust 工具链，见 `README.md` 与 [`docs/development.md`](docs/development.md) 第 3 节、[`src-tauri/README.md`](src-tauri/README.md)。完整开发与验证口径（版本要求、验证脚本清单、数据边界）见 [`docs/development.md`](docs/development.md)。

## 提交改动

1. fork → 建分支 → 改动 → 跑上面四条基础检查；
2. 涉及验证脚本的改动：脚本必须自带隔离环境（临时 `TATAI_HOME`、动态端口），不得读写用户真实数据目录；
3. PR 里写清改了什么、为什么、怎么验证的（命令 + 结果）。中文或英文都可以；
4. CI 会自动跑 `install --frozen-lockfile` / `typecheck` / `build` / `verify:registry`，全绿才好合。

### 代码约定（跟着现有代码走）

- TypeScript + React + Vite；后端与 MCP 共用 `src/server`/`src/mcp`；包管理器只用 pnpm，不混入其他锁文件；
- 新增依赖先说明必要性并核对许可原文（项目准入白名单 MIT/Apache/BSD，其他许可要给兼容依据）；
- 验证脚本放 `scripts/verify-*.ts`，风格照旧：显式 PASS/FAIL/SKIP 行 + 退出码（0 全过 / 1 有 FAIL / 3 有 SKIP）。

## 绝不能提交的数据（重要）

这些是塔台的设计红线，也是 PR 的硬性检查项：

| 数据 | 在哪 | 为什么不能进 |
| --- | --- | --- |
| 项目私有事实 | `<项目根>/.工作台/` | 设计书、任务、聊天、证据可能含你的真实项目信息；仓库只带空模板 `templates/.工作台.example/` |
| 全局数据 | `~/.tatai/`（或你的 `TATAI_HOME`） | 注册表里有你的真实项目路径；`config.json` 里有 API Key |
| 任何密钥/口令 | 环境变量、`config.json`、远程口令文件 | 一旦进了 git 历史就当作已泄漏处理 |
| 真实聊天与截图 | 界面截图、日志、终端历史 | 会暴露真实项目名、路径、协作内容；文档截图一律用虚构示例数据 |
| 作者本机的绝对路径 | 脚本、文档、配置示例 | 换成 `<你的目录>` 一类占位符 |

提交前 `git diff` 自查一遍；`.gitignore` 已忽略 `.工作台/`、`dist/`、`node_modules/`、构建产物，别用 `git add -f` 绕过它。
