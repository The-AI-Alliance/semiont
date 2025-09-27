'use client';

import React from 'react';
import { useSessionContext } from '@/contexts/SessionContext';
import { useSessionExpiry } from '@/hooks/useSessionExpiry';
import { useFormattedTime } from '@/hooks/useFormattedTime';

/**
 * Debug component to display session information
 * Only shows in development mode
 */
export function SessionDebugger() {
  const { isAuthenticated, expiresAt, isExpiringSoon: contextExpiringSoon } = useSessionContext();
  const { timeRemaining, isExpiringSoon: hookExpiringSoon } = useSessionExpiry();
  const formattedTime = useFormattedTime(timeRemaining);

  // Only show in development
  if (process.env.NODE_ENV !== 'development') {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 bg-gray-900 text-white p-4 rounded-lg shadow-lg text-xs font-mono z-50 max-w-sm">
      <div className="font-bold mb-2 text-yellow-400">Session Debug Info</div>
      <div className="space-y-1">
        <div>Authenticated: {isAuthenticated ? '✅' : '❌'}</div>
        <div>Expires: {expiresAt ? expiresAt.toLocaleTimeString() : 'N/A'}</div>
        <div>Time Remaining: {formattedTime || 'N/A'}</div>
        <div>Expiring Soon (Context): {contextExpiringSoon ? '⚠️ Yes' : 'No'}</div>
        <div>Expiring Soon (Hook): {hookExpiringSoon ? '⚠️ Yes' : 'No'}</div>
        <div className="pt-2 text-[10px] text-gray-400">
          Banner shows when &lt; 5 min remaining
        </div>
      </div>
    </div>
  );
}