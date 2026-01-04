'use client';

import React, { Fragment } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';

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
      <Dialog as="div" className="relative z-[1000]" onClose={onClose}>
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
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" />
        </TransitionChild>

        {/* Modal */}
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
              <DialogPanel className="w-full max-w-2xl transform overflow-hidden rounded-lg bg-white dark:bg-gray-800 shadow-xl transition-all">
                {/* Header */}
                <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                  <div className="flex items-center justify-between">
                    <DialogTitle className="text-lg font-semibold text-gray-900 dark:text-white">
                      {t('title')}
                    </DialogTitle>
                    <button
                      onClick={onClose}
                      aria-label={t('closeDialog')}
                      className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Content */}
                <div className="px-6 py-4 max-h-[70vh] overflow-y-auto">
                  <div className="space-y-6">
                    {shortcutGroups.map((group) => (
                      <div key={group.titleKey}>
                        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">
                          {t(group.titleKey)}
                        </h3>
                        <div className="space-y-2">
                          {group.shortcuts.map((shortcut, index) => (
                            <div
                              key={index}
                              className="flex items-center justify-between py-1.5"
                            >
                              <span className="text-sm text-gray-600 dark:text-gray-400">
                                {t(shortcut.descriptionKey)}
                              </span>
                              <div className="flex items-center gap-2">
                                {shortcut.keys.map((key, keyIndex) => {
                                  // Only show Mac keys on Mac, Windows/Linux keys on others
                                  if (key.includes('⌘') && !isMac) return null;
                                  if (key.includes('Ctrl') && isMac) return null;

                                  return (
                                    <React.Fragment key={keyIndex}>
                                      {keyIndex > 0 && !key.includes('⌘') && !key.includes('Ctrl') && (
                                        <span className="text-xs text-gray-400 dark:text-gray-500">{t('or')}</span>
                                      )}
                                      <kbd className="px-2 py-1 text-xs font-semibold text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded">
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
                  <div className="mt-8 pt-4 border-t border-gray-200 dark:border-gray-700">
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {isMac ? t('macNote') : t('windowsNote')}
                    </p>
                  </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-3 bg-gray-50 dark:bg-gray-900/50 border-t border-gray-200 dark:border-gray-700">
                  <div className="flex items-center justify-between">
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {t('footerHint', { key: '?' }).split('?').map((part, i, arr) => (
                        <React.Fragment key={i}>
                          {part}
                          {i < arr.length - 1 && (
                            <kbd className="px-1.5 py-0.5 text-xs font-semibold bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded">?</kbd>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                    <button
                      onClick={onClose}
                      className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
