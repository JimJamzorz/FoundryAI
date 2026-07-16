/* ==========================================================================
   Settings Registration
   Registers all module settings with Foundry VTT's ClientSettings API.
   ========================================================================== */

import { SvelteApplication } from '@ui/svelte-application'
import SettingsPanel from '@ui/components/SettingsPanel.svelte'

const MODULE_ID = 'foundry-ai'
export const DEFAULT_MCP_SERVER_URL = 'ws://localhost:31415/foundry-mcp'

export interface ApiProvider {
	id: string
	name: string
	baseUrl: string
	apiKey: string
}

export interface ToolPreset {
	id: string
	name: string
	toolNames: string[]
}

/** A single AI-controlled player character configuration. */
export interface AIPlayerConfig {
	id: string
	name: string
	/** Foundry Actor ID this AI player controls. */
	actorId: string
	/** Cached display name, so the roster still reads sensibly if the actor is deleted. */
	actorName: string
	/** API provider ID (references an entry in apiProviders) — lets each player point at a different LLM. */
	providerId: string
	model: string
	/** Optional voice for this player's messages. Empty uses the global TTS voice. */
	ttsVoice?: string
	/** Speak the player's table posts automatically through the local TTS queue. */
	autoSpeak?: boolean
	/** The ONE journal this player can read and write — their entire world
	 *  knowledge beyond live chat and their character sheet. Everything else
	 *  is blocked. Empty = an auto-created private notes journal. */
	journalId: string
	/** Optional role/persona prompt. Falls back to the auto-generated actor personality prompt when blank. */
	systemPromptOverride: string
	enabled: boolean
}

export interface FoundryAISettings {
	mcpBridgeEnabled: boolean
	mcpServerUrl: string
	apiProviders: ApiProvider[]
	chatProvider: string
	embeddingProvider: string
	imageProvider: string
	visionProvider: string
	ttsProvider: string
	comfyUrl: string
	chatModel: string
	embeddingModel: string
	visionModel: string
	ttsModel: string
	ttsSpeed: number
	journalFolders: string[]
	actorFolders: string[]
	sceneFolders: string[]
	macroFolders: string[]
	chatHistoryFolder: string
	sessionRecapFolder: string
	systemPromptOverride: string
	temperature: number
	maxTokens: number
	maxToolDepth: number
	streamResponses: boolean
	autoIndex: boolean
	enableTools: boolean
	showSidebarTab: boolean
	enableRAG: boolean
	playerFolder: string
	enableSceneTools: boolean
	enableDiceTools: boolean
	enableTokenTools: boolean
	enableCombatTools: boolean
	enableAudioTools: boolean
	enableChatTools: boolean
	enableCompendiumTools: boolean
	enableSpatialTools: boolean
	enableActorTools: boolean
	enableItemTools: boolean
	enableMacroTools: boolean
	enableImageTools: boolean
	enableTTS: boolean
	ttsVoice: string
	contextSummarizeThreshold: number
	summarizeKeepMessages: number
	captureSessionEvents: boolean
	sessionEvents: string
	toolPresets: ToolPreset[]
	aiPlayers: AIPlayerConfig[]
	aiPlayerHumanCap: number
	aiOrchestrationEnabled: boolean
	aiKeepSceneMoving: boolean
	uiFontSize: number
	aiIncludeDMModel: boolean
	orchestratorProviderId: string
	orchestratorModel: string
}

export function registerSettings(): void {
	// ---- MCP Bridge ----

	game.settings.register(MODULE_ID, 'mcpBridgeEnabled', {
		name: 'Enable MCP Bridge',
		hint: 'Connect to an external MCP server so Claude Code / Claude Desktop can call FoundryAI tools.',
		scope: 'world',
		config: true,
		type: Boolean,
		default: false,
		onChange: () => { Hooks.callAll(`${MODULE_ID}.settingsChanged`, 'mcpBridgeEnabled') },
	})

	game.settings.register(MODULE_ID, 'mcpServerUrl', {
		name: 'MCP Server URL',
		hint: `WebSocket URL of the MCP server (e.g. ${DEFAULT_MCP_SERVER_URL})`,
		scope: 'world',
		config: true,
		type: String,
		default: DEFAULT_MCP_SERVER_URL,
		onChange: () => { Hooks.callAll(`${MODULE_ID}.settingsChanged`, 'mcpServerUrl') },
	})

	// ---- API Providers ----

	game.settings.register(MODULE_ID, 'apiProviders', {
		name: 'API Providers',
		hint: 'List of API providers (name, base URL, API key)',
		scope: 'client',
		config: false,
		type: Array,
		default: [],
		onChange: () => { Hooks.callAll(`${MODULE_ID}.settingsChanged`, 'apiProviders') },
	})

	game.settings.register(MODULE_ID, 'chatProvider', {
		name: 'Chat Provider',
		scope: 'client', config: false, type: String, default: '',
		onChange: () => { Hooks.callAll(`${MODULE_ID}.settingsChanged`, 'chatProvider') },
	})

	game.settings.register(MODULE_ID, 'embeddingProvider', {
		name: 'Embedding Provider',
		scope: 'client', config: false, type: String, default: '',
	})

	game.settings.register(MODULE_ID, 'imageProvider', {
		name: 'Image Provider',
		scope: 'client', config: false, type: String, default: '',
	})

	game.settings.register(MODULE_ID, 'visionProvider', {
		name: 'Vision Provider',
		scope: 'client', config: false, type: String, default: '',
	})

	game.settings.register(MODULE_ID, 'ttsProvider', {
		name: 'TTS Provider',
		scope: 'client', config: false, type: String, default: '',
	})

	game.settings.register(MODULE_ID, 'comfyUrl', {
		name: 'ComfyUI URL',
		hint: 'Base URL of your ComfyUI instance (e.g. http://localhost:8188). When set, image generation runs on ComfyUI using the bundled workflow templates; the generate_image tool picks the workflow per call.',
		scope: 'client', config: false, type: String, default: '',
	})

	game.settings.register(MODULE_ID, 'chatModel', {
		name: 'FOUNDRYAI.Settings.ChatModel',
		hint: 'FOUNDRYAI.Settings.ChatModelHint',
		scope: 'world',
		config: false,
		type: String,
		default: 'anthropic/claude-sonnet-4',
		onChange: () => {
			Hooks.callAll(`${MODULE_ID}.settingsChanged`, 'chatModel')
		},
	})

	game.settings.register(MODULE_ID, 'embeddingModel', {
		name: 'FOUNDRYAI.Settings.EmbeddingModel',
		hint: 'FOUNDRYAI.Settings.EmbeddingModelHint',
		scope: 'world',
		config: false,
		type: String,
		default: 'openai/text-embedding-3-small',
		onChange: () => {
			Hooks.callAll(`${MODULE_ID}.settingsChanged`, 'embeddingModel')
		},
	})

	game.settings.register(MODULE_ID, 'visionModel', {
		name: 'Vision Model',
		hint: 'Model used for image analysis (describe_image). Falls back to the chat model if left empty.',
		scope: 'world',
		config: false,
		type: String,
		default: '',
	})

	game.settings.register(MODULE_ID, 'ttsModel', {
		name: 'FOUNDRYAI.Settings.TTSModel',
		hint: 'FOUNDRYAI.Settings.TTSModelHint',
		scope: 'world',
		config: false,
		type: String,
		default: 'openai/gpt-4o-mini-tts',
		onChange: () => {
			Hooks.callAll(`${MODULE_ID}.settingsChanged`, 'ttsModel')
		},
	})

	// ---- RAG Configuration ----

	game.settings.register(MODULE_ID, 'journalFolders', {
		name: 'FOUNDRYAI.Settings.JournalFolders',
		hint: 'FOUNDRYAI.Settings.JournalFoldersHint',
		scope: 'world',
		config: false,
		type: Array,
		default: [],
	})

	game.settings.register(MODULE_ID, 'actorFolders', {
		name: 'FOUNDRYAI.Settings.ActorFolders',
		hint: 'FOUNDRYAI.Settings.ActorFoldersHint',
		scope: 'world',
		config: false,
		type: Array,
		default: [],
	})

	game.settings.register(MODULE_ID, 'sceneFolders', {
		name: 'FOUNDRYAI.Settings.SceneFolders',
		hint: 'FOUNDRYAI.Settings.SceneFoldersHint',
		scope: 'world',
		config: false,
		type: Array,
		default: [],
	})

	game.settings.register(MODULE_ID, 'macroFolders', {
		name: 'FOUNDRYAI.Settings.MacroFolders',
		hint: 'FOUNDRYAI.Settings.MacroFoldersHint',
		scope: 'world',
		config: false,
		type: Array,
		default: [],
	})

	// ---- Journal Folder Configuration ----

	game.settings.register(MODULE_ID, 'chatHistoryFolder', {
		name: 'FOUNDRYAI.Settings.ChatHistoryFolder',
		hint: 'FOUNDRYAI.Settings.ChatHistoryFolderHint',
		scope: 'world',
		config: false,
		type: String,
		default: '',
	})

	game.settings.register(MODULE_ID, 'sessionRecapFolder', {
		name: 'FOUNDRYAI.Settings.SessionRecapFolder',
		hint: 'FOUNDRYAI.Settings.SessionRecapFolderHint',
		scope: 'world',
		config: false,
		type: String,
		default: '',
	})

	// ---- LLM Parameters ----

	game.settings.register(MODULE_ID, 'temperature', {
		name: 'FOUNDRYAI.Settings.Temperature',
		hint: 'FOUNDRYAI.Settings.TemperatureHint',
		scope: 'world',
		config: false,
		type: Number,
		default: 0.8,
		range: { min: 0, max: 2, step: 0.1 },
	})

	game.settings.register(MODULE_ID, 'maxTokens', {
		name: 'FOUNDRYAI.Settings.MaxTokens',
		hint: 'FOUNDRYAI.Settings.MaxTokensHint',
		scope: 'world',
		config: false,
		type: Number,
		default: 4096,
	})

	game.settings.register(MODULE_ID, 'maxToolDepth', {
		name: 'FOUNDRYAI.Settings.MaxToolDepth',
		hint: 'FOUNDRYAI.Settings.MaxToolDepthHint',
		scope: 'world',
		config: false,
		type: Number,
		default: 0,
	})

	game.settings.register(MODULE_ID, 'systemPromptOverride', {
		name: 'FOUNDRYAI.Settings.SystemPrompt',
		hint: 'FOUNDRYAI.Settings.SystemPromptHint',
		scope: 'world',
		config: false,
		type: String,
		default: '',
	})

	// ---- Feature Toggles ----

	game.settings.register(MODULE_ID, 'streamResponses', {
		name: 'FOUNDRYAI.Settings.StreamResponses',
		hint: 'FOUNDRYAI.Settings.StreamResponsesHint',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'autoIndex', {
		name: 'FOUNDRYAI.Settings.AutoIndex',
		hint: 'FOUNDRYAI.Settings.AutoIndexHint',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'enableTools', {
		name: 'FOUNDRYAI.Settings.EnableTools',
		hint: 'FOUNDRYAI.Settings.EnableToolsHint',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'enableRAG', {
		name: 'Enable RAG Context',
		hint: 'Inject relevant document excerpts into each prompt via embedding search. Increases token usage but gives the AI pre-loaded context.',
		scope: 'world',
		config: false,
		type: Boolean,
		default: false,
	})

	game.settings.register(MODULE_ID, 'playerFolder', {
		name: 'Player Character Folder',
		hint: 'The actor folder containing player characters. These will be included in every prompt so the AI knows the party.',
		scope: 'world',
		config: false,
		type: String,
		default: '',
	})

	game.settings.register(MODULE_ID, 'showSidebarTab', {
		name: 'FOUNDRYAI.Settings.ShowSidebarTab',
		hint: 'FOUNDRYAI.Settings.ShowSidebarTabHint',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	// ---- Tool Category Toggles ----

	game.settings.register(MODULE_ID, 'enableSceneTools', {
		name: 'Scene Tools',
		hint: 'Allow the AI to list, view, and activate scenes',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'enableDiceTools', {
		name: 'Dice Tools',
		hint: 'Allow the AI to roll dice and ability checks',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'enableTokenTools', {
		name: 'Token Tools',
		hint: 'Allow the AI to place, move, and manage tokens on the scene',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'enableCombatTools', {
		name: 'Combat Tools',
		hint: 'Allow the AI to manage combat encounters, initiative, damage, and conditions',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'enableAudioTools', {
		name: 'Audio Tools',
		hint: 'Allow the AI to control playlists and tracks',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'enableChatTools', {
		name: 'Chat Tools',
		hint: 'Allow the AI to post messages to chat as NPCs or narration',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'enableCompendiumTools', {
		name: 'Compendium Tools',
		hint: 'Allow the AI to search, read, and import from compendium packs',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'enableSpatialTools', {
		name: 'Spatial Tools',
		hint: 'Allow the AI to measure distances, find tokens in range, and place templates',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'enableActorTools', {
		name: 'Actor Tools',
		hint: 'Allow the AI to create, update, and delete actors and manage their items',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'enableItemTools', {
		name: 'Item Tools',
		hint: 'Allow the AI to create, update, and delete world items',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'enableMacroTools', {
		name: 'Macro Tools',
		hint: 'Allow the AI to create, update, list, and execute macros in allowed folders',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'enableImageTools', {
		name: 'Image & Scene Gen Tools',
		hint: 'Allow the AI to generate images and create scenes with AI-generated maps',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'toolPresets', {
		name: 'Tool Presets',
		hint: 'Saved custom tool selections for the in-chat "Customize Tools" picker',
		scope: 'client',
		config: false,
		type: Array,
		default: [],
	})

	// ---- TTS Settings ----

	game.settings.register(MODULE_ID, 'enableTTS', {
		name: 'Enable Text-to-Speech',
		hint: 'Show read-aloud buttons on NPC dialogue and blockquotes',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'ttsVoice', {
		name: 'TTS Voice',
		hint: 'The voice to use for text-to-speech',
		scope: 'world',
		config: false,
		type: String,
		default: 'nova',
	})

	game.settings.register(MODULE_ID, 'ttsSpeed', {
		name: 'TTS Speed',
		hint: 'Speech rate for OpenAI-compatible local TTS providers such as Kokoro. 1.0 is natural pace.',
		scope: 'world',
		config: false,
		type: Number,
		default: 1,
	})

	// ---- Context Management ----

	game.settings.register(MODULE_ID, 'contextSummarizeThreshold', {
		name: 'Context Summarize Threshold',
		hint: 'When context usage exceeds this percentage, prompt to summarize older messages (0 = never auto-prompt)',
		scope: 'world',
		config: false,
		type: Number,
		default: 75,
		range: { min: 0, max: 95, step: 5 },
	})

	game.settings.register(MODULE_ID, 'summarizeKeepMessages', {
		name: 'Messages to Keep When Summarizing',
		hint: 'Number of recent messages to preserve when summarizing older context',
		scope: 'world',
		config: false,
		type: Number,
		default: 10,
		range: { min: 4, max: 30, step: 1 },
	})

	// ---- Session Event Capture ----

	game.settings.register(MODULE_ID, 'captureSessionEvents', {
		name: 'Capture Session Events',
		hint: 'Automatically record combat, damage, conditions, and scene changes during play. These events are included in AI-generated session recaps.',
		scope: 'world',
		config: true,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'sessionEvents', {
		scope: 'world',
		config: false,
		type: String,
		default: '[]',
	})

	// ---- AI Players ----

	game.settings.register(MODULE_ID, 'aiPlayers', {
		name: 'AI Players',
		hint: 'Configured AI-controlled player characters — linked actor, LLM, and role prompt per character.',
		scope: 'world',
		config: false,
		type: Array,
		default: [],
		onChange: () => { Hooks.callAll(`${MODULE_ID}.settingsChanged`, 'aiPlayers') },
	})

	game.settings.register(MODULE_ID, 'aiPlayerHumanCap', {
		name: 'AI Player Human-Interaction Cap',
		hint: 'Max consecutive automated chat messages (AI players + autonomous DM narration, combined) before things go quiet and wait for a human message to break the streak. Prevents spiraling into talking only to itself.',
		scope: 'world',
		config: false,
		type: Number,
		default: 5,
	})

	game.settings.register(MODULE_ID, 'aiOrchestrationEnabled', {
		name: 'Enable AI Orchestration',
		hint: 'Opt in to the AI Players trigger loop — a central orchestrator (using your DM Chat Model, or the separate Orchestrator Model below if set) watches table chat and decides whether an AI player should react, the DM should narrate a beat, or nothing should happen. Off by default so it never surprises you with unattended chat messages until you turn it on.',
		scope: 'world',
		config: false,
		type: Boolean,
		default: false,
	})

	game.settings.register(MODULE_ID, 'uiFontSize', {
		name: 'UI Font Size',
		hint: "Base font size in pixels for the whole Foundry interface (Foundry's UI is rem-based, so this scales nearly all text without zooming the canvas). 0 = Foundry default (16px). Per-user setting.",
		scope: 'client',
		config: false,
		type: Number,
		default: 0,
		onChange: (value: number) => applyUiFontSize(value),
	})

	game.settings.register(MODULE_ID, 'aiKeepSceneMoving', {
		name: 'Keep the Scene Moving',
		hint: 'When on, an orchestrator WAIT becomes a DM narration beat instead of silence, and if the DM then declines to narrate, the orchestrator is asked once more to pick a player. The table keeps itself moving until the Human-Interaction Cap is reached or a human speaks. Chattier by design — the cap is the brake.',
		scope: 'world',
		config: false,
		type: Boolean,
		default: false,
	})

	game.settings.register(MODULE_ID, 'aiIncludeDMModel', {
		name: 'Include DM Model In AI Orchestration',
		hint: 'When on, the orchestrator may choose the DM for an autonomous narration beat. Turn it off to keep the trigger loop limited to AI players only, even when Keep the Scene Moving is enabled.',
		scope: 'world',
		config: false,
		type: Boolean,
		default: true,
	})

	game.settings.register(MODULE_ID, 'orchestratorProviderId', {
		name: 'Orchestrator Provider',
		hint: 'Optional — API provider for the orchestrator\'s ACTOR/DM/WAIT triage decision, which runs on every chat message. Leave blank to use your DM Chat Model/provider.',
		scope: 'world',
		config: false,
		type: String,
		default: '',
	})

	game.settings.register(MODULE_ID, 'orchestratorModel', {
		name: 'Orchestrator Model',
		hint: 'Optional — a fast/lightweight model for the orchestrator\'s triage decision, separate from your DM Chat Model. Worth setting if your DM model is a heavy "thinking" model — it can spend more tokens reasoning through this simple decision than a full DM turn needs, adding latency to every chat message. Leave blank to just use your DM Chat Model.',
		scope: 'world',
		config: false,
		type: String,
		default: '',
	})

	// ---- Settings Menu ----

	game.settings.registerMenu(MODULE_ID, 'settingsMenu', {
		name: 'FOUNDRYAI.Settings.MenuName',
		label: 'FOUNDRYAI.Settings.MenuLabel',
		hint: 'FOUNDRYAI.Settings.MenuHint',
		icon: 'fas fa-brain',
		type: FoundryAISettingsApp as any,
		restricted: true,
	})
}

// ---- Settings Accessor ----

/**
 * Apply the UI font-size preference to the document root. Foundry's interface
 * sizes in rem, so setting the root font-size scales nearly all text (chat,
 * sidebars, windows, this module's UI) while leaving the canvas alone.
 * Clamped to a sane range; 0/empty restores Foundry's default (16px).
 */
export function applyUiFontSize(px?: number): void {
	const value = px ?? (getSetting('uiFontSize') || 0)
	const valid = typeof value === 'number' && value >= 10 && value <= 32
	document.documentElement.style.fontSize = valid && value !== 0 ? `${value}px` : ''
}

export function getSetting<K extends keyof FoundryAISettings>(key: K): FoundryAISettings[K] {
	return game.settings.get(MODULE_ID, key) as FoundryAISettings[K]
}

export async function setSetting<K extends keyof FoundryAISettings>(
	key: K,
	value: FoundryAISettings[K],
): Promise<void> {
	await game.settings.set(MODULE_ID, key, value)
}

// ---- Settings Application (Svelte-powered) ----

class FoundryAISettingsApp extends SvelteApplication {
	constructor(options: Partial<ApplicationConfiguration> = {}) {
		super(SettingsPanel, {}, options)
	}

	static override DEFAULT_OPTIONS: ApplicationConfiguration = {
		...SvelteApplication.DEFAULT_OPTIONS,
		id: 'foundry-ai-settings',
		classes: ['foundry-ai'],
		window: {
			frame: true,
			positioned: true,
			title: 'FoundryAI Settings',
			icon: 'fas fa-brain',
			minimizable: false,
			resizable: true,
			contentTag: 'section',
			contentClasses: ['foundry-ai-content'],
		},
		position: {
			width: 600,
			height: 700,
		},
	}

	override get title(): string {
		return 'FoundryAI Settings'
	}
}

export { FoundryAISettingsApp }
