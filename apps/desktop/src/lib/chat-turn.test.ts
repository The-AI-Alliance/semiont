import { describe, it, expect, vi, afterEach } from 'vitest';
import { resourceId } from '@semiont/core';
import type { ResourceId } from '@semiont/core';
import type { AgentHistoryMessage, AgentTurnResult } from './agent-bridge';
import { chatTurn, createResolvedReference, readAgentHistory } from './chat-turn';
import type { ChatSession } from './session';

interface StoredResource {
  name: string;
  content: string;
}

/** A focused session fake for Desktop chat's resource-backed conversation protocol. */
function harness(agentResult: AgentTurnResult = { answer: 'Here is the answer.', events: [] }) {
  const resources = new Map<string, StoredResource>();
  const annotations = new Map<string, unknown[]>();
  const writes: Array<{ id: string; name: string; content: string }> = [];
  const marks: Array<Record<string, unknown>> = [];
  let nextId = 0;

  const session = {
    client: {
      yield: {
        resource: vi.fn(async (input: { name: string; file: File }) => {
          const id = `resource-${++nextId}`;
          const content = await input.file.text();
          resources.set(id, { name: input.name, content });
          writes.push({ id, name: input.name, content });
          return { resourceId: resourceId(id) };
        }),
      },
      mark: {
        annotation: vi.fn(async (input: Record<string, unknown>) => {
          marks.push(input);
          const target = input.target as { source: ResourceId };
          annotations.set(target.source, [
            ...(annotations.get(target.source) ?? []),
            { motivation: input.motivation, body: input.body },
          ]);
        }),
      },
      browse: {
        resource: vi.fn((id: ResourceId) => ({ fresh: async () => {
          const value = resources.get(id);
          if (value === undefined) throw new Error(`Unknown resource ${id}`);
          return { name: value.name };
        } })),
        resourceContent: vi.fn(async (id: ResourceId) => {
          const value = resources.get(id);
          if (value === undefined) throw new Error(`Unknown resource ${id}`);
          return value.content;
        }),
        annotations: vi.fn((id: ResourceId) => ({ fresh: async () => annotations.get(id) ?? [] })),
      },
    },
  } as unknown as ChatSession;

  const complete = vi.fn(async (_input: { messages: AgentHistoryMessage[] }) => agentResult);
  vi.stubGlobal('window', { agentBridge: { complete } });
  return { session, resources, annotations, writes, marks, complete };
}

afterEach(() => vi.unstubAllGlobals());

describe('chatTurn (resource-backed agent conversation)', () => {
  it('stores the user turn, sends linked history to the Desktop agent, and stores its answer', async () => {
    const h = harness();
    const phases: unknown[] = [];
    const heads: ResourceId[] = [];

    const result = await chatTurn(h.session, {
      question: 'What does the spec say about retries?',
      provider: 'ollama',
      model: 'qwen3.5:27b',
      kbDid: 'did:web:example.test:kb',
      conversationId: 'conversation-1',
    }, (id) => heads.push(id))(event => phases.push(event));

    expect(h.writes.map(({ name, content }) => ({ name, content }))).toEqual([
      { name: 'Desktop chat user', content: 'What does the spec say about retries?' },
      { name: 'Desktop chat assistant', content: 'Here is the answer.' },
    ]);
    expect(h.complete).toHaveBeenCalledWith({
      provider: 'ollama',
      model: 'qwen3.5:27b',
      kbDid: 'did:web:example.test:kb',
      messages: [{ role: 'user', content: 'What does the spec say about retries?' }],
    });
    expect(h.marks).toHaveLength(1);
    expect(h.marks[0]).toEqual(expect.objectContaining({
      motivation: 'commenting',
      target: { source: result.answerId },
      body: { type: 'SpecificResource', source: result.questionId, purpose: 'replying' },
    }));
    expect(result).toEqual({
      questionId: heads[0],
      answerId: heads[1],
      answerText: 'Here is the answer.',
    });
    expect(heads).toEqual([result.questionId, result.answerId]);
    expect(phases).toEqual([
      { kind: 'phase', phase: 'gathering' },
      { kind: 'question', questionId: result.questionId },
      { kind: 'phase', phase: 'thinking' },
    ]);
  });

  it('persists tool calls and results as linked resources before the assistant reply', async () => {
    const h = harness({
      answer: 'Found the resource.',
      events: [
        { kind: 'tool-call', name: 'semiont_browse', payload: '{"resourceId":"r-1"}' },
        { kind: 'tool-result', name: 'semiont_browse', payload: 'A matching resource.' },
      ],
    });

    await chatTurn(h.session, { question: 'Find this resource' })(() => {});

    expect(h.writes.map(({ name, content }) => ({ name, content }))).toEqual([
      { name: 'Desktop chat user', content: 'Find this resource' },
      { name: 'Desktop chat tool call', content: '{"resourceId":"r-1"}' },
      { name: 'Desktop chat tool result', content: '{"name":"semiont_browse","content":"A matching resource."}' },
      { name: 'Desktop chat assistant', content: 'Found the resource.' },
    ]);
    expect(h.marks.map((mark) => (mark.body as { source: string }).source)).toEqual([
      h.writes[0]?.id,
      h.writes[1]?.id,
      h.writes[2]?.id,
    ]);
  });

  it('includes prior linked turns in order', async () => {
    const h = harness();
    const first = await chatTurn(h.session, { question: 'First question' })(() => {});

    await chatTurn(h.session, {
      question: 'Second question',
      previousMessageId: first.answerId,
    })(() => {});

    expect(h.complete.mock.calls[1]?.[0].messages).toEqual([
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'Here is the answer.' },
      { role: 'user', content: 'Second question' },
    ]);
  });

  it('reconstructs stored tool-call and tool-result messages from resource history', async () => {
    const h = harness({ answer: 'Done.', events: [
      { kind: 'tool-call', name: 'semiont_browse', payload: '{"tool_calls":[{"function":{"name":"semiont_browse","arguments":{"query":"x"}}}]}' },
      { kind: 'tool-result', name: 'semiont_browse', payload: 'result' },
    ] });
    const turn = await chatTurn(h.session, { question: 'Use a tool' })(() => {});

    expect(await readAgentHistory(h.session, turn.answerId)).toEqual([
      { role: 'user', content: 'Use a tool' },
      { role: 'assistant', content: '', toolCalls: [{ name: 'semiont_browse', arguments: { query: 'x' } }] },
      { role: 'tool', toolName: 'semiont_browse', content: 'result' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });
});

describe('createResolvedReference (single-span selection linking)', () => {
  it('creates a pre-resolved linking annotation with quote context from the source text', async () => {
    const h = harness();
    const text = 'Clara moved to Des Moines after the harvest failed in 1893.';
    const start = text.indexOf('Des Moines');
    const end = start + 'Des Moines'.length;

    await createResolvedReference(h.session, resourceId('msg-1'), text, { start, end }, resourceId('doc-dsm'));

    expect(h.marks).toEqual([expect.objectContaining({
      motivation: 'linking',
      target: {
        source: 'msg-1',
        selector: [
          { type: 'TextPositionSelector', start, end },
          expect.objectContaining({ type: 'TextQuoteSelector', exact: 'Des Moines' }),
        ],
      },
      body: { type: 'SpecificResource', source: 'doc-dsm', purpose: 'linking' },
    })]);
  });
});
