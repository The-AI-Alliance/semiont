import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders, resetEventBusForTesting } from '../../test-utils';
import { AnnotateReferencesProgressWidget } from '../AnnotateReferencesProgressWidget';
import type { MarkProgress } from '@semiont/core';

describe('AnnotateReferencesProgressWidget', () => {
  beforeEach(() => {
    resetEventBusForTesting();
  });

  it('returns null when progress is null', () => {
    const { container } = renderWithProviders(
      <AnnotateReferencesProgressWidget progress={null} />
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders progress with status message', () => {
    const progress: MarkProgress = {
      status: 'in-progress',
      message: 'Processing entities...',
    };

    renderWithProviders(
      <AnnotateReferencesProgressWidget progress={progress} />
    );

    expect(screen.getByText('Processing entities...')).toBeInTheDocument();
  });

  it('shows cancel button when not complete', () => {
    const progress: MarkProgress = {
      status: 'in-progress',
      message: 'Working...',
    };

    renderWithProviders(
      <AnnotateReferencesProgressWidget progress={progress} />
    );

    const cancelButton = screen.getByTitle('ReferencesPanel.cancelAnnotation');
    expect(cancelButton).toBeInTheDocument();
  });

  it('hides cancel button when complete', () => {
    const progress: MarkProgress = {
      status: 'complete',
    };

    renderWithProviders(
      <AnnotateReferencesProgressWidget progress={progress} />
    );

    expect(screen.queryByTitle('ReferencesPanel.cancelAnnotation')).not.toBeInTheDocument();
  });

  it('emits job:cancel-requested on cancel click', () => {
    const handler = vi.fn();
    const progress: MarkProgress = {
      status: 'in-progress',
      message: 'Working...',
    };

    const { eventBus } = renderWithProviders(
      <AnnotateReferencesProgressWidget progress={progress} />,
      { returnEventBus: true }
    );

    const subscription = eventBus!.get('job:cancel-requested').subscribe(handler);

    const cancelButton = screen.getByTitle('ReferencesPanel.cancelAnnotation');
    fireEvent.click(cancelButton);

    expect(handler).toHaveBeenCalledWith({ jobType: 'annotation' });

    subscription.unsubscribe();
  });

  it('renders completed entity types', () => {
    const progress: MarkProgress = {
      status: 'in-progress',
      completedEntityTypes: [
        { entityType: 'Person', foundCount: 5 },
        { entityType: 'Organization', foundCount: 3 },
      ],
    };

    renderWithProviders(
      <AnnotateReferencesProgressWidget progress={progress} />
    );

    expect(screen.getByText('Person:')).toBeInTheDocument();
    expect(screen.getByText('Organization:')).toBeInTheDocument();
    // Translation mock returns "ReferencesPanel.found" for each entity type
    const foundLabels = screen.getAllByText('ReferencesPanel.found');
    expect(foundLabels).toHaveLength(2);
  });

  it('shows complete icon for complete status', () => {
    const progress: MarkProgress = {
      status: 'complete',
    };

    const { container } = renderWithProviders(
      <AnnotateReferencesProgressWidget progress={progress} />
    );

    expect(container.querySelector('[data-status="complete"]')).toBeInTheDocument();
    expect(screen.getByText('ReferencesPanel.complete')).toBeInTheDocument();
  });

  it('shows error message for error status', () => {
    const progress: MarkProgress = {
      status: 'error',
      message: 'Something went wrong',
    };

    const { container } = renderWithProviders(
      <AnnotateReferencesProgressWidget progress={progress} />
    );

    expect(container.querySelector('[data-status="error"]')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('shows current entity type processing details', () => {
    const progress: MarkProgress = {
      status: 'in-progress',
      currentEntityType: 'Location',
    };

    renderWithProviders(
      <AnnotateReferencesProgressWidget progress={progress} />
    );

    expect(screen.getByText(/Processing: Location/)).toBeInTheDocument();
  });
});
