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

  const buttonClass = (panel: string) =>
    `p-2 rounded-md transition-colors relative focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
      activePanel === panel
        ? 'bg-blue-200 dark:bg-blue-800/50 text-blue-700 dark:text-blue-300 border-l-4 border-blue-600 dark:border-blue-400'
        : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400'
    }`;

  return (
    <div className="w-12 h-full flex flex-col items-center gap-2 py-3 bg-gray-50 dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700">
      {/* Document Context - show document-specific panels */}
      {context === 'document' && (
        <>
          {/* Annotations Icon - unified panel for all annotation types */}
          {!isArchived && (
            <button
              onClick={() => onPanelToggle('annotations' as T)}
              className={buttonClass('annotations')}
              aria-label={t('annotations')}
              aria-pressed={activePanel === 'annotations'}
              title={t('annotations')}
            >
              <span className="text-2xl font-bold" aria-hidden="true">A</span>
            </button>
          )}

          {/* Document Info Icon */}
          <button
            onClick={() => onPanelToggle('info' as T)}
            className={buttonClass('info')}
            aria-label={t('resourceInfo')}
            aria-pressed={activePanel === 'info'}
            title={t('resourceInfo')}
          >
            <span className="text-xl" aria-hidden="true">ℹ️</span>
          </button>

          {/* History Icon */}
          <button
            onClick={() => onPanelToggle('history' as T)}
            className={buttonClass('history')}
            aria-label={t('history')}
            aria-pressed={activePanel === 'history'}
            title={t('history')}
          >
            <span className="text-xl" aria-hidden="true">📒</span>
          </button>

          {/* Collaboration Icon */}
          <button
            onClick={() => onPanelToggle('collaboration' as T)}
            className={buttonClass('collaboration')}
            aria-label={t('collaboration')}
            aria-pressed={activePanel === 'collaboration'}
            title={t('collaboration')}
          >
            <span className="text-xl" aria-hidden="true">👥</span>
          </button>

          {/* JSON-LD Icon */}
          <button
            onClick={() => onPanelToggle('jsonld' as T)}
            className={buttonClass('jsonld')}
            aria-label="JSON-LD"
            aria-pressed={activePanel === 'jsonld'}
            title="JSON-LD"
          >
            <span className="text-xl" aria-hidden="true">🌐</span>
          </button>
        </>
      )}

      {/* User Icon - always visible, appears above settings */}
      <button
        onClick={() => onPanelToggle('user' as T)}
        className={buttonClass('user')}
        aria-label={t('userAccount')}
        aria-pressed={activePanel === 'user'}
        title={t('userAccount')}
      >
        <span className="text-xl" aria-hidden="true">👤</span>
      </button>

      {/* Settings Icon - always visible without scrolling */}
      <button
        onClick={() => onPanelToggle('settings' as T)}
        className={buttonClass('settings')}
        aria-label={t('settings')}
        aria-pressed={activePanel === 'settings'}
        title={t('settings')}
      >
        <span className="text-xl" aria-hidden="true">⚙️</span>
      </button>
    </div>
  );
}
