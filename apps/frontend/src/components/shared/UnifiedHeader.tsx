'use client';

import React from 'react';
import Link from 'next/link';
import { UserMenu } from '../UserMenu';
import { SemiontBranding } from '../SemiontBranding';

interface UnifiedHeaderProps {
  showBranding?: boolean;
  showAuthLinks?: boolean;
  brandingLink?: string;
  variant?: 'standalone' | 'embedded';
}

export function UnifiedHeader({ 
  showBranding = true, 
  showAuthLinks = true,
  brandingLink = '/',
  variant = 'standalone'
}: UnifiedHeaderProps) {
  const content = (
    <div className={variant === 'standalone' ? "flex justify-between items-center h-16" : "flex justify-between items-center w-full mb-8"}>
      {showBranding ? (
        <Link 
          href={brandingLink} 
          className="hover:opacity-80 transition-opacity"
        >
          <SemiontBranding 
            size="sm" 
            showTagline={true} 
            animated={false}
            compactTagline={true}
            className="py-1"
          />
        </Link>
      ) : (
        <div></div>
      )}
      
      <div className={variant === 'standalone' ? "flex items-center space-x-4" : "text-right relative"}>
        <UserMenu showAuthLinks={showAuthLinks} />
      </div>
    </div>
  );

  if (variant === 'standalone') {
    return (
      <header className="bg-white dark:bg-gray-900 shadow border-b border-gray-200 dark:border-gray-700">
        <div className="px-4 sm:px-6 lg:px-8">
          {content}
        </div>
      </header>
    );
  }

  return content;
}