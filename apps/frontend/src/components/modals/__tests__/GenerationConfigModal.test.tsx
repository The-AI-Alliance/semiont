import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { GenerationConfigModal } from '../GenerationConfigModal';
import type { GatheredContext } from '@semiont/core';

function makeContext(overrides: Partial<GatheredContext> = {}): GatheredContext {
  return {
    sourceContext: {
      before: 'Before text. ',
      selected: 'entity mention',
      after: '. After text.',
    },
    metadata: {
      entityTypes: ['Person', 'Organization'],
    },
    graphContext: {
      connections: [
        { resourceId: 'r1', resourceName: 'Alpha Doc', bidirectional: true, entityTypes: ['Person'] },
        { resourceId: 'r2', resourceName: 'Beta Doc', bidirectional: false, entityTypes: [] },
      ],
      citedBy: [
        { resourceId: 'r3', resourceName: 'Gamma Doc' },
      ],
      citedByCount: 1,
      siblingEntityTypes: ['Location', 'Event'],
    },
    ...overrides,
  };
}

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  onGenerate: vi.fn(),
  defaultTitle: 'Test Entity',
  context: makeContext(),
  contextLoading: false,
  contextError: null,
};

describe('GenerationConfigModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders the modal title', () => {
      render(<GenerationConfigModal {...defaultProps} />);
      expect(screen.getByText('Configure Resource Generation')).toBeInTheDocument();
    });

    it('renders source context with highlighted selection', () => {
      render(<GenerationConfigModal {...defaultProps} />);
      expect(screen.getByText(/Before text/)).toBeInTheDocument();
      expect(screen.getByText('entity mention')).toBeInTheDocument();
      expect(screen.getByText(/After text/)).toBeInTheDocument();
    });

    it('renders entity type badges', () => {
      render(<GenerationConfigModal {...defaultProps} />);
      // "Person" appears both as entity type badge and in connection entity types
      expect(screen.getAllByText('Person').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Organization')).toBeInTheDocument();
    });

    it('does not render entity type badges section when empty', () => {
      const ctx = makeContext({
        metadata: { entityTypes: [] },
        graphContext: { connections: [], citedBy: [], citedByCount: 0, siblingEntityTypes: [] },
      });
      render(<GenerationConfigModal {...defaultProps} context={ctx} />);
      // Entity type badge section should not appear (the label "Entity Types" comes from translation)
      expect(screen.queryByText('Entity Types')).not.toBeInTheDocument();
    });
  });

  describe('graph context', () => {
    it('renders connections with names', () => {
      render(<GenerationConfigModal {...defaultProps} />);
      expect(screen.getByText('Alpha Doc')).toBeInTheDocument();
      expect(screen.getByText('Beta Doc')).toBeInTheDocument();
    });

    it('renders mutual badge for bidirectional connections', () => {
      render(<GenerationConfigModal {...defaultProps} />);
      const mutualBadges = screen.getAllByText('mutual');
      expect(mutualBadges).toHaveLength(1);
    });

    it('renders connection entity types', () => {
      render(<GenerationConfigModal {...defaultProps} />);
      // Alpha Doc has entityTypes: ['Person'] shown as comma-joined text
      const personTexts = screen.getAllByText('Person');
      // One from entity type badge, one from connection
      expect(personTexts.length).toBeGreaterThanOrEqual(2);
    });

    it('renders citedBy with count', () => {
      render(<GenerationConfigModal {...defaultProps} />);
      expect(screen.getByText('Gamma Doc')).toBeInTheDocument();
    });

    it('renders sibling entity types', () => {
      render(<GenerationConfigModal {...defaultProps} />);
      expect(screen.getByText('Location')).toBeInTheDocument();
      expect(screen.getByText('Event')).toBeInTheDocument();
    });

    it('does not render graph section when context has no graph data', () => {
      const ctx = makeContext({
        graphContext: {
          connections: [],
          citedBy: [],
          citedByCount: 0,
          siblingEntityTypes: [],
        },
      });
      render(<GenerationConfigModal {...defaultProps} context={ctx} />);
      expect(screen.queryByText('Alpha Doc')).not.toBeInTheDocument();
      expect(screen.queryByText('Location')).not.toBeInTheDocument();
    });

    it('does not render graph section when graphContext is absent', () => {
      const { graphContext: _, ...rest } = makeContext();
      const ctx = rest as GatheredContext;
      render(<GenerationConfigModal {...defaultProps} context={ctx} />);
      expect(screen.queryByText('Alpha Doc')).not.toBeInTheDocument();
    });
  });

  describe('loading and error states', () => {
    it('shows loading indicator when contextLoading is true', () => {
      render(
        <GenerationConfigModal {...defaultProps} contextLoading={true} context={null} />
      );
      expect(screen.getByText('Loading context...')).toBeInTheDocument();
    });

    it('shows error message when contextError is set', () => {
      render(
        <GenerationConfigModal
          {...defaultProps}
          contextError={new Error('Network error')}
          context={null}
        />
      );
      expect(screen.getByText('Failed to load context')).toBeInTheDocument();
    });

    it('disables generate button when contextLoading', () => {
      render(
        <GenerationConfigModal {...defaultProps} contextLoading={true} context={null} />
      );
      const generateBtn = screen.getByRole('button', { name: /Generate/ });
      expect(generateBtn).toBeDisabled();
    });

    it('disables generate button when context is null', () => {
      render(
        <GenerationConfigModal {...defaultProps} context={null} />
      );
      const generateBtn = screen.getByRole('button', { name: /Generate/ });
      expect(generateBtn).toBeDisabled();
    });

    it('enables generate button when context is loaded', () => {
      render(<GenerationConfigModal {...defaultProps} />);
      const generateBtn = screen.getByRole('button', { name: /Generate/ });
      expect(generateBtn).not.toBeDisabled();
    });
  });

  describe('form submission', () => {
    it('calls onGenerate with form values on submit', () => {
      const onGenerate = vi.fn();
      render(<GenerationConfigModal {...defaultProps} onGenerate={onGenerate} />);

      fireEvent.click(screen.getByRole('button', { name: /Generate/ }));

      expect(onGenerate).toHaveBeenCalledTimes(1);
      const call = onGenerate.mock.calls[0]![0];
      expect(call.title).toBe('Test Entity');
      expect(call.context).toEqual(defaultProps.context);
      expect(call.language).toBe('en');
      expect(call.temperature).toBe(0.7);
      expect(call.maxTokens).toBe(500);
    });

    it('does not include prompt when empty', () => {
      const onGenerate = vi.fn();
      render(<GenerationConfigModal {...defaultProps} onGenerate={onGenerate} />);

      fireEvent.click(screen.getByRole('button', { name: /Generate/ }));

      const call = onGenerate.mock.calls[0]![0];
      expect(call).not.toHaveProperty('prompt');
    });

    it('calls onClose after submission', () => {
      const onClose = vi.fn();
      render(<GenerationConfigModal {...defaultProps} onClose={onClose} />);

      fireEvent.click(screen.getByRole('button', { name: /Generate/ }));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when cancel is clicked', () => {
      const onClose = vi.fn();
      render(<GenerationConfigModal {...defaultProps} onClose={onClose} />);

      fireEvent.click(screen.getByText('Cancel'));

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not call onGenerate when context is null', () => {
      const onGenerate = vi.fn();
      render(
        <GenerationConfigModal {...defaultProps} onGenerate={onGenerate} context={null} />
      );

      // Button is disabled, but try clicking anyway
      const generateBtn = screen.getByRole('button', { name: /Generate/ });
      fireEvent.click(generateBtn);

      expect(onGenerate).not.toHaveBeenCalled();
    });
  });

  describe('form controls', () => {
    it('populates title from defaultTitle', () => {
      render(<GenerationConfigModal {...defaultProps} />);
      const titleInput = screen.getByDisplayValue('Test Entity');
      expect(titleInput).toBeInTheDocument();
    });

    it('renders temperature slider', () => {
      render(<GenerationConfigModal {...defaultProps} />);
      const slider = document.querySelector('input[type="range"]');
      expect(slider).toBeInTheDocument();
    });

    it('renders max tokens input', () => {
      render(<GenerationConfigModal {...defaultProps} />);
      const tokensInput = screen.getByDisplayValue('500');
      expect(tokensInput).toBeInTheDocument();
    });

    it('renders language selector', () => {
      render(<GenerationConfigModal {...defaultProps} />);
      const select = document.querySelector('select#language');
      expect(select).toBeInTheDocument();
    });
  });

  describe('not open', () => {
    it('does not render content when isOpen is false', () => {
      render(<GenerationConfigModal {...defaultProps} isOpen={false} />);
      expect(screen.queryByText('Configure Resource Generation')).not.toBeInTheDocument();
    });
  });
});
