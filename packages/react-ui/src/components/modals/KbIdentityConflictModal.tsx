'use client';

import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { useSemiont } from '../../session/SemiontProvider';
import { useObservable } from '../../hooks/useObservable';
import { useTranslations } from '../../contexts/TranslationContext';

/**
 * A registered KB's address answered with a DIFFERENT did at activation
 * (KB-IDENTITY-CHECKED-ON-ACTIVATION P2). By the time this renders, the SDK
 * has already voided the tab list and last-viewed state that claimed to be
 * about the old KB — this modal only TELLS, honestly: the entry the user
 * registered and the identity that answered are two distinct facts, both dids
 * verbatim, and the newcomer is never presented under the registered label
 * (KB-IDENTITY-VS-ADDRESS decision 7). The forward route is the Knowledge
 * Base panel, which owns re-registration; the registry entry itself is left
 * exactly as the user wrote it — it is the evidence.
 *
 * Third member of the signals-modal family (SessionExpiredModal,
 * PermissionDeniedModal): reads the active `SessionSignals`, dismiss
 * acknowledges. Unlike its elders it is fully translated — new strings go
 * through the census gate.
 */
export function KbIdentityConflictModal() {
  const t = useTranslations('KbIdentityConflictModal');
  const semiont = useSemiont();
  const signals = useObservable(semiont.activeSignals$);
  const conflictAt = useObservable(signals?.kbIdentityConflictAt$) ?? null;
  const conflict = useObservable(signals?.kbIdentityConflict$) ?? null;
  const kb = useObservable(semiont.activeSession$)?.kb ?? null;

  const showModal = conflictAt !== null && conflict !== null;
  if (!showModal) return null;

  const acknowledge = () => signals?.acknowledgeKbIdentityConflict();
  const handleReview = () => {
    acknowledge();
    semiont.emit('panel:open', { panel: 'knowledge-base' });
  };

  return (
    <Transition appear show={showModal}>
      <Dialog as="div" className="semiont-modal" onClose={acknowledge}>
        <TransitionChild
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="semiont-modal__backdrop" aria-hidden="true" />
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
                <div className="semiont-modal__content">
                  <DialogTitle className="semiont-modal__title semiont-modal__title--centered">
                    {t('title')}
                  </DialogTitle>
                  <div className="semiont-modal__description">
                    <div className="semiont-kb-conflict__fact">
                      <span className="semiont-kb-conflict__fact-label">{t('registeredIdentity')}</span>
                      {kb?.label && <span className="semiont-kb-conflict__kb-name">{kb.label}</span>}
                      <code className="semiont-kb-conflict__did">{conflict.expectedDid}</code>
                    </div>
                    <div className="semiont-kb-conflict__fact">
                      <span className="semiont-kb-conflict__fact-label">{t('answeringNow')}</span>
                      <code className="semiont-kb-conflict__did">{conflict.observedDid}</code>
                    </div>
                    <p>{t('stateCleared')}</p>
                  </div>
                </div>
                <div className="semiont-modal__actions">
                  <button type="button" onClick={acknowledge} className="semiont-button--secondary semiont-button--flex">
                    {t('dismiss')}
                  </button>
                  <button type="button" onClick={handleReview} className="semiont-button--primary semiont-button--flex">
                    {t('reviewKnowledgeBases')}
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
