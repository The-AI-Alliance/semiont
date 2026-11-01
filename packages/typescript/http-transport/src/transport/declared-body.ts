/**
 * An answer's body, read as the schema its operation declares.
 *
 * Every SDK's transport holds an answer to what the schema of its declared
 * body requires before it reads it, and refuses one with a fault, wherever
 * the fault is: as an `error` that states the answer's status, says the
 * answer is not its declared body and names the fault.
 */

import { faultOf, faultSaid, type components } from '@semiont/core';
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
 * when it has a fault as the schema's. `report`, when given, is told
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
  const fault = faultOf(schema, body);
  if (fault === undefined) return body as Schemas[K];
  const failure = APIError.fromStatus(
    `${method} ${path} answered what is not its declared body: ${faultSaid(fault)}`,
    answer.status,
    answer.statusText,
    undefined,
    undefined,
  );
  report?.(failure);
  throw failure;
}
