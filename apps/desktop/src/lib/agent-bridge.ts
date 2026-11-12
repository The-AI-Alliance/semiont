import type { ResourceId } from '@semiont/core';
import type { ChatSession } from './session';

export const AGENT_PROVIDERS = [{ id: 'ollama', label: 'Ollama' }] as const;
export type AgentProviderId = (typeof AGENT_PROVIDERS)[number]['id'];
export const DEFAULT_AGENT_PROVIDER: AgentProviderId = AGENT_PROVIDERS[0].id;

export const AGENT_MODELS = [
  { id: 'qwen3.5:27b', label: 'Qwen 3.5 · 27B' },
  { id: 'granite4.1:30b', label: 'Granite 4.1 · 30B' },
] as const;
export type AgentModelId = (typeof AGENT_MODELS)[number]['id'];
export const DEFAULT_AGENT_MODEL: AgentModelId = AGENT_MODELS[0].id;

export function isAgentProviderId(value: unknown): value is AgentProviderId {
  return AGENT_PROVIDERS.some((provider) => provider.id === value);
}

export function isAgentModelId(value: unknown): value is AgentModelId {
  return AGENT_MODELS.some((model) => model.id === value);
}

/** The provider-neutral portion of a chat turn sent to the Desktop host. */
export interface AgentHistoryMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  /** Ollama's native assistant tool-call message, preserved for the next model round. */
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export interface AgentToolEvent {
  kind: 'tool-call' | 'tool-result';
  name: string;
  payload: string;
}

export interface AgentTurnResult {
  answer: string;
  events: AgentToolEvent[];
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
}

export interface AgentBridge {
  complete(input: {
    provider: AgentProviderId;
    model: AgentModelId;
    kbDid: string;
    messages: AgentHistoryMessage[];
  }): Promise<AgentTurnResult>;
}

export function isDesktopChatResource(name: string | undefined): boolean {
  return name === 'Desktop chat user' || name === 'Desktop chat assistant' || name === 'Desktop chat tool call' || name === 'Desktop chat tool result';
}

/** Write a chat event as a plain-text KB resource and link it to its predecessor. */
export async function appendChatResource(
  session: ChatSession,
  conversationId: string,
  role: 'user' | 'assistant' | 'tool-call' | 'tool-result',
  content: string,
  previousId?: ResourceId,
): Promise<ResourceId> {
  const id = crypto.randomUUID();
  const resourceName = role === 'tool-call' ? 'Desktop chat tool call' : role === 'tool-result' ? 'Desktop chat tool result' : `Desktop chat ${role}`;
  const { resourceId } = await session.client.yield.resource({
    name: resourceName,
    file: new File([content], `${id}.txt`, { type: 'text/plain' }),
    format: 'text/plain',
    storageUri: `file://desktop-chat/${conversationId}/${id}.txt`,
  });
  if (previousId !== undefined) {
    await session.client.mark.annotation({
      motivation: 'commenting',
      target: { source: resourceId },
      body: { type: 'SpecificResource', source: previousId, purpose: 'replying' },
    });
  }
  return resourceId;
}
