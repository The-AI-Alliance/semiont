'use client';

import { useEffect, useState } from 'react';
import { useSemiont } from '../session/SemiontProvider';
import { useObservable } from '../hooks/useObservable';
import './StatusDisplay.css';

interface StatusDisplayProps {
  isFullyAuthenticated?: boolean;
  isAuthenticated?: boolean;
  hasValidBackendToken?: boolean;
}

interface StatusData {
  status: string;
  version: string;
}

export function StatusDisplay({
  isFullyAuthenticated = false,
  isAuthenticated = false,
  hasValidBackendToken = false
}: StatusDisplayProps) {
  const semiont = useObservable(useSemiont().activeSession$)?.client;
  const [data, setData] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!semiont) { setLoading(false); return; }

    const fetchStatus = () => {
      semiont.getStatus()
        .then((result) => {
          setData(result as StatusData);
          setError(null);
          setLoading(false);
        })
        .catch((err) => {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        });
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [semiont]);

  const getStatusContent = () => {
    if (isAuthenticated && !hasValidBackendToken) {
      return '🚀 Frontend Status: Ready • Backend: Please sign out and sign in again to reconnect';
    }

    if (!isFullyAuthenticated) {
      return '🚀 Frontend Status: Ready • Backend: Authentication required';
    }

    if (data) {
      return `🚀 Frontend Status: Ready • Backend: ${data.status} (v${data.version})`;
    }

    if (loading) {
      return '🚀 Frontend Status: Ready • Backend: Connecting...';
    }

    if (error) {
      const errorMessage = error.message;
      if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
        return '🚀 Frontend Status: Ready • Backend: Please sign out and sign in again';
      }
      return '🚀 Frontend Status: Ready • Backend: Connection failed';
    }

    return '🚀 Frontend Status: Ready • Backend: Unknown';
  };

  const getStatusType = (): 'warning' | 'info' | 'success' | 'loading' | 'error' => {
    if (isAuthenticated && !hasValidBackendToken) {
      return 'warning';
    }

    if (!isFullyAuthenticated) {
      return 'info';
    }

    if (data) {
      return 'success';
    }

    if (loading) {
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
      ) : error ? (
        <p className="semiont-status-hint semiont-status-error-hint" role="alert">
          <span className="sr-only">Error: </span>
          Check that the backend server is running and accessible
        </p>
      ) : null}
    </section>
  );
}
