'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { useAuthenticatedAPI } from '@/hooks/useAuthenticatedAPI';

export function StatusDisplay() {
  const { isFullyAuthenticated, isAuthenticated, hasValidBackendToken } = useAuth();
  const { fetchAPI } = useAuthenticatedAPI();

  const status = useQuery({
    queryKey: ['/api/status'],
    queryFn: () => fetchAPI('/api/status'),
    enabled: isFullyAuthenticated,
    refetchInterval: 30000, // Poll every 30 seconds
  });

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

  const getStatusColor = () => {
    // Check for users who need to re-authenticate
    if (isAuthenticated && !hasValidBackendToken) {
      return 'text-orange-800 dark:text-orange-200';
    }
    
    if (!isFullyAuthenticated) {
      return 'text-gray-800 dark:text-gray-200';
    }
    
    if (status.data) {
      return 'text-blue-800 dark:text-blue-200';
    }
    
    if (status.isLoading) {
      return 'text-yellow-800 dark:text-yellow-200';
    }
    
    return 'text-red-800 dark:text-red-200';
  };

  const getBackgroundColor = () => {
    // Check for users who need to re-authenticate
    if (isAuthenticated && !hasValidBackendToken) {
      return 'bg-orange-50 dark:bg-orange-900/20';
    }
    
    if (!isFullyAuthenticated) {
      return 'bg-gray-50 dark:bg-gray-900/20';
    }
    
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
      {!isFullyAuthenticated ? (
        <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
          Sign in to view backend status
        </p>
      ) : status.error ? (
        <p className="text-xs text-red-600 dark:text-red-400 mt-1" role="alert">
          <span className="sr-only">Error: </span>
          Check that the backend server is running and accessible
        </p>
      ) : null}
    </section>
  );
}