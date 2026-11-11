/** Normalize a KB-relative directory path, rejecting host paths and traversal. */
export function normalizeKbDirectory(path: string): string | null {
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return null;

  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) return null;
  return parts.join('/');
}

/** A directory entry returned for a direct child of the requested directory. */
export function isDirectKbDirectory(parent: string, child: string): boolean {
  const normalizedParent = normalizeKbDirectory(parent);
  const normalizedChild = normalizeKbDirectory(child);
  if (normalizedParent === null || normalizedChild === null || normalizedParent === normalizedChild) return false;
  const prefix = normalizedParent === '' ? '' : `${normalizedParent}/`;
  const remainder = normalizedChild.startsWith(prefix) ? normalizedChild.slice(prefix.length) : null;
  return remainder !== null && remainder.length > 0 && !remainder.includes('/');
}
