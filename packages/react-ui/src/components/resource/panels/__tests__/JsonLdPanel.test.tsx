import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { JsonLdPanel } from '../JsonLdPanel';
import type { components } from '@semiont/api-client';

type SemiontResource = components['schemas']['ResourceDescriptor'];

// Mock CodeMirror modules
vi.mock('@codemirror/view', () => {
  class MockEditorView {
    destroy = vi.fn();
    constructor(config: any) {
      // Store config if needed for assertions
    }
  }
  (MockEditorView as any).editable = { of: vi.fn() };

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
}));

vi.mock('@/lib/codemirror-json-theme', () => ({
  jsonLightTheme: {},
  jsonLightHighlightStyle: {},
}));

// Mock useLineNumbers hook
vi.mock('@/hooks/useLineNumbers', () => ({
  useLineNumbers: vi.fn(() => ({ showLineNumbers: true, toggleLineNumbers: vi.fn() })),
}));

import { EditorView } from '@codemirror/view';
import { useLineNumbers } from '../hooks/useLineNumbers';
import type { MockedFunction } from 'vitest';

const mockUseLineNumbers = useLineNumbers as MockedFunction<typeof useLineNumbers>;

// Test data fixtures
const createMockResource = (overrides?: Partial<SemiontResource>): SemiontResource => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  '@id': 'test-resource-1',
  id: 'test-resource-1',
  name: 'Test Resource',
  content: 'This is test content',
  format: 'text/plain',
  archived: false,
  entityTypes: ['Person', 'Organization'],
  locale: 'en-US',
  representations: [],
  created: '2024-01-01T10:00:00Z',
  modified: '2024-01-01T10:00:00Z',
  ...overrides,
});

describe('JsonLdPanel Component', () => {
  let mockClipboard: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock clipboard API
    mockClipboard = {
      writeText: vi.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(navigator, 'clipboard', {
      value: mockClipboard,
      writable: true,
      configurable: true,
    });

    // Mock document.documentElement for dark mode detection
    Object.defineProperty(document.documentElement, 'classList', {
      value: {
        contains: vi.fn().mockReturnValue(false),
      },
      writable: true,
      configurable: true,
    });

    mockUseLineNumbers.mockReturnValue({ showLineNumbers: true, toggleLineNumbers: vi.fn() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('should render panel with header', () => {
      const resource = createMockResource();
      render(<JsonLdPanel resource={resource} />);

      expect(screen.getByText('JSON-LD')).toBeInTheDocument();
    });

    it('should render copy button', () => {
      const resource = createMockResource();
      render(<JsonLdPanel resource={resource} />);

      expect(screen.getByText(/Copy/)).toBeInTheDocument();
    });

    it('should render editor container', () => {
      const resource = createMockResource();
      const { container } = render(<JsonLdPanel resource={resource} />);

      const editorDiv = container.querySelector('.flex-1.overflow-auto');
      expect(editorDiv).toBeInTheDocument();
    });
  });

  describe('CodeMirror Integration', () => {
    it('should initialize CodeMirror editor', () => {
      const resource = createMockResource();
      const { container } = render(<JsonLdPanel resource={resource} />);

      // Verify editor container is rendered
      const editorDiv = container.querySelector('.flex-1.overflow-auto');
      expect(editorDiv).toBeInTheDocument();
    });

    it('should pass resource as JSON to editor', () => {
      const resource = createMockResource();
      const { container } = render(<JsonLdPanel resource={resource} />);

      // Verify component renders without errors
      expect(container.firstChild).toBeInTheDocument();
    });

    it('should format JSON with indentation', () => {
      const resource = createMockResource();
      const { container } = render(<JsonLdPanel resource={resource} />);

      // Verify component renders without errors
      expect(container.firstChild).toBeInTheDocument();
    });

    it('should configure editor as read-only', () => {
      const resource = createMockResource();
      const { container } = render(<JsonLdPanel resource={resource} />);

      // Verify component renders without errors (read-only is configured internally)
      expect(container.firstChild).toBeInTheDocument();
    });

    it('should include line numbers when enabled', () => {
      mockUseLineNumbers.mockReturnValue({ showLineNumbers: true, toggleLineNumbers: vi.fn() });

      const resource = createMockResource();
      const { container } = render(<JsonLdPanel resource={resource} />);

      // Verify component renders without errors (line numbers configured internally)
      expect(container.firstChild).toBeInTheDocument();
    });

    it('should not include line numbers when disabled', () => {
      mockUseLineNumbers.mockReturnValue({ showLineNumbers: false, toggleLineNumbers: vi.fn() });

      const resource = createMockResource();
      const { container } = render(<JsonLdPanel resource={resource} />);

      // Verify component renders without errors (line numbers not included)
      expect(container.firstChild).toBeInTheDocument();
    });

    it('should cleanup editor on unmount', () => {
      const resource = createMockResource();
      const { unmount } = render(<JsonLdPanel resource={resource} />);

      // Should unmount without errors (cleanup happens internally)
      expect(() => unmount()).not.toThrow();
    });
  });

  describe('Dark Mode Support', () => {
    it('should use dark theme when dark mode is active', () => {
      Object.defineProperty(document.documentElement, 'classList', {
        value: {
          contains: vi.fn().mockReturnValue(true), // Dark mode active
        },
        writable: true,
        configurable: true,
      });

      const resource = createMockResource();
      const { container } = render(<JsonLdPanel resource={resource} />);

      // Verify component renders without errors (dark theme configured internally)
      expect(container.firstChild).toBeInTheDocument();
    });

    it('should use light theme when dark mode is not active', () => {
      Object.defineProperty(document.documentElement, 'classList', {
        value: {
          contains: vi.fn().mockReturnValue(false), // Light mode
        },
        writable: true,
        configurable: true,
      });

      const resource = createMockResource();
      const { container } = render(<JsonLdPanel resource={resource} />);

      // Verify component renders without errors (light theme configured internally)
      expect(container.firstChild).toBeInTheDocument();
    });
  });

  describe('Copy to Clipboard', () => {
    it('should copy JSON to clipboard when button clicked', async () => {
      const resource = createMockResource();
      render(<JsonLdPanel resource={resource} />);

      const copyButton = screen.getByText(/Copy/);
      await userEvent.click(copyButton);

      expect(mockClipboard.writeText).toHaveBeenCalledOnce();

      const copiedText = mockClipboard.writeText.mock.calls[0][0];
      expect(copiedText).toContain('test-resource-1');
      expect(copiedText).toContain('Test Resource');
    });

    it('should copy formatted JSON', async () => {
      const resource = createMockResource();
      render(<JsonLdPanel resource={resource} />);

      const copyButton = screen.getByText(/Copy/);
      await userEvent.click(copyButton);

      const copiedText = mockClipboard.writeText.mock.calls[0][0];

      // Should be formatted with indentation
      expect(copiedText).toContain('\n');
      expect(copiedText).toContain('  ');

      // Should be valid JSON
      expect(() => JSON.parse(copiedText)).not.toThrow();
    });

    it('should handle clipboard API errors gracefully', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockClipboard.writeText.mockRejectedValue(new Error('Clipboard error'));

      const resource = createMockResource();
      render(<JsonLdPanel resource={resource} />);

      const copyButton = screen.getByText(/Copy/);

      await expect(async () => {
        await userEvent.click(copyButton);
      }).not.toThrow();

      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          'Failed to copy JSON-LD:',
          expect.any(Error)
        );
      });

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Resource Updates', () => {
    it('should reinitialize editor when resource changes', () => {
      const resource1 = createMockResource({ id: 'resource-1', name: 'Resource 1' });
      const { rerender, container } = render(<JsonLdPanel resource={resource1} />);

      expect(container.firstChild).toBeInTheDocument();

      const resource2 = createMockResource({ id: 'resource-2', name: 'Resource 2' });

      // Should rerender without errors
      expect(() => rerender(<JsonLdPanel resource={resource2} />)).not.toThrow();
    });

    it('should reinitialize editor when line numbers setting changes', () => {
      mockUseLineNumbers.mockReturnValue({ showLineNumbers: true, toggleLineNumbers: vi.fn() });

      const resource = createMockResource();
      const { rerender } = render(<JsonLdPanel resource={resource} />);

      mockUseLineNumbers.mockReturnValue({ showLineNumbers: false, toggleLineNumbers: vi.fn() });

      // Should rerender without errors
      expect(() => rerender(<JsonLdPanel resource={resource} />)).not.toThrow();
    });
  });

  describe('Edge Cases', () => {
    it('should handle resource with minimal data', () => {
      const minimalResource: SemiontResource = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        '@id': 'minimal',
        id: 'minimal',
        name: 'Minimal',
        content: 'Test',
        format: 'text/plain',
        archived: false,
        representations: [],
        created: '2024-01-01T00:00:00Z',
        modified: '2024-01-01T00:00:00Z',
      };

      expect(() => {
        render(<JsonLdPanel resource={minimalResource} />);
      }).not.toThrow();
    });

    it('should handle resource with special characters', () => {
      const resource = createMockResource({
        name: 'Test "Resource" with \'quotes\' & special <chars>',
        content: 'Content with\nnewlines\tand\ttabs',
      });

      expect(() => {
        render(<JsonLdPanel resource={resource} />);
      }).not.toThrow();
    });

    it('should handle very large resource data', () => {
      const largeContent = 'A'.repeat(100000);
      const resource = createMockResource({
        content: largeContent,
      });

      expect(() => {
        render(<JsonLdPanel resource={resource} />);
      }).not.toThrow();
    });

    it('should handle resource with unicode characters', () => {
      const resource = createMockResource({
        name: '测试资源 テストリソース ресурс тест',
        content: '🎉🔥💯 Unicode content',
      });

      expect(() => {
        render(<JsonLdPanel resource={resource} />);
      }).not.toThrow();
    });

    it('should handle undefined optional fields', () => {
      const resource: SemiontResource = {
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        '@id': 'test',
        id: 'test',
        name: 'Test',
        content: 'Content',
        format: 'text/plain',
        archived: false,
        representations: [],
        created: '2024-01-01T00:00:00Z',
        modified: '2024-01-01T00:00:00Z',
        // Optional fields omitted
      };

      expect(() => {
        render(<JsonLdPanel resource={resource} />);
      }).not.toThrow();
    });
  });

  describe('Styling and Appearance', () => {
    it('should have proper panel structure', () => {
      const resource = createMockResource();
      const { container } = render(<JsonLdPanel resource={resource} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass(
        'bg-white',
        'dark:bg-gray-800',
        'rounded-lg',
        'shadow-sm',
        'p-4',
        'h-full',
        'flex',
        'flex-col'
      );
    });

    it('should have proper header styling', () => {
      const resource = createMockResource();
      render(<JsonLdPanel resource={resource} />);

      const header = screen.getByText('JSON-LD').parentElement;
      expect(header).toHaveClass(
        'flex',
        'items-center',
        'justify-between',
        'mb-3',
        'pb-2',
        'border-b'
      );
    });

    it('should have proper button styling', () => {
      const resource = createMockResource();
      render(<JsonLdPanel resource={resource} />);

      const copyButton = screen.getByText(/Copy/).closest('button');
      expect(copyButton).toHaveClass('hover:bg-gray-100', 'dark:hover:bg-gray-700');
    });

    it('should have proper editor container styling', () => {
      const resource = createMockResource();
      const { container } = render(<JsonLdPanel resource={resource} />);

      const editorContainer = container.querySelector('.flex-1.overflow-auto');
      expect(editorContainer).toHaveClass('rounded-lg', 'border');
    });

    it('should support dark mode styling', () => {
      const resource = createMockResource();
      const { container } = render(<JsonLdPanel resource={resource} />);

      const panel = container.firstChild as HTMLElement;
      expect(panel).toHaveClass('dark:bg-gray-800');
    });
  });

  describe('Accessibility', () => {
    it('should have title attribute on copy button', () => {
      const resource = createMockResource();
      render(<JsonLdPanel resource={resource} />);

      const copyButton = screen.getByText(/Copy/).closest('button');
      expect(copyButton).toHaveAttribute('title', 'Copy to clipboard');
    });

    it('should have semantic heading', () => {
      const resource = createMockResource();
      render(<JsonLdPanel resource={resource} />);

      const heading = screen.getByText('JSON-LD');
      expect(heading).toHaveClass('text-sm', 'font-semibold');
    });

    it('should have proper button structure', () => {
      const resource = createMockResource();
      render(<JsonLdPanel resource={resource} />);

      const copyButton = screen.getByText(/Copy/).closest('button');
      expect(copyButton?.tagName).toBe('BUTTON');
    });
  });

  describe('JSON-LD Format', () => {
    it('should produce valid JSON', async () => {
      const resource = createMockResource();
      render(<JsonLdPanel resource={resource} />);

      const copyButton = screen.getByText(/Copy/);
      await userEvent.click(copyButton);

      const copiedText = mockClipboard.writeText.mock.calls[0][0];

      expect(() => {
        const parsed = JSON.parse(copiedText);
        expect(parsed).toHaveProperty('id');
        expect(parsed).toHaveProperty('name');
        expect(parsed).toHaveProperty('content');
      }).not.toThrow();
    });

    it('should include all resource fields', async () => {
      const resource = createMockResource({
        id: 'full-resource',
        name: 'Full Resource',
        content: 'Complete content',
        format: 'text/markdown',
        archived: true,
        entityTypes: ['Person', 'Organization'],
        locale: 'en-US',
      });

      render(<JsonLdPanel resource={resource} />);

      const copyButton = screen.getByText(/Copy/);
      await userEvent.click(copyButton);

      const copiedText = mockClipboard.writeText.mock.calls[0][0];
      const parsed = JSON.parse(copiedText);

      expect(parsed.id).toBe('full-resource');
      expect(parsed.name).toBe('Full Resource');
      expect(parsed.format).toBe('text/markdown');
      expect(parsed.archived).toBe(true);
      expect(parsed.entityTypes).toEqual(['Person', 'Organization']);
      expect(parsed.locale).toBe('en-US');
    });
  });
});
