'use client';

'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('theme') as Theme) || 'system';
    }
    return 'system';
  });

  useEffect(() => {
    const root = window.document.documentElement;

    const applyTheme = () => {
      // Apply theme via data attribute
      if (theme === 'system') {
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light';
        root.setAttribute('data-theme', systemTheme);
      } else {
        root.setAttribute('data-theme', theme);
      }
    };

    applyTheme();

    // Listen for system theme changes when in system mode
    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = () => applyTheme();

      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }

    return undefined;
  }, [theme]);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    if (typeof window !== 'undefined') {
      localStorage.setItem('theme', newTheme);
    }
  };

  return { theme, setTheme };
}
