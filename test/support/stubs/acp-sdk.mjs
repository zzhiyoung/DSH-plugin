export const PROTOCOL_VERSION = 1

export class RequestError extends Error {
  constructor(code) {
    super(`ACP request failed with ${code}`)
    this.code = code
  }
}

export const methods = {
  client: { session: { update: 'session/update', requestPermission: 'session/request_permission' } },
  agent: { initialize: 'initialize', session: { new: 'session/new', prompt: 'session/prompt' } },
}

export function client() {
  throw new Error('The ACP client is not available in unit tests.')
}

export function ndJsonStream() {
  throw new Error('The ACP transport is not available in unit tests.')
}
