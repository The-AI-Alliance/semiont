/**
 * Prometheus Bound Dataset Configuration
 *
 * Ancient Greek drama from Project Gutenberg demonstrating:
 * - Project Gutenberg integration
 * - Text extraction with start/end patterns
 * - Smart paragraph-aware chunking
 * - Table of Contents with linked references
 * - Classical literature processing
 */

import { writeFileSync, readFileSync } from 'node:fs';
import type { DatasetConfig } from '../types.js';
import { downloadText, extractSection } from '../../src/chunking.js';
import { printInfo, printSuccess } from '../../src/display.js';

export const config: DatasetConfig = {
  name: 'prometheus_bound',
  displayName: 'Prometheus Bound',
  emoji: '🎭',
  shouldChunk: true,
  chunkSize: 4000,
  useSmartChunking: true,
  entityTypes: ['literature', 'ancient-greek-drama'],
  createTableOfContents: true,
  tocTitle: 'Prometheus Bound: Table of Contents',
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
};
