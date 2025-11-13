/**
 * Citizens United v. FEC Dataset Configuration
 *
 * Supreme Court case demonstrating:
 * - Legal opinion processing
 * - Fixed-size chunking
 * - Table of Contents with linked references
 * - Legal citation detection and tagging
 */

import { writeFileSync, readFileSync } from 'node:fs';
import type { DatasetConfig } from './types.js';
import { downloadCornellLII, formatLegalOpinion } from '../src/legal-text.js';
import { printInfo, printSuccess } from '../src/display.js';

export const config: DatasetConfig = {
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
};
