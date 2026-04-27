#!/usr/bin/env tsx
/**
 * Throwaway migration script: strip legacy chain-integrity fields from
 * persisted event metadata.
 *
 * Removes `metadata.checksum` and `metadata.prevEventHash` from every event
 * in every .jsonl file under <stateDir>/events/.  These fields were written
 * by the old in-event hash chain implementation, which has been replaced by
 * git-level integrity.
 *
 * Usage:
 *   npx tsx scripts/migrate-strip-chain-metadata.ts /path/to/.semiont
 *
 * Idempotent — running twice produces the same output.
 */

import { promises as fs } from 'fs';
import { join } from 'path';

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

function migrateLine(line: string): { migrated: string; changed: boolean } {
  if (!line.trim()) return { migrated: line, changed: false };

  try {
    const obj = JSON.parse(line);
    if (!obj.metadata || typeof obj.metadata !== 'object') {
      return { migrated: line, changed: false };
    }

    let changed = false;
    if ('checksum' in obj.metadata) {
      delete obj.metadata.checksum;
      changed = true;
    }
    if ('prevEventHash' in obj.metadata) {
      delete obj.metadata.prevEventHash;
      changed = true;
    }

    return changed
      ? { migrated: JSON.stringify(obj), changed: true }
      : { migrated: line, changed: false };
  } catch {
    return { migrated: line, changed: false };
  }
}

async function main() {
  const stateDir = process.argv[2];
  if (!stateDir) {
    console.error('Usage: npx tsx scripts/migrate-strip-chain-metadata.ts /path/to/.semiont');
    process.exit(1);
  }

  const eventsDir = join(stateDir, 'events');
  const files = await findJsonlFiles(eventsDir);

  if (files.length === 0) {
    console.log(`No .jsonl files found under ${eventsDir}`);
    return;
  }

  let totalFiles = 0;
  let totalLines = 0;
  let totalChanged = 0;

  for (const file of files) {
    const content = await fs.readFile(file, 'utf-8');
    const lines = content.split('\n');
    let fileChanged = false;

    const migratedLines = lines.map(line => {
      const { migrated, changed } = migrateLine(line);
      if (changed) {
        totalChanged++;
        fileChanged = true;
      }
      totalLines++;
      return migrated;
    });

    if (fileChanged) {
      await fs.writeFile(file, migratedLines.join('\n'), 'utf-8');
      totalFiles++;
      console.log(`  migrated: ${file}`);
    }
  }

  console.log(`\nDone. ${totalChanged} events migrated across ${totalFiles} files (${files.length} files scanned, ${totalLines} lines).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
