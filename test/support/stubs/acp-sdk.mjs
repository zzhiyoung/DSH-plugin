export const PROTOCOL_VERSION = 1

export class RequestError extends Error {
  constructor(code) {
    super(`ACP request failed with ${code}`)
    this.code = code
  }
}

export const methods = {
  client: { session: { update: 'session/update', requestPermission: 'session/request_permission' } },
  agent: { initialize: 'initialize', authenticate: 'authenticate', session: { new: 'session/new', prompt: 'session/prompt', setConfigOption: 'session/set_config_option', setMode: 'session/set_mode' } },
}

let factory
export function setClientFactory(value) { factory = value }

export function client() {
  if (factory) return factory()
  throw new Error('The ACP client is not available in unit tests.')
}

export function ndJsonStream() {
  if (factory) return {}
  throw new Error('The ACP transport is not available in unit tests.')
}
