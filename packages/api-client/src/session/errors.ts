/**
 * Session-level error surface. Emitted on `SemiontBrowser.error$` for
 * failures that make the session itself unusable (auth failed, actor
 * couldn't start, token refresh terminally exhausted). Per-request
 * errors stay with the caller as normal Promise rejections.
 */

export type SemiontErrorCode =
  | 'session.construct-failed'
  | 'session.auth-failed'
  | 'session.refresh-exhausted'
  | 'browser.sign-in-failed';

export class SemiontError extends Error {
  readonly code: SemiontErrorCode;
  readonly kbId: string | null;

  constructor(code: SemiontErrorCode, message: string, kbId: string | null = null) {
    super(message);
    this.name = 'SemiontError';
    this.code = code;
    this.kbId = kbId;
  }
}
