'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import type { ResourceUri, DetectionProgress as ApiDetectionProgress, SSEStream } from '@semiont/api-client';
import { entityType } from '@semiont/api-client';
import { useApiClient } from '../lib/api-hooks';

// Extend API type with frontend-specific fields
export interface DetectionProgress extends ApiDetectionProgress {
  completedEntityTypes?: Array<{ entityType: string; foundCount: number }>;
}

interface UseDetectionProgressOptions {
  rUri: ResourceUri;
  onComplete?: (progress: DetectionProgress) => void;
  onError?: (error: string) => void;
  onProgress?: (progress: DetectionProgress) => void;
}

export function useDetectionProgress({
  rUri,
  onComplete,
  onError,
  onProgress
}: UseDetectionProgressOptions) {
  const client = useApiClient();
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
      onError?.('Authentication required');
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
        onProgress?.(progressWithHistory);
      });

      // Handle completion
      stream.onComplete((apiProgress) => {
        const progressWithHistory: DetectionProgress = {
          ...apiProgress,
          completedEntityTypes: [...completedEntityTypesRef.current]
        };

        setIsDetecting(false);
        setProgress(null); // Clear progress to hide overlay
        onComplete?.(progressWithHistory);
        streamRef.current = null;
      });

      // Handle errors
      stream.onError((error) => {
        console.error('[Detection] Stream error:', error);
        setIsDetecting(false);
        setProgress(null); // Clear progress to hide overlay
        onError?.(error.message || 'Detection failed');
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
      onError?.('Failed to start detection');
    }
  }, [rUri, client, onComplete, onError, onProgress]);

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
