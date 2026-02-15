'use client';

import { useTranslations } from '../contexts/TranslationContext';
import { useEventBus } from '../contexts/EventBusContext';
import './toolbar/Toolbar.css';

type ToolbarContext = 'document' | 'simple';

interface Props<T extends string = string> {
  context: ToolbarContext;
  activePanel: T | null;

  // Document context specific
  isArchived?: boolean;
}

/**
 * Toolbar component for panel navigation
 *
 * @emits panel:toggle - Toggle panel visibility. Payload: { panel: string }
 */
export function Toolbar<T extends string = string>({
  context,
  activePanel,
  isArchived = false
}: Props<T>) {
  const t = useTranslations('Toolbar');
  const eventBus = useEventBus();

  const handlePanelToggle = (panel: string) => {
    eventBus.emit('panel:toggle', { panel });
  };

  return (
    <div className="semiont-toolbar" data-context={context}>
      {/* Document Context - show document-specific panels */}
      {context === 'document' && (
        <>
          {/* Annotations Icon - unified panel for all annotation types */}
          {!isArchived && (
            <button
              onClick={() => handlePanelToggle('annotations')}
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
            onClick={() => handlePanelToggle('info')}
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
            onClick={() => handlePanelToggle('history')}
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
            onClick={() => handlePanelToggle('collaboration')}
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
            onClick={() => handlePanelToggle('jsonld')}
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
        onClick={() => handlePanelToggle('user')}
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
        onClick={() => handlePanelToggle('settings')}
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
