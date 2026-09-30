# 变更记录（Changelog）

本文件记录各版本的**面向用户的变化**。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循语义化版本。

- **产品版本口径以 [GitHub Releases](https://github.com/sannongwangluo/tatai/releases) 为准**；本文件不另存发布说明全文。
- **提交执行结果 ≠ 独立审计通过 ≠ 用户验收**：标 `已交付` 只表示代码/服务已落地，不等于已审计、已验收。

## [0.2.0] —— 2026-09-30

> 状态：v0.2.0（2026-09-30）。安装包、构建戳与 sha256 以 [GitHub Releases](https://github.com/sannongwangluo/tatai/releases) 对应页为准；发布说明见 [`docs/releases/v0.2.0.md`](docs/releases/v0.2.0.md)。

### 新增（已交付）

- **六图全量可查看（V09-22）**：概览保持防爆炸上限不变，每个聚合点新增「显示全部／加载全部子级」；技术详情画布支持按名称/id/路径搜索定位。MCP `get_project_graphs` 增加 `mode=full`——未聚合并集、按 4000 对象/页**同一快照分页续取**；新增逐项取回路径（`GET /api/projects/:id/arch/items` 与 UI「查看被聚合对象」抽屉）；游标四段制绑定读取模式（overview↔full 跨模式明确拒绝）。
- **阶段接续与阻塞卡门禁（2026-09-30 有界修正）**：`project_entry` 的 `required_reads` 支持项目自带的 `.工作台/work/stage-reads.json`（机器派生指针、可选）——合法则把本阶段必读原文与 `preferred_task_id` 一并给出；指针损坏、来源缺失或内容漂移（sha256 不符）一律 `next_action=blocked`，**不静默派活**。任务状态为 `blocked` 的卡不再允许**新领**（MCP `claim_task` 与直连写入服务两条入口都拒）。
- **同步证据自动发现与完整性对账（V09-23）**：执行前经 `register_sync_contract` 登记「应同步清单」契约；完成后把 `<批次号>.evidence.json` 写进项目 `.工作台/work/sync-inbox/`，塔台**后台自动发现**并逐项读取当前实际目标验收。只读 `GET /api/projects/:id/sync-status` 与 MCP `read_sync_status` 同判据，UI 有同步证据状态入口。`blocks_entry` 批次未当前通过时接续与领取被阻断，**补证后自动解阻**。

### 变更

- **MCP 工具面 19 → 22**：新增 `register_sync_contract`、`scan_sync_evidence`、`read_sync_status`。工具数以 `src/mcp/tools/index.ts` 注册表为唯一来源。
- **文档结构重整**：README 精简为首页（用途/适合谁/下载/第一次使用/AI 边界），技术细节移入 `docs/getting-started.md`、`docs/development.md`、`docs/capabilities.md`；新增 `CHANGELOG.md` 与发布说明。

### 尚未验证（如实列出）

- 真装 / 冷启动 / 卸载未在本版重复实测（沿用 v0.1.1 的真装记录口径）；WebView2 引导器在线下载分支与 MSI 通道暂无本机真装记录。
- 新增/变更能力的逐卡独立审计与用户验收**尚未完成**；以 `PLAN.md` 卡行与其「账本投影对照表」为准。

## [0.1.1] —— 2026-09-28

**文档口径与脚本可移植性修正版。功能与 v0.1.0 相同，无功能变化。**

### 修正

- 许可证口径统一（三处）：删除仓库内换协议前遗留的 MIT 旧版发布说明；随包 `THIRD-PARTY-NOTICES.txt` 模板里「塔台自身许可：MIT」改为「GNU AGPL-3.0」；`src-tauri/Cargo.toml` 的 `license` 由 `MIT` 改为 `AGPL-3.0-or-later`。
- 本机信息占位化：`docs/agent-integration.md` 不再含作者机器的真实用户名与本机目录。
- 验证脚本可移植：`verify:v09-18` 缺作者真实台账时显式 SKIP（退出码 3）；补证脚本临时目录改用 `os.tmpdir()`。
- `LICENSE` 尾部补版权行。
- README：移除未填充的截图占位节；文档表增加 Releases 入口；注明 `audit/`、`reviews/`、`verify/` 为作者私有台账侧目录。
- 版本串 0.1.0 → 0.1.1。

详见 [v0.1.1 Release](https://github.com/sannongwangluo/tatai/releases/tag/v0.1.1)。

## [0.1.0] —— 2026-09-28

**开源首版。**

### 新增

- 七步 Gate 与事件账本：状态只来自事实与有效证据，界面不提供人工涂色。
- 六图（功能全景／系统架构／施工依赖／模块方框图／数据流向图／思维导图）与逐对象来源/证据标注。
- 19 个 stdio MCP 工具：项目接续、任务认领/回报、六图读取、Flash 问答等。
- 证据分段失效判定：文档改动只重验受影响对象。

> 已知问题：本版安装包内的 `server/THIRD-PARTY-NOTICES.txt` 曾把**塔台自身**许可误标为 `MIT`（塔台真实许可自开源起就是 **GNU AGPL-3.0**）。该错误已在 v0.1.1 修正，请使用 v0.1.1 或更新版本。详见 [v0.1.0 Release](https://github.com/sannongwangluo/tatai/releases/tag/v0.1.0) 顶部更正说明。
