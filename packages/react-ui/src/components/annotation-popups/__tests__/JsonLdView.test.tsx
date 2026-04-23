import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import type { components } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];

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

vi.mock('@codemirror/theme-one-dark', () => ({
  oneDark: {},
}));

vi.mock('@codemirror/language', () => ({
  syntaxHighlighting: vi.fn(),
  HighlightStyle: {
    define: vi.fn(() => ({})),
  },
}));

vi.mock('../../../lib/codemirror-json-theme', () => ({
  jsonLightTheme: {},
  jsonLightHighlightStyle: {},
}));

vi.mock('@/hooks/useLineNumbers');

import { useLineNumbers } from '@/hooks/useLineNumbers';
import { renderWithProviders } from '../../../test-utils';
import { JsonLdView } from '../JsonLdView';

const createMockAnnotation = (overrides?: Partial<Annotation>): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: 'anno-1',
  type: 'Annotation',
  motivation: 'highlighting',
  creator: { name: 'user@example.com' },
  created: '2024-01-01T10:00:00Z',
  target: {
    source: 'resource-1',
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

    Object.defineProperty(document.documentElement, 'classList', {
      value: {
        contains: vi.fn().mockReturnValue(false),
      },
      writable: true,
      configurable: true,
    });

    vi.mocked(useLineNumbers).mockReturnValue({
      showLineNumbers: false,
      toggleLineNumbers: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render the JSON-LD title', () => {
      const annotation = createMockAnnotation();
      renderWithProviders(<JsonLdView annotation={annotation} onBack={vi.fn()} />);

      expect(screen.getByText('JSON-LD')).toBeInTheDocument();
    });

    it('should render the back button', () => {
      const annotation = createMockAnnotation();
      renderWithProviders(<JsonLdView annotation={annotation} onBack={vi.fn()} />);

      const backButton = screen.getByTitle('Go back (Escape)');
      expect(backButton).toBeInTheDocument();
    });

    it('should render the copy button', () => {
      const annotation = createMockAnnotation();
      renderWithProviders(<JsonLdView annotation={annotation} onBack={vi.fn()} />);

      expect(screen.getByText(/Copy/)).toBeInTheDocument();
    });

    it('should render editor container', () => {
      const annotation = createMockAnnotation();
      const { container } = renderWithProviders(
        <JsonLdView annotation={annotation} onBack={vi.fn()} />
      );

      const editorDiv = container.querySelector('.semiont-jsonld-view__editor');
      expect(editorDiv).toBeInTheDocument();
    });
  });

  describe('Back button', () => {
    it('should call onBack when back button is clicked', async () => {
      const onBack = vi.fn();
      const annotation = createMockAnnotation();
      renderWithProviders(<JsonLdView annotation={annotation} onBack={onBack} />);

      const backButton = screen.getByTitle('Go back (Escape)');
      await userEvent.click(backButton);

      expect(onBack).toHaveBeenCalledOnce();
    });

    it('should call onBack when Escape key is pressed', () => {
      const onBack = vi.fn();
      const annotation = createMockAnnotation();
      renderWithProviders(<JsonLdView annotation={annotation} onBack={onBack} />);

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(onBack).toHaveBeenCalledOnce();
    });

    it('should not call onBack for non-Escape keys', () => {
      const onBack = vi.fn();
      const annotation = createMockAnnotation();
      renderWithProviders(<JsonLdView annotation={annotation} onBack={onBack} />);

      fireEvent.keyDown(window, { key: 'Enter' });

      expect(onBack).not.toHaveBeenCalled();
    });
  });

  describe('Copy to clipboard', () => {
    it('should copy annotation JSON to clipboard when copy button is clicked', async () => {
      const annotation = createMockAnnotation();
      renderWithProviders(<JsonLdView annotation={annotation} onBack={vi.fn()} />);

      const copyButton = screen.getByText(/Copy/);
      await userEvent.click(copyButton);

      expect(mockClipboard.writeText).toHaveBeenCalledOnce();
      const copiedText = mockClipboard.writeText.mock.calls[0][0];
      expect(copiedText).toBe(JSON.stringify(annotation, null, 2));
    });

    it('should copy formatted JSON with indentation', async () => {
      const annotation = createMockAnnotation();
      renderWithProviders(<JsonLdView annotation={annotation} onBack={vi.fn()} />);

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
      renderWithProviders(<JsonLdView annotation={annotation} onBack={vi.fn()} />);

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

  describe('Styling', () => {
    it('should have proper view structure', () => {
      const annotation = createMockAnnotation();
      const { container } = renderWithProviders(
        <JsonLdView annotation={annotation} onBack={vi.fn()} />
      );

      const view = container.firstChild as HTMLElement;
      expect(view).toHaveClass('semiont-jsonld-view');
    });

    it('should have proper header class', () => {
      const annotation = createMockAnnotation();
      const { container } = renderWithProviders(
        <JsonLdView annotation={annotation} onBack={vi.fn()} />
      );

      const header = container.querySelector('.semiont-jsonld-view__header');
      expect(header).toBeInTheDocument();
    });

    it('should have proper back button class', () => {
      const annotation = createMockAnnotation();
      renderWithProviders(<JsonLdView annotation={annotation} onBack={vi.fn()} />);

      const backButton = screen.getByTitle('Go back (Escape)');
      expect(backButton).toHaveClass('semiont-jsonld-view__back-button');
    });

    it('should have proper copy button class', () => {
      const annotation = createMockAnnotation();
      renderWithProviders(<JsonLdView annotation={annotation} onBack={vi.fn()} />);

      const copyButton = screen.getByTitle('Copy to clipboard');
      expect(copyButton).toHaveClass('semiont-jsonld-view__copy-button');
    });
  });

  describe('Cleanup', () => {
    it('should remove keydown listener on unmount', () => {
      const onBack = vi.fn();
      const annotation = createMockAnnotation();
      const { unmount } = renderWithProviders(
        <JsonLdView annotation={annotation} onBack={onBack} />
      );

      unmount();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onBack).not.toHaveBeenCalled();
    });

    it('should unmount without errors', () => {
      const annotation = createMockAnnotation();
      const { unmount } = renderWithProviders(
        <JsonLdView annotation={annotation} onBack={vi.fn()} />
      );

      expect(() => unmount()).not.toThrow();
    });
  });
});
