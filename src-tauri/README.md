# 塔台桌面壳（src-tauri）

U1（三期第 1 卡）落的壳 + U2（三期第 2 卡）落的**打包态集成**（路径 / PTY / MCP）。
**这里没有业务 UI**：窗口里跑的就是仓库根 `src/ui` 那一份前端，
壳只负责"开窗口 + 拉起/回收本地 Node 服务"（`PLAN.md` U1 跑偏点：不许为桌面端另写一套界面）。

## 三期的产物目录约定

| 产物 | 路径 | 谁产出 | 进 git |
| --- | --- | --- | --- |
| 前端产物 | `dist/`（`build.frontendDist: "../dist"`） | `pnpm build`（vite） | 否（`.gitignore`） |
| 随包后端源目录 | `src-tauri/resources/server/`（`index.js` + `mcp.js` + 原生 `node_modules/` + `THIRD-PARTY-NOTICES.txt`） | `pnpm build:server`（U2 落地，L2 补第三方声明，见下） | **否（`.gitignore`，V09-04 重打实测 53 个文件 / 9,096,083 B ≈ 8.7MB，含二进制）** |
| 随包 DLL | `src-tauri/resources/WebView2Loader.dll`（160,320 B） | `cargo build` 时由 `src-tauri/build.rs` 从 webview2-com-sys 的产出摆过来（U3，见下） | **否（`.gitignore`）** |
| 壳的编译产物 | `src-tauri/target/debug/`、`target/release/`（`tatai.exe`） | `pnpm tauri:build` / `cargo build` | 否 |
| exe 旁的运行副本 | `src-tauri/target/release/server/`（`tauri build` 把资源复制到 exe 旁边，直接双击 exe 也能跑） | `pnpm tauri:build` | 否 |
| 安装包 | `src-tauri/target/release/bundle/nsis/*.exe`、`.../bundle/msi/*.msi` | `pnpm tauri:build` | 否 |
| Tauri 生成的权限 schema | `src-tauri/gen/schemas/` | 构建时自动生成 | 否 |

**随包链路（U2 已接通，不必再猜）**：

```
pnpm build:server  →  src-tauri/resources/server/{index.js,mcp.js,THIRD-PARTY-NOTICES.txt,node_modules/}
cargo build        →  src-tauri/build.rs 把 WebView2Loader.dll 摆到 resources/（U3，见下）
tauri build        →  bundle.resources {"resources/server":"server", "resources/WebView2Loader.dll":"WebView2Loader.dll"}
                   →  运行时 app.path().resource_dir()/server/index.js   ← backend.rs 找的就是这个
                   →  同时复制一份到 target/release/server/（直接跑 exe 也能起后端）
tauri dev          →  beforeDevCommand = pnpm build:server && pnpm dev
                      （dev 态 bundle.resources 同样要 resources/server，缺了壳启动即报
                        resource path 'resources\server' doesn't exist 退出）
核对：pnpm verify:u2（资源布局 + 包内入口真起 + 安装目录不被写 + 壳自拉 + MCP 连上）
     pnpm verify:u3（安装包产物：载荷逐条对账 + 体积拆分 + 权限/WebView2 口径）
```

`pnpm tauri:build` 的 `beforeBuildCommand` = `pnpm build && pnpm build:server`——**打包前必须先产出随包后端**，
否则装出来的包里有壳没服务（壳会打印"未找到随包的后端入口"并照常开窗，不静默假装服务起来了）。
`pnpm tauri:dev` 侧同理：`beforeDevCommand` = `pnpm build:server && pnpm dev`（约 2 秒），
所以**干净克隆照 README 直跑 `pnpm tauri:dev` 即可，不必手动前置任何一步**——
`bundle.resources` 不分 dev / 打包一律要 `resources/server`，这条没跟上时 dev 直接起不来。

## 随包的第三方声明（L2 补）

`server/index.js`、`server/mcp.js` 是单文件产物，**除 Node 内置模块与原生模块外的全部依赖都内联在里面**
（MCP SDK / zod / ajv / chokidar / node-pty 与 tree-sitter 的 JS 层……），MIT / Apache-2.0 要求再分发时保留版权与许可声明，
而 U3 实测安装包载荷里一个 `licen*` 文件都没有（缺口见 `docs/LICENSE-AUDIT.md` §5.4）。
现由 `scripts/build-server.ts` 在构建时按**实际打进包里的依赖树**生成 `THIRD-PARTY-NOTICES.txt`：
反推内联的 npm 包（读 `package.json` + 包内 LICENSE 的版权行）、列出随包原生二进制、附 MIT 全文、
指向仓库内 `docs/LICENSE-AUDIT.md`（完整审计）与 WebView2 条款落点。
L2 复核实测：NSIS 载荷里能看到 `server\THIRD-PARTY-NOTICES.txt`（9,651 B）；
MSI 的 cab 只有哈希文件名，按大小 + mtime 对账命中同一份。完整审计与登记见 `docs/LICENSE-AUDIT.md`。

## 随包的 WebView2Loader.dll（U3 实测的坑，别再踩）

壳**静态导入** `WebView2Loader.dll`（`objdump -p tatai.exe` 能看到它排在导入表第一行；
windows-gnu 下 `tauri-build` 专门把这个 DLL 复制到 `target/<profile>/`，原因就是这个）。
但 tauri 的 NSIS 打包器只在 `settings.target().ends_with("-gnu")` 时才把它打进安装包，
而不传 `--target` 时那个 target 取的是 **CLI 自己的编译期三元组**
（`tauri_utils::platform::target_triple()` 走 `cfg!()`；npm 发的 Windows CLI 是 `win32-x64-msvc` 版），
于是判定不成立——**NSIS 包里没有这个 DLL**。后果：装完双击图标，进程 8 ms 就退出，
退出码 `3221225781` = `0xC0000135` `STATUS_DLL_NOT_FOUND`（U3 实测，装完真跑才发现；
直接跑 `target/release/tatai.exe` 不会暴露，因为 DLL 就在它旁边）。MSI 没有这道门（它扫 target 目录下的 `*.dll`），
所以**两个包行为不一致**——只有真装真跑才看得出来。

现由两处兜住（U3 落地）：

1. `src-tauri/build.rs`：`cargo build` 时把 DLL 从 webview2-com-sys 的产出目录摆到 `src-tauri/resources/WebView2Loader.dll`；
2. `tauri.conf.json` 的 `bundle.resources` 声明它（目标路径就是安装目录根，与 `tatai.exe` 同级）。

`pnpm verify:u3` 有这条回归护栏（载荷里必须有它 + 壳二进制里必须有这个导入名）；MSI 侧不会重复打包同名文件
（bundler 扫 `*.dll` 时会跳过已在资源里的）。

## 随包后端的两个入口（U2）

`src-tauri/resources/server/` 里是**两个独立的 Node 程序**（都由 `scripts/build-server.ts` 用 vite 的 SSR 构建打成单文件 ESM）：

| 入口 | 谁拉起 | 用途 |
| --- | --- | --- |
| `index.js` | **壳自己**（`backend.rs`，release 分支） | 本地 HTTP 服务（8787）：注册表 / 门禁 / 终端 / 架构图 / 变更流 |
| `mcp.js` | **外部 agent 的 MCP 客户端**（stdio，DESIGN.md §6.1「agent → 工作台」） | MCP 工具集（U2 时为 8 个；**当前 22 个**，计数以 `src/mcp/tools/index.ts` 注册表为唯一来源），与 `index.js` 读写同一份注册表与 `.工作台/` |

### node 运行时口径（U2 明确选择，不是静默假设）

**随包产物依赖系统 PATH 里的 `node`（>= 20），不把 `node.exe` 打进安装包。** 理由：

1. **体积**：`node.exe` 单文件约 80MB，远超 U3 卡的 3–10MB 目标（10 倍级），打进去等于把目标作废；
2. **用户画像**：塔台的用途就是"看着本机跑 agent / Node 项目的人"，目标机器上必然有 node；
3. **失败可诊断**：壳的打包分支先探一次 `node --version`，探不到就打一条能照做的报错（"打包态后端需要系统 PATH 里的 node >= 20"）并照常开窗，不留下"窗口开了但没数据"的哑谜；
4. **留后路**：若 U3 判定必须随包，把 `node.exe` 放进 `resources/`、把 `backend.rs` 打包分支的 `program` 从 `"node"` 换成 `<resource_dir>/node.exe` 即可，**路径解析与 env 传递一行都不用改**。

**Windows verbatim 路径踩坑（U2 实证）**：Tauri 的 `resource_dir()` 返回带 `\\?\` 前缀的 verbatim 路径
（`\\?\D:\...\server\index.js`）。Windows API 认这个前缀，**Node 不认**——直接当参数传下去会报
`Error: EISDIR: illegal operation on a directory, lstat 'D:'`，后端起不来。
所以 `backend.rs` 的 `plain_path_arg()` 专门把前缀剥掉再喂给 node（`current_dir` 保留 verbatim，
CreateProcessW 认前缀、顺带还能吃超 260 字符的长路径）。

### 全局数据目录（DoD① 的红线：数据绝不落安装目录）

| 层 | 位置 | 打包态行为 |
| --- | --- | --- |
| 工作台全局 | `TATAI_HOME` > 缺省 `~/.tatai/`（`DESIGN.md` §8.1） | 注册表 `registry.json`、`agents.json`、全局配置、`logs/backend.log` **全部落这里**；首次运行**自动建目录与 `registry.json`**，不报错 |
| 项目私有 | `<项目根>/.工作台/`（注册表里的绝对路径） | 设计书 / 进度 / Gate / 聊天 / 变更流水 / 终端历史，照常落各项目 |
| 应用安装目录 | 安装目录（exe 同目录） | **只读**：运行期一个字节都不写（`pnpm verify:u2` 对安装目录逐文件哈希前后比对；打包壳另有一层顶层条目快照比对） |

不设 `TATAI_HOME` 时按缺省走 `~/.tatai`。想让双击图标启动也固定用某个目录，把 `TATAI_HOME` 加成用户环境变量即可——
这是本机配置，不属代码改动范围（改系统设置需人确认）。`pnpm verify:u2` 与打包壳的实测都由启动环境显式传入该变量。

### 打包态日志（U2）

壳的 release 产物是 Windows GUI 子系统（`windows_subsystem = "windows"`）——双击启动**没有控制台**，
`backend.rs` 转发到壳 stdout 的后端日志没地方去。所以打包分支额外置 `TATAI_LOG_TO_FILE=1`，
后端（`src/server/backendLog.ts`）把 stdout/stderr **再抄一份**到 `<全局数据目录>/logs/backend.log`
（追加 + 超 1MB 滚动成 `.1`；stdout 本身一字不改、**dev 不置位、行为与本卡之前逐字相同**）。

壳**自己**的诊断行同口径落 `<全局数据目录>/logs/shell.log`（`backend.rs` 的 `shell_log` / `shell_warn`，
dev 不落盘）；**致命**的一档（端口已被占用、壳 panic）再走 `shell_fatal`——release 下额外弹一个
MessageBox（`MessageBoxW`，直接声明这一条 FFI、**不引 windows 系 crate**）：
GUI 子系统里 `eprintln!` 写进的是个不存在的控制台，只落日志等于没说话（Q140/Q141，2026-09-19 二轮审计）。
壳的 panic hook 在 `main.rs` 的 `install_panic_hook()`，装在任何可能 panic 的代码之前。

### 让外部 agent 连打包态的 MCP（DoD③）

MCP 是 stdio server，**agent 主动拉起**（壳不管它）。装好之后入口就是安装目录下的 `server/mcp.js`，
即 `%LOCALAPPDATA%\Tatai\server\mcp.js`（NSIS 用户级安装的实际路径，U3 真装核对通过）：

```json
{
  "mcpServers": {
    "tatai": {
      "command": "node",
      "args": ["C:\\Users\\<你的用户名>\\AppData\\Local\\Tatai\\server\\mcp.js"],
      "env": { "TATAI_HOME": "<你的全局数据目录；两边都不设时都取缺省 ~/.tatai，可省略>" }
    }
  }
}
```

- 路径怎么定（**U3 真装实测过，不是推断**）：NSIS 是 `currentUser` 安装（`bundle.windows.nsis.installMode`），
  install 目录 = `%LOCALAPPDATA%\Tatai\`，装完实际落 `C:\Users\<用户名>\AppData\Local\Tatai\server\mcp.js`（实测在位，38,176 B）——
  所以上面那行绝对路径写法是对的，照抄把 `<你的用户名>` 换成自己的即可。
  **MSI 不一样**：Tauri 的 wix 模板缺省是 `InstallScope="perMachine"`（装 `Program Files\Tatai`，**需要管理员**；
  U2 那句"MSI 也按用户装"是错的，U3 实测生成态 `main.wxs` 后改正）。要用户级 MSI 得改 wix 模板，属计划外。
  **没安装、只是直接跑 `target/release/tatai.exe` 时**，入口在 `src-tauri/target/release/server/mcp.js`。
- `env.TATAI_HOME` 要与壳启动时的一致（否则 MCP 侧读的是另一份注册表——同一份数据是"单一事实源"的前提）；
  两边都不设时都取缺省 `~/.tatai`，这时可省略。
- `command` 是 `node`（口径同上，需要 PATH 里有 node >= 20）。
- 开发态等价物：`pnpm mcp`（= `tsx src/mcp/index.ts`），两条入口共用同一份数据层与工具实现。

## 两件职责与口径（谁拉起、谁回收）

1. **开窗口加载同一份前端**：dev 下 `devUrl=http://localhost:5173`（vite，HMR 即 DoD③）；
   打包下从 `frontendDist`（`dist/`）读，走 Tauri 资源协议。
2. **拉起/回收本地 Node 服务**（`src-tauri/src/backend.rs`）：

   | 场景 | 拉起命令 | 工作目录 |
   | --- | --- | --- |
   | dev（debug 构建） | `cmd /C pnpm dev:server`（= `tsx watch src/server/index.ts`，与浏览器里同一条配方） | 仓库根 |
   | 打包（release 构建） | `node <resource_dir>/server/index.js`（入口由 `pnpm build:server` 产出，见上） | 应用资源目录 |

   - **回收（V09-14 起＝Job Object + taskkill 兜底）**：给后端挂 Windows **Job Object** 并置
     `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（`src-tauri/src/proc_tree.rs`；`backend.rs` 在 spawn 之后立刻
     `assign`）。窗口全关/正常退出时在 `RunEvent::ExitRequested | Exit` 里先 `TerminateJobObject`
     （按句柄终止整棵子树），再 `taskkill /PID <pid> /T /F` 兜底（`tsx watch` 会再套一层进程，
     只杀直接子进程会留孙进程僵尸），随后 `wait()` 回收句柄。**壳被强杀**（`taskkill /F`、任务管理器
     "结束进程"，都不带 `/T`）时 `Drop` 与这条回收点都不跑（release 是 `panic = "abort"`，恐慌不展开）——
     这时由**内核**在壳的 Job 句柄关闭时按 `KILL_ON_JOB_CLOSE` 终止 Job 内全部进程：原来登记的
     "强杀留孤儿占住 8787"（`DESIGN.md` 附录 B「M-1」）在 V09-14 由此收口，真机两轮见
     `pnpm verify:v09-14` 与作者私有台账 `.工作台/evidence/V09-14/1/`（**不随本开源仓分发**）。
     **边界如实**：Job 只终止**本 Job 成员**（按句柄，不按进程名），所以别的 agent 客户端 / 无关 node
     进程不会被误杀；`assign` 之前子进程抢先 fork 出的后代不在 Job 里，由 `taskkill /T` 兜底；
     Job 建不出来（`CreateJobObjectW`/`SetInformationJobObject` 失败）时不静默——壳打告警并退回
     `taskkill` 兜底，强杀仍可能留孤儿。
   - **就绪判定**：真发一次 `GET /health`，拿到 200 才打印"后端就绪"；30s 超时只打印告警，不挡开窗（界面自会报连不上）。
   - **端口**：`TATAI_PORT`（缺省 8787），透传给子进程；壳内前端的基址口径见 `src/ui/tauri-env.ts`（同一缺省值）。
     覆盖是**双向**的：壳把本轮实际端口经初始化脚本注入窗口（`window.__TATAI_API_ORIGIN__`，写入方
     `backend.rs::api_origin_init_script`），打包态前端读它、CSP 的 `connect-src` 放行回环任意端口，
     dev 态 vite 代理也认 `TATAI_PORT`（`vite.config.ts`）——所以 `TATAI_PORT=9000` 起壳，前后端一起走 9000。
   - **端口已被占用**：预检发现 `127.0.0.1:<port>` 能连通就**跳过拉起**（防两代后端抢同一个端口），
     窗口照开（口径同"入口缺失 / node 探不到"，也正是 `DESIGN.md` 附录 B「M-1」登记的"报占用并明示"）。
     这一档走 `shell_fatal`：release 下弹窗 + 落 `shell.log`，写明"本次**没有**拉起新后端、界面会连到占用者"；
     占用者应答塔台 `/health` 时把 pid 一起报出来（多半是上一代残留后端），并给处置命令
     （`taskkill /PID <pid> /T /F` 或设 `TATAI_PORT` 换端口）。**不自动杀占用者**——壳分不清"上一代残留"
     和"另一个正在运行的塔台实例 / 用户在跑的 dev 后端"，贸然 taskkill 会打断正在用的那个。
   - **SSE 基址（U2 在打包壳里抓出来的真 bug）**：`apiFetch` 会给请求加壳内绝对基址，但
     `new EventSource("/api/...")` 是各处自己拼 URL 的——壳内相对路径会打到 WebView 自己身上
     （资产协议回 index.html，浏览器报 `MIME type ("text/html") is not "text/event-stream"` 直接中止），
     症状是**打包壳里终端一片空白 + 变更/实况收不到推送**，而 dev 走 vite 代理完全看不出来。
     现在全前端的 SSE URL 一律经 `src/ui/api.ts` 的 `apiSseUrl` / `projectEventsUrl` / `terminalStreamUrl` 拼，
     `pnpm verify:u2` 有源码级护栏（3 处 `new EventSource` 全是这几个函数）。

## 进程树收口（V09-14）：Job Object 是主收口，taskkill 是兜底

**输入/输出契约**（`DESIGN.md` §11.3、§12.1-19、附录 E.10 第 2 行、附录 G-6；PLAN V09-14）：
输入＝壳进程**正常退出**或**被强制结束**（含任务管理器「结束进程」这种不带 `/T` 的杀法）；
输出＝① 壳启动/接管的后端进程**及其子树**退出；② 端口（尤其 8787）释放、可重新绑定；
③ 已持久化数据可重读（强杀前写入的事实还在、事件账本 `last_seq` 不倒退）；④ 其他 Agent 客户端/无关
node 进程不受影响。独立 MCP 的写需求仍按 v0.7 自愈机制按需拉起写服务，本卡**不改**那条链。

**实现与取舍**（代码：`src/proc_tree.rs` + `src/backend.rs`）：

| 路径 | 谁收口 | 依据 |
| --- | --- | --- |
| 正常退出（关窗 / `RunEvent::ExitRequested|Exit`） | `backend::shutdown` → `ProcTree::shutdown`：先 `TerminateJobObject`（按句柄终止整棵子树），再 `taskkill /PID /T /F` 兜底，最后 `child.wait()` | 壳还活着，能跑代码 |
| 被强杀（`taskkill /F`、任务管理器，**不带 `/T`**） | **内核**：壳持有的 Job 句柄随进程消失被关闭 ⇒ `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 终止 Job 内全部进程 | 壳跑不了代码，`Drop`/事件循环都不执行 |
| Job 建不出来 / `assign` 失败 | 退回 `taskkill /PID /T /F`，且壳**打告警**（不静默） | 降级必须可见 |

- **不按进程名杀**：Job 只终止本 Job 成员（句柄归属），兜底也是 `taskkill /PID <子进程 pid> /T`——
  没有 `/IM node.exe` 这类按名字的杀法，所以不会误杀别的 agent 客户端或用户自己的 node 进程。
- **竞态如实**：`spawn` 之后立刻 `assign`；`assign` 之前子进程若已 fork 出后代，那些后代不在 Job 里，
  由 `taskkill /T` 兜底。真实拉起链（cmd→pnpm→tsx→node）到第二层要几百毫秒，窗口极小但不假装为零。
- **端口占用检查一条不动**（V09-14 禁止越界明写"不得为通过验收关闭端口占用检查"）：预检、
  `shell_fatal` 弹窗、不自动杀占用者的口径全部保持原样（见上一节）。
- **真机两轮**：`pnpm verify:v09-14`（壳替身 + 真壳 `src-tauri/target/debug/tatai.exe` 在场时）＋
  作者私有台账 `.工作台/evidence/V09-14/1/` 的日志（正常退出 / 强杀、端口前后读数、PID 对照、数据重读与 MCP 接续；**不随本开源仓分发**）。

### 壳替身（验证用 launcher，`src-tauri/shell-sim/`）

`pnpm verify:v09-14` 需要"能脚本化的壳"，所以有一个**独立小 crate** `src-tauri/shell-sim`：它按
`backend.rs` 的配方拉起真后端、挂 Job、然后按 `--exit`（正常退出）/**`--hold`**（等外部强杀）/
`--abrupt-exit`（来不及收口就消失）三种方式收尾；`--no-job` 是**反例开关**，用来复现"强杀留孤儿"那条路。
它 `#[path]` 编 `src/proc_tree.rs`——**与真壳同一份收口源码**，不是另写一套。不放进 tatai 的
`bin/`/`examples/`：多一个 bin 目标会让 `tauri build` 面对"到底打哪个二进制"，而 example 仍要把
tauri 那一大坨依赖编一遍；单独 crate 只依赖 `windows`，几秒可编。

### 新增直接依赖与许可登记（`DESIGN.md` §7.4）

| 项 | 值 |
| --- | --- |
| crate | `windows` **0.61.3**（`src-tauri/Cargo.toml` 的 `[target.'cfg(windows)'.dependencies]`） |
| 是不是新进依赖树 | **不是**：0.61.3 早已在 `Cargo.lock` 里（tauri / tao / wry / webview2-com / tauri-runtime\* 的传递依赖），本次只是提为**直接依赖**并只开这段需要的 feature |
| feature 最小集 | `Win32_Foundation`（HANDLE/CloseHandle）、`Win32_Security`（`CreateJobObjectW` 的 `SECURITY_ATTRIBUTES` 形参）、`Win32_System_JobObjects`（Job 四函数与 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）、`Win32_System_Threading`（`JOBOBJECT_EXTENDED_LIMIT_INFORMATION` 里的 `IO_COUNTERS`） |
| 许可（crate `Cargo.toml` 字段原文） | `license = "MIT OR Apache-2.0"` |
| LICENSE 原文 | `license-mit`（1,141 B，sha256 `c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383`）／`license-apache-2.0`（11,351 B，sha256 `c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b`），路径 `$CARGO_HOME/registry/src/index.crates.io-*/windows-0.61.3/` |
| 原文关键句（逐字） | `MIT License` ／ `Copyright (c) Microsoft Corporation.` ／ `Permission is hereby granted, free of charge, to any person obtaining a copy of this software` ；Apache 侧 `Apache License` ／ `Version 2.0, January 2004` ／ `http://www.apache.org/licenses/` |
| 准入依据 | 落在项目既有白名单 **MIT / Apache / BSD** 内（双许可，取任一即可），**不是** §12.1-13 那种"超白名单待用户接受"的例外；核对方式＝打开 crate 原文（不是凭 crates.io 摘要或记忆），原文 sha256 与上面登记值一致 |
| 机械回读 | `pnpm verify:v09-14` ⑤ 会重新打开这两个原文文件、逐句比对上面登记的句子、并核对 sha256 |
| 状态如实 | 本登记只完成 §7.4 要求的"打开 LICENSE 原文核对 + 登记准入依据"，**不代表**独立审计通过，也**不代表**用户验收 |

`docs/LICENSE-AUDIT.md` 末尾「V09-14 新增直接依赖补记」是同一份登记的第二处落点；
`win_dialog`（MessageBoxW）仍保持直接声明 FFI，**不**为本弹窗扩 `windows` crate 的 UI feature。

## 权限（最小集）

`capabilities/default.json` 给 `core:default` + **一条窄授权** `opener:allow-open-url`（范围只写 `http://*`
与 `https://*`），窗口只挂 `main`。

Q224（2026-09-19 二轮审计）：壳内点站外链接此前把整个 WebView2 窗口导航走（设计书里的 GitHub 链接实测
一次就把应用顶掉，壳内无返回入口），处置是**交系统浏览器打开**——前端 `src/ui/external-link.ts` 在
document 捕获段拦下站外 http(s) 点击（`preventDefault` + `openUrl`），架构图 React Flow 归属链接一并覆盖。
授权故意窄：不放行 `opener:default`（会连 `open-path` / `reveal-item-in-dir` / `mailto:` / `tel:` 一起给），
塔台只需要打开网页。Rust 侧就一行 `.plugin(tauri_plugin_opener::init())`；依赖许可 Apache-2.0 / MIT
（符合 `AGENTS.md` §6）。

**不授予 `shell:*`**：拉起后端是 Rust 侧 `std::process` 干的，前端一行进程代码都没有，也没有自定义命令；
壳内前端要连本地服务靠 HTTP + 服务端的 origin 白名单（`src/server/index.ts` 的 `applyShellCors`），
不需要 Tauri 的 shell 能力。将来若真要让前端调进程，必须同时改这一处与 `DESIGN.md` 相关章节，不擅自加。

## 图标

`icons/` 是 U1 的**占位图标**（蓝环雷达图，`pnpm tauri icon <1024png>` 生成），正式视觉待设计；
`tauri.conf.json` 的 `bundle.icon` 与目录内容一一对应。

## 桌面壳工具链（Windows：Rust + mingw）

Rust 与 mingw 建议装在**项目外**、按用户安装、不改系统 PATH。下表是**通用要求**，路径请换成你自己的（作者本机的真实路径按仓库规则不写进本文件）：

| 组件 | 路径（占位符，换成你的） | 装法 |
| --- | --- | --- |
| rustup / cargo | `<ASCII 工具链目录>\cargo`（`CARGO_HOME`） | `rustup-init.exe -y --no-modify-path --profile minimal --default-host x86_64-pc-windows-gnu` |
| 工具链本体 | `<ASCII 工具链目录>\rustup`（`RUSTUP_HOME`） | 同上，`stable-x86_64-pc-windows-gnu` |
| mingw-w64 | `<ASCII 工具链目录>\mingw64`（如 winlibs 免安装解压包） | 解压，无安装器 |
| 构建临时目录 | `<ASCII 工具链目录>\tmp`（`TMP`/`TEMP`） | 见下 |

**必须全 ASCII 路径**（2026-09-18 实证的踩坑）：winlibs 的 `ld`/`dlltool` **读不了非 ASCII 路径**——

- `ld.exe: cannot find C:/Users/<中文用户名>/.rustup/.../libcore-*.rlib: No such file or directory`（文件明明存在）；
- `dlltool: Cannot create temporary file in C:\Users\<中文用户名>\AppData\Local\Temp\: Unknown error`；
- 对照实验：同一份 `libcore-*.rlib`，从 ASCII 路径链接成功（产出 44788 字节 dll），从中文路径链接失败。

所以 `CARGO_HOME`/`RUSTUP_HOME`/`TMP`/`TEMP` 一律指到 ASCII 目录（如 `<ASCII 工具链目录>\*`），
**项目自身的路径也要是 ASCII**（安装到 `C:\Users\<中文名>\...` 下的 IDE/编辑器若报同样错，同因此）。

构建命令（三个变量缺一不可，路径换成你自己的 ASCII 目录）：

```bash
export PATH="/<ASCII 工具链目录>/cargo/bin:/<ASCII 工具链目录>/mingw64/bin:$PATH"
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=gcc
export TMP='<ASCII 工具链目录>\tmp' TEMP='<ASCII 工具链目录>\tmp'
cd <你的仓库目录>/src-tauri && cargo build   # 或回到仓库根跑 pnpm tauri:dev / pnpm tauri:build
```

> **出正式 exe 只能走 `pnpm tauri:build`（tauri CLI 会自动带上 `--features custom-protocol`）**。
> 直接 `cargo build --release` 产出的是 **dev 模式 exe**：tauri 的 `is_dev()` 定义为
> `!cfg!(feature = "custom-protocol")`，与 release profile 无关——缺这个 feature 时窗口去连
> devUrl（localhost:5173）而不是嵌入的 dist/，没跑 vite 就整页"localhost 拒绝连接"
> （2026-09-21 实锤排障：后端打包分支正常拉起、窗口却是 devUrl 的混合态）。

> `pnpm tauri:dev` / `pnpm tauri:build` 需先有上面三个环境变量（按用户安装、不改系统配置，所以每开一个新终端都要先设一次）。

## 安装包（U3）：装哪种、装到哪

**逐版本的体积与 sha256 一律看对应 [Release 页](https://github.com/sannongwangluo/tatai/releases)**——仓库不另存发布说明副本，避免"仓 ↔ 包"两处漂移（本文件曾按 0.1.0 的读数记过一张固定表，已删除）。这里只保留**不随版本变化**的口径：

| | NSIS `Tatai_<版本>_x64-setup.exe`（推荐） | MSI `Tatai_<版本>_x64_en-US.msi` |
| --- | --- | --- |
| 安装作用域 | `currentUser`（`$LOCALAPPDATA\Tatai`） | `perMachine`（`Program Files\Tatai`） |
| 要管理员吗 | **不要**（`RequestExecutionLevel user`，实测非提权会话静默装成功、不弹 UAC） | **要**（per-machine，Tauri wix 模板缺省） |
| 卸载 | `uninstall.exe /S`，程序文件与快捷方式清干净；HKCU 卸载项删除 | `msiexec /x` |
| 装完占盘（程序文件） | 约 13 MB＝`tatai.exe` + `WebView2Loader.dll` + `server/`（约 53 个文件）；NSIS 另有安装器在装机时生成的 `uninstall.exe`（不在载荷里） | 同上三件、无 `uninstall.exe`（MSI 载荷解包实测逐项相等，卸载走 `msiexec`） |

**体积目标 3–10MB 对着安装包本体看**（历史两版都在区间内）；组成拆分的实测值见 `PROGRESS.md` 的 U3 与 V09-04 流水。

**构建物的两条已知性质**（省得你以为下错了包）：

- **同一棵树连打两次哈希不同**，体积逐项相同——唯一变的是 `resources/server/THIRD-PARTY-NOTICES.txt`，它由 `build-server.ts` 生成、带一行「生成时间」，内嵌进 exe 与两个包。这是**构建物自身的非确定性，不是源码漂移**。
- 「装完占盘」按**载荷口径**核对（不真装也能核）；真装 / 冷启动 / 卸载记录属 U3 ⑦ 的人工那一半，`verify:u3` 在这类机器上如实报 SKIP，不假装跑过。

**WebView2 运行时两个包都不随包**（安装包内没有运行时/引导器文件）：安装时先查注册表，缺了才联网拉微软官方引导器（`downloadBootstrapper`，短链 `https://go.microsoft.com/fwlink/p/?LinkId=2124703`，NSIS 与 MSI 同口径）——所以**目标机需要联网一次**才能在没有运行时的机器上装；没有网会停在安装阶段并提示下载失败（NSIS `Abort "$(webview2AbortError)"`）。

**壳需要的 node 也一样**：不在包里，要目标机 PATH 里有 node >= 20（口径见上文）。

**装 / 卸会留什么**（U3 实测）：程序文件、快捷方式、HKCU 卸载项都清干净；留下的三样**都不是我们的程序文件**——
① `HKCU\Software\sannongwangluo\Tatai`（Tauri 记"上次装哪了"的键，重装时沿用；勾"删除应用数据"或手动删才清）；
② `%LOCALAPPDATA%\com.sannongwangluo.tatai`（WebView2 自己的缓存目录，可达数百 MB——嫌大就勾"删除应用数据"，或在 WebView2 设置里清）；
③ **全局数据目录（`TATAI_HOME` 或 `~/.tatai`）必须保留**——那是用户数据，卸载删了才是 bug。

## 本卡（U2 / U3）验证怎么复现

```bash
# ① 可自动化的那半边（动态端口 + 探活 + 临时 TATAI_HOME，不碰真实注册表与真实项目）
#    注意顺序：tauri:build → **package:bind**（在构建尾部把「产物 ↔ 源码」绑定落证据目录）
#    → verify:u3（它会核产物-源码绑定，缺记录就红）／verify:v09-04／verify:u2
pnpm build:server && pnpm tauri:build && pnpm package:bind && pnpm verify:u3 && pnpm verify:v09-04 && pnpm verify:u2

# ② 真桌面壳那半边（GUI 截图 / 真装真卸的一次性脚本，2026-09-19 证据归档进 PROGRESS 后已清理，不再随目录分发；
#    当时怎么跑的逐条见 PROGRESS.md 的 U2 流水：CDP 接打包壳 WebView2 真敲终端、release exe + 真 MCP 客户端）
#    V09-04 的打包态冒烟（进程存活 ≥15s + /health 200 + 主界面关键 DOM）用同一套 CDP 接法，
#    驱动脚本与日志属作者私有台账（见下方说明），不随本开源仓分发
# ③ 真装 / 冷启动 / 真卸同理，记录见 U3 流水（install-record 证据摘录也在流水里）
#   ⚠️ 若重做真装验证：Git Bash 里跑 NSIS 安装器时 `/S` 会被当路径转换（MSYS 老毛病）——
#      用 `MSYS_NO_PATHCONV=1` 或 cmd.exe；脚本内部用 spawn 传参不受影响。
```

**私有证据不是随仓复现材料**：本文件与 `PROGRESS.md` 里出现的 `.工作台/evidence/…`、`.工作台/verify/…`、`smoke-*.py/log`、`binding.json` 等路径，都指**作者本机的私有台账目录**（`.工作台/` 默认 gitignore，**不随本开源仓分发**）；它们是历史核对记录，**不是**你 clone 之后能直接打开或复跑的文件。想自己复现，按上面 ① 的命令在你自己的环境产出、对照你自己的 `.工作台/evidence/`。逐条证据与对照写在 `PROGRESS.md` 的 U2 流水里。
