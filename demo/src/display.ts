/**
 * Display and Output Formatting
 *
 * Console output utilities for progress tracking and results display.
 */

import type { ChunkInfo } from './chunking';

/**
 * Prints a section header with emoji and separator line
 */
export function printSectionHeader(emoji: string, passNumber: number, title: string): void {
  console.log(`\n${emoji} PASS ${passNumber}: ${title}`);
  console.log('━'.repeat(60));
}

/**
 * Prints a main header with double-line separator
 */
export function printMainHeader(emoji: string, title: string): void {
  console.log(`\n${emoji} ${title}`);
  console.log('═'.repeat(60));
}

/**
 * Prints a success message with checkmark
 */
export function printSuccess(message: string, indent: number = 3): void {
  console.log(`${' '.repeat(indent)}✅ ${message}`);
}

/**
 * Prints an info message
 */
export function printInfo(message: string, indent: number = 3): void {
  console.log(`${' '.repeat(indent)}${message}`);
}

/**
 * Prints a warning message
 */
export function printWarning(message: string, indent: number = 3): void {
  console.log(`${' '.repeat(indent)}⚠️  ${message}`);
}

/**
 * Prints a filesystem path with folder emoji
 */
export function printFilesystemPath(label: string, path: string, indent: number = 7): void {
  console.log(`${' '.repeat(indent)}📁 ${label}: ${path}`);
}

/**
 * Prints progress for a batch operation
 */
export function printBatchProgress(current: number, total: number, message: string): void {
  console.log(`   [${current}/${total}] ${message}`);
}

/**
 * Prints download statistics
 */
export function printDownloadStats(totalChars: number, extractedChars: number): void {
  printSuccess(`Downloaded ${totalChars.toLocaleString()} characters`);
  printSuccess(`Extracted play: ${extractedChars.toLocaleString()} characters`);
}

/**
 * Prints chunking statistics
 */
export function printChunkingStats(numChunks: number, avgSize: number): void {
  printSuccess(`Created ${numChunks} chunks (avg ${avgSize} chars)`);
}

/**
 * Prints annotation details with short ID
 */
export function printAnnotationCreated(fullAnnotationId: string): void {
  // Extract short ID from full annotation ID (after last slash)
  const shortId = fullAnnotationId.split('/').pop() || fullAnnotationId;
  printSuccess(`Annotation ${shortId}`, 7);
}

/**
 * Prints event history breakdown by type
 */
export function printEventBreakdown(eventsByType: Record<string, number>): void {
  console.log('   Event breakdown:');
  Object.entries(eventsByType).forEach(([type, count]) => {
    console.log(`     • ${type}: ${count}`);
  });
  console.log('');
}

/**
 * Prints a single event from event history
 */
export interface EventDetails {
  eventNum: number;
  sequenceNumber: number | string;
  type: string;
  payload?: {
    exact?: string;
    position?: { offset?: number };
    targetDocumentId?: string;
  };
}

export function printEvent(event: EventDetails): void {
  console.log(`     [${event.eventNum}] seq=${event.sequenceNumber} - ${event.type}`);

  if (event.type === 'annotation.added' && event.payload) {
    const exact = event.payload.exact || 'unknown';
    const offset = event.payload.position?.offset ?? '?';
    console.log(`         → Created: "${exact}" at offset ${offset}`);
  } else if (event.type === 'annotation.body.updated' && event.payload) {
    const targetId = event.payload.targetDocumentId || 'unknown';
    console.log(`         → Linked to: ${targetId.substring(0, 40)}...`);
  }
}

/**
 * Prints final results summary
 */
export interface ResultsSummary {
  tocId: string;
  chunkIds: string[];
  linkedCount: number;
  totalCount: number;
  frontendUrl: string;
}

export function printResults(summary: ResultsSummary): void {
  printSectionHeader('✨', 7, 'Results');

  // Extract resource ID from full URI
  const getTocResourceId = (uri: string) => uri.split('/resources/')[1];

  console.log('\n📋 Table of Contents:');
  console.log(`   ${summary.frontendUrl}/en/know/resource/${getTocResourceId(summary.tocId)}`);

  console.log('\n📚 Document Chunks:');
  summary.chunkIds.forEach((id, index) => {
    console.log(`   Part ${index + 1}: ${summary.frontendUrl}/en/know/resource/${getTocResourceId(id)}`);
  });

  console.log('\n📊 Summary:');
  console.log(`   Total chunks: ${summary.chunkIds.length}`);
  console.log(`   Annotations created: ${summary.totalCount}`);
  console.log(`   Annotations linked: ${summary.linkedCount}`);

  if (summary.linkedCount < summary.totalCount) {
    const pending = summary.totalCount - summary.linkedCount;
    printWarning(`${pending} annotations failed to link`);
  }
}

/**
 * Prints completion message
 */
export function printCompletion(): void {
  console.log('\n✅ Complete!');
  console.log('═'.repeat(60) + '\n');
}

/**
 * Prints error message
 */
export function printError(error: Error | string): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('\n❌ Error:', message);
}
