/**
 * Tests for ImportProgress component
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ImportProgress } from '../components/ImportProgress';
import type { ImportProgressProps } from '../components/ImportProgress';

const translations: ImportProgressProps['translations'] = {
  phaseStarted: 'Starting restore…',
  phaseComplete: 'Restore complete',
  phaseError: 'Restore failed',
  statsEventsReplayed: 'Events replayed',
  statsResourcesCreated: 'Resources created',
  statsAnnotationsCreated: 'Annotations created',
  statsEntityTypesAdded: 'Entity types added',
};

describe('ImportProgress', () => {
  it('renders phase label for known phases', () => {
    render(<ImportProgress phase="started" translations={translations} />);
    expect(screen.getByText('Starting restore…')).toBeInTheDocument();
  });

  it('renders raw phase string for unknown phases', () => {
    render(<ImportProgress phase="custom-phase" translations={translations} />);
    expect(screen.getByText('custom-phase')).toBeInTheDocument();
  });

  it('renders message during active phases', () => {
    render(<ImportProgress phase="started" message="Restoring backup..." translations={translations} />);
    expect(screen.getByText('Restoring backup...')).toBeInTheDocument();
  });

  it('does not render message during complete phase', () => {
    render(<ImportProgress phase="complete" message="some message" translations={translations} />);
    expect(screen.queryByText('some message')).not.toBeInTheDocument();
  });

  it('renders complete phase with correct class', () => {
    const { container } = render(<ImportProgress phase="complete" translations={translations} />);
    const label = container.querySelector('.semiont-exchange__phase-label--complete');
    expect(label).toBeInTheDocument();
    expect(label).toHaveTextContent('Restore complete');
  });

  it('renders error phase with correct class', () => {
    const { container } = render(<ImportProgress phase="error" translations={translations} />);
    const label = container.querySelector('.semiont-exchange__phase-label--error');
    expect(label).toBeInTheDocument();
    expect(label).toHaveTextContent('Restore failed');
  });

  it('renders error message', () => {
    render(<ImportProgress phase="error" message="Connection failed" translations={translations} />);
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
  });

  it('renders backup restore stats nested under result.stats', () => {
    render(<ImportProgress
      phase="complete"
      result={{ stats: { eventsReplayed: 42, resourcesCreated: 5, annotationsCreated: 12, entityTypesAdded: 3 } }}
      translations={translations}
    />);
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Events replayed')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Resources created')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Annotations created')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Entity types added')).toBeInTheDocument();
  });

  it('renders linked-data import stats nested under result.stats', () => {
    render(<ImportProgress
      phase="complete"
      result={{ stats: { resourcesCreated: 5, annotationsCreated: 12, entityTypesAdded: 3 } }}
      translations={translations}
    />);
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Resources created')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Annotations created')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Entity types added')).toBeInTheDocument();
  });

  it('does not render result section when result lacks a stats object', () => {
    const { container } = render(<ImportProgress
      phase="complete"
      result={{ resourcesCreated: 5 }}
      translations={translations}
    />);
    expect(container.querySelector('.semiont-exchange__result')).not.toBeInTheDocument();
  });

  it('renders raw key for unknown stats', () => {
    render(<ImportProgress
      phase="complete"
      result={{ stats: { somethingNew: 7 } }}
      translations={translations}
    />);
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('somethingNew')).toBeInTheDocument();
  });

  it('does not render result section during non-complete phases', () => {
    const { container } = render(<ImportProgress
      phase="started"
      result={{ stats: { eventsReplayed: 42, resourcesCreated: 5, annotationsCreated: 12, entityTypesAdded: 3 } }}
      translations={translations}
    />);
    expect(container.querySelector('.semiont-exchange__result')).not.toBeInTheDocument();
  });
});
