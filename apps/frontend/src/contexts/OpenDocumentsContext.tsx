'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

interface OpenDocument {
  id: string;
  name: string;
  openedAt: number;
}

interface OpenDocumentsContextType {
  openDocuments: OpenDocument[];
  addDocument: (id: string, name: string) => void;
  removeDocument: (id: string) => void;
  updateDocumentName: (id: string, name: string) => void;
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
        setOpenDocuments(docs.sort((a, b) => a.openedAt - b.openedAt));
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
          setOpenDocuments(docs.sort((a, b) => a.openedAt - b.openedAt));
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
      // Add new document
      return [...prev, { id, name, openedAt: Date.now() }].sort((a, b) => a.openedAt - b.openedAt);
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
  
  return (
    <OpenDocumentsContext.Provider value={{ 
      openDocuments, 
      addDocument, 
      removeDocument, 
      updateDocumentName 
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