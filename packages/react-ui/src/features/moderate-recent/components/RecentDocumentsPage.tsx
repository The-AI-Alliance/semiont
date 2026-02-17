/**
 * RecentDocumentsPage Component
 *
 * Pure React component for viewing recent documents.
 * All dependencies passed as props - no Next.js hooks!
 */

import React from 'react';
import { ClockIcon } from '@heroicons/react/24/outline';

export interface RecentDocumentsPageProps {
  // Data props
  hasDocuments: boolean;
  isLoading: boolean;

  // UI state
  theme: 'light' | 'dark' | 'system';
  showLineNumbers: boolean;
  activePanel: string | null;

  // Translations
  translations: {
    pageTitle: string;
    pageDescription: string;
    sectionTitle: string;
    sectionDescription: string;
    noDocuments: string;
    activityWillAppear: string;
    loading: string;
  };

  // Component dependencies
  ToolbarPanels: React.ComponentType<any>;
  Toolbar: React.ComponentType<any>;
}

export function RecentDocumentsPage({
  isLoading,
  theme,
  showLineNumbers,
  activePanel,
  translations: t,
  ToolbarPanels,
  Toolbar,
}: RecentDocumentsPageProps) {

  if (isLoading) {
    return (
      <div className="semiont-page__loading">
        <p className="semiont-page__loading-text">{t.loading}</p>
      </div>
    );
  }

  return (
    <div className={`semiont-page${activePanel ? ' semiont-page--panel-open' : ''}`}>
      {/* Main Content Area */}
      <div className="semiont-page__content">
        {/* Page Title */}
        <div className="semiont-page__header">
          <h1 className="semiont-page__title">{t.pageTitle}</h1>
          <p className="semiont-page__subtitle">
            {t.pageDescription}
          </p>
        </div>

        {/* Recent Documents Section */}
        <div className="semiont-card">
          <div className="semiont-recent-docs__header">
            <div className="semiont-recent-docs__icon-box">
              <ClockIcon className="semiont-recent-docs__icon" />
            </div>
            <div className="semiont-recent-docs__content">
              <h3 className="semiont-recent-docs__title">{t.sectionTitle}</h3>
              <p className="semiont-recent-docs__description">
                {t.sectionDescription}
              </p>
            </div>
          </div>

          <div className="semiont-recent-docs__empty-state">
            <svg className="semiont-recent-docs__empty-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="semiont-recent-docs__empty-message">{t.noDocuments}</p>
            <p className="semiont-recent-docs__empty-hint">
              {t.activityWillAppear}
            </p>
          </div>
        </div>
      </div>

      {/* Right Sidebar - Panels and Toolbar */}
      <div className="semiont-page__sidebar">
        <ToolbarPanels
          activePanel={activePanel}
          theme={theme}
          showLineNumbers={showLineNumbers}
        />

        <Toolbar
          context="simple"
          activePanel={activePanel}
        />
      </div>
    </div>
  );
}
