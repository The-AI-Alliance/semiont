'use client';

import React, { useEffect, useState, createContext, useContext } from 'react';

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

  const announce = (message: string, priority: 'polite' | 'assertive' = 'polite') => {
    if (priority === 'assertive') {
      setAssertiveMessage(message);
      // Clear after announcement
      setTimeout(() => setAssertiveMessage(''), 1000);
    } else {
      setPoliteMessage(message);
      // Clear after announcement
      setTimeout(() => setPoliteMessage(''), 1000);
    }
  };

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

  return {
    announceSearchResults: (count: number, query: string) => {
      if (count === 0) {
        announce(`No results found for ${query}`, 'polite');
      } else {
        announce(`${count} result${count === 1 ? '' : 's'} found for ${query}`, 'polite');
      }
    },
    announceSearching: () => {
      announce('Searching...', 'polite');
    }
  };
}

export function useDocumentAnnouncements() {
  const { announce } = useLiveRegion();

  return {
    announceDocumentSaved: () => {
      announce('Document saved successfully', 'polite');
    },
    announceDocumentDeleted: () => {
      announce('Document deleted', 'polite');
    },
    announceAnnotationCreated: (type: 'highlight' | 'reference') => {
      announce(`${type === 'highlight' ? 'Highlight' : 'Reference'} created`, 'polite');
    },
    announceAnnotationDeleted: () => {
      announce('Annotation deleted', 'polite');
    },
    announceError: (message: string) => {
      announce(`Error: ${message}`, 'assertive');
    }
  };
}