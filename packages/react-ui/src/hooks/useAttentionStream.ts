'use client';

import { useState, useRef, useEffect } from 'react';
import { accessToken } from '@semiont/core';
import { useApiClient } from '../contexts/ApiClientContext';
import { useAuthToken } from '../contexts/AuthTokenContext';
import type { StreamStatus } from './useResourceEvents';

export function useAttentionStream(): { status: StreamStatus } {
  const semiont = useApiClient();
  const token = useAuthToken();
  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; });
  const [status, setStatus] = useState<StreamStatus>('disconnected');

  useEffect(() => {
    setStatus('connecting');
    try {
      const stream = semiont.sse.attentionStream({
        auth: tokenRef.current ? accessToken(tokenRef.current) : undefined,
        eventBus: semiont.eventBus,
      });
      setStatus('connected');
      return () => { stream.close(); setStatus('disconnected'); };
    } catch (error) {
      console.error('[AttentionStream] Failed to connect:', error);
      setStatus('error');
      return;
    }
  }, [semiont]);

  return { status };
}
