/**
 * Type-level guard — COLLABORATOR-DIRECTORY P1.
 *
 * Pins the `browse:agents` OPERATION, not just its schemas: the request
 * channel must be a registered `BusOperationKey` (which transitively requires
 * the EventMap + CHANNEL_SCHEMAS entries and derives the replies into
 * `BRIDGED_CHANNELS`), and `BusReply` must infer the reply-shape-standard
 * payload `{ agents: CollaboratorEntry[] }` from the result channel. Entries
 * cover both halves of the directory from day one — a Software agent with
 * structured `provider`/`model` and capabilities, and a Person without
 * `servesJobTypes` — so P4 (Persons) needs no schema rework.
 *
 * Enforced by `tsc --noEmit` (core `typecheck`), not vitest runtime. RED
 * before the spec + registration land (no such channel/operation); GREEN
 * after.
 */
import { describe, it, expect } from 'vitest';
import type { components } from '../types';
import type { BusOperationKey } from '../bus-operations';
import type { BusReply } from '../bus-request';

type CollaboratorEntry = components['schemas']['CollaboratorEntry'];

describe('browse:agents — operation + reply-shape guard (P1)', () => {
  it('the request channel is a registered bus operation', () => {
    const op: BusOperationKey = 'browse:agents-requested';
    expect(op).toBe('browse:agents-requested');
  });

  it('the reply infers as { agents: CollaboratorEntry[] } via the registry', () => {
    const reply: BusReply<'browse:agents-requested'> = { agents: [] };
    const entries: CollaboratorEntry[] = reply.agents;
    expect(entries).toEqual([]);
  });

  it('an entry admits a Software agent with structured provider/model and capabilities', () => {
    const entry: CollaboratorEntry = {
      agent: {
        '@type': 'Software',
        '@id': 'did:web:kb.example:agents:anthropic:claude-haiku-4-5',
        name: 'anthropic claude-haiku-4-5',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      },
      servesJobTypes: ['highlight-annotation', 'generation'],
    };
    expect(entry.agent['@type']).toBe('Software');
  });

  it('an entry admits a Person WITHOUT servesJobTypes (P4 composes into the same shape)', () => {
    const entry: CollaboratorEntry = {
      agent: {
        '@type': 'Person',
        '@id': 'did:web:kb.example:users:ada%40kb.example',
        name: 'Ada',
      },
    };
    expect(entry.servesJobTypes).toBeUndefined();
  });
});
