'use client';

import React, { Fragment } from 'react';
import { Dialog, DialogPanel, DialogTitle, DialogDescription, Transition, TransitionChild } from '@headlessui/react';

interface SelectedTextDisplayProps {
  exact: string;
}

export function SelectedTextDisplay({ exact }: SelectedTextDisplayProps) {
  return (
    <div className="semiont-selected-text-display">
      <p className="semiont-selected-text-display__label">Selected text:</p>
      <p className="semiont-selected-text-display__content">
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
    <div className="semiont-entity-type-badges">
      {entityTypes.split(',').map((type, index) => (
        <span
          key={index}
          className="semiont-entity-type-badges__badge"
        >
          {type.trim()}
        </span>
      ))}
    </div>
  );
}

interface PopupHeaderProps {
  title: string;
  selectedText?: string;
  onClose: () => void;
}

export function PopupHeader({ title, selectedText, onClose }: PopupHeaderProps) {
  return (
    <div className="semiont-popup-header">
      <h3 className="semiont-popup-header__title">
        {title}
        {selectedText && (
          <span className="semiont-popup-header__subtitle">
            &ldquo;{selectedText}&rdquo;
          </span>
        )}
      </h3>
      <button
        onClick={onClose}
        className="semiont-popup-header__close-button"
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
  wide?: boolean; // Optional prop to make the popup wider
}

export function PopupContainer({ children, position, onClose, isOpen, wide = false }: PopupContainerProps) {
  const popupWidth = wide ? 800 : 400;
  const popupHeight = wide ? 700 : 500;

  const popupStyle: React.CSSProperties = {
    position: 'fixed',
    left: `${Math.min(position.x, typeof window !== 'undefined' ? window.innerWidth - popupWidth : position.x)}px`,
    top: `${Math.min(position.y, typeof window !== 'undefined' ? window.innerHeight - popupHeight : position.y)}px`,
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="semiont-popup-overlay" onClose={onClose}>
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
          <div className="semiont-popup-backdrop" />
        </TransitionChild>

        {/* Popup positioned at cursor */}
        <div className="semiont-popup-container">
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
              className="semiont-popup-panel"
              style={popupStyle}
              data-annotation-ui
              data-wide={wide ? 'true' : 'false'}
            >
              {children}
            </DialogPanel>
          </TransitionChild>
        </div>
      </Dialog>
    </Transition>
  );
}
