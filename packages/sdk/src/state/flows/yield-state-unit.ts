import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import type { GatheredContext, ResourceId, components } from '@semiont/core';
import { resourceId as makeResourceId } from '@semiont/core';
import type { SemiontClient } from '../../client';
import type { StateUnit } from '@semiont/core';
import type { StreamObservable } from '../../awaitable';
import type { GenerationOptions, YieldGenerationEvent } from '../../namespaces/types';

type JobProgress = components['schemas']['JobProgress'];

/**
 * What a finished generation produced, held for the terminal display
 * (GENERATE-FROM-RESOURCE D8). Sourced from `job:complete` — the broadcast,
 * emitted after citations attach — never from a progress event, which is
 * mid-run and carries no result.
 */
export interface YieldOutcome {
  resourceId: ResourceId;
  resourceName: string;
  /**
   * The run stopped at the maxTokens ceiling — the artifact is cut off, not
   * complete. Mirrors `JobGenerationResult.truncated` so the terminal frame
   * derives its sentence from the OUTCOME rather than the final progress
   * frame, whose fire-and-forget emit can lose the race with `job:complete`
   * (GENERATION-ARRIVAL D5).
   */
  truncated: boolean;
}

export interface YieldStateUnit extends StateUnit {
  isGenerating$: Observable<boolean>;
  progress$: Observable<JobProgress | null>;
  /**
   * The finished run's result, once `job:complete` arrives with a generation
   * result; null while running and after dismissal. Lives and dies with the
   * progress display: a new `generate()` clears it, `dismissProgress()` clears
   * both together.
   */
  outcome$: Observable<YieldOutcome | null>;
  /**
   * Grounded generation — the context's `focus.kind` decides the shape
   * (annotation focus auto-binds; resource focus mints provenance). Ids are
   * derived from the focus; see `client.yield.fromContext`.
   *
   * Options are the namespace's own `GenerationOptions`, not a restatement:
   * every knob the wire carries (format, entity types, task, structure,
   * citations, the stall deadline) reaches `fromContext` untouched. The one
   * behavior this adds is the locale fallback — `language` unset means the
   * unit's UI locale, never the model's guess.
   */
  generate(context: GatheredContext, options: GenerationOptions): void;
  /** Clear a finished (or abandoned) progress display. Wired to the widget's Close. */
  dismissProgress(): void;
}

export function createYieldStateUnit(
  client: SemiontClient,
  locale: string,
): YieldStateUnit {
  const subs: Subscription[] = [];
  const isGenerating$ = new BehaviorSubject<boolean>(false);
  const progress$ = new BehaviorSubject<JobProgress | null>(null);
  const outcome$ = new BehaviorSubject<YieldOutcome | null>(null);

  // Generation progress/complete/fail is driven entirely by the StreamObservable
  // returned from `client.yield.fromContext` — it is filtered to this job's
  // jobId internally, so no direct bus subscription is needed here.
  //
  // `drive` is the subscribe + progress-wiring for generation. It `.subscribe()`s
  // the cold stream ONCE — the state unit owns that single subscription (pushed
  // to `subs`, torn down on dispose). Callers observe `progress$`/`isGenerating$`;
  // they never get the stream back (a second subscription would re-fire the job —
  // the A2 cold-stream double-fire), which is why the public methods return `void`.
  // No timer of its own: the stall guard lives in the stream's producer
  // (`runGeneration`), shared with every other consumption — A1 of
  // FLOW-LIFECYCLE-CONVERGENCE. A stall arrives here as a plain stream
  // error (GenerationStallError), handled below like any other.
  const drive = (gen$: StreamObservable<YieldGenerationEvent>): void => {
    const genSub = gen$.subscribe({
      next: (e) => {
        // Surface live progress to the UI.
        if (e.kind === 'progress') {
          progress$.next(e.data);
          isGenerating$.next(true);
        }
        // The `complete` event is `job:complete` — the union discriminates
        // (WIRE-UNION-DISCRIMINANTS D1), so the result names its own kind and
        // narrows without a cast. Held for the terminal frame's link (D8).
        if (e.kind === 'complete' && e.data.result?.kind === 'generation') {
          outcome$.next({
            resourceId: makeResourceId(e.data.result.resourceId),
            resourceName: e.data.result.resourceName,
            truncated: e.data.result.truncated,
          });
        }
      },
      complete: () => {
        // The finished display STAYS until dismissed (CLEAN-PROGRESS D1) —
        // `isGenerating$` going false is what flips it to its ended form.
        // It used to clear itself after 2 s, which is a different ending from
        // the assist path's 5 s, in the same component.
        isGenerating$.next(false);
      },
      error: () => {
        progress$.next(null);
        isGenerating$.next(false);
      },
    });
    subs.push(genSub);
  };

  const generate = (context: GatheredContext, options: GenerationOptions): void => {
    // A new run's frame must not carry the previous run's link.
    outcome$.next(null);
    drive(client.yield.fromContext(
      context,
      { ...options, language: options.language || locale },
    ));
  };

  return {
    isGenerating$: isGenerating$.asObservable(),
    progress$: progress$.asObservable(),
    outcome$: outcome$.asObservable(),
    generate,
    dismissProgress() {
      progress$.next(null);
      outcome$.next(null);
    },
    dispose() {
      subs.forEach(s => s.unsubscribe());
      isGenerating$.complete();
      progress$.complete();
      outcome$.complete();
    },
  };
}
