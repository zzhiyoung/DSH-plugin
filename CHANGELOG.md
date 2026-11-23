# Changelog

## 0.8.5

- 对话启动的 60 秒默认预算从取得连接后开始，覆盖握手、建会话及模型与权限选择。CLI 退出或协议流断开时立即结束等待。发送提示前遇到复用连接断开可重连一次。
- 保留完整本轮输入和可容纳的最近历史，优先传输本轮图片。允许显式设置 `maxContextBytes: 0`，兼容 `0.8.4-local.1` 的不限文字字节数配置。
- 历史图片缺失或超预算时继续。没有可桥接的 DSH 工具时跳过 HTTP MCP 初始化。并行工具调用按收到顺序执行，每个结果和附加上下文合并为一次持久化。PTC SDK 说明随工具目录提供一次。
- 在对话中显示失败阶段，区分超时、连接中断、认证和空响应。取消后待审批请求返回 ACP 取消状态。

## 0.8.3

- 输入区新增常驻“ACP 连接”入口，可独立查看各智能体状态和刷新登录。DSH 未选择模型时会直接打开模型列表，跳过原刷新面板所在的菜单根层；保留原根层面板，同时让新会话也能恢复连接。
- 后台首次创建会话返回 AUTH 时显示“需要登录”，不再统一显示“检测失败”。后台仍不主动登录，手动刷新才尝试一次认证并验证回复。
- 显式声明前端使用的远端命令及输入区插件依赖。
- 同步 README、安装说明、工具与审批配置及开发清单到 0.8.3：修正 released 工具/图片能力、常驻刷新入口、手动登录、超时与凭据持久化边界；历史诊断记录保留版本背景。

## 0.8.2

- 完整版 CodeBuddy CLI（`@tencent-ai/codebuddy-code` 2.184.0，带 `dist/codebuddy-headless.js`）在本机与桌面端共用固定端口 `127.0.0.1:13034`：桌面运行时普通 `--acp` 报 `EADDRINUSE`，`--acp --port 0` 静默退出。插件对同时带 lite/headless bundle 的完整安装也改用 `--serve --acp --acp-transport stdio --port 0`，用随机端口避开桌面。
- 完整版不注入 `CODEBUDDY_CREDENTIALS_IN_MEMORY`，保留文件凭据以便重启后免登；需要隔离时可在 `agents[].env` 显式配置该变量。核对 2.184.0 headless bundle：`FileAuthenticationStorage`、`sharedDataPath=~/AppData/Local/CodeBuddyExtension/Data/Public`、authenticate 先 logout 与精简版一致，因此换完整版不自动解决共享 auth 文件的互踢；服务端是否允许两端并存仍未实测。
- 本机实测 `--serve --acp --acp-transport stdio --port 0` 握手成功：ACP v1、19 个模型、image 与 HTTP MCP 可用，authMethods 为 iOA/external/internal/selfhosted。未执行账号登录，未替换已安装插件。

## 0.8.1

- 桌面精简版 WorkBuddy 默认启用其内置 CODEBUDDY_CREDENTIALS_IN_MEMORY=1：独立 ACP 进程仅保存自己的内存登录，不读写/监听桌面共享凭据文件，避免缺少私有加密引导环境时的凭据回读失效。显式配置值仍优先。
- 不提取桌面凭据或加密密钥，不修改桌面加密策略。退出 DSH 后内存登录消失，下次需手动刷新登录。服务器侧是否允许两端账号共存仍需实测。
- released 通过显式 finish failure 携带 AUTH 等错误码，不依赖跨包异常类型判定，避免已分类错误又被归类为 UNKNOWN。
- 根据真实日志确认同 PID 内登录后认证被清空；用户参与的真实内存登录测试通过：同一进程登录一次，两轮新会话均回复 OK，第二轮在等待 30 秒后进行；日志未见登录后状态清空或共享认证文件 missing-key。DSH 内对话及桌面共存仍待安装后验证。

## 0.8.0

- 启动/启用插件后自动连接各 agent 一次，后台不主动认证。默认 released 保留每个 agent 的 CLI 进程，手动登录后的对话复用同进程凭据，每轮创建独立 ACP 会话。
- 手动刷新同时验证目录与实际模型响应，只有 AUTH 失败才调用一次已声明支持的认证方法；随后在同一进程复验。非认证错误不登录，不自动循环认证。
- 重复刷新合并，新增验证登录/等待登录状态；同一 agent 串行，不同 agent 独立。新增 loginMs 默认 180 秒，目录/响应验证各受 discoveryMs 约束。
- 卸载取消登录/排队请求，清理保留进程、临时目录与每轮 MCP 网关；旧目录和其他 provider 可继续使用。
- 常规 93 项通过；额外用真实 ACP SDK 1.4.0 + 本地测试子进程验证认证错误、登录与跨会话进程复用。真实账号登录弹窗及桌面验收尚未执行。

## 0.7.2

- 修复 WorkBuddy 将认证/额度/服务错误包装在 refusal + _meta 时，插件丢失真实原因的问题；保留明确的 AUTH/QUOTA/RATE_LIMIT 分类，过滤原始错误的敏感详情。
- 区分目录已连接、最近对话已验证、需要登录及上次对话失败；目录刷新不会清除已知的对话认证失败。
- 目录探测默认截止 15 秒改为 60 秒，成功缓存 5 分钟、失败冷却仍为 30 秒；菜单首次等待仍为 800 毫秒。
- 实际对话连接更新目录；较晚返回的旧后台探测不能覆盖更新的成功连接。
- 本机复现：Codex/Qoder 空会话约 26 秒；Codex 实际回复 OK；WorkBuddy 列目录成功但模型请求返回 Authentication required。未重新登录，未宣称 WorkBuddy 已恢复。

## 0.7.1

- Qoder 自动识别 npm 安装前缀、APPDATA/npm 和 PATH；通过 Node 启动包声明的 JS 入口，兼容旧配置中的失效原生 exe 路径，保留自定义命令与参数。
- 刷新失败显示经过分类的登录、路径或超时原因；从未加载成功时不再声称已保留上次可用模型。不展示原始 CLI 错误中的潜在敏感信息。
- 本机 npm Qoder CLI 1.1.89 在正常用户环境中完成 ACP initialize，session/new 返回 Authentication required；未重新登录或发送模型任务。
- 新增路径识别与诊断回归，真实账号成功会话待 CLI 登录后验证。

## 0.7.0

- 放开 engines.dsh 与 DSH peer 版本限制，支持 rc.3 及后续版本尝试加载；启动按必要宿主接口自检，缺失才报不兼容。未来接口语义变化仍可能需要适配。
- 模型菜单新增 ACP 独立刷新按钮与检测转圈；首次失败明确标注，已知模型在刷新期间和失败后保留。
- 手动刷新绕过失败冷却，同一提供方共用在途探测；完成即推送状态，未改变目录也会清除加载提示。
- 后台探测独立计数，不占用对话 maxBindings，继续禁止后台主动认证。
- 已检查本机 rc.3 宿主接口；单元测试不代替真实桌面点击和账号对话验收。

## 0.6.2

- 本机 WorkBuddy CLI 2.165.0 的 authenticate 实现会先 logout 再 login。修复插件无条件重认证造成反复弹窗、可能挤掉桌面登录的触发路径。
- WorkBuddy 默认 authMode=existing，仅尝试已有 CLI 凭据；显式 authMode=authenticate 才重新认证。已有自定义启动参数的 WorkBuddy 行也应用此默认值。
- 所有后台目录发现禁用主动认证，避免刷新模型列表触发账号操作；无有效登录时保留默认入口并报错，不自动拉起浏览器。
- 撤回“反复登录证明 CLI 登录态仅单进程有效”的过早结论。已有凭据能否免登、首次登录后两端是否共存尚未验证；本次未执行实际重新登录，以免再次影响桌面账号。
- 语法检查及 66 项回归通过，包含免登模式不调用 authenticate、显式认证仍可用与后台探测不认证。

## 0.6.1

- 修复模型发现使用无限启动截止、认证或建会话挂起时拖住菜单刷新的路径。模型目录默认独立截止 15 秒，菜单首次等待最多 800 毫秒，不改变对话长任务不限时策略。
- 模型目录支持部分返回：按 provider 保留上次成功结果；未加载时返回带说明的 Default 入口，后台完成后通过 llm/models-updated 通知 DSH 更新。
- 同一 provider 共享在途探测；TTL 从完成时计算，失败冷却 30 秒；探测失败保留已知模型和图片能力，记录失败阶段并清理子进程。
- 新增回归覆盖卡住 provider、并发刷新、旧列表保留、失败冷却、更新事件去重及认证超时清理；真实桌面截图场景仍待验收。

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
