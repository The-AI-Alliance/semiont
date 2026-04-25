import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../../../test-utils';
import userEvent from '@testing-library/user-event';
import type { components } from '@semiont/core';

import type { Annotation } from '@semiont/core';

// Mock @semiont/api-client
vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual('@semiont/api-client');
  return {
    ...actual,
    getAnnotationExactText: vi.fn(),
  };
});

import { getAnnotationExactText } from '@semiont/core';
import type { MockedFunction } from 'vitest';
import { AssessmentEntry } from '../AssessmentEntry';

const mockGetAnnotationExactText = getAnnotationExactText as MockedFunction<typeof getAnnotationExactText>;

const createMockAssessment = (overrides?: Partial<Annotation>): Annotation => ({
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: 'assessment-1',
  type: 'Annotation',
  motivation: 'assessing',
  creator: {
    name: 'reviewer@example.com',
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
  body: {
    type: 'TextualBody',
    value: 'This passage needs clarification',
  },
  ...overrides,
});

describe('AssessmentEntry', () => {
  const defaultProps = {
    assessment: createMockAssessment(),
    isFocused: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAnnotationExactText.mockReturnValue('Selected passage text');
  });

  describe('Rendering', () => {
    it('should render the selected text in quotes', () => {
      renderWithProviders(<AssessmentEntry {...defaultProps} />);

      expect(screen.getByText(/Selected passage text/)).toBeInTheDocument();
    });

    it('should render the assessment body text', () => {
      renderWithProviders(<AssessmentEntry {...defaultProps} />);

      expect(screen.getByText('This passage needs clarification')).toBeInTheDocument();
    });

    it('should handle a TextualBody directly on body', () => {
      const assessment = createMockAssessment({
        body: {
          type: 'TextualBody',
          value: 'Direct body assessment',
        },
      });

      renderWithProviders(
        <AssessmentEntry assessment={assessment} isFocused={false} />
      );

      expect(screen.getByText('Direct body assessment')).toBeInTheDocument();
    });

    it('should handle an array of bodies and find TextualBody', () => {
      const assessment = createMockAssessment({
        body: [
          { type: 'TextualBody', value: 'Array body assessment' },
          { type: 'TextualBody', value: 'Second body', purpose: 'tagging' },
        ],
      });

      renderWithProviders(
        <AssessmentEntry assessment={assessment} isFocused={false} />
      );

      expect(screen.getByText('Array body assessment')).toBeInTheDocument();
    });

    it('should truncate selected text at 100 characters', () => {
      const longText = 'X'.repeat(150);
      mockGetAnnotationExactText.mockReturnValue(longText);

      renderWithProviders(<AssessmentEntry {...defaultProps} />);

      expect(screen.getByText(new RegExp(`"${'X'.repeat(100)}`))).toBeInTheDocument();
      expect(screen.getByText(/\.\.\./)).toBeInTheDocument();
    });

    it('should show creator name', () => {
      renderWithProviders(<AssessmentEntry {...defaultProps} />);

      expect(screen.getByText(/reviewer@example.com/)).toBeInTheDocument();
    });

    it('should show "Unknown" for missing creator', () => {
      const assessment = createMockAssessment();
      delete (assessment as Record<string, unknown>).creator;

      renderWithProviders(
        <AssessmentEntry assessment={assessment} isFocused={false} />
      );

      expect(screen.getByText(/Unknown/)).toBeInTheDocument();
    });

    it('should handle missing body gracefully', () => {
      const assessment = createMockAssessment();
      delete (assessment as Record<string, unknown>).body;

      const { container } = renderWithProviders(
        <AssessmentEntry assessment={assessment} isFocused={false} />
      );

      // Body section should not render
      expect(container.querySelector('.semiont-annotation-entry__body')).not.toBeInTheDocument();
    });

    it('should not render quote section when selectedText is empty', () => {
      mockGetAnnotationExactText.mockReturnValue('');

      const { container } = renderWithProviders(<AssessmentEntry {...defaultProps} />);

      expect(container.querySelector('.semiont-annotation-entry__quote')).not.toBeInTheDocument();
    });

    it('should format relative time for recent assessments', () => {
      const recentAssessment = createMockAssessment({
        created: new Date(Date.now() - 30000).toISOString(),
      });

      renderWithProviders(
        <AssessmentEntry assessment={recentAssessment} isFocused={false} />
      );

      expect(screen.getByText(/just now/)).toBeInTheDocument();
    });
  });

  describe('Interactions', () => {
    it('should emit browse:click on click', async () => {
      const clickHandler = vi.fn();

      const { container, eventBus } = renderWithProviders(
        <AssessmentEntry {...defaultProps} />,
        { returnEventBus: true }
      );

      const subscription = eventBus!.get('browse:click').subscribe(clickHandler);

      const entry = container.firstChild as HTMLElement;
      await userEvent.click(entry);

      expect(clickHandler).toHaveBeenCalledWith({
        annotationId: 'assessment-1',
        motivation: 'assessing',
      });

      subscription.unsubscribe();
    });
  });

  describe('Hover state', () => {
    it('should apply pulse class when isHovered is true', () => {
      const { container } = renderWithProviders(
        <AssessmentEntry {...defaultProps} isHovered={true} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveClass('semiont-annotation-pulse');
    });

    it('should not apply pulse class when isHovered is false', () => {
      const { container } = renderWithProviders(
        <AssessmentEntry {...defaultProps} isHovered={false} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).not.toHaveClass('semiont-annotation-pulse');
    });
  });

  describe('Focus state', () => {
    it('should set data-focused to true when focused', () => {
      const { container } = renderWithProviders(
        <AssessmentEntry {...defaultProps} isFocused={true} />
      );

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveAttribute('data-focused', 'true');
    });

    it('should set data-type to assessment', () => {
      const { container } = renderWithProviders(<AssessmentEntry {...defaultProps} />);

      const entry = container.firstChild as HTMLElement;
      expect(entry).toHaveAttribute('data-type', 'assessment');
    });
  });
});
