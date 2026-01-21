'use client';

import React, { useState, useRef, useEffect } from 'react';

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
}

/**
 * Simple navigation component for Admin and Moderation modes.
 * Renders a section header with optional dropdown and static navigation tabs.
 */
export function SimpleNavigation({
  title,
  items,
  currentPath,
  LinkComponent,
  dropdownContent
}: SimpleNavigationProps) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
  }, [isDropdownOpen]);

  return (
    <div className="semiont-simple-nav">
      {/* Section header with optional dropdown */}
      <div style={{ position: 'relative' }} ref={dropdownContent ? dropdownRef : undefined}>
        <button
          onClick={dropdownContent ? toggleDropdown : undefined}
          className="semiont-nav-section__header"
          disabled={!dropdownContent}
          aria-expanded={dropdownContent ? isDropdownOpen : undefined}
          aria-haspopup={dropdownContent ? 'true' : undefined}
          type="button"
        >
          {title}
        </button>

        {isDropdownOpen && dropdownContent && (
          <div className="semiont-nav-section__dropdown">
            {dropdownContent(closeDropdown)}
          </div>
        )}
      </div>

      {/* Static navigation tabs */}
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
    </div>
  );
}
