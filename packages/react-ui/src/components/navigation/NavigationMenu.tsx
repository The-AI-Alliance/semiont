'use client';

import React from 'react';
import type { RouteBuilder, LinkComponentProps } from '../../contexts/RoutingContext';
import './NavigationMenu.css';

type TranslateFn = (key: string, params?: Record<string, any>) => string;

interface NavigationMenuProps {
  Link: React.ComponentType<LinkComponentProps>;
  routes: Partial<RouteBuilder>;
  t: TranslateFn;
  brandingLink?: string;
  onItemClick?: () => void;
  className?: string;
  currentPath?: string;
}

export function NavigationMenu({
  Link,
  routes,
  t,
  onItemClick,
  className = "",
  currentPath
}: NavigationMenuProps) {
  const navClassName = className ? `semiont-navigation-menu ${className}` : "semiont-navigation-menu";

  // Helper to check if a path is current
  const isCurrentPage = (path: string) => {
    if (!currentPath) return false;
    // Exact match or starts with path followed by /
    return currentPath === path || currentPath.startsWith(path + '/');
  };

  return (
    <nav className={navClassName} aria-label="Main navigation">
      <Link
        href={routes.knowledge?.() || '/know'}
        {...(onItemClick && { onClick: onItemClick })}
        className="semiont-navigation-menu__link"
        aria-current={isCurrentPage(routes.knowledge?.() || '/know') ? 'page' : undefined}
      >
        {t('know')}
      </Link>

      <hr className="semiont-navigation-menu__divider" />
      <Link
        href={routes.moderate?.() || '/moderate'}
        {...(onItemClick && { onClick: onItemClick })}
        className="semiont-navigation-menu__link"
        aria-current={isCurrentPage(routes.moderate?.() || '/moderate') ? 'page' : undefined}
      >
        {t('moderate')}
      </Link>
    </nav>
  );
}
