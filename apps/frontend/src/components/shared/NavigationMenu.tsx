'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import { useAuth } from '@semiont/react-ui';

interface NavigationMenuProps {
  brandingLink?: string;
  onItemClick?: () => void;
  className?: string;
}

export function NavigationMenu({
  brandingLink = '/',
  onItemClick,
  className = "p-3"
}: NavigationMenuProps) {
  const t = useTranslations('Navigation');
  const { isAdmin, isModerator } = useAuth();

  const linkClassName = "w-full text-left text-sm text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 py-1 transition-colors focus:outline-none focus:bg-gray-50 dark:focus:bg-gray-700 rounded block";
  const dividerClassName = "my-2 border-gray-200 dark:border-gray-600";

  return (
    <div className={className}>
      <Link
        href={brandingLink}
        onClick={onItemClick}
        className={linkClassName}
        role="menuitem"
        tabIndex={0}
        aria-label="Go to home page"
      >
        {t('home')}
      </Link>
      <hr className={dividerClassName} />

      <Link
        href="/know"
        onClick={onItemClick}
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
            href="/moderate"
            onClick={onItemClick}
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
          href="/admin"
          onClick={onItemClick}
          className={linkClassName}
          role="menuitem"
          tabIndex={0}
          aria-label="Access admin dashboard"
        >
          {t('administer')}
        </Link>
      )}
    </div>
  );
}
