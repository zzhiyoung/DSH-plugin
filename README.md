# DSH ACP Agent Hub

把 [Codex](https://github.com/agentclientprotocol/codex-acp)、[Qoder](https://docs.qoder.com/cli/acp) 等支持 **ACP（Agent Client Protocol）** 的智能体接入 DeepSeek Harness（DSH），在 DSH 的模型菜单里直接选用它们对话。

[![CI](https://github.com/zzhiyoung/DSH-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/zzhiyoung/DSH-plugin/actions/workflows/ci.yml)

> English summary at the end of this file.

## 这个插件做什么

DSH 通过 `LlmAdapter` 发现模型提供方。本插件为每个配置好的 ACP 智能体注册一个提供方（`acp-codex`、`acp-qoder` …），并在用户选择它时：

1. 用 DSH 托管的子进程启动对应 CLI，按 ACP v1 握手、开一个新会话；
2. 把 DSH 会话里可见的文字历史与本轮请求打包成一条提示发给智能体；
3. 把流式回复（正文与思考过程）回写成 DSH 助手消息；
4. 智能体进程按会话复用，空闲一段时间后回收。

智能体自己的账号、模型列表、权限策略都由它自己的 CLI 管理，插件不做代理登录。

## 功能

- 一个智能体一个模型组，模型列表实时来自该 CLI 当前账号（`@default` 为智能体默认模型）。
- 流式正文；ACP `agent_thought_chunk` 映射为 DSH 的思考块，可在界面里展开查看（`showThoughts` 可关闭）。
- 同一 DSH 会话内续聊：连接与 ACP 会话复用，只发送增量历史。
- 两种接入方式：
  - `released`（默认）：走公开的 `llm/stream` 瀑布流，适配官方桌面版；
  - `driver`：提供 `agentTurnDriver` 服务，可把 DSH 工具经本地 HTTP MCP 桥接给智能体（需该智能体支持 HTTP MCP）。

## 安装

适用于 Windows 官方 DeepSeek Harness Desktop **0.2.2-rc.1**。

1. 在 DSH 桌面版打开「插件」→「添加插件」。
2. 「包名或地址」填本仓库目录的完整路径（例如 `D:\coding\DSH-plugin`），或先 `npm run pack:tgz` 生成 `.tgz` 后填该文件的完整路径。
3. 安装成功后点「立即启用」，按提示重启 DSH。
4. 打开工作区和会话，在输入区右下角的模型菜单里选择 Codex / Qoder 下的具体模型。

升级已有版本前，先在插件页卸载旧版。详细步骤见 [docs/安装说明.md](docs/安装说明.md)。

### 准备智能体

- **Codex**：需要 Node.js（已用 24.x 验证）和已登录的 Codex。插件内含 ACP 适配器，优先检测 Codex Desktop CLI，也支持 `PATH` 里的 `codex`。没装可用 `npm.cmd install -g @openai/codex` 后 `codex login`。
- **Qoder**：使用 Qoder CLI 的登录态：`& "$env:USERPROFILE\.qoder\bin\qodercli\qodercli.exe" login`。

## 配置

插件配置写在 DSH 的 `cordis.patch.yml` 行里（本仓库的 `cordis.patch.yml` 是默认值）：

```yaml
- insert:
    - id: acp-agent-hub
      name: dsh-acp-agent-hub
      config:
        execution: released
        agents:
          - id: codex
            title: Codex
            command: !!js process.env.DSH_ACP_NODE || 'node.exe'
            env: [CODEX_PATH, CODEX_HOME]
          - id: qoder
            title: Qoder
            command: !!js process.env.DSH_ACP_QODER || process.env.USERPROFILE + '/.qoder/bin/qodercli/qodercli.exe'
            args: [--acp]
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `agents` | — | 智能体列表，`id` 只能用小写字母、数字、`_`、`-`，`title` 显示在模型菜单 |
| `agents[].command` | — | 可执行文件；`codex` 行留空 `args` 时插件会自动注入内置 ACP 适配器 |
| `agents[].args` | `[]` | 启动参数 |
| `agents[].env` | `[]` | 从 DSH 进程透传的环境变量名 |
| `execution` | `released` | `released` 走 `llm/stream`；`driver` 提供 `agentTurnDriver`，允许桥接工具 |
| `tools` | `[]` | 允许桥接给智能体的 DSH 工具（`read`、`skill`）；仅 `driver` 模式可用 |
| `showThoughts` | `true` | 是否把 ACP 思考过程显示为 DSH 思考块 |
| `startupMs` | `15000` | 握手/建会话超时 |
| `promptMs` | `600000` | 单轮提示超时 |
| `cancelGraceMs` | `5000` | 取消与进程退出宽限 |
| `idleMs` | `900000` | 会话空闲多久后回收连接 |
| `maxBindings` | `8` | 同时存活的连接上限 |
| `maxContextBytes` | `131072` | 单次发送上下文上限 |
| `maxOutputBytes` | `262144` | 单轮输出上限 |

### 环境变量

| 变量 | 用途 |
| --- | --- |
| `DSH_ACP_NODE` | 自定义 `node.exe` 完整路径 |
| `DSH_ACP_CODEX_ENTRY` | 自定义 Codex ACP 适配器的 `dist/index.js` 完整路径；默认用插件内置的适配器 |
| `CODEX_PATH` | 指定 `codex.exe` 完整路径，优先于自动检测 |
| `DSH_ACP_QODER` | 自定义 `qodercli.exe` 完整路径 |

## 已知限制

- 只在 **Windows** 上验证（`platforms: win32`）。
- 仅用于 **根会话**：子智能体、标题生成等带 `purpose` 的请求不会走 ACP 路由。
- 每轮把 DSH 可见文字历史作为 JSON 发给智能体；工具调用过程不回传给对方。
- 附件（图片/文件）尚未接入，当前只接受文字输入。
- `released` 模式下智能体拿不到 DSH 工具；需要工具桥接请用 `driver` 模式，并确认智能体支持 HTTP MCP。
- 外部 CLI 使用自己的权限配置；插件会拒绝经 ACP 发起的原生工具审批。

## 开发

```powershell
node --check index.js        # 语法检查
npm test                     # node:test 单元测试
npm run pack:tgz             # 生成可安装的 .tgz
```

在不能创建子进程的受限环境里，改用 `node --test --test-isolation=none "test/*.test.js"` 在单进程内跑同一套测试。

目录结构：

```
index.js              插件入口：为 codex 行注入内置 ACP 适配器，再转交 apply
src/index.js          注册模型目录、根轮驱动 / llm/stream 适配，管理连接生命周期
src/connection.js     ACP v1 连接：子进程、握手、会话、提示、取消
src/context.js        把 DSH 会话投影成发送给智能体的文本上下文
src/gateway.js        本地 HTTP MCP 网关，把 DSH 工具暴露给智能体
src/released.js       released 模式的 llm/stream 适配
src/stream-blocks.js  把 ACP 正文/思考片段整理成 DSH 流式块
test/                 单元测试与依赖桩（不需要安装 DSH 即可运行）
vendor/codex-acp/     内置的 @agentclientprotocol/codex-acp 2.6.0（Apache-2.0）
```

测试用 `test/support/hooks.mjs` 把 `@deepseek-ai/*`、ACP SDK、MCP SDK 解析到本地桩，因此 `npm test` 不依赖 DSH 安装。要验证真实链路，把仓库目录装进 DSH 插件页后选一个智能体模型对话即可。

## Roadmap

- [ ] 图片/文件附件 → ACP `image` / `resource_link` 内容块
- [ ] `released` 模式下也支持工具桥接
- [ ] 工具调用过程的 DSH 侧展示

## 许可

MIT。内置的 `vendor/codex-acp` 来自 [@agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)，遵循 Apache-2.0，其 LICENSE 与 README 保留在 `vendor/codex-acp/`。

---

## English

**DSH ACP Agent Hub** registers Codex, Qoder and any other ACP-capable agent as model providers inside DeepSeek Harness (0.2.2-rc.1, Windows). Select the group in the model menu and the plugin spawns the agent CLI, negotiates ACP v1, sends the DSH conversation as a prompt, and streams the reply — including the agent's thinking blocks — back into the transcript.

Install by pointing DSH's plugin page at this directory (or a `npm run pack:tgz` archive). Configure agents in the plugin's `cordis.patch.yml` row. `released` execution uses the public `llm/stream` waterfall; `driver` execution can additionally bridge DSH tools through a loopback HTTP MCP gateway.

Limitations: Windows only, root conversations only, text-only input for now, and the ACP agent manages its own credentials and permissions. Run `npm test` for the unit suite; it needs no Harness installation.
