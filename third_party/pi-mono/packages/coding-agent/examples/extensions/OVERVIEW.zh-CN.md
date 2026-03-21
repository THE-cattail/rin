# Rin / Pi `examples/pi/extensions` 文件说明

> 说明对象：`/home/rin/rin-src/examples/pi/extensions`
>
> 这份文档按“这个文件主要是做什么”的角度整理，方便快速浏览示例扩展目录。

## 目录总览

这个目录大致可以分成几类：

- 安全与拦截：限制危险操作、敏感路径、沙箱运行
- 工具扩展：注册新工具、覆盖内置工具、动态工具
- UI 与交互：状态栏、页眉页脚、消息渲染、自定义编辑器
- 提示词与上下文：输入改写、系统提示词注入、上下文压缩
- Provider：自定义模型提供方接入
- 高级能力：子代理、动态资源、远程 SSH、实时 overlay 游戏

## 根目录文件

### 总览

- `README.md`  
  本目录总览文档，按主题列出各个 extension 的用途、用法和常见写法模式。

### 安全 / 生命周期

- `permission-gate.ts`  
  在调用危险 bash 命令前弹确认框，比如 `rm -rf`、`sudo`。

- `protected-paths.ts`  
  拦截对敏感路径的写入，例如 `.env`、`.git/`、`node_modules/`。

- `confirm-destructive.ts`  
  对清空会话、切换、fork 等破坏性会话操作加确认。

- `dirty-repo-guard.ts`  
  仓库有未提交改动时，阻止某些可能影响会话状态的动作。

- `timed-confirm.ts`  
  演示带超时的确认/选择框，超时后自动取消。

### 工具相关

- `hello.ts`  
  最小 custom tool 示例，用来演示最基础的工具注册方式。

- `todo.ts`  
  一个“agent 自己维护待办列表”的示例工具。模型可以通过 `todo` 工具执行 `list/add/toggle/clear`，并通过 `/todos` 查看当前分支上的待办状态。它确实对应市面上 code agent 常见的那类 todo 能力，不过这里是示例版、最小闭环版：
  - 状态不是写进外部文件，而是存在 tool result `details` 里
  - 会在 session / branch 恢复时重建状态
  - fork 后 todo 会天然跟随分支历史

- `question.ts`  
  演示如何用 `ctx.ui.select()` 向用户提问并获取选择结果。

- `questionnaire.ts`  
  多问题表单示例，支持在不同问题间切换。

- `tool-override.ts`  
  覆盖内置工具逻辑，例如给 `read` 加日志、权限控制或审计。

- `dynamic-tools.ts`  
  演示在启动后、甚至运行中动态注册工具，并附带工具专属 prompt 说明。

- `built-in-tool-renderer.ts`  
  不改内置工具行为，只改 `read/bash/edit/write` 在 UI 中的显示形式。

- `minimal-mode.ts`  
  更极简的工具渲染模式，折叠时只显示工具调用，不展示输出内容。

- `truncated-tool.ts`  
  一个带输出截断规则的 ripgrep 包装示例，遵循 50KB / 2000 行限制。

- `antigravity-image-gen.ts`  
  调 Google Antigravity 生成图片，并支持可选保存到磁盘。

- `ssh.ts`  
  把工具调用委托到远程 SSH 主机执行，用来演示远程运行能力。

- `provider-payload.ts`  
  监听 provider 请求，把发给模型提供方的 payload 记录到 `.pi/provider-payload.log`。

- `bash-spawn-hook.ts`  
  重新包装 bash 工具，在执行前修改命令、工作目录或环境变量。

### 输入 / 提示词 / 上下文

- `inline-bash.ts`  
  把用户输入里的 `!{command}` 模式先展开成命令输出，再交给模型。

- `input-transform.ts`  
  监听输入事件：例如把 `?quick xxx` 改写成简短回答，或对 `ping` / `time` 直接本地响应。

- `pirate.ts`  
  演示 `systemPromptAppend`，动态往系统提示词里追加指令。

- `claude-rules.ts`  
  扫描 `.claude/rules/` 目录，并把规则摘要注入系统提示词。

- `system-prompt-header.ts`  
  显示一个状态项，告诉你当前生效系统提示词的长度。

- `custom-compaction.ts`  
  自定义上下文压缩逻辑，自行决定如何总结会话。

- `trigger-compact.ts`  
  在上下文使用量过高时主动触发 compaction，也提供 `/trigger-compact` 命令。

### 命令 / UI / 交互

- `commands.ts`  
  提供 `/commands`，列出当前会话可用的 slash commands，并可按来源筛选。

- `preset.ts`  
  做命名预设，把模型、thinking、工具和附加说明打包成 preset。

- `tools.ts`  
  提供交互式 `/tools` 命令，动态启停工具，并把结果存入 session。

- `handoff.ts`  
  把上下文转交到一个新的、更聚焦的 session。

- `qna.ts`  
  从上一条回复里提取问题，放回编辑器，便于继续问答。

- `status-line.ts`  
  用 `ctx.ui.setStatus()` 做底部状态栏，展示 turn 进度。

- `widget-placement.ts`  
  演示 widget 可以放在编辑器上方或下方。

- `model-status.ts`  
  监听模型切换，在状态栏提示当前模型。

- `custom-footer.ts`  
  自定义底栏，示例里会显示 git 分支、token 统计等信息。

- `custom-header.ts`  
  自定义顶栏。

- `message-renderer.ts`  
  自定义消息渲染器，给消息增加颜色、折叠细节等展示方式。

- `modal-editor.ts`  
  自定义一个类 Vim 的 modal editor 组件。

- `rainbow-editor.ts`  
  一个带彩虹动画效果的自定义编辑器示例。

- `notify.ts`  
  任务结束时通过 OSC 777 发桌面通知，适配 Ghostty / iTerm2 / WezTerm。

- `titlebar-spinner.ts`  
  agent 工作时在终端标题栏显示旋转动画。

- `rpc-demo.ts`  
  演示 extension UI 的 RPC 能力，适合配合桥接 UI 测试。

- `overlay-test.ts`  
  overlay 的基础测试样例。

- `overlay-qa-tests.ts`  
  更完整的 overlay 质量测试，覆盖锚点、边距、堆叠、溢出和动画等。

- `shutdown-command.ts`  
  增加 `/quit`，演示 `ctx.shutdown()`。

- `reload-runtime.ts`  
  增加 `/reload-runtime` 命令和 `reload_runtime` 工具，演示安全重载流程。

- `interactive-shell.ts`  
  让 `vim`、`htop` 这类交互命令接管完整终端。

- `send-user-message.ts`  
  演示 extension 如何主动向会话里发送一条用户消息。

- `summarize.ts`  
  用 GPT-5.2 对当前对话做总结，并显示在临时 UI 中。

### 会话元数据 / 通信

- `event-bus.ts`  
  通过 `rin.events` 做 extension 间通信。

- `session-name.ts`  
  给 session 设置更友好的名字，便于会话选择器中查看。

- `bookmark.ts`  
  给会话树中的条目打标签，方便 `/tree` 导航。

### Git / 系统集成

- `git-checkpoint.ts`  
  每轮自动做 git stash 检查点，便于 fork 或恢复。

- `auto-commit-on-exit.ts`  
  退出时自动 commit，commit message 取最后一条 assistant 回复。

- `mac-system-theme.ts`  
  跟 macOS 深浅色模式同步 Rin 的主题。

### 游戏 / 演示型 UI

- `snake.ts`  
  Snake 游戏示例，演示自定义 UI、按键处理和状态持久化。

- `space-invaders.ts`  
  Space Invaders 终端小游戏，支持平滑按键、暂停和存档恢复。

## 子目录

### `plan-mode/`

- `plan-mode/README.md`  
  计划模式文档，说明只读探索、Plan 提取、`[DONE:n]` 进度跟踪等机制。

- `plan-mode/index.ts`  
  主实现：切换 plan mode、限制工具、抽取计划步骤、执行时跟踪完成度。

- `plan-mode/utils.ts`  
  工具函数：判断 bash 是否安全、从回复里提取计划项、识别 `[DONE:n]` 标记。

### `dynamic-resources/`

- `dynamic-resources/index.ts`  
  在 `resources_discover` 事件里动态暴露 skill、prompt、theme。

- `dynamic-resources/SKILL.md`  
  被动态加载的示例 skill 文件。

- `dynamic-resources/dynamic.md`  
  被动态加载的示例 prompt 模板。

- `dynamic-resources/dynamic.json`  
  被动态加载的示例主题配置。

### `doom-overlay/`

- `doom-overlay/README.md`  
  DOOM overlay 示例说明，包含运行方式、按键和渲染原理。

- `doom-overlay/index.ts`  
  主入口：注册 `/doom-overlay` 命令，准备 WAD，启动 overlay。

- `doom-overlay/doom-component.ts`  
  把 DOOM 帧缓冲渲染成终端中的半块字符彩色画面，并处理键盘输入。

- `doom-overlay/doom-engine.ts`  
  WebAssembly 封装层：加载编译好的 doomgeneric、喂 WAD、推进游戏 tick、读取帧数据。

- `doom-overlay/doom-keys.ts`  
  终端按键到 DOOM 键码的映射和转换逻辑。

- `doom-overlay/wad-finder.ts`  
  查找本地 WAD 文件，找不到时自动下载 shareware WAD。

- `doom-overlay/doom/build.sh`  
  构建脚本：用 Emscripten 把 doomgeneric 编译成 `doom.js` 和 `doom.wasm`。

- `doom-overlay/doom/doomgeneric_pi.c`  
  doomgeneric 的平台适配层，提供帧缓冲读取、键盘事件队列和时间接口。

### `subagent/`

- `subagent/README.md`  
  子代理功能总说明：单代理、并行、链式 workflow、agent 作用域与安全模型。

- `subagent/index.ts`  
  核心实现：起独立 `pi` 子进程执行子代理任务，支持单个 / 并行 / 链式模式，并自定义结果渲染。

- `subagent/agents.ts`  
  负责发现和解析 agent 定义文件，支持用户级与项目级 agent。

- `subagent/agents/scout.md`  
  “侦察兵” agent：快速探路代码库，返回压缩后的上下文和关键文件。

- `subagent/agents/planner.md`  
  “规划师” agent：根据上下文生成实施计划，不做改动。

- `subagent/agents/reviewer.md`  
  “审查者” agent：做代码 review，偏质量、安全和可维护性。

- `subagent/agents/worker.md`  
  “执行者” agent：真正完成任务，能力最完整。

- `subagent/prompts/implement.md`  
  预设 workflow：`scout -> planner -> worker`。

- `subagent/prompts/scout-and-plan.md`  
  预设 workflow：`scout -> planner`，只调研和规划，不实施。

- `subagent/prompts/implement-and-review.md`  
  预设 workflow：`worker -> reviewer -> worker`，实现后评审再修正。

### `custom-provider-anthropic/`

- `custom-provider-anthropic/index.ts`  
  自定义 Anthropic provider 示例，带 OAuth、API Key、模型定义和自定义 streaming 实现。

- `custom-provider-anthropic/package.json`  
  这个扩展自己的 npm 清单，声明入口和 `@anthropic-ai/sdk` 依赖。

- `custom-provider-anthropic/package-lock.json`  
  依赖锁文件。

### `custom-provider-gitlab-duo/`

- `custom-provider-gitlab-duo/index.ts`  
  GitLab Duo provider 示例，通过 GitLab AI Gateway 代理 Claude / GPT，并复用内置流式实现。

- `custom-provider-gitlab-duo/package.json`  
  这个 provider 示例自己的包清单。

- `custom-provider-gitlab-duo/test.ts`  
  独立测试脚本，用来直接验证 GitLab Duo provider 的模型和流式输出。

### `custom-provider-qwen-cli/`

- `custom-provider-qwen-cli/index.ts`  
  Qwen CLI provider 示例，走 device-code OAuth，注册 Qwen 模型，并可根据凭证动态改 base URL。

- `custom-provider-qwen-cli/package.json`  
  这个 provider 示例自己的包清单。

### `sandbox/`

- `sandbox/index.ts`  
  OS 级 bash 沙箱示例，接入 `@anthropic-ai/sandbox-runtime`，约束文件系统和网络访问。

- `sandbox/package.json`  
  沙箱扩展的包清单，声明 `@anthropic-ai/sandbox-runtime` 依赖。

- `sandbox/package-lock.json`  
  依赖锁文件。

### `with-deps/`

- `with-deps/index.ts`  
  演示“扩展目录自带 npm 依赖”的做法；这里注册了 `parse_duration` 工具，并使用 `ms` 包。

- `with-deps/package.json`  
  这个示例自己的依赖声明。

- `with-deps/package-lock.json`  
  依赖锁文件。

## 快速结论

如果把这个目录当成示例素材库来看，可以这样理解：

- 想看“安全拦截”就读：`permission-gate`、`protected-paths`、`sandbox`
- 想看“工具扩展”就读：`todo`、`dynamic-tools`、`tool-override`
- 想看“UI 定制”就读：`status-line`、`custom-header`、`custom-footer`、`message-renderer`
- 想看“上下文 / workflow”就读：`plan-mode`、`trigger-compact`、`subagent`
- 想看“provider 接入”就读：`custom-provider-*`
- 想看“高级演示”就读：`doom-overlay`、`snake`、`space-invaders`
