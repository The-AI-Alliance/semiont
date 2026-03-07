/**
 * Entity Types Projection Reader
 *
 * Reads entity types from the view storage projection file.
 * This file is maintained by ViewMaterializer in response to entitytype.added events.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { EnvironmentConfig } from '@semiont/core';

/**
 * Read entity types from view storage projection
 */
export async function readEntityTypesProjection(config: EnvironmentConfig): Promise<string[]> {
  // Resolve basePath against project root if relative
  const configuredPath = config.services.filesystem!.path;
  const projectRoot = config._metadata?.projectRoot;
  let basePath: string;
  if (path.isAbsolute(configuredPath)) {
    basePath = configuredPath;
  } else if (projectRoot) {
    basePath = path.resolve(projectRoot, configuredPath);
  } else {
    basePath = path.resolve(configuredPath);
  }

  const entityTypesPath = path.join(
    basePath,
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
