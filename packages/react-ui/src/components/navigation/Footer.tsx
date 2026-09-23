'use client';

import React from 'react';
import type { RouteBuilder, LinkComponentProps } from '../../contexts/RoutingContext';
import '../layout/Footer.css';

type TranslateFn = (key: string, params?: Record<string, any>) => string;

interface FooterProps {
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;
  t: TranslateFn;
  onOpenKeyboardHelp?: () => void;
  sourceCodeUrl?: string;
  /** Show About, Privacy Policy and Terms of Service links. False for desktop apps. */
  showPolicyLinks?: boolean;
}

export function Footer({
  Link,
  routes,
  t,
  onOpenKeyboardHelp,
  sourceCodeUrl = 'https://github.com/The-AI-Alliance/semiont',
  showPolicyLinks = true,
}: FooterProps) {

  return (
    <>
      <footer role="contentinfo" className="semiont-footer">
        <div className="semiont-footer__container">
          <div className="semiont-footer__content">
            <div className="semiont-footer__copyright">
              {t('copyright', { year: new Date().getFullYear() })}
            </div>

            <div className="semiont-footer__links">
              {showPolicyLinks && (
                <>
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
                  <Link
                    href={routes.terms?.() || '/terms'}
                    className="semiont-footer__link"
                  >
                    {t('termsOfService')}
                  </Link>
                </>
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
    </>
  );
}
