'use client';

import React, { useTransition, useEffect } from 'react';
import { SettingsPanel, ResizeHandle, usePanelWidth, EventBusProvider, useEventSubscriptions } from '@semiont/react-ui';
import { UserPanel } from '../UserPanel';
import { useLocale } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/routing';
import type { ToolbarPanelType } from '@semiont/react-ui';

interface ToolbarPanelsProps {
  activePanel: ToolbarPanelType | null;
  /** Theme setting */
  theme: 'light' | 'dark' | 'system';
  /** Line numbers setting */
  showLineNumbers: boolean;
  /** Custom panel content for context-specific panels */
  children?: React.ReactNode;
}

/**
 * Renders the toolbar panel container with common panels (user, settings)
 * and any context-specific panels passed as children.
 *
 * Settings changes are handled via GlobalSettingsEventBus - no callbacks needed.
 *
 * @example
 * // Simple context (compose, discover, moderate, admin pages)
 * <ToolbarPanels
 *   activePanel={activePanel}
 *   theme={theme}
 *   showLineNumbers={showLineNumbers}
 * />
 *
 * @example
 * // Document context with custom panels
 * <ToolbarPanels
 *   activePanel={activePanel}
 *   theme={theme}
 *   showLineNumbers={showLineNumbers}
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
  showLineNumbers,
  children
}: ToolbarPanelsProps) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  // Panel width management with localStorage persistence
  const { width, setWidth, minWidth, maxWidth } = usePanelWidth();

  // Subscribe to locale change events
  useEventSubscriptions({
    'settings:locale-changed': ({ locale: newLocale }: { locale: string }) => {
      if (!pathname) return;

      startTransition(() => {
        // The router from @/i18n/routing is locale-aware and will handle the locale prefix
        router.replace(pathname, { locale: newLocale });
      });
    },
  });

  // Don't render container if no panel is active
  if (!activePanel) {
    return null;
  }

  return (
    <div className="semiont-toolbar-panels" style={{ width: `${width}px`, position: 'relative' }}>
      {/* Resize handle on left edge */}
      <ResizeHandle
        onResize={setWidth}
        minWidth={minWidth}
        maxWidth={maxWidth}
        position="left"
        ariaLabel="Resize right panel"
      />

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
            theme={theme}
            locale={locale}
            isPendingLocaleChange={isPending}
          />
        )}
      </div>
    </div>
  );
}
