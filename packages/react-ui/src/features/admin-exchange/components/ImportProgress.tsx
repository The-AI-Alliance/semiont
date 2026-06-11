/**
 * ImportProgress — Shows SSE-driven progress during restore
 *
 * Pure React component. All state passed as props.
 */

export interface ImportProgressTranslations {
  phaseStarted: string;
  phaseComplete: string;
  phaseError: string;
  statsEventsReplayed: string;
  statsResourcesCreated: string;
  statsAnnotationsCreated: string;
  statsEntityTypesAdded: string;
}

export interface ImportProgressProps {
  phase: string;
  message?: string;
  result?: Record<string, unknown>;
  translations: ImportProgressTranslations;
}

const PHASE_LABELS: Record<string, keyof ImportProgressTranslations> = {
  started: 'phaseStarted',
  complete: 'phaseComplete',
  error: 'phaseError',
};

const STAT_LABELS: Record<string, keyof ImportProgressTranslations> = {
  eventsReplayed: 'statsEventsReplayed',
  resourcesCreated: 'statsResourcesCreated',
  annotationsCreated: 'statsAnnotationsCreated',
  entityTypesAdded: 'statsEntityTypesAdded',
};

export function ImportProgress({ phase, message, result, translations: t }: ImportProgressProps) {
  const labelKey = PHASE_LABELS[phase];
  const phaseLabel = labelKey ? t[labelKey] : phase;

  const isComplete = phase === 'complete';
  const isError = phase === 'error';

  const stats = result?.stats != null && typeof result.stats === 'object'
    ? (result.stats as Record<string, unknown>)
    : undefined;
  const statEntries = stats
    ? Object.entries(stats).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    : [];

  return (
    <div className="semiont-exchange__progress">
      <div className={`semiont-exchange__phase-label${isError ? ' semiont-exchange__phase-label--error' : isComplete ? ' semiont-exchange__phase-label--complete' : ''}`}>
        {phaseLabel}
      </div>

      {message && !isComplete && !isError && (
        <p className="semiont-exchange__progress-message">{message}</p>
      )}

      {isComplete && statEntries.length > 0 && (
        <div className="semiont-exchange__result">
          {statEntries.map(([key, value]) => {
            const statKey = STAT_LABELS[key];
            return (
              <div key={key} className="semiont-exchange__result-stat">
                <span className="semiont-exchange__result-value">{value}</span>
                <span className="semiont-exchange__result-label">{statKey ? t[statKey] : key}</span>
              </div>
            );
          })}
        </div>
      )}

      {isError && message && (
        <p className="semiont-exchange__error-message">{message}</p>
      )}
    </div>
  );
}
