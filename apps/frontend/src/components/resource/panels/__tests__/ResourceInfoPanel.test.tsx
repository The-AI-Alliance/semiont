import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ResourceInfoPanel } from '../ResourceInfoPanel';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: vi.fn(() => (key: string) => {
    const translations: Record<string, string> = {
      locale: 'Locale',
      notSpecified: 'Not specified',
      entityTypeTags: 'Entity Type Tags',
      representation: 'Representation',
      mediaType: 'Media Type',
      byteSize: 'Size',
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

describe('ResourceInfoPanel Component', () => {
  const defaultProps = {
    documentEntityTypes: [],
    documentLocale: undefined,
    primaryMediaType: undefined,
    primaryByteSize: undefined,
  };

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
      expect(container.querySelector('.bg-white.dark\\:bg-gray-800')).toBeInTheDocument();
    });

    it('should style entity type tags appropriately', () => {
      render(
        <ResourceInfoPanel
          {...defaultProps}
          documentEntityTypes={['TestType']}
        />
      );

      const tag = screen.getByText('TestType');
      expect(tag).toHaveClass('bg-blue-100');
      expect(tag).toHaveClass('dark:bg-blue-900/30');
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
});
