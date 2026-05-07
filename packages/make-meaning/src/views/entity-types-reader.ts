/**
 * Entity Types Projection Reader
 *
 * Reads entity types from the view storage projection file.
 * This file is maintained by ViewMaterializer in response to entitytype.added events.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { SemiontProject } from '@semiont/core/node';

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
      // Projection file doesn't exist. After ViewManager.rebuildAll() runs at
      // startup (see createKnowledgeBase), this is the genuine "no entity-type
      // events have been recorded yet" case — empty event log → empty result.
      return [];
    }
    throw error;
  }
}
