/**
 * ImportCard — File drop zone, preview, and import trigger
 *
 * Pure React component. All state and handlers passed as props.
 */

import React, { useRef, useState, useCallback } from 'react';
import type { ImportPreview } from '@semiont/api-client';

export type { ImportPreview };

export interface ImportCardTranslations {
  title: string;
  description: string;
  dropzoneLabel: string;
  dropzoneActive: string;
  detectedFormat: string;
  statsPreview: string;
  importButton: string;
  importing: string;
  importConfirmTitle: string;
  importConfirmMessage: string;
  confirmImport: string;
  cancelImport: string;
}

export interface ImportCardProps {
  onFileSelected: (file: File) => void;
  onImport: () => void;
  onCancel: () => void;
  selectedFile: File | null;
  preview: ImportPreview | null;
  isImporting: boolean;
  translations: ImportCardTranslations;
}

export function ImportCard({
  onFileSelected,
  onImport,
  onCancel,
  selectedFile,
  preview,
  isImporting,
  translations: t,
}: ImportCardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragActive(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragActive(false);
    setShowConfirm(false);
    const file = e.dataTransfer.files[0];
    if (file) onFileSelected(file);
  }, [onFileSelected]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setShowConfirm(false);
    const file = e.target.files?.[0];
    if (file) onFileSelected(file);
  }, [onFileSelected]);

  const handleImportClick = () => {
    setShowConfirm(true);
  };

  const handleConfirm = () => {
    setShowConfirm(false);
    onImport();
  };

  const handleCancelConfirm = () => {
    setShowConfirm(false);
  };

  return (
    <div className="semiont-admin__card">
      <h2 className="semiont-admin__section-title">{t.title}</h2>
      <p className="semiont-admin__section-description">{t.description}</p>

      <div
        className={`semiont-exchange__dropzone${isDragActive ? ' semiont-exchange__dropzone--active' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <p className="semiont-exchange__dropzone-text">
          {isDragActive ? t.dropzoneActive : t.dropzoneLabel}
        </p>
        {selectedFile && (
          <p className="semiont-exchange__file-info">
            {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
          </p>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".tar.gz,.jsonl,.gz"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      {preview && (
        <div className="semiont-exchange__preview">
          <div className="semiont-exchange__preview-row">
            <span className="semiont-exchange__preview-label">{t.detectedFormat}</span>
            <span className="semiont-exchange__preview-value">
              {preview.format} v{preview.version}
            </span>
          </div>
          {preview.sourceUrl && (
            <div className="semiont-exchange__preview-row">
              <span className="semiont-exchange__preview-label">Source</span>
              <span className="semiont-exchange__preview-value">{preview.sourceUrl}</span>
            </div>
          )}
          {Object.keys(preview.stats).length > 0 && (
            <div className="semiont-exchange__preview-row">
              <span className="semiont-exchange__preview-label">{t.statsPreview}</span>
              <span className="semiont-exchange__preview-value">
                {Object.entries(preview.stats).map(([k, v]) => `${v} ${k}`).join(', ')}
              </span>
            </div>
          )}
        </div>
      )}

      {showConfirm && (
        <div className="semiont-exchange__confirm">
          <p className="semiont-exchange__confirm-title">{t.importConfirmTitle}</p>
          <p className="semiont-exchange__confirm-message">{t.importConfirmMessage}</p>
          <div className="semiont-exchange__confirm-actions">
            <button
              className="semiont-exchange__button semiont-exchange__button--primary"
              onClick={handleConfirm}
            >
              {t.confirmImport}
            </button>
            <button
              className="semiont-exchange__button semiont-exchange__button--secondary"
              onClick={handleCancelConfirm}
            >
              {t.cancelImport}
            </button>
          </div>
        </div>
      )}

      {!showConfirm && (
        <div className="semiont-exchange__actions">
          <button
            className="semiont-exchange__button semiont-exchange__button--primary"
            onClick={handleImportClick}
            disabled={!preview || isImporting}
          >
            {isImporting ? t.importing : t.importButton}
          </button>
          {selectedFile && (
            <button
              className="semiont-exchange__button semiont-exchange__button--secondary"
              onClick={onCancel}
              disabled={isImporting}
            >
              {t.cancelImport}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
