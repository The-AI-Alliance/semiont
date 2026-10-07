/**
 * What a worker is handed, typed from the spec.
 *
 * The spec states a job description (`MarkJobParams`, `GenerationJobParams`)
 * and what the Dispatcher adds to the params of a job it holds (`JobParams`),
 * and leaves the held shape open. The types here are the two put together,
 * for the code that runs a job.
 */

import type { components } from '@semiont/core';

type MarkJobParams = components['schemas']['MarkJobParams'];
/** A job's params as the Dispatcher holds them: an open object that names what the Dispatcher adds. */
type JobParams = components['schemas']['JobParams'];

/** The motivations a `mark` job has. */
export type MarkMotivation = MarkJobParams['motivation'];

/**
 * A `mark` job's params as whoever holds the job is handed them: the
 * description's own for that motivation, and what the Dispatcher adds — the
 * resource the job is about and, for tagging, the schema its `schemaId` names.
 * `JobParams` names both additions, so each is taken from it under its own
 * name. The description's five schemas state the rest, `language` and
 * `sourceLanguage` among them.
 */
export type HeldMarkParams<M extends MarkMotivation> =
  Extract<MarkJobParams, { motivation: M }>
  & Pick<JobParams, 'resourceId'>
  & (M extends 'tagging' ? Required<Pick<JobParams, 'schema'>> : unknown);

/**
 * Whether held params are a `mark` job's of this motivation.
 *
 * The spec states what the Dispatcher adds to a job's params and leaves the
 * held shape open, so this is where a holder learns which of the five it was
 * handed. A tagging job without the schema the Dispatcher resolves is not one
 * a holder can run, and is not taken for one.
 */
export function isHeldMark<M extends MarkMotivation>(
  params: JobParams,
  motivation: M,
): params is JobParams & HeldMarkParams<M> {
  return params['motivation'] === motivation && (motivation !== 'tagging' || params.schema !== undefined);
}
