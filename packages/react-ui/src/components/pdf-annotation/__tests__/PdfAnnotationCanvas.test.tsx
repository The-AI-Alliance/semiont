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

// Mock browser-pdfjs module
vi.mock('../../../lib/browser-pdfjs', () => ({
  loadPdfDocument: vi.fn().mockResolvedValue({
    numPages: 3,
    getPage: vi.fn().mockResolvedValue({
      getViewport: vi.fn().mockReturnValue({
        width: 612,
        height: 792,
        scale: 1.0,
        rotation: 0
      }),
      render: vi.fn().mockReturnValue({
        promise: Promise.resolve()
      })
    })
  }),
  renderPdfPageToDataUrl: vi.fn().mockResolvedValue({
    dataUrl: 'data:image/png;base64,mock',
    width: 612,
    height: 792
  })
}));

describe('PdfAnnotationCanvas', () => {
  const mockResourceUri = 'http://example.com/resources/123';
  const mockOnAnnotationCreate = vi.fn();
  const mockOnAnnotationClick = vi.fn();
  const mockOnAnnotationHover = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('renders loading state initially', () => {
    render(
      <PdfAnnotationCanvas
        resourceUri={mockResourceUri}
        drawingMode={null}
      />
    );

    expect(screen.getByText(/loading pdf/i)).toBeInTheDocument();
  });

  test('renders page navigation controls after loading', async () => {
    render(
      <PdfAnnotationCanvas
        resourceUri={mockResourceUri}
        drawingMode={null}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /previous/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
  });

  test('previous button is disabled on first page', async () => {
    render(
      <PdfAnnotationCanvas
        resourceUri={mockResourceUri}
        drawingMode={null}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    });

    const prevButton = screen.getByRole('button', { name: /previous/i });
    expect(prevButton).toBeDisabled();
  });

  test('next button is disabled on last page', async () => {
    render(
      <PdfAnnotationCanvas
        resourceUri={mockResourceUri}
        drawingMode={null}
      />
    );

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    });

    const nextButton = screen.getByRole('button', { name: /next/i });

    // Navigate to last page
    await user.click(nextButton);
    await user.click(nextButton);

    await waitFor(() => {
      expect(screen.getByText(/page 3 of 3/i)).toBeInTheDocument();
    });

    expect(nextButton).toBeDisabled();
  });

  test('renders existing annotations', async () => {
    const mockAnnotations: Annotation[] = [
      {
        id: 'ann-1',
        target: {
          source: mockResourceUri,
          selector: {
            type: 'FragmentSelector',
            value: 'page=1&viewrect=100,200,150,100',
            conformsTo: 'http://tools.ietf.org/rfc/rfc3778'
          }
        },
        motivation: 'highlighting',
        created: new Date().toISOString()
      }
    ];

    render(
      <PdfAnnotationCanvas
        resourceUri={mockResourceUri}
        existingAnnotations={mockAnnotations}
        drawingMode={null}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    });

    // Annotation should be rendered in SVG
    const svg = document.querySelector('.semiont-pdf-annotation-canvas__svg');
    expect(svg).toBeInTheDocument();

    const rects = svg?.querySelectorAll('rect');
    expect(rects?.length).toBeGreaterThan(0);
  });

  test('calls onAnnotationCreate when drawing is completed', async () => {
    render(
      <PdfAnnotationCanvas
        resourceUri={mockResourceUri}
        drawingMode="rectangle"
        onAnnotationCreate={mockOnAnnotationCreate}
      />
    );

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/page 1 of 3/i)).toBeInTheDocument();
    });

    const container = document.querySelector('.semiont-pdf-annotation-canvas__container');
    expect(container).toBeInTheDocument();

    if (container) {
      // Simulate drawing a rectangle
      await user.pointer([
        { keys: '[MouseLeft>]', target: container, coords: { x: 100, y: 100 } },
        { coords: { x: 200, y: 200 } },
        { keys: '[/MouseLeft]' }
      ]);

      await waitFor(() => {
        expect(mockOnAnnotationCreate).toHaveBeenCalled();
      });
    }
  });
});
