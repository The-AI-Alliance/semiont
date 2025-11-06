'use client';

import React, { useMemo } from 'react';
import { Link } from '@/i18n/routing';
import { useTranslations } from 'next-intl';
import type { components, paths } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type ResponseContent<T> = T extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
type ReferencedBy = ResponseContent<paths['/resources/{id}/referenced-by']['get']>['referencedBy'][number];
import { formatLocaleDisplay, getBodySource, isBodyResolved, getEntityTypes } from '@semiont/api-client';

interface Props {
  highlights: Annotation[];
  comments: Annotation[];
  assessments: Annotation[];
  references: Annotation[];
  referencedBy: ReferencedBy[];
  referencedByLoading: boolean;
  documentEntityTypes: string[];
  documentLocale?: string | undefined;
}

export function ResourceInfoPanel({
  highlights,
  comments,
  assessments,
  references,
  referencedBy,
  referencedByLoading,
  documentEntityTypes,
  documentLocale
}: Props) {
  const t = useTranslations('ResourceInfoPanel');

  // Count stub vs resolved references
  const stubCount = useMemo(
    () => references.filter((r) => !isBodyResolved(r.body)).length,
    [references]
  );

  const resolvedCount = useMemo(
    () => references.filter((r) => isBodyResolved(r.body)).length,
    [references]
  );

  // Count entity types from references (at annotation level)
  const entityTypesList = useMemo(() => {
    const entityTypeCounts = new Map<string, number>();
    references.forEach((ref) => {
      const entityTypes = getEntityTypes(ref);
      entityTypes.forEach((type: string) => {
        entityTypeCounts.set(type, (entityTypeCounts.get(type) || 0) + 1);
      });
    });

    return Array.from(entityTypeCounts.entries()).sort((a, b) => b[1] - a[1]); // Sort by count descending
  }, [references]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 space-y-4">
      {/* Locale Section */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">{t('locale')}</h3>
        {documentLocale ? (
          <div className="text-xs text-gray-700 dark:text-gray-300">
            {formatLocaleDisplay(documentLocale)}
          </div>
        ) : (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {t('notSpecified')}
          </div>
        )}
      </div>

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

        {/* Comments */}
        <div>
          <span className="text-gray-500 dark:text-gray-400 block">{t('comments')}</span>
          <span className="font-medium text-gray-900 dark:text-gray-100 text-lg">
            {comments.length}
          </span>
        </div>

        {/* Assessments */}
        <div>
          <span className="text-gray-500 dark:text-gray-400 block">{t('assessments')}</span>
          <span className="font-medium text-gray-900 dark:text-gray-100 text-lg">
            {assessments.length}
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
                    href={`/know/resource/${encodeURIComponent(ref.target.source)}`}
                    className="text-sm text-blue-600 dark:text-blue-400 hover:underline block font-medium mb-1"
                  >
                    {ref.resourceName || t('untitledResource')}
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
