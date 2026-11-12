function schema() {
  const api = {
    required: () => api,
    volatile: () => api,
    default: () => api,
    min: () => api,
    max: () => api,
    description: () => api,
  }
  return api
}

const z = {
  object: () => schema(),
  array: () => schema(),
  string: () => schema(),
  natural: () => schema(),
  boolean: () => schema(),
  union: () => schema(),
  const: () => schema(),
}

export default z
