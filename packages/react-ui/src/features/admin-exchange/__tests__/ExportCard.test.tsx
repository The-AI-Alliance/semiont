/**
 * Tests for ExportCard component
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExportCard } from '../components/ExportCard';
import type { ExportCardProps } from '../components/ExportCard';

const createProps = (overrides?: Partial<ExportCardProps>): ExportCardProps => ({
  onExport: vi.fn(),
  isExporting: false,
  translations: {
    title: 'Export',
    description: 'Download a copy',
    formatLabel: 'Format',
    formatBackup: 'Full Backup',
    formatSnapshot: 'Snapshot',
    includeArchived: 'Include archived',
    exportButton: 'Export',
    exporting: 'Exporting…',
  },
  ...overrides,
});

describe('ExportCard', () => {
  it('renders title and description', () => {
    render(<ExportCard {...createProps()} />);
    expect(screen.getByRole('heading', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByText('Download a copy')).toBeInTheDocument();
  });

  it('renders format dropdown with both options', () => {
    render(<ExportCard {...createProps()} />);
    expect(screen.getByText('Full Backup')).toBeInTheDocument();
    expect(screen.getByText('Snapshot')).toBeInTheDocument();
  });

  it('calls onExport with backup format by default', () => {
    const onExport = vi.fn();
    render(<ExportCard {...createProps({ onExport })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(onExport).toHaveBeenCalledWith('backup', false);
  });

  it('calls onExport with snapshot format when selected', () => {
    const onExport = vi.fn();
    render(<ExportCard {...createProps({ onExport })} />);
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'snapshot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(onExport).toHaveBeenCalledWith('snapshot', false);
  });

  it('shows includeArchived checkbox only for snapshot format', () => {
    render(<ExportCard {...createProps()} />);
    expect(screen.queryByText('Include archived')).not.toBeInTheDocument();

    // Switch to snapshot
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'snapshot' } });
    expect(screen.getByText('Include archived')).toBeInTheDocument();
  });

  it('passes includeArchived state to onExport', () => {
    const onExport = vi.fn();
    render(<ExportCard {...createProps({ onExport })} />);
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'snapshot' } });
    fireEvent.click(screen.getByText('Include archived'));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(onExport).toHaveBeenCalledWith('snapshot', true);
  });

  it('disables button and shows exporting text when isExporting', () => {
    render(<ExportCard {...createProps({ isExporting: true })} />);
    const button = screen.getByRole('button', { name: 'Exporting…' });
    expect(button).toBeDisabled();
  });

  it('disables format select when exporting', () => {
    render(<ExportCard {...createProps({ isExporting: true })} />);
    expect(screen.getByLabelText('Format')).toBeDisabled();
  });
});
