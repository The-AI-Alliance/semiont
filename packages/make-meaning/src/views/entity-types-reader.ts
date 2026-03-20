/**
 * Entity Types Projection Reader
 *
 * Reads entity types from the view storage projection file.
 * This file is maintained by ViewMaterializer in response to entitytype.added events.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { SemiontProject } from '@semiont/core';

/**
 * Read entity types from view storage projection
 */
export async function readEntityTypesProjection(project: SemiontProject): Promise<string[]> {

  const entityTypesPath = path.join(
    project.stateDir,
    'projections',
    '__system__',
    'entitytypes.json'
  );

  try {
    const content = await fs.readFile(entityTypesPath, 'utf-8');
    const projection = JSON.parse(content);
    return projection.entityTypes || [];
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // File doesn't exist yet - return empty array
      return [];
    }
    throw error;
  }
}
