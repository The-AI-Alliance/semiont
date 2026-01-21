'use client';

import { useEffect, useState, Fragment } from 'react';
import { Dialog, DialogPanel, DialogTitle, DialogDescription, Transition, TransitionChild } from '@headlessui/react';
import { useEntityTypes } from '../../lib/api-hooks';

interface ProposeEntitiesModalProps {
  isOpen: boolean;
  onConfirm: (selectedTypes: string[]) => void;
  onCancel: () => void;
}

const STORAGE_KEY = 'userPreferredEntityTypes';

export function ProposeEntitiesModal({
  isOpen,
  onConfirm,
  onCancel
}: ProposeEntitiesModalProps) {
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);

  // Get available entity types
  const entityTypesAPI = useEntityTypes();
  const { data: entityTypesData } = entityTypesAPI.list.useQuery();
  const allEntityTypes = entityTypesData?.entityTypes || [];

  // Load saved preferences when modal opens
  useEffect(() => {
    if (isOpen) {
      // Try to load saved preferences from sessionStorage
      try {
        const saved = sessionStorage.getItem(STORAGE_KEY);
        if (saved) {
          const savedTypes = JSON.parse(saved);
          // Only use saved types that are still available
          const validSavedTypes = savedTypes.filter((type: string) =>
            allEntityTypes.includes(type)
          );
          setSelectedTypes(validSavedTypes.length > 0 ? validSavedTypes : []);
        } else {
          setSelectedTypes([]);
        }
      } catch (error) {
        console.error('Failed to load entity type preferences:', error);
        setSelectedTypes([]);
      }
    }
  }, [isOpen, allEntityTypes]);

  const handleToggleType = (type: string) => {
    setSelectedTypes(prev =>
      prev.includes(type)
        ? prev.filter(t => t !== type)
        : [...prev, type]
    );
  };

  const handleConfirm = () => {
    if (selectedTypes.length > 0) {
      // Save preferences to sessionStorage
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(selectedTypes));
      } catch (error) {
        console.error('Failed to save entity type preferences:', error);
      }
      onConfirm(selectedTypes);
    }
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="semiont-modal" onClose={onCancel}>
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

        {/* Modal panel */}
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
              <DialogPanel className="semiont-modal__panel semiont-modal__panel--medium">
        {/* Icon */}
        <div className="semiont-modal__icon-wrapper">
          <div className="semiont-modal__icon">
            <span className="semiont-modal__icon-emoji">✨</span>
          </div>
        </div>

                {/* Content */}
                <div className="semiont-modal__content">
                  <DialogTitle className="semiont-modal__title semiont-modal__title--centered">
                    Detect Entity References
                  </DialogTitle>

                  <DialogDescription className="semiont-modal__description">
                    Select entity types to automatically detect and create references for in this document.
                  </DialogDescription>
                </div>

                {/* Entity Types Selection */}
                <div className="semiont-modal__selection">
                  <p className="semiont-modal__selection-label">
                    Select entity types to detect:
                  </p>
                  <div className="semiont-modal__chips">
                    {allEntityTypes.length > 0 ? (
                      allEntityTypes.map((type: string) => (
                        <button
                          key={type}
                          onClick={() => handleToggleType(type)}
                          className={`semiont-chip ${
                            selectedTypes.includes(type)
                              ? 'semiont-chip--selected'
                              : ''
                          }`}
                          data-selected={selectedTypes.includes(type)}
                        >
                          {type}
                        </button>
                      ))
                    ) : (
                      <p className="semiont-modal__empty-state">
                        No entity types available
                      </p>
                    )}
                  </div>
                </div>

                {/* Selected Count */}
                {selectedTypes.length > 0 && (
                  <p className="semiont-modal__count">
                    {selectedTypes.length} type{selectedTypes.length !== 1 ? 's' : ''} selected
                  </p>
                )}

                {/* Actions */}
                <div className="semiont-modal__actions">
                  <button
                    onClick={onCancel}
                    className="semiont-button semiont-button--secondary semiont-button--flex"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConfirm}
                    disabled={selectedTypes.length === 0}
                    className={`semiont-button semiont-button--flex ${
                      selectedTypes.length > 0
                        ? 'semiont-button--primary semiont-button--gradient'
                        : 'semiont-button--disabled'
                    }`}
                    data-disabled={selectedTypes.length === 0}
                  >
                    ✨ Detect Entity References
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