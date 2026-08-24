import type { GenerationOptions } from '@semiont/sdk';
import type { GenerationConfig } from '../../components/modals/ConfigureGenerationStep';

/**
 * The submitted form config becomes generation options — in ONE place, by
 * spread (GENERATION-OUTPUT-FORMAT D8).
 *
 * Both page handlers previously built this object field-by-field, so a knob
 * the list didn't mention was silently dropped on the way to the wire. That
 * is exactly how `outputMediaType` came to be unreachable one layer down
 * (P1's finding), and copying the pattern here would have re-created it for
 * every future knob. Spreading means the default is "forwarded"; only the two
 * genuine transformations are spelled out:
 *
 * - `context` leaves the bag — it is `fromContext`'s positional argument.
 * - `sourceLanguage` joins it — the language of the resource being VIEWED,
 *   which the form cannot know and the page can. Omitted entirely when
 *   unknown, so absence stays absence rather than becoming `''`.
 */
export function toGenerationOptions(
  config: GenerationConfig,
  sourceLanguage: string | undefined,
): GenerationOptions {
  const { context: _positional, ...options } = config;
  return {
    ...options,
    ...(sourceLanguage ? { sourceLanguage } : {}),
  };
}
