/**
 * `registerBindUpdateBodyHandler` — the Bind flow's relay, which had NO test.
 *
 * That absence is most of why
 * `.plans/bugs/bind-body-update-failed-never-crosses.md` survived the
 * Archivist extraction: the relay's failure leg never ran anywhere, and the
 * suites that exercise binding at all drive only the success path. The bug
 * file asks specifically for "a test that drives a FAILING body update
 * end-to-end"; these are that, plus the legs around it.
 *
 * What this file CANNOT prove, and what does the other half: whether the
 * Archivist's failure signal reaches this handler when the two are different
 * processes. On one bus every channel is delivered, so the crossing bug is
 * invisible here by construction. `gateway-handler-census.test.ts` holds that
 * — no channel either roster names may be classified `in-process`, because
 * the bridge carries neither direction for one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { firstValueFrom, take, timeout } from 'rxjs';
import { EventBus, type BusFrame, type EventMap, type Logger } from '@semiont/core';
import { registerBindUpdateBodyHandler } from '../bind-update-body';

const silentLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => silentLogger),
};

const CID = 'cid-bind-1';
const ANN = 'urn:semiont:ann-1';
const RES = 'urn:semiont:res-1';
const USER = 'did:semiont:user-1';

const COMMAND = {
  annotationId: ANN,
  resourceId: RES,
  _userId: USER,
  operations: [{ op: 'add', item: { type: 'SpecificResource', source: RES } }],
} as unknown as EventMap['bind:update-body'];

describe('bind:update-body relay', () => {
  let bus: EventBus;

  /** The first frame on `channel`, or a rejection if none arrives. */
  const next = <K extends keyof EventMap>(channel: K): Promise<BusFrame<EventMap[K]>> =>
    firstValueFrom(bus.frames(channel).pipe(take(1), timeout(200)));

  beforeEach(() => {
    bus = new EventBus();
    registerBindUpdateBodyHandler(bus, silentLogger);
  });

  afterEach(() => bus.destroy());

  it('forwards to mark:update-body with the key on the ENVELOPE', async () => {
    const forwarded = next('mark:update-body');
    bus.emit('bind:update-body', COMMAND, { correlationId: CID });

    const frame = await forwarded;
    expect(frame.correlationId).toBe(CID);
    expect(frame.payload).toMatchObject({ annotationId: ANN, resourceId: RES, _userId: USER });
    // The key is a routing fact; it must not have been copied into the body.
    expect('correlationId' in (frame.payload as object)).toBe(false);
  });

  it('answers bind:body-updated once the Archivist reports the fact', async () => {
    bus.emit('bind:update-body', COMMAND, { correlationId: CID });

    const confirmed = next('bind:body-updated');
    bus.emit(
      'mark:body-updated',
      { metadata: { sequenceNumber: 1 } } as unknown as EventMap['mark:body-updated'],
      { correlationId: CID },
    );

    expect((await confirmed).correlationId).toBe(CID);
  });

  // ── the leg the bug is about ─────────────────────────────────────────────

  it('answers bind:body-update-failed CARRYING THE REASON when persistence fails', async () => {
    // The whole point of the relay: the caller learns the real outcome rather
    // than waiting out a 30 s `bus.timeout` with no cause attached.
    bus.emit('bind:update-body', COMMAND, { correlationId: CID });

    const failed = next('bind:body-update-failed');
    bus.emit(
      'mark:body-update-failed',
      { message: 'log unwritable' } as unknown as EventMap['mark:body-update-failed'],
      { correlationId: CID },
    );

    const frame = await failed;
    expect(frame.correlationId).toBe(CID);
    expect(frame.payload.message).toBe('log unwritable');
  });

  it('ignores an outcome for a correlation it never forwarded', async () => {
    // Another client's failure must not resolve this relay's caller. Nothing
    // is in flight, so nothing may be answered.
    const failed = next('bind:body-update-failed');
    bus.emit(
      'mark:body-update-failed',
      { message: 'someone else' } as unknown as EventMap['mark:body-update-failed'],
      { correlationId: 'cid-not-mine' },
    );

    await expect(failed).rejects.toThrow();
  });

  it('answers each outcome ONCE — a duplicate delivery is not a second reply', async () => {
    bus.emit('bind:update-body', COMMAND, { correlationId: CID });

    const replies: string[] = [];
    bus.frames('bind:body-update-failed').subscribe((f) => replies.push(String(f.payload.message)));
    const fail = { message: 'log unwritable' } as unknown as EventMap['mark:body-update-failed'];
    bus.emit('mark:body-update-failed', fail, { correlationId: CID });
    bus.emit('mark:body-update-failed', fail, { correlationId: CID });

    expect(replies).toEqual(['log unwritable']);
  });

  it('refuses before forwarding when the gateway injected no _userId', async () => {
    const failed = next('bind:body-update-failed');
    const { _userId: _dropped, ...anonymous } = COMMAND as unknown as Record<string, unknown>;
    bus.emit('bind:update-body', anonymous as EventMap['bind:update-body'], { correlationId: CID });

    expect((await failed).payload.message).toMatch(/_userId/);
  });
});
