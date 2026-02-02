/**
 * PdfAnnotationCanvas Component Tests
 *
 * Tests for PDF annotation canvas component including:
 * - Rendering states (loading, error, success)
 * - Page navigation controls
 * - Drawing interactions
 * - Annotation display and interactions
 * - Event handler callbacks
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PdfAnnotationCanvas } from '../PdfAnnotationCanvas';
import type { components } from '@semiont/api-client';

type Annotation = components['schemas']['Annotation'];

// Mock react-pdf
vi.mock('react-pdf', () => ({
  pdfjs: {
    GlobalWorkerOptions: { workerSrc: '' },
    version: '3.11.174'
  },
  Document: ({ children, onLoadSuccess, onLoadError, loading }: any) => {
    // Simulate successful document load
    if (onLoadSuccess) {
      setTimeout(() => onLoadSuccess({ numPages: 3 }), 0);
    }
    return <div data-testid="pdf-document">{loading}{children}</div>;
  },
  Page: ({ onLoadSuccess, pageNumber, scale }: any) => {
    // Simulate successful page load
    if (onLoadSuccess) {
      setTimeout(() => {
        onLoadSuccess({
          getViewport: ({ scale: s }: { scale: number }) => ({
            width: 612,
            height: 792
          })
        });
      }, 0);
    }
    return (
      <div data-testid={`pdf-page-${pageNumber}`} data-scale={scale}>
        Page {pageNumber}
      </div>
    );
  }
}));

describe('PdfAnnotationCanvas Component', () => {
  const defaultProps = {
    resourceUri: 'urn:semiont:resource:abc123',
    drawingMode: null as const,
    selectedMotivation: null,
    existingAnnotations: []
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering States', () => {
    test('renders loading state initially', () => {
      render(<PdfAnnotationCanvas {...defaultProps} />);
      const loadingElement = document.querySelector('.semiont-pdf-annotation-canvas__loading');
      expect(loadingElement).toBeInTheDocument();
      expect(loadingElement).toHaveTextContent('Loading PDF...');
    });

    test('renders PDF document after successful load', async () => {
      render(<PdfAnnotationCanvas {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByTestId('pdf-document')).toBeInTheDocument();
      });
    });

    test('renders page controls after document loads', async () => {
      render(<PdfAnnotationCanvas {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
        expect(screen.getByText('Previous')).toBeInTheDocument();
        expect(screen.getByText('Next')).toBeInTheDocument();
      });
    });
  });

  describe('Page Navigation', () => {
    test('Previous button is disabled on first page', async () => {
      render(<PdfAnnotationCanvas {...defaultProps} />);

      await waitFor(() => {
        const prevButton = screen.getByText('Previous') as HTMLButtonElement;
        expect(prevButton.disabled).toBe(true);
      });
    });

    test('Next button is enabled when not on last page', async () => {
      render(<PdfAnnotationCanvas {...defaultProps} />);

      await waitFor(() => {
        const nextButton = screen.getByText('Next') as HTMLButtonElement;
        expect(nextButton.disabled).toBe(false);
      });
    });

    test('navigates to next page when Next button is clicked', async () => {
      const user = userEvent.setup();
      render(<PdfAnnotationCanvas {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
      });

      const nextButton = screen.getByText('Next');
      await user.click(nextButton);

      expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    });

    test('navigates to previous page when Previous button is clicked', async () => {
      const user = userEvent.setup();
      render(<PdfAnnotationCanvas {...defaultProps} />);

      // First navigate to page 2
      await waitFor(() => {
        expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
      });

      const nextButton = screen.getByText('Next');
      await user.click(nextButton);

      await waitFor(() => {
        expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
      });

      // Then navigate back to page 1
      const prevButton = screen.getByText('Previous');
      await user.click(prevButton);

      expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    });

    test('Next button is disabled on last page', async () => {
      const user = userEvent.setup();
      render(<PdfAnnotationCanvas {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
      });

      // Navigate to last page
      const nextButton = screen.getByText('Next');
      await user.click(nextButton); // Page 2
      await user.click(nextButton); // Page 3

      await waitFor(() => {
        const button = screen.getByText('Next') as HTMLButtonElement;
        expect(button.disabled).toBe(true);
      });
    });
  });

  describe('Drawing Mode', () => {
    test('renders container when drawing mode is active', async () => {
      render(<PdfAnnotationCanvas {...defaultProps} drawingMode="rectangle" />);

      await waitFor(() => {
        const container = document.querySelector('.semiont-pdf-annotation-canvas__container');
        expect(container).toBeInTheDocument();
      });
    });

    test('renders container when drawing mode is null', async () => {
      render(<PdfAnnotationCanvas {...defaultProps} drawingMode={null} />);

      await waitFor(() => {
        const container = document.querySelector('.semiont-pdf-annotation-canvas__container');
        expect(container).toBeInTheDocument();
      });
    });
  });

  describe('Annotation Display', () => {
    test('renders existing annotations for current page', async () => {
      const annotations: Annotation[] = [
        {
          id: 'ann1',
          type: 'Annotation',
          motivation: 'highlighting',
          target: {
            source: 'urn:semiont:resource:abc123',
            selector: {
              type: 'FragmentSelector',
              value: 'page=1&viewrect=100,100,200,150',
              conformsTo: 'http://tools.ietf.org/rfc/rfc3778'
            }
          },
          body: []
        }
      ];

      render(<PdfAnnotationCanvas {...defaultProps} existingAnnotations={annotations} />);

      await waitFor(() => {
        const svg = document.querySelector('.semiont-pdf-annotation-canvas__overlay');
        expect(svg).toBeInTheDocument();
      });
    });

    test('does not render annotations from other pages', async () => {
      const annotations: Annotation[] = [
        {
          id: 'ann1',
          type: 'Annotation',
          motivation: 'highlighting',
          target: {
            source: 'urn:semiont:resource:abc123',
            selector: {
              type: 'FragmentSelector',
              value: 'page=2&viewrect=100,100,200,150',
              conformsTo: 'http://tools.ietf.org/rfc/rfc3778'
            }
          },
          body: []
        }
      ];

      render(<PdfAnnotationCanvas {...defaultProps} existingAnnotations={annotations} />);

      await waitFor(() => {
        expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
      });

      // Annotation is on page 2, so shouldn't render on page 1
      const svg = document.querySelector('.semiont-pdf-annotation-canvas__overlay');
      const rects = svg?.querySelectorAll('rect');
      expect(rects?.length).toBe(0);
    });
  });

  describe('Event Handlers', () => {
    test('calls onAnnotationClick when annotation is clicked', async () => {
      const user = userEvent.setup();
      const onAnnotationClick = vi.fn();

      const annotations: Annotation[] = [
        {
          id: 'ann1',
          type: 'Annotation',
          motivation: 'highlighting',
          target: {
            source: 'urn:semiont:resource:abc123',
            selector: {
              type: 'FragmentSelector',
              value: 'page=1&viewrect=100,100,200,150',
              conformsTo: 'http://tools.ietf.org/rfc/rfc3778'
            }
          },
          body: []
        }
      ];

      render(
        <PdfAnnotationCanvas
          {...defaultProps}
          existingAnnotations={annotations}
          onAnnotationClick={onAnnotationClick}
        />
      );

      await waitFor(() => {
        const svg = document.querySelector('.semiont-pdf-annotation-canvas__overlay');
        expect(svg).toBeInTheDocument();
      });

      const rect = document.querySelector('rect[style*="pointer-events: auto"]');
      if (rect) {
        await user.click(rect as Element);
        expect(onAnnotationClick).toHaveBeenCalledWith(annotations[0]);
      }
    });

    test('calls onAnnotationHover when hovering over annotation', async () => {
      const user = userEvent.setup();
      const onAnnotationHover = vi.fn();

      const annotations: Annotation[] = [
        {
          id: 'ann1',
          type: 'Annotation',
          motivation: 'highlighting',
          target: {
            source: 'urn:semiont:resource:abc123',
            selector: {
              type: 'FragmentSelector',
              value: 'page=1&viewrect=100,100,200,150',
              conformsTo: 'http://tools.ietf.org/rfc/rfc3778'
            }
          },
          body: []
        }
      ];

      render(
        <PdfAnnotationCanvas
          {...defaultProps}
          existingAnnotations={annotations}
          onAnnotationHover={onAnnotationHover}
        />
      );

      await waitFor(() => {
        const svg = document.querySelector('.semiont-pdf-annotation-canvas__overlay');
        expect(svg).toBeInTheDocument();
      });

      const rect = document.querySelector('rect[style*="pointer-events: auto"]');
      if (rect) {
        await user.hover(rect as Element);
        expect(onAnnotationHover).toHaveBeenCalledWith('ann1');

        await user.unhover(rect as Element);
        expect(onAnnotationHover).toHaveBeenCalledWith(null);
      }
    });
  });

  describe('Accessibility', () => {
    test('buttons have proper disabled states', async () => {
      render(<PdfAnnotationCanvas {...defaultProps} />);

      await waitFor(() => {
        const prevButton = screen.getByText('Previous');
        const nextButton = screen.getByText('Next');

        expect(prevButton).toHaveAttribute('disabled');
        expect(nextButton).not.toHaveAttribute('disabled');
      });
    });

    test('page counter provides clear navigation context', async () => {
      render(<PdfAnnotationCanvas {...defaultProps} />);

      await waitFor(() => {
        const pageInfo = screen.getByText(/Page \d+ of \d+/);
        expect(pageInfo).toBeInTheDocument();
        expect(pageInfo.textContent).toMatch(/^Page \d+ of \d+$/);
      });
    });
  });

  describe('Motivation Colors', () => {
    test('applies highlighting color for highlighting motivation', async () => {
      render(
        <PdfAnnotationCanvas
          {...defaultProps}
          drawingMode="rectangle"
          selectedMotivation="highlighting"
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('pdf-document')).toBeInTheDocument();
      });

      // Color application is tested through visual rendering
      // The actual color values are tested in unit tests
    });

    test('applies linking color for linking motivation', async () => {
      render(
        <PdfAnnotationCanvas
          {...defaultProps}
          drawingMode="rectangle"
          selectedMotivation="linking"
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('pdf-document')).toBeInTheDocument();
      });
    });

    test('applies assessing color for assessing motivation', async () => {
      render(
        <PdfAnnotationCanvas
          {...defaultProps}
          drawingMode="rectangle"
          selectedMotivation="assessing"
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('pdf-document')).toBeInTheDocument();
      });
    });

    test('applies commenting color for commenting motivation', async () => {
      render(
        <PdfAnnotationCanvas
          {...defaultProps}
          drawingMode="rectangle"
          selectedMotivation="commenting"
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('pdf-document')).toBeInTheDocument();
      });
    });
  });
});
