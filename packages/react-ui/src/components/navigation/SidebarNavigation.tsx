'use client';

import React from 'react';
import type { SidebarNavigationProps } from '../../types/navigation';

/**
 * Framework-agnostic sidebar navigation component.
 * Accepts a Link component for routing and handles active state highlighting.
 * Supports collapsed state where only icons are shown.
 */
export function SidebarNavigation({
  items,
  title,
  currentPath,
  LinkComponent,
  className = '',
  showDescriptions = true,
  activeClassName,
  inactiveClassName,
  isCollapsed = false,
  showText = true
}: SidebarNavigationProps) {
  const defaultActiveClass = 'sidebar-navigation__item--active';
  const defaultInactiveClass = 'sidebar-navigation__item--inactive';

  return (
    <div className={`sidebar-navigation ${className} ${isCollapsed ? 'sidebar-navigation--collapsed' : ''}`}>
      <div className="sidebar-navigation__container">
        <div className="sidebar-navigation__section">
          {title && !isCollapsed && (
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
                  title={(isCollapsed || showDescriptions) ? (item.description || item.name) : undefined}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <item.icon
                    className={`sidebar-navigation__icon ${
                      isActive
                        ? 'sidebar-navigation__icon--active'
                        : 'sidebar-navigation__icon--inactive'
                    }`}
                    aria-hidden="true"
                  />
                  {!isCollapsed && showText && (
                    <span className="sidebar-navigation__text">{item.name}</span>
                  )}
                </LinkComponent>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}