import { useEffect } from 'react';
import type { Theme } from '../lib/theme';

/**
 * Theme choices (Light / Dark / System), opened from the Semiont menu.
 */
export function ThemePanel({
  theme,
  onThemeChange,
  onClose,
}: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onClose: () => void;
}) {
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
      <div className="config config--modal" role="dialog" aria-modal="true" aria-labelledby="theme-title" onClick={(e) => e.stopPropagation()}>
        <div className="config__head">
          <h1 id="theme-title">Theme</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close theme settings">
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
      </div>
    </div>
  );
}
