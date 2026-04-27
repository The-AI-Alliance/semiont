#!/usr/bin/env tsx
/**
 * Throwaway migration script: rewrite persisted event type fields
 * from dot-notation to flow verb names.
 *
 * Usage:
 *   npx tsx scripts/migrate-event-types.ts /path/to/.semiont
 *
 * Idempotent — running twice produces the same output.
 * Walks every .jsonl file under <stateDir>/events/ and replaces
 * the "type" field in each JSON line.
 */

import { promises as fs } from 'fs';
import { join } from 'path';

const MAPPING: Record<string, string> = {
  'resource.created':        'yield:created',
  'resource.cloned':         'yield:cloned',
  'resource.updated':        'yield:updated',
  'resource.moved':          'yield:moved',
  'resource.archived':       'mark:archived',
  'resource.unarchived':     'mark:unarchived',
  'annotation.added':        'mark:added',
  'annotation.removed':      'mark:removed',
  'annotation.body.updated': 'mark:body-updated',
  'entitytag.added':         'mark:entity-tag-added',
  'entitytag.removed':       'mark:entity-tag-removed',
  'entitytype.added':        'mark:entity-type-added',
  'embedding.computed':      'embedding:computed',
  'embedding.deleted':       'embedding:deleted',
  'job.started':             'job:started',
  'job.progress':            'job:progress',
  'job.completed':           'job:completed',
  'job.failed':              'job:failed',
  'representation.added':    'yield:representation-added',
  'representation.removed':  'yield:representation-removed',
};

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
    let changed = false;

    // 1. Flatten nested envelope: { event: {...}, metadata: {...} } → { ...event, metadata: {...} }
    if ('event' in obj && 'metadata' in obj && typeof obj.event === 'object' && !('type' in obj)) {
      const { event, metadata, signature, ...rest } = obj;
      const flat: Record<string, unknown> = { ...event, metadata, ...rest };
      if (signature) flat.signature = signature;
      // Remove redundant metadata.timestamp
      if (flat.metadata && typeof flat.metadata === 'object' && 'timestamp' in (flat.metadata as any)) {
        delete (flat.metadata as any).timestamp;
      }
      // Also rename the type in the same pass
      if (typeof flat.type === 'string' && MAPPING[flat.type]) {
        flat.type = MAPPING[flat.type];
      }
      return { migrated: JSON.stringify(flat), changed: true };
    }

    // 2. Rename dot-notation event types to flow verb names (for already-flat events)
    const oldType = obj.type;
    if (oldType && MAPPING[oldType]) {
      obj.type = MAPPING[oldType];
      changed = true;
    }

    // 3. Remove redundant metadata.timestamp on already-flat events
    if (obj.metadata && typeof obj.metadata === 'object' && 'timestamp' in obj.metadata) {
      delete obj.metadata.timestamp;
      changed = true;
    }

    if (changed) {
      return { migrated: JSON.stringify(obj), changed: true };
    }
    return { migrated: line, changed: false };
  } catch {
    // Not valid JSON — leave untouched
    return { migrated: line, changed: false };
  }
}

async function main() {
  const stateDir = process.argv[2];
  if (!stateDir) {
    console.error('Usage: npx tsx scripts/migrate-event-types.ts /path/to/.semiont');
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
