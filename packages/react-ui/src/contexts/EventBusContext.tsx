'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import mitt from 'mitt';
import type { ResourceEvent } from '@semiont/core';
import type { components, Selector, ResourceUri } from '@semiont/api-client';

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
  'annotation:dom-hover': { annotationId: string | null }; // Raw DOM hover event from resource overlays (internal routing)
  'annotation:hover': { annotationId: string | null }; // Bidirectional hover: annotation overlay ↔ panel entry
  'annotation:click': { annotationId: string; motivation: Motivation }; // Click on annotation - includes motivation for panel coordination
  'annotation:focus': { annotationId: string | null };
  'annotation:sparkle': { annotationId: string };

  // Panel management events
  'panel:toggle': { panel: string };
  'panel:open': { panel: string; scrollToAnnotationId?: string; motivation?: string };
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
  'navigation:reference-navigate': { documentId: string };
  'navigation:entity-type-clicked': { entityType: string };

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
  'detection:complete': { motivation?: Motivation; resourceUri?: ResourceUri; progress?: any };
  'detection:cancelled': void;
  'detection:dismiss-progress': void;

  // Resource generation operations (unified event-driven flow)
  'generation:start': {
    annotationUri: string;
    resourceUri: string;
    options: {
      title: string;
      prompt?: string;
      language?: string;
      temperature?: number;
      maxTokens?: number;
      context: any; // GenerationContext - required for generation
    };
  };
  'generation:progress': any; // GenerationProgress from SSE
  'generation:complete': { annotationUri: string; progress: any };
  'generation:failed': { error: Error };
  'generation:modal-open': {
    annotationUri: string;
    resourceUri: string;
    defaultTitle: string;
  };
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

export type EventBus = ReturnType<typeof mitt<EventMap>> & { busId: string };

const EventBusContext = createContext<EventBus | null>(null);

/**
 * Generate an 8-digit hex identifier for an event bus instance
 */
function generateBusId(): string {
  return Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, '0');
}

/**
 * Create an EventBus instance with logging and unique identifier
 */
function createEventBus(): EventBus {
  const bus = mitt<EventMap>() as EventBus;
  const busId = generateBusId();

  // Add busId property
  bus.busId = busId;

  // Wrap emit to add logging with busId
  const originalEmit = bus.emit.bind(bus);
  bus.emit = ((eventName: any, payload?: any) => {
    console.info(`[EventBus:${busId}] emit:`, eventName, payload);
    return originalEmit(eventName, payload);
  }) as any;

  // Wrap on to add logging with busId
  const originalOn = bus.on.bind(bus);
  bus.on = ((eventName: any, handler: any) => {
    console.debug(`[EventBus:${busId}] subscribe:`, eventName);
    return originalOn(eventName, handler);
  }) as any;

  // Wrap off to add logging with busId
  const originalOff = bus.off.bind(bus);
  bus.off = ((eventName: any, handler?: any) => {
    console.debug(`[EventBus:${busId}] unsubscribe:`, eventName);
    return originalOff(eventName, handler);
  }) as any;

  return bus;
}

/**
 * Global singleton event bus.
 *
 * This ensures all components in the application share the same event bus instance,
 * which is critical for cross-component communication (e.g., hovering an annotation
 * in one component scrolls the panel in another component).
 *
 * FUTURE: Multi-Window Support
 * When we need to support multiple document windows (e.g., pop-out resource viewers),
 * we'll need to transition to a per-window event bus architecture:
 *
 * Option 1: Window-scoped event bus
 *   - Create a new event bus for each window/portal
 *   - Pass windowId or documentId to EventBusProvider
 *   - Store Map<windowId, EventBus> instead of single global
 *   - Components use useEventBus(windowId) to get correct bus
 *
 * Option 2: Event bus hierarchy
 *   - Global event bus for app-wide events (settings, navigation)
 *   - Per-document event bus for document-specific events (annotation hover)
 *   - Components subscribe to both buses as needed
 *
 * Option 3: Cross-window event bridge
 *   - Keep per-window buses isolated
 *   - Use BroadcastChannel or postMessage for cross-window events
 *   - Bridge pattern to sync certain events across windows
 *
 * For now, single global bus is correct for single-window app.
 */
let globalEventBus = createEventBus();

/**
 * Reset the global event bus - FOR TESTING ONLY.
 *
 * Call this in test setup (beforeEach) to ensure test isolation.
 * Each test gets a fresh event bus with no lingering subscriptions.
 *
 * @example
 * ```typescript
 * beforeEach(() => {
 *   resetEventBusForTesting();
 * });
 * ```
 */
export function resetEventBusForTesting() {
  globalEventBus = createEventBus();
}

export interface EventBusProviderProps {
  children: ReactNode;
  // rUri and client removed - operation handlers are now set up via useResolutionFlow hook
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
 *
 * NOTE: This provider uses a global singleton event bus to ensure all components
 * share the same instance. Multiple providers in the tree will all reference the
 * same global bus.
 *
 * Operation handlers (API calls triggered by events) are set up separately via
 * the useResolutionFlow hook, which should be called at the resource page level.
 */
export function EventBusProvider({
  children,
}: EventBusProviderProps) {
  const eventBus = useMemo(() => globalEventBus, []);

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
 * eventBus.emit('navigation:sidebar-toggle', undefined);
 * eventBus.emit('settings:theme-changed', { theme: 'dark' });
 *
 * // Subscribe to any event
 * useEffect(() => {
 *   const handler = ({ annotationId }) => console.log(annotationId);
 *   eventBus.on('annotation:hover', handler);
 *   return () => eventBus.off('annotation:hover', handler);
 * }, []);
 * ```
 */
export function useEventBus(): EventBus {
  const bus = useContext(EventBusContext);
  if (!bus) {
    throw new Error('useEventBus must be used within EventBusProvider');
  }
  return bus;
}
