'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { apiService } from '@/lib/api-client';
import { 
  mapBackendToFrontendSelection,
  type HighlightsApiResponse,
  type ReferencesApiResponse,
  type SelectionsApiResponse
} from '@/lib/api-types';

export interface Annotation {
  id: string;
  documentId: string;
  selectionData?: {
    type: string;
    offset: number;
    length: number;
    text: string;
  };
  text?: string;
  referencedDocumentId?: string;
  entityType?: string;
  entityTypes?: string[];
  referenceType?: string;
  type?: 'highlight' | 'reference';
  createdAt?: string;
  updatedAt?: string;
}

interface DocumentAnnotationsContextType {
  highlights: Annotation[];
  references: Annotation[];
  isLoading: boolean;
  error: string | null;
  
  // Actions
  loadAnnotations: (documentId: string) => Promise<void>;
  addHighlight: (documentId: string, text: string, position: { start: number; end: number }) => Promise<void>;
  addReference: (documentId: string, text: string, position: { start: number; end: number }, targetDocId?: string, entityType?: string, referenceType?: string) => Promise<void>;
  deleteAnnotation: (annotationId: string) => Promise<void>;
  convertHighlightToReference: (highlightId: string, targetDocId?: string, entityType?: string, referenceType?: string) => Promise<void>;
  convertReferenceToHighlight: (referenceId: string) => Promise<void>;
  refreshAnnotations: () => Promise<void>;
}

const DocumentAnnotationsContext = createContext<DocumentAnnotationsContextType | undefined>(undefined);

export function DocumentAnnotationsProvider({ children }: { children: React.ReactNode }) {
  const [highlights, setHighlights] = useState<Annotation[]>([]);
  const [references, setReferences] = useState<Annotation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentDocumentId, setCurrentDocumentId] = useState<string | null>(null);

  const loadAnnotations = useCallback(async (documentId: string) => {
    if (!documentId) return;
    
    setIsLoading(true);
    setError(null);
    setCurrentDocumentId(documentId);
    
    try {
      // Load highlights
      const highlightsResponse = await apiService.selections.getHighlights(documentId) as unknown as HighlightsApiResponse | SelectionsApiResponse;
      const highlightData = 'highlights' in highlightsResponse 
        ? highlightsResponse.highlights 
        : highlightsResponse.selections;
      const mappedHighlights = highlightData.map(mapBackendToFrontendSelection);
      setHighlights(mappedHighlights.map(h => ({ ...h, type: 'highlight' as const })));

      // Load references
      const referencesResponse = await apiService.selections.getReferences(documentId) as unknown as ReferencesApiResponse | SelectionsApiResponse;
      const referenceData = 'references' in referencesResponse 
        ? referencesResponse.references 
        : referencesResponse.selections;
      const mappedReferences = referenceData.map(mapBackendToFrontendSelection);
      setReferences(mappedReferences.map(r => ({ ...r, type: 'reference' as const })));
    } catch (err) {
      console.error('Failed to load annotations:', err);
      setError('Failed to load annotations');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshAnnotations = useCallback(async () => {
    if (currentDocumentId) {
      await loadAnnotations(currentDocumentId);
    }
  }, [currentDocumentId, loadAnnotations]);

  const addHighlight = useCallback(async (
    documentId: string, 
    text: string, 
    position: { start: number; end: number }
  ) => {
    try {
      await apiService.selections.saveAsHighlight({
        documentId,
        text,
        position
      });
      await refreshAnnotations();
    } catch (err) {
      console.error('Failed to create highlight:', err);
      throw err;
    }
  }, [refreshAnnotations]);

  const addReference = useCallback(async (
    documentId: string,
    text: string,
    position: { start: number; end: number },
    targetDocId?: string,
    entityType?: string,
    referenceType?: string
  ) => {
    try {
      // Create the selection first
      const response = await apiService.selections.create({
        documentId,
        text,
        position
      });
      
      // The response is a BackendSelection object
      const backendSelection = response as unknown as import('@/lib/api-types').BackendSelection;
      const selectionId = backendSelection.id;
      
      // If we have a target document, resolve to it
      if (targetDocId) {
        const resolveData: any = {
          selectionId,
          targetDocumentId: targetDocId
        };
        if (referenceType) {
          resolveData.referenceType = referenceType;
        }
        await apiService.selections.resolveToDocument(resolveData);
      } else if (entityType) {
        // Create a new document with the entity type(s)
        const entityTypes = entityType.split(',').map(t => t.trim()).filter(t => t);
        const newDocResponse = await apiService.documents.create({
          name: text,
          content: `# ${text}`,
          contentType: 'text/markdown'
        });
        
        // Set entity types on the new document
        if (newDocResponse.document?.id && entityTypes.length > 0) {
          await apiService.documents.update(newDocResponse.document.id, {
            entityTypes: entityTypes
          });
        }
        
        // Now resolve the selection to this new document
        if (newDocResponse.document?.id) {
          const resolveData: any = {
            selectionId,
            targetDocumentId: newDocResponse.document.id
          };
          if (referenceType) {
            resolveData.referenceType = referenceType;
          }
          await apiService.selections.resolveToDocument(resolveData);
        }
      }
      
      await refreshAnnotations();
    } catch (err) {
      console.error('Failed to create reference:', err);
      throw err;
    }
  }, [refreshAnnotations]);

  const deleteAnnotation = useCallback(async (annotationId: string) => {
    try {
      await apiService.selections.delete(annotationId);
      await refreshAnnotations();
    } catch (err) {
      console.error('Failed to delete annotation:', err);
      throw err;
    }
  }, [refreshAnnotations]);

  const convertHighlightToReference = useCallback(async (
    highlightId: string,
    targetDocId?: string,
    entityType?: string,
    referenceType?: string
  ) => {
    const highlight = highlights.find(h => h.id === highlightId);
    if (!highlight || !highlight.selectionData) return;
    
    try {
      // Delete the highlight
      await apiService.selections.delete(highlightId);
      
      // Create new reference
      await addReference(
        highlight.documentId,
        highlight.selectionData.text,
        {
          start: highlight.selectionData.offset,
          end: highlight.selectionData.offset + highlight.selectionData.length
        },
        targetDocId,
        entityType,
        referenceType
      );
    } catch (err) {
      console.error('Failed to convert highlight to reference:', err);
      throw err;
    }
  }, [highlights, addReference]);

  const convertReferenceToHighlight = useCallback(async (referenceId: string) => {
    const reference = references.find(r => r.id === referenceId);
    if (!reference || !reference.selectionData) return;
    
    try {
      // Delete the reference
      await apiService.selections.delete(referenceId);
      
      // Create new highlight
      await addHighlight(
        reference.documentId,
        reference.selectionData.text,
        {
          start: reference.selectionData.offset,
          end: reference.selectionData.offset + reference.selectionData.length
        }
      );
    } catch (err) {
      console.error('Failed to convert reference to highlight:', err);
      throw err;
    }
  }, [references, addHighlight]);

  return (
    <DocumentAnnotationsContext.Provider value={{
      highlights,
      references,
      isLoading,
      error,
      loadAnnotations,
      addHighlight,
      addReference,
      deleteAnnotation,
      convertHighlightToReference,
      convertReferenceToHighlight,
      refreshAnnotations
    }}>
      {children}
    </DocumentAnnotationsContext.Provider>
  );
}

export function useDocumentAnnotations() {
  const context = useContext(DocumentAnnotationsContext);
  if (context === undefined) {
    throw new Error('useDocumentAnnotations must be used within a DocumentAnnotationsProvider');
  }
  return context;
}