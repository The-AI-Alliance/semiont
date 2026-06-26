import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../test-utils';
import { AnnotateReferencesProgressWidget } from '../AnnotateReferencesProgressWidget';
import type { components } from '@semiont/core';

type JobProgress = components['schemas']['JobProgress'];

// The widget no longer reads translations internally — the caller supplies the
// copy + cancel job type. These are the annotation-flow values for these tests.
const tr = {
  title: 'Annotating',
  cancel: 'Cancel',
  inProgress: 'In progress',
  complete: 'Complete',
  failed: 'Failed',
  found: (count: number) => `Found ${count}`,
  current: (entityType: string) => `Current ${entityType}`,
};

function renderWidget(progress: JobProgress | null, opts?: { returnEventBus?: boolean }) {
  return renderWithProviders(
    <AnnotateReferencesProgressWidget progress={progress} cancelJobType="annotation" translations={tr} />,
    opts,
  );
}

describe('AnnotateReferencesProgressWidget', () => {
  it('returns null when progress is null', () => {
    const { container } = renderWidget(null);
    expect(container.firstChild).toBeNull();
  });

  it('renders progress with stage message', () => {
    const progress: JobProgress = { stage: 'in-progress', percentage: 50, message: 'Processing entities...' };
    renderWidget(progress);
    expect(screen.getByText('Processing entities...')).toBeInTheDocument();
  });

  it('shows cancel button when not complete', () => {
    const progress: JobProgress = { stage: 'in-progress', percentage: 30, message: 'Working...' };
    renderWidget(progress);
    expect(screen.getByTitle('Cancel')).toBeInTheDocument();
  });

  it('hides cancel button when complete', () => {
    const progress: JobProgress = { stage: 'complete', percentage: 100, message: '' };
    renderWidget(progress);
    expect(screen.queryByTitle('Cancel')).not.toBeInTheDocument();
  });

  it('emits job:cancel-requested on cancel click', () => {
    const handler = vi.fn();
    const progress: JobProgress = { stage: 'in-progress', percentage: 40, message: 'Working...' };
    const { eventBus } = renderWidget(progress, { returnEventBus: true });

    const subscription = eventBus!.get('job:cancel-requested').subscribe(handler);
    fireEvent.click(screen.getByTitle('Cancel'));
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
    renderWidget(progress);
    expect(screen.getByText('Person:')).toBeInTheDocument();
    expect(screen.getByText('Organization:')).toBeInTheDocument();
    expect(screen.getByText('Found 5')).toBeInTheDocument();
    expect(screen.getByText('Found 3')).toBeInTheDocument();
  });

  it('shows complete icon for complete stage', () => {
    const progress: JobProgress = { stage: 'complete', percentage: 100, message: '' };
    const { container } = renderWidget(progress);
    expect(container.querySelector('[data-status="complete"]')).toBeInTheDocument();
    expect(screen.getByText('Complete')).toBeInTheDocument();
  });

  it('shows error message for error stage', () => {
    const progress: JobProgress = { stage: 'error', percentage: 0, message: 'Something went wrong' };
    const { container } = renderWidget(progress);
    expect(container.querySelector('[data-status="error"]')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('shows current entity type processing details', () => {
    const progress: JobProgress = { stage: 'in-progress', percentage: 50, message: '', currentEntityType: 'Location' };
    renderWidget(progress);
    expect(screen.getByText(/Processing: Location/)).toBeInTheDocument();
  });
});
