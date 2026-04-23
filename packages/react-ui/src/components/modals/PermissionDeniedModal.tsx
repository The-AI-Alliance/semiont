'use client';

import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { useSemiont } from '../../session/SemiontProvider';
import { useObservable } from '../../hooks/useObservable';

/**
 * Modal that surfaces when a 403 forbidden error is reported via
 * `notifyPermissionDenied` (called from QueryCache.onError).
 *
 * Reads `permissionDeniedAt$` and `permissionDeniedMessage$` from the
 * active `FrontendSessionSignals`. The signals instance clears the
 * flag when the user dismisses the modal. Modal state lives on
 * signals (not the session itself) so headless sessions
 * (workers/CLIs) don't carry dead observables.
 */
export function PermissionDeniedModal() {
  const signals = useObservable(useSemiont().activeSignals$);
  const permissionDeniedAt = useObservable(signals?.permissionDeniedAt$) ?? null;
  const permissionDeniedMessage = useObservable(signals?.permissionDeniedMessage$) ?? null;
  const acknowledgePermissionDenied = () => signals?.acknowledgePermissionDenied();
  const showModal = permissionDeniedAt !== null;
  const message = permissionDeniedMessage ?? 'You do not have permission to perform this action.';

  const handleGoBack = () => {
    acknowledgePermissionDenied();
    window.history.back();
  };

  const handleGoHome = () => {
    acknowledgePermissionDenied();
    window.location.href = '/';
  };

  const handleSwitchAccount = () => {
    acknowledgePermissionDenied();
    window.location.href = `/auth/connect?callbackUrl=${encodeURIComponent(window.location.pathname)}`;
  };

  return (
    <Transition appear show={showModal}>
      <Dialog as="div" className="semiont-modal" onClose={handleGoBack}>
        <TransitionChild
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="semiont-modal__backdrop" />
        </TransitionChild>

        <div className="semiont-modal__container">
          <div className="semiont-modal__wrapper">
            <TransitionChild
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel className="semiont-modal__panel semiont-modal__panel--medium">
                <div className="semiont-modal__icon-wrapper">
                  <div className="semiont-modal__icon">
                    <svg style={{ width: '1.5rem', height: '1.5rem', color: 'var(--semiont-color-amber-600, #d97706)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  </div>
                </div>

                <div className="semiont-modal__content">
                  <DialogTitle className="semiont-modal__title semiont-modal__title--centered">
                    Access Denied
                  </DialogTitle>
                  <p className="semiont-modal__description">
                    {message}
                  </p>
                </div>

                <div style={{
                  padding: '0.75rem',
                  backgroundColor: 'var(--semiont-bg-secondary)',
                  borderRadius: 'var(--semiont-radius-md, 0.375rem)',
                  border: '1px solid var(--semiont-border-primary)',
                  fontSize: 'var(--semiont-text-sm, 0.875rem)',
                  marginBottom: '1rem',
                }}>
                  <p style={{ color: 'var(--semiont-text-secondary)', marginBottom: '0.5rem' }}>
                    This could be because:
                  </p>
                  <ul style={{
                    listStyle: 'disc',
                    listStylePosition: 'inside',
                    color: 'var(--semiont-text-tertiary)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25rem',
                  }}>
                    <li>You don't have the required permissions</li>
                    <li>The resource is restricted to specific users or teams</li>
                    <li>Your account type doesn't include this feature</li>
                  </ul>
                </div>

                <div className="semiont-modal__actions">
                  <button
                    type="button"
                    onClick={handleGoBack}
                    className="semiont-button--primary semiont-button--flex"
                  >
                    Go Back
                  </button>
                  <button
                    type="button"
                    onClick={handleGoHome}
                    className="semiont-button--secondary semiont-button--flex"
                  >
                    Go to Home
                  </button>
                </div>
                <div className="semiont-modal__actions" style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--semiont-border-primary)' }}>
                  <button
                    type="button"
                    onClick={handleSwitchAccount}
                    className="semiont-button--secondary semiont-button--flex"
                    style={{ fontSize: 'var(--semiont-text-sm, 0.875rem)' }}
                  >
                    Switch Account
                  </button>
                </div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}
