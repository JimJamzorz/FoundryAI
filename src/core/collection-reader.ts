/* ==========================================================================
   Collection Reader - Extracts content from Foundry collections for RAG
   ========================================================================== */

export interface ExtractedDocument {
	id: string
	name: string
	type: 'journal' | 'actor'
	folderId: string | null
	folderName: string
	content: string
	lastModified: number
	metadata: Record<string, any>
}

export class CollectionReader {
	// ---- Journal Entries ----

	getJournalsByFolders(folderIds: string[]): ExtractedDocument[] {
		if (!game.journal) return []

		// Resolve to include child folders
		const allFolderIds = this.resolveWithChildren(folderIds)

		const documents: ExtractedDocument[] = []

		for (const entry of game.journal.values()) {
			if (!entry.folder) continue
			if (!allFolderIds.includes(entry.folder.id)) continue

			const content = this.extractJournalContent(entry)
			if (!content) continue

			documents.push({
				id: entry.id,
				name: entry.name,
				type: 'journal',
				folderId: entry.folder?.id || null,
				folderName: entry.folder?.name || 'Uncategorized',
				content,
				lastModified: Date.now(), // Foundry doesn't expose modification time easily
				metadata: {
					pageCount: entry.pages.size,
					folderPath: this.getFolderPath(entry.folder),
				},
			})
		}

		return documents
	}

	getAllJournals(): ExtractedDocument[] {
		if (!game.journal) return []

		const documents: ExtractedDocument[] = []

		for (const entry of game.journal.values()) {
			const content = this.extractJournalContent(entry)
			if (!content) continue

			documents.push({
				id: entry.id,
				name: entry.name,
				type: 'journal',
				folderId: entry.folder?.id || null,
				folderName: entry.folder?.name || 'Uncategorized',
				content,
				lastModified: Date.now(),
				metadata: {
					pageCount: entry.pages.size,
					folderPath: entry.folder ? this.getFolderPath(entry.folder) : '',
				},
			})
		}

		return documents
	}

	private extractJournalContent(entry: JournalEntry): string {
		const parts: string[] = []

		parts.push(`# ${entry.name}`)

		for (const page of entry.pages.values()) {
			if (page.type === 'text' && page.text?.content) {
				const plainText = this.stripHtml(page.text.content)
				if (plainText.trim()) {
					if (entry.pages.size > 1) {
						parts.push(`\n## ${page.name}\n`)
					}
					parts.push(plainText)
				}
			}
		}

		return parts.join('\n').trim()
	}

	// ---- Actors ----

	getActorsByFolders(folderIds: string[]): ExtractedDocument[] {
		if (!game.actors) return []

		console.log(`FoundryAI | getActorsByFolders: input folderIds =`, folderIds)

		// Resolve to include child folders
		const allFolderIds = this.resolveWithChildren(folderIds)

		console.log(`FoundryAI | getActorsByFolders: resolved to ${allFolderIds.length} folder IDs:`, allFolderIds)

		const documents: ExtractedDocument[] = []
		let skippedNoFolder = 0
		let skippedWrongFolder = 0
		const wrongFolderSamples: string[] = [] // Log first few for debugging

		for (const actor of game.actors.values()) {
			if (!actor.folder) {
				skippedNoFolder++
				continue
			}
			if (!allFolderIds.includes(actor.folder.id)) {
				skippedWrongFolder++
				if (wrongFolderSamples.length < 5) {
					wrongFolderSamples.push(`"${actor.name}" in folder "${actor.folder.name}" (${actor.folder.id})`)
				}
				continue
			}

			const content = this.extractActorContent(actor)
			if (!content) continue

			documents.push({
				id: actor.id,
				name: actor.name,
				type: 'actor',
				folderId: actor.folder?.id || null,
				folderName: actor.folder?.name || 'Uncategorized',
				content,
				lastModified: Date.now(),
				metadata: {
					actorType: actor.type,
					img: actor.img,
					itemCount: actor.items?.size || 0,
					folderPath: actor.folder ? this.getFolderPath(actor.folder) : '',
				},
			})
		}

		console.log(
			`FoundryAI | getActorsByFolders: found ${documents.length} actors, skipped ${skippedNoFolder} (no folder), ${skippedWrongFolder} (wrong folder)`,
		)
		if (wrongFolderSamples.length > 0) {
			console.log(`FoundryAI | getActorsByFolders: sample skipped actors:`, wrongFolderSamples)
		}

		return documents
	}

	private extractActorContent(actor: Actor): string {
		const parts: string[] = []

		parts.push(`# ${actor.name}`)
		parts.push(`Type: ${actor.type}`)

		// Extract biography/description
		const bio =
			actor.system?.details?.biography?.value ||
			actor.system?.details?.biography ||
			actor.system?.description?.value ||
			actor.system?.description ||
			''

		if (bio) {
			const plainBio = typeof bio === 'string' ? this.stripHtml(bio) : ''
			if (plainBio.trim()) {
				parts.push(`\nBiography:\n${plainBio}`)
			}
		}

		// Extract basic stats if available
		const hp = actor.system?.attributes?.hp
		if (hp) {
			parts.push(`HP: ${hp.value ?? hp.max ?? '?'}/${hp.max ?? '?'}`)
		}

		const ac = actor.system?.attributes?.ac
		if (ac) {
			parts.push(`AC: ${ac.value ?? ac.flat ?? '?'}`)
		}

		// Extract ability scores if available
		const abilities = actor.system?.abilities
		if (abilities) {
			const scores: string[] = []
			for (const [key, val] of Object.entries(abilities)) {
				const abil = val as any
				if (abil?.value != null) {
					scores.push(`${key.toUpperCase()}: ${abil.value}`)
				}
			}
			if (scores.length) {
				parts.push(`Abilities: ${scores.join(', ')}`)
			}
		}

		// Extract items (inventory, spells, features)
		if (actor.items?.size > 0) {
			const itemsByType: Record<string, string[]> = {}
			for (const item of actor.items.values()) {
				const type = item.type || 'other'
				if (!itemsByType[type]) itemsByType[type] = []
				itemsByType[type].push(item.name)
			}

			for (const [type, names] of Object.entries(itemsByType)) {
				parts.push(`\n${type.charAt(0).toUpperCase() + type.slice(1)}s: ${names.join(', ')}`)
			}
		}

		return parts.join('\n').trim()
	}

	// ---- Utility: Get single document content ----

	getJournalContent(journalId: string): string | null {
		const entry = game.journal?.get(journalId)
		if (!entry) return null
		return this.extractJournalContent(entry)
	}

	getActorContent(actorId: string): string | null {
		const actor = game.actors?.get(actorId)
		if (!actor) return null
		return this.extractActorContent(actor)
	}

	// ---- Folder Helpers ----

	getJournalFolders(): Array<{ id: string; name: string; path: string; depth: number }> {
		if (!game.folders) return []

		const folders: Array<{ id: string; name: string; path: string; depth: number }> = []

		for (const folder of game.folders.values()) {
			if (folder.type === 'JournalEntry') {
				folders.push({
					id: folder.id,
					name: folder.name,
					path: this.getFolderPath(folder),
					depth: folder.depth || 0,
				})
			}
		}

		return folders.sort((a, b) => a.path.localeCompare(b.path))
	}

	getActorFolders(): Array<{ id: string; name: string; path: string; depth: number }> {
		if (!game.folders) return []

		const folders: Array<{ id: string; name: string; path: string; depth: number }> = []

		for (const folder of game.folders.values()) {
			if (folder.type === 'Actor') {
				folders.push({
					id: folder.id,
					name: folder.name,
					path: this.getFolderPath(folder),
					depth: folder.depth || 0,
				})
			}
		}

		return folders.sort((a, b) => a.path.localeCompare(b.path))
	}

	getSceneFolders(): Array<{ id: string; name: string; path: string; depth: number }> {
		if (!game.folders) return []

		const folders: Array<{ id: string; name: string; path: string; depth: number }> = []

		for (const folder of game.folders.values()) {
			if (folder.type === 'Scene') {
				folders.push({
					id: folder.id,
					name: folder.name,
					path: this.getFolderPath(folder),
					depth: folder.depth || 0,
				})
			}
		}

		return folders.sort((a, b) => a.path.localeCompare(b.path))
	}

	getMacroFolders(): Array<{ id: string; name: string; path: string; depth: number }> {
		if (!game.folders) return []

		const folders: Array<{ id: string; name: string; path: string; depth: number }> = []

		for (const folder of game.folders.values()) {
			if (folder.type === 'Macro') {
				folders.push({
					id: folder.id,
					name: folder.name,
					path: this.getFolderPath(folder),
					depth: folder.depth || 0,
				})
			}
		}

		return folders.sort((a, b) => a.path.localeCompare(b.path))
	}

	private getFolderPath(folder: Folder | null): string {
		if (!folder) return ''
		const parts: string[] = [folder.name]
		let parent = folder.parent
		while (parent) {
			parts.unshift(parent.name)
			parent = parent.parent
		}
		return parts.join(' / ')
	}

	// ---- Scene Info ----

	getCurrentSceneInfo(): string {
		const scene = game.scenes?.contents?.find((s) => s.active)
		if (!scene) return 'No active scene.'

		const parts = [`Active Scene: ${scene.name} (id: ${scene.id})`]

		// Scene metadata. Include the grid's pixel size — token positions below are in
		// canvas pixels, and the AI needs pixels-per-square to convert "N squares" into
		// pixel offsets for place_token / move_token.
		if (scene.grid) {
			parts.push(
				`Grid: ${scene.grid.distance || 5}${scene.grid.units || 'ft'} per square, ${scene.grid.size || 100}px per square (token positions are in canvas pixels)`,
			)
		}
		if (scene.weather) {
			parts.push(`Weather: ${scene.weather}`)
		}

		// Tokens with full details
		if (scene.tokens?.size) {
			const tokenDetails: string[] = []
			for (const token of scene.tokens.values()) {
				const detail: string[] = [token.name || 'Unknown']

				// Disposition
				const disp = token.disposition === 1 ? 'friendly' : token.disposition === 0 ? 'neutral' : 'hostile'
				detail.push(disp)

				// HP/AC from actor
				if (token.actor) {
					const hp = token.actor.system?.attributes?.hp
					if (hp) detail.push(`HP: ${hp.value ?? '?'}/${hp.max ?? '?'}`)
					const ac = token.actor.system?.attributes?.ac
					if (ac) detail.push(`AC: ${ac.value ?? ac.flat ?? '?'}`)
				}

				// Position
				detail.push(`pos: (${token.x}, ${token.y})`)

				// Status
				if (token.hidden) detail.push('HIDDEN')
				if (token.elevation) detail.push(`elev: ${token.elevation}`)

				// Active effects/conditions
				if (token.actor?.effects?.size) {
					const conditions = Array.from(token.actor.effects.values())
						.filter((e: any) => !e.disabled)
						.map((e: any) => e.name)
						.filter(Boolean)
					if (conditions.length) detail.push(`conditions: ${conditions.join(', ')}`)
				}

				tokenDetails.push(`- ${detail.join(' | ')} (token_id: ${token.id})`)
			}
			parts.push(`\nTokens (${scene.tokens.size}):\n${tokenDetails.join('\n')}`)
		}

		return parts.join('\n')
	}

	/**
	 * Get detailed info about a specific scene (not necessarily active)
	 */
	getSceneDetails(sceneId: string): string | null {
		const scene = game.scenes?.get(sceneId)
		if (!scene) return null

		const parts = [`Scene: ${scene.name}`]
		if (scene.active) parts.push('(ACTIVE)')

		if (scene.grid) {
			parts.push(`Grid: ${scene.grid.distance || 5}${scene.grid.units || 'ft'} per square`)
		}
		if (scene.darkness != null && scene.darkness > 0) {
			parts.push(`Darkness Level: ${Math.round(scene.darkness * 100)}%`)
		}

		if (scene.tokens?.size) {
			const tokenNames = Array.from(scene.tokens.values())
				.map((t: any) => `${t.name}${t.hidden ? ' (hidden)' : ''}`)
				.filter(Boolean)
			parts.push(`Tokens (${scene.tokens.size}): ${tokenNames.join(', ')}`)
		}

		if (scene.notes?.size) {
			parts.push(`Map Notes: ${scene.notes.size}`)
		}

		return parts.join('\n')
	}

	// ---- Combat Context ----

	getCombatContext(): string | null {
		const combat = game.combat
		if (!combat || !combat.started) return null

		const parts = [`Combat Active — Round ${combat.round}`]

		if (combat.combatant) {
			parts.push(`Current Turn: ${combat.combatant.name || 'Unknown'}`)
		}

		// Initiative order
		if (combat.turns?.length) {
			const order: string[] = []
			for (const c of combat.turns) {
				const detail: string[] = [c.name || 'Unknown']
				if (c.initiative != null) detail.push(`Init: ${c.initiative}`)
				if (c.actor) {
					const hp = c.actor.system?.attributes?.hp
					if (hp) detail.push(`HP: ${hp.value ?? '?'}/${hp.max ?? '?'}`)
				}
				if (c.defeated) detail.push('DEFEATED')
				if (c.hidden) detail.push('HIDDEN')

				const marker = c.id === combat.combatant?.id ? '>> ' : '   '
				order.push(`${marker}${detail.join(' | ')} (combatant_id: ${c.id})`)
			}
			parts.push(`\nInitiative Order:\n${order.join('\n')}`)
		}

		return parts.join('\n')
	}

	// ---- Playlist Context ----

	getPlaylistContext(): string | null {
		if (!game.playlists) return null

		const playing: string[] = []
		for (const playlist of game.playlists.values()) {
			if (playlist.playing) {
				const tracks = Array.from(playlist.sounds?.values() || [])
					.filter((s: any) => s.playing)
					.map((s: any) => s.name)
				playing.push(`🎵 ${playlist.name}${tracks.length ? ` — Playing: ${tracks.join(', ')}` : ''}`)
			}
		}

		if (playing.length === 0) return null
		return playing.join('\n')
	}

	// ---- Folder Resolution ----

	/**
	 * Resolve a list of folder IDs to include all descendant folders recursively.
	 * This way selecting a parent folder automatically includes all children.
	 */
	resolveWithChildren(folderIds: string[]): string[] {
		if (!game.folders || folderIds.length === 0) return folderIds

		const result = new Set<string>(folderIds)

		// Debug: log all folders and their parents
		console.log(`FoundryAI | resolveWithChildren: input IDs:`, folderIds)
		console.log(`FoundryAI | resolveWithChildren: total folders in game:`, game.folders.size)

		// Log parent relationships for debugging
		for (const id of folderIds) {
			const parentFolder = game.folders.get(id)
			if (parentFolder) {
				console.log(
					`FoundryAI | resolveWithChildren: selected folder "${parentFolder.name}" (${id}), type=${parentFolder.type}`,
				)
			}
		}

		// Debug: Check first few Actor folders to see their parent structure
		let debugCount = 0
		for (const folder of game.folders.values()) {
			if (folder.type === 'Actor' && debugCount < 10) {
				console.log(
					`FoundryAI | resolveWithChildren: folder "${folder.name}" (${folder.id}) -> parent: ${folder.parent?.id ?? 'null'}, folder.folder: ${(folder as any).folder ?? 'undefined'}`,
				)
				debugCount++
			}
		}

		const addChildren = (parentId: string) => {
			for (const folder of game.folders.values()) {
				// Depending on the Foundry version and serialization path, the parent
				// can be a Folder document, its ID, or a parent document.
				const rawFolderParent = (folder as any).folder
				const folderParentId =
					(typeof rawFolderParent === 'string' ? rawFolderParent : rawFolderParent?.id) ??
					(folder as any).parentId ??
					folder.parent?.id
				if (folderParentId === parentId && !result.has(folder.id)) {
					console.log(
						`FoundryAI | resolveWithChildren: found child "${folder.name}" (${folder.id}) of parent ${parentId}`,
					)
					result.add(folder.id)
					addChildren(folder.id) // Recurse
				}
			}
		}

		for (const id of folderIds) {
			addChildren(id)
		}

		console.log(`FoundryAI | resolveWithChildren: resolved to ${result.size} folders:`, Array.from(result))

		return Array.from(result)
	}

	// ---- HTML Stripping ----

	private stripHtml(html: string): string {
		// Create a temporary element to parse HTML
		const temp = document.createElement('div')
		temp.innerHTML = html

		// Remove script and style elements
		temp.querySelectorAll('script, style').forEach((el) => el.remove())

		// Get text content and clean up whitespace
		let text = temp.textContent || temp.innerText || ''
		text = text.replace(/\s+/g, ' ').trim()

		return text
	}
}

export const collectionReader = new CollectionReader()
