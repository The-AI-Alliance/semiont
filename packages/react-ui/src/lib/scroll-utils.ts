/**
 * Scroll utilities for annotation navigation
 */

export interface ScrollToAnnotationOptions {
  /** Add pulse animation that auto-removes after 2 seconds */
  pulse?: boolean;
  /** Scroll behavior */
  behavior?: ScrollBehavior;
}

/**
 * Scrolls an annotation into view within its scroll container.
 * Centers the annotation vertically within the container.
 *
 * @param annotationId - ID of the annotation to scroll to
 * @param rootElement - Root element containing the annotation (will search within this)
 * @param options - Scroll options
 * @returns true if annotation was found and scrolled, false otherwise
 */
export function scrollAnnotationIntoView(
  annotationId: string | null,
  rootElement: HTMLElement,
  options: ScrollToAnnotationOptions = {}
): boolean {
  if (!annotationId) return false;

  const { pulse = false, behavior = 'smooth' } = options;

  // Find the annotation element
  const element = rootElement.querySelector(
    `[data-annotation-id="${CSS.escape(annotationId)}"]`
  ) as HTMLElement;

  if (!element) return false;

  // Find the scroll container - try multiple possible container classes
  const scrollContainer = (
    element.closest('.semiont-browse-view__content') ||
    element.closest('.semiont-annotate-view__content') ||
    element.closest('.semiont-document-viewer__scrollable-body')
  ) as HTMLElement;

  if (scrollContainer) {
    // Check if element is already visible
    const elementRect = element.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();

    const isVisible =
      elementRect.top >= containerRect.top &&
      elementRect.bottom <= containerRect.bottom;

    if (!isVisible) {
      // Scroll to center the element vertically
      const elementTop = element.offsetTop;
      const containerHeight = scrollContainer.clientHeight;
      const elementHeight = element.offsetHeight;
      const scrollTo = elementTop - (containerHeight / 2) + (elementHeight / 2);

      scrollContainer.scrollTo({ top: scrollTo, behavior });
    }
  }

  // Add pulse effect if requested
  if (pulse) {
    element.classList.add('annotation-pulse');
    setTimeout(() => {
      element.classList.remove('annotation-pulse');
    }, 2000);
  }

  return true;
}
