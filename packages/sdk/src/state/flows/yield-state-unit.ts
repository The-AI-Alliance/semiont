import { BehaviorSubject, type Observable, type Subscription } from 'rxjs';
import type { GenerationJobParams, ResourceId, components } from '@semiont/core';
import type { SemiontClient } from '../../client';
import type { StateUnit } from '@semiont/core';
import type { DelegationObservable, YieldJobCompletion } from '../../awaitable';

type JobProgress = components['schemas']['JobProgress'];

/**
 * What a finished generation produced, held for the terminal display.
 * Sourced from `job:complete` — the broadcast, emitted after citations
 * attach — never from a progress event, which is mid-run and carries no
 * result.
 */
export interface YieldOutcome {
  resourceId: ResourceId;
  resourceName: string;
  /**
   * The run stopped at the maxTokens ceiling — the artifact is cut off, not
   * complete. Mirrors `JobGenerationResult.truncated` so the terminal frame
   * derives its sentence from the OUTCOME rather than the final progress
   * frame, whose fire-and-forget emit can lose the race with `job:complete`.
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
   * Why the last run ended without a result: it failed, stalled or was
   * cancelled. A `SemiontError`'s `code` says which. Null while a run is
   * under way, after one that completed, and once dismissed. A stall is said
   * nowhere else.
   */
  failure$: Observable<Error | null>;
  /**
   * Grounded generation — the focus of `params.context` decides the shape
   * (annotation focus auto-binds; resource focus mints provenance) and names
   * the job's resource; see `client.yield.delegate`.
   *
   * The arguments are `yield.delegate`'s own, not a restatement: every
   * parameter the job takes (format, entity types, task, structure,
   * citations) and the stall deadline reach it untouched. The one behavior
   * this adds is the locale fallback — `language` unset means the unit's UI
   * locale, never the model's guess.
   */
  generate(params: GenerationJobParams, stallDeadlineMs?: number): void;
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
  const failure$ = new BehaviorSubject<Error | null>(null);

  // Generation progress/complete/fail is driven entirely by the delegation
  // `client.yield.delegate` returns — it gives this job's events only, so no
  // direct bus subscription is needed here.
  //
  // `drive` is the subscribe + progress-wiring for generation. It `.subscribe()`s
  // the cold stream ONCE — the state unit owns that single subscription (pushed
  // to `subs`, torn down on dispose). Callers observe `progress$`/`isGenerating$`;
  // they never get the stream back (a second subscription would re-fire the job —
  // the cold-stream double-fire), which is why the public methods return `void`.
  // No timer of its own: the stall guard lives in the stream's producer
  // (`delegated`), shared with every other consumption — there is exactly
  // one. A stall arrives here as a plain stream error
  // (GenerationStallError), handled below like any other.
  const drive = (gen$: DelegationObservable<YieldJobCompletion>): void => {
    const genSub = gen$.subscribe({
      next: (e) => {
        // Surface live progress to the UI.
        if (e.kind === 'progress') {
          progress$.next(e.data);
          isGenerating$.next(true);
        }
        // The `complete` event is `job:complete`. A generation's result is
        // the one that names the resource made, so it narrows by that member
        // without a cast. Held for the terminal frame's link.
        if (e.kind === 'complete' && e.data.result && 'resourceId' in e.data.result) {
          outcome$.next({
            resourceId: e.data.result.resourceId,
            resourceName: e.data.result.resourceName,
            truncated: e.data.result.truncated,
          });
        }
      },
      complete: () => {
        // The finished display STAYS until dismissed — `isGenerating$` going
        // false is what flips it to its ended form.
        isGenerating$.next(false);
      },
      error: (error: unknown) => {
        progress$.next(null);
        isGenerating$.next(false);
        failure$.next(error instanceof Error ? error : new Error(String(error)));
      },
    });
    subs.push(genSub);
  };

  const generate = (params: GenerationJobParams, stallDeadlineMs?: number): void => {
    // A new run's frame must not carry the previous run's link, or its
    // failure.
    outcome$.next(null);
    failure$.next(null);
    drive(client.yield.delegate(
      { ...params, language: params.language || locale },
      stallDeadlineMs,
    ));
  };

  return {
    isGenerating$: isGenerating$.asObservable(),
    progress$: progress$.asObservable(),
    outcome$: outcome$.asObservable(),
    failure$: failure$.asObservable(),
    generate,
    dismissProgress() {
      progress$.next(null);
      outcome$.next(null);
      failure$.next(null);
    },
    dispose() {
      subs.forEach(s => s.unsubscribe());
      isGenerating$.complete();
      progress$.complete();
      outcome$.complete();
      failure$.complete();
    },
  };
}
