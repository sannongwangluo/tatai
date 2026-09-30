---
name: Bug 报告
about: 报告一个可复现的缺陷（崩溃、报错、行为不对）
title: "[Bug] "
labels: ["bug"]
assignees: ""
---

<!--
⚠️ 提交前请务必确认：**不要贴任何密钥、口令或真实项目数据**。
   - 不要贴 API Key / token / 远程口令原文（`config.json`、`remote/` 下的内容一律不要粘）。
   - 日志与截图先脱敏：删掉真实项目名、本机用户名与绝对路径、协作内容。
   - 安全漏洞不要走公开 Issue，请用 SECURITY.md 的私密报告渠道。
-->

## 环境

- 塔台版本（界面左下角页脚，或 Release 页）：
- 系统：Windows 版本（如 Windows 11 23H2 x64）
- Node 版本（`node -v`）：
- 安装方式：NSIS `…-setup.exe` / MSI `…_en-US.msi` / 从源码运行
- 若从源码运行：`pnpm -v`、commit 或分支

## 复现步骤

1.
2.
3.

## 期望什么

## 实际发生什么

（截图或报错原文；**截图先脱敏**）

## 相关日志

- 后端：`<全局数据目录>/logs/backend.log`
- 桌面壳：`<全局数据目录>/logs/shell.log`
- 远程访问（若相关）：`<全局数据目录>/logs/remote-audit.jsonl`

```
（粘贴相关片段；先脱敏，不要整份粘贴）
```

## 还试过什么

（可选：换目录 / 换项目 / 重装等排除动作）
