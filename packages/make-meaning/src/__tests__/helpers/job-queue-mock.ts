/**
 * The one `JobQueue` fake the handler suites share.
 *
 * Keyed by `keyof JobQueue`, so a member added to the interface reddens this
 * file instead of leaving a fake that silently answers `undefined` for it —
 * the "expected inter-lane redness" JOB-DISPATCH-PULL learned twice. Return
 * shapes are left to each test (`mockResolvedValueOnce`), because the suites
 * hand `getJob` deliberately partial jobs; the census here is membership, not
 * shape. Defaults are the quiet answers: nothing pending, nothing found,
 * every transition accepted.
 */
import { vi, type Mock } from 'vitest';
import type { JobQueue } from '@semiont/jobs';

export type JobQueueMock = Record<keyof JobQueue, Mock>;

export function makeJobQueueMock(): JobQueueMock {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    createJob: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(null),
    claimNextJob: vi.fn().mockResolvedValue({ declined: 'none-available' }),
    completeJob: vi.fn().mockResolvedValue(true),
    failJob: vi.fn().mockResolvedValue('failed'),
    checkpointUnits: vi.fn().mockResolvedValue(undefined),
    recordProgress: vi.fn().mockResolvedValue(undefined),
    cancelPendingJobs: vi.fn().mockResolvedValue(0),
    cancelJob: vi.fn().mockResolvedValue(true),
    getStats: vi.fn().mockResolvedValue({ pending: 0, running: 0, complete: 0, failed: 0, cancelled: 0 }),
  };
}
