'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { fetchEventSource } from '@microsoft/fetch-event-source';

export interface DetectionProgress {
  status: 'started' | 'scanning' | 'complete' | 'error';
  documentId: string;
  currentEntityType?: string;
  totalEntityTypes: number;
  processedEntityTypes: number;
  message?: string;
  foundCount?: number;
  completedEntityTypes?: Array<{ entityType: string; foundCount: number }>;
}

interface UseDetectionProgressOptions {
  documentId: string;
  onComplete?: (progress: DetectionProgress) => void;
  onError?: (error: string) => void;
  onProgress?: (progress: DetectionProgress) => void;
}

export function useDetectionProgress({
  documentId,
  onComplete,
  onError,
  onProgress
}: UseDetectionProgressOptions) {
  const { data: session } = useSession();
  const [isDetecting, setIsDetecting] = useState(false);
  const [progress, setProgress] = useState<DetectionProgress | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const completedEntityTypesRef = useRef<Array<{ entityType: string; foundCount: number }>>([]);

  const startDetection = useCallback(async (entityTypes: string[]) => {
    // Close any existing connection
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Get auth token from session
    if (!session?.backendToken) {
      onError?.('Authentication required');
      return;
    }

    setIsDetecting(true);
    setProgress(null);
    completedEntityTypesRef.current = [];

    // Create new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Build SSE URL
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    const url = `${apiUrl}/api/documents/${documentId}/detect-selections-stream`;

    console.log('[Detection] Starting with entity types:', entityTypes);
    console.log('[Detection] URL:', url);
    console.log('[Detection] Has backendToken:', !!session.backendToken);
    console.log('[Detection] Calling fetchEventSource...');

    try {
      await fetchEventSource(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.backendToken}`
        },
        body: JSON.stringify({ entityTypes }),
        signal: abortController.signal,

        onmessage(ev) {
          const data = JSON.parse(ev.data) as DetectionProgress;

          // Track completed entity types
          if (data.foundCount !== undefined && data.currentEntityType) {
            completedEntityTypesRef.current.push({
              entityType: data.currentEntityType,
              foundCount: data.foundCount
            });
          }

          // Add completed entity types to progress data
          const progressWithHistory = {
            ...data,
            completedEntityTypes: [...completedEntityTypesRef.current]
          };

          setProgress(progressWithHistory);
          onProgress?.(progressWithHistory);

          // Handle specific event types
          if (ev.event === 'detection-complete') {
            setIsDetecting(false);
            setProgress(null); // Clear progress to hide overlay
            onComplete?.(progressWithHistory);
            abortController.abort(); // Close connection
            abortControllerRef.current = null;
          } else if (ev.event === 'detection-error') {
            setIsDetecting(false);
            setProgress(null); // Clear progress to hide overlay
            onError?.(data.message || 'Detection failed');
            abortController.abort();
            abortControllerRef.current = null;
          }
        },

        onerror(err) {
          // If the error is due to abort, don't show error
          if (abortController.signal.aborted) {
            return;
          }

          console.error('SSE Connection error:', err);
          setIsDetecting(false);
          setProgress(null); // Clear progress to hide overlay
          onError?.('Connection lost. Please try again.');
          throw err; // Throw to stop reconnection
        },

        openWhenHidden: true // Keep connection open when tab is in background
      });
    } catch (error) {
      if (!abortController.signal.aborted) {
        console.error('[Detection] Failed to start detection:', error);
        console.error('[Detection] Error details:', {
          name: (error as Error)?.name,
          message: (error as Error)?.message,
          stack: (error as Error)?.stack
        });
        setIsDetecting(false);
        onError?.('Failed to start detection');
      }
    }
  }, [documentId, onComplete, onError, onProgress, session]);

  const cancelDetection = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsDetecting(false);
    setProgress(null);
    completedEntityTypesRef.current = [];
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
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