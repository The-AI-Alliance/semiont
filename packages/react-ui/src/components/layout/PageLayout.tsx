'use client';

import React from 'react';
import { UnifiedHeader } from './UnifiedHeader';
import { Footer } from '../navigation/Footer';
import { SkipLinks } from '../SkipLinks';
import type { LinkComponentProps, RouteBuilder } from '../../contexts/RoutingContext';
import type { TranslateFn } from '../../types/translation';

interface PageLayoutProps {
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;
  t: TranslateFn;
  tNav: TranslateFn;
  tHome: TranslateFn;
  children: React.ReactNode;
  className?: string;
  showAuthLinks?: boolean;
  CookiePreferences?: React.ComponentType<{ isOpen: boolean; onClose: () => void }>;
  onOpenKeyboardHelp?: () => void;
}

export function PageLayout({
  Link,
  routes,
  t,
  tNav,
  tHome,
  children,
  className = '',
  showAuthLinks = true,
  CookiePreferences,
  onOpenKeyboardHelp
}: PageLayoutProps) {
  return (
    <div className="semiont-page-layout">
      <SkipLinks />

      <header role="banner" className="semiont-page-layout__header">
        <div className="semiont-page-layout__header-container">
          <UnifiedHeader
            Link={Link}
            routes={routes}
            t={tNav}
            tHome={tHome}
            showAuthLinks={showAuthLinks}
            brandingLink="/"
            variant="embedded"
          />
        </div>
      </header>

      <main
        role="main"
        id="main-content"
        tabIndex={-1}
        className={`semiont-page-layout__main ${className}`}
      >
        {children}
      </main>

      <Footer
        Link={Link}
        routes={routes}
        t={t}
        {...(CookiePreferences && { CookiePreferences })}
        {...(onOpenKeyboardHelp && { onOpenKeyboardHelp })}
      />
    </div>
  );
}
