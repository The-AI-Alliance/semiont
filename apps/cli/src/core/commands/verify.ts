/**
 * Verify Command
 *
 * Validates a backup archive without importing it.
 * Checks manifest format, hash chain integrity per stream,
 * and content blob presence.
 *
 * Usage:
 *   semiont verify --file backup.tar.gz
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type { StoredEvent } from '@semiont/core';
import { isBackupManifest, validateManifestVersion, BACKUP_FORMAT } from '@semiont/make-meaning';
import { CommandResults } from '../command-types.js';
import { CommandBuilder } from '../command-definition.js';
import { OpsOptionsSchema } from '../base-options-schema.js';
import { printInfo, printSuccess, printWarning, printError } from '../io/cli-logger.js';

// Inline tar reader import — we need readTarGz from make-meaning's exchange internals,
// but it's not exported from the public API. Use a minimal reimplementation that reads
// the tar entries via the same approach: decompress, then parse headers.
// Actually, we can import readTarGz indirectly — the archive is a standard tar.gz.
// Let's just decompress and parse directly.

import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';

const BLOCK_SIZE = 512;

async function readTarGzEntries(input: Readable): Promise<Map<string, Buffer>> {
  const decompressed = await new Promise<Buffer>((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    gunzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gunzip.on('end', () => resolve(Buffer.concat(chunks)));
    gunzip.on('error', reject);
    input.on('error', reject);
    input.pipe(gunzip);
  });

  const entries = new Map<string, Buffer>();
  let offset = 0;

  while (offset + BLOCK_SIZE <= decompressed.length) {
    const header = decompressed.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((b) => b === 0)) break;

    const nameEnd = header.indexOf(0, 0);
    const name = header.subarray(0, Math.min(nameEnd, 100)).toString('utf8');
    const sizeStr = header.subarray(124, 135).toString('utf8').trim();
    const size = parseInt(sizeStr, 8);

    offset += BLOCK_SIZE;
    const data = decompressed.subarray(offset, offset + size);
    offset += size;

    const remainder = size % BLOCK_SIZE;
    if (remainder !== 0) offset += BLOCK_SIZE - remainder;

    entries.set(name, data);
  }

  return entries;
}

// =====================================================================
// SCHEMA
// =====================================================================

export const VerifyOptionsSchema = OpsOptionsSchema.extend({
  file: z.string().min(1, 'File path is required'),
});

export type VerifyOptions = z.output<typeof VerifyOptionsSchema>;

// =====================================================================
// IMPLEMENTATION
// =====================================================================

export async function runVerify(options: VerifyOptions): Promise<CommandResults> {
  const startTime = Date.now();

  const filePath = path.resolve(options.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  if (!options.quiet) {
    printInfo(`Verifying ${filePath}`);
  }

  const input = fs.createReadStream(filePath);
  const entries = await readTarGzEntries(input);

  // 1. Check manifest
  const manifestData = entries.get('.semiont/manifest.jsonl');
  if (!manifestData) {
    throw new Error('Invalid backup: missing .semiont/manifest.jsonl');
  }

  const manifestLines = manifestData.toString('utf8').trim().split('\n');
  const header = JSON.parse(manifestLines[0]);

  if (!isBackupManifest(header)) {
    throw new Error(`Invalid format: expected "${BACKUP_FORMAT}", got "${header.format}"`);
  }
  validateManifestVersion(header.version);

  if (!options.quiet) {
    printInfo(`Format: ${header.format} v${header.version}`);
    printInfo(`Exported: ${header.exportedAt}`);
    printInfo(`Source: ${header.sourceUrl}`);
    printInfo(`Stats: ${header.stats.streams} streams, ${header.stats.events} events, ${header.stats.blobs} blobs`);
  }

  // 2. Verify each event stream's hash chain
  const streamSummaries = manifestLines.slice(1).map((line: string) => JSON.parse(line));
  let totalChainBreaks = 0;
  let totalEventsChecked = 0;
  const warnings: string[] = [];

  for (const summary of streamSummaries) {
    const streamFile = `.semiont/events/${summary.stream}.jsonl`;
    const streamData = entries.get(streamFile);

    if (!streamData) {
      warnings.push(`Missing event stream: ${streamFile}`);
      continue;
    }

    const lines = streamData.toString('utf8').trim().split('\n');
    const events: StoredEvent[] = lines.map((line: string) => JSON.parse(line));
    totalEventsChecked += events.length;

    // Check hash chain
    let chainBreaks = 0;
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const curr = events[i];
      if (curr.metadata.prevEventHash && prev.metadata.checksum) {
        if (curr.metadata.prevEventHash !== prev.metadata.checksum) {
          chainBreaks++;
        }
      }
    }

    if (chainBreaks > 0) {
      warnings.push(`Stream ${summary.stream}: ${chainBreaks} hash chain break(s)`);
      totalChainBreaks += chainBreaks;
    }

    // Check first/last checksums match manifest
    if (events.length > 0) {
      const firstChecksum = events[0].metadata.checksum || '';
      const lastChecksum = events[events.length - 1].metadata.checksum || '';
      if (summary.firstChecksum && firstChecksum !== summary.firstChecksum) {
        warnings.push(`Stream ${summary.stream}: first checksum mismatch`);
      }
      if (summary.lastChecksum && lastChecksum !== summary.lastChecksum) {
        warnings.push(`Stream ${summary.stream}: last checksum mismatch`);
      }
    }

    // Check event count matches
    if (events.length !== summary.eventCount) {
      warnings.push(`Stream ${summary.stream}: expected ${summary.eventCount} events, found ${events.length}`);
    }
  }

  // 3. Check content blobs
  const contentEntries = [...entries.keys()].filter((k) => !k.startsWith('.semiont/'));
  if (header.stats.blobs !== contentEntries.length) {
    warnings.push(`Expected ${header.stats.blobs} content blobs, found ${contentEntries.length}`);
  }

  // Report
  if (!options.quiet) {
    printInfo(`Verified ${totalEventsChecked} events across ${streamSummaries.length} streams`);
    printInfo(`Content blobs: ${contentEntries.length}`);

    if (warnings.length > 0) {
      for (const w of warnings) {
        printWarning(w);
      }
    }

    if (totalChainBreaks === 0 && warnings.length === 0) {
      printSuccess('Backup is valid');
    } else {
      printError(`Verification found ${warnings.length} issue(s)`);
    }
  }

  const duration = Date.now() - startTime;
  const success = totalChainBreaks === 0 && warnings.length === 0;

  return {
    command: 'verify',
    environment: options.environment || 'n/a',
    timestamp: new Date(),
    duration,
    summary: {
      succeeded: success ? 1 : 0,
      failed: success ? 0 : 1,
      total: 1,
      warnings: warnings.length,
    },
    executionContext: { user: process.env.USER || 'unknown', workingDirectory: process.cwd(), dryRun: options.dryRun },
    results: [{
      entity: filePath,
      platform: 'posix',
      success,
      metadata: {
        format: header.format,
        version: header.version,
        streams: streamSummaries.length,
        eventsChecked: totalEventsChecked,
        contentBlobs: contentEntries.length,
        hashChainBreaks: totalChainBreaks,
        warnings,
      },
      duration,
    }],
  };
}

// =====================================================================
// COMMAND DEFINITION
// =====================================================================

export const verifyCmd = new CommandBuilder()
  .name('verify')
  .description('Verify a backup archive integrity')
  .requiresEnvironment(false)
  .requiresServices(false)
  .examples(
    'semiont verify --file backup.tar.gz',
  )
  .args({
    args: {
      '--file': {
        type: 'string',
        description: 'Backup file to verify (required)',
      },
    },
    aliases: {
      '-f': '--file',
    },
  })
  .schema(VerifyOptionsSchema)
  .handler(runVerify)
  .build();
