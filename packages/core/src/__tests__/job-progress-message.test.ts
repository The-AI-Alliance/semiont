/**
 * A6 (type half): a progress event carries a code and typed params, never a
 * prose sentence. The wire schema is
 * the contract; this pin fails to compile if `JobProgress.message` regresses
 * to a free string, and if the code vocabulary loses a census-derived member.
 */
import { describe, it, expect } from 'vitest';
import type { components } from '../types.js';

type JobProgress = components['schemas']['JobProgress'];
type JobProgressMessage = components['schemas']['JobProgressMessage'];
type Message = NonNullable<JobProgress['message']>;

describe('JobProgress message shape (A6, type half)', () => {
  it('message is the coded JobProgressMessage object, never prose', () => {
    // @ts-expect-error — a prose sentence must not be assignable to message
    const prose: Message = 'Loading resource...';
    void prose;

    const bare: Message = { code: 'loading' };
    const detecting: Message = { code: 'detecting-entities', entityType: 'Person' };
    const creating: Message = { code: 'creating-annotations', count: 3 };
    const done: Message = { code: 'complete-created', count: 3, kind: 'highlight' };
    // Generation's terminal success — generic (no name field: the client holds
    // the title it typed) plus the truncation bit.
    const generated: Message = { code: 'complete-generated', truncated: false };
    expect([bare, detecting, creating, done, generated].every((m) => typeof m === 'object')).toBe(true);
  });

  it('params are required where the census requires them', () => {
    // @ts-expect-error — creating-annotations without count is not a message
    const missingCount: JobProgressMessage = { code: 'creating-annotations' };
    void missingCount;
    // @ts-expect-error — complete-created without kind is not a message
    const missingKind: JobProgressMessage = { code: 'complete-created', count: 3 };
    void missingKind;
  });
});
