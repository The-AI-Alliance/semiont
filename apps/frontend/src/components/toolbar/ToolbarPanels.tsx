'use client';

import React, { useTransition, useEffect, useCallback } from 'react';
import { SettingsPanel, ResizeHandle, usePanelWidth, EventBusProvider, useEventSubscriptions } from '@semiont/react-ui';
import { UserPanel } from '../UserPanel';
import { useLocale } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/routing';
import { COMMON_PANELS } from '@semiont/react-ui';
import type { ToolbarPanelType } from '@semiont/react-ui';

interface ToolbarPanelsProps {
  activePanel: ToolbarPanelType | null;
  /** Theme setting */
  theme: 'light' | 'dark' | 'system';
  /** Line numbers setting */
  showLineNumbers: boolean;
  /** Hover delay setting */
  hoverDelayMs: number;
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
  hoverDelayMs,
  children
}: ToolbarPanelsProps) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  // Panel width management with localStorage persistence
  const { width, setWidth, minWidth, maxWidth } = usePanelWidth();

  // Handle locale change events
  const handleLocaleChanged = useCallback(({ locale: newLocale }: { locale: string }) => {
    if (!pathname) return;

    startTransition(() => {
      // The router from @/i18n/routing is locale-aware and will handle the locale prefix
      router.replace(pathname, { locale: newLocale });
    });
  }, [pathname, router, startTransition]);

  // Subscribe to locale change events
  useEventSubscriptions({
    'settings:locale-changed': handleLocaleChanged,
  });

  // Don't render container if no panel is active
  if (!activePanel) {
    return null;
  }

  // In simple context (no children), only user and settings panels are valid.
  // If a resource-specific panel is still active from a previous route, hide the container.
  if (!children && !COMMON_PANELS.includes(activePanel)) {
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
            hoverDelayMs={hoverDelayMs}
            locale={locale}
            isPendingLocaleChange={isPending}
          />
        )}
      </div>
    </div>
  );
}
