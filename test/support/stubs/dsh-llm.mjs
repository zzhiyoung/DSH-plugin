export class LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: provider }
  }
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  listModels() {
    return Promise.resolve([])
  }
  async *stream() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function ToolCallId(value) {
  return value
}

export function isAgentLoopRequest() {
  return true
}
