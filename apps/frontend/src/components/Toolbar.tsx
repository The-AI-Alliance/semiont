'use client';

import React from 'react';

type ToolbarPanel = 'document' | 'history' | 'info' | 'detect' | 'settings' | 'collaboration';
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
            aria-label={annotateMode ? 'Switch to Browse Mode' : 'Switch to Annotate Mode'}
            title={annotateMode ? 'Browse Mode' : 'Annotate Mode'}
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
            aria-label="Document"
            aria-pressed={activePanel === 'document'}
            title="Document"
          >
            <span className="text-xl" aria-hidden="true">📄</span>
          </button>

          {/* Detect Icon - only show in Annotate Mode and not archived */}
          {annotateMode && !isArchived && (
            <button
              onClick={() => onPanelToggle('detect' as T)}
              className={buttonClass('detect')}
              aria-label="Detect References"
              aria-pressed={activePanel === 'detect'}
              title="Detect References"
            >
              <span className="text-xl" aria-hidden="true">🔵</span>
            </button>
          )}

          {/* History Icon */}
          <button
            onClick={() => onPanelToggle('history' as T)}
            className={buttonClass('history')}
            aria-label="History"
            aria-pressed={activePanel === 'history'}
            title="History"
          >
            <span className="text-xl" aria-hidden="true">📒</span>
          </button>

          {/* Document Info Icon */}
          <button
            onClick={() => onPanelToggle('info' as T)}
            className={buttonClass('info')}
            aria-label="Document Information"
            aria-pressed={activePanel === 'info'}
            title="Document Info"
          >
            <span className="text-xl" aria-hidden="true">ℹ️</span>
          </button>

          {/* Collaboration Icon */}
          <button
            onClick={() => onPanelToggle('collaboration' as T)}
            className={buttonClass('collaboration')}
            aria-label="Collaboration"
            aria-pressed={activePanel === 'collaboration'}
            title="Collaboration"
          >
            <span className="text-xl" aria-hidden="true">👥</span>
          </button>
        </>
      )}

      {/* Settings Icon - always visible without scrolling */}
      <button
        onClick={() => onPanelToggle('settings' as T)}
        className={buttonClass('settings')}
        aria-label="Settings"
        aria-pressed={activePanel === 'settings'}
        title="Settings"
      >
        <span className="text-xl" aria-hidden="true">⚙️</span>
      </button>
    </div>
  );
}
