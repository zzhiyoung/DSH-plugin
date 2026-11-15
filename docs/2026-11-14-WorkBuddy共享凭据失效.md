# WorkBuddy 共享凭据失效调查

## 证据与判断

安装版本 0.8.0。用户报告登录验证后再次失效，模型目录已与客户端一致。读取对应 DSH 会话和 WorkBuddy CLI 日志，未提取凭据或密钥内容。

同一 CLI PID 在 21:46:39 启动；21:46:48 发出模型请求后报告 Authentication required；21:46:55 登录得到账号，随后数百毫秒内账号状态又变为 empty。21:47:29 的再次登录亦出现同类清空。对应刷新中有一次成功；后续两次刷新和实际模型请求仍失败，不能把整个过程解释成仅显示了加载提示。

同一日志记录 FileAuthenticationStorage 在 auth/workbuddy-desktop.info 上的 missing-key（read/write），中间有 recovered/read。结合源码的凭据文件解码、监听回读与 currentSessionSubject 更新逻辑，失效链路指向独立 CLI 缺少桌面私有的加密引导环境。不是简单的 DSH 重启 CLI。

CLI 源码提供 CODEBUDDY_CREDENTIALS_IN_MEMORY=1：store 仅写 memorySession，restore 直接返回内存，不初始化共享认证文件 watcher。因此选择此内置模式隔离 CLI 登录，保留现有进程，不读取/复制桌面凭据或密钥，不修改桌面的加密策略。该因果判断仍需真实账号连续对话验证。

## 修改与边界

0.8.1 只给自动识别出的 WorkBuddy 精简桌面布局默认添加内存凭据变量，显式配置优先；完整 CLI 不变。用户的自定义启动参数需显式配置该变量。DSH 关闭即丢失内存登录，下次通过手动刷新登录；不承诺服务器允许两端登录共存。

另修复 released 流通过显式 finish/error 传出 AUTH 等已分类错误码，不依赖异常类型判定，避免已分类错误又被宿主归为 UNKNOWN。

模拟测试/SDK 集成不等同于真实账号恢复。未替换已安装插件，未修改客户端认证文件。

## 非交互自检

真实精简 CLI 加 CODEBUDDY_CREDENTIALS_IN_MEMORY=1 后，initialize 约 1.6 秒完成，session/new 返回 AUTH（尚未独立登录）。这与隔离模式不恢复共享认证文件的设计一致；不代表登录后已验证。真实 ACP SDK 的本地模拟子进程集成通过。另已准备登录后立即一轮、隔 30 秒再一轮的连续测试，需用户浏览器登录才能执行。

## 用户参与的真实登录验证

2026-11-14 用户选择“现在验证”后，以 0.8.1 源码、真实 ACP SDK 和本机 WorkBuddy CLI 执行内存登录测试。未修改或复制桌面凭据文件。

- memoryOnly=true；只启动一个 CLI 进程。
- 约 1.37 秒进入等待登录，约 9.09 秒回到验证阶段，约 15.57 秒验证通过。
- 第一轮新会话约 21.07 秒结束：end_turn，正文 OK。
- 等待 30 秒后，第二轮新会话约 53.86 秒结束：end_turn，正文 OK；spawns 始终为 1，登录仅一次。
- 对应 CLI 日志：登录后用户状态清空事件 0；共享 auth/workbuddy-desktop.info 的 missing-key 警告 0。
- 测试完成后关闭测试进程，内存登录随之结束。已安装 DSH 插件尚未替换，DSH 内正常对话和桌面客户端账号共存仍需安装后的实际验证。

该结果支持内存凭据隔离修复了本次复现的“共享存储回读后失效”路径；不证明任意时长、所有模型或客户端共存均已稳定。
