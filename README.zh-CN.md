# rin

![Node.js](https://img.shields.io/badge/node-%3E%3D22-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

**给您的 agent 一个小小的家。**

**Rin** 是一个本地优先的 agent 伴侣。它想照看的，不是一时半会儿的一次任务，而是那个会跟着您慢慢熟起来的助手。您换项目、换窗口、换聊天界面时，不必总让它重新开始；Rin 会帮同一个助手把记忆、习惯，还有跟您说话的方式慢慢留住。

小助手不该是用完就丢的。
Rin 想把它收成一套能陪着您、记得事、也会自己慢慢整理好的日常存在。

## 为什么选择 Rin？

- **它跟着人走，不跟着文件夹走。** 您的助手围绕的是您，不是哪一个碰巧打开的项目。
- **它会记得。** 不是把聊天记录越堆越乱，而是真的把一些东西慢慢带下去。
- **它能在不止一个地方见您。** 可以在终端里聊，也可以接到聊天软件里继续说话。
- **它会自己整理自己。** Rin 能让助手读自己的笔记、工具和小规矩，再一点点把做事方式理顺。
- **它也能替您照看。** 重复的小事、定时看看、安静地跑一阵子的事情，本来就是它该会的。
- **它一装好就能上手。** 命令行保持得很轻，真正丰富的本事更多收在助手自己身上。

## 一小段宣言

很多 agent 工具，是从表面开始的。
一个命令，一个面板，一个项目目录。

Rin 想从“持续留下来”开始。

助手应该能记得事，
能有自己的习惯，
能把位置放稳，
也能跟着使用它的人一起慢慢长。

不是一次性的花活。
而是一位能常伴左右的小帮手。

## Rin 大致是怎么收拢在一起的

```text
您
 ├─ 在终端里说话 ────┐
 └─ 在聊天里说话 ────┤
                      ├──> Rin
                      │      ├─ 记得一些事情
                      │      ├─ 使用工具做事
                      │      ├─ 收着笔记和规矩
                      │      ├─ 处理重复的小任务
                      │      └─ 在需要时悄悄看一眼
                      │
                      └──> 跨会话继续接着来
```

## 3 步感受 Rin

**1. 安装**

```bash
# 交互式安装向导（会引导选择运行目录、provider、聊天桥接）
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# 指定自定义运行目录
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh -s -- --state-root ~/rin-home

# 只体验安装流程，不落盘
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh -s -- --dry-run
```

**2. 打开它**

```bash
rin
```

**3. 把同一个助手留在身边**

在终端里用 Rin，愿意的话也把它接到聊天软件上，让同一个助手陪着您慢慢熟起来，而不是每换一个项目就重新来过。

## 快速开始

### 环境要求

- Linux、macOS，或 Windows（Windows 上请用 Git Bash / 兼容 POSIX 的 shell 运行 `install.sh`）
- 后台 daemon 会在 `systemd`、`launchd`、分离后台进程之间自动选一个可用后端
- Node.js >= 22
- `npm`、`git`、`mktemp`

### 快速安装

```bash
# 用交互式安装向导安装最新 main
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh

# 安装到自定义运行目录
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh -s -- --state-root ~/rin-home

# 只预览安装结果，不写入环境
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | sh -s -- --dry-run

# 安装指定 ref
curl -fsSL https://raw.githubusercontent.com/THE-cattail/rin/main/install.sh | RIN_REF=main sh
```

### 源码安装

```bash
git clone https://github.com/THE-cattail/rin.git
cd rin
./install.sh --local
```

### 从本地源码树更新

```bash
cd /path/to/rin
rin update --local

# 或用另一个源码树更新已安装运行时
rin update --local --path /path/to/rin
```

### 启动 Rin

```bash
rin
```

## 使用场景

| | |
| :--- | :--- |
| **终端里的私人小帮手**<br>在不同项目之间来回切换时，它也不会每次都像第一次见面。 | **会在聊天里开口的助手**<br>适合想让同一个助手接收、处理、再发出消息的时候。 |
| **会自己收拾屋子的助手**<br>它可以看看自己的笔记、习惯和工具，然后慢慢把自己理顺。 | **安安静静做背景工作的帮手**<br>适合重复小事、定时看看，以及跑得久一点的工作。 |

## 和别的 agent 产品相比

| 关键问题 | Rin | 终端代码智能体 | 以 IDE 为中心的智能体 |
| :--- | :--- | :--- | :--- |
| **助手更像是谁的？** | 更像是属于使用它的人 | 更像属于当前 shell 或项目 | 更像属于当前编辑器工作区 |
| **通常在哪见到它？** | 终端里，也能在聊天里 | 命令执行时 | 编辑器面板和扩展里 |
| **把表面关掉之后呢？** | 助手自己的连续性还在 | 往往跟着进程一起结束 | 体验仍然绑在编辑器上 |
| **多少本事活在助手自己身上？** | 记忆、重复任务、照看、配置都在里面 | 主要是执行当前任务 | 主要是编辑器内辅助 |
| **它想成为什么？** | 一位能长期相处的私人助手 | 一个终端里的干活工具 | 一个编辑器里的帮手 |

*相关类别的示例包括终端智能体如 Codex CLI、Claude Code、Gemini CLI，以及以 IDE 为中心的工具如 Cursor、Windsurf、Cline。*

## 公共命令界面

Rin 有意把公开命令收得很小：

- `rin`：打开“当前用户自己”这套运行环境下的本地交互界面。
- `rin -u <user>`：在有权限切换用户时，直接打开另一个用户的 Rin。
- `rin --tmux [<name>]`：放进 Rin 自己独占的 tmux socket 里运行，不会出现在默认的 `tmux list-sessions` 结果中。
- `rin --tmux-list`：列出这个 Rin 专用 tmux socket 下面已有的 session name。
- `rin restart`：重启后台服务。
- `rin update`：从配置好的来源重新安装或更新 Rin。
- `rin uninstall --keep-state --yes`：移除程序，但保留已经存下来的状态。
- `rin uninstall --purge --yes`：把程序和已存状态一起移除。

## 它本来就带着的能力

- **本地对话界面**，可以直接和助手说话。
- **聊天软件投递能力**，让同一个助手走出终端。
- **内建记忆**，不只记得眼前这一段对话。
- **重复任务和安静巡看**，本来就是系统的一部分。
- **由助手自己参与整理的配置方式**，通过它自己的笔记、工具和内部说明来慢慢调顺。
- **表面很轻，本事更多收在助手里面。**

## 基于 Pi

Pi 是一套成熟的智能体运行时，提供了稳健的 session 机制、广泛的 provider / model 支持、完善的终端 UI，以及已经足够实用的扩展与 SDK 接口。

Rin 则在这层基础上，把方向转向一个本地优先、可长期延续的个人助手运行时。它不把重点放在单次会话或某个仓库上，而是让记忆、聊天桥接、定时任务，以及助手自有的笔记和规则跨会话延续下去。

## 文档

- [运行时参考](install/home/docs/rin/README.md)
- [示例（源码仓库）](examples/pi/README.md)

## 开发

验证本地改动：

```bash
npm ci
npm run check
npm run check:container
```

`npm ci` 也会在 Git 工作区里把本地 Husky hooks 装好。`pre-push` 会在每次推送前自动运行 `npm run check:container`，所以本地需要有 Docker。

贡献细节见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [CODE_STYLE.md](CODE_STYLE.md)。

## 开源协议

本项目基于 MIT 协议发布。详情见 [LICENSE](LICENSE)。
