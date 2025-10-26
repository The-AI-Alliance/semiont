'use client';

import React, { useState, useEffect, Fragment } from 'react';
import { Dialog, DialogPanel, DialogTitle, DialogDescription, Transition, TransitionChild } from '@headlessui/react';
import { useRouter } from '@/i18n/routing';
import { signIn, useSession } from 'next-auth/react';
import { AUTH_EVENTS, onAuthEvent, type AuthEventDetail } from '@/lib/auth-events';

export function PermissionDeniedModal() {
  const [showModal, setShowModal] = useState(false);
  const [deniedAction, setDeniedAction] = useState<string>('');
  const router = useRouter();
  const { data: session } = useSession();

  useEffect(() => {
    // Listen for 403 forbidden events
    const cleanup = onAuthEvent(AUTH_EVENTS.FORBIDDEN, (event: CustomEvent<AuthEventDetail>) => {
      setDeniedAction(event.detail.message || 'You do not have permission to perform this action.');
      setShowModal(true);
    });

    return cleanup;
  }, []);

  const handleGoBack = () => {
    setShowModal(false);
    router.back();
  };

  const handleGoHome = () => {
    setShowModal(false);
    router.push('/');
  };

  const handleSwitchAccount = () => {
    setShowModal(false);
    // Sign out and sign in with different account
    signIn(undefined, { callbackUrl: window.location.pathname });
  };

  const handleRequestAccess = () => {
    setShowModal(false);
    // In the future, this would open a request access form
    // For now, just close the modal
    alert('Access request feature coming soon. Please contact your administrator.');
  };

  return (
    <Transition appear show={showModal} as={Fragment}>
      <Dialog as="div" className="relative z-[10000]" onClose={handleGoBack}>
        {/* Backdrop */}
        <TransitionChild
          as={Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
        </TransitionChild>

        {/* Modal panel */}
        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <TransitionChild
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel className="w-full max-w-md transform overflow-hidden rounded-lg bg-white dark:bg-gray-800 shadow-xl transition-all">
                {/* Header */}
                <div className="p-6 pb-4">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="flex-shrink-0 w-10 h-10 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center">
                      <svg className="w-6 h-6 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                    </div>
                    <DialogTitle className="text-xl font-semibold text-gray-900 dark:text-white">
                      Access Denied
                    </DialogTitle>
                  </div>

                  <DialogDescription className="text-gray-600 dark:text-gray-300 mb-4">
                    {deniedAction}
                  </DialogDescription>

                  {/* Additional context */}
                  <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3 text-sm">
                    <p className="text-gray-600 dark:text-gray-400 mb-2">
                      This could be because:
                    </p>
                    <ul className="list-disc list-inside text-gray-500 dark:text-gray-500 space-y-1">
                      <li>You don't have the required permissions</li>
                      <li>The resource is restricted to specific users or teams</li>
                      <li>Your account type doesn't include this feature</li>
                    </ul>
                  </div>

                  {/* Show current user */}
                  {session?.user?.email && (
                    <div className="mt-4 text-xs text-gray-500 dark:text-gray-400">
                      Currently signed in as: <span className="font-medium">{session.user.email}</span>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="px-6 pb-6">
                  <div className="flex flex-col gap-2">
                    {/* Primary actions */}
                    <div className="flex gap-2">
                      <button
                        onClick={handleGoBack}
                        className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800 transition-colors"
                      >
                        Go Back
                      </button>
                      <button
                        onClick={handleGoHome}
                        className="flex-1 px-4 py-2 text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                      >
                        Go to Home
                      </button>
                    </div>

                    {/* Secondary actions */}
                    <div className="flex gap-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                      <button
                        onClick={handleSwitchAccount}
                        className="flex-1 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
                      >
                        Switch Account
                      </button>
                      <button
                        onClick={handleRequestAccess}
                        className="flex-1 px-3 py-1.5 text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                      >
                        Request Access
                      </button>
                    </div>
                  </div>
                </div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}