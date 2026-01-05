/**
 * Create Resource Route - Multipart/Form-Data Version
 *
 * Handles binary content upload via multipart/form-data:
 * - Uses plain Hono (no @hono/zod-openapi)
 * - Parses multipart form data (no JSON validation middleware)
 * - Supports binary content (images, PDFs, video, etc.)
 * - Types from generated OpenAPI types
 * - OpenAPI spec is the source of truth
 */

import { HTTPException } from 'hono/http-exception';
import type { CreationMethod } from '@semiont/core';
import type { ResourcesRouterType } from '../shared';
import type { components } from '@semiont/api-client';
import { ResourceOperations } from '../../../services/resource-operations';

type ContentFormat = components['schemas']['ContentFormat'];

export function registerCreateResource(router: ResourcesRouterType) {
  /**
   * POST /resources
   *
   * Create a new resource with binary content support via multipart/form-data
   * Requires authentication
   * Parses FormData (no JSON validation middleware)
   */
  router.post('/resources', async (c) => {
    const user = c.get('user');
    const config = c.get('config');

    if (!user) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    // Parse multipart/form-data
    const formData = await c.req.formData();

    // Extract fields
    const name = formData.get('name') as string;
    const file = formData.get('file') as File;
    const formatRaw = formData.get('format') as string;
    const language = formData.get('language') as string | null;
    const entityTypesStr = formData.get('entityTypes') as string | null;
    const creationMethod = formData.get('creationMethod') as string | null;

    // Validate required fields
    if (!name || !file || !formatRaw) {
      throw new HTTPException(400, {
        message: 'Missing required fields: name, file, format'
      });
    }

    // Type-cast to ContentFormat (OpenAPI validates this enum at spec level)
    const format = formatRaw as ContentFormat;

    // Parse entityTypes from JSON string
    const entityTypes = entityTypesStr ? JSON.parse(entityTypesStr) : [];

    // Convert File to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const contentBuffer = Buffer.from(arrayBuffer);

    // Delegate to service for resource creation
    const response = await ResourceOperations.createResource(
      {
        name,
        content: contentBuffer,
        format,
        language: language || undefined,
        entityTypes,
        creationMethod: (creationMethod || undefined) as CreationMethod | undefined,
      },
      user,
      config
    );

    return c.json(response, 201);
  });
}
