/**
 * Session-level error surface: a session's own errors, said on its
 * `errors$` (its sign-in could not be checked or renewed, the gateway
 * refused a token just issued, what its client keeps could not be kept, its
 * storage refused a write of it), which a registry says on
 * `SemiontBrowser.error$`, with a session it could not make. Per-request
 * errors stay with the caller as normal Promise rejections.
 *
 * `SemiontSessionError` extends `SemiontError` (the unified Semiont base)
 * so consumers can catch with `instanceof SemiontError` for any error
 * surfaced through the SDK.
 */

import { SemiontError, type SemiontSessionErrorCode } from '@semiont/core';

export class SemiontSessionError extends SemiontError {
  declare code: SemiontSessionErrorCode;
  readonly kbId: string | null;

  constructor(code: SemiontSessionErrorCode, message: string, kbId: string | null = null) {
    super(message, code, { kbId });
    this.name = 'SemiontSessionError';
    this.kbId = kbId;
  }
}
