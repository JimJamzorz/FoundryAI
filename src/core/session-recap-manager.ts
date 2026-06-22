/* ==========================================================================
   Session Recap Manager
   Generates AI-written polished session summaries and stores them as
   JournalEntry documents in a dedicated "Session Recaps" folder.
   ========================================================================== */

import { openRouterService, type LLMMessage } from './openrouter-service'
import { chatSessionManager } from './chat-session-manager'
import { collectionReader } from './collection-reader'
import { getSubfolderId } from './folder-manager'
import { sessionEventBuffer } from './session-event-buffer'

const MODULE_ID = 'foundry-ai'
const RECAP_FOLDER_NAME = 'Sessions'

export interface SessionRecap {
	id: string // JournalEntry document ID
	name: string // "Session Recap – <date>"
	sessionDate: number // Epoch ms
	chatSessionIds: string[] // IDs of chat sessions used to generate this recap
	model: string // Model used for generation
}

export interface RecapProgress {
	phase: 'preparing' | 'generating' | 'saving' | 'complete' | 'error'
	message: string
}

export type RecapProgressCallback = (progress: RecapProgress) => void

class SessionRecapManager {
	private folderCache: string | null = null

	/** Get or create the session recaps folder */
	async getRecapFolder(): Promise<any> {
		// Check settings for configured folder
		const configuredFolderId = this.getConfiguredFolderId()
		if (configuredFolderId) {
			const folder = game.folders?.get(configuredFolderId)
			if (folder) return folder
		}

		// Use the FoundryAI/Sessions subfolder
		const subfolderId = getSubfolderId('sessions')
		if (subfolderId) {
			const folder = game.folders?.get(subfolderId)
			if (folder) return folder
		}

		// Check cache
		if (this.folderCache) {
			const cached = game.folders?.get(this.folderCache)
			if (cached) return cached
		}

		// Find existing (legacy fallback)
		const existing = game.folders?.find((f: Folder) => f.name === RECAP_FOLDER_NAME && f.type === 'JournalEntry')

		if (existing) {
			this.folderCache = existing.id
			return existing
		}

		// Create
		const folder = await Folder.create({
			name: RECAP_FOLDER_NAME,
			type: 'JournalEntry',
			color: '#2e7d32',
		})

		this.folderCache = folder.id
		return folder
	}

	/**
	 * Generate a session recap from one or more chat sessions.
	 * The AI reads the chat logs and produces a polished narrative summary.
	 */
	async generateRecap(
		chatSessionIds: string[],
		model: string,
		onProgress?: RecapProgressCallback,
	): Promise<SessionRecap> {
		onProgress?.({ phase: 'preparing', message: 'Gathering chat session data...' })

		// Collect all messages from the specified sessions
		const allConversations: string[] = []

		for (const sessionId of chatSessionIds) {
			const session = chatSessionManager.loadSession(sessionId)
			if (!session) continue

			const formatted = session.messages
				.filter((m) => m.role !== 'system')
				.map((m) => {
					const role = m.role === 'user' ? 'DM' : m.role === 'assistant' ? 'AI Assistant' : m.role
					return `[${role}]: ${typeof m.content === 'string' ? m.content : ''}`
				})
				.join('\n\n')

			allConversations.push(`--- Session: ${session.name} ---\n${formatted}`)
		}

		const eventTimeline = sessionEventBuffer.getFormattedTimeline()

		if (allConversations.length === 0 && !eventTimeline) {
			throw new Error('No valid chat sessions found to recap.')
		}

		// Get current scene info for additional context
		let sceneContext = ''
		try {
			sceneContext = collectionReader.getCurrentSceneInfo()
		} catch {
			/* ignore */
		}

		onProgress?.({ phase: 'generating', message: 'AI is writing the session recap...' })

		const timelineSection = eventTimeline
			? `Session Event Timeline (what happened at the table):\n${eventTimeline}\n\n`
			: ''
		const chatSection = allConversations.length > 0 ? allConversations.join('\n\n') : ''

		// Build the recap prompt
		const messages: LLMMessage[] = [
			{
				role: 'system',
				content: RECAP_SYSTEM_PROMPT,
			},
			{
				role: 'user',
				content: `Here are the chat sessions from today's game session. Please write a polished session recap.\n\n${sceneContext ? `Current Scene Context:\n${sceneContext}\n\n` : ''}${timelineSection}${chatSection}`,
			},
		]

		// Generate the recap
		const response = await openRouterService.chatCompletion({
			model,
			messages,
			temperature: 0.7,
			max_tokens: 4000,
		})

		const recapContent = response.choices?.[0]?.message?.content || 'Failed to generate recap.'

		onProgress?.({ phase: 'saving', message: 'Saving session recap...' })

		// Save as journal entry
		const folder = await this.getRecapFolder()
		const now = Date.now()
		const dateStr = new Date(now).toLocaleDateString('en-US', {
			weekday: 'long',
			year: 'numeric',
			month: 'long',
			day: 'numeric',
		})
		const title = `Session Recap — ${dateStr}`

		// Build rich HTML content
		const htmlContent = this.formatRecapHtml(recapContent, dateStr, chatSessionIds)

		const journal = await JournalEntry.create({
			name: title,
			folder: folder.id,
			pages: [
				{
					name: 'Recap',
					type: 'text',
					text: { content: htmlContent, format: 1 },
				},
			],
			flags: {
				[MODULE_ID]: {
					type: 'session-recap',
					sessionDate: now,
					chatSessionIds,
					model,
				},
			},
		})

		onProgress?.({ phase: 'complete', message: 'Session recap saved!' })

		// Clear the event buffer now that events are captured in the recap
		sessionEventBuffer.clear()

		return {
			id: journal.id,
			name: title,
			sessionDate: now,
			chatSessionIds,
			model,
		}
	}

	/**
	 * Generate a quick recap from manual notes (no chat sessions needed).
	 */
	async generateFromNotes(notes: string, model: string, onProgress?: RecapProgressCallback): Promise<SessionRecap> {
		onProgress?.({ phase: 'generating', message: 'AI is writing the session recap...' })

		const messages: LLMMessage[] = [
			{ role: 'system', content: RECAP_SYSTEM_PROMPT },
			{
				role: 'user',
				content: `Here are my notes from today's session. Please write a polished session recap:\n\n${notes}`,
			},
		]

		const response = await openRouterService.chatCompletion({
			model,
			messages,
			temperature: 0.7,
			max_tokens: 4000,
		})

		const recapContent = response.choices?.[0]?.message?.content || 'Failed to generate recap.'

		onProgress?.({ phase: 'saving', message: 'Saving session recap...' })

		const folder = await this.getRecapFolder()
		const now = Date.now()
		const dateStr = new Date(now).toLocaleDateString('en-US', {
			weekday: 'long',
			year: 'numeric',
			month: 'long',
			day: 'numeric',
		})
		const title = `Session Recap — ${dateStr}`

		const htmlContent = this.formatRecapHtml(recapContent, dateStr, [])

		const journal = await JournalEntry.create({
			name: title,
			folder: folder.id,
			pages: [
				{
					name: 'Recap',
					type: 'text',
					text: { content: htmlContent, format: 1 },
				},
			],
			flags: {
				[MODULE_ID]: {
					type: 'session-recap',
					sessionDate: now,
					chatSessionIds: [],
					model,
				},
			},
		})

		onProgress?.({ phase: 'complete', message: 'Session recap saved!' })

		return {
			id: journal.id,
			name: title,
			sessionDate: now,
			chatSessionIds: [],
			model,
		}
	}

	/** List all session recaps (most recent first) */
	listRecaps(): SessionRecap[] {
		if (!game.journal) return []

		const recaps: SessionRecap[] = []

		for (const entry of game.journal.values()) {
			const flags = entry.flags?.[MODULE_ID] as Record<string, any>
			if (!flags || flags.type !== 'session-recap') continue

			recaps.push({
				id: entry.id,
				name: entry.name,
				sessionDate: flags.sessionDate || 0,
				chatSessionIds: flags.chatSessionIds || [],
				model: flags.model || '',
			})
		}

		recaps.sort((a, b) => b.sessionDate - a.sessionDate)
		return recaps
	}

	/** Delete a session recap */
	async deleteRecap(recapId: string): Promise<void> {
		const entry = game.journal?.get(recapId)
		if (!entry) throw new Error(`Session recap not found: ${recapId}`)
		await entry.delete()
	}

	// ---- Private Helpers ----

	private getConfiguredFolderId(): string | null {
		try {
			return (game.settings?.get(MODULE_ID, 'sessionRecapFolder') as string) || null
		} catch {
			return null
		}
	}

	private formatRecapHtml(markdownContent: string, dateStr: string, sessionIds: string[]): string {
		// Convert markdown-ish content to HTML
		let html = markdownContent
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			// Headers
			.replace(/^### (.+)$/gm, '<h3>$1</h3>')
			.replace(/^## (.+)$/gm, '<h2>$1</h2>')
			.replace(/^# (.+)$/gm, '<h1>$1</h1>')
			// Bold/italic
			.replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
			.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
			.replace(/\*(.*?)\*/g, '<em>$1</em>')
			// Lists
			.replace(/^- (.+)$/gm, '<li>$1</li>')
			.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
			// Horizontal rules
			.replace(/^---$/gm, '<hr>')
			// Line breaks
			.replace(/\n\n/g, '</p><p>')
			.replace(/\n/g, '<br>')

		// Wrap in styled container
		return `
<div style="font-family: 'Signika', serif;">
  <div style="text-align:center; margin-bottom:1em; padding-bottom:0.5em; border-bottom:2px solid #7b2d26;">
    <h1 style="color:#7b2d26; margin:0;">📜 Session Recap</h1>
    <p style="color:#666; font-style:italic; margin:0.25em 0 0 0;">${dateStr}</p>
  </div>
  <div style="line-height:1.6;">
    <p>${html}</p>
  </div>
  ${sessionIds.length > 0 ? `<hr><p style="font-size:0.8em; color:#888;">Generated from ${sessionIds.length} chat session(s) by FoundryAI</p>` : ''}
</div>`.trim()
	}
}

// ---- Recap System Prompt ----

const RECAP_SYSTEM_PROMPT = `You are a skilled fantasy chronicler writing a session recap for a tabletop RPG game (likely D&D 5e or similar). Your task is to transform raw chat logs or notes into a polished, engaging narrative summary.

Guidelines:
- Write in past tense, third person
- Organize with clear sections: a brief "Previously" reminder, the main events, notable encounters, key NPC interactions, and any cliffhangers
- Use evocative, descriptive language fitting a fantasy setting
- Include specific details: character names, locations, items found, decisions made
- Note any important mechanical outcomes (difficult battles, critical rolls mentioned, etc.)
- Keep the tone matching the gravity of events — dramatic for tense moments, lighter for comedy
- End with a "Looking Ahead" section hinting at unresolved threads
- Use markdown formatting with ## headers for sections
- Aim for 500-1500 words depending on session length
- If the session was short, keep the recap proportionally brief
- Do NOT invent events that didn't happen — stick to what's in the source material`

export const sessionRecapManager = new SessionRecapManager()
