/**
 * What the librarian cases share: texts to record, and how a case reads what
 * a model stand-in was sent.
 */
import type { StandInOllama } from '../harness/ollama';

/** A text every word of which occurs once, so a case can annotate any of them by quoting it. */
export const FOX = 'The quick brown fox jumps over the lazy dog.\n';

/** A second text, which shares no word of four letters or more with the first. */
export const TIDE = 'Twice each day high water floods a salt marsh.\n';

/** The prompts a model stand-in was sent since the case began, in the order they arrived. */
export function prompts(model: StandInOllama): string[] {
  return model.generations.map((generation) => String(generation.body['prompt']));
}
