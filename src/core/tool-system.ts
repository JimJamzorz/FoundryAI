/* ==========================================================================
   Tool System - OpenAI-compatible function calling tools for the LLM
   ========================================================================== */

import { embeddingService } from './embedding-service'
import { collectionReader } from './collection-reader'
import { getSetting } from '../settings'
import { openRouterService } from './openrouter-service'
import type { ToolDefinition, ToolCall } from './openrouter-service'
import { getRootFolderId, getSubfolderId } from './folder-manager'

// ---- Folder Permission Helpers ----
// These check whether a document's folder is in the user's allowed list.
// If no folders are selected for a type, nothing is accessible.

/** Collect all FoundryAI-managed folder IDs (root + subfolders). */
function getFoundryAIFolderIds(): string[] {
	const ids: string[] = []
	const root = getRootFolderId()
	if (root) ids.push(root)
	for (const key of ['notes', 'chatHistory', 'sessions', 'actors'] as const) {
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

// ---- Tool Definitions (OpenAI function calling format) ----

// == Core Tools (always available when tools enabled) ==
const CORE_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'search_journals',
			description:
				'Semantically search through indexed journal entries (sourcebooks, notes, lore). Returns brief summaries of matching journals. Use get_journal with the documentId to retrieve the full content of a specific entry. Always cite results using the provided uuidRef.',
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
				'Get the full content of a specific journal entry by its ID. Use this after search_journals to retrieve the complete text of a journal you need to read.',
			parameters: {
				type: 'object',
				properties: {
					journal_id: {
						type: 'string',
						description: 'The Foundry VTT document ID of the journal entry',
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
			description: 'Get details about a specific actor (NPC/character) by ID.',
			parameters: {
				type: 'object',
				properties: {
					actor_id: {
						type: 'string',
						description: 'The Foundry VTT document ID of the actor',
					},
				},
				required: ['actor_id'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'create_journal',
			description:
				'Create a new journal entry in a specified folder. Session recaps MUST go in the "Sessions" folder. Notes and stored data MUST go in the "Notes" folder.',
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
				},
				required: ['name', 'content'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'update_journal',
			description: 'Update the content of an existing journal entry.',
			parameters: {
				type: 'object',
				properties: {
					journal_id: {
						type: 'string',
						description: 'The ID of the journal entry to update',
					},
					content: {
						type: 'string',
						description: 'The new HTML content for the first page',
					},
					page_name: {
						type: 'string',
						description: 'Optionally update the page name',
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
			description: 'List all journal entries in a specific folder.',
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
			description: 'Roll on a roll table by its ID and return the result.',
			parameters: {
				type: 'object',
				properties: {
					table_id: {
						type: 'string',
						description: 'The ID of the roll table',
					},
				},
				required: ['table_id'],
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
			description: 'Switch the active scene to a different one. All players will be moved to this scene.',
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
			description: 'Update an existing scene\'s properties — rename it, change its background image, or adjust grid settings. To change the background, either pass image_path (an already-generated image) or prompt (generates a new image). Do NOT call generate_image separately before this — pass the prompt directly.',
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
			description: 'Roll an ability check or saving throw for a specific actor.',
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
				'Place a new token on the active scene from an actor. Tokens are placed HIDDEN by default so the DM can approve placement before revealing.',
			parameters: {
				type: 'object',
				properties: {
					actor_id: {
						type: 'string',
						description: 'The ID of the actor to create a token from',
					},
					x: {
						type: 'number',
						description: 'X position on the canvas (grid coordinates)',
					},
					y: {
						type: 'number',
						description: 'Y position on the canvas (grid coordinates)',
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
			description: 'Move an existing token to a new position on the canvas.',
			parameters: {
				type: 'object',
				properties: {
					token_id: {
						type: 'string',
						description: 'The ID of the token to move',
					},
					x: {
						type: 'number',
						description: 'New X position',
					},
					y: {
						type: 'number',
						description: 'New Y position',
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
						description: 'The ID of the token to hide',
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
						description: 'The ID of the token to reveal',
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
			description: 'Remove a token from the scene entirely.',
			parameters: {
				type: 'object',
				properties: {
					token_id: {
						type: 'string',
						description: 'The ID of the token to remove',
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
						description: 'The ID of the token to update',
					},
					name: { type: 'string', description: 'New display name' },
					width: { type: 'number', description: 'Width in grid squares' },
					height: { type: 'number', description: 'Height in grid squares' },
					elevation: { type: 'number', description: 'Elevation in feet' },
					light_dim: { type: 'number', description: 'Dim light radius in feet' },
					light_bright: { type: 'number', description: 'Bright light radius in feet' },
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
			description: 'Apply damage or healing to a token/actor.',
			parameters: {
				type: 'object',
				properties: {
					token_id: {
						type: 'string',
						description: 'The token ID of the target',
					},
					amount: {
						type: 'number',
						description: 'Amount of damage (positive) or healing (negative)',
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
						description: 'The token ID to apply the condition to',
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
						description: 'Player names to whisper to. Omit for public message.',
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
			description: 'Search across all compendium packs (SRD monsters, items, spells, etc.) by name.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Search name or partial name',
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
			description: 'Measure the distance between two tokens or two points on the map.',
			parameters: {
				type: 'object',
				properties: {
					from_token_id: { type: 'string', description: 'Token ID of the origin' },
					to_token_id: { type: 'string', description: 'Token ID of the destination' },
					from_x: { type: 'number', description: 'Origin X (if not using token)' },
					from_y: { type: 'number', description: 'Origin Y (if not using token)' },
					to_x: { type: 'number', description: 'Destination X (if not using token)' },
					to_y: { type: 'number', description: 'Destination Y (if not using token)' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'tokens_in_range',
			description: 'Find all tokens within a certain distance of a point or token.',
			parameters: {
				type: 'object',
				properties: {
					token_id: { type: 'string', description: 'Center token ID (or use x/y)' },
					x: { type: 'number', description: 'Center X (if not using token)' },
					y: { type: 'number', description: 'Center Y (if not using token)' },
					range: { type: 'number', description: 'Range in grid distance units (e.g. feet)' },
				},
				required: ['range'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'create_scene_region',
			description: 'Place a shaped scene region on the canvas (for spell areas, zones of effect, etc.).',
			parameters: {
				type: 'object',
				properties: {
					type: {
						type: 'string',
						enum: ['circle', 'cone', 'ray', 'rect'],
						description: 'Region shape',
					},
					x: { type: 'number', description: 'X position (canvas pixels)' },
					y: { type: 'number', description: 'Y position (canvas pixels)' },
					distance: { type: 'number', description: 'Size/distance in grid units (e.g. 20 for 20ft radius)' },
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
				'Update an existing actor\'s data (biography, abilities, HP, AC, stats, etc.). Uses dot-notation paths like "system.attributes.hp.max".',
			parameters: {
				type: 'object',
				properties: {
					actor_id: { type: 'string', description: 'The ID of the actor to update' },
					data: {
						type: 'object',
						description:
							'Key-value pairs of data to update. Use dot-notation for nested paths, e.g. { "system.attributes.hp.max": 50, "system.details.biography.value": "<p>New bio</p>" }',
					},
				},
				required: ['actor_id', 'data'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'delete_actor',
			description: 'Permanently delete an actor from the world. This cannot be undone.',
			parameters: {
				type: 'object',
				properties: {
					actor_id: { type: 'string', description: 'The ID of the actor to delete' },
				},
				required: ['actor_id'],
			},
		},
	},
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
			description: 'List world items, optionally filtered by type.',
			parameters: {
				type: 'object',
				properties: {
					type: {
						type: 'string',
						description: 'Filter by item type (e.g. "weapon", "spell", "feat"). Omit for all items.',
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
				'Execute a macro by ID and return its result. For script macros, the return value of the script is captured.',
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

// == Image & Scene Generation Tools ==
const IMAGE_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'list_assets',
			description: 'List all previously generated images and maps saved locally. Check this before generating new images — an existing asset may already be suitable. Filenames describe the content.',
			parameters: { type: 'object', properties: {} },
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
			name: 'generate_image',
			description:
				'Generate an image from a text prompt using AI image generation. Returns the image URL. Can be used for token art, item art, portraits, etc.',
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

// ---- Combine all static tool definition arrays ----

export const TOOL_DEFINITIONS: ToolDefinition[] = [
	...CORE_TOOLS,
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
]

/**
 * Get only the enabled tool definitions based on user settings.
 */
export function getEnabledTools(): ToolDefinition[] {
	if (!getSetting('enableTools')) return []

	const tools: ToolDefinition[] = [...CORE_TOOLS]

	if (getSetting('enableSceneTools')) tools.push(...SCENE_TOOLS)
	if (getSetting('enableDiceTools')) tools.push(...DICE_TOOLS)
	if (getSetting('enableTokenTools')) tools.push(...TOKEN_TOOLS)
	if (getSetting('enableCombatTools')) tools.push(...COMBAT_TOOLS)
	if (getSetting('enableAudioTools')) tools.push(...AUDIO_TOOLS)
	if (getSetting('enableChatTools')) tools.push(...CHAT_TOOLS)
	if (getSetting('enableCompendiumTools')) tools.push(...COMPENDIUM_TOOLS)
	if (getSetting('enableSpatialTools')) tools.push(...SPATIAL_TOOLS)
	if (getSetting('enableActorTools')) tools.push(...ACTOR_TOOLS)
	if (getSetting('enableItemTools')) tools.push(...ITEM_TOOLS)
	if (getSetting('enableMacroTools')) tools.push(...MACRO_TOOLS)
	if (getSetting('enableImageTools')) tools.push(...IMAGE_TOOLS)

	return tools
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
			// Core tools
			case 'search_journals':
				return await handleSearchJournals(args.query, args.max_results)
			case 'search_actors':
				return await handleSearchActors(args.query, args.max_results)
			case 'get_journal':
				return handleGetJournal(args.journal_id)
			case 'get_actor':
				return handleGetActor(args.actor_id)
			case 'create_journal':
				return await handleCreateJournal(args.name, args.content, args.folder_name, args.folder_id)
			case 'update_journal':
				return await handleUpdateJournal(args.journal_id, args.content, args.page_name)
			case 'list_journals_in_folder':
				return handleListJournalsInFolder(args.folder_id)
			case 'list_folders':
				return handleListFolders(args.type || 'all')
			case 'get_scene_info':
				return handleGetSceneInfo()
			case 'roll_table':
				return await handleRollTable(args.table_id)

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
			case 'delete_actor':
				return await handleDeleteActor(args.actor_id)
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
				return handleListItems(args.type, args.max_results)

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

			// Image & Scene generation tools
			case 'list_assets':
				return await handleListAssets()
			case 'describe_image':
				return await handleDescribeImage(args.image_path, args.question)
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

function handleGetJournal(journalId: string): string {
	console.log(`FoundryAI | get_journal: id="${journalId}"`)
	const entry = game.journal?.get(journalId)
	if (!entry) {
		console.log(`FoundryAI | get_journal: not found in game.journal`)
		return JSON.stringify({ error: `Journal entry not found: ${journalId}` })
	}
	console.log(
		`FoundryAI | get_journal: found "${entry.name}" in folder "${entry.folder?.name || 'root'}" (id: ${entry.folder?.id})`,
	)

	if (!isJournalFolderAllowed(entry.folder?.id)) {
		console.log(`FoundryAI | get_journal: folder not allowed`)
		return JSON.stringify({ error: `Journal entry not found: ${journalId}` })
	}

	const content = collectionReader.getJournalContent(journalId)
	return JSON.stringify({
		id: journalId,
		name: entry?.name || 'Unknown',
		folder: entry?.folder?.name || 'Root',
		content,
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
		return JSON.stringify({ error: `Actor not found: ${actorId}` })
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

async function handleCreateJournal(
	name: string,
	content: string,
	folderName?: string,
	folderId?: string,
): Promise<string> {
	let resolvedFolderId = folderId || null

	if (folderName && !resolvedFolderId) {
		let folder = game.folders?.find((f: any) => f.type === 'JournalEntry' && f.name === folderName)

		if (!folder) {
			folder = await Folder.create({
				name: folderName,
				type: 'JournalEntry',
				parent: null,
			} as any)
		}

		resolvedFolderId = folder?.id || null
	}

	const journalData: any = {
		name,
		pages: [
			{
				name,
				type: 'text',
				text: { content, format: 1 },
			},
		],
	}

	if (resolvedFolderId) {
		journalData.folder = resolvedFolderId
	}

	const journal = await JournalEntry.create(journalData)
	return JSON.stringify({
		success: true,
		id: journal.id,
		name: journal.name,
		folder: folderName || 'Root',
		message: `Created journal entry "${name}" in folder "${folderName || 'Root'}"`,
	})
}

async function handleUpdateJournal(journalId: string, content: string, pageName?: string): Promise<string> {
	console.log(
		`FoundryAI | update_journal: journalId="${journalId}", pageName="${pageName}", content length=${content?.length}`,
	)
	const entry = game.journal?.get(journalId)
	if (!entry) {
		console.log(`FoundryAI | update_journal: journal not found`)
		return JSON.stringify({ error: `Journal entry not found: ${journalId}` })
	}

	if (!isJournalFolderAllowed(entry.folder?.id)) {
		return JSON.stringify({ error: `Journal entry not found: ${journalId}` })
	}

	const firstPage = entry.pages.contents?.[0]
	if (!firstPage) {
		return JSON.stringify({ error: 'Journal has no pages to update' })
	}

	const updateData: Record<string, any> = {
		'text.content': content,
	}
	if (pageName) {
		updateData.name = pageName
	}

	await firstPage.update(updateData)
	return JSON.stringify({
		success: true,
		id: journalId,
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

function handleGetSceneInfo(): string {
	console.log(`FoundryAI | get_scene_info: called`)
	return collectionReader.getCurrentSceneInfo()
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
		return JSON.stringify({ error: `Actor not found: ${actorId}` })
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

	let resolvedFolderId = folderId || null

	if (folderName && !resolvedFolderId) {
		let folder = game.folders?.find((f: any) => f.type === 'Actor' && f.name === folderName)
		if (!folder) {
			folder = await Folder.create({ name: folderName, type: 'Actor', parent: null } as any)
		}
		resolvedFolderId = folder?.id || null
	}

	const actorData: Record<string, any> = {
		name,
		type: type || 'npc',
	}

	if (resolvedFolderId) actorData.folder = resolvedFolderId
	if (img) actorData.img = img

	// Apply system-specific data using dot-notation expansion
	if (data) {
		for (const [key, value] of Object.entries(data)) {
			actorData[key] = value
		}
	}

	const actor = await Actor.create(actorData)

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
		return JSON.stringify({ error: `Actor not found: ${actorId}` })
	}

	await actor.update(data)

	return JSON.stringify({
		success: true,
		id: actorId,
		name: actor.name,
		message: `Updated actor "${actor.name}"`,
	})
}

async function handleDeleteActor(actorId: string): Promise<string> {
	console.log(`FoundryAI | delete_actor: actorId="${actorId}"`)
	const actor = game.actors?.get(actorId)
	if (!actor) return JSON.stringify({ error: `Actor not found: ${actorId}` })

	if (!isActorFolderAllowed(actor.folder?.id)) {
		return JSON.stringify({ error: `Actor not found: ${actorId}` })
	}

	const actorName = actor.name
	await actor.delete()

	return JSON.stringify({
		success: true,
		message: `Deleted actor "${actorName}"`,
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
		return JSON.stringify({ error: `Actor not found: ${actorId}` })
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
		return JSON.stringify({ error: `Actor not found: ${actorId}` })
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
		return JSON.stringify({ error: `Actor not found: ${actorId}` })
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

function handleListItems(type?: string, maxResults?: number): string {
	console.log(`FoundryAI | list_items: type="${type}", maxResults=${maxResults}`)
	if (!game.items) return JSON.stringify({ error: 'Items collection not available' })

	const max = maxResults || 20
	const items: Array<{ id: string; name: string; type: string; folder: string }> = []

	for (const item of game.items.values()) {
		if (type && item.type !== type) continue
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

	let resolvedFolderId = folderId || null

	if (folderName && !resolvedFolderId) {
		let folder = game.folders?.find((f: any) => f.type === 'Macro' && f.name === folderName)
		if (!folder) {
			folder = await Folder.create({ name: folderName, type: 'Macro', parent: null } as any)
		}
		resolvedFolderId = folder?.id || null
	}

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

async function handleListAssets(): Promise<string> {
	try {
		const FP: typeof FilePicker = (foundry as any)?.applications?.apps?.FilePicker?.implementation ?? FilePicker
		const results: { path: string; name: string; type: string }[] = []

		const browseDirs = [
			{ dir: 'foundry-ai/images', type: 'image' },
			{ dir: 'foundry-ai/maps', type: 'map' },
		]

		for (const { dir, type } of browseDirs) {
			try {
				const browse = await (FP as any).browse('data', dir)
				for (const file of browse.files ?? []) {
					const name = file.split('/').pop() ?? file
					results.push({ path: file, name, type })
				}
			} catch {
				// Directory may not exist yet
			}
		}

		if (results.length === 0) return JSON.stringify({ assets: [], message: 'No generated assets found yet.' })

		return JSON.stringify({
			assets: results,
			message: `Found ${results.length} generated asset(s). Filenames describe the content — use path when referencing an asset.`,
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

		if (!args.image_path && !args.prompt) {
			return JSON.stringify({ error: 'Either prompt or image_path is required to generate a scene' })
		} else if (args.image_path) {
			imagePath = args.image_path
		} else if (args.prompt) {
			// Generate the map image
			const imageModel = getSetting('imageModel') || 'openai/dall-e-3'

			const mapPrompt = `Top-down fantasy battle map, grid-friendly, high detail: ${args.prompt}. Style: digital illustration suitable for a tabletop RPG virtual tabletop. No text or labels.`

			const result = await openRouterService.generateImage(mapPrompt, imageModel, mapSize)
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

		// Resolve scene folder
		let sceneFolderId: string | null = args.folder_id || null
		if (args.folder_name && !sceneFolderId) {
			let folder = game.folders?.find((f: any) => f.type === 'Scene' && f.name === args.folder_name)
			if (!folder) {
				folder = await Folder.create({ name: args.folder_name, type: 'Scene', parent: null } as any)
			}
			sceneFolderId = folder?.id || null
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
