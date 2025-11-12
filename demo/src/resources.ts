/**
 * Resource Management
 *
 * Reusable utilities for creating and managing resources.
 */

import type { SemiontApiClient } from '@semiont/api-client';
import type { ChunkInfo } from './chunking';
import { printBatchProgress, printSuccess, printFilesystemPath } from './display';
import { getLayer1Path } from './filesystem-utils';

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
): Promise<string[]> {
  const documentIds: string[] = [];
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
    const resourceId = response.resource['@id'] as string;
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
  documentId: string;
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
): Promise<{ tocId: string; references: TableOfContentsReference[] }> {
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
      documentId: '', // Will be filled by caller
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
  const tocId = response.resource['@id'] as string;
  printSuccess(`Created ToC: ${tocId}`);

  if (dataDir) {
    printFilesystemPath('Layer 1', getLayer1Path(tocId, dataDir));
  }

  return { tocId, references };
}

function printInfo(message: string, indent: number = 3): void {
  console.log(`${' '.repeat(indent)}${message}`);
}
