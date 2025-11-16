/**
 * FreeLaw New Hampshire Dataset Configuration
 *
 * Legal case documents from HuggingFace demonstrating:
 * - Multi-document workflow (fetches multiple separate documents)
 * - HuggingFace dataset integration
 * - Legal document processing
 * - Table of Contents with references to multiple documents
 */

import { writeFileSync, readFileSync } from 'node:fs';
import type { DatasetConfig, DocumentInfo } from '../types.js';
import { fetchFirstNDocuments, convertLegalCaseDocument } from '../../src/huggingface.js';
import { printInfo, printSuccess } from '../../src/display.js';

const HUGGINGFACE_DATASET = 'free-law/nh';
const DOCUMENT_COUNT = 4;

export const config: DatasetConfig = {
  name: 'freelaw_nh',
  displayName: 'New Hampshire Supreme Court Cases',
  emoji: '⚖️ ',
  shouldChunk: false, // Each document is a separate resource
  isMultiDocument: true, // Uses loadDocuments instead of loadText
  entityTypes: ['legal', 'case-law', 'new-hampshire'],
  createTableOfContents: true,
  tocTitle: 'New Hampshire Supreme Court Cases (Sample)',
  detectCitations: false, // Could add citation detection in future
  cacheFile: '/tmp/freelaw_nh.json',

  downloadContent: async () => {
    printInfo(`Fetching ${DOCUMENT_COUNT} documents from ${HUGGINGFACE_DATASET}...`);
    const rawDocs = await fetchFirstNDocuments(HUGGINGFACE_DATASET, DOCUMENT_COUNT);
    const documents = rawDocs.map((doc, i) => convertLegalCaseDocument(doc, i));
    printSuccess(`Fetched ${documents.length} legal documents`);

    documents.forEach((doc, i) => {
      printInfo(`  ${i + 1}. ${doc.title} (${doc.content.length.toLocaleString()} chars)`, 3);
    });

    writeFileSync('/tmp/freelaw_nh.json', JSON.stringify(documents, null, 2));
    printSuccess('Saved to /tmp/freelaw_nh.json');
  },

  loadDocuments: async () => {
    printInfo('Loading from /tmp/freelaw_nh.json...');
    const data = readFileSync('/tmp/freelaw_nh.json', 'utf-8');
    const documents: DocumentInfo[] = JSON.parse(data);
    printSuccess(`Loaded ${documents.length} legal documents`);

    documents.forEach((doc, i) => {
      printInfo(`  ${i + 1}. ${doc.title}`, 3);
    });

    return documents;
  },
};
