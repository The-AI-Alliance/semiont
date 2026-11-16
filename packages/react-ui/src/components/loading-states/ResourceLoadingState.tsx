/**
 * ResourceLoadingState - Loading state component for resource viewer
 *
 * Pure React component - no Next.js dependencies.
 */

export function ResourceLoadingState() {
  return (
    <div className="semiont-loading-state semiont-loading-state-resource">
      <p className="semiont-loading-message">Loading resource...</p>
    </div>
  );
}
