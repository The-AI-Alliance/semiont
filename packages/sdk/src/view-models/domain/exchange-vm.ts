import { BehaviorSubject, lastValueFrom, type Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { createDisposer } from '../lib/view-model';
import type { ViewModel } from '../lib/view-model';
import type { ShellVM } from '../flows/shell-vm';
import type { BackendDownload, ProgressEvent } from '@semiont/core';

export interface ImportPreview {
  format: string;
  version: number;
  sourceUrl: string;
  stats: Record<string, number>;
}

export interface ExchangeVM extends ViewModel {
  browse: ShellVM;
  selectedFile$: Observable<File | null>;
  preview$: Observable<ImportPreview | null>;
  importPhase$: Observable<string | null>;
  importMessage$: Observable<string | undefined>;
  importResult$: Observable<Record<string, unknown> | undefined>;
  isExporting$: Observable<boolean>;
  isImporting$: Observable<boolean>;
  selectFile(file: File): void;
  cancelImport(): void;
  doExport(): Promise<{ blob: Blob; filename: string }>;
  doImport(): Promise<void>;
}

export function createExchangeVM(
  browse: ShellVM,
  exportFn: (params?: { includeArchived?: boolean }) => Promise<BackendDownload>,
  importFn: (file: File) => Observable<ProgressEvent>,
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

  const doExport = async (): Promise<{ blob: Blob; filename: string }> => {
    isExporting$.next(true);
    try {
      const download = await exportFn();
      // Wrap the stream in a Response purely as a Blob-collection helper —
      // BackendDownload itself carries no fetch dependency.
      const blob = await new Response(download.stream).blob();
      const filename = download.filename ?? `semiont-export-${Date.now()}.tar.gz`;
      return { blob, filename };
    } finally {
      isExporting$.next(false);
    }
  };

  const doImport = async (): Promise<void> => {
    const file = selectedFile$.getValue();
    if (!file) return;
    isImporting$.next(true);
    importPhase$.next('started');
    importMessage$.next(undefined);
    importResult$.next(undefined);
    try {
      // The importFn is `Observable<ProgressEvent>` — every emit is a
      // progress event; the final emit before complete is the outcome.
      // `tap` mirrors each event into our state subjects; `lastValueFrom`
      // awaits the last value (so callers can `await vm.doImport()`).
      await lastValueFrom(
        importFn(file).pipe(
          tap((event) => {
            importPhase$.next(event.phase);
            importMessage$.next(event.message);
            if (event.result) importResult$.next(event.result);
          }),
        ),
      );
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
