import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SemiontBranding } from '../SemiontBranding';

describe('SemiontBranding Component', () => {
  const mockTranslate = vi.fn((key: string) => {
    const translations: Record<string, string> = {
      'tagline': 'Semantic Annotation Tool',
    };
    return translations[key] || key;
  });

  beforeEach(() => {
    mockTranslate.mockClear();
  });

  describe('Basic Rendering', () => {
    it('should render the Semiont heading', () => {
      render(<SemiontBranding t={mockTranslate} />);

      expect(screen.getByText('Semiont')).toBeInTheDocument();
    });

    it('should render the tagline by default', () => {
      render(<SemiontBranding t={mockTranslate} />);

      expect(screen.getByText('Semantic Annotation Tool')).toBeInTheDocument();
      expect(mockTranslate).toHaveBeenCalledWith('tagline');
    });

    it('should render main heading as h1', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} />);

      const h1 = container.querySelector('h1');
      expect(h1).toBeInTheDocument();
      expect(h1).toHaveTextContent('Semiont');
    });

    it('should render tagline as h2 when shown', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} />);

      const h2 = container.querySelector('h2');
      expect(h2).toBeInTheDocument();
      expect(h2).toHaveTextContent('Semantic Annotation Tool');
    });
  });

  describe('Tagline Display Control', () => {
    it('should show tagline when showTagline is true', () => {
      render(<SemiontBranding t={mockTranslate} showTagline={true} />);

      expect(screen.getByText('Semantic Annotation Tool')).toBeInTheDocument();
    });

    it('should hide tagline when showTagline is false', () => {
      render(<SemiontBranding t={mockTranslate} showTagline={false} />);

      expect(screen.queryByText('Semantic Annotation Tool')).not.toBeInTheDocument();
      expect(mockTranslate).not.toHaveBeenCalledWith('tagline');
    });

    it('should not render h2 when tagline is hidden', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} showTagline={false} />);

      expect(container.querySelector('h2')).not.toBeInTheDocument();
    });
  });

  describe('Size Variants', () => {
    it('should apply small size classes', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} size="sm" />);

      const h1 = container.querySelector('h1');
      expect(h1).toHaveClass('semiont-heading semiont-heading--lg');
    });

    it('should apply medium size classes', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} size="md" />);

      const h1 = container.querySelector('h1');
      expect(h1).toHaveClass('semiont-heading semiont-heading--xl');
    });

    it('should apply large size classes by default', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} />);

      const h1 = container.querySelector('h1');
      expect(h1).toHaveClass('semiont-heading semiont-heading--2xl');
    });

    it('should apply extra large size classes', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} size="xl" />);

      const h1 = container.querySelector('h1');
      expect(h1).toHaveClass('semiont-heading semiont-heading--3xl');
    });
  });

  describe('Tagline Size Variants', () => {
    it('should apply small tagline size', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} size="sm" showTagline={true} />);

      const h2 = container.querySelector('h2');
      expect(h2).toHaveClass('semiont-heading semiont-heading--sm');
    });

    it('should apply medium tagline size', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} size="md" showTagline={true} />);

      const h2 = container.querySelector('h2');
      expect(h2).toHaveClass('semiont-heading semiont-heading--md');
    });

    it('should apply large tagline size', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} size="lg" showTagline={true} />);

      const h2 = container.querySelector('h2');
      expect(h2).toHaveClass('semiont-heading semiont-heading--md');
    });

    it('should apply extra large tagline size', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} size="xl" showTagline={true} />);

      const h2 = container.querySelector('h2');
      expect(h2).toHaveClass('semiont-heading semiont-heading--lg');
    });
  });

  describe('Compact Tagline Mode', () => {
    it('should apply compact tagline styles when compactTagline is true', () => {
      const { container } = render(
        <SemiontBranding t={mockTranslate} compactTagline={true} />
      );

      const h2 = container.querySelector('h2');
      expect(h2).toHaveClass('tracking-widest');
    });

    it('should apply different spacing with compact tagline', () => {
      const { container } = render(
        <SemiontBranding t={mockTranslate} compactTagline={true} />
      );

      const h1 = container.querySelector('h1');
      expect(h1).toHaveClass('mb-1');
    });

    it('should apply normal spacing without compact tagline', () => {
      const { container } = render(
        <SemiontBranding t={mockTranslate} compactTagline={false} />
      );

      const h1 = container.querySelector('h1');
      expect(h1).toHaveClass('mb-6', 'sm:mb-8');
    });

    it('should use compact size classes with compactTagline', () => {
      const { container } = render(
        <SemiontBranding t={mockTranslate} size="sm" compactTagline={true} />
      );

      const h2 = container.querySelector('h2');
      expect(h2).toHaveClass('semiont-collaboration-panel__status-text');
    });

    it('should apply tracking-wide for normal tagline', () => {
      const { container } = render(
        <SemiontBranding t={mockTranslate} compactTagline={false} />
      );

      const h2 = container.querySelector('h2');
      expect(h2).toHaveClass('tracking-wide');
    });
  });

  describe('Animation', () => {
    it('should apply animation classes by default', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} />);

      const h1 = container.querySelector('h1');
      expect(h1).toHaveClass('animate-in', 'fade-in', 'slide-in-from-bottom-4', 'duration-1000', 'ease-out');
    });

    it('should apply delayed animation to tagline', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} />);

      const h2 = container.querySelector('h2');
      expect(h2).toHaveClass('animate-in', 'fade-in', 'slide-in-from-bottom-2', 'duration-1000', 'ease-out', 'delay-300');
    });

    it('should not apply animation classes when animated is false', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} animated={false} />);

      const h1 = container.querySelector('h1');
      expect(h1).not.toHaveClass('animate-in');
      expect(h1).not.toHaveClass('fade-in');
      expect(h1).not.toHaveClass('slide-in-from-bottom-4');
    });

    it('should not animate tagline when animated is false', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} animated={false} />);

      const h2 = container.querySelector('h2');
      expect(h2).not.toHaveClass('animate-in');
      expect(h2).not.toHaveClass('fade-in');
      expect(h2).not.toHaveClass('delay-300');
    });
  });

  describe('Custom Styling', () => {
    it('should apply custom className', () => {
      const { container } = render(
        <SemiontBranding t={mockTranslate} className="custom-class" />
      );

      const wrapper = container.querySelector('.custom-class');
      expect(wrapper).toBeInTheDocument();
    });

    it('should preserve default classes with custom className', () => {
      const { container } = render(
        <SemiontBranding t={mockTranslate} className="custom-class" />
      );

      const wrapper = container.querySelector('.custom-class');
      expect(wrapper).toHaveClass('flex', 'flex-col', 'items-center', 'justify-center', 'text-center');
    });

    it('should apply empty className by default', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} />);

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('flex', 'flex-col', 'items-center', 'justify-center', 'text-center');
    });
  });

  describe('Typography Classes', () => {
    it('should apply font-orbitron to heading', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} />);

      const h1 = container.querySelector('h1');
      expect(h1).toHaveClass('font-orbitron', 'uppercase');
    });

    it('should apply font-orbitron to tagline', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} />);

      const h2 = container.querySelector('h2');
      expect(h2).toHaveClass('font-orbitron');
    });

    it('should apply gradient text to heading', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} />);

      const span = container.querySelector('h1 span');
      expect(span).toHaveClass('bg-clip-text', 'text-transparent', 'bg-gradient-to-r');
    });

    it('should apply color classes to tagline', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} />);

      const h2 = container.querySelector('h2');
      expect(h2).toHaveClass('text-cyan-600', 'dark:text-cyan-400');
    });
  });

  describe('Layout Structure', () => {
    it('should have flex column layout', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} />);

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('flex', 'flex-col');
    });

    it('should center items', () => {
      const { container } = render(<SemiontBranding t={mockTranslate} />);

      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('items-center', 'justify-center', 'text-center');
    });
  });

  describe('Translation Integration', () => {
    it('should call translate function with tagline key', () => {
      render(<SemiontBranding t={mockTranslate} showTagline={true} />);

      expect(mockTranslate).toHaveBeenCalledWith('tagline');
      expect(mockTranslate).toHaveBeenCalledTimes(1);
    });

    it('should not call translate when tagline is hidden', () => {
      render(<SemiontBranding t={mockTranslate} showTagline={false} />);

      expect(mockTranslate).not.toHaveBeenCalled();
    });

    it('should display custom translation', () => {
      const customTranslate = vi.fn(() => 'Custom Tagline Text');

      render(<SemiontBranding t={customTranslate} />);

      expect(screen.getByText('Custom Tagline Text')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing translation gracefully', () => {
      const emptyTranslate = vi.fn((key: string) => '');

      render(<SemiontBranding t={emptyTranslate} />);

      const h2 = screen.queryByRole('heading', { level: 2 });
      expect(h2).toBeInTheDocument();
      expect(h2).toHaveTextContent('');
    });

    it('should combine all props correctly', () => {
      const { container } = render(
        <SemiontBranding
          t={mockTranslate}
          size="md"
          showTagline={true}
          animated={false}
          compactTagline={true}
          className="custom"
        />
      );

      const h1 = container.querySelector('h1');
      const h2 = container.querySelector('h2');

      expect(h1).toHaveClass('text-3xl', 'mb-1');
      expect(h1).not.toHaveClass('animate-in');
      expect(h2).toHaveClass('tracking-widest', 'text-base');
      expect(h2).not.toHaveClass('animate-in');
      expect(container.querySelector('.custom')).toBeInTheDocument();
    });
  });

  describe('Spacing Behavior', () => {
    it('should not apply margin-bottom when tagline is hidden', () => {
      const { container } = render(
        <SemiontBranding t={mockTranslate} showTagline={false} />
      );

      const h1 = container.querySelector('h1');
      expect(h1).not.toHaveClass('mb-1');
      expect(h1).not.toHaveClass('mb-6');
      expect(h1).not.toHaveClass('sm:mb-8');
    });

    it('should apply margin-bottom when tagline is shown', () => {
      const { container } = render(
        <SemiontBranding t={mockTranslate} showTagline={true} compactTagline={false} />
      );

      const h1 = container.querySelector('h1');
      expect(h1).toHaveClass('mb-6', 'sm:mb-8');
    });
  });
});
