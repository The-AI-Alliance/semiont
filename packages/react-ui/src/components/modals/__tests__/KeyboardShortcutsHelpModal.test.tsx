import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderInEnglish, renderWithProviders } from '../../../test-utils';
import '@testing-library/jest-dom';
import { KeyboardShortcutsHelpModal } from '../KeyboardShortcutsHelpModal';

// HeadlessUI's dialog as plain elements: this suite is about what is rendered inside it
vi.mock('@headlessui/react', () => import('../../../__tests__/plain-headlessui'));

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
    expect(screen.getByText('KeyboardShortcuts.listsTitle')).toBeInTheDocument();
    expect(screen.getByText('KeyboardShortcuts.searchModalTitle')).toBeInTheDocument();
    expect(screen.getByText('KeyboardShortcuts.modalTitle')).toBeInTheDocument();
    expect(screen.getByText('KeyboardShortcuts.accessibilityTitle')).toBeInTheDocument();
  });

  it('renders keyboard shortcut descriptions', () => {
    renderWithProviders(<KeyboardShortcutsHelpModal {...defaultProps} />);
    expect(screen.getByText('KeyboardShortcuts.navOpenSearch')).toBeInTheDocument();
    expect(screen.getByText('KeyboardShortcuts.navCreateResource')).toBeInTheDocument();
  });

  it('describes the one skip link a page has', () => {
    renderInEnglish(<KeyboardShortcutsHelpModal {...defaultProps} />);
    expect(screen.getByText('Navigate to the skip link (when at page start)')).toBeInTheDocument();
    expect(screen.getByText('Follow skip link')).toBeInTheDocument();
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
