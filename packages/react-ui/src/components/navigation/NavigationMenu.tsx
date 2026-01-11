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
}

export function NavigationMenu({
  Link,
  routes,
  t,
  isAdmin = false,
  isModerator = false,
  brandingLink = '/',
  onItemClick,
  className = "p-3"
}: NavigationMenuProps) {
  const linkClassName = "w-full text-left text-sm text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 py-1 transition-colors focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-700 rounded block";
  const dividerClassName = "my-2 border-gray-200 dark:border-gray-600";

  return (
    <nav className={className} role="menu" aria-label="Main navigation">
      <Link
        href={brandingLink}
        {...(onItemClick && { onClick: onItemClick })}
        className={linkClassName}
        role="menuitem"
        tabIndex={0}
        aria-label="Go to home page"
      >
        {t('home')}
      </Link>
      <hr className={dividerClassName} />

      <Link
        href={routes.knowledge?.() || '/know'}
        {...(onItemClick && { onClick: onItemClick })}
        className={linkClassName}
        role="menuitem"
        tabIndex={0}
        aria-label="Go to knowledge base"
      >
        {t('know')}
      </Link>
      <hr className={dividerClassName} />

      {(isModerator || isAdmin) && (
        <>
          <Link
            href={routes.moderate?.() || '/moderate'}
            {...(onItemClick && { onClick: onItemClick })}
            className={linkClassName}
            role="menuitem"
            tabIndex={0}
            aria-label="Access moderation dashboard"
          >
            {t('moderate')}
          </Link>
          <hr className={dividerClassName} />
        </>
      )}

      {isAdmin && (
        <Link
          href={routes.admin?.() || '/admin'}
          {...(onItemClick && { onClick: onItemClick })}
          className={linkClassName}
          role="menuitem"
          tabIndex={0}
          aria-label="Access admin dashboard"
        >
          {t('administer')}
        </Link>
      )}
    </nav>
  );
}
