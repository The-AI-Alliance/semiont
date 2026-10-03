'use client';

import React from 'react';
import { UnifiedHeader } from './UnifiedHeader';
import { MainContent } from './SkipLinks';
import type { LinkComponentProps, RouteBuilder } from '../../contexts/RoutingContext';
import type { TranslateFn } from '../../types/translation';

interface PageLayoutProps {
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;
  tNav: TranslateFn;
  tHome: TranslateFn;
  children: React.ReactNode;
  className?: string;
  showAuthLinks?: boolean;
}

export function PageLayout({
  Link,
  routes,
  tNav,
  tHome,
  children,
  className = '',
  showAuthLinks = true,
}: PageLayoutProps) {
  return (
    <div className="semiont-page-layout">
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

      <MainContent className={`semiont-page-layout__main ${className}`}>
        {children}
      </MainContent>
    </div>
  );
}
