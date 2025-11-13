/**
 * ArXiv Paper Dataset Configuration
 *
 * Research paper from arXiv.org demonstrating:
 * - ArXiv API integration
 * - Paper metadata extraction
 * - Markdown formatting
 * - Single document (no chunking)
 * - No Table of Contents
 */

import { writeFileSync, readFileSync } from 'node:fs';
import type { DatasetConfig } from '../types.js';
import { fetchArxivPaper, formatArxivPaper } from '../../src/arxiv.js';
import { printInfo, printSuccess } from '../../src/display.js';

export const config: DatasetConfig = {
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
};
