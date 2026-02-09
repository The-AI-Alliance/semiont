'use client';

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
  let lastSyncText: string;
  if (!lastEventTimestamp) {
    lastSyncText = t('noActivity');
  } else {
    const now = new Date();
    const eventTime = new Date(lastEventTimestamp);
    const diffMs = now.getTime() - eventTime.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);

    if (diffSecs < 10) {
      lastSyncText = t('justNow');
    } else if (diffSecs < 60) {
      lastSyncText = t('secondsAgo', { count: diffSecs });
    } else if (diffMins === 1) {
      lastSyncText = t('minuteAgo');
    } else if (diffMins < 60) {
      lastSyncText = t('minutesAgo', { count: diffMins });
    } else if (diffHours === 1) {
      lastSyncText = t('hourAgo');
    } else if (diffHours < 24) {
      lastSyncText = t('hoursAgo', { count: diffHours });
    } else {
      lastSyncText = eventTime.toLocaleDateString();
    }
  }

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
