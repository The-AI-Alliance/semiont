import { isObject, isString } from '@semiont/core';

/**
 * A detection job can *decline* cleanly rather than succeed or fail — today a
 * scanned / image-only PDF with no text layer to analyze (#736/#738). The
 * worker reports it on `job:complete` as a `{ declined, reason, message }`
 * result, which is not in the typed `JobResult` union, so narrow it
 * structurally. Returns the user-facing message, or null for an ordinary
 * (non-declined) result.
 *
 * A decline is neither a success nor an error: the caller should surface it as
 * info — not a "complete" success toast (misleading — nothing was detected) and
 * not a "failed" error toast (alarming — nothing broke).
 */
export function declinedMessage(result: unknown): string | null {
  return isObject(result) && result.declined === true && isString(result.message)
    ? result.message
    : null;
}
