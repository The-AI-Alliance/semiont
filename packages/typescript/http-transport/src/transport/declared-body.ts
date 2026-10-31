/**
 * An answer's body, read as the schema its operation declares.
 *
 * Rust's, Python's and Go's transports decode an answer as the type of its
 * declared body, and refuse one that lacks a member the schema requires,
 * wherever the member is. This transport holds every answer it reads to what
 * its schema requires, and refuses such an answer as they do: as an `error`
 * that states the answer's status, says the answer is not its declared body
 * and names the member.
 */

import { memberLacking, type components } from '@semiont/core';
import { APIError } from './api-error';

type Schemas = components['schemas'];

/** The parts of an answer this reads: its status, and its body as JSON. */
interface Answer {
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

/**
 * The body of `answer`, the answer to `method` `path`, as `schema`: refused
 * when it lacks a member the schema requires. `report`, when given, is told
 * of the refusal before it is thrown: a transport's error stream.
 */
export async function declaredBody<K extends keyof Schemas>(
  schema: K,
  method: string,
  path: string,
  answer: Answer,
  report?: (failure: APIError) => void,
): Promise<Schemas[K]> {
  const body = await answer.json();
  const lacks = memberLacking(schema, body);
  if (lacks === undefined) return body as Schemas[K];
  const failure = APIError.fromStatus(
    `${method} ${path} answered what is not its declared body: it has no \`${lacks}\``,
    answer.status,
    answer.statusText,
    undefined,
    undefined,
  );
  report?.(failure);
  throw failure;
}
