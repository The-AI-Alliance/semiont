/**
 * The stream's reader, held to protocol/specs/src/bus/frame-cases.json: the
 * table every SDK's stream reader runs.
 *
 * Each case's line is carried by a stream, and after it a frame of
 * `beckon:focus` that is read cleanly, so the stream is seen to go on past
 * it. What the transport delivers, what a typed read of `beckon:focus` is
 * given, and what the failure report is told are each held to the case.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom, takeWhile, toArray } from 'rxjs';
import { Bus, FrameRefusal, type EventMap, type Heard } from '@semiont/core';
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
}

const table: { cases: (Delivered | Refused)[] } = JSON.parse(
  readFileSync(new URL('../../../../../../protocol/specs/src/bus/frame-cases.json', import.meta.url), 'utf8'),
);
const delivered = table.cases.filter((stated): stated is Delivered => !('refused' in stated));
const refused = table.cases.filter((stated): stated is Refused => 'refused' in stated);

/** The channel every case told to its readers is on, read here by type. */
const READ = 'beckon:focus';
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
  const stream = createActorStateUnit({ baseUrl: 'http://localhost:4000', token: 'tok', channels: [READ, 'browse:resource-result'] });
  const told: { code: string; message: string }[] = [];
  stream.errors$.subscribe((error) => told.push({ code: error.code, message: error.message }));
  stream.start();
  await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
  return { sse, stream, told };
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
    const heard = firstValueFrom(
      new Bus({ ...stream, subscribeToResource: () => () => undefined }).frames(READ).pipe(takeWhile((one) => !isAfter(one), true), toArray()),
    );
    sse.push(sseChunk('bus-event', stated.data === undefined ? JSON.stringify(stated.frame) : stated.data));
    sse.push(sseChunk('bus-event', JSON.stringify(AFTER)));
    const before = (await heard).slice(0, -1);
    if (stated.told === 'readers') {
      expect(stated.frame?.channel).toBe(READ);
      expect(before).toHaveLength(1);
      const [refusal] = before;
      expect(refusal).toBeInstanceOf(FrameRefusal);
      expect({ ...refusal }).toEqual({ status: 'refused', channel: READ, member: stated.member, reason: stated.reason, payload: stated.frame?.payload });
      expect(told).toEqual([]);
    } else {
      expect(before).toEqual([]);
      expect(told).toEqual([{ code: 'error', message: `the stream carried what is not a frame: ${said(stated.member, stated.reason)}` }]);
    }
    stream.dispose();
  });
});
