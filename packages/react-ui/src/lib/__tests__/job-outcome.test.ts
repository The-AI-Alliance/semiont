import { describe, it, expect } from 'vitest';
import { declineReason } from '../job-outcome';

// `declinedMessage` was DELETED by P5, not aliased: the wire no longer carries
// a sentence to return. Its pins are superseded by the `declineReason` block.

describe('declineReason', () => {
  it('returns the typed reason, never a wire-supplied sentence', () => {
    expect(declineReason({ declined: true, reason: 'no-text-layer' })).toBe('no-text-layer');
    expect(declineReason({ declined: true, reason: 'encrypted' })).toBe('encrypted');
  });

  it('is null for an ordinary result', () => {
    expect(declineReason({ highlightsFound: 3 })).toBeNull();
    expect(declineReason(undefined)).toBeNull();
    expect(declineReason({ declined: false, reason: 'empty' })).toBeNull();
  });

  it('is null for a reason outside the vocabulary — never renders a raw string', () => {
    // A reason this client does not know has no copy; showing the bare token
    // would be the untranslated leak this phase exists to remove.
    expect(declineReason({ declined: true, reason: 'something-new' })).toBeNull();
  });
});
