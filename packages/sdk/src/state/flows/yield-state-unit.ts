import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import { timeout } from 'rxjs/operators';
import type { ResourceId, GatheredContext, components } from '@semiont/core';
import { annotationId as makeAnnotationId, resourceId as makeResourceId } from '@semiont/core';
import type { SemiontClient } from '../../client';
import type { StateUnit } from '../lib/state-unit';

type JobProgress = components['schemas']['JobProgress'];

export interface GenerateDocumentOptions {
  title: string;
  storageUri: string;
  prompt?: string;
  /** Body locale — language the generated resource is written in. Falls back to the state unit's UI locale when unset. */
  language?: string;
  /** Source-resource locale — language of the resource the annotation lives on. Forwarded to the prompt for context-snippet awareness. BCP-47. */
  sourceLanguage?: string;
  temperature?: number;
  maxTokens?: number;
  context: GatheredContext;
}

export interface YieldStateUnit extends StateUnit {
  isGenerating$: Observable<boolean>;
  progress$: Observable<JobProgress | null>;
  generate(referenceId: string, options: GenerateDocumentOptions): void;
}

export function createYieldStateUnit(
  client: SemiontClient,
  resourceId: ResourceId,
  locale: string,
): YieldStateUnit {
  const subs: Subscription[] = [];
  const isGenerating$ = new BehaviorSubject<boolean>(false);
  const progress$ = new BehaviorSubject<JobProgress | null>(null);
  let clearTimer: ReturnType<typeof setTimeout> | null = null;

  // Generation progress/complete/fail is driven entirely by the
  // Observable returned from `client.yield.fromAnnotation` — that
  // Observable is filtered to this specific job's jobId internally.
  // No direct bus subscription needed here.
  const generate = (referenceId: string, options: GenerateDocumentOptions): void => {
    const genSub = client.yield.fromAnnotation(
      makeResourceId(resourceId as string),
      makeAnnotationId(referenceId),
      { ...options, language: options.language || locale },
    ).pipe(
      timeout({ each: 300_000 }),
    ).subscribe({
      next: (e) => {
        // Surface live progress to the UI; `complete` events carry the
        // final job result for awaiting callers but produce no extra
        // panel signal here (the `complete` callback fires next).
        if (e.kind === 'progress') {
          progress$.next(e.data);
          isGenerating$.next(true);
        }
      },
      complete: () => {
        isGenerating$.next(false);
        if (clearTimer) clearTimeout(clearTimer);
        clearTimer = setTimeout(() => { progress$.next(null); clearTimer = null; }, 2000);
      },
      error: () => {
        progress$.next(null);
        isGenerating$.next(false);
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
