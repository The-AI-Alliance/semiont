'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { formatLocaleDisplay } from '@semiont/api-client';

interface Props {
  documentEntityTypes: string[];
  documentLocale?: string | undefined;
  primaryMediaType?: string | undefined;
  primaryByteSize?: number | undefined;
}

export function ResourceInfoPanel({
  documentEntityTypes,
  documentLocale,
  primaryMediaType,
  primaryByteSize
}: Props) {
  const t = useTranslations('ResourceInfoPanel');

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

      {/* Representation Section */}
      {(primaryMediaType || primaryByteSize !== undefined) && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">{t('representation')}</h3>
          <div className="space-y-2 text-xs">
            {primaryMediaType && (
              <div>
                <span className="text-gray-500 dark:text-gray-400 block">{t('mediaType')}</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {primaryMediaType}
                </span>
              </div>
            )}
            {primaryByteSize !== undefined && (
              <div>
                <span className="text-gray-500 dark:text-gray-400 block">{t('byteSize')}</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {primaryByteSize.toLocaleString()} bytes
                </span>
              </div>
            )}
          </div>
        </div>
      )}

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
    </div>
  );
}
