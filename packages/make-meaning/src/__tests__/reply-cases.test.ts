/**
 * What the Librarian reads from a model's reply, held to
 * specs/src/librarian/reply-cases.json.
 *
 * The suggestions are read by a function, which is called. The scores are
 * read inside the Matcher, so each case is a search over its bus with the
 * case's reply as the model's answer, and the scores are seen where a caller
 * sees them: in the results. A candidate here scores nothing before the
 * model is asked, and a score read for it adds 25 times itself, so a
 * candidate's score in the results is 25 times what was read for it. A score
 * of 0 that was read and a candidate with no score read look the same there:
 * what tells them apart is the count of scores read, which the Matcher logs.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { firstValueFrom } from 'rxjs';
import { EventBus, annotationId, resourceId, type GatheredContext, type Logger, type ResourceDescriptor } from '@semiont/core';
import { validators, formatErrors } from '@semiont/core/openapi';
import { MockInferenceClient } from '@semiont/inference';
import { Matcher, type MatcherStores } from '../matcher';
import { generateReferenceSuggestions } from '../generation/resource-generation';
import { createMockEmbeddingProvider } from './helpers/embedding-provider';

type Case = { why: string; reply: string } & (
  | { reader: 'scores'; candidates: number; scores: Array<{ candidate: number; score: number }> }
  | { reader: 'suggestions'; suggestions: string[] | null }
);

const table: { cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/librarian/reply-cases.json', import.meta.url), 'utf8'),
);

/** What a score read for a candidate adds to its score in the results. */
const WEIGHT_OF_A_READ_SCORE = 25;

const candidateId = (number: number): string => `cand-${number}`;

/**
 * A search whose name search answers `count` candidates, numbered from 1 in
 * the order the prompt lists them, and whose model answers `reply`. None has
 * a name the search term is part of, an entity type, a date or a connection.
 */
async function searchAnsweredWith(reply: string, count: number): Promise<{
  scoreOf: (candidate: number) => number | undefined;
  debug: ReturnType<typeof vi.fn>;
}> {
  const main = resourceId('res-source');
  const candidates: ResourceDescriptor[] = Array.from({ length: count }, (_, i) => ({
    '@context': 'https://schema.org/',
    '@id': resourceId(candidateId(i + 1)),
    name: `Candidate ${i + 1}`,
    representations: [],
  }));

  const context: GatheredContext = {
    focus: {
      kind: 'annotation',
      annotation: {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        id: annotationId('ann-reference'),
        motivation: 'linking',
        created: '2026-01-01T00:00:00.000Z',
        target: { source: main },
      },
      sourceResource: { '@context': 'https://schema.org/', '@id': main, name: 'Greek Myths', representations: [] },
      selected: { text: 'Zeus' },
    },
    graph: { nodes: [{ id: main, type: 'resource', label: 'Greek Myths' }], edges: [] },
    metadata: {},
  };

  const request = { resourceId: main, referenceId: annotationId('ann-reference'), context };
  const validate = validators.MatchSearchRequest;
  if (!validate(request)) throw new Error(`the search is not one the bus carries: ${formatErrors(validate.errors)}`);

  const stores: MatcherStores = {
    graph: {
      listResources: async (filter) => {
        const resources = filter.search === undefined ? [] : candidates;
        return { resources, total: resources.length };
      },
      getResource: async () => null,
    },
    views: { get: async () => null },
    vectors: { searchResources: async () => [] },
  };

  const debug = vi.fn();
  const logger: Logger = { debug, info: () => {}, warn: () => {}, error: () => {}, child: () => logger };

  const bus = new EventBus();
  const matcher = new Matcher(stores, bus, logger, new MockInferenceClient([reply]), createMockEmbeddingProvider());
  await matcher.initialize();
  try {
    const answered = firstValueFrom(bus.on('match:search-results'));
    const failed = firstValueFrom(bus.on('match:search-failed')).then(({ error }) => {
      throw new Error(`the search failed: ${error}`);
    });
    bus.emit('match:search-requested', request, { correlationId: 'reply-case' });
    const { response } = await Promise.race([answered, failed]);
    return {
      scoreOf: (candidate) => response.find((scored) => scored['@id'] === candidateId(candidate))?.score,
      debug,
    };
  } finally {
    await matcher.stop();
    bus.destroy();
  }
}

describe("what the Librarian reads from a model's reply (specs/src/librarian/reply-cases.json)", () => {
  it('has cases', () => {
    expect(table.cases.length).toBeGreaterThan(0);
  });

  for (const c of table.cases) {
    if (c.reader === 'scores') {
      it(`scores: ${c.why}`, async () => {
        const { scoreOf, debug } = await searchAnsweredWith(c.reply, c.candidates);

        const read = new Map(c.scores.map(({ candidate, score }) => [candidate, score]));
        for (let candidate = 1; candidate <= c.candidates; candidate++) {
          expect(scoreOf(candidate), `candidate ${candidate}`).toBeCloseTo(WEIGHT_OF_A_READ_SCORE * (read.get(candidate) ?? 0), 6);
        }
        expect(debug).toHaveBeenCalledWith('Inference semantic scores', {
          candidateCount: c.candidates,
          scoredCount: c.scores.length,
        });
      });
    } else {
      it(`suggestions: ${c.why}`, async () => {
        const client = new MockInferenceClient([c.reply]);
        expect(await generateReferenceSuggestions({ title: 'Black Hawk' }, client)).toStrictEqual(c.suggestions);
      });
    }
  }
});
