/**
 * Whether a job matches a filter.
 *
 * A filter (`JobFilter`) is a partial job description: it names fields of the
 * description at the description's own paths. A job matches when every field
 * the filter states equals the job's; what the filter leaves out is not
 * compared. So the comparison knows no field by name, and does not change when
 * a filter may state another.
 *
 * It is asked in two places: by the Dispatcher, choosing the next job a claim
 * takes, and by a party checking an announcement against its own claim before
 * it asks. `specs/src/jobs/filter-cases.json` holds every implementation to
 * one answer.
 */

import type { components } from './types';
import { isObject } from './type-guards';

type JobFilter = components['schemas']['JobFilter'];

/** A job as a filter is compared with it: announced, or held. */
export interface FilterableJob {
  jobType: components['schemas']['JobType'];
  params: object;
}

function states(stated: unknown, actual: unknown): boolean {
  if (!isObject(stated)) return stated === actual;
  return isObject(actual) && Object.entries(stated).every(([name, value]) => states(value, actual[name]));
}

export function jobMatchesFilter(filter: JobFilter, job: FilterableJob): boolean {
  return states(filter, job);
}
