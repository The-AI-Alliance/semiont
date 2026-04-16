import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import type { EventBus, ResourceId, YieldProgress, GatheredContext } from '@semiont/core';
import { annotationId as makeAnnotationId, resourceId as makeResourceId } from '@semiont/core';
import type { SemiontApiClient } from '../../client';
import type { ViewModel } from '../lib/view-model';

export interface GenerateDocumentOptions {
  title: string;
  storageUri: string;
  prompt?: string;
  language?: string;
  temperature?: number;
  maxTokens?: number;
  context: GatheredContext;
}

export interface YieldVM extends ViewModel {
  isGenerating$: Observable<boolean>;
  progress$: Observable<YieldProgress | null>;
  generate(referenceId: string, options: GenerateDocumentOptions): void;
}

export function createYieldVM(
  client: SemiontApiClient,
  eventBus: EventBus,
  resourceId: ResourceId,
  locale: string,
): YieldVM {
  const subs: Subscription[] = [];
  const isGenerating$ = new BehaviorSubject<boolean>(false);
  const progress$ = new BehaviorSubject<YieldProgress | null>(null);

  subs.push(eventBus.get('yield:progress').subscribe((chunk: YieldProgress) => {
    progress$.next(chunk);
    isGenerating$.next(true);
  }));

  let clearTimer: ReturnType<typeof setTimeout> | null = null;

  subs.push(eventBus.get('yield:finished').subscribe((final: YieldProgress) => {
    progress$.next(final);
    isGenerating$.next(false);
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { progress$.next(null); clearTimer = null; }, 2000);
  }));

  subs.push(eventBus.get('yield:failed').subscribe(() => {
    progress$.next(null);
    isGenerating$.next(false);
  }));

  const generate = (referenceId: string, options: GenerateDocumentOptions): void => {
    const genSub = client.yield.fromAnnotation(
      makeResourceId(resourceId as string),
      makeAnnotationId(referenceId),
      { ...options, language: options.language || locale },
    ).subscribe({
      next: (chunk) => {
        progress$.next(chunk);
        isGenerating$.next(true);
      },
      error: (error: unknown) => {
        progress$.next(null);
        isGenerating$.next(false);
        eventBus.get('yield:failed').next({
          error: error instanceof Error ? error.message : 'Generation failed',
        });
      },
    });
    subs.push(genSub);
  };

  return {
    isGenerating$: isGenerating$.asObservable(),
    progress$: progress$.asObservable(),
    generate,
    dispose() {
      subs.forEach(s => s.unsubscribe());
      if (clearTimer) clearTimeout(clearTimer);
      isGenerating$.complete();
      progress$.complete();
    },
  };
}
