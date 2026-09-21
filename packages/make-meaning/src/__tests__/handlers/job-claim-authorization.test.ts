/**
 * P0 (EXTRACT-JOBS): a `job:claim` is AUTHORIZED, not just authenticated.
 *
 * Today the `job:claim` handler reads `{ types }` and nothing else, and
 * `claimNextJob(types)` is principal-blind: ANY authenticated caller can claim
 * — and receive the full payload of — ANY pending job. `types: []` hands back
 * the next pending job of any kind. This is the first-party assumption the
 * extraction ships into a service NAMED for foreign workers, and it is the part
 * of the queue that is always wrong to leave open.
 *
 * The check authorizes by CAPABILITY, not identity. A worker's agent token
 * carries `WORKER_ROLE` — stamped at `/api/tokens/agent` from the minting
 * client's own grant — and the gateway forwards the claimant's roles onto the
 * frame as `_roles`. The dispatcher admits the claim only when `_roles` carries
 * the worker role. Authorizing by the role (rather than by matching the client
 * `semiont-worker`) is what lets a FOREIGN worker claim: the operator grants
 * that worker's client the same role and nothing here changes. Matching a
 * client id would admit only the one first-party client.
 *
 * `SERVICE_ROLE` is the floor, not the discriminator: every sidecar carries it,
 * so the archivist's token holds it exactly as a worker's does — worker-ness is
 * the separate `WORKER_ROLE` grant.
 *
 * RED today: the handler reads no capability, so a non-worker claim SUCCEEDS
 * (`job:claimed`) and `claimNextJob` is called. GREEN: refuse it with
 * `job:claim-failed` and never touch the queue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { firstValueFrom, filter, map, race, timer, take } from 'rxjs';
import { EventBus, WORKER_ROLE, SERVICE_ROLE, type EventMap, type Logger } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import { registerJobCommandHandlers } from '../../handlers/job-commands';
import { createTestProject } from '../helpers/test-project';

const silentLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => silentLogger),
};

function makeJobQueue() {
  return {
    createJob: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(null),
    // Returns a CLAIMABLE job, so that absent an authorization check the handler
    // takes the success path (`job:claimed`) — which is exactly the RED failure
    // for a non-worker claim.
    claimNextJob: vi.fn().mockResolvedValue({ job: { metadata: { id: 'job-claimable', type: 'generation' }, params: {} } }),
    completeJob: vi.fn().mockResolvedValue(true),
    failJob: vi.fn().mockResolvedValue('failed'),
    checkpointUnits: vi.fn().mockResolvedValue(undefined),
    recordProgress: vi.fn().mockResolvedValue(undefined),
    cancelPendingJobs: vi.fn().mockResolvedValue(0),
    cancelJob: vi.fn().mockResolvedValue(true),
  };
}

describe('registerJobCommandHandlers — job:claim authorization (EXTRACT-JOBS P0)', () => {
  let project: SemiontProject;
  let teardown: () => Promise<void>;
  let eventBus: EventBus;
  let jobQueue: ReturnType<typeof makeJobQueue>;

  beforeEach(async () => {
    ({ project, teardown } = await createTestProject('job-claim-authorization'));
    eventBus = new EventBus();
    jobQueue = makeJobQueue();
    registerJobCommandHandlers(eventBus, jobQueue as never, project, silentLogger);
  });

  afterEach(async () => {
    eventBus.destroy();
    await teardown();
  });

  function claim(cid: string, frame: Record<string, unknown>) {
    const claimed$ = eventBus.frames('job:claimed').pipe(
      filter((f) => f.correlationId === cid),
      map((f) => ({ ok: f.payload })),
      take(1),
    );
    const failed$ = eventBus.frames('job:claim-failed').pipe(
      filter((f) => f.correlationId === cid),
      map((f) => ({ failed: f.payload })),
      take(1),
    );
    const outcome = firstValueFrom(race(claimed$, failed$, timer(2_000)));
    eventBus.emit('job:claim', frame as never, { correlationId: cid });
    return outcome;
  }

  it('admits a claim carrying the worker capability and reaches the queue', async () => {
    const outcome = await claim('cid-worker', { types: ['generation'], _roles: [WORKER_ROLE] });
    expect(outcome, 'a worker claim is admitted').toHaveProperty('ok');
    expect(jobQueue.claimNextJob).toHaveBeenCalledTimes(1);
  });

  it('refuses a claim carrying no capabilities (a person) and never touches the queue', async () => {
    const outcome = await claim('cid-human', { types: ['generation'] });
    expect(outcome, 'a non-worker claim must be refused, not claimed').toHaveProperty('failed');
    expect((outcome as { failed: EventMap['job:claim-failed'] }).failed.message).toMatch(/worker|not authorized/i);
    expect(jobQueue.claimNextJob, 'the queue must not be consulted for an unauthorized claim').not.toHaveBeenCalled();
  });

  it('refuses a claim from a non-worker service — a sidecar has the service role, not the worker role', async () => {
    const outcome = await claim('cid-sidecar', { types: ['generation'], _roles: [SERVICE_ROLE] });
    expect(outcome, 'the service-role floor is not the worker discriminator').toHaveProperty('failed');
    expect(jobQueue.claimNextJob).not.toHaveBeenCalled();
  });
});
