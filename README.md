# Koda

Koda 是一个仍在开发中的本地优先编程智能体运行时，提供命令行工具（CLI）和交互式终端界面（TUI）。目前尚无 macOS 图形桌面应用。

项目围绕编程模型构建控制层：类型化的会话状态、确定性的模型与工具循环、运行时校验的工具、只追加事件、取消与恢复机制，以及明确的安全边界。

## 当前状态

Phase 3 本地智能体基础、Phase 4A 工作区变更崩溃恢复、Phase 4B 原生进程托管、Phase 4C1 执行策略与报告、Phase 4C2A macOS Seatbelt、Phase 4C2B Linux Bubblewrap、Phase 4C3 密钥生命周期与客户端呈现、Phase 4C4A 资源策略与客户端呈现、Phase 4C4B macOS 资源限制，以及 Phase 4C4C1 契约演进均已完成；Linux 资源限制仍待 C4C2 至 C4C4 完成。

通过验证的 macOS 和 Linux 原生执行器会声明并执行受保护的 Pipe/PTY 命令。macOS 还通过 `RLIMIT_CPU`、`RLIMIT_NOFILE` 和 `RLIMIT_FSIZE` 实施精确的单进程 CPU 时间、打开文件数和文件大小硬限制；验证实际限制值、持久化记录 `applied` 证据后才运行用户代码。原生协议 v8、持久化格式 v8（精确兼容 v1 至 v7 恢复）、app-server v18 资源证据、授权绑定、后台 PTY 恢复、安全的密钥生命周期证据，以及系统调用、网络和资源的对抗性测试已有相应实现或验证。当前策略 v3 和能力／安全 v5 将基于 cgroup 的维度称为 `job_task_count`；冻结的策略 v2／安全 v4 记录保留 `job_process_count` 原意，不作重新解释。Linux 和 Windows 的资源限制请求仍会在不支持时拒绝；macOS 的地址空间和整个任务树的任务数限制也尚不支持。

Windows 沙箱和资源限制仍待实现。Koda 已具备可选的 Rust 执行 Supervisor：使用版本化本地协议、可重连的任务观察、POSIX 进程组、Windows Job Object 与 ConPTY、有界的保留输出、明确的原生能力报告，以及贯穿执行过程的策略证据。

当前交付重点是 [Mac Release 1A](docs/plans/2026-08-31-macos-cli-release-design.md)：自包含的 macOS CLI/TUI 开发者预览版，包含内置 Node 运行时、匹配的原生执行器、严格的安装诊断、arm64/Intel 原生构建，以及签名、公证和 Homebrew 分发。其余 Linux 资源限制与 Windows 安全功能暂缓；已有跨平台 CI 继续作为回归检查。

MR1A1 至 MR1A3 已完成：统一版本来源、严格的运行时与完整性清单、源码／发布版识别、关键文件完整性校验、统一的 `koda`／`koda-chat` 入口，以及可复现、脱离仓库运行的 macOS arm64 安装包。安装包内含 Node.js、发布版 `koda-exec` 和对应架构的原生扩展，并通过完整诊断和真实 app-server／原生执行器冒烟测试。arm64 和 Intel 原生 CI 会保留未签名产物、比对同一提交的发布元数据、验证全新解包和损坏文件拒绝，并通过隔离的 Homebrew Tap 安装和测试生成的 Formula。MR1A4 的 Node OpenPGP 来源校验、Mach-O Developer ID 签名与审计、精确 ZIP 公证、发布证据、GitHub 预发布和公开 Tap 更新流程已实现。安全的服务提供商设置、启动提示和显式连接检查也已实现；Apple 签名凭据，以及首次在干净机器上安装公开版并连接真实服务提供商的验收，仍未完成。受保护的 GitHub Environment、`v*` 标签规则、公开 [`homebrew-koda`](https://github.com/ronaldo123321/homebrew-koda) 仓库、Tap 仓库变量和限定仓库范围的 Tap 令牌密钥已配置；Apple 凭据尚未配置。

因此，MR1A4 正等待 Apple Developer Program 账号。期间继续进行未签名 macOS 内部测试和 CLI/TUI 体验改进；在具备凭据前不会创建公开的 `v0.1.0` 标签，也不会降低签名和公证要求。

macOS arm64 未签名预览版的 UX1 本机真实使用验收已完成，涵盖服务提供商连接检查、CLI/TUI 对话、审批、文件修改、命令执行、后台终端和重启恢复。验收中曾有一次原因未明的 `PROVIDER_REQUEST_FAILED`，后续重试成功；请求可靠性仍需继续排查。详见 [UX1 验收记录](docs/plans/2026-09-01-macos-preview-ux1-onboarding-design.md)。

未签名内部预览版安装器已实现：使用用户目录中的版本化存储，原子切换 `current`／`previous`，严格检查发布包完整性与原生运行，提供稳定启动入口、精确回滚、崩溃恢复和所有权校验后卸载。macOS 发布工作流也在 arm64 和 Intel 原生环境验证无凭据安装流程；实现提交 `50ae01c` 在 [macOS Release Contract 运行 33505291467](https://github.com/ronaldo123321/koda/actions/runs/33505291467) 中通过两种架构的检查。这仍是未签名内部测试路径，不代表 MR1A4 完成。

Phase 4C3A/C3B/C3C/C3D 已完成：严格的不含密钥值的声明和证据、跨 TypeScript／Rust 稳定一致的摘要与限制、按原始字节流工作的脱敏器、固定的可信应用目录、将宿主环境变量解析为一次性内存租约，以及每条涉密命令的重新审批。C3C 加入不可重放的原生启动认证交换、每任务 `0700` 目录和 `0400` 文件、声明的 `*_FILE` 目标、精确的 Seatbelt／Bubblewrap 只读路径、Pipe/PTY 输出持久化前脱敏及不含密钥值的清理证据。C3D 加入 app-server v16 证据、持久化进程／结果呈现，以及 CLI/TUI 的有界摘要。实现提交 `7a34668` 在 [GitHub Actions 运行 33354068315](https://github.com/ronaldo123321/koda/actions/runs/33354068315) 中通过同一提交的 Linux、macOS、Windows 验收矩阵。

- 版本化的 Thread、Turn、Item 和 Agent Event 模式。
- 与服务提供商无关的流式模型接口。
- 运行时校验的工具注册表。
- 模型 → 工具 → 模型的智能体循环。
- OpenAI Responses、Anthropic Messages 适配器，以及经过审查的 DeepSeek、Kimi、GLM Chat Completions 配置。
- 显式选择服务提供商、各自的凭据和默认值、统一的用量与错误，以及离线适配器一致性测试。
- 对 Anthropic 已签名思考块和国内服务提供商 `reasoning_content` 的有界持久化续接状态，跨工具轮次、上下文压缩和恢复保留。
- 限定在工作区内的 `list_files`、`read_file` 和字面文本 `search_text` 工具。
- 对单个 UTF-8 文件进行精确创建或替换的 `apply_patch` 工具。
- 运行时写入策略、持久化审批事件和终端补丁预览。
- SHA-256 快照校验与同目录原子写入。
- 始终使用 `shell: false` 的结构化 `exec_command` 工具。
- 限定工作区的命令目录、过滤后的环境、有界输出、超时与取消。
- 按明确目录作用域、有界地发现嵌套的 `AGENTS.md` 和 `KODA.md`，从宽到窄稳定排序并记录摘要。
- 与服务提供商无关的单次响应 Token 用量事件和 Turn 汇总。
- 单轮 `koda run` 命令及 JSONL 事件持久化。
- 通过标准化本地历史重放，跨进程执行 `koda run --resume <thread-id>`。
- 每轮上下文快照、全局连续事件序号与类型化恢复提示。
- 保守恢复未完成的工具调用：报告不确定的副作用，绝不自动重试。
- 本地 Thread 租约，阻止两个活跃 CLI 进程写入同一日志。
- 读取、搜索和命令的大型输出以 SHA-256 内容寻址工件存储。
- 面向模型统一提供 64 KiB 摘录、准确字节数及可取回的完整输出。
- 有界 `read_artifact` 工具、缺失或损坏工件的恢复诊断，以及过期临时文件清理。
- 每次模型步骤 256 KiB 的服务提供商输出保护限制，及每条流 64 MiB 的工件硬限制。
- 与服务提供商无关的 `ContextEngine`，支持配置输入预算、保守 Token 估算和实测用量校准。
- 只追加的结构化上下文压缩，精确保留 Item ID，并原子保留工具调用与结果。
- 校验压缩元数据的恢复过程，并显示仓库指令的新增、删除和修改。
- 轮次中途压缩后重置 OpenAI 响应链，并预留配置的 `max_output_tokens`。
- 策略和审批之后、处理器执行之前，持久化记录 `tool.execution_started` 边界。
- 与原工具调用关联的类型化进程启动、退出、终止尝试和终止结果事件。
- POSIX 进程组所有权、从温和到强制的终止升级、后代清理及有界确认。
- 独立 Rust `koda-exec` Supervisor，使用同用户私有 Unix Socket 或认证的 Windows Named Pipe；具备严格的长度前缀帧、能力协商、幂等启动、可重连状态／输出读取，且不会悄悄回退到 TypeScript。
- 启动时冻结的执行配置、与策略绑定的精确命令授权、审批前准入证据，以及 TypeScript Pipe、原生 Pipe 和原生 PTY 的启动安全快照。
- 原生 POSIX 进程组和 Windows Job Object 所有权；Worker 托管的 POSIX PTY 与 Windows ConPTY 支持后台任务、连接／断开、输入权隔离、终端尺寸调整、重启连续性和有界终端输出。
- TypeScript 兼容后端在 Windows 使用感知进程树的 `taskkill` 回退，并如实报告不确定性，不冒称具备原生 Job Object 保证。
- 结构化中断操作恢复：报告副作用与进程证据，不重放副作用，也不凭历史 PID 终止进程。
- 可重建的 SQLite v2 Thread 元数据投影与有界历史搜索；JSONL 始终是权威记录。
- 无需凭据的 `koda thread list` 和 `koda thread show`，按规范化工作区过滤。
- 基于 WAL 的并发元数据写入、源指纹刷新、无效日志可见性和损坏数据库隔离。
- 运行后尽力建立索引，但派生数据库不会凌驾于 JSONL 之上。
- 仅从有效 JSONL 推导引用的工件垃圾回收，使用全局维护租约及保守的并发检查。
- 无需凭据的 `koda artifact gc` 预览，以及指定 `--delete` 和最小保留时间的删除。
- 六个确定性二进制场景：续接、上下文压缩、提示注入、进程树取消、工件读取和不确定副作用恢复。
- CLI 和协议客户端共用 `KodaApplication` 工作流。
- 通过本地标准输入／输出运行、严格且版本化的逐行 JSON-RPC 2.0 app-server。
- 先持久化再通知的事件流、单次交互审批、活跃 Turn 取消，以及正常关闭／EOF 清理。
- 无需凭据的 app-server Thread 列表、详情和搜索；有界双向 JSONL 事件历史；不同 Thread 的并发由各自租约约束。
- 可复用的 Node app-server 客户端，具备严格 NDJSON 帧、类型化 JSON-RPC 关联、有界 stderr 诊断、请求超时和自有子进程清理。
- Ink `koda-chat` REPL 仅通过 app-server v18 提供顺序对话、审批、Thread 浏览、持久化搜索、分页历史、运行时设置、工件、上下文、Plan、扩展、活动、进程／密钥／资源证据、变更恢复检查、Stage 验收和续接。
- 基于权威 JSONL 的双向类型化 `thread/events` 分页，使用排他的序号游标、每页最多 200 事件、768 KiB 结果预算及明确的损坏／超限错误。
- 基于标准化 SQLite 子串投影的修订版分页 `thread/search`：查询不超过 256 字节、最多八词 AND、512 字节摘要、结果约 256 KiB。
- 仅在空闲时使用 `/threads`、`Ctrl+T` 和 `/search <query>` 浏览当前规范化工作区；提供以命中位置为中心的权威预览、续接前元数据复查和服务提供商／模型配置继承。
- 预览窗口最多 400 事件／200 行、缓存 500 条搜索结果、随终端尺寸变化的 5 至 30 行视窗、PageUp/PageDown/Home/End 导航和过期响应代次检查。
- 按工作区保存服务提供商／模型偏好，使用修订版检查的原子持久化、损坏文件隔离和凭据可用性元数据；不传输或存储 API Key。
- 仅在空闲时使用 `/settings` 选择服务提供商或编辑模型 ID；提供显式应用、逐层 Escape、启动优先级，以及当前 Thread 与下一新 Thread 的不同配置。
- `thread/artifacts` 发现与 `artifact/read` 区间读取通过规范化工作区和权威 JSONL 引用授权，并校验 ArtifactStore 的大小、SHA-256、普通文件类型和 UTF-8。
- 仅在空闲时使用 `/artifacts`、`/artifact <id>` 和预览键 `a`；按新到旧去重、16 KiB 双向字节分页、按终端宽度换行、拒绝过期响应并逐层退出。
- 已完成对话静态输出加一个有界实时区域，使用普通终端滚动历史；支持 `/help`、`/status`、`/clear`、`/new`、`/exit`、`Esc` 取消／导航和按上下文工作的 `Ctrl+C`。
- 官方 MCP v2 客户端接入显式配置的本地 stdio 服务，每个 Turn 使用独立会话。
- 冻结且校验过的 MCP 工具目录以稳定的 `mcp__<server>__<tool>` 别名呈现，不将 MCP 引入 `agent-core`。
- 仅在模型步骤之间原子刷新 MCP 命名空间代次；完整验证候选目录，不暴露部分结果。
- 准备好的调用绑定目录代次，并保留目录差异、精确恢复链校验及续接时的累计变更证据。
- MCP 副作用采取保守策略：外部工具默认需要审批，只有明确审查过的 `read` 工具可以免审。
- MCP 调用超时、Turn 取消、逆序清理子进程、有界的二进制／结果规范化、大输出工件存储，以及保守的中断调用恢复。
- 通过 NDJSON JSON-RPC 使用用户显式配置的本地插件；每个活跃插件和 Turn 使用独立的受控进程。
- 必需／可选插件的事务式启动、能力允许清单、过滤后的命名环境、有界诊断、逆序关闭和进程树清理。
- 插件工具遵循普通策略与审批；有命名空间且不可变的插件 Skill 和命令模板由现有解析器校验。
- 内置且不依赖服务提供商的 `update_plan` 控制工具维护有界的 Thread 级 Plan／Stage／Todo 状态机。
- 持久化安全检查点、感知 Plan 的步骤／时间暂停、精确恢复校验，以及在上下文压缩后仍保留的当前 Plan。
- app-server `plan/get` 与精确匹配活跃请求的 `plan/acceptance/resolve`，以及 CLI／Ink 的 `/plan`、验收、拒绝反馈和恢复视图。
- 严格发现 `<scope>/.koda/skills/<name>/SKILL.md`：从宽到窄确定性排序、字节／数量预算、规范化路径限制和遇到符号链接时保守拒绝。
- 有效指令中使用有界 Skill 元数据；通过内置 `read_skill` 读取不可变正文，并持久化目录快照、续接变更和当前来源检查。
- 严格解析 `<scope>/.koda/commands/<name>.md` 提示模板：有界字符串参数、单次字面替换、显式 CLI／Ink `/template` 激活，且不运行处理器。
- 无需凭据的协议 v17 `extension/catalog`、`extension/read` 和 `thread/extensions`；CLI 直接检查与仅空闲时可用的 Ink `/extensions` 会区分当前和历史内容。
- 崩溃后仍可恢复的 `apply_changes` 与 `apply_patchset` 日志：同步原始备份、端点／暂存证据、保守的重启分类、安全自动回滚、Thread 审计对账，以及分歧后的写入拒绝。
- 无需凭据的冲突列表／检查、绑定状态令牌的备份导出、显式 `restore-original` 与 `accept-current` 解决、幂等 `workspace.change_set_resolved` 审计、协议／CLI／TUI 客户端和重启安全的待决回执。
- 对已证实成功的本地读取显示紧凑的实时工具活动与确定性完成摘要；审批、修改、执行、外部调用、失败、回滚和不确定操作仍逐项可见。
- 仅空闲时可用的 `/activity` 对完整持久化执行记录分页；32 毫秒合并助手文本增量通知，同时保留精确最终输出并立即刷新语义事件。
- 离线的服务提供商、运行时、CLI 及确定性智能体循环测试。

Phase 3 基线之后仍有明确暂缓项：服务提供商辅助的语义压缩、精确 Token 计算和定价、自定义端点／配置、在线模型发现、自动路由／回退、跨服务提供商续接、更多服务提供商、FTS5／模糊／实时／跨工作区搜索、终端备用屏幕、丰富的 Markdown／语法／差异渲染、二进制工件查看、重叠／模糊／目录级文件变更，以及 MCP 的非工具能力。Phase 4A 提供崩溃后持久化日志、安全自动回滚、审计对账、冲突写入阻断和显式人工解决；Phase 4B 提供重启后仍有效的原生进程所有权、PTY／后台任务及连接、POSIX 进程组、Windows Job Object 和 ConPTY。更完整的沙箱、远程 MCP／HTTP／OAuth、共享存储、远程 app-server、签名发布和高风险 Shell 字符串能力仍属后续 Phase 4 工作。父子 Thread 关系和多智能体场景矩阵属于 Phase 5。工作区写入、进程执行及未明确标为只读的 MCP 工具默认都需要审批。

## 构建独立的 macOS 安装包

在 Apple Silicon Mac 上构建并验证本地独立安装包：

```bash
pnpm install --frozen-lockfile
pnpm bundle:macos --output dist/release/local-arm64
```

输出目录必须不存在。组装过程会构建发布版 `koda-exec`、固定并验证 Node.js 22.20.0、拒绝混合架构的 Mach-O 文件和载荷中的符号链接，在仓库外运行 `koda --version`、完整安装包诊断及 app-server／原生执行器握手，然后生成确定性的压缩包、`.sha256` 文件和严格的 `.release.json` 元数据。可运行与 CI 相同的全新解包和损坏文件拒绝验收：

```bash
node apps/distribution/dist/release-main.js verify \
  --archive dist/release/local-arm64/koda-v0.1.0-darwin-arm64.tar.gz \
  --metadata dist/release/local-arm64/koda-v0.1.0-darwin-arm64.release.json \
  --corruption-check
```

直接运行解包后的候选版本：

```bash
dist/release/local-arm64/koda/bin/koda --version
dist/release/local-arm64/koda/bin/koda doctor --bundle-only
dist/release/local-arm64/koda/bin/koda
```

这是未签名的本地开发者预览包。MR1A3 提供双架构原生 CI 产物及生成、测试 Formula 的流程。MR1A4 的受保护标签工作流负责 Developer ID 签名、Node 校验和签名验证、公证、发布 GitHub Release 和更新公开 Tap；运行前必须按[发布操作手册](docs/release/macos-public-preview-runbook.md)配置受保护的凭据和环境。

## 安装未签名的 macOS 内部预览版

构建当前原生架构，并在不使用 `sudo` 的情况下安装到 `~/.local/share/koda-preview`：

```bash
pnpm preview:build
pnpm preview:install
pnpm preview:status
```

如果 `~/.local/bin` 不在 `PATH` 中，请先在当前 Shell 添加。Koda 会提示这个解决办法，但不会修改 Shell 启动文件：

```bash
export PATH="$HOME/.local/bin:$PATH"
koda --version
koda doctor
```

传入压缩包绝对路径即可安装下载的 CI 候选版本。安装器默认使用同目录的 `.release.json`；必要时可用 `--metadata` 指定元数据文件：

```bash
pnpm preview:install --archive /absolute/path/koda-v0.1.0-darwin-arm64.tar.gz
```

每次升级都会将原先的当前版本保留为 `previous`：

```bash
pnpm preview:rollback
pnpm preview:uninstall --yes
```

卸载只删除预览版拥有的启动入口和版本状态，不删除 `KODA_HOME`、服务提供商凭据、Thread、工件或设置。这些命令会明确报告 `unsigned internal preview`；它们不执行签名、公证或发布，也不代表通过 Gatekeeper 验收。

## 配置工作区

开始任务前，用已安装的 `koda setup` 选择服务提供商和模型。设置只保存不含密钥的工作区偏好；不会要求输入、提示输入或持久化 API Key：

```bash
koda setup --cwd .
koda setup --cwd . --provider deepseek --model deepseek-v4-pro
koda setup --cwd . --provider deepseek --model deepseek-v4-pro --check
koda setup --cwd . --json
```

在终端中省略服务提供商或模型时，命令会显示当前默认值并提示选择。使用管道输入或 `--json` 时，行为是确定性的且不会等待交互。输出会告知凭据环境变量的准确名称及当前是否可用，但不会显示变量值。请在启动 Koda 的 Shell 中设置所提示的变量，例如：

```bash
export DEEPSEEK_API_KEY='<your-key>'
koda chat --cwd .
```

仓库开发构建也可通过 `node apps/cli/dist/main.js setup --cwd .` 使用相同流程。重复保存未变化的设置是幂等的，不会增加设置修订号。

连接检查必须显式指定 `--check`。它通过所选服务提供商适配器发送一次不带工具的最小请求，可能消耗 API 配额；缺少凭据、凭据或模型被拒绝、限流、网络故障、取消或其他有界错误时以状态码 1 退出。它不会输出凭据或原始服务提供商响应。未指定 `--check` 的设置命令不会构造服务提供商实例，也不会发起网络请求，因此可以在尚无凭据时安全地保存偏好。

## 远程访问准备

首版远程访问面向同一使用者的多台设备，使用局域网或自有 VPN。当前已提供按需启动的只读 HTTPS 入口；设备可以查询获授权的工作区 ID，以及已绑定 Thread 的脱敏概要。远程客户端、任务控制、事件重连和自动配对仍在开发中。

在作为服务端的 Mac 上登记工作区和设备：

```bash
koda remote workspace add project --path /absolute/path/to/project
koda remote workspace list
koda remote device issue macbook --workspace project
koda remote device revoke <device-id>
```

签发命令默认只授予 `workspace:read,thread:read`；如需其他权限，可在签发时用 `--permissions` 指定逗号分隔的权限。令牌只在签发时显示一次，主机仅保存其摘要；请将令牌交给目标设备并妥善保存。每台设备单独签发，丢失时按设备 ID 撤销并重新签发。

准备带有服务端 IP 地址 SAN 的 TLS 证书及仅所有者可读的私钥，然后显式启动监听。例如主机的内网地址是 `192.168.1.10` 时：

```bash
koda remote serve --host 192.168.1.10 --port 8443 --cert /absolute/path/server.pem --key /absolute/path/server-key.pem
```

服务端拒绝公网和通配监听地址。客户端必须验证证书；自签名证书需预先信任或固定其指纹。`GET /v1/workspaces` 和 `GET /v1/threads/<thread-id>` 要求 `Authorization: Bearer <device-token>`，返回结果不含主机路径。当前没有自动登记既有本地 Thread 的命令，也没有 WebSocket 事件流，因此这两个只读接口不能视为远程操作验收通过。

## 使用 CLI

构建 Koda，为一个内置服务提供商提供凭据，然后在工作区运行任务。默认使用 OpenAI：

```bash
pnpm build
export OPENAI_API_KEY=...
node apps/cli/dist/main.js run "解释这个仓库" --cwd .
```

通过 `--provider` 或 `KODA_PROVIDER` 选择其他服务提供商：

```bash
export ANTHROPIC_API_KEY=...
node apps/cli/dist/main.js run "解释这个仓库" --cwd . --provider anthropic

export DEEPSEEK_API_KEY=...
node apps/cli/dist/main.js run "解释这个仓库" --cwd . --provider deepseek
```

| 服务提供商  | 凭据环境变量        | 默认模型          |
| ----------- | ------------------- | ----------------- |
| `openai`    | `OPENAI_API_KEY`    | `gpt-5.6-terra`   |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| `deepseek`  | `DEEPSEEK_API_KEY`  | `deepseek-v4-pro` |
| `kimi`      | `MOONSHOT_API_KEY`  | `kimi-k2.6`       |
| `glm`       | `ZAI_API_KEY`       | `glm-5.2`         |

只需要当前所选服务提供商的凭据。`--model` 或 `KODA_MODEL` 可以覆盖其默认模型。续接 Thread 时必须使用原服务提供商；跨服务提供商续接会在发起模型请求前被拒绝。

Koda 在 Turn 开始时打印生成的 Thread ID。之后可在相同的规范化工作区内，从另一个 CLI 进程继续：

```bash
node apps/cli/dist/main.js run "继续下一项任务" --cwd . --resume <thread-id>
```

Koda 向所选模型提供三种有界的写入形式。`apply_patch` 创建或精确更新一个 UTF-8 文本文件。`apply_patchset` 接受严格的 Koda Patch v1 文档，用于紧凑的逐行编辑；它不是 Git unified diff，所有上下文和删除行都必须恰好匹配一次，不做模糊匹配。`apply_changes` 提供底层结构化事务语法，最多包含 16 个独立创建、有序精确更新、同文件系统移动或删除操作。补丁集和结构化变更集会在一次审批前完整准备并预览，在工作区写入租约下重新校验，普通失败或取消后按逆序补偿。如果回滚无法证明自己正在撤销 Koda 写入的字节，结果会明确标为不确定，必须人工检查，不会自动重试。

Koda Patch v1 使用一组 `*** Begin Patch`／`*** End Patch` 包裹内容。新增段使用 `+` 行；更新段使用 `@@` 区块和空格／`-`／`+` 行前缀；纯移动使用 `*** Move File:` 后接 `*** To:`；删除使用 `*** Delete File:`。更新会保留一致的 LF 或 CRLF 行尾及目标文件末尾换行状态。格式错误、缺失、歧义或混用行尾的区块会在审批前失败。

如果重启恢复过程隔离了外部修改，可以在没有服务提供商凭据的情况下检查。复制最近一次检查返回的准确 `stateToken`；端点或暂存区的任何变化都会使它失效：

```bash
node apps/cli/dist/main.js recovery list --workspace .
node apps/cli/dist/main.js recovery inspect <conflict-id> --workspace .
node apps/cli/dist/main.js recovery export <conflict-id> <operation-index> --workspace . --state-token <sha256> --output ./original.txt
node apps/cli/dist/main.js recovery resolve <conflict-id> --workspace . --state-token <sha256> --action accept-current
node apps/cli/dist/main.js recovery resolve <conflict-id> --workspace . --state-token <sha256> --action restore-original
```

导出会创建权限为 `0600` 的新文件，拒绝覆盖已有路径。`accept-current` 保留工作区当前内容。`restore-original` 从已验证备份替换有分歧的内容，因此应先审阅检查证据。两种决定都会在删除私有恢复日志前，向原 Thread 追加幂等的解决事件。

无需服务提供商凭据即可检查本地 Thread 元数据：

```bash
node apps/cli/dist/main.js thread list --limit 20
node apps/cli/dist/main.js thread list --workspace .
node apps/cli/dist/main.js thread show <thread-id>
```

这些命令查询前会根据变化的 JSONL 日志刷新 `KODA_HOME/state.db`。数据库只是可重建的投影：删除后 Koda 会重新创建；损坏时会保留带时间戳的 `.corrupt-*` 副本，并从 JSONL 重建当前数据。

无需服务提供商凭据，也不启动插件或 MCP 进程，即可检查项目当前的 Skill、命令模板和安全的插件清单元数据：

```bash
node apps/cli/dist/main.js extension list --workspace .
node apps/cli/dist/main.js extension read skill <skill-id> --workspace .
node apps/cli/dist/main.js extension read command-template <template-id> --workspace .
```

## 使用交互式终端聊天

构建 Koda 后，在交互式终端启动 Ink 客户端。先设置所选服务提供商的凭据，即可直接开始模型对话：

```bash
pnpm build
export OPENAI_API_KEY=...
pnpm chat --cwd . --provider openai
```

安装后的命令是 `koda-chat`；也可以直接运行工作区中的构建入口：

```bash
node apps/tui/dist/main.js --cwd . --provider deepseek --model deepseek-v4-pro
node apps/tui/dist/main.js --cwd . --provider openai --resume <thread-id>
```

工作区和审批模式在启动时固定。服务提供商／模型的启动优先级依次为 CLI 参数、环境变量、匹配的工作区偏好和注册表默认值。输入 `/settings` 可打开服务提供商列表和模型编辑器；选择“应用”后会为规范化工作区保存配置，不保存凭据。已有或续接的 Thread 保留原服务提供商／模型，`/new` 则使用为下一新 Thread 保存的选择。普通输入会开始一个 Turn。

`/threads` 或 `Ctrl+T` 可打开当前工作区最近 100 个 Thread。在列表中按 `/` 搜索，或在聊天界面输入 `/search <query>`。搜索对值得展示的持久化历史使用不区分大小写的子串 AND 匹配；按 Enter 打开权威历史并标记命中位置。`/artifacts` 列出当前 Thread 引用的 UTF-8 文本／JSON 工件；`/artifact <sha256:...>` 打开已知引用；在 Thread 预览中按 `a` 可直接查看工件，无需续接。`/context` 列出当前 Thread 已准备的模型请求；在 Thread 预览中按 `c` 打开相同检查器。

`/plan` 可在不启动服务提供商或工具的情况下，查看当前权威 Plan、Stage／Todo 状态、最近安全检查点和恢复证据。`/extensions` 可在不启动服务提供商、MCP 服务或插件的情况下，比较当前工作区目录和所选 Thread 最近的持久化扩展快照。`/activity` 打开当前 Thread 的权威执行记录；PageUp/PageDown 翻页，Home/End 跳到事件边界，Escape 返回聊天界面。`/recovery` 列出隔离的工作区变更；`inspect` 显示精确证据，`export` 将一份验证过的备份写入新路径，`resolve` 暂存解决决定后还需单独执行 `/recovery confirm`。在活跃 Stage 验收卡上按 `y` 可接受，按 `n` 可针对准确的 Plan 修订提交有界修改反馈。

上下文详情显示准确或旧版预算数据、实测用量、当前 Item 身份、上下文压缩状态及仓库指令状态。按 Enter 打开有界的当前指令来源。工件和指令内容使用 PageUp/PageDown 读取相邻的已验证 UTF-8 字节区间，Home/End 到达内容边界。方向键逐行移动；在 Thread 预览中按 `r` 续接，`Esc` 返回上一层。`/new` 只在本地脱离当前 Thread，不删除历史。`/approvals` 列出活跃的精确命令授权，`/approvals revoke <id>` 撤销一项，`/approvals clear` 撤销当前工作区的全部授权。`/help`、`/status`、`/clear` 和 `/exit` 保持各自功能。

审批符合条件的 `exec_command` 时，按 `y` 仅批准本次，按 `a` 对完全相同的规范化命令授权 15 分钟；按 `n` 拒绝，按 `d` 切换详细信息。活跃 Turn 中按 `Esc` 或 `Ctrl+C` 可取消；空闲时 `Ctrl+C` 退出。该客户端要求 TTY；脚本请使用 `koda run` 或 stdio app-server。

即使没有所选服务提供商的凭据，也能启动 TUI，浏览历史、设置、扩展、工件、Plan、进程和恢复信息。启动提示、底部状态栏和 `/status` 会显示凭据是否就绪。凭据缺失时，模型输入会在本地 `turn/start` 之前被阻止；Koda 保留输入，并给出准确的 `koda setup`、`export` 和重启步骤。`/settings` 允许先保存服务提供商／模型偏好。

工作区偏好保存在 `${KODA_HOME:-$HOME/.koda}/settings/workspaces/` 中，以规范化工作区摘要为键，采用有界、版本化文件。API Key 的值只存在于 app-server 的环境中；协议仅暴露指定凭据是否已配置。

## 运行本地 app-server

构建 Koda，在服务进程环境中设置服务提供商凭据，然后启动 stdio 传输：

```bash
pnpm build
OPENAI_API_KEY=... node apps/app-server/dist/main.js
```

进程每行接受一个 UTF-8 编码的 JSON-RPC 2.0 对象。首个请求必须是 `initialize`：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":18,"client":{"name":"my-koda-client","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"turn/start","params":{"prompt":"解释这个仓库","cwd":".","provider":"openai"}}
{"jsonrpc":"2.0","id":3,"method":"thread/events","params":{"threadId":"<thread-id>","limit":200}}
{"jsonrpc":"2.0","id":4,"method":"thread/search","params":{"workspace":".","query":"解析失败","limit":50}}
{"jsonrpc":"2.0","id":5,"method":"settings/get","params":{"workspace":"."}}
{"jsonrpc":"2.0","id":6,"method":"settings/update","params":{"workspace":".","provider":"deepseek","model":"deepseek-v4-pro","expectedRevision":0}}
{"jsonrpc":"2.0","id":7,"method":"thread/artifacts","params":{"workspace":".","threadId":"<thread-id>","limit":100}}
{"jsonrpc":"2.0","id":8,"method":"artifact/read","params":{"workspace":".","threadId":"<thread-id>","artifactId":"sha256:<64-lowercase-hex>","maxBytes":16384}}
{"jsonrpc":"2.0","id":9,"method":"thread/context","params":{"workspace":".","threadId":"<thread-id>","limit":100}}
{"jsonrpc":"2.0","id":10,"method":"context/read","params":{"workspace":".","threadId":"<thread-id>","anchorSequence":42}}
{"jsonrpc":"2.0","id":11,"method":"context/instruction/read","params":{"workspace":".","threadId":"<thread-id>","anchorSequence":42,"sourceId":"ctxsrc:<64-lowercase-hex>","maxBytes":16384}}
{"jsonrpc":"2.0","id":12,"method":"approval/resolve","params":{"turnId":"<turn-id>","callId":"<call-id>","decision":"approved","grant":{"expiresInSeconds":900}}}
{"jsonrpc":"2.0","id":13,"method":"approval/grants/list","params":{"workspace":"."}}
{"jsonrpc":"2.0","id":14,"method":"approval/grants/revoke","params":{"workspace":".","grantId":"grant:<id>"}}
{"jsonrpc":"2.0","id":15,"method":"approval/grants/revokeAll","params":{"workspace":"."}}
{"jsonrpc":"2.0","id":16,"method":"plan/get","params":{"workspace":".","threadId":"<thread-id>"}}
{"jsonrpc":"2.0","id":17,"method":"plan/acceptance/resolve","params":{"threadId":"<thread-id>","turnId":"<turn-id>","callId":"<call-id>","planId":"<plan-id>","planRevision":1,"stageId":"<stage-id>","decision":"accepted"}}
{"jsonrpc":"2.0","id":18,"method":"extension/catalog","params":{"workspace":"."}}
{"jsonrpc":"2.0","id":19,"method":"extension/read","params":{"workspace":".","kind":"skill","sourceId":"skill:<64-lowercase-hex>"}}
{"jsonrpc":"2.0","id":20,"method":"thread/extensions","params":{"workspace":".","threadId":"<thread-id>"}}
{"jsonrpc":"2.0","id":21,"method":"workspace/mutation/conflicts","params":{"workspace":"."}}
{"jsonrpc":"2.0","id":22,"method":"workspace/mutation/conflict/get","params":{"workspace":".","conflictId":"wmc_<64-lowercase-hex>"}}
{"jsonrpc":"2.0","id":23,"method":"workspace/mutation/backup/export","params":{"workspace":".","conflictId":"wmc_<64-lowercase-hex>","stateToken":"<64-lowercase-hex>","operationIndex":0}}
{"jsonrpc":"2.0","id":24,"method":"workspace/mutation/conflict/resolve","params":{"workspace":".","conflictId":"wmc_<64-lowercase-hex>","stateToken":"<64-lowercase-hex>","resolution":"accept_current"}}
```

v18 的 `initialize` 结果会公布 `secretEvidence`、`workspaceMutationRecovery`，以及扩展检查、规划和其他已有能力；还会列出支持的服务提供商、凭据环境变量名称、默认模型和仅反映运行时状态的可用性布尔值。交互进程的列表、连接、读取与终止响应会呈现原生任务保留的、严格不含密钥值的证据；历史任务和非涉密任务不包含该字段。

四个 `workspace/mutation/*` 方法是无需凭据的控制层操作：列表和详情只返回元数据，备份导出需要显式请求且有界，解决冲突必须提供最近一次检查得到的准确状态令牌。`restore_original` 可能替换有分歧的文件内容；`accept_current` 不改变当前内容。这些方法都不会作为智能体工具暴露。成功解决后，Koda 会在对应的不确定事件之后追加 `workspace.change_set_resolved`，再确认恢复日志。

`extension/catalog` 严格发现当前项目扩展，只暴露安全的插件清单元数据，不启动外部进程。`extension/read` 只返回一个当前有效的项目 Skill 或命令模板来源。`thread/extensions` 重读已授权的 JSONL，返回最近或指定锚点的持久化扩展快照，不重新发现历史内容。`thread/events` 按时间顺序返回已验证事件；`beforeSequence` 和 `afterSequence` 是互斥的排他游标，`limit` 范围为 1 至 200。`workspace.change_set_prepared`、`workspace.change_set_committed`、`workspace.change_set_rolled_back` 和 `workspace.change_set_uncertain` 为 `apply_changes` 与 `apply_patchset` 提供有界的路径及摘要证据，不包含文件正文。

`thread/search` 限定规范化工作区，并返回绑定修订版的游标页面。`settings/get` 返回规范化工作区偏好与修订号；`settings/update` 必须提供该修订号，以免并发写入静默覆盖。`thread/artifacts` 在规范化工作区和严格 JSONL 授权后，仅列出按时间倒序去重的引用。`artifact/read` 还要求准确的 Thread 引用，并返回经过完整性校验、有界的 UTF-8 字节范围；`beforeByte` 和 `afterByte` 游标互斥。

每次正式的服务提供商请求前，Koda 会在任何 Compaction Item 之后写入 `context.prepared`。`thread/context` 从新到旧发现这些持久化快照；对旧日志只根据 `model.usage` 呈现信息，不编造缺失的估算值。`context/read` 从权威 JSONL 精确重建当前 Item，并拒绝摘要不匹配。`context/instruction/read` 只接受该授权请求颁发的不透明来源 ID，返回有界的当前内容；它不是通用工作区文件读取接口。`plan/get` 重读已授权的 Thread JSONL，返回最新 Plan、检查点与恢复元数据，不启动执行。`plan/acceptance/resolve` 仅接受准确匹配的活跃待决请求；重启恢复不会将历史验收证据变成可再次使用的权限。

响应与 `turn/event`／`turn/finished` 通知只使用 stdout；诊断信息使用 stderr。客户端通过 `approval/resolve` 回答 `approval.requested`，通过 `plan/acceptance/resolve` 回答 `plan.acceptance_requested`；可仅针对符合条件的命令候选创建有界会话授权，可通过三个 `approval/grants/*` 方法检查或撤销授权，可通过 `turn/cancel` 停止活跃 Turn，结束时应调用 `shutdown`。服务提供商凭据属于服务端配置，从不作为协议字段传输。

## 配置项目 Skill

将 Skill 放在 `<scope>/.koda/skills/<name>/SKILL.md`。`<scope>` 是包含 `.koda` 的目录；嵌套 Skill 仅作用于对应子树，并排在更宽作用域的来源之后。Phase 3H1 仅接受单行的 `name` 和 `description` frontmatter 字段，且名称必须与目录名一致：

```markdown
---
name: code-review
description: 检查变更的正确性、恢复行为和缺失的测试。
---

检查受影响的流程，验证故障边界，并运行针对性测试。
```

Koda 仅注入有界的目录元数据。模型通过 `read_skill` 获取当前 Turn 中一份不可变的 Skill 正文。Skill 文本属于低优先级项目指导，不能注册工具、绕过审批、越出工作区或削弱运行时策略。单文件不超过 48 KiB；每个工作区最多 32 个 Skill，总正文不超过 192 KiB。

## 配置命令模板

将经过审查的提示模板放在 `<scope>/.koda/commands/<name>.md`。参数在 frontmatter 中使用单行 JSON 数组；Phase 3H2 只接受有长度限制的字符串：

```markdown
---
name: review
description: 检查一个目标的正确性和缺失的测试。
parameters:
  [
    {
      "name": "target",
      "description": "相对于工作区的目标路径。",
      "type": "string",
      "required": true,
      "max_bytes": 1024,
    },
  ]
---

检查 {{target}} 的正确性、恢复缺口和缺失的测试。
```

可用 `koda run '/template review {"target":"src/agent.ts"}' --cwd .` 调用根目录模板，也可在 Ink 中输入相同的 `/template` 提示。嵌套模板使用 `packages/ui/review` 等选择器。Koda 在启动服务提供商前冻结并校验目录、进行一次字面替换，并记录来源、参数和渲染后输入的摘要。模板只是普通用户提示，不能定义 argv、环境、副作用、审批、工具或本地斜杠命令处理器。

## 配置本地 MCP 工具

创建 `${KODA_HOME:-$HOME/.koda}/mcp.json`，即可在每个 Turn 启动本地 stdio MCP 服务。默认文件不存在时，MCP 关闭。`KODA_MCP_CONFIG` 可指定相对于进程目录或使用绝对路径的其他配置文件。

```json
{
  "version": 1,
  "servers": {
    "github": {
      "command": "node",
      "args": ["/absolute/path/to/github-mcp-server.js"],
      "cwd": "/absolute/path/to/optional/server-directory",
      "env": ["GITHUB_TOKEN"],
      "startup_timeout_ms": 15000,
      "call_timeout_ms": 60000,
      "tools": {
        "list_repositories": { "effect": "read" }
      }
    }
  }
}
```

`command` 和 `args` 直接传递，不经过 Shell。`env` 只包含父进程环境变量名称，不包含密钥值；子进程仅接收少量运行时基础变量和列入允许清单的变量。变量缺失、`cwd` 为相对或不存在的路径、模式格式错误、目录超限、只读分类过期等情况，都会在模型看到部分目录前使 Turn 失败。

发现的工具默认副作用为 `execute`：在默认 `on-request` 模式下，每次调用都需要审批；在 `never` 模式下会被拒绝。只有审查过该服务的准确工具后，才添加 `{ "effect": "read" }`。MCP 注解只是未受信任的提示，不能降低该策略要求。MCP 工具使用本地 stdio，仅在安全的模型步骤边界刷新完整目录；HTTP／OAuth、资源、提示、采样、征询、通知和跨 Turn 共享会话仍待后续实现。

## 配置本地插件

创建 `${KODA_HOME:-$HOME/.koda}/plugins.json`，即可在每个 Turn 启动经过审查的本地插件。默认文件不存在时，插件关闭。`KODA_PLUGIN_CONFIG` 可显式指定相对于进程目录或使用绝对路径的其他配置文件。

```json
{
  "version": 1,
  "plugins": {
    "reviewer": {
      "command": "node",
      "args": ["/absolute/path/to/reviewer-plugin.mjs"],
      "required": true,
      "capabilities": ["tools", "skills", "command_templates"],
      "env": ["REVIEWER_TOKEN"],
      "tools": {
        "inspect": { "effect": "read" }
      },
      "startup_timeout_ms": 15000,
      "call_timeout_ms": 60000,
      "shutdown_timeout_ms": 5000
    }
  }
}
```

插件 stdout 严格用于 NDJSON JSON-RPC 2.0 协议流量。Koda 协商协议 v1，仅复制并校验所请求的 `tools`、`skills` 和 `command_templates`，为所有贡献的身份加上限定名；必需插件全部正常前不会发布任何能力。可选插件的失败会被隔离并记录，不复制插件 stderr。工具名称变为 `plugin__<plugin-id>__<tool-name>`，默认副作用为 `execute`；清单中可针对准确工具审查并标为 `read`。插件 Skill 和模板必须使用与项目来源相同的完整 Markdown／frontmatter 格式。

插件是使用当前用户操作系统权限运行的普通本地可执行文件。进程隔离和过滤后的环境只是生命周期保护措施，不构成操作系统安全沙箱。Koda 不会从仓库自动发现插件可执行文件、安装软件包、重启崩溃的插件，或让插件跨 Turn 常驻。

`koda extension list` 和协议 `extension/catalog` 会解析清单，但不会执行配置的命令。活跃贡献的元数据只能在正常事务式 Turn 启动后，从持久化 Thread 快照中获取。

无需服务提供商凭据即可预览未引用的旧工件；审阅报告后再决定是否删除：

```bash
node apps/cli/dist/main.js artifact gc
node apps/cli/dist/main.js artifact gc --delete --min-age-hours 24
```

垃圾回收从每条有效 JSONL 事件推导引用关系，不依赖 SQLite。存在活跃 Thread，或日志不完整、损坏、不安全、无法读取时，它拒绝删除任何内容。默认最小保留时间为 24 小时，并且始终默认只预览。

续接会读取并校验本地 JSONL 日志，重建与服务提供商无关的历史，再通过该 Thread 原先选择的服务提供商呈现。旧日志缺少上下文快照、服务提供商或工作区不匹配、Thread 正忙或日志无效时，会保守地拒绝续接。如果旧进程在工具调用中停止，Koda 只报告已持久化的副作用和进程证据，不自动再次执行。操作系统可能复用 PID，因此 Koda 不会仅凭旧进程恢复出的 PID 发送信号。

工具文本过大时，对话记录只保留有界的首尾摘录，完整捕获字节保存在 `KODA_HOME/artifacts/sha256`。工件按内容寻址并去重。模型可用 ID、字节偏移和区间长度调用 `read_artifact`；TUI 只能查看当前或预览 Thread 的 JSONL 已授权的文本工件。缺失或损坏的内容会被明确报告，不会悄悄修复。Koda 会自动删除过期的临时捕获文件；已发布的工件只能通过显式、感知引用的垃圾回收清理。

每次模型请求前，Koda 都会为基础指令、适用的仓库指导、工具模式和活跃对话记录计算预算。默认上下文窗口为 128,000 Token、输出预留 16,384 Token、安全余量 8,192 Token。前两项可通过 `KODA_CONTEXT_WINDOW_TOKENS` 和 `KODA_MAX_OUTPUT_TOKENS` 覆盖。历史超出窗口时，Koda 会向 JSONL 追加结构化压缩记录，保留最新且语义完整的后缀；重启后可重建相同的模型视图，不删除原始事件。

服务提供商默认为 `openai`，可通过 `--provider <provider>` 或 `KODA_PROVIDER` 选择。模型默认采用所选服务提供商的注册配置，可通过 `--model <model>` 或 `KODA_MODEL` 覆盖。运行事件日志默认写入 `~/.koda/threads`，可用 `KODA_HOME` 更改位置。`KODA_EXECUTION_PROFILE` 选择下文所述、启动后固定的执行配置。

Koda 从工作区根目录向下发现 `AGENTS.md` 和 `KODA.md`，排除 `.git`、`.koda`、`node_modules`、符号链接目录和超过 20 层的路径。加载顺序先宽作用域、后窄作用域；同一目录先 `AGENTS.md`、后 `KODA.md`。每个来源只适用于其子树，必须是不超过 64 KiB 的普通 UTF-8 文件，不能覆盖运行时策略或审批。最多发现 32 个文件，总计不超过 256 KiB。如果文件在 Turn 之间变化，续接会记录准确的新增、删除或修改路径，并采用当前版本。

Koda 提议补丁或命令时会打印准确操作并请求审批。逐行 CLI 的 `Approve this action? [y/N]` 每次只批准一项操作。在同一个 TUI／app-server 进程中，符合条件的内置命令可获得 15 分钟授权，范围绑定规范化工作区、准确的标准化 `argv`、工作目录和超时。授权只存在于内存中，可检查、可撤销，最长一小时；不适用于写入、MCP 或插件工具，重启后失效。命令表示为 JSON `argv` 数组，不会重新拼成 Shell 语法。设置 `--approval-mode never` 或 `KODA_APPROVAL_MODE=never` 可拒绝所有写入和进程执行，即使存在匹配授权也一样。

TypeScript 兼容后端运行命令时不提供 stdin，默认超时 30 秒，每条输出流最多保留 64 KiB。在 POSIX 上，每条命令拥有独立进程组；超时、取消、输出故障或仍存活的后代进程会触发 `SIGTERM`，经过宽限期后按需发送 `SIGKILL`。Windows 回退方案使用感知进程树的 `taskkill`；无法确认终止时会明确报告不确定性。这些保护措施不是安全沙箱：经批准的可执行文件或仓库脚本仍以当前用户的操作系统权限运行。

执行策略默认为 `unconfined`，可在启动前通过 `KODA_EXECUTION_PROFILE` 选择。通过真实 Seatbelt 启动自检的 macOS 原生执行器，以及通过精确 Bubblewrap／命名空间／seccomp 启动探测的 Linux 原生执行器支持 `read-only` 和 `workspace-write`；TypeScript 和 Windows 后端会在审批或创建任务前拒绝这些配置，不会静默降级：

```bash
export KODA_EXEC_PATH="$PWD/target/debug/koda-exec"
export KODA_EXECUTION_PROFILE=read-only
```

每条准备好的命令都会记录请求的策略维度、所选后端、能力摘要、预期启动控制，以及适用时冻结的 Linux Bubblewrap 运行时身份。受保护的 macOS 或 Linux 命令只有经过沙箱内部确认、进程身份复查、证据持久化和第二道放行门槛后，才发布 `running` 状态及已应用的文件系统／网络证据；用户代码在验证期间不会运行。Linux 启动证据显示为 `OS sandbox: Linux Bubblewrap + seccomp`；无约束或不支持的后端显示 `OS sandbox: none`。进程树托管和环境过滤另行报告。精确命令授权绑定策略、后端、能力及运行时指纹，任一变化都会使授权在执行前失效。

完整的安全保证、证据、失败、旧版兼容及平台验收契约见 [Koda 执行安全保证](docs/security/execution-security.md)。

Phase 4B 在 macOS、Linux 和 Windows 上提供 Rust Supervisor 及每任务独立的 Worker。`pnpm build` 会构建 `target/debug/koda-exec`（Windows 上为 `target/debug/koda-exec.exe`）；设置其绝对路径以显式选择原生后端：

```bash
export KODA_EXEC_PATH="$PWD/target/debug/koda-exec"
node apps/cli/dist/main.js run "运行测试" --cwd .
```

选择原生后端后，Koda 会在 `KODA_HOME/executor` 下启动或重连私有 Supervisor，完成强制版本／能力握手，并将每条已接受命令交给独立分离的 Worker。持久化清单、状态头、有界输出存储、认证的 Worker 控制和 PID 启动身份，使替换后的 Supervisor 无需重启正在运行的命令即可重连。POSIX 进程组和 Windows Job Object 管理完整进程树；POSIX PTY 和 ConPTY 提供受控后台终端、连接／断开、输入权隔离、尺寸调整和重启安全观察。命令开始前的任务可安全续接；越过命令边界后若失去任务，结果标为 `termination_uncertain`，不会猜测成功。迁移期间移除 `KODA_EXEC_PATH` 可选择现有 TypeScript 兼容后端；原生启动或协议失败后 Koda 不会静默回退。

服务提供商返回用量时，Koda 持久化标准化的输入、缓存命中、缓存写入、输出、推理和总 Token 数，并打印 Turn 摘要。未返回用量时标为未测量，不视作零计费用量。

使用 `search_text` 工具需要安装 `ripgrep`（`rg`）；没有它时 `list_files` 和 `read_file` 仍可使用。

## 开发

环境要求：

- Node.js 22.20 或更新版本；CI 使用 Node.js 24。
- pnpm 10.28.2.
- Rust 1.85 或更新版本，包含 Cargo；工作区使用 Rust 2024 edition。

```bash
pnpm install
pnpm format:check
pnpm typecheck
pnpm test
pnpm eval:scenarios
```

## 软件包

- `@koda/protocol`：版本化运行时模式和领域类型。
- `@koda/agent-core`：智能体循环、服务提供商与工具端口、事件端口。
- `@koda/providers`：OpenAI Responses、Anthropic Messages、具名 OpenAI 兼容配置、标准化错误及确定性的脚本化服务提供商。
- `@koda/runtime-node`：JSONL、工件和可重建 SQLite 元数据持久化，以及受限制的工作区、补丁和进程工具。
- `@koda/mcp-client-node`：严格的本地 MCP 配置、官方 stdio 客户端生命周期、工具适配、策略元数据和有界结果转换。
- `@koda/plugin-host-node`：严格的本地插件清单、NDJSON 协议、事务式能力验证、工具适配、诊断和进程生命周期管理。
- `@koda/app`：与传输方式无关的 Turn 编排，以及无需凭据的 Thread 元数据／历史操作。
- `@koda/cli`：逐行命令解析、终端审批，以及基于 `@koda/app` 的控制台呈现。
- `@koda/app-server`：本地 stdio JSON-RPC 传输、活跃 Turn 协调和交互审批路由。
- `@koda/app-server-client-node`：类型化本地 JSON-RPC 客户端、NDJSON 帧、请求生命周期、诊断及自有 app-server 子进程清理。
- `@koda/tui`：React／Ink 控制器、静态对话和实时区域渲染、键盘交互及 `koda-chat` 入口。
- `@koda/testkit`：确定性的时钟、ID、工具、内存事件存储和离线可靠性场景。
- `koda-exec`：原生 POSIX 进程 Supervisor、私有本地协议、有界输出、超时、取消及可重连的实时任务状态。

## 架构与设计文档

- [架构设计](docs/plans/2026-08-26-koda-agent-architecture-design.md)
- [Phase 0 实施计划](docs/plans/2026-08-26-phase-0-implementation-plan.md)
- [Phase 1A OpenAI CLI 设计](docs/plans/2026-08-26-phase-1a-openai-cli-design.md)
- [Phase 1B 安全补丁设计](docs/plans/2026-08-26-phase-1b-safe-patch-design.md)
- [Phase 1C 安全命令执行设计](docs/plans/2026-08-26-phase-1c-safe-exec-design.md)
- [Phase 1D 上下文与用量设计](docs/plans/2026-08-26-phase-1d-context-accounting-design.md)
- [Phase 2 可靠性路线图](docs/plans/2026-08-26-phase-2-roadmap.md)
- [Phase 2A 持久化续接与恢复设计](docs/plans/2026-08-26-phase-2a-resume-recovery-design.md)
- [Phase 2B 工件与输出预算设计](docs/plans/2026-08-26-phase-2b-artifacts-output-budgets-design.md)
- [Phase 2C 上下文与压缩设计](docs/plans/2026-08-26-phase-2c-context-compaction-design.md)
- [Phase 2D 进程可靠性设计](docs/plans/2026-08-26-phase-2d-process-reliability-design.md)
- [Phase 2E SQLite 元数据设计](docs/plans/2026-08-26-phase-2e-sqlite-metadata-design.md)
- [Phase 2F 场景与工件回收设计](docs/plans/2026-08-26-phase-2f-scenarios-artifact-gc-design.md)
- [Phase 4 加固路线图](docs/plans/2026-08-28-phase-4-roadmap.md)
- [macOS 公开预览版发布操作手册](docs/release/macos-public-preview-runbook.md)
- [Phase 4B 原生进程托管设计](docs/plans/2026-08-28-phase-4b-supervised-native-execution-design.md)
- [Phase 3 扩展能力路线图](docs/plans/2026-08-26-phase-3-roadmap.md)
- [Phase 3A 本地 stdio app-server 设计](docs/plans/2026-08-26-phase-3a-stdio-app-server-design.md)
- [Phase 3B 本地 MCP 客户端设计](docs/plans/2026-08-26-phase-3b-mcp-client-design.md)
- [Phase 3C 多服务提供商运行时设计](docs/plans/2026-08-26-phase-3c-multi-provider-design.md)
- [Phase 3D Ink 聊天 REPL 设计](docs/plans/2026-08-26-phase-3d-ink-chat-repl-design.md)
- [Phase 3E1 Thread 浏览与历史恢复设计](docs/plans/2026-08-27-phase-3e1-thread-browser-history-design.md)
- [Phase 3E2 历史搜索与分页导航设计](docs/plans/2026-08-27-phase-3e2-history-search-navigation-design.md)
- [Phase 3E3 工作区运行时设置设计](docs/plans/2026-08-27-phase-3e3-runtime-settings-design.md)
- [Phase 3E4 Thread 工件查看设计](docs/plans/2026-08-27-phase-3e4-artifact-inspection-design.md)
- [Phase 3E5 可审计的上下文与指令检查设计](docs/plans/2026-08-27-phase-3e5-context-inspection-design.md)
- [Phase 3F1 可审计的多文件变更事务设计](docs/plans/2026-08-27-phase-3f1-multi-file-change-transactions-design.md)
- [Phase 3F2 严格的原生补丁文档设计](docs/plans/2026-08-27-phase-3f2-native-patch-documents-design.md)
- [Phase 3F3 会话级精确命令授权设计](docs/plans/2026-08-28-phase-3f3-session-command-approval-grants-design.md)
- [Phase 3G 持久化规划与 Harness 检查点设计](docs/plans/2026-08-28-phase-3g-planning-harness-design.md)
- [Phase 3H Skill 与扩展系统设计](docs/plans/2026-08-28-phase-3h-skills-extension-system-design.md)

模型可以提出操作，但验证、策略、审批和执行由 Koda 运行时负责。用户界面消费类型化事件，不拥有智能体状态。
