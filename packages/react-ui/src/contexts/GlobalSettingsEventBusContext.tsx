'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import mitt from 'mitt';

/**
 * Global settings event map
 * These events are app-wide and don't require a resource context
 */
export type GlobalSettingsEventMap = {
  'settings:theme-changed': { theme: 'light' | 'dark' | 'system' };
  'settings:line-numbers-toggled': void;
  'settings:locale-changed': { locale: string };
};

type GlobalSettingsEventBus = ReturnType<typeof mitt<GlobalSettingsEventMap>>;

const GlobalSettingsEventBusContext = createContext<GlobalSettingsEventBus | null>(null);

export interface GlobalSettingsEventBusProviderProps {
  children: ReactNode;
}

/**
 * Global settings event bus provider
 * Provides a global event bus for settings changes that aren't tied to a specific resource
 */
export function GlobalSettingsEventBusProvider({
  children,
}: GlobalSettingsEventBusProviderProps) {
  // Create global settings event bus (one per app instance)
  const eventBus = useMemo(() => mitt<GlobalSettingsEventMap>(), []);

  return (
    <GlobalSettingsEventBusContext.Provider value={eventBus}>
      {children}
    </GlobalSettingsEventBusContext.Provider>
  );
}

/**
 * Hook to access global settings event bus
 */
export function useGlobalSettingsEvents(): GlobalSettingsEventBus {
  const bus = useContext(GlobalSettingsEventBusContext);
  if (!bus) {
    throw new Error('useGlobalSettingsEvents must be used within GlobalSettingsEventBusProvider');
  }
  return bus;
}
