/**
 * useDetectionFlow - Detection state management hook
 *
 * Manages detection flow state and event subscriptions:
 * - Tracking currently detecting motivation
 * - Detection progress updates from SSE
 * - Detection lifecycle (start, progress, complete, failed)
 *
 * Follows react-rxjs-guide.md Layer 2 pattern: Hook bridge that
 * subscribes to events and pushes values into React state.
 */

import { useState, useRef } from 'react';
import type { Motivation, ResourceUri } from '@semiont/api-client';
import { useEventBus } from '../contexts/EventBusContext';
import { useEventSubscriptions } from '../contexts/useEventSubscription';
import { useApiClient } from '../contexts/ApiClientContext';
import { useEventOperations } from '../contexts/useEventOperations';
import type { DetectionProgress } from './useDetectionProgress';

export interface DetectionFlowState {
  detectingMotivation: Motivation | null;
  detectionProgress: DetectionProgress | null;
  detectionStreamRef: React.MutableRefObject<any>;
}

/**
 * Hook for detection flow state management
 *
 * @param rUri - Resource URI being detected
 * @returns Detection state and stream ref
 */
export function useDetectionFlow(rUri: ResourceUri): DetectionFlowState {
  const eventBus = useEventBus();
  const client = useApiClient();

  // Detection state
  const [detectingMotivation, setDetectingMotivation] = useState<Motivation | null>(null);
  const [detectionProgress, setDetectionProgress] = useState<DetectionProgress | null>(null);
  const detectionStreamRef = useRef<any>(null);

  // Set up event operation handlers (detection, generation, etc.)
  useEventOperations(eventBus, { client, resourceUri: rUri });

  // Subscribe to detection events
  useEventSubscriptions({
    'detection:start': ({ motivation }: { motivation: Motivation }) => {
      setDetectingMotivation(motivation);
      setDetectionProgress(null); // Clear previous progress
    },
    'detection:progress': (chunk: any) => {
      setDetectionProgress(chunk);
    },
    'detection:complete': ({ motivation }: { motivation?: Motivation }) => {
      // Keep progress visible with final message - only clear detecting flag
      // Use callback form to get current state without closure
      setDetectingMotivation(current => {
        if (motivation === current) {
          return null;
        }
        return current;
      });
    },
    'detection:failed': () => {
      setDetectingMotivation(null);
      setDetectionProgress(null);
    },
  });

  return { detectingMotivation, detectionProgress, detectionStreamRef };
}
