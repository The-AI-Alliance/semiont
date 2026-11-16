/**
 * FileWeaverCheckpoint Tests (WEAVER-ISOLATION P3, D1 = checkpointed replay)
 *
 * The Weaver's persisted per-resource applied-sequence map. Lives in the
 * project stateDir — wiping it degrades the next catch-up to a full replay
 * through the pipeline (idempotent folds absorb it), never to wrongness.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { FileWeaverCheckpoint } from '../weaver-checkpoint';

describe('FileWeaverCheckpoint', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'weaver-checkpoint-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('load() returns an empty map when no checkpoint file exists', async () => {
    const store = new FileWeaverCheckpoint(join(dir, 'absent.json'));
    expect(await store.load()).toEqual({});
  });

  it('round-trips saved sequences', async () => {
    const store = new FileWeaverCheckpoint(join(dir, 'cp.json'));
    await store.save({ 'res-a': 7, 'res-b': 3 });

    expect(await store.load()).toEqual({ 'res-a': 7, 'res-b': 3 });
  });

  it('save() replaces the previous checkpoint wholesale', async () => {
    const store = new FileWeaverCheckpoint(join(dir, 'cp.json'));
    await store.save({ 'res-a': 1 });
    await store.save({ 'res-b': 2 });

    expect(await store.load()).toEqual({ 'res-b': 2 });
  });

  it('load() of a corrupt file degrades to empty — full replay, not a crash', async () => {
    const path = join(dir, 'cp.json');
    await fs.writeFile(path, 'not json{', 'utf-8');
    const store = new FileWeaverCheckpoint(path);

    expect(await store.load()).toEqual({});
  });
});
