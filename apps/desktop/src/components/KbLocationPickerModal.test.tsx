// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createTestSession, refuseUnscriptedOperation } from '@semiont/sdk/testing';
import { renderInApp } from '../lib/test-render';
import { KbLocationPickerModal } from './KbLocationPickerModal';

function sessionWithDirectoryTree() {
  return createTestSession({
    transport: {
      makeResponse: (operation, payload) => {
        if (operation !== 'browse:directory-requested') return refuseUnscriptedOperation(operation);
        if (payload.path === 'docs') {
          return {
            path: 'docs',
            entries: [{ type: 'dir', name: 'archive', path: 'docs/archive', mtime: '2026-11-10T12:00:00Z' }],
          };
        }
        if (payload.path === 'docs/archive') return { path: 'docs/archive', entries: [] };
        if (payload.path === '.') {
          return {
            path: '.',
            entries: [
              { type: 'dir', name: 'docs', path: 'docs', mtime: '2026-11-10T12:00:00Z' },
              { type: 'file', name: 'README.md', path: 'README.md', size: 12, mtime: '2026-11-10T12:00:00Z', tracked: false },
            ],
          };
        }
        return refuseUnscriptedOperation(operation);
      },
    },
  });
}

describe('Knowledge Base location picker', () => {
  it('navigates Browse directories and returns a KB-relative destination', async () => {
    const { session } = sessionWithDirectoryTree();
    const onChoose = vi.fn();
    const view = await renderInApp(
      <KbLocationPickerModal session={session} initialDirectory="" onChoose={onChoose} />,
    );
    try {
      await view.until(() => view.container.querySelector('[aria-label="Open folder docs"]') !== null, 'the KB root listing');
      expect(view.container.textContent).toContain('README.md');

      await view.click('[aria-label="Open folder docs"]');
      await view.until(() => view.container.querySelector('[aria-label="Open folder archive"]') !== null, 'the docs listing');
      await view.click('[aria-label="Open folder archive"]');
      await view.until(() => view.container.textContent?.includes('This folder is empty.') === true, 'the archive listing');
      await view.click('[aria-label="Choose this folder"]');

      expect(onChoose).toHaveBeenCalledWith('docs/archive');
      expect(view.errors).toEqual([]);
    } finally {
      view.unmount();
      await session.dispose();
    }
  });

  it('rejects an unsafe suggested path and starts at the KB root', async () => {
    const { session } = sessionWithDirectoryTree();
    const onChoose = vi.fn();
    const view = await renderInApp(
      <KbLocationPickerModal session={session} initialDirectory="../../outside" onChoose={onChoose} />,
    );
    try {
      await view.until(() => view.container.querySelector('[aria-label="Open folder docs"]') !== null, 'the KB root listing');
      expect(view.container.querySelector('[aria-label="Knowledge Base folder path"]')?.textContent).toContain('KB root');
      expect(view.errors).toEqual([]);
    } finally {
      view.unmount();
      await session.dispose();
    }
  });
});
