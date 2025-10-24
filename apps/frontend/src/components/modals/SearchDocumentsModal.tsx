'use client';

import React, { useState, useEffect, Fragment } from 'react';
import { Dialog, DialogPanel, DialogTitle, DialogDescription, Transition, TransitionChild } from '@headlessui/react';
import { documents } from '@/lib/api/documents';

interface SearchDocumentsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (documentId: string) => void;
  searchTerm?: string;
}

export function SearchDocumentsModal({ isOpen, onClose, onSelect, searchTerm = '' }: SearchDocumentsModalProps) {
  const [search, setSearch] = useState(searchTerm);
  const [debouncedSearch, setDebouncedSearch] = useState(searchTerm);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Use React Query for search
  const { data: searchData, isFetching: loading } = documents.search.useQuery(
    debouncedSearch,
    10
  );

  // Extract results from search data
  const results = searchData?.documents?.map((doc: any) => ({
    id: doc.id,
    name: doc.name,
    content: doc.content
  })) || [];

  // Update search term when modal opens
  useEffect(() => {
    if (isOpen && searchTerm) {
      setSearch(searchTerm);
      setDebouncedSearch(searchTerm);
    }
  }, [isOpen, searchTerm]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    // Search is handled by React Query hook
  };

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-[1001]" onClose={onClose}>
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
              <DialogPanel className="w-full max-w-[600px] transform overflow-hidden rounded-lg bg-white dark:bg-gray-800 shadow-xl border border-gray-200 dark:border-gray-700 p-6 transition-all">
                <div className="flex items-center justify-between mb-4">
                  <DialogTitle className="text-lg font-semibold text-gray-900 dark:text-white">
                    Search Documents
                  </DialogTitle>
                  <button
                    onClick={onClose}
                    className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300"
                  >
                    ✕
                  </button>
                </div>

                <form onSubmit={handleSearch} className="mb-4">
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search for documents..."
                    className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg dark:bg-gray-700 text-gray-900 dark:text-white"
                    autoFocus
                  />
                </form>

                <div className="max-h-[60vh] overflow-y-auto">
                  {loading && (
                    <div className="text-center py-4 text-gray-600 dark:text-gray-400">
                      Searching...
                    </div>
                  )}

                  {!loading && results.length === 0 && search && (
                    <div className="text-center py-4 text-gray-600 dark:text-gray-400">
                      No documents found
                    </div>
                  )}

                  {!loading && results.length > 0 && (
                    <div className="space-y-2">
                      {results.map((doc: any) => (
                        <div
                          key={doc.id}
                          className="p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-colors"
                          onClick={() => {
                            onSelect(doc.id);
                            onClose();
                          }}
                        >
                          <h4 className="font-medium text-gray-900 dark:text-white mb-1">
                            {doc.name}
                          </h4>
                          {doc.content && (
                            <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-2">
                              {doc.content.substring(0, 150)}...
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </DialogPanel>
            </TransitionChild>
          </div>
        </div>
      </Dialog>
    </Transition>
  );
}