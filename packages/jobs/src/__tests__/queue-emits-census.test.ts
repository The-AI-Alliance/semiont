/**
 * Census gate: `JOB_QUEUE_EMITS` equals what the queue drivers actually
 * emit on the bus.
 *
 * The gateway's signal bridge trusts this list as the queue drivers' whole
 * emission surface — a driver emitting a new channel without listing it
 * would stay on the raw bus and starve remote subscribers under a remote
 * plane, exactly as `job:queued` did (2026-09-15,
 * .plans/bugs/job-queued-classified-in-process-starves-workers.md).
 * Same discipline as make-meaning's gateway-handler census: `.pipe(`
 * counts as consuming, `.next` as emitting, comments stripped.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JOB_QUEUE_EMITS } from '../job-queue-interface';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER_FILES = ['fs-job-queue.ts', 'jetstream-job-queue.ts'];

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('queue-driver emission census', () => {
  test('JOB_QUEUE_EMITS is exactly what the drivers emit', () => {
    const emitted = new Set<string>();
    for (const file of DRIVER_FILES) {
      const source = stripComments(readFileSync(join(SRC, file), 'utf-8'));
      for (const match of source.matchAll(/eventBus\.emit\('([^']+)'/g)) emitted.add(match[1]!);
    }
    expect([...JOB_QUEUE_EMITS].sort()).toEqual([...emitted].sort());
  });
});
