/**
 * Census gate: docs/protocol/JOBS.md describes every channel the dispatcher
 * answers or emits. The document is what a second implementation of the
 * dispatcher is written from, so a channel the rosters grow and the document
 * does not is behaviour the next implementation will not have.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DISPATCHER_INBOUND_CHANNELS, DISPATCHER_OUTBOUND_CHANNELS } from '../service-channels.js';

const JOBS_MD = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/protocol/JOBS.md');

describe('the job protocol document', () => {
  test('names every channel the dispatcher answers or emits', () => {
    const doc = readFileSync(JOBS_MD, 'utf-8');
    const undocumented = [...DISPATCHER_INBOUND_CHANNELS, ...DISPATCHER_OUTBOUND_CHANNELS]
      .filter((channel) => !doc.includes(`\`${channel}\``));
    expect(undocumented).toEqual([]);
  });
});
