/* ==========================================================================
   Tool System — OpenAI-compatible function calling tools for the LLM
   ========================================================================== */

import { embeddingService } from './embedding-service'
import { collectionReader } from './collection-reader'
import { getSetting, setSetting } from '../settings'
import { openRouterService } from './openrouter-service'
import type { ToolDefinition, ToolCall } from './openrouter-service'
import { getRootFolderId, getSubfolderId } from './folder-manager'
import { generateCampaignDashboardHTML } from './campaign-management'

// ---- Folder Permission Helpers ----
// These check whether a document's folder is in the user's allowed list.
// If no folders are selected for a type, nothing is accessible.

/** Collect all FoundryAI-managed folder IDs (root + subfolders). */
function getFoundryAIFolderIds(): string[] {
	const ids: string[] = []
	const root = getRootFolderId()
	if (root) ids.push(root)
	for (const key of ['notes', 'chatHistory', 'sessions', 'actors', 'pdfs'] as const) {
		const id = getSubfolderId(key)
		if (id) ids.push(id)
	}
	return ids
}

function isJournalFolderAllowed(folderId: string | undefined | null): boolean {
	const allowed = getSetting('journalFolders') || []

	// Always allow FoundryAI-managed folders
	if (folderId && getFoundryAIFolderIds().includes(folderId)) {
		console.debug(`FoundryAI | isJournalFolderAllowed: folderId="${folderId}" is a FoundryAI folder, returning true`)
		return true
	}

	if (allowed.length === 0) {
		console.debug(`FoundryAI | isJournalFolderAllowed: no restrictions (allowed empty), returning true`)
		return true // no restriction if none selected
	}
	if (!folderId) {
		console.debug(`FoundryAI | isJournalFolderAllowed: folderId is null/undefined, returning false`)
		return false // root items excluded when filtering is active
	}
	// Resolve to include child folders
	const allAllowed = collectionReader.resolveWithChildren(allowed)
	const isAllowed = allAllowed.includes(folderId)
	console.debug(
		`FoundryAI | isJournalFolderAllowed: folderId="${folderId}", allowed=[${allowed.join(',')}], resolved=[${allAllowed.join(',')}], isAllowed=${isAllowed}`,
	)
	return isAllowed
}

function isActorFolderAllowed(folderId: string | undefined | null): boolean {
	const allowed = getSetting('actorFolders') || []
	if (allowed.length === 0) {
		console.debug(`FoundryAI | isActorFolderAllowed: no restrictions (allowed empty), returning true`)
		return true
	}
	if (!folderId) {
		console.debug(`FoundryAI | isActorFolderAllowed: folderId is null/undefined, returning false`)
		return false
	}
	// Resolve to include child folders
	const allAllowed = collectionReader.resolveWithChildren(allowed)
	const isAllowed = allAllowed.includes(folderId)
	console.debug(
		`FoundryAI | isActorFolderAllowed: folderId="${folderId}", allowed=[${allowed.join(',')}], resolved=[${allAllowed.join(',')}], isAllowed=${isAllowed}`,
	)
	return isAllowed
}

function isSceneFolderAllowed(folderId: string | undefined | null): boolean {
	const allowed = getSetting('sceneFolders') || []
	if (allowed.length === 0) {
		console.debug(`FoundryAI | isSceneFolderAllowed: no restrictions (allowed empty), returning true`)
		return true
	}
	if (!folderId) {
		console.debug(`FoundryAI | isSceneFolderAllowed: folderId is null/undefined, returning false`)
		return false
	}
	// Resolve to include child folders
	const allAllowed = collectionReader.resolveWithChildren(allowed)
	const isAllowed = allAllowed.includes(folderId)
	console.debug(
		`FoundryAI | isSceneFolderAllowed: folderId="${folderId}", allowed=[${allowed.join(',')}], resolved=[${allAllowed.join(',')}], isAllowed=${isAllowed}`,
	)
	return isAllowed
}

function isMacroFolderAllowed(folderId: string | undefined | null): boolean {
	const allowed = getSetting('macroFolders') || []
	if (allowed.length === 0) {
		console.debug(`FoundryAI | isMacroFolderAllowed: no restrictions (allowed empty), returning true`)
		return true
	}
	if (!folderId) {
		console.debug(`FoundryAI | isMacroFolderAllowed: folderId is null/undefined, returning false`)
		return false
	}
	const allAllowed = collectionReader.resolveWithChildren(allowed)
	const isAllowed = allAllowed.includes(folderId)
	console.debug(
		`FoundryAI | isMacroFolderAllowed: folderId="${folderId}", allowed=[${allowed.join(',')}], resolved=[${allAllowed.join(',')}], isAllowed=${isAllowed}`,
	)
	return isAllowed
}

/**
 * Distinct from "not found": the document exists but its folder isn't in the
 * allow-list. Surfacing this separately lets the caller tell a permission
 * problem (fixable in settings) apart from a bad/stale ID (not fixable by
 * retrying) instead of guessing from an identical generic error.
 */
function actorFolderDeniedError(actor: Actor): string {
	return JSON.stringify({
		error: `Permission denied: actor "${actor.name}" is in folder "${actor.folder?.name || 'Root'}", which isn't in FoundryAI's allowed actor folders. Enable it in FoundryAI settings, or use search_actors / list_actors_in_folder for actors you do have access to.`,
	})
}

function journalFolderDeniedError(entry: JournalEntry): string {
	return JSON.stringify({
		error: `Permission denied: journal "${entry.name}" is in folder "${entry.folder?.name || 'Root'}", which isn't in FoundryAI's allowed journal folders. Enable it in FoundryAI settings, or use search_journals / list_journals_in_folder for journals you do have access to.`,
	})
}

const FOLDER_SETTING_KEYS = {
	Actor: 'actorFolders',
	JournalEntry: 'journalFolders',
	Scene: 'sceneFolders',
	Macro: 'macroFolders',
} as const

const CREATABLE_FOLDER_TYPES = {
	actor: 'Actor',
	scene: 'Scene',
} as const

type CreatableFolderType = keyof typeof CREATABLE_FOLDER_TYPES

/**
 * Resolve (creating if needed) the destination folder for a create_* tool call, and
 * verify the result is actually visible to future tool calls before the caller reports
 * success. Without this, an actor/journal/scene/macro can land in a folder that isn't
 * in the type's allow-list (e.g. Root, when restrictions are active) — the create call
 * reports success, but every later get/update/delete/list call filters it out as if it
 * never existed.
 *
 * A folder the AI just created is automatically added to the allow-list, since the GM
 * had no chance to select it beforehand and the AI will need to read/update it later.
 * A pre-existing folder that the GM did not select is left alone — naming it here does
 * not grant access to it.
 */
async function resolveManagedFolder(
	folderName: string | undefined | null,
	folderId: string | undefined | null,
	docType: keyof typeof FOLDER_SETTING_KEYS,
): Promise<{ folderId: string | null; error?: string }> {
	const settingKey = FOLDER_SETTING_KEYS[docType]
	let resolvedFolderId = folderId || null

	if (folderName && !resolvedFolderId) {
		let folder = game.folders?.find((f: any) => f.type === docType && f.name === folderName)
		const isNewFolder = !folder
		if (!folder) {
			folder = await Folder.create({ name: folderName, type: docType, parent: null } as any)
		}
		resolvedFolderId = folder?.id || null

		if (isNewFolder && resolvedFolderId) {
			const allowed = getSetting(settingKey) || []
			if (allowed.length > 0 && !allowed.includes(resolvedFolderId)) {
				await setSetting(settingKey, [...allowed, resolvedFolderId])
				console.log(`FoundryAI | resolveManagedFolder: granted access to new folder "${folderName}" (${resolvedFolderId}) in ${settingKey}`)
			}
		}
	}

	// FoundryAI's own managed folders (FoundryAI/Notes, /PDFs, etc.) are always
	// readable regardless of the allow-list, same as isJournalFolderAllowed.
	if (resolvedFolderId && getFoundryAIFolderIds().includes(resolvedFolderId)) {
		return { folderId: resolvedFolderId }
	}

	const allowed = getSetting(settingKey) || []
	if (allowed.length > 0) {
		const allAllowed = collectionReader.resolveWithChildren(allowed)
		if (!resolvedFolderId || !allAllowed.includes(resolvedFolderId)) {
			return {
				folderId: resolvedFolderId,
				error: `No write access to folder "${folderName || 'Root'}" — it isn't in FoundryAI's allowed ${docType} folders. Specify a folder_name you have permission for, or enable this folder in FoundryAI settings.`,
			}
		}
	}

	return { folderId: resolvedFolderId }
}

// ---- Tool Definitions (OpenAI function calling format) ----

// == Core Tools (always available when tools enabled) ==
const CORE_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'search_journals',
			description:
				'Semantically search indexed journal entries to find which ones contain relevant information. Returns a documentId and excerpt for each match. Once you have a documentId, call get_journal immediately — do NOT browse folders, list journals, or call process_pdf. Always cite results using the provided uuidRef.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: "The search query describing what information you're looking for",
					},
					max_results: {
						type: 'number',
						description: 'Maximum number of results to return (default: 5)',
					},
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'search_actors',
			description:
				'Semantically search through indexed actors (NPCs, monsters, characters). Returns the most relevant matches.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The search query (e.g. NPC name, trait, role)',
					},
					max_results: {
						type: 'number',
						description: 'Maximum number of results to return (default: 5)',
					},
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_journal',
			description:
				'Retrieve the full text of every page in a journal entry. Accepts either the Foundry document ID or the exact journal name. This is the ONLY tool needed to read journal content — call it directly after search_journals returns a documentId, or directly by name if you already know it. Long entries are truncated to max_length characters; when the response has truncated: true, call again with offset set to next_offset to fetch the rest.',
			parameters: {
				type: 'object',
				properties: {
					journal_id: {
						type: 'string',
						description: 'The Foundry document ID of the journal entry, OR the exact journal name',
					},
					max_length: {
						type: 'number',
						description: 'Maximum number of characters to return (default: 20000)',
					},
					offset: {
						type: 'number',
						description: 'Character offset to start reading from — use the next_offset from a truncated response to continue (default: 0)',
					},
				},
				required: ['journal_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_actor',
			description: 'Get full details about a specific actor (NPC/character) by document ID. Requires an ID, not a name — get it from the Available Actors / Player Characters lists in the system prompt, search_actors, or list_actors_in_folder.',
			parameters: {
				type: 'object',
				properties: {
					actor_id: {
						type: 'string',
						description: 'The Foundry VTT document ID of the actor (NOT the actor name)',
					},
				},
				required: ['actor_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_actors_in_folder',
			description: 'List every actor in a specific folder (id, name, type, img). Use this to enumerate "who is in folder X" — e.g. the party or a folder of NPCs — instead of search_actors, which is a relevance search over biography text and will not reliably return a complete or correct folder listing. Get folder_id from list_folders.',
			parameters: {
				type: 'object',
				properties: {
					folder_id: {
						type: 'string',
						description: 'The actor folder ID to list, e.g. from list_folders',
					},
				},
				required: ['folder_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'create_journal',
			description:
				'Create a new journal entry in a specified folder. Supports multi-page journals and auto-formatted quest journals with styled headers, details grids, and GM notes. Session recaps MUST go in the "Sessions" folder. The "Notes" folder is ONLY for short, curated plot-state bullets that should always be considered going forward — it is loaded into every future prompt in full, so NEVER put reference material, extracted PDF content, or stat-block dossiers there; put those in any other folder instead.',
			parameters: {
				type: 'object',
				properties: {
					name: {
						type: 'string',
						description: 'The title of the journal entry',
					},
					content: {
						type: 'string',
						description: 'The HTML content of the journal entry. Use proper HTML formatting.',
					},
					folder_name: {
						type: 'string',
						description:
							'The name of the journal folder to create in (e.g. "Sessions", "Notes"). The folder will be created if it does not exist.',
					},
					folder_id: {
						type: 'string',
						description: 'The folder ID to create the journal in. Prefer folder_name instead.',
					},
					additional_pages: {
						type: 'array',
						description:
							'Optional extra pages to add after the main page. Use for multi-section journals (e.g. a "Player Handout" page and a separate "GM Notes" page). Each page becomes a distinct, separately-retrievable journal page.',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string', description: 'Page title (e.g. "GM Notes", "Player Handout")' },
								content: { type: 'string', description: 'HTML content for this page' },
							},
							required: ['name', 'content'],
						},
					},
					quest_meta: {
						type: 'object',
						description:
							'Optional structured quest metadata. When provided, a formatted quest header (summary, details grid, adventure hook, GM notes) is auto-generated and prepended to the main content. Use this when creating quest journals.',
						properties: {
							quest_type: {
								type: 'string',
								enum: ['main', 'side', 'personal', 'mystery', 'fetch', 'escort', 'kill', 'collection'],
								description: 'Type of quest',
							},
							difficulty: {
								type: 'string',
								enum: ['easy', 'medium', 'hard', 'deadly'],
								description: 'Quest difficulty',
							},
							location: { type: 'string', description: 'Where the quest takes place' },
							quest_giver: { type: 'string', description: 'NPC who gives the quest' },
							npc_name: { type: 'string', description: 'Key NPC involved (antagonist/ally/target)' },
							rewards: { type: 'string', description: 'Quest rewards description' },
						},
					},
				},
				required: ['name', 'content'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'update_journal',
			description:
				'Update an existing journal entry. WARNING: this REPLACES the target page\'s entire content — to append or edit, first read the current content with get_journal and resubmit the full modified HTML, or pass new_page_name to add a brand-new page without touching existing ones. By default targets the first text page; pass page_id (from list_journals_in_folder) to target a specific page.',
			parameters: {
				type: 'object',
				properties: {
					journal_id: {
						type: 'string',
						description: 'The ID of the journal entry to update',
					},
					content: {
						type: 'string',
						description: 'The new HTML content for the target page',
					},
					page_id: {
						type: 'string',
						description: 'ID of a specific page to update (from list_journals_in_folder). If omitted, updates the first text page.',
					},
					new_page_name: {
						type: 'string',
						description: 'If provided, creates a NEW page with this name instead of updating an existing one.',
					},
					page_name: {
						type: 'string',
						description: 'Optionally rename the page being updated.',
					},
				},
				required: ['journal_id', 'content'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_journals_in_folder',
			description: 'List all journal entries in a specific folder, including page IDs that can be passed to update_journal.',
			parameters: {
				type: 'object',
				properties: {
					folder_id: {
						type: 'string',
						description: 'The folder ID to list journals from',
					},
				},
				required: ['folder_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_folders',
			description: 'List all accessible journal, actor, and scene folders in the world.',
			parameters: {
				type: 'object',
				properties: {
					type: {
						type: 'string',
						enum: ['journal', 'actor', 'scene', 'all'],
						description: 'Filter by folder type',
					},
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'create_folder',
			description:
				'Create an empty actor or scene folder. Use this when the DM asks to organize actors/NPCs/monsters or scenes/locations into a new folder without creating any documents yet. Newly created folders are automatically made accessible to FoundryAI when folder restrictions are active.',
			parameters: {
				type: 'object',
				properties: {
					name: {
						type: 'string',
						description: 'The folder name to create, e.g. "NPCs", "Villains", "Spoilers", or "Chapter 3 Scenes"',
					},
					type: {
						type: 'string',
						enum: ['actor', 'scene'],
						description: 'Which Foundry document type this folder will contain',
					},
					parent_folder_id: {
						type: 'string',
						description: 'Optional parent folder ID for a nested folder. Omit to create a top-level folder.',
					},
				},
				required: ['name', 'type'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_scene_info',
			description:
				'Get detailed information about the currently active scene including tokens, notes, combat, and other details.',
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'roll_table',
			description: 'Roll on a roll table by its document ID and return the result. Get the table_id from list_rolltables. Compendium tables (via search_compendium with type "RollTable") must be imported with import_from_compendium before rolling.',
			parameters: {
				type: 'object',
				properties: {
					table_id: {
						type: 'string',
						description: 'The document ID of the roll table (NOT the table name) — from list_rolltables',
					},
				},
				required: ['table_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_rolltables',
			description: 'List all roll tables in the world with their IDs, formulas, and entry counts. Call this first to find the table_id for roll_table.',
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'create_rolltable',
			description: 'Create a new roll table from weighted text entries — random encounters, loot, rumors, complications, etc. The die formula and result ranges are computed automatically from the weights (weight 2 = twice as likely as weight 1). Roll it afterwards with roll_table.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The table name, e.g. "Forest Random Encounters"' },
					description: { type: 'string', description: 'Optional description of what the table is for and when to roll it' },
					results: {
						type: 'array',
						description: 'The table entries. Order is preserved; ranges are assigned automatically.',
						items: {
							type: 'object',
							properties: {
								text: { type: 'string', description: 'The result text, e.g. "2d4 goblins arguing over a stolen pie"' },
								weight: { type: 'number', description: 'Relative likelihood (default 1). Whole numbers only.' },
							},
							required: ['text'],
						},
					},
					folder_name: { type: 'string', description: 'Optional roll-table folder to create the table in (created if missing)' },
				},
				required: ['name', 'results'],
			},
		},
	},
]

// == Scene Tools ==
const SCENE_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'list_scenes',
			description: 'List all scenes in the world with their IDs, names, and active status.',
			parameters: {
				type: 'object',
				properties: {
					type: {
						type: 'string',
						enum: ['all', 'navigation'],
						description: 'Filter: "all" for all scenes, "navigation" for only scenes in the nav bar (default: all)',
					},
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'view_scene',
			description: 'Get detailed information about a specific scene without activating it.',
			parameters: {
				type: 'object',
				properties: {
					scene_id: {
						type: 'string',
						description: 'The ID of the scene to view',
					},
				},
				required: ['scene_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'activate_scene',
			description: 'Switch the active scene. DISRUPTIVE: instantly moves every connected player to the new scene — only call when the DM has clearly asked to switch or transition, and confirm first if there is any ambiguity. To inspect a scene without affecting players, use view_scene instead.',
			parameters: {
				type: 'object',
				properties: {
					scene_id: {
						type: 'string',
						description: 'The ID of the scene to activate',
					},
				},
				required: ['scene_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'update_scene',
			description: 'Update an existing scene\'s properties — rename it, change its background image, adjust grid settings, or set the darkness level for mood (e.g. darken the scene as night falls or the party descends into a crypt). To change the background, either pass image_path (an already-generated image) or prompt (generates a new image). Do NOT call generate_image separately before this — pass the prompt directly.',
			parameters: {
				type: 'object',
				properties: {
					scene_id: { type: 'string', description: 'The ID of the scene to update' },
					name: { type: 'string', description: 'New name for the scene' },
					image_path: { type: 'string', description: 'Path to an already-generated image to use as the new background' },
					prompt: { type: 'string', description: 'Generate a new background image from this description and apply it to the scene' },
					size: {
						type: 'string',
						enum: ['1024x1024', '1792x1024', '1024x1792'],
						description: 'Image dimensions when generating a new background via prompt. Default: 1792x1024',
					},
					grid_distance: { type: 'number', description: 'Grid square distance value (e.g. 5 for 5ft squares)' },
					grid_units: { type: 'string', description: 'Grid distance units (e.g. "ft")' },
					darkness: { type: 'number', description: 'Scene darkness level from 0 (fully lit) to 1 (pitch black). E.g. 0 for daytime, 0.5 for dusk, 0.85 for night.' },
				},
				required: ['scene_id'],
			},
		},
	},
]

// == Dice Tools ==
const DICE_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'roll_dice',
			description:
				'Roll dice using a standard dice expression. Returns the total and individual results. Does NOT post to chat.',
			parameters: {
				type: 'object',
				properties: {
					expression: {
						type: 'string',
						description: 'Dice expression (e.g. "2d6+4", "4d6kh3", "1d20+5")',
					},
					label: {
						type: 'string',
						description: 'Optional label for the roll (e.g. "Attack Roll", "Damage")',
					},
				},
				required: ['expression'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'roll_check',
			description: 'Roll an ability check or saving throw for a specific actor using the game system\'s own roll logic (D&D 5e ability list; on other systems falls back to a plain 1d20 + ability modifier). Skill checks are not supported — for "roll Perception for the goblin", get the modifier from get_actor and use roll_dice instead. Does NOT post to chat.',
			parameters: {
				type: 'object',
				properties: {
					actor_id: {
						type: 'string',
						description: 'The ID of the actor to roll for',
					},
					ability: {
						type: 'string',
						enum: ['str', 'dex', 'con', 'int', 'wis', 'cha'],
						description: 'The ability to roll',
					},
					type: {
						type: 'string',
						enum: ['check', 'save'],
						description: 'Whether to roll an ability check or saving throw',
					},
				},
				required: ['actor_id', 'ability', 'type'],
			},
		},
	},
]

// == Token Tools ==
const TOKEN_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'place_token',
			description:
				'Place a new token on the active scene from an actor. Coordinates are CANVAS PIXELS (top-left of the token), not grid squares — call get_scene_info first to see existing token positions and the scene\'s pixels-per-square, then compute pixel positions from those (e.g. "2 squares right" = x + 2 × pixels-per-square). Tokens are placed HIDDEN by default so the DM can approve placement before revealing.',
			parameters: {
				type: 'object',
				properties: {
					actor_id: {
						type: 'string',
						description: 'The ID of the actor to create a token from',
					},
					x: {
						type: 'number',
						description: 'X position in canvas pixels (see get_scene_info for reference positions and grid pixel size)',
					},
					y: {
						type: 'number',
						description: 'Y position in canvas pixels',
					},
					hidden: {
						type: 'boolean',
						description: 'Whether the token starts hidden (default: true)',
					},
				},
				required: ['actor_id', 'x', 'y'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'move_token',
			description: 'Move an existing token to a new position. Coordinates are CANVAS PIXELS, same space as the token positions reported by get_scene_info — to move relative to the current position, read it from get_scene_info and offset by multiples of the scene\'s pixels-per-square.',
			parameters: {
				type: 'object',
				properties: {
					token_id: {
						type: 'string',
						description: 'The ID of the token to move (from get_scene_info)',
					},
					x: {
						type: 'number',
						description: 'New X position in canvas pixels',
					},
					y: {
						type: 'number',
						description: 'New Y position in canvas pixels',
					},
				},
				required: ['token_id', 'x', 'y'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'hide_token',
			description: 'Hide a token from player view.',
			parameters: {
				type: 'object',
				properties: {
					token_id: {
						type: 'string',
						description: 'The ID of the token to hide (from get_scene_info)',
					},
				},
				required: ['token_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'reveal_token',
			description: 'Reveal a hidden token to player view.',
			parameters: {
				type: 'object',
				properties: {
					token_id: {
						type: 'string',
						description: 'The ID of the token to reveal (from get_scene_info or a place_token result)',
					},
				},
				required: ['token_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'remove_token',
			description: 'Remove a token from the scene entirely. This deletes only the token, not the underlying actor.',
			parameters: {
				type: 'object',
				properties: {
					token_id: {
						type: 'string',
						description: 'The ID of the token to remove (from get_scene_info)',
					},
				},
				required: ['token_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'update_token',
			description: 'Update properties of a token (name, size, elevation, light).',
			parameters: {
				type: 'object',
				properties: {
					token_id: {
						type: 'string',
						description: 'The ID of the token to update (from get_scene_info)',
					},
					name: { type: 'string', description: 'New display name' },
					width: { type: 'number', description: 'Width in grid squares' },
					height: { type: 'number', description: 'Height in grid squares' },
					elevation: { type: 'number', description: 'Elevation in grid distance units (e.g. feet)' },
					light_dim: { type: 'number', description: 'Dim light radius in grid distance units (e.g. feet)' },
					light_bright: { type: 'number', description: 'Bright light radius in grid distance units (e.g. feet)' },
					light_color: { type: 'string', description: 'Light color hex (e.g. "#ff9900")' },
				},
				required: ['token_id'],
			},
		},
	},
]

// == Combat Tools ==
const COMBAT_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'get_combat_status',
			description: 'Get the LIVE state of the current combat: round number, whose turn it is, and every combatant with initiative order, HP, conditions, combatant_id, and token_id. The Combat State section in the system prompt is a snapshot from when the conversation loaded and goes stale as turns advance — call this before making decisions mid-combat.',
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'start_combat',
			description: 'Create a new combat encounter and optionally add tokens to it.',
			parameters: {
				type: 'object',
				properties: {
					token_ids: {
						type: 'array',
						items: { type: 'string' },
						description: 'Optional list of token IDs to add as combatants',
					},
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'end_combat',
			description: 'End the current combat encounter.',
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'add_to_combat',
			description: 'Add tokens to the current combat encounter.',
			parameters: {
				type: 'object',
				properties: {
					token_ids: {
						type: 'array',
						items: { type: 'string' },
						description: 'Token IDs to add as combatants',
					},
				},
				required: ['token_ids'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'remove_from_combat',
			description: 'Remove combatants from the current combat encounter.',
			parameters: {
				type: 'object',
				properties: {
					combatant_ids: {
						type: 'array',
						items: { type: 'string' },
						description: 'Combatant IDs to remove',
					},
				},
				required: ['combatant_ids'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'next_turn',
			description: 'Advance to the next turn in combat.',
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'roll_initiative',
			description:
				'Roll initiative for combatants. If no IDs specified, rolls for all combatants that have not yet rolled.',
			parameters: {
				type: 'object',
				properties: {
					combatant_ids: {
						type: 'array',
						items: { type: 'string' },
						description: 'Specific combatant IDs to roll for. Leave empty to roll for all unrolled combatants.',
					},
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'apply_damage',
			description: 'Apply damage or healing to a token\'s actor. The "type" field decides the direction; "amount" is always a positive number of HP. Damage is floored at 0 HP; healing is capped at max HP.',
			parameters: {
				type: 'object',
				properties: {
					token_id: {
						type: 'string',
						description: 'The token ID of the target (from get_scene_info)',
					},
					amount: {
						type: 'number',
						description: 'Amount of HP, always positive — direction is set by "type", e.g. { amount: 8, type: "healing" } to heal 8',
					},
					type: {
						type: 'string',
						enum: ['damage', 'healing'],
						description: 'Whether this is damage or healing',
					},
				},
				required: ['token_id', 'amount', 'type'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'apply_condition',
			description: 'Apply a condition/status effect to a token (e.g. poisoned, stunned, prone, blinded, etc.).',
			parameters: {
				type: 'object',
				properties: {
					token_id: {
						type: 'string',
						description: 'The token ID to apply the condition to (from get_scene_info)',
					},
					condition: {
						type: 'string',
						description: 'The condition name (e.g. "poisoned", "stunned", "prone", "blinded", "frightened")',
					},
				},
				required: ['token_id', 'condition'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'remove_condition',
			description: 'Remove a condition/status effect from a token.',
			parameters: {
				type: 'object',
				properties: {
					token_id: {
						type: 'string',
						description: 'The token ID to remove the condition from',
					},
					condition: {
						type: 'string',
						description: 'The condition name to remove',
					},
				},
				required: ['token_id', 'condition'],
			},
		},
	},
]

// == Audio Tools ==
const AUDIO_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'list_playlists',
			description: 'List all playlists and their tracks.',
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'play_playlist',
			description: 'Start playing a playlist.',
			parameters: {
				type: 'object',
				properties: {
					playlist_id: {
						type: 'string',
						description: 'The ID of the playlist to play',
					},
				},
				required: ['playlist_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'stop_playlist',
			description: 'Stop a playlist. If no ID given, stops all playing playlists.',
			parameters: {
				type: 'object',
				properties: {
					playlist_id: {
						type: 'string',
						description: 'The ID of the playlist to stop. Omit to stop all.',
					},
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'play_track',
			description: 'Play a specific track from a playlist.',
			parameters: {
				type: 'object',
				properties: {
					playlist_id: {
						type: 'string',
						description: 'The ID of the playlist',
					},
					track_name: {
						type: 'string',
						description: 'The name of the track to play',
					},
				},
				required: ['playlist_id', 'track_name'],
			},
		},
	},
]

// == Chat & Narration Tools ==
const CHAT_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'post_chat_message',
			description:
				'Post a message to the Foundry VTT chat log visible to all players. Use for narration, NPC dialogue, or announcements.',
			parameters: {
				type: 'object',
				properties: {
					content: {
						type: 'string',
						description: 'The HTML/text content of the message',
					},
					speaker_name: {
						type: 'string',
						description: 'The name to display as the speaker (e.g. NPC name). Omit for narration.',
					},
					whisper_to: {
						type: 'array',
						items: { type: 'string' },
						description: 'Foundry USER names to whisper to (case-insensitive exact match). Omit for a public message. WARNING: names that match no user are silently dropped — if none match, the message is posted PUBLICLY, so double-check user names before whispering anything secret.',
					},
				},
				required: ['content'],
			},
		},
	},
]

// == Compendium Tools ==
const COMPENDIUM_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'search_compendium',
			description: 'Search across all compendium packs (SRD monsters, items, spells, etc.) by NAME SUBSTRING — this is not a semantic search like search_journals. Use short, literal names: "goblin" or "fireball", never a description like "a fearsome goblin warlord". If a query returns nothing, retry with a shorter fragment of the name.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Name or partial name to match, e.g. "goblin", "cure wounds"',
					},
					type: {
						type: 'string',
						enum: ['Actor', 'Item', 'JournalEntry', 'RollTable', 'all'],
						description: 'Filter by document type (default: all)',
					},
					max_results: {
						type: 'number',
						description: 'Maximum results to return (default: 10)',
					},
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_compendium_entry',
			description: 'Get the full details of a specific compendium entry.',
			parameters: {
				type: 'object',
				properties: {
					pack_id: {
						type: 'string',
						description: 'The compendium pack ID (e.g. "dnd5e.monsters")',
					},
					entry_id: {
						type: 'string',
						description: 'The document ID within the pack',
					},
				},
				required: ['pack_id', 'entry_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'import_from_compendium',
			description:
				'Import a document from a compendium into the world. Useful for importing SRD monsters to then place as tokens.',
			parameters: {
				type: 'object',
				properties: {
					pack_id: {
						type: 'string',
						description: 'The compendium pack ID',
					},
					entry_id: {
						type: 'string',
						description: 'The document ID to import',
					},
					folder_id: {
						type: 'string',
						description: 'Optional folder ID to import into',
					},
				},
				required: ['pack_id', 'entry_id'],
			},
		},
	},
]

// == Spatial Tools ==
const SPATIAL_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'measure_distance',
			description: 'Measure the distance between two tokens or two points on the active scene. Returns the distance in grid units (e.g. feet). REQUIRED: an origin (from_token_id, OR both from_x and from_y in canvas pixels) AND a destination (to_token_id, OR both to_x and to_y). Prefer token IDs from get_scene_info — omitted coordinates default to (0, 0), which silently gives a wrong answer.',
			parameters: {
				type: 'object',
				properties: {
					from_token_id: { type: 'string', description: 'Token ID of the origin (from get_scene_info). Use this OR from_x/from_y.' },
					to_token_id: { type: 'string', description: 'Token ID of the destination. Use this OR to_x/to_y.' },
					from_x: { type: 'number', description: 'Origin X in canvas pixels (only if not using from_token_id)' },
					from_y: { type: 'number', description: 'Origin Y in canvas pixels (only if not using from_token_id)' },
					to_x: { type: 'number', description: 'Destination X in canvas pixels (only if not using to_token_id)' },
					to_y: { type: 'number', description: 'Destination Y in canvas pixels (only if not using to_token_id)' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'tokens_in_range',
			description: 'Find all tokens within a certain distance of a token or point on the active scene. NOTE the mixed units: the center is a token ID or canvas-pixel coordinates, but range is in grid units (e.g. 30 for 30ft). Provide token_id OR both x and y — omitted coordinates default to (0, 0).',
			parameters: {
				type: 'object',
				properties: {
					token_id: { type: 'string', description: 'Center token ID (from get_scene_info). Use this OR x/y.' },
					x: { type: 'number', description: 'Center X in canvas pixels (only if not using token_id)' },
					y: { type: 'number', description: 'Center Y in canvas pixels (only if not using token_id)' },
					range: { type: 'number', description: 'Range in grid distance units, e.g. 30 for 30ft — NOT pixels' },
				},
				required: ['range'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'create_scene_region',
			description: 'Place a shaped scene region on the canvas (for spell areas, zones of effect, etc.). NOTE the mixed units: x/y are canvas pixels (same space as token positions from get_scene_info), while distance and width are in grid units (e.g. 20 for a 20ft radius).',
			parameters: {
				type: 'object',
				properties: {
					type: {
						type: 'string',
						enum: ['circle', 'cone', 'ray', 'rect'],
						description: 'Region shape',
					},
					x: { type: 'number', description: 'Origin X in canvas pixels (circle/cone/ray origin; rect center)' },
					y: { type: 'number', description: 'Origin Y in canvas pixels' },
					distance: { type: 'number', description: 'Size/distance in grid units (e.g. 20 for 20ft radius) — NOT pixels' },
					direction: {
						type: 'number',
						description: 'Direction in degrees for cone/ray. 0=right, 90=down, 180=left, 270=up',
					},
					width: { type: 'number', description: 'Width in grid units for ray shapes (default: 5)' },
					color: { type: 'string', description: 'Fill color hex (default: "#FF0000")' },
				},
				required: ['type', 'x', 'y', 'distance'],
			},
		},
	},
]

// ---- Combine all tool definitions ----

// == Actor Tools ==
const ACTOR_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'create_actor',
			description:
				'Create a new actor (NPC, character, vehicle, etc.) in the world with specified data. Use this to build new NPCs, monsters, or characters from scratch.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The name of the actor' },
					type: {
						type: 'string',
						description: 'The actor type (e.g. "npc", "character", "vehicle"). Default: "npc"',
					},
					data: {
						type: 'object',
						description:
							'System-specific data to set on the actor. For D&D 5e this includes abilities, hp, ac, biography, etc. Use the structure: { "system.attributes.hp.max": 30, "system.abilities.str.value": 16, "system.details.biography.value": "<p>Bio here</p>" }',
					},
					img: { type: 'string', description: 'Optional image path for the actor token/portrait' },
					folder_name: {
						type: 'string',
						description: 'Name of the folder to place the actor in. Will be created if it does not exist.',
					},
					folder_id: { type: 'string', description: 'Folder ID to place the actor in. Prefer folder_name.' },
				},
				required: ['name'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'update_actor',
			description:
				'Update an existing actor\'s data (biography, abilities, HP, AC, stats, portrait/token image, etc.). Uses dot-notation paths like "system.attributes.hp.max". To set the actor\'s sidebar portrait, pass a top-level "img" key with a path from list_assets — this is also how you apply an extracted/generated portrait to an actor. To set the token art shown on the canvas too, also set "prototypeToken.texture.src" to the same or a different path.',
			parameters: {
				type: 'object',
				properties: {
					actor_id: { type: 'string', description: 'The ID of the actor to update' },
					data: {
						type: 'object',
						description:
							'Key-value pairs of data to update. Use dot-notation for nested paths, e.g. { "system.attributes.hp.max": 50, "system.details.biography.value": "<p>New bio</p>" }. For portraits: { "img": "foundry-ai/images/portrait.png" }. For token art: { "prototypeToken.texture.src": "foundry-ai/images/portrait.png" }.',
					},
				},
				required: ['actor_id', 'data'],
			},
		},
	},
	// Deliberately no delete_actor tool: deleting world content is the DM's job.
	// The AI creates and updates; stale actors sitting unused are harmless (they're
	// only surfaced when folder allow-lists pick them up), while an AI-initiated
	// delete is unrecoverable. Same policy applies to journals and scenes.
	{
		type: 'function',
		function: {
			name: 'add_items_to_actor',
			description:
				'Add one or more items (weapons, armor, spells, features, etc.) to an actor. Items are defined with name, type, and system data.',
			parameters: {
				type: 'object',
				properties: {
					actor_id: { type: 'string', description: 'The ID of the actor to add items to' },
					items: {
						type: 'array',
						description: 'Array of item data objects to add',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string', description: 'Item name' },
								type: {
									type: 'string',
									description:
										'Item type (e.g. "weapon", "equipment", "spell", "feat", "consumable", "tool", "loot", "background", "class", "subclass")',
								},
								img: { type: 'string', description: 'Optional image path' },
								data: {
									type: 'object',
									description: 'System-specific item data (damage, weight, description, etc.)',
								},
							},
							required: ['name', 'type'],
						},
					},
				},
				required: ['actor_id', 'items'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'remove_item_from_actor',
			description: 'Remove an item from an actor by its embedded item ID.',
			parameters: {
				type: 'object',
				properties: {
					actor_id: { type: 'string', description: 'The actor ID' },
					item_id: { type: 'string', description: 'The embedded item ID to remove' },
				},
				required: ['actor_id', 'item_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'update_actor_item',
			description:
				'Update an item that is already on an actor (e.g. change quantity, charges, equipped state, description).',
			parameters: {
				type: 'object',
				properties: {
					actor_id: { type: 'string', description: 'The actor ID' },
					item_id: { type: 'string', description: 'The embedded item ID to update' },
					data: {
						type: 'object',
						description:
							'Key-value pairs to update on the item, e.g. { "system.quantity": 5, "system.equipped": true }',
					},
				},
				required: ['actor_id', 'item_id', 'data'],
			},
		},
	},
]

// == Item Tools ==
const ITEM_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'create_item',
			description:
				'Create a standalone world item (weapon, spell, feature, consumable, etc.) that can later be added to actors or given to players.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The item name' },
					type: {
						type: 'string',
						description: 'Item type (e.g. "weapon", "equipment", "spell", "feat", "consumable", "tool", "loot")',
					},
					data: {
						type: 'object',
						description:
							'System-specific item data. For D&D 5e: { "system.description.value": "<p>...</p>", "system.weight": 5, "system.price.value": 100 }',
					},
					img: { type: 'string', description: 'Optional image path' },
					folder_name: { type: 'string', description: 'Folder name to create the item in' },
					folder_id: { type: 'string', description: 'Folder ID to create the item in' },
				},
				required: ['name', 'type'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_item',
			description: 'Get full details of a world item by its ID.',
			parameters: {
				type: 'object',
				properties: {
					item_id: { type: 'string', description: 'The item ID' },
				},
				required: ['item_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'update_item',
			description: "Update an existing world item's data.",
			parameters: {
				type: 'object',
				properties: {
					item_id: { type: 'string', description: 'The item ID' },
					data: {
						type: 'object',
						description:
							'Key-value pairs to update, e.g. { "name": "New Name", "system.description.value": "<p>...</p>" }',
					},
				},
				required: ['item_id', 'data'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'delete_item',
			description: 'Delete a world item permanently.',
			parameters: {
				type: 'object',
				properties: {
					item_id: { type: 'string', description: 'The item ID to delete' },
				},
				required: ['item_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_items',
			description: 'List world items, optionally filtered by type and/or a name substring. When looking for a specific item, always pass name — do not page through the full list.',
			parameters: {
				type: 'object',
				properties: {
					type: {
						type: 'string',
						description: 'Filter by item type (e.g. "weapon", "spell", "feat"). Omit for all items.',
					},
					name: {
						type: 'string',
						description: 'Case-insensitive name substring to filter by, e.g. "healing" matches "Potion of Healing"',
					},
					max_results: {
						type: 'number',
						description: 'Maximum results to return (default: 20)',
					},
				},
			},
		},
	},
]

// == Macro Tools ==
const MACRO_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'list_macros',
			description: 'List macros the AI has access to (filtered by allowed macro folders).',
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_macro',
			description: "Read a macro's script content by ID.",
			parameters: {
				type: 'object',
				properties: {
					macro_id: { type: 'string', description: 'The macro ID' },
				},
				required: ['macro_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'create_macro',
			description: 'Create a new macro with a name, type, and command script.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The macro name' },
					type: {
						type: 'string',
						enum: ['script', 'chat'],
						description: 'Macro type: "script" for JavaScript, "chat" for chat command. Default: "script"',
					},
					command: { type: 'string', description: 'The macro script/command content' },
					img: { type: 'string', description: 'Optional icon image path' },
					folder_name: { type: 'string', description: 'Folder name to place the macro in' },
					folder_id: { type: 'string', description: 'Folder ID to place the macro in' },
				},
				required: ['name', 'command'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'update_macro',
			description: "Update an existing macro's name or command content.",
			parameters: {
				type: 'object',
				properties: {
					macro_id: { type: 'string', description: 'The macro ID' },
					name: { type: 'string', description: 'New name (optional)' },
					command: { type: 'string', description: 'New command/script content (optional)' },
				},
				required: ['macro_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'execute_macro',
			description:
				'Execute a macro by ID and return its result. For script macros, the return value of the script is captured. CAUTION: script macros run arbitrary JavaScript with GM privileges — before executing a macro you did not create in this conversation, read its script with get_macro and make sure it does what the DM expects.',
			parameters: {
				type: 'object',
				properties: {
					macro_id: { type: 'string', description: 'The macro ID to execute' },
				},
				required: ['macro_id'],
			},
		},
	},
]

// == PDF Tools ==
const PDF_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'list_pdfs',
			description: 'List PDF files available in foundry-ai/pdfs/ — the recommended upload location for PDFs to be processed. Returns file paths to use with process_pdf.',
			parameters: { type: 'object', properties: {} },
		},
	},
	{
		type: 'function',
		function: {
			name: 'process_pdf',
			description: 'Convert a PDF file into a new Foundry journal entry (one page per PDF page). WARNING: This CREATES a new journal — do NOT call it to read or access an existing journal. To read a journal, use get_journal. PDFs should be uploaded to foundry-ai/pdfs/ via the Foundry file browser, then listed with list_pdfs. Pages containing mostly images will say so and can be rendered with render_pdf_page.',
			parameters: {
				type: 'object',
				properties: {
					pdf_path: { type: 'string', description: 'Path to the PDF — e.g. "foundry-ai/pdfs/rulebook.pdf". Use list_pdfs to see available files.' },
					journal_name: { type: 'string', description: 'Name for the journal entry to create' },
					folder_name: { type: 'string', description: 'Journal folder to create the entry in' },
				},
				required: ['pdf_path', 'journal_name'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'render_pdf_page',
			description: 'Render a single PDF page to an image file and save it to Foundry storage. Returns the image path so you can pass it to describe_image to vision-read it, update_actor to use it as a portrait, or update_scene to use it as a map background.',
			parameters: {
				type: 'object',
				properties: {
					pdf_path: { type: 'string', description: 'Path to the PDF file' },
					page_number: { type: 'number', description: '1-indexed page number to render' },
				},
				required: ['pdf_path', 'page_number'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'render_pdf_pages',
			description: 'Render up to 5 explicit PDF pages to image files and save them to Foundry storage. Use this reliable fallback when embedded image extraction fails on compressed/JPX/JPEG2000 PDF art. Requires a small explicit page list.',
			parameters: {
				type: 'object',
				properties: {
					pdf_path: { type: 'string', description: 'Path to the PDF file' },
					pages: { type: 'array', items: { type: 'number' }, description: 'Required 1-indexed page numbers to render. Maximum 5 pages.' },
				},
				required: ['pdf_path', 'pages'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'render_pdf_region',
			description: 'Render a cropped region from a single PDF page to an image file. Use this to capture a map, portrait, handout, or art panel from a rendered page when raw embedded image extraction fails. Coordinates are percentages of the page from top-left, between 0 and 1.',
			parameters: {
				type: 'object',
				properties: {
					pdf_path: { type: 'string', description: 'Path to the PDF file' },
					page_number: { type: 'number', description: '1-indexed page number to render' },
					x: { type: 'number', description: 'Left edge of crop as a page percentage from 0 to 1' },
					y: { type: 'number', description: 'Top edge of crop as a page percentage from 0 to 1' },
					width: { type: 'number', description: 'Crop width as a page percentage from 0 to 1' },
					height: { type: 'number', description: 'Crop height as a page percentage from 0 to 1' },
				},
				required: ['pdf_path', 'page_number', 'x', 'y', 'width', 'height'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'extract_pdf_images',
			description:
				'Start a background job for best-effort extraction of embedded images (maps, illustrations, artwork) from a small explicit page list in a PDF. Returns a job_id immediately; use check_pdf_extraction_status only if the user asks for progress or results. If embedded extraction saves nothing for a page, the job renders that page and asks vision to crop the main illustration; if vision cannot identify a good crop, it saves the full-page fallback. WARNING: This can run for a while and may make vision requests. Do NOT retry automatically. Do NOT call this on an entire PDF. Prefer render_pdf_page/render_pdf_region for targeted page capture. Only call extract_pdf_images with a small explicit page list after user confirmation. Maximum 5 pages per job.',
			parameters: {
				type: 'object',
				properties: {
					pdf_path: { type: 'string', description: 'Path to the PDF file — e.g. "foundry-ai/pdfs/adventure.pdf"' },
					pages: { type: 'array', items: { type: 'number' }, description: 'Required 1-indexed page numbers to extract from. Must be explicit and contain no more than 5 pages. Do not omit this field.' },
					min_size: { type: 'number', description: 'Minimum pixel dimension (width or height) to keep an image. Defaults to 300. Use a larger value to skip decorative borders and icons.' },
					fallback: { type: 'string', enum: ['render_page_when_empty', 'none'], description: 'Fallback behavior when embedded extraction saves no images on a page. Defaults to render_page_when_empty.' },
					include_decorative: { type: 'boolean', description: 'Set true only if you explicitly want PDF construction assets like parchment backgrounds, page borders, or empty decorative frames. Defaults to false.' },
				},
				required: ['pdf_path', 'pages'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'check_pdf_extraction_status',
			description:
				'Check a PDF image extraction background job by job_id. Poll only if the user asks for progress/results; extraction jobs run independently after extract_pdf_images returns.',
			parameters: {
				type: 'object',
				properties: {
					job_id: { type: 'string', description: 'Job ID returned by extract_pdf_images' },
				},
				required: ['job_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'cancel_pdf_extraction',
			description: 'Best-effort cancellation for a queued or running PDF image extraction job.',
			parameters: {
				type: 'object',
				properties: {
					job_id: { type: 'string', description: 'Job ID returned by extract_pdf_images' },
				},
				required: ['job_id'],
			},
		},
	},
]

// == Image & Scene Generation Tools ==
const IMAGE_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'list_assets',
			description: 'List image files stored on the Foundry server. With no arguments, lists only previously generated/extracted images and maps (foundry-ai/images, foundry-ai/maps) — check this before generating new images, an existing asset may already be suitable. Pass "directory" to instead browse any other server folder (e.g. "icons", "tokens", "systems/dnd5e/tokens", or an actor\'s own art folder) for existing artwork not made by this module. ALWAYS call this to get the exact "path" value before applying an image to an actor, item, or scene — never guess or reconstruct a path from memory.',
			parameters: {
				type: 'object',
				properties: {
					directory: { type: 'string', description: 'Optional server folder to browse recursively instead of the default generated-assets folders, e.g. "icons", "tokens", "systems/dnd5e/tokens".' },
					search: { type: 'string', description: 'Optional case-insensitive substring to filter filenames by. Recommended when browsing large built-in folders like "icons".' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'describe_image',
			description: 'Use vision AI to describe the contents of an image file. Useful for inspecting existing assets before reusing or replacing them.',
			parameters: {
				type: 'object',
				properties: {
					image_path: {
						type: 'string',
						description: 'Path to the image file (e.g. "foundry-ai/images/foo.png" or any Foundry asset path)',
					},
					question: {
						type: 'string',
						description: 'What to ask about the image. Defaults to a general description if omitted.',
					},
				},
				required: ['image_path'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'organize_images',
			description: 'Use vision AI to classify image assets, move them into category subfolders, and rename them descriptively. Use after extract_pdf_images or for any existing Foundry image assets. Makes one vision request per image.',
			parameters: {
				type: 'object',
				properties: {
					image_paths: { type: 'array', items: { type: 'string' }, description: 'Paths of the images to organize, such as paths returned by extract_pdf_images.' },
					destination_root: { type: 'string', description: 'Optional folder to organize into. Defaults to each image’s current folder.' },
				},
				required: ['image_paths'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'generate_image',
			description:
				'Generate an image from a text prompt using AI image generation and save it to Foundry storage. Returns the saved image "path" (e.g. "foundry-ai/images/red-dragon-1234.png") — use that exact path with update_actor (portrait/token art), update_item, update_scene, or generate_scene\'s image_path. Use for token art, item art, portraits, etc. For new battle-map scenes, prefer generate_scene, which generates the image itself.',
			parameters: {
				type: 'object',
				properties: {
					prompt: {
						type: 'string',
						description:
							'Detailed description of the image to generate. Be specific about style, lighting, perspective, and content.',
					},
					size: {
						type: 'string',
						enum: ['1024x1024', '1792x1024', '1024x1792', '512x512'],
						description:
							'Image dimensions. Use 1792x1024 for landscape maps, 1024x1792 for portrait, 1024x1024 for square. Default: 1024x1024',
					},
				},
				required: ['prompt'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'generate_scene',
			description:
				'Generate a new Foundry VTT scene with a background map image. This tool handles image generation internally — do NOT call generate_image first. If you already have an image path from a previous generate_image call, pass it via image_path to skip regeneration.',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'The scene name' },
					prompt: {
						type: 'string',
						description:
							'Detailed description of the battle map / scene background to generate. Be specific about environment, style (top-down, isometric, etc.), lighting, and key features.',
					},
					image_path: {
						type: 'string',
						description: 'Path to an already-generated image (e.g. from a prior generate_image call). When provided, skips image generation and uses this image as the scene background.',
					},
					grid_distance: {
						type: 'number',
						description: 'Grid square distance value (default: 5 for 5ft squares)',
					},
					grid_units: {
						type: 'string',
						description: 'Grid distance units (default: "ft")',
					},
					size: {
						type: 'string',
						enum: ['1024x1024', '1792x1024', '1024x1792'],
						description: 'Map dimensions. 1792x1024 for wide landscape maps, 1024x1024 for square. Default: 1792x1024',
					},
					folder_name: { type: 'string', description: 'Scene folder name to create the scene in' },
					folder_id: { type: 'string', description: 'Scene folder ID to create the scene in' },
				},
				required: ['name'],
			},
		},
	},
]

// == Campaign Tools ==
const CAMPAIGN_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'create_campaign_dashboard',
			description:
				'Create a campaign dashboard journal with navigation, progress tracking, and clickable status toggles for each campaign part. Use at the start of a new campaign to give a single home-base journal.',
			parameters: {
				type: 'object',
				properties: {
					campaign_title: { type: 'string', description: 'Campaign title' },
					campaign_description: {
						type: 'string',
						description: 'Brief description of the campaign theme and scope',
					},
					template: {
						type: 'string',
						enum: ['five-part-adventure', 'dungeon-crawl', 'investigation', 'sandbox', 'custom'],
						description: 'Campaign structure template',
					},
					custom_parts: {
						type: 'array',
						description: 'Custom parts when template is "custom"',
						items: {
							type: 'object',
							properties: {
								title: { type: 'string', description: 'Part title' },
								description: { type: 'string', description: 'Part description' },
								type: {
									type: 'string',
									enum: ['main_part', 'sub_part', 'chapter', 'session', 'optional'],
									description: 'Part type',
								},
								level_start: { type: 'number', description: 'Recommended starting level' },
								level_end: { type: 'number', description: 'Recommended ending level' },
								sub_parts: {
									type: 'array',
									items: {
										type: 'object',
										properties: {
											title: { type: 'string' },
											description: { type: 'string' },
										},
										required: ['title', 'description'],
									},
								},
							},
							required: ['title', 'description', 'type', 'level_start', 'level_end'],
						},
					},
					default_quest_giver: { type: 'string', description: 'Default quest-giver NPC name (optional)' },
					default_location: { type: 'string', description: 'Default campaign setting/location (optional)' },
				},
				required: ['campaign_title', 'campaign_description', 'template'],
			},
		},
	},
]

// ---- Combine all static tool definition arrays ----

export const TOOL_DEFINITIONS: ToolDefinition[] = [
	...CORE_TOOLS,
	...CAMPAIGN_TOOLS,
	...SCENE_TOOLS,
	...DICE_TOOLS,
	...TOKEN_TOOLS,
	...COMBAT_TOOLS,
	...AUDIO_TOOLS,
	...CHAT_TOOLS,
	...COMPENDIUM_TOOLS,
	...SPATIAL_TOOLS,
	...ACTOR_TOOLS,
	...ITEM_TOOLS,
	...MACRO_TOOLS,
	...IMAGE_TOOLS,
	...PDF_TOOLS,
]

export type ToolGroupId = 'all' | 'campaign' | 'world' | 'gameplay' | 'automation'

export const TOOL_GROUPS: Array<{ id: ToolGroupId; label: string; description: string }> = [
	{ id: 'all', label: 'All tools', description: 'Every enabled tool' },
	{ id: 'campaign', label: 'Campaign', description: 'Journals, actors, items, and compendiums' },
	{ id: 'world', label: 'World & assets', description: 'Scenes, maps, images, PDFs, and spatial tools' },
	{ id: 'gameplay', label: 'Gameplay', description: 'Dice, tokens, combat, audio, and chat' },
	{ id: 'automation', label: 'Automation', description: 'Macros and chat controls' },
]

/**
 * Get enabled tool definitions for a focused chat preset. Core search and
 * document tools are included in every preset so the model can use world context.
 */
export function getEnabledTools(group: ToolGroupId = 'all'): ToolDefinition[] {
	if (!getSetting('enableTools')) return []

	const tools: ToolDefinition[] = [...CORE_TOOLS]
	const include = (id: ToolGroupId) => group === 'all' || group === id

	if (include('campaign')) {
		tools.push(...CAMPAIGN_TOOLS)
		if (getSetting('enableCompendiumTools')) tools.push(...COMPENDIUM_TOOLS)
		if (getSetting('enableActorTools')) tools.push(...ACTOR_TOOLS)
		if (getSetting('enableItemTools')) tools.push(...ITEM_TOOLS)
	}

	if (include('world')) {
		if (getSetting('enableSceneTools')) tools.push(...SCENE_TOOLS)
		if (getSetting('enableSpatialTools')) tools.push(...SPATIAL_TOOLS)
		if (getSetting('enableImageTools')) tools.push(...IMAGE_TOOLS, ...PDF_TOOLS)
	}

	if (include('gameplay')) {
		if (getSetting('enableDiceTools')) tools.push(...DICE_TOOLS)
		if (getSetting('enableTokenTools')) tools.push(...TOKEN_TOOLS)
		if (getSetting('enableCombatTools')) tools.push(...COMBAT_TOOLS)
		if (getSetting('enableAudioTools')) tools.push(...AUDIO_TOOLS)
		if (getSetting('enableChatTools')) tools.push(...CHAT_TOOLS)
	}

	if (include('automation')) {
		if (getSetting('enableMacroTools')) tools.push(...MACRO_TOOLS)
		if (getSetting('enableChatTools')) tools.push(...CHAT_TOOLS)
	}

	// Dedupe — e.g. CHAT_TOOLS is reachable via both "gameplay" and "automation",
	// which would otherwise send the same tool name to the LLM twice.
	const seen = new Set<string>()
	return tools.filter(t => {
		if (seen.has(t.function.name)) return false
		seen.add(t.function.name)
		return true
	})
}

// ---- Per-tool selection (for the in-chat "customize tools" picker) ----

export interface ToolCategory {
	id: string
	label: string
	tools: ToolDefinition[]
}

/** Individual tool categories, used to render per-tool checkboxes grouped in the UI. */
export const TOOL_CATEGORIES: ToolCategory[] = [
	{ id: 'core', label: 'Core (search & read)', tools: CORE_TOOLS },
	{ id: 'campaign', label: 'Campaign dashboards', tools: CAMPAIGN_TOOLS },
	{ id: 'scene', label: 'Scenes', tools: SCENE_TOOLS },
	{ id: 'dice', label: 'Dice', tools: DICE_TOOLS },
	{ id: 'token', label: 'Tokens', tools: TOKEN_TOOLS },
	{ id: 'combat', label: 'Combat', tools: COMBAT_TOOLS },
	{ id: 'audio', label: 'Audio', tools: AUDIO_TOOLS },
	{ id: 'chat', label: 'Chat & narration', tools: CHAT_TOOLS },
	{ id: 'compendium', label: 'Compendium', tools: COMPENDIUM_TOOLS },
	{ id: 'spatial', label: 'Spatial', tools: SPATIAL_TOOLS },
	{ id: 'actor', label: 'Actors', tools: ACTOR_TOOLS },
	{ id: 'item', label: 'Items', tools: ITEM_TOOLS },
	{ id: 'macro', label: 'Macros', tools: MACRO_TOOLS },
	{ id: 'image', label: 'Images & scene gen', tools: IMAGE_TOOLS },
	{ id: 'pdf', label: 'PDFs', tools: PDF_TOOLS },
]

/** Tools currently allowed by the world-level category toggles — the pool the per-message tool picker can choose from. */
export function getAvailableTools(): ToolDefinition[] {
	return getEnabledTools('all')
}

/** Resolve tool definitions for an arbitrary set of tool names, preserving canonical order and dropping anything not currently available. */
export function getToolsByNames(names: string[] | Set<string>): ToolDefinition[] {
	const wanted = names instanceof Set ? names : new Set(names)
	return getAvailableTools().filter(t => wanted.has(t.function.name))
}

/** A per-message tool selection: either one of the built-in TOOL_GROUPS, or an ad-hoc list of individual tool names. */
export type ActiveToolSelection = { group: ToolGroupId } | { custom: string[] }

export function resolveActiveTools(selection: ActiveToolSelection): ToolDefinition[] {
	if ('custom' in selection) return getToolsByNames(selection.custom)
	return getEnabledTools(selection.group)
}

// ---- Tool Execution ----

export async function executeTool(toolCall: ToolCall): Promise<string> {
	const funcName = toolCall.function.name
	let args: Record<string, any>

	console.log(
		`FoundryAI | executeTool called — name: "${funcName}", id: "${toolCall.id}", raw args: ${toolCall.function.arguments?.slice(0, 200)}`,
	)

	if (!funcName) {
		console.error('FoundryAI | Tool call has no function name!', JSON.stringify(toolCall))
		return JSON.stringify({ error: 'Tool call has no function name. This is a streaming parsing error.' })
	}

	try {
		args = JSON.parse(toolCall.function.arguments)
	} catch (e) {
		console.error(`FoundryAI | Failed to parse arguments for tool "${funcName}":`, toolCall.function.arguments, e)
		return JSON.stringify({ error: `Invalid arguments for tool ${funcName}` })
	}

	console.log(`FoundryAI | Executing tool "${funcName}" with args:`, args)

	try {
		let result: string
		switch (funcName) {
			// Campaign tools
			case 'create_campaign_dashboard':
				return await handleCreateCampaignDashboard(args)

			// Core tools
			case 'search_journals':
				return await handleSearchJournals(args.query, args.max_results)
			case 'search_actors':
				return await handleSearchActors(args.query, args.max_results)
			case 'get_journal':
				return handleGetJournal(args.journal_id, args.max_length, args.offset)
			case 'get_actor':
				return handleGetActor(args.actor_id)
			case 'list_actors_in_folder':
				return handleListActorsInFolder(args.folder_id)
			case 'create_journal':
				return await handleCreateJournal(args.name, args.content, args.folder_name, args.folder_id, args.additional_pages, args.quest_meta)
			case 'update_journal':
				return await handleUpdateJournal(args.journal_id, args.content, args.page_id, args.new_page_name, args.page_name)
			case 'list_journals_in_folder':
				return handleListJournalsInFolder(args.folder_id)
			case 'list_folders':
				return handleListFolders(args.type || 'all')
			case 'create_folder':
				return await handleCreateFolder(args.name, args.type, args.parent_folder_id)
			case 'get_scene_info':
				return handleGetSceneInfo()
			case 'roll_table':
				return await handleRollTable(args.table_id)
			case 'list_rolltables':
				return handleListRolltables()
			case 'create_rolltable':
				return await handleCreateRolltable(args)

			// Scene tools
			case 'list_scenes':
				return handleListScenes(args.type)
			case 'view_scene':
				return handleViewScene(args.scene_id)
			case 'activate_scene':
				return await handleActivateScene(args.scene_id)
			case 'update_scene':
				return await handleUpdateScene(args)

			// Dice tools
			case 'roll_dice':
				return await handleRollDice(args.expression, args.label)
			case 'roll_check':
				return await handleRollCheck(args.actor_id, args.ability, args.type)

			// Token tools
			case 'place_token':
				return await handlePlaceToken(args.actor_id, args.x, args.y, args.hidden)
			case 'move_token':
				return await handleMoveToken(args.token_id, args.x, args.y)
			case 'hide_token':
				return await handleSetTokenVisibility(args.token_id, true)
			case 'reveal_token':
				return await handleSetTokenVisibility(args.token_id, false)
			case 'remove_token':
				return await handleRemoveToken(args.token_id)
			case 'update_token':
				return await handleUpdateToken(args)

			// Combat tools
			case 'get_combat_status':
				return handleGetCombatStatus()
			case 'start_combat':
				return await handleStartCombat(args.token_ids)
			case 'end_combat':
				return await handleEndCombat()
			case 'add_to_combat':
				return await handleAddToCombat(args.token_ids)
			case 'remove_from_combat':
				return await handleRemoveFromCombat(args.combatant_ids)
			case 'next_turn':
				return await handleNextTurn()
			case 'roll_initiative':
				return await handleRollInitiative(args.combatant_ids)
			case 'apply_damage':
				return await handleApplyDamage(args.token_id, args.amount, args.type)
			case 'apply_condition':
				return await handleApplyCondition(args.token_id, args.condition)
			case 'remove_condition':
				return await handleRemoveCondition(args.token_id, args.condition)

			// Audio tools
			case 'list_playlists':
				return handleListPlaylists()
			case 'play_playlist':
				return await handlePlayPlaylist(args.playlist_id)
			case 'stop_playlist':
				return await handleStopPlaylist(args.playlist_id)
			case 'play_track':
				return await handlePlayTrack(args.playlist_id, args.track_name)

			// Chat tools
			case 'post_chat_message':
				return await handlePostChatMessage(args.content, args.speaker_name, args.whisper_to)

			// Compendium tools
			case 'search_compendium':
				return await handleSearchCompendium(args.query, args.type, args.max_results)
			case 'get_compendium_entry':
				return await handleGetCompendiumEntry(args.pack_id, args.entry_id)
			case 'import_from_compendium':
				return await handleImportFromCompendium(args.pack_id, args.entry_id, args.folder_id)

			// Spatial tools
			case 'measure_distance':
				return handleMeasureDistance(args)
			case 'tokens_in_range':
				return handleTokensInRange(args)
			case 'create_scene_region':
				return await handleCreateSceneRegion(args)

			// Actor tools
			case 'create_actor':
				return await handleCreateActor(args.name, args.type, args.data, args.img, args.folder_name, args.folder_id)
			case 'update_actor':
				return await handleUpdateActor(args.actor_id, args.data)
			case 'add_items_to_actor':
				return await handleAddItemsToActor(args.actor_id, args.items)
			case 'remove_item_from_actor':
				return await handleRemoveItemFromActor(args.actor_id, args.item_id)
			case 'update_actor_item':
				return await handleUpdateActorItem(args.actor_id, args.item_id, args.data)

			// Item tools
			case 'create_item':
				return await handleCreateItem(args.name, args.type, args.data, args.img, args.folder_name, args.folder_id)
			case 'get_item':
				return handleGetItem(args.item_id)
			case 'update_item':
				return await handleUpdateItem(args.item_id, args.data)
			case 'delete_item':
				return await handleDeleteItem(args.item_id)
			case 'list_items':
				return handleListItems(args.type, args.max_results, args.name)

			// Macro tools
			case 'list_macros':
				return handleListMacros()
			case 'get_macro':
				return handleGetMacro(args.macro_id)
			case 'create_macro':
				return await handleCreateMacro(args.name, args.type, args.command, args.img, args.folder_name, args.folder_id)
			case 'update_macro':
				return await handleUpdateMacro(args.macro_id, args.name, args.command)
			case 'execute_macro':
				return await handleExecuteMacro(args.macro_id)

			// PDF tools
			case 'list_pdfs':
				return await handleListPdfs()
			case 'process_pdf':
				return await handleProcessPdf(args)
			case 'render_pdf_page':
				return await handleRenderPdfPage(args.pdf_path, args.page_number)
			case 'render_pdf_pages':
				return await handleRenderPdfPages(args.pdf_path, args.pages)
			case 'render_pdf_region':
				return await handleRenderPdfRegion(args)
			case 'extract_pdf_images':
				return await handleExtractPdfImages(args)
			case 'check_pdf_extraction_status':
				return handleCheckPdfExtractionStatus(args.job_id)
			case 'cancel_pdf_extraction':
				return handleCancelPdfExtraction(args.job_id)

			// Image & Scene generation tools
			case 'list_assets':
				return await handleListAssets(args.directory, args.search)
			case 'describe_image':
				return await handleDescribeImage(args.image_path, args.question)
			case 'organize_images':
				return await handleOrganizeImages(args.image_paths, args.destination_root)
			// NOT an LLM tool — intentionally absent from TOOL_DEFINITIONS. This is a
			// server-internal RPC: the map-generation backend pushes base64 PNG data
			// through the MCP bridge (foundry-ai.tool.upload_generated_map) to save
			// finished images into foundry-ai/maps/ (or foundry-ai/images/ via the
			// folder arg). An LLM cannot supply imageData.
			case 'upload_generated_map':
				return await handleUploadGeneratedMap(args.filename, args.imageData, args.folder)
			// NOT an LLM tool either — the inverse of upload_generated_map: the server
			// pulls a Foundry asset's bytes (base64) to use as an img2img reference in
			// ComfyUI. The browser client fetches it since only Foundry knows its own
			// storage (which may not share a filesystem with the server).
			case 'read_asset':
				return await handleReadAsset(args.path)
			case 'generate_image':
				return await handleGenerateImage(args.prompt, args.size)
			case 'generate_scene':
				return await handleGenerateScene(args)

			default:
				console.warn(`FoundryAI | Unknown tool called: "${funcName}"`)
				return JSON.stringify({ error: `Unknown tool: ${funcName}` })
		}
	} catch (error: any) {
		console.error(`FoundryAI | Tool "${funcName}" execution failed:`, error)
		return JSON.stringify({ error: `Tool execution failed: ${error.message}` })
	}
}

// ===============================
// CAMPAIGN TOOL HANDLERS
// ===============================

async function handleCreateCampaignDashboard(args: any): Promise<string> {
	try {
		const { html, campaignId, partCount } = generateCampaignDashboardHTML({
			campaign_title: args.campaign_title,
			campaign_description: args.campaign_description,
			template: args.template,
			custom_parts: args.custom_parts,
			default_quest_giver: args.default_quest_giver,
			default_location: args.default_location,
		})
		// Reuse handleCreateJournal so folder creation and permissions stay consistent
		const result = await handleCreateJournal(
			`${args.campaign_title} - Campaign Dashboard`,
			html,
			args.campaign_title,
		)
		const parsed = JSON.parse(result)
		return JSON.stringify({
			success: true,
			campaignId,
			partCount,
			journalId: parsed.id,
			message: `Campaign dashboard "${args.campaign_title}" created with ${partCount} parts.`,
		})
	} catch (error: any) {
		return JSON.stringify({ error: `Failed to create campaign dashboard: ${error.message}` })
	}
}

// ===============================
// CORE TOOL HANDLERS
// ===============================

async function handleSearchJournals(query: string, maxResults?: number): Promise<string> {
	console.log(`FoundryAI | search_journals: query="${query}", maxResults=${maxResults}`)
	const results = await embeddingService.search(query, maxResults || 5, { documentType: 'journal' })
	console.log(`FoundryAI | search_journals: found ${results.length} results`)

	if (results.length === 0) {
		return JSON.stringify({ results: [], message: 'No matching journals found.' })
	}

	// Deduplicate by document ID — multiple chunks may come from the same journal
	const seenIds = new Set<string>()
	const uniqueResults: typeof results = []
	for (const r of results) {
		if (!seenIds.has(r.entry.documentId)) {
			seenIds.add(r.entry.documentId)
			uniqueResults.push(r)
		}
	}

	// Return brief summaries — the AI should use get_journal for full content
	const briefResults = uniqueResults.map((r) => {
		const journalId = r.entry.documentId
		// Short excerpt: first 200 chars of matching chunk text
		const excerpt = r.entry.text.slice(0, 200).trim() + (r.entry.text.length > 200 ? '…' : '')

		return {
			documentId: journalId,
			documentName: r.entry.documentName,
			folder: r.entry.folderName,
			relevance: Math.round(r.score * 100) / 100,
			uuidRef: `@UUID[JournalEntry.${journalId}]{${r.entry.documentName}}`,
			excerpt,
		}
	})

	return JSON.stringify({
		note: 'These are brief summaries. Use the get_journal tool with a documentId to retrieve the full content of any entry you need. ALWAYS cite sources using the uuidRef field.',
		results: briefResults,
	})
}

async function handleSearchActors(query: string, maxResults?: number): Promise<string> {
	const max = maxResults || 5
	const queryLower = query.toLowerCase()
	const results: Array<{ name: string; id: string; folder: string; relevance: number; excerpt: string }> = []
	const allowed = getSetting('actorFolders') || []

	console.log(`FoundryAI | search_actors: query="${query}", allowed folders:`, allowed)

	// Get actors from the configured folders (this handles folder resolution + access control)
	const indexedActors = collectionReader.getActorsByFolders(allowed)

	console.log(`FoundryAI | search_actors: found ${indexedActors.length} actors in allowed folders`)
	if (indexedActors.length > 0) {
		console.log(
			`FoundryAI | search_actors: first few actors:`,
			indexedActors.slice(0, 5).map((a) => a.name),
		)
	}

	// First pass: exact and partial name matches
	const nameMatches: typeof results = []
	for (const actor of indexedActors) {
		const nameLower = actor.name.toLowerCase()

		if (nameLower === queryLower) {
			// Exact match - highest priority
			nameMatches.unshift({
				name: actor.name,
				id: actor.id,
				folder: actor.folderName,
				relevance: 1.0,
				excerpt: actor.content.slice(0, 500),
			})
		} else if (nameLower.includes(queryLower)) {
			// Partial match
			nameMatches.push({
				name: actor.name,
				id: actor.id,
				folder: actor.folderName,
				relevance: 0.95,
				excerpt: actor.content.slice(0, 500),
			})
		}

		if (nameMatches.length >= max) break
	}

	results.push(...nameMatches.slice(0, max))

	// Second pass: embedding-based search if we need more results
	if (results.length < max) {
		const embeddingResults = await embeddingService.search(query, max - results.length, { documentType: 'actor' })
		const existingIds = new Set(results.map((r) => r.id))

		for (const r of embeddingResults) {
			if (!existingIds.has(r.entry.documentId)) {
				results.push({
					name: r.entry.documentName,
					id: r.entry.documentId,
					folder: r.entry.folderName,
					relevance: Math.round(r.score * 100) / 100,
					excerpt: r.entry.text.slice(0, 500),
				})

				if (results.length >= max) break
			}
		}
	}

	if (results.length === 0) {
		return JSON.stringify({ results: [], message: 'No matching actors found.' })
	}

	return JSON.stringify({ results })
}

const GET_JOURNAL_DEFAULT_MAX_LENGTH = 20000

function handleGetJournal(journalId: string, maxLength?: number, offset?: number): string {
	console.log(`FoundryAI | get_journal: id/name="${journalId}"`)
	// Try by ID first, then fall back to exact name match
	let entry = game.journal?.get(journalId)
	if (!entry) {
		entry = game.journal?.find((j: any) => j.name?.toLowerCase() === journalId.toLowerCase())
	}
	if (!entry) {
		console.log(`FoundryAI | get_journal: not found in game.journal`)
		return JSON.stringify({ error: `Journal entry not found: ${journalId}` })
	}
	console.log(
		`FoundryAI | get_journal: found "${entry.name}" in folder "${entry.folder?.name || 'root'}" (id: ${entry.folder?.id})`,
	)

	if (!isJournalFolderAllowed(entry.folder?.id)) {
		console.log(`FoundryAI | get_journal: folder not allowed`)
		return journalFolderDeniedError(entry)
	}

	const fullContent = collectionReader.getJournalContent(journalId) || ''
	const start = Math.max(0, offset || 0)
	const limit = maxLength && maxLength > 0 ? maxLength : GET_JOURNAL_DEFAULT_MAX_LENGTH
	const content = fullContent.slice(start, start + limit)
	const truncated = start + limit < fullContent.length

	return JSON.stringify({
		id: journalId,
		name: entry?.name || 'Unknown',
		folder: entry?.folder?.name || 'Root',
		content,
		total_length: fullContent.length,
		truncated,
		...(truncated ? { next_offset: start + limit } : {}),
	})
}

function handleGetActor(actorId: string): string {
	console.log(`FoundryAI | get_actor: id="${actorId}"`)
	const actor = game.actors?.get(actorId)
	if (!actor) {
		console.log(`FoundryAI | get_actor: not found in game.actors`)
		return JSON.stringify({ error: `Actor not found: ${actorId}` })
	}
	console.log(
		`FoundryAI | get_actor: found "${actor.name}" in folder "${actor.folder?.name || 'root'}" (id: ${actor.folder?.id})`,
	)

	if (!isActorFolderAllowed(actor.folder?.id)) {
		console.log(`FoundryAI | get_actor: folder not allowed`)
		return actorFolderDeniedError(actor)
	}

	const content = collectionReader.getActorContent(actorId)
	return JSON.stringify({
		id: actorId,
		name: actor?.name || 'Unknown',
		type: actor?.type || 'Unknown',
		folder: actor?.folder?.name || 'Root',
		content,
	})
}

function handleListActorsInFolder(folderId: string): string {
	console.log(`FoundryAI | list_actors_in_folder: folderId="${folderId}"`)
	if (!game.actors) {
		return JSON.stringify({ error: 'Actor collection not available' })
	}

	if (!isActorFolderAllowed(folderId)) {
		console.log(`FoundryAI | list_actors_in_folder: folder not allowed`)
		return JSON.stringify({
			error: `Folder not found: "${folderId}". folder_id must be an actual folder ID, not a folder name — call list_folders to get the correct ID.`,
		})
	}

	const actors: Array<{ id: string; name: string; type: string; img: string | null }> = []
	for (const actor of game.actors.values()) {
		if (actor.folder?.id === folderId) {
			actors.push({ id: actor.id, name: actor.name, type: actor.type, img: actor.img || null })
		}
	}

	const folder = game.folders?.get(folderId)
	return JSON.stringify({
		folder: folder?.name || 'Unknown',
		actors,
		count: actors.length,
	})
}

interface JournalPage {
	name: string
	content: string
}

interface QuestMeta {
	quest_type?: string
	difficulty?: string
	location?: string
	quest_giver?: string
	npc_name?: string
	rewards?: string
}

function buildStyledJournalHTML(title: string, body: string): string {
	return `
		<section class="foundryai-journal">
			<style>
				.foundryai-journal { --ink:#222; --muted:#666; --paper:#f8f5f2; --gm:#f2f2f2; --accent:#b33; --rule:#ddd; font-size:14px; line-height:1.6; color:var(--ink); }
				.foundryai-journal .wrap { max-width: 980px; margin: 0 auto; padding: 8px 12px 24px; }
				.foundryai-journal h1 { font-size: 28px; letter-spacing: .5px; text-align: center; margin: 8px 0 6px; }
				.foundryai-journal .orn { height: 10px; border: 0; border-top: 2px solid var(--rule); margin: 8px auto 16px; width: 60%; }
				.foundryai-journal h2 { font-size: 20px; margin: 18px 0 6px; }
				.foundryai-journal h3 { font-size: 16px; margin: 16px 0 6px; text-transform: uppercase; letter-spacing: .04em; }
				.foundryai-journal p.lead { font-size: 15px; color: var(--muted); margin: 0 0 10px; }
				.foundryai-journal .readaloud { background: var(--paper); border-left: 4px solid var(--accent); padding: 10px 12px; margin: 12px 0; }
				.foundryai-journal .gmnote { background: var(--gm); border-left: 4px solid #444; padding: 10px 12px; margin: 12px 0; }
				.foundryai-journal ul { margin: 6px 0 10px 18px; }
				.foundryai-journal .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px 24px; }
				.foundryai-journal img { max-width: 100%; height: auto; border-radius: 2px; }
				.foundryai-journal .meta { font-size: 12px; color: var(--muted); margin: 4px 0 12px; }
				.foundryai-journal table { border-collapse: collapse; width: 100%; }
				.foundryai-journal table th, .foundryai-journal table td { border-bottom: 1px solid var(--rule); padding: 6px 4px; text-align: left; }
				.foundryai-journal .spaced { margin-top: 14px; }
			</style>
			<div class="wrap">
				<h1>${title}</h1>
				<hr class="orn"/>
				${body}
			</div>
		</section>`
}

function buildQuestHeader(questMeta: QuestMeta, description: string): string {
	const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
	const today = new Date().toLocaleDateString()

	const detailItems: string[] = []
	if (questMeta.quest_type) detailItems.push(`<li><strong>Type:</strong> ${cap(questMeta.quest_type)} Quest</li>`)
	if (questMeta.difficulty) detailItems.push(`<li><strong>Difficulty:</strong> ${cap(questMeta.difficulty)}</li>`)
	if (questMeta.location) detailItems.push(`<li><strong>Location:</strong> ${questMeta.location}</li>`)
	if (questMeta.quest_giver) detailItems.push(`<li><strong>Quest Giver:</strong> ${questMeta.quest_giver}</li>`)
	if (questMeta.npc_name) detailItems.push(`<li><strong>Key NPC:</strong> ${questMeta.npc_name}</li>`)

	const rewardItems: string[] = []
	if (questMeta.rewards) rewardItems.push(`<li><strong>Rewards:</strong> ${questMeta.rewards}</li>`)
	rewardItems.push(`<li><strong>Status:</strong> Active</li>`)
	rewardItems.push(`<li><strong>Created:</strong> ${today}</li>`)

	const giver = questMeta.quest_giver || 'A mysterious contact'
	const diffText = questMeta.difficulty ? ` This is a ${cap(questMeta.difficulty)} difficulty quest.` : ''
	const typeText = questMeta.quest_type ? ` (${cap(questMeta.quest_type)} Quest)` : ''

	return `
		<p class="lead">${description}</p>
		<div class="grid-2">
			<div>
				<h3>Quest Details</h3>
				<ul>${detailItems.join('')}</ul>
			</div>
			<div>
				<h3>Rewards &amp; Status</h3>
				<ul>${rewardItems.join('')}</ul>
			</div>
		</div>
		<h2 class="spaced">Adventure Hook</h2>
		<div class="readaloud">
			<p>${giver} approaches you with an urgent matter${typeText}. The task must be completed soon.</p>
		</div>
		<div class="gmnote">
			<p><strong>GM Notes:</strong>${diffText} Adjust encounters to suit your party. Track quest progress and update this journal as the story develops.</p>
		</div>`
}

async function handleCreateJournal(
	name: string,
	content: string,
	folderName?: string,
	folderId?: string,
	additionalPages?: JournalPage[],
	questMeta?: QuestMeta,
): Promise<string> {
	console.log(`FoundryAI | create_journal: name="${name}", folder="${folderName || folderId || 'root'}", pages=${1 + (additionalPages?.length ?? 0)}, questMeta=${!!questMeta}`)

	const resolved = await resolveManagedFolder(folderName, folderId, 'JournalEntry')
	if (resolved.error) return JSON.stringify({ error: resolved.error })
	const resolvedFolderId = resolved.folderId

	const mainContent = questMeta ? buildStyledJournalHTML(name, buildQuestHeader(questMeta, content)) : content
	if (questMeta) console.log(`FoundryAI | create_journal: quest formatting applied`)

	const pages: any[] = [{ name, type: 'text', text: { content: mainContent, format: 1 } }]
	if (additionalPages) {
		for (const page of additionalPages) {
			pages.push({ name: page.name, type: 'text', text: { content: page.content, format: 1 } })
		}
	}

	const journalData: any = { name, pages }
	if (resolvedFolderId) journalData.folder = resolvedFolderId

	const journal = await JournalEntry.create(journalData)
	const pageCount = pages.length
	console.log(`FoundryAI | create_journal: created journal id=${journal.id} with ${pageCount} page(s)`)
	if (journal?.id) {
		embeddingService.queueReindex(journal.id, 'journal')
	}
	return JSON.stringify({
		success: true,
		id: journal.id,
		name: journal.name,
		folder: folderName || 'Root',
		pageCount,
		message: `Created journal entry "${name}" in folder "${folderName || 'Root'}" with ${pageCount} page(s)`,
	})
}

async function handleUpdateJournal(
	journalId: string,
	content: string,
	pageId?: string,
	newPageName?: string,
	pageName?: string,
): Promise<string> {
	console.log(
		`FoundryAI | update_journal: journalId="${journalId}", pageId="${pageId}", newPageName="${newPageName}", content length=${content?.length}`,
	)

	const entry = game.journal?.get(journalId)
	if (!entry) {
		return JSON.stringify({ error: `Journal entry not found: ${journalId}` })
	}
	if (!isJournalFolderAllowed(entry.folder?.id)) {
		return journalFolderDeniedError(entry)
	}

	// Mode 1: Append a brand-new page
	if (newPageName) {
		const created = await entry.createEmbeddedDocuments('JournalEntryPage', [
			{ type: 'text', name: newPageName, text: { content, format: 1 } },
		])
		const newPage = created?.[0]
		embeddingService.queueReindex(journalId, 'journal')
		return JSON.stringify({
			success: true,
			id: journalId,
			pageId: newPage?.id || '',
			pageName: newPageName,
			message: `Added new page "${newPageName}" to "${entry.name}"`,
		})
	}

	// Mode 2: Update a specific page by ID
	if (pageId) {
		const page = entry.pages?.get(pageId)
		if (!page) {
			return JSON.stringify({ error: `Page not found: ${pageId}` })
		}
		const updateData: Record<string, any> = { 'text.content': content }
		if (pageName) updateData.name = pageName
		await page.update(updateData)
		embeddingService.queueReindex(journalId, 'journal')
		return JSON.stringify({
			success: true,
			id: journalId,
			pageId: page.id,
			pageName: page.name,
			message: `Updated page "${page.name}" in "${entry.name}"`,
		})
	}

	// Mode 3: Update first text page (backward-compatible default)
	const firstPage = entry.pages?.find((p: any) => p.type === 'text') || entry.pages.contents?.[0]
	if (!firstPage) {
		return JSON.stringify({ error: 'Journal has no pages to update' })
	}
	const updateData: Record<string, any> = { 'text.content': content }
	if (pageName) updateData.name = pageName
	await firstPage.update(updateData)
	embeddingService.queueReindex(journalId, 'journal')
	return JSON.stringify({
		success: true,
		id: journalId,
		pageId: firstPage.id,
		pageName: firstPage.name,
		message: `Updated journal entry "${entry.name}"`,
	})
}

function handleListJournalsInFolder(folderId: string): string {
	console.log(`FoundryAI | list_journals_in_folder: folderId="${folderId}"`)
	if (!game.journal) {
		return JSON.stringify({ error: 'Journal collection not available' })
	}

	if (!isJournalFolderAllowed(folderId)) {
		console.log(`FoundryAI | list_journals_in_folder: folder not allowed`)
		return JSON.stringify({ error: `Folder not accessible: ${folderId}` })
	}

	const entries: Array<{ id: string; name: string }> = []
	for (const entry of game.journal.values()) {
		if (entry.folder?.id === folderId) {
			entries.push({ id: entry.id, name: entry.name })
		}
	}

	const folder = game.folders?.get(folderId)
	return JSON.stringify({
		folder: folder?.name || 'Unknown',
		entries,
		count: entries.length,
	})
}

function handleListFolders(type: string): string {
	console.log(`FoundryAI | list_folders: type="${type}"`)
	const result: Record<string, any> = {}
	const allowedJournalIds = getSetting('journalFolders') || []
	const allowedActorIds = getSetting('actorFolders') || []
	const allowedSceneIds = getSetting('sceneFolders') || []

	console.log(
		`FoundryAI | list_folders: allowed journal=${allowedJournalIds.length}, actor=${allowedActorIds.length}, scene=${allowedSceneIds.length}`,
	)

	if (type === 'journal' || type === 'all') {
		const all = collectionReader.getJournalFolders()
		const foundryAIIds = getFoundryAIFolderIds()
		result.journalFolders =
			allowedJournalIds.length > 0
				? all.filter((f) => allowedJournalIds.includes(f.id) || foundryAIIds.includes(f.id))
				: all
	}

	if (type === 'actor' || type === 'all') {
		const all = collectionReader.getActorFolders()
		result.actorFolders = allowedActorIds.length > 0 ? all.filter((f) => allowedActorIds.includes(f.id)) : all
	}

	if (type === 'scene' || type === 'all') {
		const all = collectionReader.getSceneFolders()
		result.sceneFolders = allowedSceneIds.length > 0 ? all.filter((f) => allowedSceneIds.includes(f.id)) : all
	}

	return JSON.stringify(result)
}

async function handleCreateFolder(
	name: string,
	type: CreatableFolderType,
	parentFolderId?: string,
): Promise<string> {
	console.log(`FoundryAI | create_folder: name="${name}", type="${type}", parentFolderId="${parentFolderId || ''}"`)

	if (!name || typeof name !== 'string' || name.trim().length === 0) {
		return JSON.stringify({ error: 'Folder name is required.' })
	}

	const docType = CREATABLE_FOLDER_TYPES[type]
	if (!docType) {
		return JSON.stringify({ error: 'Folder type must be "actor" or "scene".' })
	}

	const parent = parentFolderId ? game.folders?.get(parentFolderId) : null
	if (parentFolderId && !parent) {
		return JSON.stringify({ error: `Parent folder not found: ${parentFolderId}` })
	}
	if (parent && (parent as any).type !== docType) {
		return JSON.stringify({
			error: `Parent folder "${parent.name}" is a ${(parent as any).type} folder, but ${type} folders must be nested under ${docType} folders.`,
		})
	}

	const trimmedName = name.trim()
	const existing = game.folders?.find((f: any) => {
		if (f.type !== docType || f.name !== trimmedName) return false
		if (parentFolderId) return f.folder?.id === parentFolderId
		return !f.folder
	})

	const settingKey = FOLDER_SETTING_KEYS[docType]
	let folder = existing
	let created = false

	if (!folder) {
		folder = await Folder.create({
			name: trimmedName,
			type: docType,
			folder: parentFolderId || null,
			parent: parentFolderId || null,
		} as any)
		created = true
	}

	const allowed = getSetting(settingKey) || []
	if (created && folder?.id && allowed.length > 0 && !allowed.includes(folder.id)) {
		await setSetting(settingKey, [...allowed, folder.id])
		console.log(`FoundryAI | create_folder: granted access to new ${type} folder "${trimmedName}" (${folder.id})`)
	}

	return JSON.stringify({
		success: true,
		created,
		id: folder?.id,
		name: folder?.name || trimmedName,
		type,
		document_type: docType,
		parent_folder_id: folder?.folder?.id || null,
		message: `${created ? 'Created' : 'Found existing'} ${type} folder "${trimmedName}".`,
	})
}

function handleGetSceneInfo(): string {
	console.log(`FoundryAI | get_scene_info: called`)
	const info = collectionReader.getCurrentSceneInfo()
	if (info === 'No active scene.') {
		return JSON.stringify({ error: 'No active scene.' })
	}
	return JSON.stringify({ info })
}

async function handleRollTable(tableId: string): Promise<string> {
	console.log(`FoundryAI | roll_table: tableId="${tableId}"`)
	const table = game.tables?.get(tableId)
	if (!table) {
		return JSON.stringify({ error: `Roll table not found: ${tableId}` })
	}

	try {
		const result = await table.draw({ displayChat: false })
		const results = result?.results?.map((r: any) => ({
			text: r.text || r.name || 'No result text',
			range: r.range,
		}))

		return JSON.stringify({
			table: table.name,
			roll: result?.roll?.total,
			results: results || [],
		})
	} catch (error: any) {
		return JSON.stringify({ error: `Failed to roll table: ${error.message}` })
	}
}

function handleListRolltables(): string {
	console.log('FoundryAI | list_rolltables')
	if (!game.tables || game.tables.size === 0) {
		return JSON.stringify({
			tables: [],
			count: 0,
			message: 'No roll tables exist in this world yet. You can create one with create_rolltable.',
		})
	}

	const tables = Array.from(game.tables.values()).map((t) => ({
		id: t.id,
		name: t.name,
		folder: (t as any).folder?.name || 'Root',
		formula: t.formula,
		result_count: t.results?.size ?? 0,
		description: String((t as any).description || '')
			.replace(/<[^>]+>/g, '')
			.trim()
			.slice(0, 150),
	}))

	return JSON.stringify({ tables, count: tables.length })
}

async function handleCreateRolltable(args: Record<string, any>): Promise<string> {
	console.log(`FoundryAI | create_rolltable: name="${args.name}"`)
	const entries: Array<{ text: string; weight?: number }> = args.results
	if (!Array.isArray(entries) || entries.length === 0) {
		return JSON.stringify({ error: 'results must be a non-empty array of { text, weight? } entries' })
	}
	if (entries.some((e) => !e.text || typeof e.text !== 'string')) {
		return JSON.stringify({ error: 'Every result entry needs a non-empty "text" string' })
	}

	try {
		// Assign contiguous ranges from weights: weight N occupies N faces of the die.
		let low = 1
		const resultData = entries.map((e) => {
			const weight = Math.max(1, Math.round(e.weight ?? 1))
			const entry = {
				// v12+ uses string result types; fall back for older CONST shapes.
				type: (globalThis as any).CONST?.TABLE_RESULT_TYPES?.TEXT ?? 'text',
				text: e.text,
				weight,
				range: [low, low + weight - 1],
			}
			low += weight
			return entry
		})
		const dieSize = low - 1

		const data: Record<string, any> = {
			name: args.name,
			description: args.description || '',
			formula: `1d${dieSize}`,
			replacement: true,
			displayRoll: true,
			results: resultData,
		}

		if (args.folder_name) {
			let folder = game.folders?.find((f: any) => f.type === 'RollTable' && f.name === args.folder_name)
			if (!folder) {
				folder = await Folder.create({ name: args.folder_name, type: 'RollTable', parent: null } as any)
			}
			if (folder?.id) data.folder = folder.id
		}

		const table = await RollTable.create(data)
		if (!table) return JSON.stringify({ error: 'Failed to create roll table' })

		return JSON.stringify({
			success: true,
			table_id: table.id,
			name: table.name,
			formula: data.formula,
			result_count: resultData.length,
			message: `Created roll table "${table.name}" (${data.formula}, ${resultData.length} entries). Roll it with roll_table.`,
		})
	} catch (error: any) {
		return JSON.stringify({ error: `Failed to create roll table: ${error.message}` })
	}
}

// ===============================
// SCENE TOOL HANDLERS
// ===============================

function handleListScenes(type?: string): string {
	console.log(`FoundryAI | list_scenes: type="${type}"`)
	if (!game.scenes) return JSON.stringify({ error: 'Scenes not available' })

	const allowedFolders = getSetting('sceneFolders') || []
	console.log(`FoundryAI | list_scenes: allowed scene folders:`, allowedFolders)

	const scenes: Array<Record<string, any>> = []
	let skippedNavigation = 0
	let skippedFolder = 0

	for (const scene of game.scenes.values()) {
		if (type === 'navigation' && !scene.navigation) {
			skippedNavigation++
			continue
		}
		if (!isSceneFolderAllowed(scene.folder?.id)) {
			skippedFolder++
			continue
		}
		scenes.push({
			id: scene.id,
			name: scene.name,
			active: scene.active,
			navigation: scene.navigation,
			folder: scene.folder?.name || null,
			tokenCount: scene.tokens?.size || 0,
		})
	}

	console.log(
		`FoundryAI | list_scenes: found ${scenes.length} scenes, skipped ${skippedNavigation} (navigation), ${skippedFolder} (folder)`,
	)

	return JSON.stringify({ scenes, count: scenes.length })
}

function handleViewScene(sceneId: string): string {
	console.log(`FoundryAI | view_scene: sceneId="${sceneId}"`)
	const scene = game.scenes?.get(sceneId)
	if (!scene) return JSON.stringify({ error: `Scene not found: ${sceneId}` })
	if (!isSceneFolderAllowed(scene.folder?.id)) return JSON.stringify({ error: `Scene not found: ${sceneId}` })

	const details = collectionReader.getSceneDetails(sceneId)
	if (!details) return JSON.stringify({ error: `Scene not found: ${sceneId}` })
	return details
}

async function handleActivateScene(sceneId: string): Promise<string> {
	console.log(`FoundryAI | activate_scene: sceneId="${sceneId}"`)
	const scene = game.scenes?.get(sceneId)
	if (!scene) return JSON.stringify({ error: `Scene not found: ${sceneId}` })
	if (!isSceneFolderAllowed(scene.folder?.id)) return JSON.stringify({ error: `Scene not found: ${sceneId}` })

	await scene.activate()
	return JSON.stringify({
		success: true,
		message: `Activated scene "${scene.name}". All players have been moved to this scene.`,
	})
}

async function handleUpdateScene(args: Record<string, any>): Promise<string> {
	console.log(`FoundryAI | update_scene: sceneId="${args.scene_id}"`)
	const scene = game.scenes?.get(args.scene_id)
	if (!scene) return JSON.stringify({ error: `Scene not found: ${args.scene_id}` })
	try {
		const updates: Record<string, any> = {}

		if (args.name) updates.name = args.name

		if (args.grid_distance || args.grid_units) {
			updates.grid = { ...scene.grid, ...(args.grid_distance ? { distance: args.grid_distance } : {}), ...(args.grid_units ? { units: args.grid_units } : {}) }
		}

		if (args.darkness !== undefined) {
			updates['environment.darknessLevel'] = Math.max(0, Math.min(1, args.darkness))
		}

		let newBackground: string | null = null

		if (args.image_path) {
			newBackground = args.image_path
		} else if (args.prompt) {
			const size = args.size || '1792x1024'
			const imageModel = getSetting('imageModel') || 'openai/dall-e-3'
			const mapPrompt = `Top-down fantasy battle map, grid-friendly, high detail: ${args.prompt}. Style: digital illustration suitable for a tabletop RPG virtual tabletop. No text or labels.`
			const result = await openRouterService.generateImage(mapPrompt, imageModel, size)

			const FP: typeof FilePicker = (foundry as any)?.applications?.apps?.FilePicker?.implementation ?? FilePicker
			const filename = `map-${promptToSlug(args.prompt ?? scene.name)}-${Date.now()}.png`
			await FP.createDirectory('data', 'foundry-ai').catch(() => {})
			await FP.createDirectory('data', 'foundry-ai/maps').catch(() => {})

			if (result.url) {
				const blob = await fetch(result.url).then(r => r.blob())
				const file = new File([blob], filename, { type: 'image/png' })
				const uploadResult = await FP.upload('data', 'foundry-ai/maps', file, {}, { notify: false })
				newBackground = (uploadResult as any)?.path || `foundry-ai/maps/${filename}`
			} else if (result.b64_json) {
				const bytes = atob(result.b64_json)
				const arr = new Uint8Array(bytes.length)
				for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
				const file = new File([arr], filename, { type: 'image/png' })
				const uploadResult = await FP.upload('data', 'foundry-ai/maps', file, {}, { notify: false })
				newBackground = (uploadResult as any)?.path || `foundry-ai/maps/${filename}`
			} else {
				return JSON.stringify({ error: 'No image data in response' })
			}
		}

		if (newBackground) {
			const levels = (scene as any).levels?.contents ?? []
			if (levels.length > 0) {
				const levelsData = levels.map((l: any) => (l.toObject ? l.toObject() : { ...l }))
				levelsData[0].background = { ...(levelsData[0].background ?? {}), src: newBackground }
				updates.levels = levelsData
			} else {
				updates.background = { src: newBackground }
			}
		}

		if (Object.keys(updates).length === 0) return JSON.stringify({ error: 'No updates provided' })

		await scene.update(updates)
		return JSON.stringify({
			success: true,
			scene_id: scene.id,
			scene_name: updates.name ?? scene.name,
			background: newBackground,
			message: `Updated scene "${updates.name ?? scene.name}".`,
		})
	} catch (error: any) {
		return JSON.stringify({ error: `Scene update failed: ${error.message}` })
	}
}

// ===============================
// DICE TOOL HANDLERS
// ===============================

async function handleRollDice(expression: string, label?: string): Promise<string> {
	console.log(`FoundryAI | roll_dice: expression="${expression}", label="${label}"`)
	try {
		const roll = new Roll(expression)
		await roll.evaluate()

		return JSON.stringify({
			formula: roll.formula,
			total: roll.total,
			result: roll.result,
			label: label || null,
			dice: roll.dice?.map((d: any) => ({
				faces: d.faces,
				results: d.results?.map((r: any) => r.result),
			})),
		})
	} catch (error: any) {
		return JSON.stringify({ error: `Invalid dice expression "${expression}": ${error.message}` })
	}
}

async function handleRollCheck(actorId: string, ability: string, type: string): Promise<string> {
	console.log(`FoundryAI | roll_check: actorId="${actorId}", ability="${ability}", type="${type}"`)
	const actor = game.actors?.get(actorId)
	if (!actor) return JSON.stringify({ error: `Actor not found: ${actorId}` })

	try {
		let result: any

		if (type === 'save' && actor.rollAbilitySave) {
			result = await actor.rollAbilitySave(ability, { chatMessage: false })
		} else if (actor.rollAbilityTest) {
			result = await actor.rollAbilityTest(ability, { chatMessage: false })
		} else {
			// Fallback: manual roll with ability modifier
			const mod = actor.system?.abilities?.[ability]?.mod ?? 0
			const roll = new Roll(`1d20+${mod}`)
			await roll.evaluate()
			return JSON.stringify({
				actor: actor.name,
				type: `${ability} ${type}`,
				total: roll.total,
				formula: roll.formula,
				modifier: mod,
			})
		}

		return JSON.stringify({
			actor: actor.name,
			type: `${ability} ${type}`,
			total: result?.total ?? result?.roll?.total ?? null,
			formula: result?.formula ?? result?.roll?.formula ?? null,
		})
	} catch (error: any) {
		return JSON.stringify({ error: `Roll failed: ${error.message}` })
	}
}

// ===============================
// TOKEN TOOL HANDLERS
// ===============================

function getActiveScene(): Scene | null {
	return game.scenes?.contents?.find((s) => s.active) || canvas?.scene || null
}

function getToken(tokenId: string): TokenDocument | null {
	const scene = getActiveScene()
	if (!scene) return null
	return scene.tokens?.get(tokenId) || null
}

async function handlePlaceToken(actorId: string, x: number, y: number, hidden?: boolean): Promise<string> {
	console.log(`FoundryAI | place_token: actorId="${actorId}", x=${x}, y=${y}, hidden=${hidden}`)
	const actor = game.actors?.get(actorId)
	if (!actor) {
		console.log(`FoundryAI | place_token: actor not found in game.actors`)
		return JSON.stringify({ error: `Actor not found: ${actorId}` })
	}
	console.log(
		`FoundryAI | place_token: found actor "${actor.name}" in folder "${actor.folder?.name || 'root'}" (id: ${actor.folder?.id})`,
	)

	if (!isActorFolderAllowed(actor.folder?.id)) {
		console.log(`FoundryAI | place_token: folder not allowed`)
		return actorFolderDeniedError(actor)
	}

	const scene = getActiveScene()
	if (!scene) return JSON.stringify({ error: 'No active scene' })

	const tokenData: any = {
		name: actor.name,
		actorId: actor.id,
		x,
		y,
		hidden: hidden !== false, // Default to hidden=true
		disposition: actor.prototypeToken?.disposition ?? -1,
		texture: { src: actor.prototypeToken?.texture?.src || actor.img },
		width: actor.prototypeToken?.width ?? 1,
		height: actor.prototypeToken?.height ?? 1,
	}

	const created = await scene.createEmbeddedDocuments('Token', [tokenData])
	const token = created[0]

	return JSON.stringify({
		success: true,
		token_id: token?.id || token?._id,
		name: actor.name,
		position: { x, y },
		hidden: tokenData.hidden,
		message: `Placed "${actor.name}" at (${x}, ${y})${tokenData.hidden ? ' — HIDDEN (use reveal_token to show to players)' : ''}`,
	})
}

async function handleMoveToken(tokenId: string, x: number, y: number): Promise<string> {
	console.log(`FoundryAI | move_token: tokenId="${tokenId}", x=${x}, y=${y}`)
	const token = getToken(tokenId)
	if (!token) return JSON.stringify({ error: `Token not found: ${tokenId}` })

	await token.update({ x, y })

	return JSON.stringify({
		success: true,
		name: token.name,
		position: { x, y },
		message: `Moved "${token.name}" to (${x}, ${y})`,
	})
}

async function handleSetTokenVisibility(tokenId: string, hidden: boolean): Promise<string> {
	console.log(`FoundryAI | set_token_visibility: tokenId="${tokenId}", hidden=${hidden}`)
	const token = getToken(tokenId)
	if (!token) return JSON.stringify({ error: `Token not found: ${tokenId}` })

	await token.update({ hidden })

	return JSON.stringify({
		success: true,
		name: token.name,
		hidden,
		message: hidden ? `Hidden "${token.name}" from players` : `Revealed "${token.name}" to players`,
	})
}

async function handleRemoveToken(tokenId: string): Promise<string> {
	console.log(`FoundryAI | remove_token: tokenId="${tokenId}"`)
	const scene = getActiveScene()
	if (!scene) return JSON.stringify({ error: 'No active scene' })

	const token = scene.tokens?.get(tokenId)
	if (!token) return JSON.stringify({ error: `Token not found: ${tokenId}` })

	const name = token.name
	await scene.deleteEmbeddedDocuments('Token', [tokenId])

	return JSON.stringify({
		success: true,
		message: `Removed "${name}" from the scene`,
	})
}

async function handleUpdateToken(args: Record<string, any>): Promise<string> {
	console.log(`FoundryAI | update_token: args=${JSON.stringify(args)}`)
	const token = getToken(args.token_id)
	if (!token) return JSON.stringify({ error: `Token not found: ${args.token_id}` })

	const updateData: Record<string, any> = {}
	if (args.name != null) updateData.name = args.name
	if (args.width != null) updateData.width = args.width
	if (args.height != null) updateData.height = args.height
	if (args.elevation != null) updateData.elevation = args.elevation
	if (args.light_dim != null || args.light_bright != null || args.light_color != null) {
		updateData.light = {
			dim: args.light_dim ?? token.light?.dim ?? 0,
			bright: args.light_bright ?? token.light?.bright ?? 0,
			color: args.light_color ?? token.light?.color ?? '',
		}
	}

	await token.update(updateData)

	return JSON.stringify({
		success: true,
		name: token.name,
		updated: Object.keys(updateData),
		message: `Updated "${token.name}"`,
	})
}

// ===============================
// COMBAT TOOL HANDLERS
// ===============================

function handleGetCombatStatus(): string {
	console.log('FoundryAI | get_combat_status')
	const combat = game.combat
	if (!combat) {
		return JSON.stringify({ active: false, message: 'No active combat.' })
	}
	if (!combat.started) {
		return JSON.stringify({
			active: false,
			message: 'A combat encounter exists but has not started (no initiative rolled / first turn not begun).',
			combatant_count: combat.combatants?.size ?? 0,
		})
	}

	const currentId = combat.combatant?.id ?? null
	const combatants = combat.turns.map((c, idx) => {
		const actor = c.actor as any
		const hp = actor?.system?.attributes?.hp
		const conditions: string[] = actor?.effects?.size
			? (Array.from(actor.effects.values()) as any[])
					.filter((e) => !e.disabled)
					.map((e) => e.name)
					.filter(Boolean)
			: []

		return {
			combatant_id: c.id,
			token_id: c.tokenId,
			name: c.name,
			turn_order: idx,
			is_current_turn: c.id === currentId,
			initiative: c.initiative,
			hp: hp ? `${hp.value ?? '?'}/${hp.max ?? '?'}` : undefined,
			defeated: c.defeated || undefined,
			hidden: c.hidden || undefined,
			conditions: conditions.length ? conditions : undefined,
		}
	})

	return JSON.stringify({
		active: true,
		round: combat.round,
		turn: combat.turn,
		current_combatant: combat.combatant?.name ?? null,
		combatants,
	})
}

async function handleStartCombat(tokenIds?: string[]): Promise<string> {
	console.log(`FoundryAI | start_combat: called with ${tokenIds?.length || 0} tokenIds`)
	const combat = await Combat.create({})
	if (!combat) return JSON.stringify({ error: 'Failed to create combat' })

	if (tokenIds?.length) {
		const scene = getActiveScene()
		const combatantData = tokenIds
			.map((tid) => {
				const token = scene?.tokens?.get(tid)
				if (!token) return null
				return { tokenId: tid, actorId: token.actorId, hidden: token.hidden }
			})
			.filter(Boolean)

		if (combatantData.length) {
			await combat.createEmbeddedDocuments('Combatant', combatantData as any)
		}
	}

	return JSON.stringify({
		success: true,
		combat_id: combat.id,
		combatants: combat.combatants?.size || 0,
		message: `Combat started${tokenIds?.length ? ` with ${tokenIds.length} combatants` : ''}. Use roll_initiative to roll initiative.`,
	})
}

async function handleEndCombat(): Promise<string> {
	console.log(`FoundryAI | end_combat: called`)
	const combat = game.combat
	if (!combat) return JSON.stringify({ error: 'No active combat to end' })

	await combat.endCombat()

	return JSON.stringify({
		success: true,
		message: 'Combat has ended.',
	})
}

async function handleAddToCombat(tokenIds: string[]): Promise<string> {
	console.log(`FoundryAI | add_to_combat: adding ${tokenIds.length} tokens`)
	const combat = game.combat
	if (!combat) return JSON.stringify({ error: 'No active combat. Use start_combat first.' })

	const scene = getActiveScene()
	const combatantData = tokenIds
		.map((tid) => {
			const token = scene?.tokens?.get(tid)
			if (!token) return null
			return { tokenId: tid, actorId: token.actorId, hidden: token.hidden }
		})
		.filter(Boolean)

	if (combatantData.length === 0) {
		return JSON.stringify({ error: 'No valid tokens found for the given IDs' })
	}

	await combat.createEmbeddedDocuments('Combatant', combatantData as any)

	return JSON.stringify({
		success: true,
		added: combatantData.length,
		total: combat.combatants?.size || 0,
		message: `Added ${combatantData.length} combatants to the encounter.`,
	})
}

async function handleRemoveFromCombat(combatantIds: string[]): Promise<string> {
	console.log(`FoundryAI | remove_from_combat: removing ${combatantIds.length} combatants`)
	const combat = game.combat
	if (!combat) return JSON.stringify({ error: 'No active combat' })

	await combat.deleteEmbeddedDocuments('Combatant', combatantIds)

	return JSON.stringify({
		success: true,
		removed: combatantIds.length,
		message: `Removed ${combatantIds.length} combatants from combat.`,
	})
}

async function handleNextTurn(): Promise<string> {
	console.log(`FoundryAI | next_turn: called`)
	const combat = game.combat
	if (!combat) return JSON.stringify({ error: 'No active combat' })

	if (!combat.started) {
		await combat.startCombat()
		return JSON.stringify({
			success: true,
			round: combat.round,
			turn: combat.turn,
			current: combat.combatant?.name || 'Unknown',
			message: `Combat started! Round ${combat.round}, ${combat.combatant?.name || 'Unknown'}'s turn.`,
		})
	}

	await combat.nextTurn()

	return JSON.stringify({
		success: true,
		round: combat.round,
		turn: combat.turn,
		current: combat.combatant?.name || 'Unknown',
		message: `Round ${combat.round}: ${combat.combatant?.name || 'Unknown'}'s turn.`,
	})
}

async function handleRollInitiative(combatantIds?: string[]): Promise<string> {
	console.log(`FoundryAI | roll_initiative: called with ${combatantIds?.length || 0} combatantIds`)
	const combat = game.combat
	if (!combat) return JSON.stringify({ error: 'No active combat' })

	// If no IDs specified, roll for all unrolled combatants
	let ids = combatantIds
	if (!ids?.length) {
		ids = Array.from(combat.combatants.values())
			.filter((c: any) => c.initiative == null)
			.map((c: any) => c.id)
	}

	if (ids.length === 0) {
		return JSON.stringify({ message: 'All combatants already have initiative.' })
	}

	await combat.rollInitiative(ids)

	const order = Array.from(combat.combatants.values())
		.sort((a: any, b: any) => (b.initiative ?? -999) - (a.initiative ?? -999))
		.map((c: any) => ({ name: c.name, initiative: c.initiative }))

	return JSON.stringify({
		success: true,
		rolled: ids.length,
		order,
		message: `Rolled initiative for ${ids.length} combatants.`,
	})
}

async function handleApplyDamage(tokenId: string, amount: number, type: string): Promise<string> {
	console.log(`FoundryAI | apply_damage: tokenId="${tokenId}", amount=${amount}, type="${type}"`)
	const token = getToken(tokenId)
	if (!token) return JSON.stringify({ error: `Token not found: ${tokenId}` })

	const actor = token.actor
	if (!actor) return JSON.stringify({ error: `Token "${token.name}" has no associated actor` })

	const hp = actor.system?.attributes?.hp
	if (hp == null) return JSON.stringify({ error: `Cannot access HP for "${actor.name}"` })

	const currentHp = hp.value ?? 0
	const maxHp = hp.max ?? currentHp

	// Direction comes from `type`; treat amount as a magnitude. Without this, a
	// negative amount with type "damage" would *heal* — and bypass the max-HP cap.
	amount = Math.abs(amount)

	let newHp: number
	if (type === 'healing') {
		newHp = Math.min(currentHp + amount, maxHp)
	} else {
		newHp = Math.max(currentHp - amount, 0)
	}

	await actor.update({ 'system.attributes.hp.value': newHp })

	return JSON.stringify({
		success: true,
		name: actor.name,
		previousHp: currentHp,
		newHp,
		maxHp,
		change: type === 'healing' ? `+${amount}` : `-${amount}`,
		message: `${type === 'healing' ? 'Healed' : 'Damaged'} "${actor.name}" for ${amount} HP (${currentHp} → ${newHp}/${maxHp})`,
	})
}

async function handleApplyCondition(tokenId: string, condition: string): Promise<string> {
	console.log(`FoundryAI | apply_condition: tokenId="${tokenId}", condition="${condition}"`)
	const token = getToken(tokenId)
	if (!token) return JSON.stringify({ error: `Token not found: ${tokenId}` })

	const actor = token.actor
	if (!actor) return JSON.stringify({ error: `Token "${token.name}" has no associated actor` })

	// Try to find matching status effect in CONFIG
	const conditionLower = condition.toLowerCase()
	const statusEffect = CONFIG.statusEffects?.find(
		(e: any) => e.id?.toLowerCase() === conditionLower || e.name?.toLowerCase() === conditionLower,
	)

	if (statusEffect) {
		// Use Foundry's built-in status effect
		const effectData: Record<string, any> = {
			name: statusEffect.name || condition,
			icon: statusEffect.icon || 'icons/svg/aura.svg',
			'flags.core.statusId': statusEffect.id,
			statuses: [statusEffect.id],
		}
		await actor.createEmbeddedDocuments('ActiveEffect', [effectData] as any)
	} else {
		// Create a custom effect
		const effectData: Record<string, any> = {
			name: condition.charAt(0).toUpperCase() + condition.slice(1),
			icon: 'icons/svg/aura.svg',
			statuses: [conditionLower],
		}
		await (actor as any).createEmbeddedDocuments('ActiveEffect', [effectData])
	}

	return JSON.stringify({
		success: true,
		name: actor.name,
		condition,
		message: `Applied "${condition}" to "${actor.name}"`,
	})
}

async function handleRemoveCondition(tokenId: string, condition: string): Promise<string> {
	console.log(`FoundryAI | remove_condition: tokenId="${tokenId}", condition="${condition}"`)
	const token = getToken(tokenId)
	if (!token) return JSON.stringify({ error: `Token not found: ${tokenId}` })

	const actor = token.actor
	if (!actor) return JSON.stringify({ error: `Token "${token.name}" has no associated actor` })

	const conditionLower = condition.toLowerCase()
	const effect = Array.from(actor.effects.values()).find(
		(e: any) =>
			e.name?.toLowerCase() === conditionLower ||
			e.statuses?.has?.(conditionLower) ||
			e.flags?.core?.statusId?.toLowerCase() === conditionLower,
	)

	if (!effect) {
		return JSON.stringify({ error: `Condition "${condition}" not found on "${actor.name}"` })
	}

	await effect.delete()

	return JSON.stringify({
		success: true,
		name: actor.name,
		condition,
		message: `Removed "${condition}" from "${actor.name}"`,
	})
}

// ===============================
// AUDIO TOOL HANDLERS
// ===============================

function handleListPlaylists(): string {
	console.log(`FoundryAI | list_playlists: called`)
	if (!game.playlists) return JSON.stringify({ error: 'Playlists not available' })
	console.log(`FoundryAI | list_playlists: ${game.playlists.size} playlists available`)

	const playlists: Array<Record<string, any>> = []
	for (const playlist of game.playlists.values()) {
		const tracks = Array.from(playlist.sounds?.values() || []).map((s: any) => ({
			name: s.name,
			playing: s.playing || false,
		}))

		playlists.push({
			id: playlist.id,
			name: playlist.name,
			playing: playlist.playing,
			trackCount: tracks.length,
			tracks,
		})
	}

	return JSON.stringify({ playlists, count: playlists.length })
}

async function handlePlayPlaylist(playlistId: string): Promise<string> {
	console.log(`FoundryAI | play_playlist: playlistId="${playlistId}"`)
	const playlist = game.playlists?.get(playlistId)
	if (!playlist) return JSON.stringify({ error: `Playlist not found: ${playlistId}` })

	await playlist.playAll()

	return JSON.stringify({
		success: true,
		name: playlist.name,
		message: `Now playing "${playlist.name}"`,
	})
}

async function handleStopPlaylist(playlistId?: string): Promise<string> {
	console.log(`FoundryAI | stop_playlist: playlistId="${playlistId || 'all'}"`)
	if (playlistId) {
		const playlist = game.playlists?.get(playlistId)
		if (!playlist) return JSON.stringify({ error: `Playlist not found: ${playlistId}` })

		await playlist.stopAll()

		return JSON.stringify({
			success: true,
			message: `Stopped "${playlist.name}"`,
		})
	}

	// Stop all playlists
	if (game.playlists) {
		for (const playlist of game.playlists.values()) {
			if (playlist.playing) {
				await playlist.stopAll()
			}
		}
	}

	return JSON.stringify({
		success: true,
		message: 'Stopped all playlists',
	})
}

async function handlePlayTrack(playlistId: string, trackName: string): Promise<string> {
	console.log(`FoundryAI | play_track: playlistId="${playlistId}", trackName="${trackName}"`)
	const playlist = game.playlists?.get(playlistId)
	if (!playlist) return JSON.stringify({ error: `Playlist not found: ${playlistId}` })

	const sound = Array.from(playlist.sounds?.values() || []).find(
		(s: any) => s.name?.toLowerCase() === trackName.toLowerCase(),
	)

	if (!sound) return JSON.stringify({ error: `Track "${trackName}" not found in "${playlist.name}"` })

	await playlist.playSound(sound)

	return JSON.stringify({
		success: true,
		playlist: playlist.name,
		track: sound.name,
		message: `Now playing "${sound.name}" from "${playlist.name}"`,
	})
}

// ===============================
// CHAT TOOL HANDLERS
// ===============================

async function handlePostChatMessage(content: string, speakerName?: string, whisperTo?: string[]): Promise<string> {
	console.log(`FoundryAI | post_chat_message: content="${content.substring(0, 50)}...", speaker="${speakerName}"`)
	const messageData: Record<string, any> = { content }

	if (speakerName) {
		messageData.speaker = { alias: speakerName }
	}

	if (whisperTo?.length) {
		// Resolve player names to user IDs
		const userIds = whisperTo
			.map((name) => {
				const user = game.users?.find((u: any) => u.name?.toLowerCase() === name.toLowerCase())
				return user?.id
			})
			.filter(Boolean) as string[]

		if (userIds.length) {
			messageData.whisper = userIds
		}
	}

	const msg = await ChatMessage.create(messageData as Parameters<typeof ChatMessage.create>[0])

	return JSON.stringify({
		success: true,
		id: msg.id,
		message: speakerName
			? `Posted message as "${speakerName}"${whisperTo?.length ? ` (whispered to ${whisperTo.join(', ')})` : ''}`
			: `Posted narration to chat${whisperTo?.length ? ` (whispered to ${whisperTo.join(', ')})` : ''}`,
	})
}

// ===============================
// COMPENDIUM TOOL HANDLERS
// ===============================

async function handleSearchCompendium(query: string, type?: string, maxResults?: number): Promise<string> {
	if (!game.packs) return JSON.stringify({ error: 'Compendium packs not available' })

	const max = maxResults || 10
	const queryLower = query.toLowerCase()
	const results: Array<Record<string, any>> = []
	const typeFilter = type ? type.toLowerCase() : null

	console.log(`FoundryAI | search_compendium: query="${query}", type="${type}", typeFilter="${typeFilter}"`)
	console.log(`FoundryAI | search_compendium: ${game.packs.size} packs available`)

	let packsSearched = 0
	let entriesSearched = 0

	for (const [packId, pack] of game.packs) {
		if (!pack) continue
		// Convert type to lowercase for comparison
		const packType = pack.documentName?.toLowerCase()
		if (typeFilter && typeFilter !== 'all' && packType !== typeFilter) continue

		packsSearched++

		// Ensure index is loaded
		try {
			await pack.getIndex()
		} catch {
			continue
		}

		for (const [, entry] of pack.index) {
			entriesSearched++
			if (entry.name?.toLowerCase().includes(queryLower)) {
				results.push({
					pack_id: packId,
					entry_id: entry._id,
					name: entry.name,
					type: pack.documentName,
					pack_label: pack.metadata.label,
					img: entry.img || null,
				})

				if (results.length >= max) break
			}
		}

		if (results.length >= max) break
	}

	console.log(
		`FoundryAI | search_compendium: searched ${packsSearched} packs, ${entriesSearched} entries, found ${results.length} matches`,
	)

	return JSON.stringify({ results, count: results.length })
}

async function handleGetCompendiumEntry(packId: string, entryId: string): Promise<string> {
	console.log(`FoundryAI | get_compendium_entry: packId="${packId}", entryId="${entryId}"`)
	if (!game.packs) return JSON.stringify({ error: 'Compendium packs not available' })

	const pack = game.packs.get(packId)
	if (!pack) {
		console.log(`FoundryAI | get_compendium_entry: pack not found`)
		return JSON.stringify({ error: `Pack not found: ${packId}` })
	}
	console.log(`FoundryAI | get_compendium_entry: found pack "${pack.metadata.label}" (type: ${pack.documentName})`)

	try {
		const doc = await pack.getDocument(entryId)
		if (!doc) return JSON.stringify({ error: `Entry not found: ${entryId}` })

		// Extract based on document type
		if (pack.documentName === 'Actor') {
			const content = collectionReader.getActorContent(doc.id) || collectionReader['extractActorContent'](doc as any)
			return JSON.stringify({
				id: doc.id,
				name: doc.name,
				type: (doc as any).type || pack.documentName,
				pack: packId,
				content: content || `Actor: ${doc.name}`,
			})
		}

		if (pack.documentName === 'Item') {
			const item = doc as any
			return JSON.stringify({
				id: doc.id,
				name: doc.name,
				type: item.type || 'item',
				pack: packId,
				description: item.system?.description?.value || '',
				img: item.img || null,
			})
		}

		if (pack.documentName === 'JournalEntry') {
			const content = collectionReader.getJournalContent(doc.id) || `Journal: ${doc.name}`
			return JSON.stringify({
				id: doc.id,
				name: doc.name,
				type: 'JournalEntry',
				pack: packId,
				content,
			})
		}

		return JSON.stringify({
			id: doc.id,
			name: doc.name,
			type: pack.documentName,
			pack: packId,
		})
	} catch (error: any) {
		return JSON.stringify({ error: `Failed to load entry: ${error.message}` })
	}
}

async function handleImportFromCompendium(packId: string, entryId: string, folderId?: string): Promise<string> {
	console.log(`FoundryAI | import_from_compendium: packId="${packId}", entryId="${entryId}", folderId="${folderId}"`)
	if (!game.packs) return JSON.stringify({ error: 'Compendium packs not available' })

	const pack = game.packs.get(packId)
	if (!pack) {
		console.log(`FoundryAI | import_from_compendium: pack not found`)
		return JSON.stringify({ error: `Pack not found: ${packId}` })
	}
	console.log(`FoundryAI | import_from_compendium: found pack "${pack.metadata.label}" (type: ${pack.documentName})`)

	try {
		const doc = await pack.getDocument(entryId)
		if (!doc) return JSON.stringify({ error: `Entry not found: ${entryId}` })

		const importData: Record<string, any> = { folder: folderId || null }
		const imported = await pack.importDocument(doc, importData)

		return JSON.stringify({
			success: true,
			id: imported.id,
			name: imported.name,
			type: pack.documentName,
			message: `Imported "${imported.name}" from compendium "${pack.metadata.label}" into the world.`,
		})
	} catch (error: any) {
		return JSON.stringify({ error: `Import failed: ${error.message}` })
	}
}

// ===============================
// SPATIAL TOOL HANDLERS
// ===============================

function handleMeasureDistance(args: Record<string, any>): string {
	console.log(`FoundryAI | measure_distance: args=${JSON.stringify(args)}`)
	const scene = getActiveScene()
	if (!scene) return JSON.stringify({ error: 'No active scene' })

	let fromX: number, fromY: number, toX: number, toY: number

	if (args.from_token_id) {
		const token = scene.tokens?.get(args.from_token_id)
		if (!token) return JSON.stringify({ error: `Token not found: ${args.from_token_id}` })
		fromX = token.x
		fromY = token.y
	} else {
		fromX = args.from_x ?? 0
		fromY = args.from_y ?? 0
	}

	if (args.to_token_id) {
		const token = scene.tokens?.get(args.to_token_id)
		if (!token) return JSON.stringify({ error: `Token not found: ${args.to_token_id}` })
		toX = token.x
		toY = token.y
	} else {
		toX = args.to_x ?? 0
		toY = args.to_y ?? 0
	}

	// Calculate pixel distance, then convert to grid units
	const dx = toX - fromX
	const dy = toY - fromY
	const pixelDist = Math.sqrt(dx * dx + dy * dy)
	const gridSize = scene.grid?.size || 100
	const gridDistance = scene.grid?.distance || 5
	const units = scene.grid?.units || 'ft'
	const distance = Math.round((pixelDist / gridSize) * gridDistance)

	return JSON.stringify({
		distance,
		units,
		pixels: Math.round(pixelDist),
		message: `Distance: ${distance} ${units}`,
	})
}

function handleTokensInRange(args: Record<string, any>): string {
	console.log(`FoundryAI | tokens_in_range: args=${JSON.stringify(args)}`)
	const scene = getActiveScene()
	if (!scene) return JSON.stringify({ error: 'No active scene' })

	let centerX: number, centerY: number

	if (args.token_id) {
		const token = scene.tokens?.get(args.token_id)
		if (!token) return JSON.stringify({ error: `Token not found: ${args.token_id}` })
		centerX = token.x
		centerY = token.y
	} else {
		centerX = args.x ?? 0
		centerY = args.y ?? 0
	}

	const range = args.range
	const gridSize = scene.grid?.size || 100
	const gridDistance = scene.grid?.distance || 5
	const rangePixels = (range / gridDistance) * gridSize

	const tokensInRange: Array<Record<string, any>> = []

	for (const token of scene.tokens?.values() || []) {
		if (args.token_id && token.id === args.token_id) continue // Skip self

		const dx = token.x - centerX
		const dy = token.y - centerY
		const dist = Math.sqrt(dx * dx + dy * dy)

		if (dist <= rangePixels) {
			const gridDist = Math.round((dist / gridSize) * gridDistance)
			const disp = token.disposition === 1 ? 'friendly' : token.disposition === 0 ? 'neutral' : 'hostile'

			tokensInRange.push({
				token_id: token.id,
				name: token.name,
				distance: gridDist,
				disposition: disp,
				hidden: token.hidden,
			})
		}
	}

	tokensInRange.sort((a, b) => a.distance - b.distance)

	return JSON.stringify({
		center: args.token_id ? `token ${args.token_id}` : `(${centerX}, ${centerY})`,
		range: `${range} ${scene.grid?.units || 'ft'}`,
		tokens: tokensInRange,
		count: tokensInRange.length,
	})
}

async function handleCreateSceneRegion(args: Record<string, any>): Promise<string> {
	console.log(`FoundryAI | create_scene_region: args=${JSON.stringify(args)}`)
	const scene = getActiveScene()
	if (!scene) return JSON.stringify({ error: 'No active scene' })

	const gridSize: number = scene.grid?.size || 100
	const gridDistance: number = scene.grid?.distance || 5
	const distancePx = (args.distance / gridDistance) * gridSize
	const x: number = args.x
	const y: number = args.y
	const dirRad = ((args.direction ?? 0) * Math.PI) / 180

	let shape: Record<string, any>

	switch (args.type) {
		case 'circle':
			shape = { type: 'circle', x, y, radius: distancePx }
			break
		case 'rect':
			shape = { type: 'rectangle', x: x - distancePx / 2, y: y - distancePx / 2, width: distancePx, height: distancePx, rotation: 0 }
			break
		case 'cone': {
			// Standard D&D cone: 53.13° arc (26.565° half-angle)
			const halfAngle = (53.13 / 2) * (Math.PI / 180)
			shape = {
				type: 'polygon',
				points: [
					x, y,
					x + distancePx * Math.cos(dirRad - halfAngle), y + distancePx * Math.sin(dirRad - halfAngle),
					x + distancePx * Math.cos(dirRad + halfAngle), y + distancePx * Math.sin(dirRad + halfAngle),
				],
			}
			break
		}
		case 'ray': {
			const widthPx = (((args.width ?? 5) / gridDistance) * gridSize) / 2
			const perpRad = dirRad + Math.PI / 2
			const ex = x + distancePx * Math.cos(dirRad)
			const ey = y + distancePx * Math.sin(dirRad)
			shape = {
				type: 'polygon',
				points: [
					x  + widthPx * Math.cos(perpRad), y  + widthPx * Math.sin(perpRad),
					ex + widthPx * Math.cos(perpRad), ey + widthPx * Math.sin(perpRad),
					ex - widthPx * Math.cos(perpRad), ey - widthPx * Math.sin(perpRad),
					x  - widthPx * Math.cos(perpRad), y  - widthPx * Math.sin(perpRad),
				],
			}
			break
		}
		default:
			return JSON.stringify({ error: `Unknown shape type: ${args.type}` })
	}

	const regionData = {
		name: `${args.type.charAt(0).toUpperCase() + args.type.slice(1)} Area`,
		color: args.color || '#FF0000',
		shapes: [shape],
	}

	const created = await scene.createEmbeddedDocuments('Region', [regionData])

	return JSON.stringify({
		success: true,
		region_id: created[0]?.id,
		type: args.type,
		position: { x, y },
		distance: args.distance,
		message: `Created ${args.type} region (${args.distance}${scene.grid?.units || 'ft'}) at (${x}, ${y})`,
	})
}

// ===============================
// ACTOR TOOL HANDLERS
// ===============================

async function handleCreateActor(
	name: string,
	type?: string,
	data?: Record<string, any>,
	img?: string,
	folderName?: string,
	folderId?: string,
): Promise<string> {
	console.log(`FoundryAI | create_actor: name="${name}", type="${type}", folderName="${folderName}"`)

	const resolved = await resolveManagedFolder(folderName, folderId, 'Actor')
	if (resolved.error) return JSON.stringify({ error: resolved.error })
	const resolvedFolderId = resolved.folderId

	const actorData: Record<string, any> = {
		name,
		type: type || 'npc',
	}

	if (resolvedFolderId) actorData.folder = resolvedFolderId
	if (img) actorData.img = img

	// Separate items from the rest of the data — they must be added via createEmbeddedDocuments
	let itemsToAdd: any[] = []
	if (data) {
		for (const [key, value] of Object.entries(data)) {
			if (key === 'items' && Array.isArray(value)) {
				itemsToAdd = value
			} else {
				actorData[key] = value
			}
		}
	}

	const actor = await Actor.create(actorData)

	if (itemsToAdd.length > 0) {
		await actor.createEmbeddedDocuments('Item', itemsToAdd)
	}

	return JSON.stringify({
		success: true,
		id: actor.id,
		name: actor.name,
		type: actor.type,
		folder: folderName || 'Root',
		message: `Created actor "${name}" (${type || 'npc'}) in folder "${folderName || 'Root'}"`,
	})
}

async function handleUpdateActor(actorId: string, data: Record<string, any>): Promise<string> {
	console.log(`FoundryAI | update_actor: actorId="${actorId}"`)
	const actor = game.actors?.get(actorId)
	if (!actor) return JSON.stringify({ error: `Actor not found: ${actorId}` })

	if (!isActorFolderAllowed(actor.folder?.id)) {
		return actorFolderDeniedError(actor)
	}

	await actor.update(data)

	return JSON.stringify({
		success: true,
		id: actorId,
		name: actor.name,
		message: `Updated actor "${actor.name}"`,
	})
}

async function handleAddItemsToActor(
	actorId: string,
	items: Array<{ name: string; type: string; img?: string; data?: Record<string, any> }>,
): Promise<string> {
	console.log(`FoundryAI | add_items_to_actor: actorId="${actorId}", items=${items.length}`)
	const actor = game.actors?.get(actorId)
	if (!actor) return JSON.stringify({ error: `Actor not found: ${actorId}` })

	if (!isActorFolderAllowed(actor.folder?.id)) {
		return actorFolderDeniedError(actor)
	}

	const itemData = items.map((item) => {
		const base: Record<string, any> = {
			name: item.name,
			type: item.type,
		}
		if (item.img) base.img = item.img
		if (item.data) {
			for (const [key, value] of Object.entries(item.data)) {
				base[key] = value
			}
		}
		return base
	})

	const created = await actor.createEmbeddedDocuments('Item', itemData)

	return JSON.stringify({
		success: true,
		actor_id: actorId,
		actor_name: actor.name,
		items_added: created.map((i: any) => ({ id: i.id, name: i.name, type: i.type })),
		count: created.length,
		message: `Added ${created.length} item(s) to "${actor.name}"`,
	})
}

async function handleRemoveItemFromActor(actorId: string, itemId: string): Promise<string> {
	console.log(`FoundryAI | remove_item_from_actor: actorId="${actorId}", itemId="${itemId}"`)
	const actor = game.actors?.get(actorId)
	if (!actor) return JSON.stringify({ error: `Actor not found: ${actorId}` })

	if (!isActorFolderAllowed(actor.folder?.id)) {
		return actorFolderDeniedError(actor)
	}

	const item = actor.items?.get(itemId)
	if (!item) return JSON.stringify({ error: `Item not found on actor: ${itemId}` })

	const itemName = item.name
	await actor.deleteEmbeddedDocuments('Item', [itemId])

	return JSON.stringify({
		success: true,
		message: `Removed "${itemName}" from "${actor.name}"`,
	})
}

async function handleUpdateActorItem(actorId: string, itemId: string, data: Record<string, any>): Promise<string> {
	console.log(`FoundryAI | update_actor_item: actorId="${actorId}", itemId="${itemId}"`)
	const actor = game.actors?.get(actorId)
	if (!actor) return JSON.stringify({ error: `Actor not found: ${actorId}` })

	if (!isActorFolderAllowed(actor.folder?.id)) {
		return actorFolderDeniedError(actor)
	}

	const item = actor.items?.get(itemId)
	if (!item) return JSON.stringify({ error: `Item not found on actor: ${itemId}` })

	await item.update(data)

	return JSON.stringify({
		success: true,
		message: `Updated "${item.name}" on "${actor.name}"`,
	})
}

// ===============================
// ITEM TOOL HANDLERS
// ===============================

async function handleCreateItem(
	name: string,
	type: string,
	data?: Record<string, any>,
	img?: string,
	folderName?: string,
	folderId?: string,
): Promise<string> {
	console.log(`FoundryAI | create_item: name="${name}", type="${type}"`)

	let resolvedFolderId = folderId || null

	if (folderName && !resolvedFolderId) {
		let folder = game.folders?.find((f: any) => f.type === 'Item' && f.name === folderName)
		if (!folder) {
			folder = await Folder.create({ name: folderName, type: 'Item', parent: null } as any)
		}
		resolvedFolderId = folder?.id || null
	}

	const itemData: Record<string, any> = {
		name,
		type: type || 'loot',
	}

	if (resolvedFolderId) itemData.folder = resolvedFolderId
	if (img) itemData.img = img

	if (data) {
		for (const [key, value] of Object.entries(data)) {
			itemData[key] = value
		}
	}

	const item = await Item.create(itemData)

	return JSON.stringify({
		success: true,
		id: item.id,
		name: item.name,
		type: item.type,
		message: `Created item "${name}" (${type})`,
	})
}

function handleGetItem(itemId: string): string {
	console.log(`FoundryAI | get_item: itemId="${itemId}"`)
	const item = game.items?.get(itemId)
	if (!item) return JSON.stringify({ error: `Item not found: ${itemId}` })

	const desc = (item as any).system?.description?.value || (item as any).system?.description || ''
	const cleanDesc = typeof desc === 'string' ? desc.replace(/<[^>]+>/g, '').trim() : ''

	return JSON.stringify({
		id: item.id,
		name: item.name,
		type: item.type,
		img: item.img,
		folder: (item as any).folder?.name || 'Root',
		description: cleanDesc.slice(0, 2000),
		system: (item as any).system,
	})
}

async function handleUpdateItem(itemId: string, data: Record<string, any>): Promise<string> {
	console.log(`FoundryAI | update_item: itemId="${itemId}"`)
	const item = game.items?.get(itemId)
	if (!item) return JSON.stringify({ error: `Item not found: ${itemId}` })

	await item.update(data)

	return JSON.stringify({
		success: true,
		id: itemId,
		name: item.name,
		message: `Updated item "${item.name}"`,
	})
}

async function handleDeleteItem(itemId: string): Promise<string> {
	console.log(`FoundryAI | delete_item: itemId="${itemId}"`)
	const item = game.items?.get(itemId)
	if (!item) return JSON.stringify({ error: `Item not found: ${itemId}` })

	const itemName = item.name
	await item.delete()

	return JSON.stringify({
		success: true,
		message: `Deleted item "${itemName}"`,
	})
}

function handleListItems(type?: string, maxResults?: number, name?: string): string {
	console.log(`FoundryAI | list_items: type="${type}", maxResults=${maxResults}, name="${name}"`)
	if (!game.items) return JSON.stringify({ error: 'Items collection not available' })

	const max = maxResults || 20
	const nameLower = name?.toLowerCase()
	const items: Array<{ id: string; name: string; type: string; folder: string }> = []

	for (const item of game.items.values()) {
		if (type && item.type !== type) continue
		if (nameLower && !item.name?.toLowerCase().includes(nameLower)) continue
		items.push({
			id: item.id,
			name: item.name,
			type: item.type,
			folder: (item as any).folder?.name || 'Root',
		})
		if (items.length >= max) break
	}

	return JSON.stringify({ items, count: items.length })
}

// ===============================
// MACRO TOOL HANDLERS
// ===============================

function handleListMacros(): string {
	console.log(`FoundryAI | list_macros`)
	if (!game.macros) return JSON.stringify({ error: 'Macros collection not available' })

	const macros: Array<{ id: string; name: string; type: string; folder: string }> = []

	for (const macro of game.macros.values()) {
		if (!isMacroFolderAllowed((macro as any).folder?.id)) continue

		macros.push({
			id: macro.id,
			name: macro.name,
			type: macro.type,
			folder: (macro as any).folder?.name || 'Root',
		})
	}

	return JSON.stringify({ macros, count: macros.length })
}

function handleGetMacro(macroId: string): string {
	console.log(`FoundryAI | get_macro: macroId="${macroId}"`)
	const macro = game.macros?.get(macroId)
	if (!macro) return JSON.stringify({ error: `Macro not found: ${macroId}` })

	if (!isMacroFolderAllowed((macro as any).folder?.id)) {
		return JSON.stringify({ error: `Macro not found: ${macroId}` })
	}

	return JSON.stringify({
		id: macro.id,
		name: macro.name,
		type: macro.type,
		command: macro.command,
		folder: (macro as any).folder?.name || 'Root',
		img: macro.img,
	})
}

async function handleCreateMacro(
	name: string,
	type?: string,
	command?: string,
	img?: string,
	folderName?: string,
	folderId?: string,
): Promise<string> {
	console.log(`FoundryAI | create_macro: name="${name}", type="${type}"`)

	const resolved = await resolveManagedFolder(folderName, folderId, 'Macro')
	if (resolved.error) return JSON.stringify({ error: resolved.error })
	const resolvedFolderId = resolved.folderId

	const macroData: Record<string, any> = {
		name,
		type: type || 'script',
		command: command || '',
	}

	if (resolvedFolderId) macroData.folder = resolvedFolderId
	if (img) macroData.img = img

	const macro = await Macro.create(macroData)

	return JSON.stringify({
		success: true,
		id: macro.id,
		name: macro.name,
		type: macro.type,
		message: `Created macro "${name}" (${type || 'script'})`,
	})
}

async function handleUpdateMacro(macroId: string, name?: string, command?: string): Promise<string> {
	console.log(`FoundryAI | update_macro: macroId="${macroId}"`)
	const macro = game.macros?.get(macroId)
	if (!macro) return JSON.stringify({ error: `Macro not found: ${macroId}` })

	if (!isMacroFolderAllowed((macro as any).folder?.id)) {
		return JSON.stringify({ error: `Macro not found: ${macroId}` })
	}

	const updateData: Record<string, any> = {}
	if (name) updateData.name = name
	if (command) updateData.command = command

	await macro.update(updateData)

	return JSON.stringify({
		success: true,
		id: macroId,
		message: `Updated macro "${macro.name}"`,
	})
}

async function handleExecuteMacro(macroId: string): Promise<string> {
	console.log(`FoundryAI | execute_macro: macroId="${macroId}"`)
	const macro = game.macros?.get(macroId)
	if (!macro) return JSON.stringify({ error: `Macro not found: ${macroId}` })

	if (!isMacroFolderAllowed((macro as any).folder?.id)) {
		return JSON.stringify({ error: `Macro not found: ${macroId}` })
	}

	try {
		const result = await macro.execute()
		const resultStr = result !== undefined && result !== null ? String(result) : 'Macro executed (no return value)'

		return JSON.stringify({
			success: true,
			macro_name: macro.name,
			result: resultStr,
			message: `Executed macro "${macro.name}"`,
		})
	} catch (error: any) {
		return JSON.stringify({
			error: `Macro execution failed: ${error.message}`,
			macro_name: macro.name,
		})
	}
}

// ===============================
// IMAGE & SCENE GENERATION HANDLERS
// ===============================

function promptToSlug(prompt: string, maxWords = 7): string {
	return prompt
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, '')
		.trim()
		.split(/\s+/)
		.slice(0, maxWords)
		.join('-')
}

/**
 * Recursively browse a directory tree, collecting every file found at any depth.
 * extract_pdf_images and organize_images both nest files a level or two below
 * foundry-ai/images/ (per-PDF and per-category subfolders), so a flat browse()
 * silently misses them — which previously left the AI with no way to look up
 * real paths and led it to invent plausible-looking ones instead.
 */
const ASSET_IMAGE_EXT = /\.(png|webp|jpe?g|gif|svg|avif|webm)$/i
const LIST_ASSETS_MAX_RESULTS = 300

async function browseFilesRecursive(
	FP: any,
	dir: string,
	type: string,
	results: { path: string; name: string; type: string }[],
	depth = 0,
	maxResults = Infinity,
): Promise<void> {
	if (depth > 5 || results.length >= maxResults) return // safety guard against pathological/huge directory trees
	let browse: any
	try {
		browse = await FP.browse('data', dir)
	} catch {
		return // directory may not exist yet
	}
	for (const file of browse.files ?? []) {
		if (results.length >= maxResults) return
		if (!ASSET_IMAGE_EXT.test(file)) continue
		const name = file.split('/').pop() ?? file
		results.push({ path: file, name, type })
	}
	for (const subdir of browse.dirs ?? []) {
		if (results.length >= maxResults) return
		await browseFilesRecursive(FP, subdir, type, results, depth + 1, maxResults)
	}
}

async function handleListAssets(directory?: string, search?: string): Promise<string> {
	try {
		const FP: typeof FilePicker = (foundry as any)?.applications?.apps?.FilePicker?.implementation ?? FilePicker
		const results: { path: string; name: string; type: string }[] = []

		const trimmedDir = directory?.trim().replace(/^\/+|\/+$/g, '')
		const browseDirs = trimmedDir
			? [{ dir: trimmedDir, type: 'image' }]
			: [
				{ dir: 'foundry-ai/images', type: 'image' },
				{ dir: 'foundry-ai/maps', type: 'map' },
			]

		for (const { dir, type } of browseDirs) {
			await browseFilesRecursive(FP, dir, type, results, 0, LIST_ASSETS_MAX_RESULTS)
			if (results.length >= LIST_ASSETS_MAX_RESULTS) break
		}

		let assets = results
		if (search?.trim()) {
			const q = search.trim().toLowerCase()
			assets = assets.filter(a => a.name.toLowerCase().includes(q))
		}

		if (assets.length === 0) {
			return JSON.stringify({
				assets: [],
				message: trimmedDir ? `No image files found under "${trimmedDir}".` : 'No generated assets found yet.',
			})
		}

		const truncated = results.length >= LIST_ASSETS_MAX_RESULTS
		return JSON.stringify({
			assets,
			...(truncated ? { truncated: true } : {}),
			message: `Found ${assets.length} asset(s)${truncated ? ` (stopped at ${LIST_ASSETS_MAX_RESULTS} — narrow with "search" or a more specific "directory")` : ''}. Use the "path" value exactly as given when referencing an asset — never guess or invent a path.`,
		})
	} catch (error: any) {
		return JSON.stringify({ error: `Failed to list assets: ${error.message}` })
	}
}

async function handleDescribeImage(imagePath: string, question?: string): Promise<string> {
	console.log(`FoundryAI | describe_image: path="${imagePath}"`)
	try {
		// Fetch the image in the browser and encode as base64 so the vision model
		// receives the raw data rather than a localhost URL it can't reach itself
		const imageUrl = `${window.location.origin}/${imagePath}`
		const imgResponse = await fetch(imageUrl)
		if (!imgResponse.ok) return JSON.stringify({ error: `Could not fetch image: ${imgResponse.status} ${imgResponse.statusText}` })

		const blob = await imgResponse.blob()
		const base64 = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader()
			reader.onload = () => resolve((reader.result as string))
			reader.onerror = reject
			reader.readAsDataURL(blob)
		})

		const q = question || 'Describe this image in detail — what it depicts, its style, and any notable features.'
		const description = await openRouterService.describeImage(base64, q)
		return JSON.stringify({ success: true, description })
	} catch (error: any) {
		return JSON.stringify({ error: `Image description failed: ${error.message}` })
	}
}

async function handleOrganizeImages(imagePaths: unknown, destinationRoot?: string): Promise<string> {
	if (!Array.isArray(imagePaths) || imagePaths.length === 0) {
		return JSON.stringify({ error: 'image_paths must contain at least one image path.' })
	}

	console.log(`FoundryAI | organize_images: organizing ${imagePaths.length} image(s)${destinationRoot ? ` into "${destinationRoot}"` : ''}`)
	const FP: typeof FilePicker = (foundry as any)?.applications?.apps?.FilePicker?.implementation ?? FilePicker
	const results: Array<Record<string, any>> = []

	for (const imagePath of imagePaths) {
		if (typeof imagePath !== 'string' || !imagePath.trim()) {
			results.push({ success: false, error: 'Invalid image path.' })
			continue
		}

		try {
			const sourcePath = imagePath.trim()
			const sourceName = sourcePath.split('/').pop() || 'image'
			const sourceDirectory = sourcePath.slice(0, sourcePath.lastIndexOf('/'))
			const rootDirectory = destinationRoot?.trim().replace(/\/+$/, '') || sourceDirectory
			const imageUrl = `${window.location.origin}/${sourcePath}`
			console.log(`FoundryAI | organize_images: fetching "${sourcePath}"`)
			const response = await fetch(imageUrl)
			if (!response.ok) throw new Error(`Could not fetch image: ${response.status} ${response.statusText}`)

			const blob = await response.blob()
			const organization = await classifyImageForOrganization(blob, sourceName)
			const targetDirectory = `${rootDirectory}/${organization.category}`
			const extension = sourceName.match(/\.[a-z0-9]+$/i)?.[0] || (blob.type === 'image/jpeg' ? '.jpg' : '.png')
			const filename = `${promptToSlug(organization.name)}-${Date.now()}${extension}`
			const file = new File([blob], filename, { type: blob.type || 'image/png' })

			await FP.createDirectory('data', rootDirectory).catch(() => {})
			await FP.createDirectory('data', targetDirectory).catch(() => {})
			console.log(`FoundryAI | organize_images: saving "${sourcePath}" as "${targetDirectory}/${filename}"`)
			const uploadResult = await FP.upload('data', targetDirectory, file, {}, { notify: false })
			const savedPath = (uploadResult as any)?.path || `${targetDirectory}/${filename}`

			let moved = false
			if (typeof (FP as any).delete === 'function') {
				await (FP as any).delete('data', sourcePath)
				moved = true
			} else {
				console.warn(`FoundryAI | organize_images: FilePicker.delete is unavailable; kept original "${sourcePath}" after saving organized copy`)
			}

			results.push({ success: true, original_path: sourcePath, path: savedPath, moved, category: organization.category, name: organization.name, description: organization.description })
		} catch (error: any) {
			console.error(`FoundryAI | organize_images: failed for "${imagePath}"`, error)
			results.push({ success: false, original_path: imagePath, error: error.message })
		}
	}

	const organizedCount = results.filter(result => result.success).length
	return JSON.stringify({
		success: organizedCount > 0,
		organized_count: organizedCount,
		failed_count: results.length - organizedCount,
		images: results,
		message: `Organized ${organizedCount} of ${results.length} image(s) into vision-detected categories.`,
	})
}

// ===============================
// PDF TOOL HANDLERS
// ===============================

async function handleListPdfs(): Promise<string> {
	try {
		const FP: typeof FilePicker = (foundry as any)?.applications?.apps?.FilePicker?.implementation ?? FilePicker
		const browse = await (FP as any).browse('data', 'foundry-ai/pdfs')
		const pdfs: { path: string; name: string }[] = (browse.files ?? [])
			.filter((f: string) => f.toLowerCase().endsWith('.pdf'))
			.map((f: string) => ({ path: f, name: f.split('/').pop() ?? f }))

		if (pdfs.length === 0) return JSON.stringify({
			pdfs: [],
			message: 'No PDFs found in foundry-ai/pdfs/. Upload PDF files there via the Foundry file browser (File > Browse Files).',
		})

		return JSON.stringify({
			pdfs,
			message: `Found ${pdfs.length} PDF(s). Use process_pdf with the path to create a journal from one.`,
		})
	} catch (error: any) {
		return JSON.stringify({ error: `Failed to list PDFs: ${error.message}` })
	}
}

async function getPdfjsLib(): Promise<any> {
	if ((globalThis as any).pdfjsLib) return (globalThis as any).pdfjsLib
	const pdfjs = await import('pdfjs-dist')
	// Resolve worker file relative to this module — works wherever Foundry serves the module from
	pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', import.meta.url).href
	;(globalThis as any).pdfjsLib = pdfjs
	return pdfjs
}

function getPdfDocumentOptions(data: ArrayBuffer): Record<string, any> {
	return {
		data,
		cMapUrl: new URL('pdfjs/cmaps/', import.meta.url).href,
		cMapPacked: true,
		standardFontDataUrl: new URL('pdfjs/standard_fonts/', import.meta.url).href,
		wasmUrl: new URL('pdfjs/wasm/', import.meta.url).href,
		useWasm: true,
		useWorkerFetch: true,
	}
}

function escapeHtml(str: string): string {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}


async function handleProcessPdf(args: Record<string, any>): Promise<string> {
	console.log(`FoundryAI | process_pdf: path="${args.pdf_path}"`)
	try {
		// Resolve the destination folder before doing any expensive PDF/OCR work —
		// default to FoundryAI/PDFs subfolder; override with folder_name if given.
		const resolvedFolder = await resolveManagedFolder(
			args.folder_name,
			args.folder_name ? null : getSubfolderId('pdfs'),
			'JournalEntry',
		)
		if (resolvedFolder.error) return JSON.stringify({ error: resolvedFolder.error })
		const folderId = resolvedFolder.folderId

		const pdfjsLib = await getPdfjsLib()

		const pdfUrl = `${window.location.origin}/${args.pdf_path}`
		const response = await fetch(pdfUrl)
		if (!response.ok) return JSON.stringify({ error: `Could not fetch PDF: ${response.status} ${response.statusText}` })

		const arrayBuffer = await response.arrayBuffer()
		const pdf = await pdfjsLib.getDocument(getPdfDocumentOptions(arrayBuffer)).promise
		const numPages: number = pdf.numPages

		const pages: any[] = []
		let failedCount = 0

		for (let i = 1; i <= numPages; i++) {
			const page = await pdf.getPage(i)

			// Step 1: try getTextContent — no canvas rendering, no font warnings
			let pageText = ''
			try {
				const content = await page.getTextContent({ normalizeWhitespace: true } as any)
				const items = (content.items as any[]).filter((item: any) => item.str)

				// Sort top-to-bottom (y descending in PDF coords), then left-to-right
				items.sort((a: any, b: any) => {
					const ay = a.transform?.[5] ?? 0
					const by = b.transform?.[5] ?? 0
					const yDiff = by - ay
					if (Math.abs(yDiff) > 3) return yDiff
					return (a.transform?.[4] ?? 0) - (b.transform?.[4] ?? 0)
				})

				// Reconstruct text with line/paragraph breaks based on y-gaps and hasEOL
				let prevY: number | null = null
				for (const item of items as any[]) {
					const str: string = item.str || ''
					if (!str.trim()) continue
					const y: number = item.transform?.[5] ?? 0
					if (prevY !== null) {
						const gap = prevY - y
						if (gap > 14) pageText += '\n\n'
						else if (gap > 3 || item.hasEOL) pageText += '\n'
						else pageText += ' '
					}
					pageText += str
					if (item.hasEOL) prevY = null
					else prevY = y
				}
				pageText = pageText.trim()
			} catch {
				pageText = ''
			}

			let pageHtml: string

			if (pageText.length > 80) {
				// Sufficient text extracted — convert to HTML paragraphs
				pageHtml = pageText
					.split(/\n{2,}/)
					.map(block => block.replace(/\n/g, ' ').trim())
					.filter(Boolean)
					.map(block => `<p>${escapeHtml(block)}</p>`)
					.join('\n')
			} else {
				// Too little text (image-only page or encoding failure) — fall back to vision OCR
				try {
					const viewport = page.getViewport({ scale: 2.0 })
					const canvas = document.createElement('canvas')
					canvas.width = viewport.width
					canvas.height = viewport.height
					const ctx = canvas.getContext('2d')!
					await page.render({ canvasContext: ctx, viewport }).promise
					const dataUrl = canvas.toDataURL('image/png')

					const extracted = await openRouterService.describeImage(
						dataUrl,
						'Extract every word of text visible on this page. This may be an adventure book page with illustrated panels, numbered sections, stat blocks, or sidebars. Read ALL text including small text inside boxes, choices like "Turn to 37", and captions. Separate blocks with a blank line. Plain text only — no markdown, no HTML.',
					)
					pageHtml = extracted
						.split(/\n{2,}/)
						.map(block => block.replace(/\n/g, ' ').trim())
						.filter(Boolean)
						.map(block => `<p>${escapeHtml(block)}</p>`)
						.join('\n')
				} catch {
					failedCount++
					pageHtml = `<p>(No extractable text on this page — use <code>render_pdf_page</code> then <code>describe_image</code> to read it manually.)</p>`
				}
			}

			const sourceNote = `<p><em>[PDF source: ${args.pdf_path} — Page ${i} of ${numPages}]</em></p>`
			pages.push({
				name: `Page ${i}`,
				type: 'text',
				text: { content: sourceNote + '\n' + pageHtml, format: 1 },
				sort: i * 100,
			})
		}

		const journalData: any = { name: args.journal_name, pages }
		if (folderId) journalData.folder = folderId

		const journal = await JournalEntry.create(journalData)

		const folderLabel = args.folder_name || 'FoundryAI/PDFs'
		return JSON.stringify({
			success: true,
			journal_id: journal.id,
			journal_name: journal.name,
			folder: folderLabel,
			page_count: numPages,
			failed_pages: failedCount,
			message: `Created journal "${args.journal_name}" with ${numPages} pages in ${folderLabel} using vision-based text extraction.${failedCount > 0 ? ` ${failedCount} page(s) failed vision extraction — use render_pdf_page on those.` : ''}`,
		})
	} catch (error: any) {
		return JSON.stringify({ error: `PDF processing failed: ${error.message}` })
	}
}

type PdfPageRenderResult = {
	path: string
	page: number
	total_pages: number
	width: number
	height: number
	source: 'rendered_page' | 'rendered_region' | 'rendered_page_fallback'
	crop?: { x: number; y: number; width: number; height: number }
}

type PdfRenderedCanvasResult = {
	canvas: HTMLCanvasElement
	page: number
	total_pages: number
	width: number
	height: number
	crop?: { x: number; y: number; width: number; height: number }
}

function normalizePageList(pages: unknown, maxPages: number): { pages?: number[]; error?: string } {
	if (!Array.isArray(pages) || pages.length === 0) {
		return { error: `A small explicit pages array is required (maximum ${maxPages}).` }
	}
	const normalized = [...new Set(pages
		.map((page) => Number(page))
		.filter((page) => Number.isInteger(page) && page >= 1))]
	if (normalized.length === 0) return { error: 'Pages must be 1-indexed positive integers.' }
	if (normalized.length > maxPages) return { error: `At most ${maxPages} pages can be processed per call. You requested ${normalized.length}.` }
	return { pages: normalized }
}

async function loadPdfDocument(pdfPath: string): Promise<any> {
	const pdfjsLib = await getPdfjsLib()
	const pdfUrl = `${window.location.origin}/${pdfPath}`
	const response = await fetch(pdfUrl)
	if (!response.ok) throw new Error(`Could not fetch PDF: ${response.status} ${response.statusText}`)
	const arrayBuffer = await response.arrayBuffer()
	return pdfjsLib.getDocument(getPdfDocumentOptions(arrayBuffer)).promise
}

async function saveCanvasAsPng(
	canvas: HTMLCanvasElement,
	filename: string,
	outputDirectory = 'foundry-ai/images',
): Promise<string> {
	const FP: typeof FilePicker = (foundry as any)?.applications?.apps?.FilePicker?.implementation ?? FilePicker
	const blob: Blob = await new Promise(resolve => canvas.toBlob(b => resolve(b!), 'image/png'))
	const file = new File([blob], filename, { type: 'image/png' })

	await FP.createDirectory('data', 'foundry-ai').catch(() => {})
	await FP.createDirectory('data', 'foundry-ai/images').catch(() => {})
	if (outputDirectory !== 'foundry-ai/images') {
		await FP.createDirectory('data', outputDirectory).catch(() => {})
	}

	const uploadResult = await FP.upload('data', outputDirectory, file, {}, { notify: false })
	return (uploadResult as any)?.path || `${outputDirectory}/${filename}`
}

function analyzeEmbeddedPdfCanvas(canvas: HTMLCanvasElement): { skip: boolean; reason?: string } {
	const width = canvas.width
	const height = canvas.height
	if (width < 2 || height < 2) return { skip: true, reason: 'too_small' }

	const ctx = canvas.getContext('2d', { willReadFrequently: true } as any)
	if (!ctx) return { skip: false }

	const sampleW = Math.min(96, width)
	const sampleH = Math.min(96, height)
	const sampleCanvas = document.createElement('canvas')
	sampleCanvas.width = sampleW
	sampleCanvas.height = sampleH
	const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true } as any) as CanvasRenderingContext2D
	sampleCtx.drawImage(canvas, 0, 0, sampleW, sampleH)
	const data = sampleCtx.getImageData(0, 0, sampleW, sampleH).data

	let visible = 0
	let lowSatVisible = 0
	let veryLightVisible = 0
	let sum = 0
	let sumSq = 0
	let edgePixels = 0
	let centerPixels = 0
	let edgeDetail = 0
	let centerDetail = 0
	let centerSum = 0
	let centerSumSq = 0
	let centerDarkPixels = 0

	const luminanceAt = (idx: number) => 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]

	for (let y = 0; y < sampleH; y++) {
		for (let x = 0; x < sampleW; x++) {
			const i = (y * sampleW + x) * 4
			const alpha = data[i + 3]
			if (alpha < 20) continue

			const r = data[i]
			const g = data[i + 1]
			const b = data[i + 2]
			const max = Math.max(r, g, b)
			const min = Math.min(r, g, b)
			const luma = luminanceAt(i)
			const saturation = max === 0 ? 0 : (max - min) / max
			const inEdge = x < sampleW * 0.16 || x > sampleW * 0.84 || y < sampleH * 0.16 || y > sampleH * 0.84
			const inCenter = x > sampleW * 0.28 && x < sampleW * 0.72 && y > sampleH * 0.28 && y < sampleH * 0.72

			visible++
			sum += luma
			sumSq += luma * luma
			if (saturation < 0.18) lowSatVisible++
			if (luma > 190) veryLightVisible++

			let localDetail = 0
			if (x + 1 < sampleW) localDetail += Math.abs(luma - luminanceAt(i + 4))
			if (y + 1 < sampleH) localDetail += Math.abs(luma - luminanceAt(i + sampleW * 4))
			if (inEdge) {
				edgePixels++
				edgeDetail += localDetail
			}
			if (inCenter) {
				centerPixels++
				centerDetail += localDetail
				centerSum += luma
				centerSumSq += luma * luma
				if (luma < 45) centerDarkPixels++
			}
		}
	}

	if (visible === 0) return { skip: true, reason: 'transparent_or_empty' }

	const mean = sum / visible
	const variance = Math.max(0, sumSq / visible - mean * mean)
	const stdDev = Math.sqrt(variance)
	const lowSatRatio = lowSatVisible / visible
	const veryLightRatio = veryLightVisible / visible
	const edgeAvgDetail = edgePixels ? edgeDetail / edgePixels : 0
	const centerAvgDetail = centerPixels ? centerDetail / centerPixels : 0
	const centerMean = centerPixels ? centerSum / centerPixels : 0
	const centerStdDev = centerPixels ? Math.sqrt(Math.max(0, centerSumSq / centerPixels - centerMean * centerMean)) : 0
	const centerDarkRatio = centerPixels ? centerDarkPixels / centerPixels : 0

	if (lowSatRatio > 0.94 && veryLightRatio > 0.72 && stdDev < 24) {
		return { skip: true, reason: 'decorative_page_background' }
	}

	if (centerDarkRatio > 0.86 && centerMean < 45 && centerStdDev < 30 && edgeAvgDetail > centerAvgDetail * 1.8) {
		return { skip: true, reason: 'decorative_border_or_empty_frame' }
	}

	if (edgeAvgDetail > centerAvgDetail * 2.8 && centerAvgDetail < 16 && stdDev < 75) {
		return { skip: true, reason: 'decorative_border_or_empty_frame' }
	}

	return { skip: false }
}

function clampPdfCrop(args: Record<string, any>): { x: number; y: number; width: number; height: number; error?: string } {
	const x = Number(args.x)
	const y = Number(args.y)
	const width = Number(args.width)
	const height = Number(args.height)
	if (![x, y, width, height].every(Number.isFinite)) {
		return { x: 0, y: 0, width: 0, height: 0, error: 'Crop x, y, width, and height must be numbers between 0 and 1.' }
	}
	if (width <= 0 || height <= 0 || x < 0 || y < 0 || x >= 1 || y >= 1) {
		return { x, y, width, height, error: 'Crop must start within the page and have positive width and height.' }
	}
	const clampedWidth = Math.min(width, 1 - x)
	const clampedHeight = Math.min(height, 1 - y)
	return { x, y, width: clampedWidth, height: clampedHeight }
}

async function renderPdfPageToImage(
	pdf: any,
	pdfPath: string,
	pageNumber: number,
	options: {
		outputDirectory?: string
		scale?: number
		source?: PdfPageRenderResult['source']
		crop?: { x: number; y: number; width: number; height: number }
		filenamePart?: string
	} = {},
): Promise<PdfPageRenderResult> {
	const rendered = await renderPdfPageCanvas(pdf, pageNumber, {
		scale: options.scale,
		crop: options.crop,
	})
	const source = options.source ?? (options.crop ? 'rendered_region' : 'rendered_page')
	const slug = promptToSlug(pdfPath)
	const suffix = options.filenamePart ?? source
	const filename = `pdf-${slug}-p${pageNumber}-${suffix}-${Date.now()}.png`
	const savedPath = await saveCanvasAsPng(rendered.canvas, filename, options.outputDirectory)

	return {
		path: savedPath,
		page: pageNumber,
		total_pages: pdf.numPages,
		width: rendered.width,
		height: rendered.height,
		source,
		...(options.crop ? { crop: options.crop } : {}),
	}
}

async function renderPdfPageCanvas(
	pdf: any,
	pageNumber: number,
	options: {
		scale?: number
		crop?: { x: number; y: number; width: number; height: number }
	} = {},
): Promise<PdfRenderedCanvasResult> {
	if (pageNumber < 1 || pageNumber > pdf.numPages) {
		throw new Error(`Page ${pageNumber} is out of range — PDF has ${pdf.numPages} pages.`)
	}

	const page = await pdf.getPage(pageNumber)
	const viewport = page.getViewport({ scale: options.scale ?? 2.0 })
	const fullCanvas = document.createElement('canvas')
	fullCanvas.width = viewport.width
	fullCanvas.height = viewport.height
	const fullCtx = fullCanvas.getContext('2d')!
	await page.render({ canvasContext: fullCtx, viewport }).promise

	let outputCanvas = fullCanvas
	if (options.crop) {
		const sx = Math.floor(options.crop.x * fullCanvas.width)
		const sy = Math.floor(options.crop.y * fullCanvas.height)
		const sw = Math.max(1, Math.floor(options.crop.width * fullCanvas.width))
		const sh = Math.max(1, Math.floor(options.crop.height * fullCanvas.height))
		outputCanvas = document.createElement('canvas')
		outputCanvas.width = sw
		outputCanvas.height = sh
		outputCanvas.getContext('2d')!.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, sw, sh)
	}

	return {
		canvas: outputCanvas,
		page: pageNumber,
		total_pages: pdf.numPages,
		width: outputCanvas.width,
		height: outputCanvas.height,
		...(options.crop ? { crop: options.crop } : {}),
	}
}

async function handleRenderPdfPage(pdfPath: string, pageNumber: number): Promise<string> {
	console.log(`FoundryAI | render_pdf_page: path="${pdfPath}", page=${pageNumber}`)
	try {
		const pdf = await loadPdfDocument(pdfPath)
		const image = await renderPdfPageToImage(pdf, pdfPath, pageNumber, { source: 'rendered_page' })
		return JSON.stringify({
			success: true,
			...image,
			message: `Rendered page ${pageNumber} of ${image.total_pages} to ${image.path}. Use describe_image to analyse it, update_actor to use it as a portrait, or update_scene to use it as a map background.`,
		})
	} catch (error: any) {
		return JSON.stringify({ error: `PDF page render failed: ${error.message}` })
	}
}

async function handleRenderPdfPages(pdfPath: string, pages: unknown): Promise<string> {
	console.log(`FoundryAI | render_pdf_pages: path="${pdfPath}"`)
	try {
		const pageResult = normalizePageList(pages, 5)
		if (pageResult.error) return JSON.stringify({ error: pageResult.error })
		const pdf = await loadPdfDocument(pdfPath)
		const validPages = pageResult.pages!.filter((page) => page <= pdf.numPages)
		if (validPages.length === 0) {
			return JSON.stringify({ error: `None of the requested pages exist in this PDF. It has ${pdf.numPages} page(s).` })
		}

		const images: PdfPageRenderResult[] = []
		for (const page of validPages) {
			images.push(await renderPdfPageToImage(pdf, pdfPath, page, { source: 'rendered_page' }))
		}

		return JSON.stringify({
			success: true,
			rendered_count: images.length,
			images,
			message: `Rendered ${images.length} PDF page(s). Use describe_image to inspect them, or render_pdf_region to crop a specific panel/map from a page.`,
		})
	} catch (error: any) {
		return JSON.stringify({ error: `PDF pages render failed: ${error.message}` })
	}
}

async function handleRenderPdfRegion(args: Record<string, any>): Promise<string> {
	console.log(`FoundryAI | render_pdf_region: path="${args.pdf_path}", page=${args.page_number}`)
	try {
		const crop = clampPdfCrop(args)
		if (crop.error) return JSON.stringify({ error: crop.error })
		const pdf = await loadPdfDocument(args.pdf_path)
		const image = await renderPdfPageToImage(pdf, args.pdf_path, Number(args.page_number), {
			source: 'rendered_region',
			crop,
			filenamePart: 'region',
		})
		return JSON.stringify({
			success: true,
			...image,
			message: `Rendered cropped region from page ${image.page} to ${image.path}.`,
		})
	} catch (error: any) {
		return JSON.stringify({ error: `PDF region render failed: ${error.message}` })
	}
}

type VisionCrop = {
	label: string
	x: number
	y: number
	width: number
	height: number
	confidence: number
}

function parseVisionCropCandidates(text: string): VisionCrop[] {
	const match = text.match(/\[[\s\S]*\]/) || text.match(/\{[\s\S]*\}/)
	if (!match) return []

	try {
		const parsed = JSON.parse(match[0])
		const rawCandidates = Array.isArray(parsed) ? parsed : parsed.regions || parsed.candidates || []
		if (!Array.isArray(rawCandidates)) return []

		return rawCandidates
			.map((candidate: any) => ({
				label: String(candidate.label || candidate.description || 'illustration'),
				x: Number(candidate.x),
				y: Number(candidate.y),
				width: Number(candidate.width),
				height: Number(candidate.height),
				confidence: Number(candidate.confidence ?? candidate.score ?? 0.5),
			}))
			.filter((candidate: VisionCrop) => {
				const area = candidate.width * candidate.height
				return (
					[candidate.x, candidate.y, candidate.width, candidate.height, candidate.confidence].every(Number.isFinite) &&
					candidate.x >= 0 &&
					candidate.y >= 0 &&
					candidate.x < 1 &&
					candidate.y < 1 &&
					candidate.width > 0.05 &&
					candidate.height > 0.05 &&
					candidate.x + candidate.width <= 1.08 &&
					candidate.y + candidate.height <= 1.08 &&
					area >= 0.015 &&
					area <= 0.75 &&
					candidate.confidence >= 0.45
				)
			})
			.map((candidate: VisionCrop) => ({
				...candidate,
				width: Math.min(candidate.width, 1 - candidate.x),
				height: Math.min(candidate.height, 1 - candidate.y),
			}))
			.sort((a: VisionCrop, b: VisionCrop) => b.confidence - a.confidence)
	} catch {
		return []
	}
}

/** Longest edge sent to the vision model for crop suggestions. Region detection
 *  doesn't need full resolution, and a 2x-scale page render can be a multi-MB
 *  base64 payload — downscaling cuts cost and latency with no accuracy loss
 *  (crops are normalized 0–1, so they apply cleanly back to the full canvas). */
const VISION_CROP_MAX_EDGE = 1024

function downscaleCanvasForVision(canvas: HTMLCanvasElement, maxEdge = VISION_CROP_MAX_EDGE): HTMLCanvasElement {
	const longest = Math.max(canvas.width, canvas.height)
	if (longest <= maxEdge) return canvas
	const ratio = maxEdge / longest
	const scaled = document.createElement('canvas')
	scaled.width = Math.max(1, Math.round(canvas.width * ratio))
	scaled.height = Math.max(1, Math.round(canvas.height * ratio))
	scaled.getContext('2d')!.drawImage(canvas, 0, 0, scaled.width, scaled.height)
	return scaled
}

async function suggestIllustrationCropFromCanvas(canvas: HTMLCanvasElement): Promise<{ crop?: VisionCrop; raw?: string; error?: string }> {
	try {
		const dataUrl = downscaleCanvasForVision(canvas).toDataURL('image/png')
		const raw = await openRouterService.describeImage(
			dataUrl,
			'Identify the main illustration/artwork regions on this RPG book page. Ignore text, captions, page numbers, parchment background, page borders, and decorative empty frames. Return only JSON as an array like [{"label":"main illustration","x":0.12,"y":0.25,"width":0.42,"height":0.35,"confidence":0.9}]. Coordinates must be normalized from the top-left of the full page image, between 0 and 1. If there is no clear illustration, return [].',
		)
		const candidates = parseVisionCropCandidates(raw)
		return { crop: candidates[0], raw }
	} catch (error: any) {
		return { error: error?.message || String(error) }
	}
}

function cropCanvasByNormalizedRegion(
	sourceCanvas: HTMLCanvasElement,
	crop: { x: number; y: number; width: number; height: number },
	padding = 0.01,
): HTMLCanvasElement {
	const x = Math.max(0, crop.x - padding)
	const y = Math.max(0, crop.y - padding)
	const width = Math.min(crop.width + padding * 2, 1 - x)
	const height = Math.min(crop.height + padding * 2, 1 - y)
	const sx = Math.floor(x * sourceCanvas.width)
	const sy = Math.floor(y * sourceCanvas.height)
	const sw = Math.max(1, Math.floor(width * sourceCanvas.width))
	const sh = Math.max(1, Math.floor(height * sourceCanvas.height))
	const outputCanvas = document.createElement('canvas')
	outputCanvas.width = sw
	outputCanvas.height = sh
	outputCanvas.getContext('2d')!.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh)
	return outputCanvas
}

type ImageOrganization = {
	category: 'maps' | 'portraits' | 'tokens' | 'handouts' | 'items' | 'artwork' | 'textures' | 'other'
	name: string
	description: string
}

async function classifyImageForOrganization(blob: Blob, imageName: string): Promise<ImageOrganization> {
	const fallback: ImageOrganization = {
		category: 'other',
		name: imageName.replace(/\.[^.]+$/, ''),
		description: 'Image asset; vision classification was unavailable.',
	}

	try {
		const base64 = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader()
			reader.onload = () => resolve(reader.result as string)
			reader.onerror = reject
			reader.readAsDataURL(blob)
		})
		const response = await openRouterService.describeImage(base64,
			'Classify this tabletop RPG asset for a Foundry VTT library. Return only JSON with "category", "name", and "description". category must be one of: maps, portraits, tokens, handouts, items, artwork, textures, other. name must be a concise descriptive filename stem (3-8 words; no extension). description must briefly say what it depicts and how it can be used in a game.')
		const match = response.match(/\{[\s\S]*\}/)
		const classification = match ? JSON.parse(match[0]) : null
		const validCategories = new Set<ImageOrganization['category']>(['maps', 'portraits', 'tokens', 'handouts', 'items', 'artwork', 'textures', 'other'])
		const category = validCategories.has(classification?.category) ? classification.category : fallback.category
		const name = typeof classification?.name === 'string' && classification.name.trim() ? classification.name.trim() : fallback.name
		const description = typeof classification?.description === 'string' && classification.description.trim() ? classification.description.trim() : fallback.description
		return { category, name, description }
	} catch (error) {
		console.warn(`FoundryAI | organize_images: vision classification failed for image "${imageName}"; using fallback`, error)
		return fallback
	}
}

type PdfExtractionJobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled'

type PdfExtractionJob = {
	id: string
	status: PdfExtractionJobStatus
	args: Record<string, any>
	progress_percent: number
	current_stage: string
	created_at: number
	started_at?: number
	completed_at?: number
	result?: any
	error?: string
	cancel_requested?: boolean
}

const PDF_EXTRACTION_JOBS = new Map<string, PdfExtractionJob>()

function prunePdfExtractionJobs() {
	const jobs = [...PDF_EXTRACTION_JOBS.values()].sort((a, b) => b.created_at - a.created_at)
	for (const job of jobs.slice(25)) {
		if (job.status !== 'running' && job.status !== 'queued') PDF_EXTRACTION_JOBS.delete(job.id)
	}
}

function serializePdfExtractionJob(job: PdfExtractionJob): Record<string, any> {
	return {
		id: job.id,
		status: job.status,
		progress_percent: job.progress_percent,
		current_stage: job.current_stage,
		pdf_path: job.args.pdf_path,
		pages: job.args.pages,
		created_at: new Date(job.created_at).toISOString(),
		started_at: job.started_at ? new Date(job.started_at).toISOString() : undefined,
		completed_at: job.completed_at ? new Date(job.completed_at).toISOString() : undefined,
		result: job.result,
		error: job.error,
		cancel_requested: job.cancel_requested || undefined,
	}
}

function validatePdfExtractionArgs(args: Record<string, any>): { args?: Record<string, any>; error?: Record<string, any> } {
	const pageResult = normalizePageList(args.pages, 5)
	if (pageResult.error) {
		return {
			error: {
				error: pageResult.error,
				hint: 'Use a small explicit page list. Do not scan an entire PDF, and do not retry automatically after a timeout.',
			},
		}
	}
	return {
		args: {
			...args,
			pages: pageResult.pages,
			fallback: args.fallback === 'none' ? 'none' : 'render_page_when_empty',
		},
	}
}

async function handleExtractPdfImages(args: Record<string, any>): Promise<string> {
	console.log(`FoundryAI | extract_pdf_images: path="${args.pdf_path}"`)
	const validation = validatePdfExtractionArgs(args)
	if (validation.error) return JSON.stringify(validation.error)

	prunePdfExtractionJobs()
	const jobId = `pdf_extract_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
	const job: PdfExtractionJob = {
		id: jobId,
		status: 'queued',
		args: validation.args!,
		progress_percent: 0,
		current_stage: 'Queued',
		created_at: Date.now(),
	}
	PDF_EXTRACTION_JOBS.set(jobId, job)

	window.setTimeout(() => {
		processPdfExtractionJob(jobId).catch((error) => {
			const current = PDF_EXTRACTION_JOBS.get(jobId)
			if (!current || current.status === 'cancelled') return
			current.status = 'failed'
			current.error = error?.message || String(error)
			current.current_stage = 'Failed'
			current.completed_at = Date.now()
			console.error(`FoundryAI | extract_pdf_images job ${jobId} failed`, error)
		})
	}, 0)

	return JSON.stringify({
		success: true,
		job_id: jobId,
		status: 'queued',
		pdf_path: job.args.pdf_path,
		pages: job.args.pages,
		message: `Extraction started in background for page(s) ${job.args.pages.join(', ')}. Do not retry automatically; use check_pdf_extraction_status with this job_id if you need progress or results.`,
	})
}

async function processPdfExtractionJob(jobId: string): Promise<void> {
	const job = PDF_EXTRACTION_JOBS.get(jobId)
	if (!job) return

	job.status = 'running'
	job.started_at = Date.now()
	job.progress_percent = 5
	job.current_stage = 'Starting PDF image extraction'

	try {
		const resultText = await runPdfExtractionJob(job)
		if (job.cancel_requested || (job as PdfExtractionJob).status === 'cancelled') return
		const result = JSON.parse(resultText)
		if (result?.error) {
			job.status = 'failed'
			job.error = result.error
			job.result = result
			job.current_stage = 'Failed'
			job.completed_at = Date.now()
			return
		}
		job.result = result
		job.status = 'complete'
		job.progress_percent = 100
		job.current_stage = 'Complete'
		job.completed_at = Date.now()
	} catch (error: any) {
		if (job.cancel_requested || (job as PdfExtractionJob).status === 'cancelled') return
		job.status = 'failed'
		job.error = error?.message || String(error)
		job.current_stage = 'Failed'
		job.completed_at = Date.now()
	}
}

async function runPdfExtractionJob(job: PdfExtractionJob): Promise<string> {
	const args = job.args
	const requestedPages = args.pages as number[]

	try {
		if (job.cancel_requested) {
			job.status = 'cancelled'
			job.current_stage = 'Cancelled before start'
			job.completed_at = Date.now()
			return JSON.stringify({ success: false, cancelled: true })
		}

		console.log('FoundryAI | extract_pdf_images: loading PDF.js')
		// pdfjsLib is still needed below for the OPS constants; loadPdfDocument
		// (shared with the render_pdf_* tools) handles fetch + document parsing.
		const pdfjsLib = await getPdfjsLib()
		const FP: typeof FilePicker = (foundry as any)?.applications?.apps?.FilePicker?.implementation ?? FilePicker

		job.progress_percent = 15
		job.current_stage = 'Loading PDF'
		console.log(`FoundryAI | extract_pdf_images: loading PDF "${args.pdf_path}"`)
		const pdf = await loadPdfDocument(args.pdf_path)
		const numPages: number = pdf.numPages
		const minSize: number = args.min_size ?? 300
		const imageResolveTimeoutMs = 30_000
		const fallback = args.fallback === 'none' ? 'none' : 'render_page_when_empty'
		const includeDecorative = args.include_decorative === true

		const pagesToProcess: number[] = requestedPages.filter((n: number) => n <= numPages)
		if (pagesToProcess.length === 0) {
			return JSON.stringify({ error: `None of the requested pages exist in this PDF. It has ${numPages} page(s).` })
		}
		console.log(`FoundryAI | extract_pdf_images: PDF loaded (${numPages} page(s)); processing pages [${pagesToProcess.join(', ')}] with min_size=${minSize}`)
		const slug = promptToSlug(args.pdf_path)
		const outputDirectory = `foundry-ai/images/${slug}`

		console.log('FoundryAI | extract_pdf_images: ensuring output directories exist')
		await FP.createDirectory('data', 'foundry-ai').catch(() => {})
		await FP.createDirectory('data', 'foundry-ai/images').catch(() => {})
		await FP.createDirectory('data', outputDirectory).catch(() => {})
		console.log(`FoundryAI | extract_pdf_images: output directory ready at "${outputDirectory}"`)

		const savedImages: Array<{ path: string; page: number; width: number; height: number; source: 'embedded_image' | 'rendered_page_fallback' | 'vision_cropped_page_region'; image_object?: string; crop?: Record<string, any> }> = []
		const diagnostics: Array<{
			page: number
			image_objects_found: number
			embedded_saved: number
			timed_out: number
			skipped: number
			skipped_reasons: Record<string, number>
			fallback_rendered: boolean
			vision_crop_used?: boolean
			vision_crop_error?: string
		}> = []

		for (const pageNum of pagesToProcess) {
			if (job.cancel_requested) {
				job.status = 'cancelled'
				job.current_stage = `Cancelled before page ${pageNum}`
				job.completed_at = Date.now()
				return JSON.stringify({ success: false, cancelled: true })
			}
			const pageIndex = pagesToProcess.indexOf(pageNum)
			job.progress_percent = 20 + Math.round((pageIndex / pagesToProcess.length) * 70)
			job.current_stage = `Processing page ${pageNum} of ${numPages}`
			console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: loading page`)
			const page = await pdf.getPage(pageNum)
			console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: building operator list`)
			const opList = await page.getOperatorList()
			console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: operator list ready (${opList.fnArray.length} operation(s))`)

			// Collect unique image XObject names from this page
			const seen = new Set<string>()
			const imgOps = [pdfjsLib.OPS.paintImageXObject, pdfjsLib.OPS.paintJpegXObject].filter(Boolean)
			for (let i = 0; i < opList.fnArray.length; i++) {
				if (imgOps.includes(opList.fnArray[i])) {
					const name: string = opList.argsArray[i][0]
					seen.add(name)
				}
			}
			console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: found ${seen.size} unique image XObject(s)`)

			let imgIndex = 0
			let timedOutCount = 0
			let skippedCount = 0
			const skippedReasons: Record<string, number> = {}
			const markSkipped = (reason: string) => {
				skippedCount++
				skippedReasons[reason] = (skippedReasons[reason] || 0) + 1
			}
			const savedBeforePage = savedImages.length
			for (const imgName of seen) {
				if (job.cancel_requested) {
					job.status = 'cancelled'
					job.current_stage = `Cancelled on page ${pageNum}`
					job.completed_at = Date.now()
					return JSON.stringify({ success: false, cancelled: true })
				}
				console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: resolving image "${imgName}"`)
				let timedOut = false
				const imgData = await new Promise<any | undefined>((resolve) => {
					let settled = false
					const timeoutId = window.setTimeout(() => {
						if (settled) return
						settled = true
						timedOut = true
						console.warn(`FoundryAI | extract_pdf_images: page ${pageNum}: timed out after ${imageResolveTimeoutMs}ms resolving image "${imgName}"; skipping it`)
						resolve(undefined)
					}, imageResolveTimeoutMs)

					;(page as any).objs.get(imgName, (data: any) => {
						if (settled) return
						settled = true
						window.clearTimeout(timeoutId)
						resolve(data)
					})
				})
				console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: image "${imgName}" resolved (${imgData?.width ?? 'unknown'}x${imgData?.height ?? 'unknown'}, kind=${imgData?.kind ?? 'unknown'}, bitmap=${Boolean(imgData?.bitmap)})`)

				if (timedOut) timedOutCount++
				if (!imgData || imgData.width < minSize || imgData.height < minSize) {
					console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: skipping image "${imgName}" (missing or below min_size)`)
					markSkipped('missing_or_below_min_size')
					continue
				}

				const canvas = document.createElement('canvas')
				canvas.width = imgData.width
				canvas.height = imgData.height
				const ctx = canvas.getContext('2d')!

				let pixelData: Uint8ClampedArray<ArrayBuffer> | undefined
				if (imgData.kind === 3) {
					// RGBA_32BPP — copy to ensure plain ArrayBuffer (not SharedArrayBuffer)
					pixelData = new Uint8ClampedArray(imgData.data) as Uint8ClampedArray<ArrayBuffer>
				} else if (imgData.kind === 2) {
					// RGB_24BPP — expand to RGBA
					const src = imgData.data
					pixelData = new Uint8ClampedArray(imgData.width * imgData.height * 4)
					for (let j = 0; j < imgData.width * imgData.height; j++) {
						pixelData[j * 4] = src[j * 3]
						pixelData[j * 4 + 1] = src[j * 3 + 1]
						pixelData[j * 4 + 2] = src[j * 3 + 2]
						pixelData[j * 4 + 3] = 255
					}
				}

				if (pixelData) {
					console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: drawing raw pixel data for image "${imgName}" to canvas`)
					ctx.putImageData(new ImageData(pixelData, imgData.width, imgData.height), 0, 0)
				} else if (imgData.bitmap) {
					// Modern PDF.js commonly transfers decoded images as ImageBitmap objects.
					console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: drawing ImageBitmap for image "${imgName}" to canvas`)
					ctx.drawImage(imgData.bitmap as CanvasImageSource, 0, 0, imgData.width, imgData.height)
				} else {
					console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: skipping image "${imgName}" (unsupported pixel format kind=${imgData.kind})`)
					markSkipped('unsupported_pixel_format')
					continue
				}

				if (!includeDecorative) {
					const analysis = analyzeEmbeddedPdfCanvas(canvas)
					if (analysis.skip) {
						const reason = analysis.reason || 'decorative_or_low_content'
						console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: skipping image "${imgName}" (${reason})`)
						markSkipped(reason)
						continue
					}
				}

				console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: encoding image "${imgName}" as PNG`)
				const imageNumber = ++imgIndex
				const filename = `pdf-${slug}-p${pageNum}-img${imageNumber}-${Date.now()}.png`

				console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: uploading image "${imgName}" as "${outputDirectory}/${filename}"`)
				const savedPath = await saveCanvasAsPng(canvas, filename, outputDirectory)
				savedImages.push({ path: savedPath, page: pageNum, width: imgData.width, height: imgData.height, source: 'embedded_image', image_object: imgName })
				console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: saved image "${imgName}" to "${savedPath}"`)
			}
			const embeddedSaved = savedImages.length - savedBeforePage
			let fallbackRendered = false
			let visionCropUsed = false
			let visionCropError: string | undefined
			if (embeddedSaved === 0 && fallback === 'render_page_when_empty') {
				job.current_stage = `Rendering fallback for page ${pageNum}`
				console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: no embedded images saved; rendering full-page fallback`)
				const rendered = await renderPdfPageCanvas(pdf, pageNum)
				job.current_stage = `Finding illustration crop for page ${pageNum}`
				const cropSuggestion = await suggestIllustrationCropFromCanvas(rendered.canvas)
				if (cropSuggestion.crop) {
					const cropCanvas = cropCanvasByNormalizedRegion(rendered.canvas, cropSuggestion.crop)
					const filename = `pdf-${slug}-p${pageNum}-vision-crop-${Date.now()}.png`
					const savedPath = await saveCanvasAsPng(cropCanvas, filename, outputDirectory)
					savedImages.push({
						path: savedPath,
						page: pageNum,
						width: cropCanvas.width,
						height: cropCanvas.height,
						source: 'vision_cropped_page_region',
						crop: cropSuggestion.crop,
					})
					visionCropUsed = true
					console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: saved vision crop to "${savedPath}"`)
				} else {
					visionCropError = cropSuggestion.error || 'vision_returned_no_valid_crop'
					const filename = `pdf-${slug}-p${pageNum}-fallback-${Date.now()}.png`
					const savedPath = await saveCanvasAsPng(rendered.canvas, filename, outputDirectory)
					savedImages.push({
						path: savedPath,
						page: pageNum,
						width: rendered.width,
						height: rendered.height,
						source: 'rendered_page_fallback',
					})
					fallbackRendered = true
					console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: saved rendered fallback to "${savedPath}"`)
				}
			}
			diagnostics.push({
				page: pageNum,
				image_objects_found: seen.size,
				embedded_saved: embeddedSaved,
				timed_out: timedOutCount,
				skipped: skippedCount,
				skipped_reasons: skippedReasons,
				fallback_rendered: fallbackRendered,
				...(visionCropUsed ? { vision_crop_used: true } : {}),
				...(visionCropError ? { vision_crop_error: visionCropError } : {}),
			})
			console.log(`FoundryAI | extract_pdf_images: page ${pageNum}: complete (${embeddedSaved} embedded image(s), fallback=${fallbackRendered})`)
		}

		if (savedImages.length === 0) {
			return JSON.stringify({
				success: true,
				extracted_count: 0,
				images: [],
				diagnostics,
				message: `No embedded images found larger than ${minSize}px on the scanned pages, and fallback rendering was disabled. Try render_pdf_page or render_pdf_region to capture the visible page art.`,
			})
		}

		return JSON.stringify({
			success: true,
			extracted_count: savedImages.length,
			images: savedImages,
			diagnostics,
			message: `Saved ${savedImages.length} image(s). Results marked source="embedded_image" are raw PDF images; source="rendered_page_fallback" are full-page renders used when embedded extraction failed.`,
		})
	} catch (error: any) {
		console.error('FoundryAI | extract_pdf_images: failed', error)
		throw new Error(`PDF image extraction failed: ${error.message}`)
	}
}

function handleCheckPdfExtractionStatus(jobId: string): string {
	const job = PDF_EXTRACTION_JOBS.get(jobId)
	if (!job) {
		return JSON.stringify({
			error: `PDF extraction job not found: ${jobId}. Jobs are held in memory and do not survive a Foundry reload/refresh — if the world reloaded since the job started, it is gone. Check list_assets to see whether images were already saved before the reload, and start a new extract_pdf_images job for anything missing.`,
		})
	}
	return JSON.stringify({ success: true, job: serializePdfExtractionJob(job) })
}

function handleCancelPdfExtraction(jobId: string): string {
	const job = PDF_EXTRACTION_JOBS.get(jobId)
	if (!job) return JSON.stringify({ error: `PDF extraction job not found: ${jobId}` })
	if (job.status === 'complete' || job.status === 'failed' || job.status === 'cancelled') {
		return JSON.stringify({ success: false, job: serializePdfExtractionJob(job), message: `Job is already ${job.status}.` })
	}
	job.cancel_requested = true
	if (job.status === 'queued') {
		job.status = 'cancelled'
		job.current_stage = 'Cancelled before start'
		job.completed_at = Date.now()
	}
	return JSON.stringify({ success: true, job: serializePdfExtractionJob(job), message: 'PDF extraction cancellation requested.' })
}

async function handleUploadGeneratedMap(filename: string, imageData: string, folder?: string): Promise<string> {
	console.log(`FoundryAI | upload_generated_map: filename="${filename}", folder="${folder || 'maps'}"`)
	try {
		if (!filename || typeof filename !== 'string') {
			return JSON.stringify({ success: false, error: 'filename is required' })
		}
		if (!imageData || typeof imageData !== 'string') {
			return JSON.stringify({ success: false, error: 'imageData is required' })
		}

		// Allow-list destinations — this handler is reachable over the bridge,
		// so it must not accept arbitrary upload paths.
		const subfolder = folder === 'images' ? 'images' : 'maps'

		const bytes = atob(imageData)
		const arr = new Uint8Array(bytes.length)
		for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
		const blob = new Blob([arr], { type: 'image/png' })
		const file = new File([blob], filename, { type: 'image/png' })

		const FP: typeof FilePicker = (foundry as any)?.applications?.apps?.FilePicker?.implementation ?? FilePicker
		await FP.createDirectory('data', 'foundry-ai').catch(() => {})
		await FP.createDirectory('data', `foundry-ai/${subfolder}`).catch(() => {})

		const uploadResult = await FP.upload('data', `foundry-ai/${subfolder}`, file, {}, { notify: false })
		const savedPath = (uploadResult as any)?.path || `foundry-ai/${subfolder}/${filename}`

		console.log(`FoundryAI | upload_generated_map: saved to "${savedPath}"`)
		return JSON.stringify({ success: true, path: savedPath })
	} catch (error: any) {
		console.error('FoundryAI | upload_generated_map: failed', error)
		return JSON.stringify({ success: false, error: error.message })
	}
}

/**
 * Bridge-only (see the executeTool case comment): fetch a Foundry image asset
 * and return its bytes as base64 so the server can feed it to ComfyUI as an
 * img2img / style reference.
 */
async function handleReadAsset(assetPath: string): Promise<string> {
	console.log(`FoundryAI | read_asset: path="${assetPath}"`)
	try {
		if (!assetPath || typeof assetPath !== 'string') {
			return JSON.stringify({ success: false, error: 'path is required' })
		}

		// The module runs on the Foundry origin, so data paths are directly fetchable.
		let response = await fetch(assetPath)
		if (!response.ok) {
			// Paths from FilePicker may need URI encoding (spaces etc.)
			response = await fetch(encodeURI(assetPath))
		}
		if (!response.ok) {
			return JSON.stringify({
				success: false,
				error: `Could not fetch asset "${assetPath}" (HTTP ${response.status}). Use an exact path from list_assets.`,
			})
		}

		const buffer = await response.arrayBuffer()

		// Chunked btoa — String.fromCharCode(...bigArray) overflows the call stack
		// on large images.
		const bytes = new Uint8Array(buffer)
		let binary = ''
		const chunkSize = 0x8000
		for (let i = 0; i < bytes.length; i += chunkSize) {
			binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
		}
		const imageData = btoa(binary)

		const filename = assetPath.split('/').pop() || 'asset.png'
		console.log(`FoundryAI | read_asset: read ${bytes.length} bytes from "${assetPath}"`)
		return JSON.stringify({ success: true, filename, size: bytes.length, imageData })
	} catch (error: any) {
		console.error('FoundryAI | read_asset: failed', error)
		return JSON.stringify({ success: false, error: error.message })
	}
}

async function handleGenerateImage(prompt: string, size?: string): Promise<string> {
	console.log(`FoundryAI | generate_image: prompt="${prompt.slice(0, 100)}..."`)

	try {
		const imageModel = getSetting('imageModel') || 'openai/dall-e-3'
		const result = await openRouterService.generateImage(prompt, imageModel, size || '1024x1024')

		if (result.url) {
			// Try to download and save the image to Foundry's storage
			try {
				const response = await fetch(result.url)
				const blob = await response.blob()
				const filename = `${promptToSlug(prompt)}-${Date.now()}.png`
				const file = new File([blob], filename, { type: 'image/png' })

				// Ensure the foundry-ai/images directory exists
				const FP: typeof FilePicker = (foundry as any)?.applications?.apps?.FilePicker?.implementation ?? FilePicker
				await FP.createDirectory('data', 'foundry-ai').catch(() => {})
				await FP.createDirectory('data', 'foundry-ai/images').catch(() => {})

				const uploadResult = await FP.upload('data', 'foundry-ai/images', file, {}, { notify: false })
				const savedPath = (uploadResult as any)?.path || `foundry-ai/images/${filename}`

				return JSON.stringify({
					success: true,
					path: savedPath,
					message: `Image generated and saved to ${savedPath}`,
				})
			} catch (uploadErr: any) {
				// If upload fails, still return the URL
				console.warn('FoundryAI | Failed to save generated image locally:', uploadErr)
				return JSON.stringify({
					success: true,
					url: result.url,
					message: `Image generated (external URL — local save failed: ${uploadErr.message})`,
				})
			}
		} else if (result.b64_json) {
			// Save base64 image to Foundry storage
			const bytes = atob(result.b64_json)
			const arr = new Uint8Array(bytes.length)
			for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
			const blob = new Blob([arr], { type: 'image/png' })
			const filename = `${promptToSlug(prompt)}-${Date.now()}.png`
			const file = new File([blob], filename, { type: 'image/png' })

			await FilePicker.createDirectory('data', 'foundry-ai').catch(() => {})
			await FilePicker.createDirectory('data', 'foundry-ai/images').catch(() => {})

			const uploadResult = await FilePicker.upload('data', 'foundry-ai/images', file, {}, { notify: false })
			const savedPath = (uploadResult as any)?.path || `foundry-ai/images/${filename}`

			return JSON.stringify({
				success: true,
				path: savedPath,
				message: `Image generated and saved to ${savedPath}`,
			})
		}

		return JSON.stringify({ error: 'No image data in response' })
	} catch (error: any) {
		return JSON.stringify({ error: `Image generation failed: ${error.message}` })
	}
}

async function handleGenerateScene(args: Record<string, any>): Promise<string> {
	console.log(`FoundryAI | generate_scene: name="${args.name}", prompt="${(args.prompt as string | undefined)?.slice(0, 100) ?? '(using image_path)'}"...`)

	try {
		const FP: typeof FilePicker = (foundry as any)?.applications?.apps?.FilePicker?.implementation ?? FilePicker
		let imagePath = ''

		const mapSize = args.size || '896x512'
		// Parse image dimensions for scene size
		const [imgWidth, imgHeight] = mapSize.split('x').map(Number)

		const resolvedFolder = await resolveManagedFolder(args.folder_name, args.folder_id, 'Scene')
		if (resolvedFolder.error) return JSON.stringify({ error: resolvedFolder.error })
		const sceneFolderId = resolvedFolder.folderId

		if (!args.image_path && !args.prompt) {
			return JSON.stringify({ error: 'Either prompt or image_path is required to generate a scene' })
		} else if (args.image_path) {
			imagePath = args.image_path
		} else if (args.prompt) {
			// Generate the map image
			const imageModel = getSetting('imageModel') || 'openai/dall-e-3'

			const mapPrompt = `Top-down fantasy battle map, grid-friendly, high detail: ${args.prompt}. Style: digital illustration suitable for a tabletop RPG virtual tabletop. No text or labels.`

			let result: { url?: string; b64_json?: string }
			try {
				result = await openRouterService.generateImage(mapPrompt, imageModel, mapSize)
			} catch (genError: any) {
				const assetsJson = JSON.parse(await handleListAssets())
				return JSON.stringify({
					error: `Image generation failed: ${genError.message}. This may be a transient issue with the image-gen backend — try generate_scene again in a moment, or set image_path to one of the existing_assets below to reuse a pre-made map instead of generating a new one.`,
					existing_assets: assetsJson.assets ?? [],
				})
			}
			const filename = `map-${promptToSlug(args.prompt)}-${Date.now()}.png`

			await FP.createDirectory('data', 'foundry-ai').catch(() => {})
			await FP.createDirectory('data', 'foundry-ai/maps').catch(() => {})

			if (result.url) {
				const blob = await fetch(result.url).then(r => r.blob())
				const file = new File([blob], filename, { type: 'image/png' })
				const uploadResult = await FP.upload('data', 'foundry-ai/maps', file, {}, { notify: false })
				imagePath = (uploadResult as any)?.path || `foundry-ai/maps/${filename}`
			} else if (result.b64_json) {
				const bytes = atob(result.b64_json)
				const arr = new Uint8Array(bytes.length)
				for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
				const file = new File([arr], filename, { type: 'image/png' })
				const uploadResult = await FP.upload('data', 'foundry-ai/maps', file, {}, { notify: false })
				imagePath = (uploadResult as any)?.path || `foundry-ai/maps/${filename}`
			} else {
				return JSON.stringify({ error: 'No image data in response' })
			}
		}

		// Create the scene without background first so Foundry initialises the levels structure
		const sceneData: Record<string, any> = {
			name: args.name,
			width: imgWidth,
			height: imgHeight,
			grid: {
				size: 100,
				distance: args.grid_distance || 5,
				units: args.grid_units || 'ft',
			},
			padding: 0,
			navigation: true,
		}

		if (sceneFolderId) sceneData.folder = sceneFolderId

		const scene = await Scene.create(sceneData)

		// Set the background via levels (same path as update_scene)
		const levels = (scene as any).levels?.contents ?? []
		if (levels.length > 0) {
			const levelsData = levels.map((l: any) => (l.toObject ? l.toObject() : { ...l }))
			levelsData[0].background = { ...(levelsData[0].background ?? {}), src: imagePath }
			await scene.update({ levels: levelsData })
		} else {
			await scene.update({ background: { src: imagePath } })
		}

		return JSON.stringify({
			success: true,
			scene_id: scene.id,
			scene_name: scene.name,
			background: imagePath,
			dimensions: `${imgWidth}x${imgHeight}`,
			message: `Created scene "${args.name}" with AI-generated map. Use activate_scene to switch to it.`,
		})
	} catch (error: any) {
		return JSON.stringify({ error: `Scene generation failed: ${error.message}` })
	}
}
