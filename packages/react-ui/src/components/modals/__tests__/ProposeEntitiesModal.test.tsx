import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils';
import '@testing-library/jest-dom';
import { ProposeEntitiesModal } from '../ProposeEntitiesModal';

// Mock HeadlessUI to avoid jsdom OOM issues
vi.mock('@headlessui/react', () => ({
  Dialog: ({ children, onClose, ...props }: any) => <div role="dialog" {...props}>{typeof children === 'function' ? children({ open: true }) : children}</div>,
  DialogPanel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
  DialogDescription: ({ children, ...props }: any) => <p {...props}>{children}</p>,
  Transition: ({ show, children }: any) => show ? <>{children}</> : null,
  TransitionChild: ({ children }: any) => <>{children}</>,
}));

// Stable entity types array to avoid infinite re-render loops
const mockEntityTypes = ['Person', 'Organization', 'Location'];
const stableQueryResult = { data: { entityTypes: mockEntityTypes } };

vi.mock('../../../lib/api-hooks', () => ({
  useEntityTypes: vi.fn(() => ({
    list: {
      useQuery: () => stableQueryResult,
    },
  })),
}));

describe('ProposeEntitiesModal', () => {
  const defaultProps = {
    isOpen: true,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('renders modal title when open', () => {
    renderWithProviders(<ProposeEntitiesModal {...defaultProps} />);
    expect(screen.getByText('Detect Entity References')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    renderWithProviders(
      <ProposeEntitiesModal {...defaultProps} isOpen={false} />
    );
    expect(screen.queryByText('Detect Entity References')).not.toBeInTheDocument();
  });

  it('renders available entity type buttons', () => {
    renderWithProviders(<ProposeEntitiesModal {...defaultProps} />);
    expect(screen.getByText('Person')).toBeInTheDocument();
    expect(screen.getByText('Organization')).toBeInTheDocument();
    expect(screen.getByText('Location')).toBeInTheDocument();
  });

  it('toggles entity type selection on click', () => {
    renderWithProviders(<ProposeEntitiesModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Person'));
    expect(screen.getByText('1 type selected')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Organization'));
    expect(screen.getByText('2 types selected')).toBeInTheDocument();

    // Deselect
    fireEvent.click(screen.getByText('Person'));
    expect(screen.getByText('1 type selected')).toBeInTheDocument();
  });

  it('disables confirm button when no types selected', () => {
    renderWithProviders(<ProposeEntitiesModal {...defaultProps} />);
    const buttons = screen.getAllByRole('button');
    const confirmButton = buttons.find(b => b.textContent?.includes('Detect Entity'));
    expect(confirmButton).toBeDisabled();
  });

  it('enables confirm button when types are selected', () => {
    renderWithProviders(<ProposeEntitiesModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Person'));

    const buttons = screen.getAllByRole('button');
    const confirmButton = buttons.find(b => b.textContent?.includes('Detect Entity'));
    expect(confirmButton).not.toBeDisabled();
  });

  it('calls onConfirm with selected types', () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <ProposeEntitiesModal {...defaultProps} onConfirm={onConfirm} />
    );

    fireEvent.click(screen.getByText('Person'));
    fireEvent.click(screen.getByText('Location'));

    const buttons = screen.getAllByRole('button');
    const confirmButton = buttons.find(b => b.textContent?.includes('Detect Entity'));
    fireEvent.click(confirmButton!);

    expect(onConfirm).toHaveBeenCalledWith(['Person', 'Location']);
  });

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <ProposeEntitiesModal {...defaultProps} onCancel={onCancel} />
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('saves preferences to sessionStorage on confirm', () => {
    renderWithProviders(<ProposeEntitiesModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Person'));

    const buttons = screen.getAllByRole('button');
    const confirmButton = buttons.find(b => b.textContent?.includes('Detect Entity'));
    fireEvent.click(confirmButton!);

    expect(sessionStorage.getItem('userPreferredEntityTypes')).toBe(
      JSON.stringify(['Person'])
    );
  });
});
