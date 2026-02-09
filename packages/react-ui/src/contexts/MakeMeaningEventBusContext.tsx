'use client';

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import mitt from 'mitt';
import { useResourceEvents } from '../hooks/useResourceEvents';
import type { ResourceEvent } from '@semiont/core';
import type { ResourceUri } from '@semiont/api-client';

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

/**
 * Unified event map for all events (backend + UI)
 *
 * Backend events: Make-meaning's event-sourced domain events from SSE
 * UI events: Local user interactions that will enable real-time collaboration
 */
type MakeMeaningEventMap = {
  // Generic event (all types)
  'make-meaning:event': ResourceEvent;

  // Detection semantics (backend events)
  'detection:started': Extract<ResourceEvent, { type: 'job.started' }>;
  'detection:progress': Extract<ResourceEvent, { type: 'job.progress' }>;
  'detection:entity-found': Extract<ResourceEvent, { type: 'annotation.added' }>;
  'detection:completed': Extract<ResourceEvent, { type: 'job.completed' }>;
  'detection:failed': Extract<ResourceEvent, { type: 'job.failed' }>;

  // Generation semantics (backend events)
  'generation:started': Extract<ResourceEvent, { type: 'job.started' }>;
  'generation:progress': Extract<ResourceEvent, { type: 'job.progress' }>;
  'generation:resource-created': Extract<ResourceEvent, { type: 'resource.created' }>;
  'generation:completed': Extract<ResourceEvent, { type: 'job.completed' }>;

  // Annotation semantics (backend events)
  'annotation:added': Extract<ResourceEvent, { type: 'annotation.added' }>;
  'annotation:removed': Extract<ResourceEvent, { type: 'annotation.removed' }>;
  'annotation:updated': Extract<ResourceEvent, { type: 'annotation.body.updated' }>;

  // Entity tag semantics (backend events)
  'entity-tag:added': Extract<ResourceEvent, { type: 'entitytag.added' }>;
  'entity-tag:removed': Extract<ResourceEvent, { type: 'entitytag.removed' }>;

  // Resource semantics (backend events)
  'resource:archived': Extract<ResourceEvent, { type: 'resource.archived' }>;
  'resource:unarchived': Extract<ResourceEvent, { type: 'resource.unarchived' }>;

  // UI events - Local user interactions (will enable real-time collaboration)
  'ui:selection:comment-requested': SelectionData;
  'ui:selection:tag-requested': SelectionData;
  'ui:selection:assessment-requested': SelectionData;
  'ui:selection:reference-requested': SelectionData;
};

type EventBus = ReturnType<typeof mitt<MakeMeaningEventMap>>;

const MakeMeaningEventBusContext = createContext<EventBus | null>(null);

export interface MakeMeaningEventBusProviderProps {
  rUri: ResourceUri;
  children: ReactNode;
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
  children
}: MakeMeaningEventBusProviderProps) {
  // Create event bus (one per resource page)
  const eventBus = useMemo(() => mitt<MakeMeaningEventMap>(), []);

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
