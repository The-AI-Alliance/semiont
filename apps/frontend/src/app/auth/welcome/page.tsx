'use client';

import React from 'react';
import { useSession } from 'next-auth/react';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function Welcome() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [isLoading] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);

  // Redirect if not authenticated or if terms already accepted
  useEffect(() => {
    if (status === 'loading') return; // Still loading
    if (status === 'unauthenticated') {
      router.push('/auth/signin');
      return;
    }
    
    // Check if user has accepted terms by calling the /me endpoint
    const checkTermsAcceptance = async () => {
      if (!session?.backendToken) return;
      
      try {
        const response = await fetch('/api/auth/me', {
          headers: {
            'Authorization': `Bearer ${session.backendToken}`,
          },
        });
        
        if (response.ok) {
          const userData = await response.json();
          if (userData.termsAcceptedAt) {
            router.push('/');
            return;
          }
        }
      } catch (error) {
        console.error('Error checking terms acceptance:', error);
      }
    };
    
    if (session?.backendToken) {
      checkTermsAcceptance();
    }
    
    // If not a new user, redirect to main app (existing users don't need to accept terms again)
    if (session && !session.isNewUser) {
      router.push('/');
      return;
    }
  }, [status, session, router]);

  const handleTermsAcceptance = async (accepted: boolean) => {
    if (!accepted) {
      // User declined terms - sign them out and redirect to home
      const { signOut } = await import('next-auth/react');
      await signOut({ callbackUrl: '/' });
      return;
    }

    try {
      // Call backend API to record terms acceptance
      const response = await fetch('/api/auth/accept-terms', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session?.backendToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to record terms acceptance');
      }

      setTermsAccepted(true);
      
      // Small delay to show the acceptance state
      setTimeout(() => {
        router.push('/');
      }, 1000);
    } catch (error) {
      console.error('Terms acceptance error:', error);
      // Handle error - maybe show a message to the user
      alert('There was an error recording your terms acceptance. Please try again.');
    }
  };

  // Show loading while session is being fetched
  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="w-8 h-8 mx-auto animate-spin rounded-full border-2 border-blue-600 border-t-transparent"></div>
          <p className="mt-2 text-gray-600 dark:text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  // Show terms accepted confirmation
  if (termsAccepted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="w-16 h-16 mx-auto bg-green-100 dark:bg-green-900 rounded-full flex items-center justify-center">
            <svg className="w-8 h-8 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Welcome to Semiont!</h2>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              Thanks for accepting our terms. Redirecting you to the app...
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Show terms acceptance form
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 py-12">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="bg-white dark:bg-gray-800 shadow-lg rounded-lg p-8">
          <div className="text-center mb-8">
            <div className="w-16 h-16 mx-auto bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center mb-4">
              <svg className="w-8 h-8 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
              Welcome to Semiont, {session?.user?.name?.split(' ')[0]}!
            </h1>
            <p className="mt-2 text-gray-600 dark:text-gray-400">
              Before you can start using Semiont, please review and accept our terms of service
            </p>
          </div>

          <div className="max-h-96 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg p-6 mb-6 bg-gray-50 dark:bg-gray-900">
            <div className="prose dark:prose-invert max-w-none text-sm">
              <h3>Terms of Service Summary</h3>
              <p>By using Semiont, you agree to:</p>
              
              <h4>✅ Acceptable Use</h4>
              <ul>
                <li>Use the platform responsibly and lawfully</li>
                <li>Respect other users and maintain a constructive environment</li>
                <li>Follow the AI Alliance Code of Conduct principles</li>
              </ul>

              <h4>❌ Prohibited Content</h4>
              <p>You agree not to upload or share:</p>
              <ul>
                <li>Illegal, harmful, or abusive content</li>
                <li>Adult content, pornography, or sexually explicit material</li>
                <li>Hate speech, harassment, or discriminatory content</li>
                <li>Violence, threats, or content promoting harm</li>
                <li>Misinformation or deliberately false content</li>
                <li>Privacy violations or personal information without consent</li>
                <li>Copyrighted material without authorization</li>
                <li>Malware, viruses, or security threats</li>
                <li>Spam or manipulative content</li>
              </ul>

              <h4>🤝 AI Alliance Code of Conduct</h4>
              <p>
                This platform follows the{' '}
                <a 
                  href="https://ai-alliance.cdn.prismic.io/ai-alliance/Zl-MG5m069VX1dgH_AIAllianceCodeofConduct.pdf"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline"
                >
                  AI Alliance Code of Conduct
                </a>
                , promoting responsible AI development, transparency, privacy protection, and ethical considerations.
              </p>

              <h4>🔒 Your Responsibilities</h4>
              <ul>
                <li>Keep your account secure</li>
                <li>Report violations you encounter</li>
                <li>Provide accurate information</li>
                <li>Comply with all applicable laws</li>
              </ul>

              <p className="mt-4 font-medium">
                Violations may result in content removal, account suspension, or termination.
              </p>
            </div>
          </div>

          <div className="text-center space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Read the full{' '}
              <Link 
                href="/terms" 
                target="_blank"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                Terms of Service
              </Link>
              {' '}and{' '}
              <Link 
                href="/privacy" 
                target="_blank"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                Privacy Policy
              </Link>
            </p>
            
            <div className="flex justify-center gap-4">
              <button
                onClick={() => handleTermsAcceptance(false)}
                disabled={isLoading}
                className="px-6 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                Decline & Sign Out
              </button>
              <button
                onClick={() => handleTermsAcceptance(true)}
                disabled={isLoading}
                className="px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50"
              >
                {isLoading ? 'Processing...' : 'Accept & Continue'}
              </button>
            </div>

            <p className="text-xs text-gray-500 dark:text-gray-400">
              By clicking "Accept & Continue", you agree to be legally bound by these terms.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}