'use client';

import React, { useEffect } from 'react';
import { LOCALES } from '@semiont/api-client';
import { useTranslations } from '../../contexts/TranslationContext';
import { useLanguageChangeAnnouncements } from '../LiveRegion';
import { useEventBus } from '../../contexts/EventBusContext';
import './SettingsPanel.css';

interface SettingsPanelProps {
  showLineNumbers: boolean;
  theme: 'light' | 'dark' | 'system';
  locale: string;
  isPendingLocaleChange?: boolean;
  hoverDelayMs: number;
}

/**
 * Settings panel for application preferences
 *
 * @emits settings:locale-changed - Locale changed by user. Payload: { locale: string }
 * @emits settings:line-numbers-toggled - Line numbers toggled on/off. Payload: undefined
 * @emits settings:theme-changed - Theme changed by user. Payload: { theme: 'light' | 'dark' | 'system' }
 * @emits settings:hover-delay-changed - Hover delay changed by user. Payload: { hoverDelayMs: number }
 */
export function SettingsPanel({
  showLineNumbers,
  theme,
  locale,
  isPendingLocaleChange = false,
  hoverDelayMs
}: SettingsPanelProps) {
  const t = useTranslations('Settings');
  const eventBus = useEventBus();
  const { announceLanguageChanging, announceLanguageChanged } = useLanguageChangeAnnouncements();

  // Track previous locale to detect changes
  const [previousLocale, setPreviousLocale] = React.useState(locale);

  // Handle language change with announcement
  const handleLocaleChange = (newLocale: string) => {
    const localeName = LOCALES.find(l => l.code === newLocale)?.nativeName || newLocale;
    announceLanguageChanging(localeName);
    eventBus.get('settings:locale-changed').next({ locale: newLocale });
  };

  // Announce when language has successfully changed
  useEffect(() => {
    if (locale !== previousLocale && !isPendingLocaleChange) {
      const localeName = LOCALES.find(l => l.code === locale)?.nativeName || locale;
      announceLanguageChanged(localeName);
      setPreviousLocale(locale);
    }
  }, [locale, previousLocale, isPendingLocaleChange]);

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
              onClick={() => eventBus.get('settings:line-numbers-toggled').next(undefined)}
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
              onClick={() => eventBus.get('settings:theme-changed').next({ theme: 'light' })}
              className={`semiont-panel-button ${
                theme === 'light' ? 'semiont-panel-button-active' : ''
              }`}
              aria-pressed={theme === 'light'}
            >
              ☀️ {t('themeLight')}
            </button>
            <button
              onClick={() => eventBus.get('settings:theme-changed').next({ theme: 'dark' })}
              className={`semiont-panel-button ${
                theme === 'dark' ? 'semiont-panel-button-active' : ''
              }`}
              aria-pressed={theme === 'dark'}
            >
              🌙 {t('themeDark')}
            </button>
            <button
              onClick={() => eventBus.get('settings:theme-changed').next({ theme: 'system' })}
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
            className="semiont-select"
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

        {/* Hover Delay Slider */}
        <div className="semiont-settings-panel__field">
          <label htmlFor="hover-delay-slider" className="semiont-form__label">
            {t('hoverDelay')}
          </label>
          <input
            id="hover-delay-slider"
            type="range"
            min="0"
            max="500"
            step="50"
            value={hoverDelayMs}
            onChange={(e) => eventBus.get('settings:hover-delay-changed').next({ hoverDelayMs: Number(e.target.value) })}
            className="semiont-slider"
            aria-describedby="hover-delay-description"
          />
          <div className="semiont-slider__labels">
            <span>{t('hoverDelayFast')}</span>
            <span>{t('hoverDelaySlow')}</span>
          </div>
          <p id="hover-delay-description" className="semiont-form__help">
            {t('hoverDelayDescription', { delay: hoverDelayMs })}
          </p>
        </div>
      </div>
    </div>
  );
}