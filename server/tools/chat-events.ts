import { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Chat long-poll tool — the bridge from pull-only MCP clients to Foundry's
 * event stream. MCP clients (Claude Desktop, Codex) only learn things as tool
 * results, so "listening" to table chat means holding a tool call open until
 * something happens. The handler in backend.ts polls the Foundry module
 * (foundry-ai.tool.get_chat_since) every couple of seconds while the MCP
 * response stays pending.
 */
export function getChatEventToolDefinitions(): Tool[] {
  return [
    {
      name: 'wait-for-chat',
      description:
        'Wait for new messages in the Foundry VTT chat log (long-poll). Blocks until someone posts or the timeout passes, then returns the new messages oldest-first. Build a listen loop: call this → react (e.g. via post_chat_message) → call again passing the returned latest_id as since_message_id. The FIRST call without since_message_id just arms the listener and returns on the NEXT message. status "timeout" with no messages is normal — call again with the same latest_id to keep listening. Each message has an "automated" flag marking AI-generated posts (AI players / autonomous DM) — be deliberate about reacting to those, or two agents will loop off each other until the module\'s automation cap stops them.',
      inputSchema: {
        type: 'object',
        properties: {
          since_message_id: {
            type: 'string',
            description:
              'Return only messages posted after this message id — always pass the latest_id from the previous call. Omit on the first call to arm the listener at "now".',
          },
          timeout_seconds: {
            type: 'number',
            default: 75,
            description: 'How long to wait before returning a timeout, 65–300 seconds. Foundry is checked once per minute; allow at least 65 seconds for a complete check. Stay under your client\'s tool timeout.',
          },
          include_hidden: {
            type: 'boolean',
            default: false,
            description:
              'Include whispers and blind/GM-only messages. Leave false when the agent is playing a character — hidden messages are DM secrets.',
          },
        },
      },
    },
  ];
}
