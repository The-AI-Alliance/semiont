import { BehaviorSubject, type Observable } from 'rxjs';
import type { AccessToken } from '@semiont/core';
import { createDisposer } from '../lib/view-model';
import type { ViewModel } from '../lib/view-model';
import type { BrowseVM } from '../flows/browse-vm';

export interface ImportPreview {
  format: string;
  version: number;
  sourceUrl: string;
  stats: Record<string, number>;
}

export interface ExchangeVM extends ViewModel {
  browse: BrowseVM;
  selectedFile$: Observable<File | null>;
  preview$: Observable<ImportPreview | null>;
  importPhase$: Observable<string | null>;
  importMessage$: Observable<string | undefined>;
  importResult$: Observable<Record<string, unknown> | undefined>;
  isExporting$: Observable<boolean>;
  isImporting$: Observable<boolean>;
  selectFile(file: File): void;
  cancelImport(): void;
  doExport(auth: AccessToken): Promise<{ blob: Blob; filename: string }>;
  doImport(auth: AccessToken): Promise<void>;
}

export function createExchangeVM(
  browse: BrowseVM,
  exportFn: (params: { includeArchived?: boolean } | undefined, options: { auth: AccessToken }) => Promise<Response>,
  importFn: (file: File, options: { auth: AccessToken; onProgress?: (event: { phase: string; message?: string; result?: Record<string, unknown> }) => void }) => Promise<{ phase: string; message?: string; result?: Record<string, unknown> }>,
): ExchangeVM {
  const disposer = createDisposer();
  disposer.add(browse);

  const selectedFile$ = new BehaviorSubject<File | null>(null);
  const preview$ = new BehaviorSubject<ImportPreview | null>(null);
  const importPhase$ = new BehaviorSubject<string | null>(null);
  const importMessage$ = new BehaviorSubject<string | undefined>(undefined);
  const importResult$ = new BehaviorSubject<Record<string, unknown> | undefined>(undefined);
  const isExporting$ = new BehaviorSubject<boolean>(false);
  const isImporting$ = new BehaviorSubject<boolean>(false);

  const selectFile = (file: File): void => {
    selectedFile$.next(file);
    importPhase$.next(null);
    importMessage$.next(undefined);
    importResult$.next(undefined);
    preview$.next({
      format: file.name.endsWith('.tar.gz') || file.name.endsWith('.gz') ? 'semiont-linked-data' : 'unknown',
      version: 1,
      sourceUrl: '',
      stats: {} as Record<string, number>,
    });
  };

  const cancelImport = (): void => {
    selectedFile$.next(null);
    preview$.next(null);
    importPhase$.next(null);
    importMessage$.next(undefined);
    importResult$.next(undefined);
  };

  const doExport = async (auth: AccessToken): Promise<{ blob: Blob; filename: string }> => {
    isExporting$.next(true);
    try {
      const response = await exportFn(undefined, { auth });
      if (!response.ok) throw new Error(`Export failed: ${response.status} ${response.statusText}`);
      const blob = await response.blob();
      const contentDisposition = response.headers.get('Content-Disposition');
      const filename = contentDisposition?.match(/filename="(.+?)"/)?.[1]
        ?? `semiont-export-${Date.now()}.tar.gz`;
      return { blob, filename };
    } finally {
      isExporting$.next(false);
    }
  };

  const doImport = async (auth: AccessToken): Promise<void> => {
    const file = selectedFile$.getValue();
    if (!file) return;
    isImporting$.next(true);
    importPhase$.next('started');
    importMessage$.next(undefined);
    importResult$.next(undefined);
    try {
      await importFn(file, {
        auth,
        onProgress: (event) => {
          importPhase$.next(event.phase);
          importMessage$.next(event.message);
          if (event.result) importResult$.next(event.result);
        },
      });
    } finally {
      isImporting$.next(false);
    }
  };

  return {
    browse,
    selectedFile$: selectedFile$.asObservable(),
    preview$: preview$.asObservable(),
    importPhase$: importPhase$.asObservable(),
    importMessage$: importMessage$.asObservable(),
    importResult$: importResult$.asObservable(),
    isExporting$: isExporting$.asObservable(),
    isImporting$: isImporting$.asObservable(),
    selectFile,
    cancelImport,
    doExport,
    doImport,
    dispose: () => {
      selectedFile$.complete();
      preview$.complete();
      importPhase$.complete();
      importMessage$.complete();
      importResult$.complete();
      isExporting$.complete();
      isImporting$.complete();
      disposer.dispose();
    },
  };
}
