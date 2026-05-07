/**
 * Tag Schemas Projection Reader
 *
 * Reads tag schemas from the view storage projection file.
 * This file is maintained by ViewMaterializer in response to
 * `frame:tag-schema-added` events.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { SemiontProject } from '@semiont/core/node';
import type { TagSchema } from '@semiont/core';

/**
 * Read tag schemas from view storage projection
 */
export async function readTagSchemasProjection(project: SemiontProject): Promise<TagSchema[]> {
  const tagSchemasPath = path.join(
    project.stateDir,
    'projections',
    '__system__',
    'tagschemas.json'
  );

  try {
    const content = await fs.readFile(tagSchemasPath, 'utf-8');
    const projection = JSON.parse(content);
    return projection.tagSchemas || [];
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // Projection file doesn't exist. After ViewManager.rebuildAll() runs at
      // startup, this is the genuine "no tag-schema events have been recorded
      // yet" case — empty event log → empty result.
      return [];
    }
    throw error;
  }
}
