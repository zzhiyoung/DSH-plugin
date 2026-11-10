export function appendPluginRecord(session, kind, data) {
  const record = { kind, data }
  session.records ??= []
  session.records.push(record)
  return record
}

export function SessionSeq(value) {
  return value
}
