'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PopupContainer, PopupHeader } from './SharedPopupElements';
import { buttonStyles } from '@/lib/button-styles';
import { useEntityTypes } from '@/lib/api-hooks';

interface QuickReferencePopupProps {
  isOpen: boolean;
  onClose: () => void;
  position: { x: number; y: number };
  selection: {
    exact: string;
    start: number;
    end: number;
  };
  onCreateReference: (entityType?: string) => void;
}

export function QuickReferencePopup({
  isOpen,
  onClose,
  position,
  selection,
  onCreateReference,
}: QuickReferencePopupProps) {
  const t = useTranslations('CreateAnnotationPopup');
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>([]);

  // Fetch entity types from backend
  const entityTypesAPI = useEntityTypes();
  const { data: entityTypesData } = entityTypesAPI.list.useQuery();

  const entityTypes = entityTypesData?.entityTypes || [];

  const handleCreateReference = () => {
    const entityType = selectedEntityTypes.join(',') || undefined;
    onCreateReference(entityType);
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
      <PopupHeader title={t('title')} selectedText={selection.exact} onClose={onClose} />

      {/* Entity Types Selection */}
      <div className="border border-blue-200 dark:border-blue-800 rounded-lg p-3 bg-blue-50 dark:bg-blue-950/30 shadow-sm">
        {entityTypes.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">
              {t('entityTypesOptional')}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {entityTypes.map((type: string) => (
                <button
                  key={type}
                  onClick={() => toggleEntityType(type)}
                  className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
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
        )}

        {/* Create Reference Button */}
        <button
          onClick={handleCreateReference}
          className={`${buttonStyles.primary.base} w-full justify-center`}
        >
          🔗 {t('createReference')}
        </button>
      </div>
    </PopupContainer>
  );
}
