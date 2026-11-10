# Changelog

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
