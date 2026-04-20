import { useEffect, useState } from 'react';
import type { ResourceId } from '@semiont/core';
import { getPrimaryMediaType, decodeWithCharset } from '@semiont/api-client';
import { useToast } from '../components/Toast';
import { useSemiont } from '../session/SemiontProvider';
import { useObservable } from './useObservable';
import type { components } from '@semiont/core';

type SemiontResource = components['schemas']['ResourceDescriptor'];

export interface UseResourceContentResult {
  content: string;
  loading: boolean;
}

export function useResourceContent(
  rUri: ResourceId,
  resource: SemiontResource,
  enabled = true
): UseResourceContentResult {
  const { showError } = useToast();
  const semiont = useObservable(useSemiont().activeSession$)?.client;
  const mediaType = enabled ? (getPrimaryMediaType(resource) || 'text/plain') : '';

  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!semiont || !enabled || !mediaType) return;
    setLoading(true);
    semiont.getResourceRepresentation(rUri, {
      accept: mediaType as components['schemas']['ContentFormat'],
    }).then(({ data }) => {
      setContent(decodeWithCharset(data, mediaType));
      setLoading(false);
    }).catch((error) => {
      console.error('Failed to fetch representation:', error);
      showError('Failed to load resource representation');
      setLoading(false);
    });
  }, [semiont, rUri, mediaType, enabled, showError]);

  return { content, loading };
}
