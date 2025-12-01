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
import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SemiontApiClient, baseUrl, resourceUri, type ResourceUri } from '@semiont/api-client';

// Dataset configuration types
import type { DatasetConfig, DatasetConfigWithPaths } from './config/types.js';

// Local modules
import { chunkBySize, chunkText, type ChunkInfo } from './src/chunking';
import { authenticate } from './src/auth';
import {
  uploadChunks,
  uploadDocuments,
  createTableOfContents,
  createDocumentTableOfContents,
  type TableOfContentsReference,
  type DocumentInfo,
} from './src/resources';
import { createStubReferences, linkReferences } from './src/annotations';
import { showDocumentHistory } from './src/history';
import { detectCitations } from './src/legal-citations';
import { getLayer1Path } from './src/filesystem-utils';
import { TerminalApp } from './src/terminal-app.js';
import { validateResources, formatValidationResults } from './src/validation.js';
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

/**
 * Dynamically load all dataset configurations from the config directory
 * Each dataset should be in its own subdirectory with a config.ts file
 * Scans both config/ and config/private/ directories
 */
async function loadDatasets(): Promise<Record<string, DatasetConfigWithPaths>> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const configDir = join(__dirname, 'config');

  const datasets: Record<string, DatasetConfigWithPaths> = {};

  /**
   * Scan a directory for dataset configurations
   * @param basePath - The base directory to scan (e.g., 'config' or 'config/private')
   * @param relativePathPrefix - The relative path prefix for state files (e.g., 'config' or 'config/private')
   */
  async function scanDirectory(basePath: string, relativePathPrefix: string) {
    if (!existsSync(basePath)) {
      return;
    }

    // Read all entries in the directory
    const entries = readdirSync(basePath, { withFileTypes: true });

    for (const entry of entries) {
      // Only process directories (skip files like types.ts, README.md, .gitignore)
      if (!entry.isDirectory()) {
        continue;
      }

      // Look for config.ts within the dataset directory
      const configPath = join(basePath, entry.name, 'config.ts');

      // Skip if config.ts doesn't exist (e.g., private/ is a container directory, not a dataset)
      if (!existsSync(configPath)) {
        continue;
      }

      try {
        const module = await import(configPath);

        if (module.config && typeof module.config === 'object') {
          const config = module.config as DatasetConfig;

          // Add computed stateFile path
          const configWithPaths: DatasetConfigWithPaths = {
            ...config,
            stateFile: join(relativePathPrefix, entry.name, '.state.json'),
          };

          datasets[config.name] = configWithPaths;
        }
      } catch (error) {
        // Skip directories that don't have a valid config.ts
        console.warn(`Warning: Could not load config from ${relativePathPrefix}/${entry.name}:`, error instanceof Error ? error.message : error);
      }
    }
  }

  // Scan public configs in config/
  await scanDirectory(configDir, 'config');

  // Scan private configs in config/private/
  await scanDirectory(join(configDir, 'private'), 'config/private');

  return datasets;
}

// Load datasets at startup
const DATASETS = await loadDatasets();

// ============================================================================
// ENVIRONMENT CONFIGURATION
// ============================================================================

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const AUTH_EMAIL = process.env.AUTH_EMAIL || 'you@example.com';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
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
  chunkIds?: ResourceUri[];
  documentIds?: ResourceUri[];
  references?: TableOfContentsReference[];
  formattedText: string;
}

function saveState(dataset: DatasetConfigWithPaths, state: Omit<DemoState, 'dataset'>): void {
  const fullState: DemoState = { dataset: dataset.name, ...state };
  writeFileSync(dataset.stateFile, JSON.stringify(fullState, null, 2));
  printSuccess(`State saved to ${dataset.stateFile}`);
}

function loadState(dataset: DatasetConfigWithPaths): DemoState {
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
      password: AUTH_PASSWORD,
      accessToken: ACCESS_TOKEN,
    });

    // Branch: Multi-document vs Single-document workflow
    let chunkIds: ResourceUri[];
    let tocId: ResourceUri | undefined;
    let references: TableOfContentsReference[] | undefined;
    let formattedText = '';

    if (dataset.isMultiDocument && dataset.loadDocuments) {
      // Multi-document workflow
      printSectionHeader('📥', 1, 'Load Documents');
      const documents = await dataset.loadDocuments();

      // Pass 2: Upload Documents
      printSectionHeader('📤', 2, 'Upload Documents');
      chunkIds = await uploadDocuments(documents, client, {
        entityTypes: dataset.entityTypes,
        dataDir: DATA_DIR,
      });

      // Pass 3: Create Table of Contents (if needed)
      if (dataset.createTableOfContents) {
        printSectionHeader('📑', 3, 'Create Table of Contents');
        const result = await createDocumentTableOfContents(documents, client, {
          title: dataset.tocTitle!,
          entityTypes: dataset.entityTypes,
          dataDir: DATA_DIR,
        });
        tocId = result.tocId;
        references = result.references;
      }
    } else if (dataset.loadText) {
      // Single-document workflow
      printSectionHeader('📥', 1, 'Load Document');
      formattedText = await dataset.loadText();

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
      chunkIds = await uploadChunks(chunks, client, {
        entityTypes: dataset.entityTypes,
        dataDir: DATA_DIR,
      });

      // Pass 4: Create Table of Contents (if needed)
      if (dataset.createTableOfContents) {
        printSectionHeader('📑', 4, 'Create Table of Contents');
        const result = await createTableOfContents(chunks, client, {
          title: dataset.tocTitle!,
          entityTypes: dataset.entityTypes,
          dataDir: DATA_DIR,
        });
        tocId = result.tocId;
        references = result.references;
      }
    } else {
      throw new Error(`Dataset ${dataset.name} must have either loadText or loadDocuments configured`);
    }

    // Shared workflow: Create stub references and link (if TOC was created)
    if (dataset.createTableOfContents && tocId && references) {

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
      password: AUTH_PASSWORD,
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

    if (!state.chunkIds || state.chunkIds.length === 0) {
      printError(new Error('No chunks found in state. Run the load command first.'));
      process.exit(1);
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
// COMMAND: VALIDATE
// ============================================================================

async function validateCommand(datasetName: string) {
  const dataset = DATASETS[datasetName];
  if (!dataset) {
    throw new Error(`Unknown dataset: ${datasetName}. Available: ${Object.keys(DATASETS).join(', ')}`);
  }

  printMainHeader(dataset.emoji, `${dataset.displayName} Demo - Validate`);

  try {
    const client = new SemiontApiClient({
      baseUrl: baseUrl(BACKEND_URL),
    });

    // Pass 0: Authentication
    printSectionHeader('🔐', 0, 'Authentication');
    await authenticate(client, {
      email: AUTH_EMAIL,
      password: AUTH_PASSWORD,
      accessToken: ACCESS_TOKEN,
    });

    // Load state from load command
    printSectionHeader('📂', 1, 'Load State');
    const state = loadState(dataset);

    // Collect all resource URIs
    const allResources: ResourceUri[] = [];

    if (state.tocId) {
      allResources.push(state.tocId);
    }

    if (state.chunkIds) {
      allResources.push(...state.chunkIds);
    }

    if (state.documentIds) {
      allResources.push(...state.documentIds);
    }

    printSuccess(`Found ${allResources.length} resources to validate`);
    console.log();

    // Pass 2: Validate Resources
    printSectionHeader('✓', 2, 'Validate Resources');
    const results = await validateResources(allResources, client);

    // Display results
    const formattedLines = formatValidationResults(results);
    formattedLines.forEach(line => console.log(line));

    // Summary
    const successCount = results.filter(r => r.status === 'success').length;
    const errorCount = results.filter(r => r.status === 'error').length;

    console.log();
    console.log('📊 Summary:');
    console.log(`   Total resources: ${results.length}`);
    console.log(`   ✓ Successful: ${successCount}`);
    if (errorCount > 0) {
      console.log(`   ✗ Errors: ${errorCount}`);
    }

    printCompletion();
  } catch (error) {
    printError(error as Error);
    process.exit(1);
  }
}

// ============================================================================
// EXPORTS (for interactive terminal app)
// ============================================================================

export { downloadCommand, loadCommand, annotateCommand, validateCommand };

// ============================================================================
// CLI SETUP
// ============================================================================

const program = new Command();

program
  .name('demo')
  .description('Semiont demo script for multiple datasets\n\nUse --interactive (or --app, --terminal) to launch the interactive terminal UI')
  .version('0.1.0');

program
  .command('<dataset> <command>')
  .description(`Run a command on a dataset. Datasets: ${Object.keys(DATASETS).join(', ')}. Commands: download, load, annotate, validate`)
  .action((dataset: string, command: string) => {
    if (command === 'download') {
      return downloadCommand(dataset);
    } else if (command === 'load') {
      return loadCommand(dataset);
    } else if (command === 'annotate') {
      return annotateCommand(dataset);
    } else if (command === 'validate') {
      return validateCommand(dataset);
    } else {
      console.error(`Unknown command: ${command}. Use 'download', 'load', 'annotate', or 'validate'.`);
      process.exit(1);
    }
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  // Check for interactive mode flags before Commander processes them
  const hasInteractiveFlag = process.argv.some(arg =>
    arg === '--interactive' || arg === '--app' || arg === '--terminal'
  );

  if (hasInteractiveFlag) {
    // Launch interactive mode directly
    const app = new TerminalApp(DATASETS);
    app.run();
  } else {
    // Show help if no command provided
    if (process.argv.length === 2) {
      program.help();
    }

    // Parse commands normally
    program.parse(process.argv);
  }
}
