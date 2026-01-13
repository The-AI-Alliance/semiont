'use client';

import React from 'react';
import type { SidebarNavigationProps } from '../../types/navigation';

/**
 * Framework-agnostic sidebar navigation component.
 * Accepts a Link component for routing and handles active state highlighting.
 */
export function SidebarNavigation({
  items,
  title,
  currentPath,
  LinkComponent,
  className = '',
  showDescriptions = true,
  activeClassName,
  inactiveClassName
}: SidebarNavigationProps) {
  const defaultActiveClass = 'sidebar-navigation__item--active';
  const defaultInactiveClass = 'sidebar-navigation__item--inactive';

  return (
    <div className={`sidebar-navigation ${className}`}>
      <div className="sidebar-navigation__container">
        <div className="sidebar-navigation__section">
          {title && (
            <div className="sidebar-navigation__header">
              <div className="sidebar-navigation__title">{title}</div>
            </div>
          )}

          <div className="sidebar-navigation__items">
            {items.map((item) => {
              const isActive = currentPath === item.href;
              const itemClass = isActive
                ? (activeClassName || defaultActiveClass)
                : (inactiveClassName || defaultInactiveClass);

              return (
                <LinkComponent
                  key={item.name}
                  href={item.href}
                  className={`sidebar-navigation__item ${itemClass}`}
                  title={showDescriptions ? item.description : undefined}
                >
                  <item.icon
                    className={`sidebar-navigation__icon ${
                      isActive
                        ? 'sidebar-navigation__icon--active'
                        : 'sidebar-navigation__icon--inactive'
                    }`}
                    aria-hidden="true"
                  />
                  <span className="sidebar-navigation__text">{item.name}</span>
                </LinkComponent>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}