import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import type { ShellVM } from '../../flows/shell-vm';
import { createExchangeVM } from '../exchange-vm';

function mockBrowse(): ShellVM {
  return { dispose: vi.fn() } as unknown as ShellVM;
}

function makeMockFile(name: string): File {
  return new File(['content'], name, { type: 'application/gzip' });
}

describe('createExchangeVM', () => {
  it('initializes with null/empty state', async () => {
    const vm = createExchangeVM(mockBrowse(), vi.fn(), vi.fn());

    expect(await firstValueFrom(vm.selectedFile$)).toBeNull();
    expect(await firstValueFrom(vm.preview$)).toBeNull();
    expect(await firstValueFrom(vm.importPhase$)).toBeNull();
    expect(await firstValueFrom(vm.isExporting$)).toBe(false);
    expect(await firstValueFrom(vm.isImporting$)).toBe(false);

    vm.dispose();
  });

  it('selectFile sets file and generates preview', async () => {
    const vm = createExchangeVM(mockBrowse(), vi.fn(), vi.fn());

    vm.selectFile(makeMockFile('backup.tar.gz'));

    const file = await firstValueFrom(vm.selectedFile$);
    expect(file?.name).toBe('backup.tar.gz');

    const preview = await firstValueFrom(vm.preview$);
    expect(preview?.format).toBe('semiont-linked-data');

    vm.dispose();
  });

  it('selectFile detects unknown format', async () => {
    const vm = createExchangeVM(mockBrowse(), vi.fn(), vi.fn());

    vm.selectFile(makeMockFile('data.json'));

    const preview = await firstValueFrom(vm.preview$);
    expect(preview?.format).toBe('unknown');

    vm.dispose();
  });

  it('cancelImport resets all state', async () => {
    const vm = createExchangeVM(mockBrowse(), vi.fn(), vi.fn());

    vm.selectFile(makeMockFile('backup.tar.gz'));
    vm.cancelImport();

    expect(await firstValueFrom(vm.selectedFile$)).toBeNull();
    expect(await firstValueFrom(vm.preview$)).toBeNull();
    expect(await firstValueFrom(vm.importPhase$)).toBeNull();

    vm.dispose();
  });

  it('doExport calls exportFn and returns blob + filename', async () => {
    const blob = new Blob(['data']);
    const exportFn = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(blob),
      headers: new Headers({ 'Content-Disposition': 'attachment; filename="export.tar.gz"' }),
    });

    const vm = createExchangeVM(mockBrowse(), exportFn, vi.fn());

    const result = await vm.doExport();
    expect(result.filename).toBe('export.tar.gz');
    expect(result.blob).toBe(blob);

    expect(await firstValueFrom(vm.isExporting$)).toBe(false);

    vm.dispose();
  });

  it('doExport throws on non-ok response', async () => {
    const exportFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
    });

    const vm = createExchangeVM(mockBrowse(), exportFn, vi.fn());

    await expect(vm.doExport()).rejects.toThrow('Export failed');
    expect(await firstValueFrom(vm.isExporting$)).toBe(false);

    vm.dispose();
  });

  it('doImport calls importFn with progress callback', async () => {
    const importFn = vi.fn().mockImplementation((_file, { onProgress }) => {
      onProgress({ phase: 'uploading', message: '50%' });
      onProgress({ phase: 'complete', result: { resources: 10 } });
      return Promise.resolve({ phase: 'complete' });
    });

    const vm = createExchangeVM(mockBrowse(), vi.fn(), importFn);
    vm.selectFile(makeMockFile('import.tar.gz'));

    await vm.doImport();

    expect(importFn).toHaveBeenCalledOnce();
    expect(await firstValueFrom(vm.importResult$)).toEqual({ resources: 10 });
    expect(await firstValueFrom(vm.isImporting$)).toBe(false);

    vm.dispose();
  });

  it('doImport is no-op without selected file', async () => {
    const importFn = vi.fn();
    const vm = createExchangeVM(mockBrowse(), vi.fn(), importFn);

    await vm.doImport();
    expect(importFn).not.toHaveBeenCalled();

    vm.dispose();
  });
});
