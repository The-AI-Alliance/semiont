'use client';

import React from 'react';

type ToolbarPanel = 'settings';

interface Props {
  activePanel: ToolbarPanel | null;
  onPanelToggle: (panel: ToolbarPanel) => void;
}

export function SimpleToolbar({
  activePanel,
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
