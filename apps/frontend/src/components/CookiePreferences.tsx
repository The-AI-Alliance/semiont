"use client";

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  getCookieConsent,
  setCookieConsent,
  COOKIE_CATEGORIES,
  CookieConsent,
  exportUserData,
  deleteAllUserData,
  type CookieCategory
} from '@/lib/cookies';
import {
  CogIcon,
  TrashIcon,
  ArrowDownTrayIcon,
  ShieldCheckIcon,
  XMarkIcon
} from '@heroicons/react/24/outline';

interface CookiePreferencesProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CookiePreferences({ isOpen, onClose }: CookiePreferencesProps) {
  const t = useTranslations('CookiePreferences');
  const [consent, setConsent] = useState<CookieConsent | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const currentConsent = getCookieConsent();
      setConsent(currentConsent || {
        necessary: true,
        analytics: false,
        marketing: false,
        preferences: false,
        timestamp: new Date().toISOString(),
        version: '1.0'
      });
    }
  }, [isOpen]);

  // Handle ESC key to close modal
  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEsc);
      return () => {
        document.removeEventListener('keydown', handleEsc);
      };
    }
  }, [isOpen, onClose]);

  const handleSave = async () => {
    if (!consent) return;
    
    setIsLoading(true);
    setCookieConsent(consent);
    setIsLoading(false);
    onClose();
  };

  const handleCategoryToggle = (categoryId: keyof Omit<CookieConsent, 'timestamp' | 'version'>) => {
    if (categoryId === 'necessary' || !consent) return;
    
    setConsent(prev => prev ? {
      ...prev,
      [categoryId]: !prev[categoryId]
    } : null);
  };

  const handleExportData = () => {
    const data = exportUserData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { 
      type: 'application/json' 
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `semiont-user-data-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDeleteAllData = () => {
    deleteAllUserData();
  };

  if (!isOpen || !consent) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
        {/* Background overlay */}
        <div 
          className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75"
          onClick={onClose}
        />

        {/* Modal panel */}
        <div className="inline-block align-bottom bg-white rounded-lg px-4 pt-5 pb-4 text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-2xl sm:w-full sm:p-6 relative">
          {/* Close button in upper right */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 rounded-lg p-1"
            aria-label="Close"
          >
            <XMarkIcon className="h-6 w-6" />
          </button>

          <div className="sm:flex sm:items-start">
            <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-blue-100 sm:mx-0 sm:h-10 sm:w-10">
              <CogIcon className="h-6 w-6 text-blue-600" />
            </div>
            <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left flex-1 pr-8">
              <h3 className="text-lg leading-6 font-medium text-gray-900">
                {t('title')}
              </h3>
              <div className="mt-2">
                <p className="text-sm text-gray-500">
                  {t('description')}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-6">
            <div className="space-y-6">
              {/* Current consent info */}
              <div className="bg-gray-50 rounded-lg p-4">
                <div className="flex items-center">
                  <ShieldCheckIcon className="h-5 w-5 text-green-500 mr-2" />
                  <span className="text-sm font-medium text-gray-900">
                    {t('currentSettings')}
                  </span>
                </div>
                <div className="mt-2 text-xs text-gray-600">
                  <p>{t('lastUpdated', { date: new Date(consent.timestamp).toLocaleDateString() })}</p>
                  <p>{t('version', { version: consent.version })}</p>
                </div>
              </div>

              {/* Cookie categories */}
              <div className="space-y-4">
                <h4 className="text-base font-medium text-gray-900">
                  {t('cookieCategories')}
                </h4>
                
                {COOKIE_CATEGORIES.map((category: CookieCategory) => (
                  <div key={category.id} className="border border-gray-200 rounded-lg p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center">
                          <input
                            id={`pref-${category.id}`}
                            type="checkbox"
                            checked={consent[category.id] || false}
                            onChange={() => handleCategoryToggle(category.id)}
                            disabled={category.required || isLoading}
                            className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded disabled:opacity-50"
                          />
                          <label
                            htmlFor={`pref-${category.id}`}
                            className="ml-3 text-sm font-medium text-gray-900 cursor-pointer"
                          >
                            {category.name}
                            {category.required && (
                              <span className="text-xs text-gray-500 ml-1">{t('required')}</span>
                            )}
                          </label>
                        </div>
                        <p className="mt-1 text-sm text-gray-600">
                          {category.description}
                        </p>
                        <details className="mt-2">
                          <summary className="text-xs text-blue-600 cursor-pointer hover:text-blue-800">
                            {t('viewCookies', { count: category.cookies.length })}
                          </summary>
                          <div className="mt-1 text-xs text-gray-500 bg-gray-50 rounded p-2">
                            <ul className="list-disc list-inside space-y-1">
                              {category.cookies.map(cookie => (
                                <li key={cookie}>{cookie}</li>
                              ))}
                            </ul>
                          </div>
                        </details>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Data management section */}
              <div className="border-t border-gray-200 pt-6">
                <h4 className="text-base font-medium text-gray-900 mb-4">
                  {t('dataManagement')}
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <button
                    onClick={handleExportData}
                    className="flex items-center justify-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                  >
                    <ArrowDownTrayIcon className="h-4 w-4 mr-2" />
                    {t('exportMyData')}
                  </button>

                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="flex items-center justify-center px-4 py-2 border border-red-300 rounded-md shadow-sm text-sm font-medium text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500"
                  >
                    <TrashIcon className="h-4 w-4 mr-2" />
                    {t('deleteAllData')}
                  </button>
                </div>

                <p className="mt-2 text-xs text-gray-500">
                  {t('dataManagementDescription')}
                </p>
              </div>
            </div>
          </div>

          {/* Quick Actions */}
          <div className="mt-6 flex flex-wrap gap-2 justify-center">
            <button
              type="button"
              onClick={() => {
                setConsent(prev => prev ? {
                  ...prev,
                  necessary: true,
                  analytics: false,
                  marketing: false,
                  preferences: false
                } : null);
              }}
              disabled={isLoading}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 transition-colors"
            >
              {t('rejectAll')}
            </button>
            <button
              type="button"
              onClick={() => {
                setConsent(prev => prev ? {
                  ...prev,
                  necessary: true,
                  analytics: true,
                  marketing: true,
                  preferences: true
                } : null);
              }}
              disabled={isLoading}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50 transition-colors"
            >
              {t('acceptAll')}
            </button>
          </div>

          {/* Action buttons */}
          <div className="mt-6 sm:flex sm:flex-row-reverse">
            <button
              type="button"
              onClick={handleSave}
              disabled={isLoading}
              className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-blue-600 text-base font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 sm:ml-3 sm:w-auto sm:text-sm disabled:opacity-50"
            >
              {isLoading ? t('saving') : t('saveChanges')}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 sm:mt-0 sm:w-auto sm:text-sm"
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      </div>

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-60 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen pt-4 px-4 pb-20 text-center sm:block sm:p-0">
            <div className="fixed inset-0 transition-opacity bg-gray-500 bg-opacity-75" />
            <div className="inline-block align-bottom bg-white rounded-lg px-4 pt-5 pb-4 text-left overflow-hidden shadow-xl transform transition-all sm:my-8 sm:align-middle sm:max-w-lg sm:w-full sm:p-6">
              <div className="sm:flex sm:items-start">
                <div className="mx-auto flex-shrink-0 flex items-center justify-center h-12 w-12 rounded-full bg-red-100 sm:mx-0 sm:h-10 sm:w-10">
                  <TrashIcon className="h-6 w-6 text-red-600" />
                </div>
                <div className="mt-3 text-center sm:mt-0 sm:ml-4 sm:text-left">
                  <h3 className="text-lg leading-6 font-medium text-gray-900">
                    {t('deleteConfirmTitle')}
                  </h3>
                  <div className="mt-2">
                    <p className="text-sm text-gray-500">
                      {t('deleteConfirmDescription')}
                    </p>
                  </div>
                </div>
              </div>
              <div className="mt-5 sm:mt-4 sm:flex sm:flex-row-reverse">
                <button
                  type="button"
                  onClick={handleDeleteAllData}
                  className="w-full inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-red-600 text-base font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 sm:ml-3 sm:w-auto sm:text-sm"
                >
                  {t('deleteAllData')}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="mt-3 w-full inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-base font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 sm:mt-0 sm:w-auto sm:text-sm"
                >
                  {t('cancel')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CookiePreferences;