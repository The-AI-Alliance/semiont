import { useEffect, useState } from 'react';
import type { ResourceDescriptor, ResourceId, components } from '@semiont/core';
import { getPrimaryMediaType } from '@semiont/core';
import { decodeWithCharset } from '@semiont/api-client';
import { useToast } from '../components/Toast';
import { useSemiont } from '../session/SemiontProvider';
import { useObservable } from './useObservable';

export interface UseResourceContentResult {
  content: string;
  loading: boolean;
}

export function useResourceContent(
  rUri: ResourceId,
  resource: ResourceDescriptor,
  enabled = true
): UseResourceContentResult {
  const { showError } = useToast();
  const semiont = useObservable(useSemiont().activeSession$)?.client;
  const mediaType = enabled ? (getPrimaryMediaType(resource) || 'text/plain') : '';

  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!semiont || !enabled || !mediaType) return;
    let cancelled = false;
    setLoading(true);
    semiont.getResourceRepresentation(rUri, {
      accept: mediaType as components['schemas']['ContentFormat'],
    }).then(({ data }) => {
      if (cancelled) return;
      setContent(decodeWithCharset(data, mediaType));
      setLoading(false);
    }).catch((error) => {
      if (cancelled) return;
      console.error('Failed to fetch representation:', error);
      showError('Failed to load resource representation');
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [semiont, rUri, mediaType, enabled, showError]);

  return { content, loading };
}
