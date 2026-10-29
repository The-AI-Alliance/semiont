/**
 * `useAnchoredText` — what a viewer holds of a resource's text, tested without
 * a canvas.
 *
 * The rule the canvases keep is that a person may annotate only while the
 * viewer holds the text. This is the one place that holds it, so every answer
 * the read can give is driven here, on fake timers, over a REAL
 * `SemiontSession` from `@semiont/sdk/testing`. The one read the hook makes,
 * `browse.resourceAnchoredText`, is answered by a spy on the session's own
 * client: the hook depends on that method's answer, not on what carries it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createTestSession } from '@semiont/sdk/testing';
import type { SemiontSession } from '@semiont/sdk';
import { ANCHORED_TEXT_REASK_MS, resourceId } from '@semiont/core';
import type { AnchoredTextAnswer } from '@semiont/core';
import { useAnchoredText } from '../useAnchoredText';

const RESOURCE = resourceId('res-anchored-1');

const NOT_YET: AnchoredTextAnswer = { kind: 'not-yet' };
const HELLO: AnchoredTextAnswer = {
  kind: 'extracted',
  method: 'pdf-text-layer',
  text: 'Hello\n',
  items: [{ start: 0, end: 5, page: 1, x: 72, y: 700, width: 30, height: 12 }],
};

/** A session whose anchored-text read gives `replies` in turn, the last of
 *  them again for every ask after it. An `Error` is an ask that fails. */
function sessionAnswering(replies: Array<AnchoredTextAnswer | Error>) {
  const { session, client } = createTestSession();
  let asked = 0;
  const ask = vi.spyOn(client.browse, 'resourceAnchoredText').mockImplementation(async () => {
    const reply = replies[Math.min(asked++, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { session, ask };
}

/** Let an ask already made be answered. */
const answered = () => act(() => vi.advanceTimersByTimeAsync(0));
const pass = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('useAnchoredText', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks when it mounts, and holds nothing before the first answer arrives', () => {
    const { session, client } = createTestSession();
    const ask = vi.spyOn(client.browse, 'resourceAnchoredText')
      .mockImplementation(() => new Promise<AnchoredTextAnswer>(() => { /* never answered */ }));

    const { result } = renderHook(() => useAnchoredText(session, RESOURCE));

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(RESOURCE);
    expect(result.current).toEqual({ status: 'waiting' });
  });

  it('holds the text an `extracted` answer gives, and does not ask again', async () => {
    const { session, ask } = sessionAnswering([HELLO]);
    const { result } = renderHook(() => useAnchoredText(session, RESOURCE));

    await answered();
    expect(result.current).toEqual({ status: 'held', text: HELLO });

    await pass(ANCHORED_TEXT_REASK_MS * 10);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('holds an `extracted` text that is empty: the document was read and has no words', async () => {
    const { session } = sessionAnswering([{ kind: 'extracted', method: 'ocr', text: '', items: [] }]);
    const { result } = renderHook(() => useAnchoredText(session, RESOURCE));

    await answered();
    expect(result.current.status).toBe('held');
    expect(result.current).toMatchObject({ text: { text: '', items: [] } });
  });

  it('holds an empty text on `no-map`: the media type has none, and does not ask again', async () => {
    const { session, ask } = sessionAnswering([{ kind: 'no-map' }]);
    const { result } = renderHook(() => useAnchoredText(session, RESOURCE));

    await answered();
    expect(result.current).toEqual({ status: 'held', text: { text: '', items: [] } });

    await pass(ANCHORED_TEXT_REASK_MS * 10);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks again after the wait when the answer is `not-yet`, and holds the text when it lands', async () => {
    const { session, ask } = sessionAnswering([NOT_YET, HELLO]);
    const { result } = renderHook(() => useAnchoredText(session, RESOURCE));

    await answered();
    expect(result.current).toEqual({ status: 'waiting' });

    // Not a moment before the wait is over.
    await pass(ANCHORED_TEXT_REASK_MS - 1);
    expect(ask).toHaveBeenCalledTimes(1);

    await pass(1);
    expect(ask).toHaveBeenCalledTimes(2);
    await answered();
    expect(result.current).toEqual({ status: 'held', text: HELLO });

    // The text is held: the asking is over.
    await pass(ANCHORED_TEXT_REASK_MS * 10);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('asks again after the wait when the ask failed, and holds the text when it lands', async () => {
    const { session, ask } = sessionAnswering([new Error('no answer'), HELLO]);
    const { result } = renderHook(() => useAnchoredText(session, RESOURCE));

    await answered();
    expect(result.current).toEqual({ status: 'waiting' });

    await pass(ANCHORED_TEXT_REASK_MS - 1);
    expect(ask).toHaveBeenCalledTimes(1);

    await pass(1);
    expect(ask).toHaveBeenCalledTimes(2);
    await answered();
    expect(result.current).toEqual({ status: 'held', text: HELLO });
  });

  it('keeps asking at the one wait for as long as the answer is `not-yet`', async () => {
    const { session, ask } = sessionAnswering([NOT_YET]);
    const { result } = renderHook(() => useAnchoredText(session, RESOURCE));
    await answered();

    for (let asks = 2; asks <= 6; asks++) {
      await pass(ANCHORED_TEXT_REASK_MS);
      expect(ask).toHaveBeenCalledTimes(asks);
      await answered();
    }
    expect(result.current).toEqual({ status: 'waiting' });
  });

  it.each<[string, AnchoredTextAnswer]>([
    ['`declined`', { kind: 'declined', declined: 'no-text-layer' }],
    ['`unknown`', { kind: 'unknown' }],
  ])('will never hold a text after %s, and does not ask again', async (_name, answer) => {
    const { session, ask } = sessionAnswering([answer]);
    const { result } = renderHook(() => useAnchoredText(session, RESOURCE));

    await answered();
    expect(result.current).toEqual({ status: 'never' });

    await pass(ANCHORED_TEXT_REASK_MS * 10);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ status: 'never' });
  });

  it('starts over for another resource, holding nothing of the first one meanwhile', async () => {
    const first = resourceId('res-first');
    const second = resourceId('res-second');
    const { session, client } = createTestSession();
    const ask = vi.spyOn(client.browse, 'resourceAnchoredText')
      .mockImplementation(async (id) => (id === first ? HELLO : NOT_YET));

    const { result, rerender } = renderHook(({ id }) => useAnchoredText(session, id), {
      initialProps: { id: first },
    });
    await answered();
    expect(result.current).toEqual({ status: 'held', text: HELLO });

    // The render that names the second resource already holds nothing: the
    // first one's text is never a second one's.
    rerender({ id: second });
    expect(result.current).toEqual({ status: 'waiting' });
    expect(ask).toHaveBeenLastCalledWith(second);

    await answered();
    expect(result.current).toEqual({ status: 'waiting' });
  });

  it('stops asking when it unmounts', async () => {
    const { session, ask } = sessionAnswering([NOT_YET]);
    const { unmount } = renderHook(() => useAnchoredText(session, RESOURCE));
    await answered();
    expect(ask).toHaveBeenCalledTimes(1);

    unmount();
    await pass(ANCHORED_TEXT_REASK_MS * 10);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks nothing with no session, and asks when one arrives', async () => {
    const { session, ask } = sessionAnswering([HELLO]);
    const { result, rerender } = renderHook(
      ({ current }: { current: SemiontSession | null }) => useAnchoredText(current, RESOURCE),
      { initialProps: { current: null as SemiontSession | null } },
    );

    expect(result.current).toEqual({ status: 'unasked' });
    await pass(ANCHORED_TEXT_REASK_MS * 10);
    expect(ask).not.toHaveBeenCalled();

    rerender({ current: session });
    expect(result.current).toEqual({ status: 'waiting' });
    await answered();
    expect(result.current).toEqual({ status: 'held', text: HELLO });
  });
});
