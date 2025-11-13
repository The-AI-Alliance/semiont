/**
 * Resource Validation
 *
 * Fetches all resources for a dataset and validates their content
 */

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { SemiontApiClient, ResourceUri } from '@semiont/api-client';

export interface ValidationResult {
  uri: ResourceUri;
  status: 'success' | 'error';
  mediaType?: string;
  checksum?: string;
  preview?: string;
  error?: string;
  cachePath?: string;
}

/**
 * Validate all resources for a dataset
 */
export async function validateResources(
  resourceIds: ResourceUri[],
  client: SemiontApiClient
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  for (const uri of resourceIds) {
    try {
      // Fetch the resource using the api-client
      const { data, contentType } = await client.getResourceRepresentation(uri);

      // Convert ArrayBuffer to Buffer
      const buffer = Buffer.from(data);

      // Calculate checksum
      const checksum = createHash('sha256').update(buffer).digest('hex').substring(0, 16);

      // Get media type
      const mediaType = contentType || 'unknown';

      // Generate preview for text content
      let preview: string | undefined;
      if (mediaType.startsWith('text/')) {
        const text = buffer.toString('utf-8');
        // Get first line (up to 80 chars)
        const firstLine = text.split('\n')[0];
        preview = firstLine.length > 80 ? firstLine.substring(0, 77) + '...' : firstLine;
      }

      // Cache to /tmp
      const cachePath = `/tmp/semiont_${uri.split('/').pop()}_${checksum}`;
      writeFileSync(cachePath, buffer);

      results.push({
        uri,
        status: 'success',
        mediaType,
        checksum,
        preview,
        cachePath,
      });
    } catch (error) {
      results.push({
        uri,
        status: 'error',
        error: (error as Error).message,
      });
    }
  }

  return results;
}

/**
 * Create a clickable hyperlink using OSC 8 escape sequences
 * Supported by most modern terminal emulators
 */
function createHyperlink(url: string, text: string): string {
  // OSC 8 format: \033]8;;URL\033\\TEXT\033]8;;\033\\
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * Format validation results for display
 */
export function formatValidationResults(results: ValidationResult[]): string[] {
  const lines: string[] = [];

  for (const result of results) {
    const indicator = result.status === 'success' ? '✓' : '✗';
    const color = result.status === 'success' ? 'green' : 'red';

    // Create clickable URI (assumes http://localhost:4000 base URL for demo)
    const fullUrl = result.uri.startsWith('http') ? result.uri : `http://localhost:4000${result.uri}`;
    const clickableUri = createHyperlink(fullUrl, result.uri);

    lines.push(`{${color}-fg}${indicator}{/${color}-fg} ${clickableUri}`);

    if (result.status === 'success') {
      lines.push(`  Type: ${result.mediaType}`);
      lines.push(`  Checksum: ${result.checksum}`);
      if (result.preview) {
        lines.push(`  Preview: ${result.preview}`);
      }
      // Make cache path clickable as file:// URL
      const clickablePath = createHyperlink(`file://${result.cachePath}`, result.cachePath!);
      lines.push(`  Cached: ${clickablePath}`);
    } else {
      lines.push(`  {red-fg}Error: ${result.error}{/red-fg}`);
    }
    lines.push(''); // Blank line between resources
  }

  return lines;
}
