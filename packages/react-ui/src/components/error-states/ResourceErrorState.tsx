/**
 * ResourceErrorState - Error state component for resource viewer
 *
 * Pure React component - no Next.js dependencies.
 */

import { buttonStyles } from '../../lib/button-styles';

export interface ResourceErrorStateProps {
  error: unknown;
  onRetry: () => void;
}

export function ResourceErrorState({ error, onRetry }: ResourceErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 space-y-4">
      <p className="text-red-600 dark:text-red-400">
        {error instanceof Error ? error.message : 'Failed to load resource'}
      </p>
      <button
        onClick={onRetry}
        className={buttonStyles.secondary.base}
      >
        Try Again
      </button>
    </div>
  );
}
