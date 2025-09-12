"use client";

import React, { useState, useEffect } from 'react';
import { apiService, api } from '@/lib/api-client';
import type { Document } from '@/lib/api-client';
import { buttonStyles } from '@/lib/button-styles';

interface SelectionPopupProps {
  selectedText: string;
  sourceDocumentId?: string;
  onCreateHighlight: () => void;
  onCreateReference: (targetDocId?: string, entityType?: string, referenceType?: string) => void;
  onClose: () => void;
  isEditMode?: boolean;
  existingAnnotation?: {
    id: string;
    type: 'highlight' | 'reference';
    referencedDocumentId?: string;
    referenceType?: string;
    entityType?: string;
  };
  onUpdate?: (annotationId: string, updates: any) => void;
  onDelete?: (annotationId: string) => void;
}

export function SelectionPopup({
  selectedText,
  sourceDocumentId,
  onCreateHighlight,
  onCreateReference,
  onClose,
  isEditMode = false,
  existingAnnotation,
  onUpdate,
  onDelete
}: SelectionPopupProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Document[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [referenceType, setReferenceType] = useState(existingAnnotation?.referenceType || 'mentions');
  const [entityType, setEntityType] = useState(existingAnnotation?.entityType || '');
  const [customEntityType, setCustomEntityType] = useState('');
  const [showEntityTypes, setShowEntityTypes] = useState(false);

  // Fetch entity types from backend
  const { data: entityTypesData } = api.entityTypes.list.useQuery();
  const commonEntityTypes = entityTypesData?.entityTypes || [
    'Person',
    'Organization', 
    'Location',
    'Event',
    'Concept',
    'Product',
    'Technology',
    'Other'
  ];

  // Fetch reference types from backend
  const { data: referenceTypesData } = api.referenceTypes.list.useQuery();
  const referenceTypes = referenceTypesData?.referenceTypes || [
    'mentions',
    'defines',
    'cites',
    'describes',
    'uses'
  ];

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    
    setIsSearching(true);
    try {
      const response = await apiService.documents.search(searchQuery, 10);
      setSearchResults(response.documents);
      // If no results, show entity type selection
      if (response.documents.length === 0) {
        setShowEntityTypes(true);
      }
    } catch (error) {
      console.error('Search failed:', error);
      setSearchResults([]);
      setShowEntityTypes(true);
    } finally {
      setIsSearching(false);
    }
  };

  const handleCreateNewDocument = async () => {
    if (!searchQuery.trim()) return;
    
    const finalEntityType = entityType === 'Other' ? customEntityType : entityType;
    
    try {
      // Create the reference with a new document
      // The backend will create the document with the entity type
      onCreateReference(undefined, finalEntityType, referenceType);
    } catch (error) {
      console.error('Failed to create document:', error);
    }
  };

  const handleCreateReference = () => {
    if (selectedDoc) {
      // Create reference to existing document
      onCreateReference(selectedDoc.id, undefined, referenceType);
    } else if (showEntityTypes && entityType) {
      // Create reference with new entity document
      handleCreateNewDocument();
    }
  };

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

  // Prevent clicks inside the popup from closing it
  const handlePopupClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <div 
      className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-lg w-full max-h-[80vh] overflow-y-auto"
        onClick={handlePopupClick}
      >
        <div className="sticky top-0 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {isEditMode ? 'Edit Selection' : 'Create Selection'}
            </h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              ✕
            </button>
          </div>
          
          {/* Selected text display */}
          <div className="mt-3 p-2 bg-gray-50 dark:bg-gray-700 rounded">
            <p className="text-sm text-gray-600 dark:text-gray-400">Selected:</p>
            <p className="text-sm font-medium text-gray-900 dark:text-white line-clamp-2">
              "{selectedText}"
            </p>
          </div>
          
          {/* Create/Convert to Highlight button */}
          {(!isEditMode || existingAnnotation?.type === 'reference') && (
            <button
              onClick={onCreateHighlight}
              className="mt-3 w-full py-2 bg-yellow-200 hover:bg-yellow-300 dark:bg-yellow-900/50 dark:hover:bg-yellow-800/50 border border-yellow-400/30 dark:border-yellow-600/30 text-gray-900 dark:text-white rounded-lg transition-all duration-300"
            >
              {isEditMode ? 'Convert to Highlight' : 'Create Highlight'}
            </button>
          )}
          
          {/* Delete button for edit mode */}
          {isEditMode && onDelete && (
            <button
              onClick={() => onDelete(existingAnnotation!.id)}
              className="mt-3 w-full py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-600 dark:text-red-400 rounded-lg transition-all duration-300"
            >
              Delete {existingAnnotation?.type === 'highlight' ? 'Highlight' : 'Reference'}
            </button>
          )}
        </div>

        <div className="p-4 space-y-4">
          {/* Reference Type Selection */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Reference Type
            </label>
            <select
              value={referenceType}
              onChange={(e) => setReferenceType(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
            >
              {referenceTypes.map((type) => (
                <option key={type} value={type}>
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </option>
              ))}
            </select>
          </div>

          {/* Document Search */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Search for Document
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowEntityTypes(false);
                  setSelectedDoc(null);
                }}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="Enter document name..."
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
              />
              <button
                onClick={handleSearch}
                disabled={isSearching || !searchQuery.trim()}
                className={buttonStyles.secondary.base}
              >
                {isSearching ? '...' : 'Search'}
              </button>
            </div>
          </div>

          {/* Search Results */}
          {searchResults.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Select a document:
              </p>
              {searchResults.map((doc) => (
                <div
                  key={doc.id}
                  onClick={() => {
                    setSelectedDoc(doc);
                    setShowEntityTypes(false);
                  }}
                  className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                    selectedDoc?.id === doc.id
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  <p className="font-medium text-gray-900 dark:text-white">{doc.name}</p>
                  {doc.entityTypes && doc.entityTypes.length > 0 && (
                    <div className="mt-1 flex gap-1 flex-wrap">
                      {doc.entityTypes.map((type) => (
                        <span
                          key={type}
                          className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 rounded"
                        >
                          {type}
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1 mt-1">
                    {doc.content.substring(0, 100)}...
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* No results - show entity type selection */}
          {showEntityTypes && searchQuery && (
            <div className="space-y-3">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                No matching document found. Create a new entity document:
              </p>
              
              {/* Entity Type Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Entity Type
                </label>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {commonEntityTypes.map((type) => (
                    <button
                      key={type}
                      onClick={() => {
                        setEntityType(type);
                        setCustomEntityType('');
                      }}
                      className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                        entityType === type
                          ? 'border-purple-500 bg-purple-200 text-purple-900 dark:bg-purple-900/50 dark:text-purple-300'
                          : buttonStyles.tertiary.base + ' border border-gray-300 dark:border-gray-600'
                      }`}
                    >
                      {type}
                    </button>
                  ))}
                </div>
                
                {/* Custom Entity Type */}
                {entityType === 'Other' && (
                  <input
                    type="text"
                    value={customEntityType}
                    onChange={(e) => setCustomEntityType(e.target.value)}
                    placeholder="Enter custom entity type..."
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 dark:bg-gray-700 dark:text-white"
                  />
                )}
              </div>
            </div>
          )}

          {/* Create/Update Reference Button */}
          {(!isEditMode || existingAnnotation?.type === 'highlight' || existingAnnotation?.type === 'reference') && (
            <button
              onClick={handleCreateReference}
              disabled={!selectedDoc && (!showEntityTypes || !entityType || (entityType === 'Other' && !customEntityType))}
              className={`w-full py-2 ${buttonStyles.primary.base}`}
            >
              {isEditMode ? (existingAnnotation?.type === 'highlight' ? 'Convert to Reference' : 'Update Reference') : 'Create Reference'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}