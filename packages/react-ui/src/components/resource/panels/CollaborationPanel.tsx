'use client';

import type { CollaboratorEntry, ConnectionState } from '@semiont/core';
import { useTranslations } from '../../../contexts/TranslationContext';
import './CollaborationPanel.css';

/**
 * Token counts read as ceilings, not quantities — "200K" carries the meaning a
 * bare 200000 makes the reader compute. Kept lossless above the K/M break so a
 * 128000 window never displays as a rounded-away 130K.
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return String(n);
}

interface Props {
  /**
   * Connection state from `client.actor.state$`. See
   * `packages/http-transport/src/state/domain/actor-state-unit.ts`.
   *
   * UI mapping:
   *   `open` | `reconnecting` | `initial` | `connecting`
   *     → treated as "healthy" (green dot, "Live" label, event count visible).
   *     `reconnecting` is specifically INCLUDED in healthy because a
   *     brief reconnect (mount churn, channel-set change, quick blip)
   *     shouldn't alarm the user. The 100 ms reconnect debounce and
   *     sub-second fetch retry make `reconnecting` a transient state.
   *   `degraded` | `closed`
   *     → treated as "disconnected" (red dot, "Disconnected" label).
   *     `degraded` is the 3 s threshold at which the state machine
   *     decides the disconnect is sustained; this is the UI-banner
   *     trigger the plan was designed around.
   */
  state: ConnectionState;
  eventCount: number;
  lastEventTimestamp?: string;
  knowledgeBaseName?: string;
  /**
   * The KB's collaborator roster (`client.browse.agents()`, typically via
   * `useCollaborators`). Optional so hosts that never wire it — including
   * external consumers of this package — render exactly as before.
   *
   * Each entry's `limits` is absent whenever discovery could not answer *right
   * now* (INFERENCE-LIMITS-EXPOSURE D3), so a missing ceiling is normal and
   * shows as no ceiling rather than as an error.
   */
  collaborators?: CollaboratorEntry[];
}

export function CollaborationPanel({
  state,
  eventCount,
  lastEventTimestamp,
  knowledgeBaseName,
  collaborators
}: Props) {
  const t = useTranslations('CollaborationPanel');

  // Only Software agents have a provider/model and can carry inference
  // ceilings; Persons and Organizations are collaborators in a different
  // sense and have nothing to show in this section.
  const softwareAgents = (collaborators ?? []).filter(
    (entry) => entry.agent['@type'] === 'Software',
  );

  // Healthy = live, or briefly flapping. Only genuinely sustained
  // disconnects surface as "Disconnected" in the UI.
  const isHealthy = state === 'open' || state === 'reconnecting' || state === 'initial' || state === 'connecting';

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

      {knowledgeBaseName && (
        <div style={{ padding: '0 0.75rem 0.5rem', fontSize: '0.8rem', color: 'var(--semiont-color-neutral-400)' }}>
          {knowledgeBaseName}
        </div>
      )}

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
              data-connected={isHealthy ? 'true' : 'false'}
            ></span>
            <span
              className="semiont-collaboration-panel__status-text"
              data-connected={isHealthy ? 'true' : 'false'}
            >
              {isHealthy ? t('live') : t('disconnected')}
            </span>
          </span>
          {isHealthy && eventCount > 0 && (
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
            {isHealthy
              ? t('realtimeActive')
              : t('reconnecting')}
          </div>
        </div>
      </div>

      {/* Collaborators roster — software agents and their discovered ceilings */}
      {softwareAgents.length > 0 && (
        <div className="semiont-collaboration-panel__section semiont-collaboration-panel__section--bordered">
          <h3 className="semiont-collaboration-panel__heading">
            {t('collaborators')}
          </h3>
          {softwareAgents.map((entry, i) => {
            // `agent` is narrowed to the Software member by the filter above,
            // but the generated union is structural, so read through a local.
            const agent = entry.agent as Extract<CollaboratorEntry['agent'], { '@type': 'Software' }>;
            const limits = entry.limits;
            // `maxOutputTokens === contextTokens` is the schema's documented
            // sentinel for a provider with ONE shared window (Ollama). Showing
            // "128K in / 128K out" there would invent a distinction the
            // provider does not make.
            const ceiling = !limits
              ? null
              : limits.maxOutputTokens === limits.contextTokens
                ? t('sharedWindow', { contextTokens: formatTokens(limits.contextTokens) })
                : t('ceilings', {
                    contextTokens: formatTokens(limits.contextTokens),
                    maxOutputTokens: formatTokens(limits.maxOutputTokens),
                  });

            return (
              <div
                key={agent['@id'] ?? `${agent.provider}:${agent.model}:${i}`}
                className="semiont-collaboration-panel__collaborator"
                data-testid="semiont-collaborator-row"
              >
                <div className="semiont-collaboration-panel__collaborator-id">
                  {agent.provider && (
                    <span className="semiont-collaboration-panel__collaborator-provider">
                      {agent.provider}
                    </span>
                  )}
                  <span className="semiont-collaboration-panel__collaborator-model">
                    {agent.model ?? agent.name}
                  </span>
                </div>
                {entry.servesJobTypes && entry.servesJobTypes.length > 0 && (
                  <div className="semiont-collaboration-panel__collaborator-jobs">
                    {entry.servesJobTypes.join(', ')}
                  </div>
                )}
                {ceiling && (
                  <div className="semiont-collaboration-panel__collaborator-limits">
                    {ceiling}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

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
