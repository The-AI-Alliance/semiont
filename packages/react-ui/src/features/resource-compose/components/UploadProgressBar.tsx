'use client';

/**
 * Inline upload-progress affordance for the compose page.
 *
 * Subscribes (via prop) to a `UploadProgress | null` value derived from
 * `composeVM.uploadProgress$`. Renders nothing when null; renders an
 * indeterminate state on `started`; renders a labeled bar with byte
 * counts on `progress`; renders a brief "Uploaded" success state on
 * `finished` (cleared by the VM's `null` push on complete).
 *
 * Designed to live below the Save button in the compose form so the
 * visual association with the action that triggered the upload is
 * direct. Uses the existing `.semiont-progress` styles in
 * `packages/react-ui/src/styles/core/progress.css`.
 */

import React from 'react';
import type { UploadProgress } from '@semiont/sdk';

export interface UploadProgressBarProps {
  progress: UploadProgress | null;
  /** Optional label for the "starting" / "uploaded" lines. Defaults to "Upload". */
  label?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function UploadProgressBar({ progress, label = 'Upload' }: UploadProgressBarProps): React.ReactElement | null {
  if (!progress) return null;

  if (progress.phase === 'started') {
    return (
      <div className="semiont-progress-wrapper" role="status" aria-live="polite">
        <div className="semiont-progress__label">
          <span>{label}: starting…</span>
        </div>
        <div className="semiont-progress semiont-progress--indeterminate">
          <div className="semiont-progress__fill" />
        </div>
      </div>
    );
  }

  if (progress.phase === 'progress') {
    const indeterminate = progress.totalBytes <= 0;
    const percentage = indeterminate
      ? 0
      : Math.min(100, Math.round((progress.bytesUploaded / progress.totalBytes) * 100));
    return (
      <div className="semiont-progress-wrapper" role="status" aria-live="polite">
        <div className="semiont-progress__label">
          {indeterminate ? (
            <span>{label}: {formatBytes(progress.bytesUploaded)}…</span>
          ) : (
            <>
              <span>{label}: {percentage}%</span>
              <span>{formatBytes(progress.bytesUploaded)} / {formatBytes(progress.totalBytes)}</span>
            </>
          )}
        </div>
        <div
          className={`semiont-progress${indeterminate ? ' semiont-progress--indeterminate' : ''}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={indeterminate ? undefined : 100}
          aria-valuenow={indeterminate ? undefined : percentage}
        >
          <div
            className="semiont-progress__fill"
            style={indeterminate ? undefined : { width: `${percentage}%` }}
          />
        </div>
      </div>
    );
  }

  // phase === 'finished'
  return (
    <div className="semiont-progress-wrapper" role="status" aria-live="polite">
      <div className="semiont-progress__label">
        <span>{label}: uploaded</span>
      </div>
      <div className="semiont-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={100}>
        <div className="semiont-progress__fill semiont-progress__fill--success" style={{ width: '100%' }} />
      </div>
    </div>
  );
}
