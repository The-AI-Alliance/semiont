/**
 * Session-level error surface. Emitted on `SemiontBrowser.error$` for
 * failures that make the session itself unusable (auth failed, actor
 * couldn't start, token refresh terminally exhausted). Per-request
 * errors stay with the caller as normal Promise rejections.
 *
 * `SemiontSessionError` extends `SemiontError` (the unified Semiont base)
 * so consumers can catch with `instanceof SemiontError` for any error
 * surfaced through the SDK.
 */

import { SemiontError } from '@semiont/core';

export type SemiontSessionErrorCode =
  | 'session.construct-failed'
  | 'session.auth-failed'
  | 'session.refresh-exhausted'
  | 'browser.sign-in-failed';

export class SemiontSessionError extends SemiontError {
  declare code: SemiontSessionErrorCode;
  readonly kbId: string | null;

  constructor(code: SemiontSessionErrorCode, message: string, kbId: string | null = null) {
    super(message, code, { kbId });
    this.name = 'SemiontSessionError';
    this.kbId = kbId;
  }
}
