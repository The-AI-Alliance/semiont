/**
 * Tests for ResourceErrorState component
 *
 * Simple tests for error display. No mocking required.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResourceErrorState } from '../ResourceErrorState';

describe('ResourceErrorState', () => {
  describe('Error Display', () => {
    it('displays error message from Error object', () => {
      const error = new Error('Failed to load resource');
      const onRetry = vi.fn();

      render(<ResourceErrorState error={error} onRetry={onRetry} />);

      expect(screen.getByText('Failed to load resource')).toBeInTheDocument();
    });

    it('displays generic message for non-Error objects', () => {
      const error = 'Something went wrong';
      const onRetry = vi.fn();

      render(<ResourceErrorState error={error} onRetry={onRetry} />);

      expect(screen.getByText('Failed to load resource')).toBeInTheDocument();
    });

    it('displays generic message for null error', () => {
      const onRetry = vi.fn();

      render(<ResourceErrorState error={null} onRetry={onRetry} />);

      expect(screen.getByText('Failed to load resource')).toBeInTheDocument();
    });
  });

  describe('Retry Button', () => {
    it('renders retry button', () => {
      const error = new Error('Network error');
      const onRetry = vi.fn();

      render(<ResourceErrorState error={error} onRetry={onRetry} />);

      const button = screen.getByRole('button', { name: 'Try Again' });
      expect(button).toBeInTheDocument();
    });

    it('calls onRetry when button clicked', () => {
      const error = new Error('Network error');
      const onRetry = vi.fn();

      render(<ResourceErrorState error={error} onRetry={onRetry} />);

      const button = screen.getByRole('button', { name: 'Try Again' });
      fireEvent.click(button);

      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('can be clicked multiple times', () => {
      const error = new Error('Network error');
      const onRetry = vi.fn();

      render(<ResourceErrorState error={error} onRetry={onRetry} />);

      const button = screen.getByRole('button', { name: 'Try Again' });
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);

      expect(onRetry).toHaveBeenCalledTimes(3);
    });
  });

  describe('Styling', () => {
    it('renders error message with correct styling', () => {
      const error = new Error('Test error');
      const onRetry = vi.fn();

      render(<ResourceErrorState error={error} onRetry={onRetry} />);

      const errorText = screen.getByText('Test error');
      expect(errorText).toHaveClass('text-red-600', 'dark:text-red-400');
    });

    it('renders container with correct layout', () => {
      const error = new Error('Test error');
      const onRetry = vi.fn();

      render(<ResourceErrorState error={error} onRetry={onRetry} />);

      const container = screen.getByText('Test error').parentElement;
      expect(container).toHaveClass('flex', 'flex-col', 'items-center', 'justify-center', 'py-20', 'space-y-4');
    });
  });
});
