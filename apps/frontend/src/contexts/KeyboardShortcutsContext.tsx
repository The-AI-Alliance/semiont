'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from '@/i18n/routing';
import { useKeyboardShortcuts, useDoubleKeyPress } from '@semiont/react-ui';

// Dynamically import modals to avoid SSR issues with React Query and next-intl
const GlobalSearchModal = dynamic(
  () => import('../components/modals/GlobalSearchModal').then(mod => ({ default: mod.GlobalSearchModal })),
  { ssr: false }
);

const KeyboardShortcutsHelpModal = dynamic(
  () => import('@semiont/react-ui').then(mod => ({ default: mod.KeyboardShortcutsHelpModal })),
  { ssr: false }
);

interface KeyboardShortcutsContextType {
  openGlobalSearch: () => void;
  openKeyboardHelp: () => void;
  closeAllOverlays: () => void;
}

export const KeyboardShortcutsContext = createContext<KeyboardShortcutsContextType | null>(null);

export function useKeyboardShortcutsContext() {
  const context = useContext(KeyboardShortcutsContext);
  if (!context) {
    throw new Error('useKeyboardShortcutsContext must be used within KeyboardShortcutsProvider');
  }
  return context;
}

interface KeyboardShortcutsProviderProps {
  children: React.ReactNode;
}

export function KeyboardShortcutsProvider({ children }: KeyboardShortcutsProviderProps) {
  const router = useRouter();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [overlayCloseCallbacks, setOverlayCloseCallbacks] = useState<(() => void)[]>([]);

  // Open global search
  const openGlobalSearch = useCallback(() => {
    setIsSearchOpen(true);
  }, []);

  // Open keyboard help
  const openKeyboardHelp = useCallback(() => {
    setIsHelpOpen(true);
  }, []);

  // Close all overlays
  const closeAllOverlays = useCallback(() => {
    // Close all modals
    setIsSearchOpen(false);
    setIsHelpOpen(false);

    // Call all registered overlay close callbacks
    overlayCloseCallbacks.forEach(callback => callback());

    // Clear the callbacks
    setOverlayCloseCallbacks([]);
  }, [overlayCloseCallbacks]);

  // Register global keyboard shortcuts
  useKeyboardShortcuts([
    {
      key: 'k',
      ctrlOrCmd: true,
      handler: () => {
        openGlobalSearch();
      },
      description: 'Open global search'
    },
    {
      key: 'n',
      ctrlOrCmd: true,
      handler: () => {
        // Navigate to compose page to create new resource
        router.push('/know/compose');
      },
      description: 'Create new resource'
    },
    {
      key: '/',
      handler: () => {
        // Alternative search trigger (like GitHub)
        openGlobalSearch();
      },
      description: 'Open global search (alternative)'
    },
    {
      key: '?',
      shift: true,
      handler: () => {
        // Open keyboard shortcuts help
        openKeyboardHelp();
      },
      description: 'Show keyboard shortcuts help'
    }
  ]);

  // Double Escape to close all overlays
  useDoubleKeyPress('Escape', closeAllOverlays, 300);

  const contextValue: KeyboardShortcutsContextType = {
    openGlobalSearch,
    openKeyboardHelp,
    closeAllOverlays
  };

  return (
    <KeyboardShortcutsContext.Provider value={contextValue}>
      {children}
      <GlobalSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
      />
      <KeyboardShortcutsHelpModal
        isOpen={isHelpOpen}
        onClose={() => setIsHelpOpen(false)}
      />
    </KeyboardShortcutsContext.Provider>
  );
}