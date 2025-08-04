'use client';

import React from 'react';
import { useBackendStatus } from '@/hooks/useAPI';

export function StatusDisplay() {
  const status = useBackendStatus({
    pollingInterval: 30000, // Poll every 30 seconds
    enabled: true,
  });

  const getStatusContent = () => {
    if (status.data) {
      return `🚀 Frontend Status: Ready • Backend: ${status.data.status} (v${status.data.version})`;
    }
    
    if (status.isLoading) {
      return '🚀 Frontend Status: Ready • Backend: Connecting...';
    }
    
    if (status.error) {
      return '🚀 Frontend Status: Ready • Backend: Connection failed';
    }
    
    return '🚀 Frontend Status: Ready • Backend: Unknown';
  };

  const getStatusColor = () => {
    if (status.data) {
      return 'text-blue-800 dark:text-blue-200';
    }
    
    if (status.isLoading) {
      return 'text-yellow-800 dark:text-yellow-200';
    }
    
    return 'text-red-800 dark:text-red-200';
  };

  const getBackgroundColor = () => {
    if (status.data) {
      return 'bg-blue-50 dark:bg-blue-900/20';
    }
    
    if (status.isLoading) {
      return 'bg-yellow-50 dark:bg-yellow-900/20';
    }
    
    return 'bg-red-50 dark:bg-red-900/20';
  };

  return (
    <section 
      className={`mt-8 p-4 rounded-lg ${getBackgroundColor()}`}
      role="status"
      aria-live="polite"
      aria-label="System status information"
    >
      <p className={getStatusColor()}>
        <span className="sr-only">System status: </span>
        {getStatusContent()}
      </p>
      {status.error ? (
        <p className="text-xs text-red-600 dark:text-red-400 mt-1" role="alert">
          <span className="sr-only">Error: </span>
          Check that the backend server is running and accessible
        </p>
      ) : null}
    </section>
  );
}