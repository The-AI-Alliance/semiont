"use client";

import React from 'react';
import { useSelectionPopup } from '@/hooks/useSelectionPopup';
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
  const {
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
    handleCreateReference: handleCreateReferenceLogic,
  } = useSelectionPopup({
    selectedText,
    sourceDocumentId,
    existingAnnotation,
    onClose
  });

  // Prevent clicks inside the popup from closing it
  const handlePopupClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  // Wrapper for create reference that uses the onCreateReference prop
  const handleCreateReferenceClick = () => {
    handleCreateReferenceLogic(onCreateReference);
  };

  const isLoading = isLoadingEntityTypes || isLoadingReferenceTypes;

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
              disabled={isCreating}
            >
              ✕
            </button>
          </div>
          
          {/* Error display */}
          {error && (
            <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          )}
          
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
                onClick={handleCopyText}
                className={`p-1.5 rounded transition-all duration-200 ${
                  copied 
                    ? 'bg-green-500 text-white' 
                    : 'hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
                title={copied ? "Copied!" : "Copy to clipboard"}
                disabled={isCreating}
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
              disabled={isCreating}
              className="mt-3 w-full py-2 bg-yellow-200 hover:bg-yellow-300 dark:bg-yellow-900/50 dark:hover:bg-yellow-800/50 border border-yellow-400/30 dark:border-yellow-600/30 text-gray-900 dark:text-white rounded-lg transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isEditMode ? 'Convert to Highlight' : 'Create Highlight'}
            </button>
          )}
          
          {/* Delete button for edit mode */}
          {isEditMode && onDelete && (
            <button
              onClick={() => onDelete(existingAnnotation!.id)}
              disabled={isCreating}
              className="mt-3 w-full py-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-600 dark:text-red-400 rounded-lg transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Delete {existingAnnotation?.type === 'highlight' ? 'Highlight' : 'Reference'}
            </button>
          )}
        </div>

        <div className="p-4 space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-white"></div>
            </div>
          ) : (
            <>
              {/* Reference Type Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Reference Type
                </label>
                <select
                  value={referenceType}
                  onChange={(e) => setReferenceType(e.target.value)}
                  disabled={isCreating}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white disabled:opacity-50"
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
                  Link to Document
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !isSearching && handleSearch()}
                    placeholder="Search for a document..."
                    disabled={isCreating || isSearching}
                    className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white disabled:opacity-50"
                  />
                  <button
                    onClick={handleSearch}
                    disabled={isCreating || isSearching || !searchQuery.trim()}
                    className={`${buttonStyles.secondary.base} disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {isSearching ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-900 dark:border-white"></div>
                    ) : (
                      'Search'
                    )}
                  </button>
                </div>
              </div>

              {/* Search Results */}
              {searchResults.length > 0 && (
                <div className="max-h-32 overflow-y-auto border border-gray-300 dark:border-gray-600 rounded-lg">
                  {searchResults.map((doc) => (
                    <button
                      key={doc.id}
                      onClick={() => setSelectedDoc(doc)}
                      disabled={isCreating}
                      className={`w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 ${
                        selectedDoc?.id === doc.id ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                      }`}
                    >
                      <div className="text-sm font-medium text-gray-900 dark:text-white">
                        {doc.name}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {doc.content.substring(0, 100)}...
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Selected Document Display */}
              {selectedDoc && (
                <div className="p-2 bg-blue-50 dark:bg-blue-900/30 rounded-lg">
                  <div className="flex justify-between items-center">
                    <div className="text-sm">
                      <p className="font-medium text-gray-900 dark:text-white">
                        Selected: {selectedDoc.name}
                      </p>
                    </div>
                    <button
                      onClick={() => setSelectedDoc(null)}
                      disabled={isCreating}
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-50"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}

              {/* Create New Document Option */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="createNewDoc"
                  checked={createNewDoc}
                  onChange={(e) => setCreateNewDoc(e.target.checked)}
                  disabled={isCreating}
                  className="rounded border-gray-300 dark:border-gray-600 disabled:opacity-50"
                />
                <label htmlFor="createNewDoc" className="text-sm text-gray-700 dark:text-gray-300">
                  Create new document instead
                </label>
              </div>

              {createNewDoc && (
                <input
                  type="text"
                  value={newDocName}
                  onChange={(e) => setNewDocName(e.target.value)}
                  placeholder="New document name (optional)"
                  disabled={isCreating}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white disabled:opacity-50"
                />
              )}

              {/* Entity Types Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Entity Types (optional)
                </label>
                <div className="flex flex-wrap gap-2">
                  {commonEntityTypes.map((type) => (
                    <button
                      key={type}
                      onClick={() => {
                        setSelectedEntityTypes((prev) =>
                          prev.includes(type)
                            ? prev.filter((t) => t !== type)
                            : [...prev, type]
                        );
                      }}
                      disabled={isCreating}
                      className={`px-3 py-1 rounded-full text-sm transition-colors disabled:opacity-50 ${
                        selectedEntityTypes.includes(type)
                          ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>

              {/* Create Reference Button */}
              {(!isEditMode || existingAnnotation?.type === 'highlight') && (
                <button
                  onClick={handleCreateReferenceClick}
                  disabled={isCreating || (!selectedDoc && !createNewDoc && !searchQuery)}
                  className={`w-full py-2 ${buttonStyles.primary.base} disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center`}
                >
                  {isCreating ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                      Creating...
                    </>
                  ) : (
                    isEditMode ? 'Convert to Reference' : 'Create Reference'
                  )}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}