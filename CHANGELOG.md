# Changelog

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
