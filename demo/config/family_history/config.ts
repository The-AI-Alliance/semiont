/**
 * Family History Dataset Configuration
 *
 * Family history documents and photographs demonstrating:
 * - Multi-document loading (text and images)
 * - Mixed media types (markdown and images)
 * - Local file loading (no download needed)
 * - No chunking (individual documents are small)
 * - No Table of Contents
 * - Genealogy and historical entity types
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { DatasetConfig, DocumentInfo } from '../types.js';
import { printInfo, printSuccess } from '../../src/display.js';

export const config: DatasetConfig = {
  name: 'family_history',
  displayName: 'Turner Family History',
  emoji: '👨‍👩‍👧‍👦',
  shouldChunk: false,
  entityTypes: ['family-history', 'genealogy', 'biography', 'historical'],
  createTableOfContents: false,
  detectCitations: false,
  cacheFile: 'config/family_history', // Directory path for multi-document

  // Multi-document configuration
  isMultiDocument: true,

  // No downloadContent function - files are already local

  loadDocuments: async (): Promise<DocumentInfo[]> => {
    const documents: DocumentInfo[] = [];
    const familyHistoryDir = 'config/family_history';

    printInfo('Loading family history documents...');

    // Read all files in the directory
    const files = readdirSync(familyHistoryDir);

    for (const file of files) {
      // Skip the config file itself and state files
      if (file === 'config.ts' || file === '.state.json' || file.startsWith('.')) {
        continue;
      }

      const filePath = join(familyHistoryDir, file);
      const ext = extname(file).toLowerCase();

      // Handle markdown files
      if (ext === '.md') {
        const content = readFileSync(filePath, 'utf-8');
        const title = file.replace('.md', '').replace(/_/g, ' ');

        documents.push({
          title,
          content,
          format: 'text/markdown',
          metadata: {
            fileName: file,
            type: 'biography'
          }
        });

        printInfo(`  Loaded: ${title} (${content.length.toLocaleString()} characters)`, 2);
      }

      // Handle image files
      else if (['.jpg', '.jpeg', '.png'].includes(ext)) {
        const content = readFileSync(filePath);
        const title = file.replace(ext, '').replace(/_/g, ' ');

        let format = 'image/jpeg';
        if (ext === '.png') {
          format = 'image/png';
        }

        documents.push({
          title,
          content,
          format,
          metadata: {
            fileName: file,
            type: 'photograph'
          }
        });

        printInfo(`  Loaded: ${title} (${format}, ${content.length.toLocaleString()} bytes)`, 2);
      }
    }

    printSuccess(`Loaded ${documents.length} family history documents:`);
    printSuccess(`  - ${documents.filter(d => d.metadata?.type === 'biography').length} biographies`);
    printSuccess(`  - ${documents.filter(d => d.metadata?.type === 'photograph').length} photographs`);

    return documents;
  },

  // For validation only - returns a simple concatenation of text documents
  loadText: async (): Promise<string> => {
    const documents = await config.loadDocuments!();

    // Filter to only text documents and concatenate
    const textDocs = documents.filter(doc =>
      typeof doc.content === 'string' &&
      doc.format?.startsWith('text/')
    );

    const combinedText = textDocs
      .map(doc => `# ${doc.title}\n\n${doc.content}`)
      .join('\n\n---\n\n');

    printInfo('Combined text documents for validation');
    printSuccess(`Total text: ${combinedText.length.toLocaleString()} characters`);

    return combinedText;
  }
};