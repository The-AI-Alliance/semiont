/**
 * MCP Tool Handlers — verb-oriented namespace API
 *
 * Each handler receives the client (auth is internal) and raw args.
 * Returns MCP-shaped { content: [{ type: 'text', text }] }.
 */

import { firstValueFrom } from 'rxjs';
import { filter, take, timeout } from 'rxjs/operators';
import { SemiontApiClient, getExactText, getBodySource } from '@semiont/api-client';
import { resourceId, annotationId, type GatheredContext, type YieldProgress } from '@semiont/core';

type McpResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

// ── Browse ──────────────────────────────────────────────────────────────────

export async function browseResource(semiont: SemiontApiClient, args: any): Promise<McpResult> {
  const data = await semiont.browseResource(resourceId(args?.id), { auth: undefined });
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export async function browseResources(semiont: SemiontApiClient, args: any): Promise<McpResult> {
  const data = await semiont.browseResources(args?.limit, args?.archived ?? false, undefined, { auth: undefined });
  return {
    content: [{
      type: 'text',
      text: `Found ${data.total} resources:\n${data.resources.map((d: any) => `- ${d.name} (${d['@id'] ?? d.id}) — ${d.entityTypes?.join(', ') || 'no types'}`).join('\n')}`,
    }],
  };
}

export async function browseHighlights(semiont: SemiontApiClient, args: any): Promise<McpResult> {
  const data = await semiont.browseAnnotations(resourceId(args?.resourceId), undefined, { auth: undefined });
  const highlights = data.annotations.filter(a => a.motivation === 'highlighting');
  return {
    content: [{
      type: 'text',
      text: `Found ${highlights.length} highlights:\n${highlights.map(h => {
        const sel = typeof h.target === 'string' ? undefined : h.target.selector;
        const selectors = Array.isArray(sel) ? sel : [sel];
        const tq = selectors.find(s => s?.type === 'TextQuoteSelector');
        const text = tq && 'exact' in tq ? tq.exact : h.id;
        return `- ${text}`;
      }).join('\n')}`,
    }],
  };
}

export async function browseReferences(semiont: SemiontApiClient, args: any): Promise<McpResult> {
  const data = await semiont.browseAnnotations(resourceId(args?.resourceId), undefined, { auth: undefined });
  const references = data.annotations.filter(a => a.motivation === 'linking');
  return {
    content: [{
      type: 'text',
      text: `Found ${references.length} references:\n${references.map(r => {
        const sel = typeof r.target === 'string' ? undefined : r.target.selector;
        const text = getExactText(sel) || r.id;
        const source = getBodySource(r.body);
        return `- ${text} → ${source || 'stub (no link)'}`;
      }).join('\n')}`,
    }],
  };
}

// ── Mark ────────────────────────────────────────────────────────────────────

export async function markAnnotation(semiont: SemiontApiClient, args: any): Promise<McpResult> {
  const selectionData = args?.selectionData || {};
  const entityTypes = args?.entityTypes || [];

  const body = entityTypes.map((value: string) => ({
    type: 'TextualBody' as const, value, purpose: 'tagging' as const,
  }));

  const rId = resourceId(args?.resourceId);
  const data = await semiont.mark.annotation(rId, {
    motivation: 'highlighting',
    target: {
      source: args?.resourceId,
      selector: [
        { type: 'TextPositionSelector', start: selectionData.offset || 0, end: (selectionData.offset || 0) + (selectionData.length || 0) },
        { type: 'TextQuoteSelector', exact: selectionData.text || '' },
      ],
    },
    body,
  });

  return { content: [{ type: 'text', text: `Annotation created: ${data.annotationId}` }] };
}

export async function markAssist(semiont: SemiontApiClient, args: any): Promise<McpResult> {
  const rId = resourceId(args?.resourceId);
  const entityTypes = args?.entityTypes || [];
  const progressMessages: string[] = [];

  return new Promise<McpResult>((resolve) => {
    semiont.mark.assist(rId, 'linking', { entityTypes, includeDescriptiveReferences: false }).subscribe({
      next: (progress) => {
        if ('status' in progress) {
          progressMessages.push(`${progress.status}: ${progress.percentage ?? 0}%`);
        }
        if ('foundCount' in progress) {
          resolve({
            content: [{ type: 'text', text: `Detection complete. Found ${progress.foundCount || 0} entities.\n${progressMessages.join('\n')}` }],
          });
        }
      },
      error: (err) => resolve({ content: [{ type: 'text', text: `Detection failed: ${err.message}` }], isError: true }),
      complete: () => resolve({ content: [{ type: 'text', text: `Detection complete.\n${progressMessages.join('\n')}` }] }),
    });
  });
}

// ── Bind ────────────────────────────────────────────────────────────────────

export async function bindBody(semiont: SemiontApiClient, args: any): Promise<McpResult> {
  await semiont.bind.body(
    resourceId(args?.sourceResourceId),
    annotationId(args?.annotationId),
    [{ op: 'add', item: { type: 'SpecificResource', source: args?.targetResourceId, purpose: 'linking' } }],
  );
  return { content: [{ type: 'text', text: `Linked ${args?.annotationId} → ${args?.targetResourceId}` }] };
}

// ── Gather ──────────────────────────────────────────────────────────────────

export async function gatherAnnotation(semiont: SemiontApiClient, args: any): Promise<McpResult> {
  const rId = resourceId(args?.resourceId);
  const aId = annotationId(args?.annotationId);

  const completion = await firstValueFrom(
    semiont.gather.annotation(aId, rId, { contextWindow: args?.contextWindow ?? 2000 }).pipe(
      filter((e): e is Extract<typeof e, { response: unknown }> => 'response' in e),
      take(1),
      timeout(60_000),
    ),
  );

  return { content: [{ type: 'text', text: JSON.stringify((completion as any).response, null, 2) }] };
}

// ── Yield ───────────────────────────────────────────────────────────────────

export async function yieldResource(semiont: SemiontApiClient, args: any): Promise<McpResult> {
  const format = args?.contentType || 'text/plain';
  const content = args?.content || '';
  const blob = new Blob([content], { type: format });
  const file = new File([blob], args?.name + '.txt', { type: format });

  const data = await semiont.yield.resource({
    name: args?.name, file, format, storageUri: args?.storageUri,
    entityTypes: args?.entityTypes || [],
  });

  return { content: [{ type: 'text', text: `Resource created: ${data.resourceId}` }] };
}

export async function yieldFromAnnotation(semiont: SemiontApiClient, args: any): Promise<McpResult> {
  const rId = resourceId(args?.resourceId);
  const aId = annotationId(args?.annotationId);

  // Gather context first
  const gatherResult = await firstValueFrom(
    semiont.gather.annotation(aId, rId, { contextWindow: 2000 }).pipe(
      filter((e): e is Extract<typeof e, { response: unknown }> => 'response' in e),
      take(1),
      timeout(60_000),
    ),
  );

  const ctx = (gatherResult as any).response?.context as GatheredContext;
  if (!ctx) throw new Error('Failed to gather context');

  // Generate
  const progressMessages: string[] = [];
  return new Promise<McpResult>((resolve) => {
    semiont.yield.fromAnnotation(rId, aId, {
      title: args?.title ?? 'Generated',
      storageUri: args?.storageUri,
      context: ctx,
      prompt: args?.prompt,
      language: args?.language,
    }).subscribe({
      next: (p: YieldProgress) => { progressMessages.push(`${p.status}: ${p.percentage}%`); },
      error: (err) => resolve({ content: [{ type: 'text', text: `Generation failed: ${err.message}` }], isError: true }),
      complete: () => resolve({ content: [{ type: 'text', text: `Generation complete.\n${progressMessages.join('\n')}` }] }),
    });
  });
}
