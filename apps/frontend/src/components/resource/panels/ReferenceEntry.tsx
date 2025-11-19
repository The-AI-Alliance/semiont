'use client';

import React, { useEffect, useRef } from 'react';
import { useRouter } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { getAnnotationExactText, isBodyResolved, getBodySource, getEntityTypes } from '@semiont/api-client';
import { buttonStyles } from '@/lib/button-styles';
import { getResourceIcon } from '@/lib/resource-utils';

type Annotation = components['schemas']['Annotation'];

interface ReferenceEntryProps {
  reference: Annotation;
  isFocused: boolean;
  onClick: () => void;
  onReferenceRef: (referenceId: string, el: HTMLElement | null) => void;
  onReferenceHover?: (referenceId: string | null) => void;
  onGenerateDocument?: (title: string) => void;
  onSearchDocuments?: (referenceId: string, searchTerm: string) => void;
  onUpdateReference?: (referenceId: string, updates: Partial<Annotation>) => void;
  annotateMode?: boolean;
}

export function ReferenceEntry({
  reference,
  isFocused,
  onClick,
  onReferenceRef,
  onReferenceHover,
  onGenerateDocument,
  onSearchDocuments,
  onUpdateReference,
  annotateMode = true,
}: ReferenceEntryProps) {
  const t = useTranslations('ReferencesPanel');
  const router = useRouter();
  const referenceRef = useRef<HTMLDivElement>(null);

  // Register ref with parent
  useEffect(() => {
    onReferenceRef(reference.id, referenceRef.current);
    return () => {
      onReferenceRef(reference.id, null);
    };
  }, [reference.id, onReferenceRef]);

  // Scroll to reference when focused
  useEffect(() => {
    if (isFocused && referenceRef.current) {
      referenceRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isFocused]);

  const selectedText = getAnnotationExactText(reference) || '';
  const isResolved = isBodyResolved(reference.body);
  const resolvedResourceUri = isResolved ? getBodySource(reference.body) : null;
  const entityTypes = getEntityTypes(reference);

  // Extract resolved document name and media type if enriched by backend
  const resolvedDocumentName = (reference as any)._resolvedDocumentName as string | undefined;
  const resolvedDocumentMediaType = (reference as any)._resolvedDocumentMediaType as string | undefined;
  const resourceIcon = getResourceIcon(resolvedDocumentMediaType);

  const handleOpen = () => {
    if (resolvedResourceUri) {
      const resourceId = resolvedResourceUri.split('/resources/')[1];
      if (resourceId) {
        router.push(`/know/resource/${encodeURIComponent(resourceId)}`);
      }
    }
  };

  const handleComposeDocument = () => {
    router.push(`/know/compose?title=${encodeURIComponent(selectedText)}`);
  };

  const handleUnlink = () => {
    if (onUpdateReference) {
      onUpdateReference(reference.id, { body: [] });
    }
  };

  const handleGenerate = () => {
    if (onGenerateDocument) {
      onGenerateDocument(selectedText);
    }
  };

  const handleSearch = () => {
    if (onSearchDocuments) {
      onSearchDocuments(reference.id, selectedText);
    }
  };

  return (
    <div
      ref={referenceRef}
      className={`border rounded-lg p-3 transition-all cursor-pointer ${
        isFocused
          ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20 animate-pulse-outline'
          : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
      }`}
      onClick={onClick}
      onMouseEnter={() => onReferenceHover?.(reference.id)}
      onMouseLeave={() => onReferenceHover?.(null)}
    >
      {/* Status indicator and text quote */}
      <div className="text-sm text-gray-600 dark:text-gray-400 mb-2 flex items-start gap-2">
        <span className="text-base flex-shrink-0" title={isResolved ? t('resolved') : t('stub')}>
          {isResolved ? '🔗' : '❓'}
        </span>
        <div className="flex-1">
          {selectedText && (
            <div className="italic border-l-2 border-blue-300 pl-2">
              "{selectedText.substring(0, 100)}{selectedText.length > 100 ? '...' : ''}"
            </div>
          )}
          {!selectedText && (
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Image annotation
            </div>
          )}
          {resolvedDocumentName && (
            <div className="mt-1 text-xs font-medium text-blue-600 dark:text-blue-400 flex items-center gap-1">
              <span>→ {resourceIcon} {resolvedDocumentName}</span>
            </div>
          )}
        </div>
      </div>

      {/* Entity type badges */}
      {entityTypes.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {entityTypes.map((type, index) => (
            <span
              key={index}
              className="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
            >
              {type}
            </span>
          ))}
        </div>
      )}

      {/* Actions based on state - only show curation actions in Annotate mode */}
      <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
        {isResolved ? (
          // Resolved reference actions
          <div className="flex gap-1">
            <button
              onClick={handleOpen}
              className={`${buttonStyles.primary.base} ${annotateMode ? 'flex-1' : 'w-full'} !px-2 justify-center text-lg py-1`}
              title={t('open')}
            >
              🔗
            </button>
            {annotateMode && (
              <button
                onClick={handleUnlink}
                className={`${buttonStyles.secondary.base} !px-2 flex items-center justify-center text-lg`}
                title={t('unlink')}
              >
                ⛓️‍💥
              </button>
            )}
          </div>
        ) : (
          // Stub reference actions - only in Annotate mode
          annotateMode && (
            <div className="flex gap-1">
              <button
                onClick={handleGenerate}
                className={`${buttonStyles.primary.base} flex-1 !px-2 justify-center text-lg py-1`}
                title={t('generate')}
              >
                ✨
              </button>
              <button
                onClick={handleSearch}
                className={`${buttonStyles.secondary.base} flex-1 !px-2 justify-center text-lg py-1`}
                title={t('find')}
              >
                🔍
              </button>
              <button
                onClick={handleComposeDocument}
                className={`${buttonStyles.secondary.base} flex-1 !px-2 justify-center text-lg py-1`}
                title={t('create')}
              >
                ✏️
              </button>
            </div>
          )
        )}
      </div>
    </div>
  );
}
