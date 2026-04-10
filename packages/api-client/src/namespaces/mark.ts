/**
 * MarkNamespace — annotation CRUD, entity types, AI assist
 *
 * Commands return Promises that resolve on HTTP acceptance.
 * Results appear on browse Observables via events-stream.
 * assist() returns an Observable for long-running progress.
 *
 * Backend actor: Stower
 * Event prefix: mark:*
 */

import { Observable, merge } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';
import type {
  ResourceId,
  AnnotationId,
  Motivation,
  AccessToken,
  EntityType,
  EventBus,
} from '@semiont/core';
import type { SemiontApiClient } from '../client';
import type {
  MarkNamespace as IMarkNamespace,
  CreateAnnotationInput,
  MarkAssistOptions,
  MarkAssistProgress,
} from './types';
import type { UpdateResourceInput } from '@semiont/core';

type TokenGetter = () => AccessToken | undefined;

export class MarkNamespace implements IMarkNamespace {
  constructor(
    private readonly http: SemiontApiClient,
    private readonly eventBus: EventBus,
    private readonly getToken: TokenGetter,
  ) {}

  async annotation(resourceId: ResourceId, input: CreateAnnotationInput): Promise<{ annotationId: string }> {
    return this.http.markAnnotation(resourceId, input, { auth: this.getToken() });
  }

  async delete(resourceId: ResourceId, annotationId: AnnotationId): Promise<void> {
    return this.http.deleteAnnotation(resourceId, annotationId, { auth: this.getToken() });
  }

  async entityType(type: string): Promise<void> {
    return this.http.addEntityType(type as EntityType, { auth: this.getToken() });
  }

  async entityTypes(types: string[]): Promise<void> {
    return this.http.addEntityTypesBulk(types as EntityType[], { auth: this.getToken() });
  }

  async updateResource(resourceId: ResourceId, data: UpdateResourceInput): Promise<void> {
    return this.http.updateResource(resourceId, data, { auth: this.getToken() });
  }

  async archive(resourceId: ResourceId): Promise<void> {
    return this.http.updateResource(resourceId, { archived: true }, { auth: this.getToken() });
  }

  async unarchive(resourceId: ResourceId): Promise<void> {
    return this.http.updateResource(resourceId, { archived: false }, { auth: this.getToken() });
  }

  assist(resourceId: ResourceId, motivation: Motivation, options: MarkAssistOptions): Observable<MarkAssistProgress> {
    return new Observable((subscriber) => {
      const progress$ = this.eventBus.get('mark:progress').pipe(
        filter((e) => e.resourceId === (resourceId as string)),
      );
      const finished$ = this.eventBus.get('mark:assist-finished').pipe(
        filter((e) => e.resourceId === (resourceId as string) && e.motivation === motivation),
      );
      const failed$ = this.eventBus.get('mark:assist-failed').pipe(
        filter((e) => e.resourceId === (resourceId as string)),
      );

      const progressSub = progress$
        .pipe(takeUntil(merge(finished$, failed$)))
        .subscribe((e) => subscriber.next(e as MarkAssistProgress));

      const finishedSub = finished$.subscribe((e) => {
        subscriber.next(e as MarkAssistProgress);
        subscriber.complete();
      });

      const failedSub = failed$.subscribe((e) => {
        subscriber.error(new Error(e.message));
      });

      // Dispatch to the right annotate* HTTP method based on motivation
      const auth = this.getToken();
      const postPromise = this.dispatchAssist(resourceId, motivation, options, auth);
      postPromise.catch((error) => {
        subscriber.error(error);
      });

      return () => {
        progressSub.unsubscribe();
        finishedSub.unsubscribe();
        failedSub.unsubscribe();
      };
    });
  }

  private async dispatchAssist(
    resourceId: ResourceId,
    motivation: Motivation,
    options: MarkAssistOptions,
    auth: AccessToken | undefined,
  ): Promise<void> {
    if (motivation === 'tagging') {
      const { schemaId, categories } = options;
      if (!schemaId || !categories?.length) throw new Error('Tag assist requires schemaId and categories');
      await this.http.annotateTags(resourceId, { schemaId, categories }, { auth });
    } else if (motivation === 'linking') {
      const { entityTypes, includeDescriptiveReferences } = options;
      if (!entityTypes?.length) throw new Error('Reference assist requires entityTypes');
      await this.http.annotateReferences(resourceId, {
        entityTypes: entityTypes as string[],
        includeDescriptiveReferences: includeDescriptiveReferences ?? false,
      }, { auth });
    } else if (motivation === 'highlighting') {
      await this.http.annotateHighlights(resourceId, {
        instructions: options.instructions,
        density: options.density,
      }, { auth });
    } else if (motivation === 'assessing') {
      await this.http.annotateAssessments(resourceId, {
        instructions: options.instructions,
        tone: options.tone,
        density: options.density,
        language: options.language,
      }, { auth });
    } else if (motivation === 'commenting') {
      await this.http.annotateComments(resourceId, {
        instructions: options.instructions,
        tone: options.tone,
        density: options.density,
        language: options.language,
      }, { auth });
    }
  }
}
