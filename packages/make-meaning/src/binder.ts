/**
 * Binder Actor
 *
 * Bridge between the event bus and the knowledge base for entity resolution.
 * Subscribes to bind search events and referenced-by queries, queries KB stores
 * (graph, views), and emits results back to the bus.
 *
 * From ARCHITECTURE.md:
 * "When an Analyst or Linker Agent emits a bind event, the Binder receives it
 * from the bus, searches the KB stores for matching resources, and resolves
 * references — linking a mention to its referent."
 *
 * Handles:
 * - bind:search-requested — search for binding candidates
 * - bind:referenced-by-requested — find annotations that reference a resource
 *
 * The Binder handles only the read side (searching for candidates).
 * The write side (annotation.body.updated) stays in the route where
 * userId is available from auth context. That domain event still flows
 * through the bus via EventStore auto-publish.
 */

import { Subscription, from } from 'rxjs';
import { concatMap, mergeMap } from 'rxjs/operators';
import type { EventMap, GatheredContext, Logger, components } from '@semiont/core';
import { type EventBus, resourceId, uriToResourceId } from '@semiont/core';
import { getExactText, getResourceId, getResourceEntityTypes, getTargetSource, getTargetSelector } from '@semiont/api-client';
import type { InferenceClient } from '@semiont/inference';
import type { KnowledgeBase } from './knowledge-base';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

export class Binder {
  private subscriptions: Subscription[] = [];
  private readonly logger: Logger;

  constructor(
    private kb: KnowledgeBase,
    private eventBus: EventBus,
    logger: Logger,
    private inferenceClient?: InferenceClient,
  ) {
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('Binder actor initialized');

    const errorHandler = (err: unknown) => this.logger.error('Binder pipeline error', { error: err });

    const search$ = this.eventBus.get('bind:search-requested').pipe(
      concatMap((event) => from(this.handleSearch(event))),
    );

    // mergeMap: referenced-by queries are independent reads — safe to run concurrently
    const referencedBy$ = this.eventBus.get('bind:referenced-by-requested').pipe(
      mergeMap((event) => from(this.handleReferencedBy(event))),
    );

    this.subscriptions.push(
      search$.subscribe({ error: errorHandler }),
      referencedBy$.subscribe({ error: errorHandler }),
    );
  }

  private async handleSearch(event: EventMap['bind:search-requested']): Promise<void> {
    try {
      this.logger.debug('Searching for binding candidates', {
        referenceId: event.referenceId,
        searchTerm: event.searchTerm,
        hasContext: !!event.context,
      });

      if (!event.context) {
        // No context — fall back to simple name search
        const results = await this.kb.graph.searchResources(event.searchTerm);
        this.eventBus.get('bind:search-results').next({
          referenceId: event.referenceId,
          searchTerm: event.searchTerm,
          results,
        });
        return;
      }

      // Context-driven multi-source retrieval + ranking
      const context = event.context;
      const scored = await this.contextDrivenSearch(event.searchTerm, context);

      this.eventBus.get('bind:search-results').next({
        referenceId: event.referenceId,
        searchTerm: event.searchTerm,
        results: scored,
      });
    } catch (error) {
      this.logger.error('Bind search failed', {
        referenceId: event.referenceId,
        error,
      });
      this.eventBus.get('bind:search-failed').next({
        referenceId: event.referenceId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  /**
   * Context-driven search: multi-source retrieval + composite scoring
   *
   * Retrieval sources:
   * 1. Name match — graph.searchResources(searchTerm)
   * 2. Entity type match — graph.listResources({ entityTypes })
   * 3. Graph neighborhood — connections from GatheredContext
   *
   * Ranking signals:
   * - Entity type overlap (Jaccard similarity)
   * - Bidirectionality (already connected both ways)
   * - Citation weight (well-connected = important)
   * - Name match quality (exact > prefix > contains)
   * - Recency (newer resources scored higher)
   */
  private async contextDrivenSearch(
    searchTerm: string,
    context: GatheredContext,
  ): Promise<Array<ResourceDescriptor & { score: number; matchReason: string }>> {
    const annotationEntityTypes = context.metadata?.entityTypes ?? [];
    const connections = context.graphContext?.connections ?? [];

    // 1. Multi-source candidate retrieval (parallel)
    const [nameMatches, entityTypeMatches] = await Promise.all([
      this.kb.graph.searchResources(searchTerm),
      annotationEntityTypes.length > 0
        ? this.kb.graph.listResources({ entityTypes: annotationEntityTypes, limit: 50 })
            .then(r => r.resources)
        : Promise.resolve([]),
    ]);

    // 3. Graph neighborhood candidates — fetch full resources for connection IDs
    const neighborResources = await Promise.all(
      connections.map(conn =>
        this.kb.graph.getResource(resourceId(conn.resourceId)).catch(() => null)
      ),
    );

    // Union and deduplicate by resource ID
    const candidateMap = new Map<string, {
      resource: ResourceDescriptor;
      sources: Set<string>;
    }>();

    const addCandidate = (resource: ResourceDescriptor, source: string) => {
      const id = getResourceId(resource);
      if (!id) return;
      const existing = candidateMap.get(id);
      if (existing) {
        existing.sources.add(source);
      } else {
        candidateMap.set(id, { resource, sources: new Set([source]) });
      }
    };

    for (const r of nameMatches) addCandidate(r, 'name');
    for (const r of entityTypeMatches) addCandidate(r, 'entityType');
    for (const r of neighborResources) {
      if (r) addCandidate(r, 'neighborhood');
    }

    this.logger.debug('Candidate retrieval', {
      nameMatches: nameMatches.length,
      entityTypeMatches: entityTypeMatches.length,
      neighborResources: neighborResources.filter(Boolean).length,
      totalCandidates: candidateMap.size,
    });

    // 2. Score each candidate
    const connectionIds = new Set(connections.map(c => c.resourceId));
    const bidirectionalIds = new Set(
      connections.filter(c => c.bidirectional).map(c => c.resourceId),
    );
    const entityTypeFreqs = context.graphContext?.entityTypeFrequencies ?? {};
    const searchTermLower = searchTerm.toLowerCase();

    const scored = Array.from(candidateMap.values()).map(({ resource, sources }) => {
      const id = getResourceId(resource) ?? '';
      const candidateEntityTypes = getResourceEntityTypes(resource);
      const reasons: string[] = [];
      let score = 0;

      // Entity type overlap (Jaccard similarity, 0-1, weighted by 30)
      if (annotationEntityTypes.length > 0 && candidateEntityTypes.length > 0) {
        const intersection = annotationEntityTypes.filter(t => candidateEntityTypes.includes(t));
        const union = new Set([...annotationEntityTypes, ...candidateEntityTypes]);
        const jaccard = intersection.length / union.size;
        // IDF weighting: rare entity types count more
        let idfBoost = 0;
        for (const t of intersection) {
          const freq = entityTypeFreqs[t] ?? 1;
          idfBoost += 1 / Math.log2(freq + 1);
        }
        const entityScore = jaccard * 30 + idfBoost * 5;
        score += entityScore;
        if (intersection.length > 0) {
          reasons.push(`entity types: ${intersection.join(', ')}`);
        }
      }

      // Bidirectionality (already connected both ways = strong signal)
      if (bidirectionalIds.has(id)) {
        score += 20;
        reasons.push('bidirectional connection');
      } else if (connectionIds.has(id)) {
        score += 10;
        reasons.push('connected');
      }

      // Citation weight (well-connected candidates are more important)
      const citedByCount = context.graphContext?.citedByCount ?? 0;
      if (sources.has('neighborhood') && citedByCount > 0) {
        score += Math.min(citedByCount * 2, 15);
      }

      // Name match quality
      const nameLower = (resource.name ?? '').toLowerCase();
      if (nameLower === searchTermLower) {
        score += 25;
        reasons.push('exact name match');
      } else if (nameLower.startsWith(searchTermLower)) {
        score += 15;
        reasons.push('prefix name match');
      } else if (nameLower.includes(searchTermLower)) {
        score += 10;
        reasons.push('contains name match');
      }

      // Recency (newer resources get a small boost)
      const dateCreated = resource.dateCreated;
      if (dateCreated) {
        const ageMs = Date.now() - new Date(dateCreated).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        // Up to 5 points for resources created in the last 30 days
        score += Math.max(0, 5 * (1 - ageDays / 30));
      }

      // Multi-source bonus (found by multiple retrieval strategies)
      if (sources.size > 1) {
        score += sources.size * 3;
        reasons.push(`${sources.size} retrieval sources`);
      }

      return {
        ...resource,
        score: Math.round(score * 100) / 100,
        matchReason: reasons.join('; ') || 'candidate',
      };
    });

    // Inference-based semantic scoring (when available and there are candidates)
    if (this.inferenceClient && scored.length > 0) {
      try {
        const inferenceScores = await this.inferenceSemanticScore(
          searchTerm,
          context,
          scored.slice(0, 20), // Limit to top 20 candidates for cost
        );
        for (const item of scored) {
          const id = getResourceId(item) ?? '';
          const inferenceScore = inferenceScores.get(id);
          if (inferenceScore !== undefined) {
            item.score += inferenceScore * 25; // Weight inference up to 25 points
            item.score = Math.round(item.score * 100) / 100;
            if (inferenceScore > 0.5) {
              item.matchReason = item.matchReason
                ? `${item.matchReason}; semantic match`
                : 'semantic match';
            }
          }
        }
      } catch (error) {
        this.logger.warn('Inference semantic scoring failed, using structural scores only', { error });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    this.logger.debug('Search results scored', {
      total: scored.length,
      topScore: scored[0]?.score,
      topReason: scored[0]?.matchReason,
    });

    return scored;
  }

  /**
   * LLM-based semantic relevance scoring (GraphRAG-style)
   *
   * Batches candidates into a single prompt asking the LLM to score
   * each candidate's semantic relevance given the passage and graph context.
   *
   * @returns Map of resourceId → score (0-1)
   */
  private async inferenceSemanticScore(
    searchTerm: string,
    context: GatheredContext,
    candidates: Array<ResourceDescriptor & { score: number }>,
  ): Promise<Map<string, number>> {
    if (!this.inferenceClient) return new Map();

    const passage = context.sourceContext?.selected ?? searchTerm;
    const entityTypes = context.metadata?.entityTypes ?? [];
    const graphConnections = context.graphContext?.connections;
    const connections = graphConnections ?? [];

    // Build candidate list for the prompt
    const candidateLines = candidates.map((c, i) => {
      const id = getResourceId(c) ?? '';
      const cEntityTypes = getResourceEntityTypes(c);
      return `${i + 1}. "${c.name}" (id: ${id}, types: ${cEntityTypes.join(', ') || 'none'})`;
    }).join('\n');

    const contextParts: string[] = [];
    if (entityTypes.length > 0) contextParts.push(`Annotation entity types: ${entityTypes.join(', ')}`);
    if (connections.length > 0) {
      const connNames = connections.slice(0, 5).map(c => c.resourceName);
      contextParts.push(`Connected resources: ${connNames.join(', ')}`);
    }
    if (context.graphContext?.inferredRelationshipSummary) {
      contextParts.push(`Relationship context: ${context.graphContext.inferredRelationshipSummary}`);
    }

    const prompt = `Given this passage and context, score each candidate resource's semantic relevance on a scale of 0.0 to 1.0.

Passage: "${passage}"
Search term: "${searchTerm}"
${contextParts.length > 0 ? contextParts.join('\n') : ''}

Candidates:
${candidateLines}

For each candidate, output ONLY a line with the number and score, like:
1. 0.8
2. 0.3
No explanations.`;

    const response = await this.inferenceClient.generateText(prompt, 200, 0.1);

    // Parse scores from response
    const scores = new Map<string, number>();
    const lines = response.trim().split('\n');
    for (const line of lines) {
      const match = line.match(/^(\d+)\.\s*([\d.]+)/);
      if (match) {
        const index = parseInt(match[1], 10) - 1;
        const score = parseFloat(match[2]);
        if (index >= 0 && index < candidates.length && !isNaN(score) && score >= 0 && score <= 1) {
          const id = getResourceId(candidates[index]) ?? '';
          if (id) scores.set(id, score);
        }
      }
    }

    this.logger.debug('Inference semantic scores', {
      candidateCount: candidates.length,
      scoredCount: scores.size,
    });

    return scores;
  }

  private async handleReferencedBy(event: EventMap['bind:referenced-by-requested']): Promise<void> {
    try {
      this.logger.debug('Looking for annotations referencing resource', {
        resourceId: event.resourceId,
        motivation: event.motivation || 'all',
      });

      const references = await this.kb.graph.getResourceReferencedBy(event.resourceId, event.motivation);

      // Get unique source resources — getTargetSource returns full URIs, extract IDs
      const sourceUris = [...new Set(references.map(ref => getTargetSource(ref.target)))];
      const resources = await Promise.all(sourceUris.map(uri => this.kb.graph.getResource(uriToResourceId(uri))));

      // Build resource map for lookup — warn about any that couldn't be found
      for (let i = 0; i < sourceUris.length; i++) {
        if (resources[i] === null) {
          this.logger.warn('Referenced resource not found in graph', { uri: sourceUris[i] });
        }
      }
      const docMap = new Map(resources.filter(doc => doc !== null).map(doc => [doc['@id'], doc]));

      // Transform into ReferencedBy structure
      const referencedBy = references.map(ref => {
        const targetSource = getTargetSource(ref.target);
        const targetSelector = getTargetSelector(ref.target);
        const doc = docMap.get(targetSource);
        return {
          id: ref.id,
          resourceName: doc?.name || 'Untitled Resource',
          target: {
            source: targetSource,
            selector: {
              exact: targetSelector ? getExactText(targetSelector) : '',
            },
          },
        };
      });

      this.eventBus.get('bind:referenced-by-result').next({
        correlationId: event.correlationId,
        response: { referencedBy },
      });
    } catch (error) {
      this.logger.error('Referenced-by query failed', {
        resourceId: event.resourceId,
        error,
      });
      this.eventBus.get('bind:referenced-by-failed').next({
        correlationId: event.correlationId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    this.logger.info('Binder actor stopped');
  }
}
