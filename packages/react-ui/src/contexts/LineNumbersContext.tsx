'use client';

import { createContext, useContext, useState, useCallback } from 'react';
import type { ReactNode } from 'react';

interface LineNumbersContextValue {
  showLineNumbers: boolean;
  toggleLineNumbers: () => void;
}

// Context-backed like ThemeContext, and for the same reason: the Settings
// panel's toggle is APPLIED by a bus subscriber in a different component
// than the switch that displays it. As a plain per-caller useState, the
// subscriber mutated its private copy while the switch rendered another,
// and the toggle flipped nothing anywhere (e2e 13:77/:134/:189).
// localStorage is persistence only — the initial read and the write on
// toggle — never the sharing mechanism.
// See .plans/bugs/line-numbers-toggle-desynced-by-hoist.md
const LineNumbersContext = createContext<LineNumbersContextValue | null>(null);

export function LineNumbersProvider({ children }: { children: ReactNode }) {
  const [showLineNumbers, setShowLineNumbers] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('showLineNumbers') === 'true';
    }
    return false;
  });

  const toggleLineNumbers = useCallback(() => {
    const newMode = !showLineNumbers;
    setShowLineNumbers(newMode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('showLineNumbers', newMode.toString());
    }
  }, [showLineNumbers]);

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
