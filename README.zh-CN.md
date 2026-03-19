# rin

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

[![CI](https://github.com/THE-cattail/rin/actions/workflows/ci.yml/badge.svg)](https://github.com/THE-cattail/rin/actions/workflows/ci.yml)
[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-2ea44f)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

面向聊天连接代理工作流的本地优先运行环境。

## 它是什么

`rin` 把公开 CLI 保持得很小，把真正的重心放在本地运行时根目录上。

- `rin` 启动本地交互 TUI
- 后台守护进程负责桥接、定时任务和自动化流程
- 运行时状态集中存放在 `~/.rin`
- 桥接投递、记忆、检查、定时任务、Web 搜索等内部能力通过运行时 / 工具面提供，而不是不断膨胀公开子命令

## 它为什么不太一样

Rin 不是单纯把模型包一层终端壳，也不是把重心放在 IDE 外壳上。

- **默认本地优先** —— 状态、文档、技能和运行数据都放在 `~/.rin`
- **守护进程驱动** —— 自动化和聊天连接流程是运行时模型的一部分
- **公开接口克制** —— 受支持的 CLI 故意只保留启动、重启、更新、卸载
- **运行时优先设计** —— agent 侧能力放进运行时本身，而不是每加一个能力就扩一层公开 CLI

## 与其它 agent 产品相比

Rin 更像是运行时定位的差异，而不是功能清单的堆砌。

| 产品形态 | 常见重心 | Rin 的定位 |
| --- | --- | --- |
| Codex CLI、Claude Code、Gemini CLI 这类终端型 agent | 当前仓库里的活跃终端会话 | Rin 以持久的本地运行时根目录和守护进程支撑的聊天连接工作流为中心 |
| Cursor、Windsurf、Cline 这类 IDE 型 agent | 编辑器窗口及其扩展生命周期 | Rin 把工作流放在本地运行时里，并刻意保持很小的公开 CLI |

如果您想要的是一个围绕持久本地状态和后台工作流来组织的 agent runtime，Rin 就是朝这个方向做的。

## 环境要求

- 兼容 Linux 的环境
- 需要用户级 `systemd` 来支持受管守护进程的重启 / 更新流程
- Node.js >= 22
- `npm`、`git`、`mktemp`
- Docker 为可选项，仅在使用本地托管的 SearxNG 搜索侧车时需要

## 安装

通过 `install.sh` 安装。`rin install` 是刻意不公开的命令。

```bash
# 安装 main 分支
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# 安装指定 ref
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | RIN_REF=main sh
```

启动器会安装到 `~/.local/bin/rin`。

### 从源码安装

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

## 快速开始

1. 运行 `rin` 进入本地交互模式。
2. 将运行时文件统一放在 `~/.rin`。
3. 修改由守护进程接管的运行时或桥接设置后，执行 `rin restart`。
4. 需要更新时，执行 `rin update` 按已配置源码来源重新安装并刷新运行时。

## 公开命令面

| 命令 | 作用 |
| --- | --- |
| `rin` | 启动本地交互 TUI |
| `rin restart` | 重启用户级 Rin 守护进程服务 |
| `rin update` | 按已配置的源码仓库 / ref 重新安装 |
| `rin uninstall --keep-state --yes` | 删除程序和启动器，但保留 `~/.rin` |
| `rin uninstall --purge --yes` | 同时删除程序与 `~/.rin` |

## 运行时布局

- `~/.rin` —— 运行时根目录
- `~/.rin/data` —— 运行数据与守护进程状态
- `~/.rin/docs/rin` —— 安装时复制到本地的运行时参考文档

## Web 搜索

Web 搜索的运行时配置位于 `~/.rin/data/web-search/config.json`。

默认情况下，Rin 可以托管一个本地 SearxNG 侧车。您也可以把该配置指向自己的 SearxNG 实例，或提供 Serper 凭据。

## 开发

```bash
npm ci
npm run check
```

`npm run check` 会构建项目、运行单元测试、运行安装 / 更新 / 卸载流程的 smoke tests，并检查仓库的可移植性与文档一致性。

另请参阅：

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_STYLE.md](CODE_STYLE.md)
- [运行时参考](install/home/docs/rin/README.md)

## 卸载

```bash
rin uninstall --keep-state --yes
rin uninstall --purge --yes
```

## 许可证

MIT
