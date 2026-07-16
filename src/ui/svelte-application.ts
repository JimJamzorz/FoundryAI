/* ==========================================================================
   Svelte ↔ Foundry VTT Bridge
   Extends ApplicationV2 and AbstractSidebarTab to mount Svelte 5 components
   inside Foundry's application windows.
   ========================================================================== */

import { mount, unmount, type Component } from 'svelte'

const FOUNDRY_AI_SIDEBAR_WIDTH = 700

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
	protected previousSidebarWidth: string | null = null
	protected previousSidebarFlexBasis: string | null = null

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
		console.log("Sidebar tab activated, expanding sidebar if needed");
		this.expandSidebarForFoundryAI()
	}

	/** Called when sidebar tab becomes inactive */
	override _onDeactivate(): void {
		this.restoreSidebarWidth()
	}

	protected expandSidebarForFoundryAI(): void {
		const sidebar = document.querySelector<HTMLElement>('#sidebar')
		if (!sidebar) return

		const currentWidth = sidebar.getBoundingClientRect().width
		if (currentWidth >= FOUNDRY_AI_SIDEBAR_WIDTH) return

		if (this.previousSidebarWidth === null) this.previousSidebarWidth = sidebar.style.width || ''
		if (this.previousSidebarFlexBasis === null) this.previousSidebarFlexBasis = sidebar.style.flexBasis || ''

		const target = `${FOUNDRY_AI_SIDEBAR_WIDTH}px`
		sidebar.style.width = target
		sidebar.style.flexBasis = target
	}

	protected restoreSidebarWidth(): void {
		const sidebar = document.querySelector<HTMLElement>('#sidebar')
		if (!sidebar) return

		if (this.previousSidebarWidth !== null) {
			sidebar.style.width = this.previousSidebarWidth
			this.previousSidebarWidth = null
		}
		if (this.previousSidebarFlexBasis !== null) {
			sidebar.style.flexBasis = this.previousSidebarFlexBasis
			this.previousSidebarFlexBasis = null
		}
	}
}

/**
 * Foundry instantiates sidebar tabs itself (`new cls()`) from the `Sidebar.TABS`
 * registry, so it has no way to pass in a Svelte component/props. This factory
 * binds them via closure and returns a subclass Foundry can construct directly.
 */
export function createSvelteSidebarTabClass(
	component: Component<any>,
	props: Record<string, any> = {},
): new (options?: Partial<ApplicationConfiguration>) => SvelteSidebarTab {
	return class extends SvelteSidebarTab {
		constructor(options: Partial<ApplicationConfiguration> = {}) {
			super(component, props, options)
		}
	}
}

// ---- ChatLogPopoutApplication: real chat log, freely-resizable frame ----

/**
 * Foundry's own chat-log popout (`ui.chat.renderPopout()`) is not resizable —
 * the tab's `resizable` window option is hard-coded false in core and there's
 * no way to override it for the popped-out copy from module code. Rather than
 * patching Foundry's internal frame (fragile: relies on undocumented
 * `app.window.resize` wiring and can silently break on core updates), this
 * builds our own plain ApplicationV2 frame — the same proven pattern as
 * `SvelteApplication` below, which is natively resizable with no hacks — and
 * reparents Foundry's real, fully-functional chat log element into it.
 *
 * The chat log instance itself (message rendering, rolls, whispers, chat
 * input, hooks) is untouched; only its outer frame moves, so nothing about
 * how chat works changes — only the window it lives in.
 */
/** Inline styles forced onto the reparented native chat log frame, and kept
 *  in place any time Foundry tries to write over them (see `forceFrameStyle`). */
const EMBEDDED_FRAME_STYLE: Record<string, string> = {
	position: 'static',
	inset: 'unset',
	width: '100%',
	height: '100%',
	'max-width': 'none',
	'max-height': 'none',
	margin: '0',
	'box-shadow': 'none',
	border: 'none',
}

const EMBEDDED_CONTENT_STYLE: Record<string, string> = {
	height: '100%',
	flex: '1 1 auto',
}

export class ChatLogPopoutApplication extends foundry.applications.api.ApplicationV2 {
	protected nativeChatLog: InstanceType<typeof foundry.applications.sidebar.AbstractSidebarTab> | null = null
	protected frameObserver: MutationObserver | null = null

	static override DEFAULT_OPTIONS: ApplicationConfiguration = {
		...foundry.applications.api.ApplicationV2.DEFAULT_OPTIONS,
		id: 'foundry-ai-chat-log-popout',
		classes: ['foundry-ai', 'foundry-ai-chat-log-popout'],
		window: {
			frame: true,
			positioned: true,
			title: 'Chat Log',
			icon: 'fas fa-comments',
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
		return 'Chat Log'
	}

	/** Create the initial frame with a mount point */
	override async _renderHTML(_context: Record<string, any>, _options: Record<string, any>): Promise<HTMLElement> {
		const container = document.createElement('div')
		container.classList.add('foundry-ai-chatlog-root')
		container.style.width = '100%'
		container.style.height = '100%'
		container.style.overflow = 'hidden'
		container.style.display = 'flex'
		container.style.flexDirection = 'column'
		return container
	}

	/** Replace content and embed the real chat log */
	override _replaceHTML(result: HTMLElement, content: HTMLElement, _options: Record<string, any>): void {
		content.replaceChildren(result)
		void this.embedNativeChatLog(result)
	}

	/**
	 * Renders Foundry's real chat log via the public `renderPopout()` API —
	 * this creates a separate instance from the docked sidebar tab, so the
	 * sidebar's own chat log keeps working untouched — then reparents its
	 * whole (internally unmodified) frame element into our container and
	 * hides its now-redundant header/resize handle in favor of our own.
	 */
	protected async embedNativeChatLog(target: HTMLElement): Promise<void> {
		const popout = await ui.chat.renderPopout()
		this.nativeChatLog = popout

		const frame = popout.element
		const winRefs = popout.window

		// Our frame supplies the title bar and resize handle; hide Foundry's.
		if (winRefs?.header) winRefs.header.style.setProperty('display', 'none', 'important')
		if (winRefs?.resize) winRefs.resize.style.setProperty('display', 'none', 'important')

		frame.classList.add('foundry-ai-embedded-chat-log')

		// Foundry still thinks it owns this window's position (it's the same
		// instance that would normally float at a fixed size) and periodically
		// reasserts its own inline width/height — e.g. via setPosition(), or a
		// resize observer that fires while typing in the chat box — which wipes
		// out plain style writes. Neutralize the public entry point...
		popout.setPosition = () => popout.position

		// ...and back that up with a MutationObserver that re-applies our
		// forced styles the instant anything else rewrites `style` directly.
		// The before/after check keeps this from looping: once our values are
		// in place, re-applying them is a no-op and produces no new mutation.
		this.forceFrameStyle(frame, winRefs?.content ?? null)
		this.frameObserver = new MutationObserver(() => this.forceFrameStyle(frame, winRefs?.content ?? null))
		this.frameObserver.observe(frame, { attributes: true, attributeFilter: ['style'] })
		if (winRefs?.content) {
			this.frameObserver.observe(winRefs.content, { attributes: true, attributeFilter: ['style'] })
		}

		target.appendChild(frame)
	}

	/** Reapply the forced layout styles, skipping properties that already match. */
	protected forceFrameStyle(frame: HTMLElement, content: HTMLElement | null): void {
		for (const [prop, value] of Object.entries(EMBEDDED_FRAME_STYLE)) {
			if (frame.style.getPropertyValue(prop) !== value || frame.style.getPropertyPriority(prop) !== 'important') {
				frame.style.setProperty(prop, value, 'important')
			}
		}
		if (!content) return
		for (const [prop, value] of Object.entries(EMBEDDED_CONTENT_STYLE)) {
			if (content.style.getPropertyValue(prop) !== value || content.style.getPropertyPriority(prop) !== 'important') {
				content.style.setProperty(prop, value, 'important')
			}
		}
	}

	/** Tear down the embedded native chat log alongside our own frame */
	override async close(options?: Record<string, any>): Promise<this> {
		this.frameObserver?.disconnect()
		this.frameObserver = null
		const nativeChatLog = this.nativeChatLog
		this.nativeChatLog = null
		if (nativeChatLog?.rendered) {
			await nativeChatLog.close({ animate: false }).catch(() => {})
		}
		return super.close(options)
	}
}

let chatLogPopoutInstance: ChatLogPopoutApplication | null = null

/**
 * Open (or focus) the real Foundry chat log inside our own freely-resizable
 * window. Replaces the old `enablePopoutResize` hack on `ui.chat.renderPopout()`.
 */
export function openChatLogPopout(): ChatLogPopoutApplication {
	if (chatLogPopoutInstance?.rendered) {
		chatLogPopoutInstance.bringToFront()
		return chatLogPopoutInstance
	}

	chatLogPopoutInstance = new ChatLogPopoutApplication()
	chatLogPopoutInstance.render(true)
	return chatLogPopoutInstance
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

/**
 * Open a private GM ↔ AI-player interview ("Table Talk") window. One window
 * per player — talking to a second player opens alongside the first.
 */
export function openPlayerInterviewDialog(
	component: Component<any>,
	props: { player: { id: string; name: string; actorName?: string } } & Record<string, any>,
): SvelteApplication {
	const displayName = props.player.actorName || props.player.name
	const app = new SvelteApplication(component, props, {
		id: `foundry-ai-table-talk-${props.player.id}`,
		window: {
			frame: true,
			positioned: true,
			title: `Table Talk — ${displayName}`,
			icon: 'fas fa-comments',
			minimizable: true,
			resizable: true,
			contentTag: 'section',
			contentClasses: ['foundry-ai-content'],
		},
		position: {
			width: 520,
			height: 640,
		},
	})

	app.render(true)
	return app
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
