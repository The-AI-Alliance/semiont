#!/usr/bin/env tsx
/**
 * Citizens United v. FEC Demo Script
 *
 * Downloads the famous Citizens United Supreme Court case, chunks it into
 * readable sections, uploads to Semiont backend, creates a Table of Contents
 * with linked annotations, and displays the event history.
 *
 * Demonstrates:
 * - Legal opinion downloading from Cornell LII
 * - Large document chunking (2-3 pages per chunk)
 * - Markdown formatting for legal text
 * - Table of Contents generation
 * - Annotation linking workflow
 */

import { SemiontApiClient, baseUrl } from '@semiont/api-client';

// Local modules
import { downloadCornellLII, formatLegalOpinion } from './src/legal-text';
import { chunkBySize } from './src/chunking';
import { authenticate } from './src/auth';
import { uploadChunks, createTableOfContents } from './src/resources';
import { createStubReferences, linkReferences } from './src/annotations';
import { showDocumentHistory } from './src/history';
import {
  printMainHeader,
  printSectionHeader,
  printInfo,
  printSuccess,
  printDownloadStats,
  printChunkingStats,
  printResults,
  printCompletion,
  printError,
} from './src/display';

// ============================================================================
// CONTENT-SPECIFIC CONFIGURATION
// ============================================================================

const CORNELL_LII_URL = 'https://www.law.cornell.edu/supct/html/08-205.ZS.html';
const CASE_TITLE = 'Citizens United v. Federal Election Commission';
const CITATION = '558 U.S. 310 (2010)';
const CHUNK_SIZE = 5000; // ~2-3 pages per chunk
const ENTITY_TYPES = ['legal', 'supreme-court', 'campaign-finance', 'first-amendment'];
const TOC_TITLE = 'Citizens United v. FEC - Table of Contents';

// ============================================================================
// ENVIRONMENT CONFIGURATION
// ============================================================================

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const AUTH_EMAIL = process.env.AUTH_EMAIL || 'you@example.com';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const DATA_DIR = process.env.DATA_DIR || '/tmp/semiont/data/uploads';

if (!AUTH_EMAIL && !ACCESS_TOKEN) {
  throw new Error('Either AUTH_EMAIL or ACCESS_TOKEN must be provided');
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  printMainHeader('⚖️ ', 'Citizens United v. FEC Demo');

  try {
    const client = new SemiontApiClient({
      baseUrl: baseUrl(BACKEND_URL),
    });

    // Pass 0: Authentication
    printSectionHeader('🔐', 0, 'Authentication');
    await authenticate(client, {
      email: AUTH_EMAIL,
      accessToken: ACCESS_TOKEN,
    });

    // Pass 1: Download and Format
    printSectionHeader('📥', 1, 'Download Legal Opinion');
    printInfo('Downloading from Cornell LII...');
    const rawText = await downloadCornellLII(CORNELL_LII_URL);
    printSuccess(`Downloaded ${rawText.length.toLocaleString()} characters`);

    printInfo('Formatting with markdown...');
    const formattedText = formatLegalOpinion(CASE_TITLE, CITATION, rawText);
    printSuccess(`Formatted opinion: ${formattedText.length.toLocaleString()} characters`);

    // Pass 2: Chunk the Opinion
    printSectionHeader('✂️ ', 2, 'Chunk Opinion');
    printInfo(`Chunking into sections (~${CHUNK_SIZE} chars per chunk)...`);

    const chunks = chunkBySize(formattedText, CHUNK_SIZE, `${CASE_TITLE} - Part`);
    const totalChars = chunks.reduce((sum, c) => sum + c.content.length, 0);
    const avgChars = Math.round(totalChars / chunks.length);
    printDownloadStats(totalChars, totalChars);
    printChunkingStats(chunks.length, avgChars);

    // Pass 3: Upload Chunks
    printSectionHeader('📤', 3, 'Upload Opinion Chunks');
    const chunkIds = await uploadChunks(chunks, client, {
      entityTypes: ENTITY_TYPES,
      dataDir: DATA_DIR,
    });

    // Pass 4: Create Table of Contents
    printSectionHeader('📑', 4, 'Create Table of Contents');
    const { tocId, references } = await createTableOfContents(chunks, client, {
      title: TOC_TITLE,
      entityTypes: ENTITY_TYPES,
      dataDir: DATA_DIR,
    });

    // Pass 5: Create Stub References
    printSectionHeader('🔗', 5, 'Create Stub References');
    const referencesWithIds = await createStubReferences(tocId, references, chunkIds, client, {
      dataDir: DATA_DIR,
    });

    // Pass 6: Link References to Documents
    printSectionHeader('🎯', 6, 'Link References to Documents');
    const linkedCount = await linkReferences(tocId, referencesWithIds, client);

    // Pass 7: Show Document History
    printSectionHeader('📜', 7, 'Document History');
    await showDocumentHistory(tocId, client);

    // Pass 8: Print Results
    printResults({
      tocId,
      chunkIds,
      linkedCount,
      totalCount: references.length,
      frontendUrl: FRONTEND_URL,
    });

    printCompletion();
  } catch (error) {
    printError(error as Error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
