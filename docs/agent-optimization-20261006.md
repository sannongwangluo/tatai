<!-- Codex 2026-10-06 审定实施；同目录 agent-optimization-decisions-20261006.md 纠正优先。未部署、未验收。 -->
# 面向大型 Agent 项目的优化契约（2026-10-06 用户授权）

> 本文件是 DESIGN.md §6.9（2026-10-06 追加段）、§6.10、§6.11 与 §12.1 第 22–24 项的**规范细节**，也是 PLAN **V09-45…V09-49** 与 **V09-50**（P5 条件启动后追加，2026-10-06）的施工依据。正文只给方向与边界，本文件给出可施工的字段、判据与反例；两者不一致时以 DESIGN 正文为准并于施工卡登记差异。
>
> **本文件的上级裁定**：`coordinator-decisions.md`（**Codex 实施审定与纠正**，2026-10-06）逐项覆盖本草案中与之冲突的表述，**不改变原方案的验收强度**；冲突处以该文件为准（落实位置见 §13）。同目录 `baseline-review.md`（非作者独立复核）是 P0 冻结输入的复核结论（判定**无阻断**；F1 中／F2–F5 低或残余风险，登记后随批处理）。
>
> **当前状态（如实）**：本契约是**设计草案**，随同批设计细化提交审定。**未施工、未部署、未重建前端/壳/安装器、未激活任何基线、未写事件账本、未代签用户 Gate**。文中的工具名与字段名在施工时按最新现场核对后固定；本文把"拟议"写成"拟名/拟新增"，不当作已交付能力。

## 0. 来源、授权与阅读顺序

- **用户授权**：按 `<维护者资料目录>/00-优化方案.md` **全部实施**；P0–P3 必做，P4/P5 按实测启动。
- **同批留档**（按序读）：`01-接续与提交扫描.md`、`02-同步与图采集扫描.md`、`03-版本与运行恢复扫描.md`（定向取证）；`04-塔台六图只读快照.json`、`05-现场基线.json`、`06-协调者版本复核.json`；**`07-协调者复核.md`（对扫描报告的过度断言与未采纳建议以此为准）**；**`08-方案独立复核.md`（可执行口径已逐条处置）**；`09-基线收尾核验.json`、`10-作业终态.json`。
- **代码/文档引用**基于 `05-现场基线.json` 的当前字节；施工前先核实相关源是否变化（基线 HEAD `c49d277f13f27e8c64c78d2fd7b5b166575da87c`，26 个已跟踪文件改动 + 2 个未跟踪脚本，**开发态工作树是脏的**）。
- **不得**用 Git HEAD 代表脏工作树，**不得**把"未提交"读成"未审计"，**不得**把静态方案复核当作产品运行通过。

## 1. 保留约束（本批一条都不放宽）

1. 读取不认领、不写业务事实、不启动模型；预检**不能**通过内部"试写再回滚"实现。
2. 业务写入仍走唯一宿主；写口锁内核实所有权、版本、幂等与必要来源，**不能信任预检票据放行**。
3. `source_manifest` 覆盖当前验证所依赖的源码/配置/迁移；哈希正确只证明字节匹配，**不证明覆盖完整**。
4. 提交、自检、独审、复测、用户接受分开；任何简化操作都不能冒充其他角色签名。
5. 旧失败/旧证据/旧批次保留。完整验证后才能更新证据，不自动接受变化、不删除必需项换放行。
6. 监听、mtime/size、TTL、seq **不是**内容未变证明；缺失、不可读、采集残缺与未知保持可见。
7. 同步更新中不得伪装通过；只把等待/重试原因表达清楚，不用旧图顶替当前门禁依据。
8. 新协议不静默改变旧契约语义；旧客户端和旧历史能读回，不能让旧客户端误放新格式。

## 2. 已核对为"已有能力、不再重复施工"的项

| 已有能力 | 当前证据 | 本批处理 |
|---|---|---|
| 简报 summary/full/reason 与理由版本校验 | `src/server/work/taskBrief.ts`、`src/mcp/tools/taskBrief.ts` | 保留，不再造入口 |
| 按卡/章节/行取原文与完整版本续读 | `src/server/work/documents.ts`、`src/mcp/tools/readPlan.ts`、`src/mcp/tools/readDesign.ts`、`src/server/work/continuation.ts` | 保留，P1 只补"设计引用→实际定位" |
| 提交五查、聚合 failures、同键同内容返原回执 | `src/server/work/claims.ts#submitTaskResult`、`src/server/work/service.ts#submit` | 已有；P2 只提取共享纯核心并加只读预检 |
| `source_manifest` 按相关源核验 | `src/server/work/sourceEvidence.ts`、DESIGN §5.6 | 已有；覆盖集由审查者负责 |
| 事件账本增量解析、只读作业线程池、请求共享 | `src/server/work/eventReadCache.ts`、`readWorkerPool.ts`、`readJobs.ts` | 已有，不重做 |
| 同步历史批次免重扫、在途请求合并 | `src/server/work/sync.ts`、`syncDiscovery.ts` | 已有；P3 只加修复指引 |
| 图语义未变不翻新时间戳、随机临时目录排除 | `src/arch/parse.ts#writeModulesStable`、`src/arch/config.ts`（**未提交补丁**） | P0 先冻结并核齐复核；P3 复用不重写 |
| 单写、自愈、续约/释放/reopen、执行回执 | `workHost.ts`、`service.ts`、`claims.ts`、`executionReceipts.ts` | 保留；不把租约超时当进程停止，不造调度器 |

## 3. 共享红线（跨 P0–P3）

- **一事一源**：同一判据不得有两份实现。新增能力必须复用现有函数（`resolveDesignRef`、`buildSectionIndex`、`findSection`、`markdownSectionDigest`、`sourceFingerprint`、`buildOutputManifest`、`evaluateBuildStamps`、`evaluateBatch`、`writeModulesStable` 等），不得另写近似判据。
- **只读就是零写入**：零写入要按字节判（事件文件无新增事件、证据库无新增内容寻址件），不是一句声明。
- **不可知就写未知**：读失败、来源缺失、章节定位不到、宿主版本不支持，一律显式成 `unknown`/`unresolved`/`unsupported`/`not_checked`，**不得**降级成"通过"或"没配置"。
- **不编造**：不编预计用时（ETA）、不编身份、不编覆盖范围、不编责任角色。

## 4. P0 · 运行部件构建身份与发布覆盖（卡 V09-45）

### 4.1 身份对象（字段闭集）

拟新增 `src/shared/buildIdentity.ts`（浏览器安全：零 node import、零 React，可被前端与服务端共用）与 `scripts/lib/buildIdentity.ts`（构建期推导）。

```ts
export type BuildComponent = "server" | "ui";

/** 两部件**各自实际生效**的编译目标（不是同一个纯环境标签，也不是"后端目标"外推到前端）。
 *  server 值 = `scripts/build-server.ts` 传给 vite 的 `build.target`（实际 "node20"）；
 *  ui 值 = `vite.config.ts` 传给 vite 的 `build.target`（实际 "baseline-widely-available"）。
 *  声明值来自同一处常量且**确实驱动**构建选项——标签不再是"猜的默认"。 */
export interface BuildTargets {
  server: string;
  ui: string;
}
/** 实际参与编译的打包器版本（从已安装依赖解析；读不出如实 "unknown"，**不编**）。 */
export interface BundlerVersions {
  vite: string;
  rollup: string;
  esbuild: string;
}
export interface ToolchainIdentity {
  node: string;            // process.version，如 "v24.x.y"
  pnpm: string;            // 构建时实际使用的 pnpm 版本；读不出写 "unknown"，不编（不调用 pnpm）
  platform: string;        // process.platform
  arch: string;            // process.arch
  targets: BuildTargets;   // 两部件各自实际生效的编译目标（上）
  bundler: BundlerVersions; // 实际打包器版本（同一源码+锁、换过工具链 ⇒ 不同 release_id）
}

/** 已内嵌身份：只有构建期真的把身份烙进这份产物时才可能出现 */
export interface KnownBuildIdentity {
  schema_version: 1;
  component: BuildComponent;
  embedded: true;
  release_id: string;               // 见 §4.3；同一批构建的 server/ui 相同
  build_id: string;                 // 见 §4.3；按部件区分
  source_input_fingerprint: string; // 本部件构建输入集指纹（见 §4.2）
  built_at: string;                 // 只标时间，不参与 release_id/build_id 推导
  toolchain: ToolchainIdentity;     // 构建环境/编译目标/打包器（进 release_id，随身份带出便于对照）
}

/** 未知身份：源码直跑 / 旧包未内嵌 / 身份读不出；**不得**与已知身份比较出「一致」 */
export interface UnknownBuildIdentity {
  schema_version: 1;
  component: BuildComponent;
  embedded: false;
  reason: string;                   // 直跑源码 / 未内嵌 / 读取失败（原样带出）
}

export type BuildIdentity = KnownBuildIdentity | UnknownBuildIdentity;

export function resolveBuildIdentity(component: BuildComponent): BuildIdentity;
```

- **类型上不可能自相矛盾**：`embedded:true` 只出现在 `KnownBuildIdentity` 上，「不知道」只能经 `UnknownBuildIdentity` 表达（Codex 纠正；原草案用单一 interface 声明 `embedded:true` 却返回 `false`，不合法也不诚实）。
- 消费方必须**先窄化 `embedded === true`** 才允许做身份比较；否则一律按 `unknown` 上报（点名原因，不说"一致"）。
- `built_at` 只标时间：改时间戳不改 `release_id`/`build_id`（反例断言）。

### 4.2 构建输入集（显式清单 + 漂移检测）

- 身份**只对显式构建输入集**计算；清单在 `scripts/lib/buildIdentity.ts` 里**只写一处**（每部件一组 include glob），并显式排除：
  - `dist/**`、`src-tauri/target/**`、`src-tauri/resources/**`（含 `resources/server/**`，即随包后端产物）、`node_modules/**`、`.工作台/**`、`audit/**`、`__pycache__/**`、`.git/**`；
  - 身份自身的生成物与虚拟身份常量，避免**自指**（写值即改树、值当场失效）。
- 输入集必须覆盖：**server 与 UI 实际共享的依赖**（例如 `src/shared/**`，以及被两侧任一侧实际引用的 `src/arch/**` 等）＋**静态资源**（`public/**`、`index.html`）＋**构建配置与工具链输入**（`vite.config.ts`、`tsconfig.json`、`package.json`、`pnpm-lock.yaml`、`src-tauri/tauri.conf.json`、`scripts/build-server.ts`、`scripts/lib/buildIdentity.ts`）。共享依赖**同时进两边集合**，不靠手写猜测——以构建实际模块图核对（见下条）。
- **第三方模块按锁文件与工具链归属，不按源码清单判**：漂移检测把「解析到 `node_modules/` 下的模块」与 Node 内建模块**排除在"清单外源码"判定之外**——它们的身份由 `pnpm-lock.yaml`（已在输入集内）与 `toolchain_identity` 承担；只有**仓库内源码模块**出现在显式清单之外才算漂移（Codex 纠正：不能把 node_modules 全部误判为清单外源码）。
- 输入集是**内容**（相对路径 + 文件字节）的确定性哈希，与 Git ref 无关（只 commit 不动内容 ⇒ 指纹不变）。
- **`src-tauri/resources/server` 的自指反例是硬要求**：现有 `scripts/lib/sourceFingerprint.ts:16` 的 `SKIP_DIRS` **不含** `resources`，故本批要另建输入集，**不得**直接复用全树 `sourceFingerprint` 充当身份输入指纹（V09-04 全树指纹保持原用途）。
- **漂移检测（构建后）**：把**实际打进产物的模块清单**（`build-server.ts` 已从 vite 结果拿到的 `chunk.modules`）与显式输入集比对；出现**仓库内**清单外模块 ⇒ **FAIL**（不静默放行）。这样"显式清单悄悄过期"不会变成假绿。
- 构建输入先冻结、构建后复核同一清单未漂移；**生成的身份文件不回灌进其自身指纹**。

### 4.3 `release_id` / `build_id` 推导（规范性）

```
toolchain_identity = {node, pnpm, platform, arch, targets:{server,ui}, bundler:{vite,rollup,esbuild}}  # 构建环境/编译目标/打包器纳入身份
server_input_fp    = 输入集哈希（server 组，见 §4.2）
ui_input_fp        = 输入集哈希（ui 组，见 §4.2）
release_id = sha256( canonical_json([APP_VERSION, server_input_fp, ui_input_fp, toolchain_identity]) )
build_id   = sha256( canonical_json([release_id, component]) )
```

- 实现按上面**实际字段**推导（`scripts/lib/buildIdentity.ts#toolchainIdentity`／`computeReleaseId`／`computeBuildId`）：`targets` 是 `{server,ui}` 两个**各自实际生效**的值，`bundler` 是 `{vite,rollup,esbuild}` 三个**实际解析**出来的版本——不是单一 `target` 标签。
- **输出冻结**（§4.4／§4.5 关联的构建期产物核对）：构建期对 `dist/` 输出清单取一次指纹（`buildOutputManifest#outputManifestFingerprint` + `STAMP_SELF_PATHS` 排除戳自身以避免自指），`scripts/package-bind.ts` 写盘前**逐字节**核对该冻结清单（产物字节变化/缺失即 FAIL），并同时核对产物内嵌身份与引用闭包。

- `canonical_json` = 键序递归排序的确定性序列化。**实现方式（Codex 纠正）**：把纯函数 `stableStringify` **提取**到 `src/shared/stableJson.ts`（零 node import、零 React，浏览器与构建脚本都能引），`src/server/work/syncContract.ts` **再导出同名函数**——原导出与行为一字不变（同步契约的既有消费者不受影响），构建层与前端 bundle **不**因此引入 `server/work` 的依赖环；**不得**另写一份近似序列化。
- `APP_VERSION` 仍取 `src/shared/version.ts`（唯一来源＝`package.json` 的 `version`）。
- **不加入 `protocol_revision`**：全仓无该概念、无消费者；P2/P4 的能力声明随各自新接口实施，不在 P0 预置占位。

### 4.4 内嵌与读取口径

- **内嵌**：构建期把身份**烙进产物**。推荐机制＝构建器 `define`（vite/rollup 在编译期替换标识符，`src/shared/version.ts` 的内联先例同类），源码里以

  ```ts
  declare const __TATAI_BUILD_IDENTITY__: BuildIdentity | undefined;
  export function resolveBuildIdentity(component: BuildComponent): BuildIdentity { /* typeof 判未内嵌 → 未知态 */ }
  ```

  读取；未内嵌（`tsx` 直跑源码、未重建的旧包）走未知态。
- **活进程返回启动时载入的常量**：`/health` 等读口**不得**在每次请求时读磁盘上的 `build-stamp.json` 冒充"我加载的是它"。请求时读盘只能在"明确说明这是磁盘现状、不是本进程身份"的独立字段里出现（本批不引入该字段）。
- 既有 `scripts/lib/buildStamp.ts` 的构建尾戳与 `scripts/package-bind.ts` 的绑定**继续保留**：它们回答"这批产物出自哪次构建运行、该运行结束时的树指纹是多少"；新身份回答"这个运行部件实际加载了哪次构建"。两者通过发布清单**关联**，不互相替代；**不得**只取构建结束时的脏树哈希就断言所有产物同源。

### 4.5 与既有 V09-04 物-源绑定的关系

- **不另造第二套产物核验判据**：复用 `buildOutputManifest`、`evaluateBuildStamps`、`package-bind.ts`，在其中**增加** component/`build_id` 与输入清单的关联。
- server-only 构建若需要子清单，仍用同一清单原语并**标明覆盖范围**，不冒充完整安装包。
- **源码指纹与产物哈希本来就不同，不得要求直接相等**；V09-04 的全树指纹保持原用途不变。

### 4.6 对外读口与偏斜诊断

| 读口 | 返回 |
|---|---|
| `GET /api/work/health`（`src/server/work/service.ts#info` 扩展） | `{ok, service, schema_version, pid, data_dir, registered_event_types, read_workers, build_identity:{…server…}}` |
| `GET /health`（`src/server/index.ts`） | 现有字段 ＋ `build_identity`（server） |
| MCP `doctor` | service 段增加 `build_identity`（server，经宿主 `/api/work/health` 读回；读不到写 `unknown` 与原因） |
| UI 诊断处 | 显示自身（ui）身份；能取到后端身份时**对照出偏斜**（点名部件与 `release_id` 前 12 位） |

- 版本号仍走正常语义版本，**不改 MCP 握手版本格式**。
- 偏斜判定三态：`same_release`（两部件 `release_id` 相同）／`skew`（不同，点名部件）／`unknown`（任一侧未内嵌；**不得**判 `same_release`）。

### 4.7 发布覆盖（出口的一部分）

- 源码、随包后端（`src-tauri/resources/server/`）、前端产物（`dist/`）、桌面壳（`tatai.exe`）与安装器（NSIS/MSI）**必须重建**；`pnpm build` 单独跑不足以替换 Tauri 已嵌入的前端。
- **受控安装后实际读回**：安装版 UI 与 MCP 对同一任务状态/来源读数一致，且安装运行实例报出的身份与本次构建一致。
- 发布用版本目录与受控切换，保留**可回滚的完整包**；旧消费者可能仍在用的旧分片**不被清理**（不硬编码"只能 5 个分片"），核过引用后再回收。
- 部署只把属于本次发布的产物落位；**用户数据、项目 `.工作台/`、事件账本不在应用安装目录内写入**（红线）。

### 4.8 A0 反例清单（必须在隔离环境真跑）

1. **身份归属**：带身份 X 启动 → 磁盘换成 Y → **原进程仍报 X**，新起进程报 Y（07／08 的 O-2 可跑等价；真实安装版对照在发布阶段做）。
2. **自指**：改一处源码 ⇒ server 输入指纹变；只改 `dist/` 或只重跑打包 ⇒ 输入指纹不变；身份生成物本身不进指纹。
3. **清单漂移**：向 server 引入一个清单外模块 ⇒ 漂移检测 FAIL（不静默放行）。
4. **时间不冒充身份**：改 `built_at` ⇒ `release_id`/`build_id` 不变。
5. **偏斜**：server/ui `release_id` 不同可诊断；旧包未内嵌 ⇒ `unknown` 且**不判一致**。
6. **发布完整性**：缺分片的发布被拒；回滚后项目事件仍在、既有证据未被删。

## 5. P1 · 接续材料按任务精确取材（卡 V09-46）

### 5.1 `required_reads` 条目字段（保留旧字段，仅新增可选项）

`RequiredRead` 现状（`src/server/work/entry.ts:363-376`）：`path`、`section?`、`kind`（`StageReadKind`）、`why`、`revision?`、`range?`。本批**新增三个可选项**，旧键一个不动：

| 字段 | 取值 | 语义 |
|---|---|---|
| `purpose?` | `"required_content"` \| `"trace_reference"` \| `"resume_context"` | 材料用途分类：本轮必读正文／追溯指针／中断续接现场。**只是分类，不改判定、不新增授权、不改门禁** |
| `resolution?` | `"resolved"` \| `"unresolved"` | 该条是否已解析到**当前版本**的确定位置（仅设计引用派生条目给出） |
| `source_ref?` | 原始引用 token，如 `"§6.9"`、`"附录 E.5"` | 来自 `TaskDefinition.design_refs` 的原文引用，供人核对与补取 |

- 另加 `resolution_detail?: string`：`unresolved` 时说明原因（章节缺失／每级路径不唯一／引用归一到不存在的章节），并**原样带出原始引用**。
- **`purpose` 恒给**；`resolution`/`source_ref`/`resolution_detail` 只在设计引用派生条目上给出（它们对整份图纸/账本条目没有意义）。
- 字段名与是否恒给在施工时按最新现场固定；**闭键消费者（若存在）同步兼容**，不得静默丢弃未知键。

### 5.2 设计引用 → 章节定位（**新增严格解析入口**；不复用旧 first-match）

**Codex 纠正（本条覆盖原草案的两步法）**：旧 `resolveDesignRef`（`src/shared/designRef.ts`）是**蓝图/投影**用的 first-match 判据，有两处不满足本轮精确取材——① 附录子节缺失时**降级到父节**（`designRef.ts:33-39` 逐级放宽到 `附录 X` 大标题）；② 范围引用**只取第一个命中的编号**（`designRef.ts:41-46` 遇到第一个能匹配的编号就返回，`§2.6–§2.9` 会静默丢掉 `§2.9`）。因此**不得**把它的返回值当"精确定位证明"。

**新增严格解析入口**（拟 `src/shared/designRefStrict.ts`；纯函数：零 fs、零 node import）：

```ts
export type StrictRefTarget =
  | { token_part: string; resolution: "resolved"; path: string; sha256: string; line_start: number; line_end: number }
  | { token_part: string; resolution: "unresolved"; reason: "missing" | "ambiguous" | "malformed" };

export function resolveDesignRefStrict(token: string, sections: readonly MarkdownSectionNode[]): {
  targets: StrictRefTarget[];
  resolution: "resolved" | "unresolved";
};

/** 供严格解析器做唯一性闸；`findSection` 改为复用它（行为一字不变，判据仍只有一处） */
export function findSectionInParsed(sections: readonly MarkdownSectionNode[], selector: string): SectionLookupResult;
```

判据（逐条是 Codex 裁定的落实）：

1. **逐个显式编号**：把 token 拆成显式子目标——单个编号 `§2.8`、范围 `§2.6–§2.9`（必须含 `2.6`、`2.7`、`2.8`、`2.9` 全部成员，不能仅取首尾）、附录子号 `附录 E.2`。**范围只有全部成员都能唯一解析时才整体 `resolved`；任一成员不能唯一解析 ⇒ 整条 `unresolved`**（原引用原样带出），**不取第一个命中**。
2. **匹配**：在 materialSection 解析出的章节树上，按 `title` 前缀 `^<编号>(?![0-9.])`（`level >= 2`）收集**全部**候选：0 个 ⇒ `missing`，>1 个 ⇒ `ambiguous`——**两种都 `unresolved`**，不选第一个、不猜近似标题。
3. **唯一完整标题判据**：候选还须通过 `findSectionInParsed`（完整标题路径**每一级**唯一）才可用；否则按 `ambiguous` 处理。
4. **附录不降级**：`附录 X.N` 必须命中该子节（`X.N` 前缀）；**缺失子节不得降级到附录大标题**。只有 token 本身只给字母（`附录 X`）时才命中附录大标题——那是显式目标，不是回退。
5. **不改旧判据**：`resolveDesignRef` 与其消费者（`src/arch/blueprint.ts:905`、`src/server/work/statusProjection.ts:672`）**本批一字不改**；两套判据并存但**用途分开**（旧的继续服务蓝图/投影，新的只服务接续材料），并在严格模块头部写明差异与理由。
6. **复用 materialSection 口径**：围栏感知解析、每级唯一、哈希＝标题行 + 全部后代（CRLF 归一为 LF）。解析结果（`section`/`revision`/`range`）与阶段必读指针 v2 **同一口径**，因此 `required_reads` 里的 `section` 语义统一为"materialSection 口径的完整标题路径"，**与 `read_design`/`read_plan` 的 `section` 参数口径不同**——执行方按 `path` + `range` 读原文，不转传 `section`。
7. **性能**：一次入口求值只把设计书解析一次（`parseMarkdownSections`），同一次求值内的多条引用**共享同一棵树**；不得每条引用重复整篇解析。
8. **非章节类 token**（需求 ID、审计报告、外部文档如 `AGENTS.md`/`.工作台/**`）按既有分类判据不进章节解析，以 `trace_reference` 条目带出原始引用；本批**不新造分类判据**。

### 5.3 去重与多引用展开

- **去重键统一为 `kind + path + section`**（无 `section` 时视为空串）。当前实现有两套键（硬编码条目用 `kind:path`，阶段条目用 `kind:path#section`，见 `entry.ts:1823-1827`），本批**归一**，行为差异仅为"同文件多段必读不再互相顶掉"。
- **`unresolved` 且无 `section` 的条目必须把 `source_ref` 并入去重键**（Codex 纠正）：否则同一文件的两条**失败**引用会被吞掉第二条，读者看不到「还有一条依据没定位到」。
- 同一设计文件的 N 个引用**逐条输出**（`path` 可重复），仅**相同 `(path, section)`** 去重；**不因压缩删掉必要范围**。
- 整份设计书条目**始终保留**（不删除），只在有解析到的设计引用时把它的 `purpose` 标为 `trace_reference`，否则为 `required_content`。这样"某条引用未解析"也不会连带丢掉"读设计书"这条入口。

### 5.4 用途分类（"不是每轮必读全文"的边界）

| 条目 | `purpose` |
|---|---|
| 施工图卡区（`plan` + `def.section_lines` 派生 `range`） | `required_content` |
| 设计引用解析出的（设计书 + 章节） | `required_content` |
| 整份设计书（无设计引用时） | `required_content` |
| 整份设计书（有设计引用时） | `trace_reference` |
| 生效基线 `baselines.jsonl` | `trace_reference` |
| 事件账本 `events.jsonl`（`task_facts` / `audit`） | `trace_reference` |
| 项目级阶段必读指针条目（`stage-reads.json` 合法条目） | `required_content` |
| 同步阻断时的证据入口（`sync-inbox/*.evidence.json`） | `resume_context` |
| 中断续接现场 `context-resume.json` | `resume_context` |

- 分类**只影响读者怎么用**（先读必读正文、追溯指针按需回读），不改变"这些条目都在必读清单里"这一事实；每条仍带 `why`。

### 5.5 `unresolved` 的语义（红线）

- `unresolved` **不是已读**、**不是已通过**、**不是"可跳过"**：它表示"这一条本任务声明的设计依据现在定位不到"，读者必须按 `source_ref` 与补取入口核实（用 `read_design` 的 `index=true` 或按 `range` 读原文）。
- **不得**用近似标题顶替；**不得**因为 `unresolved` 就少派任务或多派任务（判定层一个字不改）。

### 5.6 兼容与不变量

- 旧字段语义不变；**不变量**：`section` 存在 ⟺ `revision` 是该章节子树哈希（无 `section` 时为整文件字节哈希，v1 口径）。
- 旧客户端仍能按 `path` 读取（新字段是附加项）；`task_brief` 原样透传 `required_reads`，不改投影白名单语义。
- 本批**不增加**"一次取全部原文"的强制调用，不把简报变成长文；入口仍只读、不认领、不调模型、无新业务事件。

### 5.7 A1 反例清单

1. 多设计引用任务：直接按条目读回所需原文，不整篇读取；同文件两段必读**都在**。
2. 缺引用 / 重名标题（每级路径不唯一）/ 章节被移动 / 围栏内伪标题 ⇒ `unresolved` + 原始引用 + 补取入口。
3. 章节外改动 ⇒ 定位不变、哈希不变；章节内改动 ⇒ 该条声明失效（哈希不匹配，须重取）。
4. 旧字段与旧客户端路径读取不退化；无新角色授权、无新业务事件。

## 6. P2 · 提交前只读预检（卡 V09-47）

### 6.1 定位（红线）

- 新增**明确只读**的预检入口（拟名 `preflight_task_result`），配套唯一宿主的**只读路由**。
- **只读**：不写事件、不存证、不续租、不生成证据、不通过自愈启动写服务、不产生认领。
- **不是门禁**：不新增审批层，不是"必须先通过预检才能提交"，不是"已交付"，也不是可绕过提交时校验的**通行票**。
- **不采用**给旧工具加 `mode=check` 的办法：旧服务可能忽略新字段而**真的执行提交**；独立只读名称在旧服务上应明确"工具不存在"，**绝不回退成写入**。

### 6.2 共享纯校验核心与「真正适用的校验」逐项核对

- 从 `claims.ts#submitTaskResult` 提取**纯**判据到 `src/server/work/submitChecks.ts`（拟名），由**预检**与**真实提交**共同调用；不把判据复制到 MCP 工具里。
- **行为不变量**：判据、错误码（`VERSION_CONFLICT`/`CLAIM_NOT_YOURS`/`LEASE_NEEDS_VERIFICATION`/`DEPENDENCY_UNMET`/`EVIDENCE_MISSING`/`INVALID_COMMAND`）与检查顺序**同源不变**（预检与真实提交**共用同一份**纯核心，不各算一套）；"必要文案安全纠正"（见下条，Codex 明确允许，不必为保留泄露而逐字照抄）**不是唯一例外**——见下面的锁内保护。
- **新增锁内保护（本批，如实记为行为改变）**：`task.result_submitted` 在**唯一写入服务临界区内**也走同一份共享结果判据——**直连通用写口手写 `task.result_submitted` 不再能旁路**（缺/空认领 token 或空证据一律被同一份判据拒，**没有"删 token 就跳过"的早退**）。这是相对旧行为的**改变**：此前可绕过的失败路径现被同一判据拦下，故**失败行为/文案不承诺逐字不变**（错误码、判据与检查顺序仍同源）；旧夹具按设计改真认领/真证据，**不为保旧绿放宽**判据。
- **`task.result_submitted` 真正适用的锁内校验（按当前源码逐项核对）**：

  | 校验 | 位置 | 对 result_submitted |
  |---|---|---|
  | 写者身份 `assertWriteOwner` | `service.ts:586` | **适用**（预检路由自己先核一次；其后易主见 §6.7） |
  | `validateWorkCommand`（闭键/字段/actor/role/entity） | `types.ts:368` | **适用**，可预判 |
  | `runtime_entries` 解析 | `service.ts:554-568` | **适用**，可预判 |
  | 幂等（同键同内容/异内容） | `service.ts:592` | **适用**，可预判（与业务层同源） |
  | 版本（锁内按事件重算） | `service.ts:623-646` | **适用**，与业务层五查同值 |
  | `assertClaimSyncGate`（同步门禁） | `service.ts:709`，**仅在 `cmd.type === "task.claimed"` 且非续约时** | **不适用**——**结果提交当前没有该门禁**；**本批不新增**（Codex 裁定） |
  | `assertEntityEventFoldable` | `service.ts:149-154`（`requirement:`/`change:` 之外**早返回**） | 不适用 |
  | `assertRequirementIntentSourceResolvable` | `service.ts:774` | 不适用（仅 requirement.\*） |
  | `assertDefinitionImportReferences` / `assertDefinitionImportHashConsistent` | `service.ts:779`／`:784` | 不适用（仅 `task.definition_imported`） |
  | `assertSelfCheckEvidenceConsistent` | `service.ts:789`／`:272`（仅 `audit.self_check_recorded`） | 不适用 |
  | `verifyReopenCommand` | `service.ts:795` | 不适用（仅 `task.reopened`） |
  | 同步域写边界（`assertSyncContractWriteCommand`／`assertSyncEvidenceWriteCommand`） | `service.ts:816-820` | 不适用（仅 `sync.*`） |
  | `verifyTaskPhaseCommand` | `service.ts:827` | 不适用（仅 `task.blocked`/`task.status_changed`） |

- 因此预检输出必须把**「不适用」与「未检查」分开**表达：`checks.status = not_applicable`（逐条点名命令与理由）与 `not_checked`（§6.7）**不得混用**，更不得把不适用写成已核。
- **必需秘密完全隐藏**（Codex 纠正）：预检的输出与错误文本**不得**出现 `claim_token`，**包括它的前缀**与**内嵌它的幂等键**。现有实现有三处会把秘密带进文本，本批**允许并建议做必要的文案安全纠正**（不要求逐字保留泄露）：
  - `claims.ts:1026` 的冲突文案里直接拼了 `retryKey`（该键含完整 `claim_token`）；
  - `service.ts:597` 同理（写路径的 `cmd.idempotency_key`）；
  - `claims.ts:1073` 回显 `state.claim_token.slice(0, 12)` 前缀。
  纠正后**错误码、判据与检查顺序不变**，相关回归同步核对；预检响应也不回显 `idempotency_key`。
- **引用存在 ≠ 内容真实 ≠ 覆盖完整**：预检只判"证据引用可解析、内容寻址件在库、项目根内相对路径存在"（即现有 `checkEvidenceRefs` 的判据）；**预检不证明测试真的跑过，也不证明覆盖完整**——那属自检/独立审计，必须在结果里如实分开（§6.7 第 3 条）。

### 6.3 幂等前置

- 复用**同一份**幂等键推导（`claims.ts:1020`：`${taskId}:task.result_submitted:${expected_revision+1}:${change_id}:${claim_token}`）与同一份内容比对（`resultIntentMatches`）。
- 命中同键：同内容 ⇒ 预检返回 `already_submitted` ＋ 原事件回执（`event_id`/`seq`/`received_at`/`entity_revision`），**不冒称当前五查通过**；异内容 ⇒ `conflict`（对应提交侧的 `IDEMPOTENCY_CONFLICT`）。
- `already_submitted` **不是产品验收**。

### 6.4 宿主只读路由

- 拟新增 `POST /api/work/preflight`（与现有只读读口同一 `WORK_TOKEN_HEADER` 鉴权门，`service.ts:1124`）。
  - 用 POST 而不是 GET：输入是表单式的大对象（证据引用、交付物），且 **`claim_token` 是秘密**，不应进 URL/查询串（避免日志与代理留痕）。
  - 该路由**声明只读**：不得调用 `appendEventDurable`、`writeSnapshot`、`putEvidence`、续租、`ensureWorkService`/自愈，不启动任何 writer。
  - 进路由后先 `service.assertWriteOwner()`：回答"在可校验的写者身份下"成立；抛 `SERVICE_UNAVAILABLE` 时调用方报 `unavailable`，**不报通过**。
  - **桌面宿主转发**：`src/server/index.ts` 的 work 面逐条放行清单（`service.ts` 侧见 `handleWorkRequest`，宿主侧见 `/api/work/*` 转发判断，`src/server/index.ts:802-830` 一带）必须同步加这一条 **方法 + 精确路径**，否则该端点会在桌面宿主落进兜底 404。
- **路由面清单登记**：同步登记进 `src/server/remote-routes.ts`（`kind:"write"`）——`verify-s2` 段②按清单锚点与 `req.method` 提及数与 `index.ts` 源码逐条对账，漏登记即红。只读远程模式下该 POST 由**既有**远程红线先拒（**沿用既有远程授权规则，不新增授权模式**；业务语义只读、`claim_token` 走 body 而**不是**传输令牌头）。
- 实现口径：路由直接调用共享纯核心（同步、有界、不占主线程长任务）；**不**走 `submitAsync` 的锁外 preparation，也不排进只读作业队列（预检的意义就是"提交前快速一次"）。若实测证明该判据耗时显著（例如大项目 `importTaskDefinitions`），再按有界作业设计另议——**不在设计阶段先承诺性能**。

### 6.5 能力协商（净新增协议面）

- 响应带 `supported_contract: "preflight/v1"`；宿主不支持该路由（404/405/未知端点）或返回不完整时，MCP 工具返回 `{ok:false, code:"UNSUPPORTED_BY_HOST"}` 并给明确指引（直接用 `submit_task_result`，或升级宿主）。
- **禁止**回退：不得回退到 `/api/work/command`（那是写），不得在 MCP 进程本地另算一套判据冒充"远端已支持"——那会漏掉宿主的锁内判据（07 第 3 条：五查在业务调用层，最终写服务另有锁内判据，P2 必须同时覆盖两层）。
- 客户端不能**仅凭自己已有工具描述**判断远端支持；只认宿主实际响应。
- 可选：`doctor` 增加一行"宿主是否支持只读预检路由"，便于接续时一眼看出能力缺失。

### 6.6 输入 / 输出

- **输入**与 `submit_task_result` **同形**（原必填仍必填）：`project_id`/`task_id`/`role`/`change_id`/`claim_token`/`expected_revision`/`evidence_refs` 等，面向**已经取得合法认领的执行者**；未认领者用 `project_entry`/`task_brief` 的 `preconditions` 看准备条件（不把预检当"未认领也能提交"的入口）。
- **输出（拟形状）**：

```jsonc
{
  "ok": true,
  "supported_contract": "preflight/v1",
  "observed_versions": { "task_revision": 12, "plan_definition_sha256": "…", "design_revision": "…" },
  "checks": [
    { "kind": "task_version", "status": "passed", "expected": 12, "actual": 12,
      "source_ref": ".工作台/work/events.jsonl", "remediation": null }
  ],
  "not_checked": [
    { "kind": "lock_in_recheck", "reason": "预检到提交之间任务版本/认领/租约可能被他人改变；提交时在唯一写入服务临界区内按当前事实重核" }
  ],
  "already_submitted": null,
  "recheck_on_commit": true
}
```

- `status` 取值闭集：`passed` / `failed` / `not_applicable` / `not_checked`。**未执行的检查只能是 `not_checked`**，不得 `passed`；**本命令不适用的锁内校验**（§6.2 表）用 `not_applicable` 并逐条点名，不得与 `not_checked` 混用。
- **必需秘密不回显**：`claim_token` 不出现在任何 `expected`/`actual`/`remediation`/错误文本与日志里。
- 预检**不能**把未存证的引用、尚未跑过的验证标为通过：只给准备步骤（例如"证据引用是项目根内相对路径，文件存在即通过；内容寻址引用必须在库"）。

### 6.7 锁内未查项（`not_checked` 必备条目）

对 `task.result_submitted` 至少列出：

1. **锁内按当前事实重核**：预检与提交之间版本/认领/持有者/租约/依赖可能变化——提交在唯一写入服务临界区内重核；`recheck_on_commit=true`。
2. **写者身份的时间边界**：路由已核当前写者身份，但身份在预检到提交之间可能易主（TOCTOU 由提交侧 `assertWriteOwner` 兜住）。
3. **测试执行与覆盖完整性不在预检断言范围**：预检只能证明"引用的证据材料可解析/在库/路径存在"，**不能**证明某项验证真的跑过、退出码真实、覆盖完整或独立审查已做——这些必须在 `not_checked` 里点名，并在 `checks` 里绝不出 `passed`。
4. **对 `task.result_submitted` 不适用的锁内校验**（§6.2 表）逐条以 `not_applicable` 说明，**不列入已核**。
5. **本批不新增结果提交的同步门禁**（Codex 裁定）：预检**不得**因此引入、也不得声称结果提交当前受 `assertClaimSyncGate` 约束——该门禁只作用于**首次认领/非续约的 `task.claimed`**。若项目配置了 `blocks_entry` 批次，其阻断体现在入口/认领路径（§2.10），不在此处。

### 6.8 A2 反例清单（零写入按字节判）

1. **一致**：冻结输入下预检与真实提交的失败项相符（同输入对照）。
2. **一次列清**：多缺项在一次响应里列全。
3. **变化仍拒**：预检→提交之间源变／任务变／所有权变 ⇒ 提交仍被拒。
4. **幂等**：同请求丢回执重发 ⇒ 提交侧只有一个结果事件；异内容同键 ⇒ 拒绝；已提交预检 ⇒ `already_submitted`。
5. **零写入**：调用前后 `<项目根>/.工作台/work/events.jsonl` **字节不变**、证据库**无新增内容寻址件**、**无认领续期**；测试在隔离且无其他写者的夹具中做（不把并行生产写入误归因）。
6. **未执行的不通过**：未跑的检查不 `passed`。
7. **能力协商**：新 MCP 配旧宿主 ⇒ `UNSUPPORTED_BY_HOST` 且**零写入**。

## 7. P3 · 同步修复计划与候选证据边界（卡 V09-48）

### 7.1 只读修复计划（现行批次）

在 `read_sync_status`／`project_entry` 的同步段上**只读附加**修复计划（`src/shared/syncEvidence.ts` 增字段；`sync.ts#readSyncStatus` 填充；MCP/HTTP/UI 同源）。逐项至少给：

| 字段 | 来源（不重算） |
|---|---|
| `item_id` / `label` / `required` / `verdict` | 本次 `evaluateBatch` 的 `SyncItemReport` |
| `reasons` | 同上（本次实时核验的逐条理由） |
| `expected` / `actual` | 同上（同一份值，不另算） |
| `source_drift[]` | `contractSourceSnapshot` 的来源快照：`{path, registered_sha256, current_sha256|null}` |
| `reusable_artifacts[]` | 证据包里**哈希仍与当前目标一致**的工件引用（可复用），与已失效引用分开列 |
| `contract_generation` | `{sha256_12, registered_seq, active}`（来自 `FoldedBatch`） |
| `registered_by` | 契约**登记事件**的 `role`／`actor_id`（`foldSync` 时随 `FoldedBatch` 捕获，**不改契约 schema**） |
| `recommended_role` | 按**失败类型**给出的**建议**承接角色：来源漂移/目标不符 → `coordinator`；必需项缺证/验证未跑 → `executor`；结论冲突/证据采信 → `auditor` |
| `next_read_entry` | 工具调用字符串（如 `read_sync_status {project_id}` / `scan_sync_evidence {project_id}` / `project_entry {project_id, role}`） |

- **`registered_by` 与 `recommended_role` 必须分开**（Codex 纠正）：登记契约的人**不是**所有修复项的责任人；`recommended_role` **只是按失败类型的建议**，**不替人授权、不构成指派**，也不改变任何角色的实际权限。
- **修复计划只列来源漂移，不自动刷新**：它给出"哪里漂了、谁建议补、从哪个入口读"，**不得**自动重算哈希、自动补证、自动改契约或自动缩小必需项。
- **只对现行（active）批次给修复计划**；历史批次（被 supersede）不参与、不阻断，`historical:true` 语义不变。
- 共因项可分组显示，但**完整项不可省略**。

#### 7.1.1 task_brief summary 的紧凑修复导航（集成修正，2026-10-06）

- **实际证据**：`repair_plan` 逐项带 `expected`/`actual`/`reasons`/候选工件，冻结示例项目同快照单批即约 349KB；`task_brief`
  默认 `detail=summary` 若原样透传，返回体由约 36KB 膨胀到约 390KB，与「Agent 更容易接手」冲突。
- **修正**：`task_brief` **默认 summary** 把**新增的** `repair_plan` 转**紧凑导航**——现形（active）批次数、逐 `verdict`
  项数、阻断批次数、`waiting_for_derivation` 等待计数、`read_only`、可保留的**有界每批摘要**（批 id/标题/verdict/计数/
  漂移**路径**）、明确 `omitted`、**结构化 `refetch`**（`read_sync_status(project_id)`）；**不再**逐项内联 `expected`/`actual`/
  `reasons`/补证动作/候选 JSON。
- **不改完整**：`read_sync_status` 与 `project_entry`／`task_brief detail=full` **一字不删**地保留完整修复计划（全部
  `item_id`/`expected`/`actual`/原因/候选与身份）。`summary` **不重算**同步——只压缩同一次评估已有的投影。
- **类型区分**：summary 的 `repair_plan`（`BriefRepairNavigation`，带 `nav:true` 判别位）与完整 `SyncRepairPlan` 同键不同型，不混用；
  旧 `task_brief` 字段语义不变，缩略**仅**作用于本批新增的 `repair_plan`。
- **验收预算**：对本快照 `summary` 的新增修复导航 ≤ 8KB（本次回归预算，不声称全项目统一 SLA）；真实同快照字节与完整读回见本轮证据。

### 7.2 候选证据的边界（本批**只返回 JSON、不新增保存入口**）

- **候选是明确"未验证的草稿"**（Codex 纠正），不是证据、不是通过、不是独立审查结论。
- **本批决定：只在响应里返回候选 JSON，零落盘，不新增任何保存入口**（原草案把"保存草稿"列为可选项，现按 Codex 裁定收敛为**不做**）。理由：不新增产品面就能满足"给协调者一份可核对的机械候选"，也避免草稿位成为绕过正式链路的旁路。
- 若**将来**要实现保存（不在本批范围），实现必须同时满足：
  - 由**获授权协调者**显式请求**唯一宿主**、用**既有判据**（`parseEvidencePackage` ＋ `evaluateBatch` 同一套校验）生成/校验；
  - 保存到 `.工作台/work/sync-drafts/<batch_id>.candidate.json`，**不进 `sync-inbox`**；
  - **构造性保证**（不是注释要求）：现行发现链路只列 `SYNC_INBOX_REL`（`listInboxEvidence` 非递归 `readdirSync` + 只认 `<batch_id>.evidence.json`，`syncDiscovery.ts:354-363` 同款），草稿目录**不会被扫到**；施工时补**断言**钉住这个边界；草稿目录同样不得作为契约的来源或目标（比照"收件目录内不得作独立目标"的自引用口径）。
- **候选进入正式链路时必须"实核候选输入版本"**（Codex 纠正：不能只有注释要求）：确认后仍走原 `register`/`scan` 链路，写入时**实际读取并核对**候选所依据的契约 `contract_sha256` 与目标当前字节；源在确认后再次变化 ⇒ **候选被拒**（不是"提示一下"）。
- 候选**不得**修改 `required`／`blocks_entry`；**由同一份源生成不构成独立审查证据**（"机器生成"≠ 独立）；候选必须注明身份与输入版本（谁生成、依据哪一版契约与目标）。

### 7.3 图等待派生

- 命中"图正在派生"导致的 `graph_full` 未通过时，修复计划如实给 `waiting_for_derivation` ＋**可重试原因**（复用 `src/server/work/graphUpdate.ts` 的状态：`updating` + phase；ETA 只用有依据的实测值，依据不足写"无法估计"，**不编造**）。
- **这只是说明**：v1 `required graph_full` 未满足时**仍阻断**；`blocks_entry` 语义不变。
- 重试**有界**并**合并同代请求**（复用 `syncDiscovery` 的单飞与合并，不新建重试器）。

### 7.4 本批明确不做（防止"暗中接受漂移"）

- 不把现行状态检查改成 `at_registration`；
- 不把整文件绑定悄悄降成章节绑定；
- 不普遍剥除 `graph-update`/`semantic-status`/`reconcile-last` 的时间、状态或错误字段（只有**已证明不影响语义**的字段允许专门处理，并逐字段论证＋留档）；
- 不新增近似比较器（复用 `writeModulesStable` 等既有判据）；
- 来源、检查类型及范围变化必须保留等价性论证与授权记录。

### 7.5 A3 反例清单

1. 同语义重生成 ⇒ 不漂移；真实源码/设计变化 ⇒ 准确失效。
2. 一次返回全部待补项（完整 `item_id`、期望/实际、责任角色、代次、下一读取入口）。
3. 源再次变化 ⇒ 候选被拒；被 supersede 的历史批次不恢复全量扫描。
4. 当前批次的必需项与 `blocks_entry` **均未被削弱**；未知/损坏/失联仍阻断。

## 8. P4 / P5 · 条件启动（卡 V09-49 判定，不默认启动）

> **2026-10-06 裁定（Codex，本批后追加）**：**P4 未证明，维持 v1、不启动**；**P5 已按实测条件启动**——真实全量采集 **25–31 s**、解析占采集约 **98.7%**、JS 树遍历/import 提取约 **72%**（依据 `replay/FINAL-REPORT.md` §8），正式由 **PLAN V09-50**（**只依赖 V09-45**）承接；**V09-49 的最终集成验收涵盖 V09-50 产物**。

### 8.1 启动条件与所需证据

- **P4 启动条件**：P0–P3 落地后，在**冻结的真实回放**中仍证明"不相关任务因同批图变化反复不能新领"，**且**有可审查的需求/任务范围映射。否则**保持 v1**，不为理论收益扩协议。
- **P5 启动条件**：同版安装与 P3 稳定后，**剖析**证明剩余主要耗时来自遍历/解析（而非版本错配或反复同步）。**已有读线程池与请求共享不得重做**；源码异步扫描是否搬进 worker 由实测决定。**（2026-10-06 实测满足：真实示例项目全量 `arch/parse` 25–31 s，证据见 §8.3。）**

### 8.2 P4 首版范围（属正式协议变更，须另立卡）

- 只支持 `project`／`task_set` 两种作用域，**暂不支持 `paths`**（路径不足以可靠说明业务影响）。这是 DESIGN §2.10 与同步契约的正式语义变更，**不能只改 `computeSyncBlock` 的 if**。
- v1 缺省仍是项目全局；新格式包含明确任务 ID、定义版本、包含哪些验收义务，以及**未分类任务的保守行为**。
- **必需义务不消失**：任务范围内的认领/验证受其必需项约束，整体交付仍汇总全部未完成义务；不能通过多个局部放行冒充全项目验收。
- 新任务/定义漂移/依赖映射不完整默认**不自动判无关**；给协调者明确补映射入口。
- 老批次迁移须**逐必需项给出承接对象与理由**，保留旧批次、授权人与版本；不允许普通 `supersede` 直接削减范围（沿用 `supersedeProblems` 判据）。
- `entry`／`claim`／直连写口采用**同一上下文求值函数**（一处判据、三处同判）。
- **能力协商是净新增协议面**：宿主报告所支持契约版本，客户端明确声明理解的版本，服务端按**实际契约**重新判定，不把客户端声明当授权。**未迁移的 v1 项目旧客户端照常工作**（保守按项目全局）；含 v2 契约的项目对不支持 v2 的旧客户端明确 `unsupported`、不写入，**不能按 v1 忽略 scope 放行**。迁移前核全部必要消费者可用，避免把运行中项目迁成无人能写。
- 回滚到 v1 只能恢复更保守的全局约束，保留 v2 事实及解释；**不复制旧绿色快照**。

### 8.3 P5 首版范围

- 先记录：遍历数、实际解析数、单文件解析耗时、队列等待、读取/哈希/构图及序列化成本。
- 若容量是问题：设计项目级**有界采集**配置，区分产品源码与审计附件；排除规则**显式可审计**，不把少扫冒充全量。
- 若主线程长任务是问题：复用**已有**有界作业设施设计扫描任务；唯一宿主发布前比输入代次，取消/过期任务不发布，**不能由 worker 写账本**。
- 若需要文件内容缓存：仍以**完整内容校验**保证正确；通知丢失、同大小 mtime 改写、重启与缓存损坏都有确定回退。
- **不先承诺** 300 秒预算或某个倍率。

**本轮证据与实施边界（2026-10-06，Codex 裁定启动；施工卡 PLAN V09-50）**

- **真实证据（`replay/FINAL-REPORT.md` §8，与 `parse.ts` 逐字节未变）**：真实示例项目全量 `arch/parse` **25–31 s**（本机 2 次：25.5 s / 31.1 s）；采集路径 **解析占 ~98.7%**，其中 **JS 树遍历/import 提取约 72%**、**tree-sitter 约 29%**、**IO 仅 0.7%**；**遍历不是瓶颈**（真实根 21,958 文件仅 265–377 ms）。`src/arch/parse.ts` 在 P0–P3 前后与主仓**逐字节相同** ⇒ 旧采集数字只作**优化前**，不是本轮 P0–P3 的收益或回归。
- **实施边界（有界热路径等价优化，不得扩面）**：
  - 只动**采集热路径**（`src/arch/parse.ts`）；**产出契约 `FileImports{targets,loc,skip}` 与 `modules.json` 逐字段不变**，完整采集语义（模块 `targets`/`loc`/`skip`）**不变**。
  - **不新增**采集协议／worker／缓存／排除规则；**不重做**已有读线程池与请求共享；**不改变** 50,000 文件上限等既有配置边界。
  - **不得少扫换性能**（不缩 `targets`、不跳文件、不改模块集）；**不得把 `mtime`／size 当内容证明**。
  - **nested import/require、语法错误文件仍须覆盖**；**取消/过期结果不得发布**（沿用 §7 与既有同步/派生判据）。
  - 手段（如 tree-sitter **S-expression query** 或只下钻的**剪枝遍历**）**必须由实际实现与等价证据支持**，**不得把剖析报告里的建议当定版**，**不先承诺倍率**。
  - 收益须在**可核对同版构建**（V09-45 身份）上实测给出数，并覆盖**受影响异步链路**与**最终安装包**（重建、受控安装、读回）。

## 9. 验证、证据与角色

### 9.1 每卡门槛

- `pnpm typecheck`（改 UI 另加 `pnpm build`，改随包后端/MCP 另加 `pnpm build:server`）＋本卡 `verify` 脚本＋受影响回归；
- 证据落 `.工作台/evidence/<卡号>/<attempt>/`（或卡面约定的隔离证据根）。

### 9.2 新增与定向更新（判据不放宽）

- 新增：`scripts/verify-build-identity.ts`、`verify-agent-materials.ts`、`verify-preflight-task-result.ts`、`verify-sync-repair.ts`（卡面原拟 `verify-v09-45.ts`／`46`／`47`／`48`，2026-10-06 集成按实际交付文件名登记，不另造重复脚本；`package.json` 别名同名）。V09-50 的 `scripts/verify-v09-50.ts` 已与 `verify:v09-50` 别名一同集成：默认使用自包含夹具；外部旧实现与数据集必须显式指定，不默认扫描私有项目。
- 定向更新（须按"旧期望／依据／新期望／保留意图／判据不放宽"五要素留档）：`verify:u2`（工具清单 29→30）、`verify:m2`（新增 `V0947_TOOLS` 分组）、`verify:v09-05`（MCP 分组名与 README 计数同源对账）、`verify:v06-02`（PLAN 卡行 72→77→**78**）、`verify:v09-03`（PLAN 前缀钉值 4a80100a…→**6d39e2ba…**）、`verify:des-current`（受检导入后转正）。
- 回归（复跑、不重跑无关全量）：`verify:task-brief`、`verify:task-brief-summary`、`verify:unified-entry`、`verify:forward-journey`、`verify:sync-evidence`、`verify:sync-incremental`、`verify:sync-request-reuse`、`verify:v09-22`、`verify:sixgraph-planfix`、`verify:v09-04`。
- 施工前先核脚本副作用（证据根、临时目录、是否改动真实项目），在隔离环境执行。

### 9.3 角色分离

- 作者自报、验证通过、独立审计、用户接受**分别记录**；独审者 ≠ 作者；**不接受 `role=user` 代签用户 Gate**。
- 未跑的验证不得写通过；未读的范围不得写成已读。

### 9.4 有效性收益的度量口径

用同一份脱敏/隔离示例项目项目快照做前后对照，生产**只读**观察、不在真实项目注入失败；至少覆盖：新会话接手、局部变更后提交、图派生更新、源变复验、中断重试五条旅程。记录开始有效工作的耗时、必读实际字节/原文覆盖、工具调用与返工次数、同步阻断次数及原因、平台维护时间、响应 p50/p95/max、错误与资源；缺真实模型 token/费用就标 `unknown`，**不把 JSON 缩短比例外推总成本**。性能数值沿用既有统一优化契约的"待实测目标"，**本契约不另造 SLA**。

## 10. 机器影响清单（施工时实测更新）

| 影响点 | 期望变化 |
|---|---|
| `src/mcp/tools/index.ts` 注册表 | ＋`preflight_task_result`（29→30） |
| `scripts/verify-u2.ts` | `MCP_TOOL_NAMES`／`MCP_TOOL_COUNT` 29→30（逐个点名、"恰好"） |
| `scripts/verify-m2.ts` | 新增分组 `V0947_TOOLS`；`scripts/verify-v09-05.ts` 的分组名列表同步 |
| `README.md`／`docs/capabilities.md` | 工具计数与清单同源对账（29→30） |
| `PLAN.md` 第一张当前任务表 | 72→77（本批首批五卡）→**78**（P5 条件启动追加 V09-50）；`scripts/verify-v06-02.ts` 行数钉值定向更新 |
| `PLAN.md` 追加块锚点之前 | `scripts/verify-v09-03.ts` ④ 的 PLAN 前缀 sha256 钉值定向更新（4a80100a…→6d39e2ba…） |
| `src/arch/parse.ts`（V09-50 热路径） | 产出契约 `FileImports{targets,loc,skip}`／`modules.json` **逐字段不变**；不新增采集协议/worker/缓存/排除；同版构建实测收益并覆盖最终安装包；专项脚本 `scripts/verify-v09-50.ts`＋受影响回归 |
| `DESIGN.md` 正文 | 生效基线定义哈希变化 ⇒ 按 §5.6 做影响分析、受检重导与基线重激活（**由获授权角色执行**） |
| v2 事件台账 | 新卡需经受检导入（`import_plan_definitions`，带 `requirement_ids`）后 `verify:des-current` ⑮ 转正 |
| `src/shared/stableJson.ts`（新） | `stableStringify` 提取到纯模块；`syncContract.ts` **再导出同名函数**（原导出与行为不变），消除构建层依赖环 |
| 提交/幂等的错误文案 | 按 §6.2「必要文案安全纠正」去掉 `claims.ts:1026`／`service.ts:597` 的幂等键（内含 token）与 `claims.ts:1073` 的 token 前缀回显；**错误码与判据不变**，受影响回归须核对 |

## 11. 技术选择：均已审定（2026-10-06）

> 状态口径（2026-10-06 修订）：本节**两张表都是已审定技术选择**，不存在"待裁定"项。下面第二张表在草案里曾标「仍待裁定（实现细节，未影响判据）」——那是**草案时点的历史状态**，已由 `coordinator-decisions.md` 末节「设计草案余项的技术裁定」（2026-10-06；同一文本在隔离工作树内为 `docs/agent-optimization-decisions-20261006.md`）逐条裁定，故本节按审定结论表述；裁定与草案推荐逐条一致，判据与验收强度不变。

**已由 `coordinator-decisions.md` 裁定（不再列为未决）**：

| 项 | 裁定 |
|---|---|
| P1 解析入口 | **不复用旧 `resolveDesignRef` 的 first-match**；复用 materialSection 解析与唯一完整标题判据，**新增严格解析入口**；逐个显式编号；范围须可证明完整展开；缺失子节不降父节；歧义不取第一项；`unresolved` 无 `section` 时去重带 `source_ref`；旧蓝图解析语义**不变** |
| P0 身份类型 | `BuildIdentity` 必须是**允许 `embedded:false` 未知态的联合类型**，不得声明 `embedded:true` 后返回 false |
| P0 输入集 | 覆盖 server/UI 实际共享依赖、静态资源与构建配置；**第三方模块按锁文件与工具链归属**，不把 `node_modules` 全部误判为清单外源码 |
| P0 序列化 | 复用稳定序列化**不得**让构建层导入 `server/work` 依赖环 ⇒ 提取共享纯原语并**兼容原导出**（§4.3） |
| P2 门禁边界 | `assertClaimSyncGate` **只用于认领类事件**；**不得**声称结果提交已有该门禁，**不得**因预检新增结果提交同步门禁 |
| P2 秘密 | 共享预检输出**完全隐藏 token**（含前缀与内嵌它的幂等键）；**必要文案安全纠正允许**，不必逐字保留泄露 |
| P2 语义边界 | 预检**不证明**测试真正执行或覆盖完整；**引用存在与内容验证分开**表达 |
| P3 责任 | `registered_by` 与 `recommended_role` **分开**；后者只按失败类型建议，**不替人授权** |
| P3 漂移 | 修复计划**只列来源漂移**，不自动刷新 |
| P3 候选 | 候选是**明确未验证的草稿**；**仅返回 JSON 时不新增保存入口**；确认后进入正式扫描必须**实核候选输入版本**（实现判据，不是注释） |

**已审定技术选择（2026-10-06，`coordinator-decisions.md` 末节逐条裁定）**：

| # | 选择 | 审定结论 |
|---|---|---|
| 1 | 身份内嵌机制 | 构建期 `define` 内联（无生成文件、无自指；源码直跑走 `UnknownBuildIdentity`） |
| 2 | `toolchain_identity` 是否进 `release_id` | 进（同源码不同编译目标不应算同一 release）；`built_at` 不进 |
| 3 | `purpose` 是否恒给 | 恒给（订阅方不必区分「没有」与「未分类」） |
| 4 | 预检路由方法 | `POST /api/work/preflight`（秘密不进 URL/查询串） |
| 5 | 预检是否进只读作业线程池 | 不进（要快、有界）；若实测判据耗时显著再另议 |
| 6 | 严格解析入口放哪 | 新模块 `src/shared/designRefStrict.ts`（旧 `designRef.ts` 一字不改）；`findSectionInParsed` 落在 `materialSection.ts` 并由 `findSection` 复用 |
| 7 | 纯序列化原语的命名/位置 | `src/shared/stableJson.ts` 导出 `stableStringify`；`syncContract.ts` 再导出同名（命名可议，行为不可变） |

## 12. 文档状态：历史准备记录（2026-10-06 草案时点）与当前发布验收要求

**一、历史准备记录（2026-10-06 草案提交时点，如实留档，不再作现在时陈述）**

本文件随设计与施工卡草案一并提交。**草案提交时点（2026-10-06）**的实际状态是：未改任何仓库文件、未部署、未重建产物、未受控安装、未写账本、未激活基线、未登记需求（需求登记是写操作，由获授权协调者执行）、**未代签任何用户 Gate**。这一段描述的是**准备状态的历史记录**——"当时做到哪一步"，**不等于**当前实施结论，**不构成**交付依据。其后 `coordinator-decisions.md`（2026-10-06）已对设计与施工草案逐条审定（§11），本轮实现与验证按规定在隔离目录内推进。

**二、当前发布验收要求（仍然生效，直至用户本人记录 Gate）**

1. **需求登记**：V09-45…V09-50 的正式登记是**写操作**，只能由获授权协调者执行；是否已登记以 PLAN 卡行与账本投影为准，本文件不预先声称已登记。
2. **基线激活**：DESIGN/PLAN 生效基线定义哈希变化时，按 **DESIGN §5.6** 做影响分析、受检重导与基线重激活，由**获授权角色**执行；本文件不预先声称新基线已生效。
3. **集成边界**：本轮实现与测试先在**隔离目录**（`<维护者核验目录>/tatai-agent-optimization-20261006/worktree` 已就位）完成；**主仓集成由协调者在隔离验证通过后统一做**，集成前不得在主干或产物中预置结果。
4. **构建与安装**：发布覆盖（含最终安装包覆盖）以同版真实构建与受控安装的**实测读数**为准；**本文件不预称部署或安装已完成**。
5. **Gate**：**用户 Gate 只能由用户本人记录**；Agent 不代签，任何 Agent 署名不得充当 `role=user`。文档、执行结果、独立审计与用户验收**分别记录**，"可请求验收"不等于"已交付"。
6. **账本与现场**：不手改生产账本；获授权的正式登记经唯一写入服务追加，不覆盖历史事件或用户现场。任务工作目录的 `ledger.md`／`baseline.json` 是**准备账本（历史）**，其"准备状态"**不得**冒充当前实施结论。
