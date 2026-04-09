'use client';

import { useState, useEffect } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { AUTH_EVENTS, onAuthEvent, type AuthEventDetail } from '../../lib/auth-events';

/**
 * Modal that surfaces when a 403 forbidden event is dispatched.
 * Listens for the `auth:forbidden` event.
 *
 * Should be mounted inside the auth shell — i.e., the part of the tree where
 * authentication is required.
 */
export function PermissionDeniedModal() {
  const [showModal, setShowModal] = useState(false);
  const [deniedAction, setDeniedAction] = useState<string>('');

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
    window.history.back();
  };

  const handleGoHome = () => {
    setShowModal(false);
    window.location.href = '/';
  };

  const handleSwitchAccount = () => {
    setShowModal(false);
    window.location.href = `/auth/connect?callbackUrl=${encodeURIComponent(window.location.pathname)}`;
  };

  return (
    <Transition appear show={showModal}>
      <Dialog as="div" className="semiont-modal" onClose={handleGoBack}>
        {/* Backdrop */}
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

        {/* Modal */}
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
                {/* Icon */}
                <div className="semiont-modal__icon-wrapper">
                  <div className="semiont-modal__icon">
                    <svg style={{ width: '1.5rem', height: '1.5rem', color: 'var(--semiont-color-amber-600, #d97706)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  </div>
                </div>

                {/* Content */}
                <div className="semiont-modal__content">
                  <DialogTitle className="semiont-modal__title semiont-modal__title--centered">
                    Access Denied
                  </DialogTitle>
                  <p className="semiont-modal__description">
                    {deniedAction}
                  </p>
                </div>

                {/* Details */}
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

                {/* Actions */}
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
