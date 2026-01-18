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
  currentPath?: string;
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
  isModerator = false,
  currentPath
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
    <aside
      className="semiont-left-sidebar"
      data-collapsed={isCollapsed}
    >
      {/* Logo Header - fixed height for alignment */}
      <div
        className="semiont-left-sidebar__header"
        data-collapsed={isCollapsed}
        ref={dropdownRef}
      >
        <button
          onClick={toggle}
          className="semiont-left-sidebar__branding-button"
          aria-label="Navigation menu"
          aria-expanded={isOpen}
          aria-controls="sidebar-nav-dropdown"
          aria-haspopup="true"
          id="sidebar-nav-button"
        >
          {isCollapsed ? (
            // Collapsed: Just show "S" with gradient
            <div className="semiont-left-sidebar__logo-collapsed">
              <span className="semiont-left-sidebar__logo-text">
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
            className="semiont-left-sidebar__dropdown"
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
              currentPath={currentPath}
            />
          </div>
        )}
      </div>

      {/* Navigation Content */}
      <nav
        role="navigation"
        aria-label="Main navigation"
        id="main-navigation"
        className="semiont-left-sidebar__content"
      >
        {typeof children === 'function' ? children(isCollapsed, toggleCollapsed) : children}
      </nav>
    </aside>
  );
}
