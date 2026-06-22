/* ==========================================================================
   System Prompt Builder
   Constructs the system prompt with campaign context, tool instructions,
   and DM-assistant personality.
   ========================================================================== */

import { getSetting } from '../settings'
import { collectionReader } from './collection-reader'
import { getSubfolderId, getRootFolderId } from './folder-manager'

const MODULE_ID = 'foundry-ai'

/** Actor data used for roleplay sessions */
export interface ActorRoleplayContext {
	actorId: string
	actorName: string
}

/**
 * Build the full system prompt, injecting campaign context from the current
 * Foundry world state.
 */
export function buildSystemPrompt(): string {
	// Check for user override
	const override = getSetting('systemPromptOverride')
	if (override && override.trim().length > 0) {
		console.log('FoundryAI | Using custom system prompt override')
		return override
	}

	const sections: string[] = [BASE_PROMPT]

	// Inject world context
	const worldContext = getWorldContext()
	if (worldContext) {
		sections.push(worldContext)
	}

	// Add tool usage instructions if tools are enabled
	if (getSetting('enableTools')) {
		sections.push(TOOL_INSTRUCTIONS)
	}

	// Add formatting instructions
	sections.push(FORMATTING_INSTRUCTIONS)

	const prompt = sections.join('\n\n')
	console.log(
		`FoundryAI | Built system prompt — ${prompt.length} chars, ${sections.length} sections, tools: ${getSetting('enableTools')}`,
	)
	return prompt
}

/**
 * Build a system prompt for an actor roleplay session.
 * The AI will stay in character as the specified actor.
 */
export function buildActorRoleplayPrompt(actor: ActorRoleplayContext): string {
	console.log(`FoundryAI | Building actor roleplay prompt for: ${actor.actorName} (${actor.actorId})`)
	const sections: string[] = []

	// Build actor-specific personality prompt
	const actorPrompt = buildActorPersonality(actor)
	sections.push(actorPrompt)

	// Inject world context so the actor knows the campaign
	const worldContext = getWorldContext()
	if (worldContext) {
		sections.push(worldContext)
	}

	// Add tool usage instructions if tools are enabled
	if (getSetting('enableTools')) {
		sections.push(TOOL_INSTRUCTIONS)
	}

	// Add formatting instructions
	sections.push(FORMATTING_INSTRUCTIONS)

	const prompt = sections.join('\n\n')
	console.log(`FoundryAI | Built actor RP prompt — ${prompt.length} chars, actor: ${actor.actorName}`)
	return prompt
}

/**
 * Build the actor personality block from their Foundry actor data.
 */
function buildActorPersonality(ctx: ActorRoleplayContext): string {
	const actor = game.actors?.get(ctx.actorId) as any
	if (!actor) {
		return `You are roleplaying as **${ctx.actorName}**. Stay in character at all times. Respond as this character would — use their voice, mannerisms, and perspective. If the DM asks out-of-character questions, you may answer briefly but always return to character.`
	}

	const system = actor.system as Record<string, any>
	const parts: string[] = []

	// Core identity
	parts.push(`You are roleplaying as **${actor.name}**, a character in this campaign.`)
	parts.push(
		`Stay in character at all times. Respond as ${actor.name} would — use their voice, mannerisms, knowledge, and perspective.`,
	)
	parts.push(
		`You do NOT know things ${actor.name} wouldn't know. You have ${actor.name}'s memories, personality, and worldview.`,
	)

	// Type and basic stats
	if (actor.type) parts.push(`\n**Type:** ${actor.type}`)

	// Race, class, level (D&D 5e)
	const details: string[] = []
	if (system?.details?.race?.name || system?.details?.race) {
		const raceName =
			typeof system.details.race === 'string' ? system.details.race : system.details.race?.name || 'Unknown'
		details.push(`**Race:** ${raceName}`)
	}
	if (system?.details?.background?.name || system?.details?.background) {
		const bg =
			typeof system.details.background === 'string' ? system.details.background : system.details.background?.name || ''
		if (bg) details.push(`**Background:** ${bg}`)
	}
	if (system?.attributes?.hp) {
		details.push(`**HP:** ${system.attributes.hp.value}/${system.attributes.hp.max}`)
	}

	// Classes (5e)
	try {
		if (actor.classes && typeof actor.classes === 'object') {
			const classEntries = Object.values(actor.classes) as any[]
			if (classEntries.length > 0) {
				const classStr = classEntries.map((c: any) => `${c.name || c.identifier} ${c.system?.levels || ''}`).join(' / ')
				details.push(`**Class:** ${classStr}`)
			}
		}
	} catch {
		/* ignore */
	}

	if (details.length > 0) parts.push(details.join(' | '))

	// Ability scores
	try {
		if (system?.abilities) {
			const abs = Object.entries(system.abilities)
				.map(([key, val]: [string, any]) => `${key.toUpperCase()}: ${val.value}`)
				.join(', ')
			if (abs) parts.push(`**Abilities:** ${abs}`)
		}
	} catch {
		/* ignore */
	}

	// Biography / description
	try {
		const bio = system?.details?.biography?.value
		if (bio && typeof bio === 'string' && bio.trim().length > 0) {
			// Strip HTML tags for a cleaner prompt
			const cleanBio = bio.replace(/<[^>]+>/g, '').trim()
			if (cleanBio.length > 0) {
				parts.push(`\n## Biography & Personality\n${cleanBio.slice(0, 3000)}`)
			}
		}
	} catch {
		/* ignore */
	}

	// Traits (D&D 5e)
	try {
		const traits = system?.details?.trait?.value
		const ideals = system?.details?.ideal?.value
		const bonds = system?.details?.bond?.value
		const flaws = system?.details?.flaw?.value

		const traitParts: string[] = []
		if (traits) traitParts.push(`**Personality Traits:** ${traits}`)
		if (ideals) traitParts.push(`**Ideals:** ${ideals}`)
		if (bonds) traitParts.push(`**Bonds:** ${bonds}`)
		if (flaws) traitParts.push(`**Flaws:** ${flaws}`)

		if (traitParts.length > 0) {
			parts.push(`\n## Character Traits\n${traitParts.join('\n')}`)
		}
	} catch {
		/* ignore */
	}

	// Items/equipment summary
	try {
		if (actor.items && actor.items.size > 0) {
			const equipped = (Array.from(actor.items.values()) as any[])
				.filter((i: any) => i.system?.equipped || i.type === 'spell')
				.slice(0, 20)
				.map((i: any) => `${i.name} (${i.type})`)
			if (equipped.length > 0) {
				parts.push(`\n## Notable Equipment & Abilities\n${equipped.join(', ')}`)
			}
		}
	} catch {
		/* ignore */
	}

	// Roleplay instructions
	parts.push(`\n## Roleplay Guidelines`)
	parts.push(`- Speak in first person as ${actor.name}`)
	parts.push(`- Use dialogue in quotation marks: "Like this"`)
	parts.push(`- Express emotions, reactions, and body language in *italics*`)
	parts.push(`- Reference your abilities, equipment, and backstory naturally`)
	parts.push(`- If asked about things your character wouldn't know, respond in character (confused, curious, etc.)`)
	parts.push(`- The DM (the user) may set scenes or describe situations — react in character`)
	parts.push(`- You may use tools to look up your own stats, spells, or items when relevant`)

	return parts.join('\n')
}

/**
 * Get a simplified system prompt (no game context, for recap generation etc.)
 */
export function buildLightSystemPrompt(): string {
	return BASE_PROMPT
}

// ---- Context Gathering ----

function getWorldContext(): string | null {
	const parts: string[] = []

	// World info
	if (game.world) {
		parts.push(
			`## Current World\n- **Name:** ${game.world.title || game.world.id}\n- **System:** ${game.system?.title || game.system?.id || 'Unknown'}`,
		)
	}

	// Active scene
	try {
		const sceneInfo = collectionReader.getCurrentSceneInfo()
		if (sceneInfo && sceneInfo !== '{}') {
			parts.push(`## Active Scene\n${sceneInfo}`)
		}
	} catch {
		/* no scene */
	}

	// Combat state
	try {
		const combatInfo = collectionReader.getCombatContext()
		if (combatInfo) {
			parts.push(`## Combat State\n${combatInfo}`)
		}
	} catch {
		/* no combat */
	}

	// Now playing
	try {
		const playlistInfo = collectionReader.getPlaylistContext()
		if (playlistInfo) {
			parts.push(`## Now Playing\n${playlistInfo}`)
		}
	} catch {
		/* ignore */
	}

	// Player characters
	try {
		const pcs = getPlayerCharacters()
		if (pcs.length > 0) {
			parts.push(`## Player Characters\n${pcs.join('\n')}`)
		}
	} catch {
		/* ignore */
	}

	// Available journals inventory
	try {
		const journalIndex = getJournalInventory()
		if (journalIndex) {
			parts.push(journalIndex)
		}
	} catch {
		/* ignore */
	}

	// AI-created notes (full content from FoundryAI/Notes folder)
	try {
		const notesContent = getNotesContent()
		if (notesContent) {
			parts.push(notesContent)
		}
	} catch {
		/* ignore */
	}

	if (parts.length === 0) return null

	return `# Campaign Context\n\n${parts.join('\n\n')}`
}

function getPlayerCharacters(): string[] {
	if (!game.actors) return []

	const playerFolderId = getSetting('playerFolder')
	const pcs: string[] = []

	for (const actor of game.actors.values()) {
		if (actor.type !== 'character') continue

		// If playerFolder is set, only include actors from that folder
		if (playerFolderId) {
			const allFolderIds = collectionReader.resolveWithChildren([playerFolderId])
			if (!actor.folder || !allFolderIds.includes(actor.folder.id)) continue
		} else {
			// Fallback: only include player-owned characters
			if (!actor.hasPlayerOwner) continue
		}

		const system = actor.system as Record<string, any>
		const details: string[] = [`- **${actor.name}** (id: ${actor.id})`]

		// Try to get class/race/level info (system-agnostic)
		if (system?.details?.race) {
			const raceName = typeof system.details.race === 'string' ? system.details.race : system.details.race?.name || ''
			if (raceName) details.push(`Race: ${raceName}`)
		}

		// Classes (5e)
		try {
			if ((actor as any).classes && typeof (actor as any).classes === 'object') {
				const classEntries = Object.values((actor as any).classes) as any[]
				if (classEntries.length > 0) {
					const classStr = classEntries
						.map((c: any) => `${c.name || c.identifier} ${c.system?.levels || ''}`)
						.join(' / ')
					details.push(`Class: ${classStr}`)
				}
			}
		} catch {
			/* ignore */
		}

		if (system?.attributes?.hp) {
			details.push(`HP: ${system.attributes.hp.value}/${system.attributes.hp.max}`)
		}
		if (system?.attributes?.ac) {
			details.push(`AC: ${system.attributes.ac.value ?? system.attributes.ac.flat ?? '?'}`)
		}

		pcs.push(details.join(' | '))
	}

	return pcs
}

/**
 * Build a compact inventory of all journal entries — just IDs and names.
 * Only includes journals from folders the user has granted access to,
 * plus journals in FoundryAI-managed folders (Notes, Sessions, Chat History, Actors).
 */
function getJournalInventory(): string | null {
	if (!game.journal || game.journal.size === 0) return null

	const allowedFolders = getSetting('journalFolders') || []
	const allAllowedFolderIds = allowedFolders.length > 0 ? collectionReader.resolveWithChildren(allowedFolders) : null // null = no restriction

	// Always include FoundryAI-managed folders
	const foundryAIFolderIds: string[] = []
	const rootId = getRootFolderId()
	if (rootId) foundryAIFolderIds.push(rootId)
	for (const key of ['notes', 'chatHistory', 'sessions', 'actors'] as const) {
		const id = getSubfolderId(key)
		if (id) foundryAIFolderIds.push(id)
	}

	const lines: string[] = ['## Available Journals']
	lines.push(
		'Call get_journal with the ID to read any of these. ALWAYS read the relevant journal before answering campaign questions.\n',
	)

	let count = 0
	for (const entry of game.journal.values()) {
		// Filter to allowed folders if restrictions are set
		if (allAllowedFolderIds !== null) {
			const folderId = entry.folder?.id
			const isAllowed = folderId && allAllowedFolderIds.includes(folderId)
			const isFoundryAI = folderId && foundryAIFolderIds.includes(folderId)
			if (!isAllowed && !isFoundryAI) continue
		}
		lines.push(`- ${entry.name} (id: ${entry.id})`)
		count++
	}

	if (count === 0) return null
	return lines.join('\n')
}

/**
 * Get full content of all journals in the FoundryAI/Notes folder.
 * These are notes the AI itself created — it should always have this context.
 */
function getNotesContent(): string | null {
	const notesFolderId = getSubfolderId('notes')
	if (!notesFolderId) return null
	if (!game.journal || game.journal.size === 0) return null

	const parts: string[] = ['## Your Notes (FoundryAI/Notes)']
	parts.push('These are notes you previously created. Reference them when relevant.\n')

	let count = 0
	for (const entry of game.journal.values()) {
		if (!entry.folder || entry.folder.id !== notesFolderId) continue

		const content = collectionReader.getJournalContent(entry.id)
		if (!content) continue

		parts.push(`### ${entry.name} (id: ${entry.id})`)
		parts.push(content)
		parts.push('')
		count++
	}

	if (count === 0) return null
	return parts.join('\n')
}

/**
 * Build a compact inventory of all actors grouped by folder.
 */
function getActorInventory(): string | null {
	if (!game.actors || game.actors.size === 0) return null

	const byFolder = new Map<string, Array<{ id: string; name: string; type: string }>>()

	for (const actor of game.actors.values()) {
		const folderName = actor.folder?.name || 'Uncategorized'
		if (!byFolder.has(folderName)) byFolder.set(folderName, [])
		byFolder.get(folderName)!.push({
			id: actor.id,
			name: actor.name,
			type: actor.type,
		})
	}

	const lines: string[] = ['## Available Actors']
	lines.push('Use search_actors or get_actor (with the ID) to look up any of these:\n')

	for (const [folder, actors] of byFolder) {
		lines.push(`### 📁 ${folder}`)
		for (const a of actors) {
			lines.push(`- ${a.name} (id: ${a.id}, type: ${a.type})`)
		}
		lines.push('')
	}

	return lines.join('\n')
}

// ---- Prompt Templates ----

const BASE_PROMPT = `You are **FoundryAI**, an expert AI Dungeon Master assistant integrated directly into Foundry Virtual Tabletop. You help the DM run their game by providing guidance, generating content, and managing game information.

## Your Capabilities
- **Lore & Reference:** Search through indexed sourcebooks, journals, and actor sheets to find relevant information
- **DM Guidance:** Suggest skill check DCs, provide NPC dialogue, describe environments, and help adjudicate rules
- **Content Creation:** Write and update journal entries for quests, notes, session recaps, and lore
- **NPC Roleplay:** Voice NPCs with distinct personalities based on their character sheets and backgrounds
- **Encounter Design:** Help balance encounters, suggest tactics, and create dramatic moments
- **World Knowledge:** Access the current scene, active characters, and campaign notes

## Your Personality
- You're a collaborative partner, not a replacement — the DM always has final say
- You're enthusiastic about storytelling and RPGs
- You give concise, actionable responses unless asked for more detail
- You use the game's own lore and established facts before inventing new content
- When you don't know something from the campaign, you say so and offer suggestions
- You match the tone of the campaign — dark and gritty, lighthearted, epic, etc.

## Important Rules
- NEVER control player characters or make decisions for them
- NEVER reveal hidden information to players (assume the DM is your audience)
- When generating DCs, use standard 5e guidelines unless the system differs
- When voicing NPCs, use quotation marks and note the NPC's name
- Reference specific source material when available (journal names, page numbers)
- If asked about rules, cite the relevant rule and provide your interpretation
- **Spoiler content:** Any NPC, creature, location, or scene the players have not yet encountered is spoiler content. Always place spoiler actors in a folder named "Spoilers" and spoiler scenes in a folder named "Spoilers". The DM moves content out of Spoilers when it is ready to be revealed. Do NOT add spoiler actors to the scene or reveal spoiler scenes until the DM explicitly asks.`

const TOOL_INSTRUCTIONS = `## Using Tools — MANDATORY
You have access to tools that let you interact with the Foundry VTT world. **You MUST use these tools before generating any response about campaign-specific content.** Do NOT rely on your training data or the "Relevant Context" section alone — always verify and enrich your answer by calling the appropriate tools first.

### Core Tools (Knowledge & Content)
- **get_journal**: Retrieve the FULL content of a journal entry by ID. **This is your primary tool.** The system prompt lists all available journals with their IDs — use this to read the relevant journal(s) before answering any campaign question. You can call it multiple times to read several journals.
- **search_journals**: Semantically search indexed journal entries when you're not sure which journal contains the information. Returns full content of matching journals with uuidRef citations. Use this when the journal name doesn't obviously match or when you need to discover which journals cover a topic.
- **search_actors**: Semantically search indexed actors (NPCs, monsters, characters). Call this for ANY question about a character, creature, or NPC. Use this to find relevant actors by name or description.
- **get_actor**: Retrieve full actor details by ID. Use when you already know the actor's ID (e.g. from the Player Characters list or a previous search).
- **create_journal / update_journal**: Create or modify journal entries (quests, notes, recaps, summaries).
- **list_journals_in_folder / list_folders**: Browse the world's organizational structure.
- **get_scene_info**: Check what's happening in the current scene (tokens, notes, lights, etc.).
- **roll_table**: Roll on tables for random content generation.

### Scene Tools
- **list_scenes**: List all scenes (optionally only navigation bar scenes).
- **view_scene**: View full details of any scene by ID.
- **activate_scene**: Switch all players to a different scene. Use when the party moves to a new location.

### Dice Tools
- **roll_dice**: Roll any dice expression (e.g. "2d6+3", "1d20", "4d6kh3"). Use for quick rolls, damage, custom checks.
- **roll_check**: Roll an ability check or save for a specific actor. The DM sees the result privately.

### Token Tools
- **place_token**: Place an actor's token on the current scene. Tokens are placed HIDDEN by default — use reveal_token when ready.
- **move_token**: Move a token to new coordinates.
- **hide_token / reveal_token**: Toggle token visibility for players.
- **remove_token**: Remove a token from the scene.
- **update_token**: Modify token properties (name, size, elevation, light emission).

### Combat Tools
- **start_combat**: Create a new combat encounter, optionally adding tokens.
- **end_combat**: End the current combat.
- **add_to_combat / remove_from_combat**: Manage combatants.
- **next_turn**: Advance to the next turn (or start combat if not started).
- **roll_initiative**: Roll initiative for combatants (defaults to all unrolled).
- **apply_damage**: Deal damage or heal a token's actor.
- **apply_condition / remove_condition**: Manage status effects (e.g. "poisoned", "prone", "stunned").

### Audio Tools
- **list_playlists**: See all playlists and their tracks.
- **play_playlist / stop_playlist**: Control playlist playback.
- **play_track**: Play a specific track from a playlist.

### Chat Tools
- **post_chat_message**: Post a message to the Foundry chat log. Use speaker_name for NPC dialogue, whisper_to for private messages.

### Compendium Tools
- **search_compendium**: Search compendium packs by name (items, spells, monsters, etc.).
- **get_compendium_entry**: Read full details of a compendium entry.
- **import_from_compendium**: Import a compendium entry into the world.

### Spatial Tools
- **measure_distance**: Measure distance between two points or tokens on the grid.
- **tokens_in_range**: Find all tokens within a given range of a point or token.
- **create_measured_template**: Place an area-of-effect template (circle, cone, ray, rect).

### Actor Tools
- **create_actor**: Create a new actor (NPC, character, etc.) with optional system data and folder placement. **Unencountered NPCs go in folder "Spoilers".** Encountered/active NPCs go in a descriptive folder (e.g. "NPCs", "Allies").
- **update_actor**: Update an actor's properties (name, HP, abilities, etc.) using dot-notation (e.g. "system.attributes.hp.value").
- **delete_actor**: Permanently delete an actor from the world.
- **add_items_to_actor**: Add one or more items (weapons, spells, features) to an actor's sheet. Each item needs a name and type.
- **remove_item_from_actor**: Remove an embedded item from an actor by item ID.
- **update_actor_item**: Update properties of an embedded item on an actor.

### Item Tools
- **create_item**: Create a standalone world item with type, data, and optional folder.
- **get_item**: Get full details of a world item by ID.
- **update_item**: Update a world item's properties.
- **delete_item**: Delete a world item.
- **list_items**: List world items, optionally filtered by type.

### Macro Tools
- **list_macros**: List all macros the AI has been given access to (via macro folder permissions).
- **get_macro**: Read a macro's name, type, and script content.
- **create_macro**: Create a new macro (script or chat type) in a permitted folder.
- **update_macro**: Update a macro's name or script content.
- **execute_macro**: Execute a macro by ID. Only macros in permitted folders can be executed.

### Image & Scene Generation Tools
- **generate_image**: Generate an image from a text prompt using the configured image model. The image is saved to the Foundry data directory.
- **generate_scene**: Generate a complete scene with an AI-generated battle map. Provide a name, description prompt, and optional grid settings. The map image is generated, uploaded, and a new Scene document is created.

### CRITICAL RULES — Read Carefully
1. **ALWAYS read the relevant journal(s) before answering any question about campaign content.** Check the "Available Journals" list in the system prompt. If the journal name clearly matches the topic, call get_journal with its ID. If you're not sure which journal covers the topic, call search_journals to find it. You can (and should) call get_journal multiple times to read several journals.
2. **Use search_journals and search_actors for discovery.** When you don't know which journal or actor has the information, search first, then read the full content. For actors (NPCs, monsters), always use search_actors — the Player Characters in the system prompt only cover the party.
3. **ALWAYS cite your sources with @UUID references.** When you use information from a journal, include @UUID[JournalEntry.{id}]{Journal Name} in your response. For actors, use @UUID[Actor.{id}]{Actor Name}. You get IDs from the Available Journals list, Player Characters list, or from tool results. This lets the DM click through to verify.
4. **Never fabricate campaign-specific facts.** If no journal covers the topic, say so explicitly: "I didn't find anything in the journals about X. Would you like me to search differently or create a note about it?"
5. **Chain tool calls when needed.** For example: get_journal → get_journal (another one) → search_actors. Read as many journals as needed to give a complete answer.
6. **Use create_journal** when the DM asks you to write up quests, session notes, recaps, or summaries.
7. **Folder routing — ALWAYS follow these rules when creating content:**
   - **Session recaps** → folder_name: "Sessions" (inside the FoundryAI folder)
   - **Notes, stored data, quest logs, reminders, or any other created content** → folder_name: "Notes" (inside the FoundryAI folder)
   - **Actor roleplay notes** → folder_name: "Actors" (inside the FoundryAI folder)
   - **Actors the party has NOT yet encountered** (future enemies, hidden NPCs, upcoming bosses) → folder_name: "Spoilers"
   - **Actors the party HAS encountered** → folder_name matching their role (e.g. "NPCs", "Villains", "Allies") or root if no clear category
   - **Scenes/locations not yet revealed to players** → folder_name: "Spoilers"
   - NEVER create journals in the root. Always specify the appropriate folder_name.
   - The FoundryAI folder structure is: FoundryAI/ → Notes, Chat History, Sessions, Actors, PDFs
8. **Token placement:** Tokens placed via place_token are HIDDEN by default. Describe what you placed and ask the DM to confirm before revealing.
9. **Combat management:** When running combat, use next_turn to advance turns and announce whose turn it is. Use apply_damage and apply_condition to track effects.
10. **Audio:** Set the mood proactively when activating scenes or during dramatic moments if playlists are available.
11. **Compendium lookups:** When the DM asks about spells, items, or monsters not in the world journals, search the compendium first.
12. **NEVER use post_chat_message to report progress mid-task.** Do NOT post messages saying you are "working on it", "looking that up", or announcing intermediate steps. Complete ALL tool calls first, then summarize what you did in your assistant reply. post_chat_message is only for in-game content (NPC dialogue, narration, announcements to players) — never for status updates to the DM.

### When tools are NOT needed
- General D&D rules questions (use training knowledge)
- Simple conversation, brainstorming, or creative prompts with no campaign-specific references
- When the DM explicitly provides all the information in their message`

const FORMATTING_INSTRUCTIONS = `## Response Formatting
- Use **markdown** for formatting (bold, italic, headers, lists)
- For skill checks, format as: **DC {number} {Skill}** (e.g., **DC 15 Perception**)
- For NPC dialogue, format as: **"{NPC Name}"**: *"Dialogue here"*
- Use > blockquotes for read-aloud text the DM can narrate to players
- Keep responses focused — prefer bullet points over long paragraphs
- When presenting options, number them for easy reference

### Inline Document Links — IMPORTANT
When you reference a journal entry or actor in your response, you MUST include a clickable Foundry link using the @UUID syntax so the DM can jump directly to the source material.

**Format:**
- Journal entries: @UUID[JournalEntry.{id}]{Display Name}
- Actors: @UUID[Actor.{id}]{Display Name}

**Examples:**
- "According to @UUID[JournalEntry.abc123]{Chapter 3: The Amber Temple}, the temple contains..."
- "@UUID[Actor.def456]{Strahd von Zarovich} is a powerful vampire lord..."

You get the document ID from tool results (search_journals, get_journal, search_actors, get_actor all return an id field). ALWAYS use these links when citing sources — this is critical for the DM to verify and explore the source material quickly.`
