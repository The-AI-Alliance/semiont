"use client";

import React, { useState, useEffect, Suspense } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useResources, useAnnotations, useEntityTypes, useApiClient } from '@/lib/api-hooks';
import { buttonStyles } from '@/lib/button-styles';
import { useToast } from '@/components/Toast';
import { useTheme } from '@/hooks/useTheme';
import { useToolbar } from '@/hooks/useToolbar';
import { useLineNumbers } from '@/hooks/useLineNumbers';
import { getPrimaryMediaType, getResourceId, isImageMimeType, resourceUri, resourceAnnotationUri, type ResourceUri, type ContentFormat, LOCALES } from '@semiont/api-client';
import { Toolbar } from '@/components/Toolbar';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { CodeMirrorRenderer } from '@/components/CodeMirrorRenderer';

function ComposeDocumentContent() {
  const t = useTranslations('Compose');
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, status } = useSession();
  const { showError, showSuccess } = useToast();
  const mode = searchParams?.get('mode');
  const tokenFromUrl = searchParams?.get('token');

  // Authentication guard - redirect to home if not authenticated
  useEffect(() => {
    if (status === 'loading') return; // Still checking auth
    if (!session?.backendToken) {
      router.push('/');
    }
  }, [session, status, router]);
  
  // Reference completion parameters
  const referenceId = searchParams?.get('referenceId');
  const sourceDocumentId = searchParams?.get('sourceDocumentId');
  const nameFromUrl = searchParams?.get('name');
  const entityTypesFromUrl = searchParams?.get('entityTypes');
  
  const [newDocName, setNewDocName] = useState('');
  const [newDocContent, setNewDocContent] = useState('');
  const [selectedEntityTypes, setSelectedEntityTypes] = useState<string[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isClone, setIsClone] = useState(false);
  const [cloneToken, setCloneToken] = useState<string | null>(null);
  const [archiveOriginal, setArchiveOriginal] = useState(true);
  const [isReferenceCompletion, setIsReferenceCompletion] = useState(false);

  // Content input method selection
  const [inputMethod, setInputMethod] = useState<'upload' | 'write'>('write');

  // File upload state
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [fileMimeType, setFileMimeType] = useState<string>('text/markdown');
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);

  // Format selection for manual content entry
  const [selectedFormat, setSelectedFormat] = useState<string>('text/markdown');

  // Language selection - default to current user locale
  const [selectedLanguage, setSelectedLanguage] = useState<string>(locale);

  // Character encoding selection - default to UTF-8 (empty string means use default)
  const [selectedCharset, setSelectedCharset] = useState<string>('');

  // Toolbar and settings state
  const { activePanel, togglePanel } = useToolbar();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  // API hooks
  const resources = useResources();
  const annotations = useAnnotations();
  const entityTypesAPI = useEntityTypes();
  const client = useApiClient();

  // Fetch available entity types
  const { data: entityTypesData } = entityTypesAPI.list.useQuery();
  const availableEntityTypes = (entityTypesData as { entityTypes: string[] } | undefined)?.entityTypes || [];

  // Set up mutation hooks
  const createDocMutation = resources.create.useMutation();
  const updateAnnotationBodyMutation = annotations.updateBody.useMutation();

  // Fetch cloned document data if in clone mode
  const { data: cloneData } = resources.getByToken.useQuery(tokenFromUrl || '');
  const createFromTokenMutation = resources.createFromToken.useMutation();

  // Load cloned document data if in clone mode or pre-fill reference completion data
  useEffect(() => {
    const loadInitialData = async () => {
      // Handle reference completion mode
      if (referenceId && sourceDocumentId && nameFromUrl) {
        setIsReferenceCompletion(true);
        setNewDocName(nameFromUrl);
        const entityTypes = entityTypesFromUrl ? entityTypesFromUrl.split(',') : [];
        if (entityTypes.length > 0) {
          setSelectedEntityTypes(entityTypes);
        }

        setIsLoading(false);
        return;
      }
      
      // Handle clone mode - data loaded via React Query
      if (mode === 'clone' && cloneData) {
        if (cloneData.sourceResource && client) {
          setIsClone(true);
          setCloneToken(tokenFromUrl || null);
          setNewDocName(cloneData.sourceResource.name);

          // Fetch representation separately
          try {
            // Use the canonical URI from the resource descriptor
            const rUri = resourceUri(cloneData.sourceResource['@id']);
            // Get the primary representation's mediaType from the source resource
            const mediaType = getPrimaryMediaType(cloneData.sourceResource) || 'text/plain';

            // Use api-client for W3C content negotiation
            const { data } = await client.getResourceRepresentation(rUri as ResourceUri, {
              accept: mediaType as ContentFormat,
            });
            // Decode ArrayBuffer to string
            const content = new TextDecoder().decode(data);
            setNewDocContent(content);
          } catch (error) {
            console.error('Failed to fetch representation:', error);
            showError('Failed to load document representation');
          }
        } else {
          showError('Invalid or expired clone token');
          router.push('/know/discover');
        }
        setIsLoading(false);
      } else if (mode === 'clone' && !tokenFromUrl) {
        showError('Clone token not found. Please try cloning again.');
        router.push('/know/discover');
      } else {
        setIsLoading(false);
      }
    };

    loadInitialData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, tokenFromUrl, cloneData, referenceId, sourceDocumentId, nameFromUrl, entityTypesFromUrl, session?.backendToken]);

  // Handle file upload
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate MIME type - only allow our 4 supported types
    const allowedTypes = ['text/plain', 'text/markdown', 'image/png', 'image/jpeg'];
    if (!allowedTypes.includes(file.type)) {
      showError(`Unsupported file type: ${file.type}. Please upload text/plain, text/markdown, image/png, or image/jpeg files.`);
      return;
    }

    setUploadedFile(file);
    setFileMimeType(file.type);
    setInputMethod('upload'); // Switch to upload mode

    // Set file name as default resource name if empty
    if (!newDocName) {
      const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
      setNewDocName(nameWithoutExt);
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
        setNewDocContent(content);
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

  const handleSaveDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocName.trim()) return;

    setIsCreating(true);
    try {
      let rUri: ResourceUri;

      if (isClone && cloneToken) {
        // Create resource from clone token with edited content
        const response = await createFromTokenMutation.mutateAsync({
          token: cloneToken,
          name: newDocName,
          content: newDocContent,
          archiveOriginal: archiveOriginal
        });

        if (!response.resource?.['@id']) {
          throw new Error('No resource URI returned from server');
        }
        // Use the canonical URI from the API response
        rUri = resourceUri(response.resource['@id']);
      } else {
        // Create a new resource with entity types
        // Prepare file for upload
        let fileToUpload: File;
        let mimeType: string;

        if (uploadedFile) {
          // Use uploaded file
          fileToUpload = uploadedFile;
          mimeType = fileMimeType;
        } else {
          // Create File from text content using selected format
          const blob = new Blob([newDocContent], { type: selectedFormat });
          const extension = selectedFormat === 'text/plain' ? '.txt' : selectedFormat === 'text/html' ? '.html' : '.md';
          fileToUpload = new File([blob], newDocName + extension, { type: selectedFormat });
          mimeType = selectedFormat;
        }

        // Construct format with charset if specified (only for text types)
        const format = selectedCharset && !uploadedFile ? `${mimeType}; charset=${selectedCharset}` : mimeType;

        const response = await createDocMutation.mutateAsync({
          name: newDocName,
          file: fileToUpload,
          format,
          entityTypes: selectedEntityTypes,
          language: selectedLanguage,
          creationMethod: 'ui'
        });

        if (!response.resource?.['@id']) {
          throw new Error('No resource URI returned from server');
        }
        // Use the canonical URI from the API response
        rUri = resourceUri(response.resource['@id']);

        // If this is a reference completion, update the reference to point to the new resource
        if (isReferenceCompletion && referenceId && rUri && sourceDocumentId) {
          try {
            // Construct ResourceAnnotationUri from sourceDocumentId and referenceId
            const annotationUri = resourceAnnotationUri(`${sourceDocumentId}/annotations/${referenceId}`);

            await updateAnnotationBodyMutation.mutateAsync({
              annotationUri,
              data: {
                resourceId: sourceDocumentId,
                operations: [{
                  op: 'add',
                  item: {
                    type: 'SpecificResource',
                    source: rUri,
                    purpose: 'linking'
                  }
                }]
              }
            });
            showSuccess('Reference successfully linked to the new resource');
          } catch (error) {
            console.error('Failed to update reference:', error);
            // Don't fail the whole operation, just log the error
            showError('Resource created but failed to update reference. You may need to manually link it.');
          }
        }
      }

      // Navigate to the new resource using just the ID (browser URLs use clean IDs)
      // Use getResourceId to extract the ID from the canonical URI
      const resourceId = getResourceId({ '@id': rUri } as any);
      if (!resourceId) {
        throw new Error('Failed to extract resource ID from URI');
      }
      router.push(`/know/resource/${encodeURIComponent(resourceId)}`);
    } catch (error) {
      console.error('Failed to save document:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to save document. Please try again.';
      showError(errorMessage);
    } finally {
      setIsCreating(false);
    }
  };

  // Show loading state while checking authentication or loading clone data
  if (status === 'loading' || isLoading) {
    return (
      <div className="px-4 py-8">
        <div className="flex items-center justify-center py-20">
          <p className="text-gray-600 dark:text-gray-300">
            {status === 'loading' ? 'Checking authentication...' : 'Loading cloned document...'}
          </p>
        </div>
      </div>
    );
  }

  // Don't render form if not authenticated (will redirect in useEffect)
  if (!session?.backendToken) {
    return null;
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto px-4 py-8 bg-white dark:bg-gray-900">
        {/* Page Title */}
        <div className="mb-8">
        <h1 className="text-2xl font-bold text-black dark:text-white">
          {isClone ? t('titleEditClone') : isReferenceCompletion ? t('titleCompleteReference') : t('title')}
        </h1>
        {(isClone || isReferenceCompletion) && (
          <p className="mt-2 text-gray-600 dark:text-gray-400">
            {isClone ? t('subtitleClone') : t('subtitleReference')}
          </p>
        )}
        {isReferenceCompletion && (
          <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-700 rounded-lg">
            <p className="text-sm text-blue-700 dark:text-blue-300">
              {t('linkedNoticePrefix')}
            </p>
          </div>
        )}
      </div>

      {/* Create Form */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700 p-6">
        <form onSubmit={handleSaveDocument} className="space-y-4">
          {/* Name */}
          <div className="flex items-center gap-4">
            <label htmlFor="docName" className="text-sm font-medium text-gray-700 dark:text-gray-300 w-32 shrink-0">
              {t('resourceName')}
            </label>
            <input
              id="docName"
              type="text"
              value={newDocName}
              onChange={(e) => setNewDocName(e.target.value)}
              placeholder={t('resourceNamePlaceholder')}
              className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
              required
              disabled={isCreating}
            />
          </div>

          {/* Entity Types Selection */}
          {(!isReferenceCompletion || selectedEntityTypes.length === 0) && (
            <div className="flex gap-4">
              <div className="text-sm font-medium text-gray-700 dark:text-gray-300 w-32 shrink-0 pt-2">
                {t('entityTypes')}
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
                {t('entityTypes')}
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
              {t('language')}
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
                {t('contentSource')}
              </label>
              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => setInputMethod('upload')}
                  disabled={isCreating}
                  className={`flex-1 p-4 rounded-lg border-2 transition-colors ${
                    inputMethod === 'upload'
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-300 dark:border-gray-600 hover:border-blue-300 dark:hover:border-blue-700'
                  } ${isCreating ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="text-2xl mb-2">📎</div>
                  <div className="font-medium text-gray-900 dark:text-white">{t('uploadFile')}</div>
                  <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                    {t('uploadFileDescription')}
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setInputMethod('write')}
                  disabled={isCreating}
                  className={`flex-1 p-4 rounded-lg border-2 transition-colors ${
                    inputMethod === 'write'
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-300 dark:border-gray-600 hover:border-blue-300 dark:hover:border-blue-700'
                  } ${isCreating ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <div className="text-2xl mb-2">✍️</div>
                  <div className="font-medium text-gray-900 dark:text-white">{t('writeContent')}</div>
                  <div className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                    {t('writeContentDescription')}
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
                        {uploadedFile ? uploadedFile.name : t('dropFileOrClick')}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                        {t('supportedFormats')}
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
                  <span className="text-gray-600 dark:text-gray-400">{t('mediaType')}:</span>
                  <code className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-gray-900 dark:text-gray-100">
                    {fileMimeType}
                  </code>
                  <span className="text-gray-500" title={t('autoDetected')}>🔒</span>
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
                    {t('format')}
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
                  {isClone ? t('resourceContent') : t('content')}
                </label>
                <div className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden">
                  <CodeMirrorRenderer
                    content={newDocContent}
                    segments={[]}
                    editable={!isCreating}
                    sourceView={true}
                    showLineNumbers={showLineNumbers}
                    onChange={(newContent) => setNewDocContent(newContent)}
                  />
                </div>
              </div>

              {/* Encoding Selector - only for manual text entry */}
              {!isClone && !isReferenceCompletion && (
                <div className="flex items-center gap-4">
                  <label htmlFor="charset-select" className="text-sm font-medium text-gray-700 dark:text-gray-300 w-32 shrink-0">
                    {t('encoding')}
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
                {t('archiveOriginal')}
              </label>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex gap-4 justify-end">
            <button
              type="button"
              onClick={() => router.push('/know/discover')}
              disabled={isCreating}
              className={buttonStyles.tertiary.base}
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              disabled={isCreating || !newDocName.trim()}
              className={buttonStyles.primary.base}
            >
              {isCreating
                ? (isClone ? t('saving') : isReferenceCompletion ? t('creatingAndLinking') : t('creating'))
                : (isClone ? t('saveClonedResource') : isReferenceCompletion ? t('createAndLinkResource') : t('createResource'))}
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
          onThemeChange={setTheme}
          showLineNumbers={showLineNumbers}
          onLineNumbersToggle={toggleLineNumbers}
        />

        {/* Toolbar - Always visible on the right */}
        <Toolbar
          context="simple"
          activePanel={activePanel}
          onPanelToggle={togglePanel}
        />
      </div>
    </div>
  );
}

export default function ComposeDocumentPage() {
  const t = useTranslations('Compose');

  return (
    <Suspense fallback={
      <div className="px-4 py-8">
        <div className="flex items-center justify-center py-20">
          <p className="text-gray-600 dark:text-gray-300">{t('loading')}</p>
        </div>
      </div>
    }>
      <ComposeDocumentContent />
    </Suspense>
  );
}