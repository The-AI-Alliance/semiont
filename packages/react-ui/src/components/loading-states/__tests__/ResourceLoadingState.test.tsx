/**
 * Tests for ResourceLoadingState component
 *
 * Simple tests for a simple component. No mocking required.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResourceLoadingState } from '../ResourceLoadingState';

describe('ResourceLoadingState', () => {
  it('renders loading message', () => {
    render(<ResourceLoadingState />);

    expect(screen.getByText('Loading resource...')).toBeInTheDocument();
  });

  it('renders with correct styling', () => {
    render(<ResourceLoadingState />);

    const container = screen.getByText('Loading resource...').parentElement;
    expect(container).toHaveClass('flex', 'items-center', 'justify-center', 'py-20');
  });

  it('renders text with correct styling', () => {
    render(<ResourceLoadingState />);

    const text = screen.getByText('Loading resource...');
    expect(text).toHaveClass('text-gray-600', 'dark:text-gray-300');
  });
});
