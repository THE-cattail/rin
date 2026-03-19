# rin

[![CI](https://github.com/THE-cattail/rin/actions/workflows/ci.yml/badge.svg)](https://github.com/THE-cattail/rin/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

**Rin** 是一个专为连接聊天（chat-connected）的智能体工作流设计的本地优先（local-first）运行时。它提供了一个稳定的、由守护进程支持的环境，使智能体能够管理日程、自动化任务和执行长时间运行的桥接交付，而无需受限于单一的终端会话或编辑器窗口。

## 为什么选择 Rin？

Rin 在智能体生态系统中占据着独特的地位。虽然许多工具专注于即时代码生成或编辑器集成，但 Rin 专注于**运行时根基**——即能够让智能体作为持续助手运行的持久化后台层。

### 定位对比

| 特性 | Rin | 终端代码智能体 | 以 IDE 为中心的智能体 |
| :--- | :--- | :--- | :--- |
| **主要界面** | 本地运行时 & TUI | CLI 命令 | 编辑器 / 扩展 |
| **执行模型** | 持久化守护进程 | 特定任务进程 | 绑定编辑器的插件 |
| **状态管理** | 集中化 (`~/.rin`) | 基于会话 | 编辑器工作区 |
| **工具表面** | 内部运行时 API | CLI 子命令 | 编辑器命令 |
| **核心焦点** | 连接的工作流 | 直接文件编辑 | 编辑器内辅助 |

*相关类别的示例包括终端智能体如 Codex CLI、Claude Code 或 Gemini CLI，以及以 IDE 为中心的工具如 Cursor、Windsurf 或 Cline。*

## 核心特性

- **本地优先根基：** 所有的运行时状态、记忆和配置均存储在 `~/.rin` 中。
- **守护进程支持：** 后台服务处理桥接、日程和自动化流，确保即使在 UI 关闭时任务也能继续运行。
- **极简 CLI 表面：** 公共 CLI 保持极度精简。复杂的智能体能力（网页搜索、记忆、检查）通过运行时工具表面暴露，而非增加 CLI 的复杂性。
- **用户级管理：** 深度集成 `systemd` 以实现托管的服务生命周期管理（重启、更新、日志）。

## 安装

### 快速安装
需要支持 `systemd` 的 Linux 兼容环境，Node.js >= 22，`npm`，`git` 以及 `mktemp`。

```bash
# 安装最新主分支 (main)
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# 安装指定引用 (ref)
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

## 命令界面

Rin 保持精简的 CLI 以减少干扰：

- `rin`: 启动交互式本地 TUI。
- `rin restart`: 重启后台 Rin 守护进程服务。
- `rin update`: 从配置的源仓库和引用重新安装/更新 Rin。
- `rin uninstall --keep-state --yes`: 移除应用程序和启动器，但保留 `~/.rin` 中的数据。
- `rin uninstall --purge --yes`: 完全移除应用程序及 `~/.rin` 目录。

## 运行时布局

运行时状态严格包含在您的用户主目录中：

- `~/.rin/`: 主要状态根目录。
- `~/.rin/data/web-search/config.json`: 网页搜索配置。
- `~/.rin/bin/`: 启动器和二进制文件。

## 网页搜索

Rin 具备灵活的网页搜索运行时能力。它可以经由 Docker 管理本地 **SearxNG** 实例（可选边车模式），连接到现有的 SearxNG 实例，或使用 **Serper** 凭据。配置在 `~/.rin/data/web-search/config.json` 中进行管理。

## 开发

### 环境要求
- Node.js >= 22
- 带有用户级 `systemd` 的 Linux
- Docker（可选，用于托管 SearxNG 边车）

### 验证
验证本地更改：
```bash
npm run check
```

有关贡献的更多详细信息，请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CODE_STYLE.md](CODE_STYLE.md)。内部文档可在 `install/home/docs/rin/README.md` 中找到。

## 开源协议

本项目采用 MIT 协议开源 - 详情请参阅 [LICENSE](LICENSE) 文件。
