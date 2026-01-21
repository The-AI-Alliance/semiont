/**
 * AuthErrorDisplay - Pure React component for displaying authentication errors
 *
 * No Next.js dependencies - receives error type and translations via props.
 */

import React from 'react';


export interface AuthErrorDisplayProps {
  /**
   * Link component for routing - passed from parent
   */
  Link: React.ComponentType<any>;

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
export function AuthErrorDisplay({ errorType, Link, translations: t }: AuthErrorDisplayProps) {
  const errorMessage = getErrorMessage(errorType, t);

  return (
    <div className="semiont-auth-error-display">
      <div className="semiont-auth-error-display__container">
        <div>
          <h2 className="semiont-auth-error-display__title">
            {t.pageTitle}
          </h2>
        </div>

        <div className="semiont-auth-error-display__error-box">
          <div className="semiont-auth-error-display__error-message">{errorMessage}</div>
        </div>

        <div className="semiont-auth-error-display__actions">
          <Link
            href="/auth/signin"
            className="semiont-auth-error-display__link"
          >
            {t.tryAgain}
          </Link>
        </div>
      </div>
    </div>
  );
}
