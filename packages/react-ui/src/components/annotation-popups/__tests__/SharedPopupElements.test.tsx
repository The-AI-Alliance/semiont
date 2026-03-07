import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../../test-utils';
import {
  SelectedTextDisplay,
  EntityTypeBadges,
  PopupHeader,
  PopupContainer,
} from '../SharedPopupElements';

// Mock HeadlessUI to avoid jsdom OOM issues
vi.mock('@headlessui/react', () => ({
  Dialog: ({ children, onClose, ...props }: any) => (
    <div role="dialog" {...props}>
      {typeof children === 'function' ? children({ open: true }) : children}
    </div>
  ),
  DialogPanel: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  Transition: ({ show, children }: any) => (show ? <>{children}</> : null),
  TransitionChild: ({ children }: any) => <>{children}</>,
}));

describe('SelectedTextDisplay', () => {
  it('should render the selected text with quotes', () => {
    renderWithProviders(<SelectedTextDisplay exact="hello world" />);

    expect(screen.getByText(/"hello world"/)).toBeInTheDocument();
  });

  it('should render the label', () => {
    renderWithProviders(<SelectedTextDisplay exact="test" />);

    expect(screen.getByText('Selected text:')).toBeInTheDocument();
  });

  it('should have proper container class', () => {
    const { container } = renderWithProviders(<SelectedTextDisplay exact="test" />);

    expect(container.querySelector('.semiont-selected-text-display')).toBeInTheDocument();
  });

  it('should have proper label class', () => {
    const { container } = renderWithProviders(<SelectedTextDisplay exact="test" />);

    expect(container.querySelector('.semiont-selected-text-display__label')).toBeInTheDocument();
  });

  it('should have proper content class', () => {
    const { container } = renderWithProviders(<SelectedTextDisplay exact="test" />);

    expect(container.querySelector('.semiont-selected-text-display__content')).toBeInTheDocument();
  });

  it('should handle empty string', () => {
    renderWithProviders(<SelectedTextDisplay exact="" />);

    expect(screen.getByText('Selected text:')).toBeInTheDocument();
  });

  it('should handle special characters in text', () => {
    renderWithProviders(<SelectedTextDisplay exact="<script>alert('xss')</script>" />);

    expect(screen.getByText('Selected text:')).toBeInTheDocument();
  });
});

describe('EntityTypeBadges', () => {
  it('should render a single entity type badge', () => {
    renderWithProviders(<EntityTypeBadges entityTypes="Person" />);

    expect(screen.getByText('Person')).toBeInTheDocument();
  });

  it('should render multiple comma-separated entity types as badges', () => {
    renderWithProviders(<EntityTypeBadges entityTypes="Person,Organization,Place" />);

    expect(screen.getByText('Person')).toBeInTheDocument();
    expect(screen.getByText('Organization')).toBeInTheDocument();
    expect(screen.getByText('Place')).toBeInTheDocument();
  });

  it('should trim whitespace from entity types', () => {
    renderWithProviders(<EntityTypeBadges entityTypes="Person , Organization , Place" />);

    expect(screen.getByText('Person')).toBeInTheDocument();
    expect(screen.getByText('Organization')).toBeInTheDocument();
    expect(screen.getByText('Place')).toBeInTheDocument();
  });

  it('should return null for empty string', () => {
    const { container } = renderWithProviders(<EntityTypeBadges entityTypes="" />);

    expect(container.querySelector('.semiont-entity-type-badges')).not.toBeInTheDocument();
  });

  it('should have proper container class', () => {
    const { container } = renderWithProviders(<EntityTypeBadges entityTypes="Person" />);

    expect(container.querySelector('.semiont-entity-type-badges')).toBeInTheDocument();
  });

  it('should have proper badge class on each badge', () => {
    const { container } = renderWithProviders(
      <EntityTypeBadges entityTypes="Person,Organization" />
    );

    const badges = container.querySelectorAll('.semiont-entity-type-badges__badge');
    expect(badges).toHaveLength(2);
  });
});

describe('PopupHeader', () => {
  it('should render the title', () => {
    renderWithProviders(
      <PopupHeader title="Annotation Details" onClose={vi.fn()} />
    );

    expect(screen.getByText('Annotation Details')).toBeInTheDocument();
  });

  it('should render selected text when provided', () => {
    renderWithProviders(
      <PopupHeader title="Details" selectedText="highlighted text" onClose={vi.fn()} />
    );

    expect(screen.getByText(/highlighted text/)).toBeInTheDocument();
  });

  it('should not render selected text subtitle when not provided', () => {
    const { container } = renderWithProviders(
      <PopupHeader title="Details" onClose={vi.fn()} />
    );

    expect(container.querySelector('.semiont-popup-header__subtitle')).not.toBeInTheDocument();
  });

  it('should render close button', () => {
    renderWithProviders(
      <PopupHeader title="Details" onClose={vi.fn()} />
    );

    const closeButton = screen.getByRole('button');
    expect(closeButton).toBeInTheDocument();
  });

  it('should call onClose when close button is clicked', () => {
    const onClose = vi.fn();
    renderWithProviders(<PopupHeader title="Details" onClose={onClose} />);

    const closeButton = screen.getByRole('button');
    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should have proper header class', () => {
    const { container } = renderWithProviders(
      <PopupHeader title="Details" onClose={vi.fn()} />
    );

    expect(container.querySelector('.semiont-popup-header')).toBeInTheDocument();
  });

  it('should have proper title class', () => {
    const { container } = renderWithProviders(
      <PopupHeader title="Details" onClose={vi.fn()} />
    );

    expect(container.querySelector('.semiont-popup-header__title')).toBeInTheDocument();
  });

  it('should have proper close button class', () => {
    const { container } = renderWithProviders(
      <PopupHeader title="Details" onClose={vi.fn()} />
    );

    expect(container.querySelector('.semiont-popup-header__close-button')).toBeInTheDocument();
  });
});

describe('PopupContainer', () => {
  const defaultProps = {
    position: { x: 100, y: 200 },
    onClose: vi.fn(),
    isOpen: true,
  };

  it('should render children when open', () => {
    renderWithProviders(
      <PopupContainer {...defaultProps}>
        <div>Popup content</div>
      </PopupContainer>
    );

    expect(screen.getByText('Popup content')).toBeInTheDocument();
  });

  it('should not render children when closed', () => {
    renderWithProviders(
      <PopupContainer {...defaultProps} isOpen={false}>
        <div>Popup content</div>
      </PopupContainer>
    );

    expect(screen.queryByText('Popup content')).not.toBeInTheDocument();
  });

  it('should render with dialog role', () => {
    renderWithProviders(
      <PopupContainer {...defaultProps}>
        <div>Content</div>
      </PopupContainer>
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('should render backdrop element', () => {
    const { container } = renderWithProviders(
      <PopupContainer {...defaultProps}>
        <div>Content</div>
      </PopupContainer>
    );

    expect(container.querySelector('.semiont-popup-backdrop')).toBeInTheDocument();
  });

  it('should set data-wide to false by default', () => {
    const { container } = renderWithProviders(
      <PopupContainer {...defaultProps}>
        <div>Content</div>
      </PopupContainer>
    );

    const panel = container.querySelector('.semiont-popup-panel');
    expect(panel).toHaveAttribute('data-wide', 'false');
  });

  it('should set data-wide to true when wide prop is true', () => {
    const { container } = renderWithProviders(
      <PopupContainer {...defaultProps} wide>
        <div>Content</div>
      </PopupContainer>
    );

    const panel = container.querySelector('.semiont-popup-panel');
    expect(panel).toHaveAttribute('data-wide', 'true');
  });

  it('should have data-annotation-ui attribute', () => {
    const { container } = renderWithProviders(
      <PopupContainer {...defaultProps}>
        <div>Content</div>
      </PopupContainer>
    );

    const panel = container.querySelector('[data-annotation-ui]');
    expect(panel).toBeInTheDocument();
  });

  it('should position popup with fixed positioning', () => {
    const { container } = renderWithProviders(
      <PopupContainer {...defaultProps}>
        <div>Content</div>
      </PopupContainer>
    );

    const panel = container.querySelector('.semiont-popup-panel') as HTMLElement;
    expect(panel?.style.position).toBe('fixed');
  });
});
