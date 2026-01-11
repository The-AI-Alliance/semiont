'use client';

import React, { useState } from 'react';
import type { RouteBuilder, LinkComponentProps } from '../../contexts/RoutingContext';

type TranslateFn = (key: string, params?: Record<string, any>) => string;

interface FooterProps {
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;
  t: TranslateFn;
  CookiePreferences?: React.ComponentType<{ isOpen: boolean; onClose: () => void }>;
  onOpenKeyboardHelp?: () => void;
  apiDocsUrl?: string;
  sourceCodeUrl?: string;
}

export function Footer({
  Link,
  routes,
  t,
  CookiePreferences,
  onOpenKeyboardHelp,
  apiDocsUrl = '/api/docs',
  sourceCodeUrl = 'https://github.com/The-AI-Alliance/semiont'
}: FooterProps) {
  const [showCookiePreferences, setShowCookiePreferences] = useState(false);

  return (
    <>
      <footer className="bg-gray-50 dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 mt-auto font-sans">
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row justify-between items-center space-y-4 sm:space-y-0">
            <div className="text-sm text-gray-500">
              {t('copyright', { year: new Date().getFullYear() })}
            </div>

            <div className="flex space-x-6 text-sm">
              <Link
                href={routes.about?.() || '/about'}
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                {t('about')}
              </Link>
              <Link
                href={routes.privacy?.() || '/privacy'}
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                {t('privacyPolicy')}
              </Link>
              {CookiePreferences && (
                <button
                  onClick={() => setShowCookiePreferences(true)}
                  className="text-gray-500 hover:text-gray-700 transition-colors"
                >
                  {t('cookiePreferences')}
                </button>
              )}
              {onOpenKeyboardHelp && (
                <button
                  onClick={onOpenKeyboardHelp}
                  className="text-gray-500 hover:text-gray-700 transition-colors flex items-center gap-1"
                >
                  {t('keyboardShortcuts')}
                  <kbd className="hidden sm:inline-block px-1 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded">
                    ?
                  </kbd>
                </button>
              )}
              <Link
                href={routes.terms?.() || '/terms'}
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                {t('termsOfService')}
              </Link>
              <a
                href={apiDocsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                {t('apiDocs')}
              </a>
              <a
                href={sourceCodeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                {t('sourceCode')}
              </a>
            </div>
          </div>
        </div>
      </footer>

      {CookiePreferences && (
        <CookiePreferences
          isOpen={showCookiePreferences}
          onClose={() => setShowCookiePreferences(false)}
        />
      )}
    </>
  );
}
