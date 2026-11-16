'use client';

import { useState } from 'react';
import { useSessionExpiry, formatTime } from '@semiont/react-ui';

export function SessionExpiryBanner() {
  const { timeRemaining, isExpiringSoon } = useSessionExpiry();
  const [dismissed, setDismissed] = useState(false);
  const formattedTime = formatTime(timeRemaining);

  // Don't show if:
  // - Session is not expiring soon
  // - User dismissed the banner
  // - No time to display
  if (!isExpiringSoon || dismissed || !formattedTime) {
    return null;
  }

  return (
    <div
      className="semiont-session-expiry-banner"
      role="alert"
      aria-live="polite"
      data-visible="true"
    >
      <div className="semiont-session-expiry-content">
        <div className="semiont-session-expiry-message">
          <span className="semiont-session-expiry-icon">
            <svg className="semiont-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </span>
          <p className="semiont-session-expiry-text">
            <span className="semiont-session-expiry-label">Session expiring soon:</span> {formattedTime} remaining
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="semiont-session-expiry-dismiss"
          aria-label="Dismiss warning"
        >
          <svg className="semiont-icon-small" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}