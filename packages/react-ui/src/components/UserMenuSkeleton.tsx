'use client';

import React from 'react';

export function UserMenuSkeleton() {
  return (
    <div
      className="semiont-user-menu-skeleton"
      aria-label="Loading user menu"
      role="status"
    >
      <span className="semiont-sr-only">Loading user menu...</span>
    </div>
  );
}