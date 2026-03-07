'use client';

import React from 'react';
import { SemiontBranding } from '../branding/SemiontBranding';
import { NavigationMenu } from '../navigation/NavigationMenu';
import { useDropdown } from '../../hooks/useUI';
import type { LinkComponentProps, RouteBuilder } from '../../contexts/RoutingContext';
import type { TranslateFn } from '../../types/translation';
import './Header.css';

interface UnifiedHeaderProps {
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;
  t: TranslateFn;
  tHome: TranslateFn;
  showBranding?: boolean;
  showAuthLinks?: boolean;
  brandingLink?: string;
  variant?: 'standalone' | 'embedded' | 'floating';
  isAuthenticated?: boolean;
  isAdmin?: boolean;
  isModerator?: boolean;
  currentPath?: string;
}

export function UnifiedHeader({
  Link,
  routes,
  t,
  tHome,
  showBranding = true,
  brandingLink = '/',
  variant = 'standalone',
  isAuthenticated = false,
  isAdmin = false,
  isModerator = false,
  currentPath
}: UnifiedHeaderProps) {
  const { isOpen, toggle, close, dropdownRef } = useDropdown();

  // Floating variant - just the logo button, positioned in the sidebar
  if (variant === 'floating' && showBranding) {
    return (
      <div
        className="semiont-unified-header semiont-unified-header--floating"
        data-variant="floating"
        ref={dropdownRef}
      >
        <button
          onClick={toggle}
          className="semiont-unified-header__branding-button"
          aria-label="Navigation menu"
          aria-expanded={isOpen}
          aria-controls="nav-menu-dropdown-1"
          aria-haspopup="true"
          id="nav-menu-button-1"
        >
          <SemiontBranding
            t={tHome}
            size="sm"
            showTagline={true}
            animated={false}
            compactTagline={true}
            className="semiont-unified-header__branding"
          />
        </button>

        {/* Dropdown Menu */}
        {isOpen && isAuthenticated && (
          <div
            id="nav-menu-dropdown-1"
            className="semiont-unified-header__dropdown"
            role="menu"
            aria-orientation="vertical"
            aria-labelledby="nav-menu-button-1"
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
    );
  }

  const content = (
    <div
      className="semiont-unified-header__content"
      data-variant={variant}
    >
      {showBranding ? (
        <div className="semiont-unified-header__branding-wrapper" ref={dropdownRef}>
          <button
            onClick={toggle}
            className="semiont-unified-header__branding-button"
            aria-label="Navigation menu"
            aria-expanded={isOpen}
            aria-controls="nav-menu-dropdown-2"
            aria-haspopup="true"
            id="nav-menu-button-2"
          >
            <SemiontBranding
              t={tHome}
              size="sm"
              showTagline={true}
              animated={false}
              compactTagline={true}
              className="semiont-unified-header__branding"
            />
          </button>

          {/* Dropdown Menu */}
          {isOpen && isAuthenticated && (
            <div
              id="nav-menu-dropdown-2"
              className="semiont-unified-header__dropdown"
              role="menu"
              aria-orientation="vertical"
              aria-labelledby="nav-menu-button-2"
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
      ) : (
        <div></div>
      )}

      <div className="semiont-unified-header__actions" data-variant={variant}>
        {/* UserMenu removed - navigation moved to logo dropdown */}
      </div>
    </div>
  );

  if (variant === 'standalone') {
    return (
      <header
        className="semiont-unified-header semiont-unified-header--standalone"
        data-variant="standalone"
      >
        <div className="semiont-unified-header__container">
          {content}
        </div>
      </header>
    );
  }

  return content;
}
