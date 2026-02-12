'use client';

import { createContext, useContext, useMemo, useEffect, type ReactNode } from 'react';
import mitt from 'mitt';
import type { ResourceEvent } from '@semiont/core';
import type { components, ResourceUri, Selector, SemiontApiClient } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];
type Motivation = components['schemas']['Motivation'];

interface SelectionData {
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
 * Unified event map for all application events
 *
 * Consolidates events from:
 * - MakeMeaningEventBus (document/annotation operations)
 * - NavigationEventBus (navigation and sidebar UI)
 * - GlobalSettingsEventBus (app-wide settings)
 */
export type EventMap = {
  // ===== BACKEND EVENTS (from SSE) =====

  // Generic event (all types)
  'make-meaning:event': ResourceEvent;

  // Detection events
  'detection:started': Extract<ResourceEvent, { type: 'job.started' }>;
  'detection:progress': Extract<ResourceEvent, { type: 'job.progress' }>;
  'detection:entity-found': Extract<ResourceEvent, { type: 'annotation.added' }>;
  'detection:completed': Extract<ResourceEvent, { type: 'job.completed' }>;
  'detection:failed': Extract<ResourceEvent, { type: 'job.failed' }>;

  // Generation events
  'generation:started': Extract<ResourceEvent, { type: 'job.started' }>;
  'generation:progress': Extract<ResourceEvent, { type: 'job.progress' }>;
  'generation:resource-created': Extract<ResourceEvent, { type: 'resource.created' }>;
  'generation:completed': Extract<ResourceEvent, { type: 'job.completed' }>;

  // Annotation events (backend)
  'annotation:added': Extract<ResourceEvent, { type: 'annotation.added' }>;
  'annotation:removed': Extract<ResourceEvent, { type: 'annotation.removed' }>;
  'annotation:updated': Extract<ResourceEvent, { type: 'annotation.body.updated' }>;

  // Entity tag events (backend)
  'entity-tag:added': Extract<ResourceEvent, { type: 'entitytag.added' }>;
  'entity-tag:removed': Extract<ResourceEvent, { type: 'entitytag.removed' }>;

  // Resource events (backend)
  'resource:archived': Extract<ResourceEvent, { type: 'resource.archived' }>;
  'resource:unarchived': Extract<ResourceEvent, { type: 'resource.unarchived' }>;

  // ===== USER INTERACTION EVENTS =====

  // Selection events (user highlighting text/regions)
  'selection:comment-requested': SelectionData;
  'selection:tag-requested': SelectionData;
  'selection:assessment-requested': SelectionData;
  'selection:reference-requested': SelectionData;

  // Unified annotation request event (all motivations)
  'annotation:requested': {
    selector: Selector | Selector[];
    motivation: Motivation;
  };

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

  // Toolbar events (annotation UI controls)
  'toolbar:selection-changed': { motivation: string | null };
  'toolbar:click-changed': { action: string };
  'toolbar:shape-changed': { shape: string };

  // Navigation events (sidebar UI)
  'navigation:sidebar-toggle': void;
  'navigation:resource-close': { resourceId: string };
  'navigation:resource-reorder': { oldIndex: number; newIndex: number };
  'navigation:link-clicked': { href: string; label?: string };
  'navigation:router-push': { path: string; reason?: string };
  'navigation:external-navigate': { url: string; resourceId?: string };

  // Settings events (app-wide)
  'settings:theme-changed': { theme: 'light' | 'dark' | 'system' };
  'settings:line-numbers-toggled': void;
  'settings:locale-changed': { locale: string };

  // ===== API OPERATION EVENTS =====

  // Resource operations
  'resource:archive': void;
  'resource:unarchive': void;
  'resource:clone': void;

  // Job control
  'job:cancel-requested': { jobType: 'detection' | 'generation' };

  // Annotation CRUD operations
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

  // Detection operations
  'detection:start': {
    motivation: Motivation;
    options: {
      instructions?: string;
      tone?: 'neutral' | 'supportive' | 'critical';
      density?: number;
      entityTypes?: string[];
      includeDescriptiveReferences?: boolean;
      schemaId?: string;
      categories?: string[];
    };
  };
  'detection:complete': { motivation: Motivation };
  'detection:cancelled': void;

  // Reference operations
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

type EventBus = ReturnType<typeof mitt<EventMap>>;

const EventBusContext = createContext<EventBus | null>(null);

export interface EventBusProviderProps {
  children: ReactNode;

  // Optional dependencies for operation handlers (from MakeMeaningEventBus)
  rUri?: ResourceUri;
  client?: SemiontApiClient;
}

/**
 * Unified event bus provider for all application events
 *
 * Consolidates three previous event buses:
 * - MakeMeaningEventBus (document/annotation operations)
 * - NavigationEventBus (navigation and sidebar UI)
 * - GlobalSettingsEventBus (app-wide settings)
 *
 * Benefits:
 * - Single import: useEventBus()
 * - No decision fatigue about which bus to use
 * - Easier cross-domain coordination
 * - Simpler provider hierarchy
 */
export function EventBusProvider({
  children,
  rUri,
  client,
}: EventBusProviderProps) {
  const eventBus = useMemo(() => mitt<EventMap>(), []);

  // Set up operation handlers if client is provided (from MakeMeaningEventBusContext logic)
  useEffect(() => {
    if (!client || !rUri) return;

    // Import event operation handlers
    const { setupEventOperations } = require('./useEventOperations');
    const cleanup = setupEventOperations(eventBus, {
      rUri,
      client,
    });

    return cleanup;
  }, [eventBus, rUri, client]);

  return (
    <EventBusContext.Provider value={eventBus}>
      {children}
    </EventBusContext.Provider>
  );
}

/**
 * Hook to access the unified event bus
 *
 * Use this everywhere instead of:
 * - useMakeMeaningEvents()
 * - useNavigationEvents()
 * - useGlobalSettingsEvents()
 *
 * @example
 * ```typescript
 * const eventBus = useEventBus();
 *
 * // Emit any event
 * eventBus.emit('annotation:hover', { annotationId: '123' });
 * eventBus.emit('navigation:sidebar-toggle');
 * eventBus.emit('settings:theme-changed', { theme: 'dark' });
 *
 * // Subscribe to any event
 * useEffect(() => {
 *   const handler = ({ annotationId }) => console.log(annotationId);
 *   eventBus.on('annotation:hover', handler);
 *   return () => eventBus.off('annotation:hover', handler);
 * }, [eventBus]);
 * ```
 */
export function useEventBus(): EventBus {
  const bus = useContext(EventBusContext);
  if (!bus) {
    throw new Error('useEventBus must be used within EventBusProvider');
  }
  return bus;
}
