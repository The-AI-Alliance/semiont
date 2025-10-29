/**
 * Stub handlers for endpoints that were removed/renamed in the API
 * These return error messages indicating the endpoint is unavailable
 */

function createStubHandler(endpointName: string) {
  return (_args: any) => {
    return {
      content: [{
        type: 'text' as const,
        text: `Error: The ${endpointName} endpoint is no longer available in the current API version. This feature may have been removed or renamed.`,
      }],
      isError: true,
    };
  };
}

// Endpoints that don't exist in the current API
export const handleDetectSelections = createStubHandler('detect-selections');
export const handleGetContextualSummary = createStubHandler('contextual-summary');
export const handleGetSchemaDescription = createStubHandler('schema-description');
export const handleGetLLMContext = createStubHandler('llm-context');
export const handleDiscoverContext = createStubHandler('discover-context');
export const handleGetResourceSelections = createStubHandler('resource-selections');
