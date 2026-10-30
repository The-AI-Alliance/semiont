/**
 * Type-level guard — the roster's bus operation.
 *
 * Pins the `browse:agents` OPERATION, not just its schemas: the request
 * channel must be a registered `BusOperationKey` (which transitively requires
 * the EventMap + CHANNEL_SCHEMAS entries and derives the replies into
 * `BRIDGED_CHANNELS`), and `BusReply` must infer the reply-shape-standard
 * payload `{ agents: RosterEntry[] }` from the result channel. An entry is an
 * engine — a provider and a model — with the jobs it serves, or without them
 * when it is declared only under actor roles. It carries no identity.
 *
 * Enforced by `tsc --noEmit` (core `typecheck`), not vitest runtime.
 */
import { describe, it, expect } from 'vitest';
import type { components } from '../types';
import type { BusOperationKey } from '../bus-operations';
import type { BusReply } from '../bus-request';

type RosterEntry = components['schemas']['RosterEntry'];

describe('browse:agents — operation + reply-shape guard', () => {
  it('the request channel is a registered bus operation', () => {
    const op: BusOperationKey = 'browse:agents-requested';
    expect(op).toBe('browse:agents-requested');
  });

  it('the reply infers as { agents: RosterEntry[] } via the registry', () => {
    const reply: BusReply<'browse:agents-requested'> = { agents: [] };
    const entries: RosterEntry[] = reply.agents;
    expect(entries).toEqual([]);
  });

  it('an entry is an engine, a provider and a model, with the jobs it serves', () => {
    const entry: RosterEntry = {
      engine: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      serves: [{ jobType: 'mark', params: { motivation: 'highlighting' } }, { jobType: 'yield' }],
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

  it('an engine declared only under actor roles serves no job', () => {
    const entry: RosterEntry = { engine: { provider: 'ollama', model: 'llama3' } };
    expect(entry.serves).toBeUndefined();
  });
});
