'use client';

import React from 'react';

type ToolbarPanel = 'history' | 'info' | 'detect' | 'settings' | 'collaboration';

interface Props {
  activePanel: ToolbarPanel | null;
  annotateMode: boolean;
  isArchived: boolean;
  onPanelToggle: (panel: ToolbarPanel) => void;
}

export function DocumentToolbar({
  activePanel,
  annotateMode,
  isArchived,
  onPanelToggle
}: Props) {
  const buttonClass = (panel: ToolbarPanel) =>
    `p-2 rounded-md transition-colors relative focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
      activePanel === panel
        ? 'bg-blue-200 dark:bg-blue-800/50 text-blue-700 dark:text-blue-300 border-l-4 border-blue-600 dark:border-blue-400'
        : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400'
    }`;

  return (
    <div className="w-12 flex flex-col items-center gap-2 py-3 bg-gray-50 dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700">
      {/* Detect Icon - only show in Annotate Mode */}
      {annotateMode && !isArchived && (
        <button
          onClick={() => onPanelToggle('detect')}
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
        onClick={() => onPanelToggle('history')}
        className={buttonClass('history')}
        aria-label="History"
        aria-pressed={activePanel === 'history'}
        title="History"
      >
        <span className="text-xl" aria-hidden="true">📒</span>
      </button>

      {/* Document Info Icon */}
      <button
        onClick={() => onPanelToggle('info')}
        className={buttonClass('info')}
        aria-label="Document Information"
        aria-pressed={activePanel === 'info'}
        title="Document Info"
      >
        <span className="text-xl" aria-hidden="true">ℹ️</span>
      </button>

      {/* Collaboration Icon */}
      <button
        onClick={() => onPanelToggle('collaboration')}
        className={buttonClass('collaboration')}
        aria-label="Collaboration"
        aria-pressed={activePanel === 'collaboration'}
        title="Collaboration"
      >
        <span className="text-xl" aria-hidden="true">👥</span>
      </button>

      {/* Settings Icon */}
      <button
        onClick={() => onPanelToggle('settings')}
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
