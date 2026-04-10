/**
 * BindNamespace — reference linking
 *
 * The simplest namespace. One method. The result (updated annotation
 * with resolved reference) arrives on browse.annotations() via the
 * enriched mark:body-updated event.
 *
 * Backend actor: Stower (via mark:update-body)
 * Event prefix: mark:body-updated (shares mark event pipeline)
 */

import type { ResourceId, AnnotationId, BodyOperation, AccessToken } from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type { BindNamespace as IBindNamespace } from './types';

type TokenGetter = () => AccessToken | undefined;

export class BindNamespace implements IBindNamespace {
  constructor(
    private readonly http: SemiontApiClient,
    private readonly getToken: TokenGetter,
  ) {}

  async body(resourceId: ResourceId, annotationId: AnnotationId, operations: BodyOperation[]): Promise<void> {
    await this.http.bindAnnotation(resourceId, annotationId, { operations }, { auth: this.getToken() });
  }
}
