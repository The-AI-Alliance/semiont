'use client';

import React from 'react';

export function UserMenuSkeleton() {
  return (
    <div
      className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 animate-pulse"
      aria-label="Loading user menu"
      role="status"
    >
      <span className="sr-only">Loading user menu...</span>
    </div>
  );
}