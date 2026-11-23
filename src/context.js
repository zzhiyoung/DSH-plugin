const INSTRUCTION = 'Answer the current requests in order. Treat prior messages as conversation context.'
const SKILL_INSTRUCTION = ' Use the dsh MCP skill tool to load applicable skills from the listed catalog.'
const OMITTED_IMAGE = '[Image omitted]'

function imageLabel(number, seq) {
  return '[Image ' + number + ', message ' + seq + ']'
}

function partsText(parts, label) {
  return parts.map((part) => typeof part === 'string' ? part : label(part)).join('\n')
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value))
}

/** Reserve the current request and tool guide, then retain the newest history that fits. */
function prepareContext(turn, coveredTo, shared, showSkills, maxBytes, { includeImages, imageInput, guide, previousImages = 0 }) {
  const session = turn.agent.session
  const currentImages = []
  const request = turn.inputs.filter(({ message }) => message.source.kind === 'user').map(({ seq, message }) => ({
    seq,
    id: message.id,
    text: message.content.map((block) => {
      if (block.type === 'text') return block.text
      if (block.type !== 'image' || !includeImages) throw new Error('ACP Hub accepts text-only input. Send a text message to continue.')
      if (!imageInput) throw new Error('This ACP agent does not advertise image prompt support.')
      currentImages.push({ seq, block })
      return imageLabel(previousImages + currentImages.length, seq)
    }).join('\n'),
  }))
  if (!request.length) throw new Error('ACP Hub requires a new human message to start a prompt.')

  const current = new Set(request.map((row) => row.seq))
  const candidates = []
  let skillEntries = []
  for (const seq of session.surface.nodes) {
    const covered = seq < (coveredTo ?? 0)
    if (current.has(seq) || (covered && !showSkills)) continue
    const event = session.eventAt(seq)
    if (event === undefined) continue
    const message = session.deriveEventMessage(event)
    if (message === null || message.role === 'system' || message.role === 'developer') continue
    if (showSkills && message.role === 'user' && message.source.kind === 'skill-catalog') skillEntries = message.source.entries
    if (covered || (message.role === 'user' && message.source.kind !== 'user')) continue
    if (message.role === 'tool' && !shared.has(message.toolCallId)) continue
    candidates.push({ seq, message })
  }

  const skills = []
  const prefix = {
    version: 1,
    mode: coveredTo === undefined ? 'snapshot' : 'delta',
    ...(showSkills ? { skills } : {}),
  }
  const instruction = INSTRUCTION + (showSkills ? SKILL_INSTRUCTION : '')
  const suffix = guide ? '\n' + guide : ''
  const format = (history) => instruction + '\n' + JSON.stringify({ ...prefix, history, request }) + suffix
  let remaining = (maxBytes || Infinity) - Buffer.byteLength(format([]))
  if (remaining < 0) throw new Error('ACP Hub context exceeds the configured byte limit for the current request and tool guide.')

  for (const { name, description } of skillEntries) {
    const entry = { name, description }
    const size = jsonBytes(entry) + (skills.length ? 1 : 0)
    if (size > remaining) continue
    skills.push(entry)
    remaining -= size
  }

  const history = []
  let imageNumber = previousImages + currentImages.length
  for (let index = candidates.length - 1; index >= 0 && remaining > 0; index--) {
    const { seq, message } = candidates[index]
    const images = []
    const parts = message.content.flatMap((block) => {
      if (block.type === 'text') return [block.text]
      if (block.type !== 'image' || !includeImages || message.role !== 'user') return []
      if (!imageInput) return [OMITTED_IMAGE]
      const image = { seq, block }
      images.push(image)
      return [image]
    })
    const text = partsText(parts, (image) => imageLabel('', image.seq))
    if (!text) continue
    const record = { seq, id: message.id, role: message.role, text, ...(message.role === 'tool' ? { callId: message.toolCallId } : {}) }
    let size = jsonBytes(record) + (history.length ? 1 : 0)
    // The digits depend on the number of retained images, regardless of message order.
    for (let offset = 1; offset <= images.length; offset++) size += String(imageNumber + offset).length
    if (size > remaining) continue
    history.push({ record, parts, images })
    remaining -= size
    imageNumber += images.length
  }
  history.reverse()
  return { format, history, currentImages }
}

function renderContext({ format, history }, label) {
  return format(history.map(({ record, parts, images }) => images.length ? { ...record, text: partsText(parts, label) } : record))
}

/** Project the canonical DSH session surface without host instructions or tool arguments. */
export function projectContext(turn, coveredTo, shared, showSkills, maxBytes, images) {
  const context = prepareContext(turn, coveredTo, shared, showSkills, maxBytes, {
    includeImages: images !== undefined, imageInput: true, previousImages: images?.length,
  })
  for (const image of context.currentImages) images.push(image)
  return renderContext(context, (image) => {
    images.push(image)
    return imageLabel(images.length, image.seq)
  })
}

/** Current images are required. Historical images are optional and newest take priority. */
export async function projectPrompt(turn, coveredTo, shared, showSkills, config, attachments, signal, { guide, imageInput = true } = {}) {
  signal.throwIfAborted()
  const context = prepareContext(turn, coveredTo, shared, showSkills, config.maxContextBytes, { includeImages: true, imageInput, guide })
  const prompt = [{ type: 'text', text: '' }]
  let remaining = config.maxImageBytes ?? Infinity
  const read = async ({ block }) => {
    signal.throwIfAborted()
    if (!block.attachment || !attachments?.readImage) throw new Error('DSH image attachment storage is unavailable.')
    const declaredBytes = block.attachment.bytes
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > remaining) throw new Error('ACP images exceed the configured byte limit.')
    const image = await attachments.readImage(block.attachment, signal)
    signal.throwIfAborted()
    const bytes = Math.max(declaredBytes, image.data.byteLength)
    if (!Number.isSafeInteger(bytes) || bytes > remaining) throw new Error('ACP images exceed the configured byte limit.')
    const content = { type: 'image', mimeType: image.ref.mediaType, data: Buffer.from(image.data).toString('base64') }
    remaining -= bytes
    return content
  }

  for (const image of context.currentImages) prompt.push(await read(image))
  const historicalImages = new Map()
  for (let index = context.history.length - 1; index >= 0; index--) {
    for (const image of context.history[index].images) {
      try {
        historicalImages.set(image, await read(image))
      } catch {
        signal.throwIfAborted()
      }
    }
  }
  prompt[0].text = renderContext(context, (image) => {
    const content = historicalImages.get(image)
    if (!content) return OMITTED_IMAGE
    prompt.push(content)
    return imageLabel(prompt.length - 1, image.seq)
  })
  return prompt
}
