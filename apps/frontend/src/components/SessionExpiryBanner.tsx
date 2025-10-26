'use client';

import React, { useState } from 'react';
import { useSessionExpiry } from '@/hooks/useSessionExpiry';
import { useFormattedTime } from '@/hooks/useFormattedTime';

export function SessionExpiryBanner() {
  const { timeRemaining, isExpiringSoon } = useSessionExpiry();
  const [dismissed, setDismissed] = useState(false);
  const formattedTime = useFormattedTime(timeRemaining);

  // Don't show if:
  // - Session is not expiring soon
  // - User dismissed the banner
  // - No time to display
  if (!isExpiringSoon || dismissed || !formattedTime) {
    return null;
  }

  return (
    <div
      className="fixed top-16 left-0 right-0 bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 p-2 z-50 animate-in slide-in-from-top duration-300"
      role="alert"
      aria-live="polite"
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between px-4">
        <div className="flex items-center gap-2">
          <span className="text-yellow-600 dark:text-yellow-400">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </span>
          <p className="text-sm text-yellow-800 dark:text-yellow-200">
            <span className="font-medium">Session expiring soon:</span> {formattedTime} remaining
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-yellow-600 hover:text-yellow-800 dark:text-yellow-400 dark:hover:text-yellow-200 p-1 rounded hover:bg-yellow-100 dark:hover:bg-yellow-900/30 transition-colors"
          aria-label="Dismiss warning"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}