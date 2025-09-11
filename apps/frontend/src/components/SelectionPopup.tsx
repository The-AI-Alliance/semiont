"use client";

import React, { useState, useEffect } from 'react';
import { apiService, api } from '@/lib/api-client';
import type { Document } from '@/lib/api-client';

interface SelectionPopupProps {
  selectedText: string;
  onCreateHighlight: () => void;
  onCreateReference: (targetDocId?: string, entityType?: string, referenceType?: string) => void;
  onClose: () => void;
}

export function SelectionPopup({
  selectedText,
  onCreateHighlight,
  onCreateReference,
  onClose
}: SelectionPopupProps) {
  const [activeTab, setActiveTab] = useState<'highlight' | 'reference' | 'entity'>('highlight');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Document[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [referenceType, setReferenceType] = useState('citation');
  const [entityType, setEntityType] = useState('');
  const [customEntityType, setCustomEntityType] = useState('');

  // Fetch entity types from backend
  const { data: entityTypesData, isLoading: entityTypesLoading } = api.entityTypes.list.useQuery();
  const commonEntityTypes = entityTypesData?.entityTypes || [
    // Fallback to hardcoded if API fails
    'Person',
    'Organization',
    'Location',
    'Event',
    'Concept',
    'Product',
    'Technology',
    'Date',
    'Other'
  ];

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    try {
      const response = await apiService.documents.search(searchQuery, 5);
      setSearchResults(response.documents);
    } catch (error) {
      console.error('Search failed:', error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleCreateNewDocument = async () => {
    try {
      const response = await apiService.documents.create({
        name: searchQuery || selectedText.substring(0, 50),
        content: `# ${searchQuery || selectedText.substring(0, 50)}\n\nThis document was created from a reference to:\n\n> ${selectedText}`,
        contentType: 'text/markdown'
      });
      
      // Create reference to the new document
      onCreateReference(response.document.id, undefined, referenceType);
    } catch (error) {
      console.error('Failed to create document:', error);
      alert('Failed to create new document');
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Create Selection
            </h3>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              ✕
            </button>
          </div>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
            Selected: "{selectedText}"
          </p>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={() => setActiveTab('highlight')}
            className={`px-4 py-2 font-medium text-sm ${
              activeTab === 'highlight'
                ? 'text-blue-600 border-b-2 border-blue-600 dark:text-blue-400 dark:border-blue-400'
                : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
            }`}
          >
            Highlight
          </button>
          <button
            onClick={() => setActiveTab('reference')}
            className={`px-4 py-2 font-medium text-sm ${
              activeTab === 'reference'
                ? 'text-blue-600 border-b-2 border-blue-600 dark:text-blue-400 dark:border-blue-400'
                : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
            }`}
          >
            Reference Document
          </button>
          <button
            onClick={() => setActiveTab('entity')}
            className={`px-4 py-2 font-medium text-sm ${
              activeTab === 'entity'
                ? 'text-blue-600 border-b-2 border-blue-600 dark:text-blue-400 dark:border-blue-400'
                : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white'
            }`}
          >
            Entity Reference
          </button>
        </div>

        {/* Content */}
        <div className="p-4 overflow-y-auto" style={{ maxHeight: '400px' }}>
          {activeTab === 'highlight' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Create a highlight to mark this text as important. Highlights are saved and can be viewed later.
              </p>
              <button
                onClick={onCreateHighlight}
                className="w-full py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 transition-colors"
              >
                Create Highlight
              </button>
            </div>
          )}

          {activeTab === 'reference' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Link this selection to another document.
              </p>

              {/* Reference Type */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Reference Type
                </label>
                <select
                  value={referenceType}
                  onChange={(e) => setReferenceType(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                >
                  <option value="citation">Citation</option>
                  <option value="definition">Definition</option>
                  <option value="elaboration">Elaboration</option>
                  <option value="example">Example</option>
                  <option value="related">Related</option>
                </select>
              </div>

              {/* Search for Document */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Search for Document
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
                    placeholder="Search documents..."
                    className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                  />
                  <button
                    onClick={handleSearch}
                    disabled={isSearching}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
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
                      onClick={() => setSelectedDoc(doc)}
                      className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                        selectedDoc?.id === doc.id
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                          : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
                      }`}
                    >
                      <p className="font-medium text-gray-900 dark:text-white">{doc.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1">
                        {doc.content.substring(0, 100)}...
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                {selectedDoc && (
                  <button
                    onClick={() => onCreateReference(selectedDoc.id, undefined, referenceType)}
                    className="flex-1 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    Link to Selected Document
                  </button>
                )}
                {searchQuery && (
                  <button
                    onClick={handleCreateNewDocument}
                    className="flex-1 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                  >
                    Create New Document
                  </button>
                )}
              </div>
            </div>
          )}

          {activeTab === 'entity' && (
            <div className="space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                Mark this selection as a reference to an entity (person, place, concept, etc.).
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
                          ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300'
                          : 'border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
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
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
                  />
                )}
              </div>

              {/* Create Entity Reference */}
              <button
                onClick={() => {
                  const finalEntityType = entityType === 'Other' ? customEntityType : entityType;
                  if (finalEntityType) {
                    onCreateReference(undefined, finalEntityType, 'entity');
                  }
                }}
                disabled={!entityType || (entityType === 'Other' && !customEntityType)}
                className="w-full py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Create Entity Reference
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}