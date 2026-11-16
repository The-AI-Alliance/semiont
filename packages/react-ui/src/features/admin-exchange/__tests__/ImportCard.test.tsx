/**
 * Tests for ImportCard component
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImportCard } from '../components/ImportCard';
import type { ImportCardProps } from '../components/ImportCard';

const createProps = (overrides?: Partial<ImportCardProps>): ImportCardProps => ({
  onFileSelected: vi.fn(),
  onImport: vi.fn(),
  onCancel: vi.fn(),
  selectedFile: null,
  preview: null,
  isImporting: false,
  translations: {
    title: 'Import',
    description: 'Restore from a file',
    dropzoneLabel: 'Drop a file here',
    dropzoneActive: 'Drop to upload',
    detectedFormat: 'Format',
    statsPreview: 'Preview',
    importButton: 'Import',
    importing: 'Importing…',
    importConfirmTitle: 'Confirm Import',
    importConfirmMessage: 'This cannot be undone.',
    confirmImport: 'Proceed',
    cancelImport: 'Cancel',
  },
  ...overrides,
});

describe('ImportCard', () => {
  it('renders title and description', () => {
    render(<ImportCard {...createProps()} />);
    expect(screen.getByRole('heading', { name: 'Import' })).toBeInTheDocument();
    expect(screen.getByText('Restore from a file')).toBeInTheDocument();
  });

  it('renders dropzone with label', () => {
    render(<ImportCard {...createProps()} />);
    expect(screen.getByText('Drop a file here')).toBeInTheDocument();
  });

  it('disables import button when no preview', () => {
    render(<ImportCard {...createProps()} />);
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('enables import button when preview is available', () => {
    render(<ImportCard {...createProps({
      selectedFile: new File([''], 'test.jsonl'),
      preview: { format: 'semiont-backup', version: 1, sourceUrl: '', stats: {} },
    })} />);
    expect(screen.getByRole('button', { name: 'Import' })).not.toBeDisabled();
  });

  it('shows file info when a file is selected', () => {
    const file = new File(['test'], 'backup.tar.gz');
    render(<ImportCard {...createProps({ selectedFile: file })} />);
    expect(screen.getByText(/backup\.tar\.gz/)).toBeInTheDocument();
  });

  it('shows preview details', () => {
    render(<ImportCard {...createProps({
      selectedFile: new File([''], 'test.jsonl'),
      preview: {
        format: 'semiont-backup',
        version: 1,
        sourceUrl: 'http://example.com',
        stats: { streams: 5 },
      },
    })} />);
    expect(screen.getByText('semiont-backup v1')).toBeInTheDocument();
    expect(screen.getByText('http://example.com')).toBeInTheDocument();
    expect(screen.getByText('5 streams')).toBeInTheDocument();
  });

  it('shows confirmation dialog on import click', () => {
    render(<ImportCard {...createProps({
      selectedFile: new File([''], 'test.jsonl'),
      preview: { format: 'semiont-backup', version: 1, sourceUrl: '', stats: {} },
    })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(screen.getByText('Confirm Import')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
  });

  it('calls onImport when confirmation is confirmed', () => {
    const onImport = vi.fn();
    render(<ImportCard {...createProps({
      onImport,
      selectedFile: new File([''], 'test.jsonl'),
      preview: { format: 'semiont-backup', version: 1, sourceUrl: '', stats: {} },
    })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(screen.getByRole('button', { name: 'Proceed' }));
    expect(onImport).toHaveBeenCalled();
  });

  it('hides confirmation when cancel is clicked in confirm dialog', () => {
    render(<ImportCard {...createProps({
      selectedFile: new File([''], 'test.jsonl'),
      preview: { format: 'semiont-backup', version: 1, sourceUrl: '', stats: {} },
    })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(screen.getByText('Confirm Import')).toBeInTheDocument();

    // In confirm dialog, the Cancel button
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButtons[0]);
    expect(screen.queryByText('Confirm Import')).not.toBeInTheDocument();
  });

  it('shows cancel button when file is selected', () => {
    render(<ImportCard {...createProps({
      selectedFile: new File([''], 'test.jsonl'),
    })} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('disables import button when importing', () => {
    render(<ImportCard {...createProps({
      isImporting: true,
      selectedFile: new File([''], 'test.jsonl'),
      preview: { format: 'semiont-backup', version: 1, sourceUrl: '', stats: {} },
    })} />);
    expect(screen.getByRole('button', { name: 'Importing…' })).toBeDisabled();
  });

  it('handles file drop', () => {
    const onFileSelected = vi.fn();
    render(<ImportCard {...createProps({ onFileSelected })} />);

    const dropzone = screen.getByText('Drop a file here').closest('.semiont-exchange__dropzone')!;
    const file = new File(['content'], 'test.tar.gz');

    fireEvent.drop(dropzone, {
      dataTransfer: { files: [file] },
    });

    expect(onFileSelected).toHaveBeenCalledWith(file);
  });
});
