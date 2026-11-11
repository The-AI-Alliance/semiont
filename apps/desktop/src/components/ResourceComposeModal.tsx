import { useEffect, useMemo, useRef, useState } from 'react';
import {
  HOVER_DELAY_MS,
  ResourceComposePage,
  useObservable,
  type ResourceComposePageProps,
} from '@semiont/react-ui';
import { extensionForMediaType } from '@semiont/core';
import type { UploadProgress } from '@semiont/sdk';
import type { ChatSession } from '../lib/session';
import { KbLocationPickerModal } from './KbLocationPickerModal';

const NoToolbarPanels: ResourceComposePageProps['ToolbarPanels'] = () => null;
const NoToolbar: ResourceComposePageProps['Toolbar'] = () => null;

export function ResourceComposeModal({
  session,
  onClose,
  onCreated,
}: {
  session: ChatSession;
  onClose: () => void;
  onCreated: (resourceId: string, name: string) => void;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [locationPickerDirectory, setLocationPickerDirectory] = useState<string | null>(null);
  const pendingDirectory = useRef<((directory: string | null) => void) | null>(null);
  const entityTypesState = useObservable(useMemo(() => session.client.browse.entityTypes(), [session]));
  const availableEntityTypes = entityTypesState?.status === 'ready' ? entityTypesState.value : [];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && uploadProgress === null && locationPickerDirectory === null) closeRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [uploadProgress, locationPickerDirectory]);

  useEffect(() => () => {
    pendingDirectory.current?.(null);
    pendingDirectory.current = null;
  }, []);

  const chooseStorageDirectory = (suggestedDirectory: string): Promise<string | null> => new Promise((resolve) => {
    pendingDirectory.current?.(null);
    pendingDirectory.current = resolve;
    setLocationPickerDirectory(suggestedDirectory);
  });

  const finishChoosingStorageDirectory = (directory: string | null) => {
    setLocationPickerDirectory(null);
    const resolve = pendingDirectory.current;
    pendingDirectory.current = null;
    resolve?.(directory);
  };

  const saveResource: ResourceComposePageProps['onSaveResource'] = async (params) => {
    const mediaType = params.format ?? 'text/markdown';
    const file = params.file ?? new File(
      [new Blob([params.content ?? ''], { type: mediaType })],
      `${params.name}${extensionForMediaType(mediaType)}`,
      { type: mediaType },
    );
    const format = params.charset && params.file === undefined ? `${mediaType}; charset=${params.charset}` : mediaType;

    try {
      const { resourceId } = await session.client.yield.resource({
        name: params.name,
        file,
        format,
        entityTypes: params.entityTypes ?? [],
        language: params.language,
        storageUri: params.storageUri,
      }).run((progress) => setUploadProgress(progress));
      setUploadProgress(null);
      // Let ResourceComposePage finish its own success state transition before the
      // parent closes this modal and unmounts it.
      window.setTimeout(() => onCreated(resourceId, params.name), 0);
    } catch (error) {
      setUploadProgress(null);
      throw error;
    }
  };

  return (
    <div className="modal modal--compose" onClick={() => uploadProgress === null && closeRef.current()}>
      <section
        className="compose-modal"
        role="dialog"
        aria-modal="true"
        aria-label="New document"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="config__close compose-modal__close"
          onClick={onClose}
          disabled={uploadProgress !== null}
          aria-label="Close new document"
        >
          ×
        </button>
        <ResourceComposePage
            mode="new"
            availableEntityTypes={availableEntityTypes}
            initialLocale="en"
            theme={document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'}
            hoverDelayMs={HOVER_DELAY_MS}
            activePanel={null}
            onSaveResource={saveResource}
            onCancel={onClose}
            onChooseStorageDirectory={chooseStorageDirectory}
            uploadProgress={uploadProgress}
            translations={{
              title: 'New Resource',
              titleEditClone: 'Clone Resource',
              subtitleClone: 'Create a copy of this resource.',
              resourceName: 'Resource name',
              resourceNamePlaceholder: 'Enter resource name…',
              entityTypes: 'Entity Type Tags',
              language: 'Language',
              contentSource: 'Content Source',
              uploadFile: 'Upload File',
              uploadFileDescription: 'Images, documents, and text files',
              writeContent: 'Write Content',
              writeContentDescription: 'Type or paste text',
              dropFileOrClick: 'Drop a file here or click to choose one',
              supportedFormats: 'Images, documents, and text files',
              mediaType: 'Media Type',
              autoDetected: 'Automatically detected',
              format: 'Format',
              content: 'Content',
              resourceContent: 'Resource Content',
              encoding: 'Encoding',
              archiveOriginal: 'Archive original resource',
              cancel: 'Cancel',
              saving: 'Saving…',
              creating: 'Creating…',
              saveClonedResource: 'Save Cloned Resource',
              createResource: 'Create Resource',
              chooseFolder: 'Choose folder…',
              locationHint: 'The resource name determines the filename. Choose a folder within this Knowledge Base.',
            }}
            ToolbarPanels={NoToolbarPanels}
            Toolbar={NoToolbar}
        />
      </section>
      {locationPickerDirectory !== null && (
        <KbLocationPickerModal
          session={session}
          initialDirectory={locationPickerDirectory}
          onChoose={finishChoosingStorageDirectory}
        />
      )}
    </div>
  );
}
