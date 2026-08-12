import { isObject, isString } from '@semiont/core';
import type { components } from '@semiont/core';

type DeclineReason = components['schemas']['JobDeclinedResult']['reason'];

/** The closed vocabulary this client has copy for. */
const REASONS: readonly string[] = ['no-text-layer', 'encrypted', 'corrupt', 'too-large', 'empty'];

/**
 * A detection job can *decline* cleanly rather than succeed or fail: a PDF
 * that is encrypted, damaged, or a scan whose text could not be recognized.
 * The worker reports it on `job:complete` as a `{ declined, reason, message }`
 * result — `JobDeclinedResult`, a member of the typed `JobResult` union since
 * #739. Narrowed structurally anyway: this runs against whatever the wire
 * delivered, and a runtime check is the honest guard at that boundary.
 * Returns the user-facing message, or null for an ordinary result.
 *
 * A decline is neither a success nor an error: the caller should surface it as
 * info — not a "complete" success toast (misleading — nothing was detected) and
 * not a "failed" error toast (alarming — nothing broke).
 */
export function declineReason(result: unknown): DeclineReason | null {
  if (!isObject(result) || result.declined !== true || !isString(result.reason)) return null;
  // A reason outside the vocabulary has no copy. Returning it anyway would put
  // a raw wire token in a toast — the untranslated leak this phase removes.
  return REASONS.includes(result.reason) ? (result.reason as DeclineReason) : null;
}
