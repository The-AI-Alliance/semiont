/**
 * AuthErrorDisplay - Pure React component for displaying authentication errors
 *
 * No Next.js dependencies - receives error type and translations via props.
 */

import React from 'react';
import Link from 'next/link';

export interface AuthErrorDisplayProps {
  /**
   * Error type from URL parameter
   */
  errorType: string | null;

  /**
   * Translation strings
   */
  translations: {
    pageTitle: string;
    tryAgain: string;
    errorConfiguration: string;
    errorAccessDenied: string;
    errorVerification: string;
    errorGeneric: string;
  };
}

/**
 * Get error message based on error type
 */
function getErrorMessage(errorType: string | null, t: AuthErrorDisplayProps['translations']): string {
  switch (errorType) {
    case 'Configuration':
      return t.errorConfiguration;
    case 'AccessDenied':
      return t.errorAccessDenied;
    case 'Verification':
      return t.errorVerification;
    default:
      return t.errorGeneric;
  }
}

/**
 * AuthErrorDisplay component
 *
 * Displays authentication error messages with a link to try again.
 */
export function AuthErrorDisplay({ errorType, translations: t }: AuthErrorDisplayProps) {
  const errorMessage = getErrorMessage(errorType, t);

  return (
    <div className="flex items-center justify-center py-20">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900 dark:text-white">
            {t.pageTitle}
          </h2>
        </div>

        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4">
          <div className="text-sm text-red-700 dark:text-red-400">{errorMessage}</div>
        </div>

        <div className="text-center">
          <Link
            href="/auth/signin"
            className="text-blue-600 hover:text-blue-500 dark:text-blue-400 dark:hover:text-blue-300"
          >
            {t.tryAgain}
          </Link>
        </div>
      </div>
    </div>
  );
}
