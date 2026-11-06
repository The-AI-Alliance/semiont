/**
 * The stream's reader, held to protocol/specs/src/bus/frame-cases.json: the
 * table every SDK's stream reader runs.
 *
 * Each case's line is carried by a stream, and after it a frame of
 * `beckon:focus` that is read cleanly, so the stream is seen to go on past
 * it. What the transport delivers, what a typed read of the case's channel is
 * given, what the failure report is told, and what becomes of a request
 * awaiting the case's reply are each held to the case.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { filter, firstValueFrom } from 'rxjs';
import { Bus, FrameRefusal, SemiontError, type EventMap, type Heard } from '@semiont/core';
import { createActorStateUnit } from '../actor-state-unit';
import { mockFetch, mockSSEResponse, sseChunk } from './helpers/mock-conn';

type Frame = { readonly channel: keyof EventMap; readonly payload: unknown; readonly correlationId?: string; readonly scope?: string };

interface Delivered {
  readonly why: string;
  readonly frame: Frame;
}

interface Refused {
  readonly why: string;
  readonly frame?: Record<string, unknown>;
  readonly data?: string;
  readonly refused: true;
  readonly member: string;
  readonly reason: 'lacks' | 'malformed';
  readonly told: 'readers' | 'failure-report';
  readonly correlationId?: string;
  readonly request?: 'fails' | 'waits';
}

const table: { cases: (Delivered | Refused)[] } = JSON.parse(
  readFileSync(new URL('../../../../../../protocol/specs/src/bus/frame-cases.json', import.meta.url), 'utf8'),
);
const delivered = table.cases.filter((stated): stated is Delivered => !('refused' in stated));
const refused = table.cases.filter((stated): stated is Refused => 'refused' in stated);

/** The channel every case told to its readers is on, but a request's, read here by type. */
const READ = 'beckon:focus';
/** The operation a request's case awaits the reply of, and the reply's channels. */
const REQUEST = 'browse:resource-requested';
const REPLIES = ['browse:resource-result', 'browse:resource-failed'] as const;
/** The correlation id a request's case names its request's by. */
const AWAITED = 'c-1';
/** The frame each case's line is followed by. */
const AFTER = { channel: READ, payload: { resourceId: 'after' } };

/** A fault in the words every SDK says one in. */
function said(member: string, reason: Refused['reason']): string {
  if (reason === 'lacks') return `it has no \`${member}\``;
  return member === '' ? 'it is malformed' : `its \`${member}\` is malformed`;
}

function isAfter(heard: Heard<EventMap[typeof READ]>): boolean {
  return heard.status === 'delivered' && heard.payload.resourceId === AFTER.payload.resourceId;
}

/** A transport's stream, carrying the lines it is given. */
async function carrying() {
  const sse = mockSSEResponse();
  const stream = createActorStateUnit({ baseUrl: 'http://localhost:4000', token: 'tok', channels: [READ, ...REPLIES] });
  const told: { code: string; message: string }[] = [];
  stream.errors$.subscribe((error) => told.push({ code: error.code, message: error.message }));
  stream.start();
  await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
  return { sse, stream, told };
}

/** The request a request's case awaits the reply of, and the correlation id it sent, which stands in for `c-1`. */
async function asking(bus: Bus) {
  mockFetch.mockResolvedValueOnce({ ok: true });
  let settled: { readonly error: unknown } | 'answered' | undefined;
  void bus.request(REQUEST, { resourceId: 'res-1' }, 60_000).then(
    () => { settled = 'answered'; },
    (error: unknown) => { settled = { error }; },
  );
  await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  const [, sent] = mockFetch.mock.calls[1] as [string, { body: string }];
  const { correlationId } = JSON.parse(sent.body) as { correlationId: string };
  return { correlationId, settled: () => settled };
}

describe('frame-cases.json', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockFetch.mockReset();
  });

  it('has a frame of each kind', () => {
    expect(delivered.length).toBeGreaterThan(0);
    expect(new Set(refused.map((stated) => stated.reason))).toEqual(new Set(['lacks', 'malformed']));
    expect(new Set(refused.map((stated) => stated.told))).toEqual(new Set(['readers', 'failure-report']));
    expect(new Set(refused.flatMap((stated) => (stated.request === undefined ? [] : [stated.request])))).toEqual(new Set(['fails', 'waits']));
  });

  it.each(delivered.map((stated) => [stated.why, stated] as const))('%s', async (_why, stated) => {
    const { sse, stream, told } = await carrying();
    const read = firstValueFrom(stream.frames(stated.frame.channel));
    sse.push(sseChunk('bus-event', JSON.stringify(stated.frame)));
    const { channel: _channel, ...envelope } = stated.frame;
    expect(await read).toEqual(envelope);
    expect(told).toEqual([]);
    stream.dispose();
  });

  it.each(refused.map((stated) => [stated.why, stated] as const))('%s', async (_why, stated) => {
    const { sse, stream, told } = await carrying();
    const bus = new Bus({ ...stream, subscribeToResource: () => () => undefined });
    const request = stated.request === undefined ? undefined : await asking(bus);
    // The request's own correlation id, in place of the one the case names it by.
    const frame = request !== undefined && stated.frame?.['correlationId'] === AWAITED ? { ...stated.frame, correlationId: request.correlationId } : stated.frame;
    const carried = stated.correlationId === AWAITED && request !== undefined ? request.correlationId : stated.correlationId;
    const channel: keyof EventMap = frame?.['channel'] === REPLIES[0] ? REPLIES[0] : READ;

    const heard: Heard<EventMap[keyof EventMap]>[] = [];
    const reading = bus.frames(channel).subscribe((one) => heard.push(one));
    const after = firstValueFrom(bus.frames(READ).pipe(filter(isAfter)));
    sse.push(sseChunk('bus-event', stated.data === undefined ? JSON.stringify(frame) : stated.data));
    sse.push(sseChunk('bus-event', JSON.stringify(AFTER)));
    await after;
    reading.unsubscribe();
    const before = channel === READ ? heard.slice(0, -1) : heard;

    if (stated.told === 'readers') {
      expect(frame?.['channel']).toBe(channel);
      expect(before).toHaveLength(1);
      const [refusal] = before;
      expect(refusal).toBeInstanceOf(FrameRefusal);
      expect({ ...refusal }).toEqual({
        status: 'refused',
        channel,
        member: stated.member,
        reason: stated.reason,
        payload: frame?.['payload'],
        ...(carried === undefined ? {} : { correlationId: carried }),
      });
      expect(told).toEqual([]);
    } else {
      expect(before).toEqual([]);
      expect(told).toEqual([{ code: 'error', message: `the stream carried what is not a frame: ${said(stated.member, stated.reason)}` }]);
    }

    if (request !== undefined && stated.request === 'fails') {
      await vi.waitFor(() => expect(request.settled()).not.toBeUndefined());
      const settled = request.settled();
      if (settled === undefined || settled === 'answered') throw new Error('the request was answered, not failed');
      expect(settled.error).toBeInstanceOf(SemiontError);
      expect(settled.error).toMatchObject({ code: 'error', message: `a frame on ${channel} is not that channel's: ${said(stated.member, stated.reason)}` });
    }
    if (request !== undefined && stated.request === 'waits') {
      expect(request.settled()).toBeUndefined();
    }
    stream.dispose();
  });
});
