/**
 * ResourceComposePage Component
 *
 * Pure React component for creating and editing resources.
 * Supports three modes: new resource, clone, and reference completion.
 * All dependencies passed as props - no Next.js hooks!
 */

import React, { useState, useEffect } from 'react';
import type { components, ResourceUri, ContentFormat } from '@semiont/api-client';
import { isImageMimeType, LOCALES } from '@semiont/api-client';
import { buttonStyles, CodeMirrorRenderer } from '@semiont/react-ui';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export interface ResourceComposePageProps {
  // Mode detection
  mode: 'new' | 'clone' | 'reference';

  // Clone mode data
  cloneData?: {
    sourceResource: ResourceDescriptor;
    sourceContent: string;
  };

  // Reference completion data
  referenceData?: {
    referenceId: string;
    sourceDocumentId: string;
    name: string;
    entityTypes: string[];
  };

  // Available options
  availableEntityTypes: string[];

  // Initial values
  initialLocale: string;

  // UI state
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
  showLineNumbers: boolean;
  onLineNumbersToggle: () => void;
  activePanel: string | null;
  onPanelToggle: (panel: string) => void;

  // Actions
  onSaveResource: (params: SaveResourceParams) => Promise<void>;
  onCancel: () => void;

  // Translations
  translations: {
    title: string;
    titleEditClone: string;
    titleCompleteReference: string;
    subtitleClone: string;
    subtitleReference: string;
    linkedNoticePrefix: string;
    resourceName: string;
    resourceNamePlaceholder: string;
    entityTypes: string;
    language: string;
    contentSource: string;
    uploadFile: string;
    uploadFileDescription: string;
    writeContent: string;
    writeContentDescription: string;
    dropFileOrClick: string;
    supportedFormats: string;
    mediaType: string;
    autoDetected: string;
    format: string;
    content: string;
    resourceContent: string;
    encoding: string;
    archiveOriginal: string;
    cancel: string;
    saving: string;
    creating: string;
    creatingAndLinking: string;
    saveClonedResource: string;
    createAndLinkResource: string;
    createResource: string;
  };

  // Component dependencies
  ToolbarPanels: React.ComponentType<any>;
  Toolbar: React.ComponentType<any>;
}

export interface SaveResourceParams {
  mode: 'new' | 'clone' | 'reference';
  name: string;
  content?: string;
  file?: File;
  format?: string;
  charset?: string;
  entityTypes?: string[];
  language: string;
  archiveOriginal?: boolean;
  referenceId?: string;
  sourceDocumentId?: string;
}

export function ResourceComposePage({
  mode,
  cloneData,
  referenceData,
  availableEntityTypes,
  initialLocale,
  theme,
  onThemeChange,
  showLineNumbers,
  onLineNumbersToggle,
  activePanel,
  onPanelToggle,
  onSaveResource,
  onCancel,
  translations: t,
  ToolbarPanels,
  Toolbar,
}: ResourceComposePageProps) {
  // Form state
  const [newResourceName, setNewResourceName] = useState('');
  const [newResourceContent, setNewResourceContent] = useState('');
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>([]);
  const [isCreating, setIsCreating] = useState(false);

  // Content input method selection
  const [inputMethod, setInputMethod] = useState<'upload' | 'write'>('write');

  // File upload state
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [fileMimeType, setFileMimeType] = useState<string>('text/markdown');
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);

  // Format selection for manual content entry
  const [selectedFormat, setSelectedFormat] = useState<string>('text/markdown');

  // Language selection - default to current user locale
  const [selectedLanguage, setSelectedLanguage] = useState<string>(initialLocale);

  // Character encoding selection - default to UTF-8 (empty string means use default)
  const [selectedCharset, setSelectedCharset] = useState<string>('');

  // Archive original checkbox (for clones only)
  const [archiveOriginal, setArchiveOriginal] = useState(true);

  // Initialize form data based on mode
  useEffect(() => {
    if (mode === 'clone' && cloneData) {
      setNewResourceName(cloneData.sourceResource.name);
      setNewResourceContent(cloneData.sourceContent);
    } else if (mode === 'reference' && referenceData) {
      setNewResourceName(referenceData.name);
      if (referenceData.entityTypes.length > 0) {
        setSelectedEntityTypes(referenceData.entityTypes);
      }
    }
  }, [mode, cloneData, referenceData]);

  // Handle file upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadedFile(file);
    setFileMimeType(file.type);
    setInputMethod('upload');

    // Set file name as default resource name if empty
    if (!newResourceName) {
      const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
      setNewResourceName(nameWithoutExt);
    }

    // For images, create preview URL
    if (isImageMimeType(file.type)) {
      const previewUrl = URL.createObjectURL(file);
      setFilePreviewUrl(previewUrl);
    } else {
      // For text files, read content
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        setNewResourceContent(content);
      };
      reader.readAsText(file);
    }
  };

  // Cleanup preview URL on unmount
  useEffect(() => {
    return () => {
      if (filePreviewUrl) {
        URL.revokeObjectURL(filePreviewUrl);
      }
    };
  }, [filePreviewUrl]);

  const handleSaveResource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newResourceName.trim()) return;

    setIsCreating(true);
    try {
      const params: SaveResourceParams = {
        mode,
        name: newResourceName,
        content: newResourceContent,
        format: uploadedFile ? fileMimeType : selectedFormat,
        entityTypes: selectedEntityTypes,
        language: selectedLanguage,
      };

      if (uploadedFile) {
        params.file = uploadedFile;
      }
      if (selectedCharset) {
        params.charset = selectedCharset;
      }
      if (mode === 'clone') {
        params.archiveOriginal = archiveOriginal;
      }
      if (referenceData?.referenceId) {
        params.referenceId = referenceData.referenceId;
      }
      if (referenceData?.sourceDocumentId) {
        params.sourceDocumentId = referenceData.sourceDocumentId;
      }

      await onSaveResource(params);
    } finally {
      setIsCreating(false);
    }
  };

  const isClone = mode === 'clone';
  const isReferenceCompletion = mode === 'reference';

  return (
    <div className="semiont-page">
      {/* Main Content Area */}
      <div className="semiont-page__content semiont-page__compose">
        {/* Page Title */}
        <div className="semiont-page__header">
          <h1 className="semiont-page__title">
            {isClone ? t.titleEditClone : isReferenceCompletion ? t.titleCompleteReference : t.title}
          </h1>
          {(isClone || isReferenceCompletion) && (
            <p className="semiont-page__subtitle">
              {isClone ? t.subtitleClone : t.subtitleReference}
            </p>
          )}
          {isReferenceCompletion && (
            <div className="semiont-page__reference-notice">
              <p className="semiont-page__reference-notice-text">
                {t.linkedNoticePrefix}
              </p>
            </div>
          )}
        </div>

        {/* Create Form */}
        <div className="semiont-form">
        <form onSubmit={handleSaveResource} className="semiont-form__fields">
          {/* Name */}
          <div className="semiont-form__field">
            <label htmlFor="docName" className="semiont-form__label">
              {t.resourceName}
            </label>
            <input
              id="docName"
              type="text"
              value={newResourceName}
              onChange={(e) => setNewResourceName(e.target.value)}
              placeholder={t.resourceNamePlaceholder}
              className="semiont-form__input"
              required
              disabled={isCreating}
            />
          </div>

          {/* Entity Types Selection */}
          {(!isReferenceCompletion || selectedEntityTypes.length === 0) && (
            <div className="semiont-form__field semiont-form__entity-types">
              <div className="semiont-form__label">
                {t.entityTypes}
              </div>
              <div
                className="semiont-form__entity-type-buttons"
                role="group"
                aria-describedby="entity-types-description"
              >
                {availableEntityTypes.map((type: string) => {
                  const isSelected = selectedEntityTypes.includes(type);
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => {
                        setSelectedEntityTypes(prev =>
                          prev.includes(type)
                            ? prev.filter(t => t !== type)
                            : [...prev, type]
                        );
                      }}
                      className="semiont-form__entity-type-button"
                      data-selected={isSelected}
                      disabled={isCreating}
                      aria-pressed={isSelected}
                      aria-label={`${type} entity type, ${isSelected ? 'selected' : 'not selected'}`}
                    >
                      {type}
                    </button>
                  );
                })}
              </div>
              {selectedEntityTypes.length > 0 && (
                <div
                  className="sr-only"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {selectedEntityTypes.length} entity type{selectedEntityTypes.length !== 1 ? 's' : ''} selected: {selectedEntityTypes.join(', ')}
                </div>
              )}
            </div>
          )}

          {/* Entity Types Display for reference completion */}
          {isReferenceCompletion && selectedEntityTypes.length > 0 && (
            <div className="semiont-form__field semiont-form__entity-types-display" role="region" aria-labelledby="selected-entity-types-label">
              <h3 id="selected-entity-types-label" className="semiont-form__label">
                {t.entityTypes}
              </h3>
              <div className="semiont-form__entity-type-tags" role="list">
                {selectedEntityTypes.map((type) => (
                  <span
                    key={type}
                    role="listitem"
                    className="semiont-form__entity-type-tag"
                    aria-label={`Entity type: ${type}`}
                  >
                    {type}
                  </span>
                ))}
              </div>
              <p className="semiont-form__helper-text" id="reference-entity-types-description">
                These entity types were selected when creating the reference
              </p>
            </div>
          )}

          {/* Language Selector */}
          <div className="semiont-form__field">
            <label htmlFor="language-select" className="semiont-form__label">
              {t.language}
            </label>
            <select
              id="language-select"
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
              disabled={isCreating}
              className="semiont-form__select"
            >
              {LOCALES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.nativeName}
                </option>
              ))}
            </select>
          </div>

          {/* Content Source Toggle - only show for new resources */}
          {!isClone && !isReferenceCompletion && (
            <div className="semiont-form__field">
              <label className="semiont-form__label">
                {t.contentSource}
              </label>
              <div className="semiont-form__content-source-toggle">
                <button
                  type="button"
                  onClick={() => setInputMethod('upload')}
                  disabled={isCreating}
                  className="semiont-form__content-source-button"
                  data-active={inputMethod === 'upload'}
                >
                  <div className="semiont-form__content-source-icon-wrapper">
                    <span className="semiont-form__content-source-icon">📎</span>
                    <span className="semiont-form__content-source-label">{t.uploadFile}</span>
                  </div>
                  <div className="semiont-form__content-source-description">
                    {t.uploadFileDescription}
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setInputMethod('write')}
                  disabled={isCreating}
                  className="semiont-form__content-source-button"
                  data-active={inputMethod === 'write'}
                >
                  <div className="semiont-form__content-source-icon-wrapper">
                    <span className="semiont-form__content-source-icon">✍️</span>
                    <span className="semiont-form__content-source-label">{t.writeContent}</span>
                  </div>
                  <div className="semiont-form__content-source-description">
                    {t.writeContentDescription}
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* Upload File Section */}
          {!isClone && !isReferenceCompletion && inputMethod === 'upload' && (
            <div className="semiont-form__upload-section">
              <div>
                <div className="semiont-form__upload-container">
                  <label className="semiont-form__upload-dropzone">
                    <div className="semiont-form__upload-area">
                      <input
                        type="file"
                        accept="text/plain,text/markdown,image/png,image/jpeg"
                        onChange={handleFileUpload}
                        className="semiont-form__upload-input"
                        disabled={isCreating}
                      />
                      <p className="semiont-form__upload-text">
                        {uploadedFile ? uploadedFile.name : t.dropFileOrClick}
                      </p>
                      <p className="semiont-form__upload-hint">
                        {t.supportedFormats}
                      </p>
                    </div>
                  </label>
                  {uploadedFile && (
                    <button
                      type="button"
                      onClick={() => {
                        setUploadedFile(null);
                        setFilePreviewUrl(null);
                        setFileMimeType('text/markdown');
                      }}
                      className="semiont-button semiont-button--danger semiont-button--small"
                      disabled={isCreating}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Media Type Display - Auto-detected */}
              {uploadedFile && (
                <div className="semiont-form__media-type">
                  <span className="semiont-form__media-type-label">{t.mediaType}:</span>
                  <code className="semiont-form__media-type-value">
                    {fileMimeType}
                  </code>
                  <span className="semiont-form__media-type-lock" title={t.autoDetected}>🔒</span>
                </div>
              )}

              {/* Image Preview */}
              {uploadedFile && filePreviewUrl && isImageMimeType(fileMimeType) && (
                <div className="semiont-form__image-preview">
                  <p className="semiont-form__image-preview-label">Preview:</p>
                  <div className="semiont-form__image-preview-container">
                    <img
                      src={filePreviewUrl}
                      alt="Upload preview"
                      className="semiont-form__image-preview-img"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Write Content Section */}
          {(isClone || isReferenceCompletion || inputMethod === 'write') && (
            <div className="semiont-form__write-section">
              {/* Format Selector - only for manual entry, not clones */}
              {!isClone && !isReferenceCompletion && (
                <div className="semiont-form__field">
                  <label htmlFor="format-select" className="semiont-form__label">
                    {t.format}
                  </label>
                  <select
                    id="format-select"
                    value={selectedFormat}
                    onChange={(e) => setSelectedFormat(e.target.value)}
                    disabled={isCreating}
                    className="semiont-form__select"
                  >
                    <option value="text/markdown">Markdown (text/markdown)</option>
                    <option value="text/plain">Plain Text (text/plain)</option>
                    <option value="text/html">HTML (text/html)</option>
                  </select>
                </div>
              )}

              {/* Content Editor */}
              <div className="semiont-form__field semiont-form__editor">
                <label className="semiont-form__label">
                  {isClone ? t.resourceContent : t.content}
                </label>
                <div className="semiont-form__editor-wrapper">
                  <CodeMirrorRenderer
                    content={newResourceContent}
                    segments={[]}
                    editable={!isCreating}
                    sourceView={true}
                    showLineNumbers={showLineNumbers}
                    onChange={(newContent) => setNewResourceContent(newContent)}
                  />
                </div>
              </div>

              {/* Encoding Selector - only for manual text entry */}
              {!isClone && !isReferenceCompletion && (
                <div className="semiont-form__field">
                  <label htmlFor="charset-select" className="semiont-form__label">
                    {t.encoding}
                  </label>
                  <select
                    id="charset-select"
                    value={selectedCharset}
                    onChange={(e) => setSelectedCharset(e.target.value)}
                    disabled={isCreating}
                    className="semiont-form__select"
                  >
                    <option value="">UTF-8 (default)</option>
                    <option value="iso-8859-1">ISO-8859-1 (Latin-1)</option>
                    <option value="windows-1252">Windows-1252</option>
                    <option value="ascii">ASCII</option>
                    <option value="utf-16le">UTF-16LE</option>
                  </select>
                </div>
              )}
            </div>
          )}

          {/* Archive Original Checkbox (for clones only) */}
          {isClone && (
            <div className="semiont-form__checkbox-field">
              <input
                id="archiveOriginal"
                type="checkbox"
                checked={archiveOriginal}
                onChange={(e) => setArchiveOriginal(e.target.checked)}
                className="semiont-form__checkbox"
                disabled={isCreating}
              />
              <label htmlFor="archiveOriginal" className="semiont-form__checkbox-label">
                {t.archiveOriginal}
              </label>
            </div>
          )}

          {/* Action Buttons */}
          <div className="semiont-form__actions">
            <button
              type="button"
              onClick={onCancel}
              disabled={isCreating}
              className={buttonStyles.tertiary.base}
            >
              {t.cancel}
            </button>
            <button
              type="submit"
              disabled={isCreating || !newResourceName.trim()}
              className={buttonStyles.primary.base}
            >
              {isCreating
                ? (isClone ? t.saving : isReferenceCompletion ? t.creatingAndLinking : t.creating)
                : (isClone ? t.saveClonedResource : isReferenceCompletion ? t.createAndLinkResource : t.createResource)}
            </button>
          </div>
        </form>
      </div>
      </div>

      {/* Right Sidebar - Panels and Toolbar */}
      <div className="semiont-page__sidebar">
        {/* Panels Container */}
        <ToolbarPanels
          activePanel={activePanel}
          theme={theme}
          onThemeChange={onThemeChange}
          showLineNumbers={showLineNumbers}
          onLineNumbersToggle={onLineNumbersToggle}
        />

        {/* Toolbar - Always visible on the right */}
        <Toolbar
          context="simple"
          activePanel={activePanel}
          onPanelToggle={onPanelToggle}
        />
      </div>
    </div>
  );
}
