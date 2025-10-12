'use client';

import React, { useMemo } from 'react';
import { Link } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import type { Annotation, ReferencedBy } from '@semiont/sdk';

interface Props {
  highlights: Annotation[];
  references: Annotation[];
  referencedBy: ReferencedBy[];
  referencedByLoading: boolean;
  documentEntityTypes: string[];
}

export function DocumentInfoPanel({
  highlights,
  references,
  referencedBy,
  referencedByLoading,
  documentEntityTypes
}: Props) {
  const t = useTranslations('DocumentInfoPanel');

  // Count stub vs resolved references
  const stubCount = useMemo(
    () => references.filter((r) => r.body.source === null || r.body.source === undefined).length,
    [references]
  );

  const resolvedCount = useMemo(
    () => references.filter((r) => r.body.source !== null && r.body.source !== undefined).length,
    [references]
  );

  // Count entity types from references
  const entityTypesList = useMemo(() => {
    const entityTypeCounts = new Map<string, number>();
    references.forEach((ref) => {
      const entityTypes = ref.body.entityTypes || [];
      entityTypes.forEach((type: string) => {
        entityTypeCounts.set(type, (entityTypeCounts.get(type) || 0) + 1);
      });
    });

    return Array.from(entityTypeCounts.entries()).sort((a, b) => b[1] - a[1]); // Sort by count descending
  }, [references]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 space-y-4">
      {/* Entity Type Tags Section */}
      {documentEntityTypes.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">{t('entityTypeTags')}</h3>
          <div className="flex flex-wrap gap-1.5">
            {documentEntityTypes.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 rounded text-xs"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Statistics Section */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">{t('statistics')}</h3>
        <div className="space-y-3 text-sm">
        {/* Highlights */}
        <div>
          <span className="text-gray-500 dark:text-gray-400 block">{t('highlights')}</span>
          <span className="font-medium text-gray-900 dark:text-gray-100 text-lg">
            {highlights.length}
          </span>
        </div>

        {/* References */}
        <div>
          <span className="text-gray-500 dark:text-gray-400 block">{t('references')}</span>
          <span className="font-medium text-gray-900 dark:text-gray-100 text-lg">
            {references.length}
          </span>

          {/* Sub-categories indented */}
          <div className="ml-4 mt-2 space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-gray-500 dark:text-gray-400">{t('stub')}</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {stubCount}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500 dark:text-gray-400">{t('resolved')}</span>
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {resolvedCount}
              </span>
            </div>
          </div>
        </div>

        {/* Entity Types */}
        {entityTypesList.length > 0 && (
          <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
            <span className="text-gray-500 dark:text-gray-400 block mb-2">{t('entityTypes')}</span>
            <div className="space-y-2">
              {entityTypesList.map(([type, count]) => (
                <div
                  key={type}
                  className="flex justify-between items-center text-xs p-2 rounded bg-gray-50 dark:bg-gray-700/50"
                >
                  <span className="text-gray-700 dark:text-gray-300">{type}</span>
                  <span className="px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium">
                    {count}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Referenced By section */}
        <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
          <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
            {t('referencedBy')}
            {referencedByLoading && (
              <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">({t('loading')})</span>
            )}
          </h4>
          {referencedBy.length > 0 ? (
            <div className="space-y-2">
              {referencedBy.map((ref) => (
                <div key={ref.id} className="border border-gray-200 dark:border-gray-700 rounded p-2">
                  <Link
                    href={`/know/document/${encodeURIComponent(ref.target.source)}`}
                    className="text-sm text-blue-600 dark:text-blue-400 hover:underline block font-medium mb-1"
                  >
                    {ref.documentName || t('untitledDocument')}
                  </Link>
                  <span className="text-xs text-gray-500 dark:text-gray-400 italic line-clamp-2">
                    "{ref.target.selector?.exact || t('noText')}"
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {referencedByLoading ? t('loadingEllipsis') : t('noIncomingReferences')}
            </p>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
