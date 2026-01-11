'use client';

import React, { useMemo } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';

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
  const t = useTranslations('CollaborationPanel');

  // Format last sync time
  const lastSyncText = useMemo(() => {
    if (!lastEventTimestamp) return t('noActivity');

    const now = new Date();
    const eventTime = new Date(lastEventTimestamp);
    const diffMs = now.getTime() - eventTime.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);

    if (diffSecs < 10) return t('justNow');
    if (diffSecs < 60) return t('secondsAgo', { count: diffSecs });
    if (diffMins === 1) return t('minuteAgo');
    if (diffMins < 60) return t('minutesAgo', { count: diffMins });
    if (diffHours === 1) return t('hourAgo');
    if (diffHours < 24) return t('hoursAgo', { count: diffHours });

    return eventTime.toLocaleDateString();
  }, [lastEventTimestamp, t]);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-4 space-y-4">
      {/* Connection Status Section */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
          {t('connectionStatus')}
        </h3>

        {/* Live indicator */}
        <div className="flex items-center gap-2 text-sm mb-2">
          <span className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`}></span>
            <span className={isConnected ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
              {isConnected ? t('live') : t('disconnected')}
            </span>
          </span>
          {isConnected && eventCount > 0 && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              ({t('events', { count: eventCount })})
            </span>
          )}
        </div>

        {/* Last sync */}
        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
          <div>
            <span className="font-medium">{t('lastSync')}</span> {lastSyncText}
          </div>
          <div>
            {isConnected
              ? t('realtimeActive')
              : t('reconnecting')}
          </div>
        </div>
      </div>

      {/* Sharing Section - Placeholder for future */}
      <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
          {t('sharing')}
        </h3>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('collaborationComingSoon')}
        </p>
      </div>
    </div>
  );
}
