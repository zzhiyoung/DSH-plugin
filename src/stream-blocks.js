/**
 * Turn interleaved ACP text and reasoning fragments into DSH assistant-stream
 * blocks. ACP sends one stream of fragments, while DSH expects closed blocks
 * with increasing indexes, so a fragment that switches kind closes the open
 * block and starts the next one.
 * @param push - receives every stream chunk in emission order.
 * @returns sinks for text and reasoning fragments, plus the final flush.
 */
export function createBlockWriter(push) {
	let index = 0
	let kind
	let text = ''
	const flush = () => {
		if (kind === undefined) return
		push({ type: 'block-end', index, block: kind === 'reasoning' ? { type: 'reasoning', text } : { type: 'text', text } })
		index += 1
		kind = undefined
		text = ''
	}
	const start = (next) => {
		if (kind === next) return
		flush()
		kind = next
		push({ type: 'block-start', index, blockType: next })
	}
	return {
		/** Append one visible assistant-text fragment. */
		text(fragment) {
			if (fragment === '') return
			start('text')
			text += fragment
			push({ type: 'text-delta', index, text: fragment })
		},
		/** Append one reasoning fragment shown as the agent's thinking. */
		reasoning(fragment) {
			if (fragment === '') return
			start('reasoning')
			text += fragment
			push({ type: 'reasoning-delta', index, text: fragment })
		},
		/** Close the block still open, if any. */
		flush,
	}
}
