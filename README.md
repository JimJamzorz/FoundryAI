# FoundryAI

AI-powered DM assistant module for [Foundry VTT](https://foundryvtt.com/) v13.

FoundryAI adds an intelligent chat assistant to your Foundry game that can read your journals and actors, answer questions about your world, generate session recaps, roleplay as NPCs, manage combat, control audio, and more — all powered by [OpenRouter](https://openrouter.ai/).

## Features

- **AI Chat** — Sidebar tab and popout window with streaming responses
- **RAG (Retrieval-Augmented Generation)** — Indexes your journals, actors, and scenes into a local vector store so the AI can search and reference your world content
- **70+ Tools** — The AI can search content, manage tokens, run combat, play audio, create actors and items, roll tables, generate images and scenes, process PDFs, and much more (see [Tools](#tools) below)
- **Actor Roleplay** — Start a dedicated chat session where the AI roleplays as a specific actor, using their biography, personality traits, abilities, and equipment
- **Session Chat History** — Conversations are saved as journal entries in the organized `FoundryAI/` folder hierarchy
- **Session Recaps** — Generate polished narrative summaries of your sessions with AI
- **Text-to-Speech** — Click to hear NPC dialogue read aloud via OpenRouter TTS
- **Organized Journal Folders** — Automatic `FoundryAI/` folder structure: Notes, Chat History, Sessions, Actors
- **Per-Category Tool Toggles** — Enable or disable tool categories (scene, dice, token, combat, audio, chat, compendium, spatial, actor, item, macro, image/PDF) individually
- **OpenRouter Integration** — Access any model available on OpenRouter (GPT-4o, Claude, Llama, Mistral, etc.)
- **Fully Client-Side** — Vector store uses IndexedDB; no external database needed

## Requirements

- Foundry VTT v13
- An [OpenRouter](https://openrouter.ai/) API key

## Installation

1. In Foundry VTT, go to **Settings → Add-on Modules → Install Module**
2. Paste the manifest URL:
   ```
   https://github.com/derekhearst/FoundryAI/releases/latest/download/module.json
   ```
3. Click **Install**
4. Enable **FoundryAI** in your world's Module Management
5. Open module settings and enter your OpenRouter API key

## Configuration

After enabling the module, open **Settings → Module Settings → FoundryAI**:

| Setting                    | Description                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| **API Key**                | Your OpenRouter API key                                                                            |
| **Chat Model**             | Model for chat responses (e.g. `openai/gpt-4o`)                                                    |
| **Embedding Model**        | Model for RAG embeddings                                                                           |
| **Journal Folders**        | Which journal folders to index for RAG                                                             |
| **Actor Folders**          | Which actor folders to index for RAG                                                               |
| **Temperature**            | Response creativity (0.0–2.0)                                                                      |
| **Max Tokens**             | Maximum response length                                                                            |
| **Stream Responses**       | Enable/disable streaming                                                                           |
| **Auto-Index on Startup**  | Automatically index content when the world loads                                                   |
| **Enable Tool Calling**    | Allow the AI to use Foundry tools                                                                  |
| **Tool Category Toggles**  | Enable/disable scene, dice, token, combat, audio, chat, compendium, spatial, actor, item, macro, and image/PDF tools individually |
| **Enable TTS**             | Enable text-to-speech for NPC dialogue                                                             |
| **TTS Voice**              | Voice to use for TTS playback                                                                      |
| **System Prompt Override** | Custom instructions for the AI                                                                     |

## Usage

### Chat

Click the **FoundryAI** tab in the sidebar, or use the scene controls brain icon / hotbar macro to open a popout window. Type a message and the AI will respond with context from your world.

### Actor Roleplay

Click the **theater masks** button (🎭) in the toolbar to open the actor picker. Select any actor and the AI will start a dedicated roleplay session, staying in character using the actor's biography, personality traits, abilities, and equipment. Actor roleplay sessions are saved in the `FoundryAI/Actors` folder.

### RAG Indexing

Use the **Reindex** button in the chat window to index your journals and actors. The AI will then be able to search and reference that content when answering questions.

### Session Recaps

Click **Generate Recap** to create a polished narrative summary from your chat sessions. Recaps are saved as journal entries in the `FoundryAI/Sessions` folder.

### Text-to-Speech

When TTS is enabled, NPC dialogue in AI responses will show a speaker button. Click it to hear the line read aloud.

## Tools

FoundryAI provides **70+ tools** across 15 categories that the AI can call autonomously during conversation. Core and campaign tools are always available when tool calling is enabled; every other category can be toggled on/off in settings.

### Core Tools (always on when tools enabled)

| Tool                      | Description                                                                    |
| ------------------------- | ------------------------------------------------------------------------------ |
| `search_journals`         | Semantically search indexed journal entries (sourcebooks, notes, lore)         |
| `search_actors`           | Semantically search indexed actors (NPCs, monsters, characters)                |
| `get_journal`             | Get the full content of a journal entry by ID or exact name                    |
| `get_actor`               | Get details about a specific actor by ID                                       |
| `list_actors_in_folder`   | List every actor in a folder (the reliable way to answer "who is in folder X") |
| `create_journal`          | Create a new journal entry (multi-page and quest formats supported)            |
| `update_journal`          | Update a journal page or append a new one                                      |
| `list_journals_in_folder` | List all journal entries in a folder, with page IDs                            |
| `list_folders`            | List accessible journal, actor, and scene folders                              |
| `create_folder`           | Create an empty actor or scene folder                                          |
| `get_scene_info`          | Get active scene details (grid, tokens, positions, conditions)                 |
| `roll_table`              | Roll on a roll table and return the result                                     |
| `list_rolltables`         | List all roll tables with IDs, formulas, and entry counts                      |
| `create_rolltable`        | Create a weighted roll table (encounters, loot, rumors)                        |

### Campaign Tools (always on when tools enabled)

| Tool                        | Description                                                              |
| --------------------------- | ------------------------------------------------------------------------ |
| `create_campaign_dashboard` | Create a campaign home-base journal with progress tracking and templates |

### Scene Tools

| Tool             | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `list_scenes`    | List all scenes with IDs, names, and active status     |
| `view_scene`     | View detailed info about a scene without activating it |
| `activate_scene` | Switch all players to a different scene                |
| `update_scene`   | Rename, change background (or generate one), adjust grid, set darkness |

### Dice Tools

| Tool         | Description                                                |
| ------------ | ---------------------------------------------------------- |
| `roll_dice`  | Roll any dice expression (e.g. `2d6+4`, `4d6kh3`)          |
| `roll_check` | Roll an ability check or saving throw for a specific actor |

### Token Tools

| Tool           | Description                                            |
| -------------- | ------------------------------------------------------ |
| `place_token`  | Place a token on the active scene (hidden by default)  |
| `move_token`   | Move a token to new coordinates                        |
| `hide_token`   | Hide a token from player view                          |
| `reveal_token` | Reveal a hidden token to players                       |
| `remove_token` | Remove a token from the scene                          |
| `update_token` | Update token properties (name, size, elevation, light) |

### Combat Tools

| Tool                 | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `get_combat_status`  | Get the live combat state (round, turn, combatants, HP)  |
| `start_combat`       | Create a new combat encounter, optionally adding tokens  |
| `end_combat`         | End the current combat                                   |
| `add_to_combat`      | Add tokens to an active combat                           |
| `remove_from_combat` | Remove combatants from combat                            |
| `next_turn`          | Advance to the next turn                                 |
| `roll_initiative`    | Roll initiative for combatants (all unrolled by default) |
| `apply_damage`       | Deal damage or heal a token's actor                      |
| `apply_condition`    | Apply a status effect (poisoned, stunned, prone, etc.)   |
| `remove_condition`   | Remove a status effect                                   |

### Audio Tools

| Tool             | Description                           |
| ---------------- | ------------------------------------- |
| `list_playlists` | List all playlists and their tracks   |
| `play_playlist`  | Start playing a playlist              |
| `stop_playlist`  | Stop a playlist (or all playlists)    |
| `play_track`     | Play a specific track from a playlist |

### Chat Tools

| Tool                | Description                                                      |
| ------------------- | ---------------------------------------------------------------- |
| `post_chat_message` | Post to the Foundry chat log (narration, NPC dialogue, whispers) |

### Compendium Tools

| Tool                     | Description                                                     |
| ------------------------ | --------------------------------------------------------------- |
| `search_compendium`      | Search compendium packs by name (monsters, items, spells, etc.) |
| `get_compendium_entry`   | Read full details of a compendium entry                         |
| `import_from_compendium` | Import a compendium entry into the world                        |

### Spatial Tools

| Tool                  | Description                                                |
| --------------------- | ---------------------------------------------------------- |
| `measure_distance`    | Measure distance between two tokens or points              |
| `tokens_in_range`     | Find all tokens within a given range of a point or token   |
| `create_scene_region` | Place an area-of-effect region (circle, cone, ray, rect)   |

### Actor Tools

| Tool                     | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `create_actor`           | Create a new NPC, monster, or character from scratch     |
| `update_actor`           | Update actor data (stats, biography, portrait/token art) |
| `add_items_to_actor`     | Add weapons, spells, features, etc. to an actor          |
| `remove_item_from_actor` | Remove an embedded item from an actor                    |
| `update_actor_item`      | Update an item on an actor (quantity, charges, equipped) |

### Item Tools

| Tool          | Description                                             |
| ------------- | ------------------------------------------------------- |
| `create_item` | Create a standalone world item (weapon, spell, loot)    |
| `get_item`    | Get full details of a world item                        |
| `update_item` | Update a world item's data                              |
| `delete_item` | Permanently delete a world item                         |
| `list_items`  | List world items, filtered by type and/or name          |

### Macro Tools

| Tool            | Description                                    |
| --------------- | ---------------------------------------------- |
| `list_macros`   | List macros in allowed macro folders           |
| `get_macro`     | Read a macro's script content                  |
| `create_macro`  | Create a new script or chat macro              |
| `update_macro`  | Update a macro's name or script                |
| `execute_macro` | Execute a macro and capture its result         |

### Image & Scene Generation Tools

| Tool              | Description                                                     |
| ----------------- | --------------------------------------------------------------- |
| `list_assets`     | List generated/extracted images, or browse any server folder    |
| `describe_image`  | Vision-AI description of an image file                          |
| `organize_images` | Classify, sort, and rename image assets with vision AI          |
| `generate_image`  | Generate an image from a prompt and save it to Foundry storage  |
| `generate_scene`  | Generate a full scene with an AI battle-map background          |

### PDF Tools

| Tool                 | Description                                                    |
| -------------------- | -------------------------------------------------------------- |
| `list_pdfs`          | List PDFs uploaded to `foundry-ai/pdfs/`                       |
| `process_pdf`        | Convert a PDF into a journal entry (one page per PDF page)     |
| `render_pdf_page`    | Render a PDF page to an image (for portraits, maps, or vision) |
| `extract_pdf_images` | Extract embedded images/maps from a PDF as PNG files           |

## Folder Structure

FoundryAI automatically creates and manages a journal folder hierarchy:

```
FoundryAI/
├── Notes/          — Short, curated plot-state notes (loaded into every prompt)
├── Chat History/   — Saved chat session conversations
├── Sessions/       — AI-generated session recaps
├── Actors/         — Actor roleplay session logs
└── PDFs/           — Journals created from processed PDFs
```

## Development

### Prerequisites

- [Bun](https://bun.sh/) (or Node.js 18+)

### Setup

```bash
git clone https://github.com/derekhearst/FoundryAI.git
cd FoundryAI
bun install
```

### Scripts

| Command             | Description                                       |
| ------------------- | ------------------------------------------------- |
| `bun run build`     | Production build → `dist/`                        |
| `bun run dev`       | Watch mode (rebuilds on changes)                  |
| `bun run package`   | Build + create `foundry-ai.zip` for release       |
| `bun run link`      | Symlink `dist/` into local Foundry modules folder |
| `bun run test`      | Run tests                                         |
| `bun run typecheck` | TypeScript type checking                          |

### Project Structure

```
src/
├── module.ts                 # Entry point (Hooks, settings, init)
├── settings.ts               # Foundry settings registration
├── core/
│   ├── openrouter-service.ts # OpenRouter API client (streaming, embeddings, TTS)
│   ├── vector-store.ts       # IndexedDB vector store with cosine similarity
│   ├── embedding-service.ts  # Document chunking + embedding pipeline
│   ├── collection-reader.ts  # Reads journals, actors, scenes from Foundry
│   ├── tool-system.ts        # 40+ function-calling tool definitions + executor
│   ├── chat-session-manager.ts   # Persists chat sessions as journal entries
│   ├── session-recap-manager.ts  # AI-generated session recaps
│   ├── folder-manager.ts     # FoundryAI journal folder hierarchy manager
│   ├── tts-service.ts        # Text-to-speech audio playback
│   └── system-prompt.ts      # Dynamic system prompt builder (DM + actor roleplay)
├── ui/
│   ├── svelte-application.ts # Foundry ApplicationV2 ↔ Svelte 5 bridge
│   └── components/
│       ├── ChatWindow.svelte    # Main chat interface
│       ├── MessageBubble.svelte # Message rendering (markdown, TTS buttons)
│       ├── SettingsPanel.svelte # Settings UI
│       └── SessionList.svelte   # Session browser
├── styles/
│   └── foundry-ai.scss       # Module styles
└── types/
    └── foundry-types.d.ts    # Foundry VTT type declarations
```

### Releasing

```bash
# Bump version, then:
bun run release <version>
```

Create a GitHub Release for the tag and upload:

- `foundry-ai.zip`
- `dist/module.json`

## Tech Stack

- **Svelte 5** (runes mode) — UI components
- **Vite 6** — Build tooling
- **TypeScript 5** — Type safety
- **OpenRouter API** — LLM chat, embeddings, and TTS
- **IndexedDB** — Client-side vector storage
- **micromark** — Markdown rendering

## License

[MIT](LICENSE)
