/**
 * HttpTransport `channels` config — the narrowed-subscription seam.
 *
 * Reply channels are global fan-out on the gateway, so a full
 * `BRIDGED_CHANNELS` subscription delivers every other client's reply
 * traffic too. A narrow-profile process (the worker) passes exactly the
 * reply channels it awaits; `isSubscribed` is the probe `busRequest` uses
 * to fail fast on anything outside the set (worker OOM, 2026-09-03).
 */

import { describe, it, expect } from 'vitest';
import { BRIDGED_CHANNELS, baseUrl } from '@semiont/core';
import { HttpTransport } from '../http-transport';

const BASE = baseUrl('http://localhost:4000');

describe('HttpTransport channels config', () => {
  it('subscribes the full bridged set when no channels are configured', () => {
    const transport = new HttpTransport({ baseUrl: BASE });
    for (const channel of BRIDGED_CHANNELS) {
      expect(transport.isSubscribed(channel)).toBe(true);
    }
    transport.dispose();
  });

  it('narrows the global subscription to exactly the configured channels', () => {
    const transport = new HttpTransport({
      baseUrl: BASE,
      channels: ['job:claimed', 'job:claim-failed'],
    });
    expect(transport.isSubscribed('job:claimed')).toBe(true);
    expect(transport.isSubscribed('job:claim-failed')).toBe(true);
    expect(transport.isSubscribed('browse:annotations-result')).toBe(false);
    expect(transport.isSubscribed('browse:resources-result')).toBe(false);
    transport.dispose();
  });
});
