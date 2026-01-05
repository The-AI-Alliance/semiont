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
    <div className="flex flex-1 overflow-hidden">
      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-4 py-8 bg-white dark:bg-gray-900">
        {/* Page Title */}
        <div className="mb-8">
        <h1 className="text-2xl font-bold text-black dark:text-white">
          {isClone ? t.titleEditClone : isReferenceCompletion ? t.titleCompleteReference : t.title}
        </h1>
        {(isClone || isReferenceCompletion) && (
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            {isClone ? t.subtitleClone : t.subtitleReference}
          </p>
        )}
        {isReferenceCompletion && (
          <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-lg">
            <p className="text-sm text-blue-700 dark:text-blue-300">
              {t.linkedNoticePrefix}
            </p>
          </div>
        )}
      </div>

      {/* Create Form */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
        <form onSubmit={handleSaveResource} className="space-y-4">
          {/* Name */}
          <div className="flex items-center gap-4">
            <label htmlFor="docName" className="text-sm font-medium text-gray-700 dark:text-gray-300 w-32 shrink-0">
              {t.resourceName}
            </label>
            <input
              id="docName"
              type="text"
              value={newResourceName}
              onChange={(e) => setNewResourceName(e.target.value)}
              placeholder={t.resourceNamePlaceholder}
              className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
              required
              disabled={isCreating}
            />
          </div>

          {/* Entity Types Selection */}
          {(!isReferenceCompletion || selectedEntityTypes.length === 0) && (
            <div className="flex gap-4">
              <div className="text-sm font-medium text-gray-700 dark:text-gray-300 w-32 shrink-0 pt-2">
                {t.entityTypes}
              </div>
              <div
                className="flex flex-wrap gap-2 mb-2"
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
                      className={`px-3 py-1 rounded-full text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 ${
                        isSelected
                          ? 'bg-blue-600 text-white hover:bg-blue-700'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
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
            <div role="region" aria-labelledby="selected-entity-types-label">
              <h3 id="selected-entity-types-label" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t.entityTypes}
              </h3>
              <div className="flex flex-wrap gap-2" role="list">
                {selectedEntityTypes.map((type) => (
                  <span
                    key={type}
                    role="listitem"
                    className="px-3 py-1 rounded-full text-sm bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700"
                    aria-label={`Entity type: ${type}`}
                  >
                    {type}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400" id="reference-entity-types-description">
                These entity types were selected when creating the reference
              </p>
            </div>
          )}

          {/* Language Selector */}
          <div className="flex items-center gap-4">
            <label htmlFor="language-select" className="text-sm font-medium text-gray-700 dark:text-gray-300 w-32 shrink-0">
              {t.language}
            </label>
            <select
              id="language-select"
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
              disabled={isCreating}
              className="px-3 py-2 rounded-lg text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
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
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                {t.contentSource}
              </label>
              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => setInputMethod('upload')}
                  disabled={isCreating}
                  className={`flex-1 p-3 rounded-lg border-2 transition-colors ${
                    inputMethod === 'upload'
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-300 dark:border-gray-600 hover:border-blue-300 dark:hover:border-blue-700'
                  } ${isCreating ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="flex items-center justify-center gap-2 mb-1">
                    <span className="text-xl">📎</span>
                    <span className="font-medium text-gray-900 dark:text-white">{t.uploadFile}</span>
                  </div>
                  <div className="text-xs text-gray-600 dark:text-gray-400 text-center">
                    {t.uploadFileDescription}
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setInputMethod('write')}
                  disabled={isCreating}
                  className={`flex-1 p-3 rounded-lg border-2 transition-colors ${
                    inputMethod === 'write'
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-300 dark:border-gray-600 hover:border-blue-300 dark:hover:border-blue-700'
                  } ${isCreating ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="flex items-center justify-center gap-2 mb-1">
                    <span className="text-xl">✍️</span>
                    <span className="font-medium text-gray-900 dark:text-white">{t.writeContent}</span>
                  </div>
                  <div className="text-xs text-gray-600 dark:text-gray-400 text-center">
                    {t.writeContentDescription}
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* Upload File Section */}
          {!isClone && !isReferenceCompletion && inputMethod === 'upload' && (
            <div className="space-y-4">
              <div>
                <div className="flex items-center gap-4">
                  <label className="flex-1 cursor-pointer">
                    <div className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-6 text-center hover:border-blue-500 dark:hover:border-blue-400 transition-colors">
                      <input
                        type="file"
                        accept="text/plain,text/markdown,image/png,image/jpeg"
                        onChange={handleFileUpload}
                        className="hidden"
                        disabled={isCreating}
                      />
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {uploadedFile ? uploadedFile.name : t.dropFileOrClick}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
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
                      className="px-3 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700"
                      disabled={isCreating}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Media Type Display - Auto-detected */}
              {uploadedFile && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-gray-600 dark:text-gray-400">{t.mediaType}:</span>
                  <code className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-gray-900 dark:text-gray-100">
                    {fileMimeType}
                  </code>
                  <span className="text-gray-500" title={t.autoDetected}>🔒</span>
                </div>
              )}

              {/* Image Preview */}
              {uploadedFile && filePreviewUrl && isImageMimeType(fileMimeType) && (
                <div className="border border-gray-300 dark:border-gray-600 rounded-lg p-4">
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Preview:</p>
                  <div className="max-h-96 overflow-hidden rounded">
                    <img
                      src={filePreviewUrl}
                      alt="Upload preview"
                      className="max-w-full h-auto"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Write Content Section */}
          {(isClone || isReferenceCompletion || inputMethod === 'write') && (
            <div className="space-y-4">
              {/* Format Selector - only for manual entry, not clones */}
              {!isClone && !isReferenceCompletion && (
                <div className="flex items-center gap-4">
                  <label htmlFor="format-select" className="text-sm font-medium text-gray-700 dark:text-gray-300 w-32 shrink-0">
                    {t.format}
                  </label>
                  <select
                    id="format-select"
                    value={selectedFormat}
                    onChange={(e) => setSelectedFormat(e.target.value)}
                    disabled={isCreating}
                    className="px-3 py-2 rounded-lg text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
                  >
                    <option value="text/markdown">Markdown (text/markdown)</option>
                    <option value="text/plain">Plain Text (text/plain)</option>
                    <option value="text/html">HTML (text/html)</option>
                  </select>
                </div>
              )}

              {/* Content Editor */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  {isClone ? t.resourceContent : t.content}
                </label>
                <div className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden">
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
                <div className="flex items-center gap-4">
                  <label htmlFor="charset-select" className="text-sm font-medium text-gray-700 dark:text-gray-300 w-32 shrink-0">
                    {t.encoding}
                  </label>
                  <select
                    id="charset-select"
                    value={selectedCharset}
                    onChange={(e) => setSelectedCharset(e.target.value)}
                    disabled={isCreating}
                    className="px-3 py-2 rounded-lg text-sm border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
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
            <div className="flex items-center">
              <input
                id="archiveOriginal"
                type="checkbox"
                checked={archiveOriginal}
                onChange={(e) => setArchiveOriginal(e.target.checked)}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                disabled={isCreating}
              />
              <label htmlFor="archiveOriginal" className="ml-2 text-sm text-gray-700 dark:text-gray-300">
                {t.archiveOriginal}
              </label>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-4 justify-end">
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
      <div className="flex">
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
