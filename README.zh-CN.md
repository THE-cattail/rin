# rin

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

`rin` 是一个面向聊天连接式 Agent 工作流的本地优先运行时。

## 你会得到什么

- 用于交互使用的 `rin`
- 用于重启守护进程的 `rin restart`
- 用于从仓库版本更新安装的 `rin update`
- 用于卸载运行时的 `rin uninstall`
- 存放在 `~/.rin` 下的运行时状态

Rin 运行在安装后的 `~/.rin` 中，而不是源码目录里。

## 环境要求

- Node.js 22+
- npm
- git
- 当前安装流程支持的类 Linux 环境

## 安装

当前用户安装：

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh
```

指定版本安装：

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | \
  RIN_REF=main sh
```

为另一个现有用户安装：

```bash
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | \
  sh -s -- --user existing-user --yes
```

## 日常命令

启动交互模式：

```bash
rin
```

重启守护进程：

```bash
rin restart
```

更新已安装运行时：

```bash
rin update
```

从指定仓库或版本更新：

```bash
rin update --repo https://github.com/THE-cattail/rin.git --ref main
```

卸载程序但保留 `~/.rin`：

```bash
rin uninstall --keep-state --yes
```

彻底删除：

```bash
rin uninstall --purge --yes
```

## 从源码开发

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
npm ci
npm run build
RIN_REPO_URL="$(pwd)" ./install.sh --current-user --yes
```

运行校验：

```bash
npm run check
```

## 仓库结构

```text
src/                 运行时代码
install.sh           引导安装脚本
install/home/        安装时复制进 ~/.rin 的内置文件
test/                自动化测试
```

## 运行时结构

```text
~/.rin/
  AGENTS.md
  app/current/
  auth.json
  data/
  docs/
  locale/
  settings.json
  skills/
```

安装后的启动入口：

```text
~/.local/bin/rin
```

## 许可

[MIT](LICENSE)
