'use client';

import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { useSemiont } from '../../session/SemiontProvider';
import { useObservable } from '../../hooks/useObservable';

/**
 * Modal that surfaces when the active KB's session expires (a 401 from
 * either the session's own JWT validation or from any React Query call
 * via the QueryCache.onError handler).
 *
 * Reads `sessionExpiredAt$` from the active SemiontSession. When the user
 * dismisses the modal, the session clears the flag.
 */
export function SessionExpiredModal() {
  const session = useObservable(useSemiont().activeSession$);
  const sessionExpiredAt = useObservable(session?.sessionExpiredAt$) ?? null;
  const sessionExpiredMessage = useObservable(session?.sessionExpiredMessage$) ?? null;
  const acknowledgeSessionExpired = () => session?.acknowledgeSessionExpired();
  const showModal = sessionExpiredAt !== null;

  const handleSignIn = () => {
    acknowledgeSessionExpired();
    window.location.href = `/auth/connect?callbackUrl=${encodeURIComponent(window.location.pathname)}`;
  };

  const handleClose = () => {
    acknowledgeSessionExpired();
    window.location.href = '/';
  };

  return (
    <Transition appear show={showModal}>
      <Dialog as="div" className="semiont-modal" onClose={handleClose}>
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
                  <div className="semiont-modal__icon" style={{
                    background: 'linear-gradient(to bottom right, var(--semiont-color-red-100, #fee2e2), var(--semiont-color-red-300, #fca5a5))',
                  }}>
                    <svg style={{ width: '1.5rem', height: '1.5rem', color: 'var(--semiont-color-red-600, #dc2626)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                </div>

                <div className="semiont-modal__content">
                  <DialogTitle className="semiont-modal__title semiont-modal__title--centered">
                    Session Expired
                  </DialogTitle>
                  <p className="semiont-modal__description">
                    {sessionExpiredMessage ?? 'Your session has expired for security reasons. Please sign in again to continue working.'}
                  </p>
                </div>

                <div className="semiont-modal__actions">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="semiont-button--secondary semiont-button--flex"
                  >
                    Go to Home
                  </button>
                  <button
                    type="button"
                    onClick={handleSignIn}
                    className="semiont-button--primary semiont-button--flex"
                  >
                    Sign In Again
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
