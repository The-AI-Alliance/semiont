import React from 'react';
import { UnifiedHeader } from './shared/UnifiedHeader';
import { Footer } from './Footer';

interface PageLayoutProps {
  children: React.ReactNode;
  className?: string;
  showAuthLinks?: boolean;
}

export function PageLayout({ children, className = '', showAuthLinks = true }: PageLayoutProps) {
  return (
    <div className="flex flex-col min-h-screen">
      <header className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
        <div className="px-4 sm:px-6 lg:px-8 py-4">
          <UnifiedHeader 
            showAuthLinks={showAuthLinks}
            brandingLink="/"
            variant="embedded"
          />
        </div>
      </header>
      
      <main className={`flex-1 ${className}`}>
        {children}
      </main>
      
      <Footer />
    </div>
  );
}