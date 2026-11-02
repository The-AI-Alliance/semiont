import { describe, expect, it, vi } from 'vitest';
import { createTestSession, refuseUnscriptedOperation, stubGateway } from '@semiont/sdk/testing';
import { jobId, resourceId, userId, type components } from '@semiont/core';
import {
  buildTask,
  delegate,
  engineForVerb,
  requesterFor,
  sessionTaskLog,
  verbForMotivation,
  type DelegationTask,
} from './delegation';

type Schemas = components['schemas'];
type EngineEntry = Schemas['EngineEntry'];

const REQUESTER: Schemas['UserResponse'] = {
  did: userId('did:web:kb.example.org:users:ada'),
  email: 'ada@example.org',
  name: 'Ada',
  image: null,
  domain: 'kb.example.org',
};
const JOB = jobId('job-2');

/**
 * The real client over the scriptable transport (@semiont/sdk/testing): `mark.delegate`
 * runs its REAL job conversation — `job:create` on the wire, lifecycle events back.
 * Requests are read off `transport.requestLog` (payload snapshots, arrival order);
 * the handler below only replays the job's lifecycle a tick later, as a worker reports
 * it: for a linking job, progress per entity type; then how the job ended.
 */
function delegateHarness(ending: 'completes' | 'declines' | 'fails' = 'completes') {
  const { session, transport } = createTestSession({
    transport: { makeResponse: (op) => (op === 'job:create' ? { jobId: JOB } : refuseUnscriptedOperation(op)) },
  });
  transport.on('job:create', (job) => {
    if (job.jobType !== 'mark') return;
    const { resourceId: resource, params } = job;
    setTimeout(() => {
      void (async () => {
        for (const entityType of params.motivation === 'linking' ? params.entityTypes : []) {
          await transport.emit('job:report-progress', {
            resourceId: resource,
            jobId: JOB,
            jobType: 'mark',
            percentage: 0,
            progress: {
              percentage: 0,
              message: { code: 'detecting-entities', entityType },
              current: { kind: 'entity-type', value: entityType },
            },
          });
        }
        if (ending === 'fails') {
          await transport.emit('job:fail', {
            resourceId: resource,
            jobId: JOB,
            jobType: 'mark',
            error: 'the model could not be reached',
            willRetry: false,
          });
          return;
        }
        await transport.emit('job:complete', {
          resourceId: resource,
          jobId: JOB,
          jobType: 'mark',
          result: ending === 'declines' ? { declined: true, reason: 'no-text-layer' } : { found: 2, persisted: 2 },
        });
      })();
    }, 0);
  });
  const jobs = () =>
    transport.requestLog
      .filter((e) => e.channel === 'job:create')
      .map((e) => e.payload as { jobType: string; resourceId: string; params: Record<string, unknown> });
  return { session, transport, jobs };
}

describe('verbForMotivation — the delegation form defaults to the footer motivation', () => {
  it('maps each selection motivation onto its motivation-shaped verb', () => {
    expect(verbForMotivation('linking')).toBe('find-references');
    expect(verbForMotivation('highlighting')).toBe('highlight');
    expect(verbForMotivation('assessing')).toBe('assess');
    expect(verbForMotivation('commenting')).toBe('draft-comments');
    expect(verbForMotivation('tagging')).toBe('suggest-tags');
  });

  it('falls back to find-references when no motivation is set', () => {
    expect(verbForMotivation(null)).toBe('find-references');
  });
});

describe('who is asking (AI/Human equivalence — DELEGATION.md)', () => {
  it('is who the gateway says is signed in, by their DID, named only when the KB holds a name', async () => {
    const did = userId('did:web:kb.example.org:users:ada');
    for (const name of ['Ada Lovelace', null]) {
      const { session } = createTestSession({
        gateway: {
          ...stubGateway(),
          getCurrentUser: async () => ({ did, email: 'ada@example.org', name, image: null, domain: 'kb.example.org' }),
        },
      });
      const requester = await requesterFor(session);
      expect(requester.did).toBe(did);
      // A name the knowledge base does not hold is not made up (from the email, say).
      expect(requester.name).toBe(name);
      await session.dispose();
    }
  });
});

describe('engineForVerb — the engine list declares which model serves each job', () => {
  const sonnet: EngineEntry = {
    engine: { provider: 'anthropic', model: 'claude-sonnet' },
    jobs: [{ jobType: 'mark', params: { motivation: 'linking' } }],
  };
  const haiku: EngineEntry = {
    engine: { provider: 'anthropic', model: 'claude-haiku' },
    jobs: [
      { jobType: 'mark', params: { motivation: 'highlighting' } },
      { jobType: 'mark', params: { motivation: 'assessing' } },
    ],
  };
  const writer: EngineEntry = {
    engine: { provider: 'anthropic', model: 'claude-opus' },
    jobs: [{ jobType: 'yield' }],
  };
  // An engine entry without job assignments serves no jobs.
  const actorOnly: EngineEntry = { engine: { provider: 'ollama', model: 'gemma3' } };

  it('picks the engine declared to serve `mark` jobs of the verb’s motivation', () => {
    expect(engineForVerb([writer, actorOnly, sonnet, haiku], 'find-references')).toEqual(sonnet.engine);
    expect(engineForVerb([writer, actorOnly, sonnet, haiku], 'highlight')).toEqual(haiku.engine);
    expect(engineForVerb([writer, actorOnly, sonnet, haiku], 'assess')).toEqual(haiku.engine);
  });

  it('names none when nothing declares the job, or the engine list has not loaded', () => {
    expect(engineForVerb([sonnet, writer, actorOnly], 'suggest-tags')).toBeUndefined();
    expect(engineForVerb([], 'highlight')).toBeUndefined();
    expect(engineForVerb(undefined, 'highlight')).toBeUndefined();
  });
});

describe('delegate — each verb is a `mark` job of its motivation', () => {
  it('find-references → a linking job with entityTypes, streaming what it is on', async () => {
    const h = delegateHarness();
    const task = buildTask(REQUESTER, resourceId('ans-7'), {
      verb: 'find-references',
      params: { entityTypes: ['Person', 'Place'] },
    });
    const onUpdate = vi.fn<(t: DelegationTask) => void>();

    const done = await delegate(h.session, task, onUpdate);

    expect(h.jobs()[0]).toEqual({
      jobType: 'mark',
      resourceId: 'ans-7',
      params: { motivation: 'linking', entityTypes: ['Person', 'Place'] },
    });
    const progressed = onUpdate.mock.calls.map(([t]) => t.progress).filter(Boolean);
    expect(progressed).toEqual(['Person', 'Place']);
    expect(done.status).toBe('done');
    expect(done.completedAt).toBeDefined();
    expect(done.progress).toBeUndefined();
    await h.session.dispose();
  });

  it('highlight → a highlighting job with optional direction', async () => {
    const h = delegateHarness();
    const done = await delegate(h.session, buildTask(REQUESTER, resourceId('ans-7'), { verb: 'highlight', params: {} }), () => {});
    expect(h.jobs()[0]).toEqual({ jobType: 'mark', resourceId: 'ans-7', params: { motivation: 'highlighting' } });
    expect(done.status).toBe('done');
    await delegate(
      h.session,
      buildTask(REQUESTER, resourceId('ans-7'), { verb: 'highlight', params: { instructions: 'focus on dates' } }),
      () => {},
    );
    expect(h.jobs()[1]?.params).toEqual({ motivation: 'highlighting', instructions: 'focus on dates' });
    await h.session.dispose();
  });

  it('assess → an assessing job with optional direction and tone', async () => {
    const h = delegateHarness();
    await delegate(
      h.session,
      buildTask(REQUESTER, resourceId('ans-7'), { verb: 'assess', params: { instructions: 'check the dates', tone: 'critical' } }),
      () => {},
    );
    expect(h.jobs()[0]?.params).toEqual({ motivation: 'assessing', instructions: 'check the dates', tone: 'critical' });
    await delegate(h.session, buildTask(REQUESTER, resourceId('ans-7'), { verb: 'assess', params: {} }), () => {});
    expect(h.jobs()[1]?.params).toEqual({ motivation: 'assessing' });
    await h.session.dispose();
  });

  it('draft-comments → a commenting job with required direction and optional tone', async () => {
    const h = delegateHarness();
    await delegate(
      h.session,
      buildTask(REQUESTER, resourceId('ans-7'), {
        verb: 'draft-comments',
        params: { instructions: 'explain unfamiliar terms', tone: 'scholarly' },
      }),
      () => {},
    );
    expect(h.jobs()[0]?.params).toEqual({
      motivation: 'commenting',
      instructions: 'explain unfamiliar terms',
      tone: 'scholarly',
    });
    await delegate(
      h.session,
      buildTask(REQUESTER, resourceId('ans-7'), { verb: 'draft-comments', params: { instructions: 'explain unfamiliar terms' } }),
      () => {},
    );
    expect(h.jobs()[1]?.params).toEqual({ motivation: 'commenting', instructions: 'explain unfamiliar terms' });
    await h.session.dispose();
  });

  it('suggest-tags → a tagging job with {schemaId, categories}', async () => {
    const h = delegateHarness();
    await delegate(
      h.session,
      buildTask(REQUESTER, resourceId('ans-7'), {
        verb: 'suggest-tags',
        params: { schemaId: 'legal-irac', categories: ['Issue', 'Rule'] },
      }),
      () => {},
    );
    expect(h.jobs()[0]?.params).toEqual({ motivation: 'tagging', schemaId: 'legal-irac', categories: ['Issue', 'Rule'] });
    await h.session.dispose();
  });

  it('reports a job that fails as a failed task, not a throw', async () => {
    const h = delegateHarness('fails');
    const task = buildTask(REQUESTER, resourceId('ans-7'), { verb: 'find-references', params: { entityTypes: ['Person'] } });
    const onUpdate = vi.fn<(t: DelegationTask) => void>();

    const failed = await delegate(h.session, task, onUpdate);

    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/could not be reached/);
    expect(onUpdate.mock.calls.at(-1)?.[0].status).toBe('failed');
    await h.session.dispose();
  });

  it('reports a job that declines (the resource could not be read) as a failed task, with why', async () => {
    const h = delegateHarness('declines');
    const task = buildTask(REQUESTER, resourceId('ans-7'), { verb: 'highlight', params: {} });

    const failed = await delegate(h.session, task, () => {});

    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/could not be read \(no-text-layer\)/);
    await h.session.dispose();
  });

  it('records completed tasks in the in-memory session task log (Phase-2 queue seed)', async () => {
    const h = delegateHarness();
    const before = sessionTaskLog.length;
    const task = buildTask(REQUESTER, resourceId('ans-9'), { verb: 'find-references', params: { entityTypes: ['Person'] } });
    await delegate(h.session, task, () => {});
    expect(sessionTaskLog.length).toBe(before + 1);
    expect(sessionTaskLog.at(-1)?.scope).toBe(resourceId('ans-9'));
    expect(sessionTaskLog.at(-1)?.status).toBe('done');
    await h.session.dispose();
  });
});
