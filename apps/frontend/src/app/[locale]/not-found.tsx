'use client';

import React from 'react';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';

export default function NotFound() {
  const t = useTranslations('NotFound');
  const locale = useLocale();

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                if (localStorage.theme === 'dark' || (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
                  document.documentElement.classList.add('dark')
                } else {
                  document.documentElement.classList.remove('dark')
                }
              } catch (_) {}
            `,
          }}
        />
      </head>
      <body className="bg-gray-50 dark:bg-gray-900">
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-center px-4">
            <h1 className="text-6xl font-bold text-gray-900 dark:text-white mb-4">{t('title')}</h1>
            <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-300 mb-4">
              {t('heading')}
            </h2>
            <p className="text-gray-600 dark:text-gray-400 mb-8">
              {t('message')}
            </p>
            <Link
              href={`/${locale}`}
              className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              {t('goHome')}
            </Link>
          </div>
        </div>
      </body>
    </html>
  );
}
