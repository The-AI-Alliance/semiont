/**
 * MCP Tool Handlers — verb-oriented namespace API
 *
 * Each handler receives the client (auth is internal) and raw args.
 * Returns MCP-shaped { content: [{ type: 'text', text }] }.
 */

import { lastValueFrom, type Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { getExactText, getBodySource } from '@semiont/core';
import { resourceId, annotationId } from '@semiont/core';
import type {
  Annotation,
  AnnotationId,
  BodyOperation,
  GatheredContext,
  Motivation,
  ResourceDescriptor,
  ResourceId,
} from '@semiont/core';
import type {
  CreateAnnotationInput,
  CreateResourceInput,
  GatherAnnotationProgress,
  GenerationOptions,
  MarkAssistEvent,
  MarkAssistOptions,
  YieldGenerationEvent,
} from '@semiont/sdk';

export type McpResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/**
 * The slice of `SemiontClient` these handlers use.
 *
 * `SemiontClient` satisfies it structurally, so `index.ts` passes its client
 * unchanged. Naming the slice keeps the dependency honest — this is the whole
 * of the SDK surface the MCP server touches — and lets tests supply a stub
 * without casting. Return types are the loosest thing the handlers actually
 * rely on (`PromiseLike` where they await, `Observable` where they pipe), so a
 * stub returns a plain promise or `of(...)`.
 */
export interface McpClient {
  browse: {
    resource(resourceId: ResourceId): PromiseLike<ResourceDescriptor>;
    resources(filters: { limit?: number; archived?: boolean; search?: string }): PromiseLike<ResourceDescriptor[]>;
    annotations(resourceId: ResourceId): PromiseLike<Annotation[]>;
  };
  mark: {
    annotation(input: CreateAnnotationInput): Promise<{ annotationId: AnnotationId }>;
    assist(resourceId: ResourceId, motivation: Motivation, options: MarkAssistOptions): Observable<MarkAssistEvent>;
  };
  bind: {
    body(resourceId: ResourceId, annotationId: AnnotationId, operations: BodyOperation[]): Promise<void>;
  };
  gather: {
    annotation(
      resourceId: ResourceId,
      annotationId: AnnotationId,
      options?: { contextWindow?: number },
    ): PromiseLike<GatherAnnotationProgress>;
  };
  yield: {
    resource(data: CreateResourceInput): PromiseLike<{ resourceId: ResourceId }>;
    fromAnnotation(
      resourceId: ResourceId,
      annotationId: AnnotationId,
      options: GenerationOptions,
    ): Observable<YieldGenerationEvent>;
  };
}

/**
 * `gather.annotation` awaits to the stream's final event — a
 * `GatherAnnotationComplete` envelope whose `response` carries the context.
 * The envelope itself is not a `GatheredContext`.
 */
function gatheredContext(final: GatherAnnotationProgress): GatheredContext {
  if (!('response' in final)) {
    throw new Error('Gather finished without a context payload');
  }
  return final.response;
}

// ── Browse ──────────────────────────────────────────────────────────────────

export async function browseResource(semiont: McpClient, args: any): Promise<McpResult> {
  const data = await semiont.browse.resource(resourceId(args?.id));
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export async function browseResources(semiont: McpClient, args: any): Promise<McpResult> {
  const filters: { limit?: number; archived?: boolean; search?: string } = {};
  if (args?.limit !== undefined) filters.limit = args.limit;
  if (args?.search !== undefined) filters.search = args.search;
  filters.archived = args?.archived ?? false;
  const resources = await semiont.browse.resources(filters);
  return {
    content: [{
      type: 'text',
      text: `Found ${resources.length} resources:\n${resources.map(d => `- ${d.name} (${d['@id']}) — ${d.entityTypes?.join(', ') || 'no types'}`).join('\n')}`,
    }],
  };
}

export async function browseHighlights(semiont: McpClient, args: any): Promise<McpResult> {
  const annotations = await semiont.browse.annotations(resourceId(args?.resourceId));
  const highlights = annotations.filter(a => a.motivation === 'highlighting');
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

export async function browseReferences(semiont: McpClient, args: any): Promise<McpResult> {
  const annotations = await semiont.browse.annotations(resourceId(args?.resourceId));
  const references = annotations.filter(a => a.motivation === 'linking');
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

export async function markAnnotation(semiont: McpClient, args: any): Promise<McpResult> {
  const selectionData = args?.selectionData || {};
  const entityTypes = args?.entityTypes || [];

  const body = entityTypes.map((value: string) => ({
    type: 'TextualBody' as const, value, purpose: 'tagging' as const,
  }));

  const data = await semiont.mark.annotation({
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

export async function markAssist(semiont: McpClient, args: any): Promise<McpResult> {
  const rId = resourceId(args?.resourceId);
  const progressMessages: string[] = [];

  try {
    const final = await lastValueFrom(
      semiont.mark.assist(rId, 'linking', {
        entityTypes: args?.entityTypes || [],
        includeDescriptiveReferences: false,
        // Annotation body locale (stamped on the unresolved-reference
        // body's `language` field) and source-resource locale (fed into
        // the prompt). Both optional — caller specifies BCP-47 tags.
        language: args?.language,
        sourceLanguage: args?.sourceLanguage,
      }).pipe(
        tap((e) => {
          if (e.kind === 'progress') progressMessages.push(`${e.data.stage}: ${e.data.percentage}%`);
        }),
      ),
    );
    const r = (final.kind === 'complete' ? final.data.result : undefined) as
      | { entitiesFound?: number; highlightsFound?: number; commentsFound?: number; assessmentsFound?: number; tagsFound?: number; totalFound?: number }
      | undefined;
    const count =
      r?.totalFound ?? r?.highlightsFound ?? r?.commentsFound ??
      r?.assessmentsFound ?? r?.tagsFound ?? 0;
    return { content: [{ type: 'text', text: `Detection complete. Found ${count} entities.\n${progressMessages.join('\n')}` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Detection failed: ${(err as Error).message}` }], isError: true };
  }
}

// ── Bind ────────────────────────────────────────────────────────────────────

export async function bindBody(semiont: McpClient, args: any): Promise<McpResult> {
  await semiont.bind.body(
    resourceId(args?.sourceResourceId),
    annotationId(args?.annotationId),
    [{ op: 'add', item: { type: 'SpecificResource', source: args?.targetResourceId, purpose: 'linking' } }],
  );
  return { content: [{ type: 'text', text: `Linked ${args?.annotationId} → ${args?.targetResourceId}` }] };
}

// ── Gather ──────────────────────────────────────────────────────────────────

export async function gatherAnnotation(semiont: McpClient, args: any): Promise<McpResult> {
  const rId = resourceId(args?.resourceId);
  const aId = annotationId(args?.annotationId);

  const final = await semiont.gather.annotation(rId, aId, { contextWindow: args?.contextWindow ?? 2000 });

  return { content: [{ type: 'text', text: JSON.stringify(gatheredContext(final), null, 2) }] };
}

// ── Yield ───────────────────────────────────────────────────────────────────

export async function yieldResource(semiont: McpClient, args: any): Promise<McpResult> {
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

export async function yieldFromAnnotation(semiont: McpClient, args: any): Promise<McpResult> {
  const rId = resourceId(args?.resourceId);
  const aId = annotationId(args?.annotationId);

  // Step 1: gather context
  const ctx = gatheredContext(await semiont.gather.annotation(rId, aId, { contextWindow: 2000 }));

  // Step 2: generate. yield.fromAnnotation streams progress, then ends with
  // a `complete` event carrying the JobCompleteCommand (with `result`).
  const progressMessages: string[] = [];
  try {
    // Default sourceLanguage from the gathered context's metadata, which the
    // backend populates from the primary representation. Caller can still
    // override via args.sourceLanguage.
    const ctxSourceLanguage = ctx.metadata?.language;

    await lastValueFrom(
      semiont.yield.fromAnnotation(rId, aId, {
        title: args?.title ?? 'Generated',
        storageUri: args?.storageUri,
        context: ctx,
        prompt: args?.prompt,
        language: args?.language,
        sourceLanguage: args?.sourceLanguage ?? ctxSourceLanguage,
      }).pipe(
        tap((e) => {
          if (e.kind === 'progress') progressMessages.push(`${e.data.stage}: ${e.data.percentage}%`);
        }),
      ),
    );
    return { content: [{ type: 'text', text: `Generation complete.\n${progressMessages.join('\n')}` }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Generation failed: ${(err as Error).message}` }], isError: true };
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Route a `tools/call` to its handler. Every name here has an entry in
 * `TOOLS` (tools.ts). Anything else — and any error a handler throws — comes
 * back as an `isError` result rather than a protocol-level failure.
 */
export async function callTool(semiont: McpClient, name: string, args: any): Promise<McpResult> {
  try {
    switch (name) {
      case 'browse_resource':       return await browseResource(semiont, args);
      case 'browse_resources':      return await browseResources(semiont, args);
      case 'browse_highlights':     return await browseHighlights(semiont, args);
      case 'browse_references':     return await browseReferences(semiont, args);
      case 'mark_annotation':       return await markAnnotation(semiont, args);
      case 'mark_assist':           return await markAssist(semiont, args);
      case 'bind_body':             return await bindBody(semiont, args);
      case 'gather_annotation':     return await gatherAnnotation(semiont, args);
      case 'yield_resource':        return await yieldResource(semiont, args);
      case 'yield_from_annotation': return await yieldFromAnnotation(semiont, args);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}` }],
      isError: true,
    };
  }
}
