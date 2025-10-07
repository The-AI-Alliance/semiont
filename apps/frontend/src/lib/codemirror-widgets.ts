/**
 * CodeMirror Inline Widgets
 *
 * Custom widgets for enhancing the document editing experience:
 * - Wiki link pills (clickable, styled)
 * - Reference previews (hover for context)
 * - Entity type badges
 */

import { WidgetType, Decoration, EditorView } from '@codemirror/view';
import type { AnnotationSelection } from '@/components/CodeMirrorRenderer';

/**
 * Reference Resolution Widget
 * Shows a small indicator next to references with hover preview
 */
export class ReferenceResolutionWidget extends WidgetType {
  constructor(
    readonly annotation: AnnotationSelection,
    readonly targetDocumentName?: string,
    readonly onNavigate?: (documentId: string) => void,
    readonly onUnresolvedClick?: (annotation: AnnotationSelection) => void,
    readonly isGenerating?: boolean
  ) {
    super();
  }

  override eq(other: ReferenceResolutionWidget) {
    return other.annotation.id === this.annotation.id &&
           other.annotation.referencedDocumentId === this.annotation.referencedDocumentId &&
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

    // Use button element for keyboard accessibility
    const indicator = document.createElement('button');
    indicator.className = 'reference-indicator';
    indicator.type = 'button';

    // Different states: resolved, generating, or stub
    const isResolved = !!this.annotation.referencedDocumentId;

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
      // Add focus styles
      indicator.style.cssText += `
        &:focus {
          outline: 2px solid #3b82f6;
          outline-offset: 2px;
          opacity: 1;
        }
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
      // Add focus styles
      indicator.style.cssText += `
        &:focus {
          outline: 2px solid #3b82f6;
          outline-offset: 2px;
          opacity: 1;
        }
      `;
    }

    // Only add hover/click handlers if not generating
    if (!this.isGenerating) {
      indicator.addEventListener('mouseenter', () => {
        indicator.style.opacity = '1';

        // NEVER show custom preview tooltip for unresolved references
        // Only show it for resolved references that have a valid document name
        if (isResolved && this.targetDocumentName && this.targetDocumentName.trim() !== '') {
          this.showPreview(container, this.targetDocumentName);
        }
      });

      indicator.addEventListener('mouseleave', () => {
        indicator.style.opacity = '0.6';
        // Only hide preview if it was shown (for resolved references)
        if (isResolved) {
          this.hidePreview(container);
        }
      });

      // Click handler: navigate for resolved, show popup for unresolved
      if (isResolved && this.annotation.referencedDocumentId && this.onNavigate) {
        indicator.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.onNavigate!(this.annotation.referencedDocumentId!);
        });
      } else if (!isResolved && this.onUnresolvedClick) {
        indicator.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.onUnresolvedClick!(this.annotation);
        });
      }
    }

    container.appendChild(indicator);
    return container;
  }

  private showPreview(container: HTMLElement, documentName: string) {
    // Don't show preview if there's no document name
    if (!documentName || documentName.trim() === '') {
      return;
    }

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

  private hidePreview(container: HTMLElement) {
    const tooltip = container.querySelector('.reference-tooltip');
    if (tooltip) {
      tooltip.remove();
    }
  }

  override ignoreEvent(event: Event): boolean {
    return event.type === 'click';
  }
}

/**
 * Find wiki links in content and return decoration positions
 */
export function findWikiLinks(content: string): Array<{ from: number; to: number; pageName: string }> {
  const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
  const links: Array<{ from: number; to: number; pageName: string }> = [];

  let match;
  while ((match = wikiLinkRegex.exec(content)) !== null) {
    const pageName = match[1];
    if (!pageName) continue; // Skip if capture group is undefined

    links.push({
      from: match.index,
      to: match.index + match[0].length,
      pageName
    });
  }

  return links;
}
