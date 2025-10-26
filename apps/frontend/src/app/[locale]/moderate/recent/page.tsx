'use client';

import { notFound } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  ClockIcon
} from '@heroicons/react/24/outline';
import { Toolbar } from '@/components/Toolbar';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { useTheme } from '@/hooks/useTheme';
import { useToolbar } from '@/hooks/useToolbar';
import { useLineNumbers } from '@/hooks/useLineNumbers';

export default function RecentDocumentsPage() {
  const t = useTranslations('ModerateRecent');
  const { data: session, status } = useSession();

  // Toolbar and settings state
  const { activePanel, togglePanel } = useToolbar();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  // Check authentication and moderator/admin status
  useEffect(() => {
    if (status === 'loading') return;
    if (status === 'unauthenticated') {
      notFound();
    }
    if (!session?.backendUser?.isModerator && !session?.backendUser?.isAdmin) {
      notFound();
    }
  }, [status, session]);

  // Show loading while checking session
  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">{t('loading')}</p>
      </div>
    );
  }

  // Show nothing if not moderator/admin (will be handled by notFound)
  if (!session?.backendUser?.isModerator && !session?.backendUser?.isAdmin) {
    return null;
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-4 py-8">
        {/* Page Title */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('pageTitle')}</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            {t('pageDescription')}
          </p>
        </div>

        {/* Recent Documents Section */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-start mb-4">
            <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gray-100 dark:bg-gray-900/20 mr-3">
              <ClockIcon className="w-6 h-6 text-gray-600 dark:text-gray-400" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('sectionTitle')}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                {t('sectionDescription')}
              </p>
            </div>
          </div>

          <div className="text-center py-12">
            <svg className="w-16 h-16 text-gray-300 dark:text-gray-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-gray-500 dark:text-gray-400">{t('noDocuments')}</p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
              {t('activityWillAppear')}
            </p>
          </div>
        </div>
      </div>

      {/* Right Sidebar - Panels and Toolbar */}
      <div className="flex">
        {/* Panels Container */}
        <ToolbarPanels
          activePanel={activePanel}
          theme={theme}
          onThemeChange={setTheme}
          showLineNumbers={showLineNumbers}
          onLineNumbersToggle={toggleLineNumbers}
        />

        <Toolbar
          context="simple"
          activePanel={activePanel}
          onPanelToggle={togglePanel}
        />
      </div>
    </div>
  );
}
