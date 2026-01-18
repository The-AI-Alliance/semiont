'use client';

import { useEffect } from 'react';
import { useTheme } from '@semiont/react-ui';

/**
 * ThemeInitializer Component
 *
 * Initializes the theme system and applies the correct data-theme attribute
 * to the document root element. This enables dark mode CSS rules to work.
 *
 * Must be rendered inside the client-side provider tree.
 */
export function ThemeInitializer() {
  const { theme } = useTheme();

  // The useTheme hook already handles applying the theme,
  // this component just ensures it gets initialized
  useEffect(() => {
    // Theme is applied via the useTheme hook's internal effect
    // This effect is just for logging/debugging if needed
    const root = document.documentElement;
    const currentTheme = root.getAttribute('data-theme');
    console.debug('Theme initialized:', currentTheme);
  }, [theme]);

  return null;
}