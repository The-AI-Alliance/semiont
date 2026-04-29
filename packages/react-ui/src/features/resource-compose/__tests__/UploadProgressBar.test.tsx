import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { UploadProgress } from '@semiont/sdk';
import type { ResourceId } from '@semiont/core';
import { UploadProgressBar } from '../components/UploadProgressBar';

describe('UploadProgressBar', () => {
  describe('null progress', () => {
    it('renders nothing when progress is null', () => {
      const { container } = render(<UploadProgressBar progress={null} />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('phase: started', () => {
    const started: UploadProgress = { phase: 'started', totalBytes: 1024 };

    it('shows the starting label with default "Upload" prefix', () => {
      render(<UploadProgressBar progress={started} />);
      expect(screen.getByText('Upload: starting…')).toBeInTheDocument();
    });

    it('uses a custom label when provided', () => {
      render(<UploadProgressBar progress={started} label="Image" />);
      expect(screen.getByText('Image: starting…')).toBeInTheDocument();
    });

    it('renders an indeterminate bar (no role=progressbar in this phase)', () => {
      const { container } = render(<UploadProgressBar progress={started} />);
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      expect(container.querySelector('.semiont-progress--indeterminate')).not.toBeNull();
    });

    it('marks the live region polite for assistive tech', () => {
      render(<UploadProgressBar progress={started} />);
      const status = screen.getByRole('status');
      expect(status).toHaveAttribute('aria-live', 'polite');
    });
  });

  describe('phase: progress (determinate)', () => {
    it('renders percentage and byte counts when totalBytes is known', () => {
      const progress: UploadProgress = {
        phase: 'progress',
        bytesUploaded: 512,
        totalBytes: 2048,
      };
      render(<UploadProgressBar progress={progress} />);
      expect(screen.getByText('Upload: 25%')).toBeInTheDocument();
      expect(screen.getByText('512 B / 2.0 KB')).toBeInTheDocument();
    });

    it('rounds percentage to nearest integer', () => {
      const progress: UploadProgress = {
        phase: 'progress',
        bytesUploaded: 333,
        totalBytes: 1000,
      };
      render(<UploadProgressBar progress={progress} />);
      // 333/1000 = 33.3% → rounds to 33
      expect(screen.getByText('Upload: 33%')).toBeInTheDocument();
    });

    it('caps percentage at 100 when bytesUploaded exceeds totalBytes', () => {
      const progress: UploadProgress = {
        phase: 'progress',
        bytesUploaded: 5000,
        totalBytes: 1000,
      };
      render(<UploadProgressBar progress={progress} />);
      expect(screen.getByText('Upload: 100%')).toBeInTheDocument();
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuenow', '100');
    });

    it('exposes ARIA progressbar attributes for determinate progress', () => {
      const progress: UploadProgress = {
        phase: 'progress',
        bytesUploaded: 500,
        totalBytes: 1000,
      };
      render(<UploadProgressBar progress={progress} />);
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuemin', '0');
      expect(bar).toHaveAttribute('aria-valuemax', '100');
      expect(bar).toHaveAttribute('aria-valuenow', '50');
    });

    it('sets the fill width inline style to the percentage', () => {
      const progress: UploadProgress = {
        phase: 'progress',
        bytesUploaded: 750,
        totalBytes: 1000,
      };
      const { container } = render(<UploadProgressBar progress={progress} />);
      const fill = container.querySelector('.semiont-progress__fill') as HTMLElement;
      expect(fill).not.toBeNull();
      expect(fill.style.width).toBe('75%');
    });

    it('does not apply the indeterminate class when totalBytes is known', () => {
      const progress: UploadProgress = {
        phase: 'progress',
        bytesUploaded: 100,
        totalBytes: 1000,
      };
      const { container } = render(<UploadProgressBar progress={progress} />);
      expect(container.querySelector('.semiont-progress--indeterminate')).toBeNull();
    });

    it('uses the custom label in determinate mode', () => {
      const progress: UploadProgress = {
        phase: 'progress',
        bytesUploaded: 100,
        totalBytes: 1000,
      };
      render(<UploadProgressBar progress={progress} label="Avatar" />);
      expect(screen.getByText('Avatar: 10%')).toBeInTheDocument();
    });
  });

  describe('phase: progress (indeterminate)', () => {
    it('renders bytesUploaded only when totalBytes is 0', () => {
      const progress: UploadProgress = {
        phase: 'progress',
        bytesUploaded: 4096,
        totalBytes: 0,
      };
      render(<UploadProgressBar progress={progress} />);
      expect(screen.getByText('Upload: 4.0 KB…')).toBeInTheDocument();
      expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    });

    it('renders bytesUploaded only when totalBytes is negative', () => {
      const progress: UploadProgress = {
        phase: 'progress',
        bytesUploaded: 1234,
        totalBytes: -1,
      };
      render(<UploadProgressBar progress={progress} />);
      expect(screen.getByText('Upload: 1.2 KB…')).toBeInTheDocument();
    });

    it('omits aria-valuemax and aria-valuenow in indeterminate mode', () => {
      const progress: UploadProgress = {
        phase: 'progress',
        bytesUploaded: 100,
        totalBytes: 0,
      };
      render(<UploadProgressBar progress={progress} />);
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuemin', '0');
      expect(bar).not.toHaveAttribute('aria-valuemax');
      expect(bar).not.toHaveAttribute('aria-valuenow');
    });

    it('applies the indeterminate class and omits inline width', () => {
      const progress: UploadProgress = {
        phase: 'progress',
        bytesUploaded: 100,
        totalBytes: 0,
      };
      const { container } = render(<UploadProgressBar progress={progress} />);
      expect(container.querySelector('.semiont-progress--indeterminate')).not.toBeNull();
      const fill = container.querySelector('.semiont-progress__fill') as HTMLElement;
      expect(fill.style.width).toBe('');
    });
  });

  describe('phase: finished', () => {
    const finished: UploadProgress = {
      phase: 'finished',
      resourceId: 'res-1' as ResourceId,
    };

    it('renders an "uploaded" label', () => {
      render(<UploadProgressBar progress={finished} />);
      expect(screen.getByText('Upload: uploaded')).toBeInTheDocument();
    });

    it('uses a custom label in the finished state', () => {
      render(<UploadProgressBar progress={finished} label="Image" />);
      expect(screen.getByText('Image: uploaded')).toBeInTheDocument();
    });

    it('reports 100% on the progressbar', () => {
      render(<UploadProgressBar progress={finished} />);
      const bar = screen.getByRole('progressbar');
      expect(bar).toHaveAttribute('aria-valuemin', '0');
      expect(bar).toHaveAttribute('aria-valuemax', '100');
      expect(bar).toHaveAttribute('aria-valuenow', '100');
    });

    it('applies the success fill modifier and full width', () => {
      const { container } = render(<UploadProgressBar progress={finished} />);
      const fill = container.querySelector('.semiont-progress__fill--success') as HTMLElement;
      expect(fill).not.toBeNull();
      expect(fill.style.width).toBe('100%');
    });
  });

  describe('byte formatting', () => {
    // Exercises formatBytes() at every threshold via the visible label.
    it.each([
      [0, '0 B'],
      [1023, '1023 B'],
      [1024, '1.0 KB'],
      [1024 * 1024 - 1, '1024.0 KB'],
      [1024 * 1024, '1.0 MB'],
      [1024 * 1024 * 1024 - 1, '1024.0 MB'],
      [1024 * 1024 * 1024, '1.00 GB'],
      [5 * 1024 * 1024 * 1024, '5.00 GB'],
    ])('formats %i bytes as "%s"', (bytes, expected) => {
      const progress: UploadProgress = {
        phase: 'progress',
        bytesUploaded: bytes,
        totalBytes: 0,
      };
      render(<UploadProgressBar progress={progress} />);
      expect(screen.getByText(`Upload: ${expected}…`)).toBeInTheDocument();
    });
  });
});
