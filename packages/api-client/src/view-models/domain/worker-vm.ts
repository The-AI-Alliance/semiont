import { BehaviorSubject, Observable, Subject } from 'rxjs';
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
    channels: ['job:queued'],
    reconnectMs,
  });

  let jobSubscription: { unsubscribe(): void } | null = null;

  const headers = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  });

  const claimJob = async (assignment: JobAssignment): Promise<ActiveJob | null> => {
    try {
      const response = await fetch(`${baseUrl}/jobs/${assignment.jobId}/claim`, {
        method: 'POST',
        headers: headers(),
      });
      if (response.status === 409) return null;
      if (!response.ok) return null;
      const job = (await response.json()) as {
        params?: Record<string, unknown>;
        metadata?: { userId?: string; userName?: string; userEmail?: string; userDomain?: string };
      };
      return {
        jobId: assignment.jobId,
        type: assignment.type,
        resourceId: assignment.resourceId,
        userId: job.metadata?.userId ?? '',
        params: job.params ?? {},
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
