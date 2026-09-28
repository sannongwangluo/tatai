# 塔台（Tatai）发布前 LICENSE 审计

> 卡号：`PLAN.md` 发布 1 / L1（`DESIGN.md` §10.3 全文逐条核对）
> 执行：Kimi Code 施工 agent，L1 ｜ 时间：2026-09-18
> 证据口径：**每一条都附「读到的原文关键句」+ 原文文件路径**；没有原文摘录的条目一律按未核对处理（`PLAN.md` L1 跑偏点）。
> 本文件的路径引用一律用 `$CARGO_HOME`、`node_modules/…` 等中性写法；作者本机的真实工具链路径只进 `PROGRESS.md`，不进仓库（`src-tauri/README.md` 同口径）。

---

## 0. 结论速览

| 问题 | 结论 |
| --- | --- |
| 是否只用 MIT / Apache / BSD？ | **白名单内主体成立**：npm 安装面 409 个包中 355 个是 MIT/Apache/BSD（另 49 个 ISC，同族允许）；Rust 430 个 crate 中 401 个是 MIT/Apache/BSD（另 1 个 ISC，同族允许）。**另有 5 个 npm 包 + 28 个 crate 超出白名单**（Rust 侧若把 ISC 也算上为 29；清单见 §3.2 / §4.3），逐条已开原文，**均非传染性许可**。 |
| 是否引入 AGPL / GPL？ | **没有**。`swark`(AGPL) / `Sourcetrail`(GPL) / `pyan3`(GPL) 全仓仅出现在文档的红线声明里，npm 安装面与 Cargo.lock 均无同名条目（§2.6、§7.1 证据）。 |
| 是否发现 LGPL？ | **1 处、且是"三选一"里的可选项**：`r-efi` 声明 `MIT OR Apache-2.0 OR LGPL-2.1-or-later`（OR 关系，可采用 MIT 或 Apache-2.0，**不强制 LGPL**），且**未编译进 Windows 壳**（§4.4）。已登记待议。 |
| 触发 DoD④「立即登记并停止发布」了吗？ | **未触发**（无 AGPL/GPL/SSPL 类传染性许可）。但 §3.2 的 5 个超白名单条目 + §5.4 的「随包缺 NOTICE」已按 `AGENTS.md` §4 登记 `DESIGN.md` 附录 B。 |
| 发布能否放行？ | **L1 审计本身完成、无红线阻断**；但**放行口径仍需人 / Max 拍板两件事**：① §3.2 的 MPL-2.0 / CC-BY-4.0 / Python-2.0 / Unlicense 是否接受（严格按 `DESIGN.md` §7.4「只接受 MIT/Apache/BSD」字面，它们都在白名单外）；② §5.4 要求的第三方声明文件（THIRD-PARTY-NOTICES）目前安装包里一个都没有，MIT / Apache-2.0 的「保留版权声明」义务需要一处落点。 |

---

## 1. 审计方法（怎么造清单、怎么防"凭记忆勾选"）

审计脚本全部临时写在 `.工作台/l1-audit/`（gitignore，不进仓库），零新 npm 依赖。

1. **npm 侧清单来自实际安装面，不来自 `package.json`**：直接扫 `node_modules/.pnpm/**/node_modules/<pkg>/package.json`，得到 **409 个 `name@version`**（`inventory.json`）。
2. **与锁文件对账**：解析 `pnpm-lock.yaml` 的 `packages:` 段（490 条 / 476 个唯一包名）。差集 = **81 个包"在锁里但本机没装"**，逐个查证**全部是别的平台的可选二进制**（`@esbuild/{darwin,linux,android,…}`、`@rollup/rollup-{darwin,linux,…}`、`@tauri-apps/cli-{linux,darwin,…}`、`@tailwindcss/oxide-*`、`lightningcss-*`、`fsevents`）；反向差集 = **0**（装了但不在锁里的包一个都没有）。
3. **不认 `package.json` 的 `license` 字段**：写脚本对每个包**打开包内 LICENSE/COPYING/NOTICE/README 原文**，从文本里识别许可族，再与字段比对（`verify.mjs`）。结果：**382 条一致、28 条记录需人工处置**（两个集合去重后正好 409——`argparse@2.0.1` 因原文含 GPL 字样被两侧各记一次；逐条见 §3.3）。
4. **传染性许可另做全文关键词扫描**：对 409 个包的 **384 个许可原文文件**逐字节扫 `GNU AFFERO GENERAL PUBLIC LICENSE` / `GNU GENERAL PUBLIC LICENSE` / `GNU LESSER GENERAL PUBLIC LICENSE` / `Server Side Public License` / `Business Source License` / `Common Public Attribution` / `EUPL` / `OSL`。命中 3 条，逐条查上下文**全是误报**（§3.2）。
5. **Rust 侧清单来自 `src-tauri/Cargo.lock` 全量 430 条**（不是只看 `Cargo.toml` 的 2 条直接依赖）：从构建机 `$CARGO_HOME/registry/src/index.crates.io-*/` 读已解包的 crate 原文；本机构建缓存里没有的 174 个（都是非 Windows 目标）逐个下载 `.crate` 归档解包补原文。**429/430 拿到 crate 原文**（唯一没有的是本仓库自身 `tatai@0.1.0`）。
6. **"到底哪些 crate 真进了壳"另做一次反推**：扫 `src-tauri/target/release/deps/*.d`（337 个依赖文件）里出现的 registry 源目录，得到**实际参与 Windows release 构建的 233 个 crate**（`built-crates.txt`）。这一列用于区分「锁里有」与「真进分发物」。
7. **交叉校验**：`cargo` 本地 sparse index 与 `index.crates.io` 的索引 JSON **都不带 `license` 字段**（本机实测：`hyper@1.11.1` 的索引条目 keys = `name,vers,deps,cksum,features,features2,yanked,rust_version,pubtime,v`），所以元数据兜底改用 `crates.io API v1 /crates/{name}/{version}` 的 `version.license`；**原文与 API 的比对结果：430 条里 0 条不一致**。

**复现入口**（全部在 `.工作台/l1-audit/`，gitignore，不进仓库；只需 Node ≥ 20，零新依赖）：

| 脚本 | 干什么 |
| --- | --- |
| `inventory.mjs` | 扫 `node_modules` 造 409 条清单 → `inventory.json` |
| `verify.mjs` | 逐包打开原文识别许可族 + 与字段比对 + 传染性关键词全文扫描 → `verify.json` |
| `stats.mjs` | 分布统计 + 超白名单项抽取 |
| `snippets.mjs <direct\|all\|包名>` | 抽某包的许可原文关键句 |
| `cargo-licenses.mjs` → `fetch-crates2.mjs` → `crates-api.mjs` → `cargo-final.mjs` | Rust 侧：扫本地 registry → 补下载缺的 174 个 `.crate` → 解包读原文 → API 兜底与交叉校验 → `cargo-final.json` |
| `built-crates.mjs` | 扫 `target/release/deps/*.d` 反推真进壳的 233 个 crate → `built-crates.txt` |
| `cargo-report.mjs` / `tables.mjs` / `fill-appendices.mjs` / `fix-appendix-g.mjs` | 生成本文件各附录表格 |
| `similarity.mjs` | T3 Code 同名文件 5-gram 相似度（§6.3） |
| `upstream/` | 抓到的上游原文副本（micromark、css v2.2.4） |
| `crates/` | 从 `static.crates.io` 下载的 `.crate` 归档与解包目录（原文证据，约 30 MB） |

---

## 2. `DESIGN.md` §10.3 清单逐条核对（DoD①②③）

### 2.1 前端 / 样式 / 组件

| 依赖 | 版本 | 实际 License | LICENSE 原文路径 | 原文关键句（逐字） |
| --- | --- | --- | --- | --- |
| React | 18.3.1 | MIT | `node_modules/react/LICENSE` | `MIT License` ／ `Copyright (c) Facebook, Inc. and its affiliates.` ／ `Permission is hereby granted, free of charge, …` |
| TypeScript | 5.9.2 | Apache-2.0 | `node_modules/typescript/LICENSE.txt` | `Apache License` ／ `Version 2.0, January 2004` ／ `http://www.apache.org/licenses/` |
| Vite | 7.3.6 | MIT | `node_modules/vite/LICENSE.md` | `Vite is released under the MIT license:` ／ `MIT License` ／ `Copyright (c) 2019-present, VoidZero Inc. and Vite contributors`（同一文件后段还逐条列出 Vite 打包进来的第三方许可，见 §2.2 注） |
| Tailwind CSS | 4.3.3 | MIT | `node_modules/tailwindcss/LICENSE` | `MIT License` ／ `Copyright (c) Tailwind Labs, Inc.` |
| shadcn/ui | — | **未作为依赖引入** | — | §10.3 备注写的是「复制进仓库，非 npm 依赖」。**本仓库源码里没有 shadcn 组件**（`grep -r "shadcn" src/` 零命中），故无受约束代码可核（证据见 §2.5） |

### 2.2 架构图 / 导图 / 终端 / 拖拽

| 依赖 | 版本 | 实际 License | LICENSE 原文路径 | 原文关键句（逐字） |
| --- | --- | --- | --- | --- |
| @xyflow/react（React Flow） | 12.11.6 | MIT | `node_modules/@xyflow/react/LICENSE` | `MIT License` ／ `Copyright (c) 2019-2025 webkid GmbH` |
| dagre | 0.8.5 | MIT | `node_modules/dagre/LICENSE` | `Copyright (c) 2012-2014 Chris Pettitt` ／ `Permission is hereby granted, free of charge, …` |
| markmap | markmap-lib 0.18.12 / markmap-view 0.18.12 | MIT | `node_modules/markmap-lib/LICENSE`、`node_modules/markmap-view/LICENSE` | `MIT License` ／ `Copyright (c) 2020 Gerald` |
| xterm.js | @xterm/xterm 6.0.0 / @xterm/addon-fit 0.11.0 | MIT | `node_modules/@xterm/xterm/LICENSE`、`node_modules/@xterm/addon-fit/LICENSE` | `Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)` ／ `Permission is hereby granted, …` |
| dnd-kit | — | **未引入** | — | `grep -rn "dnd-kit" src/ scripts/ package.json` 零命中（证据见 §2.5） |

> 注：`vite/LICENSE.md`（1875 行）除 MIT 外，还逐条列出它自身内嵌/引用的第三方许可片段（文件内命中 `BSD-2-Clause, CC0-1.0, ISC, MIT` 等字样）——那些是 Vite 构建产物里各依赖的声明，不是 Vite 本体的许可；Vite 本体仍是 MIT。

### 2.3 Markdown 渲染

| 依赖 | 版本 | 实际 License | LICENSE 原文路径 | 原文关键句（逐字） |
| --- | --- | --- | --- | --- |
| react-markdown | 10.1.0 | MIT | `node_modules/react-markdown/license`（全小写文件名） | `The MIT License (MIT)` ／ `Copyright (c) Espen Hovlandsdal` |
| streamdown | 2.6.0 | Apache-2.0 | `node_modules/streamdown/LICENSE` | `Copyright 2023 Vercel, Inc.` ／ `Licensed under the Apache License, Version 2.0 (the "License");` |
| remark-gfm | 4.0.1 | MIT | `node_modules/remark-gfm/license` | `(The MIT License)` ／ `Copyright (c) Titus Wormer <tituswormer@gmail.com>` |

### 2.4 后端运行时与本地服务

| 依赖 | 版本 | 实际 License | LICENSE 原文路径 | 原文关键句（逐字） |
| --- | --- | --- | --- | --- |
| Node.js | 运行时 24.18.0 | MIT | **不随包分发**（无随包原文） | `src-tauri/README.md`「node 运行时口径（U2 明确选择，不是静默假设）」：**「随包产物依赖系统 PATH 里的 `node`（>= 20），不把 `node.exe` 打进安装包。」** 未分发 → 无再分发义务；运行时本体为 nodejs/node 的 MIT（本审计未从本机 Node 安装目录取原文，未取即不勾） |
| web-tree-sitter | — | **未引入** | — | §10.3 该条与实现不符：实际用的是 **node binding**（`tree-sitter` npm 包），源码注释写明原因，见 §2.5 |
| tree-sitter（实际选型） | 0.25.1 / tree-sitter-python 0.25.0 / tree-sitter-typescript 0.23.2 | MIT | `node_modules/tree-sitter/LICENSE`、`node_modules/tree-sitter-python/LICENSE`、`node_modules/tree-sitter-typescript/LICENSE` | `The MIT License (MIT)` ／ `Copyright (c) 2014 maxbrunsfeld`（python 包：`Copyright (c) 2016 Max Brunsfeld`；typescript 包：`Copyright (c) 2017 Max Brunsfeld`） |
| chokidar | 5.0.0 | MIT | `node_modules/chokidar/LICENSE` | `The MIT License (MIT)` ／ `Copyright (c) 2012 Paul Miller (https://paulmillr.com), Elan Shanker` |
| better-sqlite3 | — | **未引入** | — | `grep -rn "better-sqlite3" src/ scripts/ package.json` 零命中；仓库自己的护栏脚本 `scripts/verify-e3.ts:617` 断言「没有为历史引入任何存储类依赖（扫 hist/sqlite/lowdb/level/nedb/store）」且实测命中为空 |
| SQLite | — | **未引入** | — | 同上（`DESIGN.md` §7.2 列的 SQLite 缓存这一环在实现中未落地，见 §7.2 登记） |
| @modelcontextprotocol/sdk | 1.30.0 | MIT | `node_modules/@modelcontextprotocol/sdk/LICENSE` | `MIT License` ／ `Copyright (c) 2024 Anthropic, PBC` |

### 2.5 §10.3 之外、但清单/实际安装面里确实有的依赖（补核）

| 依赖 | 版本 | 实际 License | LICENSE 原文路径 | 原文关键句（逐字） |
| --- | --- | --- | --- | --- |
| node-pty（终端后端，§10.3 未列，`DESIGN.md` 附录 B 第 4 条已登记） | 1.1.0 | MIT（**三段**，含微软 ConPTY 的再分发许可） | `node_modules/node-pty/LICENSE` | 段一 `Copyright (c) 2012-2015, Christopher Jeffrey`；段二 `The MIT License (MIT)` ／ `Copyright (c) 2016, Daniel Imms`；段三 **`MIT License` ／ `Copyright (c) 2018 - present Microsoft Corporation`**（随包的 `conpty.dll` / `OpenConsole.exe` 即此段覆盖，见 §5.2） |
| @tauri-apps/cli | 2.11.4 | **Apache-2.0 OR MIT**（双许可，二选一） | `node_modules/@tauri-apps/cli/LICENSE_APACHE-2.0`、`…/LICENSE_MIT` | `Apache License` ／ `Version 2.0, January 2004`；`MIT License` ／ `Copyright (c) 2017 - Present Tauri Apps Contributors` |
| @vitejs/plugin-react | 5.2.0 | MIT | `node_modules/@vitejs/plugin-react/LICENSE` | `MIT License` ／ `Copyright (c) 2019-present, Yuxi (Evan) You and Vite contributors` |
| @tailwindcss/vite | 4.3.3 | MIT | `node_modules/@tailwindcss/vite/LICENSE` | `MIT License` ／ `Copyright (c) Tailwind Labs, Inc.` |
| tsx | 4.23.13 | MIT | `node_modules/tsx/LICENSE` | `MIT License` ／ `Copyright (c) Hiroki Osame <hiroki.osame@gmail.com>` |
| @types/node / @types/react / @types/react-dom / @types/dagre | 24.13.5 / 18.3.31 / 18.3.1 / 0.7.54 | MIT | 各包 `LICENSE` | 四份均为 `MIT License` ／ `Copyright (c) Microsoft Corporation.` |
| react-dom | 18.3.1 | MIT | `node_modules/react-dom/LICENSE` | `MIT License` ／ `Copyright (c) Facebook, Inc. and its affiliates.` |

### 2.6 §10.3 里"写着但没引入"的四项——未引入证据

DoD① 要求"清单里所有勾选项无遗漏"，对未引入项给"为什么不用核"的实证：

| §10.3 条目 | 实际状态 | 证据（真跑的 grep） |
| --- | --- | --- |
| shadcn/ui | 未引入（既非 npm 依赖，也没有复制进仓库的组件） | `grep -rIl "shadcn" src/ scripts/ templates/` → **零命中**（全仓只有 `DESIGN.md`/`AGENTS.md`/`PLAN.md`/`PROGRESS.md` 四份文档提到它） |
| dnd-kit | 未引入 | `grep -rn "dnd-kit\|dndkit" src/ src-tauri/ scripts/ package.json` → **零命中** |
| better-sqlite3 | 未引入 | `grep -rn "better-sqlite3" src/ scripts/ package.json src-tauri/src` → **零命中** |
| web-tree-sitter | 未引入（改用 node binding） | 全仓唯一命中是源码注释 `src/arch/parse.ts:13`：**「node binding（tree-sitter npm 包 + 语言包，win32-x64 prebuild 免构建；web-tree-sitter 0.27 与 tree-sitter-wasms 的 grammar WASM ABI 不匹配，小样即败）」** |

> 这四项属于「§10.3 清单与实际依赖面的差异」，不是许可证问题，但会影响"清单逐条"的可执行性 → 已登记 `DESIGN.md` 附录 B（§7.2）。

---

## 3. 传递依赖一览（npm）

### 3.1 分布统计（409 个实际安装的 `name@version`）

| License 族 | 个数 | 归属 |
| --- | --- | --- |
| MIT | 331 | 白名单 |
| ISC | 49 | 与 BSD 同族，允许但单独标注（清单见附录 C） |
| BSD-2-Clause + BSD-3-Clause | 17 | 白名单 |
| Apache-2.0（含 `Apache-2.0 OR MIT`） | 7 | 白名单 |
| MPL-2.0 | 2 | **超白名单**（`lightningcss`、`lightningcss-win32-x64-msvc`） |
| Python-2.0（PSF） | 1 | **超白名单**（`argparse`） |
| CC-BY-4.0 | 1 | **超白名单**（`caniuse-lite`，纯数据） |
| Unlicense（公共领域） | 1 | **超白名单但比 MIT 更宽松**（`robust-predicates`） |

按"是否进生产运行时"再切一刀（`pnpm list --prod --depth Infinity` 的解析结果，316 个生产树包名）：

| 归属 | MIT | ISC | BSD | Apache | MPL | CC-BY | Python-2.0 | Unlicense |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 生产树 | 266 | 43 | 16 | 2 | 0 | 0 | 1 | 1 |
| 开发/构建链 | 65 | 6 | 1 | 5 | 2 | 1 | 0 | 0 |

**超白名单的 4 个包（5 条记录）没有一个是生产运行时依赖**：`lightningcss*` / `caniuse-lite` 只在 Tailwind v4 与 browserslist 的构建链上；`argparse` 在生产树（来自 `@modelcontextprotocol/sdk` 的 CLI 相关路径）但与 Unlicense 的 `robust-predicates`（来自 markmap 的 d3-delaunay）都是宽松许可。

### 3.2 非 MIT / Apache / BSD / ISC 的每一个（逐个开原文）

| # | 包@版本 | 字段 | 原文路径 | 原文关键句（逐字） | 判定 |
| --- | --- | --- | --- | --- | --- |
| 1 | `argparse@2.0.1` | Python-2.0 | `node_modules/argparse/LICENSE`（12 775 B / 207 行） | 文件头 `A. HISTORY OF THE SOFTWARE`；正文是 Python 的全套许可栈（`PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2` ＋ BeOpen Python License ＋ CWI ＋ CNRI）；**GPL 字样只出现在历史叙述里**：`(1) GPL-compatible doesn't mean that we're distributing Python under the GPL.` | 宽松（OSI 认可的 PSF 许可）。**非传染**；但超出白名单 → 登记 |
| 2 | `caniuse-lite@1.0.30001810` | CC-BY-4.0 | `node_modules/caniuse-lite/LICENSE`（18 651 B / 305 行） | 首行 `Attribution 4.0 International`；正文 `Creative Commons Corporation ("Creative Commons") is not a law firm…` | 知识共享署名 4.0，**纯浏览器兼容性数据**，仅构建链。署名义务需在分发物里体现 → 登记 |
| 3 | `lightningcss@1.32.0` | MPL-2.0 | `node_modules/lightningcss/LICENSE`（15 648 B / 293 行） | 首行 `Mozilla Public License Version 2.0` | 文件级弱 copyleft，**非传染**（MPL 2.0 §3.3 允许与其它代码组合成 Larger Work）。未修改使用 → 登记 |
| 4 | `lightningcss-win32-x64-msvc@1.32.0` | MPL-2.0 | `node_modules/lightningcss-win32-x64-msvc/LICENSE`（与上同一份 15 648 B） | 同 3 | 同上（同一上游的预编译二进制）。另：锁文件里其余 `lightningcss-{darwin,linux,android}*` 平台包未在本机安装，按同一上游同版本推断同为 MPL-2.0 → 一并登记 |
| 5 | `robust-predicates@3.0.3` | Unlicense | `node_modules/robust-predicates/LICENSE`（1 210 B / 20 行） | `This is free and unencumbered software released into the public domain.` ／ `Anyone is free to copy, modify, publish, use, compile, sell, or distribute this software…` ／ `In jurisdictions that recognize copyright laws, the author or authors…` | 公共领域，**比 MIT 更宽松**，无附加义务 |

**传染性关键词全文扫描的 3 条命中，逐条查证均为误报（不是 GPL 许可）：**

| 命中的文件 | 命中字样 | 上下文（逐字） | 判定 |
| --- | --- | --- | --- |
| `argparse/LICENSE` | `GNU GENERAL PUBLIC LICENSE` | `(1) GPL-compatible doesn't mean that we're distributing Python under the GPL.  All Python licenses, unlike the GPL, let you distribute a modified version without making your changes open source.` | 许可说明里的对比叙述，不是本包采用的许可 |
| `lightningcss/LICENSE` | `GNU General Public License` | MPL 2.0 §1.12 术语定义：`"Secondary License" means either the GNU General Public License, Version 2.0, the GNU Lesser General Public License, Version 2.1, the GNU Affero General Public License, Version 3.0, or any later versions of those licenses.` | MPL 2.0 正文自带的术语定义（列举"次级许可"有哪些），本地不是 GPL |
| `lightningcss-win32-x64-msvc/LICENSE` | 同上 | 同上（同版本同文件） | 同上 |

### 3.3 字段与原文不一致、或包内没有许可原文的 28 条

382/409 条的"字段 vs 原文"一致；余下 **28 条记录（去重后 27 个包**——`argparse` 因原文含 GPL 字样被两侧各记一次，见 (f)）逐条处置如下（这一节就是"不许凭字段勾选"的落点）：

**(a) 20 个 micromark 家族包：包内没有 LICENSE 文件，README 里是许可声明**

`micromark@4.0.0`、`micromark-core-commonmark@2.0.0`、`micromark-factory-{destination,label,space,title,whitespace}@2.0.0`、`micromark-util-{character,chunked,classify-character,combine-extensions,decode-numeric-character-reference,encode,html-tag-name,normalize-identifier,resolve-all,sanitize-uri,subtokenize,symbol,types}@2.0.0`（共 20 个）。

- 包内原文：`README.md` 的 `## License` 段 = **`[MIT][license] © [Titus Wormer][author]`**，同文件给出 `[license]: https://github.com/micromark/micromark/blob/main/license`。
- 上游原文（本轮实际抓取并比对）：`https://raw.githubusercontent.com/micromark/micromark/main/license` → `(The MIT License)` ／ `Copyright (c) Titus Wormer <tituswormer@gmail.com>` ／ `Permission is hereby granted, free of charge, to any person obtaining…`；抓取副本与 sha256 记录在 `.工作台/l1-audit/upstream/micromark-license.txt`（不入 git）。
- 判定：**MIT**。留痕为"包内声明 + 上游原文"两级证据，不按字段直接勾。

**(b) `boolbase@1.0.0`：包内既无 LICENSE 也无许可声明**

- 原文：`README.md` 全文 9 行，只有功能说明，**没有任何许可字样**；包目录亦无 LICENSE/COPYING。
- 字段：`ISC`。上游 GitHub（`fb55/boolbase`）本轮抓取失败（网络 `curl: (56)`），**未取到原文**。
- 判定：**按未核对登记**——该包是 cheerio/css-select 链上的选择器小工具（经 markmap-html-parser → cheerio），**在生产树内**，需人工确认或用上游仓库原文补齐。

**(c) `inline-style-parser@0.1.1`：README 指向原项目**

- 原文：`README.md` → `## License` ／ `MIT. See [license](https://github.com/reworkcss/css/blob/v2.2.4/LICENSE) from original project.`
- 上游原文（本轮实际抓取）：`https://raw.githubusercontent.com/reworkcss/css/v2.2.4/LICENSE` → `(The MIT License)` ／ `Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca>`；副本在 `.工作台/l1-audit/upstream/css-v2.2.4-LICENSE.txt`。
- 判定：**MIT**。

**(d) `@gera2ld/jsx-dom@2.2.2`：字段与原文不一致**

- 字段：`ISC`；原文 `node_modules/@gera2ld/jsx-dom/LICENSE` → **`MIT License` ／ `Copyright (c) 2020 Gerald` ／ `Permission is hereby granted, free of charge, …`**。
- 判定：取**原文 MIT**（比字段标注更宽松，无额外义务）。已登记为"字段—原文不一致"，供上游反馈。

**(e) 4 个"平台二进制占位包"：包内只有 `.node`/`.exe`，许可在原包**

| 包 | 字段 | 包内文件 | 许可原文落点（本轮实读） |
| --- | --- | --- | --- |
| `@esbuild/win32-x64@0.28.2` | MIT | `esbuild.exe` + 6 行 README | 原包 `node_modules/esbuild/LICENSE.md`：`MIT License` ／ `Copyright (c) 2020 Evan Wallace` |
| `@rollup/rollup-win32-x64-gnu@4.63.3` | MIT | 二进制 + README | 原包 `node_modules/rollup/LICENSE.md`：`Rollup is released under the MIT license:` ／ `The MIT License (MIT)` ／ `Copyright (c) 2017 [these people](…contributors)` |
| `@rollup/rollup-win32-x64-msvc@4.63.3` | MIT | 二进制 + README | 同上 |
| `@tauri-apps/cli-win32-x64-msvc@2.11.4` | `Apache-2.0 OR MIT` | `cli.win32-x64-msvc.node` | 原包 `node_modules/@tauri-apps/cli/{LICENSE_APACHE-2.0,LICENSE_MIT}`（见 §2.5） |

**(f) `argparse@2.0.1`：字段与原文其实一致，被自动校验标出来的原因是"误报"**

- 字段 `Python-2.0`，原文 `node_modules/argparse/LICENSE` 也是 Python 的全套许可栈；之所以进"不一致"清单，是因为原文里出现了 `GNU GENERAL PUBLIC LICENSE` 字样（PSF 的历史叙述，见 §3.2）。人工查证后判定**不是 GPL**，按 Python-2.0 处置。
- 这一条正是本卡跑偏点要防的情形：**只 grep 关键词会把 PSF 叙述误判成 GPL**。

> 汇总：28 条里 **27 条已拿到可引用原文**（20 条 micromark 家族、1 条 inline-style-parser、4 条平台二进制、1 条 @gera2ld/jsx-dom、1 条 argparse 误报查证）；**1 条（boolbase）确无原文可核**，已在 §7 登记为待人工确认项。

### 3.4 ISC / BSD 清单

- **ISC 49 个**：`@gera2ld/jsx-dom`（原文实为 MIT，见 §3.3d）、`@ungap/structured-clone`、`boolbase`、`d3` 及 `d3-*` 共 32 个子包、`delaunator`、`electron-to-chromium`、`graceful-fs`、`inherits`、`isexe`、`lru-cache`、`once`、`picocolors`、`semver`、`setprototypeof`、`which`、`wrappy`、`yallist`、`yaml`、`zod-to-json-schema`（完整清单见附录 C）。
  - 原文样例（`wrappy`）：`The ISC License` ／ `Copyright (c) Isaac Z. Schlueter and Contributors` ／ `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.`
- **BSD 17 个**：`d3-ease`、`fast-uri`、`highlight.js`、`qs`、`rw`、`source-map-js`（BSD-3-Clause）；`cheerio-select`、`css-select`、`css-what`、`domelementtype`、`domhandler`、`domutils`、`entities`（3 个版本）、`json-schema-typed`、`nth-check`（BSD-2-Clause）。完整清单见附录 D。
  - 原文样例（`highlight.js`，BSD-3-Clause）：`Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:`

---

## 4. Rust crate 许可（`src-tauri/Cargo.lock` 全量 430 条）

### 4.1 方法与证据分级

| 证据级 | 条数 | 说明 |
| --- | --- | --- |
| **crate 原文（解包目录）** | **429** | 255 个来自构建机 `$CARGO_HOME/registry/src/index.crates.io-*/<crate>-<ver>/`（Windows 构建真正用到的那些）；174 个是本机没有的（非 Windows 目标）→ 本轮逐个从 `static.crates.io` 下载 `.crate` 归档并解包，读其中的 `Cargo.toml [package].license` 与 `LICENSE*` 文件 |
| crates.io API 元数据 | 1 | `tatai@0.1.0`（本仓库自身工作区成员，`src-tauri/Cargo.toml` 声明 `license = "MIT"`） |
| **交叉校验** | — | 每条的「crate 内 `Cargo.toml` 声明」与「crates.io API `version.license`」逐条比对：**0 条不一致** |

### 4.2 分布

| License | 全量 430 | 其中真进 Windows 壳的 233 |
| --- | --- | --- |
| Apache-2.0（含 `Apache-2.0 OR MIT` / `MIT/Apache-2.0`） | 283 | 159 |
| MIT | 111 | 44 |
| Unicode-3.0（ICU4X 系列） | 19 | 19 |
| BSD-3-Clause / BSD-2-Clause | 7 | 5 |
| MPL-2.0 | 5 | **5** |
| Zlib | 2 | 1 |
| ISC | 1 | 0 |
| `MIT OR Apache-2.0 OR LGPL-2.1-or-later`（r-efi） | 2 | 0 |

- **`wry` / `tauri` / `tauri-build` 系列**：`tauri@2.11.5`、`tauri-build@2.6.3`、`tauri-codegen@2.6.3`、`tauri-macros@2.6.3`、`tauri-runtime@2.11.3`、`tauri-runtime-wry@2.11.4`、`tauri-utils@2.9.3` 全部为 **`Apache-2.0 OR MIT`**，原文：`LICENSE_MIT` = `MIT License` ／ `Copyright (c) 2017 - Present Tauri Apps Contributors`；`LICENSE_APACHE-2.0` = `Apache License` ／ `Version 2.0, January 2004`。`tauri-winres@0.3.6` 为 MIT。
- **传染性关键词扫描**：429 份 crate 原文里扫 `GNU (AFFERO/LESSER) GENERAL PUBLIC LICENSE` / `Server Side Public License` → **0 命中**。唯一的 LGPL 出现在 `r-efi` 的 `Cargo.toml` 字段（该 crate 不随包带 LICENSE 文件，见 §4.4）。

### 4.3 超出白名单的 crate（逐条开原文）

| crate@版本 | 声明 | 进壳 | 原文路径 | 原文关键句（逐字） |
| --- | --- | --- | --- | --- |
| `cssparser@0.36.0` | `MPL-2.0` | **是** | `…/cssparser-0.36.0/LICENSE` | `Mozilla Public License Version 2.0` ／ `==================================` |
| `cssparser-macros@0.6.1` | `MPL-2.0` | **是** | `…/cssparser-macros-0.6.1/LICENSE` | 同上 |
| `dtoa-short@0.3.5` | `MPL-2.0` | **是** | `…/dtoa-short-0.3.5/LICENSE` | 同上 |
| `option-ext@0.2.0` | `MPL-2.0` | **是** | `…/option-ext-0.2.0/LICENSE.txt` | 同上 |
| `selectors@0.36.1` | `MPL-2.0` | **是** | **无 LICENSE 文件**（`Cargo.toml` 只有 `license = "MPL-2.0"`，`Cargo.toml.orig` 为 `license.workspace = true`） | **未取到原文** → 按未核对登记 |
| `foldhash@0.2.0` | `Zlib` | **是** | `…/foldhash-0.2.0/LICENSE` | `Copyright (c) 2024 Orson Peters` ／ `This software is provided 'as-is', without any express or implied warranty.` |
| `zlib-rs@0.6.8` | `Zlib` | 否 | `…/zlib-rs-0.6.8/LICENSE` | `(C) 2024 Trifecta Tech Foundation` ／ `This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages…` |
| `icu_*` / `zerovec*` / `yoke*` / `litemap` / `writeable` / `tinystr` / `potential_utf` / `zerofrom*` / `zerotrie`（19 个） | `Unicode-3.0` | **是**（19/19） | 各包 `LICENSE` | `UNICODE LICENSE V3` ／ `COPYRIGHT AND PERMISSION NOTICE` |
| `unicode-ident@1.0.26` | `(MIT OR Apache-2.0) AND Unicode-3.0` | **是** | `…/unicode-ident-1.0.26/{LICENSE-APACHE,LICENSE-MIT,LICENSE-UNICODE}` | 三份原文并列（Apache 2.0 + MIT + Unicode License V3） |
| `r-efi@5.3.0` / `r-efi@6.0.0` | `MIT OR Apache-2.0 OR LGPL-2.1-or-later` | **否** | `…/r-efi-{5.3.0,6.0.0}/AUTHORS`、`README.md`（**无 LICENSE 文件**） | `AUTHORS`：`LICENSE: This project is triple-licensed under the MIT License, the Apache License, Version 2.0, and the GNU Lesser General Public License, Version 2.1+.`；`README.md`：`### License:` ／ `- **MIT** OR **Apache-2.0** OR **LGPL-2.1-or-later**` ／ `- See AUTHORS file for details.` |

**MPL-2.0 那 5 个是怎么进来的（反查 `Cargo.lock` 依赖边）**：
`dom_query@0.27.0` → 依赖 `selectors` / `cssparser` / `foldhash`；`cssparser` → 依赖 `cssparser-macros` / `dtoa-short`。
`dom_query@0.27.0` 的上游是 `tauri-utils@2.9.3` 与 `wry@0.55.1`（两个都在实际构建列表里）。
MPL 2.0 是**文件级** copyleft：只要不改这些文件本身，以 Larger Work 形式链接进可执行文件是被显式允许的（MPL 2.0 §3.3），**不构成传染**。但它确实在白名单外 → 登记。

### 4.4 红线相关：`r-efi` 的 LGPL 字段怎么判

- **事实**：`r-efi@5.3.0` 与 `r-efi@6.0.0` 的 `Cargo.toml` 写着 `license = "MIT OR Apache-2.0 OR LGPL-2.1-or-later"`；包内**没有 LICENSE 文件**，只有 `AUTHORS` 与 `README.md` 的文字声明（原文见 §4.3）。
- **判定**：这是**三选一的 OR**，不是"必须遵守 LGPL"。采用哪一支由下游选，选 MIT 或 Apache-2.0 即完全避开 LGPL 条款。
- **是否进分发物**：**否**。反查依赖边 `r-efi ← getrandom@0.3.4 / getrandom@0.4.3`，而 `r-efi` 是 `getrandom` 的 UEFI 目标后端；扫 `target/release/deps/*.d` 的 233 个实际编译 crate 里**没有 `r-efi`**（`getrandom` 本身在）。
- **结论**：**不构成 AGPL/GPL/LGPL 传染性许可**，不触发 DoD④ 的"停止发布"；但既然 Tauri 的锁文件里出现了 LGPL 字样，已按 `AGENTS.md` §4 **登记 `DESIGN.md` 附录 B**，由人 / Max 拍板是否要求上游换成纯 `MIT OR Apache-2.0`。

---

## 5. 随包构建物与再分发条款

安装包实际载荷（`PLAN.md` U3 卡**首次打包**实测：NSIS 52 个文件 / 11 830 472 B；MSI 51 个文件 / 11 750 664 B；**V09-04 重打 2026-09-25 实测：两个包载荷均 55 个文件 / 13 265 363 B** ＝`tatai.exe` 4 008 960 + `WebView2Loader.dll` 160 320 + `server/` 53 文件 9 096 083；首次那条含 NSIS 装机时生成的 `uninstall.exe`，重打这条是**载荷口径**、未含它）里除 `tatai.exe` 与本仓库自产的 `server/index.js`、`server/mcp.js` 外，还含下列第三方二进制：

### 5.1 `WebView2Loader.dll`（U3 特地提醒项）

| 项 | 内容 |
| --- | --- |
| 来源 | `webview2-com-sys@0.38.2` crate 自带的 `x64/WebView2Loader.dll`，由 `src-tauri/build.rs#stage_webview2_loader()` 摆到 `src-tauri/resources/`，再由 `tauri.conf.json` 的 `bundle.resources` 打进安装目录 |
| 文件身份（本机实读版本资源） | `CompanyName: Microsoft Corporation` ／ `FileDescription: Microsoft Edge Embedded Browser WebView Loader` ／ `FileVersion: 1.0.3650.58` ／ `LegalCopyright: Copyright Microsoft Corporation. All rights reserved.` |
| 随包许可文件 | **未找到**。`webview2-com-sys` crate 目录里只有 `arm64/x64/x86` 三个 DLL、导入库与 `src/`，**无 LICENSE/COPYING/NOTICE**；`src-tauri/target/release/bundle/{nsis,msi}` 下 `find -iname "*licen*" -o -iname "*notice*" -o -iname "*eula*"` → **零命中** |
| 可引用的条款落点 | 微软官方分发文档 [Distribute your app and the WebView2 Runtime](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) 的「Files to ship with the app」节原文：**“The WebView2Loader code needs to be shipped with the app. This can be done by statically linking WebView2Loader.lib into the app binaries, or by including the WebView2Loader.dll that matches the app's architecture.”** 同节给出 `\<myApp>\WebView2Loader.dll` 的目录示例，与本项目的随包位置一致 |
| 结论 | **允许随包**（微软文档明确要求/允许随 app 分发该 DLL），但**包内许可原文缺失**：所见只是「文档允许分发」+ DLL 自带的版权字符串，**没有随包的 Microsoft 软件许可条款文本** → **需人工确认**（见 §7.3 登记）。另注：Evergreen 模式只随包 `WebView2Loader.dll` 而不含 WebView2 Runtime 本体，本项目即此模式（运行时按 `bundle.targets: nsis/msi` 由 Tauri 引导器处理） |

### 5.2 `node-pty` 预编译二进制（`src-tauri/resources/server/node_modules/node-pty/prebuilds/win32-x64/`）

| 文件 | 上游 | 许可与原文落点 |
| --- | --- | --- |
| `pty.node`、`conpty.node`、`conpty_console_list.node` | node-pty | `node_modules/node-pty/LICENSE` 段一（`Copyright (c) 2012-2015, Christopher Jeffrey`）＋段二（`Copyright (c) 2016, Daniel Imms`），均 MIT |
| `conpty/conpty.dll`、`conpty/OpenConsole.exe` | **Microsoft（Windows Terminal / ConPTY）** | `node_modules/node-pty/LICENSE` **段三**：`MIT License` ／ `Copyright (c) 2018 - present Microsoft Corporation` ／ `All rights reserved.` ／ `Permission is hereby granted, free of charge, …` —— node-pty 把微软 ConPTY 的 MIT 声明放在自己的 LICENSE 里，这就是这两个文件的原文依据（`third_party/conpty/1.23.251008001/{win10-x64,win10-arm64}/` 内**不含**单独许可文件） |
| `winpty.dll`、`winpty-agent.exe` | winpty（Ryan Prichard） | `node_modules/node-pty/deps/winpty/LICENSE`：`The MIT License (MIT)` ／ `Copyright (c) 2011-2016 Ryan Prichard` ／ `Permission is hereby granted, …` |

### 5.3 tree-sitter 原生模块与运行时加载器（同一 `server/node_modules/`）

| 目录 | License | 原文路径 |
| --- | --- | --- |
| `tree-sitter/prebuilds/win32-x64/tree-sitter.node` | MIT | 原包 `node_modules/tree-sitter/LICENSE`（`The MIT License (MIT)` ／ `Copyright (c) 2014 maxbrunsfeld`） |
| `tree-sitter-python/…/tree-sitter-python.node` | MIT | `node_modules/tree-sitter-python/LICENSE`（`Copyright (c) 2016 Max Brunsfeld`） |
| `tree-sitter-typescript/…/tree-sitter-typescript.node` | MIT | `node_modules/tree-sitter-typescript/LICENSE`（`Copyright (c) 2017 Max Brunsfeld`） |
| `node-gyp-build/`（原生模块加载器） | MIT | `node_modules/node-gyp-build/LICENSE`：`The MIT License (MIT)` ／ `Copyright (c) 2017 Mathias Buus` |

### 5.4 随包的 `index.js` / `mcp.js`（本次审计新发现的口径缺口）

- 事实：`scripts/build-server.ts` 用 `ssr: { noExternal: true }` 把**除 node 内置模块以外的全部依赖内联**进两个单文件产物（`index.js` 258 852 B、`mcp.js` 38 176 B）。也就是说 **`@modelcontextprotocol/sdk` 及其传递依赖（`zod`、`ajv`、`express`、`hono`、`jose`、`eventsource` …）、`chokidar`、`tree-sitter` 的 JS 层、`node-pty` 的 JS 层**的代码原样躺在安装包的 `server/index.js`、`server/mcp.js` 里。
- 义务：MIT / Apache-2.0 都要求**再分发时保留版权与许可声明**（MIT：`The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.`）。
- 现状：安装包载荷里**没有任何 LICENSE / NOTICE / THIRD-PARTY 文件**（`find` 零命中，见 §5.1 同一命令）。仓库根只有塔台自己的 `LICENSE`（MIT）。
- 判定：**这是本次审计发现的合规缺口**（不是传染性许可问题）→ 已登记 `DESIGN.md` 附录 B，建议随包附一份 `THIRD-PARTY-NOTICES`（由构建脚本按生产树自动生成），并让 `verify:u3` 断言它在载荷里。

---

## 6. "抄设计 ≠ 抄代码"核实（§10.3 末两条，DoD 要求）

### 6.1 基准事实

- `PLAN.md` 卡 0 的结论是 **「自写壳」**（`PROGRESS.md` 2026-09-17 卡0 流水：判定标准三条全部指向自写——改造不集中在组件层、核心状态模型/路由/构建管线都要动、fork 改造量超自写壳一半），T3 Code 降级为「设计参考（布局、配对流、性能纪律可抄设计，不拷贝代码）」。
- T3 Code 的 spike 源码在 `.工作台/spike/t3code/`（**gitignore，不进仓库**；`.gitignore` 第 1 行 `.工作台/`）。

### 6.2 特征串 grep（真跑，排除 node_modules / `.工作台` / target / gen / resources / dist）

搜索词：`t3tools` / `t3code` / `T3 Code` / `ghostty` / `vibe-kanban` / `vibekanban` / `vibe_kanban` / `aionui` / `AionUi` / `aion-ui`。

| 结果 | 文件 |
| --- | --- |
| 命中 | 只有 `DESIGN.md`、`PLAN.md`、`PROGRESS.md` 三份**文档** |
| 源码（`src/`、`scripts/`、`src-tauri/src/`、`templates/`） | **零命中** |

命中的文档行逐条看，全部是"设计参考/待办/红线"的叙述，例如：
- `DESIGN.md:536` `| T3 Code | **候选基座**（fork） | MIT | 2.3 万星，半天 spike 跑起来看代码结构再定 |`
- `DESIGN.md:679` `- [ ] 若 fork T3 Code：核对 T3 Code 及其传递依赖`
- `DESIGN.md:680` `- [ ] 若参考 Vibe Kanban / AionUi：确认只是"抄设计"，未拷贝受约束代码`

另外对三家的另一种查法——**包名/依赖名**：`package.json` 与 `pnpm-lock.yaml` 里没有 `@t3tools/*`、`vibe-kanban`、`bloop`、`aionui`、`@clerk/*`、`@base-ui/*`、`@dnd-kit/*`、`effect`、`ghostty` 任何一条（T3 Code 的 monorepo 目录名、Vibe Kanban 的包名、AionUi 的包名均零命中）。

### 6.3 更强的结构性核查：同名文件 + 词袋相似度

- 把 T3 Code spike 的 web 源文件（`apps/web/src/**/*.ts(x)`，1 179 个唯一文件名）与本仓库 `src/**`（78 个唯一文件名）做**文件名交集**：只有 6 个通用名重合——`auth.ts`、`ChatView.tsx`、`index.ts`、`main.tsx`、`server.ts`、`types.ts`。
- 对 9 对同名候选文件做 **5-gram 词袋 Jaccard 相似度**（先剥注释）：**最高 0.0057**（`src/ui/main.tsx` 11 行 vs T3 `main.tsx` 85 行），其余为 0.0004 或 0。行数也完全不成比例（例：塔台 `ChatView.tsx` 473 行 vs T3 `ChatView.tsx` 10 435 行）。
- 判定：**没有任何代码片段来自 T3 Code**；同名文件是命名巧合（两边都要 `auth`/`server`/`types` 这类通用文件名）。

### 6.4 Vibe Kanban / AionUi

- 二者**从未被 clone 到本机工作区**（`.工作台/spike/` 下只有 `t3code/` 与它的截图），也没有任何依赖、包名、特征串出现在源码里（§6.2）。
- 判定：**只是"抄设计"（看板交互、桌面壳参考的口径写在 `DESIGN.md` §7.3），未拷贝受约束代码**。

---

## 7. 结论与登记

### 7.1 红线逐条

| 红线（`AGENTS.md` §6 / `DESIGN.md` §7.4） | 结论 | 证据 |
| --- | --- | --- |
| 只接受 MIT / Apache / BSD | **主体成立，5 个 npm 包 + 24 个 crate 超白名单**（均非传染，详见 §3.2 / §4.3） | 409 个 npm 包原文核对 + 430 个 crate 原文核对（429/430） |
| 避开 AGPL（swark） | **未引入** | `grep -ri` 全仓（排除 node_modules/.工作台）：`swark` 只命中 `AGENTS.md` / `DESIGN.md` / `PLAN.md` 的红线声明；npm 安装面与 Cargo.lock 无同名条目 |
| 避开 GPL（Sourcetrail / pyan3） | **未引入** | 同上；另：384 个 npm 许可原文 + 429 份 crate 原文的 GPL 全文扫描 → 0 处真实 GPL 许可（3 处误报已逐条辟明，§3.2） |
| 不引入 SSPL / BUSL / 其他传染性许可 | **未引入** | 关键词扫描 0 命中 |
| LGPL | **1 处可选支**（`r-efi`，`MIT OR Apache-2.0 OR LGPL-2.1-or-later`，未进壳） | §4.4 |
| `.工作台/` 不进 git | **成立** | `.gitignore` 第 1 行 `.工作台/`；本次审计脚本与下载的 crate 副本全在 `.工作台/l1-audit/`，`git status` 未见其身影 |

### 7.2 需要在 `DESIGN.md` 附录 B 登记的事项（本次已追加 1 条 3 点）

1. **§10.3 清单与实际依赖面不符 4 处**：`shadcn/ui`（未引入，且无仓库内复制件）、`dnd-kit`（未引入）、`better-sqlite3`＋`SQLite`（未引入，实现态改用 jsonl）、`web-tree-sitter`（未引入，改用 node binding）。
2. **5 个 npm 包超出白名单**：`argparse`(Python-2.0)、`caniuse-lite`(CC-BY-4.0)、`lightningcss`＋`lightningcss-win32-x64-msvc`(MPL-2.0)、`robust-predicates`(Unlicense)。
3. **28 个 crate 超出白名单**（Rust 侧另有 1 个 ISC，同族允许）：MPL-2.0 × 5（`cssparser` / `cssparser-macros` / `dtoa-short` / `option-ext` / `selectors`，**5 个都进壳**）、Unicode-3.0 家族 × 19（`icu_*` × 7 / `zerovec{,  -derive}` / `yoke{, -derive}` / `zerofrom{, -derive}` / `zerotrie` / `litemap` / `writeable` / `tinystr` / `potential_utf` 共 18 个纯 Unicode-3.0，加 `unicode-ident` 的 `(MIT OR Apache-2.0) AND Unicode-3.0`——**19 个都进壳**）、Zlib × 2（`foldhash` 进壳、`zlib-rs` 未进壳）、r-efi × 2（`MIT OR Apache-2.0 OR LGPL-2.1-or-later`，未进壳）。

### 7.3 证据缺口（如实登记，不冒充已核对）

| 缺口 | 影响 | 建议 |
| --- | --- | --- |
| `boolbase@1.0.0`（ISC，**生产树内**）包内无任何许可原文，上游抓取本轮失败 | 该条属于"未核对" | 人工/下一轮补上游 `LICENSE` 原文；或替换为有明确许可的选择器工具 |
| `selectors@0.36.1`（MPL-2.0，**进壳**）包内无 LICENSE 文件，只有 `Cargo.toml` 字段 | 该条属于"未核对" | 从 `servo/rust-selectors` 上游取 `LICENSE` 原文留证 |
| `WebView2Loader.dll` 随包无微软许可条款文本 | 再分发依据目前只有官方文档一句话 + DLL 内版权串 | 人工确认；必要时在安装目录或 README 附微软许可条款链接与声明 |
| Node.js 运行时 | 不随包分发（`src-tauri/README.md` 明确口径），本审计**未取 Node 自身 LICENSE 原文** | 若将来改为随包 `node.exe`（U2 留了后路），必须补 Node 的 `LICENSE` 随包 |

### 7.4 发布就绪判定（供人 / Max 拍板）

- **L1 卡本身**：DoD①–④ 的核对动作全部完成，无一遗漏项被静默跳过 → `PLAN.md` L1 置 `done`。
- **DoD④ 的"停止发布"条件未触发**（无 AGPL/GPL/SSPL）。
- **但"发布放行"不是 L1 能自己拍的口径**：严格按 `DESIGN.md` §7.4"只接受 MIT / Apache / BSD"的字面，§7.2 的 2、3 两条都算越线（尽管全部是宽松/弱 copyleft 许可）；再加 §5.4 的随包 NOTICE 缺口。这三件事需要人 / Max 明确表态后，L4（仓库打磨 + release tag）才具备放行前提。

---

## 附录 A：npm 全量安装面（409 个 `name@version`）逐条

### A. 全量安装面清单（node_modules 实际安装 409 个 name@version）

| # | 包 | License | 归属链 | 包内许可原文 |
| --- | --- | --- | --- | --- |
| 1 | `@babel/code-frame@7.29.7` | MIT | 开发/构建 | LICENSE |
| 2 | `@babel/compat-data@7.29.7` | MIT | 开发/构建 | LICENSE |
| 3 | `@babel/core@7.29.7` | MIT | 开发/构建 | LICENSE |
| 4 | `@babel/generator@7.29.8` | MIT | 开发/构建 | LICENSE |
| 5 | `@babel/helper-compilation-targets@7.29.7` | MIT | 开发/构建 | LICENSE |
| 6 | `@babel/helper-globals@7.29.7` | MIT | 开发/构建 | LICENSE |
| 7 | `@babel/helper-module-imports@7.29.7` | MIT | 开发/构建 | LICENSE |
| 8 | `@babel/helper-module-transforms@7.29.7` | MIT | 开发/构建 | LICENSE |
| 9 | `@babel/helper-plugin-utils@7.29.7` | MIT | 开发/构建 | LICENSE |
| 10 | `@babel/helper-string-parser@7.29.7` | MIT | 开发/构建 | LICENSE |
| 11 | `@babel/helper-validator-identifier@7.29.7` | MIT | 开发/构建 | LICENSE |
| 12 | `@babel/helper-validator-option@7.29.7` | MIT | 开发/构建 | LICENSE |
| 13 | `@babel/helpers@7.29.7` | MIT | 开发/构建 | LICENSE |
| 14 | `@babel/parser@7.29.8` | MIT | 开发/构建 | LICENSE |
| 15 | `@babel/plugin-transform-react-jsx-self@7.29.7` | MIT | 开发/构建 | LICENSE |
| 16 | `@babel/plugin-transform-react-jsx-source@7.29.7` | MIT | 开发/构建 | LICENSE |
| 17 | `@babel/runtime@7.29.7` | MIT | 生产 | LICENSE |
| 18 | `@babel/template@7.29.7` | MIT | 开发/构建 | LICENSE |
| 19 | `@babel/traverse@7.29.8` | MIT | 开发/构建 | LICENSE |
| 20 | `@babel/types@7.29.8` | MIT | 开发/构建 | LICENSE |
| 21 | `@esbuild/win32-x64@0.28.2` | MIT | 开发/构建 | （无） |
| 22 | `@gera2ld/jsx-dom@2.2.2` | ISC | 生产 | LICENSE |
| 23 | `@hono/node-server@2.1.1` | MIT | 生产 | LICENSE |
| 24 | `@jridgewell/gen-mapping@0.3.12` | MIT | 开发/构建 | LICENSE |
| 25 | `@jridgewell/gen-mapping@0.3.5` | MIT | 开发/构建 | LICENSE |
| 26 | `@jridgewell/remapping@2.3.5` | MIT | 开发/构建 | LICENSE |
| 27 | `@jridgewell/resolve-uri@3.1.2` | MIT | 开发/构建 | LICENSE |
| 28 | `@jridgewell/set-array@1.2.1` | MIT | 开发/构建 | LICENSE |
| 29 | `@jridgewell/sourcemap-codec@1.6.0` | MIT | 开发/构建 | LICENSE |
| 30 | `@jridgewell/trace-mapping@0.3.31` | MIT | 开发/构建 | LICENSE |
| 31 | `@modelcontextprotocol/sdk@1.30.0` | MIT | 生产 | LICENSE |
| 32 | `@rolldown/pluginutils@1.0.0-rc.3` | MIT | 开发/构建 | LICENSE |
| 33 | `@rollup/rollup-win32-x64-gnu@4.63.3` | MIT | 开发/构建 | （无） |
| 34 | `@rollup/rollup-win32-x64-msvc@4.63.3` | MIT | 开发/构建 | （无） |
| 35 | `@tailwindcss/node@4.3.3` | MIT | 开发/构建 | LICENSE |
| 36 | `@tailwindcss/oxide@4.3.3` | MIT | 开发/构建 | LICENSE |
| 37 | `@tailwindcss/oxide-win32-x64-msvc@4.3.3` | MIT | 开发/构建 | LICENSE |
| 38 | `@tailwindcss/vite@4.3.3` | MIT | 开发/构建 | LICENSE |
| 39 | `@tauri-apps/cli@2.11.4` | Apache-2.0 | 开发/构建 | LICENSE_APACHE-2.0+LICENSE_MIT |
| 40 | `@tauri-apps/cli-win32-x64-msvc@2.11.4` | Apache-2.0 | 开发/构建 | （无） |
| 41 | `@types/babel__core@7.20.5` | MIT | 开发/构建 | LICENSE |
| 42 | `@types/babel__generator@7.27.0` | MIT | 开发/构建 | LICENSE |
| 43 | `@types/babel__template@7.4.4` | MIT | 开发/构建 | LICENSE |
| 44 | `@types/babel__traverse@7.28.0` | MIT | 开发/构建 | LICENSE |
| 45 | `@types/d3-color@3.1.3` | MIT | 生产 | LICENSE |
| 46 | `@types/d3-drag@3.0.7` | MIT | 生产 | LICENSE |
| 47 | `@types/d3-interpolate@3.0.4` | MIT | 生产 | LICENSE |
| 48 | `@types/d3-selection@3.0.12` | MIT | 生产 | LICENSE |
| 49 | `@types/d3-transition@3.0.9` | MIT | 生产 | LICENSE |
| 50 | `@types/d3-zoom@3.0.8` | MIT | 生产 | LICENSE |
| 51 | `@types/dagre@0.7.54` | MIT | 开发/构建 | LICENSE |
| 52 | `@types/debug@4.1.13` | MIT | 生产 | LICENSE |
| 53 | `@types/estree@1.0.9` | MIT | 生产 | LICENSE |
| 54 | `@types/estree-jsx@1.0.5` | MIT | 生产 | LICENSE |
| 55 | `@types/hast@3.0.5` | MIT | 生产 | LICENSE |
| 56 | `@types/mdast@4.0.4` | MIT | 生产 | LICENSE |
| 57 | `@types/ms@2.1.0` | MIT | 生产 | LICENSE |
| 58 | `@types/node@24.13.5` | MIT | 开发/构建 | LICENSE |
| 59 | `@types/prop-types@15.7.15` | MIT | 生产 | LICENSE |
| 60 | `@types/react@18.3.31` | MIT | 生产 | LICENSE |
| 61 | `@types/react-dom@18.3.1` | MIT | 生产 | LICENSE |
| 62 | `@types/unist@3.0.3` | MIT | 生产 | LICENSE |
| 63 | `@types/unist@2.0.11` | MIT | 生产 | LICENSE |
| 64 | `@ungap/structured-clone@1.4.0` | ISC | 生产 | LICENSE |
| 65 | `@vitejs/plugin-react@5.2.0` | MIT | 开发/构建 | LICENSE |
| 66 | `@vscode/markdown-it-katex@1.1.2` | MIT | 生产 | LICENSE |
| 67 | `@xterm/addon-fit@0.11.0` | MIT | 生产 | LICENSE |
| 68 | `@xterm/xterm@6.0.0` | MIT | 生产 | LICENSE |
| 69 | `@xyflow/react@12.11.6` | MIT | 生产 | LICENSE |
| 70 | `@xyflow/system@0.0.82` | MIT | 生产 | LICENSE |
| 71 | `accepts@2.0.0` | MIT | 生产 | LICENSE |
| 72 | `ajv@8.20.0` | MIT | 生产 | LICENSE |
| 73 | `ajv-formats@3.0.1` | MIT | 生产 | LICENSE |
| 74 | `argparse@2.0.1` | Python-2.0 | 生产 | LICENSE |
| 75 | `bail@2.0.2` | MIT | 生产 | license |
| 76 | `baseline-browser-mapping@2.11.24` | Apache-2.0 | 开发/构建 | LICENSE.txt |
| 77 | `body-parser@2.3.0` | MIT | 生产 | LICENSE |
| 78 | `boolbase@1.0.0` | ISC | 生产 | （无） |
| 79 | `browserslist@4.29.0` | MIT | 开发/构建 | LICENSE |
| 80 | `bytes@3.1.2` | MIT | 生产 | LICENSE |
| 81 | `call-bind-apply-helpers@1.0.2` | MIT | 生产 | LICENSE |
| 82 | `call-bound@1.0.4` | MIT | 生产 | LICENSE |
| 83 | `caniuse-lite@1.0.30001810` | CC-BY-4.0 | 开发/构建 | LICENSE |
| 84 | `ccount@2.0.1` | MIT | 生产 | license |
| 85 | `character-entities@2.0.2` | MIT | 生产 | license |
| 86 | `character-entities-html4@2.1.0` | MIT | 生产 | license |
| 87 | `character-entities-legacy@3.0.0` | MIT | 生产 | license |
| 88 | `character-reference-invalid@2.0.1` | MIT | 生产 | license |
| 89 | `cheerio@1.0.0` | MIT | 生产 | LICENSE |
| 90 | `cheerio-select@2.1.0` | BSD | 生产 | LICENSE |
| 91 | `chokidar@5.0.0` | MIT | 生产 | LICENSE |
| 92 | `classcat@5.0.5` | MIT | 生产 | LICENSE.md |
| 93 | `clsx@2.1.1` | MIT | 生产 | license |
| 94 | `comma-separated-tokens@2.0.3` | MIT | 生产 | license |
| 95 | `commander@7.0.0` | MIT | 生产 | LICENSE |
| 96 | `commander@8.3.0` | MIT | 生产 | LICENSE |
| 97 | `content-disposition@1.1.0` | MIT | 生产 | LICENSE |
| 98 | `content-type@1.0.5` | MIT | 生产 | LICENSE |
| 99 | `content-type@2.1.0` | MIT | 生产 | LICENSE |
| 100 | `convert-source-map@2.0.0` | MIT | 开发/构建 | LICENSE |
| 101 | `cookie@0.7.1` | MIT | 生产 | LICENSE |
| 102 | `cookie-signature@1.2.2` | MIT | 生产 | LICENSE |
| 103 | `cors@2.8.6` | MIT | 生产 | LICENSE |
| 104 | `cross-spawn@7.0.6` | MIT | 生产 | LICENSE |
| 105 | `css-select@5.1.0` | BSD | 生产 | LICENSE |
| 106 | `css-what@6.1.0` | BSD | 生产 | LICENSE |
| 107 | `csstype@3.2.3` | MIT | 生产 | LICENSE |
| 108 | `d3@7.9.0` | ISC | 生产 | LICENSE |
| 109 | `d3-array@3.2.4` | ISC | 生产 | LICENSE |
| 110 | `d3-axis@3.0.0` | ISC | 生产 | LICENSE |
| 111 | `d3-brush@3.0.0` | ISC | 生产 | LICENSE |
| 112 | `d3-chord@3.0.1` | ISC | 生产 | LICENSE |
| 113 | `d3-color@3.1.0` | ISC | 生产 | LICENSE |
| 114 | `d3-contour@4.0.2` | ISC | 生产 | LICENSE |
| 115 | `d3-delaunay@6.0.4` | ISC | 生产 | LICENSE |
| 116 | `d3-dispatch@3.0.1` | ISC | 生产 | LICENSE |
| 117 | `d3-drag@3.0.0` | ISC | 生产 | LICENSE |
| 118 | `d3-dsv@3.0.1` | ISC | 生产 | LICENSE |
| 119 | `d3-ease@3.0.1` | BSD | 生产 | LICENSE |
| 120 | `d3-fetch@3.0.1` | ISC | 生产 | LICENSE |
| 121 | `d3-force@3.0.0` | ISC | 生产 | LICENSE |
| 122 | `d3-format@3.1.2` | ISC | 生产 | LICENSE |
| 123 | `d3-geo@3.1.1` | ISC | 生产 | LICENSE |
| 124 | `d3-hierarchy@3.1.2` | ISC | 生产 | LICENSE |
| 125 | `d3-interpolate@3.0.1` | ISC | 生产 | LICENSE |
| 126 | `d3-path@3.1.0` | ISC | 生产 | LICENSE |
| 127 | `d3-polygon@3.0.1` | ISC | 生产 | LICENSE |
| 128 | `d3-quadtree@3.0.1` | ISC | 生产 | LICENSE |
| 129 | `d3-random@3.0.1` | ISC | 生产 | LICENSE |
| 130 | `d3-scale@4.0.2` | ISC | 生产 | LICENSE |
| 131 | `d3-scale-chromatic@3.1.0` | ISC | 生产 | LICENSE |
| 132 | `d3-selection@3.0.0` | ISC | 生产 | LICENSE |
| 133 | `d3-shape@3.2.0` | ISC | 生产 | LICENSE |
| 134 | `d3-time@3.1.0` | ISC | 生产 | LICENSE |
| 135 | `d3-time-format@4.1.0` | ISC | 生产 | LICENSE |
| 136 | `d3-timer@3.0.1` | ISC | 生产 | LICENSE |
| 137 | `d3-transition@3.0.1` | ISC | 生产 | LICENSE |
| 138 | `d3-zoom@3.0.0` | ISC | 生产 | LICENSE |
| 139 | `dagre@0.8.5` | MIT | 生产 | LICENSE |
| 140 | `debug@4.4.3` | MIT | 生产 | LICENSE |
| 141 | `decode-named-character-reference@1.3.0` | MIT | 生产 | license |
| 142 | `delaunator@5.1.0` | ISC | 生产 | LICENSE |
| 143 | `depd@2.0.0` | MIT | 生产 | LICENSE |
| 144 | `dequal@2.0.3` | MIT | 生产 | license |
| 145 | `detect-libc@2.1.2` | Apache-2.0 | 开发/构建 | LICENSE |
| 146 | `devlop@1.1.0` | MIT | 生产 | license |
| 147 | `dom-serializer@2.0.0` | MIT | 生产 | LICENSE |
| 148 | `domelementtype@2.3.0` | BSD | 生产 | LICENSE |
| 149 | `domhandler@5.0.3` | BSD | 生产 | LICENSE |
| 150 | `domutils@3.1.0` | BSD | 生产 | LICENSE |
| 151 | `dunder-proto@1.0.1` | MIT | 生产 | LICENSE |
| 152 | `ee-first@1.1.1` | MIT | 生产 | LICENSE |
| 153 | `electron-to-chromium@1.5.430` | ISC | 开发/构建 | LICENSE |
| 154 | `encodeurl@2.0.0` | MIT | 生产 | LICENSE |
| 155 | `encoding-sniffer@0.2.0` | MIT | 生产 | LICENSE |
| 156 | `enhanced-resolve@5.25.1` | MIT | 开发/构建 | LICENSE |
| 157 | `entities@4.3.0` | BSD | 生产 | LICENSE |
| 158 | `entities@4.4.0` | BSD | 生产 | LICENSE |
| 159 | `entities@4.5.0` | BSD | 生产 | LICENSE |
| 160 | `es-define-property@1.0.1` | MIT | 生产 | LICENSE |
| 161 | `es-errors@1.3.0` | MIT | 生产 | LICENSE |
| 162 | `es-object-atoms@1.1.2` | MIT | 生产 | LICENSE |
| 163 | `esbuild@0.28.2` | MIT | 开发/构建 | LICENSE.md |
| 164 | `escalade@3.2.0` | MIT | 开发/构建 | license |
| 165 | `escape-html@1.0.3` | MIT | 生产 | LICENSE |
| 166 | `escape-string-regexp@5.0.0` | MIT | 生产 | license |
| 167 | `estree-util-is-identifier-name@3.0.0` | MIT | 生产 | license |
| 168 | `etag@1.8.1` | MIT | 生产 | LICENSE |
| 169 | `eventsource@3.0.2` | MIT | 生产 | LICENSE |
| 170 | `eventsource-parser@3.1.1` | MIT | 生产 | LICENSE |
| 171 | `express@5.2.1` | MIT | 生产 | LICENSE |
| 172 | `express-rate-limit@8.7.0` | MIT | 生产 | license |
| 173 | `extend@3.0.2` | MIT | 生产 | LICENSE |
| 174 | `fast-deep-equal@3.1.3` | MIT | 生产 | LICENSE |
| 175 | `fast-uri@3.1.8` | BSD | 生产 | LICENSE |
| 176 | `fdir@6.5.0` | MIT | 开发/构建 | LICENSE |
| 177 | `finalhandler@2.1.1` | MIT | 生产 | LICENSE |
| 178 | `forwarded@0.2.0` | MIT | 生产 | LICENSE |
| 179 | `fresh@2.0.0` | MIT | 生产 | LICENSE |
| 180 | `function-bind@1.1.2` | MIT | 生产 | LICENSE |
| 181 | `gensync@1.0.0-beta.2` | MIT | 开发/构建 | LICENSE |
| 182 | `get-intrinsic@1.3.0` | MIT | 生产 | LICENSE |
| 183 | `get-proto@1.0.1` | MIT | 生产 | LICENSE |
| 184 | `gopd@1.2.0` | MIT | 生产 | LICENSE |
| 185 | `graceful-fs@4.2.11` | ISC | 开发/构建 | LICENSE |
| 186 | `graphlib@2.1.8` | MIT | 生产 | LICENSE |
| 187 | `has-symbols@1.1.0` | MIT | 生产 | LICENSE |
| 188 | `hasown@2.0.4` | MIT | 生产 | LICENSE |
| 189 | `hast-util-from-parse5@8.0.3` | MIT | 生产 | license |
| 190 | `hast-util-parse-selector@4.0.0` | MIT | 生产 | license |
| 191 | `hast-util-raw@9.1.0` | MIT | 生产 | license |
| 192 | `hast-util-sanitize@5.0.2` | MIT | 生产 | license |
| 193 | `hast-util-to-jsx-runtime@2.3.6` | MIT | 生产 | license |
| 194 | `hast-util-to-parse5@8.0.1` | MIT | 生产 | license |
| 195 | `hast-util-whitespace@3.0.0` | MIT | 生产 | license |
| 196 | `hastscript@9.0.1` | MIT | 生产 | license |
| 197 | `highlight.js@11.12.0` | BSD | 生产 | LICENSE |
| 198 | `hono@4.13.8` | MIT | 生产 | LICENSE |
| 199 | `html-url-attributes@3.0.1` | MIT | 生产 | license |
| 200 | `html-void-elements@3.0.0` | MIT | 生产 | license |
| 201 | `htmlparser2@9.1.0` | MIT | 生产 | LICENSE |
| 202 | `http-errors@2.0.1` | MIT | 生产 | LICENSE |
| 203 | `http-errors@2.0.0` | MIT | 生产 | LICENSE |
| 204 | `iconv-lite@0.7.3` | MIT | 生产 | LICENSE |
| 205 | `iconv-lite@0.6.3` | MIT | 生产 | LICENSE |
| 206 | `inherits@2.0.4` | ISC | 生产 | LICENSE |
| 207 | `inline-style-parser@0.1.1` | MIT | 生产 | （无） |
| 208 | `internmap@2.0.3` | ISC | 生产 | LICENSE |
| 209 | `ip-address@10.7.2` | MIT | 生产 | LICENSE |
| 210 | `ipaddr.js@1.9.1` | MIT | 生产 | LICENSE |
| 211 | `is-alphabetical@2.0.1` | MIT | 生产 | license |
| 212 | `is-alphanumerical@2.0.1` | MIT | 生产 | license |
| 213 | `is-decimal@2.0.1` | MIT | 生产 | license |
| 214 | `is-hexadecimal@2.0.1` | MIT | 生产 | license |
| 215 | `is-plain-obj@4.1.0` | MIT | 生产 | license |
| 216 | `is-promise@4.0.0` | MIT | 生产 | LICENSE |
| 217 | `isexe@2.0.0` | ISC | 生产 | LICENSE |
| 218 | `jiti@2.7.0` | MIT | 开发/构建 | LICENSE |
| 219 | `jose@6.2.12` | MIT | 生产 | LICENSE.md |
| 220 | `js-tokens@4.0.0` | MIT | 生产 | LICENSE |
| 221 | `js-tokens@3.0.0` | MIT | 生产 | LICENSE |
| 222 | `jsesc@3.1.0` | MIT | 开发/构建 | LICENSE-MIT.txt |
| 223 | `json-schema-traverse@1.0.0` | MIT | 生产 | LICENSE |
| 224 | `json-schema-typed@8.0.2` | BSD | 生产 | LICENSE.md |
| 225 | `json5@2.2.3` | MIT | 开发/构建 | LICENSE.md |
| 226 | `katex@0.16.47` | MIT | 生产 | LICENSE |
| 227 | `lightningcss@1.32.0` | MPL-2.0 | 开发/构建 | LICENSE |
| 228 | `lightningcss-win32-x64-msvc@1.32.0` | MPL-2.0 | 开发/构建 | LICENSE |
| 229 | `linkify-it@5.0.2` | MIT | 生产 | LICENSE |
| 230 | `lodash@4.18.1` | MIT | 生产 | LICENSE |
| 231 | `longest-streak@3.1.0` | MIT | 生产 | license |
| 232 | `loose-envify@1.4.0` | MIT | 生产 | LICENSE |
| 233 | `lru-cache@5.1.1` | ISC | 开发/构建 | LICENSE |
| 234 | `magic-string@0.30.21` | MIT | 开发/构建 | LICENSE |
| 235 | `markdown-it@14.3.2` | MIT | 生产 | LICENSE |
| 236 | `markdown-it-ins@4.0.0` | MIT | 生产 | LICENSE |
| 237 | `markdown-it-mark@4.0.0` | MIT | 生产 | LICENSE |
| 238 | `markdown-it-sub@2.0.0` | MIT | 生产 | LICENSE |
| 239 | `markdown-it-sup@2.0.0` | MIT | 生产 | LICENSE |
| 240 | `markdown-table@3.0.4` | MIT | 生产 | license |
| 241 | `marked@17.0.6` | MIT | 生产 | LICENSE.md |
| 242 | `markmap-common@0.18.9` | MIT | 生产 | LICENSE |
| 243 | `markmap-html-parser@0.18.11` | MIT | 生产 | LICENSE |
| 244 | `markmap-lib@0.18.12` | MIT | 生产 | LICENSE |
| 245 | `markmap-view@0.18.12` | MIT | 生产 | LICENSE |
| 246 | `math-intrinsics@1.1.0` | MIT | 生产 | LICENSE |
| 247 | `mdast-util-find-and-replace@3.0.2` | MIT | 生产 | license |
| 248 | `mdast-util-from-markdown@2.0.3` | MIT | 生产 | license |
| 249 | `mdast-util-gfm@3.1.0` | MIT | 生产 | license |
| 250 | `mdast-util-gfm-autolink-literal@2.0.1` | MIT | 生产 | license |
| 251 | `mdast-util-gfm-footnote@2.1.0` | MIT | 生产 | license |
| 252 | `mdast-util-gfm-strikethrough@2.0.0` | MIT | 生产 | license |
| 253 | `mdast-util-gfm-table@2.0.0` | MIT | 生产 | license |
| 254 | `mdast-util-gfm-task-list-item@2.0.0` | MIT | 生产 | license |
| 255 | `mdast-util-mdx-expression@2.0.1` | MIT | 生产 | license |
| 256 | `mdast-util-mdx-jsx@3.2.0` | MIT | 生产 | license |
| 257 | `mdast-util-mdxjs-esm@2.0.1` | MIT | 生产 | license |
| 258 | `mdast-util-phrasing@4.1.0` | MIT | 生产 | license |
| 259 | `mdast-util-to-hast@13.2.1` | MIT | 生产 | license |
| 260 | `mdast-util-to-markdown@2.0.0` | MIT | 生产 | license |
| 261 | `mdast-util-to-string@4.0.0` | MIT | 生产 | license |
| 262 | `mdurl@2.1.0` | MIT | 生产 | LICENSE |
| 263 | `media-typer@1.1.1` | MIT | 生产 | LICENSE |
| 264 | `merge-descriptors@2.0.0` | MIT | 生产 | license |
| 265 | `micromark@4.0.0` | MIT | 生产 | （无） |
| 266 | `micromark-core-commonmark@2.0.0` | MIT | 生产 | （无） |
| 267 | `micromark-extension-gfm@3.0.0` | MIT | 生产 | license |
| 268 | `micromark-extension-gfm-autolink-literal@2.1.0` | MIT | 生产 | license |
| 269 | `micromark-extension-gfm-footnote@2.1.0` | MIT | 生产 | license |
| 270 | `micromark-extension-gfm-strikethrough@2.1.0` | MIT | 生产 | license |
| 271 | `micromark-extension-gfm-table@2.1.2` | MIT | 生产 | license |
| 272 | `micromark-extension-gfm-tagfilter@2.0.0` | MIT | 生产 | license |
| 273 | `micromark-extension-gfm-task-list-item@2.1.0` | MIT | 生产 | license |
| 274 | `micromark-factory-destination@2.0.0` | MIT | 生产 | （无） |
| 275 | `micromark-factory-label@2.0.0` | MIT | 生产 | （无） |
| 276 | `micromark-factory-space@2.0.0` | MIT | 生产 | （无） |
| 277 | `micromark-factory-title@2.0.0` | MIT | 生产 | （无） |
| 278 | `micromark-factory-whitespace@2.0.0` | MIT | 生产 | （无） |
| 279 | `micromark-util-character@2.0.0` | MIT | 生产 | （无） |
| 280 | `micromark-util-chunked@2.0.0` | MIT | 生产 | （无） |
| 281 | `micromark-util-classify-character@2.0.0` | MIT | 生产 | （无） |
| 282 | `micromark-util-combine-extensions@2.0.0` | MIT | 生产 | （无） |
| 283 | `micromark-util-decode-numeric-character-reference@2.0.0` | MIT | 生产 | （无） |
| 284 | `micromark-util-decode-string@2.0.1` | MIT | 生产 | license |
| 285 | `micromark-util-encode@2.0.0` | MIT | 生产 | （无） |
| 286 | `micromark-util-html-tag-name@2.0.0` | MIT | 生产 | （无） |
| 287 | `micromark-util-normalize-identifier@2.0.0` | MIT | 生产 | （无） |
| 288 | `micromark-util-resolve-all@2.0.0` | MIT | 生产 | （无） |
| 289 | `micromark-util-sanitize-uri@2.0.0` | MIT | 生产 | （无） |
| 290 | `micromark-util-subtokenize@2.0.0` | MIT | 生产 | （无） |
| 291 | `micromark-util-symbol@2.0.0` | MIT | 生产 | （无） |
| 292 | `micromark-util-types@2.0.0` | MIT | 生产 | （无） |
| 293 | `mime-db@1.54.0` | MIT | 生产 | LICENSE |
| 294 | `mime-types@3.0.2` | MIT | 生产 | LICENSE |
| 295 | `ms@2.1.3` | MIT | 生产 | license.md |
| 296 | `nanoid@3.3.19` | MIT | 开发/构建 | LICENSE |
| 297 | `negotiator@1.1.0` | MIT | 生产 | LICENSE |
| 298 | `node-addon-api@7.1.0` | MIT | 生产 | LICENSE.md |
| 299 | `node-addon-api@8.9.2` | MIT | 生产 | LICENSE.md |
| 300 | `node-gyp-build@4.8.4` | MIT | 生产 | LICENSE |
| 301 | `node-pty@1.1.0` | MIT | 生产 | LICENSE |
| 302 | `node-releases@2.0.55` | MIT | 开发/构建 | LICENSE |
| 303 | `npm2url@0.2.4` | MIT | 生产 | LICENSE |
| 304 | `nth-check@2.0.1` | BSD | 生产 | LICENSE |
| 305 | `object-assign@4.1.1` | MIT | 生产 | license |
| 306 | `object-inspect@1.13.4` | MIT | 生产 | LICENSE |
| 307 | `on-finished@2.4.1` | MIT | 生产 | LICENSE |
| 308 | `once@1.4.0` | ISC | 生产 | LICENSE |
| 309 | `parse-entities@4.0.2` | MIT | 生产 | license |
| 310 | `parse5@7.1.2` | MIT | 生产 | LICENSE |
| 311 | `parse5@7.0.0` | MIT | 生产 | LICENSE |
| 312 | `parse5-htmlparser2-tree-adapter@7.0.0` | MIT | 生产 | LICENSE |
| 313 | `parse5-parser-stream@7.1.2` | MIT | 生产 | LICENSE |
| 314 | `parseurl@1.3.3` | MIT | 生产 | LICENSE |
| 315 | `path-key@3.1.1` | MIT | 生产 | license |
| 316 | `path-to-regexp@8.4.2` | MIT | 生产 | LICENSE |
| 317 | `picocolors@1.1.1` | ISC | 开发/构建 | LICENSE |
| 318 | `picomatch@4.0.7` | MIT | 开发/构建 | LICENSE |
| 319 | `pkce-challenge@5.0.0` | MIT | 生产 | LICENSE |
| 320 | `postcss@8.5.28` | MIT | 开发/构建 | LICENSE |
| 321 | `prismjs@1.29.0` | MIT | 生产 | LICENSE |
| 322 | `property-information@7.2.0` | MIT | 生产 | license |
| 323 | `proxy-addr@2.0.8` | MIT | 生产 | LICENSE |
| 324 | `punycode.js@2.3.1` | MIT | 生产 | LICENSE-MIT.txt |
| 325 | `qs@6.16.0` | BSD | 生产 | LICENSE.md |
| 326 | `range-parser@1.3.0` | MIT | 生产 | LICENSE |
| 327 | `raw-body@3.0.0` | MIT | 生产 | LICENSE |
| 328 | `raw-body@3.0.2` | MIT | 生产 | LICENSE |
| 329 | `react@18.3.1` | MIT | 生产 | LICENSE |
| 330 | `react-dom@18.3.1` | MIT | 生产 | LICENSE |
| 331 | `react-markdown@10.1.0` | MIT | 生产 | license |
| 332 | `react-refresh@0.18.0` | MIT | 开发/构建 | LICENSE |
| 333 | `readdirp@5.1.1` | MIT | 生产 | LICENSE |
| 334 | `rehype-harden@1.1.8` | MIT | 生产 | LICENSE.md |
| 335 | `rehype-raw@7.0.0` | MIT | 生产 | license |
| 336 | `rehype-sanitize@6.0.0` | MIT | 生产 | license |
| 337 | `remark-gfm@4.0.1` | MIT | 生产 | license |
| 338 | `remark-parse@11.0.0` | MIT | 生产 | license |
| 339 | `remark-rehype@11.1.2` | MIT | 生产 | license |
| 340 | `remark-stringify@11.0.0` | MIT | 生产 | license |
| 341 | `remend@1.3.1` | Apache-2.0 | 生产 | LICENSE |
| 342 | `require-from-string@2.0.2` | MIT | 生产 | license |
| 343 | `robust-predicates@3.0.3` | Unlicense | 生产 | LICENSE |
| 344 | `rollup@4.63.3` | MIT | 开发/构建 | LICENSE.md |
| 345 | `router@2.2.0` | MIT | 生产 | LICENSE |
| 346 | `rw@1.3.3` | BSD | 生产 | LICENSE |
| 347 | `safer-buffer@2.1.2` | MIT | 生产 | LICENSE |
| 348 | `scheduler@0.23.2` | MIT | 生产 | LICENSE |
| 349 | `semver@6.3.1` | ISC | 开发/构建 | LICENSE |
| 350 | `send@1.2.1` | MIT | 生产 | LICENSE |
| 351 | `serve-static@2.2.1` | MIT | 生产 | LICENSE |
| 352 | `setprototypeof@1.2.0` | ISC | 生产 | LICENSE |
| 353 | `shebang-command@2.0.0` | MIT | 生产 | license |
| 354 | `shebang-regex@3.0.0` | MIT | 生产 | license |
| 355 | `side-channel@1.1.1` | MIT | 生产 | LICENSE |
| 356 | `side-channel-list@1.0.1` | MIT | 生产 | LICENSE |
| 357 | `side-channel-map@1.0.1` | MIT | 生产 | LICENSE |
| 358 | `side-channel-weakmap@1.0.2` | MIT | 生产 | LICENSE |
| 359 | `source-map-js@1.2.1` | BSD | 开发/构建 | LICENSE |
| 360 | `space-separated-tokens@2.0.2` | MIT | 生产 | license |
| 361 | `statuses@2.0.2` | MIT | 生产 | LICENSE |
| 362 | `statuses@2.0.1` | MIT | 生产 | LICENSE |
| 363 | `streamdown@2.6.0` | Apache-2.0 | 生产 | LICENSE |
| 364 | `stringify-entities@4.0.4` | MIT | 生产 | license |
| 365 | `style-to-js@1.0.0` | MIT | 生产 | LICENSE |
| 366 | `style-to-object@0.3.0` | MIT | 生产 | LICENSE |
| 367 | `tailwind-merge@3.7.0` | MIT | 生产 | LICENSE.md |
| 368 | `tailwindcss@4.3.3` | MIT | 开发/构建 | LICENSE |
| 369 | `tapable@2.3.3` | MIT | 开发/构建 | LICENSE |
| 370 | `tinyglobby@0.2.17` | MIT | 开发/构建 | LICENSE |
| 371 | `toidentifier@1.0.1` | MIT | 生产 | LICENSE |
| 372 | `tree-sitter@0.25.1` | MIT | 生产 | LICENSE |
| 373 | `tree-sitter-javascript@0.23.1` | MIT | 生产 | LICENSE |
| 374 | `tree-sitter-python@0.25.0` | MIT | 生产 | LICENSE |
| 375 | `tree-sitter-typescript@0.23.2` | MIT | 生产 | LICENSE |
| 376 | `trim-lines@3.0.1` | MIT | 生产 | license |
| 377 | `trough@2.2.0` | MIT | 生产 | license |
| 378 | `tsx@4.23.13` | MIT | 开发/构建 | LICENSE |
| 379 | `type-is@2.1.0` | MIT | 生产 | LICENSE |
| 380 | `typescript@5.9.2` | Apache-2.0 | 开发/构建 | LICENSE.txt |
| 381 | `uc.micro@2.1.0` | MIT | 生产 | LICENSE.txt |
| 382 | `undici@6.28.1` | MIT | 生产 | LICENSE |
| 383 | `undici-types@7.18.2` | MIT | 开发/构建 | LICENSE |
| 384 | `unified@11.0.0` | MIT | 生产 | license |
| 385 | `unified@11.0.5` | MIT | 生产 | license |
| 386 | `unist-util-is@6.0.1` | MIT | 生产 | license |
| 387 | `unist-util-position@5.0.0` | MIT | 生产 | license |
| 388 | `unist-util-stringify-position@4.0.0` | MIT | 生产 | license |
| 389 | `unist-util-visit@5.1.0` | MIT | 生产 | license |
| 390 | `unist-util-visit-parents@6.0.2` | MIT | 生产 | license |
| 391 | `unpipe@1.0.0` | MIT | 生产 | LICENSE |
| 392 | `update-browserslist-db@1.3.3` | MIT | 开发/构建 | LICENSE |
| 393 | `use-sync-external-store@1.2.0` | MIT | 生产 | LICENSE |
| 394 | `vary@1.1.2` | MIT | 生产 | LICENSE |
| 395 | `vfile@6.0.3` | MIT | 生产 | license |
| 396 | `vfile-location@5.0.3` | MIT | 生产 | license |
| 397 | `vfile-message@4.0.3` | MIT | 生产 | license |
| 398 | `vite@7.3.6` | MIT | 开发/构建 | LICENSE.md |
| 399 | `web-namespaces@2.0.1` | MIT | 生产 | license |
| 400 | `whatwg-encoding@3.1.1` | MIT | 生产 | LICENSE.txt |
| 401 | `whatwg-mimetype@4.0.0` | MIT | 生产 | LICENSE.txt |
| 402 | `which@2.0.1` | ISC | 生产 | LICENSE |
| 403 | `wrappy@1.0.2` | ISC | 生产 | LICENSE |
| 404 | `yallist@3.1.1` | ISC | 开发/构建 | LICENSE |
| 405 | `yaml@2.9.1` | ISC | 生产 | LICENSE |
| 406 | `zod@4.6.5` | MIT | 生产 | LICENSE |
| 407 | `zod-to-json-schema@3.25.2` | ISC | 生产 | LICENSE |
| 408 | `zustand@4.4.0` | MIT | 生产 | LICENSE |
| 409 | `zwitch@2.0.4` | MIT | 生产 | license |

## 附录 B：npm 字段/原文需处置的 28 条明细

### B. 字段与原文不一致、或包内无许可原文的条目（28 条）

| 包 | package.json 字段 | 实际读到的原文 | 原文路径 | 处置 |
| --- | --- | --- | --- | --- |
| `@esbuild/win32-x64@0.28.2` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/@esbuild+win32-x64@0.28.2/node_modules/@esbuild/win32-x64） | 见正文 §3.3 |
| `@gera2ld/jsx-dom@2.2.2` | ISC | MIT | LICENSE（node_modules/.pnpm/@gera2ld+jsx-dom@2.2.2/node_modules/@gera2ld/jsx-dom） | 见正文 §3.3 |
| `@rollup/rollup-win32-x64-gnu@4.63.3` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/@rollup+rollup-win32-x64-gnu@4.63.3/node_modules/@rollup/rollup-win32-x64-gnu） | 见正文 §3.3 |
| `@rollup/rollup-win32-x64-msvc@4.63.3` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/@rollup+rollup-win32-x64-msvc@4.63.3/node_modules/@rollup/rollup-win32-x64-msvc） | 见正文 §3.3 |
| `@tauri-apps/cli-win32-x64-msvc@2.11.4` | Apache-2.0 | 原文无标准许可句 | README.md（node_modules/.pnpm/@tauri-apps+cli-win32-x64-msvc@2.11.4/node_modules/@tauri-apps/cli-win32-x64-msvc） | 见正文 §3.3 |
| `argparse@2.0.1` | Python-2.0 | GPL + Python-2.0 | LICENSE（node_modules/.pnpm/argparse@2.0.1/node_modules/argparse） | 见正文 §3.3 |
| `boolbase@1.0.0` | ISC | 原文无标准许可句 | README.md（node_modules/.pnpm/boolbase@1.0.0/node_modules/boolbase） | 见正文 §3.3 |
| `inline-style-parser@0.1.1` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/inline-style-parser@0.1.1/node_modules/inline-style-parser） | 见正文 §3.3 |
| `micromark@4.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/mdast-util-from-markdown@2.0.3/node_modules/micromark） | 见正文 §3.3 |
| `micromark-core-commonmark@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/micromark-core-commonmark@2.0.0/node_modules/micromark-core-commonmark） | 见正文 §3.3 |
| `micromark-factory-destination@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/micromark-core-commonmark@2.0.0/node_modules/micromark-factory-destination） | 见正文 §3.3 |
| `micromark-factory-label@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/micromark-core-commonmark@2.0.0/node_modules/micromark-factory-label） | 见正文 §3.3 |
| `micromark-factory-space@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/micromark-core-commonmark@2.0.0/node_modules/micromark-factory-space） | 见正文 §3.3 |
| `micromark-factory-title@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/micromark-core-commonmark@2.0.0/node_modules/micromark-factory-title） | 见正文 §3.3 |
| `micromark-factory-whitespace@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/micromark-core-commonmark@2.0.0/node_modules/micromark-factory-whitespace） | 见正文 §3.3 |
| `micromark-util-character@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/mdast-util-gfm-autolink-literal@2.0.1/node_modules/micromark-util-character） | 见正文 §3.3 |
| `micromark-util-chunked@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/micromark-core-commonmark@2.0.0/node_modules/micromark-util-chunked） | 见正文 §3.3 |
| `micromark-util-classify-character@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/micromark-core-commonmark@2.0.0/node_modules/micromark-util-classify-character） | 见正文 §3.3 |
| `micromark-util-combine-extensions@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/micromark-extension-gfm@3.0.0/node_modules/micromark-util-combine-extensions） | 见正文 §3.3 |
| `micromark-util-decode-numeric-character-reference@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/mdast-util-from-markdown@2.0.3/node_modules/micromark-util-decode-numeric-character-reference） | 见正文 §3.3 |
| `micromark-util-encode@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/micromark-util-encode@2.0.0/node_modules/micromark-util-encode） | 见正文 §3.3 |
| `micromark-util-html-tag-name@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/micromark-core-commonmark@2.0.0/node_modules/micromark-util-html-tag-name） | 见正文 §3.3 |
| `micromark-util-normalize-identifier@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/mdast-util-from-markdown@2.0.3/node_modules/micromark-util-normalize-identifier） | 见正文 §3.3 |
| `micromark-util-resolve-all@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/micromark-core-commonmark@2.0.0/node_modules/micromark-util-resolve-all） | 见正文 §3.3 |
| `micromark-util-sanitize-uri@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/mdast-util-to-hast@13.2.1/node_modules/micromark-util-sanitize-uri） | 见正文 §3.3 |
| `micromark-util-subtokenize@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/micromark-core-commonmark@2.0.0/node_modules/micromark-util-subtokenize） | 见正文 §3.3 |
| `micromark-util-symbol@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/mdast-util-from-markdown@2.0.3/node_modules/micromark-util-symbol） | 见正文 §3.3 |
| `micromark-util-types@2.0.0` | MIT | 原文无标准许可句 | README.md（node_modules/.pnpm/mdast-util-from-markdown@2.0.3/node_modules/micromark-util-types） | 见正文 §3.3 |

## 附录 C：ISC 清单（49 个）

### C. ISC 清单（49 个，允许但单独标注）

`@gera2ld/jsx-dom@2.2.2`、`@ungap/structured-clone@1.4.0`、`boolbase@1.0.0`、`d3@7.9.0`、`d3-array@3.2.4`、`d3-axis@3.0.0`、`d3-brush@3.0.0`、`d3-chord@3.0.1`、`d3-color@3.1.0`、`d3-contour@4.0.2`、`d3-delaunay@6.0.4`、`d3-dispatch@3.0.1`、`d3-drag@3.0.0`、`d3-dsv@3.0.1`、`d3-fetch@3.0.1`、`d3-force@3.0.0`、`d3-format@3.1.2`、`d3-geo@3.1.1`、`d3-hierarchy@3.1.2`、`d3-interpolate@3.0.1`、`d3-path@3.1.0`、`d3-polygon@3.0.1`、`d3-quadtree@3.0.1`、`d3-random@3.0.1`、`d3-scale@4.0.2`、`d3-scale-chromatic@3.1.0`、`d3-selection@3.0.0`、`d3-shape@3.2.0`、`d3-time@3.1.0`、`d3-time-format@4.1.0`、`d3-timer@3.0.1`、`d3-transition@3.0.1`、`d3-zoom@3.0.0`、`delaunator@5.1.0`、`electron-to-chromium@1.5.430`、`graceful-fs@4.2.11`、`inherits@2.0.4`、`internmap@2.0.3`、`isexe@2.0.0`、`lru-cache@5.1.1`、`once@1.4.0`、`picocolors@1.1.1`、`semver@6.3.1`、`setprototypeof@1.2.0`、`which@2.0.1`、`wrappy@1.0.2`、`yallist@3.1.1`、`yaml@2.9.1`、`zod-to-json-schema@3.25.2`

## 附录 D：BSD 清单（17 个）

### D. BSD 清单（17 个，BSD-2-Clause / BSD-3-Clause）

`cheerio-select@2.1.0`（BSD）、`css-select@5.1.0`（BSD）、`css-what@6.1.0`（BSD）、`d3-ease@3.0.1`（BSD）、`domelementtype@2.3.0`（BSD）、`domhandler@5.0.3`（BSD）、`domutils@3.1.0`（BSD）、`entities@4.3.0`（BSD）、`entities@4.4.0`（BSD）、`entities@4.5.0`（BSD）、`fast-uri@3.1.8`（BSD）、`highlight.js@11.12.0`（BSD）、`json-schema-typed@8.0.2`（BSD）、`nth-check@2.0.1`（BSD）、`qs@6.16.0`（BSD）、`rw@1.3.3`（BSD）、`source-map-js@1.2.1`（BSD）

## 附录 E：npm 直接依赖 28 条（声明 vs 实际安装）

### F. 直接依赖 28 条（package.json 声明 vs 实际安装）

| 直接依赖 | 声明 | 实际 | License | 原文路径 |
| --- | --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | ^1.30.0 | 1.30.0 | MIT | node_modules/.pnpm/@modelcontextprotocol+sdk@1.30.0_zod@4.6.5/node_modules/@modelcontextprotocol/sdk/LICENSE（dependencies） |
| `@tailwindcss/vite` | ^4.1.13 | 4.3.3 | MIT | node_modules/.pnpm/@tailwindcss+vite@4.3.3_vit_18c2efc21d24ab28ca9a9c8d47e70b1e/node_modules/@tailwindcss/vite/LICENSE（devDependencies） |
| `@tauri-apps/cli` | ^2.11.4 | 2.11.4 | Apache-2.0 | node_modules/.pnpm/@tauri-apps+cli@2.11.4/node_modules/@tauri-apps/cli/LICENSE_APACHE-2.0,LICENSE_MIT（devDependencies） |
| `@types/dagre` | ^0.7.54 | 0.7.54 | MIT | node_modules/.pnpm/@types+dagre@0.7.54/node_modules/@types/dagre/LICENSE（devDependencies） |
| `@types/node` | ^24.5.2 | 24.13.5 | MIT | node_modules/.pnpm/@types+node@24.13.5/node_modules/@types/node/LICENSE（devDependencies） |
| `@types/react` | ^18.3.12 | 18.3.31 | MIT | node_modules/.pnpm/@types+react-dom@18.3.1/node_modules/@types/react/LICENSE（devDependencies） |
| `@types/react-dom` | ^18.3.1 | 18.3.1 | MIT | node_modules/.pnpm/@types+react-dom@18.3.1/node_modules/@types/react-dom/LICENSE（devDependencies） |
| `@vitejs/plugin-react` | ^5.0.3 | 5.2.0 | MIT | node_modules/.pnpm/@vitejs+plugin-react@5.2.0__085ba611726ae74f203121ac00d1b415/node_modules/@vitejs/plugin-react/LICENSE（devDependencies） |
| `@xterm/addon-fit` | ^0.11.0 | 0.11.0 | MIT | node_modules/.pnpm/@xterm+addon-fit@0.11.0/node_modules/@xterm/addon-fit/LICENSE（dependencies） |
| `@xterm/xterm` | ^6.0.0 | 6.0.0 | MIT | node_modules/.pnpm/@xterm+xterm@6.0.0/node_modules/@xterm/xterm/LICENSE（dependencies） |
| `@xyflow/react` | ^12.11.6 | 12.11.6 | MIT | node_modules/.pnpm/@xyflow+react@12.11.6_@type_ea2aae3f3dadcc18b16b643ecf7b3e1f/node_modules/@xyflow/react/LICENSE（dependencies） |
| `chokidar` | ^5.0.0 | 5.0.0 | MIT | node_modules/.pnpm/chokidar@5.0.0/node_modules/chokidar/LICENSE（dependencies） |
| `dagre` | ^0.8.5 | 0.8.5 | MIT | node_modules/.pnpm/dagre@0.8.5/node_modules/dagre/LICENSE（dependencies） |
| `markmap-lib` | ^0.18.12 | 0.18.12 | MIT | node_modules/.pnpm/markmap-lib@0.18.12_markmap-common@0.18.9/node_modules/markmap-lib/LICENSE（dependencies） |
| `markmap-view` | ^0.18.12 | 0.18.12 | MIT | node_modules/.pnpm/markmap-lib@0.18.12_markmap-common@0.18.9/node_modules/markmap-view/LICENSE（dependencies） |
| `node-pty` | ^1.1.0 | 1.1.0 | MIT | node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/LICENSE（dependencies） |
| `react` | ^18.3.1 | 18.3.1 | MIT | node_modules/.pnpm/@xyflow+react@12.11.6_@type_ea2aae3f3dadcc18b16b643ecf7b3e1f/node_modules/react/LICENSE（dependencies） |
| `react-dom` | ^18.3.1 | 18.3.1 | MIT | node_modules/.pnpm/@xyflow+react@12.11.6_@type_ea2aae3f3dadcc18b16b643ecf7b3e1f/node_modules/react-dom/LICENSE（dependencies） |
| `react-markdown` | ^10.1.0 | 10.1.0 | MIT | node_modules/.pnpm/react-markdown@10.1.0_@types+react@18.3.31_react@18.3.1/node_modules/react-markdown/license（dependencies） |
| `remark-gfm` | ^4.0.1 | 4.0.1 | MIT | node_modules/.pnpm/remark-gfm@4.0.1/node_modules/remark-gfm/license（dependencies） |
| `streamdown` | ^2.6.0 | 2.6.0 | Apache-2.0 | node_modules/.pnpm/streamdown@2.6.0_react-dom@18.3.1_react@18.3.1__react@18.3.1/node_modules/streamdown/LICENSE（dependencies） |
| `tailwindcss` | ^4.1.13 | 4.3.3 | MIT | node_modules/.pnpm/@tailwindcss+node@4.3.3/node_modules/tailwindcss/LICENSE（devDependencies） |
| `tree-sitter` | ^0.25.1 | 0.25.1 | MIT | node_modules/.pnpm/tree-sitter-javascript@0.23.1_tree-sitter@0.25.1/node_modules/tree-sitter/LICENSE（dependencies） |
| `tree-sitter-python` | ^0.25.0 | 0.25.0 | MIT | node_modules/.pnpm/tree-sitter-python@0.25.0_tree-sitter@0.25.1/node_modules/tree-sitter-python/LICENSE（dependencies） |
| `tree-sitter-typescript` | ^0.23.2 | 0.23.2 | MIT | node_modules/.pnpm/tree-sitter-typescript@0.23.2_tree-sitter@0.25.1/node_modules/tree-sitter-typescript/LICENSE（dependencies） |
| `tsx` | ^4.20.5 | 4.23.13 | MIT | node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/LICENSE（devDependencies） |
| `typescript` | ^5.9.2 | 5.9.2 | Apache-2.0 | node_modules/.pnpm/typescript@5.9.2/node_modules/typescript/LICENSE.txt（devDependencies） |
| `vite` | ^7.1.6 | 7.3.6 | MIT | node_modules/.pnpm/@tailwindcss+vite@4.3.3_vit_18c2efc21d24ab28ca9a9c8d47e70b1e/node_modules/vite/LICENSE.md（devDependencies） |

## 附录 F：Rust crate 全量许可（Cargo.lock 430 条）

### G. Rust crate 全量许可（Cargo.lock 430 条，含传递依赖）

| # | crate | License | 进 Windows 壳 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | `adler2@2.0.1` | BSD | 是 | ~/.cargo/registry/src/index.crates.io-*/adler2-2.0.1 |
| 2 | `aho-corasick@1.1.5` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/aho-corasick-1.1.5 |
| 3 | `alloc-no-stdlib@2.0.4` | BSD | 是 | ~/.cargo/registry/src/index.crates.io-*/alloc-no-stdlib-2.0.4 |
| 4 | `alloc-stdlib@0.2.4` | BSD | 是 | ~/.cargo/registry/src/index.crates.io-*/alloc-stdlib-0.2.4 |
| 5 | `android_system_properties@0.1.6` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/android_system_properties-0.1.6 |
| 6 | `anyhow@1.0.104` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/anyhow-1.0.104 |
| 7 | `atk@0.18.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/atk-0.18.2 |
| 8 | `atk-sys@0.18.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/atk-sys-0.18.2 |
| 9 | `atomic-waker@1.1.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/atomic-waker-1.1.2 |
| 10 | `autocfg@1.5.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/autocfg-1.5.1 |
| 11 | `base64@0.21.7` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/base64-0.21.7 |
| 12 | `base64@0.22.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/base64-0.22.1 |
| 13 | `base64@0.23.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/base64-0.23.1 |
| 14 | `bit-set@0.8.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/bit-set-0.8.0 |
| 15 | `bit-vec@0.8.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/bit-vec-0.8.0 |
| 16 | `bitflags@1.3.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/bitflags-1.3.2 |
| 17 | `bitflags@2.13.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/bitflags-2.13.2 |
| 18 | `block-buffer@0.10.4` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/block-buffer-0.10.4 |
| 19 | `block2@0.6.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/block2-0.6.2 |
| 20 | `brotli@8.0.4` | BSD | 是 | ~/.cargo/registry/src/index.crates.io-*/brotli-8.0.4 |
| 21 | `brotli-decompressor@5.0.3` | BSD | 是 | ~/.cargo/registry/src/index.crates.io-*/brotli-decompressor-5.0.3 |
| 22 | `bs58@0.5.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/bs58-0.5.1 |
| 23 | `bumpalo@3.20.3` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/bumpalo-3.20.3 |
| 24 | `bytemuck@1.25.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/bytemuck-1.25.2 |
| 25 | `byteorder@1.5.0` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/byteorder-1.5.0 |
| 26 | `bytes@1.12.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/bytes-1.12.1 |
| 27 | `cairo-rs@0.18.5` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/cairo-rs-0.18.5 |
| 28 | `cairo-sys-rs@0.18.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/cairo-sys-rs-0.18.2 |
| 29 | `camino@1.2.6` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/camino-1.2.6 |
| 30 | `cargo-platform@0.1.9` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/cargo-platform-0.1.9 |
| 31 | `cargo_metadata@0.19.2` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/cargo_metadata-0.19.2 |
| 32 | `cargo_toml@0.22.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/cargo_toml-0.22.3 |
| 33 | `cc@1.4.6` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/cc-1.4.6 |
| 34 | `cesu8@1.1.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/cesu8-1.1.0 |
| 35 | `cfb@0.7.3` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/cfb-0.7.3 |
| 36 | `cfg-expr@0.15.8` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/cfg-expr-0.15.8 |
| 37 | `cfg-if@1.0.5` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/cfg-if-1.0.5 |
| 38 | `chrono@0.4.45` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/chrono-0.4.45 |
| 39 | `combine@4.6.8` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/combine-4.6.8 |
| 40 | `cookie@0.18.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/cookie-0.18.2 |
| 41 | `core-foundation@0.10.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/core-foundation-0.10.1 |
| 42 | `core-foundation-sys@0.8.7` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/core-foundation-sys-0.8.7 |
| 43 | `core-graphics@0.25.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/core-graphics-0.25.0 |
| 44 | `core-graphics-types@0.2.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/core-graphics-types-0.2.0 |
| 45 | `cpufeatures@0.2.17` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/cpufeatures-0.2.17 |
| 46 | `crc32fast@1.5.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/crc32fast-1.5.2 |
| 47 | `crossbeam-channel@0.5.17` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/crossbeam-channel-0.5.17 |
| 48 | `crossbeam-utils@0.8.23` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/crossbeam-utils-0.8.23 |
| 49 | `crypto-common@0.1.7` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/crypto-common-0.1.7 |
| 50 | `cssparser@0.36.0` | MPL-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/cssparser-0.36.0 |
| 51 | `cssparser-macros@0.6.1` | MPL-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/cssparser-macros-0.6.1 |
| 52 | `ctor@0.8.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/ctor-0.8.0 |
| 53 | `ctor-proc-macro@0.0.7` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/ctor-proc-macro-0.0.7 |
| 54 | `darling@0.24.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/darling-0.24.1 |
| 55 | `darling_core@0.24.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/darling_core-0.24.1 |
| 56 | `darling_macro@0.24.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/darling_macro-0.24.1 |
| 57 | `dbus@0.9.12` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/dbus-0.9.12 |
| 58 | `defmt@1.1.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/defmt-1.1.1 |
| 59 | `defmt-macros@1.1.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/defmt-macros-1.1.1 |
| 60 | `defmt-parser@1.0.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/defmt-parser-1.0.0 |
| 61 | `deranged@0.5.8` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/deranged-0.5.8 |
| 62 | `derive_more@2.1.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/derive_more-2.1.1 |
| 63 | `derive_more-impl@2.1.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/derive_more-impl-2.1.1 |
| 64 | `digest@0.10.7` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/digest-0.10.7 |
| 65 | `dirs@6.0.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/dirs-6.0.0 |
| 66 | `dirs-sys@0.5.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/dirs-sys-0.5.0 |
| 67 | `dispatch2@0.3.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/dispatch2-0.3.1 |
| 68 | `displaydoc@0.2.7` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/displaydoc-0.2.7 |
| 69 | `dlopen2@0.8.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/dlopen2-0.8.2 |
| 70 | `dlopen2_derive@0.4.3` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/dlopen2_derive-0.4.3 |
| 71 | `dom_query@0.27.0` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/dom_query-0.27.0 |
| 72 | `dpi@0.1.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/dpi-0.1.2 |
| 73 | `dtoa@1.0.11` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/dtoa-1.0.11 |
| 74 | `dtoa-short@0.3.5` | MPL-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/dtoa-short-0.3.5 |
| 75 | `dtor@0.3.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/dtor-0.3.0 |
| 76 | `dtor-proc-macro@0.0.6` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/dtor-proc-macro-0.0.6 |
| 77 | `dunce@1.0.5` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/dunce-1.0.5 |
| 78 | `dyn-clone@1.0.20` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/dyn-clone-1.0.20 |
| 79 | `embed-resource@3.0.11` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/embed-resource-3.0.11 |
| 80 | `embed_plist@1.2.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/embed_plist-1.2.2 |
| 81 | `equivalent@1.0.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/equivalent-1.0.2 |
| 82 | `erased-serde@0.4.10` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/erased-serde-0.4.10 |
| 83 | `fastrand@2.5.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/fastrand-2.5.0 |
| 84 | `fdeflate@0.3.7` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/fdeflate-0.3.7 |
| 85 | `field-offset@0.3.6` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/field-offset-0.3.6 |
| 86 | `find-msvc-tools@0.1.12` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/find-msvc-tools-0.1.12 |
| 87 | `flate2@1.1.10` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/flate2-1.1.10 |
| 88 | `fnv@1.0.7` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/fnv-1.0.7 |
| 89 | `foldhash@0.2.0` | Zlib | 是 | ~/.cargo/registry/src/index.crates.io-*/foldhash-0.2.0 |
| 90 | `foreign-types@0.5.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/foreign-types-0.5.0 |
| 91 | `foreign-types-macros@0.2.4` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/foreign-types-macros-0.2.4 |
| 92 | `foreign-types-shared@0.3.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/foreign-types-shared-0.3.1 |
| 93 | `form_urlencoded@1.2.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/form_urlencoded-1.2.2 |
| 94 | `futures-channel@0.3.34` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/futures-channel-0.3.34 |
| 95 | `futures-core@0.3.34` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/futures-core-0.3.34 |
| 96 | `futures-executor@0.3.34` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/futures-executor-0.3.34 |
| 97 | `futures-io@0.3.34` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/futures-io-0.3.34 |
| 98 | `futures-macro@0.3.34` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/futures-macro-0.3.34 |
| 99 | `futures-sink@0.3.34` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/futures-sink-0.3.34 |
| 100 | `futures-task@0.3.34` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/futures-task-0.3.34 |
| 101 | `futures-util@0.3.34` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/futures-util-0.3.34 |
| 102 | `gdk@0.18.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/gdk-0.18.2 |
| 103 | `gdk-pixbuf@0.18.5` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/gdk-pixbuf-0.18.5 |
| 104 | `gdk-pixbuf-sys@0.18.0` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/gdk-pixbuf-sys-0.18.0 |
| 105 | `gdk-sys@0.18.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/gdk-sys-0.18.2 |
| 106 | `gdkwayland-sys@0.18.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/gdkwayland-sys-0.18.2 |
| 107 | `gdkx11@0.18.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/gdkx11-0.18.2 |
| 108 | `gdkx11-sys@0.18.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/gdkx11-sys-0.18.2 |
| 109 | `generic-array@0.14.7` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/generic-array-0.14.7 |
| 110 | `getrandom@0.3.4` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/getrandom-0.3.4 |
| 111 | `getrandom@0.4.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/getrandom-0.4.3 |
| 112 | `gio@0.18.4` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/gio-0.18.4 |
| 113 | `gio-sys@0.18.1` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/gio-sys-0.18.1 |
| 114 | `glib@0.18.5` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/glib-0.18.5 |
| 115 | `glib-macros@0.18.5` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/glib-macros-0.18.5 |
| 116 | `glib-sys@0.18.1` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/glib-sys-0.18.1 |
| 117 | `glob@0.3.4` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/glob-0.3.4 |
| 118 | `gobject-sys@0.18.0` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/gobject-sys-0.18.0 |
| 119 | `gtk@0.18.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/gtk-0.18.2 |
| 120 | `gtk-sys@0.18.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/gtk-sys-0.18.2 |
| 121 | `gtk3-macros@0.18.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/gtk3-macros-0.18.2 |
| 122 | `hashbrown@0.12.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/hashbrown-0.12.3 |
| 123 | `hashbrown@0.17.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/hashbrown-0.17.1 |
| 124 | `heck@0.4.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/heck-0.4.1 |
| 125 | `heck@0.5.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/heck-0.5.0 |
| 126 | `hex@0.4.3` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/hex-0.4.3 |
| 127 | `html5ever@0.38.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/html5ever-0.38.0 |
| 128 | `http@1.5.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/http-1.5.0 |
| 129 | `http-body@1.1.0` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/http-body-1.1.0 |
| 130 | `http-body-util@0.1.5` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/http-body-util-0.1.5 |
| 131 | `httparse@1.10.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/httparse-1.10.1 |
| 132 | `hyper@1.11.1` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/hyper-1.11.1 |
| 133 | `hyper-util@0.1.20` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/hyper-util-0.1.20 |
| 134 | `iana-time-zone@0.1.65` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/iana-time-zone-0.1.65 |
| 135 | `iana-time-zone-haiku@0.1.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/iana-time-zone-haiku-0.1.2 |
| 136 | `ico@0.5.0` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/ico-0.5.0 |
| 137 | `icu_collections@2.3.0` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/icu_collections-2.3.0 |
| 138 | `icu_locale_core@2.3.0` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/icu_locale_core-2.3.0 |
| 139 | `icu_normalizer@2.3.0` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/icu_normalizer-2.3.0 |
| 140 | `icu_normalizer_data@2.3.0` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/icu_normalizer_data-2.3.0 |
| 141 | `icu_properties@2.3.0` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/icu_properties-2.3.0 |
| 142 | `icu_properties_data@2.3.0` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/icu_properties_data-2.3.0 |
| 143 | `icu_provider@2.3.1` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/icu_provider-2.3.1 |
| 144 | `ident_case@1.0.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/ident_case-1.0.1 |
| 145 | `idna@1.1.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/idna-1.1.0 |
| 146 | `idna_adapter@1.2.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/idna_adapter-1.2.2 |
| 147 | `indexmap@1.9.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/indexmap-1.9.3 |
| 148 | `indexmap@2.14.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/indexmap-2.14.2 |
| 149 | `infer@0.19.0` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/infer-0.19.0 |
| 150 | `ipnet@2.12.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/ipnet-2.12.2 |
| 151 | `itoa@1.0.18` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/itoa-1.0.18 |
| 152 | `javascriptcore-rs@1.1.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/javascriptcore-rs-1.1.2 |
| 153 | `javascriptcore-rs-sys@1.1.1` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/javascriptcore-rs-sys-1.1.1 |
| 154 | `jiff@0.2.37` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/jiff-0.2.37 |
| 155 | `jiff-core@0.1.1` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/jiff-core-0.1.1 |
| 156 | `jiff-static@0.2.37` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/jiff-static-0.2.37 |
| 157 | `jiff-tzdb@0.1.8` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/jiff-tzdb-0.1.8 |
| 158 | `jiff-tzdb-platform@0.1.3` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/jiff-tzdb-platform-0.1.3 |
| 159 | `jni@0.21.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/jni-0.21.1 |
| 160 | `jni-sys@0.3.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/jni-sys-0.3.1 |
| 161 | `jni-sys@0.4.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/jni-sys-0.4.1 |
| 162 | `jni-sys-macros@0.4.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/jni-sys-macros-0.4.1 |
| 163 | `js-sys@0.3.105` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/js-sys-0.3.105 |
| 164 | `json-patch@3.0.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/json-patch-3.0.1 |
| 165 | `jsonptr@0.6.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/jsonptr-0.6.3 |
| 166 | `keyboard-types@0.7.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/keyboard-types-0.7.0 |
| 167 | `libappindicator@0.9.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/libappindicator-0.9.0 |
| 168 | `libappindicator-sys@0.9.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/libappindicator-sys-0.9.0 |
| 169 | `libc@0.2.189` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/libc-0.2.189 |
| 170 | `libdbus-sys@0.2.7` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/libdbus-sys-0.2.7 |
| 171 | `libloading@0.7.4` | ISC | 否 | ~/.cargo/registry/src/index.crates.io-*/libloading-0.7.4 |
| 172 | `libredox@0.1.24` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/libredox-0.1.24 |
| 173 | `litemap@0.8.3` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/litemap-0.8.3 |
| 174 | `lock_api@0.4.14` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/lock_api-0.4.14 |
| 175 | `log@0.4.34` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/log-0.4.34 |
| 176 | `markup5ever@0.38.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/markup5ever-0.38.0 |
| 177 | `memchr@2.8.3` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/memchr-2.8.3 |
| 178 | `memoffset@0.9.1` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/memoffset-0.9.1 |
| 179 | `mime@0.3.17` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/mime-0.3.17 |
| 180 | `miniz_oxide@0.8.9` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/miniz_oxide-0.8.9 |
| 181 | `miniz_oxide@0.9.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/miniz_oxide-0.9.1 |
| 182 | `mio@1.2.3` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/mio-1.2.3 |
| 183 | `muda@0.19.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/muda-0.19.3 |
| 184 | `ndk@0.9.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/ndk-0.9.0 |
| 185 | `ndk-sys@0.6.0+11769913` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/ndk-sys-0.6.0+11769913 |
| 186 | `new_debug_unreachable@1.0.6` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/new_debug_unreachable-1.0.6 |
| 187 | `num-conv@0.2.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/num-conv-0.2.2 |
| 188 | `num-traits@0.2.19` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/num-traits-0.2.19 |
| 189 | `num_enum@0.7.6` | BSD | 否 | ~/.cargo/registry/src/index.crates.io-*/num_enum-0.7.6 |
| 190 | `num_enum_derive@0.7.6` | BSD | 否 | ~/.cargo/registry/src/index.crates.io-*/num_enum_derive-0.7.6 |
| 191 | `objc2@0.6.4` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-0.6.4 |
| 192 | `objc2-app-kit@0.3.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-app-kit-0.3.2 |
| 193 | `objc2-cloud-kit@0.3.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-cloud-kit-0.3.2 |
| 194 | `objc2-core-data@0.3.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-core-data-0.3.2 |
| 195 | `objc2-core-foundation@0.3.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-core-foundation-0.3.2 |
| 196 | `objc2-core-graphics@0.3.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-core-graphics-0.3.2 |
| 197 | `objc2-core-image@0.3.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-core-image-0.3.2 |
| 198 | `objc2-core-location@0.3.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-core-location-0.3.2 |
| 199 | `objc2-core-text@0.3.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-core-text-0.3.2 |
| 200 | `objc2-encode@4.1.0` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-encode-4.1.0 |
| 201 | `objc2-exception-helper@0.1.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-exception-helper-0.1.1 |
| 202 | `objc2-foundation@0.3.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-foundation-0.3.2 |
| 203 | `objc2-io-surface@0.3.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-io-surface-0.3.2 |
| 204 | `objc2-quartz-core@0.3.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-quartz-core-0.3.2 |
| 205 | `objc2-ui-kit@0.3.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-ui-kit-0.3.2 |
| 206 | `objc2-user-notifications@0.3.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-user-notifications-0.3.2 |
| 207 | `objc2-web-kit@0.3.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/objc2-web-kit-0.3.2 |
| 208 | `once_cell@1.21.4` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/once_cell-1.21.4 |
| 209 | `option-ext@0.2.0` | MPL-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/option-ext-0.2.0 |
| 210 | `pango@0.18.3` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/pango-0.18.3 |
| 211 | `pango-sys@0.18.0` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/pango-sys-0.18.0 |
| 212 | `parking_lot@0.12.5` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/parking_lot-0.12.5 |
| 213 | `parking_lot_core@0.9.12` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/parking_lot_core-0.9.12 |
| 214 | `percent-encoding@2.3.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/percent-encoding-2.3.2 |
| 215 | `phf@0.13.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/phf-0.13.1 |
| 216 | `phf_codegen@0.13.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/phf_codegen-0.13.1 |
| 217 | `phf_generator@0.13.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/phf_generator-0.13.1 |
| 218 | `phf_macros@0.13.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/phf_macros-0.13.1 |
| 219 | `phf_shared@0.13.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/phf_shared-0.13.1 |
| 220 | `pin-project-lite@0.2.17` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/pin-project-lite-0.2.17 |
| 221 | `pkg-config@0.3.34` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/pkg-config-0.3.34 |
| 222 | `plist@1.10.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/plist-1.10.1 |
| 223 | `png@0.17.16` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/png-0.17.16 |
| 224 | `png@0.18.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/png-0.18.1 |
| 225 | `portable-atomic@1.15.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/portable-atomic-1.15.0 |
| 226 | `portable-atomic-util@0.2.8` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/portable-atomic-util-0.2.8 |
| 227 | `potential_utf@0.1.6` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/potential_utf-0.1.6 |
| 228 | `powerfmt@0.2.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/powerfmt-0.2.0 |
| 229 | `precomputed-hash@0.1.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/precomputed-hash-0.1.1 |
| 230 | `proc-macro-crate@1.3.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/proc-macro-crate-1.3.1 |
| 231 | `proc-macro-crate@2.0.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/proc-macro-crate-2.0.2 |
| 232 | `proc-macro-crate@3.5.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/proc-macro-crate-3.5.0 |
| 233 | `proc-macro-error@1.0.4` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/proc-macro-error-1.0.4 |
| 234 | `proc-macro-error-attr@1.0.4` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/proc-macro-error-attr-1.0.4 |
| 235 | `proc-macro2@1.0.107` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/proc-macro2-1.0.107 |
| 236 | `quick-xml@0.42.0` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/quick-xml-0.42.0 |
| 237 | `quote@1.0.47` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/quote-1.0.47 |
| 238 | `r-efi@5.3.0` | LGPL-2.1-or-later（可选，OR 关系） | 否 | ~/.cargo/registry/src/index.crates.io-*/r-efi-5.3.0 |
| 239 | `r-efi@6.0.0` | LGPL-2.1-or-later（可选，OR 关系） | 否 | ~/.cargo/registry/src/index.crates.io-*/r-efi-6.0.0 |
| 240 | `raw-window-handle@0.6.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/raw-window-handle-0.6.2 |
| 241 | `redox_syscall@0.5.18` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/redox_syscall-0.5.18 |
| 242 | `redox_users@0.5.3` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/redox_users-0.5.3 |
| 243 | `ref-cast@1.0.27` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/ref-cast-1.0.27 |
| 244 | `ref-cast-impl@1.0.27` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/ref-cast-impl-1.0.27 |
| 245 | `regex@1.13.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/regex-1.13.1 |
| 246 | `regex-automata@0.4.18` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/regex-automata-0.4.18 |
| 247 | `regex-syntax@0.8.11` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/regex-syntax-0.8.11 |
| 248 | `reqwest@0.13.5` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/reqwest-0.13.5 |
| 249 | `rustc-hash@2.1.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/rustc-hash-2.1.3 |
| 250 | `rustc_version@0.4.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/rustc_version-0.4.1 |
| 251 | `rustversion@1.0.23` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/rustversion-1.0.23 |
| 252 | `same-file@1.0.6` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/same-file-1.0.6 |
| 253 | `schemars@0.8.22` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/schemars-0.8.22 |
| 254 | `schemars@0.9.0` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/schemars-0.9.0 |
| 255 | `schemars@1.2.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/schemars-1.2.2 |
| 256 | `schemars_derive@0.8.22` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/schemars_derive-0.8.22 |
| 257 | `scopeguard@1.2.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/scopeguard-1.2.0 |
| 258 | `selectors@0.36.1` | MPL-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/selectors-0.36.1 |
| 259 | `semver@1.0.28` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/semver-1.0.28 |
| 260 | `serde@1.0.229` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/serde-1.0.229 |
| 261 | `serde-untagged@0.1.9` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/serde-untagged-0.1.9 |
| 262 | `serde_core@1.0.229` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/serde_core-1.0.229 |
| 263 | `serde_derive@1.0.229` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/serde_derive-1.0.229 |
| 264 | `serde_derive_internals@0.29.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/serde_derive_internals-0.29.1 |
| 265 | `serde_json@1.0.151` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/serde_json-1.0.151 |
| 266 | `serde_repr@0.1.21` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/serde_repr-0.1.21 |
| 267 | `serde_spanned@0.6.9` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/serde_spanned-0.6.9 |
| 268 | `serde_spanned@1.1.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/serde_spanned-1.1.1 |
| 269 | `serde_with@3.23.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/serde_with-3.23.0 |
| 270 | `serde_with_macros@3.23.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/serde_with_macros-3.23.0 |
| 271 | `serialize-to-javascript@0.1.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/serialize-to-javascript-0.1.2 |
| 272 | `serialize-to-javascript-impl@0.1.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/serialize-to-javascript-impl-0.1.2 |
| 273 | `servo_arc@0.4.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/servo_arc-0.4.3 |
| 274 | `sha2@0.10.9` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/sha2-0.10.9 |
| 275 | `shlex@2.0.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/shlex-2.0.1 |
| 276 | `simd-adler32@0.3.10` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/simd-adler32-0.3.10 |
| 277 | `siphasher@1.0.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/siphasher-1.0.3 |
| 278 | `slab@0.4.12` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/slab-0.4.12 |
| 279 | `smallvec@1.16.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/smallvec-1.16.1 |
| 280 | `socket2@0.6.5` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/socket2-0.6.5 |
| 281 | `softbuffer@0.4.8` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/softbuffer-0.4.8 |
| 282 | `soup3@0.5.0` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/soup3-0.5.0 |
| 283 | `soup3-sys@0.5.0` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/soup3-sys-0.5.0 |
| 284 | `stable_deref_trait@1.2.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/stable_deref_trait-1.2.1 |
| 285 | `string_cache@0.9.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/string_cache-0.9.0 |
| 286 | `string_cache_codegen@0.6.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/string_cache_codegen-0.6.1 |
| 287 | `strsim@0.11.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/strsim-0.11.1 |
| 288 | `swift-rs@1.0.8` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/swift-rs-1.0.8 |
| 289 | `syn@1.0.109` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/syn-1.0.109 |
| 290 | `syn@2.0.119` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/syn-2.0.119 |
| 291 | `syn@3.0.6` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/syn-3.0.6 |
| 292 | `sync_wrapper@1.0.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/sync_wrapper-1.0.2 |
| 293 | `synstructure@0.14.0` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/synstructure-0.14.0 |
| 294 | `system-deps@6.2.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/system-deps-6.2.2 |
| 295 | `tao@0.35.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/tao-0.35.3 |
| 296 | `tao-macros@0.1.4` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/tao-macros-0.1.4 |
| 297 | `target-lexicon@0.12.16` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/target-lexicon-0.12.16 |
| 298 | `tatai@0.1.0` | MIT | 否 | crates.io API 元数据 |
| 299 | `tauri@2.11.5` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/tauri-2.11.5 |
| 300 | `tauri-build@2.6.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/tauri-build-2.6.3 |
| 301 | `tauri-codegen@2.6.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/tauri-codegen-2.6.3 |
| 302 | `tauri-macros@2.6.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/tauri-macros-2.6.3 |
| 303 | `tauri-runtime@2.11.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/tauri-runtime-2.11.3 |
| 304 | `tauri-runtime-wry@2.11.4` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/tauri-runtime-wry-2.11.4 |
| 305 | `tauri-utils@2.9.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/tauri-utils-2.9.3 |
| 306 | `tauri-winres@0.3.6` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/tauri-winres-0.3.6 |
| 307 | `tendril@0.5.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/tendril-0.5.1 |
| 308 | `thiserror@1.0.69` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/thiserror-1.0.69 |
| 309 | `thiserror@2.0.20` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/thiserror-2.0.20 |
| 310 | `thiserror-impl@1.0.69` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/thiserror-impl-1.0.69 |
| 311 | `thiserror-impl@2.0.20` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/thiserror-impl-2.0.20 |
| 312 | `time@0.3.55` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/time-0.3.55 |
| 313 | `time-core@0.1.9` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/time-core-0.1.9 |
| 314 | `time-macros@0.2.32` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/time-macros-0.2.32 |
| 315 | `tinystr@0.8.4` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/tinystr-0.8.4 |
| 316 | `tinyvec@1.13.3` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/tinyvec-1.13.3 |
| 317 | `tokio@1.53.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/tokio-1.53.1 |
| 318 | `tokio-util@0.7.19` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/tokio-util-0.7.19 |
| 319 | `toml@0.8.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/toml-0.8.2 |
| 320 | `toml@0.9.12+spec-1.1.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/toml-0.9.12+spec-1.1.0 |
| 321 | `toml@1.1.6+spec-1.1.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/toml-1.1.6+spec-1.1.0 |
| 322 | `toml_datetime@0.6.3` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/toml_datetime-0.6.3 |
| 323 | `toml_datetime@0.7.5+spec-1.1.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/toml_datetime-0.7.5+spec-1.1.0 |
| 324 | `toml_datetime@1.1.1+spec-1.1.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/toml_datetime-1.1.1+spec-1.1.0 |
| 325 | `toml_edit@0.19.15` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/toml_edit-0.19.15 |
| 326 | `toml_edit@0.20.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/toml_edit-0.20.2 |
| 327 | `toml_edit@0.25.15+spec-1.1.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/toml_edit-0.25.15+spec-1.1.0 |
| 328 | `toml_parser@1.1.3+spec-1.1.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/toml_parser-1.1.3+spec-1.1.0 |
| 329 | `toml_writer@1.1.2+spec-1.1.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/toml_writer-1.1.2+spec-1.1.0 |
| 330 | `tower@0.5.3` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/tower-0.5.3 |
| 331 | `tower-http@0.6.11` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/tower-http-0.6.11 |
| 332 | `tower-layer@0.3.3` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/tower-layer-0.3.3 |
| 333 | `tower-service@0.3.3` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/tower-service-0.3.3 |
| 334 | `tracing@0.1.44` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/tracing-0.1.44 |
| 335 | `tracing-core@0.1.36` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/tracing-core-0.1.36 |
| 336 | `tray-icon@0.24.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/tray-icon-0.24.2 |
| 337 | `try-lock@0.2.5` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/try-lock-0.2.5 |
| 338 | `typeid@1.0.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/typeid-1.0.3 |
| 339 | `typenum@1.20.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/typenum-1.20.1 |
| 340 | `unic-char-property@0.9.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/unic-char-property-0.9.0 |
| 341 | `unic-char-range@0.9.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/unic-char-range-0.9.0 |
| 342 | `unic-common@0.9.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/unic-common-0.9.0 |
| 343 | `unic-ucd-ident@0.9.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/unic-ucd-ident-0.9.0 |
| 344 | `unic-ucd-version@0.9.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/unic-ucd-version-0.9.0 |
| 345 | `unicode-ident@1.0.26` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/unicode-ident-1.0.26 |
| 346 | `unicode-segmentation@1.13.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/unicode-segmentation-1.13.3 |
| 347 | `url@2.5.8` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/url-2.5.8 |
| 348 | `urlpattern@0.3.0` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/urlpattern-0.3.0 |
| 349 | `utf8_iter@1.0.4` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/utf8_iter-1.0.4 |
| 350 | `uuid@1.26.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/uuid-1.26.1 |
| 351 | `version-compare@0.2.1` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/version-compare-0.2.1 |
| 352 | `version_check@0.9.5` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/version_check-0.9.5 |
| 353 | `vswhom@0.1.0` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/vswhom-0.1.0 |
| 354 | `vswhom-sys@0.1.3` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/vswhom-sys-0.1.3 |
| 355 | `walkdir@2.5.0` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/walkdir-2.5.0 |
| 356 | `want@0.3.1` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/want-0.3.1 |
| 357 | `wasi@0.11.1+wasi-snapshot-preview1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/wasi-0.11.1+wasi-snapshot-preview1 |
| 358 | `wasip2@1.0.4+wasi-0.2.12` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/wasip2-1.0.4+wasi-0.2.12 |
| 359 | `wasm-bindgen@0.2.128` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/wasm-bindgen-0.2.128 |
| 360 | `wasm-bindgen-futures@0.4.78` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/wasm-bindgen-futures-0.4.78 |
| 361 | `wasm-bindgen-macro@0.2.128` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/wasm-bindgen-macro-0.2.128 |
| 362 | `wasm-bindgen-macro-support@0.2.128` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/wasm-bindgen-macro-support-0.2.128 |
| 363 | `wasm-bindgen-shared@0.2.128` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/wasm-bindgen-shared-0.2.128 |
| 364 | `wasm-streams@0.5.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/wasm-streams-0.5.0 |
| 365 | `web-sys@0.3.105` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/web-sys-0.3.105 |
| 366 | `web_atoms@0.2.6` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/web_atoms-0.2.6 |
| 367 | `webkit2gtk@2.0.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/webkit2gtk-2.0.2 |
| 368 | `webkit2gtk-sys@2.0.2` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/webkit2gtk-sys-2.0.2 |
| 369 | `webview2-com@0.38.2` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/webview2-com-0.38.2 |
| 370 | `webview2-com-macros@0.8.1` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/webview2-com-macros-0.8.1 |
| 371 | `webview2-com-sys@0.38.2` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/webview2-com-sys-0.38.2 |
| 372 | `winapi@0.3.9` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/winapi-0.3.9 |
| 373 | `winapi-i686-pc-windows-gnu@0.4.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/winapi-i686-pc-windows-gnu-0.4.0 |
| 374 | `winapi-util@0.1.11` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/winapi-util-0.1.11 |
| 375 | `winapi-x86_64-pc-windows-gnu@0.4.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/winapi-x86_64-pc-windows-gnu-0.4.0 |
| 376 | `window-vibrancy@0.6.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/window-vibrancy-0.6.0 |
| 377 | `windows@0.61.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-0.61.3 |
| 378 | `windows-collections@0.2.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-collections-0.2.0 |
| 379 | `windows-core@0.61.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-core-0.61.2 |
| 380 | `windows-core@0.62.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows-core-0.62.2 |
| 381 | `windows-future@0.2.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-future-0.2.1 |
| 382 | `windows-implement@0.60.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-implement-0.60.2 |
| 383 | `windows-interface@0.59.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-interface-0.59.3 |
| 384 | `windows-link@0.1.3` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-link-0.1.3 |
| 385 | `windows-link@0.2.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-link-0.2.1 |
| 386 | `windows-numerics@0.2.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-numerics-0.2.0 |
| 387 | `windows-result@0.3.4` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-result-0.3.4 |
| 388 | `windows-result@0.4.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows-result-0.4.1 |
| 389 | `windows-strings@0.4.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-strings-0.4.2 |
| 390 | `windows-strings@0.5.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows-strings-0.5.1 |
| 391 | `windows-sys@0.45.0` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows-sys-0.45.0 |
| 392 | `windows-sys@0.59.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-sys-0.59.0 |
| 393 | `windows-sys@0.61.2` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-sys-0.61.2 |
| 394 | `windows-targets@0.42.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows-targets-0.42.2 |
| 395 | `windows-targets@0.52.6` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-targets-0.52.6 |
| 396 | `windows-threading@0.1.0` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-threading-0.1.0 |
| 397 | `windows-version@0.1.7` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows-version-0.1.7 |
| 398 | `windows_aarch64_gnullvm@0.42.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows_aarch64_gnullvm-0.42.2 |
| 399 | `windows_aarch64_gnullvm@0.52.6` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows_aarch64_gnullvm-0.52.6 |
| 400 | `windows_aarch64_msvc@0.42.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows_aarch64_msvc-0.42.2 |
| 401 | `windows_aarch64_msvc@0.52.6` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows_aarch64_msvc-0.52.6 |
| 402 | `windows_i686_gnu@0.42.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows_i686_gnu-0.42.2 |
| 403 | `windows_i686_gnu@0.52.6` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows_i686_gnu-0.52.6 |
| 404 | `windows_i686_gnullvm@0.52.6` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows_i686_gnullvm-0.52.6 |
| 405 | `windows_i686_msvc@0.42.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows_i686_msvc-0.42.2 |
| 406 | `windows_i686_msvc@0.52.6` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows_i686_msvc-0.52.6 |
| 407 | `windows_x86_64_gnu@0.42.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows_x86_64_gnu-0.42.2 |
| 408 | `windows_x86_64_gnu@0.52.6` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/windows_x86_64_gnu-0.52.6 |
| 409 | `windows_x86_64_gnullvm@0.42.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows_x86_64_gnullvm-0.42.2 |
| 410 | `windows_x86_64_gnullvm@0.52.6` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows_x86_64_gnullvm-0.52.6 |
| 411 | `windows_x86_64_msvc@0.42.2` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows_x86_64_msvc-0.42.2 |
| 412 | `windows_x86_64_msvc@0.52.6` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/windows_x86_64_msvc-0.52.6 |
| 413 | `winnow@0.5.40` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/winnow-0.5.40 |
| 414 | `winnow@0.7.15` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/winnow-0.7.15 |
| 415 | `winnow@1.0.4` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/winnow-1.0.4 |
| 416 | `winreg@0.55.0` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/winreg-0.55.0 |
| 417 | `wit-bindgen@0.57.1` | Apache-2.0 | 否 | ~/.cargo/registry/src/index.crates.io-*/wit-bindgen-0.57.1 |
| 418 | `writeable@0.6.4` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/writeable-0.6.4 |
| 419 | `wry@0.55.1` | Apache-2.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/wry-0.55.1 |
| 420 | `x11@2.21.0` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/x11-2.21.0 |
| 421 | `x11-dl@2.21.0` | MIT | 否 | ~/.cargo/registry/src/index.crates.io-*/x11-dl-2.21.0 |
| 422 | `yoke@0.8.3` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/yoke-0.8.3 |
| 423 | `yoke-derive@0.8.3` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/yoke-derive-0.8.3 |
| 424 | `zerofrom@0.1.8` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/zerofrom-0.1.8 |
| 425 | `zerofrom-derive@0.1.8` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/zerofrom-derive-0.1.8 |
| 426 | `zerotrie@0.2.5` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/zerotrie-0.2.5 |
| 427 | `zerovec@0.11.8` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/zerovec-0.11.8 |
| 428 | `zerovec-derive@0.11.6` | Unicode-3.0 | 是 | ~/.cargo/registry/src/index.crates.io-*/zerovec-derive-0.11.6 |
| 429 | `zlib-rs@0.6.8` | Zlib | 否 | ~/.cargo/registry/src/index.crates.io-*/zlib-rs-0.6.8 |
| 430 | `zmij@1.0.23` | MIT | 是 | ~/.cargo/registry/src/index.crates.io-*/zmij-1.0.23 |

## 附录 G：Rust 侧超出白名单的 crate

> 下表 28 条 = Cargo.lock 430 条里 **不在 MIT / Apache / BSD / ISC 之内**的全部；另有 1 个 ISC（`libloading@0.7.4`，原文 `…/libloading-0.7.4/LICENSE`）按同族允许不列入，它在附录 F 里标为 `ISC`。

### H. Rust 侧超出白名单的 crate

| crate | License | 进壳 | 原文路径 |
| --- | --- | --- | --- |
| `cssparser@0.36.0` | "MPL-2.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/cssparser-0.36.0 |
| `cssparser-macros@0.6.1` | "MPL-2.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/cssparser-macros-0.6.1 |
| `dtoa-short@0.3.5` | "MPL-2.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/dtoa-short-0.3.5 |
| `foldhash@0.2.0` | "Zlib" | 是 | ~/.cargo/registry/src/index.crates.io-*/foldhash-0.2.0 |
| `icu_collections@2.3.0` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/icu_collections-2.3.0 |
| `icu_locale_core@2.3.0` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/icu_locale_core-2.3.0 |
| `icu_normalizer@2.3.0` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/icu_normalizer-2.3.0 |
| `icu_normalizer_data@2.3.0` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/icu_normalizer_data-2.3.0 |
| `icu_properties@2.3.0` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/icu_properties-2.3.0 |
| `icu_properties_data@2.3.0` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/icu_properties_data-2.3.0 |
| `icu_provider@2.3.1` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/icu_provider-2.3.1 |
| `litemap@0.8.3` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/litemap-0.8.3 |
| `option-ext@0.2.0` | "MPL-2.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/option-ext-0.2.0 |
| `potential_utf@0.1.6` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/potential_utf-0.1.6 |
| `r-efi@5.3.0` | "MIT OR Apache-2.0 OR LGPL-2.1-or-later" | 否 | ~/.cargo/registry/src/index.crates.io-*/r-efi-5.3.0 |
| `r-efi@6.0.0` | "MIT OR Apache-2.0 OR LGPL-2.1-or-later" | 否 | ~/.cargo/registry/src/index.crates.io-*/r-efi-6.0.0 |
| `selectors@0.36.1` | "MPL-2.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/selectors-0.36.1 |
| `tinystr@0.8.4` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/tinystr-0.8.4 |
| `unicode-ident@1.0.26` | "(MIT OR Apache-2.0) AND Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/unicode-ident-1.0.26 |
| `writeable@0.6.4` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/writeable-0.6.4 |
| `yoke@0.8.3` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/yoke-0.8.3 |
| `yoke-derive@0.8.3` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/yoke-derive-0.8.3 |
| `zerofrom@0.1.8` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/zerofrom-0.1.8 |
| `zerofrom-derive@0.1.8` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/zerofrom-derive-0.1.8 |
| `zerotrie@0.2.5` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/zerotrie-0.2.5 |
| `zerovec@0.11.8` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/zerovec-0.11.8 |
| `zerovec-derive@0.11.6` | "Unicode-3.0" | 是 | ~/.cargo/registry/src/index.crates.io-*/zerovec-derive-0.11.6 |
| `zlib-rs@0.6.8` | "Zlib" | 否 | ~/.cargo/registry/src/index.crates.io-*/zlib-rs-0.6.8 |

---

## 附：第二轮审计补票新增依赖补记（2026-09-19，L1 快照之后的增量）

> 本文件 §1–§7 的清单数字（npm 409 / crate 430）是 2026-09-18 L1 快照。2026-09-19 第二轮审计终审补票 Q224（站外链接调系统浏览器打开，`audit/R2/03-问题汇总分级.md` 乙区）新增 opener 插件依赖两条，许可证原文已核对（均符 `AGENTS.md` §6 白名单）；全量清单重跑属发布前 §10.3 遗留待办，届时以下两条应并入正式清单。

| 依赖 | 版本 | 许可 | 原文核对 |
| --- | --- | --- | --- |
| `@tauri-apps/plugin-opener`（npm） | 2.5.5 | Apache-2.0 / MIT 双许可 | 包内 `LICENSE.spdx` 声明 `Apache-2.0 / MIT`，dist-js 文件头 SPDX `Apache-2.0`+`MIT`；上游仓库 `LICENSE_MIT` 抓取 200 |
| `tauri-plugin-opener`（crate，Cargo.lock 连带新增 42 个包、0 删除、无版本改动） | 2.5.5 | Apache-2.0 OR MIT | crates.io 元数据 `Apache-2.0 OR MIT`（cargo 索引/API 均不带 license 字段时的既定兜底口径，见 §1 第 7 条） |

用途与权限面：壳内站外 http(s) 链接经 `opener:allow-open-url` 调系统浏览器打开；`src-tauri/capabilities/default.json` 为**窄授权**（scope 仅 `https://*`/`http://*`，未放 `opener:default` 整包权限）。

---

## 附：V09-14 新增直接依赖补记（2026-09-25，`windows` crate）

> 卡号：`PLAN.md` V09-14（桌面壳后端进程生命周期与端口释放）；依据 `DESIGN.md` §7.4（许可证红线：
> 新增依赖须**打开 LICENSE 原文核对**并登记准入依据）、§11.3、§12.1-19、附录 E.10 第 2 行、附录 G-6。
> 执行：Kimi Code 施工 agent，2026-09-25。**本登记只完成 §7.4 的"原文核对 + 准入依据"**，
> 不代表独立审计通过，也不代表用户验收。§1–§7 与附录 A–G 的数字是 2026-09-18 L1 快照，未因本条重跑。

| 项 | 值 |
| --- | --- |
| 依赖 | `windows` crate **0.61.3**（Rust） |
| 引入位置 | `src-tauri/Cargo.toml` → `[target.'cfg(windows)'.dependencies]`；用途＝壳的**子进程树收口**（Windows Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），落地在 `src-tauri/src/proc_tree.rs` |
| 是否新进依赖树 | **否**。`windows@0.61.3` 早已在 `src-tauri/Cargo.lock` 里（`tauri` / `tao` / `wry` / `webview2-com` / `tauri-runtime` / `tauri-runtime-wry` 等的传递依赖）；本次只是把它提为**直接依赖**并只开四个 feature（`Win32_Foundation`、`Win32_Security`、`Win32_System_JobObjects`、`Win32_System_Threading`，逐条理由写在 `Cargo.toml` 注释里） |
| 许可（crate 清单字段原文） | `license = "MIT OR Apache-2.0"`（`$CARGO_HOME/registry/src/index.crates.io-*/windows-0.61.3/Cargo.toml`） |
| LICENSE 原文（逐句摘录） | `license-mit`：`MIT License` ／ `Copyright (c) Microsoft Corporation.` ／ `Permission is hereby granted, free of charge, to any person obtaining a copy of this software`；`license-apache-2.0`：`Apache License` ／ `Version 2.0, January 2004` ／ `http://www.apache.org/licenses/` |
| 原文文件与指纹 | `license-mit` 1,141 B，sha256 `c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383`；`license-apache-2.0` 11,351 B，sha256 `c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b` |
| 准入依据 | 双许可 `MIT OR Apache-2.0`，**取 MIT 或 Apache-2.0 任一都在项目白名单内**（`AGENTS.md` §7 / `DESIGN.md` §7.4：优先 MIT/Apache/BSD）；非传染性，无 GPL/AGPL/LGPL 分支；**不属于** §12.1-13 那种"超出旧白名单、例外待用户接受"的情形，故不需另开例外。核对方式是**打开 crate 内 LICENSE 原文**（不是凭 crates.io 摘要、不是凭记忆） |
| 机械回读 | `pnpm verify:v09-14` ⑤ 重新打开这两个原文文件、按上面登记的句子逐句比对，并核对 sha256 与登记值一致；比对的是**原文文件**，不是本表 |
| 第二处落点 | `src-tauri/README.md`「进程树收口（V09-14）」一节的许可登记表（同一份内容，便于读 README 的人一眼看到） |
