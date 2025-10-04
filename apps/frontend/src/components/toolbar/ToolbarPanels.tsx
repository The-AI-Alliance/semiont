'use client';

import React from 'react';
import { SettingsPanel } from '@/components/SettingsPanel';
import { UserPanel } from '@/components/UserPanel';
import type { ToolbarPanelType } from '@/hooks/useToolbar';

interface ToolbarPanelsProps {
  activePanel: ToolbarPanelType | null;
  /** Theme setting */
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  /** Line numbers setting */
  showLineNumbers: boolean;
  onLineNumbersToggle: () => void;
  /** Custom panel content for context-specific panels */
  children?: React.ReactNode;
  /** Panel width (default: w-80) */
  width?: string;
}

/**
 * Renders the toolbar panel container with common panels (user, settings)
 * and any context-specific panels passed as children.
 *
 * @example
 * // Simple context (compose, discover, moderate, admin pages)
 * <ToolbarPanels
 *   activePanel={activePanel}
 *   theme={theme}
 *   onThemeChange={setTheme}
 *   showLineNumbers={showLineNumbers}
 *   onLineNumbersToggle={handleLineNumbersToggle}
 * />
 *
 * @example
 * // Document context with custom panels
 * <ToolbarPanels
 *   activePanel={activePanel}
 *   theme={theme}
 *   onThemeChange={setTheme}
 *   showLineNumbers={showLineNumbers}
 *   onLineNumbersToggle={handleLineNumbersToggle}
 * >
 *   {activePanel === 'document' && <DocumentPanel ... />}
 *   {activePanel === 'detect' && <DetectPanel ... />}
 *   {activePanel === 'history' && <AnnotationHistory ... />}
 *   {activePanel === 'info' && <DocumentInfoPanel ... />}
 *   {activePanel === 'collaboration' && <CollaborationPanel ... />}
 * </ToolbarPanels>
 */
export function ToolbarPanels({
  activePanel,
  theme,
  onThemeChange,
  showLineNumbers,
  onLineNumbersToggle,
  children,
  width = 'w-80'
}: ToolbarPanelsProps) {
  // Don't render container if no panel is active
  if (!activePanel) {
    return null;
  }

  return (
    <div className={`${width} bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 overflow-y-auto p-4`}>
      {/* Custom context-specific panels */}
      {children}

      {/* User Panel - common to all contexts */}
      {activePanel === 'user' && (
        <UserPanel />
      )}

      {/* Settings Panel - common to all contexts */}
      {activePanel === 'settings' && (
        <SettingsPanel
          showLineNumbers={showLineNumbers}
          onLineNumbersToggle={onLineNumbersToggle}
          theme={theme}
          onThemeChange={onThemeChange}
        />
      )}
    </div>
  );
}
