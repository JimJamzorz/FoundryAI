/* ==========================================================================
   Svelte ↔ Foundry VTT Bridge
   Extends ApplicationV2 and AbstractSidebarTab to mount Svelte 5 components
   inside Foundry's application windows.
   ========================================================================== */

import { mount, unmount, type Component } from 'svelte'

// ---- SvelteApplication: Popout / floating window ----

export class SvelteApplication extends foundry.applications.api.ApplicationV2 {
	protected svelteComponent: ReturnType<typeof mount> | null = null
	protected svelteTarget: Component
	protected svelteProps: Record<string, any>

	constructor(component: Component<any>, props: Record<string, any> = {}, options: Partial<ApplicationConfiguration> = {}) {
		super(options)
		this.svelteTarget = component
		this.svelteProps = props
	}

	static override DEFAULT_OPTIONS: ApplicationConfiguration = {
		...foundry.applications.api.ApplicationV2.DEFAULT_OPTIONS,
		id: 'foundry-ai-app',
		classes: ['foundry-ai'],
		window: {
			frame: true,
			positioned: true,
			title: 'FoundryAI',
			icon: 'fas fa-brain',
			minimizable: true,
			resizable: true,
			contentTag: 'section',
			contentClasses: ['foundry-ai-content'],
		},
		position: {
			width: 420,
			height: 600,
		},
	}

	override get title(): string {
		return 'FoundryAI'
	}

	/** Create the initial frame with a mount point */
	override async _renderHTML(_context: Record<string, any>, _options: Record<string, any>): Promise<HTMLElement> {
		const container = document.createElement('div')
		container.classList.add('foundry-ai-svelte-root')
		container.style.width = '100%'
		container.style.height = '100%'
		container.style.overflow = 'hidden'
		return container
	}

	/** Replace content and mount Svelte */
	override _replaceHTML(result: HTMLElement, content: HTMLElement, _options: Record<string, any>): void {
		content.replaceChildren(result)
		this.mountSvelte(result)
	}

	/** Mount the Svelte component into the target element */
	protected mountSvelte(target: HTMLElement): void {
		// Unmount previous if any
		this.unmountSvelte()

		this.svelteComponent = mount(this.svelteTarget, {
			target,
			props: {
				...this.svelteProps,
				application: this,
			},
		})
	}

	/** Unmount the Svelte component */
	protected unmountSvelte(): void {
		if (this.svelteComponent) {
			try {
				unmount(this.svelteComponent)
			} catch {
				/* component already destroyed */
			}
			this.svelteComponent = null
		}
	}

	/** Clean up on close — remove element from DOM */
	override async close(options?: Record<string, any>): Promise<this> {
		const el = this.element
		this.unmountSvelte()
		const result = await super.close(options)
		// Safety: ensure element is fully removed from DOM
		if (el?.parentNode) el.remove()
		return result
	}

	/** Clean up Svelte on close */
	override _onClose(options: Record<string, any>): void {
		this.unmountSvelte()
		super._onClose(options)
	}

	/** Override tear down to clean up Svelte */
	override _tearDown(options: Record<string, any>): void {
		this.unmountSvelte()
		super._tearDown(options)
	}

	/** Update Svelte props dynamically */
	updateProps(props: Record<string, any>): void {
		this.svelteProps = { ...this.svelteProps, ...props }
		// Re-mount with new props if rendered
		if (this.rendered && this.element) {
			const root = this.element.querySelector('.foundry-ai-svelte-root')
			if (root) {
				this.mountSvelte(root as HTMLElement)
			}
		}
	}
}

// ---- SvelteSidebarTab: Sidebar integration ----

export class SvelteSidebarTab extends foundry.applications.sidebar.AbstractSidebarTab {
	protected svelteComponent: ReturnType<typeof mount> | null = null
	protected svelteTarget: Component
	protected svelteProps: Record<string, any>

	static override tabName = 'foundry-ai'

	constructor(component: Component<any>, props: Record<string, any> = {}, options: Partial<ApplicationConfiguration> = {}) {
		super(options)
		this.svelteTarget = component
		this.svelteProps = props
	}

	static override DEFAULT_OPTIONS: ApplicationConfiguration = {
		...foundry.applications.sidebar.AbstractSidebarTab.DEFAULT_OPTIONS,
		id: 'foundry-ai-sidebar',
		classes: ['foundry-ai', 'foundry-ai-sidebar-tab'],
		window: {
			frame: true,
			positioned: true,
			title: 'FoundryAI',
			icon: 'fas fa-brain',
			minimizable: false,
			resizable: false,
			contentTag: 'section',
			contentClasses: ['foundry-ai-sidebar-content'],
		},
	}

	override get title(): string {
		return 'FoundryAI'
	}

	/** Create the initial frame with a mount point */
	override async _renderHTML(_context: Record<string, any>, _options: Record<string, any>): Promise<HTMLElement> {
		const container = document.createElement('div')
		container.classList.add('foundry-ai-svelte-root')
		container.style.width = '100%'
		container.style.height = '100%'
		container.style.overflow = 'hidden'
		container.style.display = 'flex'
		container.style.flexDirection = 'column'
		return container
	}

	/** Replace content and mount Svelte */
	override _replaceHTML(result: HTMLElement, content: HTMLElement, _options: Record<string, any>): void {
		content.replaceChildren(result)
		this.mountSvelte(result)
	}

	/** Mount the Svelte component */
	protected mountSvelte(target: HTMLElement): void {
		this.unmountSvelte()

		this.svelteComponent = mount(this.svelteTarget, {
			target,
			props: {
				...this.svelteProps,
				application: this,
				isSidebar: true,
			},
		})
	}

	/** Unmount the Svelte component */
	protected unmountSvelte(): void {
		if (this.svelteComponent) {
			try {
				unmount(this.svelteComponent)
			} catch {
				/* component already destroyed */
			}
			this.svelteComponent = null
		}
	}

	override async close(options?: Record<string, any>): Promise<this> {
		const el = this.element
		this.unmountSvelte()
		const result = await super.close(options)
		if (el?.parentNode) el.remove()
		return result
	}

	override _onClose(options: Record<string, any>): void {
		this.unmountSvelte()
		super._onClose(options)
	}

	override _tearDown(options: Record<string, any>): void {
		this.unmountSvelte()
		super._tearDown(options)
	}

	/** Called when sidebar tab becomes active */
	override _onActivate(): void {
		// Component is already mounted, no action needed
	}

	/** Called when sidebar tab becomes inactive */
	override _onDeactivate(): void {
		// Keep component mounted for state preservation
	}
}

// ---- Factory functions ----

let popoutInstance: SvelteApplication | null = null

/**
 * Create and render a popout chat window.
 * Returns the existing instance if already open.
 */
export function openPopoutChat(component: Component<any>, props: Record<string, any> = {}): SvelteApplication {
	if (popoutInstance?.rendered) {
		popoutInstance.bringToFront()
		return popoutInstance
	}

	popoutInstance = new SvelteApplication(component, props, {
		id: 'foundry-ai-chat',
		window: {
			frame: true,
			positioned: true,
			title: 'FoundryAI Chat',
			icon: 'fas fa-brain',
			minimizable: true,
			resizable: true,
			contentTag: 'section',
			contentClasses: ['foundry-ai-content'],
		},
		position: {
			width: 1100,
			height: 800,
		},
	})

	popoutInstance.render(true)
	return popoutInstance
}

/**
 * Create and render a settings dialog.
 */
export function openSettingsDialog(component: Component<any>, props: Record<string, any> = {}): SvelteApplication {
	const app = new SvelteApplication(component, props, {
		id: 'foundry-ai-settings',
		window: {
			frame: true,
			positioned: true,
			title: 'FoundryAI Settings',
			icon: 'fas fa-cog',
			minimizable: false,
			resizable: true,
			contentTag: 'section',
			contentClasses: ['foundry-ai-content'],
		},
		position: {
			width: 600,
			height: 700,
		},
	})

	app.render(true)
	return app
}

/**
 * Create and render the tool selection dialog.
 */
export function openToolSelectionDialog(component: Component<any>, props: Record<string, any> = {}): SvelteApplication {
	const app = new SvelteApplication(component, props, {
		id: 'foundry-ai-tool-selection',
		window: {
			frame: true,
			positioned: true,
			title: 'Customize Tools',
			icon: 'fas fa-sliders-h',
			minimizable: false,
			resizable: true,
			contentTag: 'section',
			contentClasses: ['foundry-ai-content'],
		},
		position: {
			width: 600,
			height: 700,
		},
	})

	app.render(true)
	return app
}

/**
 * Create and render the GM tool console (manually run any FoundryAI tool).
 */
let toolRunnerInstance: SvelteApplication | null = null

export function openToolRunnerDialog(component: Component<any>, props: Record<string, any> = {}): SvelteApplication {
	if (toolRunnerInstance?.rendered) {
		toolRunnerInstance.bringToFront()
		return toolRunnerInstance
	}

	toolRunnerInstance = new SvelteApplication(component, props, {
		id: 'foundry-ai-tool-runner',
		window: {
			frame: true,
			positioned: true,
			title: 'FoundryAI Tool Console',
			icon: 'fas fa-terminal',
			minimizable: true,
			resizable: true,
			contentTag: 'section',
			contentClasses: ['foundry-ai-content'],
		},
		position: {
			width: 900,
			height: 720,
		},
	})

	toolRunnerInstance.render(true)
	return toolRunnerInstance
}

/**
 * Create and render the AI Player roster manager.
 */
let playerManagerInstance: SvelteApplication | null = null

export function openPlayerManagerDialog(component: Component<any>, props: Record<string, any> = {}): SvelteApplication {
	if (playerManagerInstance?.rendered) {
		playerManagerInstance.bringToFront()
		return playerManagerInstance
	}

	playerManagerInstance = new SvelteApplication(component, props, {
		id: 'foundry-ai-player-manager',
		window: {
			frame: true,
			positioned: true,
			title: 'AI Players',
			icon: 'fas fa-users-cog',
			minimizable: true,
			resizable: true,
			contentTag: 'section',
			contentClasses: ['foundry-ai-content'],
		},
		position: {
			width: 640,
			height: 720,
		},
	})

	playerManagerInstance.render(true)
	return playerManagerInstance
}

/** Close the popout chat if open */
export function closePopoutChat(): void {
	if (popoutInstance?.rendered) {
		popoutInstance.close()
		popoutInstance = null
	}
}

/** Get the current popout instance */
export function getPopoutInstance(): SvelteApplication | null {
	return popoutInstance
}
