/**
 * SignInForm - Pure React component for authentication
 *
 * Supports both Google OAuth and email/password credentials.
 * No Next.js dependencies - all data via props.
 */

import React from 'react';
import { buttonStyles, SemiontBranding } from '@semiont/react-ui';

export interface SignInFormProps {
  /**
   * Callback when user clicks Google sign-in
   */
  onGoogleSignIn: () => Promise<void>;

  /**
   * Callback when user submits email/password credentials
   */
  onCredentialsSignIn?: ((email: string, password: string) => Promise<void>) | undefined;

  /**
   * Error message to display (if any)
   */
  error?: string | null;

  /**
   * Whether to show email/password auth form
   */
  showCredentialsAuth?: boolean;

  /**
   * Whether the auth providers are still loading
   */
  isLoading?: boolean;

  /**
   * Link component for routing - passed from parent
   */
  Link: React.ComponentType<any>;

  /**
   * Translation strings
   */
  translations: {
    pageTitle: string;
    welcomeBack: string;
    signInPrompt: string;
    continueWithGoogle: string;
    emailLabel: string;
    emailPlaceholder: string;
    passwordLabel: string;
    passwordPlaceholder: string;
    signInWithCredentials: string;
    or: string;
    credentialsAuthEnabled: string;
    approvedDomainsOnly: string;
    backToHome: string;
    learnMore: string;
    signUpInstead: string;
    errorEmailRequired: string;
    errorPasswordRequired: string;
    tagline: string;
  };
}

/**
 * Google Icon component
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
 * CredentialsAuthForm - Email/password form component
 */
function CredentialsAuthForm({
  onSubmit,
  translations: t,
}: {
  onSubmit: (email: string, password: string) => Promise<void>;
  translations: SignInFormProps['translations'];
}) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<{ email?: string; password?: string }>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errors: { email?: string; password?: string } = {};

    if (!email) {
      errors.email = t.errorEmailRequired;
    }
    if (!password) {
      errors.password = t.errorPasswordRequired;
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setValidationError(Object.values(errors)[0]); // Set first error for screen readers
      return;
    }

    setFieldErrors({});
    setValidationError(null);
    await onSubmit(email, password);
  };

  return (
    <>
      {validationError && (
        <div className="semiont-auth__error" role="alert" aria-live="polite">
          <div className="semiont-auth__error-text">{validationError}</div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="semiont-auth__form" noValidate>
        <div className="semiont-form__field">
          <label htmlFor="email" className="semiont-form__label">
            {t.emailLabel}
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (fieldErrors.email) {
                setFieldErrors({ ...fieldErrors, email: undefined });
              }
            }}
            placeholder={t.emailPlaceholder}
            className="semiont-input"
            aria-invalid={!!fieldErrors.email}
            aria-describedby={fieldErrors.email ? 'email-error' : undefined}
            required
          />
          {fieldErrors.email && (
            <span id="email-error" className="semiont-form__error" role="alert">
              {fieldErrors.email}
            </span>
          )}
        </div>
        <div className="semiont-form__field">
          <label htmlFor="password" className="semiont-form__label">
            {t.passwordLabel}
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (fieldErrors.password) {
                setFieldErrors({ ...fieldErrors, password: undefined });
              }
            }}
            placeholder={t.passwordPlaceholder}
            className="semiont-input"
            aria-invalid={!!fieldErrors.password}
            aria-describedby={fieldErrors.password ? 'password-error' : undefined}
            required
          />
          {fieldErrors.password && (
            <span id="password-error" className="semiont-form__error" role="alert">
              {fieldErrors.password}
            </span>
          )}
        </div>
        <button type="submit" className={`${buttonStyles.primary.base} semiont-button--full-width`}>
          {t.signInWithCredentials}
        </button>
      </form>

      <div className="semiont-auth__divider">
        <div className="semiont-auth__divider-line"></div>
        <div className="semiont-auth__divider-text">{t.or}</div>
      </div>
    </>
  );
}

/**
 * SignInForm - Main sign-in component
 */
export function SignInForm({
  onGoogleSignIn,
  onCredentialsSignIn,
  error,
  showCredentialsAuth = false,
  isLoading = false,
  Link,
  translations: t,
}: SignInFormProps) {
  return (
    <main className="semiont-auth__main" role="main">
      <div className="semiont-auth__container">
        <div className="semiont-auth__content">
          {/* Hero Branding Section */}
          <section aria-labelledby="signin-heading" className="semiont-auth__branding">
            <h1 id="signin-heading" className="sr-only">
              {t.pageTitle}
            </h1>
            <SemiontBranding t={(key: string) => t[key as keyof typeof t] || key} size="xl" animated={true} className="semiont-auth__logo" />
            <p className="semiont-auth__welcome">
              {t.welcomeBack}
            </p>
            <p className="semiont-auth__subtitle">
              {t.signInPrompt}
            </p>
          </section>

          {/* Error Message */}
          {error && (
            <div className="semiont-auth__error-container">
              <div className="semiont-auth__error">
                <div className="semiont-auth__error-text">{error}</div>
              </div>
            </div>
          )}

          {/* Sign In Forms */}
          <div className="semiont-auth__forms">
            {!isLoading ? (
              <>
                {showCredentialsAuth && onCredentialsSignIn && <CredentialsAuthForm onSubmit={onCredentialsSignIn} translations={t} />}

                <button onClick={onGoogleSignIn} className={`${buttonStyles.primary.base} semiont-button--full-width`}>
                  <GoogleIcon />
                  {t.continueWithGoogle}
                </button>

                <div className="semiont-auth__info">
                  {showCredentialsAuth ? t.credentialsAuthEnabled : t.approvedDomainsOnly}
                </div>
              </>
            ) : (
              <div className="semiont-auth__loading" aria-busy="true" aria-live="polite">
                {/* Placeholder to maintain consistent height while loading */}
                <div style={{ height: '200px' }}></div>
              </div>
            )}
          </div>

          {/* Navigation Links */}
          <div className="semiont-auth__links">
            <Link href="/" className={buttonStyles.secondary.base}>
              {t.backToHome}
            </Link>
            <Link href="/about" className={buttonStyles.secondary.base}>
              {t.learnMore}
            </Link>
            <Link href="/auth/signup" className={buttonStyles.primary.base}>
              {t.signUpInstead}
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
