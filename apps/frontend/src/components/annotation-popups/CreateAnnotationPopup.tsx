'use client';

import React, { useState } from 'react';
import { PopupContainer, PopupHeader, SelectedTextDisplay } from './SharedPopupElements';
import { buttonStyles } from '@/lib/button-styles';
import { api } from '@/lib/api-client';

interface CreateAnnotationPopupProps {
  isOpen: boolean;
  onClose: () => void;
  position: { x: number; y: number };
  selection: {
    text: string;
    start: number;
    end: number;
  };
  onCreateHighlight: () => void;
  onCreateReference: (targetDocId?: string, entityType?: string, referenceType?: string) => void;
}

export function CreateAnnotationPopup({
  isOpen,
  onClose,
  position,
  selection,
  onCreateHighlight,
  onCreateReference,
}: CreateAnnotationPopupProps) {
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>([]);
  const [selectedReferenceType, setSelectedReferenceType] = useState<string>('');

  // Fetch entity types and reference types from backend
  const { data: entityTypesData } = api.entityTypes.list.useQuery();
  const { data: referenceTypesData } = api.referenceTypes.list.useQuery();

  const entityTypes = entityTypesData?.entityTypes || [];
  const referenceTypes = referenceTypesData?.referenceTypes || [];

  const handleCreateHighlight = () => {
    onCreateHighlight();
    onClose();
  };

  const handleCreateStubReference = () => {
    const entityType = selectedEntityTypes.join(',') || undefined;
    onCreateReference(undefined, entityType, selectedReferenceType || undefined);
    onClose();
  };

  const toggleEntityType = (type: string) => {
    setSelectedEntityTypes(prev =>
      prev.includes(type)
        ? prev.filter(t => t !== type)
        : [...prev, type]
    );
  };

  return (
    <PopupContainer position={position} onClose={onClose} isOpen={isOpen}>
      <PopupHeader title="Create Annotation" onClose={onClose} />

      <SelectedTextDisplay text={selection.text} />

      {/* Quick Actions */}
      <div className="mb-4">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Quick Actions
        </p>
        <div className="flex gap-2">
          <button
            onClick={handleCreateHighlight}
            className={buttonStyles.secondary.base}
          >
            🖍 Create Highlight
          </button>
          <button
            onClick={handleCreateStubReference}
            className={buttonStyles.primary.base}
          >
            🔗 Create Reference
          </button>
        </div>
      </div>

      {/* Entity Types */}
      <div className="mb-4">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Entity Types (Optional)
        </p>
        <div className="flex flex-wrap gap-2">
          {entityTypes.map((type) => (
            <button
              key={type}
              onClick={() => toggleEntityType(type)}
              className={`px-3 py-1 text-sm rounded-full transition-colors ${
                selectedEntityTypes.includes(type)
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
            >
              {type}
            </button>
          ))}
        </div>
      </div>

      {/* Reference Type */}
      {referenceTypes.length > 0 && (
        <div className="mb-4">
          <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Reference Type (Optional)
          </p>
          <select
            value={selectedReferenceType}
            onChange={(e) => setSelectedReferenceType(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          >
            <option value="">None</option>
            {referenceTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>
      )}
    </PopupContainer>
  );
}