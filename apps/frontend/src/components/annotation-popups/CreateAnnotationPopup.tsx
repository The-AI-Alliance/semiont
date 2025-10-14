'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { PopupContainer, PopupHeader } from './SharedPopupElements';
import { buttonStyles } from '@/lib/button-styles';
import { api } from '@/lib/api-client';

interface CreateAnnotationPopupProps {
  isOpen: boolean;
  onClose: () => void;
  position: { x: number; y: number };
  selection: {
    exact: string;
    start: number;
    end: number;
  };
  onCreateHighlight: () => void;
  onCreateReference: (targetDocId?: string, entityType?: string, referenceType?: string) => void;
  onCreateAssessment: () => void;
}

export function CreateAnnotationPopup({
  isOpen,
  onClose,
  position,
  selection,
  onCreateHighlight,
  onCreateReference,
  onCreateAssessment,
}: CreateAnnotationPopupProps) {
  const t = useTranslations('CreateAnnotationPopup');
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>([]);

  // Fetch entity types from backend
  const { data: entityTypesData } = api.entityTypes.all.useQuery();

  const entityTypes = entityTypesData?.entityTypes || [];

  const handleCreateHighlight = () => {
    onCreateHighlight();
    onClose();
  };

  const handleCreateAssessment = () => {
    onCreateAssessment();
    onClose();
  };

  const handleCreateStubReference = () => {
    const entityType = selectedEntityTypes.join(',') || undefined;
    onCreateReference(undefined, entityType, undefined);
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

      {/* Quick Actions - Highlight and Assessment side by side */}
      <div className="flex gap-2 mb-3">
        <button
          onClick={handleCreateHighlight}
          className={`${buttonStyles.warning.base} flex-1 justify-center`}
        >
          🟡 {t('createHighlight')}
        </button>
        <button
          onClick={handleCreateAssessment}
          className={`${buttonStyles.danger.base} flex-1 justify-center`}
        >
          🔴 {t('createAssessment')}
        </button>
      </div>

      {/* Reference Section with Config */}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
        {/* Entity Types */}
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
          onClick={handleCreateStubReference}
          className={`${buttonStyles.primary.base} w-full justify-center`}
        >
          🔗 {t('createReference')}
        </button>
      </div>
    </PopupContainer>
  );
}