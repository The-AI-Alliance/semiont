/**
 * Slice a batch into round trips, bound each one, and keep them in order.
 *
 * Both providers had the same defect and must get the same fix, so the fix lives
 * once: `ollama.ts` and `voyage.ts` supply only what genuinely differs — their
 * policy values and how to post one slice — and agree on the rest by
 * construction rather than by two people remembering the same shape.
 *
 * Three properties this owns, each of which is silent when wrong:
 *
 *  - **Order.** The smelter maps embeddings back to chunks positionally
 *    (`smelter.ts:617`), so a reordering corrupts the index without erroring.
 *    `Promise.all` preserves array order regardless of completion order.
 *  - **The deadline is per round trip.** `post` builds its own `AbortSignal`
 *    INSIDE the gated thunk, so a slice that queued behind others still gets a
 *    whole budget. Hoisting that signal out would rebuild the original cliff one
 *    layer up, invisibly — the timeout would start ticking while the slice was
 *    still waiting for a slot.
 *  - **Failure says where.** A rejecting slice carries the index and the range it
 *    covered. That is for DIAGNOSIS: indexing stays all-or-nothing per resource,
 *    because a partially-indexed resource reads as fresh to reconcile
 *    (`smelter.ts:861` compares the stamp's checksum, which the landed chunks
 *    carry correctly) and would therefore never heal.
 *
 * Every slice is submitted at once; the gate — held on the provider INSTANCE, so
 * it is shared with every other caller — decides how many actually run.
 */

import type { BatchPolicy } from '@semiont/core';
import { EmbeddingProviderError, type EmbeddingProviderName } from './provider-error';

export interface SliceRef {
  index: number;
  start: number;
  end: number;
}

export interface SlicedBatchOptions {
  texts: string[];
  policy: BatchPolicy;
  provider: EmbeddingProviderName;
  model: string;
  /** Runs the work under the provider's instance-wide concurrency gate. */
  gate: <T>(work: () => Promise<T>) => Promise<T>;
  /** Posts ONE slice. Must create its own timeout signal so the deadline starts here. */
  post: (slice: string[]) => Promise<number[][]>;
}

export async function slicedEmbed(opts: SlicedBatchOptions): Promise<number[][]> {
  const { texts, policy, provider, model, gate, post } = opts;

  const refs: SliceRef[] = [];
  for (let start = 0; start < texts.length; start += policy.sliceSize) {
    refs.push({ index: refs.length, start, end: Math.min(start + policy.sliceSize, texts.length) });
  }

  const perSlice = await Promise.all(
    refs.map((ref) =>
      gate(async () => {
        try {
          return await post(texts.slice(ref.start, ref.end));
        } catch (error) {
          throw withSlice(error, ref, provider, model);
        }
      }),
    ),
  );

  return perSlice.flat();
}

/**
 * Attach the slice to whatever failed.
 *
 * An HTTP failure already arrives typed and keeps its status. Anything else —
 * a timeout, a socket reset — has no status at all, so it gets
 * `NO_HTTP_RESPONSE` rather than a plausible-looking number: a manufactured
 * status is a lie the next reader cannot detect, and `isColdModelError` reads
 * this field.
 */
function withSlice(error: unknown, slice: SliceRef, provider: EmbeddingProviderName, model: string): Error {
  if (error instanceof EmbeddingProviderError) {
    return new EmbeddingProviderError(provider, error.status, model, error.body, slice);
  }
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new EmbeddingProviderError(provider, NO_HTTP_RESPONSE, model, reason, slice);
}

/** No HTTP response happened at all — a timeout or a transport failure. */
export const NO_HTTP_RESPONSE = 0;
