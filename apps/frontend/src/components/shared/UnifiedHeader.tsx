'use client';

import React from 'react';
import Link from 'next/link';
import { SemiontBranding } from '../SemiontBranding';
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
  const { isAuthenticated, isAdmin, isModerator } = useAuth();
  const { isOpen, toggle, close, dropdownRef } = useDropdown();

  // Floating variant - just the logo button, positioned absolutely
  if (variant === 'floating' && showBranding) {
    return (
      <div className="fixed top-4 left-4 z-50" ref={dropdownRef}>
        <button
          onClick={toggle}
          className="hover:opacity-80 transition-opacity focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded bg-white dark:bg-gray-900 shadow-lg border border-gray-200 dark:border-gray-700 px-3 py-2"
          aria-label="Navigation menu"
          aria-expanded={isOpen}
          aria-haspopup="true"
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
            className="absolute left-0 mt-2 w-48 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700"
            role="menu"
            aria-orientation="vertical"
          >
            <div className="p-3">
              <Link
                href={brandingLink}
                onClick={close}
                className="w-full text-left text-sm text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 py-1 transition-colors focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-700 rounded block"
                role="menuitem"
                tabIndex={0}
                aria-label="Go to home page"
              >
                Home
              </Link>
              <hr className="my-2 border-gray-200 dark:border-gray-600" />
              <Link
                href="/know"
                onClick={close}
                className="w-full text-left text-sm text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 py-1 transition-colors focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-700 rounded block"
                role="menuitem"
                tabIndex={0}
                aria-label="Go to knowledge base"
              >
                Know
              </Link>
              <hr className="my-2 border-gray-200 dark:border-gray-600" />
              {(isModerator || isAdmin) && (
                <>
                  <Link
                    href="/moderate"
                    onClick={close}
                    className="w-full text-left text-sm text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 py-1 transition-colors focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-700 rounded block"
                    role="menuitem"
                    tabIndex={0}
                    aria-label="Access moderation dashboard"
                  >
                    Moderate
                  </Link>
                  <hr className="my-2 border-gray-200 dark:border-gray-600" />
                </>
              )}
              {isAdmin && (
                <Link
                  href="/admin"
                  onClick={close}
                  className="w-full text-left text-sm text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 py-1 transition-colors focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-700 rounded block"
                  role="menuitem"
                  tabIndex={0}
                  aria-label="Access admin dashboard"
                >
                  Administer
                </Link>
              )}
            </div>
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
            aria-haspopup="true"
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
              className="absolute left-0 mt-2 w-48 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50"
              role="menu"
              aria-orientation="vertical"
            >
              <div className="p-3">
                <Link
                  href={brandingLink}
                  onClick={close}
                  className="w-full text-left text-sm text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 py-1 transition-colors focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-700 rounded block"
                  role="menuitem"
                  tabIndex={0}
                  aria-label="Go to home page"
                >
                  Home
                </Link>
                <hr className="my-2 border-gray-200 dark:border-gray-600" />
                <Link
                  href="/know"
                  onClick={close}
                  className="w-full text-left text-sm text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 py-1 transition-colors focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-700 rounded block"
                  role="menuitem"
                  tabIndex={0}
                  aria-label="Go to knowledge base"
                >
                  Know
                </Link>
                <hr className="my-2 border-gray-200 dark:border-gray-600" />
                {(isModerator || isAdmin) && (
                  <>
                    <Link
                      href="/moderate"
                      onClick={close}
                      className="w-full text-left text-sm text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 py-1 transition-colors focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-700 rounded block"
                      role="menuitem"
                      tabIndex={0}
                      aria-label="Access moderation dashboard"
                    >
                      Moderate
                    </Link>
                    <hr className="my-2 border-gray-200 dark:border-gray-600" />
                  </>
                )}
                {isAdmin && (
                  <Link
                    href="/admin"
                    onClick={close}
                    className="w-full text-left text-sm text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 py-1 transition-colors focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-700 rounded block"
                    role="menuitem"
                    tabIndex={0}
                    aria-label="Access admin dashboard"
                  >
                    Administer
                  </Link>
                )}
              </div>
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