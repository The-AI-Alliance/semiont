/**
 * MCP Tool Handlers — verb-oriented namespace API
 *
 * Each handler receives the client (auth is internal) and raw args.
 * Returns MCP-shaped { content: [{ type: 'text', text }] }.
 */

import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import { getExactText, getBodySource } from '@semiont/core';
import { SemiontClient, createGatherVM, createMarkVM, createYieldVM } from '@semiont/sdk';
import { resourceId, annotationId, type GatheredContext } from '@semiont/core';

type McpResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

// ── Browse ──────────────────────────────────────────────────────────────────

export async function browseResource(semiont: SemiontClient, args: any): Promise<McpResult> {
  const data = await semiont.browseResource(resourceId(args?.id), { auth: undefined });
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export async function browseResources(semiont: SemiontClient, args: any): Promise<McpResult> {
  const data = await semiont.browseResources(args?.limit, args?.archived ?? false, undefined, { auth: undefined });
  return {
    content: [{
      type: 'text',
      text: `Found ${data.total} resources:\n${data.resources.map((d: any) => `- ${d.name} (${d['@id'] ?? d.id}) — ${d.entityTypes?.join(', ') || 'no types'}`).join('\n')}`,
    }],
  };
}

export async function browseHighlights(semiont: SemiontClient, args: any): Promise<McpResult> {
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

export async function browseReferences(semiont: SemiontClient, args: any): Promise<McpResult> {
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

export async function markAnnotation(semiont: SemiontClient, args: any): Promise<McpResult> {
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

export async function markAssist(semiont: SemiontClient, args: any): Promise<McpResult> {
  const rId = resourceId(args?.resourceId);
  const vm = createMarkVM(semiont, rId);

  try {
    const progressMessages: string[] = [];
    semiont.bus.get('mark:assist-request').next({
      motivation: 'linking',
      options: { entityTypes: args?.entityTypes || [], includeDescriptiveReferences: false },
    });

    return await new Promise<McpResult>((resolve) => {
      const progressSub = vm.progress$.pipe(
        filter((p): p is NonNullable<typeof p> => p !== null),
      ).subscribe((p) => { progressMessages.push(`${p.stage}: ${p.percentage ?? 0}%`); });

      const isAnnotationJob = (jt: string) => jt !== 'generation';
      const completeSub = semiont.bus.get('job:complete').subscribe((event) => {
        if (!isAnnotationJob(event.jobType)) return;
        cleanup();
        const foundCount = (event.result as { entitiesFound?: number; highlightsFound?: number; commentsFound?: number; assessmentsFound?: number; tagsFound?: number; totalFound?: number } | undefined);
        const count =
          foundCount?.totalFound ?? foundCount?.highlightsFound ?? foundCount?.commentsFound ??
          foundCount?.assessmentsFound ?? foundCount?.tagsFound ?? 0;
        resolve({ content: [{ type: 'text', text: `Detection complete. Found ${count} entities.\n${progressMessages.join('\n')}` }] });
      });
      const failSub = semiont.bus.get('job:fail').subscribe((event) => {
        if (!isAnnotationJob(event.jobType)) return;
        cleanup();
        resolve({ content: [{ type: 'text', text: `Detection failed: ${event.error}` }], isError: true });
      });
      function cleanup() { progressSub.unsubscribe(); completeSub.unsubscribe(); failSub.unsubscribe(); }
    });
  } finally {
    vm.dispose();
  }
}

// ── Bind ────────────────────────────────────────────────────────────────────

export async function bindBody(semiont: SemiontClient, args: any): Promise<McpResult> {
  await semiont.bind.body(
    resourceId(args?.sourceResourceId),
    annotationId(args?.annotationId),
    [{ op: 'add', item: { type: 'SpecificResource', source: args?.targetResourceId, purpose: 'linking' } }],
  );
  return { content: [{ type: 'text', text: `Linked ${args?.annotationId} → ${args?.targetResourceId}` }] };
}

// ── Gather ──────────────────────────────────────────────────────────────────

export async function gatherAnnotation(semiont: SemiontClient, args: any): Promise<McpResult> {
  const rId = resourceId(args?.resourceId);
  const aId = annotationId(args?.annotationId);
  const vm = createGatherVM(semiont, rId);

  try {
    semiont.bus.get('gather:requested').next({
      correlationId: crypto.randomUUID(),
      annotationId: aId as string,
      resourceId: rId as string,
      options: { contextWindow: args?.contextWindow ?? 2000 },
    });

    const context = await firstValueFrom(
      vm.context$.pipe(filter((c): c is NonNullable<typeof c> => c !== null)),
    );

    return { content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] };
  } finally {
    vm.dispose();
  }
}

// ── Yield ───────────────────────────────────────────────────────────────────

export async function yieldResource(semiont: SemiontClient, args: any): Promise<McpResult> {
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

export async function yieldFromAnnotation(semiont: SemiontClient, args: any): Promise<McpResult> {
  const rId = resourceId(args?.resourceId);
  const aId = annotationId(args?.annotationId);

  // Step 1: gather context via GatherVM
  const gatherVM = createGatherVM(semiont, rId);
  let ctx: GatheredContext;
  try {
    semiont.bus.get('gather:requested').next({
      correlationId: crypto.randomUUID(),
      annotationId: aId as string,
      resourceId: rId as string,
      options: { contextWindow: 2000 },
    });
    ctx = await firstValueFrom(
      gatherVM.context$.pipe(filter((c): c is NonNullable<typeof c> => c !== null)),
    );
  } finally {
    gatherVM.dispose();
  }

  // Step 2: generate via YieldVM
  const yieldVM = createYieldVM(semiont, rId, args?.language ?? 'en');
  try {
    yieldVM.generate(aId as string, {
      title: args?.title ?? 'Generated',
      storageUri: args?.storageUri,
      context: ctx,
      prompt: args?.prompt,
      language: args?.language,
    });

    const progressMessages: string[] = [];
    return await new Promise<McpResult>((resolve) => {
      const progressSub = yieldVM.progress$.pipe(
        filter((p): p is NonNullable<typeof p> => p !== null),
      ).subscribe((p) => { progressMessages.push(`${p.stage}: ${p.percentage}%`); });

      const completeSub = semiont.bus.get('job:complete').subscribe((event) => {
        if (event.jobType !== 'generation') return;
        cleanup();
        resolve({ content: [{ type: 'text', text: `Generation complete.\n${progressMessages.join('\n')}` }] });
      });
      const failSub = semiont.bus.get('job:fail').subscribe((event) => {
        if (event.jobType !== 'generation') return;
        cleanup();
        resolve({ content: [{ type: 'text', text: `Generation failed: ${event.error}` }], isError: true });
      });
      function cleanup() { progressSub.unsubscribe(); completeSub.unsubscribe(); failSub.unsubscribe(); }
    });
  } finally {
    yieldVM.dispose();
  }
}
