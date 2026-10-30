/**
 * Type-level guard — the engines' bus operation.
 *
 * Pins the `browse:engines` OPERATION, not just its schemas: the request
 * channel must be a registered `BusOperationKey` (which transitively requires
 * the EventMap + CHANNEL_SCHEMAS entries and derives the replies into
 * `BRIDGED_CHANNELS`), and `BusReply` must infer the reply-shape-standard
 * payload `{ engines: EngineEntry[] }` from the result channel. An entry is an
 * engine — a provider and a model — with the jobs it is used for, or without
 * them when only Librarian actors ask it. It carries no identity.
 *
 * Enforced by `tsc --noEmit` (core `typecheck`), not vitest runtime.
 */
import { describe, it, expect } from 'vitest';
import type { components } from '../types';
import type { BusOperationKey } from '../bus-operations';
import type { BusReply } from '../bus-request';

type EngineEntry = components['schemas']['EngineEntry'];

describe('browse:engines — operation + reply-shape guard', () => {
  it('the request channel is a registered bus operation', () => {
    const op: BusOperationKey = 'browse:engines-requested';
    expect(op).toBe('browse:engines-requested');
  });

  it('the reply infers as { engines: EngineEntry[] } via the registry', () => {
    const reply: BusReply<'browse:engines-requested'> = { engines: [] };
    const entries: EngineEntry[] = reply.engines;
    expect(entries).toEqual([]);
  });

  it('an entry is an engine, a provider and a model, with the jobs it is used for', () => {
    const entry: EngineEntry = {
      engine: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      jobs: [{ jobType: 'mark', params: { motivation: 'highlighting' } }, { jobType: 'yield' }],
    };
    expect(entry.engine.provider).toBe('anthropic');
  });

  it('the Agent members are NAMED schemas a consumer can reference', () => {
    // `discriminator` requires named members — an inline oneOf branch cannot
    // be a mapping target. The named types are also what lets a consumer
    // hold "a software agent" as a type rather than a re-derived narrowing.
    const software: components['schemas']['AgentSoftware'] = {
      '@type': 'Software',
      name: 'anthropic claude-haiku-4-5',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    };
    const person: components['schemas']['AgentPerson'] = { '@type': 'Person', name: 'Ada' };
    expect(software['@type']).toBe('Software');
    expect(person['@type']).toBe('Person');
  });

  it('an engine only Librarian actors ask is used for no job', () => {
    const entry: EngineEntry = { engine: { provider: 'ollama', model: 'llama3' } };
    expect(entry.jobs).toBeUndefined();
  });
});
