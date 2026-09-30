# `templates/` —— 模板目录（repo 只出代码 + 空模板）

本目录两个模板，都是**公开文件、进 git、零真实数据**（依据 `DESIGN.md` §8.3）：

| 文件 | 干什么用 | 往哪放 |
| --- | --- | --- |
| `.工作台.example/` | 项目私有目录的**空模板**：只有结构 + 空态骨架 / 示例占位，没有作者任何项目数据 | 复制成目标项目根下的 `.工作台/`（默认 gitignore） |
| `agents-md-snippet.md` | 项目 `AGENTS.md` 里的「接入了塔台 MCP」约定段（依据 `DESIGN.md` §6.2） | 手工粘贴，或对已注册项目跑 `pnpm attach:agents-md -- <project_id>`（幂等） |

## 怎么用

```bash
# 1) 新建/已有项目接入前，先铺一份空工作台（也可以不铺：缺文件时塔台按需自己建）
cp -r templates/.工作台.example/. <项目根>/.工作台/

# 2) 项目自己的 .gitignore 至少加上这一行（`.工作台/` 不进项目仓库）
printf '%s\n' '.工作台/' >> <项目根>/.gitignore

# 3) 界面「＋ 添加项目」或 POST /api/projects 接入，再按需补 AGENTS.md 的 MCP 约定段
pnpm attach:agents-md -- <project_id>
```

塔台**不要求**预先铺模板：`.工作台/` 下的文件大多在第一次需要时由程序自己建（见下表「生成时机」）。
模板的作用是**把结构摆出来**——让人和 agent 一眼看见「这个目录里该有什么、每个文件长什么样」。

## 目录结构（逐项对齐 `DESIGN.md` §2.2 + 各卡新增文件）

`[预置]` ＝ 本模板里就有这个文件/目录；`[不预置]` ＝ 塔台在第一次需要时自己建（预置瞬时状态会把"还没有事实"和"事实为空"混为一谈）。
`pnpm verify:l3` 会对这一层逐条核对：**每个条目要么在模板里存在、要么行尾写明 `[不预置]`**，两个都不满足就报红。

```
<项目根>/
├── .工作台/                          ← templates/.工作台.example/ 就是这个目录
│   ├── design.md                     设计书（唯一事实源，§2.2 / §3.5）          [预置]
│   ├── design.discuss.md             待议记录（只追加，§2.2 / §3.5）            [预置]
│   ├── plan.md                       施工图（缺省源；§2.9 / V06-02）           [不预置]
│   ├── design-revisions/             设计书不可变历史（`<内容 sha256>.md`，§2.6 / V06-02） [不预置]
│   ├── plan-revisions/               施工图不可变历史（主名 `<定义 sha256>.md`；同定义哈希下的另一份正文另存 `<内容 sha256>.md`，§2.6 / V06-02） [不预置]
│   ├── baselines.jsonl               成套图纸的生效基线（只追加，§2.9 / V06-02）  [不预置]
│   ├── decisions.jsonl               待议 / 待决登记的流水（§2.5）              [不预置]
│   ├── progress.json                 Gate 当前步 + 七步历史 + 模块四色（§2.3.2）  [预置]
│   ├── gate.jsonl                    Gate 过关 / 打回流水（只追加，§2.3.3）      [预置]
│   ├── tasks.json                    agent 自报的任务（§2.3.4 / §5.3；迁移后是 v2 事件的兼容投影） [预置]
│   ├── work/                         v2 事实与投影（V06-01/V06-03，程序自建）    [不预置]
│   │   ├── events.jsonl              唯一事实源：一行一条事件（只追加）
│   │   ├── state.json                可重建快照（带 last_seq）
│   │   ├── sync-inbox/               同步证据收件目录（V09-23）：写 `<批次号>.evidence.json`
│   │   └── migration-backup/          v1→v2 迁移备份（含逐字节哈希清单，V06-03）
│   ├── evidence/                     任务证据与交接包（按卡号分目录，程序自建）  [不预置]
│   ├── chat/
│   │   └── example-session.jsonl     每个会话一份（`<sessionId>.jsonl`，§2.3.6 / C2 卡） [预置]
│   ├── changes.jsonl                 文件变更流水（H1 文件监听产出，§2.3.5）    [预置]
│   ├── arch/
│   │   ├── modules.json              顶层模块骨架（A1 静态解析产出）            [预置]
│   │   ├── names.json                模块人话名缓存（A2 起名产出）              [预置]
│   │   ├── layout.json               布局位置记忆，**v2 按视图分键**（A4 + F4）   [预置]
│   │   ├── mindmap-fold.json         思维导图折叠记忆（N2）                    [预置]
│   │   ├── reconcile-request.json    对账钩子（B3 落、A5 消费即删）             [预置]
│   │   └── reconcile-last.json       最近一次「设计书 ↔ 代码」对账结果（A5）     [预置]
│   └── logs/
│       └── terminal-history.jsonl    终端命令历史（E3，只追加）                 [预置]
├── AGENTS.md                         项目约定（MCP 段见 templates/agents-md-snippet.md；由 `pnpm attach:agents-md` 接入）
└── ...（项目本体文件）
```

`.工作台/` 是**项目私有层**（`DESIGN.md` §8.1 第二层），默认 gitignore；塔台自身是自举例外——它的设计书事实源
是 repo 根公开的 `DESIGN.md`，施工图是根 `PLAN.md`，`.工作台/` 里不再复制一份（`AGENTS.md` §7）。

## 图纸源与基线的字段口径（V06-02，§2.6 / §2.9）

两份角色文档在任一时刻只有**一个当前源**：塔台自身固定为 repo 根 `DESIGN.md` + `PLAN.md`；
其他项目缺省 `.工作台/design.md` + `.工作台/plan.md`，也可在注册表里登记**项目根内相对路径**：

| 位置 | 字段 | 口径 |
| --- | --- | --- |
| `<全局数据目录>/registry.json` 的项目记录 | `design_path` | 设计书源路径，**项目根内相对路径**（如 `docs/design.md`）；缺省/留空 = 走缺省口径 |
| 同上 | `plan_path` | 施工图源路径，同一口径（缺省 `.工作台/plan.md`） |

越出项目根一律拒绝：`../`、绝对路径、软链（Windows 联接点）指向项目根外都会明确报错；
老注册表没有这两个字段照样读（向后兼容）。

### `plan.md` —— 施工图（§2.9）

与 `design.md` 并列的第二份图纸：回答任务、依赖、修改范围与验收。落稿与修订流程同 `design.md`
（授权设计角色可改；施工者只提异议）。**只读**方能读到"第一张表头含卡号/依赖/完成证据的 Markdown 表"
作为施工卡定义；重复卡号、悬空依赖、依赖成环、交付目标或完成证据为空时，成套图纸**不允许**激活基线。
塔台自身不读 `.工作台/plan.md`，它固定读 repo 根 `PLAN.md`。

### `baselines.jsonl` —— 成套图纸的生效基线（§2.9）

**只追加**，一行一条；**最后一条有效记录 = 当前生效基线**，旧记录永久保留（新基线失败时旧基线继续有效）。
一行字段：

```jsonc
{
  "baseline_id": "bl-cb39b32a-0a430785",       // design 内容哈希前 8 位 + plan 内容哈希前 8 位（历史基线的 plan 段取的是当时的定义哈希，逐字节不重算）
  "design_revision": { "kind": "design", "source_path": ".工作台/design.md",
                       "content_sha256": "…", "definition_sha256": "…",
                       "recovery": { "kind": "immutable_copy",
                                     "ref": ".工作台/design-revisions/<内容 sha256>.md",
                                     "key": "<内容 sha256>", "sha256": "<取回字节的 sha256>" } },
  "plan_revision":   { "kind": "plan",   "…": "…", "recovery": { "…": "…" } },
  "approved_by": "gpt-6",                       // 审定者；用户确认时为 "user"
  "approval_basis": "用户已委派 GPT-6 的技术设计职责", // 审定依据，**必填**（无依据不能激活）
  "approval_kind": "delegated_technical_review", // user_confirmed | delegated_technical_review
  "active_at": "2026-09-20T01:00:00+08:00",
  "supersedes": "bl-……"                        // 取代的上一条 baseline_id（首条为 null）
}
```

两条红线：`approval_kind=delegated_technical_review` **必须** `approved_by` 是设计角色标识（不是 `user`）——
用户委派的技术审定如实标注，**不伪造用户 Gate**；激活流程**不往 `gate.jsonl` 写一个字节**（Gate 只有人能点）。
源在审定中改变（内容/定义哈希或源路径对不上）→ 版本冲突，保留草稿与差异供重新审定。

### `design-revisions/` · `plan-revisions/` —— 不可变历史（§2.6）

基线只引用**哈希 + 恢复位置**，所以必须能取回确切原文：设计书存 `.工作台/design-revisions/<内容 sha256>.md`，
施工图存 `.工作台/plan-revisions/<定义 sha256>.md`（主名）；**同一定义哈希下的另一份正文**（施工定义哈希只覆盖
卡号/交付目标/依赖/完成证据，正文在这之外变化时内容哈希变、定义哈希不变）另存 `.工作台/plan-revisions/<内容 sha256>.md`
（文件名用哈希，内容是当时的**原文全文**；旧对象一个字节都不动）。
已在 Git 里可长期取回的对象（取回字节与原文逐字节相同）直接引用 `git:<oid>`，不必再落副本。

口径：**只增不改**——同名对象已存在就不回写；取回时校验 sha256，对不上就报错，绝不把改过的内容当原修订。
它们不是"第二份现行设计"，只是恢复用的历史对象。

## 逐文件字段口径

「生成时机」为**程序产物**的文件，模板里给的是空态骨架：让结构完整、字段口径可见；程序真跑一次就整份覆盖。

### `design.md` —— 设计书（§2.3 / §3.5）

首行标题 + 一句口径说明，正文由**落稿流程**追加（被纳管项目没有 `design.md` 时，落稿会先建出这个标题头）。
只有两条笔能写它：Flash 聊天里点「落稿」、Max 窗口审改；施工 / 执行 agent 只能往 `design.discuss.md` 提疑。

### `design.discuss.md` —— 待议记录（§3.5 提疑权）

正文只有标题头；条目一律由程序追加成一行：``- `<YYYY-MM-DD>` <内容>``（日期前缀由代码补，内部换行折叠成空格）。
**只追加**：没有修改 / 删除已有条目的接口，写错只能再追加一条纠正。

### `progress.json` —— 进度（§2.3.2）

| 字段 | 口径 |
| --- | --- |
| `version` | 固定 `1` |
| `gate.current_step` | 七步之一：`kickoff` / `requirement` / `design` / `tasks` / `develop` / `verify` / `deliver` |
| `gate.history` | 七步各一条，顺序固定：`{step, result, at, note}`；`result` ∈ `pass` / `reject` / `pending`，未过关步的 `at` / `note` 为 `null` |
| `modules` | `{id, name, status}[]`；`status` 四色 ∈ `todo`（灰）/ `doing`（黄）/ `done`（绿）/ `issue`（红） |

空态 = `current_step` 指向第一步 `kickoff`、`history` 七步全 `pending`、`modules` 空数组（与代码首建产物逐字节一致）。
模块状态还会被**任务汇总**改写（§5.3：任一 `blocked` → `issue`、任一 `doing` → `doing`、全 `done` → `done`、全 `todo` → `todo`）。

### `gate.jsonl` —— Gate 流水（§2.3.3）

一行一条，**只追加、永不回改**（写错只能再追加一条纠正）。空文件 = 还没有过人点过关 / 打回。

```jsonl
{"ts":"1970-01-01T09:00:00+08:00","step":"kickoff","result":"pass","by":"user","note":"立项确认"}
```

`result` 这里只有 `pass` / `reject`（`pending` 是初始态、不是转移结果）；`by` 固定 `"user"`——只有人能点 Gate；
`reject` 必须带 `note`（打回理由要可读）。一行字段不对，读取会带行号报错。

### `tasks.json` —— 任务（§2.3.4 / §5.3）

| 字段 | 口径 |
| --- | --- |
| `version` | 固定 `1` |
| `tasks[].id` | 任务 id，非空串，重复即报错 |
| `tasks[].title` | 任务标题 |
| `tasks[].module_id` | 归属模块 id（挂在 `progress.json` 的模块上，状态回汇总成四色） |
| `tasks[].status` | 四值 ∈ `todo` / `doing` / `done` / `blocked`，**由 agent 经 MCP 自报**，不手点 |
| `tasks[].reporter` | 自报者标识（如 agent 名） |
| `tasks[].updated_at` | 最近一次状态变更时间（本地 ISO 带偏移） |
| `tasks[].note` | 可选备注（非空即落盘；再报不传保留旧值） |

## v2 事实与兼容投影（V06-03，§2.6 / §5.4）

这一个项目级的 v2 目录**不由模板预置**（`.工作台/work/` 是程序在第一次提交 v2 事件时自己建的，
预置空事件文件会把"没有事实"和"事实为空"混为一谈），字段口径记在这里：

```
<项目根>/.工作台/work/
├── events.jsonl                        唯一事实源：一行一条事件，只追加（V06-01）
├── state.json                          可重建快照（带 last_seq）；删掉可全量重放
├── projection-error.json               投影失败标记（有它 = 快照落后于事件）
├── recovery.jsonl / quarantine/        半截尾行的恢复留痕与隔离原文
├── sync-inbox/                         同步证据收件目录（V09-23）：Agent 写 `<批次号>.evidence.json`，
│                                       塔台后台自动发现并逐项对账（用户无需手工维护；契约见
│                                       `docs/sync-evidence-contract.md`）
└── migration-backup/<时间戳>/          v1→v2 迁移前的整份备份 + manifest.json（逐字节哈希清单）
    migration-archived/<时间戳>/        回滚时移进来的 v2 事件/快照（保留事实，不删）
```

`sync-inbox/` 由程序在第一次需要时自建（不预置）；它连同整个 `.工作台/` 默认被 `.gitignore` 覆盖，**不会进 git**。

**任务状态来自事件**（`.工作台/work/events.jsonl` 的已提交事件），`tasks.json` 与 `progress.json`
里被标记的状态区是**兼容投影**。迁移后 `tasks.json` 会长成下面这样——带 `projection_of` 标记，
旧写工具（v1 的四态写口）看到它必须**拒写**，不能静默按 v1 覆盖：

```jsonc
{
  "version": 1,
  "projection_of": "work/events.jsonl",   // 有这行 = 这是派生投影，不是事实源
  "last_seq": 42,                         // 投影覆盖到的提交序号
  "generated_at": "2026-09-20T01:00:00+08:00",
  "status_semantics": "…done = 执行者已提交结果，不代表审计通过或人工验收接受（§5.4）",
  "tasks": [
    {
      "id": "T-1", "title": "…", "module_id": "m-1",
      "status": "done",                   // v1 四态（兼容读法，最弱含义）
      "reporter": "kimi-code", "updated_at": "…", "note": "…",
      "v2_status": "result_submitted",    // v2 细粒度状态（要看真状态读这个）
      "v2_status_label": "结果已提交",
      "cancelled": false,                 // 取消是旁路，单独标记
      "definition_sha256": "…", "plan_revision": "…"  // 绑定的施工定义修订（定义变了要重绑）
    }
  ]
}
```

v1 → v2 的状态映射（§5.4 的唯一映射表，`src/server/work/migrate.ts`）：

| v1 四态 | v2 执行状态 | 口径 |
| --- | --- | --- |
| `todo` | `preparing`（待准备） | v1 没有"就绪"位，只能到这里 |
| `doing` | `executing`（执行中） | v1 不区分认领与在跑 |
| `done` | `result_submitted`（**结果已提交**） | **只到这里**：不补造审计结论，也不写人工验收 |
| `blocked` | `blocked`（阻塞） | 旁路 |
| （无）| `cancelled`（取消） | v1 四态没有取消位：只在任务条目带明确取消标记时才迁移，不猜 |

### 施工图的任务定义字段口径（V06-03，§2.7 / §2.9）

施工图里第一张表头同时含「卡号/依赖/完成证据」的表 + 对应 `###` 卡片小节 = **任务定义区**；
表里的「状态」列、「**施工备注**」段与检查项勾选位 = **派生状态区**（不进定义哈希）；
其余表与小节（历史审计项、v0.5/v0.4 历史、附录）= **历史归档区**，解析器不读。

| 定义字段 | 来源 |
| --- | --- |
| `task_id`（稳定 id） | 表格「卡号」列；跨修订匹配用去空白/忽略大小写的稳定键 |
| `goal` | 表格「交付目标」列 |
| `evidence_requirement` | 表格「完成证据」列 |
| `dependency_ids` | 表格「依赖」列里**卡号形态**的 token（本表内同构：字母数字加短折线且含数字） |
| `dependency_notes` | 同一列里的其余 token（「用户本轮授权」这类自然语言），**不算悬空依赖** |
| `design_refs` | 正文「**设计依据**」段 |
| `allowed_paths` | 正文「**文件责任**」段里反引号中的路径 |
| `acceptance` | 正文检查项（`- [ ]` / `- [x]` 行）+「**交付**」段 |
| `inputs` | 「**契约**／**输入/输出契约**」段（输入与依赖版本口径） |
| `plan_revision` | 该文档修订的内容哈希 |
| 其余（`change_id` / `requirement_ids` / `base_commit` / `design_revision` / `risk` / `owner_role` / `priority` / `forbidden`） | 源文档没有就是 **null**，并逐条进导入报告的缺失项——不编造 |

状态更新不改定义哈希：定义哈希只覆盖目标/范围/依赖/接口/验收，**不含**「状态」列、时间戳、
「施工备注」段、勾选位与定义修订号。

### `changes.jsonl` —— 变更流水（§2.3.5）

文件监听顺带产出，一行一条，空文件 = 还没监听到变更（服务启动时**不自动监听任何项目**，要显式开）。

```jsonl
{"ts":"1970-01-01T09:02:13+08:00","path":"src/example.ts","action":"modify","size_delta":128}
```

`action` ∈ `add` / `modify` / `remove`；`size_delta` 是本次变更的字节差（`remove` 时为 `null`）。

### `chat/<sessionId>.jsonl` —— 聊天记录（§2.3.6 / C2 卡）

每个会话一个文件；`sessionId` 只含字母 / 数字 / `-` / `_`（塔台生成形如 `19700101-000000-a1b2c3d4`），
建会话即建文件（还没说话就是 0 字节）。一行一条消息：

```jsonl
{"role":"user","content":"……","ts":"1970-01-01T10:00:00+08:00"}
{"role":"assistant","content":"……","ts":"1970-01-01T10:00:03+08:00","model":"<模型 id>"}
```

`assistant` 行**必须带 `model`**（缺了按损坏处理）。模板里的 `example-session.jsonl` 是两行示例占位，可直接删。

### `arch/modules.json` —— 顶层模块骨架（A1）

`{version:1, generated_at:<ISO>, modules:[{id, name, path, file_count, loc, deps:[{to, weight}]}], budget_exhausted}`。
由 tree-sitter 静态解析项目根产出（`POST /api/projects/:id/arch/parse`），**LLM 全程不参与**；`name` 留空等 A2 起名填。
`budget_exhausted`（布尔）= 本份模块集是否因遍历 / 解析预算到点提前收工（`true` = 只含已扫到的部分，不是全量）；
**缺席**表示产自还没写这个标记的旧版本落盘件，完整性未知——读侧不许当成「扫完了」。模板里是空骨架。**注意**：界面「架构图」页的「先解析」引导只在**这个文件不存在**时出现——如果你希望
复制模板后第一眼看到引导，删掉这个空 `modules.json` 即可（解析后会重新生成）。

### `arch/names.json` —— 模块人话名缓存（A2）

`{version:1, entries:{"<模块 id>": {name, blurb, kind, named_at, signature, fallback?}}}`。
`signature` = `sha1(path + file_count + deps)` 前 16 位，签名没变就命中缓存**零请求**；单模块起名失败降级为
path 兜底名并标 `fallback: true`（不参与缓存命中，下次重试）。`kind` ∈ `code` / `data` / `docs` / `mixed`。
缺文件 = 还没起过名（正常空态，名字兜底成模块 id）。

### `arch/layout.json` —— 布局记忆（A4 + F4）

`{version:2, positions:{"<视图>": {"<节点 id>": {x, y}}}}`——**v2 按视图分键**：同一模块在方框图与数据流向图里各存各的
坐标，互不覆盖（切视图不跳位）。拖动节点后由前端 debounce 合并写回。模板是空 `positions`。
旧版 v1（没有视图维度）读到即把旧坐标归给方框图并原子写回升级成 v2，用户拖过的位置一条不丢。

### `arch/mindmap-fold.json` —— 导图折叠记忆（N2）

`{version:1, projects:{"<项目 id>": {expanded:[{id, path}]}}}`。`expanded` 是已展开的节点（顺序 = 展开顺序，
父在子先）；恢复时按 `path` 只补拉这几枝，不是全量。文件里再嵌一层项目 id 是为了显式「这份折叠态属于谁」；
读的时候只认自己那份，对不上就回空（不猜、不串台）。

### `arch/reconcile-request.json` / `arch/reconcile-last.json` —— 对账（B3 钩子 + A5 结果）

- `reconcile-request.json`：**瞬时标记**，定版时写成 `{ts, trigger, gate_step}`，对账跑一次即读后**删除**。
  模板里给的是空壳 `{}`（结构占位，不影响任何行为）。
- `reconcile-last.json`：最近一次对账结果，字段 `version` / `generated_at` / `trigger` /
  `design_exists` / `code_exists` / `design_source` / `design_modules` / `code_modules` /
  `only_in_design` / `only_in_code` / `matched` / `consumed_request` / `note`。
  `only_in_*` 是差异清单——**差异是信号，不是错误**（§4.5）：设计书有代码没有 = 设计书过时或未实现；
  代码有设计书没有 = 代码跑偏或漏写设计。模板里 `trigger` 为 `never`、时间戳为 1970 起点，表示「还没跑过对账」。

### `logs/terminal-history.jsonl` —— 终端命令历史（E3）

一行一条，**只追加**；单文件超 5 MB 滚动成 `terminal-history.<毫秒时间戳>.jsonl` 归档（最多留 5 份）。
空文件 = 还没有经塔台终端敲过命令。只记**本人经塔台 pane 敲进去的命令**——绝不读 shell 自己的历史文件；
命中敏感形态、无回显、密码提示词、不可重建（↑/↓ 召回、Tab 补全）四类一律**不落盘**。

```jsonl
{"ts":"1970-01-01T09:03:00+08:00","project_id":"example-project","session_id":"tmg00000-1","cwd":"<项目根>","command":"pnpm typecheck","duration_ms":1200}
```

`duration_ms` 是回车到最后一段输出的间隔（`null` = 回车后没有新输出）；`exit_code` 恒无（不编造）。

## 模板里**不**预置的文件（避免把瞬时状态当成结构）

| 文件 | 为什么不预置 |
| --- | --- |
| `.工作台/design.draft.md` | 逆向落稿草稿（B2）：存在即表示「有一份还没定版的草稿」，预置等于凭空造出一份草稿。定版后转正为 `design.md` |
| `.工作台/plan.md` | 施工图缺省源（V06-02）：真实施工图是**项目自己的内容**，预置一份空文件等于凭空给出任务定义。它由落稿/授权设计角色按需建立 |
| `.工作台/baselines.jsonl` | 生效基线流水（V06-02）：预置一条基线等于凭空宣称"这套图纸审过了"。首次激活才建，且只追加 |
| `.工作台/design-revisions/` · `.工作台/plan-revisions/` | 不可变历史（V06-02）：只在保存修订时按哈希建对象；空目录既不说明恢复位置，也不构成任何修订 |
| `.工作台/decisions.jsonl` | 待议 / 待决登记流水（§2.5）：预置空文件会把"还没有待决项"和"待决项为空"混为一谈；第一次登记时由程序建 |
| `.工作台/evidence/` | 任务证据与交接包（按卡号分目录）：内容是**执行事实**，由干活的 agent 落；预置空目录等于凭空给出一份"证据已就位"的结构 |
| `.工作台/chat/<sessionId>.jsonl`（示例以外） | 会话文件由塔台在「新建会话」时创建，一会话一份 |
| `.工作台/logs/terminal-history.<毫秒时间戳>.jsonl` | 历史滚动归档，达到 5 MB 才产生 |
| `<全局数据目录>/logs/backend.log` | **注意：这个不在项目里**。U2 的壳级后端日志落在**工作台全局层**（`TATAI_HOME` 或 `~/.tatai/` 下的 `logs/`），不属于任何一个项目（§8.1 第一层），只有在打包态设了日志开关时才写 |

## 与代码 schema 的同步（防漂移）

模板里的每个文件都能被**代码自己的读取器 / 校验函数**读通，漂移即红：

```bash
pnpm verify:l3
```

该脚本做四件事：① 目录结构逐项核对 `DESIGN.md` §2.2（贴树形输出）；② 用代码真校验模板（`progress.json` 过
`readProgress`、`tasks.json` 过任务校验、`layout.json` 过 v2 读取、`mindmap-fold.json` 过 foldStore 读、
`chat/*.jsonl` 过 `readSession`、`gate.jsonl` 过 Gate 行校验，并把生成类文件的**键集**与代码真跑一次的产物对照）；
③ 对模板做零真实数据自查（作者名 / 机器路径 / 真实项目名 / 密钥形态，命中必须为 0）；④ 把模板复制到全新临时目录
→ 真起服务 → `POST /api/projects` 接入 → 读设计书 / 读进度 / 写任务 / 起监听，跑完删干净。
