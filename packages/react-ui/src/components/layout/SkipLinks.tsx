'use client';

import './SkipLinks.css';

/**
 * Skip links for keyboard navigation accessibility
 * These links are visually hidden but become visible when focused
 * They allow keyboard users to quickly jump to main content areas
 */
export function SkipLinks() {
  return (
    <div className="semiont-skip-links">
      <div className="semiont-skip-links-container">
        <a
          href="#main-content"
          className="semiont-skip-link semiont-skip-link-first"
        >
          Skip to main content
        </a>
        <a
          href="#main-navigation"
          className="semiont-skip-link"
        >
          Skip to navigation
        </a>
        <a
          href="#search"
          className="semiont-skip-link semiont-skip-link-last"
        >
          Skip to search
        </a>
      </div>
    </div>
  );
}