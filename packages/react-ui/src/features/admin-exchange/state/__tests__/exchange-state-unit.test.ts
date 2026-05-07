import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom, of, throwError } from 'rxjs';
import type { ShellStateUnit } from '../../../../state/shell-state-unit';
import { createExchangeStateUnit } from '../exchange-state-unit';

function mockBrowse(): ShellStateUnit {
  return { dispose: vi.fn() } as unknown as ShellStateUnit;
}

function makeMockFile(name: string): File {
  return new File(['content'], name, { type: 'application/gzip' });
}

describe('createExchangeStateUnit', () => {
  it('initializes with null/empty state', async () => {
    const stateUnit = createExchangeStateUnit(mockBrowse(), vi.fn(), vi.fn());

    expect(await firstValueFrom(stateUnit.selectedFile$)).toBeNull();
    expect(await firstValueFrom(stateUnit.preview$)).toBeNull();
    expect(await firstValueFrom(stateUnit.importPhase$)).toBeNull();
    expect(await firstValueFrom(stateUnit.isExporting$)).toBe(false);
    expect(await firstValueFrom(stateUnit.isImporting$)).toBe(false);

    stateUnit.dispose();
  });

  it('selectFile sets file and generates preview', async () => {
    const stateUnit = createExchangeStateUnit(mockBrowse(), vi.fn(), vi.fn());

    stateUnit.selectFile(makeMockFile('backup.tar.gz'));

    const file = await firstValueFrom(stateUnit.selectedFile$);
    expect(file?.name).toBe('backup.tar.gz');

    const preview = await firstValueFrom(stateUnit.preview$);
    expect(preview?.format).toBe('semiont-linked-data');

    stateUnit.dispose();
  });

  it('selectFile detects unknown format', async () => {
    const stateUnit = createExchangeStateUnit(mockBrowse(), vi.fn(), vi.fn());

    stateUnit.selectFile(makeMockFile('data.json'));

    const preview = await firstValueFrom(stateUnit.preview$);
    expect(preview?.format).toBe('unknown');

    stateUnit.dispose();
  });

  it('cancelImport resets all state', async () => {
    const stateUnit = createExchangeStateUnit(mockBrowse(), vi.fn(), vi.fn());

    stateUnit.selectFile(makeMockFile('backup.tar.gz'));
    stateUnit.cancelImport();

    expect(await firstValueFrom(stateUnit.selectedFile$)).toBeNull();
    expect(await firstValueFrom(stateUnit.preview$)).toBeNull();
    expect(await firstValueFrom(stateUnit.importPhase$)).toBeNull();

    stateUnit.dispose();
  });

  // jsdom doesn't implement `Blob.prototype.stream()` portably, so build
  // the stream literal — same shape, no environment dependency.
  function streamOf(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  }

  it('doExport calls exportFn and returns blob + filename from BackendDownload', async () => {
    // exportFn now returns a BackendDownload — a transport-neutral
    // { stream, contentType, filename? } object. The state unit converts the
    // stream to a Blob and threads filename through.
    const exportFn = vi.fn().mockResolvedValue({
      stream: streamOf('data'),
      contentType: 'application/x-tar',
      filename: 'export.tar.gz',
    });

    const stateUnit = createExchangeStateUnit(mockBrowse(), exportFn, vi.fn());

    const result = await stateUnit.doExport();
    expect(result.filename).toBe('export.tar.gz');
    expect(await result.blob.text()).toBe('data');

    expect(await firstValueFrom(stateUnit.isExporting$)).toBe(false);

    stateUnit.dispose();
  });

  it('doExport falls back to a synthesized filename when the download omits one', async () => {
    const exportFn = vi.fn().mockResolvedValue({
      stream: streamOf('data'),
      contentType: 'application/x-tar',
      // no filename
    });

    const stateUnit = createExchangeStateUnit(mockBrowse(), exportFn, vi.fn());

    const result = await stateUnit.doExport();
    expect(result.filename).toMatch(/^semiont-export-\d+\.tar\.gz$/);

    stateUnit.dispose();
  });

  it('doExport propagates errors from exportFn and clears isExporting$', async () => {
    // The state unit no longer inspects HTTP status — non-OK responses are the
    // transport's concern (ky throws on non-OK by default). The state unit just
    // propagates whatever the exportFn rejects with and resets state.
    const exportFn = vi.fn().mockRejectedValue(new Error('transport boom'));

    const stateUnit = createExchangeStateUnit(mockBrowse(), exportFn, vi.fn());

    await expect(stateUnit.doExport()).rejects.toThrow('transport boom');
    expect(await firstValueFrom(stateUnit.isExporting$)).toBe(false);

    stateUnit.dispose();
  });

  it('doImport subscribes to importFn Observable and mirrors each progress event', async () => {
    // importFn now returns Observable<ProgressEvent>. The state unit subscribes,
    // mirrors each emit into its state subjects, and resolves when the
    // observable completes.
    const importFn = vi.fn().mockReturnValue(
      of(
        { phase: 'uploading', message: '50%' },
        { phase: 'complete', result: { resources: 10 } },
      ),
    );

    const stateUnit = createExchangeStateUnit(mockBrowse(), vi.fn(), importFn);
    stateUnit.selectFile(makeMockFile('import.tar.gz'));

    await stateUnit.doImport();

    expect(importFn).toHaveBeenCalledOnce();
    expect(await firstValueFrom(stateUnit.importResult$)).toEqual({ resources: 10 });
    expect(await firstValueFrom(stateUnit.importPhase$)).toBe('complete');
    expect(await firstValueFrom(stateUnit.isImporting$)).toBe(false);

    stateUnit.dispose();
  });

  it('doImport propagates errors from the importFn Observable and clears isImporting$', async () => {
    const importFn = vi.fn().mockReturnValue(throwError(() => new Error('import boom')));

    const stateUnit = createExchangeStateUnit(mockBrowse(), vi.fn(), importFn);
    stateUnit.selectFile(makeMockFile('import.tar.gz'));

    await expect(stateUnit.doImport()).rejects.toThrow('import boom');
    expect(await firstValueFrom(stateUnit.isImporting$)).toBe(false);

    stateUnit.dispose();
  });

  it('doImport is no-op without selected file', async () => {
    const importFn = vi.fn();
    const stateUnit = createExchangeStateUnit(mockBrowse(), vi.fn(), importFn);

    await stateUnit.doImport();
    expect(importFn).not.toHaveBeenCalled();

    stateUnit.dispose();
  });
});
