<script lang="ts">
  /* Tool Console — GM-only debug window to run any FoundryAI tool by hand:
     pick a tool, edit its JSON arguments, execute, inspect the raw result.
     Runs through the same executeTool path the LLM uses, so behavior is
     identical to a real tool call. */
  import { TOOL_CATEGORIES, getAvailableTools, executeTool } from '@core/tool-system';
  import type { ToolDefinition } from '@core/openrouter-service';

  interface Props {
    application?: any;
  }

  let { application: _application }: Props = $props();

  interface RunRecord {
    tool: string;
    args: string;
    result: string;
    ok: boolean;
    ms: number;
    at: string;
  }

  const isGM: boolean = (globalThis as any).game?.user?.isGM ?? false;

  // Show every DEFINED tool (a debug console should let you exercise tools even
  // when their category toggle is off), but badge the ones the LLM can't see.
  const enabledNames = new Set(getAvailableTools().map(t => t.function.name));
  const categories = TOOL_CATEGORIES.filter(cat => cat.tools.length > 0);

  let search = $state('');
  let selectedName = $state<string | null>(null);
  let argsText = $state('{}');
  let argsError = $state<string | null>(null);
  let running = $state(false);
  let history = $state<RunRecord[]>([]);

  const selected = $derived.by((): ToolDefinition | null => {
    if (!selectedName) return null;
    for (const cat of categories) {
      const tool = cat.tools.find(t => t.function.name === selectedName);
      if (tool) return tool;
    }
    return null;
  });

  const paramEntries = $derived.by(() => {
    const schema = selected?.function.parameters;
    const props: Record<string, any> = schema?.properties || {};
    const required = new Set<string>(schema?.required || []);
    return Object.entries(props).map(([name, def]) => ({
      name,
      required: required.has(name),
      type: def.enum ? `enum(${def.enum.join(' | ')})` : def.type || 'any',
      description: def.description || '',
      def,
    }));
  });

  function matchesSearch(tool: ToolDefinition): boolean {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      tool.function.name.toLowerCase().includes(q) ||
      tool.function.description.toLowerCase().includes(q)
    );
  }

  function defaultForParam(def: any): any {
    if (def?.enum?.length) return def.enum[0];
    switch (def?.type) {
      case 'number': return 0;
      case 'boolean': return false;
      case 'array': return [];
      case 'object': return {};
      default: return '';
    }
  }

  function skeletonFor(tool: ToolDefinition): string {
    const schema = tool.function.parameters;
    const props: Record<string, any> = schema?.properties || {};
    const required: string[] = schema?.required || [];
    const skeleton: Record<string, any> = {};
    for (const name of required) {
      if (name in props) skeleton[name] = defaultForParam(props[name]);
    }
    return JSON.stringify(skeleton, null, 2);
  }

  function selectTool(name: string) {
    selectedName = name;
    argsError = null;
    const tool = categories.flatMap(c => c.tools).find(t => t.function.name === name);
    argsText = tool ? skeletonFor(tool) : '{}';
  }

  /** Click an optional param in the table to add it to the JSON. */
  function addParam(name: string, def: any) {
    try {
      const parsed = JSON.parse(argsText || '{}');
      if (!(name in parsed)) parsed[name] = defaultForParam(def);
      argsText = JSON.stringify(parsed, null, 2);
      argsError = null;
    } catch {
      argsError = 'Current arguments are not valid JSON — fix them before adding parameters.';
    }
  }

  function prettify(raw: string): string {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  async function run() {
    if (!selected || running) return;
    try {
      JSON.parse(argsText || '{}');
    } catch (e: any) {
      argsError = `Arguments are not valid JSON: ${e.message}`;
      return;
    }
    argsError = null;
    running = true;
    const started = performance.now();
    let raw: string;
    let ok = true;
    try {
      raw = await executeTool({
        id: `manual_${Date.now()}`,
        type: 'function',
        function: { name: selected.function.name, arguments: argsText || '{}' },
      });
      try {
        const parsed = JSON.parse(raw);
        ok = !parsed?.error;
      } catch {
        /* non-JSON result still counts as ok */
      }
    } catch (e: any) {
      raw = JSON.stringify({ error: e?.message || String(e) });
      ok = false;
    }
    const ms = Math.round(performance.now() - started);
    history = [
      {
        tool: selected.function.name,
        args: argsText,
        result: prettify(raw),
        ok,
        ms,
        at: new Date().toLocaleTimeString(),
      },
      ...history.slice(0, 19),
    ];
    running = false;
  }

  function rerun(record: RunRecord) {
    selectTool(record.tool);
    argsText = record.args;
  }

  function copyText(text: string) {
    const g = (globalThis as any).game;
    if (g?.clipboard?.copyPlainText) {
      g.clipboard.copyPlainText(text);
    } else {
      navigator.clipboard?.writeText(text);
    }
    (globalThis as any).ui?.notifications?.info('Copied to clipboard.');
  }
</script>

<div class="tool-runner">
  {#if !isGM}
    <p class="gm-warning">The Tool Console is GM-only.</p>
  {:else}
    <div class="columns">
      <aside class="tool-list">
        <input type="text" placeholder="Search tools…" bind:value={search} />
        {#each categories as cat}
          {@const visible = cat.tools.filter(matchesSearch)}
          {#if visible.length > 0}
            <div class="category">
              <h4>{cat.label}</h4>
              {#each visible as tool}
                <button
                  class="tool-entry"
                  class:selected={tool.function.name === selectedName}
                  onclick={() => selectTool(tool.function.name)}
                >
                  <span class="tool-name">{tool.function.name}</span>
                  {#if !enabledNames.has(tool.function.name)}
                    <span class="badge-disabled" title="Category disabled in settings — the LLM can't see this tool, but you can still run it here.">off</span>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        {/each}
      </aside>

      <section class="tool-detail">
        {#if selected}
          <h3>{selected.function.name}</h3>
          <p class="description">{selected.function.description}</p>

          {#if paramEntries.length > 0}
            <table class="params">
              <thead>
                <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
              </thead>
              <tbody>
                {#each paramEntries as p}
                  <tr>
                    <td>
                      <button class="param-name" title="Add to arguments" onclick={() => addParam(p.name, p.def)}>
                        {p.name}{p.required ? ' *' : ''}
                      </button>
                    </td>
                    <td class="param-type">{p.type}</td>
                    <td class="param-desc">{p.description}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
            <p class="hint">* required — click a parameter name to insert it into the JSON below.</p>
          {:else}
            <p class="hint">This tool takes no arguments.</p>
          {/if}

          <label class="args-label" for="tool-runner-args">Arguments (JSON)</label>
          <textarea id="tool-runner-args" rows="8" bind:value={argsText} spellcheck="false"></textarea>
          {#if argsError}
            <p class="args-error">{argsError}</p>
          {/if}

          <button class="run-button" onclick={run} disabled={running}>
            {running ? 'Running…' : `Run ${selected.function.name}`}
          </button>
        {:else}
          <p class="hint">Select a tool on the left to inspect and run it.</p>
        {/if}

        {#if history.length > 0}
          <h4 class="history-header">History</h4>
          <div class="history">
            {#each history as record}
              <details class="run-record" class:failed={!record.ok}>
                <summary>
                  <span class="record-status">{record.ok ? '✓' : '✗'}</span>
                  <span class="record-tool">{record.tool}</span>
                  <span class="record-meta">{record.ms}ms · {record.at}</span>
                  <button class="record-rerun" title="Load this call back into the editor" onclick={(e) => { e.preventDefault(); rerun(record); }}>↺</button>
                </summary>
                <div class="record-body">
                  <div class="pre-header">
                    <strong>Args</strong>
                    <button class="copy-btn" title="Copy args to clipboard" onclick={() => copyText(record.args)}>Copy</button>
                  </div>
                  <pre>{record.args}</pre>
                  <div class="pre-header">
                    <strong>Result</strong>
                    <button class="copy-btn" title="Copy result to clipboard" onclick={() => copyText(record.result)}>Copy</button>
                  </div>
                  <pre>{record.result}</pre>
                </div>
              </details>
            {/each}
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .tool-runner {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 8px;
    gap: 8px;
    overflow: hidden;
    /* Foundry windows disable selection by default — re-enable it so results
       and descriptions can be copied into the next tool call. */
    user-select: text;
  }

  .gm-warning {
    margin: auto;
    font-style: italic;
    opacity: 0.8;
  }

  .columns {
    display: flex;
    gap: 10px;
    flex: 1;
    min-height: 0;
  }

  .tool-list {
    width: 230px;
    flex-shrink: 0;
    overflow-y: auto;
    border-right: 1px solid var(--color-border-light-tertiary, #444);
    padding-right: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .tool-list input {
    width: 100%;
    margin-bottom: 4px;
  }

  .category h4 {
    margin: 8px 0 2px;
    font-size: 0.8em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
  }

  .tool-entry {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: none;
    border: none;
    text-align: left;
    padding: 2px 6px;
    cursor: pointer;
    border-radius: 3px;
    font-size: 0.85em;
    line-height: 1.5;
  }

  .tool-entry:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .tool-entry.selected {
    background: rgba(120, 46, 34, 0.45);
  }

  .badge-disabled {
    font-size: 0.7em;
    padding: 0 4px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.12);
    opacity: 0.7;
  }

  .tool-detail {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-right: 4px;
  }

  .tool-detail h3 {
    margin: 0;
    font-family: monospace;
  }

  .description {
    font-size: 0.85em;
    opacity: 0.85;
    margin: 0;
  }

  table.params {
    font-size: 0.8em;
    border-collapse: collapse;
  }

  table.params th,
  table.params td {
    text-align: left;
    padding: 2px 8px 2px 0;
    vertical-align: top;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }

  .param-name {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-family: monospace;
    color: var(--color-text-hyperlink, #6cf);
  }

  .param-type {
    font-family: monospace;
    opacity: 0.7;
    white-space: nowrap;
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .param-desc {
    opacity: 0.85;
  }

  .hint {
    font-size: 0.75em;
    opacity: 0.6;
    margin: 0;
  }

  .args-label {
    font-size: 0.8em;
    font-weight: bold;
    margin-top: 4px;
  }

  textarea {
    font-family: monospace;
    font-size: 0.85em;
    resize: vertical;
    width: 100%;
  }

  .args-error {
    color: #ff6b6b;
    font-size: 0.8em;
    margin: 0;
  }

  .run-button {
    align-self: flex-start;
    padding: 4px 14px;
  }

  .history-header {
    margin: 10px 0 2px;
  }

  .run-record {
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    margin-bottom: 4px;
    font-size: 0.85em;
  }

  .run-record.failed {
    border-color: rgba(255, 90, 90, 0.5);
  }

  .run-record summary {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 8px;
    cursor: pointer;
  }

  .record-status {
    font-weight: bold;
  }

  .run-record.failed .record-status {
    color: #ff6b6b;
  }

  .record-tool {
    font-family: monospace;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .record-meta {
    opacity: 0.6;
    font-size: 0.85em;
    white-space: nowrap;
  }

  .record-rerun {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0 4px;
  }

  .record-body {
    padding: 4px 10px 8px;
  }

  .pre-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
  }

  .copy-btn {
    font-size: 0.75em;
    padding: 0 8px;
    line-height: 1.6;
    width: auto;
  }

  .record-body pre {
    max-height: 260px;
    overflow: auto;
    background: rgba(0, 0, 0, 0.25);
    padding: 6px;
    border-radius: 3px;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
    cursor: text;
  }
</style>
