/**
 * Dataset Configuration Types
 *
 * Shared types for dataset configurations.
 */

/**
 * Document info for multi-document datasets
 */
export interface DocumentInfo {
  title: string;
  content: string;
  metadata?: Record<string, any>;
}

export interface DatasetConfig {
  name: string;
  displayName: string;
  emoji: string;

  // Single-document workflow (chunked or not)
  shouldChunk: boolean;
  chunkSize?: number;
  useSmartChunking?: boolean; // If true, use paragraph-aware chunking instead of fixed-size
  cacheFile: string;
  downloadContent?: () => Promise<void>;
  loadText?: () => Promise<string>; // For single-document datasets

  // Multi-document workflow
  isMultiDocument?: boolean; // If true, uses loadDocuments instead of loadText
  loadDocuments?: () => Promise<DocumentInfo[]>; // For multi-document datasets

  // Common fields
  entityTypes: string[];
  createTableOfContents: boolean;
  tocTitle?: string;
  detectCitations: boolean;
  extractionConfig?: {
    startPattern: RegExp;
    endMarker: string;
  };
}

/**
 * Extended dataset config with computed paths
 * Created internally by demo.ts during dataset loading
 */
export interface DatasetConfigWithPaths extends DatasetConfig {
  stateFile: string; // Computed: config/{dataset_dir}/.state.json
}
