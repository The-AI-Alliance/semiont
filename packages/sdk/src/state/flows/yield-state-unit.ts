import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import { timeout } from 'rxjs/operators';
import type { ResourceId, GatheredContext, components } from '@semiont/core';
import { annotationId as makeAnnotationId, resourceId as makeResourceId } from '@semiont/core';
import type { SemiontClient } from '../../client';
import type { StateUnit } from '../lib/state-unit';
import type { StreamObservable } from '../../awaitable';
import type { YieldGenerationEvent } from '../../namespaces/types';

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
  /** Generate a resource derived from an annotation (reference) on this resource. */
  generate(referenceId: string, options: GenerateDocumentOptions): void;
  /** Generate a resource derived from this whole resource (no annotation anchor). */
  generateFromResource(options: GenerateDocumentOptions): void;
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

  // Generation progress/complete/fail is driven entirely by the StreamObservable
  // returned from `client.yield.from{Annotation,Resource}` — it is filtered to
  // this job's jobId internally, so no direct bus subscription is needed here.
  //
  // `drive` is the shared subscribe + progress-wiring for both generation entry
  // points (they differ only in which `yield.*` they call). It `.subscribe()`s
  // the cold stream ONCE — the state unit owns that single subscription (pushed
  // to `subs`, torn down on dispose). Callers observe `progress$`/`isGenerating$`;
  // they never get the stream back (a second subscription would re-fire the job —
  // the A2 cold-stream double-fire), which is why the public methods return `void`.
  const drive = (gen$: StreamObservable<YieldGenerationEvent>): void => {
    const genSub = gen$.pipe(
      timeout({ each: 300_000 }),
    ).subscribe({
      next: (e) => {
        // Surface live progress to the UI; `complete` events carry the final job
        // result for awaiting callers but produce no extra panel signal here
        // (the `complete` callback fires next).
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

  const generate = (referenceId: string, options: GenerateDocumentOptions): void => {
    drive(client.yield.fromAnnotation(
      makeResourceId(resourceId as string),
      makeAnnotationId(referenceId),
      { ...options, language: options.language || locale },
    ));
  };

  const generateFromResource = (options: GenerateDocumentOptions): void => {
    drive(client.yield.fromResource(
      makeResourceId(resourceId as string),
      { ...options, language: options.language || locale },
    ));
  };

  return {
    isGenerating$: isGenerating$.asObservable(),
    progress$: progress$.asObservable(),
    generate,
    generateFromResource,
    dispose() {
      subs.forEach(s => s.unsubscribe());
      if (clearTimer) clearTimeout(clearTimer);
      isGenerating$.complete();
      progress$.complete();
    },
  };
}
