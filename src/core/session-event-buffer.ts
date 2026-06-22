/* ==========================================================================
   Session Event Buffer
   In-memory ring of game events (combat, damage, scenes, conditions).
   Persisted to a world setting so it survives page reloads mid-session.
   Events are injected into recap prompts — no AI calls happen here.
   ========================================================================== */

const MODULE_ID = 'foundry-ai'
const PERSIST_DEBOUNCE_MS = 2000

export type SessionEventType =
	| 'combat-start'
	| 'combat-end'
	| 'combat-round'
	| 'damage'
	| 'condition'
	| 'death'
	| 'scene-change'
	| 'level-up'
	| 'loot'
	| 'note'

export interface SessionEvent {
	type: SessionEventType
	timestamp: number
	summary: string
	actors?: string[]
	data?: Record<string, any>
}

class SessionEventBuffer {
	private events: SessionEvent[] = []
	private sessionStart: number = Date.now()
	private persistTimer: ReturnType<typeof setTimeout> | null = null

	/** Load persisted events from the world setting (call once on ready). */
	load(): void {
		try {
			const raw = game.settings.get(MODULE_ID, 'sessionEvents') as string
			const parsed = JSON.parse(raw || '[]')
			if (Array.isArray(parsed)) {
				this.events = parsed
				console.debug(`FoundryAI | session-event-buffer: loaded ${this.events.length} persisted events`)
			}
		} catch {
			this.events = []
		}
	}

	/** Record a game event. Cheap + synchronous; persist is debounced. */
	record(event: SessionEvent): void {
		this.events.push(event)
		this.schedulePersist()
	}

	/** All events since session start, in chronological order. */
	getEvents(): SessionEvent[] {
		return [...this.events]
	}

	/** Plain-text timeline suitable for injection into a recap prompt. */
	getFormattedTimeline(): string {
		if (this.events.length === 0) return ''
		return this.events
			.map(e => {
				const time = new Date(e.timestamp).toLocaleTimeString()
				return `[${time}] ${e.summary}`
			})
			.join('\n')
	}

	/** Clear the buffer (call after a recap is saved, or when starting a new session). */
	clear(): void {
		this.events = []
		this.sessionStart = Date.now()
		this.schedulePersist()
	}

	private schedulePersist(): void {
		if (this.persistTimer !== null) clearTimeout(this.persistTimer)
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null
			game.settings
				.set(MODULE_ID, 'sessionEvents', JSON.stringify(this.events))
				.catch(e => console.warn('FoundryAI | session-event-buffer: persist failed', e))
		}, PERSIST_DEBOUNCE_MS)
	}
}

export const sessionEventBuffer = new SessionEventBuffer()
