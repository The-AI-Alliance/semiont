'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { arrayMove } from '@dnd-kit/sortable';

interface OpenDocument {
  id: string;
  name: string;
  openedAt: number;
  order?: number; // Optional for backward compatibility
}

interface OpenDocumentsContextType {
  openDocuments: OpenDocument[];
  addDocument: (id: string, name: string) => void;
  removeDocument: (id: string) => void;
  updateDocumentName: (id: string, name: string) => void;
  reorderDocuments: (oldIndex: number, newIndex: number) => void;
}

const OpenDocumentsContext = createContext<OpenDocumentsContextType | undefined>(undefined);

export function OpenDocumentsProvider({ children }: { children: React.ReactNode }) {
  const [openDocuments, setOpenDocuments] = useState<OpenDocument[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);
  
  // Load from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem('openDocuments');
    if (stored) {
      try {
        const docs = JSON.parse(stored) as OpenDocument[];
        // Sort by order if present, otherwise by openedAt (for backward compatibility)
        setOpenDocuments(docs.sort((a, b) => {
          if (a.order !== undefined && b.order !== undefined) {
            return a.order - b.order;
          }
          return a.openedAt - b.openedAt;
        }));
      } catch (e) {
        console.error('Failed to parse open documents:', e);
      }
    }
    setIsInitialized(true);
  }, []);
  
  // Save to localStorage whenever documents change (but not on initial mount)
  useEffect(() => {
    if (isInitialized) {
      localStorage.setItem('openDocuments', JSON.stringify(openDocuments));
    }
  }, [openDocuments, isInitialized]);
  
  // Listen for storage events from other tabs
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'openDocuments' && e.newValue) {
        try {
          const docs = JSON.parse(e.newValue) as OpenDocument[];
          // Sort by order if present, otherwise by openedAt
          setOpenDocuments(docs.sort((a, b) => {
            if (a.order !== undefined && b.order !== undefined) {
              return a.order - b.order;
            }
            return a.openedAt - b.openedAt;
          }));
        } catch (err) {
          console.error('Failed to parse open documents from storage event:', err);
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);
  
  const addDocument = useCallback((id: string, name: string) => {
    setOpenDocuments(prev => {
      const existing = prev.find(doc => doc.id === id);
      if (existing) {
        // Update name if document already exists
        return prev.map(doc =>
          doc.id === id ? { ...doc, name } : doc
        );
      }
      // Add new document with order = max order + 1
      const maxOrder = prev.length > 0
        ? Math.max(...prev.map(d => d.order ?? d.openedAt))
        : 0;
      return [...prev, { id, name, openedAt: Date.now(), order: maxOrder + 1 }];
    });
  }, []);
  
  const removeDocument = useCallback((id: string) => {
    setOpenDocuments(prev => prev.filter(doc => doc.id !== id));
  }, []);
  
  const updateDocumentName = useCallback((id: string, name: string) => {
    setOpenDocuments(prev =>
      prev.map(doc => doc.id === id ? { ...doc, name } : doc)
    );
  }, []);

  const reorderDocuments = useCallback((oldIndex: number, newIndex: number) => {
    setOpenDocuments(prev => {
      const reordered = arrayMove(prev, oldIndex, newIndex);
      // Update order field to preserve the new position
      return reordered.map((doc, index) => ({
        ...doc,
        order: index
      }));
    });
  }, []);

  return (
    <OpenDocumentsContext.Provider value={{
      openDocuments,
      addDocument,
      removeDocument,
      updateDocumentName,
      reorderDocuments
    }}>
      {children}
    </OpenDocumentsContext.Provider>
  );
}

export function useOpenDocuments() {
  const context = useContext(OpenDocumentsContext);
  if (context === undefined) {
    throw new Error('useOpenDocuments must be used within an OpenDocumentsProvider');
  }
  return context;
}