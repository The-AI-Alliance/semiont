import { describe, expect, it } from 'vitest';
import { agentLabel, attestationOf, relativeTime } from './attestation';

const NOW = Date.parse('2026-07-07T12:00:00Z');

describe('agentLabel (Browser convention: Software from structured fields)', () => {
  it('composes provider + model for Software agents', () => {
    expect(agentLabel({ '@type': 'Software', name: 'x', provider: 'anthropic', model: 'claude-x' })).toBe(
      'anthropic claude-x',
    );
  });
  it('falls back to name, then @id', () => {
    expect(agentLabel({ '@type': 'Person', name: 'Ada' })).toBe('Ada');
    expect(agentLabel({ '@type': 'Software', name: 'KB AI' })).toBe('KB AI');
  });
});

describe('relativeTime', () => {
  it('renders minutes/hours/days ago', () => {
    expect(relativeTime('2026-07-07T11:58:30Z', NOW)).toBe('just now');
    expect(relativeTime('2026-07-07T11:15:00Z', NOW)).toBe('45m ago');
    expect(relativeTime('2026-07-07T03:00:00Z', NOW)).toBe('9h ago');
    expect(relativeTime('2026-07-04T12:00:00Z', NOW)).toBe('3d ago');
  });
});

describe('attestationOf (the Browser panel attestation: By … · when / Via …)', () => {
  it('human-prompted AI work: By the Person creator, Via the Software generator', () => {
    const att = attestationOf(
      {
        creator: { '@type': 'Person', name: 'admin@example.com' },
        generator: { '@type': 'Software', name: 'x', provider: 'anthropic', model: 'claude-x' },
        created: '2026-07-07T11:00:00Z',
      },
      NOW,
    );
    expect(att).toEqual({ by: 'admin@example.com', via: 'anthropic claude-x', when: '1h ago' });
  });

  it('manual work: By only — no Via line', () => {
    const att = attestationOf(
      { creator: { '@type': 'Person', name: 'admin@example.com' }, created: '2026-07-07T11:00:00Z' },
      NOW,
    );
    expect(att).toEqual({ by: 'admin@example.com', when: '1h ago' });
  });

  it('handles a string creator and generator pipelines (array joins)', () => {
    const att = attestationOf(
      {
        creator: 'admin@example.com',
        generator: [
          { '@type': 'Software', name: 'a', provider: 'p1', model: 'm1' },
          { '@type': 'Software', name: 'b', provider: 'p2', model: 'm2' },
        ],
      },
      NOW,
    );
    expect(att).toEqual({ by: 'admin@example.com', via: 'p1 m1, p2 m2' });
  });

  it('returns null when the annotation carries no provenance at all', () => {
    expect(attestationOf({}, NOW)).toBeNull();
  });
});
