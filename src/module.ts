/* ==========================================================================
   FoundryAI — Module Entry Point
   Registers hooks, settings, sidebar tab, and exposes the public API.
   ========================================================================== */

import { DEFAULT_MCP_SERVER_URL, registerSettings, getSetting } from './settings'
import { openRouterService } from '@core/openrouter-service'
import { embeddingService } from '@core/embedding-service'
import { chatSessionManager } from '@core/chat-session-manager'
import { sessionRecapManager } from '@core/session-recap-manager'
import { ensureFoundryAIFolders } from '@core/folder-manager'
import { registerCampaignHooks } from '@core/campaign-hooks'
import { registerSessionEventHooks } from '@core/session-event-hooks'
import { sessionEventBuffer } from '@core/session-event-buffer'
import { openPopoutChat } from '@ui/svelte-application'
import { buildSystemPrompt } from '@core/system-prompt'
import ChatWindow from '@ui/components/ChatWindow.svelte'

// Import styles so Vite bundles them
import './styles/foundry-ai.scss'

const MODULE_ID = 'foundry-ai'

// ---- Module Initialization ----

Hooks.once('init', () => {
	console.log('FoundryAI | Initializing module...')

	// Register settings
	registerSettings()

	// Register campaign dashboard hooks (status toggles)
	registerCampaignHooks()

	// Register scene control button (must be before first render)
	registerSceneControlButton()
})

Hooks.once('ready', async () => {
	console.log('FoundryAI | Module ready.')

	// Only proceed for GM
	if (!game.user?.isGM) {
		console.log('FoundryAI | Non-GM user, skipping initialization.')
		return
	}

	// Load persisted session events and register table event hooks
	sessionEventBuffer.load()
	registerSessionEventHooks()

	// Configure OpenRouter service from saved providers
	configureServiceFromSettings()

	// Initialize embedding service
	try {
		const worldId = game.world?.id || 'default'
		await embeddingService.initialize(worldId)
		console.log('FoundryAI | Embedding service initialized.')
	} catch (error) {
		console.error('FoundryAI | Failed to initialize embedding service:', error)
	}

	// Auto-index if configured
	if (openRouterService.isConfigured && getSetting('autoIndex')) {
		const journalFolders = getSetting('journalFolders') || []
		const actorFolders = getSetting('actorFolders') || []

		if (journalFolders.length > 0 || actorFolders.length > 0) {
			// Delay indexing slightly to not block UI
			setTimeout(async () => {
				try {
					console.log('FoundryAI | Starting auto-index...')
					await embeddingService.reindexAll(journalFolders, actorFolders)
					console.log('FoundryAI | Auto-index complete.')
				} catch (error) {
					console.error('FoundryAI | Auto-index failed:', error)
				}
			}, 5000)
		}
	}

	// Start MCP bridge if enabled
	if (getSetting('mcpBridgeEnabled')) {
		const mcpUrl = getSetting('mcpServerUrl') || DEFAULT_MCP_SERVER_URL
		const { initMCPBridge } = await import('@core/mcp-bridge')
		initMCPBridge(mcpUrl)
		console.log(`FoundryAI | MCP bridge started → ${mcpUrl}`)
	}

	// Expose public API
	game.foundryAI = {
		chat: publicChat,
		openChat: () => openPopoutChat(ChatWindow),
		reindex: publicReindex,
		generateSessionRecap: publicGenerateRecap,
		getMCPBridge: () => import('@core/mcp-bridge').then(m => m.mcpBridge),
	}

	// Listen for settings changes
	Hooks.on(`${MODULE_ID}.settingsChanged`, async (key: string) => {
		if (key === 'apiProviders' || key === 'chatProvider') configureServiceFromSettings()
		if (key === 'mcpBridgeEnabled' || key === 'mcpServerUrl') {
			const { mcpBridge: bridge, initMCPBridge } = await import('@core/mcp-bridge')
			if (getSetting('mcpBridgeEnabled')) {
				initMCPBridge(getSetting('mcpServerUrl') || DEFAULT_MCP_SERVER_URL)
			} else {
				bridge?.stop()
			}
		}
	})

	// Ensure standard journal folders exist
	await ensureFoundryAIFolders()

	// Ensure file system directories exist for generated content and PDF uploads
	try {
		const FP: typeof FilePicker = (foundry as any)?.applications?.apps?.FilePicker?.implementation ?? FilePicker
		for (const dir of ['foundry-ai', 'foundry-ai/images', 'foundry-ai/maps', 'foundry-ai/pdfs']) {
			await (FP as any).createDirectory('data', dir).catch(() => {})
		}
	} catch { /* non-fatal */ }

	// Create/update the hotbar macro for easy access
	await ensureChatMacro()

	// Notification
	ui.notifications.info('FoundryAI is ready! Use the hotbar macro or scene controls brain icon to chat.')
})

// ---- Service Configuration ----

function configureServiceFromSettings() {
	const providers = (getSetting('apiProviders') || []) as import('./settings').ApiProvider[]
	const find = (id: string) => providers.find(p => p.id === id)
	const toConfig = (p: import('./settings').ApiProvider | undefined) =>
		p ? { baseUrl: p.baseUrl, apiKey: p.apiKey } : { baseUrl: '', apiKey: '' }

	openRouterService.configure({
		chat: toConfig(find(getSetting('chatProvider'))),
		embedding: toConfig(find(getSetting('embeddingProvider'))),
		image: toConfig(find(getSetting('imageProvider'))),
		vision: toConfig(find(getSetting('visionProvider'))),
		tts: toConfig(find(getSetting('ttsProvider'))),
		comfyUrl: getSetting('comfyUrl'),
		comfyWorkflow: getSetting('comfyWorkflow'),
		defaultModel: getSetting('chatModel'),
		embeddingModel: getSetting('embeddingModel'),
		imageModel: getSetting('imageModel'),
		visionModel: getSetting('visionModel'),
		ttsModel: getSetting('ttsModel'),
	})
}

// ---- Macro Creation ----

/**
 * Automatically create (or update) a "FoundryAI Chat" macro in the hotbar
 * so the GM can open the chat window with one click.
 */
async function ensureChatMacro() {
	try {
		const MACRO_NAME = 'FoundryAI Chat'
		const MACRO_FLAG = 'foundry-ai-chat-macro'

		// Check if our macro already exists
		let macro = game.macros?.find((m: any) => m.getFlag(MODULE_ID, MACRO_FLAG))

		const macroCommand = 'game.foundryAI.openChat()'

		if (!macro) {
			// Create the macro
			macro = await Macro.create({
				name: MACRO_NAME,
				type: 'script',
				img: 'icons/magic/perception/eye-ringed-glow-angry-small-teal.webp',
				command: macroCommand,
				[`flags.${MODULE_ID}.${MACRO_FLAG}`]: true,
			} as any)

			console.log('FoundryAI | Created chat macro.')
		} else if (macro.command !== macroCommand) {
			// Update command if it changed between versions
			await macro.update({ command: macroCommand })
			console.log('FoundryAI | Updated chat macro command.')
		}

		// Assign to hotbar slot 10 if not already on the hotbar
		if (macro) {
			const user = game.user as any
			const hotbar: Record<string, string> = user?.hotbar || {}
			const alreadyOnBar = Object.values(hotbar).includes(macro.id)

			if (!alreadyOnBar) {
				// Find first empty slot (1-10), prefer slot 10
				let targetSlot = 10
				if (hotbar[String(targetSlot)]) {
					// Slot 10 occupied, find first empty
					for (let i = 1; i <= 10; i++) {
						if (!hotbar[String(i)]) {
							targetSlot = i
							break
						}
					}
				}

				await user?.assignHotbarMacro(macro, targetSlot)
				console.log(`FoundryAI | Assigned chat macro to hotbar slot ${targetSlot}.`)
			}
		}
	} catch (err) {
		console.error('FoundryAI | Failed to create chat macro:', err)
	}
}

// ---- Scene Controls Button ----

/**
 * Register a brain button in the scene controls (left toolbar).
 * Uses the v13 Record-based API: controls.tokens.tools[id] = SceneControlTool
 * Per the API: onChange(event, active) is the callback for tool activation.
 */
function registerSceneControlButton() {
	Hooks.on('getSceneControlButtons', (controls: any) => {
		const tokenGroup = controls.tokens ?? controls.token
		if (tokenGroup?.tools) {
			tokenGroup.tools[MODULE_ID] = {
				name: MODULE_ID,
				title: 'FoundryAI Chat',
				icon: 'fas fa-brain',
				button: true,
				order: 100,
				onChange: (_event: Event, _active: boolean) => {
					openPopoutChat(ChatWindow)
				},
			}
		}
	})
}

// ---- Public API Implementation ----

async function publicChat(message: string): Promise<string> {
	if (!openRouterService.isConfigured) throw new Error('No API provider configured.')

	const response = await openRouterService.chatCompletion({
		model: getSetting('chatModel'),
		messages: [
			{ role: 'system', content: buildSystemPrompt() },
			{ role: 'user', content: message },
		],
		temperature: getSetting('temperature'),
		max_tokens: getSetting('maxTokens'),
	})

	return response.choices?.[0]?.message?.content || ''
}

async function publicReindex(): Promise<void> {
	const journalFolders = getSetting('journalFolders') || []
	const actorFolders = getSetting('actorFolders') || []
	await embeddingService.reindexAll(journalFolders, actorFolders)
}

async function publicGenerateRecap(): Promise<void> {
	const sessions = chatSessionManager.listSessions()
	if (sessions.length === 0) {
		ui.notifications.warn('No chat sessions available for recap.')
		return
	}

	// Use today's sessions
	const today = new Date()
	today.setHours(0, 0, 0, 0)
	const todaySessions = sessions.filter((s) => s.updatedAt >= today.getTime())
	const sessionIds = todaySessions.length > 0 ? todaySessions.map((s) => s.id) : [sessions[0].id]

	const model = getSetting('chatModel')
	await sessionRecapManager.generateRecap(sessionIds, model)
	ui.notifications.info('Session recap generated!')
}
