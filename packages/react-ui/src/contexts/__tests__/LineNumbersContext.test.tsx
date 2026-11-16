/**
 * Line-numbers display state is ONE shared value.
 *
 * `useLineNumbers` was plain `useState` — every caller got a private copy,
 * synchronised only through a localStorage write nobody listens to. The
 * settings hoist then applied the toggle in ToolbarPanels' copy while the
 * switch rendered a route's copy, so the toggle flipped nothing anywhere
 * (e2e 13:77 / :134 / :189). Theme survived the identical hoist because
 * `useTheme` is context-backed. These pins hold `useLineNumbers` to the
 * same contract.
 *
 * See .plans/bugs/line-numbers-toggle-desynced-by-hoist.md
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import '@testing-library/jest-dom';
import { LineNumbersProvider, useLineNumbers } from '../LineNumbersContext';

function Probe({ id }: { id: string }) {
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();
  return (
    <button data-testid={id} onClick={toggleLineNumbers}>
      {String(showLineNumbers)}
    </button>
  );
}

describe('useLineNumbers — shared state', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('all consumers see one value — a toggle through one flips every other', () => {
    render(
      <LineNumbersProvider>
        <Probe id="subscriber" />
        <Probe id="switch" />
      </LineNumbersProvider>,
    );

    fireEvent.click(screen.getByTestId('subscriber'));

    expect(screen.getByTestId('subscriber')).toHaveTextContent('true');
    expect(screen.getByTestId('switch')).toHaveTextContent('true');
  });

  it('initialises from localStorage', () => {
    localStorage.setItem('showLineNumbers', 'true');
    render(
      <LineNumbersProvider>
        <Probe id="probe" />
      </LineNumbersProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('true');
  });

  it('treats a non-boolean stored value as false', () => {
    localStorage.setItem('showLineNumbers', 'not-a-boolean');
    render(
      <LineNumbersProvider>
        <Probe id="probe" />
      </LineNumbersProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('false');
  });

  it('persists the toggle to localStorage, both directions', () => {
    render(
      <LineNumbersProvider>
        <Probe id="probe" />
      </LineNumbersProvider>,
    );
    fireEvent.click(screen.getByTestId('probe'));
    expect(localStorage.getItem('showLineNumbers')).toBe('true');
    fireEvent.click(screen.getByTestId('probe'));
    expect(localStorage.getItem('showLineNumbers')).toBe('false');
  });

  it('toggles correctly through a stale reference — each call flips from the CURRENT value', () => {
    // The apply side holds toggleLineNumbers inside bus-subscription
    // callbacks. If the toggle closes over the value it was created with, a
    // holder that missed a re-render flips from a stale snapshot and the
    // second toggle silently re-applies the first.
    function StaleCaller() {
      const { showLineNumbers, toggleLineNumbers } = useLineNumbers();
      const captured = useRef<(() => void) | null>(null);
      captured.current ??= toggleLineNumbers; // first render's reference, kept forever
      return (
        <button data-testid="stale" onClick={() => captured.current!()}>
          {String(showLineNumbers)}
        </button>
      );
    }
    render(
      <LineNumbersProvider>
        <StaleCaller />
      </LineNumbersProvider>,
    );

    fireEvent.click(screen.getByTestId('stale'));
    expect(screen.getByTestId('stale')).toHaveTextContent('true');

    fireEvent.click(screen.getByTestId('stale'));
    expect(screen.getByTestId('stale')).toHaveTextContent('false');
    expect(localStorage.getItem('showLineNumbers')).toBe('false');
  });

  it('throws outside the provider — no silent private-copy fallback', () => {
    // Mirrors useTheme. A bare useState fallback is exactly the split-state
    // bug coming back with a quieter face.
    expect(() => render(<Probe id="bare" />)).toThrow();
  });
});
