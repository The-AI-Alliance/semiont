/**
 * Tests for ComposeLoadingState component
 *
 * Simple tests for a simple component. No mocking required.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ComposeLoadingState } from '../ComposeLoadingState';

describe('ComposeLoadingState', () => {
  it('renders loading message', () => {
    render(<ComposeLoadingState message="Loading..." />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders custom message', () => {
    render(<ComposeLoadingState message="Checking authentication..." />);

    expect(screen.getByText('Checking authentication...')).toBeInTheDocument();
  });

  it('renders with correct styling', () => {
    render(<ComposeLoadingState message="Loading..." />);

    const container = screen.getByText('Loading...').parentElement;
    expect(container).toHaveClass('flex', 'items-center', 'justify-center', 'py-20');
  });

  it('renders text with correct styling', () => {
    render(<ComposeLoadingState message="Loading..." />);

    const text = screen.getByText('Loading...');
    expect(text).toHaveClass('text-gray-600', 'dark:text-gray-300');
  });
});
