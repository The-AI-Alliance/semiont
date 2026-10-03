'use client';

import type { ComponentProps } from 'react';
import { useTranslations } from '../../contexts/TranslationContext';
import './SkipLinks.css';

const MAIN_CONTENT_ID = 'main-content';

/**
 * Skip link for keyboard navigation accessibility
 * The link is visually hidden but becomes visible when focused
 * It lets keyboard users jump past the page's chrome to its MainContent
 */
export function SkipLinks() {
  const t = useTranslations('SkipLinks');

  return (
    <div className="semiont-skip-links">
      <div className="semiont-skip-links-container">
        <a href={`#${MAIN_CONTENT_ID}`} className="semiont-skip-link">
          {t('mainContent')}
        </a>
      </div>
    </div>
  );
}

/**
 * The page's main landmark, and the element the skip link lands on.
 * `tabIndex={-1}` lets it take focus from the link without joining the tab order.
 */
export function MainContent(props: Omit<ComponentProps<'main'>, 'id' | 'tabIndex'>) {
  return <main {...props} id={MAIN_CONTENT_ID} tabIndex={-1} />;
}
