/**
 * ImportProgress — Shows SSE-driven progress during restore
 *
 * Pure React component. All state passed as props.
 */

export interface ImportProgressTranslations {
  phaseStarted: string;
  phaseEntityTypes: string;
  phaseResources: string;
  phaseAnnotations: string;
  phaseComplete: string;
  phaseError: string;
  hashChainValid: string;
  hashChainInvalid: string;
  streams: string;
  events: string;
  blobs: string;
}

export interface ImportProgressProps {
  phase: string;
  message?: string;
  result?: Record<string, unknown>;
  translations: ImportProgressTranslations;
}

const PHASE_LABELS: Record<string, keyof ImportProgressTranslations> = {
  started: 'phaseStarted',
  'entity-types': 'phaseEntityTypes',
  resources: 'phaseResources',
  annotations: 'phaseAnnotations',
  complete: 'phaseComplete',
  error: 'phaseError',
};

export function ImportProgress({ phase, message, result, translations: t }: ImportProgressProps) {
  const labelKey = PHASE_LABELS[phase];
  const phaseLabel = labelKey ? t[labelKey] : phase;

  const isComplete = phase === 'complete';
  const isError = phase === 'error';

  return (
    <div className="semiont-exchange__progress">
      <div className={`semiont-exchange__phase-label${isError ? ' semiont-exchange__phase-label--error' : isComplete ? ' semiont-exchange__phase-label--complete' : ''}`}>
        {phaseLabel}
      </div>

      {message && !isComplete && !isError && (
        <p className="semiont-exchange__progress-message">{message}</p>
      )}

      {isComplete && result && (
        <div className="semiont-exchange__result">
          {result.stats != null && typeof result.stats === 'object' && (
            <>
              {Object.entries(result.stats as Record<string, number>).map(([key, value]) => {
                const label = key === 'streams' ? t.streams
                  : key === 'events' ? t.events
                  : key === 'blobs' ? t.blobs
                  : key;
                return (
                  <div key={key} className="semiont-exchange__result-stat">
                    <span className="semiont-exchange__result-value">{value}</span>
                    <span className="semiont-exchange__result-label">{label}</span>
                  </div>
                );
              })}
            </>
          )}

          {result.hashChainValid !== undefined && (
            <div className={`semiont-exchange__hash-badge${result.hashChainValid ? ' semiont-exchange__hash-badge--valid' : ' semiont-exchange__hash-badge--invalid'}`}>
              {result.hashChainValid ? t.hashChainValid : t.hashChainInvalid}
            </div>
          )}
        </div>
      )}

      {isError && message && (
        <p className="semiont-exchange__error-message">{message}</p>
      )}
    </div>
  );
}
