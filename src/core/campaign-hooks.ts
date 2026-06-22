// Campaign Dashboard Interactive Hooks
// Implements clickable status toggles using Foundry's native hook system

let isRegistered = false

export function registerCampaignHooks(): void {
	if (isRegistered) return

	const hookNames = [
		'renderJournalTextPageSheet',
		'renderJournalPageSheet',
		'renderJournalSheet',
		'renderJournalEntryPageSheet',
		'renderApplication',
	]

	hookNames.forEach(hookName => {
		Hooks.on(hookName, (app: any, html: any, data: any) => {
			onRenderJournalSheet(app, html, data)
		})
	})

	isRegistered = true
	console.log('FoundryAI | campaign: hooks registered')
}

function onRenderJournalSheet(app: any, html: any, _data: any): void {
	try {
		if (!app || !html || app._state === -1) return

		// Small delay to avoid race condition with Foundry's internal DOM manipulation
		setTimeout(() => {
			if (!app || app._state === -1 || app.closing) return
			processJournalRender(app, html, _data)
		}, 50)
	} catch (error) {
		console.error('Error in journal sheet render handler:', error)
	}
}

function processJournalRender(app: any, html: any, _data: any): void {
	try {
		if (!app || !html) return
		if (app._state === -1 || app.closing) return

		// Normalise to HTMLElement — Foundry v13 passes a native element, but older hooks
		// may pass a jQuery wrapper (has a numeric [0] key and .jquery property)
		const root: HTMLElement = (html as any).jquery ? (html as any)[0] : html

		if (!root || !root.isConnected) return

		const isCampaignDashboard =
			(app.object?.name || app.object?.parent?.name || '')?.includes('Campaign Dashboard') ||
			root.querySelector('.campaign-status-toggle') !== null

		if (!isCampaignDashboard) return

		// Resolve the JournalEntry — page sheets expose app.document.parent, entry sheets expose app.object
		let entry = app.object
		if (!entry && app.document) {
			entry = app.document.parent || app.document
		}
		if (entry?.parent) {
			entry = entry.parent // JournalEntryPage -> JournalEntry
		}
		if (!entry && app.document?.parent) {
			entry = app.document.parent
		}

		if (!entry || typeof entry.getFlag !== 'function') return

		// Load previously saved status flags for this entry
		const statusFlags: Record<string, string> = entry.getFlag('world', 'campaignStatus') || {}

		const statusToggles = Array.from(root.querySelectorAll<HTMLElement>('.campaign-status-toggle'))

		if (statusToggles.length === 0) return

		// Restore saved status on each toggle
		statusToggles.forEach(element => {
			const campaignId = element.dataset.campaignId
			const partId = element.dataset.partId

			if (!campaignId || !partId) {
				console.warn('[Campaign Status] Toggle missing data attributes:', element)
				return
			}

			const flagKey = `${campaignId}-${partId}`
			const savedStatus = statusFlags[flagKey]

			if (savedStatus) {
				updateToggleVisual(element, savedStatus)
			}
		})

		statusToggles.forEach(element => {
			element.addEventListener('click', (event: MouseEvent) => {
				onStatusToggleClick(event, element, entry, statusFlags)
			})
		})
	} catch (error) {
		console.error('Error setting up campaign dashboard interactivity:', error)
	}
}

async function onStatusToggleClick(
	event: MouseEvent,
	element: HTMLElement,
	entry: any,
	statusFlags: Record<string, string>,
): Promise<void> {
	try {
		event.preventDefault()
		event.stopPropagation()

		const campaignId = element.dataset.campaignId
		const partId = element.dataset.partId

		if (!campaignId || !partId) {
			console.warn('[Campaign Status] Click on toggle missing data attributes')
			return
		}

		if (!game.user?.isGM) {
			ui.notifications?.warn('Only GMs can modify campaign progress')
			return
		}

		const flagKey = `${campaignId}-${partId}`
		const currentStatus = getCurrentStatus(element)
		const nextStatus = getNextStatus(currentStatus)

		// Update visual immediately for responsiveness
		updateToggleVisual(element, nextStatus)
		statusFlags[flagKey] = nextStatus

		try {
			await entry.setFlag('world', 'campaignStatus', statusFlags)
		} catch (error) {
			console.error('[Campaign Status] Failed to save status:', error)
			ui.notifications?.error('Failed to save campaign progress')
			// Revert visual on save failure
			updateToggleVisual(element, currentStatus)
		}
	} catch (error) {
		console.error('Error handling status toggle click:', error)
		ui.notifications?.error('Failed to update campaign progress')
	}
}

function getCurrentStatus(element: HTMLElement): string {
	if (element.classList.contains('not-started')) return 'not_started'
	if (element.classList.contains('in-progress')) return 'in_progress'
	if (element.classList.contains('completed')) return 'completed'
	if (element.classList.contains('skipped')) return 'skipped'
	return 'not_started'
}

function getNextStatus(current: string): string {
	const cycle = ['not_started', 'in_progress', 'completed', 'skipped']
	const currentIndex = cycle.indexOf(current)
	return cycle[(currentIndex + 1) % cycle.length]
}

function updateToggleVisual(element: HTMLElement, newStatus: string): void {
	element.classList.remove('not-started', 'in-progress', 'completed', 'skipped')
	element.classList.add(newStatus.replace('_', '-'))

	const statusIcon = getStatusIcon(newStatus)
	const statusDisplay = formatStatus(newStatus)

	element.innerHTML = `${statusIcon} ${statusDisplay}`
	element.setAttribute('title', `Click to change status: ${statusDisplay}`)
}

function getStatusIcon(status: string): string {
	const icons: Record<string, string> = {
		not_started: '⚪',
		in_progress: '🔄',
		completed: '✅',
		skipped: '⏭️',
	}
	return icons[status] || '❓'
}

function formatStatus(status: string): string {
	return status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}
