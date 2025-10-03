'use client';

import React, { useMemo } from 'react';

interface Props {
  isConnected: boolean;
  eventCount: number;
  lastEventTimestamp?: string;
}

export function CollaborationPanel({
  isConnected,
  eventCount,
  lastEventTimestamp
}: Props) {
  // Format last sync time
  const lastSyncText = useMemo(() => {
    if (!lastEventTimestamp) return 'No activity yet';

    const now = new Date();
    const eventTime = new Date(lastEventTimestamp);
    const diffMs = now.getTime() - eventTime.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);

    if (diffSecs < 10) return 'Just now';
    if (diffSecs < 60) return `${diffSecs} seconds ago`;
    if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;

    return eventTime.toLocaleDateString();
  }, [lastEventTimestamp]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 space-y-4">
      {/* Connection Status Section */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          Connection Status
        </h3>

        {/* Live indicator */}
        <div className="flex items-center gap-2 text-sm mb-2">
          <span className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></span>
            <span className={isConnected ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
              {isConnected ? 'Live' : 'Disconnected'}
            </span>
          </span>
          {isConnected && eventCount > 0 && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              ({eventCount} events)
            </span>
          )}
        </div>

        {/* Last sync */}
        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
          <div>
            <span className="font-medium">Last sync:</span> {lastSyncText}
          </div>
          <div>
            {isConnected
              ? 'Real-time updates are active'
              : 'Reconnecting to server...'}
          </div>
        </div>
      </div>

      {/* Sharing Section - Placeholder for future */}
      <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
          Sharing
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Collaboration features coming soon
        </p>
      </div>
    </div>
  );
}
