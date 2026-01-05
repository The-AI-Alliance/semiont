'use client';

import React, { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import type { components } from '@semiont/api-client';
import { isBodyResolved } from '@semiont/api-client';
import { getEntityTypes } from '@semiont/ontology';

type Annotation = components['schemas']['Annotation'];

interface StatisticsPanelProps {
  highlights: Annotation[];
  comments: Annotation[];
  assessments: Annotation[];
  references: Annotation[];
  tags: Annotation[];
}

export function StatisticsPanel({
  highlights,
  comments,
  assessments,
  references,
  tags
}: StatisticsPanelProps) {
  const t = useTranslations('StatisticsPanel');

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
    <div className="h-full overflow-y-auto">
      <div className="p-4 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('title')}
        </h2>

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

          {/* Tags */}
          <div>
            <span className="text-gray-500 dark:text-gray-400 block">{t('tags')}</span>
            <span className="font-medium text-gray-900 dark:text-gray-100 text-lg">
              {tags.length}
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
        </div>
      </div>
    </div>
  );
}
