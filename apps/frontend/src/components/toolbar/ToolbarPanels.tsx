'use client';

import React, { useTransition } from 'react';
import { SettingsPanel } from '@semiont/react-ui';
import { UserPanel } from '../UserPanel';
import { useLocale } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/routing';
import type { ToolbarPanelType } from '@semiont/react-ui';

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
 *   {activePanel === 'annotations' && <UnifiedAnnotationsPanel ... />}
 *   {activePanel === 'history' && <AnnotationHistory ... />}
 *   {activePanel === 'info' && <ResourceInfoPanel ... />}
 *   {activePanel === 'collaboration' && <CollaborationPanel ... />}
 *   {activePanel === 'jsonld' && <JsonLdPanel ... />}
 * </ToolbarPanels>
 */
export function ToolbarPanels({
  activePanel,
  theme,
  onThemeChange,
  showLineNumbers,
  onLineNumbersToggle,
  children
}: ToolbarPanelsProps) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const handleLocaleChange = (newLocale: string) => {
    if (!pathname) return;

    startTransition(() => {
      // The router from @/i18n/routing is locale-aware and will handle the locale prefix
      router.replace(pathname, { locale: newLocale });
    });
  };

  // Don't render container if no panel is active
  if (!activePanel) {
    return null;
  }

  return (
    <div className="semiont-toolbar-panels">
      {/* Custom context-specific panels */}
      <div className="semiont-toolbar-panels__content">
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
            locale={locale}
            onLocaleChange={handleLocaleChange}
            isPendingLocaleChange={isPending}
          />
        )}
      </div>
    </div>
  );
}
