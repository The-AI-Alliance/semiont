import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../test-utils';
import { AnnotateReferencesProgressWidget } from '../AnnotateReferencesProgressWidget';
import type { components } from '@semiont/core';

type JobProgress = components['schemas']['JobProgress'];

describe('AnnotateReferencesProgressWidget', () => {
  it('returns null when progress is null', () => {
    const { container } = renderWithProviders(
      <AnnotateReferencesProgressWidget progress={null} />
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders progress with stage message', () => {
    const progress: JobProgress = {
      stage: 'in-progress',
      percentage: 50,
      message: 'Processing entities...',
    };

    renderWithProviders(
      <AnnotateReferencesProgressWidget progress={progress} />
    );

    expect(screen.getByText('Processing entities...')).toBeInTheDocument();
  });

  it('shows cancel button when not complete', () => {
    const progress: JobProgress = {
      stage: 'in-progress',
      percentage: 30,
      message: 'Working...',
    };

    renderWithProviders(
      <AnnotateReferencesProgressWidget progress={progress} />
    );

    const cancelButton = screen.getByTitle('ReferencesPanel.cancelAnnotation');
    expect(cancelButton).toBeInTheDocument();
  });

  it('hides cancel button when complete', () => {
    const progress: JobProgress = {
      stage: 'complete',
      percentage: 100,
      message: '',
    };

    renderWithProviders(
      <AnnotateReferencesProgressWidget progress={progress} />
    );

    expect(screen.queryByTitle('ReferencesPanel.cancelAnnotation')).not.toBeInTheDocument();
  });

  it('emits job:cancel-requested on cancel click', () => {
    const handler = vi.fn();
    const progress: JobProgress = {
      stage: 'in-progress',
      percentage: 40,
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
    const progress: JobProgress = {
      stage: 'in-progress',
      percentage: 60,
      message: '',
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

  it('shows complete icon for complete stage', () => {
    const progress: JobProgress = {
      stage: 'complete',
      percentage: 100,
      message: '',
    };

    const { container } = renderWithProviders(
      <AnnotateReferencesProgressWidget progress={progress} />
    );

    expect(container.querySelector('[data-status="complete"]')).toBeInTheDocument();
    expect(screen.getByText('ReferencesPanel.complete')).toBeInTheDocument();
  });

  it('shows error message for error stage', () => {
    const progress: JobProgress = {
      stage: 'error',
      percentage: 0,
      message: 'Something went wrong',
    };

    const { container } = renderWithProviders(
      <AnnotateReferencesProgressWidget progress={progress} />
    );

    expect(container.querySelector('[data-status="error"]')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('shows current entity type processing details', () => {
    const progress: JobProgress = {
      stage: 'in-progress',
      percentage: 50,
      message: '',
      currentEntityType: 'Location',
    };

    renderWithProviders(
      <AnnotateReferencesProgressWidget progress={progress} />
    );

    expect(screen.getByText(/Processing: Location/)).toBeInTheDocument();
  });
});
