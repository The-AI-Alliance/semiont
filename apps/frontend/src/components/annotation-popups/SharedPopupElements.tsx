'use client';

import React, { Fragment } from 'react';
import { Dialog, DialogPanel, DialogTitle, DialogDescription, Transition, TransitionChild } from '@headlessui/react';

interface SelectedTextDisplayProps {
  exact: string;
}

export function SelectedTextDisplay({ exact }: SelectedTextDisplayProps) {
  return (
    <div className="mb-4 p-3 bg-gray-100 dark:bg-gray-700 rounded-lg">
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">Selected text:</p>
      <p className="text-sm font-medium text-gray-900 dark:text-white">
        "{exact}"
      </p>
    </div>
  );
}

interface EntityTypeBadgesProps {
  entityTypes: string;
}

export function EntityTypeBadges({ entityTypes }: EntityTypeBadgesProps) {
  if (!entityTypes) return null;

  return (
    <div className="mb-3">
      {entityTypes.split(',').map((type, index) => (
        <span
          key={index}
          className="inline-block px-2 py-1 text-xs font-medium rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 mr-1 mb-1"
        >
          {type.trim()}
        </span>
      ))}
    </div>
  );
}

interface PopupHeaderProps {
  title: string;
  onClose: () => void;
}

export function PopupHeader({ title, onClose }: PopupHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
        {title}
      </h3>
      <button
        onClick={onClose}
        className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300"
      >
        ✕
      </button>
    </div>
  );
}

interface PopupContainerProps {
  children: React.ReactNode;
  position: { x: number; y: number };
  onClose: () => void;
  isOpen: boolean;
}

export function PopupContainer({ children, position, onClose, isOpen }: PopupContainerProps) {
  const popupStyle: React.CSSProperties = {
    position: 'fixed',
    left: `${Math.min(position.x, typeof window !== 'undefined' ? window.innerWidth - 400 : position.x)}px`,
    top: `${Math.min(position.y, typeof window !== 'undefined' ? window.innerHeight - 500 : position.y)}px`,
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-[999]" onClose={onClose}>
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
          <div className="fixed inset-0 bg-black/20 backdrop-blur-sm" />
        </TransitionChild>

        {/* Popup positioned at cursor */}
        <div className="fixed inset-0 pointer-events-none">
          <TransitionChild
            as={Fragment}
            enter="ease-out duration-200"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="ease-in duration-150"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <DialogPanel
              className="pointer-events-auto bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-4 w-96 max-h-[500px] overflow-y-auto"
              style={popupStyle}
            >
              {children}
            </DialogPanel>
          </TransitionChild>
        </div>
      </Dialog>
    </Transition>
  );
}