import { BehaviorSubject, type Observable } from 'rxjs';
import type { AccessToken, ResourceDescriptor, ResourceId } from '@semiont/core';
import { resourceId as makeResourceId } from '@semiont/core';
import { createDisposer } from '@semiont/sdk';
import type { StateUnit } from '@semiont/core';
import type { ShellStateUnit } from '../../../state/shell-state-unit';
import { trackList, type ListState } from '../../../state/list-state';
import type { SemiontSession } from '@semiont/sdk';
import { decodeWithCharset, extensionForMediaType } from '@semiont/core';
import type { UploadProgress } from '@semiont/sdk';

export type ComposeMode = 'new' | 'clone';

export interface ComposeParams {
  mode?: string | undefined;
  token?: string | undefined;
}

export interface CloneData {
  sourceResource: ResourceDescriptor;
  sourceContent: string;
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
}

export interface ComposePageStateUnit extends StateUnit {
  browse: ShellStateUnit;
  mode$: Observable<ComposeMode>;
  loading$: Observable<boolean>;
  cloneData$: Observable<CloneData | null>;
  entityTypes: ListState<string[]>;
  /**
   * Live upload-progress for the in-flight `save(...)` call. Emits the
   * full `UploadProgress` lifecycle (started → finished) while a save is
   * underway; resets to `null` between saves and after completion. UI
   * components can subscribe to render an upload-in-progress indicator.
   */
  uploadProgress$: Observable<UploadProgress | null>;
  save(params: SaveResourceParams): Promise<string>;
}

export function createComposePageStateUnit(
  session: SemiontSession,
  browse: ShellStateUnit,
  params: ComposeParams,
  auth?: AccessToken,
): ComposePageStateUnit {
  const { client } = session;
  const disposer = createDisposer();
  // `browse` (ShellStateUnit) is a *passed-in* dependency owned by the caller
  // (`useShellStateUnit`), not this unit — do NOT add it to the disposer (it's the
  // shared, app-scoped shell). See packages/sdk/docs/STATE-UNITS.md (composition rule).

  const isCloneMode = params.mode === 'clone' && Boolean(params.token);
  const pageMode: ComposeMode = isCloneMode ? 'clone' : 'new';

  const mode$ = new BehaviorSubject<ComposeMode>(pageMode);
  const loading$ = new BehaviorSubject<boolean>(true);
  const cloneData$ = new BehaviorSubject<CloneData | null>(null);
  const uploadProgress$ = new BehaviorSubject<UploadProgress | null>(null);

  const entityTypes = trackList<string[]>(() => client.browse.entityTypes(), []);
  disposer.add(entityTypes.dispose);

  // Initialize based on mode
  if (isCloneMode) {
    void (async () => {
      try {
        const tokenResult = await client.yield.fromToken(params.token!);
        if (tokenResult && auth) {
          const rId = makeResourceId(tokenResult['@id']);
          const { data, contentType } = await client.browse.resourceRepresentation(rId);
          const content = decodeWithCharset(data, contentType);
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
      const extension = extensionForMediaType(saveParams.format ?? 'application/octet-stream');
      fileToUpload = new File([blob], saveParams.name + extension, { type: saveParams.format ?? 'application/octet-stream' });
      mimeType = saveParams.format ?? 'application/octet-stream';
    }

    const format = saveParams.charset && !saveParams.file ? `${mimeType}; charset=${saveParams.charset}` : mimeType;

    // Subscribe to the upload's full progress lifecycle so the UI can
    // render an upload-in-progress indicator. Resolve the save() promise
    // on the `finished` event and clear the progress signal on completion
    // (success or error).
    const newResourceId = await new Promise<ResourceId>((resolve, reject) => {
      client.yield.resource({
        name: saveParams.name,
        file: fileToUpload,
        format,
        entityTypes: saveParams.entityTypes || [],
        language: saveParams.language,
        storageUri: saveParams.storageUri,
      }).subscribe({
        next: (event) => {
          uploadProgress$.next(event);
          if (event.phase === 'finished') resolve(event.resourceId);
        },
        error: (err) => {
          uploadProgress$.next(null);
          reject(err);
        },
        complete: () => uploadProgress$.next(null),
      });
    });

    return newResourceId;
  };

  return {
    browse,
    mode$: mode$.asObservable(),
    loading$: loading$.asObservable(),
    cloneData$: cloneData$.asObservable(),
    entityTypes: entityTypes.state,
    uploadProgress$: uploadProgress$.asObservable(),
    save,
    dispose: () => {
      mode$.complete();
      loading$.complete();
      cloneData$.complete();
      uploadProgress$.complete();
      disposer.dispose();
    },
  };
}
