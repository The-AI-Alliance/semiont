'use client';

import { useMemo } from 'react';
import { useTranslations } from '../../../contexts/TranslationContext';
import './CollaborationPanel.css';

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
    <div className="semiont-collaboration-panel">
      {/* Panel Title */}
      <h3 className="semiont-collaboration-panel__title">
        {t('title')}
      </h3>

      {/* Connection Status Section */}
      <div className="semiont-collaboration-panel__section">
        <h3 className="semiont-collaboration-panel__heading">
          {t('connectionStatus')}
        </h3>

        {/* Live indicator */}
        <div className="semiont-collaboration-panel__status">
          <span className="semiont-collaboration-panel__indicator">
            <span
              className="semiont-collaboration-panel__dot"
              data-connected={isConnected ? 'true' : 'false'}
            ></span>
            <span
              className="semiont-collaboration-panel__status-text"
              data-connected={isConnected ? 'true' : 'false'}
            >
              {isConnected ? t('live') : t('disconnected')}
            </span>
          </span>
          {isConnected && eventCount > 0 && (
            <span className="semiont-collaboration-panel__event-count">
              ({t('events', { count: eventCount })})
            </span>
          )}
        </div>

        {/* Last sync */}
        <div className="semiont-collaboration-panel__details">
          <div>
            <span className="semiont-collaboration-panel__label">{t('lastSync')}</span> {lastSyncText}
          </div>
          <div>
            {isConnected
              ? t('realtimeActive')
              : t('reconnecting')}
          </div>
        </div>
      </div>

      {/* Sharing Section - Placeholder for future */}
      <div className="semiont-collaboration-panel__section semiont-collaboration-panel__section--bordered">
        <h3 className="semiont-collaboration-panel__heading">
          {t('sharing')}
        </h3>
        <p className="semiont-collaboration-panel__description">
          {t('collaborationComingSoon')}
        </p>
      </div>
    </div>
  );
}
