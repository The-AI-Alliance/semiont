"use client";

import React, { useState, useEffect, Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/routing';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useResources, useAnnotations, useEntityTypes } from '@/lib/api-hooks';
import { buttonStyles } from '@/lib/button-styles';
import { useToast } from '@/components/Toast';
import { useTheme } from '@/hooks/useTheme';
import { useToolbar } from '@/hooks/useToolbar';
import { useLineNumbers } from '@/hooks/useLineNumbers';
import { getPrimaryMediaType } from '@semiont/api-client';
import { resourceUri, resourceAnnotationUri, type ResourceUri, type ResourceAnnotationUri } from '@semiont/api-client';
import { Toolbar } from '@/components/Toolbar';
import { ToolbarPanels } from '@/components/toolbar/ToolbarPanels';
import { CodeMirrorRenderer } from '@/components/CodeMirrorRenderer';

function ComposeDocumentContent() {
  const t = useTranslations('Compose');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const { showError, showSuccess } = useToast();
  const mode = searchParams?.get('mode');
  const tokenFromUrl = searchParams?.get('token');
  
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

  // Toolbar and settings state
  const { activePanel, togglePanel } = useToolbar();
  const { theme, setTheme } = useTheme();
  const { showLineNumbers, toggleLineNumbers } = useLineNumbers();

  // API hooks
  const resources = useResources();
  const annotations = useAnnotations();
  const entityTypesAPI = useEntityTypes();

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
        if (cloneData.sourceResource && session?.backendToken) {
          setIsClone(true);
          setCloneToken(tokenFromUrl || null);
          setNewDocName(cloneData.sourceResource.name);

          // Fetch representation separately
          try {
            const idString = cloneData.sourceResource.id as string;
            if (!idString) {
              throw new Error('Source resource has no ID');
            }
            const rUri = resourceUri(idString);
            // Get the primary representation's mediaType from the source resource
            const mediaType = getPrimaryMediaType(cloneData.sourceResource) || 'text/plain';

            const contentResponse = await fetch(rUri, {
              headers: {
                'Authorization': `Bearer ${session.backendToken}`,
                'Accept': mediaType,
              },
            });

            if (contentResponse.ok) {
              const content = await contentResponse.text();
              setNewDocContent(content);
            } else {
              showError('Failed to load document representation');
            }
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

        const resId = response.resource?.id as string;
        if (!resId) {
          throw new Error('No resource ID returned from server');
        }
        rUri = resourceUri(resId);
      } else {
        // Create a new resource with entity types
        const response = await createDocMutation.mutateAsync({
          name: newDocName,
          content: newDocContent,
          format: 'text/markdown',
          entityTypes: selectedEntityTypes,
          creationMethod: 'ui'
        });

        const resId = response.resource?.id as string;
        if (!resId) {
          throw new Error('No resource ID returned from server');
        }
        rUri = resourceUri(resId);

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

      // Navigate to the new resource (will add to tabs on page load)
      router.push(`/know/resource/${encodeURIComponent(rUri)}`);
    } catch (error) {
      console.error('Failed to save document:', error);
      showError('Failed to save document. Please try again.');
    } finally {
      setIsCreating(false);
    }
  };

  if (isLoading) {
    return (
      <div className="px-4 py-8">
        <div className="flex items-center justify-center py-20">
          <p className="text-gray-600 dark:text-gray-300">
            Loading cloned document...
          </p>
        </div>
      </div>
    );
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
        <form onSubmit={handleSaveDocument} className="space-y-6">
          <div>
            <label htmlFor="docName" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('resourceName')}
            </label>
            <input
              id="docName"
              type="text"
              value={newDocName}
              onChange={(e) => setNewDocName(e.target.value)}
              placeholder={t('resourceNamePlaceholder')}
              className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
              required
              disabled={isCreating}
            />
          </div>

          {/* Entity Types Selection */}
          {(!isReferenceCompletion || selectedEntityTypes.length === 0) && (
            <fieldset>
              <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                {t('entityTypes')}
              </legend>
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
            </fieldset>
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

          {/* Content editor */}
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