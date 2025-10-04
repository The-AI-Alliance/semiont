'use client';

import { notFound } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useEffect, useState, useCallback } from 'react';
import {
  ClockIcon
} from '@heroicons/react/24/outline';
import { Toolbar } from '@/components/Toolbar';
import { SettingsPanel } from '@/components/SettingsPanel';
import { UserPanel } from '@/components/UserPanel';import { useTheme } from '@/hooks/useTheme';

export default function RecentDocumentsPage() {
  const { data: session, status } = useSession();

  // Toolbar and settings state
  const [activeToolbarPanel, setActiveToolbarPanel] = useState<'settings' | 'user' | null>(null);
  const [annotateMode, setAnnotateMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('annotateMode') === 'true';
    }
    return false;
  });
  const [showLineNumbers, setShowLineNumbers] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('showLineNumbers') === 'true';
    }
    return false;
  });
  const { theme, setTheme } = useTheme();

  // Toolbar handlers
  const handleToolbarPanelToggle = useCallback((panel: 'settings') => {
    setActiveToolbarPanel(current => current === panel ? null : panel);
  }, []);

  const handleAnnotateModeToggle = useCallback(() => {
    const newMode = !annotateMode;
    setAnnotateMode(newMode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('annotateMode', newMode.toString());
    }
  }, [annotateMode]);

  const handleLineNumbersToggle = useCallback(() => {
    const newMode = !showLineNumbers;
    setShowLineNumbers(newMode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('showLineNumbers', newMode.toString());
    }
  }, [showLineNumbers]);

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
        <p className="text-gray-600 dark:text-gray-300">Loading...</p>
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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Recent Documents</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            Monitor recent document submissions and modifications across the platform.
          </p>
        </div>

        {/* Recent Documents Section */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-start mb-4">
            <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-gray-100 dark:bg-gray-900/20 mr-3">
              <ClockIcon className="w-6 h-6 text-gray-600 dark:text-gray-400" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Document Activity</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                View and review recently added or modified documents
              </p>
            </div>
          </div>

          <div className="text-center py-12">
            <svg className="w-16 h-16 text-gray-300 dark:text-gray-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-gray-500 dark:text-gray-400">No recent documents</p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">
              Document activity will appear here as users submit new content
            </p>
          </div>
        </div>
      </div>

      {/* Right Sidebar - Panels and Toolbar */}
      <div className="flex">
        {/* Panels Container */}
        {activeToolbarPanel && (
          <div className="w-80 bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 overflow-y-auto p-4">
            {/* User Panel */}
            {activeToolbarPanel === 'user' && (
              <UserPanel />
            )}

            {/* Settings Panel */}
            {activeToolbarPanel === 'settings' && (
              <SettingsPanel
                showLineNumbers={showLineNumbers}
                onLineNumbersToggle={handleLineNumbersToggle}
                theme={theme}
                onThemeChange={setTheme}
              />
            )}
          </div>
        )}

        {/* Toolbar - Always visible on the right */}
        <Toolbar
          context="simple"
          activePanel={activeToolbarPanel}
          onPanelToggle={handleToolbarPanelToggle}
        />
      </div>
    </div>
  );
}
