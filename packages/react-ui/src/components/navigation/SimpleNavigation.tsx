'use client';

import React, { useState, useRef, useEffect } from 'react';
import { useEventBus } from '../../contexts/EventBusContext';

export interface SimpleNavigationItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  description?: string;
}

export interface SimpleNavigationProps {
  title: string;
  items: SimpleNavigationItem[];
  currentPath: string;
  LinkComponent: React.ComponentType<any>;
  dropdownContent?: (onClose: () => void) => React.ReactNode;
  isCollapsed: boolean;
  icons: {
    chevronLeft: React.ComponentType<{ className?: string }>;
    bars: React.ComponentType<{ className?: string }>;
  };
  collapseSidebarLabel: string;
  expandSidebarLabel: string;
}

/**
 * Simple navigation component for Admin and Moderation modes.
 * Renders a section header with optional dropdown and static navigation tabs.
 *
 * @emits navigation:sidebar-toggle - Toggle sidebar collapsed/expanded state. Payload: undefined
 */
export function SimpleNavigation({
  title,
  items,
  currentPath,
  LinkComponent,
  dropdownContent,
  isCollapsed,
  icons,
  collapseSidebarLabel,
  expandSidebarLabel
}: SimpleNavigationProps) {
  const ChevronLeftIcon = icons.chevronLeft;
  const BarsIcon = icons.bars;

  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const eventBus = useEventBus();

  const toggleDropdown = () => setIsDropdownOpen(!isDropdownOpen);
  const closeDropdown = () => setIsDropdownOpen(false);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        closeDropdown();
      }
    };

    if (isDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
    return undefined;
  }, [isDropdownOpen]);

  return (
    <div className="semiont-simple-nav">
      {/* Section header with collapse/expand button and optional dropdown */}
      <div style={{ position: 'relative' }} ref={dropdownContent ? dropdownRef : undefined}>
        <div className="semiont-nav-section__header">
          {dropdownContent ? (
            <button
              onClick={toggleDropdown}
              className="semiont-nav-section__header-button"
              aria-expanded={isDropdownOpen}
              aria-haspopup="true"
              type="button"
            >
              {!isCollapsed && <span className="semiont-nav-section__header-text">{title}</span>}
            </button>
          ) : (
            !isCollapsed && <span className="semiont-nav-section__header-text">{title}</span>
          )}
          <button
            onClick={() => eventBus.emit('navigation:sidebar-toggle', undefined)}
            className="semiont-nav-section__header-icon"
            title={isCollapsed ? expandSidebarLabel : collapseSidebarLabel}
            aria-label={isCollapsed ? expandSidebarLabel : collapseSidebarLabel}
            type="button"
          >
            {!isCollapsed ? <ChevronLeftIcon /> : <BarsIcon />}
          </button>
        </div>

        {isDropdownOpen && dropdownContent && !isCollapsed && (
          <div className="semiont-nav-section__dropdown">
            {dropdownContent(closeDropdown)}
          </div>
        )}
      </div>

      {/* Static navigation tabs */}
      {!isCollapsed && (
        <nav className="semiont-nav-tabs">
          {items.map((item) => {
            const isActive = currentPath === item.href;
            return (
              <LinkComponent
                key={item.href}
                href={item.href}
                className={`semiont-nav-tab ${isActive ? 'semiont-nav-tab--active' : ''}`}
                title={item.description || item.name}
                aria-current={isActive ? 'page' : undefined}
              >
                <item.icon className="semiont-nav-tab__icon" aria-hidden="true" />
                <span className="semiont-nav-tab__text">{item.name}</span>
              </LinkComponent>
            );
          })}
        </nav>
      )}

      {/* Collapsed state - show icon-only tabs */}
      {isCollapsed && (
        <nav className="semiont-nav-tabs">
          {items.map((item) => {
            const isActive = currentPath === item.href;
            return (
              <LinkComponent
                key={item.href}
                href={item.href}
                className={`semiont-nav-tab ${isActive ? 'semiont-nav-tab--active' : ''}`}
                title={item.description || item.name}
                aria-current={isActive ? 'page' : undefined}
                aria-label={item.name}
              >
                <item.icon className="semiont-nav-tab__icon" aria-hidden="true" />
              </LinkComponent>
            );
          })}
        </nav>
      )}
    </div>
  );
}
