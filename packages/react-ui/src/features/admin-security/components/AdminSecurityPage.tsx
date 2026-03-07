/**
 * AdminSecurityPage Component
 *
 * Pure React component for the admin security configuration page.
 * All dependencies passed as props - no Next.js hooks!
 */

import React from 'react';
import {
  ShieldCheckIcon,
  GlobeAltIcon,
  CheckCircleIcon,
  InformationCircleIcon
} from '@heroicons/react/24/outline';
import { COMMON_PANELS, type ToolbarPanelType } from '../../../hooks/usePanelBrowse';

export interface OAuthProvider {
  name: string;
  clientId?: string;
}

export interface AdminSecurityPageProps {
  // Data props
  providers: OAuthProvider[];
  allowedDomains: string[];
  isLoading: boolean;

  // UI state
  theme: 'light' | 'dark' | 'system';
  showLineNumbers: boolean;
  activePanel: string | null;

  // Translations
  translations: {
    title: string;
    subtitle: string;
    oauthProviders: string;
    oauthProvidersDescription: string;
    clientId: string;
    configured: string;
    noProvidersConfigured: string;
    allowedDomains: string;
    allowedDomainsDescription: string;
    noDomainsConfigured: string;
    configManagementTitle: string;
    configManagementDescription: string;
    configLocalDev: string;
    configCloudDeploy: string;
    configCloudDeployCommand: string;
    configCloudDeployEnd: string;
    configAWS: string;
  };

  // Component dependencies
  ToolbarPanels: React.ComponentType<any>;
  Toolbar: React.ComponentType<any>;
}

export function AdminSecurityPage({
  providers,
  allowedDomains,
  isLoading,
  theme,
  showLineNumbers,
  activePanel,
  translations: t,
  ToolbarPanels,
  Toolbar,
}: AdminSecurityPageProps) {
  return (
    <div className={`semiont-page${activePanel && COMMON_PANELS.includes(activePanel as ToolbarPanelType) ? ' semiont-page--panel-open' : ''}`}>
      {/* Main Content Area */}
      <div className="semiont-page__content">
        <div className="semiont-page__sections">
          {/* Page Header */}
          <div className="semiont-page__header">
            <h1 className="semiont-page__title">{t.title}</h1>
            <p className="semiont-page__subtitle">
              {t.subtitle}
            </p>
          </div>

          {/* OAuth Providers */}
          <div className="semiont-admin__card">
            <div className="semiont-admin__card-header">
              <ShieldCheckIcon className="semiont-admin__card-icon semiont-admin__card-icon--primary" />
              <div>
                <h3 className="semiont-admin__card-title">{t.oauthProviders}</h3>
                <p className="semiont-admin__card-description">{t.oauthProvidersDescription}</p>
              </div>
            </div>

            {isLoading ? (
              <div className="semiont-skeleton-group">
                <div className="semiont-skeleton semiont-skeleton--bar"></div>
              </div>
            ) : providers.length > 0 ? (
              <div className="semiont-provider-list">
                {providers.map((provider) => (
                  <div key={provider.name} className="semiont-provider-item">
                    <div className="semiont-provider-item__info">
                      <CheckCircleIcon className="semiont-provider-item__icon semiont-provider-item__icon--success" />
                      <span className="semiont-provider-item__name">
                        {provider.name}
                      </span>
                      {provider.clientId && (
                        <span className="semiont-provider-item__client-id">
                          {t.clientId}: {provider.clientId}
                        </span>
                      )}
                    </div>
                    <span className="semiont-badge semiont-badge--success">
                      {t.configured}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="semiont-empty-message">
                {t.noProvidersConfigured}
              </div>
            )}
          </div>

          {/* Allowed Domains */}
          <div className="semiont-admin__card">
            <div className="semiont-admin__card-header">
              <GlobeAltIcon className="semiont-admin__card-icon semiont-admin__card-icon--primary" />
              <div>
                <h3 className="semiont-admin__card-title">{t.allowedDomains}</h3>
                <p className="semiont-admin__card-description">{t.allowedDomainsDescription}</p>
              </div>
            </div>

            {isLoading ? (
              <div className="semiont-skeleton-group">
                <div className="semiont-skeleton semiont-skeleton--chip"></div>
                <div className="semiont-skeleton semiont-skeleton--chip semiont-skeleton--chip-lg"></div>
              </div>
            ) : allowedDomains.length > 0 ? (
              <div className="semiont-domain-list">
                {allowedDomains.map((domain) => (
                  <div key={domain} className="semiont-chip semiont-chip--primary">
                    @{domain}
                  </div>
                ))}
              </div>
            ) : (
              <div className="semiont-empty-message">
                {t.noDomainsConfigured}
              </div>
            )}
          </div>

          {/* Configuration Info */}
          <div className="semiont-admin__info-box">
            <div className="semiont-info-box__content">
              <InformationCircleIcon className="semiont-info-box__icon" />
              <div className="semiont-info-box__text">
                <p className="semiont-info-box__title">{t.configManagementTitle}</p>
                <p className="semiont-info-box__description">
                  {t.configManagementDescription}
                </p>
                <ul className="semiont-info-box__list">
                  <li>{t.configLocalDev}</li>
                  <li>{t.configCloudDeploy} <code className="semiont-code-inline">{t.configCloudDeployCommand}</code> {t.configCloudDeployEnd}</li>
                  <li>{t.configAWS}</li>
                </ul>
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
