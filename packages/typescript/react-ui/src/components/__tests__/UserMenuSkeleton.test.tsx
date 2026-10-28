import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { UserMenuSkeleton } from '../UserMenuSkeleton';

describe('UserMenuSkeleton', () => {
  describe('Rendering', () => {
    it('should render without crashing', () => {
      const { container } = render(<UserMenuSkeleton />);
      expect(container.firstChild).toBeInTheDocument();
    });

    it('should have correct class name', () => {
      const { container } = render(<UserMenuSkeleton />);
      const skeleton = container.querySelector('.semiont-user-menu-skeleton');
      expect(skeleton).toBeInTheDocument();
    });

    it('should render screen reader text', () => {
      render(<UserMenuSkeleton />);
      expect(screen.getByText('Loading user menu...')).toBeInTheDocument();
    });

    it('should have screen reader text with sr-only class', () => {
      const { container } = render(<UserMenuSkeleton />);
      const srText = container.querySelector('.semiont-sr-only');
      expect(srText).toBeInTheDocument();
      expect(srText).toHaveTextContent('Loading user menu...');
    });
  });

  describe('Accessibility', () => {
    it('should have role="status"', () => {
      const { container } = render(<UserMenuSkeleton />);
      const skeleton = container.querySelector('[role="status"]');
      expect(skeleton).toBeInTheDocument();
    });

    it('should have aria-label', () => {
      const { container } = render(<UserMenuSkeleton />);
      const skeleton = container.querySelector('[aria-label="Loading user menu"]');
      expect(skeleton).toBeInTheDocument();
    });

    it('should have both role and aria-label on same element', () => {
      const { container } = render(<UserMenuSkeleton />);
      const skeleton = container.querySelector('.semiont-user-menu-skeleton');
      expect(skeleton).toHaveAttribute('role', 'status');
      expect(skeleton).toHaveAttribute('aria-label', 'Loading user menu');
    });

    it('should pass automated accessibility tests', async () => {
      const { container } = render(<UserMenuSkeleton />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    it('should be announced to screen readers', () => {
      const { container } = render(<UserMenuSkeleton />);
      const skeleton = container.querySelector('[role="status"]');

      // role="status" has implicit aria-live="polite" and aria-atomic="true"
      // which means screen readers will announce changes
      expect(skeleton).toBeInTheDocument();
    });
  });

  describe('Structure', () => {
    it('should have a single root element', () => {
      const { container } = render(<UserMenuSkeleton />);
      expect(container.children).toHaveLength(1);
    });

    it('should contain a span with sr-only class', () => {
      const { container } = render(<UserMenuSkeleton />);
      const span = container.querySelector('span.semiont-sr-only');
      expect(span).toBeInTheDocument();
    });

    it('should nest sr-only span inside skeleton div', () => {
      const { container } = render(<UserMenuSkeleton />);
      const skeleton = container.querySelector('.semiont-user-menu-skeleton');
      const srText = skeleton?.querySelector('.semiont-sr-only');
      expect(srText).toBeInTheDocument();
    });
  });

  describe('Multiple Instances', () => {
    it('should render multiple skeletons independently', () => {
      const { container } = render(
        <div>
          <UserMenuSkeleton />
          <UserMenuSkeleton />
          <UserMenuSkeleton />
        </div>
      );

      const skeletons = container.querySelectorAll('.semiont-user-menu-skeleton');
      expect(skeletons).toHaveLength(3);
    });

    it('should have unique content for each skeleton', () => {
      const { container } = render(
        <div>
          <UserMenuSkeleton />
          <UserMenuSkeleton />
        </div>
      );

      const srTexts = container.querySelectorAll('.semiont-sr-only');
      expect(srTexts).toHaveLength(2);
      srTexts.forEach(text => {
        expect(text).toHaveTextContent('Loading user menu...');
      });
    });
  });

  describe('Integration', () => {
    it('should work within a layout', () => {
      const { container } = render(
        <header>
          <nav>
            <UserMenuSkeleton />
          </nav>
        </header>
      );

      expect(container.querySelector('.semiont-user-menu-skeleton')).toBeInTheDocument();
    });

    it('should work alongside other elements', () => {
      const { container } = render(
        <div>
          <span>Before</span>
          <UserMenuSkeleton />
          <span>After</span>
        </div>
      );

      expect(screen.getByText('Before')).toBeInTheDocument();
      expect(container.querySelector('.semiont-user-menu-skeleton')).toBeInTheDocument();
      expect(screen.getByText('After')).toBeInTheDocument();
    });
  });

  describe('No Props', () => {
    it('should not accept any props', () => {
      // UserMenuSkeleton has no props interface
      // This test ensures it renders correctly with no props
      const { container } = render(<UserMenuSkeleton />);
      expect(container.querySelector('.semiont-user-menu-skeleton')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should render consistently', () => {
      const { container: container1 } = render(<UserMenuSkeleton />);
      const { container: container2 } = render(<UserMenuSkeleton />);

      expect(container1.innerHTML).toBe(container2.innerHTML);
    });

    it('should be stable on re-render', () => {
      const { container, rerender } = render(<UserMenuSkeleton />);
      const initialHTML = container.innerHTML;

      rerender(<UserMenuSkeleton />);

      expect(container.innerHTML).toBe(initialHTML);
    });
  });
});
