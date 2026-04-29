import { BehaviorSubject, Subject, type Observable, map } from 'rxjs';
import type { SemiontClient } from '../../client';
import type { ViewModel } from '../lib/view-model';

export interface Job {
  jobId: string;
  type: string;
  status: string;
  resourceId: string;
  /** DID of the user who initiated the job (audit). */
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

export function createJobQueueVM(client: SemiontClient): JobQueueVM {
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
    client.bus.get('job:queued').subscribe((event) => {
      const job: Job = {
        jobId: event.jobId,
        type: event.jobType,
        status: 'pending',
        resourceId: event.resourceId,
        userId: event.userId,
        created: new Date().toISOString(),
      };
      addOrUpdate(job);
      jobCreated$.next(job);
    }),

    client.bus.get('job:complete').subscribe((event) => {
      if (!event._userId) {
        throw new Error('job:complete missing _userId (gateway injection)');
      }
      const job: Job = {
        jobId: event.jobId,
        type: event.jobType,
        status: 'complete',
        resourceId: event.resourceId,
        userId: event._userId,
        created: '',
        completedAt: new Date().toISOString(),
        result: event.result as Record<string, unknown>,
      };
      addOrUpdate(job);
      jobCompleted$.next(job);
    }),

    client.bus.get('job:fail').subscribe((event) => {
      if (!event._userId) {
        throw new Error('job:fail missing _userId (gateway injection)');
      }
      const job: Job = {
        jobId: event.jobId,
        type: event.jobType,
        status: 'failed',
        resourceId: event.resourceId,
        userId: event._userId,
        created: '',
        completedAt: new Date().toISOString(),
        error: event.error,
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
