# Koda

Koda 是本地优先的编程智能体，提供命令行（CLI）、交互式终端（TUI）和实验性的 macOS 图形界面。它在本机管理模型对话、工具调用、审批、事件记录与中断恢复。

项目仍在开发中。macOS CLI/TUI 和 SwiftUI 图形界面可用于**未签名的内部预览**；公开签名、公证和 Homebrew 发布尚未完成。

## 能做什么

- 使用 OpenAI、Anthropic、DeepSeek、Kimi 或 GLM 运行编程任务；支持会话续接、上下文压缩和本地历史检索。
- 读取工作区、提出文件修改和运行命令。写入与执行默认需要逐项审批；工具调用和结果记录在只追加的 JSONL 日志中。
- 在 macOS 和 Linux 上通过原生执行器运行受保护的 Pipe/PTY 命令。执行策略和各平台支持范围见[执行安全说明](docs/security/execution-security.md)。
- 接入本地 MCP 服务、项目 Skill、命令模板和本地插件；可在 TUI 中查看历史、工件、审批与恢复状态。
- 在自有局域网或 VPN 中，按设备授权查看指定工作区和会话。远程任务默认只读；主机明确授予权限后，macOS 客户端可逐次请求写入或命令执行，并对每次实际操作单独审批。

## 快速开始

开发环境需要 Node.js 22.20+、pnpm 10.28.2、Rust 1.85+ 和 Cargo。CLI 搜索工具另需安装 `rg`。

```bash
pnpm install --frozen-lockfile
pnpm build
```

配置工作区和模型。`setup` 只保存不含密钥的偏好，不会联网；只有显式添加 `--check` 才会向所选服务提供商发送一次连接测试请求，可能消耗配额。

```bash
node apps/cli/dist/main.js setup --cwd .
export OPENAI_API_KEY='<your-key>'
node apps/cli/dist/main.js run "解释这个仓库" --cwd .
```

默认使用 OpenAI。其他服务提供商可用 `--provider anthropic|deepseek|kimi|glm` 选择，并在当前 Shell 中设置对应的 `ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`、`MOONSHOT_API_KEY` 或 `ZAI_API_KEY`。可用 `--model` 指定模型；只需配置当前所选服务提供商的凭据。

CLI 会打印 Thread ID，之后可在相同工作区续接；交互式终端使用同一套本地会话和审批机制：

```bash
node apps/cli/dist/main.js run "继续任务" --cwd . --resume <thread-id>
pnpm chat --cwd .
```

可以从已有 Thread 启动一个独立的子 Thread，并查询其来源与直接子项：

```bash
node apps/cli/dist/main.js run "独立检查这个问题" --cwd . --parent <thread-id> --approval-mode never
node apps/cli/dist/main.js thread show <child-thread-id>
node apps/cli/dist/main.js thread children <thread-id>
```

`--parent` 要求父 Thread 存在且属于同一工作区；子 Thread 有自己的对话历史，不继承父 Thread 的模型上下文。需要只读任务时，显式使用 `--approval-mode never` 拒绝写入和命令执行。

模型也可调用 `delegate_readonly` 同步派遣只读子任务：每轮最多两个子任务，每个最长两分钟。子任务使用独立 Thread，仅能读取工作区和项目 Skill；不能写文件、执行命令、加载 MCP／插件或再次派遣。完成后，父 Thread 收到子 Thread ID、状态和有界回答。

App-server 的 `turn/steer` 可向运行中的指定 Thread/Turn 排队发送消息；TUI 运行中也可直接输入并按回车发送。每个 Turn 最多暂存 16 条，每条最多 4096 UTF-8 字节。消息在下一次模型请求前写入事件日志并进入上下文；末次模型请求开始后或 Turn 结束时拒绝新消息。

模型可调用 `spawn_readonly` 异步启动只读子任务，或调用 `spawn_worktree` 请求创建可写子任务。后者必须先获得一次明确审批：Koda 从当前 Git HEAD 在 `KODA_HOME/worktrees` 创建独立工作区，子任务只能使用文件修改工具，不能执行命令、加载 MCP／插件或再次派遣；原工作区的未提交改动不会复制，完成后也不会自动合并。审批预览会列出任务、源提交及隔离范围。父任务可用 `wait_children` 查询／等待、`send_child_message` 发送下一步消息或 `interrupt_child` 中断，并从结果中取得 worktree 路径供检查。每个父 Turn 最多启动两个子任务，每个应用进程最多同时运行八个，子任务最长运行两分钟。实时消息和中断只适用于当前应用进程内；进程重启后，`wait_children` 可从事件日志读取已完成子任务的结果。

多子任务与项目笔记的离线验收范围见 [Phase 5 场景矩阵](docs/plans/2026-09-27-phase-5-scenario-matrix.md)。

项目笔记由用户显式维护，按真实工作区路径存放在 `KODA_HOME/memory/project-notes.db`，不会自动从对话中写入：

```bash
node apps/cli/dist/main.js memory add "发布流程" --file ./release-note.md --workspace .
node apps/cli/dist/main.js memory list --workspace .
node apps/cli/dist/main.js memory show <note-id> --workspace .
node apps/cli/dist/main.js memory edit <note-id> --file ./updated-note.md --workspace .
node apps/cli/dist/main.js memory search "签名" --workspace .
node apps/cli/dist/main.js memory delete <note-id> --workspace .
```

每个工作区最多 64 条笔记，每条正文最多 8192 UTF-8 字节。模型只能调用 `search_project_notes` 和 `read_project_note` 读取当前工作区笔记；内部子任务也只读共享父工作区的笔记，worktree 子任务按源工作区检索。笔记内容不会自动加入提示词。检索采用有界词面匹配，固定的八个离线查询用例达到 Recall@3 = 1、MRR = 1；这只是回归基线，不能代表真实项目查询的准确率。

已安装的预览版使用 `koda setup`、`koda run` 和 `koda-chat`。凭据来自启动进程的环境变量，不写入工作区设置或会话日志。工作区写入、进程执行以及未明确归类为只读的 MCP 工具默认需要审批。

## macOS 内部预览

在 Mac 上构建当前架构的独立 CLI 安装包，并安装到当前用户目录（无需 `sudo`）：

```bash
pnpm preview:build
pnpm preview:install
pnpm preview:status
```

如果 `~/.local/bin` 不在 `PATH` 中，先执行 `export PATH="$HOME/.local/bin:$PATH"`，再运行 `koda doctor`。可用 `pnpm preview:rollback` 回到上一个版本；`pnpm preview:uninstall --yes` 只卸载预览版拥有的启动入口和版本状态，不删除凭据、会话或工件。独立安装包的构建与校验也可用 `pnpm bundle:macos --output dist/release/local-arm64`。发布流程和凭据要求见 [macOS 发布手册](docs/release/macos-public-preview-runbook.md)。

原生 SwiftUI 应用位于 `apps/macos-gui`。在 Apple Silicon Mac 上构建未签名的本地 `.app`：

```bash
pnpm bundle:macos
apps/macos-gui/package-preview.sh dist/Koda.app dist/release/arm64/koda
open -a ./dist/Koda.app
```

Intel Mac 把路径中的 `arm64` 改为 `x64`。图形界面可管理本地会话，并提供远程连接的内部预览；其签名安装和公开更新仍在等待发布凭据。当前实现与验收范围见 [macOS 图形界面设计](docs/plans/2026-09-27-macos-swiftui-gui-design.md)。

## 远程访问

远程入口需显式启动，面向同一使用者的受信设备。主机先登记工作区，再为每台设备单独签发令牌；服务端需要含主机地址 SAN 的 TLS 证书与仅所有者可读的私钥。

```bash
koda remote workspace add project --path /absolute/path/to/project
koda remote device issue macbook --workspace project
koda remote serve --host 192.168.1.10 --port 8443 --cert /absolute/path/server.pem --key /absolute/path/server-key.pem
```

默认令牌只有读取权限。远程启动任务或取消任务，分别需要显式签发 `turn:start` 或 `turn:control`；任务会使用主机的模型凭据并可能消耗配额。允许写入或命令执行时，需在主机上分别签发 `workspace:mutate` 或 `process:control`，并同时签发 `thread:read,approval:resolve`，例如：

```bash
koda remote device issue macbook --workspace project --permissions workspace:read,thread:read,turn:start,workspace:mutate,approval:resolve
```

主机 `mcp.json` 中的本地 stdio 服务器或 `{"transport":"streamable_http","url":"https://…/mcp"}` 服务器，可通过 `remote_tools: ["tool_name"]` 显式允许远程工具名。先在主机运行 `koda mcp inspect <server-id>`，审阅工具定义并把输出的 SHA-256 写入该服务器的 `remote_tool_digests: {"tool_name":"<sha256>"}`；定义变化或缺少摘要时，远程调用会被拒绝。然后用 `--permissions workspace:read,thread:read,turn:start,approval:resolve,mcp:invoke --mcp-servers <server-id>` 向指定设备授权。未列出的服务器和工具不进入远程目录；有副作用的 MCP 调用仍需逐项审批。HTTPS 端点使用系统 TLS 信任并拒绝重定向；OAuth 尚未实现，需要 OAuth 的服务器暂不可用。

客户端按 Turn 选择副作用范围，每次实际写入或执行仍需在当前审批设备预览并批准；审批五分钟过期，拒绝或超时不会执行该调用。当前审批设备可输入另一台已授权设备的 ID 显式转交单次审批，目标设备可从远程窗口顶部复制自己的 ID；转交不延长有效期。客户端必须核对主机证书指纹。现有 Thread 需由主机所有者显式执行 `koda remote thread expose <thread-id> --workspace project` 才会对远程设备可见。macOS 远程窗口可按游标回放助手文本和事件状态；普通活动流不投射工具参数与结构化主机路径。仅对明确授予 `thread:events:full` 的设备，主机提供 `/v1/threads/<id>/events/full` 和 WebSocket `view=full` 的原始事件载荷；其中可能包含路径、工具参数和输出。超出响应或帧上限的单条事件可通过 `/v1/threads/<id>/events/<sequence>?afterByte=<offset>` 分段读取并校验摘要。有 `approval:resolve` 权限的设备可查看待审批操作的确切参数与路径，助手文本也可能引用工作区内容。主机崩溃后，已中断请求的重试会返回 `interrupted`，旧进程的审批不会在新进程中生效；审批归属的持久恢复与双设备真实网络验收尚未完成，具体边界见 [远程操作设计](docs/plans/2026-09-27-phase-4d-remote-operation-design.md)。

## 扩展与本地数据

- 项目 Skill：`<scope>/.koda/skills/<name>/SKILL.md`；命令模板：`<scope>/.koda/commands/<name>.md`。参阅 [Skill 与扩展设计](docs/plans/2026-08-28-phase-3h-skills-extension-system-design.md)。
- MCP 和插件只从用户明确配置的本地来源加载。插件工具遵守运行时策略与审批；安装的托管插件默认停用。参阅 [MCP 设计](docs/plans/2026-08-26-phase-3b-mcp-client-design.md)和[插件供应链设计](docs/plans/2026-09-27-phase-4e-plugin-and-update-supply-chain-design.md)。
- 事件日志默认位于 `~/.koda/threads`，可用 `KODA_HOME` 更改。SQLite 是可重建的搜索索引，JSONL 日志是权威记录。大型工具输出以内容寻址工件保存；中断后的不确定副作用不会自动重试。

无需模型凭据即可查看本地会话和预览待回收工件：

```bash
node apps/cli/dist/main.js thread list --workspace .
node apps/cli/dist/main.js thread show <thread-id>
node apps/cli/dist/main.js artifact gc
```

## 开发与文档

```bash
pnpm format:check
pnpm typecheck
pnpm test
pnpm eval:scenarios
```

`pnpm build` 会先构建 Rust 原生执行器，再构建 pnpm 工作区包。核心代码位于 `packages/`，CLI、TUI、app-server、分发工具和 macOS 图形界面位于 `apps/`，原生执行器位于 `native/koda-exec/`。

- [架构设计](docs/plans/2026-08-26-koda-agent-architecture-design.md)
- [Phase 3 功能路线图](docs/plans/2026-08-26-phase-3-roadmap.md)
- [Phase 4 安全与运行时路线图](docs/plans/2026-08-28-phase-4-roadmap.md)
- [macOS CLI/TUI 发布设计](docs/plans/2026-08-31-macos-cli-release-design.md)
- [macOS 发布手册](docs/release/macos-public-preview-runbook.md)

模型可以提出操作；验证、策略、审批和执行由 Koda 运行时负责。
