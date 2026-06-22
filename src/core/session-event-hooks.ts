/* ==========================================================================
   Session Event Hooks
   Registers Foundry hooks that translate table events into session buffer
   entries. All work here is cheap + synchronous — no AI/network calls.
   Only the GM client records events to avoid duplicate entries.

   Hook names verified against Foundry v13 API:
     combatStart(combat, updateData)
     combatRound(combat, updateData, options, userId)
     deleteCombat(combat, options, userId)
     updateActor(actor, changes, options, userId)
     createActiveEffect(effect, options, userId)
     deleteActiveEffect(effect, options, userId)
     canvasReady(canvas)
   ========================================================================== */

import { sessionEventBuffer } from './session-event-buffer'
import { getSetting } from '../settings'

/** Debounce timers for HP events, keyed by actor name. Prevents burst spam. */
const pendingHpEvents = new Map<string, ReturnType<typeof setTimeout>>()

/** Last scene id we recorded — canvasReady can fire multiple times per navigation. */
let lastRecordedSceneId: string | null = null

export function registerSessionEventHooks(): void {
	// ---- Combat lifecycle ----

	Hooks.on('combatStart', (combat: any) => {
		try {
			if (!game.user?.isGM) return
			if (!getSetting('captureSessionEvents')) return
			sessionEventBuffer.record({
				type: 'combat-start',
				timestamp: Date.now(),
				summary: `Combat started${combat.scene?.name ? ` in ${combat.scene.name}` : ''}`,
			})
		} catch (e) {
			console.warn('FoundryAI | event hook combatStart:', e)
		}
	})

	Hooks.on('deleteCombat', (combat: any) => {
		try {
			if (!game.user?.isGM) return
			if (!getSetting('captureSessionEvents')) return
			sessionEventBuffer.record({
				type: 'combat-end',
				timestamp: Date.now(),
				summary: 'Combat ended',
			})
		} catch (e) {
			console.warn('FoundryAI | event hook deleteCombat:', e)
		}
	})

	Hooks.on('combatRound', (combat: any, _updateData: any) => {
		try {
			if (!game.user?.isGM) return
			if (!getSetting('captureSessionEvents')) return
			sessionEventBuffer.record({
				type: 'combat-round',
				timestamp: Date.now(),
				summary: `Round ${combat.round} began`,
			})
		} catch (e) {
			console.warn('FoundryAI | event hook combatRound:', e)
		}
	})

	// ---- Actor HP / death — via updateActor ----

	Hooks.on('updateActor', (actor: any, changes: any) => {
		try {
			if (!game.user?.isGM) return
			if (!getSetting('captureSessionEvents')) return

			// Only proceed if HP value is part of this update
			const hpChange = changes?.system?.attributes?.hp?.value
			if (hpChange === undefined) return

			const actorName: string = actor.name
			const newHp: number = actor.system?.attributes?.hp?.value ?? 0
			const maxHp: number = actor.system?.attributes?.hp?.max ?? 0

			// Debounce per actor: rapid repeat changes (multi-hit combos) collapse into one event
			const existing = pendingHpEvents.get(actorName)
			if (existing !== undefined) clearTimeout(existing)

			const timer = setTimeout(() => {
				pendingHpEvents.delete(actorName)
				const isDeath = newHp <= 0
				sessionEventBuffer.record({
					type: isDeath ? 'death' : 'damage',
					timestamp: Date.now(),
					summary: isDeath
						? `${actorName} dropped to 0 HP`
						: `${actorName} HP changed to ${newHp}/${maxHp}`,
					actors: [actorName],
					data: { hp: newHp, max: maxHp },
				})
			}, 3000)

			pendingHpEvents.set(actorName, timer)
		} catch (e) {
			console.warn('FoundryAI | event hook updateActor:', e)
		}
	})

	// ---- Condition changes — via createActiveEffect / deleteActiveEffect ----

	Hooks.on('createActiveEffect', (effect: any) => {
		try {
			if (!game.user?.isGM) return
			if (!getSetting('captureSessionEvents')) return
			const target: string | undefined = effect.parent?.name
			if (!target) return
			sessionEventBuffer.record({
				type: 'condition',
				timestamp: Date.now(),
				summary: `${target} gained ${effect.name}`,
				actors: [target],
			})
		} catch (e) {
			console.warn('FoundryAI | event hook createActiveEffect:', e)
		}
	})

	Hooks.on('deleteActiveEffect', (effect: any) => {
		try {
			if (!game.user?.isGM) return
			if (!getSetting('captureSessionEvents')) return
			const target: string | undefined = effect.parent?.name
			if (!target) return
			sessionEventBuffer.record({
				type: 'condition',
				timestamp: Date.now(),
				summary: `${target} lost ${effect.name}`,
				actors: [target],
			})
		} catch (e) {
			console.warn('FoundryAI | event hook deleteActiveEffect:', e)
		}
	})

	// ---- Scene transitions — via canvasReady ----

	Hooks.on('canvasReady', (canvas: any) => {
		try {
			if (!game.user?.isGM) return
			if (!getSetting('captureSessionEvents')) return

			const sceneId: string | undefined = canvas.scene?.id
			// canvasReady fires multiple times per navigation; only record on actual scene change
			if (!sceneId || sceneId === lastRecordedSceneId) return
			lastRecordedSceneId = sceneId

			const sceneName: string = canvas.scene?.name ?? 'Unknown Scene'
			sessionEventBuffer.record({
				type: 'scene-change',
				timestamp: Date.now(),
				summary: `Scene changed to "${sceneName}"`,
			})
		} catch (e) {
			console.warn('FoundryAI | event hook canvasReady:', e)
		}
	})

	console.log('FoundryAI | session-event-hooks: registered')
}
