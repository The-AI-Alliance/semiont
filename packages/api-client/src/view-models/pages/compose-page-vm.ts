import { BehaviorSubject, type Observable, map } from 'rxjs';
import type { GatheredContext, AnnotationId, ContentFormat, AccessToken } from '@semiont/core';
import { resourceId as makeResourceId, annotationId as makeAnnotationId } from '@semiont/core';
import type { components } from '@semiont/core';
import { createDisposer } from '../lib/view-model';
import type { ViewModel } from '../lib/view-model';
import type { ShellVM } from '../flows/shell-vm';
import type { SemiontApiClient } from '../../client';
import { getPrimaryMediaType, decodeWithCharset } from '../../utils';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export type ComposeMode = 'new' | 'clone' | 'reference';

export interface ComposeParams {
  mode?: string | undefined;
  token?: string | undefined;
  annotationUri?: string | undefined;
  sourceDocumentId?: string | undefined;
  name?: string | undefined;
  entityTypes?: string | undefined;
  storedContext?: string | undefined;
}

export interface CloneData {
  sourceResource: ResourceDescriptor;
  sourceContent: string;
}

export interface ReferenceData {
  annotationUri: string;
  sourceDocumentId: string;
  name: string;
  entityTypes: string[];
}

export interface SaveResourceParams {
  mode: ComposeMode;
  name: string;
  storageUri: string;
  content?: string;
  file?: File;
  format?: string;
  charset?: string;
  entityTypes?: string[];
  language: string;
  archiveOriginal?: boolean;
  annotationUri?: string;
  sourceDocumentId?: string;
}

export interface ComposePageVM extends ViewModel {
  browse: ShellVM;
  mode$: Observable<ComposeMode>;
  loading$: Observable<boolean>;
  cloneData$: Observable<CloneData | null>;
  referenceData$: Observable<ReferenceData | null>;
  gatheredContext$: Observable<GatheredContext | null>;
  entityTypes$: Observable<string[]>;
  save(params: SaveResourceParams): Promise<string>;
}

export function createComposePageVM(
  client: SemiontApiClient,
  browse: ShellVM,
  params: ComposeParams,
  auth?: AccessToken,
): ComposePageVM {
  const disposer = createDisposer();
  disposer.add(browse);

  const isReferenceMode = Boolean(params.annotationUri && params.sourceDocumentId && params.name);
  const isCloneMode = params.mode === 'clone' && Boolean(params.token);
  const pageMode: ComposeMode = isCloneMode ? 'clone' : isReferenceMode ? 'reference' : 'new';

  const mode$ = new BehaviorSubject<ComposeMode>(pageMode);
  const loading$ = new BehaviorSubject<boolean>(true);
  const cloneData$ = new BehaviorSubject<CloneData | null>(null);
  const referenceData$ = new BehaviorSubject<ReferenceData | null>(null);
  const gatheredContext$ = new BehaviorSubject<GatheredContext | null>(null);

  const entityTypes$: Observable<string[]> = client.browse.entityTypes().pipe(
    map((e) => e ?? []),
  );

  // Initialize based on mode
  if (isReferenceMode) {
    const entityTypes = params.entityTypes ? params.entityTypes.split(',') : [];
    referenceData$.next({
      annotationUri: params.annotationUri!,
      sourceDocumentId: params.sourceDocumentId!,
      name: params.name!,
      entityTypes,
    });
    if (params.storedContext) {
      try { gatheredContext$.next(JSON.parse(params.storedContext)); } catch { /* ignore malformed */ }
    }
    loading$.next(false);
  } else if (isCloneMode) {
    void (async () => {
      try {
        const tokenResult = await client.yield.fromToken(params.token!);
        if (tokenResult && auth) {
          const rId = makeResourceId(tokenResult['@id']);
          const mediaType = getPrimaryMediaType(tokenResult) || 'text/plain';
          const { data } = await client.getResourceRepresentation(rId, {
            accept: mediaType as ContentFormat,
            auth,
          });
          const content = decodeWithCharset(data, mediaType);
          cloneData$.next({ sourceResource: tokenResult, sourceContent: content });
        }
      } catch {
        // Error handling is the consumer's responsibility (toast)
      }
      loading$.next(false);
    })();
  } else {
    loading$.next(false);
  }

  const save = async (saveParams: SaveResourceParams): Promise<string> => {
    if (saveParams.mode === 'clone') {
      const response = await client.yield.createFromToken({
        token: params.token!,
        name: saveParams.name,
        content: saveParams.content!,
        archiveOriginal: saveParams.archiveOriginal ?? true,
      });
      return response.resourceId;
    }

    let fileToUpload: File;
    let mimeType: string;

    if (saveParams.file) {
      fileToUpload = saveParams.file;
      mimeType = saveParams.format ?? 'application/octet-stream';
    } else {
      const blob = new Blob([saveParams.content || ''], { type: saveParams.format ?? 'application/octet-stream' });
      const extension = saveParams.format === 'text/plain' ? '.txt' : saveParams.format === 'text/html' ? '.html' : '.md';
      fileToUpload = new File([blob], saveParams.name + extension, { type: saveParams.format ?? 'application/octet-stream' });
      mimeType = saveParams.format ?? 'application/octet-stream';
    }

    const format = saveParams.charset && !saveParams.file ? `${mimeType}; charset=${saveParams.charset}` : mimeType;

    const response = await client.yield.resource({
      name: saveParams.name,
      file: fileToUpload,
      format,
      entityTypes: saveParams.entityTypes || [],
      language: saveParams.language,
      creationMethod: 'ui',
      storageUri: saveParams.storageUri,
    });

    const newResourceId = response.resourceId;

    if (saveParams.mode === 'reference' && saveParams.annotationUri && saveParams.sourceDocumentId) {
      await client.bind.body(
        makeResourceId(saveParams.sourceDocumentId),
        makeAnnotationId(saveParams.annotationUri) as AnnotationId,
        [{ op: 'add', item: { type: 'SpecificResource' as const, source: newResourceId, purpose: 'linking' as const } }],
      );
    }

    return newResourceId;
  };

  return {
    browse,
    mode$: mode$.asObservable(),
    loading$: loading$.asObservable(),
    cloneData$: cloneData$.asObservable(),
    referenceData$: referenceData$.asObservable(),
    gatheredContext$: gatheredContext$.asObservable(),
    entityTypes$,
    save,
    dispose: () => {
      mode$.complete();
      loading$.complete();
      cloneData$.complete();
      referenceData$.complete();
      gatheredContext$.complete();
      disposer.dispose();
    },
  };
}
