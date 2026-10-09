/**
 * A worker's offsets count Unicode code points. What is held here is what no
 * case table holds: whole jobs over a text with characters outside the Basic
 * Multilingual Plane, where a count of code points and a count of a string's
 * UTF-16 code units are different numbers.
 *
 * The walk's own cases are in specs/src/worker/chunk-plan-cases.json, the
 * builder's in specs/src/annotations/builder-cases.json.
 */

import { describe, it, expect } from 'vitest';
import { annotationOfSpan, entityType, resourceId, textOffsets, type Annotation, type Logger } from '@semiont/core';
import type { ElementSchema, InferenceClient, InferenceResponse, StructuredResponse } from '@semiont/inference';
import {
  processCommentJob,
  processHighlightJob,
  processReferenceJob,
  type BuildAnnotation,
  type ProcessorResult,
  type UnitCheckpoint,
} from '../processors';

const RID = resourceId('res-1');
const GENERATOR = { '@type': 'Software' as const, '@id': 'did:web:kb.example:agents:ollama:gemma3', name: 'gemma3', provider: 'ollama', model: 'gemma3' };

const LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => LOGGER,
};

/** No job here is cancelled. */
const NEVER = new AbortController().signal;

/** What a processor that ran to its end returned. */
function ran<R>(outcome: ProcessorResult<R>): { result: R } {
  if ('cancelled' in outcome) throw new Error('the processor was stopped by a cancellation');
  return outcome;
}

/** A text's code points, one to an element: what an offset counts. */
const codePoints = (text: string): string[] => Array.from(text);

/**
 * A provider that answers what it was scripted to, in order, and fails a call
 * no script foresaw: a walk that asks once too often is a failure here, not a
 * repeat of the last answer.
 */
function scripted(contextTokens: number, answers: unknown[][]): InferenceClient & { prompts: string[] } {
  const prompts: string[] = [];
  const unscripted = (): never => { throw new Error('the job asked its model for something no script foresaw'); };
  return {
    prompts,
    type: 'scripted',
    modelId: 'scripted-1',
    maxConcurrency: 1,
    verifyDetectionYield: false,
    limits: async () => ({ contextTokens, maxOutputTokens: contextTokens }),
    generateText: async (): Promise<string> => unscripted(),
    generateTextWithMetadata: async (): Promise<InferenceResponse> => unscripted(),
    generateStructured: async <T>(prompt: string, _maxTokens: number, _temperature: number, _schema: ElementSchema): Promise<StructuredResponse<T>> => {
      const answer = answers[prompts.length];
      prompts.push(prompt);
      if (answer === undefined) throw new Error(`the job asked its model a ${prompts.length}th time, for a piece no script foresaw`);
      return { items: answer as T[], stopReason: 'end_turn' };
    },
  };
}

/** Sixty sentences, each with two emoji: 2,330 code points, 2,450 UTF-16 code units. */
const LONG = Array.from({ length: 60 }, (_, i) => `😀 Sentence ${i + 1} of the survey 🎉 is here.`).join(' ');

/** A text builder for `text`, as a job is handed one. */
const textBuild = (text: string): BuildAnnotation =>
  (motivation, span, body) => annotationOfSpan({ text, resourceId: RID, generator: GENERATOR, motivation, span, body });

describe('a job over a long text with characters outside the Basic Multilingual Plane', () => {
  it('is that many code points, and fewer than its string is long', () => {
    expect(codePoints(LONG).length).toBe(2330);
    expect(LONG.length).toBe(2450);
  });

  it('ends: its walk stops at the text\'s length in code points, and asks about no piece after it', async () => {
    // Three pieces at this window. Each finds nothing, so nothing here rests on the builder.
    const client = scripted(1200, [[], [], []]);
    const cursors: number[] = [];
    const progress: Array<[number, string]> = [];

    const { result } = ran(await processHighlightJob(
      LONG, textOffsets(LONG), client, { motivation: 'highlighting', resourceId: RID }, textBuild(LONG),
      (percentage, message) => { progress.push([percentage, message.code]); }, LOGGER, NEVER,
      async (_annotations: Annotation[], checkpoint: UnitCheckpoint) => { cursors.push(checkpoint.cursor.next); },
    ));

    // One request for each piece, and none for an empty one past the end.
    expect(client.prompts.length).toBe(3);
    // Each piece is 311 tokens, 1,244 code points at most, ended at a sentence's
    // end; the next starts 256 code points before. The last cursor is the
    // text's length in code points.
    expect(cursors).toEqual([982, 1957, 2330]);
    expect(result).toEqual({ found: 0, persisted: 0 });

    // How far through the text each next piece starts is a ratio of offsets,
    // of the cursor to the text's length in code points: 30 + round(30 × 982 / 2330)
    // and 30 + round(30 × 1957 / 2330). Against 2,450 they would be 42 and 54.
    const analyzing = progress.filter(([, code]) => code === 'analyzing').map(([percentage]) => percentage);
    expect(analyzing).toEqual([30, 43, 55]);
  });

  it('asks nothing for a cursor past the text\'s end, though a string of the text goes on beyond it', async () => {
    // 2,400 is past the text's 2,330 code points and short of its string's
    // 2,450 units. There is no text there to cut: the unit asks nothing, and
    // its counts are what the cursor held.
    const client = scripted(1200, []);
    const cursors: number[] = [];

    const { result } = ran(await processHighlightJob(
      LONG, textOffsets(LONG), client, { motivation: 'highlighting', resourceId: RID }, textBuild(LONG),
      () => {}, LOGGER, NEVER,
      async (_annotations: Annotation[], checkpoint: UnitCheckpoint) => { cursors.push(checkpoint.cursor.next); },
      { highlighting: { next: 2400, size: 311, found: 7, emitted: 5, errors: 1 } },
    ));

    expect(client.prompts).toEqual([]);
    expect(cursors).toEqual([]);
    expect(result).toEqual({ found: 7, persisted: 5, errors: 1 });
  });

  it('anchors a span after an emoji at a count of code points, in every piece that sees it', async () => {
    const exact = 'Sentence 31 of the survey';
    const client = scripted(1200, [[{ exact }], [{ exact }], []]);
    const committed: Annotation[] = [];

    const { result } = ran(await processHighlightJob(
      LONG, textOffsets(LONG), client, { motivation: 'highlighting', resourceId: RID }, textBuild(LONG),
      () => {}, LOGGER, NEVER,
      async (annotations: Annotation[]) => { committed.push(...annotations); },
    ));

    // Two pieces proposed it; it is one annotation.
    expect(result).toEqual({ found: 2, persisted: 1 });
    expect(committed.length).toBe(1);
    const selectors = (committed[0]!.target as { selector: Array<{ type: string; start?: number; end?: number; exact?: string }> }).selector;
    const position = selectors.find((s) => s.type === 'TextPositionSelector')!;
    // The text between the two offsets, counted in code points, is the quote.
    expect(codePoints(LONG).slice(position.start, position.end).join('')).toBe(exact);
    // And they are not the string's own positions: sixty-one emoji stand before the span.
    expect(position.start).toBe(1163);
    expect(LONG.indexOf(exact)).toBe(1163 + 61);
  });
});

describe('a job over a short text with a character outside the Basic Multilingual Plane', () => {
  const TEXT = '😀 Ada Lovelace wrote the first algorithm 🎉 in London.';

  it('commenting: the selector counts code points, and the quote\'s context is the text\'s own', async () => {
    const client = scripted(8192, [[{ exact: 'London', comment: 'A city.' }]]);
    const committed: Annotation[] = [];

    ran(await processCommentJob(
      TEXT, textOffsets(TEXT), client, { motivation: 'commenting', resourceId: RID }, textBuild(TEXT),
      () => {}, LOGGER, NEVER,
      async (annotations: Annotation[]) => { committed.push(...annotations); },
    ));

    expect(committed.length).toBe(1);
    expect((committed[0]!.target as { selector: unknown[] }).selector).toEqual([
      { type: 'TextPositionSelector', start: 46, end: 52 },
      { type: 'TextQuoteSelector', exact: 'London', prefix: '😀 Ada Lovelace wrote the first algorithm 🎉 in ', suffix: '.' },
    ]);
  });

  it('linking: a mention after an emoji is found where it is, and built', async () => {
    const client = scripted(8192, [[{ exact: 'Ada Lovelace', entityType: 'Person' }]]);
    const committed: Annotation[] = [];
    const cursors: number[] = [];

    const { result } = ran(await processReferenceJob(
      TEXT, textOffsets(TEXT), client, { motivation: 'linking', resourceId: RID, entityTypes: [entityType('Person')] }, textBuild(TEXT),
      () => {}, LOGGER, NEVER, async () => {},
      async (annotations: Annotation[], checkpoint: UnitCheckpoint) => { committed.push(...annotations); cursors.push(checkpoint.cursor.next); },
    ));

    expect(result).toEqual({ found: 1, persisted: 1 });
    expect((committed[0]!.target as { selector: unknown[] }).selector).toEqual([
      { type: 'TextPositionSelector', start: 2, end: 14 },
      { type: 'TextQuoteSelector', exact: 'Ada Lovelace', prefix: '😀 ', suffix: ' wrote the first algorithm 🎉 in London.' },
    ]);
    // The unit's cursor ends at the text's length in code points: 53, where the string is 55 long.
    expect(cursors).toEqual([53]);
    expect(TEXT.length).toBe(55);
  });
});
