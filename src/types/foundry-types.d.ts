/* ==========================================================================
   Foundry VTT v13 Type Definitions for FoundryAI Module
   ========================================================================== */

// ---- Global Game Object ----
declare const game: Game
declare const ui: UIElements
declare const Hooks: HooksManager
declare const CONFIG: FoundryConfig
declare const canvas: Canvas
declare const Roll: typeof RollClass
declare const Macro: { create(data: Record<string, any>): Promise<Macro> }
declare const fromUuidSync: (uuid: string) => FoundryDocument | null

// ---- Game Interface ----
interface Game {
	world: { id: string; title: string }
	system: { id: string; title: string } | null
	user: User | null
	users: Collection<User>
	journal: Collection<JournalEntry>
	actors: Collection<Actor>
	scenes: Collection<Scene>
	items: Collection<Item>
	playlists: Collection<Playlist>
	tables: Collection<RollTable>
	macros: Collection<Macro>
	folders: Collection<Folder>
	packs: Map<string, CompendiumCollection>
	combat: Combat | null
	combats: Collection<Combat>
	settings: ClientSettings
	modules: Map<string, Module>
	i18n: Localization
	socket: any
	foundryAI?: FoundryAIApi
}

interface FoundryAIApi {
	chat: (message: string) => Promise<string>
	openChat: () => void
	reindex: () => Promise<void>
	generateSessionRecap: () => Promise<void>
	getMCPBridge: () => Promise<import('../core/mcp-bridge').MCPBridge | null>
}

interface User {
	id: string
	name: string
	isGM: boolean
	active: boolean
}

interface Module {
	id: string
	title: string
	active: boolean
}

interface Localization {
	localize: (key: string) => string
	format: (key: string, data?: Record<string, unknown>) => string
}

// ---- Settings ----
interface ClientSettings {
	register: (module: string, key: string, data: SettingConfig) => void
	registerMenu: (module: string, key: string, data: SettingMenuConfig) => void
	get: (module: string, key: string) => any
	set: (module: string, key: string, value: any) => Promise<any>
}

interface SettingConfig {
	name?: string
	hint?: string
	scope: 'world' | 'client'
	config: boolean
	type: any
	default: any
	choices?: Record<string, string>
	range?: { min: number; max: number; step: number }
	onChange?: (value: any) => void
	requiresReload?: boolean
}

interface SettingMenuConfig {
	name: string
	label: string
	hint?: string
	icon: string
	type: any
	restricted?: boolean
}

// ---- Collections ----
interface Collection<T> extends Map<string, T> {
	get(id: string): T | undefined
	getName(name: string): T | undefined
	find(predicate: (value: T) => boolean): T | undefined
	filter(predicate: (value: T) => boolean): T[]
	some(predicate: (value: T) => boolean): boolean
	contents: T[]
	folders: Folder[]
}

// ---- Documents ----
interface FoundryDocument {
	id: string
	name: string
	folder: Folder | null
	flags: Record<string, any>
	getFlag: (scope: string, key: string) => any
	setFlag: (scope: string, key: string, value: any) => Promise<any>
	unsetFlag: (scope: string, key: string) => Promise<any>
	update: (data: Record<string, any>) => Promise<any>
	delete: () => Promise<any>
	sheet?: any
}

interface JournalEntry extends FoundryDocument {
	pages: Collection<JournalEntryPage>
	createEmbeddedDocuments(type: string, data: Record<string, any>[]): Promise<any[]>
}

interface JournalEntryPage extends FoundryDocument {
	type: string
	text: {
		content: string | null
		markdown: string | null
		format: number
	}
	sort: number
	parent: JournalEntry
}

interface Actor extends FoundryDocument {
	type: string
	img: string
	system: Record<string, any>
	items: Collection<Item>
	effects: Collection<ActiveEffect>
	prototypeToken: Record<string, any>
	hasPlayerOwner: boolean
	rollAbilityTest?: (ability: string, options?: Record<string, any>) => Promise<any>
	rollAbilitySave?: (ability: string, options?: Record<string, any>) => Promise<any>
	rollSkill?: (skill: string, options?: Record<string, any>) => Promise<any>
	createEmbeddedDocuments(type: string, data: Record<string, any>[]): Promise<any[]>
	deleteEmbeddedDocuments(type: string, ids: string[]): Promise<any[]>
}

interface ActiveEffect extends FoundryDocument {
	icon: string
	disabled: boolean
	changes: Array<{ key: string; mode: number; value: string }>
	duration: { rounds?: number; turns?: number; seconds?: number }
	origin: string | null
	statuses: Set<string>
}

interface Scene extends FoundryDocument {
	background: { src: string | null }
	foreground: { src: string | null }
	tokens: Collection<TokenDocument>
	notes: Collection<NoteDocument>
	lights: Collection<AmbientLightDocument>
	walls: Collection<WallDocument>
	drawings: Collection<DrawingDocument>
	templates: Collection<MeasuredTemplateDocument>
	active: boolean
	navigation: boolean
	grid: { type: number; size: number; distance: number; units: string }
	dimensions: { width: number; height: number; sceneWidth: number; sceneHeight: number }
	darkness: number
	weather: string
	activate(): Promise<Scene>
	createEmbeddedDocuments(type: string, data: Record<string, any>[]): Promise<any[]>
	deleteEmbeddedDocuments(type: string, ids: string[]): Promise<any[]>
}

interface TokenDocument extends FoundryDocument {
	actorId: string
	actor: Actor | null
	x: number
	y: number
	elevation: number
	hidden: boolean
	disposition: number // -1 hostile, 0 neutral, 1 friendly
	width: number
	height: number
	texture: { src: string }
	sight: { enabled: boolean; range: number }
	light: { dim: number; bright: number; color: string }
	isOwner: boolean
	object?: any // PlaceableObject on canvas
}

interface NoteDocument extends FoundryDocument {
	entryId: string
	x: number
	y: number
	text: string
	label: string
}

interface AmbientLightDocument extends FoundryDocument {
	x: number
	y: number
	config: { dim: number; bright: number; color: string }
}

interface WallDocument extends FoundryDocument {
	c: [number, number, number, number]
	door: number // 0=none, 1=door, 2=secret
	ds: number // 0=closed, 1=open, 2=locked
}

interface DrawingDocument extends FoundryDocument {
	type: string
	x: number
	y: number
	shape: { width: number; height: number; points: number[] }
	text: string
	fillColor: string
	strokeColor: string
}

interface MeasuredTemplateDocument extends FoundryDocument {
	t: string // circle, cone, ray, rect
	x: number
	y: number
	distance: number
	direction: number
	angle: number
	width: number
	fillColor: string
	texture: string
}

interface Item extends FoundryDocument {
	type: string
	img: string
	system: Record<string, any>
}

interface Playlist extends FoundryDocument {
	sounds: Collection<PlaylistSound>
	playing: boolean
	playAll(): Promise<Playlist>
	stopAll(): Promise<Playlist>
	playSound(sound: PlaylistSound): Promise<void>
}

interface PlaylistSound extends FoundryDocument {
	path: string
	playing: boolean
	volume: number
	repeat: boolean
	fade: number
}

interface RollTable extends FoundryDocument {
	results: Collection<any>
	formula: string
	roll: () => Promise<any>
	draw: (options?: Record<string, any>) => Promise<any>
}

interface Macro extends FoundryDocument {
	type: string
	command: string
	img: string
	execute(): Promise<any>
}

interface Folder extends FoundryDocument {
	type: string
	depth: number
	children: Folder[]
	contents: FoundryDocument[]
	parent: Folder | null
}

// ---- Combat ----
interface Combat extends FoundryDocument {
	round: number
	turn: number
	started: boolean
	active: boolean
	combatant: Combatant | null
	combatants: Collection<Combatant>
	scene: Scene | null
	turns: Combatant[]
	current: { round: number; turn: number; combatantId: string | null }
	nextCombatant: Combatant | null
	startCombat(): Promise<Combat>
	nextTurn(): Promise<Combat>
	nextRound(): Promise<Combat>
	previousTurn(): Promise<Combat>
	previousRound(): Promise<Combat>
	endCombat(): Promise<Combat>
	rollInitiative(ids: string[], options?: Record<string, any>): Promise<Combat>
	setInitiative(combatantId: string, value: number): Promise<void>
	createEmbeddedDocuments(type: string, data: Record<string, any>[]): Promise<Combatant[]>
	deleteEmbeddedDocuments(type: string, ids: string[]): Promise<any[]>
}

declare namespace Combat {
	function create(data?: Record<string, any>): Promise<Combat>
}

interface Combatant extends FoundryDocument {
	actorId: string
	tokenId: string
	actor: Actor | null
	token: TokenDocument | null
	initiative: number | null
	hidden: boolean
	defeated: boolean
	isOwner: boolean
	hasRolled: boolean
}

// ---- Roll ----
declare class RollClass {
	constructor(formula: string, data?: Record<string, any>)
	formula: string
	total: number | undefined
	result: string
	terms: any[]
	dice: any[]
	evaluate(options?: { async?: boolean }): Promise<RollClass>
	toMessage(data?: Record<string, any>, options?: Record<string, any>): Promise<ChatMessage>
	static evaluate(formula: string, data?: Record<string, any>): Promise<RollClass>
}

// ---- Compendium ----
interface CompendiumCollection {
	metadata: { id: string; label: string; type: string; packageType: string; system?: string }
	documentName: string
	index: Map<string, { _id: string; name: string; img?: string; type?: string }>
	getIndex(options?: Record<string, any>): Promise<Map<string, any>>
	getDocument(id: string): Promise<FoundryDocument>
	getDocuments(query?: Record<string, any>): Promise<FoundryDocument[]>
	importDocument(doc: FoundryDocument, options?: Record<string, any>): Promise<FoundryDocument>
}

// ---- Canvas ----
interface Canvas {
	ready: boolean
	scene: Scene | null
	tokens: TokenLayer
	drawings: DrawingLayer
	templates: TemplateLayer
	grid: CanvasGrid
	dimensions: { width: number; height: number; sceneWidth: number; sceneHeight: number }
}

interface TokenLayer {
	placeables: any[]
	get(id: string): any | undefined
	ownedTokens: any[]
}

interface DrawingLayer {
	placeables: any[]
}

interface TemplateLayer {
	placeables: any[]
}

interface CanvasGrid {
	type: number
	size: number
	measureDistance(
		origin: { x: number; y: number },
		target: { x: number; y: number },
		options?: Record<string, any>,
	): number
	measureDistances(segments: Array<{ ray: any }>, options?: Record<string, any>): number[]
}

// ---- Chat Messages ----
interface ChatMessage extends FoundryDocument {
	content: string
	speaker: Record<string, any>
	whisper: string[]
	type: number
	user: User
}

declare namespace ChatMessage {
	function create(data: {
		content: string
		speaker?: Record<string, any>
		whisper?: string[]
		type?: number
		flags?: Record<string, any>
	}): Promise<ChatMessage>
}

// ---- Journal Entry Creation ----
declare namespace JournalEntry {
	function create(data: {
		name: string
		folder?: string | null
		pages?: Array<{
			name: string
			type?: string
			text?: { content: string; format?: number }
		}>
		flags?: Record<string, any>
		ownership?: Record<string, number>
	}): Promise<JournalEntry>
}

// ---- Folder Creation ----
declare namespace Folder {
	function create(data: { name: string; type: string; parent?: string | null; color?: string }): Promise<Folder>
}

// ---- Actor Creation ----
declare namespace Actor {
	function create(data: Record<string, any>): Promise<Actor>
}

// ---- Item Creation ----
declare namespace Item {
	function create(data: Record<string, any>): Promise<Item>
}

// ---- Scene Creation ----
declare namespace Scene {
	function create(data: Record<string, any>): Promise<Scene>
}

// ---- FilePicker ----
declare namespace FilePicker {
	function createDirectory(source: string, target: string, options?: Record<string, any>): Promise<any>
	function upload(source: string, path: string, file: File, body?: Record<string, any>, options?: Record<string, any>): Promise<any>
}

// ---- ApplicationV2 (Foundry v13) ----
declare namespace foundry {
	namespace applications {
		namespace api {
			class ApplicationV2 {
				constructor(options?: Partial<ApplicationConfiguration>)

				static DEFAULT_OPTIONS: ApplicationConfiguration
				static RENDER_STATES: Record<string, number>
				static TABS: Record<string, ApplicationTabsConfiguration>

				options: Readonly<ApplicationConfiguration>
				position: ApplicationPosition
				tabGroups: Record<string, string | null>

				get id(): string
				get title(): string
				get element(): HTMLElement
				get rendered(): boolean
				get state(): number
				get minimized(): boolean
				get classList(): DOMTokenList
				get hasFrame(): boolean
				get window(): {
					close: HTMLButtonElement
					content: HTMLElement
					controls: HTMLButtonElement
					controlsDropdown: HTMLDivElement
					header: HTMLElement
					icon: HTMLElement
					title: HTMLHeadingElement
					resize: HTMLElement
				}

				render(options?: boolean | Record<string, any>, _options?: Record<string, any>): Promise<this>
				close(options?: Record<string, any>): Promise<this>
				setPosition(position?: Partial<ApplicationPosition>): void | ApplicationPosition
				bringToFront(): void
				minimize(): Promise<void>
				maximize(): Promise<void>
				changeTab(tab: string, group: string, options?: Record<string, any>): void

				// Protected lifecycle methods
				_renderHTML(context: Record<string, any>, options: Record<string, any>): Promise<any>
				_replaceHTML(result: any, content: HTMLElement, options: Record<string, any>): void
				_renderFrame(options: Record<string, any>): Promise<HTMLElement>
				_prepareContext(options: Record<string, any>): Promise<Record<string, any>>
				_onFirstRender(context: Record<string, any>, options: Record<string, any>): Promise<void>
				_onRender(context: Record<string, any>, options: Record<string, any>): Promise<void>
				_onClose(options: Record<string, any>): void
				_tearDown(options: Record<string, any>): void
				_insertElement(element: HTMLElement): void
				_removeElement(element: HTMLElement): void
				_getHeaderControls(): ApplicationHeaderControlsEntry[]
				_attachFrameListeners(): void
			}
		}

		namespace sidebar {
			class AbstractSidebarTab extends foundry.applications.api.ApplicationV2 {
				static tabName: string

				get active(): boolean
				get isPopout(): boolean
				get tabName(): string
				get popout(): AbstractSidebarTab | void

				activate(): void
				renderPopout(): Promise<AbstractSidebarTab>

				_onActivate(): void
				_onDeactivate(): void
			}

			class Sidebar {
				static TABS: Record<string, SidebarTabDescriptor>
				tabGroups: { primary: string }
				popouts: Record<string, any>

				get expanded(): boolean
				expand(): void
				collapse(): void
				toggleExpanded(expanded?: boolean): void
				changeTab(tab: string, group: string, options?: Record<string, any>): void
			}
		}
	}

	namespace utils {
		function mergeObject(original: any, other: any, options?: Record<string, any>): any
		function deepClone(obj: any): any
		function randomID(length?: number): string
	}
}

interface ApplicationConfiguration {
	id?: string
	uniqueId?: string
	classes?: string[]
	tag?: string
	window?: {
		frame?: boolean
		positioned?: boolean
		title?: string
		icon?: string
		controls?: ApplicationHeaderControlsEntry[]
		minimizable?: boolean
		resizable?: boolean
		contentTag?: string
		contentClasses?: string[]
	}
	position?: Partial<ApplicationPosition>
	actions?: Record<string, (...args: any[]) => void>
	form?: {
		handler?: (...args: any[]) => Promise<void>
		submitOnChange?: boolean
		closeOnSubmit?: boolean
	}
}

interface ApplicationPosition {
	top: number
	left: number
	width: number | string
	height: number | string
	scale: number
	zIndex: number
}

interface ApplicationTabsConfiguration {
	group?: string
	initial?: string
	label?: string
	icon?: string
	cssClass?: string
}

interface ApplicationHeaderControlsEntry {
	icon: string
	label: string
	action?: string
	visible?: boolean
	ownership?: string
	onclick?: (event: PointerEvent) => void
}

interface SidebarTabDescriptor {
	id: string
	icon: string
	label: string
	cls: any
	order?: number
}

// ---- UI Elements ----
interface UIElements {
	sidebar: foundry.applications.sidebar.Sidebar
	notifications: Notifications
	chat: any
	combat: any
	scenes: any
	actors: any
	items: any
	journal: any
	tables: any
	playlists: any
	compendium: any
	settings: any
	players: any
	hotbar: any
	controls: any
	nav: any
	pause: any
	menu: any
	windows: Record<number, any>
}

interface Notifications {
	info: (message: string, options?: NotificationOptions) => void
	warn: (message: string, options?: NotificationOptions) => void
	error: (message: string, options?: NotificationOptions) => void
}

interface NotificationOptions {
	permanent?: boolean
	localize?: boolean
	console?: boolean
}

// ---- Hooks ----
interface HooksManager {
	on: (hook: string, fn: (...args: any[]) => any) => number
	once: (hook: string, fn: (...args: any[]) => any) => number
	off: (hook: string, id: number) => void
	callAll: (hook: string, ...args: any[]) => boolean
	call: (hook: string, ...args: any[]) => boolean
}

// ---- Config ----
interface FoundryConfig {
	statusEffects: Array<{ id: string; name: string; icon: string }>
	[key: string]: any
}

// ---- Dialog V2 ----
declare namespace foundry {
	namespace applications {
		namespace api {
			class DialogV2 {
				static confirm(options: {
					content: string
					yes?: { label?: string; callback?: () => any }
					no?: { label?: string; callback?: () => any }
					window?: { title?: string }
					rejectClose?: boolean
				}): Promise<any>

				static prompt(options: {
					content: string
					ok?: {
						label?: string
						callback?: (event: Event, button: HTMLButtonElement, dialog: HTMLDialogElement) => any
					}
					window?: { title?: string }
					rejectClose?: boolean
				}): Promise<any>
			}
		}
	}
}

// ---- Svelte Module Declarations ----
declare module '*.svelte' {
	import type { Component } from 'svelte'
	const component: Component<any>
	export default component
}

// ---- Micromark ----
declare module 'micromark' {
	export function micromark(value: string, options?: any): string
}
declare module 'micromark-extension-gfm' {
	export function gfm(): any
	export function gfmHtml(): any
}
