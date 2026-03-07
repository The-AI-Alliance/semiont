import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils';
import '@testing-library/jest-dom';
import { KeyboardShortcutsHelpModal } from '../KeyboardShortcutsHelpModal';

// Mock HeadlessUI to avoid jsdom OOM issues
vi.mock('@headlessui/react', () => ({
  Dialog: ({ children, onClose, ...props }: any) => <div role="dialog" {...props}>{typeof children === 'function' ? children({ open: true }) : children}</div>,
  DialogPanel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children, ...props }: any) => <h2 {...props}>{children}</h2>,
  Transition: ({ show, children }: any) => show ? <>{children}</> : null,
  TransitionChild: ({ children }: any) => <>{children}</>,
}));

describe('KeyboardShortcutsHelpModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
  };

  it('renders modal title when open', () => {
    renderWithProviders(<KeyboardShortcutsHelpModal {...defaultProps} />);
    expect(screen.getByText('KeyboardShortcuts.title')).toBeInTheDocument();
  });

  it('does not render content when closed', () => {
    renderWithProviders(
      <KeyboardShortcutsHelpModal {...defaultProps} isOpen={false} />
    );
    expect(screen.queryByText('KeyboardShortcuts.title')).not.toBeInTheDocument();
  });

  it('renders all shortcut groups', () => {
    renderWithProviders(<KeyboardShortcutsHelpModal {...defaultProps} />);
    expect(screen.getByText('KeyboardShortcuts.navigationTitle')).toBeInTheDocument();
    expect(screen.getByText('KeyboardShortcuts.sidebarTitle')).toBeInTheDocument();
    expect(screen.getByText('KeyboardShortcuts.annotationsTitle')).toBeInTheDocument();
    expect(screen.getByText('KeyboardShortcuts.listsTitle')).toBeInTheDocument();
    expect(screen.getByText('KeyboardShortcuts.searchModalTitle')).toBeInTheDocument();
    expect(screen.getByText('KeyboardShortcuts.modalTitle')).toBeInTheDocument();
    expect(screen.getByText('KeyboardShortcuts.accessibilityTitle')).toBeInTheDocument();
  });

  it('renders keyboard shortcut descriptions', () => {
    renderWithProviders(<KeyboardShortcutsHelpModal {...defaultProps} />);
    expect(screen.getByText('KeyboardShortcuts.navOpenSearch')).toBeInTheDocument();
    expect(screen.getByText('KeyboardShortcuts.annotHighlight')).toBeInTheDocument();
  });

  it('renders kbd elements for shortcuts', () => {
    renderWithProviders(<KeyboardShortcutsHelpModal {...defaultProps} />);
    const kbdElements = document.querySelectorAll('kbd.semiont-shortcuts__key');
    expect(kbdElements.length).toBeGreaterThan(0);
  });

  it('renders close button with aria-label', () => {
    renderWithProviders(<KeyboardShortcutsHelpModal {...defaultProps} />);
    expect(screen.getByLabelText('KeyboardShortcuts.closeDialog')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <KeyboardShortcutsHelpModal isOpen={true} onClose={onClose} />
    );
    fireEvent.click(screen.getByLabelText('KeyboardShortcuts.closeDialog'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders footer close button', () => {
    renderWithProviders(<KeyboardShortcutsHelpModal {...defaultProps} />);
    expect(screen.getByText('KeyboardShortcuts.close')).toBeInTheDocument();
  });

  it('calls onClose when footer close button is clicked', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <KeyboardShortcutsHelpModal isOpen={true} onClose={onClose} />
    );
    fireEvent.click(screen.getByText('KeyboardShortcuts.close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders platform note for non-Mac', () => {
    renderWithProviders(<KeyboardShortcutsHelpModal {...defaultProps} />);
    expect(screen.getByText('KeyboardShortcuts.windowsNote')).toBeInTheDocument();
  });
});
