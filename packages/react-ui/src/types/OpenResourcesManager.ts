/**
 * Open Resources Manager Interface
 *
 * Manages a list of open resources (documents/files) with persistence.
 * This interface allows apps to provide their own implementation of resource management
 * (localStorage, sessionStorage, database, etc.) while components remain framework-agnostic.
 *
 * Components accept this manager as a prop instead of consuming from Context.
 *
 * @example
 * ```tsx
 * // In app (e.g., frontend/src/hooks/useOpenResourcesManager.ts)
 * export function useOpenResourcesManager(): OpenResourcesManager {
 *   const [openResources, setOpenResources] = useState<OpenResource[]>([]);
 *
 *   // Implementation details...
 *
 *   return {
 *     openResources,
 *     addResource,
 *     removeResource,
 *     updateResourceName,
 *     reorderResources
 *   };
 * }
 *
 * // Pass to components as props
 * <KnowledgeNavigation openResourcesManager={openResourcesManager} />
 * ```
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
}

export interface OpenResourcesManager {
  /** List of currently open resources */
  openResources: OpenResource[];

  /**
   * Add a new resource to the open list or update if already exists
   * @param id - Unique resource identifier
   * @param name - Display name of the resource
   * @param mediaType - Optional media type for icon display
   */
  addResource: (id: string, name: string, mediaType?: string) => void;

  /**
   * Remove a resource from the open list
   * @param id - Resource identifier to remove
   */
  removeResource: (id: string) => void;

  /**
   * Update the display name of an open resource
   * @param id - Resource identifier
   * @param name - New display name
   */
  updateResourceName: (id: string, name: string) => void;

  /**
   * Reorder resources by moving from one index to another
   * @param oldIndex - Current position index
   * @param newIndex - Desired position index
   */
  reorderResources: (oldIndex: number, newIndex: number) => void;
}
