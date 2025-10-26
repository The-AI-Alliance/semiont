'use client';

import { useEffect, useState, Fragment } from 'react';
import { Dialog, DialogPanel, DialogTitle, DialogDescription, Transition, TransitionChild } from '@headlessui/react';
import { entityTypes as entityTypesAPI } from '@/lib/api/entity-types';

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
  const { data: entityTypesData } = entityTypesAPI.all.useQuery();
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
      <Dialog as="div" className="relative z-50" onClose={onCancel}>
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
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" />
        </TransitionChild>

        {/* Modal panel */}
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
              <DialogPanel className="w-full max-w-md transform overflow-hidden rounded-xl bg-white dark:bg-gray-800 shadow-2xl p-6 transition-all border border-gray-200 dark:border-gray-700">
        {/* Icon */}
        <div className="flex justify-center mb-4">
          <div className="w-12 h-12 bg-gradient-to-br from-yellow-100 to-amber-100 dark:from-yellow-900/30 dark:to-amber-900/30 rounded-full flex items-center justify-center">
            <span className="text-2xl">✨</span>
          </div>
        </div>

                {/* Content */}
                <div className="text-center mb-4">
                  <DialogTitle className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                    Detect Entity References
                  </DialogTitle>

                  <DialogDescription className="text-gray-600 dark:text-gray-400 text-sm">
                    Select entity types to automatically detect and create references for in this document.
                  </DialogDescription>
                </div>

                {/* Entity Types Selection */}
                <div className="mb-4">
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Select entity types to detect:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {allEntityTypes.length > 0 ? (
                      allEntityTypes.map((type: string) => (
                        <button
                          key={type}
                          onClick={() => handleToggleType(type)}
                          className={`px-3 py-1 text-sm rounded-full transition-colors ${
                            selectedTypes.includes(type)
                              ? 'bg-blue-600 text-white'
                              : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                          }`}
                        >
                          {type}
                        </button>
                      ))
                    ) : (
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        No entity types available
                      </p>
                    )}
                  </div>
                </div>

                {/* Selected Count */}
                {selectedTypes.length > 0 && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 text-center mb-4">
                    {selectedTypes.length} type{selectedTypes.length !== 1 ? 's' : ''} selected
                  </p>
                )}

                {/* Actions */}
                <div className="flex gap-2">
                  <button
                    onClick={onCancel}
                    className="flex-1 px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors duration-200 font-medium"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConfirm}
                    disabled={selectedTypes.length === 0}
                    className={`flex-1 px-4 py-2 rounded-lg transition-colors duration-200 font-medium ${
                      selectedTypes.length > 0
                        ? 'bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white shadow-md hover:shadow-lg'
                        : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
                    }`}
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