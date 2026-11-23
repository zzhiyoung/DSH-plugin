# DSH ACP Agent Hub

把 [Codex](https://github.com/agentclientprotocol/codex-acp)、[Qoder](https://docs.qoder.com/cli/acp)、[WorkBuddy](https://www.codebuddy.cn/) 等支持 **ACP（Agent Client Protocol）** 的智能体接入 DeepSeek Harness（DSH），在 DSH 的模型菜单里直接选用它们对话。

[![CI](https://github.com/zzhiyoung/DSH-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/zzhiyoung/DSH-plugin/actions/workflows/ci.yml)

> English summary at the end of this file.

## 这个插件做什么

DSH 通过 `LlmAdapter` 发现模型提供方。本插件为每个配置好的 ACP 智能体注册一个提供方（`acp-codex`、`acp-qoder`、`acp-workbuddy` …），并在用户选择它时：

1. 用 DSH 托管的子进程启动对应 CLI，按 ACP v1 握手、开一个新会话；
2. 把 DSH 会话里可见的文字历史、图片与本轮请求打包成一条提示发给智能体；
3. 把流式回复（正文与思考过程）回写成 DSH 助手消息；
4. 默认 `released` 为每个 agent 保留一个连接进程，每轮创建独立 ACP 会话；实验 `driver` 按 DSH 会话管理连接。

账号和模型列表来自 CLI；ACP 上报的原生工具审批交给 DSH 逐项确认。CLI 的执行环境与 DSH 工具沙箱分别管理。

## 功能

- 输入框旁常驻“ACP 连接”入口，查看各智能体状态、刷新并恢复登录；新会话未选择模型时也可用。
- 一个智能体一个模型组，模型列表实时来自该 CLI 当前账号（`@default` 为智能体默认模型）。
- 流式正文；ACP `agent_thought_chunk` 映射为 DSH 的思考块，可在界面里展开查看（`showThoughts` 可关闭）。
- 默认 `released` 复用进程登录态，每轮向独立 ACP 会话发送本轮请求和预算允许的最近历史。实验 `driver` 复用会话并发送增量。
- 两种接入方式：
  - `released`（默认）：走公开的 `llm/stream`，在官方桌面版内也能桥接现有 DSH 工具、MCP 和技能；
  - `driver`：供实现了 `agentTurnDriver` 的宿主实验使用。工具桥接要求外部智能体声明 HTTP MCP。
- WorkBuddy 行会自动探测桌面版随附的 `codebuddy` CLI，并适配精简 bundle 与官方完整版 CLI 的启动方式。

## 安装

当前版本 **0.8.5**，支持 Windows 官方 DeepSeek Harness Desktop。启动时检查宿主接口，缺失时报告具体服务或方法。桌面端完整任务验收需使用实际 CLI 和账号。

1. 在 DSH 桌面版打开「插件」→「添加插件」。
2. 「包名或地址」填本仓库目录的完整路径（例如 `D:\coding\DSH-plugin`），或先 `npm run pack:tgz` 生成 `.tgz` 后填该文件的完整路径。
3. 安装成功后点「立即启用」，按提示重启 DSH。
4. 打开工作区和会话，在输入区右下角的模型菜单里选择 Codex / Qoder / WorkBuddy 下的具体模型。
5. 如需检查连接或登录，点输入框旁的 **ACP 连接 → 对应智能体 → 刷新**。新会话未选择模型时也可使用；模型列表子菜单本身不显示旧的根层刷新面板。

本机安装器源码支持 `github:zzhiyoung/DSH-plugin` 与仓库 HTTPS 地址；真实网络安装待测。GitHub push 不自动更新已装插件，内置升级针对 registry 包。升级本地包前先卸载旧版。详细步骤见 [docs/安装说明.md](docs/安装说明.md)。

### 准备智能体

- **Codex**：需要 Node.js（已用 24.x 验证）和已登录的 Codex。推荐用官方 CLI：`npm.cmd install -g @openai/codex`，再 `codex login`。插件内含 ACP 适配器，会优先使用带 `codex-code-mode-host.exe` 的完整安装（全局 CLI → Codex Desktop 的版本目录），也支持 `PATH` 里的 `codex`。Codex 的 **Code Mode** 靠与 `codex.exe` 同目录的 `codex-code-mode-host.exe` 启动；只复制了 `codex.exe` 的目录（例如某些沙箱副本）能回文字，但一调用命令工具就报 `code-mode host executable not found`。
- **Qoder**：支持 npm 安装的 `@qoder-ai/qodercli`（本机 1.1.89 已验证 ACP 握手）及旧版原生 CLI。插件自动查找 npm 前缀、`%APPDATA%\npm` 和 PATH，并用 Node 直接启动 npm 包声明的入口，避免 Windows `.cmd` 启动问题；旧配置中已失效的 `.qoder/bin/qodercli/qodercli.exe` 也会自动适配。需要在终端单独执行 `qodercli login`；安装成功或 Qoder 桌面版已登录不代表 CLI 已获得有效登录态。
- **WorkBuddy**：使用 WorkBuddy 桌面版自带的 CLI（`<WorkBuddy 安装目录>\resources\app.asar.unpacked\cli\bin\codebuddy`）。插件会先查 `ProgramFiles`、`ProgramFiles(x86)`、`%LOCALAPPDATA%\Programs`，再查卸载注册表里记录的安装路径（装在 D 盘这类非系统盘时靠这一步），也可以用 `DSH_ACP_WORKBUDDY` 指向启动脚本或可执行文件。实测（WorkBuddy 37.10.3-43，CLI 2.165.0）有两点需要注意：
  1. 桌面版只带 `codebuddy-lite-wb` 精简 bundle，直接 `--acp` 会报 `Cannot find module '../dist/codebuddy'`。插件检测到这种布局时自动改用 `--serve --acp --acp-transport stdio --port 0`，并注入 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`；完整 CLI（带 `dist/codebuddy-headless.js`）**同样**需要 `--serve ... --port 0`：0.8.2 实测它与桌面端共用固定端口 `127.0.0.1:13034`，普通 `--acp` 会报 `EADDRINUSE`。
  2. 本机 CLI 的 ACP authenticate 会先退出已有会话，再强制重新登录，可能影响桌面登录。当前默认 `released` 模式在后台及普通对话中只使用已有凭据；**手动刷新才会验证模型回复，遇到 AUTH 时尝试一次登录**，登录后在同一进程复验。精简桌面布局默认启用内存凭据隔离，退出 DSH 后需重新登录；完整版默认使用其文件凭据，但不保证重启免登或两端共存。登录方法可设 `auth: internal / external / iOA / selfhosted`。


## 配置

插件配置写在 DSH 的 `cordis.patch.yml` 行里（本仓库的 `cordis.patch.yml` 是默认值）：

```yaml
- insert:
    - id: acp-agent-hub
      name: dsh-acp-agent-hub
      config:
        execution: released
        toolSource: dsh
        toolApproval: rules
        nativeApproval: dsh
        agents:
          - id: codex
            title: Codex
            command: !!js process.env.DSH_ACP_NODE || 'node.exe'
            env: [CODEX_PATH, CODEX_HOME]
          - id: qoder
            title: Qoder
            command: !!js process.env.DSH_ACP_QODER || 'qodercli'
            args: [--acp]
          - id: workbuddy
            title: WorkBuddy
            command: !!js process.env.DSH_ACP_NODE || 'node.exe'
            authMode: existing
            env: [CODEBUDDY_AUTH_TOKEN, CODEBUDDY_API_KEY, CODEBUDDY_CONFIG_DIR]
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `agents` | — | 智能体列表，`id` 只能用小写字母、数字、`_`、`-`，`title` 显示在模型菜单 |
| `agents[].command` | — | 可执行文件；`codex` 行留空 `args` 时插件会自动注入内置 ACP 适配器，`workbuddy` 行留空 `args` 时自动探测 CLI 并补全启动参数 |
| `agents[].args` | `[]` | 启动参数；Codex / WorkBuddy 留空才自动补全；WorkBuddy 自定义参数也会跳过自动环境变量注入。Qoder 仍会解析 npm 启动入口并保留参数 |
| `agents[].env` | `[]` | 环境变量：写 `NAME` 从 DSH 进程透传，写 `NAME=VALUE` 固定为该值 |
| `agents[].auth` | — | ACP 登录方式 id；仅在允许主动认证时使用 |
| `agents[].authMode` | WorkBuddy: `existing` | `released` 由手动刷新在 AUTH 后登录一次；实验 `driver` 的 `authenticate` 可显式重新认证，可能影响桌面登录。后台探测始终不主动认证 |
| `execution` | `released` | `released` 走 `llm/stream`；`driver` 提供 `agentTurnDriver`，允许桥接工具 |
| `toolSource` | `dsh` | 优先使用 DSH 当前工具，或 `external` 关闭桥接、使用 CLI 自带工具 |
| `tools` | `[]` | 桥接白名单；空列表使用当前会话可用工具，包括已注册 MCP 与技能工具，仍受 DSH 作用域限制 |
| `toolApproval` | `rules` | 按 DSH 权限规则处理；`ask` 为桥接调用额外要求确认，不能覆盖拒绝 |
| `nativeApproval` | `dsh` | 外部原生工具 ACP 审批：`dsh` 交给 DSH 确认，`agent` 跟随 CLI 权限模式，`deny` 拒绝其 ACP 请求 |
| `permissionMode` | 空 | `agent` 模式下选择 CLI 实际声明的模式 ID；留空沿用 CLI 当前模式。支持逐 agent 的 `agents[].permissionMode` 兜底 |
| `showThoughts` | `true` | 是否把 ACP 思考过程显示为 DSH 思考块 |
| `connectOnStart` | `true` | DSH 启动/插件启用后后台连接每个 agent 一次；不自动登录、不发送模型验证消息 |
| `loginMs` | `180000` | 手动刷新触发登录时的等待上限（毫秒）；登录与目录/模型验证分别计时 |
| `discoveryMs` | `60000` | 握手、建会话及手动模型验证各阶段的等待预算；交互登录单独使用 `loginMs`，不限制普通对话任务 |
| `discoveryWaitMs` | `800` | 模型菜单首次等候预算；到时先返回已加载目录或默认入口，后台完成后通知 DSH 刷新 |
| `startupMs` | `60000` | 获得连接使用权后，握手、建会话、模型和权限选择共用的毫秒预算。`0` 表示启动阶段不限时 |
| `maxImageBytes` | `20971520` | 单轮图片总字节上限，独立于文字上限 |
| `cancelGraceMs` | `5000` | 取消与进程退出宽限 |
| `idleMs` | `900000` | 实验 `driver` 的空闲会话绑定回收时间；`released` 按提供方保留进程至退出、故障或取消清理 |
| `maxBindings` | `8` | `driver` 的会话绑定上限；`released` 的并发对话请求上限，后台目录检查不占用此名额 |
| `maxContextBytes` | `131072` | 文字上下文 UTF-8 字节上限。本轮输入与工具指引优先，剩余预算用于最近历史。`0` 表示取消插件文字上限 |
| `maxOutputBytes` | `262144` | 单轮输出上限 |

模型目录发现与普通对话采用不同预算：连接阶段默认 60 秒，菜单首次最多等待 800 毫秒；成功目录缓存 5 分钟，失败冷却 30 秒，刷新失败保留旧目录。输入框旁的“ACP 连接”显示各提供方状态和独立刷新按钮；原模型菜单根层面板也保留。手动刷新绕过失败冷却，重复点击合并。首次 AUTH 失败显示“需要登录”，其他探测失败显示“检测失败”。后台检查不发模型请求；手动刷新会发送最小 OK 验证请求，可能产生模型用量。同一 agent 的刷新与对话串行，其他 agent 独立。

单轮不设截止时间，旧 `promptMs` 忽略。用户停止、插件卸载、CLI/宿主自身限制及输出字节超限仍会结束任务。取消宽限与空闲回收不限制执行中的轮次。

标准模式在发送提示前发现复用进程断开时，可重建一次连接。提示提交后，由会话记录和对应阶段的错误帮助判断执行结果。文本上下文裁剪只作用于传给 CLI 的内容，旧图片缺失或超过图片预算时可继续对话。本轮图片需完整读取，并通过与 CLI 的能力检查。

### 在插件中选择工具与审批

0.6.0 把上表的 toolSource、tools、toolApproval、nativeApproval、permissionMode 声明为 DSH 的可热更新字段，使用宿主自动生成的插件设置表单（默认条目 acp-agent-hub）。按本机 0.2.2-rc.1 的 settings 服务核实，安装新包后应在设置表单中出现；尚未完成真实桌面点击验收。工具来源、白名单和外部权限模式在下一轮读取；DSH 额外询问策略对后续调用生效。

推荐保持 toolSource=dsh、toolApproval=rules：安全操作按现有规则执行，需确认时才询问，原有拒绝不放宽。MCP 连接和账号凭据仍由 DSH 管理，外部 CLI 只获得临时桥接地址和本轮许可。

若选择 nativeApproval=agent，可填写 CLI 声明的权限模式。例如内置 Codex ACP 的 `agent` 是 Auto review；它不同于 `agent-full-access`。不支持指定模式时插件会报错，不会替换为全放行。外部 CLI 仍转交给客户端的审批会回到 DSH 确认；并非插件自动允许。此设置不影响 DSH 工具自己的规则。

DSH 使用 PTC 时，桥接入口是 run_code，提供相同作用域的工具 SDK；native executor 则列出各个工具。技能加载后刷新 tools/list 以获得新工具；宿主尚未激活的能力不能绕过激活条件。MCP resources/prompts 不是工具目录，未在此桥接中全量复制。

### 环境变量

| 变量 | 用途 |
| --- | --- |
| `DSH_ACP_NODE` | 自定义 `node.exe` 完整路径 |
| `DSH_ACP_CODEX_ENTRY` | 自定义 Codex ACP 适配器的 `dist/index.js` 完整路径；默认用插件内置的适配器 |
| `CODEX_PATH` | 指定 `codex.exe` 完整路径，优先于自动检测。目录里缺少 `codex-code-mode-host.exe` 时，插件会改用完整安装并记录一条说明 |
| `DSH_ACP_QODER` | 自定义 Qoder CLI 路径，支持原生 `.exe`、npm `.cmd` 或 JS 入口 |
| `DSH_ACP_WORKBUDDY` | 指定 `codebuddy` 启动脚本或可执行文件，优先于自动检测；可指向官方完整 CLI 的 `bin/codebuddy` |
| `DSH_ACP_WORKBUDDY_AUTH` | 自动补全 WorkBuddy 行的登录方法，默认 `internal`；手动刷新遇到 AUTH 时使用，`agents[].auth` 优先 |
| `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_API_KEY` | 透传给 WorkBuddy CLI 的凭据，用于 CLI 未登录时 |
| `CODEBUDDY_CONFIG_DIR` | WorkBuddy CLI 的配置目录；不能据此保证共享 auth 文件已隔离或桌面/CLI 互不影响 |

## 已知限制

- 只在 **Windows** 上验证（`platforms: win32`）。
- 仅用于 **根会话**：子智能体、标题生成等带 `purpose` 的请求不会走 ACP 路由。
- DSH 工具调用记录和结果保存在 DSH 会话，结果发给外部智能体；CLI 原生工具的完整执行过程尚未映射成 DSH 工具记录。
- 图片通过 DSH 附件库读取并发送 ACP image 块，按 agent 握手能力声明图片输入；具体模型仍需实测。通用文件附件暂不支持。
- 当前会话有可桥接的 DSH 工具时，外部智能体必须支持 HTTP MCP，可在设置中选用 `external`。没有可桥接工具时可直接连接不支持 HTTP MCP 的智能体。收到并行工具请求时，桥接按收到顺序执行并沿用 DSH 审批规则。
- ACP 原生工具审批逐次转交 DSH，只把 allowed-once 映射为一次允许；拒绝、取消或审批服务缺失均不放行。CLI 未上报审批的操作无法接管。外部执行不受 DSH 沙箱自动约束。
- 自动识别的 WorkBuddy 精简与完整 CLI 均使用 `--serve ... --port 0`，会在 `127.0.0.1` 随机端口起本地 HTTP 服务。启动横幅不表示 ACP 已连通，应以握手、建会话及模型验证结果判断。完整版普通 `--acp` 的固定端口可能与桌面端冲突；连接回收时服务随之退出。
- 默认 released 为每个 agent 保留一个进程，同一 agent 的刷新与对话串行，不同 agent 独立。WorkBuddy 登录可能与桌面登录冲突，不能保证两端共存；手动刷新时才允许发起一次认证。

## 排错

### Codex 只回文字，命令工具报 `code-mode host executable not found`

Codex 的 Code Mode 依赖与 `codex.exe` 同目录的 `codex-code-mode-host.exe`。Codex Desktop 在 `%LOCALAPPDATA%\OpenAI\Codex\bin\<版本哈希>\` 下解包整套文件，而 `%USERPROFILE%\.codex\.sandbox-bin\codex.exe` 这类沙箱副本只有主程序，`CODEX_PATH` 指到它就会出现「文字能回、命令跑不动」。0.4.0 起插件会检测并回退，日志里留一条 `[dsh-acp-agent-hub] CODEX_PATH points at ...`。

要彻底改用官方 CLI：

```powershell
npm.cmd install -g @openai/codex
[Environment]::SetEnvironmentVariable('CODEX_PATH', "$env:APPDATA\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe", 'User')
```

这条路径不含版本号，`npm update -g @openai/codex` 升级后仍然有效。改完从托盘完全退出 DSH 再启动，新开一个 Codex 会话让它执行一次 `git status --short`：命令有输出、日志里没有 code-mode 告警即为修好。

### 目录连接与真实对话的区别（0.7.2）

“目录已连接”仅表示 initialize/session/new 成功，并未发送收费模型请求。部分 CLI（包括本机 WorkBuddy）允许未认证账号读取模型目录，却在 session/prompt 才返回 Authentication required。实际请求成功后才标注“对话已验证”，并说明最近验证的模型选择；不保证同组所有模型都可用。已知认证失败显示“需要登录”，刷新目录不会清除此状态。后台不会自动发送测试提示或主动重新登录。

WorkBuddy 会把模型服务错误放在 refusal 的 _meta 中，插件会分类显示认证、额度、限流或服务错误，不将它们一律解释为模型拒答。没有附加错误的 refusal 则保留为明确的拒绝状态。WorkBuddy 主动认证可能先退出已有登录，恢复 CLI 登录需用户明确处理，不能把目录连接成功当作登录验证。

### 启动连接和手动登录（0.8.0）

- DSH 启动或插件启用时，自动连接每个配置好的 agent 一次，保留连接进程。后台只使用已有凭据；不会发起登录或调用模型验证。
- 点击某个 agent 的“刷新”时，检查目录并发送一条只要求回复 OK 的连接验证消息（可能产生模型用量）。只有明确返回认证失败，才调用该 CLI 实际支持的认证方法一次；登录后在同一进程中重新创建会话并再次验证。额度、限流、网络失败不触发登录。
- 同一 agent 的重复刷新合并为一次；状态显示检测中、验证登录中、等待登录。登录失败/取消/超时不自动重复登录，用户可以再次点击刷新。
- WorkBuddy authenticate 可能先退出已有账号；手动刷新是发起这一次登录的用户操作。登录成功后的进程保留供后续 released 对话使用，不靠另起一个 CLI 猜测登录态是否持久化。
- 每轮新建独立 ACP 会话，避免把上一个 DSH 聊天的历史混入另一个聊天；agent 声明支持 session/close 时先关闭旧会话。同一 agent 串行处理，不同 agent 独立；插件卸载会取消等待、关闭进程与临时目录。
- 上述进程复用适用于默认 released 执行方式。实验 driver 仍采用原有按 DSH 会话绑定的连接生命周期。

### WorkBuddy 登录后再次失效（0.8.1）

桌面精简 CLI 通过 WorkBuddy 私有环境获得加密凭据能力。独立从 DSH 启动时，实际日志出现 auth/workbuddy-desktop.info 的 missing-key，且同一 PID 登录后认证被清空。0.8.1 仅针对自动识别出的桌面精简布局启用 CLI 自带的 CODEBUDDY_CREDENTIALS_IN_MEMORY=1，不读写或监听共享认证文件；继续使用 0.8.0 的持久连接进程保存本次 CLI 登录。此设置不更改桌面加密策略，也不读取/复制桌面的令牌或密钥。显式 env 配置优先。

退出 DSH 后本次内存登录消失，下次需点击刷新登录。桌面和 CLI 是否能在服务端同时保持登录，仍需实际账号验证。自定义启动参数请自行配置 CODEBUDDY_CREDENTIALS_IN_MEMORY=1，完整独立 CodeBuddy CLI 不自动添加该设置。

### 使用官方完整版 CLI（0.8.2）

`npm install -g @tencent-ai/codebuddy-code` 装出的独立 CLI 带 `dist/codebuddy-headless.js`。把 `DSH_ACP_WORKBUDDY` 指向它的 `bin/codebuddy`，插件会识别为完整版并使用 `--serve --acp --acp-transport stdio --port 0`。安装插件并完全重启 DSH 后，可点“ACP 连接 → WorkBuddy → 刷新”完成一次登录验证，也可先在终端运行 `codebuddy` 后执行 `/login`。登录方式有 iOA、external、internal、selfhosted；账号权益与桌面登录未必相同。

完整版仍与桌面共用 `~/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` 和目录 watcher，authenticate 依旧先 logout 再 login，换完整版不等于解决两端互踢。若实测仍冲突，在该 agent 的 `env` 加 `CODEBUDDY_CREDENTIALS_IN_MEMORY=1` 可让 CLI 只用内存登录（代价是 DSH 重启后需再登录一次）。服务端是否允许同一账号两端同时在线，仍未实测。

## 开发

```powershell
node --check index.js        # 语法检查
npm run check                # 检查入口与全部模块
npm test                     # node:test 单元测试
npm run pack:tgz             # 生成可安装的 .tgz
```

在不能创建子进程的受限环境里，改用 `node --test --test-isolation=none "test/*.test.js"` 在单进程内跑同一套测试。

需要确认某个智能体的 ACP 行为时，用探测脚本直接握手：

```powershell
node scripts/probe-acp.mjs --env CODEBUDDY_FORCE_LITE_WB_BUNDLE=1 -- `
  node "D:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy" `
  --serve --acp --acp-transport stdio --port 0
```

它会打印协议版本、模型目录、MCP 能力、登录方式，以及 `session/new` 是否成功。

目录结构：

```
index.js              插件入口：为 codex 注入内置 ACP 适配器、为 workbuddy 补全启动参数，再转交 apply
src/index.js          注册模型目录、根轮驱动 / llm/stream 适配，管理连接生命周期
src/catalog.js        模型目录部分返回、后台发现和缓存
src/agent-connections.js 每个 provider 的连接进程、手动登录和串行会话
src/connection.js     ACP v1 连接：子进程、握手、会话、提示、取消
src/codex-path.js     选择 Codex 可执行文件：校验 code-mode host，必要时回退到完整安装
src/qoder-path.js     解析 Qoder npm 或原生启动入口
src/acp-result.js     分类 ACP refusal 中的认证、额度等错误
src/context.js        把 DSH 会话投影成发送给智能体的文本上下文
src/gateway.js        本地 HTTP MCP 网关，把 DSH 工具暴露给智能体
src/tool-bridge.js    按作用域解析 DSH 工具、MCP、技能和 PTC SDK
src/released.js       released 模式的 llm/stream 适配
src/stream-blocks.js  把 ACP 正文/思考片段整理成 DSH 流式块
scripts/probe-acp.mjs ACP 握手探测脚本
client.js             输入框常驻 ACP 连接菜单和模型菜单根层状态面板
test/                 单元测试与依赖桩（不需要安装 DSH 即可运行）
vendor/codex-acp/     内置的 @agentclientprotocol/codex-acp 2.6.0（Apache-2.0）
```

测试用 `test/support/hooks.mjs` 把 `@deepseek-ai/*`、ACP SDK、MCP SDK 解析到本地桩，因此 `npm test` 不依赖 DSH 安装。要验证真实链路，把仓库目录装进 DSH 插件页后选一个智能体模型对话即可。

## Roadmap

- [x] 图片附件 → ACP image（源码完成，桌面验收待做）
- [ ] 通用文件附件 → ACP resource_link
- [x] `released` 工具桥接，包括当前 DSH MCP、技能与 PTC 执行器（真实桌面账号验收待做）
- [ ] 工具调用过程的 DSH 侧展示

## 许可

MIT。内置的 `vendor/codex-acp` 来自 [@agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)，遵循 Apache-2.0，其 LICENSE 与 README 保留在 `vendor/codex-acp/`。

---

## English

**DSH ACP Agent Hub** registers Codex, Qoder, WorkBuddy and any other ACP-capable agent as model providers inside DeepSeek Harness (Windows; rc.3 host interfaces inspected, runtime capability checks instead of exact version gates). Select the group in the model menu and the plugin spawns the agent CLI, negotiates ACP v1, sends the DSH conversation as a prompt, and streams the reply — including the agent's thinking blocks — back into the transcript.

Install by pointing DSH's plugin page at this directory (or a `npm run pack:tgz` archive). Configure agents in the plugin's `cordis.patch.yml` row. `released` execution uses the public `llm/stream` waterfall; both modes can bridge scoped DSH tools, MCP services and skills through a loopback HTTP MCP gateway. Plugin settings default to DSH permission rules.

Version **0.8.3** adds a persistent **ACP 连接** control beside the composer, including before a model is selected. Refresh verifies a minimal model reply and attempts login once only after an AUTH failure; background discovery and normal released turns never initiate login. Both detected WorkBuddy CLI layouts use stdio serve flags with a free port. The lite desktop layout uses process-local credentials by default; the full CLI retains its file store. Desktop coexistence and restart persistence remain unverified.

Limitations: Windows only, root conversations only, image input when advertised by the agent, no general file attachments, and per-action native ACP permissions forwarded to DSH. Prompt execution has no deadline. Run `npm test` for the unit suite; it needs no Harness installation.
