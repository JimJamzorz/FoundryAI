/* ==========================================================================
   System Prompt Builder.
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

	// Available actors inventory — TOOL_INSTRUCTIONS rule 15 and the
	// list_actors_in_folder guidance both reference this section, so it must
	// actually be injected here.
	try {
		const actorIndex = getActorInventory()
		if (actorIndex) {
			parts.push(actorIndex)
		}
	} catch {
		/* ignore */
	}

	// Campaign notes — short, curated plot-state bullets only (see getNotesContent).
	// Long entries are listed by name/ID instead of dumped, so a single oversized
	// note can't blow up every prompt the way a full PDF-derived note used to.
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

/** Notes longer than this are listed by name/ID (fetch via get_journal) instead of inlined in full. */
const MAX_INLINE_NOTE_CHARS = 1000

/**
 * Get the content of journals in the FoundryAI/Notes folder, for always-on plot-state
 * context. Notes are meant to be short, curated bullets the AI keeps updated (see the
 * CRITICAL RULE on Notes) — not a dumping ground for extracted reference material. Any
 * note over MAX_INLINE_NOTE_CHARS is treated as reference material: it's listed by name/ID
 * only (already fetchable via get_journal from the Available Journals index above) rather
 * than inlined, so one oversized note can't blow up every prompt.
 */
function getNotesContent(): string | null {
	const notesFolderId = getSubfolderId('notes')
	if (!notesFolderId) return null
	if (!game.journal || game.journal.size === 0) return null

	const inlined: string[] = []
	const oversized: string[] = []

	for (const entry of game.journal.values()) {
		if (!entry.folder || entry.folder.id !== notesFolderId) continue

		const content = collectionReader.getJournalContent(entry.id)
		if (!content) continue

		if (content.length > MAX_INLINE_NOTE_CHARS) {
			oversized.push(`- ${entry.name} (id: ${entry.id}) — long-form, call get_journal to read it`)
			continue
		}

		inlined.push(`### ${entry.name} (id: ${entry.id})\n${content}`)
	}

	if (inlined.length === 0 && oversized.length === 0) return null

	const parts: string[] = ['## Campaign Notes']
	parts.push('Short, curated plot-state notes you previously wrote — keep these updated as the campaign evolves.\n')
	if (inlined.length > 0) parts.push(inlined.join('\n\n'))
	if (oversized.length > 0) {
		parts.push('Longer reference notes (not inlined — read with get_journal if needed):')
		parts.push(oversized.join('\n'))
	}

	return parts.join('\n')
}

/**
 * Build a compact inventory of actors grouped by folder.
 * Respects the actorFolders allow-list (same policy as getJournalInventory):
 * if folders are selected, only actors inside them (or their children) are listed.
 */
function getActorInventory(): string | null {
	if (!game.actors || game.actors.size === 0) return null

	const allowedFolders = getSetting('actorFolders') || []
	const allAllowedFolderIds = allowedFolders.length > 0 ? collectionReader.resolveWithChildren(allowedFolders) : null // null = no restriction

	const byFolder = new Map<string, Array<{ id: string; name: string; type: string }>>()

	for (const actor of game.actors.values()) {
		if (allAllowedFolderIds !== null) {
			const folderId = actor.folder?.id
			if (!folderId || !allAllowedFolderIds.includes(folderId)) continue
		}
		const folderName = actor.folder?.name || 'Uncategorized'
		if (!byFolder.has(folderName)) byFolder.set(folderName, [])
		byFolder.get(folderName)!.push({
			id: actor.id,
			name: actor.name,
			type: actor.type,
		})
	}

	const lines: string[] = ['## Available Actors']
	lines.push('This is the complete, exhaustive list of every actor grouped by folder — if you need to know who is in a given folder, the answer is already below; do not call search_actors or list_actors_in_folder to rediscover it. Use get_actor (with the ID) to read full details for one of these.\n')

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
You have access to tools that let you interact with the Foundry VTT world. **You MUST use these tools before generating any response about campaign-specific content.** Do NOT rely on your training data or the "Relevant Context" section alone — always verify and enrich your answer by calling the appropriate tools first. Each tool's own name and description (in the tools list itself) tells you what it does and when to use it — the rules below cover cross-tool workflow that isn't captured by an individual tool's description.

### CRITICAL RULES — Read Carefully
1. **ALWAYS read the relevant journal(s) before answering any question about campaign content.** Check the "Available Journals" list in the system prompt. If the journal name clearly matches the topic, call get_journal with its ID. If you're not sure which journal covers the topic, call search_journals to find it. You can (and should) call get_journal multiple times to read several journals.
2. **Use search_journals and search_actors for discovery.** When you don't know which journal or actor has the information, search first, then read the full content. For actors (NPCs, monsters), always use search_actors — the Player Characters in the system prompt only cover the party. If the question is instead "who/what is in folder X" (a membership question, not a topic search), use list_actors_in_folder — do not try to answer folder-membership questions with search_actors.
3. **ALWAYS cite your sources with @UUID references.** When you use information from a journal, include @UUID[JournalEntry.{id}]{Journal Name} in your response. For actors, use @UUID[Actor.{id}]{Actor Name}. You get IDs from the Available Journals list, Player Characters list, or from tool results. This lets the DM click through to verify.
4. **Never fabricate campaign-specific facts.** If no journal covers the topic, say so explicitly: "I didn't find anything in the journals about X. Would you like me to search differently or create a note about it?"
5. **Chain tool calls when needed.** For example: get_journal → get_journal (another one) → search_actors. Read as many journals as needed to give a complete answer.
6. **Use create_journal** when the DM asks you to write up quests, session notes, recaps, or summaries.
7. **Folder routing — ALWAYS follow these rules when creating content:**
   - **Session recaps** → folder_name: "Sessions" (inside the FoundryAI folder)
   - **Short, curated plot-state notes ONLY** (see rule 14 — never reference material or extracted source content) → folder_name: "Notes" (inside the FoundryAI folder)
   - **Reference material** (extracted PDF content, NPC/monster dossiers, stat blocks, or anything else you're archiving rather than curating) → any other descriptive folder_name — NEVER "Notes"
   - **Actor roleplay notes** → folder_name: "Actors" (inside the FoundryAI folder)
   - **Actors the party has NOT yet encountered** (future enemies, hidden NPCs, upcoming bosses) → folder_name: "Spoilers"
   - **Actors the party HAS encountered** → folder_name matching their role (e.g. "NPCs", "Villains", "Allies") or root if no clear category
   - **Scenes/locations not yet revealed to players** → folder_name: "Spoilers"
   - NEVER create journals in the root. Always specify the appropriate folder_name.
   - The FoundryAI folder structure is: FoundryAI/ → Notes, Chat History, Sessions, Actors, PDFs
8. **Token placement:** Tokens placed via place_token are HIDDEN by default. Describe what you placed and ask the DM to confirm before revealing.
9. **Combat management:** When running combat, use next_turn to advance turns and announce whose turn it is. Use apply_damage and apply_condition to track effects. The "Combat State" section above is a snapshot from when this conversation loaded — call get_combat_status for the live round, turn, and combatant HP before making mid-combat decisions.
10. **Audio:** Set the mood proactively when activating scenes or during dramatic moments if playlists are available.
11. **Compendium lookups:** When the DM asks about spells, items, or monsters not in the world journals, search the compendium first.
12. **NEVER use post_chat_message to report progress mid-task.** Do NOT post messages saying you are "working on it", "looking that up", or announcing intermediate steps. Complete ALL tool calls first, then summarize what you did in your assistant reply. post_chat_message is only for in-game content (NPC dialogue, narration, announcements to players) — never for status updates to the DM.
13. **NEVER fabricate an image/asset path.** A path like "foundry-ai/images/goblin-chief.png" is only valid if a tool call (list_assets, extract_pdf_images, organize_images, render_pdf_page, generate_image, generate_scene) returned that exact string earlier in this conversation. If you need an image for an actor, item, or scene and don't already have a real path in hand, call list_assets first — never guess a plausible-looking filename from context.
14. **The Notes folder is for short, curated plot-state tracking — never reference dumps.** Everything in FoundryAI/Notes is loaded into every future prompt in full (the "Campaign Notes" section above), so keep it small: a bullet list of things that should always be considered going forward — revealed plot twists, current party goals, faction/NPC relationship changes, unresolved threads, consequences of past decisions. NEVER copy the full text of a PDF, a monster/NPC stat-block dossier, or any other source material into a Note — that's reference material and belongs in a regular journal (any folder other than "Notes"), where it's discoverable via search_journals/get_journal on demand instead of force-loaded every time. Prefer updating one running notes journal with update_journal over creating a new one each session — Notes should stay a short, current summary, not an ever-growing log.
15. **Check what you already have before calling a tool.** The "Available Actors" and "Player Characters" lists above already give you names, IDs, and types — don't call search_actors or list_folders to rediscover something already listed there. If a tool result tells you that you already made an identical call and got the same result, that means repeating it (even with slightly reworded arguments) will not help — stop, and either use the data you already have, try a genuinely different tool, or tell the DM what you found and what's still unclear.
16. **Applying portraits/token art to actors — the workflow ends with update_actor, not with more lookups.** Once you have (a) the actor IDs you're targeting and (b) candidate image paths from list_assets/extract_pdf_images, that's everything you need — do not call list_assets, list_folders, or list_actors_in_folder again to "double check." If image filenames are generic (e.g. auto-generated slugs) and it isn't obvious which image belongs to which actor, call describe_image on each candidate to see what it depicts and match it against the actor's name/race/description, then immediately call update_actor with { "img": "<path>" } (and optionally "prototypeToken.texture.src" for the token) for each match. Finish by telling the DM which portrait you assigned to which actor.

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
