/**
 * An answer's body, read as the schema its operation declares.
 *
 * Every SDK's transport holds an answer to what the schema of its declared
 * body requires before it reads it, and refuses one with a fault, wherever
 * the fault is: as an `error` that states the answer's status, says the
 * answer is not its declared body and names the fault.
 */

import { faultSaid, type components } from '@semiont/core';
import { APIError } from './api-error';

type Schemas = components['schemas'];

/** What every SDK says of a body or a frame that is no JSON. */
export const MALFORMED = 'it is malformed';

/** The parts of an answer this reads: its status, and its body as JSON. */
interface Answer {
  readonly status: number;
  readonly statusText: string;
  /** Rejects with a `SyntaxError` when the body is no JSON. */
  json(): Promise<unknown>;
}

/**
 * The body of `answer`, the answer to `method` `path`, as `schema`: refused
 * when it is no JSON, or has a fault as the schema's. `report`, when given,
 * is told of the refusal before it is thrown: a transport's error stream.
 */
export async function declaredBody<K extends keyof Schemas>(
  schema: K,
  method: string,
  path: string,
  answer: Answer,
  report?: (failure: APIError) => void,
): Promise<Schemas[K]> {
  let body: unknown;
  try {
    body = await answer.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw refused(MALFORMED);
  }
  const refusal = faultSaid(schema, body);
  if (refusal !== undefined) throw refused(refusal);
  return body as Schemas[K];

  function refused(said: string): APIError {
    const failure = APIError.fromStatus(
      `${method} ${path} answered what is not its declared body: ${said}`,
      answer.status,
      answer.statusText,
      undefined,
      undefined,
    );
    report?.(failure);
    return failure;
  }
}
