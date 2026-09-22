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
import { registerJobCommandHandlers } from '../../handlers/job-commands';
import type { ProjectionReads } from '../../projection-reads-ask';
import { makeJobQueueMock, type JobQueueMock } from '../helpers/job-queue-mock';

const silentLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => silentLogger),
};

// job:claim never reads projections; a stub keeps the handler's other path
// (job:create validation, D7) off this suite's concern.
const stubReads: ProjectionReads = { entityTypes: async () => [], tagSchemas: async () => [] };

const WORKER = 'did:web:test:agents:ollama:gemma';
const REQUESTER = 'did:web:test:users:alice';
const RID = 'res-claimable';

describe('registerJobCommandHandlers — job:claim authorization (EXTRACT-JOBS P0)', () => {
  let eventBus: EventBus;
  let jobQueue: JobQueueMock;

  beforeEach(() => {
    eventBus = new EventBus();
    jobQueue = makeJobQueueMock();
    // Returns a CLAIMABLE job, so that absent an authorization check the handler
    // takes the success path (`job:claimed`) — which is exactly the RED failure
    // for a non-worker claim.
    // A job always names its resource and its requester: the dispatcher records
    // both on job:assigned, and refuses to assign a job it cannot record.
    jobQueue.claimNextJob.mockResolvedValue({
      job: { metadata: { id: 'job-claimable', type: 'generation', userId: REQUESTER }, params: { resourceId: RID } },
    });
    registerJobCommandHandlers(eventBus, jobQueue, stubReads, silentLogger);
  });

  afterEach(() => {
    eventBus.destroy();
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
    // `_userId` is the gateway's stamp on every emit; the handler records it as
    // the holder. A frame without one is the injection failing, not a caller.
    eventBus.emit('job:claim', { _userId: WORKER, ...frame } as never, { correlationId: cid });
    return outcome;
  }

  it('admits a claim carrying the worker capability and reaches the queue', async () => {
    const outcome = await claim('cid-worker', { types: ['generation'], _roles: [WORKER_ROLE] });
    expect(outcome, 'a worker claim is admitted').toHaveProperty('ok');
    expect(jobQueue.claimNextJob).toHaveBeenCalledTimes(1);
  });

  it('records the acceptance as job:assigned — holder, requester, and the job — beside the reply', async () => {
    // The one fact only the dispatcher can vouch for. The Stower persists it so
    // a write citing this job is checkable against the log alone
    // (VERIFIED-PROVENANCE D1).
    const assigned = firstValueFrom(eventBus.on('job:assign').pipe(take(1)));

    const outcome = await claim('cid-record', { types: ['generation'], _roles: [WORKER_ROLE] });
    expect(outcome).toHaveProperty('ok');

    expect(await assigned).toMatchObject({
      jobId: 'job-claimable',
      jobType: 'generation',
      resourceId: RID,
      holder: WORKER,
      requester: REQUESTER,
    });
  });

  it('refuses to assign a job that names no resource — there is nowhere to record the assignment', async () => {
    // Resolved BEFORE the reply: a job:claimed followed by a throw would send
    // two contradictory answers to one claim.
    jobQueue.claimNextJob.mockResolvedValueOnce({
      job: { metadata: { id: 'job-homeless', type: 'generation', userId: REQUESTER }, params: {} },
    });
    const assigns: unknown[] = [];
    eventBus.on('job:assign').subscribe((p) => { assigns.push(p); });

    const outcome = await claim('cid-homeless', { types: ['generation'], _roles: [WORKER_ROLE] });

    expect(outcome).toHaveProperty('failed');
    expect((outcome as { failed: EventMap['job:claim-failed'] }).failed.message).toMatch(/names no resource/);
    expect(assigns).toEqual([]);
  });

  it('refuses a claim the gateway did not stamp — no holder to record', async () => {
    const outcome = await claim('cid-unstamped', { types: ['generation'], _roles: [WORKER_ROLE], _userId: undefined });

    expect(outcome).toHaveProperty('failed');
    expect((outcome as { failed: EventMap['job:claim-failed'] }).failed.message).toMatch(/_userId/);
  });

  it('a worker claim that finds nothing pending is DECLINED on job:claim-failed — an empty queue is an answer, not an error', async () => {
    jobQueue.claimNextJob.mockResolvedValueOnce({ declined: 'none-available' });
    const outcome = await claim('cid-empty', { types: ['generation'], _roles: [WORKER_ROLE] });
    expect(outcome).toHaveProperty('failed');
    expect((outcome as { failed: EventMap['job:claim-failed'] }).failed.message).toBe('No pending job of the requested types');
    expect(jobQueue.claimNextJob).toHaveBeenCalledWith(['generation']);
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
