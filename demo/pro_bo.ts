#!/usr/bin/env tsx
/**
 * Prometheus Bound Demo Script - Refactored
 *
 * Downloads "Prometheus Bound" from Project Gutenberg, splits into chunks,
 * uploads to Semiont backend, creates Table of Contents with linked annotations,
 * and displays the event history showing how annotations evolved.
 *
 * Passes:
 * 0. Authentication
 * 1. Download and Chunk
 * 2. Upload Chunks
 * 3. Create Table of Contents
 * 4. Create Stub References
 * 5. Resolve References
 * 6. Show Document History
 * 7. Print Results
 */

import type { CreateDocumentRequest } from '@semiont/sdk';
import { extractAnnotationId, SemiontClient } from '@semiont/sdk';

// Local modules
import { downloadAndChunkText, type ChunkInfo } from './src/chunking';
import {
  printMainHeader,
  printSectionHeader,
  printInfo,
  printSuccess,
  printWarning,
  printBatchProgress,
  printDownloadStats,
  printChunkingStats,
  printAnnotationCreated,
  printFilesystemPath,
  printEventBreakdown,
  printEvent,
  printResults,
  printCompletion,
  printError,
  type EventDetails,
} from './src/display';
import { getLayer1Path, getLayer2Path, getLayer3Path } from './src/filesystem-utils';

// Configuration
const GUTENBERG_URL = 'https://www.gutenberg.org/cache/epub/8714/pg8714.txt';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const AUTH_EMAIL = process.env.AUTH_EMAIL || 'you@example.com';
const DATA_DIR = process.env.DATA_DIR || '/tmp/semiont/data/uploads';
const CHUNK_SIZE = 4000;

interface PartReference {
  text: string;
  start: number;
  end: number;
  documentId: string;
  annotationId?: string;
}

// === PASS 0: Authentication ===
async function authenticateWithBackend(client: SemiontClient): Promise<void> {
  printSectionHeader('🔐', 0, 'Authentication');
  printInfo(`Authenticating as ${AUTH_EMAIL}...`);

  const authData = await client.authenticate();
  printSuccess(`Authenticated as ${authData.user.name} (${authData.user.email})`);
}

// === PASS 1: Download and Chunk ===
async function downloadAndChunk(): Promise<ChunkInfo[]> {
  printSectionHeader('📥', 1, 'Download and Chunk Document');
  printInfo('Downloading from Project Gutenberg...');

  const chunks = await downloadAndChunkText(GUTENBERG_URL, {
    targetChunkSize: CHUNK_SIZE,
    startPattern: /PROMETHEUS BOUND\s+ARGUMENT/,
    endMarker: '*** END OF THE PROJECT GUTENBERG EBOOK FOUR PLAYS OF AESCHYLUS ***',
    titlePrefix: 'Prometheus Bound - Part',
  });

  // Calculate stats for display
  const totalChars = chunks.reduce((sum, c) => sum + c.content.length, 0);
  const avgChars = Math.round(totalChars / chunks.length);

  printDownloadStats(totalChars, totalChars);
  printChunkingStats(chunks.length, avgChars);

  return chunks;
}

// === PASS 2: Upload Chunks ===
async function uploadChunks(chunks: ChunkInfo[], client: SemiontClient): Promise<string[]> {
  printSectionHeader('📤', 2, 'Upload Document Chunks');

  const documentIds: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    printBatchProgress(i + 1, chunks.length, `Uploading ${chunk.title}...`);

    const request: CreateDocumentRequest = {
      name: chunk.title,
      content: chunk.content,
      format: 'text/plain',
      entityTypes: ['literature', 'ancient-greek-drama'],
      creationMethod: 'api',
    };

    const response = await client.createDocument(request);
    documentIds.push(response.document.id);
    printSuccess(response.document.id, 7);
    printFilesystemPath('Layer 1', getLayer1Path(response.document.id, DATA_DIR));
  }

  printSuccess(`All ${chunks.length} chunks uploaded`);
  return documentIds;
}

// === PASS 3: Create Table of Contents ===
async function createTableOfContents(
  chunks: ChunkInfo[],
  client: SemiontClient
): Promise<{ tocId: string; references: PartReference[] }> {
  printSectionHeader('📑', 3, 'Create Table of Contents');

  // Build markdown content with timestamp to ensure unique document ID
  const timestamp = new Date().toISOString();
  let content = `# Prometheus Bound: Table of Contents\n\n`;
  content += `_Generated: ${timestamp}_\n\n`;
  content += '## Parts\n\n';
  const references: PartReference[] = [];

  chunks.forEach((chunk, index) => {
    const partText = `Part ${chunk.partNumber}`;
    const listItem = `${index + 1}. ${partText}\n`;
    const start = content.length + `${index + 1}. `.length;
    const end = start + partText.length;

    references.push({
      text: partText,
      start,
      end,
      documentId: '', // Will be filled in next pass
    });

    content += listItem;
  });

  printInfo(`Creating ToC document with ${chunks.length} entries (${timestamp})...`);

  const request: CreateDocumentRequest = {
    name: 'Prometheus Bound: Table of Contents',
    content,
    format: 'text/markdown',
    entityTypes: ['literature', 'ancient-greek-drama', 'table-of-contents'],
    creationMethod: 'api',
  };

  const response = await client.createDocument(request);
  printSuccess(`Created ToC: ${response.document.id}`);
  printFilesystemPath('Layer 1', getLayer1Path(response.document.id, DATA_DIR));

  return { tocId: response.document.id, references };
}

// === PASS 4: Create Stub References ===
async function createStubReferences(
  tocId: string,
  references: PartReference[],
  chunkIds: string[],
  client: SemiontClient
): Promise<PartReference[]> {
  printSectionHeader('🔗', 4, 'Create Stub References');

  for (let i = 0; i < references.length; i++) {
    const ref = references[i];
    ref.documentId = chunkIds[i];

    printBatchProgress(i + 1, references.length, `Creating annotation for "${ref.text}"...`);

    const response = await client.createAnnotation({
      target: {
        source: tocId,
        selector: {
          type: 'TextPositionSelector',
          offset: ref.start,
          length: ref.end - ref.start,
          exact: ref.text,
        },
      },
      body: {
        type: 'SpecificResource',
        source: null,
        entityTypes: ['part-reference'],
      },
    });

    // Store the FULL annotation ID (includes URL prefix)
    ref.annotationId = response.annotation.id;

    printAnnotationCreated(response.annotation.id);
    printFilesystemPath('Layer 2 (event log)', getLayer2Path(tocId, DATA_DIR));
    printFilesystemPath('Layer 3 (projection)', getLayer3Path(tocId, DATA_DIR));
  }

  printSuccess(`Created ${references.length} stub annotations`);
  return references;
}

// === PASS 5: Resolve References ===
async function resolveReferences(references: PartReference[], client: SemiontClient): Promise<number> {
  printSectionHeader('🎯', 5, 'Resolve References');

  let successCount = 0;

  for (let i = 0; i < references.length; i++) {
    const ref = references[i];
    const shortDocId = ref.documentId.substring(0, 20);
    printBatchProgress(i + 1, references.length, `Resolving "${ref.text}" → ${shortDocId}...`);

    const result = await client.resolveAnnotation(ref.annotationId!, ref.documentId);

    if (result.success) {
      printSuccess('Resolved', 7);
      successCount++;
    } else {
      printWarning(`Failed: ${result.error}`, 7);
    }
  }

  printSuccess(`Resolved ${successCount}/${references.length} references`);
  return successCount;
}

// === PASS 6: Show Document History ===
async function showDocumentHistory(tocId: string, client: SemiontClient): Promise<void> {
  printSectionHeader('📜', 6, 'Document History');

  try {
    const data = await client.getDocumentEvents(tocId);

    if (!data.events || data.events.length === 0) {
      printWarning('No events found for document');
      printInfo(`Total: ${data.total || 0}`);
      printInfo(`Document ID: ${data.documentId || 'unknown'}`);
      return;
    }

    const storedEvents = data.events;
    printInfo(`Total events: ${data.total || storedEvents.length}`);
    console.log('');

    // Group events by type
    const eventsByType: Record<string, number> = {};
    storedEvents.forEach((stored: any) => {
      const type = stored.event?.type || 'unknown';
      eventsByType[type] = (eventsByType[type] || 0) + 1;
    });

    printEventBreakdown(eventsByType);

    // Show recent events (last 10)
    console.log('   Recent events:');
    const recentEvents = storedEvents.slice(-10);
    recentEvents.forEach((stored: any, index: number) => {
      const event = stored.event;
      if (!event) return;

      const eventNum = storedEvents.length - recentEvents.length + index + 1;
      const eventDetails: EventDetails = {
        eventNum,
        sequenceNumber: stored.metadata?.sequenceNumber || '?',
        type: event.type,
        payload: event.payload,
      };

      printEvent(eventDetails);
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printWarning(`Error fetching history: ${message}`);
  }
}

// === PASS 7: Print Results ===
function printFinalResults(tocId: string, chunkIds: string[], resolvedCount: number, totalCount: number): void {
  printResults({
    tocId,
    chunkIds,
    resolvedCount,
    totalCount,
    frontendUrl: FRONTEND_URL,
  });
}

// === Main Execution ===
async function main() {
  printMainHeader('🎭', 'Prometheus Bound Demo');

  try {
    const client = new SemiontClient({
      backendUrl: BACKEND_URL,
      authEmail: AUTH_EMAIL,
    });

    await authenticateWithBackend(client);
    const chunks = await downloadAndChunk();
    const chunkIds = await uploadChunks(chunks, client);
    const { tocId, references } = await createTableOfContents(chunks, client);
    const referencesWithIds = await createStubReferences(tocId, references, chunkIds, client);
    const resolvedCount = await resolveReferences(referencesWithIds, client);
    await showDocumentHistory(tocId, client);
    printFinalResults(tocId, chunkIds, resolvedCount, references.length);

    printCompletion();
  } catch (error) {
    printError(error as Error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
