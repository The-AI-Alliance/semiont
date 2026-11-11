import { useEffect, useState } from 'react';
import { LOCALES } from '@semiont/core';
import { useDesktopLocale } from '../providers';

/** Language choices for the shared Semiont interface, opened from the Semiont menu. */
export function LanguagePanel({ onClose }: { onClose: () => void }) {
  const { locale, setLocale, loaded } = useDesktopLocale();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleChange = (nextLocale: string) => {
    const selected = LOCALES.find((language) => language.code === nextLocale);
    if (!selected) return;
    setSaving(true);
    void setLocale(selected.code).finally(() => setSaving(false));
  };

  return (
    <div className="modal" onClick={onClose}>
      <section className="config config--modal language-modal" role="dialog" aria-modal="true" aria-labelledby="language-title" onClick={(event) => event.stopPropagation()}>
        <div className="config__head">
          <h1 id="language-title">Language</h1>
          <button type="button" className="config__close" onClick={onClose} aria-label="Close language settings">×</button>
        </div>
        <label className="language-modal__label" htmlFor="desktop-language">Language</label>
        <select
          id="desktop-language"
          className="language-modal__select"
          value={locale}
          onChange={(event) => handleChange(event.target.value)}
          disabled={!loaded || saving}
          aria-busy={!loaded || saving}
        >
          {LOCALES.map((language) => (
            <option key={language.code} value={language.code}>{language.nativeName}</option>
          ))}
        </select>
        <p className="language-modal__hint" aria-live="polite">
          {!loaded ? 'Loading saved language…' : saving ? 'Saving language…' : 'This changes the language used by Semiont’s shared interface. Desktop-specific controls are currently English-only.'}
        </p>
      </section>
    </div>
  );
}
