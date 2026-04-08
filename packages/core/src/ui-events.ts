/**
 * UI Events
 *
 * Frontend-only events that never leave the browser.
 * Toolbar state, panel navigation, selection gestures, settings.
 *
 * For wire protocol events, see wire-protocol.ts.
 * For internal actor commands, see actor-protocol.ts.
 */

import type { components } from './types';
import type { Selector, SelectionData } from './wire-protocol';

type Motivation = components['schemas']['Motivation'];

/**
 * Frontend-only UI events — never cross HTTP.
 *
 * Organized by flow (verb).
 */
export type UIEvents = {

  // ========================================================================
  // MARK FLOW — selection gestures, toolbar, assist UI
  // ========================================================================

  // Selection requests (user highlighting text)
  'mark:select-comment': SelectionData;
  'mark:select-tag': SelectionData;
  'mark:select-assessment': SelectionData;
  'mark:select-reference': SelectionData;

  // Unified annotation request (all motivations)
  'mark:requested': {
    selector: Selector | Selector[];
    motivation: Motivation;
  };
  'mark:cancel-pending': void;

  // Frontend panel submit — decomposed fields sent to backend via HTTP
  'mark:submit': {
    motivation: Motivation;
    selector: Selector | Selector[];
    body: components['schemas']['AnnotationBody'][];
  };

  // AI-assisted annotation request
  'mark:assist-request': {
    motivation: Motivation;
    options: {
      instructions?: string;
      tone?: 'scholarly' | 'explanatory' | 'conversational' | 'technical' | 'analytical' | 'critical' | 'balanced' | 'constructive';
      density?: number;
      language?: string;
      entityTypes?: string[];
      includeDescriptiveReferences?: boolean;
      schemaId?: string;
      categories?: string[];
    };
  };
  'mark:assist-cancelled': void;
  'mark:progress-dismiss': void;

  // Toolbar state (annotation UI controls)
  'mark:mode-toggled': void;
  'mark:selection-changed': { motivation: string | null };
  'mark:click-changed': { action: string };
  'mark:shape-changed': { shape: string };

  // ========================================================================
  // BROWSE FLOW — panel, sidebar, and navigation
  // ========================================================================

  'browse:click': { annotationId: string; motivation: Motivation };

  // Right toolbar panels
  'browse:panel-toggle': { panel: string };
  'browse:panel-open': { panel: string; scrollToAnnotationId?: string; motivation?: string };
  'browse:panel-close': void;

  // Left sidebar navigation
  'browse:sidebar-toggle': void;
  'browse:resource-close': { resourceId: string };
  'browse:resource-reorder': { oldIndex: number; newIndex: number };
  'browse:link-clicked': { href: string; label?: string };
  'browse:router-push': { path: string; reason?: string };
  'browse:external-navigate': { url: string; resourceId?: string; cancelFallback: () => void };
  'browse:reference-navigate': { resourceId: string };
  'browse:entity-type-clicked': { entityType: string };

  // ========================================================================
  // BECKON FLOW — annotation attention (hover/click/focus)
  // ========================================================================

  'beckon:hover': { annotationId: string | null };
  'beckon:focus': { annotationId?: string; resourceId?: string };
  'beckon:sparkle': { annotationId: string };

  // ========================================================================
  // SETTINGS
  // ========================================================================

  'settings:theme-changed': { theme: 'light' | 'dark' | 'system' };
  'settings:line-numbers-toggled': void;
  'settings:locale-changed': { locale: string };
  'settings:hover-delay-changed': { hoverDelayMs: number };
};
