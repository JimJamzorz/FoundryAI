<script lang="ts">
  import { getSetting, setSetting } from '../../settings';
  import { openRouterService } from '../../core/openrouter-service';

  let { application } = $props<{ application?: any }>();

  let workflowJson = $state(getSetting('comfyWorkflow') || '');
  let error = $state('');
  let saved = $state(false);

  function validate(): boolean {
    try {
      JSON.parse(workflowJson);
      error = '';
      return true;
    } catch (e: any) {
      error = e.message;
      return false;
    }
  }

  async function handleSave() {
    if (!validate()) return;
    await setSetting('comfyWorkflow', workflowJson.trim());
    openRouterService.configure({ comfyWorkflow: workflowJson.trim() });
    saved = true;
    setTimeout(() => { saved = false; }, 2000);
  }

  function handleClear() {
    workflowJson = '';
    error = '';
  }

  function handleInput() {
    saved = false;
    if (error) validate();
  }
</script>

<div class="comfy-editor">
  <div class="comfy-editor-header">
    <p class="comfy-hint">
      Paste your exported ComfyUI workflow JSON below. Node IDs are assigned by ComfyUI and must be kept as-is.
      FoundryAI automatically patches the following node types at generation time — your workflow must include at least one:
    </p>
    <ul class="comfy-nodes">
      <li><strong>PrimitiveStringMultiline</strong> or <strong>CLIPTextEncode</strong> — prompt text</li>
      <li><strong>RandomNoise</strong> or <strong>KSampler</strong> — seed (randomised each run)</li>
      <li><strong>EmptyLatentImage</strong> — output dimensions</li>
      <li><strong>ModelSamplingFlux</strong> — sampling dimensions (Flux workflows only)</li>
    </ul>
  </div>

  <textarea
    class="comfy-textarea"
    class:has-error={!!error}
    bind:value={workflowJson}
    oninput={handleInput}
    spellcheck="false"
    autocomplete="off"
  ></textarea>

  {#if error}
    <p class="comfy-error">JSON error: {error}</p>
  {/if}

  <div class="comfy-actions">
    <button class="comfy-btn secondary" onclick={handleClear}>Clear</button>
    <button class="comfy-btn primary" onclick={handleSave} disabled={!!error}>
      {saved ? 'Saved!' : 'Save Workflow'}
    </button>
  </div>
</div>

<style>
  .comfy-editor {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 12px;
    gap: 10px;
    box-sizing: border-box;
  }

  .comfy-hint {
    margin: 0 0 4px;
    font-size: 12px;
    color: var(--color-text-secondary, #aaa);
  }

  .comfy-nodes {
    margin: 0;
    padding-left: 18px;
    font-size: 11px;
    color: var(--color-text-secondary, #aaa);
  }

  .comfy-nodes li { margin-bottom: 2px; }

  .comfy-textarea {
    flex: 1;
    width: 100%;
    min-height: 0;
    font-family: monospace;
    font-size: 11px;
    resize: none;
    background: var(--color-bg-input, #1a1a1a);
    color: var(--color-text-primary, #eee);
    border: 1px solid var(--color-border, #444);
    border-radius: 4px;
    padding: 8px;
    box-sizing: border-box;
  }

  .comfy-textarea.has-error {
    border-color: #e55;
  }

  .comfy-error {
    margin: 0;
    font-size: 11px;
    color: #e55;
  }

  .comfy-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .comfy-btn {
    padding: 6px 14px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    font-size: 13px;
  }

  .comfy-btn.primary {
    background: var(--color-primary, #7c3aed);
    color: #fff;
  }

  .comfy-btn.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .comfy-btn.secondary {
    background: var(--color-bg-alt, #333);
    color: var(--color-text-primary, #eee);
  }
</style>
