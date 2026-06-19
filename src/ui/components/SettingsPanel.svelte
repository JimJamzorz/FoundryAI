<script lang="ts">
  import { openRouterService, type ModelInfo } from '@core/openrouter-service';
  import { embeddingService } from '@core/embedding-service';
  import { collectionReader } from '@core/collection-reader';
  import { getSetting, setSetting, type ApiProvider } from '../../settings';

  interface Props {
    application?: any;
  }

  let { application }: Props = $props();

  // ---- State ----
  let providers = $state<ApiProvider[]>([]);
  let chatProvider = $state('');
  let embeddingProvider = $state('');
  let imageProvider = $state('');
  let ttsProvider = $state('');
  let providerTesting = $state<Record<string, boolean>>({});
  let providerTestResults = $state<Record<string, {success: boolean; message: string} | null>>({});

  let chatModel = $state('');
  let embeddingModel = $state('');
  let temperature = $state(0.8);
  let maxTokens = $state(4096);
  let maxToolDepth = $state(0);
  let streamResponses = $state(true);
  let autoIndex = $state(true);
  let enableTools = $state(true);
  let enableRAG = $state(false);
  let playerFolder = $state('');
  let enableSceneTools = $state(true);
  let enableDiceTools = $state(true);
  let enableTokenTools = $state(true);
  let enableCombatTools = $state(true);
  let enableAudioTools = $state(true);
  let enableChatTools = $state(true);
  let enableCompendiumTools = $state(true);
  let enableSpatialTools = $state(true);
  let enableTTS = $state(true);
  let ttsVoice = $state('nova');
  let enableActorTools = $state(true);
  let enableItemTools = $state(true);
  let enableMacroTools = $state(true);
  let enableImageTools = $state(true);
  let imageModel = $state('openai/dall-e-3');
  let ttsModel = $state('openai/tts-1');
  let systemPromptOverride = $state('');
  let selectedJournalFolders = $state<string[]>([]);
  let selectedActorFolders = $state<string[]>([]);
  let selectedSceneFolders = $state<string[]>([]);
  let selectedMacroFolders = $state<string[]>([]);
  let contextSummarizeThreshold = $state(75);
  let summarizeKeepMessages = $state(10);

  let chatModels = $state<ModelInfo[]>([]);
  let embeddingModels = $state<ModelInfo[]>([]);
  let imageModels = $state<ModelInfo[]>([]);
  let ttsModels = $state<ModelInfo[]>([]);
  let chatModelFilter = $state('');
  let embeddingModelFilter = $state('');
  let imageModelFilter = $state('');
  let ttsModelFilter = $state('');
  let loadingChatModels = $state(false);
  let loadingEmbeddingModels = $state(false);
  let loadingImageModels = $state(false);
  let loadingTtsModels = $state(false);
  let macroFolders = $state<Array<{ id: string; name: string; path: string }>>([]);
  let journalFolders = $state<Array<{ id: string; name: string; path: string }>>([]);
  let actorFolders = $state<Array<{ id: string; name: string; path: string }>>([]);
  let sceneFolders = $state<Array<{ id: string; name: string; path: string }>>([]);

  let isSaving = $state(false);
  let indexStats = $state<{ totalVectors: number; documents: number } | null>(null);
  let isIndexing = $state(false);
  let indexProgress = $state('');

  // ---- Load current settings ----
  $effect(() => {
    try {
      providers = (getSetting('apiProviders') || []) as ApiProvider[];
      chatProvider = getSetting('chatProvider') || '';
      embeddingProvider = getSetting('embeddingProvider') || '';
      imageProvider = getSetting('imageProvider') || '';
      ttsProvider = getSetting('ttsProvider') || '';
      chatModel = getSetting('chatModel') || 'anthropic/claude-sonnet-4';
      embeddingModel = getSetting('embeddingModel') || 'openai/text-embedding-3-small';
      temperature = getSetting('temperature') ?? 0.8;
      maxTokens = getSetting('maxTokens') ?? 4096;
      maxToolDepth = getSetting('maxToolDepth') ?? 0;
      streamResponses = getSetting('streamResponses') ?? true;
      autoIndex = getSetting('autoIndex') ?? true;
      enableTools = getSetting('enableTools') ?? true;
      enableRAG = getSetting('enableRAG') ?? false;
      playerFolder = getSetting('playerFolder') || '';
      enableSceneTools = getSetting('enableSceneTools') ?? true;
      enableDiceTools = getSetting('enableDiceTools') ?? true;
      enableTokenTools = getSetting('enableTokenTools') ?? true;
      enableCombatTools = getSetting('enableCombatTools') ?? true;
      enableAudioTools = getSetting('enableAudioTools') ?? true;
      enableChatTools = getSetting('enableChatTools') ?? true;
      enableCompendiumTools = getSetting('enableCompendiumTools') ?? true;
      enableSpatialTools = getSetting('enableSpatialTools') ?? true;
      enableTTS = getSetting('enableTTS') ?? true;
      ttsVoice = getSetting('ttsVoice') || 'nova';
      enableActorTools = getSetting('enableActorTools') ?? true;
      enableItemTools = getSetting('enableItemTools') ?? true;
      enableMacroTools = getSetting('enableMacroTools') ?? true;
      enableImageTools = getSetting('enableImageTools') ?? true;
      imageModel = getSetting('imageModel') || 'openai/dall-e-3';
      ttsModel = getSetting('ttsModel') || 'openai/tts-1';
      systemPromptOverride = getSetting('systemPromptOverride') || '';
      selectedJournalFolders = getSetting('journalFolders') || [];
      selectedActorFolders = getSetting('actorFolders') || [];
      selectedSceneFolders = getSetting('sceneFolders') || [];
      selectedMacroFolders = getSetting('macroFolders') || [];
      contextSummarizeThreshold = getSetting('contextSummarizeThreshold') ?? 75;
      summarizeKeepMessages = getSetting('summarizeKeepMessages') ?? 10;
    } catch { /* settings not registered yet */ }

    // Load available folders
    journalFolders = collectionReader.getJournalFolders();
    actorFolders = collectionReader.getActorFolders();
    sceneFolders = collectionReader.getSceneFolders();
    macroFolders = collectionReader.getMacroFolders();

    // Load index stats
    embeddingService.getStats().then(stats => {
      if (stats) indexStats = { totalVectors: stats.totalVectors, documents: stats.totalDocuments };
    });
  });

  // ---- Provider Management ----
  function addProvider() {
    providers = [...providers, { id: crypto.randomUUID(), name: 'New Provider', baseUrl: '', apiKey: '' }];
  }

  function removeProvider(id: string) {
    providers = providers.filter(p => p.id !== id);
    if (chatProvider === id) chatProvider = '';
    if (embeddingProvider === id) embeddingProvider = '';
    if (imageProvider === id) imageProvider = '';
    if (ttsProvider === id) ttsProvider = '';
  }

  async function testProvider(provider: ApiProvider) {
    providerTesting = { ...providerTesting, [provider.id]: true };
    providerTestResults = { ...providerTestResults, [provider.id]: null };
    try {
      const result = await openRouterService.testConnection({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
      providerTestResults = { ...providerTestResults, [provider.id]: result };
    } catch (err: any) {
      providerTestResults = { ...providerTestResults, [provider.id]: { success: false, message: `❌ ${err.message}` } };
    } finally {
      providerTesting = { ...providerTesting, [provider.id]: false };
    }
  }

  // ---- Model Loading (auto on provider change) ----
  const byName = (a: ModelInfo, b: ModelInfo) => (a.name ?? a.id).localeCompare(b.name ?? b.id);

  async function loadModelsForType(type: 'chat' | 'embedding' | 'image' | 'tts', providerId: string) {
    const provider = providers.find(p => p.id === providerId);
    if (!provider) {
      if (type === 'chat') chatModels = [];
      else if (type === 'embedding') embeddingModels = [];
      else if (type === 'image') imageModels = [];
      else ttsModels = [];
      return;
    }

    if (type === 'chat') loadingChatModels = true;
    else if (type === 'embedding') loadingEmbeddingModels = true;
    else if (type === 'image') loadingImageModels = true;
    else loadingTtsModels = true;

    try {
      const all = await openRouterService.listModels({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
      if (type === 'chat') {
        chatModels = all.filter(m => (!m.architecture?.modality || m.architecture.modality.includes('text')) && !m.id.includes('embedding')).sort(byName);
        chatModelFilter = '';
        if (chatModels.length === 0) chatModel = '';
      } else if (type === 'embedding') {
        embeddingModels = all.filter(m => m.id.includes('embed') || m.architecture?.modality === 'embedding').sort(byName);
        embeddingModelFilter = '';
        if (embeddingModels.length === 0) embeddingModel = '';
      } else if (type === 'image') {
        imageModels = all.filter(m => m.architecture?.modality?.includes('image') || m.id.includes('dall-e') || m.id.includes('flux') || m.id.includes('image')).sort(byName);
        imageModelFilter = '';
        if (imageModels.length === 0) imageModel = '';
      } else {
        ttsModels = all.filter(m => m.id.includes('tts') || m.id.includes('audio') || m.architecture?.modality?.includes('audio')).sort(byName);
        ttsModelFilter = '';
        if (ttsModels.length === 0) ttsModel = '';
      }
    } catch (err: any) {
      ui.notifications.error(`Failed to load ${type} models: ${err.message}`);
    } finally {
      if (type === 'chat') loadingChatModels = false;
      else if (type === 'embedding') loadingEmbeddingModels = false;
      else if (type === 'image') loadingImageModels = false;
      else loadingTtsModels = false;
    }
  }

  // ---- Save ----
  async function handleSave() {
    isSaving = true;
    try {
      await setSetting('apiProviders', providers);
      await setSetting('chatProvider', chatProvider);
      await setSetting('embeddingProvider', embeddingProvider);
      await setSetting('imageProvider', imageProvider);
      await setSetting('ttsProvider', ttsProvider);
      await setSetting('chatModel', chatModel);
      await setSetting('embeddingModel', embeddingModel);
      await setSetting('temperature', temperature);
      await setSetting('maxTokens', maxTokens);
      await setSetting('maxToolDepth', maxToolDepth);
      await setSetting('streamResponses', streamResponses);
      await setSetting('autoIndex', autoIndex);
      await setSetting('enableTools', enableTools);
      await setSetting('enableRAG', enableRAG);
      await setSetting('playerFolder', playerFolder);
      await setSetting('enableSceneTools', enableSceneTools);
      await setSetting('enableDiceTools', enableDiceTools);
      await setSetting('enableTokenTools', enableTokenTools);
      await setSetting('enableCombatTools', enableCombatTools);
      await setSetting('enableAudioTools', enableAudioTools);
      await setSetting('enableChatTools', enableChatTools);
      await setSetting('enableCompendiumTools', enableCompendiumTools);
      await setSetting('enableSpatialTools', enableSpatialTools);
      await setSetting('enableTTS', enableTTS);
      await setSetting('ttsVoice', ttsVoice);
      await setSetting('enableActorTools', enableActorTools);
      await setSetting('enableItemTools', enableItemTools);
      await setSetting('enableMacroTools', enableMacroTools);
      await setSetting('enableImageTools', enableImageTools);
      await setSetting('imageModel', imageModel);
      await setSetting('ttsModel', ttsModel);
      await setSetting('systemPromptOverride', systemPromptOverride);
      await setSetting('journalFolders', selectedJournalFolders);
      await setSetting('actorFolders', selectedActorFolders);
      await setSetting('sceneFolders', selectedSceneFolders);
      await setSetting('macroFolders', selectedMacroFolders);
      await setSetting('contextSummarizeThreshold', contextSummarizeThreshold);
      await setSetting('summarizeKeepMessages', summarizeKeepMessages);

      // Reconfigure the service with all model settings
      const findProvider = (id: string) => providers.find(p => p.id === id);
      const toConfig = (p: ApiProvider | undefined) => ({ baseUrl: p?.baseUrl ?? '', apiKey: p?.apiKey ?? '' });
      openRouterService.configure({
        chat: toConfig(findProvider(chatProvider)),
        embedding: toConfig(findProvider(embeddingProvider)),
        image: toConfig(findProvider(imageProvider)),
        tts: toConfig(findProvider(ttsProvider)),
        defaultModel: chatModel, embeddingModel, imageModel, ttsModel,
      });

      // Refresh stats display
      await refreshStats();

      ui.notifications.info('FoundryAI settings saved!');
      application?.close();
    } catch (err: any) {
      ui.notifications.error(`Failed to save: ${err.message}`);
    } finally {
      isSaving = false;
    }
  }

  function toggleFolder(list: string[], folderId: string): string[] {
    if (list.includes(folderId)) {
      return list.filter(id => id !== folderId);
    }
    return [...list, folderId];
  }

  async function refreshStats() {
    try {
      const stats = await embeddingService.getStats();
      if (stats) indexStats = { totalVectors: stats.totalVectors, documents: stats.totalDocuments };
      else indexStats = { totalVectors: 0, documents: 0 };
    } catch {
      indexStats = { totalVectors: 0, documents: 0 };
    }
  }

  async function handleReindex() {
    if (!apiKey) {
      ui.notifications.warn('Enter your API key first.');
      return;
    }

    if (selectedJournalFolders.length === 0 && selectedActorFolders.length === 0) {
      ui.notifications.warn('Select at least one folder to index.');
      return;
    }

    isIndexing = true;
    indexProgress = 'Starting...';

    try {
      // Make sure service is configured
      const embProv = providers.find(p => p.id === embeddingProvider);
      openRouterService.configure({
        embedding: { baseUrl: embProv?.baseUrl ?? '', apiKey: embProv?.apiKey ?? '' },
        defaultModel: chatModel, embeddingModel,
      });

      // Ensure embedding service is initialized
      if (!embeddingService.isInitialized) {
        const worldId = game.world?.id || 'default';
        await embeddingService.initialize(worldId);
      }

      // Save folder selections first
      await setSetting('journalFolders', selectedJournalFolders);
      await setSetting('actorFolders', selectedActorFolders);
      await setSetting('sceneFolders', selectedSceneFolders);

      await embeddingService.reindexAll(selectedJournalFolders, selectedActorFolders, (progress) => {
        indexProgress = progress.message || `${progress.phase}: ${progress.current}/${progress.total}`;
      });

      await refreshStats();
      ui.notifications.info('Indexing complete!');
    } catch (err: any) {
      console.error('FoundryAI | Reindex failed:', err);
      ui.notifications.error(`Indexing failed: ${err.message}`);
    } finally {
      isIndexing = false;
      indexProgress = '';
    }
  }
</script>

<div class="settings-panel">
  <div class="settings-scroll">
    <!-- API Configuration -->
    <section class="settings-section">
      <h2><i class="fas fa-key"></i> API Providers</h2>

      {#if providers.length === 0}
        <p class="section-hint">No providers configured. Add one below.</p>
      {:else}
        <table class="provider-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Base URL</th>
              <th>API Key</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each providers as provider (provider.id)}
              <tr>
                <td><input type="text" bind:value={provider.name} placeholder="e.g. OpenRouter" /></td>
                <td><input type="text" bind:value={provider.baseUrl} placeholder="blank = OpenRouter" /></td>
                <td><input type="password" bind:value={provider.apiKey} placeholder="API key (optional)" /></td>
                <td class="provider-actions">
                  <button class="inline-btn" onclick={() => testProvider(provider)} disabled={providerTesting[provider.id]}>
                    {providerTesting[provider.id] ? '…' : 'Test'}
                  </button>
                  <button class="inline-btn danger" onclick={() => removeProvider(provider.id)}>×</button>
                </td>
              </tr>
              {#if providerTestResults[provider.id]}
                <tr class="test-result-row">
                  <td colspan="4">
                    <span class="field-result" class:success={providerTestResults[provider.id]?.success} class:error={!providerTestResults[provider.id]?.success}>
                      {providerTestResults[provider.id]?.message}
                    </span>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {/if}

      <button class="add-provider-btn" onclick={addProvider}>
        <i class="fas fa-plus"></i> Add Provider
      </button>
    </section>

    <!-- Model Selection -->
    <section class="settings-section">
      <h2><i class="fas fa-robot"></i> Models</h2>

      {#snippet modelProviderSelect(label: string, modelId: string, providerId: string, loading: boolean, models: ModelInfo[], filter: string, placeholder: string, onProviderChange: (id: string) => void, onModelChange: (v: string) => void, onFilterChange: (v: string) => void)}
        <div class="model-row">
          <div class="model-provider-field">
            <label>{label}</label>
            <select value={providerId} onchange={(e) => onProviderChange((e.target as HTMLSelectElement).value)}>
              <option value="">— Provider —</option>
              {#each providers as p (p.id)}
                <option value={p.id}>{p.name}</option>
              {/each}
            </select>
          </div>
          <div class="model-id-field">
            <label>&nbsp;</label>
            {#if loading}
              <div class="model-loading"><i class="fas fa-spinner fa-spin"></i> Loading...</div>
            {:else if models.length > 0}
              <input class="model-filter" type="text" value={filter} oninput={(e) => onFilterChange((e.target as HTMLInputElement).value)} placeholder="Filter models..." />
              <select value={modelId} onchange={(e) => onModelChange((e.target as HTMLSelectElement).value)}>
                {#each models.filter(m => !filter || m.id === modelId || (m.name ?? '').toLowerCase().includes(filter.toLowerCase()) || m.id.toLowerCase().includes(filter.toLowerCase())) as m (m.id)}
                  <option value={m.id}>{m.name ?? m.id} {m.name ? `(${m.id})` : ''}</option>
                {/each}
              </select>
            {:else}
              <input type="text" value={modelId} oninput={(e) => onModelChange((e.target as HTMLInputElement).value)} placeholder={placeholder} />
            {/if}
          </div>
        </div>
      {/snippet}

      {@render modelProviderSelect(
        'Chat Model', chatModel, chatProvider, loadingChatModels, chatModels, chatModelFilter,
        'e.g. anthropic/claude-sonnet-4',
        (id) => { chatProvider = id; loadModelsForType('chat', id); },
        (v) => { chatModel = v; },
        (v) => { chatModelFilter = v; }
      )}

      {@render modelProviderSelect(
        'Embedding Model', embeddingModel, embeddingProvider, loadingEmbeddingModels, embeddingModels, embeddingModelFilter,
        'e.g. openai/text-embedding-3-small',
        (id) => { embeddingProvider = id; loadModelsForType('embedding', id); },
        (v) => { embeddingModel = v; },
        (v) => { embeddingModelFilter = v; }
      )}

      {@render modelProviderSelect(
        'Image Model', imageModel, imageProvider, loadingImageModels, imageModels, imageModelFilter,
        'e.g. openai/dall-e-3',
        (id) => { imageProvider = id; loadModelsForType('image', id); },
        (v) => { imageModel = v; },
        (v) => { imageModelFilter = v; }
      )}

      {@render modelProviderSelect(
        'TTS Model', ttsModel, ttsProvider, loadingTtsModels, ttsModels, ttsModelFilter,
        'e.g. openai/gpt-4o-mini-tts',
        (id) => { ttsProvider = id; loadModelsForType('tts', id); },
        (v) => { ttsModel = v; },
        (v) => { ttsModelFilter = v; }
      )}
    </section>

    <!-- LLM Parameters -->
    <section class="settings-section">
      <h2><i class="fas fa-sliders-h"></i> Parameters</h2>

      <div class="field">
        <label for="temperature">Temperature: {temperature.toFixed(1)}</label>
        <input id="temperature" type="range" min="0" max="2" step="0.1" bind:value={temperature} />
      </div>

      <div class="field">
        <label for="max-tokens">Max Tokens</label>
        <input id="max-tokens" type="number" bind:value={maxTokens} min="256" max="128000" step="256" />
      </div>

      <div class="field">
        <label for="max-tool-depth">Max Tool Call Rounds (0 = unlimited)</label>
        <input id="max-tool-depth" type="number" bind:value={maxToolDepth} min="0" max="50" step="1" />
        <small class="hint">How many rounds of tool calls the AI can chain. 0 means no limit.</small>
      </div>

      <div class="field checkbox-field">
        <label>
          <input type="checkbox" bind:checked={streamResponses} />
          Stream Responses
        </label>
      </div>

      <div class="field checkbox-field">
        <label>
          <input type="checkbox" bind:checked={enableTools} />
          Enable Tool Use (search, create journals, etc.)
        </label>
      </div>

      {#if enableTools}
      <div class="tool-category-toggles" style="margin-left: 1.5rem; display: flex; flex-direction: column; gap: 0.25rem;">
        <small style="color: var(--color-text-dark-5); margin-bottom: 0.25rem;">Tool Categories:</small>
        <label><input type="checkbox" bind:checked={enableSceneTools} /> Scene Tools (list, view, activate scenes)</label>
        <label><input type="checkbox" bind:checked={enableDiceTools} /> Dice Tools (roll dice, ability checks)</label>
        <label><input type="checkbox" bind:checked={enableTokenTools} /> Token Tools (place, move, hide tokens)</label>
        <label><input type="checkbox" bind:checked={enableCombatTools} /> Combat Tools (initiative, damage, conditions)</label>
        <label><input type="checkbox" bind:checked={enableAudioTools} /> Audio Tools (playlists, tracks)</label>
        <label><input type="checkbox" bind:checked={enableChatTools} /> Chat Tools (post messages, NPC dialogue)</label>
        <label><input type="checkbox" bind:checked={enableCompendiumTools} /> Compendium Tools (search, import entries)</label>
        <label><input type="checkbox" bind:checked={enableSpatialTools} /> Spatial Tools (measure distance, templates)</label>
        <label><input type="checkbox" bind:checked={enableActorTools} /> Actor Tools (create, update, delete actors)</label>
        <label><input type="checkbox" bind:checked={enableItemTools} /> Item Tools (create, update, delete items)</label>
        <label><input type="checkbox" bind:checked={enableMacroTools} /> Macro Tools (create, update, execute macros)</label>
        <label><input type="checkbox" bind:checked={enableImageTools} /> Image Tools (generate images, create scenes)</label>
      </div>
      {/if}

      <div class="field checkbox-field">
        <label>
          <input type="checkbox" bind:checked={enableRAG} />
          Enable RAG Context
        </label>
        <small style="color: var(--color-text-dark-5); margin-left: 1.5rem; display: block;">
          Injects relevant document excerpts into each prompt via embedding search. Increases token usage.
        </small>
      </div>

      <div class="field checkbox-field">
        <label>
          <input type="checkbox" bind:checked={autoIndex} />
          Auto-index on startup
        </label>
      </div>

      <div class="field checkbox-field">
        <label>
          <input type="checkbox" bind:checked={enableTTS} />
          Enable Text-to-Speech on quotes
        </label>
      </div>

      {#if enableTTS}
      <div class="field" style="margin-left: 1.5rem;">
        <label for="tts-voice">TTS Voice</label>
        <select id="tts-voice" bind:value={ttsVoice}>
          <option value="alloy">Alloy</option>
          <option value="echo">Echo</option>
          <option value="fable">Fable</option>
          <option value="onyx">Onyx</option>
          <option value="nova">Nova</option>
          <option value="shimmer">Shimmer</option>
        </select>
      </div>
      {/if}
    </section>

    <!-- AI Data Access -->
    <section class="settings-section">
      <h2><i class="fas fa-shield-alt"></i> AI Data Access</h2>
      <p class="section-hint">
        Select which folders the AI can see and search. Unselected folders are completely hidden from the AI.
        Journal and actor folders are also used for RAG indexing.
      </p>

      {#if indexStats}
        <div class="stats-bar">
          <span>📊 {indexStats.totalVectors} vectors across {indexStats.documents} documents</span>
        </div>
      {/if}

      {#if isIndexing}
        <div class="index-progress">
          <i class="fas fa-spinner fa-spin"></i> {indexProgress}
        </div>
      {/if}

      <div class="field">
        <span class="field-label"><i class="fas fa-book-open"></i> Journal Folders</span>
        <div class="folder-list">
          {#if journalFolders.length === 0}
            <span class="empty-hint">No journal folders found in this world.</span>
          {:else}
            {#each journalFolders as folder (folder.id)}
              <label class="folder-item">
                <input
                  type="checkbox"
                  checked={selectedJournalFolders.includes(folder.id)}
                  onchange={() => { selectedJournalFolders = toggleFolder(selectedJournalFolders, folder.id); }}
                />
                <span title={folder.path}>{folder.path}</span>
              </label>
            {/each}
          {/if}
        </div>
      </div>

      <div class="field">
        <span class="field-label"><i class="fas fa-users"></i> Actor Folders</span>
        <div class="folder-list">
          {#if actorFolders.length === 0}
            <span class="empty-hint">No actor folders found in this world.</span>
          {:else}
            {#each actorFolders as folder (folder.id)}
              <label class="folder-item">
                <input
                  type="checkbox"
                  checked={selectedActorFolders.includes(folder.id)}
                  onchange={() => { selectedActorFolders = toggleFolder(selectedActorFolders, folder.id); }}
                />
                <span title={folder.path}>{folder.path}</span>
              </label>
            {/each}
          {/if}
        </div>
      </div>

      <div class="field">
        <span class="field-label"><i class="fas fa-dice-d20"></i> Player Character Folder</span>
        <small style="color: var(--color-text-dark-5); display: block; margin-bottom: 0.25rem;">
          Actor folder containing player characters. Their details are included in every prompt.
        </small>
        <select bind:value={playerFolder} style="width: 100%;">
          <option value="">— None —</option>
          {#each actorFolders as folder (folder.id)}
            <option value={folder.id}>{folder.path}</option>
          {/each}
        </select>
      </div>

      <div class="field">
        <span class="field-label"><i class="fas fa-map"></i> Scene Folders</span>
        <div class="folder-list">
          {#if sceneFolders.length === 0}
            <span class="empty-hint">No scene folders found in this world.</span>
          {:else}
            {#each sceneFolders as folder (folder.id)}
              <label class="folder-item">
                <input
                  type="checkbox"
                  checked={selectedSceneFolders.includes(folder.id)}
                  onchange={() => { selectedSceneFolders = toggleFolder(selectedSceneFolders, folder.id); }}
                />
                <span title={folder.path}>{folder.path}</span>
              </label>
            {/each}
          {/if}
        </div>
      </div>

      <div class="field">
        <span class="field-label"><i class="fas fa-terminal"></i> Macro Folders</span>
        <div class="folder-list">
          {#if macroFolders.length === 0}
            <span class="empty-hint">No macro folders found in this world.</span>
          {:else}
            {#each macroFolders as folder (folder.id)}
              <label class="folder-item">
                <input
                  type="checkbox"
                  checked={selectedMacroFolders.includes(folder.id)}
                  onchange={() => { selectedMacroFolders = toggleFolder(selectedMacroFolders, folder.id); }}
                />
                <span title={folder.path}>{folder.path}</span>
              </label>
            {/each}
          {/if}
        </div>
      </div>

      <button class="reindex-btn" onclick={handleReindex} disabled={isIndexing}>
        <i class="fas" class:fa-sync-alt={!isIndexing} class:fa-spinner={isIndexing} class:fa-spin={isIndexing}></i>
        {isIndexing ? 'Indexing...' : 'Reindex Now'}
      </button>
    </section>

    <!-- System Prompt -->
    <section class="settings-section">
      <h2><i class="fas fa-scroll"></i> System Prompt Override</h2>
      <div class="field">
        <label for="system-prompt">Leave blank to use the default DM assistant prompt.</label>
        <textarea
          id="system-prompt"
          bind:value={systemPromptOverride}
          rows="6"
          placeholder="Custom system prompt (optional)..."
        ></textarea>
      </div>
    </section>

    <!-- Context Management -->
    <section class="settings-section">
      <h2><i class="fas fa-compress-arrows-alt"></i> Context Management</h2>
      <p class="section-hint">Control how conversation context is managed to prevent quality degradation in long chats.</p>

      <div class="field">
        <label for="ctx-threshold">Auto-summarize prompt threshold: {contextSummarizeThreshold}%</label>
        <input
          id="ctx-threshold"
          type="range"
          min="0"
          max="95"
          step="5"
          bind:value={contextSummarizeThreshold}
        />
        <span class="field-hint">{contextSummarizeThreshold === 0 ? 'Disabled — never auto-prompt' : `Prompt to summarize when context exceeds ${contextSummarizeThreshold}%`}</span>
      </div>

      <div class="field">
        <label for="ctx-keep">Messages to keep when summarizing</label>
        <input
          id="ctx-keep"
          type="number"
          min="4"
          max="30"
          bind:value={summarizeKeepMessages}
        />
        <span class="field-hint">Recent messages preserved during summarization (older messages are replaced with a summary)</span>
      </div>
    </section>
  </div>

  <!-- Actions -->
  <div class="settings-actions">
    <button class="btn-cancel" onclick={() => application?.close()}>Cancel</button>
    <button class="btn-save" onclick={handleSave} disabled={isSaving}>
      {isSaving ? 'Saving...' : 'Save Settings'}
    </button>
  </div>
</div>

<style>
  .settings-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--foundry-ai-bg, #1a1a2e);
    color: var(--foundry-ai-text, #e0e0e0);
    font-family: 'Signika', sans-serif;
  }

  .settings-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
  }

  .settings-scroll::-webkit-scrollbar {
    width: 6px;
  }

  .settings-scroll::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
  }

  .settings-section {
    margin-bottom: 20px;
    padding-bottom: 16px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .settings-section:last-child {
    border-bottom: none;
  }

  .settings-section h2 {
    font-size: 0.95em;
    color: #e0c080;
    margin: 0 0 12px 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .settings-section h2 i {
    font-size: 0.85em;
    opacity: 0.7;
  }

  .section-hint {
    font-size: 0.8em;
    color: rgba(255, 255, 255, 0.45);
    margin: -6px 0 12px 0;
    line-height: 1.4;
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

  .field-label {
    display: block;
    font-size: 0.82em;
    font-weight: 500;
    margin-bottom: 4px;
    opacity: 0.8;
  }

  .field input[type="text"],
  .field input[type="password"],
  .field input[type="number"],
  .field select,
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

  .field input:focus,
  .field select:focus,
  .field textarea:focus {
    border-color: rgba(139, 92, 246, 0.5);
  }

  .field input[type="range"] {
    width: 100%;
    accent-color: #8b5cf6;
  }

  .field textarea {
    resize: vertical;
    min-height: 80px;
    line-height: 1.4;
  }

  .input-group {
    display: flex;
    gap: 6px;
  }

  .input-group input {
    flex: 1;
  }

  .inline-btn {
    background: rgba(139, 92, 246, 0.3);
    border: 1px solid rgba(139, 92, 246, 0.4);
    color: #c4b5fd;
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85em;
    white-space: nowrap;
    transition: all 0.15s;
  }

  .inline-btn:hover:not(:disabled) {
    background: rgba(139, 92, 246, 0.5);
    color: #fff;
  }

  .inline-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .field-result {
    display: block;
    font-size: 0.8em;
    margin-top: 4px;
  }

  .field-result.success { color: #4ade80; }
  .field-result.error { color: #f87171; }

  /* ---- Provider Table ---- */
  .provider-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82em;
    margin-bottom: 8px;
  }

  .provider-table th {
    text-align: left;
    padding: 4px 6px;
    color: rgba(255,255,255,0.4);
    font-weight: 500;
    border-bottom: 1px solid rgba(255,255,255,0.08);
  }

  .provider-table td {
    padding: 4px 4px;
    vertical-align: top;
  }

  .provider-table td input {
    width: 100%;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 4px;
    color: inherit;
    padding: 5px 8px;
    font-family: inherit;
    font-size: 1em;
    outline: none;
    box-sizing: border-box;
  }

  .provider-table td input:focus {
    border-color: rgba(139,92,246,0.5);
  }

  .provider-actions {
    white-space: nowrap;
    width: 1%;
    display: flex;
    gap: 4px;
    align-items: flex-start;
    padding-top: 5px;
  }

  .inline-btn.danger {
    background: rgba(239,68,68,0.2);
    border-color: rgba(239,68,68,0.35);
    color: #fca5a5;
  }

  .inline-btn.danger:hover:not(:disabled) {
    background: rgba(239,68,68,0.35);
    color: #fff;
  }

  .test-result-row td {
    padding: 0 6px 6px 6px;
  }

  .add-provider-btn {
    width: 100%;
    background: rgba(255,255,255,0.04);
    border: 1px dashed rgba(255,255,255,0.15);
    color: rgba(255,255,255,0.5);
    padding: 7px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.82em;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .add-provider-btn:hover {
    border-color: rgba(139,92,246,0.4);
    color: #c4b5fd;
  }

  /* ---- Model Rows ---- */
  .model-row {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
    align-items: flex-start;
  }

  .model-provider-field {
    flex: 0 0 160px;
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
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
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

  .model-loading {
    padding: 8px 10px;
    font-size: 0.82em;
    color: rgba(255,255,255,0.4);
  }

  .model-filter {
    width: 100%;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    color: inherit;
    padding: 6px 10px;
    font-family: inherit;
    font-size: 0.82em;
    outline: none;
    box-sizing: border-box;
  }

  .model-filter:focus {
    border-color: rgba(139, 92, 246, 0.5);
  }

  .model-filter + select {
    border-radius: 0 0 6px 6px;
  }

  .load-models-btn {
    width: 100%;
    background: rgba(255, 255, 255, 0.05);
    border: 1px dashed rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.6);
    padding: 8px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85em;
    margin-bottom: 12px;
    transition: all 0.15s;
  }

  .load-models-btn:hover:not(:disabled) {
    border-color: rgba(139, 92, 246, 0.4);
    color: #c4b5fd;
  }

  .checkbox-field label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 0.88em;
    opacity: 1;
  }

  .checkbox-field input[type="checkbox"] {
    accent-color: #8b5cf6;
    width: 16px;
    height: 16px;
  }

  .stats-bar {
    background: rgba(139, 92, 246, 0.1);
    border: 1px solid rgba(139, 92, 246, 0.2);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 0.8em;
    color: #c4b5fd;
    margin-bottom: 12px;
  }

  .index-progress {
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 0.8em;
    color: #93c5fd;
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .reindex-btn {
    width: 100%;
    background: rgba(34, 197, 94, 0.15);
    border: 1px solid rgba(34, 197, 94, 0.3);
    color: #86efac;
    padding: 8px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.85em;
    margin-top: 8px;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .reindex-btn:hover:not(:disabled) {
    background: rgba(34, 197, 94, 0.25);
    color: #4ade80;
  }

  .reindex-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .folder-list {
    max-height: 160px;
    overflow-y: auto;
    background: rgba(0, 0, 0, 0.15);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    padding: 6px;
  }

  .folder-item {
    display: flex !important;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
    transition: background 0.1s;
  }

  .folder-item:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .empty-hint {
    font-size: 0.82em;
    opacity: 0.4;
    padding: 8px;
  }

  /* ---- Actions Bar ---- */
  .settings-actions {
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
