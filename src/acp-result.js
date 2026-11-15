import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Some agents report backend failures as refusal + vendor metadata, rather than JSON-RPC errors. */
export function promptFailure(result, title) {
  const raw = result?._meta?.['codebuddy.ai/errorMessage'] ?? result?._meta?.errorMessage ?? result?.errorMessage;
  if (raw) {
    let detail = raw;
    if (typeof detail === 'string') { try { detail = JSON.parse(detail); } catch { /* Plain vendor message. */ } }
    const category = detail?.data?.category;
    const message = typeof detail === 'string' ? detail : [detail?.message, detail?.data?.details].filter((s) => typeof s === 'string').join(' ');
    // Categorize without copying upstream output, URLs or credentials into the DSH transcript.
    if (detail?.code === -32000 || category === 'auth' || /authentication required|unauthori[sz]ed|please.*(?:login|sign in)|not logged in/i.test(message)) {
      return new HarnessError(`${title} CLI 对话认证失败：能读取模型目录不代表已登录。请完成对应 CLI 登录，或点击刷新发起一次登录后重试。`, 'AUTH');
    }
    if (/quota|insufficient.*(?:credit|balance)|余额|额度/i.test(message)) return new HarnessError(`${title} 模型服务额度不足，请检查对应账号。`, 'QUOTA');
    if (/rate.?limit|too many requests|429/i.test(message)) return new HarnessError(`${title} 模型服务限流，请稍后重试。`, 'RATE_LIMIT');
    return new HarnessError(`${title} CLI 返回模型服务错误（停止原因：${result.stopReason ?? '未知'}），目录连接正常不代表对话请求成功。请检查对应 CLI 的账号和服务状态。`, 'SERVER');
  }
  if (result?.stopReason === 'refusal') return new HarnessError(`${title} 智能体拒绝继续当前请求（refusal），未提供进一步原因；这不等同于连接中断。`, 'ACP_REFUSAL');
}
