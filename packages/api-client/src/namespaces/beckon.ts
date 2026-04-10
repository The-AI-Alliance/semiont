/**
 * BeckonNamespace — attention coordination
 *
 * Fire-and-forget. Ephemeral presence signal delivered via the
 * attention-stream to other participants.
 *
 * Backend actor: (frontend relay via attention-stream)
 * Event prefix: beckon:*
 */

import type { AnnotationId, ResourceId, AccessToken } from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type { BeckonNamespace as IBeckonNamespace } from './types';

type TokenGetter = () => AccessToken | undefined;

export class BeckonNamespace implements IBeckonNamespace {
  constructor(
    private readonly http: SemiontApiClient,
    private readonly getToken: TokenGetter,
  ) {}

  attention(annotationId: AnnotationId, resourceId: ResourceId): void {
    // Fire-and-forget — don't await
    this.http.beckonAttention(
      'me', // participantId — always 'me' for self-identification
      { annotationId, resourceId } as Parameters<typeof this.http.beckonAttention>[1],
      { auth: this.getToken() },
    ).catch(() => {
      // Ephemeral — swallow errors silently
    });
  }
}
