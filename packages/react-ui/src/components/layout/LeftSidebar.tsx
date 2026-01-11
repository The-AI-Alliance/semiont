'use client';

import React, { useState, useEffect } from 'react';
import { NavigationMenu } from '../navigation/NavigationMenu';
import { SemiontBranding } from '../branding/SemiontBranding';
import { useDropdown } from '../../hooks/useUI';
import type { LinkComponentProps, RouteBuilder } from '../../contexts/RoutingContext';
import type { TranslateFn } from '../../types/translation';

interface LeftSidebarProps {
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;
  t: TranslateFn;
  tHome: TranslateFn;
  children: React.ReactNode | ((isCollapsed: boolean, toggleCollapsed: () => void) => React.ReactNode);
  brandingLink?: string;
  collapsible?: boolean;
  storageKey?: string;
  isAuthenticated?: boolean;
  isAdmin?: boolean;
  isModerator?: boolean;
}

export function LeftSidebar({
  Link,
  routes,
  t,
  tHome,
  children,
  brandingLink = '/',
  collapsible = false,
  storageKey = 'leftSidebarCollapsed',
  isAuthenticated = false,
  isAdmin = false,
  isModerator = false
}: LeftSidebarProps) {
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
              t={tHome}
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
            <NavigationMenu
              Link={Link}
              routes={routes}
              t={t}
              isAdmin={isAdmin}
              isModerator={isModerator}
              brandingLink={brandingLink}
              onItemClick={close}
            />
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
