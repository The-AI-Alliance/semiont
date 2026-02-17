'use client';

import React, { useState, createContext, useContext, useCallback } from 'react';
import type { components } from '@semiont/api-client';
import type { Annotator } from '../lib/annotation-registry';

type Annotation = components['schemas']['Annotation'];

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
        className="semiont-sr-only"
      >
        {politeMessage}
      </div>
      {/* Assertive announcements - interrupt current speech */}
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="semiont-sr-only"
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

export function useDocumentAnnouncements(annotators?: Record<string, Annotator>) {
  const { announce } = useLiveRegion();

  const announceDocumentSaved = useCallback(() => {
    announce('Document saved successfully', 'polite');
  }, [announce]);

  const announceDocumentDeleted = useCallback(() => {
    announce('Document deleted', 'polite');
  }, [announce]);

  const announceAnnotationCreated = useCallback((annotation: Annotation) => {
    const metadata = annotators ? Object.values(annotators).find(a => a.matchesAnnotation(annotation)) : null;
    const message = metadata?.announceOnCreate ?? 'Annotation created';
    announce(message, 'polite');
  }, [announce, annotators]);

  const announceAnnotationDeleted = useCallback(() => {
    announce('Annotation deleted', 'polite');
  }, [announce]);

  const announceAnnotationUpdated = useCallback((annotation: Annotation) => {
    const metadata = annotators ? Object.values(annotators).find(a => a.matchesAnnotation(annotation)) : null;
    const message = `${metadata?.displayName ?? 'Annotation'} updated`;
    announce(message, 'polite');
  }, [announce, annotators]);

  const announceError = useCallback((message: string) => {
    announce(`Error: ${message}`, 'assertive');
  }, [announce]);

  return {
    announceDocumentSaved,
    announceDocumentDeleted,
    announceAnnotationCreated,
    announceAnnotationDeleted,
    announceAnnotationUpdated,
    announceError
  };
}

// Hook for resource loading announcements
export function useResourceLoadingAnnouncements() {
  const { announce } = useLiveRegion();

  const announceResourceLoading = useCallback((resourceName?: string) => {
    const message = resourceName
      ? `Loading ${resourceName}...`
      : 'Loading resource...';
    announce(message, 'polite');
  }, [announce]);

  const announceResourceLoaded = useCallback((resourceName: string) => {
    announce(`${resourceName} loaded successfully`, 'polite');
  }, [announce]);

  const announceResourceLoadError = useCallback((resourceName?: string) => {
    const message = resourceName
      ? `Failed to load ${resourceName}`
      : 'Failed to load resource';
    announce(message, 'assertive');
  }, [announce]);

  const announceResourceUpdating = useCallback((resourceName: string) => {
    announce(`Updating ${resourceName}...`, 'polite');
  }, [announce]);

  return {
    announceResourceLoading,
    announceResourceLoaded,
    announceResourceLoadError,
    announceResourceUpdating
  };
}

// Hook for form submission announcements
export function useFormAnnouncements() {
  const { announce } = useLiveRegion();

  const announceFormSubmitting = useCallback(() => {
    announce('Submitting form...', 'polite');
  }, [announce]);

  const announceFormSuccess = useCallback((message?: string) => {
    announce(message || 'Form submitted successfully', 'polite');
  }, [announce]);

  const announceFormError = useCallback((message?: string) => {
    announce(message || 'Form submission failed. Please check your entries and try again.', 'assertive');
  }, [announce]);

  const announceFormValidationError = useCallback((fieldCount: number) => {
    const message = fieldCount === 1
      ? 'There is 1 field with an error'
      : `There are ${fieldCount} fields with errors`;
    announce(message, 'assertive');
  }, [announce]);

  return {
    announceFormSubmitting,
    announceFormSuccess,
    announceFormError,
    announceFormValidationError
  };
}

// Hook for language/locale change announcements
export function useLanguageChangeAnnouncements() {
  const { announce } = useLiveRegion();

  const announceLanguageChanging = useCallback((newLanguage: string) => {
    announce(`Changing language to ${newLanguage}...`, 'polite');
  }, [announce]);

  const announceLanguageChanged = useCallback((newLanguage: string) => {
    announce(`Language changed to ${newLanguage}`, 'polite');
  }, [announce]);

  return {
    announceLanguageChanging,
    announceLanguageChanged
  };
}