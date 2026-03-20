# rin

[![CI](https://github.com/THE-cattail/rin/actions/workflows/ci.yml/badge.svg)](https://github.com/THE-cattail/rin/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

**一套 runtime，把 agent 放进终端、聊天、记忆和时间里。**

**Rin** 是一个面向 chat-connected agent 的本地优先运行时。它围绕“用户”而不是“当前工作目录”来设计，让 agent 可以把上下文、记忆、工具、日程和交付通道收在一起，并跨会话持续工作。

Rin 想做的，不是每进一个仓库就重新拉起一次的临时助手，而是一套可以长期相处、持续积累的 agent runtime。

## 为什么选择 Rin？

- **以用户为中心，而不是以 cwd 为中心。** Rin 跟随的是人，而不是此刻打开的某个仓库。
- **多层记忆。** 记忆是运行时内建能力，而不是退化成一段一次性的聊天记录。
- **TUI + Koishi。** 既能在本地终端里工作，也能把同一套运行时接到聊天平台上。
- **可自举迭代。** Rin 可以直接检查、使用并继续整理它自己所处的运行时环境。
- **定时任务和巡检是一等能力。** 后台 routine 和 inspection 都是原生能力。
- **All in agent。** 公共 CLI 保持很小，更丰富的行为通过 agent runtime 自身暴露出来，因此可以开箱即用，也能由 agent 自配置。

## 一小段宣言

很多 agent 工具，是从表面开始的：
一个命令，一个编辑器面板，一个工作目录。

Rin 想从连续性开始。

agent 应该有自己的记忆、自己的 routine、自己的交互面，也应该有一套能继续长下去的运行时。

不是一次任务里的临时帮手。
而是一套可以长期留下来的 runtime。

## 架构一览

```text
用户
 ├─ 终端 ─────> Local TUI ────┐
 └─ 聊天 ─────> Koishi bridge │
                              ├──> Rin agent runtime
                              │      ├─ memory
                              │      ├─ skills
                              │      ├─ models
                              │      ├─ schedules
                              │      └─ inspections
                              │
                              └──> 持久化运行时状态 (~/.rin)
```

## 3 步感受 Rin

**1. 安装**

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh
```

**2. 启动**

```bash
rin
```

**3. 让这套 runtime 跟着您一起长**

在本地 TUI 里使用 Rin，把它接到聊天平台上，让同一个 agent runtime 持续积累，而不是每换一个仓库就重置一次。

## 快速开始

### 环境要求

- 支持用户级 `systemd` 的 Linux 兼容环境
- Node.js >= 22
- `npm`、`git`、`mktemp`

### 快速安装

```bash
# 安装最新 main
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# 安装指定 ref
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | RIN_REF=main sh
```

### 源码安装

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

### 启动 Rin

```bash
rin
```

## 典型使用场景

| | |
| :--- | :--- |
| **个人终端 agent**<br>在不同仓库之间切换时，不需要每次都从零开始。 | **聊天连接型助手**<br>可以通过桥接消息平台接收、处理和投递工作。 |
| **自维护运行时**<br>agent 可以直接检查自己的文档、技能、记忆和日程，然后继续迭代整理。 | **后台自动化伴侣**<br>适合承接周期性 routine、定期检查和长生命周期的 agent 工作流。 |

## 定位对比

| 关键问题 | Rin | 终端代码智能体 | 以 IDE 为中心的智能体 |
| :--- | :--- | :--- | :--- |
| **agent 属于谁？** | 属于用户 | 属于当前 shell 或仓库 | 属于当前编辑器工作区 |
| **主要在哪见到它？** | TUI 和聊天桥接 | CLI 命令运行 | 编辑器面板和扩展 |
| **关掉表面之后会怎样？** | runtime 仍保持自己的连续性 | 往往随进程结束而结束 | 体验仍绑定在编辑器里 |
| **多少系统能力活在 agent 内部？** | 记忆、routine、巡检、配置都在里面 | 主要是任务执行 | 主要是编辑器内辅助 |
| **重心是什么？** | 持续运行的个人 agent runtime | 直接终端工作 | 编辑器内帮助 |

*相关类别的示例包括终端智能体如 Codex CLI、Claude Code、Gemini CLI，以及以 IDE 为中心的工具如 Cursor、Windsurf、Cline。*

## 公共命令界面

Rin 有意把公共 CLI 保持得很小：

- `rin`：启动交互式本地 TUI。
- `rin restart`：重启后台 Rin 守护进程服务。
- `rin update`：从配置好的源仓库与 ref 重新安装或更新 Rin。
- `rin uninstall --keep-state --yes`：移除已安装应用和启动器，但保留 `~/.rin` 里的数据。
- `rin uninstall --purge --yes`：移除应用以及完整的 `~/.rin` 运行时。

## 内建能力

- **本地 TUI**，用于直接运行交互式 agent 会话。
- **基于 Koishi 的聊天连接能力**，用于桥接投递。
- **运行时内建记忆系统**，而不是一次性会话日志。
- **原生的定时任务与巡检能力**。
- **通过运行时文档、技能和内部工具实现 agent 自配置**。
- **极小公共命令面带来的开箱即用体验**。

## 文档

- [运行时参考](install/home/docs/rin/README.md)
- [TUI 指南](install/home/docs/rin/docs/tui.md)
- [模型与提供商](install/home/docs/rin/docs/models.md)
- [技能](install/home/docs/rin/docs/skills.md)
- [扩展](install/home/docs/rin/docs/extensions.md)
- [SDK](install/home/docs/rin/docs/sdk.md)
- [示例](install/home/docs/rin/examples/README.md)
- [开发说明](install/home/docs/rin/docs/development.md)

## 开发

验证本地改动：

```bash
npm run check
```

贡献细节见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CODE_STYLE.md](CODE_STYLE.md)。

## 开源协议

本项目基于 MIT 协议发布。详情见 [LICENSE](LICENSE)。
