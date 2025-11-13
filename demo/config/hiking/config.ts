/**
 * Hiking Notes Dataset Configuration
 *
 * Simple text document demonstrating:
 * - Local file loading (no download needed)
 * - Single document (no chunking)
 * - No Table of Contents
 * - No citation detection
 */

import { readFileSync } from 'node:fs';
import type { DatasetConfig } from '../types.js';
import { printInfo, printSuccess } from '../../src/display.js';

export const config: DatasetConfig = {
  name: 'hiking',
  displayName: 'Hiking Notes',
  emoji: '🥾 ',
  shouldChunk: false,
  entityTypes: ['text', 'hiking', 'outdoor'],
  createTableOfContents: false,
  detectCitations: false,
  cacheFile: 'data/hiking.txt', // Already local, no download needed

  // No downloadContent function - file is already local

  loadText: async () => {
    printInfo('Loading from data/hiking.txt...');
    const text = readFileSync('data/hiking.txt', 'utf-8');
    printSuccess(`Loaded ${text.length.toLocaleString()} characters`);
    return text;
  },
};
