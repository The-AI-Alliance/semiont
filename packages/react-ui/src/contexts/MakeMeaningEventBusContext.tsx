'use client';

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import mitt from 'mitt';
import { useResourceEvents } from '../hooks/useResourceEvents';
import type { ResourceEvent } from '@semiont/core';
import type { ResourceUri, SemiontApiClient } from '@semiont/api-client';
import { useEventOperations } from './useEventOperations';

/**
 * Selection data for annotation creation
 */
export interface SelectionData {
  exact: string;
  start: number;
  end: number;
  svgSelector?: string;
  fragmentSelector?: string;
  conformsTo?: string;
  prefix?: string;
  suffix?: string;
}

import type { components, Selector, Motivation } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

/**
 * Unified event map for all events (backend + UI + operations)
 *
 * Event naming philosophy: Events are named by what they represent, not by
 * implementation category. The line between "UI" and "domain" is blurry and
 * changes over time - don't encode it in event names.
 *
 * Backend events: Make-meaning's event-sourced domain events from SSE
 * UI events: Local user interactions (will enable real-time collaboration)
 * Operation events: User-initiated operations that trigger API calls
 */
export type MakeMeaningEventMap = {
  // Generic event (all types)
  'make-meaning:event': ResourceEvent;

  // Detection semantics (backend events from SSE)
  'detection:started': Extract<ResourceEvent, { type: 'job.started' }>;
  'detection:progress': Extract<ResourceEvent, { type: 'job.progress' }>;
  'detection:entity-found': Extract<ResourceEvent, { type: 'annotation.added' }>;
  'detection:completed': Extract<ResourceEvent, { type: 'job.completed' }>;
  'detection:failed': Extract<ResourceEvent, { type: 'job.failed' }>;

  // Generation semantics (backend events from SSE)
  'generation:started': Extract<ResourceEvent, { type: 'job.started' }>;
  'generation:progress': Extract<ResourceEvent, { type: 'job.progress' }>;
  'generation:resource-created': Extract<ResourceEvent, { type: 'resource.created' }>;
  'generation:completed': Extract<ResourceEvent, { type: 'job.completed' }>;

  // Annotation semantics (backend events from SSE)
  'annotation:added': Extract<ResourceEvent, { type: 'annotation.added' }>;
  'annotation:removed': Extract<ResourceEvent, { type: 'annotation.removed' }>;
  'annotation:updated': Extract<ResourceEvent, { type: 'annotation.body.updated' }>;

  // Entity tag semantics (backend events)
  'entity-tag:added': Extract<ResourceEvent, { type: 'entitytag.added' }>;
  'entity-tag:removed': Extract<ResourceEvent, { type: 'entitytag.removed' }>;

  // Resource semantics (backend events)
  'resource:archived': Extract<ResourceEvent, { type: 'resource.archived' }>;
  'resource:unarchived': Extract<ResourceEvent, { type: 'resource.unarchived' }>;

  // Resource operation events (user-initiated API calls)
  'resource:archive': void;
  'resource:unarchive': void;
  'resource:clone': void;

  // Selection events - User highlighting text/regions
  'selection:comment-requested': SelectionData;
  'selection:tag-requested': SelectionData;
  'selection:assessment-requested': SelectionData;
  'selection:reference-requested': SelectionData;

  // Annotation interaction events
  'annotation:cancel-pending': void;
  'annotation:hover': { annotationId: string | null };
  'comment:hover': { commentId: string | null };
  'annotation:click': { annotationId: string };
  'annotation:focus': { annotationId: string | null };
  'annotation:ref-update': { annotationId: string; element: HTMLElement | null };
  'annotation:sparkle': { annotationId: string };

  // Panel management events
  'panel:toggle': { panel: string };
  'panel:open': { panel: string };
  'panel:close': void;

  // View mode events
  'view:mode-toggled': void;

  // Job control events
  'job:cancel-requested': { jobType: 'detection' | 'generation' };

  // Annotation operation events (user-initiated API calls)
  'annotation:create': {
    motivation: Motivation;
    selector: Selector | Selector[];
    body: any[];
  };
  'annotation:created': { annotation: Annotation };
  'annotation:create-failed': { error: Error };
  'annotation:delete': { annotationId: string };
  'annotation:deleted': { annotationId: string };
  'annotation:delete-failed': { error: Error };
  'annotation:update-body': {
    annotationUri: string;
    resourceId: string;
    operations: Array<{
      op: 'add' | 'remove' | 'replace';
      item?: any;
      oldItem?: any;
      newItem?: any;
    }>;
  };
  'annotation:body-updated': { annotationUri: string };
  'annotation:body-update-failed': { error: Error };

  // Detection operation events (user-initiated detection)
  'detection:start': {
    motivation: Motivation;
    options: {
      // Highlights, Comments, Assessments
      instructions?: string;
      tone?: 'neutral' | 'supportive' | 'critical';
      density?: number;

      // References
      entityTypes?: string[];
      includeDescriptiveReferences?: boolean;

      // Tags
      schemaId?: string;
      categories?: string[];
    };
  };
  'detection:complete': { motivation: Motivation };
  'detection:cancelled': void;

  // Reference operation events
  'reference:generate': {
    annotationUri: string;
    resourceUri: string;
    options: { title: string; prompt?: string; language?: string; temperature?: number; maxTokens?: number };
  };
  'reference:generation-progress': { chunk: any };
  'reference:generation-complete': { annotationUri: string };
  'reference:generation-failed': { error: Error };
  'reference:create-manual': {
    annotationUri: string;
    title: string;
    entityTypes: string[];
  };
  'reference:link': {
    annotationUri: string;
    searchTerm: string;
  };
  'reference:search-modal-open': {
    referenceId: string;
    searchTerm: string;
  };
};

type EventBus = ReturnType<typeof mitt<MakeMeaningEventMap>>;

const MakeMeaningEventBusContext = createContext<EventBus | null>(null);

export interface MakeMeaningEventBusProviderProps {
  rUri: ResourceUri;
  children: ReactNode;

  // API dependencies for operation events
  client?: SemiontApiClient;

  // Callbacks for state updates (React Query invalidation, toasts, etc.)
  onAnnotationCreated?: (annotation: Annotation) => void;
  onAnnotationDeleted?: (annotationId: string) => void;
  onDetectionProgress?: (progress: any) => void;
  onError?: (error: Error, operation: string) => void;
  onSuccess?: (message: string) => void;
}

/**
 * Unified event bus provider for all events (backend + UI)
 *
 * Backend events: Make-meaning's event-sourced domain events from SSE
 * UI events: Local user interactions (enables real-time collaboration)
 *
 * This unified bus allows:
 * 1. Components to emit UI events (selections, requests)
 * 2. Other components to react to those events
 * 3. Backend events to flow through the same bus
 * 4. Foundation for peer-to-peer real-time collaboration
 */
export function MakeMeaningEventBusProvider({
  rUri,
  children,
  client,
  onAnnotationCreated,
  onAnnotationDeleted,
  onDetectionProgress,
  onError,
  onSuccess,
}: MakeMeaningEventBusProviderProps) {
  // Create event bus (one per resource page)
  const eventBus = useMemo(() => mitt<MakeMeaningEventMap>(), []);

  // Set up operation event handlers (coordinates API calls)
  useEventOperations(eventBus, {
    client,
    resourceUri: rUri,
    onAnnotationCreated,
    onAnnotationDeleted,
    onDetectionProgress,
    onError,
    onSuccess,
  });

  // Connect to backend SSE (which streams make-meaning events)
  const { status, eventCount } = useResourceEvents({
    rUri,
    // Receive make-meaning events and translate to semantic event names
    onEvent: (event: ResourceEvent) => {
      // Emit generic event
      eventBus.emit('make-meaning:event', event);

      // Translate to semantic events based on job type and event type
      if (event.type === 'job.started') {
        if (event.payload.jobType === 'detection') {
          eventBus.emit('detection:started', event);
        } else if (event.payload.jobType === 'generation') {
          eventBus.emit('generation:started', event);
        }
      }

      if (event.type === 'job.progress') {
        if (event.payload.jobType === 'detection') {
          eventBus.emit('detection:progress', event);
        } else if (event.payload.jobType === 'generation') {
          eventBus.emit('generation:progress', event);
        }
      }

      if (event.type === 'job.completed') {
        if (event.payload.jobType === 'detection') {
          eventBus.emit('detection:completed', event);
        } else if (event.payload.jobType === 'generation') {
          eventBus.emit('generation:completed', event);
        }
      }

      if (event.type === 'job.failed') {
        if (event.payload.jobType === 'detection') {
          eventBus.emit('detection:failed', event);
        }
      }

      // Annotation events (direct make-meaning semantics)
      if (event.type === 'annotation.added') {
        // Also emit as detection:entity-found if this came from detection
        eventBus.emit('annotation:added', event);
        eventBus.emit('detection:entity-found', event);
      }

      if (event.type === 'annotation.removed') {
        eventBus.emit('annotation:removed', event);
      }

      if (event.type === 'annotation.body.updated') {
        eventBus.emit('annotation:updated', event);
      }

      // Entity tag events
      if (event.type === 'entitytag.added') {
        eventBus.emit('entity-tag:added', event);
      }

      if (event.type === 'entitytag.removed') {
        eventBus.emit('entity-tag:removed', event);
      }

      // Resource events
      if (event.type === 'resource.archived') {
        eventBus.emit('resource:archived', event);
      }

      if (event.type === 'resource.unarchived') {
        eventBus.emit('resource:unarchived', event);
      }

      if (event.type === 'resource.created') {
        eventBus.emit('generation:resource-created', event);
      }
    }
  });

  // Log connection status (make-meaning event stream status)
  useEffect(() => {
    console.log(`[MakeMeaning EventBus] SSE status: ${status}, events received: ${eventCount}`);
  }, [status, eventCount]);

  return (
    <MakeMeaningEventBusContext.Provider value={eventBus}>
      {children}
    </MakeMeaningEventBusContext.Provider>
  );
}

/**
 * Hook to access make-meaning event bus
 *
 * Use this to subscribe to make-meaning's domain events directly.
 * Think in detection, generation, annotation semantics - not HTTP.
 *
 * @example
 * ```typescript
 * const eventBus = useMakeMeaningEvents();
 *
 * useEffect(() => {
 *   // Listen to make-meaning's detection progress
 *   const handler = (event) => {
 *     console.log('Make-meaning is detecting:', event.payload.currentStep);
 *     console.log('Found so far:', event.payload.foundCount);
 *   };
 *
 *   eventBus.on('detection:progress', handler);
 *   return () => eventBus.off('detection:progress', handler);
 * }, [eventBus]);
 * ```
 */
export function useMakeMeaningEvents(): EventBus {
  const bus = useContext(MakeMeaningEventBusContext);
  if (!bus) {
    throw new Error('useMakeMeaningEvents must be used within MakeMeaningEventBusProvider');
  }
  return bus;
}
