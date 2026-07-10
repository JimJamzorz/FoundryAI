/* ==========================================================================
   AI Player Runtime — Trigger Loop
   Wakes up configured AI players when chat activity happens and lets each
   one decide, independently, whether their character would speak up right
   now. Deliberately narrow tool access: journal lookups (search_journals,
   get_journal — read-only, shared with the DM assistant) plus a personal
   notes journal each player can read/write for itself. Everything else
   (world mutation, DM tools) stays out of reach — the AI player is expected
   to talk in chat like a real player would, not act unilaterally.

   Design notes (see conversation history for the full rationale):
   - Any chat message from a source OTHER than a given AI player wakes that
     player up — including messages from other AI players. A player never
     re-triggers itself off its own message.
   - Triggers are debounced per player so a burst of messages collapses into
     one decision instead of one LLM call per line (same pattern as the HP
     debounce in session-event-hooks.ts).
   - A hard cap prevents AI players from spiraling into talking only to each
     other: if the trailing N chat messages were ALL posted by AI players
     (tracked via a flag on the ChatMessage), further AI turns are suppressed
     until a human (or DM-posted) message breaks the streak.
   ========================================================================== */

import { getSetting, type AIPlayerConfig, type ApiProvider } from '../settings'
import { openRouterService, type LLMMessage, type ToolCall, type ToolDefinition } from './openrouter-service'
import { buildActorRoleplayPrompt } from './system-prompt'
import { getToolsByNames, executeTool } from './tool-system'
import { getSubfolderId } from './folder-manager'

const MODULE_ID = 'foundry-ai'

/** Quiet window after the last relevant message before a player's turn actually runs. */
const DEBOUNCE_MS = 4000

/** How many recent chat lines to hand the model as context for its decision. */
const CONTEXT_MESSAGE_LIMIT = 15

/** Sentinel the model returns when it decides not to speak up. */
const PASS_SENTINEL = 'NO_RESPONSE'

/** Bound on tool-call round trips per turn — this is a quick reaction check, not a full agent loop. */
const MAX_TOOL_ROUNDS = 3

/** Read-only journal tools reused as-is from the shared tool system. */
const SHARED_TOOL_NAMES = ['search_journals', 'get_journal']

/** Player-scoped notes tools — handled locally, not through the shared executeTool dispatcher. */
const PLAYER_NOTES_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'read_my_notes',
			description:
				"Read your personal notes journal — things you've previously written down for yourself. Private to you; use it if you need to recall something before reacting.",
			parameters: { type: 'object', properties: {}, required: [] },
		},
	},
	{
		type: 'function',
		function: {
			name: 'write_my_notes',
			description:
				"Add a short note to your personal notes journal — something you learned, witnessed, or want to remember later. Private to you; nobody else reads this unless they specifically open your journal.",
			parameters: {
				type: 'object',
				properties: {
					content: { type: 'string', description: 'The note text to add (plain text or simple HTML).' },
				},
				required: ['content'],
			},
		},
	},
]

const DECISION_INSTRUCTIONS = `## Right Now
You are deciding whether you, specifically, would naturally speak up right now, based on the recent chat log below. This is a quick reaction check, not a full turn.

### Were you the one being talked to?
Check the most recent message first, before anything else:
- If it clearly addresses a DIFFERENT character by name, or asks that character a direct question, this is not your moment. Stay quiet (pass) even if you'd have something to say — real players don't jump in and answer for each other. Only override this if you were also named or asked, you have information nobody else has and it's urgent, or the addressed character has gone unanswered for a while and the scene is stalling.
- If it's addressed to you by name, to the group as a whole, or to no one in particular (general narration, an event happening, an open question), you're free to weigh in normally.

### Tools available
You have a small toolset — reach for it rarely, not on every turn. A description of an action (a door gets kicked in, someone looks around a room) is NOT a reason to search anything; that's just something you react to in character, the same way a real player would without checking a reference book mid-scene.
- search_journals / get_journal — only if you genuinely need a specific campaign fact to react accurately, and you don't already know it.
- read_my_notes / write_my_notes — your own private notes. Jot something down only if this moment is worth remembering later; check your notes only if you need to recall something specific first.
If you use a tool, use the actual tool-calling mechanism — never write out a function name or JSON as if it were your reply. If you're not going to use a tool (the common case), skip straight to deciding.

### Deciding
- If you'd say or do something in reaction, reply with ONLY the in-character line(s) — dialogue in quotes, brief actions in *italics*, same style as your roleplay guidelines above. Keep it short and natural, like a player chiming in mid-conversation.
- Otherwise — including "this wasn't directed at me" — reply with EXACTLY: ${PASS_SENTINEL}
- Don't narrate for other characters. Don't explain your reasoning. Output only your line(s), or the pass sentinel — nothing else.`

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const inFlight = new Set<string>()

/** Register the createChatMessage hook that drives the AI player trigger loop. GM-only. */
export function registerAIPlayerHooks(): void {
	Hooks.on('createChatMessage', (message: ChatMessage) => {
		try {
			handleIncomingMessage(message)
		} catch (e) {
			console.warn('FoundryAI | ai-player-runtime: createChatMessage handler failed:', e)
		}
	})
	console.log('FoundryAI | ai-player-runtime: registered')
}

function handleIncomingMessage(message: ChatMessage): void {
	if (!game.user?.isGM) return

	const players = getEnabledPlayers()
	if (players.length === 0) return

	const authorPlayerId = message.getFlag?.(MODULE_ID, 'aiPlayerId')

	for (const player of players) {
		// Never let a player's own message re-trigger itself — everything else
		// (humans, the DM, or a *different* AI player) is fair game.
		if (authorPlayerId && authorPlayerId === player.id) continue

		const existing = debounceTimers.get(player.id)
		if (existing) clearTimeout(existing)

		const timer = setTimeout(() => {
			debounceTimers.delete(player.id)
			considerPlayerTurn(player.id).catch(e =>
				console.error(`FoundryAI | AI player "${player.name}" turn failed:`, e),
			)
		}, DEBOUNCE_MS)

		debounceTimers.set(player.id, timer)
	}
}

function getEnabledPlayers(): AIPlayerConfig[] {
	const all = (getSetting('aiPlayers') || []) as AIPlayerConfig[]
	return all.filter(p => p.enabled && p.actorId && p.providerId && p.model)
}

async function considerPlayerTurn(playerId: string): Promise<void> {
	if (inFlight.has(playerId)) return

	// Re-fetch fresh config — settings may have changed during the debounce window.
	const player = getEnabledPlayers().find(p => p.id === playerId)
	if (!player) return

	const cap = getSetting('aiPlayerHumanCap') || 5
	const trailing = countTrailingAIMessages()
	if (trailing >= cap) {
		console.log(
			`FoundryAI | AI player "${player.name}" turn suppressed — ${trailing} consecutive AI messages ≥ cap (${cap}); waiting for a human message.`,
		)
		return
	}

	inFlight.add(playerId)
	try {
		await runPlayerDecision(player)
	} finally {
		inFlight.delete(playerId)
	}
}

/** Count trailing chat messages (most recent first) authored by any AI player, stopping at the first non-AI message. */
function countTrailingAIMessages(): number {
	const all = game.messages?.contents ?? []
	let count = 0
	for (let i = all.length - 1; i >= 0; i--) {
		const flag = all[i].getFlag?.(MODULE_ID, 'aiPlayerId')
		if (flag) count++
		else break
	}
	return count
}

async function runPlayerDecision(player: AIPlayerConfig): Promise<void> {
	const providers = (getSetting('apiProviders') || []) as ApiProvider[]
	const provider = providers.find(p => p.id === player.providerId)
	if (!provider) {
		console.warn(`FoundryAI | AI player "${player.name}" has no valid provider configured — skipping.`)
		return
	}

	const recentChat = getRecentChatLines(CONTEXT_MESSAGE_LIMIT)
	if (!recentChat) return

	const systemPrompt = buildDecisionPrompt(player)
	const tools = getPlayerToolset()

	const messages: LLMMessage[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: `## Recent Chat\n${recentChat}` },
	]

	let finalRaw = ''
	let finishReason: string | null = null

	for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
		const response = await openRouterService.chatCompletion({
			model: player.model,
			provider: { baseUrl: provider.baseUrl, apiKey: provider.apiKey },
			messages,
			tools: tools.length ? tools : undefined,
			temperature: 0.85,
			max_tokens: 500,
		})

		const choice = response.choices?.[0]
		const message = choice?.message
		finishReason = choice?.finish_reason ?? null

		if (message?.tool_calls?.length && round < MAX_TOOL_ROUNDS) {
			messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls })
			for (const call of message.tool_calls) {
				let result: string
				try {
					result = await executePlayerTool(player, call)
				} catch (e: any) {
					result = JSON.stringify({ error: e?.message || 'Tool execution failed' })
				}
				messages.push({ role: 'tool', content: result, tool_call_id: call.id })
			}
			continue
		}

		finalRaw = (message?.content ?? '').trim()
		break
	}

	if (!finalRaw) {
		// Ran out of tokens (or errored quietly) without producing anything — NOT the same as an
		// intentional pass. Smaller/local models are prone to this when they ramble past their
		// budget instead of following "output only the line(s), or the sentinel." Surface it as a
		// warning so it's diagnosable instead of looking identical to a deliberate NO_RESPONSE.
		console.warn(
			`FoundryAI | AI player "${player.name}" produced no content (finish_reason: ${finishReason ?? 'unknown'}) — treating as pass, but this likely means it ran out of tokens rather than deciding to stay quiet. Consider raising max_tokens further or checking the model's output.`,
		)
		return
	}

	if (finalRaw.toUpperCase() === PASS_SENTINEL) {
		console.log(`FoundryAI | AI player "${player.name}" chose not to respond.`)
		return
	}

	if (looksLikeLeakedToolCallOrMeta(finalRaw)) {
		// The shared recoverLeakedToolCalls in openrouter-service.ts already converts most
		// leaked tool-call syntax into real tool_calls before we ever see it — this is a
		// last-resort net for anything that slips through (or a model narrating *about*
		// calling a tool instead of actually calling it), so it never gets posted to chat
		// looking like the character said it.
		console.warn(
			`FoundryAI | AI player "${player.name}" produced tool-call-looking or meta text instead of dialogue — discarding: ${finalRaw.slice(0, 200)}`,
		)
		return
	}

	await postAsPlayer(player, finalRaw)
}

/** Bare JSON, or text narrating ABOUT calling a function rather than being in-character dialogue. */
function looksLikeLeakedToolCallOrMeta(text: string): boolean {
	const trimmed = text.trim()

	if (/^[{[]/.test(trimmed)) {
		try {
			JSON.parse(trimmed)
			return true // a bare JSON object/array is never in-character dialogue
		} catch {
			/* not valid JSON — keep checking */
		}
	}

	return /\b(call (another |the )?function|function call|tool.?call)\b/i.test(trimmed)
}

/** Resolve the tool list available to AI players — respects the global "Enable Tool Calling" setting. */
function getPlayerToolset(): ToolDefinition[] {
	if (!getSetting('enableTools')) return []
	return [...getToolsByNames(SHARED_TOOL_NAMES), ...PLAYER_NOTES_TOOLS]
}

/** Dispatch a tool call — personal notes tools are handled locally; everything else goes through the shared executor. */
async function executePlayerTool(player: AIPlayerConfig, call: ToolCall): Promise<string> {
	const name = call.function.name
	if (name === 'read_my_notes' || name === 'write_my_notes') {
		return await executeNotesTool(player, name, call.function.arguments)
	}
	return await executeTool(call)
}

// ---- Personal Notes Journal ----

/** Find or create this player's personal notes journal, inside FoundryAI/Players. */
async function getOrCreatePlayerJournal(player: AIPlayerConfig): Promise<JournalEntry | null> {
	const folderId = getSubfolderId('players')
	if (!folderId) {
		console.warn('FoundryAI | ai-player-runtime: Players folder not ready yet — cannot access personal notes.')
		return null
	}

	const existing = game.journal?.find((j: any) => j.getFlag?.(MODULE_ID, 'aiPlayerId') === player.id)
	if (existing) return existing

	const journal = await JournalEntry.create({
		name: `${player.actorName || player.name} — Notes`,
		folder: folderId,
		pages: [{ name: 'Notes', type: 'text', text: { content: '', format: 1 } }],
		flags: { [MODULE_ID]: { aiPlayerId: player.id } },
	})

	console.log(`FoundryAI | Created personal notes journal for "${player.name}" (${journal.id})`)
	return journal
}

async function executeNotesTool(player: AIPlayerConfig, toolName: string, argsJson: string): Promise<string> {
	const journal = await getOrCreatePlayerJournal(player)
	if (!journal) return JSON.stringify({ error: 'Could not access personal notes journal.' })

	const page = journal.pages?.contents?.[0]
	if (!page) return JSON.stringify({ error: 'Personal notes journal has no page.' })

	if (toolName === 'read_my_notes') {
		const content = stripHtml(page.text?.content || '')
		return JSON.stringify({ notes: content || '(nothing written yet)' })
	}

	// write_my_notes
	let args: { content?: string } = {}
	try {
		args = JSON.parse(argsJson)
	} catch {
		/* fall through with empty args */
	}
	const note = (args.content || '').trim()
	if (!note) return JSON.stringify({ error: 'No content provided.' })

	const existing = page.text?.content || ''
	const timestamp = new Date().toLocaleString()
	const entry = `<p><em>${timestamp}</em> — ${note}</p>`
	const updated = existing ? `${existing}\n${entry}` : entry

	await page.update({ text: { content: updated } })
	return JSON.stringify({ success: true, message: 'Saved to your personal notes.' })
}

function buildDecisionPrompt(player: AIPlayerConfig): string {
	// Leaner than the full roleplay prompt on purpose: this uses its own small, purpose-built
	// toolset (see getPlayerToolset), so the DM-facing tool-calling workflow rules and @UUID
	// citation/formatting rules (meant for full DM/roleplay turns with the 70+ tool suite) are
	// dropped to save tokens and avoid confusing smaller/local models with instructions that
	// describe tools they don't actually have.
	const persona = buildActorRoleplayPrompt(
		{ actorId: player.actorId, actorName: player.actorName || player.name },
		{ includeTools: false, includeFormatting: false },
	)
	const extra = player.systemPromptOverride?.trim()
		? `\n\n## Additional Direction\n${player.systemPromptOverride.trim()}`
		: ''
	return `${persona}${extra}\n\n${DECISION_INSTRUCTIONS}`
}

async function postAsPlayer(player: AIPlayerConfig, content: string): Promise<void> {
	const actor = game.actors?.get(player.actorId)
	const speaker = actor ? ChatMessage.getSpeaker({ actor }) : { alias: player.name }

	await ChatMessage.create({
		content,
		speaker,
		flags: { [MODULE_ID]: { aiPlayerId: player.id } },
	})

	console.log(`FoundryAI | AI player "${player.name}" spoke up.`)
}

// ---- Chat log helpers ----

function getRecentChatLines(limit: number): string {
	const all = game.messages?.contents ?? []
	const recent = all.slice(-limit)
	const lines: string[] = []

	for (const m of recent) {
		const text = stripHtml(m.content || '').trim()
		if (!text) continue
		lines.push(`${resolveSpeakerName(m)}: ${text}`)
	}

	return lines.join('\n')
}

function resolveSpeakerName(message: ChatMessage): string {
	const speaker = message.speaker as Record<string, any> | undefined
	if (speaker?.alias) return speaker.alias
	if (speaker?.actor) {
		const actor = game.actors?.get(speaker.actor)
		if (actor) return actor.name
	}
	return message.user?.name || 'Someone'
}

function stripHtml(html: string): string {
	return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}
