<script lang="ts">
  /* Table Talk — a private GM ↔ AI-player conversation. The player answers
     with their full table context (persona, recent chat, journal tools) but
     nothing here is posted to the table. Ask them to journal any takeaways
     so their future turns remember this conversation. */
  import { runPlayerInterviewTurn } from '@core/ai-player-runtime';
  import type { AIPlayerConfig } from '../../settings';
  import type { LLMMessage } from '@core/openrouter-service';

  interface Props {
    player: AIPlayerConfig;
    application?: any;
  }

  let { player, application: _application }: Props = $props();

  interface Bubble {
    role: 'user' | 'assistant';
    content: string;
  }

  let bubbles = $state<Bubble[]>([]);
  let input = $state('');
  let thinking = $state(false);
  let scrollEl = $state<HTMLDivElement | null>(null);

  const displayName = player.actorName || player.name;

  function toLLMMessages(): LLMMessage[] {
    return bubbles.map(b => ({ role: b.role, content: b.content }));
  }

  async function send() {
    const text = input.trim();
    if (!text || thinking) return;
    input = '';
    bubbles = [...bubbles, { role: 'user', content: text }];
    thinking = true;
    scrollDown();

    try {
      const reply = await runPlayerInterviewTurn(player, toLLMMessages());
      bubbles = [...bubbles, { role: 'assistant', content: reply }];
    } catch (e: any) {
      bubbles = [...bubbles, { role: 'assistant', content: `(error: ${e?.message || e})` }];
    } finally {
      thinking = false;
      scrollDown();
    }
  }

  function scrollDown() {
    setTimeout(() => scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' }), 30);
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
</script>

<div class="interview">
  <p class="interview-hint">
    Private side chat with <strong>{displayName}</strong> — nothing here reaches the table. They can see the
    recent table chat and use their journal. Ask them to <em>write down</em> anything they should remember.
  </p>

  <div class="bubbles" bind:this={scrollEl}>
    {#if bubbles.length === 0}
      <p class="empty">Ask them anything — "why did you open that door?" is a classic.</p>
    {/if}
    {#each bubbles as b}
      <div class="bubble {b.role}">
        <span class="who">{b.role === 'user' ? 'GM' : displayName}</span>
        <div class="text">{b.content}</div>
      </div>
    {/each}
    {#if thinking}
      <div class="bubble assistant">
        <span class="who">{displayName}</span>
        <div class="text thinking"><i class="fas fa-ellipsis-h fa-fade"></i> thinking…</div>
      </div>
    {/if}
  </div>

  <div class="composer">
    <textarea
      rows="2"
      bind:value={input}
      onkeydown={onKeydown}
      placeholder={`Say something to ${displayName}…`}
      disabled={thinking}
    ></textarea>
    <button onclick={send} disabled={thinking || !input.trim()} title="Send">
      <i class="fas fa-paper-plane"></i>
    </button>
  </div>
</div>

<style>
  .interview {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 8px;
    gap: 8px;
    user-select: text;
  }

  .interview-hint {
    font-size: 0.78em;
    opacity: 0.75;
    margin: 0;
  }

  .bubbles {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-right: 4px;
  }

  .empty {
    opacity: 0.5;
    font-style: italic;
    text-align: center;
    margin-top: 30%;
  }

  .bubble {
    max-width: 88%;
    border-radius: 8px;
    padding: 6px 10px;
    background: rgba(255, 255, 255, 0.06);
  }

  .bubble.user {
    align-self: flex-end;
    background: rgba(120, 46, 34, 0.35);
  }

  .bubble.assistant {
    align-self: flex-start;
  }

  .who {
    display: block;
    font-size: 0.7em;
    font-weight: bold;
    opacity: 0.6;
    margin-bottom: 2px;
  }

  .text {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 0.9em;
  }

  .text.thinking {
    opacity: 0.6;
  }

  .composer {
    display: flex;
    gap: 6px;
    align-items: flex-end;
  }

  .composer textarea {
    flex: 1;
    resize: none;
    font-size: 0.9em;
  }

  .composer button {
    width: auto;
    padding: 6px 12px;
  }
</style>
