import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../../../test-utils';
import userEvent from '@testing-library/user-event';
import type { components } from '@semiont/core';

type Annotation = components['schemas']['Annotation'];

// Mock @semiont/api-client
vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual('@semiont/api-client');
  return {
    ...actual,
    getAnnotationExactText: vi.fn(),
  };
});

import { getAnnotationExactText } from '@semiont/api-client';
import type { MockedFunction } from 'vitest';
import { HighlightEntry } from '../HighlightEntry';

const mockGetAnnotationExactText = getAnnotationExactText as MockedFunction<typeof getAnnotationExactText>;

const createMockHighlight = (overrides?: Partial<Annotation>): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: 'highlight-1',
  type: 'Annotation',
  motivation: 'highlighting',
  creator: {
    name: 'alice@example.com',
  },
  created: '2024-06-15T12:00:00Z',
  modified: '2024-06-15T12:00:00Z',
  target: {
    source: 'resource-1',
    selector: {
      type: 'TextPositionSelector',
      start: 0,
      end: 50,
    },
  },
  ...overrides,
});

describe('HighlightEntry', () => {
  const defaultProps = {
    highlight: createMockHighlight(),
    isFocused: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAnnotationExactText.mockReturnValue('This is the highlighted text');
  });

  describe('Rendering', () => {
    it('should render the selected text in quotes', () => {
      renderWithProviders(<HighlightEntry {...defaultProps} />);

      expect(screen.getByText(/This is the highlighted text/)).toBeInTheDocument();
    });

    it('should truncate text over 200 characters', () => {
      const longText = 'A'.repeat(250);
      mockGetAnnotationExactText.mockReturnValue(longText);

      renderWithProviders(<HighlightEntry {...defaultProps} />);

      // Should show first 200 chars followed by ellipsis
      expect(screen.getByText(new RegExp(`"${'A'.repeat(200)}`))).toBeInTheDocument();
      expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
    });

    it('should not truncate text at exactly 200 characters', () => {
      const exactText = 'B'.repeat(200);
      mockGetAnnotationExactText.mockReturnValue(exactText);

      const { container } = renderWithProviders(<HighlightEntry {...defaultProps} />);

      const quote = container.querySelector('.semiont-annotation-entry__quote');
      expect(quote).toBeInTheDocument();
      expect(quote!.textContent).not.toContain('...');
    });

    it('should show creator name', () => {
      renderWithProviders(<HighlightEntry {...defaultProps} />);

      expect(screen.getByText(/alice@example.com/)).toBeInTheDocument();
    });

    it('should show "Unknown" for missing creator', () => {
      const highlight = createMockHighlight();
      delete (highlight as Record<string, unknown>).creator;

      renderWithProviders(
        <HighlightEntry highlight={highlight} isFocused={false} />
      );

      expect(screen.getByText(/Unknown/)).toBeInTheDocument();
    });

    it('should format relative time', () => {
      const recentHighlight = createMockHighlight({
        created: new Date(Date.now() - 30000).toISOString(),
      });

      renderWithProviders(
        <HighlightEntry highlight={recentHighlight} isFocused={false} />
      );

      expect(screen.getByText(/just now/)).toBeInTheDocument();
    });

    it('should not render quote section when selectedText is empty', () => {
      mockGetAnnotationExactText.mockReturnValue('');

      const { container } = renderWithProviders(<HighlightEntry {...defaultProps} />);

      expect(container.querySelector('.semiont-annotation-entry__quote')).not.toBeInTheDocument();
    });
  });

  describe('Interactions', () => {
    it('should emit browse:click on click', async () => {
      const clickHandler = vi.fn();

      const { container, eventBus } = renderWithProviders(
        <HighlightEntry {...defaultProps} />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('browse:click').subscribe(clickHandler);

      const entry = container.firstChild as HTMLElement;
      await userEvent.click(entry);

      expect(clickHandler).toHaveBeenCalledWith({
        annotationId: 'highlight-1',
        motivation: 'highlighting',
      });

      subscription.unsubscribe();
    });
  });

  describe('Hover state', () => {
    it('should apply pulse class when isHovered is true', () => {
      const { container } = renderWithProviders(
        <HighlightEntry {...defaultProps} isHovered={true} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveClass('semiont-annotation-pulse');
    });

    it('should not apply pulse class when isHovered is false', () => {
      const { container } = renderWithProviders(
        <HighlightEntry {...defaultProps} isHovered={false} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).not.toHaveClass('semiont-annotation-pulse');
    });
  });

  describe('Focus state', () => {
    it('should set data-focused to true when focused', () => {
      const { container } = renderWithProviders(
        <HighlightEntry {...defaultProps} isFocused={true} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveAttribute('data-focused', 'true');
    });

    it('should set data-focused to false when not focused', () => {
      const { container } = renderWithProviders(
        <HighlightEntry {...defaultProps} isFocused={false} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveAttribute('data-focused', 'false');
    });
  });
});
