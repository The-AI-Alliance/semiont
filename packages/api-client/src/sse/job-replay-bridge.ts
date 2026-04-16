/**
 * Job Replay Bridge
 *
 * Converts persisted job:* events (which survive SSE reconnect via
 * Last-Event-ID replay) into the ephemeral mark:progress / yield:progress
 * signals that the frontend progress UI already listens for.
 *
 * Uses a batch-settle window: when a job:started event arrives, the bridge
 * waits BATCH_SETTLE_MS before emitting a progress signal. If job:completed
 * or job:failed arrives within the window (replay of a historical job), the
 * emission is cancelled — no stale toast, no phantom progress bar.
 *
 * Only emits progress (never completion/failure) to avoid double-toasts
 * with the live ephemeral events that already handle those.
 */

import type { EventBus, EventMap } from '@semiont/core';
import type { Subscription } from 'rxjs';

interface PendingJob {
  jobType: string;
  resourceId: string;
  percentage: number;
  message?: string;
  timer: ReturnType<typeof setTimeout>;
}

const BATCH_SETTLE_MS = 200;

export function createJobReplayBridge(eventBus: EventBus): { dispose(): void } {
  const subs: Subscription[] = [];
  const pending = new Map<string, PendingJob>();

  const flush = (jobId: string) => {
    const job = pending.get(jobId);
    if (!job) return;
    pending.delete(jobId);

    if (job.jobType === 'generation') {
      eventBus.get('yield:progress').next({
        status: 'generating',
        referenceId: '',
        percentage: job.percentage,
        message: job.message,
        sourceResourceId: job.resourceId,
      } as EventMap['yield:progress']);
    } else {
      eventBus.get('mark:progress').next({
        status: job.percentage > 0 ? 'in-progress' : 'started',
        resourceId: job.resourceId,
        percentage: job.percentage,
        message: job.message,
      } as EventMap['mark:progress']);
    }
  };

  subs.push(eventBus.get('job:started').subscribe((event) => {
    const { jobId, jobType } = event.payload;
    const resourceId = String(event.resourceId ?? '');
    const timer = setTimeout(() => flush(jobId), BATCH_SETTLE_MS);
    pending.set(jobId, { jobType, resourceId, percentage: 0, timer });
  }));

  subs.push(eventBus.get('job:progress').subscribe((event) => {
    const job = pending.get(event.payload.jobId);
    if (job) {
      job.percentage = event.payload.percentage;
      job.message = event.payload.message;
    }
  }));

  subs.push(eventBus.get('job:completed').subscribe((event) => {
    const job = pending.get(event.payload.jobId);
    if (job) {
      clearTimeout(job.timer);
      pending.delete(event.payload.jobId);
    }
  }));

  subs.push(eventBus.get('job:failed').subscribe((event) => {
    const job = pending.get(event.payload.jobId);
    if (job) {
      clearTimeout(job.timer);
      pending.delete(event.payload.jobId);
    }
  }));

  return {
    dispose() {
      subs.forEach(s => s.unsubscribe());
      for (const [, job] of pending) clearTimeout(job.timer);
      pending.clear();
    },
  };
}
