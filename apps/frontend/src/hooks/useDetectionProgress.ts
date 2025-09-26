'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { fetchEventSource } from '@microsoft/fetch-event-source';
import { apiClient } from '@/lib/api-client';

export interface DetectionProgress {
  status: 'started' | 'scanning' | 'creating' | 'complete' | 'error';
  documentId: string;
  currentEntityType?: string;
  totalEntityTypes: number;
  processedEntityTypes: number;
  foundCount: number;
  createdCount: number;
  percentage: number;
  message?: string;
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
  const [isDetecting, setIsDetecting] = useState(false);
  const [progress, setProgress] = useState<DetectionProgress | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const startDetection = useCallback(async (entityTypes: string[]) => {
    // Close any existing connection
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Get auth token from API client
    const authHeader = apiClient.getAuthToken();
    if (!authHeader) {
      onError?.('Authentication required');
      return;
    }

    setIsDetecting(true);
    setProgress(null);

    // Create new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // Build SSE URL
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    const url = `${apiUrl}/api/documents/${documentId}/detect-selections-stream`;

    console.log('[Detection] Starting with entity types:', entityTypes);

    try {
      await fetchEventSource(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader
        },
        body: JSON.stringify({ entityTypes }),
        signal: abortController.signal,

        onmessage(ev) {
          const data = JSON.parse(ev.data) as DetectionProgress;
          setProgress(data);
          onProgress?.(data);

          // Handle specific event types
          if (ev.event === 'detection-complete') {
            setIsDetecting(false);
            setProgress(null); // Clear progress to hide overlay
            onComplete?.(data);
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
        console.error('Failed to start detection:', error);
        setIsDetecting(false);
        onError?.('Failed to start detection');
      }
    }
  }, [documentId, onComplete, onError, onProgress]);

  const cancelDetection = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsDetecting(false);
    setProgress(null);
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