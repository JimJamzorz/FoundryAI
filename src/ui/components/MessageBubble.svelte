<script lang="ts">
  import { micromark } from 'micromark';
  import { gfm, gfmHtml } from 'micromark-extension-gfm';
  import { playTTS } from '@core/tts-service';
  import { getSetting } from '../../settings';

  interface Props {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    isStreaming?: boolean;
    toolName?: string;
  }

  let { role, content, isStreaming = false, toolName }: Props = $props();

  // Check if TTS is enabled (safe fallback if settings not ready)
  function isTTSEnabled(): boolean {
    try { return getSetting('enableTTS') ?? true; } catch { return false; }
  }

  // Render markdown then enrich Foundry @UUID links and TTS buttons
  const renderedContent = $derived.by(() => {
    if (!content) return '';
    if (role === 'tool') {
      try {
        const parsed = JSON.parse(content);
        return `<pre class="tool-result">${JSON.stringify(parsed, null, 2)}</pre>`;
      } catch {
        return `<pre class="tool-result">${escapeHtml(content)}</pre>`;
      }
    }
    // Render markdown
    let html: string;
    try {
      html = micromark(content, {
        extensions: [gfm()],
        htmlExtensions: [gfmHtml()],
      });
    } catch {
      html = escapeHtml(content).replace(/\n/g, '<br>');
    }

    // Convert @UUID[Type.id]{Label} into clickable Foundry links
    html = html.replace(
      /@UUID\[([^\]]+)\]\{([^}]+)\}/g,
      (_match, uuid, label) => {
        return `<a class="content-link" data-uuid="${escapeHtml(uuid)}" data-tooltip="${escapeHtml(label)}"><i class="fas fa-book-open"></i> ${escapeHtml(label)}</a>`;
      }
    );

    // Inject TTS buttons on assistant messages with quotes/blockquotes
    if (role === 'assistant' && !isStreaming && isTTSEnabled()) {
      html = injectTTSButtons(html);
    }

    return html;
  });

  /**
   * Inject TTS play buttons after NPC dialogue quotes and inside blockquotes.
   * Dialogue pattern: <em>"text"</em> (from markdown *"text"*)
   * Read-aloud pattern: <blockquote>text</blockquote> (from markdown > text)
   */
  function injectTTSButtons(html: string): string {
    // NPC dialogue: <em>"text"</em>
    html = html.replace(
      /<em>"([\s\S]*?)"<\/em>/g,
      (match, dialogueText) => {
        const encoded = encodeURIComponent(dialogueText);
        return `${match}<button class="tts-btn" data-tts-text="${encoded}" title="Read aloud"><i class="fas fa-volume-up"></i></button>`;
      }
    );

    // Blockquote read-aloud text
    html = html.replace(
      /(<blockquote>)([\s\S]*?)(<\/blockquote>)/g,
      (_match, open, content, close) => {
        const plainText = content.replace(/<[^>]+>/g, '').trim();
        if (!plainText) return _match;
        const encoded = encodeURIComponent(plainText);
        return `${open}${content}<button class="tts-btn tts-btn-block" data-tts-text="${encoded}" title="Read aloud"><i class="fas fa-volume-up"></i></button>${close}`;
      }
    );

    return html;
  }

  function escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** Handle clicks on @UUID content links and TTS buttons */
  function handleContentClick(event: MouseEvent) {
    // Check for TTS button click
    const ttsBtn = (event.target as HTMLElement).closest('.tts-btn') as HTMLElement | null;
    if (ttsBtn) {
      event.preventDefault();
      event.stopPropagation();
      const text = decodeURIComponent(ttsBtn.dataset.ttsText || '');
      if (text) {
        playTTS(text, ttsBtn).catch((err: any) => {
          console.error('FoundryAI | TTS failed:', err);
          ui.notifications.error(`TTS failed: ${err.message}`);
        });
      }
      return;
    }

    // Check for @UUID content link click
    const target = (event.target as HTMLElement).closest('a.content-link[data-uuid]') as HTMLElement | null;
    if (!target) return;

    event.preventDefault();
    event.stopPropagation();

    const uuid = target.dataset.uuid;
    if (!uuid) return;

    try {
      // Use Foundry's fromUuidSync to find the document and render its sheet
      const doc = fromUuidSync(uuid) as any;
      if (doc?.sheet) {
        doc.sheet.render(true);
      } else {
        ui.notifications.warn(`Could not find document: ${uuid}`);
      }
    } catch (err) {
      console.error('FoundryAI | Failed to open document:', uuid, err);
      ui.notifications.warn(`Could not open document: ${uuid}`);
    }
  }

  const roleLabel = $derived(
    role === 'user' ? 'You'
    : role === 'assistant' ? 'FoundryAI'
    : role === 'tool' ? `🔧 ${toolName || 'Tool'}`
    : 'System'
  );

  const roleIcon = $derived(
    role === 'user' ? 'fa-user'
    : role === 'assistant' ? 'fa-brain'
    : role === 'tool' ? 'fa-wrench'
    : 'fa-cog'
  );
</script>

<div class="message-bubble message-{role}" class:streaming={isStreaming}>
  <div class="message-header">
    <i class="fas {roleIcon}"></i>
    <span class="message-role">{roleLabel}</span>
  </div>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="message-content" onclick={handleContentClick}>
    {#if role === 'tool'}
      <details class="tool-details">
        <summary>Tool Result: {toolName || 'Unknown'}</summary>
        <div class="tool-content">{@html renderedContent}</div>
      </details>
    {:else}
      {@html renderedContent}
    {/if}
    {#if isStreaming}
      <span class="streaming-cursor">▊</span>
    {/if}
  </div>
</div>

<style>
  .message-bubble {
    padding: 8px 12px;
    margin: 4px 0;
    border-radius: 8px;
    max-width: 95%;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  .message-user {
    background: rgba(59, 130, 246, 0.15);
    border-left: 3px solid #3b82f6;
    margin-left: 12px;
    align-self: flex-end;
  }

  .message-assistant {
    background: rgba(139, 92, 246, 0.15);
    border-left: 3px solid #8b5cf6;
    margin-right: 12px;
  }

  .message-system {
    background: rgba(100, 100, 100, 0.1);
    border-left: 3px solid #666;
    font-size: 0.85em;
    opacity: 0.7;
    margin: 2px 0;
  }

  .message-tool {
    background: rgba(245, 158, 11, 0.1);
    border-left: 3px solid #f59e0b;
    font-size: 0.9em;
    margin: 2px 8px;
  }

  .message-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.75em;
    font-weight: 600;
    opacity: 0.7;
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .message-content {
    line-height: 1.5;
    font-size: 0.9em;
    user-select: text;
    -webkit-user-select: text;
  }

  .message-content :global(p) {
    margin: 0.3em 0;
  }

  .message-content :global(pre) {
    background: rgba(0, 0, 0, 0.3);
    padding: 8px;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 0.85em;
    margin: 4px 0;
  }

  .message-content :global(code) {
    background: rgba(0, 0, 0, 0.2);
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 0.9em;
  }

  .message-content :global(blockquote) {
    border-left: 3px solid #7b2d26;
    margin: 4px 0;
    padding: 4px 8px;
    background: rgba(123, 45, 38, 0.1);
    font-style: italic;
  }

  .message-content :global(ul),
  .message-content :global(ol) {
    margin: 4px 0;
    padding-left: 20px;
  }

  .message-content :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 4px 0;
    font-size: 0.9em;
  }

  .message-content :global(th),
  .message-content :global(td) {
    border: 1px solid rgba(255, 255, 255, 0.15);
    padding: 4px 8px;
  }

  .message-content :global(th) {
    background: rgba(255, 255, 255, 0.05);
    font-weight: 600;
  }

  .message-content :global(strong) {
    color: #e0c080;
  }

  .message-content :global(a.content-link) {
    color: #e8c87a;
    cursor: pointer;
    text-decoration: none;
    border-bottom: 1px dotted #e8c87a;
    padding: 0 2px;
    transition: color 0.15s, border-color 0.15s;
  }

  .message-content :global(a.content-link:hover) {
    color: #ffd866;
    border-bottom-color: #ffd866;
  }

  .message-content :global(a.content-link i) {
    font-size: 0.85em;
    margin-right: 2px;
  }

  .tool-details {
    cursor: pointer;
  }

  .tool-details summary {
    font-weight: 600;
    color: #f59e0b;
  }

  .tool-content {
    margin-top: 4px;
  }

  :global(.tool-result) {
    max-height: 200px;
    overflow-y: auto;
    white-space: pre-wrap;
    font-size: 0.8em;
  }

  /* TTS Play Buttons */
  .message-content :global(.tts-btn) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: rgba(139, 92, 246, 0.2);
    border: 1px solid rgba(139, 92, 246, 0.4);
    border-radius: 4px;
    color: #c4b5fd;
    cursor: pointer;
    font-size: 0.75em;
    width: 22px;
    height: 22px;
    padding: 0;
    margin-left: 4px;
    vertical-align: middle;
    transition: background 0.15s, color 0.15s, border-color 0.15s;
    line-height: 1;
  }

  .message-content :global(.tts-btn:hover) {
    background: rgba(139, 92, 246, 0.4);
    color: #e0d4ff;
    border-color: rgba(139, 92, 246, 0.6);
  }

  .message-content :global(.tts-btn-block) {
    display: block;
    margin: 6px 0 0 auto;
    width: auto;
    height: auto;
    padding: 2px 8px;
    font-size: 0.7em;
  }

  .message-content :global(.tts-btn-block::before) {
    content: 'Read aloud ';
  }

  .streaming-cursor {
    display: inline-block;
    animation: blink 0.8s infinite;
    color: #8b5cf6;
    margin-left: 2px;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  .streaming {
    border-color: #8b5cf6;
    box-shadow: 0 0 8px rgba(139, 92, 246, 0.2);
  }
</style>
