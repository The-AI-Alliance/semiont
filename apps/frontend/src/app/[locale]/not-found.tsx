import React from 'react';
import { Link } from '@/i18n/routing';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/i18n/routing';

export default function NotFound() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`NotFound.${k}`, p as any) as string;
  const locale = useLocale();

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="text-center px-4">
        <h1 className="text-6xl font-bold text-gray-900 dark:text-white mb-4">{t('title')}</h1>
        <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-300 mb-4">
          {t('heading')}
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mb-8">
          {t('message')}
        </p>
        <Link
          to={`/${locale}`}
          className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          {t('goHome')}
        </Link>
      </div>
    </div>
  );
}
