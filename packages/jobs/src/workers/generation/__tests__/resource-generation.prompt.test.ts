import { describe, it, expect, vi } from 'vitest';
import type { InferenceClient } from '@semiont/inference';
import type { GatheredContext, Logger } from '@semiont/core';
import { generateResourceFromTopic } from '../resource-generation';

/**
 * Prompt-content spec for the generation builder.
 *
 * `processors.test.ts` mocks `generateResourceFromTopic` wholesale, so the
 * prompt the worker actually sends to inference is otherwise untested. These
 * tests call the real builder against a mocked `InferenceClient` and inspect
 * the prompt string captured at the `generateText` boundary.
 *
 * Target behavior (.plans/SEMANTIC-CONTEXT-RAG.md): the builder must consume
 * `context.semanticContext.similar` — the vector matches the gather flow
 * already produced — as a "Related passages from the knowledge base" section,
 * capped at top-3 by score and truncated to 240 chars per passage.
 */

type SemanticMatch = NonNullable<GatheredContext['semanticContext']>['similar'][number];

function makeInferenceClient(): InferenceClient {
  // Resolve a real markdown string so the builder's parse step completes and
  // we can inspect the captured prompt. House mock pattern (see processors.test.ts).
  return {
    generateText: vi.fn().mockResolvedValue('# Generated\nbody'),
  } as unknown as InferenceClient;
}

const LOGGER = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => LOGGER),
} as unknown as Logger;

/**
 * Minimal context. `annotation.motivation` and `sourceResource.name` are read
 * unconditionally by the builder's annotation section, so they must be present
 * even when the test only cares about `semanticContext`.
 */
function makeContext(similar?: SemanticMatch[]): GatheredContext {
  const ctx: Record<string, unknown> = {
    annotation: { motivation: 'linking' },
    sourceResource: { name: 'Source Doc' },
  };
  if (similar) ctx.semanticContext = { similar };
  return ctx as unknown as GatheredContext;
}

/** The prompt string the builder handed to inference (first arg of generateText). */
function promptArg(client: InferenceClient): string {
  return vi.mocked(client.generateText).mock.calls[0][0];
}

describe('generateResourceFromTopic — semanticContext in the prompt', () => {
  // Lead axiom — promoted from it.fails once the consumer landed (Phase 2). The
  // gathered passages must reach the prompt under a recognizable header.
  it('embeds semanticContext passages into the generation prompt', async () => {
    const client = makeInferenceClient();
    const context = makeContext([{ text: 'NEEDLE-PASSAGE', resourceId: 'r1', score: 0.82 }]);

    await generateResourceFromTopic('Topic', [], client, LOGGER, undefined, undefined, context);

    const prompt = promptArg(client);
    expect(prompt).toContain('NEEDLE-PASSAGE');
    expect(prompt).toMatch(/related passages/i);
  });

  // Guard — GREEN-unpinned. No semanticContext ⇒ no section, no empty header.
  it('omits the related-passages section when semanticContext is absent', async () => {
    const client = makeInferenceClient();
    const context = makeContext();

    await generateResourceFromTopic('Topic', [], client, LOGGER, undefined, undefined, context);

    expect(promptArg(client)).not.toMatch(/related passages/i);
  });

  // Guard — GREEN-unpinned. Empty match set ⇒ section omitted, same as graphContext.
  it('omits the related-passages section when similar is empty', async () => {
    const client = makeInferenceClient();
    const context = makeContext([]);

    await generateResourceFromTopic('Topic', [], client, LOGGER, undefined, undefined, context);

    expect(promptArg(client)).not.toMatch(/related passages/i);
  });

  // Cost-guard axiom — promoted from it.fails alongside the lead axiom. Cap at
  // top-3 by score; truncate each passage to 240 chars.
  it('caps related passages at top-3 by score and truncates long passages', async () => {
    const client = makeInferenceClient();
    const long = 'X'.repeat(400);
    const context = makeContext([
      { text: 'p-low-1', resourceId: 'r', score: 0.10 },
      { text: 'p-low-2', resourceId: 'r', score: 0.11 },
      { text: 'p-mid', resourceId: 'r', score: 0.50 },
      { text: 'p-hi', resourceId: 'r', score: 0.90 },
      { text: long, resourceId: 'r', score: 0.95 },
    ]);

    await generateResourceFromTopic('Topic', [], client, LOGGER, undefined, undefined, context);

    const prompt = promptArg(client);
    // Top-3 by score kept (0.95, 0.90, 0.50); the two lowest dropped.
    expect(prompt).toContain('p-hi');
    expect(prompt).toContain('p-mid');
    expect(prompt).not.toContain('p-low-1');
    expect(prompt).not.toContain('p-low-2');
    // Truncated: the 240-char prefix is present, the full 400-char passage is not.
    expect(prompt).toContain('X'.repeat(240));
    expect(prompt).not.toContain(long);
  });
});
