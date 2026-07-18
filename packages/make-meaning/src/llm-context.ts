/**
 * LLM Context
 *
 * Builds comprehensive context for LLM processing of resources
 * Orchestrates: ResourceContext, GraphContext, AnnotationContext, and generation functions
 */

import { ResourceContext } from './resource-context';
import { GraphContext } from './graph-context';
import { generateResourceSummary, generateReferenceSuggestions } from './generation/resource-generation';
import type { InferenceClient } from '@semiont/inference';
import { getPrimaryRepresentation, getResourceEntityTypes, getResourceId } from '@semiont/core';
import { resourceId as makeResourceId, type Logger, type ResourceId } from '@semiont/core';
import type { GatheredContext } from '@semiont/core';
import type { KnowledgeBase } from './knowledge-base';
import { SmeltProgressTimeout } from './smelt-progress';
import { recordGatherDegrade } from '@semiont/observability';

import type { ResourceDescriptor } from '@semiont/core';

export interface LLMContextOptions {
  depth: number;
  maxResources: number;
  includeContent: boolean;
  includeSummary: boolean;
  /**
   * Entity types to exclude from the resource-gather semantic recall
   * (caller-supplied; e.g. ['Question']). Optional; default none.
   */
  excludeEntityTypes?: string[];
}

export class LLMContext {
  /**
   * Get comprehensive LLM context for a resource
   * Includes: main resource, related resources, annotations, graph, content, summary, references
   */
  static async getResourceContext(
    resourceId: ResourceId,
    options: LLMContextOptions,
    kb: KnowledgeBase,
    inferenceClient: InferenceClient,
    /**
     * Bound on the semanticContext read-your-writes barrier
     * (SMELTER-INDEX-SYNC D3/D5). Operator-owned deployment policy: born in
     * `[environments.<env>.make-meaning.gather] settleTimeoutMs` (the TOML
     * loader holds the ONE default, 15s), threaded here as a plain argument
     * via `MakeMeaningConfig.gather` → Gatherer. Must nest inside downstream
     * watchdogs (A4) — e.g. my-chat's 90s generation stall watchdog.
     */
    settleTimeoutMs: number,
    logger: Logger,
  ): Promise<GatheredContext> {
    // Get main resource from view storage
    const mainDoc = await ResourceContext.getResourceMetadata(resourceId, kb);
    if (!mainDoc) {
      throw new Error('Resource not found');
    }

    // Get content for main resource
    const mainContent = options.includeContent
      ? await ResourceContext.getResourceContent(mainDoc, kb)
      : undefined;

    // Knowledge graph (full neighborhood — resources AND annotations as nodes).
    const graph = await GraphContext.buildKnowledgeGraph(resourceId, kb, logger);

    // Related resources for content. The cap is a view concern (Q2=C): take the first
    // (maxResources - 1) peer resource nodes, matching the previous display count.
    const resourceIdStr = resourceId.toString();
    const relatedDocs: ResourceDescriptor[] = [];
    const relatedNodes = graph.nodes
      .filter((node) => node.type === 'resource' && node.id !== resourceIdStr)
      .slice(0, Math.max(0, options.maxResources - 1));
    for (const node of relatedNodes) {
      const relatedDoc = await ResourceContext.getResourceMetadata(makeResourceId(node.id), kb);
      if (relatedDoc) {
        relatedDocs.push(relatedDoc);
      }
    }

    // Content for related resources, keyed by id.
    const relatedContent: Record<string, string> = {};
    if (options.includeContent) {
      await Promise.all(
        relatedDocs.map(async (doc) => {
          const docId = getResourceId(doc);
          if (!docId) return;
          const content = await ResourceContext.getResourceContent(doc, kb);
          if (content) {
            relatedContent[docId] = content;
          }
        })
      );
    }

    // Generate summary if requested
    const summary = options.includeSummary && mainContent
      ? await generateResourceSummary(
          mainDoc.name,
          mainContent,
          getResourceEntityTypes(mainDoc),
          inferenceClient
        )
      : undefined;

    // Generate reference suggestions if we have content
    const suggestedReferences = mainContent
      ? await generateReferenceSuggestions(mainContent, inferenceClient)
      : undefined;

    const content: { main?: string; related?: Record<string, string> } = {};
    if (mainContent) content.main = mainContent;
    if (options.includeContent) content.related = relatedContent;

    // Semantic recall over the resource's OWN already-indexed vectors (no
    // re-embedding), excluding caller-supplied entity types. The applied filter
    // is recorded on semanticContext as build provenance. EXCLUDE-VECTORS Phase 2b.
    //
    // Read-your-writes barrier (SMELTER-INDEX-SYNC P2): probe first (A3) —
    // an empty result is ambiguous (pending? never-embeddable?) — then wait
    // for the Smelter's settled decision at exactly this content generation
    // (D2) before concluding. Scoped to this slice alone: nothing else in
    // the gather ever waits (D3). Timeout degrades to absent plus exactly
    // one L4 breadcrumb; a `skipped` decision resolves immediately (D4).
    let semanticContext: GatheredContext['semanticContext'];
    const vectors = kb.vectors;
    if (vectors) {
      const excludeEntityTypes = options.excludeEntityTypes ?? [];
      const search = () =>
        vectors.searchByResource(resourceId, {
          limit: options.maxResources,
          scoreThreshold: 0.5,
          ...(excludeEntityTypes.length ? { filter: { excludeEntityTypes } } : {}),
        });

      let matches = await search();
      if (matches.length === 0) {
        const contentChecksum = getPrimaryRepresentation(mainDoc)?.checksum;
        if (contentChecksum) {
          try {
            const outcome = await kb.smeltProgress.whenSettled(resourceIdStr, contentChecksum, settleTimeoutMs);
            if (outcome === 'indexed') {
              matches = await search();
            }
            // 'skipped' | 'inert': legitimately absent — no breadcrumb.
          } catch (error) {
            if (!(error instanceof SmeltProgressTimeout)) throw error;
            // Countable AND loggable: the counter feeds fleet alerting
            // (a rising degrade rate = the Smelter isn't keeping up); the
            // breadcrumb carries the per-incident detail (L4).
            recordGatherDegrade('vectors');
            logger.warn('[gather DEGRADED] semanticContext absent — the vector projection did not settle within the barrier', {
              resourceId: resourceIdStr,
              contentChecksum,
              timeoutMs: settleTimeoutMs,
            });
          }
        }
      }

      if (matches.length > 0) {
        semanticContext = {
          similar: matches.map((m) => ({
            text: m.text,
            resourceId: m.resourceId,
            ...(m.annotationId ? { annotationId: m.annotationId } : {}),
            score: m.score,
            ...(m.entityTypes ? { entityTypes: m.entityTypes } : {}),
          })),
          ...(excludeEntityTypes.length ? { excludedEntityTypes: excludeEntityTypes } : {}),
        };
      }
    }

    // Assemble the unified GatheredContext (focus.kind:'resource'). Related resources and
    // annotations are graph nodes, not separate fields.
    return {
      focus: {
        kind: 'resource',
        resource: mainDoc,
        ...(summary ? { summary } : {}),
        ...(suggestedReferences ? { suggestedReferences } : {}),
        ...(Object.keys(content).length > 0 ? { content } : {}),
      },
      graph,
      ...(semanticContext ? { semanticContext } : {}),
      metadata: {
        resourceType: 'document',
        language: mainDoc.language as string | undefined,
      },
    };
  }
}
