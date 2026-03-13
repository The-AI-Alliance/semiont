/**
 * Tests for ImportProgress component
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ImportProgress } from '../components/ImportProgress';
import type { ImportProgressProps } from '../components/ImportProgress';

const translations: ImportProgressProps['translations'] = {
  phaseStarted: 'Starting import…',
  phaseEntityTypes: 'Adding entity types…',
  phaseResources: 'Creating resources…',
  phaseAnnotations: 'Creating annotations…',
  phaseComplete: 'Import complete',
  phaseError: 'Import failed',
  hashChainValid: 'Hash chain valid',
  hashChainInvalid: 'Hash chain invalid',
  resourcesCreated: 'Resources created',
  annotationsCreated: 'Annotations created',
  entityTypesAdded: 'Entity types added',
  streams: 'Event streams',
  events: 'Events',
  blobs: 'Content blobs',
};

describe('ImportProgress', () => {
  it('renders phase label for known phases', () => {
    render(<ImportProgress phase="started" translations={translations} />);
    expect(screen.getByText('Starting import…')).toBeInTheDocument();
  });

  it('renders raw phase string for unknown phases', () => {
    render(<ImportProgress phase="custom-phase" translations={translations} />);
    expect(screen.getByText('custom-phase')).toBeInTheDocument();
  });

  it('renders message during active phases', () => {
    render(<ImportProgress phase="resources" message="Processing resource 3/10" translations={translations} />);
    expect(screen.getByText('Processing resource 3/10')).toBeInTheDocument();
  });

  it('does not render message during complete phase', () => {
    render(<ImportProgress phase="complete" message="some message" translations={translations} />);
    expect(screen.queryByText('some message')).not.toBeInTheDocument();
  });

  it('renders complete phase with correct class', () => {
    const { container } = render(<ImportProgress phase="complete" translations={translations} />);
    const label = container.querySelector('.semiont-exchange__phase-label--complete');
    expect(label).toBeInTheDocument();
    expect(label).toHaveTextContent('Import complete');
  });

  it('renders error phase with correct class', () => {
    const { container } = render(<ImportProgress phase="error" translations={translations} />);
    const label = container.querySelector('.semiont-exchange__phase-label--error');
    expect(label).toBeInTheDocument();
    expect(label).toHaveTextContent('Import failed');
  });

  it('renders error message', () => {
    render(<ImportProgress phase="error" message="Connection failed" translations={translations} />);
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
  });

  it('renders backup result stats', () => {
    render(<ImportProgress
      phase="complete"
      result={{ stats: { streams: 5, events: 42, blobs: 3 } }}
      translations={translations}
    />);
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('Event streams')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Events')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Content blobs')).toBeInTheDocument();
  });

  it('renders snapshot result stats', () => {
    render(<ImportProgress
      phase="complete"
      result={{ resourcesCreated: 10, annotationsCreated: 25, entityTypesAdded: 3 }}
      translations={translations}
    />);
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('Resources created')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
    expect(screen.getByText('Annotations created')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Entity types added')).toBeInTheDocument();
  });

  it('renders valid hash chain badge', () => {
    const { container } = render(<ImportProgress
      phase="complete"
      result={{ hashChainValid: true }}
      translations={translations}
    />);
    expect(screen.getByText('Hash chain valid')).toBeInTheDocument();
    expect(container.querySelector('.semiont-exchange__hash-badge--valid')).toBeInTheDocument();
  });

  it('renders invalid hash chain badge', () => {
    const { container } = render(<ImportProgress
      phase="complete"
      result={{ hashChainValid: false }}
      translations={translations}
    />);
    expect(screen.getByText('Hash chain invalid')).toBeInTheDocument();
    expect(container.querySelector('.semiont-exchange__hash-badge--invalid')).toBeInTheDocument();
  });

  it('does not render result section during non-complete phases', () => {
    const { container } = render(<ImportProgress
      phase="resources"
      result={{ resourcesCreated: 5 }}
      translations={translations}
    />);
    expect(container.querySelector('.semiont-exchange__result')).not.toBeInTheDocument();
  });
});
