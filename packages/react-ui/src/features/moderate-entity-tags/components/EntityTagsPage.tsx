/**
 * EntityTagsPage Component
 *
 * Pure React component for managing entity tags.
 * All dependencies passed as props - no Next.js hooks!
 */

import React from 'react';
import {
  TagIcon,
  PlusIcon,
  ExclamationCircleIcon
} from '@heroicons/react/24/outline';
import { COMMON_PANELS, type ToolbarPanelType } from '../../../hooks/usePanelNavigation';

export interface EntityTagsPageProps {
  // Data props
  entityTypes: string[];
  isLoading: boolean;
  error: string;

  // Tag input state
  newTag: string;
  onNewTagChange: (value: string) => void;

  // Actions
  onAddTag: () => void;
  isAddingTag: boolean;

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
    inputPlaceholder: string;
    addTag: string;
    adding: string;
  };

  // Component dependencies
  ToolbarPanels: React.ComponentType<any>;
  Toolbar: React.ComponentType<any>;
}

export function EntityTagsPage({
  entityTypes,
  error,
  newTag,
  onNewTagChange,
  onAddTag,
  isAddingTag,
  theme,
  showLineNumbers,
  activePanel,
  translations: t,
  ToolbarPanels,
  Toolbar,
}: EntityTagsPageProps) {

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onAddTag();
    }
  };

  return (
    <div className={`semiont-page${activePanel && COMMON_PANELS.includes(activePanel as ToolbarPanelType) ? ' semiont-page--panel-open' : ''}`}>
      {/* Main Content Area */}
      <div className="semiont-page__content">
        {/* Page Title */}
        <div className="semiont-page__header">
          <h1 className="semiont-page__title">{t.pageTitle}</h1>
          <p className="semiont-page__subtitle">
            {t.pageDescription}
          </p>
        </div>

        {/* Entity Tags Management */}
        <div className="semiont-card">
          <div className="semiont-entity-tags__header">
            <div className="semiont-entity-tags__icon-box">
              <TagIcon className="semiont-entity-tags__icon" />
            </div>
            <div className="semiont-entity-tags__content">
              <h3 className="semiont-entity-tags__title">{t.sectionTitle}</h3>
              <p className="semiont-entity-tags__description">
                {t.sectionDescription}
              </p>
            </div>
          </div>

          {/* Existing tags */}
          <div className="semiont-entity-tags__tags-section">
            <div className="semiont-tags">
              {entityTypes.map((tag: string) => (
                <span
                  key={tag}
                  className="semiont-tag semiont-tag--info semiont-tag--rounded-md"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>

          {/* Add new tag */}
          <div className="semiont-entity-tags__input-group">
            <input
              type="text"
              value={newTag}
              onChange={(e) => onNewTagChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t.inputPlaceholder}
              className="semiont-entity-tags__input"
              disabled={isAddingTag}
            />
            <button
              onClick={onAddTag}
              disabled={isAddingTag || !newTag.trim()}
              className="semiont-button semiont-button--primary"
            >
              {isAddingTag ? (
                t.adding
              ) : (
                <>
                  <PlusIcon className="semiont-icon semiont-icon--small semiont-icon--inline" />
                  {t.addTag}
                </>
              )}
            </button>
          </div>

          {/* Error message */}
          {error && (
            <div className="semiont-entity-tags__error">
              <ExclamationCircleIcon className="semiont-entity-tags__error-icon" />
              {error}
            </div>
          )}
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
