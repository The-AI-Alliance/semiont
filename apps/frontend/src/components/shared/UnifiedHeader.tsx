'use client';

import React from 'react';
import { SemiontBranding } from '../SemiontBranding';
import { NavigationMenu } from './NavigationMenu';
import { useAuth } from '@/hooks/useAuth';
import { useDropdown } from '@/hooks/useUI';

interface UnifiedHeaderProps {
  showBranding?: boolean;
  showAuthLinks?: boolean;
  brandingLink?: string;
  variant?: 'standalone' | 'embedded' | 'floating';
}

export function UnifiedHeader({
  showBranding = true,
  showAuthLinks = true,
  brandingLink = '/',
  variant = 'standalone'
}: UnifiedHeaderProps) {
  const { isAuthenticated } = useAuth();
  const { isOpen, toggle, close, dropdownRef } = useDropdown();

  // Floating variant - just the logo button, positioned in the sidebar
  if (variant === 'floating' && showBranding) {
    return (
      <div className="fixed top-0 left-0 w-64 z-50 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 p-4" ref={dropdownRef}>
        <button
          onClick={toggle}
          className="w-full hover:opacity-80 transition-opacity focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded"
          aria-label="Navigation menu"
          aria-expanded={isOpen}
          aria-controls="nav-menu-dropdown-1"
          aria-haspopup="true"
          id="nav-menu-button-1"
        >
          <SemiontBranding
            size="sm"
            showTagline={true}
            animated={false}
            compactTagline={true}
            className="py-1"
          />
        </button>

        {/* Dropdown Menu */}
        {isOpen && isAuthenticated && (
          <div
            id="nav-menu-dropdown-1"
            className="absolute left-4 top-full mt-2 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700"
            role="menu"
            aria-orientation="vertical"
            aria-labelledby="nav-menu-button-1"
          >
            <NavigationMenu brandingLink={brandingLink} onItemClick={close} />
          </div>
        )}
      </div>
    );
  }

  const content = (
    <div className={variant === 'standalone' ? "flex justify-between items-center h-16" : "flex justify-between items-center w-full mb-8"}>
      {showBranding ? (
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={toggle}
            className="hover:opacity-80 transition-opacity focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded"
            aria-label="Navigation menu"
            aria-expanded={isOpen}
            aria-controls="nav-menu-dropdown-2"
            aria-haspopup="true"
            id="nav-menu-button-2"
          >
            <SemiontBranding
              size="sm"
              showTagline={true}
              animated={false}
              compactTagline={true}
              className="py-1"
            />
          </button>

          {/* Dropdown Menu */}
          {isOpen && isAuthenticated && (
            <div
              id="nav-menu-dropdown-2"
              className="absolute left-0 mt-2 w-48 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50"
              role="menu"
              aria-orientation="vertical"
              aria-labelledby="nav-menu-button-2"
            >
              <NavigationMenu brandingLink={brandingLink} onItemClick={close} />
            </div>
          )}
        </div>
      ) : (
        <div></div>
      )}

      <div className={variant === 'standalone' ? "flex items-center space-x-4" : "text-right relative"}>
        {/* UserMenu removed - navigation moved to logo dropdown */}
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