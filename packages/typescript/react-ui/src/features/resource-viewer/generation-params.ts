import type { GenerationJobParams } from '@semiont/core';
import type { GenerationConfig } from '../../components/modals/ConfigureGenerationStep';

/**
 * The submitted form config becomes the generation job's params — in ONE
 * place, by spread.
 *
 * Built field-by-field, a knob the list does not mention is silently
 * dropped on the way to the wire. Spreading means the default is
 * "forwarded"; only the one genuine transformation is spelled out:
 * `sourceLanguage` joins — the language of the resource being VIEWED, which
 * the form cannot know and the page can. Omitted entirely when unknown, so
 * absence stays absence rather than becoming `''`.
 */
export function toGenerationParams(
  config: GenerationConfig,
  sourceLanguage: string | undefined,
): GenerationJobParams {
  return {
    ...config,
    ...(sourceLanguage ? { sourceLanguage } : {}),
  };
}
