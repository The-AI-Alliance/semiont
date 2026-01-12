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
      <footer className="semiont-footer">
        <div className="semiont-footer__container">
          <div className="semiont-footer__content">
            <div className="semiont-footer__copyright">
              {t('copyright', { year: new Date().getFullYear() })}
            </div>

            <div className="semiont-footer__links">
              <Link
                href={routes.about?.() || '/about'}
                className="semiont-footer__link"
              >
                {t('about')}
              </Link>
              <Link
                href={routes.privacy?.() || '/privacy'}
                className="semiont-footer__link"
              >
                {t('privacyPolicy')}
              </Link>
              {CookiePreferences && (
                <button
                  onClick={() => setShowCookiePreferences(true)}
                  className="semiont-footer__link"
                >
                  {t('cookiePreferences')}
                </button>
              )}
              {onOpenKeyboardHelp && (
                <button
                  onClick={onOpenKeyboardHelp}
                  className="semiont-footer__link semiont-footer__link--keyboard"
                >
                  {t('keyboardShortcuts')}
                  <kbd className="semiont-footer__kbd">
                    ?
                  </kbd>
                </button>
              )}
              <Link
                href={routes.terms?.() || '/terms'}
                className="semiont-footer__link"
              >
                {t('termsOfService')}
              </Link>
              <a
                href={apiDocsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="semiont-footer__link"
              >
                {t('apiDocs')}
              </a>
              <a
                href={sourceCodeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="semiont-footer__link"
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
