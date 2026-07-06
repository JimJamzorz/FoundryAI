import { executeTool, TOOL_DEFINITIONS } from './tool-system'
import type { ToolCall, ToolDefinition } from './openrouter-service'

const TOOL_PREFIX = 'foundry-ai.tool.'

function toMCPToolDefinition(tool: ToolDefinition) {
	return {
		name: tool.function.name,
		description: tool.function.description,
		inputSchema: tool.function.parameters,
	}
}

export class MCPBridge {
	private ws: WebSocket | null = null
	private reconnectAttempts = 0
	private maxReconnectAttempts = 5
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private enabled = false
	private serverUrl = ''

	constructor(serverUrl: string) {
		this.serverUrl = serverUrl
	}

	start(): void {
		this.enabled = true
		this.reconnectAttempts = 0
		this.connect()
	}

	stop(): void {
		this.enabled = false
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer)
			this.reconnectTimer = null
		}
		if (this.ws) {
			this.ws.close()
			this.ws = null
		}
		console.log('FoundryAI | MCP bridge: stopped')
	}

	private connect(): void {
		if (!this.enabled) return

		console.log(`FoundryAI | MCP bridge: connecting to ${this.serverUrl}`)

		try {
			this.ws = new WebSocket(this.serverUrl)
		} catch (err) {
			console.error('FoundryAI | MCP bridge: failed to create WebSocket:', err)
			this.scheduleReconnect()
			return
		}

		this.ws.onopen = () => {
			console.log('FoundryAI | MCP bridge: connected')
			this.reconnectAttempts = 0
		}

		this.ws.onmessage = (event: MessageEvent) => {
			let message: any
			try {
				message = JSON.parse(event.data)
			} catch {
				console.warn('FoundryAI | MCP bridge: received non-JSON message:', event.data)
				return
			}
			this.handleMessage(message)
		}

		this.ws.onclose = () => {
			console.log('FoundryAI | MCP bridge: connection closed')
			this.ws = null
			this.scheduleReconnect()
		}

		this.ws.onerror = (event: Event) => {
			console.error('FoundryAI | MCP bridge: WebSocket error', event)
		}
	}

	private async handleMessage(message: any): Promise<void> {
		if (message.type !== 'mcp-request') return

		const id = message.id
		const method: string = message.data?.method ?? ''

		console.log(`FoundryAI | MCP bridge: received request id="${id}" method="${method}"`)

		// Handle ping
		if (method === 'foundry-mcp-bridge.ping' || method === 'foundry-ai.ping') {
			this.send({ type: 'mcp-response', id, data: { success: true, data: { pong: true } } })
			return
		}

		// Return FoundryAI's tool list so the MCP server can expose it to Claude Desktop
		if (method === 'foundry-ai.get_tools') {
			this.send({ type: 'mcp-response', id, data: { success: true, data: JSON.stringify(TOOL_DEFINITIONS.map(toMCPToolDefinition)) } })
			return
		}

		// Handle tool calls
		if (method.startsWith(TOOL_PREFIX)) {
			const toolName = method.slice(TOOL_PREFIX.length)
			const toolArgs = message.data?.data ?? {}

			const toolCall: ToolCall = {
				id: id ?? 'mcp',
				type: 'function',
				function: {
					name: toolName,
					arguments: JSON.stringify(toolArgs),
				},
			}

			console.log(`FoundryAI | MCP bridge: dispatching tool "${toolName}"`)

			try {
				const result = await executeTool(toolCall)
				this.send({ type: 'mcp-response', id, data: { success: true, data: JSON.parse(result) } })
			} catch (err: any) {
				console.error(`FoundryAI | MCP bridge: tool "${toolName}" threw:`, err)
				this.send({ type: 'mcp-response', id, data: { success: false, error: err?.message ?? String(err) } })
			}
			return
		}

		// Unknown method
		console.warn(`FoundryAI | MCP bridge: unknown method "${method}"`)
		this.send({ type: 'mcp-response', id, data: { success: false, error: `Unknown method: ${method}` } })
	}

	private send(message: any): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(message))
		} else {
			console.warn('FoundryAI | MCP bridge: cannot send — socket not open')
		}
	}

	private scheduleReconnect(): void {
		if (!this.enabled) return
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			console.warn('FoundryAI | MCP bridge: max reconnect attempts reached, giving up')
			return
		}

		const delay = 2000 * Math.pow(2, this.reconnectAttempts)
		this.reconnectAttempts++
		console.log(`FoundryAI | MCP bridge: reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`)

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null
			this.connect()
		}, delay)
	}

	get isConnected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN
	}
}

export let mcpBridge: MCPBridge | null = null

export function initMCPBridge(serverUrl: string): MCPBridge {
	mcpBridge?.stop()
	mcpBridge = new MCPBridge(serverUrl)
	mcpBridge.start()
	return mcpBridge
}
