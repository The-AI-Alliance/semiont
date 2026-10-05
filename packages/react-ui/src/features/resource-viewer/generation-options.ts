import type { GenerationOptions } from '@semiont/sdk';
import type { GenerationConfig } from '../../components/modals/ConfigureGenerationStep';

/**
 * The submitted form config becomes generation options — in ONE place, by
 * spread.
 *
 * Built field-by-field, a knob the list does not mention is silently
 * dropped on the way to the wire. Spreading means the default is
 * "forwarded"; only the two genuine transformations are spelled out:
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
