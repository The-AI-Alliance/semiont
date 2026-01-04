'use client';

import React, { createContext, useContext, ReactNode } from 'react';
import type { TranslationManager } from '../types/TranslationManager';

const TranslationContext = createContext<TranslationManager | null>(null);

export interface TranslationProviderProps {
  translationManager: TranslationManager;
  children: ReactNode;
}

/**
 * Provider for translation management
 * Apps must provide a TranslationManager implementation
 */
export function TranslationProvider({
  translationManager,
  children,
}: TranslationProviderProps) {
  return (
    <TranslationContext.Provider value={translationManager}>
      {children}
    </TranslationContext.Provider>
  );
}

/**
 * Hook to access translations within a namespace
 * Must be used within a TranslationProvider
 * @param namespace - Translation namespace (e.g., 'Toolbar', 'ResourceViewer')
 * @returns Function to translate keys within the namespace
 */
export function useTranslations(namespace: string) {
  const context = useContext(TranslationContext);

  if (!context) {
    throw new Error('useTranslations must be used within a TranslationProvider');
  }

  // Return a function that translates keys within this namespace
  return (key: string) => context.t(namespace, key);
}
