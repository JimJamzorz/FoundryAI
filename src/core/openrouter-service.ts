/* ==========================================================================
   OpenRouter API Service
   Handles all communication with the OpenRouter API:
   - Chat completions (with streaming)
   - Embeddings generation
   - Model listing
   ========================================================================== */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'



// ---- Types ----

export interface LLMMessage {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content: string | null
	name?: string
	tool_calls?: ToolCall[]
	tool_call_id?: string
}

export interface ToolCall {
	id: string
	type: 'function'
	function: {
		name: string
		arguments: string // JSON string
	}
}

export interface ToolDefinition {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: Record<string, any>
	}
}

export interface ChatCompletionRequest {
	model: string
	messages: LLMMessage[]
	tools?: ToolDefinition[]
	tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } }
	stream?: boolean
	temperature?: number
	max_tokens?: number
	stop?: string | string[]
	top_p?: number
	frequency_penalty?: number
	presence_penalty?: number
}

export interface ChatCompletionResponse {
	id: string
	choices: Array<{
		finish_reason: string | null
		native_finish_reason: string | null
		message: {
			role: string
			content: string | null
			tool_calls?: ToolCall[]
		}
		error?: { code: number; message: string }
	}>
	model: string
	usage?: {
		prompt_tokens: number
		completion_tokens: number
		total_tokens: number
		cost?: number
	}
}

export interface StreamingChunk {
	id: string
	choices: Array<{
		finish_reason: string | null
		delta: {
			role?: string
			content?: string | null
			tool_calls?: Partial<ToolCall>[]
		}
		error?: { code: number; message: string }
	}>
	model?: string
	usage?: {
		prompt_tokens: number
		completion_tokens: number
		total_tokens: number
		cost?: number
	}
}

export interface EmbeddingRequest {
	model: string
	input: string | string[]
}

export interface EmbeddingResponse {
	data: Array<{
		object: string
		index: number
		embedding: number[]
	}>
	model: string
	usage: {
		prompt_tokens: number
		total_tokens: number
	}
}

export interface ModelInfo {
	id: string
	name: string
	description?: string
	context_length?: number
	pricing?: {
		prompt: string
		completion: string
	}
	top_provider?: {
		max_completion_tokens?: number
	}
	architecture?: {
		modality: string
		tokenizer: string
	}
}

export interface ModelsResponse {
	data: ModelInfo[]
}

// ---- Provider Config ----

export interface ProviderConfig {
	baseUrl: string
	apiKey: string
}

// ---- Streaming Callback ----
export type StreamCallback = (chunk: {
	content?: string
	toolCalls?: Partial<ToolCall>[]
	done: boolean
	usage?: ChatCompletionResponse['usage']
	error?: string
}) => void

// ---- Service Class ----

const DEFAULT_PROVIDER: ProviderConfig = { baseUrl: OPENROUTER_BASE, apiKey: '' }

export class OpenRouterService {
	private chat: ProviderConfig = DEFAULT_PROVIDER
	private embedding: ProviderConfig = DEFAULT_PROVIDER
	private image: ProviderConfig = DEFAULT_PROVIDER
	private tts: ProviderConfig = DEFAULT_PROVIDER
	private defaultModel: string = ''
	private embeddingModel: string = ''
	private imageModel: string = ''
	private ttsModel: string = ''

	configure(options: {
		chat?: ProviderConfig
		embedding?: ProviderConfig
		image?: ProviderConfig
		tts?: ProviderConfig
		defaultModel?: string
		embeddingModel?: string
		imageModel?: string
		ttsModel?: string
	}): void {
		if (options.chat !== undefined) this.chat = this.resolve(options.chat)
		if (options.embedding !== undefined) this.embedding = this.resolve(options.embedding)
		if (options.image !== undefined) this.image = this.resolve(options.image)
		if (options.tts !== undefined) this.tts = this.resolve(options.tts)
		if (options.defaultModel) this.defaultModel = options.defaultModel
		if (options.embeddingModel) this.embeddingModel = options.embeddingModel
		if (options.imageModel) this.imageModel = options.imageModel
		if (options.ttsModel) this.ttsModel = options.ttsModel
	}

	private resolve(p: ProviderConfig): ProviderConfig {
		return { baseUrl: p.baseUrl?.trim() || OPENROUTER_BASE, apiKey: p.apiKey || '' }
	}

	get isConfigured(): boolean {
		return !!(this.chat.apiKey || this.chat.baseUrl !== OPENROUTER_BASE)
	}

	private headersFor(provider: ProviderConfig): Record<string, string> {
		const h: Record<string, string> = { 'Content-Type': 'application/json' }
		if (provider.apiKey) h['Authorization'] = `Bearer ${provider.apiKey}`
		if (provider.baseUrl === OPENROUTER_BASE) {
			h['HTTP-Referer'] = 'https://foundryvtt.com'
			h['X-Title'] = 'FoundryAI'
		}
		return h
	}

	// ---- Chat Completions ----

	async chatCompletion(request: ChatCompletionRequest, signal?: AbortSignal): Promise<ChatCompletionResponse> {
		if (!this.isConfigured) throw new Error('No API provider configured')

		const body: ChatCompletionRequest = {
			...request,
			model: request.model || this.defaultModel,
			stream: false,
		}

		console.log(
			`FoundryAI | API chatCompletion — model: ${body.model}, messages: ${body.messages.length}, tools: ${body.tools?.length || 0}`,
		)

		const response = await fetch(`${this.chat.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: this.headersFor(this.chat),
			body: JSON.stringify(body),
			signal,
		})

		if (!response.ok) {
			const error = await response.json().catch(() => ({ message: response.statusText }))
			console.error(`FoundryAI | API error (${response.status}):`, error)
			throw new Error(`API error (${response.status}): ${error.message || error.error?.message || 'Unknown error'}`)
		}

		const result = await response.json()
		console.log('FoundryAI | API chatCompletion response:', {
			model: result.model,
			finishReason: result.choices?.[0]?.finish_reason,
			hasContent: !!result.choices?.[0]?.message?.content,
			toolCalls: result.choices?.[0]?.message?.tool_calls?.map((tc: any) => tc.function?.name) || [],
			usage: result.usage,
		})
		return result
	}

	async chatCompletionStream(
		request: ChatCompletionRequest,
		onChunk: StreamCallback,
		signal?: AbortSignal,
	): Promise<void> {
		if (!this.isConfigured) throw new Error('No API provider configured')

		const body: ChatCompletionRequest = {
			...request,
			model: request.model || this.defaultModel,
			stream: true,
		}

		console.log(
			`FoundryAI | API stream — model: ${body.model}, messages: ${body.messages.length}, tools: ${body.tools?.length || 0}`,
		)

		const response = await fetch(`${this.chat.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: this.headersFor(this.chat),
			body: JSON.stringify(body),
			signal,
		})

		if (!response.ok) {
			const error = await response.json().catch(() => ({ message: response.statusText }))
			console.error(`FoundryAI | Stream API error (${response.status}):`, error)
			throw new Error(`API error (${response.status}): ${error.message || error.error?.message || 'Unknown error'}`)
		}

		if (!response.body) throw new Error('No response body for streaming request')

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''

		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split('\n')
				buffer = lines.pop() || ''

				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed || trimmed.startsWith(':')) continue
					if (!trimmed.startsWith('data: ')) continue

					const data = trimmed.slice(6)
					if (data === '[DONE]') { onChunk({ done: true }); return }

					try {
						const chunk: StreamingChunk = JSON.parse(data)
						const choice = chunk.choices?.[0]

						if (choice?.error) {
							console.error('FoundryAI | Stream chunk error:', choice.error)
							onChunk({ done: true, error: choice.error.message })
							return
						}

						if (choice?.delta?.tool_calls?.length) {
							console.debug('FoundryAI | Stream tool_call delta:', JSON.stringify(choice.delta.tool_calls))
						}

						onChunk({
							content: choice?.delta?.content || undefined,
							toolCalls: choice?.delta?.tool_calls || undefined,
							done: choice?.finish_reason != null,
							usage: chunk.usage || undefined,
						})
					} catch {
						console.warn('FoundryAI | Skipping malformed SSE chunk:', data.slice(0, 200))
					}
				}
			}
		} finally {
			reader.releaseLock()
		}

		console.debug('FoundryAI | Stream ended (no [DONE] received)')
		onChunk({ done: true })
	}

	// ---- Embeddings ----

	async generateEmbeddings(input: string | string[], model?: string): Promise<EmbeddingResponse> {
		if (!this.isConfigured) throw new Error('No API provider configured')

		const body: EmbeddingRequest = { model: model || this.embeddingModel, input }

		const response = await fetch(`${this.embedding.baseUrl}/embeddings`, {
			method: 'POST',
			headers: this.headersFor(this.embedding),
			body: JSON.stringify(body),
		})

		if (!response.ok) {
			const rawText = await response.text().catch(() => response.statusText)
			console.error('FoundryAI | Embeddings error response body:', rawText)
			let message = response.statusText
			try {
				const error = JSON.parse(rawText)
				message = error.message || error.error?.message || error.detail || rawText
			} catch { message = rawText }
			throw new Error(`Embeddings error (${response.status}): ${message}`)
		}

		return response.json()
	}

	// ---- Models ----

	async listModels(provider: ProviderConfig): Promise<ModelInfo[]> {
		const p = this.resolve(provider)
		const response = await fetch(`${p.baseUrl}/models`, { headers: this.headersFor(p) })

		if (!response.ok) throw new Error(`Failed to fetch models: ${response.statusText}`)

		const data: ModelsResponse = await response.json()
		return data.data
	}

	// ---- Image Generation ----

	async generateImage(prompt: string, model?: string, size?: string): Promise<{ url?: string; b64_json?: string }> {
		if (!this.isConfigured) throw new Error('No API provider configured')

		const body = {
			model: model || this.imageModel || 'openai/dall-e-3',
			prompt,
			n: 1,
			size: size || '1024x1024',
		}

		const imageUrl = `${this.image.baseUrl}/images/generations`
		console.log(`FoundryAI | API generateImage — url: ${imageUrl}, model: ${body.model}, prompt: "${prompt.slice(0, 100)}..."`)

		const response = await fetch(imageUrl, {
			method: 'POST',
			headers: this.headersFor(this.image),
			body: JSON.stringify(body),
		})

		if (!response.ok) {
			const error = await response.json().catch(() => ({ message: response.statusText }))
			console.error(`FoundryAI | Image gen error (${response.status}):`, error)
			throw new Error(
				`Image generation error (${response.status}): ${error.message || error.error?.message || 'Unknown error'}`,
			)
		}

		const result = await response.json()
		const imageData = result.data?.[0]
		if (!imageData) throw new Error('No image data in response')

		console.log(`FoundryAI | Image generated successfully`)
		return { url: imageData.url, b64_json: imageData.b64_json }
	}

	// ---- Text-to-Speech ----

	async generateSpeech(input: string, voice?: string, model?: string): Promise<ArrayBuffer> {
		if (!this.isConfigured) throw new Error('No API provider configured')

		const selectedVoice = voice || 'nova'
		const selectedModel = model || this.ttsModel || 'openai/gpt-4o-mini-tts'

		console.log(
			`FoundryAI | API generateSpeech — model: ${selectedModel}, voice: ${selectedVoice}, input length: ${input.length}`,
		)

		const body = {
			model: selectedModel,
			messages: [{ role: 'user', content: `Read the following text aloud naturally:\n\n${input}` }],
			modalities: ['text', 'audio'],
			audio: { voice: selectedVoice, format: 'wav' },
			stream: true,
		}

		const response = await fetch(`${this.tts.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: this.headersFor(this.tts),
			body: JSON.stringify(body),
		})

		if (!response.ok) {
			const error = await response.json().catch(() => ({ message: response.statusText }))
			console.error(`FoundryAI | TTS error (${response.status}):`, error)
			throw new Error(`TTS error (${response.status}): ${error.message || error.error?.message || 'Unknown error'}`)
		}

		if (!response.body) throw new Error('No response body for TTS streaming request')

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		const audioChunks: string[] = []

		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break

				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split('\n')
				buffer = lines.pop() || ''

				for (const line of lines) {
					const trimmed = line.trim()
					if (!trimmed || trimmed.startsWith(':')) continue
					if (!trimmed.startsWith('data: ')) continue
					const data = trimmed.slice(6)
					if (data === '[DONE]') break
					try {
						const chunk = JSON.parse(data)
						const delta = chunk.choices?.[0]?.delta
						if (delta?.audio?.data) audioChunks.push(delta.audio.data)
					} catch { /* skip malformed */ }
				}
			}
		} finally {
			reader.releaseLock()
		}

		if (audioChunks.length === 0) throw new Error('No audio data received from TTS model')

		const fullBase64 = audioChunks.join('')
		const binaryString = atob(fullBase64)
		const bytes = new Uint8Array(binaryString.length)
		for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i)

		console.log(`FoundryAI | TTS audio generated: ${bytes.byteLength} bytes from ${audioChunks.length} chunks`)
		return bytes.buffer
	}

	// ---- Connection Test ----

	async testConnection(provider: ProviderConfig): Promise<{ success: boolean; message: string }> {
		try {
			const models = await this.listModels(provider)
			return { success: true, message: `✅ Connected — ${models.length} model${models.length !== 1 ? 's' : ''} available` }
		} catch (error: any) {
			return { success: false, message: `❌ ${error.message || 'Unknown error'}` }
		}
	}
}

// Singleton
export const openRouterService = new OpenRouterService()
