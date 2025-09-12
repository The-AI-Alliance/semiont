'use client';

import React from 'react';
import { signIn, getSession } from 'next-auth/react';
import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PageLayout } from '@/components/PageLayout';
import { buttonStyles } from '@/lib/button-styles';

function SignInContent() {
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [showLocalAuth, setShowLocalAuth] = useState(false);
  const callbackUrl = searchParams?.get('callbackUrl') || '/know';

  useEffect(() => {
    // Check if local auth is enabled
    if (process.env.NEXT_PUBLIC_ENABLE_LOCAL_AUTH === 'true' || process.env.NODE_ENV === 'development') {
      // Check providers to see if credentials provider is available
      fetch('/api/auth/providers')
        .then(res => res.json())
        .then(providers => {
          if (providers.credentials) {
            setShowLocalAuth(true);
          }
        })
        .catch(() => {});
    }
    
    const errorParam = searchParams?.get('error');
    if (errorParam) {
      switch (errorParam) {
        case 'Signin':
          setError('Authentication failed. Please try again.');
          break;
        case 'OAuthSignin':
          setError('Error connecting to Google. Please try again.');
          break;
        case 'OAuthCallback':
          setError('Your email domain is not allowed for this application.');
          break;
        case 'OAuthCreateAccount':
          setError('Failed to create account. Please contact support.');
          break;
        default:
          setError('An authentication error occurred. Please try again.');
      }
    }
  }, [searchParams]);

  const handleGoogleSignIn = async () => {
    try {
      await signIn('google', { callbackUrl });
    } catch (error) {
      setError('Failed to initiate Google sign-in. Please try again.');
    }
  };

  const handleLocalSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      setError('Please enter your email address');
      return;
    }
    
    try {
      const result = await signIn('credentials', {
        email,
        redirect: false,
        callbackUrl
      });
      
      if (result?.error) {
        setError('Failed to sign in. Please check your email and try again.');
      } else if (result?.ok) {
        window.location.href = callbackUrl;
      }
    } catch (error) {
      setError('Failed to sign in. Please try again.');
    }
  };

  return (
    <PageLayout className="bg-gray-50" showAuthLinks={false}>
      <div className="flex items-center justify-center py-12 font-sans">
        <div className="max-w-md w-full space-y-8">
          <div>
            <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900 dark:text-white">
              Sign in to Semiont
            </h2>
            <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
              Semantic Knowledge Platform
            </p>
          </div>
          
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-4">
              <div className="text-sm text-red-700 dark:text-red-400">
                {error}
              </div>
            </div>
          )}

          <div className="mt-8 space-y-6">
            {showLocalAuth && (
              <>
                  <form onSubmit={handleLocalSignIn} className="space-y-4">
                    <div>
                      <label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        Email Address (Local Development)
                      </label>
                      <input
                        id="email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="admin@example.com"
                        className="appearance-none relative block w-full px-3 py-2 border border-gray-300 dark:border-gray-600 placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 focus:z-10 sm:text-sm bg-white dark:bg-gray-800"
                        required
                      />
                    </div>
                    <button
                      type="submit"
                      className={buttonStyles.primary.large}
                    >
                      Sign in with Local Development
                    </button>
                  </form>
                  
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-gray-300 dark:border-gray-600"></div>
                    </div>
                    <div className="relative flex justify-center text-sm">
                      <span className="px-2 bg-gray-50 dark:bg-gray-900 text-gray-500">Or</span>
                    </div>
                  </div>
                </>
              )}
              
              <button
                onClick={handleGoogleSignIn}
                className={buttonStyles.primary.large}
              >
                <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24">
                  <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="currentColor" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="currentColor" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="currentColor" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Continue with Google
              </button>
              
              <div className="text-xs text-center text-gray-500 dark:text-gray-400">
                {showLocalAuth ? 'Local authentication enabled for development' : 'Only users with approved email domains can sign in'}
              </div>

              <div className="text-center">
                <Link
                  href="/auth/signup"
                  className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
                >
                  Don't have an account? Sign up instead
                </Link>
              </div>
            </div>
        </div>
      </div>
    </PageLayout>
  );
}

export default function SignIn() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <SignInContent />
    </Suspense>
  );
}