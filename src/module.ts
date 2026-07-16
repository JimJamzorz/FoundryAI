/* ==========================================================================
   FoundryAI — Module Entry Point
   Registers hooks, settings, sidebar tab, and exposes the public API.
   ========================================================================== */

import { DEFAULT_MCP_SERVER_URL, registerSettings, getSetting, setSetting, applyUiFontSize } from './settings'
import { openRouterService } from '@core/openrouter-service'
import { embeddingService } from '@core/embedding-service'
import { chatSessionManager } from '@core/chat-session-manager'
import { sessionRecapManager } from '@core/session-recap-manager'
import { ensureFoundryAIFolders } from '@core/folder-manager'
import { registerCampaignHooks } from '@core/campaign-hooks'
import { registerSessionEventHooks } from '@core/session-event-hooks'
import { registerAIPlayerHooks, triggerDMBeat } from '@core/ai-player-runtime'
import { sessionEventBuffer } from '@core/session-event-buffer'
import { playTTS, stopTTS } from '@core/tts-service'
import { openPopoutChat, openToolRunnerDialog, openPlayerManagerDialog, createSvelteSidebarTabClass, openChatLogPopout } from '@ui/svelte-application'
import { buildSystemPrompt } from '@core/system-prompt'
import ChatWindow from '@ui/components/ChatWindow.svelte'
import ToolRunner from '@ui/components/ToolRunner.svelte'
import PlayerManager from '@ui/components/PlayerManager.svelte'

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
	registerChatLogDMBeatButton()
	registerChatMessageTTSButton()

	// Register the sidebar tab (must be before first render)
	if (getSetting('showSidebarTab')) {
		foundry.applications.sidebar.Sidebar.TABS[MODULE_ID] = {
			id: MODULE_ID,
			icon: 'fas fa-brain',
			label: 'FoundryAI',
			cls: createSvelteSidebarTabClass(ChatWindow),
			order: 100,
		}
	}
})

Hooks.once('ready', async () => {
	console.log('FoundryAI | Module ready.')

	// TTS controls are available in every user's chat log. Configure the local
	// provider before the GM-only startup work so each client can use its own
	// TTS provider settings.
	configureServiceFromSettings()

	// Only proceed for GM
	if (!game.user?.isGM) {
		console.log('FoundryAI | Non-GM user, skipping initialization.')
		return
	}

	// Load persisted session events and register table event hooks
	sessionEventBuffer.load()
	registerSessionEventHooks()

	// AI Players — wakes up configured AI-controlled characters on chat activity
	registerAIPlayerHooks()

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
		popoutChatLog: () => openChatLogPopout(),
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

	// Apply the per-user UI font-size preference
	applyUiFontSize()

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
		defaultModel: getSetting('chatModel'),
		embeddingModel: getSetting('embeddingModel'),
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

			// Pop the native Foundry chat log out into its own freely-resizable window.
			tokenGroup.tools[`${MODULE_ID}-popout-chat`] = {
				name: `${MODULE_ID}-popout-chat`,
				title: 'Pop Out Chat Log',
				icon: 'fas fa-comments',
				button: true,
				order: 103,
				onChange: (_event: Event, _active: boolean) => {
					openChatLogPopout()
				},
			}

			// GM-only debug console: run any FoundryAI tool by hand through the
			// same executeTool path the LLM uses.
			if (game.user?.isGM) {
				tokenGroup.tools[`${MODULE_ID}-tool-console`] = {
					name: `${MODULE_ID}-tool-console`,
					title: 'FoundryAI Tool Console',
					icon: 'fas fa-terminal',
					button: true,
					order: 101,
					onChange: (_event: Event, _active: boolean) => {
						openToolRunnerDialog(ToolRunner)
					},
				}

				// AI Players roster — configure per-character AI-controlled players.
				tokenGroup.tools[`${MODULE_ID}-players`] = {
					name: `${MODULE_ID}-players`,
					title: 'AI Players',
					icon: 'fas fa-users-cog',
					button: true,
					order: 102,
					onChange: (_event: Event, _active: boolean) => {
						openPlayerManagerDialog(PlayerManager)
					},
				}
			}
		}
	})
}

/**
 * Add a quill button to Foundry's chat sidebar controls: one click = one
 * autonomous-DM beat ("read the table, respond"). GM-only.
 */
function registerChatLogDMBeatButton() {
	Hooks.on('renderChatLog', (_app: any, html: any) => {
		if (!game.user?.isGM) return
		const root: HTMLElement | undefined = html instanceof HTMLElement ? html : html?.[0]
		if (!root) return
		// Chat control bar location differs across v12/v13 layouts — try known homes.
		const controls =
			root.querySelector('#chat-controls .control-buttons') ??
			root.querySelector('.chat-controls .control-buttons') ??
			root.querySelector('#chat-controls') ??
			root.querySelector('.chat-controls')
		if (!controls) {
			console.debug('FoundryAI | chat log DM-beat button: no chat controls element found to attach to.')
			return
		}

		if (!root.querySelector('.foundry-ai-dm-beat')) {
			const btn = document.createElement('a')
			btn.classList.add('foundry-ai-dm-beat')
			btn.dataset.tooltip = 'FoundryAI: read the table and post a DM beat'
			btn.setAttribute('role', 'button')
			btn.innerHTML = '<i class="fas fa-feather-pointed"></i>'
			btn.addEventListener('click', (e) => {
				e.preventDefault()
				void triggerDMBeat()
			})
			controls.appendChild(btn)
		}

		if (!root.querySelector('.foundry-ai-stop-tts')) {
			const stop = document.createElement('a')
			stop.classList.add('foundry-ai-stop-tts')
			stop.dataset.tooltip = 'FoundryAI: stop speech and clear the voice queue'
			stop.setAttribute('role', 'button')
			stop.innerHTML = '<i class="fas fa-volume-xmark"></i>'
			stop.addEventListener('click', (e) => {
				e.preventDefault()
				stopTTS()
			})
			controls.appendChild(stop)
		}

		if (!root.querySelector('.foundry-ai-orchestration-toggle')) {
			const toggle = document.createElement('a')
			toggle.classList.add('foundry-ai-orchestration-toggle')
			const refresh = () => {
				const enabled = getSetting('aiOrchestrationEnabled') === true
				toggle.classList.toggle('active', enabled)
				toggle.dataset.tooltip = enabled
					? 'FoundryAI: AI orchestration is on — click to pause'
					: 'FoundryAI: AI orchestration is paused — click to resume'
				toggle.innerHTML = `<i class="fas fa-${enabled ? 'robot' : 'pause'}"></i>`
			}
			refresh()
			toggle.addEventListener('click', async (e) => {
				e.preventDefault()
				await setSetting('aiOrchestrationEnabled', !getSetting('aiOrchestrationEnabled'))
				refresh()
			})
			controls.appendChild(toggle)
		}
	})
}

/**
 * Add a read-aloud control to every rendered message in Foundry's native chat
 * log. This covers messages posted by AI players and `post_chat_message`, not
 * just the assistant's own conversation panel.
 */
function registerChatMessageTTSButton() {
	Hooks.on('renderChatMessage', (message: ChatMessage, html: HTMLElement | { 0?: HTMLElement }) => {
		if (!getSetting('enableTTS')) return

		const root: HTMLElement | undefined = html instanceof HTMLElement ? html : html?.[0]
		if (!root || root.querySelector('.foundry-ai-tts-chat-message')) return

		const textContainer = document.createElement('div')
		textContainer.innerHTML = message.content || ''
		const text = textContainer.textContent?.replace(/\s+/g, ' ').trim() || ''
		if (!text) return
		const segments = getTTSMessageSegments(textContainer, text)

		const selector = document.createElement('select')
		selector.classList.add('foundry-ai-tts-segment')
		selector.title = 'Choose which part of this message to read aloud'
		segments.forEach((segment, index) => {
			const option = document.createElement('option')
			option.value = String(index)
			option.textContent = segment.label
			selector.appendChild(option)
		})

		const button = document.createElement('button')
		button.type = 'button'
		button.classList.add('foundry-ai-tts-chat-message')
		button.title = 'Read the selected chat text aloud'
		button.setAttribute('aria-label', 'Read the selected chat text aloud')
		button.innerHTML = '<i class="fas fa-volume-up"></i>'
		button.addEventListener('click', (event) => {
			event.preventDefault()
			event.stopPropagation()
			const segment = segments[Number(selector.value)] || segments[0]
			const configuredVoice = (message as any).getFlag?.(MODULE_ID, 'ttsVoice')
			const voice = typeof configuredVoice === 'string' ? configuredVoice : undefined
			playTTS(segment.text, button, voice).catch((err: any) => {
				console.error('FoundryAI | Chat log TTS failed:', err)
				ui.notifications.error(`TTS failed: ${err.message}`)
			})
		})

		const header = root.querySelector('.message-header')
		if (header) {
			header.appendChild(selector)
			header.appendChild(button)
		} else {
			root.appendChild(selector)
			root.appendChild(button)
		}
	})
}

function getTTSMessageSegments(content: HTMLElement, fullText: string): Array<{ label: string; text: string }> {
	const segments: Array<{ label: string; text: string }> = [{ label: 'Entire message', text: fullText }]
	const seen = new Set([fullText])
	const add = (label: string, text: string) => {
		const normalized = text.replace(/\s+/g, ' ').trim()
		if (!normalized || seen.has(normalized)) return
		seen.add(normalized)
		segments.push({ label, text: normalized })
	}

	Array.from(content.querySelectorAll('p, li, blockquote')).forEach((element, index) => {
		add(`Paragraph ${index + 1}: ${element.textContent?.trim().slice(0, 48) || ''}`, element.textContent || '')
	})

	const sentences = typeof Intl.Segmenter === 'function'
		? Array.from(new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(fullText), item => item.segment)
		: fullText.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || []
	sentences.slice(0, 20).forEach((sentence, index) => add(`Sentence ${index + 1}: ${sentence.trim().slice(0, 48)}`, sentence))

	return segments
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
