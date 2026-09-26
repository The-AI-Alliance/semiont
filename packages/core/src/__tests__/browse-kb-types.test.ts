/**
 * The knowledge base describes itself over the bus: `browse:kb` is a
 * registered operation that only reads, and its reply is the committed name
 * and domain plus the working tree's branch when there is one.
 *
 * The reply's shape is enforced by `tsc --noEmit` (core `typecheck`); the
 * registration and the read classification by vitest.
 */
import { describe, it, expect } from 'vitest';
import { BUS_OPERATIONS, type BusOperationKey } from '../bus-operations';
import { CHANNEL_ATTRS } from '../bus-classification';
import type { BusReply } from '../bus-request';

describe('browse:kb — the knowledge base describes itself', () => {
  it('is a registered operation that reads', () => {
    const op: BusOperationKey = 'browse:kb-requested';
    expect(BUS_OPERATIONS[op]).toEqual({ result: 'browse:kb-result', failure: 'browse:kb-failed' });
    expect(CHANNEL_ATTRS[op]).toMatchObject({ writes: false });
  });

  it('replies with the name and domain, and the branch only when the tree is on one', () => {
    const onBranch: BusReply<'browse:kb-requested'> = { name: 'KB', domain: 'example.github.io:kb', gitBranch: 'main' };
    const noBranch: BusReply<'browse:kb-requested'> = { name: 'KB', domain: 'example.github.io:kb' };
    expect([onBranch.gitBranch, noBranch.gitBranch]).toEqual(['main', undefined]);
  });
});
