import { useEffect } from 'react';
import { useLineNumbers } from '@semiont/react-ui';
import { useDesktopLocale } from '../providers';
import type { Theme } from '../lib/theme';

/**
 * Appearance preferences (theme and line numbers), opened from the Semiont menu.
 */
export function AppearancePanel({
  theme,
  onThemeChange,
  onClose,
}: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onClose: () => void;
}) {
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();
  const { loaded } = useDesktopLocale();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const options: { value: Theme; label: string; hint: string }[] = [
    { value: 'light', label: 'Light', hint: 'Always light' },
    { value: 'dark', label: 'Dark', hint: 'Always dark' },
    { value: 'system', label: 'System', hint: 'Match your OS setting' },
  ];

  return (
    <div className="modal" onClick={onClose}>
      <div className="config config--modal" role="dialog" aria-modal="true" aria-labelledby="appearance-title" onClick={(e) => e.stopPropagation()}>
        <div className="config__head">
          <h1 id="appearance-title">Appearance</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close appearance settings">
            ×
          </button>
        </div>

        <fieldset className="settings__group">
          <legend className="settings__legend">Theme</legend>
          <ul className="settings__options">
            {options.map((o) => (
              <li key={o.value}>
                <label className={`settings__option${theme === o.value ? ' settings__option--on' : ''}`}>
                  <input type="radio" name="theme" checked={theme === o.value} onChange={() => onThemeChange(o.value)} />
                  <span className="settings__option-name">{o.label}</span>
                  <span className="settings__option-hint">{o.hint}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        <div className="settings__line-numbers">
          <label className="semiont-toggle-label">
            <span className="semiont-toggle-label__text">Show line numbers</span>
            <button
              type="button"
              role="switch"
              aria-checked={showLineNumbers}
              aria-busy={!loaded}
              disabled={!loaded}
              onClick={toggleLineNumbers}
              className={`semiont-toggle ${showLineNumbers ? 'semiont-toggle--active' : ''}`}
            >
              <span className={`semiont-toggle__slider ${showLineNumbers ? 'semiont-toggle__slider--active' : ''}`} />
            </button>
          </label>
          <p className="appearance-modal__hint">
            {!loaded
              ? 'Loading saved display preferences…'
              : showLineNumbers
              ? 'Line numbers are shown in supported text views and the resource editor.'
              : 'Show line numbers in supported text views and the resource editor.'}
          </p>
        </div>
      </div>
    </div>
  );
}
