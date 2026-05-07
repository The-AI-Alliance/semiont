/**
 * OpenResource — a single entry in the open-resources list (tabs).
 *
 * The list itself lives on `SemiontBrowser.openResources$`. The CRUD
 * methods (`addOpenResource`, `removeOpenResource`, `updateOpenResourceName`,
 * `reorderOpenResources`) live on `SemiontBrowser` too.
 */

export interface OpenResource {
  /** Unique identifier for the resource */
  id: string;

  /** Display name of the resource */
  name: string;

  /** Timestamp when the resource was opened */
  openedAt: number;

  /** Order/position for manual sorting (optional for backward compatibility) */
  order?: number;

  /** Media type for icon display (e.g., 'application/pdf', 'text/plain') */
  mediaType?: string;

  /** Working-tree URI (e.g. "file://docs/overview.md") — used as tooltip in navigation */
  storageUri?: string;
}
