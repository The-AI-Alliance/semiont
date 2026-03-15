/**
 * Tests for AdminExchangePage component
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminExchangePage } from '../components/AdminExchangePage';
import type { AdminExchangePageProps } from '../components/AdminExchangePage';

const createProps = (overrides?: Partial<AdminExchangePageProps>): AdminExchangePageProps => ({
  onExport: vi.fn(),
  isExporting: false,
  onFileSelected: vi.fn(),
  onImport: vi.fn(),
  onCancelImport: vi.fn(),
  selectedFile: null,
  preview: null,
  isImporting: false,
  importPhase: null,
  theme: 'light',
  showLineNumbers: false,
  activePanel: null,
  translations: {
    title: 'Backup & Restore',
    subtitle: 'Back up and restore your knowledge base',
    export: {
      title: 'Backup',
      description: 'Create a lossless backup',
      exportButton: 'Create Backup',
      exporting: 'Creating backup…',
    },
    import: {
      title: 'Restore',
      description: 'Restore from a backup',
      dropzoneLabel: 'Drop a file here',
      dropzoneActive: 'Drop to upload',
      detectedFormat: 'Format',
      statsPreview: 'Preview',
      importButton: 'Restore',
      importing: 'Restoring…',
      importConfirmTitle: 'Confirm',
      importConfirmMessage: 'Cannot undo.',
      confirmImport: 'Proceed',
      cancelImport: 'Cancel',
    },
    progress: {
      phaseStarted: 'Starting…',
      phaseEntityTypes: 'Entity types…',
      phaseResources: 'Resources…',
      phaseAnnotations: 'Annotations…',
      phaseComplete: 'Complete',
      phaseError: 'Failed',
      hashChainValid: 'Hash valid',
      hashChainInvalid: 'Hash invalid',
      streams: 'Streams',
      events: 'Events',
      blobs: 'Blobs',
    },
  },
  ToolbarPanels: () => <div data-testid="toolbar-panels" />,
  Toolbar: () => <div data-testid="toolbar" />,
  ...overrides,
});

describe('AdminExchangePage', () => {
  it('renders page title and subtitle', () => {
    render(<AdminExchangePage {...createProps()} />);
    expect(screen.getByText('Backup & Restore')).toBeInTheDocument();
    expect(screen.getByText('Back up and restore your knowledge base')).toBeInTheDocument();
  });

  it('renders ExportCard', () => {
    render(<AdminExchangePage {...createProps()} />);
    expect(screen.getByRole('heading', { name: 'Backup' })).toBeInTheDocument();
    expect(screen.getByText('Create a lossless backup')).toBeInTheDocument();
  });

  it('renders ImportCard', () => {
    render(<AdminExchangePage {...createProps()} />);
    expect(screen.getByRole('heading', { name: 'Restore' })).toBeInTheDocument();
    expect(screen.getByText('Restore from a backup')).toBeInTheDocument();
  });

  it('renders toolbar components', () => {
    render(<AdminExchangePage {...createProps()} />);
    expect(screen.getByTestId('toolbar-panels')).toBeInTheDocument();
    expect(screen.getByTestId('toolbar')).toBeInTheDocument();
  });

  it('does not render ImportProgress when importPhase is null', () => {
    const { container } = render(<AdminExchangePage {...createProps()} />);
    expect(container.querySelector('.semiont-exchange__progress')).not.toBeInTheDocument();
  });

  it('renders ImportProgress when importPhase is set', () => {
    render(<AdminExchangePage {...createProps({ importPhase: 'started' })} />);
    expect(screen.getByText('Starting…')).toBeInTheDocument();
  });

  it('renders ImportProgress with backup result on completion', () => {
    render(<AdminExchangePage {...createProps({
      importPhase: 'complete',
      importResult: { stats: { streams: 5, events: 42, blobs: 3 }, hashChainValid: true },
    })} />);
    expect(screen.getByText('Complete')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('applies panel-open class when common panel is active', () => {
    const { container } = render(<AdminExchangePage {...createProps({ activePanel: 'user' })} />);
    expect(container.querySelector('.semiont-page--panel-open')).toBeInTheDocument();
  });

  it('does not apply panel-open class when no panel is active', () => {
    const { container } = render(<AdminExchangePage {...createProps({ activePanel: null })} />);
    expect(container.querySelector('.semiont-page--panel-open')).not.toBeInTheDocument();
  });

  it('passes theme to ToolbarPanels', () => {
    const ToolbarPanels = vi.fn(() => <div data-testid="toolbar-panels" />);
    render(<AdminExchangePage {...createProps({ theme: 'dark', ToolbarPanels })} />);
    expect(ToolbarPanels).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'dark' }),
      undefined,
    );
  });

  it('passes context to Toolbar', () => {
    const Toolbar = vi.fn(() => <div data-testid="toolbar" />);
    render(<AdminExchangePage {...createProps({ Toolbar })} />);
    expect(Toolbar).toHaveBeenCalledWith(
      expect.objectContaining({ context: 'simple' }),
      undefined,
    );
  });

  it('renders cards in grid layout', () => {
    const { container } = render(<AdminExchangePage {...createProps()} />);
    expect(container.querySelector('.semiont-exchange__cards')).toBeInTheDocument();
  });
});
