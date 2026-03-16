/* ==========================================================================
   Context Summarizer
   Compresses older conversation messages into a concise summary to
   free context window space while preserving key information.
   ========================================================================== */

import { openRouterService, type LLMMessage } from './openrouter-service'

const SUMMARY_PREFIX = '📋 **Context Summary:**'

const SUMMARIZE_SYSTEM_PROMPT = `You are a conversation summarizer for a tabletop RPG AI assistant (Foundry VTT).
Summarize the conversation so far into a concise but thorough summary that captures all important information.

PRESERVE these details:
- Character names, NPC names, and their relationships
- Locations mentioned and their descriptions
- Items, artifacts, quests, and objectives discussed
- Combat outcomes and important dice rolls
- Decisions made and their consequences
- Any world-building details or lore established
- The current situation and what was happening most recently

FORMAT: Write in past tense as a factual summary. Use bullet points for key facts. Keep it as concise as possible while retaining all actionable information the AI would need to continue the conversation coherently.

Do NOT include pleasantries, meta-commentary, or your own observations. Just the facts.`

/**
 * Summarize a set of older messages into a concise recap.
 */
export async function summarizeMessages(messagesToSummarize: LLMMessage[], model: string): Promise<string> {
	// Format messages into readable text for the summarizer
	const formatted = messagesToSummarize
		.filter((m) => m.role !== 'system')
		.map((m) => {
			if (m.role === 'tool') {
				// Condense tool results — the summarizer doesn't need raw JSON
				const preview = typeof m.content === 'string' ? m.content.slice(0, 200) : ''
				return `[Tool: ${m.name}] ${preview}`
			}
			const label = m.role === 'user' ? 'User' : 'Assistant'
			return `${label}: ${m.content || '(no content)'}`
		})
		.join('\n\n')

	const response = await openRouterService.chatCompletion({
		model,
		messages: [
			{ role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
			{
				role: 'user',
				content: `Summarize this conversation:\n\n${formatted}`,
			},
		],
		temperature: 0.3,
		max_tokens: 2048,
	})

	const summary = response.choices?.[0]?.message?.content
	if (!summary) throw new Error('Summarization returned empty response')

	return summary
}

/**
 * Determine the split point: messages before this index get summarized,
 * messages at and after this index are kept intact.
 *
 * Ensures tool call/result pairs aren't split across the boundary.
 */
export function getSplitIndex(messages: LLMMessage[], keepCount: number): number {
	const totalNonSystem = messages.filter((m) => m.role !== 'system').length
	if (totalNonSystem <= keepCount) return -1 // Not enough messages to summarize

	// Start from the proposed split
	let splitAt = messages.length - keepCount

	// Walk backward to avoid splitting a tool-call cycle
	// If splitAt lands on a 'tool' message, move it back to include the
	// preceding assistant message with tool_calls
	while (splitAt > 0 && messages[splitAt]?.role === 'tool') {
		splitAt--
	}

	// If splitAt lands on an assistant message with tool_calls, include it
	// in the "keep" set (move split before it)
	if (splitAt > 0 && messages[splitAt]?.role === 'assistant' && messages[splitAt]?.tool_calls?.length) {
		splitAt--
	}

	// Must have at least 2 messages to summarize to be worthwhile
	if (splitAt < 2) return -1

	return splitAt
}

/**
 * Check whether a message is a previously generated context summary.
 */
export function isSummaryMessage(message: LLMMessage): boolean {
	return (
		message.role === 'assistant' && typeof message.content === 'string' && message.content.startsWith(SUMMARY_PREFIX)
	)
}

/**
 * Create a summary LLMMessage from summary text.
 */
export function createSummaryMessage(summaryText: string): LLMMessage {
	return {
		role: 'assistant',
		content: `${SUMMARY_PREFIX}\n\n${summaryText}`,
	}
}

/**
 * Perform a full summarization pass on a conversation:
 * 1. Split messages into "to summarize" and "to keep"
 * 2. Call the API to summarize the older messages
 * 3. Return the new message array: [summary, ...kept]
 *
 * Returns null if there aren't enough messages to summarize.
 */
export async function summarizeConversation(
	messages: LLMMessage[],
	model: string,
	keepCount: number,
): Promise<{ messages: LLMMessage[]; tokensSaved: number } | null> {
	const splitAt = getSplitIndex(messages, keepCount)
	if (splitAt === -1) return null

	const toSummarize = messages.slice(0, splitAt)
	const toKeep = messages.slice(splitAt)

	// If the first message is already a summary, include its content in the
	// new summarization so we don't lose previously summarized info
	const existingSummaryContent =
		toSummarize.length > 0 && isSummaryMessage(toSummarize[0]) ? toSummarize[0].content : null

	const messagesForSummary = existingSummaryContent
		? [{ role: 'assistant' as const, content: existingSummaryContent }, ...toSummarize.slice(1)]
		: toSummarize

	const summaryText = await summarizeMessages(messagesForSummary, model)
	const summaryMsg = createSummaryMessage(summaryText)

	// Rough token savings estimate
	let oldTokens = 0
	for (const m of toSummarize) {
		oldTokens += typeof m.content === 'string' ? Math.ceil(m.content.length / 4) : 0
	}
	const newTokens = Math.ceil(summaryText.length / 4)
	const tokensSaved = Math.max(0, oldTokens - newTokens)

	return {
		messages: [summaryMsg, ...toKeep],
		tokensSaved,
	}
}
