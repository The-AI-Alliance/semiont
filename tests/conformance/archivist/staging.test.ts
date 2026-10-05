/**
 * Staging (ARCHIVIST.md § Staging): what reaches the git index, within the
 * bound the document sets, and that a knowledge base that does not sync git
 * runs none.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sha256, shardOf, withArchivist } from '../harness/archivist-world';
import { eventually } from '../harness/net';

const logOf = (id: string) => `.semiont/events/${shardOf(id)}/${id}/events-000001.jsonl`;

withArchivist('staging, in a knowledge base that syncs git', (world) => {
  it('stages the content and the log of a new resource, within the bound', async () => {
    const started = Date.now();
    const id = await world().created(world().world.personDid('ada'), { name: 'Staged', storageUri: 'file://staged/new.md', content: 'new\n' });
    await world().untilIndexed('staged/new.md');
    await world().untilIndexed(logOf(id));
    expect(Date.now() - started).toBeLessThan(world().settings.staging.maxWaitMs + 5_000);
    expect(world().staged()).toEqual(expect.arrayContaining(['staged/new.md', logOf(id)]));
  });

  it('stages the system stream, which the vocabulary seeded at boot wrote', async () => {
    await world().untilIndexed('.semiont/events/__system__/events-000001.jsonl');
  });

  it('stages each later event of a stream: the index holds the log as it is on disk', async () => {
    const editor = await world().person('editor');
    const id = await world().created(editor.did, { name: 'Appended', storageUri: 'file://staged/appended.md', content: 'appended\n' });
    await editor.ask('mark:archive', { resourceId: id });
    await editor.ask('mark:unarchive', { resourceId: id });
    const onDisk = () => readFileSync(join(world().dirs.root, logOf(id)), 'utf8');
    await eventually('the index to hold all three events', world().settings.staging.maxWaitMs + 5_000, () =>
      world().indexed().includes(logOf(id)) && execFileSync('git', ['show', `:${logOf(id)}`], { cwd: world().dirs.root, encoding: 'utf8' }) === onDisk() ? true : undefined,
    );
    expect(onDisk().split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('stages new content recorded by yield:update', async () => {
    const editor = await world().person('editor');
    const uri = 'file://staged/edited.md';
    const id = await world().created(editor.did, { name: 'Edited', storageUri: uri, content: 'first\n' });
    await world().untilIndexed('staged/edited.md');
    world().write(uri, 'second\n');
    await editor.ask('yield:update', { resourceId: id, storageUri: uri, contentChecksum: sha256('second\n'), byteSize: 7 });
    await eventually('the index to hold the new content', world().settings.staging.maxWaitMs + 5_000, () =>
      execFileSync('git', ['show', ':staged/edited.md'], { cwd: world().dirs.root, encoding: 'utf8' }) === 'second\n' ? true : undefined,
    );
  });

  it('unstages what an archive removes, keeping the file when told to', async () => {
    const owner = await world().person('owner');
    const removed = await world().created(owner.did, { name: 'Removed', storageUri: 'file://staged/removed.md', content: 'removed\n' });
    const kept = await world().created(owner.did, { name: 'Kept', storageUri: 'file://staged/kept.md', content: 'kept\n' });
    await world().untilIndexed('staged/removed.md');
    await world().untilIndexed('staged/kept.md');

    await owner.ask('mark:archive', { resourceId: removed, storageUri: 'file://staged/removed.md' });
    await owner.ask('mark:archive', { resourceId: kept, storageUri: 'file://staged/kept.md', keepFile: true });

    // A remove tells git before it answers.
    expect(world().indexed()).not.toContain('staged/removed.md');
    expect(world().indexed()).not.toContain('staged/kept.md');
    expect(existsSync(world().contentPath('file://staged/removed.md'))).toBe(false);
    expect(existsSync(world().contentPath('file://staged/kept.md'))).toBe(true);
  });

  it('names the branch the tree is on, read when asked', async () => {
    const reader = await world().person('reader');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Conformance', '-c', 'user.email=conformance@example.com', ...args], { cwd: world().dirs.root, encoding: 'utf8' });
    git('commit', '--quiet', '--allow-empty', '-m', 'a first commit');
    git('checkout', '--quiet', '-b', 'a-branch-of-its-own');
    expect((await reader.ask('browse:kb-requested', {}))['gitBranch']).toBe('a-branch-of-its-own');
    git('checkout', '--quiet', '-b', 'another');
    expect((await reader.ask('browse:kb-requested', {}))['gitBranch']).toBe('another');
  });

  it('stays up, and goes on recording, when a batch cannot be staged', async () => {
    const editor = await world().person('editor');
    const lock = join(world().dirs.root, '.git', 'index.lock');
    writeFileSync(lock, '');
    try {
      const id = await world().created(editor.did, { name: 'Degraded', storageUri: 'file://staged/degraded.md', content: 'degraded\n' });
      await editor.ask('mark:archive', { resourceId: id });
      expect(world().stored(id).map((e) => e.type)).toEqual(['yield:created', 'mark:archived']);
      expect((await world().http('GET', '/health', { anonymous: true, route: '/health' })).status).toBe(200);
    } finally {
      execFileSync('rm', ['-f', lock]);
    }
    // Held back by the lock, the changes are staged once it is gone.
    await world().untilIndexed('staged/degraded.md');
  });
}, { staging: { flushMs: 100, maxWaitMs: 1_000 } });

withArchivist('staging, in a knowledge base that does not sync git', (world) => {
  it('records, moves nothing to an index, and never runs git', async () => {
    const owner = await world().person('owner');
    const uri = 'file://unstaged/plain.md';
    const id = await world().created(owner.did, { name: 'Plain', storageUri: uri, content: 'plain\n' });
    world().write(uri, 'plain, edited\n');
    await owner.ask('yield:update', { resourceId: id, storageUri: uri, contentChecksum: sha256('plain, edited\n'), byteSize: 14 });
    expect(await owner.ask('browse:kb-requested', {})).not.toHaveProperty('gitBranch');
    await owner.ask('mark:archive', { resourceId: id, storageUri: uri });
    expect(existsSync(world().contentPath(uri))).toBe(false);
    expect(world().stored(id).map((e) => e.type)).toEqual(['yield:created', 'yield:updated', 'mark:archived']);

    await new Promise((r) => setTimeout(r, world().settings.staging.maxWaitMs + 500));
    expect(world().gitRuns()).toEqual([]);
    expect(existsSync(join(world().dirs.root, '.git'))).toBe(false);
  });
}, { gitSync: false, gitTripwire: true });
