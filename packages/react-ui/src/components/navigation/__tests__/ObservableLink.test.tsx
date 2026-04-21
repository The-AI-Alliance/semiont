import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../../test-utils';
import { ObservableLink } from '../ObservableLink';

describe('ObservableLink', () => {
  it('renders anchor with href', () => {
    renderWithProviders(
      <ObservableLink href="/discover">Discover</ObservableLink>
    );

    const link = screen.getByRole('link', { name: 'Discover' });
    expect(link).toHaveAttribute('href', '/discover');
  });

  it('renders children', () => {
    renderWithProviders(
      <ObservableLink href="/test">
        <span data-testid="child">Click me</span>
      </ObservableLink>
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  it('emits nav:link-clicked with href and label on click', () => {
    const handler = vi.fn();

    const { shellBus } = renderWithProviders(
      <ObservableLink href="/discover" label="Discover">
        Discover Resources
      </ObservableLink>,
      { returnShellBus: true }
    );

    const subscription = shellBus!.get('nav:link-clicked').subscribe(handler);

    const link = screen.getByRole('link');
    fireEvent.click(link);

    expect(handler).toHaveBeenCalledWith({
      href: '/discover',
      label: 'Discover',
    });

    subscription.unsubscribe();
  });

  it('calls original onClick handler if provided', () => {
    const onClick = vi.fn();

    renderWithProviders(
      <ObservableLink href="/test" onClick={onClick}>
        Click
      </ObservableLink>
    );

    const link = screen.getByRole('link');
    fireEvent.click(link);

    expect(onClick).toHaveBeenCalled();
  });

  it('passes through additional anchor props', () => {
    renderWithProviders(
      <ObservableLink
        href="/external"
        className="custom-link"
        target="_blank"
        rel="noopener noreferrer"
        data-testid="my-link"
      >
        External
      </ObservableLink>
    );

    const link = screen.getByTestId('my-link');
    expect(link).toHaveClass('custom-link');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('href', '/external');
  });
});
