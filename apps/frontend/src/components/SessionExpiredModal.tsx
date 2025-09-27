'use client';

import React, { useState, useEffect } from 'react';
import { signIn } from 'next-auth/react';
import { useSessionContext } from '@/contexts/SessionContext';
import { AUTH_EVENTS, onAuthEvent } from '@/lib/auth-events';

export function SessionExpiredModal() {
  const { isAuthenticated } = useSessionContext();
  const [wasAuthenticated, setWasAuthenticated] = useState(isAuthenticated);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    // Detect when session expires (transition from authenticated to not authenticated)
    if (wasAuthenticated && !isAuthenticated) {
      setShowModal(true);
    }
    setWasAuthenticated(isAuthenticated);
  }, [isAuthenticated, wasAuthenticated]);

  useEffect(() => {
    // Listen for 401 unauthorized events
    const cleanup = onAuthEvent(AUTH_EVENTS.UNAUTHORIZED, () => {
      // Show modal when 401 error occurs
      setShowModal(true);
    });

    return cleanup;
  }, []);

  if (!showModal) {
    return null;
  }

  const handleSignIn = () => {
    // Sign in and redirect back to current page
    signIn(undefined, { callbackUrl: window.location.pathname });
  };

  const handleClose = () => {
    setShowModal(false);
    // Redirect to home page
    window.location.href = '/';
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[9999] animate-in fade-in duration-200"
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        className="fixed inset-0 flex items-center justify-center z-[10000] p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-expired-title"
        aria-describedby="session-expired-description"
      >
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-md w-full animate-in zoom-in-95 duration-200">
          {/* Header */}
          <div className="p-6 pb-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-shrink-0 w-10 h-10 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center">
                <svg className="w-6 h-6 text-red-600 dark:text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h2
                id="session-expired-title"
                className="text-xl font-semibold text-gray-900 dark:text-white"
              >
                Session Expired
              </h2>
            </div>

            <p
              id="session-expired-description"
              className="text-gray-600 dark:text-gray-300"
            >
              Your session has expired for security reasons. Please sign in again to continue working.
            </p>
          </div>

          {/* Actions */}
          <div className="px-6 pb-6 flex gap-3 justify-end">
            <button
              onClick={handleClose}
              className="px-4 py-2 text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
            >
              Go to Home
            </button>
            <button
              onClick={handleSignIn}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 transition-colors"
            >
              Sign In Again
            </button>
          </div>
        </div>
      </div>
    </>
  );
}