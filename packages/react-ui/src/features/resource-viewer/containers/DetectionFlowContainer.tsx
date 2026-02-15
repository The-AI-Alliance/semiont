/**
 * DetectionFlowContainer - Manages detection state and event subscriptions
 *
 * This container isolates all detection-related side effects:
 * - Event subscriptions for detection:start, detection:progress, detection:complete
 * - State management for detectingMotivation and detectionProgress
 * - Setup of useEventOperations for SSE streams
 *
 * By extracting this container, we:
 * 1. Make detection flow testable in isolation (Layer 3 tests)
 * 2. Separate side effects from presentation logic
 * 3. Enable render props pattern for flexible composition
 */

import { useState, useRef, useCallback } from 'react';
import type { Motivation, ResourceUri } from '@semiont/api-client';
import { useEventBus } from '../../../contexts/EventBusContext';
import { useEventSubscriptions } from '../../../contexts/useEventSubscription';
import { useApiClient } from '../../../contexts/ApiClientContext';
import { useEventOperations } from '../../../contexts/useEventOperations';
import type { DetectionProgress } from '../../../hooks/useDetectionProgress';

export interface DetectionFlowState {
  detectingMotivation: Motivation | null;
  detectionProgress: DetectionProgress | null;
  detectionStreamRef: React.MutableRefObject<any>;
}

export interface DetectionFlowContainerProps {
  rUri: ResourceUri;
  children: (state: DetectionFlowState) => React.ReactNode;
}

/**
 * Container for detection flow state management
 *
 * @subscribes detection:start - Starts detection for a motivation. Payload: { motivation: Motivation }
 * @subscribes detection:progress - Updates detection progress. Payload: DetectionProgress
 * @subscribes detection:complete - Completes detection for a motivation. Payload: { motivation?: Motivation }
 * @subscribes detection:failed - Handles detection failure. Payload: none
 *
 * Usage:
 * ```tsx
 * <DetectionFlowContainer rUri={rUri}>
 *   {({ detectingMotivation, detectionProgress }) => (
 *     <UnifiedAnnotationsPanel
 *       detectingMotivation={detectingMotivation}
 *       detectionProgress={detectionProgress}
 *       {...otherProps}
 *     />
 *   )}
 * </DetectionFlowContainer>
 * ```
 */
export function DetectionFlowContainer({
  rUri,
  children,
}: DetectionFlowContainerProps) {
  const eventBus = useEventBus();
  const client = useApiClient();

  // Detection state
  const [detectingMotivation, setDetectingMotivation] = useState<Motivation | null>(null);
  const [detectionProgress, setDetectionProgress] = useState<DetectionProgress | null>(null);
  const detectionStreamRef = useRef<any>(null);

  // Set up event operation handlers (detection, generation, etc.)
  useEventOperations(eventBus, { client: client || undefined, resourceUri: rUri });

  // Event handlers extracted from useEventSubscriptions
  const handleDetectionStart = useCallback(({ motivation }: { motivation: Motivation }) => {
    setDetectingMotivation(motivation);
    setDetectionProgress(null); // Clear previous progress
  }, []);

  const handleDetectionProgress = useCallback((chunk: any) => {
    setDetectionProgress(chunk);
  }, []);

  const handleDetectionComplete = useCallback(({ motivation }: { motivation?: Motivation }) => {
    // Keep progress visible with final message - only clear detecting flag
    if (motivation === detectingMotivation) {
      setDetectingMotivation(null);
      // Don't clear detectionProgress - let final message display
    }
  }, [detectingMotivation]);

  const handleDetectionFailed = useCallback(() => {
    setDetectingMotivation(null);
    // Just clear progress on error - error display handled by ResourceViewerPage
    setDetectionProgress(null);
  }, []);

  // Subscribe to detection events
  useEventSubscriptions({
    'detection:start': handleDetectionStart,
    'detection:progress': handleDetectionProgress,
    'detection:complete': handleDetectionComplete,
    'detection:failed': handleDetectionFailed,
  });

  return <>{children({ detectingMotivation, detectionProgress, detectionStreamRef })}</>;
}
