/**
 * About how many tokens a text is.
 *
 * A text's length counts Unicode code points, as a text offset does.
 * specs/src/text/chunk-cases.json states the estimate of each of its texts
 * (`estimatedTokens`): it is the count a chunker sizes a chunk by.
 */

import { textOffsets } from './text-offsets';

/** The heuristic: about four code points to a token, for English text. */
const CODE_POINTS_PER_TOKEN = 4;

/**
 * Rough token count estimate: a text's length in code points, divided by
 * four and rounded up.
 *
 * The single token-estimation heuristic: the budget arithmetic of an
 * inference call uses it, so that an estimate and a chunk's size agree.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(textOffsets(text).length / CODE_POINTS_PER_TOKEN);
}
