/**
 * The Resource Info panel says where the text layer stands — the user-facing
 * face of `smelt:settled`.
 *
 * The row renders the wire's own vocabulary, translated: extracted → Ready,
 * not-yet → Preparing, declined → None, no-map → Not applicable. `unknown`
 * and not-yet-asked render NO row — no claim, no invented state. A bridged
 * `smelt:settled` for THIS resource refreshes the row in place.
 */
import { resourceId } from '@semiont/core';
import type { AnchoredTextAnswer } from '@semiont/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { screen, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createTestSemiontWrapper, renderInEnglish } from '../../../../test-utils';
import { ResourceInfoPanel } from '../ResourceInfoPanel';
import type { SemiontSession } from '@semiont/sdk';

const props = {
  resourceId: resourceId('res-tl'),
  documentEntityTypes: [],
  session: null as SemiontSession | null,
};

const EXTRACTED: AnchoredTextAnswer = { kind: 'extracted', method: 'pdf-text-layer', text: '', items: [] };

function mountWithAnswer(answer: AnchoredTextAnswer) {
  const { SemiontWrapper, eventBus, client, session } = createTestSemiontWrapper();
  const ask = vi.spyOn(client.browse, 'resourceAnchoredText').mockResolvedValue(answer);
  renderInEnglish(React.cloneElement(<ResourceInfoPanel {...props} />, { session }), { wrapper: SemiontWrapper });
  return { eventBus, ask };
}

describe('ResourceInfoPanel — text layer status', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('not-yet renders Preparing', async () => {
    mountWithAnswer({ kind: 'not-yet' });
    expect(await screen.findByText(/preparing/i)).toBeInTheDocument();
    expect(screen.getByText('Text layer')).toBeInTheDocument();
  });

  it('extracted renders Ready', async () => {
    mountWithAnswer(EXTRACTED);
    expect(await screen.findByText('Ready')).toBeInTheDocument();
  });

  it('declined renders None; no-map renders Not applicable', async () => {
    mountWithAnswer({ kind: 'declined', declined: 'no-text-layer' });
    expect(await screen.findByText(/none/i)).toBeInTheDocument();
  });

  it('unknown renders no row — no claim, no invented state', async () => {
    const { ask } = mountWithAnswer({ kind: 'unknown' });
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(screen.queryByText('Text layer')).not.toBeInTheDocument();
  });

  it("this resource's smelt:settled refreshes the row in place", async () => {
    const { eventBus, ask } = mountWithAnswer({ kind: 'not-yet' });
    await screen.findByText(/preparing/i);
    ask.mockResolvedValue(EXTRACTED);

    act(() => {
      eventBus.emit('smelt:settled', { resourceId: 'res-tl', contentChecksum: 'c', outcome: 'indexed' } as never);
    });

    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText(/preparing/i)).not.toBeInTheDocument();
  });

  it("another resource's settle does not refetch", async () => {
    const { eventBus, ask } = mountWithAnswer({ kind: 'not-yet' });
    await screen.findByText(/preparing/i);
    const calls = ask.mock.calls.length;

    act(() => {
      eventBus.emit('smelt:settled', { resourceId: 'OTHER', contentChecksum: 'c', outcome: 'indexed' } as never);
    });

    await waitFor(() => expect(ask.mock.calls.length).toBe(calls));
  });
});
