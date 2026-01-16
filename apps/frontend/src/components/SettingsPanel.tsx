'use client';

import React, { useTransition } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/routing';
import { LOCALES } from '@semiont/api-client';

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
      <h3 className="semiont-panel-title">
        {t('title')}
      </h3>

        <div className="space-y-4">
          {/* Line Numbers Toggle */}
          <div>
            <label className="flex items-center justify-between cursor-pointer">
              <span className="semiont-panel-label" style={{ marginBottom: 0 }}>
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
            <p className="semiont-panel-hint">
              {showLineNumbers ? t('lineNumbersVisible') : t('lineNumbersHidden')}
            </p>
          </div>

          {/* Theme Selection */}
          <div>
            <label className="semiont-panel-label">
              {t('theme')}
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => onThemeChange('light')}
                className={`flex-1 ${
                  theme === 'light'
                    ? 'semiont-panel-button-active'
                    : 'semiont-panel-button'
                }`}
              >
                ☀️ {t('themeLight')}
              </button>
              <button
                onClick={() => onThemeChange('dark')}
                className={`flex-1 ${
                  theme === 'dark'
                    ? 'semiont-panel-button-active'
                    : 'semiont-panel-button'
                }`}
              >
                🌙 {t('themeDark')}
              </button>
              <button
                onClick={() => onThemeChange('system')}
                className={`flex-1 ${
                  theme === 'system'
                    ? 'semiont-panel-button-active'
                    : 'semiont-panel-button'
                }`}
              >
                💻 {t('themeSystem')}
              </button>
            </div>
            <p className="semiont-panel-hint">
              {theme === 'system' ? t('themeSystemActive') : t('themeModeActive', { mode: theme.charAt(0).toUpperCase() + theme.slice(1) })}
            </p>
          </div>

          {/* Language Selection */}
          <div>
            <label htmlFor="language-select" className="semiont-panel-label">
              {t('language')}
            </label>
            <select
              id="language-select"
              value={locale}
              onChange={(e) => handleLocaleChange(e.target.value)}
              disabled={isPending}
              className="semiont-language-select"
            >
              {LOCALES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.nativeName}
                </option>
              ))}
            </select>
            <p className="semiont-panel-hint">
              {t('languageHint')}
            </p>
          </div>
        </div>
    </div>
  );
}
