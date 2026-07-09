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

/**
 * Shown when a provider rejects the request because its prompt template can't
 * render tool definitions (common with local models — e.g. Gemma has no
 * tool-calling template and LM Studio's Jinja render fails). We retry once
 * without tools and prepend this so the user knows why the AI has no hands.
 */
const TOOLS_UNSUPPORTED_NOTICE =
	"> ⚠️ *The summoned spirit peers into your enchanted toolbox and shrugs — this model does not understand FoundryAI's tools, so it answers with words alone. Bind a tool-trained model (Qwen, Llama, or Mistral Instruct serve well) to give it hands.*\n\n"

export class OpenRouterService {
	private chat: ProviderConfig = DEFAULT_PROVIDER
	private embedding: ProviderConfig = DEFAULT_PROVIDER
	private image: ProviderConfig = DEFAULT_PROVIDER
	private vision: ProviderConfig = DEFAULT_PROVIDER
	private tts: ProviderConfig = DEFAULT_PROVIDER
	private comfyUrl: string = ''
	private customWorkflow: Record<string, any> | null = null
	private defaultModel: string = ''
	private embeddingModel: string = ''
	private imageModel: string = ''
	private visionModel: string = ''
	private ttsModel: string = ''

	configure(options: {
		chat?: ProviderConfig
		embedding?: ProviderConfig
		image?: ProviderConfig
		vision?: ProviderConfig
		tts?: ProviderConfig
		comfyUrl?: string
		comfyWorkflow?: string
		defaultModel?: string
		embeddingModel?: string
		imageModel?: string
		visionModel?: string
		ttsModel?: string
	}): void {
		if (options.chat !== undefined) this.chat = this.resolve(options.chat)
		if (options.embedding !== undefined) this.embedding = this.resolve(options.embedding)
		if (options.image !== undefined) this.image = this.resolve(options.image)
		if (options.vision !== undefined) this.vision = this.resolve(options.vision)
		if (options.tts !== undefined) this.tts = this.resolve(options.tts)
		if (options.comfyUrl !== undefined) this.comfyUrl = options.comfyUrl.trim()
		if (options.comfyWorkflow !== undefined) {
			if (!options.comfyWorkflow) {
				this.customWorkflow = null
			} else {
				try { this.customWorkflow = JSON.parse(options.comfyWorkflow) }
				catch { console.warn('FoundryAI | Invalid comfyWorkflow JSON — workflow not updated') }
			}
		}
		if (options.defaultModel) this.defaultModel = options.defaultModel
		if (options.embeddingModel) this.embeddingModel = options.embeddingModel
		if (options.imageModel) this.imageModel = options.imageModel
		if (options.visionModel !== undefined) this.visionModel = options.visionModel
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

	/**
	 * Some local/self-hosted OpenAI-compatible servers fail to parse a model's tool-call
	 * syntax into the structured `tool_calls` field, leaking the raw tags into `content` or
	 * `reasoning_content` instead and leaving the turn looking like an empty, natural stop.
	 * This recovers a tool call from that leaked text so the conversation can continue
	 * instead of silently dying. Handles two known tag styles:
	 *   - `<function=NAME><parameter=KEY>value</parameter>...</function>`
	 *   - `<tool_call>{"name": "...", "arguments": {...}}</tool_call>` (Hermes-style)
	 */
	recoverLeakedToolCalls(text: string): ToolCall[] | null {
		if (!text) return null

		const fnMatch = text.match(/<function=([\w-]+)>([\s\S]*?)(?:<\/function>|$)/)
		if (fnMatch) {
			const [, name, body] = fnMatch
			const args: Record<string, string> = {}
			for (const m of body.matchAll(/<parameter=([\w-]+)>([\s\S]*?)<\/parameter>/g)) {
				args[m[1]] = m[2].trim()
			}
			return [{ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }]
		}

		const jsonMatch = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/)
		if (jsonMatch) {
			try {
				const parsed = JSON.parse(jsonMatch[1].trim())
				if (parsed?.name) {
					return [{
						id: crypto.randomUUID(),
						type: 'function',
						function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) },
					}]
				}
			} catch {
				// not valid JSON — fall through
			}
		}

		return null
	}

	/** Extract a human-readable message from a failed response, tolerating the
	 *  different error shapes providers use ({message}, {error:{message}}, {error:"..."}). */
	private async readErrorMessage(response: Response): Promise<string> {
		const error = await response.json().catch(() => ({ message: response.statusText }))
		return String(error?.message || error?.error?.message || error?.error || 'Unknown error')
	}

	/**
	 * Does this failure look like "the provider's prompt template can't render
	 * tools"? LM Studio surfaces Jinja render failures as HTTP 400 with wording
	 * like "Error rendering prompt with jinja template" — models without a
	 * tool-calling template (Gemma etc.) hit this whenever tools are attached.
	 */
	private isToolTemplateError(status: number, message: string): boolean {
		return status === 400 && /jinja|prompt template|template|tool/i.test(message)
	}

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

		let response = await fetch(`${this.chat.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: this.headersFor(this.chat),
			body: JSON.stringify(body),
			signal,
		})

		let toolsFallback = false
		if (!response.ok) {
			const errMsg = await this.readErrorMessage(response)
			if (body.tools?.length && this.isToolTemplateError(response.status, errMsg)) {
				console.warn(`FoundryAI | Provider rejected tools (no tool template?): "${errMsg}" — retrying without tools`)
				const { tools: _tools, tool_choice: _toolChoice, ...bareBody } = body
				response = await fetch(`${this.chat.baseUrl}/chat/completions`, {
					method: 'POST',
					headers: this.headersFor(this.chat),
					body: JSON.stringify(bareBody),
					signal,
				})
				if (!response.ok) {
					const retryMsg = await this.readErrorMessage(response)
					console.error(`FoundryAI | API error after tools-free retry (${response.status}):`, retryMsg)
					throw new Error(`API error (${response.status}): ${retryMsg}`)
				}
				toolsFallback = true
				ui.notifications?.warn("FoundryAI: this model doesn't support tool calling — replied without tools.")
			} else {
				console.error(`FoundryAI | API error (${response.status}):`, errMsg)
				throw new Error(`API error (${response.status}): ${errMsg}`)
			}
		}

		const result = await response.json()
		const message = result.choices?.[0]?.message

		if (toolsFallback && message) {
			// Tools were never offered on the retry, so skip tool-call recovery and
			// tell the user (in-fiction) why the AI answered without acting.
			message.content = TOOLS_UNSUPPORTED_NOTICE + (message.content || '')
			console.log('FoundryAI | API chatCompletion response (tools-free fallback):', {
				model: result.model,
				finishReason: result.choices?.[0]?.finish_reason,
				usage: result.usage,
			})
			return result
		}

		// Recover tool calls the server failed to structure before we ever log/return —
		// otherwise this looks identical to the model just giving up with an empty answer.
		if (message && !message.tool_calls?.length) {
			const recovered = this.recoverLeakedToolCalls(message.content || message.reasoning_content || message.reasoning || '')
			if (recovered) {
				console.warn('FoundryAI | Recovered tool call the server failed to structure:', recovered.map(tc => tc.function.name))
				message.tool_calls = recovered
				message.content = null
			}
		}

		console.log('FoundryAI | API chatCompletion response:', {
			model: result.model,
			finishReason: result.choices?.[0]?.finish_reason,
			hasContent: !!message?.content,
			toolCalls: message?.tool_calls?.map((tc: any) => tc.function?.name) || [],
			usage: result.usage,
			// Surface any hidden "thinking" text when content comes back empty — different servers
			// expose this under different keys depending on how they implement reasoning models.
			...(!message?.content && {
				reasoningContent: message?.reasoning_content || message?.reasoning || null,
			}),
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

		let response = await fetch(`${this.chat.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: this.headersFor(this.chat),
			body: JSON.stringify(body),
			signal,
		})

		if (!response.ok) {
			const errMsg = await this.readErrorMessage(response)
			if (body.tools?.length && this.isToolTemplateError(response.status, errMsg)) {
				console.warn(`FoundryAI | Provider rejected tools on stream (no tool template?): "${errMsg}" — retrying without tools`)
				const { tools: _tools, tool_choice: _toolChoice, ...bareBody } = body
				response = await fetch(`${this.chat.baseUrl}/chat/completions`, {
					method: 'POST',
					headers: this.headersFor(this.chat),
					body: JSON.stringify(bareBody),
					signal,
				})
				if (!response.ok) {
					const retryMsg = await this.readErrorMessage(response)
					console.error(`FoundryAI | Stream API error after tools-free retry (${response.status}):`, retryMsg)
					throw new Error(`API error (${response.status}): ${retryMsg}`)
				}
				ui.notifications?.warn("FoundryAI: this model doesn't support tool calling — replying without tools.")
				// Lead the stream with the in-fiction notice so the user sees why
				// the AI is answering without acting on the world.
				onChunk({ content: TOOLS_UNSUPPORTED_NOTICE, done: false })
			} else {
				console.error(`FoundryAI | Stream API error (${response.status}):`, errMsg)
				throw new Error(`API error (${response.status}): ${errMsg}`)
			}
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

	// ---- ComfyUI Image Generation ----

	private async generateImageComfy(prompt: string, size?: string): Promise<{ url?: string; b64_json?: string }> {
		if (!this.customWorkflow) throw new Error('No ComfyUI workflow configured — open Settings and use "Edit Workflow" to paste your workflow JSON.')
		const workflow = JSON.parse(JSON.stringify(this.customWorkflow))

		const findNode = (classType: string) => Object.keys(workflow).find(id => workflow[id]?.class_type === classType)
		const findNodes = (classType: string) => Object.keys(workflow).filter(id => workflow[id]?.class_type === classType)

		// Inject prompt — prefer a PrimitiveStringMultiline (value field), fall back to
		// any CLIPTextEncode whose text is a plain string (not a node reference array)
		const primitiveId = findNode('PrimitiveStringMultiline')
		if (primitiveId) {
			workflow[primitiveId].inputs.value = prompt
		} else {
			for (const id of findNodes('CLIPTextEncode')) {
				if (typeof workflow[id].inputs.text === 'string') {
					workflow[id].inputs.text = prompt
				}
			}
		}

		// Randomise seed
		const randomNoiseId = findNode('RandomNoise')
		if (randomNoiseId) workflow[randomNoiseId].inputs.noise_seed = Math.floor(Math.random() * 2 ** 32)
		const kSamplerId = findNode('KSampler')
		if (kSamplerId) workflow[kSamplerId].inputs.seed = Math.floor(Math.random() * 2 ** 32)

		// Apply dimensions
		if (size) {
			const [w, h] = size.split('x').map(Number)
			if (w && h) {
				const latentId = findNode('EmptyLatentImage')
				if (latentId) { workflow[latentId].inputs.width = w; workflow[latentId].inputs.height = h }
				const fluxSamplingId = findNode('ModelSamplingFlux')
				if (fluxSamplingId) { workflow[fluxSamplingId].inputs.width = w; workflow[fluxSamplingId].inputs.height = h }
			}
		}

		console.log(`FoundryAI | ComfyUI generateImage — prompt: "${prompt.slice(0, 80)}..."`)

		const queueRes = await fetch(`${this.comfyUrl}/prompt`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt: workflow, client_id: 'foundry-ai' }),
		})
		if (!queueRes.ok) throw new Error(`ComfyUI queue error (${queueRes.status}): ${queueRes.statusText}`)

		const { prompt_id } = await queueRes.json()
		console.log(`FoundryAI | ComfyUI prompt queued: ${prompt_id}`)

		// Poll history until complete (max 5 min)
		const deadline = Date.now() + 5 * 60 * 1000
		while (Date.now() < deadline) {
			await new Promise(r => setTimeout(r, 2000))
			const histRes = await fetch(`${this.comfyUrl}/history/${prompt_id}`)
			const history = await histRes.json()
			const entry = history[prompt_id]
			if (!entry) continue
			if (entry.status?.status_str === 'error') throw new Error('ComfyUI generation failed')
			if (!entry.status?.completed) continue

			// Find the first image in any output node
			for (const nodeOutput of Object.values(entry.outputs) as any[]) {
				if (nodeOutput.images?.length > 0) {
					const img = nodeOutput.images[0]
					const url = `${this.comfyUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder ?? '')}&type=${img.type ?? 'output'}`
					console.log(`FoundryAI | ComfyUI image ready: ${url}`)
					return { url }
				}
			}
			throw new Error('ComfyUI completed but no image found in outputs')
		}

		throw new Error('ComfyUI image generation timed out after 5 minutes')
	}

	// ---- Image Generation ----

	async generateImage(prompt: string, model?: string, size?: string): Promise<{ url?: string; b64_json?: string }> {
		if (this.comfyUrl) return this.generateImageComfy(prompt, size)
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

	// ---- Image Description (Vision) ----

	async describeImage(imageUrl: string, question: string, model?: string): Promise<string> {
		if (!this.isConfigured) throw new Error('No API provider configured')

		// Use vision provider if configured, otherwise fall back to chat provider
		const provider = this.vision.baseUrl && this.vision.baseUrl !== OPENROUTER_BASE || this.vision.apiKey
			? this.vision
			: this.chat
		const selectedModel = model || this.visionModel || this.defaultModel

		const response = await fetch(`${provider.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: this.headersFor(provider),
			body: JSON.stringify({
				model: selectedModel,
				messages: [
					{
						role: 'user',
						content: [
							{ type: 'image_url', image_url: { url: imageUrl } },
							{ type: 'text', text: question },
						],
					},
				],
				max_tokens: 1024,
			}),
		})

		if (!response.ok) {
			const rawText = await response.text().catch(() => response.statusText)
			console.error(`FoundryAI | Vision error (${response.status}) raw body:`, rawText)
			let err: any = {}
			try { err = JSON.parse(rawText) } catch {}
			throw new Error(`Vision error (${response.status}): ${err.message || err.error?.message || rawText || 'Unknown error'}`)
		}

		const result = await response.json()
		return result.choices?.[0]?.message?.content ?? 'No description returned'
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
