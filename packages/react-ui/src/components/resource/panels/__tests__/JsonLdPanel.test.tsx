import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { JsonLdPanel } from '../JsonLdPanel';
import { resourceId } from '@semiont/core';
import type { components } from '@semiont/core';

type GetResourceResponse = components['schemas']['GetResourceResponse'];

// Mock CodeMirror modules (the panel still renders the graph in CodeMirror)
vi.mock('@codemirror/view', () => {
  class MockEditorView {
    destroy = vi.fn();
    static editable = { of: vi.fn() };
    static theme = vi.fn(() => ({}));
  }
  return { EditorView: MockEditorView, lineNumbers: vi.fn() };
});
vi.mock('@codemirror/state', () => ({
  EditorState: { create: vi.fn(() => ({})), readOnly: { of: vi.fn() } },
}));
vi.mock('@codemirror/lang-json', () => ({ json: vi.fn() }));
vi.mock('@codemirror/theme-one-dark', () => ({ oneDark: {} }));
vi.mock('@codemirror/language', () => ({
  syntaxHighlighting: vi.fn(),
  HighlightStyle: { define: vi.fn(() => ({})) },
}));
vi.mock('../../../lib/codemirror-json-theme', () => ({
  jsonLightTheme: {},
  jsonLightHighlightStyle: {},
}));

// Mock the hooks the panel consumes — NOT the session/client stack.
vi.mock('@/hooks/useLineNumbers');
vi.mock('@/hooks/useResourceGraph');
import { useLineNumbers } from '@/hooks/useLineNumbers';
import { useResourceGraph } from '@/hooks/useResourceGraph';

const RID = resourceId('test-resource-1');

const MOCK_GRAPH: GetResourceResponse = {
  resource: {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    '@id': 'test-resource-1',
    id: 'test-resource-1',
    name: 'Test Resource',
    content: 'This is test content',
    format: 'text/plain',
    archived: false,
    entityTypes: ['Person'],
    locale: 'en-US',
    representations: [],
    created: '2024-01-01T10:00:00Z',
    modified: '2024-01-01T10:00:00Z',
  },
  annotations: [],
  entityReferences: [],
};

describe('JsonLdPanel Component', () => {
  let mockClipboard: { writeText: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockClipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', {
      value: mockClipboard, writable: true, configurable: true,
    });
    Object.defineProperty(document.documentElement, 'classList', {
      value: { contains: vi.fn().mockReturnValue(false) },
      writable: true, configurable: true,
    });

    vi.mocked(useLineNumbers).mockReturnValue({
      showLineNumbers: true, toggleLineNumbers: vi.fn(),
    });
    // Default: graph loaded successfully.
    vi.mocked(useResourceGraph).mockReturnValue({
      graph: MOCK_GRAPH, loading: false, error: null,
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe('Rendering', () => {
    it('renders the header, copy button, and editor container', () => {
      const { container } = render(<JsonLdPanel resourceId={RID} />);
      expect(screen.getByText('JSON-LD')).toBeInTheDocument();
      expect(screen.getByText(/Copy/)).toBeInTheDocument();
      expect(container.querySelector('.semiont-jsonld-panel__editor')).toBeInTheDocument();
    });

    it('fetches the graph for the given resourceId', () => {
      render(<JsonLdPanel resourceId={RID} />);
      expect(useResourceGraph).toHaveBeenCalledWith(RID);
    });
  });

  describe('Loading / error states', () => {
    it('shows a loading state and disables Copy while loading', () => {
      vi.mocked(useResourceGraph).mockReturnValue({ graph: null, loading: true, error: null });
      render(<JsonLdPanel resourceId={RID} />);
      expect(screen.getByText(/Loading JSON-LD/i)).toBeInTheDocument();
      expect(screen.getByText(/Copy/).closest('button')).toBeDisabled();
    });

    it('shows an error state and disables Copy on failure', () => {
      vi.mocked(useResourceGraph).mockReturnValue({
        graph: null, loading: false, error: new Error('boom'),
      });
      render(<JsonLdPanel resourceId={RID} />);
      expect(screen.getByText(/Failed to load JSON-LD/i)).toBeInTheDocument();
      expect(screen.getByText(/Copy/).closest('button')).toBeDisabled();
    });
  });

  describe('Copy to clipboard', () => {
    it('copies the full graph — not the bare descriptor', async () => {
      render(<JsonLdPanel resourceId={RID} />);
      await userEvent.click(screen.getByText(/Copy/));

      expect(mockClipboard.writeText).toHaveBeenCalledOnce();
      const parsed = JSON.parse(mockClipboard.writeText.mock.calls[0][0]);

      // The graph wraps the descriptor and adds annotation collections; a bare
      // ResourceDescriptor would have `id` at the top level and no `resource`.
      expect(parsed.resource.id).toBe('test-resource-1');
      expect(Array.isArray(parsed.annotations)).toBe(true);
      expect(Array.isArray(parsed.entityReferences)).toBe(true);
      expect(parsed.id).toBeUndefined();
    });

    it('copies pretty-printed, valid JSON', async () => {
      render(<JsonLdPanel resourceId={RID} />);
      await userEvent.click(screen.getByText(/Copy/));
      const copied = mockClipboard.writeText.mock.calls[0][0];
      expect(copied).toContain('\n');
      expect(copied).toContain('  ');
      expect(() => JSON.parse(copied)).not.toThrow();
    });

    it('does not copy when there is no graph yet', async () => {
      vi.mocked(useResourceGraph).mockReturnValue({ graph: null, loading: true, error: null });
      render(<JsonLdPanel resourceId={RID} />);
      const button = screen.getByText(/Copy/).closest('button')!;
      await userEvent.click(button);
      expect(mockClipboard.writeText).not.toHaveBeenCalled();
    });

    it('handles clipboard errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockClipboard.writeText.mockRejectedValue(new Error('Clipboard error'));
      render(<JsonLdPanel resourceId={RID} />);
      await userEvent.click(screen.getByText(/Copy/));
      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to copy JSON-LD:', expect.any(Error));
      });
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Accessibility / structure', () => {
    it('has the panel structure and a titled copy button', () => {
      const { container } = render(<JsonLdPanel resourceId={RID} />);
      expect(container.firstChild).toHaveClass('semiont-jsonld-panel');
      const copyButton = screen.getByText(/Copy/).closest('button');
      expect(copyButton).toHaveAttribute('title', 'Copy to clipboard');
      expect(screen.getByText('JSON-LD')).toHaveClass('semiont-jsonld-panel__title');
    });
  });
});
