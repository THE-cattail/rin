# rin

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

面向聊天连接代理工作流的本地优先运行环境。

## 环境要求

- Node.js >= 22
- npm, git, mktemp
- 兼容 Linux 的环境

## 安装

通过 `install.sh` 进行安装。注意：`rin install` 不是公开命令。

```bash
# 标准安装
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# 安装特定版本 (ref)
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | RIN_REF=main sh
```

启动器将安装至 `~/.local/bin/rin`。

### 源码安装

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

## 基本用法

- **启动**: `rin` (进入交互模式)
- **重启**: `rin restart` (重启后台守护进程)
- **更新**: `rin update` 
- **自定义更新**: `rin update --repo https://github.com/THE-cattail/rin.git --ref main` 

## 卸载

- **保留数据**: `rin uninstall --keep-state --yes` 
- **彻底清除**: `rin uninstall --purge --yes` 

## 数据存储

运行数据和状态存储在 `~/.rin` 目录下。