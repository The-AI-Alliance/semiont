/**
 * Tool execution handlers using @semiont/api-client
 */

import { SemiontApiClient, getExactText, getBodySource, type ReferenceDetectionProgress, type GenerationProgress } from '@semiont/api-client';
import { EventBus, resourceUri, annotationUri, entityType, type AccessToken } from '@semiont/core';

export async function handleCreateResource(client: SemiontApiClient, auth: AccessToken, args: any) {
  // Create File from content string for multipart/form-data upload
  const format = args?.contentType || 'text/plain';
  const content = args?.content || '';
  const blob = new Blob([content], { type: format });
  const file = new File([blob], args?.name + '.txt', { type: format });

  const data = await client.createResource({
    name: args?.name,
    file: file,
    format: format,
    entityTypes: args?.entityTypes || [],
  }, { auth });

  return {
    content: [{
      type: 'text' as const,
      text: `Resource created successfully:\nID: ${data.resource.id}\nName: ${data.resource.name}\nEntity Types: ${data.resource.entityTypes?.join(', ') || 'None'}`,
    }],
  };
}

export async function handleGetResource(client: SemiontApiClient, auth: AccessToken, id: string) {
  const data = await client.getResource(resourceUri(id), { auth });

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2),
    }],
  };
}

export async function handleListResources(client: SemiontApiClient, auth: AccessToken, args: any) {
  const data = await client.listResources(
    args?.limit,
    args?.archived ?? false,
    undefined, // query parameter
    { auth }
  );

  return {
    content: [{
      type: 'text' as const,
      text: `Found ${data.total} resources:\n${data.resources.map((d: any) => `- ${d.name} (${d.id}) - ${d.entityTypes?.join(', ') || 'No types'}`).join('\n')}`,
    }],
  };
}

export async function handleDetectAnnotations(client: SemiontApiClient, auth: AccessToken, args: any) {
  const rUri = resourceUri(args?.resourceId);
  const entityTypes = args?.entityTypes || [];

  return new Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>((resolve) => {
    const mappedEntityTypes = (entityTypes as string[]).map(t => entityType(t));
    const eventBus = new EventBus();
    const progressMessages: string[] = [];

    // Subscribe to detection events
    eventBus.get('detection:progress').subscribe((progress) => {
      // Cast to ReferenceDetectionProgress for entity-type-specific fields
      const refProgress = progress as unknown as ReferenceDetectionProgress;
      const msg = progress.status === 'scanning' && refProgress.currentEntityType
        ? `Scanning for ${refProgress.currentEntityType}... (${refProgress.processedEntityTypes}/${refProgress.totalEntityTypes})`
        : `Status: ${progress.status}`;
      progressMessages.push(msg);
      console.error(msg); // Send to stderr for MCP progress
    });

    eventBus.get('detection:complete').subscribe((result) => {
      const progress = result.progress as ReferenceDetectionProgress | undefined;
      eventBus.destroy();
      resolve({
        content: [{
          type: 'text' as const,
          text: `Entity detection complete!\nFound ${progress?.foundCount || 0} entities\n\nProgress:\n${progressMessages.join('\n')}`,
        }],
      });
    });

    eventBus.get('detection:failed').subscribe(() => {
      eventBus.destroy();
      resolve({
        content: [{
          type: 'text' as const,
          text: `Entity detection failed`,
        }],
        isError: true,
      });
    });

    // Start detection - events auto-emit to EventBus
    client.sse.detectReferences(rUri, { entityTypes: mappedEntityTypes }, { auth, eventBus });
  });
}

export async function handleCreateAnnotation(client: SemiontApiClient, auth: AccessToken, args: any) {
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
  }, { auth });

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

export async function handleSaveAnnotation(_client: SemiontApiClient, _auth: AccessToken, _args: any) {
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

export async function handleResolveAnnotation(client: SemiontApiClient, auth: AccessToken, args: any) {
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
  }, { auth });

  return {
    content: [{
      type: 'text' as const,
      text: `Annotation linked to resource:\nAnnotation ID: ${data.annotation.id}\nLinked to: ${args?.resourceId || 'null'}`,
    }],
  };
}

export async function handleGenerateResourceFromAnnotation(client: SemiontApiClient, auth: AccessToken, args: any) {
  const rUri = resourceUri(args?.resourceId);
  const aUri = annotationUri(args?.annotationId);

  // Extract annotation ID from full URI for context fetch
  const annotationId = aUri.split('/').pop();
  if (!annotationId) {
    throw new Error('Invalid annotation URI');
  }

  // Fetch context before generation
  const contextData = await client.getAnnotationLLMContext(rUri, annotationId, { contextWindow: 2000, auth });

  if (!contextData?.context) {
    throw new Error('Failed to fetch generation context');
  }

  const request = {
    title: args?.title,
    prompt: args?.prompt,
    language: args?.language,
    context: contextData.context,
  };

  return new Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>((resolve) => {
    const eventBus = new EventBus();
    const progressMessages: string[] = [];

    // Subscribe to generation events
    eventBus.get('generation:progress').subscribe((progress: GenerationProgress) => {
      const msg = `${progress.status}: ${progress.percentage}% - ${progress.message || ''}`;
      progressMessages.push(msg);
      console.error(msg); // Send to stderr for MCP progress
    });

    eventBus.get('generation:complete').subscribe((result) => {
      const progress = result.progress;
      eventBus.destroy();
      resolve({
        content: [{
          type: 'text' as const,
          text: `Resource generation complete!\nResource ID: ${progress.resourceId || 'unknown'}\nResource Name: ${progress.resourceName || 'unknown'}\n\nProgress:\n${progressMessages.join('\n')}`,
        }],
      });
    });

    eventBus.get('generation:failed').subscribe(() => {
      eventBus.destroy();
      resolve({
        content: [{
          type: 'text' as const,
          text: `Resource generation failed`,
        }],
        isError: true,
      });
    });

    // Start generation - events auto-emit to EventBus
    client.sse.generateResourceFromAnnotation(rUri, aUri, request, { auth, eventBus });
  });
}

export async function handleGetContextualSummary(_client: SemiontApiClient, _auth: AccessToken, _args: any) {
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

export async function handleGetSchemaDescription(_client: SemiontApiClient, _auth: AccessToken) {
  // NOTE: /schema-description endpoint was removed
  return {
    content: [{
      type: 'text' as const,
      text: `Error: The schema-description endpoint is no longer available.`,
    }],
    isError: true,
  };
}

export async function handleGetLLMContext(_client: SemiontApiClient, _auth: AccessToken, _args: any) {
  // NOTE: Endpoint path may have changed - need to verify correct path
  return {
    content: [{
      type: 'text' as const,
      text: `Error: The llm-context endpoint path needs to be updated.`,
    }],
    isError: true,
  };
}

export async function handleGetResourceAnnotations(_client: SemiontApiClient, _auth: AccessToken, _args: any) {
  // NOTE: Use /api/resources/{id}/annotations instead
  return {
    content: [{
      type: 'text' as const,
      text: `Error: This endpoint needs to be updated to use /api/resources/{id}/annotations.`,
    }],
    isError: true,
  };
}

export async function handleGetResourceHighlights(client: SemiontApiClient, auth: AccessToken, args: Record<string, unknown>) {
  const data = await client.getResourceAnnotations(resourceUri(args?.resourceId as string), { auth });
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

export async function handleGetResourceReferences(client: SemiontApiClient, auth: AccessToken, args: Record<string, unknown>) {
  const data = await client.getResourceAnnotations(resourceUri(args?.resourceId as string), { auth });
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
