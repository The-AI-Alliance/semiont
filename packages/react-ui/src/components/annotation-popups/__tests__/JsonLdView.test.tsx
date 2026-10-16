import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import type { Annotation, AnnotationId } from '@semiont/core';

// Mock CodeMirror modules
vi.mock('@codemirror/view', () => {
  class MockEditorView {
    destroy = vi.fn();
    constructor(_config: any) {}
    static editable = { of: vi.fn() };
    static theme = vi.fn(() => ({}));
  }

  return {
    EditorView: MockEditorView,
    lineNumbers: vi.fn(),
  };
});

vi.mock('@codemirror/state', () => ({
  EditorState: {
    create: vi.fn(() => ({})),
    readOnly: { of: vi.fn() },
  },
}));

vi.mock('@codemirror/lang-json', () => ({
  json: vi.fn(),
}));

vi.mock('@codemirror/language', () => ({
  syntaxHighlighting: vi.fn(),
  HighlightStyle: {
    define: vi.fn(() => ({})),
  },
}));

vi.mock('../../../lib/codemirror-json-theme', () => ({
  jsonTheme: {},
  jsonHighlightStyle: {},
}));

import { EditorState } from '@codemirror/state';
import { lineNumbers } from '@codemirror/view';
import { jsonTheme } from '../../../lib/codemirror-json-theme';
import { JsonLdView } from '../JsonLdView';
import { resourceId } from '@semiont/core';

/** The extensions the most recent editor was built with. */
function editorExtensions(): readonly unknown[] {
  const config = vi.mocked(EditorState.create).mock.calls.at(-1)?.[0];
  if (!config) throw new Error('no editor was created');
  return config.extensions as readonly unknown[];
}

const createMockAnnotation = (overrides?: Partial<Annotation>): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: 'anno-1' as AnnotationId,
  type: 'Annotation',
  motivation: 'highlighting',
  creator: { '@type': 'Person', name: 'user@example.com' },
  created: '2024-01-01T10:00:00Z',
  target: {
    source: resourceId('resource-1'),
    selector: {
      type: 'TextPositionSelector',
      start: 0,
      end: 10,
    },
  },
  ...overrides,
});

describe('JsonLdView', () => {
  let mockClipboard: { writeText: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockClipboard = {
      writeText: vi.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(navigator, 'clipboard', {
      value: mockClipboard,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render the JSON-LD title', () => {
      const annotation = createMockAnnotation();
      render(<JsonLdView annotation={annotation} onBack={vi.fn()} showLineNumbers={false} />);

      expect(screen.getByText('JSON-LD')).toBeInTheDocument();
    });

    it('should render the back button', () => {
      const annotation = createMockAnnotation();
      render(<JsonLdView annotation={annotation} onBack={vi.fn()} showLineNumbers={false} />);

      const backButton = screen.getByTitle('Go back (Escape)');
      expect(backButton).toBeInTheDocument();
    });

    it('should render the copy button', () => {
      const annotation = createMockAnnotation();
      render(<JsonLdView annotation={annotation} onBack={vi.fn()} showLineNumbers={false} />);

      expect(screen.getByText(/Copy/)).toBeInTheDocument();
    });

    it('should render editor container', () => {
      const annotation = createMockAnnotation();
      const { container } = render(
        <JsonLdView annotation={annotation} onBack={vi.fn()} showLineNumbers={false} />
      );

      const editorDiv = container.querySelector('.semiont-jsonld-view__editor');
      expect(editorDiv).toBeInTheDocument();
    });
  });

  describe('Back button', () => {
    it('should call onBack when back button is clicked', async () => {
      const onBack = vi.fn();
      const annotation = createMockAnnotation();
      render(<JsonLdView annotation={annotation} onBack={onBack} showLineNumbers={false} />);

      const backButton = screen.getByTitle('Go back (Escape)');
      await userEvent.click(backButton);

      expect(onBack).toHaveBeenCalledOnce();
    });

    it('should call onBack when Escape key is pressed', () => {
      const onBack = vi.fn();
      const annotation = createMockAnnotation();
      render(<JsonLdView annotation={annotation} onBack={onBack} showLineNumbers={false} />);

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(onBack).toHaveBeenCalledOnce();
    });

    it('should not call onBack for non-Escape keys', () => {
      const onBack = vi.fn();
      const annotation = createMockAnnotation();
      render(<JsonLdView annotation={annotation} onBack={onBack} showLineNumbers={false} />);

      fireEvent.keyDown(window, { key: 'Enter' });

      expect(onBack).not.toHaveBeenCalled();
    });
  });

  describe('Copy to clipboard', () => {
    it('renders no copy control where the page has no Clipboard API, as on an origin that is not a secure context', () => {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, writable: true, configurable: true });

      render(<JsonLdView annotation={createMockAnnotation()} onBack={vi.fn()} showLineNumbers={false} />);

      // A control that would fail silently is worse than none.
      expect(screen.queryByText(/Copy/)).not.toBeInTheDocument();
      expect(screen.getByText('JSON-LD')).toBeInTheDocument();
    });

    it('should copy annotation JSON to clipboard when copy button is clicked', async () => {
      const annotation = createMockAnnotation();
      render(<JsonLdView annotation={annotation} onBack={vi.fn()} showLineNumbers={false} />);

      const copyButton = screen.getByText(/Copy/);
      await userEvent.click(copyButton);

      expect(mockClipboard.writeText).toHaveBeenCalledOnce();
      const copiedText = mockClipboard.writeText.mock.calls[0][0];
      expect(copiedText).toBe(JSON.stringify(annotation, null, 2));
    });

    it('should copy formatted JSON with indentation', async () => {
      const annotation = createMockAnnotation();
      render(<JsonLdView annotation={annotation} onBack={vi.fn()} showLineNumbers={false} />);

      const copyButton = screen.getByText(/Copy/);
      await userEvent.click(copyButton);

      const copiedText = mockClipboard.writeText.mock.calls[0][0];
      expect(copiedText).toContain('\n');
      expect(copiedText).toContain('  ');
      expect(() => JSON.parse(copiedText)).not.toThrow();
    });

    it('should handle clipboard API errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockClipboard.writeText.mockRejectedValue(new Error('Clipboard error'));

      const annotation = createMockAnnotation();
      render(<JsonLdView annotation={annotation} onBack={vi.fn()} showLineNumbers={false} />);

      const copyButton = screen.getByText(/Copy/);
      await userEvent.click(copyButton);

      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          'Failed to copy JSON-LD:',
          expect.any(Error)
        );
      });

      consoleErrorSpy.mockRestore();
    });
  });

  describe('The editor', () => {
    // The viewer renders this view with no provider above it: its line numbers
    // come from the viewer, and its colours from the page's theme attribute,
    // through the CSS variables the JSON theme is written in.
    it('renders with no provider above it', () => {
      expect(() => render(
        <JsonLdView annotation={createMockAnnotation()} onBack={vi.fn()} showLineNumbers={false} />,
      )).not.toThrow();
    });

    it('is built with the JSON theme, whichever theme the page is in', () => {
      render(<JsonLdView annotation={createMockAnnotation()} onBack={vi.fn()} showLineNumbers={false} />);

      expect(editorExtensions()).toContain(jsonTheme);
    });

    it('shows line numbers when it is told to, and not otherwise', () => {
      const { unmount } = render(
        <JsonLdView annotation={createMockAnnotation()} onBack={vi.fn()} showLineNumbers />,
      );
      expect(lineNumbers).toHaveBeenCalledOnce();
      unmount();

      vi.mocked(lineNumbers).mockClear();
      render(<JsonLdView annotation={createMockAnnotation()} onBack={vi.fn()} showLineNumbers={false} />);
      expect(lineNumbers).not.toHaveBeenCalled();
    });
  });

  describe('Styling', () => {
    it('should have proper view structure', () => {
      const annotation = createMockAnnotation();
      const { container } = render(
        <JsonLdView annotation={annotation} onBack={vi.fn()} showLineNumbers={false} />
      );

      const view = container.firstChild as HTMLElement;
      expect(view).toHaveClass('semiont-jsonld-view');
    });

    it('should have proper header class', () => {
      const annotation = createMockAnnotation();
      const { container } = render(
        <JsonLdView annotation={annotation} onBack={vi.fn()} showLineNumbers={false} />
      );

      const header = container.querySelector('.semiont-jsonld-view__header');
      expect(header).toBeInTheDocument();
    });

    it('should have proper back button class', () => {
      const annotation = createMockAnnotation();
      render(<JsonLdView annotation={annotation} onBack={vi.fn()} showLineNumbers={false} />);

      const backButton = screen.getByTitle('Go back (Escape)');
      expect(backButton).toHaveClass('semiont-jsonld-view__back-button');
    });

    it('should have proper copy button class', () => {
      const annotation = createMockAnnotation();
      render(<JsonLdView annotation={annotation} onBack={vi.fn()} showLineNumbers={false} />);

      const copyButton = screen.getByTitle('Copy to clipboard');
      expect(copyButton).toHaveClass('semiont-jsonld-view__copy-button');
    });
  });

  describe('Cleanup', () => {
    it('should remove keydown listener on unmount', () => {
      const onBack = vi.fn();
      const annotation = createMockAnnotation();
      const { unmount } = render(
        <JsonLdView annotation={annotation} onBack={onBack} showLineNumbers={false} />
      );

      unmount();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onBack).not.toHaveBeenCalled();
    });

    it('should unmount without errors', () => {
      const annotation = createMockAnnotation();
      const { unmount } = render(
        <JsonLdView annotation={annotation} onBack={vi.fn()} showLineNumbers={false} />
      );

      expect(() => unmount()).not.toThrow();
    });
  });
});
