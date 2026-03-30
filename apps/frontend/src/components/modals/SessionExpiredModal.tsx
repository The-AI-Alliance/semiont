import React, { useState, useEffect } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { useSessionContext } from '@semiont/react-ui';
import { AUTH_EVENTS, onAuthEvent } from '@semiont/react-ui';

export function SessionExpiredModal() {
  const { isAuthenticated } = useSessionContext();
  const [wasAuthenticated, setWasAuthenticated] = useState(isAuthenticated);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    // Detect when session expires (transition from authenticated to not authenticated)
    if (wasAuthenticated && !isAuthenticated) {
      setShowModal(true);
    }
    setWasAuthenticated(isAuthenticated);
  }, [isAuthenticated, wasAuthenticated]);

  useEffect(() => {
    // Listen for 401 unauthorized events
    const cleanup = onAuthEvent(AUTH_EVENTS.UNAUTHORIZED, () => {
      setShowModal(true);
    });

    return cleanup;
  }, []);

  const handleSignIn = () => {
    window.location.href = `/auth/connect?callbackUrl=${encodeURIComponent(window.location.pathname)}`;
  };

  const handleClose = () => {
    setShowModal(false);
    window.location.href = '/';
  };

  return (
    <Transition appear show={showModal}>
      <Dialog as="div" className="semiont-modal" onClose={handleClose}>
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
                  <div className="semiont-modal__icon" style={{
                    background: 'linear-gradient(to bottom right, var(--semiont-color-red-100, #fee2e2), var(--semiont-color-red-300, #fca5a5))',
                  }}>
                    <svg style={{ width: '1.5rem', height: '1.5rem', color: 'var(--semiont-color-red-600, #dc2626)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                </div>

                {/* Content */}
                <div className="semiont-modal__content">
                  <DialogTitle className="semiont-modal__title semiont-modal__title--centered">
                    Session Expired
                  </DialogTitle>
                  <p className="semiont-modal__description">
                    Your session has expired for security reasons. Please sign in again to continue working.
                  </p>
                </div>

                {/* Actions */}
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
