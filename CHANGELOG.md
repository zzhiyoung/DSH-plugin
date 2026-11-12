# Changelog

## 0.6.0

- 默认 released 桌面模式接入 DSH 工具桥接：当前会话的工具、已注册 MCP、技能加载器，支持 native 与 PTC/run_code 执行器；目录按调用刷新并保留作用域和白名单。
- 新增可热更新的插件设置：toolSource、tools、toolApproval、nativeApproval、permissionMode，接入宿主自动生成表单；默认按 DSH 规则处理，移除一律升级为询问的额外限制。
- 外部原生工具可以跟随 CLI 实际声明的权限模式；未知模式明确失败，不猜厂商参数，不将自动审查等同于全量允许。残余 ACP 请求仍交 DSH 确认。
- DSH 调用以独立 assistant 请求及工具结果写入原会话，避免外层流重复执行；支持工具图片结果及取消传递，保留 MCP 鉴权信息在 DSH。
- 本机真实 MCP SDK 与 schema 合约检查通过；桌面设置表单、真实账号工具调用和厂商自动审查仍待端到端验收。

## 0.5.0

- 取消 released / driver 单轮截止，旧 promptMs 忽略；startupMs 默认 0 不限时，保留取消和退出清理。
- ACP 原生工具逐次交给 DSH approval 审批；仅 allowed-once 有效，拒绝、取消、服务缺失或异常不允许。外部执行环境仍由 CLI 管理。
- 读取当前及历史图片附件，转换 ACP image 块；模型目录能力来自 ACP 握手，新增独立 maxImageBytes。
- probe 默认不限时，新增 --auth，输出图片能力，默认拒绝审批，隐藏可能包含临时密码的非 JSON 横幅。
- Codex / WorkBuddy 实测握手声明 image 与 HTTP MCP；登录和桌面对话验收尚未完成。修正 README 会话复用及 GitHub 更新边界。
- 核实依据和剩余工作见 docs/2026-11-12-调用链核实.md。

## 0.4.0

### 修复

- Codex 能回文字但命令工具报 `failed to spawn code-mode host` / `code-mode host executable not found` 时，插件不再静默沿用不完整的 `CODEX_PATH`。新增 `src/codex-path.js`：只有 `codex.exe` 同目录存在 `codex-code-mode-host.exe` 的安装才算完整；显式 `CODEX_PATH` 缺少该文件时，改用完整的官方 CLI 或 Codex Desktop 安装，并在 stderr 写明替换前后的路径。
- 自动检测优先选择带 code-mode host 的安装（先 `npm install -g @openai/codex` 的全局目录，再 `%LOCALAPPDATA%\OpenAI\Codex\bin` 下的版本目录），不再只按修改时间取最新版本。
- WorkBuddy 的「找不到 CLI」用例改用不存在的覆盖路径，不再依赖本机是否安装了 WorkBuddy。

### 变更

- 版本号升至 0.4.0；README 与安装说明补充 OpenAI CLI 安装路径与这条故障的排查方式。

## 0.3.1

### 新增

- ACP `authenticate` 支持：智能体行新增 `auth` 字段（登录方式 id），连接握手后先登录再建会话。WorkBuddy 行默认用 `internal`（微信登录）；
  WorkBuddy/CodeBuddy CLI 的登录态只在进程内有效，不登录时 `session/prompt` 会以 `refusal` 结束。
- `DSH_ACP_WORKBUDDY_AUTH` 环境变量，用于覆盖 WorkBuddy 的登录方式（`internal`、`external`、`iOA`、`selfhosted`）。

## 0.3.0

### 新增

- WorkBuddy 接入：插件自动探测 WorkBuddy 桌面版随附的 `codebuddy` CLI，注册为 `acp-workbuddy` 模型提供方。
- 桌面版只带 `codebuddy-lite-wb` 精简 bundle，插件据此自动改用 `--serve --acp --acp-transport stdio --port 0` 启动，并注入 `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`；带 `dist/codebuddy-headless.js` 的完整 CLI 仍走普通 `--acp`。
- `DSH_ACP_WORKBUDDY` 环境变量，用于覆盖 CLI 位置；自动探测覆盖 `ProgramFiles`、`ProgramFiles(x86)` 与 `%LOCALAPPDATA%\Programs`。
- `agents[].env` 支持 `NAME=VALUE` 固定值，同时保留 `NAME` 从 DSH 进程透传的写法。
- `scripts/probe-acp.mjs` 握手探测脚本：打印协议版本、模型目录、MCP 能力与登录方式，便于新增智能体时排错。

### 变更

- WorkBuddy 的配置行在找不到 CLI 时会被跳过并记录一条警告，不会阻止插件加载。
- `CODEBUDDY_AUTH_TOKEN`、`CODEBUDDY_API_KEY`、`CODEBUDDY_CONFIG_DIR` 加入默认透传名单。
- 版本号升至 0.3.0；README 与安装说明补充 WorkBuddy 的登录态和本地 HTTP 服务说明。

## 0.2.0

首个开源版本，基于 0.1.5 的可发布包重建为可分模块开发的仓库。

### 新增

- ACP 思考过程（`agent_thought_chunk`）映射为 DSH 思考块并流式显示，新增配置 `showThoughts`（默认开启）。
- 插件展示信息：`locale/en.json`、`locale/zh.json` 的标题与描述，以及 `icon.svg`。
- 单元测试（`node:test`）与 GitHub Actions CI：配置文件校验、模型提供方注册、released/driver 两种接入方式、上下文投影、流式块整理。
- `test/support/` 依赖桩与解析钩子，使测试无需安装 DSH 即可运行。

### 变更

- `hub.js` 拆分为 `src/index.js`、`src/connection.js`、`src/context.js`、`src/gateway.js`、`src/released.js`，新增 `src/stream-blocks.js`。
- `AcpConnection.prompt()` 改为接收 `{ onText, onThought, signal }`，同时投递正文与思考片段。
- 根入口 `index.js` 只做 Codex 内置适配器注入，核心逻辑移到 `src/index.js`。
- LICENSE 改为仓库作者的 MIT 许可；内置 `@agentclientprotocol/codex-acp` 2.6.0 保留 Apache-2.0 授权文件。

### 继承自 0.1.5

- 每个 ACP 智能体注册一个模型提供方，模型目录来自该 CLI 当前账号。
- 同一 DSH 会话内的连接与 ACP 会话复用，发送增量历史。
- `released` 与 `driver` 两种接入方式；`driver` 可经本地 HTTP MCP 网关桥接 `read`、`skill` 工具。
