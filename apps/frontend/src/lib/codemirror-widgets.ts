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
    readonly onUnresolvedClick?: (annotation: AnnotationSelection) => void
  ) {
    super();
  }

  override eq(other: ReferenceResolutionWidget) {
    return other.annotation.id === this.annotation.id &&
           other.targetDocumentName === this.targetDocumentName;
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

    const indicator = document.createElement('span');
    indicator.className = 'reference-indicator';

    // Different styles for resolved vs unresolved
    const isResolved = !!this.annotation.referencedDocumentId;

    if (isResolved) {
      indicator.textContent = '🔗';
      indicator.title = this.targetDocumentName
        ? `Links to: ${this.targetDocumentName}`
        : 'Links to document';
    } else {
      indicator.textContent = '❓';
      indicator.title = 'Stub reference. Click to resolve.';
    }

    indicator.style.cssText = `
      font-size: 10px;
      cursor: pointer;
      opacity: 0.6;
      transition: opacity 0.2s ease;
    `;

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
