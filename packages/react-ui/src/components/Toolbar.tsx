'use client';

import React from 'react';
import { useTranslations } from '../contexts/TranslationContext';

type ToolbarPanel = 'history' | 'info' | 'annotations' | 'settings' | 'collaboration' | 'user' | 'jsonld';
type ToolbarContext = 'document' | 'simple';

interface Props<T extends string = string> {
  context: ToolbarContext;
  activePanel: T | null;
  onPanelToggle: (panel: T) => void;

  // Document context specific
  isArchived?: boolean;
}

export function Toolbar<T extends string = string>({
  context,
  activePanel,
  onPanelToggle,
  isArchived = false
}: Props<T>) {
  const t = useTranslations('Toolbar');

  return (
    <div className="semiont-toolbar" data-context={context}>
      {/* Document Context - show document-specific panels */}
      {context === 'document' && (
        <>
          {/* Annotations Icon - unified panel for all annotation types */}
          {!isArchived && (
            <button
              onClick={() => onPanelToggle('annotations' as T)}
              className="semiont-toolbar-button"
              data-active={activePanel === 'annotations'}
              data-panel="annotations"
              aria-label={t('annotations')}
              aria-pressed={activePanel === 'annotations'}
              title={t('annotations')}
            >
              <span className="semiont-toolbar-icon semiont-toolbar-icon-large" aria-hidden="true">A</span>
            </button>
          )}

          {/* Document Info Icon */}
          <button
            onClick={() => onPanelToggle('info' as T)}
            className="semiont-toolbar-button"
            data-active={activePanel === 'info'}
            data-panel="info"
            aria-label={t('resourceInfo')}
            aria-pressed={activePanel === 'info'}
            title={t('resourceInfo')}
          >
            <span className="semiont-toolbar-icon" aria-hidden="true">ℹ️</span>
          </button>

          {/* History Icon */}
          <button
            onClick={() => onPanelToggle('history' as T)}
            className="semiont-toolbar-button"
            data-active={activePanel === 'history'}
            data-panel="history"
            aria-label={t('history')}
            aria-pressed={activePanel === 'history'}
            title={t('history')}
          >
            <span className="semiont-toolbar-icon" aria-hidden="true">📒</span>
          </button>

          {/* Collaboration Icon */}
          <button
            onClick={() => onPanelToggle('collaboration' as T)}
            className="semiont-toolbar-button"
            data-active={activePanel === 'collaboration'}
            data-panel="collaboration"
            aria-label={t('collaboration')}
            aria-pressed={activePanel === 'collaboration'}
            title={t('collaboration')}
          >
            <span className="semiont-toolbar-icon" aria-hidden="true">👥</span>
          </button>

          {/* JSON-LD Icon */}
          <button
            onClick={() => onPanelToggle('jsonld' as T)}
            className="semiont-toolbar-button"
            data-active={activePanel === 'jsonld'}
            data-panel="jsonld"
            aria-label="JSON-LD"
            aria-pressed={activePanel === 'jsonld'}
            title="JSON-LD"
          >
            <span className="semiont-toolbar-icon" aria-hidden="true">🌐</span>
          </button>
        </>
      )}

      {/* User Icon - always visible, appears above settings */}
      <button
        onClick={() => onPanelToggle('user' as T)}
        className="semiont-toolbar-button"
        data-active={activePanel === 'user'}
        data-panel="user"
        aria-label={t('userAccount')}
        aria-pressed={activePanel === 'user'}
        title={t('userAccount')}
      >
        <span className="semiont-toolbar-icon" aria-hidden="true">👤</span>
      </button>

      {/* Settings Icon - always visible without scrolling */}
      <button
        onClick={() => onPanelToggle('settings' as T)}
        className="semiont-toolbar-button"
        data-active={activePanel === 'settings'}
        data-panel="settings"
        aria-label={t('settings')}
        aria-pressed={activePanel === 'settings'}
        title={t('settings')}
      >
        <span className="semiont-toolbar-icon" aria-hidden="true">⚙️</span>
      </button>
    </div>
  );
}
