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
    <div className="semiont-loading-state-wrapper">
      <div className="semiont-loading-state semiont-loading-state-compose">
        <p className="semiont-loading-message">{message}</p>
      </div>
    </div>
  );
}
