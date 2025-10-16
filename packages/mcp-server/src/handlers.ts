/**
 * Tool execution handlers using @semiont/api-client
 */

import { SemiontApiClient } from '@semiont/api-client';

export async function handleCreateDocument(client: SemiontApiClient, args: any) {
  const data = await client.createDocument({
    name: args?.name,
    content: args?.content,
    format: args?.contentType || 'text/plain',
    entityTypes: args?.entityTypes || [],
  });

  return {
    content: [{
      type: 'text' as const,
      text: `Document created successfully:\nID: ${data.document.id}\nName: ${data.document.name}\nEntity Types: ${data.document.entityTypes?.join(', ') || 'None'}`,
    }],
  };
}

export async function handleGetDocument(client: SemiontApiClient, id: string) {
  const data = await client.getDocument(id);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2),
    }],
  };
}

export async function handleListDocuments(client: SemiontApiClient, args: any) {
  const data = await client.listDocuments({
    limit: args?.limit,
    archived: args?.archived ?? false,
  });

  return {
    content: [{
      type: 'text' as const,
      text: `Found ${data.total} documents:\n${data.documents.map((d: any) => `- ${d.name} (${d.id}) - ${d.entityTypes?.join(', ') || 'No types'}`).join('\n')}`,
    }],
  };
}

export async function handleDetectAnnotations(_client: SemiontApiClient, _args: any) {
  // NOTE: The /detect-annotations endpoint was removed. Use /detect-annotations-stream instead
  return {
    content: [{
      type: 'text' as const,
      text: `Error: The detect-annotations endpoint is no longer available. The API now uses streaming annotation detection.`,
    }],
    isError: true,
  };
}

export async function handleCreateAnnotation(client: SemiontApiClient, args: any) {
  const selectionData = args?.selectionData || {};
  const data = await client.createAnnotation({
    motivation: 'highlighting',
    target: {
      source: args?.documentId,
      selector: {
        type: selectionData.type || 'TextPositionSelector',
        exact: selectionData.text || '',
        offset: selectionData.offset || 0,
        length: selectionData.length || 0,
      },
    },
    body: {
      type: 'TextualBody',
      entityTypes: args?.entityTypes || [],
    },
  });

  const selector = Array.isArray(data.annotation.target.selector)
    ? data.annotation.target.selector[0]
    : data.annotation.target.selector;

  return {
    content: [{
      type: 'text' as const,
      text: `Annotation created:\nID: ${data.annotation.id}\nMotivation: ${data.annotation.motivation}\nText: ${selector?.exact || 'N/A'}`,
    }],
  };
}

export async function handleSaveAnnotation(_client: SemiontApiClient, _args: any) {
  // NOTE: The /save endpoint was removed from the API
  // This functionality may have been merged into the main annotation creation
  return {
    content: [{
      type: 'text' as const,
      text: `Error: The save annotation endpoint is no longer available. Annotations are automatically persisted when created.`,
    }],
    isError: true,
  };
}

export async function handleResolveAnnotation(client: SemiontApiClient, args: any) {
  const data = await client.resolveAnnotation(args?.selectionId, args?.documentId);

  return {
    content: [{
      type: 'text' as const,
      text: `Annotation resolved to document:\nAnnotation ID: ${data.annotation.id}\nResolved to: ${data.targetDocument?.id || 'null'}\nTarget: ${data.targetDocument?.name || 'None'}`,
    }],
  };
}

export async function handleCreateDocumentFromAnnotation(_client: SemiontApiClient, _args: any) {
  // NOTE: This endpoint may have changed - /api/annotations/{id}/create-document doesn't exist
  return {
    content: [{
      type: 'text' as const,
      text: `Error: The create-document-from-annotation endpoint needs to be updated.`,
    }],
    isError: true,
  };
}

export async function handleGenerateDocumentFromAnnotation(client: SemiontApiClient, args: any) {
  const data = await client.generateDocumentFromAnnotation(args?.selectionId, {
    name: args?.name,
    entityTypes: args?.entityTypes,
    prompt: args?.prompt,
  });

  return {
    content: [{
      type: 'text' as const,
      text: `Document generated from annotation:\nDocument ID: ${data.document.id}\nDocument Name: ${data.document.name}\nFormat: ${data.document.format}`,
    }],
  };
}

export async function handleGetContextualSummary(_client: SemiontApiClient, _args: any) {
  // NOTE: /contextual-summary endpoint was removed or renamed
  // Use /api/annotations/{id}/summary or /api/annotations/{id}/context instead
  return {
    content: [{
      type: 'text' as const,
      text: `Error: The contextual-summary endpoint is no longer available. Use /summary or /context endpoints instead.`,
    }],
    isError: true,
  };
}

export async function handleGetSchemaDescription(_client: SemiontApiClient) {
  // NOTE: /schema-description endpoint was removed
  return {
    content: [{
      type: 'text' as const,
      text: `Error: The schema-description endpoint is no longer available.`,
    }],
    isError: true,
  };
}

export async function handleGetLLMContext(_client: SemiontApiClient, _args: any) {
  // NOTE: Endpoint path may have changed - need to verify correct path
  return {
    content: [{
      type: 'text' as const,
      text: `Error: The llm-context endpoint path needs to be updated.`,
    }],
    isError: true,
  };
}

export async function handleDiscoverContext(_client: SemiontApiClient, _args: any) {
  // NOTE: Endpoint path may have changed - need to verify correct path
  return {
    content: [{
      type: 'text' as const,
      text: `Error: The discover-context endpoint path needs to be updated.`,
    }],
    isError: true,
  };
}

export async function handleGetDocumentAnnotations(_client: SemiontApiClient, _args: any) {
  // NOTE: Use /api/documents/{id}/annotations instead
  return {
    content: [{
      type: 'text' as const,
      text: `Error: This endpoint needs to be updated to use /api/documents/{id}/annotations.`,
    }],
    isError: true,
  };
}

export async function handleGetDocumentHighlights(client: SemiontApiClient, args: any) {
  const data = await client.getDocumentHighlights(args?.documentId);

  return {
    content: [{
      type: 'text' as const,
      text: `Found ${data.highlights.length} highlights in document:\n${data.highlights.map((h: any) => `- ${h.selectionData?.text || h.id} (saved by ${h.savedBy})`).join('\n')}`,
    }],
  };
}

export async function handleGetDocumentReferences(client: SemiontApiClient, args: any) {
  const data = await client.getDocumentReferences(args?.documentId);

  return {
    content: [{
      type: 'text' as const,
      text: `Found ${data.references.length} references in document:\n${data.references.map((r: any) => `- ${r.selectionData?.text || r.id} → ${r.resolvedDocumentId}`).join('\n')}`,
    }],
  };
}
