/**
 * Annotation Management
 *
 * Reusable utilities for creating and linking annotations.
 */

import type { SemiontApiClient } from '@semiont/api-client';
import { resourceUri, resourceAnnotationUri } from '@semiont/api-client';
import { printBatchProgress, printSuccess, printWarning, printAnnotationCreated, printFilesystemPath } from './display';
import { getLayer2Path, getLayer3Path } from './filesystem-utils';
import type { TableOfContentsReference } from './resources';

export interface CreateStubReferencesOptions {
  dataDir?: string;
}

/**
 * Create stub annotations (references without targets yet)
 */
export async function createStubReferences(
  tocId: string,
  references: TableOfContentsReference[],
  chunkIds: string[],
  client: SemiontApiClient,
  options: CreateStubReferencesOptions = {}
): Promise<TableOfContentsReference[]> {
  const { dataDir } = options;

  for (let i = 0; i < references.length; i++) {
    const ref = references[i];
    ref.documentId = chunkIds[i];

    printBatchProgress(i + 1, references.length, `Creating annotation for "${ref.text}"...`);

    const response = await client.createAnnotation(resourceUri(tocId), {
      motivation: 'linking',
      target: {
        source: tocId,
        selector: [
          {
            type: 'TextPositionSelector',
            start: ref.start,
            end: ref.end,
          },
          {
            type: 'TextQuoteSelector',
            exact: ref.text,
          },
        ],
      },
      body: [{
        type: 'TextualBody',
        value: 'part-reference',
        purpose: 'tagging',
      }],
    });

    // Store the FULL annotation ID (includes URL prefix)
    ref.annotationId = response.annotation.id;

    printAnnotationCreated(response.annotation.id);

    if (dataDir) {
      printFilesystemPath('Layer 2 (event log)', getLayer2Path(tocId, dataDir));
      printFilesystemPath('Layer 3 (projection)', getLayer3Path(tocId, dataDir));
    }
  }

  printSuccess(`Created ${references.length} stub annotations`);
  return references;
}

export interface LinkReferencesOptions {
  showProgress?: boolean;
}

/**
 * Link stub references to target documents
 */
export async function linkReferences(
  tocId: string,
  references: TableOfContentsReference[],
  client: SemiontApiClient,
  options: LinkReferencesOptions = {}
): Promise<number> {
  const { showProgress = true } = options;
  let successCount = 0;

  for (let i = 0; i < references.length; i++) {
    const ref = references[i];
    const shortDocId = ref.documentId.substring(0, 20);

    if (showProgress) {
      printBatchProgress(i + 1, references.length, `Linking "${ref.text}" → ${shortDocId}...`);
    }

    try {
      // Match compose page pattern: short annotation ID in path, full resource URI in body
      const annotationIdShort = ref.annotationId!.split('/annotations/')[1];
      const nestedUri = `${tocId}/annotations/${annotationIdShort}`;

      await client.updateAnnotationBody(resourceAnnotationUri(nestedUri), {
        resourceId: tocId,
        operations: [{
          op: 'add',
          item: {
            type: 'SpecificResource',
            source: ref.documentId,
            purpose: 'linking',
          },
        }],
      });

      if (showProgress) {
        printSuccess('Linked', 7);
      }
      successCount++;
    } catch (error) {
      if (showProgress) {
        printWarning(`Failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 7);
      }
    }
  }

  printSuccess(`Linked ${successCount}/${references.length} references`);
  return successCount;
}
