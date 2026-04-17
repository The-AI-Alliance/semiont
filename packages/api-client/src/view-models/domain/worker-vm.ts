import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { firstValueFrom, merge, filter, map, take, timeout } from 'rxjs';
import type { ViewModel } from '../lib/view-model';
import { createActorVM, type ActorVM } from './actor-vm';

export interface JobAssignment {
  jobId: string;
  type: string;
  resourceId: string;
}

export interface ActiveJob {
  jobId: string;
  type: string;
  resourceId: string;
  userId: string;
  params: Record<string, unknown>;
}

export interface WorkerVMOptions {
  baseUrl: string;
  token: string;
  jobTypes: string[];
  reconnectMs?: number;
}

export interface WorkerVM extends ViewModel {
  activeJob$: Observable<ActiveJob | null>;
  isProcessing$: Observable<boolean>;
  jobsCompleted$: Observable<number>;
  errors$: Observable<{ jobId: string; error: string }>;

  start(): void;
  stop(): void;
  emitEvent(type: string, payload: Record<string, unknown>): Promise<void>;
  completeJob(): void;
  failJob(jobId: string, error: string): void;
}

export function createWorkerVM(options: WorkerVMOptions): WorkerVM {
  const { baseUrl, token, jobTypes, reconnectMs = 5_000 } = options;

  const activeJob$ = new BehaviorSubject<ActiveJob | null>(null);
  const isProcessing$ = new BehaviorSubject<boolean>(false);
  const jobsCompleted$ = new BehaviorSubject<number>(0);
  const errors$ = new Subject<{ jobId: string; error: string }>();

  const actor: ActorVM = createActorVM({
    baseUrl,
    token,
    channels: ['job:queued', 'job:claimed', 'job:claim-failed'],
    reconnectMs,
  });

  let jobSubscription: { unsubscribe(): void } | null = null;

  const claimJob = async (assignment: JobAssignment): Promise<ActiveJob | null> => {
    try {
      const correlationId = crypto.randomUUID();
      const result$ = merge(
        actor.on$<Record<string, unknown>>('job:claimed').pipe(
          filter((e) => e.correlationId === correlationId),
          map((e) => ({ ok: true as const, response: e.response as Record<string, unknown> })),
        ),
        actor.on$<Record<string, unknown>>('job:claim-failed').pipe(
          filter((e) => e.correlationId === correlationId),
          map(() => ({ ok: false as const })),
        ),
      ).pipe(take(1), timeout(10_000));

      const resultPromise = firstValueFrom(result$);
      await actor.emit('job:claim', { correlationId, jobId: assignment.jobId });
      const result = await resultPromise;

      if (!result.ok) return null;
      const job = result.response as {
        params?: Record<string, unknown>;
        metadata?: { userId?: string };
      };
      return {
        jobId: assignment.jobId,
        type: assignment.type,
        resourceId: assignment.resourceId,
        userId: (job.metadata?.userId ?? '') as string,
        params: (job.params ?? {}) as Record<string, unknown>,
      };
    } catch {
      return null;
    }
  };

  return {
    activeJob$: activeJob$.asObservable(),
    isProcessing$: isProcessing$.asObservable(),
    jobsCompleted$: jobsCompleted$.asObservable(),
    errors$: errors$.asObservable(),

    start: () => {
      actor.start();

      jobSubscription = actor
        .on$<{ jobId: string; jobType: string; resourceId: string }>('job:queued')
        .subscribe((event) => {
          const jobType = event.jobType;
          if (jobTypes.length > 0 && !jobTypes.includes(jobType)) return;
          if (isProcessing$.getValue()) return;

          isProcessing$.next(true);
          claimJob({ jobId: event.jobId, type: jobType, resourceId: event.resourceId })
            .then((job) => {
              if (job) {
                activeJob$.next(job);
              } else {
                isProcessing$.next(false);
              }
            })
            .catch(() => {
              isProcessing$.next(false);
            });
        });
    },

    stop: () => {
      jobSubscription?.unsubscribe();
      jobSubscription = null;
      actor.stop();
    },

    emitEvent: (type: string, payload: Record<string, unknown>): Promise<void> => {
      const resourceScope = payload.resourceId as string | undefined;
      return actor.emit(type, payload, resourceScope);
    },

    completeJob: () => {
      activeJob$.next(null);
      isProcessing$.next(false);
      jobsCompleted$.next(jobsCompleted$.getValue() + 1);
    },

    failJob: (jid: string, error: string) => {
      activeJob$.next(null);
      isProcessing$.next(false);
      errors$.next({ jobId: jid, error });
    },

    dispose: () => {
      jobSubscription?.unsubscribe();
      jobSubscription = null;
      actor.dispose();
      activeJob$.complete();
      isProcessing$.complete();
      jobsCompleted$.complete();
      errors$.complete();
    },
  };
}
