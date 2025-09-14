import { useState, useCallback, useEffect } from 'react';
import { apiService, api } from '@/lib/api-client';
import type { Document } from '@/lib/api-client';

interface UseSelectionPopupProps {
  selectedText: string;
  sourceDocumentId?: string | undefined;
  existingAnnotation?: {
    id: string;
    type: 'highlight' | 'reference';
    referencedDocumentId?: string;
    referenceType?: string;
    entityType?: string;
  } | undefined;
  onClose: () => void;
}

export function useSelectionPopup({
  selectedText,
  sourceDocumentId,
  existingAnnotation,
  onClose
}: UseSelectionPopupProps) {
  // State management
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Document[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [referenceType, setReferenceType] = useState(existingAnnotation?.referenceType || 'mentions');
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>(
    existingAnnotation?.entityType ? [existingAnnotation.entityType] : []
  );
  const [createNewDoc, setCreateNewDoc] = useState(false);
  const [newDocName, setNewDocName] = useState('');
  const [copied, setCopied] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch entity types from backend
  const { data: entityTypesData, isLoading: isLoadingEntityTypes } = api.entityTypes.list.useQuery();
  const commonEntityTypes = entityTypesData?.entityTypes || [
    'Person',
    'Organization', 
    'Location',
    'Event',
    'Concept',
    'Product',
    'Technology'
  ];

  // Fetch reference types from backend
  const { data: referenceTypesData, isLoading: isLoadingReferenceTypes } = api.referenceTypes.list.useQuery();
  const referenceTypes = referenceTypesData?.referenceTypes || [
    'mentions',
    'defines',
    'cites',
    'describes',
    'uses'
  ];

  // Handle search - memoized
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    
    setIsSearching(true);
    setError(null);
    try {
      const response = await apiService.documents.search(searchQuery, 10);
      setSearchResults(response.documents);
    } catch (error) {
      console.error('Search failed:', error);
      setError('Failed to search documents');
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [searchQuery]);

  // Handle copy to clipboard - memoized
  const handleCopyText = useCallback(() => {
    navigator.clipboard.writeText(selectedText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(err => {
      console.error('Failed to copy text:', err);
      setError('Failed to copy text to clipboard');
    });
  }, [selectedText]);

  // Handle creating new document - memoized
  const handleCreateNewDocument = useCallback(async (
    onCreateReference: (targetDocId?: string, entityType?: string, referenceType?: string) => void
  ) => {
    const docName = newDocName.trim() || searchQuery.trim() || selectedText;
    if (!docName) return;
    
    setIsCreating(true);
    setError(null);
    try {
      // Pass entity types if any are selected
      const entityTypesStr = selectedEntityTypes.length > 0 ? selectedEntityTypes.join(',') : undefined;
      onCreateReference(undefined, entityTypesStr, referenceType);
    } catch (error) {
      console.error('Failed to create document:', error);
      setError('Failed to create document');
    } finally {
      setIsCreating(false);
    }
  }, [newDocName, searchQuery, selectedText, selectedEntityTypes, referenceType]);

  // Handle creating reference - memoized
  const handleCreateReference = useCallback((
    onCreateReference: (targetDocId?: string, entityType?: string, referenceType?: string) => void
  ) => {
    if (selectedDoc && !createNewDoc) {
      // Create reference to existing document
      onCreateReference(selectedDoc.id, undefined, referenceType);
    } else if (createNewDoc || (searchQuery && !selectedDoc)) {
      // Create reference with new document
      handleCreateNewDocument(onCreateReference);
    }
  }, [selectedDoc, createNewDoc, searchQuery, referenceType, handleCreateNewDocument]);

  // Handle Escape key to close the popup
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  // Clear error after a delay
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [error]);

  return {
    // State
    searchQuery,
    searchResults,
    isSearching,
    selectedDoc,
    referenceType,
    selectedEntityTypes,
    createNewDoc,
    newDocName,
    copied,
    isCreating,
    error,
    commonEntityTypes,
    referenceTypes,
    isLoadingEntityTypes,
    isLoadingReferenceTypes,
    
    // Actions
    setSearchQuery,
    setSelectedDoc,
    setReferenceType,
    setSelectedEntityTypes,
    setCreateNewDoc,
    setNewDocName,
    handleSearch,
    handleCopyText,
    handleCreateReference,
    handleCreateNewDocument,
  };
}