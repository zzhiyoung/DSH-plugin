import { createInterface } from 'node:readline'
let authenticated = false, sessions = 0
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  let result = {}
  if (method === 'initialize') result = { protocolVersion: 1, authMethods: [{ id: 'internal', name: 'Test login' }], agentCapabilities: { sessionCapabilities: { close: {} }, mcpCapabilities: { http: true } } }
  if (method === 'authenticate') authenticated = true
  if (method === 'session/new') result = { sessionId: 's-' + ++sessions }
  if (method === 'session/prompt') {
    if (!authenticated) result = { stopReason: 'refusal', _meta: { 'codebuddy.ai/errorMessage': JSON.stringify({ code: -32000, message: 'Authentication required' }) } }
    else {
      send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } })
      result = { stopReason: 'end_turn' }
    }
  }
  send({ id, result })
})
