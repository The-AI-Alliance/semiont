/**
 * SignUpForm - Pure React component for Google OAuth sign-up
 *
 * This component is extracted from the page to enable easy testing.
 * It has no Next.js dependencies and receives all data via props.
 */

import React, { useState } from 'react';
import { buttonStyles, SemiontBranding } from '@semiont/react-ui';


export interface SignUpFormProps {
  /**
   * Link component for routing - passed from parent
   */
  Link: React.ComponentType<any>;

  /**
   * Callback when user clicks the Google sign-up button
   */
  onSignUp: () => Promise<void>;

  /**
   * Translation strings for the form
   */
  translations: {
    pageTitle: string;
    signUpPrompt: string;
    signUpWithGoogle: string;
    creatingAccount: string;
    approvedDomainsInfo: string;
    termsAgreement: string;
    alreadyHaveAccount: string;
    tagline: string;
    backToHome: string;
  };
}

/**
 * Google icon SVG component
 */
function GoogleIcon() {
  return (
    <svg className="semiont-icon semiont-icon--small semiont-icon--inline" viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="currentColor"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="currentColor"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="currentColor"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

/**
 * SignUpForm component
 *
 * Renders the sign-up form with Google OAuth button.
 * Manages loading state internally.
 */
export function SignUpForm({ onSignUp, Link, translations: t }: SignUpFormProps) {
  const [isLoading, setIsLoading] = useState(false);

  const handleSignUp = async () => {
    setIsLoading(true);
    try {
      await onSignUp();
    } catch (error) {
      console.error('Failed to initiate Google sign-up:', error);
      setIsLoading(false);
    }
  };

  return (
    <main className="semiont-auth__main" role="main">
      <div className="semiont-auth__container">
        <div className="semiont-auth__content">
          {/* Hero Branding Section */}
          <section aria-labelledby="signup-heading" className="semiont-auth__branding">
            <h1 id="signup-heading" className="sr-only">
              {t.pageTitle}
            </h1>
            <SemiontBranding t={(key: string) => t[key as keyof typeof t] || key} size="xl" animated={true} className="semiont-auth__logo" />
            <p className="semiont-auth__welcome">
              {t.pageTitle}
            </p>
            <p className="semiont-auth__subtitle">
              {t.signUpPrompt}
            </p>
          </section>

          {/* Sign Up Form */}
          <div className="semiont-auth__forms">
            <button
              onClick={handleSignUp}
              disabled={isLoading}
              className={`${buttonStyles.primary.base} semiont-button--full-width`}
            >
              {isLoading ? (
                <div className="semiont-auth__spinner"></div>
              ) : (
                <GoogleIcon />
              )}
              {isLoading ? t.creatingAccount : t.signUpWithGoogle}
            </button>

            <div className="semiont-auth__info">
              {t.approvedDomainsInfo}
              <br />
              {t.termsAgreement}
            </div>
          </div>

          {/* Navigation Links */}
          <div className="semiont-auth__links">
            <Link href="/" className={buttonStyles.secondary.base}>
              {t.backToHome}
            </Link>
            <Link href="/auth/signin" className={buttonStyles.primary.base}>
              {t.alreadyHaveAccount}
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
