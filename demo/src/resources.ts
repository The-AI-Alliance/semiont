/**
 * Resource Management
 *
 * Reusable utilities for creating and managing resources.
 */

import type { SemiontApiClient, ResourceUri } from '@semiont/api-client';
import { resourceUri } from '@semiont/api-client';
import type { ChunkInfo } from './chunking';
import { printBatchProgress, printSuccess, printFilesystemPath, printInfo } from './display';
import { getLayer1Path } from './filesystem-utils';

/**
 * Document info for multi-document uploads
 */
export interface DocumentInfo {
  title: string;
  content: string | Buffer; // Support both text and binary content
  format?: 'text/plain' | 'text/markdown' | 'image/jpeg' | 'image/png' | string; // MIME type
  metadata?: Record<string, any>;
}

export interface UploadOptions {
  entityTypes?: string[];
  dataDir?: string;
}

/**
 * Upload text chunks as resources
 */
export async function uploadChunks(
  chunks: ChunkInfo[],
  client: SemiontApiClient,
  options: UploadOptions = {}
): Promise<ResourceUri[]> {
  const documentIds: ResourceUri[] = [];
  const { entityTypes = [], dataDir } = options;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    printBatchProgress(i + 1, chunks.length, `Uploading ${chunk.title}...`);

    const request = {
      name: chunk.title,
      file: Buffer.from(chunk.content),
      format: 'text/plain' as const,
      entityTypes,
    };

    const response = await client.createResource(request);
    const resourceId = resourceUri(response.resource['@id']);
    documentIds.push(resourceId);
    printSuccess(resourceId, 7);

    if (dataDir) {
      printFilesystemPath('Layer 1', getLayer1Path(resourceId, dataDir));
    }
  }

  printSuccess(`All ${chunks.length} chunks uploaded`);
  return documentIds;
}

export interface TableOfContentsReference {
  text: string;
  start: number;
  end: number;
  documentId: ResourceUri;
  annotationId?: string;
}

export interface TableOfContentsOptions {
  title: string;
  entityTypes?: string[];
  dataDir?: string;
}

/**
 * Create a Table of Contents document with references to chunks
 */
export async function createTableOfContents(
  chunks: ChunkInfo[],
  client: SemiontApiClient,
  options: TableOfContentsOptions
): Promise<{ tocId: ResourceUri; references: TableOfContentsReference[] }> {
  const { title, entityTypes = [], dataDir } = options;

  // Build markdown content with timestamp to ensure unique document ID
  const timestamp = new Date().toISOString();
  let content = `# ${title}\n\n`;
  content += `_Generated: ${timestamp}_\n\n`;
  content += '## Parts\n\n';
  const references: TableOfContentsReference[] = [];

  chunks.forEach((chunk, index) => {
    const partText = `Part ${chunk.partNumber}`;
    const listItem = `${index + 1}. ${partText}\n`;
    const start = content.length + `${index + 1}. `.length;
    const end = start + partText.length;

    references.push({
      text: partText,
      start,
      end,
      documentId: '' as ResourceUri, // Will be filled by caller
    });

    content += listItem;
  });

  printInfo(`Creating ToC document with ${chunks.length} entries (${timestamp})...`);

  const request = {
    name: title,
    file: Buffer.from(content),
    format: 'text/markdown' as const,
    entityTypes: [...entityTypes, 'table-of-contents'],
  };

  const response = await client.createResource(request);
  const tocId = resourceUri(response.resource['@id']);
  printSuccess(`Created ToC: ${tocId}`);

  if (dataDir) {
    printFilesystemPath('Layer 1', getLayer1Path(tocId, dataDir));
  }

  return { tocId, references };
}

/**
 * Upload multiple documents as separate resources
 * Similar to uploadChunks but for multi-document datasets
 */
export async function uploadDocuments(
  documents: DocumentInfo[],
  client: SemiontApiClient,
  options: UploadOptions = {}
): Promise<ResourceUri[]> {
  const documentIds: ResourceUri[] = [];
  const { entityTypes = [], dataDir } = options;

  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    printBatchProgress(i + 1, documents.length, `Uploading ${doc.title}...`);

    // Handle both string and Buffer content
    const fileBuffer = Buffer.isBuffer(doc.content) ? doc.content : Buffer.from(doc.content);

    // Use format from document if provided, otherwise default to text/plain
    const format = doc.format || 'text/plain';

    const request = {
      name: doc.title,
      file: fileBuffer,
      format: format as any, // API accepts various MIME types
      entityTypes,
    };

    const response = await client.createResource(request);
    const resourceId = resourceUri(response.resource['@id']);
    documentIds.push(resourceId);
    printSuccess(resourceId, 7);

    if (dataDir) {
      printFilesystemPath('Layer 1', getLayer1Path(resourceId, dataDir));
    }
  }

  printSuccess(`All ${documents.length} documents uploaded`);
  return documentIds;
}

/**
 * Create a Table of Contents with references to multiple documents
 * Similar to createTableOfContents but uses document titles instead of part numbers
 */
export async function createDocumentTableOfContents(
  documents: DocumentInfo[],
  client: SemiontApiClient,
  options: TableOfContentsOptions
): Promise<{ tocId: ResourceUri; references: TableOfContentsReference[] }> {
  const { title, entityTypes = [], dataDir } = options;

  // Build markdown content with timestamp to ensure unique document ID
  const timestamp = new Date().toISOString();
  let content = `# ${title}\n\n`;
  content += `_Generated: ${timestamp}_\n\n`;
  content += '## Documents\n\n';
  const references: TableOfContentsReference[] = [];

  documents.forEach((doc, index) => {
    const docText = doc.title;
    const listItem = `${index + 1}. ${docText}\n`;
    const start = content.length + `${index + 1}. `.length;
    const end = start + docText.length;

    references.push({
      text: docText,
      start,
      end,
      documentId: '' as ResourceUri, // Will be filled by caller
    });

    content += listItem;
  });

  printInfo(`Creating ToC document with ${documents.length} entries (${timestamp})...`);

  const request = {
    name: title,
    file: Buffer.from(content),
    format: 'text/markdown' as const,
    entityTypes: [...entityTypes, 'table-of-contents'],
  };

  const response = await client.createResource(request);
  const tocId = resourceUri(response.resource['@id']);
  printSuccess(`Created ToC: ${tocId}`);

  if (dataDir) {
    printFilesystemPath('Layer 1', getLayer1Path(tocId, dataDir));
  }

  return { tocId, references };
}
