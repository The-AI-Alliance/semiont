/**
 * AdminDevOpsPage Component
 *
 * Pure React component for the admin devops page.
 * All dependencies passed as props - no Next.js hooks!
 */

import React from 'react';
import {
  CommandLineIcon
} from '@heroicons/react/24/outline';

export interface DevOpsFeature {
  title: string;
  description: string;
  icon: React.ComponentType<any>;
  available: string;
}

export interface AdminDevOpsPageProps {
  // Data props
  suggestedFeatures: DevOpsFeature[];

  // UI state
  theme: 'light' | 'dark' | 'system';
  showLineNumbers: boolean;
  activePanel: string | null;

  // Translations
  translations: {
    title: string;
    subtitle: string;
    systemStatus: string;
    cliOperations: string;
    cliOperationsDescription: string;
    cliTitle: string;
    cliDescription: string;
  };

  // Component dependencies
  StatusDisplay: React.ComponentType<any>;
  ToolbarPanels: React.ComponentType<any>;
  Toolbar: React.ComponentType<any>;
}

export function AdminDevOpsPage({
  suggestedFeatures,
  theme,
  showLineNumbers,
  activePanel,
  translations: t,
  StatusDisplay,
  ToolbarPanels,
  Toolbar,
}: AdminDevOpsPageProps) {
  return (
    <div className={`semiont-page${activePanel ? ' semiont-page--panel-open' : ''}`}>
      {/* Main Content Area */}
      <div className="semiont-page__content">
        {/* Page Title */}
        <div className="semiont-page__header">
          <h1 className="semiont-page__title">{t.title}</h1>
          <p className="semiont-page__subtitle">
            {t.subtitle}
          </p>
        </div>

        {/* System Status */}
        <div className="semiont-admin__section">
          <h2 className="semiont-admin__section-title">{t.systemStatus}</h2>
          <StatusDisplay />
        </div>

        {/* CLI Operations */}
        <div className="semiont-admin__section">
          <h2 className="semiont-admin__section-title">{t.cliOperations}</h2>
          <p className="semiont-admin__section-description">
            {t.cliOperationsDescription}
          </p>
          <div className="semiont-admin__features-grid">
            {suggestedFeatures.map((feature) => (
              <div
                key={feature.title}
                className="semiont-devops-feature"
              >
                <div className="semiont-devops-feature__header">
                  <div className="semiont-devops-feature__icon-box">
                    <feature.icon className="semiont-devops-feature__icon" />
                  </div>
                  <div className="semiont-devops-feature__content">
                    <h3 className="semiont-devops-feature__title">
                      {feature.title}
                    </h3>
                    <p className="semiont-devops-feature__description">
                      {feature.description}
                    </p>
                    <p className="semiont-devops-feature__available">
                      {feature.available}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Info Box */}
        <div className="semiont-admin__info-box">
          <div className="semiont-admin__info-box-content">
            <div className="semiont-admin__info-box-icon">
              <CommandLineIcon className="semiont-icon semiont-icon--info" />
            </div>
            <div className="semiont-admin__info-box-text">
              <h3 className="semiont-admin__info-box-title">
                {t.cliTitle}
              </h3>
              <div className="semiont-admin__info-box-description">
                <p>
                  {t.cliDescription}
                </p>
                <code className="semiont-admin__info-box-code">
                  semiont --help
                </code>
              </div>
            </div>
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
