/**
 * Button Component Tests
 *
 * Tests for the CSS-agnostic Button component including variants,
 * sizes, states, icons, and accessibility features.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { Button, ButtonGroup } from '../Button';

describe('Button Component', () => {
  describe('Basic Rendering', () => {
    it('should render button with children', () => {
      render(<Button>Click Me</Button>);

      const button = screen.getByRole('button', { name: 'Click Me' });
      expect(button).toBeInTheDocument();
      expect(button).toHaveClass('semiont-button');
    });

    it('should render without children', () => {
      render(<Button aria-label="Empty button" />);

      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
    });

    it('should forward ref to button element', () => {
      const ref = createRef<HTMLButtonElement>();
      render(<Button ref={ref}>Button</Button>);

      expect(ref.current).toBeInstanceOf(HTMLButtonElement);
      expect(ref.current?.textContent).toContain('Button');
    });

    it('should apply custom className', () => {
      render(<Button className="custom-class">Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('semiont-button', 'custom-class');
    });

    it('should pass through HTML button props', () => {
      const handleClick = vi.fn();
      render(
        <Button
          onClick={handleClick}
          title="Button title"
          data-testid="custom-button"
        >
          Button
        </Button>
      );

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('title', 'Button title');
      expect(button).toHaveAttribute('data-testid', 'custom-button');

      fireEvent.click(button);
      expect(handleClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('Button Variants', () => {
    const variants = ['primary', 'secondary', 'tertiary', 'danger', 'warning', 'ghost'] as const;

    variants.forEach(variant => {
      it(`should render ${variant} variant`, () => {
        render(<Button variant={variant}>Button</Button>);

        const button = screen.getByRole('button');
        expect(button).toHaveAttribute('data-variant', variant);
      });
    });

    it('should default to primary variant', () => {
      render(<Button>Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('data-variant', 'primary');
    });
  });

  describe('Button Sizes', () => {
    const sizes = ['xs', 'sm', 'md', 'lg', 'xl'] as const;

    sizes.forEach(size => {
      it(`should render ${size} size`, () => {
        render(<Button size={size}>Button</Button>);

        const button = screen.getByRole('button');
        expect(button).toHaveAttribute('data-size', size);
      });
    });

    it('should default to md size', () => {
      render(<Button>Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('data-size', 'md');
    });
  });

  describe('Button States', () => {
    it('should handle disabled state', () => {
      const handleClick = vi.fn();
      render(<Button disabled onClick={handleClick}>Disabled</Button>);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).toHaveAttribute('data-disabled', 'true');

      fireEvent.click(button);
      expect(handleClick).not.toHaveBeenCalled();
    });

    it('should handle loading state', () => {
      const handleClick = vi.fn();
      render(<Button loading onClick={handleClick}>Loading</Button>);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).toHaveAttribute('data-loading', 'true');
      expect(button).toHaveAttribute('data-disabled', 'true');

      // Loading spinner should be present
      const spinner = button.querySelector('.semiont-button-spinner');
      expect(spinner).toBeInTheDocument();
      expect(spinner).toHaveAttribute('aria-label', 'Loading');

      fireEvent.click(button);
      expect(handleClick).not.toHaveBeenCalled();
    });

    it('should handle active state', () => {
      render(<Button active>Active</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('data-active', 'true');
    });

    it('should handle full width', () => {
      render(<Button fullWidth>Full Width</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('data-full-width', 'true');
    });
  });

  describe('Button Icons', () => {
    it('should render left icon', () => {
      const icon = <span data-testid="left-icon">←</span>;
      render(<Button leftIcon={icon}>Button</Button>);

      const button = screen.getByRole('button');
      const leftIcon = screen.getByTestId('left-icon');
      const iconWrapper = leftIcon.parentElement;

      expect(leftIcon).toBeInTheDocument();
      expect(iconWrapper).toHaveClass('semiont-button-icon', 'semiont-button-icon-left');
    });

    it('should render right icon', () => {
      const icon = <span data-testid="right-icon">→</span>;
      render(<Button rightIcon={icon}>Button</Button>);

      const button = screen.getByRole('button');
      const rightIcon = screen.getByTestId('right-icon');
      const iconWrapper = rightIcon.parentElement;

      expect(rightIcon).toBeInTheDocument();
      expect(iconWrapper).toHaveClass('semiont-button-icon', 'semiont-button-icon-right');
    });

    it('should render both icons', () => {
      const leftIcon = <span data-testid="left-icon">←</span>;
      const rightIcon = <span data-testid="right-icon">→</span>;
      render(<Button leftIcon={leftIcon} rightIcon={rightIcon}>Button</Button>);

      expect(screen.getByTestId('left-icon')).toBeInTheDocument();
      expect(screen.getByTestId('right-icon')).toBeInTheDocument();
    });

    it('should hide icons when loading', () => {
      const leftIcon = <span data-testid="left-icon">←</span>;
      const rightIcon = <span data-testid="right-icon">→</span>;
      render(<Button loading leftIcon={leftIcon} rightIcon={rightIcon}>Button</Button>);

      expect(screen.queryByTestId('left-icon')).not.toBeInTheDocument();
      expect(screen.queryByTestId('right-icon')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Loading')).toBeInTheDocument();
    });

    it('should handle icon-only mode', () => {
      render(
        <Button iconOnly>
          <span data-testid="icon">✓</span>
        </Button>
      );

      const button = screen.getByRole('button');
      const icon = screen.getByTestId('icon');

      expect(button).toHaveAttribute('data-icon-only', 'true');
      expect(icon).toBeInTheDocument();
      // Content wrapper should not exist in icon-only mode
      expect(button.querySelector('.semiont-button-content')).not.toBeInTheDocument();
    });

    it('should wrap regular content in span', () => {
      render(<Button>Text Content</Button>);

      const button = screen.getByRole('button');
      const content = button.querySelector('.semiont-button-content');

      expect(content).toBeInTheDocument();
      expect(content).toHaveTextContent('Text Content');
    });
  });

  describe('Button Types', () => {
    it('should default to type="button"', () => {
      render(<Button>Button</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('type', 'button');
    });

    it('should accept type="submit"', () => {
      render(<Button type="submit">Submit</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('type', 'submit');
    });

    it('should accept type="reset"', () => {
      render(<Button type="reset">Reset</Button>);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('type', 'reset');
    });
  });

  describe('Loading Spinner', () => {
    it('should render spinner SVG with correct structure', () => {
      const { container } = render(<Button loading>Loading</Button>);

      const spinner = container.querySelector('.semiont-button-spinner');
      expect(spinner).toBeInTheDocument();

      const svg = spinner?.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(svg).toHaveClass('semiont-spinner-svg');
      expect(svg).toHaveAttribute('viewBox', '0 0 24 24');

      const circle = svg?.querySelector('.semiont-spinner-circle');
      expect(circle).toBeInTheDocument();

      const path = svg?.querySelector('.semiont-spinner-path');
      expect(path).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA attributes', () => {
      render(<Button>Accessible Button</Button>);

      const button = screen.getByRole('button', { name: 'Accessible Button' });
      expect(button).toBeInTheDocument();
    });

    it('should support aria-label', () => {
      render(<Button aria-label="Custom Label" />);

      const button = screen.getByRole('button', { name: 'Custom Label' });
      expect(button).toBeInTheDocument();
    });

    it('should handle keyboard interactions', () => {
      const handleClick = vi.fn();
      render(<Button onClick={handleClick}>Keyboard Button</Button>);

      const button = screen.getByRole('button');
      button.focus();
      expect(document.activeElement).toBe(button);

      // Space key
      fireEvent.keyDown(button, { key: ' ' });
      fireEvent.keyUp(button, { key: ' ' });

      // Enter key
      fireEvent.keyDown(button, { key: 'Enter' });

      // Click should be triggered by keyboard
      fireEvent.click(button);
      expect(handleClick).toHaveBeenCalled();
    });
  });

  describe('Edge Cases', () => {
    it('should handle loading and disabled simultaneously', () => {
      render(<Button loading disabled>Both States</Button>);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('data-loading', 'true');
      expect(button).toHaveAttribute('data-disabled', 'true');
    });

    it('should handle empty children with iconOnly', () => {
      render(<Button iconOnly />);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('data-icon-only', 'true');
    });
  });
});

describe('ButtonGroup Component', () => {
  it('should render children', () => {
    render(
      <ButtonGroup>
        <Button>First</Button>
        <Button>Second</Button>
        <Button>Third</Button>
      </ButtonGroup>
    );

    const group = screen.getByRole('group');
    expect(group).toBeInTheDocument();
    expect(group).toHaveClass('semiont-button-group');

    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText('Third')).toBeInTheDocument();
  });

  it('should handle horizontal orientation', () => {
    render(
      <ButtonGroup orientation="horizontal">
        <Button>Button</Button>
      </ButtonGroup>
    );

    const group = screen.getByRole('group');
    expect(group).toHaveAttribute('data-orientation', 'horizontal');
  });

  it('should handle vertical orientation', () => {
    render(
      <ButtonGroup orientation="vertical">
        <Button>Button</Button>
      </ButtonGroup>
    );

    const group = screen.getByRole('group');
    expect(group).toHaveAttribute('data-orientation', 'vertical');
  });

  it('should handle attached buttons', () => {
    render(
      <ButtonGroup attached>
        <Button>Button</Button>
      </ButtonGroup>
    );

    const group = screen.getByRole('group');
    expect(group).toHaveAttribute('data-attached', 'true');
    expect(group).not.toHaveAttribute('data-spacing');
  });

  it('should handle spacing when not attached', () => {
    const spacings = ['xs', 'sm', 'md', 'lg'] as const;

    spacings.forEach(spacing => {
      const { container } = render(
        <ButtonGroup spacing={spacing} attached={false}>
          <Button>Button</Button>
        </ButtonGroup>
      );

      const group = container.querySelector('[role="group"]');
      expect(group).toHaveAttribute('data-spacing', spacing);
      expect(group).not.toHaveAttribute('data-attached');
    });
  });

  it('should apply custom className', () => {
    render(
      <ButtonGroup className="custom-group">
        <Button>Button</Button>
      </ButtonGroup>
    );

    const group = screen.getByRole('group');
    expect(group).toHaveClass('semiont-button-group', 'custom-group');
  });

  it('should use default values', () => {
    render(
      <ButtonGroup>
        <Button>Button</Button>
      </ButtonGroup>
    );

    const group = screen.getByRole('group');
    expect(group).toHaveAttribute('data-orientation', 'horizontal');
    expect(group).toHaveAttribute('data-spacing', 'sm');
    expect(group).not.toHaveAttribute('data-attached');
  });
});