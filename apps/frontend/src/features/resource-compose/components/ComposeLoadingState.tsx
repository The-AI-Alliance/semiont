/**
 * ComposeLoadingState Component
 *
 * Simple loading state display for the compose page.
 */

import React from 'react';

export interface ComposeLoadingStateProps {
  message: string;
}

export function ComposeLoadingState({ message }: ComposeLoadingStateProps) {
  return (
    <div className="px-4 py-8">
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">{message}</p>
      </div>
    </div>
  );
}
