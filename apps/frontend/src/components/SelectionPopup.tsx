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
    hasSearched,
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
                <div className="relative">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Type to search documents..."
                    disabled={isCreating}
                    className="w-full px-3 py-2 pr-10 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white disabled:opacity-50"
                  />
                  {isSearching && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-500 dark:border-gray-400"></div>
                    </div>
                  )}
                </div>
              </div>

              {/* Search Results and Feedback */}
              {searchQuery && hasSearched && !isSearching && searchResults.length === 0 && (
                <div className="text-sm text-gray-500 dark:text-gray-400 italic">
                  No documents found matching "{searchQuery}"
                </div>
              )}
              
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

              {/* Create Stub Reference Option */}
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
                  Create stub reference instead
                </label>
              </div>

              {createNewDoc && (
                <div className="text-sm text-gray-600 dark:text-gray-400 italic">
                  A new reference will be created that points to a future document named "{selectedText}".
                  You can complete this reference later by creating the actual document.
                </div>
              )}

              {/* Entity Types - Show for new documents (selectable) or selected documents (read-only) */}
              {(createNewDoc || selectedDoc) && (
                <div className={`${createNewDoc ? 'animate-slideDown' : ''}`}>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    {createNewDoc ? 'Entity Types for Stub Reference (optional)' : 'Selected Document Entity Types'}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {createNewDoc ? (
                      // Selectable entity types for new document
                      commonEntityTypes.map((type, index) => (
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
                          className={`px-3 py-1 rounded-full text-sm transition-all duration-300 disabled:opacity-50 animate-fadeInScale ${
                            selectedEntityTypes.includes(type)
                              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700'
                              : 'bg-gradient-to-r from-gray-100 to-gray-50 dark:from-gray-700 dark:to-gray-600 text-gray-700 dark:text-gray-300 hover:from-gray-200 hover:to-gray-100 dark:hover:from-gray-600 dark:hover:to-gray-500 border border-gray-200 dark:border-gray-600'
                          }`}
                          style={{ animationDelay: `${index * 50}ms` }}
                        >
                          {type}
                        </button>
                      ))
                    ) : selectedDoc?.entityTypes && selectedDoc.entityTypes.length > 0 ? (
                      // Read-only display of selected document's entity types
                      selectedDoc.entityTypes.map((type) => (
                        <span
                          key={type}
                          className="px-3 py-1 rounded-full text-sm bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-500"
                        >
                          {type}
                        </span>
                      ))
                    ) : (
                      <span className="text-sm text-gray-500 dark:text-gray-400 italic">
                        No entity types defined
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Create Reference / Create Document Button */}
              {(!isEditMode || existingAnnotation?.type === 'highlight' || createNewDoc) && (
                <button
                  onClick={handleCreateReferenceClick}
                  disabled={isCreating || (!selectedDoc && !createNewDoc)}
                  className={`w-full py-2 ${buttonStyles.primary.base} disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center`}
                >
                  {isCreating ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                      Creating...
                    </>
                  ) : createNewDoc ? (
                    'Create Stub Reference'
                  ) : isEditMode ? (
                    'Convert to Reference'
                  ) : (
                    'Create Reference'
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