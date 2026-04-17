import { BehaviorSubject, Subject, type Observable, map } from 'rxjs';
import type { EventBus } from '@semiont/core';
import type { ViewModel } from '../lib/view-model';

export interface Job {
  jobId: string;
  type: string;
  status: string;
  resourceId: string;
  userId: string;
  created: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  progress?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export interface JobQueueVM extends ViewModel {
  jobs$: Observable<Job[]>;
  pendingByType$: Observable<Map<string, number>>;
  runningJobs$: Observable<Job[]>;
  jobCreated$: Observable<Job>;
  jobCompleted$: Observable<Job>;
  jobFailed$: Observable<Job>;
}

export function createJobQueueVM(eventBus: EventBus): JobQueueVM {
  const jobs$ = new BehaviorSubject<Job[]>([]);
  const jobCreated$ = new Subject<Job>();
  const jobCompleted$ = new Subject<Job>();
  const jobFailed$ = new Subject<Job>();

  const pendingByType$: Observable<Map<string, number>> = jobs$.pipe(
    map((all) => {
      const counts = new Map<string, number>();
      for (const j of all) {
        if (j.status === 'pending') {
          counts.set(j.type, (counts.get(j.type) ?? 0) + 1);
        }
      }
      return counts;
    }),
  );

  const runningJobs$: Observable<Job[]> = jobs$.pipe(
    map((all) => all.filter((j) => j.status === 'running')),
  );

  const addOrUpdate = (job: Job) => {
    const current = jobs$.getValue();
    const idx = current.findIndex((j) => j.jobId === job.jobId);
    if (idx >= 0) {
      const next = [...current];
      next[idx] = job;
      jobs$.next(next);
    } else {
      jobs$.next([...current, job]);
    }
  };

  const subs = [
    eventBus.get('job:queued').subscribe((event) => {
      const job: Job = {
        jobId: event.jobId,
        type: event.jobType,
        status: 'pending',
        resourceId: event.resourceId ?? '',
        userId: '',
        created: new Date().toISOString(),
      };
      addOrUpdate(job);
      jobCreated$.next(job);
    }),

    eventBus.get('job:complete').subscribe((event) => {
      const job: Job = {
        jobId: event.jobId,
        type: event.jobType ?? '',
        status: 'complete',
        resourceId: event.resourceId ?? '',
        userId: event.userId ?? '',
        created: '',
        completedAt: new Date().toISOString(),
        result: event.result as Record<string, unknown>,
      };
      addOrUpdate(job);
      jobCompleted$.next(job);
    }),

    eventBus.get('job:fail').subscribe((event) => {
      const job: Job = {
        jobId: event.jobId,
        type: event.jobType ?? '',
        status: 'failed',
        resourceId: event.resourceId ?? '',
        userId: event.userId ?? '',
        created: '',
        completedAt: new Date().toISOString(),
        error: event.error ?? 'Unknown error',
      };
      addOrUpdate(job);
      jobFailed$.next(job);
    }),
  ];

  return {
    jobs$: jobs$.asObservable(),
    pendingByType$,
    runningJobs$,
    jobCreated$: jobCreated$.asObservable(),
    jobCompleted$: jobCompleted$.asObservable(),
    jobFailed$: jobFailed$.asObservable(),
    dispose: () => {
      subs.forEach((s) => s.unsubscribe());
      jobs$.complete();
      jobCreated$.complete();
      jobCompleted$.complete();
      jobFailed$.complete();
    },
  };
}
