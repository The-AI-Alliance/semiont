import { useEventSubscriptions } from '@semiont/react-ui';

export interface ResourcePageEventHandlers {
  // Resource operations
  onArchive: () => void;
  onUnarchive: () => void;
  onClone: () => void;

  // UI operations
  onSparkleAnnotation: (annotationId: string) => void;
  onThemeChanged: (theme: any) => void;
  onLineNumbersToggled: () => void;

  // Annotation completion events
  onAnnotationCreated: (annotation: any) => void;
  onAnnotationDeleted: () => void;
  onAnnotationCreateFailed: () => void;
  onAnnotationDeleteFailed: () => void;
  onAnnotationBodyUpdated: () => void;
  onAnnotationBodyUpdateFailed: () => void;

  // Detection/generation completion events
  onDetectionComplete: () => void;
  onDetectionFailed: () => void;
  onGenerationComplete: () => void;
  onGenerationFailed: () => void;
}

/**
 * Hook that sets up all event subscriptions for the resource page
 *
 * Consolidates all event bus subscriptions into a single hook
 * for easier testing and cleaner component code.
 */
export function useResourcePageEventSubscriptions(handlers: ResourcePageEventHandlers) {
  // Subscribe to resource operation events
  useEventSubscriptions({
    'resource:archive': handlers.onArchive,
    'resource:unarchive': handlers.onUnarchive,
    'resource:clone': handlers.onClone,
    'annotation:sparkle': ({ annotationId }) => {
      handlers.onSparkleAnnotation(annotationId);
    },
  });

  // Subscribe to settings events
  useEventSubscriptions({
    'settings:theme-changed': ({ theme }) => handlers.onThemeChanged(theme),
    'settings:line-numbers-toggled': handlers.onLineNumbersToggled,
  });

  // Subscribe to operation completion events
  useEventSubscriptions({
    'annotation:created': ({ annotation }) => handlers.onAnnotationCreated(annotation),
    'annotation:deleted': handlers.onAnnotationDeleted,
    'annotation:create-failed': handlers.onAnnotationCreateFailed,
    'annotation:delete-failed': handlers.onAnnotationDeleteFailed,
    'annotation:body-updated': handlers.onAnnotationBodyUpdated,
    'annotation:body-update-failed': handlers.onAnnotationBodyUpdateFailed,
  });

  // Subscribe to detection completion events
  useEventSubscriptions({
    'detection:complete': handlers.onDetectionComplete,
    'detection:failed': handlers.onDetectionFailed,
  });

  // Subscribe to generation completion events
  useEventSubscriptions({
    'reference:generation-complete': handlers.onGenerationComplete,
    'reference:generation-failed': handlers.onGenerationFailed,
  });
}
