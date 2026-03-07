/**
 * CodeMirror Inline Widgets
 *
 * Custom widgets for enhancing the document editing experience:
 * - Reference resolution indicators (resolved 🔗, generating ✨, stub ❓)
 *
 * Event handling uses delegation — no per-widget listeners.
 * Data attributes on the container enable CodeMirrorRenderer to handle
 * clicks and hovers via a single set of delegated handlers.
 */

import { WidgetType } from '@codemirror/view';
import type { components } from '@semiont/core';
import { isResolvedReference, getBodySource } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

/**
 * Reference Resolution Widget
 * Shows a small indicator next to references with hover preview.
 *
 * All event handling is delegated — the widget sets data attributes
 * and CodeMirrorRenderer handles events via container-level listeners.
 */
export class ReferenceResolutionWidget extends WidgetType {
  constructor(
    readonly annotation: Annotation,
    readonly targetDocumentName?: string,
    readonly isGenerating?: boolean
  ) {
    super();
  }

  override eq(other: ReferenceResolutionWidget) {
    const thisSource = getBodySource(this.annotation.body);
    const otherSource = getBodySource(other.annotation.body);
    return other.annotation.id === this.annotation.id &&
           otherSource === thisSource &&
           other.targetDocumentName === this.targetDocumentName &&
           other.isGenerating === this.isGenerating;
  }

  override toDOM() {
    const container = document.createElement('span');
    container.className = 'reference-preview-widget';
    container.style.cssText = `
      display: inline-flex;
      align-items: center;
      margin-left: 4px;
      position: relative;
    `;

    // Data attributes for delegated event handling
    const isResolved = isResolvedReference(this.annotation);
    const bodySource = getBodySource(this.annotation.body);
    container.dataset.widgetAnnotationId = this.annotation.id;
    container.dataset.widgetMotivation = this.annotation.motivation;
    container.dataset.widgetResolved = isResolved ? 'true' : 'false';
    if (bodySource) container.dataset.widgetBodySource = bodySource;
    if (this.targetDocumentName) container.dataset.widgetTargetName = this.targetDocumentName;
    if (this.isGenerating) container.dataset.widgetGenerating = 'true';

    // Use button element for keyboard accessibility
    const indicator = document.createElement('button');
    indicator.className = 'reference-indicator';
    indicator.type = 'button';

    if (isResolved) {
      indicator.innerHTML = '<span aria-hidden="true">🔗</span>';
      indicator.setAttribute('aria-label', this.targetDocumentName
        ? `Reference link to ${this.targetDocumentName}`
        : 'Reference link to document');
      indicator.title = this.targetDocumentName
        ? `Links to: ${this.targetDocumentName}`
        : 'Links to document';
      indicator.style.cssText = `
        font-size: 10px;
        cursor: pointer;
        opacity: 0.6;
        transition: opacity 0.2s ease;
        background: none;
        border: none;
        padding: 0;
        margin: 0;
        vertical-align: baseline;
      `;
    } else if (this.isGenerating) {
      // Create circled sparkle matching the text selection sparkle
      indicator.innerHTML = `
        <span style="position: relative; display: inline-flex; align-items: center; justify-content: center;" aria-hidden="true">
          <span style="position: absolute; inset: 0; border-radius: 9999px; background: rgb(250, 204, 21); opacity: 0.75; animation: ping 1s cubic-bezier(0, 0, 0.2, 1) infinite;"></span>
          <span style="position: relative; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 9999px; background: white; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); border: 2px solid rgb(250, 204, 21);">
            <span style="font-size: 14px;">✨</span>
          </span>
        </span>
      `;
      indicator.setAttribute('aria-label', 'Generating document');
      indicator.setAttribute('aria-busy', 'true');
      indicator.title = 'Generating document...';
      indicator.disabled = true;
      indicator.style.cssText = `
        cursor: default;
        display: inline-flex;
        vertical-align: middle;
        background: none;
        border: none;
        padding: 0;
        margin: 0;
      `;

      // Add dark mode support - check for Tailwind dark class
      if (document.documentElement.classList.contains('dark')) {
        const innerCircle = indicator.querySelector('span > span:last-child') as HTMLElement;
        if (innerCircle) {
          innerCircle.style.background = 'rgb(31, 41, 55)'; // gray-800
          innerCircle.style.borderColor = 'rgb(234, 179, 8)'; // yellow-500
        }
        const pingCircle = indicator.querySelector('span > span:first-child') as HTMLElement;
        if (pingCircle) {
          pingCircle.style.background = 'rgb(234, 179, 8)'; // yellow-500
        }
      }
    } else {
      indicator.innerHTML = '<span aria-hidden="true">❓</span>';
      indicator.setAttribute('aria-label', 'Stub reference - click to resolve');
      indicator.title = 'Stub reference. Click to resolve.';
      indicator.style.cssText = `
        font-size: 10px;
        cursor: pointer;
        opacity: 0.6;
        transition: opacity 0.2s ease;
        background: none;
        border: none;
        padding: 0;
        margin: 0;
        vertical-align: baseline;
      `;
    }

    container.appendChild(indicator);
    return container;
  }

  override ignoreEvent(event: Event): boolean {
    return event.type === 'click';
  }
}

/**
 * Show a tooltip preview on a widget container.
 * Called from delegated mouseenter handler in CodeMirrorRenderer.
 */
export function showWidgetPreview(container: HTMLElement, documentName: string): void {
  if (!documentName || documentName.trim() === '') return;

  const tooltip = document.createElement('div');
  tooltip.className = 'reference-tooltip';
  tooltip.textContent = `→ ${documentName}`;

  tooltip.style.cssText = `
    position: absolute;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%) translateY(-4px);
    padding: 4px 8px;
    background: rgba(0, 0, 0, 0.8);
    color: white;
    border-radius: 4px;
    font-size: 11px;
    white-space: nowrap;
    pointer-events: none;
    z-index: 1000;
    animation: fadeIn 0.2s ease;
  `;

  container.appendChild(tooltip);
}

/**
 * Hide the tooltip preview from a widget container.
 * Called from delegated mouseleave handler in CodeMirrorRenderer.
 */
export function hideWidgetPreview(container: HTMLElement): void {
  const tooltip = container.querySelector('.reference-tooltip');
  if (tooltip) tooltip.remove();
}
