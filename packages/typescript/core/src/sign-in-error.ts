/**
 * Why a sign-in at an issuer failed: a person's, over any of the grants the
 * session layer runs, or a service account's, over the client-credentials
 * grant (`serviceAccountToken`).
 */

import type { SignInErrorCode } from './generated/error-codes';

export class SignInError extends Error {
  constructor(
    readonly code: SignInErrorCode,
    message: string,
    /**
     * The HTTP status the issuer answered with, when there was one.
     *
     * Absent means no response existed to read — `fetch` threw. That
     * difference decides whether a session ends or its refresh is retried: an
     * issuer refusing a grant and a network losing a packet are not the same
     * event, and a status that went only into the message would leave the two
     * indistinguishable one layer up.
     */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SignInError';
  }
}
