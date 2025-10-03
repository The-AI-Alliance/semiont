'use client';

import React, { useEffect, useState, createContext, useContext, useCallback } from 'react';

interface LiveRegionContextType {
  announce: (message: string, priority?: 'polite' | 'assertive') => void;
}

const LiveRegionContext = createContext<LiveRegionContextType | null>(null);

export function useLiveRegion() {
  const context = useContext(LiveRegionContext);
  if (!context) {
    // Return a no-op function if not within provider
    return { announce: () => {} };
  }
  return context;
}

interface LiveRegionProviderProps {
  children: React.ReactNode;
}

export function LiveRegionProvider({ children }: LiveRegionProviderProps) {
  const [politeMessage, setPoliteMessage] = useState('');
  const [assertiveMessage, setAssertiveMessage] = useState('');

  const announce = useCallback((message: string, priority: 'polite' | 'assertive' = 'polite') => {
    if (priority === 'assertive') {
      setAssertiveMessage(message);
      // Clear after announcement
      setTimeout(() => setAssertiveMessage(''), 1000);
    } else {
      setPoliteMessage(message);
      // Clear after announcement
      setTimeout(() => setPoliteMessage(''), 1000);
    }
  }, []);

  return (
    <LiveRegionContext.Provider value={{ announce }}>
      {children}
      {/* Polite announcements - wait for current speech */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {politeMessage}
      </div>
      {/* Assertive announcements - interrupt current speech */}
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
      >
        {assertiveMessage}
      </div>
    </LiveRegionContext.Provider>
  );
}

// Custom hook for common announcements
export function useSearchAnnouncements() {
  const { announce } = useLiveRegion();

  const announceSearchResults = useCallback((count: number, query: string) => {
    if (count === 0) {
      announce(`No results found for ${query}`, 'polite');
    } else {
      announce(`${count} result${count === 1 ? '' : 's'} found for ${query}`, 'polite');
    }
  }, [announce]);

  const announceSearching = useCallback(() => {
    announce('Searching...', 'polite');
  }, [announce]);

  return {
    announceSearchResults,
    announceSearching
  };
}

export function useDocumentAnnouncements() {
  const { announce } = useLiveRegion();

  const announceDocumentSaved = useCallback(() => {
    announce('Document saved successfully', 'polite');
  }, [announce]);

  const announceDocumentDeleted = useCallback(() => {
    announce('Document deleted', 'polite');
  }, [announce]);

  const announceAnnotationCreated = useCallback((type: 'highlight' | 'reference') => {
    announce(`${type === 'highlight' ? 'Highlight' : 'Reference'} created`, 'polite');
  }, [announce]);

  const announceAnnotationDeleted = useCallback(() => {
    announce('Annotation deleted', 'polite');
  }, [announce]);

  const announceError = useCallback((message: string) => {
    announce(`Error: ${message}`, 'assertive');
  }, [announce]);

  return {
    announceDocumentSaved,
    announceDocumentDeleted,
    announceAnnotationCreated,
    announceAnnotationDeleted,
    announceError
  };
}