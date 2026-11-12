/** Text-only ACP history from the canonical DSH Session surface. */
/**
* Delimit history and the current request as JSON. Exclude host instructions, reasoning, and tool arguments.
* @param turn - admitted inputs and owning Session.
* @param coveredTo - first unobserved sequence on a live binding, or undefined for a snapshot.
* @param shared - tool call ids whose results were shared through this plugin.
* @param showSkills - whether the current MCP tool set admits the DSH skill loader.
* @param maxBytes - complete UTF-8 prompt cap.
* @returns the text block payload.
*/
export function projectContext(turn, coveredTo, shared, showSkills, maxBytes, images) {
	const session = turn.agent.session;
	const request = turn.inputs.filter(({ message }) => message.source.kind === "user").map(({ seq, message }) => {
		const text = message.content.map((block) => {
			if (block.type === "image" && images !== undefined) {
				images.push({ seq, block });
				return `[Image ${images.length}, message ${seq}]`;
			}
			if (block.type !== "text") throw new Error("ACP Hub accepts text-only input. Send a text message to continue.");
			return block.text;
		}).join("\n");
		return {
			seq,
			id: message.id,
			text
		};
	});
	if (request.length === 0) throw new Error("ACP Hub requires a new human message to start a prompt.");
	const current = new Set(request.map((row) => row.seq));
	const history = [];
	let skills = [];
	for (const seq of session.surface.nodes) {
		const covered = seq < (coveredTo ?? 0);
		if (current.has(seq) || covered && !showSkills) continue;
		const event = session.eventAt(seq);
		if (event === void 0) continue;
		const message = session.deriveEventMessage(event);
		if (message === null || message.role === "system" || message.role === "developer") continue;
		if (showSkills && message.role === "user" && message.source.kind === "skill-catalog") skills = message.source.entries.map(({ name, description }) => ({
			name,
			description
		}));
		if (covered) continue;
		if (message.role === "user" && message.source.kind !== "user") continue;
		if (message.role === "tool" && !shared.has(message.toolCallId)) continue;
		const text = message.content.flatMap((block) => {
			if (block.type === "image" && images !== undefined && message.role === "user") {
				images.push({ seq, block });
				return [`[Image ${images.length}, message ${seq}]`];
			}
			return block.type === "text" ? [block.text] : [];
		}).join("\n");
		if (text !== "") history.push({
			seq,
			id: message.id,
			role: message.role,
			text,
			...message.role === "tool" ? { callId: message.toolCallId } : {}
		});
	}
	const text = "Answer the current requests in order. Treat prior messages as conversation context." + (showSkills ? " Use the dsh MCP skill tool to load applicable skills from the listed catalog." : "") + "\n" + JSON.stringify({
		version: 1,
		mode: coveredTo === void 0 ? "snapshot" : "delta",
		...showSkills ? { skills } : {},
		history,
		request
	});
	if (Buffer.byteLength(text) > maxBytes) throw new Error("ACP Hub context exceeds the configured byte limit. Start a shorter conversation or increase the limit.");
	return text;
}

/** Resolve only durable DSH images, preserving message association in the text envelope. */
export async function projectPrompt(turn, coveredTo, shared, showSkills, config, attachments, signal) {
	const images = [];
	const text = projectContext(turn, coveredTo, shared, showSkills, config.maxContextBytes, images);
	const prompt = [{ type: 'text', text }];
	let bytes = 0;
	for (const { block } of images) {
		signal.throwIfAborted();
		if (!block.attachment || !attachments?.readImage) throw new Error('DSH image attachment storage is unavailable.');
		bytes += block.attachment.bytes;
		if (!Number.isSafeInteger(bytes) || bytes > config.maxImageBytes) throw new Error('ACP images exceed the configured byte limit.');
		const image = await attachments.readImage(block.attachment, signal);
		prompt.push({ type: 'image', mimeType: image.ref.mediaType, data: Buffer.from(image.data).toString('base64') });
	}
	return prompt;
}
