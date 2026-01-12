import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SemiontFavicon } from './SemiontFavicon';

describe('SemiontFavicon', () => {
  it('renders with default props', () => {
    const { container } = render(<SemiontFavicon />);
    const svg = container.querySelector('svg');

    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('width', '32');
    expect(svg).toHaveAttribute('height', '32');
    expect(svg).toHaveAttribute('aria-label', 'Semiont Logo');
  });

  it('renders with custom size', () => {
    const { container } = render(<SemiontFavicon size={64} />);
    const svg = container.querySelector('svg');

    expect(svg).toHaveAttribute('width', '64');
    expect(svg).toHaveAttribute('height', '64');
  });

  it('renders with custom className', () => {
    const { container } = render(<SemiontFavicon className="custom-class" />);
    const svg = container.querySelector('svg');

    expect(svg).toHaveClass('custom-class');
  });

  describe('variants', () => {
    it('renders gradient variant by default', () => {
      const { container } = render(<SemiontFavicon />);
      const text = container.querySelector('text');
      const gradientDef = container.querySelector('#semiontGradient');

      expect(gradientDef).toBeInTheDocument();
      expect(text).toHaveAttribute('fill', 'url(#semiontGradient)');
      expect(text).toHaveAttribute('stroke', 'none');
    });

    it('renders solid variant', () => {
      const { container } = render(<SemiontFavicon variant="solid" />);
      const text = container.querySelector('text');

      expect(text).toHaveAttribute('fill', '#00FFFF');
      expect(text).toHaveAttribute('stroke', 'none');
    });

    it('renders outline variant', () => {
      const { container } = render(<SemiontFavicon variant="outline" />);
      const text = container.querySelector('text');
      const outlineDef = container.querySelector('#semiontOutline');

      expect(outlineDef).toBeInTheDocument();
      expect(text).toHaveAttribute('fill', 'none');
      expect(text).toHaveAttribute('stroke', 'url(#semiontOutline)');
      expect(text).toHaveAttribute('stroke-width', '12');
    });
  });

  describe('background', () => {
    it('renders with background by default', () => {
      const { container } = render(<SemiontFavicon />);
      const rect = container.querySelector('rect');

      expect(rect).toBeInTheDocument();
      expect(rect).toHaveAttribute('fill', '#1a1a1a');
      expect(rect).toHaveAttribute('width', '512');
      expect(rect).toHaveAttribute('height', '512');
    });

    it('renders without background when background={false}', () => {
      const { container } = render(<SemiontFavicon background={false} />);
      const rect = container.querySelector('rect');

      expect(rect).not.toBeInTheDocument();
    });
  });

  it('renders the S letter text', () => {
    const { container } = render(<SemiontFavicon />);
    const text = container.querySelector('text');

    expect(text).toBeInTheDocument();
    expect(text).toHaveTextContent('S');
    expect(text).toHaveAttribute('x', '256');
    expect(text).toHaveAttribute('y', '380');
    expect(text).toHaveAttribute('font-size', '380');
    expect(text).toHaveAttribute('font-weight', '900');
    expect(text).toHaveAttribute('text-anchor', 'middle');
  });

  it('renders gradient stops correctly', () => {
    const { container } = render(<SemiontFavicon />);
    const stops = container.querySelectorAll('#semiontGradient stop');

    expect(stops).toHaveLength(2);
    expect(stops[0]).toHaveAttribute('offset', '0%');
    expect(stops[0]).toHaveStyle({ stopColor: '#00FFFF', stopOpacity: '1' });
    expect(stops[1]).toHaveAttribute('offset', '100%');
    expect(stops[1]).toHaveStyle({ stopColor: '#0080FF', stopOpacity: '1' });
  });

  it('renders outline gradient stops for outline variant', () => {
    const { container } = render(<SemiontFavicon variant="outline" />);
    const outlineStops = container.querySelectorAll('#semiontOutline stop');

    expect(outlineStops).toHaveLength(2);
    expect(outlineStops[0]).toHaveAttribute('offset', '0%');
    expect(outlineStops[0]).toHaveStyle({ stopColor: '#00FFFF', stopOpacity: '1' });
    expect(outlineStops[1]).toHaveAttribute('offset', '100%');
    expect(outlineStops[1]).toHaveStyle({ stopColor: '#0080FF', stopOpacity: '1' });
  });

  it('does not render outline gradient for non-outline variants', () => {
    const { container: gradientContainer } = render(<SemiontFavicon variant="gradient" />);
    const { container: solidContainer } = render(<SemiontFavicon variant="solid" />);

    expect(gradientContainer.querySelector('#semiontOutline')).not.toBeInTheDocument();
    expect(solidContainer.querySelector('#semiontOutline')).not.toBeInTheDocument();
  });

  it('renders with all props combined', () => {
    const { container } = render(
      <SemiontFavicon
        size={128}
        className="test-favicon"
        variant="outline"
        background={false}
      />
    );

    const svg = container.querySelector('svg');
    const rect = container.querySelector('rect');
    const text = container.querySelector('text');

    expect(svg).toHaveAttribute('width', '128');
    expect(svg).toHaveAttribute('height', '128');
    expect(svg).toHaveClass('test-favicon');
    expect(rect).not.toBeInTheDocument();
    expect(text).toHaveAttribute('fill', 'none');
    expect(text).toHaveAttribute('stroke', 'url(#semiontOutline)');
  });
});