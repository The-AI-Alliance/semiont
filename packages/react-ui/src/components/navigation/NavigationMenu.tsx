'use client';

import React from 'react';
import type { RouteBuilder, LinkComponentProps } from '../../contexts/RoutingContext';

type TranslateFn = (key: string, params?: Record<string, any>) => string;

interface NavigationMenuProps {
  Link: React.ComponentType<LinkComponentProps>;
  routes: RouteBuilder;
  t: TranslateFn;
  isAdmin?: boolean;
  isModerator?: boolean;
  brandingLink?: string;
  onItemClick?: () => void;
  className?: string;
  currentPath?: string;
}

export function NavigationMenu({
  Link,
  routes,
  t,
  isAdmin = false,
  isModerator = false,
  brandingLink = '/',
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

      {(isModerator || isAdmin) && (
        <>
          <hr className="semiont-navigation-menu__divider" />
          <Link
            href={routes.moderate?.() || '/moderate'}
            {...(onItemClick && { onClick: onItemClick })}
            className="semiont-navigation-menu__link"
            aria-current={isCurrentPage(routes.moderate?.() || '/moderate') ? 'page' : undefined}
          >
            {t('moderate')}
          </Link>
        </>
      )}

      {isAdmin && (
        <>
          <hr className="semiont-navigation-menu__divider" />
          <Link
            href={routes.admin?.() || '/admin'}
            {...(onItemClick && { onClick: onItemClick })}
            className="semiont-navigation-menu__link"
            aria-current={isCurrentPage(routes.admin?.() || '/admin') ? 'page' : undefined}
          >
            {t('administer')}
          </Link>
        </>
      )}
    </nav>
  );
}
