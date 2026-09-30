/**
 * The limits report: each service that holds inference credentials — the
 * worker, the librarian — reports the discovered ceilings of its own
 * (provider, model) pairs, and nothing else needs a key to show them.
 *
 * The contract from every failure direction: the reply never fails and never
 * blocks on a provider. A rejecting discovery and a HANGING discovery both
 * leave that pair out, while healthy pairs still report. Recovery is pinned
 * too: a failed pair is consulted again on a later request (the real clients
 * deliberately clear their single-flight promise on rejection; the report
 * must not defeat that by remembering failures itself).
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { firstValueFrom, race, timer, map, take } from 'rxjs';
import { EventBus, type Logger, type components } from '@semiont/core';
import { answerLimitsRequests, reportLimits, type LimitsSource } from '../limits-report';

type InferenceLimits = components['schemas']['InferenceLimits'];

const logger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: () => logger,
};

const LIMITS_A: InferenceLimits = { contextTokens: 200_000, maxOutputTokens: 64_000 };
const LIMITS_B: InferenceLimits = { contextTokens: 8_192, maxOutputTokens: 8_192 };

const source = (type: string, modelId: string, limits: () => Promise<InferenceLimits>): LimitsSource =>
  ({ type, modelId, limits });

/**
 * CENSUS GATE — the projection in `limits-report.ts` is a hand-written mirror
 * of `InferenceLimits.json`, so it drifts silently. It already did once:
 * `acceptsTemperature` was added to the schema and to the provider type and
 * dropped in the projection, which left the Creativity slider showing on a
 * model that rejects `temperature`.
 *
 * This reads the SPEC, not a second list, so a property added to the schema
 * fails here until the projection carries it.
 */
describe('the projection carries the whole wire schema', () => {
  it('reports every property InferenceLimits.json declares, and nothing else', async () => {
    const schema = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../../specs/src/components/schemas/InferenceLimits.json', import.meta.url)),
        'utf8',
      ),
    ) as { properties: Record<string, unknown> };
    const declared = Object.keys(schema.properties);

    // A discovery answer carrying every declared property, plus the
    // provider-only field the projection is supposed to drop.
    const full: Record<string, unknown> = {
      contextTokens: 200_000,
      maxOutputTokens: 64_000,
      acceptsTemperature: false,
      outputTokensPerHour: 1_000_000,
    };
    for (const key of declared) {
      expect(
        Object.prototype.hasOwnProperty.call(full, key),
        `InferenceLimits.json declares "${key}" — add it to this fixture and to the projection in limits-report.ts`,
      ).toBe(true);
    }

    const [pair] = await reportLimits([source('anthropic', 'model-a', async () => full as never)], logger);
    const reported = Object.keys(pair?.limits ?? {});

    expect(reported.sort()).toEqual(declared.sort());
    expect(reported).not.toContain('outputTokensPerHour');
  });
});

describe('reportLimits', () => {
  it('reports each pair it holds a client for', async () => {
    const report = await reportLimits([
      source('anthropic', 'model-a', async () => LIMITS_A),
      source('ollama', 'model-b', async () => LIMITS_B),
    ], logger);

    expect(report).toEqual([
      { provider: 'anthropic', model: 'model-a', limits: LIMITS_A },
      { provider: 'ollama', model: 'model-b', limits: LIMITS_B },
    ]);
  });

  it('reports a pair once, however many clients hold it', async () => {
    const report = await reportLimits([
      source('anthropic', 'model-a', async () => LIMITS_A),
      source('anthropic', 'model-a', async () => LIMITS_A),
    ], logger);

    expect(report).toHaveLength(1);
  });

  it('a rejecting discovery leaves that pair out; healthy pairs still report', async () => {
    const report = await reportLimits([
      source('anthropic', 'model-a', async () => LIMITS_A),
      source('ollama', 'model-b', () => Promise.reject(new Error('provider briefly down'))),
    ], logger);

    expect(report.map((p) => p.model)).toEqual(['model-a']);
  });

  it('a failed pair is consulted again, and reports once it recovers', async () => {
    let down = true;
    const sources = [source('ollama', 'model-b', () => (down ? Promise.reject(new Error('down')) : Promise.resolve(LIMITS_B)))];

    expect(await reportLimits(sources, logger)).toEqual([]);
    down = false;
    expect(await reportLimits(sources, logger)).toEqual([{ provider: 'ollama', model: 'model-b', limits: LIMITS_B }]);
  });

  it('a hanging discovery does not hold the report — bounded by the budget', async () => {
    const report = await reportLimits([
      source('anthropic', 'model-a', async () => LIMITS_A),
      source('ollama', 'model-b', () => new Promise<InferenceLimits>(() => { /* never settles */ })),
    ], logger, 40);

    expect(report.map((p) => p.model)).toEqual(['model-a']);
  });
});

describe('answerLimitsRequests', () => {
  it('answers each limits operation on its own result channel, with the request\'s correlation id', async () => {
    for (const operation of ['job:limits-requested', 'gather:limits-requested', 'match:limits-requested'] as const) {
      const bus = new EventBus();
      const subscription = answerLimitsRequests(bus, operation, [source('anthropic', 'model-a', async () => LIMITS_A)], logger);
      try {
        const resultChannel = operation.replace('-requested', '-result') as 'job:limits-result';
        const reply = firstValueFrom(
          race(
            bus.frames(resultChannel),
            timer(500).pipe(map((): never => { throw new Error(`no reply on ${resultChannel}`); })),
          ).pipe(take(1)),
        );
        bus.emit(operation, {}, { correlationId: 'cid-1' });
        const frame = await reply;

        expect(frame.correlationId).toBe('cid-1');
        expect(frame.payload.response.limits).toEqual([{ provider: 'anthropic', model: 'model-a', limits: LIMITS_A }]);
      } finally {
        subscription.unsubscribe();
        bus.destroy();
      }
    }
  });
});
