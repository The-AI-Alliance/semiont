/**
 * Annotation utility functions
 */

/**
 * Compare two annotation IDs (handles URI vs internal ID formats)
 */
export function compareAnnotationIds(id1: string, id2: string): boolean {
  const extractId = (id: string) => id.includes('/') ? id.split('/').pop()! : id;
  return extractId(id1) === extractId(id2);
}
