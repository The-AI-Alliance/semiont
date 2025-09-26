'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { buttonStyles } from '@/lib/button-styles';
import { SearchDocumentsModal } from './SearchDocumentsModal';
import { apiService } from '@/lib/api-client';

interface AnnotationPopupProps {
  isOpen: boolean;
  onClose: () => void;
  position: { x: number; y: number };
  selection: {
    text: string;
    start: number;
    end: number;
  } | null;
  annotation?: {
    id: string;
    type: 'highlight' | 'reference';
    entityType?: string;
    referenceType?: string;
    resolvedDocumentId?: string;
    resolvedDocumentName?: string;
    provisional?: boolean;
  };
  onCreateHighlight?: () => void;
  onCreateReference?: (targetDocId?: string, entityType?: string, referenceType?: string) => void;
  onUpdateAnnotation?: (updates: any) => void;
  onDeleteAnnotation?: () => void;
  onGenerateDocument?: (title: string, prompt?: string) => void;
}

type PopupState = 'initial' | 'highlight' | 'stub_reference' | 'resolved_reference';

const ENTITY_TYPES = [
  'Person',
  'Company',
  'Technology',
  'Product',
  'Place',
  'Event',
  'Concept'
];

const REFERENCE_TYPES = [
  { value: 'defines', label: 'Defines' },
  { value: 'mentions', label: 'Mentions' },
  { value: 'describes', label: 'Describes' },
  { value: 'references', label: 'References' },
  { value: 'cites', label: 'Cites' }
];

export function AnnotationPopup({
  isOpen,
  onClose,
  position,
  selection,
  annotation,
  onCreateHighlight,
  onCreateReference,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onGenerateDocument
}: AnnotationPopupProps) {
  const router = useRouter();
  const [selectedEntityType, setSelectedEntityType] = useState<string>('');
  const [selectedReferenceType, setSelectedReferenceType] = useState<string>('');
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  // Determine current state
  const getCurrentState = (): PopupState => {
    if (!annotation) return 'initial';
    if (annotation.type === 'highlight') return 'highlight';
    if (annotation.type === 'reference') {
      return annotation.resolvedDocumentId ? 'resolved_reference' : 'stub_reference';
    }
    return 'initial';
  };

  const currentState = getCurrentState();

  // Reset state when popup opens
  useEffect(() => {
    if (isOpen) {
      setSelectedEntityType(annotation?.entityType || '');
      setSelectedReferenceType(annotation?.referenceType || '');
      setShowSearchModal(false);
    }
  }, [isOpen, annotation]);

  if (!isOpen) return null;

  const handleCreateHighlight = () => {
    if (onCreateHighlight) {
      onCreateHighlight();
    }
    onClose();
  };

  const handleCreateReference = () => {
    if (onCreateReference && selectedEntityType) {
      onCreateReference(undefined, selectedEntityType, selectedReferenceType || undefined);
    }
    onClose();
  };

  const handleGenerateDocument = () => {
    if (onGenerateDocument && selection) {
      setIsGenerating(true);
      onGenerateDocument(selection.text);
      onClose();
    }
  };

  const handleSearchAndLink = (documentId: string) => {
    if (onUpdateAnnotation && annotation) {
      onUpdateAnnotation({
        resolvedDocumentId: documentId,
        provisional: false
      });
    }
    setShowSearchModal(false);
    onClose();
  };

  const handleCreateNewDocument = () => {
    if (selection) {
      // Navigate to compose page with pre-filled title
      router.push(`/know/compose?title=${encodeURIComponent(selection.text)}`);
      onClose();
    }
  };

  const handleViewDocument = () => {
    if (annotation?.resolvedDocumentId) {
      router.push(`/know/document/${annotation.resolvedDocumentId}`);
      onClose();
    }
  };

  const handleUnlinkDocument = () => {
    if (onUpdateAnnotation && annotation) {
      onUpdateAnnotation({
        resolvedDocumentId: null,
        provisional: true
      });
    }
  };

  const handleConvertToHighlight = () => {
    if (onUpdateAnnotation && annotation) {
      onUpdateAnnotation({
        type: 'highlight',
        entityType: null,
        referenceType: null,
        resolvedDocumentId: null
      });
    }
  };

  const handleDelete = () => {
    if (onDeleteAnnotation) {
      onDeleteAnnotation();
    }
    onClose();
  };

  // Calculate popup position
  const popupStyle: React.CSSProperties = {
    position: 'fixed',
    left: `${Math.min(position.x, window.innerWidth - 400)}px`,
    top: `${Math.min(position.y, window.innerHeight - 500)}px`,
    zIndex: 1000,
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/20 backdrop-blur-sm z-[999]"
        onClick={onClose}
      />

      {/* Popup */}
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-4 w-96 max-h-[500px] overflow-y-auto"
        style={popupStyle}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {currentState === 'initial' && 'Create Annotation'}
            {currentState === 'highlight' && '🟡 Highlight'}
            {currentState === 'stub_reference' && '🟣 Stub Reference'}
            {currentState === 'resolved_reference' && '🔵 Linked Reference'}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            ✕
          </button>
        </div>

        {/* Selected Text */}
        {selection && (
          <div className="mb-4 p-3 bg-gray-100 dark:bg-gray-700 rounded-lg">
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Selected text:</p>
            <p className="text-sm font-medium text-gray-900 dark:text-white">
              "{selection.text}"
            </p>
          </div>
        )}

        {/* Current annotation info */}
        {annotation?.entityType && (
          <div className="mb-3">
            <span className="inline-block px-2 py-1 text-xs font-medium rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300">
              {annotation.entityType}
            </span>
            {annotation.referenceType && (
              <span className="ml-2 text-sm text-gray-600 dark:text-gray-400">
                ({annotation.referenceType})
              </span>
            )}
          </div>
        )}

        {annotation?.resolvedDocumentName && (
          <div className="mb-3 p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
            <p className="text-xs text-gray-600 dark:text-gray-400">Links to:</p>
            <p className="text-sm font-medium text-blue-700 dark:text-blue-300">
              {annotation.resolvedDocumentName}
            </p>
          </div>
        )}

        {/* Actions based on state */}
        <div className="space-y-3">
          {/* Initial state - create new */}
          {currentState === 'initial' && (
            <>
              <button
                onClick={handleCreateHighlight}
                className="w-full py-2 bg-yellow-200 hover:bg-yellow-300 dark:bg-yellow-900/50 dark:hover:bg-yellow-800/50 border border-yellow-400/30 dark:border-yellow-600/30 text-gray-900 dark:text-white rounded-lg transition-all duration-300"
              >
                🟡 Create Highlight
              </button>

              <div className="border-t dark:border-gray-700 pt-3">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Or create a reference:
                </p>

                {/* Entity Type Selection */}
                <div className="mb-3">
                  <label className="text-xs text-gray-600 dark:text-gray-400">Entity Type</label>
                  <div className="grid grid-cols-3 gap-2 mt-1">
                    {ENTITY_TYPES.map(type => (
                      <button
                        key={type}
                        onClick={() => setSelectedEntityType(type)}
                        className={`px-2 py-1 text-xs rounded-lg transition-colors ${
                          selectedEntityType === type
                            ? 'bg-purple-200 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300'
                            : 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'
                        }`}
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Reference Type Selection */}
                <div className="mb-3">
                  <label className="text-xs text-gray-600 dark:text-gray-400">Reference Type (optional)</label>
                  <select
                    value={selectedReferenceType}
                    onChange={(e) => setSelectedReferenceType(e.target.value)}
                    className="w-full mt-1 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700"
                  >
                    <option value="">None</option>
                    {REFERENCE_TYPES.map(type => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  onClick={handleCreateReference}
                  disabled={!selectedEntityType}
                  className="w-full py-2 bg-purple-200 hover:bg-purple-300 dark:bg-purple-900/50 dark:hover:bg-purple-800/50 border border-purple-400/30 dark:border-purple-600/30 text-gray-900 dark:text-white rounded-lg transition-all duration-300 disabled:opacity-50"
                >
                  🟣 Create Reference
                </button>
              </div>
            </>
          )}

          {/* Highlight state */}
          {currentState === 'highlight' && (
            <>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Convert to reference:
              </p>

              {/* Entity Type Selection */}
              <div className="mb-3">
                <label className="text-xs text-gray-600 dark:text-gray-400">Entity Type</label>
                <div className="grid grid-cols-3 gap-2 mt-1">
                  {ENTITY_TYPES.map(type => (
                    <button
                      key={type}
                      onClick={() => setSelectedEntityType(type)}
                      className={`px-2 py-1 text-xs rounded-lg transition-colors ${
                        selectedEntityType === type
                          ? 'bg-purple-200 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300'
                          : 'bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </div>

              {/* Reference Type Selection */}
              <div className="mb-3">
                <label className="text-xs text-gray-600 dark:text-gray-400">Reference Type (optional)</label>
                <select
                  value={selectedReferenceType}
                  onChange={(e) => setSelectedReferenceType(e.target.value)}
                  className="w-full mt-1 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700"
                >
                  <option value="">None</option>
                  {REFERENCE_TYPES.map(type => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>

              <button
                onClick={() => {
                  if (onCreateReference && selectedEntityType) {
                    onCreateReference(undefined, selectedEntityType, selectedReferenceType || undefined);
                    onClose();
                  }
                }}
                disabled={!selectedEntityType}
                className="w-full py-2 bg-purple-200 hover:bg-purple-300 dark:bg-purple-900/50 dark:hover:bg-purple-800/50 border border-purple-400/30 dark:border-purple-600/30 text-gray-900 dark:text-white rounded-lg transition-all duration-300 disabled:opacity-50"
              >
                🟣 Convert to Reference
              </button>

              <div className="border-t dark:border-gray-700 pt-3 mt-3">
                <button
                  onClick={handleDelete}
                  className="w-full py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-all"
                >
                  Delete Highlight
                </button>
              </div>
            </>
          )}

          {/* Stub reference state */}
          {currentState === 'stub_reference' && (
            <>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Complete this reference:
              </p>

              <button
                onClick={handleGenerateDocument}
                disabled={isGenerating}
                className={buttonStyles.primary.base + ' w-full justify-center'}
              >
                ✨ Generate Document
              </button>

              <button
                onClick={() => setShowSearchModal(true)}
                className={buttonStyles.secondary.base + ' w-full'}
              >
                🔍 Search Existing Documents
              </button>

              <button
                onClick={handleCreateNewDocument}
                className={buttonStyles.secondary.base + ' w-full'}
              >
                ✏️ Create New Document
              </button>

              <div className="border-t dark:border-gray-700 pt-3">
                <button
                  onClick={handleConvertToHighlight}
                  className="w-full py-2 text-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-all"
                >
                  Convert to Highlight
                </button>
                <button
                  onClick={handleDelete}
                  className="w-full py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-all"
                >
                  Delete Reference
                </button>
              </div>
            </>
          )}

          {/* Resolved reference state */}
          {currentState === 'resolved_reference' && (
            <>
              <button
                onClick={handleViewDocument}
                className={buttonStyles.primary.base + ' w-full justify-center'}
              >
                📄 View Document
              </button>

              <div className="border-t dark:border-gray-700 pt-3 space-y-2">
                <button
                  onClick={handleUnlinkDocument}
                  className="w-full py-2 text-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-all"
                >
                  Unlink Document
                </button>
                <button
                  onClick={handleConvertToHighlight}
                  className="w-full py-2 text-sm text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-all"
                >
                  Convert to Highlight
                </button>
                <button
                  onClick={handleDelete}
                  className="w-full py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-all"
                >
                  Delete Reference
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Search Modal */}
      {showSearchModal && (
        <SearchDocumentsModal
          isOpen={showSearchModal}
          onClose={() => setShowSearchModal(false)}
          onSelect={handleSearchAndLink}
          searchTerm={selection?.text || ''}
        />
      )}
    </>
  );
}