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
  className = ""
}: NavigationMenuProps) {
  const navClassName = className ? `semiont-navigation-menu ${className}` : "semiont-navigation-menu";

  return (
    <nav className={navClassName} role="menu" aria-label="Main navigation">
      <Link
        href={brandingLink}
        {...(onItemClick && { onClick: onItemClick })}
        className="semiont-navigation-menu__link"
        role="menuitem"
        tabIndex={0}
        aria-label="Go to home page"
      >
        {t('home')}
      </Link>
      <hr className="semiont-navigation-menu__divider" />

      <Link
        href={routes.knowledge?.() || '/know'}
        {...(onItemClick && { onClick: onItemClick })}
        className="semiont-navigation-menu__link"
        role="menuitem"
        tabIndex={0}
        aria-label="Go to knowledge base"
      >
        {t('know')}
      </Link>
      <hr className="semiont-navigation-menu__divider" />

      {(isModerator || isAdmin) && (
        <>
          <Link
            href={routes.moderate?.() || '/moderate'}
            {...(onItemClick && { onClick: onItemClick })}
            className="semiont-navigation-menu__link"
            role="menuitem"
            tabIndex={0}
            aria-label="Access moderation dashboard"
          >
            {t('moderate')}
          </Link>
          <hr className="semiont-navigation-menu__divider" />
        </>
      )}

      {isAdmin && (
        <Link
          href={routes.admin?.() || '/admin'}
          {...(onItemClick && { onClick: onItemClick })}
          className="semiont-navigation-menu__link"
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
