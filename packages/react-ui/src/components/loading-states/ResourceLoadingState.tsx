/**
 * ResourceLoadingState - Loading state component for resource viewer
 *
 * Pure React component - no Next.js dependencies.
 */

export function ResourceLoadingState() {
  return (
    <div className="flex items-center justify-center py-20">
      <p className="text-gray-600 dark:text-gray-300">Loading resource...</p>
    </div>
  );
}
