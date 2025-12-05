'use client';

import React from 'react';
import { useTranslations } from 'next-intl';

type ToolbarPanel = 'document' | 'history' | 'info' | 'references' | 'settings' | 'collaboration' | 'user' | 'jsonld' | 'comments' | 'highlights' | 'assessments' | 'tags';
type ToolbarContext = 'document' | 'simple';

interface Props<T extends string = string> {
  context: ToolbarContext;
  activePanel: T | null;
  onPanelToggle: (panel: T) => void;

  // Annotate mode - always available
  annotateMode?: boolean;
  onAnnotateModeToggle?: () => void;

  // Document context specific
  isArchived?: boolean;
}

export function Toolbar<T extends string = string>({
  context,
  activePanel,
  onPanelToggle,
  annotateMode = false,
  onAnnotateModeToggle,
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
      {/* Annotate Mode Toggle - always at top if handlers provided */}
      {onAnnotateModeToggle && (
        <>
          <button
            onClick={onAnnotateModeToggle}
            className={`p-2 rounded-md transition-colors relative focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
              annotateMode
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-gray-300 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-400 dark:hover:bg-gray-600'
            }`}
            aria-label={annotateMode ? t('switchToBrowse') : t('switchToAnnotate')}
            title={annotateMode ? t('browseMode') : t('annotateMode')}
          >
            <span className="text-xl" aria-hidden="true">{annotateMode ? '✏️' : '📖'}</span>
          </button>

          {/* Divider after toggle */}
          <div className="w-8 border-t border-gray-300 dark:border-gray-600 my-1"></div>
        </>
      )}

      {/* Document Context - show document-specific panels */}
      {context === 'document' && (
        <>
          {/* Document Icon */}
          <button
            onClick={() => onPanelToggle('document' as T)}
            className={buttonClass('document')}
            aria-label={t('resource')}
            aria-pressed={activePanel === 'document'}
            title={t('resource')}
          >
            <span className="text-xl" aria-hidden="true">📄</span>
          </button>

          {/* References Icon - show in both Browse and Annotate modes (not archived) */}
          {!isArchived && (
            <button
              onClick={() => onPanelToggle('references' as T)}
              className={buttonClass('references')}
              aria-label={t('detectReferences')}
              aria-pressed={activePanel === 'references'}
              title={t('detectReferences')}
            >
              <span className="text-xl" aria-hidden="true">🔵</span>
            </button>
          )}

          {/* Highlights Icon - show in both Browse and Annotate modes (not archived) */}
          {!isArchived && (
            <button
              onClick={() => onPanelToggle('highlights' as T)}
              className={buttonClass('highlights')}
              aria-label={t('highlights')}
              aria-pressed={activePanel === 'highlights'}
              title={t('highlights')}
            >
              <span className="text-xl" aria-hidden="true">🟡</span>
            </button>
          )}

          {/* Assessments Icon - show in both Browse and Annotate modes (not archived) */}
          {!isArchived && (
            <button
              onClick={() => onPanelToggle('assessments' as T)}
              className={buttonClass('assessments')}
              aria-label={t('assessments')}
              aria-pressed={activePanel === 'assessments'}
              title={t('assessments')}
            >
              <span className="text-xl" aria-hidden="true">🔴</span>
            </button>
          )}

          {/* Comments Icon */}
          <button
            onClick={() => onPanelToggle('comments' as T)}
            className={buttonClass('comments')}
            aria-label={t('comments')}
            aria-pressed={activePanel === 'comments'}
            title={t('comments')}
          >
            <span className="text-xl" aria-hidden="true">💬</span>
          </button>

          {/* Tags Icon - show in both Browse and Annotate modes (not archived) */}
          {!isArchived && (
            <button
              onClick={() => onPanelToggle('tags' as T)}
              className={buttonClass('tags')}
              aria-label={t('tags')}
              aria-pressed={activePanel === 'tags'}
              title={t('tags')}
            >
              <span className="text-xl" aria-hidden="true">🏷️</span>
            </button>
          )}

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
