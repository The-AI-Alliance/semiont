/**
 * What the worker reads from a model's reply, held to
 * specs/src/worker/parser-cases.json: the table every worker runs, so that one
 * reply is read into the same items, or refused the same way, whichever
 * language read it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isObject, isString, type Logger, type TagSchema, textOffsets } from '@semiont/core';
import { MockInferenceClient, type ElementSchema, type InferenceClient } from '@semiont/inference';
import { AnnotationDetection } from '../workers/annotation-detection';
import { extractEntities } from '../workers/detection/entity-extractor';

type Motivation = 'highlighting' | 'commenting' | 'assessing' | 'tagging' | 'linking';

interface Reply {
  text?: string;
  elements?: unknown[];
  stopReason: string;
}

interface Count {
  text?: string;
  fails?: true;
}

interface Read {
  items: unknown[];
  dropped?: number;
  counted?: number[];
  underReported?: unknown[];
}

interface Refusal {
  name: string;
  stopReason?: string;
}

interface Case {
  why: string;
  motivation: Motivation;
  text: string;
  category?: string;
  entityType?: string;
  reply: Reply;
  count?: Count;
  calls: number;
  countCalls?: number;
  read?: Read;
  refused?: Refusal;
}

const table: { cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/worker/parser-cases.json', import.meta.url), 'utf8'),
);

const LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => LOGGER,
};

/** No reading of the table is cancelled. */
const NEVER = new AbortController().signal;

/** The reply's text: stated, or the JSON of the elements the table states. */
function replyText(reply: Reply): string {
  if (reply.text !== undefined) return reply.text;
  if (reply.elements !== undefined) return JSON.stringify(reply.elements);
  throw new Error('the table gives a reply neither text nor elements');
}

/**
 * The table's stand-in provider. Calls for items go to the package's own
 * `MockInferenceClient`, which reads a reply's text as every provider does;
 * count calls are answered here, and the provider verifies yield exactly when
 * the case scripts a count.
 */
function standIn(reply: Reply, count: Count | undefined) {
  const items = new MockInferenceClient([replyText(reply)], [reply.stopReason]);
  let countCalls = 0;
  const client: InferenceClient = {
    type: items.type,
    modelId: items.modelId,
    maxConcurrency: items.maxConcurrency,
    verifyDetectionYield: count !== undefined,
    limits: () => items.limits(),
    generateText: (prompt, maxTokens, temperature, signal) => items.generateText(prompt, maxTokens, temperature, signal),
    generateTextWithMetadata: async () => {
      countCalls += 1;
      if (count?.text === undefined) throw new Error('the scripted count call fails');
      return { text: count.text, stopReason: 'end_turn' };
    },
    generateStructured: <T>(prompt: string, maxTokens: number, temperature: number, elementSchema: ElementSchema, signal?: AbortSignal) =>
      items.generateStructured<T>(prompt, maxTokens, temperature, elementSchema, signal),
  };
  return { client, calls: () => items.calls.length, countCalls: () => countCalls };
}

/** What a case's one piece handed on. The limits make the text a single piece; more or fewer is a fault of the case. */
function onePiece<T>(pieces: T[]): T {
  if (pieces.length !== 1) throw new Error(`the text was read in ${pieces.length} pieces, where a case is one`);
  return pieces[0]!;
}

function stated(value: string | undefined, field: string): string {
  if (value === undefined) throw new Error(`the table states no ${field} for a case that needs one`);
  return value;
}

/** A schema whose one category is the case's: a tagging call is for a category of a schema, and only the prompt reads the rest. */
function schemaOf(category: string): TagSchema {
  return {
    id: 'case-schema',
    name: 'Case schema',
    description: 'The schema a table case tags against.',
    domain: 'general',
    tags: [{ name: category, description: 'The category a table case tags for.', examples: [] }],
  };
}

const READERS: Record<Motivation, (c: Case, client: InferenceClient) => Promise<Read>> = {
  highlighting: async (c, client) => {
    const pieces: Read[] = [];
    await AnnotationDetection.detectHighlights(
      c.text, textOffsets(c.text), client, LOGGER, NEVER, undefined, undefined, undefined, undefined, undefined,
      async (items, _cursor, dropped) => { pieces.push({ items, dropped }); },
    );
    return onePiece(pieces);
  },
  commenting: async (c, client) => {
    const pieces: Read[] = [];
    await AnnotationDetection.detectComments(
      c.text, textOffsets(c.text), client, LOGGER, NEVER, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      async (items, _cursor, dropped) => { pieces.push({ items, dropped }); },
    );
    return onePiece(pieces);
  },
  assessing: async (c, client) => {
    const pieces: Read[] = [];
    await AnnotationDetection.detectAssessments(
      c.text, textOffsets(c.text), client, LOGGER, NEVER, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      async (items, _cursor, dropped) => { pieces.push({ items, dropped }); },
    );
    return onePiece(pieces);
  },
  tagging: async (c, client) => {
    const category = stated(c.category, 'category');
    const pieces: Read[] = [];
    await AnnotationDetection.detectTags(
      c.text, textOffsets(c.text), client, LOGGER, NEVER, schemaOf(category), category, undefined, undefined, undefined,
      async (items, _cursor, dropped) => { pieces.push({ items, dropped }); },
    );
    return onePiece(pieces);
  },
  linking: async (c, client) => {
    const pieces: Array<{ items: unknown[]; dropped: number }> = [];
    const counted: number[] = [];
    const underReported: unknown[] = [];
    await extractEntities(
      c.text, textOffsets(c.text), [stated(c.entityType, 'entityType')], client, false, LOGGER, NEVER, undefined, undefined,
      (verdict) => { underReported.push(verdict); },
      (count) => { counted.push(count); },
      undefined,
      async (items, _cursor, dropped) => { pieces.push({ items, dropped }); },
    );
    return { ...onePiece(pieces), counted, underReported };
  },
};

/** A failure as the table describes one: its name, and its stop reason where it has one. */
function described(failure: unknown): Refusal {
  if (!isObject(failure) || !isString(failure.name)) throw failure;
  return { name: failure.name, ...(isString(failure.stopReason) ? { stopReason: failure.stopReason } : {}) };
}

describe("reading a model's reply (specs/src/worker/parser-cases.json)", () => {
  it('has cases to run', () => {
    expect(table.cases.length).toBeGreaterThan(0);
  });

  for (const c of table.cases) {
    it(`${c.motivation}: ${c.why}`, async () => {
      const { client, calls, countCalls } = standIn(c.reply, c.count);

      let outcome: { read: Read } | { refused: Refusal };
      try {
        outcome = { read: await READERS[c.motivation](c, client) };
      } catch (failure) {
        outcome = { refused: described(failure) };
      }

      expect(outcome).toEqual(c.refused !== undefined ? { refused: c.refused } : { read: c.read });
      expect(calls()).toBe(c.calls);
      if (c.motivation === 'linking') expect(countCalls()).toBe(c.countCalls);
    });
  }
});
