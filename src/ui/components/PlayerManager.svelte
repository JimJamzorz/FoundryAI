<script lang="ts">
  import { onMount } from 'svelte';
  import { openRouterService, type ModelInfo } from '@core/openrouter-service';
  import { getSetting, setSetting, type ApiProvider, type AIPlayerConfig } from '../../settings';

  interface Props {
    application?: any;
  }

  let { application }: Props = $props();

  // ---- State ----
  let providers = $state<ApiProvider[]>([]);
  let players = $state<AIPlayerConfig[]>([]);
  let humanCap = $state(5);
  let orchestrationEnabled = $state(false);
  let keepSceneMoving = $state(false);
  let isSaving = $state(false);

  // Orchestrator model override — optional, separate from the DM's main Chat Model.
  let orchestratorProviderId = $state('');
  let orchestratorModel = $state('');
  let orchestratorModels = $state<ModelInfo[]>([]);
  let orchestratorFilter = $state('');
  let orchestratorLoadingModels = $state(false);

  // Per-player model browsing state, keyed by player id.
  let modelsByPlayer = $state<Record<string, ModelInfo[]>>({});
  let filterByPlayer = $state<Record<string, string>>({});
  let loadingByPlayer = $state<Record<string, boolean>>({});

  const byName = (a: ModelInfo, b: ModelInfo) => (a.name ?? a.id).localeCompare(b.name ?? b.id);

  // ---- Load current settings ----
  onMount(() => {
    try {
      providers = (getSetting('apiProviders') || []) as ApiProvider[];
      const saved = (getSetting('aiPlayers') || []) as AIPlayerConfig[];
      // Clone so in-progress edits don't mutate the stored setting until Save.
      players = saved.map(p => ({ ...p }));
      humanCap = getSetting('aiPlayerHumanCap') ?? 5;
      orchestrationEnabled = getSetting('aiOrchestrationEnabled') ?? false;
      keepSceneMoving = getSetting('aiKeepSceneMoving') ?? false;
      orchestratorProviderId = getSetting('orchestratorProviderId') ?? '';
      orchestratorModel = getSetting('orchestratorModel') ?? '';
      if (orchestratorProviderId) loadOrchestratorModels(orchestratorProviderId);
      // Auto-populate each configured player's model list too, so the window
      // opens usable without re-toggling every provider dropdown.
      for (const p of players) {
        if (p.providerId) loadModelsForPlayer(p.id, p.providerId);
      }
    } catch (err) {
      console.error('FoundryAI | PlayerManager: failed to load settings', err);
    }
  });

  // ---- Actors (player-character type only) ----
  function getAvailableActors(): Array<{ id: string; name: string; img: string }> {
    if (!game.actors) return [];
    const actors: Array<{ id: string; name: string; img: string }> = [];
    for (const actor of game.actors.values()) {
      if ((actor as any).type !== 'character') continue;
      actors.push({
        id: actor.id,
        name: actor.name,
        img: (actor as any).img || 'icons/svg/mystery-man.svg',
      });
    }
    return actors.sort((a, b) => a.name.localeCompare(b.name));
  }

  const availableActors = $derived.by(() => getAvailableActors());

  // ---- Roster actions ----
  function addPlayer() {
    const id = crypto.randomUUID();
    players = [
      ...players,
      {
        id,
        name: 'New AI Player',
        actorId: '',
        actorName: '',
        providerId: '',
        model: '',
        systemPromptOverride: '',
        enabled: true,
      },
    ];
  }

  function removePlayer(id: string) {
    players = players.filter(p => p.id !== id);
    const { [id]: _m, ...restModels } = modelsByPlayer;
    modelsByPlayer = restModels;
    const { [id]: _f, ...restFilter } = filterByPlayer;
    filterByPlayer = restFilter;
    const { [id]: _l, ...restLoading } = loadingByPlayer;
    loadingByPlayer = restLoading;
  }

  function updatePlayer(id: string, patch: Partial<AIPlayerConfig>) {
    players = players.map(p => (p.id === id ? { ...p, ...patch } : p));
  }

  function onActorChange(id: string, actorId: string) {
    const actor = availableActors.find(a => a.id === actorId);
    updatePlayer(id, { actorId, actorName: actor?.name ?? '' });
  }

  async function loadModelsForPlayer(id: string, providerId: string) {
    const provider = providers.find(p => p.id === providerId);
    if (!provider) {
      modelsByPlayer = { ...modelsByPlayer, [id]: [] };
      return;
    }

    loadingByPlayer = { ...loadingByPlayer, [id]: true };
    try {
      const all = await openRouterService.listModels({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
      const chatModels = all
        .filter(m => (!m.architecture?.modality || m.architecture.modality.includes('text')) && !m.id.includes('embedding'))
        .sort(byName);
      modelsByPlayer = { ...modelsByPlayer, [id]: chatModels };
      filterByPlayer = { ...filterByPlayer, [id]: '' };
    } catch (err: any) {
      ui.notifications.error(`Failed to load models: ${err.message}`);
    } finally {
      loadingByPlayer = { ...loadingByPlayer, [id]: false };
    }
  }

  async function loadOrchestratorModels(providerId: string) {
    const provider = providers.find(p => p.id === providerId);
    if (!provider) {
      orchestratorModels = [];
      return;
    }

    orchestratorLoadingModels = true;
    try {
      const all = await openRouterService.listModels({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
      orchestratorModels = all
        .filter(m => (!m.architecture?.modality || m.architecture.modality.includes('text')) && !m.id.includes('embedding'))
        .sort(byName);
      orchestratorFilter = '';
    } catch (err: any) {
      ui.notifications.error(`Failed to load models: ${err.message}`);
    } finally {
      orchestratorLoadingModels = false;
    }
  }

  // ---- Save ----
  async function handleSave() {
    isSaving = true;
    try {
      await setSetting('aiPlayers', players);
      await setSetting('aiPlayerHumanCap', humanCap);
      await setSetting('aiOrchestrationEnabled', orchestrationEnabled);
      await setSetting('aiKeepSceneMoving', keepSceneMoving);
      await setSetting('orchestratorProviderId', orchestratorProviderId);
      await setSetting('orchestratorModel', orchestratorModel);
      ui.notifications.info('AI Players saved!');
      application?.close();
    } catch (err: any) {
      ui.notifications.error(`Failed to save: ${err.message}`);
    } finally {
      isSaving = false;
    }
  }
</script>

<div class="player-manager">
  <div class="player-scroll">
    <p class="section-hint">
      Each AI player is a separate persona pointed at one of your player characters, with its own LLM, role prompt,
      and a personal notes journal it can read/write. A central orchestrator (your DM Chat Model) watches table
      chat and decides whether a player should react, the DM should narrate a beat, or nothing should happen.
    </p>

    <section class="player-card global-settings">
      <label class="enabled-toggle orchestration-toggle">
        <input type="checkbox" bind:checked={orchestrationEnabled} />
        Enable AI Orchestration
      </label>
      <small class="field-hint-inline block">
        Off by default. When on, chat activity can trigger AI players and/or autonomous DM narration without you
        typing anything — worth understanding before flipping it on mid-session.
      </small>

      <label class="enabled-toggle orchestration-toggle" style="margin-top: 12px;">
        <input type="checkbox" bind:checked={keepSceneMoving} disabled={!orchestrationEnabled} />
        Keep the Scene Moving
      </label>
      <small class="field-hint-inline block">
        A WAIT decision becomes a DM narration beat instead of silence, and if the DM declines to narrate, the
        orchestrator gets one more chance to pick a player. The table drives itself until the cap below is hit or
        a human speaks — chattier by design, the cap is the brake.
      </small>

      <div class="field" style="margin-top: 12px;">
        <label for="human-cap">Human-Interaction Cap</label>
        <input
          id="human-cap"
          type="number"
          min="1"
          max="50"
          bind:value={humanCap}
        />
        <small class="field-hint-inline block">
          Max consecutive automated messages (AI players + autonomous DM narration, combined) before things go
          quiet and wait for a human message to break the streak.
        </small>
      </div>

      <div class="field" style="margin-top: 12px;">
        <label for="orch-provider">
          Orchestrator Model <span class="field-hint-inline">(optional — defaults to your DM Chat Model)</span>
          <button
            type="button"
            class="model-refresh"
            title="Reload the model list from this provider"
            disabled={!orchestratorProviderId || orchestratorLoadingModels}
            onclick={(e) => { e.preventDefault(); loadOrchestratorModels(orchestratorProviderId); }}
          >
            <i class="fas fa-sync-alt"></i>
          </button>
        </label>
        <div class="model-row">
          <div class="model-provider-field">
            <select
              id="orch-provider"
              value={orchestratorProviderId}
              onchange={(e) => {
                const id = (e.target as HTMLSelectElement).value;
                orchestratorProviderId = id;
                if (id) loadOrchestratorModels(id);
                else orchestratorModels = [];
              }}
            >
              <option value="">— Use DM Chat Model —</option>
              {#each providers as p (p.id)}
                <option value={p.id}>{p.name}</option>
              {/each}
            </select>
          </div>
          <div class="model-id-field">
            {#if orchestratorLoadingModels}
              <div class="model-loading"><i class="fas fa-spinner fa-spin"></i> Loading...</div>
            {:else if orchestratorModels.length > 0}
              <input
                class="model-filter"
                type="text"
                value={orchestratorFilter}
                oninput={(e) => { orchestratorFilter = (e.target as HTMLInputElement).value; }}
                placeholder="Filter models..."
              />
              <select
                value={orchestratorModel}
                onchange={(e) => { orchestratorModel = (e.target as HTMLSelectElement).value; }}
              >
                <option value="">— Use DM Chat Model —</option>
                {#each orchestratorModels.filter(m => {
                  const f = orchestratorFilter.toLowerCase();
                  return !f || m.id === orchestratorModel || (m.name ?? '').toLowerCase().includes(f) || m.id.toLowerCase().includes(f);
                }) as m (m.id)}
                  <option value={m.id}>{m.name ?? m.id} {m.name ? `(${m.id})` : ''}</option>
                {/each}
              </select>
            {:else}
              <input
                type="text"
                value={orchestratorModel}
                oninput={(e) => { orchestratorModel = (e.target as HTMLInputElement).value; }}
                placeholder="Leave blank to use your DM Chat Model"
              />
            {/if}
          </div>
        </div>
        <small class="field-hint-inline block">
          Runs on every chat message to decide ACTOR/DM/WAIT — worth pointing at something fast. A heavy "thinking"
          model can spend more tokens reasoning through this one simple decision than a full DM turn needs, adding
          latency to every message. Leave blank to just use your DM Chat Model.
        </small>
      </div>
    </section>

    {#if players.length === 0}
      <p class="empty-hint">No AI players configured yet. Add one below.</p>
    {/if}

    {#each players as player (player.id)}
      <section class="player-card" class:player-inactive={!player.enabled}>
        <div class="player-card-header">
          <input
            class="player-name-input"
            type="text"
            value={player.name}
            oninput={(e) => updatePlayer(player.id, { name: (e.target as HTMLInputElement).value })}
            placeholder="Player name"
          />
          <label class="enabled-toggle" title="Active">
            <input
              type="checkbox"
              checked={player.enabled}
              onchange={(e) => updatePlayer(player.id, { enabled: (e.target as HTMLInputElement).checked })}
            />
            Active
          </label>
          <button class="inline-btn danger" onclick={() => removePlayer(player.id)} title="Remove">×</button>
        </div>

        <div class="field">
          <label for={`actor-${player.id}`}>Linked Actor</label>
          <select
            id={`actor-${player.id}`}
            value={player.actorId}
            onchange={(e) => onActorChange(player.id, (e.target as HTMLSelectElement).value)}
          >
            <option value="">— Select a character —</option>
            {#each availableActors as actor (actor.id)}
              <option value={actor.id}>{actor.name}</option>
            {/each}
          </select>
        </div>

        <div class="model-row">
          <div class="model-provider-field">
            <label for={`provider-${player.id}`}>LLM Provider</label>
            <select
              id={`provider-${player.id}`}
              value={player.providerId}
              onchange={(e) => {
                const id = (e.target as HTMLSelectElement).value;
                updatePlayer(player.id, { providerId: id });
                loadModelsForPlayer(player.id, id);
              }}
            >
              <option value="">— Provider —</option>
              {#each providers as p (p.id)}
                <option value={p.id}>{p.name}</option>
              {/each}
            </select>
          </div>
          <div class="model-id-field">
            <label>
              Model
              <button
                type="button"
                class="model-refresh"
                title="Reload the model list from this provider"
                disabled={!player.providerId || loadingByPlayer[player.id]}
                onclick={(e) => { e.preventDefault(); loadModelsForPlayer(player.id, player.providerId); }}
              >
                <i class="fas fa-sync-alt"></i>
              </button>
            </label>
            {#if loadingByPlayer[player.id]}
              <div class="model-loading"><i class="fas fa-spinner fa-spin"></i> Loading...</div>
            {:else if (modelsByPlayer[player.id]?.length ?? 0) > 0}
              <input
                class="model-filter"
                type="text"
                value={filterByPlayer[player.id] ?? ''}
                oninput={(e) => { filterByPlayer = { ...filterByPlayer, [player.id]: (e.target as HTMLInputElement).value }; }}
                placeholder="Filter models..."
              />
              <select
                value={player.model}
                onchange={(e) => updatePlayer(player.id, { model: (e.target as HTMLSelectElement).value })}
              >
                {#each (modelsByPlayer[player.id] ?? []).filter(m => {
                  const f = (filterByPlayer[player.id] ?? '').toLowerCase();
                  return !f || m.id === player.model || (m.name ?? '').toLowerCase().includes(f) || m.id.toLowerCase().includes(f);
                }) as m (m.id)}
                  <option value={m.id}>{m.name ?? m.id} {m.name ? `(${m.id})` : ''}</option>
                {/each}
              </select>
            {:else}
              <input
                type="text"
                value={player.model}
                oninput={(e) => updatePlayer(player.id, { model: (e.target as HTMLInputElement).value })}
                placeholder="e.g. anthropic/claude-sonnet-4"
              />
            {/if}
          </div>
        </div>

        <div class="field">
          <label for={`prompt-${player.id}`}>Role Prompt <span class="field-hint-inline">(optional — falls back to the actor's auto-generated personality)</span></label>
          <textarea
            id={`prompt-${player.id}`}
            value={player.systemPromptOverride}
            oninput={(e) => updatePlayer(player.id, { systemPromptOverride: (e.target as HTMLTextAreaElement).value })}
            placeholder="e.g. Play cautious and suspicious of strangers; defer to the party's rogue on social checks..."
          ></textarea>
        </div>
      </section>
    {/each}

    <button class="add-player-btn" onclick={addPlayer}>
      <i class="fas fa-plus"></i> Add AI Player
    </button>
  </div>

  <!-- Actions -->
  <div class="player-actions">
    <button class="btn-cancel" onclick={() => application?.close()}>Cancel</button>
    <button class="btn-save" onclick={handleSave} disabled={isSaving}>
      {isSaving ? 'Saving...' : 'Save Players'}
    </button>
  </div>
</div>

<style>
  .player-manager {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--foundry-ai-bg, #1a1a2e);
    color: var(--foundry-ai-text, #e0e0e0);
    font-family: 'Signika', sans-serif;
  }

  .player-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
  }

  .player-scroll::-webkit-scrollbar {
    width: 6px;
  }

  .player-scroll::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
  }

  .section-hint {
    font-size: 0.8em;
    color: rgba(255, 255, 255, 0.45);
    margin: 0 0 14px 0;
    line-height: 1.4;
  }

  .empty-hint {
    font-size: 0.85em;
    opacity: 0.5;
    padding: 8px 0;
  }

  .player-card {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 14px;
  }

  /* Named "player-inactive", not "disabled" — Foundry's own core CSS applies
     pointer-events: none to any element classed "disabled", which would make the
     whole card (including the "Active" checkbox meant to re-enable it) unclickable. */
  .player-card.player-inactive {
    opacity: 0.55;
  }

  .player-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }

  .player-name-input {
    flex: 1;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    color: inherit;
    padding: 7px 10px;
    font-family: inherit;
    font-size: 0.92em;
    font-weight: 600;
    outline: none;
  }

  .player-name-input:focus {
    border-color: rgba(139, 92, 246, 0.5);
  }

  .enabled-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.8em;
    opacity: 0.8;
    white-space: nowrap;
  }

  .field {
    margin-bottom: 12px;
  }

  .field label {
    display: block;
    font-size: 0.82em;
    font-weight: 500;
    margin-bottom: 4px;
    opacity: 0.8;
  }

  .field-hint-inline {
    font-weight: 400;
    opacity: 0.6;
    font-size: 0.95em;
  }

  .field-hint-inline.block {
    display: block;
    margin-top: 5px;
    line-height: 1.4;
  }

  .global-settings {
    background: rgba(139, 92, 246, 0.06);
    border-color: rgba(139, 92, 246, 0.2);
  }

  .global-settings .field {
    margin-bottom: 0;
  }

  #human-cap {
    width: 100px;
  }

  .field select,
  .field input[type="text"],
  .field input[type="number"],
  .field textarea {
    width: 100%;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    color: inherit;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 0.88em;
    outline: none;
    transition: border-color 0.15s;
    box-sizing: border-box;
  }

  .field select:focus,
  .field input:focus,
  .field textarea:focus {
    border-color: rgba(139, 92, 246, 0.5);
  }

  .field textarea {
    resize: vertical;
    min-height: 70px;
    line-height: 1.4;
  }

  /* ---- Model Row (mirrors SettingsPanel) ---- */
  .model-row {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
    align-items: flex-start;
  }

  .model-provider-field {
    flex: 0 0 150px;
  }

  .model-provider-field label,
  .model-id-field label {
    display: block;
    font-size: 0.82em;
    font-weight: 500;
    margin-bottom: 4px;
    opacity: 0.8;
  }

  .model-provider-field select {
    width: 100%;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    color: inherit;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 0.88em;
    outline: none;
    box-sizing: border-box;
  }

  .model-id-field {
    flex: 1;
    min-width: 0;
  }

  .model-id-field select,
  .model-id-field input {
    width: 100%;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    color: inherit;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 0.88em;
    outline: none;
    box-sizing: border-box;
  }

  .model-loading {
    font-size: 0.85em;
    opacity: 0.6;
    padding: 8px 0;
  }

  .model-refresh {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0 4px;
    width: auto;
    line-height: 1;
    opacity: 0.65;
    font-size: 0.9em;
  }

  .model-refresh:hover:not(:disabled) {
    opacity: 1;
  }

  .model-refresh:disabled {
    opacity: 0.25;
    cursor: default;
  }

  .model-filter {
    margin-bottom: 6px;
  }

  /* ---- Buttons ---- */
  .inline-btn {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: rgba(255, 255, 255, 0.7);
    padding: 5px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    line-height: 1;
    transition: all 0.15s;
  }

  .inline-btn.danger {
    background: rgba(239, 68, 68, 0.2);
    border-color: rgba(239, 68, 68, 0.35);
    color: #fca5a5;
  }

  .inline-btn.danger:hover {
    background: rgba(239, 68, 68, 0.35);
    color: #fff;
  }

  .add-player-btn {
    width: 100%;
    background: rgba(255, 255, 255, 0.04);
    border: 1px dashed rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.5);
    padding: 9px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85em;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .add-player-btn:hover {
    border-color: rgba(139, 92, 246, 0.4);
    color: #c4b5fd;
  }

  /* ---- Actions Bar ---- */
  .player-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 16px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(0, 0, 0, 0.2);
  }

  .btn-cancel {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.7);
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.88em;
    transition: all 0.15s;
  }

  .btn-cancel:hover {
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
  }

  .btn-save {
    background: #8b5cf6;
    border: none;
    color: #fff;
    padding: 8px 20px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.88em;
    font-weight: 500;
    transition: all 0.15s;
  }

  .btn-save:hover:not(:disabled) {
    background: #7c3aed;
  }

  .btn-save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
