'use client';

import React from 'react';
import { UnifiedHeader } from './UnifiedHeader';
import { Footer } from '../navigation/Footer';
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
    <div className="flex flex-col min-h-screen">
      <header className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
        <div className="px-4 sm:px-6 lg:px-8 py-4">
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

      <main className={`flex-1 ${className}`}>
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
