/**
 * KB-IDENTITY-CHECKED-ON-ACTIVATION P2: the substitution is rendered honestly.
 *
 * The signal fires after P1 has already voided the tab/last-viewed state: this
 * modal only TELLS. Honesty is KB-IDENTITY-VS-ADDRESS decision 7 — the KB the
 * entry names and the identity that answered are shown as two distinct facts,
 * both dids verbatim, and the newcomer is never presented under the registered
 * label. The route forward is the Knowledge Base panel, which owns
 * re-registration; the modal opens it, decides nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { BehaviorSubject } from 'rxjs';
import { SessionSignals } from '@semiont/sdk';

const harness = vi.hoisted(() => ({
  browser: null as unknown as {
    activeSignals$: BehaviorSubject<unknown>;
    activeSession$: BehaviorSubject<unknown>;
    emit: ReturnType<typeof vi.fn>;
  },
}));

vi.mock('../../../session/SemiontProvider', async () => {
  const actual = await vi.importActual<typeof import('../../../session/SemiontProvider')>(
    '../../../session/SemiontProvider',
  );
  return { ...actual, useSemiont: () => harness.browser };
});

import { KbIdentityConflictModal } from '../KbIdentityConflictModal';

const EXPECTED = 'did:web:example.github.io:prod-kb';
const OBSERVED = 'did:web:example.github.io:scratch-kb';

function mount(withConflict: boolean) {
  const signals = new SessionSignals();
  if (withConflict) {
    signals.notifyKbIdentityConflict({ expectedDid: EXPECTED, observedDid: OBSERVED });
  }
  harness.browser = {
    activeSignals$: new BehaviorSubject<unknown>(signals),
    activeSession$: new BehaviorSubject<unknown>({
      kb: { id: 'kb-1', label: 'Production KB', did: EXPECTED },
    }),
    emit: vi.fn(),
  };
  render(<KbIdentityConflictModal />);
  return { signals };
}

describe('KbIdentityConflictModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing while there is no conflict', () => {
    mount(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('names the registered entry and the answering identity as two distinct facts, dids verbatim', () => {
    mount(true);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The entry the user registered — label AND stored did.
    expect(screen.getByText('Production KB')).toBeInTheDocument();
    expect(screen.getByText(EXPECTED)).toBeInTheDocument();
    // The identity that answered — verbatim, and NOT under the registered label.
    expect(screen.getByText(OBSERVED)).toBeInTheDocument();
    // The void is stated: the user's tabs did not silently vanish.
    expect(screen.getByText(/tabs.*cleared|cleared.*tabs/i)).toBeInTheDocument();
  });

  it('dismiss acknowledges the signal and closes', () => {
    const { signals } = mount(true);

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(signals.kbIdentityConflictAt$.getValue()).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the forward route opens the Knowledge Base panel and acknowledges', () => {
    const { signals } = mount(true);

    fireEvent.click(screen.getByRole('button', { name: /review knowledge bases/i }));

    expect(harness.browser.emit).toHaveBeenCalledWith('panel:open', { panel: 'knowledge-base' });
    expect(signals.kbIdentityConflictAt$.getValue()).toBeNull();
  });
});
