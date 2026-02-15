'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import type { ResourceUri, DetectionProgress as ApiDetectionProgress, SSEStream } from '@semiont/api-client';
import { entityType } from '@semiont/api-client';
import { useApiClient } from '../contexts/ApiClientContext';
import { useEventBus } from '../contexts/EventBusContext';

// Extend API type with frontend-specific fields
export interface DetectionProgress extends ApiDetectionProgress {
  completedEntityTypes?: Array<{ entityType: string; foundCount: number }>;
}

interface UseDetectionProgressOptions {
  rUri: ResourceUri;
}

/**
 * Hook for managing detection progress tracking with SSE streams
 *
 * @emits detection:error-event - Error during detection. Payload: { error: string }
 * @emits detection:progress-update - Progress update during detection. Payload: { progress: DetectionProgress }
 * @emits detection:complete-event - Detection completed successfully. Payload: { progress: DetectionProgress }
 */
export function useDetectionProgress({
  rUri
}: UseDetectionProgressOptions) {
  const client = useApiClient();
  const eventBus = useEventBus();
  const [isDetecting, setIsDetecting] = useState(false);
  const [progress, setProgress] = useState<DetectionProgress | null>(null);
  const streamRef = useRef<SSEStream<ApiDetectionProgress, ApiDetectionProgress> | null>(null);
  const completedEntityTypesRef = useRef<Array<{ entityType: string; foundCount: number }>>([]);

  const startDetection = useCallback(async (entityTypes: string[]) => {
    // Close any existing stream
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }

    // Check if client is available
    if (!client) {
      eventBus.emit('detection:error-event', { error: 'Authentication required' });
      return;
    }

    setIsDetecting(true);
    setProgress(null);
    completedEntityTypesRef.current = [];

    try {
      // Start SSE stream using api-client
      const stream = client.sse.detectAnnotations(rUri, { entityTypes: entityTypes.map(entityType) });
      streamRef.current = stream;

      // Handle progress events
      stream.onProgress((apiProgress) => {
        // Track completed entity types
        if (apiProgress.foundCount !== undefined && apiProgress.currentEntityType) {
          completedEntityTypesRef.current.push({
            entityType: apiProgress.currentEntityType,
            foundCount: apiProgress.foundCount
          });
        }

        // Add completed entity types to progress data
        const progressWithHistory: DetectionProgress = {
          ...apiProgress,
          completedEntityTypes: [...completedEntityTypesRef.current]
        };

        setProgress(progressWithHistory);
        eventBus.emit('detection:progress-update', { progress: progressWithHistory });
      });

      // Handle completion
      stream.onComplete((apiProgress) => {
        const progressWithHistory: DetectionProgress = {
          ...apiProgress,
          completedEntityTypes: [...completedEntityTypesRef.current]
        };

        setIsDetecting(false);
        setProgress(null); // Clear progress to hide overlay
        eventBus.emit('detection:complete-event', { progress: progressWithHistory });
        streamRef.current = null;
      });

      // Handle errors
      stream.onError((error) => {
        console.error('[Detection] Stream error:', error);
        setIsDetecting(false);
        setProgress(null); // Clear progress to hide overlay
        eventBus.emit('detection:error-event', { error: error.message || 'Detection failed' });
        streamRef.current = null;
      });
    } catch (error) {
      console.error('[Detection] Failed to start detection:', error);
      console.error('[Detection] Error details:', {
        name: (error as Error)?.name,
        message: (error as Error)?.message,
        stack: (error as Error)?.stack
      });
      setIsDetecting(false);
      eventBus.emit('detection:error-event', { error: 'Failed to start detection' });
    }
  }, [rUri, client]); // eventBus is a global singleton - never include in deps

  const cancelDetection = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.close();
      streamRef.current = null;
    }
    setIsDetecting(false);
    setProgress(null);
    completedEntityTypesRef.current = [];
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.close();
      }
    };
  }, []);

  return {
    isDetecting,
    progress,
    startDetection,
    cancelDetection
  };
}
