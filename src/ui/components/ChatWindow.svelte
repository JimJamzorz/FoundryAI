<script lang="ts">
  import MessageBubble from './MessageBubble.svelte';
  import SessionList from './SessionList.svelte';
  import { openRouterService, type LLMMessage, type StreamCallback, type ModelInfo } from '@core/openrouter-service';
  import { chatSessionManager } from '@core/chat-session-manager';
  import { sessionRecapManager, type RecapProgress } from '@core/session-recap-manager';
  import { embeddingService } from '@core/embedding-service';
  import { getEnabledTools, executeTool } from '@core/tool-system';
  import { buildSystemPrompt, buildActorRoleplayPrompt, type ActorRoleplayContext } from '@core/system-prompt';
  import { estimateTokens, getModelContextLimit } from '@core/token-estimator';
  import { summarizeConversation } from '@core/context-summarizer';
  import { getSetting } from '../../settings';
  import { openSettingsDialog } from '../svelte-application';
  import SettingsPanel from './SettingsPanel.svelte';
  import ContextIndicator from './ContextIndicator.svelte';

  interface Props {
    isSidebar?: boolean;
    application?: any;
  }

  let { isSidebar = false, application }: Props = $props();

  // ---- State ----
  type ViewMode = 'chat' | 'sessions' | 'recap';

  let viewMode = $state<ViewMode>('chat');
  let messages = $state<LLMMessage[]>([]);
  let inputText = $state('');
  let isGenerating = $state(false);
  let streamingContent = $state('');
  let abortController: AbortController | null = $state(null);
  let currentSessionId = $state<string | null>(null);
  let currentSessionName = $state('New Chat');
  let messagesEndEl: HTMLDivElement | undefined = $state();
  let inputEl: HTMLTextAreaElement | undefined = $state();
  let recapProgress = $state<RecapProgress | null>(null);
  let isIndexing = $state(false);
  let indexProgress = $state('');

  // Actor roleplay state
  let currentActorId = $state<string | null>(null);
  let currentActorName = $state<string | null>(null);
  let showActorPicker = $state(false);

  // Context tracking state
  let lastPromptTokens = $state<number | null>(null);
  let modelContextLength = $state<number>(200_000);
  let isSummarizing = $state(false);
  let showSummarizeBanner = $state(false);
  let summarizeBannerDismissed = $state(false);

  // ---- Derived ----

  // Group messages: merge consecutive tool-call assistant + tool results into compact groups
  type CompactMessage =
    | { type: 'message'; msg: LLMMessage; index: number }
    | { type: 'tool-group'; toolCalls: Array<{ name: string; args: string }>; results: Array<{ name: string; content: string }> };

  const compactMessages = $derived.by((): CompactMessage[] => {
    const filtered = messages.filter(m => m.role !== 'system');
    const result: CompactMessage[] = [];
    let i = 0;

    while (i < filtered.length) {
      const msg = filtered[i];

      // If this is an assistant message with tool_calls, group it with following tool results
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        const toolCalls = msg.tool_calls.map((tc: any) => ({
          name: tc.function?.name || 'unknown',
          args: tc.function?.arguments || '{}',
        }));
        const results: Array<{ name: string; content: string }> = [];

        // Consume all following tool result messages
        let j = i + 1;
        while (j < filtered.length && filtered[j].role === 'tool') {
          results.push({
            name: filtered[j].name || 'unknown',
            content: typeof filtered[j].content === 'string' ? filtered[j].content : '',
          });
          j++;
        }

        result.push({ type: 'tool-group', toolCalls, results });
        i = j;
        continue;
      }

      // Skip standalone tool messages (shouldn't happen but safety)
      if (msg.role === 'tool') {
        i++;
        continue;
      }

      // Track original index for edit/retry
      const originalIndex = messages.indexOf(msg);
      result.push({ type: 'message', msg, index: originalIndex });
      i++;
    }

    return result;
  });

  const hasApiKey = $derived.by(() => {
    try {
      return !!getSetting('apiKey');
    } catch {
      return false;
    }
  });

  // Context usage: use actual API-reported tokens when available, else estimate
  const contextUsed = $derived.by(() => {
    if (lastPromptTokens !== null) return lastPromptTokens;
    return estimateTokens(messages);
  });

  const contextIsEstimate = $derived(lastPromptTokens === null);

  // Auto-prompt for summarization when threshold is exceeded
  $effect(() => {
    if (summarizeBannerDismissed || isSummarizing || isGenerating) return;
    try {
      const threshold = getSetting('contextSummarizeThreshold');
      if (threshold <= 0 || modelContextLength <= 0) return;
      const pct = (contextUsed / modelContextLength) * 100;
      if (pct >= threshold && messages.length > 10) {
        showSummarizeBanner = true;
      }
    } catch { /* settings not ready */ }
  });

  // ---- Lifecycle ----
  $effect(() => {
    // Reference reactive state so this effect re-runs when they change
    void messages.length;
    void streamingContent;

    // Auto-scroll to bottom after DOM update
    if (messagesEndEl) {
      // Use tick to wait for DOM to render, then scroll
      requestAnimationFrame(() => {
        messagesEndEl?.scrollIntoView({ behavior: 'smooth' });
      });
    }
  });

  // Fetch model context length on mount and when model changes
  $effect(() => {
    try {
      const model = getSetting('chatModel');
      // Try fallback map first (instant)
      const fallback = getModelContextLimit(model);
      if (fallback) modelContextLength = fallback;

      // Then try fetching from API for exact value
      openRouterService.listChatModels().then((models: ModelInfo[]) => {
        const match = models.find((m: ModelInfo) => m.id === model);
        if (match?.context_length) {
          modelContextLength = match.context_length;
        }
      }).catch(() => { /* use fallback */ });
    } catch { /* settings not ready */ }
  });

  // ---- Session Management ----
  let editingIndex = $state<number | null>(null);
  let editText = $state('');

  async function startNewSession() {
    const session = await chatSessionManager.createSession();
    currentSessionId = session.id;
    currentSessionName = session.name;
    currentActorId = null;
    currentActorName = null;
    messages = [];
    streamingContent = '';
    lastPromptTokens = null;
    showSummarizeBanner = false;
    summarizeBannerDismissed = false;
    viewMode = 'chat';
    inputEl?.focus();
  }

  async function startActorRoleplaySession(actorId: string, actorName: string) {
    const session = await chatSessionManager.createSession(undefined, actorId, actorName);
    currentSessionId = session.id;
    currentSessionName = session.name;
    currentActorId = actorId;
    currentActorName = actorName;
    messages = [];
    streamingContent = '';
    viewMode = 'chat';
    showActorPicker = false;

    // Auto-generate character introduction
    await generateCharacterIntro(actorId, actorName);
    inputEl?.focus();
  }

  /**
   * Generate an automatic character introduction when starting a roleplay session.
   * Sends a hidden instruction to the AI; only the assistant's response is shown.
   */
  async function generateCharacterIntro(actorId: string, actorName: string) {
    if (!hasApiKey) return;

    isGenerating = true;
    streamingContent = '';

    try {
      const systemPrompt = buildActorRoleplayPrompt({ actorId, actorName });
      const introPrompt: LLMMessage = {
        role: 'user',
        content: `You are now entering a roleplay session as ${actorName}. Introduce yourself in character. Include:

1. **Who you are** — your name, role, and a brief description of yourself
2. **Your current goals** — what you're trying to accomplish, what motivates you
3. **Common knowledge** — things most people would know about you or could learn by talking to you
4. **Dialogue hooks** — topics players might bring up and how you'd respond (e.g. "If asked about the war...", "If asked about the artifact...")
5. **Persuasion & social checks** — list 3-5 things players might try to convince you of, and for each one state the type of check (Persuasion, Intimidation, Deception, etc.) and the DC (difficulty class) required. Format as a table.

Stay fully in character for the introduction, but present the dialogue hooks and check DCs in a helpful OOC (out-of-character) section at the end marked with --- so the DM can reference it.

IMPORTANT: You already have all the information you need about this character from the system prompt. Do NOT output any tool calls, function calls, or special syntax like [TOOL_CALL]. Simply write your introduction using the character information provided.`,
      };

      const apiMessages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        introPrompt,
      ];

      const model = getSetting('chatModel');
      const temperature = getSetting('temperature');
      const maxTokens = getSetting('maxTokens');
      const stream = getSetting('streamResponses');

      console.log(`FoundryAI | Generating character intro for ${actorName}`);

      if (stream) {
        let fullContent = '';
        const onChunk: StreamCallback = (chunk) => {
          if (chunk.content) {
            fullContent += chunk.content;
            streamingContent = fullContent;
          }
        };

        await openRouterService.chatCompletionStream(
          { model, messages: apiMessages, temperature, max_tokens: maxTokens },
          onChunk,
        );

        if (fullContent) {
          const assistantMsg: LLMMessage = { role: 'assistant', content: fullContent };
          messages = [assistantMsg];
        }
      } else {
        const response = await openRouterService.chatCompletion({
          model,
          messages: apiMessages,
          temperature,
          max_tokens: maxTokens,
        });

        const content = response.choices?.[0]?.message?.content;
        if (content) {
          const assistantMsg: LLMMessage = { role: 'assistant', content };
          messages = [assistantMsg];
        }
      }

      // Save to session
      if (currentSessionId && messages.length > 0) {
        await chatSessionManager.saveFullConversation(currentSessionId, messages, model);
        console.log(`FoundryAI | Saved character intro to session ${currentSessionId}`);
      }
    } catch (error: any) {
      console.error('FoundryAI | Character intro generation failed:', error);
      const fallback: LLMMessage = {
        role: 'assistant',
        content: `*${actorName} stands before you, ready to speak.*\n\n(Character introduction could not be generated: ${error.message})`,
      };
      messages = [fallback];
    } finally {
      isGenerating = false;
      streamingContent = '';
    }
  }

  function loadSession(sessionId: string) {
    const session = chatSessionManager.loadSession(sessionId);
    if (!session) {
      ui.notifications.error('Session not found.');
      return;
    }
    currentSessionId = session.id;
    currentSessionName = session.name;
    currentActorId = session.actorId || null;
    currentActorName = session.actorName || null;
    messages = session.messages;
    streamingContent = '';
    lastPromptTokens = null;
    showSummarizeBanner = false;
    summarizeBannerDismissed = false;
    viewMode = 'chat';
  }

  // ---- Chat Control ----
  function stopGeneration() {
    if (abortController) {
      abortController.abort();
      abortController = null;
      isGenerating = false;
      streamingContent = '';
      console.log('FoundryAI | Chat generation stopped by user');
    }
  }

  // ---- Message Sending ----
  async function sendMessage() {
    const text = inputText.trim();
    if (!text || isGenerating) return;

    if (!hasApiKey) {
      ui.notifications.warn('Please configure your OpenRouter API key in FoundryAI settings.');
      return;
    }

    // Create session if needed
    if (!currentSessionId) {
      await startNewSession();
    }

    inputText = '';
    isGenerating = true;
    streamingContent = '';
    abortController = new AbortController();

    // Add user message
    const userMessage: LLMMessage = { role: 'user', content: text };
    messages = [...messages, userMessage];

    try {
      // Build context
      const systemPrompt = currentActorId
        ? buildActorRoleplayPrompt({ actorId: currentActorId, actorName: currentActorName || 'Unknown' })
        : buildSystemPrompt();

      // RAG context — only injected when enabled in settings
      const ragContext = getSetting('enableRAG') ? await getRelevantContext(text) : null;

      // Build message array for API — condense old tool results to save tokens
      const apiMessages: LLMMessage[] = [
        { role: 'system', content: systemPrompt + (ragContext ? `\n\n# Relevant Context\n${ragContext}` : '') },
        ...condenseOldToolResults(messages),
      ];

      const model = getSetting('chatModel');
      const temperature = getSetting('temperature');
      const maxTokens = getSetting('maxTokens');
      const stream = getSetting('streamResponses');
      const useTools = getSetting('enableTools');

      console.log(`FoundryAI | Sending message — model: ${model}, stream: ${stream}, tools: ${useTools}, messages: ${apiMessages.length}, actor: ${currentActorId || 'none'}`);

      if (stream) {
        await handleStreamingResponse(apiMessages, model, temperature, maxTokens, useTools, abortController.signal);
      } else {
        await handleNonStreamingResponse(apiMessages, model, temperature, maxTokens, useTools, abortController.signal);
      }

      // Save full conversation to session
      if (currentSessionId) {
        await chatSessionManager.saveFullConversation(
          currentSessionId,
          messages,
          model,
        );
        console.log(`FoundryAI | Saved conversation to session ${currentSessionId} (${messages.length} messages)`);
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('FoundryAI | Chat generation was stopped');
      } else {
        console.error('FoundryAI | Chat error:', error);
        const errorMsg: LLMMessage = {
          role: 'assistant',
          content: `⚠️ Error: ${error.message || 'Unknown error occurred'}`,
        };
        messages = [...messages, errorMsg];
      }
    } finally {
      isGenerating = false;
      streamingContent = '';
      abortController = null;
    }
  }

  // ---- Edit & Retry ----
  function startEditMessage(index: number) {
    const msg = messages[index];
    if (!msg || msg.role !== 'user') return;
    editingIndex = index;
    editText = typeof msg.content === 'string' ? msg.content : '';
  }

  function cancelEdit() {
    editingIndex = null;
    editText = '';
  }

  async function submitEdit() {
    if (editingIndex === null || !editText.trim()) return;

    // Truncate messages up to (but not including) the edited message
    messages = messages.slice(0, editingIndex);
    editingIndex = null;

    // Re-send with edited text
    inputText = editText;
    editText = '';
    await sendMessage();
  }

  async function retryFromMessage(index: number) {
    // Find the user message at or before this index
    let userIndex = index;
    while (userIndex >= 0 && messages[userIndex].role !== 'user') {
      userIndex--;
    }
    if (userIndex < 0) return;

    const userText = typeof messages[userIndex].content === 'string' ? messages[userIndex].content : '';
    if (!userText) return;

    // Truncate everything from this user message onward and resend
    messages = messages.slice(0, userIndex);
    inputText = userText;
    await sendMessage();
  }

  /**
   * Regenerate an assistant response. 
   * If index is provided, removes everything from that message onward.
   * If no prior user message exists (e.g. actor intro), regenerates the intro.
   */
  async function regenerateAssistantMessage(index: number) {
    // Find if there's a user message before this assistant message
    let userIndex = -1;
    for (let i = index - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userIndex = i;
        break;
      }
    }

    if (userIndex === -1) {
      // No user message found — this is likely an actor intro
      // Regenerate actor intro if we have an active actor roleplay
      if (currentActorId && currentActorName) {
        messages = [];
        await generateCharacterIntro(currentActorId, currentActorName);
        return;
      }
      // No actor context either — just clear and start fresh
      messages = [];
      return;
    }

    // There was a user message — truncate to that message and resend
    const userText = typeof messages[userIndex].content === 'string' ? messages[userIndex].content : '';
    messages = messages.slice(0, userIndex);
    inputText = userText;
    await sendMessage();
  }

  async function handleStreamingResponse(
    apiMessages: LLMMessage[],
    model: string,
    temperature: number,
    maxTokens: number,
    useTools: boolean,
    signal?: AbortSignal,
  ) {
    let fullContent = '';
    let streamUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

    // Accumulated tool calls — streaming sends deltas by index
    const accumulatedToolCalls: Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }> = new Map();

    const onChunk: StreamCallback = (chunk) => {
      if (chunk.error) {
        console.error('FoundryAI | Stream chunk error:', chunk.error);
      }
      if (chunk.content) {
        fullContent += chunk.content;
        streamingContent = fullContent;
      }
      if (chunk.usage) {
        streamUsage = chunk.usage;
      }
      if (chunk.toolCalls) {
        // Accumulate tool call deltas by index
        for (const delta of chunk.toolCalls) {
          const idx = (delta as any).index ?? 0;
          const existing = accumulatedToolCalls.get(idx);

          if (existing) {
            // Append arguments
            if (delta.function?.arguments) {
              existing.function.arguments += delta.function.arguments;
            }
            // Update name/id if provided (shouldn't change, but be safe)
            if (delta.id) existing.id = delta.id;
            if (delta.function?.name) existing.function.name = delta.function.name;
          } else {
            // First chunk for this index — initialize
            accumulatedToolCalls.set(idx, {
              id: delta.id || `pending-${idx}`,
              type: 'function',
              function: {
                name: delta.function?.name || '',
                arguments: delta.function?.arguments || '',
              },
            });
          }
        }
        console.debug('FoundryAI | Streaming tool call delta, accumulated:', [...accumulatedToolCalls.values()].map(tc => tc.function.name));
      }
    };

    await openRouterService.chatCompletionStream(
      {
        model,
        messages: apiMessages,
        temperature,
        max_tokens: maxTokens,
        tools: useTools ? getEnabledTools() : undefined,
        tool_choice: useTools ? 'auto' : undefined,
      },
      onChunk,
      signal,
    );

    if (accumulatedToolCalls.size > 0) {
      const toolCalls = [...accumulatedToolCalls.values()];
      // Validate all tool calls have names
      const valid = toolCalls.filter(tc => tc.function.name);
      const invalid = toolCalls.filter(tc => !tc.function.name);
      if (invalid.length > 0) {
        console.warn('FoundryAI | Dropping tool calls with missing function name:', invalid);
      }
      if (valid.length > 0) {
        console.log('FoundryAI | Executing streamed tool calls:', valid.map(tc => `${tc.function.name}(${tc.function.arguments.slice(0, 100)}...)`));
        const assistantMessage = { content: fullContent || null, tool_calls: valid };
        await handleToolCalls(assistantMessage, apiMessages, model, temperature, maxTokens, 0, signal);
      } else {
        console.warn('FoundryAI | All streamed tool calls had missing names, treating as text response');
        const msg: LLMMessage = { role: 'assistant', content: fullContent || '⚠️ Tool call failed — the model returned an invalid response.' };
        messages = [...messages, msg];
      }
    } else {
      // Normal text response
      const msg: LLMMessage = { role: 'assistant', content: fullContent };
      messages = [...messages, msg];
    }

    // Update token tracking from streaming usage
    if (streamUsage) {
      lastPromptTokens = streamUsage.prompt_tokens;
    }
  }

  async function handleNonStreamingResponse(
    apiMessages: LLMMessage[],
    model: string,
    temperature: number,
    maxTokens: number,
    useTools: boolean,
    signal?: AbortSignal,
  ) {
    const response = await openRouterService.chatCompletion(
      {
        model,
        messages: apiMessages,
        temperature,
        max_tokens: maxTokens,
        tools: useTools ? getEnabledTools() : undefined,
        tool_choice: useTools ? 'auto' : undefined,
      },
      signal,
    );

    const assistantMessage = response.choices?.[0]?.message;
    console.log('FoundryAI | Non-streaming response:', {
      hasContent: !!assistantMessage?.content,
      toolCalls: assistantMessage?.tool_calls?.map((tc: any) => tc.function?.name) || [],
      finishReason: response.choices?.[0]?.finish_reason,
      usage: response.usage,
    });

    if (assistantMessage?.tool_calls?.length) {
      await handleToolCalls(assistantMessage, apiMessages, model, temperature, maxTokens, 0, signal);
    } else {
      const msg: LLMMessage = { role: 'assistant', content: assistantMessage?.content || '' };
      messages = [...messages, msg];
    }

    // Update token tracking from response usage
    if (response.usage) {
      lastPromptTokens = response.usage.prompt_tokens;
    }
  }

  async function handleToolCalls(
    assistantMessage: any,
    apiMessages: LLMMessage[],
    model: string,
    temperature: number,
    maxTokens: number,
    depth: number = 0,
    signal?: AbortSignal,
  ) {
    // Check if abort was requested
    if (signal?.aborted) {
      console.log('FoundryAI | Tool execution stopped by user');
      return;
    }

    const maxDepth = getSetting('maxToolDepth');
    console.log(`FoundryAI | handleToolCalls depth=${depth}/${maxDepth}, tools: [${assistantMessage.tool_calls?.map((tc: any) => tc.function?.name || 'UNNAMED').join(', ')}]`);

    if (maxDepth > 0 && depth >= maxDepth) {
      console.warn(`FoundryAI | Tool call depth limit reached (${depth}/${maxDepth})`);
      messages = [...messages, { role: 'assistant', content: '⚠️ Tool call depth limit reached.' }];
      return;
    }

    // Add assistant message with tool_calls to the conversation
    const assistantMsg: LLMMessage = {
      role: 'assistant',
      content: assistantMessage.content || null,
      tool_calls: assistantMessage.tool_calls,
    };
    messages = [...messages, assistantMsg];

    // Execute all tool calls in parallel
    const toolResults: LLMMessage[] = await Promise.all(
      assistantMessage.tool_calls.map(async (toolCall: any) => {
        // Check abort before each tool execution
        if (signal?.aborted) {
          return {
            role: 'tool' as const,
            content: JSON.stringify({ error: 'Execution stopped by user' }),
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
          };
        }
        console.log(`FoundryAI | Executing tool: ${toolCall.function?.name || 'UNDEFINED'} (id: ${toolCall.id || 'NO_ID'})`, toolCall.function?.arguments?.slice(0, 200));
        const result = await executeTool(toolCall);
        console.log(`FoundryAI | Tool result [${toolCall.function?.name}]:`, result.slice(0, 300));
        return {
          role: 'tool' as const,
          content: result,
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
        };
      })
    );

    messages = [...messages, ...toolResults];

    // Check again before continuing
    if (signal?.aborted) {
      console.log('FoundryAI | Tool execution stopped by user (after execution)');
      return;
    }

    // Continue the conversation with tool results
    const continuedMessages = [...apiMessages, assistantMsg, ...toolResults];

    const response = await openRouterService.chatCompletion(
      {
        model,
        messages: continuedMessages,
        temperature,
        max_tokens: maxTokens,
        tools: getEnabledTools(),
        tool_choice: 'auto',
      },
      signal,
    );

    // Check abort after API call returns
    if (signal?.aborted) {
      console.log('FoundryAI | Tool chain stopped by user (after API response)');
      return;
    }

    const nextMessage = response.choices?.[0]?.message;

    if (nextMessage?.tool_calls?.length) {
      // Recursive tool calls
      await handleToolCalls(nextMessage, continuedMessages, model, temperature, maxTokens, depth + 1, signal);
    } else {
      messages = [...messages, { role: 'assistant', content: nextMessage?.content || '' }];
    }
  }

  // ---- RAG Context ----
  async function getRelevantContext(query: string): Promise<string | null> {
    try {
      const stats = await embeddingService.getStats();
      if (!stats || stats.totalVectors === 0) return null;

      const results = await embeddingService.search(query, 5);
      if (results.length === 0) return null;

      return embeddingService.buildContext(results);
    } catch {
      return null;
    }
  }

  // ---- Token Optimization ----
  /**
   * Condense old tool results in conversation history to reduce token usage.
   * Tool results from earlier turns (before the last assistant response) are truncated
   * since the assistant already synthesized them into its response.
   * The most recent tool call cycle is always kept in full.
   */
  function condenseOldToolResults(msgs: LLMMessage[]): LLMMessage[] {
    // Find the index of the last assistant message that has actual content (not just tool_calls)
    let lastAssistantContentIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'assistant' && m.content && !m.tool_calls) {
        lastAssistantContentIdx = i;
        break;
      }
    }

    // If there's no completed assistant response yet, keep everything
    if (lastAssistantContentIdx === -1) return msgs;

    // Find the start of the most recent tool call cycle
    // (the assistant message with tool_calls that led to the last response)
    let recentCycleStart = lastAssistantContentIdx;
    for (let i = lastAssistantContentIdx - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'tool' || (m.role === 'assistant' && m.tool_calls)) {
        recentCycleStart = i;
      } else {
        break;
      }
    }

    const MAX_OLD_TOOL_CONTENT = 200; // chars to keep from old tool results

    return msgs.map((msg, idx) => {
      // Keep everything in the most recent cycle and after in full
      if (idx >= recentCycleStart) return msg;

      // Condense old tool results
      if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > MAX_OLD_TOOL_CONTENT) {
        try {
          const parsed = JSON.parse(msg.content);
          // Build a compact summary preserving document names and IDs for reference
          if (parsed.results && Array.isArray(parsed.results)) {
            const summary = {
              _condensed: true,
              note: 'Full content was provided earlier and used in the response above.',
              results: parsed.results.map((r: any) => ({
                documentId: r.documentId || r.id,
                documentName: r.documentName || r.name,
                uuidRef: r.uuidRef,
                folder: r.folder,
              })),
            };
            return { ...msg, content: JSON.stringify(summary) };
          }
          // For other tool results, just truncate
          return { ...msg, content: msg.content.slice(0, MAX_OLD_TOOL_CONTENT) + '... [condensed]' };
        } catch {
          return { ...msg, content: msg.content.slice(0, MAX_OLD_TOOL_CONTENT) + '... [condensed]' };
        }
      }

      return msg;
    });
  }

  // ---- Reindexing ----
  async function handleReindex() {
    if (isIndexing) return;
    isIndexing = true;
    indexProgress = 'Starting...';

    try {
      const journalFolders = getSetting('journalFolders') || [];
      const actorFolders = getSetting('actorFolders') || [];

      await embeddingService.reindexAll(
        journalFolders,
        actorFolders,
        (progress) => {
          indexProgress = progress.message || progress.phase;
        },
      );

      ui.notifications.info('FoundryAI: Indexing complete!');
    } catch (error: any) {
      ui.notifications.error(`Indexing failed: ${error.message}`);
    } finally {
      isIndexing = false;
      indexProgress = '';
    }
  }

  // ---- Session Recap ----
  async function handleGenerateRecap() {
    const sessions = chatSessionManager.listSessions();
    if (sessions.length === 0) {
      ui.notifications.warn('No chat sessions to recap.');
      return;
    }

    // Use today's sessions
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todaySessions = sessions.filter(s => s.updatedAt >= today.getTime());

    const sessionIds = todaySessions.length > 0
      ? todaySessions.map(s => s.id)
      : [sessions[0].id]; // Fallback to most recent

    recapProgress = { phase: 'preparing', message: 'Starting...' };

    try {
      const model = getSetting('chatModel');
      await sessionRecapManager.generateRecap(
        sessionIds,
        model,
        (progress) => { recapProgress = progress; },
      );
      ui.notifications.info('Session recap saved!');
    } catch (error: any) {
      ui.notifications.error(`Recap failed: ${error.message}`);
    } finally {
      recapProgress = null;
    }
  }

  // ---- Context Summarization ----
  async function handleSummarize() {
    if (isSummarizing || messages.length <= 10) return;

    isSummarizing = true;
    showSummarizeBanner = false;

    try {
      const model = getSetting('chatModel');
      const keepCount = getSetting('summarizeKeepMessages');

      const result = await summarizeConversation(messages, model, keepCount);
      if (!result) {
        ui.notifications.warn('Not enough messages to summarize.');
        return;
      }

      messages = result.messages;
      lastPromptTokens = null; // Reset to re-estimate since context changed
      summarizeBannerDismissed = false;

      // Save updated conversation
      if (currentSessionId) {
        await chatSessionManager.saveFullConversation(currentSessionId, messages, model);
      }

      ui.notifications.info(`Context summarized — saved ~${result.tokensSaved.toLocaleString()} tokens.`);
    } catch (error: any) {
      console.error('FoundryAI | Summarization failed:', error);
      ui.notifications.error(`Summarization failed: ${error.message}`);
    } finally {
      isSummarizing = false;
    }
  }

  // ---- Input Handling ----
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function openSettings() {
    openSettingsDialog(SettingsPanel);
  }

  /** Get available actors for the roleplay picker */
  function getAvailableActors(): Array<{ id: string; name: string; type: string; img: string }> {
    if (!game.actors) return [];
    const actors: Array<{ id: string; name: string; type: string; img: string }> = [];
    for (const actor of game.actors.values()) {
      actors.push({
        id: actor.id,
        name: actor.name,
        type: actor.type,
        img: (actor as any).img || 'icons/svg/mystery-man.svg',
      });
    }
    return actors.sort((a, b) => a.name.localeCompare(b.name));
  }

  let actorPickerSearch = $state('');

  const filteredActors = $derived.by(() => {
    const all = getAvailableActors();
    if (!actorPickerSearch.trim()) return all;
    const q = actorPickerSearch.toLowerCase();
    return all.filter(a => a.name.toLowerCase().includes(q));
  });

  const isActorRoleplay = $derived(!!currentActorId);
</script>

<div class="chat-window" class:sidebar={isSidebar}>
  <!-- Toolbar -->
  <div class="toolbar">
    <div class="toolbar-left">
      <button
        class="toolbar-btn"
        class:active={viewMode === 'chat'}
        onclick={() => { viewMode = 'chat'; }}
        title="Chat"
      >
        <i class="fas fa-comments"></i>
      </button>
      <button
        class="toolbar-btn"
        class:active={viewMode === 'sessions'}
        onclick={() => { viewMode = 'sessions'; }}
        title="Sessions"
      >
        <i class="fas fa-list"></i>
      </button>
    </div>

    <span class="toolbar-title" title={currentSessionName}>
      {#if isActorRoleplay}
        <i class="fas fa-theater-masks" style="color: #f59e0b; margin-right: 4px;"></i>
      {/if}
      {currentSessionName}
    </span>

    <div class="toolbar-right">
      <ContextIndicator used={contextUsed} total={modelContextLength} isEstimate={contextIsEstimate} />
      <button
        class="toolbar-btn"
        onclick={handleSummarize}
        disabled={isSummarizing || messages.length <= 10}
        title="Summarize older messages to free context"
      >
        <i class="fas fa-compress-arrows-alt"></i>
      </button>
      <button
        class="toolbar-btn"
        class:active={showActorPicker}
        onclick={() => { showActorPicker = !showActorPicker; actorPickerSearch = ''; }}
        title="Roleplay as Actor"
      >
        <i class="fas fa-theater-masks"></i>
      </button>
      <button
        class="toolbar-btn"
        onclick={handleReindex}
        disabled={isIndexing}
        title={isIndexing ? indexProgress : 'Reindex RAG'}
      >
        <i class="fas fa-sync-alt" class:fa-spin={isIndexing}></i>
      </button>
      <button
        class="toolbar-btn"
        onclick={handleGenerateRecap}
        disabled={!!recapProgress}
        title="Generate Session Recap"
      >
        <i class="fas fa-scroll"></i>
      </button>
      <button class="toolbar-btn" onclick={openSettings} title="Settings">
        <i class="fas fa-cog"></i>
      </button>
    </div>
  </div>

  <!-- Recap Progress Banner -->
  {#if recapProgress}
    <div class="progress-banner">
      <i class="fas fa-spinner fa-spin"></i>
      {recapProgress.message}
    </div>
  {/if}

  <!-- Index Progress Banner -->
  {#if isIndexing}
    <div class="progress-banner index-banner">
      <i class="fas fa-database"></i>
      {indexProgress}
    </div>
  {/if}

  <!-- Summarize Banner (auto-prompt at threshold) -->
  {#if showSummarizeBanner && !isSummarizing}
    <div class="progress-banner summarize-banner">
      <i class="fas fa-exclamation-triangle"></i>
      <span>Context is {((contextUsed / modelContextLength) * 100).toFixed(0)}% full. Summarize older messages?</span>
      <button class="banner-btn" onclick={handleSummarize}>Summarize</button>
      <button class="banner-btn dismiss" onclick={() => { showSummarizeBanner = false; summarizeBannerDismissed = true; }}>Dismiss</button>
    </div>
  {/if}

  <!-- Summarizing Progress Banner -->
  {#if isSummarizing}
    <div class="progress-banner summarize-banner">
      <i class="fas fa-spinner fa-spin"></i>
      Summarizing conversation...
    </div>
  {/if}

  <!-- Actor Picker Panel -->
  {#if showActorPicker}
    <div class="actor-picker">
      <div class="actor-picker-header">
        <h3>Roleplay as Actor</h3>
        <input
          type="text"
          class="actor-search"
          placeholder="Search actors..."
          bind:value={actorPickerSearch}
        />
      </div>
      <div class="actor-picker-list">
        {#each filteredActors as actor (actor.id)}
          <button
            class="actor-pick-btn"
            onclick={() => startActorRoleplaySession(actor.id, actor.name)}
          >
            <img src={actor.img} alt="" class="actor-pick-img" />
            <div class="actor-pick-info">
              <span class="actor-pick-name">{actor.name}</span>
              <span class="actor-pick-type">{actor.type}</span>
            </div>
          </button>
        {:else}
          <div class="actor-pick-empty">No actors found</div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Content Area -->
  {#if viewMode === 'sessions'}
    <SessionList
      onSelectSession={loadSession}
      onNewSession={startNewSession}
      activeSessionId={currentSessionId ?? undefined}
    />
  {:else if viewMode === 'chat'}
    <!-- Messages Area -->
    <div class="messages-area">
      {#if !hasApiKey}
        <div class="setup-notice">
          <i class="fas fa-key"></i>
          <h3>Welcome to FoundryAI</h3>
          <p>Configure your OpenRouter API key to get started.</p>
          <button class="setup-btn" onclick={openSettings}>
            <i class="fas fa-cog"></i> Open Settings
          </button>
        </div>
      {:else if compactMessages.length === 0}
        <div class="empty-chat">
          <i class="fas fa-brain"></i>
          <h3>FoundryAI</h3>
          <p>Your AI DM Assistant</p>
          <div class="suggestions">
            <button onclick={() => { inputText = 'What do the players see when they enter the room?'; sendMessage(); }}>
              🎭 Describe a scene
            </button>
            <button onclick={() => { inputText = 'What DC should a Perception check be to notice the hidden door?'; sendMessage(); }}>
              🎲 Skill check guidance
            </button>
            <button onclick={() => { inputText = 'Voice the tavern keeper greeting the party'; sendMessage(); }}>
              🗣️ NPC dialogue
            </button>
            <button onclick={() => { inputText = 'Search my journals for information about the villain'; sendMessage(); }}>
              📖 Search lore
            </button>
          </div>
        </div>
      {:else}
        {#each compactMessages as item, i (i)}
          {#if item.type === 'tool-group'}
            <!-- Single compact box for all tool calls in this round -->
            <details class="tool-activity-group">
              <summary>
                <i class="fas fa-wrench"></i>
                <span>Tool calls: {item.toolCalls.map(tc => tc.name).join(', ')}</span>
                <span class="tool-count">({item.results.length} result{item.results.length !== 1 ? 's' : ''})</span>
              </summary>
              <div class="tool-results-list">
                {#each item.results as result}
                  <div class="tool-result-item">
                    <span class="tool-result-name">{result.name}</span>
                    <pre class="tool-result-data">{(() => { try { return JSON.stringify(JSON.parse(result.content), null, 2); } catch { return result.content; } })()}</pre>
                  </div>
                {/each}
              </div>
            </details>
          {:else if item.msg.role === 'user'}
            <!-- User message with edit/retry actions -->
            {#if editingIndex === item.index}
              <div class="message-edit-form">
                <textarea
                  class="edit-textarea"
                  bind:value={editText}
                  onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit(); } if (e.key === 'Escape') cancelEdit(); }}
                ></textarea>
                <div class="edit-actions">
                  <button class="edit-btn save" onclick={submitEdit}><i class="fas fa-check"></i> Send</button>
                  <button class="edit-btn cancel" onclick={cancelEdit}><i class="fas fa-times"></i> Cancel</button>
                </div>
              </div>
            {:else}
              <div class="user-message-wrapper">
                <MessageBubble
                  role="user"
                  content={typeof item.msg.content === 'string' ? item.msg.content : ''}
                />
                <div class="message-actions">
                  <button class="action-btn" title="Edit & resend" onclick={() => startEditMessage(item.index)}>
                    <i class="fas fa-pen"></i>
                  </button>
                  <button class="action-btn" title="Retry" onclick={() => retryFromMessage(item.index)}>
                    <i class="fas fa-redo"></i>
                  </button>
                </div>
              </div>
            {/if}
          {:else}
            <!-- Assistant/system messages with regenerate action -->
            <div class="assistant-message-wrapper">
              <MessageBubble
                role={item.msg.role as 'user' | 'assistant' | 'system' | 'tool'}
                content={typeof item.msg.content === 'string' ? item.msg.content : ''}
                toolName={item.msg.name}
              />
              {#if item.msg.role === 'assistant' && !isGenerating}
                <div class="message-actions">
                  <button class="action-btn" title="Regenerate response" onclick={() => regenerateAssistantMessage(item.index)}>
                    <i class="fas fa-sync-alt"></i>
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        {/each}

        <!-- Streaming message -->
        {#if isGenerating && streamingContent}
          <MessageBubble
            role="assistant"
            content={streamingContent}
            isStreaming={true}
          />
        {/if}

        <!-- Generating indicator -->
        {#if isGenerating && !streamingContent}
          <div class="generating-indicator">
            <div class="dot-loader">
              <span></span><span></span><span></span>
            </div>
            <span>Thinking...</span>
          </div>
        {/if}
      {/if}

      <div bind:this={messagesEndEl}></div>
    </div>

    <!-- Input Area -->
    <div class="input-area">
      <textarea
        bind:this={inputEl}
        bind:value={inputText}
        onkeydown={handleKeydown}
        placeholder={isGenerating ? 'Generating...' : 'Ask FoundryAI...'}
        disabled={isGenerating || !hasApiKey}
        rows="1"
      ></textarea>
      <button
        class="send-btn"
        onclick={sendMessage}
        disabled={isGenerating || !inputText.trim() || !hasApiKey}
        title="Send (Enter)"
      >
        {#if isGenerating}
          <i class="fas fa-spinner fa-spin"></i>
        {:else}
          <i class="fas fa-paper-plane"></i>
        {/if}
      </button>
      {#if isGenerating}
        <button
          class="stop-btn"
          onclick={stopGeneration}
          title="Stop generation"
        >
          <i class="fas fa-stop"></i>
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .chat-window {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--foundry-ai-bg, #1a1a2e);
    color: var(--foundry-ai-text, #e0e0e0);
    font-family: 'Signika', sans-serif;
    overflow: hidden;
  }

  /* ---- Toolbar ---- */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    background: rgba(0, 0, 0, 0.3);
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    gap: 6px;
    min-height: 36px;
  }

  .toolbar-left,
  .toolbar-right {
    display: flex;
    gap: 2px;
  }

  .toolbar-title {
    flex: 1;
    text-align: center;
    font-size: 0.82em;
    font-weight: 500;
    opacity: 0.7;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 8px;
  }

  .toolbar-btn {
    background: none;
    border: 1px solid transparent;
    color: rgba(255, 255, 255, 0.5);
    padding: 4px 8px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.85em;
    transition: all 0.15s;
  }

  .toolbar-btn:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.1);
  }

  .toolbar-btn.active {
    color: #8b5cf6;
    background: rgba(139, 92, 246, 0.15);
    border-color: rgba(139, 92, 246, 0.3);
  }

  .toolbar-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  /* ---- Progress Banners ---- */
  .progress-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: rgba(139, 92, 246, 0.15);
    border-bottom: 1px solid rgba(139, 92, 246, 0.2);
    font-size: 0.8em;
    color: #c4b5fd;
  }

  .index-banner {
    background: rgba(59, 130, 246, 0.15);
    border-color: rgba(59, 130, 246, 0.2);
    color: #93c5fd;
  }

  /* ---- Messages Area ---- */
  .messages-area {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    scroll-behavior: smooth;
  }

  .messages-area::-webkit-scrollbar {
    width: 6px;
  }

  .messages-area::-webkit-scrollbar-track {
    background: transparent;
  }

  .messages-area::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.15);
    border-radius: 3px;
  }

  /* ---- Tool activity group (compact) ---- */
  .tool-activity-group {
    margin: 4px 8px;
    border-left: 3px solid #f59e0b;
    border-radius: 4px;
    background: rgba(245, 158, 11, 0.08);
    font-size: 0.8em;
  }

  .tool-activity-group summary {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    color: #f59e0b;
    cursor: pointer;
    font-weight: 600;
    user-select: none;
  }

  .tool-activity-group summary::-webkit-details-marker {
    display: none;
  }

  .tool-activity-group summary::before {
    content: '▶';
    font-size: 0.7em;
    transition: transform 0.15s;
  }

  .tool-activity-group[open] summary::before {
    transform: rotate(90deg);
  }

  .tool-count {
    opacity: 0.6;
    font-weight: 400;
    font-size: 0.9em;
  }

  .tool-results-list {
    padding: 2px 8px 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .tool-result-item {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 3px;
    padding: 4px 6px;
  }

  .tool-result-name {
    font-weight: 600;
    color: #f59e0b;
    font-size: 0.85em;
    display: block;
    margin-bottom: 2px;
  }

  .tool-result-data {
    max-height: 150px;
    overflow-y: auto;
    white-space: pre-wrap;
    font-size: 0.8em;
    margin: 0;
    background: rgba(0, 0, 0, 0.15);
    padding: 4px;
    border-radius: 2px;
    color: rgba(255, 255, 255, 0.7);
  }

  /* ---- User message wrapper with actions ---- */
  .user-message-wrapper {
    position: relative;
  }

  .user-message-wrapper:hover .message-actions {
    opacity: 1;
  }

  /* ---- Assistant message wrapper with actions ---- */
  .assistant-message-wrapper {
    position: relative;
  }

  .assistant-message-wrapper:hover .message-actions {
    opacity: 1;
  }

  .message-actions {
    display: flex;
    gap: 4px;
    position: absolute;
    bottom: -2px;
    right: 8px;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .action-btn {
    background: rgba(59, 130, 246, 0.3);
    border: none;
    color: rgba(255, 255, 255, 0.7);
    width: 22px;
    height: 22px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.65em;
    padding: 0;
  }

  .action-btn:hover {
    background: rgba(59, 130, 246, 0.6);
    color: #fff;
  }

  /* ---- Edit form ---- */
  .message-edit-form {
    margin: 4px 12px;
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.3);
    border-radius: 8px;
    padding: 8px;
  }

  .edit-textarea {
    width: 100%;
    min-height: 60px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    color: inherit;
    font-family: inherit;
    font-size: 0.9em;
    padding: 6px;
    resize: vertical;
    box-sizing: border-box;
  }

  .edit-actions {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    justify-content: flex-end;
  }

  .edit-btn {
    border: none;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.8em;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .edit-btn.save {
    background: #3b82f6;
    color: #fff;
  }

  .edit-btn.save:hover {
    background: #2563eb;
  }

  .edit-btn.cancel {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.7);
  }

  .edit-btn.cancel:hover {
    background: rgba(255, 255, 255, 0.2);
  }

  /* ---- Setup / Empty States ---- */
  .setup-notice,
  .empty-chat {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    text-align: center;
    padding: 24px;
    gap: 8px;
  }

  .setup-notice i,
  .empty-chat i {
    font-size: 3em;
    opacity: 0.2;
    margin-bottom: 8px;
  }

  .setup-notice h3,
  .empty-chat h3 {
    margin: 0;
    font-size: 1.1em;
    color: #e0c080;
  }

  .setup-notice p,
  .empty-chat p {
    margin: 0;
    font-size: 0.85em;
    opacity: 0.6;
  }

  .setup-btn {
    margin-top: 12px;
    background: rgba(139, 92, 246, 0.3);
    border: 1px solid rgba(139, 92, 246, 0.5);
    color: #c4b5fd;
    padding: 8px 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9em;
    transition: all 0.2s;
  }

  .setup-btn:hover {
    background: rgba(139, 92, 246, 0.5);
    color: #fff;
  }

  .suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 16px;
    justify-content: center;
  }

  .suggestions button {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.7);
    padding: 6px 12px;
    border-radius: 16px;
    cursor: pointer;
    font-size: 0.78em;
    transition: all 0.15s;
  }

  .suggestions button:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
    border-color: rgba(255, 255, 255, 0.2);
  }

  /* ---- Generating Indicator ---- */
  .generating-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    font-size: 0.85em;
    color: rgba(255, 255, 255, 0.5);
  }

  .dot-loader {
    display: flex;
    gap: 4px;
  }

  .dot-loader span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #8b5cf6;
    animation: dot-bounce 1.4s infinite both;
  }

  .dot-loader span:nth-child(2) { animation-delay: 0.2s; }
  .dot-loader span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes dot-bounce {
    0%, 80%, 100% { transform: scale(0.6); opacity: 0.3; }
    40% { transform: scale(1); opacity: 1; }
  }

  /* ---- Input Area ---- */
  .input-area {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    padding: 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(0, 0, 0, 0.2);
  }

  .input-area textarea {
    flex: 1;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    color: inherit;
    padding: 8px 12px;
    font-family: inherit;
    font-size: 0.9em;
    resize: none;
    min-height: 38px;
    max-height: 120px;
    line-height: 1.4;
    outline: none;
    transition: border-color 0.15s;
  }

  .input-area textarea:focus {
    border-color: rgba(139, 92, 246, 0.5);
  }

  .input-area textarea:disabled {
    opacity: 0.4;
  }

  .input-area textarea::placeholder {
    color: rgba(255, 255, 255, 0.3);
  }

  .send-btn {
    background: #8b5cf6;
    border: none;
    color: #fff;
    width: 38px;
    height: 38px;
    border-radius: 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.9em;
    transition: all 0.15s;
    flex-shrink: 0;
  }

  .send-btn:hover:not(:disabled) {
    background: #7c3aed;
    transform: scale(1.05);
  }

  .send-btn:disabled {
    background: rgba(139, 92, 246, 0.3);
    cursor: not-allowed;
  }

  .stop-btn {
    background: #ef4444;
    border: none;
    color: #fff;
    width: 38px;
    height: 38px;
    border-radius: 8px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.9em;
    transition: all 0.15s;
    flex-shrink: 0;
    margin-left: 6px;
  }

  .stop-btn:hover {
    background: #dc2626;
    transform: scale(1.05);
  }

  /* ---- Actor Picker ---- */
  .actor-picker {
    display: flex;
    flex-direction: column;
    max-height: 300px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(0, 0, 0, 0.25);
  }

  .actor-picker-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .actor-picker-header h3 {
    margin: 0;
    font-size: 0.85em;
    font-weight: 600;
    color: #f59e0b;
    white-space: nowrap;
  }

  .actor-search {
    flex: 1;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    color: inherit;
    padding: 4px 8px;
    font-size: 0.8em;
    font-family: inherit;
    outline: none;
  }

  .actor-search:focus {
    border-color: rgba(245, 158, 11, 0.4);
  }

  .actor-picker-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px;
  }

  .actor-pick-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    margin: 1px 0;
    border: 1px solid transparent;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.03);
    cursor: pointer;
    text-align: left;
    color: inherit;
    transition: all 0.15s;
  }

  .actor-pick-btn:hover {
    background: rgba(245, 158, 11, 0.15);
    border-color: rgba(245, 158, 11, 0.3);
  }

  .actor-pick-img {
    width: 32px;
    height: 32px;
    border-radius: 4px;
    object-fit: cover;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .actor-pick-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .actor-pick-name {
    font-size: 0.85em;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .actor-pick-type {
    font-size: 0.7em;
    opacity: 0.5;
    text-transform: capitalize;
  }

  .actor-pick-empty {
    padding: 16px;
    text-align: center;
    font-size: 0.82em;
    opacity: 0.4;
  }

  /* ---- Sidebar adjustments ---- */
  .chat-window.sidebar {
    font-size: 0.95em;
  }

  .chat-window.sidebar .toolbar {
    padding: 4px 6px;
  }

  .chat-window.sidebar .messages-area {
    padding: 6px;
  }
</style>
