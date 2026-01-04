/**
 * @semiont/react-ui
 *
 * React components and hooks for Semiont applications
 */

// Types
export * from './types/annotation-props';
export * from './types/AnnotationManager';
export * from './types/ApiClientManager';
export * from './types/CacheManager';
export * from './types/OpenResourcesManager';
export * from './types/SessionManager';
export * from './types/TranslationManager';

// Lib utilities
export * from './lib/annotation-registry';
export * from './lib/api-hooks';
export * from './lib/auth-events';
export * from './lib/button-styles';
export * from './lib/codemirror-json-theme';
export * from './lib/codemirror-widgets';
export * from './lib/query-keys';
export * from './lib/rehype-render-annotations';
export * from './lib/remark-annotations';
export * from './lib/resource-utils';
export * from './lib/tag-schemas';
export * from './lib/validation';

// Hooks
export * from './hooks/useAnnotationPanel';
export * from './hooks/useAuth';
export * from './hooks/useDebounce';
export * from './hooks/useDetectionProgress';
export * from './hooks/useFormattedTime';
export { useFormValidation, validationRules } from './hooks/useFormValidation';
export * from './hooks/useGenerationProgress';
export * from './hooks/useKeyboardShortcuts';
export * from './hooks/useLineNumbers';
export * from './hooks/useResourceEvents';
export * from './hooks/useRovingTabIndex';
export * from './hooks/useSessionExpiry';
export * from './hooks/useTheme';
export * from './hooks/useToolbar';
// Note: useToast is already exported from ./components/Toast
// Note: useDebounce is already exported from ./hooks/useDebounce
export { useDropdown, useLoadingState, useLocalStorage } from './hooks/useUI';

// Contexts
export * from './contexts/AnnotationContext';
export * from './contexts/AnnotationUIContext';
export * from './contexts/ApiClientContext';
export * from './contexts/CacheContext';
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
export * from './components/ResourceTagsInline';
export * from './components/Toast';
export * from './components/Toolbar';

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

// Components - Layout
export * from './components/SkipLinks';
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
