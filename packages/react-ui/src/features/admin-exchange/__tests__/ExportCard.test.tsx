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
    title: 'Backup',
    description: 'Create a lossless backup',
    exportButton: 'Create Backup',
    exporting: 'Creating backup…',
  },
  ...overrides,
});

describe('ExportCard', () => {
  it('renders title and description', () => {
    render(<ExportCard {...createProps()} />);
    expect(screen.getByRole('heading', { name: 'Backup' })).toBeInTheDocument();
    expect(screen.getByText('Create a lossless backup')).toBeInTheDocument();
  });

  it('calls onExport when button is clicked', () => {
    const onExport = vi.fn();
    render(<ExportCard {...createProps({ onExport })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create Backup' }));
    expect(onExport).toHaveBeenCalled();
  });

  it('disables button and shows exporting text when isExporting', () => {
    render(<ExportCard {...createProps({ isExporting: true })} />);
    const button = screen.getByRole('button', { name: 'Creating backup…' });
    expect(button).toBeDisabled();
  });
});
