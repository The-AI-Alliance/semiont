'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { SemiontBranding } from '../SemiontBranding';
import { useAuth } from '@/hooks/useAuth';
import { useDropdown } from '@/hooks/useUI';
import { ChevronLeftIcon, Bars3Icon } from '@heroicons/react/24/outline';

interface LeftSidebarProps {
  children: React.ReactNode | ((isCollapsed: boolean, toggleCollapsed: () => void) => React.ReactNode);
  brandingLink?: string;
  collapsible?: boolean;
  storageKey?: string;
}

export function LeftSidebar({
  children,
  brandingLink = '/',
  collapsible = false,
  storageKey = 'leftSidebarCollapsed'
}: LeftSidebarProps) {
  const { isAuthenticated, isAdmin, isModerator } = useAuth();
  const { isOpen, toggle, close, dropdownRef } = useDropdown();
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Load collapsed state from localStorage on mount (only if collapsible)
  useEffect(() => {
    if (collapsible) {
      const saved = localStorage.getItem(storageKey);
      if (saved === 'true') {
        setIsCollapsed(true);
      }
    }
  }, [collapsible, storageKey]);

  // Save collapsed state to localStorage
  const toggleCollapsed = () => {
    if (!collapsible) return;
    const newState = !isCollapsed;
    setIsCollapsed(newState);
    localStorage.setItem(storageKey, newState.toString());
  };

  return (
    <aside className={`${isCollapsed ? 'w-14' : 'w-64'} bg-white dark:bg-gray-900 shadow border-r border-gray-200 dark:border-gray-700 flex-shrink-0 flex flex-col transition-all duration-300 ease-in-out`}>
      {/* Logo Header - fixed height for alignment */}
      <div className={`${isCollapsed ? 'p-2' : 'p-4'} h-24 border-b border-gray-200 dark:border-gray-700 flex items-center justify-center`} ref={dropdownRef}>
        <button
          onClick={toggle}
          className="hover:opacity-80 transition-opacity focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 rounded"
          aria-label="Navigation menu"
          aria-expanded={isOpen}
          aria-controls="sidebar-nav-dropdown"
          aria-haspopup="true"
          id="sidebar-nav-button"
        >
          {isCollapsed ? (
            // Collapsed: Just show "S" with gradient
            <div className="text-3xl font-bold font-orbitron">
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-gray-800 via-cyan-600 to-gray-800 dark:from-white dark:via-cyan-400 dark:to-white">
                S
              </span>
            </div>
          ) : (
            // Expanded: Show branding without tagline, no extra padding
            <SemiontBranding
              size="sm"
              showTagline={false}
              animated={false}
              className=""
            />
          )}
        </button>

        {/* Dropdown Menu */}
        {isOpen && isAuthenticated && (
          <div
            id="sidebar-nav-dropdown"
            className="absolute left-4 top-20 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50"
            role="menu"
            aria-orientation="vertical"
            aria-labelledby="sidebar-nav-button"
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

      {/* Navigation Content */}
      <div className="flex-1 overflow-y-auto">
        {typeof children === 'function' ? children(isCollapsed, toggleCollapsed) : children}
      </div>
    </aside>
  );
}
