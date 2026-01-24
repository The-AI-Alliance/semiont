'use client';

import React, { useState, useEffect } from 'react';
import { SemiontBranding } from '../branding/SemiontBranding';
import { NavigationMenu } from '../navigation/NavigationMenu';
import { ResizeHandle } from '../ResizeHandle';
import { usePanelWidth } from '../../hooks/usePanelWidth';
import type { LinkComponentProps, RouteBuilder } from '../../contexts/RoutingContext';
import type { TranslateFn } from '../../types/translation';

export interface NavigationMenuHelper {
  (onClose: () => void): React.ReactNode;
}

interface LeftSidebarProps {
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;
  t: TranslateFn;
  tHome: TranslateFn;
  children: React.ReactNode | ((
    isCollapsed: boolean,
    toggleCollapsed: () => void,
    navigationMenu: NavigationMenuHelper
  ) => React.ReactNode);
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
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Sidebar width management with localStorage persistence
  // Only applies when not collapsed
  const { width, setWidth, minWidth, maxWidth } = usePanelWidth({
    defaultWidth: 256, // 16rem
    minWidth: 192,     // 12rem
    maxWidth: 400,     // 25rem
    storageKey: 'semiont-left-sidebar-width'
  });

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

  // Helper function to render NavigationMenu in dropdowns
  const navigationMenu: NavigationMenuHelper = (onClose) => (
    <NavigationMenu
      Link={Link}
      routes={routes}
      t={t}
      isAdmin={isAdmin}
      isModerator={isModerator}
      brandingLink={brandingLink}
      onItemClick={onClose}
      currentPath={currentPath}
    />
  );

  return (
    <aside
      className="semiont-left-sidebar"
      data-collapsed={isCollapsed}
      style={!isCollapsed ? { width: `${width}px`, position: 'relative' } : undefined}
    >
      {/* Resize handle on right edge - only when expanded */}
      {!isCollapsed && (
        <ResizeHandle
          onResize={setWidth}
          minWidth={minWidth}
          maxWidth={maxWidth}
          position="right"
          ariaLabel="Resize left sidebar"
        />
      )}

      {/* Logo Header - fixed height for alignment */}
      <div
        className="semiont-left-sidebar__header"
        data-collapsed={isCollapsed}
      >
        <Link
          href={brandingLink}
          className="semiont-left-sidebar__branding-button"
          aria-label="Go to home page"
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
        </Link>
      </div>

      {/* Navigation Content */}
      <nav
        role="navigation"
        aria-label="Main navigation"
        id="main-navigation"
        className="semiont-left-sidebar__content"
      >
        {typeof children === 'function' ? children(isCollapsed, toggleCollapsed, navigationMenu) : children}
      </nav>
    </aside>
  );
}
