import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { AcpConnection } from './connection.js'

/** Own one process per provider, serializing its sessions and preserving process-local login. */
export class AgentConnections {
  entries = new Map();
  constructor(ctx, config, signal, phase = () => {}) { Object.assign(this, { ctx, config, signal, phase }); }
  deadline(ms, signal) { return AbortSignal.any([this.signal, ...(signal ? [signal] : []), AbortSignal.timeout(ms)]); }
  run(command, signal, task) {
    let entry = this.entries.get(command.id);
    if (!entry) { entry = { tail: Promise.resolve() }; this.entries.set(command.id, entry); }
    const work = entry.tail.then(async () => {
      this.signal.throwIfAborted(); signal?.throwIfAborted();
      return task(entry);
    });
    entry.tail = work.catch(() => {});
    if (!signal) return work;
    let cancel;
    const aborted = new Promise((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
    return Promise.race([work, aborted]).finally(() => signal.removeEventListener('abort', cancel));
  }
  async discard(entry) {
    const connection = entry.connection;
    entry.connection = undefined;
    try { await connection?.close(); }
    finally {
      if (entry.cwd && dirname(entry.cwd) === entry.temp) await rm(entry.cwd, { recursive: true, force: true });
      entry.cwd = undefined;
    }
  }
  async ensure(entry, command, signal) {
    if (entry.connection?.available) return entry.connection;
    await this.discard(entry);
    entry.temp = await realpath(tmpdir());
    entry.cwd = await mkdtemp(join(entry.temp, `dsh-acp-${command.id}-`));
    try {
      entry.connection = new AcpConnection(this.ctx.subprocess, { ...command, authMode: 'existing' }, entry.cwd, this.config.cancelGraceMs ?? 5000, new Set());
      await entry.connection.initialize(signal);
      return entry.connection;
    } catch (error) { error.acpStage = entry.connection?.stage; await this.discard(entry); throw error; }
  }
  async inspect(command, { interactive = false, verify = false } = {}) {
    return this.run(command, undefined, async (entry) => {
      const budget = this.config.discoveryMs ?? 60000;
      this.phase(command.id, '检测中…');
      const connection = await this.ensure(entry, command, this.deadline(budget));
      let directory;
      const check = async () => {
        this.phase(command.id, verify ? '验证登录中…' : '检测中…');
        await connection.newSession(entry.cwd, undefined, this.deadline(budget));
        directory = { models: connection.models, imageInput: connection.imageInput };
        if (verify) {
          let text = '';
          const stop = await connection.prompt('连接验证：请只回复 OK。不调用工具，不读取或修改文件。', {
            signal: this.deadline(budget), onPermission: async () => 'rejected',
            onText: (chunk) => { text += chunk; if (Buffer.byteLength(text) > 4096) throw new Error('Connection check output exceeded its limit.'); },
          });
          if (stop !== 'end_turn' || !text.trim()) throw new HarnessError('连接验证没有获得完整文字回复，请重试或检查模型服务。', 'EMPTY_RESPONSE');
        }
        return { ...directory, ...(verify ? { verifiedModel: '@default' } : {}) };
      };
      try {
        try { return await check(); }
        catch (error) {
          if (!interactive || error.code !== 'AUTH') throw error;
          // This is the only automatic login path: one attempt per explicit refresh.
          this.phase(command.id, '等待登录…');
          await connection.authenticate(this.deadline(this.config.loginMs ?? 180000));
          return await check();
        }
      } catch (error) {
        error.acpStage = connection.stage;
        if (directory && error instanceof Error) error.catalog = directory;
        if (error?.name === 'TimeoutError') await this.discard(entry);
        throw error;
      }
    });
  }
  /** The lease stays held through prompt settlement and gateway cleanup. */
  async use(command, { cwd, mcp, mcpTools, signal }, task) {
    return this.run(command, signal, async (entry) => {
      const startup = this.config.startupMs > 0 ? this.deadline(this.config.startupMs, signal) : AbortSignal.any([this.signal, signal]);
      const connection = await this.ensure(entry, command, startup);
      connection.mcpTools = mcpTools;
      try {
        await connection.newSession(cwd, mcp, startup);
        return await task(connection);
      } finally {
        if (signal.aborted || !connection.available || connection.outputError) await this.discard(entry);
      }
    });
  }
  async close() {
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.tail));
    const results = await Promise.allSettled([...this.entries.values()].map((entry) => this.discard(entry)));
    const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (errors.length) throw new AggregateError(errors, 'ACP connection cleanup failed.');
  }
}
