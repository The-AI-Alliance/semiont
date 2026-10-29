'use client';

import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import type { SessionEndReason } from '@semiont/sdk';
import { useSemiont } from '../../session/SemiontProvider';
import { useObservable } from '../../hooks/useObservable';
import { useTranslations } from '../../contexts/TranslationContext';

/**
 * What a person is told of why their session ended. A switch with no
 * default: a reason added to the SDK does not compile here until it has a
 * sentence.
 */
function whyEnded(reason: SessionEndReason, t: (key: string) => string): string {
  switch (reason) {
    case 'expired':
      return t('expired');
    case 'refused':
      return t('refused');
  }
}

/**
 * Modal that surfaces when the active KB's session has ended: it expired,
 * or the knowledge base did not accept the sign-in. The notice's reason
 * says which; the title is true of either. Every word is the person's
 * language: the notice carries a reason, never a sentence.
 *
 * Reads `sessionEnded$` from the active `SessionSignals`.
 * When the user dismisses the modal, the signals instance clears the
 * flag. Modal state lives on signals (not the session itself) so
 * headless sessions (workers/CLIs) don't carry dead observables.
 */
export function SessionEndedModal() {
  const t = useTranslations('SessionEndedModal');
  const signals = useObservable(useSemiont().activeSignals$);
  const sessionEnded = useObservable(signals?.sessionEnded$) ?? null;
  const acknowledgeSessionEnded = () => signals?.acknowledgeSessionEnded();
  const showModal = sessionEnded !== null;

  const handleSignIn = () => {
    acknowledgeSessionEnded();
    window.location.href = `/auth/connect?callbackUrl=${encodeURIComponent(window.location.pathname)}`;
  };

  const handleClose = () => {
    acknowledgeSessionEnded();
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
                    {t('title')}
                  </DialogTitle>
                  {sessionEnded && (
                    <p className="semiont-modal__description">
                      {whyEnded(sessionEnded.reason, t)}
                    </p>
                  )}
                </div>

                <div className="semiont-modal__actions">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="semiont-button--secondary semiont-button--flex"
                  >
                    {t('goHome')}
                  </button>
                  <button
                    type="button"
                    onClick={handleSignIn}
                    className="semiont-button--primary semiont-button--flex"
                  >
                    {t('signInAgain')}
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
