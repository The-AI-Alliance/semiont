/**
 * @semiont/react-ui
 *
 * React components and hooks for Semiont applications
 */

// Types
export * from './types/annotation-props';
export * from './types/AnnotationManager';
export * from './types/navigation';
export * from './types/TranslationManager';
export * from './types/resource-viewer';

// Lib utilities
export * from './lib/annotation-registry';
export * from './lib/button-styles';
export * from './lib/codemirror-json-theme';
export * from './lib/codemirror-widgets';
export * from './lib/media-shapes';
export { createSearchPipeline, type SearchPipeline, type SearchPipelineOptions, type SearchState } from '@semiont/sdk';
export * from './lib/annotation-overlay';
export * from './lib/resource-utils';
export * from './lib/tag-schemas';
export * from './lib/validation';

// Hooks
export * from './hooks/useStateUnit';
export * from './hooks/useDebounce';
export * from './lib/formatTime';
export * from './hooks/useKeyboardShortcuts';
export * from './hooks/useLineNumbers';
export * from './hooks/useHoverDelay';
export * from './hooks/useObservableBrowse';
export * from './hooks/usePanelWidth';
export * from './hooks/useRovingTabIndex';
export * from './hooks/useSessionExpiry';
export * from './contexts/ThemeContext';
// Note: useToast is already exported from ./components/Toast
// Note: useDebounce is already exported from ./hooks/useDebounce
export { useDropdown, useLoadingState, useLocalStorage } from './hooks/useUI';
export * from './hooks/useResourceContent';

// Session (the React layer — provider + hook + browser storage adapter).
// All session classes (`SemiontSession`, `SemiontBrowser`, `SessionSignals`,
// `SemiontSessionError`, `SessionStorage`, `InMemorySessionStorage`, the
// `KnowledgeBase` / `OpenResource` types, etc.) live in `@semiont/sdk`.
// Callers import them from there directly.
export { SemiontProvider, useSemiont, type SemiontProviderProps } from './session/SemiontProvider';
export { WebBrowserStorage } from './session/web-browser-storage';

// Contexts
export * from './contexts/AnnotationContext';

export * from './contexts/useEventSubscription';
export * from './contexts/ResourceAnnotationsContext';
export * from './contexts/RoutingContext';
export * from './contexts/TranslationContext';

// Components - Top level
export * from './components/CodeMirrorRenderer';
export * from './components/AnnotateReferencesProgressWidget';
export * from './components/ErrorBoundary';
export * from './components/ProtectedErrorBoundary';
export * from './components/LiveRegion';
export * from './components/ResizeHandle';
export * from './components/ResourceTagsInline';
export * from './components/Toast';
export * from './components/Toolbar';

// Components - Settings
export * from './components/settings/SettingsPanel';

// Components - Annotation
export * from './components/annotation/AnnotateToolbar';

// Components - Annotation Popups
export * from './components/annotation-popups/JsonLdView';
export * from './components/annotation-popups/SharedPopupElements';

// Components - Image Annotation
export * from './components/image-annotation/AnnotationOverlay';
export * from './components/image-annotation/SvgDrawingCanvas';

// Components - Modals
export * from './components/modals/KeyboardShortcutsHelpModal';
export * from './components/modals/PermissionDeniedModal';
export * from './components/modals/SessionExpiredModal';

// Components - Resource
export * from './components/resource/AnnotateView';
export * from './components/resource/AnnotationHistory';
export * from './components/resource/BrowseView';
export * from './components/resource/HistoryEvent';
export * from './components/resource/ResourceViewer';

// Components - Resource Panels
export * from './components/resource/panels/AssessmentEntry';
export * from './components/resource/panels/AssessmentPanel';
export * from './components/resource/panels/CollaborationPanel';
export * from './components/resource/panels/CommentEntry';
export * from './components/resource/panels/CommentsPanel';
export * from './components/resource/panels/AssistSection';
export * from './components/resource/panels/HighlightEntry';
export * from './components/resource/panels/HighlightPanel';
export * from './components/resource/panels/JsonLdPanel';
export * from './components/resource/panels/PanelHeader';
export * from './components/resource/panels/ReferenceEntry';
export * from './components/resource/panels/ReferencesPanel';
export * from './components/resource/panels/ResourceInfoPanel';
export * from './components/resource/panels/StatisticsPanel';
export * from './components/resource/panels/TagEntry';
export * from './components/resource/panels/TaggingPanel';
export * from './components/resource/panels/UnifiedAnnotationsPanel';

// Components - Toolbar
// (ToolbarPanels is app-specific, located in frontend)

// Components - Viewers
export * from './components/viewers';

// Components - Navigation
export * from './components/navigation/Footer';
export * from './components/navigation/NavigationMenu';
export * from './components/navigation/ObservableLink';
export * from './components/navigation/SimpleNavigation';
export * from './components/navigation/CollapsibleResourceNavigation';
export * from './components/navigation/SortableResourceTab';
export type {
  CollapsibleResourceNavigationProps,
  SortableResourceTabProps
} from './types/collapsible-navigation';
export type {
  SimpleNavigationItem,
  SimpleNavigationProps
} from './types/simple-navigation';

// Components - Modals
export * from './components/modals/ReferenceWizardModal';
export * from './components/modals/SearchModal';
export * from './components/modals/ResourceSearchModal';
export type {
  SearchModalProps,
  ResourceSearchModalProps,
} from './types/modals';

// Components - Layout
export * from './components/layout/SkipLinks';
export * from './components/StatusDisplay';

// Components - Session
export * from './components/SessionTimer';
export * from './components/SessionExpiryBanner';
export * from './components/UserMenuSkeleton';

// Components - Branding & Layout
export * from './components/branding/SemiontBranding';
export * from './components/layout/UnifiedHeader';
export * from './components/layout/LeftSidebar';
export * from './components/layout/PageLayout';

// Favicon components and assets
export { SemiontFavicon } from './assets/favicons/SemiontFavicon';
export { faviconPaths } from './assets/favicons';

// Design tokens and CSS-agnostic components
export { Button, ButtonGroup } from './components/Button/Button';
export type { ButtonProps, ButtonGroupProps } from './components/Button/Button';
export { tokens, generateCSSVariables, cssVariables } from './design-tokens';
export type {
  ColorToken,
  SpacingToken,
  TypographyToken,
  BorderRadiusToken,
  ShadowToken,
  TransitionToken
} from './design-tokens';

// Components - Loading States
export * from './components/loading-states/ComposeLoadingState';
export * from './components/loading-states/ResourceLoadingState';

// Components - Error States
export * from './components/error-states/ResourceErrorState';

// Features - Admin
export * from './features/admin-devops/components/AdminDevOpsPage';
export * from './features/admin-exchange/components/AdminExchangePage';
export * from './features/admin-exchange/components/ExportCard';
export * from './features/admin-exchange/components/ImportCard';
export * from './features/admin-exchange/components/ImportProgress';
export * from './features/admin-security/components/AdminSecurityPage';

// Features - Moderation
export * from './features/moderation-linked-data/components/LinkedDataPage';
export * from './features/admin-users/components/AdminUsersPage';

// Features - Auth
export * from './features/auth/components/SignInForm';
export * from './features/auth/components/SignUpForm';
export * from './features/auth/components/AuthErrorDisplay';
export * from './features/auth-welcome/components/WelcomePage';

// Features - Moderation
export * from './features/moderate-entity-tags/components/EntityTagsPage';
export * from './features/moderate-recent/components/RecentDocumentsPage';
export * from './features/moderate-tag-schemas/components/TagSchemasPage';

// Features - Resources
export * from './features/resource-compose/components/ResourceComposePage';
export * from './features/resource-compose/components/UploadProgressBar';
export * from './features/resource-discovery/components/ResourceDiscoveryPage';
export * from './features/resource-discovery/components/ResourceCard';
export * from './features/resource-viewer/components/ResourceViewerPage';
export * from './hooks/useHoverEmitter';
// Flow VMs live in `@semiont/sdk` (UI-shape-agnostic state machines that
// any consumer — web, terminal, mobile, daemon — can reach for).
// React-ui re-exports them so consumers of this package don't need a
// second import line.
export { createBeckonStateUnit, type BeckonStateUnit, createHoverHandlers, type HoverHandlers, HOVER_DELAY_MS } from '@semiont/sdk';
export { createMarkStateUnit, type MarkStateUnit, type PendingAnnotation } from '@semiont/sdk';
export { createYieldStateUnit, type YieldStateUnit, type GenerateDocumentOptions } from '@semiont/sdk';
export { createGatherStateUnit, type GatherStateUnit } from '@semiont/sdk';
export { createMatchStateUnit, type MatchStateUnit } from '@semiont/sdk';
// Job-domain worker adapters (`createJobClaimAdapter`, `createJobQueueStateUnit`)
// and the `WorkerBus` interface live in `@semiont/jobs` and `@semiont/sdk`
// respectively — import them from there directly if needed.

// Page-shaped state machines live here in `@semiont/react-ui` because they
// model the Semiont web frontend's specific page taxonomy and shell. They
// are framework-neutral (pure RxJS, no React inside) but not portable to a
// non-web UI shape.
export { createShellStateUnit, type ShellStateUnit, type ShellStateUnitOptions, type ToolbarPanelType, COMMON_PANELS, RESOURCE_PANELS } from './state/shell-state-unit';
export { createSessionStateUnit, type SessionStateUnit } from './state/session-state-unit';
export { createComposePageStateUnit, type ComposePageStateUnit, type ComposeParams, type ComposeMode, type CloneData, type ReferenceData, type SaveResourceParams } from './features/resource-compose/state/compose-page-state-unit';
export { createResourceViewerPageStateUnit, type ResourceViewerPageStateUnit, type WizardState, type AnnotationGroups } from './features/resource-viewer/state/resource-viewer-page-state-unit';
export { createResourceLoaderStateUnit, type ResourceLoaderStateUnit } from './features/resource-viewer/state/resource-loader-state-unit';
export { createAdminUsersStateUnit, type AdminUsersStateUnit } from './features/admin-users/state/admin-users-state-unit';
export { createAdminSecurityStateUnit, type AdminSecurityStateUnit } from './features/admin-security/state/admin-security-state-unit';
export { createExchangeStateUnit, type ExchangeStateUnit, type ImportPreview } from './features/admin-exchange/state/exchange-state-unit';
export { createWelcomeStateUnit, type WelcomeStateUnit } from './features/auth-welcome/state/welcome-state-unit';
export { createDiscoverStateUnit, type DiscoverStateUnit } from './features/resource-discovery/state/discover-state-unit';
export { createEntityTagsStateUnit, type EntityTagsStateUnit } from './features/moderate-entity-tags/state/entity-tags-state-unit';

export * from './hooks/useShellStateUnit';
export * from './hooks/useObservable';
