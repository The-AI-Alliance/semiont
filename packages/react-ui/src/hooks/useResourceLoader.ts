'use client';

import { useState, useEffect, useMemo } from 'react';
import { readyValue } from '@semiont/sdk';
import type { Annotation, ResourceDescriptor, ResourceId } from '@semiont/core';
import type { SemiontClient } from '@semiont/sdk';
import { groupAnnotations } from '../lib/annotation-groups';
import type { AnnotationsCollection } from '../types/annotation-props';

export interface UseResourceLoaderResult {
  resource: ResourceDescriptor | undefined;
  annotations: AnnotationsCollection;
  loading: boolean;
  error: Error | null;
}

const EMPTY: AnnotationsCollection = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

/**
 * Load a resource + its annotations from a bare client — no page, no composite
 * state unit, no providers. The lightweight alternative to `ResourceViewerPage`
 * for a bring-your-own-session host; feed the result straight into `<ResourceViewer>`.
 *
 * `loading` is true until BOTH the resource and its annotation list have first
 * emitted; `annotations` is bucketed via the shared `groupAnnotations`. A null
 * client subscribes to nothing (stays loading) and re-subscribes when one arrives.
 */
export function useResourceLoader(client: SemiontClient | null, resourceId: ResourceId): UseResourceLoaderResult {
  const [resource, setResource] = useState<ResourceDescriptor | undefined>(undefined);
  const [rawAnnotations, setRawAnnotations] = useState<Annotation[] | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client) return;
    setResource(undefined);
    setRawAnnotations(undefined);
    setError(null);
    const onError = (e: unknown) => setError(e instanceof Error ? e : new Error(String(e)));
    // D1: failure arrives as a `failed` EMISSION — routed to the same error
    // state; pending/ready project to the value-or-undefined these setters
    // always took.
    const subs = [
      client.browse.resource(resourceId).subscribe((st) => {
        if (st.status === 'failed') onError(st.error);
        else setResource(readyValue(st));
      }),
      client.browse.annotations(resourceId).subscribe((st) => {
        if (st.status === 'failed') onError(st.error);
        else setRawAnnotations(readyValue(st));
      }),
    ];
    return () => { for (const s of subs) s.unsubscribe(); };
  }, [client, resourceId]);

  const annotations = useMemo(() => (rawAnnotations ? groupAnnotations(rawAnnotations) : EMPTY), [rawAnnotations]);
  const loading = resource === undefined || rawAnnotations === undefined;

  return { resource, annotations, loading, error };
}
