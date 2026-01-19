'use client';

import React, { useTransition, useEffect } from 'react';
import { LOCALES } from '@semiont/api-client';
import { useTranslations } from '../../contexts/TranslationContext';
import { useLanguageChangeAnnouncements } from '../LiveRegion';

interface SettingsPanelProps {
  showLineNumbers: boolean;
  onLineNumbersToggle: () => void;
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  locale: string;
  onLocaleChange: (locale: string) => void;
  isPendingLocaleChange?: boolean;
}

export function SettingsPanel({
  showLineNumbers,
  onLineNumbersToggle,
  theme,
  onThemeChange,
  locale,
  onLocaleChange,
  isPendingLocaleChange = false
}: SettingsPanelProps) {
  const t = useTranslations('Settings');
  const { announceLanguageChanging, announceLanguageChanged } = useLanguageChangeAnnouncements();

  // Track previous locale to detect changes
  const [previousLocale, setPreviousLocale] = React.useState(locale);

  // Handle language change with announcement
  const handleLocaleChange = (newLocale: string) => {
    const localeName = LOCALES.find(l => l.code === newLocale)?.nativeName || newLocale;
    announceLanguageChanging(localeName);
    onLocaleChange(newLocale);
  };

  // Announce when language has successfully changed
  useEffect(() => {
    if (locale !== previousLocale && !isPendingLocaleChange) {
      const localeName = LOCALES.find(l => l.code === locale)?.nativeName || locale;
      announceLanguageChanged(localeName);
      setPreviousLocale(locale);
    }
  }, [locale, previousLocale, isPendingLocaleChange, announceLanguageChanged]);

  return (
    <div className="semiont-settings-panel">
      <h3 className="semiont-settings-panel__title">
        {t('title')}
      </h3>

      <div className="semiont-settings-panel__content">
        {/* Line Numbers Toggle */}
        <div className="semiont-settings-panel__field">
          <label className="semiont-toggle-label">
            <span className="semiont-toggle-label__text">
              {t('lineNumbers')}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={showLineNumbers}
              onClick={onLineNumbersToggle}
              className={`semiont-toggle ${
                showLineNumbers ? 'semiont-toggle--active' : ''
              }`}
            >
              <span
                className={`semiont-toggle__slider ${
                  showLineNumbers ? 'semiont-toggle__slider--active' : ''
                }`}
              />
            </button>
          </label>
          <p className="semiont-form__help">
            {showLineNumbers ? t('lineNumbersVisible') : t('lineNumbersHidden')}
          </p>
        </div>

        {/* Theme Selection */}
        <div className="semiont-settings-panel__field">
          <label className="semiont-form__label">
            {t('theme')}
          </label>
          <div className="semiont-settings-panel__button-group">
            <button
              onClick={() => onThemeChange('light')}
              className={`semiont-panel-button ${
                theme === 'light' ? 'semiont-panel-button-active' : ''
              }`}
              aria-pressed={theme === 'light'}
            >
              ☀️ {t('themeLight')}
            </button>
            <button
              onClick={() => onThemeChange('dark')}
              className={`semiont-panel-button ${
                theme === 'dark' ? 'semiont-panel-button-active' : ''
              }`}
              aria-pressed={theme === 'dark'}
            >
              🌙 {t('themeDark')}
            </button>
            <button
              onClick={() => onThemeChange('system')}
              className={`semiont-panel-button ${
                theme === 'system' ? 'semiont-panel-button-active' : ''
              }`}
              aria-pressed={theme === 'system'}
            >
              💻 {t('themeSystem')}
            </button>
          </div>
          <p className="semiont-form__help" aria-live="polite">
            {theme === 'system'
              ? t('themeSystemActive')
              : t('themeModeActive', { mode: theme.charAt(0).toUpperCase() + theme.slice(1) })}
          </p>
        </div>

        {/* Language Selection */}
        <div className="semiont-settings-panel__field">
          <label htmlFor="language-select" className="semiont-form__label">
            {t('language')}
          </label>
          <select
            id="language-select"
            value={locale}
            onChange={(e) => handleLocaleChange(e.target.value)}
            disabled={isPendingLocaleChange}
            className="semiont-form__select"
            aria-busy={isPendingLocaleChange}
            aria-describedby="language-hint"
          >
            {LOCALES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.nativeName}
              </option>
            ))}
          </select>
          <p id="language-hint" className="semiont-form__help">
            {t('languageHint')}
          </p>
          {isPendingLocaleChange && (
            <p className="semiont-settings-panel__loading" role="status" aria-live="polite">
              {t('languageChanging')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}