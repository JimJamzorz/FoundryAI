/* ==========================================================================
   Token Estimator
   Provides approximate token counts for context window measurement.
   Uses a char/4 heuristic for estimation; actual counts come from the API.
   ========================================================================== */

import type { LLMMessage } from './openrouter-service'

/**
 * Fallback context window sizes for common models when the API doesn't
 * return context_length. Keyed by model ID prefix.
 */
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
	'anthropic/claude-sonnet': 200_000,
	'anthropic/claude-opus': 200_000,
	'anthropic/claude-haiku': 200_000,
	'anthropic/claude-3': 200_000,
	'anthropic/claude-4': 200_000,
	'openai/gpt-4o': 128_000,
	'openai/gpt-4-turbo': 128_000,
	'openai/gpt-4': 8_192,
	'openai/gpt-3.5-turbo': 16_385,
	'openai/o1': 200_000,
	'openai/o3': 200_000,
	'google/gemini-2': 1_000_000,
	'google/gemini-pro': 1_000_000,
	'google/gemini-flash': 1_000_000,
	'meta-llama/llama-3': 128_000,
	'mistralai/mistral-large': 128_000,
	'deepseek/deepseek-chat': 128_000,
	'deepseek/deepseek-r1': 128_000,
}

/** Per-message overhead: role label, formatting tokens (~4 per message) */
const PER_MESSAGE_OVERHEAD = 4

/**
 * Estimate token count for a single string.
 * Uses chars/4 heuristic — roughly accurate for English text.
 */
export function estimateStringTokens(text: string): number {
	if (!text) return 0
	return Math.ceil(text.length / 4)
}

/**
 * Estimate token count for a single message, including overhead.
 */
export function estimateMessageTokens(message: LLMMessage): number {
	let tokens = PER_MESSAGE_OVERHEAD

	if (typeof message.content === 'string') {
		tokens += estimateStringTokens(message.content)
	}

	if (message.tool_calls) {
		for (const tc of message.tool_calls) {
			tokens += estimateStringTokens(tc.function.name)
			tokens += estimateStringTokens(tc.function.arguments)
		}
	}

	if (message.name) {
		tokens += estimateStringTokens(message.name)
	}

	return tokens
}

/**
 * Estimate total token count for a message array.
 * Optionally include system prompt and RAG context strings.
 */
export function estimateTokens(messages: LLMMessage[], systemPrompt?: string, ragContext?: string): number {
	let total = 0

	if (systemPrompt) {
		total += estimateStringTokens(systemPrompt) + PER_MESSAGE_OVERHEAD
	}

	if (ragContext) {
		total += estimateStringTokens(ragContext)
	}

	for (const msg of messages) {
		total += estimateMessageTokens(msg)
	}

	return total
}

/**
 * Look up a fallback context limit for a model ID.
 * Matches by prefix — e.g. "anthropic/claude-sonnet-4" matches "anthropic/claude-sonnet".
 */
export function getModelContextLimit(modelId: string): number | null {
	for (const [prefix, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
		if (modelId.startsWith(prefix)) return limit
	}
	return null
}
