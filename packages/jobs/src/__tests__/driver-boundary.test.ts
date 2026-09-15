/**
 * The driver boundary census (JOB-QUEUE-DRIVER P1): "if a caller can tell
 * which driver is installed, the phase failed." The backend's client library
 * may appear in EXACTLY one module — the driver itself. A second import site
 * is a leak: some consumer now sees NATS types, subjects, or handles, and
 * the backend has stopped being a config choice.
 */
import { describe, test, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await tsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('driver boundary', () => {
  test("the 'nats' client is imported by exactly the JetStream driver (and its test fixture)", async () => {
    const importers: string[] = [];
    for (const file of await tsFiles(SRC)) {
      const source = await fs.readFile(file, 'utf-8');
      if (/from ['"]nats['"]/.test(source)) importers.push(path.relative(SRC, file));
    }
    expect(importers.sort()).toEqual([
      // The driver — the ONE production module allowed to know the backend.
      'jetstream-job-queue.ts',
      // The fixture: spawns the test server and reaches into KV to age jobs —
      // driver-specific mechanism, exactly where the conformance design puts it.
      '__tests__/jetstream-job-queue.test.ts',
    ].sort());
  });
});
