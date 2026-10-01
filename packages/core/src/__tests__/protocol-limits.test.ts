/**
 * The spec's limits against the one relationship core also holds a side of:
 * a reply is retained for recovery at least twice as long as `busRequest`
 * waits for it, so a caller that times out and reconnects still finds it.
 */
import { describe, expect, it } from 'vitest';
import { BUS_REQUEST_TIMEOUT_MS } from '../generated/client-timing';
import { operationLimits } from '../openapi';

describe('protocol limits', () => {
  it('a reply outlives two busRequest deadlines', () => {
    expect(operationLimits['POST /bus/subscribe'].replyRetentionSeconds * 1000).toBeGreaterThanOrEqual(2 * BUS_REQUEST_TIMEOUT_MS);
  });
});
