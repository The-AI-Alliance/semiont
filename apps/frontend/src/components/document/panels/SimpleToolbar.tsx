'use client';

import React from 'react';

type ToolbarPanel = 'settings';

interface Props {
  activePanel: ToolbarPanel | null;
  onPanelToggle: (panel: ToolbarPanel) => void;
  annotateMode: boolean;
  onAnnotateModeToggle: () => void;
}

export function SimpleToolbar({
  activePanel,
  onPanelToggle,
  annotateMode,
  onAnnotateModeToggle
}: Props) {
  const buttonClass = (panel: ToolbarPanel) =>
    `p-2 rounded-md transition-colors relative focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${
      activePanel === panel
        ? 'bg-blue-200 dark:bg-blue-800/50 text-blue-700 dark:text-blue-300 border-l-4 border-blue-600 dark:border-blue-400'
        : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400'
    }`;

  return (
    <div className="w-12 flex flex-col items-center gap-2 py-3 bg-gray-50 dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700">
      {/* Annotate Mode Toggle */}
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

      {/* Divider */}
      <div className="w-8 border-t border-gray-300 dark:border-gray-600 my-1"></div>

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
