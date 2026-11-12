import { extractContext, textOffsets } from '@semiont/core';
import type { ResourceId } from '@semiont/core';
import type { AgentHistoryMessage, AgentModelId, AgentProviderId } from './agent-bridge';
import { appendChatResource, DEFAULT_AGENT_MODEL, DEFAULT_AGENT_PROVIDER } from './agent-bridge';
import type { ChatSession } from './session';

export type TurnPhase = 'gathering' | 'yielding' | 'thinking';
export type TurnEvent =
  | { kind: 'phase'; phase: TurnPhase }
  | { kind: 'question'; questionId: ResourceId };

export interface PendingReference {
  kind: 'resource';
  name: string;
  resourceId: ResourceId;
  start: number;
  end: number;
}

export interface ChatTurnParams {
  question: string;
  provider?: AgentProviderId;
  model?: AgentModelId;
  conversationId?: string;
  kbDid?: string;
  previousMessageId?: ResourceId;
  references?: PendingReference[];
}

/** Create a linking annotation whose exact text span points to a chosen resource. */
export async function createResolvedReference(
  session: ChatSession,
  resourceId: ResourceId,
  text: string,
  span: { start: number; end: number },
  targetResourceId: ResourceId,
): Promise<void> {
  const { start, end } = span;
  const offsets = textOffsets(text);
  const context = extractContext(text, start, end);
  await session.client.mark.annotation({
    motivation: 'linking',
    target: {
      source: resourceId,
      selector: [
        { type: 'TextPositionSelector', start, end },
        {
          type: 'TextQuoteSelector',
          exact: text.slice(offsets.indexAt(start), offsets.indexAt(end)),
          ...(context.prefix !== undefined ? { prefix: context.prefix } : {}),
          ...(context.suffix !== undefined ? { suffix: context.suffix } : {}),
        },
      ],
    },
    body: { type: 'SpecificResource', source: targetResourceId, purpose: 'linking' },
  });
}

export async function createResolvedReferences(
  session: ChatSession,
  resourceId: ResourceId,
  text: string,
  references: PendingReference[],
): Promise<void> {
  const offsets = textOffsets(text);
  for (const ref of references) {
    if (text.slice(ref.start, ref.end) !== ref.name) continue;
    await createResolvedReference(session, resourceId, text, {
      start: offsets.offsetAt(ref.start),
      end: offsets.offsetAt(ref.end),
    }, ref.resourceId);
  }
}

// Ollama does not expose a cross-model tokenizer endpoint. Four characters per token is a
// deliberately conservative local estimate; keep the actual prompt below a small context
// window while preserving the newest messages first.
const CHAT_CONTEXT_TOKEN_BUDGET = 6_000;
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

function priorMessageId(annotations: unknown): ResourceId | undefined {
  if (!Array.isArray(annotations)) return undefined;
  for (const value of annotations) {
    if (typeof value !== 'object' || value === null || !('motivation' in value) || value.motivation !== 'commenting' || !('body' in value)) continue;
    const body = value.body;
    if (typeof body === 'object' && body !== null && 'type' in body && body.type === 'SpecificResource' && 'purpose' in body && body.purpose === 'replying' && 'source' in body && typeof body.source === 'string') {
      return body.source as ResourceId;
    }
  }
  return undefined;
}

function parseStoredMessage(name: string, content: string): AgentHistoryMessage | undefined {
  if (name === 'Desktop chat user') return { role: 'user', content };
  if (name === 'Desktop chat assistant') return { role: 'assistant', content };
  if (name === 'Desktop chat tool call') {
    try {
      const payload: unknown = JSON.parse(content);
      if (typeof payload !== 'object' || payload === null || !('tool_calls' in payload) || !Array.isArray(payload.tool_calls)) return undefined;
      const toolCalls = payload.tool_calls.flatMap((item: unknown) => {
        if (typeof item !== 'object' || item === null || !('function' in item)) return [];
        const fn = item.function;
        if (typeof fn !== 'object' || fn === null || !('name' in fn) || typeof fn.name !== 'string' || !('arguments' in fn)) return [];
        const args = fn.arguments;
        if (typeof args !== 'object' || args === null || Array.isArray(args)) return [];
        return [{ name: fn.name, arguments: args as Record<string, unknown> }];
      });
      return { role: 'assistant', content: '', toolCalls };
    } catch {
      return undefined;
    }
  }
  if (name === 'Desktop chat tool result') {
    try {
      const payload: unknown = JSON.parse(content);
      if (typeof payload === 'object' && payload !== null && 'name' in payload && typeof payload.name === 'string' && 'content' in payload && typeof payload.content === 'string') {
        return { role: 'tool', toolName: payload.name, content: payload.content };
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Reconstruct bounded model context by walking backward from the current KB Resource. */
export async function readAgentHistory(session: ChatSession, headId?: ResourceId): Promise<AgentHistoryMessage[]> {
  const collected: AgentHistoryMessage[] = [];
  const seen = new Set<string>();
  let current = headId;
  let remaining = CHAT_CONTEXT_TOKEN_BUDGET;
  while (current !== undefined && remaining > 0 && !seen.has(current)) {
    seen.add(current);
    const [resource, content, annotations] = await Promise.all([
      session.client.browse.resource(current).fresh(),
      session.client.browse.resourceContent(current),
      session.client.browse.annotations(current).fresh(),
    ]);
    const message = parseStoredMessage(resource.name ?? '', content);
    if (message !== undefined) {
      collected.push(message);
      remaining -= estimateTokens(content);
    }
    current = priorMessageId(annotations);
  }
  return collected.reverse();
}

export function chatTurn(
  session: ChatSession,
  params: ChatTurnParams,
  onHeadChange: (id: ResourceId) => void = () => {},
) {
  const { question, references, previousMessageId } = params;
  const conversationId = params.conversationId ?? crypto.randomUUID();
  const kbDid = params.kbDid ?? '';
  return async (onEvent: (event: TurnEvent) => void): Promise<{ questionId: ResourceId; answerId: ResourceId; answerText: string }> => {
    onEvent({ kind: 'phase', phase: 'gathering' });
    let head = await appendChatResource(session, conversationId, 'user', question, previousMessageId);
    onHeadChange(head);
    if (references !== undefined && references.length > 0) await createResolvedReferences(session, head, question, references);
    const questionId = head;
    onEvent({ kind: 'question', questionId });

    const history = await readAgentHistory(session, head);
    onEvent({ kind: 'phase', phase: 'thinking' });
    const bridge = typeof window === 'undefined' ? undefined : window.agentBridge;
    if (bridge === undefined) throw new Error('Agent chat is available in the Semiont Desktop app.');
    const result = await bridge.complete({
      provider: params.provider ?? DEFAULT_AGENT_PROVIDER,
      model: params.model ?? DEFAULT_AGENT_MODEL,
      kbDid,
      messages: history,
    });
    for (const event of result.events) {
      const role = event.kind === 'tool-call' ? 'tool-call' : 'tool-result';
      const content = event.kind === 'tool-call' ? event.payload : JSON.stringify({ name: event.name, content: event.payload });
      head = await appendChatResource(session, conversationId, role, content, head);
      onHeadChange(head);
    }
    const answerId = await appendChatResource(session, conversationId, 'assistant', result.answer, head);
    onHeadChange(answerId);
    return { questionId, answerId, answerText: result.answer };
  };
}
