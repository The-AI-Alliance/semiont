/**
 * The limits report — how the services that hold inference credentials tell
 * everyone else what their models can do.
 *
 * The worker and the librarian are the only services with an inference key,
 * so they are the only ones that can discover a model's ceilings from its
 * provider. Each answers a limits request for its own (provider, model) pairs:
 * the worker on `job:limits-requested`, the librarian on
 * `gather:limits-requested` and `match:limits-requested`. Clients join the
 * replies to the collaborator directory.
 *
 * The only storage is the clients' own: `limits()` single-flights and caches
 * success, and clears its promise on failure so a briefly-down provider
 * recovers on a later request. A report never fails and never blocks on a
 * provider: a rejected or over-budget consult leaves that pair out.
 */

import type { Subscription } from 'rxjs';
import { BUS_OPERATIONS, type FrameSink, type FrameSource, type LimitsOperation, type Logger, type components } from '@semiont/core';
import type { InferenceClient } from './interface';

type InferenceLimits = components['schemas']['InferenceLimits'];
type InferencePairLimits = components['schemas']['InferencePairLimits'];

/**
 * Per-request ceiling on ONE pair's consult. The discovery calls carry no
 * request timeout of their own, so an unraced await would let one hung
 * provider hold every reply. Nothing is wasted by losing the race: the
 * client's single-flight discovery keeps running, and the next request
 * reports its cached result.
 */
export const LIMITS_REPORT_BUDGET_MS = 1_500;

/** A client this service holds: its provider, its model, and its discovery. */
export type LimitsSource = Pick<InferenceClient, 'type' | 'modelId' | 'limits'>;

/** One consult, bounded. Resolves undefined on any miss: over budget or rejected. */
async function consult(source: LimitsSource, budgetMs: number, logger: Logger): Promise<InferenceLimits | undefined> {
  const pair = `${source.type} ${source.modelId}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const discovery = source.limits();
    const raced = await Promise.race([
      discovery,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), budgetMs); }),
    ]);
    if (raced === undefined) {
      // Detach so a late rejection is not an unhandled rejection; the
      // single-flight discovery itself keeps running.
      void discovery.catch(() => {});
      logger.debug('Limits report: consult exceeded budget — pair left out', { pair, budgetMs });
      return undefined;
    }
    // Exactly what the wire schema declares: the provider type also carries
    // `outputTokensPerHour`, a rate-limiter input with no consumer on the
    // wire. This is a mirror of InferenceLimits.json; limits-report.test.ts
    // fails when the schema grows a property this does not carry.
    return {
      contextTokens: raced.contextTokens,
      maxOutputTokens: raced.maxOutputTokens,
      // Optional on the wire: absent means "no claim", so only a measured
      // verdict is attached.
      ...(raced.acceptsTemperature !== undefined ? { acceptsTemperature: raced.acceptsTemperature } : {}),
    };
  } catch (error) {
    logger.debug('Limits report: consult failed — pair left out', {
      pair,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The discovered limits of each distinct pair, in the order given; a pair that misses is left out. */
export async function reportLimits(
  sources: readonly LimitsSource[],
  logger: Logger,
  budgetMs: number = LIMITS_REPORT_BUDGET_MS,
): Promise<InferencePairLimits[]> {
  const distinct = new Map<string, LimitsSource>();
  for (const source of sources) {
    const pair = `${source.type} ${source.modelId}`;
    if (!distinct.has(pair)) distinct.set(pair, source);
  }
  const consulted = await Promise.all(
    [...distinct.values()].map(async (source) => ({ source, limits: await consult(source, budgetMs, logger) })),
  );
  return consulted.flatMap(({ source, limits }) =>
    limits ? [{ provider: source.type, model: source.modelId, limits }] : []);
}

/**
 * Answer `operation` on `bus` for `sources`: each request is replied to on the
 * operation's result channel, with its correlation id.
 */
export function answerLimitsRequests(
  bus: FrameSource & FrameSink,
  operation: LimitsOperation,
  sources: readonly LimitsSource[],
  logger: Logger,
): Subscription {
  const { result, failure } = BUS_OPERATIONS[operation];
  return bus.frames(operation).subscribe((frame) => {
    void reportLimits(sources, logger)
      .then((limits) => bus.emit(result, { response: { limits } }, { correlationId: frame.correlationId }))
      .catch((error: unknown) => {
        logger.error('Limits report failed', { operation, error: error instanceof Error ? error.message : String(error) });
        return bus.emit(failure, { message: error instanceof Error ? error.message : String(error) }, { correlationId: frame.correlationId });
      });
  });
}
