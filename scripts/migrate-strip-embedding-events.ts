#!/usr/bin/env tsx
/**
 * Throwaway migration script: strip embedding:computed and embedding:deleted
 * events from persisted event streams.
 *
 * These event types have been replaced by the EmbeddingStore
 * (.semiont/embeddings/ → XDG state). Nothing reads them at runtime any more.
 *
 * Usage:
 *   npx tsx scripts/migrate-strip-embedding-events.ts /path/to/.semiont
 *
 * Idempotent — running twice produces the same output.
 */

import { promises as fs } from 'fs';
import { join } from 'path';

const STRIP_TYPES = new Set(['embedding:computed', 'embedding:deleted']);

async function findJsonlFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findJsonlFiles(full));
    } else if (entry.name.endsWith('.jsonl')) {
      results.push(full);
    }
  }
  return results;
}

async function main() {
  const stateDir = process.argv[2];
  if (!stateDir) {
    console.error('Usage: npx tsx scripts/migrate-strip-embedding-events.ts /path/to/.semiont');
    process.exit(1);
  }

  const eventsDir = join(stateDir, 'events');
  const files = await findJsonlFiles(eventsDir);

  if (files.length === 0) {
    console.log(`No .jsonl files found under ${eventsDir}`);
    return;
  }

  let totalFiles = 0;
  let totalStripped = 0;

  for (const file of files) {
    const content = await fs.readFile(file, 'utf-8');
    const lines = content.split('\n');
    let fileChanged = false;

    const kept = lines.filter(line => {
      if (!line.trim()) return true; // preserve blank lines (e.g. trailing newline)
      try {
        const obj = JSON.parse(line);
        if (STRIP_TYPES.has(obj.type)) {
          totalStripped++;
          fileChanged = true;
          return false;
        }
      } catch {
        // malformed line — leave it alone
      }
      return true;
    });

    if (fileChanged) {
      await fs.writeFile(file, kept.join('\n'), 'utf-8');
      totalFiles++;
      console.log(`  stripped: ${file}`);
    }
  }

  console.log(`\nDone. ${totalStripped} events stripped across ${totalFiles} files (${files.length} files scanned).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
