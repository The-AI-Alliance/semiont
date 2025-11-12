#!/usr/bin/env tsx
/**
 * FreeLaw New Hampshire Demo Script
 *
 * Fetches the first 4 court decisions from the Hugging Face free-law/nh dataset,
 * uploads them to Semiont backend, creates a Table of Contents with linked annotations,
 * and displays the event history showing how annotations evolved.
 *
 * Demonstrates:
 * - Fetching from Hugging Face datasets
 * - Legal document handling
 * - Table of Contents generation
 * - Annotation linking workflow
 * - Event sourcing history
 */

import { SemiontApiClient, baseUrl } from '@semiont/api-client';

// Local modules
import { fetchFirstNDocuments, type HuggingFaceDocument } from './src/huggingface';
import { authenticate } from './src/auth';
import { createTableOfContents, type TableOfContentsReference } from './src/resources';
import { createStubReferences, linkReferences } from './src/annotations';
import { showDocumentHistory } from './src/history';
import {
  printMainHeader,
  printSectionHeader,
  printInfo,
  printSuccess,
  printBatchProgress,
  printFilesystemPath,
  printResults,
  printCompletion,
  printError,
} from './src/display';
import { getLayer1Path } from './src/filesystem-utils';

// ============================================================================
// CONTENT-SPECIFIC CONFIGURATION
// ============================================================================

const DATASET_NAME = 'free-law/nh';
const DOCUMENT_COUNT = 4;
const ENTITY_TYPES = ['legal', 'case-law', 'new-hampshire'];
const TOC_TITLE = 'New Hampshire Supreme Court Cases (Sample)';

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
// DOCUMENT CONVERSION
// ============================================================================

interface DocumentInfo {
  title: string;
  content: string;
  metadata: {
    decisionDate?: string;
    docketNumber?: string;
    citation?: string;
  };
}

function convertToDocumentInfo(doc: HuggingFaceDocument, index: number): DocumentInfo {
  // Create a readable title from case name
  const title = doc.name_abbreviation || doc.name || `Case ${index + 1}`;
  const decisionDate = doc.decision_date || 'Unknown Date';

  // Build citation if available
  let citation = '';
  if (doc.citations && Array.isArray(doc.citations) && doc.citations.length > 0) {
    citation = doc.citations[0].cite || '';
  } else if (doc.volume && doc.reporter && doc.first_page) {
    citation = `${doc.volume} ${doc.reporter} ${doc.first_page}`;
  }

  return {
    title: `${title} (${decisionDate})`,
    content: doc.text || '',
    metadata: {
      decisionDate: doc.decision_date,
      docketNumber: doc.docket_number,
      citation,
    },
  };
}

// ============================================================================
// UPLOAD DOCUMENTS
// ============================================================================

async function uploadDocuments(
  documents: DocumentInfo[],
  client: SemiontApiClient
): Promise<string[]> {
  const documentIds: string[] = [];

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    printBatchProgress(i + 1, documents.length, `Uploading ${doc.title}...`);

    const request = {
      name: doc.title,
      file: Buffer.from(doc.content),
      format: 'text/plain' as const,
      entityTypes: ENTITY_TYPES,
    };

    const response = await client.createResource(request);
    const resourceId = response.resource['@id'] as string;
    documentIds.push(resourceId);
    printSuccess(resourceId, 7);
    printFilesystemPath('Layer 1', getLayer1Path(resourceId, DATA_DIR));
  }

  printSuccess(`All ${documents.length} documents uploaded`);
  return documentIds;
}

// ============================================================================
// CREATE TOC WITH SIMPLE REFERENCES
// ============================================================================

async function createLegalToc(
  documents: DocumentInfo[],
  client: SemiontApiClient
): Promise<{ tocId: string; references: TableOfContentsReference[] }> {
  const timestamp = new Date().toISOString();
  let content = `# ${TOC_TITLE}\n\n`;
  content += `_Generated: ${timestamp}_\n\n`;
  content += `_Dataset: ${DATASET_NAME}_\n\n`;
  content += '## Cases\n\n';
  const references: TableOfContentsReference[] = [];

  documents.forEach((doc, index) => {
    const caseText = `Case ${index + 1}: ${doc.title}`;
    const listItem = `${index + 1}. ${caseText}\n`;
    const start = content.length + `${index + 1}. `.length;
    const end = start + caseText.length;

    references.push({
      text: caseText,
      start,
      end,
      documentId: '', // Will be filled by caller
    });

    content += listItem;
  });

  printInfo(`Creating ToC document with ${documents.length} entries (${timestamp})...`);

  const request = {
    name: TOC_TITLE,
    file: Buffer.from(content),
    format: 'text/markdown' as const,
    entityTypes: [...ENTITY_TYPES, 'table-of-contents'],
  };

  const response = await client.createResource(request);
  const tocId = response.resource['@id'] as string;
  printSuccess(`Created ToC: ${tocId}`);
  printFilesystemPath('Layer 1', getLayer1Path(tocId, DATA_DIR));

  return { tocId, references };
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  printMainHeader('⚖️ ', 'FreeLaw New Hampshire Demo');

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

    // Pass 1: Fetch from Hugging Face
    printSectionHeader('📥', 1, 'Fetch Documents from Hugging Face');
    printInfo(`Fetching first ${DOCUMENT_COUNT} documents from ${DATASET_NAME}...`);
    const rawDocs = await fetchFirstNDocuments(DATASET_NAME, DOCUMENT_COUNT);
    const documents = rawDocs.map((doc, i) => convertToDocumentInfo(doc, i));
    printSuccess(`Fetched ${documents.length} legal documents`);
    documents.forEach((doc, i) => {
      printInfo(`  ${i + 1}. ${doc.title} (${doc.content.length.toLocaleString()} chars)`, 3);
    });

    // Pass 2: Upload Documents
    printSectionHeader('📤', 2, 'Upload Documents');
    const documentIds = await uploadDocuments(documents, client);

    // Pass 3: Create Table of Contents
    printSectionHeader('📑', 3, 'Create Table of Contents');
    const { tocId, references } = await createLegalToc(documents, client);

    // Pass 4: Create Stub References
    printSectionHeader('🔗', 4, 'Create Stub References');
    const referencesWithIds = await createStubReferences(tocId, references, documentIds, client, {
      dataDir: DATA_DIR,
    });

    // Pass 5: Link References to Documents
    printSectionHeader('🎯', 5, 'Link References to Documents');
    const linkedCount = await linkReferences(tocId, referencesWithIds, client);

    // Pass 6: Show Document History
    printSectionHeader('📜', 6, 'Document History');
    await showDocumentHistory(tocId, client);

    // Pass 7: Print Results
    printResults({
      tocId,
      chunkIds: documentIds,
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
