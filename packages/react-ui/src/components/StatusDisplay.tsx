'use client';

import { useHealth } from '../lib/api-hooks';
import './StatusDisplay.css';

interface StatusDisplayProps {
  isFullyAuthenticated?: boolean;
  isAuthenticated?: boolean;
  hasValidBackendToken?: boolean;
}

export function StatusDisplay({
  isFullyAuthenticated = false,
  isAuthenticated = false,
  hasValidBackendToken = false
}: StatusDisplayProps) {
  const health = useHealth();
  const status = health.status.useQuery(30000); // Poll every 30 seconds

  const getStatusContent = () => {
    // Check for users who are logged in but missing backend token (old sessions)
    if (isAuthenticated && !hasValidBackendToken) {
      return '🚀 Frontend Status: Ready • Backend: Please sign out and sign in again to reconnect';
    }

    // If user is not authenticated at all, show appropriate message
    if (!isFullyAuthenticated) {
      return '🚀 Frontend Status: Ready • Backend: Authentication required';
    }

    if (status.data) {
      return `🚀 Frontend Status: Ready • Backend: ${status.data.status} (v${status.data.version})`;
    }

    if (status.isLoading) {
      return '🚀 Frontend Status: Ready • Backend: Connecting...';
    }

    if (status.error) {
      // Check if this is an auth error that might be fixed by re-login
      const errorMessage = status.error instanceof Error ? status.error.message : String(status.error);
      if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
        return '🚀 Frontend Status: Ready • Backend: Please sign out and sign in again';
      }
      return '🚀 Frontend Status: Ready • Backend: Connection failed';
    }

    return '🚀 Frontend Status: Ready • Backend: Unknown';
  };

  const getStatusType = (): 'warning' | 'info' | 'success' | 'loading' | 'error' => {
    // Check for users who need to re-authenticate
    if (isAuthenticated && !hasValidBackendToken) {
      return 'warning';
    }

    if (!isFullyAuthenticated) {
      return 'info';
    }

    if (status.data) {
      return 'success';
    }

    if (status.isLoading) {
      return 'loading';
    }

    return 'error';
  };

  return (
    <section
      className="semiont-status-display"
      data-status={getStatusType()}
      role="status"
      aria-live="polite"
      aria-label="System status information"
    >
      <p className="semiont-status-message">
        <span className="sr-only">System status: </span>
        {getStatusContent()}
      </p>
      {!isFullyAuthenticated ? (
        <p className="semiont-status-hint">
          Sign in to view backend status
        </p>
      ) : status.error ? (
        <p className="semiont-status-hint semiont-status-error-hint" role="alert">
          <span className="sr-only">Error: </span>
          Check that the backend server is running and accessible
        </p>
      ) : null}
    </section>
  );
}