'use client';

import React, { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error to an error reporting service
    console.error('Global error handler:', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 p-4">
      <div className="max-w-lg w-full space-y-6 text-center">
        <div>
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
            500
          </h1>
          <h2 className="text-2xl font-semibold text-gray-700 dark:text-gray-300">
            Internal Server Error
          </h2>
        </div>

        <p className="text-gray-600 dark:text-gray-400">
          Something went wrong on our end. We've been notified and are working to fix it.
        </p>

        {process.env.NODE_ENV === 'development' && error.message && (
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4 text-left">
            <p className="text-sm font-semibold text-red-800 dark:text-red-300 mb-1">
              Error Message:
            </p>
            <p className="text-sm text-red-700 dark:text-red-400 font-mono">
              {error.message}
            </p>
            {error.digest && (
              <p className="text-xs text-red-600 dark:text-red-500 mt-2">
                Error ID: {error.digest}
              </p>
            )}
          </div>
        )}

        <div className="flex gap-4 justify-center">
          <button
            onClick={reset}
            className="px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors"
          >
            Try Again
          </button>
          <a
            href="/"
            className="px-6 py-3 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-300 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 transition-colors inline-block"
          >
            Go Home
          </a>
        </div>
      </div>
    </div>
  );
}