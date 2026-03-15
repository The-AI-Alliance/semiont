/**
 * Tests for AdminLinkedDataPage component
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminLinkedDataPage } from '../components/AdminLinkedDataPage';
import type { AdminLinkedDataPageProps } from '../components/AdminLinkedDataPage';

const createProps = (overrides?: Partial<AdminLinkedDataPageProps>): AdminLinkedDataPageProps => ({
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
    title: 'Export & Import',
    subtitle: 'Exchange knowledge as JSON-LD Linked Data',
    export: {
      title: 'Export',
      description: 'Export your knowledge base as JSON-LD',
      exportButton: 'Export as JSON-LD',
      exporting: 'Exporting…',
    },
    import: {
      title: 'Import',
      description: 'Import from JSON-LD',
      dropzoneLabel: 'Drop a file here',
      dropzoneActive: 'Drop to upload',
      detectedFormat: 'Format',
      statsPreview: 'Preview',
      importButton: 'Import',
      importing: 'Importing…',
      importConfirmTitle: 'Confirm',
      importConfirmMessage: 'This will create new resources.',
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
      hashChainValid: 'Verified',
      hashChainInvalid: 'Verification failed',
      streams: 'Resources',
      events: 'Annotations',
      blobs: 'Entity types',
    },
  },
  ToolbarPanels: () => <div data-testid="toolbar-panels" />,
  Toolbar: () => <div data-testid="toolbar" />,
  ...overrides,
});

describe('AdminLinkedDataPage', () => {
  it('renders page title and subtitle', () => {
    render(<AdminLinkedDataPage {...createProps()} />);
    expect(screen.getByText('Export & Import')).toBeInTheDocument();
    expect(screen.getByText('Exchange knowledge as JSON-LD Linked Data')).toBeInTheDocument();
  });

  it('renders ExportCard', () => {
    render(<AdminLinkedDataPage {...createProps()} />);
    expect(screen.getByRole('heading', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByText('Export as JSON-LD')).toBeInTheDocument();
  });

  it('renders ImportCard', () => {
    render(<AdminLinkedDataPage {...createProps()} />);
    expect(screen.getByRole('heading', { name: 'Import' })).toBeInTheDocument();
    expect(screen.getByText('Import from JSON-LD')).toBeInTheDocument();
  });

  it('renders toolbar components', () => {
    render(<AdminLinkedDataPage {...createProps()} />);
    expect(screen.getByTestId('toolbar-panels')).toBeInTheDocument();
    expect(screen.getByTestId('toolbar')).toBeInTheDocument();
  });

  it('does not render ImportProgress when importPhase is null', () => {
    const { container } = render(<AdminLinkedDataPage {...createProps()} />);
    expect(container.querySelector('.semiont-exchange__progress')).not.toBeInTheDocument();
  });

  it('renders ImportProgress when importPhase is set', () => {
    render(<AdminLinkedDataPage {...createProps({ importPhase: 'started' })} />);
    expect(screen.getByText('Starting…')).toBeInTheDocument();
  });

  it('renders ImportProgress with result on completion', () => {
    render(<AdminLinkedDataPage {...createProps({
      importPhase: 'complete',
      importResult: { resourcesCreated: 5, annotationsCreated: 12, entityTypesAdded: 3 },
    })} />);
    expect(screen.getByText('Complete')).toBeInTheDocument();
  });

  it('applies panel-open class when common panel is active', () => {
    const { container } = render(<AdminLinkedDataPage {...createProps({ activePanel: 'user' })} />);
    expect(container.querySelector('.semiont-page--panel-open')).toBeInTheDocument();
  });

  it('does not apply panel-open class when no panel is active', () => {
    const { container } = render(<AdminLinkedDataPage {...createProps({ activePanel: null })} />);
    expect(container.querySelector('.semiont-page--panel-open')).not.toBeInTheDocument();
  });
});
