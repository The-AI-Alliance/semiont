import { BehaviorSubject, Observable, Subject } from 'rxjs';
import type { ViewModel } from '../lib/view-model';

export interface JobAssignment {
  jobId: string;
  type: string;
  resourceId: string;
}

export interface ActiveJob {
  jobId: string;
  type: string;
  resourceId: string;
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
  let running = false;
  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const headers = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  });

  const claimJob = async (assignment: JobAssignment): Promise<ActiveJob | null> => {
    try {
      const response = await fetch(`${baseUrl}/jobs/${assignment.jobId}/claim`, {
        method: 'POST',
        headers: headers(),
      });
      if (response.status === 409) return null;
      if (!response.ok) return null;
      const job = await response.json() as { params?: Record<string, unknown> };
      return {
        jobId: assignment.jobId,
        type: assignment.type,
        resourceId: assignment.resourceId,
        params: job.params ?? {},
      };
    } catch {
      return null;
    }
  };

  const emitEvent = async (type: string, payload: Record<string, unknown>): Promise<void> => {
    const job = activeJob$.getValue();
    const jobPath = job ? `/jobs/${job.jobId}/events` : '/jobs/_/events';
    await fetch(`${baseUrl}${jobPath}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ type, ...payload }),
    });
  };

  const connectJobStream = () => {
    const typeParams = jobTypes.map(t => `type=${encodeURIComponent(t)}`).join('&');
    const url = `${baseUrl}/jobs/stream?${typeParams}`;

    const es = new EventSource(url);
    eventSource = es;

    es.addEventListener('job-available', ((event: MessageEvent) => {
      if (!running) return;
      const assignment: JobAssignment = JSON.parse(event.data);

      if (isProcessing$.getValue()) return;

      isProcessing$.next(true);
      claimJob(assignment).then((job) => {
        if (job) {
          activeJob$.next(job);
        } else {
          isProcessing$.next(false);
        }
      }).catch(() => {
        isProcessing$.next(false);
      });
    }) as EventListener);

    es.addEventListener('error', () => {
      if (!running) return;
      es.close();
      eventSource = null;
      reconnectTimer = setTimeout(() => {
        if (running) connectJobStream();
      }, reconnectMs);
    });
  };

  return {
    activeJob$: activeJob$.asObservable(),
    isProcessing$: isProcessing$.asObservable(),
    jobsCompleted$: jobsCompleted$.asObservable(),
    errors$: errors$.asObservable(),
    start: () => {
      if (running) return;
      running = true;
      connectJobStream();
    },
    stop: () => {
      running = false;
      if (eventSource) { eventSource.close(); eventSource = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    },
    emitEvent,
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
      running = false;
      if (eventSource) { eventSource.close(); eventSource = null; }
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      activeJob$.complete();
      isProcessing$.complete();
      jobsCompleted$.complete();
      errors$.complete();
    },
  };
}
