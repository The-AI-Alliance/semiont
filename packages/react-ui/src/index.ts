/**
 * @semiont/react-ui
 *
 * React components and hooks for Semiont applications
 */

// Types
export * from './types/annotation-props';
export * from './types/AnnotationManager';
export * from './types/CacheManager';
export * from './types/navigation';
export type { OpenResourcesManager } from './types/OpenResourcesManager';
export { type OpenResource as OpenResourceFromManager } from './types/OpenResourcesManager';
export * from './types/SessionManager';
export * from './types/TranslationManager';
export * from './types/resource-viewer';
export * from './types/progress';

// Lib utilities
export * from './lib/annotation-registry';
export * from './lib/api-hooks';
export * from './lib/auth-events';
export * from './lib/button-styles';
export * from './lib/codemirror-json-theme';
export * from './lib/codemirror-widgets';
export * from './lib/media-shapes';
export * from './lib/query-keys';
export * from './lib/rehype-render-annotations';
export * from './lib/remark-annotations';
export * from './lib/resource-utils';
export * from './lib/tag-schemas';
export * from './lib/validation';

// Hooks
export * from './hooks/useDebounce';
export * from './hooks/useFormattedTime';
export { useFormValidation, validationRules } from './hooks/useFormValidation';
export * from './hooks/useGenerationProgress';
export * from './hooks/useKeyboardShortcuts';
export * from './hooks/useLineNumbers';
export * from './hooks/useObservableNavigation';
export * from './hooks/usePanelWidth';
export * from './hooks/useResourceEvents';
export * from './hooks/useRovingTabIndex';
export * from './hooks/useSessionExpiry';
export * from './hooks/useTheme';
// Note: useToast is already exported from ./components/Toast
// Note: useDebounce is already exported from ./hooks/useDebounce
export { useDropdown, useLoadingState, useLocalStorage } from './hooks/useUI';
export * from './hooks/useResourceContent';

// Contexts
export * from './contexts/AnnotationContext';
export * from './contexts/AnnotationUIContext';
export * from './contexts/ApiClientContext';
export * from './contexts/AuthTokenContext';
export * from './contexts/CacheContext';
export * from './contexts/EventBusContext';
export * from './contexts/useResolutionFlow';
export * from './contexts/useEventSubscription';
export * from './contexts/OpenResourcesContext';
export * from './contexts/ResourceAnnotationsContext';
export * from './contexts/RoutingContext';
export * from './contexts/SessionContext';
export * from './contexts/TranslationContext';

// Components - Top level
export * from './components/CodeMirrorRenderer';
export * from './components/DetectionProgressWidget';
export * from './components/ErrorBoundary';
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
export * from './components/modals/ProposeEntitiesModal';

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
export * from './components/resource/panels/DetectSection';
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
  SortableResourceTabProps,
  OpenResource
} from './types/collapsible-navigation';
export type {
  SimpleNavigationItem,
  SimpleNavigationProps
} from './types/simple-navigation';

// Components - Modals
export * from './components/modals/SearchModal';
export * from './components/modals/ResourceSearchModal';
export type {
  SearchModalProps,
  ResourceSearchModalProps,
  GenerationOptions
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
export * from './features/admin-security/components/AdminSecurityPage';
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
export * from './features/resource-discovery/components/ResourceDiscoveryPage';
export * from './features/resource-discovery/components/ResourceCard';
export * from './features/resource-viewer/components/ResourceViewerPage';
export * from './hooks/useDetectionFlow';
export * from './hooks/usePanelNavigation';
export * from './hooks/useGenerationFlow';
export * from './hooks/useContextRetrievalFlow';
