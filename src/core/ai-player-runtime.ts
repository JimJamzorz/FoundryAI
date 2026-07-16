/* ==========================================================================
   AI Player Runtime — Orchestrated Trigger Loop
   A single central orchestrator (the DM's own configured Chat Model) watches
   table chat and decides what happens next: a specific AI player reacts, the
   DM narrates a beat, or nothing happens and it waits for a human. This
   replaces an earlier design where every AI player listened and decided for
   itself independently — that produced pile-ons (several players deciding to
   speak at once) and no real sense of pacing or turn-taking. One arbiter with
   the full picture makes a better call than N models guessing in isolation.

   Design notes (see conversation history for the full rationale):
   - Off by default (aiOrchestrationEnabled) — opt in explicitly so nobody is
     surprised by unattended chat messages after enabling AI players.
   - Triggers are debounced (one global timer, not per-player) so a burst of
     messages collapses into one orchestrator decision instead of firing on
     every line.
   - AI players have a HARD knowledge boundary: exactly one journal each
     (GM-assigned via journalId, or an auto-created private one) that they can
     read and write — and nothing else. No shared search, no world lookups.
     If it isn't in the chat, their sheet, or their journal, the character
     doesn't know it. An earlier design gave players search_journals over the
     whole index, which let a character semantically search the GM's adventure
     text and "recall" module secrets.
   - The autonomous DM narration branch is even more restricted: read-only
     journal lookups and nothing else. No combat, damage, token, actor, or
     world-editing tools — those still require the human DM to actually chat.
     The narration is the reply TEXT itself (WAIT sentinel to do nothing),
     posted only after the same meta/leak filter the player turns use. An
     earlier design required a post_chat_message tool call to count as
     "acting", but models — including tool-capable ones — reliably write
     narration as plain content instead of wrapping it in a tool call, so
     good beats were being generated and then silently discarded.
   - A hard cap (aiPlayerHumanCap) prevents endless automated chatter: once N
     consecutive messages are all automated (AI player or autonomous DM,
     tracked via the "automated" flag on the ChatMessage), the orchestrator
     suppresses itself until a human message breaks the streak.
   ========================================================================== */

import { getSetting, type AIPlayerConfig, type ApiProvider } from '../settings'
import { queueTTS } from './tts-service'
import { openRouterService, TOOLS_UNSUPPORTED_NOTICE, type LLMMessage, type ToolCall, type ToolDefinition, type ProviderConfig } from './openrouter-service'
import { buildActorRoleplayPrompt, buildSystemPrompt } from './system-prompt'
import { getToolsByNames, executeTool } from './tool-system'
import { getSubfolderId } from './folder-manager'

const MODULE_ID = 'foundry-ai'

/** Quiet window after the last relevant message before the orchestrator actually runs.
 *  Humans type slower than models generate — a short window fires mid-typing and the
 *  orchestrator ends up reacting to half a thought. */
const DEBOUNCE_MS = 10_000

/** How many AI turns (player or DM) may run simultaneously. Turns dispatch to
 *  per-player providers — potentially different machines — so overlapping them is
 *  fine, but every HUMAN message also spawns its own decision cycle: an active GM
 *  chatting mid-scene stacks threads fast. Two keeps crosstalk lively without the
 *  in-flight count skyrocketing when a human joins in. */
const MAX_CONCURRENT_TURNS = 2

/** turnsInFlight key for the autonomous DM (only one DM narration at a time). */
const DM_TURN_KEY = '__dm__'

/** How many recent chat lines to hand the model as context. */
const CONTEXT_MESSAGE_LIMIT = 15

/** Sentinel a called-on player returns when it decides not to speak after all. */
const PASS_SENTINEL = 'NO_RESPONSE'

/** Bound on tool-call round trips per turn — a quick reaction/narration beat, not a full agent loop. */
const MAX_TOOL_ROUNDS = 3

/**
 * Token budget for a player turn / DM narration beat. A short in-character line only
 * needs a fraction of this, but reasoning-capable local models (Gemma-QAT via LM
 * Studio, etc.) spend a big chunk of whatever budget they're given on an internal
 * "thinking" pass before writing the real answer — that reasoning counts against the
 * same cap. The retry-with-more-budget safety net in openrouter-service.ts catches a
 * blown budget, but it salvages NOTHING — the first call's entire thought process is
 * discarded and re-generated from scratch, so every trip through it costs roughly
 * double. Observed: Qwen-class thinking models spend ~5000 chars (~1300+ tokens)
 * reasoning per beat, which made the old 1200 cap fail (and pay the double-cost)
 * on essentially every DM narration. Sized so thought + answer fit on the first
 * attempt; costs nothing extra for concise/non-reasoning models, since this is a
 * ceiling, not a target — they still stop at their own natural length.
 */
const TURN_MAX_TOKENS = 2500

/**
 * Token budget for the orchestrator's own ACTOR/DM/WAIT decision. The answer itself is
 * one short line, but — same as TURN_MAX_TOKENS above — a reasoning-capable model
 * assigned as the Chat Model spends real tokens "thinking" before it commits to that
 * line, and 60 wasn't enough headroom even for a fairly short deliberation (seen
 * hitting the wall at 60/60 with only ~236 chars of reasoning so far). Set generously
 * enough that the common case succeeds on the first call instead of needing
 * openrouter-service.ts's retry-with-bigger-budget fallback every single time.
 */
const ORCHESTRATOR_MAX_TOKENS = 500

/** Lookup tools for the autonomous DM narration branch — reading only. The narration
 *  itself is delivered as the reply text, NOT via post_chat_message: models (even
 *  tool-capable ones) reliably write narration as plain content rather than wrapping
 *  it in a tool call, and requiring the call meant perfectly good beats were generated
 *  and then discarded. */
const DM_LOOKUP_TOOL_NAMES = ['search_journals', 'get_journal']

/**
 * The ONLY tools an AI player has: read/write access to their one designated
 * journal (AIPlayerConfig.journalId, or an auto-created private one). This is
 * a hard knowledge boundary, not a suggestion — players used to carry
 * search_journals/get_journal over the whole index, which meant a character
 * could semantically search the GM's adventure text and "recall" module
 * secrets. Now: if it isn't in the chat, their sheet, or their journal, the
 * character doesn't know it. Handled locally, never through executeTool.
 */
const PLAYER_JOURNAL_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'read_my_journal',
			description:
				"Read your character's journal — everything they know beyond the current conversation: memories, lore they'd plausibly know, and things they've written down. Take a moment to check it whenever something rings a bell (a name, a place, a symbol).",
			parameters: { type: 'object', properties: {}, required: [] },
		},
	},
	{
		type: 'function',
		function: {
			name: 'write_my_journal',
			description:
				'Write a short entry in your journal — something learned, witnessed, promised, or worth remembering later. It will be there next time you read your journal.',
			parameters: {
				type: 'object',
				properties: {
					content: { type: 'string', description: 'The entry text to add (plain text or simple HTML).' },
				},
				required: ['content'],
			},
		},
	},
]

/** Character cap for read_my_journal — a GM-assigned lore journal can be long. */
const PLAYER_JOURNAL_READ_MAX = 8000

/** Page within the designated journal where the character's own writing goes,
 *  so GM-authored lore pages are never modified. */
const PLAYER_WRITE_PAGE_NAME = 'Character Notes'

const PLAYER_TURN_INSTRUCTIONS = `## Your Turn
The DM has indicated this is a moment for you specifically to react, based on the recent chat below.

### Your Journal
You have exactly one tool pair: read_my_journal and write_my_journal — your character's own journal. It holds everything your character knows beyond this conversation: memories, lore they'd plausibly know, things they've chosen to write down.
- Taking a second to check your journal before reacting is fine and encouraged whenever something rings a bell — a name, a place, a symbol, a promise.
- Write down what's worth remembering later: discoveries, debts, grudges, clues.
- That journal is your entire knowledge of the world. If it isn't in the chat, your journal, or your character sheet, your character does not know it — react with honest uncertainty instead of inventing facts.
If you use a tool, use the actual tool-calling mechanism — never write out a function name or JSON as if it were your reply.

### Move Things Forward
You are a doer, not a commentator. Your turn should CHANGE something — commit to an action, take the step, open the door, follow the plan, make the offer. Observing, speculating, or asking yet another question about the same thing is how scenes die.
- If another character proposed doing something (moving on, a plan, a direction), ENGAGE with it: agree and act on it, or push back with a concrete alternative of your own. Never leave a proposal hanging while you examine scenery.
- Investigating something once is good play. Investigating the same thing the group has already looked at is a wasted turn — draw a conclusion from what's known and act on it.
- When in doubt, be bold and wrong rather than careful and still. Consequences are the fun part; your character's mistakes make the story.

### Responding — CRITICAL
Whatever you write is posted to the table's chat log VERBATIM, exactly as your character's own message — not shown to anyone as a draft, not summarized, not filtered. Only your character's actual words and actions belong in it.

Never include any of the following — these are not roleplay, they're you narrating about the task instead of doing it, and they will be posted to the table looking exactly as broken as they sound:
- Planning or thinking out loud ("I'm considering my options...", "Currently considering...")
- Restating the situation, the chat, or what other characters just said back to yourself
- A numbered list of choices for what to do next (that's the DM's job, not yours)
- Any sentence about the act of writing itself — "I will add something", "we need to reply as X", "let's craft a line", "since you need to write down your thought process"
- Your own character's name as a speaker label in front of your line (e.g. "Kale: ...") — the chat log below is shown to you as "Name: message" so you can tell who said what, but that's a transcript format for your reference only, not something to reproduce. You ARE the character; the chat message already shows who's speaking, don't caption yourself
- Repeating the same sentence or paragraph more than once

Good reply: *I grip my wand tight, watching the flickering shapes.* "Careful — I don't think these things are friendly."
Bad reply (never do this): "Since Kale needs to react to the ghosts, I will write: Kale grips his wand and says..."

- Dialogue in quotes, brief actions in *italics*, same style as your roleplay guidelines above. Keep it short: usually one sentence, or two brief sentences at most. One or two short beats — a quick reaction, not a paragraph.
- If, having actually looked at the chat, there's genuinely nothing for your character to add, reply with EXACTLY: ${PASS_SENTINEL}
- Don't narrate for other characters. Output only your line(s), or the pass sentinel — nothing else.`

/**
 * DM narration instructions. The reply text itself IS the narration (posted
 * verbatim after filtering), with an explicit WAIT sentinel for "do nothing" —
 * tools exist only for looking facts up first. You are NOT taking over the
 * table: no combat, damage, token, actor, or world-editing capability exists
 * in this mode; anything like that stays with the human DM.
 */
const DM_NARRATION_INSTRUCTIONS = `## Autonomous Narration — Right Now
You've decided this moment could use a beat of narration or NPC dialogue to keep the scene moving, based on the recent chat below.

### Canon — you narrate this adventure, you do not write it
This is an established campaign with source material. You must NOT introduce new named locations, NPCs, creatures, factions, items, or plot elements. Every proper noun and every concrete fact in your narration must come from one of: the recent chat, the campaign context above (including any Director's/campaign notes), or a journal you look up right now with search_journals / get_journal.
- Unsure whether something exists in this campaign? Search FIRST, or don't mention it.
- When you have no established fact to advance with, stay purely atmospheric — weather, light, sound, smell, mood, body language. Atmosphere needs no canon and is always safe. Tension and dread are yours; new monsters and new places are not.
- Introducing something genuinely new is the human DM's call, never yours. If the scene seems to need it, that's a WAIT.

Whatever you reply is posted to the table's chat log VERBATIM as DM narration — it is not a draft and nobody filters it.
- If a short narration beat, environmental detail, or one line of NPC dialogue would genuinely help, reply with ONLY that text. A sentence or two — this is a nudge, not a full scene.
- Format chat output with simple Foundry-safe HTML when emphasis helps: use <em>italic text</em>, <strong>bold text</strong>, <p>paragraphs</p>, and <br> for line breaks. Do NOT use Markdown syntax at all — never use *, **, ***, _, #, blockquotes, or Markdown lists. Plain text is preferred when no formatting is needed.
- If the party is STALLING — circling the same spot, re-investigating what they've already examined, nobody committing to a direction — apply pressure with pure atmosphere: a sound drawing nearer, the light failing, the cold deepening, something changed because time passed. Make waiting cost something and give them a reason to move. (This needs no canon — time and weather are always yours.)
- If nothing needs to happen — the scene doesn't need advancing, or this is a moment for a human — reply with EXACTLY: WAIT
- Never explain what you're doing, never describe your reasoning, no speaker labels, no lists, no meta-commentary. Only the narration itself, or WAIT.`

// ---- Trigger loop ----

let debounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Concurrency model: the orchestrator DECISION is serialized (two overlapping
 * decisions would double-dispatch off the same chat state), but the dispatched
 * TURNS are not — each AI player runs against its own provider (often its own
 * machine), so turns fire-and-forget with a per-player guard: a player who is
 * still generating can't be picked again, and everyone in flight is hidden
 * from the orchestrator's roster for the next decision.
 */
let decisionInFlight = false
/** A message arrived while a decision was running — re-run once it finishes. */
let decisionPending = false
/** Player ids (or DM_TURN_KEY) whose turns are currently generating. */
const turnsInFlight = new Set<string>()

/**
 * The AI player dispatched on the immediately preceding orchestration cycle, if that
 * cycle was an ACTOR dispatch — cleared whenever a DM turn or a WAIT breaks the streak.
 * Weaker/smaller orchestrator models are prone to anchoring on whoever spoke most
 * recently (the recent-chat context ends up dominated by that character's own lines,
 * which reads as "this person is active" rather than "this person just went"), which
 * left unchecked can hand the same character the mic turn after turn until the human
 * cap kicks in. This is a hard, model-independent guardrail against that specific
 * failure — it does not fully replace judgment (see the "Last to speak" hint in
 * buildOrchestratorPrompt), just backstops it when the model gets it wrong anyway.
 */
let lastActorDispatchedId: string | null = null

/** Register the createChatMessage hook that drives the orchestrator. GM-only. */
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

/** Prefix every trace line so the console can be filtered down to just the orchestrator's reasoning. */
const TRACE = 'FoundryAI | orchestrator trace:'

function handleIncomingMessage(message: ChatMessage): void {
	if (!game.user?.isGM) {
		console.debug(`${TRACE} ignoring — this client isn't the GM (orchestration only runs in the GM's browser).`)
		return
	}
	if (!getSetting('aiOrchestrationEnabled')) {
		console.log(`${TRACE} ignoring createChatMessage — AI Orchestration is turned off (enable it in the AI Players window).`)
		return
	}

	console.log(
		`${TRACE} message received from "${resolveSpeakerName(message)}" — (re)starting ${DEBOUNCE_MS}ms debounce timer.`,
	)

	if (debounceTimer) clearTimeout(debounceTimer)
	debounceTimer = setTimeout(() => {
		debounceTimer = null
		console.log(`${TRACE} debounce elapsed — considering orchestration now.`)
		considerOrchestration().catch(e => console.error('FoundryAI | orchestrator turn failed:', e))
	}, DEBOUNCE_MS)
}

/**
 * options.afterDMPass marks the single follow-up cycle that "keep the scene
 * moving" runs when the DM considered narrating and declined. In that cycle the
 * orchestrator is nudged to pick a player, DM decisions are treated as WAIT
 * (the DM just passed), and WAIT is honored as-is — which is what terminates
 * the loop: WAIT → DM → DM passes → one actor-or-nothing retry → done.
 */
async function considerOrchestration(options: { afterDMPass?: boolean } = {}): Promise<void> {
	if (decisionInFlight) {
		// Don't lose this cycle — re-run once the current decision resolves.
		decisionPending = true
		console.log(`${TRACE} decision already in flight — queued a re-run for when it finishes.`)
		return
	}

	const cap = getSetting('aiPlayerHumanCap') || 5
	const trailing = countTrailingAutomatedMessages()
	console.log(`${TRACE} ${trailing} trailing automated message(s), cap is ${cap}.`)
	if (trailing >= cap) {
		console.log(
			`FoundryAI | orchestrator suppressed — ${trailing} consecutive automated messages ≥ cap (${cap}); waiting for a human message.`,
		)
		return
	}

	if (turnsInFlight.size >= MAX_CONCURRENT_TURNS) {
		console.log(`${TRACE} skipping — ${turnsInFlight.size} turn(s) already generating (cap ${MAX_CONCURRENT_TURNS}).`)
		return
	}

	const recentChat = getRecentChatLines(CONTEXT_MESSAGE_LIMIT)
	if (!recentChat) {
		console.log(`${TRACE} skipping — no recent chat text found (getRecentChatLines returned empty).`)
		return
	}

	const includeDMModel = getSetting('aiIncludeDMModel') ?? true

	// Menu construction — the DM is part of the same rotating cast as the
	// players. Hidden this cycle: whoever spoke in the recent rotation window
	// (players AND the DM), whoever is mid-generation, and whoever was just
	// dispatched but may not have posted yet. The parser only accepts names
	// from the offered menu, so this is enforced, not suggested.
	const enabled = getEnabledPlayers()
	const hiddenKeys = getRotationHiddenKeys(enabled, includeDMModel)
	if (lastActorDispatchedId) hiddenKeys.add(lastActorDispatchedId)

	const players = enabled.filter(p => !turnsInFlight.has(p.id) && !hiddenKeys.has(p.id))
	let dmEligible = includeDMModel && !hiddenKeys.has(DM_ROTATION_KEY) && !turnsInFlight.has(DM_TURN_KEY)
	// Never let the menu go completely empty: if every player is hidden/busy and
	// the DM is rotation-hidden too, the DM steps back in rather than stalling.
	if (includeDMModel && players.length === 0 && !dmEligible && !turnsInFlight.has(DM_TURN_KEY)) dmEligible = true

	const hiddenNames = [
		...enabled.filter(p => hiddenKeys.has(p.id)).map(p => p.actorName || p.name),
		...(includeDMModel && hiddenKeys.has(DM_ROTATION_KEY) ? ['DM'] : []),
	]
	if (hiddenNames.length > 0) {
		console.log(`${TRACE} rotation: hiding recent speaker(s) ${hiddenNames.join(', ')} from the menu this cycle.`)
	}
	console.log(
		`${TRACE} menu: ${[...players.map(p => p.actorName || p.name), ...(dmEligible ? ['DM'] : [])].join(', ') || '(nobody available)'}${turnsInFlight.size ? ` — ${turnsInFlight.size} in flight` : ''}`,
	)

	const pressure = getSpotlightPressure(enabled)

	decisionInFlight = true
	try {
		console.log(`${TRACE} calling orchestrator decision model...`)
		let decision = await runOrchestratorDecision(
			players,
			dmEligible,
			recentChat,
			options.afterDMPass === true,
			pressure,
			enabled,
			hiddenNames,
		)

		const keepMoving = getSetting('aiKeepSceneMoving') ?? false

		if (decision.type === 'dm' && options.afterDMPass) {
			console.log(`${TRACE} orchestrator called for the DM again right after the DM passed — stopping here.`)
			lastActorDispatchedId = null
			return
		}

		if (decision.type === 'wait') {
			// Keep-scene-moving: WAIT becomes the most sensible eligible dispatch —
			// the DM if it hasn't narrated recently, otherwise the most overdue
			// player. (Previously WAIT always became a DM beat, which is exactly how
			// the table drowned in narration once every player was rotation-hidden.)
			if (keepMoving && !options.afterDMPass) {
				if (dmEligible) {
					console.log(`${TRACE} decision was WAIT — keep-scene-moving converts it into a DM narration beat.`)
					decision = { type: 'dm' }
				} else {
					const fallback = pickMostOverdue(players, pressure)
					if (fallback) {
						console.log(
							`${TRACE} decision was WAIT — keep-scene-moving hands the mic to most-overdue "${fallback.actorName || fallback.name}" (DM has narrated too recently).`,
						)
						decision = { type: 'actor', player: fallback }
					}
				}
			}
			if (decision.type === 'wait') {
				console.log(`${TRACE} decision was WAIT — doing nothing this round.`)
				lastActorDispatchedId = null
				return
			}
		}

		if (decision.type === 'actor') {
			const player = decision.player
			const displayName = player.actorName || player.name
			lastActorDispatchedId = player.id
			turnsInFlight.add(player.id)
			console.log(`${TRACE} dispatching to AI player "${displayName}" (${turnsInFlight.size} turn(s) now in flight)...`)
			// Fire-and-forget: the turn runs on the player's own provider, and the
			// orchestrator is free to make its next decision while it generates.
			runPlayerTurn(player, recentChat)
				.catch(e => console.error(`FoundryAI | AI player turn for "${displayName}" failed:`, e))
				.finally(() => {
					turnsInFlight.delete(player.id)
					console.log(`${TRACE} player turn for "${displayName}" finished (${turnsInFlight.size} still in flight).`)
				})
			return
		}

		// DM narration — same fire-and-forget, but only one at a time.
		if (turnsInFlight.has(DM_TURN_KEY)) {
			console.log(`${TRACE} decision was DM but a DM narration is already generating — dropping this one.`)
			return
		}
		lastActorDispatchedId = null
		turnsInFlight.add(DM_TURN_KEY)
		console.log(`${TRACE} dispatching to autonomous DM narration...`)
		void (async () => {
			let posted = false
			try {
				posted = await runAutonomousDMNarration(recentChat)
			} catch (e) {
				console.error('FoundryAI | autonomous DM narration failed:', e)
			} finally {
				turnsInFlight.delete(DM_TURN_KEY)
				console.log(`${TRACE} autonomous DM narration turn finished.`)
			}
			// The DM looked at the moment and passed — under keep-scene-moving that
			// usually means "this is a player's beat", so give the orchestrator one
			// follow-up chance to name a player. afterDMPass makes it single-shot.
			if (!posted && keepMoving && !options.afterDMPass) {
				console.log(`${TRACE} DM passed — keep-scene-moving asks the orchestrator once more for a player pick.`)
				considerOrchestration({ afterDMPass: true }).catch(e =>
					console.error('FoundryAI | keep-scene-moving follow-up cycle failed:', e),
				)
			}
		})()
	} finally {
		decisionInFlight = false
		if (decisionPending) {
			decisionPending = false
			console.log(`${TRACE} running the queued decision cycle now.`)
			// New cycle sees the just-updated turnsInFlight/lastActor state.
			considerOrchestration().catch(e => console.error('FoundryAI | queued orchestration cycle failed:', e))
		}
	}
}

/** How many recent chat messages to scan when computing spotlight balance. */
const SPOTLIGHT_WINDOW = 30

interface SpotlightPressure {
	/** Automated posts per player id within the window. */
	counts: Map<string, number>
	/** Players with ZERO recent turns while some other player has had 2+ —
	 *  i.e. someone else has gone (at least) twice since they last acted. */
	overdue: AIPlayerConfig[]
}

/**
 * Measure who's been hogging the spotlight, from the chat log itself (posts are
 * stamped with aiPlayerId, so this survives reloads and needs no extra state).
 * Small orchestrator models anchor hard on whichever character dominates the
 * recent transcript — this powers both the prompt-side pressure and the hard
 * redirect that guarantees quiet characters eventually get the mic.
 */
function getSpotlightPressure(players: AIPlayerConfig[]): SpotlightPressure {
	const counts = new Map<string, number>()
	for (const p of players) counts.set(p.id, 0)

	const all = game.messages?.contents ?? []
	for (const m of all.slice(-SPOTLIGHT_WINDOW)) {
		const pid = (m as any).getFlag?.(MODULE_ID, 'aiPlayerId')
		if (pid && counts.has(pid)) counts.set(pid, (counts.get(pid) || 0) + 1)
	}

	const maxCount = Math.max(0, ...counts.values())
	const overdue = maxCount >= 2 ? players.filter(p => (counts.get(p.id) || 0) === 0) : []
	return { counts, overdue }
}

/** Rotation key representing the autonomous DM in the unified speaker rotation. */
const DM_ROTATION_KEY = 'DM'

/**
 * Hard rotation over a UNIFIED cast: the enabled players AND the autonomous DM
 * rotate together. The speakers of the last K automated posts (player turns and
 * DM beats alike) are hidden from the orchestrator's menu, K = half the cast
 * rounded up, never everyone. Soft prompt pressure demonstrably loses to an
 * anchored small model, so the favorite simply isn't offered — and because DM
 * beats count as speaking, a DM that just narrated is off the menu too, which
 * kills the observed failure where the DM narrated ten beats in a row while two
 * hidden players never aged out of exclusion (only player posts used to move
 * the window).
 *
 * Returns hidden keys: player ids and/or DM_ROTATION_KEY.
 */
function getRotationHiddenKeys(players: AIPlayerConfig[], includeDMModel = true): Set<string> {
	const castSize = players.length + (includeDMModel ? 1 : 0)
	const excludeMax = Math.min(Math.ceil(castSize / 2), castSize - 1)
	const hidden = new Set<string>()
	if (excludeMax <= 0) return hidden

	// Collect the speakers of the last `excludeMax` automated posts (duplicates
	// count — a dominant voice fills the window alone and only costs themselves).
	const all = game.messages?.contents ?? []
	let postsSeen = 0
	for (let i = all.length - 1; i >= 0 && postsSeen < excludeMax; i--) {
		const m: any = all[i]
		const pid = m.getFlag?.(MODULE_ID, 'aiPlayerId')
		if (typeof pid === 'string' && players.some(p => p.id === pid)) {
			hidden.add(pid)
			postsSeen++
		} else if (includeDMModel && m.getFlag?.(MODULE_ID, 'autonomousDM')) {
			hidden.add(DM_ROTATION_KEY)
			postsSeen++
		}
	}
	return hidden
}

/** The eligible player who has spoken least recently — the substitution target
 *  when the orchestrator names someone who isn't on the menu. */
function pickMostOverdue(eligible: AIPlayerConfig[], pressure: SpotlightPressure): AIPlayerConfig | null {
	if (eligible.length === 0) return null
	return [...eligible].sort((a, b) => (pressure.counts.get(a.id) || 0) - (pressure.counts.get(b.id) || 0))[0]
}

function getEnabledPlayers(): AIPlayerConfig[] {
	const all = (getSetting('aiPlayers') || []) as AIPlayerConfig[]
	return all.filter(p => p.enabled && p.actorId && p.providerId && p.model)
}

/** Count trailing chat messages (most recent first) posted by automation (AI player or autonomous DM), stopping at the first human/non-flagged message. */
function countTrailingAutomatedMessages(): number {
	const all = game.messages?.contents ?? []
	let count = 0
	for (let i = all.length - 1; i >= 0; i--) {
		if (all[i].getFlag?.(MODULE_ID, 'automated')) count++
		else break
	}
	return count
}

// ---- Orchestrator decision ----

type OrchestratorDecision = { type: 'actor'; player: AIPlayerConfig } | { type: 'dm' } | { type: 'wait' }

async function runOrchestratorDecision(
	players: AIPlayerConfig[],
	dmEligible: boolean,
	recentChat: string,
	dmJustPassed = false,
	pressure: SpotlightPressure = { counts: new Map(), overdue: [] },
	allEnabled: AIPlayerConfig[] = players,
	hiddenNames: string[] = [],
): Promise<OrchestratorDecision> {
	const { model, provider } = resolveOrchestratorModel()
	if (!model) {
		console.log(`${TRACE} no orchestrator model available (set a Chat Model, or an Orchestrator Model override, in Settings) — defaulting to WAIT.`)
		return { type: 'wait' }
	}
	if (!provider && !openRouterService.isConfigured) {
		console.log(`${TRACE} no chat provider configured (Settings → API Providers) — defaulting to WAIT.`)
		return { type: 'wait' }
	}

	try {
		const response = await openRouterService.chatCompletion({
			model,
			...(provider ? { provider } : {}),
			messages: [
				{ role: 'system', content: buildOrchestratorPrompt(players, dmEligible, dmJustPassed, hiddenNames) },
				{ role: 'user', content: `## Recent Chat\n${recentChat}` },
			],
			// No temperature: let the serving side decide (e.g. LM Studio's per-model
			// setting), so the orchestrator model's own tuned config is the truth.
			max_tokens: ORCHESTRATOR_MAX_TOKENS,
		})

		const raw = response.choices?.[0]?.message?.content ?? ''
		const decision = parseOrchestratorDecision(raw, players, dmEligible, allEnabled, pressure)
		console.log(
			`FoundryAI | orchestrator decision: ${decision.type}${decision.type === 'actor' ? ` (${decision.player.actorName || decision.player.name})` : ''} — raw: "${raw.trim().slice(0, 80)}"`,
		)
		return decision
	} catch (e) {
		console.error('FoundryAI | orchestrator decision call failed:', e)
		return { type: 'wait' }
	}
}

/**
 * Resolve which model (and optionally provider) runs the orchestrator's own triage
 * decision. Defaults to the DM's Chat Model/provider, same as before — but the
 * Orchestrator Model setting lets this specific, high-frequency, low-stakes call be
 * pointed at something fast/lightweight, separate from a heavier "thinking" model
 * you'd rather reserve for actual DM narration and full chat turns. Only used when
 * BOTH a provider and a model override are set and the provider still exists; a
 * lone model override (no provider picked) runs against the default configured chat
 * provider instead of guessing.
 */
function resolveOrchestratorModel(): { model: string; provider?: ProviderConfig } {
	const overrideModel = getSetting('orchestratorModel')?.trim()
	const overrideProviderId = getSetting('orchestratorProviderId')?.trim()

	if (overrideProviderId && overrideModel) {
		const providers = (getSetting('apiProviders') || []) as ApiProvider[]
		const found = providers.find(p => p.id === overrideProviderId)
		if (found) {
			return { model: overrideModel, provider: { baseUrl: found.baseUrl, apiKey: found.apiKey } }
		}
		console.warn(
			`FoundryAI | Orchestrator provider "${overrideProviderId}" not found in API Providers — falling back to the main DM Chat Model/provider.`,
		)
	} else if (overrideModel) {
		return { model: overrideModel }
	}

	return { model: getSetting('chatModel') || '' }
}

function buildOrchestratorPrompt(
	players: AIPlayerConfig[],
	dmEligible: boolean,
	dmJustPassed = false,
	hiddenNames: string[] = [],
): string {
	// One unified cast: characters and the DM are entries on the same menu, and
	// whoever spoke recently (including the DM) simply isn't listed. Anything
	// not on the menu is an invalid answer — the parser substitutes it away.
	const cast = [
		...players.map(p => `- ${p.actorName || p.name}`),
		...(dmEligible ? ['- DM   (a short beat of scene narration or NPC dialogue)'] : []),
	].join('\n') || '(nobody is available this round)'

	return `You're quietly watching a tabletop RPG session as an assistant director — you don't post anything yourself, you just decide who acts next based on the recent chat below.

## Cast — who may act next. ONLY these are valid picks:
${cast}
${hiddenNames.length > 0 ? `\n(${hiddenNames.join(', ')} spoke recently and ${hiddenNames.length === 1 ? 'is' : 'are'} resting this round — naming them is invalid.)\n` : ''}${dmJustPassed ? `\n**The DM just looked at this moment and declined to narrate** — it needs a character to act, not more scene-setting. Pick a character from the cast if at all plausible; WAIT only if truly nobody fits.\n` : ''}
## Decide
Who from the cast would most naturally act or speak next? Prefer a character reacting over DM narration when both are plausible — narration is seasoning, not the meal. If truly nothing should happen (or this is a human's moment), wait.

## Your Answer — respond with EXACTLY ONE line, nothing else:
- ACTOR: <name>   (one character's exact name from the cast above)
${dmEligible ? '- DM   (just the word DM, when the DM should narrate a beat)\n' : ''}- WAIT   (just the word WAIT, when nothing should happen)`
}

function parseOrchestratorDecision(
	raw: string,
	players: AIPlayerConfig[],
	dmEligible = true,
	allEnabled: AIPlayerConfig[] = players,
	pressure: SpotlightPressure = { counts: new Map(), overdue: [] },
): OrchestratorDecision {
	// Strip leading list markers before parsing: models frequently echo the
	// answer-format bullet ("- DM", "- WAIT", "- ACTOR: Kale"), which otherwise
	// only parses correctly by fuzzy-match luck (and "- DM"/"- WAIT" not at all).
	let firstLine = ((raw || '').trim().split('\n')[0]?.trim() ?? '').replace(/^[-*•\d.)\s]+/, '')

	// Llama-family models sometimes answer in their function-call dialects even
	// when NO tools were offered — {"name": "Meeris", "parameters": {}} or
	// <function=Meeris> — treating "pick who acts" as a call where the function
	// IS the character. Unwrap the name and parse it like any other answer.
	// A structured answer is always an explicit pick, so unmatched names get
	// the substitution treatment rather than silently becoming WAIT.
	let structuredAnswer = false
	const jsonCandidate = firstLine.startsWith('{') ? firstLine : (raw || '').trim()
	if (jsonCandidate.startsWith('{')) {
		try {
			const parsed = JSON.parse(jsonCandidate)
			if (typeof parsed?.name === 'string' && parsed.name.trim()) {
				firstLine = parsed.name.trim()
				structuredAnswer = true
			}
		} catch {
			/* not JSON — parse as-is */
		}
	}
	const fnWrap = firstLine.match(/^<function=([^>]+)>/i)
	if (fnWrap) {
		firstLine = fnWrap[1].trim()
		structuredAnswer = true
	}

	/**
	 * The model named someone who exists but isn't on the menu (rotation-hidden),
	 * or asked for a DM beat the DM can't have. It clearly wants SOMEONE to act —
	 * honoring that intent with the most overdue eligible entry keeps the scene
	 * moving; mapping it to WAIT (the old behavior) turned every anchored pick
	 * into a DM narration beat and drowned the table.
	 */
	const substitute = (wantedLabel: string): OrchestratorDecision => {
		const fallback = pickMostOverdue(players, pressure)
		if (fallback) {
			console.log(
				`FoundryAI | orchestrator named "${wantedLabel}" (not on the menu) — substituting most-overdue "${fallback.actorName || fallback.name}".`,
			)
			return { type: 'actor', player: fallback }
		}
		if (dmEligible) {
			console.log(`FoundryAI | orchestrator named "${wantedLabel}" (not on the menu) — no eligible player, substituting DM.`)
			return { type: 'dm' }
		}
		return { type: 'wait' }
	}

	const matchPlayer = (pool: AIPlayerConfig[], wanted: string): AIPlayerConfig | undefined =>
		pool.find(p => (p.actorName || p.name).trim().toLowerCase() === wanted) ??
		pool.find(p => {
			const name = (p.actorName || p.name).trim().toLowerCase()
			return name.includes(wanted) || wanted.includes(name)
		})

	if (/^(the )?(dm|dungeon master|narrator)\b/i.test(firstLine)) {
		return dmEligible ? { type: 'dm' } : substitute('DM')
	}
	if (/^WAIT\b/i.test(firstLine)) return { type: 'wait' }

	// Accept "ACTOR: Name", "NEXT: Name", or a bare name on the first line.
	const prefixMatch = firstLine.match(/^(?:ACTOR|NEXT)\s*:\s*(.+)$/i)
	const wanted = (prefixMatch ? prefixMatch[1] : firstLine).trim().toLowerCase()
	if (!wanted) return { type: 'wait' }

	// Models conflate the answer formats ("ACTOR: DM", "ACTOR: WAIT") — honor intent.
	if (/^(the )?(dm|dungeon master|narrator)$/.test(wanted)) {
		return dmEligible ? { type: 'dm' } : substitute('DM')
	}
	if (/^(wait|nobody|no ?one|none)$/.test(wanted)) return { type: 'wait' }

	const eligible = matchPlayer(players, wanted)
	if (eligible) return { type: 'actor', player: eligible }

	// Named a real character who is rotation-hidden → substitute, don't stall.
	const hidden = matchPlayer(allEnabled, wanted)
	if (hidden) return substitute(hidden.actorName || hidden.name)

	// Only for prefixed/structured answers do we treat an unmatched name as
	// "wanted a player" and substitute: the model explicitly picked SOMEONE.
	// A bare unparseable line could be anything, so wait is safer there.
	if (prefixMatch || structuredAnswer) return substitute(prefixMatch ? prefixMatch[1].trim() : wanted)
	return { type: 'wait' }
}

// ---- AI player turn ----

async function runPlayerTurn(player: AIPlayerConfig, recentChat: string): Promise<void> {
	const providers = (getSetting('apiProviders') || []) as ApiProvider[]
	const provider = providers.find(p => p.id === player.providerId)
	if (!provider) {
		console.warn(`FoundryAI | AI player "${player.name}" has no valid provider configured — skipping.`)
		return
	}

	const systemPrompt = buildPlayerTurnPrompt(player)
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
			max_tokens: TURN_MAX_TOKENS,
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
		// budget instead of following "output only the line(s), or the sentinel."
		console.warn(
			`FoundryAI | AI player "${player.name}" produced no content (finish_reason: ${finishReason ?? 'unknown'}) — likely ran out of tokens rather than having nothing to say.`,
		)
		return
	}

	if (isSentinel(finalRaw, PASS_SENTINEL)) {
		console.log(`FoundryAI | AI player "${player.name}" was called on but chose not to respond.`)
		return
	}

	if (looksLikeLeakedToolCallOrMeta(finalRaw)) {
		// The shared recoverLeakedToolCalls in openrouter-service.ts already converts most leaked
		// tool-call syntax into real tool_calls before we ever see it — this is a last-resort net
		// for anything that slips through (or a model narrating *about* calling a tool instead of
		// actually calling it), so it never gets posted to chat looking like the character said it.
		console.warn(
			`FoundryAI | AI player "${player.name}" produced tool-call-looking or meta text instead of dialogue — discarding: ${finalRaw.slice(0, 200)}`,
		)
		return
	}

	await postAsPlayer(player, finalRaw)
}

function buildPlayerTurnPrompt(player: AIPlayerConfig): string {
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
	return `${persona}${extra}\n\n${PLAYER_TURN_INSTRUCTIONS}`
}

/**
 * Bare JSON, text narrating ABOUT calling a function, or — the more common failure
 * with smaller/local models — the model narrating ABOUT writing its reply instead of
 * just writing it ("Since Kale needs to react, I will write...", numbered lists of
 * options, self-captioned "Kale: ..." speaker labels, or the same paragraph repeated
 * several times in a loop). None of that is in-character dialogue and none of it
 * should ever reach the table, so this is checked before every post.
 */
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

	if (/\b(call (another |the )?function|function call|tool.?call)\b/i.test(trimmed)) return true

	// The model narrating about the act of replying instead of just replying.
	if (
		/\b(we need to reply as|since you need to|your thought process|let'?s craft|i will add something|the decision is yours|make your choice|as (the )?(dm|dungeon master|narrator))\b/i.test(
			trimmed,
		)
	) {
		return true
	}

	// A numbered list of 2+ options ("1. Cast a spell ... 2. Try to ...") is the DM
	// presenting choices, not a single character's own line.
	if (/\b1\.\s[\s\S]{5,80}?\b2\.\s/.test(trimmed)) return true

	// The character captioning their own line with a speaker label ("Kale: ...")
	// more than once — a script-format leak, not natural first-person dialogue.
	const speakerLabelMatches = trimmed.match(/\b[A-Z][a-z]+:\s/g)
	if (speakerLabelMatches && speakerLabelMatches.length >= 2) return true

	// The same chunk of text repeated verbatim — a local-model repetition loop, not a real reply.
	if (hasRepeatedChunk(trimmed)) return true

	return false
}

/** True if any 60-char window of the text recurs verbatim elsewhere in it — a cheap repetition-loop detector. */
function hasRepeatedChunk(text: string, chunkLen = 60): boolean {
	if (text.length < chunkLen * 2) return false
	const seen = new Set<string>()
	for (let i = 0; i + chunkLen <= text.length; i += chunkLen) {
		const chunk = text.slice(i, i + chunkLen)
		if (seen.has(chunk)) return true
		seen.add(chunk)
	}
	return false
}

async function postAsPlayer(player: AIPlayerConfig, content: string): Promise<void> {
	const actor = game.actors?.get(player.actorId)
	const speaker = actor ? ChatMessage.getSpeaker({ actor }) : { alias: player.name }
	const playerFlags: Record<string, unknown> = { aiPlayerId: player.id, automated: true }
	if (player.ttsVoice) playerFlags.ttsVoice = player.ttsVoice

	await ChatMessage.create({
		content,
		speaker,
		flags: { [MODULE_ID]: playerFlags },
	})
	if (player.autoSpeak) {
		void queueTTS(content, { voice: player.ttsVoice }).catch((error) => {
			console.error(`FoundryAI | Auto-speak failed for AI player "${player.actorName || player.name}":`, error)
		})
	}

	console.log(`FoundryAI | AI player "${player.actorName || player.name}" spoke up.`)
}

/** Resolve the tool list available to AI players — respects the global "Enable Tool Calling" setting. */
function getPlayerToolset(): ToolDefinition[] {
	if (!getSetting('enableTools')) return []
	return PLAYER_JOURNAL_TOOLS
}

/** Dispatch a player tool call. ONLY the journal pair exists — nothing routes
 *  to the shared executor, so a hallucinated tool name can't become a world
 *  search. The error names what's actually available. */
async function executePlayerTool(player: AIPlayerConfig, call: ToolCall): Promise<string> {
	const name = call.function.name
	if (name === 'read_my_journal' || name === 'write_my_journal') {
		return await executeJournalTool(player, name, call.function.arguments)
	}
	// Old configs / stubborn models may still try the previous tool names.
	if (name === 'read_my_notes') return await executeJournalTool(player, 'read_my_journal', call.function.arguments)
	if (name === 'write_my_notes') return await executeJournalTool(player, 'write_my_journal', call.function.arguments)
	return JSON.stringify({
		error: `You don't have a tool called "${name}". Your only tools are read_my_journal and write_my_journal — your character's own journal.`,
	})
}

// ---- Autonomous DM narration ----

/** Returns true if a narration beat was actually posted, false on a pass/discard. */
async function runAutonomousDMNarration(recentChat: string, automated = true): Promise<boolean> {
	if (!openRouterService.isConfigured) {
		console.warn('FoundryAI | Autonomous DM narration: no API provider configured — skipping.')
		return false
	}

	const model = getSetting('chatModel')
	if (!model) return false

	const basePrompt = buildSystemPrompt({ includeTools: false, includeFormatting: false })
	const systemPrompt = `${basePrompt}\n\n${DM_NARRATION_INSTRUCTIONS}`
	const tools = getSetting('enableTools') ? getToolsByNames(DM_LOOKUP_TOOL_NAMES) : []

	const messages: LLMMessage[] = [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: `## Recent Chat\n${recentChat}` },
	]

	let finalRaw = ''

	for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
		const response = await openRouterService.chatCompletion({
			model,
			messages,
			tools: tools.length ? tools : undefined,
			temperature: getSetting('temperature') ?? 0.8,
			max_tokens: TURN_MAX_TOKENS,
		})

		const choice = response.choices?.[0]
		const message = choice?.message

		// Lookup rounds: execute journal reads and let the model continue.
		if (message?.tool_calls?.length && round < MAX_TOOL_ROUNDS) {
			messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls })
			for (const call of message.tool_calls) {
				let result: string
				try {
					result = await executeTool(call)
				} catch (e: any) {
					result = JSON.stringify({ error: e?.message || 'Tool execution failed' })
				}
				messages.push({ role: 'tool', content: result, tool_call_id: call.id })
			}
			continue
		}

		finalRaw = (message?.content ?? '').trim()

		// If the service fell back to a tools-free retry, the in-fiction notice was
		// prepended for chat-window display — it isn't narration, strip it.
		if (response._toolsFallback && finalRaw.startsWith(TOOLS_UNSUPPORTED_NOTICE.trim())) {
			finalRaw = finalRaw.slice(TOOLS_UNSUPPORTED_NOTICE.trim().length).trim()
		}
		break
	}

	if (!finalRaw || isSentinel(finalRaw, 'WAIT')) {
		console.log('FoundryAI | Autonomous DM: decided not to narrate this round.')
		return false
	}
	if (looksLikeLeakedToolCallOrMeta(finalRaw)) {
		console.warn(`FoundryAI | Autonomous DM: produced meta/non-narration text — discarding: ${finalRaw.slice(0, 200)}`)
		return false
	}

	const flags: Record<string, unknown> = automated
		? { automated: true, autonomousDM: true }
		: { manualDMBeat: true }

	await ChatMessage.create({
		content: finalRaw,
		flags: { [MODULE_ID]: flags },
	})
	console.log(`FoundryAI | ${automated ? 'Autonomous' : 'Manual'} DM: posted a narration beat.`)
	return true
}

/**
 * Tolerant sentinel match: models rarely emit a bare sentinel — they wrap it in
 * quotes, asterisks, or punctuation ("NO_RESPONSE.", *WAIT*). Exact equality
 * misses those and the wrapper text would get posted to the table as dialogue.
 */
function isSentinel(text: string, sentinel: string): boolean {
	return new RegExp(`^["'\`*\\s]*${sentinel}["'\`*.!\\s]*$`, 'i').test(text.trim())
}

// ---- Manual DM beat ----

/**
 * GM-triggered "read the table and respond" — one autonomous-DM narration
 * turn on demand. It shares the autonomous-DM's canon and safety rules but
 * its resulting chat message is deliberately treated as a manual GM action:
 * it is not marked automated, so it can wake the AI-player orchestrator.
 */
export async function triggerDMBeat(): Promise<void> {
	if (!game.user?.isGM) return
	if (turnsInFlight.has(DM_TURN_KEY)) {
		ui.notifications?.warn('FoundryAI: the DM is already composing a beat.')
		return
	}

	const recentChat = getRecentChatLines(CONTEXT_MESSAGE_LIMIT)
	if (!recentChat) {
		ui.notifications?.warn('FoundryAI: no table chat to respond to yet.')
		return
	}

	console.log(`${TRACE} manual DM beat requested by GM.`)
	turnsInFlight.add(DM_TURN_KEY)
	try {
		const posted = await runAutonomousDMNarration(recentChat, false)
		if (!posted) {
			ui.notifications?.info('FoundryAI: the DM read the scene and chose not to add anything.')
		}
	} catch (e: any) {
		console.error('FoundryAI | manual DM beat failed:', e)
		ui.notifications?.error(`FoundryAI: DM beat failed — ${e?.message || e}`)
	} finally {
		turnsInFlight.delete(DM_TURN_KEY)
	}
}

// ---- GM ↔ Player Interview ("Table Talk") ----

const INTERVIEW_INSTRUCTIONS = `## Table Talk — Private Side Chat With Your GM
The GM has pulled you aside for a one-on-one conversation. This is NOT the table chat — nothing said here is heard by the other characters, and your replies are not posted anywhere. Speak plainly and conversationally.
- Stay in character, but with an actor's self-awareness: if the GM asks why you did something, explain your reasoning honestly as the character. You may discuss your own decisions candidly.
- Your journal tools work here (read_my_journal / write_my_journal). If this conversation produces anything worth remembering at the table — guidance from the GM, a decision, a correction, a promise, a plan — WRITE IT IN YOUR JOURNAL so future-you acts on it. If the GM explicitly asks you to remember something, ALWAYS write it down.
- The recent table chat is included below so you know exactly where things stand in the game.`

/**
 * One turn of a private GM↔player conversation (the "Table Talk" window).
 * Same persona, same provider/model, same journal-only toolset, and the same
 * recent-chat context the player's table turns see — so "why did you just do
 * that?" is answerable, and anything worth keeping can be written to their
 * journal where their future table turns will find it. Output is returned to
 * the interview window only; nothing is posted to the table.
 */
export async function runPlayerInterviewTurn(player: AIPlayerConfig, conversation: LLMMessage[]): Promise<string> {
	const providers = (getSetting('apiProviders') || []) as ApiProvider[]
	const provider = providers.find(p => p.id === player.providerId)
	if (!provider) {
		return '(This player has no valid API provider configured — pick one in the AI Players window and save.)'
	}

	const persona = buildActorRoleplayPrompt(
		{ actorId: player.actorId, actorName: player.actorName || player.name },
		{ includeTools: false, includeFormatting: false },
	)
	const extra = player.systemPromptOverride?.trim()
		? `\n\n## Additional Direction\n${player.systemPromptOverride.trim()}`
		: ''
	const recentChat = getRecentChatLines(CONTEXT_MESSAGE_LIMIT)
	const systemPrompt = `${persona}${extra}\n\n${INTERVIEW_INSTRUCTIONS}\n\n## Recent Table Chat\n${recentChat || '(the table has been quiet)'}`

	const tools = getPlayerToolset()
	const messages: LLMMessage[] = [{ role: 'system', content: systemPrompt }, ...conversation]

	for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
		const response = await openRouterService.chatCompletion({
			model: player.model,
			provider: { baseUrl: provider.baseUrl, apiKey: provider.apiKey },
			messages,
			tools: tools.length ? tools : undefined,
			temperature: 0.85,
			max_tokens: TURN_MAX_TOKENS,
		})

		const message = response.choices?.[0]?.message

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

		return (message?.content ?? '').trim() || '(no response — the model returned empty content)'
	}

	return '(no response — ran out of tool rounds)'
}

// ---- Personal Notes Journal ----

/**
 * Resolve this player's designated journal: the GM-assigned one (journalId) if
 * set and still existing, otherwise their auto-created private journal inside
 * FoundryAI/Players (created on first use).
 */
async function resolvePlayerJournal(player: AIPlayerConfig): Promise<JournalEntry | null> {
	if (player.journalId) {
		const assigned = game.journal?.get(player.journalId)
		if (assigned) return assigned
		console.warn(
			`FoundryAI | ai-player-runtime: assigned journal ${player.journalId} for "${player.name}" no longer exists — falling back to their private journal.`,
		)
	}

	const folderId = getSubfolderId('players')
	if (!folderId) {
		console.warn('FoundryAI | ai-player-runtime: Players folder not ready yet — cannot access journal.')
		return null
	}

	const existing = game.journal?.find((j: any) => j.getFlag?.(MODULE_ID, 'aiPlayerId') === player.id)
	if (existing) return existing

	const journal = await JournalEntry.create({
		name: `${player.actorName || player.name} — Journal`,
		folder: folderId,
		pages: [{ name: PLAYER_WRITE_PAGE_NAME, type: 'text', text: { content: '', format: 1 } }],
		flags: { [MODULE_ID]: { aiPlayerId: player.id } },
	})

	console.log(`FoundryAI | Created private journal for "${player.name}" (${journal.id})`)
	return journal
}

async function executeJournalTool(player: AIPlayerConfig, toolName: string, argsJson: string): Promise<string> {
	const journal = await resolvePlayerJournal(player)
	if (!journal) return JSON.stringify({ error: 'Could not access your journal.' })

	if (toolName === 'read_my_journal') {
		// Read EVERY text page — a GM-assigned journal may hold multiple lore
		// pages plus the character's own notes page.
		const pages: any[] = (journal.pages as any)?.contents ?? []
		const parts: string[] = []
		for (const page of pages) {
			if (page.type !== 'text') continue
			const text = stripHtml(page.text?.content || '')
			if (!text) continue
			parts.push(pages.length > 1 ? `## ${page.name}\n${text}` : text)
		}

		let content = parts.join('\n\n')
		let truncated = false
		if (content.length > PLAYER_JOURNAL_READ_MAX) {
			content = content.slice(0, PLAYER_JOURNAL_READ_MAX)
			truncated = true
		}
		return JSON.stringify({
			journal: journal.name,
			content: content || '(nothing written yet)',
			...(truncated ? { truncated: true, note: 'Journal too long to show in full.' } : {}),
		})
	}

	// write_my_journal — appends to the character's own page, never a GM lore page.
	let args: { content?: string } = {}
	try {
		args = JSON.parse(argsJson)
	} catch {
		/* fall through with empty args */
	}
	const note = (args.content || '').trim()
	if (!note) return JSON.stringify({ error: 'No content provided.' })

	const pages: any[] = (journal.pages as any)?.contents ?? []
	let page = pages.find((p) => p.type === 'text' && p.name === PLAYER_WRITE_PAGE_NAME)
	if (!page) {
		const created = await (journal as any).createEmbeddedDocuments('JournalEntryPage', [
			{ name: PLAYER_WRITE_PAGE_NAME, type: 'text', text: { content: '', format: 1 } },
		])
		page = created?.[0]
	}
	if (!page) return JSON.stringify({ error: 'Could not find or create your notes page.' })

	const existing = page.text?.content || ''
	const timestamp = new Date().toLocaleString()
	const entry = `<p><em>${timestamp}</em> — ${note}</p>`
	const updated = existing ? `${existing}\n${entry}` : entry

	await page.update({ text: { content: updated } })
	return JSON.stringify({ success: true, message: 'Written in your journal.' })
}

// ---- Chat log helpers ----

function getRecentChatLines(limit: number): string {
	const all = game.messages?.contents ?? []
	const lines: string[] = []

	// Walk backwards collecting up to `limit` usable lines, so filtered-out
	// messages (whispers etc.) don't shrink the context window.
	for (let i = all.length - 1; i >= 0 && lines.length < limit; i--) {
		const m = all[i]

		// SECURITY: this runs on the GM client, which sees everything — whispers,
		// GM-only rolls, blind messages. None of that may reach AI player or
		// orchestrator prompts, or an AI character can "know" (and blurt out)
		// secrets the DM whispered to someone else.
		if (((m as any).whisper?.length ?? 0) > 0) continue
		if ((m as any).blind) continue

		const text = stripHtml(m.content || '').trim()
		if (!text) continue
		lines.unshift(`${resolveSpeakerName(m)}: ${text}`)
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
