/**
 * Event handler logic extracted from CodeMirrorRenderer
 *
 * These functions handle click and hover interactions on annotations
 * and widgets within the CodeMirror editor. They operate on plain DOM
 * elements and a SemiontSession — no CodeMirror API dependency.
 */

import type { Motivation } from '@semiont/core';
import type { SemiontSession } from '@semiont/api-client';
import type { TextSegment } from './codemirror-logic';

/**
 * Handle click on an annotation element.
 * Looks up the segment by annotation ID, then emits browse:click.
 *
 * @returns true if the click was handled (an annotation was clicked), false otherwise
 */
export function handleAnnotationClick(
  target: HTMLElement,
  segmentsById: Map<string, TextSegment>,
  session: SemiontSession
): boolean {
  const annotationElement = target.closest('[data-annotation-id]');
  const annotationId = annotationElement?.getAttribute('data-annotation-id');

  if (!annotationId) return false;

  const segment = segmentsById.get(annotationId);
  if (!segment?.annotation) return false;

  session.client.emit('browse:click', {
    annotationId,
    motivation: segment.annotation.motivation,
  });
  return true;
}

/**
 * Result of processing a widget click
 */
export interface WidgetClickResult {
  handled: boolean;
  action?: 'navigate' | 'browse-click';
  resourceId?: string;
  annotationId?: string;
  motivation?: Motivation;
}

/**
 * Handle click on a reference preview widget.
 * Determines whether to navigate (resolved) or browse-click (unresolved).
 */
export function handleWidgetClick(target: HTMLElement): WidgetClickResult {
  const widget = target.closest('.reference-preview-widget') as HTMLElement | null;
  if (!widget || widget.dataset.widgetGenerating === 'true') {
    return { handled: false };
  }

  const annotationId = widget.dataset.widgetAnnotationId;
  const bodySource = widget.dataset.widgetBodySource;
  const isResolved = widget.dataset.widgetResolved === 'true';

  if (!annotationId) return { handled: false };

  if (isResolved && bodySource) {
    return {
      handled: true,
      action: 'navigate',
      resourceId: bodySource,
      annotationId,
    };
  }

  return {
    handled: true,
    action: 'browse-click',
    annotationId,
    motivation: (widget.dataset.widgetMotivation as Motivation) || 'linking',
  };
}

/**
 * Dispatch a widget click result to the session bus
 */
export function dispatchWidgetClick(result: WidgetClickResult, session: SemiontSession): void {
  if (!result.handled) return;

  if (result.action === 'navigate' && result.resourceId) {
    session.client.emit('browse:reference-navigate', { resourceId: result.resourceId });
  } else if (result.action === 'browse-click' && result.annotationId) {
    session.client.emit('browse:click', {
      annotationId: result.annotationId,
      motivation: result.motivation || 'linking',
    });
  }
}

/**
 * Handle mouseenter on a widget — show preview tooltip for resolved references
 */
export function handleWidgetMouseEnter(target: HTMLElement): {
  showPreview: boolean;
  targetName?: string;
  widget: HTMLElement | null;
} {
  const widget = target.closest('.reference-preview-widget') as HTMLElement | null;
  if (!widget || widget.dataset.widgetGenerating === 'true') {
    return { showPreview: false, widget: null };
  }

  // Raise indicator opacity
  const indicator = widget.querySelector('.reference-indicator') as HTMLElement | null;
  if (indicator) indicator.style.opacity = '1';

  if (widget.dataset.widgetResolved === 'true' && widget.dataset.widgetTargetName) {
    return {
      showPreview: true,
      targetName: widget.dataset.widgetTargetName,
      widget,
    };
  }

  return { showPreview: false, widget };
}

/**
 * Handle mouseleave on a widget — hide preview tooltip
 */
export function handleWidgetMouseLeave(target: HTMLElement): {
  hidePreview: boolean;
  widget: HTMLElement | null;
} {
  const widget = target.closest('.reference-preview-widget') as HTMLElement | null;
  if (!widget) {
    return { hidePreview: false, widget: null };
  }

  const indicator = widget.querySelector('.reference-indicator') as HTMLElement | null;
  if (indicator) indicator.style.opacity = '0.6';

  if (widget.dataset.widgetResolved === 'true') {
    return { hidePreview: true, widget };
  }

  return { hidePreview: false, widget };
}
