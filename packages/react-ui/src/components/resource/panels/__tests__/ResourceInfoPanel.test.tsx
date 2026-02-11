import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ResourceInfoPanel } from '../ResourceInfoPanel';

// Mock event bus
const mockEmit = vi.fn();
const mockEventBus = {
  emit: mockEmit,
  on: vi.fn(),
  off: vi.fn(),
  all: new Map(),
};

// Mock MakeMeaningEventBusContext
vi.mock('../../../../contexts/MakeMeaningEventBusContext', () => ({
  useMakeMeaningEvents: () => mockEventBus,
}));

// Mock TranslationContext
vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: vi.fn(() => (key: string) => {
    const translations: Record<string, string> = {
      locale: 'Locale',
      notSpecified: 'Not specified',
      entityTypeTags: 'Entity Type Tags',
      representation: 'Representation',
      mediaType: 'Media Type',
      byteSize: 'Size',
      clone: 'Clone',
      cloneDescription: 'Generate a shareable clone link for this resource',
      archive: 'Archive',
      archiveDescription: 'Move this resource to archived status',
      unarchive: 'Unarchive',
      unarchiveDescription: 'Restore this resource to active status',
    };
    return translations[key] || key;
  }),
}));

// Mock @semiont/api-client utilities
vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual('@semiont/api-client');
  return {
    ...actual,
    formatLocaleDisplay: vi.fn((locale: string) => `Language: ${locale}`),
  };
});

// Mock button styles
vi.mock('@/lib/button-styles', () => ({
  buttonStyles: {
    secondary: {
      base: 'px-4 py-2 rounded-lg font-medium',
    },
  },
}));

describe('ResourceInfoPanel Component', () => {
  const defaultProps = {
    documentEntityTypes: [],
    documentLocale: undefined,
    primaryMediaType: undefined,
    primaryByteSize: undefined,
  };

  beforeEach(() => {
    mockEmit.mockClear();
  });

  describe('Rendering', () => {
    it('should render locale section', () => {
      render(<ResourceInfoPanel {...defaultProps} />);
      expect(screen.getByText('Locale')).toBeInTheDocument();
    });

    it('should render locale when provided', () => {
      render(<ResourceInfoPanel {...defaultProps} documentLocale="en-US" />);
      // formatLocaleDisplay is mocked to return "Language: {locale}"
      expect(screen.getByText('Language: en-US')).toBeInTheDocument();
    });

    it('should show "not specified" when locale is undefined', () => {
      render(<ResourceInfoPanel {...defaultProps} documentLocale={undefined} />);
      expect(screen.getByText('Not specified')).toBeInTheDocument();
    });

    it('should render entity type tags when provided', () => {
      render(
        <ResourceInfoPanel
          {...defaultProps}
          documentEntityTypes={['Person', 'Organization', 'Location']}
        />
      );

      expect(screen.getByText('Entity Type Tags')).toBeInTheDocument();
      expect(screen.getByText('Person')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
      expect(screen.getByText('Location')).toBeInTheDocument();
    });

    it('should not render entity type tags section when empty', () => {
      render(<ResourceInfoPanel {...defaultProps} documentEntityTypes={[]} />);
      expect(screen.queryByText('Entity Type Tags')).not.toBeInTheDocument();
    });

    it('should render representation section when media type provided', () => {
      render(
        <ResourceInfoPanel
          {...defaultProps}
          primaryMediaType="text/markdown"
        />
      );

      expect(screen.getByText('Representation')).toBeInTheDocument();
      expect(screen.getByText('Media Type')).toBeInTheDocument();
      expect(screen.getByText('text/markdown')).toBeInTheDocument();
    });

    it('should render byte size when provided', () => {
      render(
        <ResourceInfoPanel
          {...defaultProps}
          primaryByteSize={1024}
        />
      );

      expect(screen.getByText('Representation')).toBeInTheDocument();
      expect(screen.getByText('Size')).toBeInTheDocument();
      expect(screen.getByText('1,024 bytes')).toBeInTheDocument();
    });

    it('should not render representation section when neither media type nor byte size provided', () => {
      render(
        <ResourceInfoPanel
          {...defaultProps}
          primaryMediaType={undefined}
          primaryByteSize={undefined}
        />
      );

      expect(screen.queryByText('Representation')).not.toBeInTheDocument();
    });
  });

  describe('Styling and Appearance', () => {
    it('should have proper panel structure', () => {
      const { container } = render(<ResourceInfoPanel {...defaultProps} />);
      expect(container.querySelector('.semiont-resource-info-panel')).toBeInTheDocument();
    });

    it('should style entity type tags appropriately', () => {
      render(
        <ResourceInfoPanel
          {...defaultProps}
          documentEntityTypes={['TestType']}
        />
      );

      const tag = screen.getByText('TestType');
      expect(tag).toHaveClass('semiont-tag');
      expect(tag).toHaveAttribute('data-variant', 'blue');
    });
  });

  describe('Accessibility', () => {
    it('should have semantic heading structure', () => {
      render(
        <ResourceInfoPanel
          {...defaultProps}
          documentLocale="en-US"
          documentEntityTypes={['Person']}
        />
      );

      const headings = screen.getAllByRole('heading', { level: 3 });
      expect(headings.length).toBeGreaterThan(0);
    });
  });

  describe('Clone Action', () => {
    it('should render clone button', () => {
      render(
        <ResourceInfoPanel
          {...defaultProps}
        />
      );

      expect(screen.getByRole('button', { name: /Clone/i })).toBeInTheDocument();
      expect(screen.getByText('Generate a shareable clone link for this resource')).toBeInTheDocument();
    });

    it('should emit resource:clone event when clone button clicked', () => {
      render(
        <ResourceInfoPanel
          {...defaultProps}
        />
      );

      const button = screen.getByRole('button', { name: /Clone/i });
      fireEvent.click(button);
      expect(mockEmit).toHaveBeenCalledWith('resource:clone');
    });
  });

  describe('Archive Actions', () => {
    it('should render archive button when not archived', () => {
      render(
        <ResourceInfoPanel
          {...defaultProps}
          isArchived={false}
        />
      );

      expect(screen.getByRole('button', { name: /Archive/i })).toBeInTheDocument();
      expect(screen.getByText('Move this resource to archived status')).toBeInTheDocument();
    });

    it('should render unarchive button when archived', () => {
      render(
        <ResourceInfoPanel
          {...defaultProps}
          isArchived={true}
        />
      );

      expect(screen.getByRole('button', { name: /Unarchive/i })).toBeInTheDocument();
      expect(screen.getByText('Restore this resource to active status')).toBeInTheDocument();
    });

    it('should emit resource:archive event when archive button clicked', () => {
      render(
        <ResourceInfoPanel
          {...defaultProps}
          isArchived={false}
        />
      );

      const button = screen.getByRole('button', { name: /Archive/i });
      fireEvent.click(button);
      expect(mockEmit).toHaveBeenCalledWith('resource:archive');
    });

    it('should emit resource:unarchive event when unarchive button clicked', () => {
      render(
        <ResourceInfoPanel
          {...defaultProps}
          isArchived={true}
        />
      );

      const button = screen.getByRole('button', { name: /Unarchive/i });
      fireEvent.click(button);
      expect(mockEmit).toHaveBeenCalledWith('resource:unarchive');
    });
  });
});
