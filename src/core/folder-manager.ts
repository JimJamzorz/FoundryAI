/* ==========================================================================
   Folder Manager
   Ensures a consistent "FoundryAI" top-level journal folder structure:
     FoundryAI/
       ├── Notes
       ├── Chat History
       ├── Sessions
       └── Actors
   Provides ID lookups so other managers can place journals in the right spot.
   ========================================================================== */

const ROOT_FOLDER_NAME = 'FoundryAI'
const ROOT_FOLDER_COLOR = '#5e4fa2'

/** Subfolder names under the FoundryAI root */
export const SUBFOLDER_NAMES = {
	notes: 'Notes',
	chatHistory: 'Chat History',
	sessions: 'Sessions',
	actors: 'Actors',
	pdfs: 'PDFs',
} as const

export type SubfolderKey = keyof typeof SUBFOLDER_NAMES

/** Cache of resolved folder IDs */
const folderIdCache: Record<string, string | null> = {}

/**
 * Bootstrap the full FoundryAI folder tree.
 * Safe to call multiple times — only creates missing folders.
 * Returns the root folder.
 */
export async function ensureFoundryAIFolders(): Promise<any> {
	console.log('FoundryAI | Bootstrapping folder structure...')
	const root = await getOrCreateFolder(ROOT_FOLDER_NAME, null, ROOT_FOLDER_COLOR)
	console.log(`FoundryAI | Root folder: "${root.name}" (id: ${root.id})`)

	// Create subfolders under root
	for (const key of Object.keys(SUBFOLDER_NAMES) as SubfolderKey[]) {
		const name = SUBFOLDER_NAMES[key]
		const sub = await getOrCreateFolder(name, root.id)
		console.log(`FoundryAI | Subfolder "${name}": id=${sub.id}, parent=${sub.folder?.id || 'NONE'}`)
	}

	// Invalidate cache — the IDs may have just been created
	Object.keys(folderIdCache).forEach((k) => delete folderIdCache[k])

	console.log('FoundryAI | Folder bootstrap complete')
	return root
}

/**
 * Get the Folder document for a named subfolder under FoundryAI.
 * Returns the Folder or null if it doesn't exist yet.
 */
export function getSubfolder(key: SubfolderKey): any | null {
	const name = SUBFOLDER_NAMES[key]
	const root = game.folders?.find((f: any) => f.type === 'JournalEntry' && f.name === ROOT_FOLDER_NAME && !f.folder)
	if (!root) return null
	return (
		game.folders?.find((f: any) => f.type === 'JournalEntry' && f.name === name && f.folder?.id === root.id) || null
	)
}

/**
 * Get the subfolder ID. Returns null if not bootstrapped yet.
 */
export function getSubfolderId(key: SubfolderKey): string | null {
	// Check cache first
	const cacheKey = `subfolder-${key}`
	if (folderIdCache[cacheKey]) {
		// Verify it still exists
		const folder = game.folders?.get(folderIdCache[cacheKey]!)
		if (folder) return folderIdCache[cacheKey]!
		console.warn(`FoundryAI | Cached folder for "${key}" no longer exists, clearing cache`)
		delete folderIdCache[cacheKey]
	}

	const folder = getSubfolder(key)
	if (folder) {
		folderIdCache[cacheKey] = folder.id
		return folder.id
	}
	console.warn(`FoundryAI | Subfolder "${key}" not found`)
	return null
}

/**
 * Get the root FoundryAI folder ID. Returns null if not bootstrapped yet.
 */
export function getRootFolderId(): string | null {
	const root = game.folders?.find((f: any) => f.type === 'JournalEntry' && f.name === ROOT_FOLDER_NAME && !f.folder)
	return root?.id || null
}

// ---- Helpers ----

async function getOrCreateFolder(name: string, parentId: string | null, color?: string): Promise<any> {
	// Find existing
	const existing = game.folders?.find((f: any) => {
		if (f.type !== 'JournalEntry' || f.name !== name) return false
		if (parentId) return f.folder?.id === parentId
		return !f.folder // top-level
	})

	if (existing) return existing

	// Create
	const data: Record<string, any> = {
		name,
		type: 'JournalEntry',
		folder: parentId,
	}
	if (color) data.color = color

	const folder = await Folder.create(data)
	console.log(`FoundryAI | Created folder: ${name}${parentId ? ' (subfolder)' : ''}`)
	return folder
}
