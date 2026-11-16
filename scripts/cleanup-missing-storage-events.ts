#!/usr/bin/env tsx
/**
 * Cleanup script: remove resource event streams whose effective storageUri
 * points at a file that no longer exists on disk.
 *
 * This happens when:
 *   - a file is deleted from the working tree without a compensating event
 *   - the Generation Worker crashes mid-write, leaving a yield:created behind
 *   - a repo revert loses files but not events
 *
 * For each resource:
 *   - replay the event stream to compute the effective storageUri
 *     (yield:created, then any later yield:moved)
 *   - track whether the resource ended up archived
 *   - if non-archived AND storageUri file is missing → delete the whole stream
 *
 * Archived resources are preserved: they're opaque to rebuild, so they don't
 * crash the Smelter, and keeping them preserves history.
 *
 * Usage:
 *   npx tsx scripts/cleanup-missing-storage-events.ts /path/to/kb
 *   npx tsx scripts/cleanup-missing-storage-events.ts /path/to/kb --confirm
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';

interface ParsedEvent {
  type: string;
  payload?: Record<string, unknown>;
}

async function listResourceDirs(eventsRoot: string): Promise<string[]> {
  // Structure: events/<ab>/<cd>/<resourceId>/events-*.jsonl
  // Skip: events/__system__/
  const out: string[] = [];
  let level1: string[];
  try {
    level1 = await fs.readdir(eventsRoot);
  } catch {
    return out;
  }
  for (const a of level1) {
    if (a === '__system__') continue;
    const p1 = join(eventsRoot, a);
    const st1 = await fs.stat(p1).catch(() => null);
    if (!st1?.isDirectory()) continue;
    for (const b of await fs.readdir(p1)) {
      const p2 = join(p1, b);
      const st2 = await fs.stat(p2).catch(() => null);
      if (!st2?.isDirectory()) continue;
      for (const rid of await fs.readdir(p2)) {
        const p3 = join(p2, rid);
        const st3 = await fs.stat(p3).catch(() => null);
        if (st3?.isDirectory()) out.push(p3);
      }
    }
  }
  return out;
}

async function readEvents(resourceDir: string): Promise<ParsedEvent[]> {
  const events: ParsedEvent[] = [];
  const files = (await fs.readdir(resourceDir))
    .filter(f => f.startsWith('events-') && f.endsWith('.jsonl'))
    .sort();
  for (const f of files) {
    const content = await fs.readFile(join(resourceDir, f), 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // malformed — ignore
      }
    }
  }
  return events;
}

/**
 * Strip the "file://" prefix and resolve against the KB root.
 * Returns null if the URI is not a file:// URI.
 */
function resolveStorageUri(kbRoot: string, storageUri: string): string | null {
  if (!storageUri.startsWith('file://')) return null;
  const rel = storageUri.slice('file://'.length);
  return join(kbRoot, rel);
}

interface ResourceSummary {
  resourceId: string;
  resourceDir: string;
  storageUri: string;
  resolvedPath: string;
  name: string;
}

async function main() {
  const kbRoot = process.argv[2];
  const confirm = process.argv.includes('--confirm');

  if (!kbRoot) {
    console.error('Usage: npx tsx scripts/cleanup-missing-storage-events.ts /path/to/kb [--confirm]');
    process.exit(1);
  }

  const eventsRoot = join(kbRoot, '.semiont', 'events');
  try {
    await fs.access(eventsRoot);
  } catch {
    console.error(`No .semiont/events directory at ${eventsRoot}`);
    process.exit(1);
  }

  const resourceDirs = await listResourceDirs(eventsRoot);
  console.log(`Scanning ${resourceDirs.length} resource event streams under ${eventsRoot}`);

  const toDelete: ResourceSummary[] = [];
  let scanned = 0;
  let noStorageUri = 0;
  let archived = 0;
  let present = 0;

  for (const resourceDir of resourceDirs) {
    scanned++;
    const resourceId = resourceDir.split('/').pop()!;
    const events = await readEvents(resourceDir);

    let storageUri: string | null = null;
    let isArchived = false;
    let name = '';

    for (const ev of events) {
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      switch (ev.type) {
        case 'yield:created':
        case 'yield:cloned':
          if (typeof p.storageUri === 'string') storageUri = p.storageUri;
          if (typeof p.name === 'string') name = p.name;
          break;
        case 'yield:moved':
          if (typeof p.toUri === 'string') storageUri = p.toUri;
          break;
        case 'mark:archived':
          isArchived = true;
          break;
        case 'mark:unarchived':
          isArchived = false;
          break;
      }
    }

    if (!storageUri) { noStorageUri++; continue; }
    if (isArchived) { archived++; continue; }

    const resolved = resolveStorageUri(kbRoot, storageUri);
    if (!resolved) { noStorageUri++; continue; }

    try {
      await fs.access(resolved);
      present++;
    } catch {
      toDelete.push({ resourceId, resourceDir, storageUri, resolvedPath: resolved, name });
    }
  }

  console.log('');
  console.log(`Scanned:         ${scanned}`);
  console.log(`  present:       ${present}`);
  console.log(`  archived:      ${archived}  (preserved)`);
  console.log(`  no storageUri: ${noStorageUri}  (preserved)`);
  console.log(`  MISSING:       ${toDelete.length}`);
  console.log('');

  if (toDelete.length === 0) {
    console.log('Nothing to clean up.');
    return;
  }

  console.log('Resources whose effective storageUri points at a missing file:');
  console.log('');
  for (const r of toDelete) {
    console.log(`  ${r.resourceId}  "${r.name}"`);
    console.log(`    storageUri:  ${r.storageUri}`);
    console.log(`    resolved:    ${r.resolvedPath}`);
    console.log(`    event dir:   ${r.resourceDir}`);
    console.log('');
  }

  if (!confirm) {
    console.log('DRY RUN — no files were deleted.');
    console.log('Re-run with --confirm to delete the above event directories.');
    return;
  }

  console.log('Deleting event directories...');
  for (const r of toDelete) {
    await fs.rm(r.resourceDir, { recursive: true, force: true });
    console.log(`  rm -rf ${r.resourceDir}`);
    // Also clean up empty parent shard dirs so the tree stays tidy
    for (let p = dirname(r.resourceDir); p.startsWith(eventsRoot) && p !== eventsRoot; p = dirname(p)) {
      try {
        const entries = await fs.readdir(p);
        if (entries.length === 0) await fs.rmdir(p);
        else break;
      } catch { break; }
    }
  }
  console.log('');
  console.log(`Done. ${toDelete.length} resource event streams removed.`);
  console.log('Next backend start will rebuild views from the surviving events.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
