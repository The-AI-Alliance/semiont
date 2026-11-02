import { describe, it, expect, vi } from 'vitest';
import { createTestSession, refuseUnscriptedOperation } from '@semiont/sdk/testing';
import { jobId as brandJobId, resourceId as brandResourceId } from '@semiont/core';
import type { GatheredContext, ResourceId } from '@semiont/core';
import { chatTurn, createResolvedReference } from './chat-turn';
import { QUESTION_ENTITY_TYPE } from './session';
import { recordingContent } from './test-content';

// These specs run the REAL SemiontClient over the scriptable FaultyTransport
// (@semiont/sdk/testing): the question upload goes through a recorded content
// transport, and every bus conversation (mark:create-request, gather, job:create,
// job lifecycle) is the real busRequest pathway — the wire itself is the
// assertion surface, so a wrong belief about the SDK can't hide in a mock.

// Minimal stand-in: chatTurn passes the gathered context straight through to yield.
// A `yield` job is generated from its context's focus, so a usable
// `focus.resource['@id']` is required — the fake carries the question's id.
function fakeContext(focusRid: string): GatheredContext {
  return { focus: { kind: 'resource', resource: { '@id': focusRid } } } as unknown as GatheredContext;
}

const QUESTION = 'What does the spec say about retries?';

/** One scripted stack per test: content ids, bus replies, and (unless hanging)
 *  a completer that finishes the generation job as soon as it's created. */
function harness(opts: {
  questionId: string;
  answerId?: string | null;
  context?: GatheredContext;
  hangGeneration?: boolean;
  /** Scripted `truncated` bit on the generation result (required; true exactly when
   *  the model stopped at the maxTokens ceiling). */
  truncated?: boolean;
  /** The job declines instead of generating: what it was to read could not be read. */
  declined?: 'empty' | 'corrupt';
}) {
  const context = opts.context ?? fakeContext(opts.questionId);
  const content = recordingContent({ resourceIds: [opts.questionId] });
  let annCounter = 0;
  const stack = createTestSession({
    content: content.transport,
    transport: {
      makeResponse: (op) => {
        if (op === 'mark:create-request') return { annotationId: `ann-${++annCounter}` };
        if (op === 'gather:resource-requested') return context;
        if (op === 'job:create') return { jobId: 'job-1' };
        return refuseUnscriptedOperation(op);
      },
    },
  });
  const { session, transport } = stack;

  // The wire, in arrival order — `transport.requestLog` carries every
  // request-channel emit with its payload snapshot, so no capture handlers.
  const channels = () => transport.requestLog.map((e) => e.channel as string);
  const payloadOf = (channel: string) => transport.requestLog.find((e) => e.channel === channel)?.payload;
  const payloadsOf = (channel: string) =>
    transport.requestLog.filter((e) => e.channel === channel).map((e) => e.payload);

  if (!opts.hangGeneration) {
    // Finish the generation once the job exists (a tick later, so the SDK has
    // its jobId registered before the lifecycle event arrives).
    transport.on('job:create', () => {
      setTimeout(() => {
        void transport.emit('job:complete', {
          resourceId: brandResourceId(opts.questionId),
          jobId: brandJobId('job-1'),
          jobType: 'yield',
          // A `yield` job's result is the resource it made (resourceId + truncated
          // required) or a decline (the one with `declined`); neither names a kind.
          // "No answer resource" is a completion with no result at all.
          ...(opts.declined !== undefined
            ? { result: { declined: true, reason: opts.declined } }
            : opts.answerId === null
              ? {}
              : {
                  result: {
                    resourceId: brandResourceId(opts.answerId ?? 'answer-1'),
                    resourceName: 'answer',
                    truncated: opts.truncated ?? false,
                  },
                }),
        });
      }, 0);
    });
  }

  // Stall-guard observation: the SDK's guard cancels the job on the wire, by its id
  // (`job:cancel-requested`), so the pin listens at the transport.
  const cancels: Array<{ jobId: string }> = [];
  transport.on('job:cancel-requested', (p) => cancels.push(p));

  return { session, transport, content, channels, payloadOf, payloadsOf, cancels };
}

describe('chatTurn (resource-focal)', () => {
  it('persists the question, gathers with Questions excluded, and generates — no marking', async () => {
    const context = fakeContext('q-1');
    const h = harness({ questionId: 'q-1', answerId: 'ans-7', context });
    const onEvent = vi.fn();

    const run = chatTurn(h.session, { question: QUESTION });
    const result = await run(onEvent);

    // 1. question persisted as a Question-typed resource (the type is ensured at
    //    sign-in, not by chatTurn) — the upload's own request shape says so
    expect(h.content.puts[0]).toEqual(
      expect.objectContaining({ name: QUESTION, format: 'text/markdown', entityTypes: [QUESTION_ENTITY_TYPE] }),
    );

    // 2. gather.resource on the question id, excluding prior Questions — the SDK
    //    sends the gather options nested under `options` on the wire
    expect(h.payloadOf('gather:resource-requested')).toEqual(
      expect.objectContaining({
        resourceId: 'q-1',
        options: expect.objectContaining({ excludeEntityTypes: [QUESTION_ENTITY_TYPE] }),
      }),
    );

    // 3. the generation job on the question — Q&A-shaped (INFERENCE-TEMPLATE tiers 1+3):
    //    `task` frames it as an ANSWER, `structure` is flowing prose, `cite` has the
    //    model wrap each cited claim as [[id: claim]]; `prompt` is the residual "how".
    // No top-level resourceId on the wire: what the job is generated from travels
    // INSIDE params.context (the dispatcher derives it from the focus).
    expect(h.payloadOf('job:create')).toEqual(
      expect.objectContaining({
        jobType: 'yield',
        params: expect.objectContaining({
          title: QUESTION,
          context,
          task: 'answer',
          structure: 'prose',
          cite: true,
          prompt: 'Be direct and concise.',
        }),
      }),
    );

    // events in order: gathering → the question id (mid-turn, for the annotated question
    // bubble) → yielding
    expect(onEvent.mock.calls.map(([e]) => e)).toEqual([
      { kind: 'phase', phase: 'gathering' },
      { kind: 'question', questionId: 'q-1' },
      { kind: 'phase', phase: 'yielding' },
    ]);

    // 4. the answer is returned; marking is NOT part of the turn anymore — the only
    //    job on the wire is the generation
    expect(result).toEqual({ questionId: 'q-1', answerId: 'ans-7' });
    expect(h.channels().filter((c) => c === 'job:create')).toHaveLength(1);
    await h.session.dispose();
  });

  it('returns only the question when generation yields no answer resource', async () => {
    const h = harness({ questionId: 'q-3', answerId: null });
    const run = chatTurn(h.session, { question: QUESTION });
    const result = await run(() => {});
    expect(result).toEqual({ questionId: 'q-3' });
    expect(h.channels().filter((c) => c === 'job:create')).toHaveLength(1); // generation only
    await h.session.dispose();
  });

  it('fails the turn, with the reason, when the job declines because the question could not be read', async () => {
    const h = harness({ questionId: 'q-6', declined: 'empty' });
    await expect(chatTurn(h.session, { question: QUESTION })(() => {})).rejects.toThrow(/could not be read \(empty\)/);
    await h.session.dispose();
  });

  it('surfaces the truncated bit — a clipped answer reaches the result, an unclipped one stays silent', async () => {
    const clipped = harness({ questionId: 'q-4', answerId: 'ans-9', truncated: true });
    const clippedResult = await chatTurn(clipped.session, { question: QUESTION })(() => {});
    expect(clippedResult).toEqual({ questionId: 'q-4', answerId: 'ans-9', answerTruncated: true });
    await clipped.session.dispose();

    const clean = harness({ questionId: 'q-5', answerId: 'ans-10' }); // truncated: false
    const cleanResult = await chatTurn(clean.session, { question: QUESTION })(() => {});
    expect(cleanResult).toEqual({ questionId: 'q-5', answerId: 'ans-10' });
    expect(cleanResult).not.toHaveProperty('answerTruncated');
    await clean.session.dispose();
  });

  it('fails loudly (and cancels) when the generation goes silent instead of hanging forever', async () => {
    vi.useFakeTimers();
    try {
      // Job created, then the backend goes silent: no job:complete ever arrives.
      const h = harness({ questionId: 'q-9', hangGeneration: true });
      const run = chatTurn(h.session, { question: QUESTION });
      const settled = run(() => {}).then(
        () => ({ ok: true }) as const,
        (err: unknown) => ({ ok: false, err }) as const,
      );

      // Flush the persist/gather microtasks, then advance past the stall window.
      await vi.advanceTimersByTimeAsync(90_000);
      const outcome = await settled;

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(String((outcome.err as Error).message)).toMatch(/went silent|reconnect/i);
      // the job the queue named is cancelled, not left running
      expect(h.cancels).toContainEqual(expect.objectContaining({ jobId: 'job-1' }));
      await h.session.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createResolvedReference (shared single-span create — selection-linking uses this)', () => {
  it('creates one pre-resolved linking annotation for an arbitrary span, with source context', async () => {
    const h = harness({ questionId: 'unused' });
    const text = 'Clara moved to Des Moines after the harvest failed in 1893.';
    const start = text.indexOf('Des Moines');
    const end = start + 'Des Moines'.length;

    await createResolvedReference(
      h.session,
      'msg-1' as unknown as ResourceId,
      text,
      { start, end },
      'doc-dsm' as unknown as ResourceId,
    );

    const creates = h.payloadsOf('mark:create-request');
    expect(creates).toHaveLength(1);
    // On the wire the annotation input rides in the `{ resourceId, request }` envelope.
    const envelope = creates[0] as {
      resourceId: string;
      request: {
        motivation: string;
        target: { source: string; selector: Array<Record<string, unknown>> };
        body: { type: string; source: string; purpose: string };
      };
    };
    expect(envelope.resourceId).toBe('msg-1');
    const input = envelope.request;
    expect(input.motivation).toBe('linking');
    expect(input.target.source).toBe('msg-1');
    expect(input.target.selector[0]).toEqual({ type: 'TextPositionSelector', start, end });
    const quote = input.target.selector[1] as { type: string; exact: string; prefix?: string; suffix?: string };
    expect(quote.type).toBe('TextQuoteSelector');
    expect(quote.exact).toBe('Des Moines');
    // context extracted from the SOURCE text (word-boundary window via core extractContext)
    expect(quote.prefix?.endsWith('moved to ')).toBe(true);
    expect(quote.suffix?.startsWith(' after')).toBe(true);
    expect(input.body).toEqual({ type: 'SpecificResource', source: 'doc-dsm', purpose: 'linking' });
    await h.session.dispose();
  });
});

describe('createResolvedReferences (D2 path a — mentions become resolved annotations)', () => {
  it('creates one pre-resolved linking annotation per mention, anchored on the chip offsets, before gather', async () => {
    const h = harness({ questionId: 'q-7' });
    // The `@` is only the compose-time trigger — the sent text carries the BARE name; the
    // composer's serialize supplies each chip's exact offsets.
    const question = 'Compare Elias Turner with Margaret Hale please';

    // Capture the wire as it stood at each turn event, for ordering proofs.
    const seen: Array<{ event: unknown; wireAt: string[] }> = [];
    const run = chatTurn(h.session, {
      question,
      references: [
        { kind: 'resource' as const, name: 'Elias Turner', resourceId: 'doc-elias' as unknown as ResourceId, start: 8, end: 20 },
        { kind: 'resource' as const, name: 'Margaret Hale', resourceId: 'doc-margaret' as unknown as ResourceId, start: 26, end: 39 },
      ],
    });
    await run((event) => seen.push({ event, wireAt: h.channels() }));

    expect(seen.map((s) => s.event)).toEqual([
      { kind: 'phase', phase: 'gathering' },
      { kind: 'question', questionId: 'q-7' },
      { kind: 'phase', phase: 'yielding' },
    ]);
    // The question id is surfaced MID-TURN: AFTER its mention annotations exist (the
    // viewer's first fetch finds them), BEFORE gather hits the wire.
    const atQuestion = seen[1]?.wireAt ?? [];
    expect(atQuestion.filter((c) => c === 'mark:create-request')).toHaveLength(2);
    expect(atQuestion).not.toContain('gather:resource-requested');

    const creates = h.payloadsOf('mark:create-request');
    expect(creates).toHaveLength(2);
    const first = (
      creates[0] as {
        request: {
          motivation: string;
          target: { source: string; selector: Array<Record<string, unknown>> };
          body: { type: string; source: string; purpose: string };
        };
      }
    ).request;
    // anchored on the bare name at the composer-supplied span, on the QUESTION resource
    expect(first.motivation).toBe('linking');
    expect(first.target.source).toBe('q-7');
    expect(first.target.selector).toEqual([
      { type: 'TextPositionSelector', start: 8, end: 20 },
      expect.objectContaining({ type: 'TextQuoteSelector', exact: 'Elias Turner' }),
    ]);
    // RESOLVED at creation: a SpecificResource body pointing at the chosen referent
    expect(first.body).toEqual({ type: 'SpecificResource', source: 'doc-elias', purpose: 'linking' });

    // created BEFORE gather, so the referents can ground the retrieval — wire order
    const order = h.channels();
    expect(order.indexOf('mark:create-request')).toBeLessThan(order.indexOf('gather:resource-requested'));
    await h.session.dispose();
  });

  it('anchors on the chip occurrence, not the first textual occurrence of the name', async () => {
    const h = harness({ questionId: 'q-9' });
    // "Iowa" appears as plain prose BEFORE the chip — offsets must win over any search.
    const question = 'Iowa is big. Tell me about Iowa';
    const start = question.lastIndexOf('Iowa');
    const run = chatTurn(h.session, {
      question,
      references: [
        { kind: 'resource' as const, name: 'Iowa', resourceId: 'doc-iowa' as unknown as ResourceId, start, end: start + 4 },
      ],
    });
    await run(() => {});
    const create = (
      h.payloadOf('mark:create-request') as {
        request: { target: { selector: Array<Record<string, unknown>> } };
      }
    ).request;
    expect(create.target.selector[0]).toEqual({ type: 'TextPositionSelector', start, end: start + 4 });
    await h.session.dispose();
  });

  it('states a selector in offsets (code points), not the string’s own positions', async () => {
    const h = harness({ questionId: 'q-10' });
    // The emoji is one code point and two positions of the string, so the chip's
    // position (the composer's) and its offset (the selector's) differ by one.
    const question = '😀 see Iowa';
    const at = question.indexOf('Iowa');
    expect(at).toBe(7);
    const run = chatTurn(h.session, {
      question,
      references: [
        { kind: 'resource' as const, name: 'Iowa', resourceId: 'doc-iowa' as unknown as ResourceId, start: at, end: at + 4 },
      ],
    });
    await run(() => {});
    const create = (
      h.payloadOf('mark:create-request') as {
        request: { target: { selector: Array<Record<string, unknown>> } };
      }
    ).request;
    expect(create.target.selector).toEqual([
      { type: 'TextPositionSelector', start: 6, end: 10 },
      expect.objectContaining({ type: 'TextQuoteSelector', exact: 'Iowa' }),
    ]);
    await h.session.dispose();
  });

  it('skips a mention whose offsets no longer match the sent text (never mis-anchors)', async () => {
    const h = harness({ questionId: 'q-8' });
    const run = chatTurn(h.session, {
      question: 'only Kept here',
      references: [
        { kind: 'resource' as const, name: 'Kept', resourceId: 'doc-kept' as unknown as ResourceId, start: 5, end: 9 },
        { kind: 'resource' as const, name: 'Gone', resourceId: 'doc-gone' as unknown as ResourceId, start: 10, end: 14 },
      ],
    });
    await run(() => {});
    expect(h.payloadsOf('mark:create-request')).toHaveLength(1);
    await h.session.dispose();
  });
});
