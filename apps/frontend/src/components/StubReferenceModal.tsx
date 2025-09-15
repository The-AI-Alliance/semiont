'use client';

import { useEffect, useRef } from 'react';

interface StubReferenceModalProps {
  isOpen: boolean;
  documentName: string;
  entityTypes?: string[];
  referenceType?: string;
  onConfirm: () => void;
  onGenerate?: () => void;
  onCancel: () => void;
}

export function StubReferenceModal({
  isOpen,
  documentName,
  entityTypes,
  referenceType,
  onConfirm,
  onGenerate,
  onCancel
}: StubReferenceModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;
    
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onCancel]);

  // Handle click outside
  useEffect(() => {
    if (!isOpen) return;
    
    const handleClickOutside = (e: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);
    
    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      
      {/* Modal */}
      <div
        ref={modalRef}
        className="relative bg-white dark:bg-gray-800 rounded-xl shadow-2xl p-6 m-4 max-w-md w-full border border-gray-200 dark:border-gray-700"
      >
        {/* Icon */}
        <div className="flex justify-center mb-4">
          <div className="w-12 h-12 bg-purple-100 dark:bg-purple-900/30 rounded-full flex items-center justify-center">
            <svg className="w-6 h-6 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
        </div>

        {/* Content */}
        <div className="text-center">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            Create Referenced Document
          </h3>
          
          <p className="text-gray-600 dark:text-gray-400 mb-4">
            This reference points to a document that hasn't been created yet.
          </p>
          
          <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-3 mb-4">
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Document to create:</p>
            <p className="font-medium text-gray-900 dark:text-white">{documentName}</p>
            
            {entityTypes && entityTypes.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1 justify-center">
                {entityTypes.map(type => (
                  <span
                    key={type}
                    className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300"
                  >
                    {type}
                  </span>
                ))}
              </div>
            )}
            
            {referenceType && (
              <div className="mt-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Reference type: <span className="font-medium">{referenceType}</span>
                </span>
              </div>
            )}
          </div>
          
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
            Would you like to create this document now? You can edit the name and content in the composer.
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors duration-200 font-medium"
          >
            Stay Here
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors duration-200 font-medium"
          >
            Create Document
          </button>
          {onGenerate && (
            <button
              onClick={onGenerate}
              className="px-4 py-2 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white rounded-lg transition-all duration-200 font-medium shadow-md hover:shadow-lg"
            >
              ✨ Generate Document
            </button>
          )}
        </div>
      </div>
    </div>
  );
}