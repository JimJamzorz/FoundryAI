/* ===========================================================================
   TTS Service
   Queues speech playback so AI-player turns do not interrupt each other.
   =========================================================================== */

import { openRouterService } from './openrouter-service'
import { getSetting } from '../settings'

export interface TTSOptions {
	voice?: string
	button?: HTMLElement
}

interface TTSQueueItem {
	text: string
	options: TTSOptions
	resolve: () => void
	reject: (error: unknown) => void
}

let currentAudio: HTMLAudioElement | null = null
let currentButton: HTMLElement | null = null
let currentCleanup: (() => void) | null = null
let processingQueue = false
let playbackGeneration = 0
const queue: TTSQueueItem[] = []

/** Remove Foundry markup and dice syntax while preserving natural pauses. */
export function cleanTextForSpeech(input: string): string {
	const html = document.createElement('div')
	html.innerHTML = input

	// UI controls, source snippets, and visible dice markup are useful at the
	// table but make terrible narration. Remove them before extracting text.
	html.querySelectorAll('script, style, button, .message-metadata, .dice-tooltip, .dice-roll').forEach(element => element.remove())
	for (const element of Array.from(html.querySelectorAll('br, hr'))) element.replaceWith('. ')
	for (const element of Array.from(html.querySelectorAll('p, div, li, blockquote, h1, h2, h3, h4, h5, h6, tr'))) element.append('. ')

	return (html.textContent || input)
		.replace(/@UUID\[[^\]]+\]\{([^}]+)\}/g, '$1')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/\[\[\s*[^\]]+\s*\]\]/g, '')
		.replace(/@(?:Check|Skill|Save|Template|Item)\[[^\]]+\](?:\{[^}]+\})?/g, '')
		.replace(/(`{1,3}|\*{1,3}|_{1,3}|~{2})/g, '')
		.replace(/\.{4,}/g, '...')
		.replace(/\s*—\s*/g, ', ')
		.replace(/\s+/g, ' ')
		.replace(/\s+([,.!?;:])/g, '$1')
		.trim()
}

/** Add speech to the end of the playback queue. */
export function queueTTS(text: string, options: TTSOptions = {}): Promise<void> {
	const cleanText = cleanTextForSpeech(text)
	if (!cleanText) return Promise.resolve()

	return new Promise((resolve, reject) => {
		queue.push({ text: cleanText, options, resolve, reject })
		void processQueue()
	})
}

/**
 * Play a user-requested item immediately, clearing any queued automatic lines.
 * Clicking its active button again stops all playback.
 */
export function playTTS(text: string, button: HTMLElement, preferredVoice?: string): Promise<void> {
	if (currentButton === button && currentAudio && !currentAudio.paused) {
		stopTTS()
		return Promise.resolve()
	}

	stopTTS()
	return queueTTS(text, { button, voice: preferredVoice })
}

async function processQueue(): Promise<void> {
	if (processingQueue) return
	processingQueue = true

	try {
		while (queue.length > 0) {
			const item = queue.shift()!
			const generation = playbackGeneration
			const { button, voice } = item.options
			if (button) button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'

			try {
				const model = getSetting('ttsModel') || 'openai/gpt-4o-mini-tts'
				const selectedVoice = voice || getSetting('ttsVoice') || 'nova'
				const configuredSpeed = Number(getSetting('ttsSpeed'))
				const speed = Number.isFinite(configuredSpeed) ? Math.min(2, Math.max(0.5, configuredSpeed)) : 1
				const audioBuffer = await openRouterService.generateSpeech(item.text, selectedVoice, model, speed)
				if (generation !== playbackGeneration) {
					item.resolve()
					continue
				}

				const url = URL.createObjectURL(new Blob([audioBuffer], { type: 'audio/wav' }))
				const audio = new Audio(url)
				currentAudio = audio
				currentButton = button || null
				if (button) button.innerHTML = '<i class="fas fa-stop"></i>'

				await new Promise<void>((resolve, reject) => {
					let finished = false
					const finish = (error?: unknown) => {
						if (finished) return
						finished = true
						URL.revokeObjectURL(url)
						if (button) button.innerHTML = '<i class="fas fa-volume-up"></i>'
						if (currentAudio === audio) {
							currentAudio = null
							currentButton = null
							currentCleanup = null
						}
						error ? reject(error) : resolve()
					}
					currentCleanup = () => finish()
					audio.onended = () => finish()
					audio.onerror = () => finish(new Error('Audio playback failed'))
					audio.play().catch(finish)
				})
				item.resolve()
			} catch (error) {
				if (button) button.innerHTML = '<i class="fas fa-volume-up"></i>'
				console.error('FoundryAI | TTS playback failed:', error)
				item.reject(error)
			}
		}
	} finally {
		processingQueue = false
	}
}

/** Stop the current line and discard all automatic queued lines. */
export function stopTTS(): void {
	playbackGeneration++
	queue.splice(0).forEach(item => item.resolve())
	if (currentAudio) {
		currentAudio.pause()
		currentAudio.currentTime = 0
		currentCleanup?.()
	}
}
