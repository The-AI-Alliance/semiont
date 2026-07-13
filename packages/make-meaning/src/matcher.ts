/**
 * Matcher Actor
 *
 * Candidate search for the bind flow. Subscribes to match:search-requested,
 * queries the KB graph for matching resources, scores them, and emits results.
 *
 * Handles:
 * - match:search-requested — multi-source retrieval + composite scoring
 *
 * The write side (annotation.body.updated) stays in the route where userId
 * is available from auth context.
 */

import { Subscription, from } from 'rxjs';
import { concatMap } from 'rxjs/operators';
import type { EventMap, GatheredContext, GraphViews, Logger, ResourceDescriptor } from '@semiont/core';
import { type EventBus, resourceId, errField, deriveViews } from '@semiont/core';
import { getResourceId, getResourceEntityTypes } from '@semiont/core';
import { withActorSpan } from '@semiont/observability';
import type { InferenceClient } from '@semiont/inference';
import type { EmbeddingProvider, VectorSearchResult } from '@semiont/vectors';
import type { KnowledgeBase } from './knowledge-base';
import { resourceWithViewGrace } from './graph-read-grace';

/** The annotation branch of the unified GatheredContext — the only focus the matcher serves. */
type AnnotationFocus = Extract<GatheredContext['focus'], { kind: 'annotation' }>;

export class Matcher {
  private subscriptions: Subscription[] = [];
  private readonly logger: Logger;

  constructor(
    private kb: KnowledgeBase,
    private eventBus: EventBus,
    logger: Logger,
    private inferenceClient: InferenceClient,
    private embeddingProvider?: EmbeddingProvider,
  ) {
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    this.logger.info('Matcher actor initialized');

    const errorHandler = (err: unknown) => this.logger.error('Matcher pipeline error', { error: err });

    const search$ = this.eventBus.get('match:search-requested').pipe(
      concatMap((event) =>
        from(withActorSpan('matcher', 'match:search-requested', () => this.handleSearch(event))),
      ),
    );

    this.subscriptions.push(
      search$.subscribe({ error: errorHandler }),
    );
  }

  private async handleSearch(event: EventMap['match:search-requested']): Promise<void> {
    try {
      const context = event.context;
      if (context.focus.kind !== 'annotation') {
        throw new Error(`Matcher expected annotation focus, received '${context.focus.kind}'`);
      }
      const focus = context.focus;
      // The graph's main node was built (P3) from the focal resource id; the match event
      // carries that same id. Join on it — not on a descriptor — per the plan's P4 mapping.
      const mainResourceId = String(event.resourceId);
      const selectedText = focus.selected?.text ?? '';
      const userHint = focus.userHint ?? '';
      const searchTerm = [selectedText, userHint].filter(Boolean).join(' ');

      this.logger.debug('Searching for binding candidates', {
        referenceId: event.referenceId,
        searchTerm,
        limit: event.limit,
        useSemanticScoring: event.useSemanticScoring,
      });

      const scored = await this.contextDrivenSearch(
        searchTerm,
        context,
        focus,
        mainResourceId,
        event.useSemanticScoring,
      );

      const limited = event.limit ? scored.slice(0, event.limit) : scored;

      this.eventBus.get('match:search-results').next({
        correlationId: event.correlationId,
        referenceId: event.referenceId,
        response: limited,
      });
    } catch (error) {
      this.logger.error('Bind search failed', {
        referenceId: event.referenceId,
        error: errField(error),
      });
      this.eventBus.get('match:search-failed').next({
        correlationId: event.correlationId,
        referenceId: event.referenceId,
        error: error instanceof Error ? error.message : String(error),
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
    focus: AnnotationFocus,
    mainResourceId: string,
    useSemanticScoring?: boolean,
  ): Promise<Array<ResourceDescriptor & { score: number; matchReason: string }>> {
    const annotationEntityTypes = context.metadata.entityTypes ?? [];
    // The flattened connection/citation views are derived from the shared graph backbone.
    const views = deriveViews(context.graph, mainResourceId);
    const connections = views.connections;

    // 1. Multi-source candidate retrieval (parallel).
    // The set-shaped sources (name search, entity-type listing) are
    // eventually consistent BY DESIGN (graph-read-after-write-coverage.md,
    // mechanism (d)): there is no key to await for "all resources matching
    // this search", and multi-source retrieval absorbs a just-created
    // resource missing from one source for the Weaver's ~tens-of-ms lag.
    const [nameMatches, entityTypeMatches, semanticMatches] = await Promise.all([
      this.kb.graph.searchResources(searchTerm),
      annotationEntityTypes.length > 0
        ? this.kb.graph.listResources({ entityTypes: annotationEntityTypes, limit: 50 })
            .then(r => r.resources)
        : Promise.resolve([]),
      // 4. Semantic match — vector similarity search (if vectors configured)
      this.searchVectors(searchTerm),
    ]);

    // 3. Graph neighborhood candidates — id-keyed hydration: graph-first
    // with view fallback (mechanism (b′)). A just-created endpoint must not
    // be dropped while the Weaver lags; retrying here would multiply across
    // the candidate loop, and the view already holds the descriptor.
    const neighborResolved = await Promise.all(
      connections.map(conn => resourceWithViewGrace(this.kb, resourceId(conn.resourceId))),
    );
    const laggedNeighbors = neighborResolved.filter(r => r.laggedBehindView).length;
    if (laggedNeighbors > 0) {
      this.logger.info('[graph lag] neighborhood candidates hydrated from view', { count: laggedNeighbors });
    }
    const neighborResources = neighborResolved.map(r => r.resource);

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

    // Semantic matches resolve to full resources — same id-keyed hydration
    // with view fallback (mechanism (b′)): a vector hit can precede the
    // Weaver's apply, and dropping it would silently shrink recall.
    const semanticScores = new Map<string, number>();
    let laggedSemantic = 0;
    for (const sm of semanticMatches) {
      semanticScores.set(sm.resourceId, sm.score);
      const { resource, laggedBehindView } = await resourceWithViewGrace(this.kb, resourceId(sm.resourceId));
      if (laggedBehindView) laggedSemantic++;
      if (resource) addCandidate(resource, 'semantic');
    }
    if (laggedSemantic > 0) {
      this.logger.info('[graph lag] semantic candidates hydrated from view', { count: laggedSemantic });
    }

    this.logger.debug('Candidate retrieval', {
      nameMatches: nameMatches.length,
      entityTypeMatches: entityTypeMatches.length,
      neighborResources: neighborResources.filter(Boolean).length,
      semanticMatches: semanticMatches.length,
      totalCandidates: candidateMap.size,
    });

    // 2. Score each candidate
    const connectionIds = new Set(connections.map(c => c.resourceId));
    const bidirectionalIds = new Set(
      connections.filter(c => c.bidirectional).map(c => c.resourceId),
    );
    const entityTypeFreqs = context.metadata.entityTypeFrequencies ?? {};
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
      const citedByCount = views.citedByCount;
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

      // Semantic similarity (vector search score, weighted by 25)
      const semanticScore = semanticScores.get(id);
      if (semanticScore !== undefined) {
        score += semanticScore * 25;
        reasons.push('semantic similarity');
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

    // Inference-based semantic scoring (when available, enabled, and there are candidates)
    if (scored.length > 0 && useSemanticScoring !== false) {
      try {
        const inferenceScores = await this.inferenceSemanticScore(
          searchTerm,
          context,
          focus,
          connections,
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
    focus: AnnotationFocus,
    connections: GraphViews['connections'],
    candidates: Array<ResourceDescriptor & { score: number }>,
  ): Promise<Map<string, number>> {
    const passage = [focus.selected?.text, focus.userHint]
      .filter(Boolean).join(' — ') || searchTerm;
    const entityTypes = context.metadata.entityTypes ?? [];

    // Build candidate list for the prompt
    const candidateLines = candidates.map((c, i) => {
      const id = getResourceId(c) ?? '';
      const cEntityTypes = getResourceEntityTypes(c);
      return `${i + 1}. "${c.name}" (id: ${id}, types: ${cEntityTypes.join(', ') || 'none'})`;
    }).join('\n');

    const contextParts: string[] = [];
    contextParts.push(`Annotation motivation: ${focus.annotation.motivation}`);
    contextParts.push(`Source resource: ${focus.sourceResource.name}`);
    // Include body text for commenting/assessing annotations
    const { motivation, body } = focus.annotation;
    if (motivation === 'commenting' || motivation === 'assessing') {
      const bodyItem = Array.isArray(body) ? body[0] : body;
      if (bodyItem && 'value' in bodyItem && bodyItem.value) {
        const label = motivation === 'commenting' ? 'Comment' : 'Assessment';
        contextParts.push(`${label}: ${bodyItem.value}`);
      }
    }
    if (entityTypes.length > 0) contextParts.push(`Annotation entity types: ${entityTypes.join(', ')}`);
    if (connections.length > 0) {
      const connNames = connections.slice(0, 5).map(c => c.resourceName);
      contextParts.push(`Connected resources: ${connNames.join(', ')}`);
    }
    if (context.inferredRelationshipSummary) {
      contextParts.push(`Relationship context: ${context.inferredRelationshipSummary}`);
    }

    const prompt = `Given this passage and context, score each candidate resource's semantic relevance on a scale of 0.0 to 1.0.

Passage: "${passage}"
Search term: "${searchTerm}"
${contextParts.length > 0 ? contextParts.join('\n') : ''}

Candidates:
${candidateLines}

For each candidate, output a line with the number and score, like:
1. 0.8
2. 0.3`;

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

  /**
   * Search vectors for semantically similar resources.
   * Returns empty array if vectors or embedding provider are not configured.
   *
   * No entity-type filter: the annotation's entity types are a ranking signal
   * (Jaccard + IDF in `contextDrivenSearch`), not an inclusion gate. Gating
   * recall here would hide vector-similar but differently-tagged candidates
   * from the scorer.
   */
  private async searchVectors(
    searchTerm: string,
  ): Promise<Array<{ resourceId: string; score: number }>> {
    if (!this.kb.vectors || !this.embeddingProvider || !searchTerm.trim()) return [];

    try {
      const embedding = await this.embeddingProvider.embed(searchTerm);
      const results = await this.kb.vectors.searchResources(embedding, {
        limit: 40,
        scoreThreshold: 0.4,
      });

      return results.map((r: VectorSearchResult) => ({
        resourceId: String(r.resourceId),
        score: r.score,
      }));
    } catch (error) {
      this.logger.warn('Vector search failed, falling back to structural search', { error });
      return [];
    }
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions = [];
    this.logger.info('Matcher actor stopped');
  }
}
