"use client";

import React, { useState, useEffect } from 'react';
import { apiService, api } from '@/lib/api-client';
import type { Document } from '@/lib/api-client';
import { buttonStyles } from '@/lib/button-styles';
import { annotationStyles } from '@/lib/annotation-styles';

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
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>(
    existingAnnotation?.entityType ? [existingAnnotation.entityType] : []
  );
  const [createNewDoc, setCreateNewDoc] = useState(false);
  const [newDocName, setNewDocName] = useState('');
  const [copied, setCopied] = useState(false);

  // Fetch entity types from backend
  const { data: entityTypesData } = api.entityTypes.list.useQuery();
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
    } catch (error) {
      console.error('Search failed:', error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleCreateNewDocument = async () => {
    const docName = newDocName.trim() || searchQuery.trim() || selectedText;
    if (!docName) return;
    
    try {
      // Pass entity types if any are selected
      const entityTypesStr = selectedEntityTypes.length > 0 ? selectedEntityTypes.join(',') : undefined;
      onCreateReference(undefined, entityTypesStr, referenceType);
    } catch (error) {
      console.error('Failed to create document:', error);
    }
  };

  const handleCreateReference = () => {
    if (selectedDoc && !createNewDoc) {
      // Create reference to existing document
      onCreateReference(selectedDoc.id, undefined, referenceType);
    } else if (createNewDoc || (searchQuery && !selectedDoc)) {
      // Create reference with new document
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
          
          {/* Selected text display with copy button */}
          <div className="mt-3 p-2 bg-gray-50 dark:bg-gray-700 rounded">
            <div className="flex justify-between items-start gap-2">
              <div className="flex-1">
                <p className="text-sm text-gray-600 dark:text-gray-400">Selected:</p>
                <p className="text-sm font-medium text-gray-900 dark:text-white line-clamp-2">
                  "{selectedText}"
                </p>
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(selectedText).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000); // Reset after 2 seconds
                  }).catch(err => {
                    console.error('Failed to copy text:', err);
                  });
                }}
                className={`p-1.5 rounded transition-all duration-200 ${
                  copied 
                    ? 'bg-green-500 text-white' 
                    : 'hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
                title={copied ? "Copied!" : "Copy to clipboard"}
              >
                {copied ? (
                  // Checkmark icon for "Copied!" state
                  <svg 
                    className="w-4 h-4"
                    fill="none" 
                    stroke="currentColor" 
                    viewBox="0 0 24 24"
                  >
                    <path 
                      strokeLinecap="round" 
                      strokeLinejoin="round" 
                      strokeWidth={2} 
                      d="M5 13l4 4L19 7" 
                    />
                  </svg>
                ) : (
                  // Copy icon
                  <svg 
                    className="w-4 h-4 text-gray-600 dark:text-gray-400"
                    fill="none" 
                    stroke="currentColor" 
                    viewBox="0 0 24 24"
                  >
                    <path 
                      strokeLinecap="round" 
                      strokeLinejoin="round" 
                      strokeWidth={2} 
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" 
                    />
                  </svg>
                )}
              </button>
            </div>
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
              Target Document
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setSelectedDoc(null);
                  setCreateNewDoc(false);
                }}
                onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="Search for existing document..."
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

          {/* Search Results or Create New Options */}
          {(searchResults.length > 0 || searchQuery) && (
            <div className="space-y-2">
              {searchResults.length > 0 && (
                <>
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    Existing documents:
                  </p>
                  {searchResults.map((doc) => (
                    <div
                      key={doc.id}
                      onClick={() => {
                        setSelectedDoc(doc);
                        setCreateNewDoc(false);
                      }}
                      className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                        selectedDoc?.id === doc.id && !createNewDoc
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
                              className={annotationStyles.tags.entity}
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
                </>
              )}
              
              {/* Option to create new document */}
              <div
                onClick={() => {
                  setCreateNewDoc(true);
                  setSelectedDoc(null);
                }}
                className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                  createNewDoc
                    ? 'border-green-500 bg-green-50 dark:bg-green-900/20'
                    : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                <p className="font-medium text-gray-900 dark:text-white">
                  ✨ Create new document
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {searchQuery ? `Named: "${searchQuery}"` : `Named: "${selectedText}"`}
                </p>
              </div>
            </div>
          )}

          {/* New Document Options - show when creating new */}
          {createNewDoc && (
            <div className="space-y-3 p-3 bg-green-50 dark:bg-green-900/10 rounded-lg border border-green-200 dark:border-green-800">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Document Name
                </label>
                <input
                  type="text"
                  value={newDocName}
                  onChange={(e) => setNewDocName(e.target.value)}
                  placeholder={searchQuery || selectedText}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-gray-700 dark:text-white"
                />
              </div>
              
              {/* Entity Type Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Entity Types (optional)
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {commonEntityTypes.map((type) => (
                    <button
                      key={type}
                      onClick={() => {
                        setSelectedEntityTypes(prev => 
                          prev.includes(type) 
                            ? prev.filter(t => t !== type)
                            : [...prev, type]
                        );
                      }}
                      className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                        selectedEntityTypes.includes(type)
                          ? 'border-purple-500 bg-purple-200 text-purple-900 dark:bg-purple-900/50 dark:text-purple-300'
                          : buttonStyles.tertiary.base + ' border border-gray-300 dark:border-gray-600'
                      }`}
                    >
                      {type}
                    </button>
                  ))}
                </div>
                
                {/* Show selected entity types */}
                {selectedEntityTypes.length > 0 && (
                  <div className="mt-2 flex gap-1 flex-wrap">
                    {selectedEntityTypes.map((type) => (
                      <span
                        key={type}
                        className={`${annotationStyles.tags.entity} inline-flex items-center gap-1`}
                      >
                        {type}
                        <button
                          onClick={() => setSelectedEntityTypes(prev => prev.filter(t => t !== type))}
                          className="hover:text-purple-900 dark:hover:text-purple-100"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Create/Update Reference Button */}
          {(!isEditMode || existingAnnotation?.type === 'highlight' || existingAnnotation?.type === 'reference') && (
            <button
              onClick={handleCreateReference}
              disabled={!selectedDoc && !createNewDoc && !searchQuery}
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