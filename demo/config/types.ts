/**
 * Dataset Configuration Types
 *
 * Shared types for dataset configurations.
 */

export interface DatasetConfig {
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
