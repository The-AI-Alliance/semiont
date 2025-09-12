import React from 'react';
import { Header } from './Header';
import { Footer } from './Footer';

interface PageLayoutProps {
  children: React.ReactNode;
  className?: string;
}

export function PageLayout({ children, className = '' }: PageLayoutProps) {
  return (
    <div className="flex flex-col min-h-screen">
      <header className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <Header />
        </div>
      </header>
      
      <main className={`flex-1 ${className}`}>
        {children}
      </main>
      
      <Footer />
    </div>
  );
}