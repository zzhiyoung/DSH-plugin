/* DSH client module: use the host's React and slot registry, without bundling another runtime. */
window.__ModuleLoader__.load({ id: 'dsh-acp-agent-hub', factory: (require) => {
  const React = require('react');
  const h = React.createElement;
  const inject = ['slots', 'modelDirectories', 'remote', 'remote.commands'];
  function apply(ctx) {
    function StatusPanel({ directory, refresh, locked, reportFailure }) {
      const state = React.useSyncExternalStore(directory.subscribe, directory.getSnapshot);
      const [refreshing, setRefreshing] = React.useState(() => new Set());
      const [error, setError] = React.useState('');
      const rows = state.groups.filter((group) => group.id.startsWith('acp-'));
      const reload = async (provider) => {
        setRefreshing((before) => new Set([...before, provider]));
        setError('');
        try {
          const response = await refresh(provider);
          if (!response.ok) throw new Error(response.error.message);
          if (!response.value) throw new Error('刷新命令不可用，请检查插件是否启用。');
          if (response.value.result.kind === 'error') throw new Error(response.value.result.text);
        } catch (err) {
          setError(String(err.message ?? err));
          reportFailure?.(String(err.message ?? err));
        } finally {
          setRefreshing((before) => { const next = new Set(before); next.delete(provider); return next; });
        }
      };
      if (!rows.length) return null;
      return h('div', { style: { padding: '8px 12px', borderTop: '1px solid var(--dsw-color-border, #8884)' } },
        h('style', null, '@keyframes acp-hub-spin { to { transform: rotate(360deg) } }'),
        h('div', { style: { fontSize: 12, opacity: 0.7, marginBottom: 6 } }, 'ACP 连接检测'),
        ...rows.map((group) => {
          const model = group.models.find((row) => row.id === '@default');
          const authenticating = model?.name.includes('等待登录');
          const validating = model?.name.includes('验证登录');
          const busy = refreshing.has(group.id) || model?.name.includes('检测中') || authenticating || validating;
          const failed = model?.name.includes('失败');
          const auth = model?.name.includes('需要登录');
          const verified = model?.name.includes('对话已验证');
          const connected = model?.name.includes('目录已连接') || model?.name.includes('已就绪');
          const status = authenticating ? '等待登录…' : validating ? '验证登录中…' : busy ? '检测中…' : auth ? '需要登录' : failed ? '检测失败' : verified ? '对话已验证' : connected ? '目录已连接' : '尚未检测';
          return h('div', { key: group.id, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' } },
            h('span', { style: { flex: 1 } }, group.name),
            busy ? h('span', { 'aria-hidden': true, style: { display: 'inline-block', width: 12, height: 12, border: '2px solid currentColor', borderRightColor: 'transparent', borderRadius: '50%', animation: 'acp-hub-spin 0.8s linear infinite' } }) : null,
            h('span', { role: 'status', title: model?.description, style: { fontSize: 12 } }, status),
            h('button', { type: 'button', disabled: locked || busy, 'aria-label': `刷新 ${group.name}`, onClick: () => reload(group.id) }, '刷新'));
        }),
        error ? h('div', { role: 'alert', style: { fontSize: 12 } }, error) : null);
    }
    const sessionProps = (sessionId) => ({
        directory: ctx.modelDirectories.directoryFor(sessionId).store,
        refresh: (provider) => ctx.remote.commands.execute(sessionId, `/acp-refresh ${provider}`, []),
    });
    ctx.slots.inject('conversation.input.model.options', () => ctx.slots.register({
      name: 'conversation.input.model.options', id: 'acp-agent-hub-status', order: 50,
      inject: sessionProps,
    }, StatusPanel));
    // A blank session opens the host's model list directly, skipping model.options.
    // Keep recovery reachable before any model has been selected.
    function ConnectionMenu(props) {
      return h('details', { style: { position: 'relative' } },
        h('summary', { 'aria-label': 'ACP 连接', style: { cursor: 'pointer', fontSize: 12, listStyle: 'none', padding: '4px 8px' } }, 'ACP 连接'),
        h('div', { style: { position: 'absolute', right: 0, bottom: 'calc(100% + 8px)', zIndex: 100, width: 320, maxWidth: '80vw', maxHeight: '60vh', overflowY: 'auto', borderRadius: 12, background: 'var(--dsw-alias-surface-l1, #fff)', color: 'var(--dsw-alias-label-primary, #222)', boxShadow: '0 4px 24px #0002' } },
          h(StatusPanel, props)));
    }
    ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
      name: 'conversation.input.right', id: 'acp-agent-hub-connections', order: 50,
      inject: sessionProps,
    }, ConnectionMenu));
  }
  return { apply, inject };
} });
