'use client';

import React, { useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/routing';
import { LOCALES } from '@semiont/sdk';

interface Props {
  showLineNumbers: boolean;
  onLineNumbersToggle: () => void;
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
}

export function SettingsPanel({
  showLineNumbers,
  onLineNumbersToggle,
  theme,
  onThemeChange
}: Props) {
  const t = useTranslations('Settings');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const handleLocaleChange = (newLocale: string) => {
    if (!pathname) return;

    startTransition(() => {
      // The router from @/i18n/routing is locale-aware and will handle the locale prefix
      router.replace(pathname, { locale: newLocale });
    });
  };

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
        {t('title')}
      </h3>

        <div className="space-y-4">
          {/* Line Numbers Toggle */}
          <div>
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('lineNumbers')}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={showLineNumbers}
                onClick={onLineNumbersToggle}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
                  showLineNumbers ? 'bg-blue-600' : 'bg-gray-400 dark:bg-gray-700'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
                    showLineNumbers ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </label>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {showLineNumbers ? t('lineNumbersVisible') : t('lineNumbersHidden')}
            </p>
          </div>

          {/* Theme Selection */}
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-2">
              {t('theme')}
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => onThemeChange('light')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  theme === 'light'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                ☀️ {t('themeLight')}
              </button>
              <button
                onClick={() => onThemeChange('dark')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  theme === 'dark'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                🌙 {t('themeDark')}
              </button>
              <button
                onClick={() => onThemeChange('system')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  theme === 'system'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                }`}
              >
                💻 {t('themeSystem')}
              </button>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {theme === 'system' ? t('themeSystemActive') : t('themeModeActive', { mode: theme.charAt(0).toUpperCase() + theme.slice(1) })}
            </p>
          </div>

          {/* Language Selection */}
          <div>
            <label htmlFor="language-select" className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-2">
              {t('language')}
            </label>
            <select
              id="language-select"
              value={locale}
              onChange={(e) => handleLocaleChange(e.target.value)}
              disabled={isPending}
              className="w-full px-3 py-2 rounded-lg text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
            >
              {LOCALES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.nativeName}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              {t('languageHint')}
            </p>
          </div>
        </div>
    </div>
  );
}
