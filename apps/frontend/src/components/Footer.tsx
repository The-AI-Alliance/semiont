"use client";

import React, { useState, useContext } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CookiePreferences } from '@/components/CookiePreferences';
import { KeyboardShortcutsContext } from '@semiont/react-ui';

export function Footer() {
  const [showCookiePreferences, setShowCookiePreferences] = useState(false);
  const t = useTranslations('Footer');

  // Get keyboard shortcuts context if available (may not be available in all contexts)
  const keyboardContext = useContext(KeyboardShortcutsContext);

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
                href="/about"
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                {t('about')}
              </Link>
              <Link
                href="/privacy"
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                {t('privacyPolicy')}
              </Link>
              <button
                onClick={() => setShowCookiePreferences(true)}
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                {t('cookiePreferences')}
              </button>
              {keyboardContext && (
                <button
                  onClick={() => keyboardContext.openKeyboardHelp()}
                  className="text-gray-500 hover:text-gray-700 transition-colors flex items-center gap-1"
                >
                  {t('keyboardShortcuts')}
                  <kbd className="hidden sm:inline-block px-1 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded">
                    ?
                  </kbd>
                </button>
              )}
              <Link
                href="/terms"
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                {t('termsOfService')}
              </Link>
              <a
                href="/api/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-500 hover:text-gray-700 transition-colors"
              >
                {t('apiDocs')}
              </a>
              <a
                href="https://github.com/The-AI-Alliance/semiont"
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

      <CookiePreferences 
        isOpen={showCookiePreferences}
        onClose={() => setShowCookiePreferences(false)}
      />
    </>
  );
}

export default Footer;