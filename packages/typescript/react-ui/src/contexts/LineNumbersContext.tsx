'use client';

import { createContext, useContext, useState, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';

interface LineNumbersContextValue {
  showLineNumbers: boolean;
  toggleLineNumbers: () => void;
}

// Context-backed like ThemeContext, and for the same reason: the Settings
// panel's toggle is APPLIED by a bus subscriber in a different component
// than the switch that displays it. As a plain per-caller useState, the
// subscriber would mutate its private copy while the switch rendered
// another, and the toggle would flip nothing anywhere.
// The host may control the value to persist outside localStorage; otherwise
// localStorage is persistence only — never the sharing mechanism.
const LineNumbersContext = createContext<LineNumbersContextValue | null>(null);

export function LineNumbersProvider({
  children,
  value,
  onToggle,
}: {
  children: ReactNode;
  /** Optional controlled value for hosts that persist preferences outside localStorage. */
  value?: boolean;
  onToggle?: () => void;
}) {
  const [localValue, setLocalValue] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('showLineNumbers') === 'true';
    }
    return false;
  });
  const showLineNumbers = value ?? localValue;
  const controlled = useRef({ value, onToggle });
  controlled.current = { value, onToggle };

  // Functional update: subscribers hold this callback inside bus handlers,
  // so it must flip from the CURRENT value even when the holder's reference
  // is stale — a closure over showLineNumbers re-applies the old toggle.
  // The persistence write is idempotent, so StrictMode's double-invoked
  // updater writes the same value twice, harmlessly.
  const toggleLineNumbers = useCallback(() => {
    const current = controlled.current;
    if (current.value !== undefined) {
      current.onToggle?.();
      return;
    }
    setLocalValue((prev) => {
      const next = !prev;
      if (typeof window !== 'undefined') localStorage.setItem('showLineNumbers', next.toString());
      return next;
    });
  }, []);

  return (
    <LineNumbersContext.Provider value={{ showLineNumbers, toggleLineNumbers }}>
      {children}
    </LineNumbersContext.Provider>
  );
}

export function useLineNumbers(): LineNumbersContextValue {
  const ctx = useContext(LineNumbersContext);
  if (!ctx) {
    throw new Error('useLineNumbers must be used within a LineNumbersProvider');
  }
  return ctx;
}
