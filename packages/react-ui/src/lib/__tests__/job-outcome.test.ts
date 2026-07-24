import { describe, it, expect } from 'vitest';
import { declinedMessage } from '../job-outcome';

describe('declinedMessage', () => {
  it('returns the message for a declined result (scanned-PDF no-text-layer)', () => {
    expect(
      declinedMessage({ declined: true, reason: 'no-text-layer', message: 'No extractable text layer.' }),
    ).toBe('No extractable text layer.');
  });

  it('returns null for an ordinary annotation result', () => {
    expect(declinedMessage({ highlightsFound: 3, highlightsCreated: 3 })).toBeNull();
  });

  it('returns null for undefined, non-objects, and malformed declines', () => {
    expect(declinedMessage(undefined)).toBeNull();
    expect(declinedMessage(null)).toBeNull();
    expect(declinedMessage('nope')).toBeNull();
    expect(declinedMessage({ declined: true })).toBeNull();               // declined but no message
    expect(declinedMessage({ declined: false, message: 'x' })).toBeNull(); // has message but not declined
  });
});
