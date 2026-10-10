/**
 * A request that got no answer, and what its failure says of why.
 *
 * `fetch` rejects with what the runtime made of the failure, and the runtime
 * quotes the exchange in it. Node keeps what it could not read of an answer
 * on the error's cause, says a header's value in the message of an error
 * about one, and says a URL in the message of an error about that. Whatever
 * parses a body says where it stopped, and quotes the body there. A request
 * is made with a token and an answer may grant one, and a failure is printed
 * and logged whole.
 *
 * So no failure made here is `fetch`'s own, and none holds it. A failure says
 * the kind of error it was, by the code or the name the runtime gave it, and
 * none of the runtime's words.
 */

import { SemiontError } from './errors';
import { isObject } from './type-guards';

/** A code or a name as a runtime writes one: an identifier, and so not words. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** `value`, when it is a code or a name that says which kind of error it was. `Error` says none. */
function kind(value: unknown): string | undefined {
  return typeof value === 'string' && IDENTIFIER.test(value) && value !== 'Error' ? value : undefined;
}

/**
 * Why a request got no answer, as its failure may say it: the code of what
 * caused the rejection (`ECONNREFUSED`), failing that its name
 * (`HTTPParserError`), failing that the rejection's own name (`TimeoutError`).
 */
export function whyUnanswered(error: unknown): string {
  if (!isObject(error)) return 'Error';
  const cause = isObject(error['cause']) ? error['cause'] : undefined;
  return kind(cause?.['code']) ?? kind(cause?.['name']) ?? kind(error['name']) ?? 'Error';
}

/**
 * A request that got no answer: the far end was not reached, what came was
 * not HTTP, or the request's deadline passed.
 *
 * It states no status, since nothing answered with one, and is filed under
 * `unavailable` as every such failure is. Wherever a status that says "not
 * now" is worth another attempt, so is this (`isRetryableRequestError`).
 */
export class UnansweredError extends SemiontError {
  declare code: 'unavailable';

  /** `what` names the request. `error` is what `fetch`, or the read of its answer's body, rejected with. */
  constructor(what: string, error: unknown) {
    super(`${what} got no answer: ${whyUnanswered(error)}`, 'unavailable');
    this.name = 'UnansweredError';
  }
}

/**
 * An answer's body, read as JSON. Nothing, when it is not JSON: what the
 * parser says of such a body quotes it, and is said by no one.
 *
 * A body that stops coming is a request that got no answer, and `unanswered`
 * makes the failure of it.
 */
export async function jsonOf(response: Response, unanswered: (error: unknown) => Error): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    return body;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw unanswered(error);
  }
}
