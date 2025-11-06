/**
 * Tool execution handlers using @semiont/api-client
 */

import { SemiontApiClient, getExactText, getBodySource, resourceUri } from '@semiont/api-client';

export async function handleCreateResource(client: SemiontApiClient, args: any) {
  const data = await client.createResource({
    name: args?.name,
    content: args?.content,
    format: args?.contentType || 'text/plain',
    entityTypes: args?.entityTypes || [],
  });

  return {
    content: [{
      type: 'text' as const,
      text: `Resource created successfully:\nID: ${data.resource.id}\nName: ${data.resource.name}\nEntity Types: ${data.resource.entityTypes?.join(', ') || 'None'}`,
    }],
  };
}

export async function handleGetResource(client: SemiontApiClient, id: string) {
  const data = await client.getResource(resourceUri(id));

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2),
    }],
  };
}

export async function handleListResources(client: SemiontApiClient, args: any) {
  const data = await client.listResources(
    args?.limit,
    args?.archived ?? false
  );

  return {
    content: [{
      type: 'text' as const,
      text: `Found ${data.total} resources:\n${data.resources.map((d: any) => `- ${d.name} (${d.id}) - ${d.entityTypes?.join(', ') || 'No types'}`).join('\n')}`,
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
  const entityTypes = args?.entityTypes || [];

  // Convert entityTypes to W3C TextualBody items
  const body = entityTypes.map((value: string) => ({
    type: 'TextualBody' as const,
    value,
    purpose: 'tagging' as const,
  }));

  const rUri = resourceUri(args?.resourceId);
  const data = await client.createAnnotation(rUri, {
    motivation: 'highlighting',
    target: {
      source: args?.resourceId,
      selector: [
        {
          type: 'TextPositionSelector',
          start: selectionData.offset || 0,
          end: (selectionData.offset || 0) + (selectionData.length || 0),
        },
        {
          type: 'TextQuoteSelector',
          exact: selectionData.text || '',
        },
      ],
    },
    body,
  });

  // Extract text using SDK utility
  const targetSelector = typeof data.annotation.target === 'string'
    ? undefined
    : data.annotation.target.selector;
  const exactText = getExactText(targetSelector);

  return {
    content: [{
      type: 'text' as const,
      text: `Annotation created:\nID: ${data.annotation.id}\nMotivation: ${data.annotation.motivation}\nText: ${exactText}`,
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
  const data = await client.updateAnnotationBody(args?.selectionId, {
    resourceId: args?.sourceResourceId,
    operations: [{
      op: 'add',
      item: {
        type: 'SpecificResource',
        source: args?.resourceId,
        purpose: 'linking',
      },
    }],
  });

  return {
    content: [{
      type: 'text' as const,
      text: `Annotation linked to resource:\nAnnotation ID: ${data.annotation.id}\nLinked to: ${args?.resourceId || 'null'}`,
    }],
  };
}

export async function handleGenerateResourceFromAnnotation(client: SemiontApiClient, args: any) {
  const data = await client.generateResourceFromAnnotation(args?.selectionId, {
    name: args?.name,
    entityTypes: args?.entityTypes,
    prompt: args?.prompt,
    language: args?.language,
  });

  return {
    content: [{
      type: 'text' as const,
      text: `Resource generated successfully:\nResource ID: ${data.resource['@id']}\nResource Name: ${data.resource.name}\nAnnotation linked: ${data.annotation.id}`,
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

export async function handleGetResourceAnnotations(_client: SemiontApiClient, _args: any) {
  // NOTE: Use /api/resources/{id}/annotations instead
  return {
    content: [{
      type: 'text' as const,
      text: `Error: This endpoint needs to be updated to use /api/resources/{id}/annotations.`,
    }],
    isError: true,
  };
}

export async function handleGetResourceHighlights(client: SemiontApiClient, args: Record<string, unknown>) {
  const data = await client.getResourceAnnotations(resourceUri(args?.resourceId as string));
  const highlights = data.annotations.filter(a => a.motivation === 'highlighting');

  return {
    content: [{
      type: 'text' as const,
      text: `Found ${highlights.length} highlights in resource:\n${highlights.map(h => {
        // Safely get exact text from TextQuoteSelector
        const targetSelector = typeof h.target === 'string' ? undefined : h.target.selector;
        const selectors = Array.isArray(targetSelector) ? targetSelector : [targetSelector];
        const textQuoteSelector = selectors.find(s => s?.type === 'TextQuoteSelector');
        const text = textQuoteSelector && 'exact' in textQuoteSelector ? textQuoteSelector.exact : h.id;
        return `- ${text}${h.creator ? ` (creator: ${h.creator.name})` : ''}`;
      }).join('\n')}`,
    }],
  };
}

export async function handleGetResourceReferences(client: SemiontApiClient, args: Record<string, unknown>) {
  const data = await client.getResourceAnnotations(resourceUri(args?.resourceId as string));
  const references = data.annotations.filter(a => a.motivation === 'linking');

  return {
    content: [{
      type: 'text' as const,
      text: `Found ${references.length} references in resource:\n${references.map(r => {
        // Use SDK utilities to extract text and source
        const targetSelector = typeof r.target === 'string' ? undefined : r.target.selector;
        const text = getExactText(targetSelector) || r.id;
        const source = getBodySource(r.body);
        return `- ${text} → ${source || 'stub (no link)'}`;
      }).join('\n')}`,
    }],
  };
}
