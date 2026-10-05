import React, { useTransition, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SettingsPanel,
  ResizeHandle,
  usePanelWidth,
  useEventSubscriptions,
  useSemiont,
  useObservable,
  useHoverDelay,
  useTheme,
  useLineNumbers,
} from '@semiont/react-ui';
import { UserPanel } from '../UserPanel';
import { KnowledgeBasePanel } from '../KnowledgeBasePanel';
import { useKeyboardShortcutsContext } from '@/contexts/KeyboardShortcutsContext';
import { useLocale } from '@/i18n/routing';
import { usePathname, useRouter } from '@/i18n/routing';
import { COMMON_PANELS } from '@semiont/react-ui';
import type { ToolbarPanelType } from '@semiont/react-ui';

interface ToolbarPanelsProps {
  activePanel: ToolbarPanelType | null;
  /** Theme setting */
  theme: 'light' | 'dark' | 'system';
  /** Custom panel content for context-specific panels */
  children?: React.ReactNode;
}

/**
 * Renders the toolbar panel container with the common panels (knowledge
 * base, user, settings) and any context-specific panels passed as children.
 *
 * Settings changes arrive as `settings:*` bus events and are applied here -
 * no callbacks needed.
 *
 * @example
 * // Simple context (compose, discover, moderate pages)
 * <ToolbarPanels
 *   activePanel={activePanel}
 *   theme={theme}
 * />
 *
 * @example
 * // Document context with custom panels
 * <ToolbarPanels
 *   activePanel={activePanel}
 *   theme={theme}
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
  children
}: ToolbarPanelsProps) {
  // Source hover-delay from the shared hook so every page that mounts
  // ToolbarPanels gets the live value without prop-drilling. As a prop, a
  // page that forgets to pass it renders the Settings panel with
  // `undefined`, which surfaces as `{undefined}ms delay` after the
  // translation interpolation runs.
  const { hoverDelayMs } = useHoverDelay();
  // The Settings panel opens keyboard help.
  const { openKeyboardHelp } = useKeyboardShortcutsContext();
  const { t: _t } = useTranslation();
  const session = useObservable(useSemiont().activeSession$);
  const user = useObservable(session?.user$);
  const isAuthenticated = !!user;
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

  // APPLYING the settings this panel emits is this component's job, exactly
  // like locale above. Living here makes "the panel is mounted" and "the
  // panel works" the same condition: a per-route subscription leaves Theme
  // and Line Numbers dead on any route without one, while Language (handled
  // here) works.
  const { setTheme } = useTheme();
  const { toggleLineNumbers } = useLineNumbers();
  const handleThemeChanged = useCallback(
    ({ theme: newTheme }: { theme: 'light' | 'dark' | 'system' }) => setTheme(newTheme),
    [setTheme],
  );
  const handleLineNumbersToggled = useCallback(() => toggleLineNumbers(), [toggleLineNumbers]);

  useEventSubscriptions({
    'settings:locale-changed': handleLocaleChanged,
    'settings:theme-changed': handleThemeChanged,
    'settings:line-numbers-toggled': handleLineNumbersToggled,
  });

  // Don't render container if no panel is active
  if (!activePanel) {
    return null;
  }

  // In simple context (no children), only the common panels are valid.
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

        {/* Knowledge Base Panel - common to all contexts */}
        {activePanel === 'knowledge-base' && (
          <KnowledgeBasePanel />
        )}

        {/* User Panel - requires authentication */}
        {activePanel === 'user' && (
          isAuthenticated ? (
            <UserPanel />
          ) : (
            <div className="semiont-panel">
              <div className="semiont-panel-header">
                <h2 className="semiont-panel-header__title">
                  <span className="semiont-panel-header__text">{_t('UserPanel.account')}</span>
                </h2>
              </div>
              <div className="semiont-panel__content" style={{ padding: '1rem', textAlign: 'center' }}>
                <p style={{ color: 'var(--semiont-color-neutral-400)', fontSize: '0.85rem', lineHeight: 1.5 }}>
                  {_t('AccountPanel.notAuthenticated')}
                </p>
              </div>
            </div>
          )
        )}

        {/* Settings Panel - common to all contexts */}
        {activePanel === 'settings' && (
          <SettingsPanel
            theme={theme}
            hoverDelayMs={hoverDelayMs}
            locale={locale}
            isPendingLocaleChange={isPending}
            version={__APP_VERSION__}
            sourceCodeUrl="https://github.com/The-AI-Alliance/semiont"
            onOpenKeyboardHelp={openKeyboardHelp}
          />
        )}
      </div>
    </div>
  );
}
