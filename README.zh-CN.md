# rin

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

`rin` 是一个面向聊天连接式 Agent 工作流的本地优先运行时。

## 项目定位

这个仓库只保留适合公开维护、公开协作的部分：

- `src/` 下的 TypeScript 运行时代码
- GitHub 引导安装脚本 `install.sh`
- 安装时写入 `~/.rin` 的公共文档资产 `install/home/`
- 贡献与 CI 所需的工程文件

用户的实际运行时状态不放在仓库里，而是放在 `~/.rin`。

## 适用场景

如果你希望获得这些特性，这个项目会比较合适：

- 只有一个公开入口命令 `rin`
- 源码目录与真实运行时目录明确分离
- 私有状态、凭据、日志默认留在本机
- 可以从源码或远端仓库稳定更新

## 环境要求

- Node.js 22+
- npm
- git

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

## 更新

```bash
rin update
```

## 卸载

仅移除程序、保留 `~/.rin` 状态：

```bash
rin uninstall --keep-state --yes
```

彻底移除：

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

自测：

```bash
npm run check
```

## 运行时目录

Rin 的运行时状态位于 `~/.rin`，常见内容包括：

- `AGENTS.md`
- `settings.json`
- `auth.json`
- `data/`
- `docs/`
- `skills/`
- `locale/`
- 按需生成的 `kb/`、`routines/` 等目录

`~/.local/bin/rin` 会指向 `~/.rin/app/current/dist/index.js`。

## 公开命令面

Rin 保持很小的公开 CLI 面：

- `rin`
- `rin restart`
- `rin update`
- `rin uninstall`

内存、桥接、调度等能力属于运行时内部能力，不作为公开 shell 子命令暴露。

## 工程约束

这个仓库的目标是对开源协作友好：

- 避免只能在单一机器上生效的实现
- 优先可复现的安装、构建、更新路径
- 行为变更尽量同时补文档和自测
- 保持公开代码与私有运行时状态的清晰边界

更多约束见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

[MIT](LICENSE)
