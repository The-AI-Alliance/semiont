import { describe, it, expect } from 'vitest';
import { declineReason } from '../job-outcome';

// Decline reasons are codes: the wire carries no sentence to return.

describe('declineReason', () => {
  it('returns the typed reason, never a wire-supplied sentence', () => {
    expect(declineReason({ declined: true, reason: 'no-text-layer' })).toBe('no-text-layer');
    expect(declineReason({ declined: true, reason: 'encrypted' })).toBe('encrypted');
  });

  it('is null for an ordinary result', () => {
    expect(declineReason({ found: 3, persisted: 3 })).toBeNull();
    expect(declineReason(undefined)).toBeNull();
    expect(declineReason({ declined: false, reason: 'empty' })).toBeNull();
  });

  it('is null for a reason outside the vocabulary — never renders a raw string', () => {
    // A reason this client does not know has no copy; showing the bare token
    // would be an untranslated leak.
    expect(declineReason({ declined: true, reason: 'something-new' })).toBeNull();
  });
});
