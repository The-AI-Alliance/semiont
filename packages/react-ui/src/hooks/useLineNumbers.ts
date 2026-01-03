import { useState, useCallback } from 'react';

/**
 * Hook to manage line numbers display setting with localStorage persistence
 */
export function useLineNumbers() {
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

  return { showLineNumbers, toggleLineNumbers };
}
