<script lang="ts">
  import { TOOL_CATEGORIES, getAvailableTools } from '@core/tool-system';
  import { getSetting, setSetting, type ToolPreset } from '../../settings';

  interface Props {
    initialSelection: string[];
    onApply: (toolNames: string[]) => void;
    application?: any;
  }

  let { initialSelection, onApply, application }: Props = $props();

  const availableNames = new Set(getAvailableTools().map(t => t.function.name));
  const categories = TOOL_CATEGORIES
    .map(cat => ({ ...cat, tools: cat.tools.filter(t => availableNames.has(t.function.name)) }))
    .filter(cat => cat.tools.length > 0);

  let checked = $state<Set<string>>(new Set(initialSelection.filter(n => availableNames.has(n))));
  let search = $state('');
  let presets = $state<ToolPreset[]>(getSetting('toolPresets') || []);
  let newPresetName = $state('');

  function indeterminateAction(node: HTMLInputElement, value: boolean) {
    node.indeterminate = value;
    return {
      update(v: boolean) { node.indeterminate = v; },
    };
  }

  function toggleTool(name: string) {
    const next = new Set(checked);
    if (next.has(name)) next.delete(name); else next.add(name);
    checked = next;
  }

  function categoryCheckedCount(cat: { tools: { function: { name: string } }[] }): number {
    return cat.tools.filter(t => checked.has(t.function.name)).length;
  }

  function setCategory(cat: { tools: { function: { name: string } }[] }, value: boolean) {
    const next = new Set(checked);
    for (const t of cat.tools) {
      if (value) next.add(t.function.name); else next.delete(t.function.name);
    }
    checked = next;
  }

  function selectAll() {
    checked = new Set(categories.flatMap(c => c.tools.map(t => t.function.name)));
  }

  function selectNone() {
    checked = new Set();
  }

  function matchesSearch(name: string, description: string): boolean {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return name.toLowerCase().includes(q) || description.toLowerCase().includes(q);
  }

  // A saved grouping behaves as a single toggle: if every tool in it is already
  // checked, clicking it clears them all; otherwise clicking it checks them all.
  function togglePreset(preset: ToolPreset) {
    const allChecked = preset.toolNames.every(n => checked.has(n));
    const next = new Set(checked);
    for (const name of preset.toolNames) {
      if (allChecked) next.delete(name); else next.add(name);
    }
    checked = next;
  }

  function isPresetActive(preset: ToolPreset): boolean {
    return preset.toolNames.length > 0 && preset.toolNames.every(n => checked.has(n));
  }

  async function saveCurrentAsPreset() {
    const name = newPresetName.trim();
    if (!name || checked.size === 0) return;
    const existing = presets.find(p => p.name.toLowerCase() === name.toLowerCase());
    const preset: ToolPreset = { id: existing?.id || crypto.randomUUID(), name, toolNames: [...checked] };
    const next = existing ? presets.map(p => (p.id === preset.id ? preset : p)) : [...presets, preset];
    presets = next;
    await setSetting('toolPresets', next);
    newPresetName = '';
  }

  async function deletePreset(preset: ToolPreset) {
    const next = presets.filter(p => p.id !== preset.id);
    presets = next;
    await setSetting('toolPresets', next);
  }

  function apply() {
    onApply([...checked]);
    application?.close();
  }
</script>

<div class="tool-modal">
  <div class="tool-modal-toolbar">
    <input type="text" class="tool-search" placeholder="Search tools..." bind:value={search} />
    <button class="tool-bulk-btn" onclick={selectAll}>Select All</button>
    <button class="tool-bulk-btn" onclick={selectNone}>Select None</button>
  </div>

  {#if presets.length > 0}
    <div class="tool-presets-row">
      <span class="tool-presets-label">Saved groupings:</span>
      {#each presets as preset (preset.id)}
        <button
          class="preset-chip"
          class:active={isPresetActive(preset)}
          onclick={() => togglePreset(preset)}
          title={`${preset.toolNames.length} tool(s) — click to select/deselect all`}
        >
          {preset.name}
          <span
            class="preset-chip-remove"
            role="button"
            tabindex="0"
            onclick={(e) => { e.stopPropagation(); deletePreset(preset); }}
            onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); deletePreset(preset); } }}
            title="Delete grouping"
          >
            <i class="fas fa-times"></i>
          </span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="tool-modal-body">
    {#each categories as cat (cat.id)}
      {@const checkedCount = categoryCheckedCount(cat)}
      {@const visibleTools = cat.tools.filter(t => matchesSearch(t.function.name, t.function.description || ''))}
      {#if visibleTools.length > 0}
        <div class="tool-category">
          <div class="tool-category-header">
            <label class="tool-category-checkbox">
              <input
                type="checkbox"
                checked={checkedCount === cat.tools.length}
                use:indeterminateAction={checkedCount > 0 && checkedCount < cat.tools.length}
                onchange={() => setCategory(cat, checkedCount !== cat.tools.length)}
              />
              <span class="tool-category-label">{cat.label}</span>
            </label>
            <span class="tool-category-count">{checkedCount}/{cat.tools.length}</span>
          </div>
          <div class="tool-category-list">
            {#each visibleTools as tool (tool.function.name)}
              <label class="tool-item" title={tool.function.description}>
                <input
                  type="checkbox"
                  checked={checked.has(tool.function.name)}
                  onchange={() => toggleTool(tool.function.name)}
                />
                <span class="tool-item-name">{tool.function.name}</span>
              </label>
            {/each}
          </div>
        </div>
      {/if}
    {/each}
  </div>

  <div class="tool-modal-footer">
    <div class="tool-save-row">
      <input
        type="text"
        class="preset-name-input"
        placeholder="Save current selection as..."
        bind:value={newPresetName}
        onkeydown={(e) => { if (e.key === 'Enter') saveCurrentAsPreset(); }}
      />
      <button class="tool-bulk-btn" onclick={saveCurrentAsPreset} disabled={!newPresetName.trim() || checked.size === 0}>
        <i class="fas fa-save"></i> Save Grouping
      </button>
    </div>
    <div class="tool-modal-actions">
      <span class="tool-selected-count">{checked.size} tool{checked.size === 1 ? '' : 's'} selected</span>
      <button class="tool-modal-cancel" onclick={() => application?.close()}>Cancel</button>
      <button class="tool-modal-apply" onclick={apply}>Apply</button>
    </div>
  </div>
</div>

<style>
  .tool-modal {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--foundry-ai-bg, #1a1a2e);
    color: rgba(255, 255, 255, 0.9);
    font-family: 'Signika', sans-serif;
    overflow: hidden;
  }

  .tool-modal-toolbar {
    display: flex;
    gap: 6px;
    padding: 10px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .tool-search {
    flex: 1;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    color: inherit;
    padding: 6px 10px;
    font-size: 0.85em;
    font-family: inherit;
    outline: none;
  }

  .tool-search:focus {
    border-color: rgba(139, 92, 246, 0.5);
  }

  .tool-bulk-btn {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: inherit;
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 0.8em;
    cursor: pointer;
    white-space: nowrap;
  }

  .tool-bulk-btn:hover:not(:disabled) {
    background: rgba(139, 92, 246, 0.2);
    border-color: rgba(139, 92, 246, 0.4);
  }

  .tool-bulk-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .tool-presets-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(0, 0, 0, 0.15);
  }

  .tool-presets-label {
    font-size: 0.75em;
    color: rgba(255, 255, 255, 0.5);
    margin-right: 2px;
  }

  .preset-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: inherit;
    border-radius: 999px;
    padding: 4px 6px 4px 12px;
    font-size: 0.78em;
    cursor: pointer;
  }

  .preset-chip:hover {
    border-color: rgba(139, 92, 246, 0.5);
  }

  .preset-chip.active {
    background: rgba(139, 92, 246, 0.25);
    border-color: #8b5cf6;
    color: #fff;
  }

  .preset-chip-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    color: rgba(255, 255, 255, 0.5);
    font-size: 0.85em;
  }

  .preset-chip-remove:hover {
    background: rgba(220, 38, 38, 0.4);
    color: #fff;
  }

  .tool-modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 14px;
  }

  .tool-category {
    margin-bottom: 10px;
  }

  .tool-category-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 0;
    position: sticky;
    top: 0;
    background: #1e1e24;
  }

  .tool-category-checkbox {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }

  .tool-category-label {
    font-size: 0.85em;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.85);
  }

  .tool-category-count {
    font-size: 0.75em;
    color: rgba(255, 255, 255, 0.4);
  }

  .tool-category-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 2px 10px;
    padding: 4px 0 4px 22px;
  }

  .tool-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 4px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.78em;
    font-family: var(--font-mono, monospace);
    color: rgba(255, 255, 255, 0.75);
  }

  .tool-item:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .tool-modal-footer {
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .tool-save-row {
    display: flex;
    gap: 6px;
  }

  .preset-name-input {
    flex: 1;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    color: inherit;
    padding: 6px 10px;
    font-size: 0.85em;
    font-family: inherit;
    outline: none;
  }

  .preset-name-input:focus {
    border-color: rgba(139, 92, 246, 0.5);
  }

  .tool-modal-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .tool-selected-count {
    flex: 1;
    font-size: 0.78em;
    color: rgba(255, 255, 255, 0.5);
  }

  .tool-modal-cancel,
  .tool-modal-apply {
    border: none;
    border-radius: 6px;
    padding: 7px 14px;
    font-size: 0.85em;
    cursor: pointer;
  }

  .tool-modal-cancel {
    background: rgba(255, 255, 255, 0.08);
    color: inherit;
  }

  .tool-modal-cancel:hover {
    background: rgba(255, 255, 255, 0.14);
  }

  .tool-modal-apply {
    background: #8b5cf6;
    color: #fff;
    font-weight: 600;
  }

  .tool-modal-apply:hover {
    background: #7c3aed;
  }
</style>
