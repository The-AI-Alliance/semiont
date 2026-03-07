/**
 * TagSchemasPage Component
 *
 * Pure React component for viewing tag schemas.
 * All dependencies passed as props - no Next.js hooks!
 */

import React from 'react';
import {
  AcademicCapIcon,
  ScaleIcon,
  LightBulbIcon
} from '@heroicons/react/24/outline';
import { COMMON_PANELS, type ToolbarPanelType } from '../../../hooks/usePanelBrowse';
import type { TagSchema } from '@semiont/react-ui';

export interface TagSchemasPageProps {
  // Data props
  schemas: TagSchema[];
  isLoading: boolean;

  // UI state
  theme: 'light' | 'dark' | 'system';
  showLineNumbers: boolean;
  activePanel: string | null;

  // Translations
  translations: {
    pageTitle: string;
    pageDescription: string;
    categories: string;
    loading: string;
  };

  // Component dependencies
  ToolbarPanels: React.ComponentType<any>;
  Toolbar: React.ComponentType<any>;
}

const domainIcons: Record<string, React.ComponentType<any>> = {
  legal: ScaleIcon,
  scientific: AcademicCapIcon,
  general: LightBulbIcon
};

const domainClasses = {
  legal: 'semiont-schema-domain--legal',
  scientific: 'semiont-schema-domain--scientific',
  general: 'semiont-schema-domain--general'
};

export function TagSchemasPage({
  schemas,
  isLoading,
  theme,
  showLineNumbers,
  activePanel,
  translations: t,
  ToolbarPanels,
  Toolbar,
}: TagSchemasPageProps) {

  if (isLoading) {
    return (
      <div className="semiont-page__loading">
        <p className="semiont-page__loading-text">{t.loading}</p>
      </div>
    );
  }

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

        {/* Schemas Grid */}
        <div className="semiont-card-grid semiont-card-grid--two-columns">
          {schemas.map((schema) => {
            const Icon = domainIcons[schema.domain] || LightBulbIcon;
            const domainClass = domainClasses[schema.domain] || domainClasses.general;

            return (
              <div
                key={schema.id}
                className="semiont-card"
              >
                {/* Schema Header */}
                <div className="semiont-schema__header">
                  <div className={`semiont-schema__icon-wrapper ${domainClass}`}>
                    {Icon && <Icon className="semiont-schema__icon" />}
                  </div>
                  <div className="semiont-schema__content">
                    <h3 className="semiont-schema__title">{schema.name}</h3>
                    <p className="semiont-schema__description">
                      {schema.description}
                    </p>
                    <span className={`semiont-schema__badge ${domainClass}`}>
                      {schema.domain}
                    </span>
                  </div>
                </div>

                {/* Categories */}
                <div className="semiont-schema__categories">
                  <h4 className="semiont-schema__categories-title">
                    {t.categories}
                  </h4>
                  {schema.tags.map((tag) => (
                    <div
                      key={tag.name}
                      className="semiont-schema__category"
                    >
                      <div className="semiont-schema__category-name">
                        {tag.name}
                      </div>
                      <div className="semiont-schema__category-description">
                        {tag.description}
                      </div>
                      <div className="semiont-schema__examples">
                        {tag.examples.slice(0, 2).map((example, idx) => (
                          <span
                            key={idx}
                            className="semiont-schema__example"
                          >
                            {example}
                          </span>
                        ))}
                        {tag.examples.length > 2 && (
                          <span className="semiont-schema__example-more">
                            +{tag.examples.length - 2} more
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
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
