'use client';

/**
 * ReactUIProvider - Provides locale to @semiont/react-ui components
 *
 * This component passes the current locale from the Settings Panel to react-ui,
 * allowing react-ui components to use their built-in translations for that locale.
 */

import React from 'react';
import { useLocale } from 'next-intl';
import { TranslationProvider } from '@semiont/react-ui';

interface ReactUIProviderProps {
  children: React.ReactNode;
}

/**
 * Provider component that passes the current locale to react-ui components
 * This allows react-ui to use its own built-in translations for that locale
 */
export function ReactUIProvider({ children }: ReactUIProviderProps) {
  // Get the current locale from next-intl (which comes from Settings Panel)
  const locale = useLocale();

  // Simply pass the locale to react-ui's TranslationProvider
  // React-ui will use its own built-in translations for this locale
  return (
    <TranslationProvider locale={locale}>
      {children}
    </TranslationProvider>
  );
}