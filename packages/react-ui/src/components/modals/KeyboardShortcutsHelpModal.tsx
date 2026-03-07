'use client';

import React, { Fragment } from 'react';
import { useTranslations } from '../../contexts/TranslationContext';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import './modals.css';

interface KeyboardShortcutsHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutGroup {
  titleKey: string;
  shortcuts: {
    keys: string[];
    descriptionKey: string;
  }[];
}

const shortcutGroups: ShortcutGroup[] = [
  {
    titleKey: 'navigationTitle',
    shortcuts: [
      { keys: ['⌘K', 'Ctrl K'], descriptionKey: 'navOpenSearch' },
      { keys: ['/'], descriptionKey: 'navOpenSearchAlt' },
      { keys: ['⌘N', 'Ctrl N'], descriptionKey: 'navCreateResource' },
      { keys: ['Esc Esc'], descriptionKey: 'navCloseOverlays' },
      { keys: ['?'], descriptionKey: 'navShowHelp' },
    ]
  },
  {
    titleKey: 'sidebarTitle',
    shortcuts: [
      { keys: ['Click <'], descriptionKey: 'sidebarCollapse' },
      { keys: ['Click ☰'], descriptionKey: 'sidebarExpand' },
      { keys: ['Space'], descriptionKey: 'sidebarPickup' },
      { keys: ['↑', '↓'], descriptionKey: 'sidebarMove' },
      { keys: ['Space'], descriptionKey: 'sidebarDrop' },
      { keys: ['Esc'], descriptionKey: 'sidebarCancel' },
    ]
  },
  {
    titleKey: 'annotationsTitle',
    shortcuts: [
      { keys: ['H'], descriptionKey: 'annotHighlight' },
      { keys: ['R'], descriptionKey: 'annotReference' },
      { keys: ['Delete'], descriptionKey: 'annotDelete' },
      { keys: ['Tab'], descriptionKey: 'annotNavigate' },
      { keys: ['Shift Tab'], descriptionKey: 'annotNavigateBack' },
    ]
  },
  {
    titleKey: 'listsTitle',
    shortcuts: [
      { keys: ['←', '→'], descriptionKey: 'listsFilterNav' },
      { keys: ['↑', '↓', '←', '→'], descriptionKey: 'listsGridNav' },
      { keys: ['Home'], descriptionKey: 'listsJumpFirst' },
      { keys: ['End'], descriptionKey: 'listsJumpLast' },
    ]
  },
  {
    titleKey: 'searchModalTitle',
    shortcuts: [
      { keys: ['↑', '↓'], descriptionKey: 'searchNav' },
      { keys: ['Enter'], descriptionKey: 'searchSelect' },
      { keys: ['Esc'], descriptionKey: 'searchClose' },
    ]
  },
  {
    titleKey: 'modalTitle',
    shortcuts: [
      { keys: ['Esc'], descriptionKey: 'modalClose' },
      { keys: ['Tab'], descriptionKey: 'modalNavForward' },
      { keys: ['Shift Tab'], descriptionKey: 'modalNavBackward' },
      { keys: ['Enter'], descriptionKey: 'modalActivate' },
      { keys: ['Space'], descriptionKey: 'modalActivate' },
    ]
  },
  {
    titleKey: 'accessibilityTitle',
    shortcuts: [
      { keys: ['Tab'], descriptionKey: 'a11ySkipLinks' },
      { keys: ['Enter'], descriptionKey: 'a11yFollowLink' },
    ]
  }
];

export function KeyboardShortcutsHelpModal({ isOpen, onClose }: KeyboardShortcutsHelpModalProps) {
  const t = useTranslations('KeyboardShortcuts');
  const isMac = typeof window !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="semiont-modal" onClose={onClose}>
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
          <div className="semiont-modal__backdrop" />
        </TransitionChild>

        {/* Modal */}
        <div className="semiont-modal__container">
          <div className="semiont-modal__wrapper">
            <TransitionChild
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95"
              enterTo="opacity-100 scale-100"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100"
              leaveTo="opacity-0 scale-95"
            >
              <DialogPanel className="semiont-modal__panel semiont-modal__panel--large">
                {/* Header */}
                <div className="semiont-modal__header">
                  <div className="semiont-modal__header-content">
                    <DialogTitle className="semiont-modal__title">
                      {t('title')}
                    </DialogTitle>
                    <button
                      onClick={onClose}
                      aria-label={t('closeDialog')}
                      className="semiont-modal__close"
                    >
                      <svg className="semiont-modal__close-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Content */}
                <div className="semiont-modal__body">
                  <div className="semiont-shortcuts">
                    {shortcutGroups.map((group) => (
                      <div key={group.titleKey} className="semiont-shortcuts__group">
                        <h3 className="semiont-shortcuts__group-title">
                          {t(group.titleKey)}
                        </h3>
                        <div className="semiont-shortcuts__list">
                          {group.shortcuts.map((shortcut, index) => (
                            <div
                              key={index}
                              className="semiont-shortcuts__item"
                            >
                              <span className="semiont-shortcuts__description">
                                {t(shortcut.descriptionKey)}
                              </span>
                              <div className="semiont-shortcuts__keys">
                                {shortcut.keys.map((key, keyIndex) => {
                                  // Only show Mac keys on Mac, Windows/Linux keys on others
                                  if (key.includes('⌘') && !isMac) return null;
                                  if (key.includes('Ctrl') && isMac) return null;

                                  return (
                                    <React.Fragment key={keyIndex}>
                                      {keyIndex > 0 && !key.includes('⌘') && !key.includes('Ctrl') && (
                                        <span className="semiont-shortcuts__separator">{t('or')}</span>
                                      )}
                                      <kbd className="semiont-shortcuts__key">
                                        {key}
                                      </kbd>
                                    </React.Fragment>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Platform note */}
                  <div className="semiont-shortcuts__note">
                    <p className="semiont-shortcuts__note-text">
                      {isMac ? t('macNote') : t('windowsNote')}
                    </p>
                  </div>
                </div>

                {/* Footer */}
                <div className="semiont-modal__footer">
                  <div className="semiont-modal__footer-content">
                    <div className="semiont-modal__hint">
                      {t('footerHint', { key: '?' }).split('?').map((part, i, arr) => (
                        <React.Fragment key={i}>
                          {part}
                          {i < arr.length - 1 && (
                            <kbd className="semiont-modal__hint-key">?</kbd>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                    <button
                      onClick={onClose}
                      className="semiont-button semiont-button--secondary"
                    >
                      {t('close')}
                    </button>
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
