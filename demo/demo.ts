#!/usr/bin/env tsx
/**
 * Semiont Demo Script
 *
 * Demonstrates document processing, chunking, annotation, and linking workflows
 * for multiple datasets.
 *
 * Workflow:
 *   Download Phase (optional):
 *     - Fetch content from remote source (Cornell LII, arXiv API, etc.)
 *     - Cache raw content in data/tmp/
 *     - Skip if dataset is already local (e.g., hiking.txt)
 *
 *   Load Phase:
 *     - Read from local cache
 *     - Format and process text
 *     - Chunk document (if configured)
 *     - Upload chunks to backend
 *     - Create Table of Contents (if configured)
 *     - Link TOC references to documents (if configured)
 *
 *   Annotate Phase:
 *     - Detect patterns in text (e.g., legal citations)
 *     - Create annotations via API
 *
 * Usage:
 *   tsx demo.ts <dataset> download   # Download and cache raw content
 *   tsx demo.ts <dataset> load       # Process cache and upload to backend
 *   tsx demo.ts <dataset> annotate   # Detect citations and create annotations
 *
 * Available datasets:
 *   - citizens_united: Supreme Court case (chunked, TOC+links, citation detection)
 *   - hiking: Simple text document (single doc, no TOC, no citations)
 *   - arxiv: Research paper from arXiv.org (single doc, no TOC, no citations)
 *   - prometheus_bound: Ancient Greek drama from Project Gutenberg (smart-chunked, TOC+links, no citations)
 */

import { Command } from 'commander';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { SemiontApiClient, baseUrl, resourceUri, type ResourceUri } from '@semiont/api-client';

// Local modules
import { downloadCornellLII, formatLegalOpinion } from './src/legal-text';
import { fetchArxivPaper, formatArxivPaper } from './src/arxiv';
import { chunkBySize, chunkText, downloadText, extractSection, type ChunkInfo } from './src/chunking';
import { authenticate } from './src/auth';
import { uploadChunks, createTableOfContents, type TableOfContentsReference } from './src/resources';
import { createStubReferences, linkReferences } from './src/annotations';
import { showDocumentHistory } from './src/history';
import { detectCitations } from './src/legal-citations';
import { getLayer1Path } from './src/filesystem-utils';
import {
  printMainHeader,
  printSectionHeader,
  printInfo,
  printSuccess,
  printDownloadStats,
  printChunkingStats,
  printBatchProgress,
  printResults,
  printCompletion,
  printError,
  printFilesystemPath,
} from './src/display';

// ============================================================================
// DATASET CONFIGURATIONS
// ============================================================================

interface DatasetConfig {
  name: string;
  displayName: string;
  emoji: string;
  shouldChunk: boolean;
  chunkSize?: number;
  useSmartChunking?: boolean; // If true, use paragraph-aware chunking instead of fixed-size
  entityTypes: string[];
  createTableOfContents: boolean;
  tocTitle?: string;
  stateFile: string;
  detectCitations: boolean;
  cacheFile: string;
  downloadContent?: () => Promise<void>;
  loadText: () => Promise<string>;
  extractionConfig?: {
    startPattern: RegExp;
    endMarker: string;
  };
}

const DATASETS: Record<string, DatasetConfig> = {
  citizens_united: {
    name: 'citizens_united',
    displayName: 'Citizens United v. FEC',
    emoji: '⚖️ ',
    shouldChunk: true,
    chunkSize: 5000, // ~2-3 pages per chunk
    entityTypes: ['legal', 'supreme-court', 'campaign-finance', 'first-amendment', 'LegalCitation'],
    createTableOfContents: true,
    tocTitle: 'Citizens United v. FEC - Table of Contents',
    stateFile: '.demo-citizens-united-state.json',
    detectCitations: true,
    cacheFile: 'data/tmp/citizens_united.html',
    downloadContent: async () => {
      printInfo('Downloading from Cornell LII...');
      const url = 'https://www.law.cornell.edu/supct/html/08-205.ZS.html';
      const rawText = await downloadCornellLII(url);
      printSuccess(`Downloaded ${rawText.length.toLocaleString()} characters`);

      writeFileSync('data/tmp/citizens_united.html', rawText);
      printSuccess('Saved to data/tmp/citizens_united.html');
    },
    loadText: async () => {
      printInfo('Loading from data/tmp/citizens_united.html...');
      const rawText = readFileSync('data/tmp/citizens_united.html', 'utf-8');
      printSuccess(`Loaded ${rawText.length.toLocaleString()} characters`);

      printInfo('Formatting with markdown...');
      const caseTitle = 'Citizens United v. Federal Election Commission';
      const citation = '558 U.S. 310 (2010)';
      const formattedText = formatLegalOpinion(caseTitle, citation, rawText);
      printSuccess(`Formatted opinion: ${formattedText.length.toLocaleString()} characters`);

      return formattedText;
    },
  },
  hiking: {
    name: 'hiking',
    displayName: 'Hiking Notes',
    emoji: '🥾 ',
    shouldChunk: false,
    entityTypes: ['text', 'hiking', 'outdoor'],
    createTableOfContents: false,
    stateFile: '.demo-hiking-state.json',
    detectCitations: false,
    cacheFile: 'data/hiking.txt', // Already local, no download needed
    loadText: async () => {
      printInfo('Loading from data/hiking.txt...');
      const text = readFileSync('data/hiking.txt', 'utf-8');
      printSuccess(`Loaded ${text.length.toLocaleString()} characters`);
      return text;
    },
  },
  arxiv: {
    name: 'arxiv',
    displayName: 'Attention Is All You Need',
    emoji: '📄',
    shouldChunk: false,
    entityTypes: ['research-paper', 'ai', 'transformers', 'deep-learning'],
    createTableOfContents: false,
    stateFile: '.demo-arxiv-state.json',
    detectCitations: false,
    cacheFile: 'data/tmp/arxiv_1706.03762.json',
    downloadContent: async () => {
      const arxivId = '1706.03762';
      printInfo(`Fetching arXiv:${arxivId}...`);
      const paper = await fetchArxivPaper(arxivId);
      printSuccess(`Fetched: "${paper.title}"`);
      printInfo(`Authors: ${paper.authors.slice(0, 3).join(', ')}${paper.authors.length > 3 ? `, et al. (${paper.authors.length} total)` : ''}`, 3);
      printInfo(`Published: ${new Date(paper.published).toLocaleDateString()}`, 3);
      printInfo(`Categories: ${paper.categories.slice(0, 3).join(', ')}`, 3);
      printInfo(`Abstract: ${paper.abstract.length} characters`, 3);

      writeFileSync('data/tmp/arxiv_1706.03762.json', JSON.stringify(paper, null, 2));
      printSuccess('Saved to data/tmp/arxiv_1706.03762.json');
    },
    loadText: async () => {
      printInfo('Loading from data/tmp/arxiv_1706.03762.json...');
      const paperData = readFileSync('data/tmp/arxiv_1706.03762.json', 'utf-8');
      const paper = JSON.parse(paperData);
      printSuccess(`Loaded: "${paper.title}"`);

      printInfo('Formatting as markdown...');
      const formattedContent = formatArxivPaper(paper);
      printSuccess(`Formatted: ${formattedContent.length.toLocaleString()} characters`);

      return formattedContent;
    },
  },
  prometheus_bound: {
    name: 'prometheus_bound',
    displayName: 'Prometheus Bound',
    emoji: '🎭',
    shouldChunk: true,
    chunkSize: 4000,
    useSmartChunking: true,
    entityTypes: ['literature', 'ancient-greek-drama'],
    createTableOfContents: true,
    tocTitle: 'Prometheus Bound: Table of Contents',
    stateFile: '.demo-prometheus-bound-state.json',
    detectCitations: false,
    cacheFile: 'data/tmp/prometheus_bound.txt',
    extractionConfig: {
      startPattern: /PROMETHEUS BOUND\s+ARGUMENT/,
      endMarker: '*** END OF THE PROJECT GUTENBERG EBOOK FOUR PLAYS OF AESCHYLUS ***',
    },
    downloadContent: async () => {
      printInfo('Downloading from Project Gutenberg...');
      const url = 'https://www.gutenberg.org/cache/epub/8714/pg8714.txt';
      const fullText = await downloadText(url);
      printSuccess(`Downloaded ${fullText.length.toLocaleString()} characters`);

      writeFileSync('data/tmp/prometheus_bound.txt', fullText);
      printSuccess('Saved to data/tmp/prometheus_bound.txt');
    },
    loadText: async () => {
      printInfo('Loading from data/tmp/prometheus_bound.txt...');
      const fullText = readFileSync('data/tmp/prometheus_bound.txt', 'utf-8');
      printSuccess(`Loaded ${fullText.length.toLocaleString()} characters`);

      printInfo('Extracting "Prometheus Bound" section...');
      const extractedText = extractSection(
        fullText,
        /PROMETHEUS BOUND\s+ARGUMENT/,
        '*** END OF THE PROJECT GUTENBERG EBOOK FOUR PLAYS OF AESCHYLUS ***'
      );
      printSuccess(`Extracted ${extractedText.length.toLocaleString()} characters`);

      return extractedText;
    },
  },
};

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
// STATE MANAGEMENT
// ============================================================================

interface DemoState {
  dataset: string;
  tocId?: ResourceUri;
  chunkIds: ResourceUri[];
  references?: TableOfContentsReference[];
  formattedText: string;
}

function saveState(dataset: DatasetConfig, state: Omit<DemoState, 'dataset'>): void {
  const fullState: DemoState = { dataset: dataset.name, ...state };
  writeFileSync(dataset.stateFile, JSON.stringify(fullState, null, 2));
  printSuccess(`State saved to ${dataset.stateFile}`);
}

function loadState(dataset: DatasetConfig): DemoState {
  if (!existsSync(dataset.stateFile)) {
    throw new Error(`State file ${dataset.stateFile} not found. Run 'load' command first.`);
  }
  const data = readFileSync(dataset.stateFile, 'utf-8');
  const state: DemoState = JSON.parse(data);

  if (state.dataset !== dataset.name) {
    throw new Error(`State file is for dataset '${state.dataset}', but you requested '${dataset.name}'`);
  }

  return state;
}

// ============================================================================
// COMMAND: DOWNLOAD
// ============================================================================

async function downloadCommand(datasetName: string) {
  const dataset = DATASETS[datasetName];
  if (!dataset) {
    throw new Error(`Unknown dataset: ${datasetName}. Available: ${Object.keys(DATASETS).join(', ')}`);
  }

  printMainHeader(dataset.emoji, `${dataset.displayName} Demo - Download`);

  try {
    // Check if already cached
    if (existsSync(dataset.cacheFile)) {
      printInfo(`Cache file already exists: ${dataset.cacheFile}`);
      console.log('💡 Use --force to re-download, or run the load command to proceed.');
      return;
    }

    // Check if download is needed
    if (!dataset.downloadContent) {
      printInfo('This dataset is already local, no download needed.');
      printSuccess(`Using: ${dataset.cacheFile}`);
      printCompletion();
      return;
    }

    // Ensure data/tmp directory exists
    const { mkdirSync } = await import('node:fs');
    mkdirSync('data/tmp', { recursive: true });

    // Download content
    printSectionHeader('📥', 1, 'Download Content');
    await dataset.downloadContent();

    printCompletion();
    console.log(`\n💡 Next step: Run "tsx demo.ts ${datasetName} load" to process and upload\n`);
  } catch (error) {
    printError(error as Error);
    process.exit(1);
  }
}

// ============================================================================
// COMMAND: LOAD
// ============================================================================

async function loadCommand(datasetName: string) {
  const dataset = DATASETS[datasetName];
  if (!dataset) {
    throw new Error(`Unknown dataset: ${datasetName}. Available: ${Object.keys(DATASETS).join(', ')}`);
  }

  printMainHeader(dataset.emoji, `${dataset.displayName} Demo - Load`);

  try {
    // Check if cache file exists
    if (!existsSync(dataset.cacheFile)) {
      printError(new Error(`Cache file not found: ${dataset.cacheFile}`));
      console.log(`\n💡 Run "tsx demo.ts ${datasetName} download" first to download the content.\n`);
      process.exit(1);
    }

    const client = new SemiontApiClient({
      baseUrl: baseUrl(BACKEND_URL),
    });

    // Pass 0: Authentication
    printSectionHeader('🔐', 0, 'Authentication');
    await authenticate(client, {
      email: AUTH_EMAIL,
      accessToken: ACCESS_TOKEN,
    });

    // Pass 1: Load Document
    printSectionHeader('📥', 1, 'Load Document');
    const formattedText = await dataset.loadText();

    // Pass 2: Chunk the Document (or create single chunk)
    let chunks: ChunkInfo[];
    if (dataset.shouldChunk) {
      printSectionHeader('✂️ ', 2, 'Chunk Document');
      if (dataset.useSmartChunking) {
        printInfo(`Chunking at paragraph boundaries (~${dataset.chunkSize} chars per chunk)...`);
        chunks = chunkText(formattedText, dataset.chunkSize!, `${dataset.displayName} - Part`);
      } else {
        printInfo(`Chunking into sections (~${dataset.chunkSize} chars per chunk)...`);
        chunks = chunkBySize(formattedText, dataset.chunkSize!, `${dataset.displayName} - Part`);
      }
      const totalChars = chunks.reduce((sum, c) => sum + c.content.length, 0);
      const avgChars = Math.round(totalChars / chunks.length);
      printDownloadStats(totalChars, totalChars);
      printChunkingStats(chunks.length, avgChars);
    } else {
      printSectionHeader('📄', 2, 'Create Single Document');
      printInfo('Loading as a single document (no chunking)...');
      chunks = [{
        title: dataset.displayName,
        content: formattedText,
        partNumber: 1,
      }];
      printSuccess(`Created single document with ${formattedText.length.toLocaleString()} characters`);
    }

    // Pass 3: Upload Chunks
    printSectionHeader('📤', 3, 'Upload Chunks');
    const chunkIds = await uploadChunks(chunks, client, {
      entityTypes: dataset.entityTypes,
      dataDir: DATA_DIR,
    });

    // Pass 4: Create Table of Contents (if needed)
    let tocId: ResourceUri | undefined;
    let references: TableOfContentsReference[] | undefined;
    if (dataset.createTableOfContents) {
      printSectionHeader('📑', 4, 'Create Table of Contents');
      const result = await createTableOfContents(chunks, client, {
        title: dataset.tocTitle!,
        entityTypes: dataset.entityTypes,
        dataDir: DATA_DIR,
      });
      tocId = result.tocId;
      references = result.references;

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
    } else {
      // Pass 4: Show Document History (for non-TOC datasets)
      printSectionHeader('📜', 4, 'Document History');
      await showDocumentHistory(chunkIds[0], client);

      // Print results
      printSectionHeader('✨', 5, 'Results');
      console.log();
      console.log('📄 Document:');
      const parts = chunkIds[0].split('/resources/');
      if (parts.length !== 2 || !parts[1]) {
        throw new Error(`Invalid resource ID format: ${chunkIds[0]}`);
      }
      const resourceId = parts[1];
      console.log(`   ${FRONTEND_URL}/en/know/resource/${resourceId}`);
      console.log();
      printFilesystemPath('Layer 1', getLayer1Path(chunkIds[0], DATA_DIR));
    }

    // Save state for annotate command
    saveState(dataset, {
      tocId,
      chunkIds,
      references,
      formattedText,
    });

    printCompletion();
    if (dataset.detectCitations) {
      console.log(`\n💡 Next step: Run "tsx demo.ts ${datasetName} annotate" to detect citations\n`);
    }
  } catch (error) {
    printError(error as Error);
    process.exit(1);
  }
}

// ============================================================================
// COMMAND: ANNOTATE
// ============================================================================

async function annotateCommand(datasetName: string) {
  const dataset = DATASETS[datasetName];
  if (!dataset) {
    throw new Error(`Unknown dataset: ${datasetName}. Available: ${Object.keys(DATASETS).join(', ')}`);
  }

  printMainHeader(dataset.emoji, `${dataset.displayName} Demo - Annotate`);

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

    // Load state from load command
    printSectionHeader('📂', 1, 'Load State');
    const state = loadState(dataset);

    // Check if this dataset supports citation detection
    if (!dataset.detectCitations) {
      printInfo('This dataset does not support the annotate command (no citations to detect)');
      printCompletion();
      return;
    }

    printSuccess(`Loaded ${state.chunkIds.length} chunk IDs`);

    // Re-chunk the text to get chunk content for annotation detection
    let chunks: ChunkInfo[];
    if (dataset.shouldChunk) {
      if (dataset.useSmartChunking) {
        chunks = chunkText(state.formattedText, dataset.chunkSize!, `${dataset.displayName} - Part`);
      } else {
        chunks = chunkBySize(state.formattedText, dataset.chunkSize!, `${dataset.displayName} - Part`);
      }
    } else {
      chunks = [{
        title: dataset.displayName,
        content: state.formattedText,
        partNumber: 1,
      }];
    }

    let totalAnnotations = 0;

    // Pass 2: Detect Legal Citations
    printSectionHeader('⚖️ ', 2, 'Detect Legal Citations');

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkId = state.chunkIds[i];

      printBatchProgress(i + 1, chunks.length, `Scanning "${chunk.title}"...`);

      const citations = await detectCitations(chunk.content);

      if (citations.length > 0) {
        printInfo(`Found ${citations.length} citation(s)`, 7);

        for (const citation of citations) {
          await client.createAnnotation(resourceUri(chunkId), {
            motivation: 'linking',
            target: {
              source: chunkId,
              selector: [
                {
                  type: 'TextPositionSelector',
                  start: citation.start,
                  end: citation.end,
                },
                {
                  type: 'TextQuoteSelector',
                  exact: citation.text,
                },
              ],
            },
            body: [{
              type: 'TextualBody',
              value: 'LegalCitation',
              purpose: 'tagging',
            }],
          });

          totalAnnotations++;
        }
      }
    }

    printSuccess(`Detected and tagged ${totalAnnotations} legal citations across ${chunks.length} chunks`);

    // Pass 3: Show Document History
    printSectionHeader('📜', 3, 'Document History');
    await showDocumentHistory(state.chunkIds[0], client);

    // Pass 4: Print Summary
    console.log();
    console.log('📊 Summary:');
    console.log(`   Citations detected: ${totalAnnotations}`);

    printCompletion();
  } catch (error) {
    printError(error as Error);
    process.exit(1);
  }
}

// ============================================================================
// CLI SETUP
// ============================================================================

const program = new Command();

program
  .name('demo')
  .description('Semiont demo script for multiple datasets')
  .version('0.1.0');

program
  .command('<dataset> <command>')
  .description(`Run a command on a dataset. Datasets: ${Object.keys(DATASETS).join(', ')}. Commands: download, load, annotate`)
  .action((dataset: string, command: string) => {
    if (command === 'download') {
      return downloadCommand(dataset);
    } else if (command === 'load') {
      return loadCommand(dataset);
    } else if (command === 'annotate') {
      return annotateCommand(dataset);
    } else {
      console.error(`Unknown command: ${command}. Use 'download', 'load', or 'annotate'.`);
      process.exit(1);
    }
  });

// Show help if no command provided
if (process.argv.length === 2) {
  program.help();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse(process.argv);
}
