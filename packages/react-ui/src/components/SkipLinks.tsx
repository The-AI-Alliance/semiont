'use client';

import React from 'react';

/**
 * Skip links for keyboard navigation accessibility
 * These links are visually hidden but become visible when focused
 * They allow keyboard users to quickly jump to main content areas
 */
export function SkipLinks() {
  return (
    <div className="sr-only focus-within:not-sr-only">
      <div className="absolute top-0 left-0 z-[9999] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg">
        <a
          href="#main-content"
          className="block px-4 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-700 focus:bg-gray-50 dark:focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-t-lg"
        >
          Skip to main content
        </a>
        <a
          href="#main-navigation"
          className="block px-4 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-700 focus:bg-gray-50 dark:focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          Skip to navigation
        </a>
        <a
          href="#search"
          className="block px-4 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-700 focus:bg-gray-50 dark:focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-b-lg"
        >
          Skip to search
        </a>
      </div>
    </div>
  );
}